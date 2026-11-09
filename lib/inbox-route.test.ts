import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  inboxList: vi.fn(),
}));

vi.mock("@/lib/api-auth", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/lib/opencode", () => ({
  opencode: { session: { inbox: { list: mocks.inboxList } } },
}));

import { GET } from "../app/api/sessions/[id]/inbox/route";

const params = Promise.resolve({ id: "session-1" });

describe("session inbox reconciliation route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuth.mockResolvedValue({ user: { id: "test-user" } });
    mocks.inboxList.mockResolvedValue([{
      id: "inbox-1",
      sessionID: "session-1",
      type: "user",
      delivery: "queue",
      time: { created: 123 },
      payload: {
        text: "[image1]",
        files: [{ mime: "image/png", data: "iVBORw0KGgo=", source: { type: "inline" } }],
        metadata: { opencodeClientMessageID: "client-1" },
      },
    }]);
  });

  it("returns pending inbox items through the authenticated session endpoint", async () => {
    const response = await GET(new Request("http://localhost/api/sessions/session-1/inbox"), { params });
    expect(response.status).toBe(200);
    expect(mocks.inboxList).toHaveBeenCalledWith({ sessionID: "session-1" });
    expect((await response.json()).items[0]).toMatchObject({
      id: "inbox-1",
      type: "user",
      payload: { text: "[image1]", metadata: { opencodeClientMessageID: "client-1" } },
    });
  });

  it("does not query the server when unauthenticated", async () => {
    mocks.requireAuth.mockResolvedValue(null);
    const response = await GET(new Request("http://localhost/api/sessions/session-1/inbox"), { params });
    expect(response.status).toBe(401);
    expect(mocks.inboxList).not.toHaveBeenCalled();
  });
});
