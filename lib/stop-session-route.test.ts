import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  getSession: vi.fn(),
  log: vi.fn(),
  shellList: vi.fn(),
  interrupt: vi.fn(),
  shellRemove: vi.fn(),
}));

vi.mock("@/lib/api-auth", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/lib/opencode", () => ({
  opencode: {
    session: {
      get: mocks.getSession,
      log: mocks.log,
      interrupt: mocks.interrupt,
    },
    shell: { list: mocks.shellList, remove: mocks.shellRemove },
  },
}));

import { GET, POST } from "../app/api/sessions/[id]/stop/route";

const params = Promise.resolve({ id: "child-session" });

async function* logEvents(events: unknown[]) {
  for (const event of events) yield event as never;
}

const startedEvents = [
  {
    type: "session.shell.started",
    data: { sessionID: "child-session", shell: { id: "owned-shell" } },
  },
  {
    type: "session.shell.started",
    data: { sessionID: "another-session", shell: { id: "other-shell" } },
  },
  {
    type: "session.shell.ended",
    data: { sessionID: "child-session", shell: { id: "already-ended" } },
  },
];

function request(body: unknown) {
  return new Request("http://localhost/api/sessions/child-session/stop", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("session stop route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuth.mockResolvedValue({ user: { id: "test-user" } });
    mocks.getSession.mockResolvedValue({ location: { directory: "/project" } });
    mocks.log.mockImplementation(() => logEvents(startedEvents));
    mocks.shellList.mockResolvedValue({
      data: [
        { id: "owned-shell", status: "running", command: "pnpm test", cwd: "/project" },
        { id: "other-shell", status: "running", command: "unrelated", cwd: "/project" },
        { id: "already-ended", status: "running", command: "old", cwd: "/project" },
        { id: "exited-owned", status: "exited", command: "old", cwd: "/project" },
      ],
    });
    mocks.interrupt.mockResolvedValue({ interrupted: true });
    mocks.shellRemove.mockResolvedValue(undefined);
  });

  it("previews only running shells proven by the selected session's durable log", async () => {
    const response = await GET(new Request("http://localhost"), { params });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      sessionID: "child-session",
      shells: [{ id: "owned-shell", command: "pnpm test", cwd: "/project" }],
      shellDiscovery: "verified",
    });
    expect(mocks.shellList).toHaveBeenCalledWith({ location: { directory: "/project" } });
  });

  it("interrupts only the requested session and revalidates shell ownership before removal", async () => {
    const response = await POST(request({ removeShellIDs: ["owned-shell", "other-shell", "missing"] }), { params });

    expect(response.status).toBe(200);
    expect(mocks.interrupt).toHaveBeenCalledWith({ sessionID: "child-session" });
    expect(mocks.shellRemove).toHaveBeenCalledTimes(1);
    expect(mocks.shellRemove).toHaveBeenCalledWith({
      id: "owned-shell",
      location: { directory: "/project" },
    });
    expect(await response.json()).toMatchObject({
      sessionID: "child-session",
      interrupt: "interrupted",
      removedShells: ["owned-shell"],
      unverifiedShellIDs: ["other-shell", "missing"],
      parentState: "unknown",
    });
  });

  it("interrupts without shell deletion when none are selected", async () => {
    const response = await POST(request({ removeShellIDs: [] }), { params });

    expect(response.status).toBe(200);
    expect(mocks.interrupt).toHaveBeenCalledWith({ sessionID: "child-session" });
    expect(mocks.shellRemove).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({
      interrupt: "interrupted",
      removedShells: [],
      failedShells: [],
      unverifiedShellIDs: [],
    });
  });

  it("reports a stop race without claiming that the session was interrupted", async () => {
    mocks.interrupt.mockResolvedValue({ interrupted: false });
    mocks.shellList.mockResolvedValue({ data: [] });

    const response = await POST(request({ removeShellIDs: ["owned-shell"] }), { params });

    expect(await response.json()).toMatchObject({
      interrupt: "not-running",
      removedShells: [],
      unverifiedShellIDs: ["owned-shell"],
      parentState: "unknown",
    });
    expect(mocks.shellRemove).not.toHaveBeenCalled();
  });

  it("preserves session and shell state when unauthenticated", async () => {
    mocks.requireAuth.mockResolvedValue(null);

    const preview = await GET(new Request("http://localhost"), { params });
    const stopped = await POST(request({ removeShellIDs: [] }), { params });

    expect(preview.status).toBe(401);
    expect(stopped.status).toBe(401);
    expect(mocks.interrupt).not.toHaveBeenCalled();
    expect(mocks.shellRemove).not.toHaveBeenCalled();
  });

  it("rejects malformed requests before interrupting", async () => {
    const response = await POST(request({ removeShellIDs: [1] }), { params });

    expect(response.status).toBe(400);
    expect(mocks.interrupt).not.toHaveBeenCalled();
  });
});
