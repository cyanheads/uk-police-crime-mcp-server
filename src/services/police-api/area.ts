/**
 * @fileoverview The area module. Checks a search tool's area input against its
 * arm, resolves a neighbourhood to its boundary polygon, and builds each area
 * route's request — route, method, params (`date` always included) and the
 * route's one normalizer — for PoliceApiService.queryArea: crimes, outcomes and
 * stops in a place, a force's unplaced crimes, and a force's stops.
 * @module services/police-api/area
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { type AreaQuery, type PoliceApiService, parseUpstream } from './police-api-service.js';
import { RawCrimes, RawOutcomes, RawStops } from './raw-schemas.js';
import { normalizeCrimes, normalizeOutcomes, normalizeStops } from './records.js';
import type {
  CallBudget,
  CrimeRecord,
  MapPoint,
  OutcomeRecord,
  Place,
  StopRecord,
} from './types.js';

/** Every area arm. Each search tool accepts a subset (crimes add `force_unplaced`, stops add `force`). */
export const AREA_KINDS = [
  'point',
  'polygon',
  'location',
  'neighbourhood',
  'force_unplaced',
  'force',
] as const;

export type AreaKind = (typeof AREA_KINDS)[number];

/** A search tool's area fields after schema normalization. */
export interface AreaFields {
  readonly force?: string | undefined;
  readonly lat?: number | undefined;
  readonly lng?: number | undefined;
  readonly location_id?: string | undefined;
  readonly neighbourhood_id?: string | undefined;
  readonly polygon?: readonly { readonly lat: number; readonly lng: number }[] | undefined;
}

type AreaField = keyof AreaFields;

/** The fields each arm requires; every other area field is rejected on that arm. */
const ARM_FIELDS: Readonly<Record<AreaKind, readonly AreaField[]>> = {
  point: ['lat', 'lng'],
  polygon: ['polygon'],
  location: ['location_id'],
  neighbourhood: ['force', 'neighbourhood_id'],
  force_unplaced: ['force'],
  force: ['force'],
};

const AREA_FIELDS: readonly AreaField[] = [
  'lat',
  'lng',
  'polygon',
  'location_id',
  'force',
  'neighbourhood_id',
];

/** A checked area input. Its force is the input as given until the force check puts the matched id in its place. */
export type AreaSpec =
  | { readonly kind: 'point'; readonly lat: number; readonly lng: number }
  | { readonly kind: 'polygon'; readonly vertices: readonly MapPoint[] }
  | { readonly kind: 'location'; readonly locationId: string }
  | { readonly kind: 'neighbourhood'; readonly force: string; readonly neighbourhoodId: string }
  | { readonly kind: 'force_unplaced' | 'force'; readonly force: string };

/** What an area query is sent for: a place, or a whole force (unplaced crimes, force stops). */
export type AreaTarget = Place | { readonly kind: 'force'; readonly force: string };

/** A neighbourhood id the force does not have: its boundary answered 404 (an unknown or wrongly cased id). */
export interface UnknownNeighbourhood {
  readonly force: string;
  readonly kind: 'unknown_neighbourhood';
  readonly neighbourhoodId: string;
}

const listFields = (fields: readonly string[]): string =>
  fields.length <= 1 ? (fields[0] ?? '') : `${fields.slice(0, -1).join(', ')} and ${fields.at(-1)}`;

function specOf(kind: AreaKind, fields: AreaFields): AreaSpec | undefined {
  switch (kind) {
    case 'point':
      return fields.lat !== undefined && fields.lng !== undefined
        ? { kind, lat: fields.lat, lng: fields.lng }
        : undefined;
    case 'polygon':
      return fields.polygon
        ? {
            kind,
            vertices: fields.polygon.map(({ lat, lng }) => ({ latitude: lat, longitude: lng })),
          }
        : undefined;
    case 'location':
      return fields.location_id !== undefined
        ? { kind, locationId: fields.location_id }
        : undefined;
    case 'neighbourhood':
      return fields.force !== undefined && fields.neighbourhood_id !== undefined
        ? { kind, force: fields.force, neighbourhoodId: fields.neighbourhood_id }
        : undefined;
    case 'force_unplaced':
    case 'force':
      return fields.force !== undefined ? { kind, force: fields.force } : undefined;
  }
}

/**
 * Checks the area fields against the chosen arm: every field the arm requires
 * is present and no other area field is. A failure carries the message for the
 * tool's `invalid_area` reason.
 */
export function parseArea(
  kind: AreaKind,
  fields: AreaFields,
):
  | { readonly ok: true; readonly spec: AreaSpec }
  | { readonly message: string; readonly ok: false } {
  const required = ARM_FIELDS[kind];
  const missing = required.filter((field) => fields[field] === undefined);
  const extra = AREA_FIELDS.filter(
    (field) => !required.includes(field) && fields[field] !== undefined,
  );
  const spec = specOf(kind, fields);
  if (spec && extra.length === 0) return { ok: true, spec };
  const problems: string[] = [];
  if (missing.length > 0) {
    problems.push(
      `area '${kind}' needs ${listFields(required)}; ${listFields(missing)} ${missing.length === 1 ? 'is' : 'are'} missing.`,
    );
  }
  if (extra.length > 0) {
    problems.push(
      `area '${kind}' does not use ${listFields(extra)}; remove ${extra.length === 1 ? 'it' : 'them'} or choose the area that takes ${extra.length === 1 ? 'it' : 'them'}.`,
    );
  }
  return { ok: false, message: problems.join(' ') };
}

