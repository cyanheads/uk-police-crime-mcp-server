/**
 * @fileoverview ukcrime_list_reference — decodes the vocabulary the other
 * ukcrime tools take: force ids, crime category slugs, a force's neighbourhood
 * ids, and data availability (published months and stop-and-search publishers).
 * @module mcp-server/tools/definitions/list-reference.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { cell, inline } from '@/mcp-server/tools/format-helpers.js';
import {
  ATTRIBUTION,
  forceInput,
  monthInput,
  nameContainsInput,
} from '@/mcp-server/tools/shared-schemas.js';
import { forceGaps } from '@/services/police-api/known-gaps.js';
import { BTP_FORCE, getPoliceApiService } from '@/services/police-api/police-api-service.js';

const TOPICS = ['forces', 'categories', 'availability', 'neighbourhoods'] as const;

const OutputSchema = z.object({
  topic: z.enum(TOPICS).describe('The topic listed; its list field below is the one present.'),
  forces: z
    .array(
      z
        .object({
          id: z.string().describe('Force id the other tools take as force.'),
          name: z.string().describe('Force name as data.police.uk publishes it.'),
          gaps: z
            .string()
            .optional()
            .describe(
              'Known coverage gaps for this force, each ending with the date it was verified against data.police.uk. Absent when none are recorded.',
            ),
        })
        .describe('One police force.'),
    )
    .optional()
    .describe(
      "Topic 'forces': the forces data.police.uk lists, plus British Transport Police ('btp'), which ukcrime_search_stops takes with area 'force' and ukcrime_search_crimes with area 'force_unplaced'.",
    ),
  categories: z
    .array(
      z
        .object({
          slug: z
            .string()
            .describe(
              'Slug the category input takes, e.g. burglary; all-crime means every category.',
            ),
          name: z.string().describe('Display name, also accepted as the category input.'),
        })
        .describe('One crime category.'),
    )
    .optional()
    .describe("Topic 'categories': every crime category."),
  availability: z
    .object({
      latest_month: z
        .string()
        .describe(
          'Newest published month, YYYY-MM — what the search tools use when month is omitted.',
        ),
      earliest_month: z
        .string()
        .describe('Oldest month still served, YYYY-MM (a rolling 36-month window).'),
      months: z
        .array(
          z
            .object({
              month: z.string().describe('Published month, YYYY-MM.'),
              stop_search_forces_published: z
                .number()
                .describe(
                  'Forces, British Transport Police included, that published stop and search for this month.',
                ),
              stop_search_not_published: z
                .array(z.string())
                .describe('Force ids that did not publish stop and search for this month.'),
            })
            .describe('One published month.'),
        )
        .describe(
          'Published months, newest first: one row when month was given, none when it is not published.',
        ),
      force: z
        .string()
        .optional()
        .describe('The force id the next two lists describe, present when force was given.'),
      force_stop_search_published_months: z
        .array(z.string())
        .optional()
        .describe('Months in the listed rows for which this force published stop and search.'),
      force_stop_search_missing_months: z
        .array(z.string())
        .optional()
        .describe(
          'Months in the listed rows for which this force did not publish stop and search.',
        ),
    })
    .optional()
    .describe(
      "Topic 'availability': the published-month window and stop-and-search publication by month.",
    ),
  neighbourhoods: z
    .array(
      z
        .object({
          id: z
            .string()
            .describe('Neighbourhood id the other tools take as neighbourhood_id; case-sensitive.'),
          name: z.string().describe('Neighbourhood name as the force publishes it.'),
        })
        .describe('One neighbourhood.'),
    )
    .optional()
    .describe("Topic 'neighbourhoods': the force's neighbourhoods, sorted by name."),
  force: z
    .string()
    .optional()
    .describe("Topic 'neighbourhoods': the force whose neighbourhoods are listed."),
});

type ListReferenceOutput = z.infer<typeof OutputSchema>;

/** Lower-cases, strips diacritics and punctuation, keeps letters, digits and whitespace. */
const normalizeName = (text: string): string =>
  text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}\s]/gu, '');

/** Strict token match over `name`: every token of `query` must appear. No query keeps every entry. */
function filterByName<T extends { readonly name: string }>(
  entries: readonly T[],
  query: string | undefined,
): readonly T[] {
  if (query === undefined) return entries;
  const tokens = normalizeName(query).split(/\s+/).filter(Boolean);
  return entries.filter((entry) => {
    const haystack = normalizeName(entry.name);
    return tokens.every((token) => haystack.includes(token));
  });
}

