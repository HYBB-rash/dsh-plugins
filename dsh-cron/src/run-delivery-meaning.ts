import type { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { JsonlStore, RunLedger } from './store.ts'
import {
  isValidPreparedObjectId,
  type CronDeliveryReceipt,
  type RunPreparedDeliveryRecord,
} from './types.ts'
import {
  registerDurableBusinessFinalizationInspector,
  registerPreparedDeliveryBindingInspector,
} from './run-delivery-meaning-inspector.ts'
import type {
  CronPreparedDeliveryClaimBinding,
  CronRunDeliveryMeaningPortFactory,
  CronRunDeliveryMeaningRunPort,
} from './run-environment.ts'
import { CRON_RUN_DELIVERY_MEANING_LIFECYCLE } from './run-environment.ts'
import type { PreparedDeliveryObject, RunClaimRecord, RunDeliveryReceiptRecord, RunTrigger } from './types.ts'

const CLAIM_KEYS = ['jobId', 'runId', 'sessionId', 'scheduledFor', 'claimedAt', 'trigger'] as const
const LINEAGE_OWNER_KEYS = ['schemaVersion', 'event', 'claim', 'runLineage'] as const
const PRIMARY_OWNER_KEYS = ['schemaVersion', 'event', 'claim', 'objectId', 'businessRunId', 'businessPeriodId', 'objectClass', 'runLineage'] as const
const MEANING_OWNER_KEYS = ['schemaVersion', 'event', 'claim', 'objectId', 'businessRunId', 'businessPeriodId', 'receiptDigest'] as const
const FINALIZATION_OWNER_KEYS = ['schemaVersion', 'event', 'claim', 'objectId', 'businessRunId', 'businessPeriodId'] as const
const PRIMARY_INPUT_KEYS = ['claim', 'objectId', 'businessRunId', 'businessPeriodId'] as const
const FINALIZATION_INPUT_KEYS = ['binding'] as const
const BIND_INPUT_KEYS = ['businessRunId', 'businessPeriodId'] as const
const OWNER_EVENT = 'external-first-lineage' as const
const PRIMARY_OWNER_EVENT = 'primary-run-content-object' as const
const OWNER_LINEAGE = 'external_first' as const
const PRIMARY_OBJECT_CLASS = 'primary_run_content' as const
const MEANING_OWNER_EVENT = 'run-delivery-meaning' as const
const FINALIZATION_OWNER_EVENT = 'primary-run-content-business-finalization' as const
const RECEIPT_STATES = ['delivered', 'failed', 'uncertain'] as const
const MAX_OWNER_RECORD_BYTES = 16 * 1024
const RECEIPT_DIGEST_PATTERN = /^[0-9a-f]{64}$/


type LineageOwnerRecord = {
  readonly schemaVersion: 1
  readonly event: typeof OWNER_EVENT
  readonly claim: CronPreparedDeliveryClaimBinding
  readonly runLineage: typeof OWNER_LINEAGE
}

type PrimaryOwnerRecord = {
  readonly schemaVersion: 1
  readonly event: typeof PRIMARY_OWNER_EVENT
  readonly claim: CronPreparedDeliveryClaimBinding
  readonly objectId: string
  readonly businessRunId: string
  readonly businessPeriodId: string
  readonly objectClass: typeof PRIMARY_OBJECT_CLASS
  readonly runLineage: typeof OWNER_LINEAGE
}

type MeaningOwnerRecord = {
  readonly schemaVersion: 1
  readonly event: typeof MEANING_OWNER_EVENT
  readonly claim: CronPreparedDeliveryClaimBinding
  readonly objectId: string
  readonly businessRunId: string
  readonly businessPeriodId: string
  readonly receiptDigest: string
}

type FinalizationOwnerRecord = {
  readonly schemaVersion: 1
  readonly event: typeof FINALIZATION_OWNER_EVENT
  readonly claim: CronPreparedDeliveryClaimBinding
  readonly objectId: string
  readonly businessRunId: string
  readonly businessPeriodId: string
}

type OwnerRecord = LineageOwnerRecord | PrimaryOwnerRecord | MeaningOwnerRecord | FinalizationOwnerRecord

function isLineageOwnerRecord(record: OwnerRecord): record is LineageOwnerRecord {
  return record.event === OWNER_EVENT
}

function isPrimaryOwnerRecord(record: OwnerRecord): record is PrimaryOwnerRecord {
  return record.event === PRIMARY_OWNER_EVENT
}

function isMeaningOwnerRecord(record: OwnerRecord): record is MeaningOwnerRecord {
  return record.event === MEANING_OWNER_EVENT
}

function isFinalizationOwnerRecord(record: OwnerRecord): record is FinalizationOwnerRecord {
  return record.event === FINALIZATION_OWNER_EVENT
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...expectedKeys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): boolean {
  const allowed = new Set([...requiredKeys, ...optionalKeys])
  return requiredKeys.every(key => Object.prototype.hasOwnProperty.call(value, key))
    && Object.keys(value).every(key => allowed.has(key))
}

function isNonBlankString(value: unknown, maxBytes = 1_024): value is string {
  return typeof value === 'string'
    && value !== ''
    && value === value.trim()
    && new TextEncoder().encode(value).byteLength <= maxBytes
}

function isValidTime(value: unknown): value is string {
  return isNonBlankString(value) && Number.isFinite(Date.parse(value))
}

function isValidTrigger(value: unknown): value is RunTrigger {
  return value === 'scheduled' || value === 'manual'
}

const RECEIPT_REQUIRED_KEYS = ['objectId', 'jobId', 'runId', 'sessionId', 'scheduledFor', 'deliveryState'] as const
const RECEIPT_OPTIONAL_KEYS = ['deliveredAt', 'deliveryError'] as const

function isCronDeliveryReceipt(value: unknown): value is CronDeliveryReceipt {
  if (!isRecord(value) || !hasOnlyKeys(value, RECEIPT_REQUIRED_KEYS, RECEIPT_OPTIONAL_KEYS)) return false
  if (!isValidPreparedObjectId(value.objectId)
    || !isNonBlankString(value.jobId)
    || !isNonBlankString(value.runId)
    || !isNonBlankString(value.sessionId)
    || !isValidTime(value.scheduledFor)
    || !RECEIPT_STATES.includes(value.deliveryState as typeof RECEIPT_STATES[number])) return false
  if (value.deliveredAt !== undefined && !isValidTime(value.deliveredAt)) return false
  if (value.deliveryError !== undefined && typeof value.deliveryError !== 'string') return false
  return true
}

function sameReceipt(left: CronDeliveryReceipt, right: CronDeliveryReceipt): boolean {
  return left.objectId === right.objectId
    && left.jobId === right.jobId
    && left.runId === right.runId
    && left.sessionId === right.sessionId
    && left.scheduledFor === right.scheduledFor
    && left.deliveryState === right.deliveryState
    && left.deliveredAt === right.deliveredAt
    && left.deliveryError === right.deliveryError
}

function isClaimBinding(value: unknown): value is CronPreparedDeliveryClaimBinding {
  if (!isRecord(value) || !hasExactKeys(value, CLAIM_KEYS)) return false
  return isNonBlankString(value.jobId)
    && isNonBlankString(value.runId)
    && isNonBlankString(value.sessionId)
    && isValidTime(value.scheduledFor)
    && isValidTime(value.claimedAt)
    && isValidTrigger(value.trigger)
}

function isPrimaryInput(value: unknown): value is CronPrimaryRunContentObjectInput {
  if (!isRecord(value) || !hasExactKeys(value, PRIMARY_INPUT_KEYS)) return false
  return isClaimBinding(value.claim)
    && isValidPreparedObjectId(value.objectId)
    && isNonBlankString(value.businessRunId)
    && isNonBlankString(value.businessPeriodId)
}

function isPrimaryBinding(value: unknown): value is PrimaryRunContentBinding {
  if (!isRecord(value) || !hasExactKeys(value, [...PRIMARY_INPUT_KEYS, 'objectClass', 'runLineage'])) return false
  return isPrimaryInput({
    claim: value.claim,
    objectId: value.objectId,
    businessRunId: value.businessRunId,
    businessPeriodId: value.businessPeriodId,
  })
    && value.objectClass === PRIMARY_OBJECT_CLASS
    && value.runLineage === OWNER_LINEAGE
}

function isFinalizationInput(value: unknown): value is CronPrimaryRunContentBusinessFinalizationInput {
  return isRecord(value) && hasExactKeys(value, FINALIZATION_INPUT_KEYS) && isPrimaryBinding(value.binding)
}

function sameClaim(left: CronPreparedDeliveryClaimBinding, right: CronPreparedDeliveryClaimBinding): boolean {
  return left.jobId === right.jobId
    && left.runId === right.runId
    && left.sessionId === right.sessionId
    && left.scheduledFor === right.scheduledFor
    && left.claimedAt === right.claimedAt
    && left.trigger === right.trigger
}

function preparedMatches(
  prepared: RunPreparedDeliveryRecord | undefined,
  input: CronPrimaryRunContentObjectInput,
): boolean {
  return prepared !== undefined
    && prepared.jobId === input.claim.jobId
    && prepared.runId === input.claim.runId
    && prepared.objectId === input.objectId
    && prepared.sessionId === input.claim.sessionId
    && prepared.scheduledFor === input.claim.scheduledFor
}

function claimBinding(claim: RunClaimRecord): CronPreparedDeliveryClaimBinding | undefined {
  if (!isValidTrigger(claim.trigger)) return undefined
  const binding: CronPreparedDeliveryClaimBinding = {
    jobId: claim.jobId,
    runId: claim.runId,
    sessionId: claim.sessionId,
    scheduledFor: claim.scheduledFor,
    claimedAt: claim.claimedAt,
    trigger: claim.trigger,
  }
  return isClaimBinding(binding) ? binding : undefined
}

function parseOwnerRecord(raw: string): OwnerRecord | undefined {
  if (raw.trim() === '' || new TextEncoder().encode(raw).byteLength > MAX_OWNER_RECORD_BYTES) return undefined
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!isRecord(value) || value.schemaVersion !== 1 || !isClaimBinding(value.claim)) return undefined
  if (value.event === OWNER_EVENT) {
    if (!hasExactKeys(value, LINEAGE_OWNER_KEYS) || value.runLineage !== OWNER_LINEAGE) return undefined
    return value as unknown as LineageOwnerRecord
  }
  if (value.event === PRIMARY_OWNER_EVENT) {
    if (!hasExactKeys(value, PRIMARY_OWNER_KEYS)
      || value.objectClass !== PRIMARY_OBJECT_CLASS
      || value.runLineage !== OWNER_LINEAGE
      || !isValidPreparedObjectId(value.objectId)
      || !isNonBlankString(value.businessRunId)
      || !isNonBlankString(value.businessPeriodId)) return undefined
    return value as unknown as PrimaryOwnerRecord
  }
  if (value.event === MEANING_OWNER_EVENT) {
    if (!hasExactKeys(value, MEANING_OWNER_KEYS)
      || !isValidPreparedObjectId(value.objectId)
      || !isNonBlankString(value.businessRunId)
      || !isNonBlankString(value.businessPeriodId)
      || typeof value.receiptDigest !== 'string'
      || !RECEIPT_DIGEST_PATTERN.test(value.receiptDigest)) return undefined
    return value as unknown as MeaningOwnerRecord
  }
  if (value.event === FINALIZATION_OWNER_EVENT) {
    if (!hasExactKeys(value, FINALIZATION_OWNER_KEYS)
      || !isValidPreparedObjectId(value.objectId)
      || !isNonBlankString(value.businessRunId)
      || !isNonBlankString(value.businessPeriodId)) return undefined
    return value as unknown as FinalizationOwnerRecord
  }
  return undefined
}

