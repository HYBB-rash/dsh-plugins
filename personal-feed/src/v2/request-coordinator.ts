import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { types as nodeTypes } from 'node:util'
import { readJsonLines, appendJsonLine } from '../durable-jsonl-store.ts'
import { encodeCanonicalJson } from '../canonical-json.ts'
import { PersonalFeedScopeInputError, PersonalFeedScopeStoreError } from '../errors.ts'
import { canonicalizeXStatusIdentity } from './x-status-identity.ts'

export interface PersonalFeedV2Request {
  readonly requestId: string
  readonly cutoff: string
  readonly shanghaiDay: string
}

export interface PersonalFeedV2Clock {
  readonly now: () => Date
}

export interface PersonalFeedV2R4Input {
  readonly request: PersonalFeedV2Request
  readonly signal: AbortSignal
}

export interface PersonalFeedV2R2Input {
  readonly request: PersonalFeedV2Request
  readonly signal: AbortSignal
}

export interface PersonalFeedV2R3Input {
  readonly request: PersonalFeedV2Request
  readonly window: unknown
  readonly signal: AbortSignal
}

export interface PersonalFeedV2R5Input {
  readonly request: PersonalFeedV2Request
  readonly snapshot: unknown
  readonly candidates: PersonalFeedV2R5CandidateCursor
  readonly signal: AbortSignal
}

export interface PersonalFeedV2R5CandidateProvenance {
  readonly capturedAt: string
  readonly surface: 'for_you' | 'following' | 'explore'
  readonly surfaceOrdinal: number
  readonly occurrenceOrdinal: number
  readonly canonicalUrl: string
  readonly authorHandle: string
  readonly publishedAt: string
}

export type PersonalFeedV2R5CandidateIncompleteReason =
  | 'aborted'
  | 'body_failed'
  | 'body_insufficient'
  | 'body_unknown'
  | 'capture_failed'
  | 'clock_failed'
  | 'completion_claim_invalid'
  | 'completion_conflict'
  | 'completion_store_failed'
  | 'concurrent_reservation'
  | 'expired'
  | 'failed'
  | 'invalid_input'
  | 'processed_query_aborted'
  | 'processed_query_failed'
  | 'processed_query_unknown'
  | 'timeout'
  | 'unknown'

export interface PersonalFeedV2R5CandidateLease {
  readonly stableId: string
  readonly canonicalUrl: string
  readonly position: number
  readonly body: string
  readonly provenance: PersonalFeedV2R5CandidateProvenance
  readonly completeCurrent: (input: {
    readonly judgment: 'qualified' | 'not_qualified'
  }) => Promise<unknown>
}

export type PersonalFeedV2R5CandidateBorrowResult =
  | { readonly kind: 'candidate'; readonly lease: PersonalFeedV2R5CandidateLease }
  | { readonly kind: 'done' }
  | { readonly kind: 'incomplete'; readonly reason: PersonalFeedV2R5CandidateIncompleteReason }

export interface PersonalFeedV2R5CandidateCursor {
  readonly borrowCurrent: (input: {
    readonly signal: AbortSignal
  }) => Promise<PersonalFeedV2R5CandidateBorrowResult>
}

export interface PersonalFeedV2R4Port {
  readonly snapshot: (input: PersonalFeedV2R4Input) => unknown | Promise<unknown>
}

export interface PersonalFeedV2R2Port {
  readonly observe: (input: PersonalFeedV2R2Input) => unknown | Promise<unknown>
}

export interface PersonalFeedV2R3Port {
  readonly admit: (input: PersonalFeedV2R3Input) => unknown | Promise<unknown>
}

export interface PersonalFeedV2R5Port {
  readonly judge: (input: PersonalFeedV2R5Input) => unknown | Promise<unknown>
}

export interface CreatePersonalFeedV2RequestCoordinatorOptions {
  readonly ledgerPath: string
  readonly clock: PersonalFeedV2Clock
  readonly r4: PersonalFeedV2R4Port
  readonly r2: PersonalFeedV2R2Port
  readonly r3: PersonalFeedV2R3Port
  readonly r5: PersonalFeedV2R5Port
}

export interface PersonalFeedV2PrepareInput {
  readonly chatId: number
  readonly messageId: number
  readonly signal: AbortSignal
}

export interface PersonalFeedV2Receipt {
  readonly chatId: number
  readonly triggerMessageId: number
  readonly visibleText: string
  readonly messageIds: readonly [number]
}

export type PersonalFeedV2Outcome =
  | {
      readonly kind: 'one_link'
      readonly finalText: string
      readonly digest: string
    }
  | {
      readonly kind: 'business_empty'
      readonly finalText: string
      readonly digest: string
    }
  | {
      readonly kind: 'incomplete'
      readonly category: PersonalFeedV2IncompleteCategory
      readonly finalText: string
      readonly digest: string
    }

export type PersonalFeedV2IncompleteCategory =
  | 'personal_context'
  | 'source_window'
  | 'judgement_execution'

export interface PersonalFeedV2PreparedResult {
  readonly kind: 'prepared'
  readonly request: PersonalFeedV2Request
  readonly outcome: PersonalFeedV2Outcome
  readonly settle: (receipt: PersonalFeedV2Receipt) => void
}

export interface PersonalFeedV2DuplicateResult {
  readonly kind: 'duplicate_consumed'
}

export type PersonalFeedV2PrepareResult = PersonalFeedV2PreparedResult | PersonalFeedV2DuplicateResult

export type PersonalFeedV2RequestSnapshot =
  | { readonly status: 'open'; readonly request: PersonalFeedV2Request }
  | { readonly status: 'prepared'; readonly request: PersonalFeedV2Request; readonly outcome: PersonalFeedV2Outcome }
  | {
      readonly status: 'delivered'
      readonly request: PersonalFeedV2Request
      readonly outcome: PersonalFeedV2Outcome
      readonly receipt: PersonalFeedV2Receipt
    }

export interface PersonalFeedV2RequestCoordinator {
  readonly prepare: (input: PersonalFeedV2PrepareInput) => Promise<PersonalFeedV2PrepareResult>
  readonly read: (requestId: string) => PersonalFeedV2RequestSnapshot | undefined
  readonly drain: () => Promise<void>
}

type RequestOpenedRecord = {
  readonly schemaVersion: 1
  readonly event: 'request_opened'
  readonly requestId: string
  readonly request: {
    readonly chatId: number
    readonly messageId: number
    readonly cutoff: string
    readonly shanghaiDay: string
  }
}

type OutcomePreparedRecord = {
  readonly schemaVersion: 1
  readonly event: 'outcome_prepared'
  readonly requestId: string
  readonly outcome: PersonalFeedV2Outcome
}

