import { parseXStatusIdentity } from './x-status-identity.ts'
import {
  candidateIdentity,
  sourceIdentity,
  sourceStableReference,
} from '@herman/personal-feed'
import type {
  AdmissionSourceFacts,
  AdmissionSourceFactsAccepted,
  C03Result,
  C08Result,
  C09Result,
  C36Result,
  MechanicalCandidate,
  MaterialBasisAccepted,
  MaterialProjectionReportScopeEstablished,
  MaterialSourceFacts,
  PeriodIdentity,
  SourceCandidateReference,
  SourceCandidateReportAccepted,
  UnscreenedMaterialCandidateAccepted,
  UnscreenedSourceCandidateReport,
} from '@herman/personal-feed'

/** The only candidate shape accepted from the Python package. */
export interface XSourceCollectionItem {
  readonly id: string
  readonly url: string
  readonly text: string
  readonly time: string
  readonly user: string
  readonly media: readonly string[]
  readonly ts?: number
}

/** Run-local evidence already present in the mature X package and port. */
export interface XSourceCollectionEvidence {
  readonly runId: string
  readonly source: 'x'
  readonly collectionPath: string
  readonly collectionBatch: string
  readonly deliveryId: string
  readonly ts: number
}

export interface XSourceCandidateReportPorts {
  readonly acceptAdmissionSourceFacts: (facts: AdmissionSourceFacts) => C03Result | Promise<C03Result>
  readonly acceptUnscreenedMechanicalCandidate: (candidate: MechanicalCandidate) => C08Result | Promise<C08Result>
  readonly acceptMaterialSourceFacts: (facts: MaterialSourceFacts) => C09Result | Promise<C09Result>
}

export interface XSourceCandidateReportPort {
  readonly submitSourceCandidateReport: (
    report: UnscreenedSourceCandidateReport,
  ) => C36Result | Promise<C36Result>
}

/**
 * The X adapter's concrete C03/C08/C09 receiver.  These are source-side
 * acceptance seams; they do not create a second Personal Feed contract.
 */
export function createXSourceCandidateReportPorts(): XSourceCandidateReportPorts {
  const admissionByCandidate = new Map<string, AdmissionSourceFactsAccepted>()
  const qualifiedCandidates = new Set<string>()
  const materialCandidates = new Set<string>()

  return Object.freeze({
    acceptAdmissionSourceFacts: async (facts: AdmissionSourceFacts): Promise<C03Result> => {
      const candidateKey = validateXAdmissionSourceFacts(facts)
      if (candidateKey === undefined || admissionByCandidate.has(candidateKey)) {
        return { status: 'rejected', input: facts }
      }
      const accepted = Object.freeze({ facts: deepFreeze(structuredClone(facts)) })
      admissionByCandidate.set(candidateKey, accepted)
      return { status: 'accepted', value: accepted }
    },
    acceptUnscreenedMechanicalCandidate: async (mechanicalCandidate: MechanicalCandidate): Promise<C08Result> => {
      const candidateKey = xCandidateKey(mechanicalCandidate.candidate)
      const admission = candidateKey === undefined ? undefined : admissionByCandidate.get(candidateKey)
      if (candidateKey === undefined
        || admission === undefined
        || mechanicalCandidate.admissionFact !== admission
        || mechanicalCandidate.nomination !== undefined
        || qualifiedCandidates.has(candidateKey)
        || !isOrdinaryXMechanicalScope(mechanicalCandidate.scope, mechanicalCandidate.period)) {
        return { status: 'rejected', input: mechanicalCandidate }
      }
      const accepted = Object.freeze({
        branch: 'unscreened' as const,
        contract: 'C08' as const,
        scope: mechanicalCandidate.scope,
        period: mechanicalCandidate.period,
        candidate: mechanicalCandidate.candidate,
        acceptedQualification: Object.freeze({ kind: 'x-unscreened-material-candidate' }),
      })
      qualifiedCandidates.add(candidateKey)
      return { status: 'accepted', value: accepted }
    },
    acceptMaterialSourceFacts: async (facts: MaterialSourceFacts): Promise<C09Result> => {
      const candidateKey = xCandidateKey(facts.candidate)
      const admission = candidateKey === undefined ? undefined : admissionByCandidate.get(candidateKey)
      if (candidateKey === undefined
        || admission === undefined
        || !qualifiedCandidates.has(candidateKey)
        || materialCandidates.has(candidateKey)
        || !matchesXMaterialSourceFacts(facts, admission.facts)) {
        return { status: 'rejected', input: facts }
      }
      const accepted = Object.freeze({
        candidate: facts.candidate,
        acceptedBasis: Object.freeze({ kind: 'x-material-basis' }),
      })
      materialCandidates.add(candidateKey)
      return { status: 'accepted', value: accepted }
    },
  })
}

