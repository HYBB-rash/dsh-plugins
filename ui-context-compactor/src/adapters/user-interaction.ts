import {
  type FocusAuthority,
  type UserInteractionAdvice,
} from '../focus.ts'
import type {
  EstablishedFocusDecision,
  ExistingFocusRelation,
  ExistingFocusRelationProposalOutcome,
  ExistingFocusRelationRequest,
} from '../focus-existing.ts'

export type ExistingFocusInteractionResult =
  | {
      readonly kind: 'accepted'
      readonly focus: EstablishedFocusDecision
      readonly relation: Extract<ExistingFocusRelation, 'related' | 'one_off_unrelated'>
      readonly presentation: string
    }
  | { readonly kind: 'not_established' }

function presentation(
  relation: Extract<ExistingFocusRelation, 'related' | 'one_off_unrelated'>,
  focus: EstablishedFocusDecision,
): string {
  if (relation === 'one_off_unrelated') {
    return `本轮是一次性插问；如实处理本轮，但完成后当前焦点仍是：${focus.currentMatter}`
  }
  return `继续当前焦点：${focus.currentMatter}`
}

/** Runtime adapter only: C01 remains with FocusAuthority and C08 with advice. */
export function handleExistingFocusInteraction(
  authority: FocusAuthority,
  advice: UserInteractionAdvice,
  request: ExistingFocusRelationRequest,
  outcome: ExistingFocusRelationProposalOutcome,
): ExistingFocusInteractionResult {
  const c01 = authority.decideExistingFocus(request.expression, request.focus, outcome)
  if (c01.kind !== 'business_result'
    || c01.value.kind !== 'focus_established'
    || c01.value !== request.focus
    || outcome.kind !== 'proposal'
    || (outcome.value.relation !== 'related'
      && outcome.value.relation !== 'one_off_unrelated')) return { kind: 'not_established' }
  const c08 = advice.acceptMatterRelation(c01.value)
  if (c08.kind !== 'business_result'
    || c08.identity.contract !== 'C08'
    || c08.identity.subject !== request.focus.ref
    || c08.value.kind !== 'accepted_for_contract'
    || c08.value.value !== request.focus) return { kind: 'not_established' }
  return Object.freeze({
    kind: 'accepted',
    focus: request.focus,
    relation: outcome.value.relation,
    presentation: presentation(outcome.value.relation, request.focus),
  })
}
