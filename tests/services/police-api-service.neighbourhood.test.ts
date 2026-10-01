/**
 * @fileoverview PoliceApiService's wave 3 methods against a route-table upstream
 * on a virtual clock: `getNeighbourhood` (404 is a miss, tolerant read),
 * `getPriorities`, `getTeam` and `getEvents` (every failure throws, 404 included;
 * the people read keeps rank and name only), and `getCrimeHistory` (404 is a
 * miss, `outcomes: null` survives). Paths and id encoding, caching (none),
 * retry counts per failure class, shape mismatches, budget and cancellation.
 * @module tests/services/police-api-service.neighbourhood.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import type { MockContextLogger } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import type { PoliceApiService } from '@/services/police-api/police-api-service.js';
import type { CallBudget } from '@/services/police-api/types.js';
import {
  emptyArrayOk,
  emptyNotFound,
  eventsBody,
  hang,
  htmlBadRequest,
  htmlOk,
  jsonOk,
  neighbourhoodDetailBody,
  networkError,
  peopleBody,
  plainNotFound,
  prioritiesBody,
  type Responder,
  rateLimited,
  sequence,
  status,
} from '../fixtures/police-api-upstream.js';
import {
  crimeHistoryBody,
  historyOutcome,
  manyEvents,
  peopleWithPrivateFields,
} from '../fixtures/police-api-upstream-w3.js';
import { settle, useServiceHarness } from '../fixtures/service-harness.js';

/** Resolves with the error a call rejects with; fails the test when it resolves. */
async function failure(promise: Promise<unknown>): Promise<McpError> {
  const error = await settle(promise).then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(McpError);
  return error as McpError;
}

const FORCE = 'leicestershire';
const ID = 'NX01';
const BASE = `/${FORCE}/${ID}`;
const PERSISTENT_ID = 'a'.repeat(64);

type Method = (service: PoliceApiService, ctx: Context, budget: CallBudget) => Promise<unknown>;

/** Each neighbourhood read, its route, and how to call it. */
const READS: readonly { call: Method; name: string; path: string; ok: unknown }[] = [
  {
    name: 'getNeighbourhood',
    path: BASE,
    ok: neighbourhoodDetailBody(),
    call: (service, ctx, budget) => service.getNeighbourhood(FORCE, ID, ctx, budget),
  },
  {
    name: 'getPriorities',
    path: `${BASE}/priorities`,
    ok: prioritiesBody(),
    call: (service, ctx, budget) => service.getPriorities(FORCE, ID, ctx, budget),
  },
  {
    name: 'getTeam',
    path: `${BASE}/people`,
    ok: peopleBody(),
    call: (service, ctx, budget) => service.getTeam(FORCE, ID, ctx, budget),
  },
  {
    name: 'getEvents',
    path: `${BASE}/events`,
    ok: eventsBody(),
    call: (service, ctx, budget) => service.getEvents(FORCE, ID, ctx, budget),
  },
  {
    name: 'getCrimeHistory',
    path: `/outcomes-for-crime/${PERSISTENT_ID}`,
    ok: crimeHistoryBody(PERSISTENT_ID),
    call: (service, ctx, budget) => service.getCrimeHistory(PERSISTENT_ID, ctx, budget),
  },
];

