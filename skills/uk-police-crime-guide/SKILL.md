---
name: uk-police-crime-guide
description: Gates and workflows for the ukcrime_* tools (data.police.uk street crime, police outcomes, stop and search, neighbourhood teams). Use before quoting a count, trend or comparison from them, when tracing what happened to crimes on a street, when breaking stop and search down by ethnicity or outcome, or when an area, month or id choice is unclear.
license: Apache-2.0
metadata:
  author: cyanheads
  version: "1.0"
---

## Scope

Reach for it for crime near a place, crime mix and monthly trends, police outcomes, stop and search breakdowns, and who polices an address. Keyless.

Not for: Police Scotland crime, anything before the 36-month window, court verdicts or sentences, exact incident sites, live incidents, or official crime rates. It supplies no population denominators: a neighbourhood's `population` is usually absent.

## Identifiers

| Id | Where it comes from | What takes it |
|:---|:--------------------|:--------------|
| Force id (`cumbria`, `btp`) | `ukcrime_list_reference` forces; `located_force` in a point or location search's area echo (absent when that lookup failed, which the notice says, or when a location returned no records); `ukcrime_find_neighbourhood` | Every `force` input; names such as "Dyfed-Powys Police" also resolve |
| Neighbourhood id (`LOCC2KES`, `NC04`) | `ukcrime_find_neighbourhood` for a point; `located_neighbourhood` in a point or location search's echo; `ukcrime_list_reference` neighbourhoods with a name filter | Area `neighbourhood` on the three searches, and `ukcrime_find_neighbourhood` by id. Case is forgiven when only one id matches |
| `location_id` | `location.location_id` on any crime, outcome or stop record; `top_locations` in crime results | Area `location` on all three searches, for any month in the window |
| `persistent_id` (64 hex characters) | Crime records from `ukcrime_search_crimes`, and the crime inside each `ukcrime_search_outcomes` row | `ukcrime_get_crime_outcomes`. The numeric `id` is rejected. Anti-social behaviour records never carry one, and British Transport Police crimes (location type `BTP`) can lack one too |

## Gates

1. **Read `notice` before using any number.** Coverage lines arrive there, and a gap does not always show as zero: a central Manchester point returns a handful of crimes while the notice says Greater Manchester publishes no crime data. Drop flagged areas from comparisons rather than footnoting them.
2. **Build ranges from the published window, not the calendar.** The latest published month trails today by months. Take `latest_month` from `ukcrime_list_reference` availability (or the `month` any search echoes when month is omitted), then set `month_from` at most 11 months earlier; leave month off and the range ends at the latest month.
3. **A category-narrowed range does not flag empty months.** With a category set, a zero in `by_month` gets no notice, though the force may have skipped that month. Before calling a zero month real, run the same range without the category: only all-crime ranges flag months at zero as possible missing data.
4. **Stop and search totals include unpublished months as zeros.** A range's `total` sums every month, so a force that skipped months reads low. Check `by_month[].force_published` and the notice, and average or trend only the published months. The newest months have the shortest publisher lists, so "has not published" there often means not yet; end the range at a month `ukcrime_list_reference` availability lists for that force.
5. **Crimes have no force-wide search.** `ukcrime_search_crimes` takes no whole-force area (only the force's unplaced crimes); stop and search does. A force-wide crime total takes every one of the force's neighbourhoods plus area `force_unplaced`, month by month (dozens of calls); short of that, say it is out of reach rather than summing a few.
6. **Split a refused area into tiles that do not overlap.** For an area smaller than the one-mile circle, or one too large to answer, search polygons and sum their totals; overlapping rings count the same crime twice.
7. **Outcome names are the latest stage only.** A crime's latest outcome can read "Awaiting court outcome" or "Court result unavailable": the case went to court and the verdict is never published. The "Suspect charged" step before it shows only in the history from `ukcrime_get_crime_outcomes`, so a charge count needs histories.

## Workflows

**Outcomes over time.** `ukcrime_search_outcomes` takes one month per call with no range, so loop the months. Published outcomes keep moving: a recent month's rows lean to "Awaiting court outcome" and an older month's to "Court result unavailable" and other closed names, so compare outcome mixes only between months of similar age (in `ukcrime_search_crimes` the same drift shows as "Under investigation" dominating recent months). A `ukcrime_search_outcomes` row's own `month` can differ from the month searched, and a crime's earlier steps can be missing there, so read one crime's sequence from `ukcrime_get_crime_outcomes`.

**Crimes on one street.** There is no street search. Search a point near the street, collect every `location_id` whose `street_name` matches (several map points can share one name, and `top_locations` lists only the busiest ten, so page the crimes for quieter ones), then search area `location` for each id, with `month_from` for a range. A `street_name` labels an anonymised map point ("On or near Shopping Area"), not where anything happened.

**Stop and search by ethnicity.** Search area `force` (it includes stops the force could not place) over months the force published. Self-defined ethnicity values are full "Group - Subgroup" strings and a filter matches one value exactly, so sum breakdown rows sharing a group prefix instead of filtering for a group, leaving out "Other ethnic group - Not stated", which is a missing answer, not a group; officer-defined ethnicity is already broad (White, Asian, Black, Other). To cross-tab, read a breakdown unfiltered first, copy a value exactly into a filter, and read another field's breakdown; a filter that matches nothing returns zero, and the notice lists up to 12 of the values present for each filtered field (the unfiltered breakdown has them all). Some forces leave whole fields blank, which shows as `(not recorded)`; check its share before quoting an outcome or legislation rate.

**Comparing areas.** Use the same months, category and area shape: two points are equal one-mile circles, while neighbourhoods differ in size and rarely publish population. Run each area as its own range call, apply gates 1, 3 and 4 to each, and bring denominators from census data, not this server.
