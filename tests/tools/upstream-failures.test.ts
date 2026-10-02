/**
 * @fileoverview Every tool's envelope for the upstream failures that outlast the
 * request boundary's retries, through `runToolContract` (the production error
 * envelope, declared recovery fill included): an upstream 429 as `rate_limited`
 * naming its wait (delta-seconds and HTTP-date) or the declared hint, failing at
 * once when the wait would leave the next attempt under 10 s, exhausted 5xx and
 * network failures as `upstream_unavailable` (naming a 503's `Retry-After` off
 * the area routes), the retry deadline — or retries ending in an attempt timeout
 * before it — as retryable `retry_deadline_exceeded` (the outcomes route with its
 * own hint), a pacer shed as retryable `pacer_shed`, and a cancellation during a
 * Retry-After wait as `RequestCancelled`. Each is pinned on
 * `structuredContent.error` and in `content[]`, and every tool's declared
 * contract for the four reasons is pinned as one.
 * @module tests/tools/upstream-failures.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { findNeighbourhoodTool } from '@/mcp-server/tools/definitions/find-neighbourhood.tool.js';
import { getCrimeOutcomesTool } from '@/mcp-server/tools/definitions/get-crime-outcomes.tool.js';
import { listReferenceTool } from '@/mcp-server/tools/definitions/list-reference.tool.js';
import { searchCrimesTool } from '@/mcp-server/tools/definitions/search-crimes.tool.js';
import { searchOutcomesTool } from '@/mcp-server/tools/definitions/search-outcomes.tool.js';
import { searchStopsTool } from '@/mcp-server/tools/definitions/search-stops.tool.js';
import {
  emptyArrayOk,
  forcesBody,
  hang,
  jsonOk,
  locateBody,
  neighbourhoodDetailBody,
  networkError,
  type Responder,
  rateLimited,
  rateLimitedUntil,
  sequence,
  status,
} from '../fixtures/police-api-upstream.js';
import {
  crimeHistoryBody,
  delayed,
  neighbourhoodRoutes,
  persistentIds,
} from '../fixtures/police-api-upstream-w3.js';
import { settle, type Upstream, useToolHarness } from '../fixtures/service-harness.js';

type Result = Awaited<ReturnType<typeof runToolContract>>;

/** Virtual-clock step for these long waits; their timing assertions are whole seconds. */
const STEP_MS = 200;

const RATE_LIMITED_HINT = (seconds: number) =>
  `data.police.uk is rate-limiting this server; call again in ${seconds} s.`;
const SHED_HINT = (seconds: number) =>
  `This server's queue for data.police.uk is busy; call again in ${seconds} s.`;
const SHED_DECLARED =
  "This server's queue for data.police.uk is busy; wait a few seconds, then call this tool again.";
const RATE_LIMITED_DECLARED =
  'data.police.uk is rate-limiting this server; wait a few seconds, then call this tool again.';
const UNAVAILABLE_HINT = (seconds: number) =>
  `data.police.uk is not answering right now; call again in ${seconds} s.`;
const UNAVAILABLE_DECLARED =
  'data.police.uk is not answering right now; call this tool again in a few minutes.';
const DEADLINE_DECLARED =
  'data.police.uk did not answer within the time one call allows; call this tool again in a minute.';
const OUTCOMES_DEADLINE_HINT =
  "data.police.uk is still preparing this month's outcomes, which can take longer than one call allows when the month has not been asked for recently; run the same search again shortly and it usually succeeds.";
const SHED_MESSAGE =
  'Too many requests to data.police.uk are queued in this server, so this one was not sent.';

const text = (result: Result) =>
  result.content.map((block) => (block.type === 'text' ? block.text : '')).join('');

