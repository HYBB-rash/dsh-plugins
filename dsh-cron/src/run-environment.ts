/**
 * Generic per-run environment boundary for unattended Agent jobs.
 *
 * dsh-cron owns the registry and the lifecycle seam; a provider owns the
 * concrete prompt/tool setup.  This module deliberately has no knowledge of
 * any provider's business domain.
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  isValidPreparedDeliveryObject,
  type CronDeliveryReceipt,
  type CronRunFinishedEvent,
  type PreparedDeliveryObject,
  type RunTrigger,
} from './types.ts'

/** Public Cordis service name for the context-owned registry. */
export const CRON_AGENT_ENVIRONMENT_REGISTRY = 'cronAgentEnvironmentRegistry' as const
/** Scheduler-owned factory token; providers cannot resolve a current run from it. */
export const CRON_RUN_DELIVERY_MEANING_LIFECYCLE = 'cronRunDeliveryMeaningLifecycle' as const

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
  readonly runDeliveryMeaningPort?: CronRunDeliveryMeaningRunPort
}

/** Exact durable identity carried from one prepared claim into recovery. */
export interface CronPreparedDeliveryClaimBinding {
  readonly jobId: string
  readonly runId: string
  readonly sessionId: string
  readonly scheduledFor: string
  readonly claimedAt: string
  readonly trigger: RunTrigger
}

/** Generic scheduler facts accompanying a claim-only recovery request. */
export interface CronPreparedDeliveryRecoveryContext extends CronPreparedDeliveryClaimBinding {
  readonly jobKind: CronAgentEnvironmentJobKind
  readonly sessionMode: CronAgentEnvironmentSessionMode
  readonly gate: CronAgentEnvironmentGate
  readonly runDeliveryMeaningPort?: CronRunDeliveryMeaningRunPort
}

export interface CronRunDeliveryMeaningBindInput {
  readonly businessRunId: string
  readonly businessPeriodId: string
}

export interface CronRunDeliveryMeaningAcceptedReceipt {
  readonly status: 'accepted'
  readonly value: { readonly receipt: CronDeliveryReceipt }
}

export interface CronRunDeliveryMeaningRejectedReceipt {
  readonly status: 'rejected'
  readonly input: CronDeliveryReceipt
}

export interface CronRunDeliveryMeaningFailedReceipt {
  readonly status: 'failed'
  readonly input: CronDeliveryReceipt
}

export type CronRunDeliveryMeaningReceiptResult =
  | CronRunDeliveryMeaningAcceptedReceipt
  | CronRunDeliveryMeaningRejectedReceipt
  | CronRunDeliveryMeaningFailedReceipt

export interface CronRunDeliveryMeaningAccepted {
  readonly status: 'accepted'
}

export interface CronRunDeliveryMeaningRejected<Input> {
  readonly status: 'rejected'
  readonly input: Input
}

export interface CronRunDeliveryMeaningFailed<Input> {
  readonly status: 'failed'
  readonly input: Input
}

export type CronRunDeliveryMeaningBindResult =
  | CronRunDeliveryMeaningAccepted
  | CronRunDeliveryMeaningRejected<CronRunDeliveryMeaningBindInput>
  | CronRunDeliveryMeaningFailed<CronRunDeliveryMeaningBindInput>

export type CronRunDeliveryMeaningCommitResult =
  | CronRunDeliveryMeaningAccepted
  | CronRunDeliveryMeaningRejected<undefined>
  | CronRunDeliveryMeaningFailed<undefined>

export interface CronRunDeliveryMeaningRunPort {
  readonly bindPreparedDelivery: (
    input: CronRunDeliveryMeaningBindInput,
  ) => Promise<CronRunDeliveryMeaningBindResult>
  readonly acceptDurableReceipt: (
    receipt: CronDeliveryReceipt,
  ) => Promise<CronRunDeliveryMeaningReceiptResult>
  readonly commitBusinessFinalization: () => Promise<CronRunDeliveryMeaningCommitResult>
}

