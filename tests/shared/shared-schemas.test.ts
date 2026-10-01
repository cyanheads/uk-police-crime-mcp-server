/**
 * @fileoverview The shared input vocabulary and attribution: blank values read
 * as unset on every optional field, normalization runs before each pattern, the
 * patterns hold at their boundaries, and the polygon input accepts the upstream
 * string form while bounding its own error output.
 * @module tests/shared/shared-schemas.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';
import {
  ATTRIBUTION,
  blankAsUnset,
  categoryInput,
  forceInput,
  latInput,
  limitInput,
  lngInput,
  locationIdInput,
  monthInput,
  nameContainsInput,
  neighbourhoodIdInput,
  offsetInput,
  POLYGON_MAX_VERTICES,
  polygonInput,
} from '@/mcp-server/tools/shared-schemas.js';

/** Parses a value through a field schema; `ok` false when it is rejected. */
function read(schema: z.ZodType, value: unknown) {
  const result = schema.safeParse(value);
  return result.success
    ? { ok: true as const, value: result.data as unknown, issues: [] }
    : { ok: false as const, value: undefined, issues: result.error.issues };
}

const accepted = (schema: z.ZodType, value: unknown) => {
  const result = read(schema, value);
  expect(result.ok, `expected ${JSON.stringify(value)} to be accepted`).toBe(true);
  return result.value;
};

const rejected = (schema: z.ZodType, value: unknown) => {
  const result = read(schema, value);
  expect(result.ok, `expected ${JSON.stringify(value)} to be rejected`).toBe(false);
  return result.issues;
};

const BLANKS = ['', ' ', '   ', '\t', '\n', ' \t\n '] as const;

describe('ATTRIBUTION', () => {
  it('is the Open Government Licence v3.0 credit naming data.police.uk', () => {
    expect(ATTRIBUTION).toBe(
      'Contains public sector information licensed under the Open Government Licence v3.0. Source: data.police.uk.',
    );
  });
});

describe('blankAsUnset', () => {
  const field = blankAsUnset(z.string().optional());

  it.each(BLANKS)('maps %j to unset', (blank) => {
    expect(accepted(field, blank)).toBeUndefined();
  });

  it('maps null and undefined to unset', () => {
    expect(accepted(field, null)).toBeUndefined();
    expect(accepted(field, undefined)).toBeUndefined();
  });

  it('trims every other string', () => {
    expect(accepted(field, '  keep me \n')).toBe('keep me');
  });

  it('runs normalize on the trimmed string only', () => {
    const calls: string[] = [];
    const normalized = blankAsUnset(z.string().optional(), (value) => {
      calls.push(value);
      return value.toUpperCase();
    });
    expect(accepted(normalized, '  abc ')).toBe('ABC');
    expect(accepted(normalized, '   ')).toBeUndefined();
    expect(calls).toEqual(['abc']);
  });

  it('passes non-string values through to the inner schema untouched', () => {
    const numeric = blankAsUnset(z.number().optional());
    expect(accepted(numeric, 5)).toBe(5);
    rejected(numeric, 'five');
  });

  it('turns a blank into undefined, so a required inner schema rejects it', () => {
    rejected(blankAsUnset(z.string()), '');
  });
});

describe('forceInput', () => {
  it.each([
    ['leicestershire', 'leicestershire'],
    ['  Leicestershire  ', 'leicestershire'],
    ['LEICESTERSHIRE', 'leicestershire'],
    ['Greater Manchester', 'greater-manchester'],
    ['greater_manchester', 'greater-manchester'],
    ['greater  _ manchester', 'greater-manchester'],
    ['Avon and Somerset', 'avon-and-somerset'],
    ['northern-ireland', 'northern-ireland'],
    ['btp', 'btp'],
  ])('reads %j as %j', (input, expected) => {
    expect(accepted(forceInput, input)).toBe(expected);
  });

  it.each(BLANKS)('reads %j as unset', (blank) => {
    expect(accepted(forceInput, blank)).toBeUndefined();
  });

  it.each([
    ['digits', 'leicestershire1'],
    ['a leading hyphen', '-leicestershire'],
    ['a trailing hyphen', 'leicestershire-'],
    ['a doubled hyphen', 'greater--manchester'],
    ['a slash', 'leicestershire/neighbourhoods'],
    ['a path climb', '../forces'],
    ['a query', 'leicestershire?x=1'],
    ['an accented letter', 'dyfed-pówys'],
    ['a non-string', 5],
  ])('rejects %s', (_name, input) => {
    rejected(forceInput, input);
  });

  it('accepts 100 characters and rejects 101', () => {
    accepted(forceInput, 'a'.repeat(100));
    rejected(forceInput, 'a'.repeat(101));
  });
});

