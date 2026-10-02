/**
 * @fileoverview ukcrime_search_stops over a month range (`month_from`) through
 * `runToolContract`: the one-month shape and requests left as they were, the
 * month checks, totals, breakdowns and rows over the range with per-month
 * totals and stop-and-search publication on both surfaces, paging across month
 * boundaries from the cache, filters in every month, every area arm, a partial
 * located set, all-or-nothing failure with in-flight months cached, and the
 * budget and size stops.
 * @module tests/tools/search-stops-range.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { searchStopsTool } from '@/mcp-server/tools/definitions/search-stops.tool.js';
import { RANGE_MAX_WEIGHT } from '@/services/police-api/police-api-service.js';
import {
  boundaryBody,
  emptyArrayOk,
  jsonOk,
  lastUpdatedBody,
  locateBody,
  locateBy,
  monthsBetween,
  overloaded,
  perMonth,
  type Responder,
  rateLimited,
  STRADDLE_RING,
  STRADDLE_SAMPLES,
  status,
  stopRecord,
  stopsBody,
  streetDatesBody,
  textOk,
  wireLocation,
} from '../fixtures/police-api-upstream.js';
import { delayed, trackInFlight } from '../fixtures/police-api-upstream-w3.js';
import { settle, useToolHarness } from '../fixtures/service-harness.js';

type Input = z.input<typeof searchStopsTool.input>;
type Output = z.output<typeof searchStopsTool.output> & { notice?: string };
type Result = Awaited<ReturnType<typeof runToolContract>>;

const call = (input: Input) => settle(runToolContract(searchStopsTool, input));

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
        data: { reason?: string; recovery?: { hint: string }; retryable?: boolean };
      };
    }
  ).error;
};

const POINT = { area: 'point', lat: 52.63, lng: -1.13 } as const;
const DYFED_POWYS = { area: 'force', force: 'dyfed-powys' } as const;
const STRADDLE = { area: 'polygon', polygon: [...STRADDLE_RING] } as const;
const STREET = '/stops-street';
const FORCE_ROUTE = '/stops-force';
const MIB = 1024 * 1024;

/** Every key a one-month stops result carries on structuredContent, enrichment included, before any notice. */
const ONE_MONTH_KEYS = [
  'area',
  'attribution',
  'by_age_range',
  'by_gender',
  'by_legislation',
  'by_object_of_search',
  'by_officer_defined_ethnicity',
  'by_outcome',
  'by_outcome_linked_to_object_of_search',
  'by_removal_of_more_than_outer_clothing',
  'by_self_defined_ethnicity',
  'by_type',
  'cap',
  'data_note',
  'filters',
  'force_published',
  'month',
  'shown',
  'stops',
  'total',
  'truncated',
  'unfiltered_total',
  'unplaced',
];

/** `n` stops in `month`, one a day from the 1st at 10:00 UTC. */
const stopsIn = (month: string, n: number, overrides: Record<string, unknown> = {}) =>
  Array.from({ length: n }, (_, i) =>
    stopRecord({
      datetime: `${month}-${String(i + 1).padStart(2, '0')}T10:00:00+00:00`,
      ...overrides,
    }),
  );

const notPublished = (name: string, id: string, months: string) =>
  `${name} has not published stop and search data for ${months} to data.police.uk; call ukcrime_list_reference with topic 'availability' and force '${id}' for the months it has.`;
const ZERO_HERE = (span: string) =>
  `No stops recorded here in ${span}; try another month, a wider area, or area 'force' for the whole force, including stops it could not place.`;
const RANGE_LINE =
  '**Every force found for the area published stop and search in every month of the range:**';
const BY_MONTH_HEADER = '| Month | Stops | Every force found for the area published |';

