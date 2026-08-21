import { describe, expect, it } from 'vitest'
import { isTrustedFact } from '../src/trusted-facts/model.ts'
import { FeedbackUseCase } from '../src/x-feedback/use-case.ts'
import { InMemoryPendingStore } from '../src/x-feedback/pending-store.ts'
import type { CleanFeedbackRequest, FeedbackTarget } from '../src/x-feedback/contract.ts'

const target: FeedbackTarget = {
  id: 'x:1', content: '一条 X 内容', source: 'https://x.test/1', scope: '当前消息',
}
const request = (targets: readonly FeedbackTarget[] = [target], text = '当前用户表达'): CleanFeedbackRequest => ({
  currentMessage: { id: 1, text, targets },
  targetCatalog: { currentMessage: targets, reference: [] },
  trustedFactsByTarget: {},
})

describe('X feedback application use case', () => {
  it('resolves the sole target and records direct rating through TODO 1', () => {
    const store = new InMemoryPendingStore({ ttlMs: 1_000, clock: { now: () => 0 } })
    const result = new FeedbackUseCase(store).execute({
      conversationKey: 'chat-a',
      request: request([target], '我喜欢，因为有具体例子。'),
      interpretation: { kind: 'rating', sentiment: 'like', targetId: target.id, dimension: 'content_value', reason: '有具体例子。' },
    })

    expect(result.kind).toBe('completed')
    if (result.kind !== 'completed') return
    expect(result.decision.kind).toBe('completed')
    expect(result.effects).toHaveLength(1)
    const effect = result.effects[0]
    expect(effect.kind).toBe('append_trusted_fact')
    if (effect.kind !== 'append_trusted_fact') return
    expect(isTrustedFact(effect.fact)).toBe(true)
    expect(effect.fact.evidence).toMatchObject({ rawUserExpression: '我喜欢，因为有具体例子。' })
  })

  it('asks for a reason, then rebuilds the rating while retaining both expressions', () => {
    const store = new InMemoryPendingStore({ ttlMs: 1_000, clock: { now: () => 0 } })
    const useCase = new FeedbackUseCase(store)
    const pending = useCase.execute({
      conversationKey: 'chat-a',
      request: request([target], '不喜欢。'),
      interpretation: { kind: 'rating', sentiment: 'dislike', targetId: target.id, dimension: 'argument_quality' },
    })
    expect(pending.kind).toBe('awaiting_reason')
    const answered = useCase.execute({
      conversationKey: 'chat-a',
      request: request([], '论证跳跃。'),
      interpretation: { kind: 'reason_answer', reason: '论证跳跃。' },
    })
    expect(answered.kind).toBe('completed')
    if (answered.kind !== 'completed') return
    const effect = answered.effects[0]
    expect(effect.kind).toBe('append_trusted_fact')
    if (effect.kind !== 'append_trusted_fact') return
    expect(effect.fact).toMatchObject({ dimension: 'argument_quality', reason: '论证跳跃。' })
    expect(effect.fact.evidence).toMatchObject({ rawUserExpression: expect.stringContaining('不喜欢。') })
    expect(effect.fact.evidence).toMatchObject({ rawUserExpression: expect.stringContaining('论证跳跃。') })
    expect(store.get('chat-a')).toBeUndefined()
  })

  it('always asks again for a prior-reason reference and never reuses old facts', () => {
    const store = new InMemoryPendingStore({ ttlMs: 1_000, clock: { now: () => 0 } })
    const result = new FeedbackUseCase(store).execute({
      conversationKey: 'chat-a',
      request: { ...request([target], '还是老问题。'), trustedFactsByTarget: { [target.id]: [] } },
      interpretation: { kind: 'prior_reason_reference', targetId: target.id, dimension: 'content_value' },
    })
    expect(result.kind).toBe('awaiting_reason')
    expect(result.effects).toEqual([])
  })

  it('uses the awaiting pending target when a prior-reason answer has no fresh catalog', () => {
    const store = new InMemoryPendingStore({ ttlMs: 1_000, clock: { now: () => 0 } })
    const useCase = new FeedbackUseCase(store)
    const pending = useCase.execute({
      conversationKey: 'chat-a',
      request: request([target], '不喜欢。'),
      interpretation: { kind: 'rating', sentiment: 'dislike', targetId: target.id, dimension: 'content_value' },
    })
    expect(pending.kind).toBe('awaiting_reason')

    const result = useCase.execute({
      conversationKey: 'chat-a',
      request: { ...request([], '还是老问题。'), pending: pending.decision.state },
      interpretation: { kind: 'prior_reason_reference', targetId: target.id, dimension: 'content_value' },
    })

    expect(result.kind).toBe('awaiting_reason')
    expect(result.effects).toEqual([])
  })

  it('does not treat the same pending target and catalog target as duplicate, but rejects conflicting copies', () => {
    const store = new InMemoryPendingStore({ ttlMs: 1_000, clock: { now: () => 0 } })
    const useCase = new FeedbackUseCase(store)
    const pending = useCase.execute({
      conversationKey: 'chat-a', request: request([target], '不喜欢。'),
      interpretation: { kind: 'rating', sentiment: 'dislike', targetId: target.id, dimension: 'content_value' },
    })
    expect(pending.kind).toBe('awaiting_reason')

    const sameTarget = useCase.execute({
      conversationKey: 'chat-a', request: { ...request([target], '还是老问题。'), pending: pending.decision.state },
      interpretation: { kind: 'prior_reason_reference', targetId: target.id, dimension: 'content_value' },
    })
    expect(sameTarget.kind).toBe('awaiting_reason')

    const conflictingTarget = { ...target, content: '另一条内容' }
    const conflict = useCase.execute({
      conversationKey: 'chat-a', request: { ...request([conflictingTarget], '还是老问题。'), pending: pending.decision.state },
      interpretation: { kind: 'prior_reason_reference', targetId: target.id, dimension: 'content_value' },
    })
    expect(conflict.kind).toBe('failure')
    expect(conflict.effects).toEqual([])
  })

  it('keeps candidate pending until matching confirmation creates one branded fact', () => {
    const store = new InMemoryPendingStore({ ttlMs: 1_000, clock: { now: () => 0 } })
    const useCase = new FeedbackUseCase(store)
    const candidate = useCase.execute({
      conversationKey: 'chat-a', request: request([target], '我猜是论证跳跃。'),
      interpretation: { kind: 'candidate_reason', sentiment: 'dislike', targetId: target.id, dimension: 'argument_quality', candidate: '论证跳跃。' },
    })
    expect(candidate.kind).toBe('awaiting_candidate_confirmation')
    const confirmed = useCase.execute({
      conversationKey: 'chat-a', request: request([], '对，就是这个。'),
      interpretation: { kind: 'confirm_candidate', confirmation: '对，就是这个。' },
    })
    expect(confirmed.kind).toBe('completed')
    if (confirmed.kind !== 'completed') return
    expect(confirmed.effects).toHaveLength(1)
    const effect = confirmed.effects[0]
    expect(effect.kind).toBe('append_trusted_fact')
    if (effect.kind !== 'append_trusted_fact') return
    expect(isTrustedFact(effect.fact)).toBe(true)
    expect(effect.fact.evidence).toMatchObject({ kind: 'user_confirmed_candidate', confirmation: '对，就是这个。' })
  })

  it('records save and unsave as operations only', () => {
    const useCase = new FeedbackUseCase(new InMemoryPendingStore({ ttlMs: 1_000, clock: { now: () => 0 } }))
    for (const operation of ['save', 'unsave'] as const) {
      const result = useCase.execute({
        conversationKey: 'chat-a', request: request([target]),
        interpretation: { kind: 'operation', operation, targetId: target.id },
      })
      expect(result.kind).toBe('completed')
      if (result.kind !== 'completed') continue
      expect(result.effects).toEqual([{ kind: 'record_operation', operation, target }])
    }
  })

  it('passes ordinary or malformed target input with zero effects and rejects invalid transitions', () => {
    const store = new InMemoryPendingStore({ ttlMs: 1_000, clock: { now: () => 0 } })
    const useCase = new FeedbackUseCase(store)
    for (const reason of ['ordinary', 'not_feedback', 'mixed_intent', 'target_ambiguous'] as const) {
      const result = useCase.execute({ conversationKey: 'chat-a', request: request(), interpretation: { kind: 'pass', reason } })
      expect(result.kind).toBe('pass')
      expect(result.effects).toEqual([])
    }
    const forged = useCase.execute({
      conversationKey: 'chat-a', request: request(),
      interpretation: { kind: 'operation', operation: 'save', targetId: 'x:missing' },
    })
    expect(forged.kind).toBe('failure')
    expect(forged.effects).toEqual([])
    const invalid = useCase.execute({
      conversationKey: 'chat-a', request: request(), interpretation: { kind: 'reason_answer', reason: '没有等待。' },
    })
    expect(invalid.kind).toBe('failure')
    expect(invalid.effects).toEqual([])
  })

  it('passes into the ordinary root even when pass ends a pending TODO 1 state', () => {
    for (const reason of ['ordinary', 'not_feedback', 'mixed_intent', 'target_ambiguous'] as const) {
      const store = new InMemoryPendingStore({ ttlMs: 1_000, clock: { now: () => 0 } })
      const useCase = new FeedbackUseCase(store)
      const pending = useCase.execute({
        conversationKey: 'chat-a', request: request([target], '不喜欢。'),
        interpretation: { kind: 'rating', sentiment: 'dislike', targetId: target.id, dimension: 'content_value' },
      })
      expect(pending.kind).toBe('awaiting_reason')
      const passed = useCase.execute({
        conversationKey: 'chat-a', request: request([], '普通对话。'),
        interpretation: { kind: 'pass', reason },
      })
      expect(passed).toEqual({ kind: 'pass', reason, effects: [] })
      expect(store.get('chat-a')).toBeUndefined()
    }
  })

  it('drops old pending candidate before accepting a fresh target feedback', () => {
    const store = new InMemoryPendingStore({ ttlMs: 1_000, clock: { now: () => 0 } })
    const useCase = new FeedbackUseCase(store)
    const pending = useCase.execute({
      conversationKey: 'chat-a', request: request([target], '我猜是旧候选。'),
      interpretation: { kind: 'candidate_reason', sentiment: 'dislike', targetId: target.id, dimension: 'argument_quality', candidate: '旧候选。' },
    })
    expect(pending.kind).toBe('awaiting_candidate_confirmation')
    const fresh = useCase.execute({
      conversationKey: 'chat-a', request: request([target], '我喜欢，因为新理由。'),
      interpretation: { kind: 'rating', sentiment: 'like', targetId: target.id, dimension: 'content_value', reason: '新理由。' },
    })
    expect(fresh.kind).toBe('completed')
    if (fresh.kind !== 'completed') return
    const effect = fresh.effects[0]
    expect(effect.kind).toBe('append_trusted_fact')
    if (effect.kind !== 'append_trusted_fact') return
    expect(effect.fact.reason).toBe('新理由。')
    expect(effect.fact.evidence).not.toHaveProperty('candidate', '旧候选。')
    expect(store.get('chat-a')).toBeUndefined()
  })

  it('rejects duplicated or empty target identities without effects', () => {
    const store = new InMemoryPendingStore({ ttlMs: 1_000, clock: { now: () => 0 } })
    const useCase = new FeedbackUseCase(store)
    const duplicate = useCase.execute({
      conversationKey: 'chat-a', request: request([target, target]),
      interpretation: { kind: 'operation', operation: 'save', targetId: target.id },
    })
    expect(duplicate.kind).toBe('failure')
    const empty = useCase.execute({
      conversationKey: 'chat-a', request: request([{ ...target, id: ' ' }]),
      interpretation: { kind: 'operation', operation: 'save', targetId: ' ' },
    })
    expect(empty.kind).toBe('failure')
  })
})
