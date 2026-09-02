import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  events: [] as string[],
  sourceHandler: undefined as unknown,
  sourceWaterfall: undefined as ((envelope: unknown, next: () => unknown) => Promise<unknown>) | undefined,
  lifetimeHandler: undefined as unknown,
  lifetimeFactories: 0,
  compositionHandler: undefined as unknown,
  compositionShutdown: undefined as unknown,
  compositionFactories: 0,
  compositionOptions: undefined as unknown,
  parsedRuntimeConfig: undefined as unknown,
  startupFactoryCalls: 0,
  startupFactoryRuntimeConfigs: [] as unknown[],
  boundStartupFactory: undefined as unknown,
  startupOwner: undefined as unknown,
  startupOwnerObserveCalls: 0,
  startupOwnerShutdownCalls: 0,
  coordinator: undefined as { readonly prepare: (input: unknown) => Promise<unknown>; readonly read: () => unknown } | undefined,
  coordinatorOptions: undefined as unknown,
  personalContextR4: undefined as unknown,
  personalContextBootstrapCalls: 0,
  prepareCalls: [] as unknown[],
  coordinatorDrains: 0,
  sourceCapture: undefined as { readonly promise: Promise<void>; readonly resolve: () => void } | undefined,
  sourceDone: undefined as { readonly promise: Promise<void>; readonly resolve: () => void } | undefined,
  throwOn: new Set<string>(),
}))

const LIFETIME_MODULE_URL = new URL('../src/personal-feed/telegram-feed-lifetime.ts', import.meta.url).href
const EXTENSION_MODULE_URL = new URL('../src/telegram-extension.ts', import.meta.url).href
const EXTENSION_SOURCE_URL = new URL('../src/telegram-extension.ts', import.meta.url)
const CLEANUP_SEAL_AND_DRAIN = Symbol.for('@herman/personal-feed/v2/request-coordinator-cleanup-seal-and-drain')
const temporaryDirectories: string[] = []

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(resolveValue => { resolve = resolveValue })
  return { promise, resolve }
}

function resetState(): void {
  state.events.length = 0
  state.sourceHandler = undefined
  state.sourceWaterfall = undefined
  state.lifetimeHandler = undefined
  state.coordinator = undefined
  state.coordinatorOptions = undefined
  state.personalContextR4 = undefined
  state.personalContextBootstrapCalls = 0
  state.compositionHandler = undefined
  state.compositionShutdown = undefined
  state.compositionFactories = 0
  state.compositionOptions = undefined
  state.parsedRuntimeConfig = undefined
  state.startupOwner = undefined
  state.boundStartupFactory = undefined
  state.startupFactoryRuntimeConfigs.length = 0
  state.startupFactoryCalls = 0
  state.startupOwnerObserveCalls = 0
  state.startupOwnerShutdownCalls = 0
  state.prepareCalls.length = 0
  state.coordinatorDrains = 0
  state.lifetimeFactories = 0
  state.sourceCapture = deferred()
  state.sourceDone = deferred()
  state.throwOn.clear()
  vi.clearAllMocks()
}

function errorIfConfigured(label: string): void {
  if (state.throwOn.has(label)) throw new Error(`TEARDOWN_${label}_CANARY`)
}

function errorMessages(error: unknown): string[] {
  if (error instanceof AggregateError) return error.errors.flatMap(errorMessages)
  return [error instanceof Error ? error.message : String(error)]
}

function prepared(requestId: string, settle = (): void => undefined): unknown {
  return Object.freeze({
    kind: 'prepared' as const,
    request: Object.freeze({ requestId, cutoff: '2026-09-03T00:00:00.000Z', shanghaiDay: '2026-09-03' }),
    outcome: Object.freeze({ kind: 'incomplete' as const, category: 'personal_context' as const, finalText: 'incomplete', digest: '0'.repeat(64) }),
    settle,
  })
}

