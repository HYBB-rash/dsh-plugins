import { chmodSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { appendJsonLine, readJsonLines } from '../durable-jsonl-store.ts'
import { personalFeedV2TelegramRequestId } from './request-coordinator.ts'

export type PersonalContextLane = 'long_term_interest' | 'existing_knowledge'

export interface PersonalContextTelegramSource {
  readonly kind: 'telegram_inbound'
  readonly chatId: number
  readonly messageId: number
}

export interface PersonalContextAuthorization {
  readonly policy: 'direct_user_statement'
  readonly purpose: 'personal_feed_context'
}

export interface PersonalContextSpan {
  readonly startUtf16: number
  readonly endUtf16: number
}

export interface PersonalContextEvidence {
  readonly verbatim: string
}

export interface PersonalContextInterestFact {
  readonly factId: string
  readonly lane: 'long_term_interest'
  readonly stance: 'include' | 'exclude'
  readonly scope: PersonalContextEvidence
}

export interface PersonalContextKnowledgeFact {
  readonly factId: string
  readonly lane: 'existing_knowledge'
  readonly epistemic: 'asserted' | 'uncertain'
  readonly scope: PersonalContextEvidence
}

export type PersonalContextFact = PersonalContextInterestFact | PersonalContextKnowledgeFact

export interface PersonalContextFactEvidence {
  readonly source: PersonalContextTelegramSource
  readonly occurredAt: string
  readonly verbatim: string
}

export type PersonalContextActiveFact = PersonalContextFact & {
  readonly evidence: readonly PersonalContextFactEvidence[]
}

export interface PersonalContextSemanticInput {
  readonly source: PersonalContextTelegramSource
  readonly rawText: string
  readonly authorization: PersonalContextAuthorization
  readonly activeFacts: readonly PersonalContextActiveFact[]
}

export interface PersonalContextSemanticPort {
  readonly revise: (
    input: PersonalContextSemanticInput,
    signal?: AbortSignal,
  ) => unknown | Promise<unknown>
}

export interface PersonalContextClock {
  readonly now: () => Date
}

export interface CreatePersonalContextOwnerOptions {
  readonly logPath: string
  readonly clock: PersonalContextClock
  readonly semantic: PersonalContextSemanticPort
}

export type PersonalContextObserveResult =
  | { readonly kind: 'applied' }
  | { readonly kind: 'ignored' }
  | { readonly kind: 'already_observed' }
  | {
      readonly kind: 'incomplete'
      readonly reason: 'invalid_semantics' | 'semantic_unavailable' | 'aborted' | 'store_unavailable'
    }

export interface PersonalContextRequest {
  readonly requestId: string
  readonly cutoff: string
  readonly shanghaiDay: string
}

export interface PersonalContextLaneSufficient {
  readonly status: 'sufficient'
  readonly basisFactIds: readonly string[]
}

export interface PersonalContextLaneInsufficient {
  readonly status: 'insufficient'
  readonly reason: 'no_active_include' | 'no_asserted_knowledge'
}

export type PersonalContextLaneSufficiency =
  | PersonalContextLaneSufficient
  | PersonalContextLaneInsufficient

export interface PersonalContextLaneSnapshot {
  readonly activeFacts: readonly PersonalContextActiveFact[]
  readonly sufficiency: PersonalContextLaneSufficient
}

export interface PersonalContextSnapshot {
  readonly schemaVersion: 1
  readonly cutoff: string
  readonly longTermInterest: PersonalContextLaneSnapshot
  readonly existingKnowledge: PersonalContextLaneSnapshot
}

export type PersonalContextSnapshotResult =
  | { readonly kind: 'sufficient'; readonly snapshot: PersonalContextSnapshot }
  | {
      readonly kind: 'insufficient'
      readonly laneStatus: {
        readonly longTermInterest: PersonalContextLaneSufficiency
        readonly existingKnowledge: PersonalContextLaneSufficiency
      }
    }
  | { readonly kind: 'unknown'; readonly reason: 'store_unavailable' }

export interface PersonalContextOwner {
  readonly observe: (input: {
    readonly source: PersonalContextTelegramSource
    readonly rawText: string
    readonly signal?: AbortSignal
  }) => Promise<PersonalContextObserveResult>
  readonly snapshot: (input: { readonly request: PersonalContextRequest }) => PersonalContextSnapshotResult
}

type StoredSource = PersonalContextTelegramSource & { readonly occurredAt: string }

type StoredAssert = {
  readonly operation: 'assert'
  readonly targetFactIds: readonly []
  readonly evidence: PersonalContextEvidence
  readonly fact: PersonalContextFact
}

type StoredConfirm = {
  readonly operation: 'confirm'
  readonly targetFactIds: readonly [string]
  readonly evidence: PersonalContextEvidence
}

type StoredCorrect = {
  readonly operation: 'correct'
  readonly targetFactIds: readonly [string]
  readonly evidence: PersonalContextEvidence
  readonly fact: PersonalContextFact
}

type StoredReplace = {
  readonly operation: 'replace'
  readonly targetFactIds: readonly [string, ...string[]]
  readonly evidence: PersonalContextEvidence
  readonly fact: PersonalContextFact
}

type StoredWithdraw = {
  readonly operation: 'withdraw'
  readonly targetFactIds: readonly [string, ...string[]]
  readonly evidence: PersonalContextEvidence
}

export type PersonalContextRevision =
  | StoredAssert
  | StoredConfirm
  | StoredCorrect
  | StoredReplace
  | StoredWithdraw

export type PersonalContextLogRecord = {
  readonly schemaVersion: 1
  readonly event: 'personal_fact_source_observed'
  readonly source: StoredSource
  readonly appliedAt: string
  readonly authorization: PersonalContextAuthorization
  readonly decision:
    | { readonly kind: 'ignored' }
    | { readonly kind: 'revisions'; readonly changes: readonly PersonalContextRevision[] }
}

type MutableActiveFact = PersonalContextFact & { evidence: PersonalContextFactEvidence[] }

type SemanticAssert = {
  readonly operation: 'assert'
  readonly targetFactIds: readonly []
  readonly lane: PersonalContextLane
  readonly stance?: 'include' | 'exclude'
  readonly epistemic?: 'asserted' | 'uncertain'
  readonly evidenceSpan: PersonalContextSpan
  readonly scopeSpan: PersonalContextSpan
}

type SemanticFactRevision = Omit<SemanticAssert, 'operation' | 'targetFactIds'> & {
  readonly operation: 'correct' | 'replace'
  readonly targetFactIds: readonly string[]
}

type SemanticEvidenceRevision = {
  readonly operation: 'confirm' | 'withdraw'
  readonly targetFactIds: readonly string[]
  readonly evidenceSpan: PersonalContextSpan
}

type ParsedSemanticChange = SemanticAssert | SemanticFactRevision | SemanticEvidenceRevision

const AUTHORIZATION: PersonalContextAuthorization = deepFreeze({
  policy: 'direct_user_statement',
  purpose: 'personal_feed_context',
})

export function createPersonalContextOwner(options: CreatePersonalContextOwnerOptions): PersonalContextOwner {
  validateOptions(options)
  const { logPath, clock, semantic } = options
  let tail: Promise<void> = Promise.resolve()

  const observe = (input: {
    readonly source: PersonalContextTelegramSource
    readonly rawText: string
    readonly signal?: AbortSignal
  }): Promise<PersonalContextObserveResult> => {
    validateObserveInput(input)
    const operation = tail.then(
      async () => observeOnce(logPath, clock, semantic, input),
      async () => observeOnce(logPath, clock, semantic, input),
    )
    tail = operation.then(() => undefined, () => undefined)
    return operation
  }

  return Object.freeze({
    observe,
    snapshot: (input: { readonly request: PersonalContextRequest }) => {
      validateSnapshotInput(input)
      let log: ParsedLog
      try {
        log = readLog(logPath)
      } catch {
        return deepFreeze({ kind: 'unknown' as const, reason: 'store_unavailable' as const })
      }
      const cutoff = Date.parse(input.request.cutoff)
      const selected = log.records.filter(record => (
        Date.parse(record.appliedAt) <= cutoff
        && personalFeedV2TelegramRequestId(record.source.chatId, record.source.messageId) !== input.request.requestId
      ))
      const active = foldRecords(selected)
      if (active === undefined) {
        return deepFreeze({ kind: 'unknown' as const, reason: 'store_unavailable' as const })
      }
      return snapshotResult(input.request.cutoff, active)
    },
  })
}

async function observeOnce(
  logPath: string,
  clock: PersonalContextClock,
  semantic: PersonalContextSemanticPort,
  input: {
    readonly source: PersonalContextTelegramSource
    readonly rawText: string
    readonly signal?: AbortSignal
  },
): Promise<PersonalContextObserveResult> {
  if (isAborted(input.signal)) return incomplete('aborted')

  let log: ParsedLog
  try {
    log = readLog(logPath)
  } catch {
    return incomplete('store_unavailable')
  }
  const sourceKey = keyForSource(input.source)
  if (log.sourceKeys.has(sourceKey)) return deepFreeze({ kind: 'already_observed' as const })

  const occurredAt = readClock(clock)
  const semanticInput: PersonalContextSemanticInput = deepFreeze({
    source: { ...input.source },
    rawText: input.rawText,
    authorization: AUTHORIZATION,
    activeFacts: viewsFrom(log.active),
  })
  let rawDecision: unknown
  try {
    rawDecision = await semantic.revise(semanticInput, input.signal)
  } catch {
    return incomplete(isAborted(input.signal) ? 'aborted' : 'semantic_unavailable')
  }
  if (isAborted(input.signal)) return incomplete('aborted')

  const decision = prepareDecision(rawDecision, input.rawText, input.source, log.active)
  if (decision === undefined) return incomplete('invalid_semantics')
  const appliedAt = readClock(clock)
  const record: PersonalContextLogRecord = {
    schemaVersion: 1,
    event: 'personal_fact_source_observed',
    source: { ...input.source, occurredAt },
    appliedAt,
    authorization: AUTHORIZATION,
    decision,
  }
  if (foldRecords([...log.records, record]) === undefined) return incomplete('invalid_semantics')

  try {
    appendJsonLine(logPath, log.records, record)
    chmodSync(logPath, 0o600)
  } catch {
    return incomplete('store_unavailable')
  }
  return deepFreeze({ kind: decision.kind === 'ignored' ? 'ignored' as const : 'applied' as const })
}

type ParsedLog = {
  readonly records: readonly PersonalContextLogRecord[]
  readonly sourceKeys: ReadonlySet<string>
  readonly active: ReadonlyMap<string, MutableActiveFact>
}

function readLog(logPath: string): ParsedLog {
  const values = readJsonLines(logPath, 'personal facts')
  const records: PersonalContextLogRecord[] = []
  const sourceKeys = new Set<string>()
  let lastAppliedAt = Number.NEGATIVE_INFINITY
  for (const value of values) {
    const record = parseRecord(value)
    const sourceKey = keyForSource(record.source)
    const appliedAt = Date.parse(record.appliedAt)
    if (sourceKeys.has(sourceKey) || appliedAt < lastAppliedAt) throw new Error('invalid personal facts log')
    sourceKeys.add(sourceKey)
    lastAppliedAt = appliedAt
    records.push(record)
  }
  const active = foldRecords(records)
  if (active === undefined) throw new Error('invalid personal facts revisions')
  return { records, sourceKeys, active }
}

function prepareDecision(
  value: unknown,
  rawText: string,
  source: PersonalContextTelegramSource,
  active: ReadonlyMap<string, MutableActiveFact>,
): PersonalContextLogRecord['decision'] | undefined {
  const record = plainRecord(value)
  if (record === undefined) return undefined
  if (exactKeys(record, ['kind']) && record.kind === 'ignored') return { kind: 'ignored' }
  if (!exactKeys(record, ['kind', 'changes']) || record.kind !== 'revisions' || !Array.isArray(record.changes)
    || record.changes.length === 0) return undefined

  const usedTargets = new Set<string>()
  const changes: PersonalContextRevision[] = []
  for (let index = 0; index < record.changes.length; index += 1) {
    const parsed = parseSemanticChange(record.changes[index])
    if (parsed === undefined) return undefined
    for (const target of parsed.targetFactIds) {
      if (usedTargets.has(target)) return undefined
      usedTargets.add(target)
    }
    const targets = parsed.targetFactIds.map(target => active.get(target))
    if (targets.some(target => target === undefined)) return undefined
    const targetFacts = targets as MutableActiveFact[]
    const targetLane = targetFacts[0]?.lane
    if (targetFacts.some(target => target.lane !== targetLane)) return undefined

    const evidenceText = textFromSpan(rawText, parsed.evidenceSpan)
    if (evidenceText === undefined) return undefined
    const evidence = { verbatim: evidenceText }
    if (parsed.operation === 'confirm') {
      if (targetFacts.length !== 1) return undefined
      changes.push({ operation: 'confirm', targetFactIds: [parsed.targetFactIds[0]!], evidence })
      continue
    }
    if (parsed.operation === 'withdraw') {
      if (targetFacts.length === 0) return undefined
      changes.push({
        operation: 'withdraw',
        targetFactIds: parsed.targetFactIds as [string, ...string[]],
        evidence,
      })
      continue
    }
    if (parsed.operation !== 'assert' && parsed.operation !== 'correct' && parsed.operation !== 'replace') {
      return undefined
    }

    const scopeText = textFromSpan(rawText, parsed.scopeSpan)
    if (scopeText === undefined) return undefined
    if (parsed.operation === 'assert' && parsed.targetFactIds.length !== 0) return undefined
    if (parsed.operation === 'correct' && parsed.targetFactIds.length !== 1) return undefined
    if (parsed.operation === 'replace' && parsed.targetFactIds.length === 0) return undefined
    if (parsed.operation !== 'assert' && targetLane !== parsed.lane) return undefined

    const fact = factFromSemantic(parsed, source, index, scopeText)
    if (fact === undefined) return undefined
    if (parsed.operation === 'assert') {
      changes.push({ operation: 'assert', targetFactIds: [], evidence, fact })
    } else if (parsed.operation === 'correct') {
      changes.push({ operation: 'correct', targetFactIds: [parsed.targetFactIds[0]!], evidence, fact })
    } else {
      changes.push({
        operation: 'replace',
        targetFactIds: parsed.targetFactIds as [string, ...string[]],
        evidence,
        fact,
      })
    }
  }
  return { kind: 'revisions', changes }
}

function factFromSemantic(
  change: SemanticAssert | SemanticFactRevision,
  source: PersonalContextTelegramSource,
  ordinal: number,
  scope: string,
): PersonalContextFact | undefined {
  const factId = `${source.kind}:${source.chatId}:${source.messageId}#${ordinal}`
  if (change.lane === 'long_term_interest') {
    if (change.stance !== 'include' && change.stance !== 'exclude') return undefined
    if (change.epistemic !== undefined) return undefined
    return { factId, lane: change.lane, stance: change.stance, scope: { verbatim: scope } }
  }
  if (change.epistemic !== 'asserted' && change.epistemic !== 'uncertain') return undefined
  if (change.stance !== undefined) return undefined
  return { factId, lane: change.lane, epistemic: change.epistemic, scope: { verbatim: scope } }
}

function parseSemanticChange(value: unknown): ParsedSemanticChange | undefined {
  const record = plainRecord(value)
  if (record === undefined || typeof record.operation !== 'string') return undefined
  if (record.operation === 'confirm' || record.operation === 'withdraw') {
    if (!exactKeys(record, ['operation', 'targetFactIds', 'evidenceSpan'])) return undefined
    const targetFactIds = stringArray(record.targetFactIds)
    const evidenceSpan = parseSpan(record.evidenceSpan)
    if (targetFactIds === undefined || evidenceSpan === undefined) return undefined
    return { operation: record.operation, targetFactIds, evidenceSpan }
  }
  if (record.operation !== 'assert' && record.operation !== 'correct' && record.operation !== 'replace') {
    return undefined
  }
  const lane = record.lane
  if (lane === 'long_term_interest') {
    if (!exactKeys(record, ['operation', 'targetFactIds', 'lane', 'stance', 'evidenceSpan', 'scopeSpan'])
      || (record.stance !== 'include' && record.stance !== 'exclude')) return undefined
    return parsedFactChange(record, lane, { stance: record.stance })
  }
  if (lane === 'existing_knowledge') {
    if (!exactKeys(record, ['operation', 'targetFactIds', 'lane', 'epistemic', 'evidenceSpan', 'scopeSpan'])
      || (record.epistemic !== 'asserted' && record.epistemic !== 'uncertain')) return undefined
    return parsedFactChange(record, lane, { epistemic: record.epistemic })
  }
  return undefined
}

function parsedFactChange(
  record: Record<string, unknown>,
  lane: PersonalContextLane,
  state: { readonly stance: 'include' | 'exclude' } | { readonly epistemic: 'asserted' | 'uncertain' },
): SemanticAssert | SemanticFactRevision | undefined {
  const targetFactIds = stringArray(record.targetFactIds)
  const evidenceSpan = parseSpan(record.evidenceSpan)
  const scopeSpan = parseSpan(record.scopeSpan)
  if (targetFactIds === undefined || evidenceSpan === undefined || scopeSpan === undefined) return undefined
  const shared = { targetFactIds, lane, evidenceSpan, scopeSpan, ...state }
  if (record.operation === 'assert') return { ...shared, operation: 'assert' } as SemanticAssert
  return { ...shared, operation: record.operation as 'correct' | 'replace' } as SemanticFactRevision
}

function parseRecord(value: unknown): PersonalContextLogRecord {
  const record = requireRecord(value, ['schemaVersion', 'event', 'source', 'appliedAt', 'authorization', 'decision'])
  if (record.schemaVersion !== 1 || record.event !== 'personal_fact_source_observed') throw new Error('invalid record identity')
  const source = parseStoredSource(record.source)
  const appliedAt = requireIso(record.appliedAt)
  if (Date.parse(appliedAt) < Date.parse(source.occurredAt)) throw new Error('invalid record time')
  const authorization = parseAuthorization(record.authorization)
  const decisionRecord = plainRecord(record.decision)
  if (decisionRecord === undefined) throw new Error('invalid record decision')
  let decision: PersonalContextLogRecord['decision']
  if (exactKeys(decisionRecord, ['kind']) && decisionRecord.kind === 'ignored') {
    decision = { kind: 'ignored' }
  } else {
    if (!exactKeys(decisionRecord, ['kind', 'changes']) || decisionRecord.kind !== 'revisions'
      || !Array.isArray(decisionRecord.changes) || decisionRecord.changes.length === 0) {
      throw new Error('invalid revisions decision')
    }
    decision = {
      kind: 'revisions',
      changes: decisionRecord.changes.map((change, index) => parseStoredChange(change, source, index)),
    }
  }
  return { schemaVersion: 1, event: 'personal_fact_source_observed', source, appliedAt, authorization, decision }
}

function parseStoredSource(value: unknown): StoredSource {
  const source = requireRecord(value, ['kind', 'chatId', 'messageId', 'occurredAt'])
  if (source.kind !== 'telegram_inbound' || !validChatId(source.chatId) || !validMessageId(source.messageId)) {
    throw new Error('invalid source')
  }
  return {
    kind: source.kind,
    chatId: source.chatId,
    messageId: source.messageId,
    occurredAt: requireIso(source.occurredAt),
  }
}

function parseAuthorization(value: unknown): PersonalContextAuthorization {
  const authorization = requireRecord(value, ['policy', 'purpose'])
  if (authorization.policy !== AUTHORIZATION.policy || authorization.purpose !== AUTHORIZATION.purpose) {
    throw new Error('invalid authorization')
  }
  return AUTHORIZATION
}

function parseStoredChange(
  value: unknown,
  source: StoredSource,
  ordinal: number,
): PersonalContextRevision {
  const change = plainRecord(value)
  if (change === undefined || typeof change.operation !== 'string') throw new Error('invalid change')
  const expectedFactId = `${source.kind}:${source.chatId}:${source.messageId}#${ordinal}`
  if (change.operation === 'confirm' || change.operation === 'withdraw') {
    const targetLength = change.operation === 'confirm' ? 1 : undefined
    const parsed = parseStoredEvidenceChange(change, targetLength)
    return change.operation === 'confirm'
      ? { operation: 'confirm', targetFactIds: [parsed.targetFactIds[0]!], evidence: parsed.evidence }
      : {
          operation: 'withdraw',
          targetFactIds: parsed.targetFactIds as [string, ...string[]],
          evidence: parsed.evidence,
        }
  }
  if (change.operation !== 'assert' && change.operation !== 'correct' && change.operation !== 'replace') {
    throw new Error('invalid operation')
  }
  if (!exactKeys(change, ['operation', 'targetFactIds', 'evidence', 'fact'])) throw new Error('invalid fact change')
  const targetFactIds = stringArray(change.targetFactIds)
  const evidence = parseVerbatim(change.evidence)
  const fact = parseFact(change.fact, expectedFactId)
  if (targetFactIds === undefined) throw new Error('invalid targets')
  if (change.operation === 'assert' && targetFactIds.length === 0) {
    return { operation: 'assert', targetFactIds: [], evidence, fact }
  }
  if (change.operation === 'correct' && targetFactIds.length === 1) {
    return { operation: 'correct', targetFactIds: [targetFactIds[0]!], evidence, fact }
  }
  if (change.operation === 'replace' && targetFactIds.length > 0) {
    return { operation: 'replace', targetFactIds: targetFactIds as [string, ...string[]], evidence, fact }
  }
  throw new Error('invalid target cardinality')
}

function parseStoredEvidenceChange(
  change: Record<string, unknown>,
  exactTargetLength: number | undefined,
): { readonly targetFactIds: readonly string[]; readonly evidence: PersonalContextEvidence } {
  if (!exactKeys(change, ['operation', 'targetFactIds', 'evidence'])) throw new Error('invalid evidence change')
  const targetFactIds = stringArray(change.targetFactIds)
  if (targetFactIds === undefined || targetFactIds.length === 0
    || (exactTargetLength !== undefined && targetFactIds.length !== exactTargetLength)) throw new Error('invalid targets')
  return { targetFactIds, evidence: parseVerbatim(change.evidence) }
}

function parseFact(value: unknown, expectedFactId: string): PersonalContextFact {
  const fact = plainRecord(value)
  if (fact === undefined || fact.factId !== expectedFactId) throw new Error('invalid fact id')
  if (fact.lane === 'long_term_interest') {
    if (!exactKeys(fact, ['factId', 'lane', 'stance', 'scope'])
      || (fact.stance !== 'include' && fact.stance !== 'exclude')) throw new Error('invalid interest fact')
    return { factId: expectedFactId, lane: fact.lane, stance: fact.stance, scope: parseVerbatim(fact.scope) }
  }
  if (fact.lane === 'existing_knowledge') {
    if (!exactKeys(fact, ['factId', 'lane', 'epistemic', 'scope'])
      || (fact.epistemic !== 'asserted' && fact.epistemic !== 'uncertain')) throw new Error('invalid knowledge fact')
    return { factId: expectedFactId, lane: fact.lane, epistemic: fact.epistemic, scope: parseVerbatim(fact.scope) }
  }
  throw new Error('invalid fact lane')
}

function parseVerbatim(value: unknown): PersonalContextEvidence {
  const evidence = requireRecord(value, ['verbatim'])
  if (typeof evidence.verbatim !== 'string' || evidence.verbatim.trim() === ''
    || evidence.verbatim !== evidence.verbatim.trim()) throw new Error('invalid verbatim')
  return { verbatim: evidence.verbatim }
}

function foldRecords(records: readonly PersonalContextLogRecord[]): Map<string, MutableActiveFact> | undefined {
  let active = new Map<string, MutableActiveFact>()
  const seenFactIds = new Set<string>()
  for (const record of records) {
    if (record.decision.kind === 'ignored') continue
    const before = active
    const next = cloneActive(active)
    const usedTargets = new Set<string>()
    for (const change of record.decision.changes) {
      for (const targetId of change.targetFactIds) {
        if (usedTargets.has(targetId)) return undefined
        usedTargets.add(targetId)
      }
      const targets = change.targetFactIds.map(targetId => before.get(targetId))
      if (targets.some(target => target === undefined)) return undefined
      const targetFacts = targets as MutableActiveFact[]
      const targetLane = targetFacts[0]?.lane
      if (targetFacts.some(target => target.lane !== targetLane)) return undefined
      const evidence: PersonalContextFactEvidence = {
        source: { kind: record.source.kind, chatId: record.source.chatId, messageId: record.source.messageId },
        occurredAt: record.source.occurredAt,
        verbatim: change.evidence.verbatim,
      }

      if (change.operation === 'confirm') {
        if (targetFacts.length !== 1) return undefined
        const target = next.get(change.targetFactIds[0]!)
        if (target === undefined) return undefined
        target.evidence.push(evidence)
        continue
      }
      if (change.operation === 'withdraw') {
        if (targetFacts.length === 0) return undefined
        for (const targetId of change.targetFactIds) next.delete(targetId)
        continue
      }
      if (seenFactIds.has(change.fact.factId) || (change.operation !== 'assert' && change.fact.lane !== targetLane)) {
        return undefined
      }
      if (change.operation === 'assert' && change.targetFactIds.length !== 0) return undefined
      if (change.operation === 'correct' && change.targetFactIds.length !== 1) return undefined
      if (change.operation === 'replace' && change.targetFactIds.length === 0) return undefined
      for (const targetId of change.targetFactIds) next.delete(targetId)
      seenFactIds.add(change.fact.factId)
      next.set(change.fact.factId, { ...change.fact, evidence: [evidence] })
    }
    active = next
  }
  return active
}

function snapshotResult(
  cutoff: string,
  active: ReadonlyMap<string, MutableActiveFact>,
): PersonalContextSnapshotResult {
  const facts = viewsFrom(active)
  const interest = facts.filter(fact => fact.lane === 'long_term_interest')
  const knowledge = facts.filter(fact => fact.lane === 'existing_knowledge')
  const included = interest.filter(fact => fact.lane === 'long_term_interest' && fact.stance === 'include')
  const asserted = knowledge.filter(fact => fact.lane === 'existing_knowledge' && fact.epistemic === 'asserted')
  const longTermInterest: PersonalContextLaneSufficiency = included.length === 0
    ? { status: 'insufficient', reason: 'no_active_include' }
    : { status: 'sufficient', basisFactIds: included.map(fact => fact.factId) }
  const existingKnowledge: PersonalContextLaneSufficiency = asserted.length === 0
    ? { status: 'insufficient', reason: 'no_asserted_knowledge' }
    : { status: 'sufficient', basisFactIds: asserted.map(fact => fact.factId) }
  if (longTermInterest.status === 'insufficient' || existingKnowledge.status === 'insufficient') {
    return deepFreeze({ kind: 'insufficient', laneStatus: { longTermInterest, existingKnowledge } })
  }
  return deepFreeze({
    kind: 'sufficient',
    snapshot: {
      schemaVersion: 1,
      cutoff,
      longTermInterest: { activeFacts: interest, sufficiency: longTermInterest },
      existingKnowledge: { activeFacts: knowledge, sufficiency: existingKnowledge },
    },
  })
}

function viewsFrom(active: ReadonlyMap<string, MutableActiveFact>): PersonalContextActiveFact[] {
  return [...active.values()].map(fact => ({
    ...fact,
    scope: { ...fact.scope },
    evidence: fact.evidence.map(evidence => ({
      source: { ...evidence.source },
      occurredAt: evidence.occurredAt,
      verbatim: evidence.verbatim,
    })),
  }))
}

function cloneActive(active: ReadonlyMap<string, MutableActiveFact>): Map<string, MutableActiveFact> {
  return new Map([...active].map(([factId, fact]) => [factId, {
    ...fact,
    scope: { ...fact.scope },
    evidence: fact.evidence.map(evidence => ({ ...evidence, source: { ...evidence.source } })),
  }]))
}

function textFromSpan(rawText: string, span: PersonalContextSpan): string | undefined {
  if (span.startUtf16 < 0 || span.endUtf16 <= span.startUtf16 || span.endUtf16 > rawText.length
    || !utf16Boundary(rawText, span.startUtf16) || !utf16Boundary(rawText, span.endUtf16)) return undefined
  const value = rawText.slice(span.startUtf16, span.endUtf16)
  return value !== '' && value.trim() === value ? value : undefined
}

function utf16Boundary(value: string, index: number): boolean {
  if (index <= 0 || index >= value.length) return true
  const before = value.charCodeAt(index - 1)
  const after = value.charCodeAt(index)
  return !(before >= 0xD800 && before <= 0xDBFF && after >= 0xDC00 && after <= 0xDFFF)
}

function parseSpan(value: unknown): PersonalContextSpan | undefined {
  const span = plainRecord(value)
  if (span === undefined || !exactKeys(span, ['startUtf16', 'endUtf16'])
    || !Number.isSafeInteger(span.startUtf16) || !Number.isSafeInteger(span.endUtf16)) return undefined
  return { startUtf16: span.startUtf16 as number, endUtf16: span.endUtf16 as number }
}

function stringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.trim() === '')
    || new Set(value).size !== value.length) return undefined
  return [...value] as string[]
}

