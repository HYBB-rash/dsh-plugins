import type {
  ApplicationLevel,
  FactDimension,
  FactEvidence,
  FactTarget,
} from '../trusted-facts/model.ts'
import type {
  NavigationItem,
  NavigationTargetRef,
  TrustedFactLocator,
} from '../trusted-facts/navigation-contract.ts'

/** A current X candidate. It deliberately contains no history or user judgement. */
export interface CandidateDescriptor {
  readonly id: string
  readonly content: string
  readonly source: string
}

/** A neutral segment that lets a later adapter mechanically preselect navigation. */
export interface NavigationSegment {
  readonly kind: 'navigation-segment'
  readonly segmentId: string
  readonly items: readonly NavigationItem[]
}

export type NeutralNavigationInput =
  | readonly NavigationItem[]
  | readonly NavigationSegment[]

/** Fixed per-run limits. They are not a limit on a later exact lookup. */
export interface ProjectionBudget {
  readonly maxInlineFacts: number
  readonly maxLookupTickets: number
  readonly maxSerializedBytes: number
}

export interface CandidateFactAssessmentRequest {
  readonly candidate: CandidateDescriptor
  readonly navigation: NeutralNavigationInput
  readonly budget: ProjectionBudget
}

export type AssessmentRelevance = 'high' | 'low_confidence' | 'unrelated'
export type AssessmentEssentiality = 'inline_priority' | 'lookup_only'

/** One explicit, auditable decision for one navigation locator. */
export interface LocatorAssessmentDecision {
  readonly locatorId: string
  readonly relevance: AssessmentRelevance
  readonly essentiality: AssessmentEssentiality
  /** Explicit sorting key only; ties remain for projector canonical tie-break and never grant access. */
  readonly priority: number
  readonly reason: string
}

export interface CandidateFactAssessmentAudit {
  readonly policyId: string
  readonly policyVersion: string
  readonly candidateFingerprint: string
  readonly decisions: readonly LocatorAssessmentDecision[]
}

export interface CandidateFactAssessment {
  readonly candidate: CandidateDescriptor
  readonly audit: CandidateFactAssessmentAudit
}

export interface CandidateFactAssessmentPort {
  assess(
    request: CandidateFactAssessmentRequest,
  ): CandidateFactAssessment | ProjectionNotReady | ProjectionFailure
}

export type AssessmentAuditCoverageResult =
  | { readonly kind: 'valid'; readonly audit: CandidateFactAssessmentAudit }
  | ProjectionFailure

export function validateCandidateFactAssessmentRequest(
  value: unknown,
): ContractValidationResult<CandidateFactAssessmentRequest> {
  if (!hasExactKeys(value, ['candidate', 'navigation', 'budget']) || !Array.isArray(value.navigation)) {
    return invalid('invalid-assessment-request', 'Assessment request must contain candidate, navigation, and budget.')
  }
  const candidateResult = validateCandidateDescriptor(value.candidate)
  if (!candidateResult.ok) return candidateResult
  const budgetResult = validateProjectionBudget(value.budget)
  if (!budgetResult.ok) return budgetResult

  const navigationResult = validateNeutralNavigation(value.navigation)
  if (!navigationResult.ok) return navigationResult
  return valid({
    candidate: candidateResult.value,
    navigation: navigationResult.value,
    budget: budgetResult.value,
  })
}

/** The model-visible fact DTO. All TrustedFact fields are retained verbatim. */
export interface ProjectedTrustedFact {
  readonly target: FactTarget
  readonly dimension: FactDimension
  readonly reason: string
  readonly applicationLevel: ApplicationLevel
  readonly evidence: FactEvidence
}

export type LookupSelectorField =
  | 'target_id'
  | 'canonical_source'
  | 'dimension'
  | 'topic'

/** A deliberately closed selector summary derived from navigation only. */
export interface LookupSelectorSummary {
  readonly field: LookupSelectorField
  readonly value: string
}

/**
 * Model-visible location information. It contains no trusted-fact body,
 * reason, scope, application level, evidence, attitude, or filtering result.
 */
export interface LookupTicket {
  readonly ticketId: string
  readonly locator: TrustedFactLocator
  /** Number of explicitly selected locators represented by this neutral ticket. */
  readonly selectedLocatorCount: number
  readonly targetRefs: readonly NavigationTargetRef[]
  readonly dimension: FactDimension
  readonly topics: readonly string[]
  readonly selector?: readonly LookupSelectorSummary[]
}

