// @vitest-environment node
/*
 * Focused tests for assistant Markdown rendering (MarkdownText). The component
 * is rendered with react-dom/server renderToStaticMarkup — MUI/emotion are
 * SSR-safe here — and assertions cover structure, safety and streaming:
 *
 * - headings, lists (ordered, task), blockquotes, tables, rules, emphasis
 * - each text part is ONE Markdown document: fences nested in lists and
 *   blockquotes, four-backtick fences containing triple-backtick lines, and
 *   link references defined across a fence all survive intact
 * - fenced code keeps highlight.js highlighting and the copy button
 * - streaming: an unterminated fence still renders as code, with the caret at
 *   the typing position
 * - security: raw HTML is inert but visible (escaped literal text),
 *   javascript:/data: URLs are neutralised, images are never fetched
 *   (no <img>, no React 19 preload), external links open in a new tab while
 *   relative and fragment links stay in the current tab
 */
import { describe, expect, it } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ThemeProvider } from "@mui/material/styles";
import MarkdownText from "./components/MarkdownText";
import theme from "./theme";

function render(text: string, caret = false): string {
  return renderToStaticMarkup(
    React.createElement(
      ThemeProvider,
      { theme },
      React.createElement(MarkdownText, { text, caret }),
    ),
  );
}

describe("MarkdownText structure", () => {
  it("renders headings as heading elements at reduced variants", () => {
    const html = render("# One\n\n## Two\n\n### Three\n\n#### Four");
    expect(html).toContain("<h5");
    expect(html).toContain("One");
    expect(html).toContain("<h6");
    expect(html).toContain("Two");
    expect(html).toContain("Three");
    expect(html).toContain("Four");
  });

  it("renders unordered, ordered lists with start attributes", () => {
    /* CommonMark: "2. two" followed by a blank line and "3. three" continues
     * the same list; only a list whose first item is not 1 carries start. */
    const html = render("- a\n- b\n\n5. five\n6. six");
    expect(html).toContain("<ul");
    expect(html).toContain("<li");
    expect(html).toContain("<ol");
    expect(html).toContain('start="5"');
  });

  it("renders GFM task lists with disabled checkboxes", () => {
    const html = render("- [x] done\n- [ ] open");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("disabled");
    expect(html).toContain("checked");
    expect(html).toContain("task-list-item");
  });

  it("renders emphasis, strikethrough, inline code and blockquotes", () => {
    const html = render("**bold** *ital* ~~gone~~ `code`\n\n> quoted");
    expect(html).toContain("<strong");
    expect(html).toContain("<em");
    expect(html).toContain("<del");
    expect(html).toContain("code");
    expect(html).toContain("<blockquote");
    expect(html).toContain("quoted");
  });

  it("renders GFM tables inside the markdown output", () => {
    const html = render("| a | b |\n| --- | --- |\n| 1 | 2 |");
    expect(html).toContain("<table");
    expect(html).toContain("<th");
    expect(html).toContain("<td");
  });

  it("renders thematic breaks and preserves single line breaks", () => {
    const html = render("line1\nline2\n\n---");
    expect(html).toContain("line1\nline2");
    expect(html).toContain("<hr");
  });
});

