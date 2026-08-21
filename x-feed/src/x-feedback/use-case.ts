import {
  reduceFeedback,
  type FeedbackDecision,
  type FeedbackEffect,
  type FeedbackSignal,
} from '../trusted-facts/feedback-session.ts'
import type { FactTarget } from '../trusted-facts/model.ts'
import type {
  CleanFeedbackRequest,
  FeedbackPending,
  FeedbackInterpretation,
  FeedbackTarget,
} from './contract.ts'
import type { PendingStore } from './pending-store.ts'

export interface FeedbackUseCaseInput {
  readonly conversationKey: string
  readonly request: CleanFeedbackRequest
  readonly interpretation: FeedbackInterpretation
}

export type FeedbackUseCaseResult =
  | CompletedFeedbackResult
  | AwaitingReasonFeedbackResult
  | AwaitingCandidateFeedbackResult
  | DiscardedFeedbackResult
  | PassFeedbackResult
  | FailedFeedbackResult

export type DecisionFeedbackResult =
  | CompletedFeedbackResult
  | AwaitingReasonFeedbackResult
  | AwaitingCandidateFeedbackResult
  | DiscardedFeedbackResult

interface DecisionResultFields {
  readonly decision: Exclude<FeedbackDecision, { readonly kind: 'failed' }>
  readonly effects: readonly FeedbackEffect[]
  readonly reply: string
}

export interface CompletedFeedbackResult extends DecisionResultFields {
  readonly kind: 'completed'
  readonly decision: Extract<FeedbackDecision, { readonly kind: 'completed' }>
}

export interface AwaitingReasonFeedbackResult extends DecisionResultFields {
  readonly kind: 'awaiting_reason'
  readonly decision: Extract<FeedbackDecision, { readonly kind: 'awaiting_reason' }>
}

export interface AwaitingCandidateFeedbackResult extends DecisionResultFields {
  readonly kind: 'awaiting_candidate_confirmation'
  readonly decision: Extract<FeedbackDecision, { readonly kind: 'awaiting_candidate_confirmation' }>
}

export interface DiscardedFeedbackResult extends DecisionResultFields {
  readonly kind: 'discarded'
  readonly decision: Extract<FeedbackDecision, { readonly kind: 'discarded' }>
}

export interface PassFeedbackResult {
  readonly kind: 'pass'
  readonly reason: Extract<FeedbackInterpretation, { readonly kind: 'pass' }>['reason']
  readonly effects: readonly []
}

export type FeedbackUseCaseFailureCode =
  | 'invalid_target'
  | 'target_not_found'
  | 'target_ambiguous'
  | 'invalid_transition'
  | 'fact_rejected'

export interface FailedFeedbackResult {
  readonly kind: 'failure'
  readonly code: FeedbackUseCaseFailureCode
  readonly message: string
  readonly effects: readonly []
}

const noEffects = [] as const
const askForReasonReply = '你愿意具体说说为什么吗？'
const feedbackRecordedReply = '已记录这次反馈。'
const feedbackDiscardedReply = '这次反馈不记录。'

/** Application boundary for one clean, bounded X feedback interaction. */
export class FeedbackUseCase {
  constructor(private readonly pendingStore: PendingStore) {}

  execute(input: FeedbackUseCaseInput): FeedbackUseCaseResult {
    const pending = this.currentPending(input)
    const interpretation = input.interpretation

    if (interpretation.kind === 'pass') return this.pass(input.conversationKey, interpretation.reason, pending)
    if (interpretation.kind === 'reason_answer') return this.answerReason(input, pending)
    if (interpretation.kind === 'confirm_candidate') return this.confirmCandidate(input, pending)
    if (interpretation.kind === 'abandon_pending') return this.abandon(input.conversationKey, pending)

    const targetResult = this.resolveTarget(input.request, interpretation, pending)
    if (!targetResult.ok) return targetResult.result

    const signal = this.toFreshSignal(input.request, interpretation, targetResult.target)
    return this.reduceAndStore(input.conversationKey, signal, pending)
  }

  private currentPending(input: FeedbackUseCaseInput): FeedbackPending | undefined {
    return this.pendingStore.get(input.conversationKey) ?? input.request.pending
  }

