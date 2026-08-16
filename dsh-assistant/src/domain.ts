/**
 * Pure domain for the dsh-assistant package: the commitment vocabulary, field
 * bounds, the update-action state machine, visible-text renderers, and the
 * worker result-protocol parser.
 *
 * This module must stay free of I/O, SQL, HTTP, and live Agent references so
 * every rule is unit-testable and shared by the store, tools, reminders,
 * outbox, and worker layers.
 * @module @deepseek-ai/dsh-assistant
 */

/** Who completes the work content: the user, or a delegated background agent. */
export type WorkOwner = 'user' | 'agent'

/** Product responsibility class: one user focus, or concurrent Agent work. */
export type ResponsibilityKind = 'focus' | 'delegated' | 'monitor'

/** Long-running monitor intent survives process restarts until user cancel. */
export type MonitorDesiredState = 'none' | 'running' | 'paused'

/** Durable cold-resume handshake state for a monitor worker. */
export type MonitorResumeState = 'none' | 'needed' | 'claimed'

/** Enforce the only valid kind/owner combinations. */
export function validateResponsibilityKind(
  kind: ResponsibilityKind,
  owner: WorkOwner,
): { readonly ok: true } | { readonly ok: false; readonly message: string } {
  if (kind === 'focus') {
    return owner === 'user'
      ? { ok: true }
      : { ok: false, message: 'focus responsibilities must be user-owned.' }
  }
  return owner === 'agent'
    ? { ok: true }
    : { ok: false, message: 'delegated and monitor responsibilities must be agent-owned.' }
}

/** Lifecycle shared by focus, delegated, and monitor responsibilities. */
export type CommitmentStatus =
  | 'pending'
  | 'active'
  | 'paused'
  | 'blocked'
  | 'completed'
  | 'cancelled'

/** Reminder lifecycle on a user-owned commitment. */
export type ReminderState =
  | 'none'
  | 'scheduled'
  | 'queued'
  | 'delivered'
  | 'failed'
  | 'uncertain'
  | 'cancelled'

/** In-process worker control intent; cleared when the runtime confirms it. */
export type WorkerControlState = 'none' | 'pause_requested' | 'resume_requested'

/** Which surface created/controls the commitment. */
export type SourceSurface = 'web' | 'telegram'

/** Outbox message kinds (landing guide §6.2). */
export type OutboxKind = 'check_in' | 'completed' | 'blocked' | 'missed_check_in' | 'progress'

/** Outbox lifecycle states (landing guide §6.2). */
export type OutboxState = 'pending' | 'claimed' | 'delivered' | 'failed' | 'uncertain' | 'cancelled'

/** Statuses for responsibilities that have not reached a terminal state. */
export const OPEN_STATUSES: readonly CommitmentStatus[] = ['pending', 'active', 'paused', 'blocked']

/** Whether a responsibility has not reached a terminal state. */
export function isOpenStatus(status: CommitmentStatus): boolean {
  return OPEN_STATUSES.includes(status)
}

/** Field bounds from the landing guide §6.3. */
export const TITLE_MAX = 500
export const TEXT_MAX = 5000
export const CHECK_IN_MIN = 1
export const CHECK_IN_MAX = 10080

/** Validate a commitment title; returns an English stable error or undefined. */
export function validateTitle(value: unknown): string | undefined {
  if (typeof value !== 'string') return 'title must be a string.'
  const trimmed = value.trim()
  if (trimmed.length < 1) return 'title must not be empty.'
  if (trimmed.length > TITLE_MAX) return `title must be at most ${TITLE_MAX} characters.`
  return undefined
}

/** Validate a check-in interval in minutes; returns an error or undefined. */
export function validateCheckInMinutes(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    return 'checkInMinutes must be a positive safe integer.'
  }
  if (value < CHECK_IN_MIN || value > CHECK_IN_MAX) {
    return `checkInMinutes must be between ${CHECK_IN_MIN} and ${CHECK_IN_MAX}.`
  }
  return undefined
}

/** Bound long free text for storage and Telegram delivery. */
export function boundText(text: string, max = TEXT_MAX): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/** Stable machine-readable tool error codes (§8.5). */
export type ToolErrorCode =
  | 'current_commitment_exists'
  | 'no_current_commitment'
  | 'ambiguous_commitment'
  | 'invalid_transition'
  | 'wrong_work_owner'
  | 'wrong_control_surface'
  | 'worker_start_failed'
  | 'worker_control_failed'
  | 'persistence_failed'
  | 'delivery_uncertain'

/** One JSON-safe tool error value. */
export interface ToolError {
  readonly code: ToolErrorCode
  readonly message: string
}

/** The model-facing actions of `assistant_task_update` (§8.4). */
export type UpdateAction =
  | 'pause'
  | 'resume'
  | 'still_working'
  | 'block'
  | 'complete'
  | 'cancel'
  | 'set_next_action'

/** A parsed worker result-protocol settlement (§11.2). */
export type WorkerSettlement =
  | {
    readonly status: 'completed'
    readonly summary: string
    readonly evidence?: readonly string[]
  }
  | {
    readonly status: 'blocked'
    readonly summary: string
    readonly blocker: string
    readonly nextAction?: string
  }

