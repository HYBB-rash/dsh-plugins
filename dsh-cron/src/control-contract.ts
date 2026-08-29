/**
 * Versioned manager-owned control contract for dsh-cron.
 *
 * This module contains only the wire vocabulary and the local client shape.
 * It deliberately has no store, socket, scheduler, or background lifecycle
 * dependencies so the manager profile can expose the contract safely.
 */

import type {
  AgentEnvironmentMarker,
  CommandGate,
  CommandPayload,
  DeliverChannel,
  FailureAlertPolicy,
  ScheduleSpec,
} from './types.ts'

/**
 * The three fields that a maintenance migration is allowed to change on an
 * Agent job.  Every other persisted field is covered by the immutable
 * fingerprint and is copied byte-for-byte (after canonical JSON encoding).
 */
export interface AgentBinding {
  readonly sessionMode: 'persistent' | 'per_run'
  readonly agentEnvironment?: AgentEnvironmentMarker
  readonly externalRef?: string
}

/** A read-only, fail-closed view of one active Agent job. */
export interface AgentBindingInspection {
  readonly jobId: string
  readonly kind: 'agent'
  readonly immutableSha256: string
  readonly binding: AgentBinding
}

export type MaintenanceControlErrorCode =
  | 'invalid_request'
  | 'job_not_found'
  | 'wrong_kind'
  | 'immutable_mismatch'
  | 'binding_mismatch'
  | 'external_ref_conflict'
  | 'marker_gate_conflict'
  | 'persistence_uncertain'
  | 'verification_failed'
  | 'invalid_job_log'
  | 'timezone_mismatch'
  | 'migration_not_found'
  | 'migration_conflict'

export interface MaintenanceControlError {
  readonly ok: false
  readonly errorCode: MaintenanceControlErrorCode
  readonly message: string
}

/** Exact CAS request for one active Agent job. */
export interface TransitionAgentBindingRequest {
  readonly jobId: string
  readonly expectedImmutableSha256: string
  readonly expectedBinding: AgentBinding
  readonly desiredBinding: AgentBinding
}

export interface TransitionAgentBindingSuccess extends AgentBindingInspection {
  readonly ok: true
  readonly changed: boolean
}

export type TransitionAgentBindingResult =
  | TransitionAgentBindingSuccess
  | MaintenanceControlError

/** Exact offline request for the one UTC-to-Shanghai schedule cutover. */
export interface ReanchorCronSchedulesRequest {
  readonly migrationVersion: 1
  readonly migrationId: string
  readonly fromTimeZone: 'Etc/UTC'
  readonly toTimeZone: 'Asia/Shanghai'
  /** Exclusive lower bound used to calculate the first Shanghai occurrence. */
  readonly cutoverAt: string
  /** Audit time supplied once by the release and reused on exact retries. */
  readonly reanchoredAt: string
}

export interface ReanchoredCronJob {
  readonly jobId: string
  readonly scheduleSha256: string
  readonly nextRunAt: string
  readonly changed: boolean
}

export interface ReanchorCronSchedulesSuccess {
  readonly ok: true
  readonly changed: boolean
  readonly migrationVersion: 1
  readonly migrationId: string
  readonly inputSha256: string
  readonly cronJobCount: number
  readonly appendedCount: number
  readonly jobs: readonly ReanchoredCronJob[]
}

export type ReanchorCronSchedulesResult =
  | ReanchorCronSchedulesSuccess
  | MaintenanceControlError

/** Private-free evidence retained by an accepted release for one cron row. */
export interface ScheduleReanchorJobEvidence {
  readonly jobId: string
  readonly scheduleSha256: string
  readonly nextRunAt: string
}

/**
 * Exact accepted-release evidence used to prove that an inherited migration
 * is still present in the live run ledger.  Inspection never consults or
 * rewrites the current job definitions: normal post-cutover edits and runs do
 * not change the historical migration fact.
 */
