/**
 * Bootstrap + A-lineage RED for dsh-cron's generic run-delivery meaning owner.
 *
 * This is deliberately source-neutral: it must consume only dsh-cron's
 * durable Cron claim identity. It does not import Personal Feed or name a
 * business result. The bootstrap, external-first lineage, primary object
 * binding, durable receipt acceptance, and C2 finalization lifecycle contracts
 * are tested here; later C2 hardening and source-specific adapters stay separate.
 */

import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { JsonlStore, RunLedger, RunStore } from '../src/store.ts'
import type {
  CronDeliveryReceipt,
  RunClaimRecord,
  RunDeliveryAttemptClaimRecord,
  RunDeliveryReceiptRecord,
  RunEnvironmentPrefinishSettleRecord,
  RunFinishRecord,
  RunPreparedDeliveryRecord,
} from '../src/types.ts'
import { MAX_PREPARED_OBJECT_ID_BYTES } from '../src/types.ts'
import type { CronPreparedDeliveryClaimBinding } from '../src/run-environment.ts'

const directories: string[] = []

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-cron-todo05-meaning-'))
  directories.push(directory)
  return directory
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('generic primary run content object binding RED', () => {
  it.each([
    ['scheduled', 'b-positive-scheduled'],
    ['manual', 'b-positive-manual'],
  ] as const)('accepts %s prepared content with exact claim and derived owner facts', async (trigger, suffix) => {
    const directory = temporaryDirectory()
    const { binding, prepared } = durablePreparedClaim(directory, trigger, suffix)
    await expect(registerExternalFirstLineage(directory, binding)).resolves.toEqual({
      status: 'accepted',
      value: { claim: binding, runLineage: 'external_first' },
    })
    const input = primaryInput(binding, { objectId: prepared.objectId })

    await expect(registerPrimaryRunContentObject(directory, input)).resolves.toEqual({
      status: 'accepted',
      value: {
        claim: binding,
        objectId: prepared.objectId,
        businessRunId: 'business-run-primary',
        businessPeriodId: 'business-period-primary',
        objectClass: 'primary_run_content',
        runLineage: 'external_first',
      },
    })
  })

  it('rejects prepared content when the exact A lineage binding is missing', async () => {
    const directory = temporaryDirectory()
    const { binding, prepared } = durablePreparedClaim(directory, 'manual', 'b-missing-lineage')
    const input = primaryInput(binding, { objectId: prepared.objectId })
    const before = directorySnapshot(directory)

    await expect(registerPrimaryRunContentObject(directory, input)).resolves.toEqual({
      status: 'rejected',
      input,
    })
    expect(directorySnapshot(directory)).toEqual(before)
  })

  it('rejects a lineage-bound claim when its prepared object row is missing', async () => {
    const directory = temporaryDirectory()
    const { binding } = durablePreparedClaimOnly(directory, 'scheduled', 'b-missing-prepared')
    await expect(registerExternalFirstLineage(directory, binding)).resolves.toEqual({
      status: 'accepted',
      value: { claim: binding, runLineage: 'external_first' },
    })
    const input = primaryInput(binding)
    const before = directorySnapshot(directory)

    await expect(registerPrimaryRunContentObject(directory, input)).resolves.toEqual({
      status: 'rejected',
      input,
    })
    expect(directorySnapshot(directory)).toEqual(before)
  })

  it('rejects an object id that differs from the exact prepared row', async () => {
    const directory = temporaryDirectory()
    const { binding, prepared } = await preparedWithLineage(directory, 'manual', 'b-object-mismatch')
    const input = primaryInput(binding, { objectId: `${prepared.objectId}-foreign` })
    const before = directorySnapshot(directory)

    await expect(registerPrimaryRunContentObject(directory, input)).resolves.toEqual({
      status: 'rejected',
      input,
    })
    expect(directorySnapshot(directory)).toEqual(before)
  })

  it('rejects a claim binding that differs from the exact prepared claim', async () => {
    const directory = temporaryDirectory()
    const { binding, prepared } = await preparedWithLineage(directory, 'scheduled', 'b-claim-mismatch')
    const foreignClaim = { ...binding, sessionId: 'foreign-session' }
    const input = primaryInput(foreignClaim, { objectId: prepared.objectId })
    const before = directorySnapshot(directory)

    await expect(registerPrimaryRunContentObject(directory, input)).resolves.toEqual({
      status: 'rejected',
      input,
    })
    expect(directorySnapshot(directory)).toEqual(before)
  })

  it('rejects caller-supplied object class, lineage, and retry policy fields', async () => {
    const directory = temporaryDirectory()
    const { binding, prepared } = await preparedWithLineage(directory, 'manual', 'b-caller-fields')
    const input = primaryInput(binding, {
      objectId: prepared.objectId,
      objectClass: 'foreign-class',
      runLineage: 'foreign-lineage',
      retryEligible: true,
    })
    const before = directorySnapshot(directory)

    await expect(registerPrimaryRunContentObject(directory, input)).resolves.toEqual({
      status: 'rejected',
      input,
    })
    expect(directorySnapshot(directory)).toEqual(before)
  })

  it.each([
    ['businessRunId', 42],
    ['businessRunId', ''],
    ['businessRunId', '   '],
    ['businessRunId', 'x'.repeat(1_025)],
    ['businessPeriodId', 42],
    ['businessPeriodId', ''],
    ['businessPeriodId', '   '],
    ['businessPeriodId', 'x'.repeat(1_025)],
    ['objectId', 42],
    ['objectId', ''],
    ['objectId', '   '],
    ['objectId', 'x'.repeat(MAX_PREPARED_OBJECT_ID_BYTES + 1)],
  ] as const)('rejects invalid %s value without writing', async (field, value) => {
    const directory = temporaryDirectory()
    const safeValueLabel = String(value).replace(/[^a-z0-9]+/giu, 'x').slice(0, 8)
    const { binding, prepared } = await preparedWithLineage(directory, 'scheduled', `b-invalid-${field}-${safeValueLabel}`)
    const input = primaryInput(binding, { objectId: prepared.objectId, [field]: value })
    const before = directorySnapshot(directory)

    await expect(registerPrimaryRunContentObject(directory, input)).resolves.toEqual({
      status: 'rejected',
      input,
    })
    expect(directorySnapshot(directory)).toEqual(before)
  })

  it('fails when prepared technical evidence conflicts before binding', async () => {
    const directory = temporaryDirectory()
    const { binding, prepared } = await preparedWithLineage(directory, 'scheduled', 'b-prepared-conflict')
    new RunStore(directory).appendEvent({ ...prepared, text: 'conflicting prepared text' })
    const input = primaryInput(binding, { objectId: prepared.objectId })
    const before = directorySnapshot(directory)

    await expect(registerPrimaryRunContentObject(directory, input)).resolves.toEqual({
      status: 'failed',
      input,
    })
    expect(directorySnapshot(directory)).toEqual(before)
  })

  it('fails when transport attempt and receipt exist before the B binding', async () => {
    const directory = temporaryDirectory()
    const { binding, prepared } = durablePreparedClaim(directory, 'manual', 'b-attempt-without-binding')
    await expect(registerExternalFirstLineage(directory, binding)).resolves.toEqual({
      status: 'accepted',
      value: { claim: binding, runLineage: 'external_first' },
    })
    appendAttemptAndReceipt(directory, prepared)
    const input = primaryInput(binding, { objectId: prepared.objectId })
    const before = directorySnapshot(directory)

    await expect(registerPrimaryRunContentObject(directory, input)).resolves.toEqual({
      status: 'failed',
      input,
    })
    expect(directorySnapshot(directory)).toEqual(before)
  })

  it('replays accepted binding after the exact attempt appears without writing a second owner fact', async () => {
    const directory = temporaryDirectory()
    const { binding, prepared } = await preparedWithLineage(directory, 'scheduled', 'b-attempt-after-binding')
    const input = primaryInput(binding, { objectId: prepared.objectId })
    const first = await registerPrimaryRunContentObject(directory, input)
    appendAttemptOnly(directory, prepared)
    const afterAttempt = directorySnapshot(directory)
    const replay = await registerPrimaryRunContentObject(directory, input)

    expect(first).toEqual({
      status: 'accepted',
      value: {
        claim: binding,
        objectId: prepared.objectId,
        businessRunId: 'business-run-primary',
        businessPeriodId: 'business-period-primary',
        objectClass: 'primary_run_content',
        runLineage: 'external_first',
      },
    })
    expect(replay).toEqual(first)
    expect(directorySnapshot(directory)).toEqual(afterAttempt)
  })

  it('keeps same-instance and rebuilt-factory binding replay exact and append-free', async () => {
    const directory = temporaryDirectory()
    const { binding, prepared } = await preparedWithLineage(directory, 'manual', 'b-idempotent')
    const input = primaryInput(binding, { objectId: prepared.objectId })
    const lifecycle = await createLifecycle(directory)
    const first = await registerPrimaryOnLifecycle(lifecycle, input)
    const afterFirst = directorySnapshot(directory)
    const replay = await registerPrimaryOnLifecycle(lifecycle, input)
    const afterReplay = directorySnapshot(directory)
    const rebuilt = await registerPrimaryRunContentObject(directory, input)

    expect(first).toEqual({
      status: 'accepted',
      value: {
        claim: binding,
        objectId: prepared.objectId,
        businessRunId: 'business-run-primary',
        businessPeriodId: 'business-period-primary',
        objectClass: 'primary_run_content',
        runLineage: 'external_first',
      },
    })
    expect(replay).toEqual(first)
    expect(rebuilt).toEqual(first)
    expect(afterReplay).toEqual(afterFirst)
    expect(directorySnapshot(directory)).toEqual(afterReplay)
  })

  it.each([
    ['businessRunId', { businessRunId: 'business-run-conflict' }],
    ['businessPeriodId', { businessPeriodId: 'business-period-conflict' }],
    ['objectId', { objectId: 'prepared-object-conflict' }],
  ] as const)('rejects a same technical run binding with a conflicting %s and preserves the first fact', async (_field, change) => {
    const directory = temporaryDirectory()
    const { binding, prepared } = await preparedWithLineage(directory, 'scheduled', `b-conflict-${_field}`)
    const firstInput = primaryInput(binding, { objectId: prepared.objectId })
    await expect(registerPrimaryRunContentObject(directory, firstInput)).resolves.toEqual({
      status: 'accepted',
      value: {
        claim: binding,
        objectId: prepared.objectId,
        businessRunId: 'business-run-primary',
        businessPeriodId: 'business-period-primary',
        objectClass: 'primary_run_content',
        runLineage: 'external_first',
      },
    })
    const conflictingInput = primaryInput(binding, { objectId: prepared.objectId, ...change })
    const before = directorySnapshot(directory)

    await expect(registerPrimaryRunContentObject(directory, conflictingInput)).resolves.toEqual({
      status: 'rejected',
      input: conflictingInput,
    })
    expect(directorySnapshot(directory)).toEqual(before)
  })

  it('rejects reuse of one object id across two technical runs', async () => {
    const directory = temporaryDirectory()
    const first = await preparedWithLineage(directory, 'scheduled', 'b-object-reuse-first', 'shared-object')
    const second = await preparedWithLineage(directory, 'manual', 'b-object-reuse-second', 'shared-object')
    const firstInput = primaryInput(first.binding, { objectId: first.prepared.objectId })
    await expect(registerPrimaryRunContentObject(directory, firstInput)).resolves.toEqual({
      status: 'accepted',
      value: {
        claim: first.binding,
        objectId: first.prepared.objectId,
        businessRunId: 'business-run-primary',
        businessPeriodId: 'business-period-primary',
        objectClass: 'primary_run_content',
        runLineage: 'external_first',
      },
    })
    const secondInput = primaryInput(second.binding, {
      objectId: second.prepared.objectId,
      businessRunId: 'business-run-second',
      businessPeriodId: 'business-period-second',
    })
    const before = directorySnapshot(directory)

    await expect(registerPrimaryRunContentObject(directory, secondInput)).resolves.toEqual({
      status: 'rejected',
      input: secondInput,
    })
    expect(directorySnapshot(directory)).toEqual(before)
  })

  it('rejects a second object for the same business run and period', async () => {
    const directory = temporaryDirectory()
    const first = await preparedWithLineage(directory, 'scheduled', 'b-business-reuse-first')
    const second = await preparedWithLineage(directory, 'manual', 'b-business-reuse-second')
    const firstInput = primaryInput(first.binding, { objectId: first.prepared.objectId })
    await expect(registerPrimaryRunContentObject(directory, firstInput)).resolves.toEqual({
      status: 'accepted',
      value: {
        claim: first.binding,
        objectId: first.prepared.objectId,
        businessRunId: 'business-run-primary',
        businessPeriodId: 'business-period-primary',
        objectClass: 'primary_run_content',
        runLineage: 'external_first',
      },
    })
    const secondInput = primaryInput(second.binding, { objectId: second.prepared.objectId })
    const before = directorySnapshot(directory)

    await expect(registerPrimaryRunContentObject(directory, secondInput)).resolves.toEqual({
      status: 'rejected',
      input: secondInput,
    })
    expect(directorySnapshot(directory)).toEqual(before)
  })

  it('does not copy prepared text into the binding owner record', async () => {
    const directory = temporaryDirectory()
    const { binding, prepared } = await preparedWithLineage(directory, 'scheduled', 'b-no-text')
    const input = primaryInput(binding, { objectId: prepared.objectId })
    await expect(registerPrimaryRunContentObject(directory, input)).resolves.toMatchObject({ status: 'accepted' })

    const ownerBytes = readFileSync(ownerFile(directory), 'utf8')
    expect(ownerBytes).not.toContain(prepared.text)
    const ownerLines = ownerBytes.trim().split('\n').map(line => JSON.parse(line) as unknown)
    expect(ownerLines.every(record => !containsKey(record, 'text'))).toBe(true)
    expect(ownerLines.every(record => !containsKey(record, 'preparedAt'))).toBe(true)
  })
})

function durableClaim(directory: string, trigger: 'scheduled' | 'manual', suffix: string): RunClaimRecord {
  const claim: RunClaimRecord = {
    schemaVersion: 2,
    event: 'claim',
    trigger,
    jobId: `meaning-job-${suffix}`,
    runId: `meaning-run-${suffix}`,
    sessionId: `meaning-session-${suffix}`,
    scheduledFor: '2026-08-24T01:00:00.000Z',
    claimedAt: '2026-08-24T01:00:01.000Z',
  }
  new RunLedger(directory).claim(claim)
  return claim
}

function exactClaimBinding(claim: RunClaimRecord): CronPreparedDeliveryClaimBinding {
  return {
    jobId: claim.jobId,
    runId: claim.runId,
    sessionId: claim.sessionId,
    scheduledFor: claim.scheduledFor,
    claimedAt: claim.claimedAt,
    trigger: claim.trigger ?? 'scheduled',
  }
}