function readOwnerRecords(store: JsonlStore): OwnerRecord[] | undefined {
  const records: OwnerRecord[] = []
  for (const raw of store.readLines()) {
    if (raw.trim() === '') continue
    const record = parseOwnerRecord(raw)
    if (record === undefined) return undefined
    records.push(record)
  }
  return records
}

function readOwnerRecordsSafely(store: JsonlStore): OwnerRecord[] | undefined {
  try {
    return readOwnerRecords(store)
  } catch {
    return undefined
  }
}

type DurableReceiptEvidence = {
  readonly record: RunDeliveryReceiptRecord
  readonly raw: string
  readonly digest: string
}

function cronReceiptFromRecord(record: RunDeliveryReceiptRecord): CronDeliveryReceipt {
  const { schemaVersion: _schemaVersion, event: _event, receiptAt: _receiptAt, ...receipt } = record
  return receipt
}

function readDurableReceiptEvidence(
  storeDir: string,
  jobId: string,
  runId: string,
  foldedReceipt: RunDeliveryReceiptRecord | undefined,
): DurableReceiptEvidence | undefined {
  if (foldedReceipt === undefined) return undefined
  let lines: string[]
  try {
    lines = new JsonlStore(join(storeDir, 'runs.jsonl')).readLines()
  } catch {
    return undefined
  }
  const candidates = lines.filter(raw => {
    if (raw.trim() === '') return false
    try {
      const value = JSON.parse(raw) as unknown
      return isRecord(value) && value.event === 'delivery-receipt' && value.jobId === jobId && value.runId === runId
    } catch {
      return false
    }
  })
  if (candidates.length !== 1) return undefined
  const raw = candidates[0]
  if (raw === undefined) return undefined
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['schemaVersion', 'event', 'receiptAt', ...RECEIPT_REQUIRED_KEYS], RECEIPT_OPTIONAL_KEYS)
    || value.schemaVersion !== 2
    || value.event !== 'delivery-receipt'
    || !isValidTime(value.receiptAt)) return undefined
  const { schemaVersion: _schemaVersion, event: _event, receiptAt: _receiptAt, ...receipt } = value
  if (!isCronDeliveryReceipt(receipt) || !sameReceipt(receipt, foldedReceipt)) return undefined
  return {
    record: value as unknown as RunDeliveryReceiptRecord,
    raw,
    digest: createHash('sha256').update(raw).digest('hex'),
  }
}

/**
 * Internal scheduler-owned run-port factory.
 *
 * The factory owns the run-scoped port boundary. A, B, receipt meaning, and
 * finalization are delegated to the lifecycle owner; the port only projects
 * their deliberately narrow public results.
 */
