import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
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
  readonly candidates: unknown
  readonly signal: AbortSignal
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

export function createPersonalFeedV2RequestCoordinator(
  options: CreatePersonalFeedV2RequestCoordinatorOptions,
): PersonalFeedV2RequestCoordinator {
  if (options.ledgerPath.trim() === '') {
    throw new PersonalFeedScopeStoreError('personal Feed v2 request ledger path must be non-empty')
  }

  const readLedger = (): ParsedLedger => parseLedger(options.ledgerPath)

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
    const r4 = input.signal.aborted
      ? undefined
      : await callPort(() => options.r4.snapshot({ request: publicRequest(opened), signal: input.signal }))
    if (r4 === undefined || input.signal.aborted) {
      outcome = incomplete('personal_context', PERSONAL_CONTEXT_TEXT)
    } else {
      const r4Result = parseR4(r4)
      if (r4Result === undefined) {
        outcome = incomplete('personal_context', PERSONAL_CONTEXT_TEXT)
      } else {
        const r2 = input.signal.aborted
          ? undefined
          : await callPort(() => options.r2.observe({ request: publicRequest(opened), signal: input.signal }))
        if (r2 === undefined || input.signal.aborted) {
          outcome = incomplete('source_window', SOURCE_WINDOW_TEXT)
        } else {
          const r2Result = parseR2(r2)
          if (r2Result === undefined) {
            outcome = incomplete('source_window', SOURCE_WINDOW_TEXT)
          } else {
            const r3 = input.signal.aborted
              ? undefined
              : await callPort(() => options.r3.admit({ request: publicRequest(opened), window: r2Result.window, signal: input.signal }))
            if (r3 === undefined || input.signal.aborted) {
              outcome = incomplete('judgement_execution', JUDGEMENT_EXECUTION_TEXT)
            } else {
              const r3Result = parseR3(r3)
              if (r3Result === undefined) {
                outcome = incomplete('judgement_execution', JUDGEMENT_EXECUTION_TEXT)
              } else {
                const r5 = input.signal.aborted
                  ? undefined
                  : await callPort(() => options.r5.judge({ request: publicRequest(opened), snapshot: r4Result.snapshot, candidates: r3Result.candidates, signal: input.signal }))
                if (r5 === undefined || input.signal.aborted) {
                  outcome = incomplete('judgement_execution', JUDGEMENT_EXECUTION_TEXT)
                } else {
                  const r5Result = parseR5(r5)
                  if (r5Result === undefined) {
                    outcome = incomplete('judgement_execution', JUDGEMENT_EXECUTION_TEXT)
                  } else if (r5Result.kind === 'none') {
                    outcome = makeOutcome('business_empty', BUSINESS_EMPTY_TEXT)
                  } else {
                    const finalText = canonicalizeXStatusIdentity(r5Result.url)
                    outcome = finalText === undefined
                      ? incomplete('judgement_execution', JUDGEMENT_EXECUTION_TEXT)
                      : makeOutcome('one_link', finalText)
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

  return Object.freeze({ prepare, read })
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

function parseR2(value: unknown): { readonly window: unknown } | undefined {
  if (!isRecord(value)) return undefined
  if (value.kind !== 'complete' || !hasExactlyKeys(value, ['kind', 'window'])) return undefined
  return { window: value.window }
}

function parseR3(value: unknown): { readonly candidates: unknown } | undefined {
  if (!isRecord(value)) return undefined
  if (value.kind !== 'admitted' || !hasExactlyKeys(value, ['kind', 'candidates'])) return undefined
  return { candidates: value.candidates }
}

function parseR5(value: unknown): { readonly kind: 'one_link'; readonly url: string } | { readonly kind: 'none' } | undefined {
  if (!isRecord(value)) return undefined
  if (value.kind === 'none' && hasExactlyKeys(value, ['kind'])) return { kind: 'none' }
  if (value.kind === 'one_link' && hasExactlyKeys(value, ['kind', 'url']) && typeof value.url === 'string') {
    return { kind: 'one_link', url: value.url }
  }
  return undefined
}

async function callPort(call: () => unknown | Promise<unknown>): Promise<unknown | undefined> {
  try {
    return await call()
  } catch {
    return undefined
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
