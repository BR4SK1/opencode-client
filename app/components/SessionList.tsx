"use client";

import Add from "@mui/icons-material/Add";
import Logout from "@mui/icons-material/Logout";
import ExpandMore from "@mui/icons-material/ExpandMore";
import StopCircle from "@mui/icons-material/StopCircle";
import ForumOutlined from "@mui/icons-material/ForumOutlined";
import {
  AppBar,
  Badge,
  Box,
  Button,
  Collapse,
  IconButton,
  List,
  ListItemButton,
  ListItemText,
  Stack,
  Toolbar,
  Typography,
} from "@mui/material";
import { useMemo, useState, type ReactNode } from "react";
import type { SessionListStatus, SessionVM } from "./ChatApp";
import { ThemeSelector } from "./ThemeSelector";
import BrailleShading from "./BrailleShading";
import { DARK_SCHEME_SELECTOR } from "../theme-selection";

/*
 * Status row tint.  The accent colour and its alpha are taken from the active
 * colour scheme's CSS variables — never from theme.palette.*, which under
 * MUI's CSS-variable setup is pinned to the default scheme (Current dark) and
 * would not follow Sunfade.  Light schemes use the lighter tints; both dark
 * schemes (via DARK_SCHEME_SELECTOR) use the stronger ones, preserving the
 * previous light/dark alpha tuning.
 */
export function statusRowSx(status: SessionListStatus) {
  const channel =
    status === "running"
      ? "--mui-palette-success-mainChannel"
      : "--mui-palette-warning-mainChannel";
  const tint = (a: number) => `rgb(var(${channel}) / ${a})`;
  return {
    backgroundColor: tint(0.1),
    "&:hover": { backgroundColor: tint(0.16) },
    "&.Mui-selected": { backgroundColor: tint(0.18) },
    "&.Mui-selected:hover": { backgroundColor: tint(0.23) },
    [DARK_SCHEME_SELECTOR]: {
      backgroundColor: tint(0.2),
      "&:hover": { backgroundColor: tint(0.26) },
      "&.Mui-selected": { backgroundColor: tint(0.28) },
      "&.Mui-selected:hover": { backgroundColor: tint(0.33) },
    },
  };
}

/*
 * Status caption colour.  Light schemes take the deep accent shade (readable
 * on pale backgrounds), dark schemes the pale shade; both resolved through
 * the active scheme's CSS variables.
 */
export function statusCaptionSx(status: SessionListStatus) {
  const accent = status === "running" ? "success" : "warning";
  return {
    fontWeight: 600,
    color: `var(--mui-palette-${accent}-dark)`,
    [DARK_SCHEME_SELECTOR]: {
      color: `var(--mui-palette-${accent}-light)`,
    },
  };
}

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
  sessionStatuses: Map<string, SessionListStatus>;
  pendingCounts: Map<string, number>;
  activeId?: string;
  onOpen: (id: string) => void;
  onStop: (id: string, title: string) => void;
  onNew: () => void;
  onLogout: () => void;
  /**
   * In-flow notification stack rendered below the list (inside the root's
   * safe-area padding). Only passed for the mobile variant; on desktop the
   * chat column hosts the stack.
   */
  notificationArea?: ReactNode;
}

interface SubagentSessionRowProps {
  session: SessionVM;
  status?: SessionListStatus;
  pendingCount: number;
  active: boolean;
  onOpen: (id: string) => void;
  onStop: (id: string, title: string) => void;
}

export function SubagentSessionRow({
  session,
  status,
  pendingCount,
  active,
  onOpen,
  onStop,
}: SubagentSessionRowProps) {
  const title = session.title || "Untitled";
  const statusLabel = status === "running"
    ? "Processing"
    : status === "waiting"
      ? "Needs input"
      : undefined;

  return (
    <Box component="li" sx={{ display: "flex", alignItems: "stretch", minWidth: 0 }}>
      <ListItemButton
        onClick={() => onOpen(session.id)}
        selected={active}
        aria-label={`${title}${statusLabel ? ` — ${statusLabel}` : ""}`}
        title={statusLabel ? `${title} — ${statusLabel}` : title}
        sx={[
          { minHeight: 44, pl: 5, flex: 1, minWidth: 0 },
          ...(status ? [statusRowSx(status)] : []),
        ]}
      >
        <ListItemText
          primary={
            <Box sx={{ display: "flex", alignItems: "center", gap: 1, minWidth: 0 }}>
              <Typography variant="body2" noWrap sx={{ flex: 1, minWidth: 0 }}>
                {title}
              </Typography>
              {pendingCount > 0 && (
                <Badge
                  color="warning"
                  badgeContent={pendingCount}
                  sx={{
                    flexShrink: 0,
                    "& .MuiBadge-badge": { position: "static", transform: "none" },
                  }}
                />
              )}
            </Box>
          }
          secondary={
            <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
              <Typography variant="caption" color="text.secondary">
                {relativeTime(session.updated)}
              </Typography>
              {statusLabel && status && (
                <Typography variant="caption" sx={statusCaptionSx(status)}>
                  {statusLabel}
                </Typography>
              )}
            </Box>
          }
        />
      </ListItemButton>
      <IconButton
        aria-label={`Stop or clean up subagent session: ${title}`}
        title={`Stop or clean up ${title}`}
        onClick={(event) => {
          event.stopPropagation();
          onStop(session.id, title);
        }}
        sx={{ minWidth: 48, minHeight: 48, color: "error.main", flexShrink: 0 }}
      >
        <StopCircle />
      </IconButton>
    </Box>
  );
}

