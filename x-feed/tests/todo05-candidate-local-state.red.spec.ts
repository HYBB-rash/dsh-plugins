import { chmodSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createCandidateLocalState,
  type CandidateLocalCompletionPort,
  type CandidateLocalCompletionResult,
  type CandidateLocalStateOptions,
  type CandidateLocalStateRuntime,
} from '../src/personal-feed/candidate-local-state.ts'
import { X_FEED_SOURCE_IDENTITY } from '../src/feed-scope-adapter.ts'
import {
  createCandidateMaterialProjection,
  createCurrentContextProjection,
  createMechanicalAdmission,
  createPeriodBusinessFinalizer,
  createPersonalFeedScopeService,
} from '@herman/personal-feed'
import type {
  CandidatePeriodBusinessFinalizerOptions,
  CandidateIdentity,
  CandidateDispositionReceiver,
  CandidateDispositionValue,
  C17Result,
  C18Result,
  ExternalPeriodScopeInput,
  FormalCandidateDisposition,
  PeriodIdentity,
  PeriodReference,
  RunIdentity,
  SourceIdentity,
  SourceCandidateReference,
  SourceStableReference,
  SourceDispositionState,
  SourceCandidateReportFinalizer,
  PeriodBusinessFinalizer,
  UnscreenedMaterialCandidate,
  UnscreenedSourceCandidateReport,
} from '@herman/personal-feed'

const temporaryDirectories: string[] = []
const appendAfterControl = vi.hoisted(() => ({ throwBeforeRename: false, throwAfterRename: false }))

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    renameSync: (
      oldPath: Parameters<typeof actual.renameSync>[0],
      newPath: Parameters<typeof actual.renameSync>[1],
    ): void => {
      if (appendAfterControl.throwBeforeRename) {
        appendAfterControl.throwBeforeRename = false
        throw new Error('append failed before rename')
      }
      actual.renameSync(oldPath, newPath)
      if (appendAfterControl.throwAfterRename) {
        appendAfterControl.throwAfterRename = false
        throw new Error('append acknowledgement lost after durable rename')
      }
    },
  }
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function snapshotDirectory(directory: string): readonly [string, Buffer][] {
  return readdirSync(directory).sort().flatMap(name => {
    const path = join(directory, name)
    return statSync(path).isFile() ? [[name, readFileSync(path)] as [string, Buffer]] : []
  })
}

type LedgerMutation = (records: Record<string, unknown>[]) => void

function readLedgerRecords(path: string): Record<string, unknown>[] {
  return readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
}

function writeLedgerRecords(path: string, records: readonly Record<string, unknown>[]): void {
  writeFileSync(path, `${records.map(record => JSON.stringify(record)).join('\n')}\n`, 'utf8')
}

function countLedgerEvent(path: string, event: string): number {
  if (!existsSync(path)) return 0
  return readLedgerRecords(path).filter(record => record.event === event).length
}

function recordObject(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key]
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`ledger ${key} is not an object`)
  return value as Record<string, unknown>
}

function recordAt(records: readonly Record<string, unknown>[], index: number): Record<string, unknown> {
  const record = records[index]
  if (record === undefined) throw new Error(`ledger record ${index + 1} is missing`)
  return record
}

function realOwnerFixture(suffix: string) {
  const directory = mkdtempSync(join(tmpdir(), `x-feed-todo05-candidate-local-state-hardening-${suffix}-`))
  temporaryDirectories.push(directory)
  const ledgerPath = join(directory, 'candidate-local-state.jsonl')
  const period = testPeriod(`hardening-${suffix}`)
  const candidate = xCandidate(`x-hardening:${suffix}`, `x:hardening:${suffix}`)
  const input = disposition(period, candidate, 'Shown')
  const state = createCandidateLocalState({ ledgerPath })
  expect(state.candidateDispositionReceiver.acceptFormalDisposition(input)).toEqual({
    status: 'accepted', value: { disposition: input },
  })
  expect(statSync(ledgerPath).mode & 0o777).toBe(0o600)
  return { directory, ledgerPath, period, candidate, input, state }
}

const ownerCorruptions: readonly [string, LedgerMutation][] = [
  ['extra top-level key', records => { recordAt(records, 0).extra = true }],
  ['wrong event', records => { recordAt(records, 0).event = 'candidate_disposition_rejected' }],
  ['missing schema version', records => { delete recordAt(records, 0).schemaVersion }],
  ['missing event', records => { delete recordAt(records, 0).event }],
  ['missing disposition', records => { delete recordAt(records, 0).disposition }],
  ['missing state', records => { delete recordAt(records, 0).state }],
  ['wrong schema version', records => { recordAt(records, 0).schemaVersion = 2 }],
  ['missing nested state field', records => { delete recordObject(recordAt(records, 0), 'state').state }],
  ['missing nested disposition field', records => { delete recordObject(recordAt(records, 0), 'disposition').value }],
  ['extra disposition key', records => { recordObject(recordAt(records, 0), 'disposition').extra = true }],
  ['extra state key', records => { recordObject(recordAt(records, 0), 'state').extra = true }],
  ['extra period key', records => { recordObject(recordObject(recordAt(records, 0), 'disposition'), 'period').extra = true }],
  ['extra candidate key', records => { recordObject(recordObject(recordAt(records, 0), 'disposition'), 'candidate').extra = true }],
  ['state period mismatches disposition', records => {
    const period = recordObject(recordObject(recordAt(records, 0), 'state'), 'period')
    period.run = `${period.run}-other`
  }],
  ['state candidate mismatches disposition', records => {
    const candidate = recordObject(recordObject(recordAt(records, 0), 'state'), 'candidate')
    candidate.stableReference = `${candidate.stableReference}-other`
  }],
  ['state value mismatches disposition', records => { recordObject(recordAt(records, 0), 'state').state = 'Suppressed' }],
]

type ApplicableDispositionValue = Extract<FormalCandidateDisposition['value'],
  'MaterialUnavailableAndClosed' | 'ReviewedNotSelected' | 'Shown' | 'NotDeliveredThisPeriod' | 'PossiblyDelivered'>

function testPeriod(suffix: string): PeriodIdentity {
  return {
    run: `todo05-x-candidate-local-state-run:${suffix}` as RunIdentity,
    period: `todo05-x-candidate-local-state-period:${suffix}` as PeriodReference,
  }
}

function xCandidate(candidate: string, stableReference: string): SourceCandidateReference {
  return {
    source: X_FEED_SOURCE_IDENTITY as SourceIdentity,
    candidate: candidate as CandidateIdentity,
    stableReference: stableReference as SourceStableReference,
  }
}

function sameCandidateReference(left: SourceCandidateReference, right: SourceCandidateReference): boolean {
  return left.source === right.source
    && left.candidate === right.candidate
    && left.stableReference === right.stableReference
}

function disposition(
  period: PeriodIdentity,
  candidate: SourceCandidateReference,
  value: ApplicableDispositionValue,
): FormalCandidateDisposition {
  return { period, source: candidate.source, candidate, value }
}

function newLegalDisposition(suffix: string): FormalCandidateDisposition {
  return disposition(
    testPeriod(`hardening-new-${suffix}`),
    xCandidate(`x-hardening-new:${suffix}`, `x:hardening-new:${suffix}`),
    'Shown',
  )
}

type C17CompletionOverride = (
  input: FormalCandidateDisposition,
  forward: () => C17Result,
) => C17Result

type C18CompletionOverride = (
  input: SourceDispositionState,
  forward: () => C18Result,
) => C18Result

