import { defineConfig } from 'tsdown'

/**
 * Build directly from source and clean stale runtime chunks first. Run tsc
 * afterwards to restore declarations under lib/types.
 */
export default defineConfig({
  entry: ['src/index.ts', 'src/invariant.ts', 'src/managed-compaction.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: true,
})
