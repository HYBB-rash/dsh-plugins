import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as publicApi from '../src/index.ts'
import {
  createPersonalFeedV2RequestCoordinator,
  type PersonalFeedV2PrepareResult,
} from '../src/index.ts'

const CLEANUP_SEAL_AND_DRAIN = Symbol.for('@herman/personal-feed/v2/request-coordinator-cleanup-seal-and-drain')
const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

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

type ClosePair = {
  readonly closeProxy: (reason: string) => Promise<void>
  readonly rawRetry: (succeed: boolean) => Promise<void>
  readonly counts: () => { readonly proxy: number; readonly raw: number }
}

function recoverableClosePair(): ClosePair {
  let proxy = 0
  let raw = 0
  let closed = false
  return {
    closeProxy: async () => {
      proxy += 1
      if (proxy === 1) {
        raw += 1
        throw new Error('close failed')
      }
      if (!closed) throw new Error('close retry was not completed')
    },
    rawRetry: async (succeed: boolean) => {
      raw += 1
      if (!succeed) throw new Error('close retry failed')
      closed = true
    },
    counts: () => ({ proxy, raw }),
  }
}

function permanentClosePair(): ClosePair {
  let proxy = 0
  let raw = 0
  return {
    closeProxy: async () => {
      proxy += 1
      if (proxy === 1) raw += 1
      throw new Error('RAW_CLOSE_CANARY')
    },
    rawRetry: async () => {
      raw += 1
      throw new Error('RAW_CLOSE_CANARY')
    },
    counts: () => ({ proxy, raw }),
  }
}

function pendingClosePair(): ClosePair & { readonly complete: () => void } {
  let proxy = 0
  let raw = 0
  const pending = deferred<void>()
  return {
    closeProxy: () => {
      proxy += 1
      return pending.promise
    },
    rawRetry: async () => {
      raw += 1
    },
    counts: () => ({ proxy, raw }),
    complete: () => pending.resolve(),
  }
}

type FixtureMode = 'r3-incomplete' | 'r3-admitted' | 'r3-cleanup-only'

function fixture(mode: FixtureMode, r2Close: ClosePair, r3Close = recoverableClosePair()) {
  const directory = mkdtempSync(join(tmpdir(), 'personal-feed-v2-cleanup-'))
  temporaryDirectories.push(directory)
  const ledgerPath = join(directory, 'requests.jsonl')
  let clockCalls = 0
  const coordinator = createPersonalFeedV2RequestCoordinator({
    ledgerPath,
    clock: {
      now: () => {
        clockCalls += 1
        return new Date('2026-08-31T15:59:59.000Z')
      },
    },
    r4: {
      snapshot: async () => Object.freeze({
        kind: 'sufficient',
        snapshot: Object.freeze({ fixture: true }),
      }),
    },
    r2: {
      observe: async () => Object.freeze({
        kind: 'complete',
        window: Object.freeze({ fixture: true }),
        close: r2Close.closeProxy,
      }),
    },
    r3: {
      admit: async () => {
        if (mode === 'r3-incomplete') return Object.freeze({ kind: 'incomplete', reason: 'failed' })
        if (mode === 'r3-cleanup-only') {
          return Object.freeze({
            kind: 'admitted',
            cursor: Object.freeze({ close: r3Close.closeProxy }),
          })
        }
        return Object.freeze({
          kind: 'admitted',
          cursor: Object.freeze({
            borrowCurrent: async () => Object.freeze({ kind: 'done' }),
            finalize: async () => Object.freeze({ kind: 'none' }),
            close: r3Close.closeProxy,
          }),
        })
      },
    },
    r5: {
      judge: async (input) => {
        const done = await input.candidates.borrowCurrent({ signal: input.signal })
        if (done.kind !== 'done') throw new Error('fixture candidate cursor was not empty')
        return Object.freeze({ kind: 'none' })
      },
    },
  })
  return { coordinator, ledgerPath, r2Close, r3Close, getClockCalls: () => clockCalls }
}