async function createLifecycle(directory: string, extraConfig: Record<string, unknown> = {}): Promise<unknown> {
  const module = await import('../src/run-delivery-meaning.ts') as Record<string, unknown>
  const factory = module.createCronRunDeliveryMeaningLifecycle
  if (typeof factory !== 'function') throw new Error('missing createCronRunDeliveryMeaningLifecycle')
  return (factory as (config: unknown) => unknown)({ storeDir: directory, ...extraConfig })
}

async function registerOnLifecycle(lifecycle: unknown, binding: unknown): Promise<unknown> {
  const register = lifecycle !== null && typeof lifecycle === 'object'
    ? Reflect.get(lifecycle, 'registerExternalFirstLineage')
    : undefined
  if (typeof register !== 'function') throw new Error('missing registerExternalFirstLineage')
  return await Reflect.apply(register, lifecycle, [binding])
}

async function registerExternalFirstLineage(directory: string, binding: unknown): Promise<unknown> {
  return registerOnLifecycle(await createLifecycle(directory), binding)
}

async function registerPrimaryRunContentObject(directory: string, input: unknown): Promise<unknown> {
  const lifecycle = await createLifecycle(directory)
  return registerPrimaryOnLifecycle(lifecycle, input)
}

async function registerPrimaryOnLifecycle(lifecycle: unknown, input: unknown): Promise<unknown> {
  const register = lifecycle !== null && typeof lifecycle === 'object'
    ? Reflect.get(lifecycle, 'registerPrimaryRunContentObject')
    : undefined
  if (typeof register !== 'function') throw new Error('missing registerPrimaryRunContentObject')
  return await Reflect.apply(register, lifecycle, [input])
}

async function acceptDeliveryReceiptOnLifecycle(lifecycle: unknown, input: unknown): Promise<unknown> {
  const accept = lifecycle !== null && typeof lifecycle === 'object'
    ? Reflect.get(lifecycle, 'acceptDeliveryReceipt')
    : undefined
  if (typeof accept !== 'function') throw new Error('missing acceptDeliveryReceipt')
  return await Reflect.apply(accept, lifecycle, [input])
}

async function recordBusinessFinalizationOnLifecycle(lifecycle: unknown, input: unknown): Promise<unknown> {
  const record = lifecycle !== null && typeof lifecycle === 'object'
    ? Reflect.get(lifecycle, 'recordPrimaryRunContentBusinessFinalization')
    : undefined
  if (typeof record !== 'function') throw new Error('missing recordPrimaryRunContentBusinessFinalization')
  return await Reflect.apply(record, lifecycle, [input])
}

async function acceptDeliveryReceipt(directory: string, input: unknown, extraConfig: Record<string, unknown> = {}): Promise<unknown> {
  return acceptDeliveryReceiptOnLifecycle(await createLifecycle(directory, extraConfig), input)
}

function durablePreparedClaim(
  directory: string,
  trigger: 'scheduled' | 'manual',
  suffix: string,
  objectId = `prepared-object-${suffix}`,
): { readonly claim: RunClaimRecord; readonly binding: CronPreparedDeliveryClaimBinding; readonly prepared: RunPreparedDeliveryRecord } {
  const claim: RunClaimRecord = {
    schemaVersion: 2,
    event: 'claim',
    trigger,
    jobId: `meaning-job-${suffix}`,
    runId: `meaning-run-${suffix}`,
    sessionId: `meaning-session-${suffix}`,
    scheduledFor: '2026-08-24T02:00:00.000Z',
    claimedAt: '2026-08-24T02:00:01.000Z',
    agentEnvironment: 'b-primary/v1',
    deliveryLifecycle: 'prepared',
  }
  const binding = exactClaimBinding(claim)
  const prepared: RunPreparedDeliveryRecord = {
    schemaVersion: 2,
    event: 'prepared-delivery',
    jobId: claim.jobId,
    runId: claim.runId,
    sessionId: claim.sessionId,
    scheduledFor: claim.scheduledFor,
    preparedAt: '2026-08-24T02:00:02.000Z',
    objectId,
    text: `opaque prepared text ${suffix}`,
  }
  const ledger = new RunLedger(directory)
  ledger.claim(claim)
  ledger.prepareDelivery(prepared)
  return { claim, binding, prepared }
}

function durablePreparedClaimOnly(
  directory: string,
  trigger: 'scheduled' | 'manual',
  suffix: string,
): { readonly claim: RunClaimRecord; readonly binding: CronPreparedDeliveryClaimBinding } {
  const claim: RunClaimRecord = {
    schemaVersion: 2,
    event: 'claim',
    trigger,
    jobId: `meaning-job-${suffix}`,
    runId: `meaning-run-${suffix}`,
    sessionId: `meaning-session-${suffix}`,
    scheduledFor: '2026-08-24T02:00:00.000Z',
    claimedAt: '2026-08-24T02:00:01.000Z',
    agentEnvironment: 'b-primary/v1',
    deliveryLifecycle: 'prepared',
  }
  new RunLedger(directory).claim(claim)
  return { claim, binding: exactClaimBinding(claim) }
}

function appendAttemptAndReceipt(directory: string, prepared: RunPreparedDeliveryRecord): void {
  const attempt: RunDeliveryAttemptClaimRecord = {
    schemaVersion: 2,
    event: 'delivery-attempt-claim',
    jobId: prepared.jobId,
    runId: prepared.runId,
    sessionId: prepared.sessionId,
    scheduledFor: prepared.scheduledFor,
    claimedAt: '2026-08-24T02:00:03.000Z',
    objectId: prepared.objectId,
  }
  const receipt: RunDeliveryReceiptRecord = {
    schemaVersion: 2,
    event: 'delivery-receipt',
    jobId: prepared.jobId,
    runId: prepared.runId,
    sessionId: prepared.sessionId,
    scheduledFor: prepared.scheduledFor,
    objectId: prepared.objectId,
    deliveryState: 'delivered',
    receiptAt: '2026-08-24T02:00:04.000Z',
  }
  const ledger = new RunLedger(directory)
  ledger.claimDeliveryAttempt(attempt)
  ledger.recordDeliveryReceipt(receipt)
}

function appendAttemptOnly(directory: string, prepared: RunPreparedDeliveryRecord): void {
  new RunLedger(directory).claimDeliveryAttempt({
    schemaVersion: 2,
    event: 'delivery-attempt-claim',
    jobId: prepared.jobId,
    runId: prepared.runId,
    sessionId: prepared.sessionId,
    scheduledFor: prepared.scheduledFor,
    claimedAt: '2026-08-24T02:00:03.000Z',
    objectId: prepared.objectId,
  })
}

function appendAttemptAndReceiptState(
  directory: string,
  prepared: RunPreparedDeliveryRecord,
  deliveryState: 'delivered' | 'failed' | 'uncertain',
): RunDeliveryReceiptRecord {
  const receipt: RunDeliveryReceiptRecord = {
    schemaVersion: 2,
    event: 'delivery-receipt',
    jobId: prepared.jobId,
    runId: prepared.runId,
    sessionId: prepared.sessionId,
    scheduledFor: prepared.scheduledFor,
    objectId: prepared.objectId,
    deliveryState,
    receiptAt: '2026-08-24T02:00:04.000Z',
    ...(deliveryState === 'delivered'
      ? { deliveredAt: '2026-08-24T02:00:04.000Z' }
      : { deliveryError: `durable ${deliveryState} evidence` }),
  }
  const ledger = new RunLedger(directory)
  ledger.claimDeliveryAttempt({
    schemaVersion: 2,
    event: 'delivery-attempt-claim',
    jobId: prepared.jobId,
    runId: prepared.runId,
    sessionId: prepared.sessionId,
    scheduledFor: prepared.scheduledFor,
    claimedAt: '2026-08-24T02:00:03.000Z',
    objectId: prepared.objectId,
  })
  ledger.recordDeliveryReceipt(receipt)
  return receipt
}

function receiptInputFromDurableRow(
  directory: string,
  runId: string,
): { readonly receipt: CronDeliveryReceipt; readonly record: RunDeliveryReceiptRecord; readonly raw: string } {
  const raw = readFileSync(runsFile(directory), 'utf8').trim().split('\n').find(line => {
    const record = JSON.parse(line) as Record<string, unknown>
    return record.event === 'delivery-receipt' && record.runId === runId
  })
  if (raw === undefined) throw new Error(`missing durable receipt for ${runId}`)
  const record = JSON.parse(raw) as RunDeliveryReceiptRecord
  const { schemaVersion: _schemaVersion, event: _event, receiptAt: _receiptAt, ...receipt } = record
  return { receipt, record, raw }
}

function durableReceiptDigest(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

function removeRunEvents(directory: string, predicate: (record: Record<string, unknown>) => boolean): void {
  const lines = readFileSync(runsFile(directory), 'utf8').trim().split('\n')
  const kept = lines.filter(line => !predicate(JSON.parse(line) as Record<string, unknown>))
  writeFileSync(runsFile(directory), `${kept.join('\n')}\n`, 'utf8')
}

function appendPrefinishAck(directory: string, receipt: RunDeliveryReceiptRecord): void {
  const { schemaVersion: _schemaVersion, event: _event, receiptAt: _receiptAt, ...receiptFields } = receipt
  const acknowledgement: RunEnvironmentPrefinishSettleRecord = {
    schemaVersion: 2,
    event: 'environment-prefinish-settle',
    ...receiptFields,
    settledAt: '2026-08-24T02:00:05.000Z',
  }
  new RunLedger(directory).environmentPrefinishSettled(acknowledgement)
}

function appendSuccessfulFinish(
  directory: string,
  binding: CronPreparedDeliveryClaimBinding,
  receipt: RunDeliveryReceiptRecord,
): void {
  const finish: RunFinishRecord = {
    schemaVersion: 2,
    event: 'finish',
    trigger: binding.trigger,
    jobId: binding.jobId,
    runId: binding.runId,
    sessionId: binding.sessionId,
    scheduledFor: binding.scheduledFor,
    startedAt: binding.claimedAt,
    finishedAt: '2026-08-24T02:00:06.000Z',
    status: 'success',
    deliveryState: receipt.deliveryState,
    ...(receipt.deliveredAt === undefined ? {} : { deliveredAt: receipt.deliveredAt }),
    ...(receipt.deliveryError === undefined ? {} : { deliveryError: receipt.deliveryError }),
  }
  new RunLedger(directory).finish(finish)
}

function expectedReceiptAcceptance(
  receipt: CronDeliveryReceipt,
  binding: Record<string, unknown>,
  deliveryState: 'delivered' | 'failed' | 'uncertain',
  receiptDigest: string,
): Record<string, unknown> {
  return {
    status: 'accepted',
    value: {
      receipt,
      binding,
      retry: deliveryState === 'failed'
        ? {
            status: 'authorized',
            category: 'primary_run_content_delivery_failed',
            authorization: { binding, receiptDigest },
            readiness: 'not_ready',
          }
        : { status: 'not_authorized' },
    },
  }
}

function acceptedMeaningValue(result: unknown): Record<string, unknown> {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) throw new Error('accepted result is not an object')
  const value = Reflect.get(result, 'value')
  if (Reflect.get(result, 'status') !== 'accepted' || typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('result is not an accepted meaning')
  }
  return value as Record<string, unknown>
}

function primaryAcceptedBinding(input: Record<string, unknown>): Record<string, unknown> {
  return {
    ...input,
    objectClass: 'primary_run_content',
    runLineage: 'external_first',
  }
}

async function durableReceiptMeaningFixture(
  directory: string,
  trigger: 'scheduled' | 'manual',
  deliveryState: 'delivered' | 'failed' | 'uncertain',
  suffix: string,
): Promise<{
  readonly binding: CronPreparedDeliveryClaimBinding
  readonly primaryBinding: Record<string, unknown>
  readonly receipt: CronDeliveryReceipt
  readonly receiptRecord: RunDeliveryReceiptRecord
  readonly receiptDigest: string
}> {
  const state = await preparedWithPrimaryOwner(directory, trigger, suffix)
  appendAttemptAndReceiptState(directory, state.prepared, deliveryState)
  const durable = receiptInputFromDurableRow(directory, state.binding.runId)
  return {
    binding: state.binding,
    primaryBinding: primaryAcceptedBinding(state.input),
    receipt: durable.receipt,
    receiptRecord: durable.record,
    receiptDigest: durableReceiptDigest(durable.raw),
  }
}

async function acceptedReceiptMeaningFixture(
  directory: string,
  trigger: 'scheduled' | 'manual',
  deliveryState: 'delivered' | 'failed' | 'uncertain',
  suffix: string,
): Promise<Awaited<ReturnType<typeof durableReceiptMeaningFixture>> & {
  readonly input: { readonly receipt: CronDeliveryReceipt }
}> {
  const fixture = await durableReceiptMeaningFixture(directory, trigger, deliveryState, suffix)
  const input = { receipt: fixture.receipt }
  await expect(acceptDeliveryReceipt(directory, input)).resolves.toEqual(
    expectedReceiptAcceptance(fixture.receipt, fixture.primaryBinding, deliveryState, fixture.receiptDigest),
  )
  return { ...fixture, input }
}

function expectedFinalizationAcceptance(
  binding: Record<string, unknown>,
  deliveryState: 'delivered' | 'failed' | 'uncertain',
  receiptDigest: string,
): Record<string, unknown> {
  return {
    status: 'accepted',
    value: {
      binding,
      retry: deliveryState === 'failed'
        ? {
            status: 'authorized',
            category: 'primary_run_content_delivery_failed',
            authorization: { binding, receiptDigest },
            readiness: 'ready',
          }
        : { status: 'not_authorized' },
    },
  }
}

async function acceptedFinalizationFixture(
  directory: string,
  trigger: 'scheduled' | 'manual',
  deliveryState: 'delivered' | 'failed' | 'uncertain',
  suffix: string,
): Promise<Awaited<ReturnType<typeof acceptedReceiptMeaningFixture>> & {
  readonly finalizationInput: { readonly binding: Record<string, unknown> }
}> {
  const fixture = await acceptedReceiptMeaningFixture(directory, trigger, deliveryState, suffix)
  const finalizationInput = { binding: fixture.primaryBinding }
  await expect(recordBusinessFinalizationOnLifecycle(await createLifecycle(directory), finalizationInput)).resolves.toEqual(
    expectedFinalizationAcceptance(fixture.primaryBinding, deliveryState, fixture.receiptDigest),
  )
  return { ...fixture, finalizationInput }
}

function primaryInput(
  binding: CronPreparedDeliveryClaimBinding,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    claim: binding,
    objectId: 'prepared-object-primary',
    businessRunId: 'business-run-primary',
    businessPeriodId: 'business-period-primary',
    ...overrides,
  }
}

