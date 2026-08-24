import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  createXSourceCandidateReportPorts,
  prepareAndSubmitXSourceCandidateReport,
} from '../src/x-cron/source-candidate-report.ts'
import { createXFeedCronEnvironmentProvider } from '../src/x-cron/provider.ts'
import { createCronEnvironmentExtension } from '../src/cron-extension.ts'
import * as xCronProvider from '../src/x-cron/provider.ts'
import type { PythonCommandRequest, PythonCommandResult } from '../src/x-cron/python-ports.ts'
import { createFileProjectionSources } from '../src/fact-projection/file-projection-sources.ts'
import { FileNavigationSnapshotStore } from '../src/navigation/file-navigation-snapshot-store.ts'

/**
 * RED contract for the first source-side Personal Feed report seam.
 *
 * The helper is intentionally source-owned: it receives the finite current
 * collection after the Python adapter has parsed it, establishes C03 -> C08
 * -> C09 for that collection, and submits exactly one C35-scoped report to a
 * narrow C36 port.  The semantic X planner is a later continuation and is
 * never an input to report construction.
 */

type Candidate = {
  readonly id: string
  readonly url: string
  readonly text: string
  readonly time: string
  readonly user: string
  readonly media: readonly string[]
  readonly ts?: number
}

type CollectionEvidence = {
  readonly runId: string
  readonly source: 'x'
  readonly collectionPath: string
  readonly collectionBatch: string
  readonly deliveryId: string
  readonly ts: number
}

type CandidatePort = {
  readonly acceptAdmissionSourceFacts: ReturnType<typeof vi.fn>
  readonly acceptUnscreenedMechanicalCandidate: ReturnType<typeof vi.fn>
  readonly acceptMaterialSourceFacts: ReturnType<typeof vi.fn>
}

type ReportPort = {
  readonly submitSourceCandidateReport: ReturnType<typeof vi.fn>
}

function candidate(id: string, text = `${id} content`): Candidate {
  return {
    id,
    url: `https://x.com/alice/status/${id}`,
    text,
    time: '2026-08-23T15:00:00.000Z',
    user: 'alice',
    media: [],
    ts: 1_755_961_200,
  }
}

function candidateReference(item: Candidate) {
  return {
    source: 'x',
    candidate: `x-status:${item.id}`,
    stableReference: `x:status:${item.id}`,
  }
}

function collectionEvidence(trigger: 'scheduled' | 'manual'): CollectionEvidence {
  return {
    runId: `run:${trigger}`,
    source: 'x',
    collectionPath: `/runs/run:${trigger}/collection.jsonl`,
    collectionBatch: `/runs/run:${trigger}/collection.jsonl`,
    deliveryId: `delivery:${trigger}`,
    ts: 1_755_961_200,
  }
}

function scope(trigger: 'scheduled' | 'manual') {
  const period = { run: `run:${trigger}`, period: `period:${trigger}` }
  const reportingWindow = {
    window: {
      window: `window:${trigger}`,
      period,
      sources: ['x'],
      closesAt: '2026-08-23T16:00:00.000Z',
    },
  }
  const c32 = {
    period,
    source: 'x',
    start: {
      start: {
        period,
        startFact: { kind: 'external_run_opportunity_accepted', request: `request:${trigger}` },
        origin: trigger === 'manual'
          ? { kind: 'manual', request: `request:${trigger}` }
          : { kind: 'scheduled', trigger: '2026-08-23T15:00:00.000Z' },
      },
    },
    reportingWindow,
  }
  return {
    period,
    c32,
    c35: { scope: { period, source: 'x', reportingWindow } },
  }
}

type ContractStatus = 'accepted' | 'rejected' | 'failed' | 'unknown'
type FailureStage = 'c03' | 'c08' | 'c09'

function contractResult(status: ContractStatus, value: unknown, input: unknown) {
  return status === 'accepted' ? { status, value } : { status, input }
}

