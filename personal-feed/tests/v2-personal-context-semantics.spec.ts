import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

type TelegramLocator = {
  readonly kind: 'telegram_inbound'
  readonly chatId: number
  readonly messageId: number
}

type Span = {
  readonly startUtf16: number
  readonly endUtf16: number
}

type ProtectedSpans = {
  readonly subject: readonly Span[]
  readonly polarity: readonly Span[]
  readonly conditions: readonly Span[]
  readonly modality: readonly Span[]
  readonly attribution: readonly Span[]
  readonly temporal: readonly Span[]
  readonly applicability: readonly Span[]
}

type Attitude = {
  readonly speaker: 'user' | 'other' | 'ambiguous'
  readonly polarity: 'affirmed' | 'denied'
  readonly modality: 'committed' | 'uncertain' | 'hypothetical'
  readonly attribution: 'own_statement' | 'reported_statement' | 'mere_mention'
  readonly temporal: 'current' | 'future' | 'past' | 'unspecified'
  readonly qualification: 'unqualified' | 'conditioned' | 'scope_limited'
}

type RevisionOperation = 'assert' | 'confirm' | 'correct' | 'replace' | 'retract'

type ActiveFact = {
  readonly factId: string
  readonly fact: TerminalFact
  readonly basisRevisionIds: readonly string[]
}

type InterestProposal = {
  readonly lane: 'long_term_interest'
  readonly stance: 'include' | 'exclude'
  readonly focusSpan: Span
  readonly protectedSpans: ProtectedSpans
  readonly attitude: Attitude
  readonly operation: RevisionOperation
  readonly targetFactIds: readonly string[]
}

type KnowledgeProposal = {
  readonly lane: 'existing_knowledge'
  readonly epistemic: 'asserted' | 'uncertain'
  readonly focusSpan: Span
  readonly protectedSpans: ProtectedSpans
  readonly attitude: Attitude
  readonly operation: RevisionOperation
  readonly targetFactIds: readonly string[]
}

type FactProposal = InterestProposal | KnowledgeProposal

type UseAuthorization = {
  readonly policyId: 'personal-feed-direct-telegram-v1'
  readonly purpose: 'personal_feed_context'
  readonly sourceKind: 'telegram_inbound'
}

type NoFactReason =
  | 'not_personal_fact'
  | 'insufficient_long_term_signal'
  | 'object_feedback_without_long_term_scope'
  | 'not_concrete_proposition'
  | 'reported_or_mentioned'
  | 'hypothetical_only'

type CanonicalInterestFact = {
  readonly lane: 'long_term_interest'
  readonly stance: 'include' | 'exclude'
  readonly attitude: Attitude
}

type CanonicalKnowledgeFact = {
  readonly lane: 'existing_knowledge'
  readonly epistemic: 'asserted' | 'uncertain'
  readonly attitude: Attitude
}

type CanonicalFact = CanonicalInterestFact | CanonicalKnowledgeFact

type EntailmentTarget = {
  readonly focusSpanWithinEvidence: Span
  readonly exactFocusText: string
  readonly protectedSpansWithinEvidence: ProtectedSpans
}

type TerminalEvidence = {
  readonly sourceKey: string
  readonly evidenceSpan: Span
  readonly exactEvidenceText: string
  readonly focusSpanWithinEvidence: Span
  readonly protectedSpansWithinEvidence: ProtectedSpans
  readonly attitude: Attitude
}

type TerminalInterestFact = {
  readonly lane: 'long_term_interest'
  readonly stance: 'include' | 'exclude'
  readonly evidence: TerminalEvidence
  readonly useAuthorization: UseAuthorization
}

type TerminalKnowledgeFact = {
  readonly lane: 'existing_knowledge'
  readonly epistemic: 'asserted' | 'uncertain'
  readonly evidence: TerminalEvidence
  readonly useAuthorization: UseAuthorization
}

type TerminalFact = TerminalInterestFact | TerminalKnowledgeFact

type ClassifierInput = {
  readonly sourceKey: string
  readonly rawText: string
  readonly useAuthorization: UseAuthorization
  readonly activeFacts: readonly ActiveFact[]
}

type CanonicalRevision = {
  readonly operation: RevisionOperation
  readonly targetFacts: readonly ActiveFact[]
  readonly priorActiveFacts: readonly ActiveFact[]
}

type EntailmentInput = {
  readonly fullRawText: string
  readonly evidenceSpan: Span
  readonly exactEvidenceText: string
  readonly target: EntailmentTarget
  readonly canonicalFact: CanonicalFact
  readonly revision: CanonicalRevision
}

type NoFactInput = {
  readonly fullRawText: string
  readonly proposedReason: NoFactReason
  readonly useAuthorization: UseAuthorization
}

type SemanticPorts = {
  readonly classifier: (input: ClassifierInput) => unknown | Promise<unknown>
  readonly entailmentValidator: (input: EntailmentInput) => unknown | Promise<unknown>
  readonly noFactValidator: (input: NoFactInput) => unknown | Promise<unknown>
}

type SourceRecord = {
  readonly locator: TelegramLocator
  readonly rawText: string | null
  readonly reference: null
  readonly excludedRequestId?: string
  readonly occurredAt: string
  readonly sourceKey: string
  readonly captureSequence: number
}

type TerminalDisposition =
  | {
      readonly schemaVersion: 2
      readonly status: 'applied'
      readonly changes: readonly {
        readonly operation: RevisionOperation
        readonly targetFactIds: readonly string[]
        readonly fact: TerminalFact
        readonly validationInputDigest: string
      }[]
    }
  | { readonly schemaVersion: 2; readonly status: 'ignored'; readonly reason: NoFactReason }

type CoverageRecord = {
  readonly sourceKey: string
  readonly status: 'pending' | 'applied' | 'ignored'
  readonly disposition?: TerminalDisposition
  readonly terminalTransactionSequence?: number
  readonly dispositionDigest?: string
  readonly revisionDigest?: string
}

type CaptureResult = {
  readonly source: SourceRecord
  readonly coverage: CoverageRecord
}

type OwnerSnapshot = {
  readonly sources: readonly SourceRecord[]
  readonly coverage: readonly CoverageRecord[]
}

