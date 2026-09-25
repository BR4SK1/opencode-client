import { requireAuth } from "@/lib/api-auth";
import { opencode } from "@/lib/opencode";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth();
  if (!auth) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  try {
    const forms = await opencode.session.form.list({ sessionID: id });
    return Response.json({ forms });
  } catch (err) {
    console.error("opencode form list failed:", err);
    return Response.json({ error: "OpenCode request failed" }, { status: 502 });
  }
}