function cleanupDrain(coordinator: object): (coordinator: object) => Promise<unknown> {
  const prepare = (coordinator as { readonly prepare?: unknown }).prepare
  expect(typeof prepare).toBe('function')
  const descriptor = Object.getOwnPropertyDescriptor(prepare as object, CLEANUP_SEAL_AND_DRAIN)
  expect(descriptor, 'request cleanup seal-and-drain capability is missing').toBeDefined()
  expect(descriptor?.enumerable).toBe(false)
  expect(descriptor?.writable).toBe(false)
  expect(descriptor?.configurable).toBe(false)
  expect(descriptor === undefined ? undefined : Object.hasOwn(descriptor, 'value')).toBe(true)
  expect(typeof descriptor?.value).toBe('function')
  return descriptor?.value as (coordinator: object) => Promise<unknown>
}

function validInput(messageId = 11) {
  return Object.freeze({ chatId: 7, messageId, signal: new AbortController().signal })
}

function validReceipt(finalText: string, messageId = 11) {
  const messageIds: readonly [number] = [99]
  return Object.freeze({
    chatId: 7,
    triggerMessageId: messageId,
    visibleText: finalText,
    messageIds: Object.freeze(messageIds),
  }) as const
}

async function rejected(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(Error)
    return error as Error
  }
  throw new Error('expected promise to reject')
}

