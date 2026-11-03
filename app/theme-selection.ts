/*
 * Theme selection model for opencode-client.
 *
 * There are exactly four themes. MUI's CSS-variable machinery keeps two pieces
 * of state: the "mode" (light | dark) and a per-mode "colorScheme" override
 * (which palette to use for that mode).  A user-facing theme maps onto that
 * pair; this module is the single source of truth for the mapping, the
 * localStorage keys and the browser-chrome theme colours, so that the runtime
 * code and the pre-paint inline script in app/layout.tsx stay in lockstep.
 *
 * There is no "system" mode: when nothing is saved the default is Current
 * dark.  Legacy storage written by the old system/light/dark toggle is never
 * migrated; it is simply ignored.
 */

export const THEME_CHOICES = [
  "current-light",
  "current-dark",
  "sunfade-light",
  "sunfade-dark",
] as const;

export type ThemeChoice = (typeof THEME_CHOICES)[number];

/** localStorage key holding the mode part of the selection (light | dark). */
export const THEME_MODE_STORAGE_KEY = "oc-theme";
/** Prefix of the localStorage keys holding the per-mode colorScheme override. */
export const THEME_COLOR_SCHEME_STORAGE_KEY = "oc-theme-scheme";

/** Mode used when nothing is saved; also the pre-hydration fallback. */
export const DEFAULT_MODE = "dark";
/** Browser-chrome colour used when the scheme cannot be resolved. */
export const DEFAULT_THEME_COLOR = "#1C1917";

/** The four colour schemes registered in app/theme.ts. */
export type SchemeName = "light" | "dark" | "sunfade-light" | "sunfade-dark";

/** Browser-chrome theme-colour for every colour scheme. */
export const THEME_COLOR_BY_SCHEME: Record<SchemeName, string> = {
  light: "#ffffff",
  "sunfade-light": "#f8e9d2",
  dark: "#1C1917",
  "sunfade-dark": "#28201b",
};

interface SchemeState {
  mode: "light" | "dark";
  scheme: SchemeName;
}

const CHOICE_STATE: Record<ThemeChoice, SchemeState> = {
  "current-light": { mode: "light", scheme: "light" },
  "current-dark": { mode: "dark", scheme: "dark" },
  "sunfade-light": { mode: "light", scheme: "sunfade-light" },
  "sunfade-dark": { mode: "dark", scheme: "sunfade-dark" },
};

/*
 * Selector matching every dark-mode colour scheme, in the "&" ancestor form
 * sx expects.  Derived from the choice table so a new dark scheme cannot be
 * forgotten.  Use this instead of theme.palette.mode in component styles:
 * under MUI's CSS-variable setup the JS-side palette is pinned to the default
 * scheme (Current dark), so palette/mode reads do not follow Sunfade.
 */
export const DARK_SCHEME_SELECTOR = Object.values(CHOICE_STATE)
  .filter((state) => state.mode === "dark")
  .map((state) => `.${state.scheme} &`)
  .join(", ");

/**
 * MUI state for a user-facing theme choice.  Apply the mode first and the
 * colour scheme second: MUI stores the override in a per-mode key, so the
 * mode has to be updated before the override is written.
 */
export function choiceToState(choice: ThemeChoice): SchemeState {
  return CHOICE_STATE[choice];
}

/**
 * Resolves the user-facing choice from MUI's mode and resolved colour scheme.
 * Both are undefined during the server render and the hydration render; the
 * fallback is then the default (Current dark) so that server and first client
 * render agree.
 */
export function stateToChoice(
  mode: string | undefined,
  colorScheme: string | undefined,
): ThemeChoice {
  if (mode === "light") {
    if (colorScheme === "sunfade-light") return "sunfade-light";
    return "current-light";
  }
  if (mode === "dark") {
    if (colorScheme === "sunfade-dark") return "sunfade-dark";
    return "current-dark";
  }
  /* "system" or unknown modes are treated as the default. */
  return "current-dark";
}