describe('neighbourhoodIdInput', () => {
  it.each(['NX01', 'nx01', 'Lower Falls', 'a.b', '...', '.hidden', 'N-1_2', 'Ards and North Down'])(
    'accepts %j, case and spaces preserved',
    (id) => {
      expect(accepted(neighbourhoodIdInput, id)).toBe(id);
    },
  );

  it('trims surrounding whitespace and nothing else', () => {
    expect(accepted(neighbourhoodIdInput, '  Lower Falls\t')).toBe('Lower Falls');
  });

  it.each(BLANKS)('reads %j as unset', (blank) => {
    expect(accepted(neighbourhoodIdInput, blank)).toBeUndefined();
  });

  it.each([
    ['a forward slash', 'a/b'],
    ['a backslash', 'a\\b'],
    ['a question mark', 'a?b'],
    ['a hash', 'a#b'],
    ['a whole ".."', '..'],
    ['a whole "."', '.'],
    ['a ".." after trimming', '  ..  '],
    ['a NUL', 'a\u0000b'],
    ['a newline', 'a\nb'],
    ['a tab inside', 'a\tb'],
    ['a C1 control', 'a\u0085b'],
    ['a path-climb attempt', '../forces'],
  ])('rejects %s', (_name, id) => {
    rejected(neighbourhoodIdInput, id);
  });

  it('accepts 100 characters and rejects 101', () => {
    accepted(neighbourhoodIdInput, 'N'.repeat(100));
    rejected(neighbourhoodIdInput, 'N'.repeat(101));
  });
});

describe('locationIdInput', () => {
  it.each(['1', '1234567', '000123', '123456789012'])('accepts %j', (id) => {
    expect(accepted(locationIdInput, id)).toBe(id);
  });

  it('trims', () => {
    expect(accepted(locationIdInput, ' 987 ')).toBe('987');
  });

  it.each(BLANKS)('reads %j as unset', (blank) => {
    expect(accepted(locationIdInput, blank)).toBeUndefined();
  });

  it.each([
    ['13 digits', '1234567890123'],
    ['letters', 'abc'],
    ['a space inside', '12 34'],
    ['a sign', '-1'],
    ['a decimal', '1.5'],
    ['a number', 123],
  ])('rejects %s', (_name, id) => {
    rejected(locationIdInput, id);
  });
});

describe('monthInput', () => {
  it.each(['2026-08', '2023-09', '2026-01', '2026-12'])('accepts %s', (month) => {
    expect(accepted(monthInput, month)).toBe(month);
  });

  it('trims', () => {
    expect(accepted(monthInput, ' 2026-08 ')).toBe('2026-08');
  });

  it.each(BLANKS)('reads %j as unset', (blank) => {
    expect(accepted(monthInput, blank)).toBeUndefined();
  });

  it.each(['2026-00', '2026-13', '2026-8', '202608', '2026-08-15', 'July2026', '26-08', '2026/08'])(
    'rejects %s',
    (month) => {
      rejected(monthInput, month);
    },
  );
});

describe('categoryInput', () => {
  it('lower-cases and trims, keeping inner spacing for the handler to match', () => {
    expect(accepted(categoryInput, ' Violence And Sexual  Offences ')).toBe(
      'violence and sexual  offences',
    );
    expect(accepted(categoryInput, 'Burglary')).toBe('burglary');
  });

  it.each(BLANKS)('reads %j as unset', (blank) => {
    expect(accepted(categoryInput, blank)).toBeUndefined();
  });

  it('accepts 100 characters and rejects 101', () => {
    accepted(categoryInput, 'a'.repeat(100));
    rejected(categoryInput, 'a'.repeat(101));
  });

  it('does not constrain the characters (matching is against the cached vocabulary)', () => {
    expect(accepted(categoryInput, 'anything goes!')).toBe('anything goes!');
  });
});

describe('nameContainsInput', () => {
  it('trims and keeps case', () => {
    expect(accepted(nameContainsInput, '  Devon & Cornwall ')).toBe('Devon & Cornwall');
  });

  it.each(BLANKS)('reads %j as unset', (blank) => {
    expect(accepted(nameContainsInput, blank)).toBeUndefined();
  });

  it('accepts 100 characters and rejects 101', () => {
    accepted(nameContainsInput, 'a'.repeat(100));
    rejected(nameContainsInput, 'a'.repeat(101));
  });

  it.each(['-', '&', '...', ' & - ', "'"])(
    'rejects %j, which has no letter or digit to match',
    (value) => {
      expect(rejected(nameContainsInput, value)[0]?.message).toBe(
        'Needs a letter or digit; punctuation alone would match every name.',
      );
    },
  );

  it.each(['a', '7', '& a', 'Étoile', '℡'])(
    'accepts %j, which has a letter or digit once decomposed',
    (value) => {
      expect(accepted(nameContainsInput, value)).toBe(value);
    },
  );
});

