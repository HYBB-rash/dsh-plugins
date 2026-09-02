import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  CreatePersonalFeedV2CandidateLifecycleOptions,
  CreatePersonalFeedV2RequestCoordinatorOptions,
  PersonalFeedV2R2Input,
  PersonalFeedV2R4Input,
  PersonalFeedV2Request,
} from '@herman/personal-feed'
import type {
  TelegramInboundEnvelope,
  TelegramInboundResult,
} from '@deepseek-ai/dsh-telegram-gateway'

type AnyFactory = (options: never) => unknown

const observed = vi.hoisted(() => ({
  candidateOptions: [] as unknown[],
  coordinatorOptions: [] as unknown[],
}))

vi.mock('@herman/personal-feed', async importOriginal => {
  const actual = await importOriginal() as Record<string, unknown>
  const candidateFactory = actual.createPersonalFeedV2CandidateLifecycle as AnyFactory
  const coordinatorFactory = actual.createPersonalFeedV2RequestCoordinator as AnyFactory
  return {
    ...actual,
    createPersonalFeedV2CandidateLifecycle: vi.fn((options: unknown) => {
      observed.candidateOptions.push(options)
      return candidateFactory(options as never)
    }),
    createPersonalFeedV2RequestCoordinator: vi.fn((options: unknown) => {
      observed.coordinatorOptions.push(options)
      return coordinatorFactory(options as never)
    }),
  }
})

const COMPOSITION_MODULE_URL = new URL('../src/personal-feed/telegram-production-composition.ts', import.meta.url).href
const SOURCE_ROOT_URL = new URL('../src/index.ts', import.meta.url).href
const LIB_ROOT_URL = new URL('../lib/index.js', import.meta.url).href
const temporaryDirectories: string[] = []
const CLOCK_NOW = '2026-09-01T00:00:00.000Z'
const SOURCE_WINDOW_TEXT = '这次没有完成：X 来源或观察窗口未完成。'
const JUDGEMENT_EXECUTION_TEXT = '这次没有完成：判断或执行未完成。'

type Composition = Readonly<{
  readonly handler: (envelope: TelegramInboundEnvelope) => Promise<TelegramInboundResult>
  readonly shutdown: () => Promise<void>
}>

type CompositionModule = Readonly<{
  readonly createPersonalFeedTelegramProductionComposition?: (options: unknown) => Composition
}>

type Owner = Readonly<{
  readonly observe: (input: PersonalFeedV2R2Input) => unknown
  readonly shutdown: () => unknown
}>

type OwnerMode = 'complete' | 'throw' | 'reject' | 'malformed' | 'partial' | 'unknown'

function loadCompositionModule(): Promise<CompositionModule> {
  return import(COMPOSITION_MODULE_URL) as Promise<CompositionModule>
}

function makeNaturalZeroWindow(request: PersonalFeedV2Request): unknown {
  return Object.freeze({
    requestId: request.requestId,
    cutoff: request.cutoff,
    shanghaiDay: request.shanghaiDay,
    startedAt: request.cutoff,
    completedAt: request.cutoff,
    surfaces: Object.freeze([
      Object.freeze({
        kind: 'natural_zero',
        surface: 'for_you',
        surfaceOrdinal: 0,
        startedAt: request.cutoff,
        completedAt: request.cutoff,
        occurrences: Object.freeze([]),
      }),
      Object.freeze({
        kind: 'natural_zero',
        surface: 'following',
        surfaceOrdinal: 1,
        startedAt: request.cutoff,
        completedAt: request.cutoff,
        occurrences: Object.freeze([]),
      }),
      Object.freeze({
        kind: 'natural_zero',
        surface: 'explore',
        surfaceOrdinal: 2,
        startedAt: request.cutoff,
        completedAt: request.cutoff,
        occurrences: Object.freeze([]),
      }),
    ]),
  })
}

function makeR4(onCall?: (input: PersonalFeedV2R4Input) => void): Readonly<{ snapshot: (input: PersonalFeedV2R4Input) => unknown }> {
  return Object.freeze({
    snapshot: (input: PersonalFeedV2R4Input) => {
      onCall?.(input)
      return Object.freeze({ kind: 'sufficient', snapshot: Object.freeze({ source: 'composition-test' }) })
    },
  })
}

