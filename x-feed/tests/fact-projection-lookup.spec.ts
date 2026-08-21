import { describe, expect, it } from 'vitest'
import {
  buildExactFactLookup,
  ExactFactLookup,
  type ExactFactLookupBuildInput,
} from '../src/fact-projection/exact-fact-lookup.ts'
import {
  createReadyFactProjectionAccessRegistry,
  type CandidateFactAssessmentAudit,
  type ExactLookupGrant,
  type FrozenProjectionSnapshot,
} from '../src/fact-projection/contracts.ts'
import { createTrustedFact, type TrustedFact } from '../src/trusted-facts/model.ts'
import type {
  LocatedTrustedFact,
  LocatedTrustedFactSnapshot,
  Sha256Digest,
  TrustedFactLocator,
} from '../src/trusted-facts/navigation-contract.ts'

function factFor(index: number): TrustedFact {
  const result = createTrustedFact({
    target: {
      id: `target:${index}`,
      content: `content ${index}`,
      source: `https://example.test/${index}`,
      scope: 'this post',
    },
    dimension: 'argument_quality',
    reason: `reason ${index}`,
    applicationLevel: 'observation',
    evidence: { kind: 'user_direct', rawUserExpression: `remember ${index}` },
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
      lineNumber: index + 1,
      canonicalDigest: `sha256:digest-${index}`,
    },
  }
}

function fixture(
  count: number,
  options: { readonly ticketId?: string; readonly locatorIds?: readonly string[]; readonly knownTicketIds?: readonly string[] } = {},
): {
  input: ExactFactLookupBuildInput
  access: ExactFactLookupBuildInput['access']
  grant: ExactLookupGrant
  facts: readonly LocatedTrustedFact[]
  snapshot: FrozenProjectionSnapshot
} {
  const facts = Object.freeze(Array.from({ length: count }, (_, index) => ({
    locator: locatorFor(index),
    fact: factFor(index),
  })))
  const sourceRevision = 'sha256:source-revision' as Sha256Digest
  const locatedSnapshot: LocatedTrustedFactSnapshot = Object.freeze({ sourceRevision, facts })
  const snapshot = Object.freeze({ revision: sourceRevision })
  const locatorIds = options.locatorIds ?? facts.map(({ locator }) => locator.locatorId)
  const audit: CandidateFactAssessmentAudit = Object.freeze({
    policyId: 'test-policy',
    policyVersion: '1',
    candidateFingerprint: 'sha256:candidate',
    decisions: Object.freeze(facts.map(({ locator }) => ({
      locatorId: locator.locatorId,
      relevance: 'high' as const,
      essentiality: 'lookup_only' as const,
      priority: 1,
      reason: 'explicit test decision',
    }))),
  })
  const registry = createReadyFactProjectionAccessRegistry()
  const access = registry.createAccess(snapshot)
  const grant = registry.issueGrant(
    access,
    snapshot,
    options.ticketId ?? 'ticket:all',
    locatorIds,
  )
  return {
    input: {
      facts: locatedSnapshot,
      snapshot,
      registry,
      access,
      grants: [grant],
      audit,
      knownTicketIds: options.knownTicketIds ?? [grant.ticketId],
    },
    access,
    grant,
    facts,
    snapshot,
  }
}

function expectLookup(value: ExactFactLookupBuildInput | unknown): ExactFactLookup {
  const result = buildExactFactLookup(value as ExactFactLookupBuildInput)
  expect(result).toBeInstanceOf(ExactFactLookup)
  return result as ExactFactLookup
}

