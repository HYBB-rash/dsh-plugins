import { PersonalFeedScopeInputError, PersonalFeedScopeStoreError } from '../errors.ts'
import { canonicalizeXStatusIdentity } from './x-status-identity.ts'
import type {
  PersonalFeedV2CandidateForJudgment,
  PersonalFeedV2CandidateJudgmentResult,
  PersonalFeedV2CandidateStateInput,
  PersonalFeedV2CandidateStateResult,
} from './candidate-state-owner.ts'

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

export type PersonalFeedV2R3Input = PersonalFeedV2CandidateStateInput

export interface PersonalFeedV2R5Input {
  readonly request: PersonalFeedV2Request
  readonly snapshot: unknown
  readonly candidate: PersonalFeedV2CandidateForJudgment
  readonly signal: AbortSignal
}

export interface PersonalFeedV2R4Port {
  readonly snapshot: (input: PersonalFeedV2R4Input) => unknown | Promise<unknown>
}

export interface PersonalFeedV2R2Port {
  readonly observe: (input: PersonalFeedV2R2Input) => unknown | Promise<unknown>
}

export interface PersonalFeedV2R3Port {
  readonly evaluate: (input: PersonalFeedV2CandidateStateInput) => PersonalFeedV2CandidateStateResult | Promise<PersonalFeedV2CandidateStateResult>
}

export interface PersonalFeedV2R5Port {
  readonly judgeOne: (input: PersonalFeedV2R5Input) => PersonalFeedV2CandidateJudgmentResult | Promise<PersonalFeedV2CandidateJudgmentResult>
}

export interface CreatePersonalFeedV2RequestCoordinatorOptions {
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

export type PersonalFeedV2IncompleteCategory = 'personal_context' | 'source_window' | 'judgement_execution'

export type PersonalFeedV2Outcome =
  | { readonly kind: 'one_link'; readonly finalText: string }
  | { readonly kind: 'business_empty'; readonly finalText: string }
  | { readonly kind: 'incomplete'; readonly category: PersonalFeedV2IncompleteCategory; readonly finalText: string }

export interface PersonalFeedV2PreparedResult {
  readonly kind: 'prepared'
  readonly request: PersonalFeedV2Request
  readonly outcome: PersonalFeedV2Outcome
}

export type PersonalFeedV2PrepareResult = PersonalFeedV2PreparedResult

export interface PersonalFeedV2RequestCoordinator {
  readonly prepare: (input: PersonalFeedV2PrepareInput) => Promise<PersonalFeedV2PrepareResult>
}

type PlainRecord = Record<string, unknown>
type ParsedR2 = Readonly<{ readonly window: unknown; readonly receiver: object; readonly close: () => unknown }>

const PERSONAL_CONTEXT_TEXT = '这次没有完成：个人语境不足或未完成。'
const SOURCE_WINDOW_TEXT = '这次没有完成：X 来源或观察窗口未完成。'
const JUDGEMENT_EXECUTION_TEXT = '这次没有完成：判断或执行未完成。'
const BUSINESS_EMPTY_TEXT = '这次没有值得看的内容。'

function isRecord(value: unknown): value is PlainRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exact(value: PlainRecord, keys: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value)
  return actual.length === keys.length && actual.every(key => typeof key === 'string' && keys.includes(key))
}

function isPort(value: unknown, method: string): boolean {
  return isRecord(value) && typeof value[method] === 'function'
}

function incomplete(category: PersonalFeedV2IncompleteCategory): PersonalFeedV2Outcome {
  const finalText = category === 'personal_context'
    ? PERSONAL_CONTEXT_TEXT
    : category === 'source_window'
      ? SOURCE_WINDOW_TEXT
      : JUDGEMENT_EXECUTION_TEXT
  return Object.freeze({ kind: 'incomplete', category, finalText })
}

function parseR4(value: unknown): Readonly<{ readonly snapshot: unknown }> | undefined {
  if (!isRecord(value) || !exact(value, ['kind', 'snapshot']) || value.kind !== 'sufficient' || value.snapshot === undefined) return undefined
  return Object.freeze({ snapshot: value.snapshot })
}

function parseR2(value: unknown): ParsedR2 | undefined {
  if (!isRecord(value) || !exact(value, ['kind', 'window', 'close']) || value.kind !== 'complete' || typeof value.close !== 'function') return undefined
  return Object.freeze({ window: value.window, receiver: value, close: value.close as () => unknown })
}

function parseR3(value: unknown): PersonalFeedV2CandidateStateResult | undefined {
  if (!isRecord(value)) return undefined
  if ((value.kind === 'none' || value.kind === 'incomplete') && exact(value, ['kind'])) {
    return Object.freeze({ kind: value.kind }) as PersonalFeedV2CandidateStateResult
  }
  if (value.kind !== 'selected' || !exact(value, ['kind', 'stableId', 'canonicalUrl'])
    || typeof value.stableId !== 'string' || typeof value.canonicalUrl !== 'string') return undefined
  const canonical = canonicalizeXStatusIdentity(value.canonicalUrl)
  const statusId = canonical?.split('/')[5]
  if (canonical !== value.canonicalUrl || statusId === undefined || value.stableId !== `x-status:${statusId}`) return undefined
  return Object.freeze({ kind: 'selected', stableId: value.stableId, canonicalUrl: value.canonicalUrl })
}

