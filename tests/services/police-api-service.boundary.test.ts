/**
 * @fileoverview PoliceApiService request boundary: per-call status accept-lists,
 * failure text written from the status alone, redirects refused, tag characters
 * dropped at the parse, the decoded-byte ceiling, unreadable-body retries, the
 * 503 area value and its separately paced health probe, the 429 cooldown, the
 * per-call budget, attempt timeouts, cancellation, and the pacer with its three
 * area slots. Upstream is a route-table fake; retry backoff, pacer waits and
 * timeouts run on a virtual clock. The last block checks that harness: the
 * clock holds while a digest runs, and a hanging request survives a garbage
 * collection.
 * @module tests/services/police-api-service.boundary.test
 */

import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import type { MockContextLogger } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { outcomesQuery } from '@/services/police-api/area.js';
import type { Place } from '@/services/police-api/types.js';
import {
  API_BASE,
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
  locateBody,
  networkError,
  overloaded,
  perMonth,
  plainNotFound,
  type Responder,
  rateLimited,
  rateLimitedUntil,
  sequence,
  sizedJsonBody,
  status,
  streamOfBytes,
  textOk,
} from '../fixtures/police-api-upstream.js';
import { settle, untilReal, useServiceHarness } from '../fixtures/service-harness.js';

const MIB = 1024 * 1024;
const BODY_CEILING = 32 * MIB;

const RATE_LIMITED_HINT = (seconds: number) =>
  `data.police.uk is rate-limiting this server; call again in ${seconds} s.`;
const UNAVAILABLE_HINT = (seconds: number) =>
  `data.police.uk is not answering right now; call again in ${seconds} s.`;
const SHED_HINT = (seconds: number) =>
  `This server's queue for data.police.uk is busy; call again in ${seconds} s.`;
const OUTCOMES_DEADLINE_HINT =
  "data.police.uk is still preparing this month's outcomes, which can take longer than one call allows when the month has not been asked for recently; run the same search again shortly and it usually succeeds.";

/**
 * Real time allowed a test whose virtual wait runs past 30 s: `settle` covers it
 * in hundreds of 50 ms steps, which a loaded machine can stretch past Vitest's
 * 5 s default. The virtual-time assertions are what such a test proves.
 */
