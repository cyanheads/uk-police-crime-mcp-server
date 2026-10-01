/**
 * @fileoverview Normalized domain types the PoliceApiService returns. Upstream
 * shapes live in `raw-schemas.ts`; these are what tools consume.
 * @module services/police-api/types
 */

/** A police force as `/forces` lists it, or the static British Transport Police entry. */
export interface Force {
  /** data.police.uk force id (`leicestershire`, `btp`). */
  readonly id: string;
  /** Display name as published. Upstream text. */
  readonly name: string;
}

/** A crime category from `/crime-categories`. */
export interface Category {
  /** Display name as published (`Violence and sexual offences`). Upstream text. */
  readonly name: string;
  /** Slug the crime routes take (`violent-crime`, `all-crime`). */
  readonly slug: string;
}

/** One published month from `/crimes-street-dates`. */
export interface AvailabilityMonth {
  /** `YYYY-MM`. */
  readonly month: string;
  /** Force ids that published stop and search for the month (can include `btp`). */
  readonly stopSearchForces: readonly string[];
}

/** The published-month window. */
export interface Availability {
  /** Oldest published month, `YYYY-MM`. */
  readonly earliest: string;
  /** Newest published month, `YYYY-MM`. */
  readonly latest: string;
  /** Every published month, newest first. */
  readonly months: readonly AvailabilityMonth[];
}

/**
 * A requested month checked against the window. `ok` carries the month to send
 * as `date`; `defaulted` is true when none was requested and the latest was
 * chosen. The other two kinds map to the tools' `month_not_published` and
 * `month_out_of_range` reasons.
 */
export type MonthResolution =
  | {
      readonly availability: Availability;
      readonly defaulted: boolean;
      readonly kind: 'ok';
      readonly month: string;
    }
  | { readonly availability: Availability; readonly kind: 'not_published'; readonly month: string }
  | { readonly availability: Availability; readonly kind: 'out_of_range'; readonly month: string };

/** `/forces/{id}`, reduced to what the tools render. */
export interface ForceDetail {
  readonly id: string;
  /** Upstream text. */
  readonly name: string;
  /** Force switchboard number as published, when non-empty. Upstream text. */
  readonly telephone?: string;
  /** Force website, when non-empty. Upstream URL. */
  readonly url?: string;
}

/** One entry of `/{force}/neighbourhoods`. */
export interface Neighbourhood {
  /** Case-sensitive neighbourhood id (Northern Ireland ids are place names with spaces). */
  readonly id: string;
  /** Upstream text. */
  readonly name: string;
}

/** `/locate-neighbourhood` for a point. */
export interface LocatedNeighbourhood {
  /** Force id. */
  readonly force: string;
  /** Neighbourhood id within the force. */
  readonly neighbourhood: string;
}

/** A WGS84 coordinate pair. */
export interface MapPoint {
  readonly latitude: number;
  readonly longitude: number;
}

/**
 * Where an area query is sent: a point (1-mile radius), a polygon ring (sent by
 * POST), or a snapped map point by id. A neighbourhood resolves to its boundary
 * polygon before the query.
 */
export type Place =
  | { readonly kind: 'point'; readonly lat: number; readonly lng: number }
  | { readonly kind: 'polygon'; readonly vertices: readonly MapPoint[] }
  | { readonly kind: 'location'; readonly locationId: string };

/*
 * Area records. The area cache stores these and the search tools return slices
 * of them unchanged, so their keys are the tools' snake_case wire names.
 */

/** A record's anonymised map point and street, as data.police.uk publishes it. */
export interface RecordLocation {
  /** Upstream `location.street.id` — the id `area: 'location'` takes. */
  readonly location_id: string;
  /** Present unless a coordinate failed to parse or both were 0 (no map point within 20 km). */
  readonly map_point?: MapPoint;
  /** Always `On or near …`. Upstream text. */
  readonly street_name: string;
  /** Upstream `location_subtype` when non-empty (station or premises type). Upstream text. */
  readonly subtype?: string;
  /** `BTP` marks a British Transport Police record at a station. */
  readonly type?: 'BTP' | 'Force';
}

/** One street-level crime (`/crimes-street`, `/crimes-at-location`, `/crimes-no-location`). */
export interface CrimeRecord {
  /** Category slug. */
  readonly category: string;
  /** Non-empty upstream context only. Upstream free text. */
  readonly context?: string;
  /** Upstream numeric id, as a string. */
  readonly id: string;
  /** Absent for unplaced crimes. */
  readonly location?: RecordLocation;
  /** `YYYY-MM` the crime was recorded. */
  readonly month: string;
  /** Latest outcome; absent for anti-social behaviour. `name` is upstream text. */
  readonly outcome?: { readonly month: string; readonly name: string };
  /** 64 hex characters; absent when upstream sends `""` (always for anti-social behaviour). */
  readonly persistent_id?: string;
}