export interface CronRunDeliveryMeaningPortFactoryAccepted {
  readonly status: 'accepted'
  readonly port: CronRunDeliveryMeaningRunPort
  readonly dispose: () => void | Promise<void>
}

export interface CronRunDeliveryMeaningPortFactoryFailed {
  readonly status: 'failed'
  readonly error: string
}

export type CronRunDeliveryMeaningPortFactoryResult =
  | CronRunDeliveryMeaningPortFactoryAccepted
  | CronRunDeliveryMeaningPortFactoryFailed

export interface CronRunDeliveryMeaningPortFactory {
  readonly createRunPort: (
    claim: CronPreparedDeliveryClaimBinding,
  ) => Promise<CronRunDeliveryMeaningPortFactoryResult>
}

export interface CronAgentEnvironmentBindPreparedDeliveryContext {
  readonly preparedDelivery: PreparedDeliveryObject
  readonly runDeliveryMeaningPort: CronRunDeliveryMeaningRunPort
}

/** Project only the durable identity when returning a recovery result. */
export function toCronPreparedDeliveryClaimBinding(
  context: CronPreparedDeliveryRecoveryContext,
): CronPreparedDeliveryClaimBinding {
  return {
    jobId: context.jobId,
    runId: context.runId,
    sessionId: context.sessionId,
    scheduledFor: context.scheduledFor,
    claimedAt: context.claimedAt,
    trigger: context.trigger,
  }
}

