import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { dirname } from 'node:path'
import { encodeCanonicalJson } from '../canonical-json.ts'
import type {
  SessionUserHistoryAdapter,
  SessionUserHistoryObservation,
} from './session-user-history-adapter.ts'
import {
  PersonalFeedScopeConflictError,
  PersonalFeedScopeInputError,
  PersonalFeedScopeStoreError,
} from '../errors.ts'
import {
  PERSONAL_CONTEXT_USE_AUTHORIZATION,
  parseClassifierOutput,
  parseEntailmentApproval,
  parseNoFactApproval,
  parseTerminalDisposition,
  prepareFact,
  type PersonalContextActiveFact,
  type PersonalContextCanonicalRevision,
  type PersonalContextRevisionOperation,
  type PersonalContextSemanticPorts,
  type PersonalContextTerminalChange,
  type PersonalContextTerminalDisposition,
} from './personal-context-semantics.ts'

export {
  PERSONAL_CONTEXT_USE_AUTHORIZATION,
  type PersonalContextAttitude,
  type PersonalContextActiveFact,
  type PersonalContextCanonicalFact,
  type PersonalContextCanonicalRevision,
  type PersonalContextClassifierInput,
  type PersonalContextEntailmentInput,
  type PersonalContextEntailmentTarget,
  type PersonalContextFactProposal,
  type PersonalContextNoFactInput,
  type PersonalContextNoFactReason,
  type PersonalContextProtectedSpans,
  type PersonalContextRevisionOperation,
  type PersonalContextSemanticPorts,
  type PersonalContextSpan,
  type PersonalContextTerminalDisposition,
  type PersonalContextTerminalChange,
  type PersonalContextTerminalEvidence,
  type PersonalContextTerminalFact,
  type PersonalContextUseAuthorization,
} from './personal-context-semantics.ts'

const APPLICATION_ID = 0x50435632
const SCHEMA_VERSION = 4

export interface PersonalContextTelegramLocator {
  readonly kind: 'telegram_inbound'
  readonly chatId: number
  readonly messageId: number
}

export interface PersonalContextHistoryLocator {
  readonly kind: 'telegram_session_history'
  readonly sessionId: string
  readonly eventSeq: number
}

export type PersonalContextSourceLocator = PersonalContextTelegramLocator | PersonalContextHistoryLocator

export interface PersonalContextCaptureInput {
  readonly locator: PersonalContextTelegramLocator
  readonly rawText: string
  readonly reference: null
  readonly excludedRequestId?: string
}

export interface PersonalContextSource {
  readonly locator: PersonalContextSourceLocator
  readonly rawText: string | null
  readonly reference: null
  readonly excludedRequestId?: string
  readonly occurredAt: string
  readonly sourceKey: string
  readonly captureSequence: number
}

export interface PersonalContextPendingCoverage {
  readonly sourceKey: string
  readonly status: 'pending'
}

export interface PersonalContextTerminalCoverage {
  readonly sourceKey: string
  readonly status: 'applied' | 'ignored'
  readonly disposition: PersonalContextTerminalDisposition
  readonly terminalTransactionSequence: number
  readonly dispositionDigest: string
  readonly revisionDigest: string
}

export type PersonalContextCoverage = PersonalContextPendingCoverage | PersonalContextTerminalCoverage

export interface PersonalContextSettleInput {
  readonly sourceKey: string
  readonly signal?: AbortSignal
}

export type PersonalContextSettleResult =
  | PersonalContextCoverage
  | {
      readonly sourceKey: string
      readonly status: 'pending'
      readonly reason: 'semantics_unavailable' | 'aborted' | 'semantic_validation_failed'
    }

export interface PersonalContextCaptureResult {
  readonly source: PersonalContextSource
  readonly coverage: PersonalContextCoverage
}

export interface PersonalContextOwnerSnapshot {
  readonly sources: readonly PersonalContextSource[]
  readonly coverage: readonly PersonalContextCoverage[]
}

export interface PersonalContextRequestCoordinates {
  readonly requestId: string
  readonly cutoff: string
  readonly shanghaiDay: string
}

export interface PersonalContextFence {
  readonly schemaVersion: 1
  readonly requestId: string
  readonly cutoff: string
  readonly shanghaiDay: string
  readonly storeId: string
  readonly maxCaptureSequence: number
  readonly maxTerminalTransactionSequence: number
  readonly digest: string
}

export interface PersonalContextSnapshotInput {
  readonly fence: PersonalContextFence
}

export interface PersonalContextFreezeFenceInput {
  readonly request: PersonalContextRequestCoordinates
}

export interface PersonalContextOwner {
  readonly capture: (input: PersonalContextCaptureInput) => PersonalContextCaptureResult
  readonly settle: (input: PersonalContextSettleInput) => Promise<PersonalContextSettleResult>
  readonly read: () => PersonalContextOwnerSnapshot
  readonly freezeFence: (input: PersonalContextFreezeFenceInput) => PersonalContextFence
  readonly snapshot: (input: PersonalContextSnapshotInput) => PersonalContextSnapshotResult
  readonly bootstrap: (input: { readonly history: SessionUserHistoryAdapter; readonly signal?: AbortSignal }) => Promise<PersonalContextBootstrapResult>
  readonly close: () => void
}

export type PersonalContextBootstrapResult =
  | { readonly status: 'complete'; readonly sessionId: string; readonly observedThroughSeq: number; readonly importedSourceCount: number; readonly excludedEventCount: number; readonly digest: string }
  | { readonly status: 'incomplete'; readonly reason: 'history_unavailable' | 'history_changed' | 'history_corrupt' | 'unsupported_user_content' | 'aborted' | 'semantics_pending' }

export type PersonalContextLaneSufficiency =
  | { readonly status: 'sufficient'; readonly basisFactIds: readonly string[] }
  | { readonly status: 'insufficient'; readonly reason: 'no_active_include' | 'no_asserted_knowledge' }

export interface PersonalContextLaneSnapshot {
  readonly lane: 'long_term_interest' | 'existing_knowledge'
  readonly contextCutId: string
  readonly activeFacts: readonly PersonalContextActiveFact[]
  readonly sufficiency: PersonalContextLaneSufficiency
  readonly digest: string
}

export interface PersonalContextRevisionEntry {
  readonly revisionId: string
  readonly currentFactId: string
  readonly sourceKey: string
  readonly factOrdinal: number
  readonly lane: 'long_term_interest' | 'existing_knowledge'
  readonly operation: PersonalContextRevisionOperation
  readonly targetFactIds: readonly string[]
  readonly terminalTransactionSequence: number
  readonly validationInputDigest: string
  readonly operationDigest: string
}

export interface PersonalContextIncludedTerminalSourceProof {
  readonly sourceKey: string
  readonly captureSequence: number
  readonly terminalTransactionSequence: number
  readonly dispositionDigest: string
}

export interface PersonalContextCoverageProof {
  readonly includedTerminalSources: readonly PersonalContextIncludedTerminalSourceProof[]
  readonly unknownAtFenceSourceKeys: readonly string[]
  readonly digest: string
}

export interface PersonalContextRevisionsProof {
  readonly watermark: number
  readonly entries: readonly PersonalContextRevisionEntry[]
  readonly digest: string
}

export type PersonalContextCurrentSourceProof =
  | { readonly status: 'missing'; readonly requestId: string }
  | { readonly status: 'pending'; readonly sourceKey: string; readonly excludedRequestId: string; readonly captureSequence: number }
  | {
      readonly status: 'settled_for_future_request'
      readonly sourceKey: string
      readonly excludedRequestId: string
      readonly captureSequence: number
      readonly terminalTransactionSequence: number
      readonly dispositionDigest: string
      readonly revisionDigest: string
      readonly digest: string
    }

type CurrentSourceProofAtFence =
  | {
      readonly currentSourceProof: Extract<PersonalContextCurrentSourceProof, { readonly status: 'missing' }>
      readonly currentReason: 'current_source_missing'
    }
  | {
      readonly currentSourceProof: Extract<PersonalContextCurrentSourceProof, { readonly status: 'pending' }>
      readonly currentReason: 'current_source_pending'
    }
  | {
      readonly currentSourceProof: Extract<PersonalContextCurrentSourceProof, { readonly status: 'settled_for_future_request' }>
      readonly currentReason: undefined
    }

export interface PersonalContextSnapshotProof {
  readonly fenceDigest: string
  readonly coverage: PersonalContextCoverageProof
  readonly revisions: PersonalContextRevisionsProof
  readonly currentSource: PersonalContextCurrentSourceProof
}

export interface PersonalContextCompositeSnapshot {
  readonly schemaVersion: 1
  readonly fence: PersonalContextFence
  readonly contextCutId: string
  readonly longTermInterest: PersonalContextLaneSnapshot
  readonly existingKnowledge: PersonalContextLaneSnapshot
  readonly proof: PersonalContextSnapshotProof
  readonly digest: string
}

export interface PersonalContextLaneStatus {
  readonly longTermInterest: PersonalContextLaneSufficiency
  readonly existingKnowledge: PersonalContextLaneSufficiency
}

export type PersonalContextSnapshotResult =
  | { readonly kind: 'sufficient'; readonly snapshot: PersonalContextCompositeSnapshot }
  | { readonly kind: 'insufficient'; readonly laneStatus: PersonalContextLaneStatus; readonly proof: PersonalContextSnapshotProof }
  | { readonly kind: 'unknown'; readonly reason: 'unknown_at_fence' | 'current_source_missing' | 'current_source_pending' | 'coverage_incomplete' | 'revision_incomplete'; readonly proof: PersonalContextSnapshotProof }

export interface PersonalContextClock {
  readonly now: () => Date
}

export interface CreatePersonalContextOwnerOptions {
  readonly databasePath: string
  readonly clock: PersonalContextClock
  readonly semantics?: PersonalContextSemanticPorts
}

type SourceRow = {
  readonly source_key: unknown
  readonly locator_kind: unknown
  readonly chat_id: unknown
  readonly message_id: unknown
  readonly raw_text: unknown
  readonly reference_json: unknown
  readonly excluded_request_id: unknown
  readonly occurred_at: unknown
  readonly capture_sequence: unknown
  readonly payload_digest: unknown
  readonly session_id: unknown
  readonly event_seq: unknown
  readonly source_row_digest: unknown
}

type CoverageRow = {
  readonly source_key: unknown
  readonly status: unknown
  readonly disposition_json: unknown
  readonly disposition_digest: unknown
  readonly terminal_transaction_sequence: unknown
  readonly revision_digest: unknown
}

type FenceRow = {
  readonly request_id: unknown
  readonly cutoff: unknown
  readonly shanghai_day: unknown
  readonly fence_json: unknown
  readonly fence_digest: unknown
}

const SOURCE_COLUMNS = `
  source_key, locator_kind, chat_id, message_id, raw_text, reference_json,
  excluded_request_id, occurred_at, capture_sequence, payload_digest,
  session_id, event_seq, source_row_digest
`

const EXPECTED_TABLES = new Set([
  'personal_context_sources',
  'personal_context_coverage',
  'personal_context_metadata',
  'personal_context_fences',
  'personal_context_bootstrap',
])
const EXPECTED_SOURCE_COLUMNS = [
  ['source_key', 'TEXT', 1, 1],
  ['locator_kind', 'TEXT', 1, 0],
  ['chat_id', 'INTEGER', 0, 0],
  ['message_id', 'INTEGER', 0, 0],
  ['raw_text', 'TEXT', 0, 0],
  ['reference_json', 'TEXT', 1, 0],
  ['excluded_request_id', 'TEXT', 0, 0],
  ['occurred_at', 'TEXT', 1, 0],
  ['capture_sequence', 'INTEGER', 1, 0],
  ['payload_digest', 'TEXT', 1, 0],
  ['session_id', 'TEXT', 0, 0],
  ['event_seq', 'INTEGER', 0, 0],
  ['source_row_digest', 'TEXT', 1, 0],
] as const
const EXPECTED_COVERAGE_COLUMNS = [
  ['source_key', 'TEXT', 1, 1],
  ['status', 'TEXT', 1, 0],
  ['disposition_json', 'TEXT', 0, 0],
  ['disposition_digest', 'TEXT', 0, 0],
  ['terminal_transaction_sequence', 'INTEGER', 0, 0],
  ['revision_digest', 'TEXT', 0, 0],
] as const

const EXPECTED_METADATA_COLUMNS = [
  ['singleton', 'INTEGER', 0, 1],
  ['store_id', 'TEXT', 1, 0],
] as const

const EXPECTED_FENCE_COLUMNS = [
  ['request_id', 'TEXT', 1, 1],
  ['cutoff', 'TEXT', 1, 0],
  ['shanghai_day', 'TEXT', 1, 0],
  ['fence_json', 'TEXT', 1, 0],
  ['fence_digest', 'TEXT', 1, 0],
] as const
const EXPECTED_BOOTSTRAP_COLUMNS = [
  ['singleton', 'INTEGER', 0, 1],
  ['status', 'TEXT', 1, 0],
  ['session_id', 'TEXT', 1, 0],
  ['observed_through_seq', 'INTEGER', 1, 0],
  ['checkpoint_json', 'TEXT', 1, 0],
  ['checkpoint_digest', 'TEXT', 1, 0],
] as const

const COVERAGE_COLUMNS = `
  source_key, status, disposition_json, disposition_digest,
  terminal_transaction_sequence, revision_digest
`

