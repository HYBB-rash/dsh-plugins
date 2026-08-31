import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type {
  TelegramInboundEnvelope,
  TelegramInboundResult,
} from '@deepseek-ai/dsh-telegram-gateway'
import {
  registerTelegramFeedbackAdapter,
  type TelegramFeedbackAdapterContext,
} from '../src/x-feedback/telegram-adapter.ts'
import { createTrustedFact } from '../src/trusted-facts/model.ts'
import type { CleanFeedbackRequest, FeedbackInterpretation } from '../src/x-feedback/contract.ts'
import { InMemoryPendingStore } from '../src/x-feedback/pending-store.ts'
import { FeedbackUseCase } from '../src/x-feedback/use-case.ts'
import type { FeedbackUseCaseResult } from '../src/x-feedback/use-case.ts'

const signal = new AbortController().signal

function envelope(currentText: string, reference?: TelegramInboundEnvelope['reference']): TelegramInboundEnvelope {
  return {
    chat: { id: 7, type: 'private' },
    message: { id: 11 },
    currentText,
    ...(reference === undefined ? {} : { reference }),
    signal,
  }
}

function pass(reason: Extract<FeedbackInterpretation, { kind: 'pass' }>['reason']): FeedbackInterpretation {
  return { kind: 'pass', reason }
}

function context(): {
  ctx: TelegramFeedbackAdapterContext
  registered: Map<string, (...args: any[]) => unknown>
  unload: ReturnType<typeof vi.fn>
} {
  const registered = new Map<string, (...args: any[]) => unknown>()
  const unload = vi.fn()
  const ctx = {
    on: vi.fn((name: string, listener: (...args: any[]) => unknown) => {
      registered.set(name, listener)
      return vi.fn()
    }),
    agents: { create: vi.fn() },
  }
  return { ctx: ctx as TelegramFeedbackAdapterContext, registered, unload }
}

function makeDependencies(
  interpretation: FeedbackInterpretation = pass('ordinary'),
  result?: FeedbackUseCaseResult,
): {
  dependencies: Parameters<typeof registerTelegramFeedbackAdapter>[1]
  calls: { clean: CleanFeedbackRequest[]; useCase: unknown[]; effects: unknown[]; facts: unknown[]; order: string[] }
} {
  const calls = { clean: [], useCase: [], effects: [], facts: [], order: [] } as {
    clean: CleanFeedbackRequest[]
    useCase: unknown[]
    effects: unknown[]
    facts: unknown[]
    order: string[]
  }
  const pending = {
    get: vi.fn(),
    set: vi.fn(),
    clear: vi.fn(),
    expire: vi.fn(() => 0),
    unload: vi.fn(() => calls.order.push('pending-unload')),
  }
  const useCase = {
    execute: vi.fn((input: unknown) => {
      calls.order.push('usecase')
      calls.useCase.push(input)
      return result ?? { kind: 'pass', reason: 'ordinary', effects: [] }
    }),
  }
  const dependencies = {
    pendingStore: pending,
    useCase,
    trustedFactRepository: {
      readAll: vi.fn(() => {
        calls.facts.push('read')
        return []
      }),
    },
    effectSink: {
      apply: vi.fn((effect: unknown) => {
        calls.order.push('effect')
        calls.effects.push(effect)
        return { ok: true as const }
      }),
    },
    runCleanFeedback: vi.fn(async (request: CleanFeedbackRequest) => {
      calls.order.push('clean-flushed')
      calls.clean.push(request)
      return { interpretation, sessionId: 'session-x-feedback-test', wire: {} }
    }),
  } satisfies Parameters<typeof registerTelegramFeedbackAdapter>[1]
  return { dependencies, calls }
}

function rootResult(): TelegramInboundResult {
  return { kind: 'root-delivered' }
}

