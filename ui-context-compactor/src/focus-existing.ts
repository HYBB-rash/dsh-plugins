import { createHash } from 'node:crypto'
import type {
  DirectExpressionOrigin,
  ExplicitUserExpression,
  FocusDecision,
  FocusDecisionRef,
} from './focus.ts'

export type EstablishedFocusDecision = Extract<FocusDecision, { readonly kind: 'focus_established' }>

export type ExistingFocusRelation =
  | 'related'
  | 'one_off_unrelated'
  | 'acknowledgement'
  | 'new_matter'
  | 'unknown'
  | 'multiple'

export interface ExistingFocusRelationRequest {
  readonly expression: ExplicitUserExpression
  readonly origin: DirectExpressionOrigin
  readonly focus: EstablishedFocusDecision
}

export interface ExistingFocusRelationProposal {
  readonly kind: 'existing_focus_relation'
  readonly focus: FocusDecisionRef
  readonly relation: ExistingFocusRelation
  readonly origin: DirectExpressionOrigin
}

export type ExistingFocusRelationProposalOutcome =
  | {
      readonly kind: 'proposal'
      readonly focus: FocusDecisionRef
      readonly origin: DirectExpressionOrigin
      readonly value: ExistingFocusRelationProposal
    }
  | {
      readonly kind: 'known_failure' | 'unknown'
      readonly focus: FocusDecisionRef
      readonly origin: DirectExpressionOrigin
      readonly code: 'focus-canary'
    }

/** Bind one admitted direct expression to the exact already-established A. */
export function createExistingFocusRelationRequest(
  expression: ExplicitUserExpression,
  origin: DirectExpressionOrigin,
  focus: EstablishedFocusDecision,
): ExistingFocusRelationRequest | undefined {
  const expectedHash = createHash('sha256')
    .update(origin.messageId)
    .update('\0')
    .update(expression.expression)
    .digest('hex')
  if (origin.messageId.trim().length === 0
    || origin.hash !== expectedHash
    || expression.chat !== focus.chat
    || focus.ref.length === 0
    || focus.currentMatter.trim().length === 0) return undefined
  return Object.freeze({ expression, origin: Object.freeze({ ...origin }), focus })
}

/** Courtesy is explicitly non-closing, but does not itself establish continuation. */
export function isPoliteAcknowledgementExpression(expression: string): boolean {
  return /^(?:好|好的)[，,\s]*谢谢(?:你)?[。.!！]?$/.test(expression.trim())
}

/**
 * One conservative direct-user admission for closing the current matter.
 * Provider classification alone is never sufficient to create no-focus.
 */
export function isExplicitCurrentMatterClosure(expression: string): boolean {
  const normalized = expression.trim().replace(/[。.!！]$/, '')
  return /^(?:我)?接受(?:这个|当前)结果$/.test(normalized)
    || /^(?:这件事|当前这件事)?到此结束$/.test(normalized)
    || /^(?:这件事|当前这件事)结束了$/.test(normalized)
    || /^取消(?:这件事|当前这件事)$/.test(normalized)
}
