/**
 * @fileoverview The plumbing the area search tools share: the named-force check
 * (by id or display name, handing on the matched id; `btp` only on the force
 * arms), month-failure wording, `runAreaQuery`'s miss values and the forces it
 * finds — a point and a polygon's sample points located beside the query (at
 * most two sample lookups outstanding, so the query keeps a pacer slot), a
 * location's map point after it, every lookup given up after 10 s and each
 * degrading quietly unless the call was cancelled — breakdowns, paging, the
 * area echo, and the notice fragments (the partial-locate one included).
 * @module tests/tools/area-search.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import type { MockContextLogger } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import {
  AREA_INPUT_ALIASES,
  type AreaForces,
  areaEcho,
  breakdown,
  checkNamedForce,
  monthDefaultedNote,
  monthFailureMessage,
  NOT_RECORDED,
  outsideCoverageNote,
  pageOf,
  pagingNote,
  partialLocateNote,
  runAreaQuery,
  samplePoints,
} from '@/mcp-server/tools/area-search.js';
import {
  type AreaSpec,
  crimesQuery,
  outcomesQuery,
  stopsQuery,
} from '@/services/police-api/area.js';
import type {
  CrimeRecord,
  LocatedNeighbourhood,
  Lookup,
  MapPoint,
  OutcomeRecord,
  Place,
  StopRecord,
} from '@/services/police-api/types.js';
import {
  boundaryBody,
  crimeRecord,
  crimesBody,
  hang,
  jsonOk,
  locateBody,
  locateBy,
  outcomesBody,
  overloaded,
  plainNotFound,
  type Responder,
  STRADDLE_RING,
  STRADDLE_SAMPLES,
  status,
  stopsBody,
} from '../fixtures/police-api-upstream.js';
import { settle, untilReal, useServiceHarness } from '../fixtures/service-harness.js';

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

/** Each search's map-point reader, as the tools pass it. */
const crimePoint = (crime: CrimeRecord): MapPoint | undefined => crime.location?.map_point;
const outcomePoint = (outcome: OutcomeRecord): MapPoint | undefined =>
  outcome.crime.location?.map_point;
const stopPoint = (stop: StopRecord): MapPoint | undefined => stop.location?.map_point;

/** A polygon spec from `[lat, lng]` pairs. */
const polygonOf = (...points: Array<readonly [number, number]>): AreaSpec => ({
  kind: 'polygon',
  vertices: points.map(([latitude, longitude]) => ({ latitude, longitude })),
});
const STRADDLE: AreaSpec = polygonOf(...STRADDLE_RING.map(({ lat, lng }) => [lat, lng] as const));

