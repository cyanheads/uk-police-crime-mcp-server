/**
 * @fileoverview The shared name matcher at its own seam: the word split, the
 * name rule ukcrime_list_reference's `name_contains` runs on (punctuation in the
 * value splitting words, a name's `&` also read as "and"), the property that
 * every value the matcher before the move accepted for a name still matches it,
 * the street rule (`On or near` dropped from both sides, a bare prefix never
 * matching) over Leicester-style street names, and CPU time linear in the input
 * on every shape its regexes see.
 * @module tests/shared/name-matcher.test
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  filterByName,
  nameMatcher,
  nameWords,
  streetMatcher,
  streetPart,
  streetWords,
} from '@/mcp-server/tools/name-matcher.js';
import { STREET_ROWS } from '../fixtures/police-api-upstream.js';

/**
 * `ukcrime_list_reference`'s matcher before it moved to the shared module,
 * copied verbatim (renamed): the reference the property compares against.
 */
const normalizeName = (text: string): string =>
  text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}\s]/gu, '');

/** Strict token match over `name`: every token of `query` must appear. No query keeps every entry. */
function previousFilterByName<T extends { readonly name: string }>(
  entries: readonly T[],
  query: string | undefined,
): readonly T[] {
  if (query === undefined) return entries;
  const tokens = normalizeName(query).split(/\s+/).filter(Boolean);
  return entries.filter((entry) => {
    const haystack = normalizeName(entry.name);
    return tokens.every((token) => haystack.includes(token));
  });
}

const matchedBefore = (value: string, name: string): boolean =>
  previousFilterByName([{ name }], value).length === 1;

describe('nameWords', () => {
  it.each<[string, string[]]>([
    ['Granby Street', ['granby', 'street']],
    ['  GRANBY\tstreet ', ['granby', 'street']],
    ['granby-street', ['granby', 'street']],
    ["St. Mary's", ['st', 'mary', 's']],
    ['Devon & Cornwall', ['devon', 'cornwall']],
    ['CAFÉ', ['cafe']],
    ['café', ['cafe']],
    ['ｄｅｖｏｎ', ['devon']],
    ['A1 road', ['a1', 'road']],
    ['', []],
    ['- & ...', []],
  ])('%j → %j', (value, words) => {
    expect(nameWords(value)).toEqual(words);
  });
});

