import { EventEmitter, getEventListeners } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { createPersonalFeedV2CandidateLifecycle } from '@herman/personal-feed'

type SurfaceName = 'for_you' | 'following' | 'explore'
type RawBody =
  | { readonly kind: 'sufficient'; readonly text: string }
  | { readonly kind: 'insufficient'; readonly reason: 'placeholder' | 'empty' | 'too_large' | 'show_more_failed' }
type RawOccurrence = Readonly<{
  readonly sourceUrl: string
  readonly body: RawBody
  readonly occurrenceOrdinal: number
  readonly capturedAt: string
  readonly authorHandle: string
  readonly publishedAt: string
}>
type RawSurface = Readonly<{
  readonly kind: 'complete' | 'natural_zero'
  readonly surface: SurfaceName
  readonly surfaceOrdinal: number
  readonly startedAt: string
  readonly completedAt: string
  readonly occurrences: readonly RawOccurrence[]
}>
type RawComplete = Readonly<{
  readonly schemaVersion: 1
  readonly kind: 'complete'
  readonly requestId: string
  readonly cutoff: string
  readonly shanghaiDay: string
  readonly startedAt: string
  readonly completedAt: string
  readonly surfaces: readonly RawSurface[]
}>
type ObserverChild = Readonly<{
  readonly observe: (input: unknown) => Promise<unknown>
}>
type SurfaceObserver = Readonly<{
  readonly observe: (input: unknown) => Promise<unknown>
  readonly shutdown: () => Promise<void>
}>
type SurfaceFactory = (input: unknown) => SurfaceObserver

const REQUEST = Object.freeze({
  requestId: 'telegram:17:23',
  cutoff: '2026-08-31T02:00:00.000Z',
  shanghaiDay: '2026-08-31',
})
const TOP_STARTED = '2026-08-31T02:00:00.100Z'
const TOP_COMPLETED = '2026-08-31T02:00:03.900Z'
const NOW = new Date('2026-08-31T02:00:04.000Z')
const RAW_CANARY_A = 'BODY_CANARY_A_ONLY_DIRECT_TAKE'
const RAW_CANARY_B = 'BODY_CANARY_B_ONLY_DIRECT_TAKE'

function exactInput(signal: AbortSignal = new AbortController().signal): { readonly request: typeof REQUEST; readonly signal: AbortSignal } {
  return Object.freeze({ request: REQUEST, signal })
}

async function loadSurfaceFactory(): Promise<SurfaceFactory> {
  const moduleUrl = new URL('../src/personal-feed/x-surface-observer.ts', import.meta.url).href
  const loaded = await import(/* @vite-ignore */ moduleUrl) as { readonly createPersonalFeedXSurfaceObserver?: unknown }
  if (typeof loaded.createPersonalFeedXSurfaceObserver !== 'function') {
    throw new Error('x-surface-observer does not export createPersonalFeedXSurfaceObserver')
  }
  return loaded.createPersonalFeedXSurfaceObserver as SurfaceFactory
}

class MemoryChildProcess extends EventEmitter {
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  readonly kill = vi.fn(() => true)
  readonly pid = 7301
  readonly stdin = {
    end: vi.fn((...args: unknown[]) => {
      const callback = args.at(-1)
      if (typeof callback === 'function') callback(null)
      queueMicrotask(() => {
        this.stdout.emit('data', this.rawBytes)
        this.emit('close', 0, null)
      })
    }),
  }
  constructor(readonly rawBytes: Uint8Array) {
    super()
  }
}

