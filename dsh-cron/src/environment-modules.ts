/** Operator-configured business environment modules for dsh-cron. */

import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { CronAgentEnvironmentProvider } from './run-environment.ts'

export interface CronEnvironmentModuleConfig {
  readonly modulePath: string
  /** JSON object passed to the business module; empty means `{}`. */
  readonly configJson?: string
}

export interface CronEnvironmentModule {
  readonly createCronEnvironmentExtension: (
    ctx: Context,
    config: Readonly<Record<string, unknown>>,
  ) => CronAgentEnvironmentProvider | Promise<CronAgentEnvironmentProvider>
}

export type ImportCronEnvironmentModule = (specifier: string) => Promise<unknown>

/** Load trusted operator modules without teaching dsh-cron any business name. */
export async function loadCronEnvironmentModules(
  ctx: Context,
  configs: readonly CronEnvironmentModuleConfig[],
  importModule?: ImportCronEnvironmentModule,
): Promise<CronAgentEnvironmentProvider[]> {
  const load = importModule ?? (specifier => importFromComposition(ctx, specifier))
  const providers: CronAgentEnvironmentProvider[] = []
  for (const config of configs) {
    if (config.modulePath.trim() === '') throw new Error('cron environment modulePath must be non-empty')
    const parsed = parseConfig(config.configJson)
    const specifier = isAbsolute(config.modulePath)
      ? pathToFileURL(config.modulePath).href
      : config.modulePath
    const loaded = await load(specifier)
    if (!isModule(loaded)) {
      throw new Error(`cron environment module ${config.modulePath} does not export createCronEnvironmentExtension`)
    }
    providers.push(await loaded.createCronEnvironmentExtension(ctx, parsed))
  }
  return providers
}

/** Resolve bare business packages from the active profile, just like Cordis plugins. */
function importFromComposition(ctx: Context, specifier: string): Promise<unknown> {
  const loader = (ctx as Context & {
    loader?: { internal?: { import: (name: string, parentUrl: string, attributes: object) => Promise<unknown> } }
  }).loader
  if (ctx.baseUrl !== undefined && loader?.internal !== undefined) {
    return loader.internal.import(specifier, ctx.baseUrl, {})
  }
  return import(specifier)
}

function parseConfig(value: string | undefined): Readonly<Record<string, unknown>> {
  if (value === undefined || value.trim() === '') return Object.freeze({})
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('cron environment configJson must be valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('cron environment configJson must encode an object')
  }
  return Object.freeze({ ...(parsed as Record<string, unknown>) })
}

function isModule(value: unknown): value is CronEnvironmentModule {
  return typeof value === 'object'
    && value !== null
    && typeof (value as Record<string, unknown>).createCronEnvironmentExtension === 'function'
}
