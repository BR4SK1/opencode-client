import { describe, expect, it } from "vitest";
import {
  DARK_SCHEME_SELECTOR,
  THEME_CHOICES,
  THEME_COLOR_BY_SCHEME,
  THEME_COLOR_SCHEME_STORAGE_KEY,
  THEME_MODE_STORAGE_KEY,
  choiceToState,
  stateToChoice,
} from "./theme-selection";

describe("theme selection model", () => {
  it("offers exactly the four choices", () => {
    expect([...THEME_CHOICES]).toEqual([
      "current-light",
      "current-dark",
      "sunfade-light",
      "sunfade-dark",
    ]);
  });

  it("maps each choice onto MUI's mode + colorScheme state", () => {
    expect(choiceToState("current-light")).toEqual({ mode: "light", scheme: "light" });
    expect(choiceToState("current-dark")).toEqual({ mode: "dark", scheme: "dark" });
    expect(choiceToState("sunfade-light")).toEqual({ mode: "light", scheme: "sunfade-light" });
    expect(choiceToState("sunfade-dark")).toEqual({ mode: "dark", scheme: "sunfade-dark" });
  });

  it("resolves the active choice from mode and colorScheme", () => {
    expect(stateToChoice("light", "light")).toBe("current-light");
    expect(stateToChoice("dark", "dark")).toBe("current-dark");
    expect(stateToChoice("light", "sunfade-light")).toBe("sunfade-light");
    expect(stateToChoice("dark", "sunfade-dark")).toBe("sunfade-dark");
  });

  it("falls back to the default (Current dark) before hydration and for unknown state", () => {
    expect(stateToChoice(undefined, undefined)).toBe("current-dark");
    expect(stateToChoice("dark", undefined)).toBe("current-dark");
    expect(stateToChoice("light", undefined)).toBe("current-light");
    expect(stateToChoice("light", "bogus")).toBe("current-light");
    expect(stateToChoice("dark", "bogus")).toBe("current-dark");
    /* "system" never resolves to a system-following choice. */
    expect(stateToChoice("system", undefined)).toBe("current-dark");
  });

  it("uses fresh storage keys that cannot collide with legacy oc-theme-mode", () => {
    expect(THEME_MODE_STORAGE_KEY).not.toBe("oc-theme-mode");
    expect(THEME_COLOR_SCHEME_STORAGE_KEY).not.toBe("oc-theme-mode");
    expect(THEME_COLOR_SCHEME_STORAGE_KEY).not.toContain("oc-theme-mode");
  });

  it("has a browser-chrome colour for every colour scheme", () => {
    for (const choice of THEME_CHOICES) {
      const { scheme } = choiceToState(choice);
      expect(THEME_COLOR_BY_SCHEME[scheme]).toMatch(/^#/);
    }
  });

  it("derives the dark scheme selector from exactly the dark-mode choices", () => {
    /* The selector must stay in lockstep with the choice table: every dark
     * scheme gets a class selector, no light scheme is matched. */
    const expected = THEME_CHOICES
      .map(choiceToState)
      .filter((state) => state.mode === "dark")
      .map((state) => `.${state.scheme} &`)
      .join(", ");
    expect(DARK_SCHEME_SELECTOR).toBe(expected);
    expect(DARK_SCHEME_SELECTOR).toContain(".dark &");
    expect(DARK_SCHEME_SELECTOR).toContain(".sunfade-dark &");
    expect(DARK_SCHEME_SELECTOR).not.toContain(".light &");
    expect(DARK_SCHEME_SELECTOR).not.toContain(".sunfade-light &");
  });
});