async function createRealObserverChild(raw: RawComplete | unknown): Promise<{ readonly child: ObserverChild; readonly process: MemoryChildProcess; readonly inputSignals: AbortSignal[] }> {
  const process = new MemoryChildProcess(new TextEncoder().encode(`${JSON.stringify(raw)}\n`))
  const loaded = await import(/* @vite-ignore */ new URL('../src/personal-feed/x-observer-child.ts', import.meta.url).href) as {
    readonly createPersonalFeedXObserverChild?: unknown
  }
  if (typeof loaded.createPersonalFeedXObserverChild !== 'function') throw new Error('x-observer-child factory missing')
  const actualChild = loaded.createPersonalFeedXObserverChild({
    pythonFile: '/usr/bin/python3',
    observerCliPath: '/opt/x-feed/python/x_personal_feed_observer_cli.py',
    totalBudgetMs: 10_000,
    cleanupReserveMs: 2_000,
    killGraceMs: 500,
    nowEpochMs: () => NOW.getTime(),
    spawn: () => process,
    setTimeout,
    clearTimeout,
  }) as ObserverChild
  const inputSignals: AbortSignal[] = []
  const child: ObserverChild = Object.freeze({
    observe: async (input: unknown) => {
      const signal = (input as { readonly signal?: unknown }).signal
      if (signal instanceof AbortSignal) inputSignals.push(signal)
      return actualChild.observe(input)
    },
  })
  return { child, process, inputSignals }
}

function surface(
  surfaceName: SurfaceName,
  ordinal: number,
  startedAt: string,
  completedAt: string,
  occurrences: readonly RawOccurrence[],
  kind: 'complete' | 'natural_zero' = occurrences.length === 0 ? 'natural_zero' : 'complete',
): RawSurface {
  return Object.freeze({ kind, surface: surfaceName, surfaceOrdinal: ordinal, startedAt, completedAt, occurrences: Object.freeze([...occurrences]) })
}

function occurrence(
  sourceUrl: string,
  authorHandle: string,
  body: RawBody,
  occurrenceOrdinal: number,
  capturedAt: string,
): RawOccurrence {
  return Object.freeze({
    sourceUrl,
    body,
    occurrenceOrdinal,
    capturedAt,
    authorHandle,
    publishedAt: capturedAt,
  })
}

function completeRaw(surfaces: readonly RawSurface[] = [
  surface('for_you', 0, '2026-08-31T02:00:00.200Z', '2026-08-31T02:00:01.000Z', [
    occurrence('https://x.com/alpha/status/101', 'alpha', { kind: 'sufficient', text: RAW_CANARY_A }, 0, '2026-08-31T02:00:00.400Z'),
  ]),
  surface('following', 1, '2026-08-31T02:00:01.100Z', '2026-08-31T02:00:02.000Z', [
    occurrence('https://x.com/beta/status/202', 'beta', { kind: 'sufficient', text: RAW_CANARY_B }, 0, '2026-08-31T02:00:01.300Z'),
  ]),
  surface('explore', 2, '2026-08-31T02:00:02.100Z', '2026-08-31T02:00:03.000Z', []),
]): RawComplete {
  return Object.freeze({ schemaVersion: 1, kind: 'complete', ...REQUEST, startedAt: TOP_STARTED, completedAt: TOP_COMPLETED, surfaces: Object.freeze([...surfaces]) })
}

function mixedRaw(): RawComplete {
  return completeRaw([
    surface('for_you', 0, '2026-08-31T02:00:00.200Z', '2026-08-31T02:00:01.000Z', [
      occurrence('https://x.com/alpha/status/101', 'alpha', { kind: 'insufficient', reason: 'placeholder' }, 0, '2026-08-31T02:00:00.400Z'),
      occurrence('https://x.com/beta/status/202', 'beta', { kind: 'sufficient', text: RAW_CANARY_B }, 1, '2026-08-31T02:00:00.600Z'),
    ]),
    surface('following', 1, '2026-08-31T02:00:01.100Z', '2026-08-31T02:00:02.000Z', [
      occurrence('https://x.com/alpha/status/101', 'alpha', { kind: 'sufficient', text: RAW_CANARY_A }, 0, '2026-08-31T02:00:01.300Z'),
      occurrence('https://x.com/beta/status/202', 'beta', { kind: 'sufficient', text: RAW_CANARY_B }, 1, '2026-08-31T02:00:01.500Z'),
    ]),
    surface('explore', 2, '2026-08-31T02:00:02.100Z', '2026-08-31T02:00:03.000Z', [], 'natural_zero'),
  ])
}

function naturalZeroRaw(): RawComplete {
  return completeRaw([
    surface('for_you', 0, '2026-08-31T02:00:00.200Z', '2026-08-31T02:00:01.000Z', [], 'natural_zero'),
    surface('following', 1, '2026-08-31T02:00:01.100Z', '2026-08-31T02:00:02.000Z', [], 'natural_zero'),
    surface('explore', 2, '2026-08-31T02:00:02.100Z', '2026-08-31T02:00:03.000Z', [], 'natural_zero'),
  ])
}

