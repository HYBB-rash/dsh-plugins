import { describe, expect, it } from 'vitest'
import {
  evaluateScopePolicy,
  type ScopePolicyRequest,
} from '../src/trusted-facts/scope-policy.ts'
import { createTrustedFact, isTrustedFact, type FactDimension } from '../src/trusted-facts/model.ts'

const target = {
  id: 'x:123',
  content: 'A post about AI regulation',
  source: 'https://x.example/123',
  scope: 'this post',
}

function observation(overrides: Record<string, unknown> = {}) {
  const result = createTrustedFact({
    target,
    dimension: 'content_value' as FactDimension,
    reason: 'It contains a concrete example rather than a generic claim.',
    evidence: {
      kind: 'user_direct',
      rawUserExpression: '我喜欢它，因为它有具体例子。',
    },
    ...overrides,
  })
  if (!result.ok) throw new Error(result.message)
  return result.fact
}

function propose(
  fact: ReturnType<typeof observation>,
  applicationLevel: 'reusable_rule' | 'hard_exclusion' = 'reusable_rule',
): ScopePolicyRequest {
  return {
    kind: 'propose',
    observation: fact,
    candidate: 'Prefer concrete examples in future posts.',
    applicationLevel,
    rawUserExpression: '这条理由以后可能适用。',
  }
}

describe('trusted fact scope policy', () => {
  it('does not derive a fact from five similar observations', () => {
    const result = evaluateScopePolicy({
      kind: 'aggregate',
      observations: Array.from({ length: 5 }, () => observation()),
    })

    expect(result.kind).toBe('observations_only')
    if (result.kind !== 'observations_only') return
    expect(result.facts).toHaveLength(5)
    expect(result.effects).toEqual([])
  })

  it('rejects an ordinary object that is not an A-factory trusted fact', () => {
    const result = evaluateScopePolicy({
      kind: 'propose',
      observation: { ...observation() },
      candidate: 'Prefer concrete examples.',
      applicationLevel: 'reusable_rule',
      rawUserExpression: '以后也这样。',
    } as unknown as ScopePolicyRequest)

    expect(result).toMatchObject({ kind: 'rejected', code: 'untrusted_observation' })
  })

  it('forms a reusable candidate without trusting it', () => {
    const result = evaluateScopePolicy(propose(observation()))

    expect(result.kind).toBe('candidate')
    if (result.kind !== 'candidate') return
    expect(result.candidate.applicationLevel).toBe('reusable_rule')
    expect(result.candidate.isTrustedFact).toBe(false)
    expect(isTrustedFact(result.candidate)).toBe(false)
    expect(result.effects).toEqual([])
  })

  it('promotes only an explicitly confirmed reusable candidate', () => {
    const result = evaluateScopePolicy({
      kind: 'confirm',
      observation: observation(),
      candidate: 'Prefer concrete examples in future posts.',
      applicationLevel: 'reusable_rule',
      rawUserExpression: '对，这个作用以后可以复用。',
      confirmation: '明确确认作为可复用规则。',
    })

    expect(result.kind).toBe('trusted_fact')
    if (result.kind !== 'trusted_fact') return
    expect(result.fact.applicationLevel).toBe('reusable_rule')
    expect(isTrustedFact(result.fact)).toBe(true)
    expect(result.fact.evidence).toMatchObject({
      kind: 'user_confirmed_candidate',
      confirmation: '明确确认作为可复用规则。',
      explicitApplicationLevel: 'reusable_rule',
    })
  })

  it('does not turn an ordinary negative observation into hard exclusion', () => {
    const result = evaluateScopePolicy(propose(observation(), 'hard_exclusion'))

    expect(result).toMatchObject({ kind: 'rejected', code: 'hard_exclusion_requires_confirmation' })
  })

  it('promotes hard exclusion only after explicit assignment', () => {
    const result = evaluateScopePolicy({
      kind: 'confirm',
      observation: observation({
        reason: 'It makes an unsupported claim.',
        evidence: { kind: 'user_direct', rawUserExpression: '我不喜欢这个说法。' },
      }),
      candidate: 'Exclude unsupported claims of this kind.',
      applicationLevel: 'hard_exclusion',
      rawUserExpression: '以后排除这类内容。',
      confirmation: '明确赋予硬排除作用。',
    })

    expect(result.kind).toBe('trusted_fact')
    if (result.kind !== 'trusted_fact') return
    expect(result.fact.applicationLevel).toBe('hard_exclusion')
    expect(result.fact.evidence).toMatchObject({ explicitApplicationLevel: 'hard_exclusion' })
  })

  it('keeps argument quality dimension throughout and never derives content value', () => {
    const fact = observation({ dimension: 'argument_quality' })
    const candidate = evaluateScopePolicy(propose(fact))
    expect(candidate.kind).toBe('candidate')
    if (candidate.kind !== 'candidate') return
    expect(candidate.candidate.dimension).toBe('argument_quality')
    expect(candidate.candidate).not.toHaveProperty('content_value')
    expect(candidate.candidate).not.toHaveProperty('derivedDimensions')
  })
})
