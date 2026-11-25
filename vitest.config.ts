/**
 * @fileoverview Vitest config for the consumer server. Uses Vitest 4 `projects`
 * so you can split suites (unit/smoke/integration/fuzz) and run each with
 * `--project <name>` as the surface grows. Extends the framework's base config
 * for shared `resolve`, `ssr`, and coverage settings.
 *
 * @module vitest.config
 */

import coreConfig from '@cyanheads/mcp-ts-core/vitest.config';
import { defineConfig, mergeConfig } from 'vitest/config';

const alias = { '@/': new URL('./src/', import.meta.url).pathname };

/**
 * Vitest 5.1's forks pool calls `child.channel.unref()`, which Bun's child
 * processes lack, so a run under `bun --bun` uses worker threads; Node keeps the
 * base config's isolated forks. No suite here spawns a worker or reads local time.
 */
const bunPool = process.versions.bun === undefined ? {} : { pool: 'threads' as const };

export default mergeConfig(
  coreConfig,
  defineConfig({
    resolve: { alias },
    test: {
      ...bunPool,
      projects: [
        {
          extends: true,
          test: {
            name: 'unit',
            include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
            exclude: ['tests/smoke/**', 'tests/integration/**', 'tests/fuzz/**'],
            testTimeout: 30_000,
          },
        },
        {
          extends: true,
          test: {
            name: 'smoke',
            include: ['tests/smoke/**/*.test.ts'],
          },
        },
        {
          extends: true,
          test: {
            name: 'integration',
            include: ['tests/integration/**/*.test.ts'],
            maxWorkers: 1,
            testTimeout: 30_000,
          },
        },
        {
          extends: true,
          test: {
            name: 'fuzz',
            include: ['tests/fuzz/**/*.test.ts'],
            testTimeout: 15_000,
          },
        },
      ],
    },
  }),
);