async function createRealUnavailableCompletionFixture(suffix: string, candidateCount = 1) {
  const directory = mkdtempSync(join(tmpdir(), `x-feed-todo05-c18-${suffix}-`))
  temporaryDirectories.push(directory)
  const periodScopeLedgerPath = join(directory, 'period-scopes.jsonl')
  const reportLedgerPath = join(directory, 'source-candidate-reports.jsonl')
  const candidatePeriodLedgerPath = join(directory, 'candidate-period-facts.jsonl')
  const periodBusinessLedgerPath = join(directory, 'period-business.jsonl')
  const localLedgerPath = join(directory, 'candidate-local-state.jsonl')
  const source = X_FEED_SOURCE_IDENTITY as SourceIdentity
  const scopeInput: ExternalPeriodScopeInput = {
    requestIdentity: `dsh-cron:todo05-c18-${suffix}`,
    trigger: 'scheduled',
    scheduledFor: '2026-08-24T08:00:00.000Z',
    claimedAt: '2026-08-24T08:00:01.000Z',
    runId: `todo05-c18-${suffix}@2026-08-24T08:00:00.000Z`,
    requiredSources: [source],
    reportingWindowClosesAt: '2026-08-24T08:05:00.000Z',
  }
  const scopeService = createPersonalFeedScopeService({
    ledgerPath: periodScopeLedgerPath,
    sourceScopes: [{
      source,
      mechanicalAdmission: createMechanicalAdmission(source),
      candidateMaterialProjection: createCandidateMaterialProjection(source),
    }],
    currentContextProjection: createCurrentContextProjection(),
  })
  const established = await scopeService.establishExternalPeriodScope(scopeInput)
  const mechanicalScope = established.c32[0]?.value
  const materialScope = established.c35[0]?.value
  if (mechanicalScope === undefined || materialScope === undefined) {
    throw new Error('real C18 fixture did not establish the X source scope')
  }
  const period = established.c01.value.period
  const candidates: UnscreenedMaterialCandidate[] = Array.from({ length: candidateCount }, (_, index) => {
    const reference = xCandidate(`x-c18:${suffix}:${index}`, `x:c18:${suffix}:${index}`)
    return {
      period,
      candidate: reference,
      qualification: {
        branch: 'unscreened',
        contract: 'C08',
        scope: mechanicalScope,
        period,
        candidate: reference,
        acceptedQualification: { contract: 'C08' },
      },
      materialBasis: {
        candidate: reference,
        acceptedBasis: { contract: 'C09' },
      },
    }
  })
  const primaryCandidate = candidates[0]
  if (primaryCandidate === undefined) throw new Error('real C18 fixture needs at least one candidate')
  const report: UnscreenedSourceCandidateReport = {
    branch: 'unscreened',
    scope: materialScope,
    period,
    source,
    candidates,
  }
  let finalizer: PeriodBusinessFinalizer & SourceCandidateReportFinalizer
  let requestOverride: C17CompletionOverride | undefined
  let stateOverride: C18CompletionOverride | undefined
  const requestSourceDisposition = vi.fn<CandidateLocalCompletionPort['requestSourceDisposition']>(input => {
    const forward = (): C17Result => finalizer.requestSourceDisposition(input)
    return requestOverride === undefined ? forward() : requestOverride(input, forward)
  })
  const acceptSourceDispositionState = vi.fn<CandidateLocalCompletionPort['acceptSourceDispositionState']>(input => {
    const forward = (): C18Result => finalizer.acceptSourceDispositionState(input)
    return stateOverride === undefined ? forward() : stateOverride(input, forward)
  })
  const local = createCandidateLocalState({
    ledgerPath: localLedgerPath,
    completionPort: { requestSourceDisposition, acceptSourceDispositionState },
  })
  finalizer = createPeriodBusinessFinalizer({
    periodScopeLedgerPath,
    reportLedgerPath,
    candidatePeriodLedgerPath,
    periodBusinessLedgerPath,
    now: () => '2026-08-24T08:02:00.000Z',
    candidateDispositionReceiver: local.candidateDispositionReceiver,
  })
  const reportResult = finalizer.acceptSourceCandidateReport(report)
  expect(reportResult.status).toBe('accepted')
  if (reportResult.status !== 'accepted') throw new Error('real C18 fixture C36 was not accepted')
  for (const candidate of candidates) {
    const candidateResult = finalizer.acceptCandidateIntoPeriod({ report: reportResult.value, candidate })
    expect(candidateResult.status).toBe('accepted')
    if (candidateResult.status !== 'accepted') throw new Error('real C18 fixture C26 was not accepted')
    const materialFact = {
      kind: 'material_unavailable' as const,
      acceptedIntoPeriod: candidateResult.value,
      period,
      candidate: candidate.candidate,
      unavailableFact: { reason: 'source material was not available' },
    }
    expect(finalizer.acceptMaterialFact(materialFact)).toEqual({
      status: 'accepted', value: { fact: materialFact },
    })
  }
  return {
    directory,
    localLedgerPath,
    periodBusinessLedgerPath,
    period,
    candidate: primaryCandidate.candidate,
    candidates: candidates.map(candidate => candidate.candidate),
    finalizer,
    local,
    completionPort: { requestSourceDisposition, acceptSourceDispositionState },
    requestSourceDisposition,
    acceptSourceDispositionState,
    setRequestOverride: (value: C17CompletionOverride | undefined): void => { requestOverride = value },
    setStateOverride: (value: C18CompletionOverride | undefined): void => { stateOverride = value },
  }
}

async function createRealCompletedUnavailableFixture(suffix: string) {
  const fixture = await createRealUnavailableCompletionFixture(suffix)
  const pending = disposition(fixture.period, fixture.candidate, 'MaterialUnavailableAndClosed')
  expect(fixture.local.candidateDispositionReceiver.acceptFormalDisposition(pending)).toMatchObject({ status: 'accepted' })
  expect(fixture.local.completePendingSourceDispositions()).toEqual({
    status: 'completed', value: { completed: 1 },
  })
  return { ...fixture, pending }
}

function completionRecordIndex(records: readonly Record<string, unknown>[]): number {
  const index = records.findIndex(record => record.event === 'source_disposition_completion_accepted')
  if (index < 0) throw new Error('real candidate-local-state ledger has no completion row')
  return index
}

function completionRecord(records: readonly Record<string, unknown>[]): Record<string, unknown> {
  return recordAt(records, completionRecordIndex(records))
}

const completionCorruptions: readonly [string, LedgerMutation][] = [
  ['extra top-level key', records => { completionRecord(records).extra = true }],
  ['missing schema version', records => { delete completionRecord(records).schemaVersion }],
  ['wrong schema version', records => { completionRecord(records).schemaVersion = 2 }],
  ['missing event', records => { delete completionRecord(records).event }],
  ['wrong event', records => { completionRecord(records).event = 'source_disposition_completion_rejected' }],
  ['missing state', records => { delete completionRecord(records).state }],
  ['extra state key', records => { recordObject(completionRecord(records), 'state').extra = true }],
  ['missing state period', records => { delete recordObject(completionRecord(records), 'state').period }],
  ['extra state period key', records => {
    recordObject(recordObject(completionRecord(records), 'state'), 'period').extra = true
  }],
  ['missing state candidate', records => { delete recordObject(completionRecord(records), 'state').candidate }],
  ['extra state candidate key', records => {
    recordObject(recordObject(completionRecord(records), 'state'), 'candidate').extra = true
  }],
  ['missing state sourceCompletion', records => {
    delete recordObject(completionRecord(records), 'state').sourceCompletion
  }],
  ['extra sourceCompletion key', records => {
    recordObject(recordObject(completionRecord(records), 'state'), 'sourceCompletion').extra = true
  }],
  ['state period diverges from sourceCompletion', records => {
    const period = recordObject(recordObject(completionRecord(records), 'state'), 'period')
    period.run = `${String(period.run)}-other`
  }],
  ['state candidate diverges from sourceCompletion', records => {
    const candidate = recordObject(recordObject(completionRecord(records), 'state'), 'candidate')
    candidate.stableReference = `${String(candidate.stableReference)}-other`
  }],
  ['state value diverges from sourceCompletion', records => {
    recordObject(completionRecord(records), 'state').state = 'Displayed'
  }],
  ['sourceCompletion disposition diverges from its owner', records => {
    const sourceCompletion = recordObject(recordObject(completionRecord(records), 'state'), 'sourceCompletion')
    recordObject(sourceCompletion, 'disposition').value = 'ReviewedNotSelected'
  }],
  ['duplicate exact physical completion', records => {
    records.push(structuredClone(completionRecord(records)) as Record<string, unknown>)
  }],
  ['same-scope conflicting completion', records => {
    const conflict = structuredClone(completionRecord(records)) as Record<string, unknown>
    const state = recordObject(conflict, 'state')
    state.state = 'Displayed'
    const sourceCompletion = recordObject(state, 'sourceCompletion')
    recordObject(sourceCompletion, 'disposition').value = 'Shown'
    records.push(conflict)
  }],
  ['orphan completion without its C17 owner', records => {
    const ownerIndex = records.findIndex(record => record.event === 'candidate_disposition_accepted')
    if (ownerIndex < 0) throw new Error('real candidate-local-state ledger has no C17 owner')
    records.splice(ownerIndex, 1)
  }],
  ['completion physically precedes its C17 owner', records => {
    const completionIndex = completionRecordIndex(records)
    const ownerIndex = records.findIndex(record => record.event === 'candidate_disposition_accepted')
    if (ownerIndex < 0) throw new Error('real candidate-local-state ledger has no C17 owner')
    const owner = recordAt(records, ownerIndex)
    const completion = recordAt(records, completionIndex)
    records.splice(Math.max(ownerIndex, completionIndex), 1)
    records.splice(Math.min(ownerIndex, completionIndex), 1)
    records.unshift(completion, owner)
  }],
]

