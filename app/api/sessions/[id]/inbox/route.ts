import { requireAuth } from "@/lib/api-auth";
import { opencode } from "@/lib/opencode";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireAuth();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  try {
    const items = await opencode.session.inbox.list({ sessionID: id });
    return Response.json({ items });
  } catch (err) {
    console.error("opencode inbox list failed:", err);
    return Response.json({ error: "Unable to reconcile queued messages" }, { status: 502 });
  }
}
