import {
  createTheme,
  type ThemeOptions,
} from "@mui/material/styles";

/*
 * Font stacks.  Caskaydia Cove (the Nerd Font build of Cascadia Code) is the
 * preferred interface and content face; Montserrat is reserved for labels and
 * titles.  Neither is bundled: there is no font-loading mechanism in this
 * project, so these stacks depend on the fonts being available locally on the
 * visitor's device and otherwise fall back to the system faces below.
 */
export const monoStack =
  '"CaskaydiaCove Nerd Font", "CaskaydiaCove NF", "CaskaydiaCove Nerd Font Mono", "Cascadia Code", "Cascadia Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';

export const labelStack =
  '"Montserrat", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

/*
 * Labels and titles (headings, subtitling, overlines, buttons, captions) use
 * Montserrat; everything else — chat content, code, form inputs — inherits
 * the Caskaydia stack through the base fontFamily.
 */
const labelVariants = [
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "subtitle1",
  "subtitle2",
  "overline",
  "button",
  "caption",
] as const;

interface CodePalette {
  bg: string;
  border: string;
  text: string;
  inlineBg: string;
  keyword: string;
  string: string;
  comment: string;
  number: string;
  function: string;
  attr: string;
  tag: string;
  meta: string;
  addBg: string;
  delBg: string;
}

declare module "@mui/material/styles" {
  interface Palette {
    code: CodePalette;
  }
  interface PaletteOptions {
    code: CodePalette;
  }
  /*
   * Two extra colour schemes beyond MUI's built-in light/dark.  Declaring
   * them here lets the theme below register them and lets the theme selector
   * address them through `setColorScheme`.
   */
  interface ColorSchemeOverrides {
    "sunfade-light": true;
    "sunfade-dark": true;
  }
}

const lightCode: CodePalette = {
  bg: "#F6F8FA",
  border: "rgba(31,35,40,0.15)",
  text: "#1F2328",
  inlineBg: "rgba(110,119,129,0.15)",
  keyword: "#CF222E",
  string: "#0A3069",
  comment: "#59636E",
  number: "#0550AE",
  function: "#8250DF",
  attr: "#953800",
  tag: "#116329",
  meta: "#59636E",
  addBg: "rgba(9,105,27,0.12)",
  delBg: "rgba(207,34,46,0.10)",
};

const darkCode: CodePalette = {
  bg: "#161310",
  border: "rgba(237,229,212,0.14)",
  text: "#EDE5D4",
  inlineBg: "rgba(184,172,153,0.20)",
  keyword: "#FF7B72",
  string: "#A5D6FF",
  comment: "#8B949E",
  number: "#79C0FF",
  function: "#D2A8FF",
  attr: "#F0883E",
  tag: "#7EE787",
  meta: "#8B949E",
  addBg: "rgba(46,160,67,0.16)",
  delBg: "rgba(248,81,73,0.16)",
};

/* Sunfade code tokens (TerminalPreview mapping, medium contrast). */
const sunfadeLightCode: CodePalette = {
  bg: "#fff8e9",
  border: "#d5b99a",
  text: "#392b24",
  inlineBg: "rgba(121,90,69,0.15)",
  keyword: "#735063",
  string: "#434820",
  comment: "#392b24",
  number: "#593a11",
  function: "#2f484d",
  attr: "#324738",
  tag: "#62361f",
  meta: "#602e25",
  addBg: "rgba(67,72,32,0.16)",
  delBg: "rgba(96,46,37,0.12)",
};

/*
 * Sunfade dark follows the same Gruvbox-inspired greys as the UI palette
 * below: a neutral charcoal code well (#1d2021) with warm-grey chrome and
 * cream text, instead of the former sepia/brown surfaces.
 */
const sunfadeDarkCode: CodePalette = {
  bg: "#1d2021",
  border: "#45403d",
  text: "#ebdbb2",
  inlineBg: "rgba(168,153,132,0.24)",
  keyword: "#d3869b",
  string: "#a9b665",
  comment: "#9c9080",
  number: "#d8a657",
  function: "#89b482",
  attr: "#7daea3",
  tag: "#e78a4e",
  meta: "#9c9080",
  addBg: "rgba(169,182,101,0.16)",
  delBg: "rgba(230,104,104,0.12)",
};

