"use client";

import { useState } from "react";
import {
  Alert,
  Button,
  CircularProgress,
  Dialog,
  Stack,
  Typography,
} from "@mui/material";
import type { PendingPermission } from "./ChatApp";
import { CodeBlock } from "./CodeBlock";

interface PermissionDialogProps {
  permission: PendingPermission;
  sessionId: string;
  onDone: () => void;
}

export default function PermissionDialog({
  permission,
  sessionId,
  onDone,
}: PermissionDialogProps) {
  const [replying, setReplying] = useState<string | null>(null);
  const [error, setError] = useState(false);

  const reply = async (decision: "once" | "always" | "reject") => {
    setReplying(decision);
    setError(false);
    try {
      const res = await fetch(
        `/api/sessions/${sessionId}/permission/${permission.id}/reply`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decision }),
        },
      );
      if (res.status === 204) {
        onDone();
        return;
      }
      setError(true);
    } catch {
      setError(true);
    } finally {
      setReplying(null);
    }
  };

  return (
    <Dialog
      open
      onClose={() => {
        /* force an explicit decision */
      }}
      sx={{ alignItems: { xs: "flex-end", sm: "center" } }}
      slotProps={{
        paper: {
          sx: {
            width: "100%",
            maxWidth: 420,
            borderTopLeftRadius: { xs: 16, sm: 4 },
            borderTopRightRadius: { xs: 16, sm: 4 },
            borderBottomLeftRadius: { xs: 0, sm: 4 },
            borderBottomRightRadius: { xs: 0, sm: 4 },
            m: 0,
          },
        },
      }}
    >
      <Stack sx={{ p: 2.5, gap: 1.25, minWidth: 0 }}>
        <Typography variant="h6">Permission requested</Typography>
        <Typography variant="body1" sx={{ fontWeight: "bold", overflowWrap: "anywhere" }}>
          {permission.action}
        </Typography>
        {permission.resources.map((r) => (
          <CodeBlock
            key={r}
            code={r}
            lang={/(bash|shell|command|exec)/i.test(permission.action) ? "bash" : undefined}
            maxHeight={200}
          />
        ))}
        {permission.save && permission.save.length > 0 && (
          <Typography variant="caption" color="text.secondary">
            Allowing always saves rule: {permission.save.join(", ")}
          </Typography>
        )}
        {permission.message && (
          <Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>
            {permission.message}
          </Typography>
        )}
        {error && (
          <Alert severity="error">Failed to send reply. Try again.</Alert>
        )}
      </Stack>
      <Stack
        direction={{ xs: "column", sm: "row" }}
        spacing={1}
        sx={{
          p: 2,
          pt: 0,
          display: { xs: "flex", sm: "grid" },
          gridTemplateColumns: { sm: "repeat(3, minmax(0, 1fr))" },
        }}
      >
        <Button
          variant="contained"
          fullWidth
          disabled={replying !== null}
          onClick={() => void reply("once")}
          sx={{ height: 48 }}
        >
          {replying === "once" && <CircularProgress size={20} sx={{ mr: 1 }} />}
          Allow once
        </Button>
        <Button
          variant="outlined"
          fullWidth
          disabled={replying !== null}
          onClick={() => void reply("always")}
          sx={{ height: 48 }}
        >
          {replying === "always" && <CircularProgress size={20} sx={{ mr: 1 }} />}
          Always allow
        </Button>
        <Button
          color="error"
          fullWidth
          disabled={replying !== null}
          onClick={() => void reply("reject")}
          sx={{ height: 48 }}
        >
          {replying === "reject" && <CircularProgress size={20} sx={{ mr: 1 }} />}
          Deny
        </Button>
      </Stack>
    </Dialog>
  );
}