function containsKey(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some(item => containsKey(item, key))
  if (typeof value !== 'object' || value === null) return false
  return Object.entries(value).some(([name, child]) => name === key || containsKey(child, key))
}

async function preparedWithLineage(
  directory: string,
  trigger: 'scheduled' | 'manual',
  suffix: string,
  objectId?: string,
): Promise<ReturnType<typeof durablePreparedClaim>> {
  const state = durablePreparedClaim(directory, trigger, suffix, objectId)
  await expect(registerExternalFirstLineage(directory, state.binding)).resolves.toEqual({
    status: 'accepted',
    value: { claim: state.binding, runLineage: 'external_first' },
  })
  return state
}

async function preparedWithPrimaryOwner(
  directory: string,
  trigger: 'scheduled' | 'manual',
  suffix: string,
): Promise<{ readonly binding: CronPreparedDeliveryClaimBinding; readonly prepared: RunPreparedDeliveryRecord; readonly input: Record<string, unknown> }> {
  const state = await preparedWithLineage(directory, trigger, suffix)
  const input = primaryInput(state.binding, { objectId: state.prepared.objectId })
  await expect(registerPrimaryRunContentObject(directory, input)).resolves.toEqual({
    status: 'accepted',
    value: {
      claim: state.binding,
      objectId: state.prepared.objectId,
      businessRunId: 'business-run-primary',
      businessPeriodId: 'business-period-primary',
      objectClass: 'primary_run_content',
      runLineage: 'external_first',
    },
  })
  return { binding: state.binding, prepared: state.prepared, input }
}

function ownerRows(directory: string): { readonly path: string; readonly lines: string[]; readonly records: Array<Record<string, unknown>> } {
  const path = ownerFile(directory)
  const lines = readFileSync(path, 'utf8').trim().split('\n')
  return { path, lines, records: lines.map(line => JSON.parse(line) as Record<string, unknown>) }
}

function primaryOwnerRow(directory: string): { readonly path: string; readonly lines: string[]; readonly record: Record<string, unknown>; readonly index: number } {
  const rows = ownerRows(directory)
  const index = rows.records.findIndex(record => record.objectClass === 'primary_run_content')
  if (index < 0) throw new Error('missing production primary owner row')
  return { path: rows.path, lines: rows.lines, record: rows.records[index], index }
}

function meaningOwnerRow(directory: string): { readonly path: string; readonly lines: string[]; readonly record: Record<string, unknown>; readonly index: number } {
  const rows = ownerRows(directory)
  const index = rows.records.findIndex(record => record.event === 'run-delivery-meaning')
  if (index < 0) throw new Error('missing production meaning owner row')
  const record = rows.records[index]
  if (record === undefined) throw new Error('missing production meaning owner record')
  return { path: rows.path, lines: rows.lines, record, index }
}

function finalizationOwnerRow(directory: string): { readonly path: string; readonly lines: string[]; readonly record: Record<string, unknown>; readonly index: number } {
  const rows = ownerRows(directory)
  const index = rows.records.length - 1
  if (index < 0) throw new Error('missing production finalization owner row')
  const record = rows.records[index]
  if (record === undefined) throw new Error('missing production finalization owner record')
  return { path: rows.path, lines: rows.lines, record, index }
}

function rewriteFinalizationOwnerRow(
  directory: string,
  mutate: (record: Record<string, unknown>) => Record<string, unknown>,
): void {
  const row = finalizationOwnerRow(directory)
  const lines = [...row.lines]
  lines[row.index] = JSON.stringify(mutate(row.record))
  writeFileSync(row.path, `${lines.join('\n')}\n`, 'utf8')
}

function rewriteFinalizationOwnerRaw(directory: string, mutate: (raw: string) => string): void {
  const row = finalizationOwnerRow(directory)
  const raw = row.lines[row.index]
  if (raw === undefined) throw new Error('missing finalization owner line')
  const lines = [...row.lines]
  lines[row.index] = mutate(raw)
  writeFileSync(row.path, `${lines.join('\n')}\n`, 'utf8')
}

function rewriteMeaningOwnerRow(
  directory: string,
  mutate: (record: Record<string, unknown>) => Record<string, unknown>,
): void {
  const row = meaningOwnerRow(directory)
  const lines = [...row.lines]
  lines[row.index] = JSON.stringify(mutate(row.record))
  writeFileSync(row.path, `${lines.join('\n')}\n`, 'utf8')
}

function rewriteMeaningOwnerRaw(directory: string, mutate: (raw: string) => string): void {
  const row = meaningOwnerRow(directory)
  const raw = row.lines[row.index]
  if (raw === undefined) throw new Error('missing meaning owner line')
  const lines = [...row.lines]
  lines[row.index] = mutate(raw)
  writeFileSync(row.path, `${lines.join('\n')}\n`, 'utf8')
}

function rewriteRunReceiptRow(
  directory: string,
  runId: string,
  mutate: (record: Record<string, unknown>) => Record<string, unknown>,
): void {
  const path = runsFile(directory)
  const lines = readFileSync(path, 'utf8').trim().split('\n')
  const index = lines.findIndex(raw => {
    const record = JSON.parse(raw) as Record<string, unknown>
    return record.event === 'delivery-receipt' && record.runId === runId
  })
  if (index < 0) throw new Error('missing production receipt row')
  const raw = lines[index]
  if (raw === undefined) throw new Error('missing production receipt line')
  lines[index] = JSON.stringify(mutate(JSON.parse(raw) as Record<string, unknown>))
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8')
}

function rewriteRunReceiptRaw(directory: string, runId: string, mutate: (raw: string) => string): void {
  const path = runsFile(directory)
  const lines = readFileSync(path, 'utf8').trim().split('\n')
  const index = lines.findIndex(raw => {
    const record = JSON.parse(raw) as Record<string, unknown>
    return record.event === 'delivery-receipt' && record.runId === runId
  })
  if (index < 0) throw new Error('missing production receipt line')
  const raw = lines[index]
  if (raw === undefined) throw new Error('missing production receipt raw line')
  lines[index] = mutate(raw)
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8')
}

function rewriteRunRow(
  directory: string,
  predicate: (record: Record<string, unknown>) => boolean,
  mutate: (record: Record<string, unknown>) => Record<string, unknown>,
): void {
  const path = runsFile(directory)
  const lines = readFileSync(path, 'utf8').trim().split('\n')
  const index = lines.findIndex(raw => predicate(JSON.parse(raw) as Record<string, unknown>))
  if (index < 0) throw new Error('missing production run row')
  const raw = lines[index]
  if (raw === undefined) throw new Error('missing production run line')
  lines[index] = JSON.stringify(mutate(JSON.parse(raw) as Record<string, unknown>))
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8')
}

function runsFile(directory: string): string {
  return join(directory, 'runs.jsonl')
}

function ownerFile(directory: string): string {
  const files = readdirSync(directory)
    .map(name => join(directory, name))
    .filter(path => path !== runsFile(directory) && statSync(path).isFile())
  if (files.length !== 1) throw new Error(`expected one production owner file, found ${files.length}`)
  return files[0]
}

function ownerRecord(directory: string): Record<string, unknown> {
  const line = readFileSync(ownerFile(directory), 'utf8').trim()
  return JSON.parse(line) as Record<string, unknown>
}

function directorySnapshot(directory: string): Record<string, string> {
  const snapshot: Record<string, string> = {}
  const visit = (current: string, relative: string): void => {
    for (const name of readdirSync(current)) {
      const absolute = join(current, name)
      const child = relative === '' ? name : `${relative}/${name}`
      if (statSync(absolute).isDirectory()) visit(absolute, child)
      else snapshot[child] = readFileSync(absolute).toString('base64')
    }
  }
  visit(directory, '')
  return snapshot
}

describe('generic run-delivery meaning integration port', () => {
  it('exports a strict factory from the package-internal module', async () => {
    const module = await import('../src/run-delivery-meaning.ts') as {
      readonly createCronRunDeliveryMeaningLifecycle?: unknown
    }

    expect(module.createCronRunDeliveryMeaningLifecycle).toEqual(expect.any(Function))
  })

  it('keeps the bootstrap port fail-closed until the durable owner exists', async () => {
    const module = await import('../src/run-delivery-meaning.ts') as {
      readonly createCronRunDeliveryMeaningLifecycle?: unknown
    }
    const factory = module.createCronRunDeliveryMeaningLifecycle as ((config: { readonly storeDir: string }) => {
      readonly acceptDeliveryReceipt: (input: unknown) => unknown
    })
    const directory = temporaryDirectory()
    const lifecycle = factory({ storeDir: directory })
    const input = {
      receipt: {
        objectId: 'bootstrap-object',
        jobId: 'bootstrap-job',
        runId: 'bootstrap-run',
        sessionId: 'bootstrap-session',
        scheduledFor: '2026-08-24T00:00:00.000Z',
        deliveryState: 'delivered',
      },
    }
    const before = directorySnapshot(directory)

    await expect(lifecycle.acceptDeliveryReceipt(input)).toEqual({
      status: 'rejected',
      input,
    })
    expect(directorySnapshot(directory)).toEqual(before)
  })

  it.each([
    ['scheduled', 'scheduled-lineage'],
    ['manual', 'manual-lineage'],
  ] as const)('derives external_first from the exact %s durable claim only', async (trigger, suffix) => {
    const directory = temporaryDirectory()
    const claim = durableClaim(directory, trigger, suffix)
    const binding = exactClaimBinding(claim)

    await expect(registerExternalFirstLineage(directory, binding)).resolves.toEqual({
      status: 'accepted',
      value: { claim: binding, runLineage: 'external_first' },
    })
  })

  it('rejects a binding when the durable claim does not exist and leaves no registration fact', async () => {
    const directory = temporaryDirectory()
    const binding = {
      jobId: 'missing-job',
      runId: 'missing-run',
      sessionId: 'missing-session',
      scheduledFor: '2026-08-24T01:00:00.000Z',
      claimedAt: '2026-08-24T01:00:01.000Z',
      trigger: 'scheduled',
    } as const
    const before = directorySnapshot(directory)

    await expect(registerExternalFirstLineage(directory, binding)).resolves.toEqual({
      status: 'rejected',
      input: binding,
    })
    expect(directorySnapshot(directory)).toEqual(before)
  })

  it.each([
    'jobId',
    'runId',
    'sessionId',
    'scheduledFor',
    'claimedAt',
    'trigger',
  ] as const)('rejects a claim binding whose %s differs from the durable claim', async field => {
    const directory = temporaryDirectory()
    const claim = durableClaim(directory, 'scheduled', `mismatch-${field}`)
    const binding = {
      ...exactClaimBinding(claim),
      [field]: field === 'trigger'
        ? 'manual'
        : `${claim[field]}-foreign`,
    }
    const before = directorySnapshot(directory)

    await expect(registerExternalFirstLineage(directory, binding)).resolves.toEqual({
      status: 'rejected',
      input: binding,
    })
    expect(directorySnapshot(directory)).toEqual(before)
  })

  it('fails an unknown trigger mutation of a real durable claim instead of deriving lineage', async () => {
    const directory = temporaryDirectory()
    const claim = durableClaim(directory, 'scheduled', 'invalid-trigger')
    const binding = exactClaimBinding(claim)
    const [line] = readFileSync(runsFile(directory), 'utf8').trim().split('\n')
    const mutated = JSON.parse(line) as Record<string, unknown>
    mutated.trigger = 'future-trigger'
    writeFileSync(runsFile(directory), `${JSON.stringify(mutated)}\n`, 'utf8')
    const before = directorySnapshot(directory)

    await expect(registerExternalFirstLineage(directory, binding)).resolves.toEqual({
      status: 'failed',
      input: binding,
    })
    expect(directorySnapshot(directory)).toEqual(before)
  })

  it('fails a malformed claim mutation from a real durable claim without writing', async () => {
    const directory = temporaryDirectory()
    const claim = durableClaim(directory, 'manual', 'malformed-claim')
    const binding = exactClaimBinding(claim)
    const [line] = readFileSync(runsFile(directory), 'utf8').trim().split('\n')
    const mutated = JSON.parse(line) as Record<string, unknown>
    delete mutated.sessionId
    writeFileSync(runsFile(directory), `${JSON.stringify(mutated)}\n`, 'utf8')
    const before = directorySnapshot(directory)

    await expect(registerExternalFirstLineage(directory, binding)).resolves.toEqual({
      status: 'failed',
      input: binding,
    })
    expect(directorySnapshot(directory)).toEqual(before)
  })

  it.each([
    ['malformed JSON', (line: string, _record: Record<string, unknown>) => `${line.slice(0, -1)}broken`],
    ['missing field', (_line: string, record: Record<string, unknown>) => {
      const mutated = { ...record }
      delete mutated.runLineage
      return JSON.stringify(mutated)
    }],
    ['extra field', (_line: string, record: Record<string, unknown>) => JSON.stringify({ ...record, extra: true })],
    ['wrong nested field', (_line: string, record: Record<string, unknown>) => JSON.stringify({
      ...record,
      claim: { ...(record.claim as Record<string, unknown>), runId: 'foreign-run' },
    })],
    ['duplicate exact row', (line: string, _record: Record<string, unknown>) => `${line}\n${line}`],
    ['duplicate conflicting same-run row', (line: string, record: Record<string, unknown>) => `${line}\n${JSON.stringify({
      ...record,
      claim: { ...(record.claim as Record<string, unknown>), sessionId: 'foreign-session' },
    })}`],
  ] as const)('fails closed on production owner row %s without writing over it', async (_name, mutate) => {
    const directory = temporaryDirectory()
    const claim = durableClaim(directory, 'scheduled', `owner-row-${_name.replaceAll(' ', '-')}`)
    const binding = exactClaimBinding(claim)
    await expect(registerExternalFirstLineage(directory, binding)).resolves.toEqual({
      status: 'accepted',
      value: { claim: binding, runLineage: 'external_first' },
    })

    const path = ownerFile(directory)
    const originalLine = readFileSync(path, 'utf8').trim()
    const originalRecord = ownerRecord(directory)
    writeFileSync(path, `${mutate(originalLine, originalRecord)}\n`, 'utf8')
    const before = directorySnapshot(directory)

    await expect(registerExternalFirstLineage(directory, binding)).resolves.toEqual({
      status: 'failed',
      input: binding,
    })
    expect(directorySnapshot(directory)).toEqual(before)
  })

  it('returns failed and leaves the full directory unchanged when owner append throws before writing', async () => {
    const directory = temporaryDirectory()
    const claim = durableClaim(directory, 'manual', 'append-before')
    const binding = exactClaimBinding(claim)
    vi.spyOn(JsonlStore.prototype, 'append').mockImplementationOnce(() => {
      throw new Error('owner append failed before write')
    })
    const before = directorySnapshot(directory)

    await expect(registerExternalFirstLineage(directory, binding)).resolves.toEqual({
      status: 'failed',
      input: binding,
    })
    expect(directorySnapshot(directory)).toEqual(before)
  })

  it('reads back an owner fact when append throws after the exact row landed', async () => {
    const directory = temporaryDirectory()
    const claim = durableClaim(directory, 'scheduled', 'append-after')
    const binding = exactClaimBinding(claim)
    const append = JsonlStore.prototype.append
    vi.spyOn(JsonlStore.prototype, 'append').mockImplementationOnce(function (this: JsonlStore, record: unknown) {
      append.call(this, record)
      throw new Error('owner append failed after write')
    })

    await expect(registerExternalFirstLineage(directory, binding)).resolves.toEqual({
      status: 'accepted',
      value: { claim: binding, runLineage: 'external_first' },
    })
    const afterFirst = directorySnapshot(directory)
    await expect(registerExternalFirstLineage(directory, binding)).resolves.toEqual({
      status: 'accepted',
      value: { claim: binding, runLineage: 'external_first' },
    })
    expect(directorySnapshot(directory)).toEqual(afterFirst)
  })

  it('keeps exact registration idempotent across repeated calls and a factory/store rebuild', async () => {
    const directory = temporaryDirectory()
    const claim = durableClaim(directory, 'manual', 'idempotent')
    const binding = exactClaimBinding(claim)

    const lifecycle = await createLifecycle(directory)
    const first = await registerOnLifecycle(lifecycle, binding)
    const afterFirst = directorySnapshot(directory)
    const replay = await registerOnLifecycle(lifecycle, binding)
    expect(directorySnapshot(directory)).toEqual(afterFirst)
    const rebuilt = await registerExternalFirstLineage(directory, binding)
    expect(directorySnapshot(directory)).toEqual(afterFirst)

    expect(first).toEqual({
      status: 'accepted',
      value: { claim: binding, runLineage: 'external_first' },
    })
    expect(replay).toEqual(first)
    expect(rebuilt).toEqual(first)
  })

  it('rejects caller-supplied lineage and retry policy instead of ignoring them', async () => {
    const directory = temporaryDirectory()
    const claim = durableClaim(directory, 'scheduled', 'caller-fields')
    const before = directorySnapshot(directory)

    const binding = {
      ...exactClaimBinding(claim),
      runLineage: 'external_first',
      retryEligible: true,
      isFirstRun: true,
    }
    await expect(registerExternalFirstLineage(directory, binding)).resolves.toEqual({
      status: 'rejected',
      input: binding,
    })
    expect(directorySnapshot(directory)).toEqual(before)
  })
})

