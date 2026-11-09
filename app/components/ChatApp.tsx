"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Box,
  Stack,
  Typography,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import ForumOutlined from "@mui/icons-material/ForumOutlined";
import type { FormInfo, ModelRef } from "@opencode/client";
import type { PromptMentionAttachment } from "@/lib/prompt-mentions";
import {
  decodeCanonicalBase64,
  mapHistoryImageFiles,
  MAX_TOTAL_IMAGE_BYTES,
  type PromptImageAttachment,
} from "@/lib/prompt-images";
import {
  buildInboxUserMessages,
  mergeMessageSnapshots,
  reconcileMessageSnapshot,
  sortMessageSnapshot,
} from "@/lib/inbox-message-view";
import {
  createAgentDefaultCoordinator,
  DEFAULT_AGENT_ID,
  type AgentDefaultCoordinator,
} from "@/lib/default-agent";
import {
  buildSessionAttention,
  createPermissionReconciler,
  createRetrySlot,
  normalizePendingPermissions,
  overflowAttentionMessage,
  permissionsFromPendingPayload,
  removePermission,
  sessionAttentionMessage,
  snapshotSkipped,
  splitSessionAttention,
  upsertPermission,
  type PermissionReconciler,
  type RetrySlot,
} from "@/lib/notifications";
import {
  clearComposerDraftIfRevision,
  getComposerDraft,
  updateComposerDraft,
  type ComposerDraftContent,
  type SessionComposerDrafts,
} from "@/lib/composer-drafts";
import { signOut } from "next-auth/react";
import SessionList from "./SessionList";
import ChatView from "./ChatView";
import PermissionDialog from "./PermissionDialog";
import FormDialog from "./FormDialog";
import QuestionDialog from "./QuestionDialog";
import NotificationStack, {
  type NotificationAction,
  type NotificationItem,
} from "./NotificationStack";

const NOTIFICATION_ACTION_RELOAD = "reload";
const NOTIFICATION_ACTION_SHOW_LIST = "show-list";

export interface SessionVM {
  id: string;
  parentID?: string;
  title: string;
  created: number;
  updated: number;
  agent: string;
  model?: ModelRef;
}

export type SessionListStatus = "running" | "waiting";

interface AgentOptionVM {
  id: string;
  name: string;
  description: string;
  model?: ModelRef | null;
}

interface ModelOptionVM {
  model: ModelRef;
  label: string;
}

export interface ImageVM {
  src: string;
  name: string;
}

export type PartVM =
  | { kind: "text"; text: string }
  | {
      kind: "tool";
      id: string;
      name: string;
      status: string;
      subagentSessionID?: string;
      subagentAgentID?: string;
      error?: string;
    };

export type MessageVM =
  | {
      kind: "user";
      id: string;
      text: string;
      time?: number;
      clientMessageID?: string;
      images: ImageVM[];
      queued?: boolean;
      imageWarning?: string;
    }
  | {
      kind: "assistant";
      id: string;
      parts: PartVM[];
      agent?: string;
      time?: number;
      streaming?: boolean;
    }
  | {
      kind: "agent";
      id: string;
      agent: string;
      previous?: string;
      time?: number;
    };

interface StreamingVM {
  text: string;
  time: number;
  ended: boolean;
}

export interface PendingPermission {
  id: string;
  sessionID: string;
  action: string;
  resources: string[];
  save?: string[];
  message?: string;
}

export interface PendingQuestion {
  id: string;
  sessionID: string;
  questions: Array<{
    header: string;
    question: string;
    options: Array<{ label: string; description: string }>;
    multiple?: boolean;
    custom?: boolean;
  }>;
}

/* Raw shapes used only to map history into view models. */
interface RawPart {
  type: string;
  text?: unknown;
  id?: unknown;
  name?: unknown;
  state?: { status?: unknown; input?: unknown; metadata?: unknown; error?: unknown };
}

