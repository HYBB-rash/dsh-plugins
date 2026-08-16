import { defineConfig } from 'tsdown'

/**
 * dsh-assistant ships the Node plugin and an explicit offline migration CLI.
 * Declarations come from `tsc -b` (dts: false), matching every local package. The plugin is host-only; the
 * Telegram half is imported statically (it reuses `@deepseek-ai/dsh-telegram-gateway`
 * exports, which the telegram profile already loads).
 */
export default defineConfig({
  entry: ['lib/types/index.js', 'lib/types/migrate-cli.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
