/** Owner-bound C28 handoff and the narrow live/cold background state port. */

import type {
  CandidateBasisFreshnessDecision,
  CandidateContentReviewDecision,
  CandidateFormationResult,
  CandidateQualificationDecision,
  CandidateQualificationIssueReceiver,
  CandidateRef,
  C25Result,
  C26Result,
  C27Result,
  C28Result,
} from './candidate-qualification.ts'
import { CandidateQualificationAuthority, type CandidateQualificationReceiver } from './candidate-qualification.ts'
import type { ActionFactBoundary, ActionFactBoundaryAuthority } from './action-boundary.ts'
import type { ContractCallRef, ContractScope, FocusAuthority } from './focus.ts'
import {
  CanonicalStateTransaction,
  parseCanonicalBackgroundStateRecord,
  type BackgroundStateRecord,
  type CanonicalBackgroundTransactionInput,
  type FinalizedBackgroundRecoveryResult,
  type FinalizedCanonicalBackground,
} from './state-transaction.ts'
import { createCanonicalBackgroundMaterial } from './context-source.ts'

type QualifiedDecision<Ref extends CandidateRef = CandidateRef> = Extract<
  CandidateQualificationDecision<Ref>,
  { readonly kind: 'qualified' }
>

interface PendingQualification {
  readonly decision: QualifiedDecision
  readonly c28: C28Result
}

/** The formation/reviewer-facing facade cannot consume or authenticate C28. */
export interface BackgroundQualificationInputPort {
  acceptFormationResult<Ref extends CandidateRef>(result: CandidateFormationResult<Ref>): C25Result<Ref>
  acceptContentReview<Ref extends CandidateRef>(review: CandidateContentReviewDecision<Ref>): C26Result<Ref>
  acceptBasisFreshness<Ref extends CandidateRef>(freshness: CandidateBasisFreshnessDecision<Ref>): C27Result<Ref>
}

export interface BackgroundStateLiveInput {
  readonly sessionId: CanonicalBackgroundTransactionInput['sessionId']
  readonly session: CanonicalBackgroundTransactionInput['session']
  readonly record: BackgroundStateRecord
  readonly focus: CanonicalBackgroundTransactionInput['focus']
  readonly boundary: ActionFactBoundary
  readonly origin: CanonicalBackgroundTransactionInput['material']['origin']
  readonly save: CanonicalBackgroundTransactionInput['save']
  readonly flush: CanonicalBackgroundTransactionInput['flush']
  readonly readFrom: CanonicalBackgroundTransactionInput['readFrom']
}

export interface BackgroundStateRecoveryInput {
  readonly sessionId: CanonicalBackgroundTransactionInput['sessionId']
  readonly session: CanonicalBackgroundTransactionInput['session']
  readonly record: unknown
  readonly save: CanonicalBackgroundTransactionInput['save']
  readonly flush: CanonicalBackgroundTransactionInput['flush']
  readonly readFrom: CanonicalBackgroundTransactionInput['readFrom']
}

export interface RecoveredBackgroundState {
  readonly record: BackgroundStateRecord
  readonly evidence: FinalizedBackgroundRecoveryResult
}

/** Index receives only complete live and recovery operations. */
export interface BackgroundStatePort {
  apply(input: BackgroundStateLiveInput): Promise<FinalizedCanonicalBackground>
  recover(input: BackgroundStateRecoveryInput): Promise<RecoveredBackgroundState | undefined>
}

export interface BackgroundStateComposition {
  readonly qualification: BackgroundQualificationInputPort
  readonly state: BackgroundStatePort
}

export interface BackgroundStateDependencies {
  readonly userAdvice: CandidateQualificationIssueReceiver
  readonly focusOwner: FocusAuthority
  readonly actionOwner: ActionFactBoundaryAuthority
  readonly transaction: CanonicalStateTransaction
}

function rejectedC28<Ref extends CandidateRef>(decision: QualifiedDecision<Ref>): C28Result<Ref> {
  return Object.freeze({
    kind: 'rejected',
    identity: Object.freeze({
      contract: 'C28',
      call: `C28:${crypto.randomUUID()}` as ContractCallRef,
      subject: Object.freeze({ kind: 'candidate' as const, candidate: decision.candidate }),
    }),
    reason: Object.freeze({
      kind: 'known_business_precondition_not_met' as const,
      detail: 'C28:rejection' as ContractScope<'C28', 'rejection'>,
    }),
  })
}

