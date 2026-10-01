/**
 * @fileoverview Normalizers for data.police.uk records — the area records
 * (crimes, area outcomes, stop and search), a crime's outcome history, and a
 * neighbourhood team's profile, priorities, members and events. Each maps one
 * parsed response body's upstream sentinels to absence (`""` persistent ids
 * and outcomes, `0,0` map points, null or blank fields, `"0"` populations),
 * converts the HTML fields to plain text (each cut at 65,536 characters first),
 * and writes the tools' wire shape in the calling tool's order. Area records are
 * what the area cache stores and shares read-only.
 * @module services/police-api/records
 */

import type { z } from '@cyanheads/mcp-ts-core';
import { htmlToText } from './html-to-text.js';
import type {
  RawCrimeHistory,
  RawCrimes,
  RawEvents,
  RawNeighbourhoodDetail,
  RawOutcomes,
  RawPriorities,
  RawStops,
} from './raw-schemas.js';
import type {
  CrimeHistory,
  CrimeRecord,
  NeighbourhoodDetail,
  NeighbourhoodEvent,
  OutcomeRecord,
  Priority,
  RecordLocation,
  Station,
  StopRecord,
} from './types.js';

type RawCrime = z.output<typeof RawCrimes>[number];
type RawLocation = NonNullable<RawCrime['location']>;

/** A coordinate string to a number, or `undefined` when it does not parse. */
export function toCoordinate(value: string | null | undefined): number | undefined {
  const n = Number.parseFloat(value ?? '');
  return Number.isFinite(n) ? n : undefined;
}

/** `value` when it is a non-blank string, otherwise `undefined`. */
const present = (value: string | null | undefined): string | undefined =>
  value?.trim() ? value : undefined;

/** Longest HTML field converted, in UTF-16 code units; a longer one is cut there. */
const MAX_HTML_FIELD = 65_536;

/** The line that ends the text of a field cut at {@link MAX_HTML_FIELD}. */
const CUT_MARK = '[Cut: the published field is longer than 65,536 characters.]';

/**
 * An HTML field as text, cut at {@link MAX_HTML_FIELD} before conversion so the
 * field's length bounds both the work and the text a caller receives. The cut
 * never splits a surrogate pair, and the text of a cut field ends with
 * {@link CUT_MARK} on its own line.
 */
