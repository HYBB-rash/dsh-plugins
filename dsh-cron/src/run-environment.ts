/**
 * Generic per-run environment boundary for unattended Agent jobs.
 *
 * dsh-cron owns the registry and the lifecycle seam; a provider owns the
 * concrete prompt/tool setup.  This module deliberately has no knowledge of
 * any provider's business domain.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CronRunFinishedEvent, RunTrigger } from './types.ts'

/** Public Cordis service name for the context-owned registry. */
export const CRON_AGENT_ENVIRONMENT_REGISTRY = 'cronAgentEnvironmentRegistry' as const

export type CronAgentEnvironmentJobKind = 'agent' | 'command'
export type CronAgentEnvironmentSessionMode = 'persistent' | 'per_run'
export type CronAgentEnvironmentGate = 'forbidden' | 'present'

/** The execution facts a provider may constrain. Omitted fields are unconstrained. */
export interface CronAgentEnvironmentRequirements {
  readonly jobKind?: CronAgentEnvironmentJobKind
  readonly sessionMode?: CronAgentEnvironmentSessionMode
  readonly gate?: CronAgentEnvironmentGate
}

/** Generic facts available before an Agent or command is started. */
export interface CronAgentEnvironmentPrepareContext {
  /** Exact persisted cron job id; providers must not infer it from a marker. */
  readonly jobId: string
  readonly jobKind: CronAgentEnvironmentJobKind
  readonly sessionMode: CronAgentEnvironmentSessionMode
  readonly gate: CronAgentEnvironmentGate
  readonly runId: string
  /** Trigger facts copied from the durable claim that admitted this run. */
  readonly trigger: RunTrigger
  readonly scheduledFor: string
  readonly claimedAt: string
}

export type CronAgentEnvironmentSetup = (agent: unknown) => void | Promise<void>

/**
 * The bounded result that a provider may validate before cron delivers it.
 * This deliberately mirrors only the generic terminal shape; dsh-cron does
 * not know which provider owns the validation rules.
 */
export interface CronAgentEnvironmentOutcome {
  readonly text: string
  readonly error: string | undefined
}

export type CronAgentEnvironmentFinalize = (
  outcome: CronAgentEnvironmentOutcome,
) => void | CronAgentEnvironmentOutcome | Promise<void | CronAgentEnvironmentOutcome>

/**
 * Optional per-run terminal hook. The scheduler calls it only after the
 * terminal finish record is durable and Telegram delivery is final. Hook
 * failure is observable but can never rewrite the run or re-send Telegram.
 */
export type CronAgentEnvironmentSettle = (
  event: CronRunFinishedEvent,
) => void | Promise<void>

/** A provider-created per-run lease. The registry adds its resolved marker. */
export interface CronAgentEnvironmentLease {
  /** Apply the exact provider setup to the newly-created Agent. */
  readonly setupAgent: CronAgentEnvironmentSetup
  /** Verify that the resulting Agent surface is exactly what the provider expects. */
  readonly verifySurface: CronAgentEnvironmentSetup
  /** Validate or transform the terminal outcome before any delivery is attempted. */
  readonly finalizeOutcome?: CronAgentEnvironmentFinalize
  /** Commit provider-owned state from the durable, final delivery receipt. */
  readonly settleRun?: CronAgentEnvironmentSettle
  /** Release all provider-owned per-run resources. */
  readonly dispose: () => void | Promise<void>
}

/** A provider may complete a claimed run without creating an Agent. */
export interface CronAgentEnvironmentSkip {
  readonly kind: 'skip'
  readonly outcome: {
    readonly text: undefined
    readonly error: undefined
  }
}

export type CronAgentEnvironmentPrepareValue = CronAgentEnvironmentLease | CronAgentEnvironmentSkip

/** The lease returned to the scheduler after successful provider preparation. */
export interface ResolvedCronAgentEnvironmentLease extends CronAgentEnvironmentLease {
  readonly marker: string
}

export interface CronAgentEnvironmentProvider {
  /** Stable persisted marker, e.g. `x-feed/v1`; never inferred from a prompt. */
  readonly marker: string
  /** Generic job constraints checked before `prepare` is called. */
  readonly requirements: CronAgentEnvironmentRequirements
  /** Prepare a fresh lease for one claimed run. */
  readonly prepare: (context: CronAgentEnvironmentPrepareContext) => Promise<CronAgentEnvironmentPrepareValue>
  /** Idempotently settle a durable finish whose live lease was lost to a crash. */
  readonly settleRecoveredRun?: CronAgentEnvironmentSettle
}