export interface InspectScheduleReanchorMigrationRequest
  extends ReanchorCronSchedulesRequest {
  readonly inputSha256: string
  readonly cronJobCount: number
  readonly jobs: readonly ScheduleReanchorJobEvidence[]
}

export interface InspectScheduleReanchorMigrationSuccess
  extends InspectScheduleReanchorMigrationRequest {
  readonly ok: true
  readonly ledgerRecordCount: number
}

export type InspectScheduleReanchorMigrationResult =
  | InspectScheduleReanchorMigrationSuccess
  | MaintenanceControlError

/**
 * Narrow in-process maintenance port. It is intentionally not part of the
 * Unix-socket RPC client: deployment code imports this from the built package
 * root while online profiles retain the normal manager contract.
 */
export interface DshCronMaintenanceControl {
  inspectAgentBindingById(jobId: string): AgentBindingInspection | null
  transitionAgentBindingById(
    request: TransitionAgentBindingRequest,
  ): TransitionAgentBindingResult
  reanchorCronSchedules(
    request: ReanchorCronSchedulesRequest,
  ): ReanchorCronSchedulesResult
  inspectScheduleReanchorMigration(
    request: InspectScheduleReanchorMigrationRequest,
  ): InspectScheduleReanchorMigrationResult
}

/** The only control protocol version understood by this package. */
export const CONTROL_PROTOCOL_VERSION = 1 as const

/** The complete v1 RPC operation vocabulary. */
export const CONTROL_RPC_OPERATIONS = [
  'ensure-bound',
  'replace-bound',
  'delete-bound',
  'get-bound',
  'ensure-bound-command',
  'replace-bound-command',
  'get-bound-command',
  'update-bound-failure-alert',
] as const

export type ControlRpcOperation = (typeof CONTROL_RPC_OPERATIONS)[number]

/** The HTTP health route is intentionally separate from the RPC operations. */
export const CONTROL_HEALTH_METHOD = 'GET' as const
export const CONTROL_HEALTH_PATH = '/health' as const

/** Session lifetime for a cron job. */
export type CronSessionMode = 'persistent' | 'per_run'

/** A manager-owned external binding. */
export interface BoundCronSpec {
  readonly externalRef: string
  readonly schedule: ScheduleSpec
  readonly prompt: string
  readonly deliver: 'telegram'
  readonly cwd?: string
  readonly sessionMode: 'per_run'
  /** Optional exact provider-owned per-run Agent environment marker. */
  readonly agentEnvironment?: AgentEnvironmentMarker
  /** Optional fixed command whose non-empty stdout unlocks this Agent turn. */
  readonly gate?: CommandGate
  /** Optional throttled execution-failure notification policy. */
  readonly failureAlert?: FailureAlertPolicy
}

/**
 * A manager-owned zero-model command binding.  `argv` is executed directly,
 * never via a shell or Agent.  Bound command jobs are always fresh per run;
 * unlike agent bindings they have no prompt or model/session mode field.
 */
export interface BoundCronCommandSpec {
  readonly externalRef: string
  readonly schedule: ScheduleSpec
  readonly command: CommandPayload
  readonly deliver: 'telegram' | 'silent'
  /** Optional throttled execution-failure notification policy. */
  readonly failureAlert?: FailureAlertPolicy
  readonly cwd?: string
}

/** Execution outcome of one scheduled run. */
export type CronRunExecutionStatus = 'success' | 'error' | 'expired' | 'interrupted'

/** Delivery outcome, independent from execution outcome. */
export type CronRunDeliveryState = 'delivered' | 'silent' | 'not_requested' | 'failed' | 'uncertain'

/** Public observation of one run; execution and delivery are orthogonal. */
export interface CronRunSnapshot {
  readonly runId: string
  readonly jobId: string
  readonly scheduledFor: string
  readonly finishedAt: string
  readonly runStatus: CronRunExecutionStatus
  readonly summary?: string
  readonly error?: string
  readonly deliveryState: CronRunDeliveryState
  readonly deliveredAt?: string
  readonly deliveryError?: string
}