describe('Telegram X feedback adapter', () => {
  it('imports the gateway contract from its public package root', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/x-feedback/telegram-adapter.ts', import.meta.url)), 'utf8')

    expect(source).not.toContain('@deepseek-ai/dsh-telegram-gateway/src/')
    expect(source).toContain("from '@deepseek-ai/dsh-telegram-gateway'")
  })

  it('registers readiness and waterfall handlers and unloads pending state', async () => {
    const { ctx, registered } = context()
    const { dependencies } = makeDependencies()
    const dispose = registerTelegramFeedbackAdapter(ctx, dependencies)

    expect(registered.get('telegram/inbound/ready')?.(envelope('普通消息'))).toBe(true)
    dispose()
    expect(dependencies.pendingStore.unload).toHaveBeenCalledOnce()
  })

  it('rolls back the first ready listener and unloads pending state when the second registration fails', () => {
    const readyStop = vi.fn()
    const registrationError = new Error('waterfall registration failed')
    const { dependencies } = makeDependencies()
    const ctx = {
      on: vi.fn((name: string) => {
        if (name === 'telegram/inbound/ready') return readyStop
        throw registrationError
      }),
    } as TelegramFeedbackAdapterContext

    expect(() => registerTelegramFeedbackAdapter(ctx, dependencies)).toThrow(registrationError)
    expect(readyStop).toHaveBeenCalledOnce()
    expect(dependencies.pendingStore.unload).toHaveBeenCalledOnce()
    expect(ctx.on).toHaveBeenCalledTimes(2)
  })

  it('disposes waterfall then ready then pending, and repeated disposal is idempotent', () => {
    const order: string[] = []
    const { dependencies } = makeDependencies()
    const ctx = {
      on: vi.fn((name: string) => vi.fn(() => order.push(name))),
    } as TelegramFeedbackAdapterContext
    dependencies.pendingStore.unload.mockImplementation(() => { order.push('pending') })

    const dispose = registerTelegramFeedbackAdapter(ctx, dependencies)
    dispose()
    dispose()

    expect(order).toEqual(['telegram/inbound', 'telegram/inbound/ready', 'pending'])
    expect(dependencies.pendingStore.unload).toHaveBeenCalledOnce()
  })

  it.each(['telegram/inbound', 'telegram/inbound/ready'] as const)('continues cleanup after a %s disposer failure, reports and caches that failure, and does not repeat cleanup', cleanupPoint => {
    const cleanupError = new Error(`${cleanupPoint} cleanup failed`)
    const order: string[] = []
    const { dependencies } = makeDependencies()
    const ctx = {
      on: vi.fn((name: string) => vi.fn(() => {
        order.push(name)
        if (name === cleanupPoint) throw cleanupError
      })),
    } as TelegramFeedbackAdapterContext
    dependencies.pendingStore.unload.mockImplementation(() => { order.push('pending') })

    const dispose = registerTelegramFeedbackAdapter(ctx, dependencies)
    let firstError: unknown
    try { dispose() } catch (error) { firstError = error }

    expect(firstError).toBe(cleanupError)
    expect(order).toEqual(['telegram/inbound', 'telegram/inbound/ready', 'pending'])
    expect(dependencies.pendingStore.unload).toHaveBeenCalledOnce()

    expect(() => dispose()).toThrow(cleanupError)
    expect(order).toEqual(['telegram/inbound', 'telegram/inbound/ready', 'pending'])
    expect(dependencies.pendingStore.unload).toHaveBeenCalledOnce()
  })

  it('passes an ordinary message once without creating a clean Agent, reading facts, or effects', async () => {
    const { ctx, registered } = context()
    const { dependencies, calls } = makeDependencies()
    const dispose = registerTelegramFeedbackAdapter(ctx, dependencies)
    const next = vi.fn(rootResult)

    const result = await registered.get('telegram/inbound')!(envelope('普通消息'), next)

    expect(result).toEqual(rootResult())
    expect(next).toHaveBeenCalledOnce()
    expect(dependencies.runCleanFeedback).not.toHaveBeenCalled()
    expect(calls.facts).toEqual([])
    expect(calls.effects).toEqual([])
    dispose()
  })

  it('uses selected quote text before the full quoted message and supplies only exact target facts', async () => {
    const target = 'https://x.com/alice/status/123'
    const { ctx, registered } = context()
    const { dependencies, calls } = makeDependencies(pass('not_feedback'))
    const dispose = registerTelegramFeedbackAdapter(ctx, dependencies)
    const next = vi.fn(rootResult)

    await registered.get('telegram/inbound')!(envelope(
      `请反馈 ${target}`,
      { messageId: 10, selectedText: `选中 ${target}`, messageText: `完整引用 ${target}` },
    ), next)

    expect(calls.clean[0]).toMatchObject({
      currentMessage: { text: `请反馈 ${target}` },
      reference: { messageId: 10, text: `选中 ${target}` },
    })
    expect(next).toHaveBeenCalledOnce()
    dispose()
  })

  it('falls back to the full quote only when no selected quote exists', async () => {
    const target = 'https://x.com/alice/status/123'
    const { ctx, registered } = context()
    const { dependencies, calls } = makeDependencies(pass('not_feedback'))
    const dispose = registerTelegramFeedbackAdapter(ctx, dependencies)

    await registered.get('telegram/inbound')!(envelope(
      `请反馈 ${target}`,
      { messageId: 10, messageText: `完整引用 ${target}` },
    ), vi.fn(rootResult))

    expect(calls.clean[0]?.reference?.text).toBe(`完整引用 ${target}`)
    dispose()
  })

  it('runs clean flush before the use case and applies effects only after a completed result', async () => {
    const target = 'https://x.com/alice/status/123'
    const completed = {
      kind: 'completed' as const,
      decision: { kind: 'completed' as const, state: { kind: 'idle' as const }, effects: [{ kind: 'record_operation' as const, operation: 'save' as const, target: { id: 'x-status:123', content: target, source: target, scope: 'current' } }] },
      effects: [{ kind: 'record_operation' as const, operation: 'save' as const, target: { id: 'x-status:123', content: target, source: target, scope: 'current' } }],
      reply: '已记录',
    }
    const { ctx, registered } = context()
    const { dependencies, calls } = makeDependencies({ kind: 'operation', operation: 'save', targetId: 'x-status:123' }, completed)
    const dispose = registerTelegramFeedbackAdapter(ctx, dependencies)
    const next = vi.fn(rootResult)

    const result = await registered.get('telegram/inbound')!(envelope(`收藏 ${target}`), next)

    expect(result).toEqual({ kind: 'handled', finalText: '已记录' })
    expect(calls.order).toEqual(['clean-flushed', 'usecase', 'effect'])
    expect(next).not.toHaveBeenCalled()
    dispose()
  })

  it.each(['awaiting_reason', 'awaiting_candidate_confirmation', 'discarded'] as const)(
    'returns %s as handled without entering root',
    async kind => {
      const target = { id: 'x-status:123', content: '内容', source: 'https://x.com/a/status/123', scope: 'current' }
      const decision = kind === 'discarded'
        ? { kind: 'discarded' as const, state: { kind: 'idle' as const }, effects: [] as const }
        : kind === 'awaiting_reason'
          ? { kind: 'awaiting_reason' as const, ask: 'ask_for_reason' as const, state: { kind: 'awaiting_reason' as const, target, dimension: 'content_value' as const, sentiment: 'dislike' as const, rawUserExpression: '不喜欢' }, effects: [] as const }
          : { kind: 'awaiting_candidate_confirmation' as const, ask: 'confirm_candidate' as const, state: { kind: 'awaiting_candidate_confirmation' as const, target, dimension: 'content_value' as const, sentiment: 'dislike' as const, rawUserExpression: '不喜欢', candidate: '论证跳跃' }, effects: [] as const }
      const result = { kind, decision, effects: [], reply: '请继续' } as FeedbackUseCaseResult
      const { ctx, registered } = context()
      const { dependencies } = makeDependencies({ kind: 'rating', sentiment: 'dislike', targetId: target.id, dimension: 'content_value' }, result)
      const dispose = registerTelegramFeedbackAdapter(ctx, dependencies)
      const next = vi.fn(rootResult)

      await expect(registered.get('telegram/inbound')!(envelope('不喜欢 https://x.com/a/status/123'), next)).resolves.toEqual({
        kind: 'handled', finalText: '请继续',
      })
      expect(next).not.toHaveBeenCalled()
      dispose()
    },
  )

  it('fails closed on clean errors and clears pending without entering root', async () => {
    const { ctx, registered } = context()
    const { dependencies } = makeDependencies()
    dependencies.pendingStore.get.mockReturnValue({
      kind: 'awaiting_reason',
      target: { id: 'x-status:123', content: '内容', source: 'https://x.com/a/status/123', scope: 'current' },
      dimension: 'content_value',
      sentiment: 'dislike',
      rawUserExpression: '不喜欢',
    })
    dependencies.runCleanFeedback.mockRejectedValue(new Error('timeout'))
    const dispose = registerTelegramFeedbackAdapter(ctx, dependencies)
    const next = vi.fn(rootResult)

    const result = await registered.get('telegram/inbound')!(envelope('反馈 https://x.com/a/status/123'), next)

    expect(result).toMatchObject({ kind: 'failed' })
    expect(dependencies.pendingStore.clear).toHaveBeenCalledWith('telegram-chat:7')
    expect(next).not.toHaveBeenCalled()
    dispose()
  })

  it('hands an explicit Personal Feed request to the next adapter before touching X pending state', async () => {
    const pending = {
      kind: 'awaiting_reason' as const,
      target: { id: 'x-status:123', content: '内容', source: 'https://x.com/a/status/123', scope: 'current' as const },
      dimension: 'content_value' as const,
      sentiment: 'dislike' as const,
      rawUserExpression: '不喜欢',
    }
    const { ctx, registered } = context()
    const { dependencies, calls } = makeDependencies()
    dependencies.pendingStore.get.mockImplementation(key => {
      calls.order.push(`pending-get:${key}`)
      return pending
    })
    dependencies.pendingStore.clear.mockImplementation(key => {
      calls.order.push(`pending-clear:${key}`)
    })
    const dispose = registerTelegramFeedbackAdapter(ctx, dependencies)
    const next = vi.fn(() => {
      calls.order.push('next')
      return { kind: 'feed-adapter-sentinel' as const }
    })

    const result = await registered.get('telegram/inbound')!(envelope('给我一次个人 Feed'), next)

    expect(result).toEqual({ kind: 'feed-adapter-sentinel' })
    expect(calls.order).toEqual([
      'pending-get:telegram-chat:7',
      'pending-clear:telegram-chat:7',
      'next',
    ])
    expect(dependencies.runCleanFeedback).not.toHaveBeenCalled()
    expect(dependencies.trustedFactRepository.readAll).not.toHaveBeenCalled()
    expect(dependencies.useCase.execute).not.toHaveBeenCalled()
    expect(dependencies.effectSink.apply).not.toHaveBeenCalled()
    dispose()
  })

  it.each(['具体理由。', '帮我设计个人 Feed'] as const)(
    'does not broaden the Personal Feed handoff to the non-X message %s', async currentText => {
      const pending = {
        kind: 'awaiting_reason' as const,
        target: { id: 'x-status:123', content: '内容', source: 'https://x.com/a/status/123', scope: 'current' as const },
        dimension: 'content_value' as const,
        sentiment: 'dislike' as const,
        rawUserExpression: '不喜欢',
      }
      const completed = {
        kind: 'completed' as const,
        decision: { kind: 'completed' as const, state: { kind: 'idle' as const }, effects: [] },
        effects: [],
        reply: '旧 X 处理结果',
      }
      const { ctx, registered } = context()
      const { dependencies, calls } = makeDependencies(pass('ordinary'), completed)
      dependencies.pendingStore.get.mockReturnValue(pending)
      const dispose = registerTelegramFeedbackAdapter(ctx, dependencies)
      const next = vi.fn(rootResult)

      const result = await registered.get('telegram/inbound')!(envelope(currentText), next)

      expect(result).toEqual({ kind: 'handled', finalText: '旧 X 处理结果' })
      expect(dependencies.runCleanFeedback).toHaveBeenCalledOnce()
      expect(dependencies.trustedFactRepository.readAll).toHaveBeenCalledOnce()
      expect(dependencies.useCase.execute).toHaveBeenCalledOnce()
      expect(calls.effects).toEqual([])
      expect(dependencies.pendingStore.clear).not.toHaveBeenCalled()
      expect(next).not.toHaveBeenCalled()
      dispose()
    },
  )

  it.each(['not_feedback', 'mixed_intent', 'target_ambiguous'] as const)(
    'routes %s through clean classification then root with no effects',
    async reason => {
      const { ctx, registered } = context()
      const { dependencies, calls } = makeDependencies(pass(reason))
      const dispose = registerTelegramFeedbackAdapter(ctx, dependencies)
      const next = vi.fn(rootResult)

      const result = await registered.get('telegram/inbound')!(
        envelope('反馈 https://x.com/a/status/123'),
        next,
      )

      expect(result).toEqual(rootResult())
      expect(next).toHaveBeenCalledOnce()
      expect(calls.effects).toEqual([])
      dispose()
    },
  )

  it('reads only branded facts whose ids are in the current target catalog', async () => {
    const target = 'https://x.com/alice/status/123'
    const validResult = createTrustedFact({
      target: { id: 'x-status:123', content: '当前内容', source: target, scope: 'current' },
      dimension: 'content_value',
      reason: '明确例子。',
      evidence: { kind: 'user_direct', rawUserExpression: '我喜欢，因为明确例子。' },
    })
    if (!validResult.ok) throw new Error(validResult.message)
    const otherResult = createTrustedFact({
      target: { id: 'x-status:999', content: '无关内容', source: 'https://x.com/a/status/999', scope: 'current' },
      dimension: 'content_value',
      reason: '无关。',
      evidence: { kind: 'user_direct', rawUserExpression: '无关。' },
    })
    if (!otherResult.ok) throw new Error(otherResult.message)

    const { ctx, registered } = context()
    const { dependencies, calls } = makeDependencies(pass('not_feedback'))
    dependencies.pendingStore.get.mockReturnValue({
      kind: 'awaiting_reason',
      target: { id: 'x-status:123', content: '当前内容', source: target, scope: 'current' },
      dimension: 'content_value',
      sentiment: 'dislike',
      rawUserExpression: '不喜欢',
    })
    dependencies.trustedFactRepository.readAll = vi.fn(() => [
      validResult.fact,
      otherResult.fact,
      { target: { id: 'x-status:123' } },
    ] as never[])
    const dispose = registerTelegramFeedbackAdapter(ctx, dependencies)

    await registered.get('telegram/inbound')!(envelope(`反馈 ${target}`), vi.fn(rootResult))

    expect(calls.clean[0]?.trustedFactsByTarget).toEqual({
      'x-status:123': [expect.objectContaining({ reason: '明确例子。' })],
    })
    expect(calls.clean[0]?.pending).toMatchObject({ kind: 'awaiting_reason', target: { id: 'x-status:123' } })
    dispose()
  })

  it('fails closed for repository, use-case, polluted clean, and effect failures', async () => {
    const target = 'https://x.com/a/status/123'
    const scenarios = [
      {
        name: 'repository',
        setup: (deps: Parameters<typeof registerTelegramFeedbackAdapter>[1]) => {
          deps.trustedFactRepository.readAll = vi.fn(() => { throw new Error('facts unavailable') })
        },
      },
      {
        name: 'use-case',
        setup: (deps: Parameters<typeof registerTelegramFeedbackAdapter>[1]) => {
          deps.useCase.execute = vi.fn(() => { throw new Error('transition unavailable') })
        },
      },
      {
        name: 'use-case failure result',
        setup: (deps: Parameters<typeof registerTelegramFeedbackAdapter>[1]) => {
          deps.useCase.execute = vi.fn(() => ({
            kind: 'failure' as const,
            code: 'invalid_transition' as const,
            message: '状态无效',
            effects: [],
          }))
        },
      },
      {
        name: 'polluted clean result',
        setup: (deps: Parameters<typeof registerTelegramFeedbackAdapter>[1]) => {
          deps.runCleanFeedback = vi.fn(async () => ({ interpretation: { kind: 'pass', reason: 'ordinary', polluted: true } }))
        },
      },
      {
        name: 'effect',
        setup: (deps: Parameters<typeof registerTelegramFeedbackAdapter>[1]) => {
          deps.effectSink.apply = vi.fn(() => ({ ok: false as const, code: 'write_failed' as const, message: 'disk full' }))
          deps.useCase.execute = vi.fn(() => ({
            kind: 'completed' as const,
            decision: { kind: 'completed' as const, state: { kind: 'idle' as const }, effects: [] },
            effects: [{ kind: 'record_operation' as const, operation: 'save' as const, target: { id: 'x-status:123', content: target, source: target, scope: 'current' } }],
            reply: '已记录',
          }))
        },
      },
    ]

    for (const scenario of scenarios) {
      const { ctx, registered } = context()
      const { dependencies } = makeDependencies({ kind: 'operation', operation: 'save', targetId: 'x-status:123' })
      scenario.setup(dependencies)
      const dispose = registerTelegramFeedbackAdapter(ctx, dependencies)
      const next = vi.fn(rootResult)

      const result = await registered.get('telegram/inbound')!(envelope(`收藏 ${target}`), next)

      expect(result.kind, scenario.name).toBe('failed')
      expect(next, scenario.name).not.toHaveBeenCalled()
      expect(dependencies.pendingStore.clear, scenario.name).toHaveBeenCalledWith('telegram-chat:7')
      dispose()
    }
  })

  it('exposes persisted-fact projection failure without claiming handled success or asking for a retry', async () => {
    const target = 'https://x.com/a/status/123'
    const factResult = createTrustedFact({
      target: { id: 'x-status:123', content: '内容', source: target, scope: 'current' },
      dimension: 'content_value',
      reason: '直接理由。',
      evidence: { kind: 'user_direct', rawUserExpression: '喜欢，因为直接理由。' },
    })
    if (!factResult.ok) throw new Error(factResult.message)
    const { ctx, registered } = context()
    const { dependencies } = makeDependencies({ kind: 'rating', sentiment: 'like', targetId: 'x-status:123', dimension: 'content_value' }, {
      kind: 'completed',
      decision: { kind: 'completed', state: { kind: 'idle' }, effects: [] },
      effects: [{ kind: 'append_trusted_fact', fact: factResult.fact }],
      reply: '已记录',
    })
    dependencies.effectSink.apply = vi.fn(() => ({
      ok: false as const,
      code: 'fact_persisted_projection_unavailable' as const,
      factPersisted: true as const,
      message: 'projection unavailable',
    }))
    const dispose = registerTelegramFeedbackAdapter(ctx, dependencies)
    const next = vi.fn(rootResult)

    const result = await registered.get('telegram/inbound')!(envelope(`喜欢，因为直接理由。 ${target}`), next)

    expect(result).toEqual({
      kind: 'failed',
      visibleError: '事实已保存但投影暂不可用，无需重复发送，服务恢复后会重建。',
    })
    expect(next).not.toHaveBeenCalled()
    dispose()
  })

  it('executes the five TODO 1 chains through the real use case and two sinks', async () => {
    const target = 'https://x.com/a/status/123'
    const targetValue = { id: 'x-status:123', content: target, source: target, scope: 'current' }
    const pendingStore = new InMemoryPendingStore({ ttlMs: 10_000, clock: { now: () => 0 } })
    const useCase = new FeedbackUseCase(pendingStore)
    const facts: unknown[] = []
    const operations: unknown[] = []
    const interpretations: FeedbackInterpretation[] = [
      { kind: 'rating', sentiment: 'like', targetId: targetValue.id, dimension: 'content_value', reason: '直接理由。' },
      { kind: 'rating', sentiment: 'dislike', targetId: targetValue.id, dimension: 'argument_quality' },
      { kind: 'reason_answer', reason: '具体理由。' },
      { kind: 'prior_reason_reference', targetId: targetValue.id, dimension: 'content_value' },
      { kind: 'reason_answer', reason: '还是老问题的新明确理由。' },
      { kind: 'candidate_reason', sentiment: 'dislike', targetId: targetValue.id, dimension: 'argument_quality', candidate: '论证跳跃。' },
      { kind: 'confirm_candidate', confirmation: '对，就是这个。' },
      { kind: 'operation', operation: 'save', targetId: targetValue.id },
      { kind: 'operation', operation: 'unsave', targetId: targetValue.id },
    ]
    const { ctx, registered } = context()
    const dependencies = {
      pendingStore,
      useCase,
      trustedFactRepository: { readAll: vi.fn(() => []) },
      effectSink: {
        apply: vi.fn((effect: { kind: string }) => {
          if (effect.kind === 'append_trusted_fact') facts.push(effect)
          if (effect.kind === 'record_operation') operations.push(effect)
          return { ok: true as const }
        }),
      },
      runCleanFeedback: vi.fn(async () => ({ interpretation: interpretations.shift()! })),
    } satisfies Parameters<typeof registerTelegramFeedbackAdapter>[1]
    const dispose = registerTelegramFeedbackAdapter(ctx, dependencies)
    const root = vi.fn(rootResult)

    await registered.get('telegram/inbound')!(envelope(`喜欢，因为直接理由。 ${target}`), root)
    const awaiting = await registered.get('telegram/inbound')!(envelope(`不喜欢。 ${target}`), root)
    expect(facts).toHaveLength(1)
    const answered = await registered.get('telegram/inbound')!(envelope('具体理由。'), root)
    expect(facts).toHaveLength(2)
    const oldReason = await registered.get('telegram/inbound')!(envelope(`还是老问题。 ${target}`), root)
    expect(facts).toHaveLength(2)
    const oldReasonAnswered = await registered.get('telegram/inbound')!(envelope('还是老问题的新明确理由。'), root)
    expect(facts).toHaveLength(3)
    const candidate = await registered.get('telegram/inbound')!(envelope(`我猜是论证跳跃。 ${target}`), root)
    expect(facts).toHaveLength(3)
    const confirmed = await registered.get('telegram/inbound')!(envelope('对，就是这个。'), root)
    expect(facts).toHaveLength(4)
    await registered.get('telegram/inbound')!(envelope(`收藏 ${target}`), root)
    await registered.get('telegram/inbound')!(envelope(`取消收藏 ${target}`), root)

    expect(awaiting).toMatchObject({ kind: 'handled' })
    expect(answered).toMatchObject({ kind: 'handled' })
    expect(oldReason).toMatchObject({ kind: 'handled' })
    expect(oldReasonAnswered).toMatchObject({ kind: 'handled' })
    expect(candidate).toMatchObject({ kind: 'handled' })
    expect(confirmed).toMatchObject({ kind: 'handled' })
    expect(root).not.toHaveBeenCalled()
    expect(facts).toHaveLength(4)
    expect(operations).toHaveLength(2)
    const factEvidenceKinds = facts.map(value => {
      const effect = value as { fact?: { evidence?: { kind?: string } } }
      return effect.fact?.evidence?.kind
    })
    expect(factEvidenceKinds).toContain('user_confirmed_candidate')
    dispose()
  })
})
