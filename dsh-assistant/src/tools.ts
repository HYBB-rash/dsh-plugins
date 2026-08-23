/**
 * Model tools for the dsh-assistant package: `assistant_task_status`,
 * `assistant_track_task`, `assistant_delegate_task` (telegram only), and
 * `assistant_task_update`. Names carry the ownership split so the model never
 * mixes "I do it" with "you do it".
 * @module @deepseek-ai/dsh-assistant
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  renderDelegateAccepted,
  renderTrackAccepted,
  isOpenStatus,
  validateCheckInMinutes,
  validateTitle,
  validateUpdate,
  type CommitmentStatus,
  type ResponsibilityKind,
  type ToolError,
  type UpdateAction,
  type WorkOwner,
  type WorkerControlState,
} from './domain.ts'
import { AssistantStore, type CommitmentRow, type CronBindingRow, type OutboxRow, type WriteResult } from './store.ts'
import { WorkerController, writeResultToToolError } from './worker.ts'
import { queryWebTasks } from './observer.ts'
import type { AssistantCronSchedule } from './cron-control-port.ts'
import type { CronControlUseCase } from './cron-control.ts'

/** The model-facing view of one commitment (§8.1). */
export type CommitmentView = {
  readonly id: string
  readonly title: string
  readonly workOwner: WorkOwner
  readonly kind: ResponsibilityKind
  readonly status: CommitmentStatus
  readonly nextAction: string | null
  readonly nextContactAt: string | null
  /** Current scheduling/delivery state for a user-owned check-in. */
  readonly checkInState: 'none' | 'scheduled' | 'queued' | 'delivered' | 'failed' | 'uncertain' | 'cancelled'
  /** Most recent check-in outbox outcome, kept even after a later re-arm. */
  readonly lastCheckInDeliveryState: 'delivered' | 'failed' | 'uncertain' | 'cancelled' | null
  readonly lastCheckInDeliveryError: string | null
  readonly result: string | null
  readonly progressSummary: string | null
  readonly progressAt: string | null
  /** Bounded delivery/control facts plus opaque monitor facts; never includes event bodies or outbox text. */
  readonly lastDeliveryState: string | null
  readonly lastDeliveryError: string | null
  readonly hasWorker: boolean
  /** Bounded worker lifecycle control intent; pause/resume requests can coexist with an identity. */
  readonly workerControlState: WorkerControlState
  readonly monitorDesiredState: string | null
  readonly monitorResumeState: string | null
  readonly monitorDirection: string | null
  readonly monitorCheckpoint: string | null
  readonly monitorEventKey: string | null
  readonly monitorProposedCheckpoint: string | null
  readonly monitorEventDeliveryState: string | null
  readonly monitorEventDeliveryError: string | null
  /** Assistant-owned Cron facts; independent from worker progress and outbox delivery. */
  readonly cronBinding: CronBindingView | null
  readonly controlSurface: 'web' | 'telegram'
  readonly revision: number
}

export type CronBindingView = {
  readonly desiredState: string
  readonly schedule: AssistantCronSchedule | null
  readonly desiredCwd: string | null
  readonly boundJobId: string | null
  readonly controlError: string | null
  readonly lastRun: {
    readonly runId: string
    readonly jobId: string
    readonly scheduledFor: string
    readonly finishedAt: string
    readonly runStatus: string
    readonly summary: string | null
    readonly runError: string | null
    readonly deliveryState: string
    readonly deliveryError: string | null
  } | null
}

/** The recent-closure view, for failed/uncertain deliveries (§8.1). */
export type LastClosedView = {
  readonly id: string
  readonly title: string
  readonly workOwner: WorkOwner
  readonly status: 'completed' | 'cancelled'
  readonly result: string | null
  readonly completedAt: string | null
  readonly lastDeliveryState: string | null
  readonly lastDeliveryError: string | null
  readonly revision: number
}

/** `assistant_task_status` output. */
export type StatusOutput = {
  readonly current: CommitmentView | null
  readonly responsibilities: CommitmentView[]
  readonly totalOpen: number
  readonly truncated: boolean
  /** Up to three Telegram Agent closures; includes result for explicit recovery. */
  readonly recentAgentClosures: LastClosedView[]
  /** Legacy one-row compatibility field. */
  readonly lastClosed: LastClosedView | null
}

/** Success output shared by the mutating tools. */
export type MutationOutput = {
  readonly current: CommitmentView
  readonly reply: string
}

/** One stable tool error value (always JSON-safe). */
export type AssistantToolError = ToolError & {
  readonly current?: CommitmentView
  readonly candidates?: CommitmentView[]
}

export interface AssistantToolDeps {
  store: AssistantStore
  mode: 'web' | 'telegram'
  worker?: WorkerController
  /** Formal assistant-owned Cron control; the manager client stays outside this module. */
  cronControl?: CronControlUseCase
  now?: () => number
  abortInFlight?: (commitmentId: string) => void
  logger?: { warn(message: string): void }
}

