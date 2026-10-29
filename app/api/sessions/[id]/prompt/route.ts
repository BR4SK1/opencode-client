import { requireAuth } from "@/lib/api-auth";
import { opencode } from "@/lib/opencode";
import { getSessionLocation, resolvePromptFiles } from "@/lib/session-mentions";
import { validatePromptMentions } from "@/lib/prompt-mentions";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireAuth();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  let body: { text?: unknown; clientMessageID?: unknown; attachments?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = validatePromptMentions(body.text, body.attachments ?? []);
  if (!parsed) {
    return Response.json({ error: "Invalid prompt or file mention" }, { status: 400 });
  }
  if (
    body.clientMessageID !== undefined &&
    (typeof body.clientMessageID !== "string" ||
      body.clientMessageID.length === 0 ||
      body.clientMessageID.length > 128)
  ) {
    return Response.json({ error: "Invalid client message ID" }, { status: 400 });
  }

  try {
    const location = await getSessionLocation(id);
    const files = await resolvePromptFiles(opencode, location, parsed.attachments);
    if (!files) {
      return Response.json({ error: "A selected file or reference is no longer available" }, { status: 400 });
    }
    await opencode.session.prompt({
      sessionID: id,
      text: parsed.text,
      ...(files.length > 0 ? { files } : {}),
      ...(body.clientMessageID
        ? {
            metadata: {
              opencodeClientMessageID: body.clientMessageID as string,
            },
          }
        : {}),
    });
  } catch (err) {
    console.error("opencode prompt failed:", err);
    return Response.json({ error: "OpenCode request failed" }, { status: 502 });
  }
  return Response.json({ ok: true });
}