/** Public observation of one external binding. */
export interface BoundCronSnapshot {
  readonly externalRef: string
  readonly activeJob: BoundCronJobView | null
  readonly latestRun: CronRunSnapshot | null
}

/** Actual cron job state attached to a bound snapshot. */
export interface BoundCronJobView extends BoundCronSpec {
  readonly id: string
  readonly createdAt: string
}

/** Actual command job state attached to a command-bound snapshot. */
export interface BoundCronCommandJobView extends BoundCronCommandSpec {
  readonly id: string
  readonly createdAt: string
}

/**
 * Read-only projection used by repository release guards. Unlike a bound
 * snapshot, it also includes jobs without an externalRef so a whole-ledger
 * dependency scan cannot accidentally omit unmanaged active work.
 */
export type ActiveCronJobInspection =
  | {
      readonly kind: 'agent'
      readonly id: string
      readonly createdAt: string
      readonly externalRef?: string
      readonly schedule: ScheduleSpec
      readonly prompt: string
      readonly deliver: DeliverChannel
      readonly cwd?: string
      readonly sessionMode: CronSessionMode
      readonly agentEnvironment?: AgentEnvironmentMarker
      readonly gate?: CommandGate
      readonly failureAlert?: FailureAlertPolicy
    }
  | {
      readonly kind: 'command'
      readonly id: string
      readonly createdAt: string
      readonly externalRef?: string
      readonly schedule: ScheduleSpec
      readonly command: CommandPayload
      readonly deliver: 'telegram' | 'silent'
      readonly cwd?: string
      readonly failureAlert?: FailureAlertPolicy
    }

/** Public observation of one external command binding. */
export interface BoundCronCommandSnapshot {
  readonly externalRef: string
  readonly activeJob: BoundCronCommandJobView | null
  readonly latestRun: CronRunSnapshot | null
}

/** Readiness response returned by GET /health and the local client. */
export interface ControlHealthResponse {
  readonly protocolVersion: typeof CONTROL_PROTOCOL_VERSION
  readonly writer: 'manager'
  readonly ready: true
}

/** Base fields carried by every v1 control request. */
interface ControlRequestBase {
  readonly protocolVersion: typeof CONTROL_PROTOCOL_VERSION
}

/** Ensure a binding exists without replacing a conflicting existing spec. */
export interface EnsureBoundRequest extends ControlRequestBase {
  readonly operation: 'ensure-bound'
  readonly spec: BoundCronSpec
}

/** Replace the binding at the supplied external reference. */
export interface ReplaceBoundRequest extends ControlRequestBase {
  readonly operation: 'replace-bound'
  readonly spec: BoundCronSpec
}

/** Delete the binding identified by externalRef. */
export interface DeleteBoundRequest extends ControlRequestBase {
  readonly operation: 'delete-bound'
  readonly externalRef: string
}

/** Read the binding identified by externalRef. */
export interface GetBoundRequest extends ControlRequestBase {
  readonly operation: 'get-bound'
  readonly externalRef: string
}

/** Ensure a zero-model command binding exists without replacing it. */
export interface EnsureBoundCommandRequest extends ControlRequestBase {
  readonly operation: 'ensure-bound-command'
  readonly spec: BoundCronCommandSpec
}

/** Replace a zero-model command binding at its external reference. */
export interface ReplaceBoundCommandRequest extends ControlRequestBase {
  readonly operation: 'replace-bound-command'
  readonly spec: BoundCronCommandSpec
}

/** Read a zero-model command binding. */
export interface GetBoundCommandRequest extends ControlRequestBase {
  readonly operation: 'get-bound-command'
  readonly externalRef: string
}

/**
 * Update only the optional execution-failure notification policy attached to
 * one uniquely bound job. `null` explicitly clears the policy. The manager
 * preserves the job id, creation time, schedule, payload, delivery, cwd, and
 * session/gate fields by appending a complete same-id create row.
 */
