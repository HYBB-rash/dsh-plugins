import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createPersonalFeedV2RequestCoordinator,
  personalFeedV2TelegramRequestId,
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
  | { readonly kind: 'complete'; readonly window: unknown }
  | { readonly kind: 'partial' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'unknown' }
type R3Result =
  | { readonly kind: 'admitted'; readonly candidates: unknown }
  | { readonly kind: 'insufficient' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'unknown' }
type R5Result =
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
        }) satisfies R2Result)
      },
    },
    r3: {
      admit: async (_input: unknown): Promise<unknown> => {
        calls.r3 += 1
        return resultOrThrow(overrides.r3, Object.freeze({
          kind: 'admitted',
          candidates: Object.freeze([{ source: 'r3', candidate: 'one' }]),
        }) satisfies R3Result)
      },
    },
    r5: {
      judge: async (_input: unknown): Promise<unknown> => {
        calls.r5 += 1
        return resultOrThrow(overrides.r5, Object.freeze({
          kind: 'one_link',
          url: 'https://x.com/reader/status/42',
        }) satisfies R5Result)
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
    const r3Candidates = Object.freeze([
      Object.freeze({ marker: 'R3_ADMITTED_CANDIDATE', url: 'https://x.com/reader/status/42' }),
    ])
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
          return Object.freeze({ kind: 'complete', window: r2Window }) satisfies R2Result
        },
      },
      r3: {
        admit: async (input: PersonalFeedV2R3Input) => {
          portCalls.r3 += 1
          r3Input = input
          return Object.freeze({ kind: 'admitted', candidates: r3Candidates }) satisfies R3Result
        },
      },
      r5: {
        judge: async (input: PersonalFeedV2R5Input) => {
          portCalls.r5 += 1
          r5Input = input
          return Object.freeze({ kind: 'one_link', url: 'https://x.com/reader/status/42' }) satisfies R5Result
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
    expect(r5Input!.candidates).toBe(r3Candidates)
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
      overrides: { r5: Object.freeze({ kind: 'one_link', url: 'https://twitter.com/Some_User/status/42' }) satisfies R5Result },
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
      overrides: { r5: Object.freeze({ kind: 'none' }) satisfies R5Result },
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
    ['R3 insufficient', 'r3', Object.freeze({ kind: 'insufficient' }) satisfies R3Result, { kind: 'incomplete', category: 'judgement_execution', finalText: '这次没有完成：判断或执行未完成。' }, { r4: 1, r2: 1, r3: 1, r5: 0 }],
    ['R3 failed', 'r3', Object.freeze({ kind: 'failed' }) satisfies R3Result, { kind: 'incomplete', category: 'judgement_execution', finalText: '这次没有完成：判断或执行未完成。' }, { r4: 1, r2: 1, r3: 1, r5: 0 }],
    ['R3 unknown', 'r3', Object.freeze({ kind: 'unknown' }) satisfies R3Result, { kind: 'incomplete', category: 'judgement_execution', finalText: '这次没有完成：判断或执行未完成。' }, { r4: 1, r2: 1, r3: 1, r5: 0 }],
    ['R3 throw', 'r3', () => { throw new Error('R3 unavailable') }, { kind: 'incomplete', category: 'judgement_execution', finalText: '这次没有完成：判断或执行未完成。' }, { r4: 1, r2: 1, r3: 1, r5: 0 }],
    ['R3 malformed', 'r3', Object.freeze({ malformed: true }), { kind: 'incomplete', category: 'judgement_execution', finalText: '这次没有完成：判断或执行未完成。' }, { r4: 1, r2: 1, r3: 1, r5: 0 }],
    ['R5 insufficient', 'r5', Object.freeze({ kind: 'insufficient' }) satisfies R5Result, { kind: 'incomplete', category: 'judgement_execution', finalText: '这次没有完成：判断或执行未完成。' }, { r4: 1, r2: 1, r3: 1, r5: 1 }],
    ['R5 failed', 'r5', Object.freeze({ kind: 'failed' }) satisfies R5Result, { kind: 'incomplete', category: 'judgement_execution', finalText: '这次没有完成：判断或执行未完成。' }, { r4: 1, r2: 1, r3: 1, r5: 1 }],
    ['R5 unknown', 'r5', Object.freeze({ kind: 'unknown' }) satisfies R5Result, { kind: 'incomplete', category: 'judgement_execution', finalText: '这次没有完成：判断或执行未完成。' }, { r4: 1, r2: 1, r3: 1, r5: 1 }],
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
      overrides: { r5: Object.freeze({ kind: 'one_link', url }) satisfies R5Result },
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
      overrides: { r5: Object.freeze({ kind: 'one_link', url }) satisfies R5Result },
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
})
