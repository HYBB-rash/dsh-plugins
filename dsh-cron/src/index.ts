/**
 * dsh-cron: global unattended cron automation for DSH, aligned with Hermes
 * `hermes cron create --deliver`.
 *
 * Single package, dual role (see the design doc):
 * - `mode: manager` — web profile. Registers the `cron_create` /
 *   `cron_list` / `cron_delete` model tools on every future root agent and is
 *   the single writer of `jobs.jsonl`.
 * - `mode: scheduler` — telegram profile. Reads `jobs.jsonl`, derives a live
 *   timer projection with Hermes grace/fast-forward semantics, executes due
 *   jobs through unattended `session-cron-<jobId>` agents, delivers results
 *   to Telegram through an independent `createTelegramHttp` face, and appends
 *   every run to `runs.jsonl`.
 *
 * The scheduler half is imported dynamically so the manager profile never
 * loads the Telegram gateway package.
 * @module @deepseek-ai/dsh-cron
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import z from '@deepseek-ai/schemastery'
import { join } from 'node:path'
import { registerCronTools } from './manager.ts'
import { JobStore, defaultStoreDir } from './store.ts'
import { createControlService } from './control.ts'
import { createControlRpcClient, createControlRpcServer } from './control-rpc.ts'
import { provideCronAgentEnvironmentRegistry } from './run-environment.ts'
import { installRunNowTools } from './run-now-tool.ts'
import {
  createPreparedDeliveryEnvironmentProvider,
} from './prepared-delivery.ts'
import {
  loadCronEnvironmentModules,
  type CronEnvironmentModuleConfig,
} from './environment-modules.ts'

/** Stable Cordis plugin name. */
export const name = 'dsh-cron'

/** Public terminal-outcome event contract (§8), see `types.ts`. */
export type { CronRunFinishedEvent } from './types.ts'

/** Public manager control contract, kept free of scheduler/gateway imports. */
export * from './control-contract.ts'
/** Local, offline maintenance port; it is not exposed through online RPC. */
export { createMaintenanceControl } from './control.ts'
export type { MaintenanceControlConfig } from './control.ts'
/** Public Unix-socket client for the manager control contract. */
export { createControlRpcClient }
export type { ControlRpcClientConfig } from './control-rpc.ts'
/** Public generic per-run environment port and fail-closed registry. */
export * from './run-environment.ts'
/** Generic prepare -> deliver -> settle environment. */
export * from './prepared-delivery.ts'
/** Trusted operator module boundary for business-owned run environments. */
export * from './environment-modules.ts'

/** Services required by either role before activation. */
export const inject = ['agents', 'sessions', 'tools', 'agentDefaultModel', 'credentials', 'loader']

/** dsh-cron configuration. */
export interface Config {
  /** Which role this profile runs: manager (web) or scheduler (telegram). */
  mode: 'manager' | 'scheduler'
  /** Telegram API base URL. Defaults to https://api.telegram.org. */
  apiBaseUrl?: string
  /** Telegram bot token; falls back to the TELEGRAM_BOT_TOKEN credential reference. */
  token?: string
  /** Numeric Telegram chat id; falls back to the TELEGRAM_ALLOWED_CHAT_ID credential reference. */
  chatId?: string
  /** Job-log poll interval for the scheduler. Defaults to 10s. */
  pollIntervalMs?: number
  /** Scheduler concurrency cap for due jobs. Defaults to 3. */
  maxConcurrent?: number
  /** Whether the scheduler delivers error notices. Defaults to true. */
  deliverOnError?: boolean
  /** Store directory override. Defaults to `$DSH_HOME/storages/dsh-cron`. */
  storeDir?: string
  /** Unix socket override. Defaults to `<storeDir>/control.sock` in manager mode. */
  controlSocketPath?: string
  /** Operator-owned prepared-delivery bindings for restricted per-run jobs. */
  preparedDeliveryBindings?: Array<{
    jobId: string
    driver: {
      argv: string[]
      timeoutSeconds: number
      outputMaxBytes: number
    }
    cwd?: string
  }>
  /** Trusted business modules that provide bounded Agent environments. */
  environmentModules?: CronEnvironmentModuleConfig[]
}

