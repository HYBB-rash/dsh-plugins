import { defineConfig } from 'tsdown'

/**
 * dsh-x-feed ships one Node plugin entry. Declarations come from `tsc -b`
 * (dts: false), matching every package. The Python kernel and the cron prompt
 * are runtime assets carried by `files` in package.json — never bundled.
 */
export default defineConfig({
  entry: ['lib/types/index.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
