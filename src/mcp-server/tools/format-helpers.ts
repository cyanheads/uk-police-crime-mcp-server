/**
 * @fileoverview Escaping for text that `format()` writes into `content[]`. Police
 * forces and data.police.uk author street names, descriptions, priorities and
 * labels; these helpers keep markdown link, image, HTML and character-reference
 * syntax in that text inert and strip control and invisible format characters.
 * `structuredContent` never passes through them — it carries the service's
 * strings verbatim.
 * @module mcp-server/tools/format-helpers
 */

/**
 * C0/C1 control characters and format characters (`Cf`: bidi controls, zero-width
 * space, word joiner, byte order mark, tag characters), except the zero-width
 * non-joiner and joiner (U+200C, U+200D) that scripts and emoji sequences need.
 */
const STRIPPED = /[[\p{Cc}\p{Cf}]--[\u{200C}\u{200D}]]/gv;

/** Every line or paragraph break, plus tab, vertical tab and form feed. */
const BREAKS = /\r\n|[\n\r\t\v\f\u{85}\p{Zl}\p{Zp}]/gu;

/** Line breaks only (CRLF, CR, NEL, U+2028, U+2029, VT, FF) — normalized to LF in quoted text. */
const LINE_BREAKS = /\r\n|[\r\v\f\u{85}\p{Zl}\p{Zp}]/gu;

/**
 * The backslash, the characters that open link, image and HTML syntax, and an
 * `&` that starts a character reference, which a markdown renderer would decode
 * (`&#x202E;` to a bidi override).
 */
const MARKDOWN_SPECIALS = /[\\[\]<>]|&(?=#?[0-9A-Za-z]+;)/g;

const escapeMarkdown = (text: string): string => text.replace(MARKDOWN_SPECIALS, '\\$&');

/**
 * Renders upstream text for an inline slot — a heading, bold name, list item or
 * table cell. Breaks become spaces, control and format characters are removed,
 * and `\`, `[`, `]`, `<`, `>` and a character reference's `&` are
 * backslash-escaped.
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
 * control and format characters removed, markdown specials escaped, and every
 * line prefixed with `> `.
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
 * and format characters removed, whitespace and `[`, `]`, `<`, `>`
 * percent-encoded so no renderer turns it into link or HTML syntax.
 */
export function printUrl(url: string): string {
  return url
    .replace(BREAKS, '')
    .replace(STRIPPED, '')
    .replace(/[[\]<>\s]/gu, encodeURIComponent);
}