/**
 * The target an area query is sent for. A neighbourhood becomes its boundary
 * polygon (404 → {@link UnknownNeighbourhood}); a force arm becomes the force;
 * every other arm maps directly.
 */
export async function resolveTarget(
  spec: AreaSpec,
  service: PoliceApiService,
  ctx: Context,
  budget: CallBudget,
): Promise<{ readonly kind: 'found'; readonly value: AreaTarget } | UnknownNeighbourhood> {
  switch (spec.kind) {
    case 'neighbourhood': {
      const boundary = await service.getBoundary(spec.force, spec.neighbourhoodId, ctx, budget);
      return boundary.kind === 'miss'
        ? {
            kind: 'unknown_neighbourhood',
            force: spec.force,
            neighbourhoodId: spec.neighbourhoodId,
          }
        : { kind: 'found', value: { kind: 'polygon', vertices: boundary.value } };
    }
    case 'force_unplaced':
    case 'force':
      return { kind: 'found', value: { kind: 'force', force: spec.force } };
    default:
      return { kind: 'found', value: spec };
  }
}

/** A polygon in the upstream `poly` form, `lat,lng:lat,lng:…`, rounded to 6 dp. */
export const polyParam = (vertices: readonly MapPoint[]): string =>
  vertices
    .map(({ latitude, longitude }) => `${latitude.toFixed(6)},${longitude.toFixed(6)}`)
    .join(':');

type PlaceRequest = Pick<AreaQuery<unknown>, 'method' | 'notFoundIsMiss' | 'params' | 'path'>;

/**
 * Route, method and params for a place. A point is a GET with `lat`,`lng` (the
 * upstream's 1-mile radius); a polygon always goes by POST as a form `poly`; a
 * location is a GET by `location_id`, whose 404 is a miss where the route lists
 * it (crimes, outcomes — stops answer `[]`).
 */
function placeRequest(
  place: Place,
  routes: { readonly area: string; readonly location: string },
  month: string,
  locationMisses: boolean,
): PlaceRequest {
  switch (place.kind) {
    case 'point':
      return {
        path: routes.area,
        params: { lat: place.lat.toFixed(6), lng: place.lng.toFixed(6), date: month },
      };
    case 'polygon':
      return {
        path: routes.area,
        method: 'POST',
        params: { poly: polyParam(place.vertices), date: month },
      };
    case 'location':
      return {
        path: routes.location,
        params: { location_id: place.locationId, date: month },
        notFoundIsMiss: locationMisses,
      };
  }
}

/**
 * Street-level crimes for one month: `/crimes-street/{category}` at a point or
 * polygon, `/crimes-at-location` (no category route — the caller filters), or a
 * force's unplaced crimes from `/crimes-no-location`.
 */
export function crimesQuery(
  target: AreaTarget,
  category: string,
  month: string,
): AreaQuery<CrimeRecord> {
  const request: PlaceRequest =
    target.kind === 'force'
      ? { path: '/crimes-no-location', params: { category, force: target.force, date: month } }
      : placeRequest(
          target,
          {
            area: `/crimes-street/${encodeURIComponent(category)}`,
            location: '/crimes-at-location',
          },
          month,
          true,
        );
  return {
    ...request,
    normalize: (json) => normalizeCrimes(parseUpstream(RawCrimes, json, request.path)),
  };
}

const OUTCOMES_DEADLINE_HINT =
  "data.police.uk is still preparing this month's outcomes, which can take longer than one call allows when the month has not been asked for recently; run the same search again shortly and it usually succeeds.";

/**
 * Police outcomes recorded in one month at a place (`/outcomes-at-location`,
 * every arm). The route answered months it had not served recently in 30–53 s
 * (2026-10-01) and keeps preparing one after a client gives up, so each attempt
 * runs to the retry deadline rather than being cut at 30 s and resent, and a
 * failure at the deadline says a repeat search shortly usually succeeds.
 */
export function outcomesQuery(place: Place, month: string): AreaQuery<OutcomeRecord> {
  const path = '/outcomes-at-location';
  return {
    ...placeRequest(place, { area: path, location: path }, month, true),
    attemptToDeadline: true,
    deadlineHint: OUTCOMES_DEADLINE_HINT,
    normalize: (json) => normalizeOutcomes(parseUpstream(RawOutcomes, json, path)),
  };
}

/**
 * Stop and search for one month: `/stops-street` at a point or polygon,
 * `/stops-at-location`, or a whole force (placed and unplaced) from `/stops-force`.
 */
export function stopsQuery(target: AreaTarget, month: string): AreaQuery<StopRecord> {
  const request: PlaceRequest =
    target.kind === 'force'
      ? { path: '/stops-force', params: { force: target.force, date: month } }
      : placeRequest(
          target,
          { area: '/stops-street', location: '/stops-at-location' },
          month,
          false,
        );
  return {
    ...request,
    normalize: (json) => normalizeStops(parseUpstream(RawStops, json, request.path)),
  };
}
