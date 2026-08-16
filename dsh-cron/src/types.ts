/**
 * Shared durable types for the dsh-cron package.
 *
 * Storage layout (single-writer split, see the design doc):
 * - `jobs.jsonl` is written only by the manager role (append-only, tombstones).
 * - `runs.jsonl` is written only by the scheduler role (append-only audit).
 * @module @deepseek-ai/dsh-cron
 */

/** One of the three supported schedule kinds. */
export type ScheduleKind = 'cron' | 'interval' | 'once'

/** A cron or interval or one-shot schedule specification. */
export type ScheduleSpec =
  | { readonly kind: 'cron'; readonly expr: string }
  | { readonly kind: 'interval'; readonly minutes: number }
  | { readonly kind: 'once'; readonly runAt: string }

/** Delivery channel for a job's result. */
export type DeliverChannel = 'telegram' | 'silent'

/** One append-only line in jobs.jsonl. */
export type JobLogEntry =
  | {
      readonly op: 'create'
      readonly id: string
      readonly schedule: ScheduleSpec
      readonly prompt: string
      readonly deliver: DeliverChannel
      readonly cwd?: string
      readonly createdAt: string
    }
  | {
      readonly op: 'delete'
      readonly id: string
      readonly deletedAt: string
    }

/** A live job folded from the append-only job log. */
export interface Job {
  readonly id: string
  readonly schedule: ScheduleSpec
  readonly prompt: string
  readonly deliver: DeliverChannel
  readonly cwd?: string
  readonly createdAt: string
}

/** Folded view of the job log: active jobs plus every id ever seen. */
export interface FoldedJobs {
  readonly active: readonly Job[]
  readonly seenIds: readonly string[]
}

/** Terminal run status recorded in runs.jsonl. */
export type RunStatus = 'success' | 'error' | 'silent' | 'expired'

/** One append-only line in runs.jsonl. */
export interface RunRecord {
  readonly jobId: string
  readonly sessionId: string
  readonly startedAt: string
  readonly finishedAt: string
  readonly status: RunStatus
  readonly deliveredAt?: string
  readonly error?: string
  readonly outputPreview?: string
}

/**
 * V2 ledger event: a durable claim persisted BEFORE any Agent, tool, or
 * Telegram side effect. A claimed run must never be re-executed after a
 * restart, even if its finish never landed.
 */
export interface RunClaimRecord {
  readonly schemaVersion: 2
  readonly event: 'claim'
  /** Stable per trigger point, `jobId@<scheduledFor ISO>`; rebuild-stable. */
  readonly runId: string
  readonly jobId: string
  readonly sessionId: string
  /** The schedule time being consumed, not the actual start time. */
  readonly scheduledFor: string
  readonly claimedAt: string
  /** Crash-recovery anchor for recurring jobs (always in the future). */
  readonly nextRunAt?: string
}

/** V2 terminal statuses, including the crash-audit `interrupted` marker. */
export type RunFinishStatus = RunStatus | 'interrupted'

/** V2 ledger event: the terminal outcome of one claimed run. */
export interface RunFinishRecord {
  readonly schemaVersion: 2
  readonly event: 'finish'
  readonly runId: string
  readonly jobId: string
  readonly sessionId: string
  readonly scheduledFor: string
  readonly startedAt: string
  readonly finishedAt: string
  readonly status: RunFinishStatus
  /** Re-anchored from the actual finish time (recurring), or absent (once). */
  readonly nextRunAt?: string
  readonly deliveredAt?: string
  readonly error?: string
  readonly outputPreview?: string
}

/** Any V2 ledger event line. */
export type RunEventRecord = RunClaimRecord | RunFinishRecord

/**
 * Generic terminal-outcome event emitted by the scheduler AFTER a finish
 * append has truly persisted (§8). Observers (e.g. dsh-x-feed's delivery
 * receipt) may act on it, but the cron success/error and the Telegram
 * delivery are already final and must not be reverted or re-sent.
 *
 * The event deliberately excludes the cron prompt, the model's full output,
 * Telegram tokens/chat ids, and any user message or assistant context.
 */
export interface CronRunFinishedEvent {
  readonly jobId: string
  readonly runId: string
  readonly sessionId: string
  readonly scheduledFor: string
  readonly status: RunFinishStatus
  readonly deliveredAt?: string
  readonly error?: string
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    'dsh-cron/run-finished'(event: CronRunFinishedEvent): void | Promise<void>
  }
}

/** Stable machine-readable tool error code. */
export type CronToolErrorCode =
  | 'invalid_prompt'
  | 'invalid_schedule'
  | 'invalid_deliver'
  | 'cron_parse_error'
  | 'job_not_found'
  | 'internal_error'
  | 'persistence_uncertain'

/** One tool error value, always JSON-safe. */
export interface CronToolError {
  readonly code: CronToolErrorCode
  readonly message: string
  readonly operation?: 'create' | 'list' | 'delete'
  readonly id?: string
}

/** Success value of cron_create. */
export interface CronCreateValue {
  readonly id: string
  readonly schedule: ScheduleSpec
  readonly prompt: string
  readonly deliver: DeliverChannel
  readonly createdAt: string
}

/** One job row of cron_list. */
export interface CronJobView {
  readonly id: string
  readonly schedule: ScheduleSpec
  readonly prompt: string
  readonly deliver: DeliverChannel
  readonly createdAt: string
  readonly cwd?: string
}

/** Success value of cron_delete. */
export interface CronDeleteValue {
  readonly id: string
  readonly deleted: boolean
}

/** Allowed tool output union values. */
export type CronCreateOutput = CronCreateValue | CronToolError
export type CronListOutput = CronJobView[] | CronToolError
export type CronDeleteOutput =
  | CronDeleteValue
  | { readonly id: string; readonly deleted: false; readonly code: 'job_not_found' }
  | CronToolError
