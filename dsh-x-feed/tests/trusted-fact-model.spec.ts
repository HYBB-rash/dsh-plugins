import { describe, expect, it } from 'vitest'
import {
  ApplicationLevel,
  createTrustedFact,
  FactDimension,
  isTrustedFact,
  type TrustedFact,
} from '../src/trusted-facts/model.ts'

const target = {
  id: 'x:123',
  content: 'A post about AI regulation',
  source: 'https://x.example/123',
  scope: 'this post',
}

function directInput(overrides: Record<string, unknown> = {}) {
  return {
    target,
    dimension: 'content_value' as FactDimension,
    reason: 'It contains a concrete example rather than a generic claim.',
    evidence: {
      kind: 'user_direct' as const,
      rawUserExpression: '我喜欢它，因为它有具体例子，不是泛泛而谈。',
    },
    ...overrides,
  }
}

describe('trusted fact admission model', () => {
  it('creates a complete observation from a direct user reason', () => {
    const result = createTrustedFact(directInput())

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.fact).toMatchObject({
      target,
      dimension: 'content_value',
      reason: 'It contains a concrete example rather than a generic claim.',
      applicationLevel: 'observation',
      evidence: {
        kind: 'user_direct',
        rawUserExpression: '我喜欢它，因为它有具体例子，不是泛泛而谈。',
      },
    })
    expect(isTrustedFact(result.fact)).toBe(true)
  })

  it('rejects an external candidate without explicit user confirmation', () => {
    const result = createTrustedFact({
      ...directInput(),
      reason: 'The author is probably too speculative.',
      evidence: {
        kind: 'candidate',
        rawUserExpression: '不喜欢',
        candidate: 'The author is probably too speculative.',
      },
    })

    expect(result).toMatchObject({ ok: false, code: 'candidate_not_confirmed' })
  })

  it('promotes a confirmed candidate while retaining candidate and confirmation text', () => {
    const result = createTrustedFact({
      ...directInput(),
      reason: 'The author is too speculative.',
      evidence: {
        kind: 'user_confirmed_candidate',
        rawUserExpression: '对，就是这个原因。',
        candidate: 'The author is probably too speculative.',
        confirmation: '对，就是这个原因。',
      },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.fact.evidence).toEqual({
      kind: 'user_confirmed_candidate',
      rawUserExpression: '对，就是这个原因。',
      candidate: 'The author is probably too speculative.',
      confirmation: '对，就是这个原因。',
    })
  })

  it('keeps argument quality as one dimension and does not derive content value', () => {
    const result = createTrustedFact(
      directInput({ dimension: 'argument_quality' as FactDimension }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.fact.dimension).toBe('argument_quality')
    expect(result.fact).not.toHaveProperty('derivedDimensions')
    expect(result.fact).not.toHaveProperty('contentValue')
  })

  it('rejects an ordinary negative reason as a hard exclusion', () => {
    const result = createTrustedFact({
      ...directInput(),
      applicationLevel: 'hard_exclusion' as ApplicationLevel,
    })

    expect(result).toMatchObject({ ok: false, code: 'application_level_not_confirmed' })
  })

  it('accepts a hard exclusion only when the user explicitly assigns that force', () => {
    const result = createTrustedFact({
      ...directInput(),
      applicationLevel: 'hard_exclusion' as ApplicationLevel,
      evidence: {
        kind: 'user_direct',
        rawUserExpression: '以后明确排除这类内容。',
        explicitApplicationLevel: 'hard_exclusion',
      },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.fact.applicationLevel).toBe('hard_exclusion')
  })

  it.each([
    ['target id', { target: { ...target, id: '   ' } }, 'empty_target_id'],
    ['reason', { reason: '  ' }, 'empty_reason'],
    [
      'raw expression',
      {
        evidence: { kind: 'user_direct', rawUserExpression: '\n' },
      },
      'empty_raw_user_expression',
    ],
  ])('rejects an empty %s', (_label, overrides, code) => {
    const result = createTrustedFact(directInput(overrides))

    expect(result).toMatchObject({ ok: false, code })
  })

  it('does not trust ordinary objects or forged structural brands', () => {
    const ordinaryObject = { ...target, dimension: 'content_value' }
    const forgedObject = {
      ...ordinaryObject,
      __brand: 'TrustedFact',
    }

    expect(isTrustedFact(ordinaryObject)).toBe(false)
    expect(isTrustedFact(forgedObject)).toBe(false)
  })

  it('requires the module-private type brand for TrustedFact assignment', () => {
    const structuralFact = {
      target,
      dimension: 'content_value' as const,
      reason: 'A complete reason.',
      applicationLevel: 'observation' as const,
      evidence: {
        kind: 'user_direct' as const,
        rawUserExpression: '我明确说出的理由。',
      },
    }

    // @ts-expect-error The unique brand is intentionally inaccessible outside the module.
    const typedFact: TrustedFact = structuralFact

    expect(isTrustedFact(typedFact)).toBe(false)
  })
})
