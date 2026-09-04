import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'
import { resolve } from 'node:path'

const harnessRoot = process.env.DSH_HARNESS_ROOT

if (harnessRoot === undefined || harnessRoot === '') {
  throw new Error('Set DSH_HARNESS_ROOT to a compatible DeepSeek Harness checkout before running these tests.')
}

/**
 * External-repo test config: resolve @deepseek-ai/* to monorepo SOURCE (the
 * same tsconfig-paths the monorepo vitest uses) so the package is tested
 * against source, not loader-handoff bundles. Node-only tests; no jsdom.
 */
export default defineConfig({
  plugins: [tsconfigPaths({
    projects: [`${harnessRoot}/tsconfig.base.json`],
  })],
  test: {
    include: ['tests/**/*.spec.ts'],
    testTimeout: 30_000,
  },
  resolve: {
    alias: {
      '@deepseek-ai/dsh-cron': resolve(import.meta.dirname, '../dsh-cron/src/index.ts'),
      '@herman/personal-feed': resolve(import.meta.dirname, '../personal-feed/src/index.ts'),
    },
  },
})
