/**
 * @fileoverview Plumbing shared by the ukcrime area search tools: the described
 * area input fields and key aliases, the named-force check, month-failure
 * messages, month ranges (`month_from` checks and the two-at-a-time month
 * runner), the area run (neighbourhood boundary, the query, and the
 * `/locate-neighbourhood` lookups that find the forces for an area),
 * breakdowns, local paging over cached records, the area echo, and the notice
 * fragments every search composes. Failures come back as values so each
 * handler raises its own declared reason through `ctx.fail`.
 * @module mcp-server/tools/area-search
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  type AreaSpec,
  type AreaTarget,
  resolveTarget,
  type UnknownNeighbourhood,
} from '@/services/police-api/area.js';
import {
  type AreaQuery,
  type PoliceApiService,
  RANGE_MAX_WEIGHT,
} from '@/services/police-api/police-api-service.js';
import { compareText } from '@/services/police-api/records.js';
import type {
  Availability,
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

/**
 * The force an area arm names, matched against the force list by id or display
 * name (`btp` only on the force arms). `spec` is the area to search from here
 * on: on a force arm it carries the matched id in place of the input, so the
 * boundary path, the force parameter and the echo never see a display name.
 */
export type ForceCheck =
  | { readonly kind: 'none'; readonly spec: AreaSpec }
  | { readonly force: Force; readonly kind: 'ok'; readonly spec: AreaSpec }
  | { readonly kind: 'unknown'; readonly message: string };

export async function checkNamedForce(
  spec: AreaSpec,
  service: PoliceApiService,
  ctx: Context,
  budget: CallBudget,
): Promise<ForceCheck> {
  if (!('force' in spec)) return { kind: 'none', spec };
  const match = await service.findForce(spec.force, ctx, budget, {
    allowBtp: spec.kind !== 'neighbourhood',
  });
  if (match.kind === 'unknown') return match;
  return { kind: 'ok', force: match.force, spec: { ...spec, force: match.force.id } };
}

/** The message for a month the window rejects, prefixed with the field that sent it when given. */
export function monthFailureMessage(
  resolution: Exclude<MonthResolution, { readonly kind: 'ok' }>,
  field?: string,
): string {
  const month = field ? `${field} ${resolution.month}` : resolution.month;
  return resolution.kind === 'not_published'
    ? `${month} is not published yet; the latest published month is ${resolution.availability.latest}.`
    : `${month} is before ${resolution.availability.earliest}, the earliest month data.police.uk still serves.`;
}

// --- Month ranges -------------------------------------------------------------------

/** Most months one range covers, `month_from` through `month`. */
const RANGE_MAX_MONTHS = 12;

/**
 * Months of a range one call keeps queued or in flight: two of the service's
 * three area slots, so a range always leaves one for other calls.
 */
const MONTHS_IN_FLIGHT = 2;

export const monthFromField = monthInput.describe(
  'First month of a range, YYYY-MM, searched through month — up to 12 months, with a total for each in by_month. Omitted: month alone.',
);

export const rangeEndMonthField = monthInput.describe(
  'Month as YYYY-MM, or the last month of the range with month_from. Omitted: the latest published month, echoed as month in the result.',
);

/** `YYYY-MM` as a count of months, so a range is arithmetic. */
const monthNumber = (month: string): number => {
  const [year = 0, monthOfYear = 0] = month.split('-').map(Number);
  return year * 12 + monthOfYear - 1;
};

const monthAt = (n: number): string =>
  `${Math.floor(n / 12)}-${String((n % 12) + 1).padStart(2, '0')}`;

/** The months a search covers. */
export interface MonthWindow {
  readonly availability: Availability;
  /** `month` was omitted: the search ends at the latest published month. */
  readonly defaulted: boolean;
  /** `month_from`, when given. */
  readonly from?: string;
  /** The month searched, or the last month of the range. */
  readonly month: string;
  /** Every month searched, oldest first; `month` alone without `from`. */
  readonly months: readonly string[];
}

/** A window, or the declared reason its months fail with the message for it. */
export type MonthWindowCheck =
  | ({ readonly kind: 'ok' } & MonthWindow)
  | {
      readonly kind: 'invalid_month_range' | 'month_not_published' | 'month_out_of_range';
      readonly message: string;
    };

const monthRejected = (
  resolution: Exclude<MonthResolution, { readonly kind: 'ok' }>,
  field?: string,
): MonthWindowCheck => ({
  kind: resolution.kind === 'not_published' ? 'month_not_published' : 'month_out_of_range',
  message: monthFailureMessage(resolution, field),
});

