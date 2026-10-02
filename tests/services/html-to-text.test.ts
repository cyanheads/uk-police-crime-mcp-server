/**
 * @fileoverview htmlToText: the plain text `structuredContent` carries for the
 * HTML fields data.police.uk serves — tags dropped, block ends to newlines,
 * entities decoded once (never to an invisible or control character), invisible
 * characters removed, blank-line runs collapsed, empty to undefined, in time
 * linear in the input.
 * @module tests/services/html-to-text.test
 */

import { describe, expect, it } from 'vitest';
import { htmlToText } from '@/services/police-api/html-to-text.js';

describe('htmlToText', () => {
  describe('absent and empty input', () => {
    it.each([
      ['undefined', undefined],
      ['null', null],
      ['an empty string', ''],
      ['whitespace', '  \n\t '],
      ['an empty paragraph', '<p></p>'],
      ['only tags and breaks', '<p><br/></p><div> </div>'],
      ['only a comment', '<!-- note -->'],
      ['only a script', '<script>alert(1)</script>'],
      ['only non-breaking spaces', '<p>&nbsp;&nbsp;</p>'],
    ])('returns undefined for %s', (_name, input) => {
      expect(htmlToText(input)).toBeUndefined();
    });
  });

  describe('structure', () => {
    it('passes plain text through', () => {
      expect(htmlToText('No markup here.')).toBe('No markup here.');
    });

    it('turns the end of each paragraph into a line break', () => {
      expect(htmlToText('<p>First.</p><p>Second.</p>')).toBe('First.\nSecond.');
    });

    it.each(['<br>', '<br/>', '<br />', '<BR>'])('turns %s into a line break', (br) => {
      expect(htmlToText(`one${br}two`)).toBe('one\ntwo');
    });

    it('puts list items on their own lines', () => {
      expect(htmlToText('<ul><li>Patrols</li><li>Community meetings</li></ul>')).toBe(
        'Patrols\nCommunity meetings',
      );
    });

    it.each(['div', 'h1', 'h6', 'tr', 'table', 'blockquote', 'section', 'article', 'ol'])(
      'treats the end of <%s> as a line break',
      (tag) => {
        expect(htmlToText(`<${tag}>a</${tag}>b`)).toBe('a\nb');
      },
    );

    it('keeps inline elements on one line', () => {
      expect(
        htmlToText(
          '<p>Call <strong>101</strong> or <a href="https://example.test/x">visit</a>.</p>',
        ),
      ).toBe('Call 101 or visit.');
    });

    it('drops attributes with the tag, including ones containing quotes', () => {
      expect(htmlToText('<span class="a" data-x=\'b\' style="color:red">text</span>')).toBe('text');
    });

    it.each([
      ['double-quoted', '<a href="https://example.test/?a=1>2">link</a>'],
      ['single-quoted', "<a title='1 > 0' href=x>link</a>"],
      ['spaced around =', '<a href = "x>y" >link</a>'],
    ])('drops a tag whose %s attribute value contains ">"', (_name, html) => {
      expect(htmlToText(html)).toBe('link');
    });

    it('reads a quote outside an attribute value as part of the tag, not the start of a value', () => {
      expect(htmlToText("<a title=don't>link</a> it's here")).toBe("link it's here");
    });

    it('ends a tag whose quoted value never closes at its first ">"', () => {
      expect(htmlToText('<a href="x>link</a> after')).toBe('link after');
    });

    it('turns a <br> carrying attributes into a line break', () => {
      expect(htmlToText('one<br clear="all">two<br class=\'x\' />three')).toBe('one\ntwo\nthree');
    });

    it('collapses runs of blank lines to one blank line', () => {
      expect(htmlToText('<p>a</p><p></p><p></p><p></p><p>b</p>')).toBe('a\n\nb');
    });

    it('collapses runs of spaces and tabs inside a line and trims each line', () => {
      expect(htmlToText('  <p>  one \t  two  </p>  <p> three </p> ')).toBe('one two\nthree');
    });

    it('normalizes CRLF and CR to LF, so no carriage return survives', () => {
      const text = htmlToText('line one\r\nline two\rline three');
      expect(text).toBe('line one\nline two\nline three');
      expect(text).not.toContain('\r');
    });

    it('keeps a newline written in the source as a line break', () => {
      expect(htmlToText('first line\nsecond line')).toBe('first line\nsecond line');
    });

    it('trims leading and trailing blank lines', () => {
      expect(htmlToText('<p></p><p>body</p><p></p>')).toBe('body');
    });
  });

  describe('non-text elements', () => {
    it('drops script, style and template with their content', () => {
      expect(
        htmlToText(
          '<p>before</p><script>var x = "<p>nope</p>";</script><style>p{color:red}</style><template><p>no</p></template><p>after</p>',
        ),
      ).toBe('before\nafter');
    });

    it('drops comments, multi-line ones included', () => {
      expect(htmlToText('a<!-- hidden\nacross lines -->b')).toBe('ab');
    });

    it.each([
      ['an unclosed comment', 'kept<!-- dropped <p>still dropped</p>'],
      ['an unclosed script', 'kept<script>dropped<p>still dropped</p>'],
      ['an unclosed style', 'kept<STYLE type="text/css">p{}</p>'],
      ['a script opener with no ">"', 'kept<script src=x'],
      ['a script closed by another element only', 'kept<script>a</style>b</template>c'],
    ])('drops everything after %s', (_name, html) => {
      expect(htmlToText(html)).toBe('kept');
    });

    it('closes an element on its own closing tag, whatever the case and trailing space', () => {
      expect(htmlToText('a<SCRIPT>x</Script >b<template>y</TEMPLATE>c')).toBe('abc');
    });

    it('removes comments and non-text elements in document order', () => {
      expect(htmlToText('a<!-- <script> -->b</script>c')).toBe('abc');
      expect(htmlToText('a<script>x<!-- y</script>b-->')).toBe('ab-->');
    });
  });

  describe('time stays linear in the input', () => {
    /**
     * Each input is converted at two sizes 16 times apart and timed in this
     * thread's CPU time, which other load on the machine barely moves, keeping
     * the fastest of five samples per size taken alternately. Linear time puts
     * the large size near 16 times the small one and a quadratic scan near 256
     * times; the test allows 64 times, and 50 ms of CPU for the large size,
     * where a quadratic scan takes seconds.
     */
    const SMALL = 1_250;
    const LARGE = 20_000;
    const SAMPLES = 5;
    const MAX_RATIO = 4 * (LARGE / SMALL);
    const MAX_LARGE_MS = 50;
    /** Room for a super-linear regression, seconds a sample, to fail on its numbers rather than on the clock. */
    const REGRESSION_TIMEOUT_MS = 60_000;

    /** CPU milliseconds this thread spends converting `html`. */
    const cpuMs = (html: string): number => {
      const start = process.threadCpuUsage();
      htmlToText(html);
      const spent = process.threadCpuUsage(start);
      return (spent.user + spent.system) / 1000;
    };

    it.each([
      ['<script>', '<script>', ''],
      ['<!--', '<!--', ''],
      ['<br', '<br', ''],
      ['<a', '<a', ''],
      ['<a closed by one final ">"', '<a', '>'],
      ['<br closed by one final ">"', '<br', '>'],
      ['unclosed quoted values', '<a href="x ', ''],
      ['</p with no ">"', '</p ', ''],
      ['entity-like text', '&a', ''],
    ])(
      'takes time linear in 1,250 to 20,000 repeats of %s',
      (_name, unit, tail) => {
        const small = unit.repeat(SMALL) + tail;
        const large = unit.repeat(LARGE) + tail;
        // A first pass flattens both strings and compiles the paths they take.
        htmlToText(small);
        htmlToText(large);
        let fastestSmall = Number.POSITIVE_INFINITY;
        let fastestLarge = Number.POSITIVE_INFINITY;
        for (let sample = 0; sample < SAMPLES; sample++) {
          fastestSmall = Math.min(fastestSmall, cpuMs(small));
          fastestLarge = Math.min(fastestLarge, cpuMs(large));
        }
        expect(fastestLarge).toBeLessThan(MAX_LARGE_MS);
        expect(fastestLarge / fastestSmall).toBeLessThan(MAX_RATIO);
      },
      REGRESSION_TIMEOUT_MS,
    );
  });

  describe('entities', () => {
    it.each([
      ['&amp;', '&'],
      ['&lt;', '<'],
      ['&gt;', '>'],
      ['&quot;', '"'],
      ['&apos;', "'"],
      ['&pound;', '£'],
      ['&euro;', '€'],
      ['&copy;', '©'],
      ['&mdash;', '—'],
      ['&ndash;', '–'],
      ['&hellip;', '…'],
      ['&eacute;', 'é'],
      ['&rsquo;', '’'],
      ['&AMP;', '&'],
    ])('decodes %s', (entity, expected) => {
      expect(htmlToText(`a${entity}b`)).toBe(`a${expected}b`);
    });

    it('decodes decimal and hexadecimal numeric entities', () => {
      expect(htmlToText('&#163;100 &#x41; &#X42; &#128512;')).toBe('£100 A B 😀');
    });

    it('leaves an unknown named entity as written', () => {
      expect(htmlToText('fish &chips; &notanentity;')).toBe('fish &chips; &notanentity;');
    });

    it('leaves a bare ampersand alone', () => {
      expect(htmlToText('Fish & chips &')).toBe('Fish & chips &');
    });

    it('decodes once: &amp;lt; becomes &lt;, not <', () => {
      expect(htmlToText('&amp;lt;b&amp;gt;')).toBe('&lt;b&gt;');
    });

    it('keeps decoded angle brackets as text rather than reading them as tags', () => {
      expect(htmlToText('&lt;b&gt;bold&lt;/b&gt; and &lt;script&gt;x&lt;/script&gt;')).toBe(
        '<b>bold</b> and <script>x</script>',
      );
    });

    it.each([
      ['NUL', '&#0;'],
      ['a C0 control', '&#7;'],
      ['an escape', '&#27;'],
      ['a C1 control', '&#x9B;'],
      ['a zero-width space', '&#x200B;'],
      ['a word joiner', '&#x2060;'],
      ['a byte order mark', '&#xFEFF;'],
      ['a right-to-left override', '&#x202E;'],
      ['a tag character', '&#xE0041;'],
      ['a lone surrogate', '&#xD800;'],
      ['a noncharacter', '&#xFDD0;'],
      ['a plane-end noncharacter', '&#x1FFFF;'],
      ['a code point beyond Unicode', '&#1114112;'],
    ])('leaves the numeric entity for %s as written', (_name, entity) => {
      expect(htmlToText(`a${entity}b`)).toBe(`a${entity}b`);
    });

    it.each([
      ['zero-width non-joiner', '&#x200C;', '\u{200C}'],
      ['zero-width joiner', '&#x200D;', '\u{200D}'],
    ])('decodes the %s', (_name, entity, char) => {
      expect(htmlToText(`a${entity}b`)).toBe(`a${char}b`);
    });

    it('keeps an encoded newline as a line break', () => {
      expect(htmlToText('a&#10;b')).toBe('a\nb');
    });

    it('treats a non-breaking space as whitespace', () => {
      expect(htmlToText('a&nbsp;&nbsp;b')).toBe('a b');
    });

    it.each(['constructor', 'toString', 'valueOf', 'hasOwnProperty', 'CONSTRUCTOR'])(
      'leaves &%s; as written rather than reading an object property',
      (name) => {
        expect(htmlToText(`&${name};`)).toBe(`&${name};`);
        expect(htmlToText(`<p>Hello &${name};</p>`)).toBe(`Hello &${name};`);
      },
    );
  });

  describe('invisible characters', () => {
    it.each([
      ['a tag character', '\u{E0041}'],
      ['the cancel tag', '\u{E007F}'],
      ['the language tag', '\u{E0001}'],
      ['a zero-width space', '\u{200B}'],
      ['a word joiner', '\u{2060}'],
      ['a byte order mark', '\u{FEFF}'],
      ['a right-to-left override', '\u{202E}'],
      ['a left-to-right mark', '\u{200E}'],
      ['a C0 control', '\u{7}'],
      ['a C1 control', '\u{9B}'],
    ])('removes %s from the text', (_name, char) => {
      expect(htmlToText(`<p>a${char}b</p>`)).toBe('ab');
    });

    it('removes a run of tag characters spelling hidden text', () => {
      expect(
        htmlToText('Ward panel\u{E0049}\u{E0047}\u{E004E}\u{E004F}\u{E0052}\u{E0045} end'),
      ).toBe('Ward panel end');
    });

    it.each([
      ['zero-width non-joiner', '\u{200C}'],
      ['zero-width joiner', '\u{200D}'],
    ])('keeps the %s', (_name, char) => {
      expect(htmlToText(`a${char}b`)).toBe(`a${char}b`);
    });

    it('keeps an emoji joined by zero-width joiners whole', () => {
      const family = '\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}';
      expect(htmlToText(`<p>${family}</p>`)).toBe(family);
    });

    it('turns a next-line character into a line break rather than joining the words', () => {
      expect(htmlToText('a\u{85}b')).toBe('a\nb');
    });

    it('still turns a tab between words into a space', () => {
      expect(htmlToText('one\ttwo')).toBe('one two');
    });
  });

  describe('text that only looks like markup', () => {
    it('keeps a bare less-than or greater-than in prose', () => {
      expect(htmlToText('Response time < 5 minutes and > 2')).toBe(
        'Response time < 5 minutes and > 2',
      );
    });

    it('keeps "a < b" without eating the text up to the next ">"', () => {
      expect(htmlToText('if a < b then c > d')).toBe('if a < b then c > d');
    });
  });

  describe('realistic fields', () => {
    it('converts a neighbourhood description', () => {
      const html =
        '<p>Welcome to Example Central &amp; the surrounding streets.</p><p>Your team:</p><ul><li>Example Officer (PC 0000)</li><li>Sample Sergeant</li></ul>';
      expect(htmlToText(html)).toBe(
        'Welcome to Example Central & the surrounding streets.\nYour team:\nExample Officer (PC 0000)\nSample Sergeant',
      );
    });

    it('converts a priority with a link and a heading', () => {
      expect(
        htmlToText(
          '<h3>Fly-tipping</h3><p>See <a href="https://example.test/p">the plan</a>&hellip;</p>',
        ),
      ).toBe('Fly-tipping\nSee the plan…');
    });
  });
});
