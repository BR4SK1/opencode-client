"use client";

import { useEffect, useRef, useState } from "react";
import ArrowBack from "@mui/icons-material/ArrowBack";
import ChevronRight from "@mui/icons-material/ChevronRight";
import Refresh from "@mui/icons-material/Refresh";
import Send from "@mui/icons-material/Send";
import {
  AppBar,
  Box,
  Chip,
  CircularProgress,
  IconButton,
  LinearProgress,
  Paper,
  Stack,
  TextField,
  Toolbar,
  Typography,
} from "@mui/material";
import type { MessageVM, PartVM } from "./ChatApp";

function toolChipIcon(status: string): string {
  if (status === "completed") return "✓";
  if (status === "error") return "✕";
  return "•";
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
    <Stack direction="row" spacing={0.5} sx={{ flexWrap: "wrap", gap: 0.5, mt: 0.5 }}>
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
  streaming: Map<string, string>;
  endedIds: Set<string>;
  toolRunningCount: number;
  loading: boolean;
  sending: boolean;
  onSend: (text: string) => Promise<boolean>;
  onBack?: () => void;
  onRefresh: () => void;
  onOpenSession?: (id: string) => void;
}

export default function ChatView({
  title,
  messages,
  streaming,
  endedIds,
  toolRunningCount,
  loading,
  sending,
  onSend,
  onBack,
  onRefresh,
  onOpenSession,
}: ChatViewProps) {
  const [text, setText] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);

  const streamingEntries = Array.from(streaming.entries());

  // When a session (re)opens, loading flips to true — treat it as a fresh
  // open and stick to the bottom, even if ChatView stayed mounted across a
  // session switch and the user had scrolled up in the previous session.
  useEffect(() => {
    if (loading) nearBottomRef.current = true;
  }, [loading]);

  // Autoscroll: only when the user is within 80px of the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && nearBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, streamingEntries, toolRunningCount]);

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

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void handleSend();
    }
  };

  return (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <AppBar position="static" color="default" elevation={0}>
        <Toolbar>
          {onBack && (
            <IconButton
              aria-label="Back to sessions"
              size="large"
              edge="start"
              sx={{
                minWidth: 48,
                minHeight: 48,
                color: (t) => t.palette.action.active,
              }}
              onClick={onBack}
            >
              <ArrowBack />
            </IconButton>
          )}
          <Typography variant="h6" component="h1" noWrap sx={{ flexGrow: 1 }}>
            {title}
          </Typography>
          <IconButton
            aria-label="Refresh messages"
            size="large"
            sx={{
              minWidth: 48,
              minHeight: 48,
              color: (t) => t.palette.action.active,
            }}
            onClick={onRefresh}
          >
            <Refresh />
          </IconButton>
        </Toolbar>
      </AppBar>

      {loading && <LinearProgress />}

      <Box
        ref={scrollRef}
        onScroll={handleScroll}
        sx={{
          flex: 1,
          overflowY: "auto",
          overflowX: "hidden",
          padding: 2,
          display: "flex",
          flexDirection: "column",
          gap: 1,
        }}
      >
        {messages.map((m) =>
          m.kind === "user" ? (
            <Paper
              key={m.id}
              sx={{
                alignSelf: "flex-end",
                maxWidth: "85%",
                bgcolor: "primary.main",
                color: "primary.contrastText",
                px: 1.5,
                py: 1,
                borderRadius: 2,
              }}
            >
              <Typography variant="body1" sx={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                {m.text}
              </Typography>
            </Paper>
          ) : (
            <Paper
              key={m.id}
              variant="outlined"
              sx={{
                alignSelf: "flex-start",
                maxWidth: "85%",
                px: 1.5,
                py: 1,
                borderRadius: 2,
              }}
            >
              {m.parts
                .filter((p) => p.kind === "text")
                .map((p, i) => (
                  <Typography key={i} variant="body1" sx={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                    {p.text}
                  </Typography>
                ))}
              <ToolParts parts={m.parts} onOpenSession={onOpenSession} />
            </Paper>
          ),
        )}

        {toolRunningCount > 0 && (
          <Stack
            direction="row"
            spacing={1}
            sx={{ alignSelf: "flex-start", width: 180, alignItems: "center" }}
          >
            <LinearProgress sx={{ flex: 1 }} />
            <Typography variant="caption" color="text.secondary" noWrap>
              Tool running…
            </Typography>
          </Stack>
        )}

        {streamingEntries.map(([id, value]) => (
          <Paper
            key={`streaming-${id}`}
            variant="outlined"
            sx={{
              alignSelf: "flex-start",
              maxWidth: "85%",
              px: 1.5,
              py: 1,
              borderRadius: 2,
            }}
          >
            {value ? (
              <Typography variant="body1" sx={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                {value}
                {!endedIds.has(id) && "…"}
              </Typography>
            ) : (
              <Typography variant="body1" color="text.secondary">
                ···
              </Typography>
            )}
          </Paper>
        ))}
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
            "& svg": { color: (t) => t.palette.primary.main },
            "&.Mui-disabled": {
              bgcolor: (t) => t.palette.action.selected,
              border: "1px solid",
              borderColor: (t) => t.palette.divider,
              "& svg": { color: (t) => t.palette.text.disabled },
            },
          }}
        >
          {sending ? <CircularProgress size={20} /> : <Send />}
        </IconButton>
      </Paper>
    </Box>
  );
}