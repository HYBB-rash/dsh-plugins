/** Safe recovery of a claimed direct input that never entered a request. */

import { createHash } from 'node:crypto'
import type { Agent, InboxTarget } from '@deepseek-ai/dsh-agent'
import {
  createUserMessage,
  freezeMessage,
  MessageId,
  type UserMessage,
} from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

const MAX_PERSISTENCE_ATTEMPTS = 2
const WAKE_KIND = 'context-manager-input-requeue-wake'

interface InputRequeueWakeSource {
  readonly kind: typeof WAKE_KIND
  readonly recoveryId: string
  readonly inputId: string
  readonly attempt: number
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'context-manager-input-requeue-wake': InputRequeueWakeSource
  }
}

interface ReplayItem {
  readonly message: UserMessage
  readonly target: InboxTarget
  readonly index: number
  readonly insertionSeq: number
}

export interface RecoverableClaimedInput {
  readonly recoveryId: string
  readonly message: UserMessage
  readonly target: InboxTarget
  readonly index: number
  readonly insertionSeq: number
  readonly claimSeq: number
  readonly identityHash: string
}

export type InputRequeueOutcome =
  | { readonly kind: 'reinserted'; readonly input: RecoverableClaimedInput; readonly reinsertSeq: number }
  | { readonly kind: 'already-pending'; readonly input: RecoverableClaimedInput }
  | { readonly kind: 'persistence-failed'; readonly input: RecoverableClaimedInput; readonly reinsertSeq?: number }

export interface InputRequeuePersistence {
  flush(): Promise<boolean>
  readFrom(fromSeq: number): Promise<{ readonly events: readonly SessionEvent[] }>
}

function json(value: unknown): string {
  return JSON.stringify(value)
}

function identityHash(message: UserMessage): string {
  return createHash('sha256').update(json({
    id: String(message.id),
    role: message.role,
    source: message.source,
    content: message.content,
  })).digest('hex')
}

function sameMessage(left: UserMessage, right: UserMessage): boolean {
  return String(left.id) === String(right.id)
    && left.role === right.role
    && json(left.source) === json(right.source)
    && json(left.content) === json(right.content)
    && identityHash(left) === identityHash(right)
}

function isDirectUser(message: UserMessage): boolean {
  return message.source.kind === 'user'
}

function pending(agent: Agent, id: string): UserMessage | undefined {
  return [...agent.inbox.nextStep, ...agent.inbox.nextTurn]
    .find(message => String(message.id) === id)
}

function pendingAt(agent: Agent, input: RecoverableClaimedInput, start: number): UserMessage | undefined {
  const target = input.target === 'next-step' ? agent.inbox.nextStep : agent.inbox.nextTurn
  const sameId = [...agent.inbox.nextStep, ...agent.inbox.nextTurn]
    .filter(message => String(message.id) === String(input.message.id))
  const exact = target[start]
  return sameId.length === 1 && exact !== undefined && sameMessage(exact, input.message)
    ? exact
    : undefined
}

function isRequestEvidence(event: SessionEvent): boolean {
  return event.type === 'step/start'
    || event.type === 'request/header'
    || event.type === 'request/context'
    || event.type === 'assistant/chunk'
    || event.type === 'assistant/message'
    || event.type === 'tool/call'
    || event.type === 'tool/result'
}

/**
 * Fold only the standard append-only inbox protocol. A candidate survives
 * exactly while the latest removal is a non-canceled claim and no surface or
 * request evidence occurs before the recovery linearization point.
 */
