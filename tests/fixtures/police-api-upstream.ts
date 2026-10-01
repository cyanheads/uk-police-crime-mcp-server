/**
 * @fileoverview Upstream fixture bodies and response builders in the shapes
 * docs/design.md records for data.police.uk (API Reference: Endpoints used,
 * Record shapes, Status semantics). Shared by every test agent: bodies are plain
 * data builders and responses are fresh per call, so a fixture never carries
 * state between requests. Every person-level field is invented
 * (`Example Officer`, `PC 0000`); force ids, category slugs and the
 * `YYYY-MM` window are public reference data. Synthetic neighbourhood ids
 * (`NX01`) and street ids keep fixtures off real map points.
 * @module tests/fixtures/police-api-upstream
 */

export const API_BASE = 'https://data.police.uk/api';

/** The published window the fixtures describe (matches the design's probe, `2023-09`–`2026-08`). */
export const LATEST_MONTH = '2026-08';
export const EARLIEST_MONTH = '2023-09';

/** A response factory: called once per request so every call gets a fresh body. */
export type Responder = (request: Request) => Response | Promise<Response>;

// --- Reference bodies ------------------------------------------------------------

/** `GET /crime-last-updated` — the first day of the latest month. */
export const lastUpdatedBody = (date = `${LATEST_MONTH}-01`) => ({ date });

/** One row of `GET /crimes-street-dates`. */
export interface StreetDateRow {
  readonly date: string;
  readonly 'stop-and-search': readonly string[];
}