vi.mock('@herman/personal-feed', () => ({
  createPersonalFeedV2CandidateLifecycle: vi.fn(() => ({ admit: vi.fn(async () => Object.freeze({ kind: 'incomplete', reason: 'unknown' })) })),
  createPersonalFeedV2RequestCoordinator: vi.fn((options: unknown) => {
    state.coordinatorOptions = options
    const prepare = vi.fn(async (input: unknown) => {
      state.prepareCalls.push(input)
      const result = prepared('telegram:7:11', () => state.events.push('receipt.delivered')) as {
        readonly request: unknown
        readonly settle: () => void
      }
      const r2 = (options as { readonly r2: { readonly observe: (value: unknown) => unknown | Promise<unknown> } }).r2
      await r2.observe({ request: result.request, signal: (input as { readonly signal: AbortSignal }).signal })
      return result
    })
    Object.defineProperty(prepare, CLEANUP_SEAL_AND_DRAIN, {
      value: async (coordinator: object) => {
        expect(coordinator).toBe(state.coordinator)
        state.coordinatorDrains += 1
        state.events.push('coordinator.drain')
        errorIfConfigured('coordinator.drain')
      }, enumerable: false, writable: false, configurable: false,
    })
    state.coordinator = Object.freeze({ prepare, read: () => undefined })
    state.events.push('coordinator.create')
    return state.coordinator
  }),
  createPersonalContextOwner: vi.fn(() => ({
    bootstrap: async () => {
      state.personalContextBootstrapCalls += 1
      state.events.push('owner.bootstrap')
      return Object.freeze({ status: 'complete' as const })
    },
    freezeFence: () => Object.freeze({}),
    snapshot: async () => Object.freeze({ kind: 'sufficient', snapshot: Object.freeze({}) }),
    capture: () => Object.freeze({ source: Object.freeze({ captureSequence: 1, sourceKey: 'source:1' }), coverage: Object.freeze({ status: 'complete', sourceKey: 'source:1' }) }),
    read: () => Object.freeze({ sources: [], coverage: [] }),
    settle: async () => Object.freeze({ status: 'complete', sourceKey: 'source:1' }),
    close: () => { state.events.push('owner.close'); errorIfConfigured('owner.close') },
  })),
  createSessionUserHistoryAdapter: vi.fn(() => Object.freeze({})),
}))

vi.mock('../src/personal-feed/telegram-feed-lifetime.ts', async importOriginal => {
  const actual = await importOriginal() as {
    readonly createPersonalFeedTelegramInstallLifetime: (options: unknown) => {
      readonly handler: (envelope: unknown) => Promise<unknown>
      readonly shutdown: () => Promise<void>
    }
  }
  return {
    ...actual,
    createPersonalFeedTelegramInstallLifetime: vi.fn((options: unknown) => {
      state.lifetimeFactories += 1
      const lifetime = actual.createPersonalFeedTelegramInstallLifetime(options)
      const handler = vi.fn((envelope: unknown) => lifetime.handler(envelope))
      state.lifetimeHandler = handler
      const shutdown = vi.fn(async () => {
        state.events.push('lifetime.shutdown.call')
        return await lifetime.shutdown()
      })
      return Object.freeze({ handler, shutdown })
    }),
  }
})

vi.mock('../src/personal-feed/telegram-production-composition.ts', async importOriginal => {
  const actual = await importOriginal() as {
    readonly createPersonalFeedTelegramProductionComposition: (options: unknown) => {
      readonly handler: (envelope: unknown) => Promise<unknown>
      readonly shutdown: () => Promise<void>
    }
  }
  return {
    ...actual,
    createPersonalFeedTelegramProductionComposition: vi.fn((options: unknown) => {
      state.compositionFactories += 1
      state.events.push('composition.constructor')
      state.compositionOptions = options
      if (state.throwOn.has('composition.constructor')) throw new Error('COMPOSITION_CONSTRUCTOR_CANARY')
      const composition = actual.createPersonalFeedTelegramProductionComposition(options)
      const handler = vi.fn((envelope: unknown) => composition.handler(envelope))
      state.compositionHandler = handler
      const shutdown = vi.fn(async () => {
        state.events.push('composition.shutdown.call')
        return await composition.shutdown()
      })
      state.compositionShutdown = shutdown
      return Object.freeze({ handler, shutdown })
    }),
  }
})

