/**
 * @fileoverview ukcrime_find_neighbourhood — the police force and neighbourhood
 * policing team for a point, or by force and neighbourhood id: the team's
 * profile, contact channels and stations, and on request its priorities, team
 * members' ranks and names, upcoming events, and boundary polygon. The locate
 * call and the team profile decide the result; the force name, the force detail
 * and the optional sections degrade to a notice when they fail.
 * @module mcp-server/tools/definitions/find-neighbourhood.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { inline, printUrl, quote } from '@/mcp-server/tools/format-helpers.js';
import {
  ATTRIBUTION,
  forceInput,
  latInput,
  lngInput,
  neighbourhoodIdInput,
} from '@/mcp-server/tools/shared-schemas.js';
import { polyParam } from '@/services/police-api/area.js';
import { forceGaps } from '@/services/police-api/known-gaps.js';
import { BTP_FORCE, getPoliceApiService } from '@/services/police-api/police-api-service.js';

const SECTIONS = ['priorities', 'team', 'events', 'boundary'] as const;

type Section = (typeof SECTIONS)[number];

const DEFAULT_INCLUDE: readonly Section[] = ['priorities', 'team', 'events'];

/** Most events listed; `events_total` gives the full count. */
const MAX_EVENTS = 10;

const DATA_NOTE =
  "Team, priorities and events are published by the force and can lag; the boundary is the force's own neighbourhood polygon.";

const OUTSIDE_COVERAGE =
  'This point is outside data.police.uk coverage (England, Wales and Northern Ireland; Scotland only through British Transport Police); check that lat and lng are not swapped.';

/** A blank is unset; a list is cut to one past the section count, then de-duplicated. */
function prepareInclude(value: unknown): unknown {
  if (value === null || (typeof value === 'string' && value.trim() === '')) return;
  if (!Array.isArray(value)) return value;
  return [...new Set(value.slice(0, SECTIONS.length + 1))];
}

/** The lookup the inputs ask for, or why they ask for none or both. */
type Lookup =
  | { readonly kind: 'point'; readonly lat: number; readonly lng: number }
  | { readonly force: string; readonly kind: 'id'; readonly neighbourhoodId: string };

function lookupOf(input: {
  readonly force?: string | undefined;
  readonly lat?: number | undefined;
  readonly lng?: number | undefined;
  readonly neighbourhood_id?: string | undefined;
}):
  | { readonly lookup: Lookup; readonly ok: true }
  | { readonly message: string; readonly ok: false } {
  const { lat, lng, force, neighbourhood_id: neighbourhoodId } = input;
  const point = lat !== undefined || lng !== undefined;
  const byId = force !== undefined || neighbourhoodId !== undefined;
  if (point && byId) {
    return { ok: false, message: 'Send lat and lng, or force and neighbourhood_id — not both.' };
  }
  if (lat !== undefined && lng !== undefined)
    return { ok: true, lookup: { kind: 'point', lat, lng } };
  if (force !== undefined && neighbourhoodId !== undefined) {
    return { ok: true, lookup: { kind: 'id', force, neighbourhoodId } };
  }
  if (point) {
    return {
      ok: false,
      message: `lat and lng go together; ${lat === undefined ? 'lat' : 'lng'} is missing.`,
    };
  }
  if (byId) {
    return {
      ok: false,
      message: `force and neighbourhood_id go together; ${force === undefined ? 'force' : 'neighbourhood_id'} is missing.`,
    };
  }
  return { ok: false, message: 'Send lat and lng, or force and neighbourhood_id.' };
}

/** `a`, `a and b`, `a, b and c`. */
const listParts = (parts: readonly string[]): string =>
  parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;

const MapPointSchema = z.object({
  latitude: z.number().describe('Latitude, WGS84 decimal degrees.'),
  longitude: z.number().describe('Longitude, WGS84 decimal degrees.'),
});

