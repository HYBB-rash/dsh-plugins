import {
  createTrustedFact,
  type FactDimension,
  type FactTarget,
  type TrustedFact,
} from './model.ts'

export type FeedbackSentiment = 'like' | 'dislike'

export type FeedbackState =
  | { readonly kind: 'idle' }
  | AwaitingReasonState
  | AwaitingCandidateConfirmationState

export type AwaitingReasonState = {
  readonly kind: 'awaiting_reason'
  readonly target: FactTarget
  readonly dimension: FactDimension
  readonly sentiment: FeedbackSentiment
  readonly rawUserExpression: string
}

export type AwaitingCandidateConfirmationState = {
  readonly kind: 'awaiting_candidate_confirmation'
  readonly target: FactTarget
  readonly dimension: FactDimension
  readonly sentiment: FeedbackSentiment
  readonly rawUserExpression: string
  readonly candidate: string
}

export type FeedbackSignal =
  | { readonly kind: 'save'; readonly target: FactTarget }
  | { readonly kind: 'unsave'; readonly target: FactTarget }
  | RatingSignal
  | CandidateReasonSignal
  | PriorReasonReferenceSignal
  | { readonly kind: 'confirm_candidate'; readonly confirmation: string }
  | { readonly kind: 'abandon' }
  | { readonly kind: 'no_answer' }

export type RatingSignal = {
  readonly kind: FeedbackSentiment
  readonly target: FactTarget
  readonly dimension: FactDimension
  readonly rawUserExpression: string
  readonly reason?: string
}

export type CandidateReasonSignal = {
  readonly kind: 'candidate_reason'
  readonly sentiment: FeedbackSentiment
  readonly target: FactTarget
  readonly dimension: FactDimension
  readonly rawUserExpression: string
  readonly candidate: string
}

export type PriorReasonReferenceSignal = {
  readonly kind: 'prior_reason_reference'
  readonly target: FactTarget
  readonly dimension: FactDimension
  readonly rawUserExpression: string
  readonly priorReasons?: readonly string[]
}

export type FeedbackEffect =
  | {
      readonly kind: 'record_operation'
      readonly operation: 'save' | 'unsave'
      readonly target: FactTarget
    }
  | { readonly kind: 'append_trusted_fact'; readonly fact: TrustedFact }

export type FeedbackDecision =
  | CompletedDecision
  | AwaitingReasonDecision
  | AwaitingCandidateConfirmationDecision
  | DiscardedDecision
  | FailedDecision

export type CompletedDecision = {
  readonly kind: 'completed'
  readonly state: { readonly kind: 'idle' }
  readonly effects: readonly FeedbackEffect[]
}

export type AwaitingReasonDecision = {
  readonly kind: 'awaiting_reason'
  readonly ask: 'ask_for_reason'
  readonly state: AwaitingReasonState
  readonly effects: readonly []
}

export type AwaitingCandidateConfirmationDecision = {
  readonly kind: 'awaiting_candidate_confirmation'
  readonly ask: 'confirm_candidate'
  readonly state: AwaitingCandidateConfirmationState
  readonly effects: readonly []
}

export type DiscardedDecision = {
  readonly kind: 'discarded'
  readonly state: { readonly kind: 'idle' }
  readonly effects: readonly []
}

export type FeedbackFailureCode = 'fact_rejected' | 'invalid_transition'

export type FailedDecision = {
  readonly kind: 'failed'
  readonly code: FeedbackFailureCode
  readonly message: string
  readonly state: { readonly kind: 'idle' }
  readonly effects: readonly []
}

export function reduceFeedback(state: FeedbackState, signal: FeedbackSignal): FeedbackDecision {
  if (signal.kind === 'save' || signal.kind === 'unsave') {
    return completedWithOperation(signal.kind, signal.target)
  }

  if (signal.kind === 'abandon' || signal.kind === 'no_answer') {
    return discarded()
  }

  if (signal.kind === 'confirm_candidate') {
    return confirmCandidate(state, signal.confirmation)
  }

  if (signal.kind === 'candidate_reason') {
    return awaitCandidateConfirmation(signal)
  }

  if (signal.kind === 'prior_reason_reference') {
    return awaitReason({
      kind: 'awaiting_reason',
      target: signal.target,
      dimension: signal.dimension,
      sentiment: 'dislike',
      rawUserExpression: signal.rawUserExpression,
    })
  }

  return handleRating(signal)
}

function handleRating(signal: RatingSignal): FeedbackDecision {
  if (signal.reason === undefined) {
    return awaitReason({
      kind: 'awaiting_reason',
      target: signal.target,
      dimension: signal.dimension,
      sentiment: signal.kind,
      rawUserExpression: signal.rawUserExpression,
    })
  }

  return appendDirectObservation(signal)
}

function appendDirectObservation(signal: RatingSignal): FeedbackDecision {
  return appendFact({
    target: signal.target,
    dimension: signal.dimension,
    reason: signal.reason,
    evidence: {
      kind: 'user_direct',
      rawUserExpression: signal.rawUserExpression,
    },
  })
}

function confirmCandidate(state: FeedbackState, confirmation: string): FeedbackDecision {
  if (state.kind !== 'awaiting_candidate_confirmation') {
    return failure('invalid_transition', '当前没有等待确认的候选理由。')
  }

  return appendFact({
    target: state.target,
    dimension: state.dimension,
    reason: state.candidate,
    evidence: {
      kind: 'user_confirmed_candidate',
      rawUserExpression: state.rawUserExpression,
      candidate: state.candidate,
      confirmation,
    },
  })
}

function appendFact(input: unknown): FeedbackDecision {
  try {
    const result = createTrustedFact(input)
    if (!result.ok) return failure('fact_rejected', `可信事实未生成：${result.message}`)
    return {
      kind: 'completed',
      state: { kind: 'idle' },
      effects: [{ kind: 'append_trusted_fact', fact: result.fact }],
    }
  } catch {
    return failure('fact_rejected', '可信事实未生成：事实工厂发生未知错误。')
  }
}

function completedWithOperation(
  operation: 'save' | 'unsave',
  target: FactTarget,
): CompletedDecision {
  return {
    kind: 'completed',
    state: { kind: 'idle' },
    effects: [{ kind: 'record_operation', operation, target }],
  }
}

function awaitReason(state: AwaitingReasonState): AwaitingReasonDecision {
  return {
    kind: 'awaiting_reason',
    ask: 'ask_for_reason',
    state,
    effects: [],
  }
}

function awaitCandidateConfirmation(
  signal: CandidateReasonSignal,
): AwaitingCandidateConfirmationDecision {
  return {
    kind: 'awaiting_candidate_confirmation',
    ask: 'confirm_candidate',
    state: {
      kind: 'awaiting_candidate_confirmation',
      target: signal.target,
      dimension: signal.dimension,
      sentiment: signal.sentiment,
      rawUserExpression: signal.rawUserExpression,
      candidate: signal.candidate,
    },
    effects: [],
  }
}

function discarded(): DiscardedDecision {
  return { kind: 'discarded', state: { kind: 'idle' }, effects: [] }
}

function failure(code: FeedbackFailureCode, message: string): FailedDecision {
  return { kind: 'failed', code, message, state: { kind: 'idle' }, effects: [] }
}