export function createCronRunDeliveryMeaningPortFactory(
  config: { readonly storeDir: string },
): CronRunDeliveryMeaningPortFactory {
  type ActiveRunPortLease = {
    readonly claim: CronPreparedDeliveryClaimBinding
    readonly port: CronRunDeliveryMeaningRunPort
    readonly dispose: () => Promise<void>
  }
  const activeLeases: ActiveRunPortLease[] = []

  const createRunPort = async (claim: CronPreparedDeliveryClaimBinding) => {
    try {
      const folded = new RunLedger(config.storeDir).foldJob(claim.jobId)
      const durableClaim = folded.claims.get(claim.runId)
      const durableBinding = durableClaim === undefined ? undefined : claimBinding(durableClaim)
      if (durableClaim === undefined
        || durableBinding === undefined
        || !sameClaim(durableBinding, claim)
        || durableClaim.agentEnvironment === undefined
        || durableClaim.deliveryLifecycle !== 'prepared') {
        return { status: 'failed' as const, error: 'exact prepared claim is required' }
      }

      const lifecycle = createCronRunDeliveryMeaningLifecycle(config)
      const lineage = lifecycle.registerExternalFirstLineage(claim)
      if (lineage.status !== 'accepted') {
        return { status: 'failed' as const, error: 'prepared claim lineage registration failed' }
      }

      const activeLease = activeLeases.find(candidate => sameClaim(candidate.claim, claim))
      if (activeLease !== undefined) {
        return { status: 'accepted' as const, port: activeLease.port, dispose: activeLease.dispose }
      }

      let disposed = false
      let unregisterInspector = (): void => undefined
      let unregisterFinalizationInspector = (): void => undefined
      const dispose = async () => {
        if (disposed) return
        disposed = true
        const index = activeLeases.findIndex(candidate => sameClaim(candidate.claim, claim))
        if (index >= 0) activeLeases.splice(index, 1)
        unregisterInspector()
        unregisterFinalizationInspector()
      }
      const port: CronRunDeliveryMeaningRunPort = {
        async bindPreparedDelivery(input) {
          if (disposed) return { status: 'failed' as const, input }
          if (!isRecord(input)
            || !hasExactKeys(input, BIND_INPUT_KEYS)
            || !isNonBlankString(input.businessRunId)
            || !isNonBlankString(input.businessPeriodId)) {
            return { status: 'rejected' as const, input }
          }
          try {
            const folded = new RunLedger(config.storeDir).foldJob(claim.jobId)
            if (folded.invalidLifecycleRunIds.has(claim.runId)
              || folded.claimConflicts.has(claim.runId)
              || folded.lifecycleConflicts.has(claim.runId)) {
              return { status: 'failed' as const, input }
            }
            const prepared = folded.preparedDeliveries.get(claim.runId)
            const primaryInput: CronPrimaryRunContentObjectInput = {
              claim,
              objectId: prepared?.objectId ?? '',
              businessRunId: input.businessRunId,
              businessPeriodId: input.businessPeriodId,
            }
            if (prepared === undefined || !preparedMatches(prepared, primaryInput)) {
              return { status: 'rejected' as const, input }
            }
            const result = lifecycle.registerPrimaryRunContentObject(primaryInput)
            if (result.status === 'accepted') return { status: 'accepted' as const }
            return { status: result.status, input }
          } catch {
            return { status: 'failed' as const, input }
          }
        },
        async acceptDurableReceipt(receipt) {
          if (disposed) return { status: 'failed' as const, input: receipt }
          try {
            const result = lifecycle.acceptDeliveryReceipt({ receipt })
            if (result.status === 'accepted') {
              return { status: 'accepted' as const, value: { receipt: result.value.receipt } }
            }
            return { status: result.status, input: receipt }
          } catch {
            return { status: 'failed' as const, input: receipt }
          }
        },
        async commitBusinessFinalization() {
          if (disposed) return { status: 'failed' as const, input: undefined }
          try {
            const folded = new RunLedger(config.storeDir).foldJob(claim.jobId)
            if (folded.invalidLifecycleRunIds.has(claim.runId)
              || folded.claimConflicts.has(claim.runId)
              || folded.lifecycleConflicts.has(claim.runId)) {
              return { status: 'failed' as const, input: undefined }
            }
            const durableClaim = folded.claims.get(claim.runId)
            const durableBinding = durableClaim === undefined ? undefined : claimBinding(durableClaim)
            if (durableBinding === undefined || !sameClaim(durableBinding, claim)) {
              return { status: 'rejected' as const, input: undefined }
            }

            const records = readOwnerRecordsSafely(new JsonlStore(join(config.storeDir, 'run-delivery-meaning.jsonl')))
            if (records === undefined || !ownerProjectionIsDurable(config.storeDir, records)) {
              return { status: 'failed' as const, input: undefined }
            }
            const primaryRecords = records.filter(isPrimaryOwnerRecord)
            const matchingPrimary = primaryRecords.filter(record => sameClaim(record.claim, claim))
            if (matchingPrimary.length === 0) return { status: 'rejected' as const, input: undefined }
            if (matchingPrimary.length !== 1) return { status: 'failed' as const, input: undefined }
            const primary = matchingPrimary[0]
            if (primary === undefined) return { status: 'failed' as const, input: undefined }

            const result = lifecycle.recordPrimaryRunContentBusinessFinalization({
              binding: primaryBindingFromRecord(primary),
            })
            if (result.status === 'accepted') return { status: 'accepted' as const }
            return { status: result.status as 'rejected' | 'failed', input: undefined }
          } catch {
            return { status: 'failed' as const, input: undefined }
          }
        },
      }
      Object.freeze(port)
      unregisterInspector = registerPreparedDeliveryBindingInspector(
        port,
        createPreparedDeliveryBindingInspector(config.storeDir, claim),
      )
      unregisterFinalizationInspector = registerDurableBusinessFinalizationInspector(
        port,
        createDurableBusinessFinalizationInspector(config.storeDir, claim),
      )
      activeLeases.push({ claim, port, dispose })
      return {
        status: 'accepted' as const,
        port,
        dispose,
      }
    } catch {
      return { status: 'failed' as const, error: 'run-delivery meaning factory read failed' }
    }
  }

  return { createRunPort }
}

/** Install the scheduler-owned factory without exposing the owner store. */
export function provideCronRunDeliveryMeaningPortFactory(
  ctx: Context,
  config: { readonly storeDir: string },
): CronRunDeliveryMeaningPortFactory {
  const factory = createCronRunDeliveryMeaningPortFactory(config)
  const installed = Object.freeze({
    createRunPort: factory.createRunPort,
  })
  ctx.provide(CRON_RUN_DELIVERY_MEANING_LIFECYCLE, installed)
  return installed
}

function hasDurableReceiptRow(storeDir: string, jobId: string, runId: string): boolean {
  try {
    return new JsonlStore(join(storeDir, 'runs.jsonl')).readLines().some(raw => {
      if (raw.trim() === '') return false
      try {
        const value = JSON.parse(raw) as unknown
        return isRecord(value) && value.event === 'delivery-receipt' && value.jobId === jobId && value.runId === runId
      } catch {
        return false
      }
    })
  } catch {
    return false
  }
}

function ownerRecordMatchesDurableClaim(
  storeDir: string,
  record: OwnerRecord,
  foldedByJob: Map<string, ReturnType<RunLedger['foldJob']>>,
): boolean {
  let folded = foldedByJob.get(record.claim.jobId)
  if (folded === undefined) {
    try {
      folded = new RunLedger(storeDir).foldJob(record.claim.jobId)
    } catch {
      return false
    }
    foldedByJob.set(record.claim.jobId, folded)
  }
  if (folded.invalidLifecycleRunIds.has(record.claim.runId)
    || folded.claimConflicts.has(record.claim.runId)
    || folded.lifecycleConflicts.has(record.claim.runId)) return false
  const durableClaim = folded.claims.get(record.claim.runId)
  const durableBinding = durableClaim === undefined ? undefined : claimBinding(durableClaim)
  return durableBinding !== undefined && sameClaim(durableBinding, record.claim)
}

