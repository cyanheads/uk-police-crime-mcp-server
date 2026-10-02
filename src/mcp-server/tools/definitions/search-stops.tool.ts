/**
 * @fileoverview ukcrime_search_stops — stop and search records for one month,
 * or a range of up to 12 months, inside an area (a point's 1-mile radius, a
 * polygon, a snapped location_id, a police neighbourhood) or across a whole
 * force: counts by type, both ethnicity fields, outcome, object of search,
 * legislation, age range, gender, and the find and strip-search flags, each
 * month's total and publication for a range, and a page of stops. Filters
 * narrow the counts and the page together.
 * @module mcp-server/tools/definitions/search-stops.tool
 */

import { type Context, tool, z } from '@cyanheads/mcp-ts-core';
import { internalError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  AREA_INPUT_ALIASES,
  areaEcho,
  breakdown,
  checkNamedForce,
  type ForceCheck,
  latField,
  lngField,
  locationIdField,
  monthDefaultedNote,
  monthFromField,
  monthSpanLabel,
  NOT_RECORDED,
  neighbourhoodIdField,
  offsetField,
  outsideCoverageNote,
  pageOf,
  pagingNote,
  partialLocateNote,
  polygonField,
  rangeEndMonthField,
  rangeStopMessage,
  resolveMonthWindow,
  runAreaWindow,
  unknownNeighbourhoodMessage,
} from '@/mcp-server/tools/area-search.js';
import { inline } from '@/mcp-server/tools/format-helpers.js';
import {
  AreaEchoSchema,
  breakdownSchema,
  byMonthSchema,
  LocationSchema,
  MonthTotalSchema,
  renderArea,
  renderBreakdown,
  renderByMonth,
  renderLocation,
  SEARCH_ENRICHMENT,
  SEARCH_ENRICHMENT_TRAILER,
} from '@/mcp-server/tools/search-output.js';
import { ATTRIBUTION, forceInput, limitInput } from '@/mcp-server/tools/shared-schemas.js';
import { type AreaTarget, parseArea, stopsQuery } from '@/services/police-api/area.js';
import {
  getPoliceApiService,
  type PoliceApiService,
} from '@/services/police-api/police-api-service.js';
import type { CallBudget, StopRecord } from '@/services/police-api/types.js';

const STOP_AREAS = ['point', 'polygon', 'location', 'neighbourhood', 'force'] as const;

/** The stop fields `filters` match and the breakdowns count, in breakdown order: eight categorical, then two yes/no flags. */
const STOP_FIELDS = [
  'type',
  'self_defined_ethnicity',
  'officer_defined_ethnicity',
  'outcome',
  'object_of_search',
  'legislation',
  'age_range',
  'gender',
  'outcome_linked_to_object_of_search',
  'removal_of_more_than_outer_clothing',
] as const satisfies readonly (keyof StopRecord)[];

type StopField = (typeof STOP_FIELDS)[number];

/** A stop filter after parsing, its value read as a string. */
interface StopFilter {
  readonly field: StopField;
  readonly value: string;
}

/**
 * A stop's value for a filter field or breakdown, as the breakdowns show it: a
 * flag as `'true'` or `'false'`, an unrecorded value as undefined. Filter
 * matching, the breakdowns and the zero-hit present values all read it.
 */
const stopValue = (stop: StopRecord, field: StopField): string | undefined => {
  const value = stop[field];
  return value === undefined ? undefined : String(value);
};

/** The stops matching every filter, case-insensitively; `(not recorded)` matches an unrecorded value. */
function matchStops(
  stops: readonly StopRecord[],
  filters: readonly StopFilter[],
): readonly StopRecord[] {
  if (filters.length === 0) return stops;
  return stops.filter((stop) =>
    filters.every(
      ({ field, value }) =>
        (stopValue(stop, field) ?? NOT_RECORDED).toLowerCase() === value.toLowerCase(),
    ),
  );
}