describe('C2 finalization bootstrap RED', () => {
  it('exposes the package-internal business-finalization registration seam for a full B binding', async () => {
    const directory = temporaryDirectory()
    const fixture = await preparedWithPrimaryOwner(directory, 'manual', 'c2-bootstrap-finalization')
    const lifecycle = await createLifecycle(directory)
    const binding = primaryAcceptedBinding(fixture.input)
    const finalizationInput = { binding }
    expect(finalizationInput).toEqual({ binding })

    const recordFinalization = lifecycle !== null && typeof lifecycle === 'object'
      ? Reflect.get(lifecycle, 'recordPrimaryRunContentBusinessFinalization')
      : undefined

    expect(recordFinalization).toEqual(expect.any(Function))
  })
})

describe('C2 finalization core RED', () => {
  it.each([
    ['scheduled', 'delivered', 'c2-scheduled-delivered'],
    ['scheduled', 'failed', 'c2-scheduled-failed'],
    ['scheduled', 'uncertain', 'c2-scheduled-uncertain'],
    ['manual', 'delivered', 'c2-manual-delivered'],
    ['manual', 'failed', 'c2-manual-failed'],
    ['manual', 'uncertain', 'c2-manual-uncertain'],
  ] as const)('records %s %s business finalization from the exact C1 receipt meaning', async (trigger, deliveryState, suffix) => {
    const directory = temporaryDirectory()
    const fixture = await acceptedReceiptMeaningFixture(directory, trigger, deliveryState, suffix)
    const binding = fixture.primaryBinding
    const finalizationInput = { binding }
    const requestFailureNotification = vi.fn()
    const lifecycle = await createLifecycle(directory, { requestFailureNotification })
    const beforeOwnerLines = ownerRows(directory).lines

    const currentRetry = deliveryState === 'failed'
      ? {
          status: 'authorized',
          category: 'primary_run_content_delivery_failed',
          authorization: { binding, receiptDigest: fixture.receiptDigest },
          readiness: 'not_ready',
        }
      : { status: 'not_authorized' }
    const currentReceiptResult = await acceptDeliveryReceiptOnLifecycle(lifecycle, fixture.input)
    expect(currentReceiptResult).toEqual(expectedReceiptAcceptance(
      fixture.receipt,
      binding,
      deliveryState,
      fixture.receiptDigest,
    ))
    expect(acceptedMeaningValue(currentReceiptResult).retry).toEqual(currentRetry)

    const finalizationRetry = deliveryState === 'failed'
      ? {
          status: 'authorized',
          category: 'primary_run_content_delivery_failed',
          authorization: { binding, receiptDigest: fixture.receiptDigest },
          readiness: 'ready',
        }
      : { status: 'not_authorized' }
    const expected = {
      status: 'accepted',
      value: { binding, retry: finalizationRetry },
    }
    const expectedPostFinalizationReceipt = {
      status: 'accepted',
      value: { receipt: fixture.receipt, binding, retry: finalizationRetry },
    }
    const first = await recordBusinessFinalizationOnLifecycle(lifecycle, finalizationInput)
    expect(first).toEqual(expected)
    const firstValue = acceptedMeaningValue(first)
    expect(firstValue.binding).toBe(binding)
    if (deliveryState === 'failed') {
      const retry = firstValue.retry
      if (typeof retry !== 'object' || retry === null || Array.isArray(retry)) throw new Error('missing finalization retry')
      const authorization = Reflect.get(retry, 'authorization')
      if (typeof authorization !== 'object' || authorization === null || Array.isArray(authorization)) {
        throw new Error('missing finalization authorization')
      }
      expect(Reflect.get(authorization, 'binding')).toBe(binding)
      expect(Reflect.get(retry, 'readiness')).toBe('ready')
    }

    const afterFirst = directorySnapshot(directory)
    const afterOwnerLines = ownerRows(directory).lines
    expect(afterOwnerLines).toHaveLength(beforeOwnerLines.length + 1)
    const finalizationRecord = ownerRows(directory).records.at(-1)
    if (finalizationRecord === undefined) throw new Error('missing finalization owner row')
    expect(finalizationRecord).toMatchObject({
      claim: binding.claim,
      objectId: binding.objectId,
      businessRunId: binding.businessRunId,
      businessPeriodId: binding.businessPeriodId,
    })
    for (const forbiddenKey of [
      'deliveryState',
      'deliveredAt',
      'deliveryError',
      'receiptDigest',
      'text',
      'receipt',
      'retry',
      'authorization',
      'retryEligible',
      'policy',
      'kind',
      'ordinary',
    ]) expect(containsKey(finalizationRecord, forbiddenKey)).toBe(false)
    expect(JSON.stringify(finalizationRecord)).not.toContain(fixture.receiptDigest)
    expect(requestFailureNotification).not.toHaveBeenCalled()

    const finalizedReceipt = await acceptDeliveryReceiptOnLifecycle(lifecycle, fixture.input)
    expect(finalizedReceipt).toEqual(expectedPostFinalizationReceipt)

    const replay = await recordBusinessFinalizationOnLifecycle(lifecycle, finalizationInput)
    expect(replay).toEqual(first)
    expect(directorySnapshot(directory)).toEqual(afterFirst)

    const rebuilt = await createLifecycle(directory, { requestFailureNotification })
    const rebuiltReceipt = await acceptDeliveryReceiptOnLifecycle(rebuilt, fixture.input)
    expect(rebuiltReceipt).toEqual(expectedPostFinalizationReceipt)
    const rebuiltFinalization = await recordBusinessFinalizationOnLifecycle(rebuilt, finalizationInput)
    expect(rebuiltFinalization).toEqual(first)
    expect(acceptedMeaningValue(rebuiltFinalization).binding).toBe(binding)
    expect(directorySnapshot(directory)).toEqual(afterFirst)
    expect(requestFailureNotification).not.toHaveBeenCalled()
  })
})

describe('C2 finalization negative and order RED', () => {
  it.each([
    ['extra top-level field', (binding: Record<string, unknown>) => ({ binding, extra: true })],
    ['missing binding', (_binding: Record<string, unknown>) => ({})],
    ['non-object input', (_binding: Record<string, unknown>) => null],
    ['null binding', (_binding: Record<string, unknown>) => ({ binding: null })],
    ['binding extra field', (binding: Record<string, unknown>) => ({ binding: { ...binding, extra: true } })],
    ['binding missing claim', (binding: Record<string, unknown>) => {
      const { claim: _claim, ...withoutClaim } = binding
      return { binding: withoutClaim }
    }],
    ['binding.claim extra field', (binding: Record<string, unknown>) => ({
      binding: { ...binding, claim: { ...(binding.claim as Record<string, unknown>), extra: true } },
    })],
    ['binding.claim missing claimedAt', (binding: Record<string, unknown>) => {
      const { claimedAt: _claimedAt, ...withoutClaimedAt } = binding.claim as Record<string, unknown>
      return { binding: { ...binding, claim: withoutClaimedAt } }
    }],
    ['wrong objectClass', (binding: Record<string, unknown>) => ({ binding: { ...binding, objectClass: 'foreign' } })],
    ['wrong runLineage', (binding: Record<string, unknown>) => ({ binding: { ...binding, runLineage: 'foreign' } })],
    ['objectId non-string', (binding: Record<string, unknown>) => ({ binding: { ...binding, objectId: 42 } })],
    ['objectId blank', (binding: Record<string, unknown>) => ({ binding: { ...binding, objectId: '   ' } })],
    ['objectId oversize', (binding: Record<string, unknown>) => ({ binding: { ...binding, objectId: 'x'.repeat(MAX_PREPARED_OBJECT_ID_BYTES + 1) } })],
    ['businessRunId non-string', (binding: Record<string, unknown>) => ({ binding: { ...binding, businessRunId: 42 } })],
    ['businessRunId blank', (binding: Record<string, unknown>) => ({ binding: { ...binding, businessRunId: '   ' } })],
    ['businessRunId oversize', (binding: Record<string, unknown>) => ({ binding: { ...binding, businessRunId: 'x'.repeat(1_025) } })],
    ['businessPeriodId non-string', (binding: Record<string, unknown>) => ({ binding: { ...binding, businessPeriodId: 42 } })],
    ['businessPeriodId blank', (binding: Record<string, unknown>) => ({ binding: { ...binding, businessPeriodId: '   ' } })],
    ['businessPeriodId oversize', (binding: Record<string, unknown>) => ({ binding: { ...binding, businessPeriodId: 'x'.repeat(1_025) } })],
  ] as const)('rejects %s without writing', async (_name, createInput) => {
    const directory = temporaryDirectory()
    const fixture = await preparedWithPrimaryOwner(directory, 'manual', `c2-invalid-${_name}`)
    const binding = primaryAcceptedBinding(fixture.input)
    const input = createInput(binding)
    const before = directorySnapshot(directory)

    await expect(recordBusinessFinalizationOnLifecycle(await createLifecycle(directory), input)).resolves.toEqual({
      status: 'rejected',
      input,
    })
    expect(directorySnapshot(directory)).toEqual(before)
  })

  it.each([
    ['claim.jobId', (binding: Record<string, unknown>) => ({ ...binding, claim: { ...(binding.claim as Record<string, unknown>), jobId: 'foreign-job' } })],
    ['claim.runId', (binding: Record<string, unknown>) => ({ ...binding, claim: { ...(binding.claim as Record<string, unknown>), runId: 'foreign-run' } })],
    ['claim.sessionId', (binding: Record<string, unknown>) => ({ ...binding, claim: { ...(binding.claim as Record<string, unknown>), sessionId: 'foreign-session' } })],
    ['claim.scheduledFor', (binding: Record<string, unknown>) => ({ ...binding, claim: { ...(binding.claim as Record<string, unknown>), scheduledFor: '2026-08-24T03:00:00.000Z' } })],
    ['claim.claimedAt', (binding: Record<string, unknown>) => ({ ...binding, claim: { ...(binding.claim as Record<string, unknown>), claimedAt: '2026-08-24T03:00:01.000Z' } })],
    ['claim.trigger', (binding: Record<string, unknown>) => ({
      ...binding,
      claim: {
        ...(binding.claim as Record<string, unknown>),
        trigger: (binding.claim as Record<string, unknown>).trigger === 'scheduled' ? 'manual' : 'scheduled',
      },
    })],
    ['objectId', (binding: Record<string, unknown>) => ({ ...binding, objectId: `${String(binding.objectId)}-foreign` })],
    ['businessRunId', (binding: Record<string, unknown>) => ({ ...binding, businessRunId: 'foreign-business-run' })],
    ['businessPeriodId', (binding: Record<string, unknown>) => ({ ...binding, businessPeriodId: 'foreign-business-period' })],
  ] as const)('rejects exact binding when durable B %s differs without writing', async (_name, mutate) => {
    const directory = temporaryDirectory()
    const fixture = await preparedWithPrimaryOwner(directory, 'scheduled', `c2-binding-mismatch-${_name}`)
    const binding = primaryAcceptedBinding(fixture.input)
    const input = { binding: mutate(binding) }
    const before = directorySnapshot(directory)

    await expect(recordBusinessFinalizationOnLifecycle(await createLifecycle(directory), input)).resolves.toEqual({
      status: 'rejected',
      input,
    })
    expect(directorySnapshot(directory)).toEqual(before)
  })

  it('rejects before any attempt, receipt, or meaning exists', async () => {
    const directory = temporaryDirectory()
    const fixture = await preparedWithPrimaryOwner(directory, 'manual', 'c2-missing-technical-facts')
    const binding = primaryAcceptedBinding(fixture.input)
    const input = { binding }
    const before = directorySnapshot(directory)

    await expect(recordBusinessFinalizationOnLifecycle(await createLifecycle(directory), input)).resolves.toEqual({
      status: 'rejected',
      input,
    })
    expect(directorySnapshot(directory)).toEqual(before)
  })

  it('rejects after attempt and receipt exist but C1 meaning is absent', async () => {
    const directory = temporaryDirectory()
    const fixture = await preparedWithPrimaryOwner(directory, 'scheduled', 'c2-missing-meaning')
    appendAttemptAndReceiptState(directory, fixture.prepared, 'uncertain')
    const binding = primaryAcceptedBinding(fixture.input)
    const input = { binding }
    const before = directorySnapshot(directory)

    await expect(recordBusinessFinalizationOnLifecycle(await createLifecycle(directory), input)).resolves.toEqual({
      status: 'rejected',
      input,
    })
    expect(directorySnapshot(directory)).toEqual(before)
  })

  it('fails closed when a real prefinish acknowledgement precedes C2', async () => {
    const directory = temporaryDirectory()
    const fixture = await acceptedReceiptMeaningFixture(directory, 'scheduled', 'failed', 'c2-ack-before-finalization')
    appendPrefinishAck(directory, fixture.receiptRecord)
    const binding = fixture.primaryBinding
    const input = { binding }
    const before = directorySnapshot(directory)

    await expect(recordBusinessFinalizationOnLifecycle(await createLifecycle(directory), input)).resolves.toEqual({
      status: 'failed',
      input,
    })
    expect(directorySnapshot(directory)).toEqual(before)
  })

  it('fails closed when real prefinish acknowledgement and finish precede C2', async () => {
    const directory = temporaryDirectory()
    const fixture = await acceptedReceiptMeaningFixture(directory, 'scheduled', 'delivered', 'c2-finish-before-finalization')
    appendPrefinishAck(directory, fixture.receiptRecord)
    appendSuccessfulFinish(directory, fixture.binding, fixture.receiptRecord)
    const binding = fixture.primaryBinding
    const input = { binding }
    const before = directorySnapshot(directory)

    await expect(recordBusinessFinalizationOnLifecycle(await createLifecycle(directory), input)).resolves.toEqual({
      status: 'failed',
      input,
    })
    expect(directorySnapshot(directory)).toEqual(before)
  })

  it('keeps C2 and technical receipt replay idempotent after later acknowledgement and finish', async () => {
    const directory = temporaryDirectory()
    const fixture = await acceptedReceiptMeaningFixture(directory, 'manual', 'failed', 'c2-finalization-before-technical-close')
    const binding = fixture.primaryBinding
    const input = { binding }
    const lifecycle = await createLifecycle(directory)
    const first = await recordBusinessFinalizationOnLifecycle(lifecycle, input)
    expect(first).toMatchObject({ status: 'accepted', value: { binding } })
    const firstValue = acceptedMeaningValue(first)
    expect(firstValue.binding).toBe(binding)
    const beforeTechnicalClose = directorySnapshot(directory)

    appendPrefinishAck(directory, fixture.receiptRecord)
    appendSuccessfulFinish(directory, fixture.binding, fixture.receiptRecord)
    const afterTechnicalClose = directorySnapshot(directory)
    expect(afterTechnicalClose).not.toEqual(beforeTechnicalClose)

    await expect(recordBusinessFinalizationOnLifecycle(lifecycle, input)).resolves.toEqual(first)
    const receiptReplay = await acceptDeliveryReceiptOnLifecycle(await createLifecycle(directory), fixture.input)
    expect(receiptReplay).toEqual({
      status: 'accepted',
      value: {
        receipt: fixture.receipt,
        binding,
        retry: firstValue.retry,
      },
    })
    expect(directorySnapshot(directory)).toEqual(afterTechnicalClose)
  })
})

