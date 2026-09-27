import { requireAuth } from "@/lib/api-auth";
import { opencodeRequest } from "@/lib/opencode";

export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string; requestId: string }> },
) {
  const session = await requireAuth();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id, requestId } = await params;
  try {
    const response = await opencodeRequest(
      `/api/session/${encodeURIComponent(id)}/question/${encodeURIComponent(requestId)}/reject`,
      { method: "POST" },
    );
    if (response.status === 204) return new Response(null, { status: 204 });
    const payload = (await response.json().catch(() => ({}))) as { message?: unknown };
    return Response.json(
      { error: typeof payload.message === "string" ? payload.message : "Could not dismiss question" },
      { status: response.status },
    );
  } catch (err) {
    console.error("opencode question reject failed:", err);
    return Response.json({ error: "OpenCode request failed" }, { status: 502 });
  }
}
