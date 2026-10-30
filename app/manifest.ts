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
    // Matches the light-mode theme-color in app/layout.tsx; the runtime
    // theme-color <meta> tags override it per theme while the app is running.
    background_color: "#ffffff",
    theme_color: "#ffffff",
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