function ports(
  finalizerStatus: ContractStatus = 'accepted',
  failureStage?: FailureStage,
  failureStatus: ContractStatus = 'rejected',
): {
  readonly candidatePort: CandidatePort
  readonly reportPort: ReportPort
} {
  const candidatePort: CandidatePort = {
    acceptAdmissionSourceFacts: vi.fn(async facts => contractResult(
      failureStage === 'c03' ? failureStatus : 'accepted',
      { facts },
      facts,
    )),
    acceptUnscreenedMechanicalCandidate: vi.fn(async mechanicalCandidate => contractResult(
      failureStage === 'c08' ? failureStatus : 'accepted',
      {
        branch: 'unscreened',
        contract: 'C08',
        scope: mechanicalCandidate.scope,
        period: mechanicalCandidate.period,
        candidate: mechanicalCandidate.candidate,
        acceptedQualification: { kind: 'c08-accepted' },
      },
      mechanicalCandidate,
    )),
    acceptMaterialSourceFacts: vi.fn(async facts => contractResult(
      failureStage === 'c09' ? failureStatus : 'accepted',
      {
        candidate: facts.candidate,
        acceptedBasis: { kind: 'c09-accepted' },
      },
      facts,
    )),
  }
  const reportPort: ReportPort = {
    submitSourceCandidateReport: vi.fn(async report => contractResult(
      finalizerStatus,
      { report },
      report,
    )),
  }
  return { candidatePort, reportPort }
}

function prepareInput(
  trigger: 'scheduled' | 'manual',
  currentCollection: readonly Candidate[],
  finalizerStatus?: ContractStatus,
  failureStage?: FailureStage,
  failureStatus?: ContractStatus,
) {
  const portsForRun = ports(finalizerStatus, failureStage, failureStatus)
  const runScope = scope(trigger)
  return {
    input: {
      trigger,
      period: runScope.period,
      mechanicalAdmissionScope: runScope.c32,
      materialProjectionReportScope: runScope.c35,
      collectionEvidence: collectionEvidence(trigger),
      currentCollection,
      candidatePort: portsForRun.candidatePort,
      reportPort: portsForRun.reportPort,
    },
    ports: portsForRun,
  }
}

type ReportCandidateShape = {
  readonly candidate: { readonly candidate: string }
}

type SourceCandidateReportShape = {
  readonly candidates: readonly ReportCandidateShape[]
}

function reportCandidateIds(report: SourceCandidateReportShape): string[] {
  return report.candidates.map(entry => entry.candidate.candidate)
}

function expectedAdmissionFacts(item: Candidate, evidence: CollectionEvidence) {
  const reference = candidateReference(item)
  return {
    candidate: reference,
    authorization: {
      kind: 'x-current-collection-authorization',
      runId: evidence.runId,
      source: evidence.source,
      deliveryId: evidence.deliveryId,
    },
    originalObject: {
      kind: 'x-status',
      id: item.id,
      url: item.url,
      text: item.text,
    },
    attribution: {
      kind: 'x-author',
      handle: item.user,
    },
    exactDuplicateFact: {
      kind: 'x-current-collection-deduplicated',
      collectionPath: evidence.collectionPath,
      collectionBatch: evidence.collectionBatch,
      candidateId: item.id,
    },
    readabilityFact: {
      kind: 'x-current-collection-readable',
      candidateId: item.id,
    },
    candidateBasis: {
      kind: 'objective_new_content',
      fact: {
        kind: 'x-current-collection-item',
        runId: evidence.runId,
        collectionPath: evidence.collectionPath,
        collectionBatch: evidence.collectionBatch,
        deliveryId: evidence.deliveryId,
        candidateId: item.id,
        ts: evidence.ts,
      },
    },
  }
}

function expectedMaterialFacts(item: Candidate) {
  return {
    candidate: candidateReference(item),
    originalObject: {
      kind: 'x-status',
      id: item.id,
      url: item.url,
      text: item.text,
    },
    attribution: {
      kind: 'x-author',
      handle: item.user,
    },
    boundedRelations: {
      kind: 'x-status-media-relations',
      media: item.media,
    },
    accessibility: {
      kind: 'x-current-collection-readable',
      url: item.url,
    },
    version: {
      kind: 'x-status-version',
      observedAt: item.time,
    },
  }
}