describe("MarkdownText single-document correctness", () => {
  it("renders four-backtick fences containing triple-backtick lines", () => {
    const html = render("````\n```js\ninner\n```\n````");
    /* Exactly one code block whose content includes the inner fence lines. */
    expect(html.match(/<pre/g)?.length).toBe(1);
    expect(html).toContain("```js");
    expect(html).toContain("inner");
  });

  it("keeps fenced code inside list items", () => {
    const html = render("- item\n\n  ```js\n  let x = 1;\n  ```\n\n- next");
    const liStart = html.indexOf("<li");
    const preStart = html.indexOf("<pre");
    const liEnd = html.indexOf("</li>");
    expect(liStart).toBeGreaterThanOrEqual(0);
    expect(preStart).toBeGreaterThan(liStart);
    expect(preStart).toBeLessThan(liEnd);
    expect(html).toContain("item");
    expect(html).toContain("next");
  });

  it("keeps fenced code inside blockquotes", () => {
    const html = render("> quoted\n> ```js\n> let x = 1;\n> ```");
    const quoteStart = html.indexOf("<blockquote");
    const preStart = html.indexOf("<pre");
    const quoteEnd = html.indexOf("</blockquote>");
    expect(quoteStart).toBeGreaterThanOrEqual(0);
    expect(preStart).toBeGreaterThan(quoteStart);
    expect(preStart).toBeLessThan(quoteEnd);
  });

  it("resolves link references defined across a fence", () => {
    const html = render(
      "See [docs][ref].\n\n```js\nlet x = 1;\n```\n\n[ref]: https://example.com/doc",
    );
    expect(html).toContain('href="https://example.com/doc"');
    expect(html).toContain("<pre");
  });
});

describe("MarkdownText code blocks", () => {
  it("routes fenced code through CodeBlock with highlighting and copy", () => {
    const html = render("```python\nprint('hi')\n```");
    expect(html).toContain("<pre");
    expect(html).toContain("hljs-");
    expect(html).toContain('aria-label="Copy code"');
  });

  it("handles fenced blocks without a language", () => {
    const html = render("```\nplain\nblock\n```");
    expect(html).toContain("<pre");
    expect(html).toContain("plain\nblock");
  });

  it("keeps inline code out of pre blocks", () => {
    const html = render("run `ls -la` now");
    expect(html).not.toContain("<pre");
    expect(html).toContain("ls -la");
  });
});

describe("MarkdownText streaming", () => {
  it("renders an unterminated fence as a code block while streaming", () => {
    const html = render("intro\n```python\nprint('hi')");
    expect(html).toContain("<pre");
    expect(html).toContain("hljs-");
    expect(html).toContain("intro");
  });

  it("places the caret at the typing position, including inside code", () => {
    expect(render("partial respo", true)).toContain("▍");
    const streamingCode = render("```py\nprint('hi", true);
    expect(streamingCode).toContain("<pre");
    expect(streamingCode).toContain("▍");
    expect(render("done", false)).not.toContain("▍");
  });
});

describe("MarkdownText security and link safety", () => {
  it("renders raw HTML as escaped literal text — inert but visible", () => {
    const block = render("<div>\nhello\n</div>");
    expect(block).not.toContain("<div>");
    expect(block).toContain("&lt;div&gt;");
    expect(block).toContain("hello");

    const inline = render("keep <em>me</em> visible");
    expect(inline).not.toContain("<em>");
    expect(inline).toContain("&lt;em&gt;me&lt;/em&gt;");

    const script = render("<script>alert(1)</script>");
    expect(script).not.toContain("<script");
    expect(script).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("neutralises javascript and data URLs in links", () => {
    for (const href of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox",
    ]) {
      const html = render(`[click](${href})`);
      expect(html).not.toContain("<a ");
      expect(html).not.toContain("javascript:");
      expect(html).not.toContain("data:");
      expect(html).toContain("click");
    }
  });

  it("opens external http(s) links in a new tab with safe rel", () => {
    const html = render("[site](https://example.com) [mail](mailto:a@b.c)");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('href="mailto:a@b.c"');
  });

  it("keeps relative and fragment links in the current tab", () => {
    const html = render("[doc](./doc.md) [up](../x) [top](#heading)");
    expect((html.match(/<a /g) ?? []).length).toBe(3);
    expect(html).toContain('href="./doc.md"');
    expect(html).toContain('href="../x"');
    expect(html).toContain('href="#heading"');
    expect(html).not.toContain('target="_blank"');
  });

  it("never renders images, so no remote fetches or preloads happen", () => {
    const html = render("![tracking pixel](https://example.com/pixel.gif)");
    expect(html).not.toContain("<img");
    expect(html).not.toContain('rel="preload"');
    expect(html).not.toContain("pixel.gif");
    expect(html).toContain("[image: tracking pixel]");
  });
});
