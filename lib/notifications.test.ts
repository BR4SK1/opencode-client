import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_SESSION_NOTICES,
  buildSessionAttention,
  createPermissionReconciler,
  createRetrySlot,
  overflowAttentionMessage,
  permissionsFromPendingPayload,
  removePermission,
  sessionAttentionMessage,
  snapshotSkipped,
  splitSessionAttention,
  upsertPermission,
  type PermissionReconciler,
  type PermissionSnapshot,
  type PendingPermissionRecord,
} from "./notifications";

const sessions = [
  { id: "s1", title: "Refactor" },
  { id: "s2", title: "Docs" },
  { id: "s3", title: "" },
];

describe("buildSessionAttention", () => {
  it("returns nothing when nothing is pending", () => {
    expect(
      buildSessionAttention({
        sessions,
        otherPending: [],
        pendingForms: [],
        pendingQuestions: [],
      }),
    ).toEqual([]);
  });

  it("groups pending requests per session with per-kind counts", () => {
    const attention = buildSessionAttention({
      sessions,
      otherPending: [
        { sessionID: "s1" },
        { sessionID: "s1" },
        { sessionID: "s2" },
      ],
      pendingForms: [{ sessionID: "s1" }],
      pendingQuestions: [{ sessionID: "s2" }],
    });
    expect(attention).toHaveLength(2);
    const s1 = attention.find((a) => a.sessionID === "s1")!;
    expect(s1.counts).toEqual({ permission: 2, question: 0, form: 1 });
    expect(s1.total).toBe(3);
    expect(s1.primary).toBe("permission");
    const s2 = attention.find((a) => a.sessionID === "s2")!;
    expect(s2.counts).toEqual({ permission: 1, question: 1, form: 0 });
    expect(s2.primary).toBe("permission");
  });

  it("excludes the active session, whose requests show as dialogs", () => {
    const attention = buildSessionAttention({
      sessions,
      otherPending: [{ sessionID: "s1" }, { sessionID: "s2" }],
      pendingForms: [],
      pendingQuestions: [],
      excludeSessionID: "s1",
    });
    expect(attention.map((a) => a.sessionID)).toEqual(["s2"]);
  });

  it("falls back to Untitled for sessions missing or untitled in the list", () => {
    const attention = buildSessionAttention({
      sessions,
      otherPending: [{ sessionID: "unknown" }],
      pendingForms: [{ sessionID: "s3" }],
      pendingQuestions: [],
    });
    const untitled = attention.filter((a) => a.title === "Untitled");
    expect(untitled).toHaveLength(2);
    expect(untitled.map((a) => a.sessionID).sort()).toEqual(["s3", "unknown"]);
  });

  it("drops entries without a usable sessionID", () => {
    const attention = buildSessionAttention({
      sessions,
      otherPending: [{ sessionID: "" }, {} as { sessionID: string }],
      pendingForms: [],
      pendingQuestions: [],
    });
    expect(attention).toEqual([]);
  });

  it("orders permission-first, then by session-list recency, unknown sessions last", () => {
    const attention = buildSessionAttention({
      sessions: [{ id: "s1", title: "A" }, { id: "s2", title: "B" }],
      otherPending: [{ sessionID: "unknown" }, { sessionID: "s2" }],
      pendingForms: [{ sessionID: "s1" }],
      pendingQuestions: [],
    });
    // s2 (permission) before s1 (form) despite s1 being more recent;
    // unknown (permission) sorts after known s2.
    expect(attention.map((a) => a.sessionID)).toEqual(["s2", "unknown", "s1"]);
  });
});

