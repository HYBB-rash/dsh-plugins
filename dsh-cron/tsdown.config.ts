import { defineConfig } from 'tsdown'

/**
 * dsh-cron ships one Node plugin entry. Declarations come from `tsc -b`
 * (dts: false), matching every package. The scheduler half remains a dynamic
 * import so the manager profile does not load scheduler-only runtime code.
 */
export default defineConfig({
  entry: ['lib/types/index.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  // Only remove generated root-level JavaScript; preserve tsc-generated lib/types inputs.
  clean: ['lib/*.js'],
})
