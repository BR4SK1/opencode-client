"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import ArrowBack from "@mui/icons-material/ArrowBack";
import ChevronRight from "@mui/icons-material/ChevronRight";
import Close from "@mui/icons-material/Close";
import MenuIcon from "@mui/icons-material/Menu";
import Refresh from "@mui/icons-material/Refresh";
import Send from "@mui/icons-material/Send";
import SmartToy from "@mui/icons-material/SmartToy";
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
import { ThemeToggle } from "./ThemeToggle";
import { CodeBlock, InlineCode, parseSegments } from "./CodeBlock";

function toolChipIcon(status: string): string {
  if (status === "completed") return "✓";
  if (status === "error") return "✕";
  return "•";
}

/** HH:MM in the user's locale; tolerates second- and millisecond-epochs. */
function formatTime(time: number): string {
  const ms = time < 1e12 ? time * 1000 : time;
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Renders plain text with **bold** and `inline code` runs. Bold wrapping is
 * applied first, then inline-code splitting runs within each bold/plain piece,
 * so `code` inside bold still works. Single `*` is left as literal text. */
function renderInline(text: string, extra?: React.ReactNode): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const boldParts = text.split(/(\*\*[^*\n]+\*\*)/g);
  boldParts.forEach((part, bi) => {
    const bold = bi % 2 === 1 && /^\*\*[^*\n]+\*\*$/.test(part);
    const inner = bold ? part.slice(2, -2) : part;
    const codeParts = inner.split(/`([^`\n]+)`/g);
    const runs: React.ReactNode[] = codeParts.map((piece, i) =>
      i % 2 === 1 ? <InlineCode key={`ic-${bi}-${i}`}>{piece}</InlineCode> : piece,
    );
    if (bold) {
      nodes.push(
        <Box key={`b-${bi}`} component="strong" sx={{ fontWeight: 700 }}>
          {runs}
        </Box>,
      );
    } else {
      nodes.push(...runs);
    }
  });
  if (extra !== undefined) nodes.push(extra);
  return nodes;
}

function SegmentedText({
  text,
  caret,
}: {
  text: string;
  caret?: boolean;
}) {
  const segments = parseSegments(text);
  if (segments.length === 0) return null;

  const lastTextIndex = segments.reduce(
    (acc, s, i) => (s.kind === "text" ? i : acc),
    -1,
  );
  // Keyed because the caret is appended into the renderInline node array passed
  // to Typography, which requires keys for array children.
  const caretNode = caret ? (
    <Box
      key="oc-caret"
      component="span"
      sx={{ color: "primary.main", animation: "oc-caret-blink 1s steps(1) infinite" }}
    >
      ▍
    </Box>
  ) : undefined;

  return (
    <>
      {segments.map((s, i) => {
        if (s.kind === "code") {
          return <CodeBlock key={i} code={s.code} lang={s.lang} />;
        }
        return (
          <Typography
            key={i}
            variant="body1"
            sx={{
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
              lineHeight: 1.6,
            }}
          >
            {renderInline(s.text, i === lastTextIndex ? caretNode : undefined)}
          </Typography>
        );
      })}
      {caret && lastTextIndex === -1 && caretNode}
    </>
  );
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
  return (
    <Paper
      variant="outlined"
      sx={{
        width: "100%",
        px: 1.75,
        py: 1.25,
        borderRadius: 2.5,
        borderBottomLeftRadius: 0.75,
      }}
    >
      <Stack spacing={1}>{children}</Stack>
    </Paper>
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
            sx={{ minHeight: 44, gap: 0.5 }}
          />
        ) : (
          <Chip
            key={t.id}
            size="small"
            label={`${t.name} ${toolChipIcon(t.status)}`}
          />
        );
      })}
    </Stack>
  );
}

interface ChatViewProps {
  title: string;
  messages: MessageVM[];
  agentNames: Record<string, string>;
  toolRunningCount: number;
  loading: boolean;
  hasOlderMessages: boolean;
  loadingOlderMessages: boolean;
  sending: boolean;
  agentId: string;
  agents: Array<{ id: string; name: string; description: string }>;
  agentBusy: boolean;
  onSwitchAgent: (agentID: string) => void;
  onSend: (text: string) => Promise<boolean>;
  onLoadOlder: () => Promise<boolean>;
  onBack?: () => void;
  onRefresh: () => void;
  onOpenSession?: (id: string) => void;
}

export default function ChatView({
  title,
  messages,
  agentNames,
  toolRunningCount,
  loading,
  hasOlderMessages,
  loadingOlderMessages,
  sending,
  agentId,
  agents,
  agentBusy,
  onSwitchAgent,
  onSend,
  onLoadOlder,
  onBack,
  onRefresh,
  onOpenSession,
}: ChatViewProps) {
  const [text, setText] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);
  const scrollAnchorRef = useRef<{
    height: number;
    top: number;
    messageCount: number;
  } | null>(null);

  // When a session (re)opens, loading flips to true — treat it as a fresh
  // open and stick to the bottom, even if ChatView stayed mounted across a
  // session switch and the user had scrolled up in the previous session.
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

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const handleSend = async () => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    // The user just sent a message — force scroll to the bottom (past the
    // optimistic bubble and any subsequent streaming) regardless of the
    // prior scroll position.
    nearBottomRef.current = true;
    const ok = await onSend(trimmed);
    if (ok) setText("");
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

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void handleSend();
    }
  };

  return (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <AppBar position="static" color="default" elevation={0} sx={{ borderBottom: 1, borderColor: "divider" }}>
        <Toolbar>
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
          <Box sx={{ flexShrink: 0, width: { xs: 116, sm: 148, md: 180 }, mx: { xs: 0.5, sm: 1 } }}>
            <FormControl fullWidth size="small" disabled={agentBusy || agents.length === 0}>
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
          <Box sx={{ display: { xs: "none", md: "flex" }, alignItems: "center" }}>
            <ThemeToggle />
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
        sx={{ "& .MuiDrawer-paper": { width: 288, maxWidth: "85vw" } }}
      >
        <Stack direction="row" sx={{ alignItems: "center", justifyContent: "space-between", p: 2 }}>
          <Typography variant="h6" component="h2">
            Chat menu
          </Typography>
          <IconButton aria-label="Close chat menu" onClick={() => setMenuOpen(false)}>
            <Close />
          </IconButton>
        </Stack>
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
            <ListItemText primary="Theme" secondary="Cycle system, light, and dark" />
            <ThemeToggle />
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
          px: 2,
          py: 2,
          display: "flex",
          flexDirection: "column",
          gap: 1.5,
        }}
      >
        <Box sx={{ width: "100%", maxWidth: 760, mx: "auto", display: "flex", flexDirection: "column", gap: 1.5 }}>
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
          {messages.map((m) =>
            m.kind === "agent" ? (
              <Typography
                key={`agent-${m.id}`}
                variant="caption"
                color="text.secondary"
                sx={{ alignSelf: "center", py: 0.5 }}
              >
                Agent switched{m.previous ? ` from ${agentNames[m.previous] || m.previous}` : ""} to {agentNames[m.agent] || m.agent}
              </Typography>
            ) : m.kind === "user" ? (
              <Stack key={m.id} spacing={0.25} sx={{ alignItems: "flex-end" }}>
                <Paper
                  sx={{
                    maxWidth: "85%",
                    bgcolor: "primary.main",
                    color: "primary.contrastText",
                    px: 1.75,
                    py: 1.25,
                    borderRadius: 2.5,
                    borderBottomRightRadius: 0.75,
                  }}
                >
                  <Typography variant="body1" sx={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                    {m.text}
                  </Typography>
                </Paper>
                {m.time !== undefined && (
                  <Typography variant="caption" sx={{ color: "text.secondary", fontSize: 11 }}>
                    {formatTime(m.time)}
                  </Typography>
                )}
              </Stack>
            ) : (
              <Stack key={m.id} spacing={0.5} sx={{ alignItems: "flex-start", maxWidth: "85%" }}>
                <AssistantHeader
                  time={m.time}
                  agent={m.agent ? agentNames[m.agent] || m.agent : undefined}
                />
                <AssistantBubble>
                  {m.parts
                    .filter((p): p is Extract<PartVM, { kind: "text" }> => p.kind === "text")
                    .map((p, i, textParts) => (
                      <SegmentedText
                        key={i}
                        text={p.text}
                        caret={m.streaming && i === textParts.length - 1}
                      />
                    ))}
                  {m.streaming && !m.parts.some((p) => p.kind === "text") && (
                    <Typography variant="body1" color="text.secondary">
                      ···
                    </Typography>
                  )}
                  <ToolParts parts={m.parts} onOpenSession={onOpenSession} />
                </AssistantBubble>
              </Stack>
            ),
          )}

          {toolRunningCount > 0 && (
            <Stack
              direction="row"
              spacing={1}
              sx={{ alignItems: "center" }}
            >
              <LinearProgress sx={{ width: 160 }} />
              <Typography variant="caption" color="text.secondary" noWrap>
                Tool running…
              </Typography>
            </Stack>
          )}

        </Box>
      </Box>

      <Paper
        square
        elevation={0}
        sx={{
          borderTop: 1,
          borderColor: "divider",
          p: 1,
          display: "flex",
          alignItems: "flex-end",
          gap: 1,
        }}
      >
        <TextField
          multiline
          maxRows={4}
          fullWidth
          placeholder="Message…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={sending}
          sx={{
            "& .MuiOutlinedInput-root": { minHeight: 48 },
          }}
        />
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
