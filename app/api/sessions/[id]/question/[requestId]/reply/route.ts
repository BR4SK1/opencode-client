import { requireAuth } from "@/lib/api-auth";
import { opencodeRequest } from "@/lib/opencode";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; requestId: string }> },
) {
  const session = await requireAuth();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id, requestId } = await params;
  let body: { answers?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (
    !Array.isArray(body.answers) ||
    body.answers.some(
      (answer) => !Array.isArray(answer) || answer.some((value) => typeof value !== "string"),
    )
  ) {
    return Response.json({ error: "Answers must be an array of string arrays" }, { status: 400 });
  }

  try {
    const response = await opencodeRequest(
      `/api/session/${encodeURIComponent(id)}/question/${encodeURIComponent(requestId)}/reply`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answers: body.answers }),
      },
    );
    if (response.status === 204) return new Response(null, { status: 204 });
    const payload = (await response.json().catch(() => ({}))) as { message?: unknown };
    return Response.json(
      { error: typeof payload.message === "string" ? payload.message : "Could not submit answers" },
      { status: response.status },
    );
  } catch (err) {
    console.error("opencode question reply failed:", err);
    return Response.json({ error: "OpenCode request failed" }, { status: 502 });
  }
}
