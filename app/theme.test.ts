import { describe, expect, it } from "vitest";
import type { CssVarsTheme } from "@mui/material/styles";
import theme from "./theme";

/* The CSS-variable machinery (colour schemes, generated stylesheets) lives on
 * the CssVarsTheme side of the union, which the default export does not
 * advertise; the tests read it through that view. */
const varsTheme = theme as unknown as CssVarsTheme;

describe("the four-colour-scheme theme", () => {
  it("registers exactly the four schemes with dark as the default", () => {
    expect(Object.keys(varsTheme.colorSchemes).sort()).toEqual([
      "dark",
      "light",
      "sunfade-dark",
      "sunfade-light",
    ]);
    expect(varsTheme.defaultColorScheme).toBe("dark");
  });

  it("applies the warm charcoal / cream dark appearance", () => {
    const dark = varsTheme.colorSchemes.dark!.palette;
    expect(dark.primary.main).toBe("#90CAF9");
    expect(dark.background.default).toBe("#1C1917");
    expect(dark.background.paper).toBe("#292524");
    expect(dark.text.primary).toBe("#EDE5D4");
    expect(dark.text.secondary).toBe("#B8AC99");
    expect(dark.divider).toBe("rgba(237,229,212,0.14)");
    expect(dark.code.bg).toBe("#161310");
    expect(dark.mode).toBe("dark");
  });

  it("leaves the other three schemes untouched (distinct themes)", () => {
    expect(varsTheme.colorSchemes.light!.palette.code.bg).toBe("#F6F8FA");
    const sfLight = varsTheme.colorSchemes["sunfade-light"]!.palette;
    expect(sfLight.background.default).toBe("#f8e9d2");
    const sfDark = varsTheme.colorSchemes["sunfade-dark"]!.palette;
    expect(sfDark.background.default).toBe("#282828");
  });

  it("prefers Caskaydia Cove for content and Montserrat for labels", () => {
    const typography = (theme as unknown as { typography: Record<string, { fontFamily?: string }> })
      .typography;
    expect(typography.fontFamily).toContain("CaskaydiaCove Nerd Font");
    /* Content variants resolve to the base Caskaydia stack, never Montserrat. */
    expect(typography.body1?.fontFamily).toContain("CaskaydiaCove");
    expect(typography.body1?.fontFamily).not.toContain("Montserrat");
    for (const variant of [
      "h1",
      "h6",
      "subtitle2",
      "overline",
      "button",
      "caption",
    ]) {
      expect(typography[variant]?.fontFamily).toContain("Montserrat");
    }
  });

  it("preserves the current light appearance", () => {
    const light = varsTheme.colorSchemes.light!.palette;
    expect(light.code.bg).toBe("#F6F8FA");
    expect(light.mode).toBe("light");
  });

  it("applies the verified Sunfade light roles", () => {
    const p = varsTheme.colorSchemes["sunfade-light"]!.palette;
    expect(p.mode).toBe("light");
    expect(p.background.default).toBe("#f8e9d2");
    expect(p.background.paper).toBe("#e6cfb1");
    expect(p.text.primary).toBe("#392b24");
    expect(p.text.secondary).toBe("#4c392e");
    expect(p.divider).toBe("#d5b99a");
    /* Sunfade maps its blue accent to MUI's primary. */
    expect(p.primary.main).toBe("#4e5d61");
    expect(p.primary.contrastText).toBe("#fff8e9");
    expect(p.code.bg).toBe("#fff8e9");
    expect(p.code.keyword).toBe("#735063");
  });

  it("applies the verified Sunfade dark roles", () => {
    const p = varsTheme.colorSchemes["sunfade-dark"]!.palette;
    expect(p.mode).toBe("dark");
    expect(p.background.default).toBe("#282828");
    expect(p.background.paper).toBe("#3c3836");
    expect(p.text.primary).toBe("#ebdbb2");
    expect(p.divider).toBe("#45403d");
    expect(p.primary.main).toBe("#83a598");
    expect(p.primary.contrastText).toBe("#1d2021");
    expect(p.code.bg).toBe("#1d2021");
    expect(p.code.keyword).toBe("#d3869b");
  });

  it("keeps Sunfade dark distinct from Current dark", () => {
    const current = varsTheme.colorSchemes.dark!.palette;
    const sunfade = varsTheme.colorSchemes["sunfade-dark"]!.palette;
    /* Neutral grey vs warm charcoal: the two dark pages must not collide. */
    expect(sunfade.background.default).not.toBe(current.background.default);
    expect(sunfade.background.paper).not.toBe(current.background.paper);
    /* Muted blue-grey accent vs Current dark's bright sky blue. */
    expect(sunfade.primary.main).not.toBe(current.primary.main);
  });

  it("keeps the derived accent channels in sync with the Sunfade mains", () => {
    const light = varsTheme.colorSchemes["sunfade-light"]!.palette;
    const dark = varsTheme.colorSchemes["sunfade-dark"]!.palette;
    /* #4e5d61 -> 78 93 97; #83a598 -> 131 165 152 */
    expect(light.primary.mainChannel).toBe("78 93 97");
    expect(dark.primary.mainChannel).toBe("131 165 152");
  });

  it("generates one stylesheet per scheme, dark attached to :root", () => {
    const selectors = varsTheme
      .generateStyleSheets()
      .flatMap((sheet) => (typeof sheet === "string" ? [sheet] : Object.keys(sheet)))
      .sort();
    expect(selectors).toEqual([
      ".dark",
      ".light",
      ".sunfade-dark",
      ".sunfade-light",
      ":root",
      ":root, .dark",
    ]);
  });

  it("exposes the Sunfade palettes as CSS variables under their classes", () => {
    const findRule = (selector: string) => {
      for (const sheet of varsTheme.generateStyleSheets()) {
        if (typeof sheet !== "string" && sheet[selector]) {
          return sheet[selector] as Record<string, string>;
        }
      }
      return undefined;
    };

    const sfDark = findRule(".sunfade-dark");
    expect(sfDark).toBeDefined();
    expect(sfDark?.["--mui-palette-background-default"]).toBe("#282828");
    expect(sfDark?.["--mui-palette-primary-main"]).toBe("#83a598");
    expect(sfDark?.["--mui-palette-code-bg"]).toBe("#1d2021");

    const sfLight = findRule(".sunfade-light");
    expect(sfLight).toBeDefined();
    expect(sfLight?.["--mui-palette-background-default"]).toBe("#f8e9d2");
    expect(sfLight?.["--mui-palette-code-bg"]).toBe("#fff8e9");
  });
});
