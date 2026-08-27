/** Package-internal C41 projection and qualified-background apply composition. */

import type { ChatRef } from '../focus.ts'
import {
  bindCurrentCanonicalGeneration,
  type BackgroundCandidateFormation,
  type C41Result,
  type CanonicalStateForRollingCandidate,
} from '../candidate.ts'
import type {
  BackgroundStateLiveInput,
  BackgroundStatePort,
} from '../background-state.ts'
import {
  parseCanonicalBackgroundStateRecord,
  type FinalizedCanonicalBackground,
} from '../state-transaction.ts'

export interface QualifiedBackgroundCurrentPort {
  acceptCurrent(
    chat: ChatRef,
    record: unknown,
  ): C41Result | undefined
}

export interface QualifiedBackgroundApplyPort {
  apply(input: BackgroundStateLiveInput): Promise<FinalizedCanonicalBackground>
}

export interface QualifiedBackgroundAdapter {
  readonly current: QualifiedBackgroundCurrentPort
  readonly apply: QualifiedBackgroundApplyPort
}

interface QualifiedBackgroundAdapterDependencies {
  readonly formation: Pick<BackgroundCandidateFormation, 'acceptCurrentCanonicalState'>
  readonly state: BackgroundStatePort
}

function deepFreeze<Value>(value: Value): Value {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

function projectCurrentCanonical(
  chat: ChatRef,
  record: unknown,
): { readonly state: CanonicalStateForRollingCandidate; readonly generation: number } | undefined {
  const parsed = parseCanonicalBackgroundStateRecord(record)
  const transaction = parsed?.transaction
  if (transaction === undefined
    || transaction.phase !== 'finalized'
    || transaction.material.target !== chat
    || transaction.material.canonicalState.kind !== 'background'
    || transaction.material.canonicalState.ref !== transaction.canonicalRef
    || transaction.material.canonicalState.candidateRef !== transaction.machine.candidateRef
    || !Number.isSafeInteger(transaction.generation)
    || transaction.generation < 1) return undefined
  const canonical = transaction.material.canonicalState
  const state: CanonicalStateForRollingCandidate = deepFreeze({
    kind: 'background',
    ref: canonical.ref,
    target: chat,
    candidateRef: canonical.candidateRef,
    focus: structuredClone(canonical.focus),
    boundary: structuredClone(canonical.boundary),
  })
  return Object.freeze({ state, generation: transaction.generation })
}

export function createQualifiedBackgroundAdapter(
  dependencies: QualifiedBackgroundAdapterDependencies,
): QualifiedBackgroundAdapter {
  const current: QualifiedBackgroundCurrentPort = Object.freeze({
    acceptCurrent(chat: ChatRef, record: unknown): C41Result | undefined {
      const projected = projectCurrentCanonical(chat, record)
      if (projected === undefined) return undefined
      bindCurrentCanonicalGeneration(projected.state, projected.generation)
      return dependencies.formation.acceptCurrentCanonicalState(projected.state)
    },
  })
  const apply: QualifiedBackgroundApplyPort = Object.freeze({
    async apply(input: BackgroundStateLiveInput): Promise<FinalizedCanonicalBackground> {
      return await dependencies.state.apply(input)
    },
  })
  return Object.freeze({ current, apply })
}
