"use client";

import Add from "@mui/icons-material/Add";
import Logout from "@mui/icons-material/Logout";
import {
  AppBar,
  Box,
  Button,
  IconButton,
  List,
  ListItemButton,
  ListItemText,
  Toolbar,
  Typography,
} from "@mui/material";
import type { SessionVM } from "./ChatApp";

function relativeTime(ts: number): string {
  const millis = ts < 1e12 ? ts * 1000 : ts;
  const diff = Date.now() - millis;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

interface SessionListProps {
  variant: "mobile" | "desktop";
  sessions: SessionVM[];
  onOpen: (id: string) => void;
  onNew: () => void;
  onLogout: () => void;
}

export default function SessionList({
  variant,
  sessions,
  onOpen,
  onNew,
  onLogout,
}: SessionListProps) {
  return (
    <Box
      sx={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        overflow: "hidden",
      }}
    >
      {variant === "mobile" && (
        <AppBar position="static" color="default" elevation={0}>
          <Toolbar>
            <Typography variant="h6" component="h1" sx={{ flexGrow: 1 }}>
              opencode-client
            </Typography>
            <IconButton
              aria-label="New chat"
              size="large"
              sx={{
                minWidth: 48,
                minHeight: 48,
                color: (t) => t.palette.action.active,
              }}
              onClick={onNew}
            >
              <Add />
            </IconButton>
            <IconButton
              aria-label="Log out"
              size="large"
              sx={{
                minWidth: 48,
                minHeight: 48,
                color: (t) => t.palette.action.active,
              }}
              onClick={onLogout}
            >
              <Logout />
            </IconButton>
          </Toolbar>
        </AppBar>
      )}

      <Box sx={{ flex: 1, overflowY: "auto" }}>
        <List disablePadding>
          {sessions.map((s) => (
            <ListItemButton
              key={s.id}
              onClick={() => onOpen(s.id)}
              sx={{ minHeight: 56 }}
            >
              <ListItemText
                primary={
                  <Typography variant="body1" noWrap>
                    {s.title || "Untitled"}
                  </Typography>
                }
                secondary={
                  <Typography variant="caption" color="text.secondary">
                    {relativeTime(s.updated)}
                  </Typography>
                }
              />
            </ListItemButton>
          ))}
          {sessions.length === 0 && (
            <Box sx={{ p: 2 }}>
              <Typography variant="body2" color="text.secondary">
                No sessions yet.
              </Typography>
            </Box>
          )}
        </List>
      </Box>

      {variant === "desktop" && (
        <Box sx={{ p: 1, borderTop: 1, borderColor: "divider" }}>
          <Button fullWidth variant="outlined" onClick={onNew} sx={{ height: 48 }}>
            New chat
          </Button>
          <Button fullWidth color="inherit" onClick={onLogout} sx={{ height: 48 }}>
            Log out
          </Button>
        </Box>
      )}
    </Box>
  );
}