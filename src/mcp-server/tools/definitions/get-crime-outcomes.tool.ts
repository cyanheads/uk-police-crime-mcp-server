/**
 * @fileoverview ukcrime_get_crime_outcomes — the full police outcome history of
 * up to 25 crimes by persistent_id, one paced upstream lookup per id, four at a
 * time. Misses and per-id upstream failures are results; only an all-ids
 * failure fails the call, with server-written text.
 * @module mcp-server/tools/definitions/get-crime-outcomes.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { inline, quote } from '@/mcp-server/tools/format-helpers.js';
import { LocationSchema, renderLocation } from '@/mcp-server/tools/search-output.js';
import { ATTRIBUTION } from '@/mcp-server/tools/shared-schemas.js';
import { getPoliceApiService } from '@/services/police-api/police-api-service.js';
import type { CrimeHistory, Lookup } from '@/services/police-api/types.js';

const MAX_IDS = 25;
/** Lookups one call keeps queued or in flight, so it never holds more than this many of the shared pacer's entries. */
const LOOKUPS_IN_FLIGHT = 4;

const DATA_NOTE =
  'Police outcomes only — court results are not published. Locations are anonymised map points, not crime sites. A crime returned here is the record data.police.uk holds for the id; for Northern Ireland ids it can differ from the record that carried the id, so compare category and month.';

/**
 * Accepts one string or a list: every string is split on commas and
 * whitespace, lower-cased (upstream ids are lower-case hex, and an upper-cased
 * id 404s), blanks and repeats dropped in first-seen order, and the list cut to
 * max + 1 so an over-long list yields one issue. Non-string items pass through
 * for the schema to reject.
 */
