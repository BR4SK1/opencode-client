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

  it("preserves the current dark appearance", () => {
    const dark = varsTheme.colorSchemes.dark!.palette;
    expect(dark.primary.main).toBe("#90CAF9");
    expect(dark.background.default).toBe("#121212");
    expect(dark.background.paper).toBe("#1E1E1E");
    expect(dark.text.primary).toBe("#E6E8EB");
    expect(dark.text.secondary).toBe("#9BA1A9");
    expect(dark.divider).toBe("rgba(255,255,255,0.12)");
    expect(dark.code.bg).toBe("#0F1317");
    expect(dark.mode).toBe("dark");
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
    expect(p.background.default).toBe("#28201b");
    expect(p.background.paper).toBe("#3b2d25");
    expect(p.text.primary).toBe("#ead3b0");
    expect(p.divider).toBe("#4e392e");
    expect(p.primary.main).toBe("#879a9a");
    expect(p.primary.contrastText).toBe("#1d1916");
    expect(p.code.bg).toBe("#1d1916");
    expect(p.code.keyword).toBe("#b28aa0");
  });

  it("keeps the derived accent channels in sync with the Sunfade mains", () => {
    const light = varsTheme.colorSchemes["sunfade-light"]!.palette;
    const dark = varsTheme.colorSchemes["sunfade-dark"]!.palette;
    /* #4e5d61 -> 78 93 97; #879a9a -> 135 154 154 */
    expect(light.primary.mainChannel).toBe("78 93 97");
    expect(dark.primary.mainChannel).toBe("135 154 154");
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
    expect(sfDark?.["--mui-palette-background-default"]).toBe("#28201b");
    expect(sfDark?.["--mui-palette-primary-main"]).toBe("#879a9a");
    expect(sfDark?.["--mui-palette-code-bg"]).toBe("#1d1916");

    const sfLight = findRule(".sunfade-light");
    expect(sfLight).toBeDefined();
    expect(sfLight?.["--mui-palette-background-default"]).toBe("#f8e9d2");
    expect(sfLight?.["--mui-palette-code-bg"]).toBe("#fff8e9");
  });
});
