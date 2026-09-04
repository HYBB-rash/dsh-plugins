import { describe, expect, it, vi } from 'vitest'
import { buildExactFactLookup } from '../src/fact-projection/exact-fact-lookup.ts'
import {
  preflightFactProjectionWithAssessmentBinder,
  preflightFactProjection,
  type FactProjectionPreflightInput,
} from '../src/fact-projection/preflight.ts'
import {
  fingerprintCandidate,
  projectCandidateFacts,
} from '../src/fact-projection/project-candidate-facts.ts'
import { createTrustedFact, type TrustedFact } from '../src/trusted-facts/model.ts'
import type {
  LocatedTrustedFact,
  LocatedTrustedFactSnapshot,
  NavigationItem,
  NavigationSnapshot,
  Sha256Digest,
} from '../src/trusted-facts/navigation-contract.ts'

const sourceRevision = 'sha256:preflight-source' as Sha256Digest
const candidate = {
  id: 'candidate-1',
  content: 'A current X candidate',
  source: 'https://example.test/candidate-1',
} as const
const budget = {
  maxInlineFacts: 1,
  maxLookupTickets: 2,
  maxSerializedBytes: 20_000,
} as const

function factFor(index: number): TrustedFact {
  const result = createTrustedFact({
    target: {
      id: `target-${index}`,
      content: `target content ${index}`,
      source: `https://example.test/target-${index}`,
      scope: 'this candidate',
    },
    dimension: index === 1 ? 'content_value' : 'argument_quality',
    reason: `reason ${index}`,
    evidence: { kind: 'user_direct', rawUserExpression: `remember ${index}` },
  })
  if (!result.ok) throw new Error(result.message)
  return result.fact
}

function locatedFact(index: number): LocatedTrustedFact {
  const fact = factFor(index)
  return {
    locator: {
      schemaVersion: 1,
      locatorId: `locator:${index}`,
      persistence: {
        sourceKind: 'trusted-fact-repository',
        sourceKey: 'trusted-facts.jsonl',
        lineNumber: index,
        canonicalDigest: `sha256:fact-${index}`,
      },
    },
    fact,
  }
}

function navigationItem(located: LocatedTrustedFact): NavigationItem {
  return {
    schemaVersion: 1,
    kind: 'trusted-fact-navigation',
    origin: 'machine-derived',
    derivation: { method: 'test', version: '1' },
    locator: located.locator,
    hints: {
      topics: ['test-topic'],
      targetRefs: [{
        targetId: located.fact.target.id,
        canonicalSource: located.fact.target.source,
      }],
      dimension: located.fact.dimension,
      relations: [{ kind: 'about-target', targetId: located.fact.target.id }],
    },
  }
}

function sources(count = 2): { facts: LocatedTrustedFactSnapshot; navigation: NavigationSnapshot } {
  const facts = Array.from({ length: count }, (_, index) => locatedFact(index + 1))
  return {
    facts: { sourceRevision, facts },
    navigation: {
      schemaVersion: 1,
      sourceRevision,
      items: facts.map(navigationItem),
    },
  }
}

function assessmentFor(
  decisions = [
    {
      locatorId: 'locator:1',
      relevance: 'high' as const,
      essentiality: 'inline_priority' as const,
      priority: 1,
      reason: 'explicit test decision',
    },
    {
      locatorId: 'locator:2',
      relevance: 'high' as const,
      essentiality: 'lookup_only' as const,
      priority: 2,
      reason: 'explicit test decision',
    },
  ],
) {
  return {
    candidate,
    audit: {
      policyId: 'test-policy',
      policyVersion: '1',
      candidateFingerprint: fingerprintCandidate(candidate),
      decisions,
    },
  }
}

function readyInput(
  source = sources(),
  overrides: Partial<FactProjectionPreflightInput> = {},
): FactProjectionPreflightInput {
  return {
    facts: { readLocatedSnapshot: vi.fn(() => source.facts) },
    navigation: { readNavigationSnapshot: vi.fn(() => source.navigation) },
    assessment: { checkReadiness: vi.fn(() => ({ ready: true as const })) },
    budget,
    projector: vi.fn(() => projectCandidateFacts),
    lookup: vi.fn(() => buildExactFactLookup),
    ...overrides,
  }
}

