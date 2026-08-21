/**
 * The intentionally small public boundary for trusted-fact projection.
 *
 * The assessment request carries the full navigation as an inner semantic
 * contract.  That does not require TODO6 to put the full navigation into one
 * model request: it may mechanically preselect candidate segments while
 * preserving request-level isolation and returning one explicit decision per
 * locator.
 */

import { createFileProjectionSources } from './file-projection-sources.ts'
import { buildExactFactLookup } from './exact-fact-lookup.ts'
import {
  preflightFactProjection,
  preflightFactProjectionWithAssessmentBinder,
  type AssessmentSnapshotBinder,
  type FactProjectionAssessmentBinderInput,
  type AssessmentReadinessProbe,
  type FactProjectionPreflightResult,
} from './preflight.ts'
import { projectCandidateFacts } from './project-candidate-facts.ts'
import { createProjectionNotReady } from './contracts.ts'
import type {
  AssessmentEssentiality,
  AssessmentRelevance,
  CandidateDescriptor,
  CandidateFactAssessment,
  CandidateFactAssessmentAudit,
  CandidateFactAssessmentPort,
  CandidateFactAssessmentRequest,
  LocatorAssessmentDecision,
  LookupFailure,
  LookupResult,
  LookupSuccess,
  LookupTicket,
  NavigationSegment,
  NeutralNavigationInput,
  ProjectedTrustedFact,
  ProjectionBudget,
  ProjectionFailure,
  ProjectionNotReady,
  ProjectionView,
} from './contracts.ts'
import type { ReadyFactProjectionSession } from './preflight.ts'
import type { ApplicationLevel } from '../trusted-facts/model.ts'

/** Compose the read-only file sources and all four projection use cases. */
export function createFactProjectionPreflight(
  dataDir: string,
  budget: ProjectionBudget,
  assessment: AssessmentReadinessProbe,
): FactProjectionPreflightResult {
  if (typeof dataDir !== 'string' || dataDir.trim() === '') {
    return createProjectionNotReady(
      'projection-unavailable',
      'Fact projection requires an explicit data directory.',
    )
  }

  const sources = createFileProjectionSources(dataDir)
  return preflightFactProjection({
    facts: sources.facts,
    navigation: sources.navigation,
    assessment,
    budget,
    projector: () => projectCandidateFacts,
    lookup: () => buildExactFactLookup,
  })
}

/** Compose file sources with an assessment policy bound to this run's snapshot. */
export function createBoundFactProjectionPreflight(
  dataDir: string,
  budget: ProjectionBudget,
  assessmentBinder: AssessmentSnapshotBinder,
): FactProjectionPreflightResult {
  if (typeof dataDir !== 'string' || dataDir.trim() === '') {
    return createProjectionNotReady(
      'projection-unavailable',
      'Fact projection requires an explicit data directory.',
    )
  }

  const sources = createFileProjectionSources(dataDir)
  return preflightFactProjectionWithAssessmentBinder({
    facts: sources.facts,
    navigation: sources.navigation,
    assessmentBinder,
    budget,
    projector: () => projectCandidateFacts,
    lookup: () => buildExactFactLookup,
  })
}

/**
 * Ticket ids are stable locators, not claims of being unguessable or
 * unforgeable. Exact authorization comes from the private access brand, the
 * in-memory registry grant issued in this run, and the same frozen snapshot.
 */

/** A stable, pure binding used to construct an explicit assessment audit. */
export { fingerprintCandidate, candidateFingerprint } from './project-candidate-facts.ts'

export type {
  ApplicationLevel,
  AssessmentEssentiality,
  AssessmentRelevance,
  CandidateDescriptor,
  CandidateFactAssessment,
  CandidateFactAssessmentAudit,
  CandidateFactAssessmentPort,
  CandidateFactAssessmentRequest,
  LookupFailure,
  LookupResult,
  LookupSuccess,
  LookupTicket,
  NavigationSegment,
  NeutralNavigationInput,
  ProjectedTrustedFact,
  ProjectionBudget,
  ProjectionFailure,
  ProjectionNotReady,
  ProjectionView,
  ReadyFactProjectionSession,
  AssessmentReadinessProbe,
  AssessmentSnapshotBinder,
  FactProjectionAssessmentBinderInput,
  FactProjectionPreflightResult,
}

export { preflightFactProjectionWithAssessmentBinder }

/** Public spelling; the internal contract keeps its historical locator name. */
export type CandidateFactAssessmentDecision = LocatorAssessmentDecision
