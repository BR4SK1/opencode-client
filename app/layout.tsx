import type { Metadata, Viewport } from "next";
import InitColorSchemeScript from "@mui/material/InitColorSchemeScript";
import { AppRouterCacheProvider } from "@mui/material-nextjs/v16-appRouter";
import Providers from "./providers";
import RegisterServiceWorker from "./components/RegisterServiceWorker";
import {
  DEFAULT_MODE,
  DEFAULT_THEME_COLOR,
  THEME_COLOR_BY_SCHEME,
  THEME_COLOR_SCHEME_STORAGE_KEY,
  THEME_MODE_STORAGE_KEY,
} from "./theme-selection";

export const metadata: Metadata = {
  title: "opencode-client",
  description: "Mobile-first chat client for OpenCode",
  manifest: "/manifest.webmanifest",
  applicationName: "opencode-client",
  appleWebApp: {
    capable: true,
    title: "opencode-client",
    // "default" keeps iOS status-bar text readable in both themes. Whether
    // the bar overlaps content is device- and mode-dependent, so the chat
    // page (the only route with viewportFit: "cover") pads its shell top by
    // env(safe-area-inset-top) defensively.
    statusBarStyle: "default",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  interactiveWidget: "resizes-content",
  /*
   * A single value rather than a media-query list: the app never follows the
   * OS setting, so the initial colour below is simply the default theme's,
   * and both scripts below correct it before paint for every other theme.
   */
  themeColor: DEFAULT_THEME_COLOR,
};

/*
 * Applies the persisted theme colour immediately (before paint) so the mobile
 * browser chrome matches on first load, without waiting for hydration.
 * Mirrors the resolution logic of MUI's InitColorSchemeScript: read the mode,
 * then the per-mode colour-scheme override, then look up the colour.
 * Nothing here follows the OS setting and legacy `oc-theme-mode` storage is
 * never read.
 */
const themeColorInitScript = `
(function () {
  try {
    var mode = localStorage.getItem(${JSON.stringify(THEME_MODE_STORAGE_KEY)}) || ${JSON.stringify(DEFAULT_MODE)};
    var colors = ${JSON.stringify(THEME_COLOR_BY_SCHEME)};
    var scheme;
    if (mode === "light") {
      scheme = localStorage.getItem(${JSON.stringify(THEME_COLOR_SCHEME_STORAGE_KEY)} + "-light") || "light";
    } else {
      scheme = localStorage.getItem(${JSON.stringify(THEME_COLOR_SCHEME_STORAGE_KEY)} + "-dark") || "dark";
    }
    var color = colors[scheme] || ${JSON.stringify(DEFAULT_THEME_COLOR)};
    var metas = document.querySelectorAll('meta[name="theme-color"]');
    metas.forEach(function (meta) {
      meta.setAttribute("content", color);
    });
  } catch (e) {}
})();
`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <InitColorSchemeScript
          attribute="class"
          defaultMode={DEFAULT_MODE}
          modeStorageKey={THEME_MODE_STORAGE_KEY}
          colorSchemeStorageKey={THEME_COLOR_SCHEME_STORAGE_KEY}
        />
        <script dangerouslySetInnerHTML={{ __html: themeColorInitScript }} />
        <AppRouterCacheProvider options={{ key: "mui" }}>
          <Providers>{children}</Providers>
        </AppRouterCacheProvider>
        <RegisterServiceWorker />
      </body>
    </html>
  );
}
