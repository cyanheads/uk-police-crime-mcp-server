/**
 * @fileoverview ukcrime_search_crimes — street-level crimes recorded in one
 * month inside an area (a point's 1-mile radius, a polygon, a snapped
 * location_id, a police neighbourhood) or a force's unplaced crimes: the total,
 * counts by category and latest outcome, the busiest map points, and a page.
 * @module mcp-server/tools/definitions/search-crimes.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
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
  breakdownSchema,
  LocationSchema,
  renderArea,
  renderBreakdown,
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
import { crimesQuery, parseArea } from '@/services/police-api/area.js';
import { coverageNotes, publishesNothing } from '@/services/police-api/known-gaps.js';
import { getPoliceApiService } from '@/services/police-api/police-api-service.js';
import { compareDigits } from '@/services/police-api/records.js';
import type { CrimeRecord } from '@/services/police-api/types.js';

const CRIME_AREAS = ['point', 'polygon', 'location', 'neighbourhood', 'force_unplaced'] as const;

const ALL_CRIME = 'all-crime';

const DATA_NOTE =
  "Locations are anonymised map points that each cover at least eight addresses, not where crimes happened. Area searches exclude crimes the force could not place; search area 'force_unplaced' for those. Each crime shows its latest police outcome; court results are not published.";

const POINT_TOO_LARGE =
  "A 1-mile circle here holds too many crimes for data.police.uk to answer (it can refuse an area holding more than about 10,000); search area 'polygon' with a smaller ring around the point.";

/** Most map points listed in `top_locations`. */
const TOP_LOCATIONS = 10;

const CrimeSchema = z
  .object({
    id: z.string().describe('data.police.uk crime id.'),
    persistent_id: z
      .string()
      .optional()
      .describe(
        'Id ukcrime_get_crime_outcomes takes. Absent when unpublished, always for anti-social behaviour.',
      ),
    category: z.string().describe('Category slug.'),
    month: z.string().describe('Month recorded, YYYY-MM.'),
    location: LocationSchema.optional().describe('Absent for crimes the force could not place.'),
    outcome: z
      .object({
        name: z.string().describe('Outcome as published.'),
        month: z.string().describe('Month recorded, YYYY-MM.'),
      })
      .optional()
      .describe(
        'Latest police outcome. Absent when unpublished, always for anti-social behaviour.',
      ),
    context: z.string().optional().describe('Force-written extra detail, when any.'),
  })
  .describe('One crime.');

const OutputSchema = z.object({
  month: z.string().describe('The month searched, YYYY-MM.'),
  area: AreaEchoSchema,
  category: z
    .object({
      slug: z.string().describe('Category slug searched; all-crime means every category.'),
      name: z.string().describe('Category display name.'),
    })
    .describe('The crime category searched.'),
  total: z.number().describe('Crimes matched in the area and month.'),
  by_category: breakdownSchema('Matched crimes by category slug, most first.'),
  by_outcome: breakdownSchema(
    "Matched crimes by latest police outcome, most first; anti-social behaviour is always '(not recorded)'.",
  ),
  top_locations: z
    .array(
      z
        .object({
          location_id: z.string().describe("Pass as location_id with area 'location'."),
          street_name: z.string().describe('Street as published.'),
          count: z.number().describe('Matched crimes here.'),
          map_point: z
            .object({
              latitude: z.number().describe('Latitude, WGS84.'),
              longitude: z.number().describe('Longitude, WGS84.'),
            })
            .optional()
            .describe('Anonymised map point, not where crimes happened.'),
        })
        .describe('One map point and its crime count.'),
    )
    .optional()
    .describe(
      "Up to 10 map points holding the most matched crimes. Absent for area 'force_unplaced'.",
    ),
  crimes: z
    .array(CrimeSchema)
    .describe('This page of matched crimes, by category, then location_id, then id.'),
  next_offset: z
    .number()
    .optional()
    .describe('Pass as offset for the next page; absent on the last page.'),
});

type CrimesOutput = z.infer<typeof OutputSchema>;

