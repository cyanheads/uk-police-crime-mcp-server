/**
 * @fileoverview The bundle cleaner (`scripts/clean-mcpb.ts`) and its post-bundle
 * check (`scripts/lint-packaging.ts`) strip dependency-shipped agent docs only
 * at an installed package's root, so the MCP SDK's runtime `dist/ext/skills/`
 * modules survive (cyanheads/mcp-ts-core#794), and the two selectors agree.
 * @module tests/scripts/agent-doc-entry.test
 */

import { describe, expect, it } from 'vitest';
import { AGENT_DOC_ENTRY, filterAgentDocEntries } from '../../scripts/clean-mcpb.js';

interface PackagingLinter {
  AGENT_DOC_ENTRY: RegExp;
  checkBundleEntries(entries: string[], bundleLabel: string): string[];
}

/**
 * Loaded by URL at run time: a static import pulls the script into the `tsc`
 * program, where its repo-only `../src/mcp-server/skills.js` fallback does not
 * resolve (cyanheads/mcp-ts-core#797).
 */
const linter: PackagingLinter = await import(
  new URL('../../scripts/lint-packaging.ts', import.meta.url).href
);

/** Module files the server loads at run time, from every install layout. */
const RUNTIME_ENTRIES = [
  'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
  'node_modules/@modelcontextprotocol/server/dist/ext/skills/node.cjs',
  'node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
  'node_modules/@cyanheads/mcp-ts-core/node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
  'node_modules/some-pkg/lib/skills/loader.js',
  'node_modules/@opentelemetry/semantic-conventions/build/src/index.js',
];

/** Agent docs at a package root — plain, scoped, and nested installs — plus a stray SKILL.md. */
const AGENT_DOC_ENTRIES = [
  'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/SKILL.md',
  'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/references/patterns.md',
  'node_modules/some-pkg/skills/guide/SKILL.md',
  'node_modules/some-pkg/skills/guide/reference.md',
  'node_modules/@scope/pkg/.claude/settings.json',
  'node_modules/pkg/.agents/skills/helper/SKILL.md',
  'node_modules/outer/node_modules/@scope/inner/skills/guide/notes.md',
  'node_modules/@scope/outer/node_modules/inner/framework-skills/x/SKILL.md',
  'node_modules/pkg/docs/SKILL.md',
];

describe('AGENT_DOC_ENTRY (bundle cleaner)', () => {
  it('keeps runtime skills modules nested below a package root', () => {
    expect(filterAgentDocEntries(RUNTIME_ENTRIES)).toEqual([]);
  });

  it('strips agent docs at plain, scoped and nested package roots', () => {
    expect(filterAgentDocEntries(AGENT_DOC_ENTRIES)).toEqual(AGENT_DOC_ENTRIES);
  });

  it('never matches the bundle root', () => {
    expect(filterAgentDocEntries(['skills/guide/SKILL.md', 'dist/index.js'])).toEqual([]);
  });
});

describe('AGENT_DOC_ENTRY (packaging check 8)', () => {
  it('selects the same entries as the cleaner', () => {
    const entries = [...RUNTIME_ENTRIES, ...AGENT_DOC_ENTRIES];
    expect(entries.filter((entry) => linter.AGENT_DOC_ENTRY.test(entry))).toEqual(
      entries.filter((entry) => AGENT_DOC_ENTRY.test(entry)),
    );
  });

  it('passes a cleaned bundle that keeps the SDK runtime skills modules', () => {
    expect(linter.checkBundleEntries([...RUNTIME_ENTRIES, 'dist/index.js'], 'bundle')).toEqual([]);
  });

  it('flags a bundle that still holds package-root agent docs', () => {
    const errors = linter.checkBundleEntries([...RUNTIME_ENTRIES, ...AGENT_DOC_ENTRIES], 'bundle');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(`${AGENT_DOC_ENTRIES.length} node_modules agent-doc entries`);
  });
});
