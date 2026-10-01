/**
 * @fileoverview PoliceApiService in-process caches: every cache's TTL, the
 * entry caps (45, 45, 64, 10,000), and the area-response cache's key, weight
 * (decoded bytes x 1.25), 15-minute TTL from insert, eviction order and the
 * half-cap uncached rule. Time is virtual; large bodies are generated here.
 * @module tests/services/police-api-service.cache.test
 */

import type { MockContextLogger } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import {
  boundaryBody,
  forceDetailBody,
  jsonOk,
  locateBody,
  neighbourhoodsBody,
  plainNotFound,
  sizedJsonBody,
  textOk,
} from '../fixtures/police-api-upstream.js';
import { DAY, HOUR, MINUTE, settle, useServiceHarness } from '../fixtures/service-harness.js';

type Harness = ReturnType<typeof useServiceHarness>;

const normalize = (json: unknown) => json as readonly unknown[];

describe('PoliceApiService caches', () => {
  const h = useServiceHarness();

  /** One query on the shared area route; `params` distinguishes cache entries. */
  const area = (
    params: Record<string, string> = { date: '2026-08' },
    options: { method?: 'GET' | 'POST'; path?: string } = {},
  ) =>
    h.service.queryArea(
      {
        path: options.path ?? '/crimes-street/all-crime',
        ...(options.method ? { method: options.method } : {}),
        params,
        normalize,
      },
      h.ctx,
      h.budget(),
    );

  describe('TTL of every cache', () => {
    const cases: {
      name: string;
      path: string;
      ttl: number;
      register: (harness: Harness) => void;
      call: (harness: Harness) => Promise<unknown>;
    }[] = [
      {
        name: 'availability',
        path: '/crimes-street-dates',
        ttl: HOUR,
        register: () => undefined,
        call: (x) => x.service.getAvailability(x.ctx, x.budget()),
      },
      {
        name: 'forces',
        path: '/forces',
        ttl: DAY,
        register: () => undefined,
        call: (x) => x.service.getForces(x.ctx, x.budget()),
      },
      {
        name: 'categories',
        path: '/crime-categories',
        ttl: DAY,
        register: () => undefined,
        call: (x) => x.service.getCategories(x.ctx, x.budget()),
      },
      {
        name: 'force detail',
        path: '/forces/leicestershire',
        ttl: DAY,
        register: (x) =>
          x.upstream.route('GET', '/forces/leicestershire', jsonOk(forceDetailBody())),
        call: (x) => x.service.getForceDetail('leicestershire', x.ctx, x.budget()),
      },
      {
        name: 'neighbourhood list',
        path: '/leicestershire/neighbourhoods',
        ttl: DAY,
        register: (x) =>
          x.upstream.route('GET', '/leicestershire/neighbourhoods', jsonOk(neighbourhoodsBody())),
        call: (x) => x.service.getNeighbourhoods('leicestershire', x.ctx, x.budget()),
      },
      {
        name: 'boundary',
        path: '/leicestershire/NX01/boundary',
        ttl: DAY,
        register: (x) =>
          x.upstream.route('GET', '/leicestershire/NX01/boundary', jsonOk(boundaryBody())),
        call: (x) => x.service.getBoundary('leicestershire', 'NX01', x.ctx, x.budget()),
      },
      {
        name: 'locate',
        path: '/locate-neighbourhood',
        ttl: DAY,
        register: (x) => x.upstream.route('GET', '/locate-neighbourhood', jsonOk(locateBody())),
        call: (x) => x.service.locate(52.63, -1.13, x.ctx, x.budget()),
      },
      {
        name: 'crime-history miss',
        path: `/outcomes-for-crime/${'0'.repeat(64)}`,
        ttl: 15 * MINUTE,
        register: (x) =>
          x.upstream.route('GET', `/outcomes-for-crime/${'0'.repeat(64)}`, plainNotFound),
        call: (x) => x.service.getCrimeHistory('0'.repeat(64), x.ctx, x.budget()),
      },
    ];

    it.each(cases)(
      '$name is served from cache until $ttl ms from insert, then refetched',
      async (entry) => {
        entry.register(h);
        await settle(entry.call(h));
        await settle(entry.call(h));
        expect(h.upstream.count(entry.path)).toBe(1);
        await vi.advanceTimersByTimeAsync(entry.ttl - 1000 - 1);
        await settle(entry.call(h));
        expect(h.upstream.count(entry.path)).toBe(1);
        await vi.advanceTimersByTimeAsync(1001);
        await settle(entry.call(h));
        expect(h.upstream.count(entry.path)).toBe(2);
      },
    );

    it('does not extend an entry lifetime on a hit', async () => {
      await settle(h.service.getAvailability(h.ctx, h.budget()));
      await vi.advanceTimersByTimeAsync(30 * MINUTE);
      await settle(h.service.getAvailability(h.ctx, h.budget()));
      await vi.advanceTimersByTimeAsync(30 * MINUTE);
      await settle(h.service.getAvailability(h.ctx, h.budget()));
      expect(h.upstream.count('/crimes-street-dates')).toBe(2);
    });

    it('expires a cached miss on the same schedule as a hit', async () => {
      h.upstream.route('GET', '/forces/btp', () => new Response('Not Found', { status: 404 }));
      await settle(h.service.getForceDetail('btp', h.ctx, h.budget()));
      await vi.advanceTimersByTimeAsync(DAY + 1);
      await settle(h.service.getForceDetail('btp', h.ctx, h.budget()));
      expect(h.upstream.count('/forces/btp')).toBe(2);
    });

    it('serves the same object from cache each time', async () => {
      const first = await settle(h.service.getForces(h.ctx, h.budget()));
      const second = await settle(h.service.getForces(h.ctx, h.budget()));
      expect(second).toBe(first);
    });
  });

  describe('entry caps', () => {
    /** Fills a keyed cache past its cap and checks the least recently used entry is the one lost. */
    async function exerciseCap(options: {
      cap: number;
      pathOf: (i: number) => string;
      register: (i: number) => void;
      call: (i: number) => Promise<unknown>;
    }) {
      const { cap, pathOf, register, call } = options;
      for (let i = 0; i <= cap; i++) register(i);
      await settle(Promise.all(Array.from({ length: cap }, (_, i) => call(i))));
      for (let i = 0; i < cap; i++) expect(h.upstream.count(pathOf(i))).toBe(1);

      await settle(call(0)); // hit: entry 0 becomes the most recently used
      expect(h.upstream.count(pathOf(0))).toBe(1);

      await settle(call(cap)); // one past the cap evicts the least recently used, entry 1
      await settle(call(0));
      await settle(call(cap));
      expect(h.upstream.count(pathOf(0))).toBe(1);
      expect(h.upstream.count(pathOf(cap))).toBe(1);
      await settle(call(1));
      expect(h.upstream.count(pathOf(1))).toBe(2);
    }

    it('holds 45 force details', async () => {
      await exerciseCap({
        cap: 45,
        pathOf: (i) => `/forces/f${i}`,
        register: (i) =>
          h.upstream.route('GET', `/forces/f${i}`, jsonOk(forceDetailBody({ id: `f${i}` }))),
        call: (i) => h.service.getForceDetail(`f${i}`, h.ctx, h.budget()),
      });
    });

    it('holds 45 neighbourhood lists', async () => {
      await exerciseCap({
        cap: 45,
        pathOf: (i) => `/f${i}/neighbourhoods`,
        register: (i) =>
          h.upstream.route('GET', `/f${i}/neighbourhoods`, jsonOk(neighbourhoodsBody())),
        call: (i) => h.service.getNeighbourhoods(`f${i}`, h.ctx, h.budget()),
      });
    });

    it('holds 64 boundaries', async () => {
      await exerciseCap({
        cap: 64,
        pathOf: (i) => `/leicestershire/N${i}/boundary`,
        register: (i) =>
          h.upstream.route('GET', `/leicestershire/N${i}/boundary`, jsonOk(boundaryBody())),
        call: (i) => h.service.getBoundary('leicestershire', `N${i}`, h.ctx, h.budget()),
      });
    });

    it('counts a cached miss against the cap like any entry', async () => {
      await exerciseCap({
        cap: 45,
        pathOf: (i) => `/forces/m${i}`,
        register: (i) =>
          h.upstream.route(
            'GET',
            `/forces/m${i}`,
            () => new Response('Not Found', { status: 404 }),
          ),
        call: (i) => h.service.getForceDetail(`m${i}`, h.ctx, h.budget()),
      });
    });

    it('holds 10,000 located points, evicting the least recently used beyond that', async () => {
      h.upstream.route('GET', '/locate-neighbourhood', jsonOk(locateBody()));
      const point = (i: number) => [50 + i * 1e-5, -1] as const;
      const locate = (i: number) => h.service.locate(...point(i), h.ctx, h.budget());

      // 15 requests start per second, so batch in fifteens and let the pacer window turn over.
      for (let start = 0; start < 10_001; start += 15) {
        const batch = Array.from({ length: Math.min(15, 10_001 - start) }, (_, k) =>
          locate(start + k),
        );
        await settle(Promise.all(batch), 1000);
      }
      expect(h.upstream.count('/locate-neighbourhood')).toBe(10_001);

      await settle(locate(10_000));
      await settle(locate(1));
      expect(h.upstream.count('/locate-neighbourhood')).toBe(10_001);

      await settle(locate(0));
      expect(h.upstream.count('/locate-neighbourhood')).toBe(10_002);
    }, 120_000);
  });

  describe('area cache: key', () => {
    it('shares one entry between requests whose params differ only in key order', async () => {
      h.upstream.route('GET', '/crimes-street/all-crime', jsonOk([1]));
      await settle(area({ date: '2026-08', lat: '52.630000', lng: '-1.130000' }));
      await settle(area({ lng: '-1.130000', lat: '52.630000', date: '2026-08' }));
      expect(h.upstream.count('/crimes-street/all-crime')).toBe(1);
    });

    it.each([
      ['another month', { date: '2026-07' }, undefined],
      ['another value for one param', { date: '2026-08', lat: '52.640000' }, undefined],
      ['an extra param', { date: '2026-08', lat: '52.630000', extra: '1' }, undefined],
      ['another route', { date: '2026-08', lat: '52.630000' }, '/outcomes-at-location'],
    ])('keeps a separate entry for %s', async (_name, params, path) => {
      h.upstream.route('GET', '/crimes-street/all-crime', jsonOk([1]));
      h.upstream.route('GET', '/outcomes-at-location', jsonOk([2]));
      await settle(area({ date: '2026-08', lat: '52.630000' }));
      await settle(area(params, path ? { path } : {}));
      const total =
        h.upstream.count('/crimes-street/all-crime') + h.upstream.count('/outcomes-at-location');
      expect(total).toBe(2);
    });

    it('keeps GET and POST of the same route and params apart', async () => {
      h.upstream.route('GET', '/crimes-street/all-crime', jsonOk([1]));
      h.upstream.route('POST', '/crimes-street/all-crime', jsonOk([1]));
      await settle(area({ date: '2026-08' }));
      await settle(area({ date: '2026-08' }, { method: 'POST' }));
      await settle(area({ date: '2026-08' }, { method: 'POST' }));
      expect(h.upstream.calls.map((call) => call.method)).toEqual(['GET', 'POST']);
    });

    it('cannot confuse one param holding another param text with two params', async () => {
      h.upstream.route('GET', '/crimes-street/all-crime', jsonOk([1]));
      await settle(area({ date: '2026-08', a: '1&b=2' }));
      await settle(area({ date: '2026-08', a: '1', b: '2' }));
      expect(h.upstream.count('/crimes-street/all-crime')).toBe(2);
    });

    it('serves the cached records themselves, shared, and normalizes once per fetch', async () => {
      h.upstream.route('GET', '/crimes-street/all-crime', jsonOk([{ n: 1 }]));
      let normalized = 0;
      const query = () =>
        h.service.queryArea(
          {
            path: '/crimes-street/all-crime',
            params: { date: '2026-08' },
            normalize: (json) => {
              normalized += 1;
              return json as readonly unknown[];
            },
          },
          h.ctx,
          h.budget(),
        );
      const first = await settle(query());
      const second = await settle(query());
      expect(
        first.kind === 'found' && second.kind === 'found' && second.value === first.value,
      ).toBe(true);
      expect(normalized).toBe(1);
    });
  });

  describe('area cache: TTL', () => {
    it('serves a response for 15 minutes from insert', async () => {
      h.upstream.route('GET', '/crimes-street/all-crime', jsonOk([1]));
      await settle(area());
      await vi.advanceTimersByTimeAsync(15 * MINUTE - 1001);
      await settle(area());
      expect(h.upstream.count('/crimes-street/all-crime')).toBe(1);
      await vi.advanceTimersByTimeAsync(1001);
      await settle(area());
      expect(h.upstream.count('/crimes-street/all-crime')).toBe(2);
    });

    it('counts the 15 minutes from insert: a hit does not extend it', async () => {
      h.upstream.route('GET', '/crimes-street/all-crime', jsonOk([1]));
      await settle(area());
      await vi.advanceTimersByTimeAsync(10 * MINUTE);
      await settle(area());
      await vi.advanceTimersByTimeAsync(5 * MINUTE + 1);
      await settle(area());
      expect(h.upstream.count('/crimes-street/all-crime')).toBe(2);
    });
  });

  describe('area cache: weight, eviction and the half-cap rule', () => {
    const body20 = sizedJsonBody(20_000_000);
    const entry = (n: number) => area({ date: '2026-08', n: String(n) });
    const fetched = () => h.upstream.count('/crimes-street/all-crime');

    it('weighs entries by decoded bytes x 1.25 against a 64 MiB budget: two 20 MB bodies fit, a third evicts the oldest', async () => {
      h.upstream.route('GET', '/crimes-street/all-crime', textOk(body20));
      await settle(entry(1));
      await settle(entry(2));
      await settle(entry(1));
      await settle(entry(2));
      expect(fetched()).toBe(2);
      await settle(entry(3));
      await settle(entry(1));
      expect(fetched()).toBe(4);
    });

    it('evicts the least recently used entry, not the oldest inserted', async () => {
      h.upstream.route('GET', '/crimes-street/all-crime', textOk(body20));
      await settle(entry(1));
      await settle(entry(2));
      await settle(entry(1)); // 1 is now the most recently used
      await settle(entry(3)); // evicts 2
      expect(fetched()).toBe(3);
      await settle(entry(1));
      await settle(entry(3));
      expect(fetched()).toBe(3);
      await settle(entry(2));
      expect(fetched()).toBe(4);
    });

    it('drops expired entries before evicting live ones', async () => {
      h.upstream.route('GET', '/crimes-street/all-crime', textOk(body20));
      await settle(entry(1));
      await vi.advanceTimersByTimeAsync(MINUTE);
      await settle(entry(2));
      await settle(entry(1)); // 1 becomes the most recently used; 2 is now the least
      await vi.advanceTimersByTimeAsync(14 * MINUTE + 1001); // 1 expired, 2 still live
      await settle(entry(3));
      await settle(entry(2));
      expect(fetched()).toBe(3);
    });

    it('caches a body at the half-cap boundary (26,843,545 bytes weighs 33,554,431.25)', async () => {
      h.upstream.route('GET', '/crimes-street/all-crime', textOk(sizedJsonBody(26_843_545)));
      await settle(entry(1));
      await settle(entry(1));
      expect(fetched()).toBe(1);
    });

    it('serves a body one byte over the half-cap uncached, and says so in the log', async () => {
      h.upstream.route('GET', '/crimes-street/all-crime', textOk(sizedJsonBody(26_843_546)));
      const first = await settle(entry(1));
      expect(first.kind).toBe('found');
      await settle(entry(1));
      expect(fetched()).toBe(2);
      const log = h.ctx.log as MockContextLogger;
      expect(log.calls).toContainEqual(
        expect.objectContaining({
          level: 'info',
          msg: 'Area response too large to cache; served uncached',
          data: { path: '/crimes-street/all-crime', bytes: 26_843_546 },
        }),
      );
    });

    it('does not log the uncached notice for a body that was cached', async () => {
      h.upstream.route('GET', '/crimes-street/all-crime', jsonOk([1]));
      await settle(entry(1));
      const log = h.ctx.log as MockContextLogger;
      expect(log.calls.some((call) => call.msg.includes('too large to cache'))).toBe(false);
    });

    it('leaves other entries in place when it serves a response uncached', async () => {
      h.upstream.route('GET', '/crimes-street/all-crime', textOk(body20));
      h.upstream.route('GET', '/outcomes-at-location', textOk(sizedJsonBody(30_000_000)));
      await settle(entry(1));
      const big = await settle(area({ date: '2026-08' }, { path: '/outcomes-at-location' }));
      expect(big.kind).toBe('found');
      await settle(entry(1));
      expect(fetched()).toBe(1);
    });

    it('caches an empty list at the small weight of its body', async () => {
      h.upstream.route('GET', '/crimes-street/all-crime', jsonOk([]));
      await settle(entry(1));
      await settle(entry(1));
      expect(fetched()).toBe(1);
    });
  });
});
