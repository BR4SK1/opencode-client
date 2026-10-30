import type { ModelRef } from "@opencode/client";
import { requireAuth } from "@/lib/api-auth";
import { opencode } from "@/lib/opencode";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth();
  if (!auth) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  let body: { model?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const value = body.model;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return Response.json({ error: "Missing model" }, { status: 400 });
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.id !== "string" ||
    !candidate.id.trim() ||
    typeof candidate.providerID !== "string" ||
    !candidate.providerID.trim() ||
    (candidate.variant !== undefined && typeof candidate.variant !== "string")
  ) {
    return Response.json({ error: "Invalid model reference" }, { status: 400 });
  }
  const model: ModelRef = {
    id: candidate.id,
    providerID: candidate.providerID,
    ...(candidate.variant ? { variant: candidate.variant } : {}),
  };

  try {
    const session = await opencode.session.get({ sessionID: id });
    const result = await opencode.model.list({
      location: { directory: session.location.directory },
    });
    const available = result.data.find(
      (option) =>
        option.id === model.id &&
        option.providerID === model.providerID &&
        option.enabled,
    );
    if (
      !available ||
      (model.variant && !available.variants.some((variant) => variant.id === model.variant))
    ) {
      return Response.json(
        { error: "That model is not available for this session." },
        { status: 400 },
      );
    }

    await opencode.session.switchModel({ sessionID: id, model });
    const updated = await opencode.session.get({ sessionID: id });
    return Response.json({ model: updated.model ?? null });
  } catch (err) {
    console.error("opencode model switch failed:", err);
    return Response.json({ error: "OpenCode model switch failed" }, { status: 502 });
  }
}
