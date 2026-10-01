/**
 * @fileoverview ukcrime_search_outcomes through `runToolContract` (the
 * production parse of output extended with enrichment): every area arm, the
 * month and category inputs (local category filter, breakdowns after it), the
 * breakdown sort orders, paging and `next_offset`, every zero-hit notice and its
 * fragment order, coverage notes for the outcomes aspect, every declared error
 * reason, the enrichment fields on the zero-result page and the under-cap page
 * and their write order, upstream failure classes, blank form values, and
 * `format()` carrying the same data as `structuredContent` with upstream text
 * kept inert.
 * @module tests/tools/search-outcomes.tool.test
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
import { searchOutcomesTool } from '@/mcp-server/tools/definitions/search-outcomes.tool.js';
import { ATTRIBUTION } from '@/mcp-server/tools/shared-schemas.js';
import { coverageNotes } from '@/services/police-api/known-gaps.js';
import {
  areaOutcomeRecord,
  boundaryBody,
  crimeRecord,
  hang,
  htmlBadRequest,
  htmlOk,
  jsonOk,
  locateBody,
  outcomesBody,
  overloaded,
  plainNotFound,
  rateLimited,
  status,
  wireLocation,
} from '../fixtures/police-api-upstream.js';
import { manyOutcomes, outcomeFor } from '../fixtures/police-api-upstream-w3.js';
import { settle, useToolHarness } from '../fixtures/service-harness.js';

type Input = z.input<typeof searchOutcomesTool.input>;
type Output = z.output<typeof searchOutcomesTool.output> & {
  attribution: string;
  cap: number;
  data_note: string;
  notice?: string;
  shown: number;
  truncated: boolean;
};
type Result = Awaited<ReturnType<typeof runToolContract>>;

const call = (input: Input) => settle(runToolContract(searchOutcomesTool, input));
const callRaw = (input: unknown) => settle(runToolContract(searchOutcomesTool, input as Input));

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
const HOOD = {
  area: 'neighbourhood',
  force: 'leicestershire',
  neighbourhood_id: 'NX01',
} as const;
const MONTH_NOTE = 'No month given; searched 2026-08, the latest published month.';
const ZERO_GENERIC = 'No outcomes recorded here in 2026-08; try another month or a wider area.';
const OUTSIDE_POINT =
  'This point is outside data.police.uk coverage (England, Wales and Northern Ireland; Scotland only through British Transport Police); check that lat and lng are not swapped.';
const POINT_TOO_LARGE =
  "A 1-mile circle here holds more than 10,000 outcomes; search area 'polygon' with a smaller ring around the point.";

describe('ukcrime_search_outcomes', () => {
  const h = useToolHarness();

  /** Routes the point arm: the outcomes body and the locate answer. */
  const pointRoutes = (body: unknown = outcomesBody(), located: unknown = locateBody()) => {
    h.upstream.route('GET', '/outcomes-at-location', jsonOk(body));
    h.upstream.route('GET', '/locate-neighbourhood', jsonOk(located));
  };

  describe('area point', () => {
    it('returns the total, both breakdowns and a page sorted by crime month then crime id, located and with the month defaulted', async () => {
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
      expect(out).not.toHaveProperty('category');
      expect(out.total).toBe(3);
      expect(out.unfiltered_total).toBe(3);
      expect(out.by_outcome).toEqual([
        { code: 'under-investigation', name: 'Under investigation', count: 2 },
        { code: 'unable-to-prosecute', name: 'Unable to prosecute suspect', count: 1 },
      ]);
      expect(out.by_crime_month).toEqual([
        { month: '2026-07', count: 2 },
        { month: '2026-05', count: 1 },
      ]);
      expect(out.outcomes.map((o) => o.crime.id)).toEqual(['100000080', '100000082', '100000081']);
      expect(out.notice).toBe(MONTH_NOTE);
      expect(out).not.toHaveProperty('next_offset');
    });

    it('writes each outcome in wire shape: code, name, outcome month and the crime with its persistent_id and location', async () => {
      pointRoutes();
      const [first] = data(await call({ ...POINT })).outcomes;
      expect(first).toEqual({
        code: 'under-investigation',
        name: 'Under investigation',
        month: '2026-08',
        crime: {
          id: '100000080',
          persistent_id: 'a'.repeat(64),
          category: 'burglary',
          month: '2026-07',
          location: {
            location_id: '1000001',
            street_name: 'On or near Example Street',
            map_point: { latitude: 52.63, longitude: -1.13 },
            type: 'Force',
          },
        },
      });
    });

    it('never carries person_id or the crime latest-outcome field', async () => {
      pointRoutes([areaOutcomeRecord({ person_id: 'x' })]);
      const json = JSON.stringify(data(await call({ ...POINT })));
      expect(json).not.toContain('person_id');
      expect(json).not.toContain('outcome_status');
    });

    it('sends lat, lng at six decimals and the resolved date to /outcomes-at-location by GET, with the locate beside it', async () => {
      pointRoutes();
      await call({ area: 'point', lat: 52.5, lng: -1, month: '2026-06' });
      const [sent] = h.upstream.callsTo('/outcomes-at-location');
      expect(sent?.method).toBe('GET');
      expect(Object.fromEntries(sent?.query ?? [])).toEqual({
        lat: '52.500000',
        lng: '-1.000000',
        date: '2026-06',
      });
      expect(h.upstream.callsTo('/locate-neighbourhood')[0]?.query.get('q')).toBe(
        '52.500000,-1.000000',
      );
    });

    it('reads a crime without a persistent id, location or context as absent, not blank', async () => {
      pointRoutes([
        areaOutcomeRecord({
          crime: crimeRecord({
            location: null,
            persistent_id: '',
            context: '',
            outcome_status: null,
          }),
        }),
      ]);
      const [first] = data(await call({ ...POINT, month: '2026-07' })).outcomes;
      expect(first?.crime).toEqual({ id: '100000001', category: 'burglary', month: '2026-08' });
    });

    it('keeps crime context as published', async () => {
      pointRoutes([areaOutcomeRecord({ crime: crimeRecord({ context: 'Line one\r\nLine two' }) })]);
      const [first] = data(await call({ ...POINT, month: '2026-07' })).outcomes;
      expect(first?.crime.context).toBe('Line one\r\nLine two');
    });
  });

  describe('area polygon', () => {
    it('POSTs the ring as a six-decimal poly form body with the date, and echoes the vertex count', async () => {
      h.upstream.route('POST', '/outcomes-at-location', jsonOk(outcomesBody()));
      const out = data(await call({ area: 'polygon', polygon: RING, month: '2026-07' }));
      expect(out.area).toEqual({ type: 'polygon', vertex_count: 4 });
      expect(out.total).toBe(3);
      const [sent] = h.upstream.callsTo('/outcomes-at-location');
      expect(sent?.method).toBe('POST');
      expect(sent?.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
      const form = new URLSearchParams(sent?.body);
      expect(form.get('date')).toBe('2026-07');
      expect(form.get('poly')).toBe(
        '52.630000,-1.140000:52.630000,-1.120000:52.640000,-1.120000:52.640000,-1.140000',
      );
      expect(h.upstream.count('/locate-neighbourhood')).toBe(0);
    });

    it('accepts the string form and the poly alias', async () => {
      h.upstream.route('POST', '/outcomes-at-location', jsonOk(outcomesBody()));
      const out = data(
        await callRaw({
          area: 'polygon',
          poly: '52.63,-1.14:52.63,-1.12:52.64,-1.12',
          date: '2026-07',
        }),
      );
      expect(out.area).toEqual({ type: 'polygon', vertex_count: 3 });
      expect(out.month).toBe('2026-07');
    });
  });

  describe('area location', () => {
    it('GETs /outcomes-at-location by location_id and date, and echoes the id', async () => {
      h.upstream.route('GET', '/outcomes-at-location', jsonOk(outcomesBody()));
      const out = data(await call({ area: 'location', location_id: '1000001', month: '2026-07' }));
      expect(out.area).toEqual({ type: 'location', location_id: '1000001' });
      expect(out.total).toBe(3);
      const [sent] = h.upstream.callsTo('/outcomes-at-location');
      expect(Object.fromEntries(sent?.query ?? [])).toEqual({
        location_id: '1000001',
        date: '2026-07',
      });
      expect(h.upstream.count('/locate-neighbourhood')).toBe(0);
    });

    it('fails unknown_location (NotFound) when upstream answers 404 for the id, with the id in the message and a recovery hint', async () => {
      h.upstream.route('GET', '/outcomes-at-location', plainNotFound);
      const error = errorOf(
        await call({ area: 'location', location_id: '999999', month: '2026-07' }),
      );
      expect(error.code).toBe(JsonRpcErrorCode.NotFound);
      expect(error.data.reason).toBe('unknown_location');
      expect(error.message).toBe("data.police.uk holds no map point with location_id '999999'.");
      expect(error.data.recovery?.hint).toContain('location_id from the crime location');
      expect(h.upstream.count('/outcomes-at-location')).toBe(1);
    });

    it('reads an empty-bodied 404 the same way', async () => {
      h.upstream.route('GET', '/outcomes-at-location', (request) => status(404)(request));
      const error = errorOf(await call({ area: 'location', location_id: '5', month: '2026-07' }));
      expect(error.data.reason).toBe('unknown_location');
    });

    it('does not read a 404 as unknown_location on a point or polygon (a plain NotFound there)', async () => {
      h.upstream.route('GET', '/outcomes-at-location', plainNotFound);
      h.upstream.route('GET', '/locate-neighbourhood', jsonOk(locateBody()));
      const error = errorOf(await call({ ...POINT, month: '2026-07' }));
      expect(error.code).toBe(JsonRpcErrorCode.NotFound);
      expect(error.data.reason).not.toBe('unknown_location');
    });
  });

  describe('area neighbourhood', () => {
    const hoodRoutes = (body: unknown = outcomesBody()) => {
      h.upstream.route('GET', '/leicestershire/NX01/boundary', jsonOk(boundaryBody()));
      h.upstream.route('POST', '/outcomes-at-location', jsonOk(body));
    };

    it("posts the neighbourhood's boundary, echoes force, id and vertex count, and skips the point lookup", async () => {
      hoodRoutes();
      const out = data(await call({ ...HOOD, month: '2026-07' }));
      expect(out.area).toEqual({
        type: 'neighbourhood',
        force: 'leicestershire',
        neighbourhood_id: 'NX01',
        vertex_count: 5,
      });
      expect(out.total).toBe(3);
      const form = new URLSearchParams(h.upstream.callsTo('/outcomes-at-location')[0]?.body);
      expect(form.get('poly')?.split(':')).toHaveLength(5);
      expect(h.upstream.count('/locate-neighbourhood')).toBe(0);
    });

    it('fails unknown_neighbourhood (NotFound) when the boundary answers 404, naming the case-sensitive id', async () => {
      h.upstream.route('GET', '/leicestershire/nx01/boundary', plainNotFound);
      const error = errorOf(await call({ ...HOOD, neighbourhood_id: 'nx01', month: '2026-07' }));
      expect(error.code).toBe(JsonRpcErrorCode.NotFound);
      expect(error.data.reason).toBe('unknown_neighbourhood');
      expect(error.message).toBe(
        "Force 'leicestershire' has no neighbourhood 'nx01'; ids are case-sensitive.",
      );
      expect(error.data.recovery?.hint).toContain("topic 'neighbourhoods'");
      expect(h.upstream.count('/outcomes-at-location')).toBe(0);
    });

    it('keeps the neighbourhood id case and encodes spaces in the boundary path', async () => {
      h.upstream.route('GET', '/northern-ireland/Some%20Place/boundary', jsonOk(boundaryBody()));
      h.upstream.route('POST', '/outcomes-at-location', jsonOk(outcomesBody()));
      const out = data(
        await call({
          area: 'neighbourhood',
          force: 'Northern Ireland',
          neighbourhood_id: ' Some Place ',
          month: '2026-07',
        }),
      );
      expect(out.area.force).toBe('northern-ireland');
      expect(out.area.neighbourhood_id).toBe('Some Place');
    });

    it("fails unknown_force for 'btp' with the no-neighbourhoods message, before any area request", async () => {
      const error = errorOf(await call({ ...HOOD, force: 'btp', month: '2026-07' }));
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data.reason).toBe('unknown_force');
      expect(error.message).toBe('British Transport Police has no neighbourhoods.');
      expect(error.data.recovery?.hint).toContain("topic 'forces'");
      expect(h.upstream.count('/outcomes-at-location')).toBe(0);
      expect(h.upstream.count('/btp/NX01/boundary')).toBe(0);
    });

    it('fails unknown_force for a force not in the list', async () => {
      const error = errorOf(await call({ ...HOOD, force: 'atlantis', month: '2026-07' }));
      expect(error.data.reason).toBe('unknown_force');
      expect(error.message).toBe("No police force 'atlantis'.");
      expect(h.upstream.count('/outcomes-at-location')).toBe(0);
    });
  });

  describe('area arms this tool does not have', () => {
    it.each(['force', 'force_unplaced', 'country'])(
      'rejects area %j as InvalidParams, before any request',
      async (area) => {
        const error = errorOf(await callRaw({ area, force: 'leicestershire' }));
        expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
        expect(h.upstream.calls).toHaveLength(0);
      },
    );
  });

  describe('breakdowns', () => {
    it('sorts by_outcome by count descending, then code, and takes the name from the first record seen', async () => {
      // Sorted page order is crime month desc then crime id, so id 1 is seen first.
      pointRoutes([
        outcomeFor(9, '2026-07', 'zeta', 'Zeta last name'),
        outcomeFor(8, '2026-07', 'zeta', 'Zeta'),
        outcomeFor(7, '2026-07', 'alpha', 'Alpha'),
        outcomeFor(6, '2026-07', 'beta', 'Beta'),
        outcomeFor(5, '2026-07', 'gamma', 'Gamma'),
        outcomeFor(4, '2026-07', 'gamma', 'Gamma'),
        outcomeFor(3, '2026-07', 'gamma', 'Gamma'),
      ]);
      const out = data(await call({ ...POINT, month: '2026-07' }));
      expect(out.by_outcome).toEqual([
        { code: 'gamma', name: 'Gamma', count: 3 },
        { code: 'zeta', name: 'Zeta', count: 2 },
        { code: 'alpha', name: 'Alpha', count: 1 },
        { code: 'beta', name: 'Beta', count: 1 },
      ]);
    });

    it('sorts by_crime_month newest first across a year boundary', async () => {
      pointRoutes([
        outcomeFor(1, '2024-09'),
        outcomeFor(2, '2026-07'),
        outcomeFor(3, '2025-12'),
        outcomeFor(4, '2026-07'),
        outcomeFor(5, '2025-02'),
        outcomeFor(6, '2025-12'),
        outcomeFor(7, '2025-12'),
      ]);
      const out = data(await call({ ...POINT, month: '2026-07' }));
      expect(out.by_crime_month).toEqual([
        { month: '2026-07', count: 2 },
        { month: '2025-12', count: 3 },
        { month: '2025-02', count: 1 },
        { month: '2024-09', count: 1 },
      ]);
    });

    it('computes both breakdowns over the whole matched set, whatever the page size', async () => {
      pointRoutes(manyOutcomes(30));
      const out = data(await call({ ...POINT, month: '2026-07', limit: 2 }));
      expect(out.outcomes).toHaveLength(2);
      expect(out.by_outcome.reduce((sum, row) => sum + row.count, 0)).toBe(30);
      expect(out.by_crime_month.reduce((sum, row) => sum + row.count, 0)).toBe(30);
    });

    it('sorts the page by crime month descending then crime id ascending (numeric ids as published)', async () => {
      pointRoutes([
        outcomeFor(10, '2026-07'),
        outcomeFor(9, '2026-07'),
        outcomeFor(100, '2026-07'),
        outcomeFor(5, '2026-06'),
        outcomeFor(50, '2026-08'),
      ]);
      const out = data(await call({ ...POINT, month: '2026-07' }));
      expect(out.outcomes.map((o) => [o.crime.month, o.crime.id])).toEqual([
        ['2026-08', '50'],
        ['2026-07', '9'],
        ['2026-07', '10'],
        ['2026-07', '100'],
        ['2026-06', '5'],
      ]);
    });

    it('leaves both breakdowns empty for an empty result', async () => {
      pointRoutes([]);
      const out = data(await call({ ...POINT, month: '2026-07' }));
      expect(out.by_outcome).toEqual([]);
      expect(out.by_crime_month).toEqual([]);
    });
  });

  describe('category', () => {
    const mixed = () => [
      outcomeFor(1, '2026-07', 'under-investigation', 'Under investigation', 'burglary'),
      outcomeFor(2, '2026-07', 'cautioned', 'Cautioned', 'drugs'),
      outcomeFor(3, '2026-06', 'under-investigation', 'Under investigation', 'burglary'),
      outcomeFor(4, '2026-06', 'cautioned', 'Cautioned', 'violent-crime'),
    ];

    it.each([undefined, 'all-crime', 'ALL-CRIME', 'All crime', '  ', ''])(
      'counts every category and carries no category field for category %j',
      async (category) => {
        pointRoutes(mixed());
        const out = data(await callRaw({ ...POINT, month: '2026-07', category }));
        expect(out).not.toHaveProperty('category');
        expect(out.total).toBe(4);
        expect(out.unfiltered_total).toBe(4);
      },
    );

    it('filters locally on crime.category, with the slug and display name echoed and the breakdowns taken after it', async () => {
      pointRoutes(mixed());
      const out = data(await call({ ...POINT, month: '2026-07', category: 'burglary' }));
      expect(out.category).toEqual({ slug: 'burglary', name: 'Burglary' });
      expect(out.total).toBe(2);
      expect(out.unfiltered_total).toBe(4);
      expect(out.outcomes.map((o) => o.crime.id)).toEqual(['1', '3']);
      expect(out.by_outcome).toEqual([
        { code: 'under-investigation', name: 'Under investigation', count: 2 },
      ]);
      expect(out.by_crime_month).toEqual([
        { month: '2026-07', count: 1 },
        { month: '2026-06', count: 1 },
      ]);
      expect(out.shown).toBe(2);
    });

    it('sends no category to the upstream route (the outcomes route has no category parameter)', async () => {
      pointRoutes(mixed());
      await call({ ...POINT, month: '2026-07', category: 'burglary' });
      const [sent] = h.upstream.callsTo('/outcomes-at-location');
      expect(sent?.query.has('category')).toBe(false);
      expect(h.upstream.calls.some((c) => c.path.includes('burglary'))).toBe(false);
    });

    it.each([
      [
        'a display name',
        'Violence and sexual offences',
        'violent-crime',
        'Violence and sexual offences',
      ],
      ['an upper-cased slug', 'BURGLARY', 'burglary', 'Burglary'],
      ['a display name in upper case', 'DRUGS', 'drugs', 'Drugs'],
      ['padded and mixed case', '  Burglary ', 'burglary', 'Burglary'],
      [
        'a display name with doubled spaces',
        'Violence  and   sexual offences',
        'violent-crime',
        'Violence and sexual offences',
      ],
      ['a slug with underscores', 'vehicle_crime', 'vehicle-crime', 'Vehicle crime'],
      [
        'a display name with hyphens',
        'violence-and-sexual-offences',
        'violent-crime',
        'Violence and sexual offences',
      ],
    ])('matches %s against the cached vocabulary', async (_name, category, slug, name) => {
      pointRoutes(mixed());
      const out = data(await call({ ...POINT, month: '2026-07', category }));
      expect(out.category).toEqual({ slug, name });
    });

    it('fails unknown_category for a name outside the vocabulary, before any outcomes request', async () => {
      const error = errorOf(await call({ ...POINT, month: '2026-07', category: 'arson' }));
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data.reason).toBe('unknown_category');
      expect(error.message).toBe("No crime category matches 'arson'.");
      expect(error.data.recovery?.hint).toContain("topic 'categories'");
      expect(h.upstream.count('/outcomes-at-location')).toBe(0);
    });

    it('reports the lower-cased input in unknown_category', async () => {
      const error = errorOf(await call({ ...POINT, month: '2026-07', category: ' ARSON ' }));
      expect(error.message).toBe("No crime category matches 'arson'.");
    });

    it('reports a month failure before an unknown category, and an unknown category before an unknown force', async () => {
      const monthFirst = errorOf(await call({ ...POINT, month: '2026-09', category: 'arson' }));
      expect(monthFirst.data.reason).toBe('month_not_published');
      const categoryFirst = errorOf(
        await call({ ...HOOD, force: 'atlantis', month: '2026-07', category: 'arson' }),
      );
      expect(categoryFirst.data.reason).toBe('unknown_category');
    });
  });

  describe('month', () => {
    it('adds the defaulted-month fragment only when no month was given', async () => {
      pointRoutes();
      expect(data(await call({ ...POINT })).notice).toBe(MONTH_NOTE);
      expect(data(await call({ ...POINT, month: '2026-08' })).notice).toBeUndefined();
    });

    it('accepts the date alias for month and sends it as date', async () => {
      pointRoutes();
      const out = data(await callRaw({ ...POINT, date: '2026-05' }));
      expect(out.month).toBe('2026-05');
      expect(h.upstream.callsTo('/outcomes-at-location')[0]?.query.get('date')).toBe('2026-05');
    });

    it('fails month_not_published for a month after the latest, naming the latest', async () => {
      const error = errorOf(await call({ ...POINT, month: '2026-09' }));
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data.reason).toBe('month_not_published');
      expect(error.message).toBe(
        '2026-09 is not published yet; the latest published month is 2026-08.',
      );
      expect(error.data.recovery?.hint).toContain("topic 'availability'");
      expect(h.upstream.count('/outcomes-at-location')).toBe(0);
    });

    it('fails month_out_of_range for a month before the window, naming the earliest', async () => {
      const error = errorOf(await call({ ...POINT, month: '2023-08' }));
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data.reason).toBe('month_out_of_range');
      expect(error.message).toBe(
        '2023-08 is before 2023-09, the earliest month data.police.uk still serves.',
      );
      expect(h.upstream.count('/outcomes-at-location')).toBe(0);
    });

    it('searches the window edges', async () => {
      pointRoutes();
      expect(data(await call({ ...POINT, month: '2023-09' })).month).toBe('2023-09');
      expect(data(await call({ ...POINT, month: '2026-08' })).month).toBe('2026-08');
    });
  });

  describe('paging', () => {
    it('slices the sorted records, with next_offset and the range fragment after the month fragment', async () => {
      pointRoutes();
      const out = data(await call({ ...POINT, limit: 2 }));
      expect(out.outcomes.map((o) => o.crime.id)).toEqual(['100000080', '100000082']);
      expect(out.next_offset).toBe(2);
      expect(out.truncated).toBe(true);
      expect(out.shown).toBe(2);
      expect(out.cap).toBe(2);
      expect(out.notice).toBe(`${MONTH_NOTE} Showing 1–2 of 3; call again with offset 2 for more.`);
    });

    it('returns the last page without next_offset or a range fragment', async () => {
      pointRoutes();
      const out = data(await call({ ...POINT, month: '2026-07', limit: 2, offset: 2 }));
      expect(out.outcomes.map((o) => o.crime.id)).toEqual(['100000081']);
      expect(out).not.toHaveProperty('next_offset');
      expect(out.truncated).toBe(false);
      expect(out.shown).toBe(1);
      expect(out.notice).toBeUndefined();
    });

    it.each([3, 4, 1000])(
      'says the offset is past the end for offset %i of 3, with an empty page and no next_offset',
      async (offset) => {
        pointRoutes();
        const out = data(await call({ ...POINT, month: '2026-07', offset }));
        expect(out.outcomes).toEqual([]);
        expect(out.shown).toBe(0);
        expect(out.truncated).toBe(false);
        expect(out).not.toHaveProperty('next_offset');
        expect(out.notice).toBe(
          `offset ${offset} is past the last of 3 outcomes; omit offset to start from the first.`,
        );
        expect(out.total).toBe(3);
        expect(out.by_outcome.reduce((sum, row) => sum + row.count, 0)).toBe(3);
      },
    );

    it('pages the filtered set, and numbers the range against the filtered total', async () => {
      pointRoutes(manyOutcomes(30));
      const out = data(
        await call({ ...POINT, month: '2026-07', category: 'drugs', limit: 4, offset: 4 }),
      );
      expect(out.total).toBe(15);
      expect(out.unfiltered_total).toBe(30);
      expect(out.outcomes).toHaveLength(4);
      expect(out.outcomes.every((o) => o.crime.category === 'drugs')).toBe(true);
      expect(out.next_offset).toBe(8);
      expect(out.notice).toBe('Showing 5–8 of 15; call again with offset 8 for more.');
    });

    it('walks 250 outcomes in pages of 200 and 50 and returns each exactly once, in the sorted order', async () => {
      pointRoutes(manyOutcomes(250));
      const first = data(await call({ ...POINT, month: '2026-07', limit: 200 }));
      expect(first.outcomes).toHaveLength(200);
      expect(first.next_offset).toBe(200);
      expect(first.shown).toBe(200);
      expect(first.cap).toBe(200);
      const second = data(
        await call({ ...POINT, month: '2026-07', limit: 200, offset: first.next_offset }),
      );
      expect(second.outcomes).toHaveLength(50);
      expect(second).not.toHaveProperty('next_offset');
      const ids = [...first.outcomes, ...second.outcomes].map((o) => o.crime.id);
      expect(new Set(ids).size).toBe(250);
      const keys = [...first.outcomes, ...second.outcomes].map(
        (o) => `${o.crime.month}|${o.crime.id.padStart(12, '0')}`,
      );
      const expected = [...keys].sort((a, b) => {
        const [am = '', ai = ''] = a.split('|');
        const [bm = '', bi = ''] = b.split('|');
        return am < bm ? 1 : am > bm ? -1 : ai < bi ? -1 : ai > bi ? 1 : 0;
      });
      expect(keys).toEqual(expected);
    });

    it('reads the cache for later pages instead of the upstream', async () => {
      pointRoutes(manyOutcomes(10));
      await call({ ...POINT, month: '2026-07', limit: 3 });
      await call({ ...POINT, month: '2026-07', limit: 3, offset: 3 });
      await call({ ...POINT, month: '2026-07', limit: 3, offset: 6, category: 'burglary' });
      expect(h.upstream.count('/outcomes-at-location')).toBe(1);
    });

    it('does not mutate the cached records: a filtered call leaves the next unfiltered page whole', async () => {
      pointRoutes(manyOutcomes(10));
      await call({ ...POINT, month: '2026-07', category: 'burglary' });
      expect(data(await call({ ...POINT, month: '2026-07' })).total).toBe(10);
    });

    it.each<[string, unknown]>([
      ['limit 0', { limit: 0 }],
      ['limit 201', { limit: 201 }],
      ['a fractional limit', { limit: 2.5 }],
      ['a string limit', { limit: '5' }],
      ['a negative offset', { offset: -1 }],
      ['a fractional offset', { offset: 1.5 }],
    ])('rejects %s as InvalidParams', async (_name, extra) => {
      const error = errorOf(await callRaw({ ...POINT, ...(extra as object) }));
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(h.upstream.calls).toHaveLength(0);
    });
  });

  describe('zero-hit notices', () => {
    it('with the month defaulted and nothing recorded: the month fragment, then the generic one', async () => {
      pointRoutes([]);
      expect(data(await call({ ...POINT })).notice).toBe(`${MONTH_NOTE} ${ZERO_GENERIC}`);
    });

    it('with a month given, the generic fragment alone', async () => {
      pointRoutes([]);
      expect(data(await call({ ...POINT, month: '2026-07' })).notice).toBe(
        'No outcomes recorded here in 2026-07; try another month or a wider area.',
      );
    });

    it('outside coverage (point lookup 404) replaces the generic fragment', async () => {
      h.upstream.route('GET', '/outcomes-at-location', jsonOk([]));
      h.upstream.route('GET', '/locate-neighbourhood', plainNotFound);
      const out = data(await call({ ...POINT, month: '2026-07' }));
      expect(out.notice).toBe(OUTSIDE_POINT);
      expect(out.area).toEqual({ type: 'point', lat: LAT, lng: LNG });
    });

    it('outside coverage wins over the category fragment', async () => {
      h.upstream.route('GET', '/outcomes-at-location', jsonOk([]));
      h.upstream.route('GET', '/locate-neighbourhood', plainNotFound);
      const out = data(await call({ ...POINT, month: '2026-07', category: 'burglary' }));
      expect(out.notice).toBe(OUTSIDE_POINT);
    });

    it('a swapped polygon with no hits says every vertex lies outside coverage', async () => {
      h.upstream.route('POST', '/outcomes-at-location', jsonOk([]));
      const swapped = RING.map(({ lat, lng }) => ({ lat: lng, lng: lat }));
      const out = data(await call({ area: 'polygon', polygon: swapped, month: '2026-07' }));
      expect(out.notice).toBe(
        'This polygon lies outside data.police.uk coverage; each vertex is {lat, lng}, so check the two were not swapped.',
      );
    });

    it('a polygon inside coverage with no hits gets the generic fragment', async () => {
      h.upstream.route('POST', '/outcomes-at-location', jsonOk([]));
      const out = data(await call({ area: 'polygon', polygon: RING, month: '2026-07' }));
      expect(out.notice).toBe(
        'No outcomes recorded here in 2026-07; try another month or a wider area.',
      );
    });

    it('with a category and no hits in a located area: the category fragment replaces the generic one', async () => {
      pointRoutes(outcomesBody());
      const out = data(await call({ ...POINT, month: '2026-07', category: 'robbery' }));
      expect(out.total).toBe(0);
      expect(out.unfiltered_total).toBe(3);
      expect(out.notice).toBe(
        'Only outcomes for Robbery crimes were counted; omit category for all.',
      );
      expect(out.outcomes).toEqual([]);
    });

    it('names the category by its display name when the area held outcomes, and the explicit all-crime gets the generic fragment', async () => {
      pointRoutes(outcomesBody());
      const named = data(
        await call({ ...POINT, month: '2026-07', category: 'Violence and sexual offences' }),
      );
      expect(named.notice).toBe(
        'Only outcomes for Violence and sexual offences crimes were counted; omit category for all.',
      );
      const all = data(await call({ ...POINT, month: '2026-07', category: 'all-crime' }));
      expect(all.total).toBe(3);
      expect(all.notice).toBeUndefined();
    });

    it('with a category and nothing recorded in the area at all, the generic fragment (the category cannot be the cause)', async () => {
      pointRoutes([]);
      const out = data(await call({ ...POINT, month: '2026-07', category: 'burglary' }));
      expect(out.total).toBe(0);
      expect(out.unfiltered_total).toBe(0);
      expect(out.notice).toBe(
        'No outcomes recorded here in 2026-07; try another month or a wider area.',
      );
      const all = data(await call({ ...POINT, month: '2026-07', category: 'all-crime' }));
      expect(all.notice).toBe(
        'No outcomes recorded here in 2026-07; try another month or a wider area.',
      );
    });

    it('orders month fragment, coverage fact, then the zero-hit fragment', async () => {
      pointRoutes([], locateBody({ force: 'greater-manchester', neighbourhood: 'GM1' }));
      const out = data(await call({ ...POINT }));
      expect(out.notice).toBe(
        [MONTH_NOTE, ...coverageNotes('greater-manchester', ['outcomes']), ZERO_GENERIC].join(' '),
      );
    });

    it('no zero-hit fragment when a point lookup failed (no coverage claim is possible)', async () => {
      h.upstream.route('GET', '/outcomes-at-location', jsonOk([]));
      h.upstream.route('GET', '/locate-neighbourhood', status(500));
      const out = data(await call({ ...POINT, month: '2026-07' }));
      expect(out.notice).toBe(
        'No outcomes recorded here in 2026-07; try another month or a wider area.',
      );
    });
  });

  describe('coverage notes (the outcomes aspect only)', () => {
    it.each(['greater-manchester', 'northern-ireland', 'devon-and-cornwall'])(
      'adds the dated outcomes fact for a located %s point',
      async (force) => {
        pointRoutes(outcomesBody(), locateBody({ force, neighbourhood: 'ZZ1' }));
        const out = data(await call({ ...POINT, month: '2026-07' }));
        const facts = coverageNotes(force, ['outcomes']);
        expect(facts).toHaveLength(1);
        expect(out.notice).toBe(facts[0]);
        expect(out.notice).toContain('(data.police.uk known issues, verified 2026-10-01)');
      },
    );

    it('says nothing for forces whose table facts concern other aspects', async () => {
      for (const force of ['avon-and-somerset', 'leicestershire', 'metropolitan']) {
        pointRoutes(outcomesBody(), locateBody({ force, neighbourhood: 'ZZ1' }));
        const out = data(
          await call({ ...POINT, month: '2026-07', lat: LAT + 0.01 * force.length }),
        );
        expect(out.notice, force).toBeUndefined();
      }
    });

    it('uses the named force on the neighbourhood arm', async () => {
      h.upstream.route('GET', '/greater-manchester/GM1/boundary', jsonOk(boundaryBody()));
      h.upstream.route('POST', '/outcomes-at-location', jsonOk(outcomesBody()));
      const out = data(
        await call({
          area: 'neighbourhood',
          force: 'greater-manchester',
          neighbourhood_id: 'GM1',
          month: '2026-07',
        }),
      );
      expect(out.notice).toBe(coverageNotes('greater-manchester', ['outcomes']).join(' '));
    });

    it('carries no crime-aspect fact (Northern Ireland placeholder outcomes are a crimes note)', async () => {
      pointRoutes(outcomesBody(), locateBody({ force: 'northern-ireland', neighbourhood: 'X' }));
      const out = data(await call({ ...POINT, month: '2026-07' }));
      expect(out.notice).not.toContain('placeholder outcome');
    });
  });

  describe('enrichment: the zero-result page and the under-cap page', () => {
    it('zero-result page: attribution, data_note, truncated false, shown 0, cap and the notice', async () => {
      pointRoutes([]);
      const result = await call({ ...POINT, limit: 20 });
      const out = data(result);
      expect(out.attribution).toBe(ATTRIBUTION);
      expect(out.data_note).toBe(
        "An outcome's month is when police recorded it; the crime's own month can be years earlier. Police outcomes only — court results are not published. Locations are anonymised map points, not crime sites.",
      );
      expect(out.truncated).toBe(false);
      expect(out.shown).toBe(0);
      expect(out.cap).toBe(20);
      expect(out.notice).toBe(`${MONTH_NOTE} ${ZERO_GENERIC}`);
      expect(out.total).toBe(0);
      expect(out.unfiltered_total).toBe(0);
      expect(out.outcomes).toEqual([]);
      const rendered = text(result);
      expect(rendered).toContain('**Attribution:**');
      expect(rendered).toContain('**Data note:**');
      expect(rendered).toContain('**More rows:**');
      expect(rendered).toContain('**Rows shown:** 0');
      expect(rendered).toContain('**Page limit:** 20');
      expect(rendered).toContain('_None._');
    });

    it('under-cap page: shown is the page length, below the cap, truncated false, no notice', async () => {
      pointRoutes();
      const result = await call({ ...POINT, limit: 50, month: '2026-07' });
      const out = data(result);
      expect(out.attribution).toBe(ATTRIBUTION);
      expect(out.data_note).toContain('court results are not published');
      expect(out.shown).toBe(3);
      expect(out.cap).toBe(50);
      expect(out.shown).toBeLessThan(out.cap);
      expect(out.truncated).toBe(false);
      expect(out.notice).toBeUndefined();
      expect(text(result)).toContain('**Rows shown:** 3');
      expect(text(result)).toContain('**Page limit:** 50');
    });

    it('zero-result page on every other arm still carries the required fields', async () => {
      h.upstream.route('POST', '/outcomes-at-location', jsonOk([]));
      h.upstream.route('GET', '/outcomes-at-location', jsonOk([]));
      h.upstream.route('GET', '/leicestershire/NX01/boundary', jsonOk(boundaryBody()));
      const inputs: Input[] = [
        { area: 'polygon', polygon: RING, month: '2026-07' },
        { area: 'location', location_id: '1000001', month: '2026-07' },
        { ...HOOD, month: '2026-07' },
      ];
      for (const input of inputs) {
        const out = data(await call(input));
        expect(out.attribution, input.area).toBe(ATTRIBUTION);
        expect(out.data_note, input.area).toBeTruthy();
        expect(out.truncated, input.area).toBe(false);
        expect(out.shown, input.area).toBe(0);
        expect(out.cap, input.area).toBe(50);
        expect(out.notice, input.area).toBeTruthy();
      }
    });

    it('under-cap page on a narrowed category and a short page', async () => {
      pointRoutes();
      const out = data(await call({ ...POINT, category: 'burglary', month: '2026-07', limit: 5 }));
      expect(out.shown).toBe(3);
      expect(out.cap).toBe(5);
      expect(out.truncated).toBe(false);
    });

    it('a filter that matches nothing is a zero-result page with the unfiltered total kept', async () => {
      pointRoutes();
      const out = data(await call({ ...POINT, category: 'robbery', month: '2026-07' }));
      expect(out.shown).toBe(0);
      expect(out.truncated).toBe(false);
      expect(out.unfiltered_total).toBe(3);
    });
  });

  describe('enrichment write order (direct handler)', () => {
    const run = async (raw: Input) => {
      const ctx = createMockContext({ errors: searchOutcomesTool.errors });
      const input = searchOutcomesTool.input.parse(raw);
      const output = await settle(Promise.resolve(searchOutcomesTool.handler(input, ctx))).catch(
        (e: unknown) => e,
      );
      return { ctx, output };
    };

    it('writes the five required fields first, then notice last, overwriting truncated and shown in place', async () => {
      pointRoutes();
      const { ctx, output } = await run({ ...POINT, limit: 2 });
      expect(output).toMatchObject({ total: 3, next_offset: 2 });
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
        shown: 2,
        cap: 2,
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
      expect(getEnrichment(ctx)).toMatchObject({ truncated: false, shown: 3 });
    });

    it('has the five required fields in place before the first thing that can fail', async () => {
      const { ctx, output } = await run({ area: 'point', lat: LAT });
      expect(output).toMatchObject({ data: { reason: 'invalid_area' } });
      expect(getEnrichment(ctx)).toEqual({
        attribution: ATTRIBUTION,
        data_note: expect.any(String),
        truncated: false,
        shown: 0,
        cap: 50,
      });
    });

    it('leaves truncated false and shown 0 when a later step fails', async () => {
      const { ctx, output } = await run({ ...POINT, month: '2026-09' });
      expect(output).toMatchObject({ data: { reason: 'month_not_published' } });
      expect(getEnrichment(ctx)).toMatchObject({ truncated: false, shown: 0, cap: 50 });
      expect(getEnrichment(ctx)).not.toHaveProperty('notice');
    });

    it('logs a quiet warning, not an error, when only the locate fails', async () => {
      h.upstream.route('GET', '/outcomes-at-location', jsonOk(outcomesBody()));
      h.upstream.route('GET', '/locate-neighbourhood', status(500));
      const { ctx, output } = await run({ ...POINT, month: '2026-07' });
      expect(output).toMatchObject({ total: 3 });
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
        'point without either coordinate',
        { area: 'point' },
        "area 'point' needs lat and lng; lat and lng are missing.",
      ],
      [
        'point with a polygon',
        { area: 'point', lat: LAT, lng: LNG, polygon: RING },
        "area 'point' does not use polygon; remove it or choose the area that takes it.",
      ],
      [
        'point with a force and neighbourhood',
        { area: 'point', lat: LAT, lng: LNG, force: 'leicestershire', neighbourhood_id: 'NX01' },
        "area 'point' does not use force and neighbourhood_id; remove them or choose the area that takes them.",
      ],
      [
        'polygon without a polygon',
        { area: 'polygon' },
        "area 'polygon' needs polygon; polygon is missing.",
      ],
      [
        'polygon with a location_id',
        { area: 'polygon', polygon: RING, location_id: '1' },
        "area 'polygon' does not use location_id; remove it or choose the area that takes it.",
      ],
      [
        'location without a location_id',
        { area: 'location' },
        "area 'location' needs location_id; location_id is missing.",
      ],
      [
        'location with a point',
        { area: 'location', location_id: '1', lat: LAT, lng: LNG },
        "area 'location' does not use lat and lng; remove them or choose the area that takes them.",
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
    ])(
      'rejects %s with invalid_area and the arm-specific message, before any request',
      async (_name, input, message) => {
        const error = errorOf(await callRaw(input));
        expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
        expect(error.data.reason).toBe('invalid_area');
        expect(error.message).toBe(message);
        expect(error.data.recovery?.hint).toBe(
          "Send lat and lng for area 'point', polygon for 'polygon', location_id for 'location', or force and neighbourhood_id for 'neighbourhood'.",
        );
        expect(h.upstream.calls).toHaveLength(0);
      },
    );

    it('treats lat 0 and lng 0 as values, not as unset', async () => {
      pointRoutes([]);
      const out = data(await call({ area: 'point', lat: 0, lng: 0, month: '2026-07' }));
      expect(out.area).toMatchObject({ lat: 0, lng: 0 });
    });
  });

  describe('blank values read as unset (form clients)', () => {
    it('accepts empty strings, whitespace and null on every optional input of a point search', async () => {
      pointRoutes();
      const out = data(
        await callRaw({
          area: 'point',
          lat: LAT,
          lng: LNG,
          polygon: '',
          location_id: '  ',
          force: '',
          neighbourhood_id: null,
          month: '',
          category: ' ',
        }),
      );
      expect(out.month).toBe('2026-08');
      expect(out).not.toHaveProperty('category');
    });

    it('treats a blank lat and lng on a polygon search as unset', async () => {
      h.upstream.route('POST', '/outcomes-at-location', jsonOk(outcomesBody()));
      const out = data(
        await callRaw({ area: 'polygon', polygon: RING, lat: '', lng: null, month: '' }),
      );
      expect(out.area.type).toBe('polygon');
    });

    it('treats an empty polygon list as unset, so a polygon area reports it missing', async () => {
      const error = errorOf(await callRaw({ area: 'polygon', polygon: [] }));
      expect(error.data.reason).toBe('invalid_area');
    });

    it('treats a blank force and neighbourhood_id as missing on the neighbourhood arm', async () => {
      const error = errorOf(
        await callRaw({ area: 'neighbourhood', force: '  ', neighbourhood_id: '' }),
      );
      expect(error.data.reason).toBe('invalid_area');
    });

    it('normalizes a spoken force name and keeps the id case', async () => {
      h.upstream.route('GET', '/greater-manchester/AB12/boundary', jsonOk(boundaryBody()));
      h.upstream.route('POST', '/outcomes-at-location', jsonOk(outcomesBody()));
      const out = data(
        await callRaw({
          area: 'neighbourhood',
          force: ' Greater_Manchester ',
          neighbourhood_id: 'AB12',
          month: '2026-07',
        }),
      );
      expect(out.area).toMatchObject({ force: 'greater-manchester', neighbourhood_id: 'AB12' });
    });
  });

  describe('input validation', () => {
    it.each<[string, unknown]>([
      ['a missing area', { lat: LAT, lng: LNG }],
      ['an unknown area', { area: 'circle', lat: LAT, lng: LNG }],
      ['lat above 90', { area: 'point', lat: 91, lng: LNG }],
      ['lng below -180', { area: 'point', lat: LAT, lng: -181 }],
      ['a string lat', { area: 'point', lat: '52.6', lng: LNG }],
      ['a month in the wrong form', { ...POINT, month: '2026-13' }],
      ['a month with a day', { ...POINT, month: '2026-07-15' }],
      ['a non-numeric location_id', { area: 'location', location_id: 'abc' }],
      ['a 13-digit location_id', { area: 'location', location_id: '1234567890123' }],
      ['a force with digits', { ...HOOD, force: 'force1' }],
      ['a force with a path in it', { ...HOOD, force: '../forces' }],
      ['a neighbourhood id with a slash', { ...HOOD, neighbourhood_id: 'a/b' }],
      ['a neighbourhood id of ..', { ...HOOD, neighbourhood_id: '..' }],
      ['a neighbourhood id with a query', { ...HOOD, neighbourhood_id: 'a?b' }],
      ['a neighbourhood id over 100 characters', { ...HOOD, neighbourhood_id: 'a'.repeat(101) }],
      ['a polygon of two vertices', { area: 'polygon', polygon: RING.slice(0, 2) }],
      [
        'a polygon of [lng, lat] pairs',
        {
          area: 'polygon',
          polygon: [
            [-1.1, 52.6],
            [-1.2, 52.6],
            [-1.2, 52.7],
          ],
        },
      ],
      ['a category over 100 characters', { ...POINT, category: 'a'.repeat(101) }],
    ])('rejects %s as InvalidParams without any request', async (_name, input) => {
      const error = errorOf(await callRaw(input));
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(error.data.reason).toBe('invalid_arguments');
      expect(h.upstream.calls).toHaveLength(0);
    });

    it('accepts the coordinate aliases', async () => {
      pointRoutes([]);
      const out = data(
        await callRaw({ area: 'point', latitude: 52.1, lon: -1.2, month: '2026-07' }),
      );
      expect(out.area).toMatchObject({ lat: 52.1, lng: -1.2 });
      const out2 = data(
        await callRaw({ area: 'point', latitude: 52.3, longitude: -1.4, month: '2026-07' }),
      );
      expect(out2.area).toMatchObject({ lat: 52.3, lng: -1.4 });
      const out3 = data(await callRaw({ area: 'point', lat: 52.5, long: -1.6, month: '2026-07' }));
      expect(out3.area).toMatchObject({ lat: 52.5, lng: -1.6 });
    });
  });

  describe('upstream failures on the area query', () => {
    it.each<[string, () => void, number, string | undefined]>([
      [
        'a persistent 500',
        () => h.upstream.route('GET', '/outcomes-at-location', status(500)),
        JsonRpcErrorCode.ServiceUnavailable,
        undefined,
      ],
      [
        'a 502',
        () => h.upstream.route('GET', '/outcomes-at-location', status(502)),
        JsonRpcErrorCode.ServiceUnavailable,
        undefined,
      ],
      [
        'a 429 with a long Retry-After',
        () => h.upstream.route('GET', '/outcomes-at-location', rateLimited('60')),
        JsonRpcErrorCode.RateLimited,
        undefined,
      ],
      [
        'an HTML 200 body',
        () => h.upstream.route('GET', '/outcomes-at-location', htmlOk),
        JsonRpcErrorCode.ServiceUnavailable,
        'unreadable_response',
      ],
      [
        'an object where an array was expected',
        () => h.upstream.route('GET', '/outcomes-at-location', jsonOk({ outcomes: [] })),
        JsonRpcErrorCode.ServiceUnavailable,
        'unexpected_response',
      ],
      [
        'an outcome missing its category',
        () =>
          h.upstream.route(
            'GET',
            '/outcomes-at-location',
            jsonOk([{ date: '2026-08', crime: crimeRecord() }]),
          ),
        JsonRpcErrorCode.ServiceUnavailable,
        'unexpected_response',
      ],
      [
        'an outcome missing its crime',
        () =>
          h.upstream.route(
            'GET',
            '/outcomes-at-location',
            jsonOk([{ date: '2026-08', category: { code: 'x', name: 'X' } }]),
          ),
        JsonRpcErrorCode.ServiceUnavailable,
        'unexpected_response',
      ],
      [
        'a crime with a street-less location',
        () =>
          h.upstream.route(
            'GET',
            '/outcomes-at-location',
            jsonOk([
              areaOutcomeRecord({
                crime: crimeRecord({ location: { latitude: '1', longitude: '2' } }),
              }),
            ]),
          ),
        JsonRpcErrorCode.ServiceUnavailable,
        'unexpected_response',
      ],
      [
        'an upstream that never answers',
        () => h.upstream.route('GET', '/outcomes-at-location', hang),
        JsonRpcErrorCode.Timeout,
        undefined,
      ],
      [
        'a 400 the server built',
        () => h.upstream.route('GET', '/outcomes-at-location', htmlBadRequest),
        JsonRpcErrorCode.InvalidParams,
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
      h.upstream.route('GET', '/outcomes-at-location', jsonOk({ secret: 'upstream-only-text' }));
      const result = await call({ ...POINT, month: '2026-07' });
      expect(errorOf(result).message).toContain('/outcomes-at-location');
      expect(JSON.stringify(result)).not.toContain('upstream-only-text');
    });

    it('on the location arm a 500 stays a ServiceUnavailable (only a 404 is unknown_location)', async () => {
      h.upstream.route('GET', '/outcomes-at-location', status(500));
      const error = errorOf(await call({ area: 'location', location_id: '1', month: '2026-07' }));
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    });

    it('fails a month read that fails (reference data) without touching the area route', async () => {
      h.upstream.route('GET', '/crimes-street-dates', status(500));
      expect(errorOf(await call({ ...POINT })).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(h.upstream.count('/outcomes-at-location')).toBe(0);
    });

    it('fails a category vocabulary read that fails, when a category is given', async () => {
      h.upstream.route('GET', '/crime-categories', status(500));
      expect(errorOf(await call({ ...POINT, category: 'burglary' })).code).toBe(
        JsonRpcErrorCode.ServiceUnavailable,
      );
    });

    it('does not read the category vocabulary when no category is given', async () => {
      pointRoutes();
      await call({ ...POINT, month: '2026-07' });
      expect(h.upstream.count('/crime-categories')).toBe(0);
    });

    it('fails a force list read that fails for the neighbourhood arm', async () => {
      h.upstream.route('GET', '/forces', status(500));
      expect(errorOf(await call({ ...HOOD, month: '2026-07' })).code).toBe(
        JsonRpcErrorCode.ServiceUnavailable,
      );
    });

    it('does not retry a body it could not use as an outcome list', async () => {
      h.upstream.route('GET', '/locate-neighbourhood', jsonOk(locateBody()));
      h.upstream.route('GET', '/outcomes-at-location', jsonOk('nope'));
      await call({ ...POINT, month: '2026-07' });
      expect(h.upstream.count('/outcomes-at-location')).toBe(1);
    });

    it('cancels with RequestCancelled when the signal is already aborted', async () => {
      pointRoutes();
      const controller = new AbortController();
      controller.abort(new Error('client went away'));
      const result = await settle(
        runToolContract(
          searchOutcomesTool,
          { ...POINT },
          { context: { signal: controller.signal } },
        ),
      );
      expect(errorOf(result).code).toBe(JsonRpcErrorCode.RequestCancelled);
      expect(h.upstream.count('/outcomes-at-location')).toBe(0);
    });
  });

  describe('503 on the area query (area_too_large vs upstream_unavailable)', () => {
    it('point: area_too_large with the point wording as the recovery hint', async () => {
      h.upstream.route('GET', '/outcomes-at-location', overloaded);
      h.upstream.route('GET', '/locate-neighbourhood', jsonOk(locateBody()));
      const error = errorOf(await call({ ...POINT, month: '2026-07' }));
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data.reason).toBe('area_too_large');
      expect(error.data.recovery?.hint).toBe(POINT_TOO_LARGE);
      expect(h.upstream.count('/outcomes-at-location')).toBe(1);
      expect(h.upstream.count('/crime-last-updated')).toBe(1);
    });

    it.each<[string, Input, () => void]>([
      [
        'polygon',
        { area: 'polygon', polygon: RING, month: '2026-07' },
        () => h.upstream.route('POST', '/outcomes-at-location', overloaded),
      ],
      [
        'neighbourhood',
        { ...HOOD, month: '2026-07' },
        () => {
          h.upstream.route('GET', '/leicestershire/NX01/boundary', jsonOk(boundaryBody()));
          h.upstream.route('POST', '/outcomes-at-location', overloaded);
        },
      ],
      [
        'location',
        { area: 'location', location_id: '1000001', month: '2026-07' },
        () => h.upstream.route('GET', '/outcomes-at-location', overloaded),
      ],
    ])('%s: area_too_large with the declared recovery', async (_name, input, arrange) => {
      arrange();
      const error = errorOf(await call(input));
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data.reason).toBe('area_too_large');
      expect(error.data.recovery?.hint).toContain('split the polygon into smaller polygons');
      expect(error.data.recovery?.hint).toContain("include ['boundary']");
      expect(error.data.recovery?.hint).toContain('more than 10,000 outcomes');
    });

    it.each<[string, () => void]>([
      ['a failing probe', () => h.upstream.route('GET', '/crime-last-updated', status(500))],
      ['a probe 503', () => h.upstream.route('GET', '/crime-last-updated', overloaded)],
      ['a hung probe', () => h.upstream.route('GET', '/crime-last-updated', hang)],
    ])('is upstream_unavailable, retryable, with %s', async (_name, arrange) => {
      h.upstream.route('GET', '/locate-neighbourhood', jsonOk(locateBody()));
      h.upstream.route('GET', '/outcomes-at-location', overloaded);
      arrange();
      const error = errorOf(await call({ ...POINT, month: '2026-07' }));
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.data.reason).toBe('upstream_unavailable');
      expect(error.data.retryable).toBe(true);
      expect(error.data.recovery?.hint).toContain('call this tool again in a few minutes');
    });
  });

  describe('the locate beside a point search', () => {
    it('degrades to an unlocated echo and still returns the outcomes when the locate fails', async () => {
      h.upstream.route('GET', '/outcomes-at-location', jsonOk(outcomesBody()));
      h.upstream.route('GET', '/locate-neighbourhood', status(500));
      const out = data(await call({ ...POINT, month: '2026-07' }));
      expect(out.total).toBe(3);
      expect(out.area).toEqual({ type: 'point', lat: LAT, lng: LNG });
      expect(out.notice).toBeUndefined();
    });

    it('caches the locate across searches of the same point', async () => {
      pointRoutes();
      await call({ ...POINT, month: '2026-07' });
      await call({ ...POINT, month: '2026-06' });
      expect(h.upstream.count('/locate-neighbourhood')).toBe(1);
      expect(h.upstream.count('/outcomes-at-location')).toBe(2);
    });

    it('does not turn a miss into a notice when there are outcomes', async () => {
      h.upstream.route('GET', '/outcomes-at-location', jsonOk(outcomesBody()));
      h.upstream.route('GET', '/locate-neighbourhood', plainNotFound);
      expect(data(await call({ ...POINT, month: '2026-07' })).notice).toBeUndefined();
    });
  });

  describe('format() matches structuredContent', () => {
    it('renders the heading, area line, counts, both breakdown tables and every outcome with its crime', async () => {
      pointRoutes();
      const result = await call({ ...POINT });
      const out = data(result);
      const rendered = text(result);
      expect(rendered).toContain('## Police outcomes — 2026-08');
      expect(rendered).toContain(
        '**Area:** point · lat 52.63 · lng -1.13 · located force leicestershire · located neighbourhood NX01',
      );
      expect(rendered).toContain('**Outcomes matched:** 3 of 3 recorded this month');
      for (const row of out.by_outcome) {
        expect(rendered).toContain(`| ${row.name} | ${row.code} | ${row.count} |`);
      }
      for (const row of out.by_crime_month) {
        expect(rendered).toContain(`| ${row.month} | ${row.count} |`);
      }
      expect(rendered).toContain('### Outcomes on this page (3)');
      for (const outcome of out.outcomes) {
        expect(rendered).toContain(
          `**${outcome.name}** (${outcome.code}) · recorded ${outcome.month}`,
        );
        expect(rendered).toContain(
          `${outcome.crime.category} · id ${outcome.crime.id} · crime month ${outcome.crime.month} · persistent_id ${outcome.crime.persistent_id}`,
        );
      }
      expect(rendered).toContain(
        'On or near Example Street · location_id 1000001 · anonymised map point 52.63, -1.13 · Force',
      );
      expect(rendered).toContain(`> ${MONTH_NOTE}`);
    });

    it('labels every coordinate pair an anonymised map point', async () => {
      pointRoutes();
      const rendered = text(await call({ ...POINT, month: '2026-07' }));
      for (const line of rendered.split('\n').filter((l) => /52\.63, -1\.13/.test(l))) {
        expect(line).toContain('anonymised map point');
      }
    });

    it('renders the category line when filtered, the next offset, and the none markers on an empty page', async () => {
      pointRoutes();
      const paged = await call({ ...POINT, month: '2026-07', category: 'burglary', limit: 1 });
      const rendered = text(paged);
      expect(rendered).toContain('**Crime category:** Burglary (burglary)');
      expect(rendered).toContain('**Next offset:** 1');
      const empty = text(await call({ ...POINT, month: '2026-07', category: 'robbery' }));
      expect(empty.match(/_None\._/g)).toHaveLength(3);
      expect(empty).toContain('### Outcomes on this page (0)');
      expect(empty).not.toContain('**Next offset:**');
    });

    it('renders crime context as a blockquote and omits the persistent_id and location lines when absent', async () => {
      pointRoutes([
        areaOutcomeRecord({
          crime: crimeRecord({
            id: 7,
            context: 'First line\r\nSecond line',
            persistent_id: '',
            location: null,
          }),
        }),
      ]);
      const rendered = text(await call({ ...POINT, month: '2026-07' }));
      expect(rendered).toContain('  - Context:\n    > First line\n    > Second line');
      expect(rendered).not.toContain('persistent_id');
      expect(rendered).not.toContain('Location:');
    });

    it('keeps upstream text verbatim in structuredContent and inert in the markdown', async () => {
      const hostile = 'Evil\r\n# Injected | cell [x](https://evil.test) <b>\u202Etxt';
      pointRoutes([
        areaOutcomeRecord({
          category: { code: 'odd|code', name: hostile },
          crime: crimeRecord({
            id: 1,
            context: 'Ctx\u2028# Heading\u2029[link](https://evil.test)\u0085<i>x</i>\u202E',
            location: wireLocation(1_000_005, hostile, '52.630000', '-1.130000'),
            location_subtype: hostile,
          }),
        }),
      ]);
      const result = await call({ ...POINT, month: '2026-07' });
      const out = data(result);
      expect(out.outcomes[0]?.name).toBe(hostile);
      expect(out.outcomes[0]?.crime.location?.street_name).toBe(hostile);
      expect(out.outcomes[0]?.crime.context).toBe(
        'Ctx\u2028# Heading\u2029[link](https://evil.test)\u0085<i>x</i>\u202E',
      );
      const rendered = text(result);
      for (const char of ['\r', '\u2028', '\u2029', '\u0085', '\u202E']) {
        expect(rendered.includes(char), JSON.stringify(char)).toBe(false);
      }
      for (const line of rendered.split('\n')) {
        expect(line.startsWith('# '), line).toBe(false);
      }
      const row = rendered.split('\n').find((l) => l.includes('odd\\|code'));
      expect(row).toBe(
        '| Evil # Injected \\| cell \\[x\\](https://evil.test) \\<b\\>txt | odd\\|code | 1 |',
      );
      expect(rendered).toContain(
        '  - Context:\n    > Ctx\n    > # Heading\n    > \\[link\\](https://evil.test)\n    > ',
      );
    });

    it('keeps CR/LF in outcome and street text out of inline slots', async () => {
      pointRoutes([
        areaOutcomeRecord({
          category: { code: 'a', name: 'Name\r\nwith\nbreaks' },
          crime: crimeRecord({
            location: wireLocation(
              1_000_006,
              'On or near\r\nBreak Street',
              '52.630000',
              '-1.130000',
            ),
          }),
        }),
      ]);
      const rendered = text(await call({ ...POINT, month: '2026-07' }));
      expect(rendered).toContain('| Name with breaks | a | 1 |');
      expect(rendered).toContain('**Name with breaks** (a) · recorded');
      expect(rendered).toContain('On or near Break Street · location_id 1000006');
      expect(rendered).not.toContain('\r');
    });

    it('format() of the output object alone carries the same rows as the contract result', async () => {
      pointRoutes();
      const out = data(await call({ ...POINT, month: '2026-07' }));
      const direct = searchOutcomesTool.format?.(out) ?? [];
      const rendered = direct.map((b) => (b.type === 'text' ? b.text : '')).join('');
      for (const outcome of out.outcomes) {
        expect(rendered).toContain(outcome.crime.id);
      }
    });
  });

  describe('caching across calls', () => {
    it('reads the reference lists and the area once for repeat calls, and a new month is a new request', async () => {
      pointRoutes();
      await call({ ...POINT, month: '2026-07' });
      await call({ ...POINT, month: '2026-07', category: 'burglary' });
      await call({ ...POINT, month: '2026-06' });
      expect(h.upstream.count('/crimes-street-dates')).toBe(1);
      expect(h.upstream.count('/crime-categories')).toBe(1);
      expect(h.upstream.count('/outcomes-at-location')).toBe(2);
    });
  });
});