export function createPersonalContextOwner(options: CreatePersonalContextOwnerOptions): PersonalContextOwner {
  validateOptions(options)
  const database = openDatabase(options.databasePath)
  try {
    assertStoreIntegrity(database, options.databasePath)
  } catch (error) {
    database.close()
    throw error
  }
  let closed = false

  const assertOpen = (): void => {
    if (closed) throw new PersonalFeedScopeStoreError('personal context owner is closed')
  }

  const read = (): PersonalContextOwnerSnapshot => {
    assertOpen()
    return assertStoreIntegrity(database, options.databasePath).state
  }

  const freezeFence = (input: PersonalContextFreezeFenceInput): PersonalContextFence => {
    assertOpen()
    assertStoreIntegrity(database, options.databasePath)
    return persistFence(database, options.databasePath, input)
  }

  const snapshot = (input: PersonalContextSnapshotInput): PersonalContextSnapshotResult => {
    assertOpen()
    assertStoreIntegrity(database, options.databasePath)
    return buildCausalSnapshot(database, options.databasePath, input)
  }

  const capture = (input: PersonalContextCaptureInput): PersonalContextCaptureResult => {
    assertOpen()
    assertStoreIntegrity(database, options.databasePath)
    const parsed = validateCaptureInput(input)
    const sourceKey = sourceKeyFor(parsed.locator)
    const payloadDigest = payloadDigestFor(parsed)
    const existingBeforeTransaction = selectSource(database, parsed.locator)
    if (existingBeforeTransaction !== undefined) {
      return readExistingCapture(database, existingBeforeTransaction, payloadDigest)
    }
    let began = false
    try {
      database.exec('BEGIN IMMEDIATE')
      began = true
      assertStoreIntegrity(database, options.databasePath)
      // Recheck after acquiring the write lock for a concurrent first capture.
      // The ordinary replay/conflict path above remains a pure read.
      const existing = selectSource(database, parsed.locator)
      if (existing !== undefined) {
        const result = readExistingCapture(database, existing, payloadDigest)
        database.exec('ROLLBACK')
        began = false
        return result
      }

      const occurredAt = readClock(options.clock)
      const nextSequence = (database.prepare(
        'SELECT COALESCE(MAX(capture_sequence), 0) + 1 AS next_sequence FROM personal_context_sources',
      ).get() as { readonly next_sequence: unknown }).next_sequence
      if (typeof nextSequence !== 'number' || !Number.isSafeInteger(nextSequence) || nextSequence <= 0) {
        throw new PersonalFeedScopeStoreError('personal context capture sequence is not a positive safe integer')
      }
      database.prepare(`
        INSERT INTO personal_context_sources (
          source_key, locator_kind, chat_id, message_id, raw_text, reference_json,
          excluded_request_id, occurred_at, capture_sequence, payload_digest,
          session_id, event_seq, source_row_digest
        ) VALUES (?, ?, ?, ?, ?, 'null', ?, ?, ?, ?, NULL, NULL, ?)
      `).run(
        sourceKey,
        parsed.locator.kind,
        parsed.locator.chatId,
        parsed.locator.messageId,
        parsed.rawText,
        parsed.excludedRequestId ?? null,
        occurredAt,
        nextSequence,
        payloadDigest,
        sourceRowDigestFor({
          sourceKey,
          locator: parsed.locator,
          rawText: parsed.rawText,
          occurredAt,
          captureSequence: nextSequence,
          payloadDigest,
          ...(parsed.excludedRequestId === undefined ? {} : { excludedRequestId: parsed.excludedRequestId }),
        }),
      )
      database.prepare(
        "INSERT INTO personal_context_coverage (source_key, status) VALUES (?, 'pending')",
      ).run(sourceKey)
      const source = database.prepare(
        `SELECT ${SOURCE_COLUMNS} FROM personal_context_sources WHERE source_key = ?`,
      ).get(sourceKey) as SourceRow | undefined
      const coverage = database.prepare(
        `SELECT ${COVERAGE_COLUMNS} FROM personal_context_coverage WHERE source_key = ?`,
      ).get(sourceKey) as CoverageRow | undefined
      if (source === undefined || coverage === undefined) {
        throw new PersonalFeedScopeStoreError('personal context capture did not persist source and coverage')
      }
      const result = captureResultFromRows(source, coverage)
      database.exec('COMMIT')
      began = false
      return result
    } catch (error: unknown) {
      if (began) {
        try {
          database.exec('ROLLBACK')
        } catch {
          // Preserve the original failure.
        }
      }
      throw error
    }
  }

  const close = (): void => {
    if (closed) return
    closed = true
    database.close()
  }

  const settle = async (input: PersonalContextSettleInput): Promise<PersonalContextSettleResult> => {
    assertOpen()
    assertStoreIntegrity(database, options.databasePath)
    const parsed = validateSettleInput(input)
    const initial = selectSourceAndCoverage(database, parsed.sourceKey)
    if (initial === undefined) throw new PersonalFeedScopeInputError('personal context settle source does not exist')
    const initialCoverage = coverageFromRow(initial.coverage)
    const initialSource = sourceFromRow(initial.source, initialCoverage)
    if (initialCoverage.status !== 'pending') return initialCoverage
    if (isAbortRequested(parsed.signal)) return pendingSettleResult(parsed.sourceKey, 'aborted')
    if (options.semantics === undefined) return pendingSettleResult(parsed.sourceKey, 'semantics_unavailable')
    if (initialSource.rawText === null) throw new PersonalFeedScopeStoreError('pending personal context source is missing raw text')

    if (hasPriorPendingSource(database, initialSource.captureSequence)) {
      return pendingSettleResult(parsed.sourceKey, 'semantic_validation_failed')
    }
    const priorFold = foldBeforeCaptureSequence(database, initialSource.captureSequence)
    const activeFacts = deepFreeze([...priorFold.activeFacts])
    const activeFactsDigest = digestFor(activeFacts)

    const rawText = initialSource.rawText
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (isAbortRequested(parsed.signal)) return pendingSettleResult(parsed.sourceKey, 'aborted')
      const classifierInput = deepFreeze({
        sourceKey: parsed.sourceKey,
        rawText,
        useAuthorization: PERSONAL_CONTEXT_USE_AUTHORIZATION,
        activeFacts,
      })
      let classifierAwaited: AwaitedSemanticPort<unknown>
      try {
        classifierAwaited = await awaitSemanticPort(options.semantics.classifier(classifierInput), parsed.signal)
      } catch {
        if (isAbortRequested(parsed.signal)) return pendingSettleResult(parsed.sourceKey, 'aborted')
        continue
      }
      if (classifierAwaited.aborted) return pendingSettleResult(parsed.sourceKey, 'aborted')
      const proposal = parseClassifierOutput(classifierAwaited.value, rawText)
      if (proposal === undefined) continue

      if (proposal.kind === 'no_fact') {
        const validatorInput = deepFreeze({
          fullRawText: rawText,
          proposedReason: proposal.reason,
          useAuthorization: PERSONAL_CONTEXT_USE_AUTHORIZATION,
        })
        let validationAwaited: AwaitedSemanticPort<unknown>
        try {
          validationAwaited = await awaitSemanticPort(options.semantics.noFactValidator(validatorInput), parsed.signal)
        } catch {
          if (isAbortRequested(parsed.signal)) return pendingSettleResult(parsed.sourceKey, 'aborted')
          continue
        }
        if (validationAwaited.aborted) return pendingSettleResult(parsed.sourceKey, 'aborted')
        if (!parseNoFactApproval(validationAwaited.value)) continue
        if (isAbortRequested(parsed.signal)) return pendingSettleResult(parsed.sourceKey, 'aborted')
        return persistTerminalDisposition(
          database,
          options.databasePath,
          initial.source,
          { schemaVersion: 2, status: 'ignored', reason: proposal.reason },
          activeFactsDigest,
        )
      }

      const claimedTargetFactIds = new Set<string>()
      for (const factProposal of proposal.facts) {
        if (factProposal.operation === 'assert') continue
        const changeTargetFactIds = new Set(factProposal.targetFactIds)
        if ([...changeTargetFactIds].some(factId => claimedTargetFactIds.has(factId))) {
          return pendingSettleResult(parsed.sourceKey, 'semantic_validation_failed')
        }
        for (const factId of changeTargetFactIds) claimedTargetFactIds.add(factId)
      }

      const changes: PersonalContextTerminalChange[] = []
      for (const factProposal of proposal.facts) {
        const revision = canonicalRevisionFor(factProposal, activeFacts)
        if (revision === undefined) {
          if (isAbortRequested(parsed.signal)) return pendingSettleResult(parsed.sourceKey, 'aborted')
          return pendingSettleResult(parsed.sourceKey, 'semantic_validation_failed')
        }
        const prepared = prepareFact(factProposal, rawText, parsed.sourceKey, revision)
        if (prepared === undefined) {
          if (isAbortRequested(parsed.signal)) return pendingSettleResult(parsed.sourceKey, 'aborted')
          return pendingSettleResult(parsed.sourceKey, 'semantic_validation_failed')
        }
        const validatorInput = deepFreeze(prepared.validatorInput)
        let validationAwaited: AwaitedSemanticPort<unknown>
        try {
          validationAwaited = await awaitSemanticPort(
            options.semantics.entailmentValidator(validatorInput),
            parsed.signal,
          )
        } catch {
          if (isAbortRequested(parsed.signal)) return pendingSettleResult(parsed.sourceKey, 'aborted')
          return pendingSettleResult(parsed.sourceKey, 'semantic_validation_failed')
        }
        if (validationAwaited.aborted) return pendingSettleResult(parsed.sourceKey, 'aborted')
        if (!parseEntailmentApproval(validationAwaited.value)) {
          if (isAbortRequested(parsed.signal)) return pendingSettleResult(parsed.sourceKey, 'aborted')
          return pendingSettleResult(parsed.sourceKey, 'semantic_validation_failed')
        }
        changes.push({
          operation: factProposal.operation,
          targetFactIds: [...factProposal.targetFactIds],
          fact: prepared.terminalFact,
          validationInputDigest: digestFor(prepared.validatorInput),
        })
      }
      if (isAbortRequested(parsed.signal)) return pendingSettleResult(parsed.sourceKey, 'aborted')
      return persistTerminalDisposition(
        database,
        options.databasePath,
        initial.source,
        { schemaVersion: 2, status: 'applied', changes },
        activeFactsDigest,
      )
    }
    return pendingSettleResult(parsed.sourceKey, 'semantic_validation_failed')
  }

  const bootstrap = async (input: { readonly history: SessionUserHistoryAdapter; readonly signal?: AbortSignal }): Promise<PersonalContextBootstrapResult> => {
    assertOpen()
    assertStoreIntegrity(database, options.databasePath)
    if (!isRecord(input) || !hasExactlyKeys(input, ['history'], ['signal']) || !isRecord(input.history)
      || !isRecord(input.history.contract) || typeof input.history.observe !== 'function') {
      throw new PersonalFeedScopeInputError('personal context bootstrap input is invalid')
    }
    if (Object.prototype.hasOwnProperty.call(input, 'signal') && !(input.signal instanceof AbortSignal)) {
      throw new PersonalFeedScopeInputError('personal context bootstrap abort signal is invalid')
    }
    const checkpoint = readBootstrap(database)
    const state = readSnapshot(database, options.databasePath)
    const contract = input.history.contract
    if (!isRecord(contract) || !hasExactlyKeys(contract, ['schemaVersion', 'sourceKind', 'sessionId'])
      || contract.schemaVersion !== 1 || contract.sourceKind !== 'telegram_session_history'
      || typeof contract.sessionId !== 'string' || contract.sessionId.trim() === '') {
      throw new PersonalFeedScopeInputError('personal context bootstrap history contract is invalid')
    }
    if (checkpoint !== undefined) {
      if (checkpoint.sessionId !== contract.sessionId || checkpoint.contractDigest !== digestFor(contract)) {
        throw new PersonalFeedScopeConflictError('personal context bootstrap contract has changed')
      }
      if (checkpoint.status === 'complete') return checkpoint.result
      await settlePendingSources(database, options.databasePath, settle)
      const final = readBootstrap(database)
      if (final?.status === 'complete') return final.result
      return { status: 'incomplete', reason: 'semantics_pending' }
    }
    if (state.sources.length !== 0) throw new PersonalFeedScopeConflictError('personal context bootstrap requires an empty store')
    const signal = input.signal as AbortSignal | undefined
    if (isAborted(signal)) return { status: 'incomplete', reason: 'aborted' }
    let observed: Awaited<ReturnType<SessionUserHistoryAdapter['observe']>>
    try {
      observed = await input.history.observe(signal === undefined ? undefined : { signal })
    } catch {
      if (isAborted(signal)) return { status: 'incomplete', reason: 'aborted' }
      return { status: 'incomplete', reason: 'history_unavailable' }
    }
    if (observed.kind !== 'complete') return { status: 'incomplete', reason: observed.reason }
    assertStoreIntegrity(database, options.databasePath)
    const imported = importBootstrapObservation(database, options.databasePath, contract, observed.observation)
    await settlePendingSources(database, options.databasePath, settle)
    const final = readBootstrap(database)
    if (final?.status === 'complete') return final.result
    return {
      status: 'incomplete',
      reason: imported.importedSourceCount === 0 ? 'semantics_pending' : 'semantics_pending',
    }
  }

  return Object.freeze({ capture, settle, read, freezeFence, snapshot, bootstrap, close })
}

type BootstrapCheckpoint = {
  readonly status: 'settling' | 'complete'
  readonly sessionId: string
  readonly contractDigest: string
  readonly observationDigest: string
  readonly observedThroughSeq: number
  readonly excludedEventCount: number
  readonly importedSourceCount: number
  readonly cohortDigest: string
  readonly resultDigest: string
  readonly result: PersonalContextBootstrapResult
}

function readBootstrap(database: DatabaseSync): BootstrapCheckpoint | undefined {
  const row = database.prepare(`
    SELECT status, session_id, observed_through_seq, checkpoint_json, checkpoint_digest
    FROM personal_context_bootstrap WHERE singleton = 1
  `).get() as {
    readonly status: unknown
    readonly session_id: unknown
    readonly observed_through_seq: unknown
    readonly checkpoint_json: unknown
    readonly checkpoint_digest: unknown
  } | undefined
  if (row === undefined) return undefined
  if ((row.status !== 'settling' && row.status !== 'complete') || typeof row.session_id !== 'string'
    || !isSafeNonNegativeOrMinusOne(row.observed_through_seq) || typeof row.checkpoint_json !== 'string'
    || typeof row.checkpoint_digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(row.checkpoint_digest)) {
    throw new PersonalFeedScopeStoreError('personal context bootstrap checkpoint row is invalid')
  }
  let decoded: unknown
  try {
    decoded = JSON.parse(row.checkpoint_json)
  } catch (cause) {
    throw new PersonalFeedScopeStoreError('personal context bootstrap checkpoint is not JSON', { cause })
  }
  if (!isRecord(decoded) || !hasExactlyKeys(decoded, [
    'schemaVersion', 'contract', 'sessionId', 'observationDigest', 'observedThroughSeq',
    'excludedEventCount', 'importedSourceCount', 'cohortDigest', 'resultDigest',
  ]) || decoded.schemaVersion !== 2 || decoded.sessionId !== row.session_id
    || decoded.observedThroughSeq !== row.observed_through_seq
    || !isRecord(decoded.contract) || !hasExactlyKeys(decoded.contract, ['schemaVersion', 'sourceKind', 'sessionId'])
    || decoded.contract.schemaVersion !== 1 || decoded.contract.sourceKind !== 'telegram_session_history'
    || decoded.contract.sessionId !== row.session_id || typeof decoded.observationDigest !== 'string'
    || !/^sha256:[0-9a-f]{64}$/.test(decoded.observationDigest)
    || !isSafeNonNegativeInteger(decoded.excludedEventCount) || !isSafeNonNegativeInteger(decoded.importedSourceCount)
    || typeof decoded.cohortDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(decoded.cohortDigest)
    || typeof decoded.resultDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(decoded.resultDigest)) {
    throw new PersonalFeedScopeStoreError('personal context bootstrap checkpoint payload is invalid')
  }
  const unsigned = {
    schemaVersion: 2 as const,
    contract: decoded.contract,
    sessionId: row.session_id,
    observationDigest: decoded.observationDigest,
    observedThroughSeq: row.observed_through_seq,
    excludedEventCount: decoded.excludedEventCount,
    importedSourceCount: decoded.importedSourceCount,
    cohortDigest: decoded.cohortDigest,
    resultDigest: decoded.resultDigest,
  }
  if (digestFor(unsigned) !== row.checkpoint_digest || canonicalJsonFor(unsigned, 'bootstrap checkpoint') !== row.checkpoint_json) {
    throw new PersonalFeedScopeStoreError('personal context bootstrap checkpoint digest is invalid')
  }
  const result: PersonalContextBootstrapResult = row.status === 'complete'
    ? { status: 'complete', sessionId: row.session_id, observedThroughSeq: row.observed_through_seq, importedSourceCount: decoded.importedSourceCount, excludedEventCount: decoded.excludedEventCount, digest: decoded.resultDigest }
    : { status: 'incomplete', reason: 'semantics_pending' }
  return { status: row.status, sessionId: row.session_id, contractDigest: digestFor(decoded.contract), observationDigest: decoded.observationDigest, observedThroughSeq: row.observed_through_seq, excludedEventCount: decoded.excludedEventCount, importedSourceCount: decoded.importedSourceCount, cohortDigest: decoded.cohortDigest, resultDigest: decoded.resultDigest, result }
}

