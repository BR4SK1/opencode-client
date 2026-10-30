/** Return whether an address passes the configured sign-in allowlist. */
export function isAllowedEmail(
  email: string | null | undefined,
  allowedEmails: ReadonlySet<string>,
  localDemoMode: boolean,
): boolean {
  const normalizedEmail = email?.trim().toLowerCase();
  if (!normalizedEmail) return false;

  // The demo identity is usable only in local demo mode with no remote allowlist.
  if (localDemoMode && allowedEmails.size === 0) {
    return normalizedEmail === "demo@localhost";
  }

  return allowedEmails.has(normalizedEmail);
}
