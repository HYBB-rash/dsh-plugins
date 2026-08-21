import {
  createProjectionFailure,
  createProjectionNotReady,
  createReadyFactProjectionAccessRegistry,
  validateAssessmentAudit,
  validateProjectionBudget,
  validateProjectionView,
  type CandidateDescriptor,
  type CandidateFactAssessment,
  type CandidateFactAssessmentPort,
  type CandidateFactAssessmentAudit,
  type ExactLookupGrant,
  type FactProjectionAccessRegistry,
  type FrozenProjectionSnapshot,
  type LookupFailure,
  type LookupResult,
  type ProjectionBudget,
  type ProjectionFailure,
  type ProjectionNotReady,
  type ProjectionView,
  type ReadyFactProjectionAccess,
} from './contracts.ts'
import type {
  ExactFactLookup,
  ExactFactLookupBuildInput,
  ExactFactLookupBuildResult,
} from './exact-fact-lookup.ts'
import type {
  ProjectCandidateFactsInput,
  ProjectCandidateFactsResult,
  ProjectionArtifact,
} from './project-candidate-facts.ts'
import {
  pinLocatedSnapshot,
  pinNavigationSnapshot,
  type FactProjectionSnapshotReader,
  type NavigationProjectionSnapshotReader,
} from './file-projection-sources.ts'
import { isTrustedFact } from '../trusted-facts/model.ts'
import type {
  LocatedTrustedFactSnapshot,
  NavigationSnapshot,
  TrustedFactLocator,
} from '../trusted-facts/navigation-contract.ts'

/** Readiness is a probe only; it never exposes the model assessment port. */
export interface AssessmentReadinessProbe {
  checkReadiness(): AssessmentReadiness
}

/** Binds one assessment readiness probe to the exact pinned navigation snapshot. */
export type AssessmentSnapshotBinder = (
  navigation: NavigationSnapshot,
) => AssessmentReadinessProbe

export type AssessmentReadiness =
  | boolean
  | { readonly ready: true }
  | { readonly ready: false; readonly message?: string }

/** Pure function form keeps the composition root independent of S2/S3 classes. */
export type CandidateFactProjector = (
  input: ProjectCandidateFactsInput,
) => ProjectCandidateFactsResult

export type CandidateFactProjectorFactory = () => CandidateFactProjector

export type ExactFactLookupBuilder = (
  input: ExactFactLookupBuildInput,
) => ExactFactLookupBuildResult

export type ExactFactLookupFactory = () => ExactFactLookupBuilder

export interface FactProjectionPreflightInput {
  readonly facts: FactProjectionSnapshotReader
  readonly navigation: NavigationProjectionSnapshotReader
  readonly assessment: AssessmentReadinessProbe
  readonly budget: ProjectionBudget
  readonly projector: CandidateFactProjectorFactory
  readonly lookup: ExactFactLookupFactory
}

export type FactProjectionAssessmentBinderInput = Omit<FactProjectionPreflightInput, 'assessment'> & {
  readonly assessmentBinder: AssessmentSnapshotBinder
}

export type ExplicitCandidateAssessment = CandidateFactAssessment | CandidateFactAssessmentPort

export interface ProjectedFactProjection {
  readonly kind: 'ready'
  readonly view: ProjectionView
  lookup(ticketId: string): LookupResult
}

export type ReadyProjectionCallResult =
  | ProjectedFactProjection
  | ProjectionNotReady
  | ProjectionFailure

export interface ReadyFactProjectionSession {
  project(
    candidate: CandidateDescriptor,
    assessment: ExplicitCandidateAssessment,
  ): ReadyProjectionCallResult
}

export type FactProjectionPreflightResult =
  | { readonly kind: 'ready'; readonly session: ReadyFactProjectionSession }
  | ProjectionNotReady
  | ProjectionFailure

type PinnedSource = {
  readonly facts: LocatedTrustedFactSnapshot
  readonly navigation: NavigationSnapshot
  readonly budget: ProjectionBudget
  readonly snapshot: FrozenProjectionSnapshot
  readonly projector: CandidateFactProjectorFactory
  readonly lookup: ExactFactLookupFactory
}

type ValidatedArtifact = {
  readonly kind: 'valid'
  readonly view: ProjectionView
  readonly audit: CandidateFactAssessmentAudit
  readonly grants: readonly ExactLookupGrant[]
}

/**
 * Check every read-only dependency and then install one process-local session.
 * No access registry or capability is constructed on a not-ready path.
 */