const OutputSchema = z.object({
  found: z
    .boolean()
    .describe('True when data.police.uk holds a neighbourhood team for the point or id.'),
  guidance: z
    .string()
    .optional()
    .describe('Why nothing was found and what to try instead; present when found is false.'),
  located_from: z
    .object({
      lat: z.number().describe('Latitude looked up.'),
      lng: z.number().describe('Longitude looked up.'),
    })
    .optional()
    .describe('The point looked up, for a point lookup.'),
  force: z
    .object({
      id: z.string().describe("Force id the other tools take as force, such as 'leicestershire'."),
      name: z.string().describe('Force name as published.'),
      url: z.string().optional().describe('Force website, when published.'),
      telephone: z.string().optional().describe('Force switchboard number, when published.'),
    })
    .optional()
    .describe('The police force the neighbourhood belongs to.'),
  neighbourhood: z
    .object({
      id: z
        .string()
        .describe(
          "Neighbourhood id; pass it with force as neighbourhood_id to the search tools' area 'neighbourhood'.",
        ),
      name: z.string().describe('Neighbourhood name as published.'),
      url: z.string().optional().describe("The team's page on the force website, when published."),
      centre: MapPointSchema.optional().describe(
        "The neighbourhood's published centre point, when given.",
      ),
      population: z
        .number()
        .optional()
        .describe('Resident population as published; absent when given as 0 or not given.'),
      description: z
        .string()
        .optional()
        .describe('The team or area description, as plain text. Force-written text.'),
      contact: z
        .array(
          z
            .object({
              channel: z
                .string()
                .describe('Channel as published, such as email, telephone, twitter or facebook.'),
              value: z.string().describe('Address, number or account URL as published.'),
            })
            .describe('One team-level contact channel.'),
        )
        .describe('Team-level contact channels; empty when none are published.'),
      links: z
        .array(
          z
            .object({
              title: z.string().describe('Link title as published.'),
              url: z.string().describe('Link URL as published.'),
              description: z.string().optional().describe('Link description, when published.'),
            })
            .describe('One link the force publishes for the team.'),
        )
        .describe('Links the force publishes for the team; empty when none.'),
      stations: z
        .array(
          z
            .object({
              type: z.string().optional().describe('Station or base type, when published.'),
              name: z.string().optional().describe('Station name, when published.'),
              address: z.string().optional().describe('Street address, when published.'),
              postcode: z.string().optional().describe('Postcode, when published.'),
              description: z
                .string()
                .optional()
                .describe('Opening hours or other detail, when published. Force-written text.'),
            })
            .describe('One police station or base the team works from.'),
        )
        .describe('Police stations and bases listed for the team; empty when none.'),
    })
    .optional()
    .describe('The neighbourhood policing team and its public channels.'),
  priorities: z
    .array(
      z
        .object({
          issue: z.string().describe('The priority as plain text. Force-written text.'),
          issue_date: z
            .string()
            .optional()
            .describe('When it was set, YYYY-MM-DDTHH:MM:SS as published (no time zone).'),
          action: z
            .string()
            .optional()
            .describe('Action taken, as plain text, when published. Force-written text.'),
          action_date: z
            .string()
            .optional()
            .describe('When the action was recorded, as published, when given.'),
        })
        .describe('One current neighbourhood priority.'),
    )
    .optional()
    .describe(
      "The team's current priorities; present when include has 'priorities' and they loaded.",
    ),
  team: z
    .array(
      z
        .object({
          rank: z.string().describe('Rank as published; can include a collar number.'),
          name: z.string().describe('Name as published.'),
        })
        .describe('One team member, as the force publishes them for public contact.'),
    )
    .optional()
    .describe("Team members' ranks and names; present when include has 'team' and they loaded."),
  events: z
    .array(
      z
        .object({
          title: z.string().describe('Event title as published.'),
          type: z.string().optional().describe('Event type, such as meeting, when published.'),
          start: z
            .string()
            .optional()
            .describe('Start, YYYY-MM-DDTHH:MM:SS as published (no time zone).'),
          end: z.string().optional().describe('End, as published, when given.'),
          address: z.string().optional().describe('Where it takes place, when published.'),
          description: z
            .string()
            .optional()
            .describe('Event description as plain text, when published. Force-written text.'),
        })
        .describe('One upcoming engagement event.'),
    )
    .optional()
    .describe(
      "Up to 10 upcoming engagement events, soonest first; present when include has 'events' and they loaded.",
    ),
  events_total: z
    .number()
    .optional()
    .describe('Upcoming events published in all; more than shown when over 10.'),
  boundary: z
    .object({
      vertex_count: z.number().describe('Vertices in the polygon as returned.'),
      polygon: z
        .string()
        .describe(
          "The boundary as 'lat,lng:lat,lng:…' at 6 dp — the string form the search tools' polygon input accepts. The ring repeats its first vertex last.",
        ),
    })
    .optional()
    .describe("The neighbourhood boundary; present when include has 'boundary' and it loaded."),
  gaps: z
    .string()
    .optional()
    .describe("The force's known coverage gaps, each ending with the date the table was verified."),
});

