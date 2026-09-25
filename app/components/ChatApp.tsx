"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Alert,
  Box,
  Button,
  Snackbar,
  Stack,
  Typography,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import ForumOutlined from "@mui/icons-material/ForumOutlined";
import type { FormInfo, ModelRef } from "@opencode/client";
import { signOut } from "next-auth/react";
import SessionList from "./SessionList";
import ChatView from "./ChatView";
import PermissionDialog from "./PermissionDialog";
import FormDialog from "./FormDialog";

export interface SessionVM {
  id: string;
  parentID?: string;
  title: string;
  created: number;
  updated: number;
  agent: string;
  model?: ModelRef;
}

interface AgentOptionVM {
  id: string;
  name: string;
  description: string;
  model?: ModelRef | null;
}

export type PartVM =
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; name: string; status: string; subagentSessionID?: string };

export type MessageVM =
  | {
      kind: "user";
      id: string;
      text: string;
      time?: number;
      clientMessageID?: string;
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
  action: string;
  resources: string[];
  save?: string[];
  message?: string;
}

type OtherPending = { id: string; sessionID: string; action: string; message?: string };

type PermissionToast = { sessionID: string; title: string; count: number; key: number };

/* Raw shapes used only to map history into view models. */
interface RawPart {
  type: string;
  text?: unknown;
  id?: unknown;
  name?: unknown;
  state?: { status?: unknown; metadata?: unknown };
}

interface RawMessage {
  type: string;
  id?: unknown;
  text?: unknown;
  metadata?: unknown;
  content?: RawPart[];
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

function modelRef(v: unknown): ModelRef | undefined {
  const record = asRecord(v);
  const id = str(record.id);
  const providerID = str(record.providerID);
  if (!id || !providerID) return undefined;
  const variant = str(record.variant);
  return { id, providerID, ...(variant ? { variant } : {}) };
}

function sortVMs(messages: MessageVM[]): MessageVM[] {
  return messages
    .map((message, index) => ({ message, index }))
    .sort(
      (a, b) =>
        (a.message.time ?? 0) - (b.message.time ?? 0) || a.index - b.index,
    )
    .map(({ message }) => message);
}

function mergeVMs(existing: MessageVM[], incoming: MessageVM[]): MessageVM[] {
  const byID = new Map(existing.map((message) => [message.id, message]));

  for (const message of incoming) {
    if (message.kind === "user" && message.clientMessageID) {
      for (const [id, current] of byID) {
        if (
          current.kind === "user" &&
          current.clientMessageID === message.clientMessageID &&
          id !== message.id
        ) {
          byID.delete(id);
        }
      }
    }
    byID.set(message.id, message);
  }

  return sortVMs(Array.from(byID.values()));
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
          const metadata = asRecord(asRecord(p.state).metadata);
          parts.push({
            kind: "tool",
            id: str(p.id) || `tool-${parts.length}`,
            name: str(p.name) || "tool",
            status: str(p.state?.status) || "running",
            subagentSessionID: str(metadata.sessionID) || undefined,
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
  return sortVMs(out);
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

  return sortVMs(Array.from(byID.values()));
}

export default function ChatApp() {
  const router = useRouter();
  const theme = useTheme();
  const isDesktop = useMediaQuery(theme.breakpoints.up("md"));

  const [sessions, setSessions] = useState<SessionVM[]>([]);
  const [agents, setAgents] = useState<AgentOptionVM[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [history, setHistory] = useState<MessageVM[]>([]);
  const [streaming, setStreaming] = useState<Map<string, StreamingVM>>(new Map());
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);
  const [toolRunningCount, setToolRunningCount] = useState(0);
  const [pendingPermissions, setPendingPermissions] = useState<PendingPermission[]>([]);
  const [pendingForms, setPendingForms] = useState<FormInfo[]>([]);
  const [sending, setSending] = useState(false);
  const [switchingAgent, setSwitchingAgent] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectionLost, setConnectionLost] = useState(false);
  const [otherPending, setOtherPending] = useState<OtherPending[]>([]);
  const [permissionToast, setPermissionToast] = useState<PermissionToast | null>(null);

  const activeIdRef = useRef<string | null>(null);
  const sessionGenerationRef = useRef(0);
  const headRequestRef = useRef(0);
  const olderCursorRef = useRef<string | null>(null);
  const olderPageLoadedRef = useRef(false);
  const loadingOlderGenerationRef = useRef<number | null>(null);
  const pendingPermissionsRef = useRef<PendingPermission[]>([]);
  const sessionsRef = useRef<SessionVM[]>([]);
  const otherPendingRef = useRef<OtherPending[]>([]);
  const toastKeyRef = useRef(0);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toolTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  useEffect(() => {
    pendingPermissionsRef.current = pendingPermissions;
  }, [pendingPermissions]);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    otherPendingRef.current = otherPending;
  }, [otherPending]);

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

