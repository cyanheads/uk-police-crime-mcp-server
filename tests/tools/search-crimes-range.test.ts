/**
 * @fileoverview ukcrime_search_crimes over a month range (`month_from`) through
 * `runToolContract`: the month checks and their order, totals, breakdowns and
 * rows over the range with per-month totals on both surfaces, paging across
 * month boundaries from the cache, every area arm, all-or-nothing failure with
 * in-flight months cached, the budget and size stops, the two-month bound on
 * months in flight and the area slot it leaves other calls, and cancellation.
 * @module tests/tools/search-crimes-range.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { samplePoints } from '@/mcp-server/tools/area-search.js';
import { searchCrimesTool } from '@/mcp-server/tools/definitions/search-crimes.tool.js';
import { coverageNotes } from '@/services/police-api/known-gaps.js';
import {
  boundaryBody,
  crimeRecord,
  emptyArrayOk,
  hang,
  jsonOk,
  locateBody,
  locateBy,
  overloaded,
  perMonth,
  plainNotFound,
  type Responder,
  rateLimited,
  STRADDLE_RING,
  STRADDLE_SAMPLES,
  status,
  textOk,
  wireLocation,
} from '../fixtures/police-api-upstream.js';
import { delayed, trackInFlight } from '../fixtures/police-api-upstream-w3.js';
import { settle, useToolHarness } from '../fixtures/service-harness.js';

type Input = z.input<typeof searchCrimesTool.input>;
type Output = z.output<typeof searchCrimesTool.output> & { notice?: string };
type Result = Awaited<ReturnType<typeof runToolContract>>;

const call = (input: Input, signal?: AbortSignal) =>
  settle(runToolContract(searchCrimesTool, input, signal ? { context: { signal } } : undefined));

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
const STREET = '/crimes-street/all-crime';
const MIB = 1024 * 1024;

/** `n` burglaries recorded in `month` at one map point, ids ascending within the month. */
const crimesIn = (month: string, n: number, location = wireLocation()) =>
  Array.from({ length: n }, (_, i) =>
    crimeRecord({
      month,
      id: Number(month.replace('-', '')) * 1000 + i,
      persistent_id: `${month.replace('-', '')}${i}`.padStart(64, '0'),
      location,
    }),
  );

