import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createPersonalFeedV2RequestCoordinator,
  type CreatePersonalFeedV2RequestCoordinatorOptions,
  type PersonalFeedV2R2Port,
  type PersonalFeedV2R3Port,
  type PersonalFeedV2R5Port,
  type PersonalFeedV2R4Port,
} from '@herman/personal-feed'
import type {
  TelegramInboundEnvelope,
  TelegramInboundResult,
} from '@deepseek-ai/dsh-telegram-gateway'

const LIFETIME_MODULE_URL = new URL('../src/personal-feed/telegram-feed-lifetime.ts', import.meta.url).href
const temporaryDirectories: string[] = []

type Lifetime = Readonly<{
  readonly handler: (envelope: TelegramInboundEnvelope) => Promise<TelegramInboundResult>
  readonly shutdown: () => Promise<void>
}>

type LifetimeModule = Readonly<{
  readonly createPersonalFeedTelegramInstallLifetime?: (options: unknown) => Lifetime
}>

type Deferred<Value> = {
  readonly promise: Promise<Value>
  readonly resolve: (value: Value | PromiseLike<Value>) => void
  readonly reject: (reason?: unknown) => void
}

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value | PromiseLike<Value>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<Value>((resolveValue, rejectValue) => {
    resolve = resolveValue
    reject = rejectValue
  })
  return { promise, resolve, reject }
}

async function loadLifetimeModule(): Promise<LifetimeModule> {
  try {
    return await import(/* @vite-ignore */ LIFETIME_MODULE_URL) as LifetimeModule
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`CAPABILITY_ASSERTION: Personal Feed Telegram install lifetime unavailable: ${detail}`, { cause: error })
  }
}

async function createLifetime(options: unknown): Promise<Lifetime> {
  const module = await loadLifetimeModule()
  expect(Object.keys(module)).toEqual(['createPersonalFeedTelegramInstallLifetime'])
  expect(typeof module.createPersonalFeedTelegramInstallLifetime).toBe('function')
  if (typeof module.createPersonalFeedTelegramInstallLifetime !== 'function') {
    throw new Error('CAPABILITY_ASSERTION: lifetime factory is not callable')
  }
  return module.createPersonalFeedTelegramInstallLifetime(options)
}

function exactFrozenShape(value: unknown, keys: readonly string[]): void {
  expect(value).not.toBeNull()
  expect(typeof value).toBe('object')
  expect(Object.getPrototypeOf(value as object)).toBe(Object.prototype)
  expect(Object.isFrozen(value)).toBe(true)
  expect(Reflect.ownKeys(value as object)).toEqual(keys)
  const descriptors = Object.getOwnPropertyDescriptors(value as object)
  for (const key of keys) {
    const descriptor = descriptors[key]
    expect(descriptor?.enumerable, key).toBe(true)
    expect(descriptor?.configurable, key).toBe(false)
    expect(descriptor?.writable, key).toBe(false)
    expect(descriptor?.get, key).toBeUndefined()
    expect(descriptor?.set, key).toBeUndefined()
  }
}

function expectEnumerableGraphWithout(value: unknown, forbidden: string): void {
  const seen = new Set<object>()
  const visit = (current: unknown): void => {
    if (typeof current === 'string') {
      expect(current).not.toContain(forbidden)
      return
    }
    if (typeof current !== 'object' || current === null || seen.has(current)) return
    seen.add(current)
    for (const key of Reflect.ownKeys(current)) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key)
      if (descriptor?.enumerable !== true || descriptor.get !== undefined || descriptor.set !== undefined) continue
      if (Object.hasOwn(descriptor, 'value')) visit(descriptor.value)
    }
  }
  visit(value)
}

function envelope(messageId: number, signal = new AbortController().signal): TelegramInboundEnvelope {
  return Object.freeze({
    chat: Object.freeze({ id: 7, type: 'private' as const }),
    message: Object.freeze({ id: messageId }),
    currentText: '给我一次个人 Feed',
    signal,
  })
}

