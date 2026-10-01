/**
 * @fileoverview The output vocabulary the search tools share: the location,
 * area-echo and breakdown schemas, the enrichment block and its trailer labels,
 * and the markdown renderers — which must keep upstream text inert (CR/LF, pipes,
 * brackets, bidi and line-separator characters).
 * @module tests/tools/search-output.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';
import {
  AreaEchoSchema,
  breakdownSchema,
  LocationSchema,
  renderArea,
  renderBreakdown,
  renderLocation,
  SEARCH_ENRICHMENT,
  SEARCH_ENRICHMENT_TRAILER,
} from '@/mcp-server/tools/search-output.js';
import { AREA_KINDS } from '@/services/police-api/area.js';

describe('LocationSchema', () => {
  it('requires location_id and street_name and accepts the optional fields', () => {
    expect(
      LocationSchema.parse({
        location_id: '1000001',
        street_name: 'On or near Example Street',
        map_point: { latitude: 52.63, longitude: -1.13 },
        type: 'BTP',
        subtype: 'Railway Station',
      }),
    ).toEqual({
      location_id: '1000001',
      street_name: 'On or near Example Street',
      map_point: { latitude: 52.63, longitude: -1.13 },
      type: 'BTP',
      subtype: 'Railway Station',
    });
    expect(LocationSchema.safeParse({ location_id: '1' }).success).toBe(false);
    expect(LocationSchema.safeParse({ street_name: 'x' }).success).toBe(false);
  });

  it('accepts only Force or BTP as the type', () => {
    expect(
      LocationSchema.safeParse({ location_id: '1', street_name: 'x', type: 'Force' }).success,
    ).toBe(true);
    expect(
      LocationSchema.safeParse({ location_id: '1', street_name: 'x', type: 'Other' }).success,
    ).toBe(false);
  });

  it('describes every field', () => {
    const json = z.toJSONSchema(LocationSchema) as {
      properties: Record<string, { description?: string }>;
    };
    for (const [name, property] of Object.entries(json.properties)) {
      expect(property.description, name).toBeTruthy();
    }
  });
});

describe('AreaEchoSchema', () => {
  it('accepts every area arm as the type and nothing else', () => {
    for (const type of AREA_KINDS)
      expect(AreaEchoSchema.safeParse({ type }).success, type).toBe(true);
    expect(AreaEchoSchema.safeParse({ type: 'country' }).success).toBe(false);
    expect(AreaEchoSchema.safeParse({}).success).toBe(false);
  });

  it('carries the arm fields and the located ids, all optional', () => {
    const echo = {
      type: 'point',
      lat: 52.63,
      lng: -1.13,
      vertex_count: 5,
      location_id: '1',
      force: 'leicestershire',
      neighbourhood_id: 'NX01',
      located_force: 'leicestershire',
      located_neighbourhood: 'NX01',
    };
    expect(AreaEchoSchema.parse(echo)).toEqual(echo);
  });
});

describe('breakdownSchema', () => {
  const schema = breakdownSchema('Rows by value.');

  it('validates { value, count } rows and carries the description given', () => {
    expect(schema.parse([{ value: 'x', count: 2 }])).toEqual([{ value: 'x', count: 2 }]);
    expect(schema.description).toBe('Rows by value.');
    expect(schema.safeParse([{ value: 'x' }]).success).toBe(false);
    expect(schema.safeParse([{ value: 1, count: 1 }]).success).toBe(false);
  });
});

describe('SEARCH_ENRICHMENT', () => {
  const schema = z.object(SEARCH_ENRICHMENT);

  it('declares attribution, data_note, truncated, shown and cap as required and notice as optional', () => {
    expect(Object.keys(SEARCH_ENRICHMENT)).toEqual([
      'attribution',
      'data_note',
      'truncated',
      'shown',
      'cap',
      'notice',
    ]);
    const required = { attribution: 'a', data_note: 'd', truncated: false, shown: 0, cap: 50 };
    expect(schema.safeParse(required).success).toBe(true);
    expect(schema.safeParse({ ...required, notice: 'n' }).success).toBe(true);
    for (const key of Object.keys(required)) {
      const { [key]: _gone, ...rest } = required as Record<string, unknown>;
      expect(schema.safeParse(rest).success, `without ${key}`).toBe(false);
    }
  });

  it('labels every declared field except notice in the trailer, and nothing else', () => {
    expect(Object.keys(SEARCH_ENRICHMENT_TRAILER)).toEqual([
      'attribution',
      'data_note',
      'truncated',
      'shown',
      'cap',
    ]);
    for (const key of Object.keys(SEARCH_ENRICHMENT_TRAILER)) {
      expect(SEARCH_ENRICHMENT).toHaveProperty(key);
    }
  });
});

describe('renderArea', () => {
  it('writes the arm and its fields as one line joined by middle dots', () => {
    expect(
      renderArea({
        type: 'point',
        lat: 52.63,
        lng: -1.13,
        located_force: 'leicestershire',
        located_neighbourhood: 'NX01',
      }),
    ).toBe(
      '**Area:** point · lat 52.63 · lng -1.13 · located force leicestershire · located neighbourhood NX01',
    );
  });

  it('renders each arm', () => {
    expect(renderArea({ type: 'polygon', vertex_count: 4 })).toBe(
      '**Area:** polygon · 4 polygon vertices',
    );
    expect(renderArea({ type: 'location', location_id: '1000001' })).toBe(
      '**Area:** location · location_id 1000001',
    );
    expect(
      renderArea({
        type: 'neighbourhood',
        force: 'leicestershire',
        neighbourhood_id: 'NX01',
        vertex_count: 85,
      }),
    ).toBe(
      '**Area:** neighbourhood · 85 polygon vertices · force leicestershire · neighbourhood_id NX01',
    );
    expect(renderArea({ type: 'force_unplaced', force: 'btp' })).toBe(
      '**Area:** force_unplaced · force btp',
    );
    expect(renderArea({ type: 'force', force: 'btp' })).toBe('**Area:** force · force btp');
  });

  it('renders 0 coordinates (a defined value), not as absent', () => {
    expect(renderArea({ type: 'point', lat: 0, lng: 0 })).toBe('**Area:** point · lat 0 · lng 0');
  });

  it('keeps upstream-derived ids inert: breaks become spaces, brackets and angle brackets are escaped', () => {
    const line = renderArea({
      type: 'neighbourhood',
      force: 'leicestershire',
      neighbourhood_id: 'A\r\nB [x](https://evil.test) <b>',
    });
    expect(line).not.toContain('\n');
    expect(line).not.toContain('\r');
    expect(line).toContain('neighbourhood_id A B \\[x\\](https://evil.test) \\<b\\>');
  });
});

describe('renderLocation', () => {
  it('labels the coordinate pair an anonymised map point and lists street, id, type and subtype', () => {
    expect(
      renderLocation({
        location_id: '1000001',
        street_name: 'On or near Example Street',
        map_point: { latitude: 52.63, longitude: -1.13 },
        type: 'BTP',
        subtype: 'Railway Station',
      }),
    ).toBe(
      'On or near Example Street · location_id 1000001 · anonymised map point 52.63, -1.13 · BTP (station) · Railway Station',
    );
  });

  it('renders a minimal location and a Force type', () => {
    expect(renderLocation({ location_id: '5', street_name: 'On or near X' })).toBe(
      'On or near X · location_id 5',
    );
    expect(renderLocation({ location_id: '5', street_name: 'On or near X', type: 'Force' })).toBe(
      'On or near X · location_id 5 · Force',
    );
  });

  it('never calls the coordinates the place of the event', () => {
    const text = renderLocation({
      location_id: '5',
      street_name: 'On or near X',
      map_point: { latitude: 1, longitude: 2 },
    });
    expect(text).toContain('anonymised map point 1, 2');
    expect(text).not.toMatch(/crime scene|happened at/i);
  });

  it('keeps street and subtype text inert, including bidi and line-separator characters', () => {
    const text = renderLocation({
      location_id: '1\n2',
      street_name: 'On or near A\r\n# Injected \u202Ebidi\u2028sep\u0085nel [l](u) <i>',
      subtype: 'Sta\ttion\u2029x',
    });
    expect(text).not.toMatch(/[\r\n\t\u2028\u2029\u0085\u202E]/);
    expect(text).toContain('On or near A # Injected bidi sep nel \\[l\\](u) \\<i\\>');
    expect(text).toContain('location_id 1 2');
    expect(text).toContain('Sta tion x');
  });
});

describe('renderBreakdown', () => {
  it('renders a heading and a two-column table, in the order given', () => {
    expect(
      renderBreakdown('By category', [
        { value: 'burglary', count: 3 },
        { value: 'drugs', count: 1 },
      ]),
    ).toEqual([
      '',
      '### By category',
      '',
      '| Value | Count |',
      '|:--|--:|',
      '| burglary | 3 |',
      '| drugs | 1 |',
    ]);
  });

  it('renders none for an empty breakdown', () => {
    expect(renderBreakdown('By outcome', [])).toEqual(['', '### By outcome', '', '_None._']);
  });

  it('keeps a value with a pipe, a break and markdown inside its cell', () => {
    const lines = renderBreakdown('By outcome', [
      { value: 'A | B\r\nC [x](y) <z>', count: 2 },
      { value: '(not recorded)', count: 1 },
    ]);
    expect(lines).toContain('| A \\| B C \\[x\\](y) \\<z\\> | 2 |');
    expect(lines).toContain('| (not recorded) | 1 |');
    expect(lines.join('\n')).not.toContain('\r');
  });

  it('does not let a trailing backslash cancel the pipe escape', () => {
    const [row] = renderBreakdown('t', [{ value: 'a\\', count: 1 }]).slice(-1);
    expect(row).toBe('| a\\\\ | 1 |');
  });
});
