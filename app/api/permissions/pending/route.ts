import { requireAuth } from "@/lib/api-auth";
import { opencode } from "@/lib/opencode";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await requireAuth();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const res = await opencode.permission.request.list();
  return Response.json({
    pending: res.data.map((p) => ({
      id: p.id,
      sessionID: p.sessionID,
      action: p.action,
      resources: p.resources ?? [],
      save: p.save,
      message: p.message,
    })),
  });
}
