import type { Metadata, Viewport } from "next";
import InitColorSchemeScript from "@mui/material/InitColorSchemeScript";
import { AppRouterCacheProvider } from "@mui/material-nextjs/v16-appRouter";
import Providers from "./providers";

export const metadata: Metadata = {
  title: "opencode-client",
  description: "Mobile-first chat client for OpenCode",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  interactiveWidget: "resizes-content",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#1E1E1E" },
  ],
};

/*
 * Applies the persisted theme-color immediately (before paint) so the mobile
 * browser chrome matches on first load, without waiting for hydration.
 * Mirrors the logic in ThemeColorSync.
 */
const themeColorInitScript = `
(function () {
  try {
    var stored = localStorage.getItem("oc-theme-mode");
    var dark =
      stored === "dark" ||
      ((stored === null || stored === "system") &&
        window.matchMedia("(prefers-color-scheme: dark)").matches);
    var color = dark ? "#1E1E1E" : "#ffffff";
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
          defaultMode="system"
          modeStorageKey="oc-theme-mode"
        />
        <script dangerouslySetInnerHTML={{ __html: themeColorInitScript }} />
        <AppRouterCacheProvider options={{ key: "mui" }}>
          <Providers>{children}</Providers>
        </AppRouterCacheProvider>
      </body>
    </html>
  );
}