describe("sessionAttentionMessage", () => {
  it("wording matches the dominant kind for a single kind", () => {
    expect(
      sessionAttentionMessage({
        sessionID: "s1",
        title: "Refactor",
        counts: { permission: 1, question: 0, form: 0 },
        total: 1,
        primary: "permission",
      }),
    ).toBe("Session “Refactor” needs an approval");
  });

  it("uses plurals per kind", () => {
    expect(
      sessionAttentionMessage({
        sessionID: "s1",
        title: "Refactor",
        counts: { permission: 2, question: 3, form: 1 },
        total: 6,
        primary: "permission",
      }),
    ).toBe("Session “Refactor” needs 2 approvals, 3 questions and a form response");
  });

  it("joins two kinds naturally", () => {
    expect(
      sessionAttentionMessage({
        sessionID: "s1",
        title: "Docs",
        counts: { permission: 0, question: 1, form: 0 },
        total: 1,
        primary: "question",
      }),
    ).toBe("Session “Docs” needs a question");
  });
});

describe("splitSessionAttention", () => {
  it("keeps the priority-ordered head visible and counts the overflow", () => {
    const list = [
      { sessionID: "a", title: "A", counts: { permission: 1, question: 0, form: 0 }, total: 1, primary: "permission" as const },
      { sessionID: "b", title: "B", counts: { permission: 0, question: 1, form: 0 }, total: 1, primary: "question" as const },
      { sessionID: "c", title: "C", counts: { permission: 0, question: 0, form: 1 }, total: 1, primary: "form" as const },
      { sessionID: "d", title: "D", counts: { permission: 0, question: 0, form: 2 }, total: 2, primary: "form" as const },
    ];
    const { visible, overflowCount } = splitSessionAttention(list);
    expect(visible).toHaveLength(MAX_SESSION_NOTICES);
    expect(visible.map((a) => a.sessionID)).toEqual(["a", "b", "c"]);
    expect(overflowCount).toBe(1);
  });

  it("reports no overflow when under the cap", () => {
    const { visible, overflowCount } = splitSessionAttention([
      { sessionID: "a", title: "A", counts: { permission: 1, question: 0, form: 0 }, total: 1, primary: "permission" },
    ]);
    expect(visible).toHaveLength(1);
    expect(overflowCount).toBe(0);
  });
});

describe("overflowAttentionMessage", () => {
  it("is singular for one session and plural otherwise", () => {
    expect(overflowAttentionMessage(1)).toBe("1 more session needs attention — see the session list");
    expect(overflowAttentionMessage(3)).toBe("3 more sessions need attention — see the session list");
  });
});

describe("upsertPermission", () => {
  it("adds a permission to its session and replaces same-id entries", () => {
    let map = permissionsFromPendingPayload({
      pending: [{ id: "p1", sessionID: "s1", action: "bash" }],
    });
    map = upsertPermission(map, {
      id: "p2",
      sessionID: "s1",
      action: "write",
      resources: ["a.txt"],
    });
    expect(map.get("s1")!.map((p) => p.id)).toEqual(["p1", "p2"]);
    map = upsertPermission(map, {
      id: "p2",
      sessionID: "s1",
      action: "write",
      resources: ["b.txt"],
    });
    expect(map.get("s1")).toHaveLength(2);
    expect(map.get("s1")![1]).toMatchObject({ id: "p2", resources: ["b.txt"] });
  });

  it("does not mutate the input map", () => {
    const map = permissionsFromPendingPayload({
      pending: [{ id: "p1", sessionID: "s1", action: "bash" }],
    });
    const next = upsertPermission(map, {
      id: "p2",
      sessionID: "s2",
      action: "edit",
      resources: [],
    });
    expect(map.get("s2")).toBeUndefined();
    expect(next.get("s2")).toHaveLength(1);
  });
});

describe("removePermission", () => {
  it("removes the id from every session and prunes emptied entries", () => {
    const map = permissionsFromPendingPayload({
      pending: [
        { id: "p1", sessionID: "s1", action: "bash" },
        { id: "p2", sessionID: "s1", action: "write" },
        { id: "p1", sessionID: "s2", action: "edit" },
      ],
    });
    const next = removePermission(map, "p1");
    expect(next.has("s2")).toBe(false);
    expect(next.get("s1")!.map((p) => p.id)).toEqual(["p2"]);
    // Original map untouched.
    expect(map.get("s2")).toHaveLength(1);
  });

  it("leaves the map unchanged when the id is absent", () => {
    const map = permissionsFromPendingPayload({
      pending: [{ id: "p1", sessionID: "s1", action: "bash" }],
    });
    expect(removePermission(map, "missing").get("s1")).toEqual(map.get("s1"));
  });
});

