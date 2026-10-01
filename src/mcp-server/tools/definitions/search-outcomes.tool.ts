/**
 * @fileoverview ukcrime_search_outcomes — police outcomes recorded in one month
 * inside an area (a point's 1-mile radius, a polygon, a snapped location_id, a
 * police neighbourhood), for crimes recorded that month or earlier: the total,
 * counts by outcome and by crime month, and a page of outcomes with their crimes.
 * @module mcp-server/tools/definitions/search-outcomes.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { internalError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  AREA_INPUT_ALIASES,
  areaEcho,
  checkNamedForce,
  latField,
  lngField,
  locationIdField,
  monthDefaultedNote,
  monthFailureMessage,
  monthField,
  neighbourhoodIdField,
  offsetField,
  outsideCoverageNote,
  pageOf,
  pagingNote,
  polygonField,
  runAreaQuery,
  searchedForceId,
} from '@/mcp-server/tools/area-search.js';
import { cell, inline, quote } from '@/mcp-server/tools/format-helpers.js';
import {
  AreaEchoSchema,
  LocationSchema,
  renderArea,
  renderLocation,
  SEARCH_ENRICHMENT,
  SEARCH_ENRICHMENT_TRAILER,
} from '@/mcp-server/tools/search-output.js';
import {
  ATTRIBUTION,
  categoryInput,
  forceInput,
  limitInput,
} from '@/mcp-server/tools/shared-schemas.js';
import { outcomesQuery, parseArea } from '@/services/police-api/area.js';
import { coverageNotes } from '@/services/police-api/known-gaps.js';
import { getPoliceApiService } from '@/services/police-api/police-api-service.js';
import { compareText } from '@/services/police-api/records.js';
import type { OutcomeRecord } from '@/services/police-api/types.js';

const OUTCOME_AREAS = ['point', 'polygon', 'location', 'neighbourhood'] as const;

const ALL_CRIME = 'all-crime';

const DATA_NOTE =
  "An outcome's month is when police recorded it; the crime's own month can be years earlier. Police outcomes only — court results are not published. Locations are anonymised map points, not crime sites.";

const POINT_TOO_LARGE =
  "A 1-mile circle here holds more than 10,000 outcomes; search area 'polygon' with a smaller ring around the point.";

const OutcomeSchema = z
  .object({
    code: z.string().describe('Outcome code, such as under-investigation or unable-to-prosecute.'),
    name: z.string().describe('Outcome as published.'),
    month: z.string().describe('Month recorded, YYYY-MM.'),
    crime: z
      .object({
        id: z.string().describe('data.police.uk crime id.'),
        persistent_id: z
          .string()
          .optional()
          .describe(
            'Id ukcrime_get_crime_outcomes takes for the full history. Absent when unpublished.',
          ),
        category: z.string().describe('Category slug.'),
        month: z.string().describe('Month recorded, YYYY-MM; can be years before the outcome.'),
        location: LocationSchema.optional().describe('Absent when the crime has no location.'),
        context: z.string().optional().describe('Force-written extra detail, when any.'),
      })
      .describe('The crime this outcome was recorded for.'),
  })
  .describe('One police outcome and its crime.');

const OutputSchema = z.object({
  month: z.string().describe('The month searched — when the outcomes were recorded — YYYY-MM.'),
  area: AreaEchoSchema,
  category: z
    .object({
      slug: z.string().describe('Category slug.'),
      name: z.string().describe('Category display name.'),
    })
    .optional()
    .describe(
      "The crime category counted; absent when every category was (no category, or 'all-crime').",
    ),
  total: z.number().describe('Outcomes matched, after the category filter.'),
  unfiltered_total: z
    .number()
    .describe('Outcomes recorded in the area and month before the category filter.'),
  by_outcome: z
    .array(
      z
        .object({
          code: z.string().describe('Outcome code.'),
          name: z.string().describe('Outcome as published.'),
          count: z.number().describe('Matched outcomes.'),
        })
        .describe('An outcome and its count.'),
    )
    .describe('Matched outcomes by outcome, most first.'),
  by_crime_month: z
    .array(
      z
        .object({
          month: z.string().describe('Crime month, YYYY-MM.'),
          count: z.number().describe('Matched outcomes.'),
        })
        .describe('A crime month and its count.'),
    )
    .describe('Matched outcomes by the month their crime was recorded, newest first.'),
  outcomes: z
    .array(OutcomeSchema)
    .describe(
      "This page of matched outcomes, sorted by the crime's month, newest first, then crime id.",
    ),
  next_offset: z
    .number()
    .optional()
    .describe('Pass as offset for the next page; absent on the last page.'),
});

type OutcomesOutput = z.infer<typeof OutputSchema>;

/** Counts outcomes by code, most first, then by code. */
function outcomeCounts(outcomes: readonly OutcomeRecord[]): OutcomesOutput['by_outcome'] {
  const counts = new Map<string, OutcomesOutput['by_outcome'][number]>();
  for (const { code, name } of outcomes) {
    const entry = counts.get(code);
    if (entry) entry.count += 1;
    else counts.set(code, { code, name, count: 1 });
  }
  return Array.from(counts.values()).sort(
    (a, b) => b.count - a.count || compareText(a.code, b.code),
  );
}