describe('nameMatcher (the name_contains rule)', () => {
  it.each<[string, string, boolean]>([
    ['manchester greater', 'Greater Manchester Police', true],
    ['POLICE MANCHESTER', 'Greater Manchester Police', true],
    ['manchester leicestershire', 'Greater Manchester Police', false],
    ['Devon & Cornwall', 'Devon & Cornwall Police', true],
    ['devon cornwall', 'Devon & Cornwall Police', true],
    ['devon and cornwall', 'Devon & Cornwall Police', true],
    ['devon-and-cornwall', 'Devon & Cornwall Police', true],
    ['devon and cornwall', 'Devon ＆ Cornwall Police', true],
    ['avon & somerset', 'Avon and Somerset Constabulary', true],
    ['avon and somerset', 'Avon and Somerset Constabulary', true],
    ['att', 'AT&T', true],
    ['at and t', 'AT&T', true],
    ['and', 'Greater Manchester Police', false],
    ['dyfed powys', 'Dyfed-Powys Police', true],
    ['dyfed-powys', 'Dyfed-Powys Police', true],
    ['cafe', 'Café Quarter', true],
    ['CAFÉ quarter', 'Café Quarter', true],
    ['st marys', "St. Mary's Ward", true],
    ['st-marys', "St. Mary's Ward", true],
    ['ward mary', "St. Mary's Ward", true],
    ['mary ward st', "St. Mary's Ward", true],
    ['marys-ward', "St. Mary's Ward", true],
    ['wards', "St. Mary's Ward", false],
  ])('%j against %j → %s', (value, name, expected) => {
    expect(nameMatcher(value)(name)).toBe(expected);
  });

  it('filterByName keeps every entry, the same array, when no value is given', () => {
    const entries = [{ name: 'A' }, { name: 'B' }];
    expect(filterByName(entries, undefined)).toBe(entries);
  });

  it('filterByName keeps the matching entries in their order', () => {
    const entries = [
      { id: 1, name: 'Harbour East' },
      { id: 2, name: 'Meadows' },
      { id: 3, name: 'East Harbour' },
    ];
    expect(filterByName(entries, 'harbour east').map((entry) => entry.id)).toEqual([1, 3]);
    expect(filterByName(entries, 'nowhere')).toEqual([]);
  });

  describe('every value that matched a name before the move still matches it', () => {
    /** Letters, digits, cases, accents both composed and combining, whitespace, and the punctuation the two rules treat differently. */
    const unit = fc.constantFrom(
      ...['a', 'b', 'n', 'd', 'A', 'N', 'D', 'é', 'É', '́', '1', ' ', '\t'],
      ...['&', '＆', '-', '.', "'", '/', ',', 'ß', 'İ', 'Σ', '℡'],
    );
    const text = fc.string({ unit, maxLength: 12 });

    it('for independent values and names', () => {
      fc.assert(
        fc.property(
          text,
          text,
          (value, name) => !matchedBefore(value, name) || nameMatcher(value)(name),
        ),
        { numRuns: 5000 },
      );
    });

    it('for names built around the value, where the matcher before the move mostly matched', () => {
      let matched = 0;
      fc.assert(
        fc.property(text, text, text, (before, value, after) => {
          const name = `${before}${value}${after}`;
          if (!matchedBefore(value, name)) return true;
          matched += 1;
          return nameMatcher(value)(name);
        }),
        { numRuns: 5000 },
      );
      expect(matched).toBeGreaterThan(2500);
    });

    it('for names that are the value with punctuation, & among it, inserted between its characters', () => {
      const between = fc.array(fc.constantFrom('', '&', '＆', '-', "'", '.'), { maxLength: 13 });
      let matched = 0;
      fc.assert(
        fc.property(text, between, (value, inserts) => {
          const name = [...value].map((char, i) => `${inserts[i] ?? ''}${char}`).join('');
          if (!matchedBefore(value, name)) return true;
          matched += 1;
          return nameMatcher(value)(name);
        }),
        { numRuns: 5000 },
      );
      expect(matched).toBeGreaterThan(2500);
    });

    it('for the cases that need both readings of a name: an & deleted, and an & as "and"', () => {
      for (const [value, name] of [
        ['att', 'AT&T'],
        ['AT&T', 'ATT Ltd'],
        ['b&q', 'B&Q Store'],
      ] as const) {
        expect(matchedBefore(value, name), `${value} / ${name} before`).toBe(true);
        expect(nameMatcher(value)(name), `${value} / ${name} now`).toBe(true);
      }
    });
  });
});

describe('streetWords', () => {
  it.each<[string, string[]]>([
    ['On or near Granby Street', ['granby', 'street']],
    ['on-or-near granby', ['granby']],
    ['ON OR NEAR, Granby', ['granby']],
    ['On or near', []],
    ['on or near  ...', []],
    ['near', ['near']],
    ['on or', ['on', 'or']],
    ['granby on or near', ['granby', 'on', 'or', 'near']],
  ])('%j → %j', (value, words) => {
    expect(streetWords(value)).toEqual(words);
  });
});

describe('streetPart', () => {
  it.each<[string, string | undefined]>([
    ['On or near Granby Street', 'Granby Street'],
    ['On or near Theatre/concert Hall', 'Theatre/concert Hall'],
    ['  on  OR near   Granby Street ', 'Granby Street'],
    ['On or near ', undefined],
    ['On or near', undefined],
    ['   ', undefined],
    ['On or nearby Road', 'On or nearby Road'],
    ['Granby Street', 'Granby Street'],
  ])('%j → %j', (streetName, part) => {
    expect(streetPart(streetName)).toBe(part);
  });
});

describe('streetMatcher (the street_name_contains rule) over Leicester-style street names', () => {
  const names = STREET_ROWS.map(({ name }) => name);
  const matching = (value: string) => names.filter(streetMatcher(value));

  it.each([
    'granby street',
    'Granby St',
    'GRANBY STREET',
    'granby-street',
    'On or near Granby Street',
    'street granby',
  ])('%j finds Granby Street and nothing else', (value) => {
    expect(matching(value)).toEqual(['On or near Granby Street']);
  });

  it.each<[string, string[]]>([
    ['granby', ['On or near Granby Street', 'On or near Granby Place']],
    ['high street', ['On or near Highcross Street', 'On or near Highfield Street']],
    ['concert hall', ['On or near Theatre/concert Hall']],
    ['Theatre/Concert', ['On or near Theatre/concert Hall']],
    ["siemen's", ["On or near Siemen'S Street"]],
    ['belgrave gate', ['On or near Belgrave-Gate']],
    ['near', []],
    ['on', ['On or near Theatre/concert Hall']],
    ['zzzz', []],
  ])('%j finds %j', (value, expected) => {
    expect(matching(value)).toEqual(expected);
  });

  it('never matches a bare "On or near ", whatever the value', () => {
    for (const value of ['granby', 'near', 'on or near x', 'a']) {
      expect(streetMatcher(value)('On or near '), value).toBe(false);
    }
  });

  it('drops the prefix from the published name only at its start, as a whole word', () => {
    expect(streetMatcher('nearby')('On or nearby Road')).toBe(true);
    expect(streetMatcher('near')('On or near Near Lane')).toBe(true);
  });
});

