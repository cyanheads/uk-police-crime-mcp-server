/**
 * @fileoverview format-helpers: the escaping that keeps upstream-authored text
 * inert inside `content[]` — line breaks flattened in inline slots, control and
 * format characters stripped (the two zero-width joiners kept), markdown
 * link/image/HTML openers, character-reference ampersands and backslashes
 * escaped, table pipes escaped, free text quoted line by line, URLs printed as
 * plain text.
 * @module tests/shared/format-helpers.test
 */

import { describe, expect, it } from 'vitest';
import { cell, inline, printUrl, quote } from '@/mcp-server/tools/format-helpers.js';

/** Every character that breaks a line or paragraph, or acts like whitespace layout. */
const LINE_BREAK_CHARS = [
  '\n',
  '\r',
  '\r\n',
  '\t',
  '\v',
  '\f',
  '\u0085',
  '\u2028',
  '\u2029',
] as const;

/** Bidi controls the helpers must strip. */
const BIDI_CHARS = [
  '\u061c',
  '\u200e',
  '\u200f',
  '\u202a',
  '\u202b',
  '\u202c',
  '\u202d',
  '\u202e',
  '\u2066',
  '\u2067',
  '\u2068',
  '\u2069',
] as const;

/** C0 and C1 controls other than the ones that break lines. */
const CONTROL_CHARS = [
  '\u0000',
  '\u0001',
  '\u0007',
  '\u0008',
  '\u001b',
  '\u007f',
  '\u0080',
  '\u009f',
] as const;

/** Format characters that render as nothing; every helper must strip them. */
const INVISIBLE_CHARS = [
  '\u{E0001}',
  '\u{E0041}',
  '\u{E007F}',
  '\u{200B}',
  '\u{2060}',
  '\u{FEFF}',
] as const;

/** Joiners that scripts and emoji sequences need; every helper keeps them. */
const JOINER_CHARS = ['\u{200C}', '\u{200D}'] as const;