type Equal<Left, Right> = (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2) ? true : false
type Assert<Value extends true> = Value
type _OptionsKeys = Assert<Equal<keyof CandidateLocalStateOptions, 'ledgerPath' | 'completionPort'>>
type _CompletionPortKeys = Assert<Equal<keyof CandidateLocalCompletionPort, 'requestSourceDisposition' | 'acceptSourceDispositionState'>>
type _C17Input = Assert<Equal<Parameters<CandidateLocalCompletionPort['requestSourceDisposition']>[0], FormalCandidateDisposition>>
type _C18Input = Assert<Equal<Parameters<CandidateLocalCompletionPort['acceptSourceDispositionState']>[0], SourceDispositionState>>
type _C17Result = Assert<Equal<ReturnType<CandidateLocalCompletionPort['requestSourceDisposition']>, C17Result>>
type _C18Result = Assert<Equal<ReturnType<CandidateLocalCompletionPort['acceptSourceDispositionState']>, C18Result>>
type _CompletionResult = Assert<Equal<ReturnType<CandidateLocalStateRuntime['completePendingSourceDispositions']>, CandidateLocalCompletionResult>>
type _ReaderResult = Assert<Equal<ReturnType<CandidateLocalStateRuntime['readSourceDispositionState']>, SourceDispositionState | undefined>>

