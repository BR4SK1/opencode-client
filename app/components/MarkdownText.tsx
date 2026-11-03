"use client";

import { isValidElement, memo, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import Box from "@mui/material/Box";
import Divider from "@mui/material/Divider";
import Typography from "@mui/material/Typography";
import { CodeBlock, InlineCode } from "./CodeBlock";

/*
 * Safe Markdown rendering for assistant responses.
 *
 * Each assistant text part is parsed as ONE Markdown document:
 *
 * - react-markdown parses the source into its own element tree and renders
 *   React components; raw HTML in the source is rendered as escaped literal
 *   text (inert and visible, never parsed as markup — no `rehype-raw`), so
 *   assistant output can never inject markup.
 * - URLs go through react-markdown's `defaultUrlTransform` (only http, https,
 *   irc(s), mailto, xmpp and relative targets survive; `javascript:`/`data:`
 *   become empty), and the `a` override additionally refuses to render an
 *   anchor without a usable href. External links open in a new tab; relative
 *   and fragment links stay in the current tab.
 * - Images are never rendered (no third-party fetches, and no React 19
 *   preload link either, since no <img> element is created); the alt text is
 *   shown instead.
 * - Fenced code blocks — at any nesting depth (lists, blockquotes) and with
 *   any fence width — are rendered by the existing CodeBlock (highlight.js
 *   tokens + copy button, scheme-aware palette); inline code reuses
 *   InlineCode.
 *
 * Streaming: the whole (possibly unfinished) part is one document, so an
 * unclosed fence simply runs to the end of the source and still renders as a
 * code block. The caller appends the caret character to the source, so the
 * caret sits exactly at the typing position — including inside a streaming
 * code block.
 */

/* Module-scope so the plugin list identity is stable across renders. */
const remarkPlugins = [remarkGfm];

const paragraphSx = {
  my: 0.5,
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
  lineHeight: 1.6,
} as const;

function heading(variant: "h5" | "h6" | "subtitle1" | "subtitle2") {
  return function Heading({ children }: { children?: ReactNode }) {
    return (
      <Typography
        variant={variant}
        sx={{
          mt: 1.5,
          mb: 0.5,
          lineHeight: 1.35,
          overflowWrap: "anywhere",
        }}
      >
        {children}
      </Typography>
    );
  };
}

/*
 * Extracts the class name and raw text from the default-rendered <code>
 * element that react-markdown passes as the `pre` component's child, so
 * fenced blocks can be handed to CodeBlock unchanged.
 */
function codeElementProps(children: ReactNode): {
  className?: string;
  text: string;
} {
  const element = Array.isArray(children) ? children[0] : children;
  if (!isValidElement(element)) return { text: "" };
  const props = element.props as { className?: unknown; children?: unknown };
  const className =
    typeof props.className === "string" ? props.className : undefined;
  const raw = props.children;
  const text = Array.isArray(raw) ? raw.map(String).join("\n") : String(raw ?? "");
  return { className, text };
}

/* Only schemes the app is willing to open externally; belt-and-braces on top
 * of the library's default URL transform. Any other scheme (javascript:,
 * data:, vbscript:, …) renders as plain text instead of a link. */
const EXTERNAL_SCHEME = /^(https?|ircs?|mailto|xmpp):/i;
/* Any URI scheme at all — used to tell absolute links (open in a new tab)
 * from relative and fragment links (same tab). */
const HAS_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

const components: Components = {
  p: ({ children }) => (
    <Typography variant="body1" sx={paragraphSx}>
      {children}
    </Typography>
  ),
  h1: heading("h5"),
  h2: heading("h6"),
  h3: heading("subtitle1"),
  h4: heading("subtitle2"),
  h5: heading("subtitle2"),
  h6: heading("subtitle2"),
  /* The block <code> child is replaced by CodeBlock; inline code falls
   * through to the `code` override below. */
  pre: ({ children }) => {
    const { className, text } = codeElementProps(children);
    const lang = className?.startsWith("language-")
      ? className.slice("language-".length)
      : undefined;
    return <CodeBlock code={text.replace(/\n$/, "")} lang={lang} />;
  },
  code: ({ children }) => <InlineCode>{children}</InlineCode>,
  a: ({ children, href }) => {
    if (!href) return <Box component="span">{children}</Box>;
    if (HAS_SCHEME.test(href)) {
      if (!EXTERNAL_SCHEME.test(href)) {
        /* Neutralised scheme (javascript:, data:, …): render as text. */
        return <Box component="span">{children}</Box>;
      }
      return (
        <Box
          component="a"
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          sx={{
            color: "primary.main",
            textDecoration: "underline",
            overflowWrap: "anywhere",
          }}
        >
          {children}
        </Box>
      );
    }
    /* Relative (./doc.md, ../x) and fragment (#anchor) links: same tab,
     * no forced new window. */
    return (
      <Box
        component="a"
        href={href}
        sx={{
          color: "primary.main",
          textDecoration: "underline",
          overflowWrap: "anywhere",
        }}
      >
        {children}
      </Box>
    );
  },
  blockquote: ({ children }) => (
    <Box
      component="blockquote"
      sx={{
        m: 0,
        my: 0.75,
        pl: 1.25,
        borderLeft: 3,
        borderColor: "divider",
        color: "text.secondary",
        "& p": { my: 0.5 },
      }}
    >
      {children}
    </Box>
  ),
  ul: ({ children }) => (
    <Box
      component="ul"
      sx={{ my: 0.75, pl: "1.25em", "& ul, & ol": { my: 0.25 } }}
    >
      {children}
    </Box>
  ),
  ol: ({ children, start }) => (
    <Box
      component="ol"
      start={start}
      sx={{ my: 0.75, pl: "1.25em", "& ul, & ol": { my: 0.25 } }}
    >
      {children}
    </Box>
  ),
  li: ({ children, className }) => (
    <Box
      component="li"
      className={className}
      sx={{
        my: 0.25,
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
        ...(typeof className === "string" &&
        className.includes("task-list-item")
          ? { listStyle: "none" }
          : {}),
      }}
    >
      {children}
    </Box>
  ),
  /* No remote images: the assistant cannot make visitors fetch third-party
   * URLs; the alt text conveys the content instead. */
  img: ({ alt }) => (
    <Typography component="span" variant="caption" sx={{ color: "text.secondary" }}>
      {alt ? `[image: ${alt}]` : "[image]"}
    </Typography>
  ),
  table: ({ children }) => (
    <Box sx={{ overflowX: "auto", my: 0.75 }}>
      <Box
        component="table"
        sx={{
          borderCollapse: "collapse",
          border: 1,
          borderColor: "divider",
          fontSize: "0.95em",
        }}
      >
        {children}
      </Box>
    </Box>
  ),
  th: ({ children }) => (
    <Box
      component="th"
      sx={{
        border: 1,
        borderColor: "divider",
        px: 0.75,
        py: 0.5,
        textAlign: "left",
        fontWeight: 700,
        bgcolor: "action.selected",
      }}
    >
      {children}
    </Box>
  ),
  td: ({ children }) => (
    <Box
      component="td"
      sx={{ border: 1, borderColor: "divider", px: 0.75, py: 0.5, verticalAlign: "top" }}
    >
      {children}
    </Box>
  ),
  hr: () => <Divider sx={{ my: 1 }} />,
};

function MarkdownTextBase({
  text,
  caret = false,
}: {
  text: string;
  caret?: boolean;
}) {
  const source = caret ? `${text}▍` : text;
  /* Margin resets for the first/last block live in the app-wide GlobalStyles
   * (providers.tsx, scoped to .oc-md) — emotion would warn about the
   * :first-child/:last-child pseudo-classes during server rendering. */
  return (
    <Box className="oc-md">
      <ReactMarkdown remarkPlugins={remarkPlugins} components={components}>
        {source}
      </ReactMarkdown>
    </Box>
  );
}

/* Memoised: during streaming only the growing tail changes, while sibling
 * messages re-render with unchanged props. */
const MarkdownText = memo(MarkdownTextBase);
export default MarkdownText;