function validCandidate(requestId: string, completeCurrent: (input: unknown) => Promise<unknown>) {
  const canonicalUrl = 'https://x.com/reader/status/42'
  const receipt = Object.freeze({
    kind: 'candidate_judgment_completed' as const,
    stableId: 'x-status:42',
    requestId,
    position: 0,
    judgment: 'qualified' as const,
    completedAt: '2026-09-03T00:00:01.000Z',
  })
  return Object.freeze({
    stableId: receipt.stableId,
    canonicalUrl,
    position: 0,
    body: 'candidate body',
    provenance: Object.freeze({
      capturedAt: '2026-09-03T00:00:00.000Z',
      surface: 'for_you' as const,
      surfaceOrdinal: 0,
      occurrenceOrdinal: 0,
      canonicalUrl,
      authorHandle: 'reader',
      publishedAt: '2026-09-02T00:00:00.000Z',
    }),
    completeCurrent,
  })
}

type Fixture = {
  readonly options: CreatePersonalFeedV2RequestCoordinatorOptions
  readonly ledgerPath: string
  readonly calls: {
    readonly r4: unknown[]
    readonly r2: unknown[]
    readonly r3: unknown[]
    readonly r5: unknown[]
  }
}

function fixture(overrides: Partial<{
  readonly r4: PersonalFeedV2R4Port
  readonly r2: PersonalFeedV2R2Port
  readonly r3: PersonalFeedV2R3Port
  readonly r5: PersonalFeedV2R5Port
}> = {}): Fixture {
  const directory = mkdtempSync(join(tmpdir(), 'personal-feed-telegram-lifetime-'))
  temporaryDirectories.push(directory)
  const calls = { r4: [] as unknown[], r2: [] as unknown[], r3: [] as unknown[], r5: [] as unknown[] }
  const requestId = 'telegram:7:11'
  const r4: PersonalFeedV2R4Port = overrides.r4 ?? {
    snapshot: async input => {
      calls.r4.push(input)
      return Object.freeze({ kind: 'sufficient', snapshot: Object.freeze({ context: 'safe' }) })
    },
  }
  const r2: PersonalFeedV2R2Port = overrides.r2 ?? {
    observe: async input => {
      calls.r2.push(input)
      return Object.freeze({
        kind: 'complete',
        window: Object.freeze({ source: 'safe-window' }),
        close: async () => undefined,
      })
    },
  }
  const r3: PersonalFeedV2R3Port = overrides.r3 ?? {
    admit: async input => {
      calls.r3.push(input)
      let borrowed = false
      const completeCurrent = async () => Object.freeze({
        kind: 'candidate_judgment_completed' as const,
        stableId: 'x-status:42',
        requestId,
        position: 0,
        judgment: 'not_qualified' as const,
        completedAt: '2026-09-03T00:00:01.000Z',
      })
      const cursor = Object.freeze({
        borrowCurrent: async () => {
          if (borrowed) return Object.freeze({ kind: 'done' as const })
          borrowed = true
          return Object.freeze({ kind: 'candidate' as const, lease: validCandidate(requestId, completeCurrent) })
        },
        finalize: async () => Object.freeze({ kind: 'none' as const }),
        close: async () => undefined,
      })
      return Object.freeze({ kind: 'admitted' as const, cursor })
    },
  }
  const r5: PersonalFeedV2R5Port = overrides.r5 ?? {
    judge: async input => {
      calls.r5.push(input)
      const current = await input.candidates.borrowCurrent({ signal: input.signal })
      if (current.kind === 'candidate') await current.lease.completeCurrent({ judgment: 'not_qualified' })
      await input.candidates.borrowCurrent({ signal: input.signal })
      return Object.freeze({ kind: 'none' as const, completed: Object.freeze([]) })
    },
  }
  return {
    ledgerPath: join(directory, 'requests.jsonl'),
    calls,
    options: {
      ledgerPath: join(directory, 'requests.jsonl'),
      clock: { now: () => new Date('2026-09-03T00:00:00.000Z') },
      r4,
      r2,
      r3,
      r5,
    },
  }
}

function lifetimeOptions(options: CreatePersonalFeedV2RequestCoordinatorOptions, r2Shutdown?: () => Promise<void>): unknown {
  return Object.freeze({
    coordinatorOptions: options,
    ...(r2Shutdown === undefined ? {} : { r2Shutdown }),
  })
}