describe("permissionsFromPendingPayload", () => {
  it("maps full detail and groups by session", () => {
    const map = permissionsFromPendingPayload({
      pending: [
        {
          id: "p1",
          sessionID: "s1",
          action: "bash",
          resources: ["rm -rf /"],
          save: ["always allow"],
          message: "Run command?",
        },
        { id: "p2", sessionID: "s1", action: "write", resources: [] },
        { id: "p3", sessionID: "s2", action: "edit" },
      ],
    });
    expect(map.size).toBe(2);
    expect(map.get("s1")).toEqual([
      {
        id: "p1",
        sessionID: "s1",
        action: "bash",
        resources: ["rm -rf /"],
        save: ["always allow"],
        message: "Run command?",
      },
      { id: "p2", sessionID: "s1", action: "write", resources: [] },
    ]);
    expect(map.get("s2")).toEqual([
      { id: "p3", sessionID: "s2", action: "edit", resources: [] },
    ]);
  });

  it("drops malformed entries and tolerates a missing list", () => {
    expect(permissionsFromPendingPayload({ pending: [{ id: "x" }, "junk", null] })).toEqual(new Map());
    expect(permissionsFromPendingPayload(undefined)).toEqual(new Map());
    expect(permissionsFromPendingPayload({})).toEqual(new Map());
  });
});

describe("snapshotSkipped", () => {
  const token = { revision: 7, seq: 3 };

  it("applies when neither the revision nor the sequence moved", () => {
    expect(snapshotSkipped(token, { revision: 7, seq: 3 })).toBeNull();
  });

  it("skips as an event race when an event landed during the flight", () => {
    expect(snapshotSkipped(token, { revision: 8, seq: 3 })).toBe("event-race");
  });

  it("skips as superseded when a newer snapshot fetch started", () => {
    expect(snapshotSkipped(token, { revision: 7, seq: 4 })).toBe("superseded");
  });

  it("reports the event race first when both moved", () => {
    expect(snapshotSkipped(token, { revision: 8, seq: 4 })).toBe("event-race");
  });
});

