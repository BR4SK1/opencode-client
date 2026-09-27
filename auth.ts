import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";

const oidcConfigured = Boolean(
  process.env.AUTH_OIDC_ISSUER &&
    process.env.AUTH_OIDC_ID &&
    process.env.AUTH_OIDC_SECRET,
);

if (process.env.AUTH_DEMO === "true" && process.env.NODE_ENV === "production") {
  throw new Error(
    "AUTH_DEMO=true is only allowed in local development; refusing to start in production.",
  );
}

export const demoMode: boolean =
  process.env.AUTH_DEMO === "true" &&
  process.env.NODE_ENV !== "production" &&
  !oidcConfigured;

const allowedEmails = new Set(
  (process.env.AUTH_ALLOWED_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean),
);

function isAllowedEmail(email: string | null | undefined): boolean {
  const normalizedEmail = email?.trim().toLowerCase();
  if (!normalizedEmail) return false;

  // Keep the credential-based demo usable only in local development.
  if (demoMode && allowedEmails.size === 0) {
    return normalizedEmail === "demo@localhost";
  }

  return allowedEmails.has(normalizedEmail);
}

const providers = oidcConfigured
  ? [
      {
        id: "oidc",
        name: "OIDC",
        type: "oidc" as const,
        issuer: process.env.AUTH_OIDC_ISSUER,
        clientId: process.env.AUTH_OIDC_ID,
        clientSecret: process.env.AUTH_OIDC_SECRET,
      },
    ]
  : demoMode
    ? [
        Credentials({
          id: "demo",
          name: "Demo",
          credentials: {},
          authorize: () => ({
            id: "demo",
            name: "Local Demo User",
            email: "demo@localhost",
          }),
        }),
      ]
    : [];

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers,
  session: { strategy: "jwt" },
  trustHost: true,
  pages: { signIn: "/signin" },
  callbacks: {
    signIn({ user, profile }) {
      if (!demoMode && profile?.email_verified !== true) return false;
      return isAllowedEmail(user.email);
    },
    jwt({ token }) {
      // Re-check existing JWT sessions on every auth() call so removing an
      // address from the allowlist revokes its access without waiting for the
      // cookie's expiry.
      return isAllowedEmail(token.email) ? token : null;
    },
  },
});
