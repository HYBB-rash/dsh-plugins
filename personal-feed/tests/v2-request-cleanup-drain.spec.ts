import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as publicApi from '../src/index.ts'
import {
  createPersonalFeedV2RequestCoordinator,
  type PersonalFeedV2PrepareResult,
} from '../src/index.ts'

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
  const coordinator = createPersonalFeedV2RequestCoordinator({
    ledgerPath,
    clock: {
      now: () => new Date('2026-08-31T15:59:59.000Z'),
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
  return { coordinator, ledgerPath, r2Close, r3Close }
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

describe('personal Feed v2 request coordinator drain', () => {
  it('exposes an exact frozen coordinator shape with an explicit drain capability', async () => {
    const sample = fixture('r3-incomplete', recoverableClosePair())
    const coordinator = sample.coordinator
    expect(Reflect.ownKeys(coordinator)).toEqual(['prepare', 'read', 'drain'])
    expect(Object.keys(coordinator)).toEqual(['prepare', 'read', 'drain'])
    expect(Object.isFrozen(coordinator)).toBe(true)
    expect(typeof coordinator.prepare).toBe('function')
    expect(typeof coordinator.read).toBe('function')
    expect(typeof coordinator.drain).toBe('function')
    const descriptors = Object.getOwnPropertyDescriptors(coordinator)
    for (const key of ['prepare', 'read', 'drain'] as const) {
      expect(descriptors[key]?.enumerable, key).toBe(true)
      expect(descriptors[key]?.writable, key).toBe(false)
      expect(descriptors[key]?.configurable, key).toBe(false)
      expect(descriptors[key]?.get, key).toBeUndefined()
      expect(descriptors[key]?.set, key).toBeUndefined()
    }

    const namedExports = Object.keys(publicApi)
    expect(namedExports.some(name => /cleanup|seal|drain/iu.test(name))).toBe(false)
    const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      readonly exports?: unknown
    }
    expect(packageJson.exports).toEqual({
      '.': { types: './lib/types/index.d.ts', default: './lib/index.js' },
      './package.json': './package.json',
    })

    await coordinator.drain()
  })

  it.each([
    ['exact R2 close', 'r3-incomplete' as const],
    ['exact R3 cursor close', 'r3-admitted' as const],
    ['R3 cleanup-only salvage close', 'r3-cleanup-only' as const],
  ])('%s retains a failed coordinator close for explicit drain and delivers exactly once after the lifetime retry', async (_label, mode) => {
    const r2Close = recoverableClosePair()
    const r3Close = recoverableClosePair()
    const sample = fixture(mode, r2Close, r3Close)
    const prepared = await sample.coordinator.prepare(validInput()) as Extract<PersonalFeedV2PrepareResult, { readonly kind: 'prepared' }>
    expect(prepared.kind).toBe('prepared')
    expect(prepared.outcome.kind).toBe('incomplete')
    expect(prepared.outcome.category).toBe('source_window')

    await r2Close.rawRetry(true)
    if (mode !== 'r3-incomplete') await r3Close.rawRetry(true)
    const first = sample.coordinator.drain()
    expect(sample.coordinator.drain()).toBe(first)
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

    const first = sample.coordinator.drain()
    const second = sample.coordinator.drain()
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

    const first = sample.coordinator.drain()
    const second = sample.coordinator.drain()
    expect(second).toBe(first)
    const error = await rejected(first)
    expect(error.message).not.toContain('RAW_CLOSE_CANARY')
    expect(r2Close.counts()).toEqual({ proxy: 2, raw: 2 })

    prepared.settle(validReceipt(prepared.outcome.finalText))
    prepared.settle(validReceipt(prepared.outcome.finalText))
    expect(sample.coordinator.read('telegram:7:11')?.status).toBe('delivered')
    expect(r2Close.counts()).toEqual({ proxy: 2, raw: 2 })
  })

  it('keeps settle receipt behavior stable while seal/drain races valid and invalid receipts with one close attempt per authority', async () => {
    const r2Close = recoverableClosePair()
    const r3Close = recoverableClosePair()
    const sample = fixture('r3-admitted', r2Close, r3Close)
    const prepared = await sample.coordinator.prepare(validInput()) as Extract<PersonalFeedV2PrepareResult, { readonly kind: 'prepared' }>
    await r2Close.rawRetry(true)
    await r3Close.rawRetry(true)
    const drainPromise = sample.coordinator.drain()
    expect(() => prepared.settle(validReceipt('wrong text'))).toThrow()
    prepared.settle(validReceipt(prepared.outcome.finalText))
    prepared.settle(validReceipt(prepared.outcome.finalText))
    await drainPromise
    expect(sample.coordinator.read('telegram:7:11')?.status).toBe('delivered')
    expect(r2Close.counts()).toEqual({ proxy: 2, raw: 2 })
    expect(r3Close.counts()).toEqual({ proxy: 2, raw: 2 })
  })
})