type DeliveredTerminalRecord = {
  readonly schemaVersion: 1
  readonly event: 'delivered_terminal'
  readonly requestId: string
  readonly outcomeDigest: string
  readonly receipt: PersonalFeedV2Receipt
}

type LedgerRecord = RequestOpenedRecord | OutcomePreparedRecord | DeliveredTerminalRecord

interface ParsedLedger {
  readonly values: readonly LedgerRecord[]
  readonly states: ReadonlyMap<string, LedgerState>
}

interface LedgerState {
  readonly request?: RequestOpenedRecord
  readonly prepared?: OutcomePreparedRecord
  readonly terminal?: DeliveredTerminalRecord
  readonly eventCanonical: ReadonlyMap<string, string>
}

const PERSONAL_CONTEXT_TEXT = '这次没有完成：个人语境不足或未完成。'
const SOURCE_WINDOW_TEXT = '这次没有完成：X 来源或观察窗口未完成。'
const JUDGEMENT_EXECUTION_TEXT = '这次没有完成：判断或执行未完成。'
const BUSINESS_EMPTY_TEXT = '这次没有值得看的内容。'
const CLEANUP_WAIT_MS = 250
const CLEANUP_DRAIN_ERROR_TEXT = 'personal Feed v2 request cleanup seal-and-drain failed'

type CleanupAuthorityState = 'ready' | 'closing' | 'retained'

interface CleanupAuthority {
  readonly receiver: object
  readonly close: (reason: string) => unknown
  readonly args: readonly [string]
  state: CleanupAuthorityState
  promise: Promise<boolean> | undefined
}

interface CleanupAuthorityRegistry {
  readonly register: (receiver: object, close: (reason: string) => unknown) => CleanupAuthority
  readonly isSealed: () => boolean
  readonly retry: () => Promise<boolean>
  readonly attempt: (authority: CleanupAuthority) => Promise<boolean>
  readonly sealAndDrain: () => Promise<void>
}

interface ParsedR2 {
  readonly window: unknown
  readonly receiver: object
  readonly close: (reason: string) => unknown
}

function cleanupDrainError(): PersonalFeedScopeStoreError {
  return new PersonalFeedScopeStoreError(CLEANUP_DRAIN_ERROR_TEXT)
}