function keyForSource(source: PersonalContextTelegramSource): string {
  return `${source.kind}:${source.chatId}:${source.messageId}`
}

function incomplete(reason: Extract<PersonalContextObserveResult, { kind: 'incomplete' }>['reason']): PersonalContextObserveResult {
  return deepFreeze({ kind: 'incomplete', reason })
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

function readClock(clock: PersonalContextClock): string {
  const value = clock.now()
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new TypeError('personal context clock is invalid')
  return value.toISOString()
}

function requireIso(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || new Date(value).toISOString() !== value) throw new Error('invalid ISO instant')
  return value
}

function validateOptions(options: CreatePersonalContextOwnerOptions): void {
  const value = plainRecord(options)
  if (value === undefined || !exactKeys(value, ['logPath', 'clock', 'semantic'])
    || typeof value.logPath !== 'string' || value.logPath.trim() === '' || !isAbsolute(value.logPath)) {
    throw new TypeError('personal context owner options are invalid')
  }
  const clock = plainRecord(value.clock)
  const semantic = plainRecord(value.semantic)
  if (clock === undefined || !exactKeys(clock, ['now']) || typeof clock.now !== 'function'
    || semantic === undefined || !exactKeys(semantic, ['revise']) || typeof semantic.revise !== 'function') {
    throw new TypeError('personal context owner options are invalid')
  }
}

