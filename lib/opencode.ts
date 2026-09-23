import "server-only";
import { OpenCode } from "@opencode/client";

const baseUrl = process.env.OPENCODE_BASE_URL ?? "http://localhost:4096";

const headers: Record<string, string> = {};
if (process.env.OPENCODE_TOKEN) {
  headers.Authorization = process.env.OPENCODE_TOKEN;
}

export const opencode = OpenCode.make({ baseUrl, headers });