export interface LookupRequest {
  readonly ticketId: string
}

export interface LookupSuccess {
  readonly kind: 'lookup-success'
  readonly facts: readonly ProjectedTrustedFact[]
}

export type LookupFailureCode =
  | 'invalid_access'
  | 'grant_not_found'
  | 'grant_snapshot_mismatch'
  | 'ticket_not_found'
  | 'invalid_fact'

export interface LookupFailure {
  readonly kind: 'lookup-failure'
  readonly code: LookupFailureCode
  readonly message: string
}

export type LookupResult = LookupSuccess | LookupFailure

/** The lookup port accepts only a ticket id; grant state stays outside the request DTO. */
export interface ExactTrustedFactLookupPort {
  lookup(access: ReadyFactProjectionAccess, request: LookupRequest): LookupResult
}

/** Exact grants may contain any number of explicitly audited locators. */
export interface ExactLookupGrant {
  readonly ticketId: string
  readonly locatorIds: readonly string[]
  readonly snapshotRevision: string
}

export interface FrozenProjectionSnapshot {
  readonly revision: string
}

const readyFactProjectionAccessBrand: unique symbol = Symbol('ReadyFactProjectionAccess')

/**
 * A private branded capability. The brand alone is not authorization: the
 * registry that issued a grant must also recognize this exact access object.
 */
export interface ReadyFactProjectionAccess {
  readonly [readyFactProjectionAccessBrand]: true
}

export interface FactProjectionAccessRegistry {
  createAccess(snapshot: FrozenProjectionSnapshot): ReadyFactProjectionAccess
  issueGrant(
    access: ReadyFactProjectionAccess,
    snapshot: FrozenProjectionSnapshot,
    ticketId: string,
    locatorIds: readonly string[],
  ): ExactLookupGrant
  authorize(
    access: ReadyFactProjectionAccess,
    grant: ExactLookupGrant,
    snapshot: FrozenProjectionSnapshot,
  ): boolean
}

export interface ProjectionView {
  readonly facts: readonly ProjectedTrustedFact[]
  readonly tickets: readonly LookupTicket[]
  readonly serializedBytes: Uint8Array
}

export type ProjectionNotReadyCode =
  | 'facts-unavailable'
  | 'navigation-unavailable'
  | 'projection-unavailable'
  | 'navigation-schema-invalid'
  | 'source-revision-mismatch'
  | 'assessment-policy-unavailable'
  | 'limits-unavailable'
  | 'projector-unavailable'
  | 'lookup-unavailable'

export interface ProjectionNotReady {
  readonly kind: 'not-ready'
  readonly code: ProjectionNotReadyCode
  readonly message: string
}

export type ProjectionFailureCode =
  | 'invalid-assessment-audit'
  | 'unknown-locator'
  | 'ambiguous-locator-set'
  | 'unrepresentable'
  | 'budget-exceeded'

export interface ProjectionFailure {
  readonly kind: 'projection-failure'
  readonly code: ProjectionFailureCode
  readonly message: string
  readonly locatorIds?: readonly string[]
}

export type ProjectionResult =
  | { readonly kind: 'ready'; readonly view: ProjectionView; readonly access: ReadyFactProjectionAccess }
  | ProjectionNotReady
  | ProjectionFailure

export function createProjectionNotReady(
  code: ProjectionNotReadyCode,
  message: string,
): ProjectionNotReady {
  if (!isProjectionNotReadyCode(code) || !hasText(message)) throw new TypeError('Not-ready result is invalid.')
  return Object.freeze({ kind: 'not-ready', code, message })
}

export function createProjectionFailure(
  code: ProjectionFailureCode,
  message: string,
  locatorIds?: readonly string[],
): ProjectionFailure {
  if (!isProjectionFailureCode(code) || !hasText(message)) throw new TypeError('Projection failure is invalid.')
  if (locatorIds !== undefined && !validLocatorIds(locatorIds)) {
    throw new TypeError('Projection failure locatorIds must be an explicit non-empty set.')
  }
  return Object.freeze({
    kind: 'projection-failure',
    code,
    message,
    ...(locatorIds === undefined ? {} : { locatorIds: Object.freeze([...locatorIds]) }),
  })
}

export interface ContractValidationSuccess<T> {
  readonly ok: true
  readonly value: T
}

