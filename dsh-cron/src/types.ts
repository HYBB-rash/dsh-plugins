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

/** Session lifetime persisted on a job; legacy rows default to persistent. */
export type JobSessionMode = 'persistent' | 'per_run'

/**
 * Stable provider-owned marker for a bounded Agent environment.
 *
 * Markers are intentionally syntax-only in dsh-cron. A provider registry
 * resolves the exact value later; cron never infers a provider from a prompt
 * or from any X/feed-specific field.
 */
export type AgentEnvironmentMarker = string

/** Canonical marker grammar: lower-kebab namespace followed by `/v<positive>`. */
export const AGENT_ENVIRONMENT_MARKER_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*\/v[1-9][0-9]*$/

/** Validate a persisted marker without trimming or normalizing it. */
export function isCanonicalAgentEnvironmentMarker(value: unknown): value is AgentEnvironmentMarker {
  return typeof value === 'string'
    && value === value.trim()
    && AGENT_ENVIRONMENT_MARKER_PATTERN.test(value)
}

/**
 * An exact, shell-free command payload.  Command jobs are intentionally kept
 * separate from agent prompts: the scheduler invokes this argv directly and
 * never creates an Agent or asks a model to reproduce it.
 */
export interface CommandPayload {
  readonly argv: readonly string[]
  readonly timeoutSeconds: number
  readonly outputMaxBytes: number
}

/**
 * A narrow mechanical gate for an Agent job. The command runs first with the
 * same cwd as the job: empty/whitespace stdout means "do not start an Agent",
 * while non-empty stdout becomes bounded, untrusted input for one per-run
 * Agent turn. Command failure is an execution error, never a silent decision.
 */
export interface CommandGate {
  readonly kind: 'nonempty_stdout'
  readonly command: CommandPayload
}

/**
 * Per-job execution-failure notification policy. This throttles only the
 * scheduler's error notice; it never retries the business command/Agent turn
 * and it does not reinterpret a Telegram delivery failure as an execution
 * failure.
 */
export interface FailureAlertPolicy {
  /** First notice is eligible on this many consecutive execution errors. */
  readonly after: number
  /** Minimum time between durable notice claims for this job. */
  readonly cooldownMinutes: number
}

/** Hard upper bounds for unattended direct commands. */
export const MAX_COMMAND_TIMEOUT_SECONDS = 3_600
export const MAX_COMMAND_OUTPUT_BYTES = 1_048_576
export const MAX_FAILURE_ALERT_AFTER = 100
export const MAX_FAILURE_ALERT_COOLDOWN_MINUTES = 10_080
/** Maximum durable provider text size, measured in UTF-8 bytes. */
export const MAX_PREPARED_TEXT_BYTES = 64 * 1024
/** Maximum durable provider object identity size, measured in UTF-8 bytes. */
export const MAX_PREPARED_OBJECT_ID_BYTES = 1024

/** Delivery outcome kept orthogonal to the legacy run status field. */
export type RunDeliveryState = 'delivered' | 'silent' | 'not_requested' | 'failed' | 'uncertain'

/** Trusted terminal state for one prepared delivery object. */
export type CronDeliveryState = Extract<RunDeliveryState, 'delivered' | 'failed' | 'uncertain'>

/** Exact prepared object owned by a provider and delivered by cron. */
export interface PreparedDeliveryObject {
  readonly objectId: string
  readonly text: string
}

/** Validate exact provider-owned delivery facts before durable preparation. */
export function isValidPreparedObjectId(value: unknown): value is string {
  return typeof value === 'string'
    && value.trim() !== ''
    && value === value.trim()
    && new TextEncoder().encode(value).byteLength <= MAX_PREPARED_OBJECT_ID_BYTES
}

export function isValidPreparedDeliveryObject(value: unknown): value is PreparedDeliveryObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const object = value as Record<string, unknown>
  if (!isValidPreparedObjectId(object.objectId)) return false
  if (typeof object.text !== 'string' || object.text.trim() === '') return false
  return new TextEncoder().encode(object.text).byteLength <= MAX_PREPARED_TEXT_BYTES
}

