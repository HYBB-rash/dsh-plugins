import {
  isTrustedFact,
  type ApplicationLevel,
  type FactDimension,
  type FactEvidence,
  type FactTarget,
  type TrustedFact,
} from '../trusted-facts/model.ts'
import type { FeedbackState } from '../trusted-facts/feedback-session.ts'

/** A mechanically collected target from the current message or its reference. */
export interface FeedbackTarget extends FactTarget {}

export interface FeedbackCurrentMessage {
  readonly id: number
  readonly text: string
  readonly targets: readonly FeedbackTarget[]
}

export interface FeedbackReferenceMessage {
  readonly messageId?: number
  readonly text: string
  readonly targets: readonly FeedbackTarget[]
}

/** Mechanical target catalog; it has no semantic selection result. */
export interface FeedbackTargetCatalog {
  readonly currentMessage: readonly FeedbackTarget[]
  readonly reference: readonly FeedbackTarget[]
}

/** Pending state is the exact non-idle part of TODO 1's state machine. */
export type FeedbackPending = Exclude<FeedbackState, { readonly kind: 'idle' }>

export interface SerializedTrustedFact {
  readonly target: FeedbackTarget
  readonly dimension: FactDimension
  readonly reason: string
  readonly applicationLevel: ApplicationLevel
  readonly evidence: FactEvidence
}

export type SerializedTrustedFactsByTarget = Readonly<Record<string, readonly SerializedTrustedFact[]>>

/** The bounded material available to one short-lived interaction. */
export interface CleanFeedbackRequest {
  readonly currentMessage: FeedbackCurrentMessage
  readonly reference?: FeedbackReferenceMessage
  readonly targetCatalog: FeedbackTargetCatalog
  readonly pending?: FeedbackPending
  readonly trustedFactsByTarget: SerializedTrustedFactsByTarget
}

export type FeedbackInterpretation =
  | { readonly kind: 'pass'; readonly reason: 'ordinary' | 'not_feedback' | 'mixed_intent' | 'target_ambiguous' }
  | { readonly kind: 'operation'; readonly operation: 'save' | 'unsave'; readonly targetId: string }
  | {
      readonly kind: 'rating'
      readonly sentiment: 'like' | 'dislike'
      readonly targetId: string
      readonly dimension: FactDimension
      readonly reason?: string
    }
  | { readonly kind: 'reason_answer'; readonly reason: string }
  | { readonly kind: 'prior_reason_reference'; readonly targetId: string; readonly dimension: FactDimension }
  | {
      readonly kind: 'candidate_reason'
      readonly sentiment: 'like' | 'dislike'
      readonly targetId: string
      readonly dimension: FactDimension
      readonly candidate: string
    }
  | { readonly kind: 'confirm_candidate'; readonly confirmation: string }
  | { readonly kind: 'abandon_pending' }

/** Convert a TODO 1 factory product into the transport-safe fact projection. */
export function serializeTrustedFact(value: TrustedFact): SerializedTrustedFact {
  if (!isTrustedFact(value)) throw new TypeError('value is not a trusted fact')
  return {
    target: { ...value.target },
    dimension: value.dimension,
    reason: value.reason,
    applicationLevel: value.applicationLevel,
    evidence: { ...value.evidence },
  }
}

/** Serialize only factory-validated facts; no arbitrary object is accepted. */
export function serializeTrustedFacts(values: readonly TrustedFact[]): readonly SerializedTrustedFact[] {
  return values.map(serializeTrustedFact)
}

/** Group only factory-validated facts by their stable target id. */
export function serializeTrustedFactsByTarget(values: readonly TrustedFact[]): SerializedTrustedFactsByTarget {
  const grouped: Record<string, SerializedTrustedFact[]> = {}
  for (const fact of values) {
    const serialized = serializeTrustedFact(fact)
    const existing = grouped[serialized.target.id]
    if (existing === undefined) grouped[serialized.target.id] = [serialized]
    else existing.push(serialized)
  }
  return grouped
}