export interface ContractValidationFailure {
  readonly ok: false
  readonly code: string
  readonly message: string
}

export type ContractValidationResult<T> =
  | ContractValidationSuccess<T>
  | ContractValidationFailure

const NAVIGATION_SCHEMA_VERSION = 1
const lookupSelectorFields: readonly LookupSelectorField[] = [
  'target_id', 'canonical_source', 'dimension', 'topic',
]
const factDimensions: readonly FactDimension[] = [
  'content_value', 'argument_quality', 'factual_accuracy',
]
const applicationLevels: readonly ApplicationLevel[] = [
  'observation', 'reusable_rule', 'hard_exclusion',
]

export function validateProjectionBudget(value: unknown): ContractValidationResult<ProjectionBudget> {
  if (!hasExactKeys(value, ['maxInlineFacts', 'maxLookupTickets', 'maxSerializedBytes'])) {
    return invalid('invalid-budget', 'Projection budget must contain exactly its three limits.')
  }
  if (!isPositiveInteger(value.maxInlineFacts) || !isPositiveInteger(value.maxLookupTickets)
    || !isPositiveInteger(value.maxSerializedBytes)) {
    return invalid('invalid-budget', 'Projection budget limits must be positive finite integers.')
  }
  return valid({
    maxInlineFacts: value.maxInlineFacts,
    maxLookupTickets: value.maxLookupTickets,
    maxSerializedBytes: value.maxSerializedBytes,
  })
}

export function assertProjectionBudget(value: unknown): ProjectionBudget {
  return assertValid(validateProjectionBudget(value))
}

export function validateCandidateDescriptor(value: unknown): ContractValidationResult<CandidateDescriptor> {
  if (!hasExactKeys(value, ['id', 'content', 'source'])
    || !hasText(value.id) || !hasText(value.content) || !hasText(value.source)) {
    return invalid('invalid-candidate', 'Candidate descriptor must contain non-empty id, content, and source.')
  }
  return valid({ id: value.id, content: value.content, source: value.source })
}

export function validateAssessmentAudit(value: unknown): ContractValidationResult<CandidateFactAssessmentAudit> {
  if (!hasExactKeys(value, ['policyId', 'policyVersion', 'candidateFingerprint', 'decisions'])
    || !hasText(value.policyId) || !hasText(value.policyVersion) || !hasText(value.candidateFingerprint)
    || !Array.isArray(value.decisions)) {
    return invalid('invalid-assessment-audit', 'Assessment audit has an invalid shape.')
  }

  const decisions: LocatorAssessmentDecision[] = []
  const seen = new Set<string>()
  for (const decision of value.decisions) {
    const result = validateLocatorDecision(decision)
    if (!result.ok) return result
    if (seen.has(result.value.locatorId)) {
      return invalid('invalid-assessment-audit', 'Assessment audit contains a duplicate locator decision.')
    }
    seen.add(result.value.locatorId)
    decisions.push(result.value)
  }
  return valid({
    policyId: value.policyId,
    policyVersion: value.policyVersion,
    candidateFingerprint: value.candidateFingerprint,
    decisions: Object.freeze(decisions),
  })
}

export function assertAssessmentAudit(value: unknown): CandidateFactAssessmentAudit {
  return assertValid(validateAssessmentAudit(value))
}

/**
 * Coverage is checked after readiness. A fake or incomplete locator set is a
 * projection failure, never a not-ready result and never silently omitted.
 */
export function validateAssessmentAuditCoverage(
  auditValue: unknown,
  navigationValue: unknown,
): AssessmentAuditCoverageResult {
  const auditResult = validateAssessmentAudit(auditValue)
  if (!auditResult.ok) return createProjectionFailure('invalid-assessment-audit', auditResult.message)
  const navigationResult = validateNeutralNavigationInput(navigationValue)
  if (!navigationResult.ok) return createProjectionFailure('unrepresentable', navigationResult.message)

  const navigationIds = flattenNavigation(navigationResult.value).map(item => item.locator.locatorId)
  if (new Set(navigationIds).size !== navigationIds.length) {
    return createProjectionFailure('ambiguous-locator-set', 'Navigation contains duplicate locator ids.')
  }
  const expected = new Set(navigationIds)
  const actual = new Set(auditResult.value.decisions.map(decision => decision.locatorId))
  const unknown = [...actual].filter(locatorId => !expected.has(locatorId))
  if (unknown.length > 0) return createProjectionFailure('unknown-locator', 'Assessment audit names an unknown locator.', unknown)
  const missing = navigationIds.filter(locatorId => !actual.has(locatorId))
  if (missing.length > 0) return createProjectionFailure('ambiguous-locator-set', 'Assessment audit does not decide every locator.', missing)
  return { kind: 'valid', audit: auditResult.value }
}

