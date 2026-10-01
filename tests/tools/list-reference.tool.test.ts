/**
 * @fileoverview ukcrime_list_reference through `runToolContract` (the
 * production parse of output extended with enrichment): every topic on a
 * zero-result page and an under-cap page, filter and input validation, every
 * declared error contract, upstream failure classes, blank form values, and
 * `format()` carrying the same data as `structuredContent` with upstream text
 * kept inert.
 * @module tests/tools/list-reference.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { listReferenceTool } from '@/mcp-server/tools/definitions/list-reference.tool.js';
import { ATTRIBUTION } from '@/mcp-server/tools/shared-schemas.js';
import { forceGaps, KNOWN_GAPS, KNOWN_GAPS_VERIFIED } from '@/services/police-api/known-gaps.js';
import {
  categoriesBody,
  forcesBody,
  hang,
  htmlOk,
  jsonOk,
  neighbourhoodsBody,
  plainNotFound,
  rateLimited,
  status,
  streetDatesBody,
} from '../fixtures/police-api-upstream.js';
import { settle, useToolHarness } from '../fixtures/service-harness.js';

type Input = z.input<typeof listReferenceTool.input>;
type Output = z.output<typeof listReferenceTool.output> & { attribution: string; notice?: string };
type Result = Awaited<ReturnType<typeof runToolContract>>;

const call = (input: Input) => settle(runToolContract(listReferenceTool, input));
const callRaw = (input: unknown) => settle(runToolContract(listReferenceTool, input as Input));

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

const GAP_FORCES = [...new Set(KNOWN_GAPS.map((gap) => gap.force))];

describe('ukcrime_list_reference', () => {
  const h = useToolHarness();

  describe('topic forces', () => {
    it('lists the upstream forces then British Transport Police, under cap, with attribution and no notice', async () => {
      const result = await call({ topic: 'forces' });
      const out = data(result);
      expect(out.topic).toBe('forces');
      expect(out.forces?.map((force) => force.id)).toEqual([
        ...forcesBody().map((force) => force.id),
        'btp',
      ]);
      expect(out.forces?.at(-1)?.name).toBe('British Transport Police');
      expect(out.attribution).toBe(ATTRIBUTION);
      expect(out.notice).toBeUndefined();
      expect(text(result)).toContain('**Attribution:**');
      expect(text(result)).toContain('## Police forces (8)');
    });

    it('attaches the known gaps, dated, to exactly the forces the table names', async () => {
      const out = data(await call({ topic: 'forces' }));
      for (const entry of out.forces ?? []) {
        if (GAP_FORCES.includes(entry.id)) {
          expect(entry.gaps).toBe(forceGaps(entry.id));
          expect(entry.gaps).toContain(`verified ${KNOWN_GAPS_VERIFIED}`);
        } else {
          expect(entry).not.toHaveProperty('gaps');
        }
      }
      const withGaps = (out.forces ?? []).filter((entry) => entry.gaps).map((entry) => entry.id);
      expect(withGaps.sort()).toEqual(
        [...GAP_FORCES]
          .filter((id) => [...forcesBody().map((f) => f.id), 'btp'].includes(id))
          .sort(),
      );
    });

    it('strips upstream fields the server does not read', async () => {
      h.upstream.route(
        'GET',
        '/forces',
        jsonOk([{ id: 'leicestershire', name: 'Leicestershire Police', extra: 'x' }]),
      );
      const out = data(await call({ topic: 'forces' }));
      expect(out.forces?.[0]).toEqual({ id: 'leicestershire', name: 'Leicestershire Police' });
    });

    it('lists only British Transport Police when upstream lists nothing', async () => {
      h.upstream.route('GET', '/forces', jsonOk([]));
      const out = data(await call({ topic: 'forces' }));
      expect(out.forces?.map((force) => force.id)).toEqual(['btp']);
    });

    it.each([
      ['manchester', ['greater-manchester']],
      ['POLICE MANCHESTER', ['greater-manchester']],
      ['greater manchester', ['greater-manchester']],
      ['manchester greater', ['greater-manchester']],
      ['devon cornwall', ['devon-and-cornwall']],
      ['Devon & Cornwall', ['devon-and-cornwall']],
      ['dyfed powys', ['dyfed-powys']],
      ['transport', ['btp']],
      ['  leicestershire  ', ['leicestershire']],
    ])('name_contains %j matches %j', async (query, ids) => {
      const out = data(await call({ topic: 'forces', name_contains: query }));
      expect(out.forces?.map((force) => force.id)).toEqual(ids);
    });

    it('returns an empty list with a notice naming the trimmed query when nothing matches (zero-result page)', async () => {
      const result = await call({ topic: 'forces', name_contains: '  zzzz ' });
      const out = data(result);
      expect(out.forces).toEqual([]);
      expect(out.attribution).toBe(ATTRIBUTION);
      expect(out.notice).toBe(
        'No forces matched "zzzz"; call ukcrime_list_reference with topic \'forces\' and no name_contains to browse the full list.',
      );
      expect(text(result)).toContain('_No forces matched._');
      expect(text(result)).toContain('No forces matched "zzzz"');
    });

    it('requires every token to appear', async () => {
      const out = data(await call({ topic: 'forces', name_contains: 'manchester leicestershire' }));
      expect(out.forces).toEqual([]);
    });
  });

  describe('topic categories', () => {
    it('lists all 15 categories with slug and display name', async () => {
      const result = await call({ topic: 'categories' });
      const out = data(result);
      expect(out.categories).toEqual(
        categoriesBody().map(({ url, name }) => ({ slug: url, name })),
      );
      expect(out.categories).toHaveLength(15);
      expect(out.attribution).toBe(ATTRIBUTION);
      expect(out.notice).toBeUndefined();
      expect(text(result)).toContain('| violent-crime | Violence and sexual offences |');
    });

    it('validates an empty upstream list as an empty page', async () => {
      h.upstream.route('GET', '/crime-categories', jsonOk([]));
      const result = await call({ topic: 'categories' });
      expect(data(result).categories).toEqual([]);
      expect(text(result)).toContain('## Crime categories (0)');
    });
  });

  describe('topic availability', () => {
    it('lists every published month newest first with publisher counts and the forces that did not publish', async () => {
      const result = await call({ topic: 'availability' });
      const out = data(result);
      expect(out.availability?.latest_month).toBe('2026-08');
      expect(out.availability?.earliest_month).toBe('2023-09');
      expect(out.availability?.months).toHaveLength(36);
      expect(out.availability?.months[0]).toEqual({
        month: '2026-08',
        stop_search_forces_published: 2,
        stop_search_not_published: [
          'avon-and-somerset',
          'devon-and-cornwall',
          'dyfed-powys',
          'greater-manchester',
          'metropolitan',
          'northern-ireland',
        ],
      });
      expect(out.availability?.months.at(-1)?.month).toBe('2023-09');
      expect(out.availability).not.toHaveProperty('force');
      expect(out.notice).toBeUndefined();
      expect(text(result)).toContain('| 2026-08 | 2 | avon-and-somerset, devon-and-cornwall');
    });

    it('counts a publisher the force list does not know, and shows (none) when every force published', async () => {
      h.upstream.route(
        'GET',
        '/crimes-street-dates',
        jsonOk([
          {
            date: '2026-08',
            'stop-and-search': [...forcesBody().map((force) => force.id), 'btp', 'ghost-force'],
          },
        ]),
      );
      const result = await call({ topic: 'availability' });
      const row = data(result).availability?.months[0];
      expect(row?.stop_search_forces_published).toBe(9);
      expect(row?.stop_search_not_published).toEqual([]);
      expect(text(result)).toContain('| 2026-08 | 9 | (none) |');
    });

    it('returns one row for a month given', async () => {
      const result = await call({ topic: 'availability', month: '2025-01' });
      const out = data(result);
      expect(out.availability?.months.map((row) => row.month)).toEqual(['2025-01']);
      expect(out.notice).toBeUndefined();
    });

    it('answers a month outside the window with no rows and a notice (zero-result page)', async () => {
      const result = await call({ topic: 'availability', month: '2026-09' });
      const out = data(result);
      expect(out.availability?.months).toEqual([]);
      expect(out.availability?.latest_month).toBe('2026-08');
      expect(out.notice).toBe('2026-09 is outside the published window 2023-09–2026-08.');
      expect(out.attribution).toBe(ATTRIBUTION);
      expect(text(result)).toContain('_No months to show._');
    });

    it('answers a month before the window the same way', async () => {
      const out = data(await call({ topic: 'availability', month: '2023-08' }));
      expect(out.notice).toBe('2023-08 is outside the published window 2023-09–2026-08.');
    });

    it('says so when a month inside the window is missing from the list', async () => {
      const dates = streetDatesBody().filter((row) => row.date !== '2025-01');
      h.upstream.route('GET', '/crimes-street-dates', jsonOk(dates));
      const out = data(await call({ topic: 'availability', month: '2025-01' }));
      expect(out.availability?.months).toEqual([]);
      expect(out.notice).toBe("2025-01 is not in data.police.uk's published month list.");
    });

    it('with a force, lists the months it did and did not publish stop and search', async () => {
      h.upstream.route(
        'GET',
        '/crimes-street-dates',
        jsonOk([
          { date: '2026-08', 'stop-and-search': ['leicestershire'] },
          { date: '2026-07', 'stop-and-search': ['metropolitan'] },
          { date: '2026-06', 'stop-and-search': ['leicestershire', 'metropolitan'] },
        ]),
      );
      const result = await call({ topic: 'availability', force: 'Leicestershire' });
      const availability = data(result).availability;
      expect(availability?.force).toBe('leicestershire');
      expect(availability?.force_stop_search_published_months).toEqual(['2026-08', '2026-06']);
      expect(availability?.force_stop_search_missing_months).toEqual(['2026-07']);
      expect(text(result)).toContain('**Force:** leicestershire');
      expect(text(result)).toContain('**Stop and search published:** 2026-08, 2026-06');
      expect(text(result)).toContain('**Stop and search not published:** 2026-07');
    });

    it('accepts btp as the force and reads it from the publisher lists', async () => {
      const availability = data(
        await call({ topic: 'availability', force: 'btp', month: '2026-08' }),
      ).availability;
      expect(availability?.force).toBe('btp');
      expect(availability?.force_stop_search_published_months).toEqual(['2026-08']);
    });

    it('normalizes a spoken force name through the input schema', async () => {
      const availability = data(
        await call({ topic: 'availability', force: 'Greater Manchester', month: '2026-08' }),
      ).availability;
      expect(availability?.force).toBe('greater-manchester');
      expect(availability?.force_stop_search_missing_months).toEqual(['2026-08']);
      expect(
        text(await call({ topic: 'availability', force: 'greater_manchester', month: '2026-08' })),
      ).toContain('**Stop and search published:** (none)');
    });

    it('rejects an unknown force with unknown_force', async () => {
      const error = errorOf(await call({ topic: 'availability', force: 'atlantis' }));
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data.reason).toBe('unknown_force');
      expect(error.message).toBe("No police force 'atlantis'.");
      expect(error.data.recovery?.hint).toContain("topic 'forces'");
    });
  });

  describe('topic neighbourhoods', () => {
    const lookup = (force: string, body: unknown) =>
      h.upstream.route('GET', `/${force}/neighbourhoods`, jsonOk(body));

    it('lists the force neighbourhoods sorted by name, ids kept, with the force echoed', async () => {
      lookup('leicestershire', neighbourhoodsBody());
      const result = await call({ topic: 'neighbourhoods', force: 'leicestershire' });
      const out = data(result);
      expect(out.force).toBe('leicestershire');
      expect(out.neighbourhoods).toEqual([
        { id: 'NX01', name: 'Example Central' },
        { id: 'NX03', name: 'Example Harbour' },
        { id: 'NX02', name: 'Example Meadows' },
      ]);
      expect(out.notice).toBeUndefined();
      expect(text(result)).toContain('## Neighbourhoods (3)');
      expect(text(result)).toContain('| NX03 | Example Harbour |');
    });

    it('sorts names in English collation order, case-insensitively at the first difference', async () => {
      lookup('leicestershire', [
        { id: '3', name: 'Example Zulu' },
        { id: '1', name: 'example alpha' },
        { id: '2', name: 'Example Mike' },
      ]);
      const out = data(await call({ topic: 'neighbourhoods', force: 'leicestershire' }));
      expect(out.neighbourhoods?.map((n) => n.name)).toEqual([
        'example alpha',
        'Example Mike',
        'Example Zulu',
      ]);
    });

    it('reads a numeric upstream id as a string', async () => {
      lookup('leicestershire', [{ id: 7, name: 'Seven' }]);
      const out = data(await call({ topic: 'neighbourhoods', force: 'leicestershire' }));
      expect(out.neighbourhoods).toEqual([{ id: '7', name: 'Seven' }]);
    });

    it('returns every row for a large force (the Metropolitan list is about 680)', async () => {
      h.upstream.route(
        'GET',
        '/metropolitan/neighbourhoods',
        jsonOk(
          Array.from({ length: 680 }, (_, i) => ({
            id: `M${i}`,
            name: `Ward ${String(i).padStart(3, '0')}`,
          })),
        ),
      );
      const result = await call({ topic: 'neighbourhoods', force: 'metropolitan' });
      expect(data(result).neighbourhoods).toHaveLength(680);
      expect(text(result)).toContain('## Neighbourhoods (680)');
      expect(
        text(result)
          .split('\n')
          .filter((line) => line.startsWith('| M')),
      ).toHaveLength(680);
    });

    it('filters by name ignoring case, accents and punctuation, in any word order', async () => {
      lookup('leicestershire', [
        { id: 'A', name: 'Café Quarter' },
        { id: 'B', name: "St. Mary's Ward" },
        { id: 'C', name: 'Harbour' },
      ]);
      for (const [query, id] of [
        ['cafe', 'A'],
        ['CAFÉ quarter', 'A'],
        ['st marys', 'B'],
        ['ward mary', 'B'],
      ] as const) {
        const out = data(
          await call({ topic: 'neighbourhoods', force: 'leicestershire', name_contains: query }),
        );
        expect(
          out.neighbourhoods?.map((n) => n.id),
          query,
        ).toEqual([id]);
      }
    });

    it('returns an empty list with a notice when the filter matches nothing (zero-result page)', async () => {
      lookup('leicestershire', neighbourhoodsBody());
      const result = await call({
        topic: 'neighbourhoods',
        force: 'leicestershire',
        name_contains: 'zzzz',
      });
      const out = data(result);
      expect(out.neighbourhoods).toEqual([]);
      expect(out.notice).toContain('No neighbourhoods matched "zzzz"');
      expect(out.attribution).toBe(ATTRIBUTION);
      expect(text(result)).toContain('_No neighbourhoods matched._');
    });

    it('returns an empty list, no notice, for a force whose list is empty', async () => {
      lookup('leicestershire', []);
      const out = data(await call({ topic: 'neighbourhoods', force: 'leicestershire' }));
      expect(out.neighbourhoods).toEqual([]);
      expect(out.notice).toBeUndefined();
    });

    it('normalizes the force input before the lookup', async () => {
      lookup('greater-manchester', neighbourhoodsBody());
      const out = data(await call({ topic: 'neighbourhoods', force: ' Greater Manchester ' }));
      expect(out.force).toBe('greater-manchester');
    });

    it('fails force_required without a force, before any request', async () => {
      const error = errorOf(await call({ topic: 'neighbourhoods' }));
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data.reason).toBe('force_required');
      expect(error.data.recovery?.hint).toContain(
        "call ukcrime_list_reference with topic 'forces'",
      );
      expect(h.upstream.calls).toHaveLength(0);
    });

    it('fails unknown_force for a force not in the list, without asking for its neighbourhoods', async () => {
      const error = errorOf(await call({ topic: 'neighbourhoods', force: 'atlantis' }));
      expect(error.data.reason).toBe('unknown_force');
      expect(error.message).toBe("No police force 'atlantis'.");
      expect(h.upstream.count('/atlantis/neighbourhoods')).toBe(0);
    });

    it('fails unknown_force for btp, which has no neighbourhoods', async () => {
      const error = errorOf(await call({ topic: 'neighbourhoods', force: 'btp' }));
      expect(error.data.reason).toBe('unknown_force');
      expect(error.message).toBe('British Transport Police has no neighbourhoods.');
    });

    it('fails unknown_force when upstream answers 404 for a listed force', async () => {
      h.upstream.route('GET', '/leicestershire/neighbourhoods', plainNotFound);
      const error = errorOf(await call({ topic: 'neighbourhoods', force: 'leicestershire' }));
      expect(error.data.reason).toBe('unknown_force');
      expect(error.message).toContain('lists no neighbourhoods');
    });
  });

  describe('filters that do not fit the topic', () => {
    it.each<[string, Input, string]>([
      [
        'name_contains on categories',
        { topic: 'categories', name_contains: 'x' },
        "name_contains does not apply to topic 'categories'.",
      ],
      [
        'name_contains on availability',
        { topic: 'availability', name_contains: 'x' },
        "name_contains does not apply to topic 'availability'.",
      ],
      [
        'month on forces',
        { topic: 'forces', month: '2026-08' },
        "month applies only to topic 'availability', not 'forces'.",
      ],
      [
        'month on categories',
        { topic: 'categories', month: '2026-08' },
        "month applies only to topic 'availability', not 'categories'.",
      ],
      [
        'month on neighbourhoods',
        { topic: 'neighbourhoods', force: 'leicestershire', month: '2026-08' },
        "month applies only to topic 'availability', not 'neighbourhoods'.",
      ],
      [
        'force on forces',
        { topic: 'forces', force: 'leicestershire' },
        "force does not apply to topic 'forces'.",
      ],
      [
        'force on categories',
        { topic: 'categories', force: 'leicestershire' },
        "force does not apply to topic 'categories'.",
      ],
    ])('rejects %s with invalid_filter, before any request', async (_name, input, message) => {
      const error = errorOf(await call(input));
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data.reason).toBe('invalid_filter');
      expect(error.message).toBe(message);
      expect(error.data.recovery?.hint).toContain('name_contains only on topic');
      expect(h.upstream.calls).toHaveLength(0);
    });
  });

  describe('blank values read as unset (form clients)', () => {
    it.each<[string, Input]>([
      ['forces', { topic: 'forces', force: '', name_contains: '   ', month: '' }],
      ['categories', { topic: 'categories', force: ' ', name_contains: '', month: '\t' }],
      ['availability', { topic: 'availability', force: '', name_contains: '', month: '' }],
    ])('accepts empty strings on every optional input of %s', async (topic, input) => {
      const out = data(await call(input));
      expect(out.topic).toBe(topic);
      expect(out.notice).toBeUndefined();
    });

    it('treats a blank force on neighbourhoods as missing (force_required), not as a value', async () => {
      const error = errorOf(await call({ topic: 'neighbourhoods', force: '  ' }));
      expect(error.data.reason).toBe('force_required');
    });

    it('treats a blank name_contains as no filter', async () => {
      h.upstream.route('GET', '/leicestershire/neighbourhoods', jsonOk(neighbourhoodsBody()));
      const out = data(
        await call({ topic: 'neighbourhoods', force: 'leicestershire', name_contains: '' }),
      );
      expect(out.neighbourhoods).toHaveLength(3);
      expect(out.notice).toBeUndefined();
    });

    it('treats a blank month and force on availability as the full unfiltered window', async () => {
      const availability = data(
        await call({ topic: 'availability', force: '', month: '' }),
      ).availability;
      expect(availability?.months).toHaveLength(36);
      expect(availability).not.toHaveProperty('force');
    });

    it('reads null the same way', async () => {
      const out = data(
        await callRaw({ topic: 'forces', force: null, name_contains: null, month: null }),
      );
      expect(out.forces).toHaveLength(8);
    });
  });

  describe('input validation', () => {
    it.each<[string, unknown]>([
      ['an unknown topic', { topic: 'crimes' }],
      ['a missing topic', {}],
      ['a month in the wrong form', { topic: 'availability', month: '2026-13' }],
      ['a force with a path in it', { topic: 'neighbourhoods', force: '../forces' }],
      ['a force with digits', { topic: 'neighbourhoods', force: 'force1' }],
      ['a name_contains over 100 characters', { topic: 'forces', name_contains: 'a'.repeat(101) }],
      ['a name_contains of punctuation only', { topic: 'forces', name_contains: ' & - ' }],
      ['a non-string force', { topic: 'neighbourhoods', force: 5 }],
    ])('rejects %s as InvalidParams without any request', async (_name, input) => {
      const error = errorOf(await callRaw(input));
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(error.data.reason).toBe('invalid_arguments');
      expect(h.upstream.calls).toHaveLength(0);
    });
  });

  describe('upstream failures', () => {
    it.each<[string, () => void, number, string | undefined]>([
      [
        'a persistent 500',
        () => h.upstream.route('GET', '/forces', status(500)),
        JsonRpcErrorCode.ServiceUnavailable,
        undefined,
      ],
      [
        'a 429 with a long Retry-After',
        () => h.upstream.route('GET', '/forces', rateLimited('60')),
        JsonRpcErrorCode.RateLimited,
        undefined,
      ],
      [
        'an HTML 200 body',
        () => h.upstream.route('GET', '/forces', htmlOk),
        JsonRpcErrorCode.ServiceUnavailable,
        'unreadable_response',
      ],
      [
        'a body of the wrong shape',
        () => h.upstream.route('GET', '/forces', jsonOk({ forces: [] })),
        JsonRpcErrorCode.ServiceUnavailable,
        'unexpected_response',
      ],
      [
        'an upstream that never answers',
        () => h.upstream.route('GET', '/forces', hang),
        JsonRpcErrorCode.Timeout,
        undefined,
      ],
      [
        'a 404 on the force list',
        () => h.upstream.route('GET', '/forces', plainNotFound),
        JsonRpcErrorCode.NotFound,
        undefined,
      ],
    ])(
      'surfaces %s from topic forces as a classified error',
      async (_name, arrange, code, reason) => {
        arrange();
        const error = errorOf(await call({ topic: 'forces' }));
        expect(error.code).toBe(code);
        if (reason) expect(error.data.reason).toBe(reason);
      },
    );

    it('surfaces a failing category list', async () => {
      h.upstream.route('GET', '/crime-categories', status(502));
      expect(errorOf(await call({ topic: 'categories' })).code).toBe(
        JsonRpcErrorCode.ServiceUnavailable,
      );
    });

    it('fails availability when either parallel read fails', async () => {
      h.upstream.route('GET', '/forces', status(500));
      expect(errorOf(await call({ topic: 'availability' })).code).toBe(
        JsonRpcErrorCode.ServiceUnavailable,
      );
    });

    it('surfaces a failing neighbourhood list', async () => {
      h.upstream.route('GET', '/leicestershire/neighbourhoods', status(500));
      const error = errorOf(await call({ topic: 'neighbourhoods', force: 'leicestershire' }));
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    });

    it('does not echo the upstream body in the error', async () => {
      h.upstream.route('GET', '/forces', jsonOk({ secret: 'upstream-only-text' }));
      const result = await call({ topic: 'forces' });
      expect(JSON.stringify(result)).not.toContain('upstream-only-text');
    });
  });

  describe('caching across calls', () => {
    it('reads each reference list once for repeat calls', async () => {
      await call({ topic: 'forces' });
      await call({ topic: 'forces', name_contains: 'leicestershire' });
      await call({ topic: 'availability' });
      await call({ topic: 'availability', force: 'btp' });
      expect(h.upstream.count('/forces')).toBe(1);
      expect(h.upstream.count('/crimes-street-dates')).toBe(1);
    });
  });

  describe('format() matches structuredContent', () => {
    it('renders every force id, name and gap', async () => {
      const result = await call({ topic: 'forces' });
      const out = data(result);
      const rendered = text(result);
      for (const entry of out.forces ?? []) {
        expect(rendered).toContain(entry.id);
        expect(rendered).toContain(entry.name);
        if (entry.gaps) expect(rendered).toContain(entry.gaps);
      }
      expect(rendered).toContain('| leicestershire | Leicestershire Police | — |');
    });

    it('renders every availability row', async () => {
      const result = await call({ topic: 'availability' });
      const out = data(result);
      for (const row of out.availability?.months ?? []) {
        expect(text(result)).toContain(`| ${row.month} | ${row.stop_search_forces_published} |`);
      }
    });

    it('keeps upstream text verbatim in structuredContent and inert in the markdown', async () => {
      const hostileName = 'Evil\r\n# Injected | cell [x](https://evil.test) <b>\u202Etxt';
      h.upstream.route('GET', '/forces', jsonOk([{ id: 'leicestershire', name: hostileName }]));
      const result = await call({ topic: 'forces' });
      expect(data(result).forces?.[0]?.name).toBe(hostileName);
      const rendered = text(result);
      expect(rendered).not.toContain('\r');
      expect(rendered).not.toContain('\u202E');
      expect(rendered.split('\n').some((line) => line.startsWith('# Injected'))).toBe(false);
      const row = rendered.split('\n').find((line) => line.startsWith('| leicestershire'));
      expect(row).toBe(
        '| leicestershire | Evil # Injected \\| cell \\[x\\](https://evil.test) \\<b\\>txt | — |',
      );
    });

    it('keeps CR/LF in neighbourhood and category text out of table rows', async () => {
      h.upstream.route(
        'GET',
        '/leicestershire/neighbourhoods',
        jsonOk([{ id: 'N|1', name: 'Line one\r\nLine two\nLine three' }]),
      );
      h.upstream.route(
        'GET',
        '/crime-categories',
        jsonOk([{ url: 'odd\nslug', name: 'Odd\r\nname | x' }]),
      );
      const hoods = text(await call({ topic: 'neighbourhoods', force: 'leicestershire' }));
      expect(hoods).toContain('| N\\|1 | Line one Line two Line three |');
      expect(hoods).not.toContain('\r');
      const cats = text(await call({ topic: 'categories' }));
      expect(cats).toContain('| odd slug | Odd name \\| x |');
    });

    it('renders none markers for empty publisher lists in the force lines', async () => {
      const blocks = listReferenceTool.format?.({
        topic: 'availability',
        availability: {
          latest_month: '2026-08',
          earliest_month: '2026-08',
          months: [
            { month: '2026-08', stop_search_forces_published: 3, stop_search_not_published: [] },
          ],
          force: 'leicestershire',
          force_stop_search_published_months: [],
          force_stop_search_missing_months: [],
        },
      });
      const rendered =
        blocks?.map((block) => (block.type === 'text' ? block.text : '')).join('') ?? '';
      expect(rendered).toContain('**Stop and search published:** (none)');
      expect(rendered).toContain('**Stop and search not published:** (none)');
      expect(rendered).toContain('| 2026-08 | 3 | (none) |');
    });
  });
});
