/**
 * @fileoverview The wave 3 record normalizers: a crime's outcome history, a
 * neighbourhood's profile, its priorities and its events. Upstream sentinels
 * (`"0"` populations, unparseable centres, non-string contact values, blank and
 * null fields) read as absence, HTML fields become text, sort orders hold
 * (history by month with upstream order kept inside a month, events by start with
 * undated last), the raw schemas drop the person-level fields, and no normalizer
 * mutates the parsed body it was handed.
 * @module tests/services/records-neighbourhood.test
 */

import { describe, expect, it } from 'vitest';
import {
  RawCrimeHistory,
  RawEvents,
  RawNeighbourhoodDetail,
  RawPeople,
  RawPriorities,
} from '@/services/police-api/raw-schemas.js';
import {
  normalizeCrimeHistory,
  normalizeEvents,
  normalizeNeighbourhood,
  normalizePriorities,
} from '@/services/police-api/records.js';
import {
  crimeRecord,
  eventsBody,
  neighbourhoodDetailBody,
  peopleBody,
  prioritiesBody,
  sparseCrimeRecord,
  wireLocation,
} from '../fixtures/police-api-upstream.js';
import { historyOutcome, peopleWithPrivateFields } from '../fixtures/police-api-upstream-w3.js';

/** Freezes a parsed body all the way down, so any write to it throws in strict mode. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const history = (body: unknown) => normalizeCrimeHistory(RawCrimeHistory.parse(body));
const hood = (overrides: Record<string, unknown> = {}) =>
  normalizeNeighbourhood(RawNeighbourhoodDetail.parse(neighbourhoodDetailBody(overrides)));
const priorities = (...records: unknown[]) => normalizePriorities(RawPriorities.parse(records));
const events = (...records: unknown[]) => normalizeEvents(RawEvents.parse(records));

describe('normalizeCrimeHistory', () => {
  it('writes the crime in wire shape without a latest outcome, and every outcome as { code, name, month }', () => {
    const result = history({
      crime: crimeRecord({ persistent_id: 'a'.repeat(64) }),
      outcomes: [historyOutcome('under-investigation', 'Under investigation', '2026-07')],
    });
    expect(result).toEqual({
      crime: {
        id: '100000001',
        persistent_id: 'a'.repeat(64),
        category: 'burglary',
        month: '2026-08',
        location: {
          location_id: '1000001',
          street_name: 'On or near Example Street',
          map_point: { latitude: 52.63, longitude: -1.13 },
          type: 'Force',
        },
      },
      outcomes: [{ code: 'under-investigation', name: 'Under investigation', month: '2026-07' }],
    });
    expect(result.crime).not.toHaveProperty('outcome');
  });

  it('never carries person_id, the crime outcome_status or any key the schema does not read', () => {
    const result = history({
      crime: crimeRecord({ outcome_status: { category: 'X', date: '2026-01' }, extra: 'x' }),
      outcomes: [historyOutcome('cautioned', 'Cautioned', '2026-07')],
      person_id: 'secret',
    });
    const json = JSON.stringify(result);
    expect(json).not.toContain('person_id');
    expect(json).not.toContain('outcome_status');
    expect(json).not.toContain('extra');
  });

  it('sorts outcomes by month and keeps upstream order within a month (stable)', () => {
    const result = history({
      crime: crimeRecord(),
      outcomes: [
        historyOutcome('c-third', 'Third', '2026-07'),
        historyOutcome('a-first', 'First', '2026-05'),
        historyOutcome('z-second', 'Second', '2026-07'),
        historyOutcome('b-older', 'Older', '2025-12'),
        historyOutcome('m-fourth', 'Fourth', '2026-07'),
      ],
    });
    expect(result.outcomes?.map((outcome) => outcome.code)).toEqual([
      'b-older',
      'a-first',
      'c-third',
      'z-second',
      'm-fourth',
    ]);
  });

  it('compares months as text, so a year boundary and single digits cannot misorder', () => {
    const result = history({
      crime: crimeRecord(),
      outcomes: [
        historyOutcome('b', 'B', '2026-01'),
        historyOutcome('a', 'A', '2025-12'),
        historyOutcome('c', 'C', '2026-10'),
      ],
    });
    expect(result.outcomes?.map((outcome) => outcome.month)).toEqual([
      '2025-12',
      '2026-01',
      '2026-10',
    ]);
  });

  it('keeps outcomes: null as null (history not published) and [] as an empty history', () => {
    expect(history({ crime: crimeRecord(), outcomes: null }).outcomes).toBeNull();
    expect(history({ crime: crimeRecord(), outcomes: [] }).outcomes).toEqual([]);
  });

  it('reads sentinels as absence on the crime: empty persistent id and context, null location, 0,0 map point, blank subtype', () => {
    const sparse = history({
      crime: sparseCrimeRecord({ category: 'anti-social-behaviour', context: '   ' }),
      outcomes: [],
    }).crime;
    expect(sparse).toEqual({
      id: '100000002',
      category: 'anti-social-behaviour',
      month: '2026-08',
    });
    const zeroed = history({
      crime: crimeRecord({
        location: wireLocation(1_000_009, 'On or near Example Lane', '0.000000', '0.000000'),
        location_subtype: '  ',
        context: '',
        persistent_id: '',
      }),
      outcomes: [],
    }).crime;
    expect(zeroed.location).toEqual({
      location_id: '1000009',
      street_name: 'On or near Example Lane',
      type: 'Force',
    });
    expect(zeroed).not.toHaveProperty('persistent_id');
    expect(zeroed).not.toHaveProperty('context');
  });

  it('keeps context text and a BTP station subtype', () => {
    const { crime } = history({
      crime: crimeRecord({
        context: 'Line one\r\nLine two',
        location_type: 'BTP',
        location_subtype: 'Railway Station',
      }),
      outcomes: [],
    });
    expect(crime.context).toBe('Line one\r\nLine two');
    expect(crime.location).toMatchObject({ type: 'BTP', subtype: 'Railway Station' });
  });

  it('reads numeric crime and street ids as strings', () => {
    const { crime } = history({ crime: crimeRecord({ id: 42 }), outcomes: [] });
    expect(crime.id).toBe('42');
    expect(crime.location?.location_id).toBe('1000001');
  });

  it('does not mutate the parsed body', () => {
    const parsed = deepFreeze(
      RawCrimeHistory.parse({
        crime: crimeRecord(),
        outcomes: [historyOutcome('b', 'B', '2026-07'), historyOutcome('a', 'A', '2026-05')],
      }),
    );
    expect(() => normalizeCrimeHistory(parsed)).not.toThrow();
    expect(parsed.outcomes?.map((outcome) => outcome.category.code)).toEqual(['b', 'a']);
  });

  it('rejects a body whose outcome lacks its category at parse time (the schema, not the normalizer, guards shape)', () => {
    expect(
      RawCrimeHistory.safeParse({ crime: crimeRecord(), outcomes: [{ date: '2026-07' }] }).success,
    ).toBe(false);
    expect(RawCrimeHistory.safeParse({ crime: crimeRecord() }).success).toBe(false);
  });
});

describe('normalizeNeighbourhood', () => {
  it('writes the profile in wire shape from a full upstream body', () => {
    expect(hood()).toEqual({
      id: 'NX01',
      name: 'Example Central',
      url: 'https://www.example-force.police.test/nx01',
      centre: { latitude: 52.635, longitude: -1.13 },
      population: 4200,
      description: 'An invented neighbourhood.',
      contact: [
        { channel: 'email', value: 'nx01@example-force.police.test' },
        { channel: 'telephone', value: '101' },
      ],
      links: [],
      stations: [
        {
          type: 'station',
          name: 'Example Central Station',
          address: '1 Example Street\nExample Town',
          postcode: 'EX1 1AA',
        },
      ],
    });
  });

  it('strips upstream station keys the schema does not read (coordinates)', () => {
    const [station] = hood().stations;
    expect(station).not.toHaveProperty('latitude');
    expect(station).not.toHaveProperty('longitude');
  });

  it('reads a numeric neighbourhood id as a string', () => {
    expect(hood({ id: 7 }).id).toBe('7');
  });

  describe('population', () => {
    it.each<[string, unknown, number | undefined]>([
      ['a positive count', '4200', 4200],
      ['a padded count', ' 150 ', 150],
      ['"0" (city-centre neighbourhoods)', '0', undefined],
      ['an empty string', '', undefined],
      ['whitespace', '   ', undefined],
      ['null', null, undefined],
      ['not a number', 'n/a', undefined],
      ['a thousands separator', '1,200', undefined],
      ['a negative number', '-3', undefined],
      ['infinity', 'Infinity', undefined],
    ])('reads %s as %j', (_name, population, expected) => {
      const result = hood({ population });
      if (expected === undefined) expect(result).not.toHaveProperty('population');
      else expect(result.population).toBe(expected);
    });

    it('reads a missing population as absent', () => {
      const body = neighbourhoodDetailBody();
      const { population: _population, ...rest } = body;
      expect(normalizeNeighbourhood(RawNeighbourhoodDetail.parse(rest))).not.toHaveProperty(
        'population',
      );
    });
  });

  describe('centre', () => {
    it.each<[string, unknown]>([
      ['both coordinates unparseable', { latitude: 'abc', longitude: '' }],
      ['one coordinate unparseable', { latitude: '52.6', longitude: 'abc' }],
      ['one coordinate null', { latitude: '52.6', longitude: null }],
      ['an empty object', {}],
      ['null', null],
    ])('drops a centre with %s', (_name, centre) => {
      expect(hood({ centre })).not.toHaveProperty('centre');
    });

    it('drops a missing centre and parses decimal strings otherwise', () => {
      const { centre: _centre, ...rest } = neighbourhoodDetailBody();
      expect(normalizeNeighbourhood(RawNeighbourhoodDetail.parse(rest))).not.toHaveProperty(
        'centre',
      );
      expect(
        hood({ centre: { latitude: '51.5000000000', longitude: '-0.1200000000' } }).centre,
      ).toEqual({
        latitude: 51.5,
        longitude: -0.12,
      });
    });
  });

  describe('url', () => {
    it.each<[string, unknown]>([
      ['blank', '   '],
      ['empty', ''],
      ['null', null],
    ])('drops a %s url_force', (_name, url_force) => {
      expect(hood({ url_force })).not.toHaveProperty('url');
    });

    it('trims url_force', () => {
      expect(hood({ url_force: '  https://example.test/a  ' }).url).toBe('https://example.test/a');
    });

    it.each([
      'http://example.test/a',
      'https://example.test/a?b=1&c=2#d',
      'HTTPS://Example.test/A',
    ])('keeps the http or https url_force %j as published', (url_force) => {
      expect(hood({ url_force }).url).toBe(url_force);
    });

    it.each<[string, string]>([
      ['a javascript: url', 'javascript:alert(1)'],
      ['a javascript: url split by a tab', 'java\tscript:alert(1)'],
      ['a data: url', 'data:text/html,<b>x</b>'],
      ['a vbscript: url', 'vbscript:msgbox(1)'],
      ['a file: url', 'file:///etc/passwd'],
      ['an ftp: url', 'ftp://example.test/a'],
      ['a mailto: url', 'mailto:team@example.test'],
      ['a relative path', '/neighbourhood/nx01'],
      ['a host without a scheme', 'www.example.test/nx01'],
      ['an unparseable url', 'https://exa mple.test/'],
    ])('drops %s', (_name, url_force) => {
      expect(hood({ url_force })).not.toHaveProperty('url');
    });
  });

  describe('description', () => {
    it('converts HTML to text, decoding entities and breaking blocks onto lines', () => {
      expect(
        hood({ description: '<p>Line one &amp; two</p><p>Line&nbsp;three<br>four</p>' })
          .description,
      ).toBe('Line one & two\nLine three\nfour');
    });

    it.each<[string, unknown]>([
      ['null', null],
      ['empty', ''],
      ['tags only', '<p></p><br>'],
      ['whitespace', '  \n '],
    ])('reads a %s description as absent', (_name, description) => {
      expect(hood({ description })).not.toHaveProperty('description');
    });

    it('reads a missing description key as absent (upstream can omit it)', () => {
      const { description: _description, ...rest } = neighbourhoodDetailBody();
      expect(normalizeNeighbourhood(RawNeighbourhoodDetail.parse(rest))).not.toHaveProperty(
        'description',
      );
    });

    it('drops script and style content rather than treating it as text', () => {
      expect(
        hood({ description: '<p>Hi</p><script>alert(1)</script><style>p{}</style>' }).description,
      ).toBe('Hi');
    });
  });

  describe('contact', () => {
    it('keeps string values in upstream order, trimmed, with their channel names', () => {
      expect(
        hood({
          contact_details: {
            twitter: ' https://social.example.test/nx01 ',
            email: 'nx01@example-force.police.test',
            telephone: '101',
          },
        }).contact,
      ).toEqual([
        { channel: 'twitter', value: 'https://social.example.test/nx01' },
        { channel: 'email', value: 'nx01@example-force.police.test' },
        { channel: 'telephone', value: '101' },
      ]);
    });

    it('drops non-string values and blank strings', () => {
      expect(
        hood({
          contact_details: {
            email: 'keep@example.test',
            phone: 101,
            fax: null,
            nested: { a: 'b' },
            list: ['x'],
            flag: true,
            blank: '   ',
            empty: '',
          },
        }).contact,
      ).toEqual([{ channel: 'email', value: 'keep@example.test' }]);
    });

    it.each<[string, unknown]>([
      ['null', null],
      ['an empty object', {}],
    ])('reads %s contact_details as an empty list', (_name, contact_details) => {
      expect(hood({ contact_details }).contact).toEqual([]);
    });

    it('reads missing contact_details as an empty list', () => {
      const { contact_details: _contact, ...rest } = neighbourhoodDetailBody();
      expect(normalizeNeighbourhood(RawNeighbourhoodDetail.parse(rest)).contact).toEqual([]);
    });
  });

  describe('links', () => {
    it('keeps a titled link with its url, and an optional description when non-blank', () => {
      expect(
        hood({
          links: [
            { title: 'Example link', url: ' https://example.test/a ', description: 'About' },
            { title: 'No description', url: 'https://example.test/b', description: null },
            { title: 'Blank description', url: 'https://example.test/c', description: '  ' },
          ],
        }).links,
      ).toEqual([
        { title: 'Example link', url: 'https://example.test/a', description: 'About' },
        { title: 'No description', url: 'https://example.test/b' },
        { title: 'Blank description', url: 'https://example.test/c' },
      ]);
    });

    it('drops links without a title or without a url, so one odd link never fails the profile', () => {
      const result = hood({
        links: [
          { title: null, url: 'https://example.test/a', description: null },
          { title: '  ', url: 'https://example.test/b', description: null },
          { title: 'No url', url: null, description: null },
          { title: 'Blank url', url: '   ', description: null },
          { title: 'Keeper', url: 'https://example.test/k', description: null },
          {},
        ],
      });
      expect(result.links).toEqual([{ title: 'Keeper', url: 'https://example.test/k' }]);
    });

    it('drops a link whose url is not http or https', () => {
      const result = hood({
        links: [
          { title: 'Script', url: 'javascript:alert(1)', description: null },
          { title: 'Data', url: 'data:text/html,<b>x</b>', description: null },
          { title: 'Relative', url: '/a', description: null },
          { title: 'No scheme', url: 'www.example.test/a', description: null },
          { title: 'Keeper', url: ' http://example.test/k ', description: null },
        ],
      });
      expect(result.links).toEqual([{ title: 'Keeper', url: 'http://example.test/k' }]);
    });

    it.each<[string, unknown]>([
      ['null', null],
      ['empty', []],
    ])('reads %s links as an empty list', (_name, links) => {
      expect(hood({ links }).links).toEqual([]);
    });
  });

  describe('stations', () => {
    it('keeps each non-blank field of a station and leaves the others out', () => {
      expect(
        hood({
          locations: [
            {
              type: 'base',
              name: 'Example Base',
              description: null,
              address: '  ',
              postcode: null,
            },
            {
              type: null,
              name: null,
              description: 'Open 9-5',
              address: 'Example Road',
              postcode: 'EX2 2BB',
            },
          ],
        }).stations,
      ).toEqual([
        { type: 'base', name: 'Example Base' },
        { description: 'Open 9-5', address: 'Example Road', postcode: 'EX2 2BB' },
      ]);
    });

    it('drops stations with nothing published and keeps order for the rest', () => {
      expect(
        hood({
          locations: [
            { type: null, name: null, description: null, address: null, postcode: null },
            { type: '', name: '  ', description: '', address: '\n', postcode: '' },
            {},
            { name: 'Second Station' },
            { name: 'First Station' },
          ],
        }).stations,
      ).toEqual([{ name: 'Second Station' }, { name: 'First Station' }]);
    });

    it('keeps address and description text as published (line breaks included; HTML is not converted)', () => {
      const [station] = hood({
        locations: [{ name: 'S', address: 'Line 1\r\nLine 2', description: '<b>Open</b>' }],
      }).stations;
      expect(station).toEqual({
        name: 'S',
        address: 'Line 1\r\nLine 2',
        description: '<b>Open</b>',
      });
    });

    it.each<[string, unknown]>([
      ['null', null],
      ['empty', []],
    ])('reads %s locations as an empty list', (_name, locations) => {
      expect(hood({ locations }).stations).toEqual([]);
    });
  });

  it('reads a profile with nothing past id and name', () => {
    expect(
      normalizeNeighbourhood(RawNeighbourhoodDetail.parse({ id: 'NX09', name: 'Bare' })),
    ).toEqual({
      id: 'NX09',
      name: 'Bare',
      contact: [],
      links: [],
      stations: [],
    });
  });

  it('reads a profile with every optional key null', () => {
    expect(
      hood({
        url_force: null,
        centre: null,
        population: null,
        description: null,
        contact_details: null,
        links: null,
        locations: null,
      }),
    ).toEqual({ id: 'NX01', name: 'Example Central', contact: [], links: [], stations: [] });
  });

  it('does not mutate the parsed body', () => {
    const parsed = deepFreeze(RawNeighbourhoodDetail.parse(neighbourhoodDetailBody()));
    expect(() => normalizeNeighbourhood(parsed)).not.toThrow();
  });
});

describe('normalizePriorities', () => {
  it('writes issue and action as text with the dates as published, hyphenated keys becoming snake_case', () => {
    expect(priorities(...prioritiesBody())).toEqual([
      {
        issue: 'Anti-social behaviour & fly-tipping.',
        issue_date: '2026-07-01T00:00:00',
        action: 'Patrols\nCommunity meetings',
        action_date: '2026-08-01T00:00:00',
      },
    ]);
  });

  it('leaves out a null or blank action, and null or blank dates', () => {
    expect(
      priorities(
        { issue: '<p>One</p>', 'issue-date': null, action: null, 'action-date': null },
        { issue: '<p>Two</p>', 'issue-date': '  ', action: '<p></p>', 'action-date': '' },
        { issue: '<p>Three</p>' },
      ),
    ).toEqual([{ issue: 'One' }, { issue: 'Two' }, { issue: 'Three' }]);
  });

  it('keeps an action date when the action is absent', () => {
    expect(
      priorities({ issue: 'One', action: null, 'action-date': '2026-08-01T00:00:00' }),
    ).toEqual([{ issue: 'One', action_date: '2026-08-01T00:00:00' }]);
  });

  it('drops a priority whose issue has no text left, and keeps the order of the rest', () => {
    expect(
      priorities(
        { issue: 'First' },
        { issue: '' },
        { issue: '<p></p>', action: 'Orphan action' },
        { issue: '   ' },
        { issue: 'Second' },
      ),
    ).toEqual([{ issue: 'First' }, { issue: 'Second' }]);
  });

  it('decodes entities once, so escaped markup comes through as literal text for format() to escape', () => {
    expect(priorities({ issue: '&lt;b&gt;bold&lt;/b&gt; &amp;amp; more' })[0]?.issue).toBe(
      '<b>bold</b> &amp; more',
    );
  });

  it('returns an empty list for an empty body', () => {
    expect(priorities()).toEqual([]);
  });

  it('does not mutate the parsed body', () => {
    const parsed = deepFreeze(RawPriorities.parse(prioritiesBody()));
    expect(() => normalizePriorities(parsed)).not.toThrow();
  });
});

describe('normalizeEvents', () => {
  it('writes the wire shape, description as text, and never carries contact_details', () => {
    const result = events(...eventsBody());
    expect(result).toEqual([
      {
        title: 'Example drop-in session',
        type: 'meeting',
        start: '2026-09-15T18:00:00',
        end: '2026-09-15T19:00:00',
        address: 'Example Hall, Example Street',
        description: 'Meet your team.',
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('events@example.test');
  });

  it('sorts by start ascending, comparing the text, whatever the upstream order', () => {
    const result = events(
      { title: 'C', start_date: '2026-10-01T09:00:00' },
      { title: 'A', start_date: '2026-09-02T18:00:00' },
      { title: 'B', start_date: '2026-09-15T08:00:00' },
      { title: 'D', start_date: '2027-01-01T00:00:00' },
    );
    expect(result.map((event) => event.title)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('puts undated events last (null, missing, blank) and keeps their upstream order', () => {
    const result = events(
      { title: 'U1', start_date: null },
      { title: 'Later', start_date: '2026-10-01T09:00:00' },
      { title: 'U2' },
      { title: 'Sooner', start_date: '2026-09-01T09:00:00' },
      { title: 'U3', start_date: '   ' },
      { title: 'U4', start_date: '' },
    );
    expect(result.map((event) => event.title)).toEqual(['Sooner', 'Later', 'U1', 'U2', 'U3', 'U4']);
    for (const event of result.slice(2)) expect(event).not.toHaveProperty('start');
  });

  it('keeps upstream order between events with the same start (stable)', () => {
    const result = events(
      { title: 'Second', start_date: '2026-09-01T09:00:00' },
      { title: 'First', start_date: '2026-08-01T09:00:00' },
      { title: 'Third', start_date: '2026-09-01T09:00:00' },
      { title: 'Fourth', start_date: '2026-09-01T09:00:00' },
    );
    expect(result.map((event) => event.title)).toEqual(['First', 'Second', 'Third', 'Fourth']);
  });

  it('reads blank and null optional fields as absent', () => {
    expect(
      events({
        title: 'Bare',
        type: null,
        start_date: null,
        end_date: '  ',
        address: '',
        description: '<p></p>',
      }),
    ).toEqual([{ title: 'Bare' }]);
  });

  it('keeps the title exactly as published', () => {
    expect(events({ title: '  Padded <b>title</b>  ' })[0]?.title).toBe('  Padded <b>title</b>  ');
  });

  it('returns an empty list for an empty body', () => {
    expect(events()).toEqual([]);
  });

  it('does not mutate the parsed body', () => {
    const parsed = deepFreeze(RawEvents.parse(eventsBody()));
    expect(() => normalizeEvents(parsed)).not.toThrow();
  });
});

describe('raw schemas for the neighbourhood sections', () => {
  it('RawPeople reads rank and name only: bio, per-person contacts and extra keys never survive the parse', () => {
    const parsed = RawPeople.parse(peopleWithPrivateFields());
    expect(parsed).toEqual([
      { name: 'Example Officer', rank: 'PC 0000' },
      { name: 'Sample Sergeant', rank: 'Sgt 0000' },
    ]);
    const json = JSON.stringify(parsed);
    expect(json).not.toContain('Invented biography');
    expect(json).not.toContain('private-officer@example.test');
    expect(json).not.toContain('collar_number');
    expect(RawPeople.parse(peopleBody())).toEqual([
      { name: 'Example Officer', rank: 'PC 0000' },
      { name: 'Sample Sergeant', rank: 'Sgt 0000' },
    ]);
  });

  it('RawPeople rejects an entry without a rank or a name', () => {
    expect(RawPeople.safeParse([{ name: 'Example Officer' }]).success).toBe(false);
    expect(RawPeople.safeParse([{ rank: 'PC 0000' }]).success).toBe(false);
    expect(RawPeople.safeParse([{ name: null, rank: 'PC 0000' }]).success).toBe(false);
  });

  it('RawEvents drops contact_details and RawPriorities requires an issue', () => {
    expect(RawEvents.parse(eventsBody())[0]).not.toHaveProperty('contact_details');
    expect(RawPriorities.safeParse([{ action: 'x' }]).success).toBe(false);
    expect(RawEvents.safeParse([{ type: 'meeting' }]).success).toBe(false);
  });

  it('RawNeighbourhoodDetail requires only id and name', () => {
    expect(RawNeighbourhoodDetail.safeParse({ id: 'NX01' }).success).toBe(false);
    expect(RawNeighbourhoodDetail.safeParse({ name: 'Example' }).success).toBe(false);
    expect(RawNeighbourhoodDetail.safeParse({ id: 'NX01', name: 'Example' }).success).toBe(true);
  });
});

describe('HTML field length', () => {
  const LIMIT = 65_536;
  const MARK = '[Cut: the published field is longer than 65,536 characters.]';

  const FIELDS: readonly [string, (html: string) => string | undefined][] = [
    ['a neighbourhood description', (html) => hood({ description: html }).description],
    ['a priority issue', (html) => priorities({ issue: html })[0]?.issue],
    ['a priority action', (html) => priorities({ issue: 'Issue', action: html })[0]?.action],
    [
      'an event description',
      (html) => events({ title: 'Event', description: html })[0]?.description,
    ],
  ];

  it.each(FIELDS)('cuts %s at 65,536 characters of HTML and marks the cut', (_name, convert) => {
    expect(convert(`<p>${'a'.repeat(LIMIT)}</p>`)).toBe(`${'a'.repeat(LIMIT - 3)}\n${MARK}`);
  });

  it.each(FIELDS)('leaves %s of exactly 65,536 characters whole', (_name, convert) => {
    expect(convert('a'.repeat(LIMIT))).toBe('a'.repeat(LIMIT));
  });

  it('never cuts between the two halves of a surrogate pair', () => {
    const text = hood({ description: `${'a'.repeat(LIMIT - 1)}\u{1F600}b` }).description;
    expect(text).toBe(`${'a'.repeat(LIMIT - 1)}\n${MARK}`);
    expect(text?.isWellFormed()).toBe(true);
  });

  it('bounds the work on a field made of unclosed tags', () => {
    const start = performance.now();
    expect(hood({ description: '<script>'.repeat(500_000) })).not.toHaveProperty('description');
    expect(performance.now() - start).toBeLessThan(250);
  });
});
