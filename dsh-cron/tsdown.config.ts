import { defineConfig } from 'tsdown'

/**
 * dsh-cron ships one Node plugin entry. Declarations come from `tsc -b`
 * (dts: false), matching every package. The scheduler half is a dynamic
 * import so the manager profile never loads the Telegram gateway package.
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
