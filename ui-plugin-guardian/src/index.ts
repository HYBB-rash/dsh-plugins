/**
 * Plugin guardian, node half. Watches the plugin fibers of our own plugins
 * and auto-repairs a failed fiber by re-mounting it.
 *
 * Detection: subscribes `internal/status` (cordis emits it on every fiber
 * state transition). When a watched plugin's fiber enters `FAILED` (its
 * callback or config threw) or `DISPOSED` while it should be alive, the
 * guardian re-mounts the plugin with its original runtime (callback + inject
 * + config), with a cooldown so a crash loop does not spin.
 *
 * Repair: `ctx.plugin({ name, apply, inject, Config })` reuses the plugin
 * runtime keyed by the callback, so re-mounting restores the same identity.
 * The repair is attempted at most once per cooldown window per plugin; every
 * detection and repair is appended to an audit log under
 * `$DSH_HOME/storages/plugin-guardian/audit.jsonl`.
 *
 * @module @deepseek-ai/dsh-client-ui-plugin-guardian
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context, Fiber, FiberState, Plugin } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

/** Stable Cordis plugin name. */
export const name = 'ui-plugin-guardian'

/** Services required: none beyond the root context (internal/status is on ctx). */
export const inject: readonly string[] = []

/** Guardian configuration. */
export interface Config {
  /** Plugin names watched for failure (cordis `name`); empty = all self-owned names below. */
  watched: string[]
  /** Cooldown milliseconds between repair attempts per plugin. Defaults to 30s. */
  repairCooldownMs: number
  /** Audit log directory. Defaults to `$DSH_HOME/storages/plugin-guardian`. */
  auditDir: string
}

export const Config: z<Config> = z.object({
  watched: z.array(z.string()).default([]),
  repairCooldownMs: z.number().default(30_000),
  auditDir: z.string().default(''),
})

/** Our own plugin names (the ones this deployment develops and maintains). */
export const DEFAULT_WATCHED = [
  'ui-progressive-todo',
  'ui-context-compactor',
] as const

/**
 * Value mirror of cordis's `FiberState` const enum: a const enum has no
 * runtime object to import (and esbuild-based pipelines cannot inline it
 * across modules), so these values mirror the pinned vendored definition
 * while retaining its type (same rationale as dsh-client-web's mirror).
 */
export const FIBER_STATE = {
  PENDING: 0 as FiberState.PENDING,
  LOADING: 1 as FiberState.LOADING,
  ACTIVE: 2 as FiberState.ACTIVE,
  FAILED: 3 as FiberState.FAILED,
  DISPOSED: 4 as FiberState.DISPOSED,
  UNLOADING: 5 as FiberState.UNLOADING,
} as const

/** Fiber states the guardian treats as "down" and repairs. */
export const DOWN_STATES: readonly FiberState[] = [FIBER_STATE.FAILED, FIBER_STATE.DISPOSED]

/** One audit record. */
export interface GuardianAudit {
  time: string
  plugin: string
  event: 'detected-down' | 'repair-started' | 'repair-ok' | 'repair-failed' | 'cooldown-skip'
  oldState: string
  message?: string
}

/** Default audit root (under DSH_HOME). */
export function defaultAuditDir(): string {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'storages', 'plugin-guardian')
}

/** Append one JSONL audit record, best-effort (never throws into the loop). */
export function appendAudit(dir: string, record: GuardianAudit): void {
  try {
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'audit.jsonl'), `${JSON.stringify(record)}\n`, 'utf8')
  } catch {
    // Auditing is best-effort; a failed write must not break the watcher.
  }
}

/** Resolve the watched set: config override, else the shipped defaults. */
export function resolveWatched(config: Config): readonly string[] {
  return config.watched.length > 0 ? config.watched : DEFAULT_WATCHED
}

/** Whether the fiber's runtime name is in the watched set. */
export function isWatched(fiber: Fiber, watched: readonly string[]): boolean {
  const runtimeName = fiber.runtime?.name
  return runtimeName !== undefined && watched.includes(runtimeName)
}

/** Repair state per plugin name. */
interface RepairState {
  lastAttempt: number
  inFlight: boolean
}

/**
 * Mount the guardian: subscribe to fiber status transitions and repair our
 * own plugins when they fail.
 * @param ctx - host context (root; `internal/status` is a root event).
 * @param config - validated guardian configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const watched = resolveWatched(config)
  const auditDir = config.auditDir !== '' ? config.auditDir : defaultAuditDir()
  const cooldown = config.repairCooldownMs
  const repairs = new Map<string, RepairState>()

  ctx.on('internal/status', (fiber: Fiber, oldState: FiberState) => {
    if (!isWatched(fiber, watched)) return
    const state = fiber.state
    if (!DOWN_STATES.includes(state)) return
    const pluginName = fiber.runtime?.name
    if (pluginName === undefined) return
    appendAudit(auditDir, {
      time: new Date().toISOString(),
      plugin: pluginName,
      event: 'detected-down',
      oldState: String(oldState),
      message: `fiber entered ${String(state)}`,
    })

    const now = Date.now()
    const repair = repairs.get(pluginName)
    if (repair !== undefined && (now - repair.lastAttempt < cooldown || repair.inFlight)) {
      appendAudit(auditDir, {
        time: new Date().toISOString(),
        plugin: pluginName,
        event: 'cooldown-skip',
        oldState: String(oldState),
      })
      return
    }
    repairs.set(pluginName, { lastAttempt: now, inFlight: true })
    appendAudit(auditDir, {
      time: new Date().toISOString(),
      plugin: pluginName,
      event: 'repair-started',
      oldState: String(oldState),
    })

    void repairPlugin(ctx, fiber, pluginName, auditDir).finally(() => {
      const current = repairs.get(pluginName)
      if (current !== undefined) current.inFlight = false
    })
  })
}

/** Re-mount a failed plugin fiber using its original runtime shape. */
async function repairPlugin(ctx: Context, failed: Fiber, pluginName: string, auditDir: string): Promise<void> {
  const runtime = failed.runtime
  if (runtime === undefined || runtime === null || runtime.callback === undefined) {
    appendAudit(auditDir, {
      time: new Date().toISOString(),
      plugin: pluginName,
      event: 'repair-failed',
      oldState: String(failed.state),
      message: 'runtime missing; cannot re-mount',
    })
    return
  }
  const pluginShape: Plugin = {
    ...(runtime.name === undefined ? {} : { name: runtime.name }),
    apply: runtime.callback as Plugin.Function,
    inject: failed.inject ? Object.keys(failed.inject) : [],
    ...(runtime.Config === undefined ? {} : { Config: runtime.Config as never }),
  }
  try {
    const fiber = ctx.plugin(pluginShape, failed.config)
    await fiber
    appendAudit(auditDir, {
      time: new Date().toISOString(),
      plugin: pluginName,
      event: 'repair-ok',
      oldState: String(failed.state),
    })
    ctx.logger.info(`plugin-guardian: repaired ${pluginName} (re-mounted after ${String(failed.state)})`)
  } catch (error) {
    appendAudit(auditDir, {
      time: new Date().toISOString(),
      plugin: pluginName,
      event: 'repair-failed',
      oldState: String(failed.state),
      message: error instanceof Error ? error.message : String(error),
    })
    ctx.logger.error(`plugin-guardian: repair of ${pluginName} failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}
