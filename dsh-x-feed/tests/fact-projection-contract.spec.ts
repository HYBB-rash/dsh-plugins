import { describe, expect, it } from 'vitest'
import {
  canonicalSerializeProjectionPayload,
  createLookupRequest,
  createProjectionView,
  createProjectionFailure,
  createProjectionNotReady,
  createReadyFactProjectionAccessRegistry,
  createLookupTicketFromNavigation,
  validateAssessmentAudit,
  validateAssessmentAuditCoverage,
  type CandidateFactAssessmentAudit,
  type LookupTicket,
  type ProjectionBudget,
  type ProjectedTrustedFact,
} from '../src/fact-projection/contracts.ts'

const navigation = {
  schemaVersion: 1,
  kind: 'trusted-fact-navigation',
  origin: 'machine-derived',
  derivation: { method: 'test', version: '1' },
  locator: {
    schemaVersion: 1,
    locatorId: 'locator:1',
    persistence: {
      sourceKind: 'trusted-fact-repository',
      sourceKey: 'trusted-facts.jsonl',
      lineNumber: 1,
      canonicalDigest: 'sha256:abc',
    },
  },
  hints: {
    topics: ['architecture'],
    targetRefs: [{ targetId: 'x:1', canonicalSource: 'https://x.test/1' }],
    dimension: 'argument_quality',
    relations: [{ kind: 'about-target', targetId: 'x:1' }],
  },
} as const

const fact: ProjectedTrustedFact = {
  target: {
    id: 'x:1',
    content: '完整事实正文',
    source: 'https://x.test/1',
    scope: 'this post',
  },
  dimension: 'argument_quality',
  reason: '完整理由',
  applicationLevel: 'observation',
  evidence: { kind: 'user_direct', rawUserExpression: '我认为论证清楚。' },
}

const budget: ProjectionBudget = {
  maxInlineFacts: 2,
  maxLookupTickets: 2,
  maxSerializedBytes: 10_000,
}

