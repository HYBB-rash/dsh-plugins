import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'

const harnessRoot = process.env.DSH_HARNESS_ROOT

if (harnessRoot === undefined || harnessRoot === '') {
  throw new Error('Set DSH_HARNESS_ROOT to a compatible DeepSeek Harness checkout before running these tests.')
}

export default defineConfig({
  plugins: [tsconfigPaths({
    projects: [`${harnessRoot}/tsconfig.base.json`],
  })],
  test: {
    include: ['tests/**/*.spec.ts'],
    testTimeout: 30_000,
  },
})