function validateObserveInput(input: {
  readonly source: PersonalContextTelegramSource
  readonly rawText: string
  readonly signal?: AbortSignal
}): void {
  const value = plainRecord(input)
  if (value === undefined || !exactKeys(value, ['source', 'rawText'], ['signal']) || typeof value.rawText !== 'string') {
    throw new TypeError('personal context observe input is invalid')
  }
  const source = plainRecord(value.source)
  if (source === undefined || !exactKeys(source, ['kind', 'chatId', 'messageId'])
    || source.kind !== 'telegram_inbound' || !validChatId(source.chatId) || !validMessageId(source.messageId)) {
    throw new TypeError('personal context observe source is invalid')
  }
  if (value.signal !== undefined && !(value.signal instanceof AbortSignal)) {
    throw new TypeError('personal context observe signal is invalid')
  }
}

function validateSnapshotInput(input: { readonly request: PersonalContextRequest }): void {
  const value = plainRecord(input)
  const request = value === undefined ? undefined : plainRecord(value.request)
  if (value === undefined || !exactKeys(value, ['request']) || request === undefined
    || !exactKeys(request, ['requestId', 'cutoff', 'shanghaiDay'])
    || typeof request.requestId !== 'string' || request.requestId.trim() === ''
    || typeof request.shanghaiDay !== 'string' || request.shanghaiDay !== shanghaiDay(requireIso(request.cutoff))) {
    throw new TypeError('personal context snapshot input is invalid')
  }
}

function shanghaiDay(instant: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(instant))
  const values = new Map(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]))
  return `${values.get('year')}-${values.get('month')}-${values.get('day')}`
}

function validChatId(value: unknown): value is number {
  return Number.isSafeInteger(value) && value !== 0
}

function validMessageId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}

function requireRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const record = plainRecord(value)
  if (record === undefined || !exactKeys(record, keys)) throw new Error('invalid object shape')
  return record
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : undefined
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Reflect.ownKeys(value)
  if (keys.some(key => typeof key !== 'string') || required.some(key => !keys.includes(key))) return false
  if (keys.some(key => !required.includes(key as string) && !optional.includes(key as string))) return false
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) return false
  }
  return true
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}
