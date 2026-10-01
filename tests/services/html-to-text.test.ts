/**
 * @fileoverview htmlToText: the plain text `structuredContent` carries for the
 * HTML fields data.police.uk serves — tags dropped, block ends to newlines,
 * entities decoded once, blank-line runs collapsed, empty to undefined.
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
      ['a lone surrogate', '&#xD800;'],
      ['a code point beyond Unicode', '&#1114112;'],
    ])('drops %s', (_name, entity) => {
      expect(htmlToText(`a${entity}b`)).toBe('ab');
    });

    it('keeps an encoded newline as a line break', () => {
      expect(htmlToText('a&#10;b')).toBe('a\nb');
    });

    it('treats a non-breaking space as whitespace', () => {
      expect(htmlToText('a&nbsp;&nbsp;b')).toBe('a b');
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
