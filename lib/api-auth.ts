import { auth } from "@/auth";

export async function requireAuth() {
  return (await auth()) ?? null;
}