export function validateProjectedTrustedFact(value: unknown): ContractValidationResult<ProjectedTrustedFact> {
  if (!hasExactKeys(value, ['target', 'dimension', 'reason', 'applicationLevel', 'evidence'])
    || !isRecord(value.target) || !hasExactKeys(value.target, ['id', 'content', 'source', 'scope'])
    || !hasText(value.target.id) || !hasText(value.target.content)
    || !hasText(value.target.source) || !hasText(value.target.scope)
    || !isDimension(value.dimension) || !hasText(value.reason)
    || !isApplicationLevel(value.applicationLevel)) {
    return invalid('invalid-projected-fact', 'Projected trusted fact has an invalid or incomplete shape.')
  }
  const evidenceResult = validateEvidence(value.evidence)
  if (!evidenceResult.ok) return evidenceResult

  const projectedFact: ProjectedTrustedFact = {
    target: {
      id: value.target.id,
      content: value.target.content,
      source: value.target.source,
      scope: value.target.scope,
    },
    dimension: value.dimension,
    reason: value.reason,
    applicationLevel: value.applicationLevel,
    evidence: evidenceResult.value,
  }
  return valid(projectedFact)
}

export function assertProjectedTrustedFact(value: unknown): ProjectedTrustedFact {
  return assertValid(validateProjectedTrustedFact(value))
}

export function validateLookupTicket(value: unknown): ContractValidationResult<LookupTicket> {
  if (!hasExactKeys(value, ['ticketId', 'locator', 'selectedLocatorCount', 'targetRefs', 'dimension', 'topics'], 'selector')
    || !hasText(value.ticketId) || !isValidSelectedLocatorCount(value.selectedLocatorCount)
    || !isDimension(value.dimension)
    || !Array.isArray(value.targetRefs) || !Array.isArray(value.topics)) {
    return invalid('invalid-lookup-ticket', 'Lookup ticket has an invalid or forbidden shape.')
  }
  const locatorResult = validateLocator(value.locator)
  if (!locatorResult.ok) return invalid('invalid-lookup-ticket', locatorResult.message)
  const targetRefs: NavigationTargetRef[] = []
  for (const targetRef of value.targetRefs) {
    if (!hasExactKeys(targetRef, ['targetId', 'canonicalSource'])
      || !hasText(targetRef.targetId) || !hasText(targetRef.canonicalSource)) {
      return invalid('invalid-lookup-ticket', 'Lookup ticket target references must come from navigation.')
    }
    targetRefs.push({ targetId: targetRef.targetId, canonicalSource: targetRef.canonicalSource })
  }
  const topics: string[] = []
  for (const topic of value.topics) {
    if (!hasText(topic)) return invalid('invalid-lookup-ticket', 'Lookup ticket topics must be non-empty strings.')
    topics.push(topic)
  }
  const selectorResult = value.selector === undefined
    ? valid<readonly LookupSelectorSummary[]>([])
    : validateSelectorSummary(value.selector)
  if (!selectorResult.ok) return selectorResult

  return valid({
    ticketId: value.ticketId,
    locator: locatorResult.value,
    selectedLocatorCount: value.selectedLocatorCount,
    targetRefs: Object.freeze(targetRefs),
    dimension: value.dimension,
    topics: Object.freeze(topics),
    ...(value.selector === undefined ? {} : { selector: selectorResult.value }),
  })
}

export function assertLookupTicket(value: unknown): LookupTicket {
  return assertValid(validateLookupTicket(value))
}

export function createLookupTicketFromNavigation(
  navigation: NavigationItem,
  ticketId = deterministicLookupTicketId(navigation.locator.locatorId),
  selectedLocatorCount = 1,
): LookupTicket {
  const itemResult = validateNavigationItem(navigation)
  if (!itemResult.ok) throw new TypeError(itemResult.message)
  const item = itemResult.value
  const ticket: LookupTicket = {
    ticketId,
    locator: item.locator,
    selectedLocatorCount,
    targetRefs: item.hints.targetRefs,
    dimension: item.hints.dimension,
    topics: item.hints.topics,
  }
  return assertLookupTicket(ticket)
}

