/**
 * @fileoverview known-gaps: the static coverage table, the coverage-notes helper
 * that attaches the verified date to every fact, the `gaps` string for a force,
 * and the 180-day staleness warning.
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

  it('uses only the three source pages the design names', () => {
    const sources = new Set(KNOWN_GAPS.map((gap) => gap.source));
    expect([...sources].sort()).toEqual([
      'https://data.police.uk/about/#qa',
      'https://data.police.uk/changelog/#known-issues',
      'https://data.police.uk/docs/method/outcomes-at-location/',
    ]);
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
        'btp:outcomes',
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
      'btp:outcomes',
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
    ['btp', 'crime', false],
    ['leicestershire', 'crime', false],
  ])('%s %s → %s', (force, aspect, expected) => {
    expect(publishesNothing(force, aspect)).toBe(expected);
  });
});

describe('coverageNotes', () => {
  it('returns nothing for a force the table does not mention', () => {
    expect(coverageNotes('leicestershire')).toEqual([]);
    expect(coverageNotes('')).toEqual([]);
  });

  it('renders each fact as its text plus the dated attribution, ending in a period', () => {
    const notes = coverageNotes('greater-manchester');
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
      expect(coverageNotes(force)).toEqual(expected);
    }
  });

  it('attaches the verified date to every table-drawn string, whichever force', () => {
    for (const gap of KNOWN_GAPS) {
      for (const note of coverageNotes(gap.force)) {
        expect(note).toContain(`verified ${KNOWN_GAPS_VERIFIED}`);
      }
    }
  });

  it('narrows to the aspects asked for', () => {
    const outcomes = coverageNotes('greater-manchester', ['outcomes']);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toContain('outcome data');
    expect(coverageNotes('greater-manchester', ['crime', 'outcomes'])).toHaveLength(2);
    expect(coverageNotes('greater-manchester', ['asb'])).toEqual([]);
  });

  it('returns nothing for an empty aspect list, not everything', () => {
    expect(coverageNotes('greater-manchester', [])).toEqual([]);
  });

  it('returns nothing when the force has facts but none for the aspect', () => {
    expect(coverageNotes('avon-and-somerset', ['outcomes'])).toEqual([]);
    expect(coverageNotes('avon-and-somerset', ['locations'])).toHaveLength(1);
  });

  it('matches force ids exactly, not by substring', () => {
    expect(coverageNotes('manchester')).toEqual([]);
    expect(coverageNotes('greater-manchester-extra')).toEqual([]);
    expect(coverageNotes('Greater-Manchester')).toEqual([]);
  });

  it('returns a fresh array each call', () => {
    const first = coverageNotes('btp');
    first.push('mutated');
    expect(coverageNotes('btp')).not.toContain('mutated');
  });
});

describe('forceGaps', () => {
  it('is undefined for a force with no recorded gaps', () => {
    expect(forceGaps('leicestershire')).toBeUndefined();
  });

  it('joins a force facts into one string, each fragment dated', () => {
    const gaps = forceGaps('btp');
    expect(gaps).toBe(coverageNotes('btp').join(' '));
    expect(gaps?.match(/verified 2026-10-01/g)).toHaveLength(2);
  });

  it('is a single dated sentence for a force with one fact', () => {
    const gaps = forceGaps('devon-and-cornwall');
    expect(gaps).toBe(coverageNotes('devon-and-cornwall')[0]);
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