export function preflightFactProjection(
  input: FactProjectionPreflightInput,
): FactProjectionPreflightResult {
  if (!isPreflightInputShape(input)) {
    return createProjectionNotReady(
      'projection-unavailable',
      'Fact projection preflight dependencies are incomplete.',
    )
  }

  const sourceResult = readAndPinSources(input)
  if (sourceResult.kind !== 'ready') return sourceResult

  return completePreflight(sourceResult.value, () => input.assessment)
}

/**
 * Preflight variant for an assessment policy that must be bound to this run's
 * exact, pinned navigation snapshot.  The binder is invoked only after all
 * source, schema, alignment, and budget checks pass.
 */
export function preflightFactProjectionWithAssessmentBinder(
  input: FactProjectionAssessmentBinderInput,
): FactProjectionPreflightResult {
  if (!isAssessmentBinderInputShape(input)) {
    return createProjectionNotReady(
      'projection-unavailable',
      'Fact projection preflight dependencies are incomplete.',
    )
  }

  const sourceResult = readAndPinSources(input)
  if (sourceResult.kind !== 'ready') return sourceResult

  let assessment: unknown
  try {
    assessment = input.assessmentBinder(sourceResult.value.navigation)
  } catch (error) {
    return createProjectionNotReady(
      'assessment-policy-unavailable',
      errorMessage(error, 'Candidate fact assessment policy is unavailable.'),
    )
  }
  if (!isAssessmentReadinessProbe(assessment)) {
    return createProjectionNotReady(
      'assessment-policy-unavailable',
      'Candidate fact assessment policy did not provide a readiness probe.',
    )
  }

  return completePreflight(sourceResult.value, () => assessment)
}

function completePreflight(
  source: PinnedSource,
  assessmentFactory: () => AssessmentReadinessProbe,
): FactProjectionPreflightResult {
  const readiness = checkAssessmentReadiness(assessmentFactory())
  if (readiness.kind !== 'ready') return readiness

  const projectorResult = createProjector(source.projector)
  if (projectorResult.kind !== 'ready') return projectorResult

  const lookupResult = createLookupBuilder(source.lookup)
  if (lookupResult.kind !== 'ready') return lookupResult

  let registry: FactProjectionAccessRegistry
  let access: ReadyFactProjectionAccess
  try {
    registry = createReadyFactProjectionAccessRegistry()
    access = registry.createAccess(source.snapshot)
  } catch (error) {
    return createProjectionNotReady('projection-unavailable', errorMessage(error, 'Fact projection capability is unavailable.'))
  }
  const session = createSession(
    source,
    registry,
    access,
    projectorResult.value,
    lookupResult.value,
  )
  return Object.freeze({ kind: 'ready', session })
}

function readAndPinSources(
  input: Pick<FactProjectionPreflightInput, 'facts' | 'navigation' | 'budget' | 'projector' | 'lookup'>,
): { readonly kind: 'ready'; readonly value: PinnedSource } | ProjectionNotReady {
  let factsValue: unknown
  try {
    factsValue = input.facts.readLocatedSnapshot()
  } catch (error) {
    return createProjectionNotReady('facts-unavailable', errorMessage(error, 'Trusted facts are unavailable.'))
  }

  let navigationValue: unknown
  try {
    navigationValue = input.navigation.readNavigationSnapshot()
  } catch (error) {
    if (isMissingFileError(error)) {
      return createProjectionNotReady('navigation-unavailable', errorMessage(error, 'Trusted-fact navigation is unavailable.'))
    }
    return createProjectionNotReady('navigation-schema-invalid', errorMessage(error, 'Trusted-fact navigation schema is invalid.'))
  }

  let facts: LocatedTrustedFactSnapshot
  try {
    facts = pinLocatedSnapshot(factsValue)
  } catch (error) {
    return createProjectionNotReady('facts-unavailable', errorMessage(error, 'Trusted-fact snapshot is invalid.'))
  }

  let navigation: NavigationSnapshot
  try {
    navigation = pinNavigationSnapshot(navigationValue)
  } catch (error) {
    return createProjectionNotReady('navigation-schema-invalid', errorMessage(error, 'Trusted-fact navigation schema is invalid.'))
  }

  if (facts.sourceRevision !== navigation.sourceRevision) {
    return createProjectionNotReady(
      'source-revision-mismatch',
      'Trusted facts and navigation do not share the same source revision.',
    )
  }

  const alignment = validateSourceAlignment(facts, navigation)
  if (alignment !== undefined) return alignment

  const budgetResult = validateProjectionBudget(input.budget)
  if (!budgetResult.ok) {
    return createProjectionNotReady('limits-unavailable', budgetResult.message)
  }

  return {
    kind: 'ready',
    value: Object.freeze({
      facts,
      navigation,
      budget: Object.freeze(budgetResult.value),
      snapshot: Object.freeze({ revision: facts.sourceRevision }),
      projector: input.projector,
      lookup: input.lookup,
    }),
  }
}

