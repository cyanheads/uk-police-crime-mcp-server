/**
 * @fileoverview Plumbing shared by the ukcrime area search tools: the described
 * area input fields and key aliases, the named-force check, month-failure
 * messages, the area run (neighbourhood boundary, the query, the parallel point
 * lookup), breakdowns, local paging over cached records, the area echo, and the
 * notice fragments every search composes. Failures come back as values so each
 * handler raises its own declared reason through `ctx.fail`.
 * @module mcp-server/tools/area-search
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { type AreaSpec, type AreaTarget, resolveTarget } from '@/services/police-api/area.js';
import {
  type AreaQuery,
  BTP_FORCE,
  type PoliceApiService,
} from '@/services/police-api/police-api-service.js';
import type {
  CallBudget,
  Force,
  LocatedNeighbourhood,
  Lookup,
  MapPoint,
  MonthResolution,
} from '@/services/police-api/types.js';
import type { AreaEcho, BreakdownRow } from './search-output.js';
import {
  latInput,
  lngInput,
  locationIdInput,
  monthInput,
  neighbourhoodIdInput,
  offsetInput,
  polygonInput,
} from './shared-schemas.js';

// --- Input -------------------------------------------------------------------

export const latField = latInput.describe("Latitude, WGS84 decimal degrees, for area 'point'.");

export const lngField = lngInput.describe("Longitude, WGS84 decimal degrees, for area 'point'.");

export const polygonField = polygonInput.describe(
  "For area 'polygon': 3–2,500 vertices as { lat, lng } objects, or the string 'lat,lng:lat,lng:…'. The ring closes itself (the last vertex joins the first). [lng, lat] pairs are not accepted.",
);

export const locationIdField = locationIdInput.describe(
  "For area 'location': location.location_id from an earlier result — one anonymised map point.",
);

export const neighbourhoodIdField = neighbourhoodIdInput.describe(
  "For area 'neighbourhood', with force: a neighbourhood id from ukcrime_list_reference topic 'neighbourhoods', or from ukcrime_find_neighbourhood for a point. Case-sensitive; only trimmed.",
);

export const monthField = monthInput.describe(
  'Month as YYYY-MM. Omitted: the latest published month, echoed as month in the result.',
);

export const offsetField = offsetInput.describe(
  'Rows to skip before this page; pass next_offset from the previous result. Default 0.',
);

/** Key aliases every search tool declares: the upstream's `date`, and common coordinate spellings. */
export const AREA_INPUT_ALIASES = {
  date: 'month',
  latitude: 'lat',
  longitude: 'lng',
  lon: 'lng',
  long: 'lng',
  poly: 'polygon',
} as const;

// --- Checks before the area query -----------------------------------------------

/** The force an area arm names, checked against the force list (`btp` only on the force arms). */
export type ForceCheck =
  | { readonly kind: 'none' }
  | { readonly force: Force; readonly kind: 'ok' }
  | { readonly kind: 'unknown'; readonly message: string };

export async function checkNamedForce(
  spec: AreaSpec,
  service: PoliceApiService,
  ctx: Context,
  budget: CallBudget,
): Promise<ForceCheck> {
  if (spec.kind !== 'neighbourhood' && spec.kind !== 'force_unplaced' && spec.kind !== 'force') {
    return { kind: 'none' };
  }
  const force = await service.findForce(spec.force, ctx, budget, {
    allowBtp: spec.kind !== 'neighbourhood',
  });
  if (force) return { kind: 'ok', force };
  return {
    kind: 'unknown',
    message:
      spec.force === BTP_FORCE.id
        ? 'British Transport Police has no neighbourhoods.'
        : `No police force '${spec.force}'.`,
  };
}

/** The message for a month the window rejects. */
export function monthFailureMessage(
  resolution: Exclude<MonthResolution, { readonly kind: 'ok' }>,
): string {
  return resolution.kind === 'not_published'
    ? `${resolution.month} is not published yet; the latest published month is ${resolution.availability.latest}.`
    : `${resolution.month} is before ${resolution.availability.earliest}, the earliest month data.police.uk still serves.`;
}

// --- The area run -----------------------------------------------------------------

/** An area query's outcome. The two misses map to the tools' declared reasons. */
export type AreaRun<T> =
  | { readonly kind: 'unknown_location' }
  | { readonly kind: 'unknown_neighbourhood' }
  | {
      readonly kind: 'ok';
      /**
       * The point lookup for area 'point': `found`, or `miss` (outside coverage).
       * Absent for other arms and when the lookup failed.
       */
      readonly located?: Lookup<LocatedNeighbourhood>;
      /** Cached records, shared and read-only: filter and page into new arrays. */
      readonly records: readonly T[];
      readonly target: AreaTarget;
    };

/**
 * The point lookup a search runs beside its area query. It feeds the echo and
 * the coverage notices, never the result itself: any failure other than a
 * cancellation degrades to `undefined`.
 */
