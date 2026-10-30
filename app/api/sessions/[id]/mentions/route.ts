import { requireAuth } from "@/lib/api-auth";
import { opencode } from "@/lib/opencode";
import { getSessionLocation, listMentionCandidates } from "@/lib/session-mentions";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireAuth();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const query = new URL(request.url).searchParams.get("q") ?? "";
  if (query.length > 120) return Response.json({ error: "Search is too long" }, { status: 400 });

  try {
    const location = await getSessionLocation(id);
    const candidates = await listMentionCandidates(opencode, location, query);
    return Response.json({ candidates });
  } catch {
    return Response.json({ error: "Unable to search this session's project and references" }, { status: 502 });
  }
}
