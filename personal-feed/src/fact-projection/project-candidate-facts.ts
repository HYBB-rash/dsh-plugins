import { createHash } from 'node:crypto'
import type {
  CandidateDescriptor,
  CandidateFactAssessment,
  CandidateFactAssessmentAudit,
  CandidateFactAssessmentPort,
  CandidateFactAssessmentRequest,
  ExactLookupGrant,
  LookupTicket,
  ProjectedTrustedFact,
  ProjectionBudget,
  ProjectionFailure,
  ProjectionNotReady,
  ProjectionView,
} from './contracts.ts'
import {
  assertProjectedTrustedFact,
  createLookupTicketFromNavigation,
  createProjectionFailure,
  createProjectionView,
  deterministicLookupTicketId,
  validateAssessmentAudit,
  validateAssessmentAuditCoverage,
  validateCandidateDescriptor,
  validateProjectionBudget,
  type LocatorAssessmentDecision,
} from './contracts.ts'
import type {
  LocatedTrustedFact,
  LocatedTrustedFactSnapshot,
  NavigationItem,
  NavigationSnapshot,
  NavigationTargetRef,
  TrustedFactLocator,
} from '../trusted-facts/navigation-contract.ts'

/**
 * The internal result of candidate projection.  `view` is the only model
 * facing part; the audit and exact grants remain beside it for later
 * capability/lookup layers.
 */
export interface ProjectionArtifact {
  readonly view: ProjectionView
  readonly audit: CandidateFactAssessmentAudit
  readonly grants: readonly ExactLookupGrant[]
}

export type CandidateFactAssessmentInput =
  | CandidateFactAssessmentPort
  | CandidateFactAssessment
  | ProjectionNotReady
  | ProjectionFailure

export interface ProjectCandidateFactsInput {
  readonly candidate: CandidateDescriptor
  readonly facts: LocatedTrustedFactSnapshot
  readonly navigation: NavigationSnapshot
  readonly budget: ProjectionBudget
  readonly assessment?: CandidateFactAssessmentInput
}

export type ProjectCandidateFactsResult = ProjectionArtifact | ProjectionNotReady | ProjectionFailure

type TicketCandidate = {
  readonly decision: LocatorAssessmentDecision
  readonly located: LocatedTrustedFact
  readonly navigation: NavigationItem
}

type TicketGroup = {
  readonly candidates: readonly TicketCandidate[]
  readonly representative: TicketCandidate
  readonly priority: number
}

type ProjectionBuild =
  | { readonly kind: 'ready'; readonly view: ProjectionView; readonly grants: readonly ExactLookupGrant[] }
  | { readonly kind: 'bytes-exceeded' }
  | { readonly kind: 'tickets-exceeded' }
  | { readonly kind: 'invalid'; readonly message: string }

/**
 * A deterministic binding for an assessment to one current candidate.
 * Assessment implementations can use this helper instead of reproducing the
 * canonical encoding.  The value is deliberately a digest, not a capability.
 */
export function fingerprintCandidate(candidate: CandidateDescriptor): string {
  const canonicalCandidate = JSON.stringify([candidate.id, candidate.content, candidate.source])
  return `sha256:${createHash('sha256').update(canonicalCandidate, 'utf8').digest('hex')}`
}

export const candidateFingerprint = fingerprintCandidate

/**
 * Pure candidate projection use case.  It does not issue a branded access
 * capability, read a repository, invoke lookup, or persist state.
 */
export class ProjectCandidateFacts {
  constructor(private readonly assessmentPort?: CandidateFactAssessmentPort) {}

