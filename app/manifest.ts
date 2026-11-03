import type { MetadataRoute } from "next";

/*
 * Installable web app (PWA) manifest. Static, user-agnostic values only:
 * this route is publicly reachable and must never contain user data.
 *
 * `short_name` is what appears under the icon on a phone home screen, where
 * "opencode-client" would be truncated.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "opencode-client",
    short_name: "opencode",
    description: "Mobile-first chat client for OpenCode",
    start_url: "/",
    scope: "/",
    display: "standalone",
    // Matches the theme-colour of the default theme (Current dark) in
    // app/layout.tsx; the runtime theme-color <meta> tag overrides it per
    // theme while the app is running.
    background_color: "#1E1E1E",
    theme_color: "#1E1E1E",
    icons: [
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
