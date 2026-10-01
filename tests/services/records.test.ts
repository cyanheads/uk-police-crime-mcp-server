/**
 * @fileoverview The record normalizers: each route's wire shape field by field,
 * upstream sentinels (`""`, `0,0`, null and blank categoricals) read as absence,
 * the sort order each tool pages in, and that a normalizer never mutates the
 * parsed body it was handed.
 * @module tests/services/records.test
 */

import type { z } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';
import { RawCrimes, RawOutcomes, RawStops } from '@/services/police-api/raw-schemas.js';
import {
  normalizeCrimes,
  normalizeOutcomes,
  normalizeStops,
  toCoordinate,
} from '@/services/police-api/records.js';
import {
  areaOutcomeRecord,
  crimeRecord,
  crimesBody,
  outcomesBody,
  sparseCrimeRecord,
  sparseStopRecord,
  stopRecord,
  stopsBody,
  wireLocation,
} from '../fixtures/police-api-upstream.js';

const crimes = (...records: unknown[]) => normalizeCrimes(RawCrimes.parse(records));
const outcomes = (...records: unknown[]) => normalizeOutcomes(RawOutcomes.parse(records));
const stops = (...records: unknown[]) => normalizeStops(RawStops.parse(records));

/** Freezes a parsed body all the way down, so any write to it throws in strict mode. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

describe('toCoordinate', () => {
  it.each<[string | null | undefined, number | undefined]>([
    ['52.630000', 52.63],
    ['-1.1400000000', -1.14],
    ['0', 0],
    ['  1.5 ', 1.5],
    ['1e2', 100],
    ['', undefined],
    ['   ', undefined],
    ['abc', undefined],
    ['NaN', undefined],
    ['Infinity', undefined],
    [null, undefined],
    [undefined, undefined],
  ])('reads %j as %j', (input, expected) => {
    expect(toCoordinate(input)).toBe(expected);
  });
});

describe('normalizeCrimes', () => {
  it('writes the full wire shape: string ids, snake_case keys, nested location and outcome', () => {
    const [crime] = crimes(crimeRecord());
    expect(crime).toEqual({
      id: '100000001',
      persistent_id: 'a'.repeat(64),
      category: 'burglary',
      month: '2026-08',
      location: {
        location_id: '1000001',
        street_name: 'On or near Example Street',
        map_point: { latitude: 52.63, longitude: -1.13 },
        type: 'Force',
      },
      outcome: { name: 'Under investigation', month: '2026-08' },
    });
  });

  it('reads a numeric id and a string id the same way', () => {
    const [numeric, textual] = crimes(
      crimeRecord({ id: 42, location: wireLocation(7) }),
      crimeRecord({ id: '43', location: wireLocation('8') }),
    );
    expect(numeric?.id).toBe('42');
    expect(numeric?.location?.location_id).toBe('7');
    expect(textual?.id).toBe('43');
    expect(textual?.location?.location_id).toBe('8');
  });

  describe('absence', () => {
    it('drops an empty persistent id, empty context, empty subtype and a null outcome', () => {
      const [crime] = crimes(crimeRecord({ persistent_id: '', context: '', outcome_status: null }));
      expect(crime).not.toHaveProperty('persistent_id');
      expect(crime).not.toHaveProperty('context');
      expect(crime).not.toHaveProperty('outcome');
      expect(crime?.location).not.toHaveProperty('subtype');
    });

    it('drops a whitespace-only persistent id, context and subtype', () => {
      const [crime] = crimes(
        crimeRecord({ persistent_id: '   ', context: ' \t ', location_subtype: '  ' }),
      );
      expect(crime).not.toHaveProperty('persistent_id');
      expect(crime).not.toHaveProperty('context');
      expect(crime?.location).not.toHaveProperty('subtype');
    });

    it('drops a null location (an unplaced crime) and reads missing optional upstream fields', () => {
      const [crime] = crimes(sparseCrimeRecord());
      expect(crime).toEqual({
        id: '100000002',
        category: 'anti-social-behaviour',
        month: '2026-08',
      });
    });

    it('treats an absent location key like a null one', () => {
      const { location: _location, ...noLocation } = crimeRecord();
      const [crime] = crimes(noLocation);
      expect(crime).not.toHaveProperty('location');
    });

    it('keeps outcome text with a blank name as published (an outcome object is an outcome)', () => {
      const [crime] = crimes(crimeRecord({ outcome_status: { category: '', date: '2026-08' } }));
      expect(crime?.outcome).toEqual({ name: '', month: '2026-08' });
    });
  });

  describe('free text and subtype', () => {
    it('keeps context verbatim, line breaks included', () => {
      const [crime] = crimes(crimeRecord({ context: 'Line one\r\nLine two' }));
      expect(crime?.context).toBe('Line one\r\nLine two');
    });

    it('keeps a non-empty subtype and marks a BTP record', () => {
      const [crime] = crimes(
        crimeRecord({ location_type: 'BTP', location_subtype: 'Railway Station' }),
      );
      expect(crime?.location).toMatchObject({ type: 'BTP', subtype: 'Railway Station' });
    });

    it.each([[null], [''], ['Other'], ['force'], ['btp']])(
      'omits location type for %j (only Force and BTP are kept)',
      (locationType) => {
        const [crime] = crimes(crimeRecord({ location_type: locationType }));
        expect(crime?.location).not.toHaveProperty('type');
      },
    );

    it('omits location type when the upstream key is missing', () => {
      const { location_type: _type, ...rest } = crimeRecord();
      const [crime] = crimes(rest);
      expect(crime?.location).not.toHaveProperty('type');
    });
  });

  describe('map point', () => {
    it.each<[string, string | null, string | null, boolean]>([
      ['both parse', '52.63', '-1.13', true],
      ['one coordinate is 0', '0', '-1.13', true],
      ['both 0 (no map point within 20 km)', '0', '0', false],
      ['both 0.000000', '0.000000', '0.000000', false],
      ['latitude null', null, '-1.13', false],
      ['longitude null', '52.63', null, false],
      ['both null', null, null, false],
      ['latitude unparseable', 'x', '-1.13', false],
      ['longitude empty', '52.63', '', false],
    ])('%s → map_point present: %s', (_name, latitude, longitude, present) => {
      const [crime] = crimes(
        crimeRecord({ location: wireLocation(1_000_001, 'On or near X', latitude, longitude) }),
      );
      if (present) expect(crime?.location).toHaveProperty('map_point');
      else expect(crime?.location).not.toHaveProperty('map_point');
      expect(crime?.location?.location_id).toBe('1000001');
    });

    it('reads a location whose coordinate keys are missing altogether', () => {
      const [crime] = crimes(
        crimeRecord({ location: { street: { id: 5, name: 'On or near Nowhere' } } }),
      );
      expect(crime?.location).toEqual({
        location_id: '5',
        street_name: 'On or near Nowhere',
        type: 'Force',
      });
    });
  });

  describe('sort order', () => {
    it('sorts by category, then location_id with unplaced first, then id', () => {
      const sorted = crimes(
        crimeRecord({ id: 5, category: 'burglary', location: wireLocation(20) }),
        crimeRecord({ id: 4, category: 'burglary', location: wireLocation(3) }),
        crimeRecord({ id: 3, category: 'burglary', location: null }),
        crimeRecord({ id: 2, category: 'anti-social-behaviour', location: wireLocation(900) }),
        crimeRecord({ id: 1, category: 'burglary', location: wireLocation(3) }),
      );
      expect(sorted.map((crime) => crime.id)).toEqual(['2', '3', '1', '4', '5']);
    });

    it('orders digit ids by length first (shorter first), then code unit', () => {
      const sorted = crimes(
        crimeRecord({ id: 100, location: wireLocation(1_000_001) }),
        crimeRecord({ id: 99, location: wireLocation(999) }),
        crimeRecord({ id: 101, location: wireLocation(999) }),
        crimeRecord({ id: 20, location: wireLocation(999) }),
      );
      expect(sorted.map((crime) => crime.id)).toEqual(['20', '99', '101', '100']);
    });

    it('compares categories by code unit, independent of locale (uppercase before lowercase)', () => {
      const sorted = crimes(
        crimeRecord({ id: 1, category: 'a-category' }),
        crimeRecord({ id: 2, category: 'B-category' }),
      );
      expect(sorted.map((crime) => crime.category)).toEqual(['B-category', 'a-category']);
    });

    it('sorts the fixture body into tool order', () => {
      const sorted = normalizeCrimes(RawCrimes.parse(crimesBody()));
      expect(
        sorted.map((crime) => [crime.category, crime.location?.location_id, crime.id]),
      ).toEqual([
        ['anti-social-behaviour', '1000001', '100000050'],
        ['anti-social-behaviour', '1000003', '100000051'],
        ['burglary', '1000001', '100000030'],
        ['burglary', '1000001', '100000032'],
        ['burglary', '1000002', '100000031'],
        ['vehicle-crime', '1000001', '100000060'],
        ['violent-crime', '1000001', '100000040'],
      ]);
    });

    it('is deterministic whatever the upstream order', () => {
      const forward = normalizeCrimes(RawCrimes.parse(crimesBody()));
      const backward = normalizeCrimes(RawCrimes.parse(crimesBody().reverse()));
      expect(backward).toEqual(forward);
    });
  });

  it('returns [] for an empty body', () => {
    expect(normalizeCrimes([])).toEqual([]);
  });

  it('never mutates the body it was given, and returns a new array', () => {
    const raw = deepFreeze(RawCrimes.parse(crimesBody()));
    const before = structuredClone(raw);
    const out = normalizeCrimes(raw);
    expect(raw).toEqual(before);
    expect(out).not.toBe(raw);
    expect(raw.map((entry) => entry.id)).toEqual(before.map((entry) => entry.id));
  });

  it('does not share nested objects with the input (a later edit to the input cannot reach a record)', () => {
    const raw = RawCrimes.parse([crimeRecord()]);
    const [crime] = normalizeCrimes(raw);
    const first = raw[0];
    if (first?.location) first.location.street.name = 'changed';
    expect(crime?.location?.street_name).toBe('On or near Example Street');
  });
});

describe('normalizeOutcomes', () => {
  it('writes the wire shape: outcome code, name and month beside its crime without an outcome of its own', () => {
    const [outcome] = outcomes(areaOutcomeRecord());
    expect(outcome).toEqual({
      code: 'under-investigation',
      name: 'Under investigation',
      month: '2026-08',
      crime: {
        id: '100000001',
        persistent_id: 'a'.repeat(64),
        category: 'burglary',
        month: '2026-08',
        location: {
          location_id: '1000001',
          street_name: 'On or near Example Street',
          map_point: { latitude: 52.63, longitude: -1.13 },
          type: 'Force',
        },
      },
    });
    expect(outcome?.crime).not.toHaveProperty('outcome');
  });

  it('does not read person_id', () => {
    const [outcome] = outcomes(areaOutcomeRecord({ person_id: 'invented-person' }));
    expect(JSON.stringify(outcome)).not.toContain('invented-person');
  });

  it('applies the crime rules to the nested crime (sparse crime: no persistent id, no location)', () => {
    const [outcome] = outcomes(
      areaOutcomeRecord({ crime: sparseCrimeRecord({ id: 100_000_099 }) }),
    );
    expect(outcome?.crime).toEqual({
      id: '100000099',
      category: 'anti-social-behaviour',
      month: '2026-08',
    });
  });

  it('sorts by crime month newest first, then crime id by digit order', () => {
    const sorted = normalizeOutcomes(RawOutcomes.parse(outcomesBody()));
    expect(sorted.map((o) => [o.crime.month, o.crime.id])).toEqual([
      ['2026-07', '100000080'],
      ['2026-07', '100000082'],
      ['2026-05', '100000081'],
    ]);
  });

  it('orders ids by length before code unit', () => {
    const sorted = outcomes(
      areaOutcomeRecord({ crime: crimeRecord({ id: 100 }) }),
      areaOutcomeRecord({ crime: crimeRecord({ id: 99 }) }),
    );
    expect(sorted.map((o) => o.crime.id)).toEqual(['99', '100']);
  });

  it('sorts by the crime month, not by the outcome month', () => {
    const sorted = outcomes(
      areaOutcomeRecord({ date: '2026-08', crime: crimeRecord({ id: 1, month: '2025-01' }) }),
      areaOutcomeRecord({ date: '2026-08', crime: crimeRecord({ id: 2, month: '2026-06' }) }),
    );
    expect(sorted.map((o) => o.crime.month)).toEqual(['2026-06', '2025-01']);
  });

  it('never mutates the body it was given', () => {
    const raw = deepFreeze(RawOutcomes.parse(outcomesBody()));
    const before = structuredClone(raw);
    const out = normalizeOutcomes(raw);
    expect(raw).toEqual(before);
    expect(out).not.toBe(raw);
  });

  it('returns [] for an empty body', () => {
    expect(normalizeOutcomes([])).toEqual([]);
  });
});

describe('normalizeStops', () => {
  it('writes the wire shape for a fully populated stop; outcome_object and operation are dropped', () => {
    const [stop] = stops(stopRecord());
    expect(stop).toEqual({
      datetime: '2026-08-14T21:30:00+00:00',
      type: 'Person search',
      involved_person: true,
      gender: 'Male',
      age_range: '25-34',
      self_defined_ethnicity: 'White - English/Welsh/Scottish/Northern Irish/British',
      officer_defined_ethnicity: 'White',
      legislation: 'Misuse of Drugs Act 1971 (section 23)',
      object_of_search: 'Controlled drugs',
      outcome: 'A no further action disposal',
      outcome_linked_to_object_of_search: true,
      removal_of_more_than_outer_clothing: false,
      location: {
        location_id: '1000001',
        street_name: 'On or near Example Street',
        map_point: { latitude: 52.63, longitude: -1.13 },
      },
    });
    expect(stop).not.toHaveProperty('outcome_object');
    expect(stop).not.toHaveProperty('operation');
  });

  it('keeps operation_name when present', () => {
    const [stop] = stops(stopRecord({ operation_name: 'Operation Example' }));
    expect(stop?.operation_name).toBe('Operation Example');
  });

  it('reads every null categorical, a blank outcome and a null location as absence', () => {
    const [stop] = stops(sparseStopRecord());
    expect(stop).toEqual({
      datetime: '2026-08-02T03:10:00+00:00',
      type: 'Vehicle search',
      involved_person: false,
    });
  });

  it('keeps boolean false (a present value) and drops boolean null', () => {
    const [stop] = stops(
      stopRecord({
        involved_person: false,
        outcome_linked_to_object_of_search: false,
        removal_of_more_than_outer_clothing: null,
      }),
    );
    expect(stop?.involved_person).toBe(false);
    expect(stop?.outcome_linked_to_object_of_search).toBe(false);
    expect(stop).not.toHaveProperty('removal_of_more_than_outer_clothing');
  });

  it('drops an absent involved_person', () => {
    const { involved_person: _involved, ...rest } = stopRecord();
    const [stop] = stops(rest);
    expect(stop).not.toHaveProperty('involved_person');
  });

  it.each([
    'type',
    'gender',
    'age_range',
    'self_defined_ethnicity',
    'officer_defined_ethnicity',
    'legislation',
    'object_of_search',
    'outcome',
    'operation_name',
  ])('drops a whitespace-only %s', (field) => {
    const [stop] = stops(stopRecord({ [field]: '  \t ' }));
    expect(stop).not.toHaveProperty(field);
  });

  it('keeps categorical text verbatim (not trimmed, not re-cased)', () => {
    const [stop] = stops(
      stopRecord({ gender: ' Male ', object_of_search: 'ARTICLE for use in theft' }),
    );
    expect(stop?.gender).toBe(' Male ');
    expect(stop?.object_of_search).toBe('ARTICLE for use in theft');
  });

  it('gives a stop location no type or subtype (stop records carry neither)', () => {
    const [stop] = stops(stopRecord({ location_type: 'BTP', location_subtype: 'x' }));
    expect(stop?.location).not.toHaveProperty('type');
    expect(stop?.location).not.toHaveProperty('subtype');
  });

  it('drops the map point of a zero-zero stop location but keeps its street', () => {
    const [stop] = stops(
      stopRecord({
        location: wireLocation(1_000_005, 'On or near Zero Lane', '0.000000', '0.000000'),
      }),
    );
    expect(stop?.location).toEqual({ location_id: '1000005', street_name: 'On or near Zero Lane' });
  });

  describe('sort order', () => {
    it('sorts by datetime, then location_id with unplaced first', () => {
      const sorted = stops(
        stopRecord({ datetime: '2026-08-02T00:00:00+00:00', location: wireLocation(30) }),
        stopRecord({ datetime: '2026-08-02T00:00:00+00:00', location: null }),
        stopRecord({ datetime: '2026-08-01T23:59:59+00:00', location: wireLocation(999) }),
        stopRecord({ datetime: '2026-08-02T00:00:00+00:00', location: wireLocation(4) }),
      );
      expect(sorted.map((s) => [s.datetime, s.location?.location_id])).toEqual([
        ['2026-08-01T23:59:59+00:00', '999'],
        ['2026-08-02T00:00:00+00:00', undefined],
        ['2026-08-02T00:00:00+00:00', '4'],
        ['2026-08-02T00:00:00+00:00', '30'],
      ]);
    });

    it('keeps upstream order for stops that tie on datetime and location', () => {
      const sorted = stops(
        stopRecord({ datetime: '2026-08-02T00:00:00+00:00', gender: 'first' }),
        stopRecord({ datetime: '2026-08-02T00:00:00+00:00', gender: 'second' }),
        stopRecord({ datetime: '2026-08-02T00:00:00+00:00', gender: 'third' }),
      );
      expect(sorted.map((s) => s.gender)).toEqual(['first', 'second', 'third']);
    });

    it('sorts the fixture body into tool order', () => {
      const sorted = normalizeStops(RawStops.parse(stopsBody()));
      expect(sorted.map((s) => s.datetime)).toEqual([
        '2026-08-02T03:10:00+00:00',
        '2026-08-10T09:00:00+00:00',
        '2026-08-14T21:30:00+00:00',
        '2026-08-14T21:30:00+00:00',
        '2026-08-20T01:15:00+00:00',
        '2026-08-21T12:00:00+00:00',
      ]);
    });
  });

  it('never mutates the body it was given', () => {
    const raw = deepFreeze(RawStops.parse(stopsBody()));
    const before = structuredClone(raw);
    const out = normalizeStops(raw);
    expect(raw).toEqual(before);
    expect(out).not.toBe(raw);
  });

  it('returns [] for an empty body', () => {
    expect(normalizeStops([])).toEqual([]);
  });
});

describe('raw schemas under the normalizers', () => {
  it('strips upstream keys the server does not read', () => {
    type Parsed = z.output<typeof RawStops>[number];
    const [parsed] = RawStops.parse([stopRecord({ surprise: 'x' })]);
    expect(Object.keys(parsed as Parsed)).not.toContain('surprise');
    expect(Object.keys(parsed as Parsed)).not.toContain('operation');
    expect(Object.keys(parsed as Parsed)).not.toContain('outcome_object');
  });

  it('rejects a crime with no id, no category or no month', () => {
    for (const drop of ['id', 'category', 'month']) {
      const { [drop]: _gone, ...rest } = crimeRecord() as Record<string, unknown>;
      expect(RawCrimes.safeParse([rest]).success, drop).toBe(false);
    }
  });

  it('rejects a stop with no datetime', () => {
    const { datetime: _gone, ...rest } = stopRecord();
    expect(RawStops.safeParse([rest]).success).toBe(false);
  });

  it('rejects a location with no street', () => {
    expect(
      RawCrimes.safeParse([crimeRecord({ location: { latitude: '1', longitude: '2' } })]).success,
    ).toBe(false);
  });
});
