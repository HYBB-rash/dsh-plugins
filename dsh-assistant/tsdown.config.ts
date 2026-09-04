import { defineConfig } from 'tsdown'

/**
 * dsh-assistant ships only the current Node plugin.
 * Declarations come from `tsc -b` (dts: false), matching every local package. The plugin is host-only; the
 * Transport collaborators are discovered from the shared Cordis root at the
 * moment a delivery is attempted; no sibling plugin is bundled or imported.
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
