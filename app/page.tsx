import type { Viewport } from "next";
import { auth } from "@/auth";
import { redirect } from "next/navigation";
import ChatApp from "./components/ChatApp";

/*
 * viewportFit: "cover" is scoped to this chat route only (Next merges segment
 * viewports key-by-key, so the root layout's themeColor and other fields still
 * apply). Rationale: the reported bug is the composer clipped by the iPhone
 * rounded screen edge in the installed PWA when the keyboard is closed, and
 * this page owns that composer. Other routes (e.g. /signin) keep the default
 * viewport, where the system insets the page itself instead of exposing edges.
 *
 * Cover pairs with explicit env(safe-area-inset-*) padding on the app shell
 * and composer; each inset is a no-op wherever it is 0. Actual inset values
 * are device- and context-dependent and have not been verified on a real
 * device.
 */
export const viewport: Viewport = {
  viewportFit: "cover",
};

export default async function Home() {
  const session = await auth();
  if (!session) redirect("/signin");
  return <ChatApp />;
}
