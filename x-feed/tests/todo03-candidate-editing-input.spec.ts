import { describe, expect, it, vi } from 'vitest'
import { projectXAcceptedReportIntoEditingInputs } from '../src/x-cron/candidate-editing-input.ts'

type Candidate = {
  readonly id: string
  readonly url: string
  readonly text: string
  readonly time: string
  readonly user: string
  readonly media: readonly string[]
}

type PortSet = {
  readonly periodFinalizer: {
    readonly acceptCandidateIntoPeriod: ReturnType<typeof vi.fn>
    readonly acceptMaterialFact: ReturnType<typeof vi.fn>
  }
  readonly crossSourceEditor: {
    readonly acceptCandidateMaterial: ReturnType<typeof vi.fn>
  }
  readonly acceptedIntoPeriod: object
}

const period = { run: 'run:x-1', period: 'period:x-1' }
const reportScope = {
  scope: {
    period,
    source: 'x',
    reportingWindow: {
      window: {
        window: 'window:x-1',
        period,
        sources: ['x'],
        closesAt: '2026-08-24T01:00:00.000Z',
      },
    },
  },
}
const mechanicalScope = {
  period,
  source: 'x',
  start: {
    start: {
      period,
      startFact: { kind: 'external_run_opportunity_accepted', request: 'request:x-1' },
      origin: { kind: 'scheduled', trigger: '2026-08-24T00:30:00.000Z' },
    },
  },
  reportingWindow: reportScope.scope.reportingWindow,
}

function candidate(id: string, text = `${id} current material`): Candidate {
  return {
    id,
    url: `https://x.com/alice/status/${id}`,
    text,
    time: '2026-08-24T00:30:00.000Z',
    user: 'alice',
    media: [],
  }
}

function reference(id: string) {
  return {
    source: 'x',
    candidate: `x-status:${id}`,
    stableReference: `x:status:${id}`,
  }
}

function collectionEvidence(runId = 'python-run:x-1') {
  return {
    runId,
    source: 'x',
    collectionPath: `/runs/${runId}/collection.jsonl`,
    collectionBatch: `/runs/${runId}/collection.jsonl`,
    deliveryId: 'delivery:x-1',
    ts: 1_755_961_200,
  }
}

function reportMember(id: string, evidence: ReturnType<typeof collectionEvidence>) {
  return {
    period,
    candidate: reference(id),
    qualification: {
      branch: 'unscreened',
      contract: 'C08',
      scope: mechanicalScope,
      period,
      candidate: reference(id),
      acceptedQualification: { kind: 'c08-accepted', id },
    },
    materialBasis: {
      candidate: reference(id),
      acceptedBasis: { kind: 'c09-accepted', id, evidence },
    },
  }
}

function acceptedReport(
  memberIds: readonly string[],
  evidence = collectionEvidence(),
) {
  return {
    report: {
      branch: 'unscreened',
      scope: reportScope,
      period,
      source: 'x',
      candidates: memberIds.map(id => reportMember(id, evidence)),
    },
  }
}

function ports(
  c26: 'accepted' | 'rejected' = 'accepted',
  c16: 'accepted' | 'rejected' = 'accepted',
  c10: 'accepted' | 'rejected' = 'accepted',
): PortSet {
  const acceptedIntoPeriod = {
    period,
    candidate: reference('1'),
  }
  const periodFinalizer = {
    acceptCandidateIntoPeriod: vi.fn((input: {
      readonly candidate: { readonly candidate: object }
    }) => {
      if (c26 !== 'accepted') return { status: 'rejected' as const, input }
      acceptedIntoPeriod.candidate = input.candidate.candidate
      return { status: 'accepted' as const, value: acceptedIntoPeriod }
    }),
    acceptMaterialFact: vi.fn((input: unknown) => c16 === 'accepted'
      ? { status: 'accepted', value: { fact: input } }
      : { status: 'rejected', input }),
  }
  return {
    periodFinalizer,
    crossSourceEditor: {
      acceptCandidateMaterial: vi.fn((input: unknown) => c10 === 'accepted'
        ? { status: 'accepted', value: { material: input } }
        : { status: 'rejected', input }),
    },
    acceptedIntoPeriod,
  }
}

function input(
  accepted: ReturnType<typeof acceptedReport>,
  currentCollection: readonly Candidate[],
  candidatePorts: PortSet,
  evidence = collectionEvidence(),
) {
  return {
    period,
    collectionEvidence: evidence,
    acceptedReport: accepted,
    currentCollection,
    // These values are deliberately tempting but are not material inputs.
    recentItems: [candidate('4', 'recent planner candidate')],
    history: [candidate('5', 'historical continuation candidate')],
    plannerOutput: [candidate('6', 'old planner output candidate')],
    periodFinalizer: candidatePorts.periodFinalizer,
    crossSourceEditor: candidatePorts.crossSourceEditor,
  }
}