describe('PoliceApiService neighbourhood and crime-history reads', () => {
  const h = useServiceHarness();

  describe.each(READS)('$name: request and failure classes', ({ call, path, ok }) => {
    it('sends one GET to the route with the JSON accept header and no query', async () => {
      h.upstream.route('GET', path, jsonOk(ok));
      await settle(call(h.service, h.ctx, h.budget()));
      expect(h.upstream.calls).toHaveLength(1);
      const [sent] = h.upstream.calls;
      expect(sent?.method).toBe('GET');
      expect(sent?.path).toBe(path);
      expect([...(sent?.query.keys() ?? [])]).toEqual([]);
      expect(sent?.headers.get('accept')).toBe('application/json');
    });

    it('is not cached: a repeat call asks upstream again', async () => {
      h.upstream.route('GET', path, jsonOk(ok));
      await settle(call(h.service, h.ctx, h.budget()));
      await settle(call(h.service, h.ctx, h.budget()));
      expect(h.upstream.count(path)).toBe(2);
    });

    it('retries a persistent 500 to three attempts, then fails ServiceUnavailable', async () => {
      h.upstream.route('GET', path, status(500));
      const error = await failure(call(h.service, h.ctx, h.budget()));
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(h.upstream.count(path)).toBe(3);
    });

    it('recovers when a 503 is followed by a good body (a non-area route retries a 503)', async () => {
      h.upstream.route('GET', path, sequence(status(503), jsonOk(ok)));
      await settle(call(h.service, h.ctx, h.budget()));
      expect(h.upstream.count(path)).toBe(2);
      expect(h.upstream.count('/crime-last-updated')).toBe(0);
    });

    it('fails RateLimited on a persistent 429 with its Retry-After', async () => {
      h.upstream.route('GET', path, rateLimited('2'));
      const error = await failure(call(h.service, h.ctx, h.budget()));
      expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
      expect(error.data).toMatchObject({ retryAfter: '2' });
    });

    it('fails unreadable_response, retried, on a 200 HTML body', async () => {
      h.upstream.route('GET', path, htmlOk);
      const error = await failure(call(h.service, h.ctx, h.budget()));
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.data).toMatchObject({ reason: 'unreadable_response' });
      expect(h.upstream.count(path)).toBe(3);
    });

    it('fails unexpected_response, not retried, naming the route and not echoing the body', async () => {
      h.upstream.route('GET', path, jsonOk({ secret: 'upstream-only-text' }));
      const error = await failure(call(h.service, h.ctx, h.budget()));
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.data).toMatchObject({ reason: 'unexpected_response', retryable: false });
      expect(error.message).toContain(path);
      expect(JSON.stringify(error.data)).not.toContain('upstream-only-text');
      expect(h.upstream.count(path)).toBe(1);
    });

    it('fails InvalidParams on a 400 and logs it at error level, without retrying', async () => {
      h.upstream.route('GET', path, htmlBadRequest);
      const error = await failure(call(h.service, h.ctx, h.budget()));
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(h.upstream.count(path)).toBe(1);
      const log = h.ctx.log as MockContextLogger;
      expect(log.calls.some((entry) => entry.level === 'error')).toBe(true);
    });

    it('fails Timeout when upstream never answers', async () => {
      h.upstream.route('GET', path, hang);
      const error = await failure(call(h.service, h.ctx, h.budget()));
      expect(error.code).toBe(JsonRpcErrorCode.Timeout);
    });

    it('fails ServiceUnavailable on a network error', async () => {
      h.upstream.route('GET', path, networkError);
      const error = await failure(call(h.service, h.ctx, h.budget()));
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    });

    it('fails call_budget_exhausted without a request when the budget is spent', async () => {
      h.upstream.route('GET', path, jsonOk(ok));
      const error = await failure(call(h.service, h.ctx, { deadlineAt: Date.now() }));
      expect(error.code).toBe(JsonRpcErrorCode.Timeout);
      expect(error.data).toMatchObject({ reason: 'call_budget_exhausted' });
      expect(h.upstream.calls).toHaveLength(0);
    });

    it('rejects with the abort reason, once, when the caller cancels mid-request', async () => {
      const controller = new AbortController();
      const reason = new Error('client went away');
      h.upstream.route('GET', path, hang);
      const outcome = call(h.service, h.ctxWith(controller.signal), h.budget()).then(
        () => 'resolved',
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(1000);
      controller.abort(reason);
      expect(await settle(outcome)).toBe(reason);
      expect(h.upstream.count(path)).toBe(1);
    });
  });

  describe('getNeighbourhood', () => {
    it('returns the normalized profile', async () => {
      h.upstream.route('GET', BASE, jsonOk(neighbourhoodDetailBody()));
      const result = await settle(h.service.getNeighbourhood(FORCE, ID, h.ctx, h.budget()));
      expect(result).toEqual({
        kind: 'found',
        value: expect.objectContaining({
          id: 'NX01',
          name: 'Example Central',
          population: 4200,
          description: 'An invented neighbourhood.',
        }),
      });
    });

    it.each([
      ['an empty-bodied 404', emptyNotFound],
      ['a text/plain 404', plainNotFound],
    ])('reads %s as a miss', async (_name, responder) => {
      h.upstream.route('GET', BASE, responder);
      const result = await settle(h.service.getNeighbourhood(FORCE, ID, h.ctx, h.budget()));
      expect(result).toEqual({ kind: 'miss' });
      expect(h.upstream.count(BASE)).toBe(1);
    });

    it('does not cache a miss either', async () => {
      h.upstream.route('GET', BASE, plainNotFound);
      await settle(h.service.getNeighbourhood(FORCE, ID, h.ctx, h.budget()));
      await settle(h.service.getNeighbourhood(FORCE, ID, h.ctx, h.budget()));
      expect(h.upstream.count(BASE)).toBe(2);
    });

    it('reads tolerantly: only id and name are required, nulls everywhere else', async () => {
      h.upstream.route(
        'GET',
        BASE,
        jsonOk({
          id: ID,
          name: 'Bare',
          url_force: null,
          centre: null,
          population: null,
          description: null,
          contact_details: null,
          links: [{ title: null, url: null, description: null }, {}],
          locations: [{ type: null, name: null, description: null, address: null, postcode: null }],
        }),
      );
      const result = await settle(h.service.getNeighbourhood(FORCE, ID, h.ctx, h.budget()));
      expect(result).toEqual({
        kind: 'found',
        value: { id: ID, name: 'Bare', contact: [], links: [], stations: [] },
      });
    });

    it.each<[string, unknown]>([
      ['a missing name', { id: ID }],
      ['a missing id', { name: 'No id' }],
      ['an array body', []],
      ['a string population type that is a number', neighbourhoodDetailBody({ population: 4200 })],
    ])('fails unexpected_response for %s', async (_name, body) => {
      h.upstream.route('GET', BASE, jsonOk(body));
      const error = await failure(h.service.getNeighbourhood(FORCE, ID, h.ctx, h.budget()));
      expect(error.data).toMatchObject({ reason: 'unexpected_response' });
    });

    it('reads a numeric id upstream as a string', async () => {
      h.upstream.route('GET', BASE, jsonOk(neighbourhoodDetailBody({ id: 12 })));
      const result = await settle(h.service.getNeighbourhood(FORCE, ID, h.ctx, h.budget()));
      expect(result).toMatchObject({ kind: 'found', value: { id: '12' } });
    });
  });

  describe('path encoding of force and neighbourhood ids', () => {
    it.each<[string, string, string]>([
      ['a space (Northern Ireland place names)', 'Some Place', 'Some%20Place'],
      ['a slash', 'a/b', 'a%2Fb'],
      ['a percent sign', '50%', '50%25'],
      ['a non-ASCII letter', 'Café', 'Caf%C3%A9'],
      ['a question mark and hash', 'a?b#c', 'a%3Fb%23c'],
      ['a plus and ampersand', 'a+b&c', 'a%2Bb%26c'],
    ])('encodes %s in the id so it stays one path segment', async (_name, id, encoded) => {
      const reads: [string, () => Promise<unknown>][] = [
        ['', () => h.service.getNeighbourhood('northern-ireland', id, h.ctx, h.budget())],
        ['/priorities', () => h.service.getPriorities('northern-ireland', id, h.ctx, h.budget())],
        ['/people', () => h.service.getTeam('northern-ireland', id, h.ctx, h.budget())],
        ['/events', () => h.service.getEvents('northern-ireland', id, h.ctx, h.budget())],
      ];
      for (const [section, call] of reads) {
        const path = `/northern-ireland/${encoded}${section}`;
        h.upstream.route('GET', path, section === '' ? plainNotFound : emptyArrayOk);
        await settle(call().catch(() => undefined));
        expect(h.upstream.count(path), path).toBe(1);
      }
      expect(h.upstream.unhandled).toEqual([]);
    });

    it('encodes the force the same way', async () => {
      h.upstream.route('GET', '/odd%2Fforce/NX01', plainNotFound);
      await settle(h.service.getNeighbourhood('odd/force', 'NX01', h.ctx, h.budget()));
      expect(h.upstream.count('/odd%2Fforce/NX01')).toBe(1);
    });

    it('encodes a persistent id in the history route', async () => {
      h.upstream.route('GET', '/outcomes-for-crime/a%2Fb', plainNotFound);
      await settle(h.service.getCrimeHistory('a/b', h.ctx, h.budget()));
      expect(h.upstream.count('/outcomes-for-crime/a%2Fb')).toBe(1);
    });
  });

  describe('getPriorities, getTeam and getEvents: every failure throws, a 404 included', () => {
    it.each([
      [
        'getPriorities',
        `${BASE}/priorities`,
        (): Promise<unknown> => h.service.getPriorities(FORCE, ID, h.ctx, h.budget()),
      ],
      [
        'getTeam',
        `${BASE}/people`,
        (): Promise<unknown> => h.service.getTeam(FORCE, ID, h.ctx, h.budget()),
      ],
      [
        'getEvents',
        `${BASE}/events`,
        (): Promise<unknown> => h.service.getEvents(FORCE, ID, h.ctx, h.budget()),
      ],
    ])('%s throws NotFound on a 404 instead of returning a miss', async (_name, path, call) => {
      h.upstream.route('GET', path, plainNotFound);
      const error = await failure(call());
      expect(error.code).toBe(JsonRpcErrorCode.NotFound);
      expect(h.upstream.count(path)).toBe(1);
    });

    it.each([
      [
        'getPriorities',
        `${BASE}/priorities`,
        (): Promise<unknown> => h.service.getPriorities(FORCE, ID, h.ctx, h.budget()),
      ],
      [
        'getTeam',
        `${BASE}/people`,
        (): Promise<unknown> => h.service.getTeam(FORCE, ID, h.ctx, h.budget()),
      ],
      [
        'getEvents',
        `${BASE}/events`,
        (): Promise<unknown> => h.service.getEvents(FORCE, ID, h.ctx, h.budget()),
      ],
    ])('%s returns [] for an empty list', async (_name, path, call) => {
      h.upstream.route('GET', path, emptyArrayOk);
      await expect(settle(call())).resolves.toEqual([]);
    });
  });

  describe('getPriorities', () => {
    it('returns issue and action as text with dates as published', async () => {
      h.upstream.route('GET', `${BASE}/priorities`, jsonOk(prioritiesBody()));
      await expect(settle(h.service.getPriorities(FORCE, ID, h.ctx, h.budget()))).resolves.toEqual([
        {
          issue: 'Anti-social behaviour & fly-tipping.',
          issue_date: '2026-07-01T00:00:00',
          action: 'Patrols\nCommunity meetings',
          action_date: '2026-08-01T00:00:00',
        },
      ]);
    });

    it('accepts null action and dates (live shape) and drops a priority with no issue text', async () => {
      h.upstream.route(
        'GET',
        `${BASE}/priorities`,
        jsonOk([
          { issue: 'Kept', 'issue-date': null, action: null, 'action-date': null },
          { issue: '<p></p>', action: 'Orphan' },
        ]),
      );
      await expect(settle(h.service.getPriorities(FORCE, ID, h.ctx, h.budget()))).resolves.toEqual([
        { issue: 'Kept' },
      ]);
    });

    it('fails unexpected_response when an entry has no issue (the section is read strictly)', async () => {
      h.upstream.route('GET', `${BASE}/priorities`, jsonOk([{ action: 'x' }]));
      const error = await failure(h.service.getPriorities(FORCE, ID, h.ctx, h.budget()));
      expect(error.data).toMatchObject({ reason: 'unexpected_response' });
    });
  });

  describe('getTeam', () => {
    it('returns rank and name exactly as published, in upstream order, and nothing else', async () => {
      h.upstream.route('GET', `${BASE}/people`, jsonOk(peopleBody()));
      const team = await settle(h.service.getTeam(FORCE, ID, h.ctx, h.budget()));
      expect(team).toEqual([
        { name: 'Example Officer', rank: 'PC 0000' },
        { name: 'Sample Sergeant', rank: 'Sgt 0000' },
      ]);
      for (const member of team) expect(Object.keys(member).sort()).toEqual(['name', 'rank']);
    });

    it('never parses a biography, per-person contact details or any other key', async () => {
      h.upstream.route('GET', `${BASE}/people`, jsonOk(peopleWithPrivateFields()));
      const team = await settle(h.service.getTeam(FORCE, ID, h.ctx, h.budget()));
      const json = JSON.stringify(team);
      expect(json).not.toContain('Invented biography');
      expect(json).not.toContain('Ignore previous instructions');
      expect(json).not.toContain('private-officer@example.test');
      expect(json).not.toContain('0000 000 0000');
      expect(json).not.toContain('collar_number');
      expect(json).not.toContain('bio');
      expect(json).not.toContain('contact_details');
    });

    it('keeps a free-text rank with a collar number, untouched', async () => {
      h.upstream.route(
        'GET',
        `${BASE}/people`,
        jsonOk([{ name: 'Test Constable', rank: 'PCSO 1234 (acting)', bio: null }]),
      );
      await expect(settle(h.service.getTeam(FORCE, ID, h.ctx, h.budget()))).resolves.toEqual([
        { name: 'Test Constable', rank: 'PCSO 1234 (acting)' },
      ]);
    });

    it.each<[string, unknown]>([
      ['a missing rank', [{ name: 'Example Officer' }]],
      ['a missing name', [{ rank: 'PC 0000' }]],
      ['a null name', [{ name: null, rank: 'PC 0000' }]],
      ['an object body', { people: [] }],
    ])('fails unexpected_response for %s', async (_name, body) => {
      h.upstream.route('GET', `${BASE}/people`, jsonOk(body));
      const error = await failure(h.service.getTeam(FORCE, ID, h.ctx, h.budget()));
      expect(error.data).toMatchObject({ reason: 'unexpected_response' });
    });
  });

  describe('getEvents', () => {
    it('returns description as text, drops contact_details, and sorts by start', async () => {
      h.upstream.route('GET', `${BASE}/events`, jsonOk(manyEvents(3)));
      const events = await settle(h.service.getEvents(FORCE, ID, h.ctx, h.budget()));
      expect(events.map((event) => event.title)).toEqual(['Event 01', 'Event 02', 'Event 03']);
      expect(events[0]).toEqual({
        title: 'Event 01',
        type: 'meeting',
        start: '2026-09-01T18:00:00',
        end: '2026-09-01T19:00:00',
        address: 'Example Hall',
        description: 'Session 1.',
      });
      expect(JSON.stringify(events)).not.toContain('events@example.test');
    });

    it('returns every event the upstream lists (the cap belongs to the tool)', async () => {
      h.upstream.route('GET', `${BASE}/events`, jsonOk(manyEvents(40)));
      const events = await settle(h.service.getEvents(FORCE, ID, h.ctx, h.budget()));
      expect(events).toHaveLength(40);
    });

    it('fails unexpected_response when an event has no title', async () => {
      h.upstream.route('GET', `${BASE}/events`, jsonOk([{ type: 'meeting' }]));
      const error = await failure(h.service.getEvents(FORCE, ID, h.ctx, h.budget()));
      expect(error.data).toMatchObject({ reason: 'unexpected_response' });
    });
  });

  describe('getCrimeHistory', () => {
    it('returns the crime and its outcomes in date order', async () => {
      h.upstream.route(
        'GET',
        `/outcomes-for-crime/${PERSISTENT_ID}`,
        jsonOk(crimeHistoryBody(PERSISTENT_ID)),
      );
      const result = await settle(h.service.getCrimeHistory(PERSISTENT_ID, h.ctx, h.budget()));
      expect(result).toMatchObject({
        kind: 'found',
        value: {
          crime: { id: '100000001', persistent_id: PERSISTENT_ID, category: 'burglary' },
          outcomes: [
            { code: 'under-investigation', month: '2026-06' },
            { code: 'unable-to-prosecute', month: '2026-07' },
          ],
        },
      });
    });

    it.each([
      ['an empty-bodied 404', emptyNotFound],
      ['a text/plain 404', plainNotFound],
    ])('reads %s as a miss without retrying', async (_name, responder) => {
      h.upstream.route('GET', `/outcomes-for-crime/${PERSISTENT_ID}`, responder);
      await expect(
        settle(h.service.getCrimeHistory(PERSISTENT_ID, h.ctx, h.budget())),
      ).resolves.toEqual({ kind: 'miss' });
      expect(h.upstream.count(`/outcomes-for-crime/${PERSISTENT_ID}`)).toBe(1);
    });

    it('keeps outcomes: null as null so the tool can say the history is not published', async () => {
      h.upstream.route(
        'GET',
        `/outcomes-for-crime/${PERSISTENT_ID}`,
        jsonOk(crimeHistoryBody(PERSISTENT_ID, { outcomes: null })),
      );
      await expect(
        settle(h.service.getCrimeHistory(PERSISTENT_ID, h.ctx, h.budget())),
      ).resolves.toMatchObject({ kind: 'found', value: { outcomes: null } });
    });

    it('keeps upstream order inside a month while sorting months', async () => {
      h.upstream.route(
        'GET',
        `/outcomes-for-crime/${PERSISTENT_ID}`,
        jsonOk(
          crimeHistoryBody(PERSISTENT_ID, {
            outcomes: [
              historyOutcome('second', 'Second', '2026-07'),
              historyOutcome('first', 'First', '2026-05'),
              historyOutcome('third', 'Third', '2026-07'),
            ],
          }),
        ),
      );
      const result = await settle(h.service.getCrimeHistory(PERSISTENT_ID, h.ctx, h.budget()));
      expect(result.kind === 'found' && result.value.outcomes?.map((o) => o.code)).toEqual([
        'first',
        'second',
        'third',
      ]);
    });

    it('reads the persistent id of the record upstream returned, not the id asked for', async () => {
      h.upstream.route(
        'GET',
        `/outcomes-for-crime/${PERSISTENT_ID}`,
        jsonOk(crimeHistoryBody('f'.repeat(64))),
      );
      const result = await settle(h.service.getCrimeHistory(PERSISTENT_ID, h.ctx, h.budget()));
      expect(result.kind === 'found' && result.value.crime.persistent_id).toBe('f'.repeat(64));
    });

    it.each<[string, unknown]>([
      ['no crime', { outcomes: [] }],
      ['no outcomes key', { crime: crimeHistoryBody(PERSISTENT_ID).crime }],
      [
        'an outcome without a category',
        crimeHistoryBody(PERSISTENT_ID, { outcomes: [{ date: '2026-07' }] }),
      ],
      ['a crime without an id', crimeHistoryBody(PERSISTENT_ID, { crime: { id: undefined } })],
    ])('fails unexpected_response for %s', async (_name, body) => {
      h.upstream.route('GET', `/outcomes-for-crime/${PERSISTENT_ID}`, jsonOk(body));
      const error = await failure(h.service.getCrimeHistory(PERSISTENT_ID, h.ctx, h.budget()));
      expect(error.data).toMatchObject({ reason: 'unexpected_response' });
    });

    it('lets a transient failure recover on the retry and returns the history', async () => {
      const path = `/outcomes-for-crime/${PERSISTENT_ID}`;
      const respond: Responder = sequence(status(502), jsonOk(crimeHistoryBody(PERSISTENT_ID)));
      h.upstream.route('GET', path, respond);
      await expect(
        settle(h.service.getCrimeHistory(PERSISTENT_ID, h.ctx, h.budget())),
      ).resolves.toMatchObject({ kind: 'found' });
      expect(h.upstream.count(path)).toBe(2);
    });
  });

  it('runs parallel reads through one pacer and one budget without dropping any', async () => {
    h.upstream
      .route('GET', BASE, jsonOk(neighbourhoodDetailBody()))
      .route('GET', `${BASE}/priorities`, jsonOk(prioritiesBody()))
      .route('GET', `${BASE}/people`, jsonOk(peopleBody()))
      .route('GET', `${BASE}/events`, jsonOk(eventsBody()));
    const budget = h.budget();
    const [detail, priorities, team, events] = await settle(
      Promise.all([
        h.service.getNeighbourhood(FORCE, ID, h.ctx, budget),
        h.service.getPriorities(FORCE, ID, h.ctx, budget),
        h.service.getTeam(FORCE, ID, h.ctx, budget),
        h.service.getEvents(FORCE, ID, h.ctx, budget),
      ]),
    );
    expect(detail.kind).toBe('found');
    expect(priorities).toHaveLength(1);
    expect(team).toHaveLength(2);
    expect(events).toHaveLength(1);
    expect(h.upstream.calls).toHaveLength(4);
  });
});
