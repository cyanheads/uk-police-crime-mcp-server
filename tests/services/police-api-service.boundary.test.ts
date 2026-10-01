/**
 * @fileoverview PoliceApiService request boundary: per-call status accept-lists,
 * the decoded-byte ceiling, unreadable-body retries, the 503 area value and its
 * separately paced health probe, the 429 cooldown, the per-call budget, attempt
 * timeouts, cancellation and the pacer. Upstream is a route-table fake; retry
 * backoff, pacer waits and timeouts run on a virtual clock.
 * @module tests/services/police-api-service.boundary.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import type { MockContextLogger } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import {
  boundaryBody,
  categoriesBody,
  chunkedOk,
  emptyArrayOk,
  emptyNotFound,
  forceDetailBody,
  forcesBody,
  hang,
  htmlBadRequest,
  htmlOk,
  jsonOk,
  lastUpdatedBody,
  networkError,
  overloaded,
  plainNotFound,
  type Responder,
  rateLimited,
  sequence,
  sizedJsonBody,
  status,
  streamOfBytes,
  textOk,
} from '../fixtures/police-api-upstream.js';
import { settle, useServiceHarness } from '../fixtures/service-harness.js';

const MIB = 1024 * 1024;
const BODY_CEILING = 32 * MIB;

/** Resolves with the error a call rejects with; fails the test when it resolves. */
async function failure(promise: Promise<unknown>): Promise<McpError> {
  const error = await settle(promise).then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(McpError);
  return error as McpError;
}

/** Answers after `ms` of virtual time; rejects with the abort reason if the request is cancelled first, as a real fetch does. */
const delayed =
  (ms: number, respond: Responder): Responder =>
  (request) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        try {
          resolve(respond(request));
        } catch (error) {
          reject(error);
        }
      }, ms);
      request.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(request.signal.reason);
        },
        { once: true },
      );
    });

