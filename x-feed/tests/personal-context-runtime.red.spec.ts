import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TelegramInboundEnvelope, TelegramInboundResult } from '@deepseek-ai/dsh-telegram-gateway'
import { installTelegramExtension } from '../src/index.ts'

const ownerObserver = vi.hoisted(() => ({ closeCount: 0, events: [] as string[] }))

vi.mock('@herman/personal-feed', async importOriginal => {
  const actual = await importOriginal<typeof import('@herman/personal-feed')>()
  return {
    ...actual,
    createPersonalContextOwner: (...args: Parameters<typeof actual.createPersonalContextOwner>) => {
      const owner = actual.createPersonalContextOwner(...args)
      return Object.freeze({
        ...owner,
        close: (): void => {
          ownerObserver.closeCount += 1
          ownerObserver.events.push('owner.close')
          owner.close()
        },
      })
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
      if (options.historyFailure !== undefined) throw options.historyFailure
      if (options.historyIncomplete === true) return { corrupt: true }
      return []
    }),
    readEvent: vi.fn(async (_input: unknown) => {
      historyCalls.push('read')
      timeline.push('history:read')
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

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
  ownerObserver.closeCount = 0
  ownerObserver.events.length = 0
  vi.restoreAllMocks()
})

describe('Personal Context Telegram runtime composition (RED)', () => {
  it('requires a reliable sessionQuery before installing any listener while the resolved data directory default remains usable', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'x-feed-runtime-missing-dependency-'))
    temporaryDirectories.push(dataDir)
    const missingHistory = emptyHistoryHarness({ withoutHistory: true })

    await expect(installTelegramExtension(missingHistory.ctx as never, { dataDir, personalFeedDataDir: join(dataDir, 'personal-feed') }))
      .rejects.toThrow()
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
    expect(harness.listeners.get('telegram/inbound') ?? []).toEqual([])
    expect(harness.registration).not.toContain('telegram/inbound')
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
      r3: { admit: async () => { calls.r3 += 1; return { kind: 'admitted' as const, candidates: [] } } },
      r5: { judge: async () => { calls.r5 += 1; return { kind: 'none' as const } } },
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
      r3: { admit: async () => { calls.r3 += 1; return { kind: 'admitted' as const, candidates: [] } } },
      r5: { judge: async () => { calls.r5 += 1; return { kind: 'none' as const } } },
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
      r3: { admit: async () => { calls.r3 += 1; return { kind: 'admitted' as const, candidates: [] } } },
      r5: { judge: async () => { calls.r5 += 1; return { kind: 'none' as const } } },
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
      r3: { admit: async () => { calls.r3 += 1; return { kind: 'admitted' as const, candidates: [] } } },
      r5: { judge: async () => { calls.r5 += 1; return { kind: 'none' as const } } },
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