/*
 * MUI derives a complete palette (grey ramp, common, contrast helpers, colour
 * channels) from an accent colour through `augmentColor`, which is reached
 * only via the built-in light and dark schemes.  The Sunfade roles therefore
 * go through a standalone `createTheme` call first so that every token is
 * derived, and the resulting palettes are then registered as colour schemes.
 */
const sunfadeLightBase = createTheme({
  palette: {
    mode: "light",
    code: sunfadeLightCode,
    primary: { main: "#4e5d61", contrastText: "#fff8e9" },
    secondary: { main: "#715260", contrastText: "#fff8e9" },
    error: { main: "#8e4636", contrastText: "#fff8e9" },
    warning: { main: "#755528", contrastText: "#fff8e9" },
    success: { main: "#5c5d2f", contrastText: "#fff8e9" },
    info: { main: "#505f4d", contrastText: "#fff8e9" },
    background: { default: "#f8e9d2", paper: "#e6cfb1" },
    text: { primary: "#392b24", secondary: "#4c392e", disabled: "#795a45" },
    divider: "#d5b99a",
    action: {
      hover: "#392b2414",
      selected: "#392b2429",
      disabled: "#795a45",
      disabledBackground: "#efddc2",
    },
  },
}).palette;

/*
 * Sunfade dark keeps the family's warm-muted accents and cream text, but the
 * surfaces trade the former sepia/browns for restrained Gruvbox-style greys:
 * neutral #282828 for the page, warm grey #3c3836 for paper, charcoal #1d2021
 * for code wells.  The accents stay desaturated and warm, and the primary is
 * a muted blue-grey rather than Current dark's bright sky blue, so the two
 * dark themes remain distinct at a glance.
 */
const sunfadeDarkBase = createTheme({
  palette: {
    mode: "dark",
    code: sunfadeDarkCode,
    primary: { main: "#83a598", contrastText: "#1d2021" },
    secondary: { main: "#d3869b", contrastText: "#1d2021" },
    error: { main: "#e66868", contrastText: "#1d2021" },
    warning: { main: "#d8a657", contrastText: "#1d2021" },
    success: { main: "#a9b665", contrastText: "#1d2021" },
    info: { main: "#89b482", contrastText: "#1d2021" },
    background: { default: "#282828", paper: "#3c3836" },
    text: { primary: "#ebdbb2", secondary: "#d5c4a1", disabled: "#a89984" },
    divider: "#45403d",
    action: {
      hover: "#ebdbb214",
      selected: "#ebdbb229",
      disabled: "#a89984",
      disabledBackground: "#32302f",
    },
  },
}).palette;

/*
 * A single scheme is the default so that its variables live on `:root` and a
 * visitor with nothing stored sees it without any flash: Current dark.
 */
const theme = createTheme({
  cssVariables: { colorSchemeSelector: "class" },
  defaultColorScheme: "dark",
  typography: {
    fontFamily: monoStack,
    ...Object.fromEntries(
      labelVariants.map((variant) => [variant, { fontFamily: labelStack }]),
    ),
  } as ThemeOptions["typography"],
  colorSchemes: {
    light: { palette: { code: lightCode } },
    dark: {
      palette: {
        primary: { main: "#90CAF9", contrastText: "#0B2545" },
        /*
         * Warm charcoal surfaces with cream text, aligned with the title
         * bar's look instead of the former neutral grey (which read brown
         * next to it).  The blue accent stays so Current dark keeps its own
         * identity beside the Sunfade schemes.
         */
        background: { default: "#1C1917", paper: "#292524" },
        divider: "rgba(237,229,212,0.14)",
        text: { primary: "#EDE5D4", secondary: "#B8AC99" },
        code: darkCode,
      },
    },
    "sunfade-light": {
      palette: { ...sunfadeLightBase, code: sunfadeLightCode },
    },
    "sunfade-dark": {
      palette: { ...sunfadeDarkBase, code: sunfadeDarkCode },
    },
  },
});
export default theme;