interface RawMessage {
  type: string;
  id?: unknown;
  text?: unknown;
  metadata?: unknown;
  content?: RawPart[];
  files?: unknown;
  agent?: unknown;
  previous?: unknown;
  time?: { created?: unknown };
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function questionRequest(value: unknown): PendingQuestion | undefined {
  const request = asRecord(value);
  const id = str(request.id);
  const sessionID = str(request.sessionID);
  if (!id || !sessionID || !Array.isArray(request.questions)) return undefined;
  const questions = request.questions.map((value) => {
    const item = asRecord(value);
    return {
      header: str(item.header),
      question: str(item.question),
      options: Array.isArray(item.options)
        ? item.options.map((option) => {
            const record = asRecord(option);
            return { label: str(record.label), description: str(record.description) };
          }).filter((option) => option.label)
        : [],
      multiple: item.multiple === true,
      custom: item.custom === true,
    };
  }).filter((item) => item.question && item.options.length > 0);
  if (questions.length === 0) return undefined;
  return { id, sessionID, questions };
}

function modelRef(v: unknown): ModelRef | undefined {
  const record = asRecord(v);
  const id = str(record.id);
  const providerID = str(record.providerID);
  if (!id || !providerID) return undefined;
  const variant = str(record.variant);
  return { id, providerID, ...(variant ? { variant } : {}) };
}

function imageVMs(value: unknown, messageID: string): { images: ImageVM[]; imageWarning?: string } {
  const mapped = mapHistoryImageFiles(value, messageID || undefined);
  return {
    images: mapped.images.map(({ src, name }) => ({ src, name })),
    ...(mapped.omittedCount > 0
      ? { imageWarning: `${mapped.omittedCount} image${mapped.omittedCount === 1 ? " was" : "s were"} not previewed (invalid data or preview size limit).` }
      : {}),
  };
}

function buildVMs(data: unknown): MessageVM[] {
  const raw = (Array.isArray(data) ? data : []) as RawMessage[];
  // The API returns messages newest-first (descending by time.created).
  // Normalize to chronological ascending order (oldest first, newest last):
  // reverse a copy, then apply a stable sort by time.created. Messages
  // without a usable timestamp keep their reversed-array position.
  const chronological = raw
    .slice()
    .reverse()
    .map((m) => ({
      m,
      created: Number(m.time?.created) || 0,
    }))
    .sort((a, b) => a.created - b.created);
  const out: MessageVM[] = [];
  chronological.forEach(({ m, created }, i) => {
    const time = created || undefined;
    if (m.type === "user" && typeof m.text === "string") {
      const metadata = asRecord(m.metadata);
      out.push({
        kind: "user",
        id: str(m.id) || `user-${i}`,
        text: m.text,
        time,
        clientMessageID: str(metadata.opencodeClientMessageID) || undefined,
        ...imageVMs(m.files, str(m.id)),
      });
    } else if (m.type === "agent-switched") {
      out.push({
        kind: "agent",
        id: str(m.id) || `agent-${i}`,
        agent: str(m.agent),
        previous: str(m.previous) || undefined,
        time,
      });
    } else if (m.type === "assistant") {
      const parts: PartVM[] = [];
      for (const p of m.content ?? []) {
        if (p.type === "text" && typeof p.text === "string") {
          parts.push({ kind: "text", text: p.text });
        } else if (p.type === "tool") {
          const input = asRecord(p.state?.input);
          const metadata = asRecord(asRecord(p.state).metadata);
          parts.push({
            kind: "tool",
            id: str(p.id) || `tool-${parts.length}`,
            name: str(p.name) || "tool",
            status: str(p.state?.status) || "running",
            subagentSessionID: str(metadata.sessionID) || undefined,
            // The subagent tool input is the immediate, authoritative agent
            // choice. Child sessions may not yet be present in /api/sessions
            // when the tool result is rendered, so don't depend on that list
            // to identify the agent.
            subagentAgentID:
              p.name === "subagent" ? str(input.agent) || undefined : undefined,
            error: str(asRecord(p.state?.error).message) || undefined,
          });
        }
        // reasoning parts are skipped in the MVP
      }
      out.push({
        kind: "assistant",
        id: str(m.id) || `assistant-${i}`,
        parts,
        agent: str(m.agent) || undefined,
        time,
      });
    }
    // all other message types (idle/system/compaction/model-selected/...) are skipped
  });
  return sortMessageSnapshot(out);
}

function withStreamingMessages(
  history: MessageVM[],
  streaming: Map<string, StreamingVM>,
): MessageVM[] {
  const byID = new Map(history.map((message) => [message.id, message]));

  for (const [id, live] of streaming) {
    const current = byID.get(id);
    if (current?.kind === "assistant") {
      byID.set(id, {
        ...current,
        parts: [
          ...current.parts.filter((part) => part.kind !== "text"),
          ...(live.text ? [{ kind: "text" as const, text: live.text }] : []),
        ],
        time: current.time ?? live.time,
        streaming: !live.ended,
      });
    } else if (!current) {
      byID.set(id, {
        kind: "assistant",
        id,
        parts: live.text ? [{ kind: "text", text: live.text }] : [],
        time: live.time,
        streaming: !live.ended,
      });
    }
  }

  return sortMessageSnapshot(Array.from(byID.values()));
}

export default function ChatApp() {
  const router = useRouter();
  const theme = useTheme();
  const isDesktop = useMediaQuery(theme.breakpoints.up("md"));

  const [sessions, setSessions] = useState<SessionVM[]>([]);
  const [agents, setAgents] = useState<AgentOptionVM[]>([]);
  const [models, setModels] = useState<ModelOptionVM[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [history, setHistory] = useState<MessageVM[]>([]);
  const [streaming, setStreaming] = useState<Map<string, StreamingVM>>(new Map());
  const [sessionActivity, setSessionActivity] = useState<Map<string, "running">>(new Map());
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);
  const [toolRunningCount, setToolRunningCount] = useState(0);
  // Authoritative pending-permission store keyed by session. Kept across
  // navigation so a pending approval never vanishes from badges/notices when
  // the user leaves its session; the active session's entry drives dialogs.
  const [permissionsBySession, setPermissionsBySession] = useState<
    Map<string, PendingPermission[]>
  >(() => new Map());
  const [pendingForms, setPendingForms] = useState<FormInfo[]>([]);
  const [pendingQuestions, setPendingQuestions] = useState<PendingQuestion[]>([]);
  const [sendingSessionIDs, setSendingSessionIDs] = useState<Set<string>>(() => new Set());
  const [composerDrafts, setComposerDrafts] = useState<SessionComposerDrafts>(() => new Map());
  const [switchingAgent, setSwitchingAgent] = useState(false);
  const [switchingModel, setSwitchingModel] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectionLost, setConnectionLost] = useState(false);

  const activeIdRef = useRef<string | null>(null);
  const sendingSessionIDsRef = useRef(new Set<string>());
  const sessionGenerationRef = useRef(0);
  const headRequestRef = useRef(0);
  const olderCursorRef = useRef<string | null>(null);
  const olderPageLoadedRef = useRef(false);
  const loadingOlderGenerationRef = useRef<number | null>(null);
  const permissionsBySessionRef = useRef<Map<string, PendingPermission[]>>(new Map());
  // Trailing retry slots: a reconciliation skipped by an event race re-runs
  // once the event burst settles instead of waiting for the next
  // reconnect/visibility. Superseded snapshots do not retry (the newer fetch
  // covers them — see createPermissionReconciler).
  const permissionReconcileRetry = useRef<RetrySlot | null>(null);
  const formsResyncRetry = useRef<RetrySlot | null>(null);
  if (permissionReconcileRetry.current == null) {
    permissionReconcileRetry.current = createRetrySlot();
  }
  if (formsResyncRetry.current == null) {
    formsResyncRetry.current = createRetrySlot();
  }
  // Same guard pair for pending forms (optimistically upserted from
  // form.created events). Form snapshots all cover the same global scope, so
  // a superseded one needs no retry; only event races do.
  const formsRevisionRef = useRef(0);
  const formsSnapshotSeqRef = useRef(0);
  // Latest-callback mirror for the forms retry (assigned in an effect below).
  const resyncFormsLatestRef = useRef<() => void>(() => {});
  const pendingQuestionsRevisionRef = useRef(0);
  const activityRevisionRef = useRef(0);
  const activitySnapshotRequestRef = useRef(0);
  const sessionsRef = useRef<SessionVM[]>([]);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toolTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Coordinates the automatic default against user switches and prompts; see
  // createAgentDefaultCoordinator for the guarantees. Pure promise
  // bookkeeping, so render-time creation is safe (same as createRetrySlot).
  const agentCoordinatorRef = useRef<AgentDefaultCoordinator | null>(null);
  if (agentCoordinatorRef.current == null) {
    agentCoordinatorRef.current = createAgentDefaultCoordinator();
  }
  // Mirror of switchingAgent for callbacks that must not read render state.
  const switchingAgentRef = useRef(false);

  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  useEffect(() => {
    permissionsBySessionRef.current = permissionsBySession;
  }, [permissionsBySession]);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  const apiFetch = useCallback(
    (url: string, init?: RequestInit) => {
      return fetch(url, init).then((res) => {
        if (res.status === 401) {
          router.push("/signin");
          throw new Error("unauthorized");
        }
        return res;
      });
    },
    [router],
  );

  const reconcileSessionActivity = useCallback(async () => {
    const activityRevision = activityRevisionRef.current;
    const request = ++activitySnapshotRequestRef.current;
    try {
      const res = await apiFetch("/api/sessions/active");
      if (!res.ok) return;
      const json = asRecord(await res.json());
      if (!Array.isArray(json.sessionIDs)) return;

      // A newer SSE activity event makes this snapshot potentially stale.
      // Also ignore earlier overlapping snapshots if a later one was requested.
      if (
        activityRevision !== activityRevisionRef.current ||
        request !== activitySnapshotRequestRef.current
      ) {
        return;
      }

      const runningIDs = json.sessionIDs.filter(
        (id): id is string => typeof id === "string" && id.length > 0,
      );
      setSessionActivity(new Map(runningIDs.map((id) => [id, "running" as const])));
    } catch {
      // Keep the current activity state when reconciliation fails.
    }
  }, [apiFetch]);

