import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createCandidateMaterialProjection,
  createCrossSourceEditor,
  createCurrentContextProjection,
  createMechanicalAdmission,
  createPeriodBusinessFinalizer,
  createPersonalFeedScopeService,
  candidateIdentity,
  sourceIdentity,
  sourceStableReference,
  type CandidateMaterial,
  type ExternalPeriodScopeInput,
  type MaterialFact,
  type ReportedMaterialCandidate,
  type SourceCandidateReportAccepted,
  type UnscreenedMaterialCandidate,
  type UnscreenedSourceCandidateReport,
} from '../src/index.ts'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

async function createFixture(options: { readonly withNomination?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'personal-feed-todo03-'))
  temporaryDirectories.push(directory)

  const todo01LedgerPath = join(directory, 'period-scopes.jsonl')
  const reportLedgerPath = join(directory, 'source-candidate-reports.jsonl')
  const candidatePeriodLedgerPath = join(directory, 'candidate-period-facts.jsonl')
  const editingInputLedgerPath = join(directory, 'editing-inputs.jsonl')
  const source = sourceIdentity('x')
  const input: ExternalPeriodScopeInput = {
    requestIdentity: 'dsh-cron:cron-feed:todo03-run-1',
    trigger: 'scheduled',
    scheduledFor: '2026-08-24T13:30:00.000Z',
    claimedAt: '2026-08-24T13:30:01.000Z',
    runId: 'cron-feed@2026-08-24T13:30:00.000Z',
    requiredSources: [source],
    reportingWindowClosesAt: '2026-08-24T13:35:00.000Z',
  }
  const scopeService = createPersonalFeedScopeService({
    ledgerPath: todo01LedgerPath,
    sourceScopes: [{
      source,
      mechanicalAdmission: createMechanicalAdmission(source),
      candidateMaterialProjection: createCandidateMaterialProjection(source),
    }],
    currentContextProjection: createCurrentContextProjection(),
  })
  const established = await scopeService.establishExternalPeriodScope(input)
  const period = established.c01.value.period
  const mechanicalScope = established.c32[0].value
  const materialScope = established.c35[0].value

  const candidate = (candidateId = 'candidate-1'): UnscreenedMaterialCandidate => {
    const reference = {
      source,
      candidate: candidateIdentity(candidateId),
      stableReference: sourceStableReference(`x:${candidateId}`),
    }
    const nomination = options.withNomination === true
      ? { kind: 'exploration', identity: `${candidateId}:nomination` }
      : undefined
    return {
      period,
      candidate: reference,
      qualification: {
        branch: 'unscreened',
        contract: 'C08',
        scope: mechanicalScope,
        period,
        candidate: reference,
        acceptedQualification: { contract: 'C08' },
      },
      materialBasis: {
        candidate: reference,
        acceptedBasis: { contract: 'C09' },
      },
      ...(nomination === undefined ? {} : { nomination }),
    }
  }
  const report = (members: readonly UnscreenedMaterialCandidate[] = [candidate()]): UnscreenedSourceCandidateReport => ({
    branch: 'unscreened',
    scope: materialScope,
    period,
    source,
    candidates: members,
  })

  const finalizer = createPeriodBusinessFinalizer({
    periodScopeLedgerPath: todo01LedgerPath,
    reportLedgerPath,
    candidatePeriodLedgerPath,
    now: () => '2026-08-24T13:32:00.000Z',
  })

  const acceptedReportResult = finalizer.acceptSourceCandidateReport(report())
  expect(acceptedReportResult.status).toBe('accepted')
  if (acceptedReportResult.status !== 'accepted') throw new Error('fixture C36 must be accepted')

  return {
    directory,
    reportLedgerPath,
    candidatePeriodLedgerPath,
    editingInputLedgerPath,
    period,
    candidate,
    report,
    finalizer,
    createFinalizer: () => createPeriodBusinessFinalizer({
      periodScopeLedgerPath: todo01LedgerPath,
      reportLedgerPath,
      candidatePeriodLedgerPath,
      now: () => '2026-08-24T13:32:00.000Z',
    }),
    createEditor: () => createCrossSourceEditor({
      candidatePeriodLedgerPath,
      editingInputLedgerPath,
    }),
    acceptedReport: acceptedReportResult.value,
  }
}

