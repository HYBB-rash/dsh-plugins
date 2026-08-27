/** Internal canonical-background source and its self-contained message factory. */

import { createHash } from 'node:crypto'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type {
  CanonicalBackgroundMaterial,
  CanonicalStateRef,
  PendingCanonicalStateRef,
  PrivatePendingBackground,
} from './state-transaction.ts'
import type { ChatRef, FocusDecisionRef } from './focus.ts'
import type { ActionFactBoundaryRef } from './action-boundary.ts'
import type { CandidateRef } from './candidate-qualification.ts'

interface CanonicalBackgroundMachineProjection {
  readonly kind: 'background'
  readonly candidateRef: CandidateRef
  readonly focusRef: FocusDecisionRef
  readonly currentMatter: string
  readonly latestCorrections: string
  readonly boundaryRef: ActionFactBoundaryRef
  readonly evidenceRef: string
  readonly originMessageId: string
  readonly originHash: string
}

interface CanonicalBackgroundMessageSource {
  readonly kind: 'context-manager-canonical'
  readonly phase: 'current' | 'finalized'
  readonly pendingStateRef: PendingCanonicalStateRef
  readonly canonicalStateRef: CanonicalStateRef
  readonly generation: number
  readonly chat: ChatRef
  readonly bodyHash: string
  readonly machine: CanonicalBackgroundMachineProjection
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Internal map key; the runtime source kind deliberately remains canonical. */
    'context-manager-background': CanonicalBackgroundMessageSource
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * The canonical message contains only the qualified self-contained body and a
 * bounded machine projection. The triggering direct message remains a
 * separate Harness message and is never copied into this source.
 */
export function createCanonicalBackgroundMaterial(
  body: string,
  origin: { readonly messageId: string; readonly hash: string },
): CanonicalBackgroundMaterial {
  if (body.trim().length === 0 || origin.messageId.trim().length === 0 || origin.hash.trim().length === 0) {
    throw new Error('canonical background material is incomplete')
  }
  const bodyHash = digest(body)
  const create = (pending: PrivatePendingBackground, phase: 'current' | 'finalized'): UserMessage => {
    const candidate = pending.decision.candidate
    if (candidate.background !== body || candidate.target !== pending.material.target
      || candidate.ref !== pending.state.candidateRef || pending.state.qualification !== pending.c28) {
      throw new Error('canonical background source changed the qualified candidate identity')
    }
    const source: CanonicalBackgroundMessageSource = {
      kind: 'context-manager-canonical', phase,
      pendingStateRef: pending.state.ref,
      canonicalStateRef: pending.canonicalRef,
      generation: pending.generation,
      chat: pending.material.target,
      bodyHash,
      machine: {
        kind: 'background', candidateRef: candidate.ref,
        focusRef: pending.state.focus.ref,
        currentMatter: pending.state.focus.currentMatter,
        latestCorrections: pending.state.focus.latestCorrections,
        boundaryRef: pending.state.boundary.ref,
        evidenceRef: candidate.formationEvidence.ref,
        originMessageId: origin.messageId,
        originHash: origin.hash,
      },
    }
    return createUserMessage({
      content: [{ type: 'text', text: body }],
      source,
    })
  }
  return Object.freeze({ body, bodyHash, origin: Object.freeze({ ...origin }), create })
}
