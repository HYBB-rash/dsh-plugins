/** Trusted operator extensions for Telegram-specific business adapters. */

import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'

export interface TelegramExtensionConfig {
  readonly modulePath: string
  /** JSON object passed to the extension; empty means `{}`. */
  readonly configJson?: string
}

export interface TelegramExtensionModule {
  readonly installTelegramExtension: (
    ctx: Context,
    config: Readonly<Record<string, unknown>>,
  ) => void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>
}

export type ImportTelegramExtension = (specifier: string) => Promise<unknown>

export async function loadTelegramExtensions(
  ctx: Context,
  configs: readonly TelegramExtensionConfig[],
  importModule: ImportTelegramExtension = specifier => import(specifier),
): Promise<Array<() => void | Promise<void>>> {
  const disposers: Array<() => void | Promise<void>> = []
  try {
    for (const config of configs) {
      if (config.modulePath.trim() === '') throw new Error('Telegram extension modulePath must be non-empty')
      const parsed = parseConfig(config.configJson)
      const specifier = isAbsolute(config.modulePath)
        ? pathToFileURL(config.modulePath).href
        : config.modulePath
      const loaded = await importModule(specifier)
      if (!isModule(loaded)) {
        throw new Error(`Telegram extension ${config.modulePath} does not export installTelegramExtension`)
      }
      const dispose = await loaded.installTelegramExtension(ctx, parsed)
      if (typeof dispose === 'function') disposers.push(dispose)
    }
    return disposers
  } catch (error) {
    await Promise.allSettled(disposers.reverse().map(dispose => Promise.resolve(dispose())))
    throw error
  }
}

function parseConfig(value: string | undefined): Readonly<Record<string, unknown>> {
  if (value === undefined || value.trim() === '') return Object.freeze({})
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('Telegram extension configJson must be valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Telegram extension configJson must encode an object')
  }
  return Object.freeze({ ...(parsed as Record<string, unknown>) })
}

function isModule(value: unknown): value is TelegramExtensionModule {
  return typeof value === 'object'
    && value !== null
    && typeof (value as Record<string, unknown>).installTelegramExtension === 'function'
}
