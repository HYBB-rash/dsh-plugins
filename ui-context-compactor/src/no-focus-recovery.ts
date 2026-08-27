/**
 * Cold/crash recovery composition for the H1 no-focus canary.
 *
 * This adapter deliberately has no C34/C35/C37 signing authority. It only
 * carries already-validated stored material through the three original
 * receivers, preserving their separate identities for the later index/lifecycle
 * binding.
 */

import { FocusAuthority } from './focus.ts'
import {
  CanonicalContextAuthority,
  createFinalizedNoFocusRecoveryPort,
  createPendingNoFocusReplayPort,
  EffectiveStatePreservation,
  type FinalizedNoFocusRecoveryPort,
  type FinalizedNoFocusRecoveryResult,
  type PendingNoFocusReplayPort,
  type StoredNoFocusRecoveryEvidence,
} from './state-transaction.ts'

export interface NoFocusRecoveryReceivers {
  readonly preservation: EffectiveStatePreservation
  readonly focusAuthority: FocusAuthority
  readonly canonicalAuthority: CanonicalContextAuthority
}

export interface NoFocusRecoveryEvidence {
  /** Raw sidecar/session input; only EffectiveStatePreservation decodes it for C34. */
  readonly stored: StoredNoFocusRecoveryEvidence
}

/** Cold-only H1R-P composition input; no intermediate candidate is public. */
export interface NoFocusPendingRecoveryEvidence {
  readonly stored: StoredNoFocusRecoveryEvidence
  readonly sessionId: string
  readonly save: (record: unknown) => Promise<void>
  readonly flush: () => Promise<boolean>
  readonly readFrom: (fromSeq: number) => Promise<{ readonly events: readonly import('@deepseek-ai/dsh-session').SessionEvent[] }>
}

export type NoFocusRecoveryResult = FinalizedNoFocusRecoveryResult

/**
 * A technical recovery adapter. It cannot construct a restored focus fact,
 * cannot issue C34/C35/C37 itself, and cannot turn a failed report into a
 * current context.
 */
export class NoFocusRecovery {
  private readonly port: FinalizedNoFocusRecoveryPort
  private readonly pendingPort: PendingNoFocusReplayPort
  private readonly ownerBound: boolean
  constructor(receivers: NoFocusRecoveryReceivers) {
    // Installation binds the owner before any raw sidecar evidence is read.
    // A later foreign recovery adapter cannot consume a candidate first.
    this.ownerBound = receivers.preservation.hasExpectedRecoveryOwner(receivers.focusAuthority)
    this.port = createFinalizedNoFocusRecoveryPort(
      receivers.preservation, receivers.focusAuthority, receivers.canonicalAuthority,
    )
    this.pendingPort = createPendingNoFocusReplayPort(receivers.preservation, receivers.canonicalAuthority)
  }

  restore(evidence: NoFocusRecoveryEvidence): NoFocusRecoveryResult | undefined {
    if (!this.ownerBound) return undefined
    return this.port.restore(evidence.stored)
  }

  /**
   * The only H1R-P operation exposed to lifecycle code: exact pending
   * evidence is finalized, then immediately consumed through the established
   * C34/C35/C37 receiver chain.  Candidates and Cnn reports never escape.
   */
  async restorePending(
    evidence: NoFocusPendingRecoveryEvidence,
  ): Promise<NoFocusRecoveryResult | undefined> {
    if (!this.ownerBound) return undefined
    let latest: unknown
    const replayed = await this.pendingPort.replay({
      sessionId: evidence.sessionId,
      session: evidence.stored.session,
      record: evidence.stored.record,
      save: async record => {
        await evidence.save(record)
        latest = record
      },
      flush: evidence.flush,
      readFrom: evidence.readFrom,
    })
    if (!replayed || latest === undefined) return undefined
    return this.port.restore({ session: evidence.stored.session, record: latest })
  }
}
