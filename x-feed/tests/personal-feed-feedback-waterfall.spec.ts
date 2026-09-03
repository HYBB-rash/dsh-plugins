import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type {
  TelegramInboundEnvelope,
  TelegramInboundResult,
} from '@deepseek-ai/dsh-telegram-gateway'
import {
  registerTelegramFeedbackAdapter,
  type TelegramFeedbackAdapterDependencies,
} from '../src/x-feedback/telegram-adapter.ts'
import { InMemoryPendingStore } from '../src/x-feedback/pending-store.ts'
import {
  createPersonalFeedTelegramRequestHandler,
  registerPersonalFeedTelegramAdapter,
} from '../src/personal-feed/telegram-adapter.ts'
import { createPersonalContextTelegramRuntime } from '../src/personal-feed/personal-context-telegram-runtime.ts'
import type { FeedbackUseCaseResult } from '../src/x-feedback/use-case.ts'

const signal = new AbortController().signal
const personalFeedText = 'https://x.com/reader/status/42'

function envelope(
  currentText: string,
  reference?: TelegramInboundEnvelope['reference'],
): TelegramInboundEnvelope {
  return Object.freeze({
    chat: Object.freeze({ id: 7, type: 'private' }),
    message: Object.freeze({ id: 11 }),
    currentText,
    ...(reference === undefined ? {} : { reference: Object.freeze(reference) }),
    signal,
  })
}

function rootResult(): TelegramInboundResult {
  return { kind: 'root-delivered' }
}

function pending(kind: 'awaiting_reason' | 'awaiting_candidate_confirmation') {
  const target = Object.freeze({
    id: 'x-status:123',
    content: '内容',
    source: 'https://x.com/a/status/123',
    scope: 'current' as const,
  })
  return kind === 'awaiting_reason'
    ? Object.freeze({
      kind,
      target,
      dimension: 'content_value' as const,
      sentiment: 'dislike' as const,
      rawUserExpression: '不喜欢',
    })
    : Object.freeze({
      kind,
      target,
      dimension: 'content_value' as const,
      sentiment: 'dislike' as const,
      rawUserExpression: '不喜欢',
      candidate: '论证跳跃',
    })
}

function oldDependencies(
  pendingStore: InMemoryPendingStore,
  overrides: {
    readonly runCleanFeedback?: TelegramFeedbackAdapterDependencies['runCleanFeedback']
    readonly useCaseResult?: FeedbackUseCaseResult
  } = {},
): {
  dependencies: TelegramFeedbackAdapterDependencies
  calls: { clean: ReturnType<typeof vi.fn>; repository: ReturnType<typeof vi.fn>; useCase: ReturnType<typeof vi.fn>; effect: ReturnType<typeof vi.fn> }
} {
  const calls = {
    clean: vi.fn(),
    repository: vi.fn(() => []),
    useCase: vi.fn((): FeedbackUseCaseResult => overrides.useCaseResult ?? { kind: 'pass', reason: 'ordinary', effects: [] }),
    effect: vi.fn(() => ({ ok: true as const })),
  }
  const dependencies = {
    pendingStore,
    trustedFactRepository: { readAll: calls.repository },
    effectSink: { apply: calls.effect },
    useCase: { execute: calls.useCase },
    runCleanFeedback: overrides.runCleanFeedback === undefined
      ? (async (request, _signal) => {
        calls.clean(request)
        throw new Error('X clean runner must not be called for Personal Feed')
      })
      : async (request, requestSignal) => {
        calls.clean(request)
        return await overrides.runCleanFeedback!(request, requestSignal)
      },
  } satisfies TelegramFeedbackAdapterDependencies
  return { dependencies, calls }
}

function feedCoordinator(
  pendingStore: InMemoryPendingStore,
  mode: 'prepared' | 'throws' | 'failed' = 'prepared',
) {
  const events: string[] = []
  const prepare = vi.fn(async () => {
    events.push('prepare')
    expect(pendingStore.get('telegram-chat:7')).toBeUndefined()
    if (mode === 'throws') throw new Error('Feed coordinator unavailable')
    if (mode === 'failed') return { kind: 'failed' } as never
    return {
      kind: 'prepared' as const,
      request: {
        requestId: 'telegram:7:11',
        cutoff: '2026-08-31T15:59:59.000Z',
        shanghaiDay: '2026-08-31',
      },
      outcome: {
        kind: 'one_link' as const,
        category: 'judgement_execution' as const,
        finalText: personalFeedText,
        digest: 'a'.repeat(64),
      },
    }
  })
  return { coordinator: { prepare, read: vi.fn() }, events }
}

function installComposition(
  coordinator: unknown,
  dependencies: TelegramFeedbackAdapterDependencies,
) {
  const ctx = new Context()
  const contextRuntime = createPersonalContextTelegramRuntime({
    owner: {
      observe: vi.fn(async () => ({ kind: 'ignored' })),
      snapshot: vi.fn(),
    } as never,
    installSignal: new AbortController().signal,
  })
  const stopSource = contextRuntime.registerSourceFirst(ctx)
  const stopFeedback = registerTelegramFeedbackAdapter(ctx, dependencies)
  const handler = createPersonalFeedTelegramRequestHandler({ coordinator } as never)
  const stopPersonalFeed = registerPersonalFeedTelegramAdapter(ctx, { handler })
  return { ctx, dispose: () => { stopPersonalFeed(); stopFeedback(); stopSource() } }
}

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