function parseCronSchedule(value: unknown): AssistantCronSchedule | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const candidate = value as Record<string, unknown>
  if (candidate.kind === 'cron' && typeof candidate.expr === 'string') {
    const expr = candidate.expr.trim()
    // The assistant owns the DTO boundary, so reject an obviously malformed
    // cron shape before creating a commitment or making a manager RPC.  Field
    // ranges and expression semantics remain the generic dsh-cron contract.
    if (expr !== '' && expr.split(/\s+/).length === 5) return { kind: 'cron', expr }
  }
  if (candidate.kind === 'interval' && typeof candidate.minutes === 'number'
    && Number.isSafeInteger(candidate.minutes) && candidate.minutes > 0) {
    return { kind: 'interval', minutes: candidate.minutes }
  }
  if (candidate.kind === 'once' && typeof candidate.runAt === 'string') {
    const runAt = candidate.runAt.trim()
    if (runAt !== '' && Number.isFinite(Date.parse(runAt))) return { kind: 'once', runAt }
  }
  return undefined
}

function isToolErrorCode(value: string): value is ToolError['code'] {
  switch (value) {
    case 'current_commitment_exists':
    case 'no_current_commitment':
    case 'ambiguous_commitment':
    case 'invalid_transition':
    case 'wrong_work_owner':
    case 'wrong_control_surface':
    case 'worker_start_failed':
    case 'worker_control_failed':
    case 'persistence_failed':
    case 'delivery_uncertain':
    case 'schedule_required':
    case 'control_unavailable':
      return true
    default:
      return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function cronFailure(value: unknown): ToolError | undefined {
  if (!isRecord(value)) return { code: 'control_unavailable', message: 'Cron control returned an invalid response.' }
  if (value.ok === true) return undefined
  if (value.ok !== false) return { code: 'control_unavailable', message: 'Cron control returned an invalid response.' }
  const externalCode = value.code
  return {
    code: typeof externalCode === 'string' && isToolErrorCode(externalCode)
      ? externalCode
      : 'control_unavailable',
    message: typeof value.message === 'string' ? value.message : 'Cron control operation failed.',
  }
}

function iso(now: (() => number) | undefined): string {
  return new Date(now === undefined ? Date.now() : now()).toISOString()
}

/** Render one tool value as plain text content (the model sees the JSON). */
function renderValue(_args: unknown, value: unknown): ContentBlock[] {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

function terminalCheckInDeliveryState(row: OutboxRow | undefined): CommitmentView['lastCheckInDeliveryState'] {
  if (row === undefined) return null
  switch (row.state) {
    case 'delivered':
    case 'failed':
    case 'uncertain':
    case 'cancelled':
      return row.state
    default:
      return null
  }
}

function toView(
  row: CommitmentRow,
  mode: 'web' | 'telegram',
  latestMonitorEvent?: OutboxRow,
  store?: AssistantStore,
): CommitmentView {
  const monitor = row.kind === 'monitor'
  const latestCheckIn = row.kind === 'focus' && store !== undefined
    ? store.getLatestCheckInOutbox(row.id)
    : undefined
  const checkInState = row.kind !== 'focus'
    ? 'none'
    : row.reminderState === 'scheduled'
      ? 'scheduled'
      : row.reminderState === 'queued'
        ? latestCheckIn === undefined || latestCheckIn.state === 'pending' || latestCheckIn.state === 'claimed'
          ? 'queued'
          : latestCheckIn.state
        : row.reminderState
  return {
    id: row.id,
    title: row.title,
    workOwner: row.workOwner,
    kind: row.kind,
    status: row.status,
    nextAction: row.nextAction,
    nextContactAt: row.reminderDueAt,
    checkInState,
    lastCheckInDeliveryState: terminalCheckInDeliveryState(latestCheckIn),
    lastCheckInDeliveryError: latestCheckIn?.error ?? null,
    result: row.result,
    progressSummary: row.progressSummary,
    progressAt: row.progressAt,
    lastDeliveryState: row.lastDeliveryState,
    lastDeliveryError: row.lastDeliveryError,
    hasWorker: row.workerSessionId !== null,
    workerControlState: row.workerControlState,
    monitorDesiredState: monitor ? row.monitorDesiredState : null,
    monitorResumeState: monitor ? row.monitorResumeState : null,
    monitorDirection: monitor ? row.monitorDirection : null,
    monitorCheckpoint: monitor ? row.monitorCheckpoint : null,
    monitorEventKey: monitor ? latestMonitorEvent?.monitorEventKey ?? null : null,
    monitorProposedCheckpoint: monitor ? latestMonitorEvent?.monitorProposedCheckpoint ?? null : null,
    monitorEventDeliveryState: monitor ? latestMonitorEvent?.state ?? null : null,
    monitorEventDeliveryError: monitor ? latestMonitorEvent?.error ?? null : null,
    cronBinding: monitor && store !== undefined ? toCronBindingView(store.getCronBinding(row.id)) : null,
    controlSurface: row.workOwner === 'agent' ? 'telegram' : mode,
    revision: row.revision,
  }
}

function toCronBindingView(row: CronBindingRow | undefined): CronBindingView | null {
  if (row === undefined) return null
  let schedule: AssistantCronSchedule | null = null
  try {
    schedule = parseCronSchedule(JSON.parse(row.desiredScheduleJson)) ?? null
  } catch {
    schedule = null
  }
  return {
    desiredState: row.desiredState,
    schedule,
    desiredCwd: row.desiredCwd,
    boundJobId: row.boundJobId,
    controlError: row.controlError,
    lastRun: row.lastRunId === null || row.lastRunJobId === null || row.scheduledFor === null || row.finishedAt === null || row.runStatus === null || row.deliveryState === null
      ? null
      : {
        runId: row.lastRunId,
        jobId: row.lastRunJobId,
        scheduledFor: row.scheduledFor,
        finishedAt: row.finishedAt,
        runStatus: row.runStatus,
        summary: row.lastRunSummary,
        runError: row.runError,
        deliveryState: row.deliveryState,
        deliveryError: row.deliveryError,
      },
  }
}

function toLastClosedView(row: CommitmentRow): LastClosedView {
  return {
    id: row.id,
    title: row.title,
    workOwner: row.workOwner,
    status: row.status as 'completed' | 'cancelled',
    result: row.result,
    completedAt: row.completedAt,
    lastDeliveryState: row.lastDeliveryState,
    lastDeliveryError: row.lastDeliveryError,
    revision: row.revision,
  }
}

/** Build the status output with the §8.1 lastClosed inclusion rule. */
export function buildStatusOutput(store: AssistantStore, mode: 'web' | 'telegram'): StatusOutput {
  const focus = store.getOpenFocus()
  const maxVisible = 5
  const agentTotal = mode === 'telegram' ? store.countTelegramAgentResponsibilities() : 0
  const allVisible = [
    ...(focus === undefined ? [] : [focus]),
    ...(mode === 'telegram' ? store.listTelegramAgentResponsibilities(maxVisible + 1) : []),
  ]
  const totalOpen = (focus === undefined ? 0 : 1) + agentTotal
  const rows = allVisible.slice(0, maxVisible)
  const current = totalOpen === 1 ? allVisible[0] : undefined
  const last = mode === 'web' ? store.getLastClosedFocus() : store.getLastClosed()
  const showLast = last !== undefined
    && (current === undefined
      || last.lastDeliveryState === 'failed'
      || last.lastDeliveryState === 'uncertain')
  return {
    current: current === undefined
      ? null
      : toView(current, mode, current.kind === 'monitor' ? store.getLatestMonitorEvent(current.id) : undefined, store),
    responsibilities: rows.map(row => toView(row, mode, row.kind === 'monitor' ? store.getLatestMonitorEvent(row.id) : undefined, store)),
    totalOpen,
    truncated: totalOpen > rows.length,
    recentAgentClosures: mode === 'telegram'
      ? store.listRecentTelegramAgentClosures().map(toLastClosedView)
      : [],
    lastClosed: showLast && last !== undefined ? toLastClosedView(last) : null,
  }
}

function errorValue(error: ToolError, current?: CommitmentRow, mode?: 'web' | 'telegram'): AssistantToolError {
  return {
    code: error.code,
    message: error.message,
    ...current !== undefined && mode !== undefined ? { current: toView(current, mode) } : {},
  }
}

function controllableOpen(store: AssistantStore, mode: 'web' | 'telegram'): CommitmentRow[] {
  const focus = store.getOpenFocus()
  return [
    ...(focus === undefined ? [] : [focus]),
    ...(mode === 'telegram' ? store.listTelegramAgentResponsibilities(101) : []),
  ]
}

function selectForUpdate(
  store: AssistantStore,
  mode: 'web' | 'telegram',
  commitmentId: unknown,
): { readonly ok: true; readonly row: CommitmentRow } | { readonly ok: false; readonly error: AssistantToolError } {
  const candidates = controllableOpen(store, mode)
  if (commitmentId !== undefined) {
    if (typeof commitmentId !== 'string' || commitmentId.trim() === '') {
      return { ok: false, error: { code: 'invalid_transition', message: 'commitmentId must be a non-empty string.' } }
    }
    const row = store.getById(commitmentId)
    const visible = row !== undefined
      && isOpenStatus(row.status)
      && (row.kind === 'focus'
        || (mode === 'telegram'
          && row.workOwner === 'agent'
          && row.sourceSurface === 'telegram'
          && (row.kind === 'delegated' || row.kind === 'monitor')))
    return !visible || row === undefined
      ? { ok: false, error: { code: 'no_current_commitment', message: '没有找到当前界面可控制的该责任。' } }
      : { ok: true, row }
  }
  if (candidates.length === 0) {
    return { ok: false, error: { code: 'no_current_commitment', message: '当前没有未结束的承诺。' } }
  }
  if (candidates.length > 1) {
    return {
      ok: false,
      error: {
        code: 'ambiguous_commitment',
        message: '当前有多项责任；请明确 commitmentId，不能猜最近一项。',
        candidates: candidates.slice(0, 10).map(row => toView(row, mode)),
      },
    }
  }
  return { ok: true, row: candidates[0]! }
}


function userReply(action: UpdateAction, row: CommitmentRow, nextContactAt: string | null): string {
  switch (action) {
    case 'pause':
      return `已暂停：${row.title}。我不会再提醒，直到你说继续。`
    case 'resume':
      return nextContactAt === null
        ? `已恢复：${row.title}。`
        : `已恢复：${row.title}。我会在 ${new Date(nextContactAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} 再跟进。`
    case 'still_working':
      return nextContactAt === null
        ? `好的，继续跟进：${row.title}。`
        : `好的，我会在 ${new Date(nextContactAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} 再问你。`
    case 'block':
      return `已标记受阻：${row.title}。`
    case 'complete':
      return `已收口：${row.title}。`
    case 'cancel':
      return `已取消：${row.title}。`
    case 'set_next_action':
      return `已更新下一步：${row.title}。`
    case 'revise_monitor':
      return `已更新监控方向：${row.title}。`
    default: {
      const exhaustive: never = action
      return `已更新：${row.title}。${String(exhaustive)}`
    }
  }
}

function internalError(): AssistantToolError {
  return { code: 'persistence_failed', message: 'assistant 工具需要调用 Agent 上下文。' }
}

/**
 * Register the assistant tools in one exact root-agent scope.
 * @param deps - store, mode, worker (telegram), clock, and in-flight aborts.
 * @returns disposer for the registrations.
 */
export function registerAssistantTools(
  toolCtx: { tools: { register(def: unknown): () => void } },
  deps: AssistantToolDeps,
): () => void {
  const disposers: Array<() => void> = []

  try {
    // ── assistant_task_status ─────────────────────────────────────────────
    disposers.push(toolCtx.tools.register(defineTool({
      name: 'assistant_task_status',
      description:
        "Read the assistant's bounded open responsibilities, up to three recent Telegram Agent closures, and one legacy recent closed commitment. "
        + "This is not the user's personal todo list. For \"my tasks / todo / what else do I need to do\", "
        + "read the personal task source specified by the workspace instead. "
        + 'Directly reads the durable assistant state; never search sessions or memory for this.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            current: {
              type: 'json',
              required: true,
            },
            lastClosed: {
              type: 'json',
              required: true,
            },
            recentAgentClosures: { type: 'json', required: true },
            responsibilities: { type: 'json', required: true },
            totalOpen: { type: 'number', required: true },
            truncated: { type: 'boolean', required: true },
          },
        },
        render: renderValue,
      },
      async execute(): Promise<StatusOutput> {
        return buildStatusOutput(deps.store, deps.mode)
      },
      presentCall: () => ({ card: 'generic', title: 'Assistant: current commitment', kind: 'read' }),
    })))

    if (deps.mode === 'telegram') {
      disposers.push(toolCtx.tools.register(defineTool({
        name: 'assistant_web_task_status',
        description:
          'Read the last projected status of an independent Web conversation when the user asks about it. '
          + 'This tool is read-only: never pause, resume, redirect, or take over a Web task. '
          + 'A stale running row means only that no newer event was observed, not that it is healthy or hung.',
        parameters: {
          sessionId: { type: 'string', description: 'Exact Web session id when known.' },
          query: { type: 'string', description: 'Plain substring over session id, request, conclusion, or cwd.' },
          limit: { type: 'number', description: 'Candidate limit from 1 to 20; defaults to 5.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              selected: { type: 'json', required: true },
              candidates: { type: 'json', required: true },
              total: { type: 'number', required: true },
              truncated: { type: 'boolean', required: true },
              ambiguous: { type: 'boolean', required: true },
            },
          },
          render: renderValue,
        },
        async execute(args: Record<string, unknown>) {
          if (args.sessionId !== undefined && typeof args.sessionId !== 'string') {
            return { selected: null, candidates: [], total: 0, truncated: false, ambiguous: false }
          }
          if (args.query !== undefined && typeof args.query !== 'string') {
            return { selected: null, candidates: [], total: 0, truncated: false, ambiguous: false }
          }
          const limit = typeof args.limit === 'number' && Number.isSafeInteger(args.limit) ? args.limit : undefined
          const result = queryWebTasks(deps.store, {
            ...typeof args.sessionId === 'string' ? { sessionId: args.sessionId } : {},
            ...typeof args.query === 'string' ? { query: args.query } : {},
            ...limit === undefined ? {} : { limit },
          }, deps.now?.() ?? Date.now())
          return {
            ...result,
            selected: result.selected as unknown as JsonValue,
            candidates: result.candidates as unknown as JsonValue,
          }
        },
        presentCall: () => ({ card: 'generic', title: 'Assistant: Web task status', kind: 'read' }),
      })))
    }

    // ── assistant_track_task ──────────────────────────────────────────────
    disposers.push(toolCtx.tools.register(defineTool({
      name: 'assistant_track_task',
      description:
        'Record and supervise a USER-OWNED commitment: the user does the work, you track, time, remind, '
        + 'pause, resume, and close the loop. NEVER execute the task content yourself. '
        + 'Use when the user says they plan to do, are doing, or want a reminder about their own work. '
        + 'If a current user focus already exists, ask whether to switch it first.',
      parameters: {
        title: { type: 'string', required: true, description: 'Short user-visible title of the user\'s own work.' },
        status: {
          type: 'string',
          enum: ['pending', 'active'],
          description: 'pending when the user has not started yet; active otherwise. Defaults to active.',
        },
        nextAction: { type: 'string', description: 'What the user should do next (display only; you never do it).' },
        checkInMinutes: { type: 'number', description: 'Minutes until the next check-in reminder (1–10080).' },
      },
      output: {
        schema: {
          oneOf: [
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                current: { type: 'json', required: true },
                reply: { type: 'string', required: true },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                code: { type: 'string', required: true },
                message: { type: 'string', required: true },
                current: { type: 'json' },
              },
            },
          ],
        },
        render: renderValue,
      },
      async execute(args: Record<string, unknown>): Promise<MutationOutput | AssistantToolError> {
        const titleError = validateTitle(args.title)
        if (titleError !== undefined) {
          return { code: 'invalid_transition', message: titleError }
        }
        const checkInError = validateCheckInMinutes(args.checkInMinutes)
        if (checkInError !== undefined) {
          return { code: 'invalid_transition', message: checkInError }
        }
        const status = args.status === undefined ? 'active' : args.status
        if (status !== 'pending' && status !== 'active') {
          return { code: 'invalid_transition', message: 'status must be "pending" or "active".' }
        }
        const nextAction = args.nextAction
        if (nextAction !== undefined && typeof nextAction !== 'string') {
          return { code: 'invalid_transition', message: 'nextAction must be a string.' }
        }
        const created = deps.store.createUserCommitment({
          title: (args.title as string).trim(),
          status,
          ...nextAction === undefined ? {} : { nextAction: nextAction as string },
          ...args.checkInMinutes === undefined ? {} : { checkInMinutes: args.checkInMinutes as number },
          sourceSurface: deps.mode,
          now: iso(deps.now),
        })
        if (!created.ok) {
          return errorValue(writeResultToToolError(created), created.current, deps.mode)
        }
        const view = toView(created.row, deps.mode)
        return {
          current: view,
          reply: renderTrackAccepted({ title: view.title, nextContactAt: view.nextContactAt }),
        }
      },
      presentCall: args => ({ card: 'generic', title: 'Track user task', kind: 'other', rawInput: (args as Record<string, unknown>).title as string | undefined }),
    })))

    // ── assistant_delegate_task (telegram only) ───────────────────────────
    if (deps.mode === 'telegram' && (deps.worker !== undefined || deps.cronControl !== undefined)) {
      disposers.push(toolCtx.tools.register(defineTool({
        name: 'assistant_delegate_task',
        description:
          'Delegate an AGENT-OWNED commitment to a background worker: you execute it in a continuable '
          + 'child session and report completion or blockers. Use when the user explicitly asks you to do, '
          + 'look up, change, fix, or land something that continues past this turn. '
          + 'Do NOT use the generic subagent tool to bypass commitment state. '
          + 'For kind=monitor, an explicit schedule is required and the Cron manager owns the clock; the prompt is persisted as the complete monitor direction. '
          + 'The worker runs in the background; this call returns quickly.',
        parameters: {
          title: { type: 'string', required: true, description: 'Short title the user sees for the delegated work.' },
          prompt: {
            type: 'string',
            required: true,
            description: 'Complete, self-contained task for the background worker. It does not see this conversation.',
          },
          nextAction: { type: 'string', description: 'What should happen next while the worker runs.' },
          kind: {
            type: 'string',
            enum: ['delegated', 'monitor'],
            description: 'delegated for finite work; monitor for work that continues until the user cancels. Defaults to delegated.',
          },
          schedule: {
            type: 'json',
            description: 'Required for a new monitor: {kind:"cron",expr:string}, {kind:"interval",minutes:number}, or {kind:"once",runAt:string}.',
          },
          cwd: { type: 'string', description: 'Optional working directory for Cron runs.' },
        },
        output: {
          schema: {
            oneOf: [
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  current: { type: 'json', required: true },
                  reply: { type: 'string', required: true },
                },
              },
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  code: { type: 'string', required: true },
                  message: { type: 'string', required: true },
                  detail: { type: 'string' },
                  current: { type: 'json' },
                },
              },
            ],
          },
          render: renderValue,
        },
        async execute(args: Record<string, unknown>, exec: { agent?: Agent; signal: AbortSignal }): Promise<MutationOutput | AssistantToolError> {
          if (exec.agent === undefined) return internalError()
          const titleError = validateTitle(args.title)
          if (titleError !== undefined) {
            return { code: 'invalid_transition', message: titleError }
          }
          const prompt = args.prompt
          if (typeof prompt !== 'string' || prompt.trim() === '') {
            return { code: 'invalid_transition', message: 'prompt must be a non-empty string.' }
          }
          const nextAction = args.nextAction
          if (nextAction !== undefined && typeof nextAction !== 'string') {
            return { code: 'invalid_transition', message: 'nextAction must be a string.' }
          }
          const kind = args.kind ?? 'delegated'
          if (kind !== 'delegated' && kind !== 'monitor') {
            return { code: 'invalid_transition', message: 'kind must be "delegated" or "monitor".' }
          }
          if (kind === 'monitor') {
            if (args.schedule === undefined) {
              return { code: 'schedule_required', message: 'A new Cron monitor requires an explicit schedule.' }
            }
            const schedule = parseCronSchedule(args.schedule)
            if (schedule === undefined) {
              return { code: 'invalid_transition', message: 'schedule must be a valid Cron schedule object.' }
            }
            if (deps.cronControl === undefined) {
              return { code: 'control_unavailable', message: 'Cron control is unavailable; the monitor was not started.' }
            }
            const cwd = args.cwd
            if (cwd !== undefined && (typeof cwd !== 'string' || cwd.trim() === '')) {
              return { code: 'invalid_transition', message: 'cwd must be a non-empty string when provided.' }
            }
            const created = deps.store.createAgentCommitment({
              title: (args.title as string).trim(),
              kind: 'monitor',
              monitorDirection: prompt.trim(),
              ...nextAction === undefined ? {} : { nextAction: nextAction as string },
              sourceSurface: 'telegram',
              now: iso(deps.now),
            })
            if (!created.ok) return errorValue(writeResultToToolError(created), created.current, deps.mode)
            const control = await deps.cronControl.bindMonitor({
              commitmentId: created.row.id,
              schedule,
              ...(cwd === undefined ? {} : { cwd: cwd.trim() }),
            })
            const controlError = cronFailure(control)
            if (controlError !== undefined) {
              const current = deps.store.getById(created.row.id)
              return {
                ...controlError,
                ...current === undefined ? {} : { current: toView(current, deps.mode) },
              }
            }
            const current = deps.store.getById(created.row.id) ?? created.row
            const view = toView(current, deps.mode)
            return { current: view, reply: renderDelegateAccepted({ title: view.title }) }
          }
          if (deps.worker === undefined) {
            return { code: 'control_unavailable', message: 'No worker is available for delegated work.' }
          }
          const out = await deps.worker!.delegate(exec.agent, {
            title: (args.title as string).trim(),
            prompt: prompt.trim(),
            kind,
            ...nextAction === undefined ? {} : { nextAction: nextAction as string },
          }, exec.signal)
          if (!out.ok) {
            return {
              code: out.code,
              message: out.message,
              ...out.detail === undefined ? {} : { detail: out.detail },
            }
          }
          const view = toView(out.row, deps.mode)
          return { current: view, reply: renderDelegateAccepted({ title: view.title }) }
        },
        presentCall: args => ({ card: 'generic', title: 'Delegate agent task', kind: 'other', rawInput: (args as Record<string, unknown>).title as string | undefined }),
      })))
    }

    // ── assistant_task_update ─────────────────────────────────────────────
    disposers.push(toolCtx.tools.register(defineTool({
      name: 'assistant_task_update',
      description:
        'Update the current commitment with a validated action. '
        + 'still_working/complete/block apply only to user-owned commitments; pause/resume/cancel follow ownership rules. '
        + 'agent-owned commitments pause/resume/cancel only from Telegram. '
        + 'complete only relays an explicit user completion confirmation for USER work. '
        + 'Agent work completes only through the background worker result contract.',
      parameters: {
        commitmentId: {
          type: 'string',
          description: 'Exact responsibility id. Required whenever more than one controllable responsibility is open.',
        },
        action: {
          type: 'string',
          required: true,
          enum: ['pause', 'resume', 'revise_monitor', 'still_working', 'block', 'complete', 'cancel', 'set_next_action'],
        },
        result: { type: 'string', description: 'Final result text for complete.' },
        reason: { type: 'string', description: 'Blocker reason for block.' },
        nextAction: { type: 'string', description: 'Next step for set_next_action/block; it never replaces a monitor direction.' },
        direction: { type: 'string', description: 'Complete replacement direction for revise_monitor only.' },
        schedule: { type: 'json', description: 'Optional Cron schedule for resuming an unbound legacy monitor; bound monitors reuse the persisted schedule.' },
        checkInMinutes: { type: 'number', description: 'New check-in interval for resume/still_working.' },
      },
      output: {
        schema: {
          oneOf: [
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                current: { type: 'json', required: true },
                reply: { type: 'string', required: true },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                code: { type: 'string', required: true },
                message: { type: 'string', required: true },
                current: { type: 'json' },
                candidates: { type: 'json' },
              },
            },
          ],
        },
        render: renderValue,
      },
      async execute(
        args: Record<string, unknown>,
        exec: { agent?: Agent; signal: AbortSignal },
      ): Promise<MutationOutput | AssistantToolError> {
        if (exec.agent === undefined) return internalError()
        const action = args.action
        if (typeof action !== 'string' || !['pause', 'resume', 'revise_monitor', 'still_working', 'block', 'complete', 'cancel', 'set_next_action'].includes(action)) {
          return { code: 'invalid_transition', message: 'action must be one of the documented actions.' }
        }
        const typedAction = action as UpdateAction
        const direction = args.direction
        if (typedAction === 'revise_monitor' && (typeof direction !== 'string' || direction.trim() === '')) {
          return { code: 'invalid_transition', message: 'revise_monitor requires a non-empty direction.' }
        }
        const checkInError = validateCheckInMinutes(args.checkInMinutes)
        if (checkInError !== undefined) {
          return { code: 'invalid_transition', message: checkInError }
        }
        const selected = selectForUpdate(deps.store, deps.mode, args.commitmentId)
        if (!selected.ok) return selected.error
        const current = selected.row
        const validation = validateUpdate({
          action: typedAction,
          workOwner: current.workOwner,
          kind: current.kind,
          status: current.status,
          mode: deps.mode,
          hasLiveWorker: current.workerSessionId !== null,
          ...typedAction === 'revise_monitor' ? { direction: direction as string } : {},
        })
        if (!validation.ok) {
          return errorValue(validation, current, deps.mode)
        }

        const finish = (res: WriteResult<CommitmentRow>): MutationOutput | AssistantToolError => {
          if (!res.ok) return errorValue(writeResultToToolError(res), res.current, deps.mode)
          const view = toView(res.row, deps.mode)
          return { current: view, reply: userReply(typedAction, res.row, view.nextContactAt) }
        }

        switch (typedAction) {
          case 'pause': {
            if (current.workOwner === 'agent') {
              if (current.kind === 'monitor') {
                if (deps.cronControl === undefined) {
                  return { code: 'control_unavailable', message: 'Cron control is unavailable; the monitor was not paused.' }
                }
                const control = await deps.cronControl.pauseMonitor(current.id)
                const controlError = cronFailure(control)
                if (controlError !== undefined) {
                  const latest = deps.store.getById(current.id)
                  return {
                    ...controlError,
                    ...latest === undefined ? {} : { current: toView(latest, deps.mode) },
                  }
                }
                const latest = deps.store.getById(current.id)
                if (latest === undefined) return { code: 'persistence_failed', message: 'Monitor state disappeared after Cron pause.' }
                return { current: toView(latest, deps.mode), reply: `已暂停监控：${latest.title}。` }
              }
              if (deps.worker === undefined) return { code: 'control_unavailable', message: 'No worker is available for delegated work.' }
              const out = deps.worker!.pause(current)
              if (!out.ok) return { code: out.code, message: out.message }
              return { current: toView(out.row, deps.mode), reply: userReply('pause', out.row, out.row.reminderDueAt) }
            }
            deps.abortInFlight?.(current.id)
            return finish(deps.store.pauseUser(current.id, current.revision))
          }
          case 'resume': {
            if (current.workOwner === 'agent') {
              if (current.kind === 'monitor') {
                if (args.nextAction !== undefined) {
                  return {
                    code: 'invalid_transition',
                    message: 'monitor resume uses the persisted direction; use revise_monitor to replace it.',
                  }
                }
                // A legacy monitor without a durable binding has no safe
                // schedule to infer.  Reject before consulting Cron or any
                // worker path; an explicit schedule is the only rebind
                // authority.  Bound monitors continue to reuse their stored
                // schedule when the user omits this field.
                if (args.schedule === undefined && deps.store.getCronBinding(current.id) === undefined) {
                  return { code: 'schedule_required', message: 'The first legacy Cron resume requires an explicit schedule.' }
                }
                if (deps.cronControl === undefined) {
                  return { code: 'control_unavailable', message: 'Cron control is unavailable; the monitor was not resumed.' }
                }
                let schedule: AssistantCronSchedule | undefined
                if (args.schedule !== undefined) {
                  schedule = parseCronSchedule(args.schedule)
                  if (schedule === undefined) {
                    return { code: 'invalid_transition', message: 'schedule must be a valid Cron schedule object.' }
                  }
                }
                const control = await deps.cronControl.resumeMonitor({
                  commitmentId: current.id,
                  ...(schedule === undefined ? {} : { schedule }),
                })
                const controlError = cronFailure(control)
                if (controlError !== undefined) {
                  const latest = deps.store.getById(current.id)
                  return {
                    ...controlError,
                    ...latest === undefined ? {} : { current: toView(latest, deps.mode) },
                  }
                }
                const latest = deps.store.getById(current.id)
                if (latest === undefined) return { code: 'persistence_failed', message: 'Monitor state disappeared after Cron resume.' }
                return { current: toView(latest, deps.mode), reply: `已恢复监控：${latest.title}。后续轮次由 Cron 调度。` }
              }
              if (deps.worker === undefined) return { code: 'control_unavailable', message: 'No worker is available for delegated work.' }
              const out = await deps.worker!.resume(
                current,
                exec.agent,
                args.nextAction === undefined ? undefined : args.nextAction as string,
                exec.signal,
              )
              if (!out.ok) return { code: out.code, message: out.message }
              return {
                current: toView(out.row, deps.mode),
                reply: userReply('resume', out.row, out.row.reminderDueAt),
              }
            }
            return finish(deps.store.resumeUser(
              current.id,
              current.revision,
              args.checkInMinutes as number | undefined,
              iso(deps.now),
            ))
          }
          case 'still_working':
            return finish(deps.store.stillWorking(
              current.id,
              current.revision,
              args.checkInMinutes as number | undefined,
              iso(deps.now),
            ))
          case 'block': {
            const reason = args.reason
            const nextAction = args.nextAction
            if (reason !== undefined && typeof reason !== 'string') {
              return { code: 'invalid_transition', message: 'reason must be a string.' }
            }
            if (nextAction !== undefined && typeof nextAction !== 'string') {
              return { code: 'invalid_transition', message: 'nextAction must be a string.' }
            }
            deps.abortInFlight?.(current.id)
            return finish(deps.store.block(
              current.id,
              current.revision,
              reason === undefined ? '未说明原因' : reason,
              nextAction === undefined ? undefined : nextAction as string,
            ))
          }
          case 'complete': {
            const result = args.result
            if (result !== undefined && typeof result !== 'string') {
              return { code: 'invalid_transition', message: 'result must be a string.' }
            }
            deps.abortInFlight?.(current.id)
            return finish(deps.store.completeUser(
              current.id,
              current.revision,
              result === undefined ? undefined : result as string,
              iso(deps.now),
            ))
          }
          case 'cancel': {
            if (current.workOwner === 'agent') {
              if (current.kind === 'monitor') {
                if (deps.cronControl === undefined) {
                  return { code: 'control_unavailable', message: 'Cron control is unavailable; the monitor was not cancelled.' }
                }
                const control = await deps.cronControl.cancelMonitor(current.id)
                const controlError = cronFailure(control)
                if (controlError !== undefined) {
                  const latest = deps.store.getById(current.id)
                  return {
                    ...controlError,
                    ...latest === undefined ? {} : { current: toView(latest, deps.mode) },
                  }
                }
                const latest = deps.store.getById(current.id)
                if (latest === undefined) return { code: 'persistence_failed', message: 'Monitor state disappeared after Cron cancel.' }
                return { current: toView(latest, deps.mode), reply: `已取消监控：${latest.title}。` }
              }
              if (deps.worker === undefined) return { code: 'control_unavailable', message: 'No worker is available for delegated work.' }
              const out = deps.worker!.cancel(current)
              if (!out.ok) return { code: out.code, message: out.message }
              return { current: toView(out.row, deps.mode), reply: userReply('cancel', out.row, null) }
            }
            deps.abortInFlight?.(current.id)
            return finish(deps.store.cancel(current.id, current.revision))
          }
          case 'revise_monitor': {
            if (current.workOwner !== 'agent' || current.kind !== 'monitor') {
              return { code: 'wrong_work_owner', message: 'revise_monitor applies only to Agent-owned monitor commitments.' }
            }
            if (deps.cronControl === undefined) {
              return { code: 'control_unavailable', message: 'Cron control is unavailable; the monitor direction was not changed.' }
            }
            const control = await deps.cronControl.reviseMonitor({ commitmentId: current.id, direction: (direction as string).trim() })
            const controlError = cronFailure(control)
            if (controlError !== undefined) {
              const latest = deps.store.getById(current.id)
              return {
                ...controlError,
                ...latest === undefined ? {} : { current: toView(latest, deps.mode) },
              }
            }
            const latest = deps.store.getById(current.id)
            if (latest === undefined) return { code: 'persistence_failed', message: 'Monitor state disappeared after Cron direction revision.' }
            return {
              current: toView(latest, deps.mode),
              reply: `已更新监控方向：${latest.title}。后续轮次由 Cron 调度。`,
            }
          }
          case 'set_next_action': {
            const nextAction = args.nextAction
            if (typeof nextAction !== 'string' || nextAction.trim() === '') {
              return { code: 'invalid_transition', message: 'set_next_action requires a non-empty nextAction.' }
            }
            return finish(deps.store.setNextAction(current.id, current.revision, nextAction.trim()))
          }
          default: {
            const exhaustive: never = typedAction
            return { code: 'invalid_transition', message: `Unknown action ${String(exhaustive)}.` }
          }
        }
      },
      presentCall: args => ({ card: 'generic', title: 'Update assistant commitment', kind: 'other', rawInput: (args as Record<string, unknown>).action as string | undefined }),
    })))
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose()
    throw error
  }

  let active = true
  return () => {
    if (!active) return
    active = false
    for (const dispose of disposers.reverse()) dispose()
  }
}
