/**
 * dsh-cron: global unattended cron automation for DSH, aligned with Hermes
 * `hermes cron create --deliver`.
 *
 * Single package, dual role (see the design doc):
 * - `mode: manager` — web profile. Registers the `cron_create` /
 *   `cron_list` / `cron_delete` model tools on every future root agent and is
 *   the single writer of `jobs.jsonl`.
 * - `mode: scheduler` — execution profile. Reads `jobs.jsonl`, derives a live
 *   timer projection with Hermes grace/fast-forward semantics, executes due
 *   jobs through unattended `session-cron-<jobId>` agents, delivers results
 *   through an optional host delivery service, and appends
 *   every run to `runs.jsonl`.
 *
 * The scheduler half is imported dynamically so the manager profile does not
 * load scheduler runtime dependencies.
 * @module @deepseek-ai/dsh-cron
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import z from '@deepseek-ai/schemastery'
import { join } from 'node:path'
import { registerCronTools } from './manager.ts'
import { JobStore, defaultStoreDir } from './store.ts'
import { createControlService, isValidBoundCronCommandSpec } from './control.ts'
import type { BoundCronCommandSpec } from './control-contract.ts'
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
export {
  isValidPreparedDeliveryObject,
} from './types.ts'
export type {
  CronDeliveryReceipt,
  PreparedDeliveryObject,
} from './types.ts'

/** Public manager control contract, kept free of scheduler/provider imports. */
export * from './control-contract.ts'
/** Local, offline maintenance port; it is not exposed through online RPC. */
export { createMaintenanceControl } from './control.ts'
export type { MaintenanceControlConfig } from './control.ts'
/** Public Unix-socket client for the manager control contract. */
export { createControlRpcClient }
export type { ControlRpcClientConfig } from './control-rpc.ts'
/** Stopped-writer release preflight uses the same v2 control service and RPC. */
export { createControlService, inspectActiveJobs } from './control.ts'
export { createControlRpcServer } from './control-rpc.ts'
export type { ControlServiceConfig } from './control.ts'
export type { ControlRpcServerConfig } from './control-rpc.ts'
/** Public generic per-run environment port and fail-closed registry. */
export * from './run-environment.ts'
/** Generic prepare -> deliver -> settle environment. */
export * from './prepared-delivery.ts'
/** Trusted operator module boundary for business-owned run environments. */
export * from './environment-modules.ts'

/** Services required by either role before activation. */
export const inject = ['agents', 'sessions', 'tools', 'agentDefaultModel', 'loader', 'workspaceRegistry']

/** dsh-cron configuration. */
export interface Config {
  /** Which role this profile runs: manager (web) or scheduler (execution). */
  mode: 'manager' | 'scheduler'
  /** Job-log poll interval for the scheduler. Defaults to 10s. */
  pollIntervalMs?: number
  /** Scheduler concurrency cap for due jobs. Defaults to 3. */
  maxConcurrent?: number
  /** Whether the scheduler delivers error notices. Defaults to true. */
  deliverOnError?: boolean
  /** Optional execution tool preset for ordinary scheduled Agent sessions. */
  agentPreset?: string
  /** Store directory override. Defaults to `$DSH_HOME/storages/dsh-cron`. */
  storeDir?: string
  /** Unix socket override. Defaults to `<storeDir>/control.sock` in manager mode. */
  controlSocketPath?: string
  /** Exact create-only command bindings owned by the manager profile. */
  managedCommandBindings?: BoundCronCommandSpec[]
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
  pollIntervalMs: z.number().step(1).min(1_000).default(10_000),
  maxConcurrent: z.number().step(1).min(1).default(3),
  deliverOnError: z.boolean().default(true),
  agentPreset: z.string(),
  storeDir: z.string().default(''),
  controlSocketPath: z.string().default(''),
  managedCommandBindings: z.array(z.object({
    externalRef: z.string(),
    schedule: z.union([
      z.object({ kind: z.const('cron'), expr: z.string() }),
      z.object({ kind: z.const('interval'), minutes: z.number().step(1).min(1) }),
      z.object({ kind: z.const('once'), runAt: z.string() }),
    ]),
    command: z.object({
      argv: z.array(z.string()),
      timeoutSeconds: z.number().step(1).min(1),
      outputMaxBytes: z.number().step(1).min(1),
    }),
    deliver: z.union(['default', 'silent'] as const),
    failureAlert: (z.object({
      after: z.number().step(1).min(1),
      cooldownMinutes: z.number().step(1).min(1),
    }) as unknown as z<{ after: number; cooldownMinutes: number } | undefined>).default(undefined),
    cwd: z.string(),
  })).default([]) as unknown as z<BoundCronCommandSpec[]>,
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
  const managedCommandBindings = config.managedCommandBindings ?? []
  const externalRefs = new Set<string>()
  for (const spec of managedCommandBindings) {
    if (!isValidBoundCronCommandSpec(spec) || externalRefs.has(spec.externalRef)) {
      throw new Error('invalid managed command binding configuration')
    }
    externalRefs.add(spec.externalRef)
  }
  for (const spec of managedCommandBindings) {
    const response = await control.ensureBoundCommand(spec)
    if (!('ok' in response) || !response.ok) {
      const code = 'errorCode' in response ? response.errorCode : response.code
      throw new Error(`managed command binding conflict: ${code}`)
    }
  }
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
 * The scheduler half is loaded lazily so manager profiles stay lightweight.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (config.mode === 'scheduler') {
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
    const { applyScheduler } = await import('./scheduler.ts')
    await applyScheduler(ctx, {
      storeDir: resolveStoreDir(config),
      pollIntervalMs: config.pollIntervalMs ?? 10_000,
      maxConcurrent: config.maxConcurrent ?? 3,
      deliverOnError: config.deliverOnError ?? true,
      ...(config.agentPreset === undefined ? {} : { agentPreset: config.agentPreset }),
    }, {
      installRunNow: port => installRunNowTools(ctx, port, 'session-telegram'),
    })
    return
  }
  await applyManager(ctx, config)
}