function makeEnvelope(messageId: number, signal = new AbortController().signal): TelegramInboundEnvelope {
  return Object.freeze({
    chat: Object.freeze({ id: 7, type: 'private' }),
    message: Object.freeze({ id: messageId }),
    currentText: '给我一次个人 Feed',
    signal,
  })
}

function makeOptions(
  directory: string,
  runtimeConfig: object,
  startupFactory: (runtimeConfig: unknown) => unknown,
  r4 = makeR4(),
  clock: Readonly<{ now: () => Date }> = Object.freeze({ now: () => new Date(CLOCK_NOW) }),
  completionLedgerPath = join(directory, 'candidate-completions.jsonl'),
): unknown {
  return Object.freeze({
    runtimeConfig,
    startupFactory,
    r4,
    completionLedgerPath,
    clock,
  })
}

function makeOwner(
  mode: OwnerMode,
  counters: { observe: number; shutdown: number; receivers: object[] },
  options: { readonly pending?: Promise<unknown>; readonly entered?: () => void } = {},
): Owner {
  const observe = function (this: object, input: PersonalFeedV2R2Input): unknown {
    counters.observe += 1
    counters.receivers.push(this)
    options.entered?.()
    if (mode === 'throw') throw new Error('CANARY_OWNER_OBSERVE_THROW')
    if (mode === 'reject') return Promise.reject(new Error('CANARY_OWNER_OBSERVE_REJECT'))
    if (mode === 'malformed') return Object.freeze({ kind: 'not-complete' })
    if (mode === 'partial') return Object.freeze({ kind: 'complete', window: makeNaturalZeroWindow(input.request) })
    if (mode === 'unknown') return Object.freeze({ kind: 'unknown' })
    if (options.pending !== undefined) return options.pending.then(() => Object.freeze({
      kind: 'complete',
      window: makeNaturalZeroWindow(input.request),
      close: () => undefined,
    }))
    return Object.freeze({
      kind: 'complete',
      window: makeNaturalZeroWindow(input.request),
      close: () => undefined,
    })
  }
  const shutdown = (): unknown => {
    counters.shutdown += 1
    return undefined
  }
  return Object.freeze({ observe, shutdown })
}

function requestRecord(path: string, requestId: string): Readonly<{ readonly category?: string; readonly finalText?: string }> | undefined {
  if (!existsSync(path)) return undefined
  const records = readFileSync(path, 'utf8')
    .split('\n')
    .filter(line => line !== '')
    .map(line => JSON.parse(line) as { readonly event?: unknown; readonly requestId?: unknown; readonly outcome?: { readonly category?: unknown; readonly finalText?: unknown } })
  const record = records.find(item => item.event === 'outcome_prepared' && item.requestId === requestId)
  return record?.outcome === undefined
    ? undefined
    : { category: typeof record.outcome.category === 'string' ? record.outcome.category : undefined, finalText: typeof record.outcome.finalText === 'string' ? record.outcome.finalText : undefined }
}

function settleResult(result: TelegramInboundResult, messageId: number): void {
  if (result.kind !== 'handled-awaiting-delivery') throw new Error('composition did not prepare Telegram delivery')
  result.settle({
    chatId: 7,
    triggerMessageId: messageId,
    visibleText: result.finalText,
    messageIds: [messageId + 1000],
  })
}

function errorMessages(error: unknown): string[] {
  if (error instanceof AggregateError) return error.errors.flatMap(errorMessages)
  return [error instanceof Error ? error.message : String(error)]
}

function deferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void
  const promise = new Promise<Value>((resolveValue) => { resolve = resolveValue })
  return { promise, resolve }
}

function settleWithin<Value>(promise: Promise<Value>): Promise<Value> {
  const watchdog = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('personal Feed Telegram shutdown did not settle')), 250)
  })
  return Promise.race([promise, watchdog])
}