function ownerProjectionIsDurable(storeDir: string, records: OwnerRecord[]): boolean {
  const foldedByJob = new Map<string, ReturnType<RunLedger['foldJob']>>()
  const lineageRecords = records.filter(isLineageOwnerRecord)
  const primaryRecords = records.filter(isPrimaryOwnerRecord)
  const meaningRecords = records.filter(isMeaningOwnerRecord)
  const finalizationRecords = records.filter(isFinalizationOwnerRecord)
  const objectIds = new Set<string>()
  const businessPeriodsByRun = new Map<string, Set<string>>()

  for (const record of primaryRecords) {
    if (objectIds.has(record.objectId)) return false
    objectIds.add(record.objectId)

    const businessPeriods = businessPeriodsByRun.get(record.businessRunId) ?? new Set<string>()
    if (businessPeriods.has(record.businessPeriodId)) return false
    businessPeriods.add(record.businessPeriodId)
    businessPeriodsByRun.set(record.businessRunId, businessPeriods)
  }

  for (const record of records) {
    if (!ownerRecordMatchesDurableClaim(storeDir, record, foldedByJob)) return false

    if (record.event === OWNER_EVENT) {
      const sameRunLineage = lineageRecords.filter(candidate => candidate.claim.jobId === record.claim.jobId
        && candidate.claim.runId === record.claim.runId)
      if (sameRunLineage.length !== 1) return false
      continue
    }

    if (record.event === MEANING_OWNER_EVENT) {
      const sameRunMeaning = meaningRecords.filter(candidate => sameClaim(candidate.claim, record.claim))
      if (sameRunMeaning.length !== 1) return false
      const sameRunPrimary = primaryRecords.filter(candidate => sameClaim(candidate.claim, record.claim))
      if (sameRunPrimary.length !== 1) return false
      const primary = sameRunPrimary[0]
      const folded = foldedByJob.get(record.claim.jobId)
      if (primary === undefined || folded === undefined) return false
      const prepared = folded.preparedDeliveries.get(record.claim.runId)
      const attempt = folded.deliveryAttemptClaims.get(record.claim.runId)
      const receipt = folded.deliveryReceipts.get(record.claim.runId)
      const evidence = readDurableReceiptEvidence(storeDir, record.claim.jobId, record.claim.runId, receipt)
      if (prepared === undefined
        || prepared.jobId !== record.claim.jobId
        || prepared.runId !== record.claim.runId
        || prepared.sessionId !== record.claim.sessionId
        || prepared.scheduledFor !== record.claim.scheduledFor
        || prepared.objectId !== record.objectId
        || attempt === undefined
        || attempt.objectId !== record.objectId
        || attempt.sessionId !== record.claim.sessionId
        || attempt.scheduledFor !== record.claim.scheduledFor
        || receipt === undefined
        || receipt.objectId !== record.objectId
        || !sameClaim(primary.claim, record.claim)
        || primary.objectId !== record.objectId
        || primary.businessRunId !== record.businessRunId
        || primary.businessPeriodId !== record.businessPeriodId
        || evidence === undefined
        || evidence.digest !== record.receiptDigest) return false
      continue
    }

    if (record.event === FINALIZATION_OWNER_EVENT) {
      const sameRunFinalization = finalizationRecords.filter(candidate => sameClaim(candidate.claim, record.claim))
      if (sameRunFinalization.length !== 1) return false
      const sameRunPrimary = primaryRecords.filter(candidate => sameClaim(candidate.claim, record.claim))
      if (sameRunPrimary.length !== 1) return false
      const sameRunMeaning = meaningRecords.filter(candidate => sameClaim(candidate.claim, record.claim))
      if (sameRunMeaning.length !== 1) return false
      const primary = sameRunPrimary[0]
      const meaning = sameRunMeaning[0]
      const folded = foldedByJob.get(record.claim.jobId)
      if (primary === undefined || meaning === undefined || folded === undefined) return false
      const prepared = folded.preparedDeliveries.get(record.claim.runId)
      const attempt = folded.deliveryAttemptClaims.get(record.claim.runId)
      const receipt = folded.deliveryReceipts.get(record.claim.runId)
      const evidence = readDurableReceiptEvidence(storeDir, record.claim.jobId, record.claim.runId, receipt)
      if (prepared === undefined
        || prepared.objectId !== record.objectId
        || prepared.sessionId !== record.claim.sessionId
        || prepared.scheduledFor !== record.claim.scheduledFor
        || attempt === undefined
        || attempt.objectId !== record.objectId
        || attempt.sessionId !== record.claim.sessionId
        || attempt.scheduledFor !== record.claim.scheduledFor
        || receipt === undefined
        || receipt.objectId !== record.objectId
        || !sameClaim(primary.claim, record.claim)
        || primary.objectId !== record.objectId
        || primary.businessRunId !== record.businessRunId
        || primary.businessPeriodId !== record.businessPeriodId
        || meaning.objectId !== record.objectId
        || meaning.businessRunId !== record.businessRunId
        || meaning.businessPeriodId !== record.businessPeriodId
        || evidence === undefined
        || evidence.digest !== meaning.receiptDigest) return false
      continue
    }

    if (record.event !== PRIMARY_OWNER_EVENT) return false

    const sameRunPrimary = primaryRecords.filter(candidate => candidate.claim.jobId === record.claim.jobId
      && candidate.claim.runId === record.claim.runId)
    if (sameRunPrimary.length !== 1) return false

    let folded = foldedByJob.get(record.claim.jobId)
    if (folded === undefined) return false
    const prepared = folded.preparedDeliveries.get(record.claim.runId)
    if (prepared === undefined
      || prepared.jobId !== record.claim.jobId
      || prepared.runId !== record.claim.runId
      || prepared.sessionId !== record.claim.sessionId
      || prepared.scheduledFor !== record.claim.scheduledFor
      || prepared.objectId !== record.objectId) return false

    const sameClaimLineage = lineageRecords.filter(candidate => sameClaim(candidate.claim, record.claim))
    if (sameClaimLineage.length !== 1) return false
  }
  return true
}

function createDurableBusinessFinalizationInspector(
  storeDir: string,
  claim: CronPreparedDeliveryClaimBinding,
): () => boolean {
  return () => {
    try {
      const folded = new RunLedger(storeDir).foldJob(claim.jobId)
      if (folded.invalidLifecycleRunIds.has(claim.runId)
        || folded.claimConflicts.has(claim.runId)
        || folded.lifecycleConflicts.has(claim.runId)) return false
      const durableClaim = folded.claims.get(claim.runId)
      const durableBinding = durableClaim === undefined ? undefined : claimBinding(durableClaim)
      if (durableBinding === undefined || !sameClaim(durableBinding, claim)) return false

      const prepared = folded.preparedDeliveries.get(claim.runId)
      const attempt = folded.deliveryAttemptClaims.get(claim.runId)
      const receipt = folded.deliveryReceipts.get(claim.runId)
      if (prepared === undefined || attempt === undefined || receipt === undefined
        || prepared.objectId !== attempt.objectId
        || prepared.objectId !== receipt.objectId
        || prepared.sessionId !== claim.sessionId
        || prepared.scheduledFor !== claim.scheduledFor
        || attempt.sessionId !== claim.sessionId
        || attempt.scheduledFor !== claim.scheduledFor
        || receipt.sessionId !== claim.sessionId
        || receipt.scheduledFor !== claim.scheduledFor) return false

      const records = readOwnerRecordsSafely(new JsonlStore(join(storeDir, 'run-delivery-meaning.jsonl')))
      if (records === undefined || !ownerProjectionIsDurable(storeDir, records)) return false
      const matchingPrimary = records.filter(isPrimaryOwnerRecord).filter(record => sameClaim(record.claim, claim))
      const matchingMeaning = records.filter(isMeaningOwnerRecord).filter(record => sameClaim(record.claim, claim))
      const matchingFinalization = records.filter(isFinalizationOwnerRecord).filter(record => sameClaim(record.claim, claim))
      if (matchingPrimary.length !== 1 || matchingMeaning.length !== 1 || matchingFinalization.length !== 1) return false
      const primary = matchingPrimary[0]
      const meaning = matchingMeaning[0]
      const finalization = matchingFinalization[0]
      if (primary === undefined || meaning === undefined || finalization === undefined) return false
      return primary.objectId === prepared.objectId
        && meaning.objectId === prepared.objectId
        && finalization.objectId === prepared.objectId
        && meaning.businessRunId === primary.businessRunId
        && meaning.businessPeriodId === primary.businessPeriodId
        && finalization.businessRunId === primary.businessRunId
        && finalization.businessPeriodId === primary.businessPeriodId
    } catch {
      return false
    }
  }
}

