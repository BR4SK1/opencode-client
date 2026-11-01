/**
 * Pure model for the app's coordinated notification stack.
 *
 * Session-attention notices are *derived* from the pending permission, form,
 * and question state instead of being incremented by one-off events. That way
 * a notice stays visible for as long as the underlying request is pending —
 * notifications are never silently discarded while the session still needs
 * input — and they clear themselves when the request is resolved anywhere
 * (replied, rejected, or answered on another device).
 */

export type AttentionKind = "permission" | "question" | "form";

export interface AttentionCounts {
  permission: number;
  question: number;
  form: number;
}

export interface SessionAttention {
  sessionID: string;
  title: string;
  counts: AttentionCounts;
  total: number;
  /** Highest-priority kind present; drives severity and ordering. */
  primary: AttentionKind;
}

/** Minimal shape needed from each pending-item collection. */
export interface PendingRef {
  sessionID: string;
}

/** Sessions shown individually before the rest collapse into a summary. */
export const MAX_SESSION_NOTICES = 3;

const PRIORITY: Record<AttentionKind, number> = {
  permission: 0,
  question: 1,
  form: 2,
};

/**
 * Group pending requests per session, excluding the active session (its
 * requests surface as in-app dialogs instead). Ordering is by primary kind
 * priority (permission > question > form), then by the session list's
 * recency order; sessions missing from the list sort last and stably.
 * Entries without a usable sessionID are dropped.
 */
export function buildSessionAttention(input: {
  sessions: Array<{ id: string; title: string }>;
  otherPending: PendingRef[];
  pendingForms: PendingRef[];
  pendingQuestions: PendingRef[];
  excludeSessionID?: string | null;
}): SessionAttention[] {
  const bySession = new Map<string, AttentionCounts>();
  const countsFor = (sessionID: string): AttentionCounts => {
    let counts = bySession.get(sessionID);
    if (!counts) {
      counts = { permission: 0, question: 0, form: 0 };
      bySession.set(sessionID, counts);
    }
    return counts;
  };
  const addAll = (kind: AttentionKind, items: PendingRef[]) => {
    for (const item of items) {
      if (!item?.sessionID || item.sessionID === input.excludeSessionID) continue;
      countsFor(item.sessionID)[kind] += 1;
    }
  };
  addAll("permission", input.otherPending);
  addAll("question", input.pendingQuestions);
  addAll("form", input.pendingForms);

  const titleByID = new Map(
    input.sessions.map((session) => [session.id, session.title || "Untitled"]),
  );
  const orderIndex = new Map(input.sessions.map((session, i) => [session.id, i]));

  const out: SessionAttention[] = [];
  for (const [sessionID, counts] of bySession) {
    const total = counts.permission + counts.question + counts.form;
    if (total === 0) continue;
    const primary = (["permission", "question", "form"] as AttentionKind[]).find(
      (kind) => counts[kind] > 0,
    )!;
    out.push({
      sessionID,
      title: titleByID.get(sessionID) || "Untitled",
      counts,
      total,
      primary,
    });
  }
  return out.sort((a, b) => {
    const byPriority = PRIORITY[a.primary] - PRIORITY[b.primary];
    if (byPriority !== 0) return byPriority;
    const ia = orderIndex.get(a.sessionID) ?? Number.MAX_SAFE_INTEGER;
    const ib = orderIndex.get(b.sessionID) ?? Number.MAX_SAFE_INTEGER;
    if (ia !== ib) return ia - ib;
    return a.sessionID < b.sessionID ? -1 : a.sessionID > b.sessionID ? 1 : 0;
  });
}

