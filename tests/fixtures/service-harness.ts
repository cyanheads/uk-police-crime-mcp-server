/**
 * @fileoverview Test harness for PoliceApiService and the tools built on it: a
 * route-table upstream fake over the framework's `createFetchMock` that records
 * every request with its virtual timestamp, fake-timer helpers that keep the
 * pacer, retry backoff and call budget on one controllable clock, and a service
 * builder wired to both. No test reaches the network — an unrouted request
 * fails loudly and is listed in `upstream.unhandled`.
 * @module tests/fixtures/service-harness
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { createFetchMock, createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import {
  initPoliceApiService,
  PoliceApiService,
} from '@/services/police-api/police-api-service.js';
import type { CallBudget } from '@/services/police-api/types.js';
import {
  API_BASE,
  categoriesBody,
  forcesBody,
  jsonOk,
  lastUpdatedBody,
  type Responder,
  streetDatesBody,
} from './police-api-upstream.js';

/** Virtual "now" every service test starts at. */
export const START_TIME = Date.parse('2026-10-01T12:00:00Z');

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** The real `setTimeout`, captured before any test installs fake timers. */
const realSetTimeout = globalThis.setTimeout;
const realSetImmediate = globalThis.setImmediate;

/** One request the service sent. */
export interface UpstreamCall {
  /** Virtual epoch ms the request was sent at. */
  readonly at: number;
  /** Decoded request body, for POSTs. */
  readonly body: string | undefined;
  readonly headers: Headers;
  readonly method: string;
  /** Path under the API base, e.g. `/crimes-street/burglary`. */
  readonly path: string;
  readonly query: URLSearchParams;
  /** The `redirect` mode the request was sent with. */
  readonly redirect: RequestInit['redirect'];
  readonly signal: AbortSignal | undefined;
}

/** A route-table upstream: `route(method, path, responder)` registers or replaces an answer. */
export interface Upstream {
  readonly calls: readonly UpstreamCall[];
  /** The calls sent to `path`, in order. */
  callsTo(path: string): UpstreamCall[];
  /** Number of requests sent to `path` (any method). */
  count(path: string): number;
  readonly fetch: (input: string, init?: RequestInit) => Promise<Response>;
  /** Registers the standard reference routes (dates, last-updated, forces, categories). */
  referenceRoutes(): Upstream;
  route(method: 'GET' | 'POST', path: string, respond: Responder): Upstream;
  /** Requests that matched no route; every test file asserts this is empty after each test. */
  readonly unhandled: readonly string[];
}

/** Builds an upstream with no routes. */
export function createUpstream(): Upstream {
  const routes = new Map<string, Responder>();
  const calls: UpstreamCall[] = [];
  const unhandled: string[] = [];
  const keyOf = (method: string, path: string) => `${method.toUpperCase()} ${path}`;
  const pathOf = (url: string) => new URL(url).pathname.slice(new URL(API_BASE).pathname.length);

  const mock = createFetchMock(
    [
      {
        match: (request) => routes.has(keyOf(request.method, pathOf(request.url))),
        respond: (request) => {
          const respond = routes.get(keyOf(request.method, pathOf(request.url)));
          if (!respond) throw new Error('route vanished');
          return respond(request);
        },
      },
    ],
    {
      onUnhandled: (request) => {
        unhandled.push(`${request.method} ${request.url}`);
        throw new Error(`Unhandled upstream request: ${request.method} ${request.url}`);
      },
    },
  );

  const upstream: Upstream = {
    calls,
    unhandled,
    count: (path) => calls.filter((call) => call.path === path).length,
    callsTo: (path) => calls.filter((call) => call.path === path),
    fetch: (input, init) => {
      const url = new URL(input);
      calls.push({
        at: Date.now(),
        method: (init?.method ?? 'GET').toUpperCase(),
        path: pathOf(input),
        query: url.searchParams,
        headers: new Headers(init?.headers),
        body: typeof init?.body === 'string' ? init.body : undefined,
        redirect: init?.redirect,
        signal: init?.signal ?? undefined,
      });
      return mock.fetch(input, init);
    },
    route: (method, path, respond) => {
      routes.set(keyOf(method, path), respond);
      return upstream;
    },
    referenceRoutes: () =>
      upstream
        .route('GET', '/crimes-street-dates', jsonOk(streetDatesBody()))
        .route('GET', '/crime-last-updated', jsonOk(lastUpdatedBody()))
        .route('GET', '/forces', jsonOk(forcesBody()))
        .route('GET', '/crime-categories', jsonOk(categoriesBody())),
  };
  return upstream;
}