type SettleResult = {
  readonly sourceKey: string
  readonly status: 'pending' | 'applied' | 'ignored'
  readonly reason?: string
  readonly disposition?: TerminalDisposition
}

type PersonalContextOwner = {
  readonly capture: (input: {
    readonly locator: TelegramLocator
    readonly rawText: string
    readonly reference: null
    readonly excludedRequestId?: string
  }) => CaptureResult
  readonly settle: (input: { readonly sourceKey: string; readonly signal?: AbortSignal }) => Promise<SettleResult>
  readonly read: () => OwnerSnapshot
  readonly close: () => void
}

type ProductionModule = {
  readonly createPersonalContextOwner?: (options: {
    readonly databasePath: string
    readonly clock: { readonly now: () => Date }
    readonly semantics?: SemanticPorts
  }) => PersonalContextOwner
}

const temporaryDirectories: string[] = []
const occurredAt = '2026-08-31T16:00:00.000Z'
const useAuthorization: UseAuthorization = {
  policyId: 'personal-feed-direct-telegram-v1',
  purpose: 'personal_feed_context',
  sourceKind: 'telegram_inbound',
}
const entailed = { kind: 'target_and_revision_confirmed' } as const
const contradicted = { kind: 'contradicted' } as const
const unknown = { kind: 'unknown' } as const
const confirmedNoFact = { kind: 'confirmed_no_fact' } as const
const ownCurrentAttitude: Attitude = {
  speaker: 'user',
  polarity: 'affirmed',
  modality: 'committed',
  attribution: 'own_statement',
  temporal: 'current',
  qualification: 'unqualified',
}

function protectedSpans(overrides: Partial<ProtectedSpans> = {}): ProtectedSpans {
  return {
    subject: [],
    polarity: [],
    conditions: [],
    modality: [],
    attribution: [],
    temporal: [],
    applicability: [],
    ...overrides,
  }
}

async function production(): Promise<ProductionModule> {
  return await import('../src/index.ts') as ProductionModule
}

function makeDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'personal-feed-v2-context-semantics-'))
  temporaryDirectories.push(directory)
  return join(directory, 'state', 'personal-context.sqlite')
}

async function makeOwner(options: { readonly databasePath?: string; readonly semantics?: SemanticPorts } = {}): Promise<{
  readonly databasePath: string
  readonly owner: PersonalContextOwner
}> {
  const module = await production()
  expect(typeof module.createPersonalContextOwner).toBe('function')
  if (typeof module.createPersonalContextOwner !== 'function') throw new Error('createPersonalContextOwner is not available')
  const databasePath = options.databasePath ?? makeDatabasePath()
  const factoryOptions = options.semantics === undefined
    ? { databasePath, clock: { now: () => new Date(occurredAt) } }
    : { databasePath, clock: { now: () => new Date(occurredAt) }, semantics: options.semantics }
  return { databasePath, owner: module.createPersonalContextOwner(factoryOptions) }
}

function capture(owner: PersonalContextOwner, rawText: string, messageId: number): CaptureResult {
  return owner.capture({
    locator: { kind: 'telegram_inbound', chatId: 941, messageId },
    rawText,
    reference: null,
    excludedRequestId: `telegram:941:${messageId}`,
  })
}

function factsProposal(...facts: readonly FactProposal[]): unknown {
  return { kind: 'facts', facts }
}

function noFactProposal(reason: NoFactReason): unknown {
  return { kind: 'no_fact', reason }
}

function validInterestProposal(
  focusSpan: Span,
  protectedValue: ProtectedSpans,
  attitude: Attitude = ownCurrentAttitude,
): InterestProposal {
  return {
    lane: 'long_term_interest',
    stance: 'include',
    focusSpan,
    protectedSpans: protectedValue,
    attitude,
    operation: 'assert',
    targetFactIds: [],
  }
}

function validKnowledgeProposal(
  focusSpan: Span,
  protectedValue: ProtectedSpans,
  qualification: Attitude['qualification'] = 'unqualified',
  attitude: Attitude = ownCurrentAttitude,
): KnowledgeProposal {
  return {
    lane: 'existing_knowledge',
    epistemic: 'asserted',
    focusSpan,
    protectedSpans: protectedValue,
    attitude: { ...attitude, qualification },
    operation: 'assert',
    targetFactIds: [],
  }
}

async function expectRejected(action: () => unknown): Promise<void> {
  let rejected = false
  try {
    await action()
  } catch {
    rejected = true
  }
  expect(rejected).toBe(true)
}

function expectPendingRaw(owner: PersonalContextOwner, sourceKey: string, rawText: string): void {
  const state = owner.read()
  expect(state.sources).toHaveLength(1)
  expect(state.sources[0]?.rawText).toBe(rawText)
  expect(state.coverage).toEqual([{ sourceKey, status: 'pending' }])
}

function terminalCoverage(owner: PersonalContextOwner): CoverageRecord {
  const coverage = owner.read().coverage[0]
  expect(coverage).toBeDefined()
  if (coverage === undefined) throw new Error('terminal coverage is missing')
  return coverage
}

