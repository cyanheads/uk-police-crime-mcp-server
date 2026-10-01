# uk-police-crime-mcp-server - Directory Structure

Generated on: 2026-10-01 16:13:11

```text
uk-police-crime-mcp-server/
├── .claude-plugin/
│   └── plugin.json
├── .codex-plugin/
│   ├── mcp.json
│   └── plugin.json
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.yml
│   │   ├── config.yml
│   │   └── feature_request.yml
│   ├── workflows/
│   │   └── codeql.yml
│   ├── CODE_OF_CONDUCT.md
│   ├── CONTRIBUTING.md
│   ├── FUNDING.yml
│   └── SECURITY.md
├── .vscode/
│   ├── extensions.json
│   └── settings.json
├── changelog/
│   ├── 0.1.x/
│   └── template.md
├── docs/
│   └── design.md
├── framework-skills/
│   ├── add-app-tool/
│   │   └── SKILL.md
│   ├── add-prompt/
│   │   └── SKILL.md
│   ├── add-resource/
│   │   └── SKILL.md
│   ├── add-service/
│   │   └── SKILL.md
│   ├── add-test/
│   │   └── SKILL.md
│   ├── add-tool/
│   │   └── SKILL.md
│   ├── api-auth/
│   │   └── SKILL.md
│   ├── api-canvas/
│   │   └── SKILL.md
│   ├── api-config/
│   │   └── SKILL.md
│   ├── api-context/
│   │   └── SKILL.md
│   ├── api-errors/
│   │   └── SKILL.md
│   ├── api-linter/
│   │   └── SKILL.md
│   ├── api-mirror/
│   │   └── SKILL.md
│   ├── api-services/
│   │   ├── references/
│   │   │   ├── graph.md
│   │   │   ├── llm.md
│   │   │   └── speech.md
│   │   └── SKILL.md
│   ├── api-telemetry/
│   │   └── SKILL.md
│   ├── api-testing/
│   │   └── SKILL.md
│   ├── api-utils/
│   │   ├── references/
│   │   │   ├── formatting.md
│   │   │   ├── parsing.md
│   │   │   └── security.md
│   │   └── SKILL.md
│   ├── api-workers/
│   │   └── SKILL.md
│   ├── code-simplifier/
│   │   └── SKILL.md
│   ├── design-mcp-server/
│   │   └── SKILL.md
│   ├── field-test/
│   │   └── SKILL.md
│   ├── git-wrapup/
│   │   └── SKILL.md
│   ├── maintenance/
│   │   └── SKILL.md
│   ├── orchestrations/
│   │   ├── workflows/
│   │   │   ├── field-test-fix.md
│   │   │   ├── fix-wrapup-release.md
│   │   │   ├── greenfield-build.md
│   │   │   └── maintenance-release.md
│   │   └── SKILL.md
│   ├── polish-docs-meta/
│   │   ├── references/
│   │   │   ├── agent-protocol.md
│   │   │   ├── package-meta.md
│   │   │   ├── readme.md
│   │   │   └── server-json.md
│   │   └── SKILL.md
│   ├── release-and-publish/
│   │   └── SKILL.md
│   ├── release-pr-review/
│   │   └── SKILL.md
│   ├── report-issue-framework/
│   │   └── SKILL.md
│   ├── report-issue-local/
│   │   └── SKILL.md
│   ├── security-pass/
│   │   └── SKILL.md
│   ├── setup/
│   │   └── SKILL.md
│   ├── techniques/
│   │   ├── references/
│   │   │   └── outline-on-overflow.md
│   │   └── SKILL.md
│   └── tool-defs-analysis/
│       └── SKILL.md
├── scripts/
│   ├── build-changelog.ts
│   ├── build.ts
│   ├── check-dependency-specifiers.ts
│   ├── check-docs-sync.ts
│   ├── check-framework-antipatterns.ts
│   ├── check-skill-versions.ts
│   ├── check-skills-sync.ts
│   ├── clean-mcpb.ts
│   ├── clean.ts
│   ├── devcheck.ts
│   ├── install-otel.ts
│   ├── lint-mcp.ts
│   ├── lint-packaging.ts
│   ├── list-skills.ts
│   ├── release-github.ts
│   └── tree.ts
├── src/
│   ├── mcp-server/
│   │   └── tools/
│   │       ├── definitions/
│   │       │   ├── find-neighbourhood.tool.ts
│   │       │   ├── get-crime-outcomes.tool.ts
│   │       │   ├── index.ts
│   │       │   ├── list-reference.tool.ts
│   │       │   ├── search-crimes.tool.ts
│   │       │   ├── search-outcomes.tool.ts
│   │       │   └── search-stops.tool.ts
│   │       ├── area-search.ts
│   │       ├── format-helpers.ts
│   │       ├── search-output.ts
│   │       └── shared-schemas.ts
│   ├── services/
│   │   └── police-api/
│   │       ├── area.ts
│   │       ├── html-to-text.ts
│   │       ├── known-gaps.ts
│   │       ├── lru-cache.ts
│   │       ├── police-api-service.ts
│   │       ├── raw-schemas.ts
│   │       ├── records.ts
│   │       └── types.ts
│   └── index.ts
├── tests/
│   ├── fixtures/
│   │   ├── police-api-upstream-w3.ts
│   │   ├── police-api-upstream.ts
│   │   └── service-harness.ts
│   ├── services/
│   │   ├── area.test.ts
│   │   ├── html-to-text.test.ts
│   │   ├── known-gaps.test.ts
│   │   ├── lru-cache.test.ts
│   │   ├── police-api-service.boundary.test.ts
│   │   ├── police-api-service.cache.test.ts
│   │   ├── police-api-service.neighbourhood.test.ts
│   │   ├── police-api-service.reference.test.ts
│   │   ├── records-neighbourhood.test.ts
│   │   └── records.test.ts
│   ├── shared/
│   │   ├── format-helpers.test.ts
│   │   └── shared-schemas.test.ts
│   └── tools/
│       ├── area-search.test.ts
│       ├── find-neighbourhood.tool.test.ts
│       ├── get-crime-outcomes.tool.test.ts
│       ├── list-reference.tool.test.ts
│       ├── search-crimes.tool.test.ts
│       ├── search-outcomes.tool.test.ts
│       ├── search-output.test.ts
│       └── search-stops.tool.test.ts
├── .dockerignore
├── .env.example
├── .gitattributes
├── .gitignore
├── .mcpbignore
├── AGENTS.md
├── biome.json
├── bun.lock
├── bunfig.toml
├── CHANGELOG.md
├── CLAUDE.md
├── devcheck.config.json
├── Dockerfile
├── LICENSE
├── manifest.json
├── package.json
├── README.md
├── server.json
├── tsconfig.build.json
├── tsconfig.json
└── vitest.config.ts
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._
