import { requireAuth } from "@/lib/api-auth";
import { opencode } from "@/lib/opencode";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await requireAuth();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const res = await opencode.session.list();
  return Response.json({
    sessions: res.data.map((s) => ({
      id: s.id,
      title: s.title ?? "",
      created: s.time.created,
      updated: s.time.updated,
    })),
  });
}

export async function POST() {
  const session = await requireAuth();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const created = await opencode.session.create({});
  return Response.json(
    {
      session: {
        id: created.id,
        title: created.title ?? "",
        created: created.time.created,
        updated: created.time.updated,
      },
    },
    { status: 201 },
  );
}