import { requireAuth } from "@/lib/api-auth";
import { opencode } from "@/lib/opencode";

export const dynamic = "force-dynamic";

async function getSessionAgentState(sessionID: string) {
  const session = await opencode.session.get({ sessionID });
  const result = await opencode.agent.list({
    location: { directory: session.location.directory },
  });
  const agents = result.data
    .filter((agent) => !agent.hidden && agent.mode !== "subagent")
    .map((agent) => ({
      id: agent.id,
      name: agent.name,
      description: agent.description ?? "",
      mode: agent.mode,
      model: agent.model ?? null,
    }));

  return {
    currentAgent: session.agent ?? "",
    model: session.model ?? null,
    agents,
  };
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth();
  if (!auth) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  try {
    return Response.json(await getSessionAgentState(id));
  } catch (err) {
    console.error("opencode agent state failed:", err);
    return Response.json({ error: "OpenCode request failed" }, { status: 502 });
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth();
  if (!auth) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  let body: { agentId?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body.agentId !== "string" || body.agentId.trim() === "") {
    return Response.json({ error: "Missing agent ID" }, { status: 400 });
  }

  try {
    const session = await opencode.session.get({ sessionID: id });
    const result = await opencode.agent.list({
      location: { directory: session.location.directory },
    });
    const agent = result.data.find(
      (candidate) =>
        candidate.id === body.agentId &&
        !candidate.hidden &&
        candidate.mode !== "subagent",
    );
    if (!agent) {
      return Response.json(
        { error: "That agent is not available for this session." },
        { status: 400 },
      );
    }

    await opencode.session.switchAgent({ sessionID: id, agent: agent.id });
    if (
      agent.model &&
      (agent.model.id !== session.model?.id ||
        agent.model.providerID !== session.model.providerID ||
        agent.model.variant !== session.model.variant)
    ) {
      try {
        await opencode.session.switchModel({ sessionID: id, model: agent.model });
      } catch (err) {
        console.error("opencode agent model switch failed:", err);
        return Response.json(
          {
            error: `Switched to ${agent.name}, but its configured model could not be selected.`,
            partial: true,
          },
          { status: 502 },
        );
      }
    }

    return Response.json(await getSessionAgentState(id));
  } catch (err) {
    console.error("opencode agent switch failed:", err);
    return Response.json({ error: "OpenCode request failed" }, { status: 502 });
  }
}