/** Generic receipt fact that is durable before the technical finish event. */
export interface CronDeliveryReceipt {
  readonly objectId: string
  readonly jobId: string
  readonly runId: string
  readonly sessionId: string
  readonly scheduledFor: string
  readonly deliveryState: CronDeliveryState
  readonly deliveredAt?: string
  readonly deliveryError?: string
}

/** One append-only line in jobs.jsonl. */
export type JobLogEntry =
  | {
      readonly op: 'create'
      /** Omitted by legacy rows; explicit undefined only documents the union. */
      readonly kind?: undefined
      readonly id: string
      readonly schedule: ScheduleSpec
      readonly prompt: string
      readonly deliver: DeliverChannel
      readonly externalRef?: string
      readonly sessionMode?: JobSessionMode
      readonly agentEnvironment?: AgentEnvironmentMarker
      readonly gate?: CommandGate
      readonly failureAlert?: FailureAlertPolicy
      readonly cwd?: string
      readonly createdAt: string
    }
  | {
      readonly op: 'create'
      /** Discriminant absent from all legacy agent rows. */
      readonly kind: 'command'
      readonly id: string
      readonly schedule: ScheduleSpec
      readonly command: CommandPayload
      readonly deliver: DeliverChannel
      readonly externalRef?: string
      readonly failureAlert?: FailureAlertPolicy
      readonly cwd?: string
      readonly createdAt: string
    }
  | {
      readonly op: 'delete'
      readonly id: string
      readonly deletedAt: string
    }

/** A live job folded from the append-only job log. */
export interface AgentJob {
  /** Omitted by legacy JSON rows; keeps the Job union discriminated in TS. */
  readonly kind?: undefined
  readonly id: string
  readonly externalRef?: string
  readonly schedule: ScheduleSpec
  readonly prompt: string
  readonly deliver: DeliverChannel
  readonly sessionMode: JobSessionMode
  readonly agentEnvironment?: AgentEnvironmentMarker
  readonly gate?: CommandGate
  readonly failureAlert?: FailureAlertPolicy
  readonly cwd?: string
  readonly createdAt: string
}

/** A zero-model scheduled command. */
export interface CommandJob {
  readonly kind: 'command'
  readonly id: string
  readonly externalRef?: string
  readonly schedule: ScheduleSpec
  readonly command: CommandPayload
  readonly deliver: DeliverChannel
  readonly failureAlert?: FailureAlertPolicy
  readonly cwd?: string
  readonly createdAt: string
}

/** Every active job.  Legacy rows always materialize as AgentJob. */
export type Job = AgentJob | CommandJob

/** Structured replay evidence for a create row rejected by job validation. */
export type JobLogValidationErrorCode =
  | 'invalid_create'
  | 'invalid_agent_environment_marker'
  | 'agent_environment_requires_per_run'
  | 'agent_environment_forbids_gate'
  | 'agent_environment_not_allowed_on_command'

export interface InvalidJobLogEntry {
  /** One-based physical line number in jobs.jsonl. */
  readonly line: number
  readonly id?: string
  readonly code: JobLogValidationErrorCode
  readonly message: string
}

/** Folded view of the job log: active jobs plus every id ever seen. */
export interface FoldedJobs {
  readonly active: readonly Job[]
  readonly seenIds: readonly string[]
  /** Present only when one or more parsed create rows were isolated. */
  readonly invalid?: readonly InvalidJobLogEntry[]
}

/** Terminal run status recorded in runs.jsonl. */
export type RunStatus = 'success' | 'error' | 'silent' | 'expired'

/** V2 execution trigger; omitted on old rows means the natural schedule. */
export type RunTrigger = 'scheduled' | 'manual'

/** One append-only line in runs.jsonl. */
export interface RunRecord {
  readonly jobId: string
  readonly sessionId: string
  readonly startedAt: string
  readonly finishedAt: string
  readonly status: RunStatus
  readonly deliveredAt?: string
  readonly deliveryState?: RunDeliveryState
  readonly deliveryError?: string
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
  /** Omitted on legacy V2 rows; parse/fold treats it as `scheduled`. */
  readonly trigger?: RunTrigger
  /** Stable per trigger point, `jobId@<scheduledFor ISO>`; rebuild-stable. */
  readonly runId: string
  readonly jobId: string
  readonly sessionId: string
  /** The schedule time being consumed, not the actual start time. */
  readonly scheduledFor: string
  readonly claimedAt: string
  /** Persisted provider marker for a declared prepared-delivery lifecycle. */
  readonly agentEnvironment?: AgentEnvironmentMarker
  readonly deliveryLifecycle?: 'prepared'
  /** Crash-recovery anchor for recurring jobs (always in the future). */
  readonly nextRunAt?: string
}

