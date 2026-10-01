/**
 * @fileoverview Input vocabulary shared by the ukcrime tools (docs/design.md,
 * Shared input vocabulary) and the attribution every response carries. Each
 * optional field maps a blank, whitespace-only or null value to unset and runs
 * the normalization its description promises before its pattern, so handlers
 * see only canonical values. Tools add their own `.describe()`.
 * @module mcp-server/tools/shared-schemas
 */

import { z } from '@cyanheads/mcp-ts-core';

/** OGL v3.0 attribution — the `attribution` enrichment field, written first by every tool. */
export const ATTRIBUTION =
  'Contains public sector information licensed under the Open Government Licence v3.0. Source: data.police.uk.';

/** Most vertices a polygon input accepts. */
export const POLYGON_MAX_VERTICES = 2500;

/**
 * Wraps an optional field so a form client's blank is unset, never a value to
 * validate: `''`, a whitespace-only string and `null` become `undefined`, every
 * other string is trimmed and passed through `normalize`, other values pass
 * unchanged.
 */
export function blankAsUnset<T extends z.ZodType>(
  schema: T,
  normalize: (value: string) => string = (value) => value,
) {
  return z.preprocess((value) => {
    if (value === null) return;
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    return trimmed === '' ? undefined : normalize(trimmed);
  }, schema);
}

/** Force id: lower-cased, runs of spaces/underscores to `-`, then `^[a-z]+(-[a-z]+)*$`. */
export const forceInput = blankAsUnset(
  z
    .string()
    .max(100)
    .regex(
      /^[a-z]+(-[a-z]+)*$/,
      "Expected a force id: lower-case words joined by hyphens, such as 'leicestershire' or 'devon-and-cornwall'.",
    )
    .optional(),
  (value) => value.toLowerCase().replace(/[\s_]+/g, '-'),
);

/**
 * Neighbourhood id: trimmed only (ids are case-sensitive); path-safe — no `/`,
 * `\`, `?`, `#`, control characters, or a whole `.`/`..` — and well-formed
 * UTF-16, since `encodeURIComponent` throws on an unpaired surrogate.
 */
export const neighbourhoodIdInput = blankAsUnset(
  z
    .string()
    .max(100)
    .regex(
      /^[^/\\?#]+$/,
      "Expected a neighbourhood id such as 'NX01' from ukcrime_list_reference topic 'neighbourhoods'; it cannot contain /, \\, ? or #.",
    )
    .refine((value) => value !== '.' && value !== '..' && !/\p{Cc}/u.test(value), {
      message: "A neighbourhood id cannot be '.' or '..' or contain control characters.",
    })
    .refine((value) => value.isWellFormed(), {
      message:
        'A neighbourhood id must be well-formed text; this one contains an unpaired UTF-16 surrogate.',
    })
    .optional(),
);

/** A snapped map point id from an earlier result's `location.location_id`. */
export const locationIdInput = blankAsUnset(
  z
    .string()
    .regex(/^\d{1,12}$/, 'Expected 1–12 digits: the location.location_id of an earlier result.')
    .optional(),
);

/** Month, `YYYY-MM`. */
export const monthInput = blankAsUnset(
  z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Expected a month as YYYY-MM, such as 2026-07.')
    .optional(),
);

/** Category slug or display name, lower-cased; matched against the cached vocabulary by the handler. */
export const categoryInput = blankAsUnset(z.string().max(100).optional(), (value) =>
  value.toLowerCase(),
);

/**
 * Local name filter (strict token match). Needs a letter or digit: matching
 * ignores punctuation, so a value made only of punctuation would match every name.
 */
export const nameContainsInput = blankAsUnset(
  z
    .string()
    .max(100)
    .refine((value) => /[\p{L}\p{N}]/u.test(value.normalize('NFKD')), {
      message: 'Needs a letter or digit; punctuation alone would match every name.',
    })
    .optional(),
);

/** Latitude, WGS84 decimal degrees. */
export const latInput = blankAsUnset(z.number().min(-90).max(90).optional());

/** Longitude, WGS84 decimal degrees. */
export const lngInput = blankAsUnset(z.number().min(-180).max(180).optional());

const PolygonVertex = z
  .object(
    {
      lat: z.number().min(-90).max(90).describe('Latitude, WGS84 decimal degrees.'),
      lng: z.number().min(-180).max(180).describe('Longitude, WGS84 decimal degrees.'),
    },
    {
      error:
        'Each polygon vertex is a { lat, lng } object such as { "lat": 52.634, "lng": -1.136 }, or lat,lng in the string form; [lat, lng] pairs are not accepted because GeoJSON writes [lng, lat].',
    },
  )
  .describe('One polygon vertex as { lat, lng }.');

/**
 * Accepts the upstream string form `lat,lng:lat,lng:…` (split on `:` then `,`),
 * treats a blank string or empty list as unset, and cuts the list at max + 1
 * entries. A malformed vertex among those is reported alone: its own issues are
 * raised here, which stops the parse before the list's length checks, so a list
 * of `[lat, lng]` pairs yields one issue rather than one per vertex plus a
 * vertex count.
 */
function preparePolygon(value: unknown, ctx: z.core.$RefinementCtx): unknown {
  if (value === null) return;
  let vertices = value;
  if (typeof vertices === 'string') {
    const trimmed = vertices.trim();
    if (trimmed === '') return;
    vertices = trimmed.split(':').map((pair) => {
      const parts = pair.split(',').map((part) => part.trim());
      const [lat, lng] = parts.map(Number);
      return parts.length === 2 &&
        parts.every((part) => part !== '') &&
        Number.isFinite(lat) &&
        Number.isFinite(lng)
        ? { lat, lng }
        : pair;
    });
  }
  if (!Array.isArray(vertices)) return vertices;
  if (vertices.length === 0) return;
  const capped = vertices.slice(0, POLYGON_MAX_VERTICES + 1);
  for (const [index, vertex] of capped.entries()) {
    const parsed = PolygonVertex.safeParse(vertex);
    if (parsed.success) continue;
    for (const issue of parsed.error.issues)
      ctx.addIssue({ ...issue, path: [index, ...issue.path] });
    break;
  }
  return capped;
}

/** Polygon ring of 3–2,500 `{ lat, lng }` vertices (closed upstream). */
export const polygonInput = z.preprocess(
  preparePolygon,
  z.array(PolygonVertex).min(3).max(POLYGON_MAX_VERTICES).optional(),
);

/** Page size for the search tools, 1–200. */
export const limitInput = (defaultLimit: number) =>
  z.number().int().min(1).max(200).default(defaultLimit);

/** Rows to skip before the page. */
export const offsetInput = z.number().int().min(0).default(0);
