import { defineConfig } from 'vitest/config'

// Exercise the published SDK, never a checkout or tsconfig alias of upstream.
export default defineConfig({
  test: { include: ['telegram-gateway/tests/**/*.spec.ts', 'dsh-cron/tests/**/*.spec.ts', 'dsh-assistant/tests/**/*.spec.ts'] },
})
