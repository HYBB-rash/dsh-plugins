import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  contextOwnerOptions: [] as unknown[],
  contextOwners: [] as unknown[],
  semanticOptions: [] as unknown[],
  semanticPorts: [] as unknown[],
  judgmentOptions: [] as unknown[],
  judgmentPorts: [] as unknown[],
  runtimeOptions: [] as unknown[],
  runtimeR4: Object.freeze({ snapshot: vi.fn() }) as unknown,
  sourceHandlers: [] as unknown[],
  productionOptions: [] as unknown[],
  productionShutdowns: 0,
  listenerStops: [] as string[],
  observerOptions: [] as unknown[],
  observers: [] as unknown[],
}))

const roots: string[] = []

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  state.contextOwnerOptions.length = 0
  state.contextOwners.length = 0
  state.semanticOptions.length = 0
  state.semanticPorts.length = 0
  state.judgmentOptions.length = 0
  state.judgmentPorts.length = 0
  state.runtimeOptions.length = 0
  state.sourceHandlers.length = 0
  state.productionOptions.length = 0
  state.productionShutdowns = 0
  state.listenerStops.length = 0
  state.observerOptions.length = 0
  state.observers.length = 0
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

vi.mock('@herman/personal-feed', () => ({
  createPersonalContextOwner: vi.fn((options: unknown) => {
    state.contextOwnerOptions.push(options)
    const owner = Object.freeze({ observe: vi.fn(), snapshot: vi.fn() })
    state.contextOwners.push(owner)
    return owner
  }),
}))

vi.mock('../src/personal-feed/personal-context-semantic-llm.ts', () => ({
  createPersonalContextSemanticLlmPort: vi.fn((options: unknown) => {
    state.semanticOptions.push(options)
    const semantic = Object.freeze({ revise: vi.fn() })
    state.semanticPorts.push(semantic)
    return semantic
  }),
}))

vi.mock('../src/personal-feed/personal-feed-judgment-llm.ts', () => ({
  createPersonalFeedJudgmentLlmPort: vi.fn((options: unknown) => {
    state.judgmentOptions.push(options)
    const judgment = Object.freeze({ judgeOne: vi.fn() })
    state.judgmentPorts.push(judgment)
    return judgment
  }),
}))

vi.mock('../src/personal-feed/personal-context-telegram-runtime.ts', () => ({
  createPersonalContextTelegramRuntime: vi.fn((options: unknown) => {
    state.runtimeOptions.push(options)
    return Object.freeze({
      r4: state.runtimeR4,
      registerSourceFirst: (ctx: { on(name: string, listener: unknown): () => void }) => {
        const listener = vi.fn()
        state.sourceHandlers.push(listener)
        return ctx.on('telegram/inbound', listener)
      },
    })
  }),
}))

vi.mock('../src/personal-feed/telegram-production-composition.ts', () => ({
  createPersonalFeedTelegramProductionComposition: vi.fn((options: unknown) => {
    state.productionOptions.push(options)
    return Object.freeze({
      handler: vi.fn(async () => ({ kind: 'handled', finalText: 'feed' })),
      shutdown: vi.fn(async () => { state.productionShutdowns += 1 }),
    })
  }),
}))

vi.mock('../src/personal-feed/x-surface-observer.ts', () => ({
  createPersonalFeedXSurfaceObserver: vi.fn((options: unknown) => {
    state.observerOptions.push(options)
    const observer = Object.freeze({ observe: vi.fn() })
    state.observers.push(observer)
    return observer
  }),
}))

vi.mock('../src/config.ts', () => ({
  resolvePipelinePath: vi.fn(() => '/opt/dsh/runtime/x-feed/python/x_insight_pipeline.py'),
  parseXFeedRuntimeConfig: vi.fn((raw: Record<string, unknown>) => Object.freeze({
    dataDir: raw.dataDir,
    personalFeedDataDir: raw.personalFeedDataDir,
    telegramSessionId: 'telegram-session',
    feedbackPendingTtlMs: 60_000,
    feedbackTurnTimeoutMs: 30_000,
  })),
}))

vi.mock('../src/x-feedback/telegram-adapter.ts', () => ({
  registerTelegramFeedbackAdapter: vi.fn((ctx: { on(name: string, listener: unknown): () => void }) => {
    const stopReady = ctx.on('telegram/inbound/ready', vi.fn())
    const stopInbound = ctx.on('telegram/inbound', vi.fn())
    return () => { stopReady(); stopInbound() }
  }),
}))