function checkAssessmentReadiness(
  probe: AssessmentReadinessProbe,
): ProjectionNotReady | { readonly kind: 'ready' } {
  try {
    const result = probe.checkReadiness()
    if (isAssessmentReady(result)) return { kind: 'ready' }
    const message = isRecord(result) && hasText(result.message)
      ? result.message
      : 'Candidate fact assessment policy is not ready.'
    return createProjectionNotReady('assessment-policy-unavailable', message)
  } catch (error) {
    return createProjectionNotReady(
      'assessment-policy-unavailable',
      errorMessage(error, 'Candidate fact assessment policy is unavailable.'),
    )
  }
}

function isAssessmentReadinessProbe(value: unknown): value is AssessmentReadinessProbe {
  return isRecord(value) && typeof value.checkReadiness === 'function'
}

function createProjector(
  factory: CandidateFactProjectorFactory,
): { readonly kind: 'ready'; readonly value: CandidateFactProjector } | ProjectionNotReady {
  try {
    const projector = factory()
    if (typeof projector !== 'function') {
      return createProjectionNotReady('projector-unavailable', 'Candidate fact projector is not callable.')
    }
    return { kind: 'ready', value: projector }
  } catch (error) {
    return createProjectionNotReady('projector-unavailable', errorMessage(error, 'Candidate fact projector is unavailable.'))
  }
}

function createLookupBuilder(
  factory: ExactFactLookupFactory,
): { readonly kind: 'ready'; readonly value: ExactFactLookupBuilder } | ProjectionNotReady {
  try {
    const lookup = factory()
    if (typeof lookup !== 'function') {
      return createProjectionNotReady('lookup-unavailable', 'Exact fact lookup is not callable.')
    }
    return { kind: 'ready', value: lookup }
  } catch (error) {
    return createProjectionNotReady('lookup-unavailable', errorMessage(error, 'Exact fact lookup is unavailable.'))
  }
}

function createSession(
  source: PinnedSource,
  registry: FactProjectionAccessRegistry,
  access: ReadyFactProjectionAccess,
  projector: CandidateFactProjector,
  lookupBuilder: ExactFactLookupBuilder,
): ReadyFactProjectionSession {
  const project = (
    candidate: CandidateDescriptor,
    assessment: ExplicitCandidateAssessment,
  ): ReadyProjectionCallResult => {
    if (!isExplicitAssessment(assessment)) {
      return createProjectionFailure(
        'invalid-assessment-audit',
        'An explicit candidate assessment or assessment port is required.',
      )
    }

    let result: ProjectCandidateFactsResult
    try {
      result = projector({
        candidate,
        facts: source.facts,
        navigation: source.navigation,
        budget: source.budget,
        assessment,
      })
    } catch (error) {
      return createProjectionFailure('unrepresentable', errorMessage(error, 'Candidate fact projection failed.'))
    }

    if (isProjectionNotReady(result) || isProjectionFailure(result)) return result
    if (!isProjectionArtifact(result)) {
      return createProjectionFailure('unrepresentable', 'Candidate fact projector returned an invalid artifact.')
    }

    const artifactResult = validateArtifact(result, source.budget, source.snapshot)
    if (artifactResult.kind === 'projection-failure') return artifactResult

    const signedGrants: ExactLookupGrant[] = []
    try {
      for (const grant of artifactResult.grants) {
        signedGrants.push(registry.issueGrant(
          access,
          source.snapshot,
          grant.ticketId,
          grant.locatorIds,
        ))
      }
    } catch (error) {
      return createProjectionFailure('unrepresentable', errorMessage(error, 'Projection grant installation failed.'))
    }

    let lookupResult: ExactFactLookupBuildResult
    try {
      const input: ExactFactLookupBuildInput = {
        facts: source.facts,
        snapshot: source.snapshot,
        registry,
        access,
        grants: Object.freeze(signedGrants),
        audit: artifactResult.audit,
        knownTicketIds: Object.freeze(artifactResult.view.tickets.map(ticket => ticket.ticketId)),
      }
      lookupResult = lookupBuilder(input)
    } catch (error) {
      return createProjectionFailure('unrepresentable', errorMessage(error, 'Exact fact lookup installation failed.'))
    }
    if (isLookupFailure(lookupResult)) {
      return createProjectionFailure('unrepresentable', lookupResult.message)
    }
    if (!isLookupPort(lookupResult)) {
      return createProjectionFailure('unrepresentable', 'Exact fact lookup factory returned an invalid lookup.')
    }

    const lookup = (ticketId: string): LookupResult => {
      try {
        return lookupResult.lookup(access, { ticketId })
      } catch (error) {
        return Object.freeze({
          kind: 'lookup-failure',
          code: 'invalid_access',
          message: errorMessage(error, 'Exact fact lookup failed.'),
        })
      }
    }
    return Object.freeze({ kind: 'ready', view: artifactResult.view, lookup })
  }

  return Object.freeze({ project })
}