function incompleteRaw(kind: 'complete' | 'natural_zero' | 'partial' | 'failed' | 'unknown'): unknown {
  return Object.freeze({ schemaVersion: 1, kind: 'incomplete', ...REQUEST, startedAt: TOP_STARTED, completedAt: TOP_COMPLETED, surfaces: Object.freeze([
    Object.freeze({ surface: 'for_you', surfaceOrdinal: 0, kind }),
    Object.freeze({ surface: 'following', surfaceOrdinal: 1, kind }),
    Object.freeze({ surface: 'explore', surfaceOrdinal: 2, kind }),
  ]) })
}

function assertFrozenExact(value: unknown, keys: readonly string[]): void {
  expect(Object.isFrozen(value)).toBe(true)
  expect(value).toEqual(expect.objectContaining(Object.fromEntries(keys.map(key => [key, expect.anything()]))))
  expect(Reflect.ownKeys(value as object)).toEqual(keys)
}

function tempLedger(): { readonly path: string; readonly directory: string } {
  const directory = mkdtempSync(join(tmpdir(), 'x-surface-observer-'))
  return { directory, path: join(directory, 'completion.jsonl') }
}

async function admitWithRealR3(window: unknown, signal: AbortSignal, ledgerPath: string, processedQuery?: (input: unknown, signal: AbortSignal) => unknown): Promise<unknown> {
  const lifecycle = createPersonalFeedV2CandidateLifecycle({
    completionLedgerPath: ledgerPath,
    clock: { now: () => NOW },
    ...(processedQuery === undefined ? {} : { processedQuery }),
  })
  return lifecycle.admit({ request: REQUEST, window, signal })
}

function publicCaptures(window: unknown): Array<{ readonly owner: object; readonly take?: Function; readonly close: Function }> {
  const result: Array<{ readonly owner: object; readonly take?: Function; readonly close: Function }> = []
  const surfaces = (window as { readonly surfaces: readonly unknown[] }).surfaces
  for (const surfaceValue of surfaces) {
    const occurrences = (surfaceValue as { readonly occurrences: readonly unknown[] }).occurrences
    for (const occurrenceValue of occurrences) {
      const body = (occurrenceValue as { readonly body: Record<string, unknown> }).body
      if (body.kind === 'sufficient') {
        const capture = body.capture as { readonly take: Function; readonly close: Function }
        result.push({ owner: capture as object, take: capture.take, close: capture.close })
      } else {
        result.push({ owner: body as object, close: body.close as Function })
      }
    }
  }
  return result
}

function scrubbedJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return '<unserializable>'
  }
}