export const createLookupTicket = createLookupTicketFromNavigation

export function deterministicLookupTicketId(locatorId: string): string {
  if (!hasText(locatorId)) throw new TypeError('Locator id must be non-empty.')
  return `ticket:${locatorId}`
}

export function validateLookupRequest(value: unknown): ContractValidationResult<LookupRequest> {
  if (!hasExactKeys(value, ['ticketId']) || !hasText(value.ticketId)) {
    return invalid('invalid-lookup-request', 'Lookup request contains only one non-empty ticketId.')
  }
  return valid({ ticketId: value.ticketId })
}

export function createLookupRequest(value: unknown): LookupRequest {
  return assertValid(validateLookupRequest(value))
}

export function canonicalSerializeProjectionPayload(value: unknown): string {
  if (!hasExactKeys(value, ['facts', 'tickets']) || !Array.isArray(value.facts) || !Array.isArray(value.tickets)) {
    throw new TypeError('Projection payload must contain exactly facts and tickets.')
  }
  const facts = value.facts.map(assertProjectedTrustedFact)
  const tickets = value.tickets.map(assertLookupTicket)
  return canonicalJson({ facts, tickets })
}

export function utf8Bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

export function createProjectionView(
  value: unknown,
  budget: unknown,
): ProjectionView {
  const limits = assertProjectionBudget(budget)
  if (!hasExactKeys(value, ['facts', 'tickets']) || !Array.isArray(value.facts) || !Array.isArray(value.tickets)) {
    throw new TypeError('Projection view contains forbidden fields or has an invalid shape.')
  }
  if (value.facts.length > limits.maxInlineFacts) throw new RangeError('Projection view exceeds inline fact budget.')
  if (value.tickets.length > limits.maxLookupTickets) throw new RangeError('Projection view exceeds lookup ticket budget.')

  const facts = Object.freeze(value.facts.map(assertProjectedTrustedFact))
  const tickets = Object.freeze(value.tickets.map(assertLookupTicket))
  const serializedBytes = utf8Bytes(canonicalSerializeProjectionPayload({ facts, tickets }))
  if (serializedBytes.byteLength > limits.maxSerializedBytes) {
    throw new RangeError('Projection view exceeds serialized byte budget.')
  }
  return Object.freeze({ facts, tickets, serializedBytes })
}

export function validateProjectionView(
  value: unknown,
  budget: unknown,
): ContractValidationResult<ProjectionView> {
  try {
    if (!isRecord(value) || !hasExactKeys(value, ['facts', 'tickets', 'serializedBytes'])
      || !Array.isArray(value.facts) || !Array.isArray(value.tickets)
      || !(value.serializedBytes instanceof Uint8Array)) {
      return invalid('invalid-projection-view', 'Projection view must contain facts, tickets, and UTF-8 serializedBytes only.')
    }
    const expected = createProjectionView({ facts: value.facts, tickets: value.tickets }, budget)
    if (!sameBytes(expected.serializedBytes, value.serializedBytes)) {
      return invalid('invalid-projection-view', 'Projection view serializedBytes are not canonical UTF-8 bytes.')
    }
    return valid(expected)
  } catch (error) {
    return invalid('invalid-projection-view', error instanceof Error ? error.message : 'Projection view is invalid.')
  }
}

export function assertProjectionView(value: unknown, budget: unknown): ProjectionView {
  return assertValid(validateProjectionView(value, budget))
}

export function createReadyFactProjectionAccessRegistry(): FactProjectionAccessRegistry {
  const records = new WeakMap<object, AccessRecord>()

  return {
    createAccess(snapshot) {
      assertSnapshot(snapshot)
      const access = Object.freeze({ [readyFactProjectionAccessBrand]: true }) as ReadyFactProjectionAccess
      records.set(access, { snapshot, grants: new WeakSet<object>() })
      return access
    },
    issueGrant(access, snapshot, ticketId, locatorIds) {
      const record = records.get(access)
      if (record === undefined) throw new TypeError('Access was not issued by this registry.')
      assertSnapshot(snapshot)
      if (record.snapshot !== snapshot || record.snapshot.revision !== snapshot.revision) {
        throw new TypeError('Grant snapshot does not match the access snapshot.')
      }
      if (!hasText(ticketId) || !validLocatorIds(locatorIds)) {
        throw new TypeError('Exact lookup grant requires a ticket id and explicit locator ids.')
      }
      const grant = Object.freeze({
        ticketId,
        locatorIds: Object.freeze([...locatorIds]),
        snapshotRevision: snapshot.revision,
      })
      record.grants.add(grant)
      return grant
    },
    authorize(access, grant, snapshot) {
      const record = records.get(access)
      if (record === undefined || !record.grants.has(grant)) return false
      return record.snapshot === snapshot && record.snapshot.revision === snapshot.revision
        && grant.snapshotRevision === snapshot.revision
    },
  }
}