export interface XSourceCandidateReportPreparationInput {
  readonly period: PeriodIdentity
  readonly mechanicalAdmissionScope: MechanicalCandidate['scope']
  readonly materialProjectionReportScope: MaterialProjectionReportScopeEstablished
  readonly collectionEvidence: XSourceCollectionEvidence
  readonly currentCollection: readonly unknown[]
  readonly candidatePort: XSourceCandidateReportPorts
  readonly reportPort: XSourceCandidateReportPort
}

/**
 * Build the X source's one complete, unscreened report and hand it to C36.
 *
 * This function owns only source facts and the C03/C08/C09 assembly. It does
 * not know about planner candidates, history fallback, material editing, or
 * delivery. The caller must supply the already-established C32/C35 values.
 */
export async function prepareAndSubmitXSourceCandidateReport(
  input: XSourceCandidateReportPreparationInput,
): Promise<SourceCandidateReportAccepted> {
  const candidates = validateCurrentCollection(input.currentCollection)
  const reportCandidates = []
  for (const item of candidates) {
    reportCandidates.push(await prepareMaterialCandidate(item, input))
  }

  const report: UnscreenedSourceCandidateReport = {
    branch: 'unscreened' as const,
    scope: input.materialProjectionReportScope,
    period: input.period,
    source: sourceIdentity('x'),
    candidates: Object.freeze(reportCandidates),
  }
  const result = await input.reportPort.submitSourceCandidateReport(report)
  return requireAccepted(result, 'C36 source candidate report')
}

async function prepareMaterialCandidate(
  item: XSourceCollectionItem,
  input: XSourceCandidateReportPreparationInput,
): Promise<UnscreenedSourceCandidateReport['candidates'][number]> {
  const reference = sourceCandidateReference(item)
  const admissionFacts = admissionSourceFacts(item, reference, input.collectionEvidence)
  const admissionResult = await input.candidatePort.acceptAdmissionSourceFacts(admissionFacts)
  const admissionAccepted = requireAccepted(admissionResult, `C03 candidate ${item.id}`)

  const mechanicalCandidate: MechanicalCandidate = {
    scope: input.mechanicalAdmissionScope,
    period: input.period,
    candidate: reference,
    admissionFact: admissionAccepted,
  }
  const qualificationResult = await input.candidatePort.acceptUnscreenedMechanicalCandidate(mechanicalCandidate)
  const qualification = requireMechanicalCandidateAccepted(
    requireAccepted(qualificationResult, `C08 candidate ${item.id}`),
    mechanicalCandidate,
    `C08 candidate ${item.id}`,
  )

  const materialFacts = materialSourceFacts(item, reference)
  const materialResult = await input.candidatePort.acceptMaterialSourceFacts(materialFacts)
  const materialBasis = requireMaterialBasisAccepted(
    requireAccepted(materialResult, `C09 candidate ${item.id}`),
    reference,
    `C09 candidate ${item.id}`,
  )

  return Object.freeze({
    period: input.period,
    candidate: reference,
    qualification,
    materialBasis,
  })
}

