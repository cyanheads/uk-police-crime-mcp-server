/**
 * @fileoverview Static per-force coverage facts the API cannot express, read
 * from data.police.uk's Known Issues sections and API documentation, and the
 * coverage-notes helper — the only path by which a fact reaches a caller, always
 * with the table's verified date attached. Stop-and-search publication is never
 * recorded here: it is read live from `/crimes-street-dates`.
 *
 * Refresh on every maintenance release: re-read the source pages, edit the
 * entries to match, and move {@link KNOWN_GAPS_VERIFIED} in the same commit.
 * @module services/police-api/known-gaps
 */

/** Date (YYYY-MM-DD) the whole table was last checked against its sources. */
export const KNOWN_GAPS_VERIFIED = '2026-10-01';

/** Past this age, startup logs a warning that the table needs a refresh. */
export const KNOWN_GAPS_MAX_AGE_DAYS = 180;

/** Which part of a force's data a fact concerns. */
export type KnownGapAspect = 'asb' | 'crime' | 'locations' | 'outcomes';

/** One coverage fact about one force. */
export interface KnownGap {
  readonly aspect: KnownGapAspect;
  /** data.police.uk force id (`btp` for British Transport Police). */
  readonly force: string;
  /** The force publishes none of this aspect's data, so a zero count there is the gap itself, not a measurement. */
  readonly nothingPublished?: true;
  /** The data.police.uk page the fact was read from. */
  readonly source: string;
  /** One sentence, no closing period; the helper appends the dated attribution. */
  readonly text: string;
}

const CHANGELOG_KNOWN_ISSUES = 'https://data.police.uk/changelog/#known-issues';
const ABOUT_KNOWN_ISSUES = 'https://data.police.uk/about/#qa';
const OUTCOMES_API_DOCS = 'https://data.police.uk/docs/method/outcomes-at-location/';

/** The table. Read it through {@link coverageNotes} or {@link forceGaps}, never directly. */
export const KNOWN_GAPS: readonly KnownGap[] = [
  {
    force: 'greater-manchester',
    aspect: 'crime',
    text: 'Greater Manchester Police publishes no crime data to data.police.uk, so crime counts there do not measure crime',
    source: CHANGELOG_KNOWN_ISSUES,
    nothingPublished: true,
  },
  {
    force: 'greater-manchester',
    aspect: 'outcomes',
    text: 'Greater Manchester Police publishes no outcome data to data.police.uk, so outcome counts there do not measure police outcomes',
    source: CHANGELOG_KNOWN_ISSUES,
    nothingPublished: true,
  },
  {
    force: 'northern-ireland',
    aspect: 'crime',
    text: "Northern Ireland crimes carry the placeholder outcome 'Under investigation', and their persistent ids do not reliably resolve in ukcrime_get_crime_outcomes",
    source: OUTCOMES_API_DOCS,
  },
  {
    force: 'northern-ireland',
    aspect: 'outcomes',
    text: 'The Police Service of Northern Ireland publishes no outcomes to data.police.uk, so outcome counts there do not measure police outcomes',
    source: OUTCOMES_API_DOCS,
    nothingPublished: true,
  },
  {
    force: 'devon-and-cornwall',
    aspect: 'outcomes',
    text: 'Devon and Cornwall Police outcome data has been unreliable since a records-system change in November 2022',
    source: CHANGELOG_KNOWN_ISSUES,
  },
  {
    force: 'avon-and-somerset',
    aspect: 'locations',
    text: 'Avon and Somerset Constabulary sends about 2,000 crimes a month without coordinates, so area searches there undercount',
    source: CHANGELOG_KNOWN_ISSUES,
  },
  {
    force: 'btp',
    aspect: 'asb',
    text: 'British Transport Police supplies no anti-social behaviour data',
    source: CHANGELOG_KNOWN_ISSUES,
    nothingPublished: true,
  },
  {
    force: 'btp',
    aspect: 'outcomes',
    text: 'British Transport Police publishes no outcome data to data.police.uk',
    source: ABOUT_KNOWN_ISSUES,
    nothingPublished: true,
  },
];

const ATTRIBUTION = `(data.police.uk known issues, verified ${KNOWN_GAPS_VERIFIED})`;

/**
 * The coverage-notes helper: a force's table facts, optionally narrowed to some
 * aspects, each rendered as a sentence ending with the table's verified date.
 * Empty when the table holds nothing for the force.
 */
export function coverageNotes(force: string, aspects?: readonly KnownGapAspect[]): string[] {
  return KNOWN_GAPS.filter(
    (gap) => gap.force === force && (aspects === undefined || aspects.includes(gap.aspect)),
  ).map((gap) => `${gap.text} ${ATTRIBUTION}.`);
}

/** True when the table says the force publishes none of the aspect's data, so a zero count there needs no other explanation. */
export function publishesNothing(force: string, aspect: KnownGapAspect): boolean {
  return KNOWN_GAPS.some(
    (gap) => gap.force === force && gap.aspect === aspect && gap.nothingPublished === true,
  );
}

/** Every table fact for a force as one string (the `gaps` field), or `undefined` when none. */
export function forceGaps(force: string): string | undefined {
  const notes = coverageNotes(force);
  return notes.length > 0 ? notes.join(' ') : undefined;
}

/**
 * The startup warning for a stale table: set once the table is more than
 * {@link KNOWN_GAPS_MAX_AGE_DAYS} days older than `nowMs`, otherwise `undefined`.
 */
export function knownGapsAgeWarning(nowMs: number): string | undefined {
  const ageDays = Math.floor((nowMs - Date.parse(`${KNOWN_GAPS_VERIFIED}T00:00:00Z`)) / 86_400_000);
  if (ageDays <= KNOWN_GAPS_MAX_AGE_DAYS) return;
  return `The known-gaps coverage table was last verified ${ageDays} days ago (${KNOWN_GAPS_VERIFIED}); re-read its data.police.uk source pages and refresh it.`;
}
