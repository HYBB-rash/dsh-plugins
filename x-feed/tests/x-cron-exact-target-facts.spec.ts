import { describe, expect, it } from 'vitest'
import { buildExactTargetFacts, createExactTargetAssessment } from '../src/x-cron/exact-target-facts.ts'
import { createTrustedFact } from '../src/trusted-facts/model.ts'
import type {
  LocatedTrustedFact,
  NavigationItem,
  NavigationSnapshot,
  Sha256Digest,
} from '../src/trusted-facts/navigation-contract.ts'

const revision = 'sha256:exact-target-revision' as Sha256Digest
const candidate = {
  id: 'target-1',
  content: '当前候选正文',
  source: 'https://x.com/alice/status/1',
} as const
const budget = { maxInlineFacts: 6, maxLookupTickets: 6, maxSerializedBytes: 16_000 } as const

function located(locatorId: string, target = candidate): LocatedTrustedFact {
  const created = createTrustedFact({
    target: { id: target.id, content: target.content, source: target.source, scope: 'exact target' },
    dimension: 'content_value',
    reason: `reason-${locatorId}`,
    evidence: { kind: 'user_direct', rawUserExpression: `remember ${locatorId}` },
  })
  if (!created.ok) throw new Error(created.message)
  return {
    locator: {
      schemaVersion: 1,
      locatorId,
      persistence: {
        sourceKind: 'trusted-fact-repository',
        sourceKey: 'trusted-facts.jsonl',
        lineNumber: Number(locatorId.replace('locator:', '')) || 1,
        canonicalDigest: `sha256:${locatorId}`,
      },
    },
    fact: created.fact,
  }
}

function navigation(locatedFact: LocatedTrustedFact, targetId = locatedFact.fact.target.id, source = locatedFact.fact.target.source): NavigationItem {
  return {
    schemaVersion: 1,
    kind: 'trusted-fact-navigation',
    origin: 'machine-derived',
    derivation: { method: 'test', version: '1' },
    locator: locatedFact.locator,
    hints: {
      topics: ['unrelated-topic'],
      targetRefs: [{ targetId, canonicalSource: source }],
      dimension: locatedFact.fact.dimension,
      relations: [{ kind: 'about-target', targetId }],
    },
  }
}

function source(extra: readonly LocatedTrustedFact[] = []): {
  readonly facts: { readonly sourceRevision: Sha256Digest; readonly facts: readonly LocatedTrustedFact[] }
  readonly navigation: NavigationSnapshot
} {
  const exact = located('locator:1')
  const facts = [exact, ...extra]
  return {
    facts: { sourceRevision: revision, facts },
    navigation: {
      schemaVersion: 1,
      sourceRevision: revision,
      items: facts.map(item => navigation(item)),
    },
  }
}

describe('exact target facts projection', () => {
  it('returns a frozen assessment and delegates the same audit policy to projection', () => {
    const snapshots = source()
    const assessment = createExactTargetAssessment({ candidate, navigation: snapshots.navigation })
    expect('kind' in assessment).toBe(false)
    if ('kind' in assessment) return
    expect(Object.isFrozen(assessment)).toBe(true)
    expect(Object.isFrozen(assessment.audit)).toBe(true)
    expect(Object.isFrozen(assessment.audit.decisions)).toBe(true)
    expect(Object.isFrozen(assessment.audit.decisions[0])).toBe(true)
    const projected = buildExactTargetFacts({ candidate, ...snapshots, budget })
    expect('view' in projected).toBe(true)
    if (!('view' in projected)) return
    expect(projected.audit).toEqual(assessment.audit)
  })

  it('accepts an empty aligned snapshot without inventing facts', () => {
    const empty: NavigationSnapshot = { schemaVersion: 1, sourceRevision: revision, items: [] }
    const facts = { sourceRevision: revision, facts: [] as readonly LocatedTrustedFact[] }
    const assessment = createExactTargetAssessment({ candidate, navigation: empty })
    expect('kind' in assessment).toBe(false)
    const projected = buildExactTargetFacts({ candidate, facts, navigation: empty, budget })
    expect(projected).toHaveProperty('view.facts', [])
  })

  it('matches only exact target identity/source/relation and marks the match high inline', () => {
    const result = buildExactTargetFacts({ candidate, ...source(), budget })

    expect(result).toHaveProperty('view')
    if (!('view' in result)) return
    expect(result.view.facts).toHaveLength(1)
    expect(result.audit.decisions).toContainEqual(expect.objectContaining({
      locatorId: 'locator:1', relevance: 'high', essentiality: 'inline_priority',
    }))
  })

  it('does not change the target DTO or bytes when 200 or 10k unrelated facts are appended', () => {
    const exact = buildExactTargetFacts({ candidate, ...source(), budget })
    const unrelated = (count: number) => Array.from({ length: count }, (_, index) => {
      const other = { ...candidate, id: `other-${index}`, source: `https://x.com/other/status/${index + 2}` }
      const item = located(`locator:${index + 2}`, other)
      return item
    })
    const twoHundred = buildExactTargetFacts({ candidate, ...source(unrelated(199)), budget })
    const tenThousand = buildExactTargetFacts({ candidate, ...source(unrelated(9_999)), budget })

    expect(twoHundred).toHaveProperty('view')
    expect(tenThousand).toHaveProperty('view')
    if (!('view' in exact) || !('view' in twoHundred) || !('view' in tenThousand)) return
    expect(twoHundred.view).toEqual(exact.view)
    expect(tenThousand.view).toEqual(exact.view)
    expect(Buffer.byteLength(JSON.stringify(twoHundred.view), 'utf8')).toBe(
      Buffer.byteLength(JSON.stringify(exact.view), 'utf8'),
    )
  })

  it.each([
    ['revision mismatch', (value: ReturnType<typeof source>) => ({ ...value, facts: { ...value.facts, sourceRevision: 'sha256:other' as Sha256Digest } })],
    ['alignment mismatch', (value: ReturnType<typeof source>) => ({ ...value, navigation: { ...value.navigation, sourceRevision: 'sha256:other' as Sha256Digest } })],
    ['identity mismatch', (value: ReturnType<typeof source>) => ({ ...value, facts: { ...value.facts, facts: [located('locator:1', { ...candidate, id: 'different-target' })] } })],
  ] as const)('fails closed for %s', (_name, mutate) => {
    const result = buildExactTargetFacts({ candidate, ...mutate(source()), budget })
    expect(result.kind).not.toBe('ready')
  })
})