export function isReadyFactProjectionAccess(value: unknown): value is ReadyFactProjectionAccess {
  return typeof value === 'object' && value !== null
    && (value as { readonly [readyFactProjectionAccessBrand]?: unknown })[readyFactProjectionAccessBrand] === true
}

function validateLocatorDecision(value: unknown): ContractValidationResult<LocatorAssessmentDecision> {
  if (!hasExactKeys(value, ['locatorId', 'relevance', 'essentiality', 'priority', 'reason'])
    || !hasText(value.locatorId) || !isAssessmentRelevance(value.relevance)
    || !isAssessmentEssentiality(value.essentiality) || !isNonNegativeInteger(value.priority)
    || !hasText(value.reason)) {
    return invalid('invalid-assessment-audit', 'Locator decision must have explicit valid relevance, essentiality, priority, and reason.')
  }
  if (value.relevance === 'unrelated' && value.essentiality !== 'lookup_only') {
    return invalid('invalid-assessment-audit', 'Unrelated locators cannot be inline priorities.')
  }
  if (value.relevance === 'low_confidence' && value.essentiality !== 'lookup_only') {
    return invalid('invalid-assessment-audit', 'Low-confidence locators can only be lookup-only.')
  }
  return valid({
    locatorId: value.locatorId,
    relevance: value.relevance,
    essentiality: value.essentiality,
    priority: value.priority,
    reason: value.reason,
  })
}

function validateEvidence(value: unknown): ContractValidationResult<FactEvidence> {
  if (!isRecord(value) || !hasText(value.rawUserExpression)) {
    return invalid('invalid-projected-fact', 'Projected fact evidence must preserve rawUserExpression.')
  }
  if (value.kind === 'user_direct') {
    if (!hasExactKeys(value, ['kind', 'rawUserExpression'], 'explicitApplicationLevel')
      || (value.explicitApplicationLevel !== undefined && !isApplicationLevel(value.explicitApplicationLevel))) {
      return invalid('invalid-projected-fact', 'User-direct evidence has an invalid shape.')
    }
    return valid({
      kind: 'user_direct',
      rawUserExpression: value.rawUserExpression,
      ...(value.explicitApplicationLevel === undefined ? {} : { explicitApplicationLevel: value.explicitApplicationLevel }),
    })
  }
  if (value.kind !== 'user_confirmed_candidate') {
    return invalid('invalid-projected-fact', 'Unconfirmed candidate evidence cannot be projected.')
  }
  if (!hasExactKeys(value, ['kind', 'rawUserExpression', 'candidate', 'confirmation'], 'explicitApplicationLevel')
    || !hasText(value.candidate) || !hasText(value.confirmation)
    || (value.explicitApplicationLevel !== undefined && !isApplicationLevel(value.explicitApplicationLevel))) {
    return invalid('invalid-projected-fact', 'Confirmed-candidate evidence has an invalid shape.')
  }
  return valid({
    kind: 'user_confirmed_candidate',
    rawUserExpression: value.rawUserExpression,
    candidate: value.candidate,
    confirmation: value.confirmation,
    ...(value.explicitApplicationLevel === undefined ? {} : { explicitApplicationLevel: value.explicitApplicationLevel }),
  })
}

function validateSelectorSummary(value: unknown): ContractValidationResult<readonly LookupSelectorSummary[]> {
  if (!Array.isArray(value)) return invalid('invalid-lookup-ticket', 'Selector summary must be an array.')
  const selectors: LookupSelectorSummary[] = []
  for (const selector of value) {
    if (!hasExactKeys(selector, ['field', 'value']) || !isLookupSelectorField(selector.field) || !hasText(selector.value)) {
      return invalid('invalid-lookup-ticket', 'Selector summary contains a non-whitelisted field.')
    }
    selectors.push({ field: selector.field, value: selector.value })
  }
  return valid(Object.freeze(selectors))
}