describe('latInput and lngInput', () => {
  it.each([0, 51.5, -0.12, 90, -90])('latInput accepts %d', (lat) => {
    expect(accepted(latInput, lat)).toBe(lat);
  });

  it.each([0, 52.63, -1.13, 180, -180])('lngInput accepts %d', (lng) => {
    expect(accepted(lngInput, lng)).toBe(lng);
  });

  it.each([90.0001, -90.0001, 999, Number.NaN, Number.POSITIVE_INFINITY])(
    'latInput rejects %d',
    (lat) => {
      rejected(latInput, lat);
    },
  );

  it.each([180.0001, -180.0001, 999, Number.NaN, Number.NEGATIVE_INFINITY])(
    'lngInput rejects %d',
    (lng) => {
      rejected(lngInput, lng);
    },
  );

  it('takes numbers only: a numeric string is rejected', () => {
    rejected(latInput, '51.5');
    rejected(lngInput, '-0.12');
  });

  it.each([...BLANKS, null, undefined])('reads %j as unset', (blank) => {
    expect(accepted(latInput, blank)).toBeUndefined();
    expect(accepted(lngInput, blank)).toBeUndefined();
  });
});

describe('polygonInput', () => {
  const ring = [
    { lat: 52.63, lng: -1.14 },
    { lat: 52.63, lng: -1.12 },
    { lat: 52.64, lng: -1.12 },
  ];

  it('accepts three or more {lat, lng} vertices', () => {
    expect(accepted(polygonInput, ring)).toEqual(ring);
  });

  it('strips keys other than lat and lng', () => {
    expect(
      accepted(
        polygonInput,
        ring.map((vertex) => ({ ...vertex, extra: 1 })),
      ),
    ).toEqual(ring);
  });

  it('accepts the upstream string form lat,lng:lat,lng:…', () => {
    expect(accepted(polygonInput, '52.63,-1.14:52.63,-1.12:52.64,-1.12')).toEqual(ring);
  });

  it('tolerates spaces around the numbers in the string form', () => {
    expect(accepted(polygonInput, ' 52.63 , -1.14 : 52.63,-1.12 :52.64, -1.12 ')).toEqual(ring);
  });

  it.each([...BLANKS, null, undefined, []])('reads %j as unset', (blank) => {
    expect(accepted(polygonInput, blank)).toBeUndefined();
  });

  it('rejects fewer than three vertices', () => {
    expect(rejected(polygonInput, ring.slice(0, 2)).map((issue) => issue.code)).toEqual([
      'too_small',
    ]);
    rejected(polygonInput, '52.63,-1.14:52.63,-1.12');
  });

  it.each([
    ['latitude out of range', [{ lat: 91, lng: 0 }, ...ring.slice(1)]],
    ['longitude out of range', [{ lat: 0, lng: 181 }, ...ring.slice(1)]],
    ['a non-numeric coordinate', [{ lat: '52.6', lng: -1.1 }, ...ring.slice(1)]],
    ['a missing lng', [{ lat: 52.6 }, ...ring.slice(1)]],
    [
      'a [lng, lat] pair, whose order is ambiguous',
      [
        [-1.14, 52.63],
        [-1.12, 52.63],
        [-1.12, 52.64],
      ],
    ],
  ])('rejects %s', (_name, value) => {
    rejected(polygonInput, value);
  });

  it.each([
    ['a trailing separator', '52.63,-1.14:52.63,-1.12:52.64,-1.12:'],
    ['a missing longitude', '52.63,-1.14:52.63:52.64,-1.12'],
    ['a non-numeric part', '52.63,-1.14:oops:52.64,-1.12'],
    ['an empty coordinate', '52.63,:52.63,-1.12:52.64,-1.12'],
    ['three numbers in one pair', '52.63,-1.14,5:52.63,-1.12:52.64,-1.12'],
    ['an infinite number', 'Infinity,0:52.63,-1.12:52.64,-1.12'],
  ])('rejects a string with %s', (_name, value) => {
    rejected(polygonInput, value);
  });

  it('rejects a non-array, non-string value', () => {
    expect(rejected(polygonInput, 5).map((issue) => issue.code)).toEqual(['invalid_type']);
    rejected(polygonInput, { lat: 1, lng: 2 });
  });

  it('accepts exactly 2,500 vertices', () => {
    expect(POLYGON_MAX_VERTICES).toBe(2500);
    const vertices = Array.from({ length: 2500 }, (_, i) => ({ lat: 50 + i * 1e-4, lng: -1 }));
    expect(accepted(polygonInput, vertices)).toHaveLength(2500);
  });

  it('rejects 2,501 vertices with a single too_big issue', () => {
    const vertices = Array.from({ length: 2501 }, (_, i) => ({ lat: 50 + i * 1e-4, lng: -1 }));
    expect(rejected(polygonInput, vertices).map((issue) => issue.code)).toEqual(['too_big']);
  });

  it('bounds the issue list however long the list is: 50,000 valid vertices still give one issue', () => {
    const vertices = Array.from({ length: 50_000 }, (_, i) => ({
      lat: 50 + (i % 1000) * 1e-4,
      lng: -1,
    }));
    expect(rejected(polygonInput, vertices)).toHaveLength(1);
  });

  it('bounds the issue list when every vertex is a [lng, lat] pair: it stops at the first bad one', () => {
    const pairs = Array.from({ length: 500 }, (_, i) => [-1 + i * 1e-4, 52]);
    const issues = rejected(polygonInput, pairs);
    expect(issues.length).toBeLessThanOrEqual(2);
    expect(issues[0]?.path[0]).toBe(0);
  });

  it('bounds the issue list for a string form full of malformed vertices', () => {
    const value = Array.from({ length: 500 }, () => 'x').join(':');
    expect(rejected(polygonInput, value).length).toBeLessThanOrEqual(2);
  });

  it('reports the first malformed vertex by its index', () => {
    const vertices = [...ring, { lat: 'x', lng: 1 }, ...ring];
    expect(rejected(polygonInput, vertices)[0]?.path[0]).toBe(3);
  });
});

