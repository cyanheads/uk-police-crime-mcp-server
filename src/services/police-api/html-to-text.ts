/**
 * @fileoverview Converts the HTML fields data.police.uk serves (neighbourhood
 * descriptions, priority issues and actions, event descriptions) to plain text:
 * tags dropped, block ends to newlines, entities decoded, invisible characters
 * removed, blank-line runs collapsed, in time linear in the input. The result is
 * what `structuredContent` carries.
 * @module services/police-api/html-to-text
 */

const NAMED_ENTITIES: ReadonlyMap<string, string> = new Map(
  Object.entries({
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
  }),
);

/** A comment, or the opening of an element whose content is never text. */
const NON_TEXT_OPENER = /<!--|<(script|style|template)\b/gi;
/** The closing tag of an element whose content is never text. */
const NON_TEXT_CLOSER = /<\/(script|style|template)\s*>/gi;
/**
 * The rest of a tag after its name's first letter, through its closing `>`. A
 * quote opens an attribute value only after `=`, as in HTML, and a `>` inside
 * that value does not close the tag; a tag whose quoted value never closes ends
 * at its first `>`. A run of plain characters is taken whole (`(?=(…))\1` is an
 * atomic group) and the alternatives cannot overlap, so a failed match never
 * backtracks. Applied through {@link replaceTags} only, which keeps a `>` ahead
 * of every `<` it scans.
 */
const TAG_REST = String.raw`(?:(?:(?=([^>=]+))\1|=\s*"[^"]*"|=\s*'[^']*'|=(?!\s*["']))*>|[^>]*>)`;
/** `<br>` (with or without attributes) and the end of every block element become a line break. */
const BREAK_TAGS = new RegExp(
  String.raw`<br\b${TAG_REST}|<\/(?:p|li|div|h[1-6]|tr|ul|ol|table|blockquote|section|article)\s*>`,
  'gi',
);
/** A tag: `<` followed by a letter, `/` or `!` — so a bare `a < b` in text survives. */
const TAGS = new RegExp(String.raw`<\/?[a-z!]${TAG_REST}`, 'gi');
const ENTITIES = /&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi;

/**
 * Code points a numeric entity is never decoded to: controls other than LF,
 * format characters other than the zero-width non-joiner and joiner, surrogates
 * and noncharacters. Such an entity stays as written, visible.
 */
const UNDECODED = /^[[\p{Cc}\p{Cf}\p{Cs}\p{Noncharacter_Code_Point}]--[\n\u{200C}\u{200D}]]$/v;

/**
 * Controls and format characters removed from the text, as `content[]` removes
 * them: everything but the zero-width non-joiner and joiner, which scripts and
 * emoji sequences need, and tab, vertical tab and form feed, which the
 * whitespace collapse turns into spaces.
 */
const INVISIBLE = /[[\p{Cc}\p{Cf}]--[\t\v\f\u{200C}\u{200D}]]/gv;

function decodeEntity(match: string, body: string): string {
  if (body.startsWith('#')) {
    const hex = body[1] === 'x' || body[1] === 'X';
    const codePoint = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
    if (codePoint > 0x10ffff) return match;
    const char = String.fromCodePoint(codePoint);
    return UNDECODED.test(char) ? match : char;
  }
  return NAMED_ENTITIES.get(body.toLowerCase()) ?? match;
}

/**
 * Drops comments and `script`, `style` and `template` elements with their
 * content in one forward scan. Each opener closes at the first `-->` or matching
 * closing tag after it; an opener that never closes drops the rest of the text,
 * as a browser does.
 */
function dropNonText(html: string): string {
  let text = '';
  let from = 0;
  NON_TEXT_OPENER.lastIndex = 0;
  for (let open = NON_TEXT_OPENER.exec(html); open; open = NON_TEXT_OPENER.exec(html)) {
    text += html.slice(from, open.index);
    from = closeOf(html, open);
    if (from === -1) return text;
    NON_TEXT_OPENER.lastIndex = from;
  }
  return text + html.slice(from);
}

/** The index just past what closes `open` (a comment opener or an element opener), or -1 when nothing does. */
function closeOf(html: string, open: RegExpExecArray): number {
  const name = open[1]?.toLowerCase();
  if (name === undefined) {
    const end = html.indexOf('-->', open.index + 4);
    return end === -1 ? -1 : end + 3;
  }
  const tagEnd = html.indexOf('>', open.index);
  if (tagEnd === -1) return -1;
  NON_TEXT_CLOSER.lastIndex = tagEnd + 1;
  for (let close = NON_TEXT_CLOSER.exec(html); close; close = NON_TEXT_CLOSER.exec(html)) {
    if (close[1]?.toLowerCase() === name) return NON_TEXT_CLOSER.lastIndex;
  }
  return -1;
}

/**
 * Replaces `tags` in `text` up to its last `>` only. A tag needs a `>` to close
 * it, so none starts after the last one; leaving that tail unscanned keeps a run
 * of `<` with no `>` after it from costing a scan to the end for each `<`.
 */
function replaceTags(text: string, tags: RegExp, replacement: string): string {
  const end = text.lastIndexOf('>') + 1;
  return text.slice(0, end).replace(tags, replacement) + text.slice(end);
}

/**
 * Converts an upstream HTML fragment to plain text. Returns `undefined` for a
 * missing value or one with no text left after conversion.
 */
export function htmlToText(html: string | null | undefined): string | undefined {
  if (html == null) return;
  const text = replaceTags(replaceTags(dropNonText(html), BREAK_TAGS, '\n'), TAGS, '')
    .replace(ENTITIES, decodeEntity)
    .replace(/\r\n?|\u{85}/gu, '\n')
    .split('\n')
    .map((line) => line.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text === '' ? undefined : text;
}