vi.mock('../src/config.ts', () => ({
  parseXFeedRuntimeConfig: vi.fn((raw: Readonly<Record<string, unknown>>) => {
    const config = Object.freeze({
      dataDir: raw.dataDir as string,
      personalFeedDataDir: raw.personalFeedDataDir as string,
      telegramSessionId: 'session-telegram',
      feedbackPendingTtlMs: 600_000,
      feedbackTurnTimeoutMs: 30_000,
    })
    state.parsedRuntimeConfig = config
    return config
  }),
}))

vi.mock('../src/personal-feed/personal-context-semantic-llm.ts', () => ({
  createPersonalContextSemanticLlmPorts: vi.fn(() => ({ classifier: {}, entailmentValidator: {}, noFactValidator: {} })),
}))

vi.mock('../src/personal-feed/personal-context-telegram-runtime.ts', () => ({
  createPersonalContextTelegramRuntime: vi.fn(() => {
    const r4 = { snapshot: async () => Object.freeze({ kind: 'insufficient' }) }
    state.personalContextR4 = r4
    return {
      r4,
      registerSourceFirst: (ctx: { readonly on: (name: string, listener: (...args: unknown[]) => unknown) => () => void }, registration: { readonly personalFeedHandler: unknown }) => {
        state.sourceHandler = registration.personalFeedHandler
        state.events.push('source.register')
        let active = true
        const listener = async (envelope: unknown, next: () => unknown): Promise<unknown> => {
          if (!active) return await next()
          const text = typeof envelope === 'object' && envelope !== null && 'currentText' in envelope
            ? (envelope as { readonly currentText?: unknown }).currentText
            : undefined
          if (typeof text !== 'string' || !text.includes('Feed')) return await next()
          try {
            state.events.push('source.capture')
            await state.sourceCapture?.promise
            return await (state.sourceHandler as (envelope: unknown) => Promise<unknown>)(envelope)
          } finally {
            state.sourceDone?.resolve()
          }
        }
        state.sourceWaterfall = listener
        const stop = ctx.on('telegram/inbound', listener)
        return () => {
          active = false
          state.events.push('source.stop')
          stop()
          errorIfConfigured('source.stop')
        }
      },
      shutdown: async () => {
        state.events.push('runtime.shutdown')
        await state.sourceDone?.promise
        errorIfConfigured('runtime.shutdown')
      },
    }
  }),
}))

vi.mock('../src/x-feedback/telegram-adapter.ts', () => ({
  registerTelegramFeedbackAdapter: vi.fn((ctx: { readonly on: (name: string, listener: (...args: unknown[]) => unknown) => () => void }) => {
    const listener = async (_envelope: unknown, next: () => unknown) => await next()
    const stopReady = ctx.on('telegram/inbound/ready', listener)
    const stopInbound = ctx.on('telegram/inbound', listener)
    return () => {
      state.events.push('feedback.stop')
      stopReady()
      stopInbound()
      errorIfConfigured('feedback.stop')
    }
  }),
}))

vi.mock('../src/x-feedback/clean-agent.ts', () => ({ runCleanFeedback: vi.fn() }))
vi.mock('../src/x-feedback/feedback-effect-adapter.ts', () => ({ FeedbackEffectAdapter: class { readonly append = (): void => undefined } }))
vi.mock('../src/x-feedback/pending-store.ts', () => ({ InMemoryPendingStore: class { } }))
vi.mock('../src/x-feedback/use-case.ts', () => ({ FeedbackUseCase: class { } }))
vi.mock('../src/x-feedback/trusted-fact-repository.ts', () => ({ FileTrustedFactRepository: class { append(): void { } readAll(): readonly unknown[] { return [] } } }))
vi.mock('../src/tools.ts', () => ({ registerXFeedTools: vi.fn(() => () => { state.events.push('root.cleanup'); errorIfConfigured('root.cleanup') }) }))
vi.mock('../src/navigation/file-navigation-snapshot-store.ts', () => ({
  FileNavigationSnapshotStore: class { },
  TRUSTED_FACT_NAVIGATION_FILE_NAME: 'trusted-fact-navigation.json',
}))
vi.mock('../src/fact-projection/file-projection-sources.ts', () => ({ pinNavigationSnapshot: vi.fn((value: unknown) => value) }))
vi.mock('../src/trusted-facts/index.ts', () => ({
  RebuildTrustedFactNavigation: class { execute(): unknown { return Object.freeze({}) } },
  TrustedFactNavigationProjector: class { },
}))
vi.mock('../src/personal-feed/x-startup.ts', () => ({
  bindPersonalFeedXStartupFromPackageEntry: vi.fn(() => {
    const factory = (runtimeConfig: unknown) => {
      state.startupFactoryCalls += 1
      state.startupFactoryRuntimeConfigs.push(runtimeConfig)
      const owner = Object.freeze({
        observe: async () => {
          state.startupOwnerObserveCalls += 1
          return Object.freeze({ kind: 'unknown' })
        },
        shutdown: async () => {
          state.startupOwnerShutdownCalls += 1
          state.events.push('startup.owner.shutdown')
        },
      })
      state.startupOwner = owner
      return owner
    }
    state.boundStartupFactory = factory
    return Object.freeze(factory)
  }),
}))

