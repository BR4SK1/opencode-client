"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Alert,
  Box,
  Button,
  Typography,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import { signOut } from "next-auth/react";
import SessionList from "./SessionList";
import ChatView from "./ChatView";
import PermissionDialog from "./PermissionDialog";

export interface SessionVM {
  id: string;
  parentID?: string;
  title: string;
  created: number;
  updated: number;
}

export type PartVM =
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; name: string; status: string };

export type MessageVM =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; parts: PartVM[] };

export interface PendingPermission {
  id: string;
  action: string;
  resources: string[];
  save?: string[];
  message?: string;
}

/* Raw shapes used only to map history into view models. */
interface RawPart {
  type: string;
  text?: unknown;
  id?: unknown;
  name?: unknown;
  state?: { status?: unknown };
}

interface RawMessage {
  type: string;
  id?: unknown;
  text?: unknown;
  content?: RawPart[];
  time?: { created?: unknown };
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
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
  chronological.forEach(({ m }, i) => {
    if (m.type === "user" && typeof m.text === "string") {
      out.push({
        kind: "user",
        id: str(m.id) || `user-${i}`,
        text: m.text,
      });
    } else if (m.type === "assistant") {
      const parts: PartVM[] = [];
      for (const p of m.content ?? []) {
        if (p.type === "text" && typeof p.text === "string") {
          parts.push({ kind: "text", text: p.text });
        } else if (p.type === "tool") {
          parts.push({
            kind: "tool",
            id: str(p.id) || `tool-${parts.length}`,
            name: str(p.name) || "tool",
            status: str(p.state?.status) || "running",
          });
        }
        // reasoning parts are skipped in the MVP
      }
      out.push({
        kind: "assistant",
        id: str(m.id) || `assistant-${i}`,
        parts,
      });
    }
    // all other message types (idle/system/compaction/agent-selected/...) are skipped
  });
  return out;
}

