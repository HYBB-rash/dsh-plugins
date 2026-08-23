import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createCandidateMaterialProjection,
  createCurrentContextProjection,
  createMechanicalAdmission,
  createPeriodBusinessFinalizer,
  createPersonalFeedScopeService,
  candidateIdentity,
  sourceIdentity,
  sourceStableReference,
  type ExternalPeriodScopeInput,
  type UnscreenedMaterialCandidate,
  type UnscreenedSourceCandidateReport,
} from '../src/index.ts'

const temporaryDirectories: string[] = []

afterEach(() => {
  temporaryDirectories.splice(0).forEach(directory => {
    rmSync(directory, { recursive: true, force: true })
  })
})

async function createFixture(now = '2026-08-23T13:32:00.000Z') {
  const directory = mkdtempSync(join(tmpdir(), 'personal-feed-candidate-report-'))
  temporaryDirectories.push(directory)

  const todo01LedgerPath = join(directory, 'period-scopes.jsonl')
  const reportLedgerPath = join(directory, 'source-candidate-reports.jsonl')
  const x = sourceIdentity('x')
  const input: ExternalPeriodScopeInput = {
    requestIdentity: 'dsh-cron:cron-feed:run-1',
    trigger: 'scheduled',
    scheduledFor: '2026-08-23T13:30:00.000Z',
    claimedAt: '2026-08-23T13:30:01.000Z',
    runId: 'cron-feed@2026-08-23T13:30:00.000Z',
    requiredSources: [x],
    reportingWindowClosesAt: '2026-08-23T13:35:00.000Z',
  }
  const scopeService = createPersonalFeedScopeService({
    ledgerPath: todo01LedgerPath,
    sourceScopes: [{
      source: x,
      mechanicalAdmission: createMechanicalAdmission(x),
      candidateMaterialProjection: createCandidateMaterialProjection(x),
    }],
    currentContextProjection: createCurrentContextProjection(),
  })
  const established = await scopeService.establishExternalPeriodScope(input)
  const period = established.c01.value.period
  const reportingWindow = established.c34.value.window
  const mechanicalScope = established.c32[0].value
  const acceptedMaterialScope = established.c35[0].value

  // `branch` is the runtime discriminator required by C36's mutually exclusive union.
  const candidate = (candidateId = 'candidate-1', overrides: Partial<UnscreenedMaterialCandidate> = {}) => {
    const candidateReference = {
      source: x,
      candidate: candidateIdentity(candidateId),
      stableReference: sourceStableReference(`x:${candidateId}`),
    }
    return {
      period,
      candidate: candidateReference,
      qualification: {
        branch: 'unscreened',
        contract: 'C08',
        scope: mechanicalScope,
        period,
        candidate: candidateReference,
        acceptedQualification: { branch: 'unscreened', contract: 'C08' },
      },
      materialBasis: {
        candidate: candidateReference,
        acceptedBasis: { contract: 'C09' },
      },
      ...overrides,
    }
  }

  const report = (candidates: readonly UnscreenedMaterialCandidate[] = [candidate()]): UnscreenedSourceCandidateReport => ({
    branch: 'unscreened',
    scope: acceptedMaterialScope,
    period,
    source: x,
    candidates,
  })

  const finalizer = createPeriodBusinessFinalizer({
    periodScopeLedgerPath: todo01LedgerPath,
    reportLedgerPath,
    now: () => now,
  })

  return {
    todo01LedgerPath,
    reportLedgerPath,
    period,
    reportingWindow,
    mechanicalScope,
    acceptedMaterialScope,
    candidate,
    report,
    finalizer,
    createFinalizer: () => createPeriodBusinessFinalizer({
      periodScopeLedgerPath: todo01LedgerPath,
      reportLedgerPath,
      now: () => now,
    }),
  }
}

type Fixture = Awaited<ReturnType<typeof createFixture>>