  const refetchSessions = useCallback(async () => {
    try {
      const res = await apiFetch("/api/sessions");
      const json = asRecord(await res.json());
      setSessions(Array.isArray(json.sessions) ? (json.sessions as SessionVM[]) : []);
    } catch {
      /* unauthorized already routed to /signin */
    }
  }, [apiFetch]);

  const applyAgentState = useCallback((id: string, value: unknown) => {
    const state = asRecord(value);
    const agentID = str(state.currentAgent);
    const model = modelRef(state.model);
    const availableAgents = Array.isArray(state.agents)
      ? state.agents.map((value) => {
          const agent = asRecord(value);
          return {
            id: str(agent.id),
            name: str(agent.name) || str(agent.id),
            description: str(agent.description),
            model: modelRef(agent.model) ?? null,
          };
        })
      : [];
    setAgents(availableAgents.filter((agent) => agent.id));
    const availableModels = Array.isArray(state.models)
      ? state.models.flatMap((value) => {
          const info = asRecord(value);
          const ref = modelRef(info);
          if (!ref || info.enabled !== true) return [];
          const name = str(info.name) || ref.id;
          const base = `${ref.providerID} · ${name}`;
          const options: ModelOptionVM[] = [{ model: ref, label: base }];
          if (Array.isArray(info.variants)) {
            for (const variantValue of info.variants) {
              const variant = str(asRecord(variantValue).id);
              if (variant) {
                options.push({
                  model: { ...ref, variant },
                  label: `${base} (${variant})`,
                });
              }
            }
          }
          return options;
        })
      : [];
    setModels(availableModels);
    setSessions((previous) =>
      previous.map((session) =>
        session.id === id
          ? {
              ...session,
              agent: agentID,
              model,
            }
          : session,
      ),
    );
  }, []);

