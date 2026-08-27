/** Natural H2-to-H1 live handoff for one physically-proved no-focus close. */

import { createHash } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ChatRef, CorrectionMeaning, FocusDecisionRef } from './focus.ts'
import {
  CanonicalStateTransaction,
  type CanonicalNoFocusMaterial,
  type NoFocusDecision,
  type NoFocusTransactionCarrier,
  type PrivatePendingNoFocus,
} from './state-transaction.ts'

export interface PhysicallyProvedNoFocusHandoff<Record extends NoFocusTransactionCarrier> {
  readonly sessionId: string
  readonly session: Agent['session']
  readonly record: Record
  readonly close: { readonly messageId: string; readonly hash: string }
  readonly decision: NoFocusDecision
  readonly save: (record: Record) => Promise<void>
  readonly flush: () => Promise<boolean>
  readonly readFrom: (fromSeq: number) => Promise<{ readonly events: readonly SessionEvent[] }>
}
export interface NoFocusHarnessSuccess { readonly notice: UserMessage; readonly finalizedSeq: number }
export interface CanonicalNoFocusSource {
  readonly kind: 'context-manager-canonical'
  readonly phase: 'current' | 'finalized'
  readonly pendingStateRef: PrivatePendingNoFocus['state']['ref']
  readonly canonicalStateRef: PrivatePendingNoFocus['canonicalRef']
  readonly generation: number
  readonly chat: ChatRef
  readonly bodyHash: string
  readonly machine: {
    readonly kind: 'no_focus'
    readonly focusRef: FocusDecisionRef
    readonly latestCorrections: CorrectionMeaning
    readonly closeMessageId: string
    readonly closeHash: string
  }
}
declare module '@deepseek-ai/dsh-llm' { interface MessageSourceMap { 'context-manager-canonical': CanonicalNoFocusSource } }
const CANONICAL_TEXT = '当前没有正在进行的事项。请询问用户想开始哪件事。'
const NOTICE_TEXT = '当前事项已结束。请告诉我接下来要开始哪件事。'

/** Adapter only: it has no authority to create or reinterpret a focus fact. */
export class NoFocusHarness {
  constructor(private readonly transaction = new CanonicalStateTransaction()) {}
  async enter<Record extends NoFocusTransactionCarrier>(handoff: PhysicallyProvedNoFocusHandoff<Record>): Promise<NoFocusHarnessSuccess> {
    const committed = await this.transaction.commit({ ...handoff, focus: handoff.decision, material: this.material(handoff.close) })
    return { finalizedSeq: committed.finalizedSeq, notice: createUserMessage({
      content: [{ type: 'text', text: NOTICE_TEXT }],
      source: { kind: 'plugin', plugin: 'ui-context-compactor:no-focus', form: 'notice', summary: 'no-focus closure receipt' },
    }) }
  }
  private material(close: PhysicallyProvedNoFocusHandoff<NoFocusTransactionCarrier>['close']): CanonicalNoFocusMaterial {
    const bodyHash = createHash('sha256').update(CANONICAL_TEXT).digest('hex')
    return { body: CANONICAL_TEXT, bodyHash, create: (pending, phase) => createUserMessage({
      content: [{ type: 'text', text: CANONICAL_TEXT }],
      source: { kind: 'context-manager-canonical', phase, pendingStateRef: pending.state.ref,
        canonicalStateRef: pending.canonicalRef, generation: pending.generation, chat: pending.state.focus.chat, bodyHash,
        machine: { kind: 'no_focus', focusRef: pending.state.focus.ref, latestCorrections: pending.state.focus.latestCorrections,
          closeMessageId: close.messageId, closeHash: close.hash } },
    }) }
  }
}
