import { createTheme } from "@mui/material/styles";

export const monoStack =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';

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
  bg: "#0F1317",
  border: "rgba(240,246,252,0.12)",
  text: "#E6E8EB",
  inlineBg: "rgba(139,148,158,0.20)",
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

const sunfadeDarkCode: CodePalette = {
  bg: "#1d1916",
  border: "#4e392e",
  text: "#ead3b0",
  inlineBg: "rgba(167,135,98,0.20)",
  keyword: "#b28aa0",
  string: "#a1a45b",
  comment: "#ead3b0",
  number: "#dfa54c",
  function: "#89a3a4",
  attr: "#91a586",
  tag: "#e58349",
  meta: "#e4775f",
  addBg: "rgba(161,164,91,0.16)",
  delBg: "rgba(228,119,95,0.12)",
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

const sunfadeDarkBase = createTheme({
  palette: {
    mode: "dark",
    code: sunfadeDarkCode,
    primary: { main: "#879a9a", contrastText: "#1d1916" },
    secondary: { main: "#b18d98", contrastText: "#1d1916" },
    error: { main: "#d1826b", contrastText: "#1d1916" },
    warning: { main: "#c38c3a", contrastText: "#1d1916" },
    success: { main: "#979b5b", contrastText: "#1d1916" },
    info: { main: "#879d82", contrastText: "#1d1916" },
    background: { default: "#28201b", paper: "#3b2d25" },
    text: { primary: "#ead3b0", secondary: "#d5b991", disabled: "#a78762" },
    divider: "#4e392e",
    action: {
      hover: "#ead3b014",
      selected: "#ead3b029",
      disabled: "#a78762",
      disabledBackground: "#332720",
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
  colorSchemes: {
    light: { palette: { code: lightCode } },
    dark: {
      palette: {
        primary: { main: "#90CAF9", contrastText: "#0B2545" },
        background: { default: "#121212", paper: "#1E1E1E" },
        divider: "rgba(255,255,255,0.12)",
        text: { primary: "#E6E8EB", secondary: "#9BA1A9" },
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