describe('C2 finalization owner hardening RED', () => {
  it.each([
    ['malformed JSON', (directory: string) => rewriteFinalizationOwnerRaw(directory, raw => `${raw.slice(0, -1)}broken`)],
    ['missing field', (directory: string) => rewriteFinalizationOwnerRow(directory, record => {
      const mutated = { ...record }
      delete mutated.businessPeriodId
      return mutated
    })],
    ['extra field', (directory: string) => rewriteFinalizationOwnerRow(directory, record => ({ ...record, extra: true }))],
    ['wrong nested claim', (directory: string) => rewriteFinalizationOwnerRow(directory, record => ({
      ...record,
      claim: { ...(record.claim as Record<string, unknown>), sessionId: 'foreign-session' },
    }))],
    ['blank objectId', (directory: string) => rewriteFinalizationOwnerRow(directory, record => ({ ...record, objectId: '   ' }))],
    ['oversize objectId', (directory: string) => rewriteFinalizationOwnerRow(directory, record => ({
      ...record,
      objectId: 'x'.repeat(MAX_PREPARED_OBJECT_ID_BYTES + 1),
    }))],
    ['blank businessRunId', (directory: string) => rewriteFinalizationOwnerRow(directory, record => ({ ...record, businessRunId: '   ' }))],
    ['oversize businessRunId', (directory: string) => rewriteFinalizationOwnerRow(directory, record => ({
      ...record,
      businessRunId: 'x'.repeat(1_025),
    }))],
    ['blank businessPeriodId', (directory: string) => rewriteFinalizationOwnerRow(directory, record => ({ ...record, businessPeriodId: '   ' }))],
    ['oversize businessPeriodId', (directory: string) => rewriteFinalizationOwnerRow(directory, record => ({
      ...record,
      businessPeriodId: 'x'.repeat(1_025),
    }))],
    ['duplicate exact', (directory: string) => {
      const row = finalizationOwnerRow(directory)
      const raw = row.lines[row.index]
      if (raw === undefined) throw new Error('missing finalization owner line')
      const lines = [...row.lines]
      lines.splice(row.index + 1, 0, raw)
      writeFileSync(row.path, `${lines.join('\n')}\n`, 'utf8')
    }],
    ['duplicate conflicting business ref', (directory: string) => {
      const row = finalizationOwnerRow(directory)
      const lines = [...row.lines]
      lines.splice(row.index + 1, 0, JSON.stringify({ ...row.record, businessRunId: 'foreign-business-run' }))
      writeFileSync(row.path, `${lines.join('\n')}\n`, 'utf8')
    }],
    ['duplicate conflicting object', (directory: string) => {
      const row = finalizationOwnerRow(directory)
      const lines = [...row.lines]
      lines.splice(row.index + 1, 0, JSON.stringify({ ...row.record, objectId: 'foreign-object' }))
      writeFileSync(row.path, `${lines.join('\n')}\n`, 'utf8')
    }],
  ] as const)('fails C2 replay on real finalization row %s without writing', async (_name, corrupt) => {
    const directory = temporaryDirectory()
    const fixture = await acceptedFinalizationFixture(directory, 'manual', 'failed', `c2-owner-${_name}`)
    corrupt(directory)
    const before = directorySnapshot(directory)

    await expect(recordBusinessFinalizationOnLifecycle(await createLifecycle(directory), fixture.finalizationInput)).resolves.toEqual({
      status: 'failed',
      input: fixture.finalizationInput,
    })
    expect(directorySnapshot(directory)).toEqual(before)
  })

  it('fails every shared owner replay when a real finalization row is corrupted', async () => {
    const directory = temporaryDirectory()
    const fixture = await acceptedFinalizationFixture(directory, 'scheduled', 'uncertain', 'c2-shared-corruption')
    rewriteFinalizationOwnerRow(directory, record => ({ ...record, businessPeriodId: 'foreign-business-period' }))

    const primaryInputValue = primaryInput(fixture.binding, {
      objectId: fixture.primaryBinding.objectId,
      businessRunId: fixture.primaryBinding.businessRunId,
      businessPeriodId: fixture.primaryBinding.businessPeriodId,
    })
    const calls: Array<readonly [string, () => Promise<unknown>, unknown]> = [
      ['A replay', () => registerExternalFirstLineage(directory, fixture.binding), fixture.binding],
      ['B replay', () => registerPrimaryRunContentObject(directory, primaryInputValue), primaryInputValue],
      ['C1 replay', () => acceptDeliveryReceipt(directory, fixture.input), fixture.input],
      ['C2 replay', async () => recordBusinessFinalizationOnLifecycle(await createLifecycle(directory), fixture.finalizationInput), fixture.finalizationInput],
    ]
    for (const [_name, call, input] of calls) {
      const before = directorySnapshot(directory)
      await expect(call()).resolves.toEqual({ status: 'failed', input })
      expect(directorySnapshot(directory)).toEqual(before)
    }
  })

  it.each([
    ['C1 meaning', (directory: string) => {
      const rows = ownerRows(directory)
      const lines = rows.lines.filter((_line, index) => rows.records[index]?.event !== 'run-delivery-meaning')
      writeFileSync(rows.path, `${lines.join('\n')}\n`, 'utf8')
    }],
    ['B primary', (directory: string) => {
      const rows = ownerRows(directory)
      const lines = rows.lines.filter((_line, index) => rows.records[index]?.objectClass !== 'primary_run_content')
      writeFileSync(rows.path, `${lines.join('\n')}\n`, 'utf8')
    }],
  ] as const)('fails C2 replay when the finalized chain loses %s', async (_name, removeRow) => {
    const directory = temporaryDirectory()
    const fixture = await acceptedFinalizationFixture(directory, 'manual', 'delivered', `c2-orphan-${_name}`)
    removeRow(directory)
    const before = directorySnapshot(directory)

    await expect(recordBusinessFinalizationOnLifecycle(await createLifecycle(directory), fixture.finalizationInput)).resolves.toEqual({
      status: 'failed',
      input: fixture.finalizationInput,
    })
    expect(directorySnapshot(directory)).toEqual(before)
  })

  it.each([
    ['owner read', 'run-delivery-meaning.jsonl'],
    ['runs read', 'runs.jsonl'],
  ] as const)('fails C2 replay on targeted %s I/O without writing', async (_name, targetFile) => {
    const directory = temporaryDirectory()
    const fixture = await acceptedFinalizationFixture(directory, 'scheduled', 'delivered', `c2-io-${_name}`)
    const originalReadLines = JsonlStore.prototype.readLines
    let targetReads = 0
    vi.spyOn(JsonlStore.prototype, 'readLines').mockImplementation(function (this: JsonlStore) {
      const file = String(Reflect.get(this, 'file'))
      if (file.endsWith(targetFile)) {
        targetReads += 1
        throw new Error(`C2 ${_name} read failed`)
      }
      return originalReadLines.call(this)
    })
    const before = directorySnapshot(directory)

    await expect(recordBusinessFinalizationOnLifecycle(await createLifecycle(directory), fixture.finalizationInput)).resolves.toEqual({
      status: 'failed',
      input: fixture.finalizationInput,
    })
    expect(targetReads).toBe(1)
    expect(directorySnapshot(directory)).toEqual(before)
  })

  it('fails without writing when finalization append throws before write', async () => {
    const directory = temporaryDirectory()
    const fixture = await acceptedReceiptMeaningFixture(directory, 'manual', 'failed', 'c2-append-before')
    vi.spyOn(JsonlStore.prototype, 'append').mockImplementationOnce(() => {
      throw new Error('C2 append before write')
    })
    const input = { binding: fixture.primaryBinding }
    const before = directorySnapshot(directory)

    await expect(recordBusinessFinalizationOnLifecycle(await createLifecycle(directory), input)).resolves.toEqual({
      status: 'failed',
      input,
    })
    expect(directorySnapshot(directory)).toEqual(before)
  })

  it('reads back a finalization row after append throws after writing and replays idempotently', async () => {
    const directory = temporaryDirectory()
    const fixture = await acceptedReceiptMeaningFixture(directory, 'scheduled', 'uncertain', 'c2-append-after')
    const input = { binding: fixture.primaryBinding }
    const expected = expectedFinalizationAcceptance(fixture.primaryBinding, 'uncertain', fixture.receiptDigest)
    const originalAppend = JsonlStore.prototype.append
    vi.spyOn(JsonlStore.prototype, 'append').mockImplementationOnce(function (this: JsonlStore, record: unknown) {
      originalAppend.call(this, record)
      throw new Error('C2 append after write')
    })
    const before = directorySnapshot(directory)

    await expect(recordBusinessFinalizationOnLifecycle(await createLifecycle(directory), input)).resolves.toEqual(expected)
    const afterFirst = directorySnapshot(directory)
    expect(ownerRows(directory).lines).toHaveLength(4)
    await expect(recordBusinessFinalizationOnLifecycle(await createLifecycle(directory), input)).resolves.toEqual(expected)
    expect(directorySnapshot(directory)).toEqual(afterFirst)
    expect(afterFirst).not.toEqual(before)
  })
})

