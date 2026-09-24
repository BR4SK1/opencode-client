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

const theme = createTheme({
  cssVariables: { colorSchemeSelector: "class" },
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
  },
});

export default theme;
