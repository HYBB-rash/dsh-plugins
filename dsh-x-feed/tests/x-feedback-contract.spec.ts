import { describe, expect, it } from 'vitest'
import { createTrustedFact } from '../src/trusted-facts/model.ts'
import {
  serializeTrustedFact,
  serializeTrustedFactsByTarget,
  type CleanFeedbackRequest,
  type FeedbackInterpretation,
} from '../src/x-feedback/contract.ts'

const target = {
  id: 'item:11',
  content: '一段当前内容',
  source: 'https://example.test/item/11',
  scope: 'current message',
} as const

const factResult = createTrustedFact({
  target,
  dimension: 'argument_quality',
  reason: '理由具体。',
  evidence: { kind: 'user_direct', rawUserExpression: '我喜欢，因为理由具体。' },
})

describe('clean feedback contract', () => {
  it('contains current/reference target catalog, pending state, and validated facts', () => {
    if (!factResult.ok) throw new Error(factResult.message)
    const request: CleanFeedbackRequest = {
      currentMessage: { id: 11, text: '当前消息', targets: [target] },
      reference: { messageId: 10, text: '被引用消息', targets: [] },
      targetCatalog: {
        currentMessage: [target],
        reference: [],
      },
      trustedFactsByTarget: serializeTrustedFactsByTarget([factResult.fact]),
    }

    expect(request.targetCatalog.currentMessage).toEqual([target])
    expect(request.trustedFactsByTarget).toEqual({ [target.id]: [serializeTrustedFact(factResult.fact)] })
    expect(request).not.toHaveProperty('pending')
  })

  it('serializes only TODO 1 trusted facts and preserves evidence', () => {
    if (!factResult.ok) throw new Error(factResult.message)
    expect(serializeTrustedFact(factResult.fact)).toEqual({
      target,
      dimension: 'argument_quality',
      reason: '理由具体。',
      applicationLevel: 'observation',
      evidence: {
        kind: 'user_direct',
        rawUserExpression: '我喜欢，因为理由具体。',
      },
    })
    expect(() => serializeTrustedFactsByTarget([{ ...factResult.fact }])).toThrow('trusted fact')
  })

  it('keeps interpretation closed around routing and bounded state transitions', () => {
    const interpretations: FeedbackInterpretation[] = [
      { kind: 'pass', reason: 'ordinary' },
      { kind: 'pass', reason: 'not_feedback' },
      { kind: 'pass', reason: 'mixed_intent' },
      { kind: 'pass', reason: 'target_ambiguous' },
      { kind: 'operation', operation: 'save', targetId: target.id },
      { kind: 'operation', operation: 'unsave', targetId: target.id },
      { kind: 'rating', sentiment: 'like', targetId: target.id, dimension: 'argument_quality' },
      { kind: 'reason_answer', reason: '理由具体。' },
      { kind: 'prior_reason_reference', targetId: target.id, dimension: 'argument_quality' },
      { kind: 'candidate_reason', sentiment: 'dislike', targetId: target.id, dimension: 'argument_quality', candidate: '论证跳跃。' },
      { kind: 'confirm_candidate', confirmation: '对，就是这个。' },
      { kind: 'abandon_pending' },
    ]

    expect(interpretations.map(item => item.kind)).toEqual([
      'pass', 'pass', 'pass', 'pass', 'operation', 'operation', 'rating',
      'reason_answer', 'prior_reason_reference', 'candidate_reason',
      'confirm_candidate', 'abandon_pending',
    ])
    expect(interpretations[4]).not.toHaveProperty('target')
  })
})