describe('X pending handoff at the real Telegram waterfall boundary', () => {
  it.each(['awaiting_reason', 'awaiting_candidate_confirmation'] as const)(
    'clears %s before Personal Feed prepare, and a following ordinary message reaches root once',
    async kind => {
      const pendingStore = new InMemoryPendingStore({ ttlMs: 60_000, clock: { now: () => 0 } })
      pendingStore.set('telegram-chat:7', pending(kind))
      const clear = pendingStore.clear.bind(pendingStore)
      const events: string[] = []
      pendingStore.clear = key => { events.push('clear'); clear(key) }
      const { coordinator, events: coordinatorEvents } = feedCoordinator(pendingStore)
      const { dependencies, calls } = oldDependencies(pendingStore)
      const composition = installComposition(coordinator, dependencies)
      contexts.push(composition.ctx)

      const root = vi.fn(rootResult)
      const result = await composition.ctx.waterfall('telegram/inbound', envelope('给我一次个人 Feed'), root)

      expect(events).toEqual(['clear'])
      expect(coordinatorEvents).toEqual(['prepare'])
      expect(result).toMatchObject({ kind: 'handled', finalText: personalFeedText })
      expect(coordinator.prepare).toHaveBeenCalledOnce()
      expect(calls.clean).not.toHaveBeenCalled()
      expect(calls.repository).not.toHaveBeenCalled()
      expect(calls.useCase).not.toHaveBeenCalled()
      expect(calls.effect).not.toHaveBeenCalled()
      expect(root).not.toHaveBeenCalled()

      const ordinaryRoot = vi.fn(rootResult)
      const ordinary = await composition.ctx.waterfall('telegram/inbound', envelope('普通消息'), ordinaryRoot)
      expect(ordinary).toEqual(rootResult())
      expect(ordinaryRoot).toHaveBeenCalledOnce()
      expect(coordinator.prepare).toHaveBeenCalledOnce()
      expect(calls.clean).not.toHaveBeenCalled()
    },
  )

  it.each(['throws', 'failed'] as const)(
    'does not restore X pending when the Personal Feed coordinator %s',
    async mode => {
      const pendingStore = new InMemoryPendingStore({ ttlMs: 60_000, clock: { now: () => 0 } })
      pendingStore.set('telegram-chat:7', pending('awaiting_reason'))
      const { coordinator } = feedCoordinator(pendingStore, mode)
      const { dependencies, calls } = oldDependencies(pendingStore)
      const composition = installComposition(coordinator, dependencies)
      contexts.push(composition.ctx)
      const root = vi.fn(rootResult)

      const result = await composition.ctx.waterfall('telegram/inbound', envelope('给我一次个人 Feed'), root)

      expect(result).toEqual({ kind: 'failed', visibleError: '这次没有完成：判断或执行未完成。' })
      expect(coordinator.prepare).toHaveBeenCalledOnce()
      expect(pendingStore.get('telegram-chat:7')).toBeUndefined()
      expect(calls.clean).not.toHaveBeenCalled()
      expect(calls.repository).not.toHaveBeenCalled()
      expect(calls.useCase).not.toHaveBeenCalled()
      expect(calls.effect).not.toHaveBeenCalled()
      expect(root).not.toHaveBeenCalled()
    },
  )

  it.each([
    ['current text', '请处理 https://x.com/a/status/123', undefined],
    ['selected quote', '请处理这条', { messageId: 10, selectedText: '选中的 https://x.com/a/status/123' }],
    ['full quote', '请处理这条', { messageId: 10, messageText: '完整引用 https://twitter.com/a/status/123' }],
  ] as const)('keeps the X chain first when %s alone contains an X URL', async (_label, currentText, reference) => {
    const pendingStore = new InMemoryPendingStore({ ttlMs: 60_000, clock: { now: () => 0 } })
    const savedPending = pending('awaiting_reason')
    pendingStore.set('telegram-chat:7', savedPending)
    const completed = {
      kind: 'completed' as const,
      decision: { kind: 'completed' as const, state: { kind: 'idle' as const }, effects: [] },
      effects: [],
      reply: '旧 X 处理结果',
    }
    const { dependencies, calls } = oldDependencies(pendingStore, {
      useCaseResult: completed,
      runCleanFeedback: vi.fn(async () => ({
        interpretation: { kind: 'operation', operation: 'save', targetId: 'x-status:123' },
      })),
    })
    const { coordinator } = feedCoordinator(pendingStore, 'throws')
    const composition = installComposition(coordinator, dependencies)
    contexts.push(composition.ctx)
    const root = vi.fn(rootResult)

    const result = await composition.ctx.waterfall(
      'telegram/inbound',
      envelope(currentText, reference),
      root,
    )

    expect(result).toEqual({ kind: 'handled', finalText: '旧 X 处理结果' })
    expect(calls.clean).toHaveBeenCalledOnce()
    expect(calls.repository).toHaveBeenCalledOnce()
    expect(calls.useCase).toHaveBeenCalledOnce()
    expect(calls.effect).not.toHaveBeenCalled()
    expect(coordinator.prepare).not.toHaveBeenCalled()
    expect(pendingStore.get('telegram-chat:7')).toBe(savedPending)
    expect(root).not.toHaveBeenCalled()
  })

  it('passes an ordinary non-Feed message to root once when there is no pending X state', async () => {
    const pendingStore = new InMemoryPendingStore({ ttlMs: 60_000, clock: { now: () => 0 } })
    const { dependencies, calls } = oldDependencies(pendingStore)
    const { coordinator } = feedCoordinator(pendingStore, 'throws')
    const composition = installComposition(coordinator, dependencies)
    contexts.push(composition.ctx)
    const root = vi.fn(rootResult)

    const result = await composition.ctx.waterfall('telegram/inbound', envelope('普通非 Feed 消息'), root)

    expect(result).toEqual(rootResult())
    expect(root).toHaveBeenCalledOnce()
    expect(calls.clean).not.toHaveBeenCalled()
    expect(coordinator.prepare).not.toHaveBeenCalled()
  })
})