function fieldText(html: string | null | undefined): string | undefined {
  if (html == null || html.length <= MAX_HTML_FIELD) return htmlToText(html);
  const last = html.charCodeAt(MAX_HTML_FIELD - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? MAX_HTML_FIELD - 1 : MAX_HTML_FIELD;
  const text = htmlToText(html.slice(0, end));
  return text && `${text}\n${CUT_MARK}`;
}

/** Code-unit order, so the sort never depends on the runtime's locale. */
export const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Order for digit-string ids: shorter first, then code-unit order. */
export const compareDigits = (a: string, b: string): number =>
  a.length - b.length || compareText(a, b);

function normalizeLocation(
  raw: RawLocation,
  locationType?: string | null,
  subtype?: string | null,
): RecordLocation {
  const latitude = toCoordinate(raw.latitude);
  const longitude = toCoordinate(raw.longitude);
  const presentSubtype = present(subtype);
  return {
    location_id: raw.street.id,
    street_name: raw.street.name,
    ...(latitude !== undefined && longitude !== undefined && !(latitude === 0 && longitude === 0)
      ? { map_point: { latitude, longitude } }
      : {}),
    ...(locationType === 'Force' || locationType === 'BTP' ? { type: locationType } : {}),
    ...(presentSubtype ? { subtype: presentSubtype } : {}),
  };
}

function normalizeCrime(raw: Omit<RawCrime, 'outcome_status'>): CrimeRecord {
  const persistentId = present(raw.persistent_id);
  const context = present(raw.context);
  return {
    id: raw.id,
    ...(persistentId ? { persistent_id: persistentId } : {}),
    category: raw.category,
    month: raw.month,
    ...(raw.location
      ? { location: normalizeLocation(raw.location, raw.location_type, raw.location_subtype) }
      : {}),
    ...(context ? { context } : {}),
  };
}

/** Crimes sorted by category, then `location_id` (unplaced first), then id. */
export function normalizeCrimes(raw: z.output<typeof RawCrimes>): readonly CrimeRecord[] {
  return raw
    .map((entry): CrimeRecord => {
      const crime = normalizeCrime(entry);
      return entry.outcome_status
        ? {
            ...crime,
            outcome: { name: entry.outcome_status.category, month: entry.outcome_status.date },
          }
        : crime;
    })
    .sort(
      (a, b) =>
        compareText(a.category, b.category) ||
        compareDigits(a.location?.location_id ?? '', b.location?.location_id ?? '') ||
        compareDigits(a.id, b.id),
    );
}

/** Area outcomes sorted by the crime's month, newest first, then crime id. */
export function normalizeOutcomes(raw: z.output<typeof RawOutcomes>): readonly OutcomeRecord[] {
  return raw
    .map(
      (entry): OutcomeRecord => ({
        code: entry.category.code,
        name: entry.category.name,
        month: entry.date,
        crime: normalizeCrime(entry.crime),
      }),
    )
    .sort(
      (a, b) => compareText(b.crime.month, a.crime.month) || compareDigits(a.crime.id, b.crime.id),
    );
}

/** A crime's outcome history in date order, upstream order kept within a month; `outcomes: null` stays null. */
export function normalizeCrimeHistory(raw: z.output<typeof RawCrimeHistory>): CrimeHistory {
  return {
    crime: normalizeCrime(raw.crime),
    outcomes:
      raw.outcomes
        ?.map(({ category, date }) => ({ code: category.code, name: category.name, month: date }))
        .sort((a, b) => compareText(a.month, b.month)) ?? null,
  };
}

/** Stops sorted by `datetime`, then `location_id` (unplaced first); ties keep upstream order. */
export function normalizeStops(raw: z.output<typeof RawStops>): readonly StopRecord[] {
  return raw
    .map((entry): StopRecord => {
      const type = present(entry.type);
      const gender = present(entry.gender);
      const ageRange = present(entry.age_range);
      const selfDefined = present(entry.self_defined_ethnicity);
      const officerDefined = present(entry.officer_defined_ethnicity);
      const legislation = present(entry.legislation);
      const objectOfSearch = present(entry.object_of_search);
      const outcome = present(entry.outcome);
      const operationName = present(entry.operation_name);
      return {
        datetime: entry.datetime,
        ...(type ? { type } : {}),
        ...(typeof entry.involved_person === 'boolean'
          ? { involved_person: entry.involved_person }
          : {}),
        ...(gender ? { gender } : {}),
        ...(ageRange ? { age_range: ageRange } : {}),
        ...(selfDefined ? { self_defined_ethnicity: selfDefined } : {}),
        ...(officerDefined ? { officer_defined_ethnicity: officerDefined } : {}),
        ...(legislation ? { legislation } : {}),
        ...(objectOfSearch ? { object_of_search: objectOfSearch } : {}),
        ...(outcome ? { outcome } : {}),
        ...(typeof entry.outcome_linked_to_object_of_search === 'boolean'
          ? { outcome_linked_to_object_of_search: entry.outcome_linked_to_object_of_search }
          : {}),
        ...(typeof entry.removal_of_more_than_outer_clothing === 'boolean'
          ? { removal_of_more_than_outer_clothing: entry.removal_of_more_than_outer_clothing }
          : {}),
        ...(operationName ? { operation_name: operationName } : {}),
        ...(entry.location ? { location: normalizeLocation(entry.location) } : {}),
      };
    })
    .sort(
      (a, b) =>
        compareText(a.datetime, b.datetime) ||
        compareDigits(a.location?.location_id ?? '', b.location?.location_id ?? ''),
    );
}

/** The station fields read from upstream `locations`, each kept only when non-blank. */
const STATION_FIELDS = ['type', 'name', 'address', 'postcode', 'description'] as const;

/**
 * `/{force}/{id}`: identity as published, the HTML description as text, and
 * `"0"` populations, unparseable centres and blank fields as absent. Links
 * without a title or url and stations with nothing published are dropped.
 */
export function normalizeNeighbourhood(
  raw: z.output<typeof RawNeighbourhoodDetail>,
): NeighbourhoodDetail {
  const url = raw.url_force?.trim();
  const latitude = toCoordinate(raw.centre?.latitude);
  const longitude = toCoordinate(raw.centre?.longitude);
  const population = Number(raw.population);
  const description = fieldText(raw.description);
  return {
    id: raw.id,
    name: raw.name,
    ...(url ? { url } : {}),
    ...(latitude !== undefined && longitude !== undefined
      ? { centre: { latitude, longitude } }
      : {}),
    ...(Number.isFinite(population) && population > 0 ? { population } : {}),
    ...(description ? { description } : {}),
    contact: Object.entries(raw.contact_details ?? {}).flatMap(([channel, value]) =>
      typeof value === 'string' && value.trim() ? [{ channel, value: value.trim() }] : [],
    ),
    links: (raw.links ?? []).flatMap((link) => {
      const title = present(link.title);
      const href = link.url?.trim();
      const about = present(link.description);
      return title && href ? [{ title, url: href, ...(about ? { description: about } : {}) }] : [];
    }),
    stations: (raw.locations ?? []).flatMap((location) => {
      const station: Station = Object.fromEntries(
        STATION_FIELDS.flatMap((field) => {
          const value = present(location[field]);
          return value === undefined ? [] : [[field, value]];
        }),
      );
      return Object.keys(station).length > 0 ? [station] : [];
    }),
  };
}

/** `/{force}/{id}/priorities`: issue and action as text, dates as published; a priority whose issue is empty is dropped. */
export function normalizePriorities(raw: z.output<typeof RawPriorities>): readonly Priority[] {
  return raw.flatMap((entry) => {
    const issue = fieldText(entry.issue);
    if (!issue) return [];
    const issueDate = present(entry['issue-date']);
    const action = fieldText(entry.action);
    const actionDate = present(entry['action-date']);
    return [
      {
        issue,
        ...(issueDate ? { issue_date: issueDate } : {}),
        ...(action ? { action } : {}),
        ...(actionDate ? { action_date: actionDate } : {}),
      },
    ];
  });
}

/** `/{force}/{id}/events`: description as text, blank fields absent, sorted by start (undated last). */
export function normalizeEvents(raw: z.output<typeof RawEvents>): readonly NeighbourhoodEvent[] {
  return raw
    .map((entry): NeighbourhoodEvent => {
      const type = present(entry.type);
      const start = present(entry.start_date);
      const end = present(entry.end_date);
      const address = present(entry.address);
      const description = fieldText(entry.description);
      return {
        title: entry.title,
        ...(type ? { type } : {}),
        ...(start ? { start } : {}),
        ...(end ? { end } : {}),
        ...(address ? { address } : {}),
        ...(description ? { description } : {}),
      };
    })
    .sort((a, b) =>
      a.start === undefined || b.start === undefined
        ? Number(a.start === undefined) - Number(b.start === undefined)
        : compareText(a.start, b.start),
    );
}
