/**
 * @fileoverview The name matcher the local name filters share:
 * ukcrime_list_reference's `name_contains` and the searches'
 * `street_name_contains`. Every word of the value must appear somewhere in the
 * name, in any order, part of a word included (`Granby St` finds Granby
 * Street), with case, accents and punctuation ignored. Punctuation in the value
 * splits words (`granby-street`), and an `&` in a name also reads as "and"
 * (`devon and cornwall` finds Devon & Cornwall Police). Street names drop the
 * "On or near" data.police.uk puts before every one, on both sides.
 * @module mcp-server/tools/name-matcher
 */

/** Lower-cased, then decomposed with the combining marks dropped, so `É` reads `e`. */
const fold = (text: string): string => text.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '');

/** Each character that is not a letter, digit or whitespace. */
const PUNCTUATION = /[^\p{L}\p{N}\s]/gu;

/** A value's words: folded, split at whitespace and at punctuation. Empty when it has no letter or digit. */
export function nameWords(value: string): string[] {
  return fold(value).replace(PUNCTUATION, ' ').split(/\s+/).filter(Boolean);
}

/**
 * The text a name's words are looked for in: the name folded with its
 * punctuation deleted (`St. Mary's Ward` reads `st marys ward`), and, when it
 * holds an `&`, a second reading beside it with the `&` as "and". The deleting
 * reading is kept so a value that matched before still does (`att` still finds
 * `AT&T`); a word holds no whitespace, so it can never span the two readings.
 */
function searchText(name: string): string {
  const folded = fold(name);
  const plain = folded.replace(PUNCTUATION, '');
  return folded.includes('&')
    ? `${plain} ${folded.replaceAll('&', ' and ').replace(PUNCTUATION, '')}`
    : plain;
}

const hasEvery = (words: readonly string[], name: string): boolean => {
  const text = searchText(name);
  return words.every((word) => text.includes(word));
};

/** A test for names holding every word of `value`. */
export function nameMatcher(value: string): (name: string) => boolean {
  const words = nameWords(value);
  return (name) => hasEvery(words, name);
}

/** The entries whose `name` holds every word of `value`; every entry when `value` is undefined. */
export function filterByName<T extends { readonly name: string }>(
  entries: readonly T[],
  value: string | undefined,
): readonly T[] {
  if (value === undefined) return entries;
  const matches = nameMatcher(value);
  return entries.filter((entry) => matches(entry.name));
}

/** The words data.police.uk puts before every street name. */
const STREET_PREFIX = ['on', 'or', 'near'] as const;

/** A street value's words without a leading "On or near"; empty when the value holds nothing else. */
export function streetWords(value: string): string[] {
  const words = nameWords(value);
  return STREET_PREFIX.every((word, i) => words[i] === word)
    ? words.slice(STREET_PREFIX.length)
    : words;
}

/** The published prefix, as a whole word at the start of the name. */
const PUBLISHED_PREFIX = /^\s*on\s+or\s+near(?!\S)/iu;

/**
 * A published street name without its leading "On or near"; undefined when
 * nothing is left, as for the bare "On or near " Northern Ireland publishes
 * for some records.
 */
export function streetPart(streetName: string): string | undefined {
  const part = streetName.replace(PUBLISHED_PREFIX, '').trim();
  return part === '' ? undefined : part;
}

/** A test for published street names whose street part holds every word of `value`, "On or near" dropped from both. */
export function streetMatcher(value: string): (streetName: string) => boolean {
  const words = streetWords(value);
  return (streetName) => {
    const part = streetPart(streetName);
    return part !== undefined && hasEvery(words, part);
  };
}
