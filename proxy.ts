export { auth as proxy } from "@/auth";

// Static PWA assets (app-icon routes, manifest, service worker, offline
// fallback page) carry no user data and must be reachable without a session,
// e.g. so the browser can evaluate installability and precache the offline
// page on the sign-in screen. Tokens for those assets are regex-escaped and
// end-bounded ( (?=\?|$) ) so only the exact asset path is exempt — lookalike
// paths such as /icon.png2 or /swXjs still run the proxy. `icons/` scopes the
// pre-existing public-icons exemption to real subpaths.
export const config = {
  matcher: [
    "/((?!api/auth|signin|_next/static|_next/image|favicon\\.ico|icons/|icon\\.png(?=\\?|$)|apple-icon\\.png(?=\\?|$)|manifest\\.webmanifest(?=\\?|$)|sw\\.js(?=\\?|$)|offline\\.html(?=\\?|$)).*)",
  ],
};