/**
 * Resolves `month` (omitted → the latest published month), then `month_from`
 * when given, before any area request: each must lie in the published window
 * (never clipped to it), and `month_from` may not follow `month` or make the
 * range longer than {@link RANGE_MAX_MONTHS} months. With `month` omitted the
 * span depends on the latest month, so this is a handler check, not a schema
 * refinement.
 */
export async function resolveMonthWindow(
  month: string | undefined,
  monthFrom: string | undefined,
  service: PoliceApiService,
  ctx: Context,
  budget: CallBudget,
): Promise<MonthWindowCheck> {
  const end = await service.resolveMonth(month, ctx, budget);
  if (end.kind !== 'ok') return monthRejected(end);
  if (monthFrom === undefined) {
    const { availability, defaulted } = end;
    return { kind: 'ok', availability, defaulted, month: end.month, months: [end.month] };
  }
  const start = await service.resolveMonth(monthFrom, ctx, budget);
  if (start.kind !== 'ok') return monthRejected(start, 'month_from');
  const span = monthNumber(end.month) - monthNumber(monthFrom) + 1;
  if (span < 1) {
    return {
      kind: 'invalid_month_range',
      message: `month_from ${monthFrom} is after month ${end.month}; month_from is the first month of the range.`,
    };
  }
  if (span > RANGE_MAX_MONTHS) {
    return {
      kind: 'invalid_month_range',
      message: `${monthFrom}–${end.month} covers ${span} months; a range covers at most ${RANGE_MAX_MONTHS}, so for month ${end.month} month_from can be ${monthAt(monthNumber(end.month) - RANGE_MAX_MONTHS + 1)} at the earliest.`,
    };
  }
  return {
    kind: 'ok',
    availability: start.availability,
    defaulted: end.defaulted,
    from: monthFrom,
    month: end.month,
    months: Array.from({ length: span }, (_, i) => monthAt(monthNumber(monthFrom) + i)),
  };
}

/** How a notice names the months searched: `from–to`, or the one month. */
export const monthSpanLabel = ({
  from,
  month,
}: {
  readonly from?: string | undefined;
  readonly month: string;
}): string => (from !== undefined && from !== month ? `${from}–${month}` : month);

// --- The area run -----------------------------------------------------------------

/**
 * Polygon sample lookups one call keeps queued or in flight: two of the pacer's
 * four slots, so with the area requests sent beside them — a single-month
 * search's one query, or the two months a range keeps in flight — one call
 * never holds more requests than the pacer runs at once (Design Decision 12).
 */
const SAMPLE_LOCATES_IN_FLIGHT = 2;

/** Longest a call's lookups may hold its search: they only annotate the result, so past this they are skipped. */
const LOCATE_BUDGET_MS = 10_000;

/** Bounding box of data.police.uk coverage: no point outside it can locate, and a polygon with no vertex in it reads as swapped coordinates. */
const COVERAGE_BOX = { minLat: 49.8, maxLat: 61.0, minLng: -8.7, maxLng: 2.0 };

const inCoverageBox = ({ latitude, longitude }: MapPoint): boolean =>
  latitude >= COVERAGE_BOX.minLat &&
  latitude <= COVERAGE_BOX.maxLat &&
  longitude >= COVERAGE_BOX.minLng &&
  longitude <= COVERAGE_BOX.maxLng;

/** One `/locate-neighbourhood` answer: `found`, or `miss` (outside coverage). */
type Located = Lookup<LocatedNeighbourhood>;

/** The lookups an area run made: one for a point or a location's map point, one per sample point for a polygon. */
interface AreaLookups {
  /**
   * The lookup of a point, or of a location's map point. Absent for other arms,
   * when the lookup failed, and for a location with no record carrying a map point.
   */
  readonly located?: Located;
  /**
   * A polygon's sample-point lookups in {@link samplePoints} order, `undefined`
   * where one failed; empty when no vertex lies in the coverage box. Absent for
   * other arms.
   */
  readonly samples?: readonly (Located | undefined)[];
}

/** The forces an area is known to fall in, and the lookups that found them. Read once per call, whatever the month. */
export interface AreaForces extends AreaLookups {
  /**
   * Distinct force ids in code-unit order: the force a named arm matched, or
   * every force a lookup found. Empty when no force is known.
   */
  readonly forces: readonly string[];
}

