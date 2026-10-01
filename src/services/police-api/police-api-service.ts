/**
 * @fileoverview PoliceApiService — the only path to data.police.uk. Owns the
 * request boundary (per-call status accept-lists, a decoded-byte ceiling, the
 * 503 overload value and its separately paced health probe), the process-wide
 * pacer, retry and per-call budget, and every in-process cache. Reference
 * methods (availability, forces, categories, force detail, neighbourhood lists),
 * the locate and boundary lookups, and the generic area query live here; tools
 * add nothing between themselves and the upstream.
 * @module services/police-api/police-api-service
 */

import type { Context, z } from '@cyanheads/mcp-ts-core';
import {
  McpError,
  serviceUnavailable,
  timeout,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import {
  createPacer,
  httpErrorFromResponse,
  type Pacer,
  withRetry,
} from '@cyanheads/mcp-ts-core/utils';
import { LruCache } from './lru-cache.js';
import {
  RawBoundary,
  RawCategories,
  RawCrimeHistory,
  RawEvents,
  RawForceDetail,
  RawForces,
  RawLastUpdated,
  RawLocate,
  RawNeighbourhoodDetail,
  RawNeighbourhoods,
  RawPeople,
  RawPriorities,
  RawStreetDates,
} from './raw-schemas.js';
import {
  compareText,
  normalizeCrimeHistory,
  normalizeEvents,
  normalizeNeighbourhood,
  normalizePriorities,
  toCoordinate,
} from './records.js';
import type {
  Availability,
  CallBudget,
  Category,
  CrimeHistory,
  Force,
  ForceDetail,
  LocatedNeighbourhood,
  Lookup,
  MapPoint,
  MonthResolution,
  Neighbourhood,
  NeighbourhoodDetail,
  NeighbourhoodEvent,
  Priority,
  TeamMember,
} from './types.js';

const BASE_URL = 'https://data.police.uk/api';

/** Each tool call's total budget, inside a typical 60 s client timeout. */
const CALL_BUDGET_MS = 50_000;
/** Ceiling on any one service call's retry deadline, within the call budget. */
const SERVICE_CALL_DEADLINE_MS = 45_000;
/** One attempt's ceiling; the slowest successful call observed took 17.3 s. */
const ATTEMPT_TIMEOUT_MS = 30_000;
/** Longest a request waits in the pacer queue before it is shed; an area request's wait for an area slot counts toward it. */
const PACER_MAX_WAIT_MS = 20_000;
/** In-flight slots area requests may hold, of the pacer's four, so cheap reads always have one. */
const AREA_SLOTS = 3;
/** Decoded body ceiling; the largest body observed is 8.3 MB (a Metropolitan stop-and-search month). */
const MAX_BODY_BYTES = 32 * 1024 * 1024;
/** `/crime-last-updated` is re-read at most this often when a month newer than the cache is asked for. */
const RECHECK_INTERVAL_MS = 60_000;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Area-response cache: weight is decoded body bytes × 1.25, a heap estimate for the parsed records. */
const AREA_CACHE_CAPACITY = 64 * 1024 * 1024;
const AREA_WEIGHT_PER_BYTE = 1.25;

const SINGLETON_KEY = 'all';

/** The British Transport Police entry, absent from `/forces` but answered by the stop-and-search and unplaced-crime routes. */
export const BTP_FORCE: Force = { id: 'btp', name: 'British Transport Police' };

/** Injectable seams. Production passes `globalThis.fetch` and `Date.now`. */
export interface PoliceApiServiceOptions {
  /** Fetch implementation; tests pass a `createFetchMock` route table. */
  readonly fetch: (input: string, init?: RequestInit) => Promise<Response>;
  /** Clock in epoch milliseconds; drives every cache TTL, the re-check throttle, and call budgets. */
  readonly now: () => number;
}

/** An area route request for {@link PoliceApiService.queryArea}. */
export interface AreaQuery<T> {
  /** `POST` sends `params` as a form body — polygons always go this way. Default `GET`. */
  readonly method?: 'GET' | 'POST';
  /**
   * Parses the response body into records already in the calling tool's sort
   * order. Its result is what the area cache stores and shares, read-only, with
   * every caller — so each route has exactly one normalizer.
   */
  readonly normalize: (json: unknown) => readonly T[];
  /** True where a 404 is an answer: `/crimes-at-location` and `/outcomes-at-location` by `location_id`. */
  readonly notFoundIsMiss?: boolean;
  /** Query or form parameters, `date` included (always sent explicitly). */
  readonly params: Readonly<Record<string, string>>;
  /** Route under the API base with path segments already encoded, e.g. `/crimes-street/burglary`. */
  readonly path: string;
  /** Replaces the calling tool's declared `area_too_large` recovery hint for this request (the point arm's wording). */
  readonly tooLargeHint?: string;
}

interface UpstreamRequest {
  /** An area route: a 503 leaves the attempt as `overloaded`, and a body over the ceiling as `too_large`, instead of failing it. */
  readonly area?: boolean;
  readonly method?: 'GET' | 'POST';
  /** A 404 is an answer: returned as `miss`, body unread. */
  readonly notFoundIsMiss?: boolean;
  readonly params?: Readonly<Record<string, string>>;
  readonly path: string;
}

interface Body {
  /** Decoded body size. */
  readonly bytes: number;
  readonly json: unknown;
  readonly kind: 'ok';
}
type Miss = { readonly kind: 'miss' };
type Overloaded = { readonly kind: 'overloaded' };
type TooLarge = { readonly kind: 'too_large' };
type Answer = Body | Miss | Overloaded | TooLarge;

const MISS: Miss = { kind: 'miss' };
const TOO_LARGE: TooLarge = { kind: 'too_large' };

/**
 * Validates an upstream body against its raw schema. A mismatch means the
 * upstream changed shape; repeating the request would not help, so it fails as
 * a non-retryable `ServiceUnavailable`.
 */
export function parseUpstream<S extends z.ZodType>(
  schema: S,
  json: unknown,
  path: string,
): z.output<S> {
  const parsed = schema.safeParse(json);
  if (parsed.success) return parsed.data;
  throw serviceUnavailable(`data.police.uk returned an unexpected response shape for ${path}.`, {
    reason: 'unexpected_response',
    retryable: false,
    issues: parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.map(String).join('.')}: ${issue.message}`),
  });
}

/** The `area_too_large` refusal, carrying the query's own recovery hint when it has one. */
const areaTooLarge = (query: AreaQuery<unknown>, message: string): McpError =>
  validationError(message, {
    reason: 'area_too_large',
    ...(query.tooLargeHint ? { recovery: { hint: query.tooLargeHint } } : {}),
  });

/** A category's match key: lower-cased, each run of spaces, underscores and hyphens folded to one `-`. */
const categoryKey = (value: string): string => value.toLowerCase().replace(/[\s_-]+/g, '-');

/** A neighbourhood route, `/{force}/{id}` or one of its sections, with both ids path-encoded. */
const neighbourhoodPath = (force: string, neighbourhoodId: string, section?: string): string =>
  `/${encodeURIComponent(force)}/${encodeURIComponent(neighbourhoodId)}${section ? `/${section}` : ''}`;

/** Reads a response body under a decoded-byte ceiling; `undefined` (stream cancelled) when it is exceeded. */
async function readCapped(
  response: Response,
  limit: number,
): Promise<{ bytes: number; text: string } | undefined> {
  if (!response.body) return { bytes: 0, text: '' };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  let chunk = await reader.read();
  while (!chunk.done) {
    bytes += chunk.value.byteLength;
    if (bytes > limit) {
      await reader.cancel();
      return;
    }
    text += decoder.decode(chunk.value, { stream: true });
    chunk = await reader.read();
  }
  return { bytes, text: text + decoder.decode() };
}

/** Cache key for an area request: SHA-256 of method, route and the sorted, encoded params. */
async function areaCacheKey(
  method: string,
  path: string,
  params: Readonly<Record<string, string>>,
): Promise<string> {
  const canonical = Object.entries(params)
    .sort(([a], [b]) => compareText(a, b))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${method} ${path}?${canonical}`),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * data.police.uk client. One instance per process: the pacer enforces the
 * upstream's per-IP limit (15 requests/s, burst 30) across every caller, area
 * requests hold at most three of its four slots, and the caches hold public data
 * shared by every caller and tenant.
 */
export class PoliceApiService {
  private readonly fetchFn: PoliceApiServiceOptions['fetch'];
  private readonly now: () => number;
  private readonly pacer: Pacer;
  /** Admits area requests to {@link pacer} at most {@link AREA_SLOTS} at a time. */
  private readonly areaGate: Pacer;
  private lastRecheckAt = Number.NEGATIVE_INFINITY;

  private readonly availabilityCache: LruCache<Availability>;
  private readonly forcesCache: LruCache<readonly Force[]>;
  private readonly categoriesCache: LruCache<readonly Category[]>;
  private readonly forceDetailCache: LruCache<Lookup<ForceDetail>>;
  private readonly neighbourhoodsCache: LruCache<Lookup<readonly Neighbourhood[]>>;
  private readonly boundaryCache: LruCache<Lookup<readonly MapPoint[]>>;
  private readonly locateCache: LruCache<Lookup<LocatedNeighbourhood>>;
  private readonly crimeHistoryMissCache: LruCache<Miss>;
  private readonly areaCache: LruCache<readonly unknown[]>;

  constructor(options: PoliceApiServiceOptions) {
    this.fetchFn = options.fetch;
    this.now = options.now;
    const now = options.now;
    this.pacer = createPacer({
      name: 'data-police-uk',
      limits: [{ requests: 15, perMs: 1000 }],
      maxConcurrent: 4,
      maxQueueDepth: 200,
      cooldown: { baseMs: 1000, maxMs: 15_000 },
    });
    this.areaGate = createPacer({
      name: 'data-police-uk-area',
      maxConcurrent: AREA_SLOTS,
      maxQueueDepth: 200,
    });
    this.availabilityCache = new LruCache({ capacity: 1, ttlMs: HOUR_MS, now });
    this.forcesCache = new LruCache({ capacity: 1, ttlMs: DAY_MS, now });
    this.categoriesCache = new LruCache({ capacity: 1, ttlMs: DAY_MS, now });
    this.forceDetailCache = new LruCache({ capacity: 45, ttlMs: DAY_MS, now });
    this.neighbourhoodsCache = new LruCache({ capacity: 45, ttlMs: DAY_MS, now });
    this.boundaryCache = new LruCache({ capacity: 64, ttlMs: DAY_MS, now });
    this.locateCache = new LruCache({ capacity: 10_000, ttlMs: DAY_MS, now });
    this.crimeHistoryMissCache = new LruCache({ capacity: 10_000, ttlMs: 15 * MINUTE_MS, now });
    this.areaCache = new LruCache({
      capacity: AREA_CACHE_CAPACITY,
      maxEntryWeight: AREA_CACHE_CAPACITY / 2,
      ttlMs: 15 * MINUTE_MS,
      now,
    });
  }

  /** Opens a tool call's 50 s budget. Call once at handler start; pass it to every service call. */
  openBudget(): CallBudget {
    return { deadlineAt: this.now() + CALL_BUDGET_MS };
  }

  /** Releases both pacers: clears their timers and rejects queued requests. Wired to `createApp({ teardown })`. */
  dispose(): void {
    this.areaGate.dispose();
    this.pacer.dispose();
  }

  // --- Reference methods ---------------------------------------------------

  /** The published-month window and each month's stop-and-search publishers (cached 1 h). */
  async getAvailability(ctx: Context, budget: CallBudget): Promise<Availability> {
    const cached = this.availabilityCache.get(SINGLETON_KEY);
    if (cached) return cached;
    const path = '/crimes-street-dates';
    const [first, ...rest] = parseUpstream(
      RawStreetDates,
      (await this.send({ path }, ctx, budget)).json,
      path,
    );
    let latest = first.date;
    let earliest = first.date;
    for (const { date } of rest) {
      if (date > latest) latest = date;
      if (date < earliest) earliest = date;
    }
    const months = [first, ...rest]
      .map((row) => ({ month: row.date, stopSearchForces: row['stop-and-search'] }))
      .sort((a, b) => compareText(b.month, a.month));
    const availability: Availability = { latest, earliest, months };
    this.availabilityCache.set(SINGLETON_KEY, availability);
    return availability;
  }

  /**
   * Resolves the month a search sends as `date`. Omitted → the latest published
   * month (`defaulted: true`). Newer than the cached latest → `/crime-last-updated`
   * is re-read (at most once a minute per process) and availability refreshed if
   * it moved; still newer → `not_published`. Older than the window → `out_of_range`.
   */
  async resolveMonth(
    month: string | undefined,
    ctx: Context,
    budget: CallBudget,
  ): Promise<MonthResolution> {
    let availability = await this.getAvailability(ctx, budget);
    if (month === undefined)
      return { kind: 'ok', month: availability.latest, defaulted: true, availability };
    if (month > availability.latest) {
      availability = await this.recheckLatest(availability, ctx, budget);
      if (month > availability.latest) return { kind: 'not_published', month, availability };
    }
    if (month < availability.earliest) return { kind: 'out_of_range', month, availability };
    return { kind: 'ok', month, defaulted: false, availability };
  }

  /** The 44 forces `/forces` lists (43 England and Wales + `northern-ireland`), cached 24 h. Excludes `btp`. */
  async getForces(ctx: Context, budget: CallBudget): Promise<readonly Force[]> {
    const cached = this.forcesCache.get(SINGLETON_KEY);
    if (cached) return cached;
    const path = '/forces';
    const forces = parseUpstream(RawForces, (await this.send({ path }, ctx, budget)).json, path);
    this.forcesCache.set(SINGLETON_KEY, forces);
    return forces;
  }

  /**
   * A force by id from the cached list, or `undefined` when unknown. `btp` is
   * returned (as {@link BTP_FORCE}) only with `allowBtp` — on the routes that
   * answer for it.
   */
  async findForce(
    id: string,
    ctx: Context,
    budget: CallBudget,
    options: { readonly allowBtp: boolean },
  ): Promise<Force | undefined> {
    if (id === BTP_FORCE.id) return options.allowBtp ? BTP_FORCE : undefined;
    return (await this.getForces(ctx, budget)).find((force) => force.id === id);
  }

  /** The 15 crime categories, `all-crime` included, cached 24 h (the list does not vary by month). */
  async getCategories(ctx: Context, budget: CallBudget): Promise<readonly Category[]> {
    const cached = this.categoriesCache.get(SINGLETON_KEY);
    if (cached) return cached;
    const path = '/crime-categories';
    const categories = parseUpstream(
      RawCategories,
      (await this.send({ path }, ctx, budget)).json,
      path,
    ).map(({ url, name }) => ({ slug: url, name }));
    this.categoriesCache.set(SINGLETON_KEY, categories);
    return categories;
  }

  /**
   * Matches a category input against a slug (`burglary`) or a display name
   * (`Violence and sexual offences`), both sides folded by {@link categoryKey},
   * so `vehicle_crime`, `anti social behaviour` and `violence-and-sexual-offences`
   * each reach their one category. `undefined` when nothing matches; the
   * upstream would silently read an unknown slug as all crime.
   */
  async findCategory(
    input: string,
    ctx: Context,
    budget: CallBudget,
  ): Promise<Category | undefined> {
    const wanted = categoryKey(input);
    return (await this.getCategories(ctx, budget)).find(
      (category) => categoryKey(category.slug) === wanted || categoryKey(category.name) === wanted,
    );
  }

  /** `/forces/{id}` — website and switchboard. 404 (unknown force, or `btp`) → miss. Cached 24 h. */
  async getForceDetail(id: string, ctx: Context, budget: CallBudget): Promise<Lookup<ForceDetail>> {
    const cached = this.forceDetailCache.get(id);
    if (cached) return cached;
    const path = `/forces/${encodeURIComponent(id)}`;
    const answer = await this.send({ path, notFoundIsMiss: true }, ctx, budget);
    let result: Lookup<ForceDetail> = MISS;
    if (answer.kind === 'ok') {
      const raw = parseUpstream(RawForceDetail, answer.json, path);
      result = {
        kind: 'found',
        value: {
          id: raw.id,
          name: raw.name,
          ...(raw.url?.trim() ? { url: raw.url.trim() } : {}),
          ...(raw.telephone?.trim() ? { telephone: raw.telephone.trim() } : {}),
        },
      };
    }
    this.forceDetailCache.set(id, result);
    return result;
  }

  /** `/{force}/neighbourhoods` — ids and names in upstream order. 404 (unknown force) → miss. Cached 24 h. */
  async getNeighbourhoods(
    force: string,
    ctx: Context,
    budget: CallBudget,
  ): Promise<Lookup<readonly Neighbourhood[]>> {
    const cached = this.neighbourhoodsCache.get(force);
    if (cached) return cached;
    const path = `/${encodeURIComponent(force)}/neighbourhoods`;
    const answer = await this.send({ path, notFoundIsMiss: true }, ctx, budget);
    const result: Lookup<readonly Neighbourhood[]> =
      answer.kind === 'ok'
        ? { kind: 'found', value: parseUpstream(RawNeighbourhoods, answer.json, path) }
        : MISS;
    this.neighbourhoodsCache.set(force, result);
    return result;
  }

  // --- Area lookups ----------------------------------------------------------

  /**
   * `/locate-neighbourhood?q=lat,lng` — the force and neighbourhood covering a
   * point. 404 (outside coverage) → miss. Keyed and sent at 6 dp; cached 24 h in
   * an LRU capped at 10,000 points.
   */
  async locate(
    lat: number,
    lng: number,
    ctx: Context,
    budget: CallBudget,
  ): Promise<Lookup<LocatedNeighbourhood>> {
    const q = `${lat.toFixed(6)},${lng.toFixed(6)}`;
    const cached = this.locateCache.get(q);
    if (cached) return cached;
    const path = '/locate-neighbourhood';
    const answer = await this.send({ path, params: { q }, notFoundIsMiss: true }, ctx, budget);
    const result: Lookup<LocatedNeighbourhood> =
      answer.kind === 'ok'
        ? { kind: 'found', value: parseUpstream(RawLocate, answer.json, path) }
        : MISS;
    this.locateCache.set(q, result);
    return result;
  }

  /**
   * `/{force}/{id}/boundary` — the neighbourhood polygon as numbers, upstream
   * order (its first vertex repeated last). 404 (unknown or wrongly cased id) →
   * miss. Cached 24 h, 64 entries LRU. Vertices that fail to parse are dropped.
   */
  async getBoundary(
    force: string,
    neighbourhoodId: string,
    ctx: Context,
    budget: CallBudget,
  ): Promise<Lookup<readonly MapPoint[]>> {
    const path = neighbourhoodPath(force, neighbourhoodId, 'boundary');
    const cached = this.boundaryCache.get(path);
    if (cached) return cached;
    const answer = await this.send({ path, notFoundIsMiss: true }, ctx, budget);
    let result: Lookup<readonly MapPoint[]> = MISS;
    if (answer.kind === 'ok') {
      const vertices: MapPoint[] = [];
      for (const raw of parseUpstream(RawBoundary, answer.json, path)) {
        const latitude = toCoordinate(raw.latitude);
        const longitude = toCoordinate(raw.longitude);
        if (latitude !== undefined && longitude !== undefined)
          vertices.push({ latitude, longitude });
      }
      result = { kind: 'found', value: vertices };
    }
    this.boundaryCache.set(path, result);
    return result;
  }

  // --- Neighbourhood team and crime history ---------------------------------

  /**
   * `/{force}/{id}` — the team's profile: name, force-site page, centre,
   * population, description (HTML → text), team-level contacts, links and
   * stations. 404 (unknown or wrongly cased id) → miss. Not cached.
   */
  async getNeighbourhood(
    force: string,
    neighbourhoodId: string,
    ctx: Context,
    budget: CallBudget,
  ): Promise<Lookup<NeighbourhoodDetail>> {
    const path = neighbourhoodPath(force, neighbourhoodId);
    const answer = await this.send({ path, notFoundIsMiss: true }, ctx, budget);
    return answer.kind === 'ok'
      ? {
          kind: 'found',
          value: normalizeNeighbourhood(parseUpstream(RawNeighbourhoodDetail, answer.json, path)),
        }
      : MISS;
  }

  /** `/{force}/{id}/priorities` — issue and action as text. Every failure throws, a 404 included. Not cached. */
  async getPriorities(
    force: string,
    neighbourhoodId: string,
    ctx: Context,
    budget: CallBudget,
  ): Promise<readonly Priority[]> {
    const path = neighbourhoodPath(force, neighbourhoodId, 'priorities');
    return normalizePriorities(
      parseUpstream(RawPriorities, (await this.send({ path }, ctx, budget)).json, path),
    );
  }

  /**
   * `/{force}/{id}/people` — each member's rank and name as published, and
   * nothing else: the raw schema never reads a biography or a per-person
   * contact. Every failure throws, a 404 included. Not cached.
   */
  async getTeam(
    force: string,
    neighbourhoodId: string,
    ctx: Context,
    budget: CallBudget,
  ): Promise<readonly TeamMember[]> {
    const path = neighbourhoodPath(force, neighbourhoodId, 'people');
    return parseUpstream(RawPeople, (await this.send({ path }, ctx, budget)).json, path);
  }

  /** `/{force}/{id}/events` — upcoming events, description as text, sorted by start. Every failure throws, a 404 included. Not cached. */
  async getEvents(
    force: string,
    neighbourhoodId: string,
    ctx: Context,
    budget: CallBudget,
  ): Promise<readonly NeighbourhoodEvent[]> {
    const path = neighbourhoodPath(force, neighbourhoodId, 'events');
    return normalizeEvents(
      parseUpstream(RawEvents, (await this.send({ path }, ctx, budget)).json, path),
    );
  }

  /**
   * `/outcomes-for-crime/{persistent_id}` — the crime data.police.uk holds for
   * the id and its outcomes in date order (`null` when it publishes none). 404
   * (unknown or upper-cased id) → miss, cached 15 min in an LRU capped at
   * 10,000 ids; a found history is not cached.
   */
  async getCrimeHistory(
    persistentId: string,
    ctx: Context,
    budget: CallBudget,
  ): Promise<Lookup<CrimeHistory>> {
    if (this.crimeHistoryMissCache.get(persistentId)) return MISS;
    const path = `/outcomes-for-crime/${encodeURIComponent(persistentId)}`;
    const answer = await this.send({ path, notFoundIsMiss: true }, ctx, budget);
    if (answer.kind === 'miss') {
      this.crimeHistoryMissCache.set(persistentId, MISS);
      return MISS;
    }
    return {
      kind: 'found',
      value: normalizeCrimeHistory(parseUpstream(RawCrimeHistory, answer.json, path)),
    };
  }

  /**
   * Runs one area-route request (crimes, outcomes, stops at a point, polygon,
   * location, or force-wide) through the area cache. A hit returns the cached
   * records — shared and read-only: callers filter and page into new arrays and
   * never sort or mutate them. A miss fetches, normalizes and caches (15 min
   * from insert; weight = decoded bytes × 1.25; an entry over half the 64 MiB
   * cap is returned uncached).
   *
   * A 404 on a `notFoundIsMiss` route returns `miss`. A body over the 32 MiB
   * ceiling throws `ValidationError` with `data.reason: 'area_too_large'` (the
   * hint from `tooLargeHint` when given), neither retried nor probed. A 503
   * leaves the retry loop as a value, then one health probe
   * (`/crime-last-updated`, paced on its own, never retried) decides: probe 200
   * → the same `area_too_large`; otherwise → `ServiceUnavailable` with
   * `data.reason: 'upstream_unavailable'`, `retryable: true`. Other failures
   * bubble as baseline errors.
   */
  async queryArea<T>(
    query: AreaQuery<T>,
    ctx: Context,
    budget: CallBudget,
  ): Promise<Lookup<readonly T[]>> {
    const method = query.method ?? 'GET';
    const key = await areaCacheKey(method, query.path, query.params);
    // The key covers method, route and params, and each route has one normalizer, so a hit holds T[].
    const cached = this.areaCache.get(key) as readonly T[] | undefined;
    if (cached) return { kind: 'found', value: cached };
    const answer = await this.send(
      {
        path: query.path,
        method,
        params: query.params,
        notFoundIsMiss: query.notFoundIsMiss ?? false,
        area: true,
      },
      ctx,
      budget,
    );
    if (answer.kind === 'miss') return answer;
    if (answer.kind === 'overloaded') return this.refuseOverloaded(query, ctx, budget);
    if (answer.kind === 'too_large') {
      throw areaTooLarge(
        query,
        'data.police.uk answered with more than the 32 MiB this server reads for one area, so the area is too large to answer.',
      );
    }
    const records = query.normalize(answer.json);
    const cachedNow = this.areaCache.set(key, records, answer.bytes * AREA_WEIGHT_PER_BYTE);
    if (!cachedNow)
      ctx.log.info('Area response too large to cache; served uncached', {
        path: query.path,
        bytes: answer.bytes,
      });
    return { kind: 'found', value: records };
  }

  // --- Request boundary ------------------------------------------------------

  /**
   * Re-reads `/crime-last-updated` and refreshes availability when the latest
   * month moved. Throttled to once a minute by the last successful read, so a
   * failed re-check never stands in for one.
   */
  private async recheckLatest(
    availability: Availability,
    ctx: Context,
    budget: CallBudget,
  ): Promise<Availability> {
    const at = this.now();
    if (at - this.lastRecheckAt < RECHECK_INTERVAL_MS) return availability;
    const path = '/crime-last-updated';
    const { date } = parseUpstream(
      RawLastUpdated,
      (await this.send({ path }, ctx, budget)).json,
      path,
    );
    this.lastRecheckAt = at;
    if (date.slice(0, 7) <= availability.latest) return availability;
    ctx.log.info('data.police.uk published a newer month; refreshing availability', {
      latest: date.slice(0, 7),
    });
    this.availabilityCache.delete(SINGLETON_KEY);
    return this.getAvailability(ctx, budget);
  }

  /** Resolves a 503 on an area route into `area_too_large` or `upstream_unavailable` by probing health. */
  private async refuseOverloaded(
    query: AreaQuery<unknown>,
    ctx: Context,
    budget: CallBudget,
  ): Promise<never> {
    const healthy = await this.probeHealthy(ctx, budget);
    ctx.log.notice('Area route answered 503', { path: query.path, upstreamHealthy: healthy });
    if (healthy) {
      throw areaTooLarge(
        query,
        'data.police.uk refused this area as too large to answer, though the service itself is up.',
      );
    }
    throw serviceUnavailable(
      'data.police.uk is not answering: the area search and a status check both failed.',
      {
        reason: 'upstream_unavailable',
        retryable: true,
      },
    );
  }

  /**
   * One uncached `/crime-last-updated` request as its own pacer task, never
   * retried, bounded by what remains of the call's budget. True only on a 200;
   * any other status, a network error, a timeout, or a pacer shed is false. A
   * cancelled request rethrows.
   */
  private async probeHealthy(ctx: Context, budget: CallBudget): Promise<boolean> {
    const remainingMs = budget.deadlineAt - this.now();
    if (remainingMs <= 0) return false;
    try {
      const answer = await this.pacer.run(
        (signal) =>
          this.attempt(
            { path: '/crime-last-updated' },
            signal,
            Math.min(ATTEMPT_TIMEOUT_MS, remainingMs),
            ctx,
          ),
        { signal: ctx.signal, maxWaitMs: Math.min(PACER_MAX_WAIT_MS, remainingMs) },
      );
      return answer.kind === 'ok';
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      return false;
    }
  }

  /**
   * Sends one request: retry outside, pacer inside, status handling, the capped
   * read and the JSON parse inside each attempt. An area request first waits for
   * one of the {@link AREA_SLOTS} area slots, and that wait comes out of the same
   * 20 s it may then wait for a pacer slot. The retry deadline is
   * `min(45 s, what remains of the call budget)`.
   */
  private send(
    request: UpstreamRequest & { readonly area: true },
    ctx: Context,
    budget: CallBudget,
  ): Promise<Answer>;
  private send(
    request: UpstreamRequest & { readonly notFoundIsMiss: true },
    ctx: Context,
    budget: CallBudget,
  ): Promise<Body | Miss>;
  private send(request: UpstreamRequest, ctx: Context, budget: CallBudget): Promise<Body>;
  private async send(request: UpstreamRequest, ctx: Context, budget: CallBudget): Promise<Answer> {
    const remainingMs = budget.deadlineAt - this.now();
    if (remainingMs <= 0) {
      throw timeout('This call used up its 50-second budget before data.police.uk answered.', {
        reason: 'call_budget_exhausted',
      });
    }
    return await withRetry(
      ({ signal, remainingMs: attemptBudgetMs }) => {
        const paced = (pacedSignal: AbortSignal, maxWaitMs: number) =>
          this.pacer.run(
            (runSignal) =>
              this.attempt(request, runSignal, Math.min(ATTEMPT_TIMEOUT_MS, attemptBudgetMs), ctx),
            { signal: pacedSignal, maxWaitMs },
          );
        if (!request.area) return paced(signal, PACER_MAX_WAIT_MS);
        const queuedAt = this.now();
        return this.areaGate.run(
          (gateSignal) =>
            paced(gateSignal, Math.max(0, PACER_MAX_WAIT_MS - (this.now() - queuedAt))),
          { signal, maxWaitMs: PACER_MAX_WAIT_MS },
        );
      },
      {
        maxRetries: 2,
        baseDelayMs: 1000,
        maxDelayMs: 10_000,
        deadlineMs: Math.min(SERVICE_CALL_DEADLINE_MS, remainingMs),
        signal: ctx.signal,
        context: ctx,
        operation: `data.police.uk ${request.method ?? 'GET'} ${request.path}`,
      },
    );
  }

  /** One paced attempt under its own timeout, combined with the retry loop's signal. */
  private async attempt(
    request: UpstreamRequest,
    signal: AbortSignal,
    timeoutMs: number,
    ctx: Context,
  ): Promise<Answer> {
    const timer = new AbortController();
    const handle = setTimeout(() => timer.abort(), timeoutMs);
    // Called detached so a native fetch never sees the service as its receiver.
    const fetchFn = this.fetchFn;
    try {
      const response = await fetchFn(
        ...this.buildRequest(request, AbortSignal.any([signal, timer.signal])),
      );
      return await this.readAnswer(response, request, ctx);
    } catch (error) {
      if (timer.signal.aborted && !signal.aborted) {
        throw timeout(
          `data.police.uk did not answer within ${Math.ceil(timeoutMs / 1000)} s.`,
          undefined,
          {
            cause: error,
          },
        );
      }
      if (signal.aborted || error instanceof McpError) throw error;
      throw serviceUnavailable('Could not reach data.police.uk.', undefined, { cause: error });
    } finally {
      clearTimeout(handle);
    }
  }

  /**
   * The URL and init for a request: GET carries params in the query, POST as a
   * form body. Redirects are returned, not followed, so every request stays on
   * data.police.uk; {@link readAnswer} refuses them.
   */
  private buildRequest(request: UpstreamRequest, signal: AbortSignal): [string, RequestInit] {
    const params = new URLSearchParams(request.params);
    const url = `${BASE_URL}${request.path}`;
    if (request.method === 'POST') {
      return [
        url,
        {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: params.toString(),
          redirect: 'manual',
          signal,
        },
      ];
    }
    const query = params.toString();
    return [
      query ? `${url}?${query}` : url,
      { method: 'GET', headers: { accept: 'application/json' }, redirect: 'manual', signal },
    ];
  }

  /** Maps a response to an answer under the request's accept-list, or throws a classified error. */
  private async readAnswer(
    response: Response,
    request: UpstreamRequest,
    ctx: Context,
  ): Promise<Answer> {
    const { status } = response;
    if (status === 200) {
      const body = await readCapped(response, MAX_BODY_BYTES);
      if (!body) {
        // The same request would be as large again: a value on an area route, never retried.
        if (request.area) return TOO_LARGE;
        throw serviceUnavailable('data.police.uk sent more than 32 MiB for one response.', {
          reason: 'response_too_large',
          retryable: false,
        });
      }
      try {
        return { kind: 'ok', json: JSON.parse(body.text), bytes: body.bytes };
      } catch (error) {
        throw serviceUnavailable(
          'data.police.uk answered with a body that is not JSON.',
          {
            reason: 'unreadable_response',
          },
          { cause: error },
        );
      }
    }
    // Any other status is answered from the status code: its body is never read.
    await response.body?.cancel();
    if (status === 404 && request.notFoundIsMiss) return MISS;
    if (status === 503 && request.area) return { kind: 'overloaded' };
    if (status >= 300 && status < 400) {
      throw serviceUnavailable(
        `data.police.uk answered HTTP ${status}, a redirect this server does not follow.`,
        { reason: 'unexpected_redirect', status, retryable: false },
      );
    }
    // The framework classifies the status; the message is rebuilt so its reason phrase never reaches a caller.
    const { code, data } = await httpErrorFromResponse(response, {
      service: 'data.police.uk',
      captureBody: false,
    });
    const { statusText: _reasonPhrase, ...fields } = data ?? {};
    const error = new McpError(code, `data.police.uk returned HTTP ${status}.`, fields);
    if (status === 400) {
      ctx.log.error('data.police.uk rejected a request this server built (HTTP 400)', error, {
        path: request.path,
        method: request.method ?? 'GET',
      });
    }
    throw error;
  }
}

// --- Init/accessor -------------------------------------------------------------

let service: PoliceApiService | undefined;

/** Constructs the process-wide service. Called from `createApp({ setup })`. */
export function initPoliceApiService(options: PoliceApiServiceOptions): PoliceApiService {
  service = new PoliceApiService(options);
  return service;
}

/** The process-wide service; throws when `initPoliceApiService` has not run. */
export function getPoliceApiService(): PoliceApiService {
  if (!service)
    throw new Error('PoliceApiService not initialized — call initPoliceApiService() in setup()');
  return service;
}