describe('primary owner record hardening RED', () => {
  it.each([
    ['malformed JSON', (line: string) => '{malformed-owner-json'],
    ['missing field', (_line: string, record: Record<string, unknown>) => {
      const mutated = { ...record }
      delete mutated.businessPeriodId
      return JSON.stringify(mutated)
    }],
    ['extra field', (_line: string, record: Record<string, unknown>) => JSON.stringify({ ...record, extra: true })],
    ['wrong nested claim', (_line: string, record: Record<string, unknown>) => JSON.stringify({
      ...record,
      claim: { ...(record.claim as Record<string, unknown>), claimedAt: '2026-08-24T03:00:01.000Z' },
    })],
    ['wrong derived object class', (_line: string, record: Record<string, unknown>) => JSON.stringify({
      ...record,
      objectClass: 'foreign-class',
    })],
    ['wrong derived run lineage', (_line: string, record: Record<string, unknown>) => JSON.stringify({
      ...record,
      runLineage: 'foreign-lineage',
    })],
    ['invalid business reference', (_line: string, record: Record<string, unknown>) => JSON.stringify({
      ...record,
      businessRunId: '   ',
    })],
  ] as const)('returns failed and preserves bytes for a %s existing-row mutation', async (_name, mutate) => {
    const directory = temporaryDirectory()
    const { input } = await preparedWithPrimaryOwner(directory, 'scheduled', `hardening-${_name}`)
    const row = primaryOwnerRow(directory)
    const lines = [...row.lines]
    const raw = lines[row.index]
    if (raw === undefined) throw new Error('missing primary owner line')
    lines[row.index] = mutate(raw, row.record)
    writeFileSync(row.path, `${lines.join('\n')}\n`, 'utf8')
    const before = directorySnapshot(directory)

    await expect(registerPrimaryRunContentObject(directory, input)).resolves.toEqual({
      status: 'failed',
      input,
    })
    expect(directorySnapshot(directory)).toEqual(before)
  })

  it('fails on an exact duplicate primary owner row without appending', async () => {
    const directory = temporaryDirectory()
    const { input } = await preparedWithPrimaryOwner(directory, 'manual', 'hardening-duplicate-exact')
    const row = primaryOwnerRow(directory)
    const lines = [...row.lines]
    const raw = lines[row.index]
    if (raw === undefined) throw new Error('missing primary owner line')
    lines.splice(row.index + 1, 0, raw)
    writeFileSync(row.path, `${lines.join('\n')}\n`, 'utf8')
    const before = directorySnapshot(directory)

    await expect(registerPrimaryRunContentObject(directory, input)).resolves.toEqual({
      status: 'failed',
      input,
    })
    expect(directorySnapshot(directory)).toEqual(before)
  })

  it('fails on a conflicting same-run primary owner row and preserves the first fact', async () => {
    const directory = temporaryDirectory()
    const { input } = await preparedWithPrimaryOwner(directory, 'scheduled', 'hardening-duplicate-conflict')
    const row = primaryOwnerRow(directory)
    const lines = [...row.lines]
    lines.splice(row.index + 1, 0, JSON.stringify({ ...row.record, businessPeriodId: 'foreign-business-period' }))
    writeFileSync(row.path, `${lines.join('\n')}\n`, 'utf8')
    const before = directorySnapshot(directory)

    await expect(registerPrimaryRunContentObject(directory, input)).resolves.toEqual({
      status: 'failed',
      input,
    })
    expect(directorySnapshot(directory)).toEqual(before)
  })

  it('fails when the exact A lineage row is duplicated before replaying B', async () => {
    const directory = temporaryDirectory()
    const { input } = await preparedWithPrimaryOwner(directory, 'manual', 'hardening-duplicate-lineage')
    const rows = ownerRows(directory)
    const lineageIndex = rows.records.findIndex(record => record.event === 'external-first-lineage')
    if (lineageIndex < 0) throw new Error('missing production lineage owner row')
    const lines = [...rows.lines]
    const lineage = lines[lineageIndex]
    if (lineage === undefined) throw new Error('missing production lineage line')
    lines.splice(lineageIndex + 1, 0, lineage)
    writeFileSync(rows.path, `${lines.join('\n')}\n`, 'utf8')
    const before = directorySnapshot(directory)

    await expect(registerPrimaryRunContentObject(directory, input)).resolves.toEqual({
      status: 'failed',
      input,
    })
    expect(directorySnapshot(directory)).toEqual(before)
  })

  it('fails an orphan primary row after the exact A lineage row is removed', async () => {
    const directory = temporaryDirectory()
    const { input } = await preparedWithPrimaryOwner(directory, 'scheduled', 'hardening-orphan')
    const rows = ownerRows(directory)
    const lines = rows.lines.filter((_line, index) => rows.records[index]?.event !== 'external-first-lineage')
    writeFileSync(rows.path, `${lines.join('\n')}\n`, 'utf8')
    const before = directorySnapshot(directory)

    await expect(registerPrimaryRunContentObject(directory, input)).resolves.toEqual({
      status: 'failed',
      input,
    })
    expect(directorySnapshot(directory)).toEqual(before)
  })

  it('returns failed when the B append throws before writing', async () => {
    const directory = temporaryDirectory()
    const state = await preparedWithLineage(directory, 'manual', 'hardening-append-before')
    const input = primaryInput(state.binding, { objectId: state.prepared.objectId })
    const append = vi.spyOn(JsonlStore.prototype, 'append').mockImplementationOnce(() => {
      throw new Error('B append failed before write')
    })
    const before = directorySnapshot(directory)

    await expect(registerPrimaryRunContentObject(directory, input)).resolves.toEqual({
      status: 'failed',
      input,
    })
    expect(directorySnapshot(directory)).toEqual(before)
    expect(append).toHaveBeenCalledTimes(1)
  })

  it('reads back an exact B append that throws after writing', async () => {
    const directory = temporaryDirectory()
    const state = await preparedWithLineage(directory, 'scheduled', 'hardening-append-after')
    const input = primaryInput(state.binding, { objectId: state.prepared.objectId })
    const originalAppend = JsonlStore.prototype.append
    vi.spyOn(JsonlStore.prototype, 'append').mockImplementationOnce(function (this: JsonlStore, record: unknown) {
      originalAppend.call(this, record)
      throw new Error('B append failed after write')
    })

    await expect(registerPrimaryRunContentObject(directory, input)).resolves.toEqual({
      status: 'accepted',
      value: {
        claim: state.binding,
        objectId: state.prepared.objectId,
        businessRunId: 'business-run-primary',
        businessPeriodId: 'business-period-primary',
        objectClass: 'primary_run_content',
        runLineage: 'external_first',
      },
    })
    const afterFirst = directorySnapshot(directory)
    const row = primaryOwnerRow(directory)
    expect(row.record.event).toBe('primary-run-content-object')
    await expect(registerPrimaryRunContentObject(directory, input)).resolves.toEqual({
      status: 'accepted',
      value: {
        claim: state.binding,
        objectId: state.prepared.objectId,
        businessRunId: 'business-run-primary',
        businessPeriodId: 'business-period-primary',
        objectClass: 'primary_run_content',
        runLineage: 'external_first',
      },
    })
    expect(directorySnapshot(directory)).toEqual(afterFirst)
  })

  it('returns failed instead of throwing when owner read I/O fails', async () => {
    const directory = temporaryDirectory()
    const { input } = await preparedWithPrimaryOwner(directory, 'manual', 'hardening-read-failure')
    const originalReadLines = JsonlStore.prototype.readLines
    let reads = 0
    vi.spyOn(JsonlStore.prototype, 'readLines').mockImplementation(function (this: JsonlStore) {
      reads += 1
      if (reads === 2) throw new Error('owner read failed')
      return originalReadLines.call(this)
    })
    const before = directorySnapshot(directory)

    await expect(registerPrimaryRunContentObject(directory, input)).resolves.toEqual({
      status: 'failed',
      input,
    })
    expect(reads).toBe(2)
    expect(directorySnapshot(directory)).toEqual(before)
  })

  it('replays the exact binding after an attempt without appending a second owner fact', async () => {
    const directory = temporaryDirectory()
    const { input, prepared } = await preparedWithPrimaryOwner(directory, 'scheduled', 'hardening-attempt-replay')
    appendAttemptOnly(directory, prepared)
    const afterAttempt = directorySnapshot(directory)

    await expect(registerPrimaryRunContentObject(directory, input)).resolves.toEqual({
      status: 'accepted',
      value: {
        claim: input.claim,
        objectId: input.objectId,
        businessRunId: input.businessRunId,
        businessPeriodId: input.businessPeriodId,
        objectClass: 'primary_run_content',
        runLineage: 'external_first',
      },
    })
    expect(directorySnapshot(directory)).toEqual(afterAttempt)
  })

  it('fails exact replay when two real primary rows converge on one object id', async () => {
    const directory = temporaryDirectory()
    const first = await preparedWithPrimaryOwner(directory, 'scheduled', 'hardening-global-object-first')
    const secondState = await preparedWithLineage(directory, 'manual', 'hardening-global-object-second')
    const secondInput = primaryInput(secondState.binding, {
      objectId: secondState.prepared.objectId,
      businessRunId: 'business-run-second',
      businessPeriodId: 'business-period-second',
    })
    await expect(registerPrimaryRunContentObject(directory, secondInput)).resolves.toMatchObject({ status: 'accepted' })

    const rows = ownerRows(directory)
    const firstIndex = rows.records.findIndex(record => record.objectClass === 'primary_run_content'
      && (record.claim as Record<string, unknown>).runId === first.binding.runId)
    const secondIndex = rows.records.findIndex(record => record.objectClass === 'primary_run_content'
      && (record.claim as Record<string, unknown>).runId === secondState.binding.runId)
    if (firstIndex < 0 || secondIndex < 0) throw new Error('missing real primary owner rows')
    const firstRecord = rows.records[firstIndex]
    const secondRecord = rows.records[secondIndex]
    if (firstRecord === undefined || secondRecord === undefined) throw new Error('missing real primary owner records')
    const lines = [...rows.lines]
    lines[secondIndex] = JSON.stringify({ ...secondRecord, objectId: firstRecord.objectId })
    writeFileSync(rows.path, `${lines.join('\n')}\n`, 'utf8')

    const runLines = readFileSync(runsFile(directory), 'utf8').trim().split('\n')
    const preparedIndex = runLines.findIndex(raw => {
      const record = JSON.parse(raw) as Record<string, unknown>
      return record.event === 'prepared-delivery' && record.runId === secondState.binding.runId
    })
    if (preparedIndex < 0) throw new Error('missing real second prepared row')
    const preparedRaw = runLines[preparedIndex]
    if (preparedRaw === undefined) throw new Error('missing real second prepared line')
    const preparedRecord = JSON.parse(preparedRaw) as Record<string, unknown>
    runLines[preparedIndex] = JSON.stringify({ ...preparedRecord, objectId: firstRecord.objectId })
    writeFileSync(runsFile(directory), `${runLines.join('\n')}\n`, 'utf8')
    const before = directorySnapshot(directory)

    await expect(registerPrimaryRunContentObject(directory, first.input)).resolves.toEqual({
      status: 'failed',
      input: first.input,
    })
    expect(directorySnapshot(directory)).toEqual(before)
  })

  it('fails exact replay when two real primary rows converge on one business run and period', async () => {
    const directory = temporaryDirectory()
    const first = await preparedWithPrimaryOwner(directory, 'scheduled', 'hardening-global-business-first')
    const secondState = await preparedWithLineage(directory, 'manual', 'hardening-global-business-second')
    const secondInput = primaryInput(secondState.binding, {
      objectId: secondState.prepared.objectId,
      businessRunId: 'business-run-second',
      businessPeriodId: 'business-period-second',
    })
    await expect(registerPrimaryRunContentObject(directory, secondInput)).resolves.toMatchObject({ status: 'accepted' })

    const rows = ownerRows(directory)
    const firstIndex = rows.records.findIndex(record => record.objectClass === 'primary_run_content'
      && (record.claim as Record<string, unknown>).runId === first.binding.runId)
    const secondIndex = rows.records.findIndex(record => record.objectClass === 'primary_run_content'
      && (record.claim as Record<string, unknown>).runId === secondState.binding.runId)
    if (firstIndex < 0 || secondIndex < 0) throw new Error('missing real primary owner rows')
    const firstRecord = rows.records[firstIndex]
    const secondRecord = rows.records[secondIndex]
    if (firstRecord === undefined || secondRecord === undefined) throw new Error('missing real primary owner records')
    const lines = [...rows.lines]
    lines[secondIndex] = JSON.stringify({
      ...secondRecord,
      businessRunId: firstRecord.businessRunId,
      businessPeriodId: firstRecord.businessPeriodId,
    })
    writeFileSync(rows.path, `${lines.join('\n')}\n`, 'utf8')
    const before = directorySnapshot(directory)

    await expect(registerPrimaryRunContentObject(directory, first.input)).resolves.toEqual({
      status: 'failed',
      input: first.input,
    })
    expect(directorySnapshot(directory)).toEqual(before)
  })
})

describe('lineage owner projection hardening RED', () => {
  it('returns failed instead of throwing when A owner read I/O fails', async () => {
    const directory = temporaryDirectory()
    await preparedWithPrimaryOwner(directory, 'scheduled', 'a-owner-read-failure')
    const claim = durableClaim(directory, 'manual', 'a-owner-read-failure-new-claim')
    const binding = exactClaimBinding(claim)
    const originalReadLines = JsonlStore.prototype.readLines
    let reads = 0
    vi.spyOn(JsonlStore.prototype, 'readLines').mockImplementation(function (this: JsonlStore) {
      reads += 1
      if (reads === 2) throw new Error('lineage owner read failed')
      return originalReadLines.call(this)
    })
    const before = directorySnapshot(directory)

    await expect(registerExternalFirstLineage(directory, binding)).resolves.toEqual({
      status: 'failed',
      input: binding,
    })
    expect(reads).toBe(2)
    expect(directorySnapshot(directory)).toEqual(before)
  })

  it('fails A registration when a real B row object id diverges from prepared evidence', async () => {
    const directory = temporaryDirectory()
    await preparedWithPrimaryOwner(directory, 'scheduled', 'a-object-link-corruption')
    const row = primaryOwnerRow(directory)
    const lines = [...row.lines]
    lines[row.index] = JSON.stringify({ ...row.record, objectId: `${String(row.record.objectId)}-foreign` })
    writeFileSync(row.path, `${lines.join('\n')}\n`, 'utf8')
    const claim = durableClaim(directory, 'manual', 'a-object-link-corruption-new-claim')
    const binding = exactClaimBinding(claim)
    const before = directorySnapshot(directory)

    await expect(registerExternalFirstLineage(directory, binding)).resolves.toEqual({
      status: 'failed',
      input: binding,
    })
    expect(directorySnapshot(directory)).toEqual(before)
  })

  it('fails A registration when two real B rows converge on one business pair', async () => {
    const directory = temporaryDirectory()
    const first = await preparedWithPrimaryOwner(directory, 'scheduled', 'a-business-collision-first')
    const secondState = await preparedWithLineage(directory, 'manual', 'a-business-collision-second')
    const secondInput = primaryInput(secondState.binding, {
      objectId: secondState.prepared.objectId,
      businessRunId: 'business-run-second',
      businessPeriodId: 'business-period-second',
    })
    await expect(registerPrimaryRunContentObject(directory, secondInput)).resolves.toMatchObject({ status: 'accepted' })

    const rows = ownerRows(directory)
    const firstIndex = rows.records.findIndex(record => record.objectClass === 'primary_run_content'
      && (record.claim as Record<string, unknown>).runId === first.binding.runId)
    const secondIndex = rows.records.findIndex(record => record.objectClass === 'primary_run_content'
      && (record.claim as Record<string, unknown>).runId === secondState.binding.runId)
    if (firstIndex < 0 || secondIndex < 0) throw new Error('missing real primary owner rows')
    const firstRecord = rows.records[firstIndex]
    const secondRecord = rows.records[secondIndex]
    if (firstRecord === undefined || secondRecord === undefined) throw new Error('missing real primary owner records')
    const lines = [...rows.lines]
    lines[secondIndex] = JSON.stringify({
      ...secondRecord,
      businessRunId: firstRecord.businessRunId,
      businessPeriodId: firstRecord.businessPeriodId,
    })
    writeFileSync(rows.path, `${lines.join('\n')}\n`, 'utf8')
    const claim = durableClaim(directory, 'manual', 'a-business-collision-new-claim')
    const binding = exactClaimBinding(claim)
    const before = directorySnapshot(directory)

    await expect(registerExternalFirstLineage(directory, binding)).resolves.toEqual({
      status: 'failed',
      input: binding,
    })
    expect(directorySnapshot(directory)).toEqual(before)
  })

  it('fails A registration when a real B row is duplicated exactly', async () => {
    const directory = temporaryDirectory()
    await preparedWithPrimaryOwner(directory, 'manual', 'a-duplicate-primary')
    const row = primaryOwnerRow(directory)
    const lines = [...row.lines]
    const raw = lines[row.index]
    if (raw === undefined) throw new Error('missing primary owner line')
    lines.splice(row.index + 1, 0, raw)
    writeFileSync(row.path, `${lines.join('\n')}\n`, 'utf8')
    const claim = durableClaim(directory, 'scheduled', 'a-duplicate-primary-new-claim')
    const binding = exactClaimBinding(claim)
    const before = directorySnapshot(directory)

    await expect(registerExternalFirstLineage(directory, binding)).resolves.toEqual({
      status: 'failed',
      input: binding,
    })
    expect(directorySnapshot(directory)).toEqual(before)
  })
})