/**
 * CPU time per call, in this thread's own CPU clock (other load on the machine
 * barely moves it), for the value path the input schema's check runs on any
 * length (`streetWords`) and the name path every upstream street name takes
 * (`streetMatcher`). Each size doubles the last from 5,000 characters, is held
 * to an absolute bound before the next runs, and is timed beside a fresh
 * 5,000-character baseline; the growth asserted is the least over those pairs,
 * so a pause or a slower core only ever adds time to one side of one pair.
 */
describe('time stays linear in the input (timing)', () => {
  const BASE = 5_000;
  const SAMPLES = 5;
  /** Characters each timed batch covers, so a 5,000-character call is timed 50 at a time, well above the clock's resolution. */
  const BATCH_CHARS = 250_000;
  /** About 20 times the slowest shape measured (an `&` run, ~0.04 ms per 1,000 characters); a quadratic scan takes seconds by 80,000. */
  const MS_PER_THOUSAND = 0.8;

  const fill = (unit: string, size: number, tail = ''): string =>
    unit.repeat(Math.ceil(size / unit.length)).slice(0, size - tail.length) + tail;

  /** Per-call CPU milliseconds of `run(input)` over one batch. */
  const perCall = (run: (input: string) => unknown, input: string): number => {
    const times = Math.max(1, Math.round(BATCH_CHARS / input.length));
    const start = process.threadCpuUsage();
    for (let i = 0; i < times; i++) run(input);
    const spent = process.threadCpuUsage(start);
    return (spent.user + spent.system) / 1000 / times;
  };

  /** The least growth over the 5,000 baseline at `top`, every doubling on the way held to the absolute bound. */
  const growthTo = (
    run: (input: string) => unknown,
    shape: (size: number) => string,
    top: number,
  ): number => {
    const base = shape(BASE);
    let growth = Number.POSITIVE_INFINITY;
    for (let size = BASE * 2; size <= top; size *= 2) {
      const input = shape(size);
      run(base);
      run(input);
      const pairs = Array.from({ length: SAMPLES }, () => {
        const small = perCall(run, base);
        return { small, large: perCall(run, input) };
      });
      const fastest = Math.min(...pairs.map(({ large }) => large));
      expect(fastest, `${size} characters`).toBeLessThan((size / 1000) * MS_PER_THOUSAND);
      growth = Math.min(...pairs.map(({ small, large }) => large / small));
    }
    return growth;
  };

  const runs = {
    streetWords: (input: string) => streetWords(input),
    streetMatcher: streetMatcher('granby street'),
  };

  /** Every shape the matcher's regexes treat specially, two line-break shapes among them. */
  const shapes: Record<string, (size: number) => string> = {
    'the prefix repeated': (size) => fill('on or near ', size),
    'a whitespace run before one letter': (size) => fill(' ', size, 'x'),
    'a whitespace run between two letters': (size) => `x${' '.repeat(size - 2)}x`,
    'the prefix, then a whitespace run before one letter': (size) =>
      `On or near${' '.repeat(size - 11)}x`,
    '"on" then whitespace': (size) => `on${' '.repeat(size - 2)}`,
    'an & run': (size) => fill('&', size),
    'combining marks': (size) => fill('é', size),
    'one long line ending in a break': (size) => fill('§1 x', size, '\ny'),
    'breaks throughout': (size) => fill('  \r\n', size),
  };

  for (const [name, run] of Object.entries(runs)) {
    it(`${name}: a digit run grows 64-fold, 5,000 to 320,000 characters, in under 256 times the time (timing)`, () => {
      expect(growthTo(run, (size) => `On or near ${'1'.repeat(size - 11)}`, 320_000)).toBeLessThan(
        256,
      );
    }, 0);

    it.each(Object.entries(shapes))(
      `${name}: %s grows 16-fold, 5,000 to 80,000 characters, in under 64 times the time (timing)`,
      (_shape, shape) => {
        expect(growthTo(run, shape, 80_000)).toBeLessThan(64);
      },
      0,
    );
  }
});