describe('PoliceApiService request boundary', () => {
  const h = useServiceHarness();

  const area = (params: Record<string, string> = { date: '2026-08' }, options = {}) =>
    h.service.queryArea(
      {
        path: '/crimes-street/all-crime',
        params,
        normalize: (json) => json as readonly number[],
        ...options,
      },
      h.ctx,
      h.budget(),
    );

  describe('per-call status accept-lists', () => {
    it.each([
      ['an empty-body 404', emptyNotFound],
      ['a text/plain "Not Found" 404', plainNotFound],
    ])('reads %s as a miss on a call that lists 404', async (_name, respond) => {
      h.upstream.route('GET', '/forces/btp', respond);
      const lookup = await settle(h.service.getForceDetail('btp', h.ctx, h.budget()));
      expect(lookup).toEqual({ kind: 'miss' });
      expect(h.upstream.count('/forces/btp')).toBe(1);
    });

    it('cancels the body of a 404 miss without reading it', async () => {
      let cancelled = false;
      h.upstream.route('GET', '/forces/btp', () => {
        const body = new ReadableStream<Uint8Array>({
          cancel() {
            cancelled = true;
          },
        });
        return new Response(body, { status: 404 });
      });
      await settle(h.service.getForceDetail('btp', h.ctx, h.budget()));
      expect(cancelled).toBe(true);
    });

    it('treats a 404 on a call that does not list it as NotFound, never retried', async () => {
      h.upstream.route('GET', '/forces', plainNotFound);
      const error = await failure(h.service.getForces(h.ctx, h.budget()));
      expect(error.code).toBe(JsonRpcErrorCode.NotFound);
      expect(error.data).toMatchObject({ status: 404 });
      expect(h.upstream.count('/forces')).toBe(1);
    });

    it('treats a 404 on an area route without notFoundIsMiss as NotFound (date before the window)', async () => {
      h.upstream.route('GET', '/crimes-street/all-crime', emptyNotFound);
      const error = await failure(area());
      expect(error.code).toBe(JsonRpcErrorCode.NotFound);
      expect(h.upstream.count('/crimes-street/all-crime')).toBe(1);
    });

    it('returns a miss for a 404 on an area route with notFoundIsMiss, and does not cache it', async () => {
      h.upstream.route('GET', '/crimes-street/all-crime', emptyNotFound);
      const first = await settle(area({ date: '2026-08' }, { notFoundIsMiss: true }));
      const second = await settle(area({ date: '2026-08' }, { notFoundIsMiss: true }));
      expect(first).toEqual({ kind: 'miss' });
      expect(second).toEqual({ kind: 'miss' });
      expect(h.upstream.count('/crimes-street/all-crime')).toBe(2);
    });

    it('treats 200 [] as an answer, found and cached', async () => {
      h.upstream.route('GET', '/crimes-street/all-crime', emptyArrayOk);
      const first = await settle(area());
      const second = await settle(area());
      expect(first).toEqual({ kind: 'found', value: [] });
      expect(second).toEqual({ kind: 'found', value: [] });
      expect(h.upstream.count('/crimes-street/all-crime')).toBe(1);
    });

    it('maps an HTML 400 to InvalidParams, never retries it, and logs it at error', async () => {
      h.upstream.route('GET', '/crimes-street/all-crime', htmlBadRequest);
      const error = await failure(area());
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(error.data).toMatchObject({ status: 400 });
      expect(h.upstream.count('/crimes-street/all-crime')).toBe(1);
      const log = h.ctx.log as MockContextLogger;
      expect(
        log.calls.some((call) => call.level === 'error' && call.msg.includes('HTTP 400')),
      ).toBe(true);
    });

    it('logs only the 400 contract bug at error level, not a 404 on an unlisted route', async () => {
      h.upstream.route('GET', '/forces', plainNotFound);
      await failure(h.service.getForces(h.ctx, h.budget()));
      const log = h.ctx.log as MockContextLogger;
      expect(log.calls.some((call) => call.level === 'error')).toBe(false);
    });

    it('treats a 503 on a non-area route as ServiceUnavailable and retries it', async () => {
      h.upstream.route('GET', '/forces', overloaded);
      const error = await failure(h.service.getForces(h.ctx, h.budget()));
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(h.upstream.count('/forces')).toBe(3);
    });

    it.each([500, 502, 504])('retries a %i and recovers on the next attempt', async (code) => {
      h.upstream.route('GET', '/forces', sequence(status(code), jsonOk(forcesBody())));
      const forces = await settle(h.service.getForces(h.ctx, h.budget()));
      expect(forces).toEqual(forcesBody());
      expect(h.upstream.count('/forces')).toBe(2);
    });

    it('gives up after three attempts on a persistent 502', async () => {
      h.upstream.route('GET', '/forces', status(502));
      const error = await failure(h.service.getForces(h.ctx, h.budget()));
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.message).toContain('failed after 3 attempts');
      expect(h.upstream.count('/forces')).toBe(3);
    });

    it('wraps a network failure as ServiceUnavailable, retried, with the cause kept', async () => {
      h.upstream.route('GET', '/forces', networkError);
      const error = await failure(h.service.getForces(h.ctx, h.budget()));
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.message).toContain('Could not reach data.police.uk');
      expect((error.cause as McpError).cause).toBeInstanceOf(TypeError);
      expect(h.upstream.count('/forces')).toBe(3);
    });

    it('sends GET with an accept header and no body', async () => {
      await settle(h.service.getForces(h.ctx, h.budget()));
      const [call] = h.upstream.callsTo('/forces');
      expect(call?.method).toBe('GET');
      expect(call?.headers.get('accept')).toBe('application/json');
      expect(call?.body).toBeUndefined();
    });
  });

  describe('unexpected response shapes', () => {
    it('fails a shape mismatch as non-retryable unexpected_response with at most five issues', async () => {
      h.upstream.route('GET', '/forces', jsonOk(Array.from({ length: 9 }, () => ({ id: 1 }))));
      const error = await failure(h.service.getForces(h.ctx, h.budget()));
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.data).toMatchObject({ reason: 'unexpected_response', retryable: false });
      const issues = (error.data as { issues: string[] }).issues;
      expect(issues).toHaveLength(5);
      expect(issues[0]).toMatch(/^0\.id: /);
      expect(h.upstream.count('/forces')).toBe(1);
    });

    it('names the route in the message and never echoes the upstream body', async () => {
      h.upstream.route('GET', '/crime-categories', jsonOk({ secret: 'upstream-only-text' }));
      const error = await failure(h.service.getCategories(h.ctx, h.budget()));
      expect(error.message).toContain('/crime-categories');
      expect(JSON.stringify(error.data)).not.toContain('upstream-only-text');
    });
  });

  describe('unreadable 200 bodies', () => {
    it.each([
      ['an HTML page', htmlOk],
      ['an empty body', textOk('')],
      ['truncated JSON', textOk('[{"id":"leicestershire","na')],
    ])('retries %s and recovers when the next answer parses', async (_name, bad) => {
      h.upstream.route('GET', '/forces', sequence(bad, bad, jsonOk(forcesBody())));
      const forces = await settle(h.service.getForces(h.ctx, h.budget()));
      expect(forces).toEqual(forcesBody());
      expect(h.upstream.count('/forces')).toBe(3);
    });

    it('fails unreadable_response after three attempts, with the parse error as the cause', async () => {
      h.upstream.route('GET', '/forces', htmlOk);
      const error = await failure(h.service.getForces(h.ctx, h.budget()));
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.data).toMatchObject({ reason: 'unreadable_response' });
      expect(error.message).toContain('failed after 3 attempts');
      expect(h.upstream.count('/forces')).toBe(3);
    });
  });

  describe('decoded-byte ceiling', () => {
    it('accepts a body of exactly 32 MiB', async () => {
      h.upstream.route('GET', '/crimes-street/all-crime', textOk(sizedJsonBody(BODY_CEILING)));
      const result = await settle(area());
      expect(result.kind).toBe('found');
    });

    it('answers an area body one byte over 32 MiB as area_too_large, neither retried nor probed', async () => {
      h.upstream.route('GET', '/crimes-street/all-crime', textOk(sizedJsonBody(BODY_CEILING + 1)));
      const error = await failure(area());
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.message).toContain('too large to answer');
      expect(error.data).toMatchObject({ reason: 'area_too_large' });
      expect(error.data).not.toHaveProperty('recovery');
      expect(h.upstream.count('/crimes-street/all-crime')).toBe(1);
      expect(h.upstream.count('/crime-last-updated')).toBe(0);
    });

    it('carries tooLargeHint as the recovery hint on an over-ceiling area body', async () => {
      const { respond } = streamOfBytes(64 * MIB, MIB);
      h.upstream.route('GET', '/crimes-street/all-crime', respond);
      const error = await failure(
        area({ date: '2026-08' }, { tooLargeHint: 'Try a smaller radius.' }),
      );
      expect(error.data).toMatchObject({
        reason: 'area_too_large',
        recovery: { hint: 'Try a smaller radius.' },
      });
    });

    it('stops reading and cancels the stream once the ceiling is crossed', async () => {
      const { respond, state } = streamOfBytes(200 * MIB, MIB);
      h.upstream.route('GET', '/crimes-street/all-crime', respond);
      const error = await failure(area());
      expect(error.data).toMatchObject({ reason: 'area_too_large' });
      expect(state.cancelled).toBe(true);
      expect(state.pulledBytes).toBeLessThan(BODY_CEILING + 4 * MIB);
    });

    it('refuses an over-ceiling body on a route that is not an area query as response_too_large, not retried', async () => {
      const { respond, state } = streamOfBytes(64 * MIB, MIB);
      h.upstream.route('GET', '/forces', respond);
      const error = await failure(h.service.getForces(h.ctx, h.budget()));
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.data).toMatchObject({ reason: 'response_too_large', retryable: false });
      expect(error.data).not.toHaveProperty('recovery');
      expect(state.cancelled).toBe(true);
      expect(h.upstream.count('/forces')).toBe(1);
    });

    it('decodes a multi-byte character split across chunks', async () => {
      const bytes = new TextEncoder().encode(
        JSON.stringify([{ id: 'cote', name: 'Côte Constabulary' }]),
      );
      const split = bytes.indexOf(0xc3) + 1;
      h.upstream.route('GET', '/forces', chunkedOk([bytes.slice(0, split), bytes.slice(split)]));
      const forces = await settle(h.service.getForces(h.ctx, h.budget()));
      expect(forces).toEqual([{ id: 'cote', name: 'Côte Constabulary' }]);
    });

    it('counts decoded bytes, so multi-byte text is measured by its encoded size', async () => {
      // 17 MiB of 2-byte characters is 34 MiB decoded but only ~17 M characters.
      const body = `["${'é'.repeat(17 * MIB)}"]`;
      h.upstream.route('GET', '/crimes-street/all-crime', textOk(body));
      const error = await failure(area());
      expect(error.data).toMatchObject({ reason: 'area_too_large' });
    });
  });

  describe('503 on an area route and its health probe', () => {
    it('answers area_too_large when the probe answers 200, without retrying the area query', async () => {
      h.upstream.route('GET', '/crimes-street/all-crime', overloaded);
      const error = await failure(area());
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data).toMatchObject({ reason: 'area_too_large' });
      expect(error.data).not.toHaveProperty('recovery');
      expect(h.upstream.count('/crimes-street/all-crime')).toBe(1);
      expect(h.upstream.count('/crime-last-updated')).toBe(1);
    });

    it('carries tooLargeHint as the recovery hint when given', async () => {
      h.upstream.route('GET', '/crimes-street/all-crime', overloaded);
      const error = await failure(
        area({ date: '2026-08' }, { tooLargeHint: 'Try a smaller radius.' }),
      );
      expect(error.data).toMatchObject({
        reason: 'area_too_large',
        recovery: { hint: 'Try a smaller radius.' },
      });
    });

    it('sends the probe as a plain GET of /crime-last-updated after the area request', async () => {
      h.upstream.route('GET', '/crimes-street/all-crime', overloaded);
      await failure(area());
      expect(h.upstream.calls.map((call) => call.path)).toEqual([
        '/crimes-street/all-crime',
        '/crime-last-updated',
      ]);
      expect(h.upstream.callsTo('/crime-last-updated')[0]?.query.size).toBe(0);
    });

    it.each([
      ['a 500', status(500)],
      ['a 503', overloaded],
      ['a 404', emptyNotFound],
      ['a 429', rateLimited('1')],
      ['a network error', networkError],
      ['a 200 whose body is not JSON', htmlOk],
    ])(
      'answers upstream_unavailable, retryable, when the probe gets %s — and never retries the probe',
      async (_name, probe) => {
        h.upstream.route('GET', '/crimes-street/all-crime', overloaded);
        h.upstream.route('GET', '/crime-last-updated', probe);
        const error = await failure(area());
        expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
        expect(error.data).toMatchObject({ reason: 'upstream_unavailable', retryable: true });
        expect(h.upstream.count('/crimes-street/all-crime')).toBe(1);
        expect(h.upstream.count('/crime-last-updated')).toBe(1);
      },
    );

    it('answers upstream_unavailable when the probe times out, after the attempt timeout', async () => {
      h.upstream.route('GET', '/crimes-street/all-crime', overloaded);
      h.upstream.route('GET', '/crime-last-updated', hang);
      const start = Date.now();
      const error = await failure(area());
      expect(error.data).toMatchObject({ reason: 'upstream_unavailable' });
      expect(Date.now() - start).toBeGreaterThanOrEqual(30_000);
      expect(Date.now() - start).toBeLessThan(31_000);
      expect(h.upstream.count('/crime-last-updated')).toBe(1);
    });

    it('bounds the probe by what remains of the call budget', async () => {
      h.upstream.route('GET', '/crimes-street/all-crime', overloaded);
      h.upstream.route('GET', '/crime-last-updated', hang);
      const budget = { deadlineAt: Date.now() + 4000 };
      const start = Date.now();
      const error = await failure(
        h.service.queryArea(
          { path: '/crimes-street/all-crime', params: { date: '2026-08' }, normalize: () => [] },
          h.ctx,
          budget,
        ),
      );
      expect(error.data).toMatchObject({ reason: 'upstream_unavailable' });
      expect(Date.now() - start).toBeLessThanOrEqual(4100);
    });

    it('skips the probe and answers upstream_unavailable when the budget is already spent', async () => {
      const budget = { deadlineAt: Date.now() + 1000 };
      h.upstream.route('GET', '/crimes-street/all-crime', () => {
        vi.setSystemTime(Date.now() + 5000);
        return new Response(null, { status: 503 });
      });
      const error = await failure(
        h.service.queryArea(
          { path: '/crimes-street/all-crime', params: { date: '2026-08' }, normalize: () => [] },
          h.ctx,
          budget,
        ),
      );
      expect(error.data).toMatchObject({ reason: 'upstream_unavailable', retryable: true });
      expect(h.upstream.count('/crime-last-updated')).toBe(0);
    });

    it('logs the 503 at notice with the probe verdict', async () => {
      h.upstream.route('GET', '/crimes-street/all-crime', overloaded);
      await failure(area());
      const log = h.ctx.log as MockContextLogger;
      expect(log.calls).toContainEqual(
        expect.objectContaining({
          level: 'notice',
          data: { path: '/crimes-street/all-crime', upstreamHealthy: true },
        }),
      );
    });

    it('does not cache a 503: the next identical query asks upstream again', async () => {
      h.upstream.route('GET', '/crimes-street/all-crime', sequence(overloaded, jsonOk([1, 2])));
      await failure(area());
      const second = await settle(area());
      expect(second).toEqual({ kind: 'found', value: [1, 2] });
      expect(h.upstream.count('/crimes-street/all-crime')).toBe(2);
    });

    it('does not deadlock when every pacer slot is held by an area query that answers 503', async () => {
      h.upstream.route('GET', '/crimes-street/all-crime', overloaded);
      const results = await settle(
        Promise.allSettled(
          Array.from({ length: 12 }, (_, i) => area({ date: '2026-08', n: String(i) })),
        ),
      );
      for (const result of results) {
        expect(result.status).toBe('rejected');
        expect((result as PromiseRejectedResult).reason.data).toMatchObject({
          reason: 'area_too_large',
        });
      }
      expect(h.upstream.count('/crime-last-updated')).toBe(12);
    });

    it('rethrows the abort, rather than answering upstream_unavailable, when the call is cancelled during the probe', async () => {
      const controller = new AbortController();
      const reason = new Error('client went away');
      h.upstream.route('GET', '/crimes-street/all-crime', overloaded);
      h.upstream.route('GET', '/crime-last-updated', hang);
      const call = h.service.queryArea(
        { path: '/crimes-street/all-crime', params: { date: '2026-08' }, normalize: () => [] },
        h.ctxWith(controller.signal),
        h.budget(),
      );
      const outcome = call.then(
        () => 'resolved',
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(2000);
      controller.abort(reason);
      expect(await settle(outcome)).toBe(reason);
    });
  });

  describe('429 and the pacer cooldown', () => {
    it('honors Retry-After exactly, and starts the retry no earlier', async () => {
      h.upstream.route('GET', '/forces', sequence(rateLimited('3'), jsonOk(forcesBody())));
      await settle(h.service.getForces(h.ctx, h.budget()));
      const [first, second] = h.upstream.callsTo('/forces');
      expect(second && first ? second.at - first.at : 0).toBeGreaterThanOrEqual(3000);
      expect(second && first ? second.at - first.at : 0).toBeLessThan(3500);
    });

    it('falls back to backoff and the cooldown gate when Retry-After is absent', async () => {
      h.upstream.route('GET', '/forces', sequence(rateLimited(), jsonOk(forcesBody())));
      await settle(h.service.getForces(h.ctx, h.budget()));
      const [first, second] = h.upstream.callsTo('/forces');
      const gap = (second?.at ?? 0) - (first?.at ?? 0);
      expect(gap).toBeGreaterThanOrEqual(1000);
      expect(gap).toBeLessThanOrEqual(1250);
    });

    it('doubles the cooldown on consecutive rate limits and gives up after three attempts', async () => {
      h.upstream.route('GET', '/forces', rateLimited());
      const error = await failure(h.service.getForces(h.ctx, h.budget()));
      expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
      expect(error.message).toContain('failed after 3 attempts');
      const [a, b, c] = h.upstream.callsTo('/forces');
      expect((b?.at ?? 0) - (a?.at ?? 0)).toBeGreaterThanOrEqual(1000);
      expect((c?.at ?? 0) - (b?.at ?? 0)).toBeGreaterThanOrEqual(2000);
      expect((c?.at ?? 0) - (b?.at ?? 0)).toBeLessThanOrEqual(2500);
    });

    it('fails fast, untouched, when Retry-After is longer than the 10 s retry cap', async () => {
      h.upstream.route('GET', '/forces', rateLimited('60'));
      const start = Date.now();
      const error = await failure(h.service.getForces(h.ctx, h.budget()));
      expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
      expect(error.data).toMatchObject({ retryAfter: '60', status: 429 });
      expect(h.upstream.count('/forces')).toBe(1);
      expect(Date.now() - start).toBeLessThan(1000);
    });

    it('waits a Retry-After of exactly 10 s rather than failing fast', async () => {
      h.upstream.route('GET', '/forces', sequence(rateLimited('10'), jsonOk(forcesBody())));
      await settle(h.service.getForces(h.ctx, h.budget()));
      const [first, second] = h.upstream.callsTo('/forces');
      expect((second?.at ?? 0) - (first?.at ?? 0)).toBeGreaterThanOrEqual(10_000);
    });

    it('holds every queued request behind the shared cooldown gate, not just the retry', async () => {
      h.upstream.route('GET', '/forces', sequence(rateLimited('5'), jsonOk(forcesBody())));
      const limited = h.service.getForces(h.ctx, h.budget());
      await vi.advanceTimersByTimeAsync(1000);
      const bystander = h.service.getCategories(h.ctx, h.budget());
      await settle(Promise.all([limited, bystander]));
      const [other] = h.upstream.callsTo('/crime-categories');
      const [first] = h.upstream.callsTo('/forces');
      expect((other?.at ?? 0) - (first?.at ?? 0)).toBeGreaterThanOrEqual(5000);
    });

    it('shows the 429 header on the error when attempts run out within the cap', async () => {
      h.upstream.route('GET', '/forces', rateLimited('2'));
      const error = await failure(h.service.getForces(h.ctx, h.budget()));
      expect(error.data).toMatchObject({ retryAfter: '2', retryAttempts: 3 });
    });
  });

  describe('attempt timeout, call budget and cancellation', () => {
    it('times an attempt out at 30 s and retries', async () => {
      h.upstream.route('GET', '/forces', sequence(hang, jsonOk(forcesBody())));
      const forces = await settle(h.service.getForces(h.ctx, h.budget()));
      expect(forces).toEqual(forcesBody());
      const [first, second] = h.upstream.callsTo('/forces');
      expect((second?.at ?? 0) - (first?.at ?? 0)).toBeGreaterThanOrEqual(30_000);
    });

    it('classifies a call that never answers as Timeout, inside the 45 s service deadline', async () => {
      h.upstream.route('GET', '/forces', hang);
      const start = Date.now();
      const error = await failure(h.service.getForces(h.ctx, h.budget()));
      expect(error.code).toBe(JsonRpcErrorCode.Timeout);
      expect(Date.now() - start).toBeLessThanOrEqual(45_500);
    });

    it('opens a 50 s budget on the service clock', () => {
      expect(h.service.openBudget()).toEqual({ deadlineAt: Date.now() + 50_000 });
    });

    it('refuses a call whose budget is already spent, without sending anything', async () => {
      const error = await failure(h.service.getForces(h.ctx, { deadlineAt: Date.now() }));
      expect(error.code).toBe(JsonRpcErrorCode.Timeout);
      expect(error.data).toMatchObject({ reason: 'call_budget_exhausted' });
      expect(h.upstream.calls).toHaveLength(0);
    });

    it('spends the budget across calls: a call opened late has none left', async () => {
      const budget = h.budget();
      await vi.advanceTimersByTimeAsync(50_001);
      const error = await failure(h.service.getCategories(h.ctx, budget));
      expect(error.data).toMatchObject({ reason: 'call_budget_exhausted' });
      expect(h.upstream.calls).toHaveLength(0);
    });

    it('bounds a hanging call by the remaining budget, shorter than the attempt timeout', async () => {
      h.upstream.route('GET', '/forces', hang);
      const start = Date.now();
      const error = await failure(h.service.getForces(h.ctx, { deadlineAt: Date.now() + 5000 }));
      expect(error.code).toBe(JsonRpcErrorCode.Timeout);
      expect(Date.now() - start).toBeLessThanOrEqual(5100);
    });

    it('lets sequential slow calls share one budget until it runs out', async () => {
      h.upstream.route('GET', '/forces', delayed(20_000, jsonOk(forcesBody())));
      h.upstream.route('GET', '/crime-categories', delayed(20_000, jsonOk(categoriesBody())));
      h.upstream.route('GET', '/forces/leicestershire', delayed(20_000, jsonOk(forceDetailBody())));
      const budget = h.budget();
      const start = Date.now();
      await settle(h.service.getForces(h.ctx, budget));
      await settle(h.service.getCategories(h.ctx, budget));
      const error = await failure(h.service.getForceDetail('leicestershire', h.ctx, budget));
      expect(error.code).toBe(JsonRpcErrorCode.Timeout);
      expect(Date.now() - start).toBeLessThanOrEqual(50_200);
    });

    it('rejects with the abort reason and does not retry when the caller cancels mid-request', async () => {
      const controller = new AbortController();
      const reason = new Error('client went away');
      h.upstream.route('GET', '/forces', hang);
      const call = h.service.getForces(h.ctxWith(controller.signal), h.budget());
      const outcome = call.then(
        () => 'resolved',
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(1000);
      controller.abort(reason);
      expect(await settle(outcome)).toBe(reason);
      expect(h.upstream.count('/forces')).toBe(1);
    });

    it('does not send a request when the call is cancelled before it starts', async () => {
      const controller = new AbortController();
      controller.abort(new Error('already gone'));
      const call = h.service.getForces(h.ctxWith(controller.signal), h.budget());
      await expect(settle(call)).rejects.toThrow('already gone');
      expect(h.upstream.calls).toHaveLength(0);
    });
  });

  describe('process-wide pacer', () => {
    it('never has more than four requests in flight and never starts more than fifteen in a second', async () => {
      let inFlight = 0;
      let peak = 0;
      h.upstream.route('GET', '/crime-last-updated', jsonOk(lastUpdatedBody()));
      for (let i = 0; i < 40; i++) {
        h.upstream.route('GET', `/leicestershire/NX${i}/boundary`, async (request) => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise<void>((resolve) => setTimeout(resolve, 100));
          inFlight -= 1;
          return jsonOk(boundaryBody())(request);
        });
      }
      const lookups = await settle(
        Promise.all(
          Array.from({ length: 40 }, (_, i) =>
            h.service.getBoundary('leicestershire', `NX${i}`, h.ctx, h.budget()),
          ),
        ),
      );
      expect(lookups.every((lookup) => lookup.kind === 'found')).toBe(true);
      expect(peak).toBe(4);
      const starts = h.upstream.calls.map((call) => call.at);
      for (const start of starts) {
        const inWindow = starts.filter((at) => at >= start && at < start + 1000).length;
        expect(inWindow).toBeLessThanOrEqual(15);
      }
      expect(Math.max(...starts) - Math.min(...starts)).toBeGreaterThanOrEqual(1000);
    });
  });
});
