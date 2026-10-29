import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  prompt: vi.fn(),
  getSessionLocation: vi.fn(),
  resolvePromptFiles: vi.fn(),
}));

vi.mock("@/lib/api-auth", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/lib/opencode", () => ({
  opencode: { session: { prompt: mocks.prompt } },
}));
vi.mock("@/lib/session-mentions", () => ({
  getSessionLocation: mocks.getSessionLocation,
  resolvePromptFiles: mocks.resolvePromptFiles,
}));

import { POST } from "../app/api/sessions/[id]/prompt/route";

const params = Promise.resolve({ id: "session-1" });

describe("prompt route mention payload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuth.mockResolvedValue({ user: { id: "test-user" } });
    mocks.getSessionLocation.mockResolvedValue({ directory: "/project" });
    mocks.resolvePromptFiles.mockResolvedValue([
      {
        uri: "file:///project/src/main.ts",
        name: "main.ts",
        mention: { start: 5, end: 14, text: "@src/main" },
      },
    ]);
    mocks.prompt.mockResolvedValue({ data: {} });
  });

  it("re-resolves and forwards structured files with mention metadata", async () => {
    const response = await POST(
      new Request("http://localhost/api/sessions/session-1/prompt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: "Read @src/main",
          attachments: [{
            descriptor: { kind: "file", path: "src/main" },
            mention: { start: 5, end: 14, text: "@src/main" },
          }],
          clientMessageID: "client-1",
        }),
      }),
      { params },
    );

    expect(response.status).toBe(200);
    expect(mocks.getSessionLocation).toHaveBeenCalledWith("session-1");
    expect(mocks.resolvePromptFiles).toHaveBeenCalledWith(
      expect.anything(),
      { directory: "/project" },
      [{ descriptor: { kind: "file", path: "src/main" }, mention: { start: 5, end: 14, text: "@src/main" } }],
    );
    expect(mocks.prompt).toHaveBeenCalledWith({
      sessionID: "session-1",
      text: "Read @src/main",
      files: [{ uri: "file:///project/src/main.ts", name: "main.ts", mention: { start: 5, end: 14, text: "@src/main" } }],
      metadata: { opencodeClientMessageID: "client-1" },
    });
  });

  it("rejects forged hidden or traversal paths before sending", async () => {
    const response = await POST(
      new Request("http://localhost/api/sessions/session-1/prompt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: "Read @src/.secret",
          attachments: [{
            descriptor: { kind: "file", path: "src/.secret" },
            mention: { start: 5, end: 17, text: "@src/.secret" },
          }],
        }),
      }),
      { params },
    );

    expect(response.status).toBe(400);
    expect(mocks.getSessionLocation).not.toHaveBeenCalled();
    expect(mocks.prompt).not.toHaveBeenCalled();
  });
});
