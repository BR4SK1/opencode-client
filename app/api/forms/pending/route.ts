import { requireAuth } from "@/lib/api-auth";
import { opencode } from "@/lib/opencode";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await requireAuth();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const result = await opencode.form.list();
    return Response.json({ forms: result.data });
  } catch (err) {
    console.error("opencode pending form list failed:", err);
    return Response.json({ error: "OpenCode request failed" }, { status: 502 });
  }
}