export type CronAgentEnvironmentErrorCode =
  | 'missing_provider'
  | 'duplicate_provider'
  | 'requirements_mismatch'
  | 'prepare_failed'
  | 'surface_verification_failed'
  | 'settlement_failed'

export interface CronAgentEnvironmentError {
  readonly code: CronAgentEnvironmentErrorCode
  readonly marker?: string
  readonly message: string
  readonly operation?: 'prepare' | 'setup' | 'verify' | 'settle'
}

export type CronAgentEnvironmentResolution =
  | { readonly ok: true; readonly provider: CronAgentEnvironmentProvider }
  | { readonly ok: false; readonly error: CronAgentEnvironmentError }

export type CronAgentEnvironmentPrepareResult =
  | { readonly ok: true; readonly lease: ResolvedCronAgentEnvironmentLease }
  | { readonly ok: true; readonly skip: CronAgentEnvironmentSkip }
  | { readonly ok: false; readonly error: CronAgentEnvironmentError }

export type CronAgentEnvironmentOperationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: CronAgentEnvironmentError }

export interface CronAgentEnvironmentRegistry {
  /** Add a provider and return an idempotent disposer for this registration. */
  readonly register: (provider: CronAgentEnvironmentProvider) => () => void
  /** Resolve a marker without a default-provider fallback. */
  readonly resolve: (marker: string | undefined) => CronAgentEnvironmentResolution
  /** Resolve, validate requirements, then prepare one provider lease. */
  readonly prepare: (
    marker: string | undefined,
    context: CronAgentEnvironmentPrepareContext,
  ) => Promise<CronAgentEnvironmentPrepareResult>
  /** Run the exact Agent setup through the lease seam. */
  readonly setup: (lease: ResolvedCronAgentEnvironmentLease, agent: unknown) => Promise<CronAgentEnvironmentOperationResult>
  /** Verify the exact Agent surface through the lease seam. */
  readonly verify: (lease: ResolvedCronAgentEnvironmentLease, agent: unknown) => Promise<CronAgentEnvironmentOperationResult>
  /** Replay one unacknowledged durable finish through its provider. */
  readonly settleRecovered: (
    marker: string | undefined,
    event: CronRunFinishedEvent,
  ) => Promise<CronAgentEnvironmentOperationResult>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    readonly cronAgentEnvironmentRegistry: CronAgentEnvironmentRegistry
  }
}

function error(
  code: CronAgentEnvironmentErrorCode,
  marker: string | undefined,
  message: string,
  operation?: CronAgentEnvironmentError['operation'],
): CronAgentEnvironmentError {
  return {
    code,
    ...(marker === undefined ? {} : { marker }),
    message,
    ...(operation === undefined ? {} : { operation }),
  }
}

function matchesRequirements(
  requirements: CronAgentEnvironmentRequirements,
  context: CronAgentEnvironmentPrepareContext,
): boolean {
  return (requirements.jobKind === undefined || requirements.jobKind === context.jobKind)
    && (requirements.sessionMode === undefined || requirements.sessionMode === context.sessionMode)
    && (requirements.gate === undefined || requirements.gate === context.gate)
}

function operationFailure(
  marker: string,
  operation: 'setup' | 'verify',
  cause: unknown,
): CronAgentEnvironmentOperationResult {
  const detail = cause instanceof Error ? cause.message : String(cause)
  return {
    ok: false,
    error: error(
      'surface_verification_failed',
      marker,
      `run environment ${operation} failed: ${detail}`,
      operation,
    ),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key))
}

function isValidSkip(value: unknown): value is CronAgentEnvironmentSkip {
  if (!isRecord(value) || Array.isArray(value) || !hasExactKeys(value, ['kind', 'outcome'])) return false
  if (!isRecord(value.outcome) || Array.isArray(value.outcome) || !hasExactKeys(value.outcome, ['text', 'error'])) return false
  if (value.kind !== 'skip') return false
  return value.outcome.text === undefined && value.outcome.error === undefined
}

