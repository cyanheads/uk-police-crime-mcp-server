/**
 * @fileoverview Escaping for text that `format()` writes into `content[]`. Police
 * forces and data.police.uk author street names, descriptions, priorities and
 * labels; these helpers keep markdown link, image and HTML syntax in that text
 * inert and strip control and bidi characters. `structuredContent` never passes
 * through them — it carries the service's strings verbatim.
 * @module mcp-server/tools/format-helpers
 */

/** C0/C1 control characters and Unicode bidi controls (U+200E/F, U+202A–E, U+2066–9, U+061C). */
const STRIPPED = /[\p{Cc}\p{Bidi_Control}]/gu;

/** Every line or paragraph break, plus tab, vertical tab and form feed. */
const BREAKS = /\r\n|[\n\r\t\v\f\u{85}\p{Zl}\p{Zp}]/gu;

/** Line breaks only (CRLF, CR, NEL, U+2028, U+2029, VT, FF) — normalized to LF in quoted text. */
const LINE_BREAKS = /\r\n|[\r\v\f\u{85}\p{Zl}\p{Zp}]/gu;

/** Backslash first, then the characters that open link, image and HTML syntax. */
const MARKDOWN_SPECIALS = /[\\[\]<>]/g;

const escapeMarkdown = (text: string): string => text.replace(MARKDOWN_SPECIALS, '\\$&');

/**
 * Renders upstream text for an inline slot — a heading, bold name, list item or
 * table cell. Breaks become spaces, control and bidi characters are removed, and
 * `\`, `[`, `]`, `<`, `>` are backslash-escaped.
 */
export function inline(text: string): string {
  return escapeMarkdown(text.replace(BREAKS, ' ').replace(STRIPPED, ''));
}

/**
 * Renders upstream text for a markdown table cell: {@link inline}, then `|`
 * escaped. `inline` escapes `\` first, so a backslash before a pipe cannot cancel
 * the pipe's escape and split the cell.
 */
export function cell(text: string): string {
  return inline(text).replaceAll('|', '\\|');
}

/**
 * Renders upstream free text (a description, priority, event text, crime
 * context) as a markdown blockquote: line breaks normalized, tabs to spaces,
 * control and bidi characters removed, markdown specials escaped, and every line
 * prefixed with `> `.
 */
export function quote(text: string): string {
  return text
    .replace(LINE_BREAKS, '\n')
    .split('\n')
    .map((line) => {
      const clean = escapeMarkdown(line.replaceAll('\t', ' ').replace(STRIPPED, ''));
      return clean.trim() === '' ? '>' : `> ${clean}`;
    })
    .join('\n');
}

/**
 * Renders an upstream URL as plain text, never a markdown link: breaks, control
 * and bidi characters removed, whitespace and `[`, `]`, `<`, `>`
 * percent-encoded so no renderer turns it into link or HTML syntax.
 */
export function printUrl(url: string): string {
  return url
    .replace(BREAKS, '')
    .replace(STRIPPED, '')
    .replace(/[[\]<>\s]/gu, encodeURIComponent);
}