export function createPersonalFeedV2RequestCoordinator(
  options: CreatePersonalFeedV2RequestCoordinatorOptions,
): PersonalFeedV2RequestCoordinator {
  if (options.ledgerPath.trim() === '') {
    throw new PersonalFeedScopeStoreError('personal Feed v2 request ledger path must be non-empty')
  }

  const cleanupRegistry = createCleanupAuthorityRegistry()

  const readLedger = (): ParsedLedger => parseLedger(options.ledgerPath)

  const retryCleanupDetached = (): void => {
    if (cleanupRegistry.isSealed()) return
    void cleanupRegistry.retry().catch(() => undefined)
  }

  const read = (requestId: string): PersonalFeedV2RequestSnapshot | undefined => {
    const parsed = readLedger()
    const state = parsed.states.get(requestId)
    if (state === undefined || state.request === undefined) return undefined
    const request = publicRequest(state.request)
    if (state.terminal !== undefined && state.prepared !== undefined) {
      return deepFreeze({
        status: 'delivered',
        request,
        outcome: state.prepared.outcome,
        receipt: state.terminal.receipt,
      })
    }
    if (state.prepared !== undefined) {
      return deepFreeze({ status: 'prepared', request, outcome: state.prepared.outcome })
    }
    return deepFreeze({ status: 'open', request })
  }

  const settle = (requestId: string, receipt: PersonalFeedV2Receipt): void => {
    retryCleanupDetached()
    const parsedReceipt = parseReceipt(receipt)
    const parsed = readLedger()
    const state = parsed.states.get(requestId)
    if (state === undefined || state.request === undefined || state.prepared === undefined) {
      throw new PersonalFeedScopeStoreError(`personal Feed v2 request ${requestId} is not prepared`)
    }
    if (personalFeedV2TelegramRequestId(parsedReceipt.chatId, parsedReceipt.triggerMessageId) !== requestId) {
      throw new PersonalFeedScopeInputError('personal Feed v2 delivery receipt belongs to another request')
    }
    if (parsedReceipt.visibleText !== state.prepared.outcome.finalText) {
      throw new PersonalFeedScopeInputError('personal Feed v2 delivery receipt text does not match prepared outcome')
    }
    if (state.terminal !== undefined) {
      if (canonical(state.terminal.receipt) !== canonical(parsedReceipt)) {
        throw new PersonalFeedScopeStoreError(`personal Feed v2 request ${requestId} has a conflicting terminal receipt`)
      }
      return
    }
    const record: DeliveredTerminalRecord = {
      schemaVersion: 1,
      event: 'delivered_terminal',
      requestId,
      outcomeDigest: state.prepared.outcome.digest,
      receipt: parsedReceipt,
    }
    appendLedger(options.ledgerPath, parsed.values, record)
  }

  const prepare = async (input: PersonalFeedV2PrepareInput): Promise<PersonalFeedV2PrepareResult> => {
    if (cleanupRegistry.isSealed()) throw cleanupDrainError()
    validatePrepareInput(input)
    const requestId = personalFeedV2TelegramRequestId(input.chatId, input.messageId)
    const existing = readLedger().states.get(requestId)
    if (existing !== undefined) return { kind: 'duplicate_consumed' }

    let now: Date
    try {
      now = options.clock.now()
    } catch (cause) {
      throw new PersonalFeedScopeStoreError('personal Feed v2 request clock failed', { cause })
    }
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      throw new PersonalFeedScopeStoreError('personal Feed v2 request clock did not return a valid Date')
    }
    const cutoff = now.toISOString()
    const request: RequestOpenedRecord['request'] = {
      chatId: input.chatId,
      messageId: input.messageId,
      cutoff,
      shanghaiDay: shanghaiDay(now),
    }
    const opened: RequestOpenedRecord = {
      schemaVersion: 1,
      event: 'request_opened',
      requestId,
      request,
    }
    // This synchronous append is intentionally before the first await: a pending
    // preparation is observable as open and a duplicate cannot start another chain.
    appendLedger(options.ledgerPath, readLedger().values, opened)

    let outcome: PersonalFeedV2Outcome
    const blockedByCleanup = await cleanupRegistry.retry()
    if (blockedByCleanup) {
      outcome = incomplete('judgement_execution', JUDGEMENT_EXECUTION_TEXT)
    } else {
      const r4Call = input.signal.aborted
        ? { ok: false as const }
        : await callPort(() => options.r4.snapshot({ request: publicRequest(opened), signal: input.signal }))
      const r4 = r4Call.ok ? r4Call.value : undefined
      if (r4 === undefined || input.signal.aborted) {
        outcome = incomplete('personal_context', PERSONAL_CONTEXT_TEXT)
      } else {
        const r4Result = parseR4(r4)
        if (r4Result === undefined) {
          outcome = incomplete('personal_context', PERSONAL_CONTEXT_TEXT)
        } else {
          const r2Call = input.signal.aborted
            ? { ok: false as const }
            : await callPort(() => options.r2.observe({ request: publicRequest(opened), signal: input.signal }))
          const r2 = r2Call.ok ? r2Call.value : undefined
          if (r2 === undefined) {
            outcome = incomplete('source_window', SOURCE_WINDOW_TEXT)
          } else {
            const r2Result = parseR2(r2)
            if (r2Result === undefined) {
              outcome = incomplete('source_window', SOURCE_WINDOW_TEXT)
            } else {
              const r2Authority = cleanupRegistry.register(r2Result.receiver, r2Result.close)
              if (input.signal.aborted) {
                await cleanupRegistry.attempt(r2Authority)
                outcome = incomplete('source_window', SOURCE_WINDOW_TEXT)
              } else {
                const r3Call = await callPort(() => options.r3.admit({ request: publicRequest(opened), window: r2Result.window, signal: input.signal }))
                const r3 = r3Call.ok ? r3Call.value : undefined
                if (r3 === undefined) {
                  const r2Closed = await cleanupRegistry.attempt(r2Authority)
                  outcome = incomplete(r2Closed ? 'judgement_execution' : 'source_window', r2Closed ? JUDGEMENT_EXECUTION_TEXT : SOURCE_WINDOW_TEXT)
                } else {
                  const r3Result = parseR3(r3)
                  if (r3Result === undefined || r3Result.kind === 'incomplete') {
                    const r2Closed = await cleanupRegistry.attempt(r2Authority)
                    outcome = incomplete(r2Closed ? 'judgement_execution' : 'source_window', r2Closed ? JUDGEMENT_EXECUTION_TEXT : SOURCE_WINDOW_TEXT)
                  } else if (r3Result.kind === 'salvage') {
                    const r3Authority = cleanupRegistry.register(r3Result.receiver, r3Result.close)
                    const r2Closed = await cleanupRegistry.attempt(r2Authority)
                    await cleanupRegistry.attempt(r3Authority)
                    const category: PersonalFeedV2IncompleteCategory = r2Closed ? 'judgement_execution' : 'source_window'
                    outcome = incomplete(category, incompleteText(category))
                  } else {
                    const r3Authority = cleanupRegistry.register(r3Result.cursor.owner, r3Result.cursor.close)
                    const r2Closed = await cleanupRegistry.attempt(r2Authority)
                    if (!r2Closed) {
                      await cleanupRegistry.attempt(r3Authority)
                      outcome = incomplete('source_window', SOURCE_WINDOW_TEXT)
                    } else {
                      outcome = await coordinateCandidateJudgement(
                        r3Result.cursor,
                        r3Authority,
                        cleanupRegistry,
                        publicRequest(opened),
                        r4Result.snapshot,
                        options.r5,
                        input.signal,
                      )
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    const preparedRecord: OutcomePreparedRecord = {
      schemaVersion: 1,
      event: 'outcome_prepared',
      requestId,
      outcome,
    }
    appendLedger(options.ledgerPath, readLedger().values, preparedRecord)
    const publicOutcome = deepFreeze(outcome)
    return {
      kind: 'prepared',
      request: deepFreeze(publicRequest(opened)),
      outcome: publicOutcome,
      settle: (receipt: PersonalFeedV2Receipt) => settle(requestId, receipt),
    }
  }

  const drain = cleanupRegistry.sealAndDrain
  return Object.freeze({ prepare, read, drain })
}

function validatePrepareInput(input: PersonalFeedV2PrepareInput): void {
  if (!isRecord(input) || !hasExactlyKeys(input, ['chatId', 'messageId', 'signal'])
    || !isSafeInteger(input.chatId) || input.chatId === 0 || !isSafePositiveInteger(input.messageId)
    || !isAbortSignal(input.signal)) {
    throw new PersonalFeedScopeInputError('personal Feed v2 request input is invalid')
  }
}

function parseLedger(path: string): ParsedLedger {
  const values: LedgerRecord[] = []
  const states = new Map<string, LedgerState>()
  for (const [index, value] of readJsonLines(path, 'v2 request').entries()) {
    const lineNumber = index + 1
    const record = parseLedgerRecord(value, lineNumber)
    values.push(record)
    let state = states.get(record.requestId)
    if (state === undefined) {
      state = { eventCanonical: new Map<string, string>() }
      states.set(record.requestId, state)
    }
    const recordCanonical = canonical(record)
    const priorCanonical = state.eventCanonical.get(record.event)
    if (priorCanonical !== undefined) {
      if (priorCanonical !== recordCanonical) {
        throw new PersonalFeedScopeStoreError(`personal Feed v2 request ledger line ${lineNumber} conflicts with a replayed ${record.event}`)
      }
      continue
    }
    if (record.event === 'request_opened') {
      if (state.request !== undefined || state.prepared !== undefined || state.terminal !== undefined) {
        throw new PersonalFeedScopeStoreError(`personal Feed v2 request ledger line ${lineNumber} has an invalid event order`)
      }
      state = { ...state, request: record, eventCanonical: new Map(state.eventCanonical).set(record.event, recordCanonical) }
    } else if (record.event === 'outcome_prepared') {
      if (state.request === undefined || state.prepared !== undefined || state.terminal !== undefined) {
        throw new PersonalFeedScopeStoreError(`personal Feed v2 request ledger line ${lineNumber} has an invalid event order`)
      }
      state = { ...state, prepared: record, eventCanonical: new Map(state.eventCanonical).set(record.event, recordCanonical) }
    } else {
      if (state.request === undefined || state.prepared === undefined || state.terminal !== undefined) {
        throw new PersonalFeedScopeStoreError(`personal Feed v2 request ledger line ${lineNumber} has an invalid event order`)
      }
      if (record.outcomeDigest !== state.prepared.outcome.digest
        || record.receipt.visibleText !== state.prepared.outcome.finalText) {
        throw new PersonalFeedScopeStoreError(`personal Feed v2 request ledger line ${lineNumber} conflicts with its prepared outcome`)
      }
      state = { ...state, terminal: record, eventCanonical: new Map(state.eventCanonical).set(record.event, recordCanonical) }
    }
    states.set(record.requestId, state)
  }
  return { values: deepFreeze(values), states }
}

function parseLedgerRecord(value: unknown, lineNumber: number): LedgerRecord {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.event !== 'string' || typeof value.requestId !== 'string') {
    throw ledgerSchemaError(lineNumber)
  }
  if (value.event === 'request_opened' && hasExactlyKeys(value, ['schemaVersion', 'event', 'requestId', 'request']) && isRecord(value.request)) {
    const request = value.request
    if (hasExactlyKeys(request, ['chatId', 'messageId', 'cutoff', 'shanghaiDay'])
      && isSafeInteger(request.chatId) && request.chatId !== 0 && isSafePositiveInteger(request.messageId)
      && isValidIso(request.cutoff) && isValidShanghaiDay(request.shanghaiDay)
      && shanghaiDay(new Date(request.cutoff)) === request.shanghaiDay
      && personalFeedV2TelegramRequestId(request.chatId, request.messageId) === value.requestId) {
      return deepFreeze(value as unknown as RequestOpenedRecord)
    }
  }
  if (value.event === 'outcome_prepared' && hasExactlyKeys(value, ['schemaVersion', 'event', 'requestId', 'outcome']) && isRecord(value.outcome)) {
    const outcome = parseOutcome(value.outcome)
    if (outcome !== undefined && typeof value.requestId === 'string') {
      return deepFreeze(value as unknown as OutcomePreparedRecord)
    }
  }
  if (value.event === 'delivered_terminal'
    && hasExactlyKeys(value, ['schemaVersion', 'event', 'requestId', 'outcomeDigest', 'receipt'])
    && isDigest(value.outcomeDigest) && isRecord(value.receipt)) {
    const receipt = parseReceipt(value.receipt, lineNumber)
    if (receipt !== undefined && personalFeedV2TelegramRequestId(receipt.chatId, receipt.triggerMessageId) === value.requestId) {
      return deepFreeze(value as unknown as DeliveredTerminalRecord)
    }
  }
  throw ledgerSchemaError(lineNumber)
}

function parseOutcome(value: Record<string, unknown>): PersonalFeedV2Outcome | undefined {
  if (!hasExactlyKeys(value, ['kind', 'finalText', 'digest']) && !hasExactlyKeys(value, ['kind', 'category', 'finalText', 'digest'])) return undefined
  if (typeof value.kind !== 'string' || typeof value.finalText !== 'string' || !isDigest(value.digest)) return undefined
  let withoutDigest: Record<string, unknown>
  if (value.kind === 'one_link' && hasExactlyKeys(value, ['kind', 'finalText', 'digest'])) {
    if (canonicalizeXStatusIdentity(value.finalText) !== value.finalText) return undefined
    withoutDigest = { kind: 'one_link', finalText: value.finalText }
  } else if (value.kind === 'business_empty' && hasExactlyKeys(value, ['kind', 'finalText', 'digest'])) {
    if (value.finalText !== BUSINESS_EMPTY_TEXT) return undefined
    withoutDigest = { kind: 'business_empty', finalText: value.finalText }
  } else if (value.kind === 'incomplete' && hasExactlyKeys(value, ['kind', 'category', 'finalText', 'digest'])
    && isIncompleteCategory(value.category) && value.finalText === incompleteText(value.category)) {
    withoutDigest = { kind: 'incomplete', category: value.category, finalText: value.finalText }
  } else return undefined
  if (digestFor(withoutDigest) !== value.digest) return undefined
  return deepFreeze(value as unknown as PersonalFeedV2Outcome)
}

function parseReceipt(value: unknown, fromLedgerLine?: number): PersonalFeedV2Receipt {
  if (!isRecord(value) || !hasExactlyKeys(value, ['chatId', 'triggerMessageId', 'visibleText', 'messageIds'])
    || !isSafeInteger(value.chatId) || value.chatId === 0 || !isSafePositiveInteger(value.triggerMessageId)
    || typeof value.visibleText !== 'string' || !Array.isArray(value.messageIds)
    || Object.getPrototypeOf(value.messageIds) !== Array.prototype || !hasSingleArrayItem(value.messageIds)
    || !isSafePositiveInteger(value.messageIds[0])) {
    if (fromLedgerLine !== undefined) throw ledgerSchemaError(fromLedgerLine)
    throw new PersonalFeedScopeInputError('personal Feed v2 delivery receipt is invalid')
  }
  return deepFreeze(value as unknown as PersonalFeedV2Receipt)
}

function hasSingleArrayItem(value: readonly unknown[]): boolean {
  const keys = Reflect.ownKeys(value)
  return value.length === 1 && keys.length === 2 && keys.includes('length') && keys.includes('0')
}

function parseR4(value: unknown): { readonly snapshot: unknown } | undefined {
  if (!isRecord(value)) return undefined
  if (value.kind !== 'sufficient' || !hasExactlyKeys(value, ['kind', 'snapshot'])) return undefined
  return { snapshot: value.snapshot }
}

function parseR2(value: unknown): ParsedR2 | undefined {
  const record = plainRecord(value, ['kind', 'window', 'close'])
  const close = record?.get('close')
  if (record?.get('kind') !== 'complete' || typeof close !== 'function') return undefined
  return {
    window: record.get('window'),
    receiver: value as object,
    close: close as ParsedR2['close'],
  }
}

type CandidateIncompleteReason = PersonalFeedV2R5CandidateIncompleteReason

type CandidateJudgment = 'qualified' | 'not_qualified'

interface OwnerCandidateCursor {
  readonly owner: object
  readonly borrowCurrent: (input: unknown) => unknown
  readonly finalize: (claim: unknown) => unknown
  readonly close: (reason: string) => unknown
}

interface OwnerCandidateLease {
  readonly owner: object
  readonly stableId: string
  readonly canonicalUrl: string
  readonly position: number
  readonly body: string
  readonly provenance: PersonalFeedV2R5CandidateProvenance
  readonly completeCurrent: (input: unknown) => unknown
}

interface CandidateCompletionReceipt {
  readonly kind: 'candidate_judgment_completed'
  readonly stableId: string
  readonly requestId: string
  readonly position: number
  readonly judgment: CandidateJudgment
  readonly completedAt: string
}

interface TrackedLease {
  readonly ownerLease: OwnerCandidateLease
  readonly judgeLease: PersonalFeedV2R5CandidateLease
  readonly judgeBorrow: { readonly kind: 'candidate'; readonly lease: PersonalFeedV2R5CandidateLease }
  receipt?: CandidateCompletionReceipt
  judgment?: CandidateJudgment
}

interface CandidateTracker {
  readonly candidates: PersonalFeedV2R5CandidateCursor
  readonly receipts: readonly CandidateCompletionReceipt[]
  readonly leases: readonly TrackedLease[]
  readonly valid: () => boolean
  readonly sawDone: () => boolean
  readonly failureReason: () => 'failed' | 'aborted' | undefined
}

type ParsedFinalization =
  | {
      readonly kind: 'selected'
      readonly selected: {
        readonly stableId: string
        readonly canonicalUrl: string
        readonly position: number
      }
    }
  | { readonly kind: 'none' }
  | { readonly kind: 'incomplete'; readonly reason: CandidateIncompleteReason }

function parseR3(
  value: unknown,
): { readonly kind: 'admitted'; readonly cursor: OwnerCandidateCursor }
  | { readonly kind: 'salvage'; readonly receiver: object; readonly close: (reason: string) => unknown }
  | { readonly kind: 'incomplete'; readonly reason: CandidateIncompleteReason }
  | undefined {
  const record = plainRecord(value, ['kind', 'cursor'])
  if (record?.get('kind') === 'admitted') {
    const rawCursor = record.get('cursor')
    const cursor = parseOwnerCursor(rawCursor)
    if (cursor !== undefined) return { kind: 'admitted', cursor }
    const salvage = parseCleanupOnlyCursor(rawCursor)
    return salvage === undefined ? undefined : { kind: 'salvage', ...salvage }
  }
  return parseOwnerIncomplete(value)
}

function parseOwnerCursor(value: unknown): OwnerCandidateCursor | undefined {
  const record = plainRecord(value, ['borrowCurrent', 'finalize', 'close'])
  const borrowCurrent = record?.get('borrowCurrent')
  const finalize = record?.get('finalize')
  const close = record?.get('close')
  if (record === undefined || typeof borrowCurrent !== 'function'
    || typeof finalize !== 'function' || typeof close !== 'function') return undefined
  return {
    owner: value as object,
    borrowCurrent: borrowCurrent as OwnerCandidateCursor['borrowCurrent'],
    finalize: finalize as OwnerCandidateCursor['finalize'],
    close: close as OwnerCandidateCursor['close'],
  }
}

function parseCleanupOnlyCursor(value: unknown): { readonly receiver: object; readonly close: (reason: string) => unknown } | undefined {
  const record = descriptorSafeRecord(value)
  const close = record?.get('close')
  if (record === undefined || typeof close !== 'function') return undefined
  return { receiver: value as object, close: close as (reason: string) => unknown }
}

async function coordinateCandidateJudgement(
  ownerCursor: OwnerCandidateCursor,
  cursorAuthority: CleanupAuthority,
  cleanupRegistry: CleanupAuthorityRegistry,
  request: PersonalFeedV2Request,
  snapshot: unknown,
  r5: PersonalFeedV2R5Port,
  signal: AbortSignal,
): Promise<PersonalFeedV2Outcome> {
  const tracker = createCandidateTracker(ownerCursor, request, signal)
  let rawClaim: unknown
  let judgeResolved = false
  if (!signal.aborted) {
    try {
      rawClaim = await r5.judge({ request, snapshot, candidates: tracker.candidates, signal })
      judgeResolved = true
    } catch {
      // A failed judge has no authority to invent receipts or a terminal result.
    }
  }

  const failureReason = signal.aborted
    ? 'aborted'
    : tracker.failureReason() ?? (judgeResolved ? undefined : 'failed')
  const claim = failureReason === undefined
    ? rawClaim
    : Object.freeze({
        kind: 'incomplete' as const,
        completed: Object.freeze([...tracker.receipts]),
        reason: failureReason,
      })

  let rawFinalization: unknown
  try {
    rawFinalization = await Reflect.apply(ownerCursor.finalize, ownerCursor.owner, [claim])
  } catch {
    await cleanupRegistry.attempt(cursorAuthority)
    return incomplete('judgement_execution', JUDGEMENT_EXECUTION_TEXT)
  }
  const finalization = parseFinalization(rawFinalization)
  if (finalization === undefined) {
    await cleanupRegistry.attempt(cursorAuthority)
    return incomplete('judgement_execution', JUDGEMENT_EXECUTION_TEXT)
  }
  if (finalization.kind === 'incomplete') {
    await cleanupRegistry.attempt(cursorAuthority)
    return incomplete('judgement_execution', JUDGEMENT_EXECUTION_TEXT)
  }
  if (finalization.kind === 'none') {
    if (!isProvenNone(tracker)) {
      await cleanupRegistry.attempt(cursorAuthority)
      return incomplete('judgement_execution', JUDGEMENT_EXECUTION_TEXT)
    }
    const closed = await cleanupRegistry.attempt(cursorAuthority)
    if (!closed || signal.aborted) return incomplete('judgement_execution', JUDGEMENT_EXECUTION_TEXT)
    return makeOutcome('business_empty', BUSINESS_EMPTY_TEXT)
  }
  if (!isProvenSelection(finalization.selected, tracker)) {
    await cleanupRegistry.attempt(cursorAuthority)
    return incomplete('judgement_execution', JUDGEMENT_EXECUTION_TEXT)
  }
  const closed = await cleanupRegistry.attempt(cursorAuthority)
  if (!closed || signal.aborted) return incomplete('judgement_execution', JUDGEMENT_EXECUTION_TEXT)
  return makeOutcome('one_link', finalization.selected.canonicalUrl)
}

function createCandidateTracker(
  ownerCursor: OwnerCandidateCursor,
  request: PersonalFeedV2Request,
  signal: AbortSignal,
): CandidateTracker {
  const receipts: CandidateCompletionReceipt[] = []
  const leases: TrackedLease[] = []
  let activeLease: TrackedLease | undefined
  let trackerValid = true
  let trackerSawDone = false
  let trackerFailure: 'failed' | 'aborted' | undefined

  const fail = (reason: 'failed' | 'aborted'): void => {
    trackerValid = false
    if (trackerFailure === undefined || reason === 'aborted') trackerFailure = reason
  }
  const operationError = (): Error => new Error('personal Feed candidate operation failed')

  const complete = async (tracked: TrackedLease, input: unknown): Promise<unknown> => {
    const parsedInput = plainRecord(input, ['judgment'])
    const judgment = parsedInput?.get('judgment')
    if (parsedInput === undefined || (judgment !== 'qualified' && judgment !== 'not_qualified')) {
      fail(signal.aborted ? 'aborted' : 'failed')
      throw operationError()
    }

    let ownerResult: unknown
    try {
      ownerResult = await Reflect.apply(tracked.ownerLease.completeCurrent, tracked.ownerLease.owner, [
        Object.freeze({ judgment }),
      ])
    } catch {
      fail(signal.aborted ? 'aborted' : 'failed')
      throw operationError()
    }

    const ownerIncomplete = parseOwnerIncomplete(ownerResult)
    if (ownerIncomplete !== undefined) {
      if (tracked.receipt !== undefined && tracked.judgment !== judgment) fail('failed')
      fail(signal.aborted || ownerIncomplete.reason === 'aborted' ? 'aborted' : 'failed')
      return Object.freeze({ kind: 'incomplete' as const, reason: ownerIncomplete.reason })
    }

    const receipt = parseCompletionReceipt(ownerResult)
    if (receipt === undefined
      || receipt.stableId !== tracked.ownerLease.stableId
      || receipt.requestId !== request.requestId
      || receipt.position !== tracked.ownerLease.position
      || receipt.judgment !== judgment) {
      fail(signal.aborted ? 'aborted' : 'failed')
      throw operationError()
    }

    if (tracked.receipt !== undefined) {
      if (tracked.judgment !== judgment || tracked.receipt !== receipt) {
        fail(signal.aborted ? 'aborted' : 'failed')
        throw operationError()
      }
      return receipt
    }
    if (activeLease !== tracked || receipt.position !== receipts.length) {
      fail(signal.aborted ? 'aborted' : 'failed')
      throw operationError()
    }
    tracked.receipt = receipt
    tracked.judgment = judgment
    receipts.push(receipt)
    activeLease = undefined
    if (signal.aborted) fail('aborted')
    return receipt
  }

  const borrowCurrent = async (input: unknown): Promise<PersonalFeedV2R5CandidateBorrowResult> => {
    const parsedInput = plainRecord(input, ['signal'])
    if (parsedInput === undefined || parsedInput.get('signal') !== signal || !trackerValid) {
      fail(signal.aborted ? 'aborted' : 'failed')
      throw operationError()
    }

    let ownerResult: unknown
    try {
      ownerResult = await Reflect.apply(ownerCursor.borrowCurrent, ownerCursor.owner, [
        Object.freeze({ signal }),
      ])
    } catch {
      fail(signal.aborted ? 'aborted' : 'failed')
      throw operationError()
    }

    const incompleteResult = parseOwnerIncomplete(ownerResult)
    if (incompleteResult !== undefined) {
      fail(signal.aborted || incompleteResult.reason === 'aborted' ? 'aborted' : 'failed')
      return Object.freeze({ kind: 'incomplete' as const, reason: incompleteResult.reason })
    }

    const result = plainRecord(ownerResult, ['kind'])
    if (result?.get('kind') === 'done') {
      if (activeLease !== undefined) {
        fail(signal.aborted ? 'aborted' : 'failed')
        throw operationError()
      }
      trackerSawDone = true
      if (signal.aborted) fail('aborted')
      return Object.freeze({ kind: 'done' as const })
    }

    const candidate = plainRecord(ownerResult, ['kind', 'lease'])
    const ownerLease = candidate?.get('kind') === 'candidate'
      ? parseOwnerLease(candidate.get('lease'))
      : undefined
    if (ownerLease === undefined || trackerSawDone) {
      fail(signal.aborted ? 'aborted' : 'failed')
      throw operationError()
    }
    if (activeLease !== undefined) {
      if (activeLease.ownerLease.owner !== ownerLease.owner) {
        fail(signal.aborted ? 'aborted' : 'failed')
        throw operationError()
      }
      if (signal.aborted) fail('aborted')
      return activeLease.judgeBorrow
    }
    if (ownerLease.position !== leases.length
      || leases.some(existing => existing.ownerLease.owner === ownerLease.owner
        || existing.ownerLease.stableId === ownerLease.stableId
        || existing.ownerLease.canonicalUrl === ownerLease.canonicalUrl)) {
      fail(signal.aborted ? 'aborted' : 'failed')
      throw operationError()
    }

    let tracked!: TrackedLease
    const judgeLease: PersonalFeedV2R5CandidateLease = Object.freeze({
      stableId: ownerLease.stableId,
      canonicalUrl: ownerLease.canonicalUrl,
      position: ownerLease.position,
      body: ownerLease.body,
      provenance: ownerLease.provenance,
      completeCurrent: (input: { readonly judgment: CandidateJudgment }) => complete(tracked, input),
    })
    const judgeBorrow = Object.freeze({ kind: 'candidate' as const, lease: judgeLease })
    tracked = { ownerLease, judgeLease, judgeBorrow }
    leases.push(tracked)
    activeLease = tracked
    if (signal.aborted) fail('aborted')
    return judgeBorrow
  }

  return {
    candidates: Object.freeze({ borrowCurrent }),
    receipts,
    leases,
    valid: () => trackerValid,
    sawDone: () => trackerSawDone,
    failureReason: () => trackerFailure,
  }
}

function parseOwnerLease(value: unknown): OwnerCandidateLease | undefined {
  const record = plainRecord(value, [
    'stableId', 'canonicalUrl', 'position', 'body', 'provenance', 'completeCurrent',
  ])
  const stableId = record?.get('stableId')
  const canonicalUrl = record?.get('canonicalUrl')
  const position = record?.get('position')
  const body = record?.get('body')
  const completeCurrent = record?.get('completeCurrent')
  const provenance = parseCandidateProvenance(record?.get('provenance'))
  if (record === undefined || typeof stableId !== 'string' || typeof canonicalUrl !== 'string'
    || !isDensePosition(position) || typeof body !== 'string' || body.trim() === ''
    || typeof completeCurrent !== 'function' || provenance === undefined
    || provenance.canonicalUrl !== canonicalUrl || !isMatchingStatusIdentity(stableId, canonicalUrl)) return undefined
  return {
    owner: value as object,
    stableId,
    canonicalUrl,
    position,
    body,
    provenance,
    completeCurrent: completeCurrent as OwnerCandidateLease['completeCurrent'],
  }
}

function parseCandidateProvenance(value: unknown): PersonalFeedV2R5CandidateProvenance | undefined {
  const record = plainRecord(value, [
    'capturedAt', 'surface', 'surfaceOrdinal', 'occurrenceOrdinal', 'canonicalUrl', 'authorHandle', 'publishedAt',
  ])
  const capturedAt = record?.get('capturedAt')
  const surface = record?.get('surface')
  const surfaceOrdinal = record?.get('surfaceOrdinal')
  const occurrenceOrdinal = record?.get('occurrenceOrdinal')
  const canonicalUrl = record?.get('canonicalUrl')
  const authorHandle = record?.get('authorHandle')
  const publishedAt = record?.get('publishedAt')
  if (record === undefined || !isValidIso(capturedAt) || !isValidIso(publishedAt)
    || (surface !== 'for_you' && surface !== 'following' && surface !== 'explore')
    || !isDensePosition(surfaceOrdinal) || surfaceOrdinal > 2 || !isDensePosition(occurrenceOrdinal)
    || typeof canonicalUrl !== 'string' || canonicalizeXStatusIdentity(canonicalUrl) !== canonicalUrl
    || typeof authorHandle !== 'string' || authorHandle.trim() === '') return undefined
  const expectedSurfaceOrdinal = surface === 'for_you' ? 0 : surface === 'following' ? 1 : 2
  if (surfaceOrdinal !== expectedSurfaceOrdinal) return undefined
  return Object.freeze({
    capturedAt,
    surface,
    surfaceOrdinal,
    occurrenceOrdinal,
    canonicalUrl,
    authorHandle,
    publishedAt,
  })
}

function parseCompletionReceipt(value: unknown): CandidateCompletionReceipt | undefined {
  const record = plainRecord(value, [
    'kind', 'stableId', 'requestId', 'position', 'judgment', 'completedAt',
  ])
  const stableId = record?.get('stableId')
  const requestId = record?.get('requestId')
  const position = record?.get('position')
  const judgment = record?.get('judgment')
  const completedAt = record?.get('completedAt')
  let frozen = false
  try {
    frozen = Object.isFrozen(value)
  } catch {
    return undefined
  }
  if (!frozen || record?.get('kind') !== 'candidate_judgment_completed'
    || typeof stableId !== 'string' || !/^x-status:[1-9][0-9]*$/.test(stableId)
    || typeof requestId !== 'string' || !isDensePosition(position)
    || (judgment !== 'qualified' && judgment !== 'not_qualified') || !isValidIso(completedAt)) return undefined
  return value as CandidateCompletionReceipt
}

function parseOwnerIncomplete(
  value: unknown,
): { readonly kind: 'incomplete'; readonly reason: CandidateIncompleteReason } | undefined {
  const record = plainRecord(value, ['kind', 'reason'])
  const reason = record?.get('reason')
  return record?.get('kind') !== 'incomplete' || !isCandidateIncompleteReason(reason)
    ? undefined
    : Object.freeze({ kind: 'incomplete', reason })
}

function parseFinalization(value: unknown): ParsedFinalization | undefined {
  const incompleteResult = parseOwnerIncomplete(value)
  if (incompleteResult !== undefined) return incompleteResult
  const none = plainRecord(value, ['kind'])
  if (none?.get('kind') === 'none') return Object.freeze({ kind: 'none' })
  const record = plainRecord(value, ['kind', 'selected'])
  if (record?.get('kind') !== 'selected') return undefined
  const selected = plainRecord(record.get('selected'), ['stableId', 'canonicalUrl', 'position'])
  const stableId = selected?.get('stableId')
  const canonicalUrl = selected?.get('canonicalUrl')
  const position = selected?.get('position')
  if (selected === undefined || typeof stableId !== 'string' || typeof canonicalUrl !== 'string'
    || !isDensePosition(position) || !isMatchingStatusIdentity(stableId, canonicalUrl)) return undefined
  return Object.freeze({
    kind: 'selected',
    selected: Object.freeze({ stableId, canonicalUrl, position }),
  })
}

function createCleanupAuthorityRegistry(): CleanupAuthorityRegistry {
  const authorities = new Set<CleanupAuthority>()
  let sealed = false
  let drainPromise: Promise<void> | undefined

  const register = (receiver: object, close: (reason: string) => unknown): CleanupAuthority => {
    const authority: CleanupAuthority = {
      receiver,
      close,
      args: ['coordinator_incomplete'],
      state: 'ready',
      promise: undefined,
    }
    authorities.add(authority)
    return authority
  }

  const wait = async (promise: Promise<boolean>): Promise<boolean> => {
    const timeout = new Promise<'timeout'>(resolve => {
      setTimeout(() => resolve('timeout'), CLEANUP_WAIT_MS)
    })
    const result = await Promise.race([promise, timeout])
    return result === true
  }

  const startAttempt = (authority: CleanupAuthority): Promise<boolean> => {
    if (authority.state === 'closing') {
      return authority.promise ?? Promise.resolve(false)
    }
    if (authority.state === 'retained') authority.state = 'ready'

    authority.state = 'closing'
    let result: unknown
    try {
      result = Reflect.apply(authority.close, authority.receiver, authority.args)
    } catch {
      authority.state = 'retained'
      return Promise.resolve(false)
    }
    const completion = Promise.resolve(result).then(
      () => {
        authorities.delete(authority)
        authority.promise = undefined
        return true
      },
      () => {
        authority.state = 'retained'
        authority.promise = undefined
        return false
      },
    )
    authority.promise = completion
    return completion
  }

  const attempt = async (authority: CleanupAuthority): Promise<boolean> => {
    return wait(startAttempt(authority))
  }

  const retry = async (): Promise<boolean> => {
    await Promise.all([...authorities]
      .filter(authority => authority.state !== 'ready')
      .map(authority => attempt(authority)))
    return authorities.size !== 0
  }

  const isSealed = (): boolean => sealed

  const sealAndDrain = (): Promise<void> => {
    if (drainPromise !== undefined) return drainPromise
    sealed = true
    const snapshot = [...authorities]
    const drain = (async (): Promise<void> => {
      const results = await Promise.allSettled(snapshot.map(authority => {
        try {
          return startAttempt(authority)
        } catch {
          return Promise.reject(cleanupDrainError())
        }
      }))
      const failed = results.some(result => result.status === 'rejected'
        || (result.status === 'fulfilled' && !result.value))
      const remaining = authorities.size
      authorities.clear()
      snapshot.length = 0
      if (failed || remaining !== 0) throw cleanupDrainError()
    })()
    drainPromise = drain
    void drain.catch(() => undefined)
    return drain
  }

  return { register, isSealed, retry, attempt, sealAndDrain }
}

function isProvenSelection(
  selected: { readonly stableId: string; readonly canonicalUrl: string; readonly position: number },
  tracker: CandidateTracker,
): boolean {
  if (!tracker.valid() || tracker.receipts.length === 0
    || tracker.leases.length !== tracker.receipts.length) return false
  const lastReceipt = tracker.receipts.at(-1)
  if (lastReceipt === undefined || lastReceipt.judgment !== 'qualified'
    || tracker.receipts.slice(0, -1).some(receipt => receipt.judgment !== 'not_qualified')
    || tracker.receipts.filter(receipt => receipt.judgment === 'qualified').length !== 1
    || selected.stableId !== lastReceipt.stableId || selected.position !== lastReceipt.position) return false
  const lease = tracker.leases[selected.position]?.ownerLease
  return lease !== undefined && lease.stableId === selected.stableId
    && lease.position === selected.position && lease.canonicalUrl === selected.canonicalUrl
    && canonicalizeXStatusIdentity(selected.canonicalUrl) === selected.canonicalUrl
}

function isProvenNone(tracker: CandidateTracker): boolean {
  return tracker.valid() && tracker.sawDone()
    && tracker.leases.length === tracker.receipts.length
    && tracker.receipts.every(receipt => receipt.judgment === 'not_qualified')
}

function plainRecord(value: unknown, expected: readonly string[]): ReadonlyMap<string, unknown> | undefined {
  const record = descriptorSafeRecord(value)
  if (record === undefined) return undefined
  const sortedExpected = [...expected].sort()
  const actual = [...record.keys()].sort()
  if (actual.length !== sortedExpected.length
    || !actual.every((key, index) => key === sortedExpected[index])) return undefined
  return record
}

function descriptorSafeRecord(value: unknown): ReadonlyMap<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  let prototype: object | null
  let keys: readonly PropertyKey[]
  try {
    if (nodeTypes.isProxy(value) || Array.isArray(value)) return undefined
    prototype = Object.getPrototypeOf(value) as object | null
    keys = Reflect.ownKeys(value)
  } catch {
    return undefined
  }
  if (prototype !== Object.prototype && prototype !== null) return undefined
  const result = new Map<string, unknown>()
  for (const key of keys) {
    if (typeof key !== 'string') return undefined
    let descriptor: PropertyDescriptor | undefined
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key)
    } catch {
      return undefined
    }
    if (descriptor === undefined || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      return undefined
    }
    result.set(key, descriptor.value)
  }
  return result
}

function isMatchingStatusIdentity(stableId: string, canonicalUrl: string): boolean {
  const canonical = canonicalizeXStatusIdentity(canonicalUrl)
  if (canonical !== canonicalUrl) return false
  const match = /\/status\/([1-9][0-9]*)$/.exec(canonicalUrl)
  return match !== null && stableId === `x-status:${match[1]}`
}

function isDensePosition(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
}

function isCandidateIncompleteReason(value: unknown): value is CandidateIncompleteReason {
  return value === 'aborted' || value === 'body_failed' || value === 'body_insufficient'
    || value === 'body_unknown' || value === 'capture_failed' || value === 'clock_failed'
    || value === 'completion_claim_invalid' || value === 'completion_conflict'
    || value === 'completion_store_failed' || value === 'concurrent_reservation'
    || value === 'expired' || value === 'failed' || value === 'invalid_input'
    || value === 'processed_query_aborted' || value === 'processed_query_failed'
    || value === 'processed_query_unknown' || value === 'timeout' || value === 'unknown'
}

type PortCallResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false }

async function callPort(call: () => unknown | Promise<unknown>): Promise<PortCallResult> {
  try {
    const result = call()
    if (nodeTypes.isPromise(result)) {
      return Object.freeze({ ok: true as const, value: await result })
    }
    return Object.freeze({ ok: true as const, value: result })
  } catch {
    return Object.freeze({ ok: false as const })
  }
}

function makeOutcome(kind: 'one_link' | 'business_empty', finalText: string): PersonalFeedV2Outcome {
  const withoutDigest = { kind, finalText }
  return { ...withoutDigest, digest: digestFor(withoutDigest) } as PersonalFeedV2Outcome
}

function incomplete(category: PersonalFeedV2IncompleteCategory, finalText: string): PersonalFeedV2Outcome {
  const withoutDigest = { kind: 'incomplete' as const, category, finalText }
  return { ...withoutDigest, digest: digestFor(withoutDigest) }
}

function incompleteText(category: PersonalFeedV2IncompleteCategory): string {
  if (category === 'personal_context') return PERSONAL_CONTEXT_TEXT
  if (category === 'source_window') return SOURCE_WINDOW_TEXT
  return JUDGEMENT_EXECUTION_TEXT
}

function digestFor(value: unknown): string {
  const encoded = encodeCanonicalJson(value)
  if (encoded === undefined) throw new PersonalFeedScopeStoreError('personal Feed v2 outcome is not canonical JSON')
  return createHash('sha256').update(encoded).digest('hex')
}

function publicRequest(record: RequestOpenedRecord): PersonalFeedV2Request {
  return { requestId: record.requestId, cutoff: record.request.cutoff, shanghaiDay: record.request.shanghaiDay }
}

export function personalFeedV2TelegramRequestId(chatId: number, messageId: number): string {
  if (!Number.isSafeInteger(chatId) || chatId === 0) {
    throw new TypeError('personal Feed Telegram chat id must be a non-zero safe integer')
  }
  if (!Number.isSafeInteger(messageId) || messageId <= 0) {
    throw new TypeError('personal Feed Telegram message id must be a positive safe integer')
  }
  return `telegram:${chatId}:${messageId}`
}

function shanghaiDay(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date)
  const values = new Map(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]))
  const year = values.get('year')
  const month = values.get('month')
  const day = values.get('day')
  if (year === undefined || month === undefined || day === undefined) {
    throw new PersonalFeedScopeStoreError('personal Feed v2 request Shanghai day could not be determined')
  }
  return `${year}-${month}-${day}`
}

