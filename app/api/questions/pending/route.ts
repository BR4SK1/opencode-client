import { requireAuth } from "@/lib/api-auth";
import { opencodeRequest } from "@/lib/opencode";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await requireAuth();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const response = await opencodeRequest("/api/question/request");
    if (!response.ok) {
      return Response.json({ error: "Could not load pending questions" }, { status: response.status });
    }
    const payload = (await response.json()) as { data?: unknown };
    return Response.json({ questions: Array.isArray(payload.data) ? payload.data : [] });
  } catch (err) {
    console.error("opencode pending question list failed:", err);
    return Response.json({ error: "OpenCode request failed" }, { status: 502 });
  }
}
