"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { Alert, Button, CircularProgress, Stack } from "@mui/material";

export default function SignInButton({ demo }: { demo: boolean }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  const handleClick = async () => {
    setError(false);
    setLoading(true);
    try {
      if (demo) {
        await signIn("demo", { redirectTo: "/" });
      } else {
        await signIn("oidc", { redirectTo: "/" });
      }
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Stack sx={{ width: "100%", gap: 2 }}>
      {error && !demo && (
        <Alert severity="error">
          Sign-in is not configured (missing AUTH_OIDC_* environment variables).
        </Alert>
      )}
      <Button
        variant="contained"
        size="large"
        sx={{ height: 48 }}
        disabled={loading}
        onClick={handleClick}
      >
        {loading ? (
          <CircularProgress size={20} />
        ) : demo ? (
          "Enter demo mode"
        ) : (
          "Sign in"
        )}
      </Button>
    </Stack>
  );
}
