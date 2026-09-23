"use client";

import { useEffect, useRef, useState } from "react";
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

function ToolParts({ parts }: { parts: PartVM[] }) {
  const tools = parts.filter((p): p is Extract<PartVM, { kind: "tool" }> => p.kind === "tool");
  if (tools.length === 0) return null;
  return (
    <Stack direction="row" spacing={0.5} sx={{ flexWrap: "wrap", gap: 0.5, mt: 0.5 }}>
      {tools.map((t) => (
        <Chip
          key={t.id}
          size="small"
          label={`${t.name} ${toolChipIcon(t.status)}`}
        />
      ))}
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
}: ChatViewProps) {
  const [text, setText] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);

  const streamingEntries = Array.from(streaming.entries());

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
              sx={{ minWidth: 48, minHeight: 48 }}
              onClick={onBack}
            >
              ‹
            </IconButton>
          )}
          <Typography variant="h6" component="h1" noWrap sx={{ flexGrow: 1 }}>
            {title}
          </Typography>
          <IconButton
            aria-label="Refresh messages"
            size="large"
            sx={{ minWidth: 48, minHeight: 48 }}
            onClick={onRefresh}
          >
            ⟳
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
              <Typography variant="body1" sx={{ whiteSpace: "pre-wrap" }}>
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
                  <Typography key={i} variant="body1" sx={{ whiteSpace: "pre-wrap" }}>
                    {p.text}
                  </Typography>
                ))}
              <ToolParts parts={m.parts} />
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
              <Typography variant="body1" sx={{ whiteSpace: "pre-wrap" }}>
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
          color="primary"
          disabled={!text.trim() || sending}
          onClick={() => void handleSend()}
          sx={{ minWidth: 48, minHeight: 48 }}
        >
          {sending ? <CircularProgress size={20} /> : "➤"}
        </IconButton>
      </Paper>
    </Box>
  );
}