function importBootstrapObservation(
  database: DatabaseSync,
  databasePath: string,
  contract: SessionUserHistoryAdapter['contract'],
  observation: SessionUserHistoryObservation,
): { readonly importedSourceCount: number } {
  if (observation.schemaVersion !== 1 || observation.sessionId !== contract.sessionId
    || typeof observation.observedThroughSeq !== 'number' || !isSafeNonNegativeOrMinusOne(observation.observedThroughSeq)
    || typeof observation.manifestDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(observation.manifestDigest)
    || typeof observation.digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(observation.digest)
    || !Array.isArray(observation.messages) || !isSafeNonNegativeInteger(observation.excludedEventCount)) {
    throw new PersonalFeedScopeStoreError('personal context bootstrap observation is invalid')
  }
  const seen = new Set<number>()
  const prepared = observation.messages.map(message => {
    if (!isRecord(message) || !isRecord(message.locator)
      || !hasExactlyKeys(message.locator, ['kind', 'sessionId', 'eventSeq'])
      || message.locator.kind !== 'telegram_session_history' || message.locator.sessionId !== contract.sessionId
      || !isSafeNonNegativeInteger(message.locator.eventSeq) || seen.has(message.locator.eventSeq)
      || typeof message.rawText !== 'string' || message.rawText.trim() === ''
      || typeof message.occurredAt !== 'string' || !isCanonicalIso(message.occurredAt)) {
      throw new PersonalFeedScopeStoreError('personal context bootstrap observation contains an invalid message')
    }
    seen.add(message.locator.eventSeq)
    const locator = message.locator as unknown as PersonalContextHistoryLocator
    const sourceKey = historySourceKeyFor(locator)
    const payloadDigest = historyPayloadDigestFor(message.rawText as string, message.occurredAt as string)
    const verifiedMessage = message as unknown as SessionUserHistoryObservation['messages'][number]
    return { message: verifiedMessage, locator, sourceKey, payloadDigest }
  }).sort((left, right) => left.locator.eventSeq - right.locator.eventSeq)
  const expectedManifest = digestFor(observation.messages.map(message => ({ ...message.locator, occurredAt: message.occurredAt })))
  if (expectedManifest !== observation.manifestDigest) throw new PersonalFeedScopeStoreError('personal context bootstrap manifest digest is invalid')
  const observationUnsigned = {
    schemaVersion: 1 as const,
    sessionId: observation.sessionId,
    observedThroughSeq: observation.observedThroughSeq,
    manifestDigest: observation.manifestDigest,
    messages: observation.messages,
    excludedEventCount: observation.excludedEventCount,
  }
  if (digestFor(observationUnsigned) !== observation.digest) throw new PersonalFeedScopeStoreError('personal context bootstrap observation digest is invalid')
  const unsignedResult = { sessionId: contract.sessionId, observedThroughSeq: observation.observedThroughSeq, importedSourceCount: prepared.length, excludedEventCount: observation.excludedEventCount }
  const resultDigest = digestFor(unsignedResult)
  let began = false
  try {
    database.exec('BEGIN IMMEDIATE')
    began = true
    const current = assertStoreIntegrity(database, databasePath).state
    if (current.sources.length !== 0) throw new PersonalFeedScopeConflictError('personal context bootstrap store changed before import')
    const sequenceRow = database.prepare('SELECT COALESCE(MAX(capture_sequence), 0) AS value FROM personal_context_sources').get() as { readonly value: unknown }
    const startSequence = sequenceRow.value
    if (!isSafeNonNegativeInteger(startSequence)) throw new PersonalFeedScopeStoreError('personal context bootstrap sequence is invalid')
    const cohort = prepared.map((item, index) => ({
      sourceKey: item.sourceKey,
      sessionId: item.locator.sessionId,
      eventSeq: item.locator.eventSeq,
      occurredAt: item.message.occurredAt,
      captureSequence: startSequence + index + 1,
      payloadDigest: item.payloadDigest,
    }))
    const checkpointUnsigned = {
      schemaVersion: 2 as const,
      contract,
      sessionId: contract.sessionId,
      observationDigest: observation.digest,
      observedThroughSeq: observation.observedThroughSeq,
      excludedEventCount: observation.excludedEventCount,
      importedSourceCount: prepared.length,
      cohortDigest: digestFor(cohort),
      resultDigest,
    }
    for (let index = 0; index < prepared.length; index += 1) {
      const item = prepared[index]!
      const captureSequence = startSequence + index + 1
      const sourceRowDigest = sourceRowDigestFor({
        sourceKey: item.sourceKey,
        locator: item.locator,
        rawText: item.message.rawText,
        occurredAt: item.message.occurredAt,
        captureSequence,
        payloadDigest: item.payloadDigest,
      })
      database.prepare(`INSERT INTO personal_context_sources (
        source_key, locator_kind, chat_id, message_id, raw_text, reference_json,
        excluded_request_id, occurred_at, capture_sequence, payload_digest,
        session_id, event_seq, source_row_digest
      ) VALUES (?, 'telegram_session_history', NULL, NULL, ?, 'null', NULL, ?, ?, ?, ?, ?, ?)`)
        .run(item.sourceKey as string, item.message.rawText as string, item.message.occurredAt as string, captureSequence, item.payloadDigest as string,
          item.locator.sessionId as string, item.locator.eventSeq as number, sourceRowDigest as string)
      database.prepare("INSERT INTO personal_context_coverage (source_key, status) VALUES (?, 'pending')").run(item.sourceKey)
    }
    const checkpointJson = canonicalJsonFor(checkpointUnsigned, 'bootstrap checkpoint')
    database.prepare(`INSERT INTO personal_context_bootstrap (
      singleton, status, session_id, observed_through_seq, checkpoint_json, checkpoint_digest
    ) VALUES (1, 'settling', ?, ?, ?, ?)`)
      .run(contract.sessionId as string, observation.observedThroughSeq as number, checkpointJson as string, digestFor(checkpointUnsigned) as string)
    assertStoreIntegrity(database, databasePath)
    database.exec('COMMIT')
    began = false
    return { importedSourceCount: prepared.length }
  } catch (cause) {
    if (began) {
      try { database.exec('ROLLBACK') } catch { /* preserve original failure */ }
    }
    if (cause instanceof PersonalFeedScopeConflictError || cause instanceof PersonalFeedScopeStoreError) throw cause
    throw new PersonalFeedScopeStoreError(`personal context bootstrap import failed at "${databasePath}"`, { cause })
  }
}

async function settlePendingSources(
  database: DatabaseSync,
  databasePath: string,
  settle: (input: PersonalContextSettleInput) => Promise<PersonalContextSettleResult>,
): Promise<void> {
  assertStoreIntegrity(database, databasePath)
  const rows = database.prepare(`SELECT coverage.source_key FROM personal_context_coverage AS coverage JOIN personal_context_sources AS source ON source.source_key = coverage.source_key WHERE coverage.status = 'pending' ORDER BY source.capture_sequence`).all() as Array<{ readonly source_key: unknown }>
  for (const row of rows) {
    if (typeof row.source_key !== 'string') throw new PersonalFeedScopeStoreError('personal context bootstrap pending source key is invalid')
    await settle({ sourceKey: row.source_key })
  }
  const remaining = database.prepare("SELECT COUNT(*) AS count FROM personal_context_coverage WHERE status = 'pending'").get() as { readonly count: unknown }
  if (remaining.count === 0) {
    const checkpoint = assertStoreIntegrity(database, databasePath).checkpoint
    if (checkpoint === undefined) throw new PersonalFeedScopeStoreError('personal context bootstrap checkpoint disappeared')
    const result = checkpoint.result.status === 'complete' ? checkpoint.result : {
      status: 'complete' as const,
      sessionId: checkpoint.sessionId,
      observedThroughSeq: checkpoint.observedThroughSeq,
      importedSourceCount: readImportedSourceCount(database),
      excludedEventCount: readExcludedEventCount(database),
      digest: checkpoint.result.status === 'incomplete' ? digestFor({ sessionId: checkpoint.sessionId, observedThroughSeq: checkpoint.observedThroughSeq, importedSourceCount: readImportedSourceCount(database), excludedEventCount: readExcludedEventCount(database) }) : digestFor(checkpoint.result),
    }
    updateBootstrapComplete(database, databasePath, result)
  }
}

function updateBootstrapComplete(database: DatabaseSync, databasePath: string, result: Extract<PersonalContextBootstrapResult, { readonly status: 'complete' }>): void {
  const checkpoint = assertStoreIntegrity(database, databasePath).checkpoint
  if (checkpoint === undefined) throw new PersonalFeedScopeStoreError('personal context bootstrap checkpoint is missing')
  const contract = { schemaVersion: 1 as const, sourceKind: 'telegram_session_history' as const, sessionId: checkpoint.sessionId }
  const cohort = historyCohort(database, 'bootstrap completion')
  if (cohort.count !== checkpoint.importedSourceCount || cohort.digest !== checkpoint.cohortDigest) {
    throw new PersonalFeedScopeStoreError('personal context bootstrap history cohort changed before completion')
  }
  const checkpointUnsigned = {
    schemaVersion: 2 as const,
    contract,
    sessionId: checkpoint.sessionId,
    observationDigest: checkpoint.observationDigest,
    observedThroughSeq: result.observedThroughSeq,
    excludedEventCount: result.excludedEventCount,
    importedSourceCount: result.importedSourceCount,
    cohortDigest: cohort.digest,
    resultDigest: result.digest,
  }
  let began = false
  try {
    database.exec('BEGIN IMMEDIATE'); began = true
    const locked = assertStoreIntegrity(database, databasePath).checkpoint
    if (locked === undefined || locked.status !== 'settling' || locked.cohortDigest !== checkpoint.cohortDigest) {
      throw new PersonalFeedScopeStoreError('personal context bootstrap checkpoint changed before completion')
    }
    database.prepare(`UPDATE personal_context_bootstrap SET status = 'complete', checkpoint_json = ?, checkpoint_digest = ? WHERE singleton = 1`)
      .run(canonicalJsonFor(checkpointUnsigned, 'bootstrap checkpoint'), digestFor(checkpointUnsigned))
    assertStoreIntegrity(database, databasePath)
    database.exec('COMMIT'); began = false
  } catch (cause) {
    if (began) { try { database.exec('ROLLBACK') } catch { /* preserve */ } }
    throw cause
  }
}

function readImportedSourceCount(database: DatabaseSync): number {
  const row = database.prepare("SELECT COUNT(*) AS count FROM personal_context_sources WHERE locator_kind = 'telegram_session_history'").get() as { readonly count: unknown }
  if (!isSafeNonNegativeInteger(row.count)) throw new PersonalFeedScopeStoreError('personal context bootstrap source count is invalid')
  return row.count
}

function historyCohort(database: DatabaseSync, label: string): { readonly count: number; readonly digest: string } {
  const rows = database.prepare(`SELECT ${SOURCE_COLUMNS} FROM personal_context_sources WHERE locator_kind = 'telegram_session_history' ORDER BY capture_sequence`).all() as SourceRow[]
  const values = rows.map(row => {
    if (row.locator_kind !== 'telegram_session_history' || typeof row.source_key !== 'string'
      || typeof row.session_id !== 'string' || !isSafeNonNegativeInteger(row.event_seq)
      || typeof row.occurred_at !== 'string' || !isCanonicalIso(row.occurred_at)
      || !isSafePositiveInteger(row.capture_sequence) || typeof row.payload_digest !== 'string'
      || !/^[0-9a-f]{64}$/.test(row.payload_digest)) {
      throw new PersonalFeedScopeStoreError(`personal context ${label} history cohort row is invalid`)
    }
    return {
      sourceKey: row.source_key,
      sessionId: row.session_id,
      eventSeq: row.event_seq,
      occurredAt: row.occurred_at,
      captureSequence: row.capture_sequence,
      payloadDigest: row.payload_digest,
    }
  })
  return { count: values.length, digest: digestFor(values) }
}

function readExcludedEventCount(database: DatabaseSync): number {
  const checkpoint = readBootstrap(database)
  return checkpoint?.excludedEventCount ?? 0
}

function selectSource(database: DatabaseSync, locator: PersonalContextTelegramLocator): SourceRow | undefined {
  return database.prepare(
    `SELECT ${SOURCE_COLUMNS} FROM personal_context_sources WHERE locator_kind = ? AND chat_id = ? AND message_id = ?`,
  ).get(locator.kind, locator.chatId, locator.messageId) as SourceRow | undefined
}

function selectSourceAndCoverage(
  database: DatabaseSync,
  sourceKey: string,
): { readonly source: SourceRow; readonly coverage: CoverageRow } | undefined {
  const source = database.prepare(
    `SELECT ${SOURCE_COLUMNS} FROM personal_context_sources WHERE source_key = ?`,
  ).get(sourceKey) as SourceRow | undefined
  if (source === undefined) return undefined
  const coverage = database.prepare(
    `SELECT ${COVERAGE_COLUMNS} FROM personal_context_coverage WHERE source_key = ?`,
  ).get(sourceKey) as CoverageRow | undefined
  if (coverage === undefined) throw new PersonalFeedScopeStoreError('personal context source is missing coverage')
  return { source, coverage }
}

