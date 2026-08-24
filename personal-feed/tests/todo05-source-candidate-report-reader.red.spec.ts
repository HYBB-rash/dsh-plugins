import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createCandidateMaterialProjection,
  createCurrentContextProjection,
  createMechanicalAdmission,
  createPeriodBusinessFinalizer,
  createPersonalFeedScopeService,
  createSourceCandidateReportReader,
  candidateIdentity,
  sourceIdentity,
  sourceStableReference,
} from '../src/index.ts'
import {
  periodReferenceFor,
  reportingWindowIdentityFor,
  runIdentityFor,
  runRequestIdentity,
} from '../src/identity.ts'
import type {
  CandidateReportingWindowAccepted,
  ExternalPeriodScopeInput,
  MaterialProjectionReportScopeEstablished,
  PeriodIdentity,
  UnscreenedMaterialCandidate,
  UnscreenedSourceCandidateReport,
} from '../src/types.ts'
import type { SourceCandidateReportReader } from '../src/index.ts'

function expectDeepFrozen(value: unknown): void {
  if (typeof value !== 'object' || value === null) return
  expect(Object.isFrozen(value)).toBe(true)
  if (Array.isArray(value)) {
    value.forEach(expectDeepFrozen)
    return
  }
  Object.values(value).forEach(expectDeepFrozen)
}

const temporaryDirectories: string[] = []

afterEach(() => {
  temporaryDirectories.splice(0).forEach(directory => {
    rmSync(directory, { recursive: true, force: true })
  })
})

function snapshotDirectory(directory: string): readonly [string, string][] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      return snapshotDirectory(path).map(([childPath, contents]) => [
        join(entry.name, childPath),
        contents,
      ] as [string, string])
    }
    return [[entry.name, readFileSync(path).toString('base64')] as [string, string]]
  }).sort(([left], [right]) => left.localeCompare(right))
}

async function createFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'personal-feed-todo05-report-reader-'))
  temporaryDirectories.push(directory)

  const periodScopeLedgerPath = join(directory, 'period-scopes.jsonl')
  const reportLedgerPath = join(directory, 'source-candidate-reports.jsonl')
  const source = sourceIdentity('x')
  const input: ExternalPeriodScopeInput = {
    requestIdentity: 'dsh-cron:cron-feed:run-1',
    trigger: 'scheduled',
    scheduledFor: '2026-08-25T00:00:00.000Z',
    claimedAt: '2026-08-25T00:00:01.000Z',
    runId: 'cron-feed@2026-08-25T00:00:00.000Z',
    requiredSources: [source],
    reportingWindowClosesAt: '2026-08-25T00:05:00.000Z',
  }
  const scopeService = createPersonalFeedScopeService({
    ledgerPath: periodScopeLedgerPath,
    sourceScopes: [{
      source,
      mechanicalAdmission: createMechanicalAdmission(source),
      candidateMaterialProjection: createCandidateMaterialProjection(source),
    }],
    currentContextProjection: createCurrentContextProjection(),
  })
  const established = await scopeService.establishExternalPeriodScope(input)
  const period = established.c01.value.period
  const mechanicalScope = established.c32[0]!.value
  const acceptedMaterialScope = established.c35[0]!.value
  const candidateReference = {
    source,
    candidate: candidateIdentity('candidate-1'),
    stableReference: sourceStableReference('x:candidate-1'),
  }
  const candidate: UnscreenedMaterialCandidate = {
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
  }
  const report: UnscreenedSourceCandidateReport = {
    branch: 'unscreened',
    scope: acceptedMaterialScope,
    period,
    source,
    candidates: [candidate],
  }
  const finalizer = createPeriodBusinessFinalizer({
    periodScopeLedgerPath,
    reportLedgerPath,
    now: () => '2026-08-25T00:02:00.000Z',
  })
  return { directory, reportLedgerPath, acceptedMaterialScope, report, finalizer }
}

