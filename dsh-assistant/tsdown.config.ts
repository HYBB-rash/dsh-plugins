import { defineConfig } from 'tsdown'

/**
 * dsh-assistant ships the Node plugin and an explicit offline migration CLI.
 * Declarations come from `tsc -b` (dts: false), matching every local package. The plugin is host-only; the
 * Telegram half is imported statically (it reuses `@deepseek-ai/dsh-telegram-gateway`
 * exports, which the telegram profile already loads).
 */
export default defineConfig({
  entry: ['lib/types/index.js', 'lib/types/migrate-cli.js', 'lib/types/historical-recovery.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  // Only remove generated root-level JavaScript; preserve tsc-generated lib/types inputs.
  clean: ['lib/*.js'],
})
