import { requireAuth } from "@/lib/api-auth";
import { opencode } from "@/lib/opencode";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; formId: string }> },
) {
  const auth = await requireAuth();
  if (!auth) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id, formId } = await params;
  let body: { answer?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.answer || typeof body.answer !== "object" || Array.isArray(body.answer)) {
    return Response.json({ error: "Answer must be an object" }, { status: 400 });
  }

  try {
    await opencode.session.form.reply({
      sessionID: id,
      formID: formId,
      answer: body.answer as Record<string, string | number | boolean | string[]>,
    });
    return new Response(null, { status: 204 });
  } catch (err) {
    console.error("opencode form reply failed:", err);
    return Response.json({ error: "OpenCode request failed" }, { status: 502 });
  }
}
