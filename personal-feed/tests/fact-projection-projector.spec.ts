import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  ProjectCandidateFacts,
  fingerprintCandidate,
  projectCandidateFacts,
  type ProjectCandidateFactsInput,
} from '../src/fact-projection/project-candidate-facts.ts'
import type {
  CandidateDescriptor,
  CandidateFactAssessment,
  CandidateFactAssessmentPort,
  CandidateFactAssessmentAudit,
  ProjectionBudget,
  ProjectionNotReady,
} from '../src/fact-projection/contracts.ts'
import { createTrustedFact, type TrustedFact } from '../src/trusted-facts/model.ts'
import type {
  LocatedTrustedFact,
  LocatedTrustedFactSnapshot,
  NavigationItem,
  NavigationSnapshot,
  Sha256Digest,
  TrustedFactLocator,
} from '../src/trusted-facts/navigation-contract.ts'

const candidate: CandidateDescriptor = {
  id: 'candidate-1',
  content: 'A candidate post',
  source: 'https://example.test/candidate-1',
}

const budget: ProjectionBudget = {
  maxInlineFacts: 2,
  maxLookupTickets: 2,
  maxSerializedBytes: 20_000,
}

function factFor(index: number, reason = `reason-${index}`): TrustedFact {
  const result = createTrustedFact({
    target: {
      id: `target-${index}`,
      content: `target content ${index}`,
      source: `https://example.test/target-${index}`,
      scope: 'this candidate',
    },
    dimension: index % 2 === 0 ? 'argument_quality' : 'content_value',
    reason,
    applicationLevel: 'observation',
    evidence: {
      kind: 'user_direct',
      rawUserExpression: `remember ${index}`,
    },
  })
  if (!result.ok) throw new Error(result.message)
  return result.fact
}

function locatorFor(index: number): TrustedFactLocator {
  return {
    schemaVersion: 1,
    locatorId: `locator:${index}`,
    persistence: {
      sourceKind: 'trusted-fact-repository',
      sourceKey: 'trusted-facts.jsonl',
      lineNumber: index,
      canonicalDigest: `sha256:${index}`,
    },
  }
}

function located(index: number, reason?: string): LocatedTrustedFact {
  return { locator: locatorFor(index), fact: factFor(index, reason) }
}

function locatedWithSharedTarget(index: number): LocatedTrustedFact {
  const original = factFor(index)
  const result = createTrustedFact({
    target: {
      ...original.target,
      id: 'shared-target',
      source: 'https://example.test/shared',
    },
    dimension: 'content_value',
    reason: original.reason,
    applicationLevel: original.applicationLevel,
    evidence: original.evidence,
  })
  if (!result.ok) throw new Error(result.message)
  return { locator: locatorFor(index), fact: result.fact }
}

function navigationFor(index: number, overrides: Partial<NavigationItem['hints']> = {}): NavigationItem {
  const fact = factFor(index)
  return {
    schemaVersion: 1,
    kind: 'trusted-fact-navigation',
    origin: 'machine-derived',
    derivation: { method: 'test', version: '1' },
    locator: locatorFor(index),
    hints: {
      topics: [`topic-${index}`],
      targetRefs: [{ targetId: fact.target.id, canonicalSource: fact.target.source }],
      dimension: fact.dimension,
      relations: [{ kind: 'about-target', targetId: fact.target.id }],
      ...overrides,
    },
  }
}

function snapshots(
  indexes: readonly number[],
  navigationIndexes = indexes,
): { facts: LocatedTrustedFactSnapshot; navigation: NavigationSnapshot } {
  const sourceRevision = 'sha256:source' as Sha256Digest
  return {
    facts: { sourceRevision, facts: indexes.map(index => located(index)) },
    navigation: {
      schemaVersion: 1,
      sourceRevision,
      items: navigationIndexes.map(index => navigationFor(index)),
    },
  }
}

