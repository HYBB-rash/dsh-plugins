import { describe, expect, it } from 'vitest'
import {
  NAVIGATION_SCHEMA_VERSION,
  type LocatedTrustedFact,
  type NavigationHintDeriver,
  type NavigationItem,
  type NavigationSnapshot,
  type NavigationSnapshotWriter,
  type LocatedTrustedFactReader,
  type LocatedTrustedFactSnapshot,
  type TrustedFactLocator,
} from '../src/trusted-facts/navigation-contract.ts'
import { createTrustedFact, isTrustedFact } from '../src/trusted-facts/model.ts'

const forbiddenNavigationFields = [
  'reason',
  'scope',
  'applicationLevel',
  'evidence',
  'rawUserExpression',
  'content',
  'rank',
  'score',
  'allow',
  'deny',
  'filter',
  'exclude',
  'deliver',
  'sentiment',
  'preference',
] as const

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
    evidence: { kind: 'user_direct', rawUserExpression: '记住这个判断' },
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

describe('trusted-fact navigation contract', () => {
  it('constructs a located fact without changing the branded fact', () => {
    const located = aLocatedFact()

    expect(isTrustedFact(located.fact)).toBe(true)
    expect(located.locator.persistence.lineNumber).toBe(1)
    expect(located.locator.persistence.sourceKind).toBe('trusted-fact-repository')
    expect('sourceRevision' in located.locator.persistence).toBe(false)
  })

  it('requires navigation items to be explicit machine-derived hints', () => {
    const located = aLocatedFact()
    const item: NavigationItem = {
      schemaVersion: 1,
      kind: 'trusted-fact-navigation',
      origin: 'machine-derived',
      derivation: { method: 'exact', version: '1' },
      locator: located.locator,
      hints: {
        topics: ['AI 监管'],
        targetRefs: [{ targetId: located.fact.target.id, canonicalSource: located.fact.target.source }],
        dimension: located.fact.dimension,
        relations: [{ kind: 'about-target', targetId: located.fact.target.id }],
      },
    }

    expect(item.origin).toBe('machine-derived')
    expect(isTrustedFact(item)).toBe(false)
    for (const field of forbiddenNavigationFields) {
      expect(field in item).toBe(false)
      expect(field in item.hints).toBe(false)
    }
  })

  it('defines replace-all ports and a versioned snapshot', () => {
    const sourceRevision = 'sha256:revision' as const
    const reader: LocatedTrustedFactReader = {
      readLocatedSnapshot: () => ({ sourceRevision, facts: [aLocatedFact()] }),
    }
    const deriver: NavigationHintDeriver = { derive: () => ({ topics: [], relations: [] }) }
    const writerCalls: NavigationSnapshot[] = []
    const writer: NavigationSnapshotWriter = { replace: (snapshot) => writerCalls.push(snapshot) }
    const locatedSnapshot: LocatedTrustedFactSnapshot = reader.readLocatedSnapshot()
    const snapshot: NavigationSnapshot = {
      schemaVersion: NAVIGATION_SCHEMA_VERSION,
      sourceRevision: locatedSnapshot.sourceRevision,
      items: [],
    }

    expect(locatedSnapshot.facts).toHaveLength(1)
    expect(locatedSnapshot.sourceRevision).toBe(sourceRevision)
    expect(deriver.derive(aLocatedFact())).toEqual({ topics: [], relations: [] })
    writer.replace(snapshot)
    expect(writerCalls).toEqual([snapshot])
    expect(NAVIGATION_SCHEMA_VERSION).toBe(1)
  })
})