const errorOf = (result: Result) => {
  expect(result.isError, JSON.stringify(result.structuredContent)).toBe(true);
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

const [PERSISTENT_ID] = persistentIds(1) as [string];
const POINT = { area: 'point', lat: 52.63, lng: -1.13, month: '2026-07' } as const;
const withSignal = (signal?: AbortSignal) => (signal ? { context: { signal } } : undefined);
const locates = (upstream: Upstream) => {
  upstream.route('GET', '/locate-neighbourhood', jsonOk(locateBody()));
};

interface ToolCase {
  /** `path` is an area route, where a 503 is a value answered by one health probe, never retried. */
  readonly areaRoute?: true;
  /** Routes the call needs besides the reference ones and `path`. */
  readonly arrange?: (upstream: Upstream) => void;
  /** The hint a failure at the retry deadline carries. */
  readonly deadlineHint: string;
  /** Requests a call that never gets an answer sends before the deadline. */
  readonly hangRequests: number;
  readonly name: string;
  /** A success on `path`. */
  readonly ok: Responder;
  /** The one route whose failure the call cannot get past. */
  readonly path: string;
  readonly run: (signal?: AbortSignal) => Promise<Result>;
}

const CASES: readonly ToolCase[] = [
  {
    name: 'ukcrime_list_reference',
    path: '/forces',
    ok: jsonOk(forcesBody()),
    hangRequests: 2,
    deadlineHint: DEADLINE_DECLARED,
    run: (signal) => runToolContract(listReferenceTool, { topic: 'forces' }, withSignal(signal)),
  },
  {
    name: 'ukcrime_search_crimes',
    path: '/crimes-street/all-crime',
    areaRoute: true,
    ok: emptyArrayOk,
    arrange: locates,
    hangRequests: 2,
    deadlineHint: DEADLINE_DECLARED,
    run: (signal) => runToolContract(searchCrimesTool, { ...POINT }, withSignal(signal)),
  },
  {
    name: 'ukcrime_search_outcomes',
    path: '/outcomes-at-location',
    areaRoute: true,
    ok: emptyArrayOk,
    arrange: locates,
    hangRequests: 1,
    deadlineHint: OUTCOMES_DEADLINE_HINT,
    run: (signal) => runToolContract(searchOutcomesTool, { ...POINT }, withSignal(signal)),
  },
  {
    name: 'ukcrime_search_stops',
    path: '/stops-force',
    areaRoute: true,
    ok: emptyArrayOk,
    hangRequests: 2,
    deadlineHint: DEADLINE_DECLARED,
    run: (signal) =>
      runToolContract(
        searchStopsTool,
        { area: 'force', force: 'leicestershire', month: '2026-07' },
        withSignal(signal),
      ),
  },
  {
    name: 'ukcrime_get_crime_outcomes',
    path: `/outcomes-for-crime/${PERSISTENT_ID}`,
    ok: jsonOk(crimeHistoryBody(PERSISTENT_ID)),
    hangRequests: 2,
    deadlineHint: DEADLINE_DECLARED,
    run: (signal) =>
      runToolContract(
        getCrimeOutcomesTool,
        { persistent_ids: [PERSISTENT_ID] },
        withSignal(signal),
      ),
  },
  {
    name: 'ukcrime_find_neighbourhood',
    path: '/leicestershire/NX01',
    ok: jsonOk(neighbourhoodDetailBody({ id: 'NX01' })),
    arrange: (upstream) => {
      neighbourhoodRoutes(upstream);
    },
    hangRequests: 2,
    deadlineHint: DEADLINE_DECLARED,
    run: (signal) =>
      runToolContract(
        findNeighbourhoodTool,
        { force: 'leicestershire', neighbourhood_id: 'NX01', include: [] },
        withSignal(signal),
      ),
  },
];

describe('upstream failures that outlast the retries, on every tool', () => {
  const h = useToolHarness();

  describe.each(CASES)('$name', (c) => {
    /** Routes what the call needs, with `respond` on the route it cannot get past. */
    const failWith = (respond: Responder) => {
      c.arrange?.(h.upstream);
      h.upstream.route('GET', c.path, respond);
    };
    const call = (signal?: AbortSignal) => settle(c.run(signal), STEP_MS);

    it('fails rate_limited, retryable, naming a 30 s Retry-After on both surfaces, after waiting it once', async () => {
      failWith(rateLimited('30'));
      const result = await call();
      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
      expect(error.data).toMatchObject({
        reason: 'rate_limited',
        retryable: true,
        retryAfter: '30',
        recovery: { hint: RATE_LIMITED_HINT(30) },
      });
      expect(text(result)).toContain(`Recovery: ${RATE_LIMITED_HINT(30)}`);
      expect(text(result)).toContain('(reason rate_limited · retryable)');
      const [first, second] = h.upstream.callsTo(c.path);
      expect(h.upstream.count(c.path)).toBe(2);
      expect((second?.at ?? 0) - (first?.at ?? 0)).toBeGreaterThanOrEqual(30_000);
    });

    it('names an HTTP-date Retry-After in seconds, like delta-seconds', async () => {
      failWith(rateLimitedUntil(30_000));
      const result = await call();
      expect(errorOf(result).data).toMatchObject({
        reason: 'rate_limited',
        retryable: true,
        recovery: { hint: RATE_LIMITED_HINT(30) },
      });
      expect(text(result)).toContain(`Recovery: ${RATE_LIMITED_HINT(30)}`);
    });

    it('fails at once, after one request, naming a Retry-After that outlasts the call', async () => {
      failWith(rateLimited('60'));
      const result = await call();
      expect(errorOf(result).data).toMatchObject({
        reason: 'rate_limited',
        recovery: { hint: RATE_LIMITED_HINT(60) },
      });
      expect(h.upstream.count(c.path)).toBe(1);
    });

    it('fails at once, after one request, naming a 44 s Retry-After that would leave the next attempt under 10 s', async () => {
      failWith(sequence(rateLimited('44'), delayed(5_000, c.ok)));
      const start = Date.now();
      const result = await call();
      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
      expect(error.data).toMatchObject({
        reason: 'rate_limited',
        retryable: true,
        recovery: { hint: RATE_LIMITED_HINT(44) },
      });
      expect(text(result)).toContain(`Recovery: ${RATE_LIMITED_HINT(44)}`);
      expect(h.upstream.count(c.path)).toBe(1);
      expect(Date.now() - start).toBeLessThan(1000);
    });

    it('carries the declared rate_limited hint, naming no figure, for a 429 with no Retry-After', async () => {
      failWith(rateLimited());
      const result = await call();
      const error = errorOf(result);
      expect(error.data).toMatchObject({
        reason: 'rate_limited',
        retryable: true,
        recovery: { hint: RATE_LIMITED_DECLARED },
      });
      expect(text(result)).toContain(`Recovery: ${RATE_LIMITED_DECLARED}`);
      expect(h.upstream.count(c.path)).toBe(3);
    });

    it.each<[string, Responder]>([
      ['a 502 on every attempt', status(502)],
      ['a network failure on every attempt', networkError],
    ])(
      'fails %s as upstream_unavailable, retryable, with the declared hint',
      async (_n, respond) => {
        failWith(respond);
        const result = await call();
        const error = errorOf(result);
        expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
        expect(error.data).toMatchObject({
          reason: 'upstream_unavailable',
          retryable: true,
          recovery: { hint: UNAVAILABLE_DECLARED },
        });
        expect(text(result)).toContain(`Recovery: ${UNAVAILABLE_DECLARED}`);
        expect(text(result)).toContain('(reason upstream_unavailable · retryable)');
        expect(h.upstream.count(c.path)).toBe(3);
      },
    );

    if (!c.areaRoute) {
      it('names the Retry-After of a 503 it waited out once and could not again, on both surfaces', async () => {
        failWith(status(503, '30'));
        const result = await call();
        const error = errorOf(result);
        expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
        expect(error.data).toMatchObject({
          reason: 'upstream_unavailable',
          retryable: true,
          recovery: { hint: UNAVAILABLE_HINT(30) },
        });
        expect(text(result)).toContain(`Recovery: ${UNAVAILABLE_HINT(30)}`);
        expect(h.upstream.count(c.path)).toBe(2);
      });
    }

    it('fails an upstream that never answers at the deadline as retry_deadline_exceeded, retryable, with a hint', async () => {
      failWith(hang);
      const start = Date.now();
      const result = await call();
      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.Timeout);
      expect(error.data).toMatchObject({
        reason: 'retry_deadline_exceeded',
        retryable: true,
        recovery: { hint: c.deadlineHint },
      });
      expect(text(result)).toContain(`Recovery: ${c.deadlineHint}`);
      expect(text(result)).toContain('(reason retry_deadline_exceeded · retryable)');
      expect(h.upstream.count(c.path)).toBe(c.hangRequests);
      expect(Date.now() - start).toBeLessThanOrEqual(45_500);
    });

    it('fails two fast 502s and then a hang as retry_deadline_exceeded, retryable, with a hint', async () => {
      failWith(sequence(status(502), status(502), hang));
      const start = Date.now();
      const result = await call();
      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.Timeout);
      expect(error.data).toMatchObject({
        reason: 'retry_deadline_exceeded',
        retryable: true,
        recovery: { hint: c.deadlineHint },
      });
      expect(text(result)).toContain(`Recovery: ${c.deadlineHint}`);
      expect(text(result)).toContain('(reason retry_deadline_exceeded · retryable)');
      expect(h.upstream.count(c.path)).toBe(3);
      expect(Date.now() - start).toBeLessThanOrEqual(45_500);
    });

    it('ends as RequestCancelled, never retryable, when the caller cancels during a Retry-After wait', async () => {
      failWith(rateLimited('30'));
      const controller = new AbortController();
      setTimeout(() => controller.abort(new Error('client went away')), 10_000);
      const start = Date.now();
      const result = await call(controller.signal);
      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.RequestCancelled);
      expect(error.data?.retryable).not.toBe(true);
      expect(Date.now() - start).toBeLessThan(10_500);
      expect(h.upstream.count(c.path)).toBe(1);
    });
  });

  it('declares the four request-boundary reasons identically on every tool', () => {
    const boundary = new Set([
      'rate_limited',
      'pacer_shed',
      'upstream_unavailable',
      'retry_deadline_exceeded',
    ]);
    for (const definition of [
      listReferenceTool,
      searchCrimesTool,
      searchOutcomesTool,
      searchStopsTool,
      getCrimeOutcomesTool,
      findNeighbourhoodTool,
    ]) {
      const entries: readonly {
        readonly code: number;
        readonly reason: string;
        readonly recovery: string;
        readonly retryable?: boolean;
      }[] = definition.errors ?? [];
      const declared = Object.fromEntries(
        entries
          .filter((entry) => boundary.has(entry.reason))
          .map(({ code, reason, recovery, retryable }) => [reason, { code, recovery, retryable }]),
      );
      expect(declared, definition.name).toEqual({
        rate_limited: {
          code: JsonRpcErrorCode.RateLimited,
          recovery: RATE_LIMITED_DECLARED,
          retryable: true,
        },
        pacer_shed: {
          code: JsonRpcErrorCode.RateLimited,
          recovery: SHED_DECLARED,
          retryable: true,
        },
        upstream_unavailable: {
          code: JsonRpcErrorCode.ServiceUnavailable,
          recovery: UNAVAILABLE_DECLARED,
          retryable: true,
        },
        retry_deadline_exceeded: {
          code: JsonRpcErrorCode.Timeout,
          recovery: DEADLINE_DECLARED,
          retryable: true,
        },
      });
    }
  });

  it('ukcrime_list_reference: waits out a Retry-After that fits and answers', async () => {
    h.upstream.route('GET', '/forces', sequence(rateLimited('30'), jsonOk(forcesBody())));
    const result = await settle(runToolContract(listReferenceTool, { topic: 'forces' }), STEP_MS);
    expect(result.isError).toBeFalsy();
    const [first, second] = h.upstream.callsTo('/forces');
    expect((second?.at ?? 0) - (first?.at ?? 0)).toBeGreaterThanOrEqual(30_000);
  });

  it('ukcrime_search_crimes: a search shed by the queue fails pacer_shed, retryable, naming its wait and no internal pacer', async () => {
    h.upstream.route('GET', '/locate-neighbourhood', jsonOk(locateBody()));
    h.upstream.route('GET', '/crimes-street/all-crime', delayed(25_000, emptyArrayOk));
    const results = await settle(
      Promise.all(
        [0, 1, 2, 3].map((i) =>
          runToolContract(searchCrimesTool, { ...POINT, lat: 52.6 + i / 100 }),
        ),
      ),
      STEP_MS,
    );
    const shed = results.filter((result) => result.isError);
    expect(shed).toHaveLength(1);
    const [result] = shed as [Result];
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(error.message).toBe(SHED_MESSAGE);
    const retryAfter = error.data.retryAfter as number;
    expect(retryAfter).toBeGreaterThan(0);
    expect(error.data).toMatchObject({
      reason: 'pacer_shed',
      retryable: true,
      recovery: { hint: SHED_HINT(retryAfter) },
    });
    expect(text(result)).toContain(`Recovery: ${SHED_HINT(retryAfter)}`);
    expect(text(result)).toContain('(reason pacer_shed · retryable)');
    expect(JSON.stringify(result)).not.toContain('data-police-uk');
  });
});