/** Create a generic provider registry. No provider is installed implicitly. */
export function createCronAgentEnvironmentRegistry(
  initialProviders: readonly CronAgentEnvironmentProvider[] = [],
): CronAgentEnvironmentRegistry {
  const providers = new Map<string, CronAgentEnvironmentProvider[]>()

  const register = (provider: CronAgentEnvironmentProvider): (() => void) => {
    const existing = providers.get(provider.marker)
    if (existing === undefined) {
      providers.set(provider.marker, [provider])
    } else {
      existing.push(provider)
    }
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      const current = providers.get(provider.marker)
      if (current === undefined) return
      const index = current.indexOf(provider)
      if (index >= 0) current.splice(index, 1)
      if (current.length === 0) providers.delete(provider.marker)
    }
  }

  for (const provider of initialProviders) register(provider)

  const resolve = (marker: string | undefined): CronAgentEnvironmentResolution => {
    if (marker === undefined || marker.trim() === '') {
      return {
        ok: false,
        error: error('missing_provider', marker, 'an agent environment marker is required'),
      }
    }
    const matches = providers.get(marker)
    if (matches === undefined || matches.length === 0) {
      return {
        ok: false,
        error: error('missing_provider', marker, `no agent environment provider is registered for ${marker}`),
      }
    }
    if (matches.length !== 1) {
      return {
        ok: false,
        error: error('duplicate_provider', marker, `multiple agent environment providers are registered for ${marker}`),
      }
    }
    const [provider] = matches
    if (provider === undefined) {
      return {
        ok: false,
        error: error('missing_provider', marker, `no agent environment provider is registered for ${marker}`),
      }
    }
    return { ok: true, provider }
  }

  const prepare = async (
    marker: string | undefined,
    context: CronAgentEnvironmentPrepareContext,
  ): Promise<CronAgentEnvironmentPrepareResult> => {
    const resolved = resolve(marker)
    if (!resolved.ok) return resolved
    if (!matchesRequirements(resolved.provider.requirements, context)) {
      return {
        ok: false,
        error: error(
          'requirements_mismatch',
          resolved.provider.marker,
          `agent environment requirements do not match run ${context.runId}`,
        ),
      }
    }
    try {
      const prepared = await resolved.provider.prepare(context)
      if (isRecord(prepared) && prepared.kind === 'skip') {
        if (!isValidSkip(prepared)) {
          throw new Error('run environment prepare returned an invalid skip result')
        }
        return { ok: true, skip: prepared }
      }
      return {
        ok: true,
        lease: {
          marker: resolved.provider.marker,
          ...(prepared as CronAgentEnvironmentLease),
        },
      }
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause)
      return {
        ok: false,
        error: error(
          'prepare_failed',
          resolved.provider.marker,
          `run environment prepare failed: ${detail}`,
          'prepare',
        ),
      }
    }
  }

  const setup = async (
    lease: ResolvedCronAgentEnvironmentLease,
    agent: unknown,
  ): Promise<CronAgentEnvironmentOperationResult> => {
    try {
      await lease.setupAgent(agent)
      return { ok: true }
    } catch (cause) {
      return operationFailure(lease.marker, 'setup', cause)
    }
  }

  const verify = async (
    lease: ResolvedCronAgentEnvironmentLease,
    agent: unknown,
  ): Promise<CronAgentEnvironmentOperationResult> => {
    try {
      await lease.verifySurface(agent)
      return { ok: true }
    } catch (cause) {
      return operationFailure(lease.marker, 'verify', cause)
    }
  }

  const settleRecovered = async (
    marker: string | undefined,
    event: CronRunFinishedEvent,
  ): Promise<CronAgentEnvironmentOperationResult> => {
    const resolved = resolve(marker)
    if (!resolved.ok) return resolved
    if (resolved.provider.settleRecoveredRun === undefined) return { ok: true }
    try {
      await resolved.provider.settleRecoveredRun(event)
      return { ok: true }
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause)
      return {
        ok: false,
        error: error(
          'settlement_failed',
          resolved.provider.marker,
          `run environment settlement failed: ${detail}`,
          'settle',
        ),
      }
    }
  }

  return { register, resolve, prepare, setup, verify, settleRecovered }
}

/**
 * Provide a registry in the current Cordis fiber. Cordis owns its lifetime;
 * there is intentionally no process-global registry or hidden fallback.
 */
export function provideCronAgentEnvironmentRegistry(
  ctx: Context,
  initialProviders: readonly CronAgentEnvironmentProvider[] = [],
): CronAgentEnvironmentRegistry {
  const registry = createCronAgentEnvironmentRegistry(initialProviders)
  ctx.provide(CRON_AGENT_ENVIRONMENT_REGISTRY, registry)
  return registry
}
