/**
 * @fileoverview Converts the HTML fields data.police.uk serves (neighbourhood
 * descriptions, priority issues and actions, event descriptions) to plain text:
 * tags dropped, block ends to newlines, entities decoded, blank-line runs
 * collapsed. The result is what `structuredContent` carries.
 * @module services/police-api/html-to-text
 */

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  apos: "'",
  bull: '•',
  copy: '©',
  deg: '°',
  eacute: 'é',
  euro: '€',
  gt: '>',
  hellip: '…',
  laquo: '«',
  ldquo: '“',
  lsquo: '‘',
  lt: '<',
  mdash: '—',
  middot: '·',
  nbsp: ' ',
  ndash: '–',
  pound: '£',
  quot: '"',
  raquo: '»',
  rdquo: '”',
  reg: '®',
  rsquo: '’',
  trade: '™',
};

/** Elements whose content is never text: dropped with their content. */
const NON_TEXT_ELEMENTS = /<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const COMMENTS = /<!--[\s\S]*?-->/g;
/**
 * The rest of a tag after its name's first letter, through its closing `>`. A
 * quote opens an attribute value only after `=`, as in HTML, and a `>` inside
 * that value does not close the tag; a tag whose quoted value never closes ends
 * at its first `>`. A run of plain characters is taken whole (`(?=(…))\1` is an
 * atomic group) and the alternatives cannot overlap, so a failed match never
 * backtracks, and the leading lookahead drops a `<` no `>` follows in one scan.
 */
const TAG_REST = String.raw`(?=[^>]*>)(?:(?:(?=([^>=]+))\1|=\s*"[^"]*"|=\s*'[^']*'|=(?!\s*["']))*>|[^>]*>)`;
/** `<br>` (with or without attributes) and the end of every block element become a line break. */
const BREAK_TAGS = new RegExp(
  String.raw`<br\b${TAG_REST}|<\/(?:p|li|div|h[1-6]|tr|ul|ol|table|blockquote|section|article)\s*>`,
  'gi',
);
/** A tag: `<` followed by a letter, `/` or `!` — so a bare `a < b` in text survives. */
const TAGS = new RegExp(String.raw`<\/?[a-z!]${TAG_REST}`, 'gi');
const ENTITIES = /&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi;

function decodeEntity(match: string, body: string): string {
  if (body.startsWith('#')) {
    const hex = body[1] === 'x' || body[1] === 'X';
    const codePoint = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
    const valid =
      codePoint <= 0x10ffff &&
      !(codePoint >= 0xd800 && codePoint <= 0xdfff) &&
      (codePoint >= 0x20 || codePoint === 0x0a);
    return valid ? String.fromCodePoint(codePoint) : '';
  }
  return NAMED_ENTITIES[body.toLowerCase()] ?? match;
}

/**
 * Converts an upstream HTML fragment to plain text. Returns `undefined` for a
 * missing value or one with no text left after conversion.
 */
export function htmlToText(html: string | null | undefined): string | undefined {
  if (html == null) return;
  const text = html
    .replace(NON_TEXT_ELEMENTS, '')
    .replace(COMMENTS, '')
    .replace(BREAK_TAGS, '\n')
    .replace(TAGS, '')
    .replace(ENTITIES, decodeEntity)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text === '' ? undefined : text;
}
