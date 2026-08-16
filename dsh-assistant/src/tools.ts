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
} from './domain.ts'
import { AssistantStore, type CommitmentRow, type WriteResult } from './store.ts'
import { WorkerController, writeResultToToolError } from './worker.ts'
import { queryWebTasks } from './observer.ts'

/** The model-facing view of one commitment (§8.1). */
export type CommitmentView = {
  readonly id: string
  readonly title: string
  readonly workOwner: WorkOwner
  readonly kind: ResponsibilityKind
  readonly status: CommitmentStatus
  readonly nextAction: string | null
  readonly nextContactAt: string | null
  readonly result: string | null
  readonly progressSummary: string | null
  readonly progressAt: string | null
  readonly controlSurface: 'web' | 'telegram'
  readonly revision: number
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
  now?: () => number
  abortInFlight?: (commitmentId: string) => void
  logger?: { warn(message: string): void }
}

function iso(now: (() => number) | undefined): string {
  return new Date(now === undefined ? Date.now() : now()).toISOString()
}

/** Render one tool value as plain text content (the model sees the JSON). */
function renderValue(_args: unknown, value: unknown): ContentBlock[] {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

function toView(row: CommitmentRow, mode: 'web' | 'telegram'): CommitmentView {
  return {
    id: row.id,
    title: row.title,
    workOwner: row.workOwner,
    kind: row.kind,
    status: row.status,
    nextAction: row.nextAction,
    nextContactAt: row.reminderDueAt,
    result: row.result,
    progressSummary: row.progressSummary,
    progressAt: row.progressAt,
    controlSurface: row.workOwner === 'agent' ? 'telegram' : mode,
    revision: row.revision,
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
    current: current === undefined ? null : toView(current, mode),
    responsibilities: rows.map(row => toView(row, mode)),
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
    if (deps.mode === 'telegram' && deps.worker !== undefined) {
      disposers.push(toolCtx.tools.register(defineTool({
        name: 'assistant_delegate_task',
        description:
          'Delegate an AGENT-OWNED commitment to a background worker: you execute it in a continuable '
          + 'child session and report completion or blockers. Use when the user explicitly asks you to do, '
          + 'look up, change, fix, or land something that continues past this turn. '
          + 'Do NOT use the generic subagent tool to bypass commitment state. '
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
          enum: ['pause', 'resume', 'still_working', 'block', 'complete', 'cancel', 'set_next_action'],
        },
        result: { type: 'string', description: 'Final result text for complete.' },
        reason: { type: 'string', description: 'Blocker reason for block.' },
        nextAction: { type: 'string', description: 'Next step for set_next_action/resume direction/block.' },
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
        if (typeof action !== 'string' || !['pause', 'resume', 'still_working', 'block', 'complete', 'cancel', 'set_next_action'].includes(action)) {
          return { code: 'invalid_transition', message: 'action must be one of the documented actions.' }
        }
        const typedAction = action as UpdateAction
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
          status: current.status,
          mode: deps.mode,
          hasLiveWorker: current.workerSessionId !== null,
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
              const out = deps.worker!.pause(current)
              if (!out.ok) return { code: out.code, message: out.message }
              return { current: toView(out.row, deps.mode), reply: userReply('pause', out.row, out.row.reminderDueAt) }
            }
            deps.abortInFlight?.(current.id)
            return finish(deps.store.pauseUser(current.id, current.revision))
          }
          case 'resume': {
            if (current.workOwner === 'agent') {
              const out = await deps.worker!.resume(
                current,
                exec.agent,
                args.nextAction === undefined ? undefined : args.nextAction as string,
                exec.signal,
              )
              if (!out.ok) return { code: out.code, message: out.message }
              return { current: toView(out.row, deps.mode), reply: userReply('resume', out.row, out.row.reminderDueAt) }
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
              const out = deps.worker!.cancel(current)
              if (!out.ok) return { code: out.code, message: out.message }
              return { current: toView(out.row, deps.mode), reply: userReply('cancel', out.row, null) }
            }
            deps.abortInFlight?.(current.id)
            return finish(deps.store.cancel(current.id, current.revision))
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
