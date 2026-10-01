/**
 * @fileoverview Output vocabulary shared by the ukcrime search tools
 * (docs/design.md, Shared output conventions): the location object, the area
 * echo, breakdowns, the enrichment block every search declares, and the
 * markdown renderers `format()` uses for them.
 * @module mcp-server/tools/search-output
 */

import { z } from '@cyanheads/mcp-ts-core';
import { AREA_KINDS } from '@/services/police-api/area.js';
import { cell, inline } from './format-helpers.js';

/** A record's location — the anonymised map point and its street. */
export const LocationSchema = z
  .object({
    location_id: z
      .string()
      .describe("Snapped map point id; pass it as location_id with area 'location'."),
    street_name: z
      .string()
      .describe('Street as data.police.uk publishes it, always "On or near …".'),
    map_point: z
      .object({
        latitude: z.number().describe('Latitude, WGS84 decimal degrees.'),
        longitude: z.number().describe('Longitude, WGS84 decimal degrees.'),
      })
      .optional()
      .describe(
        'Anonymised map point covering at least eight addresses — not where the event happened. Absent when data.police.uk has no usable point.',
      ),
    type: z
      .enum(['Force', 'BTP'])
      .optional()
      .describe(
        "'BTP' marks a British Transport Police record at a station; 'Force' a territorial force record.",
      ),
    subtype: z
      .string()
      .optional()
      .describe('Station or premises type, when data.police.uk publishes one.'),
  })
  .describe('Where data.police.uk places the record: an anonymised map point and its street.');

export type LocationOutput = z.infer<typeof LocationSchema>;

/** The area as searched: the arm and its fields, plus what the point lookup found. */
export const AreaEchoSchema = z
  .object({
    type: z.enum(AREA_KINDS).describe('The area arm searched.'),
    lat: z.number().optional().describe("Latitude searched, for area 'point'."),
    lng: z.number().optional().describe("Longitude searched, for area 'point'."),
    vertex_count: z
      .number()
      .optional()
      .describe(
        "Vertices in the polygon searched — the neighbourhood's boundary for area 'neighbourhood'.",
      ),
    location_id: z.string().optional().describe("Map point searched, for area 'location'."),
    force: z.string().optional().describe('Force id searched, when the area names one.'),
    neighbourhood_id: z
      .string()
      .optional()
      .describe("Neighbourhood searched, for area 'neighbourhood'."),
    located_force: z
      .string()
      .optional()
      .describe("Force covering the point, for area 'point' when data.police.uk located it."),
    located_neighbourhood: z
      .string()
      .optional()
      .describe("Neighbourhood id covering the point, for area 'point' when located."),
  })
  .describe('The area as the server searched it.');

export type AreaEcho = z.infer<typeof AreaEchoSchema>;

/** One breakdown row. */
export interface BreakdownRow {
  readonly count: number;
  readonly value: string;
}

/** A `{ value, count }[]` breakdown, sorted by count then value. */
export const breakdownSchema = (description: string) =>
  z
    .array(
      z
        .object({
          value: z
            .string()
            .describe("The value as published; '(not recorded)' counts records that carry none."),
          count: z.number().describe('Matched records with this value.'),
        })
        .describe('One value and how many matched records carry it.'),
    )
    .describe(description);

/** The enrichment block every search tool declares; each writes the required fields first. */
export const SEARCH_ENRICHMENT = {
  attribution: z.string().describe('Open Government Licence attribution for data.police.uk data.'),
  data_note: z
    .string()
    .describe('What these records can and cannot say; read it before drawing conclusions.'),
  truncated: z
    .boolean()
    .describe('True when more rows remain after this page (offset + shown < total).'),
  shown: z.number().describe('Rows on this page.'),
  cap: z.number().describe('The limit applied to this page.'),
  notice: z
    .string()
    .optional()
    .describe(
      'The month searched when none was given, known coverage gaps, why a result is empty, and how to page on.',
    ),
};

/** Trailer labels for {@link SEARCH_ENRICHMENT}. */
export const SEARCH_ENRICHMENT_TRAILER = {
  attribution: { label: 'Attribution' },
  data_note: { label: 'Data note' },
  truncated: { label: 'More rows' },
  shown: { label: 'Rows shown' },
  cap: { label: 'Page limit' },
};

/** The area echo as one markdown line. */
export function renderArea(area: AreaEcho): string {
  const parts = [`**Area:** ${area.type}`];
  if (area.lat !== undefined) parts.push(`lat ${area.lat}`);
  if (area.lng !== undefined) parts.push(`lng ${area.lng}`);
  if (area.vertex_count !== undefined) parts.push(`${area.vertex_count} polygon vertices`);
  if (area.location_id !== undefined) parts.push(`location_id ${inline(area.location_id)}`);
  if (area.force !== undefined) parts.push(`force ${inline(area.force)}`);
  if (area.neighbourhood_id !== undefined)
    parts.push(`neighbourhood_id ${inline(area.neighbourhood_id)}`);
  if (area.located_force !== undefined) parts.push(`located force ${inline(area.located_force)}`);
  if (area.located_neighbourhood !== undefined)
    parts.push(`located neighbourhood ${inline(area.located_neighbourhood)}`);
  return parts.join(' · ');
}

/** A location as inline text; the coordinate pair is always labelled an anonymised map point. */
export function renderLocation(location: LocationOutput): string {
  const parts = [inline(location.street_name), `location_id ${inline(location.location_id)}`];
  if (location.map_point) {
    parts.push(
      `anonymised map point ${location.map_point.latitude}, ${location.map_point.longitude}`,
    );
  }
  if (location.type) parts.push(location.type === 'BTP' ? 'BTP (station)' : 'Force');
  if (location.subtype) parts.push(inline(location.subtype));
  return parts.join(' · ');
}

/** A breakdown as a markdown section with a two-column table. */
export function renderBreakdown(title: string, rows: readonly BreakdownRow[]): string[] {
  const lines = ['', `### ${title}`];
  if (rows.length === 0) return [...lines, '', '_None._'];
  lines.push('', '| Value | Count |', '|:--|--:|');
  for (const row of rows) lines.push(`| ${cell(row.value)} | ${row.count} |`);
  return lines;
}