export default function ChatApp() {
  const router = useRouter();
  const theme = useTheme();
  const isDesktop = useMediaQuery(theme.breakpoints.up("md"));

  const [sessions, setSessions] = useState<SessionVM[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [history, setHistory] = useState<MessageVM[]>([]);
  const [streaming, setStreaming] = useState<Map<string, string>>(new Map());
  const [endedIds, setEndedIds] = useState<Set<string>>(new Set());
  const [toolRunningCount, setToolRunningCount] = useState(0);
  const [pendingPermission, setPendingPermission] =
    useState<PendingPermission | null>(null);
  const [sending, setSending] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectionLost, setConnectionLost] = useState(false);

  const activeIdRef = useRef<string | null>(null);
  const pendingPermissionRef = useRef<PendingPermission | null>(null);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toolTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  useEffect(() => {
    pendingPermissionRef.current = pendingPermission;
  }, [pendingPermission]);

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

  const refetchMessages = useCallback(async () => {
    const id = activeIdRef.current;
    if (!id) return;
    try {
      const res = await apiFetch(`/api/sessions/${id}/messages`);
      const json = asRecord(await res.json());
      setHistory(buildVMs(json.messages));
    } catch {
      /* unauthorized already routed to /signin */
    }
  }, [apiFetch]);

  const resyncPendingPermission = useCallback(async () => {
    const id = activeIdRef.current;
    if (!id) return;
    try {
      const res = await apiFetch(`/api/sessions/${id}/permissions`);
      const json = asRecord(await res.json());
      const pending = Array.isArray(json.pending) ? json.pending : [];
      if (activeIdRef.current !== id) return;
      if (pending.length > 0) {
        setPendingPermission(pending[0] as PendingPermission);
      } else {
        if (pendingPermissionRef.current) setPendingPermission(null);
      }
    } catch {
      /* transient — next reconnect or focus retries */
    }
  }, [apiFetch]);

  const openSession = useCallback(
    async (id: string) => {
      const sid = id;
      setActiveId(id);
      activeIdRef.current = id;
      setHistory([]);
      setStreaming(new Map());
      setEndedIds(new Set());
      setToolRunningCount(0);
      setPendingPermission(null);
      setLoadingMessages(true);
      try {
        const res = await apiFetch(`/api/sessions/${id}/messages`);
        const json = asRecord(await res.json());
        setHistory(buildVMs(json.messages));
      } catch {
        /* unauthorized already routed to /signin */
      } finally {
        setLoadingMessages(false);
      }
      try {
        const res = await apiFetch(`/api/sessions/${id}/permissions`);
        const json = asRecord(await res.json());
        const pending = Array.isArray(json.pending) ? json.pending : [];
        if (pending.length > 0 && activeIdRef.current === sid) {
          setPendingPermission(pending[0] as PendingPermission);
        }
      } catch {
        /* unauthorized already routed to /signin */
      }
    },
    [apiFetch],
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
      const tmpId = `tmp-${Date.now()}`;
      setHistory((h) => [...h, { kind: "user", id: tmpId, text }]);
      setSending(true);
      try {
        const res = await apiFetch(`/api/sessions/${id}/prompt`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        });
        if (!res.ok) throw new Error(`prompt failed: ${res.status}`);
        return true;
      } catch (err) {
        setHistory((h) => h.filter((m) => m.id !== tmpId));
        if ((err as Error).message !== "unauthorized") {
          setError("Failed to send message.");
        }
        return false;
      } finally {
        setSending(false);
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
      switch (type) {
        case "permission.asked":
          if (str(d.sessionID) === activeIdRef.current) {
            setPendingPermission({
              id: str(d.id),
              action: str(d.action),
              resources: Array.isArray(d.resources)
                ? d.resources.map((r) => str(r)).filter(Boolean)
                : [],
              save: Array.isArray(d.save)
                ? d.save.map((s) => str(s)).filter(Boolean)
                : undefined,
              message: str(d.message) || undefined,
            });
          }
          break;
        case "permission.replied":
          if (pendingPermissionRef.current?.id === str(d.requestID)) {
            setPendingPermission(null);
          }
          break;
        case "session.text.delta":
          if (
            str(d.sessionID) === activeIdRef.current &&
            typeof d.delta === "string"
          ) {
            const mid = str(d.assistantMessageID);
            setStreaming((prev) => {
              const next = new Map(prev);
              next.set(mid, (next.get(mid) ?? "") + d.delta);
              return next;
            });
            setEndedIds((prev) => {
              const next = new Set(prev);
              next.delete(mid);
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
            const finalText = d.text;
            setStreaming((prev) => {
              const next = new Map(prev);
              next.set(mid, finalText);
              return next;
            });
            setEndedIds((prev) => new Set(prev).add(mid));
          }
          break;
        case "session.idle":
          if (str(d.sessionID) === activeIdRef.current) {
            if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
            idleTimerRef.current = setTimeout(() => {
              void refetchMessages();
              setStreaming(new Map());
              setEndedIds(new Set());
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
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      es.close();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      if (toolTimerRef.current) clearTimeout(toolTimerRef.current);
    };
  }, [refetchSessions, refetchMessages, resyncPendingPermission]);

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
            onOpen={(id) => void openSession(id)}
            onNew={() => void newChat()}
            onLogout={() => void signOut({ redirectTo: "/signin" })}
          />
        </Box>
      ) : activeId ? (
        <Box sx={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          <ChatView
            title={sessions.find((s) => s.id === activeId)?.title || "Untitled"}
            messages={history}
            streaming={streaming}
            endedIds={endedIds}
            toolRunningCount={toolRunningCount}
            loading={loadingMessages}
            sending={sending}
            onSend={sendPrompt}
            onBack={isDesktop ? undefined : () => setActiveId(null)}
            onRefresh={() => void refetchMessages()}
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
          <Typography color="text.secondary">Select a session</Typography>
        </Box>
      )}

      {pendingPermission && activeId && (
        <PermissionDialog
          permission={pendingPermission}
          sessionId={activeId}
          onDone={() => setPendingPermission(null)}
        />
      )}

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