function hasPriorPendingSource(database: DatabaseSync, captureSequence: number): boolean {
  const row = database.prepare(`
    SELECT 1 AS blocked
    FROM personal_context_sources AS source
    JOIN personal_context_coverage AS coverage ON coverage.source_key = source.source_key
    WHERE source.capture_sequence < ?
      AND coverage.status = 'pending'
    LIMIT 1
  `).get(captureSequence) as { readonly blocked: unknown } | undefined
  return row?.blocked === 1
}

function canonicalRevisionFor(
  proposal: { readonly lane: 'long_term_interest' | 'existing_knowledge'; readonly operation: PersonalContextRevisionOperation; readonly targetFactIds: readonly string[] },
  activeFacts: readonly PersonalContextActiveFact[],
): PersonalContextCanonicalRevision | undefined {
  const priorActiveFacts = activeFacts.filter(active => active.fact.lane === proposal.lane)
  const byId = new Map(priorActiveFacts.map(active => [active.factId, active] as const))
  const targetFacts: PersonalContextActiveFact[] = []
  let priorIndex = -1
  for (const factId of proposal.targetFactIds) {
    const target = byId.get(factId)
    if (target === undefined) return undefined
    const targetIndex = priorActiveFacts.indexOf(target)
    if (targetIndex <= priorIndex) return undefined
    priorIndex = targetIndex
    targetFacts.push(target)
  }
  if (proposal.operation === 'assert' && targetFacts.length !== 0) return undefined
  if (proposal.operation === 'confirm' && targetFacts.length !== 1) return undefined
  if ((proposal.operation === 'correct' || proposal.operation === 'replace' || proposal.operation === 'retract')
    && targetFacts.length === 0) return undefined
  return deepFreeze({ operation: proposal.operation, targetFacts, priorActiveFacts })
}

type FoldResult = {
  readonly activeFacts: readonly PersonalContextActiveFact[]
  readonly entries: readonly PersonalContextRevisionEntry[]
}

function foldBeforeCaptureSequence(database: DatabaseSync, captureSequence: number): FoldResult {
  const state = readSnapshot(database, 'open personal context database')
  const coverageByKey = new Map(state.coverage.map(coverage => [coverage.sourceKey, coverage] as const))
  const terminal = state.sources
    .filter(source => source.captureSequence < captureSequence)
    .flatMap(source => {
      const coverage = coverageByKey.get(source.sourceKey)
      if (coverage === undefined) throw new PersonalFeedScopeStoreError('personal context causal source is missing coverage')
      return coverage.status === 'pending' ? [] : [{ source, coverage }]
    })
  return foldTerminalSources(terminal)
}

function foldTerminalSources(
  values: readonly { readonly source: PersonalContextSource; readonly coverage: PersonalContextTerminalCoverage }[],
): FoldResult {
  const active = new Map<string, PersonalContextActiveFact>()
  const entries: PersonalContextRevisionEntry[] = []
  for (const { source, coverage } of [...values].sort((left, right) => left.source.captureSequence - right.source.captureSequence)) {
    if (coverage.disposition.status === 'ignored') continue
    const sourcePrior = new Map(active)
    const sourceEntries = revisionEntriesForChanges(
      source.sourceKey,
      coverage.terminalTransactionSequence,
      coverage.disposition.changes,
    )
    if (revisionDigestForEntries(sourceEntries) !== coverage.revisionDigest) {
      throw new PersonalFeedScopeStoreError('personal context source revision digest does not match its changes')
    }
    for (let ordinal = 0; ordinal < coverage.disposition.changes.length; ordinal += 1) {
      const change = coverage.disposition.changes[ordinal]
      const entry = sourceEntries[ordinal]
      if (change === undefined || entry === undefined) {
        throw new PersonalFeedScopeStoreError('personal context source revision proof is incomplete')
      }
      const targetFacts = change.targetFactIds.map(factId => sourcePrior.get(factId))
      if (targetFacts.some(target => target === undefined)
        || targetFacts.some(target => target?.fact.lane !== change.fact.lane)) {
        throw new PersonalFeedScopeStoreError('personal context revision targets are not causally active in the same lane')
      }
      if (change.operation === 'assert') {
        if (change.targetFactIds.length !== 0) throw new PersonalFeedScopeStoreError('personal context assert has targets')
        active.set(entry.currentFactId, deepFreeze({ factId: entry.currentFactId, fact: change.fact, basisRevisionIds: [entry.revisionId] }))
      } else if (change.operation === 'confirm') {
        const target = targetFacts[0]
        if (target === undefined || targetFacts.length !== 1) throw new PersonalFeedScopeStoreError('personal context confirm target is invalid')
        active.set(target.factId, deepFreeze({
          factId: target.factId,
          fact: target.fact,
          basisRevisionIds: [...target.basisRevisionIds, entry.revisionId],
        }))
      } else {
        if (targetFacts.length === 0) throw new PersonalFeedScopeStoreError('personal context revision has no target')
        for (const target of targetFacts) active.delete(target!.factId)
        if (change.operation !== 'retract') {
          active.set(entry.currentFactId, deepFreeze({
            factId: entry.currentFactId,
            fact: change.fact,
            basisRevisionIds: [entry.revisionId],
          }))
        }
      }
      entries.push(entry)
    }
  }
  return deepFreeze({ activeFacts: [...active.values()], entries })
}

function revisionEntriesForChanges(
  sourceKey: string,
  terminalTransactionSequence: number,
  changes: readonly PersonalContextTerminalChange[],
): PersonalContextRevisionEntry[] {
  return changes.map((change, factOrdinal) => {
    const operationDigest = digestFor({
      sourceKey,
      factOrdinal,
      lane: change.fact.lane,
      operation: change.operation,
      targetFactIds: change.targetFactIds,
      terminalTransactionSequence,
      validationInputDigest: change.validationInputDigest,
      fact: change.fact,
    })
    const revisionId = digestFor({ kind: 'personal_context_revision', operationDigest })
    const currentFactId = change.operation === 'confirm' || change.operation === 'retract'
      ? change.targetFactIds[0]!
      : digestFor({ kind: 'personal_context_fact', revisionId })
    return deepFreeze({
      revisionId,
      currentFactId,
      sourceKey,
      factOrdinal,
      lane: change.fact.lane,
      operation: change.operation,
      targetFactIds: [...change.targetFactIds],
      terminalTransactionSequence,
      validationInputDigest: change.validationInputDigest,
      operationDigest,
    })
  })
}

function revisionDigestForEntries(entries: readonly PersonalContextRevisionEntry[]): string {
  return digestFor({ entries })
}

function persistTerminalDisposition(
  database: DatabaseSync,
  databasePath: string,
  originalSource: SourceRow,
  disposition: PersonalContextTerminalDisposition,
  expectedPriorActiveDigest: string,
): PersonalContextTerminalCoverage {
  if (!isStableSourceKey(originalSource.source_key)) {
    throw new PersonalFeedScopeStoreError('personal context source key is invalid before terminal persistence')
  }
  const dispositionJson = dispositionJsonFor(disposition)
  const dispositionDigest = dispositionDigestForJson(dispositionJson)
  let began = false
  try {
    database.exec('BEGIN IMMEDIATE')
    began = true
    assertStoreIntegrity(database, databasePath)
    const current = selectSourceAndCoverage(database, originalSource.source_key)
    if (current === undefined) throw new PersonalFeedScopeStoreError('personal context source disappeared before terminal persistence')
    const currentCoverage = coverageFromRow(current.coverage)
    if (currentCoverage.status !== 'pending') {
      database.exec('ROLLBACK')
      began = false
      return currentCoverage
    }
    const currentSource = sourceFromRow(current.source, currentCoverage)
    if (currentSource.rawText === null
      || current.source.payload_digest !== originalSource.payload_digest
      || current.source.raw_text !== originalSource.raw_text
      || current.source.locator_kind !== originalSource.locator_kind
      || current.source.chat_id !== originalSource.chat_id
      || current.source.message_id !== originalSource.message_id
      || current.source.capture_sequence !== originalSource.capture_sequence) {
      throw new PersonalFeedScopeStoreError('personal context source changed during semantic settlement')
    }
    const currentPriorFold = foldBeforeCaptureSequence(database, currentSource.captureSequence)
    if (digestFor(currentPriorFold.activeFacts) !== expectedPriorActiveDigest) {
      throw new PersonalFeedScopeStoreError('personal context causal facts changed during semantic settlement')
    }
    const nextTerminalSequence = (database.prepare(`
      SELECT COALESCE(MAX(terminal_transaction_sequence), 0) + 1 AS next_sequence
      FROM personal_context_coverage
    `).get() as { readonly next_sequence: unknown }).next_sequence
    if (!isSafePositiveInteger(nextTerminalSequence)) {
      throw new PersonalFeedScopeStoreError('personal context terminal transaction sequence is invalid')
    }
    const sourceEntries = disposition.status === 'applied'
      ? revisionEntriesForChanges(originalSource.source_key, nextTerminalSequence, disposition.changes)
      : []
    const revisionDigest = revisionDigestForEntries(sourceEntries)
    const coverageUpdate = database.prepare(`
      UPDATE personal_context_coverage
      SET status = ?, disposition_json = ?, disposition_digest = ?,
        terminal_transaction_sequence = ?, revision_digest = ?
      WHERE source_key = ? AND status = 'pending'
    `).run(
      disposition.status,
      dispositionJson,
      dispositionDigest,
      nextTerminalSequence,
      revisionDigest,
      originalSource.source_key,
    )
    const sourceUpdate = database.prepare(`
      UPDATE personal_context_sources
      SET raw_text = NULL
      WHERE source_key = ? AND raw_text IS NOT NULL
    `).run(originalSource.source_key)
    if (coverageUpdate.changes !== 1 || sourceUpdate.changes !== 1) {
      throw new PersonalFeedScopeStoreError('personal context terminal persistence did not update one source atomically')
    }
    const persisted = selectSourceAndCoverage(database, originalSource.source_key)
    if (persisted === undefined) throw new PersonalFeedScopeStoreError('personal context terminal source disappeared')
    const persistedCoverage = coverageFromRow(persisted.coverage)
    sourceFromRow(persisted.source, persistedCoverage)
    if (persistedCoverage.status === 'pending') throw new PersonalFeedScopeStoreError('personal context terminal coverage remained pending')
    database.exec('COMMIT')
    began = false
    return persistedCoverage
  } catch (cause) {
    if (began) {
      try {
        database.exec('ROLLBACK')
      } catch {
        // Preserve the original failure.
      }
    }
    if (cause instanceof PersonalFeedScopeStoreError) throw cause
    throw new PersonalFeedScopeStoreError(`personal context terminal persistence failed at "${databasePath}"`, { cause })
  }
}

function pendingSettleResult(
  sourceKey: string,
  reason: 'semantics_unavailable' | 'aborted' | 'semantic_validation_failed',
): PersonalContextSettleResult {
  return deepFreeze({ sourceKey, status: 'pending', reason })
}

async function awaitSemanticPort<T>(
  value: T | PromiseLike<T>,
  signal: AbortSignal | undefined,
): Promise<AwaitedSemanticPort<T>> {
  if (signal === undefined) return { aborted: false, value: await value }
  if (signal.aborted) return { aborted: true }
  return await new Promise((resolve, reject) => {
    let finished = false
    const finish = (result: { readonly aborted: true } | { readonly aborted: false; readonly value: T }): void => {
      if (finished) return
      finished = true
      signal.removeEventListener('abort', abort)
      resolve(result)
    }
    const abort = (): void => finish({ aborted: true })
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve(value).then(
      result => finish({ aborted: false, value: result }),
      error => {
        if (finished) return
        finished = true
        signal.removeEventListener('abort', abort)
        reject(error)
      },
    )
  })
}

type AwaitedSemanticPort<T> = { readonly aborted: true } | { readonly aborted: false; readonly value: T }