async function loadExtension(): Promise<Readonly<Record<string, unknown>>> {
  try {
    return await import(/* @vite-ignore */ EXTENSION_MODULE_URL) as Readonly<Record<string, unknown>>
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`CAPABILITY_ASSERTION: extension/lifetime import unavailable: ${detail}`, { cause: error })
  }
}

async function requireLifetimeCapability(): Promise<void> {
  try {
    const module = await import(/* @vite-ignore */ LIFETIME_MODULE_URL) as Readonly<Record<string, unknown>>
    if (typeof module.createPersonalFeedTelegramInstallLifetime !== 'function') throw new Error('factory export is missing')
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`CAPABILITY_ASSERTION: extension lifetime capability unavailable: ${detail}`, { cause: error })
  }
}

function makeContext(roots: readonly unknown[] = []) {
  const listeners = new Map<string, Array<(...args: unknown[]) => unknown>>()
  const ctx = {
    logger: { info: (): void => undefined, warn: (): void => undefined, error: (): void => undefined },
    get: (name: string) => name === 'sessionQuery'
      ? { listEvents: async () => [], readEvent: async () => undefined }
      : name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'test', model: 'test' }) } : undefined,
    on: (name: string, listener: (...args: unknown[]) => unknown) => {
      state.events.push(`on:${name}`)
      const entries = listeners.get(name) ?? []
      entries.push(listener)
      listeners.set(name, entries)
      return () => {
        const current = listeners.get(name) ?? []
        const index = current.indexOf(listener)
        if (index >= 0) current.splice(index, 1)
        state.events.push(`off:${name}`)
        errorIfConfigured(`listener.${name}`)
      }
    },
    agents: { roots: () => roots },
  }
  return { ctx, listeners }
}

function makeAgent(label: string) {
  return {
    session: { id: 'session-telegram' },
    ctx: {
      effect: (effect: () => () => void) => {
        const cleanup = effect()
        return () => {
          state.events.push(`root.stop:${label}`)
          const errors: unknown[] = []
          try { errorIfConfigured(`root.${label}`) } catch (error: unknown) { errors.push(error) }
          try { cleanup() } catch (error: unknown) { errors.push(error) }
          if (errors.length === 1) throw errors[0]
          if (errors.length > 1) throw new AggregateError(errors)
        }
      },
      systemPrompt: { section: () => () => { state.events.push(`section.stop:${label}`); errorIfConfigured(`section.${label}`) } },
    },
  }
}

