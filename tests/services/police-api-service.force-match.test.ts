/**
 * @fileoverview Force matching over the full `/forces` list (44 forces, plus
 * `btp`): `forceInput` then `PoliceApiService.findForce`, as every `force` input
 * runs them. Every id and display name, with and without its suffix and in the
 * spellings people use, reaches its own force; and a differential against the
 * id-only matcher shipped before display names (0.1.1) shows no input it
 * resolved now resolves to a different force.
 * @module tests/services/police-api-service.force-match.test
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { forceInput } from '@/mcp-server/tools/shared-schemas.js';
import { BTP_FORCE } from '@/services/police-api/police-api-service.js';
import type { Force } from '@/services/police-api/types.js';
import { allForcesBody, jsonOk } from '../fixtures/police-api-upstream.js';
import { settle, useServiceHarness } from '../fixtures/service-harness.js';

const FORCES: readonly Force[] = [...allForcesBody(), BTP_FORCE];

type Resolution = string | 'rejected' | 'unknown';

/**
 * The matcher the server shipped before display names, pinned from 0.1.1: the
 * schema trimmed, lower-cased and folded runs of whitespace and `_` to `-`,
 * required `^[a-z]+(-[a-z]+)*$` (at most 100 characters), and the handler
 * accepted an exact id only, `btp` where allowed.
 */
function idOnly(input: string, allowBtp: boolean): Resolution {
  const folded = input
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
  if (folded.length > 100 || !/^[a-z]+(-[a-z]+)*$/.test(folded)) return 'rejected';
  if (folded === BTP_FORCE.id) return allowBtp ? BTP_FORCE.id : 'unknown';
  return FORCES.some((force) => force.id === folded) ? folded : 'unknown';
}

/** A display name without its trailing suffix: `Leicestershire Police` → `Leicestershire`. */
const withoutSuffix = (name: string): string =>
  name.replace(/\s+(Police Service|Police|Constabulary)$/, '');

/** The spellings of one force people and models send, each meant to reach that force. */
function spellings(force: Force): string[] {
  const bare = withoutSuffix(force.name);
  return [
    ...new Set([
      force.id,
      force.name,
      force.id.toUpperCase(),
      force.name.toLowerCase(),
      force.name.toUpperCase(),
      `  ${force.name}  `,
      force.id.replaceAll('-', ' '),
      force.id.replaceAll('-', '_'),
      force.id.replaceAll('-', '--'),
      force.id.replaceAll('-', ' - '),
      force.name.replaceAll(' ', '_'),
      force.name.replaceAll(' and ', ' & '),
      force.name.replaceAll('&', 'and'),
      bare,
      `${bare} Police`,
      `${bare} Constabulary`,
      `${bare} Police Service`,
      `${force.id} police`,
      `${force.id} constabulary`,
    ]),
  ];
}

/** Forms the schema refuses, today as before: digits, path and query characters, accents, edge hyphens. */
const refusedForms = (force: Force): string[] => [
  `${force.id}1`,
  `${force.id}/neighbourhoods`,
  `${force.id}.`,
  `${force.id}?x=1`,
  `-${force.id}`,
  `${force.id}-`,
];

/** Inputs that name no force: informal aliases, a lone suffix, a force outside the API. */
const UNMATCHED = [
  'the Met',
  'GMP',
  'PSNI',
  'Police',
  'Police Service',
  'Constabulary',
  'Police Scotland',
  'atlantis',
];

describe('force matching over the full force list', () => {
  const h = useServiceHarness();

  beforeEach(async () => {
    h.upstream.route('GET', '/forces', jsonOk(allForcesBody()));
    // Read the list once on the virtual clock; every match after it is answered from the cache.
    await settle(h.service.getForces(h.ctx, h.budget()));
  });

  /** Runs one input the way a `force` field does: the schema, then the matcher. */
  async function resolve(input: string, allowBtp: boolean): Promise<Resolution> {
    const parsed = forceInput.safeParse(input);
    if (!parsed.success || parsed.data === undefined) return 'rejected';
    const match = await h.service.findForce(parsed.data, h.ctx, h.budget(), { allowBtp });
    return match.kind === 'found' ? match.force.id : 'unknown';
  }

  it('holds the 44 listed forces, and btp beside them', () => {
    expect(allForcesBody()).toHaveLength(44);
    expect(new Set(FORCES.map((force) => force.id)).size).toBe(45);
  });

  it.each(FORCES.map((force) => [force.id, force] as const))(
    'reaches %s from its id, its display name and every spelling of either',
    async (_id, force) => {
      for (const spelling of spellings(force)) {
        expect(await resolve(spelling, true), JSON.stringify(spelling)).toBe(force.id);
      }
    },
  );

  it('keeps refusing digits, path and query characters, accents and edge hyphens at the schema', async () => {
    for (const force of FORCES) {
      for (const form of refusedForms(force)) {
        expect(await resolve(form, true), JSON.stringify(form)).toBe('rejected');
      }
    }
    expect(await resolve('dyfed-pówys', true)).toBe('rejected');
  });

  it.each(UNMATCHED)('matches nothing for %j', async (input) => {
    expect(await resolve(input, true)).toBe('unknown');
  });

  it('refuses btp, under any spelling, where btp is not accepted', async () => {
    for (const spelling of spellings(BTP_FORCE)) {
      expect(await resolve(spelling, false), JSON.stringify(spelling)).toBe('unknown');
    }
  });

  it.each([true, false])(
    'changes no input the id-only matcher resolved, and resolves the rest only to the force meant (allowBtp %s)',
    async (allowBtp) => {
      const cases = FORCES.flatMap((force) => [
        ...spellings(force).map((input) => ({ input, meant: force.id as string | undefined })),
        ...refusedForms(force).map((input) => ({ input, meant: undefined })),
      ]).concat(UNMATCHED.map((input) => ({ input, meant: undefined })));
      const tally = { inputs: 0, resolvedBefore: 0, resolvedNow: 0, changed: 0, gained: 0 };
      for (const { input, meant } of cases) {
        const before = idOnly(input, allowBtp);
        const now = await resolve(input, allowBtp);
        const resolvedBefore = before !== 'rejected' && before !== 'unknown';
        const resolvedNow = now !== 'rejected' && now !== 'unknown';
        tally.inputs += 1;
        if (resolvedBefore) tally.resolvedBefore += 1;
        if (resolvedNow) tally.resolvedNow += 1;
        if (resolvedBefore && now !== before) tally.changed += 1;
        if (!resolvedBefore && resolvedNow) {
          tally.gained += 1;
          expect(now, JSON.stringify(input)).toBe(meant);
        }
      }
      expect(tally.changed).toBe(0);
      // 568 spellings, 270 refused forms and 8 unmatched inputs; without btp, its 12 spellings resolve to nothing.
      expect(tally).toEqual(
        allowBtp
          ? { inputs: 846, resolvedBefore: 160, resolvedNow: 568, changed: 0, gained: 408 }
          : { inputs: 846, resolvedBefore: 158, resolvedNow: 556, changed: 0, gained: 398 },
      );
    },
  );
});
