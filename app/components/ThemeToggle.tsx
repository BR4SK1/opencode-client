"use client";

import { useEffect } from "react";
import BrightnessAuto from "@mui/icons-material/BrightnessAuto";
import LightMode from "@mui/icons-material/LightMode";
import DarkMode from "@mui/icons-material/DarkMode";
import IconButton from "@mui/material/IconButton";
import { useColorScheme } from "@mui/material/styles";

const LABELS = {
  system: "Theme: system (follows device)",
  light: "Theme: light",
  dark: "Theme: dark",
} as const;

export function ThemeToggle() {
  const { mode, setMode } = useColorScheme();
  // `mode` is undefined during SSR and the first client render — fall back to
  // the system icon so server and client markup match.
  const effective: "system" | "light" | "dark" = mode ?? "system";
  const Icon =
    effective === "light" ? LightMode : effective === "dark" ? DarkMode : BrightnessAuto;

  const cycle = () => {
    const next =
      effective === "system" ? "light" : effective === "dark" ? "system" : "dark";
    setMode(next);
  };

  return (
    <IconButton
      size="large"
      onClick={cycle}
      aria-label={LABELS[effective]}
      title={LABELS[effective]}
      sx={{ minWidth: 48, minHeight: 48, color: (t) => t.palette.action.active }}
    >
      <Icon />
    </IconButton>
  );
}

export function ThemeColorSync() {
  const { mode, systemMode } = useColorScheme();
  useEffect(() => {
    const effective = mode === "system" ? systemMode : mode;
    if (!effective) return;
    const color = effective === "dark" ? "#1E1E1E" : "#ffffff";
    document
      .querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')
      .forEach((meta) => {
        meta.setAttribute("content", color);
      });
  }, [mode, systemMode]);
  return null;
}
