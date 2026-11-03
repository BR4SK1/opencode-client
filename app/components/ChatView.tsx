"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import ArrowBack from "@mui/icons-material/ArrowBack";
import ChevronRight from "@mui/icons-material/ChevronRight";
import Close from "@mui/icons-material/Close";
import ExpandMore from "@mui/icons-material/ExpandMore";
import MenuIcon from "@mui/icons-material/Menu";
import Refresh from "@mui/icons-material/Refresh";
import Send from "@mui/icons-material/Send";
import SmartToy from "@mui/icons-material/SmartToy";
import InsertDriveFileOutlined from "@mui/icons-material/InsertDriveFileOutlined";
import FolderOpenOutlined from "@mui/icons-material/FolderOpenOutlined";
import LibraryBooksOutlined from "@mui/icons-material/LibraryBooksOutlined";
import type { ModelRef } from "@opencode/client";
import {
  trackMentionEdits,
  findActiveMentionQuery,
  type ActiveMentionQuery,
  type MentionCandidate,
  type MentionDescriptor,
  type PromptMentionAttachment,
} from "@/lib/prompt-mentions";
import {
  isSameDismissedMention,
  prepareComposerDraftSubmission,
  removeComposerMention,
  resolveComposerKeyAction,
  type ComposerDraft,
  type ComposerDraftContent,
  type ComposerDraftMention,
} from "@/lib/composer-drafts";
import {
  scheduleMentionSearch,
  sameMentionRequest,
  type MentionSearchRequest,
} from "@/lib/mention-search";
import {
  AppBar,
  Avatar,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  Drawer,
  FormControl,
  IconButton,
  LinearProgress,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Paper,
  MenuItem,
  Select,
  Stack,
  TextField,
  Toolbar,
  Typography,
} from "@mui/material";
import type { MessageVM, PartVM } from "./ChatApp";
import { ThemeSelector } from "./ThemeSelector";
import BrailleShading from "./BrailleShading";
import MarkdownText from "./MarkdownText";

function toolChipIcon(status: string): string {
  if (status === "completed") return "✓";
  if (status === "error") return "✕";
  return "↻";
}

function readableToolStatus(status: string): string {
  if (status === "completed") return "Completed";
  if (status === "error") return "Failed";
  if (status === "streaming") return "Starting";
  return "Running";
}

