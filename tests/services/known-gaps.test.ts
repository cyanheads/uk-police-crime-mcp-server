/**
 * @fileoverview known-gaps: the static coverage table, the coverage-notes helper
 * that attaches the verified date to every fact, the facts that start at a month
 * (none before it, every month from it on), the `gaps` string for a force, and
 * the 180-day staleness warning.
 * @module tests/services/known-gaps.test
 */

import { describe, expect, it } from 'vitest';
import {
  coverageNotes,
  forceGaps,
  KNOWN_GAPS,
  KNOWN_GAPS_MAX_AGE_DAYS,
  KNOWN_GAPS_VERIFIED,
  type KnownGapAspect,
  knownGapsAgeWarning,
  publishesNothing,
} from '@/services/police-api/known-gaps.js';

const DAY_MS = 86_400_000;
const verifiedAt = Date.parse(`${KNOWN_GAPS_VERIFIED}T00:00:00Z`);
const SUFFIX = `(data.police.uk known issues, verified ${KNOWN_GAPS_VERIFIED}).`;
const ASPECTS: readonly KnownGapAspect[] = ['asb', 'crime', 'locations', 'outcomes'];
/** A month on or after every dated fact's from-month, so every fact applies. */
const LATE = ['2026-09'] as const;

describe('known-gaps table', () => {
  it('has a verified date that parses as a real calendar date', () => {
    expect(KNOWN_GAPS_VERIFIED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isNaN(verifiedAt)).toBe(false);
    expect(new Date(verifiedAt).toISOString().slice(0, 10)).toBe(KNOWN_GAPS_VERIFIED);
  });

  it('is not dated in the future', () => {
    expect(verifiedAt).toBeLessThanOrEqual(Date.now());
  });

  it('names a data.police.uk source page on every entry', () => {
    expect(KNOWN_GAPS.length).toBeGreaterThan(0);
    for (const gap of KNOWN_GAPS) {
      expect(gap.source).toMatch(/^https:\/\/data\.police\.uk\//);
    }
  });

  it('uses only the four source pages the design names', () => {
    const sources = new Set(KNOWN_GAPS.map((gap) => gap.source));
    expect([...sources].sort()).toEqual([
      'https://data.police.uk/about/#qa',
      'https://data.police.uk/changelog/',
      'https://data.police.uk/changelog/#known-issues',
      'https://data.police.uk/docs/method/outcomes-at-location/',
    ]);
  });

  it('dates exactly the facts that start at a month, each read from the release notes and naming its month', () => {
    const dated = KNOWN_GAPS.filter((gap) => gap.fromMonth !== undefined);
    expect(dated.map((gap) => `${gap.force}:${gap.aspect}:${gap.fromMonth}`).sort()).toEqual([
      'btp:crime:2025-02',
      'gloucestershire:crime:2026-02',
      'gloucestershire:outcomes:2026-02',
    ]);
    for (const gap of dated) {
      expect(gap.fromMonth).toMatch(/^\d{4}-(0[1-9]|1[0-2])$/);
      expect(gap.text).toContain(`since ${gap.fromMonth}`);
      expect(gap.source).toBe('https://data.police.uk/changelog/');
    }
  });

  it('gives every entry a force, a known aspect and one sentence without a closing period', () => {
    const aspects: readonly KnownGapAspect[] = ['asb', 'crime', 'locations', 'outcomes'];
    for (const gap of KNOWN_GAPS) {
      expect(gap.force).toMatch(/^[a-z]+(-[a-z]+)*$/);
      expect(aspects).toContain(gap.aspect);
      expect(gap.text.trim()).toBe(gap.text);
      expect(gap.text.length).toBeGreaterThan(20);
      expect(gap.text.endsWith('.')).toBe(false);
    }
  });

  it('carries the facts the design records', () => {
    const pairs = KNOWN_GAPS.map((gap) => `${gap.force}:${gap.aspect}`);
    expect(pairs).toEqual(
      expect.arrayContaining([
        'greater-manchester:crime',
        'greater-manchester:outcomes',
        'northern-ireland:crime',
        'northern-ireland:outcomes',
        'devon-and-cornwall:outcomes',
        'avon-and-somerset:locations',
        'btp:asb',
        'btp:crime',
        'btp:outcomes',
        'gloucestershire:crime',
        'gloucestershire:outcomes',
      ]),
    );
  });

  it('never records a stop-and-search fact (that is read live)', () => {
    for (const gap of KNOWN_GAPS) {
      expect(gap.text).not.toMatch(/stop(s)?[ -]and[ -]search/i);
    }
  });

  it('has no duplicate force and aspect pair', () => {
    const pairs = KNOWN_GAPS.map((gap) => `${gap.force}:${gap.aspect}`);
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it('marks exactly the facts that say a force publishes nothing for an aspect', () => {
    const marked = KNOWN_GAPS.filter((gap) => gap.nothingPublished).map(
      (gap) => `${gap.force}:${gap.aspect}`,
    );
    expect(marked.sort()).toEqual([
      'btp:asb',
      'btp:crime',
      'btp:outcomes',
      'gloucestershire:crime',
      'gloucestershire:outcomes',
      'greater-manchester:crime',
      'greater-manchester:outcomes',
      'northern-ireland:outcomes',
    ]);
  });
});

describe('publishesNothing', () => {
  it.each<[string, KnownGapAspect, boolean]>([
    ['greater-manchester', 'crime', true],
    ['northern-ireland', 'outcomes', true],
    ['northern-ireland', 'crime', false],
    ['devon-and-cornwall', 'outcomes', false],
    ['leicestershire', 'crime', false],
  ])('%s %s → %s', (force, aspect, expected) => {
    expect(publishesNothing([force], aspect, ['2026-07'])).toBe(expected);
  });

  it.each<[string, string, KnownGapAspect, readonly string[], boolean]>([
    ['the month before the from-month', 'btp', 'crime', ['2025-01'], false],
    ['the from-month itself', 'btp', 'crime', ['2025-02'], true],
    ['months after it', 'btp', 'crime', ['2025-03', '2026-08'], true],
    ['a range spanning it', 'btp', 'crime', ['2024-12', '2025-01', '2025-02', '2025-03'], false],
    ['the month before the from-month', 'gloucestershire', 'crime', ['2026-01'], false],
    ['the from-month itself', 'gloucestershire', 'crime', ['2026-02'], true],
    ['a range spanning it', 'gloucestershire', 'crime', ['2026-01', '2026-02'], false],
    ['the month before the from-month', 'gloucestershire', 'outcomes', ['2026-01'], false],
    ['the from-month itself', 'gloucestershire', 'outcomes', ['2026-02'], true],
    ['an undated fact in the earliest month', 'greater-manchester', 'crime', ['2023-09'], true],
  ])('%s: %s %s %j → %s', (_name, force, aspect, months, expected) => {
    expect(publishesNothing([force], aspect, months)).toBe(expected);
  });

  it.each<[string, readonly string[], KnownGapAspect, readonly string[], boolean]>([
    ['no force known', [], 'outcomes', ['2026-07'], false],
    [
      'every force silent',
      ['greater-manchester', 'northern-ireland'],
      'outcomes',
      ['2026-07'],
      true,
    ],
    [
      'one force publishing',
      ['northern-ireland', 'leicestershire'],
      'outcomes',
      ['2026-07'],
      false,
    ],
    [
      'a dated and an undated silent force, inside the dated one',
      ['gloucestershire', 'greater-manchester'],
      'crime',
      ['2026-08'],
      true,
    ],
    [
      'a dated and an undated silent force, before the dated one',
      ['gloucestershire', 'greater-manchester'],
      'crime',
      ['2026-01'],
      false,
    ],
    [
      'a dated and an undated silent force, a range spanning the dated one',
      ['gloucestershire', 'greater-manchester'],
      'crime',
      ['2026-01', '2026-02'],
      false,
    ],
    [
      'a dated silent force beside one publishing',
      ['gloucestershire', 'leicestershire'],
      'crime',
      ['2026-08'],
      false,
    ],
  ])('a list: %s → %s', (_name, forces, aspect, months, expected) => {
    expect(publishesNothing(forces, aspect, months)).toBe(expected);
  });
});

describe('coverageNotes', () => {
  it('returns nothing for a force the table does not mention', () => {
    expect(coverageNotes('leicestershire', ASPECTS, LATE)).toEqual([]);
    expect(coverageNotes('', ASPECTS, LATE)).toEqual([]);
  });

  it('renders each fact as its text plus the dated attribution, ending in a period', () => {
    const notes = coverageNotes('greater-manchester', ASPECTS, LATE);
    expect(notes).toHaveLength(2);
    for (const note of notes) {
      expect(note.endsWith(SUFFIX)).toBe(true);
      expect(note).not.toContain('..');
    }
    expect(notes[0]).toContain('Greater Manchester Police publishes no crime data');
  });

  it('returns one note per table entry for the force, in table order', () => {
    for (const force of new Set(KNOWN_GAPS.map((gap) => gap.force))) {
      const expected = KNOWN_GAPS.filter((gap) => gap.force === force).map(
        (gap) => `${gap.text} ${SUFFIX}`,
      );
      expect(coverageNotes(force, ASPECTS, LATE)).toEqual(expected);
    }
  });

  it('attaches the verified date to every table-drawn string, whichever force', () => {
    for (const gap of KNOWN_GAPS) {
      for (const note of coverageNotes(gap.force, ASPECTS, LATE)) {
        expect(note).toContain(`verified ${KNOWN_GAPS_VERIFIED}`);
      }
    }
  });

  it('narrows to the aspects asked for', () => {
    const outcomes = coverageNotes('greater-manchester', ['outcomes'], LATE);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toContain('outcome data');
    expect(coverageNotes('greater-manchester', ['crime', 'outcomes'], LATE)).toHaveLength(2);
    expect(coverageNotes('greater-manchester', ['asb'], LATE)).toEqual([]);
  });

  it('returns nothing for an empty aspect list, not everything', () => {
    expect(coverageNotes('greater-manchester', [], LATE)).toEqual([]);
  });

  it('returns nothing when the force has facts but none for the aspect', () => {
    expect(coverageNotes('avon-and-somerset', ['outcomes'], LATE)).toEqual([]);
    expect(coverageNotes('avon-and-somerset', ['locations'], LATE)).toHaveLength(1);
  });

  it('matches force ids exactly, not by substring', () => {
    expect(coverageNotes('manchester', ASPECTS, LATE)).toEqual([]);
    expect(coverageNotes('greater-manchester-extra', ASPECTS, LATE)).toEqual([]);
    expect(coverageNotes('Greater-Manchester', ASPECTS, LATE)).toEqual([]);
  });

  it('returns a fresh array each call', () => {
    const first = coverageNotes('btp', ASPECTS, LATE);
    first.push('mutated');
    expect(coverageNotes('btp', ASPECTS, LATE)).not.toContain('mutated');
  });

  it('gives a dated fact no note before its from-month, its note from that month on, and its note for a range spanning it', () => {
    const btpCrime = (months: readonly string[]) => coverageNotes('btp', ['crime'], months);
    const note = `British Transport Police has sent no crime data to data.police.uk since 2025-02, so its crime counts from that month on do not measure crime ${SUFFIX}`;
    expect(btpCrime(['2025-01'])).toEqual([]);
    expect(btpCrime(['2024-12', '2025-01'])).toEqual([]);
    expect(btpCrime(['2025-02'])).toEqual([note]);
    expect(btpCrime(['2026-08'])).toEqual([note]);
    expect(btpCrime(['2024-12', '2025-01', '2025-02', '2025-03'])).toEqual([note]);
  });

  it('starts both Gloucestershire facts at 2026-02', () => {
    expect(coverageNotes('gloucestershire', ['crime', 'outcomes'], ['2026-01'])).toEqual([]);
    expect(coverageNotes('gloucestershire', ['crime', 'outcomes'], ['2026-02'])).toEqual([
      `Gloucestershire Constabulary has sent no crime data to data.police.uk since 2026-02, so its crime counts from that month on do not measure crime ${SUFFIX}`,
      `Gloucestershire Constabulary has sent no outcome data to data.police.uk since 2026-02, so its outcome counts from that month on do not measure police outcomes ${SUFFIX}`,
    ]);
    expect(coverageNotes('gloucestershire', ['outcomes'], ['2026-01', '2026-02'])).toHaveLength(1);
  });

  it('applies an undated fact whatever the months', () => {
    const early = coverageNotes('greater-manchester', ['crime'], ['2023-09']);
    expect(early).toHaveLength(1);
    expect(early).toEqual(coverageNotes('greater-manchester', ['crime'], LATE));
  });
});

describe('forceGaps', () => {
  it('is undefined for a force with no recorded gaps', () => {
    expect(forceGaps('leicestershire')).toBeUndefined();
  });

  it('joins every fact for a force into one string, a dated one included with its month, each fragment dated', () => {
    const gaps = forceGaps('btp');
    expect(gaps).toBe(
      KNOWN_GAPS.filter((gap) => gap.force === 'btp')
        .map((gap) => `${gap.text} ${SUFFIX}`)
        .join(' '),
    );
    expect(gaps?.match(new RegExp(`verified ${KNOWN_GAPS_VERIFIED}`, 'g'))).toHaveLength(3);
    expect(gaps).toContain(
      'British Transport Police has sent no crime data to data.police.uk since 2025-02',
    );
  });

  it('names the from-month of every dated fact', () => {
    expect(forceGaps('gloucestershire')?.match(/since 2026-02/g)).toHaveLength(2);
  });

  it('is a single dated sentence for a force with one fact', () => {
    const gaps = forceGaps('devon-and-cornwall');
    expect(gaps).toBe(coverageNotes('devon-and-cornwall', ASPECTS, LATE)[0]);
    expect(gaps?.endsWith(SUFFIX)).toBe(true);
  });
});

describe('knownGapsAgeWarning', () => {
  it('is quiet on the day it was verified', () => {
    expect(knownGapsAgeWarning(verifiedAt)).toBeUndefined();
  });

  it('is quiet up to and including 180 days', () => {
    expect(KNOWN_GAPS_MAX_AGE_DAYS).toBe(180);
    expect(knownGapsAgeWarning(verifiedAt + 180 * DAY_MS)).toBeUndefined();
  });

  it('counts whole days: 180 days and 23 hours is still 180', () => {
    expect(knownGapsAgeWarning(verifiedAt + 180 * DAY_MS + 23 * 3_600_000)).toBeUndefined();
  });

  it('warns from 181 days, naming the age and the verified date', () => {
    const warning = knownGapsAgeWarning(verifiedAt + 181 * DAY_MS);
    expect(warning).toContain('181 days ago');
    expect(warning).toContain(KNOWN_GAPS_VERIFIED);
    expect(warning).toMatch(/re-read/);
  });

  it('keeps counting beyond the threshold', () => {
    expect(knownGapsAgeWarning(verifiedAt + 400 * DAY_MS)).toContain('400 days ago');
  });

  it('is quiet when the clock is before the verified date', () => {
    expect(knownGapsAgeWarning(verifiedAt - 5 * DAY_MS)).toBeUndefined();
  });
});