  private pass(
    conversationKey: string,
    reason: PassFeedbackResult['reason'],
    pending: FeedbackPending | undefined,
  ): PassFeedbackResult | FailedFeedbackResult {
    if (pending !== undefined) {
      const decision = reduceFeedback(pending, { kind: 'no_answer' }) as Extract<FeedbackDecision, { readonly kind: 'discarded' }>
      if (decision.kind !== 'discarded') return this.failure('invalid_transition', '待处理反馈未能结束。')
      this.pendingStore.clear(conversationKey)
    }
    this.pendingStore.clear(conversationKey)
    return { kind: 'pass', reason, effects: noEffects }
  }

  private abandon(
    conversationKey: string,
    pending: FeedbackPending | undefined,
  ): DiscardedFeedbackResult | FailedFeedbackResult {
    if (pending === undefined) return this.invalidTransition('当前没有可放弃的待处理反馈。')
    const decision = reduceFeedback(pending, { kind: 'abandon' }) as Extract<FeedbackDecision, { readonly kind: 'discarded' }>
    this.pendingStore.clear(conversationKey)
    return { kind: 'discarded', decision, effects: decision.effects, reply: feedbackDiscardedReply }
  }

  private answerReason(
    input: FeedbackUseCaseInput,
    pending: FeedbackPending | undefined,
  ): FeedbackUseCaseResult {
    if (pending?.kind !== 'awaiting_reason') return this.invalidTransition('当前没有等待理由的反馈。')
    const signal: FeedbackSignal = {
      kind: pending.sentiment,
      target: pending.target,
      dimension: pending.dimension,
      reason: input.interpretation.kind === 'reason_answer' ? input.interpretation.reason : '',
      rawUserExpression: combineExpressions(pending.rawUserExpression, input.request.currentMessage.text),
    }
    return this.reduceAndStore(input.conversationKey, signal, pending)
  }

  private confirmCandidate(
    input: FeedbackUseCaseInput,
    pending: FeedbackPending | undefined,
  ): FeedbackUseCaseResult {
    if (pending?.kind !== 'awaiting_candidate_confirmation') {
      return this.invalidTransition('当前没有等待确认的候选理由。')
    }
    const decision = reduceFeedback(pending, {
      kind: 'confirm_candidate',
      confirmation: input.interpretation.kind === 'confirm_candidate' ? input.interpretation.confirmation : '',
    })
    return this.storeDecision(input.conversationKey, decision)
  }

  private resolveTarget(
    request: CleanFeedbackRequest,
    interpretation: TargetedInterpretation,
    pending: FeedbackPending | undefined,
  ): { readonly ok: true; readonly target: FeedbackTarget } | { readonly ok: false; readonly result: FailedFeedbackResult } {
    const targetId = 'targetId' in interpretation ? interpretation.targetId : undefined
    if (typeof targetId !== 'string' || targetId.trim() === '') {
      return { ok: false, result: this.failure('invalid_target', '目标 id 不能为空。') }
    }
    const catalog = [...request.targetCatalog.currentMessage, ...request.targetCatalog.reference]
    if (catalog.some(target => !hasValidTarget(target))) {
      return { ok: false, result: this.failure('invalid_target', '目标内容不能为空。') }
    }
    const matches = findCatalogTargets(catalog, targetId)
    if (matches.length > 1) return { ok: false, result: this.failure('target_ambiguous', '目标无法唯一定位。') }
    const catalogTarget = matches[0]
    if (pending !== undefined && !hasValidTarget(pending.target)) {
      return { ok: false, result: this.failure('invalid_target', '目标内容不能为空。') }
    }
    const pendingTarget = pending !== undefined && pending.target.id === targetId ? pending.target : undefined
    if (catalogTarget === undefined && pendingTarget === undefined) {
      return { ok: false, result: this.failure('target_not_found', '目标无法唯一定位。') }
    }
    if (catalogTarget === undefined) {
      if (!hasValidTarget(pendingTarget)) return { ok: false, result: this.failure('invalid_target', '目标内容不能为空。') }
      return { ok: true, target: pendingTarget }
    }
    if (pendingTarget !== undefined && !sameTarget(catalogTarget, pendingTarget)) {
      return { ok: false, result: this.failure('target_ambiguous', '目标无法唯一定位。') }
    }
    return { ok: true, target: catalogTarget }
  }