export const findNeighbourhoodTool = tool('ukcrime_find_neighbourhood', {
  title: 'Find UK Police Neighbourhood',
  description:
    "Find the police force and neighbourhood policing team for a point, or look one up by force and neighbourhood id. Returns the team's description, contact channels and police stations, its current priorities with the action taken, team members' ranks and names, and upcoming engagement events. include adds the boundary polygon, needed only to split a neighbourhood too large to search into smaller polygons: ukcrime_search_crimes, ukcrime_search_outcomes and ukcrime_search_stops take the neighbourhood directly through area 'neighbourhood'.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    lat: latInput.describe('Latitude, WGS84 decimal degrees, to look up by point (with lng).'),
    lng: lngInput.describe('Longitude, WGS84 decimal degrees, to look up by point (with lat).'),
    force: forceInput.describe(
      "Force id such as 'leicestershire' (ukcrime_list_reference topic 'forces' lists them), to look up by id (with neighbourhood_id); trimmed, lower-cased, spaces and underscores become hyphens.",
    ),
    neighbourhood_id: neighbourhoodIdInput.describe(
      "Neighbourhood id from ukcrime_list_reference topic 'neighbourhoods', to look up by id (with force). Case-sensitive; only trimmed.",
    ),
    include: z
      .preprocess(
        prepareInclude,
        z
          .array(z.enum(SECTIONS).describe('An optional section to load.'))
          .max(SECTIONS.length)
          .optional(),
      )
      .describe(
        "Optional sections to load: 'priorities', 'team', 'events', 'boundary'. Omitted: priorities, team and events. [] loads none of them.",
      ),
  }),
  inputAliases: { latitude: 'lat', longitude: 'lng', lon: 'lng', long: 'lng' },
  output: OutputSchema,
  enrichment: {
    attribution: z
      .string()
      .describe('Open Government Licence attribution for data.police.uk data.'),
    data_note: z
      .string()
      .describe('What these records can and cannot say; read it before drawing conclusions.'),
    notice: z
      .string()
      .optional()
      .describe('Parts that could not be loaded from data.police.uk, and how to retry.'),
  },
  enrichmentTrailer: {
    attribution: { label: 'Attribution' },
    data_note: { label: 'Data note' },
  },
  errors: [
    {
      reason: 'invalid_lookup',
      code: JsonRpcErrorCode.ValidationError,
      when: 'neither or both of lat+lng and force+neighbourhood_id are given, or half of a pair',
      recovery:
        'Send lat and lng to look up by point, or force and neighbourhood_id to look up by id — not both.',
      severity: 'notice',
    },
    {
      reason: 'unknown_force',
      code: JsonRpcErrorCode.ValidationError,
      when: "force is not in the force list, or is 'btp' (British Transport Police has no neighbourhoods)",
      recovery:
        "Call ukcrime_list_reference with topic 'forces' for valid force ids such as 'leicestershire'.",
      severity: 'notice',
    },
  ],

  async handler(input, ctx) {
    ctx.enrich({ attribution: ATTRIBUTION, data_note: DATA_NOTE });
    const parsed = lookupOf(input);
    if (!parsed.ok) throw ctx.fail('invalid_lookup', parsed.message);
    const { lookup } = parsed;
    const include = new Set(input.include ?? DEFAULT_INCLUDE);

    const service = getPoliceApiService();
    const budget = service.openBudget();
    const locatedFrom =
      lookup.kind === 'point' ? { located_from: { lat: lookup.lat, lng: lookup.lng } } : {};

    let forceId: string;
    let neighbourhoodId: string;
    if (lookup.kind === 'point') {
      const located = await service.locate(lookup.lat, lookup.lng, ctx, budget);
      if (located.kind === 'miss')
        return { found: false, guidance: OUTSIDE_COVERAGE, ...locatedFrom };
      forceId = located.value.force;
      neighbourhoodId = located.value.neighbourhood;
    } else {
      const known = await service.findForce(lookup.force, ctx, budget, { allowBtp: false });
      if (!known) {
        throw ctx.fail(
          'unknown_force',
          lookup.force === BTP_FORCE.id
            ? 'British Transport Police has no neighbourhoods.'
            : `No police force '${lookup.force}'.`,
        );
      }
      forceId = known.id;
      neighbourhoodId = lookup.neighbourhoodId;
    }

    // The profile decides the result; the force name, force detail and sections degrade.
    const optional = Promise.allSettled([
      service.findForce(forceId, ctx, budget, { allowBtp: false }),
      service.getForceDetail(forceId, ctx, budget),
      include.has('priorities')
        ? service.getPriorities(forceId, neighbourhoodId, ctx, budget)
        : undefined,
      include.has('team') ? service.getTeam(forceId, neighbourhoodId, ctx, budget) : undefined,
      include.has('events') ? service.getEvents(forceId, neighbourhoodId, ctx, budget) : undefined,
      include.has('boundary')
        ? service.getBoundary(forceId, neighbourhoodId, ctx, budget)
        : undefined,
    ]);
    const [detail, settled] = await Promise.all([
      service.getNeighbourhood(forceId, neighbourhoodId, ctx, budget),
      optional,
    ]);
    ctx.signal.throwIfAborted();

    if (detail.kind === 'miss') {
      return {
        found: false,
        guidance: `No neighbourhood '${neighbourhoodId}' in force '${forceId}'. Ids are case-sensitive; call ukcrime_list_reference with topic 'neighbourhoods' and force '${forceId}' to find it by name.`,
        ...locatedFrom,
      };
    }

    const failedParts: string[] = [];
    const loaded = <T>(result: PromiseSettledResult<T>, part: string): T | undefined => {
      if (result.status === 'fulfilled') return result.value;
      failedParts.push(part);
      ctx.log.warning('Could not load part of a neighbourhood', {
        part,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
      return;
    };
    const [listedResult, forceResult, prioritiesResult, teamResult, eventsResult, boundaryResult] =
      settled;
    const forceDetail = loaded(forceResult, 'force details');
    const forceInfo = forceDetail?.kind === 'found' ? forceDetail.value : undefined;
    const listed = listedResult.status === 'fulfilled' ? listedResult.value : undefined;
    if (listedResult.status === 'rejected') {
      ctx.log.warning('Could not load the force list; naming the force from its detail', {
        error:
          listedResult.reason instanceof Error
            ? listedResult.reason.message
            : String(listedResult.reason),
      });
      // Named by its bare id only when the detail gave no name either.
      if (!forceInfo && forceResult.status === 'fulfilled') failedParts.push('force details');
    }
    const priorities = loaded(prioritiesResult, 'priorities');
    const team = loaded(teamResult, 'team');
    const events = loaded(eventsResult, 'events');
    const boundaryLookup = loaded(boundaryResult, 'boundary');
    // A found neighbourhood with no boundary is a load failure, not an empty polygon.
    if (boundaryLookup?.kind === 'miss') failedParts.push('boundary');
    const boundary = boundaryLookup?.kind === 'found' ? boundaryLookup.value : undefined;
    if (failedParts.length > 0) {
      ctx.enrich.notice(
        `Could not load ${listParts(failedParts)} from data.police.uk; call ukcrime_find_neighbourhood again to retry.`,
      );
    }

    const neighbourhood = detail.value;
    const gaps = forceGaps(forceId);
    return {
      found: true,
      ...locatedFrom,
      force: {
        id: forceId,
        name: listed?.name ?? forceInfo?.name ?? forceId,
        ...(forceInfo?.url ? { url: forceInfo.url } : {}),
        ...(forceInfo?.telephone ? { telephone: forceInfo.telephone } : {}),
      },
      neighbourhood: {
        ...neighbourhood,
        contact: [...neighbourhood.contact],
        links: [...neighbourhood.links],
        stations: [...neighbourhood.stations],
      },
      ...(priorities ? { priorities: [...priorities] } : {}),
      ...(team ? { team: [...team] } : {}),
      ...(events ? { events: events.slice(0, MAX_EVENTS), events_total: events.length } : {}),
      ...(boundary
        ? { boundary: { vertex_count: boundary.length, polygon: polyParam(boundary) } }
        : {}),
      ...(gaps ? { gaps } : {}),
    };
  },

  format: (result) => {
    const lines: string[] = [];
    const { force, neighbourhood } = result;
    lines.push(
      neighbourhood && force
        ? `## ${inline(neighbourhood.name)} — ${inline(force.name)}`
        : '## Neighbourhood not found',
    );
    lines.push('', `**Found:** ${result.found ? 'yes' : 'no'}`);
    if (result.located_from) {
      lines.push(
        `**Looked up from:** lat ${result.located_from.lat}, lng ${result.located_from.lng}`,
      );
    }
    if (result.guidance) lines.push(`**Guidance:** ${inline(result.guidance)}`);

    if (force) {
      const parts = [`**Force:** ${inline(force.name)} (${inline(force.id)})`];
      if (force.url) parts.push(`website ${printUrl(force.url)}`);
      if (force.telephone) parts.push(`telephone ${inline(force.telephone)}`);
      lines.push(parts.join(' · '));
    }

    if (neighbourhood) {
      const parts = [`**Neighbourhood id:** ${inline(neighbourhood.id)}`];
      if (neighbourhood.url) parts.push(`team page ${printUrl(neighbourhood.url)}`);
      if (neighbourhood.population !== undefined)
        parts.push(`population ${neighbourhood.population}`);
      if (neighbourhood.centre) {
        parts.push(
          `published centre ${neighbourhood.centre.latitude}, ${neighbourhood.centre.longitude}`,
        );
      }
      lines.push(parts.join(' · '));
      if (neighbourhood.description) lines.push('', quote(neighbourhood.description));

      lines.push('', '### Contact');
      if (neighbourhood.contact.length === 0) lines.push('', '_None published._');
      else lines.push('');
      for (const { channel, value } of neighbourhood.contact) {
        const shown = /^https?:\/\//i.test(value) ? printUrl(value) : inline(value);
        lines.push(`- ${inline(channel)}: ${shown}`);
      }

      lines.push('', '### Links');
      if (neighbourhood.links.length === 0) lines.push('', '_None published._');
      else lines.push('');
      for (const link of neighbourhood.links) {
        const about = link.description ? ` — ${inline(link.description)}` : '';
        lines.push(`- ${inline(link.title)}: ${printUrl(link.url)}${about}`);
      }

      lines.push('', '### Police stations');
      if (neighbourhood.stations.length === 0) lines.push('', '_None published._');
      else lines.push('');
      for (const station of neighbourhood.stations) {
        const parts = [station.name, station.type, station.address, station.postcode]
          .filter((part): part is string => part !== undefined)
          .map(inline);
        lines.push(`- ${parts.length > 0 ? parts.join(' · ') : 'Station'}`);
        if (station.description) {
          lines.push(
            ...quote(station.description)
              .split('\n')
              .map((line) => `  ${line}`),
          );
        }
      }
    }

    if (result.priorities) {
      lines.push('', `### Priorities (${result.priorities.length})`);
      if (result.priorities.length === 0) lines.push('', '_None published._');
      for (const priority of result.priorities) {
        lines.push(
          '',
          `**Issue**${priority.issue_date ? ` (set ${inline(priority.issue_date)})` : ''}:`,
        );
        lines.push(quote(priority.issue));
        if (priority.action) {
          lines.push(
            `**Action taken**${priority.action_date ? ` (${inline(priority.action_date)})` : ''}:`,
            quote(priority.action),
          );
        } else if (priority.action_date) {
          lines.push(`**Action recorded:** ${inline(priority.action_date)}`);
        }
      }
    }

    if (result.team) {
      lines.push('', `### Team (${result.team.length})`);
      if (result.team.length === 0) lines.push('', '_None published._');
      else lines.push('');
      for (const member of result.team) {
        lines.push(`- ${inline(member.rank)} — ${inline(member.name)}`);
      }
    }

    if (result.events) {
      const total = result.events_total ?? result.events.length;
      lines.push('', `### Upcoming events (${result.events.length} of ${total})`);
      if (result.events.length === 0) lines.push('', '_None published._');
      else lines.push('');
      for (const event of result.events) {
        const parts = [`**${inline(event.title)}**`];
        if (event.type) parts.push(inline(event.type));
        if (event.start) parts.push(`starts ${inline(event.start)}`);
        if (event.end) parts.push(`ends ${inline(event.end)}`);
        if (event.address) parts.push(inline(event.address));
        lines.push(`- ${parts.join(' · ')}`);
        if (event.description) {
          lines.push(
            ...quote(event.description)
              .split('\n')
              .map((line) => `  ${line}`),
          );
        }
      }
    }

    if (result.boundary) {
      lines.push(
        '',
        `### Boundary (${result.boundary.vertex_count} vertices)`,
        '',
        '```text',
        result.boundary.polygon,
        '```',
      );
    }

    if (result.gaps) lines.push('', `**Known coverage gaps:** ${inline(result.gaps)}`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
