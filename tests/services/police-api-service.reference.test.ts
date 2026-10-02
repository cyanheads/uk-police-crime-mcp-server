/**
 * @fileoverview PoliceApiService reference and lookup methods: availability,
 * month resolution (with its throttled re-check), forces, matching one by id or
 * display name, and BTP handling,
 * categories, force detail, neighbourhood lists, locate and boundary, plus
 * `parseUpstream` and the request each generic area query builds. Each method
 * is exercised against fixture bodies shaped like the API Reference, including
 * sparse and malformed ones.
 * @module tests/services/police-api-service.reference.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { BTP_FORCE, parseUpstream } from '@/services/police-api/police-api-service.js';
import {
  boundaryBody,
  EARLIEST_MONTH,
  emptyNotFound,
  forceDetailBody,
  forcesBody,
  jsonOk,
  LATEST_MONTH,
  lastUpdatedBody,
  locateBody,
  neighbourhoodsBody,
  plainNotFound,
  sequence,
  status,
  streetDatesBody,
} from '../fixtures/police-api-upstream.js';
import { settle, useServiceHarness } from '../fixtures/service-harness.js';

async function failure(promise: Promise<unknown>): Promise<McpError> {
  const error = await settle(promise).then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(McpError);
  return error as McpError;
}

describe('parseUpstream', () => {
  const Schema = z.object({ id: z.string(), n: z.number() });

  it('returns the parsed data, stripping keys the schema does not read', () => {
    expect(parseUpstream(Schema, { id: 'a', n: 1, bio: 'unread' }, '/x')).toEqual({
      id: 'a',
      n: 1,
    });
  });

  it('throws a non-retryable ServiceUnavailable naming the route on a shape mismatch', () => {
    let thrown: unknown;
    try {
      parseUpstream(Schema, { id: 5 }, '/forces/x');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(McpError);
    const error = thrown as McpError;
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.message).toContain('/forces/x');
    expect(error.data).toMatchObject({ reason: 'unexpected_response', retryable: false });
    expect((error.data as { issues: string[] }).issues).toEqual([
      expect.stringMatching(/^id: /),
      expect.stringMatching(/^n: /),
    ]);
  });
});

describe('PoliceApiService reference methods', () => {
  const h = useServiceHarness();

  describe('getAvailability', () => {
    it('returns the window and every month newest first, with each month stop-and-search publishers', async () => {
      const availability = await settle(h.service.getAvailability(h.ctx, h.budget()));
      expect(availability.latest).toBe(LATEST_MONTH);
      expect(availability.earliest).toBe(EARLIEST_MONTH);
      expect(availability.months).toHaveLength(36);
      expect(availability.months[0]).toEqual({
        month: LATEST_MONTH,
        stopSearchForces: ['leicestershire', 'btp'],
      });
      expect(availability.months.at(-1)?.month).toBe(EARLIEST_MONTH);
    });

    it('derives latest, earliest and ordering from the dates, not from upstream order', async () => {
      h.upstream.route(
        'GET',
        '/crimes-street-dates',
        jsonOk([
          { date: '2026-06', 'stop-and-search': ['a'] },
          { date: '2026-08', 'stop-and-search': [] },
          { date: '2026-07', 'stop-and-search': ['a', 'b'] },
        ]),
      );
      const availability = await settle(h.service.getAvailability(h.ctx, h.budget()));
      expect(availability.latest).toBe('2026-08');
      expect(availability.earliest).toBe('2026-06');
      expect(availability.months).toEqual([
        { month: '2026-08', stopSearchForces: [] },
        { month: '2026-07', stopSearchForces: ['a', 'b'] },
        { month: '2026-06', stopSearchForces: ['a'] },
      ]);
    });

    it('handles a single published month', async () => {
      h.upstream.route(
        'GET',
        '/crimes-street-dates',
        jsonOk([{ date: '2026-08', 'stop-and-search': [] }]),
      );
      const availability = await settle(h.service.getAvailability(h.ctx, h.budget()));
      expect(availability).toEqual({
        latest: '2026-08',
        earliest: '2026-08',
        months: [{ month: '2026-08', stopSearchForces: [] }],
      });
    });

    it.each([
      ['an empty list', []],
      ['a month in the wrong form', [{ date: '2026-8', 'stop-and-search': [] }]],
      ['a missing stop-and-search list', [{ date: '2026-08' }]],
      ['an object where a list is expected', { date: '2026-08' }],
    ])('fails %s as unexpected_response without retrying', async (_name, body) => {
      h.upstream.route('GET', '/crimes-street-dates', jsonOk(body));
      const error = await failure(h.service.getAvailability(h.ctx, h.budget()));
      expect(error.data).toMatchObject({ reason: 'unexpected_response', retryable: false });
      expect(h.upstream.count('/crimes-street-dates')).toBe(1);
    });
  });

  describe('resolveMonth', () => {
    it('defaults an omitted month to the latest, flagged as defaulted', async () => {
      const resolution = await settle(h.service.resolveMonth(undefined, h.ctx, h.budget()));
      expect(resolution).toMatchObject({ kind: 'ok', month: LATEST_MONTH, defaulted: true });
    });

    it.each([EARLIEST_MONTH, '2025-01', LATEST_MONTH])(
      'accepts %s inside the window',
      async (month) => {
        const resolution = await settle(h.service.resolveMonth(month, h.ctx, h.budget()));
        expect(resolution).toMatchObject({ kind: 'ok', month, defaulted: false });
        expect(h.upstream.count('/crime-last-updated')).toBe(0);
      },
    );

    it('answers out_of_range for a month before the window, without re-checking', async () => {
      const resolution = await settle(h.service.resolveMonth('2023-08', h.ctx, h.budget()));
      expect(resolution).toMatchObject({ kind: 'out_of_range', month: '2023-08' });
      expect(resolution.availability.earliest).toBe(EARLIEST_MONTH);
      expect(h.upstream.count('/crime-last-updated')).toBe(0);
    });

    it('re-checks /crime-last-updated for a month newer than the cached latest, and answers not_published when it has not moved', async () => {
      const resolution = await settle(h.service.resolveMonth('2026-09', h.ctx, h.budget()));
      expect(resolution).toMatchObject({ kind: 'not_published', month: '2026-09' });
      expect(h.upstream.count('/crime-last-updated')).toBe(1);
      expect(h.upstream.count('/crimes-street-dates')).toBe(1);
    });

    it('re-checks at most once a minute', async () => {
      await settle(h.service.resolveMonth('2026-09', h.ctx, h.budget()));
      await vi.advanceTimersByTimeAsync(59_000);
      await settle(h.service.resolveMonth('2026-10', h.ctx, h.budget()));
      expect(h.upstream.count('/crime-last-updated')).toBe(1);
      await vi.advanceTimersByTimeAsync(1000);
      await settle(h.service.resolveMonth('2026-10', h.ctx, h.budget()));
      expect(h.upstream.count('/crime-last-updated')).toBe(2);
    });

    it('refreshes availability when the re-check shows a newer month, then accepts it', async () => {
      h.upstream.route(
        'GET',
        '/crimes-street-dates',
        sequence(jsonOk(streetDatesBody()), jsonOk(streetDatesBody({ to: '2026-09' }))),
      );
      h.upstream.route('GET', '/crime-last-updated', jsonOk(lastUpdatedBody('2026-09-01')));
      const resolution = await settle(h.service.resolveMonth('2026-09', h.ctx, h.budget()));
      expect(resolution).toMatchObject({ kind: 'ok', month: '2026-09', defaulted: false });
      expect(resolution.availability.latest).toBe('2026-09');
      expect(h.upstream.count('/crimes-street-dates')).toBe(2);
    });

    it('still answers not_published when availability, once refreshed, lacks the month', async () => {
      h.upstream.route('GET', '/crime-last-updated', jsonOk(lastUpdatedBody('2026-09-01')));
      const resolution = await settle(h.service.resolveMonth('2026-10', h.ctx, h.budget()));
      expect(resolution).toMatchObject({ kind: 'not_published', month: '2026-10' });
      expect(h.upstream.count('/crimes-street-dates')).toBe(2);
    });

    it('does not refresh availability when the re-check names the month already cached', async () => {
      h.upstream.route('GET', '/crime-last-updated', jsonOk(lastUpdatedBody('2026-08-01')));
      await settle(h.service.resolveMonth('2026-09', h.ctx, h.budget()));
      expect(h.upstream.count('/crimes-street-dates')).toBe(1);
    });

    it('surfaces a re-check failure rather than guessing', async () => {
      h.upstream.route('GET', '/crime-last-updated', emptyNotFound);
      const error = await failure(h.service.resolveMonth('2026-09', h.ctx, h.budget()));
      expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    });

    it('re-checks again on the next call after a failed re-check, within the minute', async () => {
      h.upstream.route(
        'GET',
        '/crimes-street-dates',
        sequence(jsonOk(streetDatesBody()), jsonOk(streetDatesBody({ to: '2026-09' }))),
      );
      h.upstream.route(
        'GET',
        '/crime-last-updated',
        sequence(emptyNotFound, jsonOk(lastUpdatedBody('2026-09-01'))),
      );
      await failure(h.service.resolveMonth('2026-09', h.ctx, h.budget()));
      await vi.advanceTimersByTimeAsync(5000);
      const resolution = await settle(h.service.resolveMonth('2026-09', h.ctx, h.budget()));
      expect(resolution).toMatchObject({ kind: 'ok', month: '2026-09' });
      expect(h.upstream.count('/crime-last-updated')).toBe(2);
    });

    it('fails an unexpected re-check body as unexpected_response', async () => {
      h.upstream.route('GET', '/crime-last-updated', jsonOk({ date: 'soon' }));
      const error = await failure(h.service.resolveMonth('2026-09', h.ctx, h.budget()));
      expect(error.data).toMatchObject({ reason: 'unexpected_response' });
    });
  });

  describe('forces', () => {
    it('lists the forces upstream names, without btp', async () => {
      const forces = await settle(h.service.getForces(h.ctx, h.budget()));
      expect(forces).toEqual(forcesBody());
      expect(forces.map((force) => force.id)).not.toContain('btp');
    });

    it('strips fields the server does not read', async () => {
      h.upstream.route(
        'GET',
        '/forces',
        jsonOk([{ id: 'leicestershire', name: 'Leicestershire Police', extra: 1 }]),
      );
      expect(await settle(h.service.getForces(h.ctx, h.budget()))).toEqual([
        { id: 'leicestershire', name: 'Leicestershire Police' },
      ]);
    });

    it('fails a force without a name as unexpected_response', async () => {
      h.upstream.route('GET', '/forces', jsonOk([{ id: 'leicestershire' }]));
      const error = await failure(h.service.getForces(h.ctx, h.budget()));
      expect(error.data).toMatchObject({ reason: 'unexpected_response' });
    });

    const BTP_REFUSED = {
      kind: 'unknown',
      message: 'British Transport Police has no neighbourhoods.',
    } as const;

    it('findForce finds a listed force by id, and names an unknown one', async () => {
      const options = { allowBtp: false };
      expect(
        await settle(h.service.findForce('leicestershire', h.ctx, h.budget(), options)),
      ).toEqual({ kind: 'found', force: { id: 'leicestershire', name: 'Leicestershire Police' } });
      expect(await settle(h.service.findForce('atlantis', h.ctx, h.budget(), options))).toEqual({
        kind: 'unknown',
        message: "No police force 'atlantis'.",
      });
    });

    it.each([
      ['leicestershire-police', 'leicestershire'],
      ['metropolitan-police', 'metropolitan'],
      ['metropolitan-police-service', 'metropolitan'],
      ['devon-and-cornwall-police', 'devon-and-cornwall'],
      ['avon-and-somerset-constabulary', 'avon-and-somerset'],
      ['police-service-of-northern-ireland', 'northern-ireland'],
      ['Dyfed-Powys Police', 'dyfed-powys'],
    ])('findForce matches the display-name form %j to %s', async (input, id) => {
      const match = await settle(
        h.service.findForce(input, h.ctx, h.budget(), { allowBtp: false }),
      );
      expect(match).toMatchObject({ kind: 'found', force: { id } });
    });

    it('findForce answers btp only where the caller allows it, without asking upstream', async () => {
      expect(
        await settle(h.service.findForce('btp', h.ctx, h.budget(), { allowBtp: true })),
      ).toEqual({ kind: 'found', force: BTP_FORCE });
      expect(
        await settle(h.service.findForce('btp', h.ctx, h.budget(), { allowBtp: false })),
      ).toEqual(BTP_REFUSED);
      expect(h.upstream.count('/forces')).toBe(0);
    });

    it('findForce matches British Transport Police to btp, refused by the same gate', async () => {
      expect(
        await settle(
          h.service.findForce('british-transport-police', h.ctx, h.budget(), { allowBtp: true }),
        ),
      ).toEqual({ kind: 'found', force: BTP_FORCE });
      expect(
        await settle(
          h.service.findForce('british-transport-police', h.ctx, h.budget(), { allowBtp: false }),
        ),
      ).toEqual(BTP_REFUSED);
    });

    it('does not let a listed force named btp through allowBtp: false', async () => {
      h.upstream.route('GET', '/forces', jsonOk([{ id: 'btp', name: 'Listed BTP' }]));
      expect(
        await settle(h.service.findForce('btp', h.ctx, h.budget(), { allowBtp: false })),
      ).toEqual(BTP_REFUSED);
    });

    it('findForce picks neither force when a name key is shared, naming both ids', async () => {
      h.upstream.route(
        'GET',
        '/forces',
        jsonOk([
          { id: 'northshire', name: 'Southshire Police' },
          { id: 'southshire', name: 'Southshire Constabulary' },
        ]),
      );
      expect(
        await settle(
          h.service.findForce('southshire-police', h.ctx, h.budget(), { allowBtp: true }),
        ),
      ).toEqual({
        kind: 'unknown',
        message:
          "'southshire-police' matches more than one police force: 'northshire', 'southshire'; send one of their ids.",
      });
      // An exact id is matched first, so the id itself is never ambiguous.
      expect(
        await settle(h.service.findForce('southshire', h.ctx, h.budget(), { allowBtp: true })),
      ).toMatchObject({ kind: 'found', force: { id: 'southshire' } });
    });

    it('findForce matches an exact id before any name', async () => {
      h.upstream.route(
        'GET',
        '/forces',
        jsonOk([
          { id: 'kent', name: 'Medway Police' },
          { id: 'medway', name: 'Kent Police' },
        ]),
      );
      expect(
        await settle(h.service.findForce('kent', h.ctx, h.budget(), { allowBtp: true })),
      ).toMatchObject({ kind: 'found', force: { id: 'kent' } });
    });

    it('exports btp as British Transport Police', () => {
      expect(BTP_FORCE).toEqual({ id: 'btp', name: 'British Transport Police' });
    });
  });

  describe('categories', () => {
    it('maps the upstream url to slug and keeps all 15 including all-crime', async () => {
      const categories = await settle(h.service.getCategories(h.ctx, h.budget()));
      expect(categories).toHaveLength(15);
      expect(categories[0]).toEqual({ slug: 'all-crime', name: 'All crime' });
      expect(categories).toContainEqual({
        slug: 'violent-crime',
        name: 'Violence and sexual offences',
      });
      expect(Object.keys(categories[0] ?? {}).sort()).toEqual(['name', 'slug']);
    });

    it('fails a category without a url as unexpected_response', async () => {
      h.upstream.route('GET', '/crime-categories', jsonOk([{ name: 'Burglary' }]));
      const error = await failure(h.service.getCategories(h.ctx, h.budget()));
      expect(error.data).toMatchObject({ reason: 'unexpected_response' });
    });

    it.each([
      ['a slug', 'burglary', 'burglary'],
      ['the all-crime slug', 'all-crime', 'all-crime'],
      ['a lower-cased display name', 'violence and sexual offences', 'violent-crime'],
      ['a display name whose slug differs', 'criminal damage and arson', 'criminal-damage-arson'],
      ['a display name with runs of spaces', 'violence   and  sexual offences', 'violent-crime'],
      ['a display name that is also a phrase', 'all crime', 'all-crime'],
      ['a slug written with underscores', 'vehicle_crime', 'vehicle-crime'],
      ['a slug written with spaces', 'anti social behaviour', 'anti-social-behaviour'],
      ['a display name written with hyphens', 'violence-and-sexual-offences', 'violent-crime'],
      ['mixed runs of spaces, underscores and hyphens', 'vehicle _-crime', 'vehicle-crime'],
    ])('findCategory matches %s', async (_name, input, slug) => {
      const found = await settle(h.service.findCategory(input, h.ctx, h.budget()));
      expect(found?.slug).toBe(slug);
    });

    it('findCategory matches an upstream display name that has irregular whitespace', async () => {
      h.upstream.route(
        'GET',
        '/crime-categories',
        jsonOk([{ url: 'violent-crime', name: 'Violence  and Sexual   Offences' }]),
      );
      const found = await settle(
        h.service.findCategory('violence and sexual offences', h.ctx, h.budget()),
      );
      expect(found?.slug).toBe('violent-crime');
    });

    it('findCategory resolves every slug and display name, in hyphen, underscore and space spellings, to its own category (no two fold to one form)', async () => {
      const categories = await settle(h.service.getCategories(h.ctx, h.budget()));
      expect(categories).toHaveLength(15);
      for (const { slug, name } of categories) {
        for (const form of [slug, name]) {
          const words = form.toLowerCase().split(/[\s-]+/);
          for (const spelling of [words.join('-'), words.join('_'), words.join(' ')]) {
            const found = await settle(h.service.findCategory(spelling, h.ctx, h.budget()));
            expect(found?.slug, `${JSON.stringify(spelling)} should resolve to ${slug}`).toBe(slug);
          }
        }
      }
    });

    it.each(['arson', 'violent', '', 'all-crimes', 'theft'])(
      'findCategory returns undefined for %j, never widening to all crime',
      async (input) => {
        expect(await settle(h.service.findCategory(input, h.ctx, h.budget()))).toBeUndefined();
      },
    );
  });

  describe('getForceDetail', () => {
    it('keeps id, name, url and telephone and drops everything else', async () => {
      h.upstream.route('GET', '/forces/leicestershire', jsonOk(forceDetailBody()));
      const lookup = await settle(h.service.getForceDetail('leicestershire', h.ctx, h.budget()));
      expect(lookup).toEqual({
        kind: 'found',
        value: {
          id: 'leicestershire',
          name: 'Leicestershire Police',
          url: 'https://www.example-force.police.test',
          telephone: '101',
        },
      });
    });

    it('trims url and telephone', async () => {
      h.upstream.route(
        'GET',
        '/forces/leicestershire',
        jsonOk(
          forceDetailBody({ url: '  https://www.example-force.police.test  ', telephone: ' 101 ' }),
        ),
      );
      const lookup = await settle(h.service.getForceDetail('leicestershire', h.ctx, h.budget()));
      expect(lookup).toMatchObject({
        value: { url: 'https://www.example-force.police.test', telephone: '101' },
      });
    });

    it.each([
      'javascript:alert(1)',
      'data:text/html,<b>x</b>',
      '/relative',
      'www.example-force.police.test',
    ])('omits a url that is not http or https: %j', async (url) => {
      h.upstream.route('GET', '/forces/leicestershire', jsonOk(forceDetailBody({ url })));
      const lookup = await settle(h.service.getForceDetail('leicestershire', h.ctx, h.budget()));
      expect(lookup).toEqual({
        kind: 'found',
        value: { id: 'leicestershire', name: 'Leicestershire Police', telephone: '101' },
      });
    });

    it.each([
      ['null', null],
      ['an empty string', ''],
      ['whitespace', '   '],
    ])('omits url and telephone when they are %s', async (_name, empty) => {
      h.upstream.route(
        'GET',
        '/forces/leicestershire',
        jsonOk(forceDetailBody({ url: empty, telephone: empty })),
      );
      const lookup = await settle(h.service.getForceDetail('leicestershire', h.ctx, h.budget()));
      expect(lookup.kind).toBe('found');
      if (lookup.kind === 'found') {
        expect(Object.keys(lookup.value).sort()).toEqual(['id', 'name']);
      }
    });

    it('omits url and telephone when the upstream leaves the keys out entirely', async () => {
      h.upstream.route(
        'GET',
        '/forces/leicestershire',
        jsonOk({ id: 'leicestershire', name: 'Leicestershire Police' }),
      );
      const lookup = await settle(h.service.getForceDetail('leicestershire', h.ctx, h.budget()));
      expect(lookup).toEqual({
        kind: 'found',
        value: { id: 'leicestershire', name: 'Leicestershire Police' },
      });
    });

    it.each([
      ['an empty-body 404', emptyNotFound],
      ['a text/plain Not Found', plainNotFound],
    ])('answers a miss for %s (an unknown force, or btp)', async (_name, respond) => {
      h.upstream.route('GET', '/forces/btp', respond);
      expect(await settle(h.service.getForceDetail('btp', h.ctx, h.budget()))).toEqual({
        kind: 'miss',
      });
    });

    it('caches the miss as it caches a hit', async () => {
      h.upstream.route('GET', '/forces/btp', plainNotFound);
      await settle(h.service.getForceDetail('btp', h.ctx, h.budget()));
      await settle(h.service.getForceDetail('btp', h.ctx, h.budget()));
      expect(h.upstream.count('/forces/btp')).toBe(1);
    });

    it('does not cache a failure', async () => {
      h.upstream.route(
        'GET',
        '/forces/leicestershire',
        sequence(status(500), status(500), status(500), jsonOk(forceDetailBody())),
      );
      await failure(h.service.getForceDetail('leicestershire', h.ctx, h.budget()));
      const lookup = await settle(h.service.getForceDetail('leicestershire', h.ctx, h.budget()));
      expect(lookup.kind).toBe('found');
    });

    it('fails an unexpected body as unexpected_response', async () => {
      h.upstream.route('GET', '/forces/leicestershire', jsonOk({ name: 'No id' }));
      const error = await failure(h.service.getForceDetail('leicestershire', h.ctx, h.budget()));
      expect(error.data).toMatchObject({ reason: 'unexpected_response' });
    });

    it('percent-encodes the id in the path', async () => {
      h.upstream.route('GET', '/forces/a%20b%2Fc', plainNotFound);
      await settle(h.service.getForceDetail('a b/c', h.ctx, h.budget()));
      expect(h.upstream.count('/forces/a%20b%2Fc')).toBe(1);
    });
  });

  describe('getNeighbourhoods', () => {
    it('returns ids and names in upstream order', async () => {
      h.upstream.route('GET', '/leicestershire/neighbourhoods', jsonOk(neighbourhoodsBody()));
      const lookup = await settle(h.service.getNeighbourhoods('leicestershire', h.ctx, h.budget()));
      expect(lookup).toEqual({ kind: 'found', value: neighbourhoodsBody() });
    });

    it('reads a numeric id as its digits', async () => {
      h.upstream.route('GET', '/leicestershire/neighbourhoods', jsonOk([{ id: 7, name: 'Seven' }]));
      const lookup = await settle(h.service.getNeighbourhoods('leicestershire', h.ctx, h.budget()));
      expect(lookup).toEqual({ kind: 'found', value: [{ id: '7', name: 'Seven' }] });
    });

    it('keeps ids case-sensitive and with spaces (Northern Ireland style)', async () => {
      h.upstream.route(
        'GET',
        '/northern-ireland/neighbourhoods',
        jsonOk([{ id: 'Lower Falls', name: 'Lower Falls' }]),
      );
      const lookup = await settle(
        h.service.getNeighbourhoods('northern-ireland', h.ctx, h.budget()),
      );
      expect(lookup).toEqual({
        kind: 'found',
        value: [{ id: 'Lower Falls', name: 'Lower Falls' }],
      });
    });

    it('answers an empty list as found, not a miss', async () => {
      h.upstream.route('GET', '/leicestershire/neighbourhoods', jsonOk([]));
      expect(
        await settle(h.service.getNeighbourhoods('leicestershire', h.ctx, h.budget())),
      ).toEqual({
        kind: 'found',
        value: [],
      });
    });

    it('answers a miss for a 404 and caches it', async () => {
      h.upstream.route('GET', '/atlantis/neighbourhoods', plainNotFound);
      expect(await settle(h.service.getNeighbourhoods('atlantis', h.ctx, h.budget()))).toEqual({
        kind: 'miss',
      });
      await settle(h.service.getNeighbourhoods('atlantis', h.ctx, h.budget()));
      expect(h.upstream.count('/atlantis/neighbourhoods')).toBe(1);
    });

    it('fails a list entry without a name as unexpected_response', async () => {
      h.upstream.route('GET', '/leicestershire/neighbourhoods', jsonOk([{ id: 'NX01' }]));
      const error = await failure(h.service.getNeighbourhoods('leicestershire', h.ctx, h.budget()));
      expect(error.data).toMatchObject({ reason: 'unexpected_response' });
    });
  });

  describe('locate', () => {
    it('sends the point at six decimal places and returns force and neighbourhood', async () => {
      h.upstream.route('GET', '/locate-neighbourhood', jsonOk(locateBody()));
      const lookup = await settle(h.service.locate(52.63, -1.13, h.ctx, h.budget()));
      expect(lookup).toEqual({
        kind: 'found',
        value: { force: 'leicestershire', neighbourhood: 'NX01' },
      });
      expect(h.upstream.callsTo('/locate-neighbourhood')[0]?.query.get('q')).toBe(
        '52.630000,-1.130000',
      );
    });

    it('keys the cache at six decimal places: points that round together share one request', async () => {
      h.upstream.route('GET', '/locate-neighbourhood', jsonOk(locateBody()));
      await settle(h.service.locate(51.5, -0.12, h.ctx, h.budget()));
      await settle(h.service.locate(51.5000001, -0.1200002, h.ctx, h.budget()));
      expect(h.upstream.count('/locate-neighbourhood')).toBe(1);
    });

    it('asks again for a point that differs at the sixth decimal', async () => {
      h.upstream.route('GET', '/locate-neighbourhood', jsonOk(locateBody()));
      await settle(h.service.locate(51.5, -0.12, h.ctx, h.budget()));
      await settle(h.service.locate(51.500001, -0.12, h.ctx, h.budget()));
      expect(h.upstream.count('/locate-neighbourhood')).toBe(2);
    });

    it.each([
      ['an empty-body 404', emptyNotFound],
      ['a text/plain Not Found', plainNotFound],
    ])('answers a miss, cached, for %s (a point outside coverage)', async (_name, respond) => {
      h.upstream.route('GET', '/locate-neighbourhood', respond);
      expect(await settle(h.service.locate(55.86, -4.25, h.ctx, h.budget()))).toEqual({
        kind: 'miss',
      });
      await settle(h.service.locate(55.86, -4.25, h.ctx, h.budget()));
      expect(h.upstream.count('/locate-neighbourhood')).toBe(1);
    });

    it('reads a numeric neighbourhood id as its digits', async () => {
      h.upstream.route('GET', '/locate-neighbourhood', jsonOk(locateBody({ neighbourhood: 42 })));
      const lookup = await settle(h.service.locate(52.63, -1.13, h.ctx, h.budget()));
      expect(lookup).toMatchObject({ value: { neighbourhood: '42' } });
    });

    it('fails a body without a force as unexpected_response', async () => {
      h.upstream.route('GET', '/locate-neighbourhood', jsonOk({ neighbourhood: 'NX01' }));
      const error = await failure(h.service.locate(52.63, -1.13, h.ctx, h.budget()));
      expect(error.data).toMatchObject({ reason: 'unexpected_response' });
    });
  });

  describe('getBoundary', () => {
    it('returns numeric vertices in upstream order, first vertex repeated last', async () => {
      h.upstream.route('GET', '/leicestershire/NX01/boundary', jsonOk(boundaryBody()));
      const lookup = await settle(
        h.service.getBoundary('leicestershire', 'NX01', h.ctx, h.budget()),
      );
      expect(lookup.kind).toBe('found');
      if (lookup.kind !== 'found') return;
      expect(lookup.value).toHaveLength(5);
      expect(lookup.value[0]).toEqual({ latitude: 52.63, longitude: -1.14 });
      expect(lookup.value.at(-1)).toEqual(lookup.value[0]);
      expect(typeof lookup.value[1]?.latitude).toBe('number');
    });

    it('drops vertices whose coordinates do not parse', async () => {
      h.upstream.route(
        'GET',
        '/leicestershire/NX01/boundary',
        jsonOk([
          { latitude: '52.6', longitude: '-1.1' },
          { latitude: 'abc', longitude: '-1.2' },
          { latitude: '52.7', longitude: '' },
          { latitude: '52.8', longitude: '-1.3' },
        ]),
      );
      const lookup = await settle(
        h.service.getBoundary('leicestershire', 'NX01', h.ctx, h.budget()),
      );
      expect(lookup).toEqual({
        kind: 'found',
        value: [
          { latitude: 52.6, longitude: -1.1 },
          { latitude: 52.8, longitude: -1.3 },
        ],
      });
    });

    it('answers a miss for a 404 (an unknown or wrongly cased id) and caches it', async () => {
      h.upstream.route('GET', '/leicestershire/nx01/boundary', plainNotFound);
      expect(
        await settle(h.service.getBoundary('leicestershire', 'nx01', h.ctx, h.budget())),
      ).toEqual({
        kind: 'miss',
      });
      await settle(h.service.getBoundary('leicestershire', 'nx01', h.ctx, h.budget()));
      expect(h.upstream.count('/leicestershire/nx01/boundary')).toBe(1);
    });

    it('keys the cache on force and neighbourhood id, case-sensitively', async () => {
      h.upstream.route('GET', '/leicestershire/NX01/boundary', jsonOk(boundaryBody()));
      h.upstream.route('GET', '/leicestershire/nx01/boundary', plainNotFound);
      await settle(h.service.getBoundary('leicestershire', 'NX01', h.ctx, h.budget()));
      await settle(h.service.getBoundary('leicestershire', 'nx01', h.ctx, h.budget()));
      expect(h.upstream.count('/leicestershire/NX01/boundary')).toBe(1);
      expect(h.upstream.count('/leicestershire/nx01/boundary')).toBe(1);
    });

    it('percent-encodes a neighbourhood id with spaces', async () => {
      h.upstream.route('GET', '/northern-ireland/Lower%20Falls/boundary', jsonOk(boundaryBody()));
      const lookup = await settle(
        h.service.getBoundary('northern-ireland', 'Lower Falls', h.ctx, h.budget()),
      );
      expect(lookup.kind).toBe('found');
    });

    it('cannot be walked up the upstream path by an id containing separators', async () => {
      h.upstream.route('GET', '/leicestershire/..%2Fforces/boundary', plainNotFound);
      await settle(h.service.getBoundary('leicestershire', '../forces', h.ctx, h.budget()));
      expect(h.upstream.calls.map((call) => call.path)).toEqual([
        '/leicestershire/..%2Fforces/boundary',
      ]);
    });

    it('fails a vertex without a longitude as unexpected_response', async () => {
      h.upstream.route('GET', '/leicestershire/NX01/boundary', jsonOk([{ latitude: '52.6' }]));
      const error = await failure(
        h.service.getBoundary('leicestershire', 'NX01', h.ctx, h.budget()),
      );
      expect(error.data).toMatchObject({ reason: 'unexpected_response' });
    });
  });

  describe('queryArea requests', () => {
    const normalize = (json: unknown) => json as readonly number[];

    it('sends a GET with params in the query string, date included, and no body', async () => {
      h.upstream.route('GET', '/crimes-street/burglary', jsonOk([1]));
      await settle(
        h.service.queryArea(
          {
            path: '/crimes-street/burglary',
            params: { lat: '52.630000', lng: '-1.130000', date: '2026-08' },
            normalize,
          },
          h.ctx,
          h.budget(),
        ),
      );
      const [call] = h.upstream.callsTo('/crimes-street/burglary');
      expect(call?.method).toBe('GET');
      expect(call?.body).toBeUndefined();
      expect(Object.fromEntries(call?.query ?? [])).toEqual({
        lat: '52.630000',
        lng: '-1.130000',
        date: '2026-08',
      });
    });

    it('sends a POST as a form body, never in the query string', async () => {
      h.upstream.route('POST', '/crimes-street/all-crime', jsonOk([1]));
      const poly = '52.630000,-1.140000:52.630000,-1.120000:52.640000,-1.120000';
      await settle(
        h.service.queryArea(
          {
            path: '/crimes-street/all-crime',
            method: 'POST',
            params: { poly, date: '2026-08' },
            normalize,
          },
          h.ctx,
          h.budget(),
        ),
      );
      const [call] = h.upstream.callsTo('/crimes-street/all-crime');
      expect(call?.method).toBe('POST');
      expect(call?.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
      expect(call?.headers.get('accept')).toBe('application/json');
      expect(call?.query.size).toBe(0);
      const form = new URLSearchParams(call?.body);
      expect(form.get('poly')).toBe(poly);
      expect(form.get('date')).toBe('2026-08');
    });

    it('passes the parsed JSON to normalize and returns its records', async () => {
      h.upstream.route('GET', '/crimes-street/all-crime', jsonOk([{ n: 1 }, { n: 2 }]));
      const lookup = await settle(
        h.service.queryArea(
          {
            path: '/crimes-street/all-crime',
            params: { date: '2026-08' },
            normalize: (json) => (json as { n: number }[]).map((row) => row.n * 10),
          },
          h.ctx,
          h.budget(),
        ),
      );
      // The body `[{"n":1},{"n":2}]` is 17 bytes, weighing 17 × 1.25.
      expect(lookup).toEqual({ kind: 'found', value: [10, 20], weight: 21.25 });
    });

    it('does not cache a response whose normalizer threw, and does not retry it', async () => {
      h.upstream.route('GET', '/crimes-street/all-crime', jsonOk([1]));
      const query = (fail: boolean) =>
        h.service.queryArea(
          {
            path: '/crimes-street/all-crime',
            params: { date: '2026-08' },
            normalize: (json) => {
              if (fail) throw new Error('bad record');
              return json as number[];
            },
          },
          h.ctx,
          h.budget(),
        );
      await expect(settle(query(true))).rejects.toThrow('bad record');
      expect(h.upstream.count('/crimes-street/all-crime')).toBe(1);
      expect(await settle(query(false))).toEqual({ kind: 'found', value: [1], weight: 3.75 });
      expect(h.upstream.count('/crimes-street/all-crime')).toBe(2);
    });
  });
});
