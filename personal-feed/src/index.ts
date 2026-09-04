import { installTelegramExtensionWithClock } from './telegram-extension.ts'

/** Install the Personal Feed Telegram extension with an isolated clock. */
export function installTelegramExtension(
  ctx: Parameters<typeof installTelegramExtensionWithClock>[0],
  rawConfig: Parameters<typeof installTelegramExtensionWithClock>[1],
): ReturnType<typeof installTelegramExtensionWithClock> {
  const clock = Object.freeze({ now: () => new Date() })
  return installTelegramExtensionWithClock(ctx, rawConfig, clock)
}
