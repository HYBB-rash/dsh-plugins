/**
 * Telegram outbox pump for dsh-assistant: claim-before-send, at-most-once
 * delivery of reminder and worker-result rows (§12).
 *
 * Order per row: transaction-claim (with a check-in re-validation that the
 * commitment is still active) → HTTP send of every 4096-char chunk →
 * delivered; on failure: failed (no auto-retry), uncertain when an in-flight
 * send was aborted or a later chunk failed after earlier chunks were sent,
 * and stale `claimed` rows from a previous process become uncertain on start
 * (never replayed).
 * @module @deepseek-ai/dsh-assistant
 */

import { chunkText, type TelegramHttp } from '@deepseek-ai/dsh-telegram-gateway'
import { cleanError } from './domain.ts'
import { AssistantStore, type OutboxRow } from './store.ts'

export interface OutboxPumpDeps {
  store: AssistantStore
  http: TelegramHttp
  chatId: number
  maxChars?: number
  signal: AbortSignal
  now?: () => number
  logger?: { warn(message: string): void }
}

function iso(now: (() => number) | undefined): string {
  return new Date(now === undefined ? Date.now() : now()).toISOString()
}

/**
 * One process-local outbox pump. `start()` marks stale claimed rows from a
 * previous process as uncertain, then runs an immediate catch-up and a poll
 * loop. `pumpOnce()` is the test seam for one claim+send round.
 */
export class OutboxPump {
  private readonly inFlight = new Map<string, AbortController>()
  private stopping = false
  private timer: ReturnType<typeof setInterval> | undefined
  private run: Promise<void> | undefined

  constructor(private readonly deps: OutboxPumpDeps) {}

  start(pollIntervalMs: number): void {
    // A fresh process owns nothing in-flight; anything still claimed from a
    // previous run is uncertain and must never be replayed.
    this.deps.store.markStaleClaimed()
    this.requestPump()
    this.timer = setInterval(() => this.requestPump(), pollIntervalMs)
  }

  async stop(): Promise<void> {
    this.stopping = true
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    for (const controller of this.inFlight.values()) {
      controller.abort(new Error('outbox pump disposed'))
    }
    if (this.run !== undefined) await this.run
  }

  /** Abort in-flight sends for one commitment (pause/complete/cancel). */
  abortCommitment(commitmentId: string): void {
    for (const [id, controller] of this.inFlight) {
      const row = this.deps.store.getOutbox(id)
      if (row !== undefined && row.commitmentId === commitmentId) {
        // A monitor event is already a durable hand-off from the just-finished
        // round.  Pausing changes the desired continuation only; it must not
        // abort the pending/in-flight event, because a successful delivery is
        // what confirms its checkpoint.  Cancellation sets desired state to
        // `none` and still aborts, producing the required uncertain terminal
        // state without replay.
        if (row.kind === 'monitor_event' && this.deps.store.getById(commitmentId)?.monitorDesiredState === 'paused') {
          continue
        }
        controller.abort(new Error('commitment state changed'))
      }
    }
  }

  private requestPump(): void {
    if (this.stopping || this.run !== undefined) return
    this.run = this.pumpOnce().finally(() => {
      this.run = undefined
    })
  }

  /** One claim+send round over every pending row. */
  async pumpOnce(): Promise<void> {
    if (this.stopping) return
    for (const row of this.deps.store.listPendingOutbox()) {
      if (this.stopping || this.deps.signal.aborted) return
      await this.pumpOne(row)
    }
  }

  private async pumpOne(row: OutboxRow): Promise<void> {
    const claim = this.deps.store.claimOutbox(row.id, iso(this.deps.now))
    if (!claim.ok) return // cancelled / not pending
    const outbox = claim.outbox
    const controller = new AbortController()
    this.inFlight.set(outbox.id, controller)
    const signal = this.deps.signal.aborted
      ? controller.signal
      : AbortSignal.any([this.deps.signal, controller.signal])
    let sent = 0
    try {
      const chunks = chunkText(outbox.text, this.deps.maxChars ?? 4096)
      for (const chunk of chunks) {
        await this.deps.http.sendMessage(this.deps.chatId, chunk, undefined, signal)
        sent++
      }
      this.deps.store.finishOutbox(outbox.id, 'delivered', { deliveredAt: iso(this.deps.now) })
      this.touchDelivery(outbox, 'delivered')
    } catch (error) {
      const aborted = controller.signal.aborted || this.deps.signal.aborted
      const message = cleanError(error)
      if (aborted) {
        this.deps.store.finishOutbox(outbox.id, 'uncertain', { error: 'in-flight send aborted' })
        this.touchDelivery(outbox, 'uncertain', 'aborted')
      } else if (sent > 0) {
        // Partial chunks were accepted; the rest cannot be re-sent.
        this.deps.store.finishOutbox(outbox.id, 'uncertain', { error: `partial delivery: ${message}` })
        this.touchDelivery(outbox, 'uncertain', message)
      } else {
        this.deps.store.finishOutbox(outbox.id, 'failed', { error: message })
        this.touchDelivery(outbox, 'failed', message)
      }
    } finally {
      this.inFlight.delete(outbox.id)
    }
  }

  /** Surface result-delivery state on the commitment for status views. */
  private touchDelivery(outbox: OutboxRow, state: 'delivered' | 'failed' | 'uncertain', error?: string): void {
    if (outbox.kind === 'completed' || outbox.kind === 'blocked') {
      this.deps.store.touchLastDelivery(outbox.commitmentId, state, error)
    }
  }
}