export default function SessionList({
  variant,
  sessions,
  sessionStatuses,
  pendingCounts,
  activeId,
  onOpen,
  onStop,
  onNew,
  onLogout,
  notificationArea,
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
        // Safe-area bottom inset for the chat page's viewportFit: "cover"
        // (app/page.tsx): keeps the mobile list's last rows and the desktop
        // variant's bottom buttons out of the home-indicator / rounded-corner
        // zone. No-op wherever the inset resolves to 0; device-dependent.
        paddingBottom: "env(safe-area-inset-bottom, 0px)",
      }}
    >
      {variant === "desktop" && (
        <Box
          sx={{
            px: 2,
            py: 1.5,
            borderBottom: 1,
            borderColor: "divider",
            display: "flex",
            alignItems: "center",
            // Positioning context + clipping for the decorative braille
            // shading; the content wrapper below paints above it.
            position: "relative",
            overflow: "hidden",
          }}
        >
          <BrailleShading />
          <Box
            sx={{
              position: "relative",
              display: "flex",
              alignItems: "center",
              flex: 1,
              minWidth: 0,
            }}
          >
            <Typography variant="h6" component="h1" sx={{ flexGrow: 1 }}>
              opencode-client
            </Typography>
            <ThemeSelector />
          </Box>
        </Box>
      )}

      {variant === "mobile" && (
        <AppBar
          position="static"
          color="default"
          elevation={0}
          sx={{
            // Positioning context + clipping for the decorative braille
            // shading; the toolbar below paints above it.
            position: "relative",
            overflow: "hidden",
          }}
        >
          <BrailleShading />
          <Toolbar sx={{ position: "relative" }}>
            <Typography variant="h6" component="h1" sx={{ flexGrow: 1 }}>
              opencode-client
            </Typography>
            <ThemeSelector />
            <IconButton
              aria-label="New chat"
              size="large"
              sx={{
                minWidth: 48,
                minHeight: 48,
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
            const status = sessionStatuses.get(s.id);
            const statusLabel =
              status === "running"
                ? "Processing"
                : status === "waiting"
                  ? "Needs input"
                  : undefined;
            const badgeCount =
              (pendingCounts.get(s.id) ?? 0) +
              (children ?? []).reduce(
                (acc, c) => acc + (pendingCounts.get(c.id) ?? 0),
                0,
              );
            return (
              <Box key={s.id}>
                <ListItemButton
                  onClick={() => onOpen(s.id)}
                  selected={s.id === activeId}
                  aria-label={`${s.title || "Untitled"}${statusLabel ? ` — ${statusLabel}` : ""}`}
                  title={
                    statusLabel
                      ? `${s.title || "Untitled"} — ${statusLabel}`
                      : s.title || "Untitled"
                  }
                  sx={[{ minHeight: 56 }, ...(status ? [statusRowSx(status)] : [])]}
                >
                  <ListItemText
                    primary={
                      <Box
                        sx={{ display: "flex", alignItems: "center", gap: 1, minWidth: 0 }}
                      >
                        <Typography variant="body1" noWrap sx={{ flex: 1, minWidth: 0 }}>
                          {s.title || "Untitled"}
                        </Typography>
                        {badgeCount > 0 && (
                          <Badge
                            color="warning"
                            badgeContent={badgeCount}
                            sx={{
                              flexShrink: 0,
                              "& .MuiBadge-badge": {
                                position: "static",
                                transform: "none",
                              },
                            }}
                          />
                        )}
                      </Box>
                    }
                    secondary={
                      <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                        <Typography variant="caption" color="text.secondary">
                          {relativeTime(s.updated)}
                        </Typography>
                        {statusLabel && status && (
                          <Typography variant="caption" sx={statusCaptionSx(status)}>
                            {statusLabel}
                          </Typography>
                        )}
                      </Box>
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
                        {children.map((child) => (
                          <SubagentSessionRow
                            key={child.id}
                            session={child}
                            status={sessionStatuses.get(child.id)}
                            pendingCount={pendingCounts.get(child.id) ?? 0}
                            active={child.id === activeId}
                            onOpen={onOpen}
                            onStop={onStop}
                          />
                        ))}
                      </List>
                    </Collapse>
                  </>
                )}
              </Box>
            );
          })}
          {sessions.length === 0 && (
            <Stack spacing={1} sx={{ py: 6, alignItems: "center" }}>
              <ForumOutlined sx={{ fontSize: 36, color: "text.disabled" }} />
              <Typography variant="body2" color="text.secondary">
                No sessions yet
              </Typography>
              <Typography variant="caption" color="text.disabled">
                Start a new chat to begin
              </Typography>
            </Stack>
          )}
        </List>
      </Box>

      {notificationArea && <Box sx={{ px: 1.5 }}>{notificationArea}</Box>}

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
