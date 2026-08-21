import type { FeedbackPending } from './contract.ts'

/** A clock is supplied by the boundary so pending state is deterministic in tests. */
export interface PendingClock {
  now(): number
}

export interface PendingStore {
  get(conversationKey: string): FeedbackPending | undefined
  set(conversationKey: string, pending: FeedbackPending): void
  clear(conversationKey: string): void
  expire(): number
  unload(): void
}

export interface InMemoryPendingStoreOptions {
  readonly ttlMs: number
  readonly clock: PendingClock
}

interface PendingEntry {
  readonly pending: FeedbackPending
  readonly expiresAt: number
}

/** Process-local, one-slot-per-conversation pending state. It is never persisted. */
export class InMemoryPendingStore implements PendingStore {
  private readonly entries = new Map<string, PendingEntry>()

  constructor(private readonly options: InMemoryPendingStoreOptions) {
    if (!Number.isFinite(options.ttlMs) || options.ttlMs < 0) {
      throw new RangeError('pending TTL must be a non-negative finite number')
    }
  }

  get(conversationKey: string): FeedbackPending | undefined {
    const entry = this.entries.get(conversationKey)
    if (entry === undefined) return undefined
    if (this.hasExpired(entry, this.options.clock.now())) {
      this.entries.delete(conversationKey)
      return undefined
    }
    return entry.pending
  }

  set(conversationKey: string, pending: FeedbackPending): void {
    this.entries.set(conversationKey, {
      pending,
      expiresAt: this.options.clock.now() + this.options.ttlMs,
    })
  }

  clear(conversationKey: string): void {
    this.entries.delete(conversationKey)
  }

  expire(): number {
    const now = this.options.clock.now()
    let removed = 0
    for (const [conversationKey, entry] of this.entries) {
      if (!this.hasExpired(entry, now)) continue
      this.entries.delete(conversationKey)
      removed += 1
    }
    return removed
  }

  unload(): void {
    this.entries.clear()
  }

  private hasExpired(entry: PendingEntry, now: number): boolean {
    return now >= entry.expiresAt
  }
}
