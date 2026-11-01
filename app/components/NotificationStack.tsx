"use client";

import Close from "@mui/icons-material/Close";
import { Alert, Box, Button, IconButton, Stack } from "@mui/material";

export interface NotificationAction {
  /**
   * Stable id interpreted by the consumer's onAction handler at event time
   * (keeps ref-writing navigation callbacks out of render-scope data).
   */
  id: string;
  label: string;
}

export interface NotificationItem {
  key: string;
  severity: "info" | "warning" | "error" | "success";
  message: string;
  action?: NotificationAction;
  onClose?: () => void;
}

interface NotificationStackProps {
  /**
   * Urgent items (connection loss, errors). Rendered first and announced
   * assertively.
   */
  assertiveItems?: NotificationItem[];
  /** Session-attention items. Announced politely; persistent while pending. */
  politeItems?: NotificationItem[];
  /** Invoked when an item's action button is pressed. */
  onAction?: (item: NotificationItem, action: NotificationAction) => void;
}

function NotificationCard({
  item,
  role,
  onAction,
}: {
  item: NotificationItem;
  role: "alert" | "status";
  onAction?: (item: NotificationItem, action: NotificationAction) => void;
}) {
  // MUI renders `action` XOR the close button, so compose both explicitly.
  const actionNode =
    item.action || item.onClose ? (
      <Stack direction="row" sx={{ alignItems: "center", gap: 1, flexShrink: 0, ml: 1 }}>
        {item.action && (
          <Button
            color="inherit"
            variant="outlined"
            size="small"
            sx={{ height: 40 }}
            onClick={() => item.action && onAction?.(item, item.action)}
          >
            {item.action.label}
          </Button>
        )}
        {item.onClose && (
          <IconButton
            aria-label="Dismiss notification"
            size="small"
            onClick={item.onClose}
          >
            <Close fontSize="small" />
          </IconButton>
        )}
      </Stack>
    ) : undefined;
  return (
    <Alert
      // Roles are per-item (role="alert" announces assertively on insertion in
      // common screen readers; role="status" politely). The containers stay
      // unmounted-role-neutral so semantics are not nested or doubled.
      role={role}
      severity={item.severity}
      action={actionNode}
      sx={{
        borderRadius: 2,
        alignItems: "center",
        "& .MuiAlert-message": { minWidth: 0, py: 0.5 },
      }}
    >
      {item.message}
    </Alert>
  );
}

/**
 * Coordinated notification stack rendered *in flow* just above the composer
 * (or above the bottom of the mobile session list), never as a fixed overlay.
 * Because it occupies layout space it can never obscure the composer, and it
 * moves together with composer/keyboard height changes instead of relying on
 * hardcoded bottom offsets. The live-region containers stay mounted even when
 * empty so announcements are not lost when the first item appears.
 */
export default function NotificationStack({
  assertiveItems = [],
  politeItems = [],
  onAction,
}: NotificationStackProps) {
  const empty = assertiveItems.length === 0 && politeItems.length === 0;
  return (
    <Box
      // A focusable region lets keyboard users scroll the capped stack when it
      // overflows; it is only a tab stop while something is shown.
      {...(empty
        ? {}
        : { role: "region", "aria-label": "Notifications", tabIndex: 0 })}
      sx={{
        width: "100%",
        // Cap so a burst of notices cannot crush the chat scroll area on a
        // short (e.g. keyboard-open) viewport; overflow scrolls inside.
        maxHeight: "40dvh",
        overflowY: "auto",
        pt: empty ? 0 : 1.25,
        pb: empty ? 0 : 1,
        display: "flex",
        flexDirection: "column",
        gap: 1,
        // Horizontal padding is owned by the placement wrappers.
        "&:focus-visible": {
          outline: 2,
          outlineColor: "primary.main",
          outlineOffset: -2,
        },
      }}
    >
      <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
        {assertiveItems.map((item) => (
          <NotificationCard key={item.key} item={item} role="alert" onAction={onAction} />
        ))}
      </Box>
      <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
        {politeItems.map((item) => (
          <NotificationCard key={item.key} item={item} role="status" onAction={onAction} />
        ))}
      </Box>
    </Box>
  );
}
