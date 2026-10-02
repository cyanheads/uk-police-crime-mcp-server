<div align="center">
  <h1>@cyanheads/uk-police-crime-mcp-server</h1>
  <p><b>Search UK street-level crime, police outcomes, stop and search, and neighbourhood teams from data.police.uk: England, Wales and Northern Ireland forces, plus British Transport Police (Scotland's only coverage), via MCP. STDIO or Streamable HTTP.</b>
  <div>6 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.1-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/uk-police-crime-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.1.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/uk-police-crime-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/uk-police-crime-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.2-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/uk-police-crime-mcp-server/releases/latest/download/uk-police-crime-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=uk-police-crime-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvdWstcG9saWNlLWNyaW1lLW1jcC1zZXJ2ZXIiXX0=) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22uk-police-crime-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fuk-police-crime-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://uk-police-crime.caseyjhand.com/mcp](https://uk-police-crime.caseyjhand.com/mcp)

</div>

---

## Overview

Monthly street-level crime, police outcomes, and stop and search records from [data.police.uk](https://data.police.uk/), plus the neighbourhood policing teams behind them. Covers the 43 territorial forces of England and Wales, the Police Service of Northern Ireland, and British Transport Police, whose station records are the only coverage of Scotland. Search by point, polygon, map point, neighbourhood, or whole force; follow a crime's outcome history; find who polices a place. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:---|:---|
| `ukcrime_list_reference` | Decode force ids, crime categories, a force's neighbourhood ids, and which months and forces are published |
| `ukcrime_search_crimes` | Search the street-level crimes recorded in one month, or a range of up to 12, inside an area, with counts by category and latest outcome |
| `ukcrime_search_outcomes` | List the police outcomes recorded in one month inside an area, for crimes from that month or earlier |
| `ukcrime_get_crime_outcomes` | Fetch the full outcome history of up to 25 crimes by `persistent_id` |
| `ukcrime_search_stops` | Search stop and search records for one month, or a range of up to 12, inside an area or across a whole force, with breakdowns and filters |
| `ukcrime_find_neighbourhood` | Find the force and neighbourhood policing team for a point, or look one up by id |

## Capability reference

### `ukcrime_list_reference` <sub>tool</sub>

- `topic`: `forces`, `categories`, `availability`, or `neighbourhoods` (needs `force`); `name_contains` filters forces and neighbourhoods by name, and `month` narrows `availability` to one row
- `availability` returns `latest_month`, `earliest_month`, and which forces published stop and search each month; with `force`, the months that force did and did not publish
- `forces` includes British Transport Police (`btp`) and each force's known coverage `gaps`; typed errors: `force_required`, `unknown_force`, `invalid_filter`

---

### `ukcrime_search_crimes` <sub>tool</sub>

- `area`: `point` (`lat`, `lng`; a 1-mile radius), `polygon` (3–2,500 vertices), `location` (`location_id`), `neighbourhood` (`force` + `neighbourhood_id`), or `force_unplaced` (`force`: the crimes it could not place); optional `month` (default: latest published), `month_from` (a range of up to 12 months ending at `month`), and `category` (default: every category)
- Returns `total`, `by_category`, `by_outcome`, up to 10 `top_locations`, and a page of `crimes` with the `persistent_id` that `ukcrime_get_crime_outcomes` takes; `limit` defaults to 25 (max 200), `next_offset` continues
- With `month_from`, the totals, breakdowns and `top_locations` cover the range, `by_month` gives each month's total, and rows page across it, oldest month first
- Failures carry a typed `reason`, such as `month_not_published`, `unknown_category`, or `area_too_large`; a range that cannot be fetched whole in one call fails `range_incomplete` (call again: fetched months stay cached) or `range_too_large`

---

### `ukcrime_search_outcomes` <sub>tool</sub>

- Same areas as `ukcrime_search_crimes` except `force_unplaced`; `month` is when the outcome was recorded, and `category` counts only outcomes for crimes in that category
- Returns `total`, `unfiltered_total`, `by_outcome` (code, name, count), `by_crime_month`, and a page of `outcomes`, each with its crime; `limit` defaults to 20 (max 200)
- Police outcomes only: court results are not published, and the result says when a force publishes no outcomes

---

### `ukcrime_get_crime_outcomes` <sub>tool</sub>

- `persistent_ids`: 1–25 64-character ids from `ukcrime_search_crimes` or `ukcrime_search_outcomes`; anti-social behaviour records carry none
- Each crime comes back with every outcome, oldest first; `history_available: false` marks a crime with no published history
- Unknown ids land in `not_found` and failed lookups in `failed`, so one bad id never fails the batch

---

### `ukcrime_search_stops` <sub>tool</sub>

- `area`: `point`, `polygon`, `location`, `neighbourhood`, or `force` (every stop the force published, placed or not); optional `month` and `month_from`, as on `ukcrime_search_crimes`; up to 8 `filters` on `type`, `self_defined_ethnicity`, `officer_defined_ethnicity`, `outcome`, `object_of_search`, `legislation`, `age_range`, `gender`, `outcome_linked_to_object_of_search`, or `removal_of_more_than_outer_clothing` (the last two take `'true'`, `'false'` or `'(not recorded)'`; a JSON boolean also works)
- Returns `total`, `unfiltered_total`, `unplaced`, `force_published` (whether every force found for the area — the one it names, or those located at a point, a polygon's centre and outermost vertices, or a location's map point — published stop and search that month, or every month of a range), a breakdown per filterable field, and a page of `stops`; `limit` defaults to 15 (max 200)
- With `month_from`, `by_month` gives each month's total and its own `force_published`, so a month a force skipped reads as a gap, not a drop; the notice lists the months each force skipped
- Filters narrow breakdowns and page together, in every month of a range: filter one field and read another's breakdown for a cross-tab

---

### `ukcrime_find_neighbourhood` <sub>tool</sub>

- Look up by `lat` + `lng` or by `force` + `neighbourhood_id`; `include` picks `priorities`, `team`, `events` (the default three) and `boundary`
- Returns the force, the team's description, contact channels and stations, current priorities, every upcoming event the force published (soonest first), and the boundary as a polygon string the search tools accept
- Team entries carry only rank and name; biographies and personal contact details are not returned. A point outside coverage returns `found: false` with `guidance`

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

data.police.uk-specific:

- Every location is an anonymised map point covering at least eight addresses, never the place a crime or stop happened; outputs label it that way
- Validates locally what the upstream would silently widen: unknown categories, months outside the window, forces matching no id or name (`Leicestershire Police` works as well as `leicestershire`), and area fields the chosen area does not use
- Omitting `month` searches the latest published month and echoes it; per-force coverage gaps are dated and named in each result's `notice`
- A 12-month trend of crimes or stop and search is one call for most areas: `month_from` fetches the months two at a time and caches each for 15 minutes, so paging and a repeat send no area request; a large area that runs short of time fails `range_incomplete`, and the repeat fetches only the months still missing
- Requests are paced process-wide under data.police.uk's rate limit, with retries and in-process caches

Agent-friendly output:

- Every response carries the Open Government Licence attribution; all tools except `ukcrime_list_reference` add a `data_note` on what the records can and cannot say
- Totals and breakdowns cover every matched record; `limit` / `offset` / `next_offset` page the rows
- Typed failure reasons with a recovery hint, and a `notice` that separates "no data published" from "nothing happened"

## Known limitations

- Only the latest 36 months are served; longer trends need the bulk archive at data.police.uk, which this server does not read
- A range covers at most 12 months, and `ukcrime_search_outcomes` takes one month at a time: an outcomes month not recently asked for can take data.police.uk 10–53 s to answer
- Greater Manchester Police publishes no crime, outcome or stop and search data; searches there return only other forces' or British Transport Police records
- Northern Ireland has no outcomes and no stop and search, and every crime other than anti-social behaviour carries the placeholder outcome `Under investigation`
- Court outcomes from June 2019 onward are not published
- data.police.uk can refuse an area holding more than about 10,000 records, whatever the category, and the point radius is fixed at one mile; dense city centres need polygons smaller than a borough
- The API reports which forces published stop and search each month, but not which supplied crime data, so a force that skipped a month shows as a thin or empty area; a low or zero count can mean missing data
- Many stops carry a blank outcome, reported as `(not recorded)`; stop `datetime` is UTC while months follow UK local time

## Getting started

### Public Hosted Instance

A public instance is available at `https://uk-police-crime.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "uk-police-crime-mcp-server": {
      "type": "streamable-http",
      "url": "https://uk-police-crime.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

Add the following to your MCP client configuration file.

```json
{
  "mcpServers": {
    "uk-police-crime-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/uk-police-crime-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "uk-police-crime-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/uk-police-crime-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "uk-police-crime-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "ghcr.io/cyanheads/uk-police-crime-mcp-server:latest"]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- No API key: data.police.uk is open and keyless.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/uk-police-crime-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd uk-police-crime-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

## Configuration

The server reads no environment variables of its own. It paces requests process-wide under data.police.uk's limit of 15 per second (burst 30); calls queue for their turn. When data.police.uk rate-limits the server, a `Retry-After` that leaves the call time for another attempt is waited out there; a longer one, or a rate limit that outlasts the retries, fails the call as `rate_limited`, naming the wait. A busy queue in this server fails as `pacer_shed`, an outage as `upstream_unavailable`, and a call that runs out of time as `retry_deadline_exceeded`; all four are retryable, and the hint names the wait when one is known.

| Variable | Description | Default |
|:---|:---|:---|
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_SESSION_MODE` | HTTP session mode: `stateless`, `stateful`, or `auto`. | `auto` (`.env.example` and the Docker image set `stateless`) |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<app-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend: `in-memory`, `filesystem`, `supabase`, `cloudflare-kv/r2/d1`. | `in-memory` |
| `OTEL_ENABLED` | Enable [OpenTelemetry](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

See [`.env.example`](./.env.example) for the common framework overrides.

## Running the server

### Local development

- **Build and run the production version**:

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:http
  # or
  bun run start:stdio
  ```

- **Run checks and tests**:
  ```sh
  bun run devcheck  # Lints, formats, type-checks, and more
  bun run test      # Runs the test suite
  ```

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`) plus the area handling, input vocabulary, and output shapes the search tools share. |
| `src/services/police-api` | data.police.uk client: request pacer, retries, caches, upstream schemas, record normalization, dated coverage-gaps table. |
| `tests/` | Unit and integration tests. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for logging, `ctx.state` for storage
- Register new tools in `allToolDefinitions` (`src/mcp-server/tools/definitions/index.ts`), which `src/index.ts` passes to `createApp()`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

This project is licensed under the Apache 2.0 License. See the [LICENSE](./LICENSE) file for details.

Data: Contains public sector information licensed under the [Open Government Licence v3.0](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/). Source: data.police.uk. Every tool response carries this attribution; storing, caching and redistributing the data are permitted with it. This project is independent of the Home Office, data.police.uk and the police forces.