function errorMessages(error: unknown): string[] {
  if (error instanceof AggregateError) return error.errors.flatMap(errorMessages)
  return [error instanceof Error ? error.message : String(error)]
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('Personal Feed Telegram install lifetime', () => {
  it('returns the exact frozen handler/shutdown carrier and explicit coordinator drain', async () => {
    const sample = fixture()
    const lifetime = await createLifetime(lifetimeOptions(sample.options))
    exactFrozenShape(lifetime, ['handler', 'shutdown'])
    expect(typeof lifetime.handler).toBe('function')
    expect(typeof lifetime.shutdown).toBe('function')
    const coordinator = createPersonalFeedV2RequestCoordinator(sample.options)
    expect(Reflect.ownKeys(coordinator)).toEqual(['prepare', 'read', 'drain'])
    expect(Object.isFrozen(coordinator)).toBe(true)
    exactFrozenShape(coordinator, ['prepare', 'read', 'drain'])
    expect(typeof coordinator.drain).toBe('function')
    await lifetime.shutdown()
  })

  it.each([
    ['duplicate request A', 11],
    ['duplicate request B', 12],
  ] as const)('%s duplicate request uses one prepare and one combined signal', async (_fixtureKind, messageId) => {
    const signals: AbortSignal[] = []
    const sample = fixture({
      r4: {
        snapshot: async input => {
          signals.push(input.signal)
          return Object.freeze({ kind: 'insufficient' as const })
        },
      },
    })
    const lifetime = await createLifetime(lifetimeOptions(sample.options))
    const requestSignal = new AbortController().signal
    const first = lifetime.handler(envelope(messageId, requestSignal))
    const duplicate = lifetime.handler(envelope(messageId, requestSignal))
    const [firstResult, duplicateResult] = await Promise.all([first, duplicate])
    expect(firstResult.kind).toBe('handled-awaiting-delivery')
    expect(duplicateResult).toEqual({ kind: 'handled', finalText: '' })
    expect(signals).toHaveLength(1)
    expect(signals[0]).not.toBe(requestSignal)
    expect(sample.calls.r2).toHaveLength(0)
    expect(lifetime.handler).toBe(lifetime.handler)
    await lifetime.shutdown()
  })

  it('carries one new combined signal through the complete R4/R2/R3/R5/candidate path', async () => {
    const signals: AbortSignal[] = []
    const sample = fixture({
      r4: { snapshot: async input => { signals.push(input.signal); return Object.freeze({ kind: 'sufficient', snapshot: Object.freeze({}) }) } },
      r2: { observe: async input => { signals.push(input.signal); return Object.freeze({ kind: 'complete' as const, window: Object.freeze({}), close: async () => undefined }) } },
      r3: {
        admit: async input => {
          signals.push(input.signal)
          let borrowed = false
          const cursor = Object.freeze({
            borrowCurrent: async (borrowInput: { readonly signal: AbortSignal }) => {
              signals.push(borrowInput.signal)
              if (borrowed) return Object.freeze({ kind: 'done' as const })
              borrowed = true
              return Object.freeze({ kind: 'candidate' as const, lease: validCandidate('telegram:7:11', async () => Object.freeze({
                kind: 'candidate_judgment_completed' as const,
                stableId: 'x-status:42',
                requestId: 'telegram:7:11',
                position: 0,
                judgment: 'qualified' as const,
                completedAt: '2026-09-03T00:00:01.000Z',
              })) })
            },
            finalize: async () => Object.freeze({ kind: 'selected' as const, selected: {
              stableId: 'x-status:42', canonicalUrl: 'https://x.com/reader/status/42', position: 0,
            } }),
            close: async () => undefined,
          })
          return Object.freeze({ kind: 'admitted' as const, cursor })
        },
      },
      r5: {
        judge: async input => {
          signals.push(input.signal)
          const current = await input.candidates.borrowCurrent({ signal: input.signal })
          if (current.kind === 'candidate') await current.lease.completeCurrent({ judgment: 'qualified' })
          await input.candidates.borrowCurrent({ signal: input.signal })
          return Object.freeze({ kind: 'selected' as const, completed: Object.freeze([]), selected: Object.freeze({
            stableId: 'x-status:42', canonicalUrl: 'https://x.com/reader/status/42', position: 0,
          }) })
        },
      },
    })
    const lifetime = await createLifetime(lifetimeOptions(sample.options))
    const envelopeSignal = new AbortController().signal
    const result = await lifetime.handler(envelope(11, envelopeSignal))
    expect(result.kind).toBe('handled-awaiting-delivery')
    expect(signals).toHaveLength(6)
    expect(new Set(signals).size).toBe(1)
    expect(signals[0]).not.toBe(envelopeSignal)
    await lifetime.shutdown()
  })

  it.each([
    ['R4', 'r4'],
    ['R2', 'r2'],
    ['R3', 'r3'],
    ['R5', 'r5'],
    ['finalize', 'finalize'],
    ['close', 'close'],
  ] as const)('shutdown drains a request paused at %s before resolving', async (_label, pause) => {
    const pending = deferred<unknown>()
    const entered = deferred<void>()
    let enteredObserved = false
    const markEntered = (): void => {
      if (enteredObserved) return
      enteredObserved = true
      entered.resolve(undefined)
    }
    const sample = fixture({
      r4: pause === 'r4'
        ? { snapshot: async _input => { markEntered(); await pending.promise; return Object.freeze({ kind: 'insufficient' as const }) } }
        : undefined,
      r2: pause === 'r2'
        ? { observe: async _input => { markEntered(); await pending.promise; return Object.freeze({ kind: 'complete', window: Object.freeze({}), close: async () => undefined }) } }
        : pause === 'close'
          ? { observe: async _input => Object.freeze({ kind: 'complete', window: Object.freeze({}), close: async () => { markEntered(); await pending.promise } }) }
        : undefined,
      r3: pause === 'r3'
        ? { admit: async _input => { markEntered(); await pending.promise; return Object.freeze({ kind: 'incomplete', reason: 'failed' as const }) } }
        : pause === 'finalize'
          ? { admit: async _input => Object.freeze({ kind: 'admitted' as const, cursor: Object.freeze({
            borrowCurrent: async () => Object.freeze({ kind: 'done' as const }),
            finalize: async () => { markEntered(); await pending.promise; return Object.freeze({ kind: 'none' as const }) },
            close: async () => undefined,
          }) }) }
        : undefined,
      r5: pause === 'r5'
        ? { judge: async _input => { markEntered(); await pending.promise; return Object.freeze({ kind: 'none' as const }) } }
        : undefined,
    })
    const lifetime = await createLifetime(lifetimeOptions(sample.options))
    const running = lifetime.handler(envelope(11))
    let enteredTimeout: ReturnType<typeof setTimeout> | undefined
    const enteredFailure = new Promise<never>((_, reject) => {
      enteredTimeout = setTimeout(() => reject(new Error(`operation did not enter: ${pause}`)), 1_000)
    })
    try {
      await Promise.race([entered.promise, enteredFailure])
    } finally {
      if (enteredTimeout !== undefined) clearTimeout(enteredTimeout)
    }
    expect(enteredObserved).toBe(true)
    const shutdown = lifetime.shutdown()
    let settled = false
    void shutdown.then(() => { settled = true }, () => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    pending.resolve(undefined)
    await running
    await shutdown
  })

  it('waits beyond the ordinary 250ms cleanup window, performs one lifetime raw retry, then coordinator drain', async () => {
    const firstAttempt = deferred<void>()
    const entered = deferred<void>()
    let rawCalls = 0
    const rawClose = async () => {
      const attempt = ++rawCalls
      if (attempt === 1) {
        entered.resolve()
        await firstAttempt.promise
        throw new Error('RAW_CLOSE_FIRST_FAILURE')
      }
      if (attempt !== 2) throw new Error('RAW_CLOSE_THIRD_CALL')
    }
    const r2 = {
      observe: async () => Object.freeze({
        kind: 'complete' as const,
        window: Object.freeze({}),
        close: rawClose,
      }),
    }
    const r2Shutdown = vi.fn(async () => undefined)
    const sample = fixture({ r2 })
    const lifetime = await createLifetime(lifetimeOptions({ ...sample.options, r2 }, r2Shutdown))
    const running = lifetime.handler(envelope(11))
    await entered.promise
    const shutdown = lifetime.shutdown()
    expect(r2Shutdown).toHaveBeenCalledOnce()
    let settled = false
    void shutdown.then(() => { settled = true }, () => { settled = true })
    await new Promise<void>(resolve => setTimeout(resolve, 275))
    expect(settled).toBe(false)
    expect(rawCalls).toBe(1)
    firstAttempt.resolve()
    await running
    await shutdown
    expect(r2Shutdown).toHaveBeenCalledOnce()
    expect(rawCalls).toBe(2)

  })

  it.each([
    ['R2', 'recovers'],
    ['R2', 'permanent'],
    ['R3', 'recovers'],
    ['R3', 'permanent'],
  ] as const)('%s port cleanup %s after a sealed late resource', async (portKind, outcome) => {
    const canary = 'RAW_BODY_MUST_NOT_LEAK'
    const entered = deferred<void>()
    const releasePort = deferred<void>()
    let portSignal: AbortSignal | undefined
    let rawCalls = 0
    const rawReceivers: object[] = []
    const rawClose = vi.fn(async function (this: object, _reason: string) {
      rawReceivers.push(this)
      const attempt = ++rawCalls
      if (attempt === 1) throw new Error(`${canary}: ordinary close failed`)
      if (attempt === 2) {
        if (outcome === 'permanent') throw new Error(`${canary}: final close failed`)
        return
      }
      throw new Error(`${canary}: third close is forbidden`)
    })
    const r2Resource = Object.freeze({
      kind: 'complete' as const,
      window: Object.freeze({ body: canary }),
      close: rawClose,
    })
    const r3Cursor = Object.freeze({
      borrowCurrent: async () => Object.freeze({ kind: 'done' as const }),
      finalize: async () => Object.freeze({ kind: 'none' as const }),
      close: rawClose,
    })
    const r3Resource = Object.freeze({ kind: 'admitted' as const, cursor: r3Cursor })
    const safeR2 = Object.freeze({
      kind: 'complete' as const,
      window: Object.freeze({ body: canary }),
      close: async () => undefined,
    })
    const sample = fixture({
      r2: portKind === 'R2'
        ? { observe: async input => { portSignal = input.signal; entered.resolve(); await releasePort.promise; return r2Resource } }
        : { observe: async () => safeR2 },
      r3: portKind === 'R3'
        ? { admit: async input => { portSignal = input.signal; entered.resolve(); await releasePort.promise; return r3Resource } }
        : undefined,
    })
    const targetResource = portKind === 'R2' ? r2Resource : r3Resource
    exactFrozenShape(targetResource, portKind === 'R2' ? ['kind', 'window', 'close'] : ['kind', 'cursor'])
    if (portKind === 'R3') exactFrozenShape(r3Cursor, ['borrowCurrent', 'finalize', 'close'])
    const lifetime = await createLifetime(lifetimeOptions(sample.options))
    const running = lifetime.handler(envelope(11))
    await entered.promise
    const shutdown = lifetime.shutdown()
    expect(lifetime.shutdown()).toBe(shutdown)
    expect(portSignal).toBeDefined()
    if (portSignal === undefined) throw new Error('delayed port did not receive a signal')
    expect(portSignal.aborted).toBe(true)
    let shutdownSettled = false
    void shutdown.then(() => { shutdownSettled = true }, () => { shutdownSettled = true })
    await Promise.resolve()
    expect(shutdownSettled).toBe(false)
    expect(rawCalls).toBe(0)
    releasePort.resolve(undefined)
    const prepared = await running
    expect(prepared.kind).toBe('handled-awaiting-delivery')
    expectEnumerableGraphWithout(prepared, canary)
    expect(rawCalls).toBe(1)
    expect(rawReceivers).toEqual([portKind === 'R2' ? r2Resource : r3Cursor])

    let shutdownError: unknown
    try { await shutdown } catch (error: unknown) { shutdownError = error }
    if (outcome === 'recovers') {
      expect(shutdownError).toBeUndefined()
    } else {
      expect(shutdownError).toBeInstanceOf(AggregateError)
      expect((shutdownError as AggregateError).errors).toHaveLength(1)
      expect(errorMessages(shutdownError)).toEqual(['personal Feed Telegram cleanup failed'])
      expectEnumerableGraphWithout(shutdownError, canary)
    }
    expect(rawCalls).toBe(2)
    expect(rawReceivers).toEqual([portKind === 'R2' ? r2Resource : r3Cursor, portKind === 'R2' ? r2Resource : r3Cursor])
    if (prepared.kind === 'handled-awaiting-delivery') {
      expect(() => prepared.settle({ chatId: 7, triggerMessageId: 11, visibleText: prepared.finalText, messageIds: [99] })).not.toThrow()
    }
    const late = await lifetime.handler(envelope(12))
    expect(late).toEqual({ kind: 'failed', visibleError: '这次没有完成：判断或执行未完成。' })
    expect(lifetime.shutdown()).toBe(shutdown)
    expect(rawCalls).toBe(2)
  })

  it.each([
    'sync throw',
    'immediate native Promise reject',
  ] as const)('r2Shutdown %s is observed without an unhandled rejection', async variant => {
    const canary = 'RAW_BODY_MUST_NOT_LEAK'
    const ordinaryRelease = deferred<void>()
    const ordinaryEntered = deferred<void>()
    let rawCalls = 0
    const rawFailure = new Error(`${canary}: ordinary raw close failed`)
    const rawClose = vi.fn(async function (this: object, _reason: string) {
      const attempt = ++rawCalls
      if (attempt === 1) {
        ordinaryEntered.resolve(undefined)
        await ordinaryRelease.promise
        throw rawFailure
      }
      if (attempt === 2) return
      throw new Error(`${canary}: third close is forbidden`)
    })
    const r2 = {
      observe: async () => Object.freeze({
        kind: 'complete' as const,
        window: Object.freeze({ body: canary }),
        close: rawClose,
      }),
    }
    let r2ShutdownCalls = 0
    const r2Shutdown = (): Promise<never> => {
      r2ShutdownCalls += 1
      if (variant === 'sync throw') throw rawFailure
      return Promise.reject(rawFailure)
    }
    const sample = fixture({ r2 })
    const lifetime = await createLifetime(lifetimeOptions({ ...sample.options, r2 }, r2Shutdown))
    const running = lifetime.handler(envelope(11))
    await ordinaryEntered.promise
    const unhandledReasons: unknown[] = []
    const unhandledListener = (reason: unknown): void => { unhandledReasons.push(reason) }
    process.on('unhandledRejection', unhandledListener)
    let shutdown: Promise<void> | undefined
    try {
      shutdown = lifetime.shutdown()
      expect(lifetime.shutdown()).toBe(shutdown)
      expect(r2ShutdownCalls).toBe(1)
      await new Promise<void>(resolve => { setImmediate(resolve) })
      expect(unhandledReasons).toHaveLength(0)
      expect(unhandledReasons.every(reason => reason === rawFailure)).toBe(true)
      ordinaryRelease.resolve(undefined)
      const prepared = await running
      expect(prepared.kind).toBe('handled-awaiting-delivery')
      expectEnumerableGraphWithout(prepared, canary)
      let shutdownError: unknown
      try { await shutdown } catch (error: unknown) { shutdownError = error }
      expect(shutdownError).toBeInstanceOf(AggregateError)
      expect((shutdownError as AggregateError).errors).toHaveLength(1)
      expect(errorMessages(shutdownError)).toEqual(['personal Feed Telegram cleanup failed'])
      expectEnumerableGraphWithout(shutdownError, canary)
      expect(rawCalls).toBe(2)
      expect(r2ShutdownCalls).toBe(1)
    } finally {
      ordinaryRelease.resolve(undefined)
      process.off('unhandledRejection', unhandledListener)
    }
    expect(process.listeners('unhandledRejection')).not.toContain(unhandledListener)
  })

  it('seals and aborts before a saved or late handler can inspect input, clock, ledger, ports, or authority', async () => {
    const sample = fixture()
    const lifetime = await createLifetime(lifetimeOptions(sample.options))
    const shutdown = lifetime.shutdown()
    const touches: string[] = []
    const hostile = new Proxy({}, {
      get: () => { touches.push('get'); throw new Error('HOSTILE_INPUT_CANARY') },
      ownKeys: () => { touches.push('ownKeys'); throw new Error('HOSTILE_INPUT_CANARY') },
      getPrototypeOf: () => { touches.push('getPrototypeOf'); throw new Error('HOSTILE_INPUT_CANARY') },
    })
    const result = await lifetime.handler(hostile as never)
    expect(result).toEqual({ kind: 'failed', visibleError: '这次没有完成：判断或执行未完成。' })
    await shutdown
    expect(touches).toEqual([])
    expect(sample.calls.r4).toEqual([])
    expect(sample.calls.r2).toEqual([])
    expect(sample.calls.r3).toEqual([])
    expect(sample.calls.r5).toEqual([])
  })

  it('requires exact descriptor-safe R2/R3 wrappers, preserves window identity and receiver, and never exposes body text', async () => {
    const canary = 'RAW_BODY_MUST_NOT_LEAK'
    let rawR2: object | undefined
    let rawCursor: object | undefined
    const r2Receivers: object[] = []
    const cursorReceivers: object[] = []
    let r2Window: unknown
    let r3Window: unknown
    let r3Input: unknown
    let r5Input: unknown
    const r2 = {
      observe: async () => {
        const window = Object.freeze({ canary })
        const raw = Object.freeze({
          kind: 'complete' as const,
          window,
          close: async function (this: object) { r2Receivers.push(this) },
        })
        rawR2 = raw
        r2Window = window
        return raw
      },
    }
    const r3 = {
      admit: async function (input: { readonly window: unknown }) {
        r3Input = input
        r3Window = input.window
        const cursor = Object.freeze({
          borrowCurrent: async function (this: object) {
            cursorReceivers.push(this)
            return Object.freeze({ kind: 'done' as const })
          },
          finalize: async function (this: object) {
            cursorReceivers.push(this)
            return Object.freeze({ kind: 'none' as const })
          },
          close: async function (this: object) {
            cursorReceivers.push(this)
          },
        })
        rawCursor = cursor
        return Object.freeze({ kind: 'admitted' as const, cursor })
      },
    }
    const r5 = {
      judge: async (input: { readonly candidates: { readonly borrowCurrent: (input: unknown) => Promise<unknown> }; readonly signal: AbortSignal }) => {
        r5Input = input
        await input.candidates.borrowCurrent({ signal: input.signal })
        return Object.freeze({ kind: 'none' as const })
      },
    }
    const sample = fixture({ r2, r3, r5 })
    const lifetime = await createLifetime(lifetimeOptions({ ...sample.options, r2, r3, r5 }))
    const result = await lifetime.handler(envelope(11))
    expect(result.kind).toBe('handled-awaiting-delivery')
    expect(r3Window).toBe(r2Window)
    expect(r2Receivers).toEqual([rawR2])
    expect(cursorReceivers).toEqual([rawCursor, rawCursor, rawCursor])
    expect(Object.keys(r3Input as object).sort()).toEqual(['request', 'signal', 'window'])
    expect(Object.keys(r5Input as object).sort()).toEqual(['candidates', 'request', 'signal', 'snapshot'])
    expectEnumerableGraphWithout(r5Input, canary)
    expectEnumerableGraphWithout(result, canary)
    await lifetime.shutdown()

    let invalidR2AccessorReads = 0
    let invalidR2ProxyTouches = 0
    let invalidR3CursorAccessorReads = 0
    let invalidR3CursorProxyTouches = 0
    let invalidR3OuterAccessorReads = 0
    let invalidR3OuterProxyTouches = 0
    const invalidCases: Array<{
      readonly label: string
      readonly r2?: PersonalFeedV2R2Port
      readonly r3?: PersonalFeedV2R3Port
      readonly traps: () => number
    }> = [
      {
        label: 'R2 extra key',
        r2: { observe: async () => ({ kind: 'complete', window: { canary }, close: async () => undefined, extra: canary }) },
        traps: () => 0,
      },
      {
        label: 'R2 accessor',
        r2: { observe: async () => Object.defineProperty({ kind: 'complete', window: {}, close: async () => undefined }, 'window', {
          enumerable: true, configurable: true, get: () => { invalidR2AccessorReads += 1; throw new Error('R2_GETTER_CANARY') },
        }) },
        traps: () => invalidR2AccessorReads,
      },
      {
        label: 'R2 Proxy',
        r2: { observe: () => new Proxy({ kind: 'complete', window: {}, close: async () => undefined }, {
          get: () => { invalidR2ProxyTouches += 1; throw new Error('R2_PROXY_GET_CANARY') }, ownKeys: () => { invalidR2ProxyTouches += 1; throw new Error('R2_PROXY_KEYS_CANARY') },
        }) },
        traps: () => invalidR2ProxyTouches,
      },
      {
        label: 'R3 cursor extra key',
        r3: { admit: async () => ({ kind: 'admitted', cursor: { borrowCurrent: async () => ({ kind: 'done' }), finalize: async () => ({ kind: 'none' }), close: async () => undefined, extra: canary } }) },
        traps: () => 0,
      },
      {
        label: 'R3 cursor accessor',
        r3: { admit: async () => ({ kind: 'admitted', cursor: Object.defineProperty({ borrowCurrent: async () => ({ kind: 'done' }), finalize: async () => ({ kind: 'none' }), close: async () => undefined }, 'close', {
          enumerable: true, configurable: true, get: () => { invalidR3CursorAccessorReads += 1; throw new Error('R3_GETTER_CANARY') },
        }) }) },
        traps: () => invalidR3CursorAccessorReads,
      },
      {
        label: 'R3 cursor Proxy',
        r3: { admit: () => ({ kind: 'admitted', cursor: new Proxy({ borrowCurrent: async () => ({ kind: 'done' }), finalize: async () => ({ kind: 'none' }), close: async () => undefined }, {
          get: () => { invalidR3CursorProxyTouches += 1; throw new Error('R3_PROXY_GET_CANARY') }, ownKeys: () => { invalidR3CursorProxyTouches += 1; throw new Error('R3_PROXY_KEYS_CANARY') },
        }) }) },
        traps: () => invalidR3CursorProxyTouches,
      },
      {
        label: 'R3 outer extra key',
        r3: { admit: async () => ({ kind: 'admitted', cursor: {}, extra: canary }) },
        traps: () => 0,
      },
      {
        label: 'R3 outer accessor',
        r3: { admit: async () => Object.defineProperty({ kind: 'admitted', cursor: {} }, 'cursor', {
          enumerable: true, configurable: true, get: () => { invalidR3OuterAccessorReads += 1; throw new Error('R3_OUTER_GETTER_CANARY') },
        }) },
        traps: () => invalidR3OuterAccessorReads,
      },
      {
        label: 'R3 outer Proxy',
        r3: { admit: () => new Proxy({ kind: 'admitted', cursor: {} }, {
          get: () => { invalidR3OuterProxyTouches += 1; throw new Error('R3_OUTER_PROXY_GET_CANARY') }, ownKeys: () => { invalidR3OuterProxyTouches += 1; throw new Error('R3_OUTER_PROXY_KEYS_CANARY') },
        }) },
        traps: () => invalidR3OuterProxyTouches,
      },
    ]
    for (const invalid of invalidCases) {
      const invalidR5 = vi.fn(async () => { throw new Error('R5_MUST_NOT_RUN') })
      const invalidSample = fixture({
        ...(invalid.r2 === undefined ? {} : { r2: invalid.r2 as PersonalFeedV2R2Port }),
        ...(invalid.r3 === undefined ? {} : { r3: invalid.r3 as PersonalFeedV2R3Port }),
        r5: { judge: invalidR5 },
      })
      const invalidLifetime = await createLifetime(lifetimeOptions(invalidSample.options))
      const invalidResult = await invalidLifetime.handler(envelope(20))
      expect(['failed', 'handled-awaiting-delivery']).toContain(invalidResult.kind)
      expect(invalidR5).not.toHaveBeenCalled()
      expect(invalid.traps(), invalid.label).toBe(0)
      expectEnumerableGraphWithout(invalidResult, 'CANARY')
      expectEnumerableGraphWithout(invalidResult, 'candidate body')
      await invalidLifetime.shutdown().catch(() => undefined)
    }
  })

  it('preserves receipt ownership: no receipt still drains, invalid receipt rejects, and valid receipt settles once without new close', async () => {
    const close = vi.fn(async () => undefined)
    const sample = fixture({ r2: { observe: async () => Object.freeze({ kind: 'complete' as const, window: Object.freeze({}), close }) } })
    const lifetime = await createLifetime(lifetimeOptions(sample.options))
    const result = await lifetime.handler(envelope(11))
    expect(result.kind).toBe('handled-awaiting-delivery')
    if (result.kind !== 'handled-awaiting-delivery') throw new Error('fixture did not prepare')
    const baseline = readFileSync(sample.ledgerPath, 'utf8')
    expect(() => result.settle({ chatId: 7, triggerMessageId: 11, visibleText: 'wrong', messageIds: [99] })).toThrow()
    expect(readFileSync(sample.ledgerPath, 'utf8')).toBe(baseline)
    expect(() => result.settle({ chatId: 7, triggerMessageId: 11, visibleText: result.finalText, messageIds: [99, 100] })).toThrow()
    expect(readFileSync(sample.ledgerPath, 'utf8')).toBe(baseline)
    await lifetime.shutdown()
    expect(readFileSync(sample.ledgerPath, 'utf8')).toBe(baseline)
    result.settle({ chatId: 7, triggerMessageId: 11, visibleText: result.finalText, messageIds: [99] })
    result.settle({ chatId: 7, triggerMessageId: 11, visibleText: result.finalText, messageIds: [99] })
    const afterReceipt = readFileSync(sample.ledgerPath, 'utf8')
    expect(afterReceipt).toContain('delivered_terminal')
    expect(afterReceipt.match(/"event":"delivered_terminal"/gu)).toHaveLength(1)
    expect(close).toHaveBeenCalledTimes(1)
  })

})
