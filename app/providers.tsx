"use client";

import * as React from "react";
import { ThemeProvider } from "@mui/material/styles";
import CssBaseline from "@mui/material/CssBaseline";
import GlobalStyles from "@mui/material/GlobalStyles";
import theme from "./theme";
import { ThemeColorSync } from "./components/ThemeSelector";
import {
  DEFAULT_MODE,
  THEME_COLOR_SCHEME_STORAGE_KEY,
  THEME_MODE_STORAGE_KEY,
} from "./theme-selection";

/*
 * Scrollbar and selection styling per colour scheme.  `color-scheme` itself is
 * written by the theme (every colour scheme carries its `palette.mode`), so it
 * is not repeated here.
 */
const globalStyles = (
  <GlobalStyles
    styles={{
      html: { scrollbarWidth: "thin" },
      "html.dark": {
        scrollbarWidth: "thin",
        scrollbarColor: "rgba(184,172,153,0.4) transparent",
      },
      "html.sunfade-dark": {
        scrollbarWidth: "thin",
        scrollbarColor: "rgba(235,219,178,0.35) transparent",
      },
      "::selection": { backgroundColor: "rgba(25,118,210,0.22)" },
      "html.dark ::selection": { backgroundColor: "rgba(144,202,249,0.30)" },
      "html.sunfade-light ::selection": {
        backgroundColor: "#4e5d61",
        color: "#fff8e9",
      },
      "html.sunfade-dark ::selection": {
        backgroundColor: "#83a598",
        color: "#1d2021",
      },
      "@keyframes oc-caret-blink": {
        "50%": { opacity: 0.15 },
      },
      // Markdown block spacing resets, scoped to MarkdownText's container.
      ".oc-md > :first-child": { marginTop: 0 },
      ".oc-md > :last-child": { marginBottom: 0 },
    }}
  />
);

export default function Providers({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ThemeProvider
      theme={theme}
      defaultMode={DEFAULT_MODE}
      modeStorageKey={THEME_MODE_STORAGE_KEY}
      colorSchemeStorageKey={THEME_COLOR_SCHEME_STORAGE_KEY}
      disableTransitionOnChange
    >
      <CssBaseline />
      {globalStyles}
      <ThemeColorSync />
      {children}
    </ThemeProvider>
  );
}