describe('core durable receipt acceptance RED', () => {
  it.each([
    ['scheduled', 'delivered', 'c1a-scheduled-delivered'],
    ['scheduled', 'failed', 'c1a-scheduled-failed'],
    ['scheduled', 'uncertain', 'c1a-scheduled-uncertain'],
    ['manual', 'delivered', 'c1a-manual-delivered'],
    ['manual', 'failed', 'c1a-manual-failed'],
    ['manual', 'uncertain', 'c1a-manual-uncertain'],
  ] as const)('accepts exact %s durable %s receipt with state-derived retry contract', async (trigger, deliveryState, suffix) => {
    const directory = temporaryDirectory()
    const fixture = await durableReceiptMeaningFixture(directory, trigger, deliveryState, suffix)
    const input = { receipt: fixture.receipt }
    const requestFailureNotification = vi.fn()
    const before = directorySnapshot(directory)
    const beforeOwnerLines = readFileSync(ownerFile(directory), 'utf8').trim().split('\n')

    const result = await acceptDeliveryReceipt(directory, input, { requestFailureNotification })
    expect(result).toEqual(expectedReceiptAcceptance(
      fixture.receipt,
      fixture.primaryBinding,
      deliveryState,
      fixture.receiptDigest,
    ))
    const acceptedValue = acceptedMeaningValue(result)
    expect(acceptedValue.receipt).toBe(input.receipt)
    expect(acceptedValue.binding).toEqual(fixture.primaryBinding)
    if (deliveryState === 'failed') {
      const retry = acceptedValue.retry
      if (typeof retry !== 'object' || retry === null || Array.isArray(retry)) throw new Error('missing failed retry contract')
      expect(Reflect.get(Reflect.get(retry, 'authorization'), 'binding')).toEqual(fixture.primaryBinding)
    }
    expect(requestFailureNotification).not.toHaveBeenCalled()
    expect(Object.keys(input).sort()).toEqual(['receipt'])

    const afterOwnerLines = readFileSync(ownerFile(directory), 'utf8').trim().split('\n')
    expect(afterOwnerLines).toHaveLength(beforeOwnerLines.length + 1)
    const meaningRecord = JSON.parse(afterOwnerLines.at(-1) ?? '') as unknown
    expect(containsKey(meaningRecord, 'deliveryState')).toBe(false)
    expect(containsKey(meaningRecord, 'deliveredAt')).toBe(false)
    expect(containsKey(meaningRecord, 'deliveryError')).toBe(false)
    if (deliveryState === 'failed') expect(JSON.stringify(meaningRecord)).not.toContain(fixture.receiptRecord.deliveryError)
    expect(directorySnapshot(directory)).not.toEqual(before)
  })

  it.each([
    ['extra top-level field', (receipt: CronDeliveryReceipt) => ({ receipt, extra: true })],
    ['extra nested receipt field', (receipt: CronDeliveryReceipt) => ({ receipt: { ...receipt, extra: true } })],
    ['missing top-level receipt', (_receipt: CronDeliveryReceipt) => ({})],
    ['non-object top-level receipt', (_receipt: CronDeliveryReceipt) => ({ receipt: 'not-an-object' })],
    ['missing required receipt field', (receipt: CronDeliveryReceipt) => {
      const { runId: _runId, ...withoutRunId } = receipt
      return { receipt: withoutRunId }
    }],
    ['non-string identity', (receipt: CronDeliveryReceipt) => ({ receipt: { ...receipt, jobId: 42 } })],
    ['blank identity', (receipt: CronDeliveryReceipt) => ({ receipt: { ...receipt, objectId: ' ' } })],
    ['invalid delivery state', (receipt: CronDeliveryReceipt) => ({ receipt: { ...receipt, deliveryState: 'silent' } })],
    ['identity mismatch', (receipt: CronDeliveryReceipt) => ({ receipt: { ...receipt, runId: 'foreign-run' } })],
    ['state mismatch', (receipt: CronDeliveryReceipt) => ({
      receipt: { ...receipt, deliveryState: 'failed', deliveryError: 'different durable state' },
    })],
    ['invalid optional timestamp', (receipt: CronDeliveryReceipt) => ({ receipt: { ...receipt, deliveredAt: 42 } })],
  ] as const)('rejects %s without writing or throwing', async (_name, makeInput) => {
    const directory = temporaryDirectory()
    const fixture = await durableReceiptMeaningFixture(directory, 'scheduled', 'delivered', `c1a-invalid-${_name}`)
    const input = makeInput(fixture.receipt)
    const before = directorySnapshot(directory)

    await expect(acceptDeliveryReceipt(directory, input)).resolves.toEqual({
      status: 'rejected',
      input,
    })
    expect(directorySnapshot(directory)).toEqual(before)
  })

  it('rejects a deliveredAt value that is valid ISO but differs from the durable receipt', async () => {
    const directory = temporaryDirectory()
    const fixture = await durableReceiptMeaningFixture(directory, 'scheduled', 'delivered', 'c1a-delivered-at-mismatch')
    const input = {
      receipt: { ...fixture.receipt, deliveredAt: '2026-08-24T02:00:06.000Z' },
    }
    const before = directorySnapshot(directory)

    await expect(acceptDeliveryReceipt(directory, input)).resolves.toEqual({
      status: 'rejected',
      input,
    })
    expect(directorySnapshot(directory)).toEqual(before)
  })

  it('rejects a failed deliveryError value that differs from the durable receipt', async () => {
    const directory = temporaryDirectory()
    const fixture = await durableReceiptMeaningFixture(directory, 'manual', 'failed', 'c1a-error-mismatch')
    const input = {
      receipt: { ...fixture.receipt, deliveryError: 'another valid failure description' },
    }
    const before = directorySnapshot(directory)

    await expect(acceptDeliveryReceipt(directory, input)).resolves.toEqual({
      status: 'rejected',
      input,
    })
    expect(directorySnapshot(directory)).toEqual(before)
  })

  it('rejects a prepared A+B run with neither attempt nor receipt', async () => {
    const directory = temporaryDirectory()
    const state = await preparedWithPrimaryOwner(directory, 'scheduled', 'c1a-missing-attempt-receipt')
    appendAttemptAndReceiptState(directory, state.prepared, 'delivered')
    const durable = receiptInputFromDurableRow(directory, state.binding.runId)
    removeRunEvents(directory, record => record.runId === state.binding.runId
      && (record.event === 'delivery-attempt-claim' || record.event === 'delivery-receipt'))
    const input = { receipt: durable.receipt }
    const before = directorySnapshot(directory)

    await expect(acceptDeliveryReceipt(directory, input)).resolves.toEqual({
      status: 'rejected',
      input,
    })
    expect(directorySnapshot(directory)).toEqual(before)
  })

  it('rejects a prepared A+B run with an attempt but no receipt', async () => {
    const directory = temporaryDirectory()
    const state = await preparedWithPrimaryOwner(directory, 'manual', 'c1a-missing-receipt')
    appendAttemptAndReceiptState(directory, state.prepared, 'uncertain')
    const durable = receiptInputFromDurableRow(directory, state.binding.runId)
    removeRunEvents(directory, record => record.runId === state.binding.runId && record.event === 'delivery-receipt')
    const input = { receipt: durable.receipt }
    const before = directorySnapshot(directory)

    await expect(acceptDeliveryReceipt(directory, input)).resolves.toEqual({
      status: 'rejected',
      input,
    })
    expect(directorySnapshot(directory)).toEqual(before)
  })

  it('fails when a real receipt exists but the B owner row is missing', async () => {
    const directory = temporaryDirectory()
    const state = await preparedWithPrimaryOwner(directory, 'scheduled', 'c1a-missing-binding')
    appendAttemptAndReceiptState(directory, state.prepared, 'delivered')
    const durable = receiptInputFromDurableRow(directory, state.binding.runId)
    const rows = ownerRows(directory)
    const lines = rows.lines.filter((_line, index) => {
      const record = rows.records[index]
      return record?.event !== 'primary-run-content-object'
    })
    writeFileSync(rows.path, `${lines.join('\n')}\n`, 'utf8')
    const input = { receipt: durable.receipt }
    const before = directorySnapshot(directory)

    await expect(acceptDeliveryReceipt(directory, input)).resolves.toEqual({
      status: 'failed',
      input,
    })
    expect(directorySnapshot(directory)).toEqual(before)
  })

  it('fails closed when receipt and prefinish acknowledgement exist before C1 meaning', async () => {
    const directory = temporaryDirectory()
    const fixture = await durableReceiptMeaningFixture(directory, 'scheduled', 'delivered', 'c1-ack-before-meaning')
    appendPrefinishAck(directory, fixture.receiptRecord)
    const input = { receipt: fixture.receipt }
    const before = directorySnapshot(directory)

    await expect(acceptDeliveryReceipt(directory, input)).resolves.toEqual({ status: 'failed', input })
    expect(ownerRows(directory).records.filter(record => record.event === 'run-delivery-meaning')).toHaveLength(0)
    expect(directorySnapshot(directory)).toEqual(before)
  })

  it('replays an existing C1 meaning after a later prefinish acknowledgement', async () => {
    const directory = temporaryDirectory()
    const fixture = await durableReceiptMeaningFixture(directory, 'manual', 'uncertain', 'c1-meaning-before-ack')
    const input = { receipt: fixture.receipt }
    const first = await acceptDeliveryReceipt(directory, input)
    expect(first).toEqual(expectedReceiptAcceptance(
      fixture.receipt,
      fixture.primaryBinding,
      'uncertain',
      fixture.receiptDigest,
    ))
    appendPrefinishAck(directory, fixture.receiptRecord)
    const afterAck = directorySnapshot(directory)

    await expect(acceptDeliveryReceipt(directory, input)).resolves.toEqual(first)
    expect(directorySnapshot(directory)).toEqual(afterAck)
  })

  it('fails when a prefinish acknowledgement remains but the receipt row is removed', async () => {
    const directory = temporaryDirectory()
    const state = await preparedWithPrimaryOwner(directory, 'manual', 'c1a-ack-without-receipt')
    appendAttemptAndReceiptState(directory, state.prepared, 'uncertain')
    const durable = receiptInputFromDurableRow(directory, state.binding.runId)
    appendPrefinishAck(directory, durable.record)
    removeRunEvents(directory, record => record.runId === state.binding.runId && record.event === 'delivery-receipt')
    const input = { receipt: durable.receipt }
    const before = directorySnapshot(directory)

    await expect(acceptDeliveryReceipt(directory, input)).resolves.toEqual({
      status: 'failed',
      input,
    })
    expect(directorySnapshot(directory)).toEqual(before)
  })

  it('replays the accepted receipt meaning by exact value across instance and rebuild', async () => {
    const directory = temporaryDirectory()
    const fixture = await durableReceiptMeaningFixture(directory, 'manual', 'failed', 'c1a-idempotence')
    const input = { receipt: fixture.receipt }
    const expected = expectedReceiptAcceptance(fixture.receipt, fixture.primaryBinding, 'failed', fixture.receiptDigest)
    const lifecycle = await createLifecycle(directory)
    const first = await acceptDeliveryReceiptOnLifecycle(lifecycle, input)
    const afterFirst = directorySnapshot(directory)
    const replay = await acceptDeliveryReceiptOnLifecycle(lifecycle, input)
    const rebuilt = await acceptDeliveryReceipt(directory, input)

    expect(first).toEqual(expected)
    expect(replay).toEqual(first)
    expect(rebuilt).toEqual(first)
    expect(directorySnapshot(directory)).toEqual(afterFirst)
  })
})