function validateLocator(value: unknown): ContractValidationResult<TrustedFactLocator> {
  if (!hasExactKeys(value, ['schemaVersion', 'locatorId', 'persistence']) || value.schemaVersion !== NAVIGATION_SCHEMA_VERSION
    || !hasText(value.locatorId) || !hasExactKeys(value.persistence, [
      'sourceKind', 'sourceKey', 'lineNumber', 'canonicalDigest',
    ]) || value.persistence.sourceKind !== 'trusted-fact-repository'
    || !hasText(value.persistence.sourceKey) || !isPositiveInteger(value.persistence.lineNumber)
    || !isSha256Digest(value.persistence.canonicalDigest)) {
    return invalid('invalid-locator', 'Locator is not a valid trusted-fact navigation locator.')
  }
  return valid({
    schemaVersion: NAVIGATION_SCHEMA_VERSION,
    locatorId: value.locatorId,
    persistence: {
      sourceKind: 'trusted-fact-repository',
      sourceKey: value.persistence.sourceKey,
      lineNumber: value.persistence.lineNumber,
      canonicalDigest: value.persistence.canonicalDigest,
    },
  })
}

function validateNavigationItem(value: unknown): ContractValidationResult<NavigationItem> {
  if (!hasExactKeys(value, ['schemaVersion', 'kind', 'origin', 'derivation', 'locator', 'hints'])
    || value.schemaVersion !== NAVIGATION_SCHEMA_VERSION || value.kind !== 'trusted-fact-navigation'
    || value.origin !== 'machine-derived' || !hasExactKeys(value.derivation, ['method', 'version'])
    || !hasText(value.derivation.method) || !hasText(value.derivation.version)
    || !hasExactKeys(value.hints, ['topics', 'targetRefs', 'dimension', 'relations'])
    || !Array.isArray(value.hints.topics) || !Array.isArray(value.hints.targetRefs)
    || !isDimension(value.hints.dimension) || !Array.isArray(value.hints.relations)) {
    return invalid('invalid-navigation', 'Navigation item has an invalid neutral shape.')
  }
  const locatorResult = validateLocator(value.locator)
  if (!locatorResult.ok) return locatorResult
  const targetRefs: NavigationTargetRef[] = []
  for (const targetRef of value.hints.targetRefs) {
    if (!hasExactKeys(targetRef, ['targetId', 'canonicalSource'])
      || !hasText(targetRef.targetId) || !hasText(targetRef.canonicalSource)) {
      return invalid('invalid-navigation', 'Navigation target reference is invalid.')
    }
    targetRefs.push({ targetId: targetRef.targetId, canonicalSource: targetRef.canonicalSource })
  }
  const topics: string[] = []
  for (const topic of value.hints.topics) {
    if (!hasText(topic)) return invalid('invalid-navigation', 'Navigation topics must be non-empty strings.')
    topics.push(topic)
  }
  return valid({
    schemaVersion: NAVIGATION_SCHEMA_VERSION,
    kind: 'trusted-fact-navigation',
    origin: 'machine-derived',
    derivation: { method: value.derivation.method, version: value.derivation.version },
    locator: locatorResult.value,
    hints: {
      topics: Object.freeze(topics),
      targetRefs: Object.freeze(targetRefs),
      dimension: value.hints.dimension,
      relations: value.hints.relations,
    },
  })
}

function validateNeutralNavigation(value: readonly unknown[]): ContractValidationResult<NeutralNavigationInput> {
  if (value.length === 0) return valid(Object.freeze([]) as readonly NavigationItem[])
  const isSegmented = value.every(item => isRecord(item) && item.kind === 'navigation-segment')
  if (isSegmented) {
    const segments: NavigationSegment[] = []
    for (const segment of value) {
      if (!hasExactKeys(segment, ['kind', 'segmentId', 'items']) || segment.kind !== 'navigation-segment'
        || !hasText(segment.segmentId) || !Array.isArray(segment.items)) {
        return invalid('invalid-navigation', 'Navigation segment has an invalid shape.')
      }
      const items: NavigationItem[] = []
      for (const item of segment.items) {
        const itemResult = validateNavigationItem(item)
        if (!itemResult.ok) return itemResult
        items.push(itemResult.value)
      }
      segments.push({ kind: 'navigation-segment', segmentId: segment.segmentId, items: Object.freeze(items) })
    }
    return valid(Object.freeze(segments))
  }

  const items: NavigationItem[] = []
  for (const item of value) {
    const itemResult = validateNavigationItem(item)
    if (!itemResult.ok) return itemResult
    items.push(itemResult.value)
  }
  return valid(Object.freeze(items))
}