function naturalJoin(parts: string[]): string {
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

function kindPhrase(kind: AttentionKind, count: number): string {
  if (kind === "permission") return count > 1 ? `${count} approvals` : "an approval";
  if (kind === "question") return count > 1 ? `${count} questions` : "a question";
  return count > 1 ? `${count} form responses` : "a form response";
}

/** Human-readable summary, e.g. `Session “Refactor” needs an approval and 2 questions`. */
export function sessionAttentionMessage(attention: SessionAttention): string {
  const parts: string[] = [];
  if (attention.counts.permission > 0) {
    parts.push(kindPhrase("permission", attention.counts.permission));
  }
  if (attention.counts.question > 0) {
    parts.push(kindPhrase("question", attention.counts.question));
  }
  if (attention.counts.form > 0) {
    parts.push(kindPhrase("form", attention.counts.form));
  }
  return `Session “${attention.title}” needs ${naturalJoin(parts)}`;
}

/** Summary for sessions beyond the visible cap, e.g. `2 more sessions need attention`. */
export function overflowAttentionMessage(count: number): string {
  if (count === 1) return "1 more session needs attention — see the session list";
  return `${count} more sessions need attention — see the session list`;
}

/**
 * Cap the visible per-session notices. The list is already priority-ordered,
 * so the most important sessions stay visible and the remainder are counted.
 */
export function splitSessionAttention(
  list: SessionAttention[],
  max: number = MAX_SESSION_NOTICES,
): { visible: SessionAttention[]; overflowCount: number } {
  return {
    visible: list.slice(0, Math.max(0, max)),
    overflowCount: Math.max(0, list.length - Math.max(0, max)),
  };
}

/*
 * Authoritative pending-permission store, keyed by session. A single map is
 * kept across navigation: clearing on back/switch previously made a pending
 * approval vanish from badges and notices until the next global refetch.
 * SSE events, the per-session resync, and the global refetch all write here.
 */

export interface PendingPermissionLike {
  id: string;
  sessionID: string;
}

export type PermissionsBySession<V extends PendingPermissionLike = PendingPermissionLike> = Map<
  string,
  V[]
>;

/** Upsert a permission into its session's list (newest last), immutably. */
export function upsertPermission<V extends PendingPermissionLike>(
  map: PermissionsBySession<V>,
  permission: V,
): PermissionsBySession<V> {
  const next = new Map(map);
  const list = (next.get(permission.sessionID) ?? []).filter(
    (item) => item.id !== permission.id,
  );
  list.push(permission);
  next.set(permission.sessionID, list);
  return next;
}

/** Remove a permission id from every session; emptied entries are pruned. */
export function removePermission<V extends PendingPermissionLike>(
  map: PermissionsBySession<V>,
  requestID: string,
): PermissionsBySession<V> {
  const next = new Map(map);
  for (const [sessionID, list] of next) {
    const filtered = list.filter((item) => item.id !== requestID);
    if (filtered.length === list.length) continue;
    if (filtered.length === 0) next.delete(sessionID);
    else next.set(sessionID, filtered);
  }
  return next;
}

export interface PendingPermissionRecord {
  id: string;
  sessionID: string;
  action: string;
  resources: string[];
  save?: string[];
  message?: string;
}

/**
 * Normalize a raw pending-permission list: drop entries without both id and
 * sessionID, coerce fields, and deduplicate by sessionID+id.
 */
export function normalizePendingPermissions(
  list: unknown,
): PendingPermissionRecord[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: PendingPermissionRecord[] = [];
  for (const item of list) {
    const entry = asRecord(item);
    const id = typeof entry.id === "string" ? entry.id : "";
    const sessionID = typeof entry.sessionID === "string" ? entry.sessionID : "";
    if (!id || !sessionID) continue;
    const key = `${sessionID}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id,
      sessionID,
      action: typeof entry.action === "string" ? entry.action : "",
      resources: asStringList(entry.resources) ?? [],
      ...(asStringList(entry.save) ? { save: asStringList(entry.save) } : {}),
      ...(typeof entry.message === "string" && entry.message
        ? { message: entry.message }
        : {}),
    });
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/*
 * Reconciliation race guards for pending-permission/form snapshots.
 *
 * Optimistic SSE event handling is the primary state keeper; snapshot fetches
 * reconcile it against server truth. A snapshot may only be applied when
 * nothing has happened since it started — otherwise a response captured
 * before an event would erase or resurrect entries relative to fresher
 * event-derived state.
 */

export interface SnapshotToken {
  /** Event revision captured when the fetch started. */
  revision: number;
  /** Monotonic snapshot sequence captured when the fetch started. */
  seq: number;
}

export type SnapshotSkipReason = "event-race" | "superseded";

/**
 * Decide whether a completed snapshot may be applied. `current` carries the
 * revision counter and snapshot sequence at response time. A revision change
 * means an event landed during the flight; a seq change means a newer
 * snapshot fetch (global or per-session — they share one sequence) started
 * and owns the write. Event races are reported with priority because they
 * always warrant a retry.
 */
export function snapshotSkipped(
  token: SnapshotToken,
  current: SnapshotToken,
): SnapshotSkipReason | null {
  if (token.revision !== current.revision) return "event-race";
  if (token.seq !== current.seq) return "superseded";
  return null;
}

export interface RetrySlot {
  /** Schedule `run` as a trailing task; ignored while a run is pending. */
  schedule(run: () => void): void;
  /** Cancel a pending run, if any. */
  cancel(): void;
}

/**
 * Single-slot trailing scheduler used to retry reconciliations skipped by
 * races. Repeated skips coalesce into one deferred run; the run re-checks
 * freshness itself and re-schedules on another skip, so a skip never
 * dead-ends without a subsequent authoritative correction.
 */
export function createRetrySlot(): RetrySlot {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    schedule(run) {
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        run();
      }, 0);
    },
    cancel() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

function asStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.map((item) => (typeof item === "string" ? item : "")).filter(Boolean);
  return items;
}

/**
 * Build an authoritative per-session map from a raw
 * `/api/permissions/pending` response body. Entries without both id and
 * sessionID are dropped. The endpoint returns full detail (resources, save,
 * message), so entries here are dialog-ready.
 */
export function permissionsFromPendingPayload(
  payload: unknown,
): PermissionsBySession<PendingPermissionRecord> {
  const record = asRecord(payload);
  const list = Array.isArray(record.pending) ? record.pending : [];
  const map: PermissionsBySession<PendingPermissionRecord> = new Map();
  for (const permission of normalizePendingPermissions(list)) {
    const existing = map.get(permission.sessionID) ?? [];
    existing.push(permission);
    map.set(permission.sessionID, existing);
  }
  return map;
}

/*
 * Coordination of overlapping pending-permission snapshot fetches.
 *
 * Two fetch scopes exist: a global snapshot (authoritative for every
 * session) and per-session snapshots. Optimistic SSE event handling is the
 * primary state keeper; snapshots reconcile it against server truth. A
 * snapshot may only be applied when neither an event in its scope nor a
 * newer fetch invalidates it.
 *
 * Retry policy (coverage-aware, bounded, quiescent):
 * - "Superseded" (a newer fetch started) does NOT spuriously retry when that
 *   newer fetch covers the skipped work: a global snapshot covers every
 *   session, and a per-session snapshot covers its own session — including a
 *   re-request for the same session. Only a per-session snapshot superseded
 *   by a DIFFERENT session's snapshot leaves its session uncovered; that,
 *   and every event race, raises a single coalesced "reconcile needed" flag
 *   whose trailing drain runs one global snapshot covering everything.
 * - The last fetch started always applies (nothing supersedes it), so once
 *   external triggers stop, every chain terminates: no livelock.
 * - Failed responses never apply and never self-retry; reconnect, focus,
 *   and navigation provide the retry path (no unbounded retries against a
 *   failing endpoint).
 * - Revisions are per scope: an event for session B does not invalidate an
 *   in-flight snapshot of session A; it does invalidate global snapshots.
 */
export interface PermissionSnapshot {
  ok: boolean;
  permissions: PendingPermissionRecord[];
}

export interface PermissionReconcilerOptions {
  fetchGlobal: () => Promise<PermissionSnapshot | null>;
  fetchSession: (sessionID: string) => Promise<PermissionSnapshot | null>;
  applyGlobal: (permissions: PendingPermissionRecord[]) => void;
  applySession: (sessionID: string, permissions: PendingPermissionRecord[]) => void;
  /**
   * Trailing scheduler for the coalesced reconcile drain. The app passes a
   * timeout-0 single-slot scheduler; deterministic tests pass a manual FIFO
   * queue they drain explicitly.
   */
  schedule: (run: () => void) => void;
}

export interface PermissionReconciler {
  /** Record an SSE permission event for a session. */
  noteEvent(sessionID: string): void;
  reconcileSession(sessionID: string): Promise<void>;
  reconcileGlobal(): Promise<void>;
  /** True while a reconciliation retry is needed or its drain is queued. */
  hasPendingRetry(): boolean;
}

export function createPermissionReconciler(
  options: PermissionReconcilerOptions,
): PermissionReconciler {
  let seq = 0;
  let globalRevision = 0;
  const sessionRevisions = new Map<string, number>();
  type SnapshotOwner = { kind: "global" } | { kind: "session"; sessionID: string };
  let latestOwner: SnapshotOwner | null = null;
  // Accessors keep TS from flow-narrowing the closure-mutated owner inside a
  // single async function (concurrent fetches may reassign it across awaits).
  const setLatestOwner = (owner: SnapshotOwner) => {
    latestOwner = owner;
  };
  const latestIsGlobal = () => latestOwner !== null && latestOwner.kind === "global";
  const latestCoversSession = (sessionID: string) =>
    latestOwner !== null &&
    (latestOwner.kind === "global" ||
      (latestOwner.kind === "session" && latestOwner.sessionID === sessionID));
  let reconcileNeeded = false;
  let drainQueued = false;

  const requestReconcile = () => {
    reconcileNeeded = true;
    if (drainQueued) return;
    drainQueued = true;
    options.schedule(() => {
      drainQueued = false;
      if (!reconcileNeeded) return;
      reconcileNeeded = false;
      void reconcileGlobal();
    });
  };

  const reconcileGlobal = async (): Promise<void> => {
    const token = { revision: globalRevision, seq: ++seq };
    setLatestOwner({ kind: "global" });
    const snapshot = await options.fetchGlobal().catch(() => null);
    if (!snapshot || !snapshot.ok) return;
    const skipped = snapshotSkipped(token, { revision: globalRevision, seq });
    if (skipped) {
      // Superseded by another global snapshot: it covers this one. Anything
      // else (event race, superseded by a narrower session snapshot) leaves
      // work uncovered and needs one coalesced global reconcile.
      if (!(skipped === "superseded" && latestIsGlobal())) {
        requestReconcile();
      }
      return;
    }
    options.applyGlobal(snapshot.permissions);
  };

  const reconcileSession = async (sessionID: string): Promise<void> => {
    const revision = sessionRevisions.get(sessionID) ?? 0;
    const token = { revision, seq: ++seq };
    setLatestOwner({ kind: "session", sessionID });
    const snapshot = await options.fetchSession(sessionID).catch(() => null);
    if (!snapshot || !snapshot.ok) return;
    const currentRevision = sessionRevisions.get(sessionID) ?? 0;
    const skipped = snapshotSkipped(token, {
      revision: currentRevision,
      seq,
    });
    if (skipped) {
      if (skipped === "superseded") {
        // Covered by the newer fetch: it applies or flags its own reconcile.
        if (!latestCoversSession(sessionID)) requestReconcile();
        return;
      }
      // Event race in this session's scope.
      requestReconcile();
      return;
    }
    options.applySession(sessionID, snapshot.permissions);
  };

  return {
    noteEvent(sessionID: string) {
      if (!sessionID) return;
      sessionRevisions.set(sessionID, (sessionRevisions.get(sessionID) ?? 0) + 1);
      globalRevision += 1;
    },
    reconcileSession: (sessionID: string) => reconcileSession(sessionID),
    reconcileGlobal: () => reconcileGlobal(),
    hasPendingRetry: () => reconcileNeeded || drainQueued,
  };
}
