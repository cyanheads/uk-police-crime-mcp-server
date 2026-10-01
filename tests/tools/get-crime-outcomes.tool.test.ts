/**
 * @fileoverview ukcrime_get_crime_outcomes through `runToolContract` (the
 * production parse of output extended with enrichment): input preprocessing
 * (strings split on commas and whitespace, lower-cased, blanks and repeats
 * dropped, cut at 26), the `persistent_id` alias, per-id isolation (404 is a
 * result, other failures are results, an all-ids failure rethrows the first, an
 * aborted signal throws), `outcomes: null`, request pacing, the enrichment
 * fields on the zero-result page and the under-cap page, and `format()`
 * carrying the same data as `structuredContent` with upstream text kept inert.
 * @module tests/tools/get-crime-outcomes.tool.test
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
import { getCrimeOutcomesTool } from '@/mcp-server/tools/definitions/get-crime-outcomes.tool.js';
import { ATTRIBUTION } from '@/mcp-server/tools/shared-schemas.js';
import {
  emptyNotFound,
  hang,
  htmlBadRequest,
  htmlOk,
  jsonOk,
  networkError,
  plainNotFound,
  type Responder,
  rateLimited,
  sparseCrimeRecord,
  status,
  wireLocation,
} from '../fixtures/police-api-upstream.js';
import {
  crimeHistoryBody,
  delayed,
  historyOutcome,
  persistentIds,
  trackInFlight,
} from '../fixtures/police-api-upstream-w3.js';
import { settle, useToolHarness } from '../fixtures/service-harness.js';

type Input = z.input<typeof getCrimeOutcomesTool.input>;
type Output = z.output<typeof getCrimeOutcomesTool.output> & {
  attribution: string;
  data_note: string;
};
type Result = Awaited<ReturnType<typeof runToolContract>>;

const call = (input: Input) => settle(runToolContract(getCrimeOutcomesTool, input));
const callRaw = (input: unknown) => settle(runToolContract(getCrimeOutcomesTool, input as Input));

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
        data: { reason?: string; recovery?: { hint: string }; [k: string]: unknown };
      };
    }
  ).error;
};

const [A, B, C, D] = persistentIds(4) as [string, string, string, string];
const pathOf = (id: string) => `/outcomes-for-crime/${id}`;

const MISS_GUIDANCE = (n: number) =>
  `data.police.uk holds no crime for ${n} of these ids. Take persistent ids from the persistent_id field of ukcrime_search_crimes or ukcrime_search_outcomes results; anti-social behaviour records carry none.`;
const FAILED_GUIDANCE = (n: number) =>
  `${n} lookups failed upstream; call ukcrime_get_crime_outcomes again with just those ids.`;
const DATA_NOTE =
  'Police outcomes only — court results are not published. Locations are anonymised map points, not crime sites. A crime returned here is the record data.police.uk holds for the id; for Northern Ireland ids it can differ from the record that carried the id, so compare category and month.';

describe('ukcrime_get_crime_outcomes', () => {
  // Only /outcomes-for-crime is ever called; an unrouted request fails the test.
  const h = useToolHarness({ reference: false });

  /** Routes each id to its own history body. */
  const found = (...ids: string[]) => {
    for (const id of ids) h.upstream.route('GET', pathOf(id), jsonOk(crimeHistoryBody(id)));
  };

  describe('one id', () => {
    it('returns the crime, its outcomes in date order, and history_available true', async () => {
      found(A);
      const out = data(await call({ persistent_ids: [A] }));
      expect(out.crimes).toEqual([
        {
          persistent_id: A,
          id: '100000001',
          category: 'burglary',
          month: '2026-08',
          location: {
            location_id: '1000001',
            street_name: 'On or near Example Street',
            map_point: { latitude: 52.63, longitude: -1.13 },
            type: 'Force',
          },
          history_available: true,
          outcomes: [
            { code: 'under-investigation', name: 'Under investigation', month: '2026-06' },
            { code: 'unable-to-prosecute', name: 'Unable to prosecute suspect', month: '2026-07' },
          ],
        },
      ]);
      expect(out.not_found).toEqual([]);
      expect(out.failed).toEqual([]);
      expect(out).not.toHaveProperty('guidance');
    });

    it('sends one GET to /outcomes-for-crime/{id} with no query', async () => {
      found(A);
      await call({ persistent_ids: [A] });
      expect(h.upstream.calls).toHaveLength(1);
      const [sent] = h.upstream.calls;
      expect(sent?.method).toBe('GET');
      expect(sent?.path).toBe(pathOf(A));
      expect([...(sent?.query.keys() ?? [])]).toEqual([]);
    });

    it('reports the id that was requested as persistent_id, not the one upstream returned', async () => {
      h.upstream.route('GET', pathOf(A), jsonOk(crimeHistoryBody('f'.repeat(64))));
      const out = data(await call({ persistent_ids: [A] }));
      expect(out.crimes[0]?.persistent_id).toBe(A);
      expect(JSON.stringify(out)).not.toContain('f'.repeat(64));
    });

    it('sorts outcomes by month and keeps upstream order within a month', async () => {
      h.upstream.route(
        'GET',
        pathOf(A),
        jsonOk(
          crimeHistoryBody(A, {
            outcomes: [
              historyOutcome('second', 'Second', '2026-07'),
              historyOutcome('first', 'First', '2026-05'),
              historyOutcome('third', 'Third', '2026-07'),
            ],
          }),
        ),
      );
      const out = data(await call({ persistent_ids: [A] }));
      expect(out.crimes[0]?.outcomes.map((o) => o.code)).toEqual(['first', 'second', 'third']);
    });

    it('reads outcomes: null as history_available false and an empty list', async () => {
      h.upstream.route('GET', pathOf(A), jsonOk(crimeHistoryBody(A, { outcomes: null })));
      const result = await call({ persistent_ids: [A] });
      const [crime] = data(result).crimes;
      expect(crime?.history_available).toBe(false);
      expect(crime?.outcomes).toEqual([]);
      expect(text(result)).toContain(
        '**Outcome history:** not published by data.police.uk for this crime.',
      );
    });

    it('reads an empty outcome list as history_available true with none recorded', async () => {
      h.upstream.route('GET', pathOf(A), jsonOk(crimeHistoryBody(A, { outcomes: [] })));
      const result = await call({ persistent_ids: [A] });
      const [crime] = data(result).crimes;
      expect(crime?.history_available).toBe(true);
      expect(crime?.outcomes).toEqual([]);
      expect(text(result)).toContain('**Outcome history:** none recorded.');
    });

    it('leaves location and context out when the record has none (sparse crime)', async () => {
      h.upstream.route(
        'GET',
        pathOf(A),
        jsonOk(crimeHistoryBody(A, { crime: sparseCrimeRecord({ persistent_id: A }) })),
      );
      const [crime] = data(await call({ persistent_ids: [A] })).crimes;
      expect(crime).toEqual({
        persistent_id: A,
        id: '100000002',
        category: 'anti-social-behaviour',
        month: '2026-08',
        history_available: true,
        outcomes: expect.any(Array),
      });
    });

    it('keeps crime context as published and drops an empty one', async () => {
      h.upstream.route(
        'GET',
        pathOf(A),
        jsonOk(crimeHistoryBody(A, { crime: { context: 'Line one\r\nLine two' } })),
      );
      expect(data(await call({ persistent_ids: [A] })).crimes[0]?.context).toBe(
        'Line one\r\nLine two',
      );
      h.upstream.route('GET', pathOf(B), jsonOk(crimeHistoryBody(B, { crime: { context: '' } })));
      expect(data(await call({ persistent_ids: [B] })).crimes[0]).not.toHaveProperty('context');
    });

    it('omits a map point that upstream zeroed (more than 20 km from any map point)', async () => {
      h.upstream.route(
        'GET',
        pathOf(A),
        jsonOk(
          crimeHistoryBody(A, {
            crime: { location: wireLocation(7, 'On or near Far Lane', '0.000000', '0.000000') },
          }),
        ),
      );
      const [crime] = data(await call({ persistent_ids: [A] })).crimes;
      expect(crime?.location).toEqual({
        location_id: '7',
        street_name: 'On or near Far Lane',
        type: 'Force',
      });
    });
  });

  describe('input forms', () => {
    it('takes a list of ids and returns the crimes in input order', async () => {
      found(A, B, C);
      const out = data(await call({ persistent_ids: [C, A, B] }));
      expect(out.crimes.map((c) => c.persistent_id)).toEqual([C, A, B]);
    });

    it('keeps input order even when later ids answer first', async () => {
      h.upstream.route('GET', pathOf(A), delayed(2000, jsonOk(crimeHistoryBody(A))));
      h.upstream.route('GET', pathOf(B), jsonOk(crimeHistoryBody(B)));
      const out = data(await call({ persistent_ids: [A, B] }));
      expect(out.crimes.map((c) => c.persistent_id)).toEqual([A, B]);
    });

    it.each<[string, (ids: string[]) => unknown]>([
      ['a comma-separated string', ([a, b, c]) => `${a},${b},${c}`],
      ['a comma-and-space string', ([a, b, c]) => `${a}, ${b} ,${c}`],
      ['a whitespace-separated string', ([a, b, c]) => `${a} ${b}\t${c}`],
      ['a newline-separated string', ([a, b, c]) => `${a}\n${b}\r\n${c}`],
      [
        'a string with leading and trailing separators',
        ([a, b, c]) => `, ${a},${b};`.replace(';', `,${c},`),
      ],
      ['an array of comma-joined strings', ([a, b, c]) => [`${a},${b}`, c]],
      ['an array with blank items', ([a, b, c]) => [a, '', '  ', b, ',', c]],
    ])('reads %s as the three ids in order', async (_name, build) => {
      const ids = [A, B, C];
      found(...ids);
      const out = data(await callRaw({ persistent_ids: build(ids) }));
      expect(out.crimes.map((c) => c.persistent_id)).toEqual(ids);
    });

    it('reads a single bare id string', async () => {
      found(A);
      expect(data(await callRaw({ persistent_ids: A })).crimes).toHaveLength(1);
    });

    it('lower-cases the ids, requests the lower-case path and reports the lower-case id', async () => {
      const mixed = `${'AB'.repeat(16)}${'cD'.repeat(16)}`;
      const lower = mixed.toLowerCase();
      h.upstream.route('GET', pathOf(lower), jsonOk(crimeHistoryBody(lower)));
      const out = data(await callRaw({ persistent_ids: [mixed] }));
      expect(out.crimes[0]?.persistent_id).toBe(lower);
      expect(h.upstream.calls.map((c) => c.path)).toEqual([pathOf(lower)]);
    });

    it('drops repeats, keeping the first-seen order, and asks upstream once per distinct id', async () => {
      found(A, B);
      const out = data(await callRaw({ persistent_ids: `${B}, ${A} ${B.toUpperCase()}, ${A}` }));
      expect(out.crimes.map((c) => c.persistent_id)).toEqual([B, A]);
      expect(h.upstream.count(pathOf(A))).toBe(1);
      expect(h.upstream.count(pathOf(B))).toBe(1);
    });

    it('treats a case-only repeat as a repeat', async () => {
      found(A);
      await callRaw({ persistent_ids: [A, A.toUpperCase()] });
      expect(h.upstream.calls).toHaveLength(1);
    });

    it('accepts the singular persistent_id alias, as a string or a list', async () => {
      found(A, B);
      expect(data(await callRaw({ persistent_id: A })).crimes[0]?.persistent_id).toBe(A);
      expect(
        data(await callRaw({ persistent_id: `${A} ${B}` })).crimes.map((c) => c.persistent_id),
      ).toEqual([A, B]);
      expect(
        data(await callRaw({ persistent_id: [B] })).crimes.map((c) => c.persistent_id),
      ).toEqual([B]);
    });
  });

  describe('input limits and validation', () => {
    it('accepts exactly 25 ids and sends 25 requests', async () => {
      const ids = persistentIds(25);
      found(...ids);
      const out = data(await call({ persistent_ids: ids }));
      expect(out.crimes).toHaveLength(25);
      expect(h.upstream.calls).toHaveLength(25);
    });

    it('accepts 25 distinct ids followed by repeats of them (repeats are dropped before the limit)', async () => {
      const ids = persistentIds(25);
      found(...ids);
      const out = data(await callRaw({ persistent_ids: [...ids, ...ids.slice(0, 5)] }));
      expect(out.crimes).toHaveLength(25);
    });

    it('rejects 26 distinct ids as InvalidParams, before any request', async () => {
      const error = errorOf(await callRaw({ persistent_ids: persistentIds(26) }));
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(error.data.reason).toBe('invalid_arguments');
      expect(h.upstream.calls).toHaveLength(0);
    });

    it('cuts an over-long list at 26 first, so the rejection names the list once, not once per extra id', async () => {
      const error = errorOf(await callRaw({ persistent_ids: persistentIds(300).join(',') }));
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(error.message.match(/persistent_ids/g)?.length ?? 0).toBeLessThanOrEqual(2);
      expect(error.message.length).toBeLessThan(600);
      expect(h.upstream.calls).toHaveLength(0);
    });

    it.each<[string, unknown]>([
      ['a missing field', {}],
      ['null', { persistent_ids: null }],
      ['an empty string', { persistent_ids: '' }],
      ['a whitespace-only string', { persistent_ids: '  \n ' }],
      ['only separators', { persistent_ids: ' , ,, ' }],
      ['an empty list', { persistent_ids: [] }],
      ['a list of blanks', { persistent_ids: ['', ' '] }],
      ['a 63-character id', { persistent_ids: ['a'.repeat(63)] }],
      ['a 65-character id', { persistent_ids: ['a'.repeat(65)] }],
      ['a non-hex id', { persistent_ids: ['g'.repeat(64)] }],
      ['an id with a path in it', { persistent_ids: [`../${'a'.repeat(61)}`] }],
      ['a number', { persistent_ids: 5 }],
      ['an object', { persistent_ids: { id: A } }],
      ['a non-string list item', { persistent_ids: [A, 5] }],
      ['a good id beside a bad one', { persistent_ids: [A, 'zz'] }],
    ])('rejects %s as InvalidParams without any request', async (_name, input) => {
      const error = errorOf(await callRaw(input));
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(error.data.reason).toBe('invalid_arguments');
      expect(h.upstream.calls).toHaveLength(0);
    });
  });

  describe('not_found: a 404 is a result', () => {
    it.each([
      ['an empty-bodied 404', emptyNotFound],
      ['a text/plain 404', plainNotFound],
    ])(
      'reports %s under not_found with the guidance, and succeeds with no crimes (zero-result page)',
      async (_name, responder) => {
        h.upstream.route('GET', pathOf(A), responder);
        const result = await call({ persistent_ids: [A] });
        const out = data(result);
        expect(out.crimes).toEqual([]);
        expect(out.not_found).toEqual([A]);
        expect(out.failed).toEqual([]);
        expect(out.guidance).toBe(MISS_GUIDANCE(1));
        expect(h.upstream.count(pathOf(A))).toBe(1);
        expect(text(result)).toContain('0 found, 1 not found, 0 failed');
      },
    );

    it('lists misses in input order beside the crimes that were found, and counts them in the guidance', async () => {
      found(B);
      h.upstream.route('GET', pathOf(A), plainNotFound);
      h.upstream.route('GET', pathOf(C), emptyNotFound);
      const out = data(await call({ persistent_ids: [A, B, C] }));
      expect(out.crimes.map((c) => c.persistent_id)).toEqual([B]);
      expect(out.not_found).toEqual([A, C]);
      expect(out.guidance).toBe(MISS_GUIDANCE(2));
    });
  });

  describe('failed: any other lookup failure is a result', () => {
    it('reports one failing id under failed with its error text while the others return', async () => {
      found(A, C);
      h.upstream.route('GET', pathOf(B), status(500));
      const result = await call({ persistent_ids: [A, B, C] });
      const out = data(result);
      expect(out.crimes.map((c) => c.persistent_id)).toEqual([A, C]);
      expect(out.not_found).toEqual([]);
      expect(out.failed).toHaveLength(1);
      expect(out.failed[0]?.persistent_id).toBe(B);
      expect(out.failed[0]?.error).toEqual(expect.any(String));
      expect(out.failed[0]?.error.length).toBeGreaterThan(0);
      expect(out.guidance).toBe(FAILED_GUIDANCE(1));
      expect(h.upstream.count(pathOf(B))).toBe(3);
      expect(text(result)).toContain('2 found, 0 not found, 1 failed');
    });

    it.each<[string, Responder, number]>([
      ['a persistent 500', status(500), 3],
      ['a 502', status(502), 3],
      ['a 429', rateLimited('2'), 3],
      ['an HTML 200 body', htmlOk, 3],
      ['a body of the wrong shape', jsonOk({ crime: null }), 1],
      ['a crime without an id', jsonOk(crimeHistoryBody(B, { crime: { id: undefined } })), 1],
      ['a 400', htmlBadRequest, 1],
      ['an upstream that never answers', hang, 1],
    ])(
      'puts %s under failed and still succeeds when another id answered',
      async (_name, responder, _attempts) => {
        found(A);
        h.upstream.route('GET', pathOf(B), responder);
        const out = data(await call({ persistent_ids: [A, B] }));
        expect(out.crimes.map((c) => c.persistent_id)).toEqual([A]);
        expect(out.failed.map((f) => f.persistent_id)).toEqual([B]);
      },
    );

    it('does not retry a body of the wrong shape or a 400', async () => {
      found(A);
      h.upstream.route('GET', pathOf(B), jsonOk({ nope: true }));
      h.upstream.route('GET', pathOf(C), htmlBadRequest);
      await call({ persistent_ids: [A, B, C] });
      expect(h.upstream.count(pathOf(B))).toBe(1);
      expect(h.upstream.count(pathOf(C))).toBe(1);
    });

    it.each<[string, Responder, string]>([
      [
        'a 500 carrying upstream status text and a body',
        () =>
          new Response('upstream-body-text', {
            status: 500,
            statusText: 'Ask upstream-status-text',
          }),
        'data.police.uk is not answering (HTTP 500).',
      ],
      [
        'a 429 with Retry-After',
        rateLimited('2'),
        'data.police.uk rate-limited the lookup. Retry after 2 s.',
      ],
      ['a 429 without Retry-After', rateLimited(), 'data.police.uk rate-limited the lookup.'],
      ['an HTML 200 body', htmlOk, 'data.police.uk answered with a body that is not JSON.'],
      [
        'a body of the wrong shape',
        jsonOk({ crime: null }),
        'data.police.uk answered in an unexpected shape.',
      ],
      ['a 400', htmlBadRequest, 'data.police.uk refused the lookup (HTTP 400).'],
      ['an upstream that never answers', hang, 'data.police.uk did not answer in time.'],
      ['a network failure', networkError, 'data.police.uk is not answering.'],
    ])(
      'writes the failed error for %s from its code and reason, never upstream text',
      async (_name, responder, message) => {
        found(A);
        h.upstream.route('GET', pathOf(B), responder);
        const result = await call({ persistent_ids: [A, B] });
        expect(data(result).failed).toEqual([{ persistent_id: B, error: message }]);
        const json = JSON.stringify(result);
        expect(json).not.toContain('upstream-body-text');
        expect(json).not.toContain('upstream-status-text');
        expect(json).not.toContain('attempt');
      },
    );

    it('does not put the upstream response body in the failed error of a wrong-shape body', async () => {
      found(A);
      h.upstream.route('GET', pathOf(B), jsonOk({ secret: 'upstream-only-text' }));
      const result = await call({ persistent_ids: [A, B] });
      expect(JSON.stringify(result)).not.toContain('upstream-only-text');
    });

    it('joins the not_found and failed guidance in that order, one sentence each', async () => {
      found(A);
      h.upstream.route('GET', pathOf(B), plainNotFound);
      h.upstream.route('GET', pathOf(C), status(500));
      h.upstream.route('GET', pathOf(D), status(502));
      const out = data(await call({ persistent_ids: [A, B, C, D] }));
      expect(out.not_found).toEqual([B]);
      expect(out.failed.map((f) => f.persistent_id)).toEqual([C, D]);
      expect(out.guidance).toBe(`${MISS_GUIDANCE(1)} ${FAILED_GUIDANCE(2)}`);
    });

    it('logs one warning, not an error, for a partial failure', async () => {
      found(A);
      h.upstream.route('GET', pathOf(B), status(500));
      const ctx = createMockContext();
      const input = getCrimeOutcomesTool.input.parse({ persistent_ids: [A, B] });
      await settle(Promise.resolve(getCrimeOutcomesTool.handler(input, ctx)));
      const log = ctx.log as MockContextLogger;
      expect(log.calls.filter((c) => c.level === 'warning')).toHaveLength(1);
      expect(log.calls.some((c) => c.level === 'error')).toBe(false);
    });
  });

  describe('every id failing rethrows the first failure', () => {
    it.each<[string, Responder, number]>([
      ['a persistent 500', status(500), JsonRpcErrorCode.ServiceUnavailable],
      ['a 429', rateLimited('60'), JsonRpcErrorCode.RateLimited],
      ['an HTML 200 body', htmlOk, JsonRpcErrorCode.ServiceUnavailable],
      ['a wrong-shape body', jsonOk({ nope: true }), JsonRpcErrorCode.ServiceUnavailable],
      ['an upstream that never answers', hang, JsonRpcErrorCode.Timeout],
      ['a 400', htmlBadRequest, JsonRpcErrorCode.InvalidParams],
    ])(
      'fails the call with the classified error for %s on a single id',
      async (_name, responder, code) => {
        h.upstream.route('GET', pathOf(A), responder);
        const error = errorOf(await call({ persistent_ids: [A] }));
        expect(error.code).toBe(code);
      },
    );

    it('fails with the error of the first id in input order, not the first to fail', async () => {
      h.upstream.route('GET', pathOf(A), delayed(3000, rateLimited('60')));
      h.upstream.route('GET', pathOf(B), status(500));
      const error = errorOf(await call({ persistent_ids: [A, B] }));
      expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
    });

    it('fails with a classified error when every id fails with a different class', async () => {
      h.upstream.route('GET', pathOf(A), htmlOk);
      h.upstream.route('GET', pathOf(B), status(500));
      h.upstream.route('GET', pathOf(C), jsonOk('nope'));
      const error = errorOf(await call({ persistent_ids: [A, B, C] }));
      expect(error.data.reason).toBe('unreadable_response');
    });

    it('does not rethrow when one id was only missing: a 404 beside a failure is a partial success', async () => {
      h.upstream.route('GET', pathOf(A), plainNotFound);
      h.upstream.route('GET', pathOf(B), status(500));
      const out = data(await call({ persistent_ids: [A, B] }));
      expect(out.crimes).toEqual([]);
      expect(out.not_found).toEqual([A]);
      expect(out.failed.map((f) => f.persistent_id)).toEqual([B]);
    });

    it('does not rethrow when every id was missing', async () => {
      h.upstream.route('GET', pathOf(A), plainNotFound);
      h.upstream.route('GET', pathOf(B), plainNotFound);
      const out = data(await call({ persistent_ids: [A, B] }));
      expect(out.not_found).toEqual([A, B]);
      expect(out.guidance).toBe(MISS_GUIDANCE(2));
    });
  });

  describe('cancellation', () => {
    it('throws RequestCancelled when the signal is already aborted, without a request', async () => {
      found(A);
      const controller = new AbortController();
      controller.abort(new Error('client went away'));
      const result = await settle(
        runToolContract(
          getCrimeOutcomesTool,
          { persistent_ids: [A] },
          { context: { signal: controller.signal } },
        ),
      );
      expect(errorOf(result).code).toBe(JsonRpcErrorCode.RequestCancelled);
      expect(h.upstream.calls).toHaveLength(0);
    });

    it('throws when the signal aborts mid-call, even though one id already answered (no partial success)', async () => {
      found(A);
      h.upstream.route('GET', pathOf(B), hang);
      const controller = new AbortController();
      setTimeout(() => controller.abort(new Error('client went away')), 500);
      const result = await settle(
        runToolContract(
          getCrimeOutcomesTool,
          { persistent_ids: [A, B] },
          { context: { signal: controller.signal } },
        ),
      );
      expect(errorOf(result).code).toBe(JsonRpcErrorCode.RequestCancelled);
      expect(h.upstream.count(pathOf(A))).toBe(1);
    });

    it('throws when the signal aborts while every lookup is hung', async () => {
      h.upstream.route('GET', pathOf(A), hang);
      h.upstream.route('GET', pathOf(B), hang);
      const controller = new AbortController();
      setTimeout(() => controller.abort(new Error('client went away')), 500);
      const result = await settle(
        runToolContract(
          getCrimeOutcomesTool,
          { persistent_ids: [A, B] },
          { context: { signal: controller.signal } },
        ),
      );
      expect(errorOf(result).code).toBe(JsonRpcErrorCode.RequestCancelled);
    });
  });

  describe('request pacing', () => {
    it('sends one request per distinct id, never more than four in flight, and finishes inside the call budget', async () => {
      const ids = persistentIds(25);
      const tracker = trackInFlight(200, (request) => {
        const id = new URL(request.url).pathname.split('/').pop() ?? '';
        return jsonOk(crimeHistoryBody(id))(request);
      });
      for (const id of ids) h.upstream.route('GET', pathOf(id), tracker.respond);
      const started = Date.now();
      const out = data(await call({ persistent_ids: ids }));
      expect(out.crimes).toHaveLength(25);
      expect(tracker.peak()).toBeLessThanOrEqual(4);
      expect(tracker.peak()).toBeGreaterThan(1);
      expect(h.upstream.calls).toHaveLength(25);
      expect(Date.now() - started).toBeLessThan(50_000);
    });

    it('does not start more than fifteen requests in any second', async () => {
      const ids = persistentIds(25);
      found(...ids);
      await call({ persistent_ids: ids });
      const starts = h.upstream.calls.map((c) => c.at);
      for (const start of starts) {
        expect(starts.filter((at) => at >= start && at < start + 1000).length).toBeLessThanOrEqual(
          15,
        );
      }
    });

    it('does not cache histories: a repeat call asks upstream again', async () => {
      found(A);
      await call({ persistent_ids: [A] });
      await call({ persistent_ids: [A] });
      expect(h.upstream.count(pathOf(A))).toBe(2);
    });

    it('shares one 50 s budget: lookups that cannot finish inside it fail instead of running on', async () => {
      h.upstream.route('GET', pathOf(A), delayed(120_000, jsonOk(crimeHistoryBody(A))));
      const error = errorOf(await call({ persistent_ids: [A] }));
      expect(error.code).toBe(JsonRpcErrorCode.Timeout);
    });
  });

  describe('enrichment: the zero-result page and the under-cap page', () => {
    it('zero-result page (every id missing): attribution and data_note present, crimes empty', async () => {
      h.upstream.route('GET', pathOf(A), plainNotFound);
      const result = await call({ persistent_ids: [A] });
      const out = data(result);
      expect(out.attribution).toBe(ATTRIBUTION);
      expect(out.data_note).toBe(DATA_NOTE);
      expect(out.crimes).toEqual([]);
      const rendered = text(result);
      expect(rendered).toContain('**Attribution:**');
      expect(rendered).toContain('**Data note:**');
    });

    it('under-cap page (3 of up to 25 ids found): attribution and data_note present', async () => {
      found(A, B, C);
      const result = await call({ persistent_ids: [A, B, C] });
      const out = data(result);
      expect(out.attribution).toBe(ATTRIBUTION);
      expect(out.data_note).toBe(DATA_NOTE);
      expect(out.crimes).toHaveLength(3);
      expect(text(result)).toContain(`**Attribution:** ${ATTRIBUTION}`);
    });

    it('partial-failure page: both required fields still present', async () => {
      found(A);
      h.upstream.route('GET', pathOf(B), status(500));
      const out = data(await call({ persistent_ids: [A, B] }));
      expect(out.attribution).toBe(ATTRIBUTION);
      expect(out.data_note).toBe(DATA_NOTE);
      expect(out).not.toHaveProperty('notice');
    });

    it('writes attribution then data_note, before any request, and nothing else', async () => {
      found(A);
      const ctx = createMockContext({ errors: getCrimeOutcomesTool.errors });
      const input = getCrimeOutcomesTool.input.parse({ persistent_ids: [A] });
      await settle(Promise.resolve(getCrimeOutcomesTool.handler(input, ctx)));
      expect(Object.keys(getEnrichment(ctx))).toEqual(['attribution', 'data_note']);
    });

    it('has the required fields in place when every lookup fails', async () => {
      h.upstream.route('GET', pathOf(A), status(500));
      const ctx = createMockContext({ errors: getCrimeOutcomesTool.errors });
      const input = getCrimeOutcomesTool.input.parse({ persistent_ids: [A] });
      await expect(
        settle(Promise.resolve(getCrimeOutcomesTool.handler(input, ctx))),
      ).rejects.toThrow();
      expect(getEnrichment(ctx)).toEqual({ attribution: ATTRIBUTION, data_note: DATA_NOTE });
    });
  });

  describe('format() matches structuredContent', () => {
    it('renders every crime with its persistent_id, id, category, month, location and outcome lines', async () => {
      found(A, B);
      h.upstream.route(
        'GET',
        pathOf(B),
        jsonOk(
          crimeHistoryBody(B, {
            crime: { category: 'drugs', month: '2026-06', context: 'Some context' },
          }),
        ),
      );
      const result = await call({ persistent_ids: [A, B] });
      const out = data(result);
      const rendered = text(result);
      expect(rendered).toContain('## Crime outcome histories — 2 found, 0 not found, 0 failed');
      for (const crime of out.crimes) {
        expect(rendered).toContain(`### ${crime.category} · ${crime.month}`);
        expect(rendered).toContain(
          `**persistent_id:** ${crime.persistent_id} · **id:** ${crime.id}`,
        );
        for (const outcome of crime.outcomes) {
          expect(rendered).toContain(`- ${outcome.month} · ${outcome.name} (${outcome.code})`);
        }
      }
      expect(rendered).toContain(
        '**Location:** On or near Example Street · location_id 1000001 · anonymised map point 52.63, -1.13 · Force',
      );
      expect(rendered).toContain('**Context:**\n> Some context');
    });

    it('lists outcomes in the order structuredContent carries them', async () => {
      found(A);
      const result = await call({ persistent_ids: [A] });
      const rendered = text(result);
      expect(rendered.indexOf('2026-06 · Under investigation')).toBeLessThan(
        rendered.indexOf('2026-07 · Unable to prosecute suspect'),
      );
    });

    it('renders not_found ids, failed ids with their error, and the guidance', async () => {
      found(A);
      h.upstream.route('GET', pathOf(B), plainNotFound);
      h.upstream.route('GET', pathOf(C), status(500));
      const result = await call({ persistent_ids: [A, B, C] });
      const out = data(result);
      const rendered = text(result);
      expect(rendered).toContain('### Not found');
      expect(rendered).toContain(`- ${B}`);
      expect(rendered).toContain('### Failed lookups');
      expect(rendered).toContain(`- ${C}: `);
      expect(rendered).toContain(`**Guidance:** ${out.guidance}`);
      expect(rendered).toContain('1 found, 1 not found, 1 failed');
    });

    it('omits the not-found, failed and guidance sections when there are none', async () => {
      found(A);
      const rendered = text(await call({ persistent_ids: [A] }));
      expect(rendered).not.toContain('### Not found');
      expect(rendered).not.toContain('### Failed lookups');
      expect(rendered).not.toContain('**Guidance:**');
    });

    it('keeps upstream text verbatim in structuredContent and inert in the markdown', async () => {
      const hostile = 'Evil\r\n# Injected | cell [x](https://evil.test) <b>\u202Etxt';
      const context = 'Ctx\u2028# Heading\u2029[link](https://evil.test)\u0085<i>x</i>\u202E';
      h.upstream.route(
        'GET',
        pathOf(A),
        jsonOk(
          crimeHistoryBody(A, {
            crime: {
              context,
              location: wireLocation(1_000_005, hostile, '52.630000', '-1.130000'),
              location_subtype: hostile,
            },
            outcomes: [historyOutcome('odd|code', hostile, '2026-07')],
          }),
        ),
      );
      const result = await call({ persistent_ids: [A] });
      const [crime] = data(result).crimes;
      expect(crime?.outcomes[0]?.name).toBe(hostile);
      expect(crime?.location?.street_name).toBe(hostile);
      expect(crime?.context).toBe(context);
      const rendered = text(result);
      for (const char of ['\r', '\u2028', '\u2029', '\u0085', '\u202E']) {
        expect(rendered.includes(char), JSON.stringify(char)).toBe(false);
      }
      for (const line of rendered.split('\n')) expect(line.startsWith('# '), line).toBe(false);
      expect(rendered).toContain(
        '- 2026-07 · Evil # Injected | cell \\[x\\](https://evil.test) \\<b\\>txt (odd|code)',
      );
      expect(rendered).toContain(
        '**Context:**\n> Ctx\n> # Heading\n> \\[link\\](https://evil.test)\n> ',
      );
    });

    it('keeps CR/LF in outcome and street names out of the list and heading slots', async () => {
      h.upstream.route(
        'GET',
        pathOf(A),
        jsonOk(
          crimeHistoryBody(A, {
            crime: {
              category: 'cat\r\negory',
              location: wireLocation(
                1_000_006,
                'On or near\r\nBreak Street',
                '52.630000',
                '-1.130000',
              ),
            },
            outcomes: [historyOutcome('c', 'Name\r\nwith\nbreaks', '2026-07')],
          }),
        ),
      );
      const rendered = text(await call({ persistent_ids: [A] }));
      expect(rendered).toContain('### cat egory · 2026-08');
      expect(rendered).toContain('- 2026-07 · Name with breaks (c)');
      expect(rendered).toContain('On or near Break Street · location_id 1000006');
      expect(rendered).not.toContain('\r');
    });

    it('escapes a failed-lookup error so it stays one inert line', async () => {
      const output = {
        crimes: [],
        not_found: [],
        failed: [{ persistent_id: A, error: 'Boom\r\n# Injected [x](https://evil.test)' }],
        guidance: 'Guidance\r\n# Injected too',
      };
      const rendered =
        getCrimeOutcomesTool
          .format?.(output)
          .map((b) => (b.type === 'text' ? b.text : ''))
          .join('') ?? '';
      expect(rendered).toContain(`- ${A}: Boom # Injected \\[x\\](https://evil.test)`);
      expect(rendered).toContain('**Guidance:** Guidance # Injected too');
      expect(rendered).not.toContain('\r');
    });

    it('labels every coordinate pair an anonymised map point', async () => {
      found(A);
      const rendered = text(await call({ persistent_ids: [A] }));
      for (const line of rendered.split('\n').filter((l) => /52\.63, -1\.13/.test(l))) {
        expect(line).toContain('anonymised map point');
      }
    });
  });
});