function boundInput(
  source = sources(),
  overrides: Partial<Omit<FactProjectionPreflightInput, 'assessment'>> & {
    readonly assessmentBinder?: (navigation: NavigationSnapshot) => unknown
  } = {},
) {
  return {
    facts: { readLocatedSnapshot: vi.fn(() => source.facts) },
    navigation: { readNavigationSnapshot: vi.fn(() => source.navigation) },
    assessmentBinder: vi.fn((navigation: NavigationSnapshot) => ({
      checkReadiness: vi.fn(() => ({ ready: true as const })),
      navigation,
    })),
    budget,
    projector: vi.fn(() => projectCandidateFacts),
    lookup: vi.fn(() => buildExactFactLookup),
    ...overrides,
  }
}

describe('TODO5-S4 fact projection preflight', () => {
  it.each([
    ['facts-unavailable', () => { throw new Error('facts unavailable') }],
    ['navigation-unavailable', () => { throw Object.assign(new Error('missing navigation'), { code: 'ENOENT' }) }],
  ] as const)('returns %s before readiness or capability creation', (expectedCode, failingReader) => {
    const source = sources()
    const input = readyInput(source, {
      ...(expectedCode === 'facts-unavailable'
        ? { facts: { readLocatedSnapshot: vi.fn(failingReader) } }
        : { navigation: { readNavigationSnapshot: vi.fn(failingReader) } }),
    })

    const result = preflightFactProjection(input)

    expect(result).toMatchObject({ kind: 'not-ready', code: expectedCode })
    expect(result).not.toHaveProperty('session')
    expect(input.assessment.checkReadiness).not.toHaveBeenCalled()
    expect(input.projector).not.toHaveBeenCalled()
    expect(input.lookup).not.toHaveBeenCalled()
  })

  it('returns every distinct not-ready reason without creating access or a session', () => {
    const source = sources()
    const cases: Array<{
      readonly code: string
      readonly input: FactProjectionPreflightInput
    }> = [
      {
        code: 'navigation-schema-invalid',
        input: readyInput(source, {
          navigation: { readNavigationSnapshot: vi.fn(() => ({ bad: true } as never)) },
        }),
      },
      {
        code: 'source-revision-mismatch',
        input: readyInput({
          facts: source.facts,
          navigation: { ...source.navigation, sourceRevision: 'sha256:other' as Sha256Digest },
        }),
      },
      {
        code: 'assessment-policy-unavailable',
        input: readyInput(source, {
          assessment: { checkReadiness: vi.fn(() => ({ ready: false as const, message: 'policy is loading' })) },
        }),
      },
      {
        code: 'limits-unavailable',
        input: readyInput(source, { budget: { maxInlineFacts: 0, maxLookupTickets: 1, maxSerializedBytes: 1 } }),
      },
      {
        code: 'projector-unavailable',
        input: readyInput(source, { projector: vi.fn(() => { throw new Error('projector missing') }) }),
      },
      {
        code: 'lookup-unavailable',
        input: readyInput(source, { lookup: vi.fn(() => { throw new Error('lookup missing') }) }),
      },
    ]

    for (const { code, input } of cases) {
      const result = preflightFactProjection(input)
      expect(result, code).toMatchObject({ kind: 'not-ready', code })
      expect(result).not.toHaveProperty('session')
      expect(result).not.toHaveProperty('access')
      expect(result).not.toHaveProperty('registry')
    }
  })

  it('pins both snapshots once, freezes them, and builds a narrow ready session only afterwards', () => {
    const source = sources()
    const input = readyInput(source)
    const result = preflightFactProjection(input)

    expect(result).toMatchObject({ kind: 'ready' })
    expect(input.facts.readLocatedSnapshot).toHaveBeenCalledTimes(1)
    expect(input.navigation.readNavigationSnapshot).toHaveBeenCalledTimes(1)
    expect(input.assessment.checkReadiness).toHaveBeenCalledTimes(1)
    expect(input.projector).toHaveBeenCalledTimes(1)
    expect(input.lookup).toHaveBeenCalledTimes(1)
    if (result.kind !== 'ready') return

    expect(Object.keys(result)).toEqual(['kind', 'session'])
    expect(Object.keys(result.session)).toEqual(['project'])
    expect(Object.isFrozen(source.facts.facts)).toBe(false)

    const projected = result.session.project(candidate, assessmentFor())
    expect(projected).toMatchObject({
      kind: 'ready',
      view: {
        facts: [{ target: { id: 'target-1' } }],
        tickets: [{ locator: { locatorId: 'locator:2' }, selectedLocatorCount: 1 }],
      },
    })
    expect(projected).not.toHaveProperty('access')
    expect(projected).not.toHaveProperty('registry')
    expect(projected).not.toHaveProperty('audit')
    expect(projected).not.toHaveProperty('grants')

    // Mutating reader-owned objects after preflight cannot alter the pinned call.
    source.navigation.items[0]!.hints.topics.push('late-mutation')
    if (projected.kind === 'ready') {
      const repeated = result.session.project(candidate, assessmentFor())
      expect(repeated).toMatchObject({ kind: 'ready', view: projected.view })
    }
  })

  it('uses the exact grant for a lookup and does not provide a broad read method', () => {
    const source = sources()
    const result = preflightFactProjection(readyInput(source))
    expect(result.kind).toBe('ready')
    if (result.kind !== 'ready') return

    const projected = result.session.project(candidate, assessmentFor())
    expect(projected.kind).toBe('ready')
    if (projected.kind !== 'ready') return

    expect(projected.lookup('ticket:locator:2')).toMatchObject({
      kind: 'lookup-success',
      facts: [{ target: { id: 'target-2' }, reason: 'reason 2' }],
    })
    expect(projected.lookup('ticket:guessed')).toMatchObject({
      kind: 'lookup-failure', code: 'ticket_not_found',
    })
    expect(projected).not.toHaveProperty('readAll')
    expect(projected).not.toHaveProperty('listAll')
    expect(projected).not.toHaveProperty('query')
  })

  it('accepts an explicit assessment port without granting it source or model capabilities', () => {
    const source = sources()
    const result = preflightFactProjection(readyInput(source))
    expect(result.kind).toBe('ready')
    if (result.kind !== 'ready') return

    const assessment = assessmentFor()
    const assess = vi.fn(() => assessment)
    const projected = result.session.project(candidate, { assess })

    expect(projected).toMatchObject({ kind: 'ready' })
    expect(assess).toHaveBeenCalledTimes(1)
    expect(assess).toHaveBeenCalledWith({ candidate, navigation: expect.any(Array), budget })
    const request = assess.mock.calls[0]?.[0]
    expect(request).not.toHaveProperty('facts')
    expect(request).not.toHaveProperty('model')
    expect(request).not.toHaveProperty('readAll')
  })

  it('turns fake, incomplete, and malformed assessments into projection failures', () => {
    const source = sources()
    const result = preflightFactProjection(readyInput(source))
    expect(result.kind).toBe('ready')
    if (result.kind !== 'ready') return

    const assessment = assessmentFor()
    const fake = result.session.project(candidate, {
      ...assessment,
      audit: {
        ...assessment.audit,
        decisions: [
          assessment.audit.decisions[0]!,
          { ...assessment.audit.decisions[1]!, locatorId: 'locator:fake' },
        ],
      },
    })
    expect(fake).toMatchObject({ kind: 'projection-failure', code: 'unknown-locator' })

    const missing = result.session.project(candidate, {
      ...assessment,
      audit: { ...assessment.audit, decisions: [assessment.audit.decisions[0]!] },
    })
    expect(missing).toMatchObject({ kind: 'projection-failure', code: 'ambiguous-locator-set' })

    const malformed = result.session.project(candidate, {} as never)
    expect(malformed).toMatchObject({ kind: 'projection-failure', code: 'invalid-assessment-audit' })
    expect(malformed).not.toHaveProperty('view')
  })

  it('rejects duplicate, missing, and misleading navigation alignment before readiness', () => {
    const source = sources()
    const cases = [
      {
        code: 'facts-unavailable',
        facts: { ...source.facts, facts: [source.facts.facts[0]!, source.facts.facts[0]!] },
        navigation: source.navigation,
      },
      {
        code: 'navigation-schema-invalid',
        facts: source.facts,
        navigation: { ...source.navigation, items: [source.navigation.items[0]!] },
      },
      {
        code: 'navigation-schema-invalid',
        facts: source.facts,
        navigation: {
          ...source.navigation,
          items: source.navigation.items.map((item, index) => index === 0
            ? { ...item, hints: { ...item.hints, dimension: 'factual_accuracy' as const } }
            : item),
        },
      },
      {
        code: 'navigation-schema-invalid',
        facts: source.facts,
        navigation: {
          ...source.navigation,
          items: source.navigation.items.map((item, index) => index === 0
            ? { ...item, hints: { ...item.hints, targetRefs: [{ targetId: 'wrong', canonicalSource: 'https://wrong.test' }] } }
            : item),
        },
      },
    ] as const

    for (const value of cases) {
      const input = readyInput({ facts: value.facts, navigation: value.navigation })
      const result = preflightFactProjection(input)
      expect(result).toMatchObject({ kind: 'not-ready', code: value.code })
      expect(input.assessment.checkReadiness).not.toHaveBeenCalled()
      expect(input.projector).not.toHaveBeenCalled()
      expect(input.lookup).not.toHaveBeenCalled()
    }
  })

  it('rejects extra fields in the pinned fact locator wrapper', () => {
    const source = sources()
    const invalidFacts = {
      ...source.facts,
      facts: source.facts.facts.map(located => ({ ...located, extra: 'must not cross the boundary' })),
    }
    const input = readyInput({ facts: invalidFacts as never, navigation: source.navigation })
    const result = preflightFactProjection(input)
    expect(result).toMatchObject({ kind: 'not-ready', code: 'facts-unavailable' })
    expect(input.assessment.checkReadiness).not.toHaveBeenCalled()
  })

  it('rejects an invalid preflight shape with a stable projection-unavailable result', () => {
    const result = preflightFactProjection({} as FactProjectionPreflightInput)
    expect(result).toMatchObject({ kind: 'not-ready', code: 'projection-unavailable' })
    expect(result).not.toHaveProperty('session')
  })

  it('does not accept or invoke model, scrape, search, writer, or history capabilities', () => {
    const source = sources()
    const input = readyInput(source)
    const forbidden = {
      assess: vi.fn(),
      scrape: vi.fn(),
      search: vi.fn(),
      prepare: vi.fn(),
      shown: vi.fn(),
      write: vi.fn(),
      readAll: vi.fn(),
      shell: vi.fn(),
    }

    const result = preflightFactProjection({
      ...input,
      assessment: { checkReadiness: vi.fn(() => ({ ready: true as const })), ...forbidden },
      facts: { readLocatedSnapshot: vi.fn(() => source.facts), ...forbidden },
      navigation: { readNavigationSnapshot: vi.fn(() => source.navigation), ...forbidden },
    } as unknown as FactProjectionPreflightInput)

    expect(result.kind).toBe('ready')
    for (const method of Object.values(forbidden)) expect(method).not.toHaveBeenCalled()
  })
})

