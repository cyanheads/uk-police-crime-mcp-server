/**
 * @fileoverview The plumbing the area search tools share: the named-force check
 * (`btp` only on the force arms), month-failure wording, `runAreaQuery`'s miss
 * values and its point-arm locate that degrades quietly unless the call was
 * cancelled, breakdowns, paging, the area echo, and the notice fragments.
 * @module tests/tools/area-search.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import type { MockContextLogger } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import {
  AREA_INPUT_ALIASES,
  areaEcho,
  breakdown,
  checkNamedForce,
  monthDefaultedNote,
  monthFailureMessage,
  NOT_RECORDED,
  outsideCoverageNote,
  pageOf,
  pagingNote,
  runAreaQuery,
  searchedForceId,
} from '@/mcp-server/tools/area-search.js';
import {
  type AreaSpec,
  crimesQuery,
  outcomesQuery,
  stopsQuery,
} from '@/services/police-api/area.js';
import type { LocatedNeighbourhood, Lookup, Place } from '@/services/police-api/types.js';
import {
  boundaryBody,
  crimesBody,
  hang,
  jsonOk,
  locateBody,
  outcomesBody,
  overloaded,
  plainNotFound,
  status,
  stopsBody,
} from '../fixtures/police-api-upstream.js';
import { settle, useServiceHarness } from '../fixtures/service-harness.js';

const POINT: AreaSpec = { kind: 'point', lat: 52.63, lng: -1.13 };
const RING: AreaSpec = {
  kind: 'polygon',
  vertices: [
    { latitude: 52.63, longitude: -1.14 },
    { latitude: 52.64, longitude: -1.12 },
    { latitude: 52.6, longitude: -1.1 },
  ],
};
const FOUND: Lookup<LocatedNeighbourhood> = {
  kind: 'found',
  value: { force: 'leicestershire', neighbourhood: 'NX01' },
};
const MISS: Lookup<LocatedNeighbourhood> = { kind: 'miss' };

describe('AREA_INPUT_ALIASES', () => {
  it('maps the upstream and common coordinate spellings one to one', () => {
    expect(AREA_INPUT_ALIASES).toEqual({
      date: 'month',
      latitude: 'lat',
      longitude: 'lng',
      lon: 'lng',
      long: 'lng',
      poly: 'polygon',
    });
  });
});

describe('checkNamedForce', () => {
  const h = useServiceHarness();
  const check = (spec: AreaSpec) => settle(checkNamedForce(spec, h.service, h.ctx, h.budget()));

  it.each<[string, AreaSpec]>([
    ['point', POINT],
    ['polygon', RING],
    ['location', { kind: 'location', locationId: '1000001' }],
  ])('says none for %s, with no request', async (_name, spec) => {
    expect(await check(spec)).toEqual({ kind: 'none' });
    expect(h.upstream.calls).toHaveLength(0);
  });

  it.each(['neighbourhood', 'force_unplaced', 'force'] as const)(
    '%s resolves a listed force to the force object',
    async (kind) => {
      const spec: AreaSpec =
        kind === 'neighbourhood'
          ? { kind, force: 'leicestershire', neighbourhoodId: 'NX01' }
          : { kind, force: 'leicestershire' };
      expect(await check(spec)).toEqual({
        kind: 'ok',
        force: { id: 'leicestershire', name: 'Leicestershire Police' },
      });
    },
  );

  it.each(['neighbourhood', 'force_unplaced', 'force'] as const)(
    '%s rejects an unknown force by name',
    async (kind) => {
      const spec: AreaSpec =
        kind === 'neighbourhood'
          ? { kind, force: 'atlantis', neighbourhoodId: 'NX01' }
          : { kind, force: 'atlantis' };
      expect(await check(spec)).toEqual({
        kind: 'unknown',
        message: "No police force 'atlantis'.",
      });
    },
  );

  it.each(['force_unplaced', 'force'] as const)(
    '%s accepts btp (British Transport Police), without reading the force list',
    async (kind) => {
      expect(await check({ kind, force: 'btp' })).toEqual({
        kind: 'ok',
        force: { id: 'btp', name: 'British Transport Police' },
      });
      expect(h.upstream.count('/forces')).toBe(0);
    },
  );

  it('rejects btp on the neighbourhood arm with its own message', async () => {
    expect(await check({ kind: 'neighbourhood', force: 'btp', neighbourhoodId: 'NX01' })).toEqual({
      kind: 'unknown',
      message: 'British Transport Police has no neighbourhoods.',
    });
  });

  it('is case-sensitive about the force id (the schema lower-cases before it gets here)', async () => {
    expect((await check({ kind: 'force', force: 'Leicestershire' })).kind).toBe('unknown');
  });

  it('propagates a force-list failure', async () => {
    h.upstream.route('GET', '/forces', status(500));
    const error = await check({ kind: 'force', force: 'leicestershire' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
  });
});

describe('monthFailureMessage', () => {
  const h = useServiceHarness();

  it('names the latest published month for a month not published yet', async () => {
    const resolution = await settle(h.service.resolveMonth('2026-09', h.ctx, h.budget()));
    if (resolution.kind !== 'not_published') throw new Error(`got ${resolution.kind}`);
    expect(monthFailureMessage(resolution)).toBe(
      '2026-09 is not published yet; the latest published month is 2026-08.',
    );
  });

  it('names the earliest month served for a month before the window', async () => {
    const resolution = await settle(h.service.resolveMonth('2023-08', h.ctx, h.budget()));
    if (resolution.kind !== 'out_of_range') throw new Error(`got ${resolution.kind}`);
    expect(monthFailureMessage(resolution)).toBe(
      '2023-08 is before 2023-09, the earliest month data.police.uk still serves.',
    );
  });
});

describe('runAreaQuery', () => {
  const h = useServiceHarness();

  const crimes = (spec: AreaSpec, category = 'all-crime', ctx = h.ctx) =>
    settle(
      runAreaQuery(
        spec,
        (target) => crimesQuery(target, category, '2026-08'),
        h.service,
        ctx,
        h.budget(),
      ),
    );

  describe('point arm', () => {
    it('sends the area query and the locate together, and returns both', async () => {
      h.upstream.route('GET', '/crimes-street/all-crime', jsonOk(crimesBody()));
      h.upstream.route('GET', '/locate-neighbourhood', jsonOk(locateBody()));
      const run = await crimes(POINT);
      if (run.kind !== 'ok') throw new Error(`got ${run.kind}`);
      expect(run.records).toHaveLength(7);
      expect(run.target).toBe(POINT);
      expect(run.located).toEqual(FOUND);
      expect(h.upstream.callsTo('/locate-neighbourhood')[0]?.query.get('q')).toBe(
        '52.630000,-1.130000',
      );
      const [first, second] = h.upstream.calls;
      expect(first?.at).toBe(second?.at);
    });

    it('starts the locate before the area answer comes back (parallel, not sequential)', async () => {
      h.upstream.route('GET', '/crimes-street/all-crime', async (request) => {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        return jsonOk(crimesBody())(request);
      });
      h.upstream.route('GET', '/locate-neighbourhood', jsonOk(locateBody()));
      const run = await crimes(POINT);
      expect(run.kind).toBe('ok');
      const locate = h.upstream.callsTo('/locate-neighbourhood')[0];
      const area = h.upstream.callsTo('/crimes-street/all-crime')[0];
      expect(locate?.at).toBe(area?.at);
    });

    it('carries a locate miss (outside coverage) as located: miss', async () => {
      h.upstream.route('GET', '/crimes-street/all-crime', jsonOk([]));
      h.upstream.route('GET', '/locate-neighbourhood', plainNotFound);
      const run = await crimes(POINT);
      if (run.kind !== 'ok') throw new Error(`got ${run.kind}`);
      expect(run.located).toEqual(MISS);
      expect(run.records).toEqual([]);
    });

    it('degrades quietly when the locate fails: ok without located, one warning logged', async () => {
      h.upstream.route('GET', '/crimes-street/all-crime', jsonOk(crimesBody()));
      h.upstream.route('GET', '/locate-neighbourhood', status(500));
      const run = await crimes(POINT);
      if (run.kind !== 'ok') throw new Error(`got ${run.kind}`);
      expect(run).not.toHaveProperty('located');
      expect(run.records).toHaveLength(7);
      const warnings = (h.ctx.log as MockContextLogger).calls.filter(
        (call) => call.level === 'warning',
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.msg).toBe('Point lookup failed; searching without the located force');
      expect(warnings[0]?.data).toMatchObject({ error: expect.any(String) });
    });

    it.each<[string, () => void]>([
      [
        'a malformed body',
        () => h.upstream.route('GET', '/locate-neighbourhood', jsonOk({ force: 1 })),
      ],
      ['a hung request', () => h.upstream.route('GET', '/locate-neighbourhood', hang)],
      [
        'a 429',
        () =>
          h.upstream.route(
            'GET',
            '/locate-neighbourhood',
            () => new Response(null, { status: 429 }),
          ),
      ],
    ])('degrades the same way for %s', async (_name, arrange) => {
      h.upstream.route('GET', '/crimes-street/all-crime', jsonOk(crimesBody()));
      arrange();
      const run = await crimes(POINT);
      if (run.kind !== 'ok') throw new Error(`got ${run.kind}`);
      expect(run).not.toHaveProperty('located');
      expect(run.records).toHaveLength(7);
    });

    it('rethrows a locate failure when the call was cancelled while the locate was in flight', async () => {
      const controller = new AbortController();
      const ctx = h.ctxWith(controller.signal);
      h.upstream.route('GET', '/crimes-street/all-crime', jsonOk(crimesBody()));
      h.upstream.route('GET', '/locate-neighbourhood', hang);
      // The area query has long since answered when the caller cancels.
      setTimeout(() => controller.abort(), 1000);
      const error = await crimes(POINT, 'all-crime', ctx).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toHaveProperty('kind');
      expect(ctx.signal.aborted).toBe(true);
      expect(h.upstream.count('/crimes-street/all-crime')).toBe(1);
      const degraded = (ctx.log as MockContextLogger).calls.some(
        (call) => call.msg === 'Point lookup failed; searching without the located force',
      );
      expect(degraded).toBe(false);
    });

    it('still raises an area failure when the locate would have succeeded', async () => {
      h.upstream.route('GET', '/crimes-street/all-crime', status(500));
      h.upstream.route('GET', '/locate-neighbourhood', jsonOk(locateBody()));
      const error = await crimes(POINT).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(McpError);
      expect((error as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    });

    it('lets a 503 area refusal through as area_too_large with the builder’s hint', async () => {
      h.upstream.route('GET', '/crimes-street/all-crime', overloaded);
      h.upstream.route('GET', '/locate-neighbourhood', jsonOk(locateBody()));
      const error = await settle(
        runAreaQuery(
          POINT,
          (target) => ({
            ...crimesQuery(target, 'all-crime', '2026-08'),
            tooLargeHint: 'Use a ring.',
          }),
          h.service,
          h.ctx,
          h.budget(),
        ),
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(McpError);
      expect((error as McpError).data).toMatchObject({
        reason: 'area_too_large',
        recovery: { hint: 'Use a ring.' },
      });
    });
  });

  describe('arms without a locate', () => {
    it('never calls /locate-neighbourhood for a polygon', async () => {
      h.upstream.route('POST', '/crimes-street/all-crime', jsonOk(crimesBody()));
      const run = await crimes(RING);
      if (run.kind !== 'ok') throw new Error(`got ${run.kind}`);
      expect(run).not.toHaveProperty('located');
      expect(h.upstream.count('/locate-neighbourhood')).toBe(0);
    });

    it('never calls /locate-neighbourhood for a location or a force arm', async () => {
      h.upstream.route('GET', '/crimes-at-location', jsonOk(crimesBody()));
      h.upstream.route('GET', '/crimes-no-location', jsonOk([]));
      await crimes({ kind: 'location', locationId: '1000001' });
      await crimes({ kind: 'force_unplaced', force: 'leicestershire' });
      expect(h.upstream.count('/locate-neighbourhood')).toBe(0);
    });
  });

  describe('neighbourhood arm', () => {
    const NEIGHBOURHOOD: AreaSpec = {
      kind: 'neighbourhood',
      force: 'leicestershire',
      neighbourhoodId: 'NX01',
    };

    it('resolves the boundary, then POSTs it as a polygon; the target is that polygon', async () => {
      h.upstream.route('GET', '/leicestershire/NX01/boundary', jsonOk(boundaryBody()));
      h.upstream.route('POST', '/crimes-street/all-crime', jsonOk(crimesBody()));
      const run = await crimes(NEIGHBOURHOOD);
      if (run.kind !== 'ok') throw new Error(`got ${run.kind}`);
      expect(run.target.kind).toBe('polygon');
      if (run.target.kind === 'polygon') expect(run.target.vertices).toHaveLength(5);
      expect(h.upstream.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
        'GET /leicestershire/NX01/boundary',
        'POST /crimes-street/all-crime',
      ]);
      expect(new URLSearchParams(h.upstream.calls[1]?.body).get('poly')).toBe(
        '52.630000,-1.140000:52.630000,-1.120000:52.640000,-1.120000:52.640000,-1.140000:52.630000,-1.140000',
      );
    });

    it('returns unknown_neighbourhood on a boundary 404, without sending the area query', async () => {
      h.upstream.route('GET', '/leicestershire/NX01/boundary', plainNotFound);
      expect(await crimes(NEIGHBOURHOOD)).toEqual({ kind: 'unknown_neighbourhood' });
      expect(h.upstream.calls.map((c) => c.path)).toEqual(['/leicestershire/NX01/boundary']);
    });

    it('does not turn a boundary 500 into a miss', async () => {
      h.upstream.route('GET', '/leicestershire/NX01/boundary', status(500));
      const error = await crimes(NEIGHBOURHOOD).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(McpError);
    });
  });

  describe('misses', () => {
    it('maps a 404 on crimes-at-location to unknown_location', async () => {
      h.upstream.route('GET', '/crimes-at-location', plainNotFound);
      expect(await crimes({ kind: 'location', locationId: '999' })).toEqual({
        kind: 'unknown_location',
      });
    });

    it('maps a 404 on outcomes-at-location to unknown_location', async () => {
      h.upstream.route('GET', '/outcomes-at-location', plainNotFound);
      const run = await settle(
        runAreaQuery(
          { kind: 'location', locationId: '999' },
          (target) => outcomesQuery(target as Place, '2026-08'),
          h.service,
          h.ctx,
          h.budget(),
        ),
      );
      expect(run).toEqual({ kind: 'unknown_location' });
    });

    it('does not read a 404 on stops-at-location as a miss (that route answers [] for an unknown id)', async () => {
      h.upstream.route('GET', '/stops-at-location', plainNotFound);
      const error = await settle(
        runAreaQuery(
          { kind: 'location', locationId: '999' },
          (target) => stopsQuery(target, '2026-08'),
          h.service,
          h.ctx,
          h.budget(),
        ),
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(McpError);
      expect((error as McpError).code).toBe(JsonRpcErrorCode.NotFound);
    });

    it('returns ok with no records for a location that answers []', async () => {
      h.upstream.route('GET', '/stops-at-location', jsonOk([]));
      const run = await settle(
        runAreaQuery(
          { kind: 'location', locationId: '999' },
          (target) => stopsQuery(target, '2026-08'),
          h.service,
          h.ctx,
          h.budget(),
        ),
      );
      expect(run).toMatchObject({ kind: 'ok', records: [] });
    });
  });

  describe('records', () => {
    it('shares the cached array between runs (read-only, never re-fetched)', async () => {
      h.upstream.route('GET', '/crimes-at-location', jsonOk(crimesBody()));
      const spec: AreaSpec = { kind: 'location', locationId: '1000001' };
      const first = await crimes(spec);
      const second = await crimes(spec);
      if (first.kind !== 'ok' || second.kind !== 'ok') throw new Error('expected ok');
      expect(second.records).toBe(first.records);
      expect(h.upstream.count('/crimes-at-location')).toBe(1);
    });

    it('returns the target for a force arm', async () => {
      h.upstream.route('GET', '/stops-force', jsonOk(stopsBody()));
      const run = await settle(
        runAreaQuery(
          { kind: 'force', force: 'leicestershire' },
          (target) => stopsQuery(target, '2026-08'),
          h.service,
          h.ctx,
          h.budget(),
        ),
      );
      expect(run).toMatchObject({ kind: 'ok', target: { kind: 'force', force: 'leicestershire' } });
    });

    it('returns normalized outcome records for the outcomes route', async () => {
      h.upstream.route('GET', '/outcomes-at-location', jsonOk(outcomesBody()));
      h.upstream.route('GET', '/locate-neighbourhood', jsonOk(locateBody()));
      const run = await settle(
        runAreaQuery(
          POINT,
          (target) => outcomesQuery(target as Place, '2026-08'),
          h.service,
          h.ctx,
          h.budget(),
        ),
      );
      if (run.kind !== 'ok') throw new Error(`got ${run.kind}`);
      expect(run.records.map((r) => r.crime.id)).toEqual(['100000080', '100000082', '100000081']);
      expect(run.located).toEqual(FOUND);
    });
  });
});

describe('searchedForceId', () => {
  it('prefers the force the arm named', () => {
    expect(
      searchedForceId(
        { kind: 'ok', force: { id: 'btp', name: 'British Transport Police' } },
        FOUND,
      ),
    ).toBe('btp');
  });

  it('falls back to the located force', () => {
    expect(searchedForceId({ kind: 'none' }, FOUND)).toBe('leicestershire');
  });

  it.each<[string, Lookup<LocatedNeighbourhood> | undefined]>([
    ['a locate miss', MISS],
    ['no locate', undefined],
  ])('is undefined for none and %s', (_name, located) => {
    expect(searchedForceId({ kind: 'none' }, located)).toBeUndefined();
  });

  it('is undefined for an unknown named force', () => {
    expect(searchedForceId({ kind: 'unknown', message: 'x' }, undefined)).toBeUndefined();
  });
});

describe('areaEcho', () => {
  it('echoes a point with the located force and neighbourhood when found', () => {
    expect(areaEcho(POINT, POINT as Place, FOUND)).toEqual({
      type: 'point',
      lat: 52.63,
      lng: -1.13,
      located_force: 'leicestershire',
      located_neighbourhood: 'NX01',
    });
  });

  it.each<[string, Lookup<LocatedNeighbourhood> | undefined]>([
    ['a locate miss', MISS],
    ['no locate', undefined],
  ])('echoes a point without located fields for %s', (_name, located) => {
    expect(areaEcho(POINT, POINT as Place, located)).toEqual({
      type: 'point',
      lat: 52.63,
      lng: -1.13,
    });
  });

  it('echoes a polygon by vertex count (as given, the ring not closed)', () => {
    expect(areaEcho(RING, RING as Place, undefined)).toEqual({ type: 'polygon', vertex_count: 3 });
  });

  it('echoes a location by id', () => {
    const spec: AreaSpec = { kind: 'location', locationId: '1000001' };
    expect(areaEcho(spec, spec as Place, undefined)).toEqual({
      type: 'location',
      location_id: '1000001',
    });
  });

  it('echoes a neighbourhood with the boundary polygon size searched', () => {
    const spec: AreaSpec = {
      kind: 'neighbourhood',
      force: 'leicestershire',
      neighbourhoodId: 'NX01',
    };
    const target = {
      kind: 'polygon',
      vertices: boundaryBody().map(() => ({ latitude: 1, longitude: 2 })),
    } as const;
    expect(areaEcho(spec, target, undefined)).toEqual({
      type: 'neighbourhood',
      force: 'leicestershire',
      neighbourhood_id: 'NX01',
      vertex_count: 5,
    });
  });

  it.each(['force_unplaced', 'force'] as const)('echoes %s by force alone', (kind) => {
    expect(areaEcho({ kind, force: 'btp' }, { kind: 'force', force: 'btp' }, undefined)).toEqual({
      type: kind,
      force: 'btp',
    });
  });
});

describe('breakdown', () => {
  it('counts by value, most first, then by value in code-unit order', () => {
    expect(breakdown(['b', 'a', 'b', 'C', 'a', 'z', 'b'], (value) => value)).toEqual([
      { value: 'b', count: 3 },
      { value: 'a', count: 2 },
      { value: 'C', count: 1 },
      { value: 'z', count: 1 },
    ]);
  });

  it('buckets absent values under (not recorded)', () => {
    expect(NOT_RECORDED).toBe('(not recorded)');
    expect(
      breakdown([{ v: 'x' }, { v: undefined }, { v: undefined }], (record) => record.v),
    ).toEqual([
      { value: '(not recorded)', count: 2 },
      { value: 'x', count: 1 },
    ]);
  });

  it('keeps an empty-string value as its own bucket (only undefined is absent)', () => {
    expect(breakdown(['', undefined], (value) => value)).toEqual([
      { value: '', count: 1 },
      { value: '(not recorded)', count: 1 },
    ]);
  });

  it('breaks count ties by value with punctuation before letters', () => {
    expect(breakdown(['a', undefined], (value) => value).map((row) => row.value)).toEqual([
      '(not recorded)',
      'a',
    ]);
  });

  it('is empty for no records and never mutates its input', () => {
    expect(breakdown([], () => 'x')).toEqual([]);
    const records = Object.freeze(['b', 'a']);
    expect(() => breakdown(records, (value) => value)).not.toThrow();
  });
});

describe('pageOf', () => {
  const rows = [1, 2, 3, 4, 5];

  it('returns the first page with next_offset when rows remain', () => {
    expect(pageOf(rows, 0, 2)).toEqual({ rows: [1, 2], nextOffset: 2 });
  });

  it('returns a middle page', () => {
    expect(pageOf(rows, 2, 2)).toEqual({ rows: [3, 4], nextOffset: 4 });
  });

  it('returns the last partial page with no next_offset key', () => {
    const page = pageOf(rows, 4, 2);
    expect(page).toEqual({ rows: [5] });
    expect(page).not.toHaveProperty('nextOffset');
  });

  it('has no next_offset when the page ends exactly at the end', () => {
    const page = pageOf(rows, 3, 2);
    expect(page.rows).toEqual([4, 5]);
    expect(page).not.toHaveProperty('nextOffset');
  });

  it('has no next_offset when the limit covers everything', () => {
    expect(pageOf(rows, 0, 200)).toEqual({ rows });
  });

  it.each([5, 6, 1000])(
    'returns no rows and no next_offset for offset %i at or past the end',
    (offset) => {
      const page = pageOf(rows, offset, 2);
      expect(page.rows).toEqual([]);
      expect(page).not.toHaveProperty('nextOffset');
    },
  );

  it('handles an empty list', () => {
    expect(pageOf([], 0, 50)).toEqual({ rows: [] });
  });

  it('returns a new array, so the cached records are never aliased by a page', () => {
    const page = pageOf(rows, 0, 5);
    expect(page.rows).not.toBe(rows);
  });

  it('walks every row exactly once following next_offset', () => {
    const seen: number[] = [];
    let offset: number | undefined = 0;
    while (offset !== undefined) {
      const page: ReturnType<typeof pageOf<number>> = pageOf(rows, offset, 2);
      seen.push(...page.rows);
      offset = page.nextOffset;
    }
    expect(seen).toEqual(rows);
  });
});

describe('notice fragments', () => {
  describe('monthDefaultedNote', () => {
    it('names the month searched', () => {
      expect(monthDefaultedNote('2026-08')).toBe(
        'No month given; searched 2026-08, the latest published month.',
      );
    });
  });

  describe('outsideCoverageNote', () => {
    const OUTSIDE_POINT =
      'This point is outside data.police.uk coverage (England, Wales and Northern Ireland; Scotland only through British Transport Police); check that lat and lng are not swapped.';
    const OUTSIDE_POLYGON =
      'This polygon lies outside data.police.uk coverage; each vertex is {lat, lng}, so check the two were not swapped.';
    const ring = (...points: Array<[number, number]>): AreaSpec => ({
      kind: 'polygon',
      vertices: points.map(([latitude, longitude]) => ({ latitude, longitude })),
    });

    it('flags a point whose locate answered 404', () => {
      expect(outsideCoverageNote(POINT, MISS)).toBe(OUTSIDE_POINT);
    });

    it.each<[string, Lookup<LocatedNeighbourhood> | undefined]>([
      ['found', FOUND],
      ['unknown (the locate failed)', undefined],
    ])('does not flag a point whose locate is %s', (_name, located) => {
      expect(outsideCoverageNote(POINT, located)).toBeUndefined();
    });

    it('flags a polygon with every vertex outside the coverage box', () => {
      expect(
        outsideCoverageNote(ring([48.85, 2.35], [48.86, 2.36], [48.84, 2.34]), undefined),
      ).toBe(OUTSIDE_POLYGON);
    });

    it('flags a polygon with swapped coordinates (lat in the longitude slot)', () => {
      expect(
        outsideCoverageNote(ring([-1.14, 52.63], [-1.12, 52.64], [-1.13, 52.6]), undefined),
      ).toBe(OUTSIDE_POLYGON);
    });

    it('does not flag a polygon with one vertex inside the box', () => {
      expect(
        outsideCoverageNote(ring([48.85, 2.35], [52.63, -1.13], [48.84, 2.34]), undefined),
      ).toBeUndefined();
    });

    it.each<[string, [number, number]]>([
      ['south-west corner', [49.8, -8.7]],
      ['north-east corner', [61.0, 2.0]],
      ['south-east corner', [49.8, 2.0]],
      ['north-west corner', [61.0, -8.7]],
    ])('treats the %s of the box as inside', (_name, point) => {
      expect(outsideCoverageNote(ring(point, point, point), undefined)).toBeUndefined();
    });

    it.each<[string, [number, number]]>([
      ['just south', [49.79, -1]],
      ['just north', [61.01, -1]],
      ['just west', [52, -8.71]],
      ['just east', [52, 2.01]],
    ])('treats a point %s of the box as outside', (_name, point) => {
      expect(outsideCoverageNote(ring(point, point, point), undefined)).toBe(OUTSIDE_POLYGON);
    });

    it('ignores the locate result for a polygon and the polygon for a point', () => {
      expect(outsideCoverageNote(ring([48.85, 2.35]), FOUND)).toBe(OUTSIDE_POLYGON);
      expect(outsideCoverageNote(POINT, MISS)).toBe(OUTSIDE_POINT);
    });

    it.each<[string, AreaSpec]>([
      ['location', { kind: 'location', locationId: '1' }],
      [
        'neighbourhood',
        { kind: 'neighbourhood', force: 'leicestershire', neighbourhoodId: 'NX01' },
      ],
      ['force_unplaced', { kind: 'force_unplaced', force: 'leicestershire' }],
      ['force', { kind: 'force', force: 'leicestershire' }],
    ])('has nothing to say about a %s', (_name, spec) => {
      expect(outsideCoverageNote(spec, MISS)).toBeUndefined();
    });
  });

  describe('pagingNote', () => {
    it('describes the range shown and where the next page starts', () => {
      expect(pagingNote('crimes', 0, { rows: new Array(50), nextOffset: 50 }, 120)).toBe(
        'Showing 1–50 of 120; call again with offset 50 for more.',
      );
      expect(pagingNote('stops', 50, { rows: new Array(50), nextOffset: 100 }, 120)).toBe(
        'Showing 51–100 of 120; call again with offset 100 for more.',
      );
    });

    it('has nothing to say for a complete or last page', () => {
      expect(pagingNote('crimes', 0, { rows: new Array(5) }, 5)).toBeUndefined();
      expect(pagingNote('crimes', 100, { rows: new Array(20) }, 120)).toBeUndefined();
    });

    it.each([7, 8, 500])('flags offset %i at or past the 7 results', (offset) => {
      expect(pagingNote('crimes', offset, { rows: [] }, 7)).toBe(
        `offset ${offset} is past the last of 7 crimes; omit offset to start from the first.`,
      );
    });

    it('names the noun it is given', () => {
      expect(pagingNote('stops', 9, { rows: [] }, 3)).toBe(
        'offset 9 is past the last of 3 stops; omit offset to start from the first.',
      );
    });

    it('stays silent for an empty result, whatever the offset', () => {
      expect(pagingNote('crimes', 0, { rows: [] }, 0)).toBeUndefined();
      expect(pagingNote('crimes', 10, { rows: [] }, 0)).toBeUndefined();
    });
  });
});
