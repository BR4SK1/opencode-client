import { requireAuth } from "@/lib/api-auth";
import { opencode } from "@/lib/opencode";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireAuth();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const cursor = new URL(request.url).searchParams.get("cursor") || undefined;
  const res = await opencode.message.list({
    sessionID: id,
    limit: 50,
    ...(cursor ? { cursor } : { order: "desc" }),
  });
  return Response.json({
    messages: res.data,
    nextCursor: res.cursor.next ?? null,
  });
}