export function recoverableClaimedInputs(
  sessionId: string,
  events: readonly SessionEvent[],
): readonly RecoverableClaimedInput[] {
  const state: Record<InboxTarget, ReplayItem[]> = { 'next-step': [], 'next-turn': [] }
  const claims = new Map<string, RecoverableClaimedInput>()
  const disqualified = new Set<string>()

  for (const event of events) {
    if (event.type === 'agent/inbox/spliced') {
      const target = event.data.target
      const before = state[target]
      const removedCount = event.data.removedCount ?? 0
      const removed = before.slice(event.data.start, event.data.start + removedCount)
      if (removedCount > 0) {
        for (const [offset, item] of removed.entries()) {
          const message = item.message
          if (!isDirectUser(message)) continue
          const messageId = String(message.id)
          if (event.data.outcome !== undefined) {
            claims.delete(messageId)
            disqualified.add(messageId)
            continue
          }
          const hash = identityHash(message)
          const recoveryId = createHash('sha256').update(
            `${sessionId}\0${event.seq}\0${String(message.id)}\0${target}\0${hash}`,
          ).digest('hex')
          claims.set(messageId, Object.freeze({
            recoveryId,
            message,
            target,
            index: event.data.start + offset,
            insertionSeq: item.insertionSeq,
            claimSeq: event.seq,
            identityHash: hash,
          }))
        }
      }
      const inserted = event.data.inserted.map((message, offset): ReplayItem => Object.freeze({
        message,
        target,
        index: event.data.start + offset,
        insertionSeq: event.seq,
      }))
      before.splice(event.data.start, removedCount, ...inserted)
      continue
    }

    if (event.type === 'user/message') {
      const claim = claims.get(String(event.data.id))
      if (claim !== undefined && event.seq > claim.claimSeq) disqualified.add(String(event.data.id))
      continue
    }
    if (isRequestEvidence(event)) {
      for (const [id, claim] of claims) {
        if (event.seq > claim.claimSeq) disqualified.add(id)
      }
    }
  }

  return [...claims.values()]
    .filter(claim => !disqualified.has(String(claim.message.id)))
    .sort((left, right) => left.claimSeq - right.claimSeq || left.index - right.index)
}
function exactReinsertReadback(
  events: readonly SessionEvent[],
  input: RecoverableClaimedInput,
  reinsertSeq: number,
  reinsertStart: number,
): boolean {
  const exact = events.filter(event => event.seq === reinsertSeq)
  if (exact.length !== 1) return false
  const event = exact[0]
  return event?.type === 'agent/inbox/spliced'
    && event.data.target === input.target
    && event.data.start === reinsertStart
    && event.data.removedCount === undefined
    && event.data.outcome === undefined
    && event.data.inserted.length === 1
    && sameMessage(event.data.inserted[0]!, input.message)
    && identityHash(event.data.inserted[0]!) === input.identityHash
}

function exactLiveReinsert(
  agent: Agent,
  input: RecoverableClaimedInput,
  reinsertStart: number,
): SessionEvent<'agent/inbox/spliced'> | undefined {
  return agent.session.events.findLast((event): event is SessionEvent<'agent/inbox/spliced'> =>
    event.type === 'agent/inbox/spliced'
      && event.seq > input.claimSeq
      && event.data.target === input.target
      && event.data.start === reinsertStart
      && event.data.removedCount === undefined
      && event.data.outcome === undefined
      && event.data.inserted.length === 1
      && sameMessage(event.data.inserted[0]!, input.message))
}

function batchStart(
  batch: readonly RecoverableClaimedInput[],
  input: RecoverableClaimedInput,
): number | undefined {
  const ordered = batch
    .filter(candidate => candidate.target === input.target)
    .sort((left, right) => left.claimSeq - right.claimSeq || left.index - right.index)
  const start = ordered.findIndex(candidate => candidate.recoveryId === input.recoveryId)
  return start < 0 ? undefined : start
}

function exactBatchPrefix(
  agent: Agent,
  batch: readonly RecoverableClaimedInput[],
  input: RecoverableClaimedInput,
  start: number,
): boolean {
  const target = input.target === 'next-step' ? agent.inbox.nextStep : agent.inbox.nextTurn
  const preceding = batch
    .filter(candidate => candidate.target === input.target)
    .sort((left, right) => left.claimSeq - right.claimSeq || left.index - right.index)
    .slice(0, start)
  return preceding.every((candidate, index) => {
    const message = target[index]
    return message !== undefined && sameMessage(message, candidate.message)
  })
}