vi.mock('../src/store.ts', () => ({ XFeedbackStore: class { readonly append = vi.fn() } }))
vi.mock('../src/tools.ts', () => ({ registerXFeedTools: vi.fn(() => vi.fn()) }))
vi.mock('../src/x-feedback/clean-agent.ts', () => ({ runCleanFeedback: vi.fn() }))
vi.mock('../src/x-feedback/feedback-effect-adapter.ts', () => ({ FeedbackEffectAdapter: class { } }))
vi.mock('../src/x-feedback/pending-store.ts', () => ({ InMemoryPendingStore: class { } }))
vi.mock('../src/x-feedback/use-case.ts', () => ({ FeedbackUseCase: class { } }))
vi.mock('../src/x-feedback/trusted-fact-repository.ts', () => ({
  FileTrustedFactRepository: class {
    readonly append = vi.fn()
    readonly readAll = vi.fn(() => [])
  },
}))
vi.mock('../src/navigation/file-navigation-snapshot-store.ts', () => ({
  FileNavigationSnapshotStore: class { },
  TRUSTED_FACT_NAVIGATION_FILE_NAME: 'trusted-fact-navigation.json',
}))
vi.mock('../src/fact-projection/file-projection-sources.ts', () => ({ pinNavigationSnapshot: (value: unknown) => value }))
vi.mock('../src/trusted-facts/index.ts', () => ({
  RebuildTrustedFactNavigation: class { execute(): unknown { return {} } },
  TrustedFactNavigationProjector: class { },
}))

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'x-feed-context-install-'))
  roots.push(root)
  const dataDir = join(root, 'x-feed')
  const personalFeedDataDir = join(root, 'personal-feed')
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(personalFeedDataDir, { recursive: true })
  writeFileSync(join(dataDir, 'trusted-fact-navigation.json'), '{}\n')
  const listeners: string[] = []
  const currentSelection = vi.fn(() => ({ provider: 'provider', model: 'model' }))
  const ctx = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    llm: { stream: vi.fn() },
    get: vi.fn((name: string) => name === 'agentDefaultModel'
      ? { currentSelection }
      : undefined),
    on: vi.fn((name: string) => {
      listeners.push(name)
      return () => { state.listenerStops.push(name) }
    }),
    agents: { roots: () => [] },
  }
  return { root, dataDir, personalFeedDataDir, listeners, currentSelection, ctx }
}

describe('Personal Feed Telegram install composition', () => {
  it('uses one facts owner and registers source, feedback, then the one Feed handler without history or bootstrap', async () => {
    vi.stubEnv('DSH_PYTHON_BIN', '/nix/store/test-python/bin/python3')
    const value = fixture()
    const clock = Object.freeze({ now: () => new Date('2026-09-01T00:00:00.000Z') })
    const { installTelegramExtensionWithClock } = await import('../src/telegram-extension.ts')
    const dispose = await installTelegramExtensionWithClock(
      value.ctx as never,
      { dataDir: value.dataDir, personalFeedDataDir: value.personalFeedDataDir },
      clock,
    )

    expect(state.observerOptions).toStrictEqual([{
      pythonBin: '/nix/store/test-python/bin/python3',
      observerCliPath: '/opt/dsh/runtime/x-feed/python/x_personal_feed_observer_cli.py',
      clock,
    }])
    expect(state.semanticOptions).toHaveLength(1)
    expect(state.semanticOptions[0]).toMatchObject({ ctx: value.ctx, provider: 'provider', model: 'model' })
    expect(value.currentSelection).toHaveBeenCalledOnce()
    expect(state.judgmentOptions).toHaveLength(1)
    expect(state.judgmentOptions[0]).toStrictEqual({ ctx: value.ctx, provider: 'provider', model: 'model' })
    expect(state.judgmentPorts).toHaveLength(1)
    expect(state.contextOwnerOptions).toStrictEqual([{
      logPath: join(value.personalFeedDataDir, 'v2', 'personal-facts.jsonl'),
      clock,
      semantic: state.semanticPorts[0],
    }])
    expect(state.runtimeOptions).toHaveLength(1)
    expect(state.runtimeOptions[0]).toMatchObject({ owner: state.contextOwners[0] })
    const installSignal = (state.runtimeOptions[0] as { installSignal?: unknown }).installSignal
    expect(installSignal).toBeInstanceOf(AbortSignal)
    expect((installSignal as AbortSignal).aborted).toBe(false)
    expect(state.productionOptions).toHaveLength(1)
    expect(state.productionOptions[0]).toStrictEqual({
      r4: state.runtimeR4,
      r2: state.observers[0],
      r5: state.judgmentPorts[0],
      candidateStatePath: join(value.personalFeedDataDir, 'v2', 'candidate-state.jsonl'),
      clock,
    })
    expect(state.sourceHandlers).toHaveLength(1)
    expect(value.listeners.filter(name => name === 'telegram/inbound')).toHaveLength(3)
    expect(value.ctx.get).not.toHaveBeenCalledWith('sessionQuery')

    await dispose()
    expect(state.judgmentOptions).toHaveLength(1)
    expect(state.judgmentPorts).toHaveLength(1)
  })

  it('aborts the one install signal, removes listeners, and reuses one production shutdown promise on disposal', async () => {
    const value = fixture()
    const clock = Object.freeze({ now: () => new Date('2026-09-01T00:00:00.000Z') })
    const { installTelegramExtensionWithClock } = await import('../src/telegram-extension.ts')
    const dispose = await installTelegramExtensionWithClock(
      value.ctx as never,
      { dataDir: value.dataDir, personalFeedDataDir: value.personalFeedDataDir },
      clock,
    )
    const installSignal = (state.runtimeOptions[0] as { installSignal: AbortSignal }).installSignal

    const first = dispose()
    const second = dispose()
    expect(second).toBe(first)
    expect(installSignal.aborted).toBe(true)
    await first
    expect(state.productionShutdowns).toBe(1)
    expect(state.listenerStops.filter(name => name === 'telegram/inbound')).toHaveLength(3)
    expect(state.listenerStops.filter(name => name === 'telegram/inbound/ready')).toHaveLength(1)
    expect(state.listenerStops.filter(name => name === 'agent/created')).toHaveLength(1)
  })
})