/** Outcome of parsing one worker's final output. */
export type WorkerResultParse =
  | { readonly kind: 'settlement'; readonly settlement: WorkerSettlement; readonly body: string }
  | { readonly kind: 'invalid'; readonly reason: string; readonly body: string }

/** The exact protocol prefix a worker's last non-empty line must carry. */
export const WORKER_RESULT_PREFIX = 'DSH_ASSISTANT_RESULT '

/** Last non-empty line of a text body (protocol line candidate). */
export function lastNonEmptyLine(text: string): string {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim()
    if (line !== '') return line
  }
  return ''
}

/** Text body without the trailing protocol line (for delivery). */
export function stripProtocolLine(text: string): string {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.trim() !== '') {
      if (lines[i]!.trimStart().startsWith(WORKER_RESULT_PREFIX)) lines.splice(i, 1)
      break
    }
  }
  return lines.join('\n').trim()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') return undefined
    out.push(item)
  }
  return out
}

/**
 * Parse a worker's final text according to the strict result protocol.
 * Only the last non-empty line is inspected; the marker prefix must match
 * exactly and the payload must pass the strict schema.
 */
export function parseWorkerResult(text: string): WorkerResultParse {
  const body = stripProtocolLine(text)
  const line = lastNonEmptyLine(text)
  if (!line.startsWith(WORKER_RESULT_PREFIX)) {
    return { kind: 'invalid', reason: 'missing DSH_ASSISTANT_RESULT marker', body }
  }
  const payload = line.slice(WORKER_RESULT_PREFIX.length).trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    return { kind: 'invalid', reason: 'protocol payload is not valid JSON', body }
  }
  if (!isRecord(parsed)) {
    return { kind: 'invalid', reason: 'protocol payload must be a JSON object', body }
  }
  const status = parsed.status
  const summary = asString(parsed.summary)
  if (status === 'completed') {
    if (summary === undefined || summary.trim() === '') {
      return { kind: 'invalid', reason: 'completed settlement requires a non-empty summary', body }
    }
    const evidence = asStringArray(parsed.evidence)
    if (parsed.evidence !== undefined && evidence === undefined) {
      return { kind: 'invalid', reason: 'evidence must be an array of strings', body }
    }
    const settlement: WorkerSettlement = evidence !== undefined && evidence.length > 0
      ? { status: 'completed', summary: summary.trim(), evidence }
      : { status: 'completed', summary: summary.trim() }
    return { kind: 'settlement', settlement, body }
  }
  if (status === 'blocked') {
    const blocker = asString(parsed.blocker)
    if (blocker === undefined || blocker.trim() === '') {
      return { kind: 'invalid', reason: 'blocked settlement requires a non-empty blocker', body }
    }
    const nextAction = asString(parsed.nextAction)
    const settlement: WorkerSettlement = nextAction !== undefined && nextAction.trim() !== ''
      ? {
        status: 'blocked',
        summary: summary === undefined ? '' : summary.trim(),
        blocker: blocker.trim(),
        nextAction: nextAction.trim(),
      }
      : {
        status: 'blocked',
        summary: summary === undefined ? '' : summary.trim(),
        blocker: blocker.trim(),
      }
    return { kind: 'settlement', settlement, body }
  }
  return { kind: 'invalid', reason: `unknown protocol status "${String(status)}"`, body }
}

/** Validate one `assistant_task_update` action against the current state. */
export interface UpdateValidationInput {
  readonly action: UpdateAction
  readonly workOwner: WorkOwner
  readonly status: CommitmentStatus
  readonly mode: 'web' | 'telegram'
  readonly hasLiveWorker: boolean
}

export type UpdateValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: ToolErrorCode; readonly message: string }

/**
 * The update-action state machine (§7). Returns the reason when the action is
 * rejected for the current commitment; `ok: true` otherwise.
 */
