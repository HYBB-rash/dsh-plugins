import { beforeEach, describe, expect, it } from 'vitest'
import {
  createTrustedFact,
  evaluateScopePolicy,
  isTrustedFact,
  reduceFeedback,
  type FeedbackDecision,
  type FeedbackSignal,
  type FeedbackState,
} from '../src/trusted-facts/index.ts'

const target = { id: 'x:acceptance', content: 'AI regulation post', source: 'x://acceptance', scope: 'this post' } as const
const idle: FeedbackState = { kind: 'idle' }
const dimension = 'content_value' as const
const operationSink: unknown[] = []
const trustedFactSink: unknown[] = []
const evaluationLedger: unknown[] = []

function execute(decision: FeedbackDecision): void {
  for (const effect of decision.effects) {
    if (effect.kind === 'record_operation') operationSink.push(effect)
    if (effect.kind === 'append_trusted_fact') trustedFactSink.push(effect.fact)
    expect(effect.kind).not.toBe('record_evaluation')
  }
}

function decide(signal: FeedbackSignal, state: FeedbackState = idle): FeedbackDecision {
  const decision = reduceFeedback(state, signal)
  execute(decision)
  return decision
}

function observation(overrides: Record<string, unknown> = {}) {
  const result = createTrustedFact({
    target,
    dimension,
    reason: '具体例充分。',
    evidence: { kind: 'user_direct', rawUserExpression: '我喜欢，因为有具体例子。' },
    ...overrides,
  })
  if (!result.ok) throw new Error(result.message)
  return result.fact
}

describe('trusted facts: black-box acceptance and sole core出口', () => {
  beforeEach(() => {
    operationSink.length = 0
    trustedFactSink.length = 0
    evaluationLedger.length = 0
  })

  it('save records only an operation, and unsave never becomes a fact or preference', () => {
    decide({ kind: 'save', target })
    decide({ kind: 'unsave', target })
    expect(operationSink).toHaveLength(2)
    expect(trustedFactSink).toEqual([])
    expect(evaluationLedger).toEqual([])
  })

  it('reasonless dislike stays pending, then no_answer or abandon discards with zero effects', () => {
    for (const ending of ['no_answer', 'abandon'] as const) {
      const pending = decide({ kind: 'dislike', target, dimension, rawUserExpression: '不喜欢。' })
      expect(pending.kind).toBe('awaiting_reason')
      expect(decide({ kind: ending }, pending.state).kind).toBe('discarded')
    }
    expect(operationSink).toEqual([])
    expect(trustedFactSink).toEqual([])
    expect(evaluationLedger).toEqual([])
  })

  it('prior reason reference asks again even with one prior reason and has zero effects', () => {
    const decision = decide({ kind: 'prior_reason_reference', target, dimension, rawUserExpression: '还是老问题。', priorReasons: ['唯一旧理由'] })
    expect(decision.kind).toBe('awaiting_reason')
    expect(decision.effects).toEqual([])
  })

  it('direct reason creates a trusted fact with target, dimension, reason and raw evidence', () => {
    const decision = decide({ kind: 'like', target, dimension, rawUserExpression: '我喜欢，因为有例子。', reason: '具体例子充分。' })
    expect(decision.kind).toBe('completed'); expect(trustedFactSink.at(-1)).toMatchObject({ target, dimension, reason: '具体例子充分。', evidence: { rawUserExpression: '我喜欢，因为有例子。' } })
    expect(isTrustedFact(trustedFactSink.at(-1))).toBe(true)
  })

  it('candidate reason remains pending until confirmation, then creates exactly one fact preserving evidence', () => {
    const pending = decide({ kind: 'candidate_reason', sentiment: 'dislike', target, dimension, rawUserExpression: '不喜欢。', candidate: '论证跳跃。' })
    expect(pending.kind).toBe('awaiting_candidate_confirmation')
    decide({ kind: 'confirm_candidate', confirmation: '对，就是这个。' }, pending.state)
    expect(trustedFactSink).toHaveLength(1)
    expect(trustedFactSink[0]).toMatchObject({ reason: '论证跳跃。', evidence: { rawUserExpression: '不喜欢。', candidate: '论证跳跃。', confirmation: '对，就是这个。' } })
  })

  it('unconfirmed candidate is discarded and does not enter the next decision', () => {
    trustedFactSink.length = 0
    const pending = decide({ kind: 'candidate_reason', sentiment: 'dislike', target, dimension, rawUserExpression: '不喜欢。', candidate: '论证跳跃。' })
    expect(decide({ kind: 'no_answer' }, pending.state).kind).toBe('discarded')
    expect(trustedFactSink).toEqual([])
    expect(decide({ kind: 'like', target, dimension, rawUserExpression: '喜欢。', reason: '有例子。' }).kind).toBe('completed')
  })

  it('five similar observations remain five observations; aggregate and proposal create no fact/effect', () => {
    const facts = Array.from({ length: 5 }, () => observation())
    const aggregate = evaluateScopePolicy({ kind: 'aggregate', observations: facts })
    expect(aggregate).toMatchObject({ kind: 'observations_only', effects: [] })
    if (aggregate.kind === 'observations_only') {
      expect(aggregate.facts).toHaveLength(5)
    }
    const trustedFactCountBeforeProposal = trustedFactSink.length
    const proposal = evaluateScopePolicy({ kind: 'propose', observation: facts[0], candidate: '以后都排除。', applicationLevel: 'reusable_rule', rawUserExpression: '可能适用。' })
    expect(proposal).toMatchObject({ kind: 'candidate', effects: [] })
    if (proposal.kind === 'candidate') {
      expect(isTrustedFact(proposal.candidate)).toBe(false)
    }
    expect(trustedFactSink).toHaveLength(trustedFactCountBeforeProposal)
  })

  it('argument quality remains argument_quality throughout and never becomes content_value', () => {
    const fact = observation({ dimension: 'argument_quality', reason: '论证很差。' })
    const proposal = evaluateScopePolicy({ kind: 'propose', observation: fact, candidate: '论证很差。', applicationLevel: 'reusable_rule', rawUserExpression: '以后关注论证。' })
    expect(fact.dimension).toBe('argument_quality')
    expect(proposal).toMatchObject({ kind: 'candidate', candidate: { dimension: 'argument_quality' } })
    if (proposal.kind === 'candidate') {
      expect(isTrustedFact(proposal.candidate)).toBe(false)
      expect(proposal.candidate).not.toHaveProperty('content_value')
      expect(proposal.candidate).not.toHaveProperty('derivedFact')
    }
    expect(trustedFactSink).toEqual([])
  })

  it('ordinary negative proposal is not hard exclusion; explicit confirmation is required', () => {
    const fact = observation({ reason: '不喜欢这个说法。' })
    const proposal = evaluateScopePolicy({ kind: 'propose', observation: fact, candidate: '排除这类内容。', applicationLevel: 'hard_exclusion', rawUserExpression: '以后排除。' })
    expect(proposal).toMatchObject({ kind: 'rejected' })
    expect(proposal).not.toHaveProperty('fact')
    const confirmed = evaluateScopePolicy({ kind: 'confirm', observation: fact, candidate: '排除这类内容。', applicationLevel: 'hard_exclusion', rawUserExpression: '以后排除。', confirmation: '明确设为硬排除。' })
    expect(confirmed).toMatchObject({ kind: 'trusted_fact', fact: { applicationLevel: 'hard_exclusion' } })
    if (confirmed.kind === 'trusted_fact') {
      expect(isTrustedFact(confirmed.fact)).toBe(true)
    }
  })
})
