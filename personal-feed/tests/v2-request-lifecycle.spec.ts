import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  canonicalizeXStatusIdentity,
  createPersonalFeedV2CandidateLifecycle,
  createPersonalFeedV2RequestCoordinator,
  personalFeedV2TelegramRequestId,
  type PersonalFeedV2CandidateCompletionReceipt,
  type PersonalFeedV2CandidateCursor,
  type PersonalFeedV2R2Input,
  type PersonalFeedV2R3Input,
  type PersonalFeedV2R4Input,
  type PersonalFeedV2R5Input,
  type PersonalFeedV2Request,
} from '../src/index.ts'

type Equal<Left, Right> = (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2) ? true : false
type Assert<Value extends true> = Value

type _RequestKeysAreExact = Assert<Equal<keyof PersonalFeedV2Request, 'requestId' | 'cutoff' | 'shanghaiDay'>>
type _R4InputKeysAreExact = Assert<Equal<keyof PersonalFeedV2R4Input, 'request' | 'signal'>>
type _R2InputKeysAreExact = Assert<Equal<keyof PersonalFeedV2R2Input, 'request' | 'signal'>>
type _R3InputKeysAreExact = Assert<Equal<keyof PersonalFeedV2R3Input, 'request' | 'window' | 'signal'>>
type _R5InputKeysAreExact = Assert<Equal<keyof PersonalFeedV2R5Input, 'request' | 'snapshot' | 'candidates' | 'signal'>>

type R4Result =
  | { readonly kind: 'sufficient'; readonly snapshot: unknown }
  | { readonly kind: 'insufficient' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'unknown' }
type R2Result =
  | { readonly kind: 'complete'; readonly window: unknown; readonly close: () => unknown }
  | { readonly kind: 'partial' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'unknown' }
type R3Result =
  | { readonly kind: 'admitted'; readonly cursor: unknown }
  | { readonly kind: 'incomplete'; readonly reason: 'failed' | 'unknown' | 'aborted' | 'timeout' }
type R5Directive =
  | { readonly kind: 'one_link'; readonly url: string }
  | { readonly kind: 'none' }
  | { readonly kind: 'insufficient' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'unknown' }

type Override = unknown | (() => unknown)
interface Overrides {
  readonly r4?: Override
  readonly r2?: Override
  readonly r3?: Override
  readonly r5?: Override
}

interface Calls {
  r4: number
  r2: number
  r3: number
  r5: number
}

interface PreparedResult {
  readonly kind: 'prepared'
  readonly request: {
    readonly requestId: string
    readonly cutoff: string
    readonly shanghaiDay: string
  }
  readonly outcome: {
    readonly kind: string
    readonly category: string
    readonly finalText: string
    readonly digest: string
    readonly [key: string]: unknown
  }
  readonly settle: (receipt: Receipt) => void
}

interface Receipt {
  readonly chatId: number
  readonly triggerMessageId: number
  readonly visibleText: string
  readonly messageIds: readonly [number]
}

function resultOrThrow(value: Override, fallback: unknown): unknown {
  if (typeof value === 'function') return value()
  return value === undefined ? fallback : value
}

function simpleCursor(requestId: string, finalUrl: string) {
  const canonicalUrl = canonicalizeXStatusIdentity(finalUrl) ?? finalUrl
  const receipt = Object.freeze({
    kind: 'candidate_judgment_completed' as const,
    stableId: 'x-status:42',
    requestId,
    position: 0,
    judgment: 'not_qualified' as const,
    completedAt: '2026-08-31T16:00:00.000Z',
  })
  const lease = Object.freeze({
    stableId: receipt.stableId,
    canonicalUrl,
    position: 0,
    body: 'fixture candidate',
    provenance: Object.freeze({
      capturedAt: '2026-08-31T16:00:00.000Z',
      surface: 'for_you' as const,
      surfaceOrdinal: 0,
      occurrenceOrdinal: 0,
      canonicalUrl,
      authorHandle: 'fixture-author',
      publishedAt: '2026-08-30T12:00:00.000Z',
    }),
    completeCurrent: async (input: { readonly judgment: 'qualified' | 'not_qualified' }) =>
      Object.freeze({ ...receipt, judgment: input.judgment }),
  })
  let borrowed = false
  return Object.freeze({
    cursor: Object.freeze({
      borrowCurrent: async () => {
        if (borrowed) return Object.freeze({ kind: 'done' as const })
        borrowed = true
        return Object.freeze({ kind: 'candidate' as const, lease })
      },
      finalize: async (claim: unknown) => {
        if (typeof claim === 'object' && claim !== null && (claim as { readonly kind?: unknown }).kind === 'selected') {
          return Object.freeze({ kind: 'selected' as const, selected: { stableId: receipt.stableId, canonicalUrl, position: 0 } })
        }
        if (typeof claim === 'object' && claim !== null && (claim as { readonly kind?: unknown }).kind === 'none') {
          return Object.freeze({ kind: 'none' as const })
        }
        return Object.freeze({ kind: 'incomplete' as const, reason: 'completion_claim_invalid' as const })
      },
      close: async () => undefined,
    }),
    receipt,
  })
}

function makePorts(overrides: Overrides = {}) {
  const calls: Calls = { r4: 0, r2: 0, r3: 0, r5: 0 }
  const ports = Object.freeze({
    r4: {
      snapshot: async (_input: unknown): Promise<unknown> => {
        calls.r4 += 1
        return resultOrThrow(overrides.r4, Object.freeze({
          kind: 'sufficient',
          snapshot: Object.freeze({ source: 'r4', captured: true }),
        }) satisfies R4Result)
      },
    },
    r2: {
      observe: async (_input: unknown): Promise<unknown> => {
        calls.r2 += 1
        return resultOrThrow(overrides.r2, Object.freeze({
          kind: 'complete',
          window: Object.freeze({ source: 'r2', complete: true }),
          close: async () => undefined,
        }) satisfies R2Result)
      },
    },
    r3: {
      admit: async (input: PersonalFeedV2R3Input): Promise<unknown> => {
        calls.r3 += 1
        if (overrides.r3 !== undefined) return resultOrThrow(overrides.r3, Object.freeze({ kind: 'incomplete' }))
        const directive = (typeof overrides.r5 === 'function'
          ? { kind: 'none' }
          : overrides.r5 ?? { kind: 'none' }) as { readonly kind?: unknown; readonly url?: unknown }
        const selectedUrl = typeof directive === 'object' && directive !== null && 'url' in directive && typeof directive.url === 'string'
          ? directive.url
          : 'https://x.com/reader/status/42'
        const finalUrl = directive.kind === 'one_link' && typeof directive.url === 'string'
          ? selectedUrl
          : 'https://x.com/reader/status/42'
        return Object.freeze({ kind: 'admitted', cursor: simpleCursor(input.request.requestId, finalUrl).cursor })
      },
    },
    r5: {
      judge: async (input: PersonalFeedV2R5Input): Promise<unknown> => {
        calls.r5 += 1
        assertCandidateJudgeView(input.candidates)
        const candidates = input.candidates
        const directive = resultOrThrow(overrides.r5, Object.freeze({ kind: 'none' })) as { readonly kind?: unknown; readonly url?: unknown }
        if (directive.kind !== 'one_link' && directive.kind !== 'none') return directive
        const first = await candidates.borrowCurrent({ signal: input.signal }) as { readonly kind: string; readonly lease?: { readonly completeCurrent: (input: unknown) => Promise<unknown> } }
        if (first.kind !== 'candidate' || first.lease === undefined) throw new Error('fixture candidate missing')
        const receipt = await first.lease.completeCurrent({ judgment: directive.kind === 'one_link' ? 'qualified' : 'not_qualified' })
        expect(await candidates.borrowCurrent({ signal: input.signal })).toEqual({ kind: 'done' })
        return directive.kind === 'one_link'
          ? Object.freeze({ kind: 'selected' as const, completed: Object.freeze([receipt]), selected: receipt })
          : Object.freeze({ kind: 'none' as const, completed: Object.freeze([receipt]) })
      },
    },
  })
  return { calls, ports }
}

function makeCoordinator(
  directory: string,
  options: { readonly now?: Date; readonly overrides?: Overrides } = {},
) {
  const ledgerPath = join(directory, 'requests.jsonl')
  const fake = makePorts(options.overrides)
  const now = options.now ?? new Date('2026-08-31T15:59:59.000Z')
  const coordinator = createPersonalFeedV2RequestCoordinator({
    ledgerPath,
    clock: { now: () => new Date(now) },
    r4: fake.ports.r4,
    r2: fake.ports.r2,
    r3: fake.ports.r3,
    r5: fake.ports.r5,
  })
  return { coordinator, ledgerPath, calls: fake.calls }
}

function signal(): AbortSignal {
  return new AbortController().signal
}

type CandidateCaptureCounters = { take: number; close: number; reasons: string[] }

type CandidateWindowRequest = {
  readonly requestId: string
  readonly cutoff: string
  readonly shanghaiDay: string
}

function candidateCapture(
  body: string,
  counters: CandidateCaptureCounters,
  markers: readonly string[],
) {
  const take = Object.assign(
    (_input: { readonly signal: AbortSignal }) => {
      counters.take += 1
      return body
    },
    Object.fromEntries(markers.map(marker => [marker, true])),
  )
  const close = Object.assign(
    (reason?: string) => {
      counters.close += 1
      if (reason !== undefined) counters.reasons.push(reason)
    },
    Object.fromEntries(markers.map(marker => [`${marker}_CLOSE`, true])),
  )
  return { kind: 'sufficient' as const, capture: { take, close } }
}

function candidateWindow(
  request: CandidateWindowRequest,
  counters: readonly CandidateCaptureCounters[],
) {
  const ids = [101, 202, 303]
  const surfaces = ['for_you', 'following', 'explore'] as const
  const surfaceTimes = [1, 2, 3].map(offset => new Date(Date.parse(request.cutoff) + offset).toISOString())
  return {
    requestId: request.requestId,
    cutoff: request.cutoff,
    shanghaiDay: request.shanghaiDay,
    startedAt: request.cutoff,
    completedAt: surfaceTimes[2],
    surfaces: surfaces.map((surface, surfaceOrdinal) => ({
      kind: 'complete' as const,
      surface,
      surfaceOrdinal,
      startedAt: surfaceOrdinal === 0 ? request.cutoff : surfaceTimes[surfaceOrdinal - 1],
      completedAt: surfaceTimes[surfaceOrdinal],
      occurrences: [{
        sourceUrl: `https://x.com/reader_${surfaceOrdinal}/status/${ids[surfaceOrdinal]}`,
        body: candidateCapture(`candidate-body-${ids[surfaceOrdinal]}`, counters[surfaceOrdinal]!, [
          `R2_RAW_WINDOW_CANARY_${surfaceOrdinal}`,
          `R2_PROCESSED_CANARY_${surfaceOrdinal}`,
          `R2_FAILED_CANARY_${surfaceOrdinal}`,
        ]),
        occurrenceOrdinal: 0,
        capturedAt: surfaceTimes[surfaceOrdinal],
        authorHandle: `author_${surfaceOrdinal}`,
        publishedAt: '2026-08-30T12:34:56.000Z',
      }],
    })),
  } as const
}

function closeAwareCandidateCapture(
  body: string,
  counters: CandidateCaptureCounters,
  markers: readonly string[],
) {
  let available = true
  const take = Object.assign(
    (_input: { readonly signal: AbortSignal }) => {
      counters.take += 1
      if (!available) return undefined
      available = false
      return body
    },
    Object.fromEntries(markers.map(marker => [marker, true])),
  )
  const close = Object.assign(
    (reason?: string) => {
      counters.close += 1
      available = false
      if (reason !== undefined) counters.reasons.push(reason)
    },
    Object.fromEntries(markers.map(marker => [`${marker}_CLOSE`, true])),
  )
  return { kind: 'sufficient' as const, capture: { take, close } }
}

function closeAwareCandidateWindow(
  request: CandidateWindowRequest,
  counters: readonly CandidateCaptureCounters[],
) {
  const ids = [101, 202, 303]
  const surfaces = ['for_you', 'following', 'explore'] as const
  const surfaceTimes = [1, 2, 3].map(offset => new Date(Date.parse(request.cutoff) + offset).toISOString())
  return {
    requestId: request.requestId,
    cutoff: request.cutoff,
    shanghaiDay: request.shanghaiDay,
    startedAt: request.cutoff,
    completedAt: surfaceTimes[2],
    surfaces: surfaces.map((surface, surfaceOrdinal) => ({
      kind: 'complete' as const,
      surface,
      surfaceOrdinal,
      startedAt: surfaceOrdinal === 0 ? request.cutoff : surfaceTimes[surfaceOrdinal - 1],
      completedAt: surfaceTimes[surfaceOrdinal],
      occurrences: [{
        sourceUrl: `https://x.com/reader_${surfaceOrdinal}/status/${ids[surfaceOrdinal]}`,
        body: closeAwareCandidateCapture(`candidate-body-${ids[surfaceOrdinal]}`, counters[surfaceOrdinal]!, [
          `R2_RAW_WINDOW_CANARY_${surfaceOrdinal}`,
          `R2_PROCESSED_CANARY_${surfaceOrdinal}`,
          `R2_FAILED_CANARY_${surfaceOrdinal}`,
        ]),
        occurrenceOrdinal: 0,
        capturedAt: surfaceTimes[surfaceOrdinal],
        authorHandle: `author_${surfaceOrdinal}`,
        publishedAt: '2026-08-30T12:34:56.000Z',
      }],
    })),
  } as const
}

function hasOwnMarker(value: unknown, marker: string, seen = new Set<object>()): boolean {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return false
  if (seen.has(value)) return false
  seen.add(value)
  for (const key of Reflect.ownKeys(value)) {
    if (key === marker) return true
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor !== undefined && 'value' in descriptor && hasOwnMarker(descriptor.value, marker, seen)) return true
  }
  return false
}

