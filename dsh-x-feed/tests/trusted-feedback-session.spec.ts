import { describe, expect, it } from 'vitest'
import { isTrustedFact } from '../src/trusted-facts/model.ts'
import {
  reduceFeedback,
  type FeedbackDecision,
  type FeedbackSignal,
  type FeedbackState,
} from '../src/trusted-facts/feedback-session.ts'

const target = {
  id: 'x:123',
  content: 'A post about AI regulation',
  source: 'https://x.example/123',
  scope: 'this post',
} as const

const dimension = 'content_value' as const
const idle: FeedbackState = { kind: 'idle' }

function decide(signal: FeedbackSignal, state: FeedbackState = idle): FeedbackDecision {
  return reduceFeedback(state, signal)
}

function directLikeSignal(overrides: Partial<Extract<FeedbackSignal, { kind: 'like' }>> = {}) {
  return {
    kind: 'like' as const,
    target,
    dimension,
    rawUserExpression: '我喜欢它，因为它有具体例子。',
    reason: 'It contains a concrete example rather than a generic claim.',
    ...overrides,
  }
}

function dislikeSignal(overrides: Partial<Extract<FeedbackSignal, { kind: 'dislike' }>> = {}) {
  return {
    kind: 'dislike' as const,
    target,
    dimension,
    rawUserExpression: '不喜欢这条。',
    ...overrides,
  }
}

describe('trusted feedback session reducer', () => {
  it('records save as an operation and never creates a fact', () => {
    const decision = decide({ kind: 'save', target })

    expect(decision).toMatchObject({
      kind: 'completed',
      state: { kind: 'idle' },
      effects: [{ kind: 'record_operation', operation: 'save', target }],
    })
    expect(decision.effects).not.toContainEqual(expect.objectContaining({ kind: 'append_trusted_fact' }))
  })

  it('records unsave as an operation without creating a fact', () => {
    const decision = decide({ kind: 'unsave', target })

    expect(decision).toMatchObject({
      kind: 'completed',
      state: { kind: 'idle' },
      effects: [{ kind: 'record_operation', operation: 'unsave', target }],
    })
    expect(decision.effects).not.toContainEqual(expect.objectContaining({ kind: 'append_trusted_fact' }))
  })

  it('asks for a reason after a reasonless dislike and writes nothing', () => {
    const decision = decide(dislikeSignal())

    expect(decision).toMatchObject({
      kind: 'awaiting_reason',
      ask: 'ask_for_reason',
      state: {
        kind: 'awaiting_reason',
        target,
        dimension,
        sentiment: 'dislike',
      },
      effects: [],
    })
  })

  it.each(['abandon', 'no_answer'] as const)('discards pending reason on %s with no effects', (kind) => {
    const pending = decide(dislikeSignal())
    const decision = decide({ kind }, pending.state)

    expect(decision).toEqual({ kind: 'discarded', state: idle, effects: [] })
  })

  it('does not associate a prior reason, even when there is only one candidate', () => {
    const decision = decide({
      kind: 'prior_reason_reference',
      target,
      dimension,
      rawUserExpression: '还是老问题。',
      priorReasons: ['The author is too speculative.'],
    })

    expect(decision).toMatchObject({
      kind: 'awaiting_reason',
      ask: 'ask_for_reason',
      state: { kind: 'awaiting_reason', rawUserExpression: '还是老问题。' },
      effects: [],
    })
  })

  it('keeps an external candidate pending until explicit confirmation', () => {
    const decision = decide({
      kind: 'candidate_reason',
      sentiment: 'dislike',
      target,
      dimension,
      rawUserExpression: '不喜欢。',
      candidate: 'The author is too speculative.',
    })

    expect(decision).toMatchObject({
      kind: 'awaiting_candidate_confirmation',
      ask: 'confirm_candidate',
      state: {
        kind: 'awaiting_candidate_confirmation',
        candidate: 'The author is too speculative.',
      },
      effects: [],
    })
  })

  it('creates one trusted observation only after candidate confirmation', () => {
    const pending = decide({
      kind: 'candidate_reason',
      sentiment: 'dislike',
      target,
      dimension,
      rawUserExpression: '不喜欢。',
      candidate: 'The author is too speculative.',
    })
    const decision = decide(
      { kind: 'confirm_candidate', confirmation: '对，就是这个原因。' },
      pending.state,
    )

    expect(decision.kind).toBe('completed')
    expect(decision.effects).toHaveLength(1)
    const effect = decision.effects[0]
    expect(effect.kind).toBe('append_trusted_fact')
    if (effect.kind !== 'append_trusted_fact') return

    expect(isTrustedFact(effect.fact)).toBe(true)
    expect(effect.fact).toMatchObject({
      target,
      dimension,
      applicationLevel: 'observation',
      evidence: {
        kind: 'user_confirmed_candidate',
        rawUserExpression: '不喜欢。',
        candidate: 'The author is too speculative.',
        confirmation: '对，就是这个原因。',
      },
    })
  })

  it('discards an unconfirmed candidate and does not carry it into the next decision', () => {
    const pending = decide({
      kind: 'candidate_reason',
      sentiment: 'dislike',
      target,
      dimension,
      rawUserExpression: '不喜欢。',
      candidate: 'The author is too speculative.',
    })
    const discarded = decide({ kind: 'no_answer' }, pending.state)
    const nextDecision = decide(directLikeSignal(), discarded.state)

    expect(discarded).toEqual({ kind: 'discarded', state: idle, effects: [] })
    expect(nextDecision.kind).toBe('completed')
    expect(nextDecision.effects).toHaveLength(1)
  })

  it('creates an observation from a direct user reason', () => {
    const decision = decide(directLikeSignal())

    expect(decision.kind).toBe('completed')
    expect(decision.effects).toHaveLength(1)
    const effect = decision.effects[0]
    expect(effect.kind).toBe('append_trusted_fact')
    if (effect.kind !== 'append_trusted_fact') return

    expect(isTrustedFact(effect.fact)).toBe(true)
    expect(effect.fact).toMatchObject({
      target,
      dimension,
      reason: 'It contains a concrete example rather than a generic claim.',
      applicationLevel: 'observation',
      evidence: {
        kind: 'user_direct',
        rawUserExpression: '我喜欢它，因为它有具体例子。',
      },
    })
  })

  it('returns a stable failure decision when the fact factory rejects input', () => {
    const decision = decide(directLikeSignal({ reason: '   ' }))

    expect(decision).toMatchObject({
      kind: 'failed',
      code: 'fact_rejected',
      state: { kind: 'idle' },
      effects: [],
    })
  })

  it('never exposes legacy evaluation-writing effects in concrete decisions', () => {
    const decisions = [
      decide({ kind: 'save', target }),
      decide({ kind: 'unsave', target }),
      decide(dislikeSignal()),
      decide({
        kind: 'candidate_reason',
        sentiment: 'dislike',
        target,
        dimension,
        rawUserExpression: '不喜欢。',
        candidate: 'The author is too speculative.',
      }),
      decide(directLikeSignal()),
    ]

    for (const decision of decisions) {
      for (const effect of decision.effects) {
        expect(['record_operation', 'append_trusted_fact']).toContain(effect.kind)
        expect(effect).not.toHaveProperty('record_like')
        expect(effect).not.toHaveProperty('record_dislike')
        expect(effect).not.toHaveProperty('record_feedback')
        expect(effect).not.toHaveProperty('append_legacy_feedback')
      }
    }
  })
})