/** An area query's outcome. The two misses map to the tools' declared reasons. */
export type AreaRun<T> =
  | { readonly kind: 'unknown_location' }
  | UnknownNeighbourhood
  | (AreaForces & {
      readonly kind: 'ok';
      /** Cached records, shared and read-only: filter and page into new arrays. */
      readonly records: readonly T[];
      readonly target: AreaTarget;
    });

/** A point as `/locate-neighbourhood` is sent and cached: `lat,lng` at 6 dp. */
const locateKey = ({ latitude, longitude }: MapPoint): string =>
  `${latitude.toFixed(6)},${longitude.toFixed(6)}`;

/**
 * The points that locate a polygon's forces: the bounding-box centre (it can
 * fall in a force no vertex reaches, such as one enclosed by the ring), then
 * the northernmost, southernmost, easternmost and westernmost vertices, the
 * first of any tie. Repeats at 6 dp are dropped, so at most five. None when no
 * vertex lies in the coverage box, where every lookup would answer 404.
 */
export function samplePoints(vertices: readonly MapPoint[]): MapPoint[] {
  if (!vertices.some(inCoverageBox)) return [];
  const extreme = (beats: (a: MapPoint, b: MapPoint) => boolean): MapPoint =>
    vertices.reduce((best, vertex) => (beats(vertex, best) ? vertex : best));
  const north = extreme((a, b) => a.latitude > b.latitude);
  const south = extreme((a, b) => a.latitude < b.latitude);
  const east = extreme((a, b) => a.longitude > b.longitude);
  const west = extreme((a, b) => a.longitude < b.longitude);
  const centre = {
    latitude: (north.latitude + south.latitude) / 2,
    longitude: (east.longitude + west.longitude) / 2,
  };
  const seen = new Set<string>();
  return [centre, north, south, east, west].filter((point) => {
    const key = locateKey(point);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * One point lookup. It feeds the echo and the coverage notices, never the
 * result itself: any failure other than a cancellation degrades to `undefined`.
 * `budget` is the lookups' share of the call's, so a lookup refused for a spent
 * budget is logged as skipped, never as the call running out of time.
 */
async function locateQuietly(
  point: MapPoint,
  service: PoliceApiService,
  ctx: Context,
  budget: CallBudget,
): Promise<Located | undefined> {
  try {
    return await service.locate(point.latitude, point.longitude, ctx, budget);
  } catch (error) {
    if (ctx.signal.aborted) throw error;
    if (error instanceof McpError && error.data?.reason === 'call_budget_exhausted') {
      ctx.log.warning(
        'Point lookup skipped: the time allowed for lookups ran out before it was sent; searching without the located force',
      );
      return;
    }
    ctx.log.warning('Point lookup failed; searching without the located force', {
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
}

/**
 * Locates a polygon's sample points. The shared pacer bounds requests in flight
 * process-wide, not per call, so workers sharing one iterator keep this call to
 * {@link SAMPLE_LOCATES_IN_FLIGHT} lookups queued or in flight.
 */
async function locateSamples(
  points: readonly MapPoint[],
  service: PoliceApiService,
  ctx: Context,
  budget: CallBudget,
): Promise<(Located | undefined)[]> {
  const pending = points.entries();
  const lookups: (Located | undefined)[] = [];
  const worker = async () => {
    for (const [index, point] of pending) {
      lookups[index] = await locateQuietly(point, service, ctx, budget);
    }
  };
  await Promise.all(Array.from({ length: SAMPLE_LOCATES_IN_FLIGHT }, worker));
  return lookups;
}

/** The lookups a point or polygon search sends beside its area query, all inside {@link LOCATE_BUDGET_MS}. */
async function locateBeside(
  spec: AreaSpec,
  service: PoliceApiService,
  ctx: Context,
  callBudget: CallBudget,
): Promise<AreaLookups> {
  const budget = service.narrowBudget(callBudget, LOCATE_BUDGET_MS);
  if (spec.kind === 'point') {
    const located = await locateQuietly(
      { latitude: spec.lat, longitude: spec.lng },
      service,
      ctx,
      budget,
    );
    return located ? { located } : {};
  }
  if (spec.kind === 'polygon') {
    return { samples: await locateSamples(samplePoints(spec.vertices), service, ctx, budget) };
  }
  return {};
}

/**
 * A location's lookup, once its records are in: the map point they share, from
 * the first record carrying one, inside {@link LOCATE_BUDGET_MS}.
 */
async function locateRecords<T>(
  records: readonly T[],
  mapPointOf: (record: T) => MapPoint | undefined,
  service: PoliceApiService,
  ctx: Context,
  budget: CallBudget,
): Promise<AreaLookups> {
  for (const record of records) {
    const point = mapPointOf(record);
    if (!point) continue;
    const located = await locateQuietly(
      point,
      service,
      ctx,
      service.narrowBudget(budget, LOCATE_BUDGET_MS),
    );
    return located ? { located } : {};
  }
  return {};
}

/** The forces a run knows: the named arm's matched id, or every force its lookups found. */
function forcesOf(spec: AreaSpec, { located, samples = [] }: AreaLookups): string[] {
  if ('force' in spec) return [spec.force];
  const found = [located, ...samples].flatMap((lookup) =>
    lookup?.kind === 'found' ? [lookup.value.force] : [],
  );
  return [...new Set(found)].sort(compareText);
}

/**
 * Resolves the area's target (a neighbourhood's boundary polygon), sends the
 * query `build` makes for it, and finds the forces for the area, every request
 * through the same pacer and budget: a point is located, and a polygon's sample
 * points, beside the query; a location's map point (read with `mapPointOf`) once
 * the query has answered. Lookups get {@link LOCATE_BUDGET_MS} of the budget, and
 * one that fails adds no force. Named arms carry their force.
 */
export async function runAreaQuery<T>(
  spec: AreaSpec,
  build: (target: AreaTarget) => AreaQuery<T>,
  mapPointOf: (record: T) => MapPoint | undefined,
  service: PoliceApiService,
  ctx: Context,
  budget: CallBudget,
): Promise<AreaRun<T>> {
  const target = await resolveTarget(spec, service, ctx, budget);
  if (target.kind === 'unknown_neighbourhood') return target;
  const [result, beside] = await Promise.all([
    service.queryArea(build(target.value), ctx, budget),
    locateBeside(spec, service, ctx, budget),
  ]);
  // Only the crimes and outcomes location routes answer 404 as a miss.
  if (result.kind === 'miss') return { kind: 'unknown_location' };
  const lookups =
    spec.kind === 'location'
      ? await locateRecords(result.value, mapPointOf, service, ctx, budget)
      : beside;
  return {
    kind: 'ok',
    records: result.value,
    target: target.value,
    forces: forcesOf(spec, lookups),
    ...lookups,
  };
}

/** One month of a range and its cached records (shared and read-only). */
export interface MonthRecords<T> {
  readonly month: string;
  readonly records: readonly T[];
}

/**
 * Why a range stopped starting months: time ran short (`month` is the first not
 * started), or the months grew too heavy to keep — `month` is the first month
 * whose projected weight passed {@link RANGE_MAX_WEIGHT}, never started, or the
 * month whose landing took the total past it.
 */
export type RangeStop =
  | { readonly fetched: number; readonly kind: 'range_incomplete'; readonly month: string }
  | { readonly kind: 'range_too_large'; readonly month: string };

/** A range run's outcome: the misses and stops map to the tools' declared reasons. */
export type RangeRun<T> =
  | { readonly kind: 'unknown_location' }
  | UnknownNeighbourhood
  | RangeStop
  | (AreaForces & {
      readonly kind: 'ok';
      /** Every month of the range, oldest first. */
      readonly months: readonly MonthRecords<T>[];
      readonly target: AreaTarget;
    });

/**
 * Queries each month, {@link MONTHS_IN_FLIGHT} workers sharing one month list,
 * so the call never holds more than two area requests queued or in flight. A
 * month starts only while the weight landed plus the projected weight of the
 * months in flight, itself included, stays within {@link RANGE_MAX_WEIGHT} —
 * each projected at the heaviest month landed so far, so nothing is projected
 * before the first lands — and then only while one full attempt fits in the
 * budget, checked again when it is sent, after any wait behind other calls.
 * The first month that fails (or, on a location, answers 404) stops the
 * dispatch; so do a projection past the bound, months landed weighing more
 * than it, and a budget too short for another month. Months in flight then
 * land — and stay cached — before the run settles: the first failure or 404
 * wins (a failure rethrows, a 404 is `unknown_location`), and either outranks
 * a stop, which is returned.
 */
async function fetchMonths<T>(
  months: readonly string[],
  query: (month: string) => AreaQuery<T>,
  service: PoliceApiService,
  ctx: Context,
  budget: CallBudget,
): Promise<
  | { readonly kind: 'ok'; readonly months: MonthRecords<T>[] }
  | { readonly kind: 'unknown_location' }
  | RangeStop
> {
  const fetched: MonthRecords<T>[] = [];
  const pending = months.values();
  let weight = 0;
  /** The heaviest month landed: what each month in flight is projected to weigh. */
  let heaviest = 0;
  /** Months started whose answer has not landed. */
  let inFlight = 0;
  let failure: { readonly error: unknown } | 'miss' | undefined;
  let stop: { readonly kind: RangeStop['kind']; readonly month: string } | undefined;
  /** A month answered `late` was never sent: the range stops as if it had not started, at the earliest such month. */
  const stopLate = (month: string) => {
    if (!stop || (stop.kind === 'range_incomplete' && compareText(month, stop.month) < 0)) {
      stop = { kind: 'range_incomplete', month };
    }
  };
  const worker = async () => {
    for (const month of pending) {
      if (failure || stop) return;
      if (weight + (inFlight + 1) * heaviest > RANGE_MAX_WEIGHT) {
        stop = { kind: 'range_too_large', month };
        return;
      }
      if (!service.fitsAttempt(budget)) {
        stop = { kind: 'range_incomplete', month };
        return;
      }
      inFlight += 1;
      try {
        const answer = await service.queryRangeMonth(query(month), ctx, budget);
        if (answer.kind === 'miss') {
          failure ??= 'miss';
          return;
        }
        if (answer.kind === 'late') {
          stopLate(month);
          return;
        }
        fetched.push({ month, records: answer.value });
        weight += answer.weight;
        heaviest = Math.max(heaviest, answer.weight);
        if (weight > RANGE_MAX_WEIGHT) stop ??= { kind: 'range_too_large', month };
      } catch (error) {
        failure ??= { error };
      } finally {
        inFlight -= 1;
      }
    }
  };
  await Promise.all(Array.from({ length: MONTHS_IN_FLIGHT }, worker));
  if (failure === 'miss') return { kind: 'unknown_location' };
  if (failure) throw failure.error;
  if (stop?.kind === 'range_incomplete') return { ...stop, fetched: fetched.length };
  if (stop) return { kind: stop.kind, month: stop.month };
  return { kind: 'ok', months: fetched.sort((a, b) => compareText(a.month, b.month)) };
}

/**
 * {@link runAreaQuery} over a range of months: the target resolved once (one
 * boundary read), each month queried through {@link fetchMonths}, and the forces
 * found once for the whole range — a point and a polygon's sample points beside
 * the months, a location's map point from the first record carrying one, in
 * month order (a month can be empty).
 */
async function runAreaRange<T>(
  spec: AreaSpec,
  months: readonly string[],
  build: (target: AreaTarget, month: string) => AreaQuery<T>,
  mapPointOf: (record: T) => MapPoint | undefined,
  service: PoliceApiService,
  ctx: Context,
  budget: CallBudget,
): Promise<RangeRun<T>> {
  const target = await resolveTarget(spec, service, ctx, budget);
  if (target.kind === 'unknown_neighbourhood') return target;
  const [fetched, beside] = await Promise.all([
    fetchMonths(months, (month) => build(target.value, month), service, ctx, budget),
    locateBeside(spec, service, ctx, budget),
  ]);
  if (fetched.kind !== 'ok') return fetched;
  const lookups =
    spec.kind === 'location'
      ? await locateRecords(
          fetched.months.flatMap(({ records }) => records),
          mapPointOf,
          service,
          ctx,
          budget,
        )
      : beside;
  return {
    kind: 'ok',
    months: fetched.months,
    target: target.value,
    forces: forcesOf(spec, lookups),
    ...lookups,
  };
}

/**
 * Runs a search's window: {@link runAreaQuery} for its one month, or
 * {@link runAreaRange} when `month_from` was given (a one-month range
 * included). Either way the records come back by month.
 */
export async function runAreaWindow<T>(
  spec: AreaSpec,
  window: MonthWindow,
  build: (target: AreaTarget, month: string) => AreaQuery<T>,
  mapPointOf: (record: T) => MapPoint | undefined,
  service: PoliceApiService,
  ctx: Context,
  budget: CallBudget,
): Promise<RangeRun<T>> {
  if (window.from !== undefined) {
    return runAreaRange(spec, window.months, build, mapPointOf, service, ctx, budget);
  }
  const run = await runAreaQuery(
    spec,
    (target) => build(target, window.month),
    mapPointOf,
    service,
    ctx,
    budget,
  );
  if (run.kind !== 'ok') return run;
  const { records, ...found } = run;
  return { ...found, months: [{ month: window.month, records }] };
}

/**
 * The message for a range that stopped starting months. A size stop's month
 * may never have been fetched (its projected weight passed the bound) or may be
 * the month whose landing did; either way the range would pass the bound there.
 * A one-month range stops for size only on a month a single-month search still
 * answers, uncached.
 */
export function rangeStopMessage(stop: RangeStop, window: MonthWindow): string {
  const span = monthSpanLabel(window);
  const count = window.months.length;
  if (stop.kind === 'range_too_large') {
    return count === 1
      ? `${span} holds more records than one call keeps for a range; search it without month_from.`
      : `The ${count} months of ${span} hold more records than one call keeps for a range; it would pass that limit at ${stop.month}.`;
  }
  if (stop.fetched === 0) {
    return `This call ran short of time before it could fetch ${count === 1 ? span : `any of the ${count} months of ${span}`}.`;
  }
  return `This call ran short of time after fetching ${stop.fetched} of the ${count} months of ${span}; ${stop.month} and later did not start. The months fetched stay cached for 15 minutes, so a repeat call fetches only the rest.`;
}

/** The message for a neighbourhood id the force does not have. */
export function unknownNeighbourhoodMessage({
  force,
  neighbourhoodId,
}: UnknownNeighbourhood): string {
  return `Force '${force}' has no neighbourhood '${neighbourhoodId}'; ids are case-sensitive.`;
}

/** The area echo: the arm's own fields, the polygon size searched, and the forces the lookups found. */
export function areaEcho(
  spec: AreaSpec,
  run: AreaForces & { readonly target: AreaTarget },
): AreaEcho {
  const located =
    run.located?.kind === 'found'
      ? {
          located_force: run.located.value.force,
          located_neighbourhood: run.located.value.neighbourhood,
        }
      : {};
  switch (spec.kind) {
    case 'point':
      return { type: spec.kind, lat: spec.lat, lng: spec.lng, ...located };
    case 'polygon':
      return {
        type: spec.kind,
        vertex_count: spec.vertices.length,
        ...(run.forces.length > 0 ? { located_forces: [...run.forces] } : {}),
      };
    case 'location':
      return { type: spec.kind, location_id: spec.locationId, ...located };
    case 'neighbourhood':
      return {
        type: spec.kind,
        force: spec.force,
        neighbourhood_id: spec.neighbourhoodId,
        ...(run.target.kind === 'polygon' ? { vertex_count: run.target.vertices.length } : {}),
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
    (a, b) => b.count - a.count || compareText(a.value, b.value),
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

/** `month` was omitted and the latest published month searched, or a range ending at it. */
export const monthDefaultedNote = (month: string, from?: string): string =>
  from !== undefined && from !== month
    ? `No month given; searched ${from}–${month}, a range ending at ${month}, the latest published month.`
    : `No month given; searched ${month}, the latest published month.`;

/**
 * For a search with no hits: the point lies outside coverage (its lookup
 * answered 404), or the polygon does — every vertex outside the coverage box,
 * or every sample point answering 404 (Scotland, open sea).
 */
export function outsideCoverageNote(spec: AreaSpec, run: AreaLookups): string | undefined {
  if (spec.kind === 'point' && run.located?.kind === 'miss') {
    return 'This point is outside data.police.uk coverage (England, Wales and Northern Ireland; Scotland only through British Transport Police); check that lat and lng are not swapped.';
  }
  const samples = run.samples ?? [];
  const everySampleMissed =
    samples.length > 0 && samples.every((lookup) => lookup?.kind === 'miss');
  if (spec.kind === 'polygon' && (!spec.vertices.some(inCoverageBox) || everySampleMissed)) {
    return 'This polygon lies outside data.police.uk coverage; each vertex is {lat, lng}, so check the two were not swapped.';
  }
  return;
}

/**
 * For a polygon some of whose sample lookups failed while others found a force:
 * its forces may be short of every force it falls in, so no notice or flag may
 * speak for all of them. Absent when every lookup answered, or none found a force.
 */
export function partialLocateNote(run: AreaForces): string | undefined {
  const samples = run.samples ?? [];
  const failed = samples.filter((lookup) => lookup === undefined).length;
  if (failed === 0 || run.forces.length === 0) return;
  return `The force at ${failed} of this polygon's ${samples.length} sample points could not be looked up, so the forces named here may not be all it falls in; search again to retry the lookup.`;
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