type CandidateJudgeView = {
  readonly borrowCurrent: (input: { readonly signal: AbortSignal }) => Promise<unknown>
}

function assertCandidateJudgeView(value: unknown): asserts value is CandidateJudgeView {
  expect(value).not.toBeNull()
  expect(typeof value).toBe('object')
  expect(Object.keys(value as object)).toEqual(['borrowCurrent'])
  expect(Reflect.ownKeys(value as object)).toEqual(['borrowCurrent'])
  expect(typeof (value as CandidateJudgeView).borrowCurrent).toBe('function')
  expect(value).not.toHaveProperty('finalize')
  expect(value).not.toHaveProperty('close')
}

function candidateLeaseKeys(value: unknown): readonly string[] {
  return Object.keys(value as object).sort()
}

function makeCandidateOwner(
  directory: string,
  request: CandidateWindowRequest,
  now: Date,
) {
  const counters: CandidateCaptureCounters[] = [
    { take: 0, close: 0, reasons: [] },
    { take: 0, close: 0, reasons: [] },
    { take: 0, close: 0, reasons: [] },
  ]
      const window = closeAwareCandidateWindow(request, counters)
  const owner = createPersonalFeedV2CandidateLifecycle({
    completionLedgerPath: join(directory, 'candidate-completions.jsonl'),
    clock: { now: () => new Date(now) },
  })
  return { owner, request, window, counters }
}

type ScriptedBorrowEvent = 'candidate1' | 'candidate2' | 'done' | 'incomplete' | 'throw' | 'malformed' | 'abort'
type ScriptedCompleteEvent = 'receipt1' | 'receipt2' | 'incomplete' | 'throw' | 'malformed' | 'wrong_identity' | 'abort'
type ScriptedFinalizeEvent = 'exact_incomplete' | 'throw' | 'malformed' | 'extra'

interface ScriptedCursorOptions {
  readonly borrow: readonly ScriptedBorrowEvent[]
  readonly complete: readonly ScriptedCompleteEvent[]
  readonly finalize: ScriptedFinalizeEvent
  readonly requestId: string
  readonly signalController: AbortController
}

interface B3Observations {
  readonly r4: number
  readonly r2: number
  readonly r3: number
  readonly r5: number
  readonly borrow: number
  readonly complete: number
  readonly finalize: number
  readonly close: number
  readonly closeReasons: readonly string[]
  readonly finalizeInputs: readonly unknown[]
  readonly cursor: PersonalFeedV2CandidateCursor
  readonly receipt1: PersonalFeedV2CandidateCompletionReceipt
  readonly malformedRaw?: unknown
  readonly malformedCursorCalls: number
}

function makeScriptedCursor(options: ScriptedCursorOptions): {
  readonly cursor: PersonalFeedV2CandidateCursor
  readonly observations: {
    borrow: number
    complete: number
    finalize: number
    close: number
    closeReasons: string[]
    finalizeInputs: unknown[]
  }
  readonly receipt1: PersonalFeedV2CandidateCompletionReceipt
} {
  const observations = { borrow: 0, complete: 0, finalize: 0, close: 0, closeReasons: [] as string[], finalizeInputs: [] as unknown[] }
  const receipt1 = Object.freeze({
    kind: 'candidate_judgment_completed' as const,
    stableId: 'x-status:101',
    requestId: options.requestId,
    position: 0,
    judgment: 'not_qualified' as const,
    completedAt: '2026-08-31T16:00:01.000Z',
  })
  const receipt2 = Object.freeze({
    kind: 'candidate_judgment_completed' as const,
    stableId: 'x-status:202',
    requestId: options.requestId,
    position: 1,
    judgment: 'not_qualified' as const,
    completedAt: '2026-08-31T16:00:02.000Z',
  })
  const complete = async (_input: unknown): Promise<unknown> => {
    observations.complete += 1
    const event = options.complete[observations.complete - 1]
    if (event === 'receipt1') return receipt1
    if (event === 'receipt2') return receipt2
    if (event === 'incomplete') return Object.freeze({ kind: 'incomplete', reason: 'failed' })
    if (event === 'throw') throw new Error('scripted completion failure')
    if (event === 'malformed') return Object.freeze({ kind: 'candidate_judgment_completed', stableId: 'x-status:202' })
    if (event === 'wrong_identity') return Object.freeze({ ...receipt2, stableId: 'x-status:other-batch', position: 99, judgment: 'qualified', extra: 'RECEIPT_EXTRA' })
    options.signalController.abort()
    return Object.freeze({ kind: 'incomplete', reason: 'aborted' })
  }
  const lease = (position: number, stableId: string, canonicalUrl: string) => Object.freeze({
    stableId,
    canonicalUrl,
    position,
    body: `scripted-body-${position}`,
    provenance: Object.freeze({
      capturedAt: '2026-08-31T16:00:00.000Z',
      surface: position === 0 ? 'for_you' as const : 'following' as const,
      surfaceOrdinal: position,
      occurrenceOrdinal: 0,
      canonicalUrl,
      authorHandle: `scripted-author-${position}`,
      publishedAt: '2026-08-30T12:34:56.000Z',
    }),
    completeCurrent: complete,
  })
  const cursor = Object.freeze({
    borrowCurrent: async (_input: { readonly signal: AbortSignal }): Promise<unknown> => {
      observations.borrow += 1
      const event = options.borrow[observations.borrow - 1]
      if (event === 'candidate1') return Object.freeze({ kind: 'candidate', lease: lease(0, 'x-status:101', 'https://x.com/reader_0/status/101') })
      if (event === 'candidate2') return Object.freeze({ kind: 'candidate', lease: lease(1, 'x-status:202', 'https://x.com/reader_1/status/202') })
      if (event === 'done') return Object.freeze({ kind: 'done' })
      if (event === 'incomplete') return Object.freeze({ kind: 'incomplete', reason: 'failed' })
      if (event === 'throw') throw new Error('scripted borrow failure')
      if (event === 'malformed') return Object.freeze({ kind: 'candidate', lease: { stableId: 'x-status:101' } })
      options.signalController.abort()
      return Object.freeze({ kind: 'incomplete', reason: 'aborted' })
    },
    finalize: async (claim: unknown): Promise<unknown> => {
      observations.finalize += 1
      observations.finalizeInputs.push(claim)
      if (options.finalize === 'throw') throw new Error('scripted finalizer failure')
      if (options.finalize === 'malformed') return Object.freeze({ kind: 'incomplete', reason: 'failed', extra: 'FINALIZER_EXTRA' })
      if (options.finalize === 'extra') return Object.freeze({ kind: 'none', extra: 'FINALIZER_EXTRA' })
      const record = claim as { readonly kind?: unknown; readonly reason?: unknown }
      return record.kind === 'incomplete'
        ? Object.freeze({ kind: 'incomplete', reason: record.reason })
        : Object.freeze({ kind: 'incomplete', reason: 'completion_claim_invalid' })
    },
    close: async (reason: string): Promise<void> => {
      observations.close += 1
      observations.closeReasons.push(reason)
    },
  }) as PersonalFeedV2CandidateCursor
  return { cursor, observations, receipt1 }
}

interface B3Case {
  readonly name: string
  readonly r3: 'incomplete' | 'throw' | 'malformed' | 'abort_inside' | 'deferred_abort' | 'admitted'
  readonly borrow: readonly ScriptedBorrowEvent[]
  readonly complete: readonly ScriptedCompleteEvent[]
  readonly finalize: ScriptedFinalizeEvent
  readonly r5: 'none' | 'throw' | 'malformed_raw' | 'abort_raw'
  readonly expected: {
    readonly outcome: 'incomplete'
    readonly r5: number
    readonly borrow: number
    readonly complete: number
    readonly finalize: number
    readonly close: number
    readonly closeReasons: readonly string[]
    readonly prefixLength: number
    readonly finalizeReason?: 'failed' | 'aborted'
  }
}