  execute(input: ProjectCandidateFactsInput): ProjectCandidateFactsResult {
    const sourceValidation = validateSourceSnapshots(input.facts, input.navigation)
    if (sourceValidation !== undefined) return sourceValidation

    const candidateValidation = validateCandidateDescriptor(input.candidate)
    if (!candidateValidation.ok) {
      return createProjectionFailure('unrepresentable', candidateValidation.message)
    }
    const budgetValidation = validateProjectionBudget(input.budget)
    if (!budgetValidation.ok) {
      return createProjectionFailure('budget-exceeded', budgetValidation.message)
    }

    const locatedById = indexLocatedFacts(input.facts.facts)
    if (locatedById.kind === 'projection-failure') return locatedById
    const navigationById = indexNavigationItems(input.navigation.items)
    if (navigationById.kind === 'projection-failure') return navigationById
    const snapshotAlignment = validateNavigationFactAlignment(navigationById.items, locatedById.facts)
    if (snapshotAlignment !== undefined) return snapshotAlignment

    const assessmentSource = input.assessment ?? this.assessmentPort
    if (assessmentSource === undefined) {
      return createProjectionFailure('unrepresentable', 'Candidate fact assessment is required.')
    }
    const assessmentResult = resolveAssessment(
      assessmentSource,
      candidateValidation.value,
      input.navigation.items,
      budgetValidation.value,
    )
    if (isProjectionNotReady(assessmentResult) || isProjectionFailure(assessmentResult)) {
      return assessmentResult
    }

    const assessmentValidation = validateAssessment(
      assessmentResult,
      candidateValidation.value,
      input.navigation.items,
    )
    if (isProjectionFailure(assessmentValidation)) return assessmentValidation

    const selections = selectCandidates(
      assessmentValidation.audit,
      navigationById.items,
      locatedById.facts,
    )
    if (selections.kind === 'projection-failure') return selections

    return buildArtifact(
      selections,
      assessmentValidation.audit,
      input.facts.sourceRevision,
      budgetValidation.value,
    )
  }
}

/** Function form for callers that do not need a retained use-case object. */
export function projectCandidateFacts(input: ProjectCandidateFactsInput): ProjectCandidateFactsResult
export function projectCandidateFacts(
  candidate: CandidateDescriptor,
  facts: LocatedTrustedFactSnapshot,
  navigation: NavigationSnapshot,
  budget: ProjectionBudget,
  assessment: CandidateFactAssessmentInput,
): ProjectCandidateFactsResult
export function projectCandidateFacts(
  first: ProjectCandidateFactsInput | CandidateDescriptor,
  facts?: LocatedTrustedFactSnapshot,
  navigation?: NavigationSnapshot,
  budget?: ProjectionBudget,
  assessment?: CandidateFactAssessmentInput,
): ProjectCandidateFactsResult {
  if (isProjectCandidateFactsInput(first)) {
    return new ProjectCandidateFacts().execute(first)
  }
  if (facts === undefined || navigation === undefined || budget === undefined || assessment === undefined) {
    return createProjectionFailure(
      'unrepresentable',
      'Candidate, located facts, navigation, budget, and assessment are all required.',
    )
  }
  return new ProjectCandidateFacts().execute({
    candidate: first,
    facts,
    navigation,
    budget,
    assessment,
  })
}

function resolveAssessment(
  source: CandidateFactAssessmentInput,
  candidate: CandidateDescriptor,
  navigation: readonly NavigationItem[],
  budget: ProjectionBudget,
): CandidateFactAssessment | ProjectionNotReady | ProjectionFailure {
  if (isAssessmentPort(source)) {
    const request: CandidateFactAssessmentRequest = { candidate, navigation, budget }
    return source.assess(request)
  }
  return source
}

function validateAssessment(
  value: CandidateFactAssessment,
  candidate: CandidateDescriptor,
  navigation: readonly NavigationItem[],
): CandidateFactAssessment | ProjectionFailure {
  if (!isCandidateFactAssessment(value)) return createProjectionFailure('invalid-assessment-audit', 'Assessment result is not an object.')
  const candidateResult = validateCandidateDescriptor(value.candidate)
  if (!candidateResult.ok) return createProjectionFailure('invalid-assessment-audit', candidateResult.message)
  if (!sameCandidate(candidateResult.value, candidate)) {
    return createProjectionFailure('invalid-assessment-audit', 'Assessment candidate does not match the current candidate.')
  }

  const auditResult = validateAssessmentAudit(value.audit)
  if (!auditResult.ok) return createProjectionFailure('invalid-assessment-audit', auditResult.message)
  if (auditResult.value.candidateFingerprint !== fingerprintCandidate(candidate)) {
    return createProjectionFailure('invalid-assessment-audit', 'Assessment candidate fingerprint does not match the current candidate.')
  }

  const coverage = validateAssessmentAuditCoverage(auditResult.value, navigation)
  if (coverage.kind === 'projection-failure') return coverage
  return { candidate: candidateResult.value, audit: coverage.audit }
}

function validateSourceSnapshots(
  facts: LocatedTrustedFactSnapshot,
  navigation: NavigationSnapshot,
): ProjectionFailure | undefined {
  if (!isSha256Digest(facts.sourceRevision) || !isSha256Digest(navigation.sourceRevision)) {
    return createProjectionFailure('unrepresentable', 'Fact and navigation snapshots must carry valid source revisions.')
  }
  if (facts.sourceRevision !== navigation.sourceRevision) {
    return createProjectionFailure('unrepresentable', 'Fact and navigation snapshots do not share a source revision.')
  }
  if (navigation.schemaVersion !== 1 || !Array.isArray(navigation.items)) {
    return createProjectionFailure('unrepresentable', 'Navigation snapshot has an invalid schema.')
  }
  if (!Array.isArray(facts.facts)) {
    return createProjectionFailure('unrepresentable', 'Located trusted-fact snapshot has an invalid fact collection.')
  }
  return undefined
}