function exactPendingBatch(
  agent: Agent,
  batch: readonly RecoverableClaimedInput[],
): boolean {
  const ordered = [...batch]
    .sort((left, right) => left.claimSeq - right.claimSeq || left.index - right.index)
  return ordered.every((input) => {
    const start = batchStart(ordered, input)
    return start !== undefined
      && pendingAt(agent, input, start) !== undefined
      && exactBatchPrefix(agent, ordered, input, start)
  })
}

/** One process-local coordinator; incident notification intentionally is not durable. */
export class InputRequeueCoordinator {
  private readonly failed = new WeakMap<Agent, Map<string, RecoverableClaimedInput>>()
  private readonly scheduledWakes = new WeakMap<Agent, Set<string>>()

  plan(agent: Agent): readonly RecoverableClaimedInput[] {
    return recoverableClaimedInputs(String(agent.session.id), agent.session.events)
  }

  /** Remove a crash-left mechanical wake before it can enter a request. */
  discardStaleWakes(agent: Agent): number {
    const stale = [...agent.inbox.nextStep, ...agent.inbox.nextTurn].filter(message => this.isWake(message))
    let removed = 0
    for (const wake of stale) {
      if (agent.inbox.remove(wake.id)) removed += 1
    }
    return removed
  }

  /** The inserted hook consumes the wake synchronously; send() then latches only its driver wake. */
  discardInsertedWake(agent: Agent, message: UserMessage): boolean {
    if (!this.isWake(message)) return false
    return agent.inbox.remove(message.id)
  }

  isWake(message: UserMessage): boolean {
    return message.source.kind === WAKE_KIND
  }

  hasDeferredFailure(agent: Agent, messageId: string): boolean {
    return this.failed.get(agent)?.has(messageId) === true
  }

  deferredFailure(agent: Agent, messageId: string): RecoverableClaimedInput | undefined {
    return this.failed.get(agent)?.get(messageId)
  }

  consumeDeferredFailure(agent: Agent, messageId: string): void {
    const failures = this.failed.get(agent)
    failures?.delete(messageId)
    if (failures?.size === 0) this.failed.delete(agent)
  }

  async recover(
    agent: Agent,
    input: RecoverableClaimedInput,
    persistence: InputRequeuePersistence,
    wake: 'none' | 'after-idle' = 'none',
    batch: readonly RecoverableClaimedInput[] = this.plan(agent),
  ): Promise<InputRequeueOutcome> {
    const plan = this.plan(agent)
    const currentPlan = plan.find(candidate => candidate.recoveryId === input.recoveryId)
    const reinsertStart = batchStart(batch, input)
    if (reinsertStart === undefined) return this.fail(agent, input)
    const existing = pending(agent, String(input.message.id))
    if (existing !== undefined) {
      if (currentPlan === undefined
        || !sameMessage(existing, input.message)
        || pendingAt(agent, input, reinsertStart) === undefined
        || !exactBatchPrefix(agent, batch, input, reinsertStart)) return this.fail(agent, input)
      const reinsert = exactLiveReinsert(agent, input, reinsertStart)
      if (reinsert === undefined) return this.fail(agent, input)
      for (let attempt = 0; attempt < MAX_PERSISTENCE_ATTEMPTS; attempt += 1) {
        try {
          if (!await persistence.flush()) continue
          const detached = await persistence.readFrom(reinsert.seq)
          if (!exactReinsertReadback(detached.events, input, reinsert.seq, reinsertStart)) continue
          this.consumeDeferredFailure(agent, String(input.message.id))
          if (wake === 'after-idle') this.scheduleWake(agent, [input])
          return { kind: 'already-pending', input }
        } catch {
          // A fixed second attempt may prove the same exact persisted reinsert.
        }
      }
      return this.fail(agent, input, reinsert.seq)
    }
    if (currentPlan === undefined || !sameMessage(currentPlan.message, input.message)) {
      return this.fail(agent, input)
    }

    let reinsertSeq: number | undefined
    for (let attempt = 0; attempt < MAX_PERSISTENCE_ATTEMPTS; attempt += 1) {
      const already = pending(agent, String(input.message.id))
      if (already === undefined) {
        if (!exactBatchPrefix(agent, batch, input, reinsertStart)) return this.fail(agent, input, reinsertSeq)
        try {
          const before = agent.session.events.length
          const list = input.target === 'next-step' ? agent.inbox.nextStep : agent.inbox.nextTurn
          if (reinsertStart > list.length) return this.fail(agent, input, reinsertSeq)
          agent.inbox.splice(input.target, reinsertStart, 0, [input.message])
          const event = agent.session.events.at(-1)
          if (agent.session.events.length !== before + 1
            || event?.type !== 'agent/inbox/spliced'
            || event.data.start !== reinsertStart) continue
          reinsertSeq = event.seq
        } catch {
          continue
        }
      } else if (!sameMessage(already, input.message)
        || pendingAt(agent, input, reinsertStart) === undefined) {
        return this.fail(agent, input, reinsertSeq)
      }

      if (reinsertSeq === undefined) {
        const event = agent.session.events.findLast(candidate => candidate.type === 'agent/inbox/spliced'
          && candidate.data.inserted.some(message => String(message.id) === String(input.message.id)))
        if (event?.type !== 'agent/inbox/spliced') continue
        reinsertSeq = event.seq
      }
      try {
        if (!await persistence.flush()) continue
        const detached = await persistence.readFrom(reinsertSeq)
        if (!exactReinsertReadback(detached.events, input, reinsertSeq, reinsertStart)) continue
        this.consumeDeferredFailure(agent, String(input.message.id))
        const outcome: InputRequeueOutcome = { kind: 'reinserted', input, reinsertSeq }
        if (wake === 'after-idle') this.scheduleWake(agent, [input])
        return outcome
      } catch {
        // A fixed second attempt may prove the same single pending insertion.
      }
    }
    return this.fail(agent, input, reinsertSeq)
  }

