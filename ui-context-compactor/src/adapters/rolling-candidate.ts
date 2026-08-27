/** F01-T4 C41/C14/C15 association and exact identical-candidate observation. */

import type { ActionFactBoundary } from '../action-boundary.ts'
import {
  rollingCandidateGeneration,
  type BackgroundCandidateFormation,
  type RollingCandidateRequest,
} from '../candidate.ts'
import type { CandidateEnvelope, CandidateRef, C28Result } from '../candidate-qualification.ts'
import type { EvidenceConclusionSet } from '../fact-resolution.ts'
import type { ChatRef } from '../focus.ts'
import type { ExactBackgroundUpdateOrigin } from '../candidate.ts'
import type { FutureCriticalPointProjection } from '../future-critical-candidate.ts'
import type { OwnerQualifiedCandidateObserver } from '../background-state.ts'
import type { QualifiedBackgroundCurrentPort } from './qualified-background.ts'
import { parseCanonicalBackgroundStateRecord } from '../state-transaction.ts'

declare const identicalQualifiedCandidateBrand: unique symbol
export type IdenticalQualifiedCandidateRef = CandidateRef & {
  readonly [identicalQualifiedCandidateBrand]: 'IdenticalQualifiedCandidateRef'
}

type QualifiedDecision<Ref extends CandidateRef = CandidateRef> = Extract<
  import('../candidate-qualification.ts').CandidateQualificationDecision<Ref>,
  { readonly kind: 'qualified' }
>

interface CurrentRollingAssociation {
  readonly generation: number
  readonly canonicalRef: string
  readonly body: string
  readonly machineProjection: string
  actionRef?: string
  evidenceRef?: string
}

export interface RollingCandidatePending {
  readonly chat: ChatRef
  readonly generation: number
  readonly actionRef: string
  readonly evidenceRef: string
  readonly producer: ExactBackgroundUpdateOrigin
  readonly futureCriticalPoints?: FutureCriticalPointProjection
}

export type RollingQualification<Ref extends CandidateRef = CandidateRef> =
  | { readonly kind: 'changed'; readonly decision: QualifiedDecision<Ref>; readonly c28: C28Result<Ref> }
  | { readonly kind: 'identical'; readonly ref: IdenticalQualifiedCandidateRef; readonly decision: QualifiedDecision<Ref>; readonly c28: C28Result<Ref> }

export interface RollingCandidateAdapter extends OwnerQualifiedCandidateObserver {
  acceptCurrent(chat: ChatRef, record: unknown): boolean
  acceptActionFactBoundary(boundary: ActionFactBoundary): void
  acceptEvidenceConclusions(conclusions: EvidenceConclusionSet): void
  requestRollingCandidate(request: RollingCandidateRequest): boolean
  stagePending(
    chat: ChatRef,
    producer: ExactBackgroundUpdateOrigin,
    futureCriticalPoints?: FutureCriticalPointProjection,
  ): boolean
  takePending(chat: ChatRef, consumer: ExactBackgroundUpdateOrigin): RollingCandidatePending | undefined
  takeQualification(chat: ChatRef): RollingQualification | undefined
}

interface RollingCandidateAdapterDependencies {
  readonly current: QualifiedBackgroundCurrentPort
  readonly formation: Pick<BackgroundCandidateFormation, 'requestRollingCandidate'>
}

function machineProjection(candidate: CandidateEnvelope): string {
  return JSON.stringify({
    target: candidate.target,
    focusBasis: candidate.basis.focus,
    formationFocus: candidate.formationFocus,
    formationActionBoundary: {
      kind: candidate.formationActionBoundary.kind,
      requiredFacts: candidate.formationActionBoundary.requiredFacts.requirements,
      usableFacts: candidate.formationActionBoundary.usableFacts,
      unresolvedFacts: candidate.formationActionBoundary.unresolvedFacts,
      preciselyBlockedActions: candidate.formationActionBoundary.preciselyBlockedActions,
      safelyContinuableActions: candidate.formationActionBoundary.safelyContinuableActions,
    },
    formationEvidence: candidate.formationEvidence.conclusions,
    actionableFacts: candidate.actionableFacts,
    uncertainties: candidate.uncertainties,
    knownFutureCriticalPoints: candidate.knownFutureCriticalPoints,
  })
}