/** The map points holding the most crimes, most first, then by location id. */
function topLocations(crimes: readonly CrimeRecord[]): NonNullable<CrimesOutput['top_locations']> {
  const counts = new Map<string, NonNullable<CrimesOutput['top_locations']>[number]>();
  for (const { location } of crimes) {
    if (!location) continue;
    const entry = counts.get(location.location_id);
    if (entry) entry.count += 1;
    else {
      counts.set(location.location_id, {
        location_id: location.location_id,
        street_name: location.street_name,
        count: 1,
        ...(location.map_point ? { map_point: location.map_point } : {}),
      });
    }
  }
  return Array.from(counts.values())
    .sort((a, b) => b.count - a.count || compareDigits(a.location_id, b.location_id))
    .slice(0, TOP_LOCATIONS);
}

export const searchCrimesTool = tool('ukcrime_search_crimes', {
  title: 'Search UK Street-Level Crimes',
  description:
    "Search street-level crimes recorded in one month inside an area — a point with a 1-mile radius, a polygon, a snapped location_id from an earlier result, or a police neighbourhood — or list the crimes a force could not place on the map (area 'force_unplaced'). Returns the total, counts by category and by latest police outcome, the busiest map points, and a page of crimes, each with the persistent_id that ukcrime_get_crime_outcomes takes; for what police resolved in a month, whenever the crime was recorded, use ukcrime_search_outcomes. Locations are anonymised map points, not crime sites. data.police.uk can refuse an area holding more than about 10,000 crimes, whatever the category — then search smaller polygons.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    area: z
      .enum(CRIME_AREAS)
      .describe(
        "Area to search: 'point' (lat and lng; a 1-mile radius), 'polygon' (polygon), 'location' (location_id), 'neighbourhood' (force and neighbourhood_id), or 'force_unplaced' (force alone: the crimes that force could not place on the map). An area field the chosen area does not use is rejected.",
      ),
    lat: latField,
    lng: lngField,
    polygon: polygonField,
    location_id: locationIdField,
    force: forceInput.describe(
      "Force id such as 'leicestershire' (ukcrime_list_reference topic 'forces' lists them); trimmed, lower-cased, spaces and underscores become hyphens. For area 'neighbourhood' (with neighbourhood_id) and 'force_unplaced' (alone), where 'btp' (British Transport Police) is also accepted.",
    ),
    neighbourhood_id: neighbourhoodIdField,
    month: monthField,
    category: categoryInput.describe(
      "Crime category slug such as 'burglary', or its display name such as 'Violence and sexual offences'; case-insensitive, and spaces, underscores and hyphens match each other ('vehicle_crime' finds 'vehicle-crime'). Omitted: every category (all-crime). ukcrime_list_reference topic 'categories' lists them.",
    ),
    limit: limitInput(25).describe('Crimes on this page, 1–200. Default 25.'),
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
        "Send lat and lng for area 'point', polygon for 'polygon', location_id for 'location', force and neighbourhood_id for 'neighbourhood', or force alone for 'force_unplaced'.",
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
        "Call ukcrime_list_reference with topic 'categories' for valid slugs such as 'burglary', or omit category to search all crime.",
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
      reason: 'unknown_location',
      code: JsonRpcErrorCode.NotFound,
      when: 'data.police.uk holds no map point with this location_id',
      recovery:
        "Use a location_id from the location of an earlier ukcrime_search_crimes result, or search area 'point' with lat and lng.",
      severity: 'notice',
    },
    {
      reason: 'area_too_large',
      code: JsonRpcErrorCode.ValidationError,
      when: 'the area is too large to answer: data.police.uk can refuse one holding more than about 10,000 crimes',
      recovery:
        "Search a smaller area: split the polygon into smaller polygons, or for a neighbourhood call ukcrime_find_neighbourhood with include ['boundary'] and search parts of that polygon with area 'polygon'. The limit of about 10,000 crimes counts every category, so a narrower category does not help.",
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
      service.findCategory(input.category ?? ALL_CRIME, ctx, budget),
      checkNamedForce(spec, service, ctx, budget),
    ]);
    if (resolution.kind === 'not_published') {
      throw ctx.fail('month_not_published', monthFailureMessage(resolution));
    }
    if (resolution.kind === 'out_of_range') {
      throw ctx.fail('month_out_of_range', monthFailureMessage(resolution));
    }
    if (!category) {
      throw ctx.fail('unknown_category', `No crime category matches '${input.category}'.`);
    }
    if (named.kind === 'unknown') throw ctx.fail('unknown_force', named.message);
    const { month } = resolution;

    const run = await runAreaQuery(
      spec,
      (target) => ({
        ...crimesQuery(target, category.slug, month),
        ...(spec.kind === 'point' ? { tooLargeHint: POINT_TOO_LARGE } : {}),
      }),
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

    const narrowed = category.slug !== ALL_CRIME;
    // The location route takes no category, so a narrowed search filters locally.
    const matched =
      spec.kind === 'location' && narrowed
        ? run.records.filter((crime) => crime.category === category.slug)
        : run.records;
    const total = matched.length;
    const page = pageOf(matched, input.offset, input.limit);
    ctx.enrich({ truncated: page.nextOffset !== undefined, shown: page.rows.length });

    const notes: string[] = [];
    if (resolution.defaulted) notes.push(monthDefaultedNote(month));
    const forceId = searchedForceId(named, run.located);
    if (forceId) {
      notes.push(
        ...coverageNotes(
          forceId,
          spec.kind === 'force_unplaced' ? ['crime', 'asb'] : ['crime', 'locations', 'asb'],
        ),
      );
    }
    // A force that publishes no crime data is explained by its coverage note alone.
    const silentForce = forceId !== undefined && publishesNothing(forceId, 'crime');
    if (total === 0 && !(spec.kind === 'force_unplaced' && !narrowed && silentForce)) {
      notes.push(
        outsideCoverageNote(spec, run.located) ??
          (narrowed
            ? `Only ${inline(category.name)} was searched; omit category to search all crime.`
            : spec.kind === 'force_unplaced'
              ? `This force recorded no crimes without a location in ${month}; the other areas cover the crimes it placed.`
              : `Nothing recorded here in ${month}. A force can miss a month the API still lists as published (https://data.police.uk/changelog/); try another month, a wider area, or area 'force_unplaced' for crimes the force could not place.`),
      );
    }
    const paging = pagingNote('crimes', input.offset, page, total);
    if (paging) notes.push(paging);
    if (notes.length > 0) ctx.enrich.notice(notes.join(' '));

    return {
      month,
      area: areaEcho(spec, run.target, run.located),
      category: { slug: category.slug, name: category.name },
      total,
      by_category: breakdown(matched, (crime) => crime.category),
      by_outcome: breakdown(matched, (crime) => crime.outcome?.name),
      ...(spec.kind === 'force_unplaced' ? {} : { top_locations: topLocations(matched) }),
      crimes: [...page.rows],
      ...(page.nextOffset !== undefined ? { next_offset: page.nextOffset } : {}),
    };
  },

  format: (result) => {
    const lines = [
      `## Street-level crimes — ${inline(result.month)}`,
      '',
      renderArea(result.area),
      `**Category:** ${inline(result.category.name)} (${inline(result.category.slug)})`,
      `**Crimes matched:** ${result.total}`,
      ...renderBreakdown('By category', result.by_category),
      ...renderBreakdown('By latest police outcome', result.by_outcome),
    ];

    if (result.top_locations) {
      lines.push('', '### Busiest anonymised map points');
      if (result.top_locations.length === 0) {
        lines.push('', '_None._');
      } else {
        lines.push(
          '',
          '| Location id | Street | Crimes | Anonymised map point |',
          '|:--|:--|--:|:--|',
        );
        for (const spot of result.top_locations) {
          const point = spot.map_point
            ? `${spot.map_point.latitude}, ${spot.map_point.longitude}`
            : '—';
          lines.push(
            `| ${cell(spot.location_id)} | ${cell(spot.street_name)} | ${spot.count} | ${point} |`,
          );
        }
      }
    }

    lines.push('', `### Crimes on this page (${result.crimes.length})`);
    if (result.crimes.length === 0) lines.push('', '_None._');
    else lines.push('');
    for (const [index, crime] of result.crimes.entries()) {
      // A blank line closes the previous crime's quoted context.
      if (result.crimes[index - 1]?.context) lines.push('');
      const head = [`**${inline(crime.category)}**`, `id ${inline(crime.id)}`, inline(crime.month)];
      if (crime.persistent_id) head.push(`persistent_id ${inline(crime.persistent_id)}`);
      lines.push(`- ${head.join(' · ')}`);
      if (crime.location) lines.push(`  - Location: ${renderLocation(crime.location)}`);
      if (crime.outcome) {
        lines.push(
          `  - Latest outcome: ${inline(crime.outcome.name)} (${inline(crime.outcome.month)})`,
        );
      }
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