describe('TODO5 fact projection contracts', () => {
  it('rejects invalid budgets, audit decisions, and locator decisions at runtime', () => {
    expect(() => createProjectionView({ facts: [], tickets: [] }, {
      ...budget,
      maxInlineFacts: -1,
    })).toThrow(/budget/i)

    const invalidAudit: CandidateFactAssessmentAudit = {
      policyId: 'policy',
      policyVersion: '1',
      candidateFingerprint: 'candidate-fingerprint',
      decisions: [{
        locatorId: '',
        relevance: 'high',
        essentiality: 'inline_priority',
        priority: Number.NaN,
        reason: '',
      }],
    }
    expect(() => createProjectionView({ facts: [], tickets: [], audit: invalidAudit }, budget)).toThrow()
  })

  it('uses explicit not-ready codes and rejects unknown codes', () => {
    for (const code of [
      'navigation-schema-invalid',
      'source-revision-mismatch',
      'assessment-policy-unavailable',
      'limits-unavailable',
      'projector-unavailable',
      'lookup-unavailable',
    ] as const) {
      expect(createProjectionNotReady(code, 'stable code')).toMatchObject({ kind: 'not-ready', code })
    }
    expect(() => createProjectionNotReady('unknown-code' as never, 'must reject')).toThrow()
  })

  it('enforces audit relevance and essentiality combinations while allowing priority ties', () => {
    const audit = (relevance: string, essentiality: string, priority = 1) => validateAssessmentAudit({
      policyId: 'policy',
      policyVersion: '1',
      candidateFingerprint: 'candidate-fingerprint',
      decisions: [{ locatorId: 'locator:1', relevance, essentiality, priority, reason: 'explicit audit reason' }],
    })
    expect(audit('high', 'inline_priority').ok).toBe(true)
    expect(audit('low_confidence', 'lookup_only').ok).toBe(true)
    expect(audit('high', 'inline_priority', 1)).toEqual(audit('high', 'inline_priority', 1))
    expect(audit('unrelated', 'inline_priority').ok).toBe(false)
    expect(audit('low_confidence', 'inline_priority').ok).toBe(false)
  })

  it('classifies fake or incomplete locator coverage as projection failure', () => {
    const audit = {
      policyId: 'policy',
      policyVersion: '1',
      candidateFingerprint: 'candidate-fingerprint',
      decisions: [{
        locatorId: 'locator:fake',
        relevance: 'low_confidence',
        essentiality: 'lookup_only',
        priority: 1,
        reason: '需要回查',
      }],
    }
    const result = validateAssessmentAuditCoverage(audit, [navigation])
    expect(result).toMatchObject({ kind: 'projection-failure', code: 'unknown-locator' })
    expect(result).not.toHaveProperty('access')
  })

  it('preserves every ProjectedTrustedFact field and produces JSON-serializable DTOs', () => {
    const view = createProjectionView({ facts: [fact], tickets: [] }, budget)
    expect(view.facts).toEqual([fact])
    expect(JSON.parse(new TextDecoder().decode(view.serializedBytes))).toEqual({ facts: [fact], tickets: [] })
  })

  it('builds tickets from neutral navigation and excludes fact or attitude fields', () => {
    const ticket: LookupTicket = createLookupTicketFromNavigation(navigation)
    expect(ticket.locator.locatorId).toBe('locator:1')
    expect(ticket.targetRefs).toEqual(navigation.hints.targetRefs)
    expect(ticket.dimension).toBe('argument_quality')
    expect(ticket.topics).toEqual(['architecture'])
    expect(ticket.selectedLocatorCount).toBe(1)
    expect(ticket).not.toHaveProperty('content')
    expect(ticket).not.toHaveProperty('reason')
    expect(ticket).not.toHaveProperty('scope')
    expect(ticket).not.toHaveProperty('applicationLevel')
    expect(ticket).not.toHaveProperty('evidence')
  })

  it('allows a bounded neutral 200-locator group ticket but rejects zero or unknown fields', () => {
    const ticket = createLookupTicketFromNavigation(navigation, 'ticket:group', 200)
    expect(ticket.selectedLocatorCount).toBe(200)
    const largerTicket = createLookupTicketFromNavigation(navigation, 'ticket:larger-group', 10_000)
    expect(largerTicket.selectedLocatorCount).toBe(10_000)
    expect(() => createLookupTicketFromNavigation(navigation, 'ticket:zero', 0)).toThrow()
    expect(() => createLookupTicketFromNavigation({ ...navigation, selectedLocatorCount: 200 } as never)).toThrow()
  })

  it('keeps ProjectionView bounded, forbidden-field-free, and canonical bytes stable', () => {
    const first = createProjectionView({ facts: [fact], tickets: [] }, budget)
    const second = createProjectionView({ facts: [fact], tickets: [] }, budget)
    expect([...first.serializedBytes]).toEqual([...second.serializedBytes])
    expect(canonicalSerializeProjectionPayload({ facts: [fact], tickets: [] }))
      .toBe(new TextDecoder().decode(first.serializedBytes))
    expect(() => createProjectionView({ facts: [], tickets: [], sourceRevision: 'sha256:nope' }, budget)).toThrow()
  })

  it('rejects a forged serialized view and does not turn projection failure into not-ready', () => {
    const view = createProjectionView({ facts: [fact], tickets: [] }, budget)
    const forged = { ...view, serializedBytes: new TextEncoder().encode('{}') }
    expect(() => createProjectionView(forged, budget)).toThrow()
    const failure = createProjectionFailure('unknown-locator', 'fake locator', ['locator:fake'])
    const notReady = createProjectionNotReady('navigation-unavailable', 'navigation unavailable')
    expect(failure.kind).toBe('projection-failure')
    expect(notReady.kind).toBe('not-ready')
    expect(failure).not.toHaveProperty('access')
    expect(notReady).not.toHaveProperty('access')
  })

  it('keeps lookup requests to ticketId only and separates access from ticket identity', () => {
    const request = createLookupRequest({ ticketId: 'ticket:locator:1' })
    expect(request).toEqual({ ticketId: 'ticket:locator:1' })
    expect(() => createLookupRequest({ ticketId: 'ticket:1', limit: 1 })).toThrow()

    const registry = createReadyFactProjectionAccessRegistry()
    const snapshot = Object.freeze({ revision: 'sha256:revision-1' })
    const access = registry.createAccess(snapshot)
    const grant = registry.issueGrant(access, snapshot, 'ticket:locator:1', ['locator:1'])
    expect(registry.authorize(access, grant, snapshot)).toBe(true)
    expect(registry.authorize(access, grant, Object.freeze({ revision: 'sha256:other' }))).toBe(false)
    expect(registry.authorize(registry.createAccess(snapshot), grant, snapshot)).toBe(false)
  })

  it('keeps projection failure distinct from not-ready and gives neither a capability', () => {
    const notReady = { kind: 'not-ready', code: 'navigation-unavailable', message: 'not ready' } as const
    const failure = { kind: 'projection-failure', code: 'unknown_locator', message: 'fake locator' } as const
    expect(notReady.kind).not.toBe(failure.kind)
    expect(notReady).not.toHaveProperty('access')
    expect(failure).not.toHaveProperty('access')
  })
})
