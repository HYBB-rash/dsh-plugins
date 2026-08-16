/**
 * Reminder runtime for dsh-assistant (telegram mode): polls the durable state,
 * queues one deterministic check-in outbox per due reminder, and drives the
 * outbox pump. The scan and the pump are separate so a due reminder is
 * queued exactly once even across restarts and multiple pollers, and the
 * restart catch-up (including the >2h honest wording) falls out of the same
 * scan.
 * @module @deepseek-ai/dsh-assistant
 */

import { cleanError, renderMissedReminderText, renderReminderText } from './domain.ts'
import { AssistantStore } from './store.ts'
import { OutboxPump } from './outbox.ts'

export interface ReminderRuntimeDeps {
  store: AssistantStore
  pump?: OutboxPump
  pollIntervalMs: number
  lateReminderAfterMs: number
  signal: AbortSignal
  now?: () => number
  logger?: { warn(message: string): void }
}

function iso(now: (() => number) | undefined): string {
  return new Date(now === undefined ? Date.now() : now()).toISOString()
}

/**
 * One process-local reminder loop. `tick()` is the test seam: scan due
 * reminders, then pump the outbox.
 */
export class ReminderRuntime {
  private timer: ReturnType<typeof setInterval> | undefined
  private stopping = false

  constructor(private readonly deps: ReminderRuntimeDeps) {}

  start(): void {
    void this.tick()
    this.timer = setInterval(() => {
      void this.tick()
    }, this.deps.pollIntervalMs)
  }

  async dispose(): Promise<void> {
    this.stopping = true
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    await this.deps.pump?.stop()
  }

  /** One scan + pump round. */
  async tick(): Promise<void> {
    if (this.stopping || this.deps.signal.aborted) return
    const nowIso = iso(this.deps.now)
    try {
      this.deps.store.queueDueReminders(nowIso, this.deps.lateReminderAfterMs, (kind, row) =>
        kind === 'check_in' ? renderReminderText(row.title) : renderMissedReminderText(row.title))
    } catch (error) {
      this.deps.logger?.warn(`dsh-assistant: reminder scan failed: ${cleanError(error)}`)
    }
    await this.deps.pump?.pumpOnce()
  }

  /** Abort in-flight sends for one commitment via the pump. */
  abortInFlight(commitmentId: string): void {
    this.deps.pump?.abortCommitment(commitmentId)
  }
}