export type CronPreparedDeliveryRecovery =
  | {
      readonly status: 'ready'
      readonly claim: CronPreparedDeliveryClaimBinding
      readonly preparedDelivery: PreparedDeliveryObject
    }
  | {
      readonly status: 'not-ready'
      readonly claim: CronPreparedDeliveryClaimBinding
    }
  | {
      readonly status: 'conflict'
      readonly claim: CronPreparedDeliveryClaimBinding
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

/** Technical receipt hook invoked before the generic cron finish event. */
export interface CronAgentEnvironmentPrefinishAccepted {
  readonly status: 'accepted'
}

export type CronAgentEnvironmentPrefinishSettle = (
  receipt: CronDeliveryReceipt,
) => CronAgentEnvironmentPrefinishAccepted | Promise<CronAgentEnvironmentPrefinishAccepted>

/** Recovery counterpart for a prepared object whose live lease was lost. */
export type CronAgentEnvironmentRecoveredDeliverySettle = (
  receipt: CronDeliveryReceipt,
  runDeliveryMeaningPort?: CronRunDeliveryMeaningRunPort,
) => CronAgentEnvironmentPrefinishAccepted | Promise<CronAgentEnvironmentPrefinishAccepted>

export type CronPreparedDeliveryRecoveryResult =
  | { readonly ok: true; readonly recovery: CronPreparedDeliveryRecovery }
  | { readonly ok: false; readonly error: CronAgentEnvironmentError }

export function isAcceptedPrefinishResult(value: unknown): value is CronAgentEnvironmentPrefinishAccepted {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && (value as Record<string, unknown>).status === 'accepted'
}

/** A provider-created per-run lease. The registry adds its resolved marker. */
interface CronAgentEnvironmentLeaseBase {
  /** Apply the exact provider setup to the newly-created Agent. */
  readonly setupAgent: CronAgentEnvironmentSetup
  /** Verify that the resulting Agent surface is exactly what the provider expects. */
  readonly verifySurface: CronAgentEnvironmentSetup
  /** Validate or transform the terminal outcome before any delivery is attempted. */
  readonly finalizeOutcome?: CronAgentEnvironmentFinalize
  /** Release all provider-owned per-run resources. */
  readonly dispose: () => void | Promise<void>
}

export type CronAgentEnvironmentLease =
  | (CronAgentEnvironmentLeaseBase & {
      readonly preparedDelivery: PreparedDeliveryObject
      readonly settleDeliveryBeforeFinish: CronAgentEnvironmentPrefinishSettle
      readonly settleRun?: never
    })
  | (CronAgentEnvironmentLeaseBase & {
      readonly preparedDelivery?: never
      readonly settleDeliveryBeforeFinish?: never
      /** Commit provider-owned state from the durable, final delivery receipt. */
      readonly settleRun?: CronAgentEnvironmentSettle
    })

/*
 * The union above is intentionally the public shape: prepared delivery and
 * its pre-finish hook are one opt-in, while legacy leases retain post-finish
 * settlement only.
 */
export type ResolvedCronAgentEnvironmentLease = CronAgentEnvironmentLease & {
  readonly marker: string
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

export interface CronAgentEnvironmentProvider {
  /** Stable persisted marker, e.g. `business/v1`; never inferred from a prompt. */
  readonly marker: string
  /** Generic job constraints checked before `prepare` is called. */
  readonly requirements: CronAgentEnvironmentRequirements
  /** Explicit provider-level opt-in for durable prepared delivery lifecycle. */
  readonly preparedDeliveryLifecycle?: boolean
  readonly runDeliveryMeaningLifecycle?: boolean
  /** Prepare a fresh lease for one claimed run. */
  readonly prepare: (context: CronAgentEnvironmentPrepareContext) => Promise<CronAgentEnvironmentPrepareValue>
  readonly bindPreparedDelivery?: (
    context: CronAgentEnvironmentBindPreparedDeliveryContext,
  ) => void | Promise<void>
  /** Idempotently settle a durable finish whose live lease was lost to a crash. */
  readonly settleRecoveredRun?: CronAgentEnvironmentSettle
  /** Replay a prepared object's receipt after restart, before generic finish. */
  readonly settleRecoveredDelivery?: CronAgentEnvironmentRecoveredDeliverySettle
  /** Continue one durable claim into its provider-owned prepared object. */
  readonly recoverPreparedDelivery?: (
    context: CronPreparedDeliveryRecoveryContext,
  ) => CronPreparedDeliveryRecovery | Promise<CronPreparedDeliveryRecovery>
}

export type CronAgentEnvironmentErrorCode =
  | 'missing_provider'
  | 'duplicate_provider'
  | 'requirements_mismatch'
  | 'prepare_failed'
  | 'surface_verification_failed'
  | 'settlement_failed'
  | 'recovery_failed'
  | 'binding_failed'

export interface CronAgentEnvironmentError {
  readonly code: CronAgentEnvironmentErrorCode
  readonly marker?: string
  readonly message: string
  readonly operation?: 'prepare' | 'setup' | 'verify' | 'settle' | 'bind'
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
  /** Invoke the provider's prepared-object binding hook without trusting its return value. */
  readonly bindPreparedDelivery: (
    marker: string | undefined,
    context: CronAgentEnvironmentBindPreparedDeliveryContext,
  ) => Promise<CronAgentEnvironmentOperationResult>
  /** Replay one unacknowledged durable finish through its provider. */
  readonly settleRecovered: (
    marker: string | undefined,
    event: CronRunFinishedEvent,
  ) => Promise<CronAgentEnvironmentOperationResult>
  readonly settleRecoveredDelivery: (
    marker: string | undefined,
    receipt: CronDeliveryReceipt,
    runDeliveryMeaningPort?: CronRunDeliveryMeaningRunPort,
  ) => Promise<CronAgentEnvironmentOperationResult>
  /** Recover one claim-only prepared run through its registered provider. */
  readonly recoverPreparedDelivery: (
    marker: string | undefined,
    context: CronPreparedDeliveryRecoveryContext,
  ) => Promise<CronPreparedDeliveryRecoveryResult>
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

const RECOVERY_CLAIM_KEYS = ['jobId', 'runId', 'sessionId', 'scheduledFor', 'claimedAt', 'trigger'] as const
const RECOVERY_CONTEXT_KEYS = [...RECOVERY_CLAIM_KEYS, 'jobKind', 'sessionMode', 'gate'] as const
const RECOVERY_CONTEXT_KEYS_WITH_PORT = [...RECOVERY_CONTEXT_KEYS, 'runDeliveryMeaningPort'] as const

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every(key => actual.includes(key))
}

function isValidClaimBinding(value: unknown): value is CronPreparedDeliveryClaimBinding {
  if (!isExactRecord(value, RECOVERY_CLAIM_KEYS)) return false
  return hasValidClaimBindingValues(value)
}

function hasValidClaimBindingValues(value: Record<string, unknown>): boolean {
  return typeof value.jobId === 'string'
    && value.jobId.trim() !== ''
    && typeof value.runId === 'string'
    && value.runId.trim() !== ''
    && typeof value.sessionId === 'string'
    && value.sessionId.trim() !== ''
    && typeof value.scheduledFor === 'string'
    && !Number.isNaN(Date.parse(value.scheduledFor))
    && typeof value.claimedAt === 'string'
    && !Number.isNaN(Date.parse(value.claimedAt))
    && (value.trigger === 'scheduled' || value.trigger === 'manual')
}

function isValidRecoveryContext(value: unknown): value is CronPreparedDeliveryRecoveryContext {
  if ((!isExactRecord(value, RECOVERY_CONTEXT_KEYS) && !isExactRecord(value, RECOVERY_CONTEXT_KEYS_WITH_PORT))
    || !hasValidClaimBindingValues(value)) return false
  if (Object.prototype.hasOwnProperty.call(value, 'runDeliveryMeaningPort')) {
    const port = value.runDeliveryMeaningPort
    if (typeof port !== 'object' || port === null || Array.isArray(port)) return false
    if (!isExactRecord(port, ['bindPreparedDelivery', 'acceptDurableReceipt', 'commitBusinessFinalization'])) return false
    if (typeof port.bindPreparedDelivery !== 'function'
      || typeof port.acceptDurableReceipt !== 'function'
      || typeof port.commitBusinessFinalization !== 'function') return false
  }
  return (value.jobKind === 'agent' || value.jobKind === 'command')
    && (value.sessionMode === 'persistent' || value.sessionMode === 'per_run')
    && (value.gate === 'forbidden' || value.gate === 'present')
}

function sameClaimBinding(
  left: CronPreparedDeliveryClaimBinding,
  right: CronPreparedDeliveryClaimBinding,
): boolean {
  return left.jobId === right.jobId
    && left.runId === right.runId
    && left.sessionId === right.sessionId
    && left.scheduledFor === right.scheduledFor
    && left.claimedAt === right.claimedAt
    && left.trigger === right.trigger
}

function validateRecovery(
  value: unknown,
  context: CronPreparedDeliveryRecoveryContext,
): CronPreparedDeliveryRecovery | undefined {
  if (!isExactRecord(value, ['status', 'claim', ...(value && typeof value === 'object' && 'status' in value && (value as { status?: unknown }).status === 'ready' ? ['preparedDelivery'] : [])])) return undefined
  if (!isValidClaimBinding(value.claim) || !sameClaimBinding(value.claim, context)) return undefined
  if (value.status === 'ready') {
    if (!isExactRecord(value, ['status', 'claim', 'preparedDelivery'])
      || !isExactRecord(value.preparedDelivery, ['objectId', 'text'])
      || !isValidPreparedDeliveryObject(value.preparedDelivery)) return undefined
    return {
      status: 'ready',
      claim: value.claim,
      preparedDelivery: value.preparedDelivery,
    }
  }
  if (value.status === 'not-ready' && isExactRecord(value, ['status', 'claim'])) {
    return { status: 'not-ready', claim: value.claim }
  }
  if (value.status === 'conflict' && isExactRecord(value, ['status', 'claim'])) {
    return { status: 'conflict', claim: value.claim }
  }
  return undefined
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

function isValidRunDeliveryMeaningPort(value: unknown): value is CronRunDeliveryMeaningRunPort {
  return isRecord(value)
    && !Array.isArray(value)
    && isExactRecord(value, ['bindPreparedDelivery', 'acceptDurableReceipt', 'commitBusinessFinalization'])
    && typeof value.bindPreparedDelivery === 'function'
    && typeof value.acceptDurableReceipt === 'function'
    && typeof value.commitBusinessFinalization === 'function'
}

function isValidBindPreparedDeliveryContext(
  value: unknown,
): value is CronAgentEnvironmentBindPreparedDeliveryContext {
  return isRecord(value)
    && !Array.isArray(value)
    && isExactRecord(value, ['preparedDelivery', 'runDeliveryMeaningPort'])
    && isValidPreparedDeliveryObject(value.preparedDelivery)
    && isValidRunDeliveryMeaningPort(value.runDeliveryMeaningPort)
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

  const bindPreparedDelivery = async (
    marker: string | undefined,
    context: CronAgentEnvironmentBindPreparedDeliveryContext,
  ): Promise<CronAgentEnvironmentOperationResult> => {
    const resolved = resolve(marker)
    if (!resolved.ok) return resolved
    if (!isValidBindPreparedDeliveryContext(context)) {
      return {
        ok: false,
        error: error('binding_failed', resolved.provider.marker, 'prepared delivery binding context is invalid', 'bind'),
      }
    }
    const bind = resolved.provider.bindPreparedDelivery
    if (bind === undefined) {
      return {
        ok: false,
        error: error('binding_failed', resolved.provider.marker, 'prepared delivery binding hook is unavailable', 'bind'),
      }
    }
    try {
      await bind(context)
      return { ok: true }
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause)
      return {
        ok: false,
        error: error('binding_failed', resolved.provider.marker, `prepared delivery binding failed: ${detail}`, 'bind'),
      }
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

  const settleRecoveredDelivery = async (
    marker: string | undefined,
    receipt: CronDeliveryReceipt,
    runDeliveryMeaningPort?: CronRunDeliveryMeaningRunPort,
  ): Promise<CronAgentEnvironmentOperationResult> => {
    const resolved = resolve(marker)
    if (!resolved.ok) return resolved
    if (resolved.provider.settleRecoveredDelivery === undefined) {
      return {
        ok: false,
        error: error('settlement_failed', resolved.provider.marker, 'prepared delivery recovery hook is unavailable', 'settle'),
      }
    }
    try {
      const result = await resolved.provider.settleRecoveredDelivery(receipt, runDeliveryMeaningPort)
      if (!isAcceptedPrefinishResult(result)) {
        return {
          ok: false,
          error: error('settlement_failed', resolved.provider.marker, 'prepared delivery recovery hook did not return accepted', 'settle'),
        }
      }
      return { ok: true }
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause)
      return {
        ok: false,
        error: error('settlement_failed', resolved.provider.marker, `prepared delivery settlement failed: ${detail}`, 'settle'),
      }
    }
  }

  const recoverPreparedDelivery = async (
    marker: string | undefined,
    context: CronPreparedDeliveryRecoveryContext,
  ): Promise<CronPreparedDeliveryRecoveryResult> => {
    const resolved = resolve(marker)
    if (!resolved.ok) return resolved
    if (!isValidRecoveryContext(context)) {
      return {
        ok: false,
        error: error('recovery_failed', resolved.provider.marker, 'prepared delivery recovery context is invalid'),
      }
    }
    if (resolved.provider.preparedDeliveryLifecycle !== true
      || !matchesRequirements(resolved.provider.requirements, context)) {
      return {
        ok: false,
        error: error('recovery_failed', resolved.provider.marker, 'prepared delivery recovery requirements do not match'),
      }
    }
    const recover = resolved.provider.recoverPreparedDelivery
    if (recover === undefined) {
      return {
        ok: false,
        error: error('recovery_failed', resolved.provider.marker, 'prepared delivery recovery port is unavailable'),
      }
    }
    try {
      const recovery = validateRecovery(await recover(context), context)
      if (recovery === undefined) {
        return {
          ok: false,
          error: error('recovery_failed', resolved.provider.marker, 'prepared delivery recovery result is invalid'),
        }
      }
      return { ok: true, recovery }
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause)
      return {
        ok: false,
        error: error('recovery_failed', resolved.provider.marker, `prepared delivery recovery failed: ${detail}`),
      }
    }
  }

  return {
    register,
    resolve,
    prepare,
    setup,
    verify,
    bindPreparedDelivery,
    settleRecovered,
    settleRecoveredDelivery,
    recoverPreparedDelivery,
  }
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