describe('ukcrime_search_crimes over a month range', () => {
  const h = useToolHarness();

  /** The months requested from `path`, in the order sent. */
  const asked = (path = STREET) =>
    h.upstream
      .callsTo(path)
      .map((c) => c.query.get('date') ?? new URLSearchParams(c.body).get('date'));

  const locates = () => h.upstream.route('GET', '/locate-neighbourhood', jsonOk(locateBody()));

  describe('month checks, before any area request', () => {
    it('refuses a month_from before the window as month_out_of_range naming month_from, never clipping it', async () => {
      const error = errorOf(await call({ ...POINT, month_from: '2023-08', month: '2024-03' }));
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data.reason).toBe('month_out_of_range');
      expect(error.message).toBe(
        'month_from 2023-08 is before 2023-09, the earliest month data.police.uk still serves.',
      );
      expect(h.upstream.count(STREET)).toBe(0);
      expect(h.upstream.count('/locate-neighbourhood')).toBe(0);
    });

    it('refuses a month_from after the latest month as month_not_published naming month_from, after one re-check', async () => {
      const error = errorOf(await call({ ...POINT, month_from: '2026-09' }));
      expect(error.data.reason).toBe('month_not_published');
      expect(error.message).toBe(
        'month_from 2026-09 is not published yet; the latest published month is 2026-08.',
      );
      expect(error.data.recovery?.hint).toBe(
        "Call ukcrime_list_reference with topic 'availability' for the published months, or omit month to search the latest one; month_from must be a published month no later than month.",
      );
      expect(h.upstream.count('/crime-last-updated')).toBe(1);
      expect(h.upstream.count(STREET)).toBe(0);
    });

    it('refuses a month_from after month as invalid_month_range, with the declared recovery', async () => {
      const result = await call({ ...POINT, month_from: '2026-05', month: '2026-03' });
      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data.reason).toBe('invalid_month_range');
      expect(error.message).toBe(
        'month_from 2026-05 is after month 2026-03; month_from is the first month of the range.',
      );
      expect(error.data.recovery?.hint).toBe(
        'Send a month_from no later than month, making a range of at most 12 months counting both ends; with month omitted, the range ends at the latest published month.',
      );
      expect(text(result)).toContain('Recovery:');
      expect(h.upstream.count(STREET)).toBe(0);
    });

    it('refuses 13 months as invalid_month_range, naming the earliest month_from that fits', async () => {
      const error = errorOf(await call({ ...POINT, month_from: '2025-07', month: '2026-07' }));
      expect(error.data.reason).toBe('invalid_month_range');
      expect(error.message).toBe(
        '2025-07–2026-07 covers 13 months; a range covers at most 12, so for month 2026-07 month_from can be 2025-08 at the earliest.',
      );
      expect(h.upstream.count(STREET)).toBe(0);
    });

    it('measures the span from the latest month when month is omitted', async () => {
      const error = errorOf(await call({ ...POINT, month_from: '2025-08' }));
      expect(error.message).toBe(
        '2025-08–2026-08 covers 13 months; a range covers at most 12, so for month 2026-08 month_from can be 2025-09 at the earliest.',
      );
    });

    it('checks month first, then month_from, then the category', async () => {
      expect(
        errorOf(await call({ ...POINT, month: '2026-09', month_from: '2023-01' })).message,
      ).toBe('2026-09 is not published yet; the latest published month is 2026-08.');
      expect(
        errorOf(await call({ ...POINT, month_from: '2023-01', category: 'nonsense' })).data.reason,
      ).toBe('month_out_of_range');
      expect(
        errorOf(
          await call({ ...POINT, month_from: '2026-08', month: '2026-01', category: 'nonsense' }),
        ).data.reason,
      ).toBe('invalid_month_range');
    });

    it('rejects a malformed month_from at the schema, and reads a blank one as unset (one month, no by_month)', async () => {
      const bad = await call({ ...POINT, month_from: '2026-13' });
      expect(errorOf(bad).code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(h.upstream.count(STREET)).toBe(0);

      h.upstream.route('GET', STREET, emptyArrayOk);
      locates();
      const out = data(await call({ ...POINT, month: '2026-07', month_from: '  ' }));
      expect(out.month_from).toBeUndefined();
      expect(out.by_month).toBeUndefined();
      expect(asked()).toEqual(['2026-07']);
    });

    it('declares the three range reasons with their codes', () => {
      const declared = Object.fromEntries(
        (searchCrimesTool.errors ?? []).map((entry) => [entry.reason, entry]),
      );
      expect(declared.invalid_month_range).toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
      });
      expect(declared.range_too_large).toMatchObject({ code: JsonRpcErrorCode.ValidationError });
      expect(declared.range_incomplete).toMatchObject({
        code: JsonRpcErrorCode.Timeout,
        retryable: true,
      });
    });
  });

  describe('a range at a point', () => {
    /** 2025-09..2026-08, with nothing recorded in 2025-10. */
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
        Object.entries(COUNTS).map(([month, n]) => [month, jsonOk(crimesIn(month, n))]),
      );

    it('12 months: one request a month (at most two in flight) and one locate; totals, breakdowns and rows over the range, oldest month first', async () => {
      const tracked = trackInFlight(1000, perMonth(yearOf()));
      h.upstream.route('GET', STREET, tracked.respond);
      locates();
      const result = await call({ ...POINT, month_from: '2025-09', month: '2026-08', limit: 200 });
      const out = data(result);
      expect(out.month_from).toBe('2025-09');
      expect(out.month).toBe('2026-08');
      expect(out.by_month).toEqual(
        Object.entries(COUNTS).map(([month, total]) => ({ month, total })),
      );
      expect(out.total).toBe(16);
      expect(out.by_month?.reduce((sum, row) => sum + row.total, 0)).toBe(out.total);
      expect(out.by_category).toEqual([{ value: 'burglary', count: 16 }]);
      expect(out.top_locations).toEqual([
        expect.objectContaining({ location_id: '1000001', count: 16 }),
      ]);
      expect(out.crimes.map((crime) => crime.month)).toEqual(
        Object.entries(COUNTS).flatMap(([month, n]) => Array<string>(n).fill(month)),
      );
      expect(out.crimes.slice(0, 3).map((crime) => crime.id)).toEqual([
        '202509000',
        '202509001',
        '202511000',
      ]);
      expect(out.area).toMatchObject({ located_force: 'leicestershire' });
      expect([...asked()].sort()).toEqual(Object.keys(COUNTS));
      expect(h.upstream.count('/locate-neighbourhood')).toBe(1);
      expect(tracked.peak()).toBe(2);

      const markdown = text(result);
      expect(markdown).toContain('## Street-level crimes — 2025-09–2026-08\n');
      expect(markdown).toContain(
        '### By month\n\n| Month | Crimes |\n|:--|--:|\n| 2025-09 | 2 |\n',
      );
      expect(markdown).toContain('| 2025-10 | 0 |');
      expect(markdown).toContain('| 2026-08 | 2 |');
    });

    it('defaults month to the latest month and says the range ends there', async () => {
      h.upstream.route('GET', STREET, perMonth(yearOf()));
      locates();
      const out = data(await call({ ...POINT, month_from: '2026-06' }));
      expect(out.month).toBe('2026-08');
      expect(out.by_month?.map((row) => row.month)).toEqual(['2026-06', '2026-07', '2026-08']);
      expect(out.notice).toContain(
        'No month given; searched 2026-06–2026-08, a range ending at 2026-08, the latest published month.',
      );
    });

    it('treats month_from equal to month as a one-month range: one row, both months echoed', async () => {
      h.upstream.route('GET', STREET, perMonth(yearOf()));
      locates();
      const result = await call({ ...POINT, month_from: '2026-07', month: '2026-07' });
      const out = data(result);
      expect(out.month_from).toBe('2026-07');
      expect(out.by_month).toEqual([{ month: '2026-07', total: 1 }]);
      expect(text(result)).toContain('## Street-level crimes — 2026-07\n');
      expect(asked()).toEqual(['2026-07']);
    });

    it('names the range in the zero-hit fragment', async () => {
      h.upstream.route('GET', STREET, emptyArrayOk);
      locates();
      const out = data(await call({ ...POINT, month_from: '2026-06', month: '2026-07' }));
      expect(out.total).toBe(0);
      expect(out.by_month).toEqual([
        { month: '2026-06', total: 0 },
        { month: '2026-07', total: 0 },
      ]);
      expect(out.notice).toContain('Nothing recorded here in 2026-06–2026-07.');
    });

    it('names the months at zero in a range with hits as possibly missing data, on both surfaces', async () => {
      h.upstream.route(
        'GET',
        STREET,
        perMonth({
          '2026-05': jsonOk(crimesIn('2026-05', 2)),
          '2026-08': jsonOk(crimesIn('2026-08', 1)),
        }),
      );
      locates();
      const result = await call({ ...POINT, month_from: '2026-05', month: '2026-08' });
      const out = data(result);
      expect(out.by_month).toEqual([
        { month: '2026-05', total: 2 },
        { month: '2026-06', total: 0 },
        { month: '2026-07', total: 0 },
        { month: '2026-08', total: 1 },
      ]);
      expect(out.notice).toBe(
        'Nothing recorded here in 2026-06, 2026-07. A force can miss a month the API still lists as published (https://data.police.uk/changelog/), so a month at zero may be missing data rather than no crime.',
      );
      expect(text(result)).toContain(`> ${out.notice}`);
    });

    it('adds no zero-month line when a category narrows the range, where a month at zero is common', async () => {
      h.upstream.route(
        'GET',
        '/crimes-street/burglary',
        perMonth({ '2026-07': jsonOk(crimesIn('2026-07', 1)) }),
      );
      locates();
      const out = data(
        await call({ ...POINT, month_from: '2026-06', month: '2026-08', category: 'burglary' }),
      );
      expect(out.total).toBe(1);
      expect(out.by_month?.map((row) => row.total)).toEqual([0, 1, 0]);
      expect(out.notice).toBeUndefined();
    });

    it('words the zero-month line for unplaced crimes on area force_unplaced', async () => {
      h.upstream.route(
        'GET',
        '/crimes-no-location',
        perMonth({ '2026-08': jsonOk(crimesIn('2026-08', 1, null as never)) }),
      );
      const result = await call({
        area: 'force_unplaced',
        force: 'leicestershire',
        month_from: '2026-07',
        month: '2026-08',
      });
      const out = data(result);
      expect(out.notice).toBe(
        'This force recorded no crimes without a location in 2026-07. A force can miss a month the API still lists as published (https://data.police.uk/changelog/), so a month at zero may be missing data rather than no crime.',
      );
      expect(text(result)).toContain(`> ${out.notice}`);
    });

    it('pages across a month boundary from the cache, and says when the offset is past the end', async () => {
      h.upstream.route(
        'GET',
        STREET,
        perMonth({
          '2026-07': jsonOk(crimesIn('2026-07', 3)),
          '2026-08': jsonOk(crimesIn('2026-08', 3)),
        }),
      );
      locates();
      const range = { ...POINT, month_from: '2026-07', month: '2026-08', limit: 4 } as const;
      const first = data(await call(range));
      expect(first.crimes.map((crime) => crime.id)).toEqual([
        '202607000',
        '202607001',
        '202607002',
        '202608000',
      ]);
      expect(first.next_offset).toBe(4);
      expect(first.notice).toContain('Showing 1–4 of 6; call again with offset 4 for more.');

      const second = data(await call({ ...range, offset: 4 }));
      expect(second.crimes.map((crime) => crime.id)).toEqual(['202608001', '202608002']);
      expect(second.next_offset).toBeUndefined();
      expect(second.by_month).toEqual(first.by_month);

      const past = data(await call({ ...range, offset: 10 }));
      expect(past.crimes).toEqual([]);
      expect(past.notice).toContain(
        'offset 10 is past the last of 6 crimes; omit offset to start from the first.',
      );

      expect(asked()).toHaveLength(2);
      expect(h.upstream.count('/locate-neighbourhood')).toBe(1);
    });

    it('orders months and rows oldest first when a later month lands first', async () => {
      // 2026-07 lands at 1 s and 2026-08, sent then, at 2 s; 2026-06 lands last, at 5 s.
      h.upstream.route(
        'GET',
        STREET,
        perMonth({
          '2026-06': delayed(5000, jsonOk(crimesIn('2026-06', 1))),
          '2026-07': delayed(1000, jsonOk(crimesIn('2026-07', 1))),
          '2026-08': delayed(1000, jsonOk(crimesIn('2026-08', 1))),
        }),
      );
      locates();
      const start = Date.now();
      const result = await call({ ...POINT, month_from: '2026-06', month: '2026-08' });
      const out = data(result);
      expect(h.upstream.callsTo(STREET).map((sent) => sent.at - start)).toEqual([0, 0, 1000]);
      expect(out.by_month).toEqual([
        { month: '2026-06', total: 1 },
        { month: '2026-07', total: 1 },
        { month: '2026-08', total: 1 },
      ]);
      expect(out.crimes.map((crime) => crime.month)).toEqual(['2026-06', '2026-07', '2026-08']);
      expect(text(result)).toContain('| 2026-06 | 1 |\n| 2026-07 | 1 |\n| 2026-08 | 1 |');
    });
  });

  describe('every area arm', () => {
    const RING = [
      { lat: 52.63, lng: -1.14 },
      { lat: 52.63, lng: -1.12 },
      { lat: 52.64, lng: -1.12 },
      { lat: 52.64, lng: -1.14 },
    ];

    it('polygon: one POST a month with its date, the sample points located once for the range', async () => {
      h.upstream.route('POST', STREET, perMonth({ '2026-08': jsonOk(crimesIn('2026-08', 2)) }));
      locates();
      const out = data(
        await call({ area: 'polygon', polygon: RING, month_from: '2026-06', month: '2026-08' }),
      );
      expect(out.by_month).toEqual([
        { month: '2026-06', total: 0 },
        { month: '2026-07', total: 0 },
        { month: '2026-08', total: 2 },
      ]);
      expect([...asked()].sort()).toEqual(['2026-06', '2026-07', '2026-08']);
      expect(h.upstream.count('/locate-neighbourhood')).toBe(
        samplePoints(RING.map(({ lat, lng }) => ({ latitude: lat, longitude: lng }))).length,
      );
      expect(out.area).toMatchObject({ located_forces: ['leicestershire'] });
    });

    it('polygon: two months and two sample lookups go out at once, together filling the pacer without waiting on it', async () => {
      h.upstream.route('POST', STREET, delayed(3000, emptyArrayOk));
      h.upstream.route('GET', '/locate-neighbourhood', delayed(1000, jsonOk(locateBody())));
      const start = Date.now();
      data(await call({ area: 'polygon', polygon: RING, month_from: '2026-03', month: '2026-08' }));
      const sentAt = (path: string) => h.upstream.callsTo(path).map((sent) => sent.at - start);
      expect(sentAt(STREET)).toEqual([0, 0, 3000, 3000, 6000, 6000]);
      expect(sentAt('/locate-neighbourhood').slice(0, 2)).toEqual([0, 0]);
    });

    it('polygon: a partial located set gets the partial fragment once and keeps the generic zero line for the range', async () => {
      // Greater Manchester (no crime data) answers on two samples; the other two fail.
      h.upstream.route('POST', STREET, emptyArrayOk);
      h.upstream.route(
        'GET',
        '/locate-neighbourhood',
        locateBy({
          [STRADDLE_SAMPLES.centre]: status(500),
          [STRADDLE_SAMPLES.north]: 'greater-manchester',
          [STRADDLE_SAMPLES.south]: status(500),
          [STRADDLE_SAMPLES.east]: 'greater-manchester',
        }),
      );
      const result = await call({
        area: 'polygon',
        polygon: [...STRADDLE_RING],
        month_from: '2026-06',
        month: '2026-08',
      });
      const out = data(result);
      expect(out.total).toBe(0);
      expect(out.area.located_forces).toEqual(['greater-manchester']);
      expect(out.notice).toBe(
        [
          ...coverageNotes('greater-manchester', ['crime', 'locations', 'asb']),
          "The force at 2 of this polygon's 4 sample points could not be looked up, so the forces named here may not be all it falls in; search again to retry the lookup.",
          "Nothing recorded here in 2026-06–2026-08. A force can miss a month the API still lists as published (https://data.police.uk/changelog/); try another month, a wider area, or area 'force_unplaced' for crimes the force could not place.",
        ].join(' '),
      );
      expect(text(result)).toContain(`> ${out.notice}`);
      const sent = h.upstream.callsTo('/locate-neighbourhood').map((c) => c.query.get('q'));
      expect(new Set(sent).size).toBe(4);
      expect(sent.filter((q) => q === STRADDLE_SAMPLES.north)).toHaveLength(1);
    });

    it('polygon: answers when every sample lookup hangs, the lookups giving up at 10 s', async () => {
      h.upstream.route('POST', STREET, emptyArrayOk);
      h.upstream.route('GET', '/locate-neighbourhood', hang);
      const start = Date.now();
      const out = data(
        await call({ area: 'polygon', polygon: RING, month_from: '2026-06', month: '2026-08' }),
      );
      expect(out.by_month).toHaveLength(3);
      expect(out.area).not.toHaveProperty('located_forces');
      expect(Date.now() - start).toBeLessThanOrEqual(10_500);
    });

    it('location: an empty first month, located once from the first record with a map point', async () => {
      const spot = wireLocation(1_000_005, 'On or near Spot Street', '52.640000', '-1.140000');
      h.upstream.route(
        'GET',
        '/crimes-at-location',
        perMonth({
          '2026-07': jsonOk([
            ...crimesIn(
              '2026-07',
              1,
              wireLocation(1_000_005, 'On or near Spot Street', null, null),
            ),
            ...crimesIn('2026-07', 1, spot).map((c) => ({ ...c, id: 999, category: 'drugs' })),
          ]),
          '2026-08': jsonOk(crimesIn('2026-08', 1, spot)),
        }),
      );
      locates();
      const out = data(
        await call({
          area: 'location',
          location_id: '1000005',
          month_from: '2026-06',
          month: '2026-08',
          category: 'burglary',
        }),
      );
      expect(out.by_month).toEqual([
        { month: '2026-06', total: 0 },
        { month: '2026-07', total: 1 },
        { month: '2026-08', total: 1 },
      ]);
      expect(out.total).toBe(2);
      expect(h.upstream.callsTo('/locate-neighbourhood').map((c) => c.query.get('q'))).toEqual([
        '52.640000,-1.140000',
      ]);
      expect(out.area).toMatchObject({ located_force: 'leicestershire' });
    });

    it('location: a 404 in any month is unknown_location; the months in flight land and no further month starts', async () => {
      h.upstream.route(
        'GET',
        '/crimes-at-location',
        perMonth({ '2026-06': plainNotFound }, delayed(2000, emptyArrayOk)),
      );
      locates();
      const error = errorOf(
        await call({ area: 'location', location_id: '9', month_from: '2026-05', month: '2026-08' }),
      );
      expect(error.data.reason).toBe('unknown_location');
      expect([...asked('/crimes-at-location')].sort()).toEqual(['2026-05', '2026-06']);
    });

    it('neighbourhood: one boundary read, then one POST a month', async () => {
      h.upstream.route('GET', '/leicestershire/NX01/boundary', jsonOk(boundaryBody()));
      h.upstream.route('POST', STREET, perMonth({ '2026-07': jsonOk(crimesIn('2026-07', 2)) }));
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
      expect(h.upstream.count('/leicestershire/NX01/boundary')).toBe(1);
      expect([...asked()].sort()).toEqual(['2026-06', '2026-07', '2026-08']);
      expect(h.upstream.count('/locate-neighbourhood')).toBe(0);
    });

    it('force_unplaced: one crimes-no-location request a month, no busiest points', async () => {
      h.upstream.route(
        'GET',
        '/crimes-no-location',
        perMonth({ '2026-08': jsonOk(crimesIn('2026-08', 1, null as never)) }),
      );
      const out = data(
        await call({ area: 'force_unplaced', force: 'leicestershire', month_from: '2026-07' }),
      );
      expect(out.by_month).toEqual([
        { month: '2026-07', total: 0 },
        { month: '2026-08', total: 1 },
      ]);
      expect(out.top_locations).toBeUndefined();
      expect([...asked('/crimes-no-location')].sort()).toEqual(['2026-07', '2026-08']);
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

    it('a month that never answers fails at the retry deadline as retry_deadline_exceeded; a repeat fetches only that month', async () => {
      let first = true;
      h.upstream.route(
        'GET',
        STREET,
        perMonth({ '2026-03': (request) => (first ? hang(request) : emptyArrayOk(request)) }),
      );
      locates();
      const range = { ...POINT, month_from: '2026-03', month: '2026-08' } as const;
      const error = errorOf(await call(range));
      expect(error.code).toBe(JsonRpcErrorCode.Timeout);
      expect(error.data.reason).toBe('retry_deadline_exceeded');
      const firstCall = asked().length;
      expect(new Set(asked())).toEqual(new Set(SIX));

      first = false;
      data(await call(range));
      expect(asked().slice(firstCall)).toEqual(['2026-03']);
    });

    it('reports a month that fails after the budget stop fired with its own reason, not range_incomplete', async () => {
      // 2025-11 lands at 30 s and stops the range (20 s left); 2025-12 fails at 31 s.
      h.upstream.route(
        'GET',
        STREET,
        perMonth({ '2025-12': delayed(16_000, rateLimited('120')) }, delayed(15_000, emptyArrayOk)),
      );
      locates();
      const error = errorOf(await call({ ...POINT, month_from: '2025-09', month: '2026-08' }));
      expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
      expect(error.data.reason).toBe('rate_limited');
      expect([...asked()].sort()).toEqual(['2025-09', '2025-10', '2025-11', '2025-12']);
    });

    it('a cancellation mid-range ends as RequestCancelled with no further month started', async () => {
      h.upstream.route('GET', STREET, delayed(10_000, emptyArrayOk));
      locates();
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 5000);
      const result = await call(
        { ...POINT, month_from: '2026-03', month: '2026-08' },
        controller.signal,
      );
      expect(errorOf(result).code).toBe(JsonRpcErrorCode.RequestCancelled);
      expect(asked()).toHaveLength(2);
    });
  });

  describe('the budget and size stops', () => {
    it('stops starting months once a full attempt no longer fits, failing range_incomplete; a repeat fetches only the rest', async () => {
      h.upstream.route('GET', STREET, delayed(9000, emptyArrayOk));
      locates();
      const range = { ...POINT, month_from: '2025-09', month: '2026-08' } as const;
      const result = await call(range);
      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.Timeout);
      expect(error.data).toMatchObject({ reason: 'range_incomplete', retryable: true });
      expect(error.message).toBe(
        'This call ran short of time after fetching 6 of the 12 months of 2025-09–2026-08; 2026-03 and later did not start. The months fetched stay cached for 15 minutes, so a repeat call fetches only the rest.',
      );
      expect(error.data.recovery?.hint).toContain('shorten the range');
      expect(text(result)).toContain('(reason range_incomplete · retryable');
      expect([...asked()].sort()).toEqual([
        '2025-09',
        '2025-10',
        '2025-11',
        '2025-12',
        '2026-01',
        '2026-02',
      ]);

      const out = data(await call(range));
      expect(out.by_month).toHaveLength(12);
      expect(asked()).toHaveLength(12);
    });

    it('checks the time left before a cached month too: a range whose remaining months are cached still stops once a full attempt no longer fits', async () => {
      h.upstream.route(
        'GET',
        STREET,
        perMonth({
          '2026-03': delayed(25_000, emptyArrayOk),
          '2026-04': delayed(25_000, emptyArrayOk),
        }),
      );
      locates();
      for (const month of ['2026-05', '2026-06', '2026-07', '2026-08']) {
        data(await call({ ...POINT, month }));
      }
      const error = errorOf(await call({ ...POINT, month_from: '2026-03', month: '2026-08' }));
      expect(error.data.reason).toBe('range_incomplete');
      expect(error.message).toBe(
        'This call ran short of time after fetching 2 of the 6 months of 2026-03–2026-08; 2026-05 and later did not start. The months fetched stay cached for 15 minutes, so a repeat call fetches only the rest.',
      );
      expect(asked().slice(0, 4)).toEqual(['2026-05', '2026-06', '2026-07', '2026-08']);
      expect([...asked().slice(4)].sort()).toEqual(['2026-03', '2026-04']);
    });

    it('sends no month that waited behind another range until less than one full attempt was left: both fail range_incomplete, never a timeout', async () => {
      h.upstream.route('GET', STREET, delayed(17_000, emptyArrayOk));
      locates();
      const start = Date.now();
      const results = await settle(
        Promise.all(
          [52.61, 52.62].map((lat) =>
            runToolContract(searchCrimesTool, {
              area: 'point',
              lat,
              lng: -1.13,
              month_from: '2025-09',
              month: '2026-08',
            }),
          ),
        ),
      );
      for (const result of results) {
        const error = errorOf(result);
        expect(error.code).toBe(JsonRpcErrorCode.Timeout);
        expect(error.data).toMatchObject({ reason: 'range_incomplete', retryable: true });
        expect(text(result)).toContain('(reason range_incomplete · retryable');
      }
      const short = (fetched: number, first: string) =>
        `This call ran short of time after fetching ${fetched} of the 12 months of 2025-09–2026-08; ${first} and later did not start. The months fetched stay cached for 15 minutes, so a repeat call fetches only the rest.`;
      // The second range's 2025-11 reached an area slot at 34 s, with 16 s left: never sent.
      expect(results.map((result) => errorOf(result).message)).toEqual([
        short(4, '2026-01'),
        short(2, '2025-11'),
      ]);
      // Each month went out with at least 30 s of its call's 50 s budget left.
      expect(
        h.upstream
          .callsTo(STREET)
          .map((sent) => `${sent.query.get('lat')} ${sent.query.get('date')} ${sent.at - start}`),
      ).toEqual([
        '52.610000 2025-09 0',
        '52.610000 2025-10 0',
        '52.620000 2025-09 0',
        '52.620000 2025-10 17000',
        '52.610000 2025-11 17000',
        '52.610000 2025-12 17000',
      ]);
    });

    it('fails range_too_large naming the month whose landing took the total past 32 MiB of weight, when months outweigh the projection', async () => {
      const heavy = (month: string) =>
        textOk(JSON.stringify([crimeRecord({ month, padding: 'x'.repeat(20 * MIB) })]));
      h.upstream.route(
        'GET',
        STREET,
        perMonth({
          // A light first month projects 2026-05 as light, so it starts; 2026-04 and 2026-05 then land heavy.
          '2026-03': delayed(1000, jsonOk(crimesIn('2026-03', 1))),
          '2026-04': delayed(2000, heavy('2026-04')),
          '2026-05': delayed(3000, heavy('2026-05')),
        }),
      );
      locates();
      const result = await call({ ...POINT, month_from: '2026-03', month: '2026-05' });
      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data.reason).toBe('range_too_large');
      expect(error.message).toBe(
        'The 3 months of 2026-03–2026-05 hold more records than one call keeps for a range; it would pass that limit at 2026-05.',
      );
      expect(error.data.recovery?.hint).toContain('Shorten the range');
      expect(text(result)).toContain('(reason range_too_large');
      expect([...asked()].sort()).toEqual(['2026-03', '2026-04', '2026-05']);
    });

    it('fails a one-month range whose month outweighs what a range keeps as range_too_large, while the same search without month_from answers it', async () => {
      h.upstream.route(
        'GET',
        STREET,
        textOk(JSON.stringify([crimeRecord({ month: '2026-07', padding: 'x'.repeat(26 * MIB) })])),
      );
      locates();
      const result = await call({ ...POINT, month_from: '2026-07', month: '2026-07' });
      const error = errorOf(result);
      expect(error.data.reason).toBe('range_too_large');
      expect(error.message).toBe(
        '2026-07 holds more records than one call keeps for a range; search it without month_from.',
      );
      expect(text(result)).toContain(error.message);

      const out = data(await call({ ...POINT, month: '2026-07' }));
      expect(out.total).toBe(1);
      expect(out.by_month).toBeUndefined();
      expect(asked()).toEqual(['2026-07', '2026-07']);
    });

    it('fails range_incomplete without sending a month when the time left before the first month is short of one full attempt', async () => {
      const slowBoundary = (id: string) =>
        h.upstream.route(
          'GET',
          `/leicestershire/${id}/boundary`,
          delayed(21_000, jsonOk(boundaryBody())),
        );
      slowBoundary('NX01');
      slowBoundary('NX02');
      const hood = (id: string) =>
        ({ area: 'neighbourhood', force: 'leicestershire', neighbourhood_id: id }) as const;

      const one = await call({ ...hood('NX01'), month_from: '2026-07', month: '2026-07' });
      expect(errorOf(one).data).toMatchObject({ reason: 'range_incomplete', retryable: true });
      expect(errorOf(one).message).toBe(
        'This call ran short of time before it could fetch 2026-07.',
      );
      expect(text(one)).toContain(errorOf(one).message);

      const three = await call({ ...hood('NX02'), month_from: '2026-06', month: '2026-08' });
      expect(errorOf(three).data.reason).toBe('range_incomplete');
      expect(errorOf(three).message).toBe(
        'This call ran short of time before it could fetch any of the 3 months of 2026-06–2026-08.',
      );
      expect(h.upstream.count(STREET)).toBe(0);

      // The boundary is cached now, so a repeat has the whole budget for its month.
      h.upstream.route('POST', STREET, emptyArrayOk);
      expect(
        data(await call({ ...hood('NX01'), month_from: '2026-07', month: '2026-07' })).by_month,
      ).toEqual([{ month: '2026-07', total: 0 }]);
    });
  });

  describe('months in flight beside other calls', () => {
    it('leaves an area slot free: a single-month call issued while a 12-month range runs is sent at once, not queued behind the range', async () => {
      h.upstream.route('GET', STREET, delayed(3000, emptyArrayOk));
      locates();
      const start = Date.now();
      const [range, single] = await settle(
        Promise.all([
          runToolContract(searchCrimesTool, {
            area: 'point',
            lat: 52.61,
            lng: -1.13,
            month_from: '2025-09',
            month: '2026-08',
          }),
          new Promise<void>((resolve) => setTimeout(resolve, 1000)).then(() =>
            runToolContract(searchCrimesTool, {
              area: 'point',
              lat: 52.7,
              lng: -1.13,
              month: '2026-08',
            }),
          ),
        ]),
      );
      expect(data(range).by_month).toHaveLength(12);
      expect(data(single).month).toBe('2026-08');
      const sentAt = (lat: string) =>
        h.upstream
          .callsTo(STREET)
          .filter((sent) => sent.query.get('lat') === lat)
          .map((sent) => sent.at - start);
      expect(sentAt('52.700000')).toEqual([1000]);
      const rangeSent = sentAt('52.610000');
      expect(rangeSent).toHaveLength(12);
      expect(Math.max(...rangeSent)).toBeGreaterThan(1000);
    });
  });
});
