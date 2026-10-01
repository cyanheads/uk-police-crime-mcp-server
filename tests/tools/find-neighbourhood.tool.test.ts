/**
 * @fileoverview ukcrime_find_neighbourhood through `runToolContract` (the
 * production parse of output extended with enrichment): point and id lookups,
 * the three invalid_lookup messages, unknown_force, `found: false` for a locate
 * or profile miss, section loading by `include` (cut to 5, then de-duplicated;
 * `[]` loads none; blank is the default), the single degraded-sections notice,
 * the event cap and `events_total`, the boundary string, known-gap and force-name
 * fallbacks, the proof that a biography and per-person contacts never reach
 * either surface, the enrichment fields on the not-found and found pages and
 * their write order, upstream failure classes, blank form values, caching, and
 * `format()` carrying the same data as `structuredContent` with upstream text
 * kept inert.
 * @module tests/tools/find-neighbourhood.tool.test
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
import { findNeighbourhoodTool } from '@/mcp-server/tools/definitions/find-neighbourhood.tool.js';
import { ATTRIBUTION, polygonInput } from '@/mcp-server/tools/shared-schemas.js';
import { forceGaps } from '@/services/police-api/known-gaps.js';
import {
  boundaryBody,
  forceDetailBody,
  hang,
  htmlBadRequest,
  htmlOk,
  jsonOk,
  locateBody,
  neighbourhoodDetailBody,
  plainNotFound,
  prioritiesBody,
  type Responder,
  rateLimited,
  status,
} from '../fixtures/police-api-upstream.js';
import {
  delayed,
  hostileDetailBody,
  manyEvents,
  neighbourhoodRoutes,
  peopleWithPrivateFields,
} from '../fixtures/police-api-upstream-w3.js';
import { quoteRunOns } from '../fixtures/quote-run-ons.js';
import { settle, useToolHarness } from '../fixtures/service-harness.js';

type Input = z.input<typeof findNeighbourhoodTool.input>;
type Output = z.output<typeof findNeighbourhoodTool.output> & {
  attribution: string;
  data_note: string;
  notice?: string;
};
type Result = Awaited<ReturnType<typeof runToolContract>>;

const call = (input: Input) => settle(runToolContract(findNeighbourhoodTool, input));
const callRaw = (input: unknown) => settle(runToolContract(findNeighbourhoodTool, input as Input));

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

const LAT = 52.63;
const LNG = -1.13;
const POINT = { lat: LAT, lng: LNG } as const;
const BY_ID = { force: 'leicestershire', neighbourhood_id: 'NX01' } as const;
const P = '/leicestershire/NX01';
const SECTION_PATHS = [`${P}/priorities`, `${P}/people`, `${P}/events`, `${P}/boundary`] as const;
const OUTSIDE_COVERAGE =
  'This point is outside data.police.uk coverage (England, Wales and Northern Ireland; Scotland only through British Transport Police); check that lat and lng are not swapped.';
const DATA_NOTE =
  "Team, priorities and events are published by the force and can lag; the boundary is the force's own neighbourhood polygon.";
const COULD_NOT = (parts: string) =>
  `Could not load ${parts} from data.police.uk; call ukcrime_find_neighbourhood again to retry.`;
const BOUNDARY_STRING =
  '52.630000,-1.140000:52.630000,-1.120000:52.640000,-1.120000:52.640000,-1.140000:52.630000,-1.140000';

describe('ukcrime_find_neighbourhood', () => {
  const h = useToolHarness();
  const routes = (people?: unknown) =>
    people === undefined
      ? neighbourhoodRoutes(h.upstream)
      : neighbourhoodRoutes(h.upstream, undefined, people);

  describe('point lookup', () => {
    it('locates the point, loads the profile, force detail and the default sections, and not the boundary', async () => {
      routes();
      const out = data(await call({ ...POINT }));
      expect(out.found).toBe(true);
      expect(out.located_from).toEqual({ lat: LAT, lng: LNG });
      expect(out.force).toEqual({
        id: 'leicestershire',
        name: 'Leicestershire Police',
        url: 'https://www.example-force.police.test',
        telephone: '101',
      });
      expect(out.neighbourhood).toEqual({
        id: 'NX01',
        name: 'Example Central',
        url: 'https://www.example-force.police.test/nx01',
        centre: { latitude: 52.635, longitude: -1.13 },
        population: 4200,
        description: 'An invented neighbourhood.',
        contact: [
          { channel: 'email', value: 'nx01@example-force.police.test' },
          { channel: 'telephone', value: '101' },
        ],
        links: [],
        stations: [
          {
            type: 'station',
            name: 'Example Central Station',
            address: '1 Example Street\nExample Town',
            postcode: 'EX1 1AA',
          },
        ],
      });
      expect(out.priorities).toEqual([
        {
          issue: 'Anti-social behaviour & fly-tipping.',
          issue_date: '2026-07-01T00:00:00',
          action: 'Patrols\nCommunity meetings',
          action_date: '2026-08-01T00:00:00',
        },
      ]);
      expect(out.team).toEqual([
        { rank: 'PC 0000', name: 'Example Officer' },
        { rank: 'Sgt 0000', name: 'Sample Sergeant' },
      ]);
      expect(out.events).toEqual([
        {
          title: 'Example drop-in session',
          type: 'meeting',
          start: '2026-09-15T18:00:00',
          end: '2026-09-15T19:00:00',
          address: 'Example Hall, Example Street',
          description: 'Meet your team.',
        },
      ]);
      expect(out.events_total).toBe(1);
      expect(out).not.toHaveProperty('boundary');
      expect(out).not.toHaveProperty('gaps');
      expect(out).not.toHaveProperty('guidance');
      expect(out.notice).toBeUndefined();
      expect(h.upstream.count(`${P}/boundary`)).toBe(0);
      const locate = h.upstream.callsTo('/locate-neighbourhood')[0];
      expect(locate?.query.get('q')).toBe('52.630000,-1.130000');
    });

    it('accepts the coordinate aliases', async () => {
      routes();
      expect(data(await callRaw({ latitude: LAT, longitude: LNG })).located_from).toEqual({
        lat: LAT,
        lng: LNG,
      });
      expect(data(await callRaw({ latitude: 52.1, lon: -1.2 })).located_from).toEqual({
        lat: 52.1,
        lng: -1.2,
      });
      expect(data(await callRaw({ lat: 52.2, long: -1.3 })).located_from).toEqual({
        lat: 52.2,
        lng: -1.3,
      });
    });

    it('treats lat 0 and lng 0 as a point, not as unset', async () => {
      h.upstream.route('GET', '/locate-neighbourhood', plainNotFound);
      const out = data(await call({ lat: 0, lng: 0 }));
      expect(out.found).toBe(false);
      expect(out.located_from).toEqual({ lat: 0, lng: 0 });
      expect(h.upstream.callsTo('/locate-neighbourhood')[0]?.query.get('q')).toBe(
        '0.000000,0.000000',
      );
    });

    it('answers found false with the coverage guidance and located_from when the point is outside coverage, asking for nothing else', async () => {
      h.upstream.route('GET', '/locate-neighbourhood', plainNotFound);
      const result = await call({ ...POINT });
      const out = data(result);
      expect(out.found).toBe(false);
      expect(out.guidance).toBe(OUTSIDE_COVERAGE);
      expect(out.located_from).toEqual({ lat: LAT, lng: LNG });
      expect(out).not.toHaveProperty('force');
      expect(out).not.toHaveProperty('neighbourhood');
      expect(out.notice).toBeUndefined();
      expect(h.upstream.calls.map((c) => c.path)).toEqual(['/locate-neighbourhood']);
      expect(text(result)).toContain('## Neighbourhood not found');
      expect(text(result)).toContain('**Found:** no');
    });

    it('answers found false when the located neighbourhood has no profile, naming the case-sensitive id', async () => {
      routes();
      h.upstream.route('GET', P, plainNotFound);
      const out = data(await call({ ...POINT }));
      expect(out.found).toBe(false);
      expect(out.guidance).toBe(
        "No neighbourhood 'NX01' in force 'leicestershire'. Ids are case-sensitive; call ukcrime_list_reference with topic 'neighbourhoods' and force 'leicestershire' to find it by name.",
      );
      expect(out.located_from).toEqual({ lat: LAT, lng: LNG });
      expect(out).not.toHaveProperty('force');
      expect(out.notice).toBeUndefined();
    });

    it('falls back for the force name: the force list, then the force detail, then the id', async () => {
      routes();
      h.upstream.route(
        'GET',
        '/locate-neighbourhood',
        jsonOk(locateBody({ force: 'ghost-force' })),
      );
      h.upstream.route('GET', '/ghost-force/NX01', jsonOk(neighbourhoodDetailBody()));
      h.upstream.route('GET', '/ghost-force/NX01/priorities', jsonOk([]));
      h.upstream.route('GET', '/ghost-force/NX01/people', jsonOk([]));
      h.upstream.route('GET', '/ghost-force/NX01/events', jsonOk([]));
      h.upstream.route(
        'GET',
        '/forces/ghost-force',
        jsonOk(forceDetailBody({ id: 'ghost-force', name: 'Ghost Constabulary' })),
      );
      expect(data(await call({ ...POINT })).force).toMatchObject({
        id: 'ghost-force',
        name: 'Ghost Constabulary',
      });
      h.upstream.route(
        'GET',
        '/locate-neighbourhood',
        jsonOk(locateBody({ force: 'phantom-force' })),
      );
      for (const section of ['', '/priorities', '/people', '/events']) {
        h.upstream.route(
          'GET',
          `/phantom-force/NX01${section}`,
          section === '' ? jsonOk(neighbourhoodDetailBody()) : jsonOk([]),
        );
      }
      h.upstream.route('GET', '/forces/phantom-force', plainNotFound);
      const out = data(await call({ lat: 52.7, lng: -1.2 }));
      expect(out.force).toEqual({ id: 'phantom-force', name: 'phantom-force' });
      expect(out.notice).toBeUndefined();
    });
  });

  describe('id lookup', () => {
    it('skips the locate, validates the force against the list and loads the same sections', async () => {
      routes();
      const out = data(await call({ ...BY_ID }));
      expect(out.found).toBe(true);
      expect(out).not.toHaveProperty('located_from');
      expect(out.force?.name).toBe('Leicestershire Police');
      expect(out.neighbourhood?.id).toBe('NX01');
      expect(h.upstream.count('/locate-neighbourhood')).toBe(0);
      expect(h.upstream.count('/forces')).toBe(1);
    });

    it('normalizes a spoken force name and keeps the neighbourhood id case and spaces', async () => {
      neighbourhoodRoutes(h.upstream, { force: 'northern-ireland', id: 'Some Place' });
      const out = data(
        await call({ force: ' Northern_Ireland ', neighbourhood_id: ' Some Place ' }),
      );
      expect(out.force?.id).toBe('northern-ireland');
      expect(out.neighbourhood?.id).toBe('Some Place');
      expect(h.upstream.count('/northern-ireland/Some%20Place')).toBe(1);
    });

    it('answers found false without located_from for an unknown id (404), with no notice even though the sections 404 too', async () => {
      routes();
      for (const path of [P, ...SECTION_PATHS]) h.upstream.route('GET', path, plainNotFound);
      const out = data(await call({ ...BY_ID, neighbourhood_id: 'NX01' }));
      expect(out.found).toBe(false);
      expect(out.guidance).toContain("No neighbourhood 'NX01' in force 'leicestershire'.");
      expect(out).not.toHaveProperty('located_from');
      expect(out.notice).toBeUndefined();
    });

    it('treats a wrongly cased id as a miss (ids are case-sensitive upstream)', async () => {
      routes();
      h.upstream.route('GET', '/leicestershire/nx01', plainNotFound);
      for (const section of ['priorities', 'people', 'events']) {
        h.upstream.route('GET', `/leicestershire/nx01/${section}`, plainNotFound);
      }
      const out = data(await call({ force: 'leicestershire', neighbourhood_id: 'nx01' }));
      expect(out.found).toBe(false);
      expect(out.guidance).toContain("No neighbourhood 'nx01'");
    });

    it('fails unknown_force for a force outside the list, before any neighbourhood request', async () => {
      const error = errorOf(await call({ force: 'atlantis', neighbourhood_id: 'NX01' }));
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data.reason).toBe('unknown_force');
      expect(error.message).toBe("No police force 'atlantis'.");
      expect(error.data.recovery?.hint).toContain("topic 'forces'");
      expect(h.upstream.calls.some((c) => c.path.startsWith('/atlantis'))).toBe(false);
    });

    it("fails unknown_force for 'btp' with the no-neighbourhoods message", async () => {
      const error = errorOf(await call({ force: 'btp', neighbourhood_id: 'NX01' }));
      expect(error.data.reason).toBe('unknown_force');
      expect(error.message).toBe('British Transport Police has no neighbourhoods.');
      expect(h.upstream.calls.some((c) => c.path.startsWith('/btp'))).toBe(false);
    });
  });

  describe('invalid_lookup', () => {
    it.each<[string, Record<string, unknown>, string]>([
      ['neither lookup', {}, 'Send lat and lng, or force and neighbourhood_id.'],
      [
        'both lookups',
        { ...POINT, ...BY_ID },
        'Send lat and lng, or force and neighbourhood_id — not both.',
      ],
      [
        'a point and half of an id',
        { ...POINT, force: 'leicestershire' },
        'Send lat and lng, or force and neighbourhood_id — not both.',
      ],
      [
        'half of a point and half of an id',
        { lat: LAT, neighbourhood_id: 'NX01' },
        'Send lat and lng, or force and neighbourhood_id — not both.',
      ],
      ['lat without lng', { lat: LAT }, 'lat and lng go together; lng is missing.'],
      ['lng without lat', { lng: LNG }, 'lat and lng go together; lat is missing.'],
      [
        'force without an id',
        { force: 'leicestershire' },
        'force and neighbourhood_id go together; neighbourhood_id is missing.',
      ],
      [
        'an id without a force',
        { neighbourhood_id: 'NX01' },
        'force and neighbourhood_id go together; force is missing.',
      ],
      [
        'only blanks',
        { lat: '', lng: null, force: ' ', neighbourhood_id: '' },
        'Send lat and lng, or force and neighbourhood_id.',
      ],
    ])('rejects %s with invalid_lookup, before any request', async (_name, input, message) => {
      const error = errorOf(await callRaw(input));
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data.reason).toBe('invalid_lookup');
      expect(error.message).toBe(message);
      expect(error.data.recovery?.hint).toBe(
        'Send lat and lng to look up by point, or force and neighbourhood_id to look up by id — not both.',
      );
      expect(h.upstream.calls).toHaveLength(0);
    });
  });

  describe('include', () => {
    const requested = () =>
      SECTION_PATHS.filter((path) => h.upstream.count(path) > 0).map((path) =>
        path.split('/').pop(),
      );

    it.each<[string, Input['include'] | undefined, string[]]>([
      ['omitted', undefined, ['priorities', 'people', 'events']],
      ['priorities only', ['priorities'], ['priorities']],
      ['team only', ['team'], ['people']],
      ['events only', ['events'], ['events']],
      ['boundary only', ['boundary'], ['boundary']],
      [
        'every section',
        ['priorities', 'team', 'events', 'boundary'],
        ['priorities', 'people', 'events', 'boundary'],
      ],
      ['an empty list', [], []],
    ])('with include %s requests exactly the sections that load', async (_name, include, paths) => {
      routes();
      await call({ ...BY_ID, ...(include === undefined ? {} : { include }) });
      expect(requested()).toEqual(paths);
      expect(h.upstream.count(P)).toBe(1);
      expect(h.upstream.count('/forces/leicestershire')).toBe(1);
    });

    it('never asks for /people without team', async () => {
      routes();
      await call({ ...BY_ID, include: ['priorities', 'events', 'boundary'] });
      expect(h.upstream.count(`${P}/people`)).toBe(0);
    });

    it('returns only the sections that were requested, and none for []', async () => {
      routes();
      const some = data(await call({ ...BY_ID, include: ['team'] }));
      expect(some.team).toHaveLength(2);
      expect(some).not.toHaveProperty('priorities');
      expect(some).not.toHaveProperty('events');
      expect(some).not.toHaveProperty('events_total');
      expect(some).not.toHaveProperty('boundary');
      const none = data(await call({ ...BY_ID, include: [] }));
      for (const key of ['priorities', 'team', 'events', 'events_total', 'boundary']) {
        expect(none, key).not.toHaveProperty(key);
      }
      expect(none.neighbourhood?.id).toBe('NX01');
    });

    it.each<[string, unknown]>([
      ['an empty string', ''],
      ['whitespace', '   '],
      ['null', null],
    ])('reads %s as the default sections', async (_name, include) => {
      routes();
      const out = data(await callRaw({ ...BY_ID, include }));
      expect(out.priorities).toBeDefined();
      expect(out.team).toBeDefined();
      expect(out.events).toBeDefined();
      expect(out).not.toHaveProperty('boundary');
    });

    it('de-duplicates, so a repeated section is requested once', async () => {
      routes();
      await call({ ...BY_ID, include: ['priorities', 'priorities', 'team', 'team'] });
      expect(h.upstream.count(`${P}/priorities`)).toBe(1);
      expect(h.upstream.count(`${P}/people`)).toBe(1);
    });

    it('cuts the list to five entries before de-duplicating, so a bad entry past the cut is never seen', async () => {
      routes();
      const out = data(
        await callRaw({ ...BY_ID, include: ['team', 'team', 'team', 'team', 'team', 'bogus'] }),
      );
      expect(out.team).toHaveLength(2);
      expect(requested()).toEqual(['people']);
    });

    it('accepts a long list of repeats that de-duplicates to the four sections', async () => {
      routes();
      await call({
        ...BY_ID,
        include: [
          'boundary',
          'team',
          'events',
          'priorities',
          'priorities',
          'events',
          'team',
        ] as never,
      });
      expect(requested()).toEqual(['priorities', 'people', 'events', 'boundary']);
    });

    it.each<[string, unknown]>([
      ['an unknown section', ['bogus']],
      ['a bad entry inside the first five', ['team', 'bogus', 'events']],
      ['a string that is not blank', 'team'],
      ['a number', 5],
    ])('rejects %s as InvalidParams', async (_name, include) => {
      const error = errorOf(await callRaw({ ...BY_ID, include }));
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(h.upstream.calls).toHaveLength(0);
    });
  });

  describe('degraded sections: one notice for everything that failed', () => {
    const all = ['priorities', 'team', 'events', 'boundary'] as const;

    it.each<[string, string, string]>([
      ['priorities', `${P}/priorities`, 'priorities'],
      ['team', `${P}/people`, 'team'],
      ['events', `${P}/events`, 'events'],
      ['boundary', `${P}/boundary`, 'boundary'],
    ])(
      'omits %s and says so when its request fails, keeping everything else',
      async (section, path, label) => {
        routes();
        h.upstream.route('GET', path, status(500));
        const out = data(await call({ ...BY_ID, include: [...all] }));
        expect(out.found).toBe(true);
        expect(out.notice).toBe(COULD_NOT(label));
        expect(out, section).not.toHaveProperty(section);
        for (const other of all.filter((s) => s !== section))
          expect(out[other], other).toBeDefined();
        expect(out.neighbourhood?.name).toBe('Example Central');
      },
    );

    it('reads a boundary 404 on a found neighbourhood as a failed boundary, not an empty polygon', async () => {
      routes();
      h.upstream.route('GET', `${P}/boundary`, plainNotFound);
      const out = data(await call({ ...BY_ID, include: ['boundary'] }));
      expect(out).not.toHaveProperty('boundary');
      expect(out.notice).toBe(COULD_NOT('boundary'));
    });

    it('names two failures with "and", in the order force details, priorities, team, events, boundary', async () => {
      routes();
      h.upstream.route('GET', `${P}/priorities`, status(500));
      h.upstream.route('GET', `${P}/events`, status(500));
      expect(data(await call({ ...BY_ID })).notice).toBe(COULD_NOT('priorities and events'));
    });

    it('names three or more with commas and a final "and", in one notice', async () => {
      routes();
      h.upstream.route('GET', `${P}/priorities`, status(500));
      h.upstream.route('GET', `${P}/people`, status(500));
      h.upstream.route('GET', `${P}/events`, status(500));
      expect(data(await call({ ...BY_ID })).notice).toBe(COULD_NOT('priorities, team and events'));
    });

    it('names all five parts, force details first, in one notice', async () => {
      routes();
      for (const path of ['/forces/leicestershire', ...SECTION_PATHS]) {
        h.upstream.route('GET', path, status(500));
      }
      const everything = await call({ ...BY_ID, include: [...all] });
      expect(data(everything).notice).toBe(
        COULD_NOT('force details, priorities, team, events and boundary'),
      );
      expect(text(everything).match(/Could not load/g)).toHaveLength(1);
    });

    it('writes the notice once through the enrichment, never twice', async () => {
      routes();
      h.upstream.route('GET', `${P}/priorities`, status(500));
      h.upstream.route('GET', `${P}/people`, status(500));
      const ctx = createMockContext({ errors: findNeighbourhoodTool.errors });
      const input = findNeighbourhoodTool.input.parse({ ...BY_ID });
      await settle(Promise.resolve(findNeighbourhoodTool.handler(input, ctx)));
      expect(Object.keys(getEnrichment(ctx))).toEqual(['attribution', 'data_note', 'notice']);
      expect(
        (ctx.log as MockContextLogger).calls.filter((c) => c.level === 'warning'),
      ).toHaveLength(2);
    });

    it('logs a failed part with server-written text, never the upstream reason phrase or body', async () => {
      routes();
      h.upstream.route(
        'GET',
        `${P}/priorities`,
        () =>
          new Response('upstream-body-text', {
            status: 502,
            statusText: 'Ask upstream-status-text',
          }),
      );
      const ctx = createMockContext({ errors: findNeighbourhoodTool.errors });
      const input = findNeighbourhoodTool.input.parse({ ...BY_ID });
      await settle(Promise.resolve(findNeighbourhoodTool.handler(input, ctx)));
      const warnings = (ctx.log as MockContextLogger).calls.filter((c) => c.level === 'warning');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.data).toMatchObject({
        part: 'priorities',
        error: expect.stringMatching(/^data\.police\.uk returned HTTP 502\./),
      });
      expect(JSON.stringify(warnings)).not.toContain('upstream-status-text');
      expect(JSON.stringify(warnings)).not.toContain('upstream-body-text');
    });

    it('omits the force url and telephone, but keeps its id and list name, when the force detail fails', async () => {
      routes();
      h.upstream.route('GET', '/forces/leicestershire', status(500));
      const out = data(await call({ ...BY_ID }));
      expect(out.force).toEqual({ id: 'leicestershire', name: 'Leicestershire Police' });
      expect(out.notice).toBe(COULD_NOT('force details'));
    });

    it('reads a force-detail 404 as no website or phone, with no notice (a miss is not a failure)', async () => {
      routes();
      h.upstream.route('GET', '/forces/leicestershire', plainNotFound);
      const out = data(await call({ ...BY_ID }));
      expect(out.force).toEqual({ id: 'leicestershire', name: 'Leicestershire Police' });
      expect(out.notice).toBeUndefined();
    });

    it('takes the force name from the force detail, with no notice, when the force list fails on a point lookup', async () => {
      routes();
      h.upstream.route('GET', '/forces', status(500));
      const out = data(await call({ ...POINT }));
      expect(out.found).toBe(true);
      expect(out.force).toEqual({
        id: 'leicestershire',
        name: 'Leicestershire Police',
        url: 'https://www.example-force.police.test',
        telephone: '101',
      });
      expect(out.neighbourhood?.name).toBe('Example Central');
      expect(out.priorities).toBeDefined();
      expect(out.notice).toBeUndefined();
    });

    it.each<[string, Responder]>([
      ['fails', status(500)],
      ['misses', plainNotFound],
    ])(
      'names the force by its id and says force details could not load when the force list fails and the force detail %s',
      async (_name, detail) => {
        routes();
        h.upstream.route('GET', '/forces', status(500));
        h.upstream.route('GET', '/forces/leicestershire', detail);
        const result = await call({ ...POINT });
        const out = data(result);
        expect(out.found).toBe(true);
        expect(out.force).toEqual({ id: 'leicestershire', name: 'leicestershire' });
        expect(out.notice).toBe(COULD_NOT('force details'));
        expect(text(result).match(/Could not load/g)).toHaveLength(1);
      },
    );

    it.each<[string, Responder]>([
      ['a 429', rateLimited('60')],
      ['a 404', plainNotFound],
      ['an HTML 200 body', htmlOk],
      ['a 400', htmlBadRequest],
      ['an upstream that never answers', hang],
      ['a body of the wrong shape', jsonOk({ nope: true })],
      ['a person without a rank', jsonOk([{ name: 'Example Officer' }])],
    ])('degrades the team section on %s rather than failing the call', async (_name, responder) => {
      routes();
      h.upstream.route('GET', `${P}/people`, responder);
      const out = data(await call({ ...BY_ID }));
      expect(out.found).toBe(true);
      expect(out).not.toHaveProperty('team');
      expect(out.notice).toBe(COULD_NOT('team'));
      expect(out.priorities).toBeDefined();
    });

    it('does not mention a section that was not requested, whatever its route does', async () => {
      routes();
      h.upstream.route('GET', `${P}/people`, status(500));
      expect(data(await call({ ...BY_ID, include: ['events'] })).notice).toBeUndefined();
      expect(h.upstream.count(`${P}/people`)).toBe(0);
    });

    it('throws RequestCancelled, not a degraded success, when the signal aborts while sections are hung', async () => {
      routes();
      for (const path of [`${P}/priorities`, `${P}/people`, `${P}/events`]) {
        h.upstream.route('GET', path, hang);
      }
      const controller = new AbortController();
      setTimeout(() => controller.abort(new Error('client went away')), 500);
      const result = await settle(
        runToolContract(
          findNeighbourhoodTool,
          { ...BY_ID },
          { context: { signal: controller.signal } },
        ),
      );
      expect(errorOf(result).code).toBe(JsonRpcErrorCode.RequestCancelled);
    });
  });

  describe('the decisive calls fail the lookup', () => {
    it.each<[string, Responder, number, string | undefined]>([
      ['a persistent 500', status(500), JsonRpcErrorCode.ServiceUnavailable, undefined],
      ['a 429', rateLimited('60'), JsonRpcErrorCode.RateLimited, undefined],
      ['an HTML 200 body', htmlOk, JsonRpcErrorCode.ServiceUnavailable, 'unreadable_response'],
      [
        'a wrong-shape body',
        jsonOk({ nope: true }),
        JsonRpcErrorCode.ServiceUnavailable,
        'unexpected_response',
      ],
      ['an upstream that never answers', hang, JsonRpcErrorCode.Timeout, undefined],
      ['a 400', htmlBadRequest, JsonRpcErrorCode.InvalidParams, undefined],
    ])('fails the point lookup on %s from the locate', async (_name, responder, code, reason) => {
      routes();
      h.upstream.route('GET', '/locate-neighbourhood', responder);
      const error = errorOf(await call({ ...POINT }));
      expect(error.code).toBe(code);
      if (reason) expect(error.data.reason).toBe(reason);
      expect(h.upstream.count(P)).toBe(0);
    });

    it.each<[string, Responder, number, string | undefined]>([
      ['a persistent 500', status(500), JsonRpcErrorCode.ServiceUnavailable, undefined],
      ['a 429', rateLimited('60'), JsonRpcErrorCode.RateLimited, undefined],
      ['an HTML 200 body', htmlOk, JsonRpcErrorCode.ServiceUnavailable, 'unreadable_response'],
      [
        'a body without a name',
        jsonOk({ id: 'NX01' }),
        JsonRpcErrorCode.ServiceUnavailable,
        'unexpected_response',
      ],
      ['an upstream that never answers', hang, JsonRpcErrorCode.Timeout, undefined],
    ])('fails the lookup on %s from the profile', async (_name, responder, code, reason) => {
      routes();
      h.upstream.route('GET', P, responder);
      const error = errorOf(await call({ ...BY_ID }));
      expect(error.code).toBe(code);
      if (reason) expect(error.data.reason).toBe(reason);
    });

    it('does not echo an upstream body in a shape failure', async () => {
      routes();
      h.upstream.route('GET', P, jsonOk({ secret: 'upstream-only-text' }));
      expect(JSON.stringify(await call({ ...BY_ID }))).not.toContain('upstream-only-text');
    });

    it('fails a point lookup whose profile read fails even when the sections loaded', async () => {
      routes();
      h.upstream.route('GET', P, status(502));
      expect(errorOf(await call({ ...POINT })).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    });

    it('fails with RequestCancelled when the signal is already aborted, without a request', async () => {
      routes();
      const controller = new AbortController();
      controller.abort(new Error('client went away'));
      const result = await settle(
        runToolContract(
          findNeighbourhoodTool,
          { ...POINT },
          { context: { signal: controller.signal } },
        ),
      );
      expect(errorOf(result).code).toBe(JsonRpcErrorCode.RequestCancelled);
      expect(h.upstream.calls).toHaveLength(0);
    });
  });

  describe('events', () => {
    it('lists at most 10 events, the earliest first, with events_total giving the full count', async () => {
      routes();
      h.upstream.route('GET', `${P}/events`, jsonOk(manyEvents(12)));
      const result = await call({ ...BY_ID });
      const out = data(result);
      expect(out.events).toHaveLength(10);
      expect(out.events?.map((e) => e.title)).toEqual(
        Array.from({ length: 10 }, (_, i) => `Event ${String(i + 1).padStart(2, '0')}`),
      );
      expect(out.events_total).toBe(12);
      expect(text(result)).toContain('### Upcoming events (10 of 12)');
    });

    it.each<[number, number]>([
      [0, 0],
      [1, 1],
      [10, 10],
      [11, 10],
    ])('with %i events shows %i and counts them all', async (n, shown) => {
      routes();
      h.upstream.route('GET', `${P}/events`, jsonOk(manyEvents(n)));
      const out = data(await call({ ...BY_ID, include: ['events'] }));
      expect(out.events).toHaveLength(shown);
      expect(out.events_total).toBe(n);
    });

    it('sorts undated events after dated ones before the cap, so the cap never drops a dated event for an undated one', async () => {
      routes();
      const undated = Array.from({ length: 5 }, (_, i) => ({
        title: `Undated ${i}`,
        start_date: null,
      }));
      h.upstream.route('GET', `${P}/events`, jsonOk([...undated, ...manyEvents(7)]));
      const out = data(await call({ ...BY_ID, include: ['events'] }));
      expect(out.events?.slice(0, 7).every((e) => e.title.startsWith('Event'))).toBe(true);
      expect(out.events?.slice(7).map((e) => e.title)).toEqual([
        'Undated 0',
        'Undated 1',
        'Undated 2',
      ]);
      expect(out.events_total).toBe(12);
    });

    it('renders the empty list as none published', async () => {
      routes();
      h.upstream.route('GET', `${P}/events`, jsonOk([]));
      const result = await call({ ...BY_ID, include: ['events'] });
      expect(text(result)).toContain('### Upcoming events (0 of 0)\n\n_None published._');
    });
  });

  describe('boundary', () => {
    it('returns the ring as the lat,lng:lat,lng string at six decimals with the vertex count, repeating the first vertex last', async () => {
      routes();
      const result = await call({ ...BY_ID, include: ['boundary'] });
      const out = data(result);
      expect(out.boundary).toEqual({ vertex_count: 5, polygon: BOUNDARY_STRING });
      expect(text(result)).toContain('### Boundary (5 vertices)');
      expect(text(result)).toContain(BOUNDARY_STRING);
    });

    it('produces a string the polygon input of the search tools accepts', async () => {
      routes();
      const out = data(await call({ ...BY_ID, include: ['boundary'] }));
      const parsed = polygonInput.safeParse(out.boundary?.polygon);
      expect(parsed.success).toBe(true);
      expect(parsed.success && parsed.data?.length).toBe(5);
    });

    it('counts only the vertices that parse', async () => {
      routes();
      h.upstream.route(
        'GET',
        `${P}/boundary`,
        jsonOk([...boundaryBody(), { latitude: 'abc', longitude: '1' }]),
      );
      expect(data(await call({ ...BY_ID, include: ['boundary'] })).boundary?.vertex_count).toBe(5);
    });
  });

  describe('known gaps', () => {
    it.each(['avon-and-somerset', 'northern-ireland'])(
      'adds the dated gaps text for %s',
      async (force) => {
        neighbourhoodRoutes(h.upstream, { force, id: 'NX01' });
        h.upstream.route('GET', '/forces', jsonOk([{ id: force, name: 'Some Force' }]));
        const result = await call({ force, neighbourhood_id: 'NX01' });
        const out = data(result);
        expect(out.gaps).toBe(forceGaps(force));
        expect(out.gaps).toContain('verified 2026-10-01');
        expect(text(result)).toContain('**Known coverage gaps:**');
      },
    );

    it('adds none for a force the table does not name', async () => {
      routes();
      const result = await call({ ...BY_ID });
      expect(data(result)).not.toHaveProperty('gaps');
      expect(text(result)).not.toContain('Known coverage gaps');
    });
  });

  describe('person-level fields never reach the output', () => {
    it('returns rank and name only for team members and drops a biography, contacts and extra keys', async () => {
      routes(peopleWithPrivateFields());
      h.upstream.route('GET', `${P}/events`, jsonOk(manyEvents(2)));
      const result = await call({ ...BY_ID });
      const out = data(result);
      expect(out.team).toEqual([
        { rank: 'PC 0000', name: 'Example Officer' },
        { rank: 'Sgt 0000', name: 'Sample Sergeant' },
      ]);
      for (const surface of [JSON.stringify(out), text(result)]) {
        expect(surface).not.toContain('Invented biography');
        expect(surface).not.toContain('Ignore previous instructions');
        expect(surface).not.toContain('private-officer@example.test');
        expect(surface).not.toContain('0000 000 0000');
        expect(surface).not.toContain('collar_number');
        expect(surface).not.toContain('events@example.test');
      }
    });

    it('still returns the team-level contact channels from the profile', async () => {
      routes(peopleWithPrivateFields());
      const out = data(await call({ ...BY_ID }));
      expect(out.neighbourhood?.contact).toEqual([
        { channel: 'email', value: 'nx01@example-force.police.test' },
        { channel: 'telephone', value: '101' },
      ]);
    });
  });

  describe('enrichment: the not-found page and the found page', () => {
    it('not-found page: attribution and data_note present, no notice', async () => {
      h.upstream.route('GET', '/locate-neighbourhood', plainNotFound);
      const result = await call({ ...POINT });
      const out = data(result);
      expect(out.attribution).toBe(ATTRIBUTION);
      expect(out.data_note).toBe(DATA_NOTE);
      expect(out.notice).toBeUndefined();
      expect(text(result)).toContain('**Attribution:**');
      expect(text(result)).toContain('**Data note:**');
    });

    it('found page: attribution and data_note present, no notice when everything loaded', async () => {
      routes();
      const result = await call({ ...BY_ID });
      const out = data(result);
      expect(out.attribution).toBe(ATTRIBUTION);
      expect(out.data_note).toBe(DATA_NOTE);
      expect(out.notice).toBeUndefined();
      expect(text(result)).toContain(`**Attribution:** ${ATTRIBUTION}`);
    });

    it('degraded page: attribution, data_note and the notice', async () => {
      routes();
      h.upstream.route('GET', `${P}/events`, status(500));
      const out = data(await call({ ...BY_ID }));
      expect(out.attribution).toBe(ATTRIBUTION);
      expect(out.data_note).toBe(DATA_NOTE);
      expect(out.notice).toBe(COULD_NOT('events'));
    });

    it('writes attribution then data_note first, and nothing else when nothing failed', async () => {
      routes();
      const ctx = createMockContext({ errors: findNeighbourhoodTool.errors });
      const input = findNeighbourhoodTool.input.parse({ ...BY_ID });
      await settle(Promise.resolve(findNeighbourhoodTool.handler(input, ctx)));
      expect(Object.keys(getEnrichment(ctx))).toEqual(['attribution', 'data_note']);
    });

    it('has both required fields in place before the first thing that can fail', async () => {
      const ctx = createMockContext({ errors: findNeighbourhoodTool.errors });
      const input = findNeighbourhoodTool.input.parse({});
      await expect(
        Promise.resolve(findNeighbourhoodTool.handler(input, ctx)),
      ).rejects.toMatchObject({
        data: { reason: 'invalid_lookup' },
      });
      expect(getEnrichment(ctx)).toEqual({ attribution: ATTRIBUTION, data_note: DATA_NOTE });
    });
  });

  describe('input validation and blank form values', () => {
    it.each<[string, unknown]>([
      ['lat above 90', { lat: 91, lng: LNG }],
      ['lng below -180', { lat: LAT, lng: -181 }],
      ['a string lat', { lat: '52.6', lng: LNG }],
      ['a force with digits', { force: 'force1', neighbourhood_id: 'NX01' }],
      ['a force with a path in it', { force: '../forces', neighbourhood_id: 'NX01' }],
      ['a neighbourhood id with a slash', { ...BY_ID, neighbourhood_id: 'a/b' }],
      ['a neighbourhood id of ..', { ...BY_ID, neighbourhood_id: '..' }],
      ['a neighbourhood id with a hash', { ...BY_ID, neighbourhood_id: 'a#b' }],
      ['a neighbourhood id over 100 characters', { ...BY_ID, neighbourhood_id: 'a'.repeat(101) }],
    ])('rejects %s as InvalidParams without any request', async (_name, input) => {
      const error = errorOf(await callRaw(input));
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(error.data.reason).toBe('invalid_arguments');
      expect(h.upstream.calls).toHaveLength(0);
    });

    it('accepts empty strings, whitespace and null on the optional inputs of the other lookup', async () => {
      routes();
      const byPoint = data(
        await callRaw({ ...POINT, force: '', neighbourhood_id: '  ', include: '' }),
      );
      expect(byPoint.found).toBe(true);
      const byId = data(await callRaw({ ...BY_ID, lat: '', lng: null, include: null }));
      expect(byId.found).toBe(true);
    });
  });

  describe('caching', () => {
    it('caches the locate and the force detail, but not the profile or the sections', async () => {
      routes();
      await call({ ...POINT });
      await call({ ...POINT });
      expect(h.upstream.count('/locate-neighbourhood')).toBe(1);
      expect(h.upstream.count('/forces/leicestershire')).toBe(1);
      expect(h.upstream.count('/forces')).toBe(1);
      for (const path of [P, `${P}/priorities`, `${P}/people`, `${P}/events`]) {
        expect(h.upstream.count(path), path).toBe(2);
      }
    });
  });

  describe('request fan-out', () => {
    it('sends the locate first, then the profile, force detail and sections together rather than one after another', async () => {
      routes();
      for (const path of [P, '/forces/leicestershire', ...SECTION_PATHS.slice(0, 3)]) {
        h.upstream.route(
          'GET',
          path,
          delayed(
            1000,
            jsonOk(
              path === P
                ? neighbourhoodDetailBody()
                : path.endsWith('priorities')
                  ? prioritiesBody()
                  : path.startsWith('/forces')
                    ? forceDetailBody()
                    : [],
            ),
          ),
        );
      }
      h.upstream.route('GET', '/locate-neighbourhood', delayed(500, jsonOk(locateBody())));
      const started = Date.now();
      data(await call({ ...POINT }));
      const locate = h.upstream.callsTo('/locate-neighbourhood')[0];
      const profile = h.upstream.callsTo(P)[0];
      expect((profile?.at ?? 0) - (locate?.at ?? 0)).toBeGreaterThanOrEqual(500);
      // Six paced requests of 1 s each, at most four at once: two waves, never six in a row.
      expect(Date.now() - started).toBeLessThan(3500);
    });
  });

  describe('format() matches structuredContent', () => {
    it('renders every field of a full result', async () => {
      routes();
      h.upstream.route('GET', `${P}/events`, jsonOk(manyEvents(3)));
      const result = await call({
        ...POINT,
        include: ['priorities', 'team', 'events', 'boundary'],
      });
      const out = data(result);
      const rendered = text(result);
      expect(rendered).toContain('## Example Central — Leicestershire Police');
      expect(rendered).toContain('**Found:** yes');
      expect(rendered).toContain('**Looked up from:** lat 52.63, lng -1.13');
      expect(rendered).toContain(
        '**Force:** Leicestershire Police (leicestershire) · website https://www.example-force.police.test · telephone 101',
      );
      expect(rendered).toContain(
        '**Neighbourhood id:** NX01 · team page https://www.example-force.police.test/nx01 · population 4200 · published centre 52.635, -1.13',
      );
      expect(rendered).toContain('> An invented neighbourhood.');
      expect(rendered).toContain('- email: nx01@example-force.police.test');
      expect(rendered).toContain('- telephone: 101');
      expect(rendered).toContain('### Links\n\n_None published._');
      expect(rendered).toContain(
        '- Example Central Station · station · 1 Example Street Example Town · EX1 1AA',
      );
      expect(rendered).toContain('### Priorities (1)');
      expect(rendered).toContain(
        '**Issue** (set 2026-07-01T00:00:00):\n> Anti-social behaviour & fly-tipping.',
      );
      expect(rendered).toContain(
        '**Action taken** (2026-08-01T00:00:00):\n> Patrols\n> Community meetings',
      );
      expect(rendered).toContain('### Team (2)');
      for (const member of out.team ?? []) {
        expect(rendered).toContain(`- ${member.rank} — ${member.name}`);
      }
      expect(rendered).toContain('### Upcoming events (3 of 3)');
      for (const event of out.events ?? []) {
        expect(rendered).toContain(
          `**${event.title}** · ${event.type} · starts ${event.start} · ends ${event.end} · ${event.address}`,
        );
        expect(rendered).toContain(`> ${event.description}`);
      }
      expect(rendered).toContain('### Boundary (5 vertices)');
      expect(rendered).toContain(out.boundary?.polygon ?? 'missing');
    });

    it('renders an action date without an action, and none-published markers for empty sections', async () => {
      routes();
      h.upstream.route(
        'GET',
        `${P}/priorities`,
        jsonOk([{ issue: 'Only a date', action: null, 'action-date': '2026-08-01T00:00:00' }]),
      );
      h.upstream.route('GET', `${P}/people`, jsonOk([]));
      h.upstream.route(
        'GET',
        P,
        jsonOk(neighbourhoodDetailBody({ contact_details: {}, locations: [] })),
      );
      const rendered = text(await call({ ...BY_ID }));
      expect(rendered).toContain('**Action recorded:** 2026-08-01T00:00:00');
      expect(rendered).toContain('### Team (0)\n\n_None published._');
      expect(rendered).toContain('### Contact\n\n_None published._');
      expect(rendered).toContain('### Police stations\n\n_None published._');
      h.upstream.route('GET', `${P}/priorities`, jsonOk([]));
      expect(text(await call({ ...BY_ID }))).toContain('### Priorities (0)\n\n_None published._');
    });

    it('ends every quoted block with a blank line, so no server line renders inside it', async () => {
      routes();
      const station = (name: string) => ({ type: 'station', name, description: `${name} hours` });
      h.upstream.route(
        'GET',
        P,
        jsonOk(neighbourhoodDetailBody({ locations: [station('North'), station('South')] })),
      );
      h.upstream.route(
        'GET',
        `${P}/priorities`,
        jsonOk([
          { issue: 'With an action', action: 'Patrols', 'action-date': '2026-08-01T00:00:00' },
          { issue: 'With an action date', action: null, 'action-date': '2026-08-02T00:00:00' },
          { issue: 'Issue only', action: null },
        ]),
      );
      h.upstream.route('GET', `${P}/events`, jsonOk(manyEvents(3)));
      for (const include of [undefined, [], ['priorities'], ['events']] as const) {
        const rendered = text(await call({ ...BY_ID, include: include && [...include] }));
        expect(quoteRunOns(rendered), JSON.stringify(include)).toEqual([]);
      }
      const rendered = text(await call({ ...BY_ID }));
      expect(rendered).toContain('> With an action\n\n**Action taken** (2026-08-01T00:00:00):');
      expect(rendered).toContain(
        '> With an action date\n\n**Action recorded:** 2026-08-02T00:00:00',
      );
      expect(rendered).toContain('  > North hours\n\n- South');
    });

    it('omits the headings of sections that were not loaded', async () => {
      routes();
      const rendered = text(await call({ ...BY_ID, include: [] }));
      for (const heading of ['### Priorities', '### Team', '### Upcoming events', '### Boundary']) {
        expect(rendered).not.toContain(heading);
      }
    });

    it('keeps upstream text verbatim in structuredContent and inert in the markdown', async () => {
      routes();
      h.upstream.route('GET', P, jsonOk(hostileDetailBody()));
      h.upstream.route(
        'GET',
        `${P}/people`,
        jsonOk([{ name: 'Evil\r\n# Injected [x](https://evil.test)', rank: 'PC\u202E 0000 | x' }]),
      );
      h.upstream.route(
        'GET',
        `${P}/priorities`,
        jsonOk([
          {
            issue: '<p>&lt;script&gt;alert(1)&lt;/script&gt; [x](https://evil.test)</p>',
            action: null,
          },
        ]),
      );
      h.upstream.route(
        'GET',
        `${P}/events`,
        jsonOk([
          {
            title: 'Event\r\n# Injected',
            type: 'a|b',
            start_date: '2026-09-15T18:00:00',
            address: 'Hall\nStreet',
            description: '<p>Desc\u2028# Heading\u2029more</p>',
          },
        ]),
      );
      const result = await call({ ...BY_ID });
      const out = data(result);
      expect(out.neighbourhood?.name).toBe(
        'Evil\r\n# Injected | cell [x](https://evil.test) <b>\u202Etxt',
      );
      expect(out.neighbourhood?.stations[0]?.address).toBe('Line 1\r\nLine 2 | pipe');
      expect(out.team?.[0]?.name).toBe('Evil\r\n# Injected [x](https://evil.test)');
      expect(out.priorities?.[0]?.issue).toBe('<script>alert(1)</script> [x](https://evil.test)');
      const rendered = text(result);
      for (const char of ['\r', '\u2028', '\u2029', '\u0085', '\u202E']) {
        expect(rendered.includes(char), JSON.stringify(char)).toBe(false);
      }
      for (const line of rendered.split('\n')) expect(line.startsWith('# '), line).toBe(false);
      expect(rendered).toContain(
        '## Evil # Injected | cell \\[x\\](https://evil.test) \\<b\\>txt — Leicestershire Police',
      );
      expect(rendered).toContain('> \\[link\\](https://evil.test) \\<img src=x\\>');
      expect(rendered).toContain('- a@example.test # Injected'.replace('- ', '- email: '));
      expect(rendered).toContain('- website: https://example.test/a%20b%5B1%5D%3Cx%3E');
      expect(rendered).toContain(
        '- Title with break: https://example.test/path%20with%20space%5B1%5D%3Cx%3E — Desc # Injected',
      );
      expect(rendered).toContain('- Evil Station · station · Line 1 Line 2 | pipe · EX1 1AA');
      expect(rendered).toContain(
        '  > Open 9\n  > 5\n  > Closed\n  > Sundays \\[x\\](https://evil.test)',
      );
      expect(rendered).toContain('- PC 0000 | x — Evil # Injected \\[x\\](https://evil.test)');
      expect(rendered).toContain('> \\<script\\>alert(1)\\</script\\> \\[x\\](https://evil.test)');
      expect(rendered).toContain(
        '- **Event # Injected** · a|b · starts 2026-09-15T18:00:00 · Hall Street',
      );
      expect(rendered).toContain('  > Desc # Heading more');
    });

    it('prints force and team-page urls as plain text, never as links', async () => {
      routes();
      h.upstream.route(
        'GET',
        '/forces/leicestershire',
        jsonOk(forceDetailBody({ url: 'https://example.test/a b[1]<x>' })),
      );
      const rendered = text(await call({ ...BY_ID }));
      expect(rendered).toContain('website https://example.test/a%20b%5B1%5D%3Cx%3E');
      expect(rendered).not.toMatch(/\]\(https?:/);
    });
  });
});
