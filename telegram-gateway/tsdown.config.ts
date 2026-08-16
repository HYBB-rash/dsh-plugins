import { defineConfig } from 'tsdown'

/**
 * telegram-gateway ships one Node plugin entry. Declarations come from
 * `tsc -b` (dts: false), matching every package.
 */
export default defineConfig({
  entry: ['lib/types/index.js', 'lib/types/invariant.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