/**
 * Detect a prepared terminal run whose technical close exists but whose
 * business finalization does not. This is intentionally package-internal:
 * the scheduler uses it only before claiming another run for the same job.
 */
export function hasUnfinalizedPreparedTerminalOwner(storeDir: string, jobId: string): boolean {
  try {
    const records = readOwnerRecordsSafely(new JsonlStore(join(storeDir, 'run-delivery-meaning.jsonl')))
    if (records === undefined) return true
    const jobRecords = records.filter(record => record.claim.jobId === jobId)
    if (jobRecords.length === 0) return false
    if (!ownerProjectionIsDurable(storeDir, records)) return true

    const folded = new RunLedger(storeDir).foldJob(jobId)
    const runLines = new JsonlStore(join(storeDir, 'runs.jsonl')).readLines()
    const hasFinish = (runId: string): boolean => runLines.some(raw => {
      try {
        const value = JSON.parse(raw) as unknown
        return isRecord(value)
          && value.event === 'finish'
          && value.jobId === jobId
          && value.runId === runId
      } catch {
        return false
      }
    })

    return records.filter(isPrimaryOwnerRecord)
      .filter(record => record.claim.jobId === jobId)
      .some(primary => {
        const sameClaimMeaning = records.filter(isMeaningOwnerRecord)
          .filter(record => sameClaim(record.claim, primary.claim))
        const sameClaimFinalization = records.filter(isFinalizationOwnerRecord)
          .filter(record => sameClaim(record.claim, primary.claim))
        return sameClaimMeaning.length === 1
          && sameClaimFinalization.length === 0
          && folded.preparedDeliveries.has(primary.claim.runId)
          && (folded.prefinishSettledDeliveries.has(primary.claim.runId)
            || hasFinish(primary.claim.runId))
      })
  } catch {
    return true
  }
}

function createPreparedDeliveryBindingInspector(
  storeDir: string,
  claim: CronPreparedDeliveryClaimBinding,
): (preparedDelivery: PreparedDeliveryObject) => boolean {
  return preparedDelivery => {
    const folded = new RunLedger(storeDir).foldJob(claim.jobId)
    if (folded.invalidLifecycleRunIds.has(claim.runId)
      || folded.claimConflicts.has(claim.runId)
      || folded.lifecycleConflicts.has(claim.runId)) return false
    const durableClaim = folded.claims.get(claim.runId)
    const durableBinding = durableClaim === undefined ? undefined : claimBinding(durableClaim)
    if (durableBinding === undefined || !sameClaim(durableBinding, claim)) return false
    const prepared = folded.preparedDeliveries.get(claim.runId)
    if (prepared === undefined
      || prepared.jobId !== claim.jobId
      || prepared.runId !== claim.runId
      || prepared.sessionId !== claim.sessionId
      || prepared.scheduledFor !== claim.scheduledFor
      || prepared.objectId !== preparedDelivery.objectId
      || prepared.text !== preparedDelivery.text) return false
    const records = readOwnerRecordsSafely(new JsonlStore(join(storeDir, 'run-delivery-meaning.jsonl')))
    if (records === undefined || !ownerProjectionIsDurable(storeDir, records)) return false
    const primaryRecords = records.filter(isPrimaryOwnerRecord)
      .filter(record => sameClaim(record.claim, claim))
    return primaryRecords.length === 1
      && primaryRecords[0]!.objectId === preparedDelivery.objectId
      && primaryRecords[0]!.objectClass === PRIMARY_OBJECT_CLASS
      && primaryRecords[0]!.runLineage === OWNER_LINEAGE
  }
}

function primaryRecordMatchesInput(record: OwnerRecord, input: CronPrimaryRunContentObjectInput): boolean {
  return record.event === PRIMARY_OWNER_EVENT
    && sameClaim(record.claim, input.claim)
    && record.objectId === input.objectId
    && record.businessRunId === input.businessRunId
    && record.businessPeriodId === input.businessPeriodId
    && record.objectClass === PRIMARY_OBJECT_CLASS
    && record.runLineage === OWNER_LINEAGE
}

function primaryBindingFromRecord(record: PrimaryOwnerRecord): PrimaryRunContentBinding {
  return {
    claim: record.claim,
    objectId: record.objectId,
    businessRunId: record.businessRunId,
    businessPeriodId: record.businessPeriodId,
    objectClass: record.objectClass,
    runLineage: record.runLineage,
  }
}

function retryForReceipt(
  receipt: CronDeliveryReceipt,
  binding: PrimaryRunContentBinding,
  receiptDigest: string,
  readiness: 'not_ready' | 'ready' = 'not_ready',
): CronRunDeliveryMeaningRetry {
  if (receipt.deliveryState !== 'failed') return { status: 'not_authorized' }
  return {
    status: 'authorized',
    category: 'primary_run_content_delivery_failed',
    authorization: { binding, receiptDigest },
    readiness,
  }
}

export interface CronRunDeliveryMeaningConfig {
  readonly storeDir: string
}

export interface CronExternalFirstLineageAccepted {
  readonly status: 'accepted'
  readonly value: {
    readonly claim: CronPreparedDeliveryClaimBinding
    readonly runLineage: 'external_first'
  }
}

export interface CronExternalFirstLineageRejected {
  readonly status: 'rejected'
  readonly input: CronPreparedDeliveryClaimBinding
}

export interface CronExternalFirstLineageFailed {
  readonly status: 'failed'
  readonly input: CronPreparedDeliveryClaimBinding
}

export type CronExternalFirstLineageResult =
  | CronExternalFirstLineageAccepted
  | CronExternalFirstLineageRejected
  | CronExternalFirstLineageFailed

export interface CronPrimaryRunContentObjectInput {
  readonly claim: CronPreparedDeliveryClaimBinding
  readonly objectId: string
  readonly businessRunId: string
  readonly businessPeriodId: string
}

export interface CronPrimaryRunContentObjectAccepted {
  readonly status: 'accepted'
  readonly value: CronPrimaryRunContentObjectInput & {
    readonly objectClass: typeof PRIMARY_OBJECT_CLASS
    readonly runLineage: typeof OWNER_LINEAGE
  }
}

export interface CronPrimaryRunContentObjectRejected {
  readonly status: 'rejected'
  readonly input: CronPrimaryRunContentObjectInput
}

export interface CronPrimaryRunContentObjectFailed {
  readonly status: 'failed'
  readonly input: CronPrimaryRunContentObjectInput
}