describe('C1b durable receipt hardening RED', () => {
  it.each([
    ['missing field', (_line: string, record: Record<string, unknown>) => {
      const mutated = { ...record }
      delete mutated.receiptDigest
      return JSON.stringify(mutated)
    }],
    ['extra field', (_line: string, record: Record<string, unknown>) => JSON.stringify({ ...record, extra: true })],
    ['wrong digest', (_line: string, record: Record<string, unknown>) => JSON.stringify({ ...record, receiptDigest: 'a'.repeat(64) })],
  ] as const)('fails a real meaning row %s without writing', async (_name, mutate) => {
    const directory = temporaryDirectory()
    const fixture = await acceptedReceiptMeaningFixture(directory, 'scheduled', 'failed', `c1b-meaning-${_name}`)
    const row = meaningOwnerRow(directory)
    const raw = row.lines[row.index]
    if (raw === undefined) throw new Error('missing meaning owner line')
    rewriteMeaningOwnerRow(directory, record => {
      const mutated = mutate(raw, record)
      return JSON.parse(mutated) as Record<string, unknown>
    })
    const before = directorySnapshot(directory)

    await expect(acceptDeliveryReceipt(directory, fixture.input)).resolves.toEqual({
      status: 'failed',
      input: fixture.input,
    })
    expect(directorySnapshot(directory)).toEqual(before)
  })

  it('fails a malformed real meaning owner line without setup throwing or writing', async () => {
    const directory = temporaryDirectory()
    const fixture = await acceptedReceiptMeaningFixture(directory, 'scheduled', 'failed', 'c1b-meaning-malformed')
    rewriteMeaningOwnerRaw(directory, raw => `${raw.slice(0, -1)}broken`)
    const before = directorySnapshot(directory)

    await expect(acceptDeliveryReceipt(directory, fixture.input)).resolves.toEqual({
      status: 'failed',
      input: fixture.input,
    })
    expect(directorySnapshot(directory)).toEqual(before)
  })

  it('fails a duplicated exact meaning row without reusing it', async () => {
    const directory = temporaryDirectory()
    const fixture = await acceptedReceiptMeaningFixture(directory, 'manual', 'delivered', 'c1b-duplicate-exact')
    const row = meaningOwnerRow(directory)
    const raw = row.lines[row.index]
    if (raw === undefined) throw new Error('missing meaning owner line')
    const lines = [...row.lines]
    lines.splice(row.index + 1, 0, raw)
    writeFileSync(row.path, `${lines.join('\n')}\n`, 'utf8')
    const before = directorySnapshot(directory)

    await expect(acceptDeliveryReceipt(directory, fixture.input)).resolves.toEqual({
      status: 'failed',
      input: fixture.input,
    })
    expect(directorySnapshot(directory)).toEqual(before)
  })

  it('fails a duplicated conflicting meaning row and preserves the first fact', async () => {
    const directory = temporaryDirectory()
    const fixture = await acceptedReceiptMeaningFixture(directory, 'scheduled', 'uncertain', 'c1b-duplicate-conflict')
    const row = meaningOwnerRow(directory)
    const lines = [...row.lines]
    lines.splice(row.index + 1, 0, JSON.stringify({ ...row.record, receiptDigest: 'b'.repeat(64) }))
    writeFileSync(row.path, `${lines.join('\n')}\n`, 'utf8')
    const before = directorySnapshot(directory)

    await expect(acceptDeliveryReceipt(directory, fixture.input)).resolves.toEqual({
      status: 'failed',
      input: fixture.input,
    })
    expect(directorySnapshot(directory)).toEqual(before)
  })

  it('fails an orphan meaning row after the real B owner row is removed', async () => {
    const directory = temporaryDirectory()
    const fixture = await acceptedReceiptMeaningFixture(directory, 'manual', 'failed', 'c1b-orphan-b')
    const rows = ownerRows(directory)
    const lines = rows.lines.filter((_line, index) => rows.records[index]?.event !== 'primary-run-content-object')
    writeFileSync(rows.path, `${lines.join('\n')}\n`, 'utf8')
    const before = directorySnapshot(directory)

    await expect(acceptDeliveryReceipt(directory, fixture.input)).resolves.toEqual({
      status: 'failed',
      input: fixture.input,
    })
    expect(directorySnapshot(directory)).toEqual(before)
  })

  it.each([
    ['delivered-to-uncertain', 'delivered', (record: Record<string, unknown>) => {
      const mutated = { ...record, deliveryState: 'uncertain' }
      delete mutated.deliveredAt
      mutated.deliveryError = 'raw receipt changed after meaning'
      return mutated
    }],
    ['uncertain-to-delivered', 'uncertain', (record: Record<string, unknown>) => {
      const mutated = { ...record, deliveryState: 'delivered', deliveredAt: '2026-08-24T02:00:06.000Z' }
      delete mutated.deliveryError
      return mutated
    }],
    ['receipt-time', 'failed', (record: Record<string, unknown>) => ({ ...record, receiptAt: '2026-08-24T02:00:06.000Z' })],
  ] as const)('fails when the durable receipt raw row changes %s after C1 acceptance', async (_name, state, mutate) => {
    const directory = temporaryDirectory()
    const fixture = await acceptedReceiptMeaningFixture(directory, 'scheduled', state, `c1b-raw-${_name}`)
    rewriteRunReceiptRow(directory, fixture.binding.runId, mutate)
    const before = directorySnapshot(directory)

    await expect(acceptDeliveryReceipt(directory, fixture.input)).resolves.toEqual({
      status: 'failed',
      input: fixture.input,
    })
    expect(directorySnapshot(directory)).toEqual(before)
  })

  it('fails when a semantically identical durable receipt row is only key-reordered', async () => {
    const directory = temporaryDirectory()
    const fixture = await acceptedReceiptMeaningFixture(directory, 'manual', 'delivered', 'c1b-receipt-key-order')
    rewriteRunReceiptRow(directory, fixture.binding.runId, record => Object.fromEntries(Object.entries(record).reverse()))
    const before = directorySnapshot(directory)

    await expect(acceptDeliveryReceipt(directory, fixture.input)).resolves.toEqual({
      status: 'failed',
      input: fixture.input,
    })
    expect(directorySnapshot(directory)).toEqual(before)
  })

  it('fails when only a failed receipt deliveryError changes while state stays failed', async () => {
    const directory = temporaryDirectory()
    const fixture = await acceptedReceiptMeaningFixture(directory, 'scheduled', 'failed', 'c1b-error-only')
    rewriteRunReceiptRow(directory, fixture.binding.runId, record => ({
      ...record,
      deliveryError: 'same failed state, different durable error',
    }))
    const before = directorySnapshot(directory)

    await expect(acceptDeliveryReceipt(directory, fixture.input)).resolves.toEqual({
      status: 'failed',
      input: fixture.input,
    })
    expect(directorySnapshot(directory)).toEqual(before)
  })

  it.each([
    ['malformed raw receipt', (raw: string) => `${raw.slice(0, -1)}broken`],
    ['extra raw receipt field', (raw: string) => `${raw.slice(0, -1)},"extra":true}`],
    ['duplicate exact raw receipt', (raw: string) => `${raw}\n${raw}`],
  ] as const)('fails when the real receipt row is %s after C1 acceptance', async (_name, mutate) => {
    const directory = temporaryDirectory()
    const fixture = await acceptedReceiptMeaningFixture(directory, 'manual', 'uncertain', `c1b-raw-corrupt-${_name}`)
    rewriteRunReceiptRaw(directory, fixture.binding.runId, mutate)
    const before = directorySnapshot(directory)

    await expect(acceptDeliveryReceipt(directory, fixture.input)).resolves.toEqual({
      status: 'failed',
      input: fixture.input,
    })
    expect(directorySnapshot(directory)).toEqual(before)
  })

  it('fails when the receipt remains but its real attempt row is removed', async () => {
    const directory = temporaryDirectory()
    const fixture = await acceptedReceiptMeaningFixture(directory, 'manual', 'uncertain', 'c1b-attempt-removed')
    removeRunEvents(directory, record => record.runId === fixture.binding.runId && record.event === 'delivery-attempt-claim')
    const before = directorySnapshot(directory)

    await expect(acceptDeliveryReceipt(directory, fixture.input)).resolves.toEqual({
      status: 'failed',
      input: fixture.input,
    })
    expect(directorySnapshot(directory)).toEqual(before)
  })

  it.each([
    ['prepared object conflict', (directory: string, fixture: Awaited<ReturnType<typeof acceptedReceiptMeaningFixture>>) => {
      rewriteRunRow(directory, record => record.event === 'prepared-delivery' && record.runId === fixture.binding.runId,
        record => ({ ...record, objectId: `${String(record.objectId)}-foreign` }))
    }],
    ['A claim conflict', (directory: string, fixture: Awaited<ReturnType<typeof acceptedReceiptMeaningFixture>>) => {
      const rows = ownerRows(directory)
      const index = rows.records.findIndex(record => record.event === 'external-first-lineage'
        && (record.claim as Record<string, unknown>).runId === fixture.binding.runId)
      if (index < 0) throw new Error('missing real A owner row')
      const lines = [...rows.lines]
      const record = rows.records[index]
      if (record === undefined) throw new Error('missing real A owner record')
      lines[index] = JSON.stringify({ ...record, claim: { ...(record.claim as Record<string, unknown>), sessionId: 'foreign-session' } })
      writeFileSync(rows.path, `${lines.join('\n')}\n`, 'utf8')
    }],
    ['B object conflict', (directory: string, fixture: Awaited<ReturnType<typeof acceptedReceiptMeaningFixture>>) => {
      const row = primaryOwnerRow(directory)
      const lines = [...row.lines]
      lines[row.index] = JSON.stringify({ ...row.record, objectId: `${String(row.record.objectId)}-foreign` })
      writeFileSync(row.path, `${lines.join('\n')}\n`, 'utf8')
    }],
  ] as const)('fails when a real %s corrupts the technical/object chain', async (_name, mutate) => {
    const directory = temporaryDirectory()
    const fixture = await acceptedReceiptMeaningFixture(directory, 'scheduled', 'failed', `c1b-chain-${_name}`)
    mutate(directory, fixture)
    const before = directorySnapshot(directory)

    await expect(acceptDeliveryReceipt(directory, fixture.input)).resolves.toEqual({ status: 'failed', input: fixture.input })
    expect(directorySnapshot(directory)).toEqual(before)
  })

  it('fails when a real prefinish acknowledgement remains but the receipt is removed after meaning exists', async () => {
    const directory = temporaryDirectory()
    const fixture = await acceptedReceiptMeaningFixture(directory, 'manual', 'uncertain', 'c1b-ack-receipt-gap')
    appendPrefinishAck(directory, fixture.receiptRecord)
    removeRunEvents(directory, record => record.runId === fixture.binding.runId && record.event === 'delivery-receipt')
    const before = directorySnapshot(directory)

    await expect(acceptDeliveryReceipt(directory, fixture.input)).resolves.toEqual({ status: 'failed', input: fixture.input })
    expect(directorySnapshot(directory)).toEqual(before)
  })

  it.each([
    ['owner read', 'run-delivery-meaning.jsonl'],
    ['runs fold', 'runs.jsonl'],
  ] as const)('returns failed on %s I/O after C1 acceptance', async (_name, targetFile) => {
    const directory = temporaryDirectory()
    const fixture = await acceptedReceiptMeaningFixture(directory, 'scheduled', 'delivered', `c1b-io-${_name}`)
    const originalReadLines = JsonlStore.prototype.readLines
    let targetReads = 0
    vi.spyOn(JsonlStore.prototype, 'readLines').mockImplementation(function (this: JsonlStore) {
      const file = String(Reflect.get(this, 'file'))
      if (file.endsWith(targetFile)) {
        targetReads += 1
        throw new Error(`C1b ${_name} read failed`)
      }
      return originalReadLines.call(this)
    })
    const before = directorySnapshot(directory)

    await expect(acceptDeliveryReceipt(directory, fixture.input)).resolves.toEqual({ status: 'failed', input: fixture.input })
    expect(targetReads).toBe(1)
    expect(directorySnapshot(directory)).toEqual(before)
  })

  it('fails when meaning append throws before writing', async () => {
    const directory = temporaryDirectory()
    const fixture = await acceptedReceiptMeaningFixture(directory, 'manual', 'failed', 'c1b-append-before')
    const rows = ownerRows(directory)
    const lines = rows.lines.filter((_line, index) => rows.records[index]?.event !== 'run-delivery-meaning')
    writeFileSync(rows.path, `${lines.join('\n')}\n`, 'utf8')
    vi.spyOn(JsonlStore.prototype, 'append').mockImplementationOnce(() => {
      throw new Error('meaning append before write')
    })
    const before = directorySnapshot(directory)

    await expect(acceptDeliveryReceipt(directory, fixture.input)).resolves.toEqual({ status: 'failed', input: fixture.input })
    expect(directorySnapshot(directory)).toEqual(before)
  })

  it('reads back a meaning row after append throws after writing and replays without another row', async () => {
    const directory = temporaryDirectory()
    const fixture = await acceptedReceiptMeaningFixture(directory, 'scheduled', 'uncertain', 'c1b-append-after')
    const rows = ownerRows(directory)
    const lines = rows.lines.filter((_line, index) => rows.records[index]?.event !== 'run-delivery-meaning')
    writeFileSync(rows.path, `${lines.join('\n')}\n`, 'utf8')
    const originalAppend = JsonlStore.prototype.append
    vi.spyOn(JsonlStore.prototype, 'append').mockImplementationOnce(function (this: JsonlStore, record: unknown) {
      originalAppend.call(this, record)
      throw new Error('meaning append after write')
    })
    const before = directorySnapshot(directory)
    const expected = expectedReceiptAcceptance(fixture.receipt, fixture.primaryBinding, 'uncertain', fixture.receiptDigest)

    await expect(acceptDeliveryReceipt(directory, fixture.input)).resolves.toEqual(expected)
    const afterFirst = directorySnapshot(directory)
    await expect(acceptDeliveryReceipt(directory, fixture.input)).resolves.toEqual(expected)
    await expect(acceptDeliveryReceipt(directory, fixture.input)).resolves.toEqual(expected)
    expect(directorySnapshot(directory)).toEqual(afterFirst)
    expect(directorySnapshot(directory)).not.toEqual(before)
  })

  it.each([
    ['malformed', (directory: string) => rewriteMeaningOwnerRaw(directory, raw => `${raw.slice(0, -1)}broken`)],
    ['duplicate', (directory: string) => {
      const row = meaningOwnerRow(directory)
      const raw = row.lines[row.index]
      if (raw === undefined) throw new Error('missing meaning owner line')
      const lines = [...row.lines]
      lines.splice(row.index + 1, 0, raw)
      writeFileSync(row.path, `${lines.join('\n')}\n`, 'utf8')
    }],
    ['digest', (directory: string) => rewriteMeaningOwnerRow(directory, record => ({ ...record, receiptDigest: 'c'.repeat(64) }))],
  ] as const)('fails C1 A and B API calls when a real meaning row is %s', async (_name, corrupt) => {
    const directory = temporaryDirectory()
    const fixture = await acceptedReceiptMeaningFixture(directory, 'scheduled', 'failed', `c1b-api-${_name}`)
    const newPrepared = durablePreparedClaim(directory, 'manual', `c1b-api-${_name}-new-b`)
    const newBInput = primaryInput(newPrepared.binding, {
      objectId: newPrepared.prepared.objectId,
      businessRunId: `business-run-new-${_name}`,
      businessPeriodId: `business-period-new-${_name}`,
    })
    await expect(registerExternalFirstLineage(directory, newPrepared.binding)).resolves.toEqual({
      status: 'accepted',
      value: { claim: newPrepared.binding, runLineage: 'external_first' },
    })
    const newClaim = durableClaim(directory, 'scheduled', `c1b-api-${_name}-new-a`)
    const newABinding = exactClaimBinding(newClaim)
    corrupt(directory)
    const existingBInput = primaryInput(fixture.binding, {
      objectId: fixture.primaryBinding.objectId,
      businessRunId: fixture.primaryBinding.businessRunId,
      businessPeriodId: fixture.primaryBinding.businessPeriodId,
    })
    const before = directorySnapshot(directory)

    await expect(registerExternalFirstLineage(directory, newABinding)).resolves.toEqual({
      status: 'failed',
      input: newABinding,
    })
    expect(directorySnapshot(directory)).toEqual(before)
    await expect(registerPrimaryRunContentObject(directory, existingBInput)).resolves.toEqual({
      status: 'failed',
      input: existingBInput,
    })
    expect(directorySnapshot(directory)).toEqual(before)
    await expect(registerPrimaryRunContentObject(directory, newBInput)).resolves.toEqual({
      status: 'failed',
      input: newBInput,
    })
    expect(directorySnapshot(directory)).toEqual(before)
  })

  it.each([
    ['delivered', 'not_authorized'],
    ['uncertain', 'not_authorized'],
    ['failed', 'authorized'],
  ] as const)('keeps %s retry meaning stable across rebuild without C29 calls', async (deliveryState, retryStatus) => {
    const directory = temporaryDirectory()
    const fixture = await acceptedReceiptMeaningFixture(directory, 'manual', deliveryState, `c1b-rebuild-${deliveryState}`)
    const requestFailureNotification = vi.fn()
    const before = directorySnapshot(directory)
    const rebuilt = await acceptDeliveryReceipt(directory, fixture.input, { requestFailureNotification })
    const expected = expectedReceiptAcceptance(fixture.receipt, fixture.primaryBinding, deliveryState, fixture.receiptDigest)

    expect(rebuilt).toEqual(expected)
    expect(Reflect.get(acceptedMeaningValue(rebuilt).retry, 'status')).toBe(retryStatus)
    expect(requestFailureNotification).not.toHaveBeenCalled()
    expect(directorySnapshot(directory)).toEqual(before)
  })
})