async function locateQuietly(
  lat: number,
  lng: number,
  service: PoliceApiService,
  ctx: Context,
  budget: CallBudget,
): Promise<Lookup<LocatedNeighbourhood> | undefined> {
  try {
    return await service.locate(lat, lng, ctx, budget);
  } catch (error) {
    if (ctx.signal.aborted) throw error;
    ctx.log.warning('Point lookup failed; searching without the located force', {
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
}

/**
 * Resolves the area's target (a neighbourhood's boundary polygon), sends the
 * query `build` makes for it, and for a point runs `/locate-neighbourhood` in
 * parallel through the same pacer and budget.
 */
export async function runAreaQuery<T>(
  spec: AreaSpec,
  build: (target: AreaTarget) => AreaQuery<T>,
  service: PoliceApiService,
  ctx: Context,
  budget: CallBudget,
): Promise<AreaRun<T>> {
  const target = await resolveTarget(spec, service, ctx, budget);
  if (target.kind === 'miss') return { kind: 'unknown_neighbourhood' };
  const [result, located] = await Promise.all([
    service.queryArea(build(target.value), ctx, budget),
    spec.kind === 'point' ? locateQuietly(spec.lat, spec.lng, service, ctx, budget) : undefined,
  ]);
  // Only the crimes and outcomes location routes answer 404 as a miss.
  if (result.kind === 'miss') return { kind: 'unknown_location' };
  return {
    kind: 'ok',
    records: result.value,
    target: target.value,
    ...(located ? { located } : {}),
  };
}

/** The force a search is known to fall in: the one the arm names, or the point's located force. */
export function searchedForceId(
  named: ForceCheck,
  located: Lookup<LocatedNeighbourhood> | undefined,
): string | undefined {
  if (named.kind === 'ok') return named.force.id;
  return located?.kind === 'found' ? located.value.force : undefined;
}

/** The area echo: the arm's own fields, the polygon size searched, and what the point lookup found. */
export function areaEcho(
  spec: AreaSpec,
  target: AreaTarget,
  located: Lookup<LocatedNeighbourhood> | undefined,
): AreaEcho {
  switch (spec.kind) {
    case 'point':
      return {
        type: spec.kind,
        lat: spec.lat,
        lng: spec.lng,
        ...(located?.kind === 'found'
          ? {
              located_force: located.value.force,
              located_neighbourhood: located.value.neighbourhood,
            }
          : {}),
      };
    case 'polygon':
      return { type: spec.kind, vertex_count: spec.vertices.length };
    case 'location':
      return { type: spec.kind, location_id: spec.locationId };
    case 'neighbourhood':
      return {
        type: spec.kind,
        force: spec.force,
        neighbourhood_id: spec.neighbourhoodId,
        ...(target.kind === 'polygon' ? { vertex_count: target.vertices.length } : {}),
      };
    case 'force_unplaced':
    case 'force':
      return { type: spec.kind, force: spec.force };
  }
}

// --- Aggregation and paging --------------------------------------------------------

/** Bucket for records that carry no value for a breakdown field (and the filter value that matches them). */
export const NOT_RECORDED = '(not recorded)';

/** Counts records by value, absent values under {@link NOT_RECORDED}; sorted by count, then value. */
export function breakdown<T>(
  records: readonly T[],
  valueFor: (record: T) => string | undefined,
): BreakdownRow[] {
  const counts = new Map<string, number>();
  for (const record of records) {
    const value = valueFor(record) ?? NOT_RECORDED;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return Array.from(counts, ([value, count]) => ({ value, count })).sort(
    (a, b) => b.count - a.count || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0),
  );
}

/** A page of already-sorted records; `nextOffset` is set when rows remain after it. */
export function pageOf<T>(
  records: readonly T[],
  offset: number,
  limit: number,
): { readonly nextOffset?: number; readonly rows: readonly T[] } {
  const rows = records.slice(offset, offset + limit);
  const end = offset + rows.length;
  return end < records.length ? { rows, nextOffset: end } : { rows };
}

// --- Notice fragments ------------------------------------------------------------

/** `month` was omitted and the latest published month searched. */
export const monthDefaultedNote = (month: string): string =>
  `No month given; searched ${month}, the latest published month.`;

/** Bounding box of data.police.uk coverage, for the swapped-coordinate check. */
const COVERAGE_BOX = { minLat: 49.8, maxLat: 61.0, minLng: -8.7, maxLng: 2.0 };

const inCoverageBox = ({ latitude, longitude }: MapPoint): boolean =>
  latitude >= COVERAGE_BOX.minLat &&
  latitude <= COVERAGE_BOX.maxLat &&
  longitude >= COVERAGE_BOX.minLng &&
  longitude <= COVERAGE_BOX.maxLng;

/**
 * For a search with no hits: the point lies outside coverage (its lookup
 * answered 404), or every polygon vertex lies outside the coverage box.
 */
export function outsideCoverageNote(
  spec: AreaSpec,
  located: Lookup<LocatedNeighbourhood> | undefined,
): string | undefined {
  if (spec.kind === 'point' && located?.kind === 'miss') {
    return 'This point is outside data.police.uk coverage (England, Wales and Northern Ireland; Scotland only through British Transport Police); check that lat and lng are not swapped.';
  }
  if (spec.kind === 'polygon' && !spec.vertices.some(inCoverageBox)) {
    return 'This polygon lies outside data.police.uk coverage; each vertex is {lat, lng}, so check the two were not swapped.';
  }
  return;
}

/** An offset past the end, or the range a page shows and where the next one starts. */
export function pagingNote(
  noun: string,
  offset: number,
  page: { readonly nextOffset?: number; readonly rows: readonly unknown[] },
  total: number,
): string | undefined {
  if (total > 0 && offset >= total) {
    return `offset ${offset} is past the last of ${total} ${noun}; omit offset to start from the first.`;
  }
  if (page.nextOffset !== undefined) {
    return `Showing ${offset + 1}–${offset + page.rows.length} of ${total}; call again with offset ${page.nextOffset} for more.`;
  }
  return;
}