async function runB3Case(testCase: B3Case): Promise<B3Observations> {
  const directory = mkdtempSync(join(tmpdir(), 'personal-feed-v2-b3-'))
  temporaryDirectories.push(directory)
  const controller = new AbortController()
  const request: CandidateWindowRequest = {
    requestId: 'telegram:4242:9001',
    cutoff: '2026-08-31T16:00:00.000Z',
    shanghaiDay: '2026-09-01',
  }
  const scripted = makeScriptedCursor({
    borrow: testCase.borrow,
    complete: testCase.complete,
    finalize: testCase.finalize,
    requestId: request.requestId,
    signalController: controller,
  })
  const calls = { r4: 0, r2: 0, r3: 0, r5: 0 }
  let releaseR3: ((value: unknown) => void) | undefined
  let r3Input: PersonalFeedV2R3Input | undefined
  let malformedRaw: unknown
  let malformedCursorCalls = 0
  const window = Object.freeze({ source: 'B3_WINDOW' })
  const coordinator = createPersonalFeedV2RequestCoordinator({
    ledgerPath: join(directory, 'requests.jsonl'),
    clock: { now: () => new Date('2026-08-31T16:00:00.000Z') },
    r4: { snapshot: async () => { calls.r4 += 1; return { kind: 'sufficient', snapshot: Object.freeze({ source: 'B3_R4' }) } } },
    r2: { observe: async () => { calls.r2 += 1; return { kind: 'complete', window, close: async () => undefined } } },
    r3: {
      admit: async (input: PersonalFeedV2R3Input) => {
        calls.r3 += 1
        r3Input = input
        if (testCase.r3 === 'throw') throw new Error('scripted admission failure')
        if (testCase.r3 === 'incomplete' || testCase.r3 === 'abort_inside') {
          if (testCase.r3 === 'abort_inside') controller.abort()
          return { kind: 'incomplete', reason: 'failed' }
        }
        if (testCase.r3 === 'malformed') return {
          kind: 'admitted',
          cursor: { borrowCurrent: async () => { malformedCursorCalls += 1; return { kind: 'done' } } },
        }
        if (testCase.r3 === 'deferred_abort') {
          return new Promise(resolve => {
            releaseR3 = resolve
          })
        }
        return { kind: 'admitted', cursor: scripted.cursor }
      },
    },
    r5: {
      judge: async (input: PersonalFeedV2R5Input) => {
        calls.r5 += 1
        assertCandidateJudgeView(input.candidates)
        const view = input.candidates as CandidateJudgeView
        if (testCase.r5 === 'none') {
          const completed: PersonalFeedV2CandidateCompletionReceipt[] = []
          const incompleteClaim = (reason: 'failed' | 'aborted') => Object.freeze({
            kind: 'incomplete' as const,
            completed: Object.freeze([...completed]),
            reason,
          })
          const completeLease = async (lease: { readonly completeCurrent: (input: unknown) => Promise<unknown> }) => {
            const raw = await lease.completeCurrent({ judgment: 'not_qualified' }) as { readonly kind?: unknown; readonly reason?: unknown }
            if (raw.kind === 'candidate_judgment_completed') {
              completed.push(raw as PersonalFeedV2CandidateCompletionReceipt)
              return undefined
            }
            return incompleteClaim(raw.reason === 'aborted' ? 'aborted' : 'failed')
          }
          const first = await view.borrowCurrent({ signal: controller.signal })
          if (testCase.borrow[0] === 'candidate1' && first !== undefined) {
            if ((first as { readonly kind?: unknown }).kind === 'candidate') {
              const lease = (first as { readonly lease: { readonly completeCurrent: (input: unknown) => Promise<unknown> } }).lease
              const failure = await completeLease(lease)
              if (failure !== undefined) return failure
            }
          }
          if (testCase.borrow.length > 1) {
            const second = await view.borrowCurrent({ signal: controller.signal })
            if ((second as { readonly kind?: unknown }).kind === 'candidate') {
              const lease = (second as { readonly lease: { readonly completeCurrent: (input: unknown) => Promise<unknown> } }).lease
              const failure = await completeLease(lease)
              if (failure !== undefined) return failure
            } else if ((second as { readonly kind?: unknown; readonly reason?: unknown }).kind === 'incomplete') {
              return incompleteClaim((second as { readonly reason?: unknown }).reason === 'aborted' ? 'aborted' : 'failed')
            }
          }
          return Object.freeze({ kind: 'none' as const, completed: Object.freeze([...completed]) })
        }
        if (testCase.r5 === 'throw') {
          const first = await view.borrowCurrent({ signal: controller.signal })
          if ((first as { readonly kind?: unknown }).kind === 'candidate') {
            const lease = (first as { readonly lease: { readonly completeCurrent: (input: unknown) => Promise<unknown> } }).lease
            const firstReceipt = await lease.completeCurrent({ judgment: 'not_qualified' })
            if (testCase.name.startsWith('E1')) {
              const replay = await lease.completeCurrent({ judgment: 'not_qualified' })
              expect(replay).toBe(firstReceipt)
            }
          }
          throw new Error('scripted judge failure')
        }
        const first = await view.borrowCurrent({ signal: controller.signal })
        if ((first as { readonly kind?: unknown }).kind === 'candidate') {
          await (first as { readonly lease: { readonly completeCurrent: (input: unknown) => Promise<unknown> } }).lease.completeCurrent({ judgment: 'not_qualified' })
        }
        if (testCase.r5 === 'abort_raw') controller.abort()
        if (testCase.r5 === 'malformed_raw') {
          malformedRaw = { kind: 'one_link', url: 'https://x.com/reader_0/status/101', extra: 'RAW_EXTRA' }
          return malformedRaw
        }
        return { kind: 'one_link', url: 'https://x.com/reader_0/status/101' }
      },
    },
  })

  let prepared: PreparedResult | undefined
  if (testCase.r3 === 'deferred_abort') {
    const pending = coordinator.prepare({ chatId: 4242, messageId: 9001, signal: controller.signal })
    for (let index = 0; index < 10 && releaseR3 === undefined; index += 1) await Promise.resolve()
    expect(releaseR3, testCase.name).toBeTypeOf('function')
    controller.abort()
    releaseR3!({ kind: 'admitted', cursor: scripted.cursor })
    prepared = await pending as PreparedResult
  } else {
    prepared = await coordinator.prepare({ chatId: 4242, messageId: 9001, signal: controller.signal }) as PreparedResult
  }
  expect(prepared.outcome.kind, testCase.name).toBe(testCase.expected.outcome)
  expect(prepared.outcome.finalText, testCase.name).toBe('这次没有完成：判断或执行未完成。')
  expect(prepared.outcome.finalText, testCase.name).not.toContain('B3_WINDOW')
  expect(r3Input === undefined || Object.keys(r3Input).sort().join(',') === 'request,signal,window').toBe(true)
  return {
    ...calls,
    ...scripted.observations,
    cursor: scripted.cursor,
    receipt1: scripted.receipt1,
    malformedRaw,
    malformedCursorCalls,
  }
}

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('Personal Feed v2 honest request lifecycle', () => {
  it('exports the one Telegram request identity function and rejects unsafe/non-positive coordinates', () => {
    expect(personalFeedV2TelegramRequestId(42, 5)).toBe('telegram:42:5')
    expect(personalFeedV2TelegramRequestId(-42, 5)).toBe('telegram:-42:5')
    expect(() => personalFeedV2TelegramRequestId(0, 1)).toThrow()
    expect(() => personalFeedV2TelegramRequestId(Number.MAX_SAFE_INTEGER + 1, 5)).toThrow()
    expect(() => personalFeedV2TelegramRequestId(42, 0)).toThrow()
    expect(() => personalFeedV2TelegramRequestId(42, -1)).toThrow()
    expect(() => personalFeedV2TelegramRequestId(42, 1.5)).toThrow()
    expect(() => personalFeedV2TelegramRequestId(42, Number.MAX_SAFE_INTEGER + 1)).toThrow()
  })

  it('reads one clock boundary per chat/message and reuses it across Shanghai midnight without colliding across chats', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'personal-feed-v2-lifecycle-'))
    temporaryDirectories.push(directory)
    let now = new Date('2026-08-31T15:59:59.000Z')
    let clockReads = 0
    const fake = makePorts()
    const coordinator = createPersonalFeedV2RequestCoordinator({
      ledgerPath: join(directory, 'requests.jsonl'),
      clock: { now: () => { clockReads += 1; return new Date(now) } },
      r4: fake.ports.r4,
      r2: fake.ports.r2,
      r3: fake.ports.r3,
      r5: fake.ports.r5,
    })

    const first = await coordinator.prepare({ chatId: 42, messageId: 5, signal: signal() }) as PreparedResult
    expect(first.kind).toBe('prepared')
    expect(first.request).toEqual({
      requestId: 'telegram:42:5',
      cutoff: '2026-08-31T15:59:59.000Z',
      shanghaiDay: '2026-08-31',
    })
    expect(clockReads).toBe(1)

    now = new Date('2026-09-01T16:01:00.000Z')
    const duplicate = await coordinator.prepare({ chatId: 42, messageId: 5, signal: signal() })
    expect(duplicate).toEqual({ kind: 'duplicate_consumed' })
    expect(coordinator.read('telegram:42:5')).toMatchObject({ status: 'prepared', request: first.request })
    expect(clockReads).toBe(1)
    expect(fake.calls).toEqual({ r4: 1, r2: 1, r3: 1, r5: 1 })

    const otherChat = await coordinator.prepare({ chatId: 43, messageId: 5, signal: signal() }) as PreparedResult
    expect(otherChat.kind).toBe('prepared')
    expect(otherChat.request.requestId).toBe('telegram:43:5')
    expect(otherChat.request.cutoff).toBe('2026-09-01T16:01:00.000Z')
    expect(clockReads).toBe(2)
    expect(fake.calls).toEqual({ r4: 2, r2: 2, r3: 2, r5: 2 })
  })

  it('passes each port only its narrow public input while preserving the complete-chain values', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'personal-feed-v2-port-inputs-'))
    temporaryDirectories.push(directory)
    const requestSignal = signal()
    const r4Snapshot = Object.freeze({
      marker: 'R4_PRIVATE_SNAPSHOT',
      privateContext: Object.freeze({ subject: 'user-only' }),
    })
    const r2Window = Object.freeze({
      marker: 'R2_RAW_WINDOW',
      bodies: Object.freeze([
        Object.freeze({ state: 'processed', marker: 'R2_PROCESSED_BODY' }),
        Object.freeze({ state: 'failed', marker: 'R2_FAILED_BODY' }),
      ]),
    })
    const portCalls = { r4: 0, r2: 0, r3: 0, r5: 0 }
    let r4Input: PersonalFeedV2R4Input | undefined
    let r2Input: PersonalFeedV2R2Input | undefined
    let r3Input: PersonalFeedV2R3Input | undefined
    let r5Input: PersonalFeedV2R5Input | undefined

    const coordinator = createPersonalFeedV2RequestCoordinator({
      ledgerPath: join(directory, 'requests.jsonl'),
      clock: { now: () => new Date('2026-08-31T15:59:59.000Z') },
      r4: {
        snapshot: async (input: PersonalFeedV2R4Input) => {
          portCalls.r4 += 1
          r4Input = input
          return Object.freeze({ kind: 'sufficient', snapshot: r4Snapshot }) satisfies R4Result
        },
      },
      r2: {
        observe: async (input: PersonalFeedV2R2Input) => {
          portCalls.r2 += 1
          r2Input = input
          return Object.freeze({ kind: 'complete', window: r2Window, close: async () => undefined }) satisfies R2Result
        },
      },
      r3: {
        admit: async (input: PersonalFeedV2R3Input) => {
          portCalls.r3 += 1
          r3Input = input
          return Object.freeze({ kind: 'admitted', cursor: simpleCursor(input.request.requestId, 'https://x.com/reader/status/42').cursor })
        },
      },
      r5: {
        judge: async (input: PersonalFeedV2R5Input) => {
          portCalls.r5 += 1
          r5Input = input
          assertCandidateJudgeView(input.candidates)
          const candidates = input.candidates
          const first = await candidates.borrowCurrent({ signal: input.signal }) as { readonly kind: string; readonly lease?: { readonly completeCurrent: (input: unknown) => Promise<unknown> } }
          if (first.kind !== 'candidate' || first.lease === undefined) throw new Error('port fixture candidate missing')
          const receipt = await first.lease.completeCurrent({ judgment: 'qualified' })
          expect(await candidates.borrowCurrent({ signal: input.signal })).toEqual({ kind: 'done' })
          return Object.freeze({ kind: 'selected' as const, completed: Object.freeze([receipt]), selected: receipt })
        },
      },
    })

    const prepared = await coordinator.prepare({ chatId: 42, messageId: 5, signal: requestSignal }) as PreparedResult
    const expectedRequest = {
      requestId: 'telegram:42:5',
      cutoff: '2026-08-31T15:59:59.000Z',
      shanghaiDay: '2026-08-31',
    }

    expect(prepared.outcome.kind).toBe('one_link')
    expect(prepared.outcome.finalText).toBe('https://x.com/reader/status/42')
    expect(portCalls).toEqual({ r4: 1, r2: 1, r3: 1, r5: 1 })
    expect(Object.keys(r4Input!).sort()).toEqual(['request', 'signal'])
    expect(Object.keys(r2Input!).sort()).toEqual(['request', 'signal'])
    expect(Object.keys(r3Input!).sort()).toEqual(['request', 'signal', 'window'])
    expect(Object.keys(r5Input!).sort()).toEqual(['candidates', 'request', 'signal', 'snapshot'])
    expect(Object.keys(r4Input!.request).sort()).toEqual(['cutoff', 'requestId', 'shanghaiDay'])
    expect(Object.keys(r2Input!.request).sort()).toEqual(['cutoff', 'requestId', 'shanghaiDay'])
    expect(Object.keys(r3Input!.request).sort()).toEqual(['cutoff', 'requestId', 'shanghaiDay'])
    expect(Object.keys(r5Input!.request).sort()).toEqual(['cutoff', 'requestId', 'shanghaiDay'])
    expect(r4Input!.request).toEqual(expectedRequest)
    expect(r2Input!.request).toEqual(expectedRequest)
    expect(r3Input!.request).toEqual(expectedRequest)
    expect(r5Input!.request).toEqual(expectedRequest)
    expect(r4Input!.signal).toBe(requestSignal)
    expect(r2Input!.signal).toBe(requestSignal)
    expect(r3Input!.signal).toBe(requestSignal)
    expect(r5Input!.signal).toBe(requestSignal)
    expect(r3Input!.window).toBe(r2Window)
    expect(r5Input!.snapshot).toBe(r4Snapshot)
    expect(Object.keys(r5Input!.candidates as object)).toEqual(['borrowCurrent'])
    expect(r5Input).not.toHaveProperty('window')
    expect(r3Input).not.toBeUndefined()
    expect(JSON.stringify(r2Input)).not.toContain('R4_PRIVATE_SNAPSHOT')
    expect(JSON.stringify(r3Input)).not.toContain('R4_PRIVATE_SNAPSHOT')
    expect(JSON.stringify(r5Input)).not.toContain('R2_RAW_WINDOW')
    expect(JSON.stringify(r5Input)).not.toContain('R2_PROCESSED_BODY')
    expect(JSON.stringify(r5Input)).not.toContain('R2_FAILED_BODY')
  })

  it('returns the strict canonical x.com link when the complete chain produces one link', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'personal-feed-v2-one-link-'))
    temporaryDirectories.push(directory)
    const { coordinator } = makeCoordinator(directory, {
      overrides: { r5: Object.freeze({ kind: 'one_link', url: 'https://twitter.com/Some_User/status/42' }) satisfies R5Directive },
    })

    const prepared = await coordinator.prepare({ chatId: 42, messageId: 5, signal: signal() }) as PreparedResult
    expect(prepared.outcome.kind).toBe('one_link')
    expect(prepared.outcome.finalText).toBe('https://x.com/some_user/status/42')
    expect(prepared.outcome.finalText.match(/https:\/\/x\.com\/[^\s]+\/status\/[1-9][0-9]*/g)).toEqual([
      'https://x.com/some_user/status/42',
    ])
    expect(prepared.outcome.digest).toEqual(expect.any(String))
  })

  it('uses the exact business-empty text only when the complete chain returns no link', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'personal-feed-v2-empty-'))
    temporaryDirectories.push(directory)
    const { coordinator } = makeCoordinator(directory, {
      overrides: { r5: Object.freeze({ kind: 'none' }) satisfies R5Directive },
    })

    const prepared = await coordinator.prepare({ chatId: 42, messageId: 5, signal: signal() }) as PreparedResult
    expect(prepared.outcome.kind).toBe('business_empty')
    expect(prepared.outcome.finalText).toBe('这次没有值得看的内容。')
  })

  it.each([
    ['R4 insufficient', 'r4', Object.freeze({ kind: 'insufficient' }) satisfies R4Result, { kind: 'incomplete', category: 'personal_context', finalText: '这次没有完成：个人语境不足或未完成。' }, { r4: 1, r2: 0, r3: 0, r5: 0 }],
    ['R4 failed', 'r4', Object.freeze({ kind: 'failed' }) satisfies R4Result, { kind: 'incomplete', category: 'personal_context', finalText: '这次没有完成：个人语境不足或未完成。' }, { r4: 1, r2: 0, r3: 0, r5: 0 }],
    ['R4 unknown', 'r4', Object.freeze({ kind: 'unknown' }) satisfies R4Result, { kind: 'incomplete', category: 'personal_context', finalText: '这次没有完成：个人语境不足或未完成。' }, { r4: 1, r2: 0, r3: 0, r5: 0 }],
    ['R4 throw', 'r4', () => { throw new Error('R4 unavailable') }, { kind: 'incomplete', category: 'personal_context', finalText: '这次没有完成：个人语境不足或未完成。' }, { r4: 1, r2: 0, r3: 0, r5: 0 }],
    ['R4 malformed', 'r4', Object.freeze({ malformed: true }), { kind: 'incomplete', category: 'personal_context', finalText: '这次没有完成：个人语境不足或未完成。' }, { r4: 1, r2: 0, r3: 0, r5: 0 }],
    ['R2 partial', 'r2', Object.freeze({ kind: 'partial' }) satisfies R2Result, { kind: 'incomplete', category: 'source_window', finalText: '这次没有完成：X 来源或观察窗口未完成。' }, { r4: 1, r2: 1, r3: 0, r5: 0 }],
    ['R2 failed', 'r2', Object.freeze({ kind: 'failed' }) satisfies R2Result, { kind: 'incomplete', category: 'source_window', finalText: '这次没有完成：X 来源或观察窗口未完成。' }, { r4: 1, r2: 1, r3: 0, r5: 0 }],
    ['R2 unknown', 'r2', Object.freeze({ kind: 'unknown' }) satisfies R2Result, { kind: 'incomplete', category: 'source_window', finalText: '这次没有完成：X 来源或观察窗口未完成。' }, { r4: 1, r2: 1, r3: 0, r5: 0 }],
    ['R2 throw', 'r2', () => { throw new Error('R2 unavailable') }, { kind: 'incomplete', category: 'source_window', finalText: '这次没有完成：X 来源或观察窗口未完成。' }, { r4: 1, r2: 1, r3: 0, r5: 0 }],
    ['R2 malformed', 'r2', Object.freeze({ malformed: true }), { kind: 'incomplete', category: 'source_window', finalText: '这次没有完成：X 来源或观察窗口未完成。' }, { r4: 1, r2: 1, r3: 0, r5: 0 }],
    ['R3 insufficient', 'r3', Object.freeze({ kind: 'incomplete', reason: 'failed' }) satisfies R3Result, { kind: 'incomplete', category: 'judgement_execution', finalText: '这次没有完成：判断或执行未完成。' }, { r4: 1, r2: 1, r3: 1, r5: 0 }],
    ['R3 failed', 'r3', Object.freeze({ kind: 'incomplete', reason: 'failed' }) satisfies R3Result, { kind: 'incomplete', category: 'judgement_execution', finalText: '这次没有完成：判断或执行未完成。' }, { r4: 1, r2: 1, r3: 1, r5: 0 }],
    ['R3 unknown', 'r3', Object.freeze({ kind: 'incomplete', reason: 'unknown' }) satisfies R3Result, { kind: 'incomplete', category: 'judgement_execution', finalText: '这次没有完成：判断或执行未完成。' }, { r4: 1, r2: 1, r3: 1, r5: 0 }],
    ['R3 throw', 'r3', () => { throw new Error('R3 unavailable') }, { kind: 'incomplete', category: 'judgement_execution', finalText: '这次没有完成：判断或执行未完成。' }, { r4: 1, r2: 1, r3: 1, r5: 0 }],
    ['R3 malformed', 'r3', Object.freeze({ malformed: true }), { kind: 'incomplete', category: 'judgement_execution', finalText: '这次没有完成：判断或执行未完成。' }, { r4: 1, r2: 1, r3: 1, r5: 0 }],
    ['R5 insufficient', 'r5', Object.freeze({ kind: 'insufficient' }) satisfies R5Directive, { kind: 'incomplete', category: 'judgement_execution', finalText: '这次没有完成：判断或执行未完成。' }, { r4: 1, r2: 1, r3: 1, r5: 1 }],
    ['R5 failed', 'r5', Object.freeze({ kind: 'failed' }) satisfies R5Directive, { kind: 'incomplete', category: 'judgement_execution', finalText: '这次没有完成：判断或执行未完成。' }, { r4: 1, r2: 1, r3: 1, r5: 1 }],
    ['R5 unknown', 'r5', Object.freeze({ kind: 'unknown' }) satisfies R5Directive, { kind: 'incomplete', category: 'judgement_execution', finalText: '这次没有完成：判断或执行未完成。' }, { r4: 1, r2: 1, r3: 1, r5: 1 }],
    ['R5 throw', 'r5', () => { throw new Error('R5 unavailable') }, { kind: 'incomplete', category: 'judgement_execution', finalText: '这次没有完成：判断或执行未完成。' }, { r4: 1, r2: 1, r3: 1, r5: 1 }],
    ['R5 malformed', 'r5', Object.freeze({ malformed: true }), { kind: 'incomplete', category: 'judgement_execution', finalText: '这次没有完成：判断或执行未完成。' }, { r4: 1, r2: 1, r3: 1, r5: 1 }],
  ] as const)('fails closed on %s and does not run later ports or claim business empty', async (_name, port, value, expected, expectedCalls) => {
    const directory = mkdtempSync(join(tmpdir(), 'personal-feed-v2-incomplete-'))
    temporaryDirectories.push(directory)
    const overrides: Overrides = { [port]: value }
    const { coordinator, calls } = makeCoordinator(directory, { overrides })

    const prepared = await coordinator.prepare({ chatId: 42, messageId: 5, signal: signal() }) as PreparedResult
    expect(prepared.outcome.kind).toBe(expected.kind)
    expect(prepared.outcome.category).toBe(expected.category)
    expect(prepared.outcome.finalText).toBe(expected.finalText)
    expect(prepared.outcome.finalText).not.toBe('这次没有值得看的内容。')
    expect(calls).toEqual(expectedCalls)
  })

  it.each([
    ['query', 'https://x.com/user/status/42?utm_source=feed'],
    ['fragment', 'https://x.com/user/status/42#fragment'],
    ['photo', 'https://x.com/user/status/42/photo/1'],
    ['non-status', 'https://x.com/user/post/42'],
    ['non-HTTPS', 'http://x.com/user/status/42'],
    ['non-X', 'https://example.com/user/status/42'],
    ['uppercase host', 'https://X.com/user/status/42'],
    ['leading-zero', 'https://x.com/user/status/042'],
    ['title appended', 'https://x.com/user/status/42 a useful title'],
    ['second URL', 'https://x.com/user/status/42 https://x.com/user/status/43'],
  ] as const)('rejects %s from the one-link guard', async (_name, url) => {
    const directory = mkdtempSync(join(tmpdir(), 'personal-feed-v2-url-guard-'))
    temporaryDirectories.push(directory)
    const { coordinator } = makeCoordinator(directory, {
      overrides: { r5: Object.freeze({ kind: 'one_link', url }) satisfies R5Directive },
    })

    const prepared = await coordinator.prepare({ chatId: 42, messageId: 5, signal: signal() }) as PreparedResult
    expect(prepared.outcome.kind).toBe('incomplete')
    expect(prepared.outcome.category).toBe('judgement_execution')
    expect(prepared.outcome.finalText).toBe('这次没有完成：判断或执行未完成。')
  })

  it.each([
    'https://twitter.com/Some_User/status/42',
    'https://x.com/SOME_USER/status/42',
  ] as const)('canonicalizes an allowed %s URL to one lowercase x.com URL', async (url) => {
    const directory = mkdtempSync(join(tmpdir(), 'personal-feed-v2-url-canonical-'))
    temporaryDirectories.push(directory)
    const { coordinator } = makeCoordinator(directory, {
      overrides: { r5: Object.freeze({ kind: 'one_link', url }) satisfies R5Directive },
    })

    const prepared = await coordinator.prepare({ chatId: 42, messageId: 5, signal: signal() }) as PreparedResult
    expect(prepared.outcome.finalText).toBe('https://x.com/some_user/status/42')
  })

  it('rejects an object with only an aborted boolean instead of treating it as an AbortSignal', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'personal-feed-v2-abort-signal-'))
    temporaryDirectories.push(directory)
    const { coordinator, calls } = makeCoordinator(directory)
    const fakeSignal = { aborted: false } as AbortSignal

    await expect(coordinator.prepare({ chatId: 42, messageId: 5, signal: fakeSignal })).rejects.toThrow()
    expect(calls).toEqual({ r4: 0, r2: 0, r3: 0, r5: 0 })
  })

  it('keeps a prepared request open until one matching receipt settles it, with idempotent replay and immutable terminal state', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'personal-feed-v2-settle-'))
    temporaryDirectories.push(directory)
    let releaseR4!: (result: unknown) => void
    const r4Preparing = new Promise<unknown>(resolve => { releaseR4 = resolve })
    const { coordinator } = makeCoordinator(directory, { overrides: { r4: () => r4Preparing } })
    const preparing = coordinator.prepare({ chatId: 42, messageId: 5, signal: signal() })
    expect(coordinator.read('telegram:42:5')).toMatchObject({ status: 'open' })
    releaseR4(Object.freeze({
      kind: 'sufficient',
      snapshot: Object.freeze({ source: 'r4', captured: true }),
    }) satisfies R4Result)
    const prepared = await preparing as PreparedResult
    const receipt: Receipt = {
      chatId: 42,
      triggerMessageId: 5,
      visibleText: prepared.outcome.finalText,
      messageIds: [9001],
    }

    expect(coordinator.read('telegram:42:5')).toMatchObject({ status: 'prepared' })
    prepared.settle(receipt)
    expect(coordinator.read('telegram:42:5')).toMatchObject({ status: 'delivered', receipt })
    prepared.settle(receipt)
    expect(coordinator.read('telegram:42:5')).toMatchObject({ status: 'delivered', receipt })

    const mismatches: readonly Receipt[] = [
      { ...receipt, visibleText: 'different text' },
      { ...receipt, messageIds: [9002] },
      { ...receipt, chatId: 43 },
      { ...receipt, triggerMessageId: 6 },
    ]
    for (const mismatch of mismatches) {
      expect(() => prepared.settle(mismatch)).toThrow()
      expect(coordinator.read('telegram:42:5')).toMatchObject({ status: 'delivered', receipt })
    }
  })

  it('accepts a real R3 cursor through a judge-only view only when finalized exact prefixes prove selected, none, or incomplete', async () => {
    const runRealChain = async (judgment: 'qualified' | 'not_qualified') => {
      const directory = mkdtempSync(join(tmpdir(), `personal-feed-v2-r3-cursor-${judgment}-`))
      temporaryDirectories.push(directory)
      const request: CandidateWindowRequest = {
        requestId: judgment === 'qualified' ? 'telegram:4242:9401' : 'telegram:4242:9402',
        cutoff: '2026-08-31T16:00:00.000Z',
        shanghaiDay: '2026-09-01',
      }
      const fixture = makeCandidateOwner(directory, request, new Date('2026-08-31T16:00:01.000Z'))
      const snapshot = Object.freeze({ source: 'R4_PRIVATE_SNAPSHOT', ownerOnly: true })
      let r3Input: PersonalFeedV2R3Input | undefined
      let r2Input: PersonalFeedV2R2Input | undefined
      let r5Input: PersonalFeedV2R5Input | undefined
      let r5Calls = 0
      let ownerCursor: PersonalFeedV2CandidateCursor | undefined
      const coordinator = createPersonalFeedV2RequestCoordinator({
        ledgerPath: join(directory, 'requests.jsonl'),
        clock: { now: () => new Date('2026-08-31T16:00:00.000Z') },
        r4: {
          snapshot: async (input: PersonalFeedV2R4Input) => {
            expect(Object.keys(input).sort()).toEqual(['request', 'signal'])
            return Object.freeze({ kind: 'sufficient', snapshot })
          },
        },
        r2: {
          observe: async (input: PersonalFeedV2R2Input) => {
            r2Input = input
            return Object.freeze({ kind: 'complete', window: fixture.window, close: async () => undefined })
          },
        },
        r3: {
          admit: async (input: PersonalFeedV2R3Input) => {
            r3Input = input
            expect(input.request).toEqual(request)
            const admitted = await fixture.owner.admit({ request: input.request, window: input.window, signal: input.signal })
            expect(admitted.kind).toBe('admitted')
            if (admitted.kind !== 'admitted') throw new Error('real R3 owner did not admit the exact window')
            ownerCursor = admitted.cursor
            return Object.freeze({ kind: 'admitted', cursor: admitted.cursor })
          },
        },
        r5: {
          judge: async (input: PersonalFeedV2R5Input) => {
            r5Calls += 1
            r5Input = input
            expect(input.request).toEqual(request)
            expect(Object.keys(input).sort()).toEqual(['candidates', 'request', 'signal', 'snapshot'])
            expect(input.snapshot).toBe(snapshot)
            assertCandidateJudgeView(input.candidates)
            const view = input.candidates
            const completed: PersonalFeedV2CandidateCompletionReceipt[] = []
            while (true) {
              const borrowed = await view.borrowCurrent({ signal: input.signal }) as {
                readonly kind: string
                readonly lease?: {
                  readonly body: string
                  readonly canonicalUrl: string
                  readonly completeCurrent: (input: unknown) => Promise<unknown>
                  readonly position: number
                  readonly provenance: Record<string, unknown>
                  readonly stableId: string
                }
              }
              if (borrowed.kind === 'done') break
              expect(borrowed.kind, 'R5 must only receive candidate, done, or coordinator incomplete').toBe('candidate')
              if (borrowed.kind !== 'candidate' || borrowed.lease === undefined) throw new Error('judge-only view did not expose a candidate')
              expect(candidateLeaseKeys(borrowed.lease)).toEqual([
                'body', 'canonicalUrl', 'completeCurrent', 'position', 'provenance', 'stableId',
              ])
              expect(Object.keys(borrowed.lease.provenance).sort()).toEqual([
                'authorHandle', 'canonicalUrl', 'capturedAt', 'occurrenceOrdinal', 'publishedAt', 'surface', 'surfaceOrdinal',
              ])
              const rawReceipt = await borrowed.lease.completeCurrent({ judgment }) as { readonly kind?: unknown }
              expect(rawReceipt.kind).toBe('candidate_judgment_completed')
              if (rawReceipt.kind !== 'candidate_judgment_completed') throw new Error('R5 did not receive an owner completion receipt')
              const receipt = rawReceipt as PersonalFeedV2CandidateCompletionReceipt
              completed.push(receipt)
              if (judgment === 'qualified') break
            }
            expect(await view.borrowCurrent({ signal: input.signal })).toEqual({ kind: 'done' })
            if (judgment === 'qualified') {
              expect(completed).toHaveLength(1)
              return Object.freeze({ kind: 'selected', completed: Object.freeze(completed), selected: completed[0] })
            }
            expect(completed).toHaveLength(3)
            return Object.freeze({ kind: 'none', completed: Object.freeze(completed) })
          },
        },
      })
      const prepared = await coordinator.prepare({
        chatId: 4242,
        messageId: judgment === 'qualified' ? 9401 : 9402,
        signal: signal(),
      }) as PreparedResult
      expect(prepared.outcome.kind).toBe(judgment === 'qualified' ? 'one_link' : 'business_empty')
      expect(prepared.outcome.finalText).toBe(
        judgment === 'qualified' ? 'https://x.com/reader_0/status/101' : '这次没有值得看的内容。',
      )
      expect(r3Input).not.toBeUndefined()
      expect(Object.keys(r3Input!).sort()).toEqual(['request', 'signal', 'window'])
      expect(r3Input!.window).toBe(fixture.window)
      for (const marker of ['R2_RAW_WINDOW_CANARY_0', 'R2_PROCESSED_CANARY_1', 'R2_FAILED_CANARY_2']) {
        expect(hasOwnMarker(r3Input!.window, marker)).toBe(true)
      }
      expect(ownerCursor).not.toBeUndefined()
      expect(r5Calls).toBe(1)
      expect(r2Input).not.toBeUndefined()
      expect(Object.keys(r2Input!).sort()).toEqual(['request', 'signal'])
      expect(JSON.stringify(r2Input)).not.toContain('R4_PRIVATE_SNAPSHOT')
      expect(JSON.stringify(r3Input)).not.toContain('R4_PRIVATE_SNAPSHOT')
      expect(r5Input).not.toBeUndefined()
      expect(Object.keys(r5Input!).sort()).toEqual(['candidates', 'request', 'signal', 'snapshot'])
      for (const marker of [
        'R2_RAW_WINDOW_CANARY_0', 'R2_PROCESSED_CANARY_1', 'R2_FAILED_CANARY_2',
        'R2_RAW_WINDOW_CANARY_0_CLOSE', 'R2_PROCESSED_CANARY_1_CLOSE', 'R2_FAILED_CANARY_2_CLOSE',
      ]) {
        expect(hasOwnMarker(r5Input, marker)).toBe(false)
      }
      expect(r5Input).not.toHaveProperty('window')
      expect(r5Input).not.toHaveProperty('surfaces')
      expect(r5Input).not.toHaveProperty('finalize')
      expect(r5Input).not.toHaveProperty('close')
      expect(JSON.stringify(r5Input)).not.toContain('R2_RAW_WINDOW')
      expect(JSON.stringify(r5Input)).not.toContain('R2_PROCESSED')
      expect(JSON.stringify(r5Input)).not.toContain('R2_FAILED')
      expect(fixture.counters.every(counter => counter.close === 1)).toBe(true)
      return { coordinator, fixture }
    }

    await runRealChain('qualified')
    await runRealChain('not_qualified')

    const enemyClaims: readonly {
      readonly name: string
      readonly claim: (receipt: PersonalFeedV2CandidateCompletionReceipt) => unknown
    }[] = [
      { name: 'raw old one_link', claim: () => ({ kind: 'one_link', url: 'https://x.com/reader_0/status/101' }) },
      { name: 'bare none', claim: () => ({ kind: 'none' }) },
      { name: 'partial selected', claim: receipt => ({ kind: 'selected', completed: [], selected: receipt }) },
      { name: 'copied receipt', claim: receipt => ({ kind: 'selected', completed: [{ ...receipt }], selected: receipt }) },
      { name: 'future receipt', claim: receipt => ({ kind: 'selected', completed: [{ ...receipt, completedAt: '2099-01-01T00:00:00.000Z' }], selected: receipt }) },
      { name: 'other-batch receipt', claim: receipt => ({ kind: 'selected', completed: [{ ...receipt, requestId: 'telegram:9999:1' }], selected: receipt }) },
      { name: 'outer extra', claim: receipt => Object.assign({ kind: 'selected', completed: [receipt], selected: receipt }, { extra: 'OUTER_EXTRA' }) },
      { name: 'nested claim', claim: receipt => ({ claim: { kind: 'selected', completed: [receipt], selected: receipt } }) },
      { name: 'array extra key', claim: receipt => ({ kind: 'selected', completed: Object.assign([receipt], { extra: 'ARRAY_EXTRA' }), selected: receipt }) },
      { name: 'selected extra key', claim: receipt => ({ kind: 'selected', completed: [receipt], selected: { ...receipt, extra: 'SELECTED_EXTRA' } }) },
    ]
    for (const [index, enemy] of enemyClaims.entries()) {
      const directory = mkdtempSync(join(tmpdir(), 'personal-feed-v2-r3-enemy-'))
      temporaryDirectories.push(directory)
      const request: CandidateWindowRequest = {
        requestId: `telegram:4242:${9450 + index}`,
        cutoff: '2026-08-31T16:00:00.000Z',
        shanghaiDay: '2026-09-01',
      }
      const fixture = makeCandidateOwner(directory, request, new Date('2026-08-31T16:00:01.000Z'))
      let sawDone = false
      let finalizeCalled = 0
      const coordinator = createPersonalFeedV2RequestCoordinator({
        ledgerPath: join(directory, 'requests.jsonl'),
        clock: { now: () => new Date('2026-08-31T16:00:00.000Z') },
        r4: { snapshot: async () => ({ kind: 'sufficient', snapshot: Object.freeze({ source: 'enemy-r4' }) }) },
        r2: { observe: async () => ({ kind: 'complete', window: fixture.window, close: async () => undefined }) },
        r3: {
          admit: async (input: PersonalFeedV2R3Input) => {
            expect(input.request).toEqual(request)
            const admitted = await fixture.owner.admit({ request: input.request, window: input.window, signal: input.signal })
            if (admitted.kind !== 'admitted') throw new Error('enemy fixture did not admit')
            const cursor = admitted.cursor
            return Object.freeze({
              kind: 'admitted',
              cursor: Object.freeze({
                borrowCurrent: cursor.borrowCurrent,
                finalize: async (claim: unknown) => { finalizeCalled += 1; return cursor.finalize(claim) },
                close: cursor.close,
              }),
            })
          },
        },
        r5: {
          judge: async (input: PersonalFeedV2R5Input) => {
            assertCandidateJudgeView(input.candidates)
            const candidates = input.candidates
            const borrowed = await candidates.borrowCurrent({ signal: input.signal }) as {
              readonly kind?: unknown
              readonly lease?: { readonly completeCurrent: (input: unknown) => Promise<unknown> }
            }
            expect(borrowed.kind, enemy.name).toBe('candidate')
            if (borrowed.kind !== 'candidate' || borrowed.lease === undefined) throw new Error('enemy fixture candidate missing')
            const rawReceipt = await borrowed.lease.completeCurrent({ judgment: 'qualified' }) as { readonly kind?: unknown }
            if (rawReceipt.kind !== 'candidate_judgment_completed') throw new Error('enemy fixture receipt missing')
            const receipt = rawReceipt as PersonalFeedV2CandidateCompletionReceipt
            expect(await candidates.borrowCurrent({ signal: input.signal })).toEqual({ kind: 'done' })
            sawDone = true
            return enemy.claim(receipt)
          },
        },
      })
      const prepared = await coordinator.prepare({ chatId: 4242, messageId: 9450 + index, signal: signal() }) as PreparedResult
      expect(prepared.outcome.kind, enemy.name).toBe('incomplete')
      expect(prepared.outcome.finalText, enemy.name).toBe('这次没有完成：判断或执行未完成。')
      expect(prepared.outcome.finalText, enemy.name).not.toBe('https://x.com/reader_0/status/101')
      expect(prepared.outcome.finalText, enemy.name).not.toBe('这次没有值得看的内容。')
      expect(sawDone, enemy.name).toBe(true)
      expect(finalizeCalled, enemy.name).toBe(1)
    }

    for (const rejection of [
      { name: 'fake selected success without tracked qualified', kind: 'selected' as const, sawDone: true },
      { name: 'fake none success without sawDone', kind: 'none' as const, sawDone: false },
    ]) {
      const directory = mkdtempSync(join(tmpdir(), 'personal-feed-v2-r3-tracker-reject-'))
      temporaryDirectories.push(directory)
      const request: CandidateWindowRequest = {
        requestId: rejection.kind === 'selected' ? 'telegram:4242:9470' : 'telegram:4242:9471',
        cutoff: '2026-08-31T16:00:00.000Z',
        shanghaiDay: '2026-09-01',
      }
      const receipt = Object.freeze({
        kind: 'candidate_judgment_completed' as const,
        stableId: 'x-status:101',
        requestId: request.requestId,
        position: 0,
        judgment: 'not_qualified' as const,
        completedAt: '2026-08-31T16:00:01.000Z',
      })
      const lease = Object.freeze({
        stableId: 'x-status:101',
        canonicalUrl: 'https://x.com/reader/status/101',
        position: 0,
        body: 'tracker-rejection-body',
        provenance: Object.freeze({
          capturedAt: '2026-08-31T16:00:00.000Z',
          surface: 'for_you' as const,
          surfaceOrdinal: 0,
          occurrenceOrdinal: 0,
          canonicalUrl: 'https://x.com/reader/status/101',
          authorHandle: 'tracker-author',
          publishedAt: '2026-08-30T12:34:56.000Z',
        }),
        completeCurrent: async (_input: unknown) => receipt,
      })
      let borrowCalls = 0
      let finalizeCalls = 0
      let closeCalls = 0
      const closeReasons: string[] = []
      const fakeCursor = Object.freeze({
        borrowCurrent: async (_input: { readonly signal: AbortSignal }) => {
          borrowCalls += 1
          return borrowCalls === 1 ? { kind: 'candidate' as const, lease } : { kind: 'done' as const }
        },
        finalize: async (_claim: unknown) => {
          finalizeCalls += 1
          return rejection.kind === 'selected'
            ? { kind: 'selected' as const, selected: { stableId: receipt.stableId, canonicalUrl: lease.canonicalUrl, position: 0 } }
            : { kind: 'none' as const }
        },
        close: async (reason: string) => {
          closeCalls += 1
          closeReasons.push(reason)
        },
      })
      const coordinator = createPersonalFeedV2RequestCoordinator({
        ledgerPath: join(directory, 'requests.jsonl'),
        clock: { now: () => new Date('2026-08-31T16:00:00.000Z') },
        r4: { snapshot: async () => ({ kind: 'sufficient', snapshot: Object.freeze({ source: 'tracker-r4' }) }) },
        r2: { observe: async () => ({ kind: 'complete', window: Object.freeze({ source: 'tracker-r2' }), close: async () => undefined }) },
        r3: {
          admit: async (input: PersonalFeedV2R3Input) => {
            expect(input.request).toEqual(request)
            return { kind: 'admitted', cursor: fakeCursor }
          },
        },
        r5: {
          judge: async (input: PersonalFeedV2R5Input) => {
            assertCandidateJudgeView(input.candidates)
            const candidates = input.candidates
            const first = await candidates.borrowCurrent({ signal: input.signal }) as {
              readonly kind: string
              readonly lease?: { readonly completeCurrent: (input: unknown) => Promise<unknown> }
            }
            expect(first.kind, rejection.name).toBe('candidate')
            if (first.lease === undefined) throw new Error('tracker rejection candidate missing')
            const completed = await first.lease.completeCurrent({ judgment: 'not_qualified' })
            if (rejection.sawDone) expect(await candidates.borrowCurrent({ signal: input.signal })).toEqual({ kind: 'done' })
            return rejection.kind === 'selected'
              ? { kind: 'selected', completed: Object.freeze([completed]), selected: completed }
              : { kind: 'none', completed: Object.freeze([completed]) }
          },
        },
      })
      const prepared = await coordinator.prepare({
        chatId: 4242,
        messageId: rejection.kind === 'selected' ? 9470 : 9471,
        signal: signal(),
      }) as PreparedResult
      expect(prepared.outcome.kind, rejection.name).toBe('incomplete')
      expect(prepared.outcome.finalText, rejection.name).toBe('这次没有完成：判断或执行未完成。')
      expect(prepared.outcome.finalText, rejection.name).not.toBe('https://x.com/reader/status/101')
      expect(prepared.outcome.finalText, rejection.name).not.toBe('这次没有值得看的内容。')
      expect(finalizeCalls, rejection.name).toBe(1)
      expect(closeCalls, rejection.name).toBe(1)
      expect(closeReasons, rejection.name).toEqual(['coordinator_incomplete'])
    }
  })

  it('finalizes or closes every admitted cursor across the exact failure matrix without inventing completion receipts', async () => {
    const cases: readonly B3Case[] = [
      { name: 'A1 r3 exact incomplete', r3: 'incomplete', borrow: [], complete: [], finalize: 'exact_incomplete', r5: 'none', expected: { outcome: 'incomplete', r5: 0, borrow: 0, complete: 0, finalize: 0, close: 0, closeReasons: [], prefixLength: 0 } },
      { name: 'A2 r3 throw', r3: 'throw', borrow: [], complete: [], finalize: 'exact_incomplete', r5: 'none', expected: { outcome: 'incomplete', r5: 0, borrow: 0, complete: 0, finalize: 0, close: 0, closeReasons: [], prefixLength: 0 } },
      { name: 'A3 malformed admitted cursor', r3: 'malformed', borrow: [], complete: [], finalize: 'exact_incomplete', r5: 'none', expected: { outcome: 'incomplete', r5: 0, borrow: 0, complete: 0, finalize: 0, close: 0, closeReasons: [], prefixLength: 0 } },
      { name: 'A4 admit abort exact incomplete', r3: 'abort_inside', borrow: [], complete: [], finalize: 'exact_incomplete', r5: 'none', expected: { outcome: 'incomplete', r5: 0, borrow: 0, complete: 0, finalize: 0, close: 0, closeReasons: [], prefixLength: 0 } },
      { name: 'B1 deferred r3 abort', r3: 'deferred_abort', borrow: [], complete: [], finalize: 'exact_incomplete', r5: 'none', expected: { outcome: 'incomplete', r5: 0, borrow: 0, complete: 0, finalize: 1, close: 1, closeReasons: ['coordinator_incomplete'], prefixLength: 0, finalizeReason: 'aborted' } },
      { name: 'C1 borrow2 incomplete', r3: 'admitted', borrow: ['candidate1', 'incomplete'], complete: ['receipt1'], finalize: 'exact_incomplete', r5: 'none', expected: { outcome: 'incomplete', r5: 1, borrow: 2, complete: 1, finalize: 1, close: 1, closeReasons: ['coordinator_incomplete'], prefixLength: 1, finalizeReason: 'failed' } },
      { name: 'C2 borrow2 throw', r3: 'admitted', borrow: ['candidate1', 'throw'], complete: ['receipt1'], finalize: 'exact_incomplete', r5: 'none', expected: { outcome: 'incomplete', r5: 1, borrow: 2, complete: 1, finalize: 1, close: 1, closeReasons: ['coordinator_incomplete'], prefixLength: 1, finalizeReason: 'failed' } },
      { name: 'C3 borrow2 malformed', r3: 'admitted', borrow: ['candidate1', 'malformed'], complete: ['receipt1'], finalize: 'exact_incomplete', r5: 'none', expected: { outcome: 'incomplete', r5: 1, borrow: 2, complete: 1, finalize: 1, close: 1, closeReasons: ['coordinator_incomplete'], prefixLength: 1, finalizeReason: 'failed' } },
      { name: 'C4 borrow2 abort', r3: 'admitted', borrow: ['candidate1', 'abort'], complete: ['receipt1'], finalize: 'exact_incomplete', r5: 'none', expected: { outcome: 'incomplete', r5: 1, borrow: 2, complete: 1, finalize: 1, close: 1, closeReasons: ['coordinator_incomplete'], prefixLength: 1, finalizeReason: 'aborted' } },
      { name: 'D1 complete2 incomplete', r3: 'admitted', borrow: ['candidate1', 'candidate2'], complete: ['receipt1', 'incomplete'], finalize: 'exact_incomplete', r5: 'none', expected: { outcome: 'incomplete', r5: 1, borrow: 2, complete: 2, finalize: 1, close: 1, closeReasons: ['coordinator_incomplete'], prefixLength: 1, finalizeReason: 'failed' } },
      { name: 'D2 complete2 throw', r3: 'admitted', borrow: ['candidate1', 'candidate2'], complete: ['receipt1', 'throw'], finalize: 'exact_incomplete', r5: 'none', expected: { outcome: 'incomplete', r5: 1, borrow: 2, complete: 2, finalize: 1, close: 1, closeReasons: ['coordinator_incomplete'], prefixLength: 1, finalizeReason: 'failed' } },
      { name: 'D3 complete2 extra wrong identity', r3: 'admitted', borrow: ['candidate1', 'candidate2'], complete: ['receipt1', 'wrong_identity'], finalize: 'exact_incomplete', r5: 'none', expected: { outcome: 'incomplete', r5: 1, borrow: 2, complete: 2, finalize: 1, close: 1, closeReasons: ['coordinator_incomplete'], prefixLength: 1, finalizeReason: 'failed' } },
      { name: 'D4 complete2 abort', r3: 'admitted', borrow: ['candidate1', 'candidate2'], complete: ['receipt1', 'abort'], finalize: 'exact_incomplete', r5: 'none', expected: { outcome: 'incomplete', r5: 1, borrow: 2, complete: 2, finalize: 1, close: 1, closeReasons: ['coordinator_incomplete'], prefixLength: 1, finalizeReason: 'aborted' } },
      { name: 'E1 r5 throw after prefix replay', r3: 'admitted', borrow: ['candidate1'], complete: ['receipt1', 'receipt1'], finalize: 'exact_incomplete', r5: 'throw', expected: { outcome: 'incomplete', r5: 1, borrow: 1, complete: 2, finalize: 1, close: 1, closeReasons: ['coordinator_incomplete'], prefixLength: 1, finalizeReason: 'failed' } },
      { name: 'E2 r5 malformed raw after prefix', r3: 'admitted', borrow: ['candidate1'], complete: ['receipt1'], finalize: 'exact_incomplete', r5: 'malformed_raw', expected: { outcome: 'incomplete', r5: 1, borrow: 1, complete: 1, finalize: 1, close: 1, closeReasons: ['coordinator_incomplete'], prefixLength: 1 } },
      { name: 'E3 r5 abort after success raw', r3: 'admitted', borrow: ['candidate1'], complete: ['receipt1'], finalize: 'exact_incomplete', r5: 'abort_raw', expected: { outcome: 'incomplete', r5: 1, borrow: 1, complete: 1, finalize: 1, close: 1, closeReasons: ['coordinator_incomplete'], prefixLength: 1, finalizeReason: 'aborted' } },
      { name: 'F1 finalize throw after done none', r3: 'admitted', borrow: ['candidate1', 'done'], complete: ['receipt1'], finalize: 'throw', r5: 'none', expected: { outcome: 'incomplete', r5: 1, borrow: 2, complete: 1, finalize: 1, close: 1, closeReasons: ['coordinator_incomplete'], prefixLength: 1 } },
      { name: 'F2 finalize malformed after done none', r3: 'admitted', borrow: ['candidate1', 'done'], complete: ['receipt1'], finalize: 'malformed', r5: 'none', expected: { outcome: 'incomplete', r5: 1, borrow: 2, complete: 1, finalize: 1, close: 1, closeReasons: ['coordinator_incomplete'], prefixLength: 1 } },
      { name: 'F3 finalize extra after done none', r3: 'admitted', borrow: ['candidate1', 'done'], complete: ['receipt1'], finalize: 'extra', r5: 'none', expected: { outcome: 'incomplete', r5: 1, borrow: 2, complete: 1, finalize: 1, close: 1, closeReasons: ['coordinator_incomplete'], prefixLength: 1 } },
    ]
    expect(cases).toHaveLength(19)
    for (const testCase of cases) {
      const observed = await runB3Case(testCase)
      expect({ r4: observed.r4, r2: observed.r2, r3: observed.r3, r5: observed.r5 }, testCase.name)
        .toEqual({ r4: 1, r2: 1, r3: 1, r5: testCase.expected.r5 })
      expect(observed.borrow, testCase.name).toBe(testCase.expected.borrow)
      expect(observed.complete, testCase.name).toBe(testCase.expected.complete)
      expect(observed.finalize, testCase.name).toBe(testCase.expected.finalize)
      expect(observed.close, testCase.name).toBe(testCase.expected.close)
      expect(observed.closeReasons, testCase.name).toEqual(testCase.expected.closeReasons)
      if (testCase.name.startsWith('A3')) expect(observed.malformedCursorCalls, testCase.name).toBe(0)
      expect(observed.finalizeInputs, testCase.name).toHaveLength(testCase.expected.finalize)
      if (testCase.expected.finalizeReason !== undefined) {
        const claim = observed.finalizeInputs[0] as { readonly kind?: unknown; readonly completed?: unknown; readonly reason?: unknown }
        expect(claim.kind, testCase.name).toBe('incomplete')
        expect(claim.reason, testCase.name).toBe(testCase.expected.finalizeReason)
        expect(Object.keys(claim).sort(), testCase.name).toEqual(['completed', 'kind', 'reason'])
        expect(Object.isFrozen(claim.completed), testCase.name).toBe(true)
        expect(Array.isArray(claim.completed), testCase.name).toBe(true)
        expect((claim.completed as readonly unknown[]).length, testCase.name).toBe(testCase.expected.prefixLength)
        expect((claim.completed as readonly unknown[]).every(receipt => receipt === observed.receipt1), testCase.name).toBe(
          testCase.expected.prefixLength === 0 || testCase.expected.prefixLength === 1,
        )
      }
      if (testCase.name.startsWith('E2')) {
        expect(observed.finalizeInputs[0], testCase.name).toBe(observed.malformedRaw)
        expect(observed.finalizeInputs[0], testCase.name).toEqual({
          kind: 'one_link',
          url: 'https://x.com/reader_0/status/101',
          extra: 'RAW_EXTRA',
        })
      }
      if (testCase.name.startsWith('F')) {
        expect(observed.finalizeInputs[0], testCase.name).toMatchObject({ kind: 'none' })
        const claim = observed.finalizeInputs[0] as { readonly completed?: unknown }
        expect(Object.keys(claim).sort(), testCase.name).toEqual(['completed', 'kind'])
        expect(Object.isFrozen(claim.completed), testCase.name).toBe(true)
        expect((claim.completed as readonly unknown[]).length, testCase.name).toBe(1)
        expect((claim.completed as readonly unknown[])[0], testCase.name).toBe(observed.receipt1)
      }
      expect(observed.finalizeInputs.some(input => {
        const value = input as { readonly completed?: readonly unknown[] }
        return value.completed?.some(receipt => receipt !== observed.receipt1) === true
      }), testCase.name).toBe(false)
    }
  })

  it('accepts only descriptor-safe R2 complete results, preserves the close receiver, and fails closed on hostile shapes', async () => {
    const accessorState = { reads: 0 }
    const accessorResult = Object.create(Object.prototype) as Record<string, unknown>
    for (const [key, value] of Object.entries({ kind: 'complete', window: Object.freeze({}), close: () => undefined })) {
      Object.defineProperty(accessorResult, key, { enumerable: true, configurable: true, get: () => { accessorState.reads += 1; return value } })
    }
    const proxyState = { traps: 0 }
    const proxyTarget = { kind: 'complete', window: Object.freeze({}), close: () => undefined }
    const proxyResult = new Proxy(proxyTarget, {
      get: () => { proxyState.traps += 1; return undefined },
      ownKeys: () => { proxyState.traps += 1; return Reflect.ownKeys(proxyTarget) },
      getOwnPropertyDescriptor: () => { proxyState.traps += 1; return undefined },
      getPrototypeOf: () => { proxyState.traps += 1; return Object.prototype },
    })
    const hostileResults: readonly { readonly name: string; readonly value: unknown; readonly touches: () => number }[] = [
      { name: 'old two-key result', value: { kind: 'complete', window: Object.freeze({ old: true }) }, touches: () => 0 },
      { name: 'extra key', value: { kind: 'complete', window: Object.freeze({}), close: () => undefined, extra: true }, touches: () => 0 },
      {
        name: 'symbol key',
        value: Object.assign({ kind: 'complete', window: Object.freeze({}), close: () => undefined }, { [Symbol('extra')]: true }),
        touches: () => 0,
      },
      {
        name: 'accessor result',
        value: accessorResult,
        touches: () => accessorState.reads,
      },
      {
        name: 'proxy result',
        value: proxyResult,
        touches: () => proxyState.traps,
      },
    ]

    for (const hostile of hostileResults) {
      const directory = mkdtempSync(join(tmpdir(), 'personal-feed-v2-r2-shape-'))
      temporaryDirectories.push(directory)
      const calls = { r2: 0, r3: 0, r5: 0, close: 0 }
      const coordinator = createPersonalFeedV2RequestCoordinator({
        ledgerPath: join(directory, 'requests.jsonl'),
        clock: { now: () => new Date('2026-08-31T16:00:00.000Z') },
        r4: { snapshot: async () => ({ kind: 'sufficient', snapshot: Object.freeze({ safe: true }) }) },
        r2: { observe: () => { calls.r2 += 1; return hostile.value } },
        r3: { admit: async () => { calls.r3 += 1; return { kind: 'incomplete', reason: 'failed' } } },
        r5: { judge: async () => { calls.r5 += 1; return { kind: 'none', completed: [] } } },
      })
      const prepared = await coordinator.prepare({ chatId: 42, messageId: 700 + calls.r2, signal: signal() }) as PreparedResult
      expect(prepared.outcome.kind, hostile.name).toBe('incomplete')
      expect(prepared.outcome.category, hostile.name).toBe('source_window')
      expect(calls, hostile.name).toEqual({ r2: 1, r3: 0, r5: 0, close: 0 })
      expect(hostile.touches(), hostile.name).toBe(0)
    }

    const directory = mkdtempSync(join(tmpdir(), 'personal-feed-v2-r2-safe-close-'))
    temporaryDirectories.push(directory)
    const order: string[] = []
    let cursorReceiver: unknown
    let cursorCloseCalls = 0
    const cursor = Object.freeze({
      borrowCurrent: async () => { order.push('borrow'); return { kind: 'done' as const } },
      finalize: async (claim: unknown) => { order.push('finalize'); expect(claim).toMatchObject({ kind: 'none' }); return { kind: 'none' as const } },
      close: async function (this: unknown) { cursorReceiver = this; cursorCloseCalls += 1; order.push('cursor-close') },
    })
    let r2Receiver: unknown
    let r2CloseCalls = 0
    const r2 = Object.freeze({
      kind: 'complete' as const,
      window: Object.freeze({ source: 'safe-window' }),
      close: async function (this: unknown) { r2Receiver = this; r2CloseCalls += 1; order.push('r2-close') },
    })
    const coordinator = createPersonalFeedV2RequestCoordinator({
      ledgerPath: join(directory, 'requests.jsonl'),
      clock: { now: () => new Date('2026-08-31T16:00:00.000Z') },
      r4: { snapshot: async () => ({ kind: 'sufficient', snapshot: Object.freeze({ safe: true }) }) },
      r2: { observe: async () => r2 },
      r3: { admit: async () => { order.push('r3'); return { kind: 'admitted', cursor } } },
      r5: { judge: async (input) => { order.push('r5'); await input.candidates.borrowCurrent({ signal: input.signal }); return { kind: 'none', completed: [] } } },
    })
    const prepared = await coordinator.prepare({ chatId: 42, messageId: 799, signal: signal() }) as PreparedResult
    expect(prepared.outcome.kind).toBe('business_empty')
    expect(r2CloseCalls).toBe(1)
    expect(r2Receiver).toBe(r2)
    expect(cursorCloseCalls).toBe(1)
    expect(cursorReceiver).toBe(cursor)
    expect(order.indexOf('r3')).toBeLessThan(order.indexOf('r2-close'))
    expect(order.indexOf('r2-close')).toBeLessThan(order.indexOf('r5'))
  })

  it('terminally attempts R2 cleanup after every incomplete, throw, malformed, pre-aborted, and deferred-abort R3 result', async () => {
    const variants = ['incomplete', 'throw', 'malformed', 'pre', 'deferred_abort'] as const
    for (const variant of variants) {
      const directory = mkdtempSync(join(tmpdir(), 'personal-feed-v2-r3-abort-table-'))
      temporaryDirectories.push(directory)
      const controller = new AbortController()
      const requestId = `telegram:42:${810 + variants.indexOf(variant)}`
      const request: CandidateWindowRequest = { requestId, cutoff: '2026-08-31T16:00:00.000Z', shanghaiDay: '2026-09-01' }
      const counters: CandidateCaptureCounters[] = [
        { take: 0, close: 0, reasons: [] }, { take: 0, close: 0, reasons: [] }, { take: 0, close: 0, reasons: [] },
      ]
      const window = closeAwareCandidateWindow(request, counters)
      const body = (window.surfaces[0]!.occurrences[0]!.body as { readonly capture: { readonly take: Function } }).capture
      const calls = { r2: 0, r3: 0, r5: 0, r2Close: 0 }
      let release: ((value: unknown) => void) | undefined
      const cursor = Object.freeze({
        borrowCurrent: async () => ({ kind: 'done' as const }),
        finalize: async () => ({ kind: 'none' as const }),
        close: async () => undefined,
      })
      const r2 = Object.freeze({
        kind: 'complete' as const,
        window,
        close: async () => {
          calls.r2Close += 1
          for (const surface of window.surfaces) for (const occurrence of surface.occurrences) {
            const body = occurrence.body as { readonly capture?: { readonly close: () => Promise<void> }; readonly close?: () => Promise<void> }
            if (body.capture !== undefined) await body.capture.close()
            else if (body.close !== undefined) await body.close()
          }
        },
      })
      const coordinator = createPersonalFeedV2RequestCoordinator({
        ledgerPath: join(directory, 'requests.jsonl'),
        clock: { now: () => new Date('2026-08-31T16:00:00.000Z') },
        r4: { snapshot: async () => ({ kind: 'sufficient', snapshot: Object.freeze({ source: 'r4' }) }) },
        r2: {
          observe: async () => {
            calls.r2 += 1
            if (variant === 'pre') controller.abort()
            return r2
          },
        },
        r3: {
          admit: async () => {
            calls.r3 += 1
            if (variant === 'throw') throw new Error('R3 failed')
            if (variant === 'malformed') return { kind: 'admitted', cursor: { borrowCurrent: async () => ({ kind: 'done' }) } }
            if (variant === 'incomplete' || variant === 'pre') return { kind: 'incomplete', reason: 'failed' }
            return new Promise(resolve => { release = resolve })
          },
        },
        r5: { judge: async () => { calls.r5 += 1; return { kind: 'none', completed: [] } } },
      })
      const pending = coordinator.prepare({ chatId: 42, messageId: 810 + variants.indexOf(variant), signal: controller.signal })
      if (variant === 'deferred_abort') {
        for (let attempt = 0; attempt < 10 && release === undefined; attempt += 1) await Promise.resolve()
        expect(release, variant).toBeTypeOf('function')
        controller.abort()
        release!({ kind: 'incomplete', reason: 'aborted' })
      }
      const prepared = await pending as PreparedResult
      expect(prepared.outcome.kind, variant).toBe('incomplete')
      const expectedCalls = variant === 'pre'
        ? { r2: 1, r3: 0, r5: 0, r2Close: 1 }
        : { r2: 1, r3: 1, r5: 0, r2Close: 1 }
      expect(prepared.outcome.category, variant).toBe(variant === 'pre' ? 'source_window' : 'judgement_execution')
      expect(calls, variant).toEqual(expectedCalls)
      expect(body.take({ signal: controller.signal }), variant).toBeUndefined()
    }
  })

  it('bounds sync, rejected, and never-settling R2 close failures after admitted R3 while retaining the cursor failure owner', async () => {
    const variants = ['throw', 'reject', 'pending'] as const
    for (const variant of variants) {
      const directory = mkdtempSync(join(tmpdir(), 'personal-feed-v2-r2-close-failure-'))
      temporaryDirectories.push(directory)
      const controller = new AbortController()
      const calls = { r2: 0, r3: 0, r5: 0, cursorClose: 0 }
      let releaseClose: (() => void) | undefined
      const cursor = Object.freeze({
        borrowCurrent: async () => ({ kind: 'done' as const }),
        finalize: async () => ({ kind: 'none' as const }),
        close: async () => { calls.cursorClose += 1 },
      })
      const r2 = Object.freeze({
        kind: 'complete' as const,
        window: Object.freeze({ source: 'r2-close-failure' }),
        close: () => {
          if (variant === 'throw') throw new Error('R2 close throw')
          if (variant === 'reject') return Promise.reject(new Error('R2 close reject'))
          return new Promise<void>(resolve => { releaseClose = resolve })
        },
      })
      const coordinator = createPersonalFeedV2RequestCoordinator({
        ledgerPath: join(directory, 'requests.jsonl'),
        clock: { now: () => new Date('2026-08-31T16:00:00.000Z') },
        r4: { snapshot: async () => ({ kind: 'sufficient', snapshot: Object.freeze({ source: 'r4' }) }) },
        r2: { observe: async () => { calls.r2 += 1; return r2 } },
        r3: { admit: async () => { calls.r3 += 1; return { kind: 'admitted', cursor } } },
        r5: { judge: async () => { calls.r5 += 1; return { kind: 'none', completed: [] } } },
      })
      const started = Date.now()
      const preparing = coordinator.prepare({ chatId: 42, messageId: 850 + variants.indexOf(variant), signal: controller.signal })
      let timeout: ReturnType<typeof setTimeout> | undefined
      const prepared = (variant === 'pending'
        ? await Promise.race([
            preparing,
            new Promise<PreparedResult>(resolve => { timeout = setTimeout(() => resolve(undefined as unknown as PreparedResult), 700) }),
          ])
        : await preparing) as PreparedResult
      if (timeout !== undefined) clearTimeout(timeout)
      expect(Date.now() - started, variant).toBeLessThan(1_500)
      expect(prepared.outcome.kind, variant).toBe('incomplete')
      expect(prepared.outcome.category, variant).toBe('source_window')
      expect(calls.r5, variant).toBe(0)
      expect(calls.cursorClose, variant).toBe(1)
      if (variant === 'pending') releaseClose!()
    }
  })

  it('finalizes each valid cursor at most once, closes it on every R5 outcome, and only preserves proven selected or none', async () => {
    const cases = [
      { name: 'selected', r5: 'selected', finalize: 'selected', outcome: 'one_link' },
      { name: 'none', r5: 'none', finalize: 'none', outcome: 'business_empty' },
      { name: 'incomplete', r5: 'incomplete', finalize: 'incomplete', outcome: 'incomplete' },
      { name: 'throw', r5: 'throw', finalize: 'incomplete', outcome: 'incomplete' },
      { name: 'malformed', r5: 'malformed', finalize: 'malformed', outcome: 'incomplete' },
      { name: 'abort', r5: 'abort', finalize: 'selected', outcome: 'incomplete' },
      { name: 'borrow throw', r5: 'borrow_throw', finalize: 'incomplete', outcome: 'incomplete' },
      { name: 'complete throw', r5: 'complete_throw', finalize: 'incomplete', outcome: 'incomplete' },
      { name: 'finalize throw', r5: 'none', finalize: 'throw', outcome: 'incomplete' },
    ] as const
    for (const testCase of cases) {
      const directory = mkdtempSync(join(tmpdir(), 'personal-feed-v2-r5-matrix-'))
      temporaryDirectories.push(directory)
      const controller = new AbortController()
      const requestId = `telegram:42:${900 + cases.indexOf(testCase)}`
      const receipt = Object.freeze({
        kind: 'candidate_judgment_completed' as const,
        stableId: 'x-status:901',
        requestId,
        position: 0,
        judgment: 'not_qualified' as const,
        completedAt: '2026-08-31T16:00:01.000Z',
      })
      const qualifiedReceipt = Object.freeze({ ...receipt, judgment: 'qualified' as const })
      const lease = Object.freeze({
        stableId: 'x-status:901', canonicalUrl: 'https://x.com/fixture/status/901', position: 0, body: 'candidate body',
        provenance: Object.freeze({
          capturedAt: '2026-08-31T16:00:00.000Z', surface: 'for_you' as const, surfaceOrdinal: 0,
          occurrenceOrdinal: 0, canonicalUrl: 'https://x.com/fixture/status/901', authorHandle: 'fixture',
          publishedAt: '2026-08-31T15:00:00.000Z',
        }),
        completeCurrent: async (input: { readonly judgment?: unknown }) => {
          if (testCase.r5 === 'complete_throw') throw new Error('completion throw')
          if (testCase.r5 === 'selected') {
            expect(input.judgment, testCase.name).toBe('qualified')
            return qualifiedReceipt
          }
          expect(input.judgment, testCase.name).toBe('not_qualified')
          return receipt
        },
      })
      const observations = { borrow: 0, complete: 0, finalize: 0, close: 0 }
      const cursor = Object.freeze({
        borrowCurrent: async () => {
          observations.borrow += 1
          if (testCase.r5 === 'borrow_throw') throw new Error('borrow throw')
          return observations.borrow === 1 ? { kind: 'candidate' as const, lease } : { kind: 'done' as const }
        },
        finalize: async (claim: unknown) => {
          observations.finalize += 1
          expect(observations.finalize, testCase.name).toBe(1)
          if (testCase.finalize === 'throw') throw new Error('finalize throw')
          if (testCase.finalize === 'malformed') return { kind: 'none', extra: 'FINALIZE_EXTRA' }
          if (testCase.finalize === 'selected') return {
            kind: 'selected' as const,
            selected: { stableId: receipt.stableId, canonicalUrl: lease.canonicalUrl, position: 0 },
          }
          if (testCase.finalize === 'none') return { kind: 'none' as const }
          expect(claim).toMatchObject({ kind: 'incomplete' })
          return { kind: 'incomplete' as const, reason: 'failed' as const }
        },
        close: async () => { observations.close += 1 },
      })
      const coordinator = createPersonalFeedV2RequestCoordinator({
        ledgerPath: join(directory, 'requests.jsonl'),
        clock: { now: () => new Date('2026-08-31T16:00:02.000Z') },
        r4: { snapshot: async () => ({ kind: 'sufficient', snapshot: Object.freeze({ safe: true }) }) },
        r2: { observe: async () => ({ kind: 'complete', window: Object.freeze({ source: 'r2' }), close: async () => undefined }) },
        r3: { admit: async () => ({ kind: 'admitted', cursor }) },
        r5: {
          judge: async (input) => {
            if (testCase.r5 === 'throw') throw new Error('judge throw')
            if (testCase.r5 === 'incomplete') return { kind: 'incomplete', completed: [], reason: 'failed' }
            const first = await input.candidates.borrowCurrent({ signal: input.signal })
            if (testCase.r5 === 'borrow_throw') return { kind: 'none', completed: [] }
            if (first.kind === 'candidate') {
              observations.complete += 1
              const completed = await first.lease.completeCurrent({
                judgment: testCase.r5 === 'selected' ? 'qualified' : 'not_qualified',
              })
              if (testCase.r5 === 'abort') controller.abort()
              await input.candidates.borrowCurrent({ signal: input.signal })
              if (testCase.r5 === 'malformed') return { kind: 'none', completed: [completed], extra: 'R5_EXTRA' }
              if (testCase.r5 === 'selected') return { kind: 'selected', completed: [completed], selected: completed }
              return { kind: 'none', completed: [completed] }
            }
            return { kind: 'none', completed: [] }
          },
        },
      })
      const prepared = await coordinator.prepare({ chatId: 42, messageId: 900 + cases.indexOf(testCase), signal: controller.signal }) as PreparedResult
      expect(prepared.outcome.kind, testCase.name).toBe(testCase.outcome)
      expect(observations.finalize, testCase.name).toBe(1)
      expect(observations.close, testCase.name).toBe(1)
      if (testCase.name === 'selected') expect(prepared.outcome.finalText).toBe('https://x.com/fixture/status/901')
      if (testCase.name === 'none') expect(prepared.outcome.finalText).toBe('这次没有值得看的内容。')
      if (testCase.outcome === 'incomplete') expect(prepared.outcome.finalText).toBe('这次没有完成：判断或执行未完成。')
    }
  })

  it('retries a rejected cursor close through synchronous settle with the same receiver and never reopens the old owner', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'personal-feed-v2-close-retry-'))
    temporaryDirectories.push(directory)
    let closeReceiver: unknown
    let closeCalls = 0
    let cursor!: object
    const close = async function (this: unknown) {
      closeReceiver = this
      closeCalls += 1
      if (closeCalls === 1) throw new Error('first close reject')
    }
    cursor = Object.freeze({
      borrowCurrent: async () => ({ kind: 'done' as const }),
      finalize: async () => ({ kind: 'none' as const, extra: 'MALFORMED_FINALIZE' }),
      close,
    })
    let r4Calls = 0
    const coordinator = createPersonalFeedV2RequestCoordinator({
      ledgerPath: join(directory, 'requests.jsonl'),
      clock: { now: () => new Date('2026-08-31T16:00:00.000Z') },
      r4: { snapshot: async () => { r4Calls += 1; return { kind: 'sufficient', snapshot: Object.freeze({ safe: true }) } } },
      r2: { observe: async () => ({ kind: 'complete', window: Object.freeze({ source: 'r2' }), close: async () => undefined }) },
      r3: { admit: async () => ({ kind: 'admitted', cursor }) },
      r5: { judge: async () => ({ kind: 'none', completed: [] }) },
    })
    const prepared = await coordinator.prepare({ chatId: 42, messageId: 980, signal: signal() }) as PreparedResult
    expect(prepared.outcome.kind).toBe('incomplete')
    const receipt: Receipt = {
      chatId: 42, triggerMessageId: 980, visibleText: prepared.outcome.finalText, messageIds: [1],
    }
    expect(() => prepared.settle(receipt)).not.toThrow()
    expect(prepared.settle(receipt)).toBeUndefined()
    expect(closeCalls).toBe(2)
    expect(closeReceiver).toBe(cursor)
    expect(await coordinator.prepare({ chatId: 42, messageId: 980, signal: signal() })).toEqual({ kind: 'duplicate_consumed' })
    expect(r4Calls).toBe(1)
    expect(closeCalls).toBe(2)
  })

  it('keeps one pending cursor-close attempt single-flight across settle and duplicate prepare, then permits a later request after late fulfillment', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'personal-feed-v2-close-pending-'))
    temporaryDirectories.push(directory)
    let releaseClose!: () => void
    let closeCalls = 0
    let closeReceiver: unknown
    const pendingClose = new Promise<void>(resolve => { releaseClose = resolve })
    const cursor = Object.freeze({
      borrowCurrent: async () => ({ kind: 'done' as const }),
      finalize: async () => ({ kind: 'none', extra: 'MALFORMED_FINALIZE' }),
      close: async function (this: unknown) { closeReceiver = this; closeCalls += 1; return pendingClose },
    })
    const calls = { r4: 0, r2: 0, r3: 0, r5: 0 }
    const coordinator = createPersonalFeedV2RequestCoordinator({
      ledgerPath: join(directory, 'requests.jsonl'),
      clock: { now: () => new Date('2026-08-31T16:00:00.000Z') },
      r4: { snapshot: async () => { calls.r4 += 1; return { kind: 'sufficient', snapshot: Object.freeze({ safe: true }) } } },
      r2: { observe: async () => { calls.r2 += 1; return { kind: 'complete', window: Object.freeze({ source: 'r2' }), close: async () => undefined } } },
      r3: {
        admit: async (input) => {
          calls.r3 += 1
          return input.request.requestId.endsWith(':991') || input.request.requestId.endsWith(':992')
            ? { kind: 'incomplete' as const, reason: 'failed' as const }
            : { kind: 'admitted' as const, cursor }
        },
      },
      r5: {
        judge: async (input) => {
          calls.r5 += 1
          expect(await input.candidates.borrowCurrent({ signal: input.signal })).toEqual({ kind: 'done' })
          return { kind: 'none', completed: [] }
        },
      },
    })
    const started = Date.now()
    const preparing = coordinator.prepare({ chatId: 42, messageId: 990, signal: signal() })
    let timeout: ReturnType<typeof setTimeout> | undefined
    const prepared = await Promise.race([
      preparing,
      new Promise<PreparedResult>(resolve => { timeout = setTimeout(() => resolve(undefined as unknown as PreparedResult), 700) }),
    ]) as PreparedResult
    if (timeout !== undefined) clearTimeout(timeout)
    expect(Date.now() - started).toBeLessThan(1_500)
    expect(prepared.outcome.kind).toBe('incomplete')
    const receipt: Receipt = { chatId: 42, triggerMessageId: 990, visibleText: prepared.outcome.finalText, messageIds: [1] }
    expect(() => prepared.settle(receipt)).not.toThrow()
    expect(await coordinator.prepare({ chatId: 42, messageId: 990, signal: signal() })).toEqual({ kind: 'duplicate_consumed' })
    expect(closeCalls).toBe(1)
    expect(closeReceiver).toBe(cursor)
    expect(calls.r5).toBe(1)
    const blocked = await coordinator.prepare({ chatId: 42, messageId: 991, signal: signal() }) as PreparedResult
    expect(blocked.outcome.kind).toBe('incomplete')
    expect(blocked.outcome.category).toBe('judgement_execution')
    expect(blocked.outcome.finalText).not.toContain('candidate-body')
    expect(calls).toEqual({ r4: 1, r2: 1, r3: 1, r5: 1 })
    releaseClose()
    await preparing
    const later = await coordinator.prepare({ chatId: 42, messageId: 992, signal: signal() }) as PreparedResult
    expect(later.outcome.kind).toBe('incomplete')
    expect(calls).toEqual({ r4: 2, r2: 2, r3: 2, r5: 1 })
    expect(closeCalls).toBe(1)
  })

  it('attempts owner terminal cleanup before an outcome ledger append, and keeps body-free delivery failures outside lifecycle ownership', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'personal-feed-v2-ledger-order-'))
    temporaryDirectories.push(directory)
    const ledgerPath = join(directory, 'requests.jsonl')
    const order: string[] = []
    const cursor = Object.freeze({
      borrowCurrent: async () => { order.push('borrow'); return { kind: 'done' as const } },
      finalize: async () => { order.push('finalize'); return { kind: 'none' as const } },
      close: async () => { order.push('cursor-close') },
    })
    const coordinator = createPersonalFeedV2RequestCoordinator({
      ledgerPath,
      clock: { now: () => new Date('2026-08-31T16:00:00.000Z') },
      r4: { snapshot: async () => ({ kind: 'sufficient', snapshot: Object.freeze({ safe: true }) }) },
      r2: { observe: async () => ({ kind: 'complete', window: Object.freeze({ source: 'r2' }), close: async () => { order.push('r2-close') } }) },
      r3: { admit: async () => ({ kind: 'admitted', cursor }) },
      r5: {
        judge: async (input) => {
          order.push('r5')
          await input.candidates.borrowCurrent({ signal: input.signal })
          // Force the subsequent outcome_prepared append to fail after the open record exists.
          rmSync(ledgerPath, { force: true })
          mkdirSync(ledgerPath)
          return { kind: 'none', completed: [] }
        },
      },
    })
    const failure = await coordinator.prepare({ chatId: 42, messageId: 1001, signal: signal() }).catch(error => error)
    expect(failure).toBeInstanceOf(Error)
    expect(order.indexOf('r2-close')).toBeGreaterThanOrEqual(0)
    expect(order.indexOf('r2-close')).toBeLessThan(order.indexOf('r5'))
    expect(order.indexOf('cursor-close')).toBeGreaterThan(order.indexOf('r5'))
    const diagnostic = String(failure)
    expect(diagnostic).not.toContain('BODY_CANARY')
    expect(diagnostic).not.toContain('candidate body')

    const successDirectory = mkdtempSync(join(tmpdir(), 'personal-feed-v2-fake-delivery-'))
    temporaryDirectories.push(successDirectory)
    let ownerCloseCalls = 0
    const successCursor = Object.freeze({
      borrowCurrent: async () => ({ kind: 'done' as const }),
      finalize: async () => ({ kind: 'none' as const }),
      close: async () => { ownerCloseCalls += 1 },
    })
    const successCoordinator = createPersonalFeedV2RequestCoordinator({
      ledgerPath: join(successDirectory, 'requests.jsonl'),
      clock: { now: () => new Date('2026-08-31T16:00:00.000Z') },
      r4: { snapshot: async () => ({ kind: 'sufficient', snapshot: Object.freeze({ safe: true }) }) },
      r2: { observe: async () => ({ kind: 'complete', window: Object.freeze({ source: 'r2' }), close: async () => undefined }) },
      r3: { admit: async () => ({ kind: 'admitted', cursor: successCursor }) },
      r5: { judge: async (input) => { await input.candidates.borrowCurrent({ signal: input.signal }); return { kind: 'none', completed: [] } } },
    })
    const prepared = await successCoordinator.prepare({ chatId: 42, messageId: 1002, signal: signal() }) as PreparedResult
    const beforeDelivery = ownerCloseCalls
    const fakeDelivery = (outcome: unknown): never => {
      expect(JSON.stringify(outcome)).not.toContain('candidate body')
      expect(JSON.stringify(outcome)).not.toContain('BODY_CANARY')
      throw new Error('fake delivery failed')
    }
    expect(() => fakeDelivery(prepared.outcome)).toThrow('fake delivery failed')
    expect(ownerCloseCalls).toBe(beforeDelivery)
  })

  it('salvages only a cleanup-only close from a malformed admitted cursor after R3 has taken an R2 capture', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'personal-feed-v2-salvage-close-'))
    temporaryDirectories.push(directory)
    const request: CandidateWindowRequest = { requestId: 'telegram:42:1010', cutoff: '2026-08-31T16:00:00.000Z', shanghaiDay: '2026-09-01' }
    const counters: CandidateCaptureCounters[] = [
      { take: 0, close: 0, reasons: [] }, { take: 0, close: 0, reasons: [] }, { take: 0, close: 0, reasons: [] },
    ]
    const window = closeAwareCandidateWindow(request, counters)
    const capture = (window.surfaces[0]!.occurrences[0]!.body as { readonly capture: { readonly take: Function } }).capture
    const order: string[] = []
    let malformedCursor!: Record<string, unknown>
    malformedCursor = {
      borrowCurrent: 'not callable',
      finalize: 'not callable',
      close: function (this: Record<string, unknown>) { expect(this).toBe(malformedCursor); order.push('cursor-close') },
    }
    const coordinator = createPersonalFeedV2RequestCoordinator({
      ledgerPath: join(directory, 'requests.jsonl'),
      clock: { now: () => new Date('2026-08-31T16:00:00.000Z') },
      r4: { snapshot: async () => ({ kind: 'sufficient', snapshot: Object.freeze({ safe: true }) }) },
      r2: {
        observe: async () => ({
          kind: 'complete', window,
          close: async () => { order.push('r2-close'); for (const surface of window.surfaces) for (const occurrence of surface.occurrences) {
            const body = occurrence.body as { readonly capture?: { readonly close: () => Promise<void> }; readonly close?: () => Promise<void> }
            if (body.capture !== undefined) await body.capture.close()
            else if (body.close !== undefined) await body.close()
          } },
        }),
      },
      r3: {
        admit: async (input) => {
          const taken = capture.take({ signal: input.signal })
          expect(taken).toBe('candidate-body-101')
          expect(counters[0]!.take).toBe(1)
          return { kind: 'admitted', cursor: malformedCursor }
        },
      },
      r5: { judge: async () => { throw new Error('R5 must not run') } },
    })
    const prepared = await coordinator.prepare({ chatId: 42, messageId: 1010, signal: signal() }) as PreparedResult
    expect(prepared.outcome.kind).toBe('incomplete')
    expect(prepared.outcome.category).toBe('judgement_execution')
    expect(order).toEqual(['r2-close', 'cursor-close'])
    expect(counters.every(counter => counter.take <= 1)).toBe(true)
    expect(counters.every(counter => counter.close === 1)).toBe(true)
  })

  it('rejects every admitted cursor shape without a safe close while closing only R2 and never taking a body', async () => {
    const variants = ['no close', 'accessor', 'inherited', 'nonfunction', 'symbol', 'nonenumerable', 'wrong prototype', 'proxy'] as const
    for (const variant of variants) {
      const directory = mkdtempSync(join(tmpdir(), 'personal-feed-v2-no-safe-close-'))
      temporaryDirectories.push(directory)
      const request: CandidateWindowRequest = { requestId: `telegram:42:${1030 + variants.indexOf(variant)}`, cutoff: '2026-08-31T16:00:00.000Z', shanghaiDay: '2026-09-01' }
      const counters: CandidateCaptureCounters[] = [
        { take: 0, close: 0, reasons: [] }, { take: 0, close: 0, reasons: [] }, { take: 0, close: 0, reasons: [] },
      ]
      const window = closeAwareCandidateWindow(request, counters)
      const capture = (window.surfaces[0]!.occurrences[0]!.body as { readonly capture: { readonly take: Function; readonly close: Function } }).capture
      let touches = 0
      const base = { borrowCurrent: async () => ({ kind: 'done' }), finalize: async () => ({ kind: 'none' }) }
      let cursor: unknown
      if (variant === 'no close') cursor = base
      else if (variant === 'accessor') cursor = Object.defineProperty({ ...base }, 'close', { enumerable: true, get: () => { touches += 1; return async () => undefined } })
      else if (variant === 'inherited') cursor = Object.assign(Object.create({ close: async () => undefined }), base)
      else if (variant === 'nonfunction') cursor = { ...base, close: 'bad' }
      else if (variant === 'symbol') cursor = Object.assign({ ...base, close: async () => undefined }, { [Symbol('extra')]: true })
      else if (variant === 'nonenumerable') {
        cursor = { ...base }
        Object.defineProperty(cursor, 'close', { value: async () => undefined, enumerable: false })
      } else if (variant === 'wrong prototype') cursor = Object.assign(Object.create({ wrong: true }), { ...base, close: async () => undefined })
      else {
        const target = { ...base, close: async () => undefined }
        cursor = new Proxy(target, {
          get: () => { touches += 1; return undefined }, ownKeys: () => { touches += 1; return Reflect.ownKeys(target) },
          getOwnPropertyDescriptor: () => { touches += 1; return undefined }, getPrototypeOf: () => { touches += 1; return Object.prototype },
        })
      }
      let r2Close = 0
      const coordinator = createPersonalFeedV2RequestCoordinator({
        ledgerPath: join(directory, 'requests.jsonl'),
        clock: { now: () => new Date('2026-08-31T16:00:00.000Z') },
        r4: { snapshot: async () => ({ kind: 'sufficient', snapshot: Object.freeze({ safe: true }) }) },
        r2: {
          observe: async () => ({ kind: 'complete', window, close: async () => {
            r2Close += 1
            for (const surface of window.surfaces) for (const occurrence of surface.occurrences) {
              const body = occurrence.body as { readonly capture?: { readonly close: () => Promise<void> }; readonly close?: () => Promise<void> }
              if (body.capture !== undefined) await body.capture.close()
              else if (body.close !== undefined) await body.close()
            }
          } }),
        },
        r3: { admit: async () => ({ kind: 'admitted', cursor }) },
        r5: { judge: async () => { throw new Error('R5 must not run') } },
      })
      const prepared = await coordinator.prepare({ chatId: 42, messageId: 1030 + variants.indexOf(variant), signal: signal() }) as PreparedResult
      expect(prepared.outcome.kind, variant).toBe('incomplete')
      expect(prepared.outcome.category, variant).toBe('judgement_execution')
      expect(r2Close, variant).toBe(1)
      expect(counters[0]!.take, variant).toBe(0)
      expect(capture.take({ signal: signal() }), variant).toBeUndefined()
      expect(touches, variant).toBe(0)
    }
  })
})
