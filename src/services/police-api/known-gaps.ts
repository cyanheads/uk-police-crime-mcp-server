/**
 * @fileoverview Static per-force coverage facts the API cannot express, read
 * from data.police.uk's changelog (its Known Issues section and its monthly
 * release notes), its About page and its API documentation, and the
 * coverage-notes helper — the only path by which a fact reaches a caller, always
 * with the table's verified date attached. A fact can start at a month
 * (`fromMonth`, for a force that stopped sending a kind of data), and then
 * applies only to searches reaching that month or later. Stop-and-search
 * publication is never recorded here: it is read live from `/crimes-street-dates`.
 *
 * Refresh on every maintenance release: re-read the source pages — the
 * changelog's Known Issues and every monthly release note since the last
 * refresh (their "Crime data not provided" lines), the About page's Q&A and the
 * outcomes API docs — then confirm each entry with a live area query in its
 * force: a month the entry covers and, for a dated entry, the month before its
 * `fromMonth`. The release notes miss refreshes, so a month they list as not
 * provided may since have been published. A force missing a single month gets no
 * entry (the zero-hit notices carry that caveat); one that has sent nothing for
 * every month since some month gets a dated entry. Edit the entries to match and
 * move {@link KNOWN_GAPS_VERIFIED} in the same commit.
 * @module services/police-api/known-gaps
 */

/** Date (YYYY-MM-DD) the whole table was last checked against its sources. */
export const KNOWN_GAPS_VERIFIED = '2026-11-25';

/** Past this age, startup logs a warning that the table needs a refresh. */
export const KNOWN_GAPS_MAX_AGE_DAYS = 180;

/** Which part of a force's data a fact concerns. */
export type KnownGapAspect = 'asb' | 'crime' | 'locations' | 'outcomes';

/** One coverage fact about one force. */
export interface KnownGap {
  readonly aspect: KnownGapAspect;
  /** data.police.uk force id (`btp` for British Transport Police). */
  readonly force: string;
  /** First month (YYYY-MM) the fact holds, and every later month with it; absent when it holds for every month. */
  readonly fromMonth?: string;
  /** The force publishes none of this aspect's data (from `fromMonth` on, when set), so a zero count there is the gap itself, not a measurement. */
  readonly nothingPublished?: true;
  /** The data.police.uk page the fact was read from. */
  readonly source: string;
  /** One sentence, no closing period, naming `fromMonth` when set; the helper appends the dated attribution. */
  readonly text: string;
}

const CHANGELOG_KNOWN_ISSUES = 'https://data.police.uk/changelog/#known-issues';
const CHANGELOG_RELEASE_NOTES = 'https://data.police.uk/changelog/';
const ABOUT_KNOWN_ISSUES = 'https://data.police.uk/about/#qa';
const OUTCOMES_API_DOCS = 'https://data.police.uk/docs/method/outcomes-at-location/';

/** The table. Read it through {@link coverageNotes}, {@link publishesNothing} or {@link forceGaps}, never directly. */
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
    force: 'gloucestershire',
    aspect: 'crime',
    fromMonth: '2026-02',
    text: 'Gloucestershire Constabulary has sent no crime data to data.police.uk since 2026-02, so its crime counts from that month on do not measure crime',
    source: CHANGELOG_RELEASE_NOTES,
    nothingPublished: true,
  },
  {
    force: 'gloucestershire',
    aspect: 'outcomes',
    fromMonth: '2026-02',
    text: 'Gloucestershire Constabulary has sent no outcome data to data.police.uk since 2026-02, so its outcome counts from that month on do not measure police outcomes',
    source: CHANGELOG_RELEASE_NOTES,
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
    // No figure: Known Issues states about 2,000 a month, while `/crimes-no-location` measured 705 (2026-08) and 662 (2026-09); `force_unplaced` gives any month's count.
    text: 'Avon and Somerset Constabulary sends some crimes each month without coordinates, so area searches there undercount its crimes and their outcomes',
    source: CHANGELOG_KNOWN_ISSUES,
  },
  {
    force: 'btp',
    aspect: 'crime',
    fromMonth: '2025-02',
    text: 'British Transport Police has sent no crime data to data.police.uk since 2025-02, so its crime counts from that month on do not measure crime',
    source: CHANGELOG_RELEASE_NOTES,
    nothingPublished: true,
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

const render = (gap: KnownGap): string => `${gap.text} ${ATTRIBUTION}.`;

/**
 * The coverage-notes helper: a force's table facts for some aspects that apply
 * to a search of `months` (YYYY-MM, at least one), each rendered as a sentence
 * ending with the table's verified date. An undated fact always applies; a dated
 * one when any searched month is on or after its `fromMonth`. Empty when none
 * applies.
 */
export function coverageNotes(
  force: string,
  aspects: readonly KnownGapAspect[],
  months: readonly string[],
): string[] {
  return KNOWN_GAPS.filter((gap) => {
    if (gap.force !== force || !aspects.includes(gap.aspect)) return false;
    const from = gap.fromMonth;
    return from === undefined || months.some((month) => month >= from);
  }).map(render);
}

/**
 * True when the table says every one of `forces` publishes none of the aspect's
 * data in every one of `months` (YYYY-MM, at least one), so a zero count over
 * them needs no explanation beyond their coverage notes: a dated fact counts
 * only when every month is on or after its `fromMonth`. False for an empty list,
 * and when any force publishes some in any of the months.
 */
export function publishesNothing(
  forces: readonly string[],
  aspect: KnownGapAspect,
  months: readonly string[],
): boolean {
  return (
    forces.length > 0 &&
    forces.every((force) =>
      KNOWN_GAPS.some((gap) => {
        if (gap.force !== force || gap.aspect !== aspect || gap.nothingPublished !== true) {
          return false;
        }
        const from = gap.fromMonth;
        return from === undefined || months.every((month) => month >= from);
      }),
    )
  );
}

/** Every table fact for a force, whatever the month, as one string (the `gaps` field), or `undefined` when none. */
export function forceGaps(force: string): string | undefined {
  const notes = KNOWN_GAPS.filter((gap) => gap.force === force).map(render);
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