export const listReferenceTool = tool('ukcrime_list_reference', {
  title: 'List UK Police Reference Data',
  description:
    "Decode the vocabulary the other ukcrime tools take: police force ids, crime category slugs, a force's neighbourhood ids, and data availability — the published months, and which forces published stop and search in each. Use it when a force, category, neighbourhood id or month is unknown; name_contains filters forces and neighbourhoods by name. The Metropolitan Police has about 680 neighbourhoods, so filter by name there; to get the force and neighbourhood covering a latitude and longitude, call ukcrime_find_neighbourhood instead.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    topic: z
      .enum(TOPICS)
      .describe(
        "What to list: 'forces' (force ids), 'categories' (crime category slugs), 'availability' (published months and stop-and-search publication), or 'neighbourhoods' (one force's neighbourhood ids; needs force).",
      ),
    force: forceInput.describe(
      "Force id such as 'leicestershire'; trimmed, lower-cased, spaces and underscores become hyphens. Required for topic 'neighbourhoods'. On 'availability', where 'btp' (British Transport Police) is also accepted, adds the months this force did and did not publish stop and search. Not accepted on 'forces' or 'categories'.",
    ),
    name_contains: nameContainsInput.describe(
      "Words that must all appear in the name, in any order — case, accents and punctuation ignored, so the value needs at least one letter or digit. Topics 'forces' and 'neighbourhoods' only.",
    ),
    month: monthInput.describe(
      "Month as YYYY-MM. Topic 'availability' only: return just that month's row.",
    ),
  }),
  output: OutputSchema,
  enrichment: {
    attribution: z
      .string()
      .describe('Open Government Licence attribution for data.police.uk data.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Why a list is empty — a name filter that matched nothing, or a month that is not published — and what to do instead.',
      ),
  },
  enrichmentTrailer: { attribution: { label: 'Attribution' } },
  errors: [
    {
      reason: 'force_required',
      code: JsonRpcErrorCode.ValidationError,
      when: "topic 'neighbourhoods' without force",
      recovery:
        "Pass force, for example 'leicestershire'; call ukcrime_list_reference with topic 'forces' for every force id.",
      severity: 'notice',
    },
    {
      reason: 'unknown_force',
      code: JsonRpcErrorCode.ValidationError,
      when: 'force is not in the force list',
      recovery:
        "Call ukcrime_list_reference with topic 'forces' for valid force ids such as 'leicestershire'.",
      severity: 'notice',
    },
    {
      reason: 'invalid_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: "name_contains on 'categories' or 'availability', month off 'availability', or force on 'forces' or 'categories'",
      recovery:
        "Call ukcrime_list_reference again with name_contains only on topic 'forces' or 'neighbourhoods', month only on 'availability', and force only on 'neighbourhoods' or 'availability'.",
      severity: 'notice',
    },
  ],

  async handler(input, ctx) {
    ctx.enrich({ attribution: ATTRIBUTION });
    const { topic, force, month } = input;
    const nameContains = input.name_contains;

    if (nameContains !== undefined && topic !== 'forces' && topic !== 'neighbourhoods') {
      throw ctx.fail('invalid_filter', `name_contains does not apply to topic '${topic}'.`);
    }
    if (month !== undefined && topic !== 'availability') {
      throw ctx.fail(
        'invalid_filter',
        `month applies only to topic 'availability', not '${topic}'.`,
      );
    }
    if (force !== undefined && (topic === 'forces' || topic === 'categories')) {
      throw ctx.fail('invalid_filter', `force does not apply to topic '${topic}'.`);
    }

    const service = getPoliceApiService();
    const budget = service.openBudget();
    const notices: string[] = [];
    let result: ListReferenceOutput;

    if (topic === 'forces') {
      const matches = filterByName(
        [...(await service.getForces(ctx, budget)), BTP_FORCE],
        nameContains,
      );
      if (nameContains !== undefined && matches.length === 0) {
        notices.push(
          `No forces matched "${nameContains}"; call ukcrime_list_reference with topic 'forces' and no name_contains to browse the full list.`,
        );
      }
      result = {
        topic,
        forces: matches.map(({ id, name }) => {
          const gaps = forceGaps(id);
          return { id, name, ...(gaps ? { gaps } : {}) };
        }),
      };
    } else if (topic === 'categories') {
      result = {
        topic,
        categories: (await service.getCategories(ctx, budget)).map(({ slug, name }) => ({
          slug,
          name,
        })),
      };
    } else if (topic === 'availability') {
      const [availability, forces] = await Promise.all([
        service.getAvailability(ctx, budget),
        service.getForces(ctx, budget),
      ]);
      const forceEntry =
        force === undefined
          ? undefined
          : await service.findForce(force, ctx, budget, { allowBtp: true });
      if (force !== undefined && !forceEntry) {
        throw ctx.fail('unknown_force', `No police force '${force}'.`);
      }
      const everyForce = [...forces.map(({ id }) => id), BTP_FORCE.id];
      const rows =
        month === undefined
          ? availability.months
          : availability.months.filter((row) => row.month === month);
      if (month !== undefined && rows.length === 0) {
        notices.push(
          month < availability.earliest || month > availability.latest
            ? `${month} is outside the published window ${availability.earliest}–${availability.latest}.`
            : `${month} is not in data.police.uk's published month list.`,
        );
      }
      result = {
        topic,
        availability: {
          latest_month: availability.latest,
          earliest_month: availability.earliest,
          months: rows.map((row) => ({
            month: row.month,
            stop_search_forces_published: row.stopSearchForces.length,
            stop_search_not_published: everyForce.filter(
              (id) => !row.stopSearchForces.includes(id),
            ),
          })),
          ...(forceEntry
            ? {
                force: forceEntry.id,
                force_stop_search_published_months: rows
                  .filter((row) => row.stopSearchForces.includes(forceEntry.id))
                  .map((row) => row.month),
                force_stop_search_missing_months: rows
                  .filter((row) => !row.stopSearchForces.includes(forceEntry.id))
                  .map((row) => row.month),
              }
            : {}),
        },
      };
    } else {
      if (force === undefined) {
        throw ctx.fail('force_required', "topic 'neighbourhoods' needs force.");
      }
      const forceEntry = await service.findForce(force, ctx, budget, { allowBtp: false });
      if (!forceEntry) {
        throw ctx.fail(
          'unknown_force',
          force === BTP_FORCE.id
            ? 'British Transport Police has no neighbourhoods.'
            : `No police force '${force}'.`,
        );
      }
      const lookup = await service.getNeighbourhoods(forceEntry.id, ctx, budget);
      if (lookup.kind === 'miss') {
        throw ctx.fail(
          'unknown_force',
          `data.police.uk lists no neighbourhoods for force '${force}'.`,
        );
      }
      const sorted = [...lookup.value].sort((a, b) => a.name.localeCompare(b.name, 'en'));
      const matches = filterByName(sorted, nameContains);
      if (nameContains !== undefined && matches.length === 0) {
        notices.push(
          `No neighbourhoods matched "${nameContains}"; call ukcrime_list_reference with topic 'neighbourhoods' and no name_contains to browse the full list.`,
        );
      }
      result = {
        topic,
        force: forceEntry.id,
        neighbourhoods: matches.map(({ id, name }) => ({ id, name })),
      };
    }

    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));
    return result;
  },

  format: (result) => {
    const lines = [`**Topic:** ${result.topic}`];

    if (result.forces) {
      lines.push('', `## Police forces (${result.forces.length})`);
      if (result.forces.length === 0) {
        lines.push('', '_No forces matched._');
      } else {
        lines.push('', '| Force id | Name | Known coverage gaps |', '|:--|:--|:--|');
        for (const entry of result.forces) {
          lines.push(
            `| ${cell(entry.id)} | ${cell(entry.name)} | ${entry.gaps ? cell(entry.gaps) : '—'} |`,
          );
        }
      }
    }

    if (result.categories) {
      lines.push(
        '',
        `## Crime categories (${result.categories.length})`,
        '',
        '| Slug | Name |',
        '|:--|:--|',
      );
      for (const category of result.categories) {
        lines.push(`| ${cell(category.slug)} | ${cell(category.name)} |`);
      }
    }

    if (result.availability) {
      const availability = result.availability;
      lines.push(
        '',
        '## Data availability',
        '',
        `**Latest month:** ${availability.latest_month} · **Earliest month:** ${availability.earliest_month}`,
      );
      if (availability.force) {
        const published = availability.force_stop_search_published_months ?? [];
        const missing = availability.force_stop_search_missing_months ?? [];
        lines.push(
          '',
          `**Force:** ${inline(availability.force)}`,
          `- **Stop and search published:** ${published.length > 0 ? published.join(', ') : '(none)'}`,
          `- **Stop and search not published:** ${missing.length > 0 ? missing.join(', ') : '(none)'}`,
        );
      }
      if (availability.months.length === 0) {
        lines.push('', '_No months to show._');
      } else {
        lines.push(
          '',
          '| Month | Forces that published stop and search | Did not publish stop and search |',
          '|:--|--:|:--|',
        );
        for (const row of availability.months) {
          const missing = row.stop_search_not_published.map(cell).join(', ');
          lines.push(
            `| ${row.month} | ${row.stop_search_forces_published} | ${missing || '(none)'} |`,
          );
        }
      }
    }

    if (result.force) lines.push(`**Force:** ${inline(result.force)}`);
    if (result.neighbourhoods) {
      lines.push('', `## Neighbourhoods (${result.neighbourhoods.length})`);
      if (result.neighbourhoods.length === 0) {
        lines.push('', '_No neighbourhoods matched._');
      } else {
        lines.push('', '| Neighbourhood id | Name |', '|:--|:--|');
        for (const entry of result.neighbourhoods) {
          lines.push(`| ${cell(entry.id)} | ${cell(entry.name)} |`);
        }
      }
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