describe('TODO5-S3 exact fact lookup', () => {
  it('rejects a guessed ticket id, but accepts the real access and grant', () => {
    const setup = fixture(1)
    const lookup = expectLookup(setup.input)

    expect(lookup.lookup(setup.access, { ticketId: 'ticket:guessed' })).toMatchObject({
      kind: 'lookup-failure', code: 'ticket_not_found',
    })
    expect(lookup.lookup(setup.access, { ticketId: setup.grant.ticketId })).toMatchObject({
      kind: 'lookup-success', facts: [{ target: { id: 'target:0' } }],
    })
  })

  it('rejects cross-capability replay and extra request fields', () => {
    const setup = fixture(1)
    const lookup = expectLookup(setup.input)
    const otherAccess = setup.input.registry.createAccess(setup.snapshot)

    expect(lookup.lookup(otherAccess, { ticketId: setup.grant.ticketId })).toMatchObject({
      kind: 'lookup-failure', code: 'invalid_access',
    })
    expect(lookup.lookup(setup.access, { ticketId: setup.grant.ticketId, locatorIds: ['locator:0'] } as never))
      .toMatchObject({ kind: 'lookup-failure', code: 'invalid_access' })

    const otherRegistry = createReadyFactProjectionAccessRegistry()
    const foreignAccess = otherRegistry.createAccess(setup.snapshot)
    const otherGrant = otherRegistry.issueGrant(foreignAccess, setup.snapshot, setup.grant.ticketId, ['locator:0'])
    expect(buildExactFactLookup({ ...setup.input, grants: [otherGrant] })).toMatchObject({
      kind: 'lookup-failure', code: 'grant_snapshot_mismatch',
    })
  })

  it('rejects grants whose snapshot object or revision is not the frozen projection snapshot', () => {
    const setup = fixture(1)
    const otherSnapshot = Object.freeze({ revision: setup.snapshot.revision })
    const wrongObjectGrant = Object.freeze({
      ...setup.grant,
      snapshotRevision: otherSnapshot.revision,
    })
    expect(buildExactFactLookup({ ...setup.input, grants: [wrongObjectGrant] })).toMatchObject({
      kind: 'lookup-failure', code: 'grant_snapshot_mismatch',
    })

    const wrongRevision = Object.freeze({ revision: 'sha256:other' })
    expect(buildExactFactLookup({ ...setup.input, snapshot: wrongRevision })).toMatchObject({
      kind: 'lookup-failure', code: 'grant_snapshot_mismatch',
    })
  })

  it('rejects unknown, unrelated, and missing audit decisions for every granted locator', () => {
    const setup = fixture(1, { locatorIds: ['locator:unknown'] })
    expect(buildExactFactLookup(setup.input)).toMatchObject({
      kind: 'lookup-failure', code: 'invalid_fact',
    })

    const unrelated = {
      ...setup.input.audit,
      decisions: [{
        locatorId: 'locator:0',
        relevance: 'unrelated' as const,
        essentiality: 'lookup_only' as const,
        priority: 1,
        reason: 'unrelated',
      }],
    }
    expect(buildExactFactLookup({ ...setup.input, audit: unrelated })).toMatchObject({
      kind: 'lookup-failure', code: 'invalid_fact',
    })

    const missing = { ...setup.input, audit: { ...setup.input.audit, decisions: [] } }
    expect(buildExactFactLookup(missing)).toMatchObject({ kind: 'lookup-failure', code: 'invalid_fact' })
  })

  it('rejects a mutable facts array even when the snapshot shell is frozen', () => {
    const setup = fixture(1)
    const mutableFacts = [...setup.facts]
    const fakePinnedSnapshot = Object.freeze({ ...setup.input.facts, facts: mutableFacts })
    expect(buildExactFactLookup({ ...setup.input, facts: fakePinnedSnapshot })).toMatchObject({
      kind: 'lookup-failure', code: 'invalid_fact',
    })
  })

  it('rejects empty or duplicate known ticket ids and requires exact view/grant coverage', () => {
    const setup = fixture(1)
    expect(buildExactFactLookup({ ...setup.input, knownTicketIds: [''] })).toMatchObject({
      kind: 'lookup-failure', code: 'invalid_fact',
    })
    expect(buildExactFactLookup({ ...setup.input, knownTicketIds: [setup.grant.ticketId, setup.grant.ticketId] }))
      .toMatchObject({ kind: 'lookup-failure', code: 'invalid_fact' })
    expect(buildExactFactLookup({ ...setup.input, knownTicketIds: ['ticket:view-without-grant'] })).toMatchObject({
      kind: 'lookup-failure', code: 'grant_not_found',
    })
    expect(buildExactFactLookup({ ...setup.input, knownTicketIds: [setup.grant.ticketId, 'ticket:extra'] })).toMatchObject({
      kind: 'lookup-failure', code: 'grant_not_found',
    })
  })

  it('returns every explicitly granted fact, including 200 facts, with no lookup cap', () => {
    const setup = fixture(200)
    const lookup = expectLookup(setup.input)
    const result = lookup.lookup(setup.access, { ticketId: setup.grant.ticketId })
    expect(result).toMatchObject({ kind: 'lookup-success' })
    expect(result.kind === 'lookup-success' ? result.facts : []).toHaveLength(200)
    expect(result.kind === 'lookup-success' ? result.facts[199]?.target.id : undefined).toBe('target:199')

    const tenThousand = fixture(10_000, { ticketId: 'ticket:10k' })
    const tenThousandLookup = expectLookup(tenThousand.input)
    const tenThousandResult = tenThousandLookup.lookup(tenThousand.access, { ticketId: 'ticket:10k' })
    expect(tenThousandResult).toMatchObject({ kind: 'lookup-success' })
    expect(tenThousandResult.kind === 'lookup-success' ? tenThousandResult.facts : []).toHaveLength(10_000)
    expect(tenThousandResult.kind === 'lookup-success'
      ? tenThousandResult.facts[9_999]?.target.id
      : undefined).toBe('target:9999')
  })

  it('indexes the frozen source once and returns the complete whitelisted DTO repeatedly', () => {
    const setup = fixture(1)
    const lookup = expectLookup(setup.input)
    const first = lookup.lookup(setup.access, { ticketId: setup.grant.ticketId })
    const second = lookup.lookup(setup.access, { ticketId: setup.grant.ticketId })
    expect(second).toEqual(first)
    expect(first).toMatchObject({
      kind: 'lookup-success',
      facts: [{
        target: {
          id: 'target:0', content: 'content 0', source: 'https://example.test/0', scope: 'this post',
        },
        dimension: 'argument_quality', reason: 'reason 0', applicationLevel: 'observation',
        evidence: { kind: 'user_direct', rawUserExpression: 'remember 0' },
      }],
    })
    expect(lookup).not.toHaveProperty('readAll')
    expect(lookup).not.toHaveProperty('listAll')
    expect(lookup).not.toHaveProperty('query')
  })
})