function acceptedC28<Ref extends CandidateRef>(decision: QualifiedDecision<Ref>): C28Result<Ref> {
  return Object.freeze({
    kind: 'business_result',
    identity: Object.freeze({
      contract: 'C28',
      call: `C28:${crypto.randomUUID()}` as ContractCallRef,
      subject: Object.freeze({ kind: 'candidate' as const, candidate: decision.candidate }),
    }),
    value: Object.freeze({ kind: 'accepted_for_contract' as const, value: decision }),
  })
}

/**
 * Owns the qualification authority and its one-use handoff. The returned
 * facade can submit C25/C26/C27, but only the closed state port can consume
 * the resulting exact C28 decision/report pair.
 */
export function createBackgroundStateComposition(
  dependencies: BackgroundStateDependencies,
): BackgroundStateComposition {
  const pending = new Map<string, PendingQualification>()
  const receiver: CandidateQualificationReceiver = Object.freeze({
    acceptCandidateQualification<Ref extends CandidateRef>(
      decision: QualifiedDecision<Ref>,
    ): C28Result<Ref> {
      const target = decision.candidate.target
      if (pending.has(target)) return rejectedC28(decision)
      const c28 = acceptedC28(decision)
      pending.set(target, Object.freeze({ decision, c28 }))
      return c28
    },
  })
  const owner = new CandidateQualificationAuthority({ observer: receiver, userAdvice: dependencies.userAdvice })
  const live = dependencies.transaction.createBackgroundLivePort()
  const repair = dependencies.transaction.createBackgroundRepairPort()
  const recovery = dependencies.transaction.createBackgroundRecoveryPort(
    dependencies.focusOwner,
    dependencies.actionOwner,
  )
  const qualification: BackgroundQualificationInputPort = Object.freeze({
    acceptFormationResult<Ref extends CandidateRef>(result: CandidateFormationResult<Ref>): C25Result<Ref> {
      return owner.acceptFormationResult(result)
    },
    acceptContentReview<Ref extends CandidateRef>(review: CandidateContentReviewDecision<Ref>): C26Result<Ref> {
      return owner.acceptContentReview(review)
    },
    acceptBasisFreshness<Ref extends CandidateRef>(freshness: CandidateBasisFreshnessDecision<Ref>): C27Result<Ref> {
      return owner.acceptBasisFreshness(freshness)
    },
  })
  const state: BackgroundStatePort = Object.freeze({
    async apply(input: BackgroundStateLiveInput): Promise<FinalizedCanonicalBackground> {
      const handoff = pending.get(input.sessionId)
      pending.delete(input.sessionId)
      if (handoff === undefined
        || handoff.decision.candidate.target !== input.sessionId
        || handoff.decision.candidate.formationFocus.ref !== input.focus.ref
        || handoff.decision.candidate.formationActionBoundary.ref !== input.boundary.ref) {
        throw new Error('background state has no matching owner-qualified C28 handoff')
      }
      return await live.commit({
        sessionId: input.sessionId,
        session: input.session,
        record: input.record,
        qualificationOwner: owner,
        decision: handoff.decision,
        c28: handoff.c28,
        focus: input.focus,
        actionOwner: dependencies.actionOwner,
        boundary: input.boundary,
        save: input.save,
        flush: input.flush,
        readFrom: input.readFrom,
        material: createCanonicalBackgroundMaterial(handoff.decision.candidate.background, input.origin),
      })
    },
    async recover(input: BackgroundStateRecoveryInput): Promise<RecoveredBackgroundState | undefined> {
      const parsed = parseCanonicalBackgroundStateRecord(input.record)
      const transaction = parsed?.transaction
      if (parsed === undefined || transaction === undefined) return undefined
      const material = createCanonicalBackgroundMaterial(transaction.body, {
        messageId: transaction.machine.originMessageId,
        hash: transaction.machine.originHash,
      })
      const repaired = await repair.repair({
        sessionId: input.sessionId,
        session: input.session,
        record: parsed,
        save: input.save,
        flush: input.flush,
        readFrom: input.readFrom,
        create: material.create,
      })
      if (repaired === undefined) return undefined
      const evidence = recovery.restore({ session: input.session, record: repaired })
      return evidence === undefined ? undefined : Object.freeze({ record: repaired, evidence })
    },
  })
  return Object.freeze({ qualification, state })
}