function indexLocatedFacts(
  locatedFacts: readonly LocatedTrustedFact[],
): { readonly kind: 'valid'; readonly facts: ReadonlyMap<string, LocatedTrustedFact> } | ProjectionFailure {
  const facts = new Map<string, LocatedTrustedFact>()
  for (const located of locatedFacts) {
    if (!isRecord(located) || !isTrustedFactLocator(located.locator)) {
      return createProjectionFailure('unrepresentable', 'Located trusted-fact snapshot contains an invalid locator.')
    }
    const locatorId = located.locator.locatorId
    if (facts.has(locatorId)) {
      return createProjectionFailure('ambiguous-locator-set', 'Located trusted-fact snapshot contains duplicate locator ids.', [locatorId])
    }
    facts.set(locatorId, located)
  }
  return { kind: 'valid', facts }
}

function indexNavigationItems(
  navigation: readonly NavigationItem[],
): { readonly kind: 'valid'; readonly items: ReadonlyMap<string, NavigationItem> } | ProjectionFailure {
  const items = new Map<string, NavigationItem>()
  for (const item of navigation) {
    if (!isRecord(item) || !isRecord(item.locator) || !hasText(item.locator.locatorId)) {
      return createProjectionFailure('unrepresentable', 'Navigation contains an invalid locator.')
    }
    const locatorId = item.locator.locatorId
    if (items.has(locatorId)) {
      return createProjectionFailure('ambiguous-locator-set', 'Navigation contains duplicate locator ids.', [locatorId])
    }
    try {
      createLookupTicketFromNavigation(item)
    } catch (error) {
      return createProjectionFailure('unrepresentable', error instanceof Error ? error.message : 'Navigation item is invalid.')
    }
    items.set(locatorId, item)
  }
  return { kind: 'valid', items }
}

function validateNavigationFactAlignment(
  navigation: ReadonlyMap<string, NavigationItem>,
  locatedFacts: ReadonlyMap<string, LocatedTrustedFact>,
): ProjectionFailure | undefined {
  const missingFacts: string[] = []
  const mismatchedLocators: string[] = []
  for (const [locatorId, item] of navigation) {
    const located = locatedFacts.get(locatorId)
    if (located === undefined) {
      missingFacts.push(locatorId)
      continue
    }
    if (compareLocatorKeys(located.locator, item.locator) !== 0) {
      mismatchedLocators.push(locatorId)
      continue
    }

    const target = isRecord(located.fact) && isRecord(located.fact.target)
      ? located.fact.target
      : undefined
    const targetRefs = item.hints.targetRefs
    const targetRef = targetRefs.length === 1 ? targetRefs[0] : undefined
    if (target === undefined || !hasText(target.id) || !hasText(target.source)
      || targetRef === undefined
      || targetRef.targetId !== target.id
      || targetRef.canonicalSource !== target.source
      || item.hints.dimension !== located.fact.dimension) {
      mismatchedLocators.push(locatorId)
    }
  }
  if (missingFacts.length > 0) {
    return createProjectionFailure(
      'unknown-locator',
      'Navigation names a locator that is absent from the located trusted-fact snapshot.',
      missingFacts,
    )
  }
  if (mismatchedLocators.length > 0) {
    return createProjectionFailure(
      'unrepresentable',
      'Navigation target references or dimensions disagree with the located trusted-fact snapshot.',
      mismatchedLocators,
    )
  }
  return undefined
}

function selectCandidates(
  audit: CandidateFactAssessmentAudit,
  navigation: ReadonlyMap<string, NavigationItem>,
  locatedFacts: ReadonlyMap<string, LocatedTrustedFact>,
): { readonly kind: 'valid'; readonly inline: readonly TicketCandidate[]; readonly tickets: readonly TicketCandidate[] } | ProjectionFailure {
  const decisionsById = new Map(audit.decisions.map(decision => [decision.locatorId, decision]))
  const all: TicketCandidate[] = []
  for (const [locatorId, decision] of decisionsById) {
    if (decision.relevance === 'unrelated') continue
    const item = navigation.get(locatorId)
    const located = locatedFacts.get(locatorId)
    if (item === undefined || located === undefined) {
      return createProjectionFailure('unknown-locator', 'Assessment selected a locator absent from the current snapshots.', [locatorId])
    }
    all.push({ decision, navigation: item, located })
  }
  all.sort(compareCandidates)
  return {
    kind: 'valid',
    inline: all.filter(candidate => candidate.decision.relevance === 'high'
      && candidate.decision.essentiality === 'inline_priority'),
    tickets: all.filter(candidate => !(candidate.decision.relevance === 'high'
      && candidate.decision.essentiality === 'inline_priority')),
  }
}