export const Config: z<Config> = z.object({
  mode: z.union(['manager', 'scheduler'] as const).default('manager'),
  apiBaseUrl: z.string().default('https://api.telegram.org'),
  token: z.string(),
  chatId: z.string(),
  pollIntervalMs: z.number().step(1).min(1_000).default(10_000),
  maxConcurrent: z.number().step(1).min(1).default(3),
  deliverOnError: z.boolean().default(true),
  storeDir: z.string().default(''),
  controlSocketPath: z.string().default(''),
  preparedDeliveryBindings: z.array(z.object({
    jobId: z.string(),
    driver: z.object({
      argv: z.array(z.string()),
      timeoutSeconds: z.number().step(1).min(1).max(3_600),
      outputMaxBytes: z.number().step(1).min(1).max(1_048_576),
    }),
    cwd: z.string(),
  })).default([]),
  environmentModules: z.array(z.object({
    modulePath: z.string(),
    configJson: z.string(),
  })).default([]),
})

/** Resolve the store directory, defaulting under DSH_HOME. */
export function resolveStoreDir(config: Pick<Config, 'storeDir'>): string {
  return config.storeDir !== undefined && config.storeDir !== ''
    ? config.storeDir
    : defaultStoreDir(resolveDshHome())
}

/** Resolve the manager control socket without changing scheduler paths. */
export function resolveControlSocketPath(config: Pick<Config, 'storeDir' | 'controlSocketPath'>): string {
  return config.controlSocketPath !== undefined && config.controlSocketPath !== ''
    ? config.controlSocketPath
    : join(resolveStoreDir(config), 'control.sock')
}

type OwnerCleanup = () => void | Promise<void>

/**
 * Manager role: register the cron tools on every future root agent.
 * Mirrors the schedule package's per-root pattern — the tools mutate the
 * durable job log with a `sessions.flush` barrier before each append.
 */
export async function applyManager(ctx: Context, config: Config): Promise<void> {
  const storeDir = resolveStoreDir(config)
  const store = new JobStore(storeDir)
  const control = createControlService({ storeDir })
  const controlRpc = createControlRpcServer({
    socketPath: resolveControlSocketPath(config),
    control,
    environment: 'production',
  })
  await controlRpc.listen()
  const runtimes = new Map<Agent, OwnerCleanup>()
  let stopping = false

  ctx.effect(() => {
    const stopCreated = ctx.on('agent/created', ({ agent }) => {
      if (stopping || runtimes.has(agent) || !ctx.agents.roots().includes(agent)) return
      const cleanup: OwnerCleanup = agent.ctx.effect(() => {
        const disposeTools = registerCronTools(ctx, agent.ctx, store)
        return async () => {
          disposeTools()
        }
      }, 'dsh-cron.manager()')
      runtimes.set(agent, cleanup)
    })

    return async () => {
      stopping = true
      stopCreated()
      const cleanups = [...runtimes.values()]
      runtimes.clear()
      await Promise.allSettled(cleanups.map(cleanup => Promise.resolve(cleanup())))
      await controlRpc.dispose()
    }
  }, 'dsh-cron.manager.lifecycle()')
}

/**
 * Cordis plugin entry: dispatch to the configured role.
 * The scheduler half is loaded lazily so manager profiles never import the
 * Telegram gateway package.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const registry = provideCronAgentEnvironmentRegistry(ctx)
  const preparedDeliveryBindings = config.preparedDeliveryBindings ?? []
  if (preparedDeliveryBindings.length > 0) {
    ctx.effect(
      () => registry.register(createPreparedDeliveryEnvironmentProvider({ bindings: preparedDeliveryBindings })),
      'dsh-cron.prepared-delivery-provider()',
    )
  }
  const environmentModules = config.environmentModules ?? []
  if (environmentModules.length > 0) {
    const providers = await loadCronEnvironmentModules(ctx, environmentModules)
    for (const provider of providers) {
      ctx.effect(
        () => registry.register(provider),
        `dsh-cron.environment-module(${provider.marker})`,
      )
    }
  }
  if (config.mode === 'scheduler') {
    const { applyScheduler } = await import('./scheduler.ts')
    await applyScheduler(ctx, {
      storeDir: resolveStoreDir(config),
      apiBaseUrl: config.apiBaseUrl ?? 'https://api.telegram.org',
      ...(config.token === undefined ? {} : { token: config.token }),
      ...(config.chatId === undefined ? {} : { chatId: config.chatId }),
      tokenRef: 'TELEGRAM_BOT_TOKEN',
      chatIdRef: 'TELEGRAM_ALLOWED_CHAT_ID',
      pollIntervalMs: config.pollIntervalMs ?? 10_000,
      maxConcurrent: config.maxConcurrent ?? 3,
      deliverOnError: config.deliverOnError ?? true,
    }, {
      installRunNow: port => installRunNowTools(ctx, port, 'session-telegram'),
    })
    return
  }
  await applyManager(ctx, config)
}
