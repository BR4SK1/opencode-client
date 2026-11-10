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
import { WEB_PROMPT_SKILL_ID } from "./web-prompt-skill";
import { MAX_PROMPT_REQUEST_BYTES } from "./prompt-images";

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
          clientMessageID: "msg_12345678-1234-1234-1234-123456789abc",
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
      id: "msg_12345678-1234-1234-1234-123456789abc",
      text: "Read @src/main",
      skills: [{ id: WEB_PROMPT_SKILL_ID }],
      files: [{ uri: "file:///project/src/main.ts", name: "main.ts", mention: { start: 5, end: 14, text: "@src/main" } }],
      metadata: {
        opencodeClientMessageID: "msg_12345678-1234-1234-1234-123456789abc",
        opencodeClientOriginalText: "Read @src/main",
      },
    });
  });

  it("attaches the prompt-local skill without changing text, Unicode mention offsets, or optional metadata", async () => {
    const text = "A😀 @src/main";
    const attachment = {
      descriptor: { kind: "file", path: "src/main" },
      mention: { start: 4, end: 13, text: "@src/main" },
    };
    const resolvedFile = {
      uri: "file:///project/src/main.ts",
      name: "main.ts",
      mention: attachment.mention,
    };
    mocks.resolvePromptFiles.mockResolvedValue([resolvedFile]);

    const response = await POST(
      new Request("http://localhost/api/sessions/session-1/prompt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, attachments: [attachment] }),
      }),
      { params },
    );

    expect(response.status).toBe(200);
    expect(mocks.resolvePromptFiles).toHaveBeenCalledWith(
      expect.anything(),
      { directory: "/project" },
      [attachment],
    );
    expect(mocks.prompt).toHaveBeenCalledWith({
      sessionID: "session-1",
      text,
      skills: [{ id: WEB_PROMPT_SKILL_ID }],
      files: [resolvedFile],
    });
    expect(mocks.prompt.mock.calls[0]?.[0]).not.toHaveProperty("metadata");
  });

  it("keeps original authored text in sideband metadata without altering model input or attaching skill text", async () => {
    const text = "Please review this exact request: 😀\\nkeep the user's wording intact.";
    const clientMessageID = "msg_abcdef12-3456-7890-abcd-ef1234567890";
    const response = await POST(
      new Request("http://localhost/api/sessions/session-1/prompt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, clientMessageID }),
      }),
      { params },
    );

    expect(response.status).toBe(200);
    expect(mocks.prompt).toHaveBeenCalledWith({
      sessionID: "session-1",
      id: clientMessageID,
      text,
      skills: [{ id: WEB_PROMPT_SKILL_ID }],
      files: [{ uri: "file:///project/src/main.ts", name: "main.ts", mention: { start: 5, end: 14, text: "@src/main" } }],
      metadata: {
        opencodeClientMessageID: clientMessageID,
        opencodeClientOriginalText: text,
      },
    });
    const prompt = mocks.prompt.mock.calls[0]?.[0];
    expect(prompt.text).toBe(text);
    expect(prompt.metadata.opencodeClientOriginalText).toBe(text);
    expect(JSON.stringify(prompt.skills)).not.toContain(text);
  });

  it("rejects invalid prompt text and client message IDs before sending", async () => {
    for (const body of [
      { text: "  " },
      { text: "Valid prompt", clientMessageID: "" },
      { text: "Valid prompt", clientMessageID: "x".repeat(129) },
    ]) {
      const response = await POST(
        new Request("http://localhost/api/sessions/session-1/prompt", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        { params },
      );

      expect(response.status).toBe(400);
    }

    expect(mocks.getSessionLocation).not.toHaveBeenCalled();
    expect(mocks.prompt).not.toHaveBeenCalled();
  });

  it("forwards validated image data as an inline OpenCode file in prompt order", async () => {
    mocks.resolvePromptFiles.mockResolvedValue([]);
    const response = await POST(
      new Request("http://localhost/api/sessions/session-1/prompt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: "A😀 [image1]",
          clientMessageID: "msg_abcdef12-3456-7890-abcd-ef1234567890",
          images: [{
            data: "iVBORw0KGgo=",
            mime: "image/png",
            name: "../screen.png",
            mention: { start: 4, end: 12, text: "[image1]" },
          }],
        }),
      }),
      { params },
    );

    expect(response.status).toBe(200);
    expect(mocks.prompt).toHaveBeenCalledWith({
      sessionID: "session-1",
      text: "A😀 [image1]",
      skills: [{ id: WEB_PROMPT_SKILL_ID }],
      files: [{
        uri: "data:image/png;base64,iVBORw0KGgo=",
        name: ".._screen.png",
        mention: { start: 4, end: 12, text: "[image1]" },
      }],
      id: "msg_abcdef12-3456-7890-abcd-ef1234567890",
      metadata: {
        opencodeClientMessageID: "msg_abcdef12-3456-7890-abcd-ef1234567890",
        opencodeClientOriginalText: "A😀 [image1]",
      },
    });
  });

  it("rejects arbitrary client image URIs and malformed image bytes before contacting OpenCode", async () => {
    for (const image of [
      { uri: "https://example.invalid/image.png", mime: "image/png", mention: { start: 0, end: 8, text: "[image1]" } },
      { data: "AA==", mime: "image/png", mention: { start: 0, end: 8, text: "[image1]" } },
    ]) {
      const response = await POST(
        new Request("http://localhost/api/sessions/session-1/prompt", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "[image1]", images: [image] }),
        }),
        { params },
      );
      expect(response.status).toBe(400);
    }
    expect(mocks.getSessionLocation).not.toHaveBeenCalled();
    expect(mocks.prompt).not.toHaveBeenCalled();
  });

  it("bounds the raw authenticated prompt request body", async () => {
    const response = await POST(
      new Request("http://localhost/api/sessions/session-1/prompt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: `{"text":"${"x".repeat(MAX_PROMPT_REQUEST_BYTES)}"}`,
      }),
      { params },
    );
    expect(response.status).toBe(413);
    expect((await response.json()).error).toContain("9 MiB encoded limit");
    expect(mocks.prompt).not.toHaveBeenCalled();
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
