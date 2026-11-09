/** Context shown on prompts delivered through the authenticated web prompt route. */
export const WEB_PROMPT_CONTEXT_SUFFIX =
  "\n\n[Context: This prompt was sent via web; the user has no terminal here but may resume in a server terminal.]";

/** Append the visible web-client context without changing prior text or offsets. */
export function appendWebPromptContext(text: string): string {
  return text.endsWith(WEB_PROMPT_CONTEXT_SUFFIX)
    ? text
    : `${text}${WEB_PROMPT_CONTEXT_SUFFIX}`;
}