function validateNeutralNavigationInput(value: unknown): ContractValidationResult<NeutralNavigationInput> {
  return Array.isArray(value)
    ? validateNeutralNavigation(value)
    : invalid('invalid-navigation', 'Navigation input must be an item collection or segmented collection.')
}

function flattenNavigation(navigation: NeutralNavigationInput): readonly NavigationItem[] {
  if (navigation.length === 0) return []
  if (navigation.every(item => item.kind === 'navigation-segment')) {
    return navigation.flatMap(segment => segment.items)
  }
  return navigation
}

interface AccessRecord {
  readonly snapshot: FrozenProjectionSnapshot
  readonly grants: WeakSet<object>
}

function assertSnapshot(value: unknown): asserts value is FrozenProjectionSnapshot {
  if (!hasExactKeys(value, ['revision']) || !hasText(value.revision) || !Object.isFrozen(value)) {
    throw new TypeError('Projection snapshot must be a frozen object with a revision.')
  }
}

function valid<T>(value: T): ContractValidationSuccess<T> {
  return { ok: true, value }
}

function invalid(code: string, message: string): ContractValidationFailure {
  return { ok: false, code, message }
}

function assertValid<T>(result: ContractValidationResult<T>): T {
  if (!result.ok) throw new TypeError(result.message)
  return result.value
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: unknown, required: readonly string[], ...optional: string[]): value is Record<string, any> {
  if (!isRecord(value)) return false
  const keys = Object.keys(value)
  const allowed = new Set([...required, ...optional])
  return required.every(key => Object.prototype.hasOwnProperty.call(value, key))
    && keys.every(key => allowed.has(key))
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isDimension(value: unknown): value is FactDimension {
  return typeof value === 'string' && factDimensions.includes(value as FactDimension)
}

function isApplicationLevel(value: unknown): value is ApplicationLevel {
  return typeof value === 'string' && applicationLevels.includes(value as ApplicationLevel)
}

function isAssessmentRelevance(value: unknown): value is AssessmentRelevance {
  return value === 'high' || value === 'low_confidence' || value === 'unrelated'
}

function isAssessmentEssentiality(value: unknown): value is AssessmentEssentiality {
  return value === 'inline_priority' || value === 'lookup_only'
}

function isLookupSelectorField(value: unknown): value is LookupSelectorField {
  return typeof value === 'string' && lookupSelectorFields.includes(value as LookupSelectorField)
}

function isProjectionNotReadyCode(value: unknown): value is ProjectionNotReadyCode {
  return value === 'facts-unavailable' || value === 'navigation-unavailable' || value === 'projection-unavailable'
    || value === 'navigation-schema-invalid' || value === 'source-revision-mismatch'
    || value === 'assessment-policy-unavailable' || value === 'limits-unavailable'
    || value === 'projector-unavailable' || value === 'lookup-unavailable'
}

function isProjectionFailureCode(value: unknown): value is ProjectionFailureCode {
  return value === 'invalid-assessment-audit' || value === 'unknown-locator'
    || value === 'ambiguous-locator-set' || value === 'unrepresentable' || value === 'budget-exceeded'
}

function isSha256Digest(value: unknown): value is `sha256:${string}` {
  return typeof value === 'string' && /^sha256:.+$/.test(value)
}

function isValidSelectedLocatorCount(value: unknown): value is number {
  return isPositiveInteger(value)
}

function validLocatorIds(value: unknown): value is readonly string[] {
  if (!Array.isArray(value) || value.length === 0) return false
  const ids = value.filter(hasText)
  return ids.length === value.length && new Set(ids).size === ids.length
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  return left.every((byte, index) => byte === right[index])
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON cannot contain non-finite numbers.')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (!isRecord(value)) throw new TypeError('Canonical JSON received an unsupported value.')
  const entries = Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
  return `{${entries.join(',')}}`
}