/** What a run that located nothing carries, for the echo and note helpers. */
const NONE: AreaForces = { forces: [] };

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
  ])('says none for %s, with no request, and keeps the area as it is', async (_name, spec) => {
    expect(await check(spec)).toEqual({ kind: 'none', spec });
    expect(h.upstream.calls).toHaveLength(0);
  });

  const named = (kind: 'neighbourhood' | 'force_unplaced' | 'force', force: string): AreaSpec =>
    kind === 'neighbourhood' ? { kind, force, neighbourhoodId: 'NX01' } : { kind, force };

  it.each(['neighbourhood', 'force_unplaced', 'force'] as const)(
    '%s resolves a listed force to the force object',
    async (kind) => {
      expect(await check(named(kind, 'leicestershire'))).toEqual({
        kind: 'ok',
        force: { id: 'leicestershire', name: 'Leicestershire Police' },
        spec: named(kind, 'leicestershire'),
      });
    },
  );

  it.each(['neighbourhood', 'force_unplaced', 'force'] as const)(
    '%s matches a display name and puts the matched id in the area it hands on',
    async (kind) => {
      // The schema folds 'Devon & Cornwall Police' to this before the check.
      expect(await check(named(kind, 'devon-and-cornwall-police'))).toEqual({
        kind: 'ok',
        force: { id: 'devon-and-cornwall', name: 'Devon & Cornwall Police' },
        spec: named(kind, 'devon-and-cornwall'),
      });
    },
  );

  it.each(['force_unplaced', 'force'] as const)(
    '%s matches British Transport Police to btp',
    async (kind) => {
      expect(await check({ kind, force: 'british-transport-police' })).toEqual({
        kind: 'ok',
        force: { id: 'btp', name: 'British Transport Police' },
        spec: { kind, force: 'btp' },
      });
    },
  );

  it('refuses British Transport Police on the neighbourhood arm with the btp message', async () => {
    expect(await check(named('neighbourhood', 'british-transport-police'))).toEqual({
      kind: 'unknown',
      message: 'British Transport Police has no neighbourhoods.',
    });
  });

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
        spec: { kind, force: 'btp' },
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

  it('matches case-insensitively, whether or not the schema folded the value first', async () => {
    expect(await check({ kind: 'force', force: 'Leicestershire Police' })).toMatchObject({
      kind: 'ok',
      spec: { kind: 'force', force: 'leicestershire' },
    });
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

  /** Starts the query without moving the virtual clock; {@link crimes} also drives it to completion. */
  const startCrimes = (spec: AreaSpec, category = 'all-crime', ctx = h.ctx) =>
    runAreaQuery(
      spec,
      (target) => crimesQuery(target, category, '2026-08'),
      crimePoint,
      h.service,
      ctx,
      h.budget(),
    );
  const crimes = (spec: AreaSpec, category = 'all-crime', ctx = h.ctx) =>
    settle(startCrimes(spec, category, ctx));

  describe('point arm', () => {
    it('sends the area query and the locate together, and returns both', async () => {
      // Both answers wait until both requests are out, so neither request can wait on the other's answer.
      let release = () => {};
      const answered = new Promise<void>((resolve) => {
        release = resolve;
      });
      const held =
        (respond: Responder): Responder =>
        async (request) => {
          await answered;
          return respond(request);
        };
      h.upstream.route('GET', '/crimes-street/all-crime', held(jsonOk(crimesBody())));
      h.upstream.route('GET', '/locate-neighbourhood', held(jsonOk(locateBody())));
      const pending = startCrimes(POINT);
      await untilReal(() => h.upstream.calls.length === 2);
      release();
      const run = await settle(pending);
      if (run.kind !== 'ok') throw new Error(`got ${run.kind}`);
      expect(run.records).toHaveLength(7);
      expect(run.target).toBe(POINT);
      expect(run.located).toEqual(FOUND);
      expect(run.forces).toEqual(['leicestershire']);
      expect(run).not.toHaveProperty('samples');
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
      const pending = startCrimes(POINT);
      await untilReal(() => h.upstream.calls.length === 2);
      const run = await settle(pending);
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
      expect(run.forces).toEqual([]);
      expect(run.records).toEqual([]);
    });

    it('degrades quietly when the locate fails: ok without located, one warning logged', async () => {
      h.upstream.route('GET', '/crimes-street/all-crime', jsonOk(crimesBody()));
      h.upstream.route('GET', '/locate-neighbourhood', status(500));
      const run = await crimes(POINT);
      if (run.kind !== 'ok') throw new Error(`got ${run.kind}`);
      expect(run).not.toHaveProperty('located');
      expect(run.forces).toEqual([]);
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

    it('gives up on a hung locate at 10 s, so an answered point search waits no longer', async () => {
      h.upstream.route('GET', '/crimes-street/all-crime', jsonOk(crimesBody()));
      h.upstream.route('GET', '/locate-neighbourhood', hang);
      const start = Date.now();
      const run = await crimes(POINT);
      if (run.kind !== 'ok') throw new Error(`got ${run.kind}`);
      expect(run).not.toHaveProperty('located');
      expect(run.records).toHaveLength(7);
      expect(Date.now() - start).toBeLessThanOrEqual(10_500);
    });

    it('waits out no Retry-After for a locate: a 429 asking for 5 s degrades after one request', async () => {
      h.upstream.route('GET', '/crimes-street/all-crime', jsonOk(crimesBody()));
      h.upstream.route('GET', '/locate-neighbourhood', status(429, '5'));
      const run = await crimes(POINT);
      if (run.kind !== 'ok') throw new Error(`got ${run.kind}`);
      expect(run).not.toHaveProperty('located');
      expect(run.records).toHaveLength(7);
      expect(h.upstream.count('/locate-neighbourhood')).toBe(1);
    });

    it('rethrows a locate failure when the call was cancelled while the locate was in flight', async () => {
      const controller = new AbortController();
      const ctx = h.ctxWith(controller.signal);
      h.upstream.route('GET', '/crimes-street/all-crime', jsonOk(crimesBody()));
      h.upstream.route('GET', '/locate-neighbourhood', hang);
      const pending = startCrimes(POINT, 'all-crime', ctx);
      await untilReal(() => h.upstream.calls.length === 2);
      // The area query has long since answered when the caller cancels.
      setTimeout(() => controller.abort(), 1000);
      const error = await settle(pending).catch((e: unknown) => e);
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
          crimePoint,
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

  describe('polygon arm', () => {
    /** The straddle ring's sample answers: Greater Manchester to the north, Cheshire to the south. */
    const straddleAnswers = (overrides: Record<string, string | Responder> = {}) =>
      locateBy({
        [STRADDLE_SAMPLES.centre]: 'cheshire',
        [STRADDLE_SAMPLES.north]: 'greater-manchester',
        [STRADDLE_SAMPLES.south]: 'cheshire',
        [STRADDLE_SAMPLES.east]: 'greater-manchester',
        ...overrides,
      });

    it('locates the sample points beside the area query and returns their distinct forces, sorted', async () => {
      h.upstream.route('POST', '/crimes-street/all-crime', jsonOk(crimesBody()));
      h.upstream.route('GET', '/locate-neighbourhood', straddleAnswers());
      const run = await crimes(STRADDLE);
      if (run.kind !== 'ok') throw new Error(`got ${run.kind}`);
      expect(run.forces).toEqual(['cheshire', 'greater-manchester']);
      expect(run.samples?.map((lookup) => lookup?.kind === 'found' && lookup.value.force)).toEqual([
        'cheshire',
        'greater-manchester',
        'cheshire',
        'greater-manchester',
      ]);
      expect(run).not.toHaveProperty('located');
      const locates = h.upstream.callsTo('/locate-neighbourhood');
      expect(locates.map((call) => call.query.get('q'))).toEqual([
        STRADDLE_SAMPLES.centre,
        STRADDLE_SAMPLES.north,
        STRADDLE_SAMPLES.south,
        STRADDLE_SAMPLES.east,
      ]);
      const [area] = h.upstream.callsTo('/crimes-street/all-crime');
      expect(locates.every((call) => call.at === area?.at)).toBe(true);
    });

    it('keeps at most two sample lookups queued or in flight, leaving the area query a pacer slot', async () => {
      // A pentagon whose centre and four extreme vertices are five distinct points.
      const pentagon = polygonOf(
        [53.4, -2.3],
        [53.38, -2.24],
        [53.34, -2.26],
        [53.34, -2.34],
        [53.38, -2.36],
      );
      expect(samplePoints(pentagon.kind === 'polygon' ? pentagon.vertices : [])).toHaveLength(5);
      h.upstream.route('POST', '/crimes-street/all-crime', jsonOk([]));
      h.upstream.route('GET', '/locate-neighbourhood', async (request) => {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return jsonOk(locateBody())(request);
      });
      let outstanding = 0;
      let most = 0;
      const locate = h.service.locate.bind(h.service);
      vi.spyOn(h.service, 'locate').mockImplementation(async (...args) => {
        outstanding += 1;
        most = Math.max(most, outstanding);
        try {
          return await locate(...args);
        } finally {
          outstanding -= 1;
        }
      });
      const run = await crimes(pentagon);
      if (run.kind !== 'ok') throw new Error(`got ${run.kind}`);
      expect(run.samples).toHaveLength(5);
      expect(h.upstream.count('/locate-neighbourhood')).toBe(5);
      expect(most).toBe(2);
    });

    it('logs the samples left unsent when the 10 s for lookups ran out as skipped, not as a spent call budget', async () => {
      const pentagon = polygonOf(
        [53.4, -2.3],
        [53.38, -2.24],
        [53.34, -2.26],
        [53.34, -2.34],
        [53.38, -2.36],
      );
      h.upstream.route('POST', '/crimes-street/all-crime', jsonOk([]));
      h.upstream.route('GET', '/locate-neighbourhood', hang);
      const run = await crimes(pentagon);
      if (run.kind !== 'ok') throw new Error(`got ${run.kind}`);
      expect(run.samples).toEqual([undefined, undefined, undefined, undefined, undefined]);
      expect(h.upstream.count('/locate-neighbourhood')).toBe(2);
      const warnings = (h.ctx.log as MockContextLogger).calls.filter((c) => c.level === 'warning');
      expect(warnings.map((c) => c.msg).sort()).toEqual([
        'Point lookup failed; searching without the located force',
        'Point lookup failed; searching without the located force',
        'Point lookup skipped: the time allowed for lookups ran out before it was sent; searching without the located force',
        'Point lookup skipped: the time allowed for lookups ran out before it was sent; searching without the located force',
        'Point lookup skipped: the time allowed for lookups ran out before it was sent; searching without the located force',
      ]);
      expect(JSON.stringify(warnings)).not.toContain('50-second budget');
    });

    it('sends the area query and answers when every sample lookup hangs, never shedding it behind its own lookups', async () => {
      h.upstream.route('POST', '/crimes-street/all-crime', jsonOk(crimesBody()));
      h.upstream.route('GET', '/locate-neighbourhood', hang);
      const run = await crimes(STRADDLE);
      if (run.kind !== 'ok') throw new Error(`got ${run.kind}`);
      expect(run.records).toHaveLength(7);
      expect(run.forces).toEqual([]);
      expect(run.samples).toEqual([undefined, undefined, undefined, undefined]);
      expect(h.upstream.count('/crimes-street/all-crime')).toBe(1);
    });

    it('gives up on hung sample lookups at 10 s, so an answered polygon search waits no longer', async () => {
      h.upstream.route('POST', '/crimes-street/all-crime', jsonOk([]));
      h.upstream.route(
        'GET',
        '/locate-neighbourhood',
        straddleAnswers({ [STRADDLE_SAMPLES.north]: hang, [STRADDLE_SAMPLES.east]: hang }),
      );
      const start = Date.now();
      const run = await crimes(STRADDLE);
      if (run.kind !== 'ok') throw new Error(`got ${run.kind}`);
      expect(run.forces).toEqual(['cheshire']);
      expect(Date.now() - start).toBeLessThanOrEqual(10_500);
    });

    it('gives the area query a slot when every sample hangs and the area answers late: the lookups end at 10 s, the search when the area answers', async () => {
      h.upstream.route('POST', '/crimes-street/all-crime', async (request) => {
        await new Promise((resolve) => setTimeout(resolve, 15_000));
        return jsonOk(crimesBody())(request);
      });
      h.upstream.route('GET', '/locate-neighbourhood', hang);
      const start = Date.now();
      const run = await crimes(STRADDLE);
      if (run.kind !== 'ok') throw new Error(`got ${run.kind}`);
      expect(run.records).toHaveLength(7);
      expect(Date.now() - start).toBeGreaterThanOrEqual(15_000);
      expect(Date.now() - start).toBeLessThanOrEqual(15_500);
    });

    it('fails an area query answering 500 as upstream_unavailable while every sample lookup hangs, never as pacer_shed', async () => {
      h.upstream.route('POST', '/crimes-street/all-crime', status(500));
      h.upstream.route('GET', '/locate-neighbourhood', hang);
      const start = Date.now();
      const error = await crimes(STRADDLE).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(McpError);
      expect((error as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect((error as McpError).data).toMatchObject({
        reason: 'upstream_unavailable',
        retryable: true,
      });
      // Every attempt and retry went out while the two hung lookups still held their slots.
      const attempts = h.upstream.callsTo('/crimes-street/all-crime');
      expect(attempts).toHaveLength(3);
      expect(attempts.every((attempt) => attempt.at - start < 10_000)).toBe(true);
      expect(h.upstream.count('/locate-neighbourhood')).toBe(2);
    });

    it('sends no lookup for a polygon with no vertex in the coverage box', async () => {
      h.upstream.route('POST', '/crimes-street/all-crime', jsonOk([]));
      const run = await crimes(polygonOf([48.85, 2.35], [48.86, 2.36], [48.84, 2.34]));
      if (run.kind !== 'ok') throw new Error(`got ${run.kind}`);
      expect(run.samples).toEqual([]);
      expect(run.forces).toEqual([]);
      expect(h.upstream.count('/locate-neighbourhood')).toBe(0);
    });

    it('carries every 404 as a miss and locates no force', async () => {
      h.upstream.route('POST', '/crimes-street/all-crime', jsonOk([]));
      h.upstream.route('GET', '/locate-neighbourhood', plainNotFound);
      const run = await crimes(STRADDLE);
      if (run.kind !== 'ok') throw new Error(`got ${run.kind}`);
      expect(run.samples).toEqual([MISS, MISS, MISS, MISS]);
      expect(run.forces).toEqual([]);
    });

    it('skips a sample whose lookup failed, keeping the others, with one warning', async () => {
      h.upstream.route('POST', '/crimes-street/all-crime', jsonOk([]));
      h.upstream.route(
        'GET',
        '/locate-neighbourhood',
        straddleAnswers({
          [STRADDLE_SAMPLES.north]: status(500),
          [STRADDLE_SAMPLES.east]: status(500),
        }),
      );
      const run = await crimes(STRADDLE);
      if (run.kind !== 'ok') throw new Error(`got ${run.kind}`);
      expect(run.samples?.map((lookup) => lookup?.kind)).toEqual([
        'found',
        undefined,
        'found',
        undefined,
      ]);
      expect(run.forces).toEqual(['cheshire']);
      const warnings = (h.ctx.log as MockContextLogger).calls.filter((c) => c.level === 'warning');
      expect(warnings).toHaveLength(2);
    });

    it('rethrows when the call is cancelled while a sample lookup is in flight', async () => {
      const controller = new AbortController();
      const ctx = h.ctxWith(controller.signal);
      h.upstream.route('POST', '/crimes-street/all-crime', jsonOk([]));
      h.upstream.route(
        'GET',
        '/locate-neighbourhood',
        straddleAnswers({ [STRADDLE_SAMPLES.south]: hang }),
      );
      const pending = startCrimes(STRADDLE, 'all-crime', ctx);
      await untilReal(() => h.upstream.count('/locate-neighbourhood') === 4);
      setTimeout(() => controller.abort(), 1000);
      const error = await settle(pending).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toHaveProperty('kind');
      const degraded = (ctx.log as MockContextLogger).calls.some(
        (call) => call.msg === 'Point lookup failed; searching without the located force',
      );
      expect(degraded).toBe(false);
    });

    it('sends no further lookup or query for a repeated polygon (both cached)', async () => {
      h.upstream.route('POST', '/crimes-street/all-crime', jsonOk(crimesBody()));
      h.upstream.route('GET', '/locate-neighbourhood', straddleAnswers());
      const first = await crimes(STRADDLE);
      const second = await crimes(STRADDLE);
      expect(second).toEqual(first);
      expect(h.upstream.count('/locate-neighbourhood')).toBe(4);
      expect(h.upstream.count('/crimes-street/all-crime')).toBe(1);
    });
  });

  describe('location arm', () => {
    const LOCATION: AreaSpec = { kind: 'location', locationId: '1000001' };

    it('locates the first record carrying a map point, after the area answer', async () => {
      h.upstream.route('GET', '/crimes-at-location', async (request) => {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        return jsonOk([
          crimeRecord({ id: 1, location: null }),
          crimeRecord({ id: 2, location: { ...crimeRecord().location, latitude: '52.640000' } }),
          crimeRecord({ id: 3 }),
        ])(request);
      });
      h.upstream.route(
        'GET',
        '/locate-neighbourhood',
        locateBy({ '52.640000,-1.130000': 'leicestershire' }),
      );
      const run = await crimes(LOCATION);
      if (run.kind !== 'ok') throw new Error(`got ${run.kind}`);
      expect(run.located).toEqual(FOUND);
      expect(run.forces).toEqual(['leicestershire']);
      expect(run).not.toHaveProperty('samples');
      const [area] = h.upstream.callsTo('/crimes-at-location');
      const locates = h.upstream.callsTo('/locate-neighbourhood');
      expect(locates).toHaveLength(1);
      expect(locates[0]?.at).toBeGreaterThanOrEqual((area?.at ?? 0) + 5000);
    });

    it.each<[string, unknown[]]>([
      ['no records', []],
      ['records with no map point', [crimeRecord({ location: null })]],
    ])('sends no lookup for %s', async (_name, body) => {
      h.upstream.route('GET', '/crimes-at-location', jsonOk(body));
      const run = await crimes(LOCATION);
      if (run.kind !== 'ok') throw new Error(`got ${run.kind}`);
      expect(run).not.toHaveProperty('located');
      expect(run.forces).toEqual([]);
      expect(h.upstream.count('/locate-neighbourhood')).toBe(0);
    });

    it('degrades quietly when the lookup fails', async () => {
      h.upstream.route('GET', '/crimes-at-location', jsonOk([crimeRecord()]));
      h.upstream.route('GET', '/locate-neighbourhood', status(500));
      const run = await crimes(LOCATION);
      if (run.kind !== 'ok') throw new Error(`got ${run.kind}`);
      expect(run).not.toHaveProperty('located');
      expect(run.forces).toEqual([]);
    });

    it('gives up on a hung lookup 10 s after the area answered, so the answered search waits no longer', async () => {
      h.upstream.route('GET', '/crimes-at-location', async (request) => {
        await new Promise((resolve) => setTimeout(resolve, 20_000));
        return jsonOk([crimeRecord()])(request);
      });
      h.upstream.route('GET', '/locate-neighbourhood', hang);
      const start = Date.now();
      const run = await crimes(LOCATION);
      if (run.kind !== 'ok') throw new Error(`got ${run.kind}`);
      expect(run).not.toHaveProperty('located');
      expect(run.records).toHaveLength(1);
      expect(Date.now() - start).toBeGreaterThanOrEqual(30_000);
      expect(Date.now() - start).toBeLessThanOrEqual(30_500);
    });
  });

  describe('named arms', () => {
    it('carry the named force and send no lookup', async () => {
      h.upstream.route('GET', '/crimes-no-location', jsonOk([]));
      h.upstream.route('GET', '/leicestershire/NX01/boundary', jsonOk(boundaryBody()));
      h.upstream.route('POST', '/crimes-street/all-crime', jsonOk([]));
      const unplaced = await crimes({ kind: 'force_unplaced', force: 'btp' });
      const hood = await crimes({
        kind: 'neighbourhood',
        force: 'leicestershire',
        neighbourhoodId: 'NX01',
      });
      expect(unplaced).toMatchObject({ kind: 'ok', forces: ['btp'] });
      expect(hood).toMatchObject({ kind: 'ok', forces: ['leicestershire'] });
      expect(unplaced).not.toHaveProperty('located');
      expect(hood).not.toHaveProperty('samples');
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
      expect(await crimes(NEIGHBOURHOOD)).toEqual({
        kind: 'unknown_neighbourhood',
        force: 'leicestershire',
        neighbourhoodId: 'NX01',
      });
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
          outcomePoint,
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
          stopPoint,
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
          stopPoint,
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
      h.upstream.route('GET', '/locate-neighbourhood', jsonOk(locateBody()));
      const spec: AreaSpec = { kind: 'location', locationId: '1000001' };
      const first = await crimes(spec);
      const second = await crimes(spec);
      if (first.kind !== 'ok' || second.kind !== 'ok') throw new Error('expected ok');
      expect(second.records).toBe(first.records);
      expect(h.upstream.count('/crimes-at-location')).toBe(1);
      expect(h.upstream.count('/locate-neighbourhood')).toBe(1);
    });

    it('returns the target for a force arm', async () => {
      h.upstream.route('GET', '/stops-force', jsonOk(stopsBody()));
      const run = await settle(
        runAreaQuery(
          { kind: 'force', force: 'leicestershire' },
          (target) => stopsQuery(target, '2026-08'),
          stopPoint,
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
          outcomePoint,
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

describe('samplePoints', () => {
  const at = (points: readonly MapPoint[]) =>
    points.map(({ latitude, longitude }) => `${latitude.toFixed(6)},${longitude.toFixed(6)}`);

  it('takes the bounding-box centre, then the first northernmost, southernmost and easternmost vertices of a rectangle (westernmost repeats)', () => {
    expect(at(samplePoints(STRADDLE.kind === 'polygon' ? STRADDLE.vertices : []))).toEqual([
      STRADDLE_SAMPLES.centre,
      STRADDLE_SAMPLES.north,
      STRADDLE_SAMPLES.south,
      STRADDLE_SAMPLES.east,
    ]);
  });

  it('keeps five distinct points at most, and one for a degenerate ring', () => {
    const pentagon = polygonOf(
      [53.4, -2.3],
      [53.38, -2.24],
      [53.34, -2.26],
      [53.34, -2.34],
      [53.38, -2.36],
    );
    expect(samplePoints(pentagon.kind === 'polygon' ? pentagon.vertices : [])).toHaveLength(5);
    const dot = polygonOf([52.63, -1.13], [52.63, -1.13], [52.63, -1.13]);
    expect(at(samplePoints(dot.kind === 'polygon' ? dot.vertices : []))).toEqual([
      '52.630000,-1.130000',
    ]);
  });

  it('drops repeats only at the 6 dp a lookup is sent at: vertices 0.00001° apart stay distinct', () => {
    // N is 0.00001° north of SW, E 0.00001° east of it; W and S repeat SW.
    const sliver = polygonOf([52.63, -1.13], [52.63001, -1.13], [52.63, -1.12999]);
    const points = at(samplePoints(sliver.kind === 'polygon' ? sliver.vertices : []));
    expect(points).toHaveLength(4);
    expect(points.slice(1)).toEqual([
      '52.630010,-1.130000',
      '52.630000,-1.130000',
      '52.630000,-1.129990',
    ]);
  });

  it('is empty when no vertex lies in the coverage box', () => {
    const paris = polygonOf([48.85, 2.35], [48.86, 2.36], [48.84, 2.34]);
    expect(samplePoints(paris.kind === 'polygon' ? paris.vertices : [])).toEqual([]);
  });
});

describe('areaEcho', () => {
  it('echoes a point with the located force and neighbourhood when found', () => {
    expect(
      areaEcho(POINT, { target: POINT as Place, forces: ['leicestershire'], located: FOUND }),
    ).toEqual({
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
    expect(
      areaEcho(POINT, { target: POINT as Place, forces: [], ...(located ? { located } : {}) }),
    ).toEqual({
      type: 'point',
      lat: 52.63,
      lng: -1.13,
    });
  });

  it('echoes a polygon by vertex count (as given, the ring not closed)', () => {
    expect(areaEcho(RING, { ...NONE, target: RING as Place })).toEqual({
      type: 'polygon',
      vertex_count: 3,
    });
  });

  it('echoes a polygon’s located forces as given (the run sorts them)', () => {
    expect(
      areaEcho(RING, {
        target: RING as Place,
        forces: ['cheshire', 'greater-manchester'],
        samples: [MISS],
      }),
    ).toEqual({
      type: 'polygon',
      vertex_count: 3,
      located_forces: ['cheshire', 'greater-manchester'],
    });
  });

  it('echoes a location with its map point’s located force and neighbourhood', () => {
    const spec: AreaSpec = { kind: 'location', locationId: '1000001' };
    expect(
      areaEcho(spec, { target: spec as Place, forces: ['leicestershire'], located: FOUND }),
    ).toEqual({
      type: 'location',
      location_id: '1000001',
      located_force: 'leicestershire',
      located_neighbourhood: 'NX01',
    });
  });

  it('echoes a location by id', () => {
    const spec: AreaSpec = { kind: 'location', locationId: '1000001' };
    expect(areaEcho(spec, { ...NONE, target: spec as Place })).toEqual({
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
    expect(areaEcho(spec, { forces: ['leicestershire'], target })).toEqual({
      type: 'neighbourhood',
      force: 'leicestershire',
      neighbourhood_id: 'NX01',
      vertex_count: 5,
    });
  });

  it.each(['force_unplaced', 'force'] as const)('echoes %s by force alone', (kind) => {
    expect(
      areaEcho(
        { kind, force: 'btp' },
        { forces: ['btp'], target: { kind: 'force', force: 'btp' } },
      ),
    ).toEqual({
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
      expect(outsideCoverageNote(POINT, { located: MISS })).toBe(OUTSIDE_POINT);
    });

    it.each<[string, Lookup<LocatedNeighbourhood> | undefined]>([
      ['found', FOUND],
      ['unknown (the locate failed)', undefined],
    ])('does not flag a point whose locate is %s', (_name, located) => {
      expect(outsideCoverageNote(POINT, located ? { located } : {})).toBeUndefined();
    });

    it('flags a polygon with every vertex outside the coverage box', () => {
      expect(outsideCoverageNote(ring([48.85, 2.35], [48.86, 2.36], [48.84, 2.34]), NONE)).toBe(
        OUTSIDE_POLYGON,
      );
    });

    it('flags a polygon with swapped coordinates (lat in the longitude slot)', () => {
      expect(outsideCoverageNote(ring([-1.14, 52.63], [-1.12, 52.64], [-1.13, 52.6]), NONE)).toBe(
        OUTSIDE_POLYGON,
      );
    });

    it('does not flag a polygon with one vertex inside the box', () => {
      expect(
        outsideCoverageNote(ring([48.85, 2.35], [52.63, -1.13], [48.84, 2.34]), NONE),
      ).toBeUndefined();
    });

    it.each<[string, [number, number]]>([
      ['south-west corner', [49.8, -8.7]],
      ['north-east corner', [61.0, 2.0]],
      ['south-east corner', [49.8, 2.0]],
      ['north-west corner', [61.0, -8.7]],
    ])('treats the %s of the box as inside', (_name, point) => {
      expect(outsideCoverageNote(ring(point, point, point), NONE)).toBeUndefined();
    });

    it.each<[string, [number, number]]>([
      ['just south', [49.79, -1]],
      ['just north', [61.01, -1]],
      ['just west', [52, -8.71]],
      ['just east', [52, 2.01]],
    ])('treats a point %s of the box as outside', (_name, point) => {
      expect(outsideCoverageNote(ring(point, point, point), NONE)).toBe(OUTSIDE_POLYGON);
    });

    it('flags an in-box polygon whose every sample answered 404, and only then', () => {
      const highlands = ring([57.5, -4.3], [57.5, -4.1], [57.4, -4.1]);
      expect(outsideCoverageNote(highlands, { samples: [MISS, MISS] })).toBe(OUTSIDE_POLYGON);
      expect(outsideCoverageNote(highlands, { samples: [MISS, undefined] })).toBeUndefined();
      expect(outsideCoverageNote(highlands, { samples: [MISS, FOUND] })).toBeUndefined();
      expect(outsideCoverageNote(highlands, { samples: [] })).toBeUndefined();
    });

    it('ignores the locate result for a polygon and the polygon for a point', () => {
      expect(outsideCoverageNote(ring([48.85, 2.35]), { located: FOUND })).toBe(OUTSIDE_POLYGON);
      expect(outsideCoverageNote(POINT, { located: MISS })).toBe(OUTSIDE_POINT);
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
      expect(outsideCoverageNote(spec, { located: MISS, samples: [MISS] })).toBeUndefined();
    });
  });

  describe('partialLocateNote', () => {
    const CHESHIRE: Lookup<LocatedNeighbourhood> = {
      kind: 'found',
      value: { force: 'cheshire', neighbourhood: 'CX01' },
    };

    it('names how many of the sample lookups failed when others found a force', () => {
      expect(
        partialLocateNote({
          forces: ['cheshire'],
          samples: [CHESHIRE, undefined, CHESHIRE, undefined],
        }),
      ).toBe(
        "The force at 2 of this polygon's 4 sample points could not be looked up, so the forces named here may not be all it falls in; search again to retry the lookup.",
      );
      expect(
        partialLocateNote({ forces: ['cheshire'], samples: [CHESHIRE, MISS, undefined] }),
      ).toContain("The force at 1 of this polygon's 3 sample points");
    });

    it.each<[string, AreaForces]>([
      ['every lookup answered', { forces: ['cheshire'], samples: [CHESHIRE, MISS] }],
      ['every lookup failed', { forces: [], samples: [undefined, undefined] }],
      ['the rest answered 404', { forces: [], samples: [MISS, undefined] }],
      ['no sample was sent', { forces: [], samples: [] }],
      ['a point whose locate failed', { forces: [] }],
      ['a named arm', { forces: ['leicestershire'] }],
    ])('says nothing when %s', (_name, run) => {
      expect(partialLocateNote(run)).toBeUndefined();
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