function buildArtifact(
  selections: { readonly kind: 'valid'; readonly inline: readonly TicketCandidate[]; readonly tickets: readonly TicketCandidate[] },
  audit: CandidateFactAssessmentAudit,
  sourceRevision: string,
  budget: ProjectionBudget,
): ProjectionArtifact | ProjectionFailure {
  let inline = [...selections.inline.slice(0, budget.maxInlineFacts)]
  let overflow = [...selections.inline.slice(budget.maxInlineFacts), ...selections.tickets]

  while (true) {
    const built = buildProjection(inline, overflow, sourceRevision, budget)
    if (built.kind === 'ready') {
      return Object.freeze({
        view: built.view,
        audit: Object.freeze({ ...audit, decisions: Object.freeze([...audit.decisions]) }),
        grants: Object.freeze([...built.grants]),
      })
    }
    if (built.kind === 'tickets-exceeded') {
      return createProjectionFailure(
        'unrepresentable',
        'Relevant navigation cannot be represented within maxLookupTickets.',
      )
    }
    if (built.kind === 'bytes-exceeded' && inline.length > 0) {
      // Extract Method/Guard Clause style: moving the lowest-priority inline
      // candidate is the only mechanical way to reduce the body budget while
      // preserving the explicit priority order.
      overflow.push(inline.pop() as TicketCandidate)
      overflow.sort(compareCandidates)
      continue
    }
    if (built.kind === 'bytes-exceeded') {
      return createProjectionFailure('budget-exceeded', 'Projection cannot fit the fixed canonical UTF-8 byte budget.')
    }
    return createProjectionFailure('unrepresentable', built.message)
  }
}

function buildProjection(
  inline: readonly TicketCandidate[],
  overflow: readonly TicketCandidate[],
  sourceRevision: string,
  budget: ProjectionBudget,
): ProjectionBuild {
  const facts: ProjectedTrustedFact[] = []
  try {
    for (const candidate of inline) facts.push(assertProjectedTrustedFact(candidate.located.fact))
  } catch (error) {
    return { kind: 'invalid', message: error instanceof Error ? error.message : 'Trusted fact is invalid.' }
  }

  const groups = groupTicketCandidates(overflow)
  if (groups.length > budget.maxLookupTickets) return { kind: 'tickets-exceeded' }
  const tickets = groups.map(createTicket)
  const grants = groups.map(group => createGrant(group, sourceRevision))

  try {
    const view = createProjectionView({ facts, tickets }, budget)
    return { kind: 'ready', view, grants: Object.freeze(grants) }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Projection view is invalid.'
    if (message.toLowerCase().includes('serialized byte')) return { kind: 'bytes-exceeded' }
    if (message.toLowerCase().includes('lookup ticket')) return { kind: 'tickets-exceeded' }
    return { kind: 'invalid', message }
  }
}

function groupTicketCandidates(candidates: readonly TicketCandidate[]): readonly TicketGroup[] {
  const groups = new Map<string, TicketCandidate[]>()
  for (const candidate of candidates) {
    const key = ticketGroupKey(candidate.navigation)
    const group = groups.get(key)
    if (group === undefined) groups.set(key, [candidate])
    else group.push(candidate)
  }
  return [...groups.values()]
    .map(group => {
      const sorted = [...group].sort(compareCandidates)
      return {
        candidates: Object.freeze(sorted),
        representative: sorted[0] as TicketCandidate,
        priority: sorted[0]?.decision.priority ?? 0,
      }
    })
    .sort((left, right) => left.priority - right.priority
      || compareLocatorKeys(left.representative.navigation.locator, right.representative.navigation.locator))
}

function ticketGroupKey(item: NavigationItem): string {
  const targetRefs = canonicalTargetRefs(item.hints.targetRefs)
  // A dimension-only summary is too broad when there is no target reference;
  // retain exact topics in that exceptional case.
  const topics = targetRefs.length === 0 ? [...item.hints.topics].sort(compareStrings) : []
  return JSON.stringify({ dimension: item.hints.dimension, targetRefs, topics })
}

