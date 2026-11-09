import { requireAuth } from "@/lib/api-auth";
import { opencode } from "@/lib/opencode";
import { getSessionLocation, resolvePromptFiles } from "@/lib/session-mentions";
import { validatePromptMentions } from "@/lib/prompt-mentions";
import { appendWebPromptContext } from "@/lib/prompt-context";
import { readBoundedRequestText, RequestBodyTooLargeError } from "@/lib/bounded-request";
import {
  MAX_PROMPT_REQUEST_BYTES,
  validatePromptImages,
} from "@/lib/prompt-images";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireAuth();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  let body: { text?: unknown; clientMessageID?: unknown; attachments?: unknown; images?: unknown };
  try {
    const decoded: unknown = JSON.parse(await readBoundedRequestText(request, MAX_PROMPT_REQUEST_BYTES));
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    body = decoded as typeof body;
  } catch (err) {
    if (err instanceof RequestBodyTooLargeError) {
      return Response.json(
        { error: "Prompt request exceeds the 9 MiB encoded limit. Reduce image data or prompt/references; images may be up to 4 MiB each and 6 MiB combined." },
        { status: 413 },
      );
    }
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = validatePromptMentions(body.text, body.attachments ?? []);
  if (!parsed) {
    return Response.json({ error: "Invalid prompt or file mention" }, { status: 400 });
  }
  const images = validatePromptImages(parsed.text, body.images ?? []);
  if (!images) {
    return Response.json(
      { error: "Invalid image attachment. Use PNG, JPEG, or WebP images up to 4 MiB each and 6 MiB total, with matching [imageN] tags." },
      { status: 400 },
    );
  }
  if (
    body.clientMessageID !== undefined &&
    (typeof body.clientMessageID !== "string" ||
      !/^msg_[0-9a-f-]{36}$/u.test(body.clientMessageID))
  ) {
    return Response.json({ error: "Invalid client message ID" }, { status: 400 });
  }

  try {
    const location = await getSessionLocation(id);
    const resolvedFiles = await resolvePromptFiles(opencode, location, parsed.attachments);
    if (!resolvedFiles) {
      return Response.json({ error: "A selected file or reference is no longer available" }, { status: 400 });
    }
    const imageFiles = images.map((image) => ({
      uri: `data:${image.mime};base64,${image.data}`,
      name: image.name,
      mention: image.mention,
    }));
    const files = [...resolvedFiles, ...imageFiles].sort(
      (a, b) => (a.mention?.start ?? Number.MAX_SAFE_INTEGER) - (b.mention?.start ?? Number.MAX_SAFE_INTEGER),
    );
    await opencode.session.prompt({
      sessionID: id,
      // OpenCode's durable inbox reconciles retries by this stable message ID.
      ...(body.clientMessageID ? { id: body.clientMessageID as string } : {}),
      text: appendWebPromptContext(parsed.text),
      ...(files.length > 0 ? { files } : {}),
      ...(body.clientMessageID
        ? {
            metadata: {
              opencodeClientMessageID: body.clientMessageID as string,
            },
          }
        : {}),
    });
    return Response.json({ ok: true });
  } catch (err) {
    console.error("opencode prompt failed:", err);
    return Response.json({ error: "OpenCode request failed" }, { status: 502 });
  }
}
