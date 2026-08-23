import {
  candidateIdentity,
  sourceIdentity,
  sourceStableReference,
} from '@herman/personal-feed'
import type {
  C10Result,
  C16Result,
  C26Result,
  CandidateAcceptedIntoPeriod,
  CandidateMaterial,
  EditingInputAccepted,
  MaterialFact,
  MaterialFactRecorded,
  PeriodIdentity,
  ReportedMaterialCandidate,
  SourceCandidateReference,
  SourceCandidateReportAccepted,
} from '@herman/personal-feed'
import { parseXStatusIdentity } from './x-status-identity.ts'
import type {
  XSourceCollectionEvidence,
  XSourceCollectionItem,
} from './source-candidate-report.ts'

export interface XCandidateEditingInputPorts {
  readonly periodFinalizer: {
    readonly acceptCandidateIntoPeriod: (candidate: ReportedMaterialCandidate) => C26Result | Promise<C26Result>
    readonly acceptMaterialFact: (fact: MaterialFact) => C16Result | Promise<C16Result>
  }
  readonly crossSourceEditor: {
    readonly acceptCandidateMaterial: (material: CandidateMaterial) => C10Result | Promise<C10Result>
  }
}

export interface XCandidateEditingInputPreparationInput {
  readonly period: PeriodIdentity
  readonly collectionEvidence: XSourceCollectionEvidence
  readonly acceptedReport: SourceCandidateReportAccepted
  readonly currentCollection: readonly XSourceCollectionItem[]
  readonly periodFinalizer: XCandidateEditingInputPorts['periodFinalizer']
  readonly crossSourceEditor: XCandidateEditingInputPorts['crossSourceEditor']
}

export interface XCandidateEditingInputCompleted {
  readonly candidate: SourceCandidateReference
  readonly materialFact: MaterialFactRecorded
  readonly editingInput: EditingInputAccepted
}

/**
 * Project only current-run members of an accepted C36 report into C26/C16/C10.
 * This adapter owns no Personal Feed facts; every accepted value comes from
 * the corresponding receiver port.
 */
export async function projectXAcceptedReportIntoEditingInputs(
  input: XCandidateEditingInputPreparationInput,
): Promise<readonly XCandidateEditingInputCompleted[]> {
  const report = input.acceptedReport.report
  if (report.source !== 'x' || !sameValue(report.period, input.period)) {
    throw new Error('X accepted C36 report does not belong to the requested X period')
  }
  for (const member of report.candidates) {
    const acceptedBasis = member.materialBasis.acceptedBasis
    if (isRecord(acceptedBasis)
      && acceptedBasis.evidence !== undefined
      && !sameValue(acceptedBasis.evidence, input.collectionEvidence)) {
      throw new Error('X accepted C09 evidence does not match the current collection evidence')
    }
  }

  const currentItems = new Map<string, XSourceCollectionItem>()
  for (const item of input.currentCollection) {
    const reference = sourceCandidateReference(item)
    currentItems.set(reference.stableReference, item)
  }

  const completed: XCandidateEditingInputCompleted[] = []
  for (const member of report.candidates) {
    const item = currentItems.get(member.candidate.stableReference)
    if (item === undefined || !hasSameCollectionEvidence(member, input.collectionEvidence)) continue

    const reported: ReportedMaterialCandidate = {
      report: input.acceptedReport,
      candidate: member,
    }
    const c26Result = await input.periodFinalizer.acceptCandidateIntoPeriod(reported)
    const acceptedIntoPeriod = acceptedCandidate(c26Result, member)
    if (acceptedIntoPeriod === undefined) continue

    const material = candidateMaterial(acceptedIntoPeriod, item)
    const materialFact = formedMaterialFact(acceptedIntoPeriod, item)
    const [c16Result, c10Result] = await Promise.all([
      input.periodFinalizer.acceptMaterialFact(materialFact),
      input.crossSourceEditor.acceptCandidateMaterial(material),
    ])
    const recordedFact = acceptedMaterialFact(c16Result, materialFact)
    const editingInput = acceptedEditingInput(c10Result, material)
    if (recordedFact === undefined || editingInput === undefined) continue

    completed.push({
      candidate: acceptedIntoPeriod.candidate,
      materialFact: recordedFact,
      editingInput,
    })
  }
  return Object.freeze(completed)
}

