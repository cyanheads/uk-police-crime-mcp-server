/**
 * @fileoverview Zod schemas for data.police.uk response bodies. Each reads only
 * the fields the server uses — object schemas strip every other key — so a
 * field left out here (a person's bio, per-person contact details) is never
 * parsed and cannot reach either client surface. Shapes verified against the
 * live API on 2026-10-01 (docs/design.md, API Reference).
 * @module services/police-api/raw-schemas
 */

import { z } from '@cyanheads/mcp-ts-core';

/** Ids arrive as strings; a numeric id is read as its digits. */
const RawId = z.union([z.string(), z.number()]).transform(String);

/** `/crime-last-updated` — `{ date: "YYYY-MM-DD" }`, the first day of the latest month. */
export const RawLastUpdated = z.object({ date: z.string().regex(/^\d{4}-\d{2}/) });

const RawStreetDate = z.object({
  date: z.string().regex(/^\d{4}-\d{2}$/),
  'stop-and-search': z.array(z.string()),
});

/** `/crimes-street-dates` — published months, newest first; never empty (a non-empty tuple). */
export const RawStreetDates = z.tuple([RawStreetDate], RawStreetDate);

/** `/crime-categories` — `url` is the slug. */
export const RawCategories = z.array(z.object({ url: z.string(), name: z.string() }));

/** `/forces`. */
export const RawForces = z.array(z.object({ id: z.string(), name: z.string() }));

/** `/forces/{id}`, reduced to the fields the tools render. */
export const RawForceDetail = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string().nullish(),
  telephone: z.string().nullish(),
});

/** `/{force}/neighbourhoods`. */
export const RawNeighbourhoods = z.array(z.object({ id: RawId, name: z.string() }));

/** `/locate-neighbourhood?q=lat,lng`. */
export const RawLocate = z.object({ force: z.string(), neighbourhood: RawId });

/** `/{force}/{id}/boundary` — coordinates as decimal strings, first vertex repeated last. */
export const RawBoundary = z.array(z.object({ latitude: z.string(), longitude: z.string() }));

/** A record's `location`: coordinates as decimal strings and the snapped street. */
const RawRecordLocation = z.object({
  latitude: z.string().nullish(),
  longitude: z.string().nullish(),
  street: z.object({ id: RawId, name: z.string() }),
});

/** Fields a crime carries both on its own and inside an area outcome. */
const RawCrimeFields = {
  category: z.string(),
  location_type: z.string().nullish(),
  location: RawRecordLocation.nullish(),
  context: z.string().nullish(),
  persistent_id: z.string().nullish(),
  id: RawId,
  location_subtype: z.string().nullish(),
  month: z.string(),
};

/** `/crimes-street/{category}`, `/crimes-at-location`, `/crimes-no-location`. */
export const RawCrimes = z.array(
  z.object({
    ...RawCrimeFields,
    outcome_status: z.object({ category: z.string(), date: z.string() }).nullish(),
  }),
);

/** `/outcomes-at-location` — `person_id` (always null) is not read. */
export const RawOutcomes = z.array(
  z.object({
    category: z.object({ code: z.string(), name: z.string() }),
    date: z.string(),
    crime: z.object(RawCrimeFields),
  }),
);

/** `/outcomes-for-crime/{persistent_id}` — the crime and its outcome history; `outcomes` is null on some Northern Ireland records, and `person_id` is not read. */
export const RawCrimeHistory = z.object({
  crime: z.object(RawCrimeFields),
  outcomes: z
    .array(
      z.object({
        category: z.object({ code: z.string(), name: z.string() }),
        date: z.string(),
      }),
    )
    .nullable(),
});

/**
 * `/{force}/{id}` — a neighbourhood team. Everything past its identity is read
 * tolerantly: this record decides whether a lookup succeeds, so one odd link or
 * station must not fail it. `url_force` is the team's page on the force site.
 */
export const RawNeighbourhoodDetail = z.object({
  id: RawId,
  name: z.string(),
  url_force: z.string().nullish(),
  centre: z.object({ latitude: z.string().nullish(), longitude: z.string().nullish() }).nullish(),
  population: z.string().nullish(),
  description: z.string().nullish(),
  contact_details: z.record(z.string(), z.unknown()).nullish(),
  links: z
    .array(
      z.object({
        title: z.string().nullish(),
        url: z.string().nullish(),
        description: z.string().nullish(),
      }),
    )
    .nullish(),
  locations: z
    .array(
      z.object({
        type: z.string().nullish(),
        name: z.string().nullish(),
        description: z.string().nullish(),
        address: z.string().nullish(),
        postcode: z.string().nullish(),
      }),
    )
    .nullish(),
});

/** `/{force}/{id}/priorities` — `issue` and `action` are HTML; dates `YYYY-MM-DDTHH:MM:SS`, no zone. */
export const RawPriorities = z.array(
  z.object({
    issue: z.string(),
    'issue-date': z.string().nullish(),
    action: z.string().nullish(),
    'action-date': z.string().nullish(),
  }),
);

/**
 * `/{force}/{id}/people` — rank and name only. `bio` and the per-person
 * `contact_details` are deliberately not read, so they are never parsed and
 * cannot reach either client surface.
 */
export const RawPeople = z.array(z.object({ rank: z.string(), name: z.string() }));

/** `/{force}/{id}/events` — upcoming events; `description` is HTML. `contact_details` is deliberately not read. */
export const RawEvents = z.array(
  z.object({
    title: z.string(),
    type: z.string().nullish(),
    start_date: z.string().nullish(),
    end_date: z.string().nullish(),
    description: z.string().nullish(),
    address: z.string().nullish(),
  }),
);

/** `/stops-street`, `/stops-at-location`, `/stops-force` — every categorical can be null; `operation` and `outcome_object` are not read. */
export const RawStops = z.array(
  z.object({
    type: z.string().nullish(),
    involved_person: z.boolean().nullish(),
    datetime: z.string(),
    gender: z.string().nullish(),
    age_range: z.string().nullish(),
    self_defined_ethnicity: z.string().nullish(),
    officer_defined_ethnicity: z.string().nullish(),
    legislation: z.string().nullish(),
    object_of_search: z.string().nullish(),
    outcome: z.string().nullish(),
    outcome_linked_to_object_of_search: z.boolean().nullish(),
    removal_of_more_than_outer_clothing: z.boolean().nullish(),
    operation_name: z.string().nullish(),
    location: RawRecordLocation.nullish(),
  }),
);