export type CronPrimaryRunContentObjectResult =
  | CronPrimaryRunContentObjectAccepted
  | CronPrimaryRunContentObjectRejected
  | CronPrimaryRunContentObjectFailed

/** Technical receipt input reserved for the later receipt owner slice. */
export interface CronRunDeliveryMeaningReceiptInput {
  readonly receipt: CronDeliveryReceipt
}

function isReceiptInput(value: unknown): value is CronRunDeliveryMeaningReceiptInput {
  return isRecord(value) && hasExactKeys(value, ['receipt']) && isCronDeliveryReceipt(value.receipt)
}

type PrimaryRunContentBinding = CronPrimaryRunContentObjectAccepted['value']

export interface CronRunDeliveryMeaningNotAuthorized {
  readonly status: 'not_authorized'
}

export interface CronRunDeliveryMeaningAuthorized {
  readonly status: 'authorized'
  readonly category: 'primary_run_content_delivery_failed'
  readonly authorization: {
    readonly binding: PrimaryRunContentBinding
    readonly receiptDigest: string
  }
  readonly readiness: 'not_ready' | 'ready'
}

export type CronRunDeliveryMeaningRetry =
  | CronRunDeliveryMeaningNotAuthorized
  | CronRunDeliveryMeaningAuthorized

export interface CronPrimaryRunContentBusinessFinalizationInput {
  readonly binding: PrimaryRunContentBinding
}

export interface CronPrimaryRunContentBusinessFinalizationAccepted {
  readonly status: 'accepted'
  readonly value: {
    readonly binding: PrimaryRunContentBinding
    readonly retry: CronRunDeliveryMeaningRetry
  }
}

export interface CronPrimaryRunContentBusinessFinalizationRejected {
  readonly status: 'rejected'
  readonly input: CronPrimaryRunContentBusinessFinalizationInput
}

export interface CronPrimaryRunContentBusinessFinalizationFailed {
  readonly status: 'failed'
  readonly input: CronPrimaryRunContentBusinessFinalizationInput
}

export type CronPrimaryRunContentBusinessFinalizationResult =
  | CronPrimaryRunContentBusinessFinalizationAccepted
  | CronPrimaryRunContentBusinessFinalizationRejected
  | CronPrimaryRunContentBusinessFinalizationFailed

export interface CronRunDeliveryMeaningAccepted {
  readonly status: 'accepted'
  readonly value: {
    readonly receipt: CronDeliveryReceipt
    readonly binding: PrimaryRunContentBinding
    readonly retry: CronRunDeliveryMeaningRetry
  }
}

export interface CronRunDeliveryMeaningRejected {
  readonly status: 'rejected'
  readonly input: unknown
}

export interface CronRunDeliveryMeaningFailed {
  readonly status: 'failed'
  readonly input: unknown
}

export type CronRunDeliveryMeaningResult =
  | CronRunDeliveryMeaningAccepted
  | CronRunDeliveryMeaningRejected
  | CronRunDeliveryMeaningFailed

/** Package-internal integration port for the generic run-delivery meaning owner. */
export interface CronRunDeliveryMeaningLifecycle {
  registerExternalFirstLineage(input: CronPreparedDeliveryClaimBinding): CronExternalFirstLineageResult
  registerPrimaryRunContentObject(input: CronPrimaryRunContentObjectInput): CronPrimaryRunContentObjectResult
  acceptDeliveryReceipt(input: CronRunDeliveryMeaningReceiptInput): CronRunDeliveryMeaningResult
  recordPrimaryRunContentBusinessFinalization(
    input: CronPrimaryRunContentBusinessFinalizationInput,
  ): CronPrimaryRunContentBusinessFinalizationResult
}

