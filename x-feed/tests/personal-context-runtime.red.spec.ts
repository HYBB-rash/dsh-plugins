import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { TelegramInboundEnvelope, TelegramInboundResult } from '@deepseek-ai/dsh-telegram-gateway'
import { installTelegramExtension } from '../src/index.ts'

const ownerObserver = vi.hoisted(() => ({
  closeCount: 0,
  events: [] as string[],
  wiringEvents: [] as string[],
  contextOwnerOptions: [] as unknown[],
  contextOwners: [] as unknown[],
  contextSnapshotResults: [] as unknown[],
  candidateFactoryOptions: [] as unknown[],
  candidateOwners: [] as unknown[],
  coordinatorOptions: [] as unknown[],
  coordinatorOwners: [] as unknown[],
  personalContextRuntimeR4: [] as unknown[],
  startupBinderCalls: [] as unknown[][],
  startupBoundFactories: [] as unknown[],
  startupBoundFactoryCalls: [] as unknown[][],
}))

vi.mock('@herman/personal-feed', async importOriginal => {
  const actual = await importOriginal<typeof import('@herman/personal-feed')>()
  return {
    ...actual,
    createPersonalContextOwner: (...args: Parameters<typeof actual.createPersonalContextOwner>) => {
      const owner = actual.createPersonalContextOwner(...args)
      ownerObserver.contextOwnerOptions.push(args[0])
      const wrapped = Object.freeze({
        ...owner,
        capture: (...captureArgs: Parameters<typeof owner.capture>) => owner.capture(...captureArgs),
        read: (...readArgs: Parameters<typeof owner.read>) => owner.read(...readArgs),
        freezeFence: (...fenceArgs: Parameters<typeof owner.freezeFence>) => owner.freezeFence(...fenceArgs),
        snapshot: (...snapshotArgs: Parameters<typeof owner.snapshot>) => {
          const result = owner.snapshot(...snapshotArgs)
          ownerObserver.contextSnapshotResults.push(result)
          return result
        },
        close: (): void => {
          ownerObserver.closeCount += 1
          ownerObserver.events.push('owner.close')
          owner.close()
        },
      })
      ownerObserver.contextOwners.push(wrapped)
      return wrapped
    },
    createPersonalFeedV2CandidateLifecycle: (...args: Parameters<typeof actual.createPersonalFeedV2CandidateLifecycle>) => {
      ownerObserver.candidateFactoryOptions.push(args[0])
      const owner = actual.createPersonalFeedV2CandidateLifecycle(...args)
      ownerObserver.candidateOwners.push(owner)
      ownerObserver.wiringEvents.push('candidate.factory')
      return owner
    },
    createPersonalFeedV2RequestCoordinator: (...args: Parameters<typeof actual.createPersonalFeedV2RequestCoordinator>) => {
      ownerObserver.coordinatorOptions.push(args[0])
      const coordinator = actual.createPersonalFeedV2RequestCoordinator(...args)
      ownerObserver.coordinatorOwners.push(coordinator)
      ownerObserver.wiringEvents.push('coordinator.factory')
      return coordinator
    },
  }
})

vi.mock('../src/personal-feed/x-startup.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/personal-feed/x-startup.ts')>() as typeof import('../src/personal-feed/x-startup.ts') & {
    readonly bindPersonalFeedXStartupFromPackageEntry?: (...args: unknown[]) => unknown
  }
  const bind = actual.bindPersonalFeedXStartupFromPackageEntry
  return {
    ...actual,
    bindPersonalFeedXStartupFromPackageEntry: (...args: unknown[]): unknown => {
      ownerObserver.startupBinderCalls.push(args)
      if (typeof bind !== 'function') throw new Error('CAPABILITY_ASSERTION: startup binder is unavailable')
      const factory = Reflect.apply(bind, undefined, args)
      if (typeof factory !== 'function') throw new Error('CAPABILITY_ASSERTION: startup binder did not return a factory')
      const wrapped = (runtimeConfig: unknown): unknown => {
        ownerObserver.startupBoundFactoryCalls.push([runtimeConfig])
        return Reflect.apply(factory, undefined, [runtimeConfig])
      }
      Object.freeze(wrapped)
      ownerObserver.startupBoundFactories.push(wrapped)
      return wrapped
    },
  }
})

vi.mock('../src/personal-feed/personal-context-telegram-runtime.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/personal-feed/personal-context-telegram-runtime.ts')>()
  return {
    ...actual,
    createPersonalContextTelegramRuntime: (...args: Parameters<typeof actual.createPersonalContextTelegramRuntime>) => {
      const runtime = actual.createPersonalContextTelegramRuntime(...args)
      ownerObserver.personalContextRuntimeR4.push(runtime.r4)
      return runtime
    },
  }
})

vi.mock('../src/x-feedback/pending-store.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/x-feedback/pending-store.ts')>()
  return {
    ...actual,
    InMemoryPendingStore: class extends actual.InMemoryPendingStore {
      override unload(): void {
        ownerObserver.events.push('pending.unload')
        super.unload()
      }
    },
  }
})

type Listener = (value: TelegramInboundEnvelope, next: () => TelegramInboundResult | Promise<TelegramInboundResult>) => TelegramInboundResult | Promise<TelegramInboundResult>

type RuntimeHarness = {
  readonly ctx: Record<string, unknown>
  readonly listeners: Map<string, Listener[]>
  readonly registration: string[]
  readonly disposal: string[]
  readonly inboundRegistration: number[]
  readonly inboundDisposal: number[]
  readonly historyCalls: string[]
  readonly timeline: string[]
  readonly llmRequests: unknown[]
}

function emptyHistoryHarness(options: { readonly historyFailure?: Error; readonly historyIncomplete?: boolean; readonly withoutHistory?: boolean } = {}): RuntimeHarness {
  const listeners = new Map<string, Listener[]>()
  const registration: string[] = []
  const disposal: string[] = []
  const inboundRegistration: number[] = []
  const inboundDisposal: number[] = []
  const historyCalls: string[] = []
  const timeline: string[] = []
  const llmRequests: unknown[] = []
  const sessionQuery = {
    listEvents: vi.fn(async (_sessionId: string) => {
      historyCalls.push('list')
      timeline.push('history:list')
      ownerObserver.wiringEvents.push('history:list')
      if (options.historyFailure !== undefined) throw options.historyFailure
      if (options.historyIncomplete === true) return { corrupt: true }
      return []
    }),
    readEvent: vi.fn(async (_input: unknown) => {
      historyCalls.push('read')
      timeline.push('history:read')
      ownerObserver.wiringEvents.push('history:read')
      return undefined
    }),
  }
  const ctx = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    get: vi.fn((name: string) => {
      if (name === 'sessionQuery' && options.withoutHistory !== true) return sessionQuery
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }) }
      return undefined
    }),
    llm: { stream: async function* (request: unknown) { llmRequests.push(request); return undefined } },
    on: vi.fn((name: string, listener: Listener) => {
      registration.push(name)
      timeline.push(`register:${name}`)
      ownerObserver.events.push(`listener.register:${name}`)
      ownerObserver.wiringEvents.push(`listener.register:${name}`)
      const inboundOrdinal = name === 'telegram/inbound'
        ? inboundRegistration.push(inboundRegistration.length) - 1
        : undefined
      const current = listeners.get(name) ?? []
      current.push(listener)
      listeners.set(name, current)
      return () => {
        disposal.push(name)
        ownerObserver.events.push(`listener.dispose:${name}`)
        if (inboundOrdinal !== undefined) inboundDisposal.push(inboundOrdinal)
        const values = listeners.get(name) ?? []
        listeners.set(name, values.filter(value => value !== listener))
      }
    }),
    agents: { roots: () => [] },
  }
  return { ctx, listeners, registration, disposal, inboundRegistration, inboundDisposal, historyCalls, timeline, llmRequests }
}

type RootFailure = 'tool1' | 'tool2' | 'section'

type RootFixture = {
  readonly agent: Record<string, unknown>
  readonly tools: string[]
  readonly sections: string[]
  readonly timeline: string[]
  readonly disposal: string[]
}

function rootFixture(sessionId: string, failure?: RootFailure, label = 'root'): RootFixture {
  const tools: string[] = []
  const sections: string[] = []
  const timeline: string[] = []
  const disposal: string[] = []
  let registeredTools = 0
  const agent = {
    session: { id: sessionId },
    ctx: {
      tools: {
        register: (definition: { readonly name?: string }) => {
          registeredTools += 1
          if (failure === `tool${registeredTools}`) throw new Error(`${failure} registration failed`)
          const name = definition.name ?? 'unknown'
          tools.push(name)
          timeline.push(`register:${name}`)
          ownerObserver.events.push(`${label}.register:${name}`)
          return () => {
            const index = tools.indexOf(name)
            if (index >= 0) tools.splice(index, 1)
            disposal.push(name)
            timeline.push(`dispose:${name}`)
            ownerObserver.events.push(`${label}.dispose:${name}`)
          }
        },
      },
      systemPrompt: {
        section: (section: { readonly name?: string }) => {
          if (failure === 'section') throw new Error('section registration failed')
          const name = section.name ?? 'unknown'
          sections.push(name)
          timeline.push(`register:${name}`)
          ownerObserver.events.push(`${label}.register:${name}`)
          return () => {
            const index = sections.indexOf(name)
            if (index >= 0) sections.splice(index, 1)
            disposal.push(name)
            timeline.push(`dispose:${name}`)
            ownerObserver.events.push(`${label}.dispose:${name}`)
          }
        },
      },
      effect: (callback: () => unknown) => callback(),
    },
  }
  return { agent, tools, sections, timeline, disposal }
}

function config(dataDir: string, personalFeedDataDir: string): Record<string, unknown> {
  return {
    dataDir,
    personalFeedDataDir,
    telegramSessionId: 'session-telegram',
    feedbackTurnTimeoutMs: 30_000,
  }
}

function expectFrozenInstallClock(value: unknown): asserts value is { readonly now: () => Date } {
  expect(value).not.toBeNull()
  expect(typeof value).toBe('object')
  expect(Object.getPrototypeOf(value as object)).toBe(Object.prototype)
  expect(Object.isFrozen(value)).toBe(true)
  expect(Reflect.ownKeys(value as object)).toEqual(['now'])
  const descriptor = Object.getOwnPropertyDescriptor(value as object, 'now')
  expect(descriptor?.enumerable).toBe(true)
  expect(descriptor?.configurable).toBe(false)
  expect(descriptor?.writable).toBe(false)
  expect(descriptor?.get).toBeUndefined()
  expect(descriptor?.set).toBeUndefined()
  expect(typeof (value as { readonly now?: unknown }).now).toBe('function')
}

function candidateWindow(
  request: Readonly<{ readonly requestId: string; readonly cutoff: string; readonly shanghaiDay: string }>,
  completedAt: string,
): Record<string, unknown> {
  return {
    requestId: request.requestId,
    cutoff: request.cutoff,
    shanghaiDay: request.shanghaiDay,
    startedAt: request.cutoff,
    completedAt,
    surfaces: [
      { kind: 'natural_zero', surface: 'for_you', surfaceOrdinal: 0, startedAt: request.cutoff, completedAt: '2026-09-01T15:59:59.850Z', occurrences: [] },
      { kind: 'natural_zero', surface: 'following', surfaceOrdinal: 1, startedAt: '2026-09-01T15:59:59.850Z', completedAt: '2026-09-01T15:59:59.875Z', occurrences: [] },
      { kind: 'natural_zero', surface: 'explore', surfaceOrdinal: 2, startedAt: '2026-09-01T15:59:59.875Z', completedAt, occurrences: [] },
    ],
  }
}

function envelope(currentText: string, reference?: TelegramInboundEnvelope['reference'], messageId = 11): TelegramInboundEnvelope {
  return Object.freeze({
    chat: Object.freeze({ id: 7, type: 'private' }),
    message: Object.freeze({ id: messageId }),
    currentText,
    ...(reference === undefined ? {} : { reference: Object.freeze(reference) }),
    signal: new AbortController().signal,
  })
}

function waterfall(listeners: readonly Listener[], value: TelegramInboundEnvelope, root: () => TelegramInboundResult = () => ({ kind: 'root-delivered' })): Promise<TelegramInboundResult> {
  let index = 0
  const next = (): TelegramInboundResult | Promise<TelegramInboundResult> => {
    const listener = listeners[index++]
    return listener === undefined ? root() : listener(value, next)
  }
  return Promise.resolve(next())
}

