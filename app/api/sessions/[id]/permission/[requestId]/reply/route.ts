import { requireAuth } from "@/lib/api-auth";
import { opencode } from "@/lib/opencode";

export const dynamic = "force-dynamic";

const VALID_DECISIONS = ["once", "always", "reject"] as const;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; requestId: string }> },
) {
  const session = await requireAuth();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id, requestId } = await params;
  let body: { decision?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const decision = body.decision;
  if (
    typeof decision !== "string" ||
    !VALID_DECISIONS.includes(decision as (typeof VALID_DECISIONS)[number])
  ) {
    return Response.json(
      { error: 'decision must be one of "once", "always", "reject"' },
      { status: 400 },
    );
  }

  try {
    await opencode.permission.reply({
      sessionID: id,
      requestID: requestId,
      decision: decision as (typeof VALID_DECISIONS)[number],
    });
  } catch (err) {
    console.error("opencode permission reply failed:", err);
    return Response.json({ error: "OpenCode request failed" }, { status: 502 });
  }
  return new Response(null, { status: 204 });
}