function validateArtifact(
  artifact: ProjectionArtifact,
  budget: ProjectionBudget,
  snapshot: FrozenProjectionSnapshot,
): ProjectionFailure | ValidatedArtifact {
  const viewResult = validateProjectionView(artifact.view, budget)
  if (!viewResult.ok) return createProjectionFailure('unrepresentable', viewResult.message)
  const auditResult = validateAssessmentAudit(artifact.audit)
  if (!auditResult.ok) return createProjectionFailure('invalid-assessment-audit', auditResult.message)
  if (!Array.isArray(artifact.grants) || artifact.grants.length !== viewResult.value.tickets.length) {
    return createProjectionFailure('unrepresentable', 'Projection tickets and grants must have identical counts.')
  }

  const ticketIds = new Set<string>()
  const grantedLocators = new Set<string>()
  const grants: ExactLookupGrant[] = []
  for (const [index, value] of artifact.grants.entries()) {
    if (!isExactLookupGrant(value) || ticketIds.has(value.ticketId)) {
      return createProjectionFailure('unrepresentable', 'Projection grants must be explicit and unique.')
    }
    const ticket = viewResult.value.tickets[index]
    if (ticket === undefined || ticket.ticketId !== value.ticketId) {
      return createProjectionFailure('unrepresentable', 'Projection tickets and grants must have identical ids.')
    }
    if (ticket.selectedLocatorCount !== value.locatorIds.length
      || !value.locatorIds.includes(ticket.locator.locatorId)
      || value.locatorIds.some(locatorId => grantedLocators.has(locatorId))) {
      return createProjectionFailure('unrepresentable', 'Projection tickets and grants must describe disjoint exact locators.')
    }
    if (value.snapshotRevision !== snapshot.revision) {
      return createProjectionFailure('unrepresentable', 'Projection grant revision does not match the pinned snapshot.')
    }
    ticketIds.add(value.ticketId)
    for (const locatorId of value.locatorIds) grantedLocators.add(locatorId)
    grants.push(Object.freeze({
      ticketId: value.ticketId,
      locatorIds: Object.freeze([...value.locatorIds]),
      snapshotRevision: value.snapshotRevision,
    }))
  }
  return { kind: 'valid', view: viewResult.value, audit: auditResult.value, grants: Object.freeze(grants) }
}

function validateSourceAlignment(
  facts: LocatedTrustedFactSnapshot,
  navigation: NavigationSnapshot,
): ProjectionNotReady | undefined {
  const factsByLocator = new Map<string, LocatedTrustedFactSnapshot['facts'][number]>()
  for (const located of facts.facts) {
    if (factsByLocator.has(located.locator.locatorId)) {
      return createProjectionNotReady('facts-unavailable', 'Trusted-fact snapshot contains duplicate locators.')
    }
    if (!isTrustedFact(located.fact)) {
      return createProjectionNotReady('facts-unavailable', 'Trusted-fact snapshot contains an untrusted value.')
    }
    factsByLocator.set(located.locator.locatorId, located)
  }

  const navigationIds = new Set<string>()
  for (const item of navigation.items) {
    const locatorId = item.locator.locatorId
    if (navigationIds.has(locatorId)) {
      return createProjectionNotReady('navigation-schema-invalid', 'Navigation contains duplicate locators.')
    }
    navigationIds.add(locatorId)
    const located = factsByLocator.get(locatorId)
    if (located === undefined || !sameLocator(located.locator, item.locator)) {
      return createProjectionNotReady('navigation-schema-invalid', 'Navigation locators do not match trusted facts.')
    }
    const targetRef = item.hints.targetRefs.length === 1 ? item.hints.targetRefs[0] : undefined
    if (targetRef === undefined
      || targetRef.targetId !== located.fact.target.id
      || targetRef.canonicalSource !== located.fact.target.source
      || item.hints.dimension !== located.fact.dimension) {
      return createProjectionNotReady(
        'navigation-schema-invalid',
        'Navigation target references or dimensions do not match trusted facts.',
      )
    }
  }

  if (navigationIds.size !== factsByLocator.size) {
    return createProjectionNotReady('navigation-schema-invalid', 'Navigation must contain exactly one item per trusted fact.')
  }
  for (const locatorId of factsByLocator.keys()) {
    if (!navigationIds.has(locatorId)) {
      return createProjectionNotReady('navigation-schema-invalid', 'Navigation is missing a trusted-fact locator.')
    }
  }
  return undefined
}