function feedEnvelope(messageId = 11): Readonly<Record<string, unknown>> {
  return Object.freeze({ chat: Object.freeze({ id: 7, type: 'private' }), message: Object.freeze({ id: messageId }), currentText: '给我一次个人 Feed', signal: new AbortController().signal })
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('Personal Feed Telegram install lifetime extension integration', () => {
  it('shares one real lifetime handler across both entries and orders drain, source continuation, teardown, and errors', async () => {
    resetState()
    const directory = mkdtempSync(join(tmpdir(), 'personal-feed-lifetime-extension-'))
    temporaryDirectories.push(directory)
    writeFileSync(join(directory, 'trusted-fact-navigation.json'), '{}')
    const roots = [makeAgent('first'), makeAgent('second')]
    const { ctx, listeners } = makeContext(roots)
    await requireLifetimeCapability()
    const module = await loadExtension()
    const extensionSource = readFileSync(EXTENSION_SOURCE_URL, 'utf8')
    expect(extensionSource.match(/createPersonalFeedTelegramProductionComposition\s*\(/gu)).toHaveLength(1)
    expect(extensionSource).toContain("from './personal-feed/telegram-production-composition.ts'")
    expect(extensionSource).not.toContain('createPersonalFeedV2CandidateLifecycle')
    expect(extensionSource).not.toContain('createPersonalFeedTelegramInstallLifetime')
    expect(extensionSource).not.toContain('void personalFeedXStartupFactory')
    expect(extensionSource).not.toMatch(/r2\s*:\s*\{\s*observe\s*:\s*async\s*\(\)\s*=>/u)
    expect(extensionSource).not.toContain('export { createPersonalFeedTelegramProductionComposition')
    expect(extensionSource).not.toContain('dsh-cron/run-finished')
    expect(extensionSource).not.toMatch(/session-(?:web|cron)/u)
    expect(typeof module.installTelegramExtensionFromPackageEntry).toBe('function')
    if (typeof module.installTelegramExtensionFromPackageEntry !== 'function') return
    const install = module.installTelegramExtensionFromPackageEntry as (ctx: unknown, config: unknown, entry: string, clock: unknown) => Promise<() => Promise<void>>
    const installClock = { now: () => new Date('2026-09-03T00:00:00.000Z') }
    const dispose = await install(ctx, { dataDir: directory, personalFeedDataDir: join(directory, 'personal-feed') }, new URL('../src/index.ts', import.meta.url).href, installClock)
    expect(state.compositionFactories).toBe(1)
    expect(state.compositionOptions).toBeDefined()
    const compositionOptions = state.compositionOptions as {
      readonly runtimeConfig: unknown
      readonly startupFactory: ((runtimeConfig: unknown) => unknown) & { readonly length: number }
      readonly r4: unknown
      readonly completionLedgerPath: string
      readonly clock: unknown
    }
    expect(Reflect.ownKeys(compositionOptions)).toEqual([
      'runtimeConfig', 'startupFactory', 'r4', 'completionLedgerPath', 'clock',
    ])
    expect(Object.isFrozen(compositionOptions)).toBe(true)
    expect(compositionOptions.runtimeConfig).toBe(state.parsedRuntimeConfig)
    expect(compositionOptions.startupFactory).toBeDefined()
    expect(compositionOptions.startupFactory.length).toBe(1)
    expect(Object.isFrozen(compositionOptions.startupFactory)).toBe(true)
    expect(compositionOptions.startupFactory).toBe(state.boundStartupFactory)
    expect(compositionOptions.r4).toBe(state.personalContextR4)
    expect(compositionOptions.clock).toBe(installClock)
    expect(compositionOptions.completionLedgerPath).toBe(join(directory, 'personal-feed', 'v2', 'candidate-judgments.jsonl'))
    expect(state.coordinatorOptions).toBeDefined()
    expect(state.sourceHandler).toBeDefined()
    expect(state.compositionHandler).toBe(state.sourceHandler)
    expect(state.lifetimeFactories).toBe(1)
    expect(state.prepareCalls).toHaveLength(0)
    expect(state.events.filter(value => value === 'coordinator.create')).toHaveLength(1)

    const next = vi.fn(() => Object.freeze({ kind: 'root' }))
    const normalListener = listeners.get('telegram/inbound')?.at(-1)
    expect(normalListener).toBeDefined()
    const normalResult = await normalListener?.(feedEnvelope(11), next)
    expect(normalResult).toMatchObject({ kind: 'handled-awaiting-delivery' })
    expect(state.prepareCalls).toHaveLength(1)
    expect((state.lifetimeHandler as { readonly mock: { readonly calls: readonly unknown[][] } }).mock.calls).toHaveLength(1)
    expect(state.startupFactoryCalls).toBe(1)
    expect(state.startupOwnerObserveCalls).toBe(1)
    expect(state.startupFactoryRuntimeConfigs[0]).toBe(state.parsedRuntimeConfig)
    const fallback = state.sourceWaterfall?.(feedEnvelope(12), next)
    expect(fallback).toBeDefined()
    state.sourceCapture?.resolve()
    await expect(fallback).resolves.toMatchObject({ kind: 'handled-awaiting-delivery' })
    expect(state.prepareCalls).toHaveLength(2)
    expect((state.lifetimeHandler as { readonly mock: { readonly calls: readonly unknown[][] } }).mock.calls).toHaveLength(2)
    expect(state.startupFactoryCalls).toBe(1)
    expect(state.startupOwnerObserveCalls).toBe(2)
    state.sourceCapture = deferred()
    state.sourceDone = deferred()
    const continuation = state.sourceWaterfall?.(feedEnvelope(13), next)
    expect(continuation).toBeDefined()
    expect(state.events).toContain('source.capture')
    const disposePromise = dispose()
    expect(dispose()).toBe(disposePromise)
    let disposeSettled = false
    void disposePromise.then(() => { disposeSettled = true }, () => { disposeSettled = true })
    await Promise.resolve()
    expect(disposeSettled).toBe(false)
    expect(state.prepareCalls).toHaveLength(2)
    state.sourceCapture?.resolve()
    const staleFeedResult = await continuation
    expect(staleFeedResult).toEqual({ kind: 'failed', visibleError: '这次没有完成：判断或执行未完成。' })
    expect(next).not.toHaveBeenCalled()
    await disposePromise
    expect(state.compositionShutdown).toBeDefined()
    expect((state.compositionShutdown as { readonly mock: { readonly calls: readonly unknown[][] } }).mock.calls).toHaveLength(1)
    expect(state.startupOwnerShutdownCalls).toBe(1)
    expect(state.coordinatorDrains).toBe(1)
    expect(state.events).toEqual(expect.arrayContaining([
      'root.stop:first',
      'root.stop:second',
      'section.stop:first',
      'section.stop:second',
      'feedback.stop',
      'runtime.shutdown',
      'owner.close',
    ]))
    expect(state.events.filter(value => value === 'composition.shutdown.call')).toHaveLength(1)
    expect(state.events.indexOf('lifetime.shutdown.call')).toBeLessThan(state.events.indexOf('source.stop'))
    expect(state.events.indexOf('lifetime.shutdown.call')).toBeLessThan(state.events.indexOf('root.stop:first'))
    expect(state.events.indexOf('lifetime.shutdown.call')).toBeLessThan(state.events.indexOf('feedback.stop'))
    expect(state.events.indexOf('runtime.shutdown')).toBeGreaterThan(state.events.indexOf('source.stop'))
    expect(state.events.indexOf('coordinator.drain')).toBeLessThan(state.events.indexOf('runtime.shutdown'))
    expect(state.events.indexOf('owner.close')).toBeGreaterThan(state.events.indexOf('runtime.shutdown'))
    expect(state.events.indexOf('root.stop:second')).toBeLessThan(state.events.indexOf('root.stop:first'))
    expect(state.events.filter(value => value === 'off:agent/created')).toHaveLength(1)
    expect(state.events.filter(value => value === 'off:telegram/inbound')).toHaveLength(3)
    expect(state.events.filter(value => value === 'off:telegram/inbound/ready')).toHaveLength(1)
    const staleOrdinary = await state.sourceWaterfall?.(Object.freeze({ currentText: '普通消息' }), next)
    expect(staleOrdinary).toEqual({ kind: 'root' })
    expect(state.prepareCalls).toHaveLength(2)

    resetState()
    const secondDirectory = mkdtempSync(join(tmpdir(), 'personal-feed-lifetime-errors-'))
    temporaryDirectories.push(secondDirectory)
    writeFileSync(join(secondDirectory, 'trusted-fact-navigation.json'), '{}')
    state.sourceDone?.resolve()
    for (const label of ['source.stop', 'root.first', 'root.second', 'section.first', 'section.second', 'listener.agent/created', 'coordinator.drain', 'runtime.shutdown', 'owner.close']) state.throwOn.add(label)
    const second = makeContext([makeAgent('first'), makeAgent('second')])
    const secondDispose = await install(second.ctx, { dataDir: secondDirectory, personalFeedDataDir: join(secondDirectory, 'personal-feed') }, new URL('../src/index.ts', import.meta.url).href, { now: () => new Date('2026-09-03T00:00:00.000Z') })
    const rejected = secondDispose()
    expect(secondDispose()).toBe(rejected)
    let rejection: unknown
    try { await rejected } catch (error: unknown) { rejection = error }
    expect(rejection).toBeInstanceOf(AggregateError)
    const messages = errorMessages(rejection)
    expect(messages).toEqual(expect.arrayContaining([
      'TEARDOWN_source.stop_CANARY',
      'TEARDOWN_root.first_CANARY',
      'TEARDOWN_root.second_CANARY',
      'TEARDOWN_section.first_CANARY',
      'TEARDOWN_section.second_CANARY',
      'TEARDOWN_listener.agent/created_CANARY',
      'TEARDOWN_coordinator.drain_CANARY',
      'TEARDOWN_runtime.shutdown_CANARY',
      'TEARDOWN_owner.close_CANARY',
    ]))
    expect(messages.join('\n')).not.toContain('RAW_BODY_MUST_NOT_LEAK')
    expect(state.coordinatorDrains).toBe(1)
    expect(state.events).toEqual(expect.arrayContaining([
      'root.stop:first',
      'root.stop:second',
      'section.stop:first',
      'section.stop:second',
      'off:agent/created',
      'runtime.shutdown',
      'owner.close',
    ]))
    expect(state.events.filter(value => value === 'off:agent/created')).toHaveLength(1)
    expect(state.events.filter(value => value === 'off:telegram/inbound')).toHaveLength(3)
    expect(state.events.filter(value => value === 'off:telegram/inbound/ready')).toHaveLength(1)
  })

  it('rolls back a synchronous composition constructor failure before registering Telegram or roots', async () => {
    resetState()
    state.sourceDone?.resolve()
    state.throwOn.add('composition.constructor')
    const directory = mkdtempSync(join(tmpdir(), 'personal-feed-lifetime-composition-rollback-'))
    temporaryDirectories.push(directory)
    writeFileSync(join(directory, 'trusted-fact-navigation.json'), '{}')
    const { ctx } = makeContext([makeAgent('first')])
    const module = await loadExtension()
    expect(typeof module.installTelegramExtensionFromPackageEntry).toBe('function')
    if (typeof module.installTelegramExtensionFromPackageEntry !== 'function') return
    const install = module.installTelegramExtensionFromPackageEntry as (ctx: unknown, config: unknown, entry: string, clock: unknown) => Promise<() => Promise<void>>
    let rejection: unknown
    try {
      await install(ctx, { dataDir: directory, personalFeedDataDir: join(directory, 'personal-feed') }, new URL('../src/index.ts', import.meta.url).href, { now: () => new Date('2026-09-03T00:00:00.000Z') })
    } catch (error: unknown) {
      rejection = error
    }
    expect(rejection).toBeInstanceOf(Error)
    expect(errorMessages(rejection)).toContain('COMPOSITION_CONSTRUCTOR_CANARY')
    expect(state.personalContextBootstrapCalls).toBe(1)
    expect(state.compositionFactories).toBe(1)
    expect(state.events.indexOf('owner.bootstrap')).toBeLessThan(state.events.indexOf('composition.constructor'))
    expect(state.startupFactoryCalls).toBe(0)
    expect(state.compositionShutdown).toBeUndefined()
    expect(state.events).toContain('runtime.shutdown')
    expect(state.events).toContain('owner.close')
    expect(state.events.indexOf('runtime.shutdown')).toBeLessThan(state.events.indexOf('owner.close'))
    expect(state.events).not.toContain('source.register')
    expect(state.events).not.toContain('on:telegram/inbound')
    expect(state.events).not.toContain('on:telegram/inbound/ready')
    expect(state.events).not.toContain('on:agent/created')
    expect(state.events).not.toContain('root.stop:first')
    expect(state.events).not.toContain('section.stop:first')
  })
})