/** Every field's breakdown over a stop list. */
function stopBreakdowns(stops: readonly StopRecord[]) {
  const count = (field: StopField) => breakdown(stops, (stop) => stopValue(stop, field));
  return {
    by_type: count('type'),
    by_self_defined_ethnicity: count('self_defined_ethnicity'),
    by_officer_defined_ethnicity: count('officer_defined_ethnicity'),
    by_outcome: count('outcome'),
    by_object_of_search: count('object_of_search'),
    by_legislation: count('legislation'),
    by_age_range: count('age_range'),
    by_gender: count('gender'),
    by_outcome_linked_to_object_of_search: count('outcome_linked_to_object_of_search'),
    by_removal_of_more_than_outer_clothing: count('removal_of_more_than_outer_clothing'),
  };
}

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
    // The union, not a preprocess to string, so the advertised schema accepts the boolean too.
    value: z
      .preprocess(
        (value) => (typeof value === 'string' ? value.trim() : value),
        z.union([z.string().min(1).max(200), z.boolean()]),
      )
      .describe(
        "Value to match exactly, case-insensitively, as the breakdowns show it: 'true' or 'false' for outcome_linked_to_object_of_search and removal_of_more_than_outer_clothing (a JSON true or false reads the same), and '(not recorded)' for stops with no value.",
      ),
  })
  .strict()
  .describe('Keep only stops whose field equals value.');

const StopSchema = z
  .object({
    datetime: z.string().describe('When the stop happened, UTC ISO 8601 as published.'),
    type: z.string().optional().describe('Person search, vehicle search, or both.'),
    involved_person: z.boolean().optional().describe('Whether a person was searched.'),
    gender: z.string().optional().describe('Gender.'),
    age_range: z.string().optional().describe('Age range.'),
    self_defined_ethnicity: z.string().optional().describe('Ethnicity as the person defined it.'),
    officer_defined_ethnicity: z
      .string()
      .optional()
      .describe('Ethnicity as the officer perceived it.'),
    legislation: z.string().optional().describe('Power the search was made under.'),
    object_of_search: z.string().optional().describe('What the officer was searching for.'),
    outcome: z.string().optional().describe('Outcome.'),
    outcome_linked_to_object_of_search: z
      .boolean()
      .optional()
      .describe('Whether the outcome related to the object searched for.'),
    removal_of_more_than_outer_clothing: z
      .boolean()
      .optional()
      .describe('Whether more than outer clothing was removed.'),
    operation_name: z.string().optional().describe('Policing operation the stop was part of.'),
    location: LocationSchema.optional().describe('Absent for stops the force could not place.'),
  })
  .describe('One stop and search, values as published; a field is absent when not recorded.');

