import { requireAuth } from "@/lib/api-auth";
import { opencode } from "@/lib/opencode";
import { pickDefaultAgent } from "@/lib/default-agent";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await requireAuth();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  // The server pages results (default limit 50), so loop until a page comes
  // back empty or the cursor is exhausted. After a full page cursor.next may
  // still be truthy; the next page then returns 0 items with cursor.next
  // falsy. Cap at 50 iterations as a safety net.
  const all: Awaited<ReturnType<typeof opencode.session.list>>["data"] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 50; i++) {
    const res = await opencode.session.list({ limit: 200, cursor });
    all.push(...res.data);
    if (res.data.length === 0 || !res.cursor.next) break;
    cursor = res.cursor.next;
  }

  return Response.json({
    sessions: all.map((s) => ({
      id: s.id,
      title: s.title ?? "",
      created: s.time.created,
      updated: s.time.updated,
      agent: s.agent ?? "",
      model: s.model ?? null,
      ...(s.parentID ? { parentID: s.parentID } : {}),
    })),
  });
}

export async function POST() {
  const session = await requireAuth();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  // New sessions start on this client's default agent when it is selectable in
  // the server's default location (where client-created sessions live). When
  // it is unavailable or the list cannot be read, create without an agent so
  // new chat never breaks; the server then applies its own configured default
  // at prompt time.
  const agentList = await opencode.agent.list({}).catch(() => null);
  const defaultAgent = pickDefaultAgent(agentList?.data);
  const created = await opencode.session.create(
    defaultAgent ? { agent: defaultAgent } : {},
  );
  return Response.json(
    {
      session: {
        id: created.id,
        title: created.title ?? "",
        created: created.time.created,
        updated: created.time.updated,
        agent: created.agent ?? "",
        model: created.model ?? null,
      },
    },
    { status: 201 },
  );
}