describe('Personal Feed X surface observer Group3C', () => {
  it('maps a real observer-child complete result into the exact R3 capture window without exposing body', async () => {
    const factory = await loadSurfaceFactory()
    const { child: realChild, process, inputSignals } = await createRealObserverChild(mixedRaw())
    const signalController = new AbortController()
    const processedSignals: AbortSignal[] = []
    const processedIds: string[] = []
    const observer = factory({ child: realChild })
    const ledger = tempLedger()
    try {
      const result = await observer.observe(exactInput(signalController.signal))
      expect(inputSignals).toEqual([signalController.signal])
      assertFrozenExact(result, ['kind', 'window', 'close'])
      const resultRecord = result as { readonly kind: string; readonly window: unknown; readonly close: () => Promise<void> }
      expect(resultRecord.kind).toBe('complete')
      expect(scrubbedJson(result)).not.toContain(RAW_CANARY_A)
      expect(scrubbedJson(result)).not.toContain(RAW_CANARY_B)
      const window = resultRecord.window as Record<string, unknown>
      expect(Reflect.ownKeys(window)).toEqual(['requestId', 'cutoff', 'shanghaiDay', 'startedAt', 'completedAt', 'surfaces'])
      expect((window.surfaces as readonly unknown[]).map(surfaceValue => (surfaceValue as Record<string, unknown>).surface)).toEqual(['for_you', 'following', 'explore'])
      const captures = publicCaptures(window)
      expect(captures).toHaveLength(4)
      expect(new Set(captures.map(capture => capture.owner)).size).toBe(4)
      expect(captures.every(capture => Object.isFrozen(capture.owner))).toBe(true)
      const processedQuery = (input: unknown, querySignal: AbortSignal) => {
        processedSignals.push(querySignal)
        processedIds.push((input as { readonly stableId: string }).stableId)
        return { kind: 'unprocessed' as const }
      }
      const lifecycle = createPersonalFeedV2CandidateLifecycle({ completionLedgerPath: ledger.path, clock: { now: () => NOW }, processedQuery })
      const r3InputSignal = signalController.signal
      const admitted = await lifecycle.admit({ request: REQUEST, window, signal: r3InputSignal })
      expect(admitted).toMatchObject({ kind: 'admitted' })
      expect(processedIds).toEqual(['x-status:101', 'x-status:202'])
      expect(processedSignals.every(value => value === r3InputSignal)).toBe(true)
      expect(inputSignals[0]).toBe(r3InputSignal)
      const cursor = (admitted as { readonly cursor: { readonly borrowCurrent: Function; readonly close: Function } }).cursor
      const first = await cursor.borrowCurrent({ signal: r3InputSignal })
      expect(first).toMatchObject({ kind: 'candidate', lease: { position: 0, stableId: 'x-status:101' } })
      const firstLease = (first as { readonly lease: { readonly body: string; readonly completeCurrent: Function } }).lease
      expect(await firstLease.completeCurrent({ judgment: 'qualified' })).toMatchObject({ kind: 'candidate_judgment_completed' })
      expect(firstLease.body).toBe(RAW_CANARY_A)
      expect(scrubbedJson(result)).not.toContain(RAW_CANARY_A)
      const ledgerText = existsSync(ledger.path) ? readFileSync(ledger.path, 'utf8') : ''
      expect(ledgerText).not.toContain(RAW_CANARY_A)
      expect(ledgerText).not.toContain(RAW_CANARY_B)
      await cursor.close('test-cleanup')
      await resultRecord.close()
      await observer.shutdown()
    } finally {
      await observer.shutdown().catch(() => undefined)
      rmSync(ledger.directory, { recursive: true, force: true })
      process.removeAllListeners()
      process.stdout.removeAllListeners()
      process.stderr.removeAllListeners()
    }
  })

  it('preserves all-natural-zero as an exact empty R3 cursor', async () => {
    const factory = await loadSurfaceFactory()
    const { child } = await createRealObserverChild(naturalZeroRaw())
    const controller = new AbortController()
    const observer = factory({ child })
    const ledger = tempLedger()
    try {
      const result = await observer.observe(exactInput(controller.signal))
      assertFrozenExact(result, ['kind', 'window', 'close'])
      expect((result as { readonly kind: string }).kind).toBe('complete')
      const window = (result as { readonly window: Record<string, unknown> }).window
      expect(scrubbedJson(window)).not.toContain('BODY_CANARY')
      const admitted = await admitWithRealR3(window, controller.signal, ledger.path)
      expect(admitted).toMatchObject({ kind: 'admitted' })
      const cursor = (admitted as { readonly cursor: { readonly borrowCurrent: Function; readonly close: Function } }).cursor
      expect(await cursor.borrowCurrent({ signal: controller.signal })).toEqual({ kind: 'done' })
      await cursor.close('test-cleanup')
      await result.close()
      await observer.shutdown()
      rmSync(ledger.directory, { recursive: true, force: true })
    } finally {
      await observer.shutdown().catch(() => undefined)
      rmSync(ledger.directory, { recursive: true, force: true })
    }
  })

  it('linearizes every capture as a distinct one-shot slot bound to the original signal', async () => {
    const factory = await loadSurfaceFactory()
    const controller = new AbortController()
    const otherController = new AbortController()
    const raw = completeRaw([
      surface('for_you', 0, '2026-08-31T02:00:00.200Z', '2026-08-31T02:00:01.000Z', [occurrence('https://x.com/a/status/1', 'a', { kind: 'sufficient', text: RAW_CANARY_A }, 0, '2026-08-31T02:00:00.400Z'), occurrence('https://x.com/b/status/2', 'b', { kind: 'sufficient', text: RAW_CANARY_B }, 1, '2026-08-31T02:00:00.600Z')]),
      surface('following', 1, '2026-08-31T02:00:01.100Z', '2026-08-31T02:00:02.000Z', [occurrence('https://x.com/c/status/3', 'c', { kind: 'sufficient', text: 'BODY_CANARY_C_ONLY_DIRECT_TAKE' }, 0, '2026-08-31T02:00:01.300Z'), occurrence('https://x.com/d/status/4', 'd', { kind: 'insufficient', reason: 'empty' }, 1, '2026-08-31T02:00:01.500Z')]),
      surface('explore', 2, '2026-08-31T02:00:02.100Z', '2026-08-31T02:00:03.000Z', [], 'natural_zero'),
    ])
    const child: ObserverChild = Object.freeze({ observe: async () => raw })
    const observer = factory({ child })
    try {
      const result = await observer.observe(exactInput(controller.signal)) as { readonly window: unknown; readonly close: Function }
      const window = result.window as Record<string, unknown>
      const captures = publicCaptures(window)
      expect(captures).toHaveLength(4)
      expect(new Set(captures.map(capture => capture.owner)).size).toBe(4)
      expect(captures.every(capture => Object.isFrozen(capture.owner))).toBe(true)
      const first = captures[0]
      const second = captures[1]
      const third = captures[2]
      if (first === undefined || second === undefined || third === undefined || first.take === undefined || second.take === undefined || third.take === undefined) throw new Error('capture fixture is incomplete')
      const concurrent = await Promise.all([
        third.take({ signal: controller.signal }),
        third.take({ signal: controller.signal }),
      ])
      expect(concurrent.filter(value => value === 'BODY_CANARY_C_ONLY_DIRECT_TAKE')).toHaveLength(1)
      expect(concurrent.filter(value => value === undefined)).toHaveLength(1)
      expect(await first.take({ signal: otherController.signal })).toBeUndefined()
      expect(await first.take({ signal: controller.signal })).toBe(RAW_CANARY_A)
      expect(await first.take({ signal: controller.signal })).toBeUndefined()
      expect(await second.take({ signal: otherController.signal })).toBeUndefined()
      expect(await second.take({ signal: controller.signal })).toBe(RAW_CANARY_B)
      const closePromise = first.close('test-close')
      expect(closePromise).toBeInstanceOf(Promise)
      expect(await first.take({ signal: controller.signal })).toBeUndefined()
      await closePromise
      await result.close()
      await observer.shutdown()
      expect(Object.keys(observer)).toEqual(['observe', 'shutdown'])
      expect(Object.isFrozen(observer)).toBe(true)
    } finally {
      await observer.shutdown().catch(() => undefined)
    }
  })

  it('closes every public capture across real R3 admission failures and exclusion paths', async () => {
    const factory = await loadSurfaceFactory()
    const cases = [
      ['processed', { kind: 'processed' }, 'admitted'],
      ['duplicate', { kind: 'unprocessed' }, 'admitted'],
      ['not-selected', { kind: 'unprocessed' }, 'admitted'],
      ['processed failed', { kind: 'failed' }, 'incomplete'],
      ['unknown', { kind: 'unknown' }, 'incomplete'],
      ['throw', undefined, 'incomplete'],
      ['abort', { kind: 'aborted' }, 'incomplete'],
      ['mismatched R3 request', { kind: 'unprocessed' }, 'incomplete'],
      ['invalid input', { kind: 'unprocessed' }, 'incomplete'],
      ['capture unavailable', { kind: 'unprocessed' }, 'incomplete'],
    ] as const
    for (const [label, queryResult, expectedKind] of cases) {
      const controller = new AbortController()
      const child: ObserverChild = Object.freeze({ observe: async () => mixedRaw() })
      const observer = factory({ child })
      const ledger = tempLedger()
      try {
        const result = await observer.observe(exactInput(controller.signal)) as { readonly window: unknown; readonly close: Function }
        const captures = publicCaptures(result.window)
        const query = (_input: unknown, _signal: AbortSignal) => {
          if (label === 'throw') throw new Error(RAW_CANARY_A)
          return queryResult
        }
        const lifecycle = createPersonalFeedV2CandidateLifecycle({ completionLedgerPath: ledger.path, clock: { now: () => NOW }, processedQuery: query })
        const request = label === 'mismatched R3 request' ? Object.freeze({ ...REQUEST, requestId: 'telegram:17:24' }) : REQUEST
        const input = label === 'invalid input' ? { request, window: result.window, signal: controller.signal, extra: true } : { request, window: result.window, signal: controller.signal }
        if (label === 'capture unavailable') await result.close()
        const outcome = await lifecycle.admit(input)
        expect(outcome).toMatchObject({ kind: expectedKind })
        expect(scrubbedJson(outcome)).not.toContain(RAW_CANARY_A)
        expect(scrubbedJson(outcome)).not.toContain(RAW_CANARY_B)
        await result.close()
        if (expectedKind === 'admitted') {
          await (outcome as { readonly cursor: { readonly close: (reason: string) => Promise<void> } }).cursor.close('test-cleanup')
        }
        for (const capture of captures) {
          await capture.close('test-idempotent-close')
          await capture.close('test-repeated-close')
          if (capture.take !== undefined) expect(await capture.take({ signal: controller.signal })).toBeUndefined()
        }
      } finally {
        await observer.shutdown().catch(() => undefined)
        rmSync(ledger.directory, { recursive: true, force: true })
      }
    }
  })

  it('fails every non-complete or malformed child result closed and body-free', async () => {
    const factory = await loadSurfaceFactory()
    let proxyTraps = 0
    let accessorReads = 0
    let midConversionReads = 0
    const proxyFixture = new Proxy(completeRaw(), { ownKeys: () => { proxyTraps += 1; throw new Error(RAW_CANARY_A) } })
    const accessorFixture = Object.defineProperty({ ...completeRaw() }, 'startedAt', { get: () => { accessorReads += 1; throw new Error(RAW_CANARY_A) } })
    const midFaultBody = Object.defineProperty({ kind: 'sufficient' }, 'text', { enumerable: true, get: () => { midConversionReads += 1; throw new Error(RAW_CANARY_B) } })
    const midFault = completeRaw([
      surface('for_you', 0, '2026-08-31T02:00:00.200Z', '2026-08-31T02:00:01.000Z', [
        occurrence('https://x.com/alpha/status/101', 'alpha', { kind: 'sufficient', text: RAW_CANARY_A }, 0, '2026-08-31T02:00:00.400Z'),
        { ...occurrence('https://x.com/beta/status/202', 'beta', { kind: 'sufficient', text: RAW_CANARY_B }, 1, '2026-08-31T02:00:00.600Z'), body: midFaultBody as unknown as RawBody },
      ]),
      surface('following', 1, '2026-08-31T02:00:01.100Z', '2026-08-31T02:00:02.000Z', [occurrence('https://x.com/gamma/status/303', 'gamma', { kind: 'sufficient', text: RAW_CANARY_B }, 0, '2026-08-31T02:00:01.300Z')]),
      surface('explore', 2, '2026-08-31T02:00:02.100Z', '2026-08-31T02:00:03.000Z', [], 'natural_zero'),
    ])
    const malformedResults: unknown[] = [
      incompleteRaw('complete'), incompleteRaw('natural_zero'), incompleteRaw('partial'), incompleteRaw('failed'), incompleteRaw('unknown'),
      { kind: 'error', code: 'aborted' }, { kind: 'error', code: 'invalid_request' }, { kind: 'error', code: 'child_invalid_input' },
      { kind: 'error', code: 'insufficient_budget' }, { kind: 'error', code: 'observer_failed' }, { kind: 'error', code: 'protocol_invalid' }, { kind: 'error', code: 'timed_out' },
      new Error(RAW_CANARY_A), Object.freeze({ kind: 'reject' }),
      Object.freeze({ ...completeRaw(), surfaces: Object.freeze([]) }),
      Object.freeze({ ...completeRaw(), extra: RAW_CANARY_A }),
      proxyFixture,
      accessorFixture,
      midFault,
    ]
    for (const malformed of malformedResults) {
      const controller = new AbortController()
      const child: ObserverChild = Object.freeze({ observe: async () => {
        if (malformed instanceof Error) throw malformed
        if (typeof malformed === 'object' && malformed !== null && 'kind' in malformed && malformed.kind === 'reject') {
          throw new Error(RAW_CANARY_B)
        }
        return malformed
      } })
      const observer = factory({ child })
      try {
        const value = await observer.observe(exactInput(controller.signal))
        expect(value).toEqual(Object.freeze({ kind: 'incomplete' }))
        expect(Reflect.ownKeys(value as object)).toEqual(['kind'])
        expect(scrubbedJson(value)).not.toContain(RAW_CANARY_A)
        expect(scrubbedJson(value)).not.toContain(RAW_CANARY_B)
      } finally {
        await observer.shutdown().catch(() => undefined)
      }
    }
    expect(proxyTraps).toBe(0)
    expect(accessorReads).toBe(0)
    expect(midConversionReads).toBe(0)
    const preAborted = new AbortController()
    preAborted.abort()
    let preAbortChildCalls = 0
    const preAbortObserver = factory({ child: Object.freeze({ observe: async () => { preAbortChildCalls += 1; return completeRaw() } }) })
    try {
      expect(await preAbortObserver.observe(exactInput(preAborted.signal))).toEqual(Object.freeze({ kind: 'incomplete' }))
      expect(preAbortChildCalls).toBe(0)
    } finally {
      await preAbortObserver.shutdown().catch(() => undefined)
    }
    const deferredController = new AbortController()
    let resolveDeferred!: (value: unknown) => void
    const deferred = new Promise<unknown>(resolve => { resolveDeferred = resolve })
    const deferredObserver = factory({ child: Object.freeze({ observe: async () => await deferred }) })
    try {
      const pending = deferredObserver.observe(exactInput(deferredController.signal))
      deferredController.abort()
      resolveDeferred(completeRaw())
      expect(await pending).toEqual(Object.freeze({ kind: 'incomplete' }))
    } finally {
      resolveDeferred(completeRaw())
      await deferredObserver.shutdown().catch(() => undefined)
    }
  })

  it('uses one abort listener per complete batch and closes the transfer gap', async () => {
    const factory = await loadSurfaceFactory()
    const firstController = new AbortController()
    const firstObserver = factory({ child: Object.freeze({ observe: async () => completeRaw() }) })
    const firstBaseline = getEventListeners(firstController.signal, 'abort')
    try {
      const result = await firstObserver.observe(exactInput(firstController.signal)) as { readonly window: unknown; readonly close: Function }
      const handles = publicCaptures(result.window)
      const afterComplete = getEventListeners(firstController.signal, 'abort')
      expect(afterComplete).toHaveLength(firstBaseline.length + 1)
      const listener = afterComplete.at(-1)
      firstController.abort()
      expect(getEventListeners(firstController.signal, 'abort')).toEqual(firstBaseline)
      for (const handle of handles) {
        if (handle.take !== undefined) expect(await handle.take({ signal: firstController.signal })).toBeUndefined()
      }
      await result.close()
      await firstObserver.shutdown()
      expect(getEventListeners(firstController.signal, 'abort')).toEqual(firstBaseline)
      expect(listener).toBeDefined()
    } finally {
      await firstObserver.shutdown().catch(() => undefined)
    }
    const secondController = new AbortController()
    const secondObserver = factory({ child: Object.freeze({ observe: async () => completeRaw() }) })
    const secondBaseline = getEventListeners(secondController.signal, 'abort')
    try {
      const result = await secondObserver.observe(exactInput(secondController.signal)) as { readonly close: Function }
      expect(getEventListeners(secondController.signal, 'abort')).toHaveLength(secondBaseline.length + 1)
      await result.close()
      expect(getEventListeners(secondController.signal, 'abort')).toEqual(secondBaseline)
      await secondObserver.shutdown()
    } finally {
      await secondObserver.shutdown().catch(() => undefined)
    }
  })

  it('seals and drains the owner on shutdown without creating a second request signal', async () => {
    const factory = await loadSurfaceFactory()
    const deferred: { resolve: (value: unknown) => void; promise: Promise<unknown> } = {} as never
    deferred.promise = new Promise(resolve => { deferred.resolve = resolve })
    const controller = new AbortController()
    let calls = 0
    const child: ObserverChild = Object.freeze({ observe: async () => { calls += 1; return await deferred.promise } })
    const observer = factory({ child })
    try {
      const pending = observer.observe(exactInput(controller.signal))
      const shutdown = observer.shutdown()
      expect(Object.isFrozen(observer)).toBe(true)
      expect(await observer.observe(exactInput(controller.signal))).toEqual(Object.freeze({ kind: 'incomplete' }))
      expect(calls).toBe(1)
      deferred.resolve(completeRaw())
      expect(await pending).toEqual(Object.freeze({ kind: 'incomplete' }))
      expect(observer.shutdown()).toBe(shutdown)
      await shutdown
      expect(controller.signal.aborted).toBe(false)
      expect(calls).toBe(1)
    } finally {
      deferred.resolve(completeRaw())
      await observer.shutdown().catch(() => undefined)
    }
    const secondController = new AbortController()
    const secondObserver = factory({ child: Object.freeze({ observe: async () => completeRaw() }) })
    try {
      const secondResult = await secondObserver.observe(exactInput(secondController.signal)) as { readonly window: unknown; readonly close: Function }
      const handles = publicCaptures(secondResult.window)
      const shutdown = secondObserver.shutdown()
      for (const handle of handles) {
        if (handle.take !== undefined) expect(await handle.take({ signal: secondController.signal })).toBeUndefined()
      }
      await shutdown
      expect(getEventListeners(secondController.signal, 'abort')).toHaveLength(0)
      await secondResult.close()
      await secondObserver.shutdown()
    } finally {
      await secondObserver.shutdown().catch(() => undefined)
    }
  })

  it('keeps body bytes out of every project-controlled persistent or diagnostic surface', async () => {
    const factory = await loadSurfaceFactory()
    const sourcePath = new URL('../src/personal-feed/x-surface-observer.ts', import.meta.url)
    const source = existsSync(sourcePath) ? readFileSync(sourcePath, 'utf8') : ''
    const rootSource = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
    expect(rootSource).not.toContain('x-surface-observer')
    expect(source).not.toMatch(/from\s+['"]node:fs(?:\/promises)?['"]|require\(\s*['"]node:fs/)
    expect(source).not.toMatch(/\b(?:session|timeline|history|shown|current_collection|recovery)\b\s*\./)
    expect(source).not.toMatch(/\b(?:console|logger|log)\s*\./)
    const controller = new AbortController()
    const observer = factory({ child: Object.freeze({ observe: async () => completeRaw() }) })
    const ledger = tempLedger()
    try {
      const result = await observer.observe(exactInput(controller.signal)) as { readonly window: unknown; readonly close: Function }
      const owner = createPersonalFeedV2CandidateLifecycle({ completionLedgerPath: ledger.path, clock: { now: () => NOW }, processedQuery: () => ({ kind: 'unprocessed' as const }) })
      const admitted = await owner.admit({ request: REQUEST, window: result.window, signal: controller.signal })
      expect(scrubbedJson(result)).not.toContain(RAW_CANARY_A)
      expect(scrubbedJson(result)).not.toContain(RAW_CANARY_B)
      expect(scrubbedJson(admitted)).not.toContain(RAW_CANARY_A)
      expect(scrubbedJson(admitted)).not.toContain(RAW_CANARY_B)
      const ledgerText = existsSync(ledger.path) ? readFileSync(ledger.path, 'utf8') : ''
      expect(ledgerText).not.toContain(RAW_CANARY_A)
      expect(ledgerText).not.toContain(RAW_CANARY_B)
      if (admitted && typeof admitted === 'object' && 'cursor' in admitted) {
        await (admitted as { readonly cursor: { readonly close: (reason: string) => Promise<void> } }).cursor.close('test-cleanup')
      }
      await result.close()
      await observer.shutdown()
      expect(scrubbedJson(await observer.observe(exactInput(controller.signal)))).not.toContain(RAW_CANARY_A)
      expect(scrubbedJson(await observer.observe(exactInput(controller.signal)))).not.toContain(RAW_CANARY_B)
    } finally {
      await observer.shutdown().catch(() => undefined)
      rmSync(ledger.directory, { recursive: true, force: true })
    }
  })
})