function reported(
  acceptedReport: SourceCandidateReportAccepted,
  candidate: UnscreenedMaterialCandidate,
): ReportedMaterialCandidate {
  return { report: acceptedReport, candidate }
}

function candidateMaterial(
  acceptedIntoPeriod: Record<string, unknown>,
  candidate: UnscreenedMaterialCandidate,
): CandidateMaterial {
  const nomination = acceptedIntoPeriod.nomination
  return {
    acceptedIntoPeriod: acceptedIntoPeriod as CandidateMaterial['acceptedIntoPeriod'],
    period: candidate.period,
    candidate: candidate.candidate,
    boundedContent: { title: 'A bounded candidate fact' },
    attribution: { source: candidate.candidate.source },
    exactLookup: { stableReference: candidate.candidate.stableReference },
    ...(nomination === undefined ? {} : { nomination }),
  }
}

function materialFormedFact(
  acceptedIntoPeriod: Record<string, unknown>,
  candidate: UnscreenedMaterialCandidate,
): MaterialFact {
  return {
    kind: 'material_formed',
    acceptedIntoPeriod: acceptedIntoPeriod as MaterialFact & { acceptedIntoPeriod: unknown }['acceptedIntoPeriod'],
    period: candidate.period,
    candidate: candidate.candidate,
    materialFormedFact: { available: true },
  } as MaterialFact
}