function expectTerminalMetadata(coverage: CoverageRecord): void {
  expect(Object.keys(coverage).sort()).toEqual([
    'disposition', 'dispositionDigest', 'revisionDigest', 'sourceKey', 'status', 'terminalTransactionSequence',
  ])
  expect(coverage.terminalTransactionSequence).toBeGreaterThan(0)
  expect(coverage.dispositionDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
  expect(coverage.revisionDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('Personal Feed v2 R4 exact personal-context semantics', () => {
  it('applies both fact lanes from owner-sliced exact evidence, scrubs raw text, and rejects malformed span-only proposals', async () => {
    const rawText = '我长期关注虚构主题 A，而且我已经知道虚构命题 P'
    const unavailable = await makeOwner()
    const unavailableCapture = capture(unavailable.owner, rawText, 101)
    const unavailableBefore = unavailable.owner.read()
    const unavailableBytes = readFileSync(unavailable.databasePath)

    expect(typeof unavailable.owner.settle).toBe('function')
    await expect(unavailable.owner.settle({ sourceKey: unavailableCapture.source.sourceKey })).resolves.toMatchObject({
      sourceKey: unavailableCapture.source.sourceKey,
      status: 'pending',
      reason: 'semantics_unavailable',
    })
    expect(unavailable.owner.read()).toEqual(unavailableBefore)
    expect(readFileSync(unavailable.databasePath)).toEqual(unavailableBytes)
    unavailable.owner.close()

    const classifierInputs: ClassifierInput[] = []
    const entailmentInputs: EntailmentInput[] = []
    const interestProposal = validInterestProposal(
      { startUtf16: 5, endUtf16: 11 },
      protectedSpans({ subject: [{ startUtf16: 0, endUtf16: 1 }], temporal: [{ startUtf16: 1, endUtf16: 3 }] }),
    )
    const knowledgeProposal = validKnowledgeProposal(
      { startUtf16: 19, endUtf16: 25 },
      protectedSpans({ subject: [{ startUtf16: 14, endUtf16: 15 }], temporal: [{ startUtf16: 15, endUtf16: 17 }] }),
    )
    const semantics: SemanticPorts = {
      classifier: input => {
        classifierInputs.push(input)
        expect(Object.keys(input).sort()).toEqual(['activeFacts', 'rawText', 'sourceKey', 'useAuthorization'])
        expect(input.rawText).toBe(rawText)
        expect(input.useAuthorization).toEqual(useAuthorization)
        expect(input.activeFacts).toEqual([])
        return factsProposal(interestProposal, knowledgeProposal)
      },
      entailmentValidator: input => {
        entailmentInputs.push(input)
        expect(Object.keys(input).sort()).toEqual(['canonicalFact', 'evidenceSpan', 'exactEvidenceText', 'fullRawText', 'revision', 'target'])
        return entailed
      },
      noFactValidator: () => {
        throw new Error('a facts proposal must not call the no-fact validator')
      },
    }
    const databasePath = makeDatabasePath()
    const owner = (await makeOwner({ databasePath, semantics })).owner
    const captured = capture(owner, rawText, 102)

    await expect(owner.settle({ sourceKey: captured.source.sourceKey })).resolves.toMatchObject({ status: 'applied' })
    expect(classifierInputs).toEqual([{ sourceKey: captured.source.sourceKey, rawText, useAuthorization, activeFacts: [] }])
    expect(entailmentInputs).toHaveLength(2)
    expect(entailmentInputs.map(input => ({
      fullRawText: input.fullRawText,
      evidenceSpan: input.evidenceSpan,
      exactEvidenceText: input.exactEvidenceText,
      target: input.target,
    }))).toEqual([
      {
        fullRawText: rawText,
        evidenceSpan: { startUtf16: 0, endUtf16: 11 },
        exactEvidenceText: '我长期关注虚构主题 A',
        target: {
          focusSpanWithinEvidence: { startUtf16: 5, endUtf16: 11 },
          exactFocusText: '虚构主题 A',
          protectedSpansWithinEvidence: protectedSpans({
            subject: [{ startUtf16: 0, endUtf16: 1 }],
            temporal: [{ startUtf16: 1, endUtf16: 3 }],
          }),
        },
      },
      {
        fullRawText: rawText,
        evidenceSpan: { startUtf16: 14, endUtf16: 25 },
        exactEvidenceText: '我已经知道虚构命题 P',
        target: {
          focusSpanWithinEvidence: { startUtf16: 5, endUtf16: 11 },
          exactFocusText: '虚构命题 P',
          protectedSpansWithinEvidence: protectedSpans({
            subject: [{ startUtf16: 0, endUtf16: 1 }],
            temporal: [{ startUtf16: 1, endUtf16: 3 }],
          }),
        },
      },
    ])

    const expectedCanonicalFacts: readonly CanonicalFact[] = [
      {
        lane: 'long_term_interest',
        stance: 'include',
        attitude: ownCurrentAttitude,
      },
      {
        lane: 'existing_knowledge',
        epistemic: 'asserted',
        attitude: ownCurrentAttitude,
      },
    ]
    expect(entailmentInputs.map(input => input.canonicalFact)).toEqual(expectedCanonicalFacts)
    expect(entailmentInputs.map(input => input.revision)).toEqual([
      { operation: 'assert', targetFacts: [], priorActiveFacts: [] },
      { operation: 'assert', targetFacts: [], priorActiveFacts: [] },
    ])
    const expectedFacts: readonly TerminalFact[] = [
      {
        lane: 'long_term_interest',
        stance: 'include',
        evidence: {
          sourceKey: captured.source.sourceKey,
          evidenceSpan: { startUtf16: 0, endUtf16: 11 },
          exactEvidenceText: '我长期关注虚构主题 A',
          focusSpanWithinEvidence: { startUtf16: 5, endUtf16: 11 },
          protectedSpansWithinEvidence: protectedSpans({
            subject: [{ startUtf16: 0, endUtf16: 1 }],
            temporal: [{ startUtf16: 1, endUtf16: 3 }],
          }),
          attitude: ownCurrentAttitude,
        },
        useAuthorization,
      },
      {
        lane: 'existing_knowledge',
        epistemic: 'asserted',
        evidence: {
          sourceKey: captured.source.sourceKey,
          evidenceSpan: { startUtf16: 14, endUtf16: 25 },
          exactEvidenceText: '我已经知道虚构命题 P',
          focusSpanWithinEvidence: { startUtf16: 5, endUtf16: 11 },
          protectedSpansWithinEvidence: protectedSpans({
            subject: [{ startUtf16: 0, endUtf16: 1 }],
            temporal: [{ startUtf16: 1, endUtf16: 3 }],
          }),
          attitude: ownCurrentAttitude,
        },
        useAuthorization,
      },
    ]
    expect(owner.read().sources[0]?.rawText).toBeNull()
    const appliedCoverage = terminalCoverage(owner)
    expectTerminalMetadata(appliedCoverage)
    expect(appliedCoverage).toMatchObject({ sourceKey: captured.source.sourceKey, status: 'applied' })
    expect(appliedCoverage.disposition).toMatchObject({ schemaVersion: 2, status: 'applied' })
    if (appliedCoverage.disposition?.status !== 'applied') throw new Error('facts were not applied')
    expect(appliedCoverage.disposition.changes.map(change => change.fact)).toEqual(expectedFacts)
    expect(appliedCoverage.disposition.changes.map(change => ({ operation: change.operation, targetFactIds: change.targetFactIds }))).toEqual([
      { operation: 'assert', targetFactIds: [] },
      { operation: 'assert', targetFactIds: [] },
    ])
    for (const change of appliedCoverage.disposition.changes) {
      expect(Object.keys(change).sort()).toEqual(['fact', 'operation', 'targetFactIds', 'validationInputDigest'])
      expect(change.validationInputDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
    }
    owner.close()

    const reopened = (await makeOwner({ databasePath, semantics })).owner
    expect(reopened.read().sources[0]?.rawText).toBeNull()
    const reopenedCoverage = terminalCoverage(reopened)
    expectTerminalMetadata(reopenedCoverage)
    expect(reopenedCoverage).toEqual(appliedCoverage)
    reopened.close()

    const malformed = [
      ['free-text fact key', { ...interestProposal, proposition: 'generated text must never cross the port' }],
      ['missing operation', (({ operation: _operation, ...fact }) => fact)(interestProposal)],
      ['missing target ids', (({ targetFactIds: _targetFactIds, ...fact }) => fact)(interestProposal)],
      ['assert with target', { ...interestProposal, targetFactIds: ['fact:forged'] }],
      ['generated revision text', { ...interestProposal, summary: 'generated revision text must never cross the port' }],
      ['out-of-range span', { ...interestProposal, focusSpan: { startUtf16: 5, endUtf16: rawText.length + 1 } }],
      ['missing protected category', {
        ...interestProposal,
        protectedSpans: {
          subject: [], polarity: [], conditions: [], modality: [], attribution: [], temporal: [],
        },
      }],
      ['unsupported enum', { ...interestProposal, stance: 'remember' }],
    ] as const

    for (const [name, badFact] of malformed) {
      let calls = 0
      const badOwner = (await makeOwner({
        semantics: {
          classifier: () => {
            calls += 1
            return { kind: 'facts', facts: [badFact] }
          },
          entailmentValidator: () => entailed,
          noFactValidator: () => confirmedNoFact,
        },
      })).owner
      const badCapture = capture(badOwner, rawText, 110 + malformed.findIndex(entry => entry[0] === name))

      await expect(badOwner.settle({ sourceKey: badCapture.source.sourceKey }), name).resolves.toMatchObject({ status: 'pending' })
      expect(calls, name).toBeGreaterThan(0)
      expect(calls, name).toBeLessThanOrEqual(2)
      expectPendingRaw(badOwner, badCapture.source.sourceKey, rawText)
      badOwner.close()
    }
  })

  it('fails closed when protected subject, negation, correction, condition, modality, attribution, time, or scope markers fall outside the proposed hull', async () => {
    const counterexamples = [
      ['我不认为 P', 'knowledge', { startUtf16: 5, endUtf16: 6 }],
      ['他说 P', 'knowledge', { startUtf16: 3, endUtf16: 4 }],
      ['别人说我关注 A，但其实不是', 'interest', { startUtf16: 7, endUtf16: 8 }],
      ['如果以后也许会关注 A', 'interest', { startUtf16: 10, endUtf16: 11 }],
      ['不要再把我当成关注 A', 'interest', { startUtf16: 10, endUtf16: 11 }],
      ['P 只在 C 下成立', 'knowledge', { startUtf16: 0, endUtf16: 1 }],
      ['只是提及 P', 'knowledge', { startUtf16: 5, endUtf16: 6 }],
    ] as const

    for (const [rawText, lane, focusSpan] of counterexamples) {
      let validatorCalls = 0
      const proposal = lane === 'interest'
        ? validInterestProposal(focusSpan, protectedSpans())
        : validKnowledgeProposal(focusSpan, protectedSpans())
      const owner = (await makeOwner({
        semantics: {
          classifier: () => factsProposal(proposal),
          entailmentValidator: () => {
            validatorCalls += 1
            return entailed
          },
          noFactValidator: () => confirmedNoFact,
        },
      })).owner
      const captured = capture(owner, rawText, 200 + counterexamples.findIndex(entry => entry[0] === rawText))

      await expect(owner.settle({ sourceKey: captured.source.sourceKey }), rawText).resolves.toMatchObject({ status: 'pending' })
      expectPendingRaw(owner, captured.source.sourceKey, rawText)
      expect(validatorCalls, `owner guard must reject before semantic validation: ${rawText}`).toBe(0)
      owner.close()
    }

    const positiveRaw = '我长期关注 A'
    const positiveOwner = (await makeOwner({
      semantics: {
        classifier: () => factsProposal(validInterestProposal(
          { startUtf16: 6, endUtf16: 7 },
          protectedSpans({ subject: [{ startUtf16: 0, endUtf16: 1 }], temporal: [{ startUtf16: 1, endUtf16: 3 }] }),
        )),
        entailmentValidator: () => entailed,
        noFactValidator: () => confirmedNoFact,
      },
    })).owner
    const positiveCapture = capture(positiveOwner, positiveRaw, 208)

    await expect(positiveOwner.settle({ sourceKey: positiveCapture.source.sourceKey })).resolves.toMatchObject({ status: 'applied' })
    const disposition = terminalCoverage(positiveOwner).disposition
    expect(disposition?.status).toBe('applied')
    if (disposition?.status !== 'applied') throw new Error('positive control was not applied as facts')
    expect(disposition.changes[0]?.fact.evidence.exactEvidenceText).toBe('我长期关注 A')
    expect(disposition.changes[0]?.fact.evidence.evidenceSpan).toEqual({ startUtf16: 0, endUtf16: 7 })
    positiveOwner.close()
  })

  it('accepts future committed interest and denied asserted knowledge with exact subject and temporal or polarity spans', async () => {
    const cases: readonly {
      readonly rawText: string
      readonly messageId: number
      readonly proposal: FactProposal
      readonly expectedCanonicalFact: CanonicalFact
      readonly expectedEvidenceSpan: Span
      readonly expectedExactEvidenceText: string
      readonly expectedTarget: EntailmentTarget
    }[] = [
      {
        rawText: '我以后想研究 P',
        messageId: 209,
        proposal: validInterestProposal(
          { startUtf16: 7, endUtf16: 8 },
          protectedSpans({
            subject: [{ startUtf16: 0, endUtf16: 1 }],
            temporal: [{ startUtf16: 1, endUtf16: 3 }],
          }),
          { ...ownCurrentAttitude, temporal: 'future' },
        ),
        expectedCanonicalFact: {
          lane: 'long_term_interest',
          stance: 'include',
          attitude: { ...ownCurrentAttitude, temporal: 'future' },
        },
        expectedEvidenceSpan: { startUtf16: 0, endUtf16: 8 },
        expectedExactEvidenceText: '我以后想研究 P',
        expectedTarget: {
          focusSpanWithinEvidence: { startUtf16: 7, endUtf16: 8 },
          exactFocusText: 'P',
          protectedSpansWithinEvidence: protectedSpans({
            subject: [{ startUtf16: 0, endUtf16: 1 }],
            temporal: [{ startUtf16: 1, endUtf16: 3 }],
          }),
        },
      },
      {
        rawText: '我不做中转站',
        messageId: 210,
        proposal: validKnowledgeProposal(
          { startUtf16: 3, endUtf16: 6 },
          protectedSpans({
            subject: [{ startUtf16: 0, endUtf16: 1 }],
            polarity: [{ startUtf16: 1, endUtf16: 2 }],
          }),
          'unqualified',
          { ...ownCurrentAttitude, polarity: 'denied' },
        ),
        expectedCanonicalFact: {
          lane: 'existing_knowledge',
          epistemic: 'asserted',
          attitude: { ...ownCurrentAttitude, polarity: 'denied' },
        },
        expectedEvidenceSpan: { startUtf16: 0, endUtf16: 6 },
        expectedExactEvidenceText: '我不做中转站',
        expectedTarget: {
          focusSpanWithinEvidence: { startUtf16: 3, endUtf16: 6 },
          exactFocusText: '中转站',
          protectedSpansWithinEvidence: protectedSpans({
            subject: [{ startUtf16: 0, endUtf16: 1 }],
            polarity: [{ startUtf16: 1, endUtf16: 2 }],
          }),
        },
      },
    ]

    for (const testCase of cases) {
      let validatorInput: EntailmentInput | undefined
      const owner = (await makeOwner({
        semantics: {
          classifier: () => factsProposal(testCase.proposal),
          entailmentValidator: input => {
            validatorInput = input
            expect(Object.keys(input).sort()).toEqual([
              'canonicalFact', 'evidenceSpan', 'exactEvidenceText', 'fullRawText', 'revision', 'target',
            ])
            return entailed
          },
          noFactValidator: () => confirmedNoFact,
        },
      })).owner
      const captured = capture(owner, testCase.rawText, testCase.messageId)

      await expect(owner.settle({ sourceKey: captured.source.sourceKey })).resolves.toMatchObject({ status: 'applied' })
      expect(validatorInput).toEqual({
        fullRawText: testCase.rawText,
        evidenceSpan: testCase.expectedEvidenceSpan,
        exactEvidenceText: testCase.expectedExactEvidenceText,
        target: testCase.expectedTarget,
        canonicalFact: testCase.expectedCanonicalFact,
        revision: { operation: 'assert', targetFacts: [], priorActiveFacts: [] },
      })
      const disposition = terminalCoverage(owner).disposition
      expect(disposition?.status).toBe('applied')
      if (disposition?.status !== 'applied') throw new Error('positive semantic control was not applied')
      expect(disposition.changes[0]?.fact.evidence.exactEvidenceText).toBe(testCase.expectedExactEvidenceText)
      expect(disposition.changes[0]?.fact.evidence.focusSpanWithinEvidence).toEqual(testCase.expectedTarget.focusSpanWithinEvidence)
      owner.close()
    }
  })

  it('passes only the owner-derived focus target to entailment and keeps the source pending on non-approval', async () => {
    const rawText = '我已经知道 P 和 Q'
    const proposal = validKnowledgeProposal(
      { startUtf16: 10, endUtf16: 11 },
      protectedSpans({ subject: [{ startUtf16: 0, endUtf16: 1 }] }),
    )
    const validatorInputs: EntailmentInput[] = []
    const owner = (await makeOwner({
      semantics: {
        classifier: () => factsProposal(proposal),
        entailmentValidator: input => {
          validatorInputs.push(input)
          return contradicted
        },
        noFactValidator: () => confirmedNoFact,
      },
    })).owner
    const captured = capture(owner, rawText, 211)

    await expect(owner.settle({ sourceKey: captured.source.sourceKey })).resolves.toMatchObject({ status: 'pending' })
    expect(validatorInputs.length).toBeGreaterThanOrEqual(1)
    expect(validatorInputs.length).toBeLessThanOrEqual(2)
    for (const input of validatorInputs) {
      expect(Object.keys(input).sort()).toEqual([
        'canonicalFact', 'evidenceSpan', 'exactEvidenceText', 'fullRawText', 'revision', 'target',
      ])
      expect(input.fullRawText).toBe(rawText)
      expect(input.evidenceSpan).toEqual({ startUtf16: 0, endUtf16: 11 })
      expect(input.exactEvidenceText).toBe(rawText)
      expect(input.target).toEqual({
        focusSpanWithinEvidence: { startUtf16: 10, endUtf16: 11 },
        exactFocusText: 'Q',
        protectedSpansWithinEvidence: protectedSpans({ subject: [{ startUtf16: 0, endUtf16: 1 }] }),
      })
      expect(input.revision).toEqual({ operation: 'assert', targetFacts: [], priorActiveFacts: [] })
    }
    expectPendingRaw(owner, captured.source.sourceKey, rawText)
    expect(owner.read().coverage[0]?.disposition).toBeUndefined()
    owner.close()
  })

  it('preserves a conditional knowledge fact only with the full owner-derived P, condition, and scope hull', async () => {
    const rawText = 'P 只在 C 下成立'
    let validatorInput: EntailmentInput | undefined
    const proposal = validKnowledgeProposal(
      { startUtf16: 0, endUtf16: 1 },
      protectedSpans({
        conditions: [{ startUtf16: 2, endUtf16: 10 }],
        applicability: [{ startUtf16: 2, endUtf16: 10 }],
      }),
      'conditioned',
    )
    const owner = (await makeOwner({
      semantics: {
        classifier: () => factsProposal(proposal),
        entailmentValidator: input => {
          validatorInput = input
          return entailed
        },
        noFactValidator: () => confirmedNoFact,
      },
    })).owner
    const captured = capture(owner, rawText, 301)

    await expect(owner.settle({ sourceKey: captured.source.sourceKey })).resolves.toMatchObject({ status: 'applied' })
    expect(validatorInput).toEqual({
      fullRawText: rawText,
      evidenceSpan: { startUtf16: 0, endUtf16: 10 },
      exactEvidenceText: rawText,
      target: {
        focusSpanWithinEvidence: { startUtf16: 0, endUtf16: 1 },
        exactFocusText: 'P',
        protectedSpansWithinEvidence: protectedSpans({
          conditions: [{ startUtf16: 2, endUtf16: 10 }],
          applicability: [{ startUtf16: 2, endUtf16: 10 }],
        }),
      },
      canonicalFact: {
        lane: 'existing_knowledge',
        epistemic: 'asserted',
        attitude: { ...ownCurrentAttitude, qualification: 'conditioned' },
      },
      revision: { operation: 'assert', targetFacts: [], priorActiveFacts: [] },
    })
    const disposition = terminalCoverage(owner).disposition
    expect(disposition?.status).toBe('applied')
    if (disposition?.status !== 'applied') throw new Error('conditional fact was not applied')
    expect(disposition.changes).toHaveLength(1)
    expect(disposition.changes[0]).toMatchObject({
      operation: 'assert',
      targetFactIds: [],
      fact: {
        lane: 'existing_knowledge', epistemic: 'asserted',
        evidence: {
          sourceKey: captured.source.sourceKey,
          evidenceSpan: { startUtf16: 0, endUtf16: 10 },
          exactEvidenceText: rawText,
          focusSpanWithinEvidence: { startUtf16: 0, endUtf16: 1 },
          protectedSpansWithinEvidence: protectedSpans({
            conditions: [{ startUtf16: 2, endUtf16: 10 }],
            applicability: [{ startUtf16: 2, endUtf16: 10 }],
          }),
          attitude: { ...ownCurrentAttitude, qualification: 'conditioned' },
        },
        useAuthorization,
      },
    })
    expect(Object.keys(disposition.changes[0]?.fact ?? {}).sort()).toEqual([
      'epistemic', 'evidence', 'lane', 'useAuthorization',
    ])
    expect(JSON.stringify(disposition)).not.toContain('"proposition":"P"')
    expect(JSON.stringify(disposition)).not.toContain('"summary"')
    expect(JSON.stringify(disposition)).not.toContain('"reasoning"')
    expect(owner.read().sources[0]?.rawText).toBeNull()
    owner.close()
  })

  it('does not reach a partial terminal state when a second round omits a previously contradicted fact', async () => {
    const rawText = '我长期关注 A，而且我已经知道 B'
    const interest = validInterestProposal(
      { startUtf16: 6, endUtf16: 7 },
      protectedSpans({ subject: [{ startUtf16: 0, endUtf16: 1 }], temporal: [{ startUtf16: 1, endUtf16: 3 }] }),
    )
    const knowledge = validKnowledgeProposal(
      { startUtf16: 16, endUtf16: 17 },
      protectedSpans({ subject: [{ startUtf16: 10, endUtf16: 11 }], temporal: [{ startUtf16: 11, endUtf16: 13 }] }),
    )
    let classifierCalls = 0
    let validatorCalls = 0
    const owner = (await makeOwner({
      semantics: {
        classifier: () => {
          classifierCalls += 1
          return classifierCalls === 1
            ? factsProposal(interest, knowledge)
            : factsProposal(interest)
        },
        entailmentValidator: input => {
          validatorCalls += 1
          return input.canonicalFact.lane === 'long_term_interest' ? entailed : contradicted
        },
        noFactValidator: () => confirmedNoFact,
      },
    })).owner
    const captured = capture(owner, rawText, 302)

    await expect(owner.settle({ sourceKey: captured.source.sourceKey })).resolves.toMatchObject({ status: 'pending' })
    expect(classifierCalls).toBeGreaterThanOrEqual(1)
    expect(classifierCalls).toBeLessThanOrEqual(2)
    expect(validatorCalls).toBeGreaterThanOrEqual(2)
    expect(validatorCalls).toBeLessThanOrEqual(3)
    expectPendingRaw(owner, captured.source.sourceKey, rawText)
    expect(owner.read().coverage[0]?.disposition).toBeUndefined()
    owner.close()
  })

  it('rejects an over-broad classifier subject before semantic validation and preserves the private raw source', async () => {
    const rawText = '我已经知道 P，今天的无关私密备注是 S'
    const proposal = validKnowledgeProposal(
      { startUtf16: 6, endUtf16: 7 },
      protectedSpans({ subject: [{ startUtf16: 0, endUtf16: 20 }] }),
    )
    let classifierCalls = 0
    let validatorCalls = 0
    const owner = (await makeOwner({
      semantics: {
        classifier: () => {
          classifierCalls += 1
          return factsProposal(proposal)
        },
        entailmentValidator: () => {
          validatorCalls += 1
          return entailed
        },
        noFactValidator: () => confirmedNoFact,
      },
    })).owner
    const captured = capture(owner, rawText, 303)

    await expect(owner.settle({ sourceKey: captured.source.sourceKey })).resolves.toMatchObject({ status: 'pending' })
    expect(classifierCalls).toBeGreaterThanOrEqual(1)
    expect(classifierCalls).toBeLessThanOrEqual(2)
    expect(validatorCalls).toBe(0)
    expectPendingRaw(owner, captured.source.sourceKey, rawText)
    expect(owner.read().coverage[0]?.disposition).toBeUndefined()
    owner.close()
  })

  it('uses fresh bounded classification after independent disagreement and leaves every exhausted, unknown, thrown, or aborted source pending with full raw text', async () => {
    const rawText = '我长期关注虚构主题 A，而且我已经知道虚构命题 P'
    const validProposal = validInterestProposal(
      { startUtf16: 5, endUtf16: 11 },
      protectedSpans({ subject: [{ startUtf16: 0, endUtf16: 1 }], temporal: [{ startUtf16: 1, endUtf16: 3 }] }),
    )
    const validKnowledge = validKnowledgeProposal(
      { startUtf16: 19, endUtf16: 25 },
      protectedSpans({ subject: [{ startUtf16: 14, endUtf16: 15 }], temporal: [{ startUtf16: 15, endUtf16: 17 }] }),
    )
    let classifierCalls = 0
    let noFactCalls = 0
    let entailmentCalls = 0
    const recoveryOwner = (await makeOwner({
      semantics: {
        classifier: () => {
          classifierCalls += 1
          return classifierCalls === 1
            ? noFactProposal('not_personal_fact')
            : factsProposal(validProposal)
        },
        noFactValidator: input => {
          noFactCalls += 1
          expect(input).toEqual({
            fullRawText: rawText,
            proposedReason: 'not_personal_fact',
            useAuthorization,
          })
          return contradicted
        },
        entailmentValidator: () => {
          entailmentCalls += 1
          return entailed
        },
      },
    })).owner
    const recoveryCapture = capture(recoveryOwner, rawText, 401)

    await expect(recoveryOwner.settle({ sourceKey: recoveryCapture.source.sourceKey })).resolves.toMatchObject({ status: 'applied' })
    expect(classifierCalls).toBe(2)
    expect(noFactCalls).toBe(1)
    expect(entailmentCalls).toBe(1)
    expect(terminalCoverage(recoveryOwner).status).toBe('applied')
    expect(terminalCoverage(recoveryOwner).status).not.toBe('ignored')
    recoveryOwner.close()

    const failures = [
      {
        name: 'two rounds with one contradicted fact never partially commit the source',
        classifier: () => factsProposal(validProposal, validKnowledge),
        entailmentValidator: (input: EntailmentInput) => input.canonicalFact.lane === 'long_term_interest'
          ? entailed
          : contradicted,
        noFactValidator: () => confirmedNoFact,
      },
      {
        name: 'two contradicted no-fact validations',
        classifier: () => noFactProposal('insufficient_long_term_signal'),
        entailmentValidator: () => entailed,
        noFactValidator: () => contradicted,
      },
      {
        name: 'unknown independent entailment',
        classifier: () => factsProposal(validProposal),
        entailmentValidator: () => unknown,
        noFactValidator: () => confirmedNoFact,
      },
      {
        name: 'validator output with an extra key is not accepted',
        classifier: () => factsProposal(validProposal),
        entailmentValidator: () => ({ kind: 'target_and_revision_confirmed', explanation: 'forged' }),
        noFactValidator: () => confirmedNoFact,
      },
      {
        name: 'legacy fact-only validator approval kind is not accepted',
        classifier: () => factsProposal(validProposal),
        entailmentValidator: () => ({ kind: 'target_entailed_with_minimal_evidence' }),
        noFactValidator: () => confirmedNoFact,
      },
      {
        name: 'another legacy validator approval kind is not accepted',
        classifier: () => factsProposal(validProposal),
        entailmentValidator: () => ({ kind: 'entailed_without_semantic_loss' }),
        noFactValidator: () => confirmedNoFact,
      },
      {
        name: 'no-fact validator output with an extra key is not accepted',
        classifier: () => noFactProposal('not_personal_fact'),
        entailmentValidator: () => entailed,
        noFactValidator: () => ({ kind: 'confirmed_no_fact', explanation: 'forged' }),
      },
      {
        name: 'classifier throws',
        classifier: () => { throw new Error('synthetic classifier failure') },
        entailmentValidator: () => entailed,
        noFactValidator: () => confirmedNoFact,
      },
    ] as const

    for (const failure of failures) {
      let calls = 0
      const owner = (await makeOwner({
        semantics: {
          classifier: input => {
            calls += 1
            expect(input.rawText).toBe(rawText)
            return failure.classifier()
          },
          entailmentValidator: failure.entailmentValidator,
          noFactValidator: failure.noFactValidator,
        },
      })).owner
      const captured = capture(owner, rawText, 410 + failures.findIndex(entry => entry.name === failure.name))

      await expect(owner.settle({ sourceKey: captured.source.sourceKey }), failure.name).resolves.toMatchObject({ status: 'pending' })
      expect(calls, failure.name).toBeGreaterThan(0)
      expect(calls, failure.name).toBeLessThanOrEqual(2)
      expectPendingRaw(owner, captured.source.sourceKey, rawText)
      owner.close()
    }

    let abortedClassifierCalls = 0
    const abortedOwner = (await makeOwner({
      semantics: {
        classifier: () => {
          abortedClassifierCalls += 1
          return factsProposal(validProposal)
        },
        entailmentValidator: () => entailed,
        noFactValidator: () => confirmedNoFact,
      },
    })).owner
    const abortedCapture = capture(abortedOwner, rawText, 420)
    const controller = new AbortController()
    controller.abort()

    await expect(abortedOwner.settle({ sourceKey: abortedCapture.source.sourceKey, signal: controller.signal })).resolves.toMatchObject({ status: 'pending' })
    expect(abortedClassifierCalls).toBe(0)
    expectPendingRaw(abortedOwner, abortedCapture.source.sourceKey, rawText)
    abortedOwner.close()
  })

  it('surfaces terminal persistence failure when the successful validator closes the owner without retrying semantics', async () => {
    const rawText = '我长期关注 P'
    const proposal = validInterestProposal(
      { startUtf16: 6, endUtf16: 7 },
      protectedSpans({ subject: [{ startUtf16: 0, endUtf16: 1 }], temporal: [{ startUtf16: 1, endUtf16: 3 }] }),
    )
    let classifierCalls = 0
    let validatorCalls = 0
    let owner: PersonalContextOwner | undefined
    const semantics: SemanticPorts = {
      classifier: () => {
        classifierCalls += 1
        return factsProposal(proposal)
      },
      entailmentValidator: () => {
        validatorCalls += 1
        owner?.close()
        return entailed
      },
      noFactValidator: () => confirmedNoFact,
    }
    owner = (await makeOwner({ semantics })).owner
    const captured = capture(owner, rawText, 421)

    let rejection: unknown
    try {
      await owner.settle({ sourceKey: captured.source.sourceKey })
    } catch (error) {
      rejection = error
    }
    expect(rejection).toBeInstanceOf(Error)
    expect(String(rejection)).toMatch(/store|owner|closed|database|persist/i)
    expect(String(rejection)).not.toContain('semantic_validation_failed')
    expect(classifierCalls).toBe(1)
    expect(validatorCalls).toBe(1)
  })

  it('rejects engagement and assistant carriers, ignores only independently confirmed no-fact, then replays the scrubbed terminal source idempotently', async () => {
    const rawTelegramCases = [
      ['like', '我给虚构对象甲点了赞。', 'object_feedback_without_long_term_scope'],
      ['save', '我保存了虚构对象乙。', 'object_feedback_without_long_term_scope'],
      ['assistant summary', '助手总结提到了虚构对象丙。', 'reported_or_mentioned'],
      ['shown', '系统展示了虚构对象丁。', 'not_personal_fact'],
      ['processed', '系统已处理虚构对象戊。', 'not_personal_fact'],
      ['click', '我点击了虚构对象己。', 'not_personal_fact'],
    ] as const

    for (const [name, telegramRawText, proposedReason] of rawTelegramCases) {
      let classifierCallsForCase = 0
      let noFactCallsForCase = 0
      let entailmentCallsForCase = 0
      const caseOwner = (await makeOwner({
        semantics: {
          classifier: input => {
            classifierCallsForCase += 1
            expect(Object.keys(input).sort(), name).toEqual(['activeFacts', 'rawText', 'sourceKey', 'useAuthorization'])
            expect(input.rawText, name).toBe(telegramRawText)
            expect(input.useAuthorization, name).toEqual(useAuthorization)
            expect(input.activeFacts, name).toEqual([])
            return noFactProposal(proposedReason)
          },
          entailmentValidator: () => {
            entailmentCallsForCase += 1
            return entailed
          },
          noFactValidator: input => {
            noFactCallsForCase += 1
            expect(input, name).toEqual({
              fullRawText: telegramRawText,
              proposedReason,
              useAuthorization,
            })
            return confirmedNoFact
          },
        },
      })).owner
      const caseCapture = capture(caseOwner, telegramRawText, 510 + rawTelegramCases.findIndex(entry => entry[0] === name))

      const ignored = await caseOwner.settle({ sourceKey: caseCapture.source.sourceKey })
      expect(ignored, name).toMatchObject({
        sourceKey: caseCapture.source.sourceKey, status: 'ignored',
        disposition: { schemaVersion: 2, status: 'ignored', reason: proposedReason },
      })
      expectTerminalMetadata(ignored)
      expect(classifierCallsForCase, name).toBe(1)
      expect(noFactCallsForCase, name).toBe(1)
      expect(entailmentCallsForCase, name).toBe(0)
      expect(caseOwner.read().sources[0]?.rawText, name).toBeNull()
      caseOwner.close()
    }

    const rawText = '虚构对象被点赞或保存，但这不是长期个人事实。'
    let classifierCalls = 0
    let noFactCalls = 0
    let entailmentCalls = 0
    const owner = (await makeOwner({
      semantics: {
        classifier: input => {
          classifierCalls += 1
          expect(input).toEqual({
            sourceKey: input.sourceKey,
            rawText,
            useAuthorization,
            activeFacts: [],
          })
          return noFactProposal('object_feedback_without_long_term_scope')
        },
        entailmentValidator: () => {
          entailmentCalls += 1
          return entailed
        },
        noFactValidator: input => {
          noFactCalls += 1
          expect(Object.keys(input).sort()).toEqual(['fullRawText', 'proposedReason', 'useAuthorization'])
          expect(input).toEqual({
            fullRawText: rawText,
            proposedReason: 'object_feedback_without_long_term_scope',
            useAuthorization,
          })
          return confirmedNoFact
        },
      },
    })).owner
    const captured = capture(owner, rawText, 501)
    const sourceKey = captured.source.sourceKey
    const illegalCarriers = [
      ['like', true],
      ['save', true],
      ['assistantSummary', 'generated assistant summary'],
      ['shown', true],
      ['processed', true],
      ['click', { button: 'synthetic' }],
      ['rawText', rawText],
      ['sourceKind', 'telegram_inbound'],
      ['legacy', true],
      ['signal', { aborted: true }],
    ] as const

    for (const [key, value] of illegalCarriers) {
      await expectRejected(() => owner.settle({ sourceKey, [key]: value } as unknown as { sourceKey: string }))
      expectPendingRaw(owner, sourceKey, rawText)
    }
    expect(classifierCalls).toBe(0)
    expect(noFactCalls).toBe(0)
    expect(entailmentCalls).toBe(0)

    const terminal = await owner.settle({ sourceKey })
    expect(terminal).toMatchObject({
      sourceKey, status: 'ignored',
      disposition: { schemaVersion: 2, status: 'ignored', reason: 'object_feedback_without_long_term_scope' },
    })
    expectTerminalMetadata(terminal)
    expect(classifierCalls).toBe(1)
    expect(noFactCalls).toBe(1)
    expect(entailmentCalls).toBe(0)
    expect(owner.read().sources[0]?.rawText).toBeNull()
    expect(terminalCoverage(owner)).toEqual(terminal)

    await expect(owner.settle({ sourceKey })).resolves.toEqual(terminal)
    expect(classifierCalls).toBe(1)
    expect(noFactCalls).toBe(1)

    const replay = capture(owner, rawText, 501)
    expect(replay.source.rawText).toBeNull()
    expect(replay.coverage).toEqual(terminal)
    expect(owner.read().sources).toHaveLength(1)
    expect(owner.read().coverage).toHaveLength(1)
    await expectRejected(() => capture(owner, `${rawText}冲突`, 501))
    expect(owner.read().sources[0]?.rawText).toBeNull()
    expect(terminalCoverage(owner)).toEqual(terminal)
    owner.close()
  })
})