function readNow(clock: PersonalFeedV2Clock): Date {
  let value: Date
  try {
    value = clock.now()
  } catch (cause) {
    throw new PersonalFeedScopeStoreError('personal Feed v2 request clock failed', { cause })
  }
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new PersonalFeedScopeStoreError('personal Feed v2 request clock did not return a valid Date')
  }
  return new Date(value.getTime())
}

function validatePrepareInput(input: unknown): asserts input is PersonalFeedV2PrepareInput {
  if (!isRecord(input) || !exact(input, ['chatId', 'messageId', 'signal'])
    || !Number.isSafeInteger(input.chatId) || input.chatId === 0
    || !Number.isSafeInteger(input.messageId) || (input.messageId as number) <= 0
    || !(input.signal instanceof AbortSignal)) {
    throw new PersonalFeedScopeInputError('personal Feed v2 request input is invalid')
  }
}

function shanghaiDay(value: Date): string {
  return new Date(value.getTime() + 8 * 60 * 60 * 1_000).toISOString().slice(0, 10)
}

export function personalFeedV2TelegramRequestId(chatId: number, messageId: number): string {
  if (!Number.isSafeInteger(chatId) || chatId === 0 || !Number.isSafeInteger(messageId) || messageId <= 0) {
    throw new PersonalFeedScopeInputError('personal Feed v2 Telegram request identity is invalid')
  }
  return `telegram:${chatId}:${messageId}`
}

export function createPersonalFeedV2RequestCoordinator(options: CreatePersonalFeedV2RequestCoordinatorOptions): PersonalFeedV2RequestCoordinator {
  if (!isRecord(options) || !exact(options, ['clock', 'r4', 'r2', 'r3', 'r5'])
    || !isPort(options.clock, 'now') || !isPort(options.r4, 'snapshot') || !isPort(options.r2, 'observe')
    || !isPort(options.r3, 'evaluate') || !isPort(options.r5, 'judgeOne')) {
    throw new PersonalFeedScopeInputError('personal Feed v2 request coordinator options are invalid')
  }

  const prepare = async (rawInput: PersonalFeedV2PrepareInput): Promise<PersonalFeedV2PrepareResult> => {
    validatePrepareInput(rawInput)
    const now = readNow(options.clock)
    const request = Object.freeze({
      requestId: personalFeedV2TelegramRequestId(rawInput.chatId, rawInput.messageId),
      cutoff: now.toISOString(),
      shanghaiDay: shanghaiDay(now),
    })
    let outcome: PersonalFeedV2Outcome
    if (rawInput.signal.aborted) {
      outcome = incomplete('personal_context')
    } else {
      let r4Raw: unknown
      try {
        r4Raw = await options.r4.snapshot(Object.freeze({ request, signal: rawInput.signal }))
      } catch {
        r4Raw = undefined
      }
      const r4 = rawInput.signal.aborted ? undefined : parseR4(r4Raw)
      if (r4 === undefined) {
        outcome = incomplete('personal_context')
      } else {
        let r2Raw: unknown
        try {
          r2Raw = await options.r2.observe(Object.freeze({ request, signal: rawInput.signal }))
        } catch {
          r2Raw = undefined
        }
        const r2 = rawInput.signal.aborted ? undefined : parseR2(r2Raw)
        if (r2 === undefined) {
          outcome = incomplete('source_window')
        } else {
          let r3Raw: unknown
          try {
            r3Raw = await options.r3.evaluate(Object.freeze({
              request,
              window: r2.window,
              signal: rawInput.signal,
              judgeOne: (candidate: PersonalFeedV2CandidateForJudgment) => options.r5.judgeOne(Object.freeze({
                request,
                snapshot: r4.snapshot,
                candidate,
                signal: rawInput.signal,
              })),
            }))
          } catch {
            r3Raw = undefined
          }
          const r3 = rawInput.signal.aborted ? undefined : parseR3(r3Raw)
          outcome = r3?.kind === 'selected'
            ? Object.freeze({ kind: 'one_link', finalText: r3.canonicalUrl })
            : r3?.kind === 'none'
              ? Object.freeze({ kind: 'business_empty', finalText: BUSINESS_EMPTY_TEXT })
              : incomplete('judgement_execution')
          try {
            await Reflect.apply(r2.close, r2.receiver, [])
          } catch {
            outcome = incomplete('source_window')
          }
        }
      }
    }
    return Object.freeze({ kind: 'prepared', request, outcome })
  }

  Object.freeze(prepare)
  return Object.freeze({ prepare })
}