/** Splits a markdown table row on pipes that are not backslash-escaped. */
function splitRow(row: string): string[] {
  const cells: string[] = [];
  let current = '';
  for (let i = 0; i < row.length; i++) {
    const char = row[i] ?? '';
    if (char === '\\') {
      current += char + (row[i + 1] ?? '');
      i += 1;
    } else if (char === '|') {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

/** True when a `[` or `<` appears unescaped (not preceded by an odd run of backslashes). */
function hasUnescaped(text: string, chars: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const char = text[i] ?? '';
    if (char === '\\') {
      i += 1;
    } else if (chars.includes(char)) {
      return true;
    }
  }
  return false;
}

describe('inline', () => {
  it('leaves ordinary text alone', () => {
    expect(inline('On or near Example Street')).toBe('On or near Example Street');
    expect(inline('')).toBe('');
  });

  it.each(LINE_BREAK_CHARS)('turns the break character %j into a space', (br) => {
    expect(inline(`one${br}two`)).toBe('one two');
  });

  it('never leaves a line break in the output, whatever the input mixes', () => {
    const text = inline(`a${LINE_BREAK_CHARS.join('x')}b`);
    expect(text).not.toMatch(/[\n\r\u0085\u2028\u2029]/u);
  });

  it('turns CRLF into one space, not two', () => {
    expect(inline('a\r\nb')).toBe('a b');
  });

  it.each(CONTROL_CHARS)('strips the control character %j', (control) => {
    expect(inline(`a${control}b`)).toBe('ab');
  });

  it.each(BIDI_CHARS)('strips the bidi control %j', (bidi) => {
    expect(inline(`a${bidi}b`)).toBe('ab');
  });

  it('strips a right-to-left override that would reorder what follows', () => {
    expect(inline('safe\u202etxt.exe')).toBe('safetxt.exe');
  });

  it.each([
    ['[', '\\['],
    [']', '\\]'],
    ['<', '\\<'],
    ['>', '\\>'],
    ['\\', '\\\\'],
  ])('escapes %j', (char, escaped) => {
    expect(inline(`a${char}b`)).toBe(`a${escaped}b`);
  });

  it('defuses markdown link syntax', () => {
    const text = inline('[click me](https://evil.test)');
    expect(text).toBe('\\[click me\\](https://evil.test)');
    expect(hasUnescaped(text, '[')).toBe(false);
  });

  it('defuses markdown image syntax', () => {
    const text = inline('![tracker](https://evil.test/p.png)');
    expect(text).toBe('!\\[tracker\\](https://evil.test/p.png)');
  });

  it('defuses HTML and autolink syntax', () => {
    const text = inline('<script>alert(1)</script> <https://evil.test>');
    expect(hasUnescaped(text, '<>')).toBe(false);
  });

  it('escapes the backslash first, so an upstream backslash cannot cancel an escape', () => {
    // Upstream `\[x](y)` would render as a link if only `[` were escaped: `\\[x](y)`.
    expect(inline('\\[x](y)')).toBe('\\\\\\[x\\](y)');
    expect(hasUnescaped(inline('\\[x](y)'), '[')).toBe(false);
  });

  it('does not touch characters outside the listed set', () => {
    expect(inline('*bold* _em_ `code` # heading & more | pipe')).toBe(
      '*bold* _em_ `code` # heading & more | pipe',
    );
  });

  it('keeps non-ASCII text', () => {
    expect(inline('Café Quarter — £5 ✓ 日本')).toBe('Café Quarter — £5 ✓ 日本');
  });

  it('strips controls after flattening, so a break next to a control still yields one space', () => {
    expect(inline('a\u0000\nb')).toBe('a b');
  });

  it.each(INVISIBLE_CHARS)('strips the invisible character %j', (char) => {
    expect(inline(`a${char}b`)).toBe('ab');
  });

  it('strips a run of tag characters spelling hidden text', () => {
    expect(inline('Ward panel\u{E0049}\u{E0047}\u{E004E}\u{E004F}\u{E0052}\u{E0045}')).toBe(
      'Ward panel',
    );
  });

  it.each(JOINER_CHARS)('keeps the joiner %j', (char) => {
    expect(inline(`a${char}b`)).toBe(`a${char}b`);
  });

  it.each([
    ['a numeric reference', '&#x202E;'],
    ['a decimal reference', '&#8238;'],
    ['a named reference', '&lrm;'],
    ['an escaped ampersand', '&amp;'],
  ])('escapes the ampersand of %s, so no renderer decodes it', (_name, ref) => {
    expect(inline(`a${ref}b`)).toBe(`a\\${ref}b`);
  });

  it('leaves an ampersand that starts no reference alone', () => {
    expect(inline('Fish & chips &x &#; & ;')).toBe('Fish & chips &x &#; & ;');
  });
});

describe('cell', () => {
  it('escapes pipes on top of inline escaping', () => {
    expect(cell('a|b')).toBe('a\\|b');
    expect(cell('[x]|<y>')).toBe('\\[x\\]\\|\\<y\\>');
  });

  it('flattens line breaks so a cell stays on one row', () => {
    expect(cell('first\nsecond\r\nthird')).toBe('first second third');
  });

  it('keeps a row to its own cells when the text carries pipes and backslashes', () => {
    const hostile = ['a|b', 'a\\|b', 'a\\\\|b', '\\', '|', '||', 'x\\'];
    for (const text of hostile) {
      const row = `| ${cell(text)} | other |`;
      expect(splitRow(row)).toHaveLength(4);
    }
  });

  it('cannot let a trailing backslash escape the cell delimiter that follows it', () => {
    const row = `| ${cell('ends with a backslash\\')} | other |`;
    expect(splitRow(row)).toEqual(['', ' ends with a backslash\\\\ ', ' other ', '']);
  });

  it.each(INVISIBLE_CHARS)('strips the invisible character %j', (char) => {
    expect(cell(`a${char}|b`)).toBe('a\\|b');
  });

  it.each(JOINER_CHARS)('keeps the joiner %j', (char) => {
    expect(cell(`a${char}b`)).toBe(`a${char}b`);
  });
});

describe('quote', () => {
  it('prefixes a single line with "> "', () => {
    expect(quote('Fly-tipping on the estate')).toBe('> Fly-tipping on the estate');
  });

  it('prefixes every line of multi-line text', () => {
    expect(quote('one\ntwo\nthree')).toBe('> one\n> two\n> three');
  });

  it.each(['\r\n', '\r', '\u0085', '\u2028', '\u2029', '\v', '\f'])(
    'treats %j as a line break between quoted lines',
    (br) => {
      expect(quote(`one${br}two`)).toBe('> one\n> two');
    },
  );

  it('renders a blank line as a bare ">" so the blockquote continues', () => {
    expect(quote('one\n\ntwo')).toBe('> one\n>\n> two');
  });

  it('renders a whitespace-only line, or one of only controls, as a bare ">"', () => {
    expect(quote('one\n   \ntwo')).toBe('> one\n>\n> two');
    expect(quote('one\n\u0000\u200e\ntwo')).toBe('> one\n>\n> two');
  });

  it('quotes the empty string as a bare ">"', () => {
    expect(quote('')).toBe('>');
  });

  it('quotes trailing newlines as trailing bare ">" lines', () => {
    expect(quote('text\n')).toBe('> text\n>');
  });

  it('turns tabs into spaces', () => {
    expect(quote('a\tb')).toBe('> a b');
  });

  it.each(CONTROL_CHARS)('strips the control character %j', (control) => {
    expect(quote(`a${control}b`)).toBe('> ab');
  });

  it.each(BIDI_CHARS)('strips the bidi control %j', (bidi) => {
    expect(quote(`a${bidi}b`)).toBe('> ab');
  });

  it('escapes brackets, angle brackets and backslashes inside the blockquote', () => {
    const text = quote('![x](https://evil.test/a.png)\n<img src=x>\n\\[y](z)');
    expect(text).toBe('> !\\[x\\](https://evil.test/a.png)\n> \\<img src=x\\>\n> \\\\\\[y\\](z)');
  });

  it('never lets an input line escape the quote, whatever it starts with', () => {
    const hostile = [
      '# heading',
      '---',
      '```',
      '- list',
      '1. item',
      '| a | b |',
      '> already quoted',
      '    code',
    ];
    const lines = quote(hostile.join('\n')).split('\n');
    expect(lines).toHaveLength(hostile.length);
    for (const line of lines) expect(line.startsWith('>')).toBe(true);
  });

  it('keeps every output line quoted when upstream text smuggles break characters', () => {
    const out = quote('a\u2028# injected\u0085- also\r\n---');
    for (const line of out.split('\n')) expect(line.startsWith('>')).toBe(true);
  });

  it('leaves no carriage return or Unicode line separator in the output', () => {
    expect(quote('a\r\nb\rc\u2028d\u2029e')).not.toMatch(/[\r\u2028\u2029\u0085]/u);
  });

  it.each(INVISIBLE_CHARS)('strips the invisible character %j', (char) => {
    expect(quote(`a${char}b`)).toBe('> ab');
  });

  it('renders a line of only invisible characters as a bare ">"', () => {
    expect(quote(`one\n${INVISIBLE_CHARS.join('')}\ntwo`)).toBe('> one\n>\n> two');
  });

  it.each(JOINER_CHARS)('keeps the joiner %j', (char) => {
    expect(quote(`a${char}b`)).toBe(`> a${char}b`);
  });

  it('escapes the ampersand of a character reference inside the blockquote', () => {
    expect(quote('see &#x202E;txt.exe &amp;lt;')).toBe('> see \\&#x202E;txt.exe \\&amp;lt;');
  });
});

describe('printUrl', () => {
  it('leaves an ordinary URL unchanged', () => {
    const url = 'https://www.example-force.police.test/neighbourhood/nx01?tab=1&x=2#top';
    expect(printUrl(url)).toBe(url);
  });

  it.each([
    ['[', '%5B'],
    [']', '%5D'],
    ['<', '%3C'],
    ['>', '%3E'],
    [' ', '%20'],
    ['\u00a0', '%C2%A0'],
  ])('percent-encodes %j', (char, encoded) => {
    expect(printUrl(`https://example.test/a${char}b`)).toBe(`https://example.test/a${encoded}b`);
  });

  it('turns markdown link syntax into plain text', () => {
    expect(printUrl('[click](https://evil.test)')).toBe('%5Bclick%5D(https://evil.test)');
  });

  it.each(LINE_BREAK_CHARS)(
    'removes the break character %j outright, without leaving a gap',
    (br) => {
      expect(printUrl(`https://example.test/a${br}b`)).toBe('https://example.test/ab');
    },
  );

  it.each([...CONTROL_CHARS, ...BIDI_CHARS, ...INVISIBLE_CHARS])('strips %j', (char) => {
    expect(printUrl(`https://example.test/a${char}b`)).toBe('https://example.test/ab');
  });

  it('leaves existing percent-encoding alone', () => {
    expect(printUrl('https://example.test/a%20b%5Bc')).toBe('https://example.test/a%20b%5Bc');
  });

  it('leaves nothing a renderer could read as link or HTML syntax', () => {
    const out = printUrl('<https://evil.test/ x>[a](b)\n\t');
    expect(out).not.toMatch(/[[\]<>\s]/u);
  });

  it('returns an empty string for empty input', () => {
    expect(printUrl('')).toBe('');
  });
});
