import "server-only";
import { opencode } from "./opencode";
export { listMentionCandidates, resolvePromptFiles } from "./mention-catalog";

export async function getSessionLocation(sessionID: string) {
  const session = await opencode.session.get({ sessionID });
  return session.location;
}