function createTicket(group: TicketGroup): LookupTicket {
  const representative = group.representative.navigation
  const base = createLookupTicketFromNavigation(
    representative,
    deterministicLookupTicketId(representative.locator.locatorId),
    group.candidates.length,
  )
  const topics = commonTopics(group.candidates.map(candidate => candidate.navigation.hints.topics))
  return Object.freeze({ ...base, topics: Object.freeze(topics) })
}

function createGrant(group: TicketGroup, sourceRevision: string): ExactLookupGrant {
  return Object.freeze({
    ticketId: deterministicLookupTicketId(group.representative.navigation.locator.locatorId),
    locatorIds: Object.freeze(group.candidates.map(candidate => candidate.navigation.locator.locatorId)),
    snapshotRevision: sourceRevision,
  })
}

function commonTopics(topicLists: readonly (readonly string[])[]): readonly string[] {
  const first = topicLists[0]
  if (first === undefined) return []
  const rest = topicLists.slice(1).map(topics => new Set(topics))
  return [...new Set(first)].filter(topic => rest.every(topics => topics.has(topic)))
}

function canonicalTargetRefs(targetRefs: readonly NavigationTargetRef[]): readonly NavigationTargetRef[] {
  return [...targetRefs]
    .map(targetRef => ({ targetId: targetRef.targetId, canonicalSource: targetRef.canonicalSource }))
    .sort((left, right) => compareStrings(`${left.targetId}\u0000${left.canonicalSource}`, `${right.targetId}\u0000${right.canonicalSource}`))
}

function compareCandidates(left: TicketCandidate, right: TicketCandidate): number {
  return left.decision.priority - right.decision.priority
    || compareLocatorKeys(left.navigation.locator, right.navigation.locator)
}

function compareLocatorKeys(left: TrustedFactLocator, right: TrustedFactLocator): number {
  const leftKey = JSON.stringify([
    left.schemaVersion,
    left.locatorId,
    left.persistence.sourceKind,
    left.persistence.sourceKey,
    left.persistence.lineNumber,
    left.persistence.canonicalDigest,
  ])
  const rightKey = JSON.stringify([
    right.schemaVersion,
    right.locatorId,
    right.persistence.sourceKind,
    right.persistence.sourceKey,
    right.persistence.lineNumber,
    right.persistence.canonicalDigest,
  ])
  return compareStrings(leftKey, rightKey)
}

function isTrustedFactLocator(value: unknown): value is TrustedFactLocator {
  if (!isRecord(value) || value.schemaVersion !== 1 || !hasText(value.locatorId)
    || !isRecord(value.persistence)
    || value.persistence.sourceKind !== 'trusted-fact-repository'
    || !hasText(value.persistence.sourceKey)
    || !Number.isSafeInteger(value.persistence.lineNumber) || value.persistence.lineNumber <= 0
    || !isSha256Digest(value.persistence.canonicalDigest)) {
    return false
  }
  return true
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function sameCandidate(left: CandidateDescriptor, right: CandidateDescriptor): boolean {
  return left.id === right.id && left.content === right.content && left.source === right.source
}

function isAssessmentPort(value: CandidateFactAssessmentInput): value is CandidateFactAssessmentPort {
  return typeof value === 'object' && value !== null
    && 'assess' in value && typeof (value as { readonly assess?: unknown }).assess === 'function'
}

function isCandidateFactAssessment(value: CandidateFactAssessment | ProjectionNotReady | ProjectionFailure): value is CandidateFactAssessment {
  return isRecord(value) && 'candidate' in value && 'audit' in value
}

function isProjectionNotReady(value: CandidateFactAssessment | ProjectionNotReady | ProjectionFailure): value is ProjectionNotReady {
  return isRecord(value) && (value as { readonly kind?: unknown }).kind === 'not-ready'
}

function isProjectionFailure(value: CandidateFactAssessment | ProjectionNotReady | ProjectionFailure): value is ProjectionFailure {
  return isRecord(value) && (value as { readonly kind?: unknown }).kind === 'projection-failure'
}

function isProjectCandidateFactsInput(value: ProjectCandidateFactsInput | CandidateDescriptor): value is ProjectCandidateFactsInput {
  return isRecord(value) && 'facts' in value && 'navigation' in value && 'budget' in value
}

function isSha256Digest(value: unknown): value is `sha256:${string}` {
  return typeof value === 'string' && /^sha256:.+$/.test(value)
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