  /** One mechanically filtered driver wake is enough for one proved recovery batch. */
  wakeAfterIdle(agent: Agent, inputs: readonly RecoverableClaimedInput[]): void {
    if (inputs.length === 0) return
    const ordered = [...inputs].sort((left, right) => left.claimSeq - right.claimSeq || left.index - right.index)
    if (!exactPendingBatch(agent, ordered)) return
    this.scheduleWake(agent, ordered)
  }

  private fail(
    agent: Agent,
    input: RecoverableClaimedInput,
    reinsertSeq?: number,
  ): InputRequeueOutcome {
    const failures = this.failed.get(agent) ?? new Map<string, RecoverableClaimedInput>()
    failures.set(String(input.message.id), input)
    this.failed.set(agent, failures)
    return {
      kind: 'persistence-failed',
      input,
      ...(reinsertSeq === undefined ? {} : { reinsertSeq }),
    }
  }

  private scheduleWake(agent: Agent, inputs: readonly RecoverableClaimedInput[]): void {
    const input = inputs[0]
    if (input === undefined) return
    const recoveryId = createHash('sha256')
      .update(inputs.map(candidate => candidate.recoveryId).join('\0'))
      .digest('hex')
    const scheduled = this.scheduledWakes.get(agent) ?? new Set<string>()
    if (scheduled.has(recoveryId)) return
    scheduled.add(recoveryId)
    this.scheduledWakes.set(agent, scheduled)
    void agent.whenIdle().then(() => {
      // Re-prove the same recovered prefix at the actual wake linearization
      // point. Later same-target work must never move ahead while this wake was
      // waiting for a foreign/current turn to become idle.
      if (!exactPendingBatch(agent, inputs)) return
      const wake = freezeMessage({
        ...createUserMessage({
          content: [{ type: 'text', text: 'Resume the physically proved pending input.' }],
          source: {
            kind: WAKE_KIND,
            recoveryId,
            inputId: String(input.message.id),
            attempt: 1,
          },
        }),
        id: MessageId(`input-requeue-wake:${recoveryId}`),
      })
      agent.steer(wake)
    }).finally(() => {
      scheduled.delete(recoveryId)
      if (scheduled.size === 0) this.scheduledWakes.delete(agent)
    })
  }
}