/** Counts outcomes by the month their crime was recorded, newest month first. */
function crimeMonthCounts(outcomes: readonly OutcomeRecord[]): OutcomesOutput['by_crime_month'] {
  const counts = new Map<string, number>();
  for (const { crime } of outcomes) counts.set(crime.month, (counts.get(crime.month) ?? 0) + 1);
  return Array.from(counts, ([month, count]) => ({ month, count })).sort((a, b) =>
    compareText(b.month, a.month),
  );
}

export const searchOutcomesTool = tool('ukcrime_search_outcomes', {
  title: 'Search UK Police Outcomes',
  description:
    'List the police outcomes recorded in one month inside an area — a point with a 1-mile radius, a polygon, a location_id, or a neighbourhood — for crimes recorded that month or any earlier one. Returns the total, counts by outcome and by the month each crime was recorded, and a page of outcomes, each with its crime and persistent_id. Use it for what police resolved in a month; ukcrime_search_crimes gives the latest outcome of the crimes recorded in a month instead. Court results are not published; the result says when a force publishes no outcomes.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    area: z
      .enum(OUTCOME_AREAS)
      .describe(
        "Area to search: 'point' (lat and lng; a 1-mile radius), 'polygon' (polygon), 'location' (location_id), or 'neighbourhood' (force and neighbourhood_id). An area field the chosen area does not use is rejected.",
      ),
    lat: latField,
    lng: lngField,
    polygon: polygonField,
    location_id: locationIdField,
    force: forceInput.describe(
      "For area 'neighbourhood', with neighbourhood_id: a force id such as 'leicestershire' (ukcrime_list_reference topic 'forces' lists them); trimmed, lower-cased, spaces and underscores become hyphens.",
    ),
    neighbourhood_id: neighbourhoodIdField,
    month: monthField,
    category: categoryInput.describe(
      "Count only outcomes for crimes in this category: a slug such as 'burglary' or a display name such as 'Violence and sexual offences'; case-insensitive, and spaces, underscores and hyphens match each other ('vehicle_crime' finds 'vehicle-crime'). Omitted or 'all-crime': every category. ukcrime_list_reference topic 'categories' lists them.",
    ),
    limit: limitInput(20).describe('Outcomes on this page, 1–200. Default 20.'),
    offset: offsetField,
  }),
  inputAliases: AREA_INPUT_ALIASES,
  output: OutputSchema,
  enrichment: SEARCH_ENRICHMENT,
  enrichmentTrailer: SEARCH_ENRICHMENT_TRAILER,
  errors: [
    {
      reason: 'invalid_area',
      code: JsonRpcErrorCode.ValidationError,
      when: "the area's required fields are missing, or a field it does not use is present",
      recovery:
        "Send lat and lng for area 'point', polygon for 'polygon', location_id for 'location', or force and neighbourhood_id for 'neighbourhood'.",
      severity: 'notice',
    },
    {
      reason: 'month_not_published',
      code: JsonRpcErrorCode.ValidationError,
      when: 'month is after the latest published month',
      recovery:
        "Call ukcrime_list_reference with topic 'availability' for the published months, or omit month to search the latest one.",
      severity: 'notice',
    },
    {
      reason: 'month_out_of_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'month is before the 36-month window',
      recovery:
        "data.police.uk serves only the last 36 months; call ukcrime_list_reference with topic 'availability' for the earliest month.",
      severity: 'notice',
    },
    {
      reason: 'unknown_category',
      code: JsonRpcErrorCode.ValidationError,
      when: 'category matches no category slug or name',
      recovery:
        "Call ukcrime_list_reference with topic 'categories' for valid slugs such as 'burglary', or omit category to count outcomes for every crime.",
      severity: 'notice',
    },
    {
      reason: 'unknown_force',
      code: JsonRpcErrorCode.ValidationError,
      when: "force is not in the force list, or is 'btp' (British Transport Police has no neighbourhoods)",
      recovery:
        "Call ukcrime_list_reference with topic 'forces' for valid force ids such as 'leicestershire'.",
      severity: 'notice',
    },
    {
      reason: 'unknown_neighbourhood',
      code: JsonRpcErrorCode.NotFound,
      when: 'the force has no neighbourhood with this id (ids are case-sensitive)',
      recovery:
        "Call ukcrime_list_reference with topic 'neighbourhoods' and this force for valid ids, or ukcrime_find_neighbourhood with lat and lng.",
      severity: 'notice',
    },
    {
      reason: 'unknown_location',
      code: JsonRpcErrorCode.NotFound,
      when: 'data.police.uk holds no map point with this location_id',
      recovery:
        "Use a location_id from the crime location of an earlier ukcrime_search_outcomes or ukcrime_search_crimes result, or search area 'point' with lat and lng.",
      severity: 'notice',
    },
    {
      reason: 'area_too_large',
      code: JsonRpcErrorCode.ValidationError,
      when: 'the area holds more than 10,000 outcomes, which data.police.uk refuses to answer',
      recovery:
        "Search a smaller area: split the polygon into smaller polygons, or for a neighbourhood call ukcrime_find_neighbourhood with include ['boundary'] and search parts of that polygon with area 'polygon'. The upstream refuses areas holding more than 10,000 outcomes.",
      severity: 'notice',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'data.police.uk is not answering',
      recovery: 'data.police.uk is not answering right now; call this tool again in a few minutes.',
      retryable: true,
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    ctx.enrich({
      attribution: ATTRIBUTION,
      data_note: DATA_NOTE,
      truncated: false,
      shown: 0,
      cap: input.limit,
    });
    const parsed = parseArea(input.area, input);
    if (!parsed.ok) throw ctx.fail('invalid_area', parsed.message);
    const { spec } = parsed;

    const service = getPoliceApiService();
    const budget = service.openBudget();
    const [resolution, category, named] = await Promise.all([
      service.resolveMonth(input.month, ctx, budget),
      input.category === undefined ? undefined : service.findCategory(input.category, ctx, budget),
      checkNamedForce(spec, service, ctx, budget),
    ]);
    if (resolution.kind === 'not_published') {
      throw ctx.fail('month_not_published', monthFailureMessage(resolution));
    }
    if (resolution.kind === 'out_of_range') {
      throw ctx.fail('month_out_of_range', monthFailureMessage(resolution));
    }
    if (input.category !== undefined && !category) {
      throw ctx.fail('unknown_category', `No crime category matches '${input.category}'.`);
    }
    if (named.kind === 'unknown') throw ctx.fail('unknown_force', named.message);
    const { month } = resolution;

    const run = await runAreaQuery(
      spec,
      (target) => {
        // No outcome arm is force-wide, so the target is always a place.
        if (target.kind === 'force')
          throw internalError('Outcome searches have no force-wide area.');
        return {
          ...outcomesQuery(target, month),
          ...(spec.kind === 'point' ? { tooLargeHint: POINT_TOO_LARGE } : {}),
        };
      },
      service,
      ctx,
      budget,
    );
    if (run.kind === 'unknown_neighbourhood') {
      throw ctx.fail(
        'unknown_neighbourhood',
        `Force '${input.force}' has no neighbourhood '${input.neighbourhood_id}'; ids are case-sensitive.`,
      );
    }
    if (run.kind === 'unknown_location') {
      throw ctx.fail(
        'unknown_location',
        `data.police.uk holds no map point with location_id '${input.location_id}'.`,
      );
    }

    // The outcomes route takes no category, so a narrowed search filters locally.
    const filter = category && category.slug !== ALL_CRIME ? category : undefined;
    const matched = filter
      ? run.records.filter((outcome) => outcome.crime.category === filter.slug)
      : run.records;
    const total = matched.length;
    const page = pageOf(matched, input.offset, input.limit);
    ctx.enrich({ truncated: page.nextOffset !== undefined, shown: page.rows.length });

    const notes: string[] = [];
    if (resolution.defaulted) notes.push(monthDefaultedNote(month));
    const forceId = searchedForceId(named, run.located);
    if (forceId) notes.push(...coverageNotes(forceId, ['outcomes']));
    if (total === 0) {
      notes.push(
        outsideCoverageNote(spec, run.located) ??
          (filter && run.records.length > 0
            ? `Only outcomes for ${inline(filter.name)} crimes were counted; omit category for all.`
            : `No outcomes recorded here in ${month}; try another month or a wider area.`),
      );
    }
    const paging = pagingNote('outcomes', input.offset, page, total);
    if (paging) notes.push(paging);
    if (notes.length > 0) ctx.enrich.notice(notes.join(' '));

    return {
      month,
      area: areaEcho(spec, run.target, run.located),
      ...(filter ? { category: { slug: filter.slug, name: filter.name } } : {}),
      total,
      unfiltered_total: run.records.length,
      by_outcome: outcomeCounts(matched),
      by_crime_month: crimeMonthCounts(matched),
      outcomes: [...page.rows],
      ...(page.nextOffset !== undefined ? { next_offset: page.nextOffset } : {}),
    };
  },

  format: (result) => {
    const lines = [`## Police outcomes — ${inline(result.month)}`, '', renderArea(result.area)];
    if (result.category) {
      lines.push(
        `**Crime category:** ${inline(result.category.name)} (${inline(result.category.slug)})`,
      );
    }
    lines.push(
      `**Outcomes matched:** ${result.total} of ${result.unfiltered_total} recorded this month`,
    );

    lines.push('', '### By outcome');
    if (result.by_outcome.length === 0) lines.push('', '_None._');
    else {
      lines.push('', '| Outcome | Code | Count |', '|:--|:--|--:|');
      for (const row of result.by_outcome) {
        lines.push(`| ${cell(row.name)} | ${cell(row.code)} | ${row.count} |`);
      }
    }

    lines.push('', '### By month the crime was recorded');
    if (result.by_crime_month.length === 0) lines.push('', '_None._');
    else {
      lines.push('', '| Crime month | Count |', '|:--|--:|');
      for (const row of result.by_crime_month) {
        lines.push(`| ${cell(row.month)} | ${row.count} |`);
      }
    }

    lines.push('', `### Outcomes on this page (${result.outcomes.length})`);
    if (result.outcomes.length === 0) lines.push('', '_None._');
    else lines.push('');
    for (const [index, outcome] of result.outcomes.entries()) {
      const { crime } = outcome;
      // A blank line closes the previous outcome's quoted crime context.
      if (result.outcomes[index - 1]?.crime.context) lines.push('');
      lines.push(
        `- **${inline(outcome.name)}** (${inline(outcome.code)}) · recorded ${inline(outcome.month)}`,
      );
      const head = [
        inline(crime.category),
        `id ${inline(crime.id)}`,
        `crime month ${inline(crime.month)}`,
      ];
      if (crime.persistent_id) head.push(`persistent_id ${inline(crime.persistent_id)}`);
      lines.push(`  - Crime: ${head.join(' · ')}`);
      if (crime.location) lines.push(`  - Location: ${renderLocation(crime.location)}`);
      if (crime.context) {
        lines.push(
          '  - Context:',
          ...quote(crime.context)
            .split('\n')
            .map((line) => `    ${line}`),
        );
      }
    }

    if (result.next_offset !== undefined) {
      lines.push('', `**Next offset:** ${result.next_offset}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