describe('limitInput', () => {
  const limit = limitInput(50);

  it('defaults to the value given', () => {
    expect(accepted(limit, undefined)).toBe(50);
    expect(accepted(limitInput(25), undefined)).toBe(25);
  });

  it.each([1, 50, 200])('accepts %d', (n) => {
    expect(accepted(limit, n)).toBe(n);
  });

  it.each([0, -1, 201, 1.5, Number.NaN])('rejects %d', (n) => {
    rejected(limit, n);
  });

  it('takes numbers only', () => {
    rejected(limit, '10');
  });
});

describe('offsetInput', () => {
  it('defaults to 0', () => {
    expect(accepted(offsetInput, undefined)).toBe(0);
  });

  it.each([0, 1, 5000])('accepts %d', (n) => {
    expect(accepted(offsetInput, n)).toBe(n);
  });

  it.each([-1, 1.5, Number.NaN])('rejects %d', (n) => {
    rejected(offsetInput, n);
  });
});

describe('a form client submitting every optional field blank', () => {
  const form = z.object({
    force: forceInput,
    neighbourhood_id: neighbourhoodIdInput,
    location_id: locationIdInput,
    month: monthInput,
    category: categoryInput,
    name_contains: nameContainsInput,
    lat: latInput,
    lng: lngInput,
    polygon: polygonInput,
  });

  it('reads empty strings as unset on every field', () => {
    const blanks = Object.fromEntries(Object.keys(form.shape).map((key) => [key, '']));
    expect(form.parse(blanks)).toEqual({});
  });

  it('reads whitespace-only strings as unset on every field', () => {
    const blanks = Object.fromEntries(Object.keys(form.shape).map((key) => [key, ' \t ']));
    expect(form.parse(blanks)).toEqual({});
  });

  it('reads null as unset on every field', () => {
    const nulls = Object.fromEntries(Object.keys(form.shape).map((key) => [key, null]));
    expect(form.parse(nulls)).toEqual({});
  });

  it('accepts every field left out', () => {
    expect(form.parse({})).toEqual({});
  });

  it('applies each field normalization when real values arrive', () => {
    expect(
      form.parse({
        force: ' Greater Manchester ',
        neighbourhood_id: ' NX01 ',
        location_id: ' 123 ',
        month: ' 2026-08 ',
        category: ' Burglary ',
        name_contains: ' east ',
        lat: 52.63,
        lng: -1.13,
        polygon: [],
      }),
    ).toEqual({
      force: 'greater-manchester',
      neighbourhood_id: 'NX01',
      location_id: '123',
      month: '2026-08',
      category: 'burglary',
      name_contains: 'east',
      lat: 52.63,
      lng: -1.13,
    });
  });
});
