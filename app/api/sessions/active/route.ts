import { requireAuth } from "@/lib/api-auth";
import { opencode } from "@/lib/opencode";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await requireAuth();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const active = await opencode.session.active();
  const sessionIDs = Object.entries(active)
    .filter(([, status]) => status.type === "running")
    .map(([id]) => id);

  return Response.json({ sessionIDs });
}
