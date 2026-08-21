import { describe, expect, it, vi } from 'vitest'
import { createTrustedFact, isTrustedFact } from '../src/trusted-facts/model.ts'
import type {
  LocatedTrustedFact,
  NavigationHintDeriver,
  TrustedFactLocator,
} from '../src/trusted-facts/navigation-contract.ts'
import { TrustedFactNavigationProjector } from '../src/trusted-facts/navigation-projector.ts'

function aLocatedFact(): LocatedTrustedFact {
  const result = createTrustedFact({
    target: {
      id: 'post-1',
      content: 'A post',
      source: 'https://example.com/post-1',
      scope: 'x',
    },
    dimension: 'content_value',
    reason: 'Useful',
    applicationLevel: 'reusable_rule',
    evidence: {
      kind: 'user_direct',
      rawUserExpression: '记住这个判断',
      explicitApplicationLevel: 'reusable_rule',
    },
  })
  if (!result.ok) throw new Error(result.message)

  const locator: TrustedFactLocator = {
    schemaVersion: 1,
    locatorId: 'tf-jsonl-v0:1:sha256:abc',
    persistence: {
      sourceKind: 'trusted-fact-repository',
      sourceKey: 'trusted-facts.jsonl',
      lineNumber: 1,
      canonicalDigest: 'sha256:abc',
    },
  }
  return { locator, fact: result.fact }
}

function projectorFor(output: ReturnType<NavigationHintDeriver['derive']>) {
  const derive = vi.fn(() => output)
  const projector = new TrustedFactNavigationProjector(
    { derive },
    { method: 'exact-phrase', version: '1' },
  )
  return { derive, projector }
}

describe('TrustedFactNavigationProjector', () => {
  it('projects one machine-derived item without exposing fact semantics', () => {
    const located = aLocatedFact()
    const { derive, projector } = projectorFor({
      topics: [' AI 监管 ', '', 'AI 监管', '内容'],
      relations: [
        { kind: 'about-target', targetId: 'post-1' },
        { kind: 'about-target', targetId: 'post-1' },
        { kind: 'other', targetId: 'post-1' } as never,
      ],
    })

    const item = projector.project(located)

    expect(derive).toHaveBeenCalledTimes(1)
    expect(item).toMatchObject({
      schemaVersion: 1,
      kind: 'trusted-fact-navigation',
      origin: 'machine-derived',
      derivation: { method: 'exact-phrase', version: '1' },
      locator: located.locator,
      hints: {
        topics: ['AI 监管', '内容'],
        targetRefs: [{ targetId: 'post-1', canonicalSource: 'https://example.com/post-1' }],
        dimension: 'content_value',
        relations: [{ kind: 'about-target', targetId: 'post-1' }],
      },
    })
    expect(isTrustedFact(item)).toBe(false)
    for (const field of [
      'reason', 'scope', 'applicationLevel', 'evidence', 'rawUserExpression', 'content',
      'rank', 'score', 'allow', 'deny', 'filter', 'exclude', 'deliver', 'sentiment', 'preference',
    ]) {
      expect(field in item).toBe(false)
      expect(field in item.hints).toBe(false)
    }
  })

  it.each([
    { topics: [], relations: [] },
    { topics: [' AI 监管 '], relations: [{ kind: 'about-target' as const, targetId: 'post-1' }] },
    { topics: ['错误标签'], relations: [{ kind: 'about-target' as const, targetId: 'wrong-target' }] },
  ])('keeps source and fact unchanged for deriver output %#', (hints) => {
    const located = aLocatedFact()
    const factBefore = structuredClone(located.fact)
    const { projector } = projectorFor(hints)

    const item = projector.project(located)

    expect(item.locator).toBe(located.locator)
    expect(item.hints.targetRefs).toEqual([
      { targetId: located.fact.target.id, canonicalSource: located.fact.target.source },
    ])
    expect(item.hints.dimension).toBe(located.fact.dimension)
    expect(located.fact).toEqual(expect.objectContaining(factBefore))
  })

  it('freezes the projected containers while preserving the branded fact', () => {
    const located = aLocatedFact()
    const { projector } = projectorFor({ topics: ['topic'], relations: [] })

    const item = projector.project(located)

    expect(Object.isFrozen(item)).toBe(true)
    expect(Object.isFrozen(item.derivation)).toBe(true)
    expect(Object.isFrozen(item.hints)).toBe(true)
    expect(Object.isFrozen(item.hints.topics)).toBe(true)
    expect(Object.isFrozen(item.hints.targetRefs)).toBe(true)
    expect(Object.isFrozen(item.hints.relations)).toBe(true)
    expect(isTrustedFact(located.fact)).toBe(true)
  })
})
