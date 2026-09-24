"use client";

import { useEffect, useRef, useState } from "react";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import CheckIcon from "@mui/icons-material/Check";
import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import json from "highlight.js/lib/languages/json";
import bash from "highlight.js/lib/languages/bash";
import shell from "highlight.js/lib/languages/shell";
import python from "highlight.js/lib/languages/python";
import xml from "highlight.js/lib/languages/xml";
import css from "highlight.js/lib/languages/css";
import yaml from "highlight.js/lib/languages/yaml";
import sql from "highlight.js/lib/languages/sql";
import markdown from "highlight.js/lib/languages/markdown";
import diff from "highlight.js/lib/languages/diff";
import theme, { monoStack } from "../theme";
import type { ThemeVars } from "@mui/material/styles";

// The app always uses cssVariables, so `theme.vars` is defined at runtime;
// the single assertion narrows the (optional) Theme-union type once here
// instead of at every usage site.
const codeTokens = (theme.vars as ThemeVars).palette.code;

hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("shell", shell);
hljs.registerLanguage("python", python);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("css", css);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("diff", diff);

const ALIASES: Record<string, string> = {
  sh: "shell",
  js: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  yml: "yaml",
  html: "xml",
  svg: "xml",
  py: "python",
  md: "markdown",
};

export type Segment =
  | { kind: "text"; text: string }
  | { kind: "code"; lang: string | undefined; code: string };

/**
 * Splits assistant text into text and fenced-code segments. The `(?:```|$)`
 * tail also matches an unterminated final fence, which happens while streaming.
 */
export function parseSegments(text: string): Segment[] {
  const out: Segment[] = [];
  const re = /```([A-Za-z0-9_-]*)[^\n]*\n([\s\S]*?)(?:```|$)/g;
  let last = 0;
  for (;;) {
    const m = re.exec(text);
    if (m === null) break;
    if (m.index > last) out.push({ kind: "text", text: text.slice(last, m.index) });
    out.push({ kind: "code", lang: m[1] || undefined, code: m[2] });
    last = m.index + m[0].length;
    if (m[0].length === 0) break;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}

interface CodeBlockProps {
  code: string;
  lang?: string;
  maxHeight?: number;
}

export function CodeBlock({ code, lang, maxHeight }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);
  const language = lang ? ALIASES[lang] ?? lang : undefined;
  const registered = language ? hljs.getLanguage(language) !== undefined : false;
  const html = registered
    ? hljs.highlight(code, { language: language as string, ignoreIllegals: true }).value
    : undefined;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      // Clipboard API unavailable (permissions/HTTP) — legacy fallback.
      const ta = document.createElement("textarea");
      ta.value = code;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } finally {
        document.body.removeChild(ta);
      }
    }
    setCopied(true);
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Box
      sx={{
        position: "relative",
        borderRadius: 1.5,
        bgcolor: codeTokens.bg,
        border: "1px solid",
        borderColor: codeTokens.border,
        overflow: "hidden",
        "& pre": {
          margin: 0,
          padding: "10px 12px",
          paddingTop: "44px",
          overflowX: "auto",
          ...(maxHeight !== undefined
            ? { overflowY: "auto", maxHeight }
            : {}),
          fontFamily: monoStack,
          fontSize: 13,
          lineHeight: 1.6,
          color: codeTokens.text,
          tabSize: 2,
          whiteSpace: "pre",
        },
        "& code": {
          fontFamily: monoStack,
        },
        "& .hljs-keyword, & .hljs-built_in": {
          color: codeTokens.keyword,
        },
        "& .hljs-string": { color: codeTokens.string },
        "& .hljs-comment, & .hljs-meta": {
          color: codeTokens.meta,
        },
        "& .hljs-number, & .hljs-literal": {
          color: codeTokens.number,
        },
        "& .hljs-title.function_, & .hljs-title": {
          color: codeTokens.function,
        },
        "& .hljs-attr, & .hljs-variable, & .hljs-property": {
          color: codeTokens.attr,
        },
        "& .hljs-tag, & .hljs-section": {
          color: codeTokens.tag,
        },
        "& .hljs-addition": {
          color: codeTokens.tag,
          backgroundColor: codeTokens.addBg,
        },
        "& .hljs-deletion": {
          color: codeTokens.keyword,
          backgroundColor: codeTokens.delBg,
        },
      }}
    >
      <pre>
        <code
          // highlight.js output is HTML-escaped by the library itself.
          dangerouslySetInnerHTML={html !== undefined ? { __html: html } : undefined}
        >
          {html === undefined ? code : undefined}
        </code>
      </pre>
      <IconButton
        size="small"
        aria-label="Copy code"
        onClick={() => void handleCopy()}
        sx={{
          position: "absolute",
          top: 4,
          right: 4,
          minWidth: 44,
          minHeight: 44,
        }}
      >
        {copied ? <CheckIcon fontSize="small" /> : <ContentCopyIcon fontSize="small" />}
      </IconButton>
    </Box>
  );
}

export function InlineCode({ children }: { children: React.ReactNode }) {
  return (
    <Box
      component="span"
      sx={{
        fontFamily: monoStack,
        fontSize: "0.875em",
        px: 0.5,
        py: "1px",
        borderRadius: 0.5,
        bgcolor: codeTokens.inlineBg,
      }}
    >
      {children}
    </Box>
  );
}