describe("createRetrySlot", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces repeated schedule calls into one trailing run", () => {
    const slot = createRetrySlot();
    const run = vi.fn();
    slot.schedule(run);
    slot.schedule(run);
    slot.schedule(run);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(0);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("ignores schedules while a run is pending, then re-arms", () => {
    const slot = createRetrySlot();
    const first = vi.fn();
    const second = vi.fn();
    slot.schedule(first);
    slot.schedule(second);
    vi.advanceTimersByTime(0);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    slot.schedule(second);
    vi.advanceTimersByTime(0);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("cancel prevents the pending run and frees the slot", () => {
    const slot = createRetrySlot();
    const run = vi.fn();
    slot.schedule(run);
    slot.cancel();
    vi.advanceTimersByTime(0);
    expect(run).not.toHaveBeenCalled();
    slot.schedule(run);
    vi.advanceTimersByTime(0);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("supports a retry chain: each run may schedule the next", () => {
    const slot = createRetrySlot();
    const second = vi.fn();
    const first = vi.fn(() => slot.schedule(second));
    slot.schedule(first);
    // runAllTimers drains chained timers (a run scheduling the next one).
    vi.runAllTimers();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });
});

/*
 * Deterministic coordination scenarios for overlapping global and
 * per-session permission reconciliations. The scheduler is a manual FIFO
 * queue the tests drain explicitly, so every interleaving is fixed; the
 * drain loop fails loudly (cap) instead of hanging if reconciliation ever
 * fails to quiesce.
 */

const perm = (id: string, sessionID: string, action = "bash"): PendingPermissionRecord => ({
  id,
  sessionID,
  action,
  resources: [],
});

function createHarness() {
  const schedulerQueue: Array<() => void> = [];
  let globalCalls = 0;
  const sessionCalls: Record<string, number> = {};
  const globalResponses: Array<PermissionSnapshot | null> = [];  const sessionResponses: Record<string, Array<PermissionSnapshot | null>> = {};
  const appliedSessions = new Map<string, PendingPermissionRecord[]>();
  const appliedGlobal: Array<PendingPermissionRecord[]> = [];

  const rec: PermissionReconciler = createPermissionReconciler({
    fetchGlobal: async () => {
      globalCalls += 1;
      const response = globalResponses.shift();
      if (!response) throw new Error("unexpected global fetch");
      return response;
    },
    fetchSession: async (sessionID) => {
      sessionCalls[sessionID] = (sessionCalls[sessionID] ?? 0) + 1;
      const queue = sessionResponses[sessionID];
      const response = queue?.shift();
      if (!response) throw new Error(`unexpected session fetch: ${sessionID}`);
      return response;
    },
    applyGlobal: (permissions) => {
      appliedGlobal.push(permissions);
      const map = new Map<string, PendingPermissionRecord[]>();
      for (const p of permissions) {
        const list = map.get(p.sessionID) ?? [];
        list.push(p);
        map.set(p.sessionID, list);
      }
      for (const [sessionID, list] of map) appliedSessions.set(sessionID, list);
    },
    applySession: (sessionID, permissions) => {
      appliedSessions.set(sessionID, permissions);
    },
    schedule: (run) => {
      schedulerQueue.push(run);
    },
  });

  const flush = async () => {
    for (let i = 0; i < 25; i++) await Promise.resolve();
  };

  const drainScheduler = async () => {
    for (let guard = 0; guard < 100; guard += 1) {
      if (schedulerQueue.length === 0) return;
      const job = schedulerQueue.shift();
      job?.();
      await flush();
    }
    throw new Error("reconciliation did not quiesce (livelock?)");
  };

  return {
    rec,
    schedulerQueue,
    flush,
    drainScheduler,
    globalCalls: () => globalCalls,
    sessionCalls: (id: string) => sessionCalls[id] ?? 0,
    queueGlobal: (snapshots: Array<PermissionSnapshot | null>) => {
      globalResponses.push(...snapshots);
    },
    queueSession: (id: string, snapshots: Array<PermissionSnapshot | null>) => {
      sessionResponses[id] = [...(sessionResponses[id] ?? []), ...snapshots];
    },
    appliedSessions,
    appliedGlobal: () => appliedGlobal,
  };
}

describe("createPermissionReconciler", () => {
  it("overlapping global + two session fetches converge with one coalesced global retry", async () => {
    const h = createHarness();
    // Two global responses: the initial (superseded) one and the coalesced retry.
    h.queueGlobal([
      { ok: true, permissions: [perm("g1", "A"), perm("g2", "B")] },
      { ok: true, permissions: [perm("g1", "A"), perm("g2", "B")] },
    ]);
    h.queueSession("A", [{ ok: true, permissions: [perm("a1", "A")] }]);
    h.queueSession("B", [{ ok: true, permissions: [perm("b1", "B")] }]);

    void h.rec.reconcileGlobal();
    void h.rec.reconcileSession("A");
    void h.rec.reconcileSession("B");
    await h.flush();

    // Global (seq 1) was superseded by session B (seq 3) — narrower coverage,
    // so a reconcile is flagged; A likewise; B (latest) applied.
    expect(h.appliedSessions.get("B")).toEqual([perm("b1", "B")]);
    expect(h.appliedSessions.get("A")).toBeUndefined();
    expect(h.rec.hasPendingRetry()).toBe(true);

    await h.drainScheduler();

    // Exactly one coalesced global retry covered both sessions.
    expect(h.globalCalls()).toBe(2);
    expect(h.sessionCalls("A")).toBe(1);
    expect(h.sessionCalls("B")).toBe(1);
    expect(h.appliedSessions.get("A")).toEqual([perm("g1", "A")]);
    expect(h.appliedSessions.get("B")).toEqual([perm("g2", "B")]);
    expect(h.schedulerQueue).toHaveLength(0);
    expect(h.rec.hasPendingRetry()).toBe(false);
  });

  it("a session snapshot superseded by a global snapshot does not spuriously retry", async () => {
    const h = createHarness();
    h.queueSession("A", [{ ok: true, permissions: [perm("a1", "A")] }]);
    h.queueGlobal([{ ok: true, permissions: [perm("g1", "A")] }]);

    void h.rec.reconcileSession("A");
    void h.rec.reconcileGlobal();
    await h.flush();

    // A was superseded by the global fetch, which covers A: no retry.
    expect(h.rec.hasPendingRetry()).toBe(false);
    expect(h.schedulerQueue).toHaveLength(0);
    await h.drainScheduler();
    expect(h.globalCalls()).toBe(1);
    expect(h.sessionCalls("A")).toBe(1);
    expect(h.appliedSessions.get("A")).toEqual([perm("g1", "A")]);
  });

  it("a session superseded by a DIFFERENT session is not dropped: one global covers both", async () => {
    const h = createHarness();
    h.queueSession("A", [{ ok: true, permissions: [perm("a1", "A")] }]);
    h.queueSession("B", [{ ok: true, permissions: [perm("b1", "B")] }]);
    h.queueGlobal([{ ok: true, permissions: [perm("g1", "A"), perm("g2", "B")] }]);

    void h.rec.reconcileSession("A");
    void h.rec.reconcileSession("B");
    await h.flush();

    expect(h.appliedSessions.get("B")).toEqual([perm("b1", "B")]);
    expect(h.rec.hasPendingRetry()).toBe(true);

    await h.drainScheduler();

    // A's reconciliation was preserved through the single global retry.
    expect(h.appliedSessions.get("A")).toEqual([perm("g1", "A")]);
    expect(h.appliedSessions.get("B")).toEqual([perm("g2", "B")]);
    expect(h.globalCalls()).toBe(1);
    expect(h.rec.hasPendingRetry()).toBe(false);
  });

  it("an event for another session does not invalidate a session snapshot", async () => {
    const h = createHarness();
    h.queueSession("A", [{ ok: true, permissions: [perm("a1", "A")] }]);

    void h.rec.reconcileSession("A");
    h.rec.noteEvent("B");
    await h.flush();

    expect(h.appliedSessions.get("A")).toEqual([perm("a1", "A")]);
    expect(h.globalCalls()).toBe(0);
    expect(h.rec.hasPendingRetry()).toBe(false);
    expect(h.schedulerQueue).toHaveLength(0);
  });

  it("an event in the snapshot's own scope retries via one global reconcile", async () => {
    const h = createHarness();
    h.queueSession("A", [{ ok: true, permissions: [perm("a1", "A")] }]);
    h.queueGlobal([{ ok: true, permissions: [perm("g1", "A")] }]);

    void h.rec.reconcileSession("A");
    h.rec.noteEvent("A");
    await h.flush();

    expect(h.appliedSessions.get("A")).toBeUndefined();
    expect(h.rec.hasPendingRetry()).toBe(true);

    await h.drainScheduler();

    expect(h.appliedSessions.get("A")).toEqual([perm("g1", "A")]);
    expect(h.globalCalls()).toBe(1);
    expect(h.rec.hasPendingRetry()).toBe(false);
  });

  it("a global snapshot racing an event retries exactly once and quiesces", async () => {
    const h = createHarness();
    h.queueGlobal([{ ok: true, permissions: [perm("g1", "A")] }]);
    h.queueGlobal([{ ok: true, permissions: [perm("g2", "A")] }]);

    void h.rec.reconcileGlobal();
    h.rec.noteEvent("A");
    await h.flush();

    expect(h.appliedGlobal()).toHaveLength(0);
    expect(h.rec.hasPendingRetry()).toBe(true);

    await h.drainScheduler();

    expect(h.appliedGlobal()).toEqual([[perm("g2", "A")]]);
    expect(h.globalCalls()).toBe(2);
    expect(h.schedulerQueue).toHaveLength(0);
    expect(h.rec.hasPendingRetry()).toBe(false);
  });

  it("two overlapping global fetches coalesce without any retry", async () => {
    const h = createHarness();
    h.queueGlobal([{ ok: true, permissions: [perm("g1", "A")] }]);
    h.queueGlobal([{ ok: true, permissions: [perm("g2", "A")] }]);

    void h.rec.reconcileGlobal();
    void h.rec.reconcileGlobal();
    await h.flush();

    // The older global is superseded by a newer global (full coverage): no
    // retry, and the newer snapshot's data wins.
    expect(h.appliedGlobal()).toEqual([[perm("g2", "A")]]);
    expect(h.globalCalls()).toBe(2);
    expect(h.rec.hasPendingRetry()).toBe(false);
    expect(h.schedulerQueue).toHaveLength(0);
  });

  it("a session superseded by a re-request for the SAME session is covered", async () => {
    const h = createHarness();
    h.queueSession("A", [{ ok: true, permissions: [perm("a1", "A")] }]);
    h.queueSession("A", [{ ok: true, permissions: [perm("a2", "A")] }]);

    void h.rec.reconcileSession("A");
    void h.rec.reconcileSession("A");
    await h.flush();

    expect(h.appliedSessions.get("A")).toEqual([perm("a2", "A")]);
    expect(h.sessionCalls("A")).toBe(2);
    expect(h.rec.hasPendingRetry()).toBe(false);
    expect(h.schedulerQueue).toHaveLength(0);
  });

  it("failed responses never apply and never self-retry", async () => {
    const h = createHarness();
    h.queueGlobal([{ ok: false, permissions: [] }]);
    h.queueSession("A", [null]);

    void h.rec.reconcileGlobal();
    void h.rec.reconcileSession("A");
    await h.flush();

    expect(h.appliedGlobal()).toHaveLength(0);
    expect(h.appliedSessions.size).toBe(0);
    expect(h.rec.hasPendingRetry()).toBe(false);
    expect(h.schedulerQueue).toHaveLength(0);
    expect(h.globalCalls()).toBe(1);
    expect(h.sessionCalls("A")).toBe(1);
  });

  it("alternating trigger storm still quiesces once triggers stop", async () => {
    const h = createHarness();
    // Script a realistic storm: repeated overlapping triggers, each with a
    // valid response, plus events. The final extra global response serves the
    // single coalesced drain that runs after the triggers stop. After that,
    // everything must settle with a bounded number of fetches.
    for (let round = 0; round < 5; round += 1) {
      h.queueGlobal([{ ok: true, permissions: [perm(`g${round}`, "A")] }]);
      h.queueSession("A", [{ ok: true, permissions: [perm(`a${round}`, "A")] }]);
      h.queueSession("B", [{ ok: true, permissions: [perm(`b${round}`, "B")] }]);
      void h.rec.reconcileGlobal();
      void h.rec.reconcileSession("A");
      void h.rec.reconcileSession("B");
      h.rec.noteEvent("A");
      await h.flush();
    }
    h.queueGlobal([
      { ok: true, permissions: [perm("g4", "A"), perm("g4b", "B")] },
    ]);
    await h.drainScheduler();
    expect(h.schedulerQueue).toHaveLength(0);
    expect(h.rec.hasPendingRetry()).toBe(false);
    // Final applied state reflects the drain's global snapshot.
    expect(h.appliedSessions.get("A")?.[0]?.id).toBe("g4");
    expect(h.appliedSessions.get("B")?.[0]?.id).toBe("g4b");
  });
});