function admissionSourceFacts(
  item: XSourceCollectionItem,
  reference: SourceCandidateReference,
  evidence: XSourceCollectionEvidence,
): AdmissionSourceFacts {
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

function materialSourceFacts(
  item: XSourceCollectionItem,
  reference: SourceCandidateReference,
): MaterialSourceFacts {
  return {
    candidate: reference,
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

function validateCurrentCollection(value: readonly unknown[]): readonly XSourceCollectionItem[] {
  if (!Array.isArray(value)) throw new Error('X current collection must be an array')
  const seen = new Set<string>()
  return Object.freeze(value.map((raw, index) => {
    const item = parseCollectionItem(raw, index)
    const identity = sourceCandidateReference(item)
    if (seen.has(identity.stableReference)) {
      throw new Error(`X current collection contains duplicate candidate ${identity.stableReference}`)
    }
    seen.add(identity.stableReference)
    return item
  }))
}

function parseCollectionItem(value: unknown, index: number): XSourceCollectionItem {
  if (!isRecord(value)) throw new Error(`X current collection item ${index} is not an object`)
  const expectedKeys = ['id', 'url', 'text', 'time', 'user', 'media', 'ts']
  const requiredKeys = ['id', 'url', 'text', 'time', 'user', 'media']
  const actualKeys = Object.keys(value)
  const hasOptionalTimestamp = actualKeys.includes('ts')
  if (!hasExactKeys(value, hasOptionalTimestamp ? expectedKeys : requiredKeys)) {
    throw new Error(`X current collection item ${index} has an invalid raw shape`)
  }
  if (typeof value.id !== 'string' || !/^\d+$/u.test(value.id) || value.id === '0') {
    throw new Error(`X current collection item ${index} has an invalid id`)
  }
  if (typeof value.url !== 'string' || typeof value.text !== 'string' || value.text.trim() === '') {
    throw new Error(`X current collection item ${index} has invalid url or text`)
  }
  if (typeof value.time !== 'string' || !Number.isFinite(Date.parse(value.time))) {
    throw new Error(`X current collection item ${index} has an invalid time`)
  }
  if (typeof value.user !== 'string' || value.user.trim() === '' || !Array.isArray(value.media)
    || value.media.some(media => typeof media !== 'string')
    || (hasOptionalTimestamp && (typeof value.ts !== 'number' || !Number.isFinite(value.ts)))) {
    throw new Error(`X current collection item ${index} has invalid user or media`)
  }
  return {
    id: value.id,
    url: value.url,
    text: value.text,
    time: value.time,
    user: value.user,
    media: Object.freeze([...value.media]),
    ...(hasOptionalTimestamp ? { ts: value.ts as number } : {}),
  }
}

function requireAccepted<T>(result: AcceptedResult<T>, operation: string): T {
  if (result.status !== 'accepted') {
    throw new Error(`${operation} did not return an accepted result: ${result.status}`)
  }
  return result.value
}

function requireMechanicalCandidateAccepted(
  value: unknown,
  expected: MechanicalCandidate,
  operation: string,
): UnscreenedMaterialCandidateAccepted {
  if (!isRecord(value)
    || value.branch !== 'unscreened'
    || value.contract !== 'C08'
    || value.scope !== expected.scope
    || value.period !== expected.period
    || value.candidate !== expected.candidate
    || value.acceptedQualification === undefined) {
    throw new Error(`${operation} returned a mismatched accepted qualification`)
  }
  return value as unknown as UnscreenedMaterialCandidateAccepted
}

function requireMaterialBasisAccepted(
  value: unknown,
  expectedCandidate: SourceCandidateReference,
  operation: string,
): MaterialBasisAccepted {
  if (!isRecord(value)
    || value.candidate !== expectedCandidate
    || value.acceptedBasis === undefined) {
    throw new Error(`${operation} returned a mismatched accepted material basis`)
  }
  return value as unknown as MaterialBasisAccepted
}

type AcceptedResult<T> =
  | { readonly status: 'accepted'; readonly value: T }
  | { readonly status: 'rejected' | 'failed' | 'unknown'; readonly input: unknown }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function samePeriod(left: unknown, right: unknown): boolean {
  return isRecord(left) && isRecord(right)
    && left.run === right.run
    && left.period === right.period
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index])
}

function validateXAdmissionSourceFacts(facts: AdmissionSourceFacts): string | undefined {
  const candidateId = xCandidateStatusId(facts.candidate)
  if (candidateId === undefined
    || !isRecord(facts.authorization)
    || !isRecord(facts.originalObject)
    || !isRecord(facts.attribution)
    || !isRecord(facts.exactDuplicateFact)
    || !isRecord(facts.readabilityFact)
    || !isRecord(facts.candidateBasis)) {
    return undefined
  }

  const authorization = facts.authorization
  const originalObject = facts.originalObject
  const attribution = facts.attribution
  const duplicateFact = facts.exactDuplicateFact
  const readabilityFact = facts.readabilityFact
  const basis = facts.candidateBasis
  if (authorization.kind !== 'x-current-collection-authorization'
    || authorization.source !== 'x'
    || !isNonEmptyString(authorization.runId)
    || !isNonEmptyString(authorization.deliveryId)
    || originalObject.kind !== 'x-status'
    || originalObject.id !== candidateId
    || !isNonEmptyString(originalObject.url)
    || !isNonEmptyString(originalObject.text)
    || parseXStatusIdentity(originalObject.url)?.statusId !== candidateId
    || attribution.kind !== 'x-author'
    || !isNonEmptyString(attribution.handle)
    || duplicateFact.kind !== 'x-current-collection-deduplicated'
    || !isNonEmptyString(duplicateFact.collectionPath)
    || duplicateFact.collectionBatch !== duplicateFact.collectionPath
    || duplicateFact.candidateId !== candidateId
    || readabilityFact.kind !== 'x-current-collection-readable'
    || readabilityFact.candidateId !== candidateId
    || basis.kind !== 'objective_new_content'
    || !isRecord(basis.fact)) {
    return undefined
  }

  const basisFact = basis.fact
  if (basisFact.kind !== 'x-current-collection-item'
    || basisFact.runId !== authorization.runId
    || basisFact.collectionPath !== duplicateFact.collectionPath
    || basisFact.collectionBatch !== duplicateFact.collectionBatch
    || basisFact.deliveryId !== authorization.deliveryId
    || basisFact.candidateId !== candidateId
    || !isPositiveSafeInteger(basisFact.ts)) {
    return undefined
  }
  return xCandidateKey(facts.candidate)
}

function matchesXMaterialSourceFacts(
  facts: MaterialSourceFacts,
  admissionFacts: AdmissionSourceFacts,
): boolean {
  if (xCandidateKey(facts.candidate) !== xCandidateKey(admissionFacts.candidate)
    || !isRecord(facts.originalObject)
    || !isRecord(admissionFacts.originalObject)
    || !isRecord(facts.attribution)
    || !isRecord(admissionFacts.attribution)
    || !isRecord(facts.boundedRelations)
    || !isRecord(facts.accessibility)
    || !isRecord(facts.version)) {
    return false
  }

  const originalObject = facts.originalObject
  const admittedObject = admissionFacts.originalObject
  const attribution = facts.attribution
  const admittedAttribution = admissionFacts.attribution
  return originalObject.kind === 'x-status'
    && originalObject.id === admittedObject.id
    && originalObject.url === admittedObject.url
    && originalObject.text === admittedObject.text
    && attribution.kind === 'x-author'
    && attribution.handle === admittedAttribution.handle
    && facts.boundedRelations.kind === 'x-status-media-relations'
    && Array.isArray(facts.boundedRelations.media)
    && facts.boundedRelations.media.every(media => typeof media === 'string')
    && facts.accessibility.kind === 'x-current-collection-readable'
    && facts.accessibility.url === admittedObject.url
    && facts.version.kind === 'x-status-version'
    && isNonEmptyString(facts.version.observedAt)
    && Number.isFinite(Date.parse(facts.version.observedAt))
}

function isOrdinaryXMechanicalScope(scope: unknown, period: unknown): boolean {
  if (!isRecord(scope)
    || scope.source !== 'x'
    || !isPeriodIdentity(scope.period)
    || !isPeriodIdentity(period)
    || !samePeriod(scope.period, period)
    || !isRecord(scope.start)
    || !isRecord(scope.start.start)
    || !isRecord(scope.reportingWindow)
    || !isRecord(scope.reportingWindow.window)) {
    return false
  }

  const start = scope.start.start
  const window = scope.reportingWindow.window
  return isPeriodIdentity(start.period)
    && samePeriod(start.period, period)
    && isRecord(start.startFact)
    && start.startFact.kind === 'external_run_opportunity_accepted'
    && isRecord(start.origin)
    && (start.origin.kind === 'scheduled' || start.origin.kind === 'manual')
    && isPeriodIdentity(window.period)
    && samePeriod(window.period, period)
    && Array.isArray(window.sources)
    && window.sources.includes('x')
    && isNonEmptyString(window.window)
    && isNonEmptyString(window.closesAt)
    && Number.isFinite(Date.parse(window.closesAt))
}

function xCandidateKey(value: unknown): string | undefined {
  const statusId = xCandidateStatusId(value)
  return statusId === undefined ? undefined : `x\u0000${statusId}`
}

function xCandidateStatusId(value: unknown): string | undefined {
  if (!isRecord(value)
    || value.source !== 'x'
    || typeof value.candidate !== 'string'
    || typeof value.stableReference !== 'string') {
    return undefined
  }
  const match = /^x-status:([1-9]\d*)$/u.exec(value.candidate)
  if (match === null || value.stableReference !== `x:status:${match[1]}`) return undefined
  return match[1]
}

function isPeriodIdentity(value: unknown): value is PeriodIdentity {
  return isRecord(value)
    && isNonEmptyString(value.run)
    && isNonEmptyString(value.period)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  return value
}