/** Every month from `from` to `to` inclusive, newest first, each with the same stop-and-search publishers. */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const [toYear = 0, toMonth = 0] = to.split('-').map(Number);
  let [year = 0, month = 0] = from.split('-').map(Number);
  while (year < toYear || (year === toYear && month <= toMonth)) {
    out.push(`${year}-${String(month).padStart(2, '0')}`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return out.reverse();
}

/** `GET /crimes-street-dates` over the full fixture window, newest first. */
export function streetDatesBody(
  options: {
    from?: string;
    to?: string;
    stopSearch?: readonly string[] | ((month: string) => readonly string[]);
  } = {},
): StreetDateRow[] {
  const {
    from = EARLIEST_MONTH,
    to = LATEST_MONTH,
    stopSearch = ['leicestershire', 'btp'],
  } = options;
  return monthsBetween(from, to).map((date) => ({
    date,
    'stop-and-search': typeof stopSearch === 'function' ? [...stopSearch(date)] : [...stopSearch],
  }));
}

/** `GET /forces` — a representative subset of the 44 (public reference data). `btp` is never listed. */
export const forcesBody = () => [
  { id: 'avon-and-somerset', name: 'Avon and Somerset Constabulary' },
  { id: 'devon-and-cornwall', name: 'Devon & Cornwall Police' },
  { id: 'dyfed-powys', name: 'Dyfed-Powys Police' },
  { id: 'greater-manchester', name: 'Greater Manchester Police' },
  { id: 'leicestershire', name: 'Leicestershire Police' },
  { id: 'metropolitan', name: 'Metropolitan Police Service' },
  { id: 'northern-ireland', name: 'Police Service of Northern Ireland' },
];

/** `GET /crime-categories` — all 15, `url` being the slug. */
export const categoriesBody = () => [
  { url: 'all-crime', name: 'All crime' },
  { url: 'anti-social-behaviour', name: 'Anti-social behaviour' },
  { url: 'bicycle-theft', name: 'Bicycle theft' },
  { url: 'burglary', name: 'Burglary' },
  { url: 'criminal-damage-arson', name: 'Criminal damage and arson' },
  { url: 'drugs', name: 'Drugs' },
  { url: 'other-theft', name: 'Other theft' },
  { url: 'possession-of-weapons', name: 'Possession of weapons' },
  { url: 'public-order', name: 'Public order' },
  { url: 'robbery', name: 'Robbery' },
  { url: 'shoplifting', name: 'Shoplifting' },
  { url: 'theft-from-the-person', name: 'Theft from the person' },
  { url: 'vehicle-crime', name: 'Vehicle crime' },
  { url: 'violent-crime', name: 'Violence and sexual offences' },
  { url: 'other-crime', name: 'Other crime' },
];

/** `GET /forces/{id}` — full upstream shape; `url` and `telephone` are the fields the server keeps. */
export const forceDetailBody = (overrides: Record<string, unknown> = {}) => ({
  id: 'leicestershire',
  name: 'Leicestershire Police',
  url: 'https://www.example-force.police.test',
  telephone: '101',
  description: null,
  engagement_methods: [
    {
      type: 'twitter',
      title: 'Twitter',
      description: null,
      url: 'https://social.example.test/force',
    },
  ],
  ...overrides,
});

/** `GET /{force}/neighbourhoods` — synthetic ids, upstream order (unsorted by name). */
export const neighbourhoodsBody = () => [
  { id: 'NX03', name: 'Example Harbour' },
  { id: 'NX01', name: 'Example Central' },
  { id: 'NX02', name: 'Example Meadows' },
];

/** `GET /locate-neighbourhood?q=lat,lng`. */
export const locateBody = (overrides: Record<string, unknown> = {}) => ({
  force: 'leicestershire',
  neighbourhood: 'NX01',
  ...overrides,
});

/** `GET /{force}/{id}/boundary` — decimal strings at 10 dp, first vertex repeated last. */
export const boundaryBody = () => [
  { latitude: '52.6300000000', longitude: '-1.1400000000' },
  { latitude: '52.6300000000', longitude: '-1.1200000000' },
  { latitude: '52.6400000000', longitude: '-1.1200000000' },
  { latitude: '52.6400000000', longitude: '-1.1400000000' },
  { latitude: '52.6300000000', longitude: '-1.1400000000' },
];

// --- Record bodies (area routes and later neighbourhood sections) -----------------

/** A street-level crime with every upstream field present. */
export const crimeRecord = (overrides: Record<string, unknown> = {}) => ({
  category: 'burglary',
  location_type: 'Force',
  location: {
    latitude: '52.630000',
    longitude: '-1.130000',
    street: { id: 1_000_001, name: 'On or near Example Street' },
  },
  context: '',
  outcome_status: { category: 'Under investigation', date: LATEST_MONTH },
  persistent_id: 'a'.repeat(64),
  id: 100_000_001,
  location_subtype: '',
  month: LATEST_MONTH,
  ...overrides,
});

/** A crime with the optional upstream fields gone: no `context`, `outcome_status`, `location_subtype`, `location_type`. */
export const sparseCrimeRecord = (overrides: Record<string, unknown> = {}) => ({
  category: 'anti-social-behaviour',
  location: null,
  persistent_id: '',
  id: 100_000_002,
  month: LATEST_MONTH,
  ...overrides,
});

/** An area outcome: the outcome plus the crime it belongs to. */
export const areaOutcomeRecord = (overrides: Record<string, unknown> = {}) => ({
  category: { code: 'under-investigation', name: 'Under investigation' },
  date: LATEST_MONTH,
  person_id: null,
  crime: crimeRecord(),
  ...overrides,
});

/** A stop-and-search record with every field populated. */
export const stopRecord = (overrides: Record<string, unknown> = {}) => ({
  type: 'Person search',
  involved_person: true,
  datetime: '2026-08-14T21:30:00+00:00',
  gender: 'Male',
  age_range: '25-34',
  self_defined_ethnicity: 'White - English/Welsh/Scottish/Northern Irish/British',
  officer_defined_ethnicity: 'White',
  legislation: 'Misuse of Drugs Act 1971 (section 23)',
  object_of_search: 'Controlled drugs',
  outcome: 'A no further action disposal',
  outcome_object: { id: 'bu-no-further-action', name: 'A no further action disposal' },
  outcome_linked_to_object_of_search: true,
  removal_of_more_than_outer_clothing: false,
  operation: null,
  operation_name: null,
  location: {
    latitude: '52.630000',
    longitude: '-1.130000',
    street: { id: 1_000_001, name: 'On or near Example Street' },
  },
  ...overrides,
});

/** A stop with every categorical `null`, no outcome (`""`), and no location. */
export const sparseStopRecord = (overrides: Record<string, unknown> = {}) => ({
  type: 'Vehicle search',
  involved_person: false,
  datetime: '2026-08-02T03:10:00+00:00',
  gender: null,
  age_range: null,
  self_defined_ethnicity: null,
  officer_defined_ethnicity: null,
  legislation: null,
  object_of_search: null,
  outcome: '',
  outcome_object: { id: '', name: '' },
  outcome_linked_to_object_of_search: null,
  removal_of_more_than_outer_clothing: null,
  operation: null,
  operation_name: null,
  location: null,
  ...overrides,
});

// --- Area route bodies (crimes, outcomes, stops) ------------------------------------

/** A record `location` with a snapped street, in the wire shape (`latitude`/`longitude` are decimal strings). */
export const wireLocation = (
  streetId: number | string = 1_000_001,
  streetName = 'On or near Example Street',
  latitude: string | null = '52.630000',
  longitude: string | null = '-1.130000',
) => ({ latitude, longitude, street: { id: streetId, name: streetName } });

/**
 * `GET /crimes-street/all-crime` for a small area, in upstream (unsorted) order:
 * seven placed crimes across four categories and three snapped streets. One is
 * anti-social behaviour with no outcome and no persistent id, one is a BTP
 * station record, one carries multi-line `context`.
 */
export const crimesBody = () => [
  crimeRecord({
    id: 100_000_031,
    location: wireLocation(1_000_002, 'On or near Example Road', '52.631000', '-1.131000'),
    persistent_id: 'b'.repeat(64),
  }),
  crimeRecord({ id: 100_000_030 }),
  crimeRecord({
    id: 100_000_032,
    outcome_status: { category: 'Unable to prosecute suspect', date: LATEST_MONTH },
    persistent_id: 'c'.repeat(64),
  }),
  crimeRecord({
    id: 100_000_040,
    category: 'violent-crime',
    context: 'Line one\r\nLine two',
    persistent_id: 'd'.repeat(64),
  }),
  sparseCrimeRecord({ id: 100_000_050, location: wireLocation() }),
  sparseCrimeRecord({
    id: 100_000_051,
    location: wireLocation(1_000_003, 'On or near Example Close', '52.632000', '-1.132000'),
  }),
  crimeRecord({
    id: 100_000_060,
    category: 'vehicle-crime',
    location_type: 'BTP',
    location_subtype: 'Railway Station',
    persistent_id: 'e'.repeat(64),
  }),
];

/** `GET /crimes-no-location` — a force's unplaced crimes: `location` is `null` on every record. */
export const unplacedCrimesBody = () => [
  crimeRecord({
    id: 100_000_071,
    location: null,
    location_type: null,
    persistent_id: 'f'.repeat(64),
  }),
  crimeRecord({
    id: 100_000_070,
    location: null,
    location_type: null,
    outcome_status: null,
    persistent_id: '1'.repeat(64),
  }),
  crimeRecord({
    id: 100_000_072,
    category: 'drugs',
    location: null,
    location_type: null,
    persistent_id: '2'.repeat(64),
  }),
];

/** `GET /outcomes-at-location` — three outcomes recorded in one month for crimes of earlier months, in upstream order. */
export const outcomesBody = () => [
  areaOutcomeRecord({
    crime: crimeRecord({ id: 100_000_081, month: '2026-05', outcome_status: null }),
  }),
  areaOutcomeRecord({
    category: { code: 'unable-to-prosecute', name: 'Unable to prosecute suspect' },
    crime: crimeRecord({ id: 100_000_082, month: '2026-07' }),
  }),
  areaOutcomeRecord({ crime: crimeRecord({ id: 100_000_080, month: '2026-07' }) }),
];

/**
 * `GET /stops-street` for a small area, in upstream (unsorted) order: six stops,
 * one placed at a second street, one with every categorical `null` and no
 * location, one with a blank outcome, one with no `type`.
 */
export const stopsBody = () => [
  stopRecord(),
  stopRecord({
    type: 'Vehicle search',
    involved_person: false,
    datetime: '2026-08-10T09:00:00+00:00',
    gender: 'Female',
    age_range: '18-24',
    self_defined_ethnicity: 'Black/African/Caribbean/Black British - African',
    officer_defined_ethnicity: 'Black',
    legislation: 'Police and Criminal Evidence Act 1984 (section 1)',
    object_of_search: 'Stolen goods',
    outcome: 'Arrest',
    outcome_linked_to_object_of_search: false,
    removal_of_more_than_outer_clothing: null,
    operation_name: 'Operation Example',
  }),
  sparseStopRecord(),
  stopRecord({
    type: 'Person and Vehicle search',
    datetime: '2026-08-14T21:30:00+00:00',
    gender: 'Other',
    outcome: '',
    outcome_object: { id: '', name: '' },
    location: wireLocation(1_000_002, 'On or near Example Road', '52.631000', '-1.131000'),
  }),
  stopRecord({
    type: null,
    datetime: '2026-08-20T01:15:00+00:00',
    gender: 'Male',
    age_range: 'over 34',
    self_defined_ethnicity: 'White - English/Welsh/Scottish/Northern Irish/British',
    officer_defined_ethnicity: 'White',
    object_of_search: 'Offensive weapons',
    legislation: 'Criminal Justice and Public Order Act 1994 (section 60)',
    outcome: 'Community resolution',
    location: null,
  }),
  stopRecord({
    datetime: '2026-08-21T12:00:00+00:00',
    gender: 'Male',
    age_range: '10-17',
    outcome: 'A no further action disposal',
  }),
];

/** `n` distinct stops (cycling through a few categorical values), for large-month cases; generated, never checked in. */
export const manyStops = (n: number) =>
  Array.from({ length: n }, (_, i) =>
    stopRecord({
      datetime: `2026-08-${String((i % 28) + 1).padStart(2, '0')}T${String(i % 24).padStart(2, '0')}:00:00+00:00`,
      gender: ['Male', 'Female', 'Other'][i % 3],
      outcome: i % 5 === 0 ? '' : 'A no further action disposal',
      location:
        i % 10 === 0 ? null : wireLocation(1_000_000 + (i % 40), `On or near Street ${i % 40}`),
    }),
  );

/** `n` distinct crimes over `streets` snapped streets and a few categories, for large-area cases. */
export const manyCrimes = (n: number, streets = 25) =>
  Array.from({ length: n }, (_, i) =>
    crimeRecord({
      id: 200_000_000 + i,
      category: ['burglary', 'drugs', 'robbery'][i % 3],
      location: wireLocation(2_000_000 + (i % streets), `On or near Street ${i % streets}`),
      persistent_id: i.toString(16).padStart(64, '0'),
    }),
  );

/** `GET /outcomes-for-crime/{persistent_id}`. */
export const outcomesForCrimeBody = (overrides: Record<string, unknown> = {}) => ({
  crime: crimeRecord(),
  outcomes: [
    {
      category: { code: 'under-investigation', name: 'Under investigation' },
      date: '2026-07',
      person_id: null,
    },
    {
      category: { code: 'unable-to-prosecute', name: 'Unable to prosecute suspect' },
      date: LATEST_MONTH,
      person_id: null,
    },
  ],
  ...overrides,
});

/** `GET /{force}/{id}` — neighbourhood detail; `description` can be absent upstream. */
export const neighbourhoodDetailBody = (overrides: Record<string, unknown> = {}) => ({
  id: 'NX01',
  name: 'Example Central',
  url_force: 'https://www.example-force.police.test/nx01',
  centre: { latitude: '52.635000', longitude: '-1.130000' },
  population: '4200',
  description: '<p>An invented neighbourhood.</p>',
  contact_details: { email: 'nx01@example-force.police.test', telephone: '101' },
  links: [],
  locations: [
    {
      type: 'station',
      name: 'Example Central Station',
      description: null,
      address: '1 Example Street\nExample Town',
      postcode: 'EX1 1AA',
      latitude: '52.635000',
      longitude: '-1.130000',
    },
  ],
  ...overrides,
});

/** `GET /{force}/{id}/people` — invented names; `bio` and `contact_details` are fields the server never reads. */
export const peopleBody = () => [
  { name: 'Example Officer', rank: 'PC 0000', bio: null, contact_details: {} },
  {
    name: 'Sample Sergeant',
    rank: 'Sgt 0000',
    bio: 'Invented biography the server must never read.',
    contact_details: { email: 'nobody@example.test' },
  },
];

/** `GET /{force}/{id}/priorities` — HTML `issue` and `action`, dates without a zone. */
export const prioritiesBody = () => [
  {
    issue: '<p>Anti-social behaviour &amp; fly-tipping.</p>',
    'issue-date': '2026-07-01T00:00:00',
    action: '<ul><li>Patrols</li><li>Community meetings</li></ul>',
    'action-date': '2026-08-01T00:00:00',
  },
];

/** `GET /{force}/{id}/events` — upcoming events only, HTML `description`, `contact_details` the server drops. */
export const eventsBody = () => [
  {
    title: 'Example drop-in session',
    type: 'meeting',
    start_date: '2026-09-15T18:00:00',
    end_date: '2026-09-15T19:00:00',
    description: '<p>Meet your team.</p>',
    address: 'Example Hall, Example Street',
    contact_details: { email: 'events@example.test' },
  },
];

// --- Response builders --------------------------------------------------------------

/** 200 with a JSON body. */
export const jsonOk =
  (body: unknown): Responder =>
  () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

/** 200 with a literal body string (to build bodies the JSON helper cannot, or exact byte sizes). */
export const textOk =
  (body: string, contentType = 'application/json'): Responder =>
  () =>
    new Response(body, { status: 200, headers: { 'content-type': contentType } });

/** 200 `[]` — an empty answer, not an error (future month, point outside coverage, unknown stop `location_id`). */
export const emptyArrayOk: Responder = jsonOk([]);

/** 200 with an HTML page where JSON was expected (an interstitial or proxy page). */
export const htmlOk: Responder = textOk('<html><body>Service busy</body></html>', 'text/html');

/** 404 with an empty body (`text/html`): a date before the window, a malformed `poly`, an unknown `location_id`. */
export const emptyNotFound: Responder = () =>
  new Response(null, { status: 404, headers: { 'content-type': 'text/html' } });

/** 404 `Not Found` as `text/plain`: an unknown force, neighbourhood or `locate-neighbourhood` outside coverage. */
export const plainNotFound: Responder = () =>
  new Response('Not Found', { status: 404, headers: { 'content-type': 'text/plain' } });

/** 400 with the HTML body a too-long request line gets. */
export const htmlBadRequest: Responder = () =>
  new Response('<html><body>Request Line is too large (4100 > 4094)</body></html>', {
    status: 400,
    headers: { 'content-type': 'text/html' },
  });

/** 429, with or without `Retry-After` (delta-seconds). */
export const rateLimited =
  (retryAfter?: string): Responder =>
  () =>
    new Response(null, {
      status: 429,
      ...(retryAfter === undefined ? {} : { headers: { 'retry-after': retryAfter } }),
    });

/** 503 with an empty body and no `Retry-After`: an area data.police.uk refuses as too large, or an outage. */
export const overloaded: Responder = () => new Response(null, { status: 503 });

/** A bare status with an empty body (500, 502, 504 …). */
export const status =
  (code: number): Responder =>
  () =>
    new Response(null, { status: code });

/** A fetch that never answers; rejects with the request's abort reason when its signal fires. */
export const hang: Responder = (request) =>
  new Promise<Response>((_resolve, reject) => {
    const abort = () => reject(request.signal.reason ?? new DOMException('Aborted', 'AbortError'));
    if (request.signal.aborted) abort();
    request.signal.addEventListener('abort', abort, { once: true });
  });

/** A fetch that fails at the network layer. */
export const networkError: Responder = () => {
  throw new TypeError('fetch failed');
};

/** Serves `responders[n]` on the nth call; the last one repeats once the list is spent. */
export function sequence(...responders: Responder[]): Responder {
  let call = 0;
  return (request) => {
    const responder = responders[Math.min(call, responders.length - 1)];
    call += 1;
    if (!responder) throw new Error('sequence() needs at least one responder');
    return responder(request);
  };
}

/** A valid JSON body of exactly `bytes` ASCII bytes: `["xxx…"]`. Generated, never checked in. */
export function sizedJsonBody(bytes: number): string {
  if (bytes < 4) throw new RangeError('A sized JSON body needs at least 4 bytes.');
  return `["${'x'.repeat(bytes - 4)}"]`;
}

/** State of a {@link streamOfBytes} response, readable after the service has dealt with it. */
export interface StreamState {
  cancelled: boolean;
  pulledBytes: number;
}

/**
 * A 200 whose body streams `totalBytes` of `x` in `chunkBytes` chunks and is not
 * valid JSON — the service must stop reading at its ceiling. `state` records how
 * much was pulled and whether the consumer cancelled the stream.
 */
export function streamOfBytes(
  totalBytes: number,
  chunkBytes = 1024 * 1024,
): { respond: Responder; state: StreamState } {
  const state: StreamState = { cancelled: false, pulledBytes: 0 };
  const respond: Responder = () => {
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= totalBytes) {
          controller.close();
          return;
        }
        const size = Math.min(chunkBytes, totalBytes - sent);
        controller.enqueue(new Uint8Array(size).fill(0x78));
        sent += size;
        state.pulledBytes = sent;
      },
      cancel() {
        state.cancelled = true;
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { respond, state };
}

/** A 200 whose body is the given text, delivered as the given byte chunks (to split multi-byte characters). */
export function chunkedOk(chunks: readonly Uint8Array[]): Responder {
  return () => {
    let index = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[index];
        if (chunk === undefined) controller.close();
        else controller.enqueue(chunk);
        index += 1;
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  };
}
