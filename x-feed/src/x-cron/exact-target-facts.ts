import {
  createProjectionFailure,
  type CandidateDescriptor,
  type CandidateFactAssessment,
  type ProjectionBudget,
  type ProjectionFailure,
  type ProjectionNotReady,
} from '../fact-projection/contracts.ts'
import {
  fingerprintCandidate,
  projectCandidateFacts,
  type ProjectionArtifact,
} from '../fact-projection/project-candidate-facts.ts'
import { createCandidateNavigationRecall } from './navigation-recall.ts'
import type {
  LocatedTrustedFactSnapshot,
  NavigationSnapshot,
  Sha256Digest,
} from '../trusted-facts/navigation-contract.ts'

/** The bounded budget used by the exact-target bridge. */
export const EXACT_TARGET_PROJECTION_BUDGET: ProjectionBudget = Object.freeze({
  maxInlineFacts: 6,
  maxLookupTickets: 6,
  maxSerializedBytes: 16_000,
})

export interface ExactTargetFactsInput {
  readonly candidate: CandidateDescriptor
  readonly facts: LocatedTrustedFactSnapshot
  readonly navigation: NavigationSnapshot
  readonly budget?: ProjectionBudget
}

export type ExactTargetFactsResult = ProjectionArtifact | ProjectionNotReady | ProjectionFailure

export type ExactTargetAssessmentResult = CandidateFactAssessment | ProjectionFailure

/** Build the frozen mechanical assessment for one pinned exact-target navigation snapshot. */
export function createExactTargetAssessment(input: {
  readonly candidate: CandidateDescriptor
  readonly navigation: NavigationSnapshot
}): ExactTargetAssessmentResult {
  const built = createCandidateNavigationRecall(input.navigation)
  if (built.kind !== 'ready') return createProjectionFailure('unrepresentable', built.message)

  const sourceRevision = input.navigation.sourceRevision as Sha256Digest
  const recalled = built.index.recall({
    sourceRevision,
    targetIds: [input.candidate.id],
    canonicalSources: [input.candidate.source],
    topics: [],
    relationKeys: [`about-target:${input.candidate.id}`],
    dimensions: [],
  })
  if (recalled.kind !== 'recalled') return createProjectionFailure('unrepresentable', recalled.message)

  const matched = new Set(recalled.locatorIds)
  const decisions = Object.freeze(input.navigation.items.map((item, index) => Object.freeze({
    locatorId: item.locator.locatorId,
    relevance: matched.has(item.locator.locatorId) ? 'high' as const : 'unrelated' as const,
    essentiality: matched.has(item.locator.locatorId) ? 'inline_priority' as const : 'lookup_only' as const,
    priority: matched.has(item.locator.locatorId) ? 0 : index + 1,
    reason: matched.has(item.locator.locatorId)
      ? 'exact candidate target/source/about-target match'
      : 'no exact candidate target/source/about-target match',
  })))
  const audit = Object.freeze({
    policyId: 'x-cron-exact-target',
    policyVersion: '1',
    candidateFingerprint: fingerprintCandidate(input.candidate),
    decisions,
  })
  return Object.freeze({
    candidate: input.candidate,
    audit,
  })
}

/**
 * Project trusted facts for one current candidate using only exact neutral
 * target/source/relation keys. No topic, dimension, body, Agent, or LLM path
 * is involved in this bridge.
 */
export function buildExactTargetFacts(input: ExactTargetFactsInput): ExactTargetFactsResult {
  const assessment = createExactTargetAssessment({ candidate: input.candidate, navigation: input.navigation })
  if ('kind' in assessment) return assessment

  return projectCandidateFacts({
    candidate: input.candidate,
    facts: input.facts,
    navigation: input.navigation,
    budget: input.budget ?? EXACT_TARGET_PROJECTION_BUDGET,
    assessment,
  })
}

/** Descriptive alias for callers that prefer the operation name. */
export const projectExactTargetFacts = buildExactTargetFacts