describe('ukcrime_search_stops over a month range', () => {
  const h = useToolHarness();

  const requests = () =>
    h.upstream.calls.map(({ method, path, query }) => `${method} ${path} ${query}`).sort();

  /** The months requested from `path`, in the order sent. */
  const asked = (path = STREET) =>
    h.upstream
      .callsTo(path)
      .map((c) => c.query.get('date') ?? new URLSearchParams(c.body).get('date'));

  const locates = () => h.upstream.route('GET', '/locate-neighbourhood', jsonOk(locateBody()));

  /** Stop-and-search publishers by month: Dyfed-Powys through 2025-11, never after. */
  const dyfedPowysDates = () =>
    h.upstream.route(
      'GET',
      '/crimes-street-dates',
      jsonOk(
        streetDatesBody({
          stopSearch: (month) =>
            month <= '2025-11' ? ['dyfed-powys', 'leicestershire', 'btp'] : ['leicestershire'],
        }),
      ),
    );

  describe('one month (no month_from): the result shape and the requests sent', () => {
    it('point: the same keys, one stops request for the month, one locate, the one-month heading and publication line', async () => {
      h.upstream.route('GET', STREET, jsonOk(stopsBody()));
      locates();
      const result = await call({ ...POINT, month: '2026-07' });
      expect(Object.keys(result.structuredContent ?? {}).sort()).toEqual(ONE_MONTH_KEYS);
      expect(requests()).toEqual([
        'GET /crimes-street-dates ',
        'GET /locate-neighbourhood q=52.630000%2C-1.130000',
        'GET /stops-street lat=52.630000&lng=-1.130000&date=2026-07',
      ]);
      const markdown = text(result);
      expect(markdown).toContain('## Stop and search — 2026-07\n');
      expect(markdown).toContain(
        '**Every force found for the area published stop and search this month:** yes',
      );
      expect(markdown).not.toContain('By month');
    });

    it('force: one stops-force request for the defaulted month; a non-publisher named for that month alone', async () => {
      dyfedPowysDates();
      h.upstream.route('GET', FORCE_ROUTE, jsonOk([]));
      const result = await call({ ...DYFED_POWYS });
      const out = data(result);
      expect(Object.keys(out).sort()).toEqual([...ONE_MONTH_KEYS, 'notice'].sort());
      expect(out.force_published).toBe(false);
      expect(out.notice).toBe(
        `No month given; searched 2026-08, the latest published month. ${notPublished('Dyfed-Powys Police', 'dyfed-powys', '2026-08')}`,
      );
      expect(requests()).toEqual([
        'GET /crimes-street-dates ',
        'GET /forces ',
        'GET /stops-force force=dyfed-powys&date=2026-08',
      ]);
      expect(text(result)).toContain(
        '**Every force found for the area published stop and search this month:** no',
      );
    });
  });

  describe('month checks, before any area request', () => {
    it('refuses a month_from before the window as month_out_of_range naming month_from, never clipping it', async () => {
      const error = errorOf(
        await call({ ...DYFED_POWYS, month_from: '2023-08', month: '2024-03' }),
      );
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data.reason).toBe('month_out_of_range');
      expect(error.message).toBe(
        'month_from 2023-08 is before 2023-09, the earliest month data.police.uk still serves.',
      );
      expect(h.upstream.count(FORCE_ROUTE)).toBe(0);
    });

    it('refuses a month_from after the latest month as month_not_published naming month_from', async () => {
      const error = errorOf(await call({ ...POINT, month_from: '2026-09' }));
      expect(error.data.reason).toBe('month_not_published');
      expect(error.message).toBe(
        'month_from 2026-09 is not published yet; the latest published month is 2026-08.',
      );
      expect(error.data.recovery?.hint).toBe(
        "Call ukcrime_list_reference with topic 'availability' for the published months, or omit month to search the latest one; month_from must be a published month no later than month.",
      );
      expect(h.upstream.count(STREET)).toBe(0);
      expect(h.upstream.count('/locate-neighbourhood')).toBe(0);
    });

    it('refuses a month_from after month, and a 13-month range, as invalid_month_range with the declared recovery', async () => {
      const after = await call({ ...POINT, month_from: '2026-05', month: '2026-03' });
      expect(errorOf(after).data.reason).toBe('invalid_month_range');
      expect(errorOf(after).message).toBe(
        'month_from 2026-05 is after month 2026-03; month_from is the first month of the range.',
      );
      expect(errorOf(after).data.recovery?.hint).toBe(
        'Send a month_from no later than month, making a range of at most 12 months counting both ends; with month omitted, the range ends at the latest published month.',
      );
      expect(text(after)).toContain('Recovery:');

      const long = errorOf(await call({ ...POINT, month_from: '2025-08' }));
      expect(long.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(long.message).toBe(
        '2025-08–2026-08 covers 13 months; a range covers at most 12, so for month 2026-08 month_from can be 2025-09 at the earliest.',
      );
      expect(h.upstream.count(STREET)).toBe(0);
    });

    it('checks month first, then month_from, then the force', async () => {
      const unknown = { area: 'force', force: 'nowhere' } as const;
      expect(
        errorOf(await call({ ...unknown, month: '2026-09', month_from: '2023-01' })).message,
      ).toBe('2026-09 is not published yet; the latest published month is 2026-08.');
      expect(errorOf(await call({ ...unknown, month_from: '2023-01' })).data.reason).toBe(
        'month_out_of_range',
      );
      expect(
        errorOf(await call({ ...unknown, month_from: '2026-08', month: '2026-01' })).data.reason,
      ).toBe('invalid_month_range');
      expect(errorOf(await call({ ...unknown, month_from: '2026-07' })).data.reason).toBe(
        'unknown_force',
      );
      expect(h.upstream.count(FORCE_ROUTE)).toBe(0);
    });

    it('rejects a malformed month_from at the schema, and reads a blank one as unset (one month, no by_month)', async () => {
      expect(errorOf(await call({ ...POINT, month_from: '2026-13' })).code).toBe(
        JsonRpcErrorCode.InvalidParams,
      );
      h.upstream.route('GET', STREET, emptyArrayOk);
      locates();
      const out = data(await call({ ...POINT, month: '2026-07', month_from: '  ' }));
      expect(out).not.toHaveProperty('month_from');
      expect(out).not.toHaveProperty('by_month');
      expect(asked()).toEqual(['2026-07']);
    });

    it('declares the three range reasons with their codes, and names month_from on month_out_of_range', () => {
      const declared = Object.fromEntries(
        (searchStopsTool.errors ?? []).map((entry) => [entry.reason, entry]),
      );
      expect(declared.invalid_month_range).toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
      });
      expect(declared.range_too_large).toMatchObject({ code: JsonRpcErrorCode.ValidationError });
      expect(declared.range_incomplete).toMatchObject({
        code: JsonRpcErrorCode.Timeout,
        retryable: true,
      });
      expect(declared.month_out_of_range?.when).toBe(
        'month or month_from is before the 36-month window',
      );
    });
  });

  describe('a range at a point', () => {
    /** 2025-09..2026-08, with no stops in 2025-10. */
    const COUNTS: Readonly<Record<string, number>> = {
      '2025-09': 2,
      '2025-10': 0,
      '2025-11': 1,
      '2025-12': 3,
      '2026-01': 1,
      '2026-02': 1,
      '2026-03': 2,
      '2026-04': 1,
      '2026-05': 1,
      '2026-06': 1,
      '2026-07': 1,
      '2026-08': 2,
    };
    const yearOf = () =>
      Object.fromEntries(
        Object.entries(COUNTS).map(([month, n]) => [month, jsonOk(stopsIn(month, n))]),
      );

    it('12 months: one request a month (at most two in flight) and one locate; totals, flags, breakdowns and rows over the range in datetime order, on both surfaces', async () => {
      const tracked = trackInFlight(1000, perMonth(yearOf()));
      h.upstream.route('GET', STREET, tracked.respond);
      locates();
      const result = await call({ ...POINT, month_from: '2025-09', month: '2026-08', limit: 200 });
      const out = data(result);
      expect(out.month_from).toBe('2025-09');
      expect(out.month).toBe('2026-08');
      expect(out.by_month).toEqual(
        Object.entries(COUNTS).map(([month, total]) => ({ month, total, force_published: true })),
      );
      expect(out.total).toBe(16);
      expect(out.unfiltered_total).toBe(16);
      expect(out.by_month?.reduce((sum, row) => sum + row.total, 0)).toBe(out.total);
      expect(out.unplaced).toBe(0);
      expect(out.force_published).toBe(true);
      expect(out.by_type).toEqual([{ value: 'Person search', count: 16 }]);
      expect(out.stops.map((stop) => stop.datetime)).toEqual(
        Object.entries(COUNTS).flatMap(([month, n]) =>
          Array.from(
            { length: n },
            (_, i) => `${month}-${String(i + 1).padStart(2, '0')}T10:00:00+00:00`,
          ),
        ),
      );
      expect(out.notice).toBeUndefined();
      expect([...asked()].sort()).toEqual(Object.keys(COUNTS));
      expect(h.upstream.count('/locate-neighbourhood')).toBe(1);
      expect(tracked.peak()).toBe(2);

      const markdown = text(result);
      expect(markdown).toContain('## Stop and search — 2025-09–2026-08\n');
      expect(markdown).toContain('**Stops matched:** 16 of 16 · **Without a location:** 0');
      expect(markdown).toContain(
        `### By month\n\n${BY_MONTH_HEADER}\n|:--|--:|:--|\n| 2025-09 | 2 | yes |\n| 2025-10 | 0 | yes |\n`,
      );
      expect(markdown).toContain('| 2026-08 | 2 | yes |');
      expect(markdown).toContain(`${RANGE_LINE} yes`);
      expect(markdown).not.toContain('this month');
    });

    it('treats month_from equal to month as a one-month range: one row, both months echoed', async () => {
      h.upstream.route('GET', STREET, perMonth(yearOf()));
      locates();
      const result = await call({ ...POINT, month_from: '2026-07', month: '2026-07' });
      const out = data(result);
      expect(Object.keys(out).sort()).toEqual([...ONE_MONTH_KEYS, 'by_month', 'month_from'].sort());
      expect(out.month_from).toBe('2026-07');
      expect(out.by_month).toEqual([{ month: '2026-07', total: 1, force_published: true }]);
      expect(text(result)).toContain('## Stop and search — 2026-07\n');
      expect(asked()).toEqual(['2026-07']);
    });

    it('defaults month to the latest month and says the range ends there', async () => {
      h.upstream.route('GET', STREET, perMonth(yearOf()));
      locates();
      const out = data(await call({ ...POINT, month_from: '2026-06' }));
      expect(out.month).toBe('2026-08');
      expect(out.by_month?.map((row) => row.month)).toEqual(['2026-06', '2026-07', '2026-08']);
      expect(out.notice).toBe(
        'No month given; searched 2026-06–2026-08, a range ending at 2026-08, the latest published month.',
      );
    });

    it('names the range in the zero-hit fragment', async () => {
      h.upstream.route('GET', STREET, emptyArrayOk);
      locates();
      const out = data(await call({ ...POINT, month_from: '2026-06', month: '2026-07' }));
      expect(out.total).toBe(0);
      expect(out.notice).toBe(ZERO_HERE('2026-06–2026-07'));
    });

    it('pages across a month boundary from the cache, and says when the offset is past the end', async () => {
      h.upstream.route(
        'GET',
        STREET,
        perMonth({
          '2026-07': jsonOk(stopsIn('2026-07', 3)),
          '2026-08': jsonOk(stopsIn('2026-08', 3)),
        }),
      );
      locates();
      const range = { ...POINT, month_from: '2026-07', month: '2026-08', limit: 4 } as const;
      const first = data(await call(range));
      expect(first.stops.map((stop) => stop.datetime.slice(0, 10))).toEqual([
        '2026-07-01',
        '2026-07-02',
        '2026-07-03',
        '2026-08-01',
      ]);
      expect(first.next_offset).toBe(4);
      expect(first.notice).toBe('Showing 1–4 of 6; call again with offset 4 for more.');

      const second = data(await call({ ...range, offset: 4 }));
      expect(second.stops.map((stop) => stop.datetime.slice(0, 10))).toEqual([
        '2026-08-02',
        '2026-08-03',
      ]);
      expect(second.next_offset).toBeUndefined();
      expect(second.by_month).toEqual(first.by_month);

      const past = data(await call({ ...range, offset: 10 }));
      expect(past.stops).toEqual([]);
      expect(past.notice).toBe(
        'offset 10 is past the last of 6 stops; omit offset to start from the first.',
      );

      expect(asked()).toHaveLength(2);
      expect(h.upstream.count('/locate-neighbourhood')).toBe(1);
    });
  });

  describe('stop-and-search publication over a range', () => {
    const SKIPPED = [
      '2025-12',
      '2026-01',
      '2026-02',
      '2026-03',
      '2026-04',
      '2026-05',
      '2026-06',
      '2026-07',
      '2026-08',
    ];

    it('Dyfed-Powys 2025-09–2026-08: true through 2025-11 and false from 2025-12, the top-level flag false, the skipped months listed', async () => {
      dyfedPowysDates();
      h.upstream.route(
        'GET',
        FORCE_ROUTE,
        perMonth({
          '2025-09': jsonOk(stopsIn('2025-09', 2)),
          '2025-10': jsonOk(stopsIn('2025-10', 1)),
          '2025-11': jsonOk(stopsIn('2025-11', 3)),
        }),
      );
      const result = await call({ ...DYFED_POWYS, month_from: '2025-09', month: '2026-08' });
      const out = data(result);
      expect(out.by_month).toEqual([
        { month: '2025-09', total: 2, force_published: true },
        { month: '2025-10', total: 1, force_published: true },
        { month: '2025-11', total: 3, force_published: true },
        ...SKIPPED.map((month) => ({ month, total: 0, force_published: false })),
      ]);
      expect(out.force_published).toBe(false);
      expect(out.total).toBe(6);
      expect(out.notice).toBe(
        notPublished('Dyfed-Powys Police', 'dyfed-powys', SKIPPED.join(', ')),
      );
      expect(asked(FORCE_ROUTE)).toHaveLength(12);
      expect(h.upstream.count('/forces')).toBe(1);

      const markdown = text(result);
      expect(markdown).toContain('| 2025-11 | 3 | yes |\n| 2025-12 | 0 | no |\n');
      expect(markdown).toContain(`${RANGE_LINE} no`);
      expect(markdown).toContain(`> ${out.notice}`);
    });

    it('a new latest month fetches the cached months again, so a month backfilled in the release never reads as published with no stops', async () => {
      h.upstream
        .route(
          'GET',
          '/crimes-street-dates',
          jsonOk(
            streetDatesBody({
              stopSearch: (month) => (month === '2026-08' ? ['btp'] : ['leicestershire', 'btp']),
            }),
          ),
        )
        .route('GET', FORCE_ROUTE, perMonth({ '2026-07': jsonOk(stopsIn('2026-07', 5)) }));
      const range = { area: 'force', force: 'leicestershire', month_from: '2026-07' } as const;
      expect(data(await call({ ...range, month: '2026-08' })).by_month).toEqual([
        { month: '2026-07', total: 5, force_published: true },
        { month: '2026-08', total: 0, force_published: false },
      ]);

      // data.police.uk releases 2026-09 and backfills Leicestershire's 2026-08.
      h.upstream
        .route('GET', '/crime-last-updated', jsonOk(lastUpdatedBody('2026-09-01')))
        .route('GET', '/crimes-street-dates', jsonOk(streetDatesBody({ to: '2026-09' })))
        .route(
          'GET',
          FORCE_ROUTE,
          perMonth({
            '2026-07': jsonOk(stopsIn('2026-07', 5)),
            '2026-08': jsonOk(stopsIn('2026-08', 9)),
            '2026-09': jsonOk(stopsIn('2026-09', 4)),
          }),
        );
      const result = await call({ ...range, month: '2026-09' });
      const out = data(result);
      expect(out.by_month).toEqual([
        { month: '2026-07', total: 5, force_published: true },
        { month: '2026-08', total: 9, force_published: true },
        { month: '2026-09', total: 4, force_published: true },
      ]);
      expect(out.force_published).toBe(true);
      expect(out.total).toBe(18);
      expect(asked(FORCE_ROUTE).slice(2).sort()).toEqual(['2026-07', '2026-08', '2026-09']);
      expect(text(result)).toContain('| 2026-08 | 9 | yes |');
    });

    it('a range the force published no month of: every flag false, and the not-published fragment alone explains the zero', async () => {
      dyfedPowysDates();
      h.upstream.route('GET', FORCE_ROUTE, emptyArrayOk);
      const out = data(await call({ ...DYFED_POWYS, month_from: '2025-12', month: '2026-02' }));
      expect(out.by_month).toEqual(
        ['2025-12', '2026-01', '2026-02'].map((month) => ({
          month,
          total: 0,
          force_published: false,
        })),
      );
      expect(out.force_published).toBe(false);
      expect(out.notice).toBe(
        notPublished('Dyfed-Powys Police', 'dyfed-powys', '2025-12, 2026-01, 2026-02'),
      );
    });

    it('keeps the zero line naming the range when the force published some month of it', async () => {
      dyfedPowysDates();
      h.upstream.route('GET', FORCE_ROUTE, emptyArrayOk);
      const out = data(await call({ ...DYFED_POWYS, month_from: '2025-11', month: '2025-12' }));
      expect(out.by_month).toEqual([
        { month: '2025-11', total: 0, force_published: true },
        { month: '2025-12', total: 0, force_published: false },
      ]);
      expect(out.notice).toBe(
        [
          notPublished('Dyfed-Powys Police', 'dyfed-powys', '2025-12'),
          'No stops recorded for this force in 2025-11–2025-12; try another month.',
        ].join(' '),
      );
    });

    it('leaves a month with no row in the publication list unflagged, and the top-level flag out when no month is false', async () => {
      h.upstream.route(
        'GET',
        '/crimes-street-dates',
        jsonOk(streetDatesBody().filter((row) => row.date !== '2026-07')),
      );
      h.upstream.route(
        'GET',
        STREET,
        perMonth({
          '2026-06': jsonOk(stopsIn('2026-06', 1)),
          '2026-07': jsonOk(stopsIn('2026-07', 1)),
          '2026-08': jsonOk(stopsIn('2026-08', 1)),
        }),
      );
      locates();
      const result = await call({ ...POINT, month_from: '2026-06', month: '2026-08' });
      const out = data(result);
      expect(out.by_month).toEqual([
        { month: '2026-06', total: 1, force_published: true },
        { month: '2026-07', total: 1 },
        { month: '2026-08', total: 1, force_published: true },
      ]);
      expect(out).not.toHaveProperty('force_published');
      expect(text(result)).toContain(
        `${BY_MONTH_HEADER}\n|:--|--:|:--|\n| 2026-06 | 1 | yes |\n| 2026-07 | 1 | unknown |`,
      );
      expect(text(result)).not.toContain(RANGE_LINE);
    });

    it('a polygon straddling two forces: each month flagged for both, the non-publisher named with the months it skipped', async () => {
      h.upstream.route(
        'GET',
        '/crimes-street-dates',
        jsonOk(
          streetDatesBody({
            stopSearch: (month) =>
              month === '2026-06' ? ['cheshire', 'greater-manchester'] : ['cheshire'],
          }),
        ),
      );
      h.upstream.route('POST', STREET, perMonth({ '2026-06': jsonOk(stopsIn('2026-06', 2)) }));
      h.upstream.route(
        'GET',
        '/locate-neighbourhood',
        locateBy({
          [STRADDLE_SAMPLES.centre]: 'cheshire',
          [STRADDLE_SAMPLES.north]: 'greater-manchester',
          [STRADDLE_SAMPLES.south]: 'cheshire',
          [STRADDLE_SAMPLES.east]: 'greater-manchester',
        }),
      );
      const out = data(await call({ ...STRADDLE, month_from: '2026-06', month: '2026-08' }));
      expect(out.area.located_forces).toEqual(['cheshire', 'greater-manchester']);
      expect(out.by_month).toEqual([
        { month: '2026-06', total: 2, force_published: true },
        { month: '2026-07', total: 0, force_published: false },
        { month: '2026-08', total: 0, force_published: false },
      ]);
      expect(out.force_published).toBe(false);
      expect(out.notice).toBe(
        notPublished('Greater Manchester Police', 'greater-manchester', '2026-07, 2026-08'),
      );
      expect([...asked()].sort()).toEqual(['2026-06', '2026-07', '2026-08']);
      expect(h.upstream.count('/locate-neighbourhood')).toBe(4);
    });

    describe('a straddle some of whose sample lookups failed', () => {
      const PARTIAL =
        "The force at 2 of this polygon's 4 sample points could not be looked up, so the forces named here may not be all it falls in; search again to retry the lookup.";
      /** The straddle with `answered` found on its side and the other side's two samples failing (500). */
      const partialStraddle = (answered: string, side: 'north' | 'south') => {
        const north = side === 'north' ? answered : status(500);
        const south = side === 'south' ? answered : status(500);
        return locateBy({
          [STRADDLE_SAMPLES.centre]: south,
          [STRADDLE_SAMPLES.north]: north,
          [STRADDLE_SAMPLES.south]: south,
          [STRADDLE_SAMPLES.east]: north,
        });
      };

      it('withholds true from every month and from the top-level flag, says so once, and keeps the zero line', async () => {
        h.upstream.route(
          'GET',
          '/crimes-street-dates',
          jsonOk(streetDatesBody({ stopSearch: ['cheshire'] })),
        );
        h.upstream.route('POST', STREET, emptyArrayOk);
        h.upstream.route('GET', '/locate-neighbourhood', partialStraddle('cheshire', 'south'));
        const result = await call({ ...STRADDLE, month_from: '2026-06', month: '2026-08' });
        const out = data(result);
        expect(out.area.located_forces).toEqual(['cheshire']);
        expect(out.by_month).toEqual([
          { month: '2026-06', total: 0 },
          { month: '2026-07', total: 0 },
          { month: '2026-08', total: 0 },
        ]);
        expect(out).not.toHaveProperty('force_published');
        expect(out.notice).toBe([PARTIAL, ZERO_HERE('2026-06–2026-08')].join(' '));
        const markdown = text(result);
        expect(markdown).toContain('### By month\n\n| Month | Stops |\n|:--|--:|\n');
        expect(markdown).not.toContain(BY_MONTH_HEADER);
        expect(markdown).not.toContain(RANGE_LINE);
        expect(markdown).toContain(`> ${out.notice}`);
      });

      it('still says false for the months a found force skipped, and nothing for the months it published', async () => {
        h.upstream.route(
          'GET',
          '/crimes-street-dates',
          jsonOk(
            streetDatesBody({
              stopSearch: (month) => (month === '2026-06' ? ['greater-manchester'] : []),
            }),
          ),
        );
        h.upstream.route(
          'POST',
          STREET,
          perMonth({
            '2026-06': jsonOk(stopsIn('2026-06', 1)),
            '2026-07': jsonOk(stopsIn('2026-07', 1)),
            '2026-08': jsonOk(stopsIn('2026-08', 1)),
          }),
        );
        h.upstream.route(
          'GET',
          '/locate-neighbourhood',
          partialStraddle('greater-manchester', 'north'),
        );
        const result = await call({ ...STRADDLE, month_from: '2026-06', month: '2026-08' });
        const out = data(result);
        expect(out.by_month).toEqual([
          { month: '2026-06', total: 1 },
          { month: '2026-07', total: 1, force_published: false },
          { month: '2026-08', total: 1, force_published: false },
        ]);
        expect(out.force_published).toBe(false);
        expect(out.notice).toBe(
          [
            notPublished('Greater Manchester Police', 'greater-manchester', '2026-07, 2026-08'),
            PARTIAL,
          ].join(' '),
        );
        const markdown = text(result);
        expect(markdown).toContain('| 2026-06 | 1 | unknown |\n| 2026-07 | 1 | no |');
        expect(markdown).toContain(`${RANGE_LINE} no`);
      });
    });
  });

  describe('filters over a range', () => {
    const LEICESTERSHIRE = { area: 'force', force: 'leicestershire' } as const;

    it('apply in every month, both flags included: per-month totals after filters, unfiltered_total over the range', async () => {
      h.upstream.route(
        'GET',
        FORCE_ROUTE,
        perMonth({
          '2026-06': jsonOk([
            ...stopsIn('2026-06', 2),
            stopRecord({
              datetime: '2026-06-20T10:00:00+00:00',
              removal_of_more_than_outer_clothing: true,
            }),
          ]),
          '2026-07': jsonOk([
            stopRecord({
              datetime: '2026-07-03T10:00:00+00:00',
              removal_of_more_than_outer_clothing: true,
              outcome_linked_to_object_of_search: false,
            }),
          ]),
          '2026-08': jsonOk([
            stopRecord({
              datetime: '2026-08-04T10:00:00+00:00',
              removal_of_more_than_outer_clothing: true,
            }),
            ...stopsIn('2026-08', 1),
          ]),
        }),
      );
      const result = await call({
        ...LEICESTERSHIRE,
        month_from: '2026-06',
        month: '2026-08',
        filters: [
          { field: 'removal_of_more_than_outer_clothing', value: true },
          { field: 'outcome_linked_to_object_of_search', value: 'true' },
        ],
      });
      const out = data(result);
      expect(out.by_month).toEqual([
        { month: '2026-06', total: 1, force_published: true },
        { month: '2026-07', total: 0, force_published: true },
        { month: '2026-08', total: 1, force_published: true },
      ]);
      expect(out.total).toBe(2);
      expect(out.unfiltered_total).toBe(6);
      expect(out.by_removal_of_more_than_outer_clothing).toEqual([{ value: 'true', count: 2 }]);
      expect(out.by_outcome_linked_to_object_of_search).toEqual([{ value: 'true', count: 2 }]);
      expect(out.stops.map((stop) => stop.datetime)).toEqual([
        '2026-06-20T10:00:00+00:00',
        '2026-08-04T10:00:00+00:00',
      ]);
      expect(text(result)).toContain('| 2026-07 | 0 | yes |');
    });

    it('lists the values present across every month when nothing matched', async () => {
      h.upstream.route(
        'GET',
        FORCE_ROUTE,
        perMonth({
          '2026-07': jsonOk(stopsIn('2026-07', 2)),
          '2026-08': jsonOk(stopsIn('2026-08', 1, { gender: 'Female' })),
        }),
      );
      const out = data(
        await call({
          ...LEICESTERSHIRE,
          month_from: '2026-07',
          month: '2026-08',
          filters: [{ field: 'gender', value: 'Other' }],
        }),
      );
      expect(out.total).toBe(0);
      expect(out.unfiltered_total).toBe(3);
      expect(out.notice).toBe(
        'No stops matched the filters; values present for gender: "Male", "Female".',
      );
    });
  });

  describe('every area arm', () => {
    it('location: one request a month, located once from the first stop carrying a map point, each month flagged for that force', async () => {
      const spot = wireLocation(1_000_005, 'On or near Spot Street', '52.640000', '-1.140000');
      h.upstream.route(
        'GET',
        '/stops-at-location',
        perMonth({
          '2026-07': jsonOk([
            ...stopsIn('2026-07', 1, {
              location: wireLocation(1_000_005, 'On or near Spot Street', null, null),
            }),
            stopRecord({ datetime: '2026-07-09T10:00:00+00:00', location: spot }),
          ]),
          '2026-08': jsonOk(stopsIn('2026-08', 1, { location: spot })),
        }),
      );
      locates();
      const out = data(
        await call({
          area: 'location',
          location_id: '1000005',
          month_from: '2026-06',
          month: '2026-08',
        }),
      );
      expect(out.by_month).toEqual([
        { month: '2026-06', total: 0, force_published: true },
        { month: '2026-07', total: 2, force_published: true },
        { month: '2026-08', total: 1, force_published: true },
      ]);
      expect(out.force_published).toBe(true);
      expect(h.upstream.callsTo('/locate-neighbourhood').map((c) => c.query.get('q'))).toEqual([
        '52.640000,-1.140000',
      ]);
      expect(out.area).toMatchObject({ located_force: 'leicestershire' });
      expect([...asked('/stops-at-location')].sort()).toEqual(['2026-06', '2026-07', '2026-08']);
    });

    it('location: no stops in any month gives the location fragment naming the range', async () => {
      h.upstream.route('GET', '/stops-at-location', emptyArrayOk);
      const out = data(
        await call({ area: 'location', location_id: '1000005', month_from: '2026-07' }),
      );
      expect(out.by_month).toEqual([
        { month: '2026-07', total: 0 },
        { month: '2026-08', total: 0 },
      ]);
      expect(out.notice).toBe(
        "No month given; searched 2026-07–2026-08, a range ending at 2026-08, the latest published month. No stops at location 1000005 in 2026-07–2026-08; location ids come from earlier results, so check it or search area 'point'.",
      );
    });

    it('neighbourhood: one boundary read, then one POST a month, each month flagged for the named force', async () => {
      h.upstream.route('GET', '/leicestershire/NX01/boundary', jsonOk(boundaryBody()));
      h.upstream.route('POST', STREET, perMonth({ '2026-07': jsonOk(stopsIn('2026-07', 2)) }));
      const out = data(
        await call({
          area: 'neighbourhood',
          force: 'leicestershire',
          neighbourhood_id: 'NX01',
          month_from: '2026-06',
          month: '2026-08',
        }),
      );
      expect(out.total).toBe(2);
      expect(out.by_month).toEqual([
        { month: '2026-06', total: 0, force_published: true },
        { month: '2026-07', total: 2, force_published: true },
        { month: '2026-08', total: 0, force_published: true },
      ]);
      expect(h.upstream.count('/leicestershire/NX01/boundary')).toBe(1);
      expect([...asked()].sort()).toEqual(['2026-06', '2026-07', '2026-08']);
      expect(h.upstream.count('/locate-neighbourhood')).toBe(0);
    });
  });

  describe('all-or-nothing failure', () => {
    const SIX = ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08'];

    it.each<[string, JsonRpcErrorCode, Responder, string?]>([
      ['rate_limited', JsonRpcErrorCode.RateLimited, rateLimited('120')],
      ['upstream_unavailable', JsonRpcErrorCode.ServiceUnavailable, overloaded, 'probe fails'],
      ['area_too_large', JsonRpcErrorCode.ValidationError, overloaded],
    ])(
      'a month failing %s fails the call with it; no further month starts, the months in flight are cached, and a repeat fetches only the rest',
      async (reason, code, failing, probe) => {
        let first = true;
        h.upstream.route(
          'GET',
          STREET,
          perMonth(
            { '2026-03': (request) => (first ? failing(request) : emptyArrayOk(request)) },
            delayed(5000, emptyArrayOk),
          ),
        );
        if (probe) h.upstream.route('GET', '/crime-last-updated', status(500));
        locates();
        const range = { ...POINT, month_from: '2026-03', month: '2026-08' } as const;
        const error = errorOf(await call(range));
        expect(error.code).toBe(code);
        expect(error.data.reason).toBe(reason);
        if (reason === 'area_too_large') expect(error.message).toContain('for 2026-03');
        expect([...asked()].sort()).toEqual(['2026-03', '2026-04']);

        first = false;
        const out = data(await call(range));
        expect(out.by_month).toHaveLength(6);
        expect([...asked()].sort()).toEqual(['2026-03', ...SIX].sort());
      },
    );
  });

  describe('the budget and size stops', () => {
    it('stops starting months once a full attempt no longer fits, failing range_incomplete; a repeat fetches only the rest', async () => {
      h.upstream.route('GET', FORCE_ROUTE, delayed(9000, emptyArrayOk));
      const range = { ...DYFED_POWYS, month_from: '2025-09', month: '2026-08' } as const;
      const result = await call(range);
      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.Timeout);
      expect(error.data).toMatchObject({ reason: 'range_incomplete', retryable: true });
      expect(error.message).toBe(
        'This call ran short of time after fetching 6 of the 12 months of 2025-09–2026-08; 2026-03 and later did not start. The months fetched stay cached for 15 minutes, so a repeat call fetches only the rest.',
      );
      expect(error.data.recovery?.hint).toContain('shorten the range');
      expect(text(result)).toContain('(reason range_incomplete · retryable');
      expect(asked(FORCE_ROUTE)).toHaveLength(6);

      const out = data(await call(range));
      expect(out.by_month).toHaveLength(12);
      expect(asked(FORCE_ROUTE)).toHaveLength(12);
    });

    it('starts no month whose projected weight passes 32 MiB, failing range_too_large naming it, unsent', async () => {
      const heavy = (month: string) =>
        textOk(
          JSON.stringify([
            stopRecord({ datetime: `${month}-02T10:00:00+00:00`, padding: 'x'.repeat(11 * MIB) }),
          ]),
        );
      h.upstream.route(
        'GET',
        FORCE_ROUTE,
        perMonth({
          '2026-03': delayed(1000, heavy('2026-03')),
          '2026-04': delayed(2000, heavy('2026-04')),
          '2026-05': delayed(3000, heavy('2026-05')),
        }),
      );
      const result = await call({ ...DYFED_POWYS, month_from: '2026-03', month: '2026-08' });
      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data.reason).toBe('range_too_large');
      // 2026-03 lands at 13.75 MiB with 2026-04 in flight: 2026-05 would make about 41 MiB.
      expect(error.message).toBe(
        'The 6 months of 2026-03–2026-08 hold more records than one call keeps for a range; it would pass that limit at 2026-05.',
      );
      expect(error.data.recovery?.hint).toContain('Shorten the range');
      expect(text(result)).toContain('(reason range_too_large');
      expect([...asked(FORCE_ROUTE)].sort()).toEqual(['2026-03', '2026-04']);
    });

    describe('Metropolitan-sized months', () => {
      /** One stop padded to the 8.3 MB of a Metropolitan Police force month. */
      const metropolitanSized = (month: string) =>
        JSON.stringify([
          stopRecord({ datetime: `${month}-02T10:00:00+00:00`, padding: 'x'.repeat(8_300_000) }),
        ]);
      const months = monthsBetween('2025-09', '2026-08').reverse();
      /** Months of that size the bound admits: 3. */
      const admitted = Math.floor(
        RANGE_MAX_WEIGHT / (Buffer.byteLength(metropolitanSized('2025-09')) * 1.25),
      );
      const routeMonths = () =>
        h.upstream.route(
          'GET',
          FORCE_ROUTE,
          perMonth(
            Object.fromEntries(
              months.map((month) => [
                month,
                delayed(1000, (request) => textOk(metropolitanSized(month))(request)),
              ]),
            ),
          ),
        );
      const LEICESTERSHIRE = { area: 'force', force: 'leicestershire' } as const;

      it('admits as many as the bound keeps: a range of three succeeds, every month sent once', async () => {
        expect(admitted).toBe(3);
        routeMonths();
        const result = await call({ ...LEICESTERSHIRE, month_from: '2025-09', month: '2025-11' });
        const out = data(result);
        expect(out.by_month).toEqual(
          months.slice(0, 3).map((month) => ({ month, total: 1, force_published: true })),
        );
        expect(out.total).toBe(3);
        expect([...asked(FORCE_ROUTE)].sort()).toEqual(months.slice(0, 3));
        expect(text(result)).toContain('| 2025-11 | 1 | yes |');
      });

      it('starts no month the bound cannot keep: 12 send no more requests than the bound admits, failing range_too_large', async () => {
        routeMonths();
        const result = await call({ ...LEICESTERSHIRE, month_from: '2025-09', month: '2026-08' });
        const error = errorOf(result);
        expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
        expect(error.data.reason).toBe('range_too_large');
        expect(error.message).toBe(
          'The 12 months of 2025-09–2026-08 hold more records than one call keeps for a range; it would pass that limit at 2025-12.',
        );
        expect(text(result)).toContain('(reason range_too_large');
        expect(asked(FORCE_ROUTE).length).toBeLessThanOrEqual(admitted);
        expect([...asked(FORCE_ROUTE)].sort()).toEqual(months.slice(0, admitted));
      });
    });
  });
});
