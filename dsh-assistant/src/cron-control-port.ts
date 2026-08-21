/**
 * Assistant-owned control vocabulary for the dsh-cron bridge.
 *
 * This module is deliberately independent from dsh-cron.  The application
 * layer stores these DTOs and talks to this port; only the outer adapter knows
 * the manager's wire types and transport.
 */

export type AssistantCronSchedule =
  | { readonly kind: 'cron'; readonly expr: string }
  | { readonly kind: 'interval'; readonly minutes: number }
  | { readonly kind: 'once'; readonly runAt: string }

export interface AssistantCronBindingSpec {
  readonly externalRef: string
  readonly schedule: AssistantCronSchedule
  readonly prompt: string
  readonly cwd?: string
}

export interface AssistantCronActiveJob {
  readonly id: string
  readonly externalRef: string
  readonly schedule: AssistantCronSchedule
  readonly prompt: string
  readonly cwd?: string
  readonly createdAt: string
}

export type AssistantCronRunStatus = 'success' | 'error' | 'expired' | 'interrupted'
export type AssistantCronDeliveryState = 'delivered' | 'silent' | 'not_requested' | 'failed' | 'uncertain'

export interface AssistantCronLatestRun {
  readonly runId: string
  readonly jobId: string
  readonly scheduledFor: string
  readonly finishedAt: string
  readonly runStatus: AssistantCronRunStatus
  readonly summary?: string
  readonly error?: string
  readonly deliveryState: AssistantCronDeliveryState
  readonly deliveredAt?: string
  readonly deliveryError?: string
}

export interface AssistantCronBindingSnapshot {
  readonly externalRef: string
  readonly activeJob: AssistantCronActiveJob | null
  readonly latestRun: AssistantCronLatestRun | null
}

export type AssistantCronControlResult =
  | { readonly ok: true; readonly snapshot: AssistantCronBindingSnapshot }
  | { readonly ok: false; readonly code: string; readonly message: string }

export interface AssistantCronControlPort {
  ensureBound(spec: AssistantCronBindingSpec): Promise<AssistantCronControlResult>
  replaceBound(spec: AssistantCronBindingSpec): Promise<AssistantCronControlResult>
  deleteBound(externalRef: string): Promise<AssistantCronControlResult>
  getBound(externalRef: string): Promise<AssistantCronControlResult>
  readiness(): Promise<{ readonly state: 'ready' | 'unavailable'; readonly reason?: string }>
}