function acceptedCandidate(
  result: C26Result,
  member: ReportedMaterialCandidate['candidate'],
): CandidateAcceptedIntoPeriod | undefined {
  if (result.status !== 'accepted' || !isCandidateAcceptedIntoPeriod(result.value)) return undefined
  if (!sameValue(result.value.period, member.period)
    || !sameValue(result.value.candidate, member.candidate)
    || !sameValue(result.value.nomination, member.nomination)) return undefined
  return result.value
}

function acceptedMaterialFact(result: C16Result, expected: MaterialFact): MaterialFactRecorded | undefined {
  if (result.status !== 'accepted' || !isRecord(result.value)
    || !hasOnlyKeys(result.value, ['fact'])
    || !isRecord(result.value.fact)) return undefined
  return sameValue(result.value.fact, expected) ? result.value : undefined
}

function acceptedEditingInput(result: C10Result, expected: CandidateMaterial): EditingInputAccepted | undefined {
  if (result.status !== 'accepted' || !isRecord(result.value)
    || !hasOnlyKeys(result.value, ['material'])
    || !isRecord(result.value.material)) return undefined
  return sameValue(result.value.material, expected) ? result.value : undefined
}

function isCandidateAcceptedIntoPeriod(value: unknown): value is CandidateAcceptedIntoPeriod {
  if (!isRecord(value) || !isRecord(value.period) || !isRecord(value.candidate)) return false
  const keys = Object.keys(value)
  if (!keys.every(key => key === 'period' || key === 'candidate' || key === 'nomination')) return false
  return typeof value.period.run === 'string'
    && typeof value.period.period === 'string'
    && isCandidateReference(value.candidate)
}

function candidateMaterial(
  acceptedIntoPeriod: CandidateAcceptedIntoPeriod,
  item: XSourceCollectionItem,
): CandidateMaterial {
  return {
    acceptedIntoPeriod,
    period: acceptedIntoPeriod.period,
    candidate: acceptedIntoPeriod.candidate,
    boundedContent: {
      kind: 'x-status',
      id: item.id,
      url: item.url,
      text: item.text,
      time: item.time,
      media: item.media,
    },
    attribution: { kind: 'x-author', handle: item.user },
    exactLookup: { kind: 'x-status-lookup', url: item.url },
    ...(acceptedIntoPeriod.nomination === undefined ? {} : { nomination: acceptedIntoPeriod.nomination }),
  }
}

function formedMaterialFact(
  acceptedIntoPeriod: CandidateAcceptedIntoPeriod,
  item: XSourceCollectionItem,
): MaterialFact {
  return {
    kind: 'material_formed',
    acceptedIntoPeriod,
    period: acceptedIntoPeriod.period,
    candidate: acceptedIntoPeriod.candidate,
    materialFormedFact: {
      kind: 'x-current-collection-material-formed',
      candidateId: item.id,
      url: item.url,
    },
  }
}

function hasSameCollectionEvidence(
  member: ReportedMaterialCandidate['candidate'],
  evidence: XSourceCollectionEvidence,
): boolean {
  const basis = member.materialBasis.acceptedBasis
  return isRecord(basis) && sameValue(basis.evidence, evidence)
}

function sourceCandidateReference(item: XSourceCollectionItem): SourceCandidateReference {
  const identity = parseXStatusIdentity(item.url)
  if (identity === undefined || identity.statusId !== item.id) {
    throw new Error(`X current collection item ${item.id} has a non-canonical identity`)
  }
  return {
    source: sourceIdentity('x'),
    candidate: candidateIdentity(`x-status:${identity.statusId}`),
    stableReference: sourceStableReference(`x:status:${identity.statusId}`),
  }
}

function isCandidateReference(value: unknown): value is SourceCandidateReference {
  return isRecord(value)
    && typeof value.source === 'string'
    && typeof value.candidate === 'string'
    && typeof value.stableReference === 'string'
}

function hasOnlyKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const keys = [...expected].sort()
  return actual.length === keys.length && actual.every((key, index) => key === keys[index])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => sameValue(value, right[index]))
  }
  if (!isRecord(left) || !isRecord(right)) return false
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && sameValue(left[key], right[key]))
}
