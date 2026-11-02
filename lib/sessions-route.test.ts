import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  create: vi.fn(),
  agentList: vi.fn(),
  sessionList: vi.fn(),
}));

vi.mock("@/lib/api-auth", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/lib/opencode", () => ({
  opencode: {
    session: { create: mocks.create, list: mocks.sessionList },
    agent: { list: mocks.agentList },
  },
}));

import { POST } from "../app/api/sessions/route";

function createdSession(agent: string | undefined) {
  return {
    id: "ses_new",
    title: "New session",
    time: { created: 1000, updated: 1000 },
    ...(agent !== undefined ? { agent } : {}),
    model: null,
  };
}

describe("sessions route new-session default agent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuth.mockResolvedValue({ user: { id: "test-user" } });
    mocks.create.mockResolvedValue(createdSession("cal"));
  });

  it("creates new sessions on the client default agent when selectable", async () => {
    mocks.agentList.mockResolvedValue({
      data: [
        { id: "general", mode: "subagent", hidden: false },
        { id: "cal", mode: "primary", hidden: false },
      ],
    });

    const response = await POST();

    expect(response.status).toBe(201);
    expect(mocks.agentList).toHaveBeenCalledWith({});
    expect(mocks.create).toHaveBeenCalledWith({ agent: "cal" });
    const body = await response.json();
    expect(body.session.agent).toBe("cal");
  });

  it("creates without an agent when the default is absent or hidden", async () => {
    mocks.agentList.mockResolvedValue({
      data: [{ id: "cal", mode: "primary", hidden: true }],
    });
    mocks.create.mockResolvedValue(createdSession(undefined));

    const response = await POST();

    expect(response.status).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith({});
    const body = await response.json();
    expect(body.session.agent).toBe("");
  });

  it("still creates a session when the agent list cannot be read", async () => {
    mocks.agentList.mockRejectedValue(new Error("agent list failed"));
    mocks.create.mockResolvedValue(createdSession(undefined));

    const response = await POST();

    expect(response.status).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith({});
  });

  it("does not create a session when unauthenticated", async () => {
    mocks.requireAuth.mockResolvedValue(null);

    const response = await POST();

    expect(response.status).toBe(401);
    expect(mocks.agentList).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