function isAbortRequested(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

function readExistingCapture(database: DatabaseSync, existing: SourceRow, payloadDigest: string): PersonalContextCaptureResult {
  if (existing.payload_digest !== payloadDigest) {
    throw new PersonalFeedScopeConflictError('personal context source locator has a conflicting payload')
  }
  if (!isStableSourceKey(existing.source_key)) {
    throw new PersonalFeedScopeStoreError('personal context source key is invalid')
  }
  const coverage = database.prepare(
    `SELECT ${COVERAGE_COLUMNS} FROM personal_context_coverage WHERE source_key = ?`,
  ).get(existing.source_key) as CoverageRow | undefined
  if (coverage === undefined) {
    throw new PersonalFeedScopeStoreError('personal context source is missing coverage')
  }
  return captureResultFromRows(existing, coverage)
}

function openDatabase(path: string): DatabaseSync {
  const wasMissing = !existsSync(path)
  const parent = dirname(path)
  mkdirSync(parent, { recursive: true, mode: 0o700 })
  chmodSync(parent, 0o700)
  let database: DatabaseSync | undefined
  try {
    database = new DatabaseSync(path)
    chmodSync(path, 0o600)
    configureDatabase(database, path, wasMissing)
    return database
  } catch (error: unknown) {
    try {
      database?.close()
    } catch {
      // Preserve the original open/schema failure.
    }
    throw error
  }
}

function configureDatabase(database: DatabaseSync, path: string, wasMissing: boolean): void {
  database.exec('PRAGMA foreign_keys = ON')
  database.exec('PRAGMA busy_timeout = 5000')
  let began = false
  try {
    database.exec('BEGIN IMMEDIATE')
    began = true
    const userVersion = (database.prepare('PRAGMA user_version').get() as { readonly user_version: unknown }).user_version
    const applicationId = (database.prepare('PRAGMA application_id').get() as { readonly application_id: unknown }).application_id
    const objects = database.prepare(
      "SELECT name, type FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name",
    ).all() as Array<{ readonly name: unknown; readonly type: unknown }>
    if (!wasMissing || userVersion !== 0 || applicationId !== 0 || objects.length !== 0) {
      if (applicationId === APPLICATION_ID && (userVersion === 2 || userVersion === 3)) {
        preflightLegacyState(database, path, userVersion)
        migrateLegacySchema(database, path, userVersion)
        database.exec(`PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = ${SCHEMA_VERSION}`)
        assertSchema(database, path)
      } else if (userVersion !== SCHEMA_VERSION || applicationId !== APPLICATION_ID) {
        throw new PersonalFeedScopeStoreError(`personal context database at "${path}" has an unsupported identity or schema version`)
      } else assertSchema(database, path, objects)
    } else {
      createSchema(database, path)
      database.exec(`PRAGMA application_id = ${APPLICATION_ID}`)
      database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
      assertSchema(database, path)
    }
    database.exec('COMMIT')
    began = false
  } catch (error: unknown) {
    if (began) {
      try {
        database.exec('ROLLBACK')
      } catch {
        // Preserve the original schema failure.
      }
    }
    throw error
  }
}

function createSchema(database: DatabaseSync, path: string): void {
  database.exec(`
    CREATE TABLE personal_context_sources (
      source_key TEXT PRIMARY KEY,
      locator_kind TEXT NOT NULL CHECK (locator_kind IN ('telegram_inbound', 'telegram_session_history')),
      chat_id INTEGER,
      message_id INTEGER,
      raw_text TEXT,
      reference_json TEXT NOT NULL CHECK (reference_json = 'null'),
      excluded_request_id TEXT,
      occurred_at TEXT NOT NULL,
      capture_sequence INTEGER NOT NULL UNIQUE,
      payload_digest TEXT NOT NULL,
      session_id TEXT,
      event_seq INTEGER,
      source_row_digest TEXT NOT NULL,
      CHECK ((locator_kind = 'telegram_inbound' AND chat_id <> 0 AND message_id > 0 AND session_id IS NULL AND event_seq IS NULL)
        OR (locator_kind = 'telegram_session_history' AND chat_id IS NULL AND message_id IS NULL AND session_id IS NOT NULL AND session_id <> '' AND event_seq IS NOT NULL AND event_seq >= 0 AND excluded_request_id IS NULL)),
      UNIQUE (locator_kind, chat_id, message_id),
      UNIQUE (locator_kind, session_id, event_seq)
    ) STRICT;

    CREATE TABLE personal_context_coverage (
      source_key TEXT PRIMARY KEY REFERENCES personal_context_sources(source_key),
      status TEXT NOT NULL CHECK (status IN ('pending', 'applied', 'ignored')),
      disposition_json TEXT,
      disposition_digest TEXT,
      terminal_transaction_sequence INTEGER UNIQUE,
      revision_digest TEXT,
      CHECK (
        (status = 'pending' AND disposition_json IS NULL AND disposition_digest IS NULL
          AND terminal_transaction_sequence IS NULL AND revision_digest IS NULL)
        OR
        (status IN ('applied', 'ignored') AND disposition_json IS NOT NULL AND disposition_digest IS NOT NULL
          AND terminal_transaction_sequence IS NOT NULL AND terminal_transaction_sequence > 0
          AND revision_digest IS NOT NULL)
      )
    ) STRICT;

    CREATE TABLE personal_context_metadata (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      store_id TEXT NOT NULL
    ) STRICT;

    CREATE TABLE personal_context_fences (
      request_id TEXT PRIMARY KEY,
      cutoff TEXT NOT NULL,
      shanghai_day TEXT NOT NULL,
      fence_json TEXT NOT NULL,
      fence_digest TEXT NOT NULL
    ) STRICT;

    CREATE TABLE personal_context_bootstrap (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      status TEXT NOT NULL CHECK (status IN ('settling', 'complete')),
      session_id TEXT NOT NULL,
      observed_through_seq INTEGER NOT NULL CHECK (observed_through_seq >= -1),
      checkpoint_json TEXT NOT NULL,
      checkpoint_digest TEXT NOT NULL
    ) STRICT;
  `)
  database.prepare(
    'INSERT INTO personal_context_metadata (singleton, store_id) VALUES (1, ?)',
  ).run(digestFor({ kind: 'personal_context_store', path }))
}

function migrateLegacySchema(database: DatabaseSync, path: string, version: number): void {
  const sources = database.prepare(`SELECT source_key, locator_kind, chat_id, message_id, raw_text, reference_json, excluded_request_id, occurred_at, capture_sequence, payload_digest FROM personal_context_sources ORDER BY capture_sequence`).all() as Array<Record<string, unknown>>
  const coverages = database.prepare(`SELECT source_key, status, disposition_json, disposition_digest${version === 3 ? ', terminal_transaction_sequence, revision_digest' : ''} FROM personal_context_coverage ORDER BY source_key`).all() as Array<Record<string, unknown>>
  const metadata = version === 3
    ? database.prepare('SELECT store_id FROM personal_context_metadata WHERE singleton = 1').get() as { readonly store_id: unknown } | undefined
    : undefined
  const fences = version === 3
    ? database.prepare('SELECT request_id, cutoff, shanghai_day, fence_json, fence_digest FROM personal_context_fences').all() as Array<Record<string, unknown>>
    : []
  database.exec(`ALTER TABLE personal_context_sources RENAME TO personal_context_sources_legacy; ALTER TABLE personal_context_coverage RENAME TO personal_context_coverage_legacy;`)
  if (version === 3) database.exec('ALTER TABLE personal_context_metadata RENAME TO personal_context_metadata_legacy; ALTER TABLE personal_context_fences RENAME TO personal_context_fences_legacy;')
  createSchema(database, path)
  if (metadata !== undefined && typeof metadata.store_id === 'string') {
    database.prepare('UPDATE personal_context_metadata SET store_id = ? WHERE singleton = 1').run(metadata.store_id)
  }
  const dispositionByKey = new Map<string, PersonalContextTerminalDisposition | undefined>()
  for (const row of coverages) {
    if (typeof row.source_key !== 'string') throw new PersonalFeedScopeStoreError('legacy coverage source key is invalid')
    const dispositionJson = row.disposition_json
    if (dispositionJson === null) { dispositionByKey.set(row.source_key, undefined); continue }
    if (typeof dispositionJson !== 'string') throw new PersonalFeedScopeStoreError('legacy disposition is invalid')
    let parsed: unknown
    try { parsed = JSON.parse(dispositionJson) } catch (cause) { throw new PersonalFeedScopeStoreError('legacy disposition is not JSON', { cause }) }
    if (version === 2 && isRecord(parsed) && parsed.schemaVersion === 1 && parsed.status === 'applied' && Array.isArray(parsed.facts)) {
      parsed = { schemaVersion: 2, status: 'applied', changes: parsed.facts.map(fact => ({ operation: 'assert', targetFactIds: [], fact, validationInputDigest: `sha256:${'0'.repeat(64)}` })) }
    } else if (version === 2 && isRecord(parsed) && parsed.schemaVersion === 1 && parsed.status === 'ignored') {
      parsed = { schemaVersion: 2, status: 'ignored', reason: parsed.reason }
    }
    const disposition = parseTerminalDisposition(parsed)
    if (disposition === undefined) throw new PersonalFeedScopeStoreError('legacy disposition is invalid')
    dispositionByKey.set(row.source_key, disposition)
  }
  for (const row of sources) {
    if (row.locator_kind !== 'telegram_inbound' || typeof row.source_key !== 'string' || !isSafeNonZeroInteger(row.chat_id)
      || !isSafePositiveInteger(row.message_id) || typeof row.occurred_at !== 'string' || !isSafePositiveInteger(row.capture_sequence)
      || typeof row.payload_digest !== 'string') throw new PersonalFeedScopeStoreError('legacy source row is invalid')
    const locator: PersonalContextTelegramLocator = { kind: 'telegram_inbound', chatId: row.chat_id, messageId: row.message_id }
    const sourceRowDigest = sourceRowDigestFor({
      sourceKey: row.source_key, locator, rawText: typeof row.raw_text === 'string' ? row.raw_text : null,
      occurredAt: row.occurred_at, captureSequence: row.capture_sequence, payloadDigest: row.payload_digest,
      ...(typeof row.excluded_request_id === 'string' ? { excludedRequestId: row.excluded_request_id } : {}),
    })
    database.prepare(`INSERT INTO personal_context_sources (
      source_key, locator_kind, chat_id, message_id, raw_text, reference_json, excluded_request_id,
      occurred_at, capture_sequence, payload_digest, session_id, event_seq, source_row_digest
    ) VALUES (?, 'telegram_inbound', ?, ?, ?, 'null', ?, ?, ?, ?, NULL, NULL, ?)`)
      .run(row.source_key as string, row.chat_id as number, row.message_id as number, row.raw_text as string | null, row.excluded_request_id as string | null, row.occurred_at as string,
        row.capture_sequence as number, row.payload_digest as string, sourceRowDigest)
  }
  const terminalSequenceBySource = new Map<string, number>()
  let terminal = 0
  for (const row of [...sources].sort((a, b) => Number(a.capture_sequence) - Number(b.capture_sequence))) {
    const disposition = typeof row.source_key === 'string' ? dispositionByKey.get(row.source_key) : undefined
    if (disposition !== undefined) terminalSequenceBySource.set(row.source_key as string, ++terminal)
  }
  for (const row of coverages) {
    if (typeof row.source_key !== 'string') throw new PersonalFeedScopeStoreError('legacy coverage source key is invalid')
    const disposition = dispositionByKey.get(row.source_key)
    const dispositionJson = disposition === undefined ? null : dispositionJsonFor(disposition)
    const dispositionDigest = dispositionJson === null ? null : dispositionDigestForJson(dispositionJson)
    const sequence = disposition === undefined ? null : (version === 3 && isSafePositiveInteger(row.terminal_transaction_sequence) ? row.terminal_transaction_sequence : terminalSequenceBySource.get(row.source_key)!)
    const entries = disposition?.status === 'applied' ? revisionEntriesForChanges(row.source_key, sequence!, disposition.changes) : []
    const revisionDigest = disposition === undefined ? null : (version === 3 && typeof row.revision_digest === 'string' ? row.revision_digest : revisionDigestForEntries(entries))
    database.prepare(`INSERT INTO personal_context_coverage (
      source_key, status, disposition_json, disposition_digest, terminal_transaction_sequence, revision_digest
    ) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(row.source_key as string, disposition === undefined ? 'pending' : disposition.status, dispositionJson, dispositionDigest, sequence, revisionDigest)
  }
  for (const fence of fences) {
    if (typeof fence.request_id !== 'string' || typeof fence.cutoff !== 'string'
      || typeof fence.shanghai_day !== 'string' || typeof fence.fence_json !== 'string'
      || typeof fence.fence_digest !== 'string') {
      throw new PersonalFeedScopeStoreError('legacy fence row is invalid')
    }
    database.prepare(`INSERT INTO personal_context_fences (request_id, cutoff, shanghai_day, fence_json, fence_digest) VALUES (?, ?, ?, ?, ?)`)
      .run(fence.request_id, fence.cutoff, fence.shanghai_day, fence.fence_json, fence.fence_digest)
  }
  database.exec('DROP TABLE personal_context_coverage_legacy; DROP TABLE personal_context_sources_legacy;')
  if (version === 3) database.exec('DROP TABLE personal_context_metadata_legacy; DROP TABLE personal_context_fences_legacy;')
}

/** Pure read gate for legacy files.  Migration is deliberately not allowed to
 * rename a table until every old row has passed its semantic checks. */
function preflightLegacyState(database: DatabaseSync, path: string, version: 2 | 3): void {
  const expectedTables = version === 2
    ? new Set(['personal_context_sources', 'personal_context_coverage'])
    : new Set(['personal_context_sources', 'personal_context_coverage', 'personal_context_metadata', 'personal_context_fences'])
  const objects = database.prepare("SELECT name, type FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name").all() as Array<{ readonly name: unknown; readonly type: unknown }>
  if (objects.length !== expectedTables.size || objects.some(object => object.type !== 'table' || typeof object.name !== 'string' || !expectedTables.has(object.name))) {
    throw new PersonalFeedScopeStoreError(`legacy personal context database at "${path}" has an unsupported object set`)
  }
  assertLegacyTable(database, path, 'personal_context_sources', [
    ['source_key', 'TEXT', 1, 1], ['locator_kind', 'TEXT', 1, 0], ['chat_id', 'INTEGER', 1, 0],
    ['message_id', 'INTEGER', 1, 0], ['raw_text', 'TEXT', 0, 0], ['reference_json', 'TEXT', 1, 0],
    ['excluded_request_id', 'TEXT', 0, 0], ['occurred_at', 'TEXT', 1, 0], ['capture_sequence', 'INTEGER', 1, 0],
    ['payload_digest', 'TEXT', 1, 0],
  ])
  assertLegacyTable(database, path, 'personal_context_coverage', version === 2
    ? [['source_key', 'TEXT', 1, 1], ['status', 'TEXT', 1, 0], ['disposition_json', 'TEXT', 0, 0], ['disposition_digest', 'TEXT', 0, 0]]
    : [['source_key', 'TEXT', 1, 1], ['status', 'TEXT', 1, 0], ['disposition_json', 'TEXT', 0, 0], ['disposition_digest', 'TEXT', 0, 0], ['terminal_transaction_sequence', 'INTEGER', 0, 0], ['revision_digest', 'TEXT', 0, 0]])
  if (version === 3) {
    assertLegacyTable(database, path, 'personal_context_metadata', [['singleton', 'INTEGER', 0, 1], ['store_id', 'TEXT', 1, 0]])
    assertLegacyTable(database, path, 'personal_context_fences', [['request_id', 'TEXT', 1, 1], ['cutoff', 'TEXT', 1, 0], ['shanghai_day', 'TEXT', 1, 0], ['fence_json', 'TEXT', 1, 0], ['fence_digest', 'TEXT', 1, 0]])
    const metadata = database.prepare('SELECT singleton, store_id FROM personal_context_metadata').all() as Array<{ readonly singleton: unknown; readonly store_id: unknown }>
    if (metadata.length !== 1 || metadata[0]?.singleton !== 1 || metadata[0]?.store_id !== digestFor({ kind: 'personal_context_store', path })) {
      throw new PersonalFeedScopeStoreError('legacy personal context store identity is invalid')
    }
  }
  const sources = database.prepare('SELECT source_key, locator_kind, chat_id, message_id, raw_text, reference_json, excluded_request_id, occurred_at, capture_sequence, payload_digest FROM personal_context_sources ORDER BY capture_sequence').all() as Array<Record<string, unknown>>
  const coverages = database.prepare('SELECT source_key, status, disposition_json, disposition_digest' + (version === 3 ? ', terminal_transaction_sequence, revision_digest' : '') + ' FROM personal_context_coverage ORDER BY source_key').all() as Array<Record<string, unknown>>
  if (sources.length !== coverages.length) throw new PersonalFeedScopeStoreError('legacy personal context source and coverage counts differ')
  const sourceKeys = new Set<string>()
  let previousSequence = 0
  for (const row of sources) {
    if (typeof row.source_key !== 'string' || !isStableSourceKey(row.source_key) || sourceKeys.has(row.source_key)
      || row.locator_kind !== 'telegram_inbound' || !isSafeNonZeroInteger(row.chat_id)
      || !isSafePositiveInteger(row.message_id) || row.reference_json !== 'null'
      || (row.raw_text !== null && (typeof row.raw_text !== 'string' || row.raw_text.trim() === ''))
      || typeof row.occurred_at !== 'string' || !isCanonicalIso(row.occurred_at)
      || !isSafePositiveInteger(row.capture_sequence) || row.capture_sequence <= previousSequence
      || typeof row.payload_digest !== 'string' || !/^[0-9a-f]{64}$/.test(row.payload_digest)) {
      throw new PersonalFeedScopeStoreError('legacy personal context source row is invalid')
    }
    const locator: PersonalContextTelegramLocator = { kind: 'telegram_inbound', chatId: row.chat_id, messageId: row.message_id }
    if (row.source_key !== sourceKeyFor(locator)) throw new PersonalFeedScopeStoreError('legacy personal context source key does not match locator')
    const excludedRequestId = row.excluded_request_id
    if (excludedRequestId !== null && (typeof excludedRequestId !== 'string' || excludedRequestId !== requestIdFor(locator))) {
      throw new PersonalFeedScopeStoreError('legacy personal context excluded request id is invalid')
    }
    const excluded = typeof excludedRequestId === 'string' ? excludedRequestId : undefined
    const rawText = row.raw_text
    if (rawText !== null && row.payload_digest !== payloadDigestFor({ locator, rawText, reference: null, ...(excluded === undefined ? {} : { excludedRequestId: excluded }) })) {
      throw new PersonalFeedScopeStoreError('legacy personal context payload digest is invalid')
    }
    previousSequence = row.capture_sequence
    sourceKeys.add(row.source_key)
  }
  const coverageKeys = new Set<string>()
  const terminalSequences = new Set<number>()
  for (const row of coverages) {
    if (typeof row.source_key !== 'string' || !sourceKeys.has(row.source_key) || coverageKeys.has(row.source_key)) {
      throw new PersonalFeedScopeStoreError('legacy personal context coverage key set is invalid')
    }
    coverageKeys.add(row.source_key)
    if (row.status === 'pending') {
      if (row.disposition_json !== null || row.disposition_digest !== null || (version === 3 && (row.terminal_transaction_sequence !== null || row.revision_digest !== null))) {
        throw new PersonalFeedScopeStoreError('legacy pending coverage has terminal fields')
      }
      continue
    }
    if (row.status !== 'applied' && row.status !== 'ignored' || typeof row.disposition_json !== 'string' || typeof row.disposition_digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(row.disposition_digest) || dispositionDigestForJson(row.disposition_json) !== row.disposition_digest) {
      throw new PersonalFeedScopeStoreError('legacy terminal coverage is invalid')
    }
    let decoded: unknown
    try { decoded = JSON.parse(row.disposition_json) } catch { throw new PersonalFeedScopeStoreError('legacy disposition is not JSON') }
    if (version === 2 && (!isRecord(decoded) || decoded.schemaVersion !== 1)) {
      throw new PersonalFeedScopeStoreError('legacy v2 disposition schema version is invalid')
    }
    if (version === 2 && isRecord(decoded) && decoded.schemaVersion === 1 && decoded.status === 'applied' && Array.isArray(decoded.facts)) {
      decoded = { schemaVersion: 2, status: 'applied', changes: decoded.facts.map(fact => ({ operation: 'assert', targetFactIds: [], fact, validationInputDigest: `sha256:${'0'.repeat(64)}` })) }
    } else if (version === 2 && isRecord(decoded) && decoded.schemaVersion === 1 && decoded.status === 'ignored') {
      decoded = { schemaVersion: 2, status: 'ignored', reason: decoded.reason }
    }
    const disposition = parseTerminalDisposition(decoded)
    if (disposition === undefined || disposition.status !== row.status || (disposition.status === 'applied' && disposition.changes.some(change => change.fact.evidence.sourceKey !== row.source_key))) {
      throw new PersonalFeedScopeStoreError('legacy terminal disposition semantics are invalid')
    }
    if (version === 3) {
      if (!isSafePositiveInteger(row.terminal_transaction_sequence) || terminalSequences.has(row.terminal_transaction_sequence)
        || typeof row.revision_digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(row.revision_digest)) {
        throw new PersonalFeedScopeStoreError('legacy terminal sequence or revision digest is invalid')
      }
      terminalSequences.add(row.terminal_transaction_sequence)
      const entries = disposition.status === 'applied' ? revisionEntriesForChanges(row.source_key, row.terminal_transaction_sequence, disposition.changes) : []
      if (revisionDigestForEntries(entries) !== row.revision_digest) throw new PersonalFeedScopeStoreError('legacy revision digest is invalid')
    }
  }
  if (coverageKeys.size !== sourceKeys.size) throw new PersonalFeedScopeStoreError('legacy source and coverage key sets differ')
  if (version === 3) {
    const fences = database.prepare('SELECT request_id, cutoff, shanghai_day, fence_json, fence_digest FROM personal_context_fences').all() as FenceRow[]
    const maxCapture = sources.reduce((max, row) => Math.max(max, Number(row.capture_sequence)), 0)
    const maxTerminal = coverages.reduce((max, row) => Math.max(max, row.status === 'pending' ? 0 : Number(row.terminal_transaction_sequence)), 0)
    for (const row of fences) {
      const fence = fenceFromRow(row)
      if (fence.storeId !== digestFor({ kind: 'personal_context_store', path })) throw new PersonalFeedScopeStoreError('legacy fence store identity is invalid')
      validateFreezeFenceInput({ request: { requestId: fence.requestId, cutoff: fence.cutoff, shanghaiDay: fence.shanghaiDay } })
      if (fence.maxCaptureSequence > maxCapture || fence.maxTerminalTransactionSequence > maxTerminal) throw new PersonalFeedScopeStoreError('legacy fence watermark exceeds legacy state')
    }
  }
}

function assertLegacyTable(database: DatabaseSync, path: string, table: string, expected: readonly (readonly [string, string, number, number])[]): void {
  const rows = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ readonly name: unknown; readonly type: unknown; readonly notnull: unknown; readonly pk: unknown }>
  if (rows.length !== expected.length || rows.some((row, index) => {
    const wanted = expected[index]
    return wanted === undefined || row.name !== wanted[0] || row.type !== wanted[1] || row.notnull !== wanted[2] || row.pk !== wanted[3]
  })) throw new PersonalFeedScopeStoreError(`legacy personal context database at "${path}" has an invalid ${table} definition`)
}

function assertSchema(
  database: DatabaseSync,
  path: string,
  knownObjects?: readonly { readonly name: unknown; readonly type: unknown }[],
): void {
  const objects = knownObjects ?? database.prepare(
    "SELECT name, type FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name",
  ).all() as Array<{ readonly name: unknown; readonly type: unknown }>
  if (objects.length !== EXPECTED_TABLES.size || objects.some(object => object.type !== 'table' || typeof object.name !== 'string' || !EXPECTED_TABLES.has(object.name))) {
    throw new PersonalFeedScopeStoreError(`personal context database at "${path}" has unknown or missing schema objects`)
  }
  assertTable(database, path, 'personal_context_sources', EXPECTED_SOURCE_COLUMNS)
  assertTable(database, path, 'personal_context_coverage', EXPECTED_COVERAGE_COLUMNS)
  assertTable(database, path, 'personal_context_metadata', EXPECTED_METADATA_COLUMNS)
  assertTable(database, path, 'personal_context_fences', EXPECTED_FENCE_COLUMNS)
  assertTable(database, path, 'personal_context_bootstrap', EXPECTED_BOOTSTRAP_COLUMNS)
  const sourceSql = (database.prepare(
    "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'personal_context_sources'",
  ).get() as { readonly sql: unknown } | undefined)?.sql
  const coverageSql = (database.prepare(
    "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'personal_context_coverage'",
  ).get() as { readonly sql: unknown } | undefined)?.sql
  const metadataSql = (database.prepare(
    "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'personal_context_metadata'",
  ).get() as { readonly sql: unknown } | undefined)?.sql
  const fenceSql = (database.prepare(
    "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'personal_context_fences'",
  ).get() as { readonly sql: unknown } | undefined)?.sql
  if (typeof sourceSql !== 'string' || typeof coverageSql !== 'string'
    || typeof metadataSql !== 'string' || typeof fenceSql !== 'string'
    || ![sourceSql, coverageSql, metadataSql, fenceSql].every(sql => /\bSTRICT\b/i.test(sql))) {
    throw new PersonalFeedScopeStoreError(`personal context database at "${path}" has a non-strict schema`)
  }
  const normalizedSourceSql = sourceSql.replaceAll(/\s+/g, ' ').toLowerCase()
  const normalizedCoverageSql = coverageSql.replaceAll(/\s+/g, ' ').toLowerCase()
  if (!normalizedSourceSql.includes("check (locator_kind in ('telegram_inbound', 'telegram_session_history'))")
    || !normalizedSourceSql.includes('capture_sequence integer not null unique')
    || !normalizedSourceSql.includes('unique (locator_kind, chat_id, message_id)')
    || !normalizedSourceSql.includes("check (reference_json = 'null')")
    || !normalizedCoverageSql.includes('references personal_context_sources(source_key)')
    || !normalizedCoverageSql.includes("status text not null check (status in ('pending', 'applied', 'ignored'))")
    || !normalizedCoverageSql.includes('terminal_transaction_sequence integer unique')
    || !normalizedCoverageSql.includes("status = 'pending' and disposition_json is null and disposition_digest is null")
    || !normalizedCoverageSql.includes("status in ('applied', 'ignored') and disposition_json is not null and disposition_digest is not null")) {
    throw new PersonalFeedScopeStoreError(`personal context database at "${path}" has invalid schema constraints`)
  }
}

function assertTable(
  database: DatabaseSync,
  path: string,
  table: string,
  expected: readonly (readonly [string, string, number, number])[],
): void {
  const rows = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    readonly name: unknown
    readonly type: unknown
    readonly notnull: unknown
    readonly pk: unknown
  }>
  if (rows.length !== expected.length || rows.some((row, index) => {
    const wanted = expected[index]
    return wanted === undefined || row.name !== wanted[0] || row.type !== wanted[1] || row.notnull !== wanted[2] || row.pk !== wanted[3]
  })) {
    throw new PersonalFeedScopeStoreError(`personal context database at "${path}" has an invalid ${table} definition`)
  }
}

function validateOptions(options: CreatePersonalContextOwnerOptions): void {
  if (!isRecord(options) || !hasExactlyKeys(options, ['databasePath', 'clock'], ['semantics'])) {
    throw new PersonalFeedScopeInputError('personal context owner options have an unsupported shape')
  }
  if (typeof options.databasePath !== 'string' || options.databasePath.trim() === '') {
    throw new PersonalFeedScopeInputError('personal context database path must be non-empty')
  }
  if (!isRecord(options.clock) || !hasExactlyKeys(options.clock, ['now']) || typeof options.clock.now !== 'function') {
    throw new PersonalFeedScopeInputError('personal context owner clock is invalid')
  }
  if (Object.prototype.hasOwnProperty.call(options, 'semantics')) {
    if (!isRecord(options.semantics)
      || !hasExactlyKeys(options.semantics, ['classifier', 'entailmentValidator', 'noFactValidator'])
      || typeof options.semantics.classifier !== 'function'
      || typeof options.semantics.entailmentValidator !== 'function'
      || typeof options.semantics.noFactValidator !== 'function') {
      throw new PersonalFeedScopeInputError('personal context semantic ports are invalid')
    }
  }
}

function validateSettleInput(input: PersonalContextSettleInput): PersonalContextSettleInput {
  if (!isRecord(input) || !hasExactlyKeys(input, ['sourceKey'], ['signal'])) {
    throw new PersonalFeedScopeInputError('personal context settle input has an unsupported shape')
  }
  if (!isStableSourceKey(input.sourceKey)) {
    throw new PersonalFeedScopeInputError('personal context settle source key is invalid')
  }
  if (Object.prototype.hasOwnProperty.call(input, 'signal') && !(input.signal instanceof AbortSignal)) {
    throw new PersonalFeedScopeInputError('personal context settle abort signal is invalid')
  }
  return input
}

function validateCaptureInput(input: PersonalContextCaptureInput): PersonalContextCaptureInput {
  if (!isRecord(input) || !hasExactlyKeys(input, ['locator', 'rawText', 'reference'], ['excludedRequestId'])) {
    throw new PersonalFeedScopeInputError('personal context capture input has an unsupported shape')
  }
  if (!isRecord(input.locator) || !hasExactlyKeys(input.locator, ['kind', 'chatId', 'messageId'])) {
    throw new PersonalFeedScopeInputError('personal context Telegram locator is invalid')
  }
  if (input.locator.kind !== 'telegram_inbound' || !isSafeNonZeroInteger(input.locator.chatId) || !isSafePositiveInteger(input.locator.messageId)) {
    throw new PersonalFeedScopeInputError('personal context Telegram locator has invalid identifiers')
  }
  if (typeof input.rawText !== 'string' || input.rawText.trim() === '') {
    throw new PersonalFeedScopeInputError('personal context raw text must be non-blank')
  }
  if (input.reference !== null) {
    throw new PersonalFeedScopeInputError('personal context reference must be null')
  }
  const excludedPresent = Object.prototype.hasOwnProperty.call(input, 'excludedRequestId')
  if (excludedPresent) {
    if (typeof input.excludedRequestId !== 'string' || input.excludedRequestId === '') {
      throw new PersonalFeedScopeInputError('personal context excluded request id is invalid')
    }
    const expected = requestIdFor(input.locator)
    if (input.excludedRequestId !== expected) {
      throw new PersonalFeedScopeInputError('personal context excluded request id does not match locator')
    }
  }
  return input
}

function readClock(clock: PersonalContextClock): string {
  let now: Date
  try {
    now = clock.now()
  } catch (cause) {
    throw new PersonalFeedScopeStoreError('personal context owner clock failed', { cause })
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new PersonalFeedScopeStoreError('personal context owner clock did not return a valid Date')
  }
  return now.toISOString()
}

function readSnapshot(database: DatabaseSync, path: string): PersonalContextOwnerSnapshot {
  const rows = database.prepare(`SELECT ${SOURCE_COLUMNS} FROM personal_context_sources ORDER BY capture_sequence`).all() as SourceRow[]
  const coverageRows = database.prepare(
    `SELECT ${COVERAGE_COLUMNS} FROM personal_context_coverage ORDER BY source_key`,
  ).all() as CoverageRow[]
  if (coverageRows.length !== rows.length) {
    throw new PersonalFeedScopeStoreError(`personal context database at "${path}" has incomplete source coverage`)
  }
  const coverageByKey = new Map<string, CoverageRow>()
  for (const row of coverageRows) {
    if (typeof row.source_key !== 'string' || coverageByKey.has(row.source_key)) {
      throw new PersonalFeedScopeStoreError(`personal context database at "${path}" has invalid coverage rows`)
    }
    coverageByKey.set(row.source_key, row)
  }
  const sources: PersonalContextSource[] = []
  const coverage: PersonalContextCoverage[] = []
  for (const row of rows) {
    const rowCoverage = typeof row.source_key === 'string' ? coverageByKey.get(row.source_key) : undefined
    if (rowCoverage === undefined) throw new PersonalFeedScopeStoreError(`personal context database at "${path}" has source without coverage`)
    const parsedCoverage = coverageFromRow(rowCoverage)
    const source = sourceFromRow(row, parsedCoverage)
    sources.push(source)
    coverage.push(parsedCoverage)
    coverageByKey.delete(row.source_key as string)
  }
  if (coverageByKey.size !== 0) throw new PersonalFeedScopeStoreError(`personal context database at "${path}" has coverage without source`)
  return deepFreeze({ sources, coverage })
}

function assertStoreIntegrity(database: DatabaseSync, path: string): {
  readonly storeId: string
  readonly checkpoint: BootstrapCheckpoint | undefined
  readonly state: PersonalContextOwnerSnapshot
} {
  const storeId = readStoreId(database, path)
  const state = readSnapshot(database, path)
  const checkpoint = readBootstrap(database)
  const fenceRows = database.prepare(`
    SELECT request_id, cutoff, shanghai_day, fence_json, fence_digest
    FROM personal_context_fences ORDER BY request_id
  `).all() as FenceRow[]
  for (const row of fenceRows) {
    const fence = fenceFromRow(row)
    if (fence.storeId !== storeId) throw new PersonalFeedScopeStoreError('personal context fence store identity is invalid')
  }
  if (checkpoint !== undefined) {
    const cohort = historyCohort(database, 'store integrity')
    if (cohort.count !== checkpoint.importedSourceCount || cohort.digest !== checkpoint.cohortDigest) {
      throw new PersonalFeedScopeStoreError('personal context bootstrap history cohort is incomplete or changed')
    }
    const historySources = state.sources.filter(source => source.locator.kind === 'telegram_session_history')
    for (const source of historySources) {
      if (source.locator.kind === 'telegram_session_history' && source.locator.sessionId !== checkpoint.sessionId) {
        throw new PersonalFeedScopeStoreError('personal context bootstrap history session is inconsistent')
      }
    }
    const historyCoverage = new Map(state.coverage.map(coverage => [coverage.sourceKey, coverage] as const))
    if (checkpoint.status === 'complete') {
      if (checkpoint.result.status !== 'complete') throw new PersonalFeedScopeStoreError('personal context complete checkpoint result is incomplete')
      if (historySources.some(source => historyCoverage.get(source.sourceKey)?.status === 'pending')) {
        throw new PersonalFeedScopeStoreError('personal context complete checkpoint has pending history coverage')
      }
      const expectedResultDigest = digestFor({
        sessionId: checkpoint.sessionId,
        observedThroughSeq: checkpoint.observedThroughSeq,
        importedSourceCount: checkpoint.importedSourceCount,
        excludedEventCount: checkpoint.excludedEventCount,
      })
      if (checkpoint.resultDigest !== expectedResultDigest || checkpoint.result.digest !== expectedResultDigest) {
        throw new PersonalFeedScopeStoreError('personal context bootstrap result digest is invalid')
      }
    } else if (checkpoint.result.status !== 'incomplete' || checkpoint.result.reason !== 'semantics_pending') {
      throw new PersonalFeedScopeStoreError('personal context settling checkpoint result is invalid')
    }
  }
  return { storeId, checkpoint, state }
}

function persistFence(
  database: DatabaseSync,
  databasePath: string,
  input: PersonalContextFreezeFenceInput,
): PersonalContextFence {
  const request = validateFreezeFenceInput(input)
  assertStoreIntegrity(database, databasePath)
  const replay = selectFence(database, request.requestId)
  if (replay !== undefined) return replayFenceOrConflict(replay, request)
  let began = false
  try {
    database.exec('BEGIN IMMEDIATE')
    began = true
    assertStoreIntegrity(database, databasePath)
    const concurrent = selectFence(database, request.requestId)
    if (concurrent !== undefined) {
      const result = replayFenceOrConflict(concurrent, request)
      database.exec('ROLLBACK')
      began = false
      return result
    }
    const storeId = readStoreId(database, databasePath)
    const maxCaptureSequence = readNonNegativeSequence(database, `
      SELECT COALESCE(MAX(capture_sequence), 0) AS value FROM personal_context_sources
    `, 'capture fence')
    const maxTerminalTransactionSequence = readNonNegativeSequence(database, `
      SELECT COALESCE(MAX(terminal_transaction_sequence), 0) AS value FROM personal_context_coverage
    `, 'terminal fence')
    const unsigned = {
      schemaVersion: 1 as const,
      requestId: request.requestId,
      cutoff: request.cutoff,
      shanghaiDay: request.shanghaiDay,
      storeId,
      maxCaptureSequence,
      maxTerminalTransactionSequence,
    }
    const fence: PersonalContextFence = deepFreeze({ ...unsigned, digest: digestFor(unsigned) })
    const fenceJson = canonicalJsonFor(fence, 'personal context fence')
    database.prepare(`
      INSERT INTO personal_context_fences (
        request_id, cutoff, shanghai_day, fence_json, fence_digest
      ) VALUES (?, ?, ?, ?, ?)
    `).run(fence.requestId, fence.cutoff, fence.shanghaiDay, fenceJson, fence.digest)
    const persisted = selectFence(database, fence.requestId)
    if (persisted === undefined || canonicalJsonFor(persisted, 'persisted personal context fence') !== fenceJson) {
      throw new PersonalFeedScopeStoreError('personal context fence did not persist exactly')
    }
    database.exec('COMMIT')
    began = false
    return persisted
  } catch (cause) {
    if (began) {
      try {
        database.exec('ROLLBACK')
      } catch {
        // Preserve the original fence failure.
      }
    }
    if (cause instanceof PersonalFeedScopeInputError
      || cause instanceof PersonalFeedScopeConflictError
      || cause instanceof PersonalFeedScopeStoreError) throw cause
    throw new PersonalFeedScopeStoreError(`personal context fence persistence failed at "${databasePath}"`, { cause })
  }
}

function validateFreezeFenceInput(input: PersonalContextFreezeFenceInput): PersonalContextRequestCoordinates {
  if (!isRecord(input) || !hasExactlyKeys(input, ['request'])
    || !isRecord(input.request)
    || !hasExactlyKeys(input.request, ['requestId', 'cutoff', 'shanghaiDay'])) {
    throw new PersonalFeedScopeInputError('personal context fence input has an unsupported shape')
  }
  const request = input.request
  if (typeof request.requestId !== 'string' || !/^telegram:-?\d+:[1-9]\d*$/.test(request.requestId)) {
    throw new PersonalFeedScopeInputError('personal context fence request id is invalid')
  }
  if (typeof request.cutoff !== 'string' || !Number.isFinite(Date.parse(request.cutoff))) {
    throw new PersonalFeedScopeInputError('personal context fence cutoff is invalid')
  }
  if (typeof request.shanghaiDay !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(request.shanghaiDay)) {
    throw new PersonalFeedScopeInputError('personal context fence Shanghai day is invalid')
  }
  const shanghaiDayAtCutoff = new Date(Date.parse(request.cutoff) + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
  if (request.shanghaiDay !== shanghaiDayAtCutoff) {
    throw new PersonalFeedScopeInputError('personal context fence cutoff and Shanghai day disagree')
  }
  return { requestId: request.requestId, cutoff: request.cutoff, shanghaiDay: request.shanghaiDay }
}

function selectFence(database: DatabaseSync, requestId: string): PersonalContextFence | undefined {
  const row = database.prepare(`
    SELECT request_id, cutoff, shanghai_day, fence_json, fence_digest
    FROM personal_context_fences WHERE request_id = ?
  `).get(requestId) as FenceRow | undefined
  return row === undefined ? undefined : fenceFromRow(row)
}

function fenceFromRow(row: FenceRow): PersonalContextFence {
  if (typeof row.request_id !== 'string' || typeof row.cutoff !== 'string'
    || typeof row.shanghai_day !== 'string' || typeof row.fence_json !== 'string'
    || typeof row.fence_digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(row.fence_digest)) {
    throw new PersonalFeedScopeStoreError('personal context fence row is invalid')
  }
  let value: unknown
  try {
    value = JSON.parse(row.fence_json)
  } catch (cause) {
    throw new PersonalFeedScopeStoreError('personal context fence is not JSON', { cause })
  }
  if (!isRecord(value) || !hasExactlyKeys(value, [
    'schemaVersion', 'requestId', 'cutoff', 'shanghaiDay', 'storeId',
    'maxCaptureSequence', 'maxTerminalTransactionSequence', 'digest',
  ]) || value.schemaVersion !== 1 || value.requestId !== row.request_id
    || value.cutoff !== row.cutoff || value.shanghaiDay !== row.shanghai_day
    || typeof value.storeId !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value.storeId)
    || !isSafeNonNegativeInteger(value.maxCaptureSequence)
    || !isSafeNonNegativeInteger(value.maxTerminalTransactionSequence)
    || value.digest !== row.fence_digest) {
    throw new PersonalFeedScopeStoreError('personal context fence payload is invalid')
  }
  const unsigned = {
    schemaVersion: 1 as const,
    requestId: value.requestId as string,
    cutoff: value.cutoff as string,
    shanghaiDay: value.shanghaiDay as string,
    storeId: value.storeId,
    maxCaptureSequence: value.maxCaptureSequence,
    maxTerminalTransactionSequence: value.maxTerminalTransactionSequence,
  }
  const fence: PersonalContextFence = { ...unsigned, digest: value.digest as string }
  if (digestFor(unsigned) !== fence.digest || canonicalJsonFor(fence, 'personal context fence') !== row.fence_json) {
    throw new PersonalFeedScopeStoreError('personal context fence digest is invalid')
  }
  return deepFreeze(fence)
}

function replayFenceOrConflict(row: PersonalContextFence, request: PersonalContextRequestCoordinates): PersonalContextFence {
  if (row.cutoff !== request.cutoff || row.shanghaiDay !== request.shanghaiDay) {
    throw new PersonalFeedScopeConflictError('personal context request already has different fence coordinates')
  }
  return row
}

function readStoreId(database: DatabaseSync, databasePath: string): string {
  const row = database.prepare(
    'SELECT store_id FROM personal_context_metadata WHERE singleton = 1',
  ).get() as { readonly store_id: unknown } | undefined
  if (row === undefined || typeof row.store_id !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(row.store_id)) {
    throw new PersonalFeedScopeStoreError('personal context store id is invalid')
  }
  if (row.store_id !== digestFor({ kind: 'personal_context_store', path: databasePath })) {
    throw new PersonalFeedScopeStoreError('personal context store id does not match its database path')
  }
  return row.store_id
}

function readNonNegativeSequence(database: DatabaseSync, sql: string, label: string): number {
  const value = (database.prepare(sql).get() as { readonly value: unknown }).value
  if (!isSafeNonNegativeInteger(value)) {
    throw new PersonalFeedScopeStoreError(`personal context ${label} sequence is invalid`)
  }
  return value
}

function buildCausalSnapshot(
  database: DatabaseSync,
  databasePath: string,
  input: PersonalContextSnapshotInput,
): PersonalContextSnapshotResult {
  if (!isRecord(input) || !hasExactlyKeys(input, ['fence']) || !isRecord(input.fence)) {
    throw new PersonalFeedScopeInputError('personal context snapshot input has an unsupported shape')
  }
  const persistedFence = selectFence(database, typeof input.fence.requestId === 'string' ? input.fence.requestId : '')
  if (persistedFence === undefined
    || canonicalJsonFor(input.fence, 'personal context supplied fence') !== canonicalJsonFor(persistedFence, 'personal context persisted fence')) {
    throw new PersonalFeedScopeConflictError('personal context snapshot fence is not the persisted request fence')
  }
  const state = readSnapshot(database, databasePath)
  const coverageByKey = new Map(state.coverage.map(coverage => [coverage.sourceKey, coverage] as const))
  const boundedSources = state.sources.filter(source => source.captureSequence <= persistedFence.maxCaptureSequence)
  const currentSources = boundedSources.filter(source => source.excludedRequestId === persistedFence.requestId)
  if (currentSources.length > 1) {
    throw new PersonalFeedScopeStoreError('personal context fence has multiple current sources')
  }
  const included: Array<{ readonly source: PersonalContextSource; readonly coverage: PersonalContextTerminalCoverage }> = []
  const unknownAtFenceSourceKeys: string[] = []
  for (const source of boundedSources) {
    if (source.excludedRequestId === persistedFence.requestId) continue
    const coverage = coverageByKey.get(source.sourceKey)
    if (coverage === undefined) throw new PersonalFeedScopeStoreError('personal context snapshot source lacks coverage')
    if (coverage.status === 'pending'
      || coverage.terminalTransactionSequence > persistedFence.maxTerminalTransactionSequence) {
      unknownAtFenceSourceKeys.push(source.sourceKey)
    } else {
      included.push({ source, coverage })
    }
  }
  const includedTerminalSources: PersonalContextIncludedTerminalSourceProof[] = included.map(({ source, coverage }) => ({
    sourceKey: source.sourceKey,
    captureSequence: source.captureSequence,
    terminalTransactionSequence: coverage.terminalTransactionSequence,
    dispositionDigest: coverage.dispositionDigest,
  }))
  const coverageUnsigned = { includedTerminalSources, unknownAtFenceSourceKeys }
  const coverageProof: PersonalContextCoverageProof = deepFreeze({
    ...coverageUnsigned,
    digest: digestFor(coverageUnsigned),
  })
  const fold = foldTerminalSources(included)
  const revisionsUnsigned = {
    watermark: persistedFence.maxTerminalTransactionSequence,
    entries: fold.entries,
  }
  const revisionsProof: PersonalContextRevisionsProof = deepFreeze({
    ...revisionsUnsigned,
    digest: digestFor(revisionsUnsigned),
  })
  const { currentSourceProof, currentReason } = currentSourceProofAtFence(
    currentSources[0], coverageByKey, persistedFence,
  )
  const proof: PersonalContextSnapshotProof = deepFreeze({
    fenceDigest: persistedFence.digest,
    coverage: coverageProof,
    revisions: revisionsProof,
    currentSource: currentSourceProof,
  })
  const checkpoint = readBootstrap(database)
  if (checkpoint?.status === 'settling') {
    return deepFreeze({ kind: 'unknown', reason: 'coverage_incomplete', proof })
  }
  if (unknownAtFenceSourceKeys.length > 0) {
    return deepFreeze({ kind: 'unknown', reason: 'unknown_at_fence', proof })
  }
  if (currentReason !== undefined) return deepFreeze({ kind: 'unknown', reason: currentReason, proof })

  const contextCutId = digestFor({
    fenceDigest: persistedFence.digest,
    coverageDigest: coverageProof.digest,
    revisionsDigest: revisionsProof.digest,
  })
  const longTermFacts = fold.activeFacts.filter(active => active.fact.lane === 'long_term_interest')
  const knowledgeFacts = fold.activeFacts.filter(active => active.fact.lane === 'existing_knowledge')
  const longTermSufficientIds = longTermFacts
    .filter(active => active.fact.lane === 'long_term_interest' && active.fact.stance === 'include')
    .map(active => active.factId)
  const knowledgeSufficientIds = knowledgeFacts
    .filter(active => active.fact.lane === 'existing_knowledge' && active.fact.epistemic === 'asserted')
    .map(active => active.factId)
  const longTermSufficiency: PersonalContextLaneSufficiency = longTermSufficientIds.length > 0
    ? { status: 'sufficient', basisFactIds: longTermSufficientIds }
    : { status: 'insufficient', reason: 'no_active_include' }
  const knowledgeSufficiency: PersonalContextLaneSufficiency = knowledgeSufficientIds.length > 0
    ? { status: 'sufficient', basisFactIds: knowledgeSufficientIds }
    : { status: 'insufficient', reason: 'no_asserted_knowledge' }
  const laneStatus: PersonalContextLaneStatus = deepFreeze({
    longTermInterest: longTermSufficiency,
    existingKnowledge: knowledgeSufficiency,
  })
  if (longTermSufficiency.status !== 'sufficient' || knowledgeSufficiency.status !== 'sufficient') {
    return deepFreeze({ kind: 'insufficient', laneStatus, proof })
  }
  const longTermInterest = laneSnapshot(
    'long_term_interest', contextCutId, longTermFacts, longTermSufficiency,
  )
  const existingKnowledge = laneSnapshot(
    'existing_knowledge', contextCutId, knowledgeFacts, knowledgeSufficiency,
  )
  const unsignedSnapshot = {
    schemaVersion: 1 as const,
    fence: persistedFence,
    contextCutId,
    longTermInterest,
    existingKnowledge,
    proof,
  }
  const snapshot: PersonalContextCompositeSnapshot = deepFreeze({
    ...unsignedSnapshot,
    digest: digestFor(unsignedSnapshot),
  })
  return deepFreeze({ kind: 'sufficient', snapshot })
}

function currentSourceProofAtFence(
  currentSource: PersonalContextSource | undefined,
  coverageByKey: ReadonlyMap<string, PersonalContextCoverage>,
  persistedFence: PersonalContextFence,
): CurrentSourceProofAtFence {
  if (currentSource === undefined) {
    return {
      currentSourceProof: { status: 'missing', requestId: persistedFence.requestId },
      currentReason: 'current_source_missing',
    }
  }
  const coverage = coverageByKey.get(currentSource.sourceKey)
  if (coverage === undefined) throw new PersonalFeedScopeStoreError('personal context current source lacks coverage')
  if (coverage.status === 'pending') {
    return {
      currentSourceProof: {
        status: 'pending',
        sourceKey: currentSource.sourceKey,
        excludedRequestId: persistedFence.requestId,
        captureSequence: currentSource.captureSequence,
      },
      currentReason: 'current_source_pending',
    }
  }
  const unsigned = {
    status: 'settled_for_future_request' as const,
    sourceKey: currentSource.sourceKey,
    excludedRequestId: persistedFence.requestId,
    captureSequence: currentSource.captureSequence,
    terminalTransactionSequence: coverage.terminalTransactionSequence,
    dispositionDigest: coverage.dispositionDigest,
    revisionDigest: coverage.revisionDigest,
  }
  return {
    currentSourceProof: { ...unsigned, digest: digestFor(unsigned) },
    currentReason: undefined,
  }
}

function laneSnapshot(
  lane: 'long_term_interest' | 'existing_knowledge',
  contextCutId: string,
  activeFacts: readonly PersonalContextActiveFact[],
  sufficiency: PersonalContextLaneSufficiency,
): PersonalContextLaneSnapshot {
  const unsigned = { lane, contextCutId, activeFacts, sufficiency }
  return deepFreeze({ ...unsigned, digest: digestFor(unsigned) })
}

function captureResultFromRows(sourceRow: SourceRow, coverageRow: CoverageRow): PersonalContextCaptureResult {
  if (coverageRow.source_key !== sourceRow.source_key) {
    throw new PersonalFeedScopeStoreError('personal context coverage does not belong to source')
  }
  const coverage = coverageFromRow(coverageRow)
  return deepFreeze({ source: sourceFromRow(sourceRow, coverage), coverage })
}

function sourceFromRow(row: SourceRow, coverage: PersonalContextCoverage): PersonalContextSource {
  if ((row.locator_kind !== 'telegram_inbound' && row.locator_kind !== 'telegram_session_history')
    || (row.locator_kind === 'telegram_inbound' && (!isSafeNonZeroInteger(row.chat_id) || !isSafePositiveInteger(row.message_id) || row.session_id !== null || row.event_seq !== null))
    || (row.locator_kind === 'telegram_session_history' && (row.chat_id !== null || row.message_id !== null || typeof row.session_id !== 'string' || row.session_id === '' || !isSafeNonNegativeInteger(row.event_seq) || row.excluded_request_id !== null))
    || (row.raw_text !== null && (typeof row.raw_text !== 'string' || row.raw_text.trim() === '')) || row.reference_json !== 'null' || typeof row.occurred_at !== 'string' || !isCanonicalIso(row.occurred_at) || typeof row.source_key !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(row.source_key) || !isSafePositiveInteger(row.capture_sequence) || typeof row.payload_digest !== 'string' || !/^[0-9a-f]{64}$/.test(row.payload_digest) || typeof row.source_row_digest !== 'string' || !/^[0-9a-f]{64}$/.test(row.source_row_digest)) {
    throw new PersonalFeedScopeStoreError('personal context source row is invalid')
  }
  if (coverage.sourceKey !== row.source_key
    || (coverage.status === 'pending' && row.raw_text === null)
    || (coverage.status !== 'pending' && row.raw_text !== null)) {
    throw new PersonalFeedScopeStoreError('personal context source and coverage lifecycle is invalid')
  }
  const locator: PersonalContextSourceLocator = row.locator_kind === 'telegram_inbound'
    ? { kind: 'telegram_inbound', chatId: row.chat_id as number, messageId: row.message_id as number }
    : { kind: 'telegram_session_history', sessionId: row.session_id as string, eventSeq: row.event_seq as number }
  if (row.source_key !== sourceKeyFor(locator)) throw new PersonalFeedScopeStoreError('personal context source key is invalid')
  const excludedRequestId = row.excluded_request_id
  if (excludedRequestId !== null && (locator.kind !== 'telegram_inbound' || typeof excludedRequestId !== 'string' || excludedRequestId !== requestIdFor(locator))) {
    throw new PersonalFeedScopeStoreError('personal context excluded request id is invalid')
  }
  if (row.raw_text !== null) {
    if (locator.kind === 'telegram_inbound') {
      const payload: PersonalContextCaptureInput = excludedRequestId === null
        ? { locator, rawText: row.raw_text, reference: null }
        : { locator, rawText: row.raw_text, reference: null, excludedRequestId }
      if (row.payload_digest !== payloadDigestFor(payload)) throw new PersonalFeedScopeStoreError('personal context payload digest is invalid')
    } else if (row.payload_digest !== historyPayloadDigestFor(row.raw_text as string, row.occurred_at)) {
      throw new PersonalFeedScopeStoreError('personal context historical payload digest is invalid')
    }
  }
  const expectedRowDigest = sourceRowDigestFor({
    sourceKey: row.source_key,
    locator,
    rawText: row.raw_text,
    occurredAt: row.occurred_at,
    captureSequence: row.capture_sequence,
    payloadDigest: row.payload_digest,
    ...(typeof excludedRequestId === 'string' ? { excludedRequestId } : {}),
  })
  if (expectedRowDigest !== row.source_row_digest) throw new PersonalFeedScopeStoreError('personal context source row digest is invalid')
  if (locator.kind === 'telegram_session_history') {
    return { locator, rawText: row.raw_text, reference: null, occurredAt: row.occurred_at, sourceKey: row.source_key, captureSequence: row.capture_sequence }
  }
  return excludedRequestId === null
    ? { locator, rawText: row.raw_text, reference: null, occurredAt: row.occurred_at, sourceKey: row.source_key, captureSequence: row.capture_sequence }
    : { locator, rawText: row.raw_text, reference: null, excludedRequestId, occurredAt: row.occurred_at, sourceKey: row.source_key, captureSequence: row.capture_sequence }
}

function coverageFromRow(row: CoverageRow): PersonalContextCoverage {
  if (typeof row.source_key !== 'string' || !isStableSourceKey(row.source_key)) {
    throw new PersonalFeedScopeStoreError('personal context coverage row is invalid')
  }
  if (row.status === 'pending'
    && row.disposition_json === null
    && row.disposition_digest === null
    && row.terminal_transaction_sequence === null
    && row.revision_digest === null) {
    return { sourceKey: row.source_key, status: 'pending' }
  }
  if ((row.status !== 'applied' && row.status !== 'ignored')
    || typeof row.disposition_json !== 'string'
    || typeof row.disposition_digest !== 'string'
    || !/^sha256:[0-9a-f]{64}$/.test(row.disposition_digest)
    || !isSafePositiveInteger(row.terminal_transaction_sequence)
    || typeof row.revision_digest !== 'string'
    || !/^sha256:[0-9a-f]{64}$/.test(row.revision_digest)
    || dispositionDigestForJson(row.disposition_json) !== row.disposition_digest) {
    throw new PersonalFeedScopeStoreError('personal context terminal coverage row is invalid')
  }
  let decoded: unknown
  try {
    decoded = JSON.parse(row.disposition_json)
  } catch (cause) {
    throw new PersonalFeedScopeStoreError('personal context terminal disposition is not JSON', { cause })
  }
  const disposition = parseTerminalDisposition(decoded)
  if (disposition === undefined || disposition.status !== row.status || dispositionJsonFor(disposition) !== row.disposition_json) {
    throw new PersonalFeedScopeStoreError('personal context terminal disposition is invalid')
  }
  if (disposition.status === 'applied' && disposition.changes.some(change => change.fact.evidence.sourceKey !== row.source_key)) {
    throw new PersonalFeedScopeStoreError('personal context terminal fact belongs to another source')
  }
  const entries = disposition.status === 'applied'
    ? revisionEntriesForChanges(row.source_key, row.terminal_transaction_sequence, disposition.changes)
    : []
  if (revisionDigestForEntries(entries) !== row.revision_digest) {
    throw new PersonalFeedScopeStoreError('personal context terminal revision proof is invalid')
  }
  return deepFreeze({
    sourceKey: row.source_key,
    status: row.status,
    disposition,
    terminalTransactionSequence: row.terminal_transaction_sequence,
    dispositionDigest: row.disposition_digest,
    revisionDigest: row.revision_digest,
  })
}

function sourceKeyFor(locator: PersonalContextSourceLocator): string {
  const canonical = encodeCanonicalJson(locator)
  if (canonical === undefined) throw new PersonalFeedScopeInputError('personal context locator is not canonical JSON')
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`
}

function historySourceKeyFor(locator: PersonalContextHistoryLocator): string {
  return sourceKeyFor(locator)
}

function historyPayloadDigestFor(rawText: string, occurredAt: string): string {
  return createHash('sha256').update(canonicalJsonFor({ rawText, occurredAt }, 'historical payload'), 'utf8').digest('hex')
}

function sourceRowDigestFor(input: {
  readonly sourceKey: string
  readonly locator: PersonalContextSourceLocator
  readonly rawText: string | null
  readonly occurredAt: string
  readonly captureSequence: number
  readonly payloadDigest: string
  readonly excludedRequestId?: string
}): string {
  const base = {
    sourceKey: input.sourceKey,
    locator: input.locator,
    occurredAt: input.occurredAt,
    captureSequence: input.captureSequence,
    payloadDigest: input.payloadDigest,
  }
  const stable = input.excludedRequestId === undefined ? base : { ...base, excludedRequestId: input.excludedRequestId }
  return createHash('sha256').update(canonicalJsonFor(stable, 'personal context source row'), 'utf8').digest('hex')
}

function isStableSourceKey(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value)
}

function payloadDigestFor(input: PersonalContextCaptureInput): string {
  const value = Object.prototype.hasOwnProperty.call(input, 'excludedRequestId')
    ? { rawText: input.rawText, reference: input.reference, excludedRequestId: input.excludedRequestId }
    : { rawText: input.rawText, reference: input.reference }
  const canonical = encodeCanonicalJson(value)
  if (canonical === undefined) throw new PersonalFeedScopeInputError('personal context payload is not canonical JSON')
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

function dispositionJsonFor(disposition: PersonalContextTerminalDisposition): string {
  return canonicalJsonFor(disposition, 'personal context terminal disposition')
}

function dispositionDigestForJson(dispositionJson: string): string {
  return `sha256:${createHash('sha256').update(dispositionJson, 'utf8').digest('hex')}`
}

function canonicalJsonFor(value: unknown, label: string): string {
  const canonical = encodeCanonicalJson(value)
  if (canonical === undefined) throw new PersonalFeedScopeStoreError(`${label} is not canonical JSON`)
  return canonical
}

function digestFor(value: unknown): string {
  const canonical = canonicalJsonFor(value, 'personal context digest input')
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`
}

function requestIdFor(locator: PersonalContextTelegramLocator): string {
  return `telegram:${locator.chatId}:${locator.messageId}`
}

function isSafeNonZeroInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value !== 0
}

function isSafePositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isSafeNonNegativeOrMinusOne(value: unknown): value is number {
  return value === -1 || isSafeNonNegativeInteger(value)
}

function isCanonicalIso(value: string): boolean {
  try {
    return new Date(value).toISOString() === value
  } catch {
    return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactlyKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const ownKeys = Reflect.ownKeys(value)
  if (ownKeys.some(key => typeof key !== 'string')) return false
  const allowed = new Set([...required, ...optional])
  const keys = ownKeys as string[]
  if (keys.some(key => !allowed.has(key))) return false
  return required.every(key => Object.prototype.hasOwnProperty.call(value, key))
    && keys.length >= required.length
    && keys.length <= required.length + optional.length
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  return value
}