export function validateUpdate(input: UpdateValidationInput): UpdateValidation {
  const { action, workOwner, status, mode } = input
  switch (action) {
    case 'pause':
      if (status === 'paused') {
        return { ok: false, code: 'invalid_transition', message: 'The commitment is already paused.' }
      }
      if (workOwner === 'agent' && mode === 'web') {
        return {
          ok: false,
          code: 'wrong_control_surface',
          message: 'Agent-owned commitments are controlled from Telegram.',
        }
      }
      if (status !== 'active') {
        return { ok: false, code: 'invalid_transition', message: `Cannot pause a ${status} commitment.` }
      }
      return { ok: true }
    case 'resume':
      if (workOwner === 'agent' && mode === 'web') {
        return {
          ok: false,
          code: 'wrong_control_surface',
          message: 'Agent-owned commitments are controlled from Telegram.',
        }
      }
      if (status !== 'paused' && status !== 'blocked') {
        return { ok: false, code: 'invalid_transition', message: `Cannot resume a ${status} commitment.` }
      }
      return { ok: true }
    case 'still_working':
      if (workOwner === 'agent') {
        return {
          ok: false,
          code: 'wrong_work_owner',
          message: 'still_working applies only to user-owned commitments.',
        }
      }
      if (status !== 'active') {
        return { ok: false, code: 'invalid_transition', message: `Cannot mark a ${status} commitment as still working.` }
      }
      return { ok: true }
    case 'block':
      if (workOwner === 'agent') {
        return {
          ok: false,
          code: 'wrong_work_owner',
          message: 'Agent-owned commitments become blocked only through the worker result contract.',
        }
      }
      if (status !== 'pending' && status !== 'active') {
        return { ok: false, code: 'invalid_transition', message: `Cannot block a ${status} commitment.` }
      }
      return { ok: true }
    case 'complete':
      if (workOwner === 'agent') {
        return {
          ok: false,
          code: 'wrong_work_owner',
          message: 'Agent-owned commitments complete only through the worker result contract.',
        }
      }
      if (status === 'completed') {
        return { ok: false, code: 'invalid_transition', message: 'The commitment is already completed.' }
      }
      if (status === 'cancelled') {
        return { ok: false, code: 'invalid_transition', message: 'The commitment was cancelled.' }
      }
      return { ok: true }
    case 'cancel':
      if (workOwner === 'agent' && mode === 'web') {
        return {
          ok: false,
          code: 'wrong_control_surface',
          message: 'Agent-owned commitments are controlled from Telegram.',
        }
      }
      if (status === 'completed' || status === 'cancelled') {
        return { ok: false, code: 'invalid_transition', message: `Cannot cancel a ${status} commitment.` }
      }
      return { ok: true }
    case 'set_next_action':
      if (status === 'completed' || status === 'cancelled') {
        return { ok: false, code: 'invalid_transition', message: `Cannot update a ${status} commitment.` }
      }
      return { ok: true }
    default: {
      const exhaustive: never = action
      return { ok: false, code: 'invalid_transition', message: `Unknown action "${String(exhaustive)}".` }
    }
  }
}

/** Add whole minutes to an ISO instant (pure; `now` is the anchor clock). */
export function addMinutes(iso: string, minutes: number, now: () => number): string {
  const base = Number.isFinite(Date.parse(iso)) ? Date.parse(iso) : now()
  return new Date(base + minutes * 60_000).toISOString()
}

/** Local clock formatting for user-facing "我会在 HH:MM 回来问你" text. */
export function formatLocalTime(iso: string): string {
  const date = new Date(iso)
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

/** Render the user-visible acceptance text for a tracked user task (§10.1). */
export function renderTrackAccepted(input: {
  title: string
  nextContactAt: string | null
}): string {
  const lines = [`- [ ] ${input.title}`, '事情由你做，跟进由我负责。', '状态：进行中']
  if (input.nextContactAt !== null) {
    lines.push(`我会在 ${formatLocalTime(input.nextContactAt)} 回来问你。`)
  }
  return lines.join('\n')
}

/** Render the user-visible acceptance text for a delegated agent task (§8.3). */
export function renderDelegateAccepted(input: { title: string }): string {
  return [
    `- [ ] ${input.title}`,
    '归属：我来做',
    '状态：进行中',
    '我已经接下这件事；完成或受阻时会主动告诉你。',
  ].join('\n')
}

/** Render an ordinary due reminder (§10.2). */
export function renderReminderText(title: string): string {
  return `⏰ 到时间了：${title}\n\n还在做、先休息，还是已经完成？`
}

/** Render a catch-up reminder after an offline gap > lateReminderAfterMs (§10.3). */
export function renderMissedReminderText(title: string): string {
  return `⏰ 我在离线期间错过了这次跟进：${title}\n\n你还在做、先休息，还是已经完成？`
}

/** Render the active delivery for a completed worker task (§11.3). */
export function renderCompletedDelivery(title: string, body: string): string {
  return `✅ 我负责的事情已完成：${title}\n\n${body}`
}

/** Render the active delivery for a blocked worker task (§11.3). */
export function renderBlockedDelivery(input: {
  title: string
  summary: string
  blocker: string
  nextAction?: string
}): string {
  const lines = [
    `⚠️ 我负责的事情受阻：${input.title}`,
    '',
    `已经做到：${input.summary}`,
    `阻断：${input.blocker}`,
  ]
  if (input.nextAction !== undefined && input.nextAction.trim() !== '') {
    lines.push(`下一步需要：${input.nextAction}`)
  }
  return lines.join('\n')
}

/** Bounded partial-output preservation for failed/invalid worker ends. */
export function boundedPartial(text: string, max = 1000): string {
  const trimmed = text.trim()
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`
}

/**
 * Clean an error for storage/logs: no tokens, no full URLs, no message
 * bodies. Never used for user-facing text.
 */
export function cleanError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const bounded = message.length > 300 ? `${message.slice(0, 299)}…` : message
  return bounded
    .replace(/bot\d+:[\w-]+/g, 'bot<redacted>')
    .replace(/https?:\/\/[^\s]*(bot|token)[^\s]*/gi, '<redacted-url>')
}