export function createCronRunDeliveryMeaningLifecycle(
  config: CronRunDeliveryMeaningConfig,
): CronRunDeliveryMeaningLifecycle {
  const ownerStore = new JsonlStore(join(config.storeDir, 'run-delivery-meaning.jsonl'))
  const failed = (input: CronPreparedDeliveryClaimBinding): CronExternalFirstLineageFailed => ({ status: 'failed', input })
  const registerExternalFirstLineage = (input: CronPreparedDeliveryClaimBinding): CronExternalFirstLineageResult => {
    if (!isClaimBinding(input)) return { status: 'rejected', input }

    const folded = new RunLedger(config.storeDir).foldJob(input.jobId)
    if (folded.invalidLifecycleRunIds.has(input.runId)
      || folded.claimConflicts.has(input.runId)
      || folded.lifecycleConflicts.has(input.runId)) {
      return failed(input)
    }
    const durableClaim = folded.claims.get(input.runId)
    const durableBinding = durableClaim === undefined ? undefined : claimBinding(durableClaim)
    if (durableBinding === undefined || !sameClaim(durableBinding, input)) {
      return { status: 'rejected', input }
    }

    const records = readOwnerRecordsSafely(ownerStore)
    if (records === undefined) return failed(input)
    if (!ownerProjectionIsDurable(config.storeDir, records)) return failed(input)

    const sameRun = records.filter(record => record.event === OWNER_EVENT
      && record.claim.jobId === input.jobId
      && record.claim.runId === input.runId)
    if (sameRun.length > 1 || sameRun.some(record => !sameClaim(record.claim, input))) {
      return failed(input)
    }
    if (sameRun.length === 1) {
      const first = sameRun[0]
      if (first === undefined) return { status: 'rejected', input }
      return {
        status: 'accepted',
        value: { claim: first.claim, runLineage: OWNER_LINEAGE },
      }
    }

    const record: OwnerRecord = {
      schemaVersion: 1,
      event: OWNER_EVENT,
      claim: input,
      runLineage: OWNER_LINEAGE,
    }
    try {
      ownerStore.append(record)
    } catch {
      const readBack = readOwnerRecordsSafely(ownerStore)
      if (readBack !== undefined
        && readBack.length === records.length + 1
        && ownerProjectionIsDurable(config.storeDir, readBack)) {
        const persisted = readBack.filter(item => item.claim.jobId === input.jobId && item.claim.runId === input.runId)
        const first = persisted[0]
        if (first !== undefined && persisted.length === 1 && sameClaim(first.claim, input)) {
          return { status: 'accepted', value: { claim: first.claim, runLineage: OWNER_LINEAGE } }
        }
      }
      return failed(input)
    }
    return { status: 'accepted', value: { claim: input, runLineage: OWNER_LINEAGE } }
  }

  const registerPrimaryRunContentObject = (input: CronPrimaryRunContentObjectInput): CronPrimaryRunContentObjectResult => {
    const rejected = (): CronPrimaryRunContentObjectRejected => ({ status: 'rejected', input })
    const failed = (): CronPrimaryRunContentObjectFailed => ({ status: 'failed', input })
    if (!isPrimaryInput(input)) return rejected()

    const folded = new RunLedger(config.storeDir).foldJob(input.claim.jobId)
    if (folded.invalidLifecycleRunIds.has(input.claim.runId)
      || folded.claimConflicts.has(input.claim.runId)
      || folded.lifecycleConflicts.has(input.claim.runId)) return failed()
    const durableClaim = folded.claims.get(input.claim.runId)
    const durableBinding = durableClaim === undefined ? undefined : claimBinding(durableClaim)
    if (durableBinding === undefined || !sameClaim(durableBinding, input.claim)) return rejected()

    const records = readOwnerRecordsSafely(ownerStore)
    if (records === undefined) return failed()
    const lineageRecords = records.filter(record => record.event === OWNER_EVENT)
    const lineage = lineageRecords.find(record => sameClaim(record.claim, input.claim))
    const prepared = folded.preparedDeliveries.get(input.claim.runId)
    const hasAttemptOrReceipt = folded.deliveryAttemptClaims.has(input.claim.runId)
      || folded.deliveryReceipts.has(input.claim.runId)
    if (!ownerProjectionIsDurable(config.storeDir, records)) return failed()
    if (lineage === undefined) return hasAttemptOrReceipt ? failed() : rejected()
    if (prepared === undefined) return hasAttemptOrReceipt ? failed() : rejected()
    if (!preparedMatches(prepared, input)) return rejected()

    const primaryRecords = records.filter(isPrimaryOwnerRecord)

    const sameRun = primaryRecords.filter(record => sameClaim(record.claim, input.claim))
    if (sameRun.length > 1) return failed()
    const existing = sameRun[0]
    if (existing !== undefined) {
      if (existing.objectId === input.objectId
        && existing.businessRunId === input.businessRunId
        && existing.businessPeriodId === input.businessPeriodId) {
        return {
          status: 'accepted',
          value: {
            claim: existing.claim,
            objectId: existing.objectId,
            businessRunId: existing.businessRunId,
            businessPeriodId: existing.businessPeriodId,
            objectClass: PRIMARY_OBJECT_CLASS,
            runLineage: OWNER_LINEAGE,
          },
        }
      }
      return rejected()
    }
    if (hasAttemptOrReceipt) return failed()

    if (primaryRecords.some(record => record.objectId === input.objectId && !sameClaim(record.claim, input.claim))) return rejected()
    if (primaryRecords.some(record => record.businessRunId === input.businessRunId
      && record.businessPeriodId === input.businessPeriodId
      && !sameClaim(record.claim, input.claim))) return rejected()

    const record: PrimaryOwnerRecord = {
      schemaVersion: 1,
      event: PRIMARY_OWNER_EVENT,
      claim: input.claim,
      objectId: input.objectId,
      businessRunId: input.businessRunId,
      businessPeriodId: input.businessPeriodId,
      objectClass: PRIMARY_OBJECT_CLASS,
      runLineage: OWNER_LINEAGE,
    }
    try {
      ownerStore.append(record)
    } catch {
      const readBack = readOwnerRecordsSafely(ownerStore)
      if (readBack !== undefined
        && readBack.length === records.length + 1
        && ownerProjectionIsDurable(config.storeDir, readBack)) {
        const persisted = readBack.filter((candidate): candidate is PrimaryOwnerRecord => isPrimaryOwnerRecord(candidate)
          && sameClaim(candidate.claim, input.claim))
        if (persisted.length === 1 && primaryRecordMatchesInput(persisted[0]!, input)) {
          return {
            status: 'accepted',
            value: {
              claim: persisted[0]!.claim,
              objectId: persisted[0]!.objectId,
              businessRunId: persisted[0]!.businessRunId,
              businessPeriodId: persisted[0]!.businessPeriodId,
              objectClass: PRIMARY_OBJECT_CLASS,
              runLineage: OWNER_LINEAGE,
            },
          }
        }
      }
      return failed()
    }
    return {
      status: 'accepted',
      value: {
        claim: input.claim,
        objectId: input.objectId,
        businessRunId: input.businessRunId,
        businessPeriodId: input.businessPeriodId,
        objectClass: PRIMARY_OBJECT_CLASS,
        runLineage: OWNER_LINEAGE,
      },
    }
  }

  const acceptDeliveryReceipt = (input: CronRunDeliveryMeaningReceiptInput): CronRunDeliveryMeaningResult => {
    const rejected = (): CronRunDeliveryMeaningRejected => ({ status: 'rejected', input })
    const failed = (): CronRunDeliveryMeaningFailed => ({ status: 'failed', input })
    if (!isReceiptInput(input)) return rejected()

    let folded: ReturnType<RunLedger['foldJob']>
    try {
      folded = new RunLedger(config.storeDir).foldJob(input.receipt.jobId)
    } catch {
      return failed()
    }
    if (folded.invalidLifecycleRunIds.has(input.receipt.runId)
      || folded.claimConflicts.has(input.receipt.runId)
      || folded.lifecycleConflicts.has(input.receipt.runId)) return failed()

    const durableClaim = folded.claims.get(input.receipt.runId)
    const durableBinding = durableClaim === undefined ? undefined : claimBinding(durableClaim)
    if (durableBinding === undefined || !sameClaim(durableBinding, {
      jobId: input.receipt.jobId,
      runId: input.receipt.runId,
      sessionId: input.receipt.sessionId,
      scheduledFor: input.receipt.scheduledFor,
      claimedAt: durableBinding.claimedAt,
      trigger: durableBinding.trigger,
    })) return rejected()

    let records: OwnerRecord[] | undefined
    try {
      records = readOwnerRecordsSafely(ownerStore)
    } catch {
      records = undefined
    }
    if (records === undefined) return failed()
    const meaningRecords = records.filter(isMeaningOwnerRecord)
      .filter(record => sameClaim(record.claim, durableBinding))
    const hasMeaning = meaningRecords.length > 0

    const receipt = folded.deliveryReceipts.get(input.receipt.runId)
    const receiptEvidence = readDurableReceiptEvidence(config.storeDir, input.receipt.jobId, input.receipt.runId, receipt)
    const hasAttempt = folded.deliveryAttemptClaims.has(input.receipt.runId)
    const hasAcknowledgement = folded.prefinishSettledDeliveries.has(input.receipt.runId)
    const hasReceiptRow = hasDurableReceiptRow(config.storeDir, input.receipt.jobId, input.receipt.runId)
    if (receipt === undefined || receiptEvidence === undefined) {
      return hasMeaning || hasAcknowledgement || hasReceiptRow ? failed() : rejected()
    }
    if (!hasAttempt || !sameReceipt(receipt, input.receipt)) return hasMeaning ? failed() : rejected()
    if (hasAcknowledgement && !hasMeaning) return failed()
    if (!ownerProjectionIsDurable(config.storeDir, records)) return failed()

    const primaryRecords = records.filter(isPrimaryOwnerRecord)
    const matchingPrimary = primaryRecords.filter(record => sameClaim(record.claim, durableBinding))
    if (matchingPrimary.length !== 1) return failed()
    const primary = matchingPrimary[0]
    if (primary === undefined) return failed()
    const prepared = folded.preparedDeliveries.get(input.receipt.runId)
    const attempt = folded.deliveryAttemptClaims.get(input.receipt.runId)
    if (prepared === undefined
      || prepared.objectId !== primary.objectId
      || prepared.sessionId !== durableBinding.sessionId
      || prepared.scheduledFor !== durableBinding.scheduledFor
      || attempt === undefined
      || attempt.objectId !== primary.objectId
      || attempt.sessionId !== durableBinding.sessionId
      || attempt.scheduledFor !== durableBinding.scheduledFor) return failed()

    const binding = primaryBindingFromRecord(primary)
    const sameMeaning = meaningRecords
    if (sameMeaning.length > 1) return failed()
    const finalizationRecords = records.filter(isFinalizationOwnerRecord)
    const sameFinalization = finalizationRecords.filter(record => sameClaim(record.claim, durableBinding))
    if (sameFinalization.length > 1) return failed()
    const finalization = sameFinalization[0]
    if (finalization !== undefined
      && (finalization.objectId !== binding.objectId
        || finalization.businessRunId !== binding.businessRunId
        || finalization.businessPeriodId !== binding.businessPeriodId)) return failed()
    const readiness = finalization === undefined ? 'not_ready' : 'ready'
    const existing = sameMeaning[0]
    if (existing !== undefined) {
      if (existing.objectId !== binding.objectId
        || existing.businessRunId !== binding.businessRunId
        || existing.businessPeriodId !== binding.businessPeriodId
        || existing.receiptDigest !== receiptEvidence.digest) return failed()
      return {
        status: 'accepted',
        value: {
          receipt: input.receipt,
          binding,
          retry: retryForReceipt(input.receipt, binding, receiptEvidence.digest, readiness),
        },
      }
    }

    const meaningRecord: MeaningOwnerRecord = {
      schemaVersion: 1,
      event: MEANING_OWNER_EVENT,
      claim: primary.claim,
      objectId: primary.objectId,
      businessRunId: primary.businessRunId,
      businessPeriodId: primary.businessPeriodId,
      receiptDigest: receiptEvidence.digest,
    }
    try {
      ownerStore.append(meaningRecord)
    } catch {
      const readBack = readOwnerRecordsSafely(ownerStore)
      if (readBack !== undefined
        && readBack.length === records.length + 1
        && ownerProjectionIsDurable(config.storeDir, readBack)) {
        const persisted = readBack.filter((candidate): candidate is MeaningOwnerRecord => isMeaningOwnerRecord(candidate)
          && sameClaim(candidate.claim, durableBinding))
        const exact = persisted[0]
        if (persisted.length === 1
          && exact !== undefined
          && exact.objectId === meaningRecord.objectId
          && exact.businessRunId === meaningRecord.businessRunId
          && exact.businessPeriodId === meaningRecord.businessPeriodId
          && exact.receiptDigest === meaningRecord.receiptDigest) {
          return {
            status: 'accepted',
            value: {
              receipt: input.receipt,
              binding,
              retry: retryForReceipt(input.receipt, binding, receiptEvidence.digest, readiness),
            },
          }
        }
      }
      return failed()
    }
    return {
      status: 'accepted',
      value: {
        receipt: input.receipt,
        binding,
        retry: retryForReceipt(input.receipt, binding, receiptEvidence.digest, readiness),
      },
    }
  }

  const recordPrimaryRunContentBusinessFinalization = (
    input: CronPrimaryRunContentBusinessFinalizationInput,
  ): CronPrimaryRunContentBusinessFinalizationResult => {
    const rejected = (): CronPrimaryRunContentBusinessFinalizationRejected => ({ status: 'rejected', input })
    const failed = (): CronPrimaryRunContentBusinessFinalizationFailed => ({ status: 'failed', input })
    if (!isFinalizationInput(input)) return rejected()

    let folded: ReturnType<RunLedger['foldJob']>
    try {
      folded = new RunLedger(config.storeDir).foldJob(input.binding.claim.jobId)
    } catch {
      return failed()
    }
    if (folded.invalidLifecycleRunIds.has(input.binding.claim.runId)
      || folded.claimConflicts.has(input.binding.claim.runId)
      || folded.lifecycleConflicts.has(input.binding.claim.runId)) return failed()
    const durableClaim = folded.claims.get(input.binding.claim.runId)
    const durableBinding = durableClaim === undefined ? undefined : claimBinding(durableClaim)
    if (durableBinding === undefined || !sameClaim(durableBinding, input.binding.claim)) return rejected()

    const records = readOwnerRecordsSafely(ownerStore)
    if (records === undefined || !ownerProjectionIsDurable(config.storeDir, records)) return failed()
    const primaryRecords = records.filter(isPrimaryOwnerRecord)
    const matchingPrimary = primaryRecords.filter(record => sameClaim(record.claim, input.binding.claim))
    if (matchingPrimary.length === 0) return rejected()
    if (matchingPrimary.length !== 1) return failed()
    const primary = matchingPrimary[0]
    if (primary === undefined
      || primary.objectId !== input.binding.objectId
      || primary.businessRunId !== input.binding.businessRunId
      || primary.businessPeriodId !== input.binding.businessPeriodId
      || primary.objectClass !== PRIMARY_OBJECT_CLASS
      || primary.runLineage !== OWNER_LINEAGE) return rejected()

    const meaningRecords = records.filter(isMeaningOwnerRecord)
    const matchingMeaning = meaningRecords.filter(record => sameClaim(record.claim, input.binding.claim))
    if (matchingMeaning.length === 0) return rejected()
    if (matchingMeaning.length !== 1) return failed()
    const meaning = matchingMeaning[0]
    const receipt = folded.deliveryReceipts.get(input.binding.claim.runId)
    const receiptEvidence = readDurableReceiptEvidence(
      config.storeDir,
      input.binding.claim.jobId,
      input.binding.claim.runId,
      receipt,
    )
    const attempt = folded.deliveryAttemptClaims.get(input.binding.claim.runId)
    const prepared = folded.preparedDeliveries.get(input.binding.claim.runId)
    if (meaning === undefined
      || prepared === undefined
      || attempt === undefined
      || receipt === undefined
      || receiptEvidence === undefined
      || prepared.objectId !== input.binding.objectId
      || attempt.objectId !== input.binding.objectId
      || receipt.objectId !== input.binding.objectId
      || meaning.objectId !== input.binding.objectId
      || meaning.businessRunId !== input.binding.businessRunId
      || meaning.businessPeriodId !== input.binding.businessPeriodId
      || receiptEvidence.digest !== meaning.receiptDigest) return failed()

    const finalizationRecords = records.filter(isFinalizationOwnerRecord)
    const matchingFinalization = finalizationRecords.filter(record => sameClaim(record.claim, input.binding.claim))
    const accepted = (): CronPrimaryRunContentBusinessFinalizationAccepted => ({
      status: 'accepted',
      value: {
        binding: input.binding,
        retry: retryForReceipt(cronReceiptFromRecord(receipt), input.binding, receiptEvidence.digest, 'ready'),
      },
    })
    if (matchingFinalization.length > 1) return failed()
    const existing = matchingFinalization[0]
    if (existing !== undefined) {
      if (existing.objectId !== input.binding.objectId
        || existing.businessRunId !== input.binding.businessRunId
        || existing.businessPeriodId !== input.binding.businessPeriodId) return failed()
      return accepted()
    }

    if (folded.prefinishSettledDeliveries.has(input.binding.claim.runId)
      || folded.unsettledFinishes.some(finish => finish.runId === input.binding.claim.runId)) return failed()

    const record: FinalizationOwnerRecord = {
      schemaVersion: 1,
      event: FINALIZATION_OWNER_EVENT,
      claim: input.binding.claim,
      objectId: input.binding.objectId,
      businessRunId: input.binding.businessRunId,
      businessPeriodId: input.binding.businessPeriodId,
    }
    try {
      ownerStore.append(record)
    } catch {
      const readBack = readOwnerRecordsSafely(ownerStore)
      if (readBack !== undefined
        && readBack.length === records.length + 1
        && ownerProjectionIsDurable(config.storeDir, readBack)) {
        const persisted = readBack.filter((candidate): candidate is FinalizationOwnerRecord => isFinalizationOwnerRecord(candidate)
          && sameClaim(candidate.claim, input.binding.claim))
        const exact = persisted[0]
        if (persisted.length === 1
          && exact !== undefined
          && exact.objectId === record.objectId
          && exact.businessRunId === record.businessRunId
          && exact.businessPeriodId === record.businessPeriodId) return accepted()
      }
      return failed()
    }
    return accepted()
  }

  return {
    registerExternalFirstLineage,
    registerPrimaryRunContentObject,
    acceptDeliveryReceipt,
    recordPrimaryRunContentBusinessFinalization,
  }
}