describe('personal Feed v2 request cleanup seal-and-drain capability', () => {
  it('keeps the coordinator and package carrier contracts closed while exposing only the internal symbol capability', async () => {
    const sample = fixture('r3-incomplete', recoverableClosePair())
    const coordinator = sample.coordinator
    expect(Reflect.ownKeys(coordinator)).toEqual(['prepare', 'read'])
    expect(Object.keys(coordinator)).toEqual(['prepare', 'read'])
    expect(Object.isFrozen(coordinator)).toBe(true)

    const prepare = coordinator.prepare as unknown as object
    const descriptor = Object.getOwnPropertyDescriptor(prepare, CLEANUP_SEAL_AND_DRAIN)
    expect(descriptor, 'missing internal cleanup capability').toBeDefined()
    expect(descriptor?.enumerable).toBe(false)
    expect(descriptor?.writable).toBe(false)
    expect(descriptor?.configurable).toBe(false)
    expect(descriptor === undefined ? undefined : Object.hasOwn(descriptor, 'value')).toBe(true)
    expect(typeof descriptor?.value).toBe('function')
    const standardFunctionKeys = new Set(Reflect.ownKeys(async function standardPrepare() {}))
    const prepareKeys = Reflect.ownKeys(prepare)
    expect(prepareKeys.filter(key => key === CLEANUP_SEAL_AND_DRAIN)).toHaveLength(1)
    expect(prepareKeys.filter(key => typeof key === 'string' && !standardFunctionKeys.has(key))).toEqual([])
    expect(prepareKeys.filter(key => typeof key === 'symbol' && key !== CLEANUP_SEAL_AND_DRAIN)).toEqual([])
    expect(Object.keys(prepare)).toEqual([])

    const namedExports = Object.keys(publicApi)
    expect(namedExports.some(name => /cleanup|seal|drain/iu.test(name))).toBe(false)
    expect(Object.values(publicApi)).not.toContain(CLEANUP_SEAL_AND_DRAIN)
    const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      readonly exports?: unknown
    }
    expect(packageJson.exports).toEqual({
      '.': { types: './lib/types/index.d.ts', default: './lib/index.js' },
      './package.json': './package.json',
    })

    await cleanupDrain(coordinator)(coordinator)
  })

  it('rejects forged, proxied, getter-backed, and cross-coordinator keys without touching their bodies or cleanup authorities', async () => {
    const first = fixture('r3-incomplete', recoverableClosePair())
    const second = fixture('r3-incomplete', recoverableClosePair())
    await first.coordinator.prepare(validInput())
    expect(first.r2Close.counts()).toEqual({ proxy: 1, raw: 1 })
    const firstDrain = cleanupDrain(first.coordinator)
    const secondDrain = cleanupDrain(second.coordinator)
    expect(firstDrain).toBe(secondDrain)
    const getterTouches: string[] = []
    const getterBacked = new Proxy({}, {
      get: () => {
        getterTouches.push('get')
        throw new Error('GETTER_CANARY')
      },
      getPrototypeOf: () => {
        getterTouches.push('getPrototypeOf')
        throw new Error('GETTER_CANARY')
      },
      ownKeys: () => {
        getterTouches.push('ownKeys')
        throw new Error('GETTER_CANARY')
      },
    })
    const forged = Object.freeze({ prepare: first.coordinator.prepare, read: first.coordinator.read })
    const recombined = Object.freeze({ prepare: first.coordinator.prepare, read: second.coordinator.read })

    const errors = await Promise.all([
      rejected(Reflect.apply(firstDrain, undefined, [forged])),
      rejected(Reflect.apply(firstDrain, undefined, [getterBacked])),
      rejected(Reflect.apply(firstDrain, undefined, [Object.create(null)])),
      rejected(Reflect.apply(firstDrain, undefined, [recombined])),
    ])
    expect(new Set(errors.map(error => error.message)).size).toBe(1)
    expect(errors[0]?.message).not.toContain('GETTER_CANARY')
    expect(getterTouches).toEqual([])
    expect(first.r2Close.counts()).toEqual({ proxy: 1, raw: 1 })
    expect(second.r2Close.counts()).toEqual({ proxy: 0, raw: 0 })
  })

  it.each([
    ['exact R2 close', 'r3-incomplete' as const],
    ['exact R3 cursor close', 'r3-admitted' as const],
    ['R3 cleanup-only salvage close', 'r3-cleanup-only' as const],
  ])('%s retains a failed coordinator close for the internal drain and delivers exactly once after the lifetime retry', async (_label, mode) => {
    const r2Close = recoverableClosePair()
    const r3Close = recoverableClosePair()
    const sample = fixture(mode, r2Close, r3Close)
    const prepared = await sample.coordinator.prepare(validInput()) as Extract<PersonalFeedV2PrepareResult, { readonly kind: 'prepared' }>
    expect(prepared.kind).toBe('prepared')
    expect(prepared.outcome.kind).toBe('incomplete')
    expect(prepared.outcome.category).toBe('source_window')

    await r2Close.rawRetry(true)
    if (mode !== 'r3-incomplete') await r3Close.rawRetry(true)
    const drain = cleanupDrain(sample.coordinator)
    const first = Reflect.apply(drain, undefined, [sample.coordinator])
    expect(Reflect.apply(drain, undefined, [sample.coordinator])).toBe(first)
    await first

    const counts = sample.r2Close.counts()
    const r3Counts = sample.r3Close.counts()
    expect(counts).toEqual({ proxy: 2, raw: 2 })
    if (mode !== 'r3-incomplete') expect(sample.r3Close.counts()).toEqual({ proxy: 2, raw: 2 })
    prepared.settle(validReceipt(prepared.outcome.finalText))
    prepared.settle(validReceipt(prepared.outcome.finalText))
    expect(sample.coordinator.read('telegram:7:11')?.status).toBe('delivered')
    const terminalRecords = readFileSync(sample.ledgerPath, 'utf8')
      .trim().split('\n').map(line => JSON.parse(line) as { readonly event?: unknown })
      .filter(record => record.event === 'delivered_terminal')
    expect(terminalRecords).toHaveLength(1)
    expect(sample.r2Close.counts()).toEqual(counts)
    if (mode !== 'r3-incomplete') expect(sample.r3Close.counts()).toEqual(r3Counts)
  })

  it('keeps the same drain promise pending beyond the coordinator cleanup wait until an actual close settles', async () => {
    const r2Close = pendingClosePair()
    const sample = fixture('r3-incomplete', r2Close)
    const prepared = await sample.coordinator.prepare(validInput()) as Extract<PersonalFeedV2PrepareResult, { readonly kind: 'prepared' }>
    expect(prepared.outcome.kind).toBe('incomplete')

    const drain = cleanupDrain(sample.coordinator)
    const first = Reflect.apply(drain, undefined, [sample.coordinator])
    const second = Reflect.apply(drain, undefined, [sample.coordinator])
    expect(second).toBe(first)
    let settled = false
    void first.then(() => { settled = true }, () => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(sample.r2Close.counts()).toEqual({ proxy: 1, raw: 0 })
    r2Close.complete()
    await first
    expect(settled).toBe(true)
    expect(sample.r2Close.counts()).toEqual({ proxy: 1, raw: 0 })
  })

  it('rejects permanently failed cleanup once, without a third raw close, while preserving a late valid receipt', async () => {
    const r2Close = permanentClosePair()
    const sample = fixture('r3-incomplete', r2Close)
    const prepared = await sample.coordinator.prepare(validInput()) as Extract<PersonalFeedV2PrepareResult, { readonly kind: 'prepared' }>
    await r2Close.rawRetry(false).catch(() => undefined)

    const drain = cleanupDrain(sample.coordinator)
    const first = Reflect.apply(drain, undefined, [sample.coordinator])
    const second = Reflect.apply(drain, undefined, [sample.coordinator])
    expect(second).toBe(first)
    const error = await rejected(first)
    expect(error.message).not.toContain('RAW_CLOSE_CANARY')
    expect(r2Close.counts()).toEqual({ proxy: 2, raw: 2 })

    prepared.settle(validReceipt(prepared.outcome.finalText))
    prepared.settle(validReceipt(prepared.outcome.finalText))
    expect(sample.coordinator.read('telegram:7:11')?.status).toBe('delivered')
    expect(r2Close.counts()).toEqual({ proxy: 2, raw: 2 })
  })

  it('seals before direct prepare can read hostile input, write the ledger, or touch clock and ports', async () => {
    const sample = fixture('r3-incomplete', recoverableClosePair())
    const drain = cleanupDrain(sample.coordinator)
    await Reflect.apply(drain, undefined, [sample.coordinator])
    const touches: string[] = []
    const hostile = new Proxy({}, {
      get: () => {
        touches.push('get')
        throw new Error('HOSTILE_INPUT_CANARY')
      },
      getPrototypeOf: () => {
        touches.push('getPrototypeOf')
        throw new Error('HOSTILE_INPUT_CANARY')
      },
      ownKeys: () => {
        touches.push('ownKeys')
        throw new Error('HOSTILE_INPUT_CANARY')
      },
    })
    const error = await rejected(sample.coordinator.prepare(hostile as never))
    expect(error.message).not.toContain('HOSTILE_INPUT_CANARY')
    expect(touches).toEqual([])
    expect(sample.getClockCalls()).toBe(0)
    expect(existsSync(sample.ledgerPath)).toBe(false)
    expect(sample.r2Close.counts()).toEqual({ proxy: 0, raw: 0 })
  })

  it('keeps settle receipt behavior stable while seal/drain races valid and invalid receipts with one close attempt per authority', async () => {
    const r2Close = recoverableClosePair()
    const r3Close = recoverableClosePair()
    const sample = fixture('r3-admitted', r2Close, r3Close)
    const prepared = await sample.coordinator.prepare(validInput()) as Extract<PersonalFeedV2PrepareResult, { readonly kind: 'prepared' }>
    await r2Close.rawRetry(true)
    await r3Close.rawRetry(true)
    const drain = cleanupDrain(sample.coordinator)
    const drainPromise = Reflect.apply(drain, undefined, [sample.coordinator])
    expect(() => prepared.settle(validReceipt('wrong text'))).toThrow()
    prepared.settle(validReceipt(prepared.outcome.finalText))
    prepared.settle(validReceipt(prepared.outcome.finalText))
    await drainPromise
    expect(sample.coordinator.read('telegram:7:11')?.status).toBe('delivered')
    expect(r2Close.counts()).toEqual({ proxy: 2, raw: 2 })
    expect(r3Close.counts()).toEqual({ proxy: 2, raw: 2 })
  })
})