function sameLocator(left: TrustedFactLocator, right: TrustedFactLocator): boolean {
  return left.schemaVersion === right.schemaVersion
    && left.locatorId === right.locatorId
    && left.persistence.sourceKind === right.persistence.sourceKind
    && left.persistence.sourceKey === right.persistence.sourceKey
    && left.persistence.lineNumber === right.persistence.lineNumber
    && left.persistence.canonicalDigest === right.persistence.canonicalDigest
}

function isProjectionArtifact(value: ProjectCandidateFactsResult): value is ProjectionArtifact {
  return hasExactKeys(value, ['view', 'audit', 'grants'])
}

function isProjectionNotReady(value: ProjectCandidateFactsResult): value is ProjectionNotReady {
  return hasExactKeys(value, ['kind', 'code', 'message'])
    && (value as { readonly kind: unknown }).kind === 'not-ready'
}

function isProjectionFailure(value: ProjectCandidateFactsResult): value is ProjectionFailure {
  return isRecord(value)
    && hasRequiredKeys(value, ['kind', 'code', 'message'], ['locatorIds'])
    && (value as { readonly kind: unknown }).kind === 'projection-failure'
}

function isLookupFailure(value: ExactFactLookupBuildResult): value is LookupFailure {
  return isRecord(value) && (value as { readonly kind?: unknown }).kind === 'lookup-failure'
}

function isLookupPort(value: ExactFactLookupBuildResult): value is ExactFactLookup {
  return isRecord(value) && typeof (value as { readonly lookup?: unknown }).lookup === 'function'
}

function isExactLookupGrant(value: unknown): value is ExactLookupGrant {
  return isRecord(value)
    && Object.keys(value).length === 3
    && hasText(value.ticketId)
    && isSha256Digest(value.snapshotRevision)
    && Array.isArray(value.locatorIds)
    && value.locatorIds.length > 0
    && value.locatorIds.every(hasText)
    && new Set(value.locatorIds).size === value.locatorIds.length
}

function isExplicitAssessment(value: unknown): value is ExplicitCandidateAssessment {
  if (!isRecord(value)) return false
  if (typeof value.assess === 'function') return true
  return 'candidate' in value && 'audit' in value
}

function isAssessmentReady(value: unknown): value is true | { readonly ready: true } {
  return value === true || (isRecord(value) && value.ready === true)
}

function isPreflightInputShape(value: unknown): value is FactProjectionPreflightInput {
  return hasExactKeys(value, ['facts', 'navigation', 'assessment', 'budget', 'projector', 'lookup'])
    && isRecord(value.facts) && typeof value.facts.readLocatedSnapshot === 'function'
    && isRecord(value.navigation) && typeof value.navigation.readNavigationSnapshot === 'function'
    && isRecord(value.assessment) && typeof value.assessment.checkReadiness === 'function'
    && typeof value.projector === 'function'
    && typeof value.lookup === 'function'
    && isRecord(value.budget)
}

function isAssessmentBinderInputShape(value: unknown): value is FactProjectionAssessmentBinderInput {
  return hasExactKeys(value, ['facts', 'navigation', 'assessmentBinder', 'budget', 'projector', 'lookup'])
    && isRecord(value.facts) && typeof value.facts.readLocatedSnapshot === 'function'
    && isRecord(value.navigation) && typeof value.navigation.readNavigationSnapshot === 'function'
    && typeof value.assessmentBinder === 'function'
    && typeof value.projector === 'function'
    && typeof value.lookup === 'function'
    && isRecord(value.budget)
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT'
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && hasText(error.message) ? error.message : fallback
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

function hasExactKeys(value: unknown, expected: readonly string[]): value is Record<string, any> {
  if (!isRecord(value)) return false
  const keys = Object.keys(value)
  return keys.length === expected.length && expected.every(key => keys.includes(key))
}

function hasRequiredKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
): value is Record<string, any> {
  if (!isRecord(value)) return false
  const keys = Object.keys(value)
  return required.every(key => keys.includes(key))
    && keys.every(key => required.includes(key) || optional.includes(key))
}
