/**
 * @fileoverview The area module: `parseArea` on every arm (required fields,
 * rejected extras, message wording), `resolveTarget` (a neighbourhood becomes its
 * boundary, force arms become the force, every other arm passes through),
 * `polyParam`'s 6-dp form, and the `crimesQuery`, `outcomesQuery` and
 * `stopsQuery` descriptors — path, method, params, miss handling and the one
 * normalizer each route owns — including the requests they put on the wire.
 * @module tests/services/area.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { describe, expect, it } from 'vitest';
import {
  AREA_KINDS,
  type AreaFields,
  type AreaKind,
  crimesQuery,
  outcomesQuery,
  parseArea,
  polyParam,
  resolveTarget,
  stopsQuery,
} from '@/services/police-api/area.js';
import type { Place } from '@/services/police-api/types.js';
import {
  boundaryBody,
  crimesBody,
  jsonOk,
  outcomesBody,
  plainNotFound,
  stopsBody,
} from '../fixtures/police-api-upstream.js';
import { settle, useServiceHarness } from '../fixtures/service-harness.js';

const RING = [
  { lat: 52.63, lng: -1.14 },
  { lat: 52.63, lng: -1.12 },
  { lat: 52.64, lng: -1.12 },
];

const ARMS: ReadonlyArray<[AreaKind, AreaFields]> = [
  ['point', { lat: 52.63, lng: -1.13 }],
  ['polygon', { polygon: RING }],
  ['location', { location_id: '1000001' }],
  ['neighbourhood', { force: 'leicestershire', neighbourhood_id: 'NX01' }],
  ['force_unplaced', { force: 'leicestershire' }],
  ['force', { force: 'leicestershire' }],
];

describe('parseArea', () => {
  it('declares the six arms in the documented order', () => {
    expect(AREA_KINDS).toEqual([
      'point',
      'polygon',
      'location',
      'neighbourhood',
      'force_unplaced',
      'force',
    ]);
  });

  describe('accepts exactly the required fields', () => {
    it('point → { kind, lat, lng }', () => {
      expect(parseArea('point', { lat: 52.63, lng: -1.13 })).toEqual({
        ok: true,
        spec: { kind: 'point', lat: 52.63, lng: -1.13 },
      });
    });

    it('point accepts 0, 0 (zero is a value, not an absence)', () => {
      expect(parseArea('point', { lat: 0, lng: 0 })).toEqual({
        ok: true,
        spec: { kind: 'point', lat: 0, lng: 0 },
      });
    });

    it('polygon → vertices as { latitude, longitude } in input order, not closed by the server', () => {
      expect(parseArea('polygon', { polygon: RING })).toEqual({
        ok: true,
        spec: {
          kind: 'polygon',
          vertices: [
            { latitude: 52.63, longitude: -1.14 },
            { latitude: 52.63, longitude: -1.12 },
            { latitude: 52.64, longitude: -1.12 },
          ],
        },
      });
    });

    it('location → { kind, locationId }', () => {
      expect(parseArea('location', { location_id: '1000001' })).toEqual({
        ok: true,
        spec: { kind: 'location', locationId: '1000001' },
      });
    });

    it('neighbourhood → { kind, force, neighbourhoodId }', () => {
      expect(
        parseArea('neighbourhood', { force: 'leicestershire', neighbourhood_id: 'NX01' }),
      ).toEqual({
        ok: true,
        spec: { kind: 'neighbourhood', force: 'leicestershire', neighbourhoodId: 'NX01' },
      });
    });

    it.each(['force_unplaced', 'force'] as const)('%s → { kind, force }', (kind) => {
      expect(parseArea(kind, { force: 'btp' })).toEqual({
        ok: true,
        spec: { kind, force: 'btp' },
      });
    });

    it('treats a field present as undefined as absent', () => {
      expect(parseArea('location', { location_id: '1', force: undefined, lat: undefined })).toEqual(
        {
          ok: true,
          spec: { kind: 'location', locationId: '1' },
        },
      );
    });
  });

  describe('missing required fields', () => {
    it.each<[AreaKind, AreaFields, string]>([
      ['point', { lat: 52.63 }, "area 'point' needs lat and lng; lng is missing."],
      ['point', { lng: -1.13 }, "area 'point' needs lat and lng; lat is missing."],
      ['point', {}, "area 'point' needs lat and lng; lat and lng are missing."],
      ['polygon', {}, "area 'polygon' needs polygon; polygon is missing."],
      ['location', {}, "area 'location' needs location_id; location_id is missing."],
      [
        'neighbourhood',
        {},
        "area 'neighbourhood' needs force and neighbourhood_id; force and neighbourhood_id are missing.",
      ],
      [
        'neighbourhood',
        { force: 'leicestershire' },
        "area 'neighbourhood' needs force and neighbourhood_id; neighbourhood_id is missing.",
      ],
      [
        'neighbourhood',
        { neighbourhood_id: 'NX01' },
        "area 'neighbourhood' needs force and neighbourhood_id; force is missing.",
      ],
      ['force_unplaced', {}, "area 'force_unplaced' needs force; force is missing."],
      ['force', {}, "area 'force' needs force; force is missing."],
    ])('%s with %j fails with a message naming the field', (kind, fields, message) => {
      expect(parseArea(kind, fields)).toEqual({ ok: false, message });
    });
  });

  describe('fields the arm does not use', () => {
    it.each<[AreaKind, AreaFields, string]>([
      [
        'point',
        { lat: 52.63, lng: -1.13, force: 'leicestershire' },
        "area 'point' does not use force; remove it or choose the area that takes it.",
      ],
      [
        'point',
        { lat: 52.63, lng: -1.13, polygon: RING, location_id: '1' },
        "area 'point' does not use polygon and location_id; remove them or choose the area that takes them.",
      ],
      [
        'polygon',
        { polygon: RING, lat: 52.63 },
        "area 'polygon' does not use lat; remove it or choose the area that takes it.",
      ],
      [
        'location',
        { location_id: '1', neighbourhood_id: 'NX01' },
        "area 'location' does not use neighbourhood_id; remove it or choose the area that takes it.",
      ],
      [
        'neighbourhood',
        { force: 'leicestershire', neighbourhood_id: 'NX01', location_id: '1' },
        "area 'neighbourhood' does not use location_id; remove it or choose the area that takes it.",
      ],
      [
        'force_unplaced',
        { force: 'leicestershire', neighbourhood_id: 'NX01' },
        "area 'force_unplaced' does not use neighbourhood_id; remove it or choose the area that takes it.",
      ],
      [
        'force',
        { force: 'leicestershire', lat: 52.63, lng: -1.13, polygon: RING },
        "area 'force' does not use lat, lng and polygon; remove them or choose the area that takes them.",
      ],
    ])('%s with %j fails naming the extras', (kind, fields, message) => {
      expect(parseArea(kind, fields)).toEqual({ ok: false, message });
    });

    it('rejects an extra even when 0 (a falsy value is still present)', () => {
      const result = parseArea('location', { location_id: '1', lat: 0 });
      expect(result).toEqual({
        ok: false,
        message: "area 'location' does not use lat; remove it or choose the area that takes it.",
      });
    });

    it('joins a missing-field problem and an extra-field problem with a space', () => {
      expect(parseArea('point', { lat: 52.63, force: 'leicestershire' })).toEqual({
        ok: false,
        message:
          "area 'point' needs lat and lng; lng is missing. area 'point' does not use force; remove it or choose the area that takes it.",
      });
    });
  });

  it.each(ARMS)('every arm rejects every other arm’s fields: %s', (kind, ownFields) => {
    for (const [otherKind, otherFields] of ARMS) {
      if (otherKind === kind) continue;
      const mixed = { ...ownFields, ...otherFields };
      const sharesOnlyOwn = Object.keys(otherFields).every((key) => key in ownFields);
      expect(parseArea(kind, mixed).ok, `${kind} + ${otherKind}`).toBe(sharesOnlyOwn);
    }
  });
});

describe('polyParam', () => {
  it('writes lat,lng pairs joined by colons at 6 dp', () => {
    expect(
      polyParam([
        { latitude: 52.63, longitude: -1.14 },
        { latitude: 52.64, longitude: -1.12 },
      ]),
    ).toBe('52.630000,-1.140000:52.640000,-1.120000');
  });

  it('rounds longer coordinates to 6 dp and pads shorter ones', () => {
    expect(polyParam([{ latitude: 52.123_456_78, longitude: -1.5 }])).toBe('52.123457,-1.500000');
  });

  it('keeps the sign of a negative longitude and writes zero as 0.000000', () => {
    expect(polyParam([{ latitude: 0, longitude: -0.5 }])).toBe('0.000000,-0.500000');
  });

  it('writes a single vertex without a separator and an empty ring as an empty string', () => {
    expect(polyParam([{ latitude: 1, longitude: 2 }])).toBe('1.000000,2.000000');
    expect(polyParam([])).toBe('');
  });

  it('keeps a boundary closed when its first vertex is repeated last', () => {
    const ring = boundaryBody().map((v) => ({
      latitude: Number(v.latitude),
      longitude: Number(v.longitude),
    }));
    const parts = polyParam(ring).split(':');
    expect(parts).toHaveLength(5);
    expect(parts[0]).toBe(parts[4]);
  });
});

describe('resolveTarget', () => {
  const h = useServiceHarness();

  it('turns a neighbourhood into its boundary polygon (numeric vertices, first repeated last)', async () => {
    h.upstream.route('GET', '/leicestershire/NX01/boundary', jsonOk(boundaryBody()));
    const target = await settle(
      resolveTarget(
        { kind: 'neighbourhood', force: 'leicestershire', neighbourhoodId: 'NX01' },
        h.service,
        h.ctx,
        h.budget(),
      ),
    );
    expect(target).toEqual({
      kind: 'found',
      value: {
        kind: 'polygon',
        vertices: [
          { latitude: 52.63, longitude: -1.14 },
          { latitude: 52.63, longitude: -1.12 },
          { latitude: 52.64, longitude: -1.12 },
          { latitude: 52.64, longitude: -1.14 },
          { latitude: 52.63, longitude: -1.14 },
        ],
      },
    });
  });

  it('path-encodes the neighbourhood id (a Northern Ireland id with a space)', async () => {
    h.upstream.route('GET', '/northern-ireland/Belfast%20City/boundary', jsonOk(boundaryBody()));
    const target = await settle(
      resolveTarget(
        { kind: 'neighbourhood', force: 'northern-ireland', neighbourhoodId: 'Belfast City' },
        h.service,
        h.ctx,
        h.budget(),
      ),
    );
    expect(target.kind).toBe('found');
    expect(h.upstream.calls.map((call) => call.path)).toEqual([
      '/northern-ireland/Belfast%20City/boundary',
    ]);
  });

  it('names the force and id of an unknown or wrongly cased neighbourhood (404), and caches the miss', async () => {
    h.upstream.route('GET', '/leicestershire/nx01/boundary', plainNotFound);
    const spec = {
      kind: 'neighbourhood',
      force: 'leicestershire',
      neighbourhoodId: 'nx01',
    } as const;
    const miss = {
      kind: 'unknown_neighbourhood',
      force: 'leicestershire',
      neighbourhoodId: 'nx01',
    };
    expect(await settle(resolveTarget(spec, h.service, h.ctx, h.budget()))).toEqual(miss);
    expect(await settle(resolveTarget(spec, h.service, h.ctx, h.budget()))).toEqual(miss);
    expect(h.upstream.count('/leicestershire/nx01/boundary')).toBe(1);
  });

  it('does not ask the upstream for a boundary twice', async () => {
    h.upstream.route('GET', '/leicestershire/NX01/boundary', jsonOk(boundaryBody()));
    const spec = {
      kind: 'neighbourhood',
      force: 'leicestershire',
      neighbourhoodId: 'NX01',
    } as const;
    await settle(resolveTarget(spec, h.service, h.ctx, h.budget()));
    await settle(resolveTarget(spec, h.service, h.ctx, h.budget()));
    expect(h.upstream.count('/leicestershire/NX01/boundary')).toBe(1);
  });

  it.each(['force_unplaced', 'force'] as const)(
    '%s becomes the whole force, with no request',
    async (kind) => {
      const target = await resolveTarget({ kind, force: 'btp' }, h.service, h.ctx, h.budget());
      expect(target).toEqual({ kind: 'found', value: { kind: 'force', force: 'btp' } });
      expect(h.upstream.calls).toHaveLength(0);
    },
  );

  it.each<[string, Place]>([
    ['point', { kind: 'point', lat: 52.63, lng: -1.13 }],
    ['polygon', { kind: 'polygon', vertices: [{ latitude: 52.63, longitude: -1.14 }] }],
    ['location', { kind: 'location', locationId: '1000001' }],
  ])('passes a %s spec through unchanged, with no request', async (_name, spec) => {
    const target = await resolveTarget(spec, h.service, h.ctx, h.budget());
    expect(target.kind).toBe('found');
    if (target.kind === 'found') expect(target.value).toBe(spec);
    expect(h.upstream.calls).toHaveLength(0);
  });

  it('propagates a boundary lookup failure (500) instead of reading it as a miss', async () => {
    h.upstream.route(
      'GET',
      '/leicestershire/NX01/boundary',
      () => new Response(null, { status: 500 }),
    );
    const error = await settle(
      resolveTarget(
        { kind: 'neighbourhood', force: 'leicestershire', neighbourhoodId: 'NX01' },
        h.service,
        h.ctx,
        h.budget(),
      ),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
  });
});

describe('crimesQuery', () => {
  const VERTICES = [
    { latitude: 52.63, longitude: -1.14 },
    { latitude: 52.64, longitude: -1.12 },
    { latitude: 52.6, longitude: -1.1 },
  ];

  it('point → GET /crimes-street/{category} with lat, lng (6 dp) and date', () => {
    const query = crimesQuery(
      { kind: 'point', lat: 52.123_456_78, lng: -1.5 },
      'burglary',
      '2026-08',
    );
    expect(query.path).toBe('/crimes-street/burglary');
    expect(query.params).toEqual({ lat: '52.123457', lng: '-1.500000', date: '2026-08' });
    expect(query.method).toBeUndefined();
    expect(query.notFoundIsMiss).toBeUndefined();
  });

  it('polygon → POST the same route with poly and date', () => {
    const query = crimesQuery({ kind: 'polygon', vertices: VERTICES }, 'all-crime', '2026-08');
    expect(query.path).toBe('/crimes-street/all-crime');
    expect(query.method).toBe('POST');
    expect(query.params).toEqual({
      poly: '52.630000,-1.140000:52.640000,-1.120000:52.600000,-1.100000',
      date: '2026-08',
    });
  });

  it('location → GET /crimes-at-location with no category, a 404 being a miss', () => {
    const query = crimesQuery({ kind: 'location', locationId: '1000001' }, 'burglary', '2026-08');
    expect(query.path).toBe('/crimes-at-location');
    expect(query.params).toEqual({ location_id: '1000001', date: '2026-08' });
    expect(query.notFoundIsMiss).toBe(true);
    expect(query.method).toBeUndefined();
  });

  it('force → GET /crimes-no-location with category, force and date', () => {
    const query = crimesQuery({ kind: 'force', force: 'leicestershire' }, 'drugs', '2026-08');
    expect(query.path).toBe('/crimes-no-location');
    expect(query.params).toEqual({ category: 'drugs', force: 'leicestershire', date: '2026-08' });
    expect(query.method).toBeUndefined();
    expect(query.notFoundIsMiss).toBeUndefined();
  });

  it('percent-encodes the category in the path segment', () => {
    const query = crimesQuery({ kind: 'point', lat: 1, lng: 2 }, 'a b/c', '2026-08');
    expect(query.path).toBe('/crimes-street/a%20b%2Fc');
  });

  it('always puts date in params', () => {
    for (const target of [
      { kind: 'point', lat: 1, lng: 2 },
      { kind: 'polygon', vertices: VERTICES },
      { kind: 'location', locationId: '5' },
      { kind: 'force', force: 'btp' },
    ] as const) {
      expect(crimesQuery(target, 'all-crime', '2025-01').params.date).toBe('2025-01');
    }
  });

  describe('normalize', () => {
    const query = crimesQuery({ kind: 'point', lat: 52.63, lng: -1.13 }, 'all-crime', '2026-08');

    it('parses the body into sorted wire-shape records', () => {
      const records = query.normalize(crimesBody());
      expect(records).toHaveLength(7);
      expect(records.map((crime) => crime.id)).toEqual([
        '100000050',
        '100000051',
        '100000030',
        '100000032',
        '100000031',
        '100000060',
        '100000040',
      ]);
    });

    it('answers [] for an empty array', () => {
      expect(query.normalize([])).toEqual([]);
    });

    it.each<[string, unknown]>([
      ['an object', { crimes: [] }],
      ['null', null],
      ['a record without a category', [{ id: 1, month: '2026-08' }]],
      ['a record with a numeric month', [{ category: 'x', id: 1, month: 202_608 }]],
    ])('fails %s as a non-retryable unexpected_response naming the route', (_name, body) => {
      let thrown: unknown;
      try {
        query.normalize(body);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(McpError);
      const error = thrown as McpError;
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.data).toMatchObject({ reason: 'unexpected_response', retryable: false });
      expect(error.message).toContain('/crimes-street/all-crime');
    });

    it('names the location route when the location query is the one that fails', () => {
      const atLocation = crimesQuery({ kind: 'location', locationId: '1' }, 'all-crime', '2026-08');
      expect(() => atLocation.normalize('nope')).toThrow(/\/crimes-at-location/);
    });
  });
});

describe('outcomesQuery', () => {
  const RING_VERTICES = [
    { latitude: 52.63, longitude: -1.14 },
    { latitude: 52.64, longitude: -1.12 },
    { latitude: 52.6, longitude: -1.1 },
  ];

  it('point → GET /outcomes-at-location with lat, lng and date', () => {
    const query = outcomesQuery({ kind: 'point', lat: 52.63, lng: -1.13 }, '2026-08');
    expect(query.path).toBe('/outcomes-at-location');
    expect(query.params).toEqual({ lat: '52.630000', lng: '-1.130000', date: '2026-08' });
    expect(query.method).toBeUndefined();
    expect(query).not.toHaveProperty('notFoundIsMiss');
  });

  it('polygon → POST the same route with poly and date', () => {
    const query = outcomesQuery({ kind: 'polygon', vertices: RING_VERTICES }, '2026-08');
    expect(query.path).toBe('/outcomes-at-location');
    expect(query.method).toBe('POST');
    expect(query.params).toEqual({
      poly: '52.630000,-1.140000:52.640000,-1.120000:52.600000,-1.100000',
      date: '2026-08',
    });
  });

  it('location → the same route with location_id, a 404 being a miss', () => {
    const query = outcomesQuery({ kind: 'location', locationId: '1000001' }, '2026-08');
    expect(query.path).toBe('/outcomes-at-location');
    expect(query.params).toEqual({ location_id: '1000001', date: '2026-08' });
    expect(query.notFoundIsMiss).toBe(true);
  });

  it('normalizes into outcome records sorted by crime month (newest first), then crime id', () => {
    const query = outcomesQuery({ kind: 'point', lat: 52.63, lng: -1.13 }, '2026-08');
    const records = query.normalize(outcomesBody());
    expect(records.map((r) => [r.crime.month, r.crime.id])).toEqual([
      ['2026-07', '100000080'],
      ['2026-07', '100000082'],
      ['2026-05', '100000081'],
    ]);
    expect(records[0]).toMatchObject({
      code: 'under-investigation',
      name: 'Under investigation',
      month: '2026-08',
    });
  });

  it('fails a body of the wrong shape naming /outcomes-at-location', () => {
    const query = outcomesQuery({ kind: 'point', lat: 1, lng: 2 }, '2026-08');
    expect(() => query.normalize([{ category: 'x' }])).toThrow(/\/outcomes-at-location/);
  });
});

describe('stopsQuery', () => {
  it('point → GET /stops-street with lat, lng and date', () => {
    const query = stopsQuery({ kind: 'point', lat: 52.63, lng: -1.13 }, '2026-08');
    expect(query.path).toBe('/stops-street');
    expect(query.params).toEqual({ lat: '52.630000', lng: '-1.130000', date: '2026-08' });
    expect(query.method).toBeUndefined();
    expect(query).not.toHaveProperty('notFoundIsMiss');
  });

  it('polygon → POST /stops-street with poly and date', () => {
    const query = stopsQuery(
      {
        kind: 'polygon',
        vertices: [
          { latitude: 52.63, longitude: -1.14 },
          { latitude: 52.64, longitude: -1.12 },
          { latitude: 52.6, longitude: -1.1 },
        ],
      },
      '2026-08',
    );
    expect(query.path).toBe('/stops-street');
    expect(query.method).toBe('POST');
    expect(query.params.poly).toBe('52.630000,-1.140000:52.640000,-1.120000:52.600000,-1.100000');
  });

  it('location → GET /stops-at-location, where a 404 is NOT a miss (an unknown id answers [])', () => {
    const query = stopsQuery({ kind: 'location', locationId: '1000001' }, '2026-08');
    expect(query.path).toBe('/stops-at-location');
    expect(query.params).toEqual({ location_id: '1000001', date: '2026-08' });
    expect(query.notFoundIsMiss).toBe(false);
  });

  it('force → GET /stops-force with force and date', () => {
    const query = stopsQuery({ kind: 'force', force: 'btp' }, '2026-08');
    expect(query.path).toBe('/stops-force');
    expect(query.params).toEqual({ force: 'btp', date: '2026-08' });
    expect(query.method).toBeUndefined();
  });

  it('normalizes into stops sorted by datetime then location id (unplaced first)', () => {
    const query = stopsQuery({ kind: 'force', force: 'leicestershire' }, '2026-08');
    const records = query.normalize(stopsBody());
    expect(records.map((s) => s.datetime)).toEqual([
      '2026-08-02T03:10:00+00:00',
      '2026-08-10T09:00:00+00:00',
      '2026-08-14T21:30:00+00:00',
      '2026-08-14T21:30:00+00:00',
      '2026-08-20T01:15:00+00:00',
      '2026-08-21T12:00:00+00:00',
    ]);
    expect(records[2]?.location?.location_id).toBe('1000001');
    expect(records[3]?.location?.location_id).toBe('1000002');
  });

  it('fails a body of the wrong shape naming /stops-force', () => {
    const query = stopsQuery({ kind: 'force', force: 'leicestershire' }, '2026-08');
    expect(() => query.normalize({ stops: [] })).toThrow(/\/stops-force/);
  });
});

describe('descriptors on the wire (queryArea)', () => {
  const h = useServiceHarness();

  it('sends a point as a GET with lat, lng and date in the query string', async () => {
    h.upstream.route('GET', '/crimes-street/burglary', jsonOk(crimesBody()));
    const result = await settle(
      h.service.queryArea(
        crimesQuery({ kind: 'point', lat: 52.63, lng: -1.13 }, 'burglary', '2026-08'),
        h.ctx,
        h.budget(),
      ),
    );
    expect(result.kind).toBe('found');
    const [call] = h.upstream.calls;
    expect(call?.method).toBe('GET');
    expect(Object.fromEntries(call?.query ?? [])).toEqual({
      lat: '52.630000',
      lng: '-1.130000',
      date: '2026-08',
    });
  });

  it('sends a polygon as a form POST (poly, date), not as a query string', async () => {
    h.upstream.route('POST', '/stops-street', jsonOk(stopsBody()));
    await settle(
      h.service.queryArea(
        stopsQuery(
          {
            kind: 'polygon',
            vertices: [
              { latitude: 52.63, longitude: -1.14 },
              { latitude: 52.64, longitude: -1.12 },
              { latitude: 52.6, longitude: -1.1 },
            ],
          },
          '2026-08',
        ),
        h.ctx,
        h.budget(),
      ),
    );
    const [call] = h.upstream.calls;
    expect(call?.method).toBe('POST');
    expect(call?.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    expect(call?.query.size).toBe(0);
    expect(new URLSearchParams(call?.body).get('poly')).toBe(
      '52.630000,-1.140000:52.640000,-1.120000:52.600000,-1.100000',
    );
    expect(new URLSearchParams(call?.body).get('date')).toBe('2026-08');
  });

  it('turns a 404 on /crimes-at-location into a miss and a 404 on /stops-at-location into an error', async () => {
    h.upstream.route('GET', '/crimes-at-location', plainNotFound);
    h.upstream.route('GET', '/stops-at-location', plainNotFound);
    const miss = await settle(
      h.service.queryArea(
        crimesQuery({ kind: 'location', locationId: '1' }, 'all-crime', '2026-08'),
        h.ctx,
        h.budget(),
      ),
    );
    expect(miss).toEqual({ kind: 'miss' });
    const error = await settle(
      h.service.queryArea(
        stopsQuery({ kind: 'location', locationId: '1' }, '2026-08'),
        h.ctx,
        h.budget(),
      ),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).code).toBe(JsonRpcErrorCode.NotFound);
  });

  it('reads records through the one normalizer a route owns, so a repeat call shares the cached array', async () => {
    h.upstream.route('GET', '/crimes-street/all-crime', jsonOk(crimesBody()));
    const run = () =>
      settle(
        h.service.queryArea(
          crimesQuery({ kind: 'point', lat: 52.63, lng: -1.13 }, 'all-crime', '2026-08'),
          h.ctx,
          h.budget(),
        ),
      );
    const first = await run();
    const second = await run();
    expect(h.upstream.count('/crimes-street/all-crime')).toBe(1);
    if (first.kind !== 'found' || second.kind !== 'found') throw new Error('expected found');
    expect(second.value).toBe(first.value);
  });
});