  const fetchAgentState = useCallback(
    async (id: string, generation?: number) => {
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
        return true;
      } catch {
        return false;
      }
    },
    [apiFetch, applyAgentState],
  );

  const switchAgent = useCallback(
    async (agentID: string) => {
      const id = activeIdRef.current;
      if (!id || !agentID) return;
      const generation = sessionGenerationRef.current;
      setSwitchingAgent(true);
      setError(null);
      try {
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
        if (activeIdRef.current === id && sessionGenerationRef.current === generation) {
          setSwitchingAgent(false);
        }
      }
    },
    [apiFetch, applyAgentState, fetchAgentState],
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
      return {
        messages: buildVMs(rawMessages),
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
      setHistory((previous) => mergeVMs(previous, page.messages));
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
      setHistory((previous) => mergeVMs(previous, page.messages));
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

  const resyncPendingPermission = useCallback(async () => {
    const id = activeIdRef.current;
    const generation = sessionGenerationRef.current;
    if (!id) return;
    try {
      const res = await apiFetch(`/api/sessions/${id}/permissions`);
      const json = asRecord(await res.json());
      const pending = Array.isArray(json.pending) ? json.pending : [];
      if (
        activeIdRef.current !== id ||
        sessionGenerationRef.current !== generation
      ) return;
      setPendingPermissions(pending as PendingPermission[]);
    } catch {
      /* transient — next reconnect or focus retries */
    }
  }, [apiFetch]);

  const resyncPendingForms = useCallback(async () => {
    const id = activeIdRef.current;
    const generation = sessionGenerationRef.current;
    if (!id) return;
    try {
      const res = await apiFetch(`/api/sessions/${encodeURIComponent(id)}/forms`);
      if (!res.ok) return;
      const json = asRecord(await res.json());
      if (
        activeIdRef.current !== id ||
        sessionGenerationRef.current !== generation
      ) {
        return;
      }
      setPendingForms(Array.isArray(json.forms) ? (json.forms as FormInfo[]) : []);
    } catch {
      /* transient — next reconnect or focus retries */
    }
  }, [apiFetch]);

  const refetchPendingPermissions = useCallback(async () => {
    try {
      const res = await apiFetch("/api/permissions/pending");
      const json = asRecord(await res.json());
      const pending = Array.isArray(json.pending) ? json.pending : [];
      setOtherPending(
        pending.map((p) => {
          const r = asRecord(p);
          return {
            id: str(r.id),
            sessionID: str(r.sessionID),
            action: str(r.action),
            message: str(r.message) || undefined,
          };
        }),
      );
    } catch {
      /* transient — next reconnect or focus retries */
    }
  }, [apiFetch]);

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
      setSending(false);
      setSwitchingAgent(false);
      setToolRunningCount(0);
      setPendingPermissions([]);
      setPendingForms([]);
      setAgents([]);
      setLoadingMessages(true);
      void fetchAgentState(id, generation);
      void resyncPendingPermission();
      void resyncPendingForms();
      try {
        const page = await fetchMessagePage(id);
        if (
          activeIdRef.current !== sid ||
          sessionGenerationRef.current !== generation ||
          headRequestRef.current !== request
        ) {
          return;
        }
        setHistory((previous) => mergeVMs(previous, page.messages));
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
    [fetchAgentState, fetchMessagePage, resyncPendingForms, resyncPendingPermission, setMessageCursor],
  );

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

  const sendPrompt = useCallback(
    async (text: string): Promise<boolean> => {
      const id = activeIdRef.current;
      if (!id || !text.trim()) return false;
      const generation = sessionGenerationRef.current;
      const clientMessageID = `tmp-${crypto.randomUUID()}`;
      setHistory((previous) =>
        sortVMs([
          ...previous,
          {
            kind: "user",
            id: clientMessageID,
            clientMessageID,
            text,
            time: Date.now(),
          },
        ]),
      );
      setSending(true);
      try {
        const res = await apiFetch(`/api/sessions/${id}/prompt`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, clientMessageID }),
        });
        if (!res.ok) throw new Error(`prompt failed: ${res.status}`);
        return true;
      } catch (err) {
        if (
          activeIdRef.current === id &&
          sessionGenerationRef.current === generation
        ) {
          setHistory((previous) =>
            previous.filter((message) => message.id !== clientMessageID),
          );
        }
        if (
          (err as Error).message !== "unauthorized" &&
          activeIdRef.current === id &&
          sessionGenerationRef.current === generation
        ) {
          setError("Failed to send message.");
        }
        return false;
      } finally {
        if (
          activeIdRef.current === id &&
          sessionGenerationRef.current === generation
        ) {
          setSending(false);
        }
      }
    },
    [apiFetch],
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
        case "permission.asked":
          if (str(d.sessionID) === activeIdRef.current) {
            const permission: PendingPermission = {
              id: str(d.id),
              action: str(d.action),
              resources: Array.isArray(d.resources)
                ? d.resources.map((r) => str(r)).filter(Boolean)
                : [],
              save: Array.isArray(d.save)
                ? d.save.map((s) => str(s)).filter(Boolean)
                : undefined,
              message: str(d.message) || undefined,
            };
            setPendingPermissions((previous) => [
              ...previous.filter((item) => item.id !== permission.id),
              permission,
            ]);
          } else {
            const sid = str(d.sessionID);
            const pid = str(d.id);
            const entry: OtherPending = {
              id: pid,
              sessionID: sid,
              action: str(d.action),
              message: str(d.message) || undefined,
            };
            setOtherPending((prev) => [...prev.filter((x) => x.id !== pid), entry]);
            const s = sessionsRef.current.find((x) => x.id === sid);
            if (!s) void refetchSessions();
            const title = s?.title || "Untitled";
            setPermissionToast((prev) =>
              prev && prev.sessionID === sid
                ? { ...prev, count: prev.count + 1, key: ++toastKeyRef.current }
                : { sessionID: sid, title, count: 1, key: ++toastKeyRef.current },
            );
          }
          break;
        case "permission.replied": {
          const rid = str(d.requestID);
          if (pendingPermissionsRef.current.some((item) => item.id === rid)) {
            setPendingPermissions((previous) => previous.filter((item) => item.id !== rid));
            void resyncPendingPermission();
          }
          const sid2 = str(d.sessionID);
          const next = otherPendingRef.current.filter((x) => x.id !== rid);
          if (next.length !== otherPendingRef.current.length) setOtherPending(next);
          setPermissionToast((t) => (t && t.sessionID === sid2 ? null : t));
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
          if (str(form.sessionID) === activeIdRef.current) void resyncPendingForms();
          break;
        }
        case "form.replied":
        case "form.cancelled":
          if (str(d.sessionID) === activeIdRef.current) void resyncPendingForms();
          break;
        case "session.text.started":
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
          void resyncPendingPermission();
          void resyncPendingForms();
          void refetchPendingPermissions();
          void refetchSessions();
          void refetchMessages();
          if (activeIdRef.current) void fetchAgentState(activeIdRef.current);
          break;
        default:
          break;
      }
    };
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
        void resyncPendingPermission();
        void resyncPendingForms();
        void refetchPendingPermissions();
        void refetchMessages();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      es.close();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      if (toolTimerRef.current) clearTimeout(toolTimerRef.current);
    };
  }, [
    fetchAgentState,
    refetchSessions,
    refetchMessages,
    resyncPendingForms,
    resyncPendingPermission,
    refetchPendingPermissions,
  ]);

  useEffect(() => {
    const t = setTimeout(() => {
      void refetchSessions();
      void refetchPendingPermissions();
    }, 0);
    return () => clearTimeout(t);
  }, [refetchSessions, refetchPendingPermissions]);

  const pendingCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of otherPending) {
      counts.set(p.sessionID, (counts.get(p.sessionID) ?? 0) + 1);
    }
    return counts;
  }, [otherPending]);

  const displayMessages = useMemo(
    () => withStreamingMessages(history, streaming),
    [history, streaming],
  );

  const activeSession = sessions.find((session) => session.id === activeId);
  const agentNames = useMemo(
    () => Object.fromEntries(agents.map((agent) => [agent.id, agent.name])),
    [agents],
  );
  const showMobileList = !isDesktop && !activeId;

  return (
    <Box sx={{ display: "flex", height: "100dvh", overflow: "hidden" }}>
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
            pendingCounts={pendingCounts}
            activeId={activeId ?? undefined}
            onOpen={(id) => void openSession(id)}
            onNew={() => void newChat()}
            onLogout={() => void signOut({ redirectTo: "/signin" })}
          />
        </Box>
      ) : activeId ? (
        <Box sx={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          <ChatView
            title={activeSession?.title || "Untitled"}
            messages={displayMessages}
            agentNames={agentNames}
            agentId={activeSession?.agent ?? ""}
            agents={agents}
            agentBusy={switchingAgent}
            onSwitchAgent={(agentID) => void switchAgent(agentID)}
            toolRunningCount={toolRunningCount}
            loading={loadingMessages}
            hasOlderMessages={olderCursor !== null}
            loadingOlderMessages={loadingOlderMessages}
            sending={sending || switchingAgent}
            onSend={sendPrompt}
            onBack={
              isDesktop
                ? undefined
                : () => {
                    ++sessionGenerationRef.current;
                    ++headRequestRef.current;
                    activeIdRef.current = null;
                    setActiveId(null);
                    setAgents([]);
                    setPendingForms([]);
                    setPendingPermissions([]);
                  }
            }
            onRefresh={() => {
              void refetchMessages();
              void fetchAgentState(activeId);
              void resyncPendingPermission();
              void resyncPendingForms();
            }}
            onLoadOlder={loadOlderMessages}
            onOpenSession={openSession}
          />
        </Box>
      ) : (
        <Box
          sx={{
            flex: 1,
            minWidth: 0,
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
      )}

      {pendingPermissions[0] && activeId && (
        <PermissionDialog
          permission={pendingPermissions[0]}
          sessionId={activeId}
          onDone={() => void resyncPendingPermission()}
        />
      )}
      {pendingPermissions.length === 0 && pendingForms[0] && activeId && (
        <FormDialog
          key={pendingForms[0].id}
          form={pendingForms[0]}
          sessionID={activeId}
          onDone={() => {
            setPendingForms((previous) => previous.filter((form) => form.id !== pendingForms[0].id));
            void resyncPendingForms();
          }}
        />
      )}

      <Snackbar
        key={permissionToast?.key ?? 0}
        open={permissionToast !== null}
        autoHideDuration={7000}
        slotProps={{
          content: { sx: { borderRadius: 2 } },
        }}
        onClose={(_e, reason) => {
          if (reason !== "clickaway") setPermissionToast(null);
        }}
        message={
          permissionToast
            ? `Session “${permissionToast.title}” needs approval${permissionToast.count > 1 ? ` (${permissionToast.count} pending)` : ""}`
            : ""
        }
        action={
          permissionToast && (
            <Button
              color="inherit"
              variant="outlined"
              size="small"
              sx={{ height: 40, flexShrink: 0 }}
              onClick={() => {
                const sid = permissionToast.sessionID;
                setPermissionToast(null);
                void openSession(sid);
              }}
            >
              Open
            </Button>
          )
        }
        sx={{
          position: "fixed",
          bottom: 88,
          left: 16,
          right: 16,
          zIndex: (t) => t.zIndex.snackbar,
        }}
      />

      {connectionLost && (
        <Alert
          severity="warning"
          onClose={() => setConnectionLost(false)}
          sx={{
            position: "fixed",
            bottom: 88,
            left: 16,
            right: 16,
            zIndex: (t) => t.zIndex.snackbar - 1,
          }}
          action={
            <Button
              variant="outlined"
              size="small"
              sx={{ height: 40 }}
              onClick={() => location.reload()}
            >
              Reload
            </Button>
          }
        >
          Live updates lost — reload the page to reconnect.
        </Alert>
      )}

      {error && (
        <Alert
          severity="error"
          onClose={() => setError(null)}
          sx={{
            position: "fixed",
            bottom: 88,
            left: 16,
            right: 16,
            zIndex: (t) => t.zIndex.snackbar,
          }}
        >
          {error}
        </Alert>
      )}
    </Box>
  );
}