describe('TODO 03 candidate enters the period and becomes editing input', () => {
  it('only exposes C26/C16 on a finalizer configured with candidate-period persistence', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'personal-feed-todo03-options-'))
    temporaryDirectories.push(directory)

    const scopeOnly = createPeriodBusinessFinalizer()
    expect(scopeOnly).not.toHaveProperty('acceptCandidateIntoPeriod')
    expect(scopeOnly).not.toHaveProperty('acceptMaterialFact')

    const c36Only = createPeriodBusinessFinalizer({
      periodScopeLedgerPath: join(directory, 'period-scopes.jsonl'),
      reportLedgerPath: join(directory, 'source-candidate-reports.jsonl'),
      now: () => '2026-08-24T13:32:00.000Z',
    })
    expect(c36Only).not.toHaveProperty('acceptCandidateIntoPeriod')
    expect(c36Only).not.toHaveProperty('acceptMaterialFact')

    const full = createPeriodBusinessFinalizer({
      periodScopeLedgerPath: join(directory, 'period-scopes-full.jsonl'),
      reportLedgerPath: join(directory, 'source-candidate-reports-full.jsonl'),
      candidatePeriodLedgerPath: join(directory, 'candidate-period-facts.jsonl'),
      now: () => '2026-08-24T13:32:00.000Z',
    })
    expect(full).toHaveProperty('acceptCandidateIntoPeriod')
    expect(full).toHaveProperty('acceptMaterialFact')
  })

  it('accepts only the exact C36 member, then uses one C26 credential for C16 and C10', async () => {
    const fixture = await createFixture()
    const member = fixture.candidate()

    const acceptedIntoPeriodResult = fixture.finalizer.acceptCandidateIntoPeriod(
      reported(fixture.acceptedReport, member),
    )

    expect(acceptedIntoPeriodResult.status).toBe('accepted')
    if (acceptedIntoPeriodResult.status !== 'accepted') throw new Error('C26 must accept the C36 member')

    const acceptedIntoPeriod = acceptedIntoPeriodResult.value
    const material = candidateMaterial(acceptedIntoPeriod, member)
    const formedFact = materialFormedFact(acceptedIntoPeriod, member)

    expect(material.acceptedIntoPeriod).toBe(acceptedIntoPeriod)
    expect((formedFact as { acceptedIntoPeriod: unknown }).acceptedIntoPeriod).toBe(acceptedIntoPeriod)

    const editor = fixture.createEditor()
    const reportLedgerBeforeEditing = readFileSync(fixture.reportLedgerPath, 'utf8')
    const editingInputResult = editor.acceptCandidateMaterial(material)
    expect(editingInputResult).toEqual({ status: 'accepted', value: { material } })

    expect(editor.listAcceptedInputs()).toEqual([material])
    expect(readFileSync(fixture.reportLedgerPath, 'utf8')).toBe(reportLedgerBeforeEditing)

    const materialFactResult = fixture.finalizer.acceptMaterialFact(formedFact)
    expect(materialFactResult).toEqual({ status: 'accepted', value: { fact: formedFact } })

    expect(fixture.finalizer).not.toHaveProperty('acceptCandidateMaterial')
    expect(editor).not.toHaveProperty('acceptCandidateIntoPeriod')
    expect(editor).not.toHaveProperty('acceptMaterialFact')
  })

  it('rejects a report-external candidate and a material fact forged with a conflicting C26 identity', async () => {
    const fixture = await createFixture()
    const member = fixture.candidate()
    const reportExternalMember = fixture.candidate('candidate-2')

    const reportExternalResult = fixture.finalizer.acceptCandidateIntoPeriod(
      reported(fixture.acceptedReport, reportExternalMember),
    )
    expect(reportExternalResult.status).toBe('rejected')
    expect(fixture.finalizer.acceptMaterialFact(materialFormedFact(
      { period: fixture.period, candidate: reportExternalMember.candidate },
      reportExternalMember,
    ))).toMatchObject({ status: 'rejected' })

    const acceptedIntoPeriodResult = fixture.finalizer.acceptCandidateIntoPeriod(
      reported(fixture.acceptedReport, member),
    )
    expect(acceptedIntoPeriodResult.status).toBe('accepted')
    if (acceptedIntoPeriodResult.status !== 'accepted') throw new Error('C26 must accept the real member')

    const acceptedIntoPeriod = acceptedIntoPeriodResult.value
    const forgedFact = materialFormedFact(
      { ...acceptedIntoPeriod, candidate: reportExternalMember.candidate },
      member,
    )
    expect(fixture.finalizer.acceptMaterialFact(forgedFact)).toMatchObject({ status: 'rejected' })

    const editor = fixture.createEditor()
    const forgedMaterial = candidateMaterial(
      { ...acceptedIntoPeriod, candidate: reportExternalMember.candidate },
      member,
    )
    expect(editor.acceptCandidateMaterial(forgedMaterial)).toMatchObject({ status: 'rejected' })

    expect(editor.listAcceptedInputs()).toEqual([])
  })

  it('rejects a second C26 request with the same candidate identity but a different stable reference', async () => {
    const fixture = await createFixture()
    const member = fixture.candidate()
    const firstResult = fixture.finalizer.acceptCandidateIntoPeriod(
      reported(fixture.acceptedReport, member),
    )
    expect(firstResult.status).toBe('accepted')
    if (firstResult.status !== 'accepted') throw new Error('C26 must accept the first member')

    const candidateWithConflictingReference = {
      ...member.candidate,
      stableReference: sourceStableReference('x:conflicting-stable-reference'),
    }
    const conflictingMember: UnscreenedMaterialCandidate = {
      ...member,
      candidate: candidateWithConflictingReference,
      qualification: {
        ...member.qualification,
        candidate: candidateWithConflictingReference,
      },
      materialBasis: {
        ...member.materialBasis,
        candidate: candidateWithConflictingReference,
      },
    }
    const candidatePeriodBeforeRetry = readFileSync(fixture.candidatePeriodLedgerPath, 'utf8')

    expect(fixture.finalizer.acceptCandidateIntoPeriod(
      reported(fixture.acceptedReport, conflictingMember),
    )).toMatchObject({ status: 'rejected' })
    expect(readFileSync(fixture.candidatePeriodLedgerPath, 'utf8')).toBe(candidatePeriodBeforeRetry)
    expect(JSON.parse(candidatePeriodBeforeRetry.trim()).accepted).toEqual(firstResult.value)
  })

  it('rejects nomination drift and incomplete or conflicting material without adding an input', async () => {
    const fixture = await createFixture({ withNomination: true })
    const member = fixture.candidate()
    const acceptedIntoPeriodResult = fixture.finalizer.acceptCandidateIntoPeriod(
      reported(fixture.acceptedReport, member),
    )
    expect(acceptedIntoPeriodResult.status).toBe('accepted')
    if (acceptedIntoPeriodResult.status !== 'accepted') throw new Error('C26 must accept the nominated member')

    const acceptedIntoPeriod = acceptedIntoPeriodResult.value
    const material = candidateMaterial(acceptedIntoPeriod, member)
    const editor = fixture.createEditor()
    const editingLedgerBeforeRejects = existsSync(fixture.editingInputLedgerPath)
      ? readFileSync(fixture.editingInputLedgerPath, 'utf8')
      : ''

    expect(editor.acceptCandidateMaterial({
      ...material,
      nomination: { kind: 'exploration', identity: 'forged-nomination' },
    })).toMatchObject({ status: 'rejected' })
    expect(editor.acceptCandidateMaterial((() => {
      const { nomination: _nomination, ...withoutNomination } = material
      return withoutNomination
    })() as CandidateMaterial)).toMatchObject({ status: 'rejected' })

    for (const missingField of ['boundedContent', 'attribution', 'exactLookup'] as const) {
      const incomplete = { ...material }
      delete incomplete[missingField]
      expect(editor.acceptCandidateMaterial(incomplete as CandidateMaterial))
        .toMatchObject({ status: 'rejected' })
    }

    expect(editor.listAcceptedInputs()).toEqual([])
    expect(existsSync(fixture.editingInputLedgerPath)
      ? readFileSync(fixture.editingInputLedgerPath, 'utf8')
      : '').toBe(editingLedgerBeforeRejects)

    expect(editor.acceptCandidateMaterial(material)).toMatchObject({ status: 'accepted' })
    expect(editor.acceptCandidateMaterial({
      ...material,
      boundedContent: { title: 'conflicting second material' },
    })).toMatchObject({ status: 'rejected' })
    expect(editor.listAcceptedInputs()).toEqual([material])
    expect(readFileSync(fixture.editingInputLedgerPath, 'utf8').trim().split('\n')).toHaveLength(1)
  })

  it('is idempotent across duplicate C10 submission and finalizer/editor reconstruction', async () => {
    const fixture = await createFixture()
    const member = fixture.candidate()
    const acceptedIntoPeriodResult = fixture.finalizer.acceptCandidateIntoPeriod(
      reported(fixture.acceptedReport, member),
    )
    expect(acceptedIntoPeriodResult.status).toBe('accepted')
    if (acceptedIntoPeriodResult.status !== 'accepted') throw new Error('C26 must accept the member')

    const acceptedIntoPeriod = acceptedIntoPeriodResult.value
    const formedFact = materialFormedFact(acceptedIntoPeriod, member)
    expect(fixture.finalizer.acceptMaterialFact(formedFact).status).toBe('accepted')
    expect(readFileSync(fixture.candidatePeriodLedgerPath, 'utf8').trim().split('\n').map(line => {
      return (JSON.parse(line) as { event: string }).event
    })).toEqual(['candidate_accepted_into_period', 'material_fact_recorded'])
    const material = candidateMaterial(acceptedIntoPeriod, member)
    const editor = fixture.createEditor()

    expect(editor.acceptCandidateMaterial(material)).toEqual({
      status: 'accepted',
      value: { material },
    })
    expect(editor.acceptCandidateMaterial(structuredClone(material))).toEqual({
      status: 'accepted',
      value: { material },
    })
    expect(editor.listAcceptedInputs()).toEqual([material])

    const candidatePeriodBeforeRebuild = readFileSync(fixture.candidatePeriodLedgerPath, 'utf8')
    const rebuiltFinalizer = fixture.createFinalizer()
    expect(rebuiltFinalizer.acceptCandidateIntoPeriod(
      reported(fixture.acceptedReport, member),
    )).toEqual({ status: 'accepted', value: acceptedIntoPeriod })
    expect(rebuiltFinalizer.acceptMaterialFact(formedFact)).toEqual({
      status: 'accepted',
      value: { fact: formedFact },
    })
    expect(readFileSync(fixture.candidatePeriodLedgerPath, 'utf8')).toBe(candidatePeriodBeforeRebuild)

    const rebuiltEditor = createCrossSourceEditor({
      candidatePeriodLedgerPath: fixture.candidatePeriodLedgerPath,
      editingInputLedgerPath: fixture.editingInputLedgerPath,
    })
    expect(rebuiltEditor.listAcceptedInputs()).toEqual([material])

    const persistedLines = readFileSync(fixture.editingInputLedgerPath, 'utf8').trim().split('\n')
    expect(persistedLines).toHaveLength(1)
    const persisted = JSON.parse(persistedLines[0]) as Record<string, unknown>
    expect(persisted).toMatchObject({ event: 'editing_input_accepted' })
    expect(persisted).not.toHaveProperty('closure')
    expect(persisted).not.toHaveProperty('conclusion')
    expect(persisted).not.toHaveProperty('content')
    expect(persisted).not.toHaveProperty('body')
  })
})