function assessmentFor(
  navigation: NavigationSnapshot,
  decisions: CandidateFactAssessmentAudit['decisions'],
  assessmentCandidate = candidate,
): CandidateFactAssessment {
  return {
    candidate: assessmentCandidate,
    audit: {
      policyId: 'test-policy',
      policyVersion: '1',
      candidateFingerprint: fingerprintCandidate(assessmentCandidate),
      decisions,
    },
  }
}

function decision(
  locatorId: string,
  options: Partial<CandidateFactAssessmentAudit['decisions'][number]> = {},
): CandidateFactAssessmentAudit['decisions'][number] {
  return {
    locatorId,
    relevance: 'high',
    essentiality: 'inline_priority',
    priority: 1,
    reason: 'assessment reason',
    ...options,
  }
}

function input(
  source: ReturnType<typeof snapshots>,
  assessment: ProjectCandidateFactsInput['assessment'],
  overrides: Partial<Omit<ProjectCandidateFactsInput, 'candidate' | 'facts' | 'navigation' | 'budget' | 'assessment'>> = {},
): ProjectCandidateFactsInput {
  return {
    candidate,
    facts: source.facts,
    navigation: source.navigation,
    budget,
    assessment,
    ...overrides,
  }
}

describe('ProjectCandidateFacts', () => {
  it('projects the four assessment bands with their fixed visibility rules', () => {
    const source = snapshots([1, 2, 3, 4])
    const assessment = assessmentFor(source.navigation, [
      decision('locator:1', { relevance: 'high', essentiality: 'inline_priority', priority: 1 }),
      decision('locator:2', { relevance: 'high', essentiality: 'lookup_only', priority: 2 }),
      decision('locator:3', { relevance: 'low_confidence', essentiality: 'lookup_only', priority: 3 }),
      decision('locator:4', { relevance: 'unrelated', essentiality: 'lookup_only', priority: 4 }),
    ])

    const result = projectCandidateFacts(input(source, assessment))

    expect(result).toMatchObject({
      view: {
        facts: [{ target: { id: 'target-1' } }],
        tickets: [
          { selectedLocatorCount: 1, locator: { locatorId: 'locator:2' } },
          { selectedLocatorCount: 1, locator: { locatorId: 'locator:3' } },
        ],
      },
    })
    expect(result.view.facts).toHaveLength(1)
    expect(result.view.tickets).toHaveLength(2)
    expect(result.view.facts.map(fact => fact.target.id)).not.toContain('target-4')
    expect(result.grants.map(grant => grant.locatorIds)).toEqual([['locator:2'], ['locator:3']])
  })

  it('keeps every trusted fact DTO field, including scope and evidence', () => {
    const source = snapshots([1])
    const assessment = assessmentFor(source.navigation, [decision('locator:1')])
    const result = projectCandidateFacts(input(source, assessment))

    expect(result.view.facts[0]).toEqual({
      target: {
        id: 'target-1',
        content: 'target content 1',
        source: 'https://example.test/target-1',
        scope: 'this candidate',
      },
      dimension: 'content_value',
      reason: 'reason-1',
      applicationLevel: 'observation',
      evidence: { kind: 'user_direct', rawUserExpression: 'remember 1' },
    })
  })

  it('inlines high-priority facts first and turns lower priority overflow into exact tickets', () => {
    const source = snapshots([1, 2, 3])
    const assessment = assessmentFor(source.navigation, [
      decision('locator:1', { priority: 20 }),
      decision('locator:2', { priority: 1 }),
      decision('locator:3', { priority: 10 }),
    ])
    const result = projectCandidateFacts(input(source, assessment, {
      budget: { ...budget, maxInlineFacts: 2, maxLookupTickets: 1 },
    }))

    expect(result.view.facts.map(fact => fact.target.id)).toEqual(['target-2', 'target-3'])
    expect(result.view.tickets).toHaveLength(1)
    expect(result.view.tickets[0].locator.locatorId).toBe('locator:1')
    expect(result.grants[0].locatorIds).toEqual(['locator:1'])
  })

  it('groups only a common target-reference and dimension summary, retaining every exact locator', () => {
    const source = snapshots([1, 3], [1, 3])
    const sharedFacts: LocatedTrustedFactSnapshot = {
      ...source.facts,
      facts: [locatedWithSharedTarget(1), locatedWithSharedTarget(3)],
    }
    const sharedTargetRefs = [{ targetId: 'shared-target', canonicalSource: 'https://example.test/shared' }]
    const groupedNavigation: NavigationSnapshot = {
      ...source.navigation,
      items: source.navigation.items.map(item => ({
        ...item,
        hints: { ...item.hints, targetRefs: sharedTargetRefs },
      })),
    }
    const assessment = assessmentFor(groupedNavigation, [
      decision('locator:3', { relevance: 'low_confidence', essentiality: 'lookup_only', priority: 2 }),
      decision('locator:1', { relevance: 'high', essentiality: 'lookup_only', priority: 1 }),
    ])

    const result = projectCandidateFacts(input({ facts: sharedFacts, navigation: groupedNavigation }, assessment, {
      budget: { ...budget, maxLookupTickets: 1 },
    }))

    expect(result.view.tickets).toHaveLength(1)
    expect(result.view.tickets[0]).toMatchObject({
      selectedLocatorCount: 2,
      targetRefs: sharedTargetRefs,
      dimension: 'content_value',
    })
    expect(result.grants[0].locatorIds).toEqual(['locator:1', 'locator:3'])
  })

  it('rejects navigation target references or dimensions that disagree with the located fact', () => {
    const source = snapshots([1])
    const wrongTargetNavigation: NavigationSnapshot = {
      ...source.navigation,
      items: source.navigation.items.map(item => ({
        ...item,
        hints: {
          ...item.hints,
          targetRefs: [{ targetId: 'wrong-target', canonicalSource: 'https://example.test/wrong' }],
        },
      })),
    }
    const wrongTargetAssessment = assessmentFor(wrongTargetNavigation, [decision('locator:1')])
    expect(projectCandidateFacts(input({ ...source, navigation: wrongTargetNavigation }, wrongTargetAssessment)))
      .toMatchObject({ kind: 'projection-failure', code: 'unrepresentable' })

    const wrongDimensionNavigation: NavigationSnapshot = {
      ...source.navigation,
      items: source.navigation.items.map(item => ({
        ...item,
        hints: { ...item.hints, dimension: 'factual_accuracy' },
      })),
    }
    const wrongDimensionAssessment = assessmentFor(wrongDimensionNavigation, [decision('locator:1')])
    expect(projectCandidateFacts(input({ ...source, navigation: wrongDimensionNavigation }, wrongDimensionAssessment)))
      .toMatchObject({ kind: 'projection-failure', code: 'unrepresentable' })
  })

  it('uses the canonical locator key to break equal priorities independently of input order', () => {
    const source = snapshots([3, 1], [3, 1])
    const assessment = assessmentFor(source.navigation, [
      decision('locator:3', { priority: 7 }),
      decision('locator:1', { priority: 7 }),
    ])

    const result = projectCandidateFacts(input(source, assessment))

    expect(result.view.facts.map(fact => fact.target.id)).toEqual(['target-1', 'target-3'])
  })

  it('turns a whole fact into a ticket when adding it would exceed canonical UTF-8 bytes', () => {
    const base = snapshots([1])
    const source = {
      facts: { ...base.facts, facts: [located(1, 'x'.repeat(600))] },
      navigation: base.navigation,
    }
    const assessment = assessmentFor(source.navigation, [decision('locator:1')])
    const result = projectCandidateFacts(input(source, assessment, {
      budget: { maxInlineFacts: 1, maxLookupTickets: 1, maxSerializedBytes: 450 },
    }))

    expect(result.view.facts).toEqual([])
    expect(result.view.tickets).toHaveLength(1)
    expect(result.view.tickets[0].selectedLocatorCount).toBe(1)
  })

  it('keeps low-confidence facts as tickets and excludes unrelated facts and grants', () => {
    const source = snapshots([1, 2, 3])
    const assessment = assessmentFor(source.navigation, [
      decision('locator:1', { relevance: 'low_confidence', essentiality: 'lookup_only', priority: 1 }),
      decision('locator:2', { relevance: 'unrelated', essentiality: 'lookup_only', priority: 2 }),
      decision('locator:3', { relevance: 'high', essentiality: 'lookup_only', priority: 3 }),
    ])
    const result = projectCandidateFacts(input(source, assessment))

    expect(result.view.facts).toEqual([])
    expect(result.view.tickets.map(ticket => ticket.locator.locatorId)).toEqual(['locator:1', 'locator:3'])
    expect(result.grants.flatMap(grant => grant.locatorIds)).not.toContain('locator:2')
  })

  it('is invariant from 2 to 200 facts/navigation items, including 100x unrelated noise and a new revision', () => {
    const small = snapshots([1, 2], [1, 2])
    const smallAssessment = assessmentFor(small.navigation, [
      decision('locator:1', { priority: 1 }),
      decision('locator:2', { relevance: 'high', essentiality: 'lookup_only', priority: 2 }),
    ])
    const largeIndexes = [1, 2, ...Array.from({ length: 198 }, (_, index) => index + 3)]
    const large = snapshots(largeIndexes, largeIndexes)
    const largeWithDifferentRevision = {
      facts: { ...large.facts, sourceRevision: 'sha256:large' as Sha256Digest },
      navigation: { ...large.navigation, sourceRevision: 'sha256:large' as Sha256Digest },
    }
    const largeAssessment = assessmentFor(large.navigation, [
      ...smallAssessment.audit.decisions,
      ...Array.from({ length: 198 }, (_, index) => decision(`locator:${index + 3}`, {
        relevance: 'unrelated',
        essentiality: 'lookup_only',
        priority: 3 + index,
      })),
    ])

    const first = projectCandidateFacts(input(small, smallAssessment))
    const second = projectCandidateFacts(input(largeWithDifferentRevision, largeAssessment))

    expect(small.facts.facts).toHaveLength(2)
    expect(largeWithDifferentRevision.facts.facts).toHaveLength(200)
    expect(small.facts.sourceRevision).not.toBe(largeWithDifferentRevision.facts.sourceRevision)
    expect(second.view.facts).toEqual(first.view.facts)
    expect(second.view.tickets).toEqual(first.view.tickets)
    expect([...second.view.serializedBytes]).toEqual([...first.view.serializedBytes])
  })

  it('rejects fake locator ids, missing decisions, candidate mismatch, and source mismatch as structured failures', () => {
    const source = snapshots([1, 2])
    const fake = assessmentFor(source.navigation, [
      decision('locator:fake'),
      decision('locator:2'),
    ])
    const missing = assessmentFor(source.navigation, [decision('locator:1')])
    const mismatchedCandidate = assessmentFor(source.navigation, [
      decision('locator:1'),
      decision('locator:2'),
    ], { ...candidate, id: 'other-candidate' })

    expect(projectCandidateFacts(input(source, fake))).toMatchObject({ kind: 'projection-failure', code: 'unknown-locator' })
    expect(projectCandidateFacts(input(source, missing))).toMatchObject({ kind: 'projection-failure', code: 'ambiguous-locator-set' })
    expect(projectCandidateFacts(input(source, mismatchedCandidate))).toMatchObject({ kind: 'projection-failure', code: 'invalid-assessment-audit' })

    const sourceMismatch = {
      facts: { ...source.facts, sourceRevision: 'sha256:other' as Sha256Digest },
      navigation: source.navigation,
    }
    expect(projectCandidateFacts(input(sourceMismatch, assessmentFor(source.navigation, [
      decision('locator:1'),
      decision('locator:2'),
    ])))).toMatchObject({ kind: 'projection-failure', code: 'unrepresentable' })
  })

  it('rejects heterogeneous ticket groups when the ticket budget cannot represent them', () => {
    const source = snapshots([1, 2])
    const assessment = assessmentFor(source.navigation, [
      decision('locator:1', { relevance: 'high', essentiality: 'lookup_only', priority: 1 }),
      decision('locator:2', { relevance: 'low_confidence', essentiality: 'lookup_only', priority: 2 }),
    ])
    const result = projectCandidateFacts(input(source, assessment, {
      budget: { ...budget, maxLookupTickets: 1 },
    }))

    expect(result).toMatchObject({ kind: 'projection-failure', code: 'unrepresentable' })
  })

  it('keeps counts and bytes within fixed budget and keeps audit/grants outside the view', () => {
    const source = snapshots([1, 2, 3])
    const assessment = assessmentFor(source.navigation, [
      decision('locator:1', { priority: 1 }),
      decision('locator:2', { priority: 2 }),
      decision('locator:3', { relevance: 'high', essentiality: 'lookup_only', priority: 3 }),
    ])
    const limits = { maxInlineFacts: 1, maxLookupTickets: 2, maxSerializedBytes: 4_000 }
    const result = projectCandidateFacts(input(source, assessment, { budget: limits }))

    expect(result.view.facts.length).toBeLessThanOrEqual(limits.maxInlineFacts)
    expect(result.view.tickets.length).toBeLessThanOrEqual(limits.maxLookupTickets)
    expect(result.view.serializedBytes.byteLength).toBeLessThanOrEqual(limits.maxSerializedBytes)
    expect(Object.keys(result.view).sort()).toEqual(['facts', 'serializedBytes', 'tickets'])
    expect(result.view).not.toHaveProperty('audit')
    expect(result.view).not.toHaveProperty('grants')
    expect(result.audit).toEqual(assessment.audit)
    expect(result.grants).toHaveLength(result.view.tickets.length)
  })

  it('propagates assessment not-ready without manufacturing a capability', () => {
    const source = snapshots([1])
    const notReady: ProjectionNotReady = {
      kind: 'not-ready',
      code: 'assessment-policy-unavailable',
      message: 'assessment unavailable',
    }
    const result = projectCandidateFacts(input(source, notReady))
    expect(result).toEqual(notReady)
    expect(result).not.toHaveProperty('view')
    expect(result).not.toHaveProperty('grants')
  })

  it('accepts a port and calls it with only the current candidate, neutral navigation, and budget', () => {
    const source = snapshots([1])
    const assessment = assessmentFor(source.navigation, [decision('locator:1')])
    const assess = vi.fn(() => assessment)
    const port: CandidateFactAssessmentPort = { assess }
    const result = projectCandidateFacts(input(source, port))

    expect(result.view.facts).toHaveLength(1)
    expect(assess).toHaveBeenCalledWith({ candidate, navigation: source.navigation.items, budget })
  })

  it('can retain the assessment port on the pure use-case and keep the input model-only', () => {
    const source = snapshots([1])
    const assess = vi.fn(() => assessmentFor(source.navigation, [decision('locator:1')]))
    const useCase = new ProjectCandidateFacts({ assess })
    const result = useCase.execute({
      candidate,
      facts: source.facts,
      navigation: source.navigation,
      budget,
    })

    expect(result.view.facts).toHaveLength(1)
    expect(assess).toHaveBeenCalledTimes(1)
  })

  it('uses a deterministic candidate fingerprint', () => {
    expect(fingerprintCandidate(candidate)).toBe(
      `sha256:${createHash('sha256').update(JSON.stringify([candidate.id, candidate.content, candidate.source])).digest('hex')}`,
    )
  })
})
