import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { dirname } from 'node:path'
import { encodeCanonicalJson } from '../canonical-json.ts'
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
const SCHEMA_VERSION = 3

export interface PersonalContextTelegramLocator {
  readonly kind: 'telegram_inbound'
  readonly chatId: number
  readonly messageId: number
}

export interface PersonalContextCaptureInput {
  readonly locator: PersonalContextTelegramLocator
  readonly rawText: string
  readonly reference: null
  readonly excludedRequestId?: string
}

export interface PersonalContextSource {
  readonly locator: PersonalContextTelegramLocator
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
  readonly close: () => void
}

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
  excluded_request_id, occurred_at, capture_sequence, payload_digest
`

const EXPECTED_TABLES = new Set([
  'personal_context_sources',
  'personal_context_coverage',
  'personal_context_metadata',
  'personal_context_fences',
])
const EXPECTED_SOURCE_COLUMNS = [
  ['source_key', 'TEXT', 1, 1],
  ['locator_kind', 'TEXT', 1, 0],
  ['chat_id', 'INTEGER', 1, 0],
  ['message_id', 'INTEGER', 1, 0],
  ['raw_text', 'TEXT', 0, 0],
  ['reference_json', 'TEXT', 1, 0],
  ['excluded_request_id', 'TEXT', 0, 0],
  ['occurred_at', 'TEXT', 1, 0],
  ['capture_sequence', 'INTEGER', 1, 0],
  ['payload_digest', 'TEXT', 1, 0],
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

const COVERAGE_COLUMNS = `
  source_key, status, disposition_json, disposition_digest,
  terminal_transaction_sequence, revision_digest
`

export function createPersonalContextOwner(options: CreatePersonalContextOwnerOptions): PersonalContextOwner {
  validateOptions(options)
  const database = openDatabase(options.databasePath)
  let closed = false

  const assertOpen = (): void => {
    if (closed) throw new PersonalFeedScopeStoreError('personal context owner is closed')
  }

  const read = (): PersonalContextOwnerSnapshot => {
    assertOpen()
    return readSnapshot(database, options.databasePath)
  }

  const freezeFence = (input: PersonalContextFreezeFenceInput): PersonalContextFence => {
    assertOpen()
    return persistFence(database, options.databasePath, input)
  }

  const snapshot = (input: PersonalContextSnapshotInput): PersonalContextSnapshotResult => {
    assertOpen()
    return buildCausalSnapshot(database, options.databasePath, input)
  }

  const capture = (input: PersonalContextCaptureInput): PersonalContextCaptureResult => {
    assertOpen()
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
          excluded_request_id, occurred_at, capture_sequence, payload_digest
        ) VALUES (?, ?, ?, ?, ?, 'null', ?, ?, ?, ?)
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

  return Object.freeze({ capture, settle, read, freezeFence, snapshot, close })
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
      if (userVersion !== SCHEMA_VERSION || applicationId !== APPLICATION_ID) {
        throw new PersonalFeedScopeStoreError(`personal context database at "${path}" has an unsupported identity or schema version`)
      }
      assertSchema(database, path, objects)
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
      locator_kind TEXT NOT NULL CHECK (locator_kind = 'telegram_inbound'),
      chat_id INTEGER NOT NULL CHECK (chat_id <> 0),
      message_id INTEGER NOT NULL CHECK (message_id > 0),
      raw_text TEXT,
      reference_json TEXT NOT NULL CHECK (reference_json = 'null'),
      excluded_request_id TEXT,
      occurred_at TEXT NOT NULL,
      capture_sequence INTEGER NOT NULL UNIQUE,
      payload_digest TEXT NOT NULL,
      UNIQUE (locator_kind, chat_id, message_id)
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
  `)
  database.prepare(
    'INSERT INTO personal_context_metadata (singleton, store_id) VALUES (1, ?)',
  ).run(digestFor({ kind: 'personal_context_store', path }))
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
  if (!normalizedSourceSql.includes("check (locator_kind = 'telegram_inbound')")
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

function persistFence(
  database: DatabaseSync,
  databasePath: string,
  input: PersonalContextFreezeFenceInput,
): PersonalContextFence {
  const request = validateFreezeFenceInput(input)
  const replay = selectFence(database, request.requestId)
  if (replay !== undefined) return replayFenceOrConflict(replay, request)
  let began = false
  try {
    database.exec('BEGIN IMMEDIATE')
    began = true
    const concurrent = selectFence(database, request.requestId)
    if (concurrent !== undefined) {
      const result = replayFenceOrConflict(concurrent, request)
      database.exec('ROLLBACK')
      began = false
      return result
    }
    const storeId = readStoreId(database)
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

function readStoreId(database: DatabaseSync): string {
  const row = database.prepare(
    'SELECT store_id FROM personal_context_metadata WHERE singleton = 1',
  ).get() as { readonly store_id: unknown } | undefined
  if (row === undefined || typeof row.store_id !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(row.store_id)) {
    throw new PersonalFeedScopeStoreError('personal context store id is invalid')
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
  if (row.locator_kind !== 'telegram_inbound' || !isSafeNonZeroInteger(row.chat_id) || !isSafePositiveInteger(row.message_id) || (row.raw_text !== null && (typeof row.raw_text !== 'string' || row.raw_text.trim() === '')) || row.reference_json !== 'null' || typeof row.occurred_at !== 'string' || !isCanonicalIso(row.occurred_at) || typeof row.source_key !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(row.source_key) || !isSafePositiveInteger(row.capture_sequence) || typeof row.payload_digest !== 'string' || !/^[0-9a-f]{64}$/.test(row.payload_digest)) {
    throw new PersonalFeedScopeStoreError('personal context source row is invalid')
  }
  if (coverage.sourceKey !== row.source_key
    || (coverage.status === 'pending' && row.raw_text === null)
    || (coverage.status !== 'pending' && row.raw_text !== null)) {
    throw new PersonalFeedScopeStoreError('personal context source and coverage lifecycle is invalid')
  }
  const locator: PersonalContextTelegramLocator = { kind: 'telegram_inbound', chatId: row.chat_id, messageId: row.message_id }
  if (row.source_key !== sourceKeyFor(locator)) throw new PersonalFeedScopeStoreError('personal context source key is invalid')
  const excludedRequestId = row.excluded_request_id
  if (excludedRequestId !== null && (typeof excludedRequestId !== 'string' || excludedRequestId !== requestIdFor(locator))) {
    throw new PersonalFeedScopeStoreError('personal context excluded request id is invalid')
  }
  if (row.raw_text !== null) {
    const payload: PersonalContextCaptureInput = excludedRequestId === null
      ? { locator, rawText: row.raw_text, reference: null }
      : { locator, rawText: row.raw_text, reference: null, excludedRequestId }
    if (row.payload_digest !== payloadDigestFor(payload)) throw new PersonalFeedScopeStoreError('personal context payload digest is invalid')
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

function sourceKeyFor(locator: PersonalContextTelegramLocator): string {
  const canonical = encodeCanonicalJson(locator)
  if (canonical === undefined) throw new PersonalFeedScopeInputError('personal context locator is not canonical JSON')
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`
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
