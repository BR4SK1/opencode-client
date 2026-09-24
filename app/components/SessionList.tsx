"use client";

import Add from "@mui/icons-material/Add";
import Logout from "@mui/icons-material/Logout";
import ExpandMore from "@mui/icons-material/ExpandMore";
import {
  AppBar,
  Box,
  Button,
  Collapse,
  IconButton,
  List,
  ListItemButton,
  ListItemText,
  Toolbar,
  Typography,
} from "@mui/material";
import { useMemo, useState } from "react";
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
  const [open, setOpen] = useState<Set<string>>(new Set());

  // Group child sessions under their parent. Sessions whose parent is not in
  // the list (orphaned) fall back to top-level so no data is dropped.
  const { roots, childrenByParent } = useMemo(() => {
    const ids = new Set(sessions.map((s) => s.id));
    const childrenByParent = new Map<string, SessionVM[]>();
    const roots: SessionVM[] = [];
    for (const s of sessions) {
      if (s.parentID && ids.has(s.parentID)) {
        const list = childrenByParent.get(s.parentID);
        if (list) list.push(s);
        else childrenByParent.set(s.parentID, [s]);
      } else {
        roots.push(s);
      }
    }
    return { roots, childrenByParent };
  }, [sessions]);

  const toggleOpen = (id: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
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
          {roots.map((s) => {
            const children = childrenByParent.get(s.id);
            const expanded = open.has(s.id);
            return (
              <Box key={s.id}>
                <ListItemButton
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
                {children && children.length > 0 && (
                  <>
                    <ListItemButton
                      onClick={() => toggleOpen(s.id)}
                      aria-expanded={expanded}
                      aria-label={`Toggle subagent sessions for ${s.title || "Untitled"}`}
                      sx={{ minHeight: 40 }}
                    >
                      <ExpandMore
                        sx={{
                          mr: 1,
                          transition: (t) =>
                            t.transitions.create("transform", {
                              duration: t.transitions.duration.short,
                            }),
                          transform: expanded ? "rotate(180deg)" : "none",
                        }}
                      />
                      <ListItemText
                        primary={
                          <Typography variant="caption" color="text.secondary">
                            {children.length === 1
                              ? "1 subagent session"
                              : `${children.length} subagent sessions`}
                          </Typography>
                        }
                      />
                    </ListItemButton>
                    <Collapse
                      in={expanded}
                      timeout="auto"
                      unmountOnExit
                      component="li"
                    >
                      <List disablePadding>
                        {children.map((c) => (
                          <ListItemButton
                            key={c.id}
                            onClick={() => onOpen(c.id)}
                            sx={{ minHeight: 44, pl: 5 }}
                          >
                            <ListItemText
                              primary={
                                <Typography variant="body2" noWrap>
                                  {c.title || "Untitled"}
                                </Typography>
                              }
                              secondary={
                                <Typography
                                  variant="caption"
                                  color="text.secondary"
                                >
                                  {relativeTime(c.updated)}
                                </Typography>
                              }
                            />
                          </ListItemButton>
                        ))}
                      </List>
                    </Collapse>
                  </>
                )}
              </Box>
            );
          })}
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