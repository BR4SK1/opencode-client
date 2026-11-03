import { describe, expect, it } from "vitest";
import type { CssVarsTheme } from "@mui/material/styles";
import {
  DARK_SCHEME_SELECTOR,
  THEME_CHOICES,
  choiceToState,
} from "./theme-selection";
import theme from "./theme";
import {
  statusCaptionSx,
  statusRowSx,
} from "./components/SessionList";

/*
 * Node-environment contract tests for the SessionList status styles.  These
 * components must style themselves entirely through the active colour
 * scheme's CSS variables (never through theme.palette.*, which is pinned to
 * the default dark scheme under MUI's cssVariables setup), and every CSS
 * variable they reference must actually be emitted for all four schemes.
 *
 * The test walks the sx objects for `var(--...)` references and checks each
 * one against the stylesheets the theme generates per scheme.
 */

const varsTheme = theme as unknown as CssVarsTheme;

type Status = "running" | "waiting";

/* Recursively collect every `--mui-palette-*` variable name referenced by any
 * string in the sx object. */
function collectVars(node: unknown, into: Set<string> = new Set()): Set<string> {
  if (typeof node === "string") {
    for (const match of node.matchAll(/var\((--[\w-]+)/g)) {
      into.add(match[1]);
    }
  } else if (Array.isArray(node)) {
    for (const item of node) collectVars(item, into);
  } else if (node && typeof node === "object") {
    for (const value of Object.values(node)) collectVars(value, into);
  }
  return into;
}

/** One rule object per selector from the theme's generated stylesheets. */
function generatedRules(): Record<string, Record<string, string>> {
  const rules: Record<string, Record<string, string>> = {};
  for (const sheet of varsTheme.generateStyleSheets()) {
    if (typeof sheet !== "string") {
      for (const [selector, rule] of Object.entries(sheet)) {
        rules[selector] = rule as Record<string, string>;
      }
    }
  }
  return rules;
}

/* The canonical scheme rules: the dark default is emitted under the combined
 * `:root, .dark` selector (the standalone `:root` / `.dark` rules carry only
 * root-level tokens such as color-scheme); the other three schemes on their
 * classes. */
const CANONICAL_SELECTORS = [":root, .dark", ".light", ".sunfade-light", ".sunfade-dark"] as const;

describe("SessionList status styles", () => {
  it("uses the success channel for running and the warning channel for waiting", () => {
    const running = collectVars(statusRowSx("running"));
    expect(running).toContain("--mui-palette-success-mainChannel");
    expect(running).not.toContain("--mui-palette-warning-mainChannel");
    const waiting = collectVars(statusRowSx("waiting"));
    expect(waiting).toContain("--mui-palette-warning-mainChannel");
    expect(waiting).not.toContain("--mui-palette-success-mainChannel");
  });

  it("emits every referenced CSS variable under all four schemes", () => {
    const rules = generatedRules();
    const referenced = new Set<string>();
    for (const status of ["running", "waiting"] as Status[]) {
      collectVars(statusRowSx(status), referenced);
      collectVars(statusCaptionSx(status), referenced);
    }
    for (const selector of CANONICAL_SELECTORS) {
      const rule = rules[selector];
      expect(rule, `stylesheet for ${selector}`).toBeDefined();
      for (const cssVar of referenced) {
        /* Palette tokens arrive as hex/rgb() strings; *Channel tokens as bare
         * space-separated RGB numbers. */
        expect(rule[cssVar], `${cssVar} under ${selector}`).toMatch(
          /^(#[\da-fA-F]+|rgb|[\d.]+(?: [\d.]+)*)/,
        );
      }
    }
  });

  it("keeps the light/dark tint contract via the dark scheme selector", () => {
    const expectedDarkSelector = THEME_CHOICES
      .map(choiceToState)
      .filter((state) => state.mode === "dark")
      .map((state) => `.${state.scheme} &`)
      .join(", ");
    expect(DARK_SCHEME_SELECTOR).toBe(expectedDarkSelector);

    for (const status of ["running", "waiting"] as Status[]) {
      const sx = statusRowSx(status) as Record<string, unknown>;
      const background = sx.backgroundColor as string;
      /* Light tints are the 0.1 family; dark overrides the 0.2 family. */
      expect(background).toMatch(/rgb\(var\(--mui-palette-\w+-mainChannel\) \/ 0\.1\)/);
      const dark = sx[DARK_SCHEME_SELECTOR] as Record<string, unknown>;
      expect((dark.backgroundColor as string)).toMatch(
        /rgb\(var\(--mui-palette-\w+-mainChannel\) \/ 0\.2\)/,
      );
    }
  });

  it("picks the readable accent shade per scheme for status captions", () => {
    for (const status of ["running", "waiting"] as Status[]) {
      const accent = status === "running" ? "success" : "warning";
      const sx = statusCaptionSx(status) as Record<string, unknown>;
      expect(sx.color).toBe(`var(--mui-palette-${accent}-dark)`);
      const dark = sx[DARK_SCHEME_SELECTOR] as Record<string, unknown>;
      expect(dark.color).toBe(`var(--mui-palette-${accent}-light)`);
    }
  });
});