/**
 * Durable claim for one failure-alert attempt. It lands before Telegram is
 * touched, so a scheduler restart or an ambiguous send cannot bypass the
 * per-job cooldown and cause an immediate duplicate notice.
 */
export interface RunFailureAlertClaimRecord {
  readonly schemaVersion: 2
  readonly event: 'failure-alert-claim'
  readonly runId: string
  readonly jobId: string
  readonly claimedAt: string
}

/** Durable acknowledgement written only after a business environment settles. */
export interface RunEnvironmentSettleRecord {
  readonly schemaVersion: 2
  readonly event: 'environment-settle'
  readonly runId: string
  readonly jobId: string
  readonly settledAt: string
}

/** Durable exact prepared object, written before any transport side effect. */
export interface RunPreparedDeliveryRecord extends PreparedDeliveryObject {
  readonly schemaVersion: 2
  readonly event: 'prepared-delivery'
  readonly jobId: string
  readonly runId: string
  readonly sessionId: string
  readonly scheduledFor: string
  readonly preparedAt: string
}

/** Durable claim for the one transport attempt of a prepared object. */
export interface RunDeliveryAttemptClaimRecord {
  readonly schemaVersion: 2
  readonly event: 'delivery-attempt-claim'
  readonly jobId: string
  readonly runId: string
  readonly sessionId: string
  readonly scheduledFor: string
  readonly claimedAt: string
  readonly objectId: string
}

/** Durable object-level trusted transport receipt. */
export interface RunDeliveryReceiptRecord extends CronDeliveryReceipt {
  readonly schemaVersion: 2
  readonly event: 'delivery-receipt'
  readonly receiptAt: string
}

/** Durable technical acknowledgement of a successful pre-finish hook. */
export interface RunEnvironmentPrefinishSettleRecord extends CronDeliveryReceipt {
  readonly schemaVersion: 2
  readonly event: 'environment-prefinish-settle'
  readonly settledAt: string
}

export const PREPARED_DELIVERY_EVENT = 'prepared-delivery' as const
export const DELIVERY_ATTEMPT_CLAIM_EVENT = 'delivery-attempt-claim' as const
export const DELIVERY_RECEIPT_EVENT = 'delivery-receipt' as const
export const ENVIRONMENT_PREFINISH_SETTLE_EVENT = 'environment-prefinish-settle' as const

/** V2 terminal statuses, including the crash-audit `interrupted` marker. */
export type RunFinishStatus = RunStatus | 'interrupted'

/** V2 ledger event: the terminal outcome of one claimed run. */
export interface RunFinishRecord {
  readonly schemaVersion: 2
  readonly event: 'finish'
  /** Omitted on legacy V2 rows; parse/fold treats it as `scheduled`. */
  readonly trigger?: RunTrigger
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
  readonly deliveryState?: RunDeliveryState
  readonly deliveryError?: string
  readonly error?: string
  readonly outputPreview?: string
}

/** Any V2 ledger event line. */
export type RunEventRecord =
  | RunClaimRecord
  | RunFailureAlertClaimRecord
  | RunFinishRecord
  | RunEnvironmentSettleRecord
  | RunPreparedDeliveryRecord
  | RunDeliveryAttemptClaimRecord
  | RunDeliveryReceiptRecord
  | RunEnvironmentPrefinishSettleRecord

/** Every durable run line, including the legacy V1 terminal shape. */
export type RunHistoryRecord = RunRecord | RunEventRecord

/**
 * Generic terminal-outcome event emitted by the scheduler AFTER a finish
 * append has truly persisted (§8). A matching environment settlement
 * callback may act on it, but the cron success/error and the Telegram
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
  readonly deliveryState?: RunDeliveryState
  readonly deliveryError?: string
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