const LONG_VIRTUAL_WAIT_TIMEOUT_MS = 60_000;

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
      expect(first).toEqual({ kind: 'found', value: [], weight: 2.5 });
      expect(second).toEqual({ kind: 'found', value: [], weight: 2.5 });
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

  describe('failure text', () => {
    /** A refusal carrying an upstream reason phrase and body, neither of which a caller should see. */
    const wordy =
      (code: number): Responder =>
      () =>
        new Response('upstream-body-text', { status: code, statusText: 'Upstream reason phrase' });

    it.each([500, 502, 400, 403, 429])(
      'names only the HTTP status in the message of a %i, with no reason phrase or body in data',
      async (code) => {
        h.upstream.route('GET', '/forces', wordy(code));
        const error = await failure(h.service.getForces(h.ctx, h.budget()));
        expect(error.message).toMatch(new RegExp(`^data\\.police\\.uk returned HTTP ${code}\\.`));
        expect(error.data).toMatchObject({ status: code });
        expect(error.data).not.toHaveProperty('statusText');
        expect(error.data).not.toHaveProperty('body');
        expect(error.data).not.toHaveProperty('responseBody');
        const seen = JSON.stringify({ message: error.message, data: error.data });
        expect(seen).not.toContain('Upstream reason phrase');
        expect(seen).not.toContain('upstream-body-text');
      },
    );

    it('cancels the body of a refusal without reading it', async () => {
      let cancelled = false;
      h.upstream.route('GET', '/forces', () => {
        const body = new ReadableStream<Uint8Array>({
          cancel() {
            cancelled = true;
          },
        });
        return new Response(body, { status: 400 });
      });
      await failure(h.service.getForces(h.ctx, h.budget()));
      expect(cancelled).toBe(true);
    });

    it('keeps the reason phrase out of the 400 it logs at error', async () => {
      h.upstream.route('GET', '/forces', wordy(400));
      const error = await failure(h.service.getForces(h.ctx, h.budget()));
      expect(error.message).toBe('data.police.uk returned HTTP 400.');
      const log = h.ctx.log as MockContextLogger;
      expect(log.calls.filter((call) => call.level === 'error')).toHaveLength(1);
    });
  });

  describe('redirects', () => {
    it('sends GET and POST requests with redirect: manual', async () => {
      h.upstream.route('POST', '/crimes-street/all-crime', emptyArrayOk);
      await settle(h.service.getForces(h.ctx, h.budget()));
      await settle(area({ date: '2026-08', poly: '52,-1:52.1,-1:52,-1.1' }, { method: 'POST' }));
      expect(h.upstream.calls.map((call) => [call.method, call.redirect])).toEqual([
        ['GET', 'manual'],
        ['POST', 'manual'],
      ]);
    });

    it.each([301, 302, 303, 307, 308])(
      'fails a %i as unexpected_redirect, not retried, naming the status and never the Location',
      async (code) => {
        h.upstream.route(
          'GET',
          '/forces',
          () =>
            new Response(null, {
              status: code,
              headers: { location: 'https://elsewhere.example/landing?token=abc' },
            }),
        );
        const error = await failure(h.service.getForces(h.ctx, h.budget()));
        expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
        expect(error.data).toMatchObject({
          reason: 'unexpected_redirect',
          status: code,
          retryable: false,
        });
        expect(error.message).toContain(`HTTP ${code}`);
        expect(JSON.stringify({ message: error.message, data: error.data })).not.toContain(
          'elsewhere.example',
        );
        expect(h.upstream.count('/forces')).toBe(1);
      },
    );

    it('fails a redirect on an area route the same way, without a health probe', async () => {
      h.upstream.route(
        'GET',
        '/crimes-street/all-crime',
        () =>
          new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/' } }),
      );
      const error = await failure(area());
      expect(error.data).toMatchObject({ reason: 'unexpected_redirect', status: 302 });
      expect(h.upstream.count('/crimes-street/all-crime')).toBe(1);
      expect(h.upstream.count('/crime-last-updated')).toBe(0);
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

  describe('tag characters in a 200 body', () => {
    it('drops literal tag characters from every string value', async () => {
      h.upstream.route(
        'GET',
        '/forces',
        jsonOk([
          { id: 'leicestershire', name: 'Leicestershire\u{E0049}\u{E0047}\u{E004E} Police' },
        ]),
      );
      const forces = await settle(h.service.getForces(h.ctx, h.budget()));
      expect(forces).toEqual([{ id: 'leicestershire', name: 'Leicestershire Police' }]);
    });

    it('drops tag characters written as escaped surrogate pairs, in either case', async () => {
      h.upstream.route(
        'GET',
        '/forces',
        textOk(
          '[{"id":"leicestershire","name":"Leicestershire\\udb40\\udc49\\uDB40\\uDC47 Police"}]',
        ),
      );
      const forces = await settle(h.service.getForces(h.ctx, h.budget()));
      expect(forces).toEqual([{ id: 'leicestershire', name: 'Leicestershire Police' }]);
    });

    it('drops them from object keys too, so a contact channel name carries none', async () => {
      h.upstream.route(
        'GET',
        '/leicestershire/NX01',
        textOk(
          `{"id":"NX01","name":"Example\u{E0041} Central","contact_details":{"e\\udb40\\udc41mail":"nx01@example.test\\udb40\\udc7f"}}`,
        ),
      );
      const result = await settle(
        h.service.getNeighbourhood('leicestershire', 'NX01', h.ctx, h.budget()),
      );
      expect(result).toMatchObject({
        kind: 'found',
        value: {
          name: 'Example Central',
          contact: [{ channel: 'email', value: 'nx01@example.test' }],
        },
      });
    });

    it('keeps every other character as received, invisible ones included', async () => {
      const name = 'Leicestershire\u{200B}\u{2060}\u{FEFF}\u{202E} Police\u{1F46E}';
      h.upstream.route('GET', '/forces', jsonOk([{ id: 'leicestershire', name }]));
      const forces = await settle(h.service.getForces(h.ctx, h.budget()));
      expect(forces).toEqual([{ id: 'leicestershire', name }]);
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

    it('names the month refused in the over-ceiling message', async () => {
      h.upstream.route('GET', '/crimes-street/all-crime', textOk(sizedJsonBody(BODY_CEILING + 1)));
      const error = await failure(area({ date: '2026-05' }));
      expect(error.message).toBe(
        'data.police.uk answered this area for 2026-05 with more than the 32 MiB this server reads for one area, so the area is too large to answer.',
      );
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

    it('names the month refused when the probe answers 200', async () => {
      h.upstream.route('GET', '/crimes-street/all-crime', overloaded);
      const error = await failure(area({ date: '2026-05' }));
      expect(error.message).toBe(
        'data.police.uk refused this area for 2026-05 as too large to answer, though the service itself is up.',
      );
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
      expect(second).toEqual({ kind: 'found', value: [1, 2], weight: 6.25 });
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

    it('fails at once after one request as rate_limited when Retry-After outlasts the 45 s service-call deadline, naming the wait', async () => {
      h.upstream.route('GET', '/forces', rateLimited('60'));
      const start = Date.now();
      const error = await failure(h.service.getForces(h.ctx, h.budget()));
      expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
      expect(error.message).toBe('data.police.uk returned HTTP 429.');
      expect(error.data).toMatchObject({
        reason: 'rate_limited',
        retryable: true,
        retryAfter: '60',
        status: 429,
        recovery: { hint: RATE_LIMITED_HINT(60) },
      });
      expect(h.upstream.count('/forces')).toBe(1);
      expect(Date.now() - start).toBeLessThan(1000);
    });

    it('waits out a Retry-After of 30 s that fits the deadline, outside the pacer, and succeeds', async () => {
      h.upstream.route('GET', '/forces', sequence(rateLimited('30'), jsonOk(forcesBody())));
      const forces = await settle(h.service.getForces(h.ctx, h.budget()));
      expect(forces).toEqual(forcesBody());
      const [first, second] = h.upstream.callsTo('/forces');
      expect((second?.at ?? 0) - (first?.at ?? 0)).toBeGreaterThanOrEqual(30_000);
      expect((second?.at ?? 0) - (first?.at ?? 0)).toBeLessThan(30_500);
    });

    it('waits a Retry-After of 34 s, which leaves the next attempt 11 s of the 45 s deadline', async () => {
      h.upstream.route('GET', '/forces', sequence(rateLimited('34'), jsonOk(forcesBody())));
      const forces = await settle(h.service.getForces(h.ctx, h.budget()), 200);
      expect(forces).toEqual(forcesBody());
      const [first, second] = h.upstream.callsTo('/forces');
      expect((second?.at ?? 0) - (first?.at ?? 0)).toBeGreaterThanOrEqual(34_000);
      expect((second?.at ?? 0) - (first?.at ?? 0)).toBeLessThan(34_500);
    });

    it.each(['36', '44'])(
      'fails a Retry-After of %s s at once, after one request, as rate_limited naming it: the next attempt would have under 10 s',
      async (seconds) => {
        h.upstream.route('GET', '/forces', sequence(rateLimited(seconds), jsonOk(forcesBody())));
        const start = Date.now();
        const error = await failure(h.service.getForces(h.ctx, h.budget()));
        expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
        expect(error.data).toMatchObject({
          reason: 'rate_limited',
          retryable: true,
          retryAfter: seconds,
          recovery: { hint: RATE_LIMITED_HINT(Number(seconds)) },
        });
        expect(h.upstream.count('/forces')).toBe(1);
        expect(Date.now() - start).toBeLessThan(1000);
      },
    );

    it('fails a 44 s Retry-After at once rather than waiting into a 5 s answer the deadline would cut off', async () => {
      h.upstream.route(
        'GET',
        '/forces',
        sequence(rateLimited('44'), delayed(5_000, jsonOk(forcesBody()))),
      );
      const start = Date.now();
      const error = await failure(h.service.getForces(h.ctx, h.budget()));
      expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
      expect(error.data).toMatchObject({
        reason: 'rate_limited',
        retryable: true,
        recovery: { hint: RATE_LIMITED_HINT(44) },
      });
      expect(h.upstream.count('/forces')).toBe(1);
      expect(Date.now() - start).toBeLessThan(1000);
    });

    it('fails the callers the closed cooldown gate held to 15 s at once, while the first waits out its 30 s and succeeds', async () => {
      const path = '/crimes-street/all-crime';
      let served = 0;
      h.upstream.route('GET', path, (request) => {
        served += 1;
        return served <= 3 ? rateLimited('30')(request) : emptyArrayOk(request);
      });
      const point = (i: number) =>
        h.service
          .queryArea(
            {
              path,
              params: { date: '2026-08', lat: String(52.6 + i / 100), lng: '-1.13' },
              normalize: (json) => json as readonly number[],
            },
            h.ctx,
            h.budget(),
          )
          .then(
            (value) => ({ at: Date.now(), value }),
            (error: unknown) => ({ at: Date.now(), error }),
          );
      const start = Date.now();
      const first = point(0);
      // The first 429 closes the cooldown gate before the other two callers queue.
      await untilReal(() => h.upstream.count(path) === 1);
      const [a, b, c] = await settle(Promise.all([first, point(1), point(2)]), 200);
      expect(a).toMatchObject({ value: { kind: 'found', value: [] } });
      expect(a.at - start).toBeGreaterThanOrEqual(30_000);
      for (const held of [b, c]) {
        expect(held).toHaveProperty('error');
        const error = (held as { error: McpError }).error;
        expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
        expect(error.data).toMatchObject({
          reason: 'rate_limited',
          retryable: true,
          recovery: { hint: RATE_LIMITED_HINT(30) },
        });
        expect(held.at - start).toBeGreaterThanOrEqual(15_000);
        expect(held.at - start).toBeLessThan(16_000);
      }
      // One request each from the held callers; the first sent two.
      const sent = h.upstream.callsTo(path).map((call) => call.at - start);
      expect(sent).toHaveLength(4);
      expect(sent.filter((at) => at >= 15_000 && at < 16_000)).toHaveLength(2);
    });

    it('measures the wait against what remains of the call budget, not the full 45 s', async () => {
      h.upstream.route('GET', '/forces', rateLimited('25'));
      const error = await failure(h.service.getForces(h.ctx, { deadlineAt: Date.now() + 20_000 }));
      expect(error.data).toMatchObject({
        reason: 'rate_limited',
        recovery: { hint: RATE_LIMITED_HINT(25) },
      });
      expect(h.upstream.count('/forces')).toBe(1);
    });

    it('fails after the second attempt as rate_limited, naming the wait, when every attempt asks for 30 s', async () => {
      h.upstream.route('GET', '/forces', rateLimited('30'));
      const error = await failure(h.service.getForces(h.ctx, h.budget()));
      expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
      expect(error.data).toMatchObject({
        reason: 'rate_limited',
        retryable: true,
        retryAfter: '30',
        status: 429,
        recovery: { hint: RATE_LIMITED_HINT(30) },
      });
      const [first, second] = h.upstream.callsTo('/forces');
      expect(h.upstream.count('/forces')).toBe(2);
      expect((second?.at ?? 0) - (first?.at ?? 0)).toBeGreaterThanOrEqual(30_000);
    });

    it('waits out an HTTP-date Retry-After the same way', async () => {
      h.upstream.route('GET', '/forces', sequence(rateLimitedUntil(30_000), jsonOk(forcesBody())));
      const forces = await settle(h.service.getForces(h.ctx, h.budget()));
      expect(forces).toEqual(forcesBody());
      const [first, second] = h.upstream.callsTo('/forces');
      // An HTTP-date has whole-second resolution.
      expect((second?.at ?? 0) - (first?.at ?? 0)).toBeGreaterThanOrEqual(29_000);
      expect((second?.at ?? 0) - (first?.at ?? 0)).toBeLessThan(30_500);
    });

    it('names an HTTP-date Retry-After in seconds when it does not fit, keeping the raw header', async () => {
      h.upstream.route('GET', '/forces', rateLimitedUntil(30_000));
      const error = await failure(h.service.getForces(h.ctx, h.budget()));
      expect(error.data).toMatchObject({
        reason: 'rate_limited',
        retryable: true,
        retryAfter: expect.stringMatching(/ GMT$/),
        recovery: { hint: RATE_LIMITED_HINT(30) },
      });
      expect(h.upstream.count('/forces')).toBe(2);
    });

    it('rounds a wait up to whole seconds: an HTTP-date 59.7 s ahead is named as 60 s, not 59', async () => {
      // The 429 arrives 300 ms into a second; the header's date has whole-second resolution.
      vi.setSystemTime(Date.now() + 300);
      h.upstream.route('GET', '/forces', rateLimitedUntil(60_000));
      const error = await failure(h.service.getForces(h.ctx, h.budget()));
      expect(error.data).toMatchObject({
        reason: 'rate_limited',
        recovery: { hint: RATE_LIMITED_HINT(60) },
      });
      expect(h.upstream.count('/forces')).toBe(1);
    });

    it('fails rate_limited with no hint of its own once attempts run out on a 429 with no Retry-After', async () => {
      h.upstream.route('GET', '/forces', rateLimited());
      const error = await failure(h.service.getForces(h.ctx, h.budget()));
      expect(error.data).toMatchObject({
        reason: 'rate_limited',
        retryable: true,
        retryAttempts: 3,
      });
      expect(error.data).not.toHaveProperty('retryAfter');
      expect(error.data).not.toHaveProperty('recovery');
      expect(h.upstream.count('/forces')).toBe(3);
    });

    it('ends at once with the abort reason, sending nothing more, when the call is cancelled during the wait', async () => {
      const controller = new AbortController();
      const reason = new Error('client went away');
      h.upstream.route('GET', '/forces', sequence(rateLimited('30'), jsonOk(forcesBody())));
      const start = Date.now();
      const outcome = h.service.getForces(h.ctxWith(controller.signal), h.budget()).then(
        () => 'resolved',
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(10_000);
      controller.abort(reason);
      expect(await settle(outcome)).toBe(reason);
      expect(Date.now() - start).toBeLessThan(10_500);
      expect(h.upstream.count('/forces')).toBe(1);
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

    it('shows the 429 header on the error when attempts run out on short waits', async () => {
      h.upstream.route('GET', '/forces', rateLimited('2'));
      const error = await failure(h.service.getForces(h.ctx, h.budget()));
      expect(error.data).toMatchObject({
        retryAfter: '2',
        retryAttempts: 3,
        reason: 'rate_limited',
        recovery: { hint: RATE_LIMITED_HINT(2) },
      });
    });
  });

  describe('failures that outlast the retries', () => {
    it.each([500, 502, 503, 504])(
      'fails a persistent %i as upstream_unavailable, retryable, after three attempts, keeping the status',
      async (code) => {
        h.upstream.route('GET', '/forces', status(code));
        const error = await failure(h.service.getForces(h.ctx, h.budget()));
        expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
        expect(error.message).toBe(
          `data.police.uk returned HTTP ${code}. (failed after 3 attempts)`,
        );
        expect(error.data).toMatchObject({
          reason: 'upstream_unavailable',
          retryable: true,
          status: code,
          retryAttempts: 3,
        });
        // The calling tool's declared recovery fills the hint.
        expect(error.data).not.toHaveProperty('recovery');
        expect(h.upstream.count('/forces')).toBe(3);
      },
    );

    it(
      'names the wait of a 503 whose Retry-After it waited out once and could not again: upstream_unavailable after two requests',
      async () => {
        h.upstream.route('GET', '/forces', status(503, '30'));
        const error = await failure(h.service.getForces(h.ctx, h.budget()));
        expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
        expect(error.data).toMatchObject({
          reason: 'upstream_unavailable',
          retryable: true,
          status: 503,
          retryAfter: '30',
          recovery: { hint: UNAVAILABLE_HINT(30) },
        });
        const [first, second] = h.upstream.callsTo('/forces');
        expect(h.upstream.count('/forces')).toBe(2);
        expect((second?.at ?? 0) - (first?.at ?? 0)).toBeGreaterThanOrEqual(30_000);
      },
      LONG_VIRTUAL_WAIT_TIMEOUT_MS,
    );

    it.each([502, 504])(
      'names the short Retry-After of a %i still failing after three attempts',
      async (code) => {
        h.upstream.route('GET', '/forces', status(code, '2'));
        const error = await failure(h.service.getForces(h.ctx, h.budget()));
        expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
        expect(error.data).toMatchObject({
          reason: 'upstream_unavailable',
          retryable: true,
          retryAttempts: 3,
          retryAfter: '2',
          recovery: { hint: UNAVAILABLE_HINT(2) },
        });
        expect(h.upstream.count('/forces')).toBe(3);
      },
    );

    it('fails a network failure that outlasts the retries as upstream_unavailable, keeping its cause', async () => {
      h.upstream.route('GET', '/forces', networkError);
      const error = await failure(h.service.getForces(h.ctx, h.budget()));
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.message).toBe('Could not reach data.police.uk. (failed after 3 attempts)');
      expect(error.data).toMatchObject({ reason: 'upstream_unavailable', retryable: true });
      expect((error.cause as McpError).cause).toBeInstanceOf(TypeError);
      expect(h.upstream.count('/forces')).toBe(3);
    });

    it(
      'fails a request that never answers at the 45 s deadline as retry_deadline_exceeded, retryable',
      async () => {
        h.upstream.route('GET', '/forces', hang);
        const start = Date.now();
        const error = await failure(h.service.getForces(h.ctx, h.budget()));
        expect(error.code).toBe(JsonRpcErrorCode.Timeout);
        expect(error.data).toMatchObject({
          reason: 'retry_deadline_exceeded',
          retryable: true,
          retryAttempts: 2,
        });
        expect(error.data).not.toHaveProperty('recovery');
        expect(Date.now() - start).toBeLessThanOrEqual(45_500);
        expect(h.upstream.count('/forces')).toBe(2);
      },
      LONG_VIRTUAL_WAIT_TIMEOUT_MS,
    );

    it.each<[string, Responder]>([
      ['a 502', status(502)],
      ['a network failure', networkError],
    ])(
      'fails retries ending in an attempt timeout before the deadline as retry_deadline_exceeded, retryable: two of %s, then a hang',
      async (_name, fast) => {
        h.upstream.route('GET', '/forces', sequence(fast, fast, hang));
        const start = Date.now();
        const error = await failure(h.service.getForces(h.ctx, h.budget()));
        // The third attempt times out at 30 s, about 33 s in: the loop is out of retries, not deadline.
        expect(Date.now() - start).toBeGreaterThanOrEqual(30_000);
        expect(Date.now() - start).toBeLessThan(45_000);
        expect(error.code).toBe(JsonRpcErrorCode.Timeout);
        expect(error.message).toBe(
          'data.police.uk did not answer within 30 s. (failed after 3 attempts)',
        );
        expect(error.data).toMatchObject({
          reason: 'retry_deadline_exceeded',
          retryable: true,
          retryAttempts: 3,
        });
        // The calling tool's declared recovery fills the hint.
        expect(error.data).not.toHaveProperty('recovery');
        expect(h.upstream.count('/forces')).toBe(3);
      },
      LONG_VIRTUAL_WAIT_TIMEOUT_MS,
    );

    it('leaves a 501 untyped and unretried: the route is not implemented, not down', async () => {
      h.upstream.route('GET', '/forces', status(501));
      const error = await failure(h.service.getForces(h.ctx, h.budget()));
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.data).toMatchObject({ retryable: false, status: 501 });
      expect(error.data).not.toHaveProperty('reason');
      expect(h.upstream.count('/forces')).toBe(1);
    });

    it('keeps the reason of a failure that already has one: unreadable_response stays itself', async () => {
      h.upstream.route('GET', '/forces', htmlOk);
      const error = await failure(h.service.getForces(h.ctx, h.budget()));
      expect(error.data).toMatchObject({ reason: 'unreadable_response' });
      expect(error.data).not.toHaveProperty('retryable');
    });
  });

  describe('the outcomes route', () => {
    const POLYGON: Place = {
      kind: 'polygon',
      vertices: [
        { latitude: 52.63, longitude: -1.14 },
        { latitude: 52.63, longitude: -1.12 },
        { latitude: 52.64, longitude: -1.12 },
      ],
    };
    const POINT_PLACE: Place = { kind: 'point', lat: 52.63, lng: -1.13 };
    const outcomes = (place: Place = POINT_PLACE, budget = h.budget(), ctx = h.ctx) =>
      h.service.queryArea(outcomesQuery(place, '2026-08'), ctx, budget);

    it.each<[string, 'GET' | 'POST', Place]>([
      ['a point', 'GET', POINT_PLACE],
      ['a polygon', 'POST', POLYGON],
      ['a location', 'GET', { kind: 'location', locationId: '1000001' }],
    ])(
      'lets one request for %s run past 30 s: an answer at 35 s succeeds with one request',
      async (_name, method, place) => {
        h.upstream.route(method, '/outcomes-at-location', delayed(35_000, emptyArrayOk));
        const result = await settle(outcomes(place));
        expect(result).toEqual({ kind: 'found', value: [], weight: 2.5 });
        expect(h.upstream.count('/outcomes-at-location')).toBe(1);
      },
    );

    it('fails one request that never answers at the 45 s deadline, retryable, with the outcomes hint', async () => {
      h.upstream.route('GET', '/outcomes-at-location', hang);
      const start = Date.now();
      const error = await failure(outcomes());
      expect(error.code).toBe(JsonRpcErrorCode.Timeout);
      expect(error.data).toMatchObject({
        reason: 'retry_deadline_exceeded',
        retryable: true,
        retryAttempts: 1,
        recovery: { hint: OUTCOMES_DEADLINE_HINT },
      });
      expect(Date.now() - start).toBeGreaterThanOrEqual(45_000);
      expect(Date.now() - start).toBeLessThanOrEqual(45_500);
      expect(h.upstream.count('/outcomes-at-location')).toBe(1);
    });

    it('bounds the one request by what remains of the call budget', async () => {
      h.upstream.route('GET', '/outcomes-at-location', hang);
      const start = Date.now();
      const error = await failure(outcomes(POINT_PLACE, { deadlineAt: Date.now() + 10_000 }));
      expect(error.data).toMatchObject({
        reason: 'retry_deadline_exceeded',
        recovery: { hint: OUTCOMES_DEADLINE_HINT },
      });
      expect(Date.now() - start).toBeLessThanOrEqual(10_100);
      expect(h.upstream.count('/outcomes-at-location')).toBe(1);
    });

    it('still retries a fast failure inside the same deadline', async () => {
      h.upstream.route('GET', '/outcomes-at-location', sequence(status(502), emptyArrayOk));
      const result = await settle(outcomes());
      expect(result).toEqual({ kind: 'found', value: [], weight: 2.5 });
      expect(h.upstream.count('/outcomes-at-location')).toBe(2);
    });

    it('ends at once with the abort reason when the call is cancelled during the long request', async () => {
      const controller = new AbortController();
      const reason = new Error('client went away');
      h.upstream.route('GET', '/outcomes-at-location', hang);
      const outcome = outcomes(POINT_PLACE, h.budget(), h.ctxWith(controller.signal)).then(
        () => 'resolved',
        (error: unknown) => error,
      );
      await settle(new Promise<void>((resolve) => setTimeout(resolve, 32_000)));
      controller.abort(reason);
      expect(await settle(outcome)).toBe(reason);
      expect(h.upstream.count('/outcomes-at-location')).toBe(1);
    });

    it('keeps the 30 s attempt timeout and its retry on the other area routes', async () => {
      h.upstream.route('GET', '/crimes-street/all-crime', sequence(hang, emptyArrayOk));
      const result = await settle(area());
      expect(result).toEqual({ kind: 'found', value: [], weight: 2.5 });
      const [first, second] = h.upstream.callsTo('/crimes-street/all-crime');
      expect((second?.at ?? 0) - (first?.at ?? 0)).toBeGreaterThanOrEqual(30_000);
      expect((second?.at ?? 0) - (first?.at ?? 0)).toBeLessThan(31_500);
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

    it('narrows a budget to end within the given time, never past the budget it narrows', async () => {
      const budget = h.budget();
      expect(h.service.narrowBudget(budget, 10_000)).toEqual({ deadlineAt: Date.now() + 10_000 });
      await vi.advanceTimersByTimeAsync(45_000);
      expect(h.service.narrowBudget(budget, 10_000)).toEqual(budget);
    });

    it('ends a request that never answers at a narrowed budget, not the 45 s service deadline', async () => {
      h.upstream.route('GET', '/forces', hang);
      const start = Date.now();
      const error = await failure(
        h.service.getForces(h.ctx, h.service.narrowBudget(h.budget(), 10_000)),
      );
      expect(error.code).toBe(JsonRpcErrorCode.Timeout);
      expect(Date.now() - start).toBeLessThanOrEqual(10_500);
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

    it('leaves a failure untyped, never retryable, when the call was cancelled as the upstream answered', async () => {
      const controller = new AbortController();
      h.upstream.route('GET', '/forces', () => {
        controller.abort(new Error('client went away'));
        return new Response(null, { status: 502 });
      });
      const error = await failure(h.service.getForces(h.ctxWith(controller.signal), h.budget()));
      expect(error.message).toBe('data.police.uk returned HTTP 502.');
      expect(error.data).not.toHaveProperty('reason');
      expect(error.data).not.toHaveProperty('retryable');
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

    /** Resolves once `ready()` holds, polled on the virtual clock. */
    const until = (ready: () => boolean) =>
      settle(
        new Promise<void>((resolve) => {
          const check = () => (ready() ? resolve() : setTimeout(check, 10));
          check();
        }),
      );

    /** Routes the area endpoint to answer `[]` after `ms`, counting the requests it holds open. */
    function heldAreaRoute(ms: number) {
      const held = { now: 0, peak: 0 };
      h.upstream.route('GET', '/crimes-street/all-crime', async (request) => {
        held.now += 1;
        held.peak = Math.max(held.peak, held.now);
        try {
          return await delayed(ms, emptyArrayOk)(request);
        } finally {
          held.now -= 1;
        }
      });
      return held;
    }

    /** Four distinct area queries, each settling to when it settled (ms after `start`) and its error, if any. */
    const fourAreas = (start: number) =>
      Array.from({ length: 4 }, (_, i) =>
        area({ date: '2026-08', n: String(i) }).then(
          () => ({ at: Date.now() - start }),
          (error: unknown) => ({ at: Date.now() - start, error }),
        ),
      );

    it('holds at most three area queries in flight, so a cheap read never waits behind them', async () => {
      const held = heldAreaRoute(10_000);
      h.upstream.route('GET', '/locate-neighbourhood', jsonOk(locateBody()));
      const areas = fourAreas(Date.now());
      await until(() => held.now >= 3);
      const start = Date.now();
      const located = await settle(h.service.locate(52.63, -1.13, h.ctx, h.budget()));
      expect(located.kind).toBe('found');
      expect(Date.now() - start).toBeLessThan(1000);
      expect(held.now).toBe(3);
      const outcomes = await settle(Promise.all(areas));
      expect(outcomes.every((outcome) => !('error' in outcome))).toBe(true);
      expect(held.peak).toBe(3);
    });

    it('sheds an area query left waiting 20 s for an area slot as pacer_shed', async () => {
      heldAreaRoute(25_000);
      const outcomes = await settle(Promise.all(fourAreas(Date.now())));
      const shed = outcomes.filter((outcome) => 'error' in outcome);
      expect(shed).toHaveLength(1);
      expect(shed[0]?.error).toMatchObject({
        code: JsonRpcErrorCode.RateLimited,
        data: { reason: 'pacer_shed' },
      });
      expect(shed[0]?.at).toBeGreaterThanOrEqual(20_000);
      expect(shed[0]?.at).toBeLessThan(21_000);
    });

    it('gives a shed retryable, a hint naming its wait, and a message that names no internal pacer', async () => {
      heldAreaRoute(25_000);
      const outcomes = await settle(Promise.all(fourAreas(Date.now())));
      const error = outcomes.find((outcome) => 'error' in outcome)?.error as McpError;
      expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
      expect(error.message).toBe(
        'Too many requests to data.police.uk are queued in this server, so this one was not sent.',
      );
      const retryAfter = (error.data as { retryAfter: number }).retryAfter;
      expect(retryAfter).toBeGreaterThan(0);
      expect(error.data).toMatchObject({
        reason: 'pacer_shed',
        retryable: true,
        recovery: { hint: SHED_HINT(retryAfter) },
      });
      expect(JSON.stringify({ message: error.message, data: error.data })).not.toContain(
        'data-police-uk',
      );
    });

    it('holds no area slot while it waits out a Retry-After: other area queries go out when the cooldown gate opens', async () => {
      const first = sequence(rateLimited('30'), emptyArrayOk);
      const held = { now: 0, peak: 0 };
      const others = delayed(5000, emptyArrayOk);
      h.upstream.route('GET', '/crimes-street/all-crime', async (request) => {
        if (new URL(request.url).searchParams.get('n') === 'A') return first(request);
        held.now += 1;
        held.peak = Math.max(held.peak, held.now);
        try {
          return await others(request);
        } finally {
          held.now -= 1;
        }
      });
      const start = Date.now();
      const limited = area({ date: '2026-08', n: 'A' });
      await until(() => h.upstream.count('/crimes-street/all-crime') >= 1);
      const rest = ['B', 'C', 'D'].map((n) => area({ date: '2026-08', n }));
      const [result] = await settle(Promise.all([limited, Promise.all(rest)]));
      expect(result).toEqual({ kind: 'found', value: [], weight: 2.5 });
      const sent = h.upstream.callsTo('/crimes-street/all-crime').map((call) => call.at - start);
      const [aFirst, ...later] = sent;
      expect(aFirst).toBeLessThan(1000);
      // B, C and D wait only for the cooldown gate (15 s cap), all three in flight at once.
      const others3 = later.slice(0, 3);
      for (const at of others3) {
        expect(at).toBeGreaterThanOrEqual(15_000);
        expect(at).toBeLessThan(16_000);
      }
      expect(held.peak).toBe(3);
      // A's own retry goes out after the full 30 s it was asked to wait.
      expect(later[3]).toBeGreaterThanOrEqual(30_000);
    });

    it('counts the wait for an area slot against the same 20 s as the wait for a pacer slot', async () => {
      const held = heldAreaRoute(15_000);
      const ids = ['A', 'B', 'C', 'D'];
      for (const id of ids) {
        h.upstream.route(
          'GET',
          `/leicestershire/${id}/boundary`,
          delayed(25_000, jsonOk(boundaryBody())),
        );
      }
      const start = Date.now();
      const areas = fourAreas(start);
      await until(() => held.now >= 3);
      // One slow read takes the free slot; three queue for the slots the areas release at 15 s,
      // so the fourth area query, admitted to the pacer at 15 s, finds every slot taken.
      const reads = ids.map((id) => h.service.getBoundary('leicestershire', id, h.ctx, h.budget()));
      const [outcomes] = await settle(Promise.all([Promise.all(areas), Promise.all(reads)]));
      const shed = outcomes.filter((outcome) => 'error' in outcome);
      expect(shed).toHaveLength(1);
      expect(shed[0]?.error).toMatchObject({ data: { reason: 'pacer_shed' } });
      expect(shed[0]?.at).toBeGreaterThanOrEqual(20_000);
      expect(shed[0]?.at).toBeLessThan(21_000);
    });
  });

  describe('a range month: one full attempt, checked when it is sent', () => {
    const ROUTE = '/crimes-street/all-crime';
    const july = {
      path: ROUTE,
      params: { date: '2026-07' },
      normalize: (json: unknown) => json as readonly number[],
    };
    /** The July requests sent, as ms after `start`. */
    const julySent = (start: number) =>
      h.upstream
        .callsTo(ROUTE)
        .filter((call) => call.query.get('date') === '2026-07')
        .map((call) => call.at - start);
    /** Runs `run` once `ms` of virtual time has passed. */
    const inMs = <T>(ms: number, run: () => Promise<T>) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms)).then(run);
    /** Three August queries holding every area slot for 25 s; July answers at once. */
    const holdAreaSlots = () => {
      h.upstream.route(
        'GET',
        ROUTE,
        perMonth({ '2026-07': emptyArrayOk }, delayed(25_000, emptyArrayOk)),
      );
      return Promise.all(['A', 'B', 'C'].map((n) => area({ date: '2026-08', n })));
    };

    it('answers late, never sent, a month that waited for an area slot until less than one full attempt was left', async () => {
      const start = Date.now();
      const budget = h.budget();
      const [answer] = await settle(
        Promise.all([
          inMs(6000, () => h.service.queryRangeMonth(july, h.ctx, budget)),
          holdAreaSlots(),
        ]),
      );
      expect(answer).toEqual({ kind: 'late' });
      expect(julySent(start)).toEqual([]);
    });

    it('sends a single-month query after the same wait, whatever is left', async () => {
      const start = Date.now();
      const budget = h.budget();
      const [answer] = await settle(
        Promise.all([inMs(6000, () => h.service.queryArea(july, h.ctx, budget)), holdAreaSlots()]),
      );
      expect(answer).toEqual({ kind: 'found', value: [], weight: 2.5 });
      expect(julySent(start)).toEqual([25_000]);
    });

    it('checks only the first attempt: a retry goes out with less than one full attempt left', async () => {
      h.upstream.route('GET', ROUTE, sequence(delayed(8000, rateLimited('1')), emptyArrayOk));
      const start = Date.now();
      const budget = h.budget();
      const answer = await settle(
        inMs(15_000, () => h.service.queryRangeMonth(july, h.ctx, budget)),
      );
      expect(answer).toEqual({ kind: 'found', value: [], weight: 2.5 });
      const [first, retry] = julySent(start);
      expect(first).toBe(15_000);
      expect(retry).toBeGreaterThan(20_000);
    });

    it('serves a cached month whatever is left', async () => {
      h.upstream.route('GET', ROUTE, emptyArrayOk);
      await settle(h.service.queryRangeMonth(july, h.ctx, h.budget()));
      const short = h.service.narrowBudget(h.budget(), 10_000);
      expect(await settle(h.service.queryRangeMonth(july, h.ctx, short))).toEqual({
        kind: 'found',
        value: [],
        weight: 2.5,
      });
      expect(julySent(0)).toHaveLength(1);
    });
  });

  describe('the test harness', () => {
    it('holds the virtual clock while a digest started during a settle runs', async () => {
      const start = Date.now();
      let doneAt: number | undefined;
      const work = (async () => {
        // Starts after settle has checked for digests once, as a handler reaching its cache key does.
        await new Promise<void>((resolve) => setImmediate(resolve));
        await crypto.subtle.digest('SHA-256', new Uint8Array(16 * MIB));
        doneAt = Date.now();
      })();
      await settle(work);
      expect(doneAt).toBe(start);
    });

    /** V8's collector, reached without `--expose-gc` on the command line. */
    const collectGarbage = (() => {
      setFlagsFromString('--expose-gc');
      return runInNewContext('gc') as () => void;
    })();

    it('still ends a hanging request when its caller aborts after a garbage collection, as a real fetch in flight does', async () => {
      h.upstream.route('GET', '/forces', hang);
      const controller = new AbortController();
      let outcome: unknown = 'pending';
      void h.upstream.fetch(`${API_BASE}/forces`, { signal: controller.signal }).then(
        () => {
          outcome = 'answered';
        },
        (error: unknown) => {
          outcome = error;
        },
      );
      for (let round = 0; round < 3; round++) {
        collectGarbage();
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      const reason = new Error('attempt timed out');
      controller.abort(reason);
      await untilReal(() => outcome !== 'pending', 1000);
      expect(outcome).toBe(reason);
    });
  });
});
