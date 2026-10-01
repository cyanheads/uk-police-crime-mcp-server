/**
 * @fileoverview ukcrime_search_stops through `runToolContract` (the production
 * parse of output extended with enrichment): every area arm, every filter field
 * and its semantics, paging and `next_offset`, the stop-and-search publication
 * check, every zero-hit notice, every declared error reason, the enrichment
 * fields on the zero-result page and the under-cap page and their write order,
 * upstream failure classes, blank form values, and `format()` carrying the same
 * data as `structuredContent` with upstream text kept inert.
 * @module tests/tools/search-stops.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createMockContext,
  getEnrichment,
  type MockContextLogger,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { searchStopsTool } from '@/mcp-server/tools/definitions/search-stops.tool.js';
import { ATTRIBUTION } from '@/mcp-server/tools/shared-schemas.js';
import {
  boundaryBody,
  hang,
  htmlBadRequest,
  htmlOk,
  jsonOk,
  locateBody,
  manyStops,
  overloaded,
  plainNotFound,
  rateLimited,
  sparseStopRecord,
  status,
  stopRecord,
  stopsBody,
  streetDatesBody,
  wireLocation,
} from '../fixtures/police-api-upstream.js';
import { settle, useToolHarness } from '../fixtures/service-harness.js';

type Input = z.input<typeof searchStopsTool.input>;
type Output = z.output<typeof searchStopsTool.output> & {
  attribution: string;
  cap: number;
  data_note: string;
  notice?: string;
  shown: number;
  truncated: boolean;
};
type Result = Awaited<ReturnType<typeof runToolContract>>;

const call = (input: Input) => settle(runToolContract(searchStopsTool, input));
const callRaw = (input: unknown) => settle(runToolContract(searchStopsTool, input as Input));

const data = (result: Result) => {
  expect(result.isError, JSON.stringify(result.structuredContent)).toBeFalsy();
  return result.structuredContent as unknown as Output;
};

const text = (result: Result) =>
  result.content.map((block) => (block.type === 'text' ? block.text : '')).join('');

const errorOf = (result: Result) => {
  expect(result.isError).toBe(true);
  return (
    result.structuredContent as unknown as {
      error: {
        code: number;
        message: string;
        data: {
          reason?: string;
          recovery?: { hint: string };
          retryable?: boolean;
          [k: string]: unknown;
        };
      };
    }
  ).error;
};

const LAT = 52.63;
const LNG = -1.13;
const POINT = { area: 'point', lat: LAT, lng: LNG } as const;
const FORCE = { area: 'force', force: 'leicestershire' } as const;
const RING = [
  { lat: 52.63, lng: -1.14 },
  { lat: 52.63, lng: -1.12 },
  { lat: 52.64, lng: -1.12 },
  { lat: 52.64, lng: -1.14 },
];
const MONTH_NOTE = 'No month given; searched 2026-08, the latest published month.';
const notPublished = (name: string, id: string, month = '2026-08') =>
  `${name} has not published stop and search data for ${month} to data.police.uk; call ukcrime_list_reference with topic 'availability' and force '${id}' for the months it has.`;
const ZERO_HERE = (month: string) =>
  `No stops recorded here in ${month}; try another month, a wider area, or area 'force' for the whole force, including stops it could not place.`;
const ZERO_FORCE = (month: string) =>
  `No stops recorded for this force in ${month}; try another month.`;

describe('ukcrime_search_stops', () => {
  const h = useToolHarness();

  const pointRoutes = (body: unknown = stopsBody()) => {
    h.upstream.route('GET', '/stops-street', jsonOk(body));
    h.upstream.route('GET', '/locate-neighbourhood', jsonOk(locateBody()));
  };
  const forceRoute = (body: unknown = stopsBody()) =>
    h.upstream.route('GET', '/stops-force', jsonOk(body));

  describe('area point', () => {
    it('returns totals, every breakdown and a page sorted by datetime then location, located and published', async () => {
      pointRoutes();
      const out = data(await call({ ...POINT }));
      expect(out.month).toBe('2026-08');
      expect(out.area).toEqual({
        type: 'point',
        lat: LAT,
        lng: LNG,
        located_force: 'leicestershire',
        located_neighbourhood: 'NX01',
      });
      expect(out.filters).toEqual([]);
      expect(out.total).toBe(6);
      expect(out.unfiltered_total).toBe(6);
      expect(out.unplaced).toBe(2);
      expect(out.force_published).toBe(true);
      expect(out.by_type).toEqual([
        { value: 'Person search', count: 2 },
        { value: 'Vehicle search', count: 2 },
        { value: '(not recorded)', count: 1 },
        { value: 'Person and Vehicle search', count: 1 },
      ]);
      expect(out.by_gender).toEqual([
        { value: 'Male', count: 3 },
        { value: '(not recorded)', count: 1 },
        { value: 'Female', count: 1 },
        { value: 'Other', count: 1 },
      ]);
      expect(out.by_outcome).toEqual([
        { value: '(not recorded)', count: 2 },
        { value: 'A no further action disposal', count: 2 },
        { value: 'Arrest', count: 1 },
        { value: 'Community resolution', count: 1 },
      ]);
      expect(out.by_age_range).toEqual([
        { value: '25-34', count: 2 },
        { value: '(not recorded)', count: 1 },
        { value: '10-17', count: 1 },
        { value: '18-24', count: 1 },
        { value: 'over 34', count: 1 },
      ]);
      for (const key of [
        'by_self_defined_ethnicity',
        'by_officer_defined_ethnicity',
        'by_object_of_search',
        'by_legislation',
      ] as const) {
        expect(
          out[key].reduce((sum, row) => sum + row.count, 0),
          key,
        ).toBe(6);
      }
      expect(out.stops.map((stop) => [stop.datetime, stop.location?.location_id])).toEqual([
        ['2026-08-02T03:10:00+00:00', undefined],
        ['2026-08-10T09:00:00+00:00', '1000001'],
        ['2026-08-14T21:30:00+00:00', '1000001'],
        ['2026-08-14T21:30:00+00:00', '1000002'],
        ['2026-08-20T01:15:00+00:00', undefined],
        ['2026-08-21T12:00:00+00:00', '1000001'],
      ]);
      expect(out.next_offset).toBeUndefined();
      expect(out.notice).toBe(MONTH_NOTE);
    });

    it('sends lat, lng at 6 dp and the resolved month, and locates the same point', async () => {
      pointRoutes();
      await call({ area: 'point', lat: 52.123_456_78, lng: -1.5, month: '2026-07' });
      expect(Object.fromEntries(h.upstream.callsTo('/stops-street')[0]?.query ?? [])).toEqual({
        lat: '52.123457',
        lng: '-1.500000',
        date: '2026-07',
      });
      expect(h.upstream.callsTo('/locate-neighbourhood')[0]?.query.get('q')).toBe(
        '52.123457,-1.500000',
      );
    });

    it('drops operation and outcome_object, and reads null categoricals, blank outcomes and null booleans as absent', async () => {
      pointRoutes();
      const { stops } = data(await call({ ...POINT }));
      const sparse = stops[0];
      expect(sparse).toEqual({
        datetime: '2026-08-02T03:10:00+00:00',
        type: 'Vehicle search',
        involved_person: false,
      });
      const blankOutcome = stops[3];
      expect(blankOutcome).not.toHaveProperty('outcome');
      expect(stops[1]).toMatchObject({
        operation_name: 'Operation Example',
        outcome_linked_to_object_of_search: false,
      });
      expect(stops[1]).not.toHaveProperty('removal_of_more_than_outer_clothing');
      expect(stops[2]).toMatchObject({
        involved_person: true,
        removal_of_more_than_outer_clothing: false,
      });
      expect(stops[4]).not.toHaveProperty('type');
      for (const stop of stops) {
        expect(stop).not.toHaveProperty('operation');
        expect(stop).not.toHaveProperty('outcome_object');
      }
    });

    it.each<[string, Record<string, unknown>]>([
      [
        'latitude/longitude/date',
        { area: 'point', latitude: LAT, longitude: LNG, date: '2026-07' },
      ],
      ['lon', { area: 'point', lat: LAT, lon: LNG, month: '2026-07' }],
      ['long', { area: 'point', lat: LAT, long: LNG, month: '2026-07' }],
    ])('reads the %s aliases', async (_name, input) => {
      pointRoutes();
      const out = data(await callRaw(input));
      expect(out.month).toBe('2026-07');
      expect(out.area).toMatchObject({ lat: LAT, lng: LNG });
    });
  });

  describe('area polygon', () => {
    it('POSTs the ring as a form and has no force, so no publication check and no locate', async () => {
      h.upstream.route('POST', '/stops-street', jsonOk(stopsBody()));
      const out = data(await call({ area: 'polygon', polygon: RING, month: '2026-07' }));
      expect(out.area).toEqual({ type: 'polygon', vertex_count: 4 });
      expect(out.total).toBe(6);
      expect(out).not.toHaveProperty('force_published');
      expect(out.notice).toBeUndefined();
      const [request] = h.upstream.callsTo('/stops-street');
      expect(request?.method).toBe('POST');
      expect(request?.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
      const form = new URLSearchParams(request?.body);
      expect(form.get('poly')).toBe(
        '52.630000,-1.140000:52.630000,-1.120000:52.640000,-1.120000:52.640000,-1.140000',
      );
      expect(form.get('date')).toBe('2026-07');
      expect(h.upstream.count('/locate-neighbourhood')).toBe(0);
    });

    it('reads poly as polygon and accepts the string form', async () => {
      h.upstream.route('POST', '/stops-street', jsonOk([]));
      const out = data(
        await callRaw({
          area: 'polygon',
          poly: '52.63,-1.14:52.63,-1.12:52.64,-1.12',
          month: '2026-07',
        }),
      );
      expect(out.area.vertex_count).toBe(3);
    });
  });

  describe('area location', () => {
    it('reads /stops-at-location and has no force to check publication for', async () => {
      h.upstream.route('GET', '/stops-at-location', jsonOk(stopsBody()));
      const out = data(await call({ area: 'location', location_id: '1000001', month: '2026-07' }));
      expect(out.area).toEqual({ type: 'location', location_id: '1000001' });
      expect(out.total).toBe(6);
      expect(out).not.toHaveProperty('force_published');
      expect(Object.fromEntries(h.upstream.callsTo('/stops-at-location')[0]?.query ?? [])).toEqual({
        location_id: '1000001',
        date: '2026-07',
      });
    });

    it('says so when the location holds no stops (the upstream answers [] for an unknown id)', async () => {
      h.upstream.route('GET', '/stops-at-location', jsonOk([]));
      const out = data(await call({ area: 'location', location_id: '999', month: '2026-07' }));
      expect(out.total).toBe(0);
      expect(out.notice).toBe(
        "No stops at location 999 in 2026-07; location ids come from earlier results, so check it or search area 'point'.",
      );
    });

    it('has no unknown_location: a 404 is a baseline NotFound without a reason', async () => {
      h.upstream.route('GET', '/stops-at-location', plainNotFound);
      const error = errorOf(await call({ area: 'location', location_id: '999', month: '2026-07' }));
      expect(error.code).toBe(JsonRpcErrorCode.NotFound);
      expect(error.data.reason).not.toBe('unknown_neighbourhood');
    });
  });

  describe('area neighbourhood', () => {
    const NEIGHBOURHOOD = {
      area: 'neighbourhood',
      force: 'leicestershire',
      neighbourhood_id: 'NX01',
      month: '2026-07',
    } as const;

    it('reads the boundary, POSTs it as the polygon, echoes its size and checks the named force published', async () => {
      h.upstream.route('GET', '/leicestershire/NX01/boundary', jsonOk(boundaryBody()));
      h.upstream.route('POST', '/stops-street', jsonOk(stopsBody()));
      const out = data(await call({ ...NEIGHBOURHOOD }));
      expect(out.area).toEqual({
        type: 'neighbourhood',
        force: 'leicestershire',
        neighbourhood_id: 'NX01',
        vertex_count: 5,
      });
      expect(out.total).toBe(6);
      expect(out.force_published).toBe(true);
      expect(h.upstream.count('/locate-neighbourhood')).toBe(0);
    });

    it('fails unknown_neighbourhood (NotFound) on a boundary 404, before any stop request', async () => {
      h.upstream.route('GET', '/leicestershire/zz99/boundary', plainNotFound);
      const error = errorOf(await call({ ...NEIGHBOURHOOD, neighbourhood_id: 'zz99' }));
      expect(error.code).toBe(JsonRpcErrorCode.NotFound);
      expect(error.data.reason).toBe('unknown_neighbourhood');
      expect(error.message).toBe(
        "Force 'leicestershire' has no neighbourhood 'zz99'; ids are case-sensitive.",
      );
      expect(error.data.recovery?.hint).toContain("topic 'neighbourhoods'");
      expect(h.upstream.count('/stops-street')).toBe(0);
    });

    it('rejects btp as unknown_force (British Transport Police has no neighbourhoods)', async () => {
      const error = errorOf(await call({ ...NEIGHBOURHOOD, force: 'btp' }));
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data.reason).toBe('unknown_force');
      expect(error.message).toBe('British Transport Police has no neighbourhoods.');
    });

    it('rejects an unknown force before reading a boundary', async () => {
      const error = errorOf(await call({ ...NEIGHBOURHOOD, force: 'atlantis' }));
      expect(error.data.reason).toBe('unknown_force');
      expect(error.message).toBe("No police force 'atlantis'.");
      expect(h.upstream.count('/atlantis/NX01/boundary')).toBe(0);
    });
  });

  describe('area force', () => {
    it('reads /stops-force with force and date, counting the stops the force could not place', async () => {
      forceRoute();
      const out = data(await call({ ...FORCE, month: '2026-07' }));
      expect(out.area).toEqual({ type: 'force', force: 'leicestershire' });
      expect(out.total).toBe(6);
      expect(out.unplaced).toBe(2);
      expect(out.force_published).toBe(true);
      expect(Object.fromEntries(h.upstream.callsTo('/stops-force')[0]?.query ?? [])).toEqual({
        force: 'leicestershire',
        date: '2026-07',
      });
      expect(h.upstream.count('/locate-neighbourhood')).toBe(0);
    });

    it('accepts btp without reading the force list, and reads its publication from the month list', async () => {
      forceRoute();
      const out = data(await call({ area: 'force', force: 'btp', month: '2026-07' }));
      expect(out.area.force).toBe('btp');
      expect(out.force_published).toBe(true);
      expect(out.notice).toBeUndefined();
      expect(h.upstream.count('/forces')).toBe(0);
    });

    it('rejects an unknown force before any stop request', async () => {
      const error = errorOf(await call({ area: 'force', force: 'atlantis' }));
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data.reason).toBe('unknown_force');
      expect(h.upstream.count('/stops-force')).toBe(0);
    });

    it('does not offer the unplaced-crimes arm', async () => {
      expect(
        errorOf(await callRaw({ area: 'force_unplaced', force: 'leicestershire' })).data.reason,
      ).toBe('invalid_arguments');
    });

    it('handles a force-wide month of 12,088 stops, paging 200 at a time with breakdowns over all of them', async () => {
      forceRoute(manyStops(12_088));
      const out = data(await call({ ...FORCE, month: '2026-07', limit: 200 }));
      expect(out.total).toBe(12_088);
      expect(out.unfiltered_total).toBe(12_088);
      expect(out.unplaced).toBe(1209);
      expect(out.stops).toHaveLength(200);
      expect(out.next_offset).toBe(200);
      expect(out.truncated).toBe(true);
      expect(out.by_gender.reduce((sum, row) => sum + row.count, 0)).toBe(12_088);
      expect(out.notice).toBe('Showing 1–200 of 12088; call again with offset 200 for more.');
    });
  });

  describe('filters', () => {
    const filtered = (filters: unknown, extra: Record<string, unknown> = {}) =>
      callRaw({ ...FORCE, month: '2026-07', filters, ...extra });

    it('narrows the total, every breakdown, the page and the unplaced count together; unfiltered_total stays', async () => {
      forceRoute();
      const out = data(await filtered([{ field: 'gender', value: 'Male' }]));
      expect(out.filters).toEqual([{ field: 'gender', value: 'Male' }]);
      expect(out.total).toBe(3);
      expect(out.unfiltered_total).toBe(6);
      expect(out.unplaced).toBe(1);
      expect(out.by_gender).toEqual([{ value: 'Male', count: 3 }]);
      expect(out.by_type).toEqual([
        { value: 'Person search', count: 2 },
        { value: '(not recorded)', count: 1 },
      ]);
      expect(out.stops.map((stop) => stop.datetime)).toEqual([
        '2026-08-14T21:30:00+00:00',
        '2026-08-20T01:15:00+00:00',
        '2026-08-21T12:00:00+00:00',
      ]);
    });

    it('gives a cross-tab: filter one field, read another’s breakdown', async () => {
      forceRoute();
      const out = data(await filtered([{ field: 'type', value: 'Person search' }]));
      expect(out.total).toBe(2);
      expect(out.by_age_range).toEqual([
        { value: '10-17', count: 1 },
        { value: '25-34', count: 1 },
      ]);
    });

    it('matches case-insensitively and trims the value, echoing it trimmed', async () => {
      forceRoute();
      const out = data(await filtered([{ field: 'type', value: '  PERSON SEARCH  ' }]));
      expect(out.total).toBe(2);
      expect(out.filters).toEqual([{ field: 'type', value: 'PERSON SEARCH' }]);
    });

    it('matches the whole value, not a substring', async () => {
      forceRoute();
      expect(data(await filtered([{ field: 'type', value: 'search' }])).total).toBe(0);
      expect(data(await filtered([{ field: 'type', value: 'Person' }])).total).toBe(0);
    });

    it('ANDs several filters', async () => {
      forceRoute();
      const out = data(
        await filtered([
          { field: 'gender', value: 'male' },
          { field: 'age_range', value: '10-17' },
        ]),
      );
      expect(out.total).toBe(1);
      expect(out.stops[0]?.datetime).toBe('2026-08-21T12:00:00+00:00');
    });

    it('ANDs two filters on the same field, which can only match when the values are equal', async () => {
      forceRoute();
      expect(
        data(
          await filtered([
            { field: 'gender', value: 'Male' },
            { field: 'gender', value: 'Female' },
          ]),
        ).total,
      ).toBe(0);
      expect(
        data(
          await filtered([
            { field: 'gender', value: 'Male' },
            { field: 'gender', value: 'MALE' },
          ]),
        ).total,
      ).toBe(3);
    });

    it('matches (not recorded) against an absent value, case-insensitively', async () => {
      forceRoute();
      const absent = data(await filtered([{ field: 'outcome', value: '(not recorded)' }]));
      expect(absent.total).toBe(2);
      expect(absent.stops.map((stop) => stop.outcome)).toEqual([undefined, undefined]);
      expect(data(await filtered([{ field: 'type', value: '(NOT RECORDED)' }])).total).toBe(1);
    });

    it.each<[string, string, number]>([
      ['type', 'vehicle search', 2],
      ['self_defined_ethnicity', 'Black/African/Caribbean/Black British - African', 1],
      ['officer_defined_ethnicity', 'black', 1],
      ['outcome', 'ARREST', 1],
      ['object_of_search', 'controlled drugs', 3],
      ['legislation', 'Police and Criminal Evidence Act 1984 (section 1)', 1],
      ['age_range', 'over 34', 1],
      ['gender', 'other', 1],
    ])('filters on %s = %j → %i stops', async (field, value, count) => {
      forceRoute();
      const out = data(await filtered([{ field, value }]));
      expect(out.total).toBe(count);
      expect(out.filters).toEqual([{ field, value }]);
    });

    it('pages the filtered set and reports its total', async () => {
      forceRoute();
      const out = data(await filtered([{ field: 'gender', value: 'Male' }], { limit: 2 }));
      expect(out.total).toBe(3);
      expect(out.stops).toHaveLength(2);
      expect(out.next_offset).toBe(2);
      expect(out.notice).toBe('Showing 1–2 of 3; call again with offset 2 for more.');
      const next = data(
        await filtered([{ field: 'gender', value: 'Male' }], { limit: 2, offset: 2 }),
      );
      expect(next.stops).toHaveLength(1);
      expect(next.next_offset).toBeUndefined();
    });

    it.each<[string, unknown]>([
      ['null', null],
      ['an empty string', ''],
    ])('reads %s as no filters', async (_name, filters) => {
      forceRoute();
      const out = data(await filtered(filters));
      expect(out.filters).toEqual([]);
      expect(out.total).toBe(6);
    });

    it('reads an empty list as no filters', async () => {
      forceRoute();
      const out = data(await filtered([]));
      expect(out.filters).toEqual([]);
      expect(out.total).toBe(6);
    });

    it('accepts exactly eight filters', async () => {
      forceRoute();
      const eight = Array.from({ length: 8 }, () => ({ field: 'type', value: 'Person search' }));
      expect(data(await filtered(eight)).total).toBe(2);
    });

    it.each<[string, unknown]>([
      ['nine filters', Array.from({ length: 9 }, () => ({ field: 'type', value: 'x' }))],
      [
        'a thousand filters (cut before validation)',
        Array.from({ length: 1000 }, () => ({ field: 'type', value: 'x' })),
      ],
      ['an unknown field', [{ field: 'ethnicity', value: 'x' }]],
      ['a missing value', [{ field: 'type' }]],
      ['a blank value', [{ field: 'type', value: '' }]],
      ['a whitespace-only value', [{ field: 'type', value: '   ' }]],
      ['a value over 200 characters', [{ field: 'type', value: 'a'.repeat(201) }]],
      ['an extra key on a filter', [{ field: 'type', value: 'x', op: 'contains' }]],
      ['a non-object entry', ['type']],
      ['a string instead of a list', 'type'],
      ['an object instead of a list', { field: 'type', value: 'x' }],
    ])('rejects %s as invalid_arguments', async (_name, filters) => {
      const error = errorOf(await filtered(filters));
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(error.data.reason).toBe('invalid_arguments');
      expect(h.upstream.calls).toHaveLength(0);
    });

    it('keeps the error for a thousand bad filters to a handful of issues', async () => {
      const error = errorOf(
        await filtered(Array.from({ length: 1000 }, () => ({ field: 'nope', value: 'x' }))),
      );
      expect((error.data.issues as unknown[]).length).toBeLessThanOrEqual(12);
    });

    it('accepts a value of exactly 200 characters', async () => {
      forceRoute();
      expect(data(await filtered([{ field: 'type', value: 'a'.repeat(200) }])).total).toBe(0);
    });
  });

  describe('publication check (force_published)', () => {
    it('is true and silent for a located point whose force published', async () => {
      pointRoutes();
      const out = data(await call({ ...POINT, month: '2026-07' }));
      expect(out.force_published).toBe(true);
      expect(out.notice).toBeUndefined();
    });

    it('is false with the not-published fragment for a named force, after the month fragment, even with results', async () => {
      forceRoute();
      const out = data(await call({ area: 'force', force: 'metropolitan' }));
      expect(out.force_published).toBe(false);
      expect(out.total).toBe(6);
      expect(out.notice).toBe(
        `${MONTH_NOTE} ${notPublished('Metropolitan Police Service', 'metropolitan')}`,
      );
    });

    it('names a located point’s force from the force list', async () => {
      h.upstream.route('GET', '/stops-street', jsonOk(stopsBody()));
      h.upstream.route(
        'GET',
        '/locate-neighbourhood',
        jsonOk(locateBody({ force: 'metropolitan' })),
      );
      const out = data(await call({ ...POINT, month: '2026-07' }));
      expect(out.force_published).toBe(false);
      expect(out.area.located_force).toBe('metropolitan');
      expect(out.notice).toBe(
        notPublished('Metropolitan Police Service', 'metropolitan', '2026-07'),
      );
    });

    it('falls back to the force id when a located force is not in the force list', async () => {
      h.upstream.route('GET', '/stops-street', jsonOk(stopsBody()));
      h.upstream.route(
        'GET',
        '/locate-neighbourhood',
        jsonOk(locateBody({ force: 'ghost-force' })),
      );
      const out = data(await call({ ...POINT, month: '2026-07' }));
      expect(out.force_published).toBe(false);
      expect(out.notice).toBe(notPublished('ghost-force', 'ghost-force', '2026-07'));
    });

    it('names a located force by its id, without failing the search, when the force list read fails', async () => {
      h.upstream.route('GET', '/forces', status(500));
      h.upstream.route('GET', '/stops-street', jsonOk(stopsBody()));
      h.upstream.route(
        'GET',
        '/locate-neighbourhood',
        jsonOk(locateBody({ force: 'metropolitan' })),
      );
      const out = data(await call({ ...POINT, month: '2026-07' }));
      expect(out.total).toBe(6);
      expect(out.force_published).toBe(false);
      expect(out.notice).toBe(notPublished('metropolitan', 'metropolitan', '2026-07'));
    });

    it('flattens a located force id that carries a line break in the notice', async () => {
      h.upstream.route('GET', '/stops-street', jsonOk(stopsBody()));
      h.upstream.route(
        'GET',
        '/locate-neighbourhood',
        jsonOk(locateBody({ force: 'ghost\n# force' })),
      );
      const out = data(await call({ ...POINT, month: '2026-07' }));
      expect(out.notice).toBe(notPublished('ghost # force', 'ghost # force', '2026-07'));
    });

    it('names British Transport Police when it is missing from the publisher list', async () => {
      h.upstream.route(
        'GET',
        '/crimes-street-dates',
        jsonOk(streetDatesBody({ stopSearch: ['leicestershire'] })),
      );
      forceRoute();
      const out = data(await call({ area: 'force', force: 'btp', month: '2026-07' }));
      expect(out.force_published).toBe(false);
      expect(out.notice).toBe(notPublished('British Transport Police', 'btp', '2026-07'));
    });

    it('reads publication for the month searched, not the latest month', async () => {
      h.upstream.route(
        'GET',
        '/crimes-street-dates',
        jsonOk(
          streetDatesBody({
            stopSearch: (month) => (month === '2026-05' ? [] : ['leicestershire', 'btp']),
          }),
        ),
      );
      forceRoute();
      expect(data(await call({ ...FORCE, month: '2026-05' })).force_published).toBe(false);
      expect(data(await call({ ...FORCE, month: '2026-06' })).force_published).toBe(true);
    });

    it('leaves force_published out when the month has no row in the availability list', async () => {
      h.upstream.route(
        'GET',
        '/crimes-street-dates',
        jsonOk(streetDatesBody().filter((row) => row.date !== '2026-05')),
      );
      forceRoute();
      const out = data(await call({ ...FORCE, month: '2026-05' }));
      expect(out).not.toHaveProperty('force_published');
      expect(out.notice).toBeUndefined();
    });

    it('leaves force_published out for a point whose locate failed or missed, and for polygon and location', async () => {
      h.upstream.route('GET', '/stops-street', jsonOk(stopsBody()));
      h.upstream.route('GET', '/locate-neighbourhood', status(500));
      expect(data(await call({ ...POINT, month: '2026-07' }))).not.toHaveProperty(
        'force_published',
      );
      h.upstream.route('GET', '/locate-neighbourhood', plainNotFound);
      expect(data(await call({ ...POINT, lat: 52.7, month: '2026-07' }))).not.toHaveProperty(
        'force_published',
      );
      h.upstream.route('POST', '/stops-street', jsonOk(stopsBody()));
      expect(
        data(await call({ area: 'polygon', polygon: RING, month: '2026-07' })),
      ).not.toHaveProperty('force_published');
    });

    it('reports a non-publisher on the notice and counts a month with other forces’ stops as results', async () => {
      h.upstream.route('POST', '/stops-street', jsonOk(stopsBody()));
      const out = data(await call({ area: 'polygon', polygon: RING, month: '2026-07' }));
      expect(out.total).toBe(6);
      expect(out.notice).toBeUndefined();
    });
  });

  describe('zero-hit notices', () => {
    it('after filters: lists the values present for each filtered field in the unfiltered set', async () => {
      forceRoute();
      const out = data(
        await callRaw({
          ...FORCE,
          month: '2026-07',
          filters: [
            { field: 'gender', value: 'Nonbinary' },
            { field: 'type', value: 'Person search' },
          ],
        }),
      );
      expect(out.total).toBe(0);
      expect(out.unfiltered_total).toBe(6);
      expect(out.notice).toBe(
        'No stops matched the filters; values present for gender: "Male", "(not recorded)", "Female", "Other"; values present for type: "Person search", "Vehicle search", "(not recorded)", "Person and Vehicle search".',
      );
    });

    it('lists a field once when it is filtered twice', async () => {
      forceRoute();
      const out = data(
        await callRaw({
          ...FORCE,
          month: '2026-07',
          filters: [
            { field: 'gender', value: 'a' },
            { field: 'gender', value: 'b' },
          ],
        }),
      );
      expect(out.notice?.match(/values present for gender/g)).toHaveLength(1);
    });

    it('lists at most 12 present values and counts the rest', async () => {
      const body = Array.from({ length: 15 }, (_, i) =>
        stopRecord({
          gender: `G${String(i + 1).padStart(2, '0')}`,
          datetime: `2026-08-01T00:${String(i).padStart(2, '0')}:00+00:00`,
        }),
      );
      forceRoute(body);
      const out = data(
        await callRaw({
          ...FORCE,
          month: '2026-07',
          filters: [{ field: 'gender', value: 'none' }],
        }),
      );
      const listed = Array.from(
        { length: 12 },
        (_, i) => `"G${String(i + 1).padStart(2, '0')}"`,
      ).join(', ');
      expect(out.notice).toBe(
        `No stops matched the filters; values present for gender: ${listed} and 3 more.`,
      );
    });

    it('lists exactly 12 present values without an “and more” tail', async () => {
      const body = Array.from({ length: 12 }, (_, i) =>
        stopRecord({ gender: `G${String(i + 1).padStart(2, '0')}` }),
      );
      forceRoute(body);
      const out = data(
        await callRaw({
          ...FORCE,
          month: '2026-07',
          filters: [{ field: 'gender', value: 'none' }],
        }),
      );
      expect(out.notice).not.toContain('more');
      expect(out.notice?.match(/"G\d\d"/g)).toHaveLength(12);
    });

    it('keeps upstream values inert in the notice (breaks, brackets) while structuredContent keeps them', async () => {
      forceRoute([stopRecord({ gender: 'A\r\nB [x](y) <z>' })]);
      const out = data(
        await callRaw({
          ...FORCE,
          month: '2026-07',
          filters: [{ field: 'gender', value: 'none' }],
        }),
      );
      expect(out.notice).toBe(
        'No stops matched the filters; values present for gender: "A B \\[x\\](y) \\<z\\>".',
      );
    });

    it('skips the filter fragment when the unfiltered set is empty and says the force has none', async () => {
      forceRoute([]);
      const out = data(
        await callRaw({
          ...FORCE,
          month: '2026-07',
          filters: [{ field: 'gender', value: 'Male' }],
        }),
      );
      expect(out.notice).toBe(ZERO_FORCE('2026-07'));
    });

    it('force arm, nothing recorded', async () => {
      forceRoute([]);
      expect(data(await call({ ...FORCE })).notice).toBe(`${MONTH_NOTE} ${ZERO_FORCE('2026-08')}`);
    });

    it('point arm, located, nothing recorded', async () => {
      pointRoutes([]);
      expect(data(await call({ ...POINT })).notice).toBe(`${MONTH_NOTE} ${ZERO_HERE('2026-08')}`);
    });

    it('neighbourhood arm, nothing recorded', async () => {
      h.upstream.route('GET', '/leicestershire/NX01/boundary', jsonOk(boundaryBody()));
      h.upstream.route('POST', '/stops-street', jsonOk([]));
      const out = data(
        await call({
          area: 'neighbourhood',
          force: 'leicestershire',
          neighbourhood_id: 'NX01',
          month: '2026-07',
        }),
      );
      expect(out.notice).toBe(ZERO_HERE('2026-07'));
    });

    it('point outside coverage (locate 404)', async () => {
      h.upstream.route('GET', '/stops-street', jsonOk([]));
      h.upstream.route('GET', '/locate-neighbourhood', plainNotFound);
      const out = data(await call({ ...POINT, month: '2026-07' }));
      expect(out.notice).toBe(
        'This point is outside data.police.uk coverage (England, Wales and Northern Ireland; Scotland only through British Transport Police); check that lat and lng are not swapped.',
      );
      expect(out).not.toHaveProperty('force_published');
    });

    it('polygon outside the coverage box', async () => {
      h.upstream.route('POST', '/stops-street', jsonOk([]));
      const out = data(
        await call({
          area: 'polygon',
          polygon: RING.map(({ lat, lng }) => ({ lat: lng, lng: lat })),
          month: '2026-07',
        }),
      );
      expect(out.notice).toBe(
        'This polygon lies outside data.police.uk coverage; each vertex is {lat, lng}, so check the two were not swapped.',
      );
    });

    it('polygon inside the box, nothing recorded', async () => {
      h.upstream.route('POST', '/stops-street', jsonOk([]));
      expect(data(await call({ area: 'polygon', polygon: RING, month: '2026-07' })).notice).toBe(
        ZERO_HERE('2026-07'),
      );
    });

    it('a force that did not publish: only the not-published fragment, not “no stops recorded”', async () => {
      forceRoute([]);
      const out = data(await call({ area: 'force', force: 'metropolitan', month: '2026-07' }));
      expect(out.total).toBe(0);
      expect(out.force_published).toBe(false);
      expect(out.notice).toBe(
        notPublished('Metropolitan Police Service', 'metropolitan', '2026-07'),
      );
    });

    it('a point inside a non-publishing force: the not-published fragment replaces the generic one', async () => {
      h.upstream.route('GET', '/stops-street', jsonOk([]));
      h.upstream.route(
        'GET',
        '/locate-neighbourhood',
        jsonOk(locateBody({ force: 'metropolitan' })),
      );
      const out = data(await call({ ...POINT, month: '2026-07' }));
      expect(out.notice).toBe(
        notPublished('Metropolitan Police Service', 'metropolitan', '2026-07'),
      );
    });

    it('a location with no stops keeps its own fragment even when no force is known', async () => {
      h.upstream.route('GET', '/stops-at-location', jsonOk([]));
      const out = data(await call({ area: 'location', location_id: '1000001' }));
      expect(out.notice).toBe(
        `${MONTH_NOTE} No stops at location 1000001 in 2026-08; location ids come from earlier results, so check it or search area 'point'.`,
      );
    });

    it('filters over a non-empty location result keep the filter fragment, not the location one', async () => {
      h.upstream.route('GET', '/stops-at-location', jsonOk(stopsBody()));
      const out = data(
        await callRaw({
          area: 'location',
          location_id: '1000001',
          month: '2026-07',
          filters: [{ field: 'gender', value: 'none' }],
        }),
      );
      expect(out.notice).toContain('No stops matched the filters');
      expect(out.notice).not.toContain('No stops at location');
    });
  });

  describe('paging', () => {
    it('slices the sorted records, with next_offset and the range fragment', async () => {
      forceRoute();
      const result = await call({ ...FORCE, month: '2026-07', limit: 4 });
      const out = data(result);
      expect(out.stops).toHaveLength(4);
      expect(out.next_offset).toBe(4);
      expect(out.truncated).toBe(true);
      expect(out.shown).toBe(4);
      expect(out.cap).toBe(4);
      expect(out.notice).toBe('Showing 1–4 of 6; call again with offset 4 for more.');
      expect(text(result)).toContain('**Next offset:** 4');
    });

    it('walks every stop once by following next_offset, reading the upstream once', async () => {
      forceRoute();
      const seen: string[] = [];
      let offset: number | undefined = 0;
      while (offset !== undefined) {
        const out: Output = data(await call({ ...FORCE, month: '2026-07', limit: 4, offset }));
        seen.push(...out.stops.map((stop) => `${stop.datetime}|${stop.location?.location_id}`));
        offset = out.next_offset;
      }
      expect(seen).toHaveLength(6);
      expect(h.upstream.count('/stops-force')).toBe(1);
    });

    it.each([6, 7, 99])('says an offset of %i is past the last of 6 stops', async (offset) => {
      forceRoute();
      const out = data(await call({ ...FORCE, month: '2026-07', offset }));
      expect(out.stops).toEqual([]);
      expect(out.shown).toBe(0);
      expect(out.truncated).toBe(false);
      expect(out.total).toBe(6);
      expect(out.notice).toBe(
        `offset ${offset} is past the last of 6 stops; omit offset to start from the first.`,
      );
    });

    it('uses a default page of 15', async () => {
      forceRoute(manyStops(60));
      const out = data(await call({ ...FORCE, month: '2026-07' }));
      expect(out.stops).toHaveLength(15);
      expect(out.cap).toBe(15);
      expect(out.next_offset).toBe(15);
    });

    it.each<[string, Record<string, unknown>]>([
      ['limit 0', { limit: 0 }],
      ['limit 201', { limit: 201 }],
      ['a fractional limit', { limit: 2.5 }],
      ['a negative offset', { offset: -1 }],
    ])('rejects %s as invalid_arguments', async (_name, extra) => {
      const error = errorOf(await callRaw({ ...FORCE, ...extra }));
      expect(error.data.reason).toBe('invalid_arguments');
      expect(h.upstream.calls).toHaveLength(0);
    });
  });

  describe('month', () => {
    it('fails month_not_published for a month after the latest', async () => {
      const error = errorOf(await call({ ...FORCE, month: '2026-09' }));
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data.reason).toBe('month_not_published');
      expect(error.message).toBe(
        '2026-09 is not published yet; the latest published month is 2026-08.',
      );
      expect(error.data.recovery?.hint).toContain("topic 'availability'");
      expect(h.upstream.count('/stops-force')).toBe(0);
    });

    it('fails month_out_of_range for a month before the window (the upstream would 502)', async () => {
      const error = errorOf(await call({ ...FORCE, month: '2023-08' }));
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data.reason).toBe('month_out_of_range');
      expect(error.message).toBe(
        '2023-08 is before 2023-09, the earliest month data.police.uk still serves.',
      );
      expect(h.upstream.count('/stops-force')).toBe(0);
    });

    it('reports a bad month before an unknown force', async () => {
      expect(
        errorOf(await call({ area: 'force', force: 'atlantis', month: '2026-09' })).data.reason,
      ).toBe('month_not_published');
    });

    it('reads the date alias', async () => {
      forceRoute();
      expect(data(await callRaw({ ...FORCE, date: '2025-02' })).month).toBe('2025-02');
    });
  });

  describe('invalid_area', () => {
    it.each<[string, Record<string, unknown>, string]>([
      [
        'point without lat',
        { area: 'point', lng: LNG },
        "area 'point' needs lat and lng; lat is missing.",
      ],
      ['force without a force', { area: 'force' }, "area 'force' needs force; force is missing."],
      [
        'location with nothing',
        { area: 'location' },
        "area 'location' needs location_id; location_id is missing.",
      ],
      [
        'force with a neighbourhood id',
        { area: 'force', force: 'leicestershire', neighbourhood_id: 'NX01' },
        "area 'force' does not use neighbourhood_id; remove it or choose the area that takes it.",
      ],
      [
        'polygon with a force',
        { area: 'polygon', polygon: RING, force: 'leicestershire' },
        "area 'polygon' does not use force; remove it or choose the area that takes it.",
      ],
      [
        'neighbourhood with coordinates',
        {
          area: 'neighbourhood',
          force: 'leicestershire',
          neighbourhood_id: 'NX01',
          lat: 1,
          lng: 2,
        },
        "area 'neighbourhood' does not use lat and lng; remove them or choose the area that takes them.",
      ],
    ])('rejects %s', async (_name, input, message) => {
      const error = errorOf(await callRaw(input));
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data.reason).toBe('invalid_area');
      expect(error.message).toBe(message);
      expect(error.data.recovery?.hint).toBe(
        "Send lat and lng for area 'point', polygon for 'polygon', location_id for 'location', force and neighbourhood_id for 'neighbourhood', or force alone for 'force'.",
      );
      expect(h.upstream.calls).toHaveLength(0);
    });
  });

  describe('blank values read as unset (form clients)', () => {
    it('accepts empty strings and nulls on every optional input an arm does not use', async () => {
      pointRoutes();
      const out = data(
        await callRaw({
          ...POINT,
          polygon: '',
          location_id: ' ',
          force: '',
          neighbourhood_id: '\t',
          month: '',
          filters: '',
        }),
      );
      expect(out.total).toBe(6);
      expect(out.notice).toBe(MONTH_NOTE);
      pointRoutes();
      const withNulls = data(
        await callRaw({
          ...POINT,
          polygon: null,
          location_id: null,
          force: null,
          neighbourhood_id: null,
          month: null,
          filters: null,
        }),
      );
      expect(withNulls.total).toBe(6);
    });

    it('treats a blank required field as missing (invalid_area)', async () => {
      const error = errorOf(await callRaw({ area: 'force', force: '   ' }));
      expect(error.data.reason).toBe('invalid_area');
    });
  });

  describe('enrichment: the zero-result page and the under-cap page', () => {
    it('zero-result page carries every required field and a notice', async () => {
      forceRoute([]);
      const result = await call({ ...FORCE, limit: 10 });
      const out = data(result);
      expect(out.attribution).toBe(ATTRIBUTION);
      expect(out.data_note).toMatch(
        /^Locations are anonymised map points, not where stops happened/,
      );
      expect(out.truncated).toBe(false);
      expect(out.shown).toBe(0);
      expect(out.cap).toBe(10);
      expect(out.notice).toBe(`${MONTH_NOTE} ${ZERO_FORCE('2026-08')}`);
      expect(out.total).toBe(0);
      expect(out.unfiltered_total).toBe(0);
      expect(out.unplaced).toBe(0);
      for (const key of [
        'by_type',
        'by_self_defined_ethnicity',
        'by_officer_defined_ethnicity',
        'by_outcome',
        'by_object_of_search',
        'by_legislation',
        'by_age_range',
        'by_gender',
        'stops',
      ] as const) {
        expect(out[key], key).toEqual([]);
      }
      const rendered = text(result);
      for (const label of ['Attribution', 'Data note', 'More rows', 'Rows shown', 'Page limit']) {
        expect(rendered).toContain(`**${label}:**`);
      }
    });

    it('under-cap page: shown below the cap, truncated false', async () => {
      forceRoute();
      const result = await call({ ...FORCE, month: '2026-07', limit: 25 });
      const out = data(result);
      expect(out.attribution).toBe(ATTRIBUTION);
      expect(out.data_note).toContain('datetime is UTC while months follow UK local time');
      expect(out.shown).toBe(6);
      expect(out.cap).toBe(25);
      expect(out.truncated).toBe(false);
      expect(out.notice).toBeUndefined();
      expect(text(result)).toContain('**Rows shown:** 6');
      expect(text(result)).toContain('**Page limit:** 25');
    });

    it('zero-result page on every other arm still carries the required fields', async () => {
      h.upstream.route('POST', '/stops-street', jsonOk([]));
      h.upstream.route('GET', '/stops-at-location', jsonOk([]));
      h.upstream.route('GET', '/leicestershire/NX01/boundary', jsonOk(boundaryBody()));
      h.upstream.route('GET', '/stops-street', jsonOk([]));
      h.upstream.route('GET', '/locate-neighbourhood', jsonOk(locateBody()));
      const inputs: Input[] = [
        { area: 'point', lat: LAT, lng: LNG, month: '2026-07' },
        { area: 'polygon', polygon: RING, month: '2026-07' },
        { area: 'location', location_id: '1000001', month: '2026-07' },
        {
          area: 'neighbourhood',
          force: 'leicestershire',
          neighbourhood_id: 'NX01',
          month: '2026-07',
        },
      ];
      for (const input of inputs) {
        const out = data(await call(input));
        expect(out.attribution, input.area).toBe(ATTRIBUTION);
        expect(out.data_note, input.area).toBeTruthy();
        expect(out.truncated, input.area).toBe(false);
        expect(out.shown, input.area).toBe(0);
        expect(out.cap, input.area).toBe(15);
        expect(out.notice, input.area).toBeTruthy();
      }
    });

    it('under-cap page after filters', async () => {
      forceRoute();
      const out = data(
        await callRaw({
          ...FORCE,
          month: '2026-07',
          limit: 5,
          filters: [{ field: 'gender', value: 'Male' }],
        }),
      );
      expect(out.shown).toBe(3);
      expect(out.cap).toBe(5);
      expect(out.truncated).toBe(false);
    });
  });

  describe('enrichment write order (direct handler)', () => {
    const run = async (raw: Input) => {
      const ctx = createMockContext({ errors: searchStopsTool.errors });
      const input = searchStopsTool.input.parse(raw);
      const output = await settle(Promise.resolve(searchStopsTool.handler(input, ctx))).catch(
        (e: unknown) => e,
      );
      return { ctx, output };
    };

    it('writes the five required fields first, then notice last, overwriting truncated and shown in place', async () => {
      forceRoute();
      const { ctx, output } = await run({ ...FORCE, limit: 4 });
      expect(output).toMatchObject({ total: 6, next_offset: 4 });
      expect(Object.keys(getEnrichment(ctx))).toEqual([
        'attribution',
        'data_note',
        'truncated',
        'shown',
        'cap',
        'notice',
      ]);
      expect(getEnrichment(ctx)).toMatchObject({ truncated: true, shown: 4, cap: 4 });
    });

    it('writes no notice when there is nothing to say', async () => {
      forceRoute();
      const { ctx } = await run({ ...FORCE, month: '2026-07' });
      expect(Object.keys(getEnrichment(ctx))).toEqual([
        'attribution',
        'data_note',
        'truncated',
        'shown',
        'cap',
      ]);
    });

    it('has the five required fields in place when the first check fails', async () => {
      const { ctx, output } = await run({ area: 'force' });
      expect(output).toMatchObject({ data: { reason: 'invalid_area' } });
      expect(getEnrichment(ctx)).toEqual({
        attribution: ATTRIBUTION,
        data_note: expect.any(String),
        truncated: false,
        shown: 0,
        cap: 15,
      });
    });

    it('logs a quiet warning, not an error, when only the locate fails', async () => {
      h.upstream.route('GET', '/stops-street', jsonOk(stopsBody()));
      h.upstream.route('GET', '/locate-neighbourhood', status(500));
      const { ctx, output } = await run({ ...POINT, month: '2026-07' });
      expect(output).toMatchObject({ total: 6 });
      const log = ctx.log as MockContextLogger;
      expect(log.calls.filter((c) => c.level === 'warning')).toHaveLength(1);
      expect(log.calls.some((c) => c.level === 'error')).toBe(false);
    });
  });

  describe('upstream failures on the area query', () => {
    it.each<[string, () => void, number, string | undefined]>([
      [
        'a persistent 500',
        () => h.upstream.route('GET', '/stops-force', status(500)),
        JsonRpcErrorCode.ServiceUnavailable,
        undefined,
      ],
      [
        'a 429 with a long Retry-After',
        () => h.upstream.route('GET', '/stops-force', rateLimited('60')),
        JsonRpcErrorCode.RateLimited,
        undefined,
      ],
      [
        'an HTML 200 body',
        () => h.upstream.route('GET', '/stops-force', htmlOk),
        JsonRpcErrorCode.ServiceUnavailable,
        'unreadable_response',
      ],
      [
        'an object where a list was expected',
        () => h.upstream.route('GET', '/stops-force', jsonOk({ stops: [] })),
        JsonRpcErrorCode.ServiceUnavailable,
        'unexpected_response',
      ],
      [
        'a stop with no datetime',
        () => h.upstream.route('GET', '/stops-force', jsonOk([{ type: 'Person search' }])),
        JsonRpcErrorCode.ServiceUnavailable,
        'unexpected_response',
      ],
      [
        'a stop with a numeric gender',
        () => h.upstream.route('GET', '/stops-force', jsonOk([stopRecord({ gender: 7 })])),
        JsonRpcErrorCode.ServiceUnavailable,
        'unexpected_response',
      ],
      [
        'an upstream that never answers',
        () => h.upstream.route('GET', '/stops-force', hang),
        JsonRpcErrorCode.Timeout,
        undefined,
      ],
      [
        'a 400 the server built',
        () => h.upstream.route('GET', '/stops-force', htmlBadRequest),
        JsonRpcErrorCode.InvalidParams,
        undefined,
      ],
      [
        'a 502 (the route’s answer for a month before the window)',
        () => h.upstream.route('GET', '/stops-force', status(502)),
        JsonRpcErrorCode.ServiceUnavailable,
        undefined,
      ],
    ])('surfaces %s as a classified error', async (_name, arrange, code, reason) => {
      arrange();
      const error = errorOf(await call({ ...FORCE, month: '2026-07' }));
      expect(error.code).toBe(code);
      if (reason) expect(error.data.reason).toBe(reason);
    });

    it('names the route, never the upstream body, in an unexpected_response', async () => {
      h.upstream.route('GET', '/stops-force', jsonOk({ secret: 'upstream-only-text' }));
      const result = await call({ ...FORCE, month: '2026-07' });
      expect(errorOf(result).message).toContain('/stops-force');
      expect(JSON.stringify(result)).not.toContain('upstream-only-text');
    });

    it('fails a month-list read that fails without touching the stops route', async () => {
      h.upstream.route('GET', '/crimes-street-dates', status(500));
      expect(errorOf(await call({ ...FORCE })).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(h.upstream.count('/stops-force')).toBe(0);
    });

    it('fails a force-list read that fails for a force arm', async () => {
      h.upstream.route('GET', '/forces', status(500));
      expect(errorOf(await call({ ...FORCE })).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    });
  });

  describe('503 on the area query (area_too_large vs upstream_unavailable)', () => {
    it('point: area_too_large with the point wording as the recovery hint', async () => {
      h.upstream.route('GET', '/stops-street', overloaded);
      h.upstream.route('GET', '/locate-neighbourhood', jsonOk(locateBody()));
      const error = errorOf(await call({ ...POINT, month: '2026-07' }));
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data.reason).toBe('area_too_large');
      expect(error.data.recovery?.hint).toBe(
        "A 1-mile circle here holds too many stops for data.police.uk to answer; search area 'polygon' with a smaller ring around the point.",
      );
      expect(h.upstream.count('/crime-last-updated')).toBe(1);
    });

    it('polygon: area_too_large with the declared recovery', async () => {
      h.upstream.route('POST', '/stops-street', overloaded);
      const error = errorOf(await call({ area: 'polygon', polygon: RING, month: '2026-07' }));
      expect(error.data.reason).toBe('area_too_large');
      expect(error.data.recovery?.hint).toBe(
        'Search a smaller area: split the polygon into smaller polygons, or search a neighbourhood or a point instead.',
      );
    });

    it('force: a 503 still runs the probe', async () => {
      h.upstream.route('GET', '/stops-force', overloaded);
      const error = errorOf(await call({ ...FORCE, month: '2026-07' }));
      expect(error.data.reason).toBe('area_too_large');
      expect(h.upstream.count('/crime-last-updated')).toBe(1);
    });

    it.each<[string, () => void]>([
      ['a failing probe', () => h.upstream.route('GET', '/crime-last-updated', status(500))],
      ['a hung probe', () => h.upstream.route('GET', '/crime-last-updated', hang)],
    ])('is upstream_unavailable, retryable, with %s', async (_name, arrange) => {
      h.upstream.route('GET', '/stops-force', overloaded);
      arrange();
      const error = errorOf(await call({ ...FORCE, month: '2026-07' }));
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.data.reason).toBe('upstream_unavailable');
      expect(error.data.retryable).toBe(true);
    });
  });

  describe('the locate beside a point search', () => {
    it('degrades to an unlocated echo and a result without force_published when the locate fails', async () => {
      h.upstream.route('GET', '/stops-street', jsonOk(stopsBody()));
      h.upstream.route('GET', '/locate-neighbourhood', status(500));
      const out = data(await call({ ...POINT, month: '2026-07' }));
      expect(out.total).toBe(6);
      expect(out.area).toEqual({ type: 'point', lat: LAT, lng: LNG });
      expect(out).not.toHaveProperty('force_published');
      expect(out.notice).toBeUndefined();
    });

    it('caches the locate across searches of the same point', async () => {
      pointRoutes();
      await call({ ...POINT, month: '2026-07' });
      await call({ ...POINT, month: '2026-06' });
      expect(h.upstream.count('/locate-neighbourhood')).toBe(1);
    });
  });

  describe('format() matches structuredContent', () => {
    it('renders the header lines, every breakdown section, and every stop', async () => {
      pointRoutes();
      const result = await call({ ...POINT });
      const out = data(result);
      const rendered = text(result);
      expect(rendered).toContain('## Stop and search — 2026-08');
      expect(rendered).toContain(
        '**Area:** point · lat 52.63 · lng -1.13 · located force leicestershire · located neighbourhood NX01',
      );
      expect(rendered).toContain('**Filters:** none');
      expect(rendered).toContain('**Stops matched:** 6 of 6 · **Without a location:** 2');
      expect(rendered).toContain('**Force published stop and search for this month:** yes');
      for (const title of [
        'By search type',
        'By self-defined ethnicity',
        'By officer-defined ethnicity',
        'By outcome',
        'By object of search',
        'By legislation',
        'By age range',
        'By gender',
      ]) {
        expect(rendered).toContain(`### ${title}`);
      }
      for (const rows of [
        out.by_type,
        out.by_outcome,
        out.by_gender,
        out.by_age_range,
        out.by_legislation,
      ]) {
        for (const row of rows) expect(rendered).toContain(`| ${row.value} | ${row.count} |`);
      }
      expect(rendered).toContain('### Stops on this page (6)');
      for (const stop of out.stops) expect(rendered).toContain(`**${stop.datetime}**`);
      expect(rendered).toContain(`> ${out.notice}`);
    });

    it('renders every stop field, booleans as yes and no', async () => {
      forceRoute([stopsBody()[1]]);
      const rendered = text(await call({ ...FORCE, month: '2026-07' }));
      expect(rendered).toContain(
        '- **2026-08-10T09:00:00+00:00** · Vehicle search · person involved: no · gender: Female · age: 18-24 · self-defined ethnicity: Black/African/Caribbean/Black British - African · officer-defined ethnicity: Black · legislation: Police and Criminal Evidence Act 1984 (section 1) · object of search: Stolen goods · outcome: Arrest · outcome linked to object of search: no · operation: Operation Example',
      );
      expect(rendered).toContain(
        '  - Location: On or near Example Street · location_id 1000001 · anonymised map point 52.63, -1.13',
      );
      forceRoute([stopRecord()]);
      const other = text(await call({ ...FORCE, month: '2026-06' }));
      expect(other).toContain('outcome linked to object of search: yes');
      expect(other).toContain('more than outer clothing removed: no');
    });

    it('renders a bare line for a stop with every categorical missing and no location', async () => {
      forceRoute([sparseStopRecord()]);
      const rendered = text(await call({ ...FORCE, month: '2026-07' }));
      expect(rendered).toContain(
        '- **2026-08-02T03:10:00+00:00** · Vehicle search · person involved: no',
      );
      expect(rendered).not.toContain('Location:');
    });

    it('renders the filters line with the values as echoed', async () => {
      forceRoute();
      const rendered = text(
        await callRaw({
          ...FORCE,
          month: '2026-07',
          filters: [
            { field: 'gender', value: 'Male' },
            { field: 'type', value: '(not recorded)' },
          ],
        }),
      );
      expect(rendered).toContain('**Filters:** gender = "Male"; type = "(not recorded)"');
      expect(rendered).toContain('**Stops matched:** 1 of 6');
    });

    it('renders force_published no, and omits the line when it is unknown', async () => {
      forceRoute();
      expect(
        text(await call({ area: 'force', force: 'metropolitan', month: '2026-07' })),
      ).toContain('**Force published stop and search for this month:** no');
      h.upstream.route('POST', '/stops-street', jsonOk(stopsBody()));
      expect(text(await call({ area: 'polygon', polygon: RING, month: '2026-07' }))).not.toContain(
        'Force published',
      );
    });

    it('renders none markers for an empty result and the next offset when paging', async () => {
      forceRoute([]);
      const empty = text(await call({ ...FORCE, month: '2026-07' }));
      expect(empty).toContain('### Stops on this page (0)\n\n_None._');
      expect(empty).toContain('### By search type\n\n_None._');
      expect(empty).not.toContain('Next offset');
      forceRoute();
      expect(text(await call({ ...FORCE, month: '2026-06', limit: 2 }))).toContain(
        '**Next offset:** 2',
      );
    });

    it('keeps upstream text verbatim in structuredContent and inert in the markdown', async () => {
      const hostile =
        'Evil\r\n# Injected | cell [x](https://evil.test) <b>\u202Etxt\u2028tail\u0085end';
      forceRoute([
        stopRecord({
          gender: hostile,
          type: `Type\r\n# T ${hostile}`,
          outcome: 'Out | come\n- bullet',
          object_of_search: hostile,
          legislation: hostile,
          age_range: hostile,
          self_defined_ethnicity: hostile,
          officer_defined_ethnicity: hostile,
          operation_name: hostile,
          location: wireLocation(7, `On or near ${hostile}`),
        }),
      ]);
      const result = await call({ ...FORCE, month: '2026-07' });
      const out = data(result);
      expect(out.stops[0]?.gender).toBe(hostile);
      expect(out.stops[0]?.operation_name).toBe(hostile);
      expect(out.by_gender[0]?.value).toBe(hostile);
      const rendered = text(result);
      expect(rendered).not.toMatch(/[\r\u202E\u2028\u2029\u0085]/);
      expect(rendered.split('\n').some((line) => line.startsWith('# '))).toBe(false);
      expect(rendered.split('\n').some((line) => line.startsWith('- bullet'))).toBe(false);
      expect(rendered).toContain(
        'Evil # Injected \\| cell \\[x\\](https://evil.test) \\<b\\>txt tail end',
      );
      const row = rendered.split('\n').find((line) => line.startsWith('| Out'));
      expect(row).toBe('| Out \\| come - bullet | 1 |');
    });

    it('keeps a filter value with a break and a quote out of the filters line', async () => {
      forceRoute([stopRecord({ gender: 'a' })]);
      const rendered = text(
        await callRaw({
          ...FORCE,
          month: '2026-07',
          filters: [{ field: 'gender', value: 'x\r\n# Heading [l](u)' }],
        }),
      );
      expect(rendered).not.toContain('\r');
      expect(rendered.split('\n').some((line) => line.startsWith('# Heading'))).toBe(false);
      expect(rendered).toContain('**Filters:** gender = "x # Heading \\[l\\](u)"');
    });

    it('format() of a minimal output renders without force_published', () => {
      const blocks = searchStopsTool.format?.({
        month: '2026-08',
        area: { type: 'force', force: 'btp' },
        filters: [],
        total: 0,
        unfiltered_total: 0,
        unplaced: 0,
        by_type: [],
        by_self_defined_ethnicity: [],
        by_officer_defined_ethnicity: [],
        by_outcome: [],
        by_object_of_search: [],
        by_legislation: [],
        by_age_range: [],
        by_gender: [],
        stops: [],
      });
      const rendered =
        blocks?.map((block) => (block.type === 'text' ? block.text : '')).join('') ?? '';
      expect(rendered).toContain('**Stops matched:** 0 of 0');
      expect(rendered).not.toContain('Force published');
    });
  });

  describe('caching across calls', () => {
    it('serves a repeated search from the area cache and reads the reference lists once', async () => {
      forceRoute();
      await call({ ...FORCE, month: '2026-07' });
      await call({ ...FORCE, month: '2026-07', limit: 3 });
      await call({ ...FORCE, month: '2026-07', filters: [{ field: 'gender', value: 'Male' }] });
      expect(h.upstream.count('/stops-force')).toBe(1);
      expect(h.upstream.count('/crimes-street-dates')).toBe(1);
      expect(h.upstream.count('/forces')).toBe(1);
    });

    it('does not read the force list for arms that name no force', async () => {
      pointRoutes();
      await call({ ...POINT, month: '2026-07' });
      expect(h.upstream.count('/forces')).toBe(0);
    });
  });
});