function preparePersistentIds(value: unknown): unknown {
  const items = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(items)) return value;
  const seen = new Set<string>();
  const ids: unknown[] = [];
  for (const item of items) {
    if (ids.length > MAX_IDS) break;
    if (typeof item !== 'string') {
      ids.push(item);
      continue;
    }
    for (const part of item.split(/[\s,]+/)) {
      const id = part.toLowerCase();
      if (id === '' || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
  }
  return ids.slice(0, MAX_IDS + 1);
}

/** Server-written failure text for the service's `ServiceUnavailable` reasons. */
const UNAVAILABLE_BY_REASON: ReadonlyMap<string, string> = new Map([
  ['response_too_large', 'data.police.uk sent a response too large to read.'],
  ['unreadable_response', 'data.police.uk answered with a body that is not JSON.'],
  ['unexpected_response', 'data.police.uk answered in an unexpected shape.'],
  [
    'unexpected_redirect',
    'data.police.uk answered with a redirect, which this server does not follow.',
  ],
]);

/**
 * Why one lookup failed, written from the error's code, `reason`, HTTP status
 * and `retryAfter` alone, so no upstream status text or internal message
 * reaches `failed[].error`.
 */
function lookupFailure(error: unknown): string {
  if (!(error instanceof McpError)) return 'The lookup failed unexpectedly.';
  const { reason, retryAfter, status } = error.data ?? {};
  const http = typeof status === 'number' ? ` (HTTP ${status})` : '';
  const wait = Number(retryAfter);
  const retry = /^\d+$/.test(String(retryAfter)) && wait > 0 ? ` Retry after ${wait} s.` : '';
  switch (error.code) {
    case JsonRpcErrorCode.RateLimited:
      return reason === 'pacer_shed'
        ? `Too many requests to data.police.uk were queued.${retry}`
        : `data.police.uk rate-limited the lookup.${retry}`;
    case JsonRpcErrorCode.Timeout:
      return reason === 'call_budget_exhausted'
        ? 'The call ran out of time before this lookup was sent.'
        : 'data.police.uk did not answer in time.';
    case JsonRpcErrorCode.ServiceUnavailable:
      return (
        (typeof reason === 'string' ? UNAVAILABLE_BY_REASON.get(reason) : undefined) ??
        `data.police.uk is not answering${http}.`
      );
    default:
      return `data.police.uk refused the lookup${http}.`;
  }
}

/**
 * The call's failure when every lookup failed: the first failure's code,
 * `reason`, `retryable` and `retryAfter`, with {@link lookupFailure}'s text as
 * the message. The original rides as `cause`, which only the server's own log
 * reads.
 */
function allFailed(error: unknown): McpError {
  const message = lookupFailure(error);
  if (!(error instanceof McpError)) {
    return new McpError(JsonRpcErrorCode.InternalError, message, undefined, { cause: error });
  }
  const { reason, retryable, retryAfter } = error.data ?? {};
  return new McpError(
    error.code,
    message,
    {
      ...(reason === undefined ? {} : { reason }),
      ...(retryable === undefined ? {} : { retryable }),
      ...(retryAfter === undefined ? {} : { retryAfter }),
    },
    { cause: error },
  );
}

const OutputSchema = z.object({
  crimes: z
    .array(
      z
        .object({
          persistent_id: z.string().describe('The persistent id this record was fetched by.'),
          id: z.string().describe('data.police.uk crime id.'),
          category: z.string().describe('Category slug.'),
          month: z.string().describe('Month recorded, YYYY-MM.'),
          location: LocationSchema.optional().describe('Absent when the crime has no location.'),
          context: z.string().optional().describe('Force-written extra detail, when any.'),
          history_available: z
            .boolean()
            .describe(
              'False when data.police.uk publishes no outcome history for this crime (seen on Northern Ireland records); outcomes is then empty.',
            ),
          outcomes: z
            .array(
              z
                .object({
                  code: z.string().describe('Outcome code, such as under-investigation.'),
                  name: z.string().describe('Outcome as published.'),
                  month: z.string().describe('Month recorded, YYYY-MM.'),
                })
                .describe('One police outcome.'),
            )
            .describe('Every police outcome recorded for the crime, oldest first.'),
        })
        .describe('One crime and its outcome history.'),
    )
    .describe('The crimes found, in the order their ids were given.'),
  not_found: z
    .array(z.string().describe('A persistent id.'))
    .describe('Ids data.police.uk holds no crime for.'),
  failed: z
    .array(
      z
        .object({
          persistent_id: z.string().describe('The persistent id.'),
          error: z.string().describe('Why the lookup failed upstream.'),
        })
        .describe('One failed lookup.'),
    )
    .describe(
      'Ids whose lookup still failed after retries for a reason other than a missing crime (outage, timeout, rate limit). Empty when none.',
    ),
  guidance: z
    .string()
    .optional()
    .describe('What to do about ids in not_found or failed; absent when every id resolved.'),
});

type CrimeOutcomesOutput = z.infer<typeof OutputSchema>;

/** One id's lookup: its answer, or why it failed. */
type LookupResult =
  | { readonly id: string; readonly lookup: Lookup<CrimeHistory> }
  | { readonly id: string; readonly error: unknown };

export const getCrimeOutcomesTool = tool('ukcrime_get_crime_outcomes', {
  title: 'Get UK Crime Outcome Histories',
  description:
    'Fetch the full police outcome history of up to 25 crimes by persistent_id — the 64-character id on crimes from ukcrime_search_crimes and ukcrime_search_outcomes. Returns each crime with every outcome, oldest first, and lists the ids data.police.uk does not hold. Anti-social behaviour records carry no persistent id.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    persistent_ids: z
      .preprocess(
        preparePersistentIds,
        z
          .array(
            z
              .string()
              .regex(
                /^[0-9a-f]{64}$/,
                "Expected the 64-character hexadecimal persistent_id from a crime record, not the record's numeric id.",
              )
              .describe('A 64-character hexadecimal persistent id.'),
          )
          .min(1)
          .max(MAX_IDS),
      )
      .describe(
        '1–25 persistent ids from the persistent_id field of ukcrime_search_crimes or ukcrime_search_outcomes results. A comma- or space-separated string is also accepted; ids are lower-cased and repeats dropped.',
      ),
  }),
  inputAliases: { persistent_id: 'persistent_ids' },
  output: OutputSchema,
  enrichment: {
    attribution: z.string().describe('Open Government Licence attribution.'),
    data_note: z.string().describe('What these records can and cannot say; read it first.'),
  },
  enrichmentTrailer: {
    attribution: { label: 'Attribution' },
    data_note: { label: 'Data note' },
  },

  async handler(input, ctx) {
    ctx.enrich({ attribution: ATTRIBUTION, data_note: DATA_NOTE });
    const service = getPoliceApiService();
    const budget = service.openBudget();
    // Per-id isolation: one failed lookup must not discard the others. Four
    // workers share one iterator and write each result at its id's index.
    const pending = input.persistent_ids.entries();
    const results: LookupResult[] = [];
    const worker = async () => {
      for (const [index, id] of pending) {
        results[index] = await service.getCrimeHistory(id, ctx, budget).then(
          (lookup) => ({ id, lookup }),
          (error: unknown) => ({ id, error }),
        );
      }
    };
    await Promise.all(Array.from({ length: LOOKUPS_IN_FLIGHT }, worker));
    ctx.signal.throwIfAborted();

    const crimes: CrimeOutcomesOutput['crimes'] = [];
    const notFound: string[] = [];
    const failed: CrimeOutcomesOutput['failed'] = [];
    const failures: unknown[] = [];
    for (const result of results) {
      if ('error' in result) {
        failures.push(result.error);
        failed.push({ persistent_id: result.id, error: lookupFailure(result.error) });
      } else if (result.lookup.kind === 'miss') {
        notFound.push(result.id);
      } else {
        const { crime, outcomes } = result.lookup.value;
        crimes.push({
          persistent_id: result.id,
          id: crime.id,
          category: crime.category,
          month: crime.month,
          ...(crime.location ? { location: crime.location } : {}),
          ...(crime.context ? { context: crime.context } : {}),
          history_available: outcomes !== null,
          outcomes: outcomes ? [...outcomes] : [],
        });
      }
    }
    // Every lookup failing reads as an outage, not as an empty success.
    if (failures.length === results.length) throw allFailed(failures[0]);
    if (failures.length > 0) {
      ctx.log.warning('Some crime outcome lookups failed upstream', {
        failed: failures.length,
        requested: results.length,
      });
    }

    const guidance: string[] = [];
    if (notFound.length > 0) {
      guidance.push(
        `data.police.uk holds no crime for ${notFound.length} of these ids. Take persistent ids from the persistent_id field of ukcrime_search_crimes or ukcrime_search_outcomes results; anti-social behaviour records carry none.`,
      );
    }
    if (failed.length > 0) {
      guidance.push(
        `${failed.length} lookups failed upstream; call ukcrime_get_crime_outcomes again with just those ids.`,
      );
    }
    return {
      crimes,
      not_found: notFound,
      failed,
      ...(guidance.length > 0 ? { guidance: guidance.join(' ') } : {}),
    };
  },

  format: (result) => {
    const lines = [
      `## Crime outcome histories — ${result.crimes.length} found, ${result.not_found.length} not found, ${result.failed.length} failed`,
    ];
    for (const crime of result.crimes) {
      lines.push(
        '',
        `### ${inline(crime.category)} · ${inline(crime.month)}`,
        `**persistent_id:** ${inline(crime.persistent_id)} · **id:** ${inline(crime.id)}`,
      );
      if (crime.location) lines.push(`**Location:** ${renderLocation(crime.location)}`);
      if (crime.context) lines.push('**Context:**', quote(crime.context), '');
      if (!crime.history_available) {
        lines.push('**Outcome history:** not published by data.police.uk for this crime.');
      } else if (crime.outcomes.length === 0) {
        lines.push('**Outcome history:** none recorded.');
      } else {
        lines.push('**Outcome history:**');
        for (const outcome of crime.outcomes) {
          lines.push(
            `- ${inline(outcome.month)} · ${inline(outcome.name)} (${inline(outcome.code)})`,
          );
        }
      }
    }
    if (result.not_found.length > 0) {
      lines.push('', '### Not found', '', ...result.not_found.map((id) => `- ${inline(id)}`));
    }
    if (result.failed.length > 0) {
      lines.push(
        '',
        '### Failed lookups',
        '',
        ...result.failed.map((entry) => `- ${inline(entry.persistent_id)}: ${inline(entry.error)}`),
      );
    }
    if (result.guidance) lines.push('', `**Guidance:** ${inline(result.guidance)}`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