export interface UpdateBoundFailureAlertRequest extends ControlRequestBase {
  readonly operation: 'update-bound-failure-alert'
  readonly externalRef: string
  readonly failureAlert: FailureAlertPolicy | null
}

/** The complete v1 request union; health is an HTTP endpoint, not an RPC op. */
export type ControlRequest =
  | EnsureBoundRequest
  | ReplaceBoundRequest
  | DeleteBoundRequest
  | GetBoundRequest
  | EnsureBoundCommandRequest
  | ReplaceBoundCommandRequest
  | GetBoundCommandRequest
  | UpdateBoundFailureAlertRequest

/** A successful v1 operation response. */
export interface ControlSuccessResponse {
  readonly protocolVersion: typeof CONTROL_PROTOCOL_VERSION
  readonly ok: true
  readonly operation: ControlRpcOperation
  readonly snapshot: BoundCronSnapshot
}

/** Successful command operation response. */
export interface CommandControlSuccessResponse {
  readonly protocolVersion: typeof CONTROL_PROTOCOL_VERSION
  readonly ok: true
  readonly operation: 'ensure-bound-command' | 'replace-bound-command' | 'get-bound-command'
  readonly snapshot: BoundCronCommandSnapshot
}

/** A policy-only update may target either an Agent or a command binding. */
export interface FailureAlertControlSuccessResponse {
  readonly protocolVersion: typeof CONTROL_PROTOCOL_VERSION
  readonly ok: true
  readonly operation: 'update-bound-failure-alert'
  readonly snapshot: BoundCronSnapshot | BoundCronCommandSnapshot
}

/** Bounded errors that may cross the manager control wire. */
export type ControlErrorCode =
  | 'invalid_request'
  | 'binding_conflict'
  | 'persistence_uncertain'
  | 'internal_error'

/** A failed v1 operation response. */
export interface ControlErrorResponse {
  readonly protocolVersion: typeof CONTROL_PROTOCOL_VERSION
  readonly ok: false
  readonly operation?: ControlRpcOperation
  readonly errorCode: ControlErrorCode
  readonly message: string
}

/** Every v1 RPC response is either a bounded success or bounded wire error. */
export type ControlResponse =
  | ControlSuccessResponse
  | CommandControlSuccessResponse
  | FailureAlertControlSuccessResponse
  | ControlErrorResponse

/** Errors local to a client transport; these never become wire error codes. */
export type DshCronControlClientErrorCode =
  | ControlErrorCode
  | 'control_unavailable'
  | 'timeout'
  | 'protocol_error'

/** Consumable local transport/client error; it never widens the wire error union. */
export interface DshCronControlClientError {
  readonly code: DshCronControlClientErrorCode
  readonly message: string
  readonly operation?: ControlRpcOperation
}

/** Local typed client for the v1 manager operations and readiness. */
export interface DshCronControlClient {
  ensureBound(spec: BoundCronSpec): Promise<ControlResponse | DshCronControlClientError>
  replaceBound(spec: BoundCronSpec): Promise<ControlResponse | DshCronControlClientError>
  deleteBound(externalRef: string): Promise<ControlResponse | DshCronControlClientError>
  getBound(externalRef: string): Promise<ControlResponse | DshCronControlClientError>
  ensureBoundCommand(spec: BoundCronCommandSpec): Promise<ControlResponse | DshCronControlClientError>
  replaceBoundCommand(spec: BoundCronCommandSpec): Promise<ControlResponse | DshCronControlClientError>
  getBoundCommand(externalRef: string): Promise<ControlResponse | DshCronControlClientError>
  updateBoundFailureAlert(
    externalRef: string,
    failureAlert: FailureAlertPolicy | null,
  ): Promise<ControlResponse | DshCronControlClientError>
  readiness(): Promise<ControlHealthResponse>
}
