/**
 * @fileoverview ukcrime_search_stops — stop and search records for one month
 * inside an area (a point's 1-mile radius, a polygon, a snapped location_id, a
 * police neighbourhood) or across a whole force: counts by type, both ethnicity
 * fields, outcome, object of search, legislation, age range and gender, and a
 * page of stops. Filters narrow the counts and the page together.
 * @module mcp-server/tools/definitions/search-stops.tool
 */

import { type Context, tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  AREA_INPUT_ALIASES,
  areaEcho,
  breakdown,
  checkNamedForce,
  latField,
  lngField,
  locationIdField,
  monthDefaultedNote,
  monthFailureMessage,
  monthField,
  NOT_RECORDED,
  neighbourhoodIdField,
  offsetField,
  outsideCoverageNote,
  pageOf,
  pagingNote,
  polygonField,
  runAreaQuery,
  searchedForceId,
} from '@/mcp-server/tools/area-search.js';
import { inline } from '@/mcp-server/tools/format-helpers.js';
import {
  AreaEchoSchema,
  breakdownSchema,
  LocationSchema,
  renderArea,
  renderBreakdown,
  renderLocation,
  SEARCH_ENRICHMENT,
  SEARCH_ENRICHMENT_TRAILER,
} from '@/mcp-server/tools/search-output.js';
import { ATTRIBUTION, forceInput, limitInput } from '@/mcp-server/tools/shared-schemas.js';
import { parseArea, stopsQuery } from '@/services/police-api/area.js';
import {
  getPoliceApiService,
  type PoliceApiService,
} from '@/services/police-api/police-api-service.js';
import type { CallBudget, StopRecord } from '@/services/police-api/types.js';

const STOP_AREAS = ['point', 'polygon', 'location', 'neighbourhood', 'force'] as const;

/** The categorical stop fields `filters` match and the breakdowns count, in breakdown order. */
const STOP_FIELDS = [
  'type',
  'self_defined_ethnicity',
  'officer_defined_ethnicity',
  'outcome',
  'object_of_search',
  'legislation',
  'age_range',
  'gender',
] as const satisfies readonly (keyof StopRecord)[];

type StopField = (typeof STOP_FIELDS)[number];

/** Most filters a call takes. */
const MAX_FILTERS = 8;

/** Most present values the zero-hit notice lists per filtered field. */
const MAX_PRESENT_VALUES = 12;

const DATA_NOTE =
  "Locations are anonymised map points, not where stops happened. datetime is UTC while months follow UK local time, so a stop just after midnight on the 1st can show the previous day's UTC date. Ethnicity is recorded twice: as the person defined it and as the officer perceived it. An outcome the force left blank counts as (not recorded).";

const POINT_TOO_LARGE =
  "A 1-mile circle here holds too many stops for data.police.uk to answer; search area 'polygon' with a smaller ring around the point.";

const StopFilterInput = z
  .object({
    field: z.enum(STOP_FIELDS).describe('Stop field to match.'),
    value: z
      .preprocess(
        (value) => (typeof value === 'string' ? value.trim() : value),
        z.string().min(1).max(200),
      )
      .describe(
        "Value to match exactly, case-insensitively, as the breakdowns show it; '(not recorded)' matches stops with no value.",
      ),
  })
  .strict()
  .describe('Keep only stops whose field equals value.');

const StopSchema = z
  .object({
    datetime: z.string().describe('When the stop happened, UTC ISO 8601 as published.'),
    type: z
      .string()
      .optional()
      .describe('Person search, vehicle search, or both, as published. Absent when not recorded.'),
    involved_person: z
      .boolean()
      .optional()
      .describe('Whether a person was searched. Absent when not recorded.'),
    gender: z.string().optional().describe('Gender as recorded. Absent when not recorded.'),
    age_range: z.string().optional().describe('Age range as recorded. Absent when not recorded.'),
    self_defined_ethnicity: z
      .string()
      .optional()
      .describe('Ethnicity as the person defined it. Absent when not recorded.'),
    officer_defined_ethnicity: z
      .string()
      .optional()
      .describe('Ethnicity as the officer perceived it. Absent when not recorded.'),
    legislation: z
      .string()
      .optional()
      .describe('Power the search was made under. Absent when not recorded.'),
    object_of_search: z
      .string()
      .optional()
      .describe('What the officer was searching for. Absent when not recorded.'),
    outcome: z
      .string()
      .optional()
      .describe('Outcome as published. Absent when the force left it blank.'),
    outcome_linked_to_object_of_search: z
      .boolean()
      .optional()
      .describe(
        'Whether the outcome related to the object searched for. Absent when not recorded.',
      ),
    removal_of_more_than_outer_clothing: z
      .boolean()
      .optional()
      .describe('Whether more than outer clothing was removed. Absent when not recorded.'),
    operation_name: z
      .string()
      .optional()
      .describe('Name of the policing operation, when the stop was part of one.'),
    location: LocationSchema.optional().describe(
      'Where data.police.uk places the stop. Absent for stops the force could not place.',
    ),
  })
  .describe('One stop and search.');

const OutputSchema = z.object({
  month: z.string().describe('The month searched, YYYY-MM.'),
  area: AreaEchoSchema,
  filters: z
    .array(
      z
        .object({
          field: z.enum(STOP_FIELDS).describe('Field matched.'),
          value: z.string().describe('Value matched, case-insensitively.'),
        })
        .describe('One applied filter.'),
    )
    .describe('Filters applied; empty when none.'),
  total: z.number().describe('Stops matched after filters.'),
  unfiltered_total: z.number().describe('Stops in the area and month before filters.'),
  unplaced: z
    .number()
    .describe("Matched stops with no location — the force's unplaced stops, for area 'force'."),
  force_published: z
    .boolean()
    .optional()
    .describe(
      "Whether the area's force (named, or located for a point) is in this month's stop-and-search publisher list. Absent when the force is not known.",
    ),
  by_type: breakdownSchema('Matched stops by search type, most first.'),
  by_self_defined_ethnicity: breakdownSchema(
    'Matched stops by ethnicity as the person defined it, most first.',
  ),
  by_officer_defined_ethnicity: breakdownSchema(
    'Matched stops by ethnicity as the officer perceived it, most first.',
  ),
  by_outcome: breakdownSchema(
    "Matched stops by outcome, most first; a blank outcome counts as '(not recorded)' and is often the largest bucket.",
  ),
  by_object_of_search: breakdownSchema('Matched stops by object of search, most first.'),
  by_legislation: breakdownSchema('Matched stops by legislation, most first.'),
  by_age_range: breakdownSchema('Matched stops by age range, most first.'),
  by_gender: breakdownSchema('Matched stops by gender, most first.'),
  stops: z
    .array(StopSchema)
    .describe('This page of matched stops, sorted by datetime, oldest first, then location_id.'),
  next_offset: z
    .number()
    .optional()
    .describe('Pass as offset for the next page; absent on the last page.'),
});

const BREAKDOWN_TITLES: Readonly<Record<StopField, string>> = {
  type: 'By search type',
  self_defined_ethnicity: 'By self-defined ethnicity',
  officer_defined_ethnicity: 'By officer-defined ethnicity',
  outcome: 'By outcome',
  object_of_search: 'By object of search',
  legislation: 'By legislation',
  age_range: 'By age range',
  gender: 'By gender',
};

const yesNo = (flag: boolean): string => (flag ? 'yes' : 'no');

/**
 * A located force's name for the not-published fragment. The search already
 * has its answer, so a failed force-list read leaves the name unknown rather
 * than failing the call; a cancellation still rethrows.
 */