describe('TODO05 source candidate report reader bootstrap', () => {
  it('exposes a frozen reader with one method', async () => {
    const run = runIdentityFor(runRequestIdentity('run-1'))
    const period: PeriodIdentity = {
      run,
      period: periodReferenceFor(run),
    }
    const source = sourceIdentity('x')
    const reportingWindow: CandidateReportingWindowAccepted = {
      window: {
        window: reportingWindowIdentityFor('todo05-source-candidate-report-reader'),
        period,
        sources: [source],
        closesAt: '2026-08-25T01:00:00.000Z',
      },
    }
    const scope = {
      scope: {
        period,
        source,
        reportingWindow,
      },
    } satisfies MaterialProjectionReportScopeEstablished

    const reader: SourceCandidateReportReader = createSourceCandidateReportReader({
      reportLedgerPath: '/tmp/todo05-source-candidate-reports.jsonl',
    })

    expect(Object.isFrozen(reader)).toBe(true)
    expect(Reflect.ownKeys(reader)).toEqual(['readAcceptedSourceCandidateReport'])
    expect(typeof reader.readAcceptedSourceCandidateReport).toBe('function')
  })

  it('reads one real accepted C36 report without changing the directory', async () => {
    const fixture = await createFixture()
    const acceptedResult = fixture.finalizer.acceptSourceCandidateReport(fixture.report)
    expect(acceptedResult.status).toBe('accepted')
    if (acceptedResult.status !== 'accepted') return

    const before = snapshotDirectory(fixture.directory)
    const reader = createSourceCandidateReportReader({
      reportLedgerPath: fixture.reportLedgerPath,
    })

    const result = reader.readAcceptedSourceCandidateReport(fixture.acceptedMaterialScope)
    expect(result).toEqual({
      status: 'found',
      value: acceptedResult.value,
    })
    if (result.status === 'found') {
      expectDeepFrozen(result.value)
      expectDeepFrozen(result.value.report)
    }
    expect(snapshotDirectory(fixture.directory)).toEqual(before)
  })

  it('reports missing for a healthy absent report ledger without changing the directory', async () => {
    const fixture = await createFixture()
    const missingReportLedgerPath = join(fixture.directory, 'missing-source-candidate-reports.jsonl')
    const before = snapshotDirectory(fixture.directory)
    const reader = createSourceCandidateReportReader({
      reportLedgerPath: missingReportLedgerPath,
    })

    expect(reader.readAcceptedSourceCandidateReport(fixture.acceptedMaterialScope)).toEqual({
      status: 'missing',
      input: fixture.acceptedMaterialScope,
    })
    expect(snapshotDirectory(fixture.directory)).toEqual(before)
  })

  it('rejects an invalid runtime scope with the same invalid input reference', async () => {
    const fixture = await createFixture()
    const invalid = structuredClone(fixture.acceptedMaterialScope) as {
      scope: {
        reportingWindow: {
          window: Record<string, unknown>
        }
      }
    }
    delete invalid.scope.reportingWindow.window.closesAt
    const before = snapshotDirectory(fixture.directory)
    const reader = createSourceCandidateReportReader({
      reportLedgerPath: fixture.reportLedgerPath,
    })
    const result = reader.readAcceptedSourceCandidateReport(invalid as never)

    expect(result).toEqual({ status: 'rejected', input: invalid })
    expect(result.input).toBe(invalid)
    expect(snapshotDirectory(fixture.directory)).toEqual(before)
  })

  it('fails closed on a duplicated physical accepted C36 row without rewriting it', async () => {
    const fixture = await createFixture()
    expect(fixture.finalizer.acceptSourceCandidateReport(fixture.report).status).toBe('accepted')
    const line = readFileSync(fixture.reportLedgerPath, 'utf8').trimEnd()
    appendFileSync(fixture.reportLedgerPath, `${line}\n`)
    const before = snapshotDirectory(fixture.directory)
    const reader = createSourceCandidateReportReader({
      reportLedgerPath: fixture.reportLedgerPath,
    })

    expect(reader.readAcceptedSourceCandidateReport(fixture.acceptedMaterialScope)).toEqual({
      status: 'failed',
      input: fixture.acceptedMaterialScope,
    })
    expect(snapshotDirectory(fixture.directory)).toEqual(before)
  })

  it('fails closed on a consistently conflicting second report row without overwriting the first', async () => {
    const fixture = await createFixture()
    expect(fixture.finalizer.acceptSourceCandidateReport(fixture.report).status).toBe('accepted')
    const firstRow = JSON.parse(readFileSync(fixture.reportLedgerPath, 'utf8').trimEnd()) as {
      accepted: {
        report: {
          candidates: [{
            candidate: Record<string, unknown>
            qualification: { candidate: Record<string, unknown> }
            materialBasis: { candidate: Record<string, unknown> }
          }]
        }
      }
    }
    const conflictingRow = structuredClone(firstRow)
    const conflictingReference = {
      ...conflictingRow.accepted.report.candidates[0].candidate,
      candidate: 'candidate-2',
      stableReference: 'x:candidate-2',
    }
    const conflictingCandidate = conflictingRow.accepted.report.candidates[0]
    conflictingCandidate.candidate = conflictingReference
    conflictingCandidate.qualification.candidate = conflictingReference
    conflictingCandidate.materialBasis.candidate = conflictingReference
    appendFileSync(fixture.reportLedgerPath, `${JSON.stringify(conflictingRow)}\n`)
    const before = snapshotDirectory(fixture.directory)
    const reader = createSourceCandidateReportReader({
      reportLedgerPath: fixture.reportLedgerPath,
    })

    expect(reader.readAcceptedSourceCandidateReport(fixture.acceptedMaterialScope)).toEqual({
      status: 'failed',
      input: fixture.acceptedMaterialScope,
    })
    expect(snapshotDirectory(fixture.directory)).toEqual(before)
  })

  it('fails closed on a corrupt row derived from the real accepted row without rewriting it', async () => {
    const fixture = await createFixture()
    expect(fixture.finalizer.acceptSourceCandidateReport(fixture.report).status).toBe('accepted')
    const acceptedRow = JSON.parse(readFileSync(fixture.reportLedgerPath, 'utf8').trimEnd()) as Record<string, unknown>
    const corruptRow = structuredClone(acceptedRow)
    corruptRow.schemaVersion = 999
    writeFileSync(fixture.reportLedgerPath, `${JSON.stringify(corruptRow)}\n`)
    const before = snapshotDirectory(fixture.directory)
    const reader = createSourceCandidateReportReader({
      reportLedgerPath: fixture.reportLedgerPath,
    })

    expect(reader.readAcceptedSourceCandidateReport(fixture.acceptedMaterialScope)).toEqual({
      status: 'failed',
      input: fixture.acceptedMaterialScope,
    })
    expect(snapshotDirectory(fixture.directory)).toEqual(before)
  })

  it('fails closed when the report path is a real directory without side effects', async () => {
    const fixture = await createFixture()
    const before = snapshotDirectory(fixture.directory)
    const reader = createSourceCandidateReportReader({
      reportLedgerPath: fixture.directory,
    })

    expect(reader.readAcceptedSourceCandidateReport(fixture.acceptedMaterialScope)).toEqual({
      status: 'failed',
      input: fixture.acceptedMaterialScope,
    })
    expect(snapshotDirectory(fixture.directory)).toEqual(before)
  })
})
