import { requireAuth } from "@/lib/api-auth";
import { opencode } from "@/lib/opencode";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireAuth();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  let body: { text?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.text || typeof body.text !== "string" || body.text.trim() === "") {
    return Response.json({ error: "Missing or empty text" }, { status: 400 });
  }

  try {
    await opencode.session.prompt({ sessionID: id, text: body.text });
  } catch (err) {
    console.error("opencode prompt failed:", err);
    return Response.json({ error: "OpenCode request failed" }, { status: 502 });
  }
  return Response.json({ ok: true });
}