const OutputSchema = z.object({
  month_from: z
    .string()
    .optional()
    .describe(
      'First month of the range searched, YYYY-MM; present only when month_from was given.',
    ),
  month: z.string().describe('The month searched, or the last month of the range, YYYY-MM.'),
  area: AreaEchoSchema,
  filters: z
    .array(
      z
        .object({
          field: z.enum(STOP_FIELDS).describe('Field matched.'),
          value: z.string().describe('Value matched.'),
        })
        .describe('One applied filter.'),
    )
    .describe('Filters applied, case-insensitively; empty when none.'),
  total: z.number().describe('Stops matched after filters, over the month or range.'),
  unfiltered_total: z
    .number()
    .describe('Stops in the area over the month or range, before filters.'),
  unplaced: z
    .number()
    .describe("Matched stops with no location — the force's unplaced stops, for area 'force'."),
  force_published: z
    .boolean()
    .optional()
    .describe(
      "Whether every force found for the area (the one it names, or each located at a point, a polygon's centre and outermost vertices, or a location's map point) published stop and search this month, or in every month of a range: false when any month was missed. Otherwise absent when no force was found, when a month has no row in the publication list, or when none of those found is missing yet a polygon point could not be looked up.",
    ),
  by_month: byMonthSchema(
    MonthTotalSchema.extend({
      force_published: z
        .boolean()
        .optional()
        .describe(
          'Whether every force found for the area published stop and search this month; absent on the same terms as the top-level force_published.',
        ),
    }),
    'Stops matched in each month of the range, oldest first; their totals sum to total. Present only when month_from was given.',
  ),
  by_type: breakdownSchema('Matched stops by search type, most first.'),
  by_self_defined_ethnicity: breakdownSchema(
    'Matched stops by ethnicity as the person defined it, most first.',
  ),
  by_officer_defined_ethnicity: breakdownSchema(
    'Matched stops by ethnicity as the officer perceived it, most first.',
  ),
  by_outcome: breakdownSchema(
    "Matched stops by outcome, most first; '(not recorded)' is often the largest.",
  ),
  by_object_of_search: breakdownSchema('Matched stops by object of search, most first.'),
  by_legislation: breakdownSchema('Matched stops by legislation, most first.'),
  by_age_range: breakdownSchema('Matched stops by age range, most first.'),
  by_gender: breakdownSchema('Matched stops by gender, most first.'),
  by_outcome_linked_to_object_of_search: breakdownSchema(
    "Matched stops by whether the outcome was linked to the object of search ('true', 'false' or '(not recorded)'), most first.",
  ),
  by_removal_of_more_than_outer_clothing: breakdownSchema(
    "Matched stops by whether more than outer clothing was removed ('true', 'false' or '(not recorded)' where the force sent no value, as some do for vehicle-only searches), most first.",
  ),
  stops: z
    .array(StopSchema)
    .describe('This page of matched stops, oldest first, then by location_id.'),
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
  outcome_linked_to_object_of_search: 'By outcome linked to object of search',
  removal_of_more_than_outer_clothing: 'By more than outer clothing removed',
};

const yesNo = (flag: boolean): string => (flag ? 'yes' : 'no');

/**
 * A month's stop-and-search publication for the forces a search knows:
 * `unpublished` lists those missing from the month's publisher list, and
 * `published` is true when none is and the forces are `complete`, false when
 * any is, and absent when no force is known, the month has no row in the list,
 * or none is missing from forces that may not be complete.
 */
function publication(
  forces: readonly string[],
  publishers: readonly string[] | undefined,
  complete: boolean,
): { readonly published?: boolean; readonly unpublished: readonly string[] } {
  if (forces.length === 0 || !publishers) return { unpublished: [] };
  const unpublished = forces.filter((force) => !publishers.includes(force));
  if (unpublished.length === 0 && !complete) return { unpublished };
  return { published: unpublished.length === 0, unpublished };
}

/**
 * Names for the not-published fragment, by force id: the named force's, or the
 * force list's for located forces. The search already has its answer, so a
 * failed force-list read leaves each name to its id rather than failing the
 * call; a cancellation still rethrows.
 */
async function forceNames(
  named: ForceCheck,
  service: PoliceApiService,
  ctx: Context,
  budget: CallBudget,
): Promise<ReadonlyMap<string, string>> {
  if (named.kind === 'ok') return new Map([[named.force.id, named.force.name]]);
  try {
    const forces = await service.getForces(ctx, budget);
    return new Map(forces.map((force) => [force.id, force.name]));
  } catch (error) {
    if (ctx.signal.aborted) throw error;
    ctx.log.warning('Force list read failed; naming each located force by its id', {
      error: error instanceof Error ? error.message : String(error),
    });
    return new Map();
  }
}

export const searchStopsTool = tool('ukcrime_search_stops', {
  title: 'Search UK Police Stop and Search',
  description:
    "Search police stop and search records for one month, or with month_from a range of up to 12 months, inside an area — a point with a 1-mile radius, a polygon, a location_id from an earlier result, or a police neighbourhood — or across a whole force with area 'force', which includes stops the force could not place. Returns the total and counts by search type, self-defined and officer-defined ethnicity, outcome, object of search, legislation, age range, gender, whether the outcome was linked to the object of search, and whether more than outer clothing was removed, each month's total for a range, and a page of stops. filters narrow the counts and the page together, so filtering one field and reading another's breakdown gives a cross-tab. Forces skip months and some publish none; the result names each force it finds for the area that did not publish, with the months it skipped.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    area: z
      .enum(STOP_AREAS)
      .describe(
        "Area to search: 'point' (lat and lng; a 1-mile radius), 'polygon' (polygon), 'location' (location_id), 'neighbourhood' (force and neighbourhood_id), or 'force' (force alone: every stop the force published for the month or range, placed or not). An area field the chosen area does not use is rejected.",
      ),
    lat: latField,
    lng: lngField,
    polygon: polygonField,
    location_id: locationIdField,
    force: forceInput.describe(
      "Force id such as 'leicestershire', or its name such as 'Leicestershire Police' (ukcrime_list_reference topic 'forces' lists both); case-insensitive, spaces, underscores and hyphens match each other, '&' matches 'and', and a trailing 'Police', 'Police Service' or 'Constabulary' is optional. For area 'neighbourhood' (with neighbourhood_id) and 'force' (alone), where 'btp' (British Transport Police) is also accepted.",
    ),
    neighbourhood_id: neighbourhoodIdField,
    month: rangeEndMonthField,
    month_from: monthFromField,
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
        'Up to 8 filters, all of which a stop must match; they narrow the counts and the page together. Fields: type, self_defined_ethnicity, officer_defined_ethnicity, outcome, object_of_search, legislation, age_range, gender, outcome_linked_to_object_of_search, removal_of_more_than_outer_clothing.',
      ),
    limit: limitInput(15).describe('Stops on this page, 1–200. Default 15.'),
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
      when: 'month or month_from is after the latest published month',
      recovery:
        "Call ukcrime_list_reference with topic 'availability' for the published months, or omit month to search the latest one; month_from must be a published month no later than month.",
      severity: 'notice',
    },
    {
      reason: 'month_out_of_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'month or month_from is before the 36-month window',
      recovery:
        "data.police.uk serves only the last 36 months; call ukcrime_list_reference with topic 'availability' for the earliest month.",
      severity: 'notice',
    },
    {
      reason: 'invalid_month_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'month_from is after month, or the range spans more than 12 months',
      recovery:
        'Send a month_from no later than month, making a range of at most 12 months counting both ends; with month omitted, the range ends at the latest published month.',
      severity: 'notice',
    },
    {
      reason: 'unknown_force',
      code: JsonRpcErrorCode.ValidationError,
      when: "force matches no listed force id or name, or more than one, or is 'btp' on area 'neighbourhood'",
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
      reason: 'range_too_large',
      code: JsonRpcErrorCode.ValidationError,
      when: "the range's months hold more records than one call keeps for a range",
      recovery:
        'Shorten the range or search a smaller area; each month alone, or a shorter range, may still fit.',
      severity: 'notice',
    },
    {
      reason: 'range_incomplete',
      code: JsonRpcErrorCode.Timeout,
      when: 'the months of the range could not all be fetched within the time one call allows',
      recovery:
        'Call again with the same input — the months already fetched are cached, so the repeat fetches only the rest — or shorten the range or search a smaller area.',
      retryable: true,
    },
    {
      reason: 'upstream_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'data.police.uk is not answering',
      recovery: 'data.police.uk is not answering right now; call this tool again in a few minutes.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'data.police.uk is rate-limiting this server for longer than this call can wait',
      recovery:
        'data.police.uk is rate-limiting this server; wait a few seconds, then call this tool again.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'pacer_shed',
      code: JsonRpcErrorCode.RateLimited,
      when: 'too many requests to data.police.uk are already queued in this server',
      recovery:
        "This server's queue for data.police.uk is busy; wait a few seconds, then call this tool again.",
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'retry_deadline_exceeded',
      code: JsonRpcErrorCode.Timeout,
      when: 'data.police.uk did not answer within the time one call allows',
      recovery:
        'data.police.uk did not answer within the time one call allows; call this tool again in a minute.',
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

    const service = getPoliceApiService();
    const budget = service.openBudget();
    const [window, named] = await Promise.all([
      resolveMonthWindow(input.month, input.month_from, service, ctx, budget),
      checkNamedForce(parsed.spec, service, ctx, budget),
    ]);
    if (window.kind !== 'ok') throw ctx.fail(window.kind, window.message);
    if (named.kind === 'unknown') throw ctx.fail('unknown_force', named.message);
    const { spec } = named;
    const { month } = window;
    const ranged = window.from !== undefined;
    const span = monthSpanLabel(window);

    const query = (target: AreaTarget, queried: string) => ({
      ...stopsQuery(target, queried),
      ...(spec.kind === 'point' ? { tooLargeHint: POINT_TOO_LARGE } : {}),
    });
    const mapPointOf = (stop: StopRecord) => stop.location?.map_point;
    const run = await runAreaWindow(spec, window, query, mapPointOf, service, ctx, budget);
    if (run.kind === 'range_incomplete' || run.kind === 'range_too_large') {
      throw ctx.fail(run.kind, rangeStopMessage(run, window));
    }
    if (run.kind === 'unknown_neighbourhood') {
      throw ctx.fail('unknown_neighbourhood', unknownNeighbourhoodMessage(run));
    }
    // /stops-at-location answers [] for an unknown id, so the boundary is the only lookup that misses.
    if (run.kind === 'unknown_location')
      throw internalError('Stop searches have no location lookup that misses.');

    const filters: StopFilter[] = (input.filters ?? []).map(({ field, value }) => ({
      field,
      value: String(value),
    }));
    // A range locates once, so one partial located set withholds `true` from every month.
    const partial = partialLocateNote(run);
    const byMonth = run.months.map(({ month: searched, records }) => ({
      month: searched,
      matched: matchStops(records, filters),
      ...publication(
        run.forces,
        window.availability.months.find((row) => row.month === searched)?.stopSearchForces,
        partial === undefined,
      ),
    }));
    const records = run.months.flatMap((entry) => entry.records);
    const matched = byMonth.flatMap((entry) => entry.matched);
    const total = matched.length;
    const page = pageOf(matched, input.offset, input.limit);
    ctx.enrich({ truncated: page.nextOffset !== undefined, shown: page.rows.length });

    const flags = byMonth.map((entry) => entry.published);
    const forcePublished = flags.includes(false)
      ? false
      : flags.every((flag) => flag === true)
        ? true
        : undefined;
    const skipped = run.forces
      .map((forceId) => ({
        forceId,
        months: byMonth
          .filter((entry) => entry.unpublished.includes(forceId))
          .map((entry) => entry.month),
      }))
      .filter((entry) => entry.months.length > 0);

    const notes: string[] = [];
    if (window.defaulted) notes.push(monthDefaultedNote(month, window.from));
    if (skipped.length > 0) {
      const names = await forceNames(named, service, ctx, budget);
      for (const { forceId, months: missed } of skipped) {
        notes.push(
          `${inline(names.get(forceId) ?? forceId)} has not published stop and search data for ${missed.join(', ')} to data.police.uk; call ukcrime_list_reference with topic 'availability' and force '${inline(forceId)}' for the months it has.`,
        );
      }
    }
    if (partial) notes.push(partial);
    if (total === 0) {
      if (filters.length > 0 && records.length > 0) {
        const fields = [...new Set(filters.map(({ field }) => field))];
        const present = fields.map((field) => {
          const values = breakdown(records, (stop) => stopValue(stop, field));
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
          `No stops at location ${spec.locationId} in ${span}; location ids come from earlier results, so check it or search area 'point'.`,
        );
      } else {
        const outside = outsideCoverageNote(spec, run);
        // The not-published fragments explain a zero only where no force found published in any month searched.
        const nonePublished =
          run.forces.length > 0 &&
          byMonth.every((entry) => entry.unpublished.length === run.forces.length);
        if (outside) notes.push(outside);
        else if (partial || !nonePublished) {
          notes.push(
            spec.kind === 'force'
              ? `No stops recorded for this force in ${span}; try another month.`
              : `No stops recorded here in ${span}; try another month, a wider area, or area 'force' for the whole force, including stops it could not place.`,
          );
        }
      }
    }
    const paging = pagingNote('stops', input.offset, page, total);
    if (paging) notes.push(paging);
    if (notes.length > 0) ctx.enrich.notice(notes.join(' '));

    return {
      ...(ranged ? { month_from: window.from } : {}),
      month,
      area: areaEcho(spec, run),
      filters,
      total,
      unfiltered_total: records.length,
      unplaced: matched.filter((stop) => !stop.location).length,
      ...(forcePublished !== undefined ? { force_published: forcePublished } : {}),
      ...(ranged
        ? {
            by_month: byMonth.map((entry) => ({
              month: entry.month,
              total: entry.matched.length,
              ...(entry.published !== undefined ? { force_published: entry.published } : {}),
            })),
          }
        : {}),
      ...stopBreakdowns(matched),
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
      `## Stop and search — ${inline(monthSpanLabel({ month: result.month, from: result.month_from }))}`,
      '',
      renderArea(result.area),
      `**Filters:** ${filters}`,
      `**Stops matched:** ${result.total} of ${result.unfiltered_total} · **Without a location:** ${result.unplaced}`,
    ];
    if (result.force_published !== undefined) {
      const when = result.month_from === undefined ? 'this month' : 'in every month of the range';
      lines.push(
        `**Every force found for the area published stop and search ${when}:** ${yesNo(result.force_published)}`,
      );
    }
    if (result.by_month) lines.push(...renderByMonth('Stops', result.by_month));
    const breakdowns = {
      type: result.by_type,
      self_defined_ethnicity: result.by_self_defined_ethnicity,
      officer_defined_ethnicity: result.by_officer_defined_ethnicity,
      outcome: result.by_outcome,
      object_of_search: result.by_object_of_search,
      legislation: result.by_legislation,
      age_range: result.by_age_range,
      gender: result.by_gender,
      outcome_linked_to_object_of_search: result.by_outcome_linked_to_object_of_search,
      removal_of_more_than_outer_clothing: result.by_removal_of_more_than_outer_clothing,
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