describe('TODO 02 source candidate report / C36', () => {
  it('accepts one complete empty report in the existing C32/C35 source and window', async () => {
    const fixture = await createFixture()

    const result = fixture.finalizer.acceptSourceCandidateReport(fixture.report([]))

    expect(result.status).toBe('accepted')
    expect(result.value).toMatchObject({
      report: {
        branch: 'unscreened',
        period: fixture.period,
        source: sourceIdentity('x'),
        candidates: [],
      },
    })
  })

  it('accepts one complete report and freezes that source/window against a second report', async () => {
    const fixture = await createFixture()
    const firstReport = fixture.report([fixture.candidate('candidate-1')])

    expect(fixture.finalizer.acceptSourceCandidateReport(firstReport).status).toBe('accepted')

    const secondResult = fixture.finalizer.acceptSourceCandidateReport(
      fixture.report([fixture.candidate('candidate-2')]),
    )

    expect(secondResult.status).toBe('rejected')
    expect(secondResult.input).toEqual(fixture.report([fixture.candidate('candidate-2')]))
  })

  it('deep-freezes the accepted snapshot independently from later caller mutation', async () => {
    const fixture = await createFixture()
    const report = fixture.report([fixture.candidate('candidate-1')])
    const originalWindowIdentity = fixture.reportingWindow.window

    const result = fixture.finalizer.acceptSourceCandidateReport(report)

    expect(result.status).toBe('accepted')
    Reflect.set(report, 'source', sourceIdentity('mutated-source'))
    Reflect.set(report.candidates[0], 'materialBasis', undefined)
    Reflect.set(report.scope.scope.reportingWindow.window, 'window', 'mutated-window')

    expect(result.value?.report).toMatchObject({
      source: sourceIdentity('x'),
      candidates: [{ materialBasis: { acceptedBasis: { contract: 'C09' } } }],
      scope: { scope: { reportingWindow: { window: { window: originalWindowIdentity } } } },
    })
  })

  it('keeps one report unique after rebuilding the finalizer from the same ledgers', async () => {
    const fixture = await createFixture()

    expect(fixture.finalizer.acceptSourceCandidateReport(fixture.report()).status).toBe('accepted')

    const rebuiltFinalizer = fixture.createFinalizer()
    const duplicateResult = rebuiltFinalizer.acceptSourceCandidateReport(fixture.report())

    expect(duplicateResult.status).toBe('rejected')
  })

  it.each([
    {
      name: 'a different source',
      makeReport: (fixture: Fixture) => ({
        ...fixture.report(),
        source: sourceIdentity('reading-list'),
      }),
    },
    {
      name: 'a different period',
      makeReport: (fixture: Fixture) => ({
        ...fixture.report(),
        period: { run: 'run-2', period: 'period-2' },
      }),
    },
    {
      name: 'a different C35 waiting window',
      makeReport: (fixture: Fixture) => ({
        ...fixture.report(),
        scope: {
          ...fixture.acceptedMaterialScope,
          scope: {
            ...fixture.acceptedMaterialScope.scope,
            reportingWindow: {
              window: {
                ...fixture.reportingWindow,
                window: 'window-2',
              },
            },
          },
        },
      }),
    },
    {
      name: 'a report scope from another source C35',
      makeReport: (fixture: Fixture) => ({
        ...fixture.report(),
        scope: {
          ...fixture.acceptedMaterialScope,
          scope: {
            ...fixture.acceptedMaterialScope.scope,
            source: sourceIdentity('reading-list'),
          },
        },
      }),
    },
    {
      name: 'a candidate qualification from another source C32',
      makeReport: (fixture: Fixture) => fixture.report([fixture.candidate('candidate-1', {
        qualification: {
          ...fixture.candidate().qualification,
          scope: {
            ...fixture.mechanicalScope,
            source: sourceIdentity('reading-list'),
          },
        },
      })]),
    },
    {
      name: 'a mixed source-screening branch',
      makeReport: (fixture: Fixture) => ({
        ...fixture.report(),
        branch: 'screened',
      }),
    },
    {
      name: 'a missing qualification',
      makeReport: (fixture: Fixture) => fixture.report([
        fixture.candidate('candidate-1', { qualification: undefined }),
      ]),
    },
    {
      name: 'a missing C09 material basis',
      makeReport: (fixture: Fixture) => fixture.report([
        fixture.candidate('candidate-1', { materialBasis: undefined }),
      ]),
    },
    {
      name: 'a candidate outside the C35 scope',
      makeReport: (fixture: Fixture) => fixture.report([
        fixture.candidate('candidate-1', {
          period: { run: 'run-2', period: 'period-2' },
        }),
      ]),
    },
    {
      name: 'a duplicate candidate',
      makeReport: (fixture: Fixture) => fixture.report([
        fixture.candidate('candidate-1'),
        fixture.candidate('candidate-1'),
      ]),
    },
    {
      name: 'a report-shaped bypass candidate',
      makeReport: (fixture: Fixture) => fixture.candidate('candidate-1'),
    },
  ])('rejects $name without freezing an invalid report', async ({ makeReport }) => {
    const fixture = await createFixture()

    const result = fixture.finalizer.acceptSourceCandidateReport(makeReport(fixture))

    expect(result.status).toBe('rejected')
    expect(result.input).toEqual(makeReport(fixture))
  })

  it('rejects an invalid report, then accepts the legal first report', async () => {
    const fixture = await createFixture()
    const invalidReport = fixture.report([fixture.candidate('candidate-1', { materialBasis: undefined })])

    expect(fixture.finalizer.acceptSourceCandidateReport(invalidReport).status).toBe('rejected')
    expect(fixture.finalizer.acceptSourceCandidateReport(fixture.report()).status).toBe('accepted')
  })

  it('rejects one candidate identity paired with conflicting stable references', async () => {
    const fixture = await createFixture()
    const first = fixture.candidate('candidate-1')
    const conflictingReference = {
      ...first.candidate,
      stableReference: sourceStableReference('x:conflicting-reference'),
    }
    const conflicting = {
      ...first,
      candidate: conflictingReference,
      qualification: { ...first.qualification, candidate: conflictingReference },
      materialBasis: { ...first.materialBasis, candidate: conflictingReference },
    }

    const result = fixture.finalizer.acceptSourceCandidateReport(
      fixture.report([first, conflicting]),
    )

    expect(result.status).toBe('rejected')
  })

  it('rejects a report received after the C34 waiting boundary', async () => {
    const fixture = await createFixture('2026-08-23T13:35:00.001Z')

    const result = fixture.finalizer.acceptSourceCandidateReport(fixture.report())

    expect(result.status).toBe('rejected')
  })

  it('writes accepted reports to an independent append-only ledger without changing TODO 01', async () => {
    const fixture = await createFixture()
    const todo01Before = readFileSync(fixture.todo01LedgerPath, 'utf8')

    expect(fixture.finalizer.acceptSourceCandidateReport(fixture.report()).status).toBe('accepted')

    expect(readFileSync(fixture.todo01LedgerPath, 'utf8')).toBe(todo01Before)
    expect(readFileSync(fixture.reportLedgerPath, 'utf8')).not.toBe('')
  })
})