async function locatedForceName(
  forceId: string,
  service: PoliceApiService,
  ctx: Context,
  budget: CallBudget,
): Promise<string | undefined> {
  try {
    return (await service.findForce(forceId, ctx, budget, { allowBtp: true }))?.name;
  } catch (error) {
    if (ctx.signal.aborted) throw error;
    ctx.log.warning('Force list read failed; naming the located force by its id', {
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
}

export const searchStopsTool = tool('ukcrime_search_stops', {
  title: 'Search UK Police Stop and Search',
  description:
    "Search police stop and search records for one month inside an area — a point with a 1-mile radius, a polygon, a location_id from an earlier result, or a police neighbourhood — or across a whole force with area 'force', which includes stops the force could not place. Returns the total and counts by search type, self-defined and officer-defined ethnicity, outcome, object of search, legislation, age range and gender, plus a page of stops. filters narrow the counts and the page together, so filtering one field and reading another's breakdown gives a cross-tab. Forces skip months and some publish none; the result says when the force did not publish for the month.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    area: z
      .enum(STOP_AREAS)
      .describe(
        "Area to search: 'point' (lat and lng; a 1-mile radius), 'polygon' (polygon), 'location' (location_id), 'neighbourhood' (force and neighbourhood_id), or 'force' (force alone: every stop the force published for the month, placed or not). An area field the chosen area does not use is rejected.",
      ),
    lat: latField,
    lng: lngField,
    polygon: polygonField,
    location_id: locationIdField,
    force: forceInput.describe(
      "Force id such as 'leicestershire' (ukcrime_list_reference topic 'forces' lists them); trimmed, lower-cased, spaces and underscores become hyphens. For area 'neighbourhood' (with neighbourhood_id) and 'force' (alone), where 'btp' (British Transport Police) is also accepted.",
    ),
    neighbourhood_id: neighbourhoodIdField,
    month: monthField,
    filters: z
      .preprocess(
        (value) =>
          value === null || (typeof value === 'string' && value.trim() === '')
            ? undefined
            : Array.isArray(value)
              ? value.slice(0, MAX_FILTERS + 1)
              : value,
        z.array(StopFilterInput).max(MAX_FILTERS).optional(),
      )
      .describe(
        'Up to 8 filters, all of which a stop must match; they narrow the counts and the page together. Fields: type, self_defined_ethnicity, officer_defined_ethnicity, outcome, object_of_search, legislation, age_range, gender.',
      ),
    limit: limitInput(25).describe('Stops on this page, 1–200. Default 25.'),
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
        "Send lat and lng for area 'point', polygon for 'polygon', location_id for 'location', force and neighbourhood_id for 'neighbourhood', or force alone for 'force'.",
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
      reason: 'unknown_force',
      code: JsonRpcErrorCode.ValidationError,
      when: "force is not in the force list, or 'btp' on area 'neighbourhood'",
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
      reason: 'area_too_large',
      code: JsonRpcErrorCode.ValidationError,
      when: 'the area holds more stops than data.police.uk will answer for',
      recovery:
        'Search a smaller area: split the polygon into smaller polygons, or search a neighbourhood or a point instead.',
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
    const [resolution, named] = await Promise.all([
      service.resolveMonth(input.month, ctx, budget),
      checkNamedForce(spec, service, ctx, budget),
    ]);
    if (resolution.kind === 'not_published') {
      throw ctx.fail('month_not_published', monthFailureMessage(resolution));
    }
    if (resolution.kind === 'out_of_range') {
      throw ctx.fail('month_out_of_range', monthFailureMessage(resolution));
    }
    if (named.kind === 'unknown') throw ctx.fail('unknown_force', named.message);
    const { month } = resolution;

    const run = await runAreaQuery(
      spec,
      (target) => ({
        ...stopsQuery(target, month),
        ...(spec.kind === 'point' ? { tooLargeHint: POINT_TOO_LARGE } : {}),
      }),
      service,
      ctx,
      budget,
    );
    // /stops-at-location answers [] for an unknown id, so the boundary is the only lookup that misses.
    if (run.kind !== 'ok') {
      throw ctx.fail(
        'unknown_neighbourhood',
        `Force '${input.force}' has no neighbourhood '${input.neighbourhood_id}'; ids are case-sensitive.`,
      );
    }

    const filters = input.filters ?? [];
    const matched =
      filters.length === 0
        ? run.records
        : run.records.filter((stop) =>
            filters.every(
              ({ field, value }) =>
                (stop[field] ?? NOT_RECORDED).toLowerCase() === value.toLowerCase(),
            ),
          );
    const total = matched.length;
    const page = pageOf(matched, input.offset, input.limit);
    ctx.enrich({ truncated: page.nextOffset !== undefined, shown: page.rows.length });

    const forceId = searchedForceId(named, run.located);
    const publishers = resolution.availability.months.find(
      (row) => row.month === month,
    )?.stopSearchForces;
    const forcePublished =
      forceId !== undefined && publishers ? publishers.includes(forceId) : undefined;

    const notes: string[] = [];
    if (resolution.defaulted) notes.push(monthDefaultedNote(month));
    if (forceId !== undefined && forcePublished === false) {
      const forceName =
        named.kind === 'ok'
          ? named.force.name
          : ((await locatedForceName(forceId, service, ctx, budget)) ?? forceId);
      notes.push(
        `${inline(forceName)} has not published stop and search data for ${month} to data.police.uk; call ukcrime_list_reference with topic 'availability' and force '${inline(forceId)}' for the months it has.`,
      );
    }
    if (total === 0) {
      if (filters.length > 0 && run.records.length > 0) {
        const fields = [...new Set(filters.map(({ field }) => field))];
        const present = fields.map((field) => {
          const values = breakdown(run.records, (stop) => stop[field]);
          const listed = values
            .slice(0, MAX_PRESENT_VALUES)
            .map(({ value }) => `"${inline(value)}"`)
            .join(', ');
          const more =
            values.length > MAX_PRESENT_VALUES
              ? ` and ${values.length - MAX_PRESENT_VALUES} more`
              : '';
          return `values present for ${field}: ${listed}${more}`;
        });
        notes.push(`No stops matched the filters; ${present.join('; ')}.`);
      } else if (spec.kind === 'location') {
        notes.push(
          `No stops at location ${spec.locationId} in ${month}; location ids come from earlier results, so check it or search area 'point'.`,
        );
      } else {
        const outside = outsideCoverageNote(spec, run.located);
        if (outside) notes.push(outside);
        else if (forcePublished !== false) {
          notes.push(
            spec.kind === 'force'
              ? `No stops recorded for this force in ${month}; try another month.`
              : `No stops recorded here in ${month}; try another month, a wider area, or area 'force' for the whole force, including stops it could not place.`,
          );
        }
      }
    }
    const paging = pagingNote('stops', input.offset, page, total);
    if (paging) notes.push(paging);
    if (notes.length > 0) ctx.enrich.notice(notes.join(' '));

    return {
      month,
      area: areaEcho(spec, run.target, run.located),
      filters: filters.map(({ field, value }) => ({ field, value })),
      total,
      unfiltered_total: run.records.length,
      unplaced: matched.filter((stop) => !stop.location).length,
      ...(forcePublished !== undefined ? { force_published: forcePublished } : {}),
      by_type: breakdown(matched, (stop) => stop.type),
      by_self_defined_ethnicity: breakdown(matched, (stop) => stop.self_defined_ethnicity),
      by_officer_defined_ethnicity: breakdown(matched, (stop) => stop.officer_defined_ethnicity),
      by_outcome: breakdown(matched, (stop) => stop.outcome),
      by_object_of_search: breakdown(matched, (stop) => stop.object_of_search),
      by_legislation: breakdown(matched, (stop) => stop.legislation),
      by_age_range: breakdown(matched, (stop) => stop.age_range),
      by_gender: breakdown(matched, (stop) => stop.gender),
      stops: [...page.rows],
      ...(page.nextOffset !== undefined ? { next_offset: page.nextOffset } : {}),
    };
  },

  format: (result) => {
    const filters =
      result.filters.length > 0
        ? result.filters.map(({ field, value }) => `${field} = "${inline(value)}"`).join('; ')
        : 'none';
    const lines = [
      `## Stop and search — ${inline(result.month)}`,
      '',
      renderArea(result.area),
      `**Filters:** ${filters}`,
      `**Stops matched:** ${result.total} of ${result.unfiltered_total} · **Without a location:** ${result.unplaced}`,
    ];
    if (result.force_published !== undefined) {
      lines.push(
        `**Force published stop and search for this month:** ${yesNo(result.force_published)}`,
      );
    }
    const breakdowns = {
      type: result.by_type,
      self_defined_ethnicity: result.by_self_defined_ethnicity,
      officer_defined_ethnicity: result.by_officer_defined_ethnicity,
      outcome: result.by_outcome,
      object_of_search: result.by_object_of_search,
      legislation: result.by_legislation,
      age_range: result.by_age_range,
      gender: result.by_gender,
    };
    for (const field of STOP_FIELDS) {
      lines.push(...renderBreakdown(BREAKDOWN_TITLES[field], breakdowns[field]));
    }

    lines.push('', `### Stops on this page (${result.stops.length})`);
    if (result.stops.length === 0) lines.push('', '_None._');
    else lines.push('');
    for (const stop of result.stops) {
      const parts = [`**${inline(stop.datetime)}**`];
      if (stop.type) parts.push(inline(stop.type));
      if (stop.involved_person !== undefined)
        parts.push(`person involved: ${yesNo(stop.involved_person)}`);
      if (stop.gender) parts.push(`gender: ${inline(stop.gender)}`);
      if (stop.age_range) parts.push(`age: ${inline(stop.age_range)}`);
      if (stop.self_defined_ethnicity)
        parts.push(`self-defined ethnicity: ${inline(stop.self_defined_ethnicity)}`);
      if (stop.officer_defined_ethnicity)
        parts.push(`officer-defined ethnicity: ${inline(stop.officer_defined_ethnicity)}`);
      if (stop.legislation) parts.push(`legislation: ${inline(stop.legislation)}`);
      if (stop.object_of_search) parts.push(`object of search: ${inline(stop.object_of_search)}`);
      if (stop.outcome) parts.push(`outcome: ${inline(stop.outcome)}`);
      if (stop.outcome_linked_to_object_of_search !== undefined) {
        parts.push(
          `outcome linked to object of search: ${yesNo(stop.outcome_linked_to_object_of_search)}`,
        );
      }
      if (stop.removal_of_more_than_outer_clothing !== undefined) {
        parts.push(
          `more than outer clothing removed: ${yesNo(stop.removal_of_more_than_outer_clothing)}`,
        );
      }
      if (stop.operation_name) parts.push(`operation: ${inline(stop.operation_name)}`);
      lines.push(`- ${parts.join(' · ')}`);
      if (stop.location) lines.push(`  - Location: ${renderLocation(stop.location)}`);
    }

    if (result.next_offset !== undefined) {
      lines.push('', `**Next offset:** ${result.next_offset}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