describe('TODO03 X candidate material to editing-input seam', () => {
  it('projects only the same-run current collection intersection with the accepted C36 report', async () => {
    const candidatePorts = ports()
    const evidence = collectionEvidence()
    const accepted = acceptedReport(['1', '2'], evidence)

    await projectXAcceptedReportIntoEditingInputs(input(
      accepted,
      [candidate('1'), candidate('3', 'non-member current candidate')],
      candidatePorts,
      evidence,
    ) as never)

    expect(candidatePorts.periodFinalizer.acceptCandidateIntoPeriod).toHaveBeenCalledOnce()
    expect(candidatePorts.periodFinalizer.acceptMaterialFact).toHaveBeenCalledOnce()
    expect(candidatePorts.crossSourceEditor.acceptCandidateMaterial).toHaveBeenCalledOnce()

    const [c26Input] = candidatePorts.periodFinalizer.acceptCandidateIntoPeriod.mock.calls[0]!
    expect(c26Input.report).toBe(accepted)
    expect(c26Input.candidate).toBe(accepted.report.candidates[0])
    expect(c26Input.candidate.materialBasis.acceptedBasis.evidence).toBe(evidence)
    expect(c26Input.candidate.candidate).toEqual(reference('1'))
    expect(c26Input.candidate.candidate).not.toEqual(reference('2'))
    expect(c26Input.candidate.candidate).not.toEqual(reference('3'))

    const [materialFact] = candidatePorts.periodFinalizer.acceptMaterialFact.mock.calls[0]!
    const [candidateMaterial] = candidatePorts.crossSourceEditor.acceptCandidateMaterial.mock.calls[0]!
    expect(materialFact.acceptedIntoPeriod).toBe(candidatePorts.acceptedIntoPeriod)
    expect(candidateMaterial.acceptedIntoPeriod).toBe(candidatePorts.acceptedIntoPeriod)
    expect(materialFact.period).toEqual(period)
    expect(materialFact.candidate).toEqual(reference('1'))
    expect(candidateMaterial.period).toEqual(period)
    expect(candidateMaterial.candidate).toEqual(reference('1'))
    expect(candidateMaterial.boundedContent).toMatchObject({ id: '1', text: '1 current material' })
    expect(candidateMaterial.attribution).toMatchObject({ handle: 'alice' })

    expect(candidatePorts.periodFinalizer.acceptCandidateIntoPeriod.mock.invocationCallOrder[0])
      .toBeLessThan(candidatePorts.periodFinalizer.acceptMaterialFact.mock.invocationCallOrder[0]!)
    expect(candidatePorts.periodFinalizer.acceptCandidateIntoPeriod.mock.invocationCallOrder[0])
      .toBeLessThan(candidatePorts.crossSourceEditor.acceptCandidateMaterial.mock.invocationCallOrder[0]!)
  })

  it('preserves missing source time and keeps the real item observation timestamp separate', async () => {
    const candidatePorts = ports()
    const evidence = collectionEvidence()
    const currentItem = {
      ...candidate('1'),
      time: '',
      ts: 1_787_510_409,
    }

    await projectXAcceptedReportIntoEditingInputs(input(
      acceptedReport(['1'], evidence),
      [currentItem],
      candidatePorts,
      evidence,
    ) as never)

    const [material] = candidatePorts.crossSourceEditor.acceptCandidateMaterial.mock.calls[0]!
    expect(material.boundedContent).toMatchObject({
      time: '',
      ts: 1_787_510_409,
    })
    expect(material.boundedContent.time).not.toBe('2026-08-23T18:40:09.000Z')
  })

  it('does not call C26, C16, or C10 for a legal empty C36 report', async () => {
    const candidatePorts = ports()
    const result = await projectXAcceptedReportIntoEditingInputs(input(
      acceptedReport([]),
      [candidate('1')],
      candidatePorts,
    ) as never)

    expect(result).toEqual([])
    expect(candidatePorts.periodFinalizer.acceptCandidateIntoPeriod).not.toHaveBeenCalled()
    expect(candidatePorts.periodFinalizer.acceptMaterialFact).not.toHaveBeenCalled()
    expect(candidatePorts.crossSourceEditor.acceptCandidateMaterial).not.toHaveBeenCalled()
  })

  it('does not project current_collection material from a different Python run', async () => {
    const candidatePorts = ports()
    const evidence = collectionEvidence()
    const runInput = input(acceptedReport(['1'], evidence), [candidate('1')], candidatePorts, evidence)

    await expect(projectXAcceptedReportIntoEditingInputs({
      ...runInput,
      collectionEvidence: collectionEvidence('python-run:other'),
    } as never)).rejects.toThrow(/evidence|run|collection/i)

    expect(candidatePorts.periodFinalizer.acceptCandidateIntoPeriod).not.toHaveBeenCalled()
    expect(candidatePorts.periodFinalizer.acceptMaterialFact).not.toHaveBeenCalled()
    expect(candidatePorts.crossSourceEditor.acceptCandidateMaterial).not.toHaveBeenCalled()
  })

  it('stops at a non-accepted C26 result and never fabricates C16 or C10 inputs', async () => {
    const candidatePorts = ports('rejected')

    await projectXAcceptedReportIntoEditingInputs(input(
      acceptedReport(['1']),
      [candidate('1')],
      candidatePorts,
    ) as never)

    expect(candidatePorts.periodFinalizer.acceptCandidateIntoPeriod).toHaveBeenCalledOnce()
    expect(candidatePorts.periodFinalizer.acceptMaterialFact).not.toHaveBeenCalled()
    expect(candidatePorts.crossSourceEditor.acceptCandidateMaterial).not.toHaveBeenCalled()
  })

  it('sends both independent C16 and C10 requests after the same C26 success', async () => {
    const candidatePorts = ports()

    await projectXAcceptedReportIntoEditingInputs(input(
      acceptedReport(['1']),
      [candidate('1')],
      candidatePorts,
    ) as never)

    expect(candidatePorts.periodFinalizer.acceptCandidateIntoPeriod).toHaveBeenCalledOnce()
    expect(candidatePorts.periodFinalizer.acceptMaterialFact).toHaveBeenCalledOnce()
    expect(candidatePorts.crossSourceEditor.acceptCandidateMaterial).toHaveBeenCalledOnce()
    expect(candidatePorts.periodFinalizer.acceptCandidateIntoPeriod.mock.invocationCallOrder[0])
      .toBeLessThan(candidatePorts.periodFinalizer.acceptMaterialFact.mock.invocationCallOrder[0]!)
    expect(candidatePorts.periodFinalizer.acceptCandidateIntoPeriod.mock.invocationCallOrder[0])
      .toBeLessThan(candidatePorts.crossSourceEditor.acceptCandidateMaterial.mock.invocationCallOrder[0]!)
    expect(candidatePorts.periodFinalizer).not.toHaveProperty('acceptCandidateMaterial')
    expect(candidatePorts.crossSourceEditor).not.toHaveProperty('acceptCandidateIntoPeriod')
    expect(candidatePorts.crossSourceEditor).not.toHaveProperty('acceptMaterialFact')
  })

  it('does not report completion when C16 rejects after the independent C10 receiver accepts', async () => {
    const candidatePorts = ports('accepted', 'rejected', 'accepted')

    const result = await projectXAcceptedReportIntoEditingInputs(input(
      acceptedReport(['1']),
      [candidate('1')],
      candidatePorts,
    ) as never)

    expect(result).toEqual([])
    expect(candidatePorts.periodFinalizer.acceptCandidateIntoPeriod).toHaveBeenCalledOnce()
    expect(candidatePorts.periodFinalizer.acceptMaterialFact).toHaveBeenCalledOnce()
    expect(candidatePorts.crossSourceEditor.acceptCandidateMaterial).toHaveBeenCalledOnce()
    expect(candidatePorts.crossSourceEditor.acceptCandidateMaterial.mock.results[0]?.value)
      .toMatchObject({ status: 'accepted' })
  })

  it('does not report completion when C10 rejects after the independent C16 receiver accepts', async () => {
    const candidatePorts = ports('accepted', 'accepted', 'rejected')

    const result = await projectXAcceptedReportIntoEditingInputs(input(
      acceptedReport(['1']),
      [candidate('1')],
      candidatePorts,
    ) as never)

    expect(result).toEqual([])
    expect(candidatePorts.periodFinalizer.acceptCandidateIntoPeriod).toHaveBeenCalledOnce()
    expect(candidatePorts.periodFinalizer.acceptMaterialFact).toHaveBeenCalledOnce()
    expect(candidatePorts.crossSourceEditor.acceptCandidateMaterial).toHaveBeenCalledOnce()
    expect(candidatePorts.periodFinalizer.acceptMaterialFact.mock.results[0]?.value)
      .toMatchObject({ status: 'accepted' })
  })
})