afterEach(() => {
  observed.candidateOptions.length = 0
  observed.coordinatorOptions.length = 0
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('Personal Feed Telegram production composition', () => {
  it('keeps the production constructor private and rejects non-exact frozen data carriers', async () => {
    const privateModule = await loadCompositionModule()
    expect(Object.keys(privateModule)).toEqual(['createPersonalFeedTelegramProductionComposition'])
    expect(typeof privateModule.createPersonalFeedTelegramProductionComposition).toBe('function')
    const sourceRoot = await import(SOURCE_ROOT_URL) as Record<string, unknown>
    const libRoot = await import(LIB_ROOT_URL) as Record<string, unknown>
    expect(Object.hasOwn(sourceRoot, 'createPersonalFeedTelegramProductionComposition')).toBe(false)
    expect(Object.hasOwn(libRoot, 'createPersonalFeedTelegramProductionComposition')).toBe(false)
    if (typeof privateModule.createPersonalFeedTelegramProductionComposition !== 'function') return

    const directory = mkdtempSync(join(tmpdir(), 'personal-feed-telegram-composition-surface-'))
    temporaryDirectories.push(directory)
    const runtimeConfig = Object.freeze({ dataDir: join(directory, 'data') })
    const startupFactory = (_config: unknown): Owner => makeOwner('complete', { observe: 0, shutdown: 0, receivers: [] })
    const valid = makeOptions(directory, runtimeConfig, startupFactory)
    const composition = privateModule.createPersonalFeedTelegramProductionComposition(valid)
    expect(Object.getPrototypeOf(composition)).toBe(Object.prototype)
    expect(Reflect.ownKeys(composition)).toEqual(['handler', 'shutdown'])
    expect(Object.isFrozen(composition)).toBe(true)
    expect(typeof composition.handler).toBe('function')
    expect(typeof composition.shutdown).toBe('function')
    expect(privateModule.createPersonalFeedTelegramProductionComposition.length).toBe(1)

    const extra = Object.freeze({ ...(valid as Record<string, unknown>), CANARY_EXTRA: true })
    const accessor = { ...(valid as Record<string, unknown>) }
    Object.defineProperty(accessor, 'runtimeConfig', { enumerable: true, configurable: false, get: () => runtimeConfig })
    Object.freeze(accessor)
    const proxy = new Proxy(valid as object, { get: () => { throw new Error('CANARY_PROXY_GET') } })
    const mutableRuntime = makeOptions(directory, { dataDir: 'mutable' }, startupFactory)
    for (const invalid of [extra, accessor, proxy, mutableRuntime]) {
      expect(() => privateModule.createPersonalFeedTelegramProductionComposition(invalid)).toThrow()
    }
  })

  it('lazily creates one owner, reuses its receiver, forwards exact request coordinates/signals, and reaches real R3', async () => {
    const module = await loadCompositionModule()
    if (typeof module.createPersonalFeedTelegramProductionComposition !== 'function') throw new Error('composition constructor is missing')
    const directory = mkdtempSync(join(tmpdir(), 'personal-feed-telegram-composition-lazy-'))
    temporaryDirectories.push(directory)
    const runtimeConfig = Object.freeze({ dataDir: join(directory, 'data'), parsed: true })
    const clock = Object.freeze({ now: () => new Date(CLOCK_NOW) })
    const ownerCounters = { observe: 0, shutdown: 0, receivers: [] as object[] }
    const factoryConfigs: unknown[] = []
    const requestSignals: AbortSignal[] = []
    const requestCoordinates: PersonalFeedV2Request[] = []
    const r4 = makeR4()
    const startupFactory = (config: unknown): Owner => {
      factoryConfigs.push(config)
      const observe = function (this: object, input: PersonalFeedV2R2Input): unknown {
        ownerCounters.observe += 1
        ownerCounters.receivers.push(this)
        requestSignals.push(input.signal)
        requestCoordinates.push(input.request)
        return Object.freeze({
          kind: 'complete',
          window: makeNaturalZeroWindow(input.request),
          close: () => undefined,
        })
      }
      return Object.freeze({ observe, shutdown: () => { ownerCounters.shutdown += 1 } })
    }
    const composition = module.createPersonalFeedTelegramProductionComposition(makeOptions(directory, runtimeConfig, startupFactory, r4, clock))
    expect(factoryConfigs).toHaveLength(0)
    expect(observed.candidateOptions).toHaveLength(1)
    expect(observed.coordinatorOptions).toHaveLength(1)
    const candidateOptions = observed.candidateOptions[0] as CreatePersonalFeedV2CandidateLifecycleOptions
    const coordinatorOptions = observed.coordinatorOptions[0] as CreatePersonalFeedV2RequestCoordinatorOptions
    expect(candidateOptions.clock).toBe(clock)
    expect(coordinatorOptions.clock).toBe(clock)

    const requestResults = [
      await composition.handler(makeEnvelope(21)),
      await composition.handler(makeEnvelope(22)),
      ...(await Promise.all([
        composition.handler(makeEnvelope(23)),
        composition.handler(makeEnvelope(24)),
      ])),
    ]
    for (const [index, result] of requestResults.entries()) {
      expect(result).toMatchObject({ kind: 'handled-awaiting-delivery', finalText: JUDGEMENT_EXECUTION_TEXT })
      settleResult(result, 21 + index)
    }
    expect(factoryConfigs).toHaveLength(1)
    expect(factoryConfigs[0]).toBe(runtimeConfig)
    expect(ownerCounters.observe).toBe(4)
    expect(new Set(ownerCounters.receivers).size).toBe(1)
    expect(requestCoordinates).toHaveLength(4)
    expect(requestCoordinates.map(request => request.requestId)).toEqual([
      'telegram:7:21', 'telegram:7:22', 'telegram:7:23', 'telegram:7:24',
    ])
    expect(requestCoordinates.every(request => request.cutoff === CLOCK_NOW && request.shanghaiDay === '2026-09-01')).toBe(true)
    expect(requestSignals).toHaveLength(4)
    expect(requestSignals.every(signal => signal instanceof AbortSignal && !signal.aborted)).toBe(true)
    expect(new Set(requestSignals).size).toBe(4)
    expect(requestResults.every(result => result.kind === 'handled-awaiting-delivery')).toBe(true)
    await composition.shutdown()
  })

  it('accepts an ordinary R4 data-descriptor port and preserves its receiver through one real request', async () => {
    const module = await loadCompositionModule()
    if (typeof module.createPersonalFeedTelegramProductionComposition !== 'function') throw new Error('composition constructor is missing')
    const directory = mkdtempSync(join(tmpdir(), 'personal-feed-telegram-composition-r4-descriptor-'))
    temporaryDirectories.push(directory)
    const runtimeConfig = Object.freeze({ dataDir: directory })
    const receivers: object[] = []
    const r4 = {
      snapshot(this: object, _input: PersonalFeedV2R4Input): unknown {
        receivers.push(this)
        return Object.freeze({ kind: 'sufficient', snapshot: Object.freeze({ source: 'ordinary-r4' }) })
      },
    }
    const ownerCounters = { observe: 0, shutdown: 0, receivers: [] as object[] }
    const startupFactory = (_config: unknown): Owner => makeOwner('complete', ownerCounters)
    const composition = module.createPersonalFeedTelegramProductionComposition(makeOptions(directory, runtimeConfig, startupFactory, r4))
    const descriptor = Object.getOwnPropertyDescriptor(r4, 'snapshot')
    expect(descriptor?.enumerable).toBe(true)
    expect(descriptor?.configurable).toBe(true)
    expect(descriptor?.writable).toBe(true)
    const result = await composition.handler(makeEnvelope(27))
    expect(result).toMatchObject({ kind: 'handled-awaiting-delivery', finalText: JUDGEMENT_EXECUTION_TEXT })
    settleResult(result, 27)
    expect(receivers).toEqual([r4])
    await composition.shutdown()
  })

  it.each([
    ['factory throw', 'throw'] as const,
    ['invalid owner shape', 'invalid'] as const,
  ])('caches %s as permanent source-window failure without creating an owner', async (_label, mode) => {
    const module = await loadCompositionModule()
    if (typeof module.createPersonalFeedTelegramProductionComposition !== 'function') throw new Error('composition constructor is missing')
    const directory = mkdtempSync(join(tmpdir(), 'personal-feed-telegram-composition-factory-failure-'))
    temporaryDirectories.push(directory)
    const runtimeConfig = Object.freeze({ dataDir: directory })
    const counters = { observe: 0, shutdown: 0, receivers: [] as object[] }
    let factoryCalls = 0
    const startupFactory = (_config: unknown): unknown => {
      factoryCalls += 1
      if (mode === 'throw') throw new Error('CANARY_FACTORY_THROW')
      const owner = makeOwner('complete', counters)
      return Object.freeze({ observe: owner.observe, shutdown: owner.shutdown, CANARY_EXTRA: true })
    }
    const composition = module.createPersonalFeedTelegramProductionComposition(makeOptions(directory, runtimeConfig, startupFactory))
    for (const messageId of [31, 32]) {
      const result = await composition.handler(makeEnvelope(messageId))
      expect(result).toMatchObject({ kind: 'handled-awaiting-delivery', finalText: SOURCE_WINDOW_TEXT })
      settleResult(result, messageId)
    }
    expect(factoryCalls).toBe(1)
    expect(counters.observe).toBe(0)
    expect(counters.shutdown).toBe(0)
    await composition.shutdown()
    const afterShutdown = await composition.handler(makeEnvelope(33))
    expect(afterShutdown).toMatchObject({ kind: 'failed' })
    expect(factoryCalls).toBe(1)
    expect(counters.shutdown).toBe(0)
  })

  it.each([
    ['sync throw', 'throw'],
    ['reject', 'reject'],
    ['malformed', 'malformed'],
    ['partial', 'partial'],
    ['unknown', 'unknown'],
  ] as const)('does not poison the lazy owner after %s observe result', async (_label, mode) => {
    const module = await loadCompositionModule()
    if (typeof module.createPersonalFeedTelegramProductionComposition !== 'function') throw new Error('composition constructor is missing')
    const directory = mkdtempSync(join(tmpdir(), 'personal-feed-telegram-composition-observe-failure-'))
    temporaryDirectories.push(directory)
    const runtimeConfig = Object.freeze({ dataDir: directory })
    const counters = { observe: 0, shutdown: 0, receivers: [] as object[] }
    let factoryCalls = 0
    let observeCalls = 0
    const ownerReceivers: object[] = []
    const startupFactory = (_config: unknown): Owner => {
      factoryCalls += 1
      const first = makeOwner(mode, counters)
      const second = makeOwner('complete', counters)
      const observe = function (this: object, input: PersonalFeedV2R2Input): unknown {
        observeCalls += 1
        ownerReceivers.push(this)
        return Reflect.apply(observeCalls === 1 ? first.observe : second.observe, observeCalls === 1 ? first : second, [input])
      }
      return Object.freeze({ observe, shutdown: first.shutdown })
    }
    const composition = module.createPersonalFeedTelegramProductionComposition(makeOptions(directory, runtimeConfig, startupFactory))
    const first = await composition.handler(makeEnvelope(41))
    expect(first).toMatchObject({ kind: 'handled-awaiting-delivery', finalText: SOURCE_WINDOW_TEXT })
    settleResult(first, 41)
    const second = await composition.handler(makeEnvelope(42))
    expect(second).toMatchObject({ kind: 'handled-awaiting-delivery', finalText: JUDGEMENT_EXECUTION_TEXT })
    settleResult(second, 42)
    expect(factoryCalls).toBe(1)
    expect(observeCalls).toBe(2)
    expect(ownerReceivers).toHaveLength(2)
    expect(ownerReceivers[0]).toBe(ownerReceivers[1])
    const requestsPath = join(directory, 'requests.jsonl')
    expect(requestRecord(requestsPath, 'telegram:7:41')).toEqual({ category: 'source_window', finalText: SOURCE_WINDOW_TEXT })
    expect(requestRecord(requestsPath, 'telegram:7:42')).toEqual({ category: 'judgement_execution', finalText: JUDGEMENT_EXECUTION_TEXT })
    expect(existsSync(join(directory, 'candidate-completions.jsonl'))).toBe(false)
    await composition.shutdown()
  })

  it('shuts down first with one cached promise and never initializes the lazy owner', async () => {
    const module = await loadCompositionModule()
    if (typeof module.createPersonalFeedTelegramProductionComposition !== 'function') throw new Error('composition constructor is missing')
    const directory = mkdtempSync(join(tmpdir(), 'personal-feed-telegram-composition-shutdown-first-'))
    temporaryDirectories.push(directory)
    const counters = { observe: 0, shutdown: 0, receivers: [] as object[] }
    let factoryCalls = 0
    const runtimeConfig = Object.freeze({ dataDir: directory })
    const startupFactory = (_config: unknown): Owner => {
      factoryCalls += 1
      return makeOwner('complete', counters)
    }
    const composition = module.createPersonalFeedTelegramProductionComposition(makeOptions(directory, runtimeConfig, startupFactory))
    const firstShutdown = composition.shutdown()
    expect(composition.shutdown()).toBe(firstShutdown)
    await firstShutdown
    const result = await composition.handler(makeEnvelope(51))
    expect(result).toMatchObject({ kind: 'failed' })
    expect(factoryCalls).toBe(0)
    expect(counters.observe).toBe(0)
    expect(counters.shutdown).toBe(0)
  })

  it('aborts active observation before waiting, releases it into source-window incomplete, and closes exactly once', async () => {
    const module = await loadCompositionModule()
    if (typeof module.createPersonalFeedTelegramProductionComposition !== 'function') throw new Error('composition constructor is missing')
    const directory = mkdtempSync(join(tmpdir(), 'personal-feed-telegram-composition-active-shutdown-'))
    temporaryDirectories.push(directory)
    const entered = deferred<void>()
    const release = deferred<unknown>()
    const counters = { observe: 0, shutdown: 0, receivers: [] as object[] }
    let closeCalls = 0
    let factoryCalls = 0
    let activeSignal: AbortSignal | undefined
    const runtimeConfig = Object.freeze({ dataDir: directory })
    const startupFactory = (_config: unknown): Owner => {
      factoryCalls += 1
      const owner = makeOwner('complete', counters)
      const observe = function (this: object, input: PersonalFeedV2R2Input): unknown {
        counters.observe += 1
        counters.receivers.push(this)
        activeSignal = input.signal
        entered.resolve(undefined)
        return release.promise.then(() => Object.freeze({
          kind: 'complete',
          window: makeNaturalZeroWindow(input.request),
          close: () => { closeCalls += 1 },
        }))
      }
      return Object.freeze({ observe, shutdown: owner.shutdown })
    }
    const composition = module.createPersonalFeedTelegramProductionComposition(makeOptions(directory, runtimeConfig, startupFactory))
    const requestPromise = composition.handler(makeEnvelope(61))
    await entered.promise
    const shutdown = composition.shutdown()
    expect(counters.observe).toBe(1)
    expect(activeSignal?.aborted).toBe(true)
    let shutdownFinished = false
    void shutdown.then(() => { shutdownFinished = true }, () => { shutdownFinished = true })
    await Promise.resolve()
    expect(shutdownFinished).toBe(false)
    release.resolve(undefined)
    const result = await requestPromise
    expect(result).toMatchObject({ kind: 'handled-awaiting-delivery', finalText: SOURCE_WINDOW_TEXT })
    settleResult(result, 61)
    expect(composition.shutdown()).toBe(shutdown)
    await shutdown
    expect(factoryCalls).toBe(1)
    expect(counters.shutdown).toBe(1)
    expect(closeCalls).toBe(1)
  })

  it('caches factory-internal synchronous shutdown, then closes the returned owner once without reviving observation', async () => {
    const module = await loadCompositionModule()
    if (typeof module.createPersonalFeedTelegramProductionComposition !== 'function') throw new Error('composition constructor is missing')
    const directory = mkdtempSync(join(tmpdir(), 'personal-feed-telegram-composition-factory-shutdown-'))
    temporaryDirectories.push(directory)
    const runtimeConfig = Object.freeze({ dataDir: directory })
    const counters = { observe: 0, shutdown: 0, receivers: [] as object[] }
    let composition!: Composition
    let nestedShutdown!: Promise<void>
    let factoryCalls = 0
    const startupFactory = (_config: unknown): Owner => {
      factoryCalls += 1
      nestedShutdown = composition.shutdown()
      void nestedShutdown.then(() => undefined, () => undefined)
      return makeOwner('complete', counters)
    }
    composition = module.createPersonalFeedTelegramProductionComposition(makeOptions(directory, runtimeConfig, startupFactory))
    const result = await composition.handler(makeEnvelope(81))
    expect(result).toMatchObject({ kind: 'handled-awaiting-delivery', finalText: SOURCE_WINDOW_TEXT })
    settleResult(result, 81)
    expect(factoryCalls).toBe(1)
    expect(counters.observe).toBe(0)
    expect(nestedShutdown).toBeDefined()
    const laterShutdown = composition.shutdown()
    void laterShutdown.then(() => undefined, () => undefined)
    expect(laterShutdown).toBe(nestedShutdown)
    await settleWithin(nestedShutdown)
    expect(counters.shutdown).toBe(1)
    const afterShutdown = await composition.handler(makeEnvelope(82))
    expect(afterShutdown).toMatchObject({ kind: 'failed' })
    expect(factoryCalls).toBe(1)
    expect(counters.observe).toBe(0)
  })

  it.each([
    ['owner returns undefined', 'undefined'] as const,
    ['owner returns its reentrant shutdown promise', 'promise'] as const,
  ])('caches synchronous owner.shutdown reentry when %s', async (_label, mode) => {
    const module = await loadCompositionModule()
    if (typeof module.createPersonalFeedTelegramProductionComposition !== 'function') throw new Error('composition constructor is missing')
    const directory = mkdtempSync(join(tmpdir(), 'personal-feed-telegram-composition-owner-reentry-'))
    temporaryDirectories.push(directory)
    const runtimeConfig = Object.freeze({ dataDir: directory })
    const counters = { observe: 0, shutdown: 0, receivers: [] as object[] }
    let composition!: Composition
    let reentrantShutdown!: Promise<void>
    let factoryCalls = 0
    let r2CloseCalls = 0
    const startupFactory = (_config: unknown): Owner => {
      factoryCalls += 1
      const observe = function (this: object, input: PersonalFeedV2R2Input): unknown {
        counters.observe += 1
        counters.receivers.push(this)
        return Object.freeze({
          kind: 'complete',
          window: makeNaturalZeroWindow(input.request),
          close: () => { r2CloseCalls += 1 },
        })
      }
      const shutdown = (): unknown => {
        counters.shutdown += 1
        reentrantShutdown = composition.shutdown()
        void reentrantShutdown.then(() => undefined, () => undefined)
        return mode === 'promise' ? reentrantShutdown : undefined
      }
      return Object.freeze({ observe, shutdown })
    }
    composition = module.createPersonalFeedTelegramProductionComposition(makeOptions(directory, runtimeConfig, startupFactory))
    const prepared = await composition.handler(makeEnvelope(mode === 'promise' ? 91 : 90))
    expect(prepared).toMatchObject({ kind: 'handled-awaiting-delivery', finalText: JUDGEMENT_EXECUTION_TEXT })
    settleResult(prepared, mode === 'promise' ? 91 : 90)
    expect(factoryCalls).toBe(1)
    const externalShutdown = composition.shutdown()
    void externalShutdown.then(() => undefined, () => undefined)
    expect(reentrantShutdown).toBe(externalShutdown)
    const repeatedShutdown = composition.shutdown()
    void repeatedShutdown.then(() => undefined, () => undefined)
    expect(repeatedShutdown).toBe(externalShutdown)
    if (mode === 'undefined') {
      await settleWithin(externalShutdown)
    } else {
      let failure: unknown
      try {
        await settleWithin(externalShutdown)
      } catch (error) {
        failure = error
      }
      expect(failure).toBeDefined()
      expect(errorMessages(failure).every(message => message === 'personal Feed Telegram cleanup failed')).toBe(true)
    }
    expect(counters.shutdown).toBe(1)
    expect(factoryCalls).toBe(1)
    expect(r2CloseCalls).toBe(1)
    expect(observed.coordinatorOptions).toHaveLength(1)
  })

  it.each([
    ['sync throw', 'throw'] as const,
    ['reject', 'reject'] as const,
  ])('caches and sanitizes owner shutdown %s failure', async (_label, mode) => {
    const module = await loadCompositionModule()
    if (typeof module.createPersonalFeedTelegramProductionComposition !== 'function') throw new Error('composition constructor is missing')
    const directory = mkdtempSync(join(tmpdir(), 'personal-feed-telegram-composition-shutdown-failure-'))
    temporaryDirectories.push(directory)
    const runtimeConfig = Object.freeze({ dataDir: directory })
    const counters = { observe: 0, shutdown: 0, receivers: [] as object[] }
    const startupFactory = (_config: unknown): Owner => {
      const owner = makeOwner('complete', counters)
      const shutdown = (): unknown => {
        counters.shutdown += 1
        if (mode === 'throw') throw new Error('CANARY_OWNER_SHUTDOWN_THROW')
        return Promise.reject(new Error('CANARY_OWNER_SHUTDOWN_REJECT'))
      }
      return Object.freeze({ observe: owner.observe, shutdown })
    }
    const composition = module.createPersonalFeedTelegramProductionComposition(makeOptions(directory, runtimeConfig, startupFactory))
    const result = await composition.handler(makeEnvelope(mode === 'throw' ? 71 : 72))
    expect(result).toMatchObject({ kind: 'handled-awaiting-delivery', finalText: JUDGEMENT_EXECUTION_TEXT })
    settleResult(result, mode === 'throw' ? 71 : 72)
    const firstShutdown = composition.shutdown()
    const secondShutdown = composition.shutdown()
    expect(secondShutdown).toBe(firstShutdown)
    let failure: unknown
    try {
      await firstShutdown
    } catch (error) {
      failure = error
    }
    expect(failure).toBeDefined()
    expect(errorMessages(failure)).toContain('personal Feed Telegram cleanup failed')
    expect(errorMessages(failure).every(message => !message.includes('CANARY_OWNER_SHUTDOWN'))).toBe(true)
    expect(counters.shutdown).toBe(1)
  })

  it.each([
    ['direct request-ledger path', 'requests.jsonl'] as const,
    ['normalized equivalent path', 'nested/../requests.jsonl'] as const,
  ])('rejects completion ledger collision before factory or file creation: %s', async (_label, relativePath) => {
    const module = await loadCompositionModule()
    if (typeof module.createPersonalFeedTelegramProductionComposition !== 'function') throw new Error('composition constructor is missing')
    const directory = mkdtempSync(join(tmpdir(), 'personal-feed-telegram-composition-ledger-collision-'))
    temporaryDirectories.push(directory)
    const runtimeConfig = Object.freeze({ dataDir: directory })
    let factoryCalls = 0
    const startupFactory = (_config: unknown): Owner => {
      factoryCalls += 1
      return makeOwner('complete', { observe: 0, shutdown: 0, receivers: [] })
    }
    const completionLedgerPath = join(directory, relativePath)
    let failure: unknown
    try {
      module.createPersonalFeedTelegramProductionComposition(makeOptions(directory, runtimeConfig, startupFactory, makeR4(), undefined, completionLedgerPath))
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(Error)
    expect(errorMessages(failure).length).toBeGreaterThan(0)
    expect(errorMessages(failure).every(message => !message.includes('CANARY'))).toBe(true)
    expect(errorMessages(failure).every(message => message === errorMessages(failure)[0])).toBe(true)
    expect(factoryCalls).toBe(0)
    expect(existsSync(join(directory, 'requests.jsonl'))).toBe(false)
    expect(existsSync(completionLedgerPath)).toBe(false)
  })
})
