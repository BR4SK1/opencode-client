import { describe, expect, it } from "vitest";
import { isAllowedEmail } from "./access-control";

describe("isAllowedEmail", () => {
  const allowedEmails = new Set(["admin@example.com"]);

  it("normalizes the submitted address before matching the allowlist", () => {
    expect(isAllowedEmail("  ADMIN@Example.COM ", allowedEmails, false)).toBe(
      true,
    );
  });

  it("denies missing and unlisted addresses", () => {
    expect(isAllowedEmail(undefined, allowedEmails, false)).toBe(false);
    expect(isAllowedEmail("other@example.com", allowedEmails, false)).toBe(
      false,
    );
  });

  it("allows only the local demo identity when demo mode has no allowlist", () => {
    expect(isAllowedEmail("DEMO@LOCALHOST", new Set(), true)).toBe(true);
    expect(isAllowedEmail("admin@example.com", new Set(), true)).toBe(false);
  });

  it("does not let demo mode bypass a configured allowlist", () => {
    expect(isAllowedEmail("demo@localhost", allowedEmails, true)).toBe(false);
  });
});