describe('TODO02 X source-side complete candidate report seam', () => {
  it('runs C03 -> C08 -> C09 on all current-collection candidates before one C36 submission', async () => {
    const currentCollection = [candidate('1'), candidate('2')]
    const run = prepareInput('scheduled', currentCollection)

    await prepareAndSubmitXSourceCandidateReport(run.input as never)

    expect(run.ports.candidatePort.acceptAdmissionSourceFacts).toHaveBeenCalledTimes(2)
    expect(run.ports.candidatePort.acceptUnscreenedMechanicalCandidate).toHaveBeenCalledTimes(2)
    expect(run.ports.candidatePort.acceptMaterialSourceFacts).toHaveBeenCalledTimes(2)
    expect(run.ports.reportPort.submitSourceCandidateReport).toHaveBeenCalledOnce()
    expect(run.ports.candidatePort.acceptAdmissionSourceFacts.mock.invocationCallOrder[0])
      .toBeLessThan(run.ports.candidatePort.acceptUnscreenedMechanicalCandidate.mock.invocationCallOrder[0]!)
    expect(run.ports.candidatePort.acceptUnscreenedMechanicalCandidate.mock.invocationCallOrder[0])
      .toBeLessThan(run.ports.candidatePort.acceptMaterialSourceFacts.mock.invocationCallOrder[0]!)
    expect(run.ports.candidatePort.acceptMaterialSourceFacts.mock.invocationCallOrder[0])
      .toBeLessThan(run.ports.reportPort.submitSourceCandidateReport.mock.invocationCallOrder[0]!)

    currentCollection.forEach((item, index) => {
      const reference = candidateReference(item)
      const [admissionFacts] = run.ports.candidatePort.acceptAdmissionSourceFacts.mock.calls[index]!
      expect(admissionFacts).toEqual(expectedAdmissionFacts(item, run.input.collectionEvidence))

      const [mechanicalCandidate] = run.ports.candidatePort.acceptUnscreenedMechanicalCandidate.mock.calls[index]!
      expect(mechanicalCandidate).toEqual({
        scope: run.input.mechanicalAdmissionScope,
        period: run.input.period,
        candidate: reference,
        admissionFact: { facts: admissionFacts },
      })

      const [materialFacts] = run.ports.candidatePort.acceptMaterialSourceFacts.mock.calls[index]!
      expect(materialFacts).toEqual(expectedMaterialFacts(item))

      const c08Result = {
        branch: 'unscreened',
        contract: 'C08',
        scope: run.input.mechanicalAdmissionScope,
        period: run.input.period,
        candidate: reference,
        acceptedQualification: { kind: 'c08-accepted' },
      }
      const c09Result = {
        candidate: reference,
        acceptedBasis: { kind: 'c09-accepted' },
      }
      const [report] = run.ports.reportPort.submitSourceCandidateReport.mock.calls[0]!
      expect(report.candidates[index]).toEqual({
        period: run.input.period,
        candidate: reference,
        qualification: c08Result,
        materialBasis: c09Result,
      })
      expect(mechanicalCandidate.candidate).toEqual(reference)
      expect(materialFacts.candidate).toEqual(reference)
      expect(c08Result.candidate).toEqual(reference)
      expect(c09Result.candidate).toEqual(reference)
    })

    const [report] = run.ports.reportPort.submitSourceCandidateReport.mock.calls[0]!
    expect(report.scope).toEqual(run.input.materialProjectionReportScope)
    expect(report.period).toEqual(run.input.period)
    expect(report.source).toBe('x')
    expect(report.branch).toBe('unscreened')
    expect(reportCandidateIds(report)).toEqual(['x-status:1', 'x-status:2'])
  })

  it('keeps a candidate with missing published time and uses its observation timestamp for C09', async () => {
    const missingPublishedTime = {
      ...candidate('2084423106102526107'),
      time: '',
      ts: 1_787_510_409,
    }
    const run = prepareInput('scheduled', [
      candidate('1'),
      candidate('2'),
      missingPublishedTime,
      candidate('4'),
    ])

    await prepareAndSubmitXSourceCandidateReport(run.input as never)

    expect(run.ports.candidatePort.acceptAdmissionSourceFacts).toHaveBeenCalledTimes(4)
    expect(run.ports.candidatePort.acceptUnscreenedMechanicalCandidate).toHaveBeenCalledTimes(4)
    expect(run.ports.candidatePort.acceptMaterialSourceFacts).toHaveBeenCalledTimes(4)
    expect(run.ports.reportPort.submitSourceCandidateReport).toHaveBeenCalledOnce()
    const [report] = run.ports.reportPort.submitSourceCandidateReport.mock.calls[0]!
    expect(reportCandidateIds(report)).toEqual([
      'x-status:1',
      'x-status:2',
      'x-status:2084423106102526107',
      'x-status:4',
    ])
    const materialFacts = run.ports.candidatePort.acceptMaterialSourceFacts.mock.calls
      .map(([facts]) => facts)
      .find(facts => facts.candidate.candidate === 'x-status:2084423106102526107')
    expect(materialFacts.version).toEqual({
      kind: 'x-status-version',
      observedAt: '2026-08-23T18:40:09.000Z',
    })
    expect(missingPublishedTime.time).toBe('')
  })

  it('uses collection evidence only when missing published time has no item observation timestamp', async () => {
    const { ts: _observationTimestamp, ...withoutItemTimestamp } = {
      ...candidate('2084423106102526107'),
      time: '',
    }
    const run = prepareInput('scheduled', [withoutItemTimestamp])
    const input = {
      ...run.input,
      collectionEvidence: {
        ...run.input.collectionEvidence,
        ts: 1_787_510_448,
      },
    }

    await prepareAndSubmitXSourceCandidateReport(input as never)

    expect(run.ports.candidatePort.acceptMaterialSourceFacts).toHaveBeenCalledOnce()
    const [materialFacts] = run.ports.candidatePort.acceptMaterialSourceFacts.mock.calls[0]!
    expect(materialFacts.version).toEqual({
      kind: 'x-status-version',
      observedAt: '2026-08-23T18:40:48.000Z',
    })
    expect(withoutItemTimestamp.time).toBe('')
    const [report] = run.ports.reportPort.submitSourceCandidateReport.mock.calls[0]!
    expect(reportCandidateIds(report)).toEqual(['x-status:2084423106102526107'])
  })

  it('fails closed on a non-empty malformed published time instead of replacing it', async () => {
    const run = prepareInput('scheduled', [{
      ...candidate('2084423106102526107'),
      time: 'not-a-time',
      ts: 1_787_510_409,
    }])

    await expect(prepareAndSubmitXSourceCandidateReport(run.input as never))
      .rejects.toThrow('X current collection item 0 has an invalid time')

    expect(run.ports.candidatePort.acceptAdmissionSourceFacts).not.toHaveBeenCalled()
    expect(run.ports.candidatePort.acceptUnscreenedMechanicalCandidate).not.toHaveBeenCalled()
    expect(run.ports.candidatePort.acceptMaterialSourceFacts).not.toHaveBeenCalled()
    expect(run.ports.reportPort.submitSourceCandidateReport).not.toHaveBeenCalled()
  })

  it.each([0, -1, 1.5, Number.POSITIVE_INFINITY, 'not-a-timestamp'])(
    'fails closed when missing published time has invalid item observation timestamp %s',
    async invalidTimestamp => {
      const run = prepareInput('scheduled', [{
        ...candidate('2084423106102526107'),
        time: '',
        ts: invalidTimestamp,
      } as never])

      await expect(prepareAndSubmitXSourceCandidateReport(run.input as never))
        .rejects.toThrow('X current collection item 0 has an invalid observation timestamp')

      expect(run.ports.candidatePort.acceptAdmissionSourceFacts).not.toHaveBeenCalled()
      expect(run.ports.candidatePort.acceptUnscreenedMechanicalCandidate).not.toHaveBeenCalled()
      expect(run.ports.candidatePort.acceptMaterialSourceFacts).not.toHaveBeenCalled()
      expect(run.ports.reportPort.submitSourceCandidateReport).not.toHaveBeenCalled()
    },
  )

  it('production X candidate ports return the shared C03/C08/C09 accepted shapes', async () => {
    const run = prepareInput('scheduled', [candidate('1')])
    const reportPort = vi.fn(async (report: unknown) => ({
      status: 'accepted' as const,
      value: { report },
    }))
    await prepareAndSubmitXSourceCandidateReport({
      ...run.input,
      candidatePort: createXSourceCandidateReportPorts(),
      reportPort: { submitSourceCandidateReport: reportPort },
    } as never)

    const [report] = reportPort.mock.calls[0]!
    expect(report).toMatchObject({
      branch: 'unscreened',
      candidates: [{
        candidate: candidateReference(candidate('1')),
        qualification: {
          branch: 'unscreened',
          contract: 'C08',
          scope: run.input.mechanicalAdmissionScope,
          period: run.input.period,
          candidate: candidateReference(candidate('1')),
        },
        materialBasis: { candidate: candidateReference(candidate('1')) },
      }],
    })
  })

  it('production C03 rejects an objective-new-content fact that names another candidate', async () => {
    const item = candidate('1')
    const evidence = collectionEvidence('scheduled')
    const facts = expectedAdmissionFacts(item, evidence)
    const candidatePort = createXSourceCandidateReportPorts()

    const result = await candidatePort.acceptAdmissionSourceFacts({
      ...facts,
      candidateBasis: {
        ...facts.candidateBasis,
        fact: { ...facts.candidateBasis.fact, candidateId: '2' },
      },
    } as never)

    expect(result.status).toBe('rejected')
  })

  it('production C08 rejects a candidate whose C03 acceptance was never established', async () => {
    const item = candidate('1')
    const runScope = scope('scheduled')
    const candidatePort = createXSourceCandidateReportPorts()

    const result = await candidatePort.acceptUnscreenedMechanicalCandidate({
      scope: runScope.c32,
      period: runScope.period,
      candidate: candidateReference(item),
      admissionFact: { facts: expectedAdmissionFacts(item, collectionEvidence('scheduled')) },
    } as never)

    expect(result.status).toBe('rejected')
  })

  it('production C09 rejects material facts before the same candidate has passed C08', async () => {
    const candidatePort = createXSourceCandidateReportPorts()

    const result = await candidatePort.acceptMaterialSourceFacts(
      expectedMaterialFacts(candidate('1')) as never,
    )

    expect(result.status).toBe('rejected')
  })

  it('submits one explicit empty unscreened report when current collection is empty', async () => {
    const run = prepareInput('scheduled', [])

    await prepareAndSubmitXSourceCandidateReport(run.input as never)

    expect(run.ports.candidatePort.acceptAdmissionSourceFacts).not.toHaveBeenCalled()
    expect(run.ports.candidatePort.acceptUnscreenedMechanicalCandidate).not.toHaveBeenCalled()
    expect(run.ports.candidatePort.acceptMaterialSourceFacts).not.toHaveBeenCalled()
    expect(run.ports.reportPort.submitSourceCandidateReport).toHaveBeenCalledOnce()
    const [report] = run.ports.reportPort.submitSourceCandidateReport.mock.calls[0]!
    expect(report.candidates).toEqual([])
    expect(report.branch).toBe('unscreened')
    expect(report.scope).toEqual(run.input.materialProjectionReportScope)
  })

  it('builds the report only from the current collection boundary', async () => {
    const historicalFallback = candidate('999', 'historical fallback')
    const plannerSelection = candidate('998', 'semantic planner bypass')
    const run = prepareInput('manual', [candidate('1')])

    await prepareAndSubmitXSourceCandidateReport(run.input as never)

    const [report] = run.ports.reportPort.submitSourceCandidateReport.mock.calls[0]!
    expect(reportCandidateIds(report)).toEqual(['x-status:1'])
    expect(reportCandidateIds(report)).not.toEqual(expect.arrayContaining([
      historicalFallback.id,
      plannerSelection.id,
    ]))
  })

  it('uses only the unscreened C08 branch and never manufactures C04-C07 or C30', async () => {
    const run = prepareInput('scheduled', [candidate('1')])

    await prepareAndSubmitXSourceCandidateReport(run.input as never)

    const [report] = run.ports.reportPort.submitSourceCandidateReport.mock.calls[0]!
    expect(report.candidates[0]).not.toHaveProperty('screeningFact')
    expect(run.ports.candidatePort).not.toHaveProperty('acceptMechanicalRules')
    expect(run.ports.candidatePort).not.toHaveProperty('acceptExplorationNomination')
    expect(run.ports.candidatePort).not.toHaveProperty('screen')
    expect(run.ports.candidatePort).not.toHaveProperty('acceptScreenedCandidate')
  })

  it.each(['scheduled', 'manual'] as const)('%s runs through the same C32/C35 report seam', async trigger => {
    const run = prepareInput(trigger, [candidate('1')])

    await prepareAndSubmitXSourceCandidateReport(run.input as never)

    expect(run.ports.reportPort.submitSourceCandidateReport).toHaveBeenCalledOnce()
    const [report] = run.ports.reportPort.submitSourceCandidateReport.mock.calls[0]!
    expect(report.scope).toEqual(run.input.materialProjectionReportScope)
    expect(report.scope.scope.reportingWindow.window.window).toBe(`window:${trigger}`)
  })

  it('does not continue semantic planning when the C36 finalizer rejects the complete report', async () => {
    const run = prepareInput('scheduled', [candidate('1')], 'rejected')

    await expect(prepareAndSubmitXSourceCandidateReport(run.input as never))
      .rejects.toThrow(/report/i)

    expect(run.ports.reportPort.submitSourceCandidateReport).toHaveBeenCalledOnce()
  })

  it.each([
    ['c03', 'rejected'],
    ['c03', 'failed'],
    ['c03', 'unknown'],
    ['c08', 'rejected'],
    ['c08', 'failed'],
    ['c08', 'unknown'],
    ['c09', 'rejected'],
    ['c09', 'failed'],
    ['c09', 'unknown'],
  ] as const)('fails closed when %s returns %s', async (failureStage, status) => {
    const run = prepareInput('scheduled', [candidate('1')], 'accepted', failureStage, status)

    await expect(prepareAndSubmitXSourceCandidateReport(run.input as never))
      .rejects.toThrow()

    expect(run.ports.reportPort.submitSourceCandidateReport).not.toHaveBeenCalled()
  })

  it('fails closed when a malformed current collection repeats one stable candidate', async () => {
    const run = prepareInput('scheduled', [candidate('1'), candidate('1')])

    await expect(prepareAndSubmitXSourceCandidateReport(run.input as never))
      .rejects.toThrow(/duplicate/i)

    expect(run.ports.reportPort.submitSourceCandidateReport).not.toHaveBeenCalled()
  })

  it('wires provider current_collection to C36 before planner and leaves recent_items out of the report', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'x-feed-todo02-provider-red-'))
    const factSources = createFileProjectionSources(directory)
    new FileNavigationSnapshotStore(directory).replace({
      schemaVersion: 1,
      sourceRevision: factSources.facts.readLocatedSnapshot().sourceRevision,
      items: [],
    })
    const currentItem = candidate('1')
    const historyItem = candidate('999', 'history fallback')
    const run = prepareInput('scheduled', [currentItem], 'rejected')
    const packageValue = {
      ok: true,
      collection_batch: join(
        directory,
        '.runs',
        `run-${createHash('sha256').update('run:scheduled', 'utf8').digest('hex').slice(0, 32)}`,
        'collection.jsonl',
      ),
      collection_status: 'ok',
      delivery_id: run.input.collectionEvidence.deliveryId,
      ts: run.input.collectionEvidence.ts,
      current_collection: [currentItem],
      recent_items: [historyItem],
    }
    expect(packageValue.current_collection[0]).toEqual({
      id: '1',
      url: currentItem.url,
      text: currentItem.text,
      time: currentItem.time,
      user: currentItem.user,
      media: [],
      ts: currentItem.ts,
    })
    const pythonCalls: PythonCommandRequest[] = []
    const pythonRun = vi.fn(async (request: PythonCommandRequest): Promise<PythonCommandResult> => {
      pythonCalls.push(request)
      return { stdout: '{"ok":true}\n', stderr: '', exitCode: 0 }
    })
    const readFile = vi.fn(async () => JSON.stringify(packageValue))
    const provider = createXFeedCronEnvironmentProvider({
      ctx: {} as never,
      cronJobId: 'cron-x',
      dataDir: directory,
      pythonBin: '/usr/bin/python3',
      pipelinePath: '/pkg/python/x_insight_pipeline.py',
      run: pythonRun,
      readFile,
      sourceCandidateReport: {
        period: run.input.period,
        mechanicalAdmissionScope: run.input.mechanicalAdmissionScope,
        materialProjectionReportScope: run.input.materialProjectionReportScope,
        candidatePort: run.ports.candidatePort,
        reportPort: run.ports.reportPort,
      },
    } as never)

    try {
      await expect(provider.prepare({ jobId: 'cron-x', runId: 'run:scheduled' } as never))
        .rejects.toThrow(/report/i)

      expect(run.ports.reportPort.submitSourceCandidateReport).toHaveBeenCalledOnce()
      const [report] = run.ports.reportPort.submitSourceCandidateReport.mock.calls[0]!
      expect(reportCandidateIds(report)).toEqual(['x-status:1'])
      expect(reportCandidateIds(report)).not.toContain('x-status:999')
      expect(pythonCalls).toHaveLength(1)
      expect(pythonCalls[0]!.args[0]).toBe('/pkg/python/x_insight_pipeline.py')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('fails closed when current_collection is present but is not an array', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'x-feed-todo02-provider-shape-'))
    const factSources = createFileProjectionSources(directory)
    new FileNavigationSnapshotStore(directory).replace({
      schemaVersion: 1,
      sourceRevision: factSources.facts.readLocatedSnapshot().sourceRevision,
      items: [],
    })
    const run = prepareInput('manual', [])
    const packageValue = {
      ok: true,
      collection_batch: join(
        directory,
        '.runs',
        `run-${createHash('sha256').update('run:manual', 'utf8').digest('hex').slice(0, 32)}`,
        'collection.jsonl',
      ),
      collection_status: 'empty',
      delivery_id: run.input.collectionEvidence.deliveryId,
      ts: run.input.collectionEvidence.ts,
      current_collection: { id: 'not-an-array' },
      recent_items: [],
    }
    const provider = createXFeedCronEnvironmentProvider({
      ctx: {} as never,
      cronJobId: 'cron-x',
      dataDir: directory,
      pythonBin: '/usr/bin/python3',
      pipelinePath: '/pkg/python/x_insight_pipeline.py',
      run: vi.fn(async (): Promise<PythonCommandResult> => ({ stdout: '{}\n', stderr: '', exitCode: 0 })),
      readFile: vi.fn(async () => JSON.stringify(packageValue)),
      sourceCandidateReport: {
        period: run.input.period,
        mechanicalAdmissionScope: run.input.mechanicalAdmissionScope,
        materialProjectionReportScope: run.input.materialProjectionReportScope,
        candidatePort: run.ports.candidatePort,
        reportPort: run.ports.reportPort,
      },
    } as never)

    try {
      await expect(provider.prepare({ jobId: 'cron-x', runId: 'run:manual' } as never))
        .rejects.toThrow(/current_collection/i)
      expect(run.ports.reportPort.submitSourceCandidateReport).not.toHaveBeenCalled()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('cron extension uses the established C32/C35 seam and persists one accepted empty report', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'x-feed-todo02-cron-report-'))
    const personalFeedDirectory = join(directory, 'personal-feed')
    const factSources = createFileProjectionSources(directory)
    new FileNavigationSnapshotStore(directory).replace({
      schemaVersion: 1,
      sourceRevision: factSources.facts.readLocatedSnapshot().sourceRevision,
      items: [],
    })
    const runId = `cron-x@${new Date(Date.now() - 1_000).toISOString()}`
    const legacyPrepare = vi.fn(async () => {
      throw new Error('legacy X cron provider must not prepare ordinary Feed runs')
    })
    vi.spyOn(xCronProvider, 'createXFeedCronEnvironmentProvider').mockReturnValue({
      marker: 'dsh-x-feed/v1',
      requirements: { jobKind: 'agent', sessionMode: 'per_run', gate: 'forbidden' },
      prepare: legacyPrepare,
    } as never)
    const ordinaryPrepare = vi.fn(async () => {
      return { kind: 'skip' as const, outcome: { text: undefined, error: undefined } }
    })
    const ordinaryFactory = vi.spyOn(xCronProvider, 'createXFeedCronEnvironmentProviderForOrdinaryFeed')
      .mockImplementation(options => ({
        marker: 'dsh-x-feed/v1',
        requirements: { jobKind: 'agent', sessionMode: 'per_run', gate: 'forbidden' },
        prepare: async context => {
          if (options.sourceCandidateReport !== undefined) {
            await prepareAndSubmitXSourceCandidateReport({
              period: options.sourceCandidateReport.period,
              mechanicalAdmissionScope: options.sourceCandidateReport.mechanicalAdmissionScope,
              materialProjectionReportScope: options.sourceCandidateReport.materialProjectionReportScope,
              collectionEvidence: {
                runId: context.runId,
                source: 'x',
                collectionPath: join(directory, '.runs', 'collection.jsonl'),
                collectionBatch: join(directory, '.runs', 'collection.jsonl'),
                deliveryId: 'delivery:cron',
                ts: Math.floor(Date.now() / 1000),
              },
              currentCollection: [],
              candidatePort: options.sourceCandidateReport.candidatePort,
              reportPort: options.sourceCandidateReport.reportPort,
            })
          }
          return ordinaryPrepare()
        },
      } as never))
    const extension = createCronEnvironmentExtension({
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    } as never, {
      cronJobId: 'cron-x',
      dataDir: directory,
      pythonBin: '/usr/bin/python3',
      pipelinePath: '/pkg/python/x_insight_pipeline.py',
      personalFeedDataDir: personalFeedDirectory,
      personalFeedRequiredSources: ['x'],
      candidateReportingWindowMs: 300_000,
    })

    try {
      const prepared = await extension.prepare({
        jobId: 'cron-x',
        jobKind: 'agent',
        sessionMode: 'per_run',
        gate: 'forbidden',
        runId,
        trigger: 'manual',
        scheduledFor: new Date(Date.now() - 1_000).toISOString(),
        claimedAt: new Date(Date.now() - 1_000).toISOString(),
      } as never)
      expect(prepared).toMatchObject({ kind: 'skip' })
      const reports = readFileSync(join(personalFeedDirectory, 'source-candidate-reports.jsonl'), 'utf8')
        .trim().split('\n').map(line => JSON.parse(line))
      expect(reports).toHaveLength(1)
      expect(reports[0]).toMatchObject({
        event: 'source_candidate_report_accepted',
        accepted: { report: { source: 'x', branch: 'unscreened', candidates: [] } },
      })
      expect(ordinaryFactory).toHaveBeenCalledOnce()
      expect(ordinaryPrepare).toHaveBeenCalledOnce()
      expect(legacyPrepare).not.toHaveBeenCalled()
    } finally {
      vi.restoreAllMocks()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
