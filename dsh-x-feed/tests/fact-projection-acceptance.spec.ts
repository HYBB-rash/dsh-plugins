import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createBoundFactProjectionPreflight,
  createFactProjectionPreflight,
  candidateFingerprint,
  type CandidateFactAssessment,
  type CandidateDescriptor,
  type ProjectionBudget,
} from '../src/fact-projection/index.ts'
import { createFileProjectionSources } from '../src/fact-projection/file-projection-sources.ts'
import {
  FileNavigationSnapshotStore,
  TRUSTED_FACT_NAVIGATION_FILE_NAME,
} from '../src/navigation/file-navigation-snapshot-store.ts'
import { createTrustedFact } from '../src/trusted-facts/model.ts'
import { FileTrustedFactRepository } from '../src/x-feedback/trusted-fact-repository.ts'

const directories: string[] = []
const candidate: CandidateDescriptor = {
  id: 'candidate-acceptance',
  content: 'A candidate that needs its explicit facts',
  source: 'https://example.test/candidate-acceptance',
}
const budget: ProjectionBudget = {
  maxInlineFacts: 1,
  maxLookupTickets: 2,
  maxSerializedBytes: 16_384,
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function assessmentFor(
  decisions: CandidateFactAssessment['audit']['decisions'],
): CandidateFactAssessment {
  return {
    candidate,
    audit: {
      policyId: 'acceptance-policy',
      policyVersion: '1',
      candidateFingerprint: candidateFingerprint(candidate),
      decisions,
    },
  }
}

type Fixture = {
  readonly dataDir: string
  readonly locatorIds: readonly string[]
}

async function fixture(count: number, sharedTarget = false, largeFact = false): Promise<Fixture> {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-x-feed-fact-projection-s5-'))
  directories.push(dataDir)
  const repository = new FileTrustedFactRepository(dataDir)
  for (let index = 1; index <= count; index += 1) {
    const result = createTrustedFact({
      target: {
        id: sharedTarget ? 'target-shared' : `target-${index}`,
        content: largeFact
          ? `${sharedTarget ? 'shared target content' : `target content ${index}`} ${'long-content '.repeat(100)}`
          : sharedTarget ? 'shared target content' : `target content ${index}`,
        source: sharedTarget ? 'https://example.test/shared' : `https://example.test/target-${index}`,
        scope: 'this candidate',
      },
      dimension: 'content_value',
      reason: largeFact ? `${'long-reason '.repeat(100)}${index}` : `full fact reason ${index}`,
      evidence: {
        kind: 'user_direct',
        rawUserExpression: largeFact
          ? `${'long-evidence '.repeat(100)}${index}`
          : `remember full fact ${index}`,
      },
    })
    if (!result.ok) throw new Error(result.message)
    expect(repository.append(result.fact)).toMatchObject({ ok: true })
  }
  const sources = createFileProjectionSources(dataDir)
  const snapshot = sources.facts.readLocatedSnapshot()
  new FileNavigationSnapshotStore(dataDir).replace({
    schemaVersion: 1,
    sourceRevision: snapshot.sourceRevision,
    items: snapshot.facts.map(located => ({
      schemaVersion: 1 as const,
      kind: 'trusted-fact-navigation' as const,
      origin: 'machine-derived' as const,
      derivation: { method: 'acceptance', version: '1' },
      locator: located.locator,
      hints: {
        topics: ['acceptance'],
        targetRefs: [{ targetId: located.fact.target.id, canonicalSource: located.fact.target.source }],
        dimension: located.fact.dimension,
        relations: [{ kind: 'about-target' as const, targetId: located.fact.target.id }],
      },
    })),
  })
  return { dataDir, locatorIds: snapshot.facts.map(located => located.locator.locatorId) }
}

function decisionsFor(
  locatorIds: readonly string[],
  classify: (index: number) => {
    readonly relevance: 'high' | 'low_confidence' | 'unrelated'
    readonly essentiality: 'inline_priority' | 'lookup_only'
  },
) {
  return locatorIds.map((locatorId, index) => {
    const choice = classify(index)
    return {
      locatorId,
      relevance: choice.relevance,
      essentiality: choice.essentiality,
      priority: index + 1,
      reason: `explicit acceptance assessment ${index + 1}`,
    }
  })
}

function readyProjection(
  dataDir: string,
  projectionBudget: ProjectionBudget,
  assessment: CandidateFactAssessment,
) {
  const preflight = createFactProjectionPreflight(
    dataDir,
    projectionBudget,
    { checkReadiness: () => ({ ready: true as const }) },
  )
  return preflight.kind === 'ready' ? preflight.session.project(candidate, assessment) : preflight
}

describe('TODO5-S5 public fact-projection composition', () => {
  it('composes the bound assessment convenience without widening the ready boundary', async () => {
    const source = await fixture(1)
    let boundNavigation: unknown
    const result = createBoundFactProjectionPreflight(
      source.dataDir,
      budget,
      navigation => {
        boundNavigation = navigation
        return { checkReadiness: () => ({ ready: true as const }) }
      },
    )

    expect(result).toMatchObject({ kind: 'ready' })
    expect(boundNavigation).toBeDefined()
    expect(Object.isFrozen(boundNavigation)).toBe(true)
    if (result.kind !== 'ready') return
    expect(Object.keys(result)).toEqual(['kind', 'session'])
    expect(Object.keys(result.session)).toEqual(['project'])
  })

  it('composes read-only files, explicit assessment, projection, and exact lookup', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dsh-x-feed-fact-projection-s5-'))
    directories.push(dataDir)
    const fact = createTrustedFact({
      target: {
        id: 'target-acceptance',
        content: 'target content',
        source: 'https://example.test/target-acceptance',
        scope: 'this candidate',
      },
      dimension: 'content_value',
      reason: 'explicit acceptance reason',
      evidence: { kind: 'user_direct', rawUserExpression: 'remember this' },
    })
    if (!fact.ok) throw new Error(fact.message)
    const repository = new FileTrustedFactRepository(dataDir)
    expect(repository.append(fact.fact)).toMatchObject({ ok: true })
    const sources = createFileProjectionSources(dataDir)
    const snapshot = sources.facts.readLocatedSnapshot()
    const located = snapshot.facts[0]
    if (located === undefined) throw new Error('acceptance fixture did not create a fact')
    new FileNavigationSnapshotStore(dataDir).replace({
      schemaVersion: 1,
      sourceRevision: snapshot.sourceRevision,
      items: [{
        schemaVersion: 1,
        kind: 'trusted-fact-navigation',
        origin: 'machine-derived',
        derivation: { method: 'acceptance', version: '1' },
        locator: located.locator,
        hints: {
          topics: ['acceptance'],
          targetRefs: [{ targetId: located.fact.target.id, canonicalSource: located.fact.target.source }],
          dimension: located.fact.dimension,
          relations: [{ kind: 'about-target', targetId: located.fact.target.id }],
        },
      }],
    })

    const preflight = createFactProjectionPreflight(
      dataDir,
      budget,
      { checkReadiness: () => ({ ready: true as const }) },
    )
    expect(preflight).toMatchObject({ kind: 'ready' })
    if (preflight.kind !== 'ready') return
    const projected = preflight.session.project(candidate, assessmentFor([{
      locatorId: located.locator.locatorId,
      relevance: 'high',
      essentiality: 'inline_priority',
      priority: 1,
      reason: 'explicitly selected for inline context',
    }]))
    expect(projected).toMatchObject({
      kind: 'ready',
      view: { facts: [{ target: { id: 'target-acceptance', content: 'target content', scope: 'this candidate' } }] },
    })
    if (projected.kind !== 'ready') return
    expect(projected.view.facts[0]).toEqual({
      target: {
        id: 'target-acceptance',
        content: 'target content',
        source: 'https://example.test/target-acceptance',
        scope: 'this candidate',
      },
      dimension: 'content_value',
      reason: 'explicit acceptance reason',
      applicationLevel: 'observation',
      evidence: { kind: 'user_direct', rawUserExpression: 'remember this' },
    })
    expect(projected).not.toHaveProperty('audit')
    expect(projected).not.toHaveProperty('grants')
    expect(projected).not.toHaveProperty('access')
    const jsonView = JSON.stringify(projected.view)
    expect(() => JSON.parse(jsonView) as unknown).not.toThrow()
    for (const forbiddenField of ['audit', 'grants', 'access', 'session', 'history', 'tools', 'reasoning']) {
      expect(jsonView).not.toContain(`"${forbiddenField}"`)
    }
  })

  it('returns structured not-ready without a session when navigation is absent', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dsh-x-feed-fact-projection-s5-'))
    directories.push(dataDir)
    let readinessCalls = 0
    const preflight = createFactProjectionPreflight(
      dataDir,
      budget,
      { checkReadiness: () => { readinessCalls += 1; return { ready: true as const } } },
    )
    expect(preflight).toMatchObject({ kind: 'not-ready', code: 'navigation-unavailable' })
    expect(preflight).not.toHaveProperty('session')
    expect(readinessCalls).toBe(0)
  })

  it('moves a whole fact to a neutral ticket when inline bytes are too small', async () => {
    const source = await fixture(1, true, true)
    const result = readyProjection(source.dataDir, {
      maxInlineFacts: 1,
      maxLookupTickets: 1,
      maxSerializedBytes: 2_000,
    }, assessmentFor(decisionsFor(source.locatorIds, () => ({
      relevance: 'high',
      essentiality: 'inline_priority',
    }))))
    expect(result).toMatchObject({ kind: 'ready' })
    if (result?.kind !== 'ready') return
    expect(result.view.facts).toEqual([])
    const ticket = result.view.tickets[0]
    expect(ticket).toMatchObject({
      locator: { locatorId: source.locatorIds[0] },
      targetRefs: [{ targetId: 'target-shared', canonicalSource: 'https://example.test/shared' }],
      dimension: 'content_value',
      topics: ['acceptance'],
      selectedLocatorCount: 1,
    })
    expect(ticket).toBeDefined()
    const ticketJson = JSON.stringify(ticket)
    for (const forbiddenField of ['content', 'reason', 'scope', 'applicationLevel', 'evidence', 'attitude']) {
      expect(ticketJson).not.toContain(`"${forbiddenField}"`)
    }
    expect(result.lookup(ticket!.ticketId)).toMatchObject({
      kind: 'lookup-success',
      facts: [{
        reason: expect.stringContaining('long-reason'),
        evidence: { rawUserExpression: expect.stringContaining('long-evidence') },
      }],
    })
  })

  it('keeps the model view identical from 2 facts to 200 facts with unrelated noise', async () => {
    const small = await fixture(2)
    const large = await fixture(200)
    const classify = (index: number) => index === 0
      ? { relevance: 'high' as const, essentiality: 'inline_priority' as const }
      : index === 1
        ? { relevance: 'high' as const, essentiality: 'lookup_only' as const }
        : { relevance: 'unrelated' as const, essentiality: 'lookup_only' as const }
    const smallAssessment = assessmentFor(decisionsFor(small.locatorIds, classify))
    const largeAssessment = assessmentFor(decisionsFor(large.locatorIds, classify))
    const smallResult = readyProjection(small.dataDir, budget, smallAssessment)
    const largeResult = readyProjection(large.dataDir, budget, largeAssessment)
    expect(smallResult).toMatchObject({ kind: 'ready' })
    expect(largeResult).toMatchObject({ kind: 'ready' })
    if (smallResult?.kind !== 'ready' || largeResult?.kind !== 'ready') return
    expect([...largeResult.view.serializedBytes]).toEqual([...smallResult.view.serializedBytes])
    expect(largeResult.view.serializedBytes.byteLength).toBe(smallResult.view.serializedBytes.byteLength)
  })

  it('keeps low-confidence facts ticket-only, omits unrelated facts, and looks up a whole 200-fact ticket', async () => {
    const lowConfidence = await fixture(2)
    const lowResult = readyProjection(lowConfidence.dataDir, budget, assessmentFor(decisionsFor(
      lowConfidence.locatorIds,
      index => index === 0
        ? { relevance: 'low_confidence', essentiality: 'lookup_only' }
        : { relevance: 'unrelated', essentiality: 'lookup_only' },
    )))
    expect(lowResult).toMatchObject({ kind: 'ready' })
    if (lowResult?.kind !== 'ready') return
    expect(lowResult.view.facts).toEqual([])
    expect(lowResult.view.tickets).toHaveLength(1)
    expect(lowResult.view.tickets[0]).toMatchObject({ selectedLocatorCount: 1 })
    expect(lowResult.lookup(lowResult.view.tickets[0]!.ticketId)).toMatchObject({
      kind: 'lookup-success',
      facts: [{ target: { id: 'target-1' }, reason: 'full fact reason 1' }],
    })
    expect(lowResult.lookup('ticket:unknown')).toMatchObject({ kind: 'lookup-failure', code: 'ticket_not_found' })

    const many = await fixture(200, true)
    const manyResult = readyProjection(many.dataDir, {
      maxInlineFacts: 1,
      maxLookupTickets: 1,
      maxSerializedBytes: 16_384,
    }, assessmentFor(decisionsFor(many.locatorIds, () => ({
      relevance: 'low_confidence',
      essentiality: 'lookup_only',
    }))))
    expect(manyResult).toMatchObject({ kind: 'ready' })
    if (manyResult?.kind !== 'ready') return
    expect(manyResult.view.facts).toEqual([])
    expect(manyResult.view.tickets).toHaveLength(1)
    expect(manyResult.view.tickets[0]).toMatchObject({ selectedLocatorCount: 200 })
    const lookup = manyResult.lookup(manyResult.view.tickets[0]!.ticketId)
    expect(lookup.kind).toBe('lookup-success')
    if (lookup.kind === 'lookup-success') {
      expect(lookup.facts).toHaveLength(200)
      expect(lookup.facts[0]).toMatchObject({ reason: 'full fact reason 1' })
      expect(lookup.facts[199]).toMatchObject({ reason: 'full fact reason 200' })
    }

    const highMany = await fixture(200, true)
    const highManyResult = readyProjection(highMany.dataDir, {
      maxInlineFacts: 1,
      maxLookupTickets: 1,
      maxSerializedBytes: 16_384,
    }, assessmentFor(decisionsFor(highMany.locatorIds, () => ({
      relevance: 'high',
      essentiality: 'inline_priority',
    }))))
    expect(highManyResult).toMatchObject({ kind: 'ready' })
    if (highManyResult?.kind !== 'ready') return
    expect(highManyResult.view.facts).toHaveLength(1)
    expect(highManyResult.view.tickets).toMatchObject([{ selectedLocatorCount: 199 }])
    expect(highManyResult.lookup(highManyResult.view.tickets[0]!.ticketId)).toMatchObject({
      kind: 'lookup-success',
      facts: expect.arrayContaining([
        expect.objectContaining({ reason: 'full fact reason 200' }),
      ]),
    })
  })

  it('returns structured projection failures for fake decisions and a byte budget with no truncation fallback', async () => {
    const source = await fixture(2, true)
    const fake = readyProjection(source.dataDir, budget, assessmentFor([{
      locatorId: 'locator:fake',
      relevance: 'high',
      essentiality: 'inline_priority',
      priority: 1,
      reason: 'explicit fake locator for failure path',
    }]))
    expect(fake).toMatchObject({ kind: 'projection-failure', code: 'unknown-locator' })
    expect(fake).not.toHaveProperty('session')

    const tooSmall = readyProjection(source.dataDir, {
      maxInlineFacts: 1,
      maxLookupTickets: 1,
      maxSerializedBytes: 1,
    }, assessmentFor(decisionsFor(source.locatorIds, () => ({
      relevance: 'high',
      essentiality: 'inline_priority',
    }))))
    expect(tooSmall).toMatchObject({ kind: 'projection-failure', code: 'budget-exceeded' })
    expect(tooSmall).not.toHaveProperty('session')

    const insufficientTickets = await fixture(3)
    const ticketFailure = readyProjection(insufficientTickets.dataDir, {
      maxInlineFacts: 1,
      maxLookupTickets: 1,
      maxSerializedBytes: 16_384,
    }, assessmentFor(decisionsFor(insufficientTickets.locatorIds, () => ({
      relevance: 'high',
      essentiality: 'inline_priority',
    }))))
    expect(ticketFailure).toMatchObject({ kind: 'projection-failure', code: 'unrepresentable' })
    expect(ticketFailure).not.toHaveProperty('session')

    const missingDecision = readyProjection(source.dataDir, budget, assessmentFor([{
      locatorId: source.locatorIds[0]!,
      relevance: 'high',
      essentiality: 'inline_priority',
      priority: 1,
      reason: 'incomplete assessment for failure path',
    }]))
    expect(missingDecision).toMatchObject({ kind: 'projection-failure' })
    expect(missingDecision).not.toHaveProperty('session')
  })

  it('keeps bad navigation schema and revision mismatch as not-ready without a session', async () => {
    const badSchema = await fixture(1)
    await writeFile(join(badSchema.dataDir, TRUSTED_FACT_NAVIGATION_FILE_NAME), JSON.stringify({ bad: true }))
    const schemaResult = createFactProjectionPreflight(
      badSchema.dataDir,
      budget,
      { checkReadiness: () => ({ ready: true as const }) },
    )
    expect(schemaResult).toMatchObject({ kind: 'not-ready', code: 'navigation-schema-invalid' })
    expect(schemaResult).not.toHaveProperty('session')

    const mismatch = await fixture(1)
    await writeFile(join(mismatch.dataDir, TRUSTED_FACT_NAVIGATION_FILE_NAME), JSON.stringify({
      schemaVersion: 1,
      sourceRevision: 'sha256:different-revision',
      items: [],
    }))
    const mismatchResult = createFactProjectionPreflight(
      mismatch.dataDir,
      budget,
      { checkReadiness: () => ({ ready: true as const }) },
    )
    expect(mismatchResult).toMatchObject({ kind: 'not-ready', code: 'source-revision-mismatch' })
    expect(mismatchResult).not.toHaveProperty('session')
  })
})
