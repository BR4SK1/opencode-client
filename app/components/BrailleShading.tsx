"use client";

import Box from "@mui/material/Box";

/*
 * Restrained decorative texture for title bars: a single row of braille
 * characters at very low opacity, rendered behind the bar's content.
 *
 * Guarantees:
 * - aria-hidden and pointer-events: none, so it is invisible to assistive
 *   technology and never intercepts touches or keyboard focus.
 * - Absolutely positioned with the parent clipping overflow, so it can never
 *   shift layout or overlap text outside its bar; the sibling content is
 *   positioned relative and paints above it.
 * - Coloured through `currentColor` (the bar's text colour) at low opacity, so
 *   it stays subtle in every colour scheme.
 */

/* A dotted gradient of braille cells — texture, not a message. */
const PATTERN = "⣿⣻⢿⡿⣟⣯⣷⣾⣽⣻";
const REPEATS = 40;

export default function BrailleShading() {
  return (
    <Box
      aria-hidden="true"
      sx={{
        position: "absolute",
        inset: 0,
        overflow: "hidden",
        pointerEvents: "none",
        userSelect: "none",
        display: "flex",
        alignItems: "center",
        color: "text.primary",
        opacity: 0.07,
        "& > span": {
          whiteSpace: "nowrap",
          lineHeight: 1,
          fontSize: 24,
          letterSpacing: "0.06em",
          pl: 1,
        },
      }}
    >
      <span>{PATTERN.repeat(REPEATS)}</span>
    </Box>
  );
}