/** HH:MM in the user's locale; tolerates second- and millisecond-epochs. */
function formatTime(time: number): string {
  const ms = time < 1e12 ? time * 1000 : time;
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function AssistantHeader({ time, agent }: { time?: number; agent?: string }) {
  return (
    <Stack direction="row" spacing={0.75} sx={{ alignItems: "center" }}>
      <Avatar sx={{ width: 24, height: 24, bgcolor: "primary.main" }}>
        <SmartToy sx={{ fontSize: 14, color: "primary.contrastText" }} />
      </Avatar>
      <Typography variant="caption" sx={{ color: "text.secondary", fontWeight: 600 }}>
        {agent ? `OpenCode · ${agent}` : "OpenCode"}
      </Typography>
      {time !== undefined && (
        <Typography variant="caption" sx={{ color: "text.secondary" }}>
          {formatTime(time)}
        </Typography>
      )}
    </Stack>
  );
}

function AssistantBubble({ children }: { children: React.ReactNode }) {
  /*
   * Agent responses are plain full-width text: no chat bubble, no border, no
   * background — only a small inset from the screen edge (owned by the
   * message list padding). Markdown segmentation is untouched.
   */
  return (
    <Stack spacing={1} sx={{ width: "100%" }}>
      {children}
    </Stack>
  );
}

function ToolParts({
  parts,
  onOpenSession,
}: {
  parts: PartVM[];
  onOpenSession?: (id: string) => void;
}) {
  const tools = parts.filter((p): p is Extract<PartVM, { kind: "tool" }> => p.kind === "tool");
  if (tools.length === 0) return null;
  return (
    <Stack direction="row" sx={{ flexWrap: "wrap", gap: 0.75 }}>
      {tools.map((t) => {
        const sid = t.subagentSessionID;
        return sid && onOpenSession ? (
          <Chip
            key={t.id}
            component="button"
            type="button"
            size="small"
            variant="outlined"
            color="primary"
            onClick={() => onOpenSession(sid)}
            aria-label="Open subagent session"
            label={
              <>
                {`${t.name} ${toolChipIcon(t.status)}`}
                <ChevronRight sx={{ fontSize: 18, verticalAlign: "middle", mr: -0.5 }} />
              </>
            }
            sx={{ minHeight: 44, gap: 0.5, borderRadius: 0 }}
          />
        ) : (
          <Chip
            key={t.id}
            size="small"
            label={`${t.name} ${toolChipIcon(t.status)}`}
            sx={{ borderRadius: 0 }}
          />
        );
      })}
    </Stack>
  );
}

type ToolPartVM = Extract<PartVM, { kind: "tool" }>;
type ToolOnlyMessage = Extract<MessageVM, { kind: "assistant" }>;

function isToolOnlyAssistant(message: MessageVM): message is ToolOnlyMessage {
  return (
    message.kind === "assistant" &&
    message.parts.some((part) => part.kind === "tool") &&
    !message.parts.some((part) => part.kind === "text" && part.text.trim())
  );
}

function ActivitySummary({
  messages,
  agentNames,
  subagentAgentNames,
  onOpenSession,
}: {
  messages: ToolOnlyMessage[];
  agentNames: Record<string, string>;
  subagentAgentNames: Record<string, string>;
  onOpenSession?: (id: string) => void;
}) {
  const tools = messages.flatMap((message) =>
    message.parts.filter((part): part is ToolPartVM => part.kind === "tool"),
  );
  const counts = tools.reduce<Record<string, number>>((result, tool) => {
    const status = readableToolStatus(tool.status);
    result[status] = (result[status] ?? 0) + 1;
    return result;
  }, {});
  const statusSummary = Object.entries(counts)
    .map(([status, count]) => `${count} ${status.toLowerCase()}`)
    .join(" · ");

  return (
    <Box
      component="details"
      sx={{
        width: "100%",
        border: 1,
        borderColor: "divider",
        borderRadius: 0,
        overflow: "hidden",
        bgcolor: "background.paper",
      }}
    >
      <Box
        component="summary"
        sx={{
          minHeight: 48,
          px: 1.5,
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 1,
          cursor: "pointer",
          listStylePosition: "inside",
          "&:focus-visible": { outline: "2px solid", outlineColor: "primary.main" },
          "details[open] & .MuiSvgIcon-root": { transform: "rotate(180deg)" },
        }}
      >
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          Activity · {tools.length} {tools.length === 1 ? "task" : "tasks"}
        </Typography>
        <Typography variant="caption" color="text.secondary" sx={{ ml: "auto" }}>
          {statusSummary}
        </Typography>
        <ExpandMore sx={{ transition: (theme) => theme.transitions.create("transform") }} />
      </Box>
      <Divider />
      <Stack component="ul" spacing={0} sx={{ listStyle: "none", m: 0, p: 0.5 }}>
        {tools.map((tool) => {
          const taskName = tool.name || "Tool";
          const subagentAgentIdentity = tool.subagentAgentID
            ? agentNames[tool.subagentAgentID] || tool.subagentAgentID
            : tool.subagentSessionID
              ? subagentAgentNames[tool.subagentSessionID]
              : undefined;
          const isSubagent = tool.name === "subagent" || Boolean(tool.subagentSessionID);
          const subagentAgent = isSubagent
            ? subagentAgentIdentity || "subagent"
            : undefined;
          const taskLabel = (
            <Stack direction="row" sx={{ alignItems: "center", flex: 1, minWidth: 0, gap: 0.75 }}>
              <Typography variant="body2" sx={{ fontWeight: 500, flex: 1, minWidth: 0 }} noWrap>
                {taskName}
              </Typography>
              {subagentAgent && (
                <Chip
                  size="small"
                  variant="outlined"
                  label={subagentAgent}
                  title={subagentAgentIdentity ? `Subagent agent: ${subagentAgentIdentity}` : "Subagent identity unavailable"}
                  aria-label={subagentAgentIdentity ? `Subagent agent: ${subagentAgentIdentity}` : "Subagent identity unavailable"}
                  sx={{
                    height: 22,
                    maxWidth: 160,
                    flexShrink: 0,
                    borderRadius: 0,
                    "& .MuiChip-label": { overflow: "hidden", textOverflow: "ellipsis", px: 0.75 },
                  }}
                />
              )}
            </Stack>
          );
          const statusLabel = (
            <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
              {readableToolStatus(tool.status)}
            </Typography>
          );
          return (
            <Box
              component="li"
              key={tool.id}
              sx={{ px: 1, py: 0.25, minHeight: 44, display: "flex", flexDirection: "column", justifyContent: "center" }}
            >
              {tool.subagentSessionID && onOpenSession ? (
                <Button
                  variant="text"
                  color="inherit"
                  onClick={() => onOpenSession(tool.subagentSessionID!)}
                  aria-label={`Open ${taskName}${subagentAgentIdentity ? ` in ${subagentAgentIdentity}` : ""} subagent session`}
                  sx={{ minHeight: 44, justifyContent: "space-between", gap: 1, px: 0, textTransform: "none" }}
                >
                  {taskLabel}
                  {statusLabel}
                  <ChevronRight aria-hidden="true" sx={{ flexShrink: 0 }} />
                </Button>
              ) : (
                <Stack direction="row" sx={{ minHeight: 44, alignItems: "center", justifyContent: "space-between", gap: 1 }}>
                  {taskLabel}
                  {statusLabel}
                </Stack>
              )}
              {tool.status === "error" && tool.error && (
                <Typography variant="caption" color="error.main" sx={{ px: 1, pb: 0.5, overflowWrap: "anywhere" }}>
                  {tool.error}
                </Typography>
              )}
            </Box>
          );
        })}
      </Stack>
    </Box>
  );
}

type MessageRow =
  | { kind: "message"; key: string; message: MessageVM }
  | { kind: "activity"; key: string; messages: ToolOnlyMessage[] };

function groupToolOnlyMessages(messages: MessageVM[]): MessageRow[] {
  const rows: MessageRow[] = [];
  for (let index = 0; index < messages.length; ) {
    const message = messages[index];
    if (isToolOnlyAssistant(message)) {
      const group: ToolOnlyMessage[] = [];
      while (index < messages.length && isToolOnlyAssistant(messages[index])) {
        group.push(messages[index] as ToolOnlyMessage);
        index += 1;
      }
      rows.push({ kind: "activity", key: `activity-${group[0].id}`, messages: group });
    } else {
      rows.push({ kind: "message", key: message.id, message });
      index += 1;
    }
  }
  return rows;
}

function candidateIcon(kind: MentionCandidate["kind"]) {
  if (kind === "directory") return <FolderOpenOutlined fontSize="small" />;
  if (kind === "reference") return <LibraryBooksOutlined fontSize="small" />;
  return <InsertDriveFileOutlined fontSize="small" />;
}

interface ChatViewProps {
  sessionID: string;
  draft: ComposerDraft;
  onDraftChange: (sessionID: string, draft: ComposerDraftContent) => void;
  onClearDraft: (sessionID: string, revision: number) => void;
  title: string;
  messages: MessageVM[];
  agentNames: Record<string, string>;
  subagentAgentNames: Record<string, string>;
  toolRunningCount: number;
  sessionWorking: boolean;
  loading: boolean;
  hasOlderMessages: boolean;
  loadingOlderMessages: boolean;
  sending: boolean;
  agentId: string;
  agents: Array<{ id: string; name: string; description: string }>;
  agentBusy: boolean;
  model?: ModelRef;
  models: Array<{ model: ModelRef; label: string }>;
  modelBusy: boolean;
  onSwitchAgent: (agentID: string) => void;
  onSwitchModel: (model: ModelRef) => void;
  onSend: (sessionID: string, text: string, attachments: PromptMentionAttachment[]) => Promise<boolean>;
  onLoadOlder: () => Promise<boolean>;
  onBack?: () => void;
  onRefresh: () => void;
  onOpenSession?: (id: string) => void;
  /**
   * In-flow notification stack rendered just above the composer so notices
   * never obscure it and move with keyboard/composer height changes.
   */
  notificationArea?: ReactNode;
  /**
   * Number of notifications currently shown. Changes when the stack's height
   * may change, driving bottom re-pinning of the scroll area.
   */
  notificationCount?: number;
}

export default function ChatView({
  sessionID,
  draft,
  onDraftChange,
  onClearDraft,
  title,
  messages,
  agentNames,
  subagentAgentNames,
  toolRunningCount,
  sessionWorking,
  loading,
  hasOlderMessages,
  loadingOlderMessages,
  sending,
  agentId,
  agents,
  agentBusy,
  model,
  models,
  modelBusy,
  onSwitchAgent,
  onSwitchModel,
  onSend,
  onLoadOlder,
  onBack,
  onRefresh,
  onOpenSession,
  notificationArea,
  notificationCount,
}: ChatViewProps) {
  const draftRef = useRef({ sessionID, draft });
  useLayoutEffect(() => {
    if (draftRef.current.sessionID !== sessionID || draft.revision >= draftRef.current.draft.revision) {
      draftRef.current = { sessionID, draft };
    }
  }, [sessionID, draft]);
  const text = draft.text;
  const mentions = draft.mentions;
  const [activeMention, setActiveMention] = useState<ActiveMentionQuery | null>(null);
  const [candidates, setCandidates] = useState<MentionCandidate[]>([]);
  const [mentionState, setMentionState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [activeCandidate, setActiveCandidate] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [draftError, setDraftError] = useState<{ sessionID: string; message: string } | null>(null);
  const dismissedMentionRef = useRef<{ sessionID: string; start: number; query: string } | null>(null);
  // Live mirror of the active mention, updated synchronously in the same event
  // that queues the state change. Passive-effect cleanup runs only after
  // commit, so in-flight search results are validated against this ref — not
  // the abort signal alone — before they may touch composer state.
  const activeMentionRef = useRef<ActiveMentionQuery | null>(null);
  const setActiveMentionSync = (next: ActiveMentionQuery | null) => {
    activeMentionRef.current = next;
    setActiveMention(next);
  };
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const activeOptionRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);
  const scrollAnchorRef = useRef<{
    height: number;
    top: number;
    messageCount: number;
  } | null>(null);
  useEffect(() => {
    if (!activeMention) return;
    const request: MentionSearchRequest = { sessionID, ...activeMention };
    return scheduleMentionSearch(
      {
        currentRequest: () => {
          const live = activeMentionRef.current;
          return live ? { sessionID, ...live } : null;
        },
        fetchMentionCandidates: (url, signal) =>
          fetch(url, { signal, credentials: "same-origin" }).then(async (response) => {
            if (!response.ok) throw new Error("Search failed");
            return (await response.json()) as { candidates?: unknown };
          }),
        applyResults: (rows) => {
          setCandidates(rows);
          setMentionState("ready");
          setActiveCandidate(0);
        },
        applyError: () => {
          setCandidates([]);
          setMentionState("error");
        },
      },
      request,
    );
  }, [activeMention, sessionID]);

  useEffect(() => {
    activeOptionRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeCandidate, candidates]);

  const currentDraft = () =>
    draftRef.current.sessionID === sessionID ? draftRef.current.draft : draft;

  const commitDraft = (content: ComposerDraftContent) => {
    const next: ComposerDraft = { ...content, revision: currentDraft().revision + 1 };
    draftRef.current = { sessionID, draft: next };
    onDraftChange(sessionID, content);
    setDraftError(null);
    return next;
  };

  const updateActiveMention = (next: ActiveMentionQuery | null) => {
    const dismissed = dismissedMentionRef.current;
    if (dismissed?.sessionID === sessionID) {
      if (isSameDismissedMention(dismissed, sessionID, next)) {
        setActiveMentionSync(null);
        setCandidates([]);
        setMentionState("idle");
        return;
      }
      dismissedMentionRef.current = null;
    }

    // Compare against the synchronous ref so an update is never deduped away
    // while uncommitted state still lags behind the live caret/query.
    const live = activeMentionRef.current;
    if (
      live?.query === next?.query &&
      live?.start === next?.start &&
      live?.end === next?.end
    ) return;
    setCandidates([]);
    setMentionState(next ? "loading" : "idle");
    setActiveCandidate(0);
    setActiveMentionSync(next);
  };

  const updateMentionAtCaret = (caret: number) => {
    const current = currentDraft();
    updateActiveMention(findActiveMentionQuery(current.text, caret, current.mentions));
  };

  // When a session (re)opens, loading flips to true — treat it as a fresh
  // open and stick to the bottom rather than preserving an old scroll anchor.
  useEffect(() => {
    if (loading) {
      nearBottomRef.current = true;
      scrollAnchorRef.current = null;
    }
  }, [loading]);

  // Preserve the current viewport when an older page is prepended. Otherwise,
  // autoscroll only when the user is already within 80px of the bottom.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const anchor = scrollAnchorRef.current;
    if (anchor && messages.length > anchor.messageCount) {
      el.scrollTop = anchor.top + (el.scrollHeight - anchor.height);
      scrollAnchorRef.current = null;
      nearBottomRef.current =
        el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      return;
    }
    if (anchor && !loadingOlderMessages) scrollAnchorRef.current = null;
    if (!loadingOlderMessages && nearBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, toolRunningCount, loadingOlderMessages]);

  // The in-flow notification stack takes layout space above the composer, so
  // when it appears, disappears, or changes size it shrinks/grows the scroll
  // area and can push the newest message out of view. Keep a bottom-pinned
  // user pinned; never force scroll when they intentionally scrolled away.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || notificationCount === undefined || !nearBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [notificationCount]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const handleTextChange = (value: string, caret: number) => {
    const current = currentDraft();
    const adjusted = trackMentionEdits(current.text, value, current.mentions);
    commitDraft({ text: value, mentions: adjusted });
    updateActiveMention(findActiveMentionQuery(value, caret, adjusted));
  };

  const selectCandidate = (candidate: MentionCandidate) => {
    // Selection must belong to the request that is still live: a stale search
    // response can never make its candidates selectable.
    const live = activeMentionRef.current;
    if (!activeMention || !live) return;
    if (!sameMentionRequest({ sessionID, ...live }, { sessionID, ...activeMention })) return;
    const current = currentDraft();
    const mentionText = `@${candidate.label}`;
    const nextText = `${current.text.slice(0, activeMention.start)}${mentionText}${current.text.slice(activeMention.end)}`;
    const adjusted = trackMentionEdits(current.text, nextText, current.mentions);
    const descriptor: MentionDescriptor = candidate.kind === "reference"
      ? { kind: "reference", alias: candidate.alias ?? candidate.name }
      : { kind: candidate.kind, path: candidate.path ?? candidate.label };
    const start = activeMention.start;
    const nextMention: ComposerDraftMention = {
      id: crypto.randomUUID(),
      descriptor,
      kind: candidate.kind,
      label: candidate.label,
      mention: { start, end: start + mentionText.length, text: mentionText },
    };
    const nextMentions = [...adjusted, nextMention].sort((a, b) => a.mention.start - b.mention.start);
    commitDraft({ text: nextText, mentions: nextMentions });
    updateActiveMention(null);
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      const caret = start + mentionText.length;
      textarea.focus();
      textarea.setSelectionRange(caret, caret);
    });
  };

  const removeMention = (id: string) => {
    const current = currentDraft();
    const removed = removeComposerMention(
      current.text,
      current.mentions,
      id,
      textareaRef.current?.selectionStart ?? current.text.length,
    );
    if (!removed) return;
    commitDraft({ text: removed.text, mentions: removed.mentions });
    updateActiveMention(findActiveMentionQuery(removed.text, removed.caret, removed.mentions));
    requestAnimationFrame(() => {
      const input = textareaRef.current;
      if (!input) return;
      input.focus();
      input.setSelectionRange(removed.caret, removed.caret);
    });
  };

  const handleSend = async () => {
    const current = currentDraft();
    const prepared = prepareComposerDraftSubmission(current.text, current.mentions);
    if (!prepared.text || sending) return;
    if (!prepared.valid) {
      setDraftError({
        sessionID,
        message: "A selected attachment no longer matches the draft text. Remove it and select it again before sending.",
      });
      return;
    }
    // The user just sent a message — force scroll to the bottom (past the
    // optimistic bubble and any subsequent streaming) regardless of the
    // prior scroll position.
    nearBottomRef.current = true;
    const payload = prepared.mentions.map(({ descriptor, mention }) => ({ descriptor, mention }));
    const ok = await onSend(sessionID, prepared.text, payload);
    if (ok) onClearDraft(sessionID, current.revision);
  };

  const handleLoadOlder = async () => {
    const el = scrollRef.current;
    if (!el || loadingOlderMessages) return;
    scrollAnchorRef.current = {
      height: el.scrollHeight,
      top: el.scrollTop,
      messageCount: messages.length,
    };
    const loaded = await onLoadOlder();
    if (!loaded) scrollAnchorRef.current = null;
  };

  const rows = groupToolOnlyMessages(messages);
  const modelValue = (value: ModelRef) =>
    JSON.stringify([value.providerID, value.id, value.variant ?? ""]);
  const selectedModel = model ? modelValue(model) : "";
  const selectModel = (value: string) => {
    try {
      const [providerID, id, variant] = JSON.parse(value) as [string, string, string];
      const option = models.find(
        (item) =>
          item.model.providerID === providerID &&
          item.model.id === id &&
          (item.model.variant ?? "") === variant,
      );
      if (option) onSwitchModel(option.model);
    } catch {
      // Ignore malformed Select values.
    }
  };

  // Enter never sends and never selects: it always falls through to the
  // textarea's native newline insertion (preserving IME composition and
  // native undo), even while attachment candidates are loading or visible.
  // The visible Send button is the only way to submit; candidates are chosen
  // by tap or Tab. resolveComposerKeyAction only claims keys that drive the
  // attachment menu.
  const handleKeyDown = (e: React.KeyboardEvent) => {
    const action = resolveComposerKeyAction({
      key: e.key,
      isComposing: e.nativeEvent.isComposing,
      hasActiveMention: Boolean(activeMention),
      candidateCount: candidates.length,
      shiftKey: e.shiftKey,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      altKey: e.altKey,
    });
    if (action.type === "default") return;
    e.preventDefault();
    if (action.type === "move-candidate") {
      setActiveCandidate((index) => (index + action.delta + candidates.length) % candidates.length);
      return;
    }
    if (action.type === "select-candidate") {
      if (candidates[activeCandidate]) selectCandidate(candidates[activeCandidate]);
      return;
    }
    if (activeMention) {
      dismissedMentionRef.current = {
        sessionID,
        start: activeMention.start,
        query: activeMention.query,
      };
      setActiveMentionSync(null);
      setCandidates([]);
      setMentionState("idle");
      setActiveCandidate(0);
    }
  };

  return (
    <Box
      sx={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        overflow: "hidden",
      }}
    >
      <AppBar
        position="static"
        color="default"
        elevation={0}
        sx={{
          borderBottom: 1,
          borderColor: "divider",
          // Positioning context + clipping for the decorative braille
          // shading; the toolbar below paints above it.
          position: "relative",
          overflow: "hidden",
        }}
      >
        <BrailleShading />
        <Toolbar sx={{ position: "relative" }}>
          {onBack && (
            <IconButton
              aria-label="Back to sessions"
              size="large"
              edge="start"
              sx={{
                minWidth: 48,
                minHeight: 48,
              }}
              onClick={onBack}
            >
              <ArrowBack />
            </IconButton>
          )}
          <Typography variant="h6" component="h1" noWrap sx={{ flexGrow: 1 }}>
            {title}
          </Typography>
          <Box sx={{ display: { xs: "none", md: "block" }, flexShrink: 0, width: 160, mx: 0.5 }}>
            <FormControl fullWidth size="small" disabled={agentBusy || modelBusy || agents.length === 0}>
              <Select
                value={agentId || ""}
                onChange={(event) => onSwitchAgent(event.target.value)}
                displayEmpty
                inputProps={{ "aria-label": "Select agent" }}
                sx={{
                  "& .MuiSelect-select": {
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  },
                }}
              >
                {!agentId && (
                  <MenuItem value="" disabled>
                    {agentBusy ? "Loading agent…" : "Select agent"}
                  </MenuItem>
                )}
                {!agents.some((agent) => agent.id === agentId) && agentId && (
                  <MenuItem value={agentId} disabled>
                    Unavailable: {agentId}
                  </MenuItem>
                )}
                {agents.map((agent) => (
                  <MenuItem key={agent.id} value={agent.id} title={agent.description}>
                    {agent.name || agent.id}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Box>
          <Box sx={{ display: { xs: "none", md: "block" }, flexShrink: 0, width: 220, mx: 0.5 }}>
            <FormControl fullWidth size="small" disabled={agentBusy || modelBusy || models.length === 0}>
              <Select
                value={selectedModel}
                onChange={(event) => selectModel(event.target.value)}
                displayEmpty
                inputProps={{ "aria-label": "Select model" }}
                sx={{
                  "& .MuiSelect-select": {
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  },
                }}
              >
                {!model && (
                  <MenuItem value="" disabled>
                    {modelBusy ? "Loading model…" : "Select model"}
                  </MenuItem>
                )}
                {model && !models.some((option) => modelValue(option.model) === selectedModel) && (
                  <MenuItem value={selectedModel} disabled>
                    Unavailable: {model.providerID}/{model.id}
                  </MenuItem>
                )}
                {models.map((option) => (
                  <MenuItem key={modelValue(option.model)} value={modelValue(option.model)} title={option.label}>
                    {option.label}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Box>
          <Box sx={{ display: { xs: "none", md: "flex" }, alignItems: "center" }}>
            <ThemeSelector />
            <IconButton
              aria-label="Refresh messages"
              size="large"
              sx={{ minWidth: 48, minHeight: 48 }}
              onClick={onRefresh}
            >
              <Refresh />
            </IconButton>
          </Box>
          <IconButton
            aria-label="Open chat menu"
            size="large"
            sx={{ display: { xs: "inline-flex", md: "none" }, minWidth: 48, minHeight: 48 }}
            onClick={() => setMenuOpen(true)}
          >
            <MenuIcon />
          </IconButton>
        </Toolbar>
      </AppBar>

      <Drawer
        anchor="right"
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        sx={{
          // The drawer is portaled outside the app shell, so it needs its own
          // safe-area padding for the chat page's viewportFit: "cover"
          // (app/page.tsx). Each inset is a no-op wherever it resolves to 0.
          "& .MuiDrawer-paper": {
            width: 288,
            maxWidth: "85vw",
            paddingTop: "env(safe-area-inset-top, 0px)",
            paddingBottom: "env(safe-area-inset-bottom, 0px)",
            paddingLeft: "env(safe-area-inset-left, 0px)",
            paddingRight: "env(safe-area-inset-right, 0px)",
          },
        }}
      >
        <Stack direction="row" sx={{ alignItems: "center", justifyContent: "space-between", p: 1.5 }}>
          <Typography variant="h6" component="h2">
            Chat menu
          </Typography>
          <IconButton aria-label="Close chat menu" onClick={() => setMenuOpen(false)}>
            <Close />
          </IconButton>
        </Stack>
        <Divider />
        <Box sx={{ px: 1.5, py: 1.5 }}>
          <Typography variant="subtitle2" sx={{ mb: 1 }}>
            Agent
          </Typography>
          <FormControl fullWidth size="small" disabled={agentBusy || modelBusy || agents.length === 0}>
            <Select
              value={agentId || ""}
              onChange={(event) => onSwitchAgent(event.target.value)}
              displayEmpty
              inputProps={{ "aria-label": "Select agent" }}
            >
              {!agentId && (
                <MenuItem value="" disabled>
                  {agentBusy ? "Loading agent…" : "Select agent"}
                </MenuItem>
              )}
              {!agents.some((agent) => agent.id === agentId) && agentId && (
                <MenuItem value={agentId} disabled>
                  Unavailable: {agentId}
                </MenuItem>
              )}
              {agents.map((agent) => (
                <MenuItem key={agent.id} value={agent.id} title={agent.description}>
                  {agent.name || agent.id}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <Typography variant="subtitle2" sx={{ mt: 2, mb: 1 }}>
            Model
          </Typography>
          <FormControl fullWidth size="small" disabled={agentBusy || modelBusy || models.length === 0}>
            <Select
              value={selectedModel}
              onChange={(event) => selectModel(event.target.value)}
              displayEmpty
              inputProps={{ "aria-label": "Select model" }}
            >
              {!model && (
                <MenuItem value="" disabled>
                  {models.length === 0 ? "No models available" : "Select model"}
                </MenuItem>
              )}
              {model && !models.some((option) => modelValue(option.model) === selectedModel) && (
                <MenuItem value={selectedModel} disabled>
                  Unavailable: {model.providerID}/{model.id}
                </MenuItem>
              )}
              {models.map((option) => (
                <MenuItem key={modelValue(option.model)} value={modelValue(option.model)} title={option.label}>
                  {option.label}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          {(agentBusy || modelBusy) && (
            <Stack direction="row" spacing={1} role="status" aria-live="polite" sx={{ alignItems: "center", mt: 1 }}>
              <CircularProgress size={16} />
              <Typography variant="caption" color="text.secondary">
                {agentBusy ? "Switching agent…" : "Switching model…"}
              </Typography>
            </Stack>
          )}
        </Box>
        <Divider />
        <List>
          <ListItemButton
            onClick={() => {
              setMenuOpen(false);
              onRefresh();
            }}
            sx={{ minHeight: 56 }}
          >
            <ListItemIcon>
              <Refresh />
            </ListItemIcon>
            <ListItemText primary="Refresh messages" />
          </ListItemButton>
          <Divider component="li" />
          <ListItemButton component="div" sx={{ minHeight: 64, cursor: "default" }}>
            <ListItemText primary="Theme" secondary="Current light, Current dark, Sunfade light, Sunfade dark" />
            <ThemeSelector />
          </ListItemButton>
        </List>
      </Drawer>

      {loading && <LinearProgress />}

      <Box
        ref={scrollRef}
        onScroll={handleScroll}
        sx={{
          flex: 1,
          overflowY: "auto",
          overflowX: "hidden",
          scrollbarWidth: "thin",
          // Small screen-edge padding; agent responses run the full width.
          px: 1,
          py: 1,
          display: "flex",
          flexDirection: "column",
          gap: 1.25,
        }}
      >
        <Box sx={{ width: "100%", display: "flex", flexDirection: "column", gap: 1.25 }}>
          {hasOlderMessages && (
            <Button
              size="small"
              disabled={loadingOlderMessages}
              onClick={() => void handleLoadOlder()}
              sx={{ alignSelf: "center", minHeight: 40 }}
            >
              {loadingOlderMessages ? (
                <CircularProgress size={18} sx={{ mr: 1 }} />
              ) : null}
              Load older messages
            </Button>
          )}
          {rows.map((row) =>
            row.kind === "activity" ? (
              <ActivitySummary
                key={row.key}
                messages={row.messages}
                agentNames={agentNames}
                subagentAgentNames={subagentAgentNames}
                onOpenSession={onOpenSession}
              />
            ) : row.message.kind === "agent" ? (
              <Typography
                key={`agent-${row.message.id}`}
                variant="caption"
                color="text.secondary"
                sx={{ alignSelf: "center", py: 0.5 }}
              >
                Agent switched{row.message.previous ? ` from ${agentNames[row.message.previous] || row.message.previous}` : ""} to {agentNames[row.message.agent] || row.message.agent}
              </Typography>
            ) : row.message.kind === "user" ? (
              <Stack key={row.message.id} spacing={0.25} sx={{ alignItems: "flex-end" }}>
                <Paper
                  sx={{
                    // 85% of the column on phones; the absolute cap keeps the
                    // bubble reasonable once the column runs full width.
                    maxWidth: "min(85%, 720px)",
                    bgcolor: "primary.main",
                    color: "primary.contrastText",
                    px: 1.25,
                    py: 1,
                    borderRadius: 0,
                  }}
                >
                  <Typography variant="body1" sx={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                    {row.message.text}
                  </Typography>
                </Paper>
                {row.message.time !== undefined && (
                  <Typography variant="caption" sx={{ color: "text.secondary", fontSize: 11 }}>
                    {formatTime(row.message.time)}
                  </Typography>
                )}
              </Stack>
            ) : (
              <Stack key={row.message.id} spacing={0.5} sx={{ width: "100%" }}>
                <AssistantHeader
                  time={row.message.time}
                  agent={row.message.agent ? agentNames[row.message.agent] || row.message.agent : undefined}
                />
                <AssistantBubble>
                  {/* Each text part is one Markdown document (MarkdownText);
                   * the caret rides on the last text part while streaming —
                   * MarkdownText appends the caret character to the source so
                   * it sits at the typing position, including inside an
                   * unfinished fenced code block, which CommonMark still
                   * parses as a code block. */}
                  {row.message.parts
                    .filter((p): p is Extract<PartVM, { kind: "text" }> => p.kind === "text")
                    .map((p, i, textParts) => (
                      <MarkdownText
                        key={i}
                        text={p.text}
                        caret={row.message.kind === "assistant" && row.message.streaming && i === textParts.length - 1}
                      />
                    ))}
                  {row.message.streaming && !row.message.parts.some((p) => p.kind === "text") && (
                    <Typography variant="body1" color="text.secondary">
                      ···
                    </Typography>
                  )}
                  <ToolParts parts={row.message.parts} onOpenSession={onOpenSession} />
                </AssistantBubble>
              </Stack>
            ),
          )}

        </Box>
      </Box>

      {notificationArea && (
        <Box sx={{ flexShrink: 0, px: 1.5 }}>{notificationArea}</Box>
      )}

      <Paper
        square
        elevation={0}
        sx={{
          borderTop: 1,
          borderColor: "divider",
          p: 0.75,
          // Keeps the input clear of the iPhone home indicator and rounded
          // display corners under this page's viewportFit: "cover"
          // (app/page.tsx). The env() is a no-op wherever it resolves to 0;
          // actual inset values are device- and context-dependent and not
          // verified here — check on a real device.
          pb: "calc(8px + env(safe-area-inset-bottom, 0px))",
          display: "flex",
          alignItems: "flex-end",
          gap: 1,
          position: "relative",
        }}
      >
        {sessionWorking && (
          <LinearProgress
            variant="indeterminate"
            aria-label="Assistant is working"
            sx={{
              position: "absolute",
              top: -2,
              left: 0,
              right: 0,
              height: 2,
            }}
          />
        )}
        {activeMention && (
          <Paper
            variant="outlined"
            sx={{
              position: "absolute",
              zIndex: 3,
              left: 8,
              right: 8,
              bottom: "calc(100% + 8px)",
              width: "min(760px, calc(100vw - 32px))",
              maxHeight: 320,
              overflowY: "auto",
              mx: "auto",
              boxShadow: 4,
            }}
          >
            <Typography variant="caption" color="text.secondary" sx={{ display: "block", px: 1.5, pt: 1 }}>
              Visible references
            </Typography>
            {mentionState === "loading" && (
              <Stack role="status" aria-live="polite" direction="row" spacing={1} sx={{ alignItems: "center", p: 1.5 }}>
                <CircularProgress size={16} />
                <Typography variant="body2">Searching this session’s references…</Typography>
              </Stack>
            )}
            {mentionState === "error" && (
              <Typography role="alert" color="error.main" variant="body2" sx={{ p: 1.5 }}>
                Could not search references. Keep typing to retry.
              </Typography>
            )}
            {mentionState === "ready" && candidates.length === 0 && (
              <Typography role="status" aria-live="polite" color="text.secondary" variant="body2" sx={{ p: 1.5 }}>
                No matching references.
              </Typography>
            )}
            {candidates.length > 0 && (
              <List component="div" id="mention-options" role="listbox" aria-label="Reference suggestions" dense sx={{ py: 0.5 }}>
                {candidates.map((candidate, index) => (
                  <ListItemButton
                    id={`mention-option-${index}`}
                    key={`${candidate.kind}:${candidate.kind === "reference" ? candidate.alias : candidate.path}:${index}`}
                    component="div"
                    role="option"
                    tabIndex={-1}
                    ref={index === activeCandidate ? activeOptionRef : undefined}
                    aria-selected={index === activeCandidate}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => selectCandidate(candidate)}
                    sx={{ minHeight: 48, gap: 1, px: 1.5, bgcolor: index === activeCandidate ? "action.selected" : undefined }}
                  >
                    {candidateIcon(candidate.kind)}
                    <Box sx={{ minWidth: 0, flex: 1 }}>
                      <Typography variant="body2" noWrap>{candidate.label}</Typography>
                    </Box>
                    <Chip size="small" variant="outlined" label={candidate.kind} />
                  </ListItemButton>
                ))}
              </List>
            )}
          </Paper>
        )}
        <Box sx={{ flex: 1, minWidth: 0 }}>
          {mentions.length > 0 && (
            <Stack direction="row" role="group" aria-label="Selected attachments" sx={{ flexWrap: "wrap", gap: 0.5, mb: 0.75 }}>
              {mentions.map((mention) => (
                <Chip
                  key={mention.id}
                  size="small"
                  variant="outlined"
                  icon={candidateIcon(mention.kind)}
                  label={`${mention.kind}: @${mention.label}`}
                  title={`Attached ${mention.kind}: ${mention.label}`}
                  onDelete={() => removeMention(mention.id)}
                  sx={{ maxWidth: "100%", minHeight: 32, "& .MuiChip-label": { overflow: "hidden", textOverflow: "ellipsis" } }}
                />
              ))}
            </Stack>
          )}
          {draftError?.sessionID === sessionID && (
            <Typography role="alert" color="error.main" variant="body2" sx={{ mb: 0.75 }}>
              {draftError.message}
            </Typography>
          )}
          <TextField
            inputRef={textareaRef}
            multiline
            maxRows={4}
            fullWidth
            placeholder="Message… (type @ to attach a reference)"
            value={text}
            onChange={(e) => handleTextChange(e.target.value, e.target.selectionStart ?? e.target.value.length)}
            disabled={sending}
            slotProps={{
              htmlInput: {
                role: "combobox",
                "aria-label": "Message",
                "aria-autocomplete": "list",
                "aria-haspopup": "listbox",
                "aria-multiline": "true",
                "aria-expanded": Boolean(activeMention && candidates.length > 0),
                "aria-controls": activeMention && candidates.length > 0 ? "mention-options" : undefined,
                "aria-activedescendant": activeMention && candidates.length > 0 ? `mention-option-${activeCandidate}` : undefined,
                onKeyDown: handleKeyDown,
                onKeyUp: (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
                  if (!e.nativeEvent.isComposing) updateMentionAtCaret(e.currentTarget.selectionStart);
                },
                onClick: (e: React.MouseEvent<HTMLTextAreaElement>) => updateMentionAtCaret(e.currentTarget.selectionStart),
                onSelect: (e: React.SyntheticEvent<HTMLTextAreaElement>) => updateMentionAtCaret(e.currentTarget.selectionStart),
              },
            }}
            sx={{
              "& .MuiOutlinedInput-root": { minHeight: 48 },
            }}
          />
        </Box>
        <IconButton
          aria-label="Send"
          size="large"
          disabled={!text.trim() || sending}
          onClick={() => void handleSend()}
          sx={{
            minWidth: 48,
            minHeight: 48,
            "& svg": { color: "primary.main" },
            "&.Mui-disabled": {
              bgcolor: "action.selected",
              border: "1px solid",
              borderColor: "divider",
              "& svg": { color: "text.disabled" },
            },
          }}
        >
          {sending ? <CircularProgress size={20} /> : <Send />}
        </IconButton>
      </Paper>
    </Box>
  );
}