  // Performs the automatic default switch for a session and reports whether
  // it was applied. Marking, serialization, and outcome tracking live in the
  // coordinator; failures stay silent — the agent picker still shows the
  // unselected state and the next agent-state fetch retries.
  const applyDefaultAgent = useCallback(
    async (id: string): Promise<boolean> => {
      const generation = sessionGenerationRef.current;
      try {
        const res = await apiFetch(`/api/sessions/${encodeURIComponent(id)}/agent`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agentId: DEFAULT_AGENT_ID }),
        });
        const result = asRecord(await res.json());
        if (!res.ok) return false;
        if (activeIdRef.current === id && sessionGenerationRef.current === generation) {
          applyAgentState(id, result);
        }
        return true;
      } catch {
        return false;
      }
    },
    [apiFetch, applyAgentState],
  );

  const fetchAgentState = useCallback(
    async (id: string, generation?: number) => {
      const coordinator = agentCoordinatorRef.current;
      const settleStateFetch = coordinator?.beginStateFetch(id);
      try {
        const res = await apiFetch(`/api/sessions/${encodeURIComponent(id)}/agent`);
        if (!res.ok) return false;
        const json = await res.json();
        if (
          activeIdRef.current !== id ||
          (generation !== undefined && sessionGenerationRef.current !== generation)
        ) {
          return false;
        }
        applyAgentState(id, json);
        // Sessions with no agent yet start on this client's default agent the
        // first time their state is fetched here. The coordinator starts the
        // attempt only for agentless sessions with the default agent
        // selectable, never while a user switch is in flight, and at most one
        // attempt at a time (a failure unmarks it for a later retry). The
        // started switch is awaited by user switches and prompts, so an
        // explicit selection and the first prompt cannot outrun it.
        const state = asRecord(json);
        const startDefault = coordinator?.noteAgentState({
          sessionID: id,
          currentAgent: str(state.currentAgent),
          agents: Array.isArray(state.agents) ? state.agents.map(asRecord) : undefined,
          switchInProgress: switchingAgentRef.current,
        });
        if (startDefault) {
          void applyDefaultAgent(id).then(startDefault, () => startDefault(false));
        }
        return true;
      } catch {
        return false;
      } finally {
        settleStateFetch?.();
      }
    },
    [apiFetch, applyAgentState, applyDefaultAgent],
  );

  const switchAgent = useCallback(
    async (agentID: string) => {
      const id = activeIdRef.current;
      if (!id || !agentID) return;
      const generation = sessionGenerationRef.current;
      setSwitchingAgent(true);
      switchingAgentRef.current = true;
      setError(null);
      try {
        // An automatic default may still be in flight for this session. Wait
        // for it to settle so this explicit selection is applied strictly
        // after it — the user's choice always wins regardless of request
        // timing. When no default was started this resolves immediately.
        await agentCoordinatorRef.current?.defaultOutcome(id);
        const res = await apiFetch(`/api/sessions/${encodeURIComponent(id)}/agent`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agentId: agentID }),
        });
        const result = asRecord(await res.json());
        if (!res.ok) {
          if (activeIdRef.current === id && sessionGenerationRef.current === generation) {
            await fetchAgentState(id, generation);
            setError(str(result.error) || "Failed to switch agent.");
          }
          return;
        }
        if (activeIdRef.current === id && sessionGenerationRef.current === generation) {
          applyAgentState(id, result);
        }
      } catch {
        if (activeIdRef.current === id && sessionGenerationRef.current === generation) {
          await fetchAgentState(id, generation);
          setError("Failed to switch agent.");
        }
      } finally {
        switchingAgentRef.current = false;
        if (activeIdRef.current === id && sessionGenerationRef.current === generation) {
          setSwitchingAgent(false);
        }
      }
    },
    [apiFetch, applyAgentState, fetchAgentState],
  );

  const switchModel = useCallback(
    async (model: ModelRef) => {
      const id = activeIdRef.current;
      if (!id) return;
      const generation = sessionGenerationRef.current;
      setSwitchingModel(true);
      setError(null);
      try {
        const res = await apiFetch(`/api/sessions/${encodeURIComponent(id)}/model`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model }),
        });
        const result = asRecord(await res.json());
        if (!res.ok) {
          if (activeIdRef.current === id && sessionGenerationRef.current === generation) {
            await fetchAgentState(id, generation);
            setError(str(result.error) || "Failed to switch model.");
          }
          return;
        }
        const selected = modelRef(result.model);
        if (selected && activeIdRef.current === id && sessionGenerationRef.current === generation) {
          setSessions((previous) =>
            previous.map((session) => session.id === id ? { ...session, model: selected } : session),
          );
        }
      } catch {
        if (activeIdRef.current === id && sessionGenerationRef.current === generation) {
          await fetchAgentState(id, generation);
          setError("Failed to switch model.");
        }
      } finally {
        if (activeIdRef.current === id && sessionGenerationRef.current === generation) {
          setSwitchingModel(false);
        }
      }
    },
    [apiFetch, fetchAgentState],
  );

  const setMessageCursor = useCallback((cursor: string | null) => {
    olderCursorRef.current = cursor;
    setOlderCursor(cursor);
  }, []);

  const fetchMessagePage = useCallback(
    async (id: string, cursor?: string) => {
      const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
      const res = await apiFetch(
        `/api/sessions/${encodeURIComponent(id)}/messages${query}`,
      );
      if (!res.ok) throw new Error(`message fetch failed: ${res.status}`);
      const json = asRecord(await res.json());
      const rawMessages = Array.isArray(json.messages) ? json.messages : [];
      let inboxMessages: MessageVM[] = [];
      let inboxSnapshotSucceeded = false;
      if (!cursor) {
        let inboxFailed = false;
        try {
          const inboxResponse = await apiFetch(`/api/sessions/${encodeURIComponent(id)}/inbox`);
          if (inboxResponse.ok) {
            const inbox = asRecord(await inboxResponse.json());
            inboxMessages = buildInboxUserMessages(inbox.items);
            inboxSnapshotSucceeded = true;
          } else {
            inboxFailed = true;
          }
        } catch {
          inboxFailed = true;
        }
        if (activeIdRef.current === id) {
          setError((previous) => inboxFailed
            ? "Could not check queued messages; accepted prompts may still be pending. Refresh to retry."
            : previous === "Could not check queued messages; accepted prompts may still be pending. Refresh to retry."
              ? null
              : previous,
          );
        }
      }
      return {
        messages: mergeMessageSnapshots(inboxMessages, buildVMs(rawMessages)),
        inboxSnapshotSucceeded,
        rawCount: rawMessages.length,
        nextCursor: str(json.nextCursor) || null,
      };
    },
    [apiFetch],
  );

  const refetchMessages = useCallback(async () => {
    const id = activeIdRef.current;
    if (!id) return false;
    const generation = sessionGenerationRef.current;
    const request = ++headRequestRef.current;
    try {
      const page = await fetchMessagePage(id);
      if (
        activeIdRef.current !== id ||
        sessionGenerationRef.current !== generation ||
        headRequestRef.current !== request
      ) {
        return false;
      }
      setHistory((previous) => reconcileMessageSnapshot(previous, page.messages, page.inboxSnapshotSucceeded));
      if (
        olderCursorRef.current === null &&
        !olderPageLoadedRef.current &&
        page.nextCursor
      ) {
        setMessageCursor(page.nextCursor);
      }
      const syncedAssistantIDs = new Set(
        page.messages
          .filter((message) => message.kind === "assistant")
          .map((message) => message.id),
      );
      setStreaming((previous) => {
        const next = new Map(previous);
        for (const [messageID, message] of next) {
          if (message.ended && syncedAssistantIDs.has(messageID)) {
            next.delete(messageID);
          }
        }
        return next;
      });
      setLoadingMessages(false);
      return true;
    } catch {
      /* unauthorized already routed to /signin */
      if (
        activeIdRef.current === id &&
        sessionGenerationRef.current === generation &&
        headRequestRef.current === request
      ) {
        setLoadingMessages(false);
      }
      return false;
    }
  }, [fetchMessagePage, setMessageCursor]);

  const loadOlderMessages = useCallback(async () => {
    const id = activeIdRef.current;
    const cursor = olderCursorRef.current;
    const generation = sessionGenerationRef.current;
    if (!id || !cursor || loadingOlderGenerationRef.current === generation) {
      return false;
    }

    loadingOlderGenerationRef.current = generation;
    setLoadingOlderMessages(true);
    try {
      const page = await fetchMessagePage(id, cursor);
      if (
        activeIdRef.current !== id ||
        sessionGenerationRef.current !== generation ||
        olderCursorRef.current !== cursor
      ) {
        return false;
      }
      setHistory((previous) => mergeMessageSnapshots(previous, page.messages));
      olderPageLoadedRef.current = true;
      setMessageCursor(page.nextCursor);
      return page.rawCount > 0;
    } catch {
      /* transient — keep the current page available */
      return false;
    } finally {
      if (loadingOlderGenerationRef.current === generation) {
        loadingOlderGenerationRef.current = null;
      }
      if (sessionGenerationRef.current === generation) {
        setLoadingOlderMessages(false);
      }
    }
  }, [fetchMessagePage, setMessageCursor]);

  // Coordinated pending-permission reconciliation: per-scope event revisions,
  // a shared snapshot sequence, and coverage-aware retry decisions live in
  // createPermissionReconciler (unit-tested for overlap/livelock scenarios).
  // Created in a mount effect (before any fetch trigger can run) so the
  // fetch/apply closures are not built during render.
  const permissionReconciler = useRef<PermissionReconciler | null>(null);
  useEffect(() => {
    if (permissionReconciler.current != null) return;
    permissionReconciler.current = createPermissionReconciler({
      fetchGlobal: async () => {
        try {
          const res = await apiFetch("/api/permissions/pending");
          // Never apply an error response: it would rebuild the map empty
          // and erase every session's pending permissions.
          if (!res.ok) return null;
          const json = asRecord(await res.json());
          const pending = Array.isArray(json.pending) ? json.pending : [];
          return { ok: true, permissions: normalizePendingPermissions(pending) };
        } catch {
          /* transient — next reconnect or focus retries */
          return null;
        }
      },
      fetchSession: async (sessionID) => {
        try {
          const res = await apiFetch(`/api/sessions/${sessionID}/permissions`);
          // Never apply an error response: it would erase the session's
          // pending permissions.
          if (!res.ok) return null;
          const json = asRecord(await res.json());
          const pending = Array.isArray(json.pending) ? json.pending : [];
          return { ok: true, permissions: normalizePendingPermissions(pending) };
        } catch {
          /* transient — next reconnect or focus retries */
          return null;
        }
      },
      applyGlobal: (permissions) => {
        setPermissionsBySession(permissionsFromPendingPayload({ pending: permissions }));
      },
      applySession: (sessionID, permissions) => {
        // Session-scoped write; other sessions keep their state. An empty
        // result clears a stale entry for this session.
        setPermissionsBySession((previous) => {
          const next = new Map(previous);
          next.set(sessionID, permissions as PendingPermission[]);
          return next;
        });
      },
      schedule: (run) => {
        permissionReconcileRetry.current?.schedule(run);
      },
    });
  }, [apiFetch]);

  const resyncPendingPermission = useCallback((sessionID?: string) => {
    const id = sessionID ?? activeIdRef.current;
    if (!id) return;
    void permissionReconciler.current?.reconcileSession(id);
  }, []);

  const refetchPendingPermissions = useCallback(() => {
    void permissionReconciler.current?.reconcileGlobal();
  }, []);

  const resyncPendingForms = useCallback(async () => {
    const token = {
      revision: formsRevisionRef.current,
      seq: ++formsSnapshotSeqRef.current,
    };
    try {
      const res = await apiFetch("/api/forms/pending");
      // Never apply an error response: it would replace optimistic
      // form.created upserts with an empty list.
      if (!res.ok) return;
      const json = asRecord(await res.json());
      const skipped = snapshotSkipped(token, {
        revision: formsRevisionRef.current,
        seq: formsSnapshotSeqRef.current,
      });
      if (skipped) {
        // Form snapshots all cover the same global scope, so one superseded
        // by a newer fetch is fully covered by it — no retry. An event race
        // retries once the burst settles instead of dropping reconciliation.
        if (skipped === "superseded") return;
        formsResyncRetry.current?.schedule(() => {
          resyncFormsLatestRef.current();
        });
        return;
      }
      setPendingForms(Array.isArray(json.forms) ? (json.forms as FormInfo[]) : []);
    } catch {
      /* transient — next reconnect or focus retries */
    }
  }, [apiFetch]);

  const resyncPendingQuestions = useCallback(async () => {
    const revision = pendingQuestionsRevisionRef.current;
    try {
      const res = await apiFetch("/api/questions/pending");
      if (!res.ok) return;
      const json = asRecord(await res.json());
      if (revision !== pendingQuestionsRevisionRef.current) return;
      const questions = Array.isArray(json.questions)
        ? json.questions.map(questionRequest).filter((item): item is PendingQuestion => Boolean(item))
        : [];
      setPendingQuestions(questions);
    } catch {
      /* transient — next reconnect or focus retries */
    }
  }, [apiFetch]);

  // Latest-callback mirror lets a skipped forms fetch schedule its own retry
  // without a circular useCallback dependency.
  useEffect(() => {
    resyncFormsLatestRef.current = () => void resyncPendingForms();
  }, [resyncPendingForms]);

  // Retry slots hold timers; cancel them on unmount.
  useEffect(
    () => () => {
      permissionReconcileRetry.current?.cancel();
      formsResyncRetry.current?.cancel();
    },
    [],
  );

  const openSession = useCallback(
    async (id: string) => {
      const sid = id;
      const generation = ++sessionGenerationRef.current;
      const request = ++headRequestRef.current;
      setActiveId(id);
      activeIdRef.current = id;
      setHistory([]);
      setStreaming(new Map());
      olderPageLoadedRef.current = false;
      setMessageCursor(null);
      setLoadingOlderMessages(false);
      setSwitchingAgent(false);
      switchingAgentRef.current = false;
      setSwitchingModel(false);
      setToolRunningCount(0);
      setAgents([]);
      setModels([]);
      setLoadingMessages(true);
      void fetchAgentState(id, generation);
      void resyncPendingPermission(id);
      void resyncPendingForms();
      void resyncPendingQuestions();
      try {
        const page = await fetchMessagePage(id);
        if (
          activeIdRef.current !== sid ||
          sessionGenerationRef.current !== generation ||
          headRequestRef.current !== request
        ) {
          return;
        }
        setHistory((previous) => mergeMessageSnapshots(previous, page.messages));
        setMessageCursor(page.nextCursor);
      } catch {
        /* unauthorized already routed to /signin */
      } finally {
        if (
          activeIdRef.current === sid &&
          sessionGenerationRef.current === generation &&
          headRequestRef.current === request
        ) {
          setLoadingMessages(false);
        }
      }
    },
    [fetchAgentState, fetchMessagePage, resyncPendingForms, resyncPendingPermission, resyncPendingQuestions, setMessageCursor],
  );

  // Leave the active session for the session list. Pending permissions are
  // intentionally retained in the per-session map so they remain visible as
  // badges and notices instead of vanishing until the next global refetch.
  const backToList = useCallback(() => {
    ++sessionGenerationRef.current;
    ++headRequestRef.current;
    activeIdRef.current = null;
    setActiveId(null);
    setAgents([]);
    setModels([]);
  }, []);

  const newChat = useCallback(async () => {
    try {
      const res = await apiFetch("/api/sessions", { method: "POST" });
      const json = asRecord(await res.json());
      const created = asRecord(json.session);
      const id = str(created.id);
      if (!id) return;
      const vm: SessionVM = {
        id,
        title: str(created.title),
        created: Number(created.created) || Date.now(),
        updated: Number(created.updated) || Date.now(),
        agent: str(created.agent),
        model: modelRef(created.model),
      };
      setSessions((prev) => [vm, ...prev]);
      await openSession(id);
    } catch {
      /* unauthorized already routed to /signin */
    }
  }, [apiFetch, openSession]);

  const persistComposerDraft = useCallback((sessionID: string, draft: ComposerDraftContent) => {
    setComposerDrafts((current) => updateComposerDraft(current, sessionID, draft));
  }, []);

  const finishComposerImageRead = useCallback((sessionID: string, imageID: string, result: { data: string } | { error: string }) => {
    setComposerDrafts((current) => {
      const draft = getComposerDraft(current, sessionID);
      if (!draft.images.some((image) => image.id === imageID)) return current;
      const images = draft.images.map((image) => image.id !== imageID
        ? image
        : "data" in result
          ? { ...image, data: result.data, error: undefined }
          : { ...image, data: null, error: result.error },
      );
      return updateComposerDraft(current, sessionID, {
        text: draft.text,
        mentions: draft.mentions,
        images,
      });
    });
  }, []);

  const clearComposerDraft = useCallback((sessionID: string, revision: number) => {
    setComposerDrafts((current) => clearComposerDraftIfRevision(current, sessionID, revision));
  }, []);

  const sendPrompt = useCallback(
    async (
      sessionID: string,
      text: string,
      attachments: PromptMentionAttachment[],
      images: PromptImageAttachment[],
      clientMessageID: string,
    ): Promise<boolean> => {
      const id = sessionID;
      const imageBytes = images.reduce((sum, image) => {
        const bytes = decodeCanonicalBase64(image.data);
        return sum + (bytes?.length ?? MAX_TOTAL_IMAGE_BYTES + 1);
      }, 0);
      if (!id || !text.trim() || imageBytes > MAX_TOTAL_IMAGE_BYTES || sendingSessionIDsRef.current.has(id)) return false;
      sendingSessionIDsRef.current.add(id);
      const generation = sessionGenerationRef.current;
      setHistory((previous) =>
        sortMessageSnapshot([
          ...previous.filter((message) => message.id !== clientMessageID),
          {
            kind: "user",
            id: clientMessageID,
            clientMessageID,
            text,
            time: Date.now(),
            images: images.map((image) => ({
              src: `data:${image.mime};base64,${image.data}`,
              name: image.name,
            })),
          },
        ]),
      );
      setSendingSessionIDs((current) => new Set(current).add(id));
      try {
        // Hold the prompt until the session's agent state has settled and any
        // automatic default for it has been applied, so an agentless session's
        // first prompt cannot run before this client's default agent is in
        // effect. When the default agent is unavailable or its switch fails,
        // this resolves anyway and the server's own configured default
        // applies rather than blocking the prompt indefinitely.
        await agentCoordinatorRef.current?.whenAgentStateSettled(id);
        const res = await apiFetch(`/api/sessions/${id}/prompt`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, clientMessageID, attachments, images }),
        });
        const responseBody = asRecord(await res.json().catch(() => ({})));
        if (!res.ok) throw new Error(str(responseBody.error) || `Prompt failed (${res.status}).`);
        setHistory((previous) => previous.map((message) =>
          message.id === clientMessageID && message.kind === "user"
            ? { ...message, queued: true }
            : message,
        ));
        void refetchMessages();
        return true;
      } catch (err) {
        if (
          activeIdRef.current === id &&
          sessionGenerationRef.current === generation
        ) {
          setHistory((previous) =>
            previous.filter((message) => message.id !== clientMessageID),
          );
          // A timeout can follow successful server admission; reconcile before treating the message as absent.
          void refetchMessages();
        }
        if (
          (err as Error).message !== "unauthorized" &&
          activeIdRef.current === id &&
          sessionGenerationRef.current === generation
        ) {
          setError((err as Error).message || "Failed to send message.");
        }
        return false;
      } finally {
        sendingSessionIDsRef.current.delete(id);
        setSendingSessionIDs((current) => {
          const next = new Set(current);
          next.delete(id);
          return next;
        });
      }
    },
    [apiFetch, refetchMessages],
  );

  // Create the global event stream once on mount.
  useEffect(() => {
    const es = new EventSource("/api/events");
    es.onmessage = (e: MessageEvent<string>) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(e.data);
      } catch {
        return;
      }
      const rec = asRecord(parsed);
      const type = str(rec.type);
      const d = asRecord(rec.data);
      const eventTime = Number(rec.created) || Date.now();
      switch (type) {
        case "session.status": {
          const sid = str(d.sessionID);
          const status = asRecord(d.status);
          if (sid) {
            if (
              status.type === "busy" ||
              status.type === "retry" ||
              status.type === "idle"
            ) {
              activityRevisionRef.current += 1;
            }
            setSessionActivity((previous) => {
              const next = new Map(previous);
              if (status.type === "busy" || status.type === "retry") {
                next.set(sid, "running");
              } else if (status.type === "idle") {
                next.delete(sid);
              }
              return next;
            });
          }
          break;
        }
        case "permission.asked": {
          const sid = str(d.sessionID);
          const pid = str(d.id);
          if (!sid || !pid) break;
          permissionReconciler.current?.noteEvent(sid);
          const permission: PendingPermission = {
            id: pid,
            sessionID: sid,
            action: str(d.action),
            resources: Array.isArray(d.resources)
              ? d.resources.map((r) => str(r)).filter(Boolean)
              : [],
            save: Array.isArray(d.save)
              ? d.save.map((s) => str(s)).filter(Boolean)
              : undefined,
            message: str(d.message) || undefined,
          };
          // Every session's pending permission is tracked in one place, so
          // state survives navigation; the active session additionally shows
          // its dialog and gets resync-corrected.
          setPermissionsBySession((previous) =>
            upsertPermission(previous, permission),
          );
          if (!sessionsRef.current.some((x) => x.id === sid)) void refetchSessions();
          break;
        }
        case "permission.replied": {
          const rid = str(d.requestID);
          if (!rid) break;
          const replySid = str(d.sessionID);
          if (replySid) permissionReconciler.current?.noteEvent(replySid);
          const activeHadIt = Boolean(
            activeIdRef.current &&
              permissionsBySessionRef.current
                .get(activeIdRef.current)
                ?.some((item) => item.id === rid),
          );
          setPermissionsBySession((previous) => removePermission(previous, rid));
          if (activeHadIt) void resyncPendingPermission();
          break;
        }
        case "session.inbox.enqueued":
        case "session.inbox.delivered":
        case "session.inbox.cancelled":
        case "session.inbox.delivery.changed": {
          const sid = str(d.sessionID);
          const inboxID = str(d.inboxID);
          if (sid === activeIdRef.current) {
            if (type === "session.inbox.cancelled" && inboxID) {
              setHistory((previous) => previous.filter((message) =>
                message.kind !== "user" ||
                (message.id !== `inbox-${inboxID}` && message.id !== inboxID && message.clientMessageID !== inboxID),
              ));
            }
            // Reconcile both the pending queue and the visible history at the durable boundary.
            void refetchMessages();
          }
          break;
        }
        case "session.agent.selected": {
          const sid = str(d.sessionID);
          const agent = str(d.agent);
          if (sid && agent) {
            setSessions((previous) =>
              previous.map((session) =>
                session.id === sid ? { ...session, agent } : session,
              ),
            );
            if (sid === activeIdRef.current) void fetchAgentState(sid);
          }
          break;
        }
        case "session.model.selected": {
          const sid = str(d.sessionID);
          const model = modelRef(d.model);
          if (sid && model) {
            setSessions((previous) =>
              previous.map((session) =>
                session.id === sid ? { ...session, model } : session,
              ),
            );
          }
          break;
        }
        case "agent.updated":
        case "config.updated":
          if (activeIdRef.current) void fetchAgentState(activeIdRef.current);
          break;
        case "form.created": {
          const form = asRecord(d.form);
          const sid = str(form.sessionID);
          const fid = str(form.id);
          if (sid && fid) {
            // The event carries the full form record; upsert it immediately so
            // a transient resync failure cannot silently lose the pending-form
            // state (the former toast showed from the event itself). The
            // resync below remains the reconciliation step: on success it
            // replaces this list with server truth, so no phantom entry
            // survives a disagreement.
            formsRevisionRef.current += 1;
            setPendingForms((previous) => [
              ...previous.filter((item) => item.id !== fid),
              form as unknown as FormInfo,
            ]);
            if (sid !== activeIdRef.current) {
              const session = sessionsRef.current.find((item) => item.id === sid);
              if (!session) void refetchSessions();
            }
          }
          // If the payload were ever missing id/sessionID this falls back to
          // resync-only (the pre-existing behavior).
          void resyncPendingForms();
          break;
        }
        case "form.replied":
        case "form.cancelled": {
          const formID = str(d.id);
          if (formID) {
            formsRevisionRef.current += 1;
            setPendingForms((previous) => previous.filter((form) => form.id !== formID));
          }
          void resyncPendingForms();
          break;
        }
        case "question.asked": {
          pendingQuestionsRevisionRef.current += 1;
          const question = questionRequest(d);
          if (!question) break;
          setPendingQuestions((previous) => [
            ...previous.filter((item) => item.id !== question.id),
            question,
          ]);
          if (question.sessionID !== activeIdRef.current) {
            const session = sessionsRef.current.find((item) => item.id === question.sessionID);
            if (!session) void refetchSessions();
          }
          break;
        }
        case "question.replied":
        case "question.rejected": {
          pendingQuestionsRevisionRef.current += 1;
          const requestID = str(d.requestID);
          if (requestID) {
            setPendingQuestions((previous) => previous.filter((item) => item.id !== requestID));
          }
          void resyncPendingQuestions();
          break;
        }
        case "session.text.started":
          if (str(d.sessionID)) {
            activityRevisionRef.current += 1;
            setSessionActivity((previous) => new Map(previous).set(str(d.sessionID), "running"));
          }
          if (str(d.sessionID) === activeIdRef.current) {
            const mid = str(d.assistantMessageID);
            if (!mid) break;
            setStreaming((previous) => {
              const next = new Map(previous);
              const current = next.get(mid);
              next.set(mid, {
                text: current?.text ?? "",
                time: current?.time ?? eventTime,
                ended: false,
              });
              return next;
            });
          }
          break;
        case "session.text.delta":
          if (
            str(d.sessionID) === activeIdRef.current &&
            typeof d.delta === "string"
          ) {
            const mid = str(d.assistantMessageID);
            if (!mid) break;
            setStreaming((prev) => {
              const next = new Map(prev);
              const current = next.get(mid);
              next.set(mid, {
                text: (current?.text ?? "") + d.delta,
                time: current?.time ?? eventTime,
                ended: false,
              });
              return next;
            });
          }
          break;
        case "session.text.ended":
          if (
            str(d.sessionID) === activeIdRef.current &&
            typeof d.text === "string"
          ) {
            const mid = str(d.assistantMessageID);
            if (!mid) break;
            const finalText = d.text;
            setStreaming((prev) => {
              const next = new Map(prev);
              const current = next.get(mid);
              next.set(mid, {
                text: finalText,
                time: current?.time ?? eventTime,
                ended: true,
              });
              return next;
            });
          }
          break;
        case "session.idle":
          if (str(d.sessionID)) {
            activityRevisionRef.current += 1;
            setSessionActivity((previous) => {
              const next = new Map(previous);
              next.delete(str(d.sessionID));
              return next;
            });
          }
          if (str(d.sessionID) === activeIdRef.current) {
            if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
            idleTimerRef.current = setTimeout(() => {
              void refetchMessages();
              setToolRunningCount(0);
            }, 400);
          }
          break;
        case "session.tool.called":
        case "session.tool.success":
        case "session.tool.failed":
          if (type === "session.tool.called" && str(d.sessionID)) {
            activityRevisionRef.current += 1;
            setSessionActivity((previous) => new Map(previous).set(str(d.sessionID), "running"));
          }
          if (str(d.sessionID) === activeIdRef.current) {
            setToolRunningCount((c) =>
              Math.max(0, type === "session.tool.called" ? c + 1 : c - 1),
            );
            if (toolTimerRef.current) clearTimeout(toolTimerRef.current);
            toolTimerRef.current = setTimeout(() => {
              void refetchMessages();
            }, 300);
          }
          break;
        case "session.created":
          void refetchSessions();
          break;
        case "server.connected":
          // A live event stream means connection-loss warnings are stale.
          setConnectionLost(false);
          void reconcileSessionActivity();
          void resyncPendingPermission();
          void resyncPendingForms();
          void resyncPendingQuestions();
          void refetchPendingPermissions();
          void refetchSessions();
          void refetchMessages();
          if (activeIdRef.current) void fetchAgentState(activeIdRef.current);
          break;
        default:
          break;
      }
    };
    const initialActivitySync = setTimeout(() => {
      void reconcileSessionActivity();
    }, 0);
    const activityInterval = setInterval(() => {
      void reconcileSessionActivity();
    }, 15000);
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) {
        // Permanent failure — the browser gave up reconnecting.
        setConnectionLost(true);
      } else if (es.readyState === EventSource.CONNECTING) {
        // Auto-reconnect in progress; clear any stale warning.
        setConnectionLost(false);
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void reconcileSessionActivity();
        void resyncPendingPermission();
        void resyncPendingForms();
        void resyncPendingQuestions();
        void refetchPendingPermissions();
        void refetchMessages();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      es.close();
      clearTimeout(initialActivitySync);
      clearInterval(activityInterval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      if (toolTimerRef.current) clearTimeout(toolTimerRef.current);
    };
  }, [
    reconcileSessionActivity,
    fetchAgentState,
    refetchSessions,
    refetchMessages,
    resyncPendingForms,
    resyncPendingQuestions,
    resyncPendingPermission,
    refetchPendingPermissions,
  ]);

  useEffect(() => {
    const t = setTimeout(() => {
      void refetchSessions();
      void refetchPendingPermissions();
      void resyncPendingForms();
      void resyncPendingQuestions();
    }, 0);
    return () => clearTimeout(t);
  }, [refetchSessions, refetchPendingPermissions, resyncPendingForms, resyncPendingQuestions]);

  const allPermissions = useMemo(
    () => Array.from(permissionsBySession.values()).flat(),
    [permissionsBySession],
  );

  const pendingCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of allPermissions) {
      counts.set(p.sessionID, (counts.get(p.sessionID) ?? 0) + 1);
    }
    for (const form of pendingForms) {
      counts.set(form.sessionID, (counts.get(form.sessionID) ?? 0) + 1);
    }
    for (const question of pendingQuestions) {
      counts.set(question.sessionID, (counts.get(question.sessionID) ?? 0) + 1);
    }
    return counts;
  }, [allPermissions, pendingForms, pendingQuestions]);

  const sessionStatuses = useMemo(() => {
    const statuses = new Map<string, SessionListStatus>(sessionActivity);
    for (const pending of allPermissions) statuses.set(pending.sessionID, "waiting");
    for (const form of pendingForms) statuses.set(form.sessionID, "waiting");
    for (const question of pendingQuestions) statuses.set(question.sessionID, "waiting");
    return statuses;
  }, [allPermissions, pendingForms, pendingQuestions, sessionActivity]);

  const displayMessages = useMemo(
    () => withStreamingMessages(history, streaming),
    [history, streaming],
  );

  const activeSession = sessions.find((session) => session.id === activeId);
  const activePermissions = useMemo(
    () => (activeId ? permissionsBySession.get(activeId) ?? [] : []),
    [activeId, permissionsBySession],
  );
  const activePendingForm = pendingForms.find((form) => form.sessionID === activeId);
  const activePendingQuestion = pendingQuestions.find((question) => question.sessionID === activeId);
  const agentNames = useMemo(
    () => Object.fromEntries(agents.map((agent) => [agent.id, agent.name])),
    [agents],
  );
  const subagentAgentNames = useMemo(
    () =>
      Object.fromEntries(
        sessions.flatMap((session) => {
          const agent = session.agent.trim();
          return agent ? [[session.id, agentNames[agent] || agent]] : [];
        }),
      ),
    [agentNames, sessions],
  );
  const showMobileList = !isDesktop && !activeId;
  const activeComposerDraft = activeId ? getComposerDraft(composerDrafts, activeId) : undefined;

  const attention = useMemo(
    () =>
      buildSessionAttention({
        sessions,
        otherPending: allPermissions,
        pendingForms,
        pendingQuestions,
        // The active session's requests surface as dialogs, not notices.
        excludeSessionID: activeId,
      }),
    [activeId, allPermissions, pendingForms, pendingQuestions, sessions],
  );
  const { visible: visibleAttention, overflowCount } = useMemo(
    () => splitSessionAttention(attention),
    [attention],
  );

  // Dispatches notification action buttons at event time; action ids are
  // declarative so no ref-writing callback flows through render-scope data.
  const handleNotificationAction = useCallback(
    (_item: NotificationItem, action: NotificationAction) => {
      if (action.id === NOTIFICATION_ACTION_RELOAD) {
        location.reload();
        return;
      }
      if (action.id === NOTIFICATION_ACTION_SHOW_LIST) {
        backToList();
        return;
      }
      // Otherwise the id is the sessionID to open.
      void openSession(action.id);
    },
    [backToList, openSession],
  );

  // Built during render; action ids keep this free of ref-writing callbacks.
  const politeItems: NotificationItem[] = visibleAttention.map((entry) => ({
    key: `attention-${entry.sessionID}`,
    severity: entry.primary === "permission" ? "warning" : "info",
    message: sessionAttentionMessage(entry),
    action: { id: entry.sessionID, label: "Open" },
  }));
  if (overflowCount > 0) {
    const overflowItem: NotificationItem = {
      key: "attention-overflow",
      severity: "info",
      message: overflowAttentionMessage(overflowCount),
    };
    // On mobile the hidden sessions are only reachable via the list, so give
    // the summary a usable action; the desktop sidebar already shows every
    // session with badges.
    if (!isDesktop) {
      overflowItem.action = { id: NOTIFICATION_ACTION_SHOW_LIST, label: "Show list" };
    }
    politeItems.push(overflowItem);
  }

  const assertiveItems = useMemo<NotificationItem[]>(() => {
    const items: NotificationItem[] = [];
    if (connectionLost) {
      items.push({
        key: "connection-lost",
        severity: "warning",
        message: "Live updates lost — reload the page to reconnect.",
        action: { id: NOTIFICATION_ACTION_RELOAD, label: "Reload" },
        onClose: () => setConnectionLost(false),
      });
    }
    if (error) {
      items.push({
        key: "app-error",
        severity: "error",
        message: error,
        onClose: () => setError(null),
      });
    }
    return items;
  }, [connectionLost, error]);

  const notificationArea = (
    <NotificationStack
      assertiveItems={assertiveItems}
      politeItems={politeItems}
      onAction={handleNotificationAction}
    />
  );
  const notificationCount = assertiveItems.length + politeItems.length;

  return (
    <Box
      sx={{
        display: "flex",
        height: "100dvh",
        overflow: "hidden",
        // Safe-area insets for this page's viewportFit: "cover" (page.tsx).
        // Each inset is a no-op wherever it resolves to 0; actual values are
        // device- and context-dependent (browser vs installed PWA, notch
        // side, keyboard state) and are not verified here — check on a real
        // device. Top is defensive: statusBarStyle "default" is expected to
        // keep content below the status bar, but this keeps the app bars
        // clear if a device reports a top inset under cover.
        paddingTop: "env(safe-area-inset-top, 0px)",
        paddingLeft: "env(safe-area-inset-left, 0px)",
        paddingRight: "env(safe-area-inset-right, 0px)",
      }}
    >
      {isDesktop && (
        <Box
          sx={{
            width: 320,
            flexShrink: 0,
            borderRight: 1,
            borderColor: "divider",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
        >
          <SessionList
            variant="desktop"
            sessions={sessions}
            sessionStatuses={sessionStatuses}
            pendingCounts={pendingCounts}
            activeId={activeId ?? undefined}
            onOpen={(id) => void openSession(id)}
            onNew={() => void newChat()}
            onLogout={() => void signOut({ redirectTo: "/signin" })}
          />
        </Box>
      )}

      {showMobileList ? (
        <Box sx={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          <SessionList
            variant="mobile"
            sessions={sessions}
            sessionStatuses={sessionStatuses}
            pendingCounts={pendingCounts}
            activeId={activeId ?? undefined}
            onOpen={(id) => void openSession(id)}
            onNew={() => void newChat()}
            onLogout={() => void signOut({ redirectTo: "/signin" })}
            notificationArea={notificationArea}
          />
        </Box>
      ) : activeId ? (
        <Box sx={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          <ChatView
            key={activeId}
            sessionID={activeId}
            draft={activeComposerDraft!}
            onDraftChange={persistComposerDraft}
            onImageRead={finishComposerImageRead}
            onClearDraft={clearComposerDraft}
            title={activeSession?.title || "Untitled"}
            messages={displayMessages}
            agentNames={agentNames}
            subagentAgentNames={subagentAgentNames}
            agentId={activeSession?.agent ?? ""}
            agents={agents}
            agentBusy={switchingAgent}
            model={activeSession?.model}
            models={models}
            modelBusy={switchingModel}
            onSwitchAgent={(agentID) => void switchAgent(agentID)}
            onSwitchModel={(model) => void switchModel(model)}
            toolRunningCount={toolRunningCount}
            sessionWorking={sessionStatuses.get(activeId) === "running"}
            loading={loadingMessages}
            hasOlderMessages={olderCursor !== null}
            loadingOlderMessages={loadingOlderMessages}
            sending={sendingSessionIDs.has(activeId) || switchingAgent || switchingModel}
            onSend={sendPrompt}
            onBack={isDesktop ? undefined : backToList}
            onRefresh={() => {
              void refetchMessages();
              void fetchAgentState(activeId);
              void resyncPendingPermission();
              void resyncPendingForms();
              void resyncPendingQuestions();
            }}
            onLoadOlder={loadOlderMessages}
            onOpenSession={openSession}
            notificationArea={notificationArea}
            notificationCount={notificationCount}
          />
        </Box>
      ) : (
        <Box
          sx={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
          }}
        >
          <Box
            sx={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Stack spacing={1} sx={{ alignItems: "center" }}>
              <ForumOutlined sx={{ fontSize: 48, color: "text.disabled" }} />
              <Typography color="text.secondary">Select a session</Typography>
            </Stack>
          </Box>
          {notificationArea && (
            <Box sx={{ px: 1.5, pb: "calc(8px + env(safe-area-inset-bottom, 0px))" }}>
              {notificationArea}
            </Box>
          )}
        </Box>
      )}

      {activePermissions[0] && activeId && (
        <PermissionDialog
          permission={activePermissions[0]}
          sessionId={activeId}
          onDone={() => void resyncPendingPermission()}
        />
      )}
      {activePermissions.length === 0 && activeId && activePendingQuestion && (
        <QuestionDialog
          key={activePendingQuestion.id}
          request={activePendingQuestion}
          onDone={() => {
            setPendingQuestions((previous) => previous.filter((item) => item.id !== activePendingQuestion.id));
            void resyncPendingQuestions();
          }}
        />
      )}
      {activePermissions.length === 0 && !activePendingQuestion && activeId && activePendingForm && (
        <FormDialog
          key={activePendingForm.id}
          form={activePendingForm}
          sessionID={activeId}
          onDone={() => {
            setPendingForms((previous) => previous.filter((item) => item.id !== activePendingForm.id));
            void resyncPendingForms();
          }}
        />
      )}
    </Box>
  );
}
