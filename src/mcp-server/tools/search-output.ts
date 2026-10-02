/**
 * @fileoverview Output vocabulary shared by the ukcrime search tools
 * (docs/design.md, Shared output conventions): the location object, the area
 * echo, breakdowns, a range's per-month totals, the enrichment block every
 * search declares, and the markdown renderers `format()` uses for them.
 * @module mcp-server/tools/search-output
 */

import { z } from '@cyanheads/mcp-ts-core';
import { AREA_KINDS } from '@/services/police-api/area.js';
import { cell, inline } from './format-helpers.js';

/** A record's location — the anonymised map point and its street. */
export const LocationSchema = z
  .object({
    location_id: z.string().describe("Map point id; pass it as location_id with area 'location'."),
    street_name: z.string().describe('Street as published: "On or near …".'),
    map_point: z
      .object({
        latitude: z.number().describe('Latitude, WGS84.'),
        longitude: z.number().describe('Longitude, WGS84.'),
      })
      .optional()
      .describe(
        'Anonymised point covering at least eight addresses, not where it happened. Absent when unpublished.',
      ),
    type: z
      .enum(['Force', 'BTP'])
      .optional()
      .describe(
        "'BTP': a British Transport Police station record; 'Force': a territorial force's.",
      ),
    subtype: z.string().optional().describe('Station or premises type, when published.'),
  })
  .describe('Where data.police.uk places the record.');

export type LocationOutput = z.infer<typeof LocationSchema>;

/** The area as searched: the arm and its fields, plus the forces its lookups found. */
export const AreaEchoSchema = z
  .object({
    type: z.enum(AREA_KINDS).describe('The area arm searched.'),
    lat: z.number().optional().describe("Latitude, for 'point'."),
    lng: z.number().optional().describe("Longitude, for 'point'."),
    vertex_count: z
      .number()
      .optional()
      .describe("Polygon vertices; the boundary's, for 'neighbourhood'."),
    location_id: z.string().optional().describe("Map point, for 'location'."),
    force: z.string().optional().describe('Force id, when the area names one.'),
    neighbourhood_id: z.string().optional().describe("Neighbourhood id, for 'neighbourhood'."),
    located_force: z
      .string()
      .optional()
      .describe("Force covering the point, or the location's map point, when located."),
    located_neighbourhood: z
      .string()
      .optional()
      .describe("Neighbourhood covering the point, or the location's map point, when located."),
    located_forces: z
      .array(z.string().describe('Force id.'))
      .optional()
      .describe(
        "For 'polygon': forces its bounding-box centre and outermost vertices were located in, sorted; a point whose lookup failed adds none. Absent when none was located.",
      ),
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
          value: z.string().describe("As published; '(not recorded)' when absent."),
          count: z.number().describe('Matched records.'),
        })
        .describe('A value and its count.'),
    )
    .describe(description);

/** One month of a range: the month and its matched total. A tool with more per-month facts extends it. */
export const MonthTotalSchema = z.object({
  month: z.string().describe('Month, YYYY-MM.'),
  total: z.number().describe('Matched records in this month, after every filter.'),
});

/** One by-month row as the renderer reads it; `force_published` is the stop-and-search column. */
export interface MonthTotalRow {
  readonly force_published?: boolean | undefined;
  readonly month: string;
  readonly total: number;
}

/** `by_month`: present only when `month_from` was given. */
export const byMonthSchema = <Row extends z.ZodType>(row: Row, description: string) =>
  z.array(row.describe('One month of the range.')).optional().describe(description);

/** The enrichment block every search tool declares; each writes the required fields first. */
export const SEARCH_ENRICHMENT = {
  attribution: z.string().describe('Open Government Licence attribution.'),
  data_note: z.string().describe('What these records can and cannot say; read it first.'),
  truncated: z.boolean().describe('True when more rows remain after this page.'),
  shown: z.number().describe('Rows on this page.'),
  cap: z.number().describe('Page limit applied.'),
  notice: z
    .string()
    .optional()
    .describe('Defaulted month, coverage gaps, why a result is empty, and how to page on.'),
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
  if (area.located_forces !== undefined)
    parts.push(`located forces ${area.located_forces.map(inline).join(', ')}`);
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

/**
 * A range's per-month totals as a markdown section, oldest month first; a
 * published column appears when any row carries `force_published` (`unknown`
 * where one does not).
 */
export function renderByMonth(noun: string, rows: readonly MonthTotalRow[]): string[] {
  const flagged = rows.some((row) => row.force_published !== undefined);
  const lines = ['', '### By month', ''];
  lines.push(
    flagged
      ? `| Month | ${noun} | Every force found for the area published |`
      : `| Month | ${noun} |`,
    flagged ? '|:--|--:|:--|' : '|:--|--:|',
  );
  for (const row of rows) {
    const published =
      row.force_published === undefined ? 'unknown' : row.force_published ? 'yes' : 'no';
    lines.push(
      flagged
        ? `| ${row.month} | ${row.total} | ${published} |`
        : `| ${row.month} | ${row.total} |`,
    );
  }
  return lines;
}

/** A breakdown as a markdown section with a two-column table. */
export function renderBreakdown(title: string, rows: readonly BreakdownRow[]): string[] {
  const lines = ['', `### ${title}`];
  if (rows.length === 0) return [...lines, '', '_None._'];
  lines.push('', '| Value | Count |', '|:--|--:|');
  for (const row of rows) lines.push(`| ${cell(row.value)} | ${row.count} |`);
  return lines;
}
