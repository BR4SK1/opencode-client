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
});