/** Installs the virtual clock for one test: Date and the timer functions are virtual, `setImmediate` and microtasks stay real. */
function installVirtualClock(): void {
  vi.useFakeTimers({
    toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
  });
  vi.setSystemTime(START_TIME);
}

/**
 * Drives a pending service call to completion on the virtual clock: yields a few
 * real milliseconds (native crypto and stream work), then advances virtual time
 * in `stepMs` slices until the promise settles. Returns what the promise
 * resolved to, or rejects with what it rejected with.
 */
export async function settle<T>(promise: Promise<T>, stepMs = 50, limitMs = 300_000): Promise<T> {
  let done = false;
  const watch = () => {
    done = true;
  };
  promise.then(watch, watch);
  let advanced = 0;
  let rounds = 0;
  while (!done && advanced <= limitMs) {
    // The first rounds wait real milliseconds for native work (crypto digests, streams); later rounds only yield.
    await new Promise<void>((resolve) =>
      rounds < 3 ? realSetTimeout(resolve, 2) : realSetImmediate(resolve),
    );
    rounds += 1;
    if (done) break;
    await vi.advanceTimersByTimeAsync(stepMs);
    advanced += stepMs;
  }
  return promise;
}

/**
 * Waits real time with the virtual clock held still until `ready()` holds, so
 * native work a request waits on (an area query's SHA-256 cache key) finishes
 * before {@link settle} moves the clock. Fails after `limitMs` real milliseconds.
 */
export async function untilReal(ready: () => boolean, limitMs = 2000): Promise<void> {
  const start = performance.now();
  while (!ready()) {
    if (performance.now() - start > limitMs) {
      throw new Error(`untilReal: the condition still did not hold after ${limitMs} ms`);
    }
    await new Promise<void>((resolve) => realSetTimeout(resolve, 1));
  }
}

/** A service wired to a fresh upstream and a mock context, rebuilt for every test. */
export interface ServiceHarness {
  /** A budget opened now (50 s on the virtual clock). */
  budget(): CallBudget;
  readonly ctx: Context;
  /** A mock context whose signal is the given one. */
  ctxWith(signal: AbortSignal): Context;
  readonly service: PoliceApiService;
  readonly upstream: Upstream;
}

/**
 * Registers the hooks for a describe block of service tests: a virtual clock, a
 * fresh `PoliceApiService` over a fresh upstream (reference routes registered
 * unless `reference: false`), disposal afterwards, and an assertion that no
 * request went unrouted. The returned handle reads the current test's instances.
 */
export function useServiceHarness(options: { reference?: boolean } = {}): ServiceHarness {
  let current: { ctx: Context; service: PoliceApiService; upstream: Upstream } | undefined;
  const live = () => {
    if (!current) throw new Error('useServiceHarness: read outside a test');
    return current;
  };

  beforeEach(() => {
    installVirtualClock();
    const upstream = createUpstream();
    if (options.reference !== false) upstream.referenceRoutes();
    current = {
      upstream,
      service: new PoliceApiService({ fetch: upstream.fetch, now: () => Date.now() }),
      ctx: createMockContext(),
    };
  });
  afterEach(() => {
    const { service, upstream } = live();
    service.dispose();
    vi.useRealTimers();
    current = undefined;
    expect(upstream.unhandled).toEqual([]);
  });

  return {
    get ctx() {
      return live().ctx;
    },
    get service() {
      return live().service;
    },
    get upstream() {
      return live().upstream;
    },
    budget: () => live().service.openBudget(),
    ctxWith: (signal) => createMockContext({ signal }),
  };
}

/** The process-wide service a tool handler reads, over a fresh upstream, rebuilt for every test. */
export interface ToolHarness {
  readonly service: PoliceApiService;
  readonly upstream: Upstream;
}

/**
 * Registers the hooks for a describe block of tool tests: a virtual clock and
 * `initPoliceApiService` over a fresh upstream (reference routes registered
 * unless `reference: false`), disposed afterwards.
 */
export function useToolHarness(options: { reference?: boolean } = {}): ToolHarness {
  let current: { service: PoliceApiService; upstream: Upstream } | undefined;
  const live = () => {
    if (!current) throw new Error('useToolHarness: read outside a test');
    return current;
  };

  beforeEach(() => {
    installVirtualClock();
    const upstream = createUpstream();
    if (options.reference !== false) upstream.referenceRoutes();
    current = {
      upstream,
      service: initPoliceApiService({ fetch: upstream.fetch, now: () => Date.now() }),
    };
  });
  afterEach(() => {
    const { service, upstream } = live();
    service.dispose();
    vi.useRealTimers();
    current = undefined;
    expect(upstream.unhandled).toEqual([]);
  });

  return {
    get service() {
      return live().service;
    },
    get upstream() {
      return live().upstream;
    },
  };
}