  private toFreshSignal(
    request: CleanFeedbackRequest,
    interpretation: TargetedInterpretation,
    target: FactTarget,
  ): FeedbackSignal {
    if (interpretation.kind === 'operation') {
      return { kind: interpretation.operation, target }
    }
    if (interpretation.kind === 'rating') {
      return {
        kind: interpretation.sentiment,
        target,
        dimension: interpretation.dimension,
        rawUserExpression: request.currentMessage.text,
        ...(interpretation.reason === undefined ? {} : { reason: interpretation.reason }),
      }
    }
    if (interpretation.kind === 'prior_reason_reference') {
      return {
        kind: 'prior_reason_reference',
        target,
        dimension: interpretation.dimension,
        rawUserExpression: request.currentMessage.text,
      }
    }
    return {
      kind: 'candidate_reason',
      sentiment: interpretation.sentiment,
      target,
      dimension: interpretation.dimension,
      rawUserExpression: request.currentMessage.text,
      candidate: interpretation.candidate,
    }
  }

  private reduceAndStore(
    conversationKey: string,
    signal: FeedbackSignal,
    pending: FeedbackPending | undefined,
  ): FeedbackUseCaseResult {
    const decision = reduceFeedback(pending ?? { kind: 'idle' }, signal)
    return this.storeDecision(conversationKey, decision)
  }

  private storeDecision(conversationKey: string, decision: FeedbackDecision): FeedbackUseCaseResult {
    if (decision.kind === 'awaiting_reason' || decision.kind === 'awaiting_candidate_confirmation') {
      this.pendingStore.set(conversationKey, decision.state)
    } else {
      this.pendingStore.clear(conversationKey)
    }
    return this.renderDecision(decision)
  }

  private renderDecision(decision: FeedbackDecision, reply?: string): FeedbackUseCaseResult {
    if (decision.kind === 'failed') {
      const code = decision.code === 'fact_rejected' ? 'fact_rejected' : 'invalid_transition'
      return this.failure(code, decision.message)
    }
    if (decision.kind === 'awaiting_reason') {
      return { kind: 'awaiting_reason', decision, effects: decision.effects, reply: reply ?? askForReasonReply }
    }
    if (decision.kind === 'awaiting_candidate_confirmation') {
      return {
        kind: 'awaiting_candidate_confirmation',
        decision,
        effects: decision.effects,
        reply: reply ?? `我猜理由是“${decision.state.candidate}”，对吗？`,
      }
    }
    if (decision.kind === 'discarded') {
      return { kind: 'discarded', decision, effects: decision.effects, reply: reply ?? feedbackDiscardedReply }
    }
    return { kind: 'completed', decision, effects: decision.effects, reply: reply ?? feedbackRecordedReply }
  }

  private invalidTransition(message: string): FailedFeedbackResult {
    return this.failure('invalid_transition', message)
  }

  private failure(code: FeedbackUseCaseFailureCode, message: string): FailedFeedbackResult {
    return { kind: 'failure', code, message, effects: noEffects }
  }
}

type TargetedInterpretation =
  | Extract<FeedbackInterpretation, { readonly kind: 'operation' }>
  | Extract<FeedbackInterpretation, { readonly kind: 'rating' }>
  | Extract<FeedbackInterpretation, { readonly kind: 'prior_reason_reference' }>
  | Extract<FeedbackInterpretation, { readonly kind: 'candidate_reason' }>

function combineExpressions(original: string, answer: string): string {
  return `原始评价：${original}\n当前回答：${answer}`
}

function hasValidTarget(target: unknown): target is FeedbackTarget {
  if (typeof target !== 'object' || target === null) return false
  const candidate = target as Partial<FeedbackTarget>
  return [candidate.id, candidate.content, candidate.source, candidate.scope]
    .every(value => typeof value === 'string' && value.trim() !== '')
}

function sameTarget(left: FeedbackTarget, right: FeedbackTarget): boolean {
  return left.id === right.id
    && left.content === right.content
    && left.source === right.source
    && left.scope === right.scope
}

function findCatalogTargets(catalog: readonly FeedbackTarget[], targetId: string): readonly FeedbackTarget[] {
  return catalog.filter(target => target.id === targetId)
}

export function executeFeedback(
  input: FeedbackUseCaseInput,
  pendingStore: PendingStore,
): FeedbackUseCaseResult {
  return new FeedbackUseCase(pendingStore).execute(input)
}