/** One police outcome from `/outcomes-at-location`, with its crime. */
export interface OutcomeRecord {
  /** Outcome code (`under-investigation`). */
  readonly code: string;
  readonly crime: Omit<CrimeRecord, 'outcome'>;
  /** `YYYY-MM` the outcome was recorded. */
  readonly month: string;
  /** Outcome display name. Upstream text. */
  readonly name: string;
}

/** One stop and search (`/stops-street`, `/stops-at-location`, `/stops-force`). Categorical fields are upstream text, absent when null or empty. */
export interface StopRecord {
  readonly age_range?: string;
  /** UTC ISO 8601, as published. */
  readonly datetime: string;
  readonly gender?: string;
  readonly involved_person?: boolean;
  readonly legislation?: string;
  /** Absent for stops the force could not place. */
  readonly location?: RecordLocation;
  readonly object_of_search?: string;
  readonly officer_defined_ethnicity?: string;
  readonly operation_name?: string;
  /** Absent when the force left it blank. */
  readonly outcome?: string;
  readonly outcome_linked_to_object_of_search?: boolean;
  readonly removal_of_more_than_outer_clothing?: boolean;
  readonly self_defined_ethnicity?: string;
  readonly type?: string;
}

/** One outcome in a crime's history. */
export interface HistoryOutcome {
  /** Outcome code (`under-investigation`). */
  readonly code: string;
  /** `YYYY-MM` the outcome was recorded. */
  readonly month: string;
  /** Outcome display name. Upstream text. */
  readonly name: string;
}

/** `/outcomes-for-crime/{persistent_id}`: the crime data.police.uk holds for the id, and its outcomes. */
export interface CrimeHistory {
  readonly crime: Omit<CrimeRecord, 'outcome'>;
  /** In date order (upstream order within a month); `null` when data.police.uk publishes no history (seen on Northern Ireland records). */
  readonly outcomes: readonly HistoryOutcome[] | null;
}

/*
 * Neighbourhood records, in the find tool's snake_case wire shape. Upstream
 * text throughout; HTML fields are already converted to plain text.
 */

/** A police station or base listed for a neighbourhood team (upstream `locations`). */
export interface Station {
  readonly address?: string;
  readonly description?: string;
  readonly name?: string;
  readonly postcode?: string;
  /** Station or base type as published, when given. */
  readonly type?: string;
}

/** `/{force}/{id}`: a neighbourhood team's public profile. */
export interface NeighbourhoodDetail {
  /** Published centre point, when both coordinates parse. */
  readonly centre?: MapPoint;
  /** Team-level contact channels (email, telephone, social accounts), as published. */
  readonly contact: readonly { readonly channel: string; readonly value: string }[];
  /** Plain text converted from HTML; absent when missing, null or empty. */
  readonly description?: string;
  readonly id: string;
  /** Links the force publishes for the team; entries without a title or url are dropped. */
  readonly links: readonly {
    readonly description?: string;
    readonly title: string;
    readonly url: string;
  }[];
  readonly name: string;
  /** Absent when upstream sends `"0"` or a non-number. */
  readonly population?: number;
  readonly stations: readonly Station[];
  /** The team's page on the force website (upstream `url_force`). */
  readonly url?: string;
}

/** One neighbourhood priority; issue and action converted from HTML, dates as published. */
export interface Priority {
  readonly action?: string;
  readonly action_date?: string;
  readonly issue: string;
  readonly issue_date?: string;
}

/** One neighbourhood team member, rank and name exactly as the force publishes them. */
export interface TeamMember {
  readonly name: string;
  /** Free text; can include a collar number. */
  readonly rank: string;
}

/** One upcoming neighbourhood engagement event; description converted from HTML, dates as published. */
export interface NeighbourhoodEvent {
  readonly address?: string;
  readonly description?: string;
  readonly end?: string;
  readonly start?: string;
  readonly title: string;
  readonly type?: string;
}

/**
 * A lookup whose 404 is an answer. `miss` means data.police.uk holds nothing
 * under the key; every other failure throws.
 */
export type Lookup<T> = { readonly kind: 'found'; readonly value: T } | { readonly kind: 'miss' };

/**
 * One tool call's time budget, opened by `PoliceApiService.openBudget()` when
 * the handler starts and passed to every service call it makes. Parallel calls
 * share it.
 */
export interface CallBudget {
  /** Epoch milliseconds, on the service's clock, when the call's budget runs out. */
  readonly deadlineAt: number;
}