describe('TODO 05 X candidate-local-state bootstrap seam', () => {
  it('requires the future candidate-local-state factory and keeps bootstrap calls fail-closed', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'x-feed-todo05-candidate-local-state-'))
    temporaryDirectories.push(directory)
    const ledgerPath = join(directory, 'candidate-local-state.jsonl')
    const before = snapshotDirectory(directory)
    type _FactoryOptions = Assert<Equal<Parameters<typeof createCandidateLocalState>[0], CandidateLocalStateOptions>>
    type _FactoryRuntime = Assert<Equal<ReturnType<typeof createCandidateLocalState>, CandidateLocalStateRuntime>>
    const invalidDisposition = undefined as unknown as FormalCandidateDisposition
    const legalPeriod: PeriodIdentity = {
      run: 'todo05-candidate-local-state-run' as RunIdentity,
      period: 'todo05-candidate-local-state-period' as PeriodReference,
    }
    const legalCandidate: SourceCandidateReference = {
      source: 'todo05-candidate-local-state-source' as SourceIdentity,
      candidate: 'todo05-candidate-local-state-candidate' as CandidateIdentity,
      stableReference: 'todo05:candidate-local-state' as SourceStableReference,
    }
    const noPortState = createCandidateLocalState({ ledgerPath })
    expect(Object.isFrozen(noPortState)).toBe(true)
    expect(Object.isFrozen(noPortState.candidateDispositionReceiver)).toBe(true)
    expect(Object.keys(noPortState.candidateDispositionReceiver)).toEqual(['acceptFormalDisposition'])
    expect(Object.keys(noPortState).sort()).toEqual([
      'candidateDispositionReceiver',
      'completePendingSourceDispositions',
      'readSourceDispositionState',
    ])
    expect(noPortState.candidateDispositionReceiver.acceptFormalDisposition(invalidDisposition)).toEqual({
      status: 'rejected', input: invalidDisposition,
    })
    expect(noPortState.completePendingSourceDispositions()).toEqual({ status: 'failed' })
    expect(noPortState.readSourceDispositionState(
      legalPeriod,
      legalCandidate,
    )).toBeUndefined()

    const requestSourceDisposition = vi.fn<CandidateLocalCompletionPort['requestSourceDisposition']>(disposition => ({
      status: 'failed', input: disposition,
    }))
    const acceptSourceDispositionState = vi.fn<CandidateLocalCompletionPort['acceptSourceDispositionState']>(state => ({
      status: 'failed', input: state,
    }))
    const healthyPort: CandidateLocalCompletionPort = { requestSourceDisposition, acceptSourceDispositionState }
    const healthyState = createCandidateLocalState({ ledgerPath, completionPort: healthyPort })
    expect(Object.isFrozen(healthyState)).toBe(true)
    expect(Object.isFrozen(healthyState.candidateDispositionReceiver)).toBe(true)
    expect(Object.keys(healthyState.candidateDispositionReceiver)).toEqual(['acceptFormalDisposition'])
    expect(Object.keys(healthyState).sort()).toEqual([
      'candidateDispositionReceiver',
      'completePendingSourceDispositions',
      'readSourceDispositionState',
    ])
    expect(healthyState.completePendingSourceDispositions()).toEqual({
      status: 'completed', value: { completed: 0 },
    })
    expect(requestSourceDisposition).not.toHaveBeenCalled()
    expect(acceptSourceDispositionState).not.toHaveBeenCalled()
    expect(healthyState.readSourceDispositionState(
      legalPeriod,
      legalCandidate,
    )).toBeUndefined()
    expect(snapshotDirectory(directory)).toEqual(before)
  })

  it.each([
    'MaterialUnavailableAndClosed',
    'ReviewedNotSelected',
    'Shown',
    'NotDeliveredThisPeriod',
    'PossiblyDelivered',
  ] as const)('accepts a valid X C17 disposition and exposes only its stable C18 owner for %s', value => {
    const directory = mkdtempSync(join(tmpdir(), 'x-feed-todo05-candidate-local-state-c17-'))
    temporaryDirectories.push(directory)
    const ledgerPath = join(directory, 'candidate-local-state.jsonl')
    const period = testPeriod(value)
    const candidate = xCandidate(`x-status:${value}`, `x:status:${value}`)
    const requestSourceDisposition = vi.fn<CandidateLocalCompletionPort['requestSourceDisposition']>(dispositionInput => ({
      status: 'failed', input: dispositionInput,
    }))
    const acceptSourceDispositionState = vi.fn<CandidateLocalCompletionPort['acceptSourceDispositionState']>(stateInput => ({
      status: 'failed', input: stateInput,
    }))
    const state = createCandidateLocalState({
      ledgerPath,
      completionPort: { requestSourceDisposition, acceptSourceDispositionState },
    })
    const input = disposition(period, candidate, value)
    const result = state.candidateDispositionReceiver.acceptFormalDisposition(input)
    expect(result).toEqual({ status: 'accepted', value: { disposition: input } })
    if (result.status !== 'accepted') throw new Error('valid C17 disposition did not accept')
    expect(result.value).not.toHaveProperty('state')
    expect(requestSourceDisposition).not.toHaveBeenCalled()
    expect(acceptSourceDispositionState).not.toHaveBeenCalled()
    const firstOwner = state.readSourceDispositionState(period, candidate)
    expect(firstOwner).toBeDefined()
    if (firstOwner === undefined) throw new Error('accepted C17 did not expose a C18 owner')
    expect(firstOwner.period).toEqual(period)
    expect(firstOwner.candidate).toEqual(candidate)
    expect(firstOwner.state).toBe(value === 'Shown' ? 'Displayed' : 'Suppressed')
    expect(firstOwner.sourceCompletion).toBeDefined()
    const firstBytes = snapshotDirectory(directory)
    const ledgerLines = readFileSync(ledgerPath, 'utf8').split('\n').filter(line => line.trim() !== '')
    expect(ledgerLines).toHaveLength(1)
    expect(state.candidateDispositionReceiver.acceptFormalDisposition(input)).toEqual(result)
    expect(snapshotDirectory(directory)).toEqual(firstBytes)
    const rebuilt = createCandidateLocalState({
      ledgerPath,
      completionPort: { requestSourceDisposition, acceptSourceDispositionState },
    })
    expect(rebuilt.candidateDispositionReceiver.acceptFormalDisposition(input)).toEqual(result)
    const rebuiltOwner = rebuilt.readSourceDispositionState(period, candidate)
    expect(rebuiltOwner).toBeDefined()
    if (rebuiltOwner === undefined) throw new Error('rebuild lost accepted C18 owner')
    expect(rebuiltOwner.period).toEqual(firstOwner.period)
    expect(rebuiltOwner.candidate).toEqual(firstOwner.candidate)
    expect(rebuiltOwner.state).toEqual(firstOwner.state)
    expect(rebuiltOwner.sourceCompletion).toEqual(firstOwner.sourceCompletion)
    expect(snapshotDirectory(directory)).toEqual(firstBytes)
  })

  it('completes one pending unavailable owner through the real PF C17 and C18 chain exactly once', async () => {
    const fixture = await createRealUnavailableCompletionFixture('single-positive')
    const pending = disposition(fixture.period, fixture.candidate, 'MaterialUnavailableAndClosed')
    expect(fixture.local.candidateDispositionReceiver.acceptFormalDisposition(pending)).toEqual({
      status: 'accepted', value: { disposition: pending },
    })
    expect(fixture.requestSourceDisposition).not.toHaveBeenCalled()
    expect(fixture.acceptSourceDispositionState).not.toHaveBeenCalled()

    expect(fixture.local.completePendingSourceDispositions()).toEqual({
      status: 'completed', value: { completed: 1 },
    })
    expect(fixture.requestSourceDisposition).toHaveBeenCalledTimes(1)
    expect(fixture.requestSourceDisposition).toHaveBeenCalledWith(pending)
    const expectedState = fixture.local.readSourceDispositionState(fixture.period, fixture.candidate)
    expect(expectedState).toMatchObject({ state: 'Suppressed' })
    expect(fixture.acceptSourceDispositionState).toHaveBeenCalledTimes(1)
    expect(fixture.acceptSourceDispositionState).toHaveBeenCalledWith(expectedState)
    const businessRecords = readLedgerRecords(fixture.periodBusinessLedgerPath)
    expect(businessRecords.filter(record => record.event === 'candidate_disposition_accepted')).toHaveLength(1)
    expect(businessRecords.filter(record => record.event === 'source_disposition_state_accepted')).toHaveLength(1)
    const afterCompletion = snapshotDirectory(fixture.directory)

    expect(fixture.local.completePendingSourceDispositions()).toEqual({
      status: 'completed', value: { completed: 0 },
    })
    expect(fixture.requestSourceDisposition).toHaveBeenCalledTimes(1)
    expect(fixture.acceptSourceDispositionState).toHaveBeenCalledTimes(1)
    expect(snapshotDirectory(fixture.directory)).toEqual(afterCompletion)

    const rebuilt = createCandidateLocalState({
      ledgerPath: fixture.localLedgerPath,
      completionPort: fixture.completionPort,
    })
    expect(rebuilt.completePendingSourceDispositions()).toEqual({
      status: 'completed', value: { completed: 0 },
    })
    expect(fixture.requestSourceDisposition).toHaveBeenCalledTimes(1)
    expect(fixture.acceptSourceDispositionState).toHaveBeenCalledTimes(1)
    expect(snapshotDirectory(fixture.directory)).toEqual(afterCompletion)
  })

  it.each(['rejected', 'failed', 'unknown', 'throw', 'wrong-accepted'] as const)(
    'keeps a C17 owner pending and never calls C18 when the real C17 handoff is %s',
    async failure => {
      const fixture = await createRealUnavailableCompletionFixture(`c17-${failure}`)
      const pending = disposition(fixture.period, fixture.candidate, 'MaterialUnavailableAndClosed')
      expect(fixture.local.candidateDispositionReceiver.acceptFormalDisposition(pending)).toMatchObject({ status: 'accepted' })
      const localBefore = readFileSync(fixture.localLedgerPath)
      let wrongAccepted: C17Result | undefined
      if (failure === 'wrong-accepted') {
        const other = await createRealUnavailableCompletionFixture('c17-wrong-other')
        const otherDisposition = disposition(other.period, other.candidate, 'MaterialUnavailableAndClosed')
        expect(other.local.candidateDispositionReceiver.acceptFormalDisposition(otherDisposition)).toMatchObject({ status: 'accepted' })
        wrongAccepted = other.finalizer.requestSourceDisposition(otherDisposition)
        expect(wrongAccepted.status).toBe('accepted')
      }
      fixture.setRequestOverride(input => {
        if (failure === 'throw') throw new Error('C17 port failed')
        if (failure === 'unknown') return { status: 'unknown', input } as unknown as C17Result
        if (failure === 'wrong-accepted') {
          if (wrongAccepted === undefined) throw new Error('real wrong C17 result was not prepared')
          return wrongAccepted
        }
        return { status: failure, input }
      })

      expect(fixture.local.completePendingSourceDispositions()).toEqual({ status: 'failed' })
      expect(fixture.requestSourceDisposition).toHaveBeenCalledTimes(1)
      expect(fixture.acceptSourceDispositionState).not.toHaveBeenCalled()
      expect(readFileSync(fixture.localLedgerPath)).toEqual(localBefore)
      expect(countLedgerEvent(fixture.periodBusinessLedgerPath, 'candidate_disposition_accepted')).toBe(0)
      expect(countLedgerEvent(fixture.periodBusinessLedgerPath, 'source_disposition_state_accepted')).toBe(0)

      fixture.setRequestOverride(undefined)
      expect(fixture.local.completePendingSourceDispositions()).toEqual({
        status: 'completed', value: { completed: 1 },
      })
      expect(fixture.requestSourceDisposition).toHaveBeenCalledTimes(2)
      expect(fixture.acceptSourceDispositionState).toHaveBeenCalledTimes(1)
      expect(countLedgerEvent(fixture.periodBusinessLedgerPath, 'candidate_disposition_accepted')).toBe(1)
      expect(countLedgerEvent(fixture.periodBusinessLedgerPath, 'source_disposition_state_accepted')).toBe(1)
    },
  )

  it.each(['rejected', 'failed', 'unknown', 'throw', 'wrong-accepted'] as const)(
    'keeps a C18 owner pending after C17 when the real C18 handoff is %s',
    async failure => {
      const fixture = await createRealUnavailableCompletionFixture(`c18-${failure}`)
      const pending = disposition(fixture.period, fixture.candidate, 'MaterialUnavailableAndClosed')
      expect(fixture.local.candidateDispositionReceiver.acceptFormalDisposition(pending)).toMatchObject({ status: 'accepted' })
      const localBefore = readFileSync(fixture.localLedgerPath)
      let wrongAccepted: C18Result | undefined
      if (failure === 'wrong-accepted') {
        const other = await createRealUnavailableCompletionFixture('c18-wrong-other')
        const otherDisposition = disposition(other.period, other.candidate, 'MaterialUnavailableAndClosed')
        expect(other.local.candidateDispositionReceiver.acceptFormalDisposition(otherDisposition)).toMatchObject({ status: 'accepted' })
        const otherC17 = other.finalizer.requestSourceDisposition(otherDisposition)
        expect(otherC17.status).toBe('accepted')
        if (otherC17.status !== 'accepted') throw new Error('real wrong C18 basis was not accepted')
        const otherState = other.local.readSourceDispositionState(other.period, other.candidate)
        if (otherState === undefined) throw new Error('real wrong C18 owner was not durable')
        wrongAccepted = other.finalizer.acceptSourceDispositionState(otherState)
        expect(wrongAccepted.status).toBe('accepted')
      }
      fixture.setStateOverride(input => {
        if (failure === 'throw') throw new Error('C18 port failed')
        if (failure === 'unknown') return { status: 'unknown', input } as unknown as C18Result
        if (failure === 'wrong-accepted') {
          if (wrongAccepted === undefined) throw new Error('real wrong C18 result was not prepared')
          return wrongAccepted
        }
        return { status: failure, input }
      })

      expect(fixture.local.completePendingSourceDispositions()).toEqual({ status: 'failed' })
      expect(fixture.requestSourceDisposition).toHaveBeenCalledTimes(1)
      expect(fixture.acceptSourceDispositionState).toHaveBeenCalledTimes(1)
      expect(readFileSync(fixture.localLedgerPath)).toEqual(localBefore)
      expect(countLedgerEvent(fixture.periodBusinessLedgerPath, 'candidate_disposition_accepted')).toBe(1)
      expect(countLedgerEvent(fixture.periodBusinessLedgerPath, 'source_disposition_state_accepted')).toBe(0)

      fixture.setStateOverride(undefined)
      expect(fixture.local.completePendingSourceDispositions()).toEqual({
        status: 'completed', value: { completed: 1 },
      })
      expect(fixture.requestSourceDisposition).toHaveBeenCalledTimes(2)
      expect(fixture.acceptSourceDispositionState).toHaveBeenCalledTimes(2)
      expect(countLedgerEvent(fixture.periodBusinessLedgerPath, 'candidate_disposition_accepted')).toBe(1)
      expect(countLedgerEvent(fixture.periodBusinessLedgerPath, 'source_disposition_state_accepted')).toBe(1)
    },
  )

  it('continues after the first pending owner fails and repairs only that owner on replay', async () => {
    const fixture = await createRealUnavailableCompletionFixture('partial-repair', 2)
    const firstCandidate = fixture.candidates[0]
    const secondCandidate = fixture.candidates[1]
    if (firstCandidate === undefined || secondCandidate === undefined) throw new Error('partial fixture needs two candidates')
    const first = disposition(fixture.period, firstCandidate, 'MaterialUnavailableAndClosed')
    const second = disposition(fixture.period, secondCandidate, 'MaterialUnavailableAndClosed')
    expect(fixture.local.candidateDispositionReceiver.acceptFormalDisposition(first)).toMatchObject({ status: 'accepted' })
    expect(fixture.local.candidateDispositionReceiver.acceptFormalDisposition(second)).toMatchObject({ status: 'accepted' })
    fixture.setRequestOverride((input, forward) => sameCandidateReference(input.candidate, firstCandidate)
      ? { status: 'failed', input }
      : forward())

    expect(fixture.local.completePendingSourceDispositions()).toEqual({ status: 'failed' })
    expect(fixture.requestSourceDisposition).toHaveBeenCalledTimes(2)
    expect(fixture.acceptSourceDispositionState).toHaveBeenCalledTimes(1)
    expect(fixture.acceptSourceDispositionState.mock.calls[0]?.[0].candidate).toEqual(secondCandidate)
    expect(countLedgerEvent(fixture.periodBusinessLedgerPath, 'candidate_disposition_accepted')).toBe(1)
    expect(countLedgerEvent(fixture.periodBusinessLedgerPath, 'source_disposition_state_accepted')).toBe(1)

    fixture.setRequestOverride(undefined)
    expect(fixture.local.completePendingSourceDispositions()).toEqual({
      status: 'completed', value: { completed: 1 },
    })
    const requestCallsFor = (candidate: SourceCandidateReference): number => fixture.requestSourceDisposition.mock.calls
      .filter(([input]) => sameCandidateReference(input.candidate, candidate)).length
    const stateCallsFor = (candidate: SourceCandidateReference): number => fixture.acceptSourceDispositionState.mock.calls
      .filter(([input]) => sameCandidateReference(input.candidate, candidate)).length
    expect(requestCallsFor(firstCandidate)).toBe(2)
    expect(requestCallsFor(secondCandidate)).toBe(1)
    expect(stateCallsFor(firstCandidate)).toBe(1)
    expect(stateCallsFor(secondCandidate)).toBe(1)
    expect(countLedgerEvent(fixture.periodBusinessLedgerPath, 'candidate_disposition_accepted')).toBe(2)
    expect(countLedgerEvent(fixture.periodBusinessLedgerPath, 'source_disposition_state_accepted')).toBe(2)

    const rebuilt = createCandidateLocalState({
      ledgerPath: fixture.localLedgerPath,
      completionPort: fixture.completionPort,
    })
    expect(rebuilt.completePendingSourceDispositions()).toEqual({
      status: 'completed', value: { completed: 0 },
    })
    expect(requestCallsFor(firstCandidate)).toBe(2)
    expect(requestCallsFor(secondCandidate)).toBe(1)
    expect(stateCallsFor(firstCandidate)).toBe(1)
    expect(stateCallsFor(secondCandidate)).toBe(1)
  })

  it('repairs a local completion ack after real PF C18 succeeded before the local rename failed', async () => {
    const fixture = await createRealUnavailableCompletionFixture('ack-before-repair')
    const pending = disposition(fixture.period, fixture.candidate, 'MaterialUnavailableAndClosed')
    expect(fixture.local.candidateDispositionReceiver.acceptFormalDisposition(pending)).toMatchObject({ status: 'accepted' })
    const localBefore = readFileSync(fixture.localLedgerPath)
    fixture.setStateOverride((_input, forward) => {
      const result = forward()
      if (result.status === 'accepted') appendAfterControl.throwBeforeRename = true
      return result
    })

    expect(fixture.local.completePendingSourceDispositions()).toEqual({ status: 'failed' })
    expect(appendAfterControl.throwBeforeRename).toBe(false)
    expect(readFileSync(fixture.localLedgerPath)).toEqual(localBefore)
    expect(readdirSync(fixture.directory).some(name => name.endsWith('.tmp'))).toBe(false)
    expect(countLedgerEvent(fixture.periodBusinessLedgerPath, 'candidate_disposition_accepted')).toBe(1)
    expect(countLedgerEvent(fixture.periodBusinessLedgerPath, 'source_disposition_state_accepted')).toBe(1)

    fixture.setStateOverride(undefined)
    expect(fixture.local.completePendingSourceDispositions()).toEqual({
      status: 'completed', value: { completed: 1 },
    })
    expect(fixture.requestSourceDisposition).toHaveBeenCalledTimes(2)
    expect(fixture.acceptSourceDispositionState).toHaveBeenCalledTimes(2)
    expect(countLedgerEvent(fixture.periodBusinessLedgerPath, 'candidate_disposition_accepted')).toBe(1)
    expect(countLedgerEvent(fixture.periodBusinessLedgerPath, 'source_disposition_state_accepted')).toBe(1)
    expect(countLedgerEvent(fixture.localLedgerPath, 'candidate_disposition_accepted')).toBe(1)
    expect(countLedgerEvent(fixture.localLedgerPath, 'source_disposition_completion_accepted')).toBe(1)
    expect(fixture.local.completePendingSourceDispositions()).toEqual({
      status: 'completed', value: { completed: 0 },
    })
    expect(fixture.requestSourceDisposition).toHaveBeenCalledTimes(2)
    expect(fixture.acceptSourceDispositionState).toHaveBeenCalledTimes(2)
  })

  it.each(completionCorruptions)('fails every shared operation for a real completion row with %s', async (_name, mutate) => {
    const fixture = await createRealCompletedUnavailableFixture(`completion-corrupt-${_name}`)
    const records = readLedgerRecords(fixture.localLedgerPath)
    const realCompletion = completionRecord(records)
    expect(Object.keys(realCompletion).sort()).toEqual(['event', 'schemaVersion', 'state'])
    expect(Object.keys(recordObject(realCompletion, 'state')).sort()).toEqual([
      'candidate', 'period', 'sourceCompletion', 'state',
    ])
    expect(Object.keys(recordObject(recordObject(realCompletion, 'state'), 'sourceCompletion'))).toEqual(['disposition'])
    mutate(records)
    writeLedgerRecords(fixture.localLedgerPath, records)
    const before = snapshotDirectory(fixture.directory)
    const rebuilt = createCandidateLocalState({
      ledgerPath: fixture.localLedgerPath,
      completionPort: fixture.completionPort,
    })
    const runnerResult = rebuilt.completePendingSourceDispositions()
    const existingResult = rebuilt.candidateDispositionReceiver.acceptFormalDisposition(fixture.pending)
    const newInput = newLegalDisposition(`completion-corrupt-${_name}`)
    const newResult = rebuilt.candidateDispositionReceiver.acceptFormalDisposition(newInput)
    let readerThrew = false
    try {
      rebuilt.readSourceDispositionState(fixture.period, fixture.candidate)
    } catch {
      readerThrew = true
    }

    expect(runnerResult).toEqual({ status: 'failed' })
    expect(existingResult).toEqual({ status: 'failed', input: fixture.pending })
    expect(newResult).toEqual({ status: 'failed', input: newInput })
    expect(readerThrew).toBe(true)
    expect(fixture.requestSourceDisposition).toHaveBeenCalledTimes(1)
    expect(fixture.acceptSourceDispositionState).toHaveBeenCalledTimes(1)
    expect(snapshotDirectory(fixture.directory)).toEqual(before)
  })

  it('fails every shared operation when the completion owner cannot be read', async () => {
    const fixture = await createRealCompletedUnavailableFixture('completion-read-io')
    rmSync(fixture.localLedgerPath)
    mkdirSync(fixture.localLedgerPath)
    const before = snapshotDirectory(fixture.directory)
    const rebuilt = createCandidateLocalState({
      ledgerPath: fixture.localLedgerPath,
      completionPort: fixture.completionPort,
    })
    const runnerResult = rebuilt.completePendingSourceDispositions()
    const existingResult = rebuilt.candidateDispositionReceiver.acceptFormalDisposition(fixture.pending)
    const newInput = newLegalDisposition('completion-read-io')
    const newResult = rebuilt.candidateDispositionReceiver.acceptFormalDisposition(newInput)
    let readerThrew = false
    try {
      rebuilt.readSourceDispositionState(fixture.period, fixture.candidate)
    } catch {
      readerThrew = true
    }

    expect(runnerResult).toEqual({ status: 'failed' })
    expect(existingResult).toEqual({ status: 'failed', input: fixture.pending })
    expect(newResult).toEqual({ status: 'failed', input: newInput })
    expect(readerThrew).toBe(true)
    expect(fixture.requestSourceDisposition).toHaveBeenCalledTimes(1)
    expect(fixture.acceptSourceDispositionState).toHaveBeenCalledTimes(1)
    expect(statSync(fixture.localLedgerPath).isDirectory()).toBe(true)
    expect(snapshotDirectory(fixture.directory)).toEqual(before)
  })

  it('accepts a durable completion after its atomic rename succeeds even when acknowledgement throws', async () => {
    const fixture = await createRealUnavailableCompletionFixture('ack-after-readback')
    const pending = disposition(fixture.period, fixture.candidate, 'MaterialUnavailableAndClosed')
    expect(fixture.local.candidateDispositionReceiver.acceptFormalDisposition(pending)).toMatchObject({ status: 'accepted' })
    fixture.setStateOverride((_input, forward) => {
      const result = forward()
      if (result.status === 'accepted') appendAfterControl.throwAfterRename = true
      return result
    })

    expect(fixture.local.completePendingSourceDispositions()).toEqual({
      status: 'completed', value: { completed: 1 },
    })
    expect(appendAfterControl.throwAfterRename).toBe(false)
    expect(countLedgerEvent(fixture.periodBusinessLedgerPath, 'candidate_disposition_accepted')).toBe(1)
    expect(countLedgerEvent(fixture.periodBusinessLedgerPath, 'source_disposition_state_accepted')).toBe(1)
    expect(countLedgerEvent(fixture.localLedgerPath, 'candidate_disposition_accepted')).toBe(1)
    expect(countLedgerEvent(fixture.localLedgerPath, 'source_disposition_completion_accepted')).toBe(1)
    expect(readdirSync(fixture.directory).some(name => name.endsWith('.tmp'))).toBe(false)
    const afterCompletion = snapshotDirectory(fixture.directory)

    expect(fixture.local.completePendingSourceDispositions()).toEqual({
      status: 'completed', value: { completed: 0 },
    })
    const rebuilt = createCandidateLocalState({
      ledgerPath: fixture.localLedgerPath,
      completionPort: fixture.completionPort,
    })
    expect(rebuilt.completePendingSourceDispositions()).toEqual({
      status: 'completed', value: { completed: 0 },
    })
    expect(fixture.requestSourceDisposition).toHaveBeenCalledTimes(1)
    expect(fixture.acceptSourceDispositionState).toHaveBeenCalledTimes(1)
    expect(snapshotDirectory(fixture.directory)).toEqual(afterCompletion)
  })

  it('persists two independent completion scopes without treating the second owner as corruption', async () => {
    const fixture = await createRealUnavailableCompletionFixture('two-completions', 2)
    for (const candidate of fixture.candidates) {
      const pending = disposition(fixture.period, candidate, 'MaterialUnavailableAndClosed')
      expect(fixture.local.candidateDispositionReceiver.acceptFormalDisposition(pending)).toMatchObject({ status: 'accepted' })
    }
    expect(fixture.local.completePendingSourceDispositions()).toEqual({
      status: 'completed', value: { completed: 2 },
    })
    expect(countLedgerEvent(fixture.localLedgerPath, 'candidate_disposition_accepted')).toBe(2)
    expect(countLedgerEvent(fixture.localLedgerPath, 'source_disposition_completion_accepted')).toBe(2)
    expect(countLedgerEvent(fixture.periodBusinessLedgerPath, 'candidate_disposition_accepted')).toBe(2)
    expect(countLedgerEvent(fixture.periodBusinessLedgerPath, 'source_disposition_state_accepted')).toBe(2)
    for (const candidate of fixture.candidates) {
      expect(fixture.local.readSourceDispositionState(fixture.period, candidate)).toMatchObject({ state: 'Suppressed' })
    }
    const completed = snapshotDirectory(fixture.directory)
    const rebuilt = createCandidateLocalState({
      ledgerPath: fixture.localLedgerPath,
      completionPort: fixture.completionPort,
    })
    expect(rebuilt.completePendingSourceDispositions()).toEqual({
      status: 'completed', value: { completed: 0 },
    })
    expect(snapshotDirectory(fixture.directory)).toEqual(completed)
  })

  it('keeps C17 single-writer facts scoped by period and full candidate reference', () => {
    const directory = mkdtempSync(join(tmpdir(), 'x-feed-todo05-candidate-local-state-replay-'))
    temporaryDirectories.push(directory)
    const ledgerPath = join(directory, 'candidate-local-state.jsonl')
    const period = testPeriod('single-writer')
    const otherPeriod = testPeriod('other-period')
    const candidate = xCandidate('x-status:single', 'x:status:single')
    const otherCandidate = xCandidate('x-status:other', 'x:status:other')
    const state = createCandidateLocalState({ ledgerPath })
    const first = disposition(period, candidate, 'Shown')
    expect(state.candidateDispositionReceiver.acceptFormalDisposition(first)).toEqual({
      status: 'accepted', value: { disposition: first },
    })
    const afterFirst = snapshotDirectory(directory)
    expect(state.candidateDispositionReceiver.acceptFormalDisposition(first)).toEqual({
      status: 'accepted', value: { disposition: first },
    })
    expect(snapshotDirectory(directory)).toEqual(afterFirst)
    const rebuilt = createCandidateLocalState({ ledgerPath })
    expect(rebuilt.candidateDispositionReceiver.acceptFormalDisposition(first)).toEqual({
      status: 'accepted', value: { disposition: first },
    })
    expect(snapshotDirectory(directory)).toEqual(afterFirst)
    const conflicting = disposition(period, candidate, 'ReviewedNotSelected')
    expect(rebuilt.candidateDispositionReceiver.acceptFormalDisposition(conflicting)).toEqual({
      status: 'rejected', input: conflicting,
    })
    expect(snapshotDirectory(directory)).toEqual(afterFirst)
    const second = disposition(period, otherCandidate, 'Shown')
    const third = disposition(otherPeriod, candidate, 'Shown')
    expect(rebuilt.candidateDispositionReceiver.acceptFormalDisposition(second)).toEqual({
      status: 'accepted', value: { disposition: second },
    })
    expect(rebuilt.candidateDispositionReceiver.acceptFormalDisposition(third)).toEqual({
      status: 'accepted', value: { disposition: third },
    })
    expect(rebuilt.readSourceDispositionState(period, otherCandidate)).toBeDefined()
    expect(rebuilt.readSourceDispositionState(otherPeriod, candidate)).toBeDefined()
  })

  it.each([
    ['source differs from candidate', { source: 'other' }],
    ['candidate source is not X', { candidateSource: 'other' }],
    ['invalid disposition value outside PF union', { value: 'NotAFormalDisposition' }],
    ['extra top-level key', { extra: true }],
    ['extra period key', { periodExtra: true }],
    ['extra candidate key', { candidateExtra: true }],
    ['missing top-level source', { missingSource: true }],
    ['missing top-level value', { missingValue: true }],
    ['missing period', { missingPeriod: true }],
    ['missing period run', { missingPeriodRun: true }],
    ['missing period reference', { missingPeriodPeriod: true }],
    ['missing candidate', { missingCandidate: true }],
    ['missing candidate source', { missingCandidateSource: true }],
    ['missing candidate identity', { missingCandidateIdentity: true }],
    ['missing candidate stable reference', { missingCandidateStableReference: true }],
  ] as const)('rejects malformed or out-of-scope C17 input with zero bytes for %s', (_name, mutation) => {
    const directory = mkdtempSync(join(tmpdir(), 'x-feed-todo05-candidate-local-state-invalid-'))
    temporaryDirectories.push(directory)
    const ledgerPath = join(directory, 'candidate-local-state.jsonl')
    const period = testPeriod('invalid')
    const candidate = xCandidate('x-status:invalid', 'x:status:invalid')
    const base = disposition(period, candidate, 'Shown')
    const mutationRecord = mutation as Record<string, unknown>
    const value = typeof mutationRecord.value === 'string' ? mutationRecord.value : base.value
    const mutated = {
      ...base,
      ...(mutationRecord.source === 'other' ? { source: 'other' as SourceIdentity } : {}),
      ...(mutationRecord.candidateSource === 'other' ? {
        candidate: { ...candidate, source: 'other' as SourceIdentity },
      } : {}),
      ...(mutationRecord.extra === true ? { extra: true } : {}),
      ...(mutationRecord.periodExtra === true ? { period: { ...period, extra: true } } : {}),
      ...(mutationRecord.candidateExtra === true ? { candidate: { ...candidate, extra: true } } : {}),
      value,
    }
    let invalid: unknown = mutated
    if (mutationRecord.missingSource === true) {
      const { source: _source, ...withoutSource } = mutated
      invalid = withoutSource
    } else if (mutationRecord.missingValue === true) {
      const { value: _value, ...withoutValue } = mutated
      invalid = withoutValue
    } else if (mutationRecord.missingPeriod === true) {
      const { period: _period, ...withoutPeriod } = mutated
      invalid = withoutPeriod
    } else if (mutationRecord.missingPeriodRun === true) {
      const { period, ...withoutPeriod } = mutated
      const { run: _run, ...withoutRun } = period
      invalid = { ...withoutPeriod, period: withoutRun }
    } else if (mutationRecord.missingPeriodPeriod === true) {
      const { period, ...withoutPeriod } = mutated
      const { period: _period, ...withoutPeriodReference } = period
      invalid = { ...withoutPeriod, period: withoutPeriodReference }
    } else if (mutationRecord.missingCandidate === true) {
      const { candidate: _candidate, ...withoutCandidate } = mutated
      invalid = withoutCandidate
    } else if (mutationRecord.missingCandidateSource === true) {
      const { candidate, ...withoutCandidate } = mutated
      const { source: _source, ...withoutSource } = candidate
      invalid = { ...withoutCandidate, candidate: withoutSource }
    } else if (mutationRecord.missingCandidateIdentity === true) {
      const { candidate, ...withoutCandidate } = mutated
      const { candidate: _candidate, ...withoutCandidateIdentity } = candidate
      invalid = { ...withoutCandidate, candidate: withoutCandidateIdentity }
    } else if (mutationRecord.missingCandidateStableReference === true) {
      const { candidate, ...withoutCandidate } = mutated
      const { stableReference: _stableReference, ...withoutStableReference } = candidate
      invalid = { ...withoutCandidate, candidate: withoutStableReference }
    }
    const typedInvalid = invalid as FormalCandidateDisposition
    const before = snapshotDirectory(directory)
    const state = createCandidateLocalState({ ledgerPath })
    expect(state.candidateDispositionReceiver.acceptFormalDisposition(typedInvalid)).toEqual({
      status: 'rejected', input: typedInvalid,
    })
    expect(snapshotDirectory(directory)).toEqual(before)
  })

  it('distinguishes full X candidate tuples that collide under the old delimiter key', () => {
    const directory = mkdtempSync(join(tmpdir(), 'x-feed-todo05-candidate-local-state-nul-'))
    temporaryDirectories.push(directory)
    const ledgerPath = join(directory, 'candidate-local-state.jsonl')
    const period = testPeriod('nul')
    const firstCandidate = xCandidate('a\0b', 'c')
    const secondCandidate = xCandidate('a', 'b\0c')
    const first = disposition(period, firstCandidate, 'Shown')
    const second = disposition(period, secondCandidate, 'Shown')
    const state = createCandidateLocalState({ ledgerPath })
    expect(state.candidateDispositionReceiver.acceptFormalDisposition(first)).toEqual({
      status: 'accepted', value: { disposition: first },
    })
    const afterFirst = snapshotDirectory(directory)
    expect(state.candidateDispositionReceiver.acceptFormalDisposition(first)).toEqual({
      status: 'accepted', value: { disposition: first },
    })
    expect(snapshotDirectory(directory)).toEqual(afterFirst)
    expect(state.candidateDispositionReceiver.acceptFormalDisposition(second)).toEqual({
      status: 'accepted', value: { disposition: second },
    })
    expect(state.candidateDispositionReceiver.acceptFormalDisposition(first)).toEqual({
      status: 'accepted', value: { disposition: first },
    })
    expect(state.readSourceDispositionState(period, firstCandidate)).toBeDefined()
    expect(state.readSourceDispositionState(period, secondCandidate)).toBeDefined()
    expect(readFileSync(ledgerPath, 'utf8').split('\n').filter(line => line.trim() !== '')).toHaveLength(2)
  })

  it.each(ownerCorruptions)('fails closed for a real owner row with %s', (_name, mutate) => {
    const fixture = realOwnerFixture('shape')
    const records = readLedgerRecords(fixture.ledgerPath)
    mutate(records)
    writeLedgerRecords(fixture.ledgerPath, records)
    const before = snapshotDirectory(fixture.directory)
    const rebuilt = createCandidateLocalState({ ledgerPath: fixture.ledgerPath })
    expect(rebuilt.candidateDispositionReceiver.acceptFormalDisposition(fixture.input)).toEqual({
      status: 'failed', input: fixture.input,
    })
    const newInput = newLegalDisposition(`shape-${_name}`)
    expect(rebuilt.candidateDispositionReceiver.acceptFormalDisposition(newInput)).toEqual({
      status: 'failed', input: newInput,
    })
    expect(() => rebuilt.readSourceDispositionState(fixture.period, fixture.candidate)).toThrow()
    expect(snapshotDirectory(fixture.directory)).toEqual(before)
  })

  it('fails closed when opaque sourceCompletion is swapped between real owner rows', () => {
    const fixture = realOwnerFixture('completion-swap')
    const secondCandidate = xCandidate('x-hardening:completion-swap-second', 'x:hardening:completion-swap-second')
    const secondInput = disposition(fixture.period, secondCandidate, 'Shown')
    expect(fixture.state.candidateDispositionReceiver.acceptFormalDisposition(secondInput)).toEqual({
      status: 'accepted', value: { disposition: secondInput },
    })
    const records = readLedgerRecords(fixture.ledgerPath)
    const firstState = recordObject(recordAt(records, 0), 'state')
    const secondState = recordObject(recordAt(records, 1), 'state')
    firstState.sourceCompletion = secondState.sourceCompletion
    writeLedgerRecords(fixture.ledgerPath, records)
    const before = snapshotDirectory(fixture.directory)
    const rebuilt = createCandidateLocalState({ ledgerPath: fixture.ledgerPath })
    expect(rebuilt.candidateDispositionReceiver.acceptFormalDisposition(fixture.input)).toEqual({
      status: 'failed', input: fixture.input,
    })
    const newInput = newLegalDisposition('completion-swap')
    expect(rebuilt.candidateDispositionReceiver.acceptFormalDisposition(newInput)).toEqual({
      status: 'failed', input: newInput,
    })
    expect(() => rebuilt.readSourceDispositionState(fixture.period, fixture.candidate)).toThrow()
    expect(snapshotDirectory(fixture.directory)).toEqual(before)
  })

  it.each([
    ['duplicate exact physical row', (records: Record<string, unknown>[]) => {
      records.push(structuredClone(recordAt(records, 0)) as Record<string, unknown>)
    }],
    ['same-scope conflicting owner', (records: Record<string, unknown>[]) => {
      const firstDisposition = recordObject(recordAt(records, 0), 'disposition')
      const firstState = recordObject(recordAt(records, 0), 'state')
      recordAt(records, 1).disposition = { ...firstDisposition, value: 'ReviewedNotSelected' }
      recordAt(records, 1).state = { ...firstState, state: 'Suppressed', sourceCompletion: firstState.sourceCompletion }
    }],
    ['cross-scope owner reused for another disposition', (records: Record<string, unknown>[]) => {
      const firstDisposition = recordObject(recordAt(records, 0), 'disposition')
      const firstState = recordObject(recordAt(records, 0), 'state')
      const secondDisposition = recordObject(recordAt(records, 1), 'disposition')
      recordAt(records, 1).state = { ...firstState, period: secondDisposition.period, candidate: firstDisposition.candidate }
    }],
  ] as const)('fails closed for %s', (_name, mutate) => {
    const fixture = realOwnerFixture('owner-conflict')
    const secondCandidate = xCandidate('x-hardening:owner-conflict-second', 'x:hardening:owner-conflict-second')
    const secondInput = disposition(fixture.period, secondCandidate, 'Shown')
    expect(fixture.state.candidateDispositionReceiver.acceptFormalDisposition(secondInput)).toEqual({
      status: 'accepted', value: { disposition: secondInput },
    })
    const records = readLedgerRecords(fixture.ledgerPath)
    mutate(records)
    writeLedgerRecords(fixture.ledgerPath, records)
    const before = snapshotDirectory(fixture.directory)
    const rebuilt = createCandidateLocalState({ ledgerPath: fixture.ledgerPath })
    expect(rebuilt.candidateDispositionReceiver.acceptFormalDisposition(fixture.input)).toEqual({
      status: 'failed', input: fixture.input,
    })
    const newInput = newLegalDisposition(`owner-conflict-${_name}`)
    expect(rebuilt.candidateDispositionReceiver.acceptFormalDisposition(newInput)).toEqual({
      status: 'failed', input: newInput,
    })
    expect(() => rebuilt.readSourceDispositionState(fixture.period, fixture.candidate)).toThrow()
    expect(snapshotDirectory(fixture.directory)).toEqual(before)
  })

  it('fails closed on owner read I/O and leaves the directory unchanged', () => {
    const fixture = realOwnerFixture('read-io')
    rmSync(fixture.ledgerPath)
    mkdirSync(fixture.ledgerPath)
    const before = snapshotDirectory(fixture.directory)
    const rebuilt = createCandidateLocalState({ ledgerPath: fixture.ledgerPath })
    expect(rebuilt.candidateDispositionReceiver.acceptFormalDisposition(fixture.input)).toEqual({
      status: 'failed', input: fixture.input,
    })
    const newInput = newLegalDisposition('read-io')
    expect(rebuilt.candidateDispositionReceiver.acceptFormalDisposition(newInput)).toEqual({
      status: 'failed', input: newInput,
    })
    expect(() => rebuilt.readSourceDispositionState(fixture.period, fixture.candidate)).toThrow()
    expect(snapshotDirectory(fixture.directory)).toEqual(before)
  })

  it('fails closed for a truncated real owner JSON line', () => {
    const fixture = realOwnerFixture('truncated-json')
    const line = readFileSync(fixture.ledgerPath, 'utf8').trimEnd()
    writeFileSync(fixture.ledgerPath, `${line.slice(0, -2)}\n`, 'utf8')
    const before = snapshotDirectory(fixture.directory)
    const rebuilt = createCandidateLocalState({ ledgerPath: fixture.ledgerPath })
    expect(rebuilt.candidateDispositionReceiver.acceptFormalDisposition(fixture.input)).toEqual({
      status: 'failed', input: fixture.input,
    })
    const newInput = newLegalDisposition('truncated-json')
    expect(rebuilt.candidateDispositionReceiver.acceptFormalDisposition(newInput)).toEqual({
      status: 'failed', input: newInput,
    })
    expect(() => rebuilt.readSourceDispositionState(fixture.period, fixture.candidate)).toThrow()
    expect(snapshotDirectory(fixture.directory)).toEqual(before)
  })

  it('fails before append without leaving a temporary or durable second owner', () => {
    const fixture = realOwnerFixture('append-before')
    const secondCandidate = xCandidate('x-hardening:append-before-second', 'x:hardening:append-before-second')
    const secondInput = disposition(fixture.period, secondCandidate, 'Shown')
    const before = snapshotDirectory(fixture.directory)
    chmodSync(fixture.directory, 0o500)
    try {
      const result = fixture.state.candidateDispositionReceiver.acceptFormalDisposition(secondInput)
      expect(result).toEqual({ status: 'failed', input: secondInput })
      expect(snapshotDirectory(fixture.directory)).toEqual(before)
      expect(readFileSync(fixture.ledgerPath, 'utf8').split('\n').filter(line => line.trim() !== '')).toHaveLength(1)
    } finally {
      chmodSync(fixture.directory, 0o700)
    }
  })

  it('cleans a temporary left by an append failure before rename', () => {
    const fixture = realOwnerFixture('append-before-temp')
    const secondCandidate = xCandidate('x-hardening:append-before-temp-second', 'x:hardening:append-before-temp-second')
    const secondInput = disposition(fixture.period, secondCandidate, 'Shown')
    const before = snapshotDirectory(fixture.directory)
    appendAfterControl.throwBeforeRename = true
    try {
      const result = fixture.state.candidateDispositionReceiver.acceptFormalDisposition(secondInput)
      expect(result).toEqual({ status: 'failed', input: secondInput })
      expect(snapshotDirectory(fixture.directory)).toEqual(before)
      expect(readdirSync(fixture.directory)).toEqual(['candidate-local-state.jsonl'])
      const rebuilt = createCandidateLocalState({ ledgerPath: fixture.ledgerPath })
      expect(rebuilt.candidateDispositionReceiver.acceptFormalDisposition(fixture.input)).toEqual({
        status: 'accepted', value: { disposition: fixture.input },
      })
    } finally {
      appendAfterControl.throwBeforeRename = false
    }
  })

  it('accepts after append throws only when read-back contains the exact unique owner', () => {
    const fixture = realOwnerFixture('append-after')
    const secondCandidate = xCandidate('x-hardening:append-after-second', 'x:hardening:append-after-second')
    const secondInput = disposition(fixture.period, secondCandidate, 'Shown')
    appendAfterControl.throwAfterRename = true
    try {
      const result = fixture.state.candidateDispositionReceiver.acceptFormalDisposition(secondInput)
      expect(result).toEqual({ status: 'accepted', value: { disposition: secondInput } })
      const recoveredBytes = snapshotDirectory(fixture.directory)
      expect(recoveredBytes.map(([name]) => name)).toEqual(['candidate-local-state.jsonl'])
      expect(readFileSync(fixture.ledgerPath, 'utf8').split('\n').filter(line => line.trim() !== '')).toHaveLength(2)
      expect(fixture.state.readSourceDispositionState(fixture.period, secondCandidate)).toBeDefined()
      expect(fixture.state.candidateDispositionReceiver.acceptFormalDisposition(secondInput)).toEqual({
        status: 'accepted', value: { disposition: secondInput },
      })
      expect(snapshotDirectory(fixture.directory)).toEqual(recoveredBytes)
      const rebuilt = createCandidateLocalState({ ledgerPath: fixture.ledgerPath })
      expect(rebuilt.candidateDispositionReceiver.acceptFormalDisposition(secondInput)).toEqual({
        status: 'accepted', value: { disposition: secondInput },
      })
      expect(rebuilt.readSourceDispositionState(fixture.period, secondCandidate)).toEqual(
        fixture.state.readSourceDispositionState(fixture.period, secondCandidate),
      )
      expect(snapshotDirectory(fixture.directory)).toEqual(recoveredBytes)
    } finally {
      appendAfterControl.throwAfterRename = false
    }
  })
})