const temporaryDirectories: string[] = []

function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value !== 'object') throw new Error('fixture value is not canonical JSON')
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonical(value), 'utf8').digest('hex')}`
}

function flattenAggregateErrors(error: unknown): unknown[] {
  if (!(error instanceof AggregateError)) return [error]
  return error.errors.flatMap(flattenAggregateErrors)
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
  ownerObserver.closeCount = 0
  ownerObserver.events.length = 0
  ownerObserver.wiringEvents.length = 0
  ownerObserver.contextOwnerOptions.length = 0
  ownerObserver.contextOwners.length = 0
  ownerObserver.contextSnapshotResults.length = 0
  ownerObserver.candidateFactoryOptions.length = 0
  ownerObserver.candidateOwners.length = 0
  ownerObserver.coordinatorOptions.length = 0
  ownerObserver.coordinatorOwners.length = 0
  ownerObserver.personalContextRuntimeR4.length = 0
  ownerObserver.startupBinderCalls.length = 0
  ownerObserver.startupBoundFactories.length = 0
  ownerObserver.startupBoundFactoryCalls.length = 0
  vi.restoreAllMocks()
})

describe('Personal Context Telegram runtime composition (RED)', () => {
  it('requires a reliable sessionQuery before installing any listener while the resolved data directory default remains usable', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'x-feed-runtime-missing-dependency-'))
    temporaryDirectories.push(dataDir)
    const missingHistory = emptyHistoryHarness({ withoutHistory: true })

    await expect(installTelegramExtension(missingHistory.ctx as never, { dataDir, personalFeedDataDir: join(dataDir, 'personal-feed') }))
      .rejects.toThrow()
    expect(ownerObserver.candidateFactoryOptions).toHaveLength(0)
    expect(missingHistory.registration).toEqual([])
    expect(missingHistory.historyCalls).toEqual([])

    const completeHistory = emptyHistoryHarness()
    const dispose = await installTelegramExtension(completeHistory.ctx as never, {
      dataDir,
      personalFeedDataDir: join(dataDir, 'personal-feed'),
    })
    await dispose()
  })

  it('completes the empty fixed-session bootstrap before registering inbound listeners', async () => {
    const root = mkdtempSync(join(tmpdir(), 'x-feed-runtime-bootstrap-'))
    temporaryDirectories.push(root)
    const personalFeedDataDir = join(root, 'personal-feed')
    const harness = emptyHistoryHarness()
    const dispose = await installTelegramExtension(harness.ctx as never, config(root, personalFeedDataDir))

    expect(harness.historyCalls).toEqual(['list', 'list'])
    const firstInbound = harness.timeline.indexOf('register:telegram/inbound')
    expect(firstInbound).toBeGreaterThan(-1)
    expect(harness.timeline.slice(0, firstInbound)).not.toContain('register:telegram/inbound')
    expect(harness.timeline.lastIndexOf('history:list')).toBeLessThan(firstInbound)
    expect(harness.listeners.get('telegram/inbound')).toHaveLength(3)
    expect(harness.registration.filter(name => name === 'telegram/inbound')).toHaveLength(3)
    await dispose()
  })

  it.each(['incomplete', 'throw'] as const)('fails closed on %s bootstrap and leaves zero inbound listeners', async mode => {
    const root = mkdtempSync(join(tmpdir(), 'x-feed-runtime-bootstrap-fail-'))
    temporaryDirectories.push(root)
    const harness = emptyHistoryHarness(mode === 'incomplete'
      ? { historyIncomplete: true }
      : { historyFailure: new Error('history unavailable') })

    await expect(installTelegramExtension(harness.ctx as never, config(root, join(root, 'personal-feed'))))
      .rejects.toThrow()
    expect(ownerObserver.candidateFactoryOptions).toHaveLength(0)
    expect(harness.listeners.get('telegram/inbound') ?? []).toEqual([])
    expect(harness.registration).not.toContain('telegram/inbound')
  })

  it('creates one candidate owner only after complete bootstrap and keeps the candidate ledger inert across stale disposal paths', async () => {
    const root = mkdtempSync(join(tmpdir(), 'x-feed-runtime-candidate-wiring-'))
    temporaryDirectories.push(root)
    const personalFeedDataDir = join(root, 'personal-feed')
    const completionLedgerPath = join(personalFeedDataDir, 'v2', 'candidate-judgments.jsonl')
    mkdirSync(join(personalFeedDataDir, 'v2'), { recursive: true })
    const sentinel = Buffer.from('candidate-ledger-sentinel\n', 'utf8')
    writeFileSync(completionLedgerPath, sentinel)

    const first = rootFixture('session-telegram', undefined, 'candidate-root-1')
    const second = rootFixture('session-telegram', undefined, 'candidate-root-2')
    const harness = emptyHistoryHarness()
    ;(harness.ctx as { agents: { roots: () => unknown[] } }).agents.roots = () => [first.agent, second.agent]

    const dispose = await installTelegramExtension(harness.ctx as never, config(root, personalFeedDataDir))

    // Keep this as the first decisive assertion: the old production entry has
    // no candidate factory call, so its RED is the missing owner (not a later
    // shape, fixture, bootstrap, or mock failure).
    expect(ownerObserver.candidateFactoryOptions).toHaveLength(1)
    expect(ownerObserver.candidateOwners).toHaveLength(1)
    expect(ownerObserver.coordinatorOptions).toHaveLength(1)

    const factoryOptions = ownerObserver.candidateFactoryOptions[0] as Record<string, unknown>
    expect(Object.getPrototypeOf(factoryOptions)).toBe(Object.prototype)
    expect(Reflect.ownKeys(factoryOptions).sort()).toEqual(['clock', 'completionLedgerPath'])
    expect(Object.keys(factoryOptions).sort()).toEqual(['clock', 'completionLedgerPath'])
    expect(Object.keys(factoryOptions).every(key => {
      const descriptor = Object.getOwnPropertyDescriptor(factoryOptions, key)
      return descriptor?.enumerable === true && 'value' in (descriptor ?? {})
    })).toBe(true)
    expect(factoryOptions.completionLedgerPath).toBe(completionLedgerPath)

    const coordinatorOptions = ownerObserver.coordinatorOptions[0] as {
      readonly clock: unknown
      readonly r2: { readonly observe: (input: unknown) => unknown | Promise<unknown> }
      readonly r3: unknown
      readonly r4: { readonly snapshot: (input: unknown) => unknown | Promise<unknown> }
      readonly r5: { readonly judge: (input: unknown) => unknown | Promise<unknown> }
    }
    expect(coordinatorOptions.clock).toBe(factoryOptions.clock)
    expect(coordinatorOptions.r3).toBe(ownerObserver.candidateOwners[0])
    expect(coordinatorOptions.r4).toBe(ownerObserver.personalContextRuntimeR4[0])
    expect(typeof coordinatorOptions.r4.snapshot).toBe('function')

    const request = Object.freeze({
      requestId: 'telegram:7:11',
      cutoff: '2026-08-31T16:00:00.000Z',
      shanghaiDay: '2026-09-01',
    })
    const signal = new AbortController().signal
    const r2 = await coordinatorOptions.r2.observe({ request, signal })
    expect(r2).toEqual({ kind: 'unknown' })
    expect(Object.keys(r2 as Record<string, unknown>)).toEqual(['kind'])
    const r5 = await coordinatorOptions.r5.judge({
      request,
      snapshot: Object.freeze({}),
      candidates: Object.freeze({ borrowCurrent: async () => ({ kind: 'done' as const }) }),
      signal,
    })
    expect(r5).toEqual({ kind: 'incomplete', completed: [], reason: 'unknown' })
    expect(Object.keys(r5 as Record<string, unknown>).sort()).toEqual(['completed', 'kind', 'reason'])
    expect(Object.isFrozen(r5 as object)).toBe(true)
    expect(Object.isFrozen((r5 as { readonly completed: readonly unknown[] }).completed)).toBe(true)

    expect(harness.historyCalls).toEqual(['list', 'list'])
    const firstInbound = harness.timeline.indexOf('register:telegram/inbound')
    expect(firstInbound).toBeGreaterThan(-1)
    expect(ownerObserver.wiringEvents.lastIndexOf('history:list')).toBeLessThan(
      ownerObserver.wiringEvents.indexOf('candidate.factory'),
    )
    expect(ownerObserver.wiringEvents.indexOf('candidate.factory')).toBeLessThan(
      ownerObserver.wiringEvents.indexOf('listener.register:telegram/inbound'),
    )
    expect(harness.registration.filter(name => name === 'telegram/inbound')).toHaveLength(3)

    // Existing roots and repeated root-created notifications must not create a
    // second candidate owner.
    const createdListeners = harness.listeners.get('agent/created') ?? []
    for (const listener of createdListeners) {
      listener({ agent: first.agent } as never, (() => ({ kind: 'root-delivered' })) as never)
      listener({ agent: second.agent } as never, (() => ({ kind: 'root-delivered' })) as never)
    }
    expect(ownerObserver.candidateFactoryOptions).toHaveLength(1)

    const staleInbound = [...(harness.listeners.get('telegram/inbound') ?? [])]
    const staleSource = staleInbound[0]
    const stalePersonalFeed = staleInbound.at(-1)
    expect(staleSource).toBeDefined()
    expect(stalePersonalFeed).toBeDefined()
    const staleRoot = vi.fn(() => ({ kind: 'root-delivered' as const }))
    const beforeDispose = readFileSync(completionLedgerPath)
    await dispose()
    expect(readFileSync(completionLedgerPath)).toEqual(beforeDispose)
    await expect(staleSource!(envelope('普通消息'), staleRoot)).resolves.toEqual({ kind: 'root-delivered' })
    await expect(stalePersonalFeed!(envelope('给我一次个人 Feed'), staleRoot)).resolves.toEqual({ kind: 'root-delivered' })
    expect(staleRoot).toHaveBeenCalledTimes(2)
    expect(readFileSync(completionLedgerPath)).toEqual(sentinel)

    // The only production creation site is the Telegram install entry.  This
    // bounded check counts calls, so barrel exports/definitions are not treated
    // as instances; unrelated entries must not mention the fixed ledger name.
    const telegramSource = readFileSync(new URL('../src/telegram-extension.ts', import.meta.url), 'utf8')
    expect(telegramSource.match(/\bcreatePersonalFeedV2CandidateLifecycle\s*\(/g) ?? []).toHaveLength(1)
    const nonCreationSources = [
      '../src/personal-feed/personal-context-telegram-runtime.ts',
      '../src/personal-feed/telegram-adapter.ts',
      '../../../local-profiles/telegram/cordis.patch.yml',
      '../../../local-profiles/web/cordis.patch.yml',
      '../../telegram-gateway/src/extensions.ts',
      '../../telegram-gateway/src/index.ts',
      '../../../../plugins-src/skills/personal-feed-selector/SKILL.md',
    ]
    for (const relativePath of nonCreationSources) {
      const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8')
      expect(source).not.toMatch(/\bcreatePersonalFeedV2CandidateLifecycle\s*\(/)
      expect(source).not.toContain('candidate-judgments.jsonl')
    }
  })

  it.each([
    ['source', 'telegram/inbound', 1, []],
    ['feedback ready', 'telegram/inbound/ready', 1, [0]],
    ['feedback waterfall', 'telegram/inbound', 2, [0]],
    ['Personal Feed', 'telegram/inbound', 3, [1, 0]],
  ] as const)('post-bootstrap acquisition failure at %s rolls back every acquired listener exactly once', async (label, failedName, failedOrdinal, expectedInboundDisposal) => {
    const root = mkdtempSync(join(tmpdir(), `x-feed-runtime-acquisition-${label.replace(/\s+/gu, '-')}-`))
    temporaryDirectories.push(root)
    const harness = emptyHistoryHarness()
    let inboundRegistrations = 0
    const originalOn = harness.ctx.on as unknown as (name: string, listener: Listener, options?: { readonly prepend?: boolean }) => () => void
    harness.ctx.on = vi.fn((name: string, listener: Listener, options?: { readonly prepend?: boolean }) => {
      const ordinal = name === 'telegram/inbound' ? ++inboundRegistrations : 1
      if (name === failedName && ordinal === failedOrdinal) throw new Error(`${label} acquisition failed`)
      return originalOn(name, listener, options)
    }) as never

    await expect(installTelegramExtension(harness.ctx as never, config(root, join(root, 'personal-feed')))).rejects.toThrow(`${label} acquisition failed`)
    expect(harness.listeners.get('telegram/inbound') ?? []).toEqual([])
    expect(harness.listeners.get('telegram/inbound/ready') ?? []).toEqual([])
    expect(harness.inboundDisposal).toEqual(expectedInboundDisposal)
    expect(ownerObserver.closeCount).toBe(1)
    expect(ownerObserver.events.at(-1)).toBe('owner.close')
  })

  it.each([
    ['root tool1', 'tool1', []],
    ['root tool2', 'tool2', ['x_feed_record_feedback']],
    ['root section', 'section', ['x_feed_list_saved', 'x_feed_record_feedback']],
  ] as const)('post-bootstrap %s failure leaves no root registration or listener residue', async (label, failure, expectedDisposal) => {
    const root = mkdtempSync(join(tmpdir(), `x-feed-runtime-${failure}-`))
    temporaryDirectories.push(root)
    const fixture = rootFixture('session-telegram', failure)
    const harness = emptyHistoryHarness()
    ;(harness.ctx as { agents: { roots: () => unknown[] } }).agents.roots = () => [fixture.agent]

    await expect(installTelegramExtension(harness.ctx as never, config(root, join(root, 'personal-feed')))).rejects.toThrow()
    expect(harness.listeners.get('telegram/inbound') ?? []).toEqual([])
    expect(harness.listeners.get('telegram/inbound/ready') ?? []).toEqual([])
    expect(fixture.tools).toEqual([])
    expect(fixture.sections).toEqual([])
    expect(fixture.disposal).toEqual(expectedDisposal)
    expect(ownerObserver.closeCount).toBe(1)
    expect(ownerObserver.events.at(-1)).toBe('owner.close')
  })

  it('post-bootstrap second existing root failure rolls back the first root and all shared listeners', async () => {
    const root = mkdtempSync(join(tmpdir(), 'x-feed-runtime-second-root-'))
    temporaryDirectories.push(root)
    const first = rootFixture('session-telegram')
    const second = rootFixture('session-telegram', 'section')
    const harness = emptyHistoryHarness()
    ;(harness.ctx as { agents: { roots: () => unknown[] } }).agents.roots = () => [first.agent, second.agent]

    await expect(installTelegramExtension(harness.ctx as never, config(root, join(root, 'personal-feed')))).rejects.toThrow()
    expect(first.timeline).toEqual([
      'register:x_feed_record_feedback', 'register:x_feed_list_saved', 'register:x-feed:contract',
      'dispose:x-feed:contract', 'dispose:x_feed_list_saved', 'dispose:x_feed_record_feedback',
    ])
    expect(first.disposal).toEqual(['x-feed:contract', 'x_feed_list_saved', 'x_feed_record_feedback'])
    expect(first.tools).toEqual([])
    expect(first.sections).toEqual([])
    expect(second.tools).toEqual([])
    expect(second.sections).toEqual([])
    expect(harness.listeners.get('telegram/inbound') ?? []).toEqual([])
    expect(ownerObserver.closeCount).toBe(1)
    expect(ownerObserver.events.at(-1)).toBe('owner.close')
  })

  it('agent/created registration failure rolls back post-bootstrap listeners', async () => {
    const root = mkdtempSync(join(tmpdir(), 'x-feed-runtime-created-registration-'))
    temporaryDirectories.push(root)
    const harness = emptyHistoryHarness()
    const originalOn = harness.ctx.on as unknown as (name: string, listener: Listener, options?: { readonly prepend?: boolean }) => () => void
    harness.ctx.on = vi.fn((name: string, listener: Listener, options?: { readonly prepend?: boolean }) => {
      if (name === 'agent/created') throw new Error('agent/created registration failed')
      return originalOn(name, listener, options)
    }) as never

    await expect(installTelegramExtension(harness.ctx as never, config(root, join(root, 'personal-feed')))).rejects.toThrow('agent/created registration failed')
    expect(harness.listeners.get('telegram/inbound') ?? []).toEqual([])
    expect(harness.listeners.get('telegram/inbound/ready') ?? []).toEqual([])
    expect(ownerObserver.closeCount).toBe(1)
    expect(ownerObserver.events.at(-1)).toBe('owner.close')
  })

  it('future agent/created root failure rolls back only that root and preserves an already-installed root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'x-feed-runtime-future-root-failure-'))
    temporaryDirectories.push(root)
    const existing = rootFixture('session-telegram')
    const future = rootFixture('session-telegram', 'section')
    const harness = emptyHistoryHarness()
    const roots: unknown[] = [existing.agent]
    ;(harness.ctx as { agents: { roots: () => unknown[] } }).agents.roots = () => roots
    const createdHandlers: Array<(value: { readonly agent: unknown }) => void> = []
    const originalOn = harness.ctx.on as unknown as (name: string, listener: Listener, options?: { readonly prepend?: boolean }) => () => void
    harness.ctx.on = vi.fn((name: string, listener: Listener, options?: { readonly prepend?: boolean }) => {
      if (name === 'agent/created') {
        createdHandlers.push(listener as unknown as (value: { readonly agent: unknown }) => void)
        return () => undefined
      }
      return originalOn(name, listener, options)
    }) as never

    const dispose = await installTelegramExtension(harness.ctx as never, config(root, join(root, 'personal-feed')))
    expect(existing.tools).toHaveLength(2)
    expect(createdHandlers).toHaveLength(1)
    roots.push(future.agent)
    expect(() => createdHandlers[0]!({ agent: future.agent })).toThrow()
    expect(future.tools).toEqual([])
    expect(future.sections).toEqual([])
    expect(future.disposal).toEqual(['x_feed_list_saved', 'x_feed_record_feedback'])
    expect(existing.tools).toHaveLength(2)
    await dispose()
    expect(existing.disposal).toEqual(['x-feed:contract', 'x_feed_list_saved', 'x_feed_record_feedback'])
    expect(existing.tools).toEqual([])
    expect(existing.sections).toEqual([])
  })

  it('normal extension disposal is a single reverse transaction: root sections, tools, listeners, then owner', async () => {
    const root = mkdtempSync(join(tmpdir(), 'x-feed-runtime-dispose-transaction-'))
    temporaryDirectories.push(root)
    const first = rootFixture('session-telegram', undefined, 'root1')
    const second = rootFixture('session-telegram', undefined, 'root2')
    const harness = emptyHistoryHarness()
    ;(harness.ctx as { agents: { roots: () => unknown[] } }).agents.roots = () => [first.agent, second.agent]

    const dispose = await installTelegramExtension(harness.ctx as never, config(root, join(root, 'personal-feed')))
    const firstDispose = dispose()
    expect(dispose()).toBe(firstDispose)
    await firstDispose
    expect(second.timeline).toEqual([
      'register:x_feed_record_feedback', 'register:x_feed_list_saved', 'register:x-feed:contract',
      'dispose:x-feed:contract', 'dispose:x_feed_list_saved', 'dispose:x_feed_record_feedback',
    ])
    expect(first.timeline).toEqual([
      'register:x_feed_record_feedback', 'register:x_feed_list_saved', 'register:x-feed:contract',
      'dispose:x-feed:contract', 'dispose:x_feed_list_saved', 'dispose:x_feed_record_feedback',
    ])
    expect(second.disposal).toEqual(['x-feed:contract', 'x_feed_list_saved', 'x_feed_record_feedback'])
    expect(first.disposal).toEqual(['x-feed:contract', 'x_feed_list_saved', 'x_feed_record_feedback'])
    expect(second.tools).toEqual([])
    expect(second.sections).toEqual([])
    expect(first.tools).toEqual([])
    expect(first.sections).toEqual([])
    expect(harness.inboundDisposal).toEqual([2, 1, 0])
    expect(harness.listeners.get('telegram/inbound') ?? []).toEqual([])
    expect(ownerObserver.events.slice(-13)).toEqual([
      'listener.dispose:agent/created',
      'root2.dispose:x-feed:contract', 'root2.dispose:x_feed_list_saved', 'root2.dispose:x_feed_record_feedback',
      'root1.dispose:x-feed:contract', 'root1.dispose:x_feed_list_saved', 'root1.dispose:x_feed_record_feedback',
      'listener.dispose:telegram/inbound', 'listener.dispose:telegram/inbound',
      'listener.dispose:telegram/inbound/ready', 'pending.unload',
      'listener.dispose:telegram/inbound', 'owner.close',
    ])
    expect(ownerObserver.closeCount).toBe(1)
  })

  it.each([
    ['successfully waits for a real classifier next task before closing the owner', false] as const,
    ['preserves only independent real classifier next and return errors through extension disposal', true] as const,
  ])('%s', async (_label, failing) => {
    const root = mkdtempSync(join(tmpdir(), `x-feed-runtime-real-classifier-${failing ? 'failure' : 'success'}-`))
    temporaryDirectories.push(root)
    const harness = emptyHistoryHarness()
    let wireSignal: AbortSignal | undefined
    let runtimeAbortReason: unknown
    let abortCount = 0
    let returnCount = 0
    let releaseNext: ((result: IteratorResult<StreamChunk>) => void) | undefined
    let rejectNext: ((reason: unknown) => void) | undefined
    let releaseReturn: ((result: IteratorResult<StreamChunk>) => void) | undefined
    let rejectReturn: ((reason: unknown) => void) | undefined
    const nextTask = new Promise<IteratorResult<StreamChunk>>((resolve, reject) => {
      releaseNext = resolve
      rejectNext = reject
    })
    const returnTask = new Promise<IteratorResult<StreamChunk>>((resolve, reject) => {
      releaseReturn = resolve
      rejectReturn = reject
    })
    ;(harness.ctx as unknown as { readonly llm: { stream: (request: GenerateOptions) => AsyncIterable<StreamChunk> } }).llm.stream = vi.fn((request: GenerateOptions): AsyncIterable<StreamChunk> => {
      wireSignal = request.signal
      request.signal?.addEventListener('abort', () => {
        abortCount += 1
        runtimeAbortReason = request.signal?.reason
      }, { once: true })
      const iterator: AsyncIterator<StreamChunk> = {
        next: () => nextTask,
        return: () => {
          returnCount += 1
          return returnTask
        },
      }
      return { [Symbol.asyncIterator]: () => iterator }
    })

    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      const dispose = await installTelegramExtension(harness.ctx as never, config(root, join(root, 'personal-feed')))
      const inbound = harness.listeners.get('telegram/inbound') ?? []
      const sourceRun = waterfall(inbound, envelope('普通消息'))
      void sourceRun.then(() => undefined, () => undefined)
      for (let turn = 0; turn < 8 && wireSignal === undefined; turn += 1) await Promise.resolve()
      expect(wireSignal).toBeDefined()

      let disposeSettled = false
      const firstDispose = dispose()
      void firstDispose.then(() => { disposeSettled = true }, () => { disposeSettled = true })
      expect(dispose()).toBe(firstDispose)
      for (let turn = 0; turn < 8 && returnCount === 0; turn += 1) await Promise.resolve()
      expect(wireSignal?.aborted).toBe(true)
      expect(abortCount).toBe(1)
      expect(returnCount).toBe(1)
      expect(disposeSettled).toBe(false)
      expect(ownerObserver.closeCount).toBe(0)

      if (!failing) {
        releaseNext?.({ done: true, value: undefined })
        releaseReturn?.({ done: true, value: undefined })
        await sourceRun
        await expect(firstDispose).resolves.toBeUndefined()
        expect(returnCount).toBe(1)
        expect(abortCount).toBe(1)
        expect(ownerObserver.closeCount).toBe(1)
        expect(ownerObserver.events.at(-1)).toBe('owner.close')
      } else {
        const lateNextError = new Error('late classifier next failed')
        const lateReturnError = new Error('late classifier return failed')
        rejectNext?.(lateNextError)
        await Promise.resolve()
        expect(disposeSettled).toBe(false)
        expect(ownerObserver.closeCount).toBe(0)
        rejectReturn?.(lateReturnError)
        await sourceRun

        let disposeError: unknown
        try { await firstDispose } catch (error) { disposeError = error }
        const errors = flattenAggregateErrors(disposeError)
        expect(errors).toEqual([lateNextError, lateReturnError])
        expect(errors[0]).toBe(lateNextError)
        expect(errors[1]).toBe(lateReturnError)
        expect(errors).not.toContain(runtimeAbortReason)
        expect(returnCount).toBe(1)
        expect(abortCount).toBe(1)
        expect(ownerObserver.closeCount).toBe(1)
        expect(ownerObserver.events.at(-1)).toBe('owner.close')
      }
      await new Promise<void>(resolve => setTimeout(resolve, 0))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
      releaseNext?.({ done: true, value: undefined })
      releaseReturn?.({ done: true, value: undefined })
    }
  }, 2_000)

  it('guards blank/whitespace at the first real waterfall layer with zero source, ledger, semantic, X, and root effects', async () => {
    const root = mkdtempSync(join(tmpdir(), 'x-feed-runtime-blank-'))
    temporaryDirectories.push(root)
    const harness = emptyHistoryHarness()
    const dispose = await installTelegramExtension(harness.ctx as never, config(root, join(root, 'personal-feed')))
    const inbound = harness.listeners.get('telegram/inbound') ?? []
    const rootResult = vi.fn(() => ({ kind: 'root-delivered' as const }))
    await expect(waterfall(inbound, envelope('  \n\t  '), rootResult)).resolves.toEqual({ kind: 'handled', finalText: '' })
    expect(rootResult).not.toHaveBeenCalled()
    await dispose()
    expect(existsSync(join(root, 'personal-feed', 'v2', 'requests.jsonl'))).toBe(false)
    if (existsSync(join(root, 'personal-feed', 'v2', 'personal-context.sqlite'))) {
      const personalFeed = await import('@herman/personal-feed')
      const owner = personalFeed.createPersonalContextOwner({
        databasePath: join(root, 'personal-feed', 'v2', 'personal-context.sqlite'),
        clock: { now: () => new Date('2026-08-31T16:00:00.000Z') },
      })
      expect(owner.read()).toEqual({ sources: [], coverage: [] })
      owner.close()
    }
  })

  it('fails closed on durable capture failure for non-Feed and keeps downstream, shared Feed, R4, and root at zero', async () => {
    const factory = await loadRuntimeSeam()
    const owner = ownerFixture({ sources: [], coverage: [] })
    owner.capture.mockImplementation(() => { throw new Error('capture unavailable') })
    const runtime = factory({ owner })
    const harness = seamContext()
    const downstream = vi.fn((_value: TelegramInboundEnvelope, next: () => TelegramInboundResult) => next())
    harness.ctx.on('telegram/inbound', downstream)
    const personalFeedHandler = vi.fn(async () => ({ kind: 'handled' as const, finalText: '' }))
    const root = vi.fn(() => ({ kind: 'root-delivered' as const }))
    const dispose = runtime.registerSourceFirst(harness.ctx, { personalFeedHandler })
    await expect(runWaterfall(harness.listeners, envelope('普通消息'), root)).resolves.toEqual({ kind: 'failed', visibleError: '这次没有完成：判断或执行未完成。' })
    expect(downstream).not.toHaveBeenCalled()
    expect(personalFeedHandler).not.toHaveBeenCalled()
    expect(owner.freezeFence).not.toHaveBeenCalled()
    expect(owner.snapshot).not.toHaveBeenCalled()
    expect(root).not.toHaveBeenCalled()
    dispose()
  })

  it('uses a request-scoped Feed failure marker to enter the real shared coordinator once, then clears it for a new Feed request', async () => {
    const factory = await loadRuntimeSeam()
    const personalFeed = await import('@herman/personal-feed')
    const adapter = await import('../src/personal-feed/telegram-adapter.ts') as {
      readonly createPersonalFeedTelegramRequestHandler?: (options: { readonly coordinator: unknown }) =>
        (envelope: TelegramInboundEnvelope) => Promise<TelegramInboundResult>
      readonly registerPersonalFeedTelegramAdapter?: (
        ctx: { readonly on: (name: string, listener: Listener, options?: { readonly prepend?: boolean }) => () => void },
        options: { readonly coordinator: unknown },
      ) => () => void
    }
    if (typeof adapter.createPersonalFeedTelegramRequestHandler !== 'function'
      || typeof adapter.registerPersonalFeedTelegramAdapter !== 'function') throw new Error('shared handler is unavailable')
    const directory = mkdtempSync(join(tmpdir(), 'personal-context-runtime-capture-failure-'))
    temporaryDirectories.push(directory)
    const calls = { r2: 0, r3: 0, r5: 0 }
    const owner = ownerFixture({ sources: [], coverage: [] })
    let captureCount = 0
    owner.capture.mockImplementation(input => {
      if (captureCount++ === 0) throw new Error('capture unavailable')
      return { source: { ...source(7, 12, 1), rawText: input.rawText, sourceKey: 'telegram:7:12' }, coverage: pending('telegram:7:12') }
    })
    owner.freezeFence.mockImplementation(input => ({
      schemaVersion: 1,
      requestId: (input as { readonly request: { readonly requestId: string } }).request.requestId,
      cutoff: '2026-08-31T16:00:00.000Z',
      shanghaiDay: '2026-09-01',
      storeId: 'fixture-store',
      maxCaptureSequence: 1,
      maxTerminalTransactionSequence: 0,
      digest: 'd'.repeat(64),
    }))
    owner.snapshot.mockReturnValue({ kind: 'unknown', reason: 'current_source_pending' })
    const runtime = factory({ owner })
    const coordinator = personalFeed.createPersonalFeedV2RequestCoordinator({
      ledgerPath: join(directory, 'requests.jsonl'),
      clock: { now: () => new Date('2026-08-31T16:00:00.000Z') },
      r4: runtime.r4,
      r2: { observe: async () => { calls.r2 += 1; return { kind: 'complete' as const, window: {} } } },
      r3: { admit: async () => { calls.r3 += 1; return { kind: 'admitted' as const, cursor: { borrowCurrent: async () => ({ kind: 'done' as const }), finalize: async () => ({ kind: 'incomplete' as const, reason: 'failed' as const }), close: async () => undefined } } } },
      r5: { judge: async () => { calls.r5 += 1; return { kind: 'none' as const, completed: Object.freeze([]) } } },
    })
    const realSharedHandler = adapter.createPersonalFeedTelegramRequestHandler({ coordinator })
    const captureFailureHandler = vi.fn(realSharedHandler)
    const harness = seamContext()
    const oldX = vi.fn((_value: TelegramInboundEnvelope, next: () => TelegramInboundResult) => next())
    const stopOldX = harness.ctx.on('telegram/inbound', oldX)
    const root = vi.fn(() => ({ kind: 'root-delivered' as const }))
    const dispose = runtime.registerSourceFirst(harness.ctx, { personalFeedHandler: captureFailureHandler })
    const stopPersonalFeed = adapter.registerPersonalFeedTelegramAdapter(harness.ctx, { coordinator })
    const first = await runWaterfall(harness.listeners, envelope('给我一次个人 Feed'), root)
    expect(first).toMatchObject({
      kind: 'handled-awaiting-delivery',
      finalText: '这次没有完成：个人语境不足或未完成。',
    })
    expect(captureFailureHandler).toHaveBeenCalledOnce()
    expect(owner.freezeFence).not.toHaveBeenCalled()
    expect(owner.snapshot).not.toHaveBeenCalled()
    expect(oldX).not.toHaveBeenCalled()
    expect(root).not.toHaveBeenCalled()
    expect(calls).toEqual({ r2: 0, r3: 0, r5: 0 })
    if (first.kind !== 'handled-awaiting-delivery') throw new Error('first Feed result was not deliverable')
    first.settle({ chatId: 7, triggerMessageId: 11, visibleText: first.finalText, messageIds: [901] })
    expect(coordinator.read('telegram:7:11')).toMatchObject({ status: 'delivered', outcome: { category: 'personal_context' } })

    const adjacentRoot = vi.fn(() => ({ kind: 'root-delivered' as const }))
    const second = await runWaterfall(harness.listeners, envelope('给我一次个人 Feed', undefined, 12), adjacentRoot)
    expect(second).toMatchObject({ kind: 'handled-awaiting-delivery' })
    expect(captureFailureHandler).toHaveBeenCalledOnce()
    expect(oldX).toHaveBeenCalledOnce()
    expect(owner.freezeFence).toHaveBeenCalledOnce()
    expect(owner.snapshot).toHaveBeenCalledOnce()
    expect(calls).toEqual({ r2: 0, r3: 0, r5: 0 })
    expect(adjacentRoot).not.toHaveBeenCalled()
    stopPersonalFeed()
    dispose()
    stopOldX()
  })

  it('registers source capture before old X and Personal Feed, then disposes the inbound chain in reverse', async () => {
    const root = mkdtempSync(join(tmpdir(), 'x-feed-runtime-order-'))
    temporaryDirectories.push(root)
    const harness = emptyHistoryHarness()
    const dispose = await installTelegramExtension(harness.ctx as never, config(root, join(root, 'personal-feed')))
    const inbound = harness.listeners.get('telegram/inbound') ?? []
    expect(inbound).toHaveLength(3)

    const rootResult = vi.fn(() => ({ kind: 'root-delivered' as const }))
    await waterfall(inbound, envelope('普通消息', { messageText: '引用内容不能成为正文' }), rootResult)
    expect(harness.registration.filter(name => name === 'telegram/inbound')).toHaveLength(3)

    await dispose()
    expect(harness.inboundRegistration).toEqual([0, 1, 2])
    expect(harness.inboundDisposal).toEqual([2, 1, 0])
    const personalFeed = await import('@herman/personal-feed')
    const owner = personalFeed.createPersonalContextOwner({
      databasePath: join(root, 'personal-feed', 'v2', 'personal-context.sqlite'),
      clock: { now: () => new Date('2026-08-31T16:00:00.000Z') },
    })
    const snapshot = owner.read()
    expect(snapshot.sources).toHaveLength(1)
    expect(snapshot.sources[0]).toMatchObject({
      rawText: '普通消息',
      reference: null,
    })
    expect(JSON.stringify(snapshot)).not.toContain('引用内容不能成为正文')
    owner.close()
    expect(harness.disposal.filter(name => name === 'telegram/inbound')).toEqual([
      'telegram/inbound',
      'telegram/inbound',
      'telegram/inbound',
    ])
    expect(harness.listeners.get('telegram/inbound')).toEqual([])
  })

  it.each([
    '给我一次个人 Feed',
    '我最近不关心通用 AI 新闻了，给我一次个人 Feed。',
  ] as const)('uses one request-scoped excludedRequestId for pure or mixed Feed (%s), keeps quote canary out of every source/ledger carrier, and keeps a later source independent', async feedText => {
    const root = mkdtempSync(join(tmpdir(), 'x-feed-runtime-excluded-'))
    temporaryDirectories.push(root)
    const personalFeedDataDir = join(root, 'personal-feed')
    const harness = emptyHistoryHarness()
    const dispose = await installTelegramExtension(harness.ctx as never, config(root, personalFeedDataDir))
    const inbound = harness.listeners.get('telegram/inbound') ?? []
    const firstRoot = vi.fn(() => ({ kind: 'root-delivered' as const }))
    const first = await waterfall(inbound, envelope(feedText, { messageText: 'QUOTE-CANARY-DO-NOT-COPY' }), firstRoot)
    expect(first).toMatchObject({ kind: 'handled-awaiting-delivery' })
    const secondRoot = vi.fn(() => ({ kind: 'root-delivered' as const }))
    await waterfall(inbound, envelope('普通消息', undefined, 12), secondRoot)
    await dispose()

    const personalFeed = await import('@herman/personal-feed')
    const owner = personalFeed.createPersonalContextOwner({
      databasePath: join(personalFeedDataDir, 'v2', 'personal-context.sqlite'),
      clock: { now: () => new Date('2026-08-31T16:00:00.000Z') },
    })
    const snapshot = owner.read()
    expect(snapshot.sources).toHaveLength(2)
    expect(snapshot.sources[0]).toMatchObject({ rawText: feedText, reference: null, excludedRequestId: 'telegram:7:11' })
    expect(snapshot.sources[1]).toMatchObject({ rawText: '普通消息', reference: null })
    expect(snapshot.sources[1]).not.toHaveProperty('excludedRequestId')
    expect(JSON.stringify(snapshot)).not.toContain('QUOTE-CANARY-DO-NOT-COPY')
    expect(JSON.stringify(harness.llmRequests)).not.toContain('QUOTE-CANARY-DO-NOT-COPY')
    owner.close()
  })

  it('shares one frozen install clock across R4, R3, R1, and the lazy R2 binding while independent installs stay isolated', async () => {
    expect(installTelegramExtension.length).toBe(2)
    const firstRoot = mkdtempSync(join(tmpdir(), 'x-feed-runtime-clock-first-'))
    const secondRoot = mkdtempSync(join(tmpdir(), 'x-feed-runtime-clock-second-'))
    temporaryDirectories.push(firstRoot, secondRoot)
    const firstHarness = emptyHistoryHarness()
    const secondHarness = emptyHistoryHarness()

    const firstDispose = await installTelegramExtension(firstHarness.ctx as never, config(firstRoot, join(firstRoot, 'personal-feed')))
    expect(ownerObserver.contextOwnerOptions).toHaveLength(1)
    expect(ownerObserver.candidateFactoryOptions).toHaveLength(1)
    expect(ownerObserver.coordinatorOptions).toHaveLength(1)
    expect(ownerObserver.personalContextRuntimeR4).toHaveLength(1)
    expect(ownerObserver.startupBinderCalls).toHaveLength(1)
    expect(ownerObserver.startupBoundFactories).toHaveLength(1)
    expect(ownerObserver.startupBoundFactoryCalls).toEqual([])

    const firstOwnerOptions = ownerObserver.contextOwnerOptions[0] as { readonly clock?: unknown }
    const firstCandidateOptions = ownerObserver.candidateFactoryOptions[0] as { readonly clock?: unknown }
    const firstCoordinatorOptions = ownerObserver.coordinatorOptions[0] as { readonly clock?: unknown; readonly r2?: unknown; readonly r5?: unknown }
    const firstBinderCall = ownerObserver.startupBinderCalls[0]
    const firstClock = firstOwnerOptions.clock
    expectFrozenInstallClock(firstClock)
    expect(firstCandidateOptions.clock).toBe(firstClock)
    expect(firstCoordinatorOptions.clock).toBe(firstClock)
    expect(firstBinderCall?.[0]).toBe(new URL('../src/index.ts', import.meta.url).href)
    expect(firstBinderCall?.[1]).toBe(firstClock)
    expect(firstBinderCall).toHaveLength(2)
    expect(Object.isFrozen(ownerObserver.startupBoundFactories[0])).toBe(true)
    expect((ownerObserver.startupBoundFactories[0] as Function).length).toBe(1)

    const firstR2 = await (firstCoordinatorOptions.r2 as { readonly observe: (input: unknown) => Promise<unknown> }).observe({})
    expect(firstR2).toEqual(Object.freeze({ kind: 'unknown' }))
    expect(Object.keys(firstR2 as Record<string, unknown>)).toEqual(['kind'])
    const firstR5 = await (firstCoordinatorOptions.r5 as { readonly judge: (input: unknown) => Promise<unknown> }).judge({})
    expect(firstR5).toEqual({ kind: 'incomplete', completed: [], reason: 'unknown' })
    expect(Object.isFrozen(firstR5)).toBe(true)
    expect(ownerObserver.startupBoundFactoryCalls).toEqual([])
    expect((firstHarness.ctx as { readonly agents: { readonly roots: () => unknown[] } }).agents.roots()).toEqual([])
    expect(firstHarness.listeners.get('agent/created') ?? []).toHaveLength(1)

    const secondDispose = await installTelegramExtension(secondHarness.ctx as never, config(secondRoot, join(secondRoot, 'personal-feed')))
    expect(ownerObserver.contextOwnerOptions).toHaveLength(2)
    expect(ownerObserver.candidateFactoryOptions).toHaveLength(2)
    expect(ownerObserver.coordinatorOptions).toHaveLength(2)
    expect(ownerObserver.personalContextRuntimeR4).toHaveLength(2)
    expect(ownerObserver.startupBinderCalls).toHaveLength(2)
    expect(ownerObserver.startupBoundFactories).toHaveLength(2)
    expect(ownerObserver.startupBoundFactoryCalls).toEqual([])

    const secondOwnerOptions = ownerObserver.contextOwnerOptions[1] as { readonly clock?: unknown }
    const secondCandidateOptions = ownerObserver.candidateFactoryOptions[1] as { readonly clock?: unknown }
    const secondCoordinatorOptions = ownerObserver.coordinatorOptions[1] as { readonly clock?: unknown }
    const secondBinderCall = ownerObserver.startupBinderCalls[1]
    const secondClock = secondOwnerOptions.clock
    expectFrozenInstallClock(secondClock)
    expect(secondClock).not.toBe(firstClock)
    expect(secondCandidateOptions.clock).toBe(secondClock)
    expect(secondCoordinatorOptions.clock).toBe(secondClock)
    expect(secondBinderCall?.[0]).toBe(new URL('../src/index.ts', import.meta.url).href)
    expect(secondBinderCall?.[1]).toBe(secondClock)
    expect(secondBinderCall?.[1]).not.toBe(firstBinderCall?.[1])
    expect((secondHarness.ctx as { readonly agents: { readonly roots: () => unknown[] } }).agents.roots()).toEqual([])
    expect(secondHarness.listeners.get('agent/created') ?? []).toHaveLength(1)

    await firstDispose()
    await secondDispose()
    expect(ownerObserver.startupBoundFactoryCalls).toEqual([])
  })

  it('orders source capture, request cutoff, and real R3 validation through one scripted install clock', async () => {
    const root = mkdtempSync(join(tmpdir(), 'x-feed-runtime-scripted-clock-'))
    temporaryDirectories.push(root)
    const harness = emptyHistoryHarness()
    const sourceEntry = new URL('../src/index.ts', import.meta.url).href
    const extension = await import('../src/telegram-extension.ts') as {
      readonly installTelegramExtensionFromPackageEntry?: (
        ctx: unknown,
        rawConfig: Readonly<Record<string, unknown>>,
        packageEntryUrl: string,
        clock: { readonly now: () => Date },
      ) => Promise<() => Promise<void>>
    }
    if (typeof extension.installTelegramExtensionFromPackageEntry !== 'function') {
      throw new Error('CAPABILITY_ASSERTION: private Telegram install composition seam is unavailable')
    }

    const source10Text = '我关注可靠设计。我知道幂等重试'
    expect(source10Text).toHaveLength(15)
    expect(source10Text.slice(3, 7)).toBe('可靠设计')
    expect(source10Text.slice(11, 15)).toBe('幂等重试')
    expect(source10Text.slice(0, 1)).toBe('我')
    expect(source10Text.slice(8, 9)).toBe('我')
    const attitude = {
      speaker: 'user',
      polarity: 'affirmed',
      modality: 'committed',
      attribution: 'own_statement',
      temporal: 'current',
      qualification: 'unqualified',
    }
    const source10Facts = {
      kind: 'facts',
      facts: [
        {
          lane: 'long_term_interest',
          stance: 'include',
          focusSpan: { startUtf16: 3, endUtf16: 7 },
          protectedSpans: {
            subject: [{ startUtf16: 0, endUtf16: 1 }],
            polarity: [],
            conditions: [],
            modality: [],
            attribution: [],
            temporal: [],
            applicability: [],
          },
          attitude,
          operation: 'assert',
          targetFactIds: [],
        },
        {
          lane: 'existing_knowledge',
          epistemic: 'asserted',
          focusSpan: { startUtf16: 11, endUtf16: 15 },
          protectedSpans: {
            subject: [{ startUtf16: 8, endUtf16: 9 }],
            polarity: [],
            conditions: [],
            modality: [],
            attribution: [],
            temporal: [],
            applicability: [],
          },
          attitude,
          operation: 'assert',
          targetFactIds: [],
        },
      ],
    }
    const source10Key = digest({ kind: 'telegram_inbound', chatId: 7, messageId: 10 })
    const source11Key = digest({ kind: 'telegram_inbound', chatId: 7, messageId: 11 })
    const source12Key = digest({ kind: 'telegram_inbound', chatId: 7, messageId: 12 })
    const semanticResponses: Array<{ readonly tool: string; readonly sourceKey?: string; readonly rawText: string; readonly value: unknown }> = [
      { tool: 'submit-personal-context-classification', sourceKey: source10Key, rawText: source10Text, value: source10Facts },
      { tool: 'submit-personal-context-entailment', rawText: source10Text, value: { decision: 'confirmed' } },
      { tool: 'submit-personal-context-entailment', rawText: source10Text, value: { decision: 'confirmed' } },
      { tool: 'submit-personal-context-classification', sourceKey: source11Key, rawText: '给我一次个人 Feed', value: { kind: 'no_fact', reason: 'not_personal_fact' } },
      { tool: 'submit-personal-context-no-fact', rawText: '给我一次个人 Feed', value: { decision: 'confirmed' } },
      { tool: 'submit-personal-context-classification', sourceKey: source12Key, rawText: '请求后的事实', value: { kind: 'no_fact', reason: 'not_personal_fact' } },
      { tool: 'submit-personal-context-no-fact', rawText: '请求后的事实', value: { decision: 'confirmed' } },
    ]
    let semanticCallOrdinal = 0
    const toolCallChunks = (request: GenerateOptions, value: unknown): StreamChunk[] => {
      const name = request.tools?.[0]?.name
      if (typeof name !== 'string') throw new Error('scripted semantic request has no submission tool')
      const encoded = JSON.stringify(value)
      if (encoded === undefined) throw new Error('scripted semantic response is not JSON encodable')
      const callId = CallId(`runtime-semantic-call-${semanticCallOrdinal}`)
      return [
        { type: 'block-start', index: 0, blockType: 'tool-call' },
        { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: encoded },
        { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name, arguments: encoded } },
        { type: 'finish', reason: { kind: 'tool-calls' } },
      ]
    }
    const llm = (harness.ctx as { llm: { stream: (request: GenerateOptions) => AsyncIterable<StreamChunk> } }).llm
    llm.stream = vi.fn(async function* (request: GenerateOptions): AsyncIterable<StreamChunk> {
      harness.llmRequests.push(request)
      const response = semanticResponses.shift()
      if (response === undefined) throw new Error('scripted semantic response queue exhausted')
      semanticCallOrdinal += 1
      expect(request.tools).toHaveLength(1)
      expect(request.tools?.[0]?.name).toBe(response.tool)
      const message = request.messages?.[0] as unknown as { readonly content?: readonly { readonly text?: unknown }[] } | undefined
      const userText = message?.content?.[0]?.text
      if (typeof userText !== 'string') throw new Error('scripted semantic request has no user JSON')
      const input = JSON.parse(userText) as { readonly sourceKey?: unknown; readonly rawText?: unknown; readonly fullRawText?: unknown }
      if (response.sourceKey !== undefined) expect(input.sourceKey).toBe(response.sourceKey)
      expect(input.rawText ?? input.fullRawText).toBe(response.rawText)
      for (const chunk of toolCallChunks(request, response.value)) yield chunk
    })

    const scripted = [
      '2026-09-01T15:59:59.700Z',
      '2026-09-01T15:59:59.800Z',
      '2026-09-01T15:59:59.800Z',
      '2026-09-01T15:59:59.900Z',
      '2026-09-01T15:59:59.900Z',
      '2026-09-01T15:59:59.901Z',
    ]
    let installed = false
    const clock = Object.freeze({
      now: vi.fn(() => {
        if (!installed) return new Date('2026-09-01T15:59:59.000Z')
        const value = scripted.shift()
        if (value === undefined) throw new Error('scripted clock exhausted')
        return new Date(value)
      }),
    })
    let dispose: (() => Promise<void>) | undefined
    let testCursor: { readonly close: (reason: string) => unknown } | undefined
    try {
      dispose = await extension.installTelegramExtensionFromPackageEntry(
        harness.ctx,
        config(root, join(root, 'personal-feed')),
        sourceEntry,
        clock,
      )
      installed = true
      clock.now.mockClear()
      const inbound = harness.listeners.get('telegram/inbound') ?? []
      await waterfall(inbound, envelope(source10Text, undefined, 10))
      const source10State = (ownerObserver.contextOwners[0] as { readonly read: () => unknown }).read() as {
        readonly coverage: ReadonlyArray<{ readonly sourceKey: string; readonly status: string; readonly disposition?: { readonly status?: string } }>
      }
      expect(source10State.coverage).toEqual([
        expect.objectContaining({ sourceKey: source10Key, status: 'applied', disposition: expect.objectContaining({ status: 'applied' }) }),
      ])
      expect(semanticCallOrdinal).toBe(3)
      expect(semanticResponses).toHaveLength(4)
      const feed = await waterfall(inbound, envelope('给我一次个人 Feed', undefined, 11))
      expect(semanticCallOrdinal).toBe(5)
      expect(semanticResponses).toHaveLength(2)
      const firstSnapshot = ownerObserver.contextSnapshotResults.at(-1) as {
        readonly kind?: unknown
        readonly snapshot?: { readonly proof?: { readonly currentSource?: unknown; readonly coverage?: { readonly unknownAtFenceSourceKeys?: readonly string[] } } }
      }
      expect(firstSnapshot?.kind).toBe('sufficient')
      expect(feed).toMatchObject({ kind: 'handled-awaiting-delivery', finalText: '这次没有完成：X 来源或观察窗口未完成。' })

    const request = Object.freeze({
      requestId: 'telegram:7:11',
      cutoff: '2026-09-01T15:59:59.800Z',
      shanghaiDay: '2026-09-01',
    })
    const candidate = ownerObserver.candidateOwners[0] as {
      readonly admit: (input: unknown) => Promise<{ readonly kind: string; readonly cursor?: { readonly close: (reason: string) => unknown } }>
    }
    const admission = await candidate.admit({
      request,
      window: candidateWindow(request, '2026-09-01T15:59:59.900Z'),
      signal: new AbortController().signal,
    })
    expect(admission.kind).toBe('admitted')
    testCursor = admission.cursor
    await testCursor?.close('C2 test cleanup')

    const r4 = ownerObserver.personalContextRuntimeR4[0] as {
      readonly snapshot: (input: unknown) => Promise<unknown>
    }
    expect(firstSnapshot?.kind).toBe('sufficient')
    expect(firstSnapshot?.snapshot?.proof?.currentSource).toMatchObject({ status: 'settled_for_future_request' })
    expect(firstSnapshot?.snapshot?.proof?.coverage?.unknownAtFenceSourceKeys).toEqual([])
    expect(ownerObserver.contextOwnerOptions[0]).toMatchObject({ clock })
    expect(ownerObserver.candidateFactoryOptions[0]).toMatchObject({ clock })
    expect(ownerObserver.coordinatorOptions[0]).toMatchObject({ clock })
    const state = (ownerObserver.contextOwners[0] as { readonly read: () => unknown }).read() as {
      readonly sources: ReadonlyArray<{ readonly sourceKey: string; readonly occurredAt: string }>
      readonly coverage: ReadonlyArray<{ readonly sourceKey: string; readonly status: string; readonly disposition?: { readonly status?: string } }>
    }
    const currentSources = state.sources.filter(source => source.sourceKey === source10Key || source.sourceKey === source11Key)
    expect(currentSources.map(source => source.occurredAt)).toEqual([
      '2026-09-01T15:59:59.700Z',
      '2026-09-01T15:59:59.800Z',
    ])
    expect(currentSources.every(source => Date.parse(source.occurredAt) <= Date.parse(request.cutoff))).toBe(true)
    expect(state.coverage.filter(coverage => coverage.sourceKey === source10Key || coverage.sourceKey === source11Key)).toEqual([
      expect.objectContaining({ sourceKey: source10Key, status: 'applied', disposition: expect.objectContaining({ status: 'applied' }) }),
      expect.objectContaining({ sourceKey: source11Key, status: 'ignored', disposition: expect.objectContaining({ status: 'ignored' }) }),
    ])

    const ledgerPath = join(root, 'personal-feed', 'v2', 'requests.jsonl')
    const opened = readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
      .find(record => record.event === 'request_opened')
    expect(opened).toMatchObject({
      requestId: 'telegram:7:11',
      request: { cutoff: request.cutoff, shanghaiDay: request.shanghaiDay },
    })

    await waterfall(inbound, envelope('请求后的事实', undefined, 12))
    const laterSnapshot = await r4.snapshot({ request, signal: new AbortController().signal }) as {
      readonly kind?: unknown
      readonly snapshot?: { readonly proof?: { readonly coverage?: { readonly includedTerminalSources?: ReadonlyArray<{ readonly sourceKey: string }>; readonly unknownAtFenceSourceKeys?: readonly string[] } } }
    }
    const futureSourceKey = source12Key
    expect(laterSnapshot.kind).toBe('sufficient')
    expect(laterSnapshot.snapshot?.proof?.coverage?.includedTerminalSources?.map(source => source.sourceKey) ?? []).not.toContain(futureSourceKey)
    expect(laterSnapshot.snapshot?.proof?.coverage?.unknownAtFenceSourceKeys ?? []).not.toContain(futureSourceKey)
    expect(ownerObserver.contextSnapshotResults).toHaveLength(2)
    expect(clock.now.mock.calls.length).toBe(6)
    expect(semanticCallOrdinal).toBe(7)
    expect(semanticResponses).toEqual([])
    } finally {
      await testCursor?.close('C2 test cleanup retry')
      await dispose?.().catch(() => undefined)
    }
  })
})

type SeamOwner = {
  readonly capture: ReturnType<typeof vi.fn>
  readonly read: ReturnType<typeof vi.fn>
  readonly settle: ReturnType<typeof vi.fn>
  readonly freezeFence: ReturnType<typeof vi.fn>
  readonly snapshot: ReturnType<typeof vi.fn>
  readonly close: ReturnType<typeof vi.fn>
}

type RuntimeSeam = {
  readonly r4: { readonly snapshot: (input: unknown) => unknown | Promise<unknown> }
  readonly shutdown: () => Promise<void>
  readonly registerSourceFirst: (
    ctx: { readonly on: (name: string, listener: Listener, options?: { readonly prepend?: boolean }) => () => void },
    options: { readonly personalFeedHandler: (envelope: TelegramInboundEnvelope) => Promise<TelegramInboundResult> },
  ) => () => void
}

type RuntimeSeamFactory = (options: {
  readonly owner: unknown
  readonly semanticLifecycle: { readonly shutdown: () => Promise<void> }
}) => RuntimeSeam

async function loadRuntimeSeam(): Promise<RuntimeSeamFactory> {
  const module = await import('../src/personal-feed/personal-context-telegram-runtime.ts') as {
    readonly createPersonalContextTelegramRuntime?: RuntimeSeamFactory
  }
  if (typeof module.createPersonalContextTelegramRuntime !== 'function') {
    throw new Error('personal context Telegram runtime seam is unavailable')
  }
  return module.createPersonalContextTelegramRuntime
}

const noopPersonalFeedHandler = async (): Promise<TelegramInboundResult> => ({ kind: 'handled', finalText: '' })

function source(chatId: number, messageId: number, captureSequence: number, sourceKey = `telegram:${chatId}:${messageId}`): Record<string, unknown> {
  return {
    locator: { kind: 'telegram_inbound', chatId, messageId },
    rawText: `正文-${messageId}`,
    reference: null,
    occurredAt: '2026-08-31T16:00:00.000Z',
    sourceKey,
    captureSequence,
  }
}

function pending(sourceKey: string): Record<string, unknown> { return { sourceKey, status: 'pending' } }
function terminal(sourceKey: string): Record<string, unknown> { return { sourceKey, status: 'ignored', disposition: { schemaVersion: 2, status: 'ignored', reason: 'not_personal_fact' }, terminalTransactionSequence: 1, dispositionDigest: 'd'.repeat(64), revisionDigest: 'r'.repeat(64) } }

function ownerFixture(values: {
  readonly sources: readonly Record<string, unknown>[]
  readonly coverage: readonly Record<string, unknown>[]
  readonly capture?: (input: Record<string, unknown>) => { readonly source: Record<string, unknown>; readonly coverage: Record<string, unknown> }
  readonly settle?: (sourceKey: string) => unknown | Promise<unknown>
  readonly snapshot?: (input: unknown) => unknown
}): SeamOwner {
  return {
    capture: vi.fn(values.capture ?? ((input: Record<string, unknown>) => ({ source: { ...source(7, 11, 4), rawText: input.rawText, sourceKey: 'telegram:7:11' }, coverage: pending('telegram:7:11') }))),
    read: vi.fn(() => ({ sources: values.sources, coverage: values.coverage })),
    settle: vi.fn(async (input: { readonly sourceKey: string }) => values.settle?.(input.sourceKey) ?? terminal(input.sourceKey)),
    freezeFence: vi.fn(() => ({ requestId: 'telegram:7:11', cutoff: '2026-08-31T16:00:00.000Z', shanghaiDay: '2026-09-01' })),
    snapshot: vi.fn((input: unknown) => values.snapshot?.(input) ?? { kind: 'unknown', reason: 'unknown_at_fence' }),
    close: vi.fn(),
  }
}

function seamContext(): { readonly ctx: { readonly on: (name: string, listener: Listener, options?: { readonly prepend?: boolean }) => () => void }; readonly listeners: Listener[] } {
  const listeners: Listener[] = []
  return {
    listeners,
    ctx: {
      on: (_name, listener, options) => {
        if (options?.prepend === true) listeners.unshift(listener)
        else listeners.push(listener)
        return () => {
          const index = listeners.indexOf(listener)
          if (index >= 0) listeners.splice(index, 1)
        }
      },
    },
  }
}

function runWaterfall(listeners: readonly Listener[], value: TelegramInboundEnvelope, root: () => TelegramInboundResult = () => ({ kind: 'root-delivered' })): Promise<TelegramInboundResult> {
  let index = 0
  const next = (): TelegramInboundResult | Promise<TelegramInboundResult> => {
    const listener = listeners[index++]
    return listener === undefined ? root() : listener(value, next)
  }
  return Promise.resolve(next())
}

describe('Personal Context Telegram package-private runtime seam (RED)', () => {
  it('joins source and R4 owner operations behind one shutdown Promise while semantic cleanup may reject first', async () => {
    const factory = await loadRuntimeSeam()
    const semanticError = new Error('semantic cleanup failed')
    const settleError = new Error('owner settle failed')
    const snapshotError = new Error('owner snapshot failed')
    let releaseSettle: (() => void) | undefined
    let releaseSnapshot: (() => void) | undefined
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    const owner = ownerFixture({
      sources: [source(7, 11, 1)],
      coverage: [pending('telegram:7:11')],
      capture: input => ({ source: { ...source(7, 11, 1), rawText: input.rawText }, coverage: pending('telegram:7:11') }),
      settle: () => new Promise<never>((_resolve, reject) => {
        releaseSettle = () => { reject(settleError) }
      }),
      snapshot: () => new Promise<never>((_resolve, reject) => {
        releaseSnapshot = () => { reject(snapshotError) }
      }),
    })
    const semanticShutdown = vi.fn(async () => { throw semanticError })
    try {
      const runtime = factory({ owner, semanticLifecycle: { shutdown: semanticShutdown } })
      const harness = seamContext()
      const sourceDispose = runtime.registerSourceFirst(harness.ctx, { personalFeedHandler: noopPersonalFeedHandler })
      const sourceRun = runWaterfall(harness.listeners, envelope('普通消息'))
      const r4Run = runtime.r4.snapshot({
        request: { requestId: 'r4-pending', cutoff: '2026-08-31T16:00:00.000Z', shanghaiDay: '2026-09-01' },
        signal: new AbortController().signal,
      })
      void sourceRun.catch(() => undefined)
      void (r4Run as Promise<unknown>).catch(() => undefined)
      await Promise.resolve()
      expect(owner.capture).toHaveBeenCalledOnce()
      expect(owner.read).toHaveBeenCalledOnce()
      expect(owner.settle).toHaveBeenCalledOnce()
      expect(owner.freezeFence).toHaveBeenCalledOnce()
      expect(owner.snapshot).toHaveBeenCalledOnce()

      const shutdown = runtime.shutdown()
      expect(runtime.shutdown()).toBe(shutdown)
      expect(semanticShutdown).toHaveBeenCalledOnce()
      sourceDispose()
      expect(harness.listeners).toEqual([])
      await Promise.resolve()
      expect(owner.close).not.toHaveBeenCalled()

      const captureCalls = owner.capture.mock.calls.length
      const freezeCalls = owner.freezeFence.mock.calls.length
      const afterShutdown = await runtime.r4.snapshot({
        request: { requestId: 'after-shutdown', cutoff: '2026-08-31T16:00:00.000Z', shanghaiDay: '2026-09-01' },
        signal: new AbortController().signal,
      })
      expect(afterShutdown).toMatchObject({ kind: 'unknown' })
      expect(owner.capture).toHaveBeenCalledTimes(captureCalls)
      expect(owner.freezeFence).toHaveBeenCalledTimes(freezeCalls)
      expect(releaseSettle).toBeDefined()
      expect(releaseSnapshot).toBeDefined()
      releaseSnapshot?.()
      releaseSettle?.()
      await sourceRun
      await expect(r4Run).rejects.toBe(snapshotError)
      await expect(shutdown).rejects.toThrow()
      expect(semanticError).toBeInstanceOf(Error)
      expect(settleError).toBeInstanceOf(Error)
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
      releaseSettle?.()
      releaseSnapshot?.()
    }
  })

  it('A drains each pending source exactly once in capture order through current and never touches terminal/later sources', async () => {
    const factory = await loadRuntimeSeam()
    const sourceA = source(7, 10, 1)
    const sourceB = source(7, 11, 2)
    const sourceC = source(7, 12, 3)
    const sourceD = source(7, 14, 4)
    const sourceE = source(7, 15, 5)
    const events: string[] = []
    const owner = ownerFixture({
      sources: [sourceE, sourceC, sourceB, sourceD, sourceA],
      coverage: [pending(sourceD.sourceKey as string), terminal(sourceB.sourceKey as string), pending(sourceE.sourceKey as string), pending(sourceA.sourceKey as string), pending(sourceC.sourceKey as string)],
      capture: input => {
        events.push(`capture ${sourceD.sourceKey}`)
        return { source: { ...sourceD, rawText: input.rawText }, coverage: pending(sourceD.sourceKey as string) }
      },
      settle: sourceKey => { events.push(`settle ${sourceKey}`); return terminal(sourceKey) },
    })
    owner.read.mockImplementation(() => { events.push('read'); return { sources: [sourceE, sourceC, sourceB, sourceD, sourceA], coverage: [pending(sourceD.sourceKey as string), terminal(sourceB.sourceKey as string), pending(sourceE.sourceKey as string), pending(sourceA.sourceKey as string), pending(sourceC.sourceKey as string)] } })
    const runtime = factory({ owner })
    const harness = seamContext()
    harness.ctx.on('telegram/inbound', vi.fn((_value: TelegramInboundEnvelope, next: () => TelegramInboundResult) => { events.push('downstream'); return next() }))
    const dispose = runtime.registerSourceFirst(harness.ctx, { personalFeedHandler: noopPersonalFeedHandler })

    await runWaterfall(harness.listeners, envelope('普通消息', undefined, 14))
    expect(owner.read).toHaveBeenCalledOnce()
    expect(events).toEqual([
      'capture telegram:7:14',
      'read',
      'settle telegram:7:10',
      'settle telegram:7:12',
      'settle telegram:7:14',
      'downstream',
    ])
    expect(owner.settle).toHaveBeenCalledTimes(3)
    expect(owner.settle.mock.calls.map(call => (call[0] as { readonly sourceKey: string }).sourceKey)).toEqual([
      'telegram:7:10', 'telegram:7:12', 'telegram:7:14',
    ])
    dispose()
  })

  it.each([
    ['pending', () => ({ sourceKey: 'telegram:7:10', status: 'pending', reason: 'semantics_unavailable' })],
    ['throw', () => { throw new Error('settle failed') }],
  ] as const)('B/C stop the semantic drain after the first %s barrier but continue ordinary downstream', async (_name, result) => {
    const factory = await loadRuntimeSeam()
    const owner = ownerFixture({
      sources: [source(7, 10, 1), source(7, 11, 2)],
      coverage: [pending('telegram:7:10'), pending('telegram:7:11')],
      capture: input => ({ source: { ...source(7, 11, 2), rawText: input.rawText }, coverage: pending('telegram:7:11') }),
      settle: sourceKey => sourceKey === 'telegram:7:10' ? result() : terminal(sourceKey),
    })
    const runtime = factory({ owner })
    const harness = seamContext()
    const downstream = vi.fn((_value: TelegramInboundEnvelope, next: () => TelegramInboundResult) => next())
    harness.ctx.on('telegram/inbound', downstream)
    const dispose = runtime.registerSourceFirst(harness.ctx, { personalFeedHandler: noopPersonalFeedHandler })

    await runWaterfall(harness.listeners, envelope('普通消息'))
    expect(owner.read).toHaveBeenCalledOnce()
    expect(owner.settle).toHaveBeenCalledTimes(1)
    expect(downstream).toHaveBeenCalledOnce()
    dispose()
  })

  it.each([
    ['sufficient', { kind: 'sufficient', snapshot: { lane: 'fixture' } }],
    ['insufficient', { kind: 'insufficient', reason: 'no_active_include' }],
    ['unknown', { kind: 'unknown', reason: 'coverage_incomplete' }],
  ] as const)('R4 preserves the owner %s result and freezes the request fence before snapshot', async (_name, expected) => {
    const factory = await loadRuntimeSeam()
    const events: string[] = []
    const owner = ownerFixture({
      sources: [], coverage: [],
      snapshot: () => { events.push('snapshot'); return expected },
    })
    owner.freezeFence.mockImplementation(() => { events.push('freezeFence'); return { requestId: 'telegram:7:11', cutoff: '2026-08-31T16:00:00.000Z', shanghaiDay: '2026-09-01' } })
    const runtime = factory({ owner })
    const result = await runtime.r4.snapshot({ request: { requestId: 'telegram:7:11', cutoff: '2026-08-31T16:00:00.000Z', shanghaiDay: '2026-09-01' }, signal: new AbortController().signal })

    expect(events).toEqual(['freezeFence', 'snapshot'])
    expect(result).toEqual(expected)
  })

  it('R4 lets an owner throw continue throwing instead of inventing a normalized result', async () => {
    const factory = await loadRuntimeSeam()
    const owner = ownerFixture({ sources: [], coverage: [] })
    owner.snapshot.mockImplementation(() => { throw new Error('snapshot unavailable') })
    const runtime = factory({ owner })
    await expect(runtime.r4.snapshot({ request: { requestId: 'telegram:7:11', cutoff: '2026-08-31T16:00:00.000Z', shanghaiDay: '2026-09-01' }, signal: new AbortController().signal })).rejects.toThrow('snapshot unavailable')
  })

  it.each(['insufficient', 'unknown', 'throw'] as const)('real coordinator maps R4 %s to exact personal_context incomplete without invoking later lanes', async mode => {
    const factory = await loadRuntimeSeam()
    const personalFeed = await import('@herman/personal-feed')
    const directory = mkdtempSync(join(tmpdir(), 'personal-context-runtime-r4-'))
    temporaryDirectories.push(directory)
    const owner = ownerFixture({ sources: [], coverage: [] })
    if (mode === 'unknown') owner.snapshot.mockReturnValue({ kind: 'unknown', reason: 'coverage_incomplete' })
    if (mode === 'insufficient') owner.snapshot.mockReturnValue({ kind: 'insufficient', reason: 'no_active_include' })
    if (mode === 'throw') owner.snapshot.mockImplementation(() => { throw new Error('snapshot unavailable') })
    const runtime = factory({ owner })
    const calls = { r2: 0, r3: 0, r5: 0 }
    const coordinator = personalFeed.createPersonalFeedV2RequestCoordinator({
      ledgerPath: join(directory, 'requests.jsonl'),
      clock: { now: () => new Date('2026-08-31T16:00:00.000Z') },
      r4: runtime.r4,
      r2: { observe: async () => { calls.r2 += 1; return { kind: 'complete' as const, window: {} } } },
      r3: { admit: async () => { calls.r3 += 1; return { kind: 'admitted' as const, cursor: { borrowCurrent: async () => ({ kind: 'done' as const }), finalize: async () => ({ kind: 'incomplete' as const, reason: 'failed' as const }), close: async () => undefined } } } },
      r5: { judge: async () => { calls.r5 += 1; return { kind: 'none' as const, completed: Object.freeze([]) } } },
    })
    const result = await coordinator.prepare({ chatId: 7, messageId: 11, signal: new AbortController().signal })
    expect(result).toMatchObject({ kind: 'prepared', outcome: { kind: 'incomplete', category: 'personal_context', finalText: '这次没有完成：个人语境不足或未完成。' } })
    expect(owner.freezeFence).toHaveBeenCalledOnce()
    expect(owner.snapshot).toHaveBeenCalledOnce()
    expect(calls).toEqual({ r2: 0, r3: 0, r5: 0 })
  })

  it.each(['coverage-missing', 'read-throws'] as const)('treats %s as the same drain barrier as pending/throw and still continues ordinary downstream', async mode => {
    const factory = await loadRuntimeSeam()
    const owner = ownerFixture({
      sources: [source(7, 10, 1), source(7, 11, 2)],
      coverage: mode === 'coverage-missing' ? [pending('telegram:7:10')] : [pending('telegram:7:10'), pending('telegram:7:11')],
      capture: input => ({ source: { ...source(7, 11, 2), rawText: input.rawText }, coverage: pending('telegram:7:11') }),
    })
    if (mode === 'read-throws') owner.read.mockImplementation(() => { throw new Error('owner read failed') })
    const runtime = factory({ owner })
    const harness = seamContext()
    const downstream = vi.fn((_value: TelegramInboundEnvelope, next: () => TelegramInboundResult) => next())
    harness.ctx.on('telegram/inbound', downstream)
    const dispose = runtime.registerSourceFirst(harness.ctx, { personalFeedHandler: noopPersonalFeedHandler })
    await runWaterfall(harness.listeners, envelope('普通消息'))

    expect(owner.read).toHaveBeenCalledOnce()
    if (mode === 'coverage-missing') expect(owner.settle).toHaveBeenCalledOnce()
    else expect(owner.settle).not.toHaveBeenCalled()
    expect(downstream).toHaveBeenCalledOnce()
    dispose()
  })

  it('F keeps a completed SQLite bootstrap checkpoint restartable without session history reads', async () => {
    const factory = await loadRuntimeSeam()
    const personalFeed = await import('@herman/personal-feed')
    const directory = mkdtempSync(join(tmpdir(), 'personal-context-runtime-restart-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'v2', 'personal-context.sqlite')
    const historyCalls: string[] = []
    const historyQuery = {
      listEvents: vi.fn(async () => { historyCalls.push('list'); return [] }),
      readEvent: vi.fn(async () => { historyCalls.push('read'); return undefined }),
    }
    const history = personalFeed.createSessionUserHistoryAdapter({
      sessionId: 'session-telegram',
      sessionQuery: historyQuery,
    })
    const semantics = {
      classifier: () => ({ kind: 'no_fact' as const, reason: 'not_personal_fact' as const }),
      entailmentValidator: () => ({ kind: 'target_and_revision_confirmed' as const }),
      noFactValidator: () => ({ kind: 'confirmed_no_fact' as const }),
    }
    const first = personalFeed.createPersonalContextOwner({ databasePath, clock: { now: () => new Date('2026-08-31T16:00:00.000Z') }, semantics })
    const firstBootstrap = await first.bootstrap({ history })
    expect(firstBootstrap).toMatchObject({ status: 'complete' })
    expect(historyCalls).toEqual(['list', 'list'])
    const oldCapture = first.capture({ locator: { kind: 'telegram_inbound', chatId: 7, messageId: 10 }, rawText: '旧 A', reference: null })
    expect(first.read().coverage).toEqual([expect.objectContaining({ sourceKey: oldCapture.source.sourceKey, status: 'pending' })])
    first.close()
    historyCalls.splice(0)

    const reopened = personalFeed.createPersonalContextOwner({ databasePath, clock: { now: () => new Date('2026-08-31T16:00:00.000Z') }, semantics })
    const reopenedBootstrap = await reopened.bootstrap({ history })
    expect(reopenedBootstrap).toMatchObject({ status: 'complete' })
    expect(historyCalls).toEqual([])
    expect(historyQuery.listEvents).toHaveBeenCalledTimes(2)
    expect(historyQuery.readEvent).not.toHaveBeenCalled()
    const events: string[] = []
    const owner = {
      ...reopened,
      capture: (input: Parameters<typeof reopened.capture>[0]) => { events.push('capture B'); return reopened.capture(input) },
      read: () => { events.push('read'); return reopened.read() },
      settle: async (input: Parameters<typeof reopened.settle>[0]) => { events.push(`settle ${input.sourceKey}`); return reopened.settle(input) },
    }
    const runtime = factory({ owner })
    const harness = seamContext()
    harness.ctx.on('telegram/inbound', vi.fn((_value: TelegramInboundEnvelope, next: () => TelegramInboundResult) => {
      events.push('old X')
      return next()
    }))
    const dispose = runtime.registerSourceFirst(harness.ctx, { personalFeedHandler: noopPersonalFeedHandler })
    await runWaterfall(harness.listeners, envelope('普通消息'), () => {
      events.push('root')
      return { kind: 'root-delivered' }
    })

    const currentSourceKey = digest({ kind: 'telegram_inbound', chatId: 7, messageId: 11 })
    expect(events).toEqual(['capture B', 'read', `settle ${oldCapture.source.sourceKey}`, `settle ${currentSourceKey}`, 'old X', 'root'])
    expect(historyCalls).toEqual([])
    dispose()
    reopened.close()
  })

  it('D lets old X continue while an old pending source blocks Feed: current is not settled and the shared handler owns the sole personal-context incomplete result', async () => {
    const factory = await loadRuntimeSeam()
    const personalFeed = await import('@herman/personal-feed')
    const adapter = await import('../src/personal-feed/telegram-adapter.ts') as {
      readonly createPersonalFeedTelegramRequestHandler?: (options: { readonly coordinator: unknown }) =>
        (envelope: TelegramInboundEnvelope) => Promise<TelegramInboundResult>
      readonly registerPersonalFeedTelegramAdapter?: (
        ctx: { readonly on: (name: string, listener: Listener, options?: { readonly prepend?: boolean }) => () => void },
        options: { readonly coordinator: unknown },
      ) => () => void
    }
    if (typeof adapter.createPersonalFeedTelegramRequestHandler !== 'function'
      || typeof adapter.registerPersonalFeedTelegramAdapter !== 'function') throw new Error('shared handler is unavailable')
    const directory = mkdtempSync(join(tmpdir(), 'personal-context-runtime-d-'))
    temporaryDirectories.push(directory)
    const calls = { r2: 0, r3: 0, r5: 0 }
    const owner = ownerFixture({
      sources: [source(7, 10, 1), source(7, 11, 2)],
      coverage: [pending('telegram:7:10'), pending('telegram:7:11')],
      settle: sourceKey => ({ sourceKey, status: 'pending', reason: 'semantics_unavailable' }),
    })
    const runtime = factory({ owner })
    const coordinator = personalFeed.createPersonalFeedV2RequestCoordinator({
      ledgerPath: join(directory, 'requests.jsonl'),
      clock: { now: () => new Date('2026-08-31T16:00:00.000Z') },
      r4: runtime.r4,
      r2: { observe: async () => { calls.r2 += 1; return { kind: 'complete' as const, window: {} } } },
      r3: { admit: async () => { calls.r3 += 1; return { kind: 'admitted' as const, cursor: { borrowCurrent: async () => ({ kind: 'done' as const }), finalize: async () => ({ kind: 'incomplete' as const, reason: 'failed' as const }), close: async () => undefined } } } },
      r5: { judge: async () => { calls.r5 += 1; return { kind: 'none' as const, completed: Object.freeze([]) } } },
    })
    const captureFailureHandler = vi.fn(adapter.createPersonalFeedTelegramRequestHandler({ coordinator }))
    const harness = seamContext()
    const oldX = vi.fn((_value: TelegramInboundEnvelope, next: () => TelegramInboundResult) => next())
    const stopOldX = harness.ctx.on('telegram/inbound', oldX)
    const dispose = runtime.registerSourceFirst(harness.ctx, { personalFeedHandler: captureFailureHandler })
    const stopPersonalFeed = adapter.registerPersonalFeedTelegramAdapter(harness.ctx, { coordinator })

    const result = await runWaterfall(harness.listeners, envelope('给我一次个人 Feed'))
    expect(result).toMatchObject({ kind: 'handled-awaiting-delivery', finalText: '这次没有完成：个人语境不足或未完成。' })
    expect(owner.read).toHaveBeenCalledOnce()
    expect(owner.settle).toHaveBeenCalledTimes(1)
    expect(captureFailureHandler).not.toHaveBeenCalled()
    expect(oldX).toHaveBeenCalledOnce()
    expect(owner.freezeFence).toHaveBeenCalledOnce()
    expect(owner.snapshot).toHaveBeenCalledOnce()
    if (result.kind !== 'handled-awaiting-delivery') throw new Error('Feed result was not deliverable')
    result.settle({ chatId: 7, triggerMessageId: 11, visibleText: result.finalText, messageIds: [901] })
    expect(coordinator.read('telegram:7:11')).toMatchObject({ status: 'delivered', outcome: { category: 'personal_context' } })
    expect(calls).toEqual({ r2: 0, r3: 0, r5: 0 })
    stopPersonalFeed()
    dispose()
    stopOldX()
  })

  it('E settles old and current before the first Feed fence, preserves the future-only proof, then exposes that fact to a real later request', async () => {
    const factory = await loadRuntimeSeam()
    const personalFeed = await import('@herman/personal-feed')
    const adapter = await import('../src/personal-feed/telegram-adapter.ts') as {
      readonly createPersonalFeedTelegramRequestHandler?: (options: { readonly coordinator: unknown }) =>
        (envelope: TelegramInboundEnvelope) => Promise<TelegramInboundResult>
      readonly registerPersonalFeedTelegramAdapter?: (
        ctx: { readonly on: (name: string, listener: Listener, options?: { readonly prepend?: boolean }) => () => void },
        options: { readonly coordinator: unknown },
      ) => () => void
    }
    if (typeof adapter.createPersonalFeedTelegramRequestHandler !== 'function'
      || typeof adapter.registerPersonalFeedTelegramAdapter !== 'function') throw new Error('shared handler is unavailable')
    const directory = mkdtempSync(join(tmpdir(), 'personal-context-runtime-e-'))
    temporaryDirectories.push(directory)
    const sourceA = source(7, 10, 1)
    const currentSource = source(7, 11, 2)
    const laterSource = source(7, 12, 3)
    const firstSnapshot = {
      kind: 'sufficient' as const,
      snapshot: {
        longTermInterest: { activeFacts: [] },
        existingKnowledge: { activeFacts: [] },
        proof: { currentSource: { status: 'settled_for_future_request' } },
      },
    }
    const secondSnapshot = {
      kind: 'sufficient' as const,
      snapshot: {
        longTermInterest: { activeFacts: [{ factId: 'fact-from-current' }] },
        existingKnowledge: { activeFacts: [] },
        proof: { currentSource: { status: 'current_request' } },
      },
    }
    const order: string[] = []
    const captures: Record<string, unknown>[] = []
    let requestCount = 0
    const owner: SeamOwner = {
      capture: vi.fn((input: Record<string, unknown>) => {
        captures.push(input)
        requestCount += 1
        const current = requestCount === 1 ? currentSource : laterSource
        order.push(`capture ${current.sourceKey}`)
        return { source: { ...current, rawText: input.rawText }, coverage: pending(current.sourceKey as string) }
      }),
      read: vi.fn(() => {
        order.push('read')
        return requestCount === 1
          ? { sources: [currentSource, sourceA], coverage: [pending(currentSource.sourceKey as string), pending(sourceA.sourceKey as string)] }
          : { sources: [laterSource, currentSource, sourceA], coverage: [pending(laterSource.sourceKey as string), terminal(currentSource.sourceKey as string), terminal(sourceA.sourceKey as string)] }
      }),
      settle: vi.fn(async (input: { readonly sourceKey: string }) => {
        order.push(`settle ${input.sourceKey}`)
        return terminal(input.sourceKey)
      }),
      freezeFence: vi.fn((input: { readonly request: { readonly requestId: string } }) => {
        order.push('freezeFence')
        return { schemaVersion: 1, requestId: input.request.requestId, cutoff: '2026-08-31T16:00:00.000Z', shanghaiDay: '2026-09-01', storeId: 'fixture-store', maxCaptureSequence: 3, maxTerminalTransactionSequence: 2, digest: 'd'.repeat(64) }
      }),
      snapshot: vi.fn((input: { readonly fence: { readonly requestId: string } }) => {
        order.push('snapshot')
        return input.fence.requestId === 'telegram:7:11' ? firstSnapshot : secondSnapshot
      }),
      close: vi.fn(),
    }
    const runtime = factory({ owner })
    const calls = { r2: 0, r3: 0, r5: 0 }
    const r4Results: unknown[] = []
    const coordinator = personalFeed.createPersonalFeedV2RequestCoordinator({
      ledgerPath: join(directory, 'requests.jsonl'),
      clock: { now: () => new Date('2026-08-31T16:00:00.000Z') },
      r4: { snapshot: async input => { const result = await runtime.r4.snapshot(input); r4Results.push(result); return result } },
      r2: { observe: async () => { calls.r2 += 1; return { kind: 'partial' as const } } },
      r3: { admit: async () => { calls.r3 += 1; return { kind: 'admitted' as const, cursor: { borrowCurrent: async () => ({ kind: 'done' as const }), finalize: async () => ({ kind: 'incomplete' as const, reason: 'failed' as const }), close: async () => undefined } } } },
      r5: { judge: async () => { calls.r5 += 1; return { kind: 'none' as const, completed: Object.freeze([]) } } },
    })
    const captureFailureHandler = vi.fn(adapter.createPersonalFeedTelegramRequestHandler({ coordinator }))
    const adapterCoordinator = {
      prepare: async (input: Parameters<typeof coordinator.prepare>[0]) => {
        order.push('R1')
        return coordinator.prepare(input)
      },
    }
    const harness = seamContext()
    const stopOldX = harness.ctx.on('telegram/inbound', vi.fn((_value: TelegramInboundEnvelope, next: () => TelegramInboundResult) => { order.push('old X'); return next() }))
    const dispose = runtime.registerSourceFirst(harness.ctx, { personalFeedHandler: captureFailureHandler })
    const stopPersonalFeed = adapter.registerPersonalFeedTelegramAdapter(harness.ctx, { coordinator: adapterCoordinator })

    const first = await runWaterfall(harness.listeners, envelope('给我一次个人 Feed'))
    expect(first).toMatchObject({ kind: 'handled-awaiting-delivery', finalText: '这次没有完成：X 来源或观察窗口未完成。' })
    expect(captures[0]).toMatchObject({ rawText: '给我一次个人 Feed', reference: null, excludedRequestId: 'telegram:7:11' })
    expect(owner.read).toHaveBeenCalledOnce()
    expect(order).toEqual(['capture telegram:7:11', 'read', 'settle telegram:7:10', 'settle telegram:7:11', 'old X', 'R1', 'freezeFence', 'snapshot'])
    expect(r4Results[0]).toBe(firstSnapshot)
    expect(owner.snapshot.mock.calls[0]?.[0]).toMatchObject({ fence: { requestId: 'telegram:7:11', cutoff: '2026-08-31T16:00:00.000Z', shanghaiDay: '2026-09-01' } })
    expect(firstSnapshot.snapshot.longTermInterest.activeFacts).not.toContainEqual(expect.objectContaining({ factId: 'fact-from-current' }))
    expect(firstSnapshot.snapshot.existingKnowledge.activeFacts).not.toContainEqual(expect.objectContaining({ factId: 'fact-from-current' }))
    expect(firstSnapshot.snapshot.proof.currentSource.status).toBe('settled_for_future_request')
    if (first.kind !== 'handled-awaiting-delivery') throw new Error('first Feed result was not deliverable')
    first.settle({ chatId: 7, triggerMessageId: 11, visibleText: first.finalText, messageIds: [901] })
    expect(coordinator.read('telegram:7:11')).toMatchObject({ status: 'delivered' })

    const second = await runWaterfall(harness.listeners, envelope('给我一次个人 Feed', undefined, 12))
    expect(second).toMatchObject({ kind: 'handled-awaiting-delivery', finalText: '这次没有完成：X 来源或观察窗口未完成。' })
    expect(captures[1]).toMatchObject({ rawText: '给我一次个人 Feed', reference: null, excludedRequestId: 'telegram:7:12' })
    expect(owner.read).toHaveBeenCalledTimes(2)
    expect(owner.settle).toHaveBeenCalledTimes(3)
    expect(secondSnapshot.snapshot.longTermInterest.activeFacts).toEqual([{ factId: 'fact-from-current' }])
    expect(order.slice(8)).toEqual(['capture telegram:7:12', 'read', 'settle telegram:7:12', 'old X', 'R1', 'freezeFence', 'snapshot'])
    expect(r4Results[1]).toBe(secondSnapshot)
    expect(owner.snapshot.mock.calls[1]?.[0]).toMatchObject({ fence: { requestId: 'telegram:7:12', cutoff: '2026-08-31T16:00:00.000Z', shanghaiDay: '2026-09-01' } })
    expect(captureFailureHandler).not.toHaveBeenCalled()
    expect(calls).toEqual({ r2: 2, r3: 0, r5: 0 })
    stopPersonalFeed()
    dispose()
    stopOldX()
  })
})
