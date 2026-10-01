/**
 * @fileoverview ukcrime_search_crimes through `runToolContract` (the production
 * parse of output extended with enrichment): every area arm, the category and
 * month inputs, paging and `next_offset`, every zero-hit notice, every declared
 * error reason, the enrichment fields on the zero-result page and the under-cap
 * page and their write order, upstream failure classes, blank form values, and
 * `format()` carrying the same data as `structuredContent` with upstream text
 * kept inert.
 * @module tests/tools/search-crimes.tool.test
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
import { searchCrimesTool } from '@/mcp-server/tools/definitions/search-crimes.tool.js';
import { ATTRIBUTION } from '@/mcp-server/tools/shared-schemas.js';
import { coverageNotes } from '@/services/police-api/known-gaps.js';
import {
  boundaryBody,
  crimeRecord,
  crimesBody,
  hang,
  htmlBadRequest,
  htmlOk,
  jsonOk,
  lastUpdatedBody,
  locateBody,
  manyCrimes,
  overloaded,
  plainNotFound,
  rateLimited,
  sequence,
  sparseCrimeRecord,
  status,
  streamOfBytes,
  streetDatesBody,
  unplacedCrimesBody,
  wireLocation,
} from '../fixtures/police-api-upstream.js';
import { settle, useToolHarness } from '../fixtures/service-harness.js';

type Input = z.input<typeof searchCrimesTool.input>;
type Output = z.output<typeof searchCrimesTool.output> & {
  attribution: string;
  cap: number;
  data_note: string;
  notice?: string;
  shown: number;
  truncated: boolean;
};
type Result = Awaited<ReturnType<typeof runToolContract>>;

const call = (input: Input) => settle(runToolContract(searchCrimesTool, input));
const callRaw = (input: unknown) => settle(runToolContract(searchCrimesTool, input as Input));

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
const RING = [
  { lat: 52.63, lng: -1.14 },
  { lat: 52.63, lng: -1.12 },
  { lat: 52.64, lng: -1.12 },
  { lat: 52.64, lng: -1.14 },
];
const MONTH_NOTE = 'No month given; searched 2026-08, the latest published month.';
const ZERO_GENERIC =
  "Nothing recorded here in 2026-08. A force can miss a month the API still lists as published (https://data.police.uk/changelog/); try another month, a wider area, or area 'force_unplaced' for crimes the force could not place.";

describe('ukcrime_search_crimes', () => {
  const h = useToolHarness();

  /** Routes the point arm: the area body and the locate answer. */
  const pointRoutes = (body: unknown = crimesBody(), category = 'all-crime') => {
    h.upstream.route('GET', `/crimes-street/${category}`, jsonOk(body));
    h.upstream.route('GET', '/locate-neighbourhood', jsonOk(locateBody()));
  };

  describe('area point', () => {
    it('returns the total, breakdowns, busiest map points and a sorted page, located and with the month defaulted', async () => {
      pointRoutes();
      const result = await call({ ...POINT });
      const out = data(result);
      expect(out.month).toBe('2026-08');
      expect(out.area).toEqual({
        type: 'point',
        lat: LAT,
        lng: LNG,
        located_force: 'leicestershire',
        located_neighbourhood: 'NX01',
      });
      expect(out.category).toEqual({ slug: 'all-crime', name: 'All crime' });
      expect(out.total).toBe(7);
      expect(out.by_category).toEqual([
        { value: 'burglary', count: 3 },
        { value: 'anti-social-behaviour', count: 2 },
        { value: 'vehicle-crime', count: 1 },
        { value: 'violent-crime', count: 1 },
      ]);
      expect(out.by_outcome).toEqual([
        { value: 'Under investigation', count: 4 },
        { value: '(not recorded)', count: 2 },
        { value: 'Unable to prosecute suspect', count: 1 },
      ]);
      expect(out.top_locations).toEqual([
        {
          location_id: '1000001',
          street_name: 'On or near Example Street',
          count: 5,
          map_point: { latitude: 52.63, longitude: -1.13 },
        },
        {
          location_id: '1000002',
          street_name: 'On or near Example Road',
          count: 1,
          map_point: { latitude: 52.631, longitude: -1.131 },
        },
        {
          location_id: '1000003',
          street_name: 'On or near Example Close',
          count: 1,
          map_point: { latitude: 52.632, longitude: -1.132 },
        },
      ]);
      expect(out.crimes.map((crime) => crime.id)).toEqual([
        '100000050',
        '100000051',
        '100000030',
        '100000032',
        '100000031',
        '100000060',
        '100000040',
      ]);
      expect(out.next_offset).toBeUndefined();
      expect(out.notice).toBe(MONTH_NOTE);
    });

    it('shapes each crime: persistent_id only when present, outcome only when present, context verbatim', async () => {
      pointRoutes();
      const { crimes } = data(await call({ ...POINT }));
      const asb = crimes.find((crime) => crime.id === '100000050');
      expect(asb).toEqual({
        id: '100000050',
        category: 'anti-social-behaviour',
        month: '2026-08',
        location: {
          location_id: '1000001',
          street_name: 'On or near Example Street',
          map_point: { latitude: 52.63, longitude: -1.13 },
        },
      });
      expect(crimes.find((crime) => crime.id === '100000040')).toMatchObject({
        context: 'Line one\r\nLine two',
        persistent_id: 'd'.repeat(64),
        outcome: { name: 'Under investigation', month: '2026-08' },
      });
      expect(crimes.find((crime) => crime.id === '100000060')?.location).toMatchObject({
        type: 'BTP',
        subtype: 'Railway Station',
      });
    });

    it('sends lat and lng at 6 dp with the resolved month, and locates the same point', async () => {
      pointRoutes();
      await call({ area: 'point', lat: 52.123_456_78, lng: -1.5 });
      const [area] = h.upstream.callsTo('/crimes-street/all-crime');
      expect(area?.method).toBe('GET');
      expect(Object.fromEntries(area?.query ?? [])).toEqual({
        lat: '52.123457',
        lng: '-1.500000',
        date: '2026-08',
      });
      expect(h.upstream.callsTo('/locate-neighbourhood')[0]?.query.get('q')).toBe(
        '52.123457,-1.500000',
      );
    });

    it('accepts the coordinates 0, 0 as values', async () => {
      h.upstream.route('GET', '/crimes-street/all-crime', jsonOk([]));
      h.upstream.route('GET', '/locate-neighbourhood', plainNotFound);
      const out = data(await call({ area: 'point', lat: 0, lng: 0 }));
      expect(out.area).toEqual({ type: 'point', lat: 0, lng: 0 });
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
      expect(out.area).toMatchObject({ type: 'point', lat: LAT, lng: LNG });
      expect(out.notice).toBeUndefined();
      expect(h.upstream.callsTo('/crimes-street/all-crime')[0]?.query.get('date')).toBe('2026-07');
    });

    it('reads poly as polygon', async () => {
      h.upstream.route('POST', '/crimes-street/all-crime', jsonOk(crimesBody()));
      const out = data(await callRaw({ area: 'polygon', poly: RING }));
      expect(out.area).toEqual({ type: 'polygon', vertex_count: 4 });
    });
  });

  describe('area polygon', () => {
    it('POSTs the ring as a form (poly, date), 6 dp, and echoes the vertex count; no locate, no force notes', async () => {
      h.upstream.route('POST', '/crimes-street/all-crime', jsonOk(crimesBody()));
      const result = await call({ area: 'polygon', polygon: RING, month: '2026-07' });
      const out = data(result);
      expect(out.area).toEqual({ type: 'polygon', vertex_count: 4 });
      expect(out.total).toBe(7);
      expect(out.notice).toBeUndefined();
      const [request] = h.upstream.callsTo('/crimes-street/all-crime');
      expect(request?.method).toBe('POST');
      expect(request?.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
      const form = new URLSearchParams(request?.body);
      expect(form.get('poly')).toBe(
        '52.630000,-1.140000:52.630000,-1.120000:52.640000,-1.120000:52.640000,-1.140000',
      );
      expect(form.get('date')).toBe('2026-07');
      expect(h.upstream.count('/locate-neighbourhood')).toBe(0);
    });

    it('accepts the string form lat,lng:lat,lng:…', async () => {
      h.upstream.route('POST', '/crimes-street/all-crime', jsonOk(crimesBody()));
      const out = data(
        await call({
          area: 'polygon',
          polygon: '52.63,-1.14:52.63,-1.12:52.64,-1.12' as never,
          month: '2026-07',
        }),
      );
      expect(out.area).toEqual({ type: 'polygon', vertex_count: 3 });
    });

    it('accepts a ring of exactly 2,500 vertices', async () => {
      h.upstream.route('POST', '/crimes-street/all-crime', jsonOk([]));
      const ring = Array.from({ length: 2500 }, (_, i) => ({
        lat: 52 + (i % 100) / 1000,
        lng: -1 + Math.floor(i / 100) / 1000,
      }));
      const out = data(await call({ area: 'polygon', polygon: ring, month: '2026-07' }));
      expect(out.area.vertex_count).toBe(2500);
    });
  });

  describe('area location', () => {
    it('reads /crimes-at-location by location_id and month, returning every category when none is given', async () => {
      h.upstream.route('GET', '/crimes-at-location', jsonOk(crimesBody()));
      const out = data(await call({ area: 'location', location_id: '1000001', month: '2026-07' }));
      expect(out.area).toEqual({ type: 'location', location_id: '1000001' });
      expect(out.total).toBe(7);
      expect(out.category).toEqual({ slug: 'all-crime', name: 'All crime' });
      expect(Object.fromEntries(h.upstream.callsTo('/crimes-at-location')[0]?.query ?? [])).toEqual(
        { location_id: '1000001', date: '2026-07' },
      );
      expect(h.upstream.count('/locate-neighbourhood')).toBe(0);
    });

    it('filters a narrowed category locally, because the route takes none', async () => {
      h.upstream.route('GET', '/crimes-at-location', jsonOk(crimesBody()));
      const out = data(
        await call({
          area: 'location',
          location_id: '1000001',
          month: '2026-07',
          category: 'burglary',
        }),
      );
      expect(out.category).toEqual({ slug: 'burglary', name: 'Burglary' });
      expect(out.total).toBe(3);
      expect(out.by_category).toEqual([{ value: 'burglary', count: 3 }]);
      expect(out.crimes.every((crime) => crime.category === 'burglary')).toBe(true);
      expect(h.upstream.callsTo('/crimes-at-location')[0]?.query.has('category')).toBe(false);
    });

    it('fails unknown_location (NotFound) when the id is not held', async () => {
      h.upstream.route('GET', '/crimes-at-location', plainNotFound);
      const error = errorOf(await call({ area: 'location', location_id: '999', month: '2026-07' }));
      expect(error.code).toBe(JsonRpcErrorCode.NotFound);
      expect(error.data.reason).toBe('unknown_location');
      expect(error.message).toBe("data.police.uk holds no map point with location_id '999'.");
      expect(error.data.recovery?.hint).toContain('location_id from the location of an earlier');
    });
  });

  describe('area neighbourhood', () => {
    const NEIGHBOURHOOD = {
      area: 'neighbourhood',
      force: 'leicestershire',
      neighbourhood_id: 'NX01',
      month: '2026-07',
    } as const;

    it('reads the boundary, POSTs it as the polygon, and echoes the force, id and boundary size', async () => {
      h.upstream.route('GET', '/leicestershire/NX01/boundary', jsonOk(boundaryBody()));
      h.upstream.route('POST', '/crimes-street/all-crime', jsonOk(crimesBody()));
      const out = data(await call({ ...NEIGHBOURHOOD }));
      expect(out.area).toEqual({
        type: 'neighbourhood',
        force: 'leicestershire',
        neighbourhood_id: 'NX01',
        vertex_count: 5,
      });
      expect(out.total).toBe(7);
      expect(
        h.upstream.calls
          .filter(
            (c) =>
              c.path !== '/crimes-street-dates' &&
              c.path !== '/forces' &&
              c.path !== '/crime-categories',
          )
          .map((c) => `${c.method} ${c.path}`),
      ).toEqual(['GET /leicestershire/NX01/boundary', 'POST /crimes-street/all-crime']);
      expect(h.upstream.count('/locate-neighbourhood')).toBe(0);
    });

    it('fails unknown_neighbourhood (NotFound) on a boundary 404, before any crime request', async () => {
      h.upstream.route('GET', '/leicestershire/zz99/boundary', plainNotFound);
      const error = errorOf(await call({ ...NEIGHBOURHOOD, neighbourhood_id: 'zz99' }));
      expect(error.code).toBe(JsonRpcErrorCode.NotFound);
      expect(error.data.reason).toBe('unknown_neighbourhood');
      expect(error.message).toBe(
        "Force 'leicestershire' has no neighbourhood 'zz99'; ids are case-sensitive.",
      );
      expect(error.data.recovery?.hint).toContain("topic 'neighbourhoods'");
      expect(h.upstream.count('/crimes-street/all-crime')).toBe(0);
    });

    it('path-encodes an id with a space (a Northern Ireland neighbourhood)', async () => {
      h.upstream.route('GET', '/northern-ireland/Belfast%20City/boundary', jsonOk(boundaryBody()));
      h.upstream.route('POST', '/crimes-street/all-crime', jsonOk([]));
      const out = data(
        await call({
          ...NEIGHBOURHOOD,
          force: 'northern-ireland',
          neighbourhood_id: 'Belfast City',
        }),
      );
      expect(out.area.neighbourhood_id).toBe('Belfast City');
    });

    it('trims the id but keeps its case', async () => {
      h.upstream.route('GET', '/leicestershire/Nx01/boundary', jsonOk(boundaryBody()));
      h.upstream.route('POST', '/crimes-street/all-crime', jsonOk([]));
      const out = data(await call({ ...NEIGHBOURHOOD, neighbourhood_id: '  Nx01  ' }));
      expect(out.area.neighbourhood_id).toBe('Nx01');
    });

    it.each<[string, string, string]>([
      [
        'avon-and-somerset',
        'locations',
        'Avon and Somerset Constabulary sends about 2,000 crimes a month without coordinates',
      ],
      ['greater-manchester', 'crime', 'Greater Manchester Police publishes no crime data'],
      [
        'northern-ireland',
        'crime',
        "Northern Ireland crimes carry the placeholder outcome 'Under investigation'",
      ],
    ])(
      'adds the %s coverage notes (%s), dated, ahead of any other fragment',
      async (force, _aspect, fragment) => {
        h.upstream.route('GET', `/${force}/NX01/boundary`, jsonOk(boundaryBody()));
        h.upstream.route('POST', '/crimes-street/all-crime', jsonOk(crimesBody()));
        h.upstream.route('GET', '/forces', jsonOk([{ id: force, name: force }]));
        const out = data(await call({ ...NEIGHBOURHOOD, force }));
        expect(out.notice).toContain(fragment);
        expect(out.notice).toContain('(data.police.uk known issues, verified 2026-10-01)');
        expect(out.notice).toBe(coverageNotes(force, ['crime', 'locations', 'asb']).join(' '));
      },
    );

    it('keeps notes for a force with no table facts off the notice entirely', async () => {
      h.upstream.route('GET', '/leicestershire/NX01/boundary', jsonOk(boundaryBody()));
      h.upstream.route('POST', '/crimes-street/all-crime', jsonOk(crimesBody()));
      expect(data(await call({ ...NEIGHBOURHOOD })).notice).toBeUndefined();
    });
  });

  describe('area force_unplaced', () => {
    const UNPLACED = { area: 'force_unplaced', force: 'leicestershire', month: '2026-07' } as const;

    it('reads /crimes-no-location with category, force and date; echoes the force; lists no busiest points', async () => {
      h.upstream.route('GET', '/crimes-no-location', jsonOk(unplacedCrimesBody()));
      const result = await call({ ...UNPLACED });
      const out = data(result);
      expect(out.area).toEqual({ type: 'force_unplaced', force: 'leicestershire' });
      expect(out.total).toBe(3);
      expect(out).not.toHaveProperty('top_locations');
      expect(text(result)).not.toContain('Busiest anonymised map points');
      expect(out.crimes.every((crime) => crime.location === undefined)).toBe(true);
      expect(Object.fromEntries(h.upstream.callsTo('/crimes-no-location')[0]?.query ?? [])).toEqual(
        {
          category: 'all-crime',
          force: 'leicestershire',
          date: '2026-07',
        },
      );
      expect(out.crimes.map((crime) => crime.id)).toEqual(['100000070', '100000071', '100000072']);
      expect(out.crimes.find((crime) => crime.id === '100000070')).not.toHaveProperty('outcome');
    });

    it('sends a narrowed category as a parameter, not a path segment', async () => {
      h.upstream.route('GET', '/crimes-no-location', jsonOk(unplacedCrimesBody()));
      await call({ ...UNPLACED, category: 'Drugs' });
      expect(h.upstream.callsTo('/crimes-no-location')[0]?.query.get('category')).toBe('drugs');
    });

    it('accepts btp, without reading the force list for it, and notes the missing ASB data (not locations)', async () => {
      h.upstream.route('GET', '/crimes-no-location', jsonOk(unplacedCrimesBody()));
      const out = data(await call({ ...UNPLACED, force: 'btp' }));
      expect(out.area.force).toBe('btp');
      expect(out.notice).toBe(coverageNotes('btp', ['crime', 'asb']).join(' '));
      expect(out.notice).toContain(
        'British Transport Police supplies no anti-social behaviour data',
      );
      expect(out.notice).not.toContain('outcome data');
    });

    it('omits the locations note on this arm, where unplaced crimes are the result', async () => {
      h.upstream.route('GET', '/crimes-no-location', jsonOk(unplacedCrimesBody()));
      h.upstream.route('GET', '/forces', jsonOk([{ id: 'avon-and-somerset', name: 'Avon' }]));
      const out = data(await call({ ...UNPLACED, force: 'avon-and-somerset' }));
      expect(out.notice).toBeUndefined();
    });

    it('lets the gap note explain an empty list for a force that publishes no crime data, without pointing at crimes it placed', async () => {
      h.upstream.route('GET', '/crimes-no-location', jsonOk([]));
      h.upstream.route(
        'GET',
        '/forces',
        jsonOk([{ id: 'greater-manchester', name: 'Greater Manchester Police' }]),
      );
      const out = data(await call({ ...UNPLACED, force: 'greater-manchester' }));
      expect(out.total).toBe(0);
      expect(out.notice).toBe(coverageNotes('greater-manchester', ['crime', 'asb']).join(' '));
      expect(out.notice).toContain('Greater Manchester Police publishes no crime data');
      expect(out.notice).not.toContain('the crimes it placed');
    });

    it('says the force recorded none when the list is empty', async () => {
      h.upstream.route('GET', '/crimes-no-location', jsonOk([]));
      const out = data(await call({ ...UNPLACED }));
      expect(out.total).toBe(0);
      expect(out.notice).toBe(
        'This force recorded no crimes without a location in 2026-07; the other areas cover the crimes it placed.',
      );
    });

    it('keeps the narrowed-category fragment ahead of the unplaced one when both could apply', async () => {
      h.upstream.route('GET', '/crimes-no-location', jsonOk([]));
      const out = data(await call({ ...UNPLACED, category: 'burglary' }));
      expect(out.notice).toBe('Only Burglary was searched; omit category to search all crime.');
    });

    it('rejects an unknown force', async () => {
      const error = errorOf(await call({ ...UNPLACED, force: 'atlantis' }));
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data.reason).toBe('unknown_force');
      expect(error.message).toBe("No police force 'atlantis'.");
      expect(h.upstream.count('/crimes-no-location')).toBe(0);
    });

    it('does not offer the stop-and-search force arm', async () => {
      const error = errorOf(await callRaw({ area: 'force', force: 'leicestershire' }));
      expect(error.data.reason).toBe('invalid_arguments');
    });
  });

  describe('category', () => {
    it.each<[string, string, string, string]>([
      ['a slug', 'burglary', 'burglary', 'Burglary'],
      ['a mixed-case slug', 'BuRgLaRy', 'burglary', 'Burglary'],
      [
        'a display name',
        'Violence and sexual offences',
        'violent-crime',
        'Violence and sexual offences',
      ],
      [
        'a display name with runs of spaces',
        '  violence   AND  sexual offences ',
        'violent-crime',
        'Violence and sexual offences',
      ],
      ['the explicit all-crime slug', 'all-crime', 'all-crime', 'All crime'],
      ['the all-crime display name', 'ALL CRIME', 'all-crime', 'All crime'],
      ['a slug with underscores', 'vehicle_crime', 'vehicle-crime', 'Vehicle crime'],
      [
        'a slug with spaces',
        'anti social behaviour',
        'anti-social-behaviour',
        'Anti-social behaviour',
      ],
      [
        'a display name with hyphens',
        'violence-and-sexual-offences',
        'violent-crime',
        'Violence and sexual offences',
      ],
    ])('matches %s', async (_name, input, slug, name) => {
      pointRoutes(crimesBody(), slug);
      const out = data(await call({ ...POINT, category: input, month: '2026-07' }));
      expect(out.category).toEqual({ slug, name });
      expect(h.upstream.count(`/crimes-street/${slug}`)).toBe(1);
    });

    it('sends the slug the display name resolved to as the path segment', async () => {
      pointRoutes(crimesBody(), 'theft-from-the-person');
      await call({ ...POINT, category: 'Theft from the person', month: '2026-07' });
      expect(h.upstream.count('/crimes-street/theft-from-the-person')).toBe(1);
    });

    it('fails unknown_category for a name the vocabulary does not hold, before any area request', async () => {
      const error = errorOf(await call({ ...POINT, category: 'arson', month: '2026-07' }));
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data.reason).toBe('unknown_category');
      expect(error.message).toBe("No crime category matches 'arson'.");
      expect(error.data.recovery?.hint).toContain("topic 'categories'");
      expect(h.upstream.count('/crimes-street/arson')).toBe(0);
      expect(h.upstream.count('/crimes-street/all-crime')).toBe(0);
    });

    it('echoes the category as the user typed it in the failure message, trimmed and lower-cased by the schema', async () => {
      const error = errorOf(await call({ ...POINT, category: '  ARSON  ', month: '2026-07' }));
      expect(error.message).toBe("No crime category matches 'arson'.");
    });

    it('reads a category list that the upstream changed (the cached vocabulary decides)', async () => {
      h.upstream.route(
        'GET',
        '/crime-categories',
        jsonOk([
          { url: 'all-crime', name: 'All crime' },
          { url: 'new-thing', name: 'New thing' },
        ]),
      );
      pointRoutes(crimesBody(), 'new-thing');
      const out = data(await call({ ...POINT, category: 'New Thing', month: '2026-07' }));
      expect(out.category).toEqual({ slug: 'new-thing', name: 'New thing' });
    });
  });

  describe('month', () => {
    it('uses a given month and writes no month fragment', async () => {
      pointRoutes();
      const out = data(await call({ ...POINT, month: '2025-01' }));
      expect(out.month).toBe('2025-01');
      expect(out.notice).toBeUndefined();
    });

    it.each(['2023-09', '2026-08'])('accepts the window edge %s', async (month) => {
      pointRoutes();
      expect(data(await call({ ...POINT, month })).month).toBe(month);
    });

    it('fails month_not_published for a month after the latest, re-checking last-updated once', async () => {
      const error = errorOf(await call({ ...POINT, month: '2026-09' }));
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data.reason).toBe('month_not_published');
      expect(error.message).toBe(
        '2026-09 is not published yet; the latest published month is 2026-08.',
      );
      expect(error.data.recovery?.hint).toContain("topic 'availability'");
      expect(h.upstream.count('/crime-last-updated')).toBe(1);
      expect(h.upstream.count('/crimes-street/all-crime')).toBe(0);
    });

    it('searches a month that publication has caught up to since the cached window', async () => {
      h.upstream.route(
        'GET',
        '/crimes-street-dates',
        sequence(jsonOk(streetDatesBody()), jsonOk(streetDatesBody({ to: '2026-09' }))),
      );
      h.upstream.route('GET', '/crime-last-updated', jsonOk(lastUpdatedBody('2026-09-01')));
      pointRoutes();
      const out = data(await call({ ...POINT, month: '2026-09' }));
      expect(out.month).toBe('2026-09');
    });

    it('fails month_out_of_range for a month before the window', async () => {
      const error = errorOf(await call({ ...POINT, month: '2023-08' }));
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data.reason).toBe('month_out_of_range');
      expect(error.message).toBe(
        '2023-08 is before 2023-09, the earliest month data.police.uk still serves.',
      );
      expect(error.data.recovery?.hint).toContain('last 36 months');
    });

    it('reports the month before an unknown category or force (declared order of checks)', async () => {
      expect(
        errorOf(await call({ ...POINT, month: '2026-09', category: 'arson' })).data.reason,
      ).toBe('month_not_published');
      expect(
        errorOf(await call({ area: 'force_unplaced', force: 'atlantis', month: '2023-08' })).data
          .reason,
      ).toBe('month_out_of_range');
    });

    it('reports an unknown category before an unknown force', async () => {
      expect(
        errorOf(await call({ area: 'force_unplaced', force: 'atlantis', category: 'arson' })).data
          .reason,
      ).toBe('unknown_category');
    });

    it('reports invalid_area before any month or reference work', async () => {
      const error = errorOf(await call({ area: 'point', lat: LAT, month: '2026-09' }));
      expect(error.data.reason).toBe('invalid_area');
      expect(h.upstream.calls).toHaveLength(0);
    });
  });

  describe('paging', () => {
    it('slices the sorted records, with next_offset and the range fragment after the month fragment', async () => {
      pointRoutes();
      const result = await call({ ...POINT, limit: 3 });
      const out = data(result);
      expect(out.total).toBe(7);
      expect(out.crimes.map((crime) => crime.id)).toEqual(['100000050', '100000051', '100000030']);
      expect(out.next_offset).toBe(3);
      expect(out.truncated).toBe(true);
      expect(out.shown).toBe(3);
      expect(out.cap).toBe(3);
      expect(out.notice).toBe(`${MONTH_NOTE} Showing 1–3 of 7; call again with offset 3 for more.`);
      expect(text(result)).toContain('**Next offset:** 3');
    });

    it('walks every crime once by following next_offset, reading the upstream once', async () => {
      pointRoutes();
      const seen: string[] = [];
      let offset: number | undefined = 0;
      while (offset !== undefined) {
        const out: Output = data(await call({ ...POINT, limit: 3, offset }));
        seen.push(...out.crimes.map((crime) => crime.id));
        expect(out.total).toBe(7);
        offset = out.next_offset;
      }
      expect(seen).toHaveLength(7);
      expect(new Set(seen).size).toBe(7);
      expect(h.upstream.count('/crimes-street/all-crime')).toBe(1);
    });

    it('returns the last partial page with no next_offset, no truncation and no range fragment', async () => {
      pointRoutes();
      const out = data(await call({ ...POINT, limit: 3, offset: 6, month: '2026-07' }));
      expect(out.crimes).toHaveLength(1);
      expect(out.next_offset).toBeUndefined();
      expect(out.truncated).toBe(false);
      expect(out.shown).toBe(1);
      expect(out.notice).toBeUndefined();
    });

    it.each([7, 8, 500])(
      'says an offset of %i is past the last of 7 crimes, with an empty page',
      async (offset) => {
        pointRoutes();
        const result = await call({ ...POINT, offset, month: '2026-07' });
        const out = data(result);
        expect(out.crimes).toEqual([]);
        expect(out.shown).toBe(0);
        expect(out.truncated).toBe(false);
        expect(out.next_offset).toBeUndefined();
        expect(out.total).toBe(7);
        expect(out.notice).toBe(
          `offset ${offset} is past the last of 7 crimes; omit offset to start from the first.`,
        );
        expect(text(result)).toContain('### Crimes on this page (0)');
      },
    );

    it('applies limit 200 and pages a large area, with breakdowns over the whole matched set', async () => {
      pointRoutes(manyCrimes(1500));
      const out = data(await call({ ...POINT, limit: 200, month: '2026-07' }));
      expect(out.total).toBe(1500);
      expect(out.crimes).toHaveLength(200);
      expect(out.next_offset).toBe(200);
      expect(out.cap).toBe(200);
      expect(out.by_category.reduce((sum, row) => sum + row.count, 0)).toBe(1500);
      expect(out.top_locations).toHaveLength(10);
      expect(out.top_locations?.every((spot) => spot.count === 60)).toBe(true);
      expect(out.notice).toBe('Showing 1–200 of 1500; call again with offset 200 for more.');
    });

    it('uses a default page of 25', async () => {
      pointRoutes(manyCrimes(120));
      const out = data(await call({ ...POINT, month: '2026-07' }));
      expect(out.crimes).toHaveLength(25);
      expect(out.cap).toBe(25);
      expect(out.next_offset).toBe(25);
    });

    it.each<[string, Record<string, unknown>]>([
      ['limit 0', { limit: 0 }],
      ['limit 201', { limit: 201 }],
      ['a fractional limit', { limit: 1.5 }],
      ['a string limit', { limit: '5' }],
      ['a negative offset', { offset: -1 }],
      ['a fractional offset', { offset: 0.5 }],
    ])('rejects %s as invalid_arguments, before any request', async (_name, extra) => {
      const error = errorOf(await callRaw({ ...POINT, ...extra }));
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(error.data.reason).toBe('invalid_arguments');
      expect(h.upstream.calls).toHaveLength(0);
    });

    it('caps top_locations at 10 map points, most crimes first, then by id', async () => {
      const body = Array.from({ length: 12 }, (_, i) =>
        crimeRecord({
          id: 300_000 + i,
          location: wireLocation(5_000_000 + i, `On or near Street ${i}`),
        }),
      );
      body.push(
        crimeRecord({ id: 300_100, location: wireLocation(5_000_011, 'On or near Street 11') }),
      );
      pointRoutes(body);
      const out = data(await call({ ...POINT, month: '2026-07' }));
      expect(out.top_locations).toHaveLength(10);
      expect(out.top_locations?.[0]).toMatchObject({ location_id: '5000011', count: 2 });
      expect(out.top_locations?.[1]?.location_id).toBe('5000000');
      expect(out.top_locations?.at(-1)?.location_id).toBe('5000008');
    });

    it('orders map points of equal count by id length first', async () => {
      pointRoutes([
        crimeRecord({ id: 1, location: wireLocation(1_000_000) }),
        crimeRecord({ id: 2, location: wireLocation(999) }),
      ]);
      const out = data(await call({ ...POINT, month: '2026-07' }));
      expect(out.top_locations?.map((spot) => spot.location_id)).toEqual(['999', '1000000']);
    });

    it('lists a map point with no usable coordinates without a map_point', async () => {
      pointRoutes([
        crimeRecord({
          id: 1,
          location: wireLocation(1_000_001, 'On or near Zero', '0.000000', '0.000000'),
        }),
      ]);
      const result = await call({ ...POINT, month: '2026-07' });
      const out = data(result);
      expect(out.top_locations).toEqual([
        { location_id: '1000001', street_name: 'On or near Zero', count: 1 },
      ]);
      expect(text(result)).toContain('| 1000001 | On or near Zero | 1 | — |');
    });

    it('counts a record that carries no location in the total but not in top_locations', async () => {
      pointRoutes([crimeRecord({ id: 1 }), crimeRecord({ id: 2, location: null })]);
      const out = data(await call({ ...POINT, month: '2026-07' }));
      expect(out.total).toBe(2);
      expect(out.top_locations).toHaveLength(1);
      expect(out.top_locations?.[0]?.count).toBe(1);
    });
  });

  describe('zero-hit notices', () => {
    it('outside coverage: a point whose locate answered 404', async () => {
      h.upstream.route('GET', '/crimes-street/all-crime', jsonOk([]));
      h.upstream.route('GET', '/locate-neighbourhood', plainNotFound);
      const out = data(await call({ ...POINT }));
      expect(out.total).toBe(0);
      expect(out.area).toEqual({ type: 'point', lat: LAT, lng: LNG });
      expect(out.notice).toBe(
        `${MONTH_NOTE} This point is outside data.police.uk coverage (England, Wales and Northern Ireland; Scotland only through British Transport Police); check that lat and lng are not swapped.`,
      );
    });

    it('does not claim outside coverage when the point has hits', async () => {
      h.upstream.route('GET', '/crimes-street/all-crime', jsonOk(crimesBody()));
      h.upstream.route('GET', '/locate-neighbourhood', plainNotFound);
      const out = data(await call({ ...POINT, month: '2026-07' }));
      expect(out.total).toBe(7);
      expect(out.notice).toBeUndefined();
    });

    it('generic: a located point with nothing recorded', async () => {
      pointRoutes([]);
      const out = data(await call({ ...POINT }));
      expect(out.notice).toBe(`${MONTH_NOTE} ${ZERO_GENERIC}`);
    });

    it('generic when the locate failed (no located force, no outside-coverage claim)', async () => {
      h.upstream.route('GET', '/crimes-street/all-crime', jsonOk([]));
      h.upstream.route('GET', '/locate-neighbourhood', status(500));
      const out = data(await call({ ...POINT, month: '2026-07' }));
      expect(out.area).toEqual({ type: 'point', lat: LAT, lng: LNG });
      expect(out.notice).toBe(ZERO_GENERIC.replace('2026-08', '2026-07'));
    });

    it('polygon outside the coverage box', async () => {
      h.upstream.route('POST', '/crimes-street/all-crime', jsonOk([]));
      const out = data(
        await call({
          area: 'polygon',
          polygon: [
            { lat: 48.85, lng: 2.35 },
            { lat: 48.86, lng: 2.36 },
            { lat: 48.84, lng: 2.34 },
          ],
          month: '2026-07',
        }),
      );
      expect(out.notice).toBe(
        'This polygon lies outside data.police.uk coverage; each vertex is {lat, lng}, so check the two were not swapped.',
      );
    });

    it('polygon with swapped coordinates reads as outside coverage', async () => {
      h.upstream.route('POST', '/crimes-street/all-crime', jsonOk([]));
      const out = data(
        await call({
          area: 'polygon',
          polygon: RING.map(({ lat, lng }) => ({ lat: lng, lng: lat })),
          month: '2026-07',
        }),
      );
      expect(out.notice).toContain('This polygon lies outside data.police.uk coverage');
    });

    it('polygon inside the box is generic', async () => {
      h.upstream.route('POST', '/crimes-street/all-crime', jsonOk([]));
      const out = data(await call({ area: 'polygon', polygon: RING, month: '2026-07' }));
      expect(out.notice).toBe(ZERO_GENERIC.replace('2026-08', '2026-07'));
    });

    it('narrowed category names the category as published and suggests all crime', async () => {
      pointRoutes([], 'burglary');
      const out = data(await call({ ...POINT, category: 'burglary', month: '2026-07' }));
      expect(out.notice).toBe('Only Burglary was searched; omit category to search all crime.');
    });

    it('narrowed category keeps outside coverage first when the point is outside', async () => {
      h.upstream.route('GET', '/crimes-street/burglary', jsonOk([]));
      h.upstream.route('GET', '/locate-neighbourhood', plainNotFound);
      const out = data(await call({ ...POINT, category: 'burglary', month: '2026-07' }));
      expect(out.notice).toContain('outside data.police.uk coverage');
      expect(out.notice).not.toContain('Only Burglary');
    });

    it('keeps CR/LF and markdown in an upstream category name out of the notice', async () => {
      h.upstream.route(
        'GET',
        '/crime-categories',
        jsonOk([
          { url: 'all-crime', name: 'All crime' },
          { url: 'odd', name: 'Odd <b>name\r\nline [x](y)' },
        ]),
      );
      pointRoutes([], 'odd');
      const out = data(await call({ ...POINT, category: 'odd', month: '2026-07' }));
      expect(out.notice).toBe(
        'Only Odd \\<b\\>name line \\[x\\](y) was searched; omit category to search all crime.',
      );
      expect(out.category.name).toBe('Odd <b>name\r\nline [x](y)');
    });

    it('places known-gap notes between the month fragment and the zero-hit fragment', async () => {
      h.upstream.route('GET', '/crimes-street/all-crime', jsonOk([]));
      h.upstream.route(
        'GET',
        '/locate-neighbourhood',
        jsonOk(locateBody({ force: 'greater-manchester' })),
      );
      const out = data(await call({ ...POINT }));
      expect(out.area.located_force).toBe('greater-manchester');
      expect(out.notice).toBe(
        [
          MONTH_NOTE,
          ...coverageNotes('greater-manchester', ['crime', 'locations', 'asb']),
          ZERO_GENERIC,
        ].join(' '),
      );
    });

    it('for a located BTP force notes the ASB gap (point arms read crime, locations and asb)', async () => {
      pointRoutes();
      h.upstream.route('GET', '/locate-neighbourhood', jsonOk(locateBody({ force: 'btp' })));
      const out = data(await call({ ...POINT, month: '2026-07' }));
      expect(out.notice).toBe(coverageNotes('btp', ['crime', 'locations', 'asb']).join(' '));
    });
  });

  describe('enrichment: the zero-result page and the under-cap page', () => {
    it('zero-result page: attribution, data_note, truncated false, shown 0, cap and the notice', async () => {
      pointRoutes([]);
      const result = await call({ ...POINT, limit: 20 });
      const out = data(result);
      expect(out.attribution).toBe(ATTRIBUTION);
      expect(out.data_note).toMatch(
        /^Locations are anonymised map points that each cover at least eight addresses/,
      );
      expect(out.truncated).toBe(false);
      expect(out.shown).toBe(0);
      expect(out.cap).toBe(20);
      expect(out.notice).toBe(`${MONTH_NOTE} ${ZERO_GENERIC}`);
      expect(out.total).toBe(0);
      expect(out.by_category).toEqual([]);
      expect(out.by_outcome).toEqual([]);
      expect(out.top_locations).toEqual([]);
      expect(out.crimes).toEqual([]);
      const rendered = text(result);
      expect(rendered).toContain('**Attribution:**');
      expect(rendered).toContain('**Data note:**');
      expect(rendered).toContain('**More rows:**');
      expect(rendered).toContain('**Rows shown:**');
      expect(rendered).toContain('**Page limit:**');
    });

    it('under-cap page: shown is the page length, below the cap, with truncated false', async () => {
      pointRoutes();
      const result = await call({ ...POINT, limit: 50, month: '2026-07' });
      const out = data(result);
      expect(out.attribution).toBe(ATTRIBUTION);
      expect(out.data_note).toContain('Area searches exclude crimes the force could not place');
      expect(out.shown).toBe(7);
      expect(out.cap).toBe(50);
      expect(out.shown).toBeLessThan(out.cap);
      expect(out.truncated).toBe(false);
      expect(out.notice).toBeUndefined();
      expect(text(result)).toContain('**Rows shown:** 7');
      expect(text(result)).toContain('**Page limit:** 50');
    });

    it('zero-result page on every other arm still carries the required fields', async () => {
      h.upstream.route('POST', '/crimes-street/all-crime', jsonOk([]));
      h.upstream.route('GET', '/crimes-at-location', jsonOk([]));
      h.upstream.route('GET', '/crimes-no-location', jsonOk([]));
      h.upstream.route('GET', '/leicestershire/NX01/boundary', jsonOk(boundaryBody()));
      const inputs: Input[] = [
        { area: 'polygon', polygon: RING, month: '2026-07' },
        { area: 'location', location_id: '1000001', month: '2026-07' },
        { area: 'force_unplaced', force: 'leicestershire', month: '2026-07' },
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
        expect(out.cap, input.area).toBe(25);
        expect(out.notice, input.area).toBeTruthy();
      }
    });

    it('under-cap page on a narrowed category and a short page', async () => {
      h.upstream.route('GET', '/crimes-at-location', jsonOk(crimesBody()));
      const out = data(
        await call({
          area: 'location',
          location_id: '1',
          category: 'vehicle-crime',
          month: '2026-07',
          limit: 5,
        }),
      );
      expect(out.shown).toBe(1);
      expect(out.cap).toBe(5);
      expect(out.truncated).toBe(false);
    });
  });

  describe('enrichment write order (direct handler)', () => {
    const run = async (raw: Input) => {
      const ctx = createMockContext({ errors: searchCrimesTool.errors });
      const input = searchCrimesTool.input.parse(raw);
      const output = await settle(Promise.resolve(searchCrimesTool.handler(input, ctx))).catch(
        (e: unknown) => e,
      );
      return { ctx, output };
    };

    it('writes the five required fields first, then notice last, overwriting truncated and shown in place', async () => {
      pointRoutes();
      const { ctx, output } = await run({ ...POINT, limit: 3 });
      expect(output).toMatchObject({ total: 7, next_offset: 3 });
      const enrichment = getEnrichment(ctx);
      expect(Object.keys(enrichment)).toEqual([
        'attribution',
        'data_note',
        'truncated',
        'shown',
        'cap',
        'notice',
      ]);
      expect(enrichment).toMatchObject({
        truncated: true,
        shown: 3,
        cap: 3,
        attribution: ATTRIBUTION,
      });
    });

    it('writes no notice when there is nothing to say', async () => {
      pointRoutes();
      const { ctx } = await run({ ...POINT, month: '2026-07' });
      expect(Object.keys(getEnrichment(ctx))).toEqual([
        'attribution',
        'data_note',
        'truncated',
        'shown',
        'cap',
      ]);
      expect(getEnrichment(ctx)).toMatchObject({ truncated: false, shown: 7 });
    });

    it('has the five required fields in place before the first thing that can fail', async () => {
      const { ctx, output } = await run({ area: 'point', lat: LAT });
      expect(output).toMatchObject({ data: { reason: 'invalid_area' } });
      expect(getEnrichment(ctx)).toEqual({
        attribution: ATTRIBUTION,
        data_note: expect.any(String),
        truncated: false,
        shown: 0,
        cap: 25,
      });
    });

    it('leaves truncated false and shown 0 when a later step fails', async () => {
      const { ctx, output } = await run({ ...POINT, month: '2026-09' });
      expect(output).toMatchObject({ data: { reason: 'month_not_published' } });
      expect(getEnrichment(ctx)).toMatchObject({ truncated: false, shown: 0, cap: 25 });
      expect(getEnrichment(ctx)).not.toHaveProperty('notice');
    });

    it('logs a quiet warning, not an error, when only the locate fails', async () => {
      h.upstream.route('GET', '/crimes-street/all-crime', jsonOk(crimesBody()));
      h.upstream.route('GET', '/locate-neighbourhood', status(500));
      const { ctx, output } = await run({ ...POINT, month: '2026-07' });
      expect(output).toMatchObject({ total: 7 });
      const log = ctx.log as MockContextLogger;
      expect(log.calls.filter((c) => c.level === 'warning')).toHaveLength(1);
      expect(log.calls.some((c) => c.level === 'error')).toBe(false);
    });
  });

  describe('invalid_area', () => {
    it.each<[string, Record<string, unknown>, string]>([
      [
        'point without lng',
        { area: 'point', lat: LAT },
        "area 'point' needs lat and lng; lng is missing.",
      ],
      [
        'point with nothing',
        { area: 'point' },
        "area 'point' needs lat and lng; lat and lng are missing.",
      ],
      [
        'polygon with nothing',
        { area: 'polygon' },
        "area 'polygon' needs polygon; polygon is missing.",
      ],
      [
        'location with nothing',
        { area: 'location' },
        "area 'location' needs location_id; location_id is missing.",
      ],
      [
        'neighbourhood without an id',
        { area: 'neighbourhood', force: 'leicestershire' },
        "area 'neighbourhood' needs force and neighbourhood_id; neighbourhood_id is missing.",
      ],
      [
        'neighbourhood without a force',
        { area: 'neighbourhood', neighbourhood_id: 'NX01' },
        "area 'neighbourhood' needs force and neighbourhood_id; force is missing.",
      ],
      [
        'force_unplaced without a force',
        { area: 'force_unplaced' },
        "area 'force_unplaced' needs force; force is missing.",
      ],
      [
        'point with a force',
        { area: 'point', lat: LAT, lng: LNG, force: 'leicestershire' },
        "area 'point' does not use force; remove it or choose the area that takes it.",
      ],
      [
        'polygon with coordinates',
        { area: 'polygon', polygon: RING, lat: LAT, lng: LNG },
        "area 'polygon' does not use lat and lng; remove them or choose the area that takes them.",
      ],
      [
        'location with a neighbourhood id',
        { area: 'location', location_id: '1', neighbourhood_id: 'NX01' },
        "area 'location' does not use neighbourhood_id; remove it or choose the area that takes it.",
      ],
      [
        'force_unplaced with a neighbourhood id',
        { area: 'force_unplaced', force: 'leicestershire', neighbourhood_id: 'NX01' },
        "area 'force_unplaced' does not use neighbourhood_id; remove it or choose the area that takes it.",
      ],
    ])('rejects %s', async (_name, input, message) => {
      const error = errorOf(await callRaw(input));
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data.reason).toBe('invalid_area');
      expect(error.message).toBe(message);
      expect(error.data.recovery?.hint).toContain("Send lat and lng for area 'point'");
      expect(h.upstream.calls).toHaveLength(0);
    });

    it('rejects a missing and an unknown area as invalid_arguments', async () => {
      expect(errorOf(await callRaw({ lat: LAT, lng: LNG })).data.reason).toBe('invalid_arguments');
      expect(errorOf(await callRaw({ area: 'country' })).data.reason).toBe('invalid_arguments');
    });
  });

  describe('blank values read as unset (form clients)', () => {
    it('accepts empty strings on every optional input the point arm does not use', async () => {
      pointRoutes();
      const out = data(
        await callRaw({
          ...POINT,
          polygon: '',
          location_id: '',
          force: '  ',
          neighbourhood_id: '\t',
          month: '',
          category: '',
        }),
      );
      expect(out.total).toBe(7);
      expect(out.category.slug).toBe('all-crime');
      expect(out.notice).toBe(MONTH_NOTE);
    });

    it('reads null the same way', async () => {
      pointRoutes();
      const out = data(
        await callRaw({
          ...POINT,
          polygon: null,
          location_id: null,
          force: null,
          neighbourhood_id: null,
          month: null,
          category: null,
        }),
      );
      expect(out.total).toBe(7);
    });

    it('reads an empty list for polygon as unset', async () => {
      pointRoutes();
      expect(data(await callRaw({ ...POINT, polygon: [] })).total).toBe(7);
    });

    it('reads blank coordinates as unset on an arm that does not use them', async () => {
      h.upstream.route('GET', '/crimes-at-location', jsonOk(crimesBody()));
      const out = data(
        await callRaw({
          area: 'location',
          location_id: '1000001',
          lat: '',
          lng: ' ',
          month: '2026-07',
        }),
      );
      expect(out.area).toEqual({ type: 'location', location_id: '1000001' });
    });

    it('treats a blank required field as missing (invalid_area), not as a value', async () => {
      const error = errorOf(await callRaw({ area: 'location', location_id: ' ' }));
      expect(error.data.reason).toBe('invalid_area');
      expect(error.message).toBe("area 'location' needs location_id; location_id is missing.");
      const error2 = errorOf(await callRaw({ area: 'point', lat: '', lng: '' }));
      expect(error2.data.reason).toBe('invalid_area');
    });
  });

  describe('input validation', () => {
    it.each<[string, unknown]>([
      ['a latitude of 91', { ...POINT, lat: 91 }],
      ['a longitude of -181', { ...POINT, lng: -181 }],
      ['a numeric string latitude', { ...POINT, lat: '52.63' }],
      ['a month 2026-13', { ...POINT, month: '2026-13' }],
      ['a month 2026-8', { ...POINT, month: '2026-8' }],
      ['a month with a day', { ...POINT, month: '2026-07-15' }],
      ['a force with a path in it', { area: 'force_unplaced', force: '../forces' }],
      ['a force with digits', { area: 'force_unplaced', force: 'force1' }],
      [
        'a neighbourhood id with a slash',
        { area: 'neighbourhood', force: 'leicestershire', neighbourhood_id: 'a/b' },
      ],
      [
        'a neighbourhood id of ..',
        { area: 'neighbourhood', force: 'leicestershire', neighbourhood_id: '..' },
      ],
      [
        'a neighbourhood id of .',
        { area: 'neighbourhood', force: 'leicestershire', neighbourhood_id: '.' },
      ],
      [
        'a neighbourhood id with ?',
        { area: 'neighbourhood', force: 'leicestershire', neighbourhood_id: 'a?b' },
      ],
      [
        'a neighbourhood id with #',
        { area: 'neighbourhood', force: 'leicestershire', neighbourhood_id: 'a#b' },
      ],
      [
        'a neighbourhood id with a control character',
        { area: 'neighbourhood', force: 'leicestershire', neighbourhood_id: 'a\u0007b' },
      ],
      [
        'a neighbourhood id over 100 characters',
        { area: 'neighbourhood', force: 'leicestershire', neighbourhood_id: 'a'.repeat(101) },
      ],
      ['a location_id with letters', { area: 'location', location_id: '12ab' }],
      ['a location_id of 13 digits', { area: 'location', location_id: '1'.repeat(13) }],
      ['a polygon of two vertices', { area: 'polygon', polygon: RING.slice(0, 2) }],
      [
        'a polygon of [lng, lat] pairs',
        {
          area: 'polygon',
          polygon: [
            [-1.14, 52.63],
            [-1.12, 52.63],
            [-1.12, 52.64],
          ],
        },
      ],
      [
        'a polygon with a vertex out of range',
        { area: 'polygon', polygon: [...RING.slice(0, 2), { lat: 95, lng: 0 }] },
      ],
      [
        'a polygon string with a bad vertex',
        { area: 'polygon', polygon: '52.63,-1.14:oops:52.64,-1.12' },
      ],
      [
        'a polygon of 2,501 vertices',
        { area: 'polygon', polygon: Array.from({ length: 2501 }, () => ({ lat: 52, lng: -1 })) },
      ],
      ['a category of 101 characters', { ...POINT, category: 'a'.repeat(101) }],
      ['a non-object input', 'point'],
    ])('rejects %s as invalid_arguments, before any request', async (_name, input) => {
      const error = errorOf(await callRaw(input));
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(error.data.reason).toBe('invalid_arguments');
      expect(h.upstream.calls).toHaveLength(0);
    });

    it.each<[string, unknown, string]>([
      [
        'month',
        { ...POINT, month: '2026-7' },
        'month: Expected a month as YYYY-MM, such as 2026-07.',
      ],
      [
        'force',
        { area: 'force_unplaced', force: 'avon & somerset' },
        "force: Expected a force id: lower-case words joined by hyphens, such as 'leicestershire' or 'devon-and-cornwall'.",
      ],
      [
        'location_id',
        { area: 'location', location_id: '12ab' },
        'location_id: Expected 1–12 digits: the location.location_id of an earlier result.',
      ],
      [
        'neighbourhood_id',
        { area: 'neighbourhood', force: 'leicestershire', neighbourhood_id: 'a/b' },
        "neighbourhood_id: Expected a neighbourhood id such as 'NX01' from ukcrime_list_reference topic 'neighbourhoods'; it cannot contain /, \\, ? or #.",
      ],
    ])('names the expected shape of %s rather than its pattern', async (_name, input, line) => {
      const result = await callRaw(input);
      expect(errorOf(result).message).toContain(line);
      expect(text(result)).not.toContain('must match pattern');
    });

    it('normalizes a spoken force name', async () => {
      h.upstream.route('GET', '/crimes-no-location', jsonOk([]));
      h.upstream.route(
        'GET',
        '/forces',
        jsonOk([{ id: 'greater-manchester', name: 'Greater Manchester Police' }]),
      );
      const out = data(
        await call({ area: 'force_unplaced', force: ' Greater_Manchester ', month: '2026-07' }),
      );
      expect(out.area.force).toBe('greater-manchester');
    });

    it('cuts a 1000-vertex polygon string at its first bad vertex, so the error carries one issue, not one per vertex', async () => {
      const ring = Array.from({ length: 1000 }, (_, i) => `${95 + i / 1000},-1`).join(':');
      const error = errorOf(await callRaw({ area: 'polygon', polygon: ring }));
      expect(error.data.reason).toBe('invalid_arguments');
      expect((error.data.issues as unknown[]).length).toBeLessThanOrEqual(3);
    });

    it('answers a polygon of coordinate pairs by saying vertices are { lat, lng } objects, with no vertex count', async () => {
      const result = await callRaw({
        area: 'polygon',
        polygon: [
          [52.634, -1.136],
          [52.64, -1.13],
          [52.63, -1.12],
        ],
      });
      const error = errorOf(result);
      expect(error.data.reason).toBe('invalid_arguments');
      expect(error.message).toContain('polygon.0: Each polygon vertex is a { lat, lng } object');
      expect(text(result)).not.toContain('>=3');
      expect(text(result)).not.toContain('Too small');
      expect(h.upstream.calls).toHaveLength(0);
    });

    it('treats a number where the category text goes as the text it prints as (unknown_category)', async () => {
      const error = errorOf(await callRaw({ ...POINT, category: 5 }));
      expect(error.data.reason).toBe('unknown_category');
      expect(error.message).toBe("No crime category matches '5'.");
    });
  });

  describe('upstream failures on the area query', () => {
    it.each<[string, () => void, number, string | undefined]>([
      [
        'a persistent 500',
        () => h.upstream.route('GET', '/crimes-street/all-crime', status(500)),
        JsonRpcErrorCode.ServiceUnavailable,
        undefined,
      ],
      [
        'a 502',
        () => h.upstream.route('GET', '/crimes-street/all-crime', status(502)),
        JsonRpcErrorCode.ServiceUnavailable,
        undefined,
      ],
      [
        'a 429 with a long Retry-After',
        () => h.upstream.route('GET', '/crimes-street/all-crime', rateLimited('60')),
        JsonRpcErrorCode.RateLimited,
        undefined,
      ],
      [
        'an HTML 200 body',
        () => h.upstream.route('GET', '/crimes-street/all-crime', htmlOk),
        JsonRpcErrorCode.ServiceUnavailable,
        'unreadable_response',
      ],
      [
        'an object where an array was expected',
        () => h.upstream.route('GET', '/crimes-street/all-crime', jsonOk({ crimes: [] })),
        JsonRpcErrorCode.ServiceUnavailable,
        'unexpected_response',
      ],
      [
        'a crime missing its category',
        () =>
          h.upstream.route(
            'GET',
            '/crimes-street/all-crime',
            jsonOk([{ id: 1, month: '2026-08' }]),
          ),
        JsonRpcErrorCode.ServiceUnavailable,
        'unexpected_response',
      ],
      [
        'a crime with a street-less location',
        () =>
          h.upstream.route(
            'GET',
            '/crimes-street/all-crime',
            jsonOk([crimeRecord({ location: { latitude: '1', longitude: '2' } })]),
          ),
        JsonRpcErrorCode.ServiceUnavailable,
        'unexpected_response',
      ],
      [
        'an upstream that never answers',
        () => h.upstream.route('GET', '/crimes-street/all-crime', hang),
        JsonRpcErrorCode.Timeout,
        undefined,
      ],
      [
        'a 400 the server built',
        () => h.upstream.route('GET', '/crimes-street/all-crime', htmlBadRequest),
        JsonRpcErrorCode.InvalidParams,
        undefined,
      ],
      [
        'a 404 on the street route (not a miss there)',
        () => h.upstream.route('GET', '/crimes-street/all-crime', plainNotFound),
        JsonRpcErrorCode.NotFound,
        undefined,
      ],
    ])('surfaces %s as a classified error', async (_name, arrange, code, reason) => {
      h.upstream.route('GET', '/locate-neighbourhood', jsonOk(locateBody()));
      arrange();
      const error = errorOf(await call({ ...POINT, month: '2026-07' }));
      expect(error.code).toBe(code);
      if (reason) expect(error.data.reason).toBe(reason);
    });

    it('names the route, never the upstream body, in an unexpected_response', async () => {
      h.upstream.route('GET', '/locate-neighbourhood', jsonOk(locateBody()));
      h.upstream.route('GET', '/crimes-street/all-crime', jsonOk({ secret: 'upstream-only-text' }));
      const result = await call({ ...POINT, month: '2026-07' });
      expect(errorOf(result).message).toContain('/crimes-street/all-crime');
      expect(JSON.stringify(result)).not.toContain('upstream-only-text');
    });

    it('fails a month read that fails (reference data) without touching the area route', async () => {
      h.upstream.route('GET', '/crimes-street-dates', status(500));
      expect(errorOf(await call({ ...POINT })).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(h.upstream.count('/crimes-street/all-crime')).toBe(0);
    });

    it('fails a category vocabulary read that fails', async () => {
      h.upstream.route('GET', '/crime-categories', status(500));
      expect(errorOf(await call({ ...POINT })).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    });

    it('fails a force list read that fails for a force arm', async () => {
      h.upstream.route('GET', '/forces', status(500));
      expect(errorOf(await call({ area: 'force_unplaced', force: 'leicestershire' })).code).toBe(
        JsonRpcErrorCode.ServiceUnavailable,
      );
    });

    it('does not retry a body it could not use as a crime list', async () => {
      h.upstream.route('GET', '/locate-neighbourhood', jsonOk(locateBody()));
      h.upstream.route('GET', '/crimes-street/all-crime', jsonOk('nope'));
      await call({ ...POINT, month: '2026-07' });
      expect(h.upstream.count('/crimes-street/all-crime')).toBe(1);
    });
  });

  describe('503 on the area query (area_too_large vs upstream_unavailable)', () => {
    it('point: area_too_large with the point wording as the recovery hint', async () => {
      h.upstream.route('GET', '/crimes-street/all-crime', overloaded);
      h.upstream.route('GET', '/locate-neighbourhood', jsonOk(locateBody()));
      const error = errorOf(await call({ ...POINT, month: '2026-07' }));
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data.reason).toBe('area_too_large');
      expect(error.data.recovery?.hint).toBe(
        "A 1-mile circle here holds too many crimes for data.police.uk to answer (it can refuse an area holding more than about 10,000); search area 'polygon' with a smaller ring around the point.",
      );
      expect(h.upstream.count('/crimes-street/all-crime')).toBe(1);
      expect(h.upstream.count('/crime-last-updated')).toBe(1);
    });

    it('states the 10,000-crime refusal as one data.police.uk can make, not one it always makes', () => {
      expect(searchCrimesTool.description).toContain(
        'data.police.uk can refuse an area holding more than about 10,000 crimes',
      );
      expect(searchCrimesTool.description).not.toContain('is refused upstream');
      const entry = searchCrimesTool.errors?.find((e) => e.reason === 'area_too_large');
      expect(entry?.when).toBe(
        'the area is too large to answer: data.police.uk can refuse one holding more than about 10,000 crimes',
      );
      expect(entry?.recovery).not.toContain('cap');
    });

    it.each<[string, Input, string, () => void]>([
      [
        'polygon',
        { area: 'polygon', polygon: RING, month: '2026-07' },
        '/crimes-street/all-crime',
        () => h.upstream.route('POST', '/crimes-street/all-crime', overloaded),
      ],
      [
        'neighbourhood',
        {
          area: 'neighbourhood',
          force: 'leicestershire',
          neighbourhood_id: 'NX01',
          month: '2026-07',
        },
        '/crimes-street/all-crime',
        () => {
          h.upstream.route('GET', '/leicestershire/NX01/boundary', jsonOk(boundaryBody()));
          h.upstream.route('POST', '/crimes-street/all-crime', overloaded);
        },
      ],
    ])('%s: area_too_large with the declared recovery', async (_name, input, _path, arrange) => {
      arrange();
      const error = errorOf(await call(input));
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data.reason).toBe('area_too_large');
      expect(error.data.recovery?.hint).toContain('split the polygon into smaller polygons');
      expect(error.data.recovery?.hint).toContain(
        'The limit of about 10,000 crimes counts every category',
      );
    });

    it('does not read a narrower category as the way out (the limit counts every category)', async () => {
      h.upstream.route('GET', '/crimes-street/burglary', overloaded);
      h.upstream.route('GET', '/locate-neighbourhood', jsonOk(locateBody()));
      const error = errorOf(await call({ ...POINT, category: 'burglary', month: '2026-07' }));
      expect(error.data.reason).toBe('area_too_large');
    });

    it.each<[string, () => void]>([
      ['a failing probe', () => h.upstream.route('GET', '/crime-last-updated', status(500))],
      ['a probe 503', () => h.upstream.route('GET', '/crime-last-updated', overloaded)],
      ['a hung probe', () => h.upstream.route('GET', '/crime-last-updated', hang)],
    ])('is upstream_unavailable, retryable, with %s', async (_name, arrange) => {
      h.upstream.route('GET', '/locate-neighbourhood', jsonOk(locateBody()));
      h.upstream.route('GET', '/crimes-street/all-crime', overloaded);
      arrange();
      const error = errorOf(await call({ ...POINT, month: '2026-07' }));
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.data.reason).toBe('upstream_unavailable');
      expect(error.data.retryable).toBe(true);
      expect(error.data.recovery?.hint).toContain('call this tool again in a few minutes');
    });
  });

  describe('an area answer over the 32 MiB body ceiling', () => {
    const oversized = () => streamOfBytes(64 * 1024 * 1024).respond;

    it('polygon: area_too_large with the declared split-the-area recovery, not retried', async () => {
      h.upstream.route('POST', '/crimes-street/all-crime', oversized());
      const result = await call({ area: 'polygon', polygon: RING, month: '2026-07' });
      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.message).toContain('too large to answer');
      expect(error.data.reason).toBe('area_too_large');
      expect(error.data.recovery?.hint).toContain('split the polygon into smaller polygons');
      expect(text(result)).toContain('split the polygon into smaller polygons');
      expect(h.upstream.count('/crimes-street/all-crime')).toBe(1);
      expect(h.upstream.count('/crime-last-updated')).toBe(0);
    });

    it('point: area_too_large with the point wording as the recovery hint', async () => {
      h.upstream.route('GET', '/crimes-street/all-crime', oversized());
      h.upstream.route('GET', '/locate-neighbourhood', jsonOk(locateBody()));
      const error = errorOf(await call({ ...POINT, month: '2026-07' }));
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data.reason).toBe('area_too_large');
      expect(error.data.recovery?.hint).toContain(
        "search area 'polygon' with a smaller ring around the point",
      );
    });
  });

  describe('the locate beside a point search', () => {
    it('degrades to an unlocated echo and still returns the crimes when the locate fails', async () => {
      h.upstream.route('GET', '/crimes-street/all-crime', jsonOk(crimesBody()));
      h.upstream.route('GET', '/locate-neighbourhood', status(500));
      const out = data(await call({ ...POINT, month: '2026-07' }));
      expect(out.total).toBe(7);
      expect(out.area).toEqual({ type: 'point', lat: LAT, lng: LNG });
      expect(out.notice).toBeUndefined();
    });

    it('degrades the same way for a locate body of the wrong shape and for a hung locate', async () => {
      h.upstream.route('GET', '/crimes-street/all-crime', jsonOk(crimesBody()));
      h.upstream.route('GET', '/locate-neighbourhood', jsonOk({ nope: true }));
      expect(data(await call({ ...POINT, month: '2026-07' })).total).toBe(7);
      h.upstream.route('GET', '/locate-neighbourhood', hang);
      expect(data(await call({ ...POINT, lat: 52.7, month: '2026-07' })).total).toBe(7);
    });

    it('reads a numeric neighbourhood id from the locate as a string', async () => {
      h.upstream.route('GET', '/crimes-street/all-crime', jsonOk(crimesBody()));
      h.upstream.route(
        'GET',
        '/locate-neighbourhood',
        jsonOk({ force: 'leicestershire', neighbourhood: 4 }),
      );
      expect(data(await call({ ...POINT, month: '2026-07' })).area.located_neighbourhood).toBe('4');
    });

    it('caches the locate across searches of the same point', async () => {
      pointRoutes();
      await call({ ...POINT, month: '2026-07' });
      await call({ ...POINT, month: '2026-06' });
      expect(h.upstream.count('/locate-neighbourhood')).toBe(1);
    });
  });

  describe('format() matches structuredContent', () => {
    it('renders every crime, breakdown row and busiest map point', async () => {
      pointRoutes();
      const result = await call({ ...POINT });
      const out = data(result);
      const rendered = text(result);
      expect(rendered).toContain('## Street-level crimes — 2026-08');
      expect(rendered).toContain(
        '**Area:** point · lat 52.63 · lng -1.13 · located force leicestershire · located neighbourhood NX01',
      );
      expect(rendered).toContain('**Category:** All crime (all-crime)');
      expect(rendered).toContain('**Crimes matched:** 7');
      for (const row of [...out.by_category, ...out.by_outcome]) {
        expect(rendered).toContain(`| ${row.value} | ${row.count} |`);
      }
      for (const spot of out.top_locations ?? []) {
        expect(rendered).toContain(
          `| ${spot.location_id} | ${spot.street_name} | ${spot.count} | ${spot.map_point?.latitude}, ${spot.map_point?.longitude} |`,
        );
      }
      for (const crime of out.crimes) {
        expect(rendered).toContain(`id ${crime.id}`);
        if (crime.persistent_id) expect(rendered).toContain(`persistent_id ${crime.persistent_id}`);
        if (crime.location) expect(rendered).toContain(`location_id ${crime.location.location_id}`);
        if (crime.outcome)
          expect(rendered).toContain(
            `Latest outcome: ${crime.outcome.name} (${crime.outcome.month})`,
          );
      }
      expect(rendered).toContain('### Crimes on this page (7)');
      expect(rendered).toContain('anonymised map point 52.63, -1.13');
      expect(rendered).toContain('BTP (station) · Railway Station');
      expect(rendered).toContain(`> ${out.notice}`);
    });

    it('quotes crime context line by line', async () => {
      pointRoutes();
      const rendered = text(await call({ ...POINT }));
      expect(rendered).toContain('  - Context:\n    > Line one\n    > Line two');
    });

    it('renders none markers for an empty result', async () => {
      pointRoutes([]);
      const rendered = text(await call({ ...POINT }));
      expect(rendered).toContain('### By category\n\n_None._');
      expect(rendered).toContain('### By latest police outcome\n\n_None._');
      expect(rendered).toContain('### Busiest anonymised map points\n\n_None._');
      expect(rendered).toContain('### Crimes on this page (0)\n\n_None._');
      expect(rendered).not.toContain('Next offset');
    });

    it('renders the next offset', async () => {
      pointRoutes();
      expect(text(await call({ ...POINT, limit: 2 }))).toContain('**Next offset:** 2');
    });

    it('keeps upstream text verbatim in structuredContent and inert in the markdown', async () => {
      const hostile =
        'On or near Evil\r\n# Injected | cell [x](https://evil.test) <b>\u202Etxt\u2028tail\u0085end';
      pointRoutes([
        crimeRecord({
          id: 1,
          category: 'burglary',
          location: wireLocation(7, hostile),
          outcome_status: { category: 'Out\r\ncome | [y](z)', date: '2026-08' },
          context: 'ctx line\r\n# not a heading\u2029after',
          location_subtype: 'Sub\r\ntype',
        }),
      ]);
      const result = await call({ ...POINT, month: '2026-07' });
      const out = data(result);
      expect(out.crimes[0]?.location?.street_name).toBe(hostile);
      expect(out.crimes[0]?.outcome?.name).toBe('Out\r\ncome | [y](z)');
      expect(out.crimes[0]?.context).toBe('ctx line\r\n# not a heading\u2029after');
      const rendered = text(result);
      expect(rendered).not.toMatch(/[\r\u202E\u2028\u2029\u0085]/);
      expect(rendered.split('\n').some((line) => line.startsWith('# Injected'))).toBe(false);
      expect(rendered.split('\n').some((line) => line.startsWith('# not a heading'))).toBe(false);
      expect(rendered).toContain(
        'On or near Evil # Injected \\| cell \\[x\\](https://evil.test) \\<b\\>txt tail end',
      );
      expect(rendered).toContain('| Out come \\| \\[y\\](z) | 1 |');
      expect(rendered).toContain('> # not a heading');
      expect(rendered).toContain('Sub type');
    });

    it('keeps CR/LF in a street name out of the busiest-points table row', async () => {
      pointRoutes([crimeRecord({ id: 1, location: wireLocation(9, 'On or near A\r\nB | C') })]);
      const rendered = text(await call({ ...POINT, month: '2026-07' }));
      const row = rendered.split('\n').find((line) => line.startsWith('| 9 |'));
      expect(row).toBe('| 9 | On or near A B \\| C | 1 | 52.63, -1.13 |');
    });

    it('renders a crime with no location and no outcome as a bare line', async () => {
      h.upstream.route('GET', '/crimes-no-location', jsonOk([sparseCrimeRecord({ id: 5 })]));
      const rendered = text(
        await call({ area: 'force_unplaced', force: 'leicestershire', month: '2026-07' }),
      );
      expect(rendered).toContain('- **anti-social-behaviour** · id 5 · 2026-08');
      expect(rendered).not.toContain('Location:');
      expect(rendered).not.toContain('Latest outcome:');
    });

    it('format() of a minimal output renders without top_locations', () => {
      const blocks = searchCrimesTool.format?.({
        month: '2026-08',
        area: { type: 'force_unplaced', force: 'btp' },
        category: { slug: 'all-crime', name: 'All crime' },
        total: 0,
        by_category: [],
        by_outcome: [],
        crimes: [],
      });
      const rendered =
        blocks?.map((block) => (block.type === 'text' ? block.text : '')).join('') ?? '';
      expect(rendered).toContain('**Crimes matched:** 0');
      expect(rendered).not.toContain('Busiest');
    });
  });

  describe('caching across calls', () => {
    it('reads the reference lists once for repeat calls', async () => {
      pointRoutes();
      await call({ ...POINT, month: '2026-07' });
      await call({ ...POINT, month: '2026-06' });
      expect(h.upstream.count('/crimes-street-dates')).toBe(1);
      expect(h.upstream.count('/crime-categories')).toBe(1);
    });

    it('does not read the force list for arms that name no force', async () => {
      pointRoutes();
      await call({ ...POINT, month: '2026-07' });
      expect(h.upstream.count('/forces')).toBe(0);
    });

    it('serves a repeated search from the area cache', async () => {
      pointRoutes();
      await call({ ...POINT, month: '2026-07' });
      await call({ ...POINT, month: '2026-07', limit: 10 });
      expect(h.upstream.count('/crimes-street/all-crime')).toBe(1);
    });
  });
});