function deepFreeze<Value>(value: Value): Value {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

function currentAssociation(record: unknown, chat: ChatRef): CurrentRollingAssociation | undefined {
  const transaction = parseCanonicalBackgroundStateRecord(record)?.transaction
  if (transaction?.phase !== 'finalized' || transaction.material.target !== chat) return undefined
  const decision = transaction.c28.kind === 'business_result'
    ? transaction.c28.value.value : undefined
  const candidate = decision?.kind === 'qualified' ? decision.candidate : undefined
  if (candidate === undefined || transaction.body !== candidate.background) return undefined
  return {
    generation: transaction.generation,
    canonicalRef: transaction.canonicalRef,
    body: transaction.body,
    machineProjection: machineProjection(candidate),
  }
}

export function createRollingCandidateAdapter(
  dependencies: RollingCandidateAdapterDependencies,
): RollingCandidateAdapter {
  const current = new Map<ChatRef, CurrentRollingAssociation>()
  const outcomes = new Map<ChatRef, RollingQualification>()
  const pending = new Map<ChatRef, RollingCandidatePending>()
  const active = new Map<ChatRef, number>()
  return Object.freeze({
    acceptCurrent(chat: ChatRef, record: unknown): boolean {
      const association = currentAssociation(record, chat)
      const existing = current.get(chat)
      if (association === undefined) return false
      if (existing?.generation === association.generation) {
        return existing.canonicalRef === association.canonicalRef
          && existing.body === association.body
          && existing.machineProjection === association.machineProjection
      }
      const c41 = dependencies.current.acceptCurrent(chat, record)
      if (c41?.kind !== 'business_result'
        || c41.identity.contract !== 'C41'
        || c41.value.kind !== 'accepted_for_contract'
        || c41.value.value.target !== chat) return false
      current.set(chat, association)
      outcomes.delete(chat)
      pending.delete(chat)
      return true
    },
    acceptActionFactBoundary(boundary: ActionFactBoundary): void {
      const association = current.get(boundary.chat)
      if (association !== undefined) association.actionRef = boundary.ref
    },
    acceptEvidenceConclusions(conclusions: EvidenceConclusionSet): void {
      const association = current.get(conclusions.chat)
      if (association !== undefined) association.evidenceRef = conclusions.ref
    },
    requestRollingCandidate(request: RollingCandidateRequest): boolean {
      const association = current.get(request.chat)
      if (association === undefined
        || association.generation !== request.generation
        || association.actionRef === undefined
        || association.evidenceRef === undefined
        || association.actionRef !== request.actionRef
        || association.evidenceRef !== request.evidenceRef) return false
      active.set(request.chat, request.generation)
      try {
        return dependencies.formation.requestRollingCandidate(request)
      } finally {
        if (active.get(request.chat) === request.generation) active.delete(request.chat)
      }
    },
    stagePending(
      chat: ChatRef,
      producer: ExactBackgroundUpdateOrigin,
      futureCriticalPoints?: FutureCriticalPointProjection,
    ): boolean {
      const association = current.get(chat)
      if (association === undefined || association.actionRef === undefined
        || association.evidenceRef === undefined || pending.has(chat)
        || producer.messageId.trim().length === 0 || producer.hash.trim().length === 0) return false
      pending.set(chat, Object.freeze({ chat, generation: association.generation,
        actionRef: association.actionRef, evidenceRef: association.evidenceRef,
        producer: Object.freeze({ ...producer }),
        ...futureCriticalPoints === undefined
          ? {}
          : { futureCriticalPoints: deepFreeze(structuredClone(futureCriticalPoints)) },
      }))
      return true
    },
    takePending(chat: ChatRef, consumer: ExactBackgroundUpdateOrigin): RollingCandidatePending | undefined {
      const value = pending.get(chat)
      if (value === undefined || value.producer.messageId === consumer.messageId
        || value.producer.hash === consumer.hash) return undefined
      pending.delete(chat)
      const association = current.get(chat)
      return association?.generation === value.generation
        && association.actionRef === value.actionRef && association.evidenceRef === value.evidenceRef
        ? value : undefined
    },
    acceptOwnerQualifiedCandidate<Ref extends CandidateRef>(
      decision: QualifiedDecision<Ref>,
      c28: C28Result<Ref>,
    ): void {
      const association = current.get(decision.candidate.target)
      if (association === undefined
        || active.get(decision.candidate.target) !== association.generation
        || rollingCandidateGeneration(decision.candidate) !== association.generation
        || c28.kind !== 'business_result'
        || c28.value.kind !== 'accepted_for_contract'
        || c28.value.value !== decision) return
      active.delete(decision.candidate.target)
      const identical = decision.candidate.background === association.body
        && machineProjection(decision.candidate) === association.machineProjection
      outcomes.set(decision.candidate.target, identical
        ? Object.freeze({ kind: 'identical', ref: decision.candidate.ref as unknown as IdenticalQualifiedCandidateRef, decision, c28 })
        : Object.freeze({ kind: 'changed', decision, c28 }))
    },
    takeQualification(chat: ChatRef): RollingQualification | undefined {
      const outcome = outcomes.get(chat)
      outcomes.delete(chat)
      return outcome
    },
  })
}
