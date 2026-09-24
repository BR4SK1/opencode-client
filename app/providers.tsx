"use client";

import * as React from "react";
import { ThemeProvider } from "@mui/material/styles";
import CssBaseline from "@mui/material/CssBaseline";
import GlobalStyles from "@mui/material/GlobalStyles";
import theme from "./theme";
import { ThemeColorSync } from "./components/ThemeToggle";

const globalStyles = (
  <GlobalStyles
    styles={{
      html: { colorScheme: "light", scrollbarWidth: "thin" },
      "html.dark": {
        colorScheme: "dark",
        scrollbarWidth: "thin",
        scrollbarColor: "rgba(155,161,169,0.4) transparent",
      },
      "::selection": { backgroundColor: "rgba(25,118,210,0.22)" },
      "html.dark ::selection": { backgroundColor: "rgba(144,202,249,0.30)" },
      "@keyframes oc-caret-blink": {
        "50%": { opacity: 0.15 },
      },
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
      defaultMode="system"
      modeStorageKey="oc-theme-mode"
      disableTransitionOnChange
    >
      <CssBaseline />
      {globalStyles}
      <ThemeColorSync />
      {children}
    </ThemeProvider>
  );
}