function isValidIso(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false
  const date = new Date(value)
  return !Number.isNaN(date.getTime()) && date.toISOString() === value
}

function isValidShanghaiDay(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime())) return false
  const [year, month, day] = value.split('-').map(Number)
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function isIncompleteCategory(value: unknown): value is PersonalFeedV2IncompleteCategory {
  return value === 'personal_context' || value === 'source_window' || value === 'judgement_execution'
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

function isSafePositiveInteger(value: unknown): value is number {
  return isSafeInteger(value) && value > 0
}

function isAbortSignal(value: unknown): value is AbortSignal {
  if (typeof value !== 'object' || value === null) return false
  const signal = value as {
    readonly aborted?: unknown
    readonly addEventListener?: unknown
    readonly removeEventListener?: unknown
  }
  return typeof signal.aborted === 'boolean'
    && typeof signal.addEventListener === 'function'
    && typeof signal.removeEventListener === 'function'
}

function appendLedger(path: string, records: readonly unknown[], record: unknown): void {
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  chmodSync(directory, 0o700)
  appendJsonLine(path, records, record)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactlyKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const ownKeys = Reflect.ownKeys(value)
  if (ownKeys.some(key => typeof key !== 'string')) return false
  const actual = (ownKeys as string[]).sort()
  const sortedExpected = [...expected].sort()
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index])
}

function canonical(value: unknown): string {
  const encoded = encodeCanonicalJson(value)
  if (encoded === undefined) throw new PersonalFeedScopeStoreError('personal Feed v2 ledger record is not canonical JSON')
  return encoded
}

function ledgerSchemaError(lineNumber: number): PersonalFeedScopeStoreError {
  return new PersonalFeedScopeStoreError(`personal Feed v2 request ledger line ${lineNumber} has an unsupported schema`)
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  return value
}