describe('TODO6 pinned assessment binder preflight', () => {
  it('reads each source once, passes one frozen navigation reference to the binder, and preserves it for projection', () => {
    const source = sources()
    let boundNavigation: NavigationSnapshot | undefined
    let projectedNavigation: NavigationSnapshot | undefined
    const projector = vi.fn(() => (input: Parameters<typeof projectCandidateFacts>[0]) => {
      projectedNavigation = input.navigation
      return projectCandidateFacts(input)
    })
    const assessmentBinder = vi.fn((navigation: NavigationSnapshot) => {
      boundNavigation = navigation
      return { checkReadiness: vi.fn(() => ({ ready: true as const })) }
    })
    const input = boundInput(source, { assessmentBinder, projector })

    const result = preflightFactProjectionWithAssessmentBinder(input)

    expect(result).toMatchObject({ kind: 'ready' })
    expect(input.facts.readLocatedSnapshot).toHaveBeenCalledTimes(1)
    expect(input.navigation.readNavigationSnapshot).toHaveBeenCalledTimes(1)
    expect(assessmentBinder).toHaveBeenCalledTimes(1)
    expect(boundNavigation).toBeDefined()
    expect(Object.isFrozen(boundNavigation)).toBe(true)
    expect(Object.isFrozen(boundNavigation?.items)).toBe(true)
    expect(Object.keys(result)).toEqual(['kind', 'session'])
    if (result.kind !== 'ready') return
    expect(Object.keys(result.session)).toEqual(['project'])

    const projected = result.session.project(candidate, assessmentFor())
    expect(projected).toMatchObject({ kind: 'ready' })
    expect(projector).toHaveBeenCalledTimes(1)
    expect(projectedNavigation).toBe(boundNavigation)
  })

  it('pins the binder navigation before reader-owned late mutation, including unchanged revision and changed hints', () => {
    const source = sources()
    let boundNavigation: NavigationSnapshot | undefined
    let projectedNavigation: NavigationSnapshot | undefined
    const projector = vi.fn(() => (input: Parameters<typeof projectCandidateFacts>[0]) => {
      projectedNavigation = input.navigation
      return projectCandidateFacts(input)
    })
    const input = boundInput(source, {
      assessmentBinder: vi.fn((navigation: NavigationSnapshot) => {
        boundNavigation = navigation
        return { checkReadiness: vi.fn(() => ({ ready: true as const })) }
      }),
      projector,
    })
    const result = preflightFactProjectionWithAssessmentBinder(input)
    expect(result.kind).toBe('ready')
    if (result.kind !== 'ready') return

    source.navigation.items[0]!.hints.topics.push('late-marker')
    const projected = result.session.project(candidate, assessmentFor())

    expect(projected).toMatchObject({ kind: 'ready' })
    expect(projectedNavigation).toBe(boundNavigation)
    expect(JSON.stringify(boundNavigation)).not.toContain('late-marker')
    expect(JSON.stringify(projectedNavigation)).not.toContain('late-marker')
  })

  it.each([
    ['throws', vi.fn(() => { throw new Error('binder unavailable') })],
    ['returns null', vi.fn(() => null)],
    ['returns no probe', vi.fn(() => ({ ready: true }))],
    ['returns not-ready probe', vi.fn(() => ({ checkReadiness: vi.fn(() => ({ ready: false as const })) }))],
    ['probe check throws', vi.fn(() => ({ checkReadiness: vi.fn(() => { throw new Error('check unavailable') }) }))],
  ])('maps binder %s to assessment-policy-unavailable before projector or lookup', (_label, assessmentBinder) => {
    const input = boundInput(sources(), { assessmentBinder })
    const result = preflightFactProjectionWithAssessmentBinder(input)

    expect(result).toMatchObject({ kind: 'not-ready', code: 'assessment-policy-unavailable' })
    expect(result).not.toHaveProperty('session')
    expect(result).not.toHaveProperty('access')
    expect(result).not.toHaveProperty('registry')
    expect(input.projector).not.toHaveBeenCalled()
    expect(input.lookup).not.toHaveBeenCalled()
  })

  it('does not call the binder when source, alignment, or budget validation fails', () => {
    const source = sources()
    const cases = [
      { facts: { readLocatedSnapshot: vi.fn(() => { throw new Error('facts unavailable') }) } },
      { navigation: { readNavigationSnapshot: vi.fn(() => ({ bad: true } as never)) } },
      { facts: { readLocatedSnapshot: vi.fn(() => ({ ...source.facts, sourceRevision: 'sha256:other' } as never)) } },
      { navigation: { readNavigationSnapshot: vi.fn(() => ({
        ...source.navigation,
        items: [source.navigation.items[0]!],
      })) } },
      { budget: { maxInlineFacts: 0, maxLookupTickets: 1, maxSerializedBytes: 1 } },
    ] as const

    for (const overrides of cases) {
      const input = boundInput(source, overrides)
      const result = preflightFactProjectionWithAssessmentBinder(input)
      expect(result.kind).toBe('not-ready')
      expect(input.assessmentBinder).not.toHaveBeenCalled()
    }
  })
})
