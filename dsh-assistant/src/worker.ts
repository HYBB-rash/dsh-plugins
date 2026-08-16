/**
 * Agent-owned responsibility worker: binds each responsibility to its DSH
 * continuable child, maps the lifecycle edges, and implements the strict
 * result protocol (§11).
 *
 * Ordering rules enforced here:
 * - `delegate` persists a pending row FIRST, installs the parent-scoped
 *   lifecycle listeners, then calls `startContinuable`; the `subagent/start`
 *   listener persists the child identity inside the pending window;
 * - pause persists `paused + pause_requested` BEFORE `interrupt`; the
 *   matching aborted end clears the control state;
 * - resume persists `active + resume_requested` BEFORE `followup`; an old
 *   aborted end landing during the resume window never blocks;
 * - cancel persists the terminal state BEFORE `interrupt`; late ends are
 *   ignored;
 * - a worker turn ending is never a completion: only a valid
 *   `DSH_ASSISTANT_RESULT` protocol line settles completed/blocked.
 * @module @deepseek-ai/dsh-assistant
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { randomUUID } from 'node:crypto'
import type { ContentBlock, MessageId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentRunEndInfo, SubagentRunInfo } from '@deepseek-ai/dsh-subagent'
import {
  cleanError,
  parseWorkerResult,
  renderBlockedDelivery,
  renderCompletedDelivery,
  boundedPartial,
  type ToolError,
} from './domain.ts'
import { AssistantStore, type CommitmentRow, type WriteResult } from './store.ts'

/** Narrow structural face over `ctx.subagents` (satisfied by the real service). */
export interface SubagentsApi {
  startContinuable(spec: {
    provider: string
    label: string
    request: {
      prompt: ContentBlock[]
      parent: Agent
      maxDepth?: number
      toolFilter?: { allow?: string[]; deny?: string[] }
      persona?: string
    }
    signal: AbortSignal
  }): Promise<{ childId: SessionId; messageId: MessageId }>
  interrupt(
    targetSessionId: SessionId,
    authority: { kind: 'user'; parentSessionId: SessionId } | { kind: 'ancestor'; agent: Agent },
  ): void
  followup(
    parent: Agent,
    childId: SessionId,
    content: ContentBlock[],
    options: { source: { kind: 'plugin'; plugin: string }; signal: AbortSignal },
  ): Promise<MessageId>
}

/** Default child persona: focus on the delegation, never manage commitments. */
export const DEFAULT_CHILD_PERSONA = [
  'You are a delegated background worker for the user\'s private assistant.',
  'Complete exactly the task given in your first message, working autonomously and to completion.',
  'You do not manage commitments: never call any assistant_task_* tool and never create or complete commitments.',
  'Use the official report tool only for a meaningful completed stage, a concrete blocker, or a long stage whose current state matters. Do not send fixed-interval heartbeats and do not use report for the final result.',
  'Your final message is collected by dsh-assistant automatically. If you lack permissions or need a user decision, finish with the blocked protocol instead of guessing.',
  'Finish your final message with exactly one protocol line as the last non-empty line:',
  'DSH_ASSISTANT_RESULT {"status":"completed","summary":"<what you finished>","evidence":["<key evidence>"]}',
  'or, when you cannot finish:',
  'DSH_ASSISTANT_RESULT {"status":"blocked","summary":"<where you got to>","blocker":"<the concrete blocker>","nextAction":"<who must do what>"}',
  'Before that line, write your full natural-language delivery. Never claim completed without actually finishing.',
].join('\n')

/** Map a store WriteResult failure to a stable tool error. */
export function writeResultToToolError(res: WriteResult<CommitmentRow>): ToolError {
  if (res.ok) {
    // Callers pass only failures; keep the switch exhaustive without lying.
    return { code: 'persistence_failed', message: 'internal: unexpected successful write.' }
  }
  switch (res.code) {
    case 'current_commitment_exists':
      return { code: 'current_commitment_exists', message: res.message }
    case 'revision_mismatch':
    case 'invalid_transition':
    case 'terminal':
      return { code: 'invalid_transition', message: res.message }
    case 'not_found':
      return { code: 'no_current_commitment', message: res.message }
    case 'persistence_failed':
      return { code: 'persistence_failed', message: '持久化失败；请重试或先查询当前状态。' }
    default: {
      const exhaustive: never = res.code
      return { code: 'persistence_failed', message: `Unknown store failure ${String(exhaustive)}.` }
    }
  }
}

/** Extract joined text from an assistant ContentBlock array. */
export function extractText(blocks: readonly ContentBlock[] | undefined): string {
  if (blocks === undefined) return ''
  return blocks
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/** Follow-up text for a resume (§11.4). */
export function buildResumeText(direction: string | undefined): string {
  const base = '继续上次未完成的任务，保留原目标；完成或受阻时仍按 DSH_ASSISTANT_RESULT 协议收口。'
  return direction === undefined || direction.trim() === ''
    ? base
    : `${base}\n用户补充方向：${direction.trim()}`
}

/** Outcome of one worker operation, JSON-safe for tool results. */
export type WorkerOpOutput =
  | { readonly ok: true; readonly row: CommitmentRow }
  | { readonly ok: false; readonly code: ToolError['code']; readonly message: string; readonly detail?: string }

/** Outcome of a delegate call. */
export type DelegateOutput = WorkerOpOutput

export interface WorkerControllerDeps {
  store: AssistantStore
  mode: 'web' | 'telegram'
  subagents: SubagentsApi
  telegramParentSessionId: string
  provider?: string
  now?: () => number
  logger?: { warn(message: string): void; info?(message: string): void }
  childPersona?: string
  abortInFlight?: (commitmentId: string) => void
}

function iso(now: (() => number) | undefined): string {
  return new Date(now === undefined ? Date.now() : now()).toISOString()
}

/**
 * One per-plugin worker controller. Installs parent-scoped lifecycle
 * listeners once per root and maps the delegate/pause/resume/cancel flows.
 */
export class WorkerController {
  private readonly installed = new WeakSet<Agent>()
  private readonly pendingStarts = new Map<string, string[]>()
  private stopping = false

  constructor(private readonly deps: WorkerControllerDeps) {}

  /** Called by the plugin before dispose so late ends are never misreported. */
  setStopping(value: boolean): void {
    this.stopping = value
  }

  /** Install scoped lifecycle listeners for one root; idempotent. */
  ensureInstalled(agent: Agent): () => void {
    if (this.installed.has(agent)) return () => {}
    this.installed.add(agent)
    const disposers: Array<() => void> = []
    disposers.push(agent.ctx.on('subagent/start', (info: SubagentRunInfo) => {
      try {
        this.onStart(info, agent.session.id)
      } catch (error) {
        this.logWarn(`subagent/start handler failed: ${cleanError(error)}`)
      }
    }))
    disposers.push(agent.ctx.on('subagent/end', (info: SubagentRunEndInfo) => {
      try {
        this.onEnd(info)
      } catch (error) {
        this.logWarn(`subagent/end handler failed: ${cleanError(error)}`)
      }
    }))
    return () => {
      this.installed.delete(agent)
      for (const dispose of disposers) dispose()
    }
  }

  /** `subagent/start`: persist child identity (delegate window or resume epoch). */
  onStart(info: SubagentRunInfo, parentSessionId = this.deps.telegramParentSessionId): void {
    if (this.stopping) return
    const existing = this.deps.store.getByWorkerSessionId(info.id)
    if (existing !== undefined) {
      if (existing.workOwner !== 'agent' || existing.status === 'completed' || existing.status === 'cancelled') return
      const res = this.deps.store.acceptResumedWorkerRun(existing.id, existing.revision, info.runId)
      if (!res.ok) this.logWarn(`acceptResumedWorkerRun failed: ${res.message}`)
      return
    }
    const pending = this.pendingStarts.get(String(parentSessionId))
    const commitmentId = pending?.shift()
    if (pending !== undefined && pending.length === 0) this.pendingStarts.delete(String(parentSessionId))
    if (commitmentId === undefined) return
    const current = this.deps.store.getById(commitmentId)
    if (current === undefined || current.workOwner !== 'agent') return
    if (current.status === 'completed' || current.status === 'cancelled') return
    if (current.workerSessionId === null) {
      // Only the delegate's pending window may adopt an identity; a generic
      // subagent start on an active commitment must not hijack the fields.
      if (current.status !== 'pending') return
      const res = this.deps.store.saveWorkerIdentity(current.id, current.revision, {
        workerSessionId: info.id,
        workerRunId: info.runId,
        workerParentSessionId: this.deps.telegramParentSessionId,
      })
      if (!res.ok) this.logWarn(`saveWorkerIdentity failed: ${res.message}`)
      return
    }
  }

  /** `subagent/end`: apply the strict result protocol or control confirmations. */
  onEnd(info: SubagentRunEndInfo): void {
    if (this.stopping) return
    const current = this.deps.store.getByWorkerSessionId(info.id)
    if (current === undefined || current.workOwner !== 'agent') return
    if (current.status === 'completed' || current.status === 'cancelled') return // late event
    if (current.workerRunId !== null && current.workerRunId !== info.runId) return // stale epoch end

    const text = extractText(info.lastAssistantMessage)
    const nowIso = iso(this.deps.now)

    if (info.stopReason === 'aborted') {
      // §4.4 state table for aborted ends:
      // - paused + pause_requested + current run aborted → clear control,
      //   keep paused, never block or deliver (the user's pause confirmation);
      // - active + resume_requested + old run aborted (new start not yet
      //   landed) → IGNORE and KEEP resume_requested: the old abort must not
      //   clear a control state only the new run's persisted id may clear;
      // - otherwise (active, control none, run id is the current new run) →
      //   the NEW worker round aborted abnormally: block with one outbox.
      if (current.status === 'paused' && current.workerControlState === 'pause_requested') {
        this.clearControlBestEffort(current.id)
        return
      }
      if (current.workerControlState === 'resume_requested') {
        // Old-run abort inside the resume window: never clear, never block.
        return
      }
      this.settleBlocked(current, text, '后台轮次被中断，但没有有效收口结果。', undefined, nowIso)
      return
    }

    if (info.stopReason !== 'completed') {
      // error / max-tokens / refusal / unknown: blocked with bounded partial output.
      const reason = `后台轮次结束但没有给出有效收口结果（stopReason=${info.stopReason}）`
      this.settleBlocked(current, text, reason, undefined, nowIso)
      return
    }

    const parsed = parseWorkerResult(text)
    if (parsed.kind === 'invalid') {
      this.settleBlocked(current, text, `后台轮次结束但没有给出有效收口结果：${parsed.reason}`, undefined, nowIso)
      return
    }
    const settlement = parsed.settlement
    const body = parsed.body !== '' ? parsed.body : settlement.summary
    if (settlement.status === 'completed' && current.kind === 'monitor') {
      const reason = '监控 worker 提前退出，目前未监控；等待用户决定是否恢复。'
      const outboxText = renderBlockedDelivery({
        title: current.title,
        summary: body,
        blocker: reason,
      })
      this.settleTerminal(current, 'blocked', body, reason, undefined, outboxText, nowIso, info.runId)
    } else if (settlement.status === 'completed') {
      const outboxText = renderCompletedDelivery(current.title, body)
      this.settleTerminal(current, 'completed', body, undefined, undefined, outboxText, nowIso, info.runId)
    } else {
      const outboxText = renderBlockedDelivery({
        title: current.title,
        summary: settlement.summary,
        blocker: settlement.blocker,
        ...settlement.nextAction === undefined ? {} : { nextAction: settlement.nextAction },
      })
      this.settleTerminal(current, 'blocked', body, settlement.blocker, settlement.nextAction, outboxText, nowIso, info.runId)
    }
  }

  /**
   * Delegate one agent-owned responsibility: persist it as pending, start a
   * continuable child, confirm the persisted identity, then activate.
   */
  async delegate(
    agent: Agent,
    args: { title: string; prompt: string; kind?: 'delegated' | 'monitor'; nextAction?: string },
    signal: AbortSignal,
  ): Promise<DelegateOutput> {
    if (this.deps.mode !== 'telegram') {
      return { ok: false, code: 'wrong_control_surface', message: 'Agent 后台工作只在 Telegram 控制。' }
    }
    const nowIso = iso(this.deps.now)
    const created = this.deps.store.createAgentCommitment({
      title: args.title,
      kind: args.kind ?? 'delegated',
      ...args.nextAction === undefined ? {} : { nextAction: args.nextAction },
      sourceSurface: 'telegram',
      sourceSessionId: agent.session.id,
      now: nowIso,
    })
    if (!created.ok) return { ok: false, ...writeResultToToolError(created) }
    const commitment = created.row

    // The listener must be present before startContinuable so the identity is
    // persisted synchronously inside the pending window.
    this.ensureInstalled(agent)
    const parentKey = String(agent.session.id)
    const pending = this.pendingStarts.get(parentKey) ?? []
    pending.push(commitment.id)
    this.pendingStarts.set(parentKey, pending)

    let started: { childId: SessionId; messageId: MessageId }
    try {
      started = await this.deps.subagents.startContinuable({
        provider: this.deps.provider ?? 'spawn',
        label: args.title,
        request: {
          prompt: [{ type: 'text', text: args.prompt }],
          parent: agent,
          maxDepth: 1,
          // 验收返工 §4.1: assistant tools are root-local, so no global
          // toolFilter.deny is possible or needed — a child scope never sees
          // them (proven by tests/tools-visibility.spec.ts).
          persona: this.deps.childPersona ?? DEFAULT_CHILD_PERSONA,
        },
        signal,
      })
    } catch (error) {
      const stillPending = this.pendingStarts.get(parentKey)
      if (stillPending !== undefined) {
        const index = stillPending.indexOf(commitment.id)
        if (index >= 0) stillPending.splice(index, 1)
        if (stillPending.length === 0) this.pendingStarts.delete(parentKey)
      }
      const message = cleanError(error)
      const fresh = this.deps.store.getById(commitment.id)
      if (fresh !== undefined) {
        this.deps.store.markStartFailed(fresh.id, fresh.revision, `后台启动失败：${message}`)
      }
      return {
        ok: false,
        code: 'worker_start_failed',
        message: '后台子会话启动失败，未能接下这件事。',
        ...message === '' ? {} : { detail: message },
      }
    }

    const stillPending = this.pendingStarts.get(parentKey)
    if (stillPending !== undefined) {
      const index = stillPending.indexOf(commitment.id)
      if (index >= 0) stillPending.splice(index, 1)
      if (stillPending.length === 0) this.pendingStarts.delete(parentKey)
    }

    const fresh = this.deps.store.getById(commitment.id)
    if (fresh === undefined) {
      return { ok: false, code: 'persistence_failed', message: '承诺状态丢失，无法确认后台子会话。' }
    }
    if (fresh.status === 'completed' || fresh.status === 'blocked' || fresh.status === 'cancelled') {
      // An ultra-fast child settled before the tool could activate it; the
      // terminal state wins and must not be overwritten.
      return { ok: true, row: fresh }
    }
    if (fresh.workerSessionId !== started.childId) {
      // The identity was not persisted (listener write failed): interrupt the
      // known child so no un-tracked worker keeps running, and mark uncertain.
      try {
        this.deps.subagents.interrupt(started.childId, {
          kind: 'user',
          parentSessionId: SessionId(this.deps.telegramParentSessionId),
        })
      } catch {
        // Best effort: the child may already be gone.
      }
      this.deps.store.failWorker(fresh.id, fresh.revision, '后台启动结果不确定：child 身份未持久化')
      return {
        ok: false,
        code: 'worker_start_failed',
        message: '后台启动结果不确定；已停止后台子会话，未留下未追踪工作。',
      }
    }
    if (fresh.status === 'pending') {
      const active = this.deps.store.markAgentActive(fresh.id, fresh.revision)
      if (!active.ok) {
        // The lifecycle advanced between our read and this write; keep whatever
        // state it reached (terminal wins).
        const latest = this.deps.store.getById(fresh.id)!
        return { ok: true, row: latest }
      }
      return { ok: true, row: active.row }
    }
    return { ok: true, row: fresh }
  }

  /** Resume every desired-running monitor only after the fixed root listener exists. */
  async recoverMonitors(agent: Agent, signal: AbortSignal, handshakeTimeoutMs = 5_000): Promise<void> {
    if (this.deps.mode !== 'telegram' || this.stopping) return
    this.ensureInstalled(agent)
    for (const candidate of this.deps.store.listMonitorsNeedingResume()) {
      if (signal.aborted || this.stopping) return
      if (candidate.workerSessionId === null) continue
      const token = randomUUID()
      const claimed = this.deps.store.claimMonitorResume(candidate.id, candidate.revision, token, iso(this.deps.now))
      if (!claimed.ok) continue
      try {
        await this.deps.subagents.followup(
          agent,
          SessionId(candidate.workerSessionId),
          [{ type: 'text', text: '服务已恢复。继续原监控目标；不要改变范围。按阶段使用 report，只有取消才停止监控。' }],
          { source: { kind: 'plugin', plugin: 'dsh-assistant' }, signal },
        )
        if (signal.aborted || this.stopping) return
        const deadline = Date.now() + handshakeTimeoutMs
        while (Date.now() <= deadline) {
          if (signal.aborted || this.stopping) return
          const latest = this.deps.store.getById(candidate.id)
          if (latest === undefined || latest.status === 'cancelled') break
          if (latest.workerControlState === 'none' && latest.monitorResumeState === 'none') break
          await new Promise(resolve => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))))
        }
        if (signal.aborted || this.stopping) return
        const latest = this.deps.store.getById(candidate.id)
        if (latest !== undefined && latest.monitorResumeState === 'claimed') {
          this.failMonitorRecovery(latest, '监控恢复后没有确认新的运行实例，目前未监控。')
        }
      } catch (error) {
        // A normal plugin shutdown owns the claimed→needed transition via
        // normalizeAgentOnStartup(). Never turn that expected abort into a
        // blocked responsibility or touch the store after its lifetime ends.
        if (signal.aborted || this.stopping) return
        const latest = this.deps.store.getById(candidate.id)
        if (latest !== undefined && latest.monitorResumeState === 'claimed') {
          this.failMonitorRecovery(latest, `监控恢复失败，目前未监控：${cleanError(error)}`)
        }
      }
    }
  }

  private failMonitorRecovery(row: CommitmentRow, reason: string): void {
    const nowIso = iso(this.deps.now)
    const text = renderBlockedDelivery({ title: row.title, summary: row.progressSummary ?? '等待恢复原监控', blocker: reason })
    const res = this.deps.store.failMonitorResume(row.id, row.revision, reason, nowIso, text)
    if (!res.ok) this.logWarn(`failMonitorResume failed: ${res.message}`)
  }

  /** Pause an agent commitment: persist first, then really interrupt. */
  pause(commitment: CommitmentRow): WorkerOpOutput {
    if (this.deps.mode !== 'telegram') {
      return { ok: false, code: 'wrong_control_surface', message: 'Agent 后台工作只在 Telegram 控制。' }
    }
    if (commitment.workerSessionId === null) {
      return { ok: false, code: 'worker_control_failed', message: '没有可暂停的后台子会话。' }
    }
    const res = this.deps.store.pauseAgent(commitment.id, commitment.revision)
    if (!res.ok) return { ok: false, ...writeResultToToolError(res) }
    this.deps.abortInFlight?.(commitment.id)
    try {
      this.deps.subagents.interrupt(SessionId(commitment.workerSessionId), {
        kind: 'user',
        parentSessionId: SessionId(this.deps.telegramParentSessionId),
      })
    } catch (error) {
      const message = cleanError(error)
      const fresh = this.deps.store.getById(commitment.id)
      if (fresh !== undefined) {
        this.deps.store.failWorker(fresh.id, fresh.revision, `暂停失败：interrupt 抛出 ${message}`)
      }
      return {
        ok: false,
        code: 'worker_control_failed',
        message: '已标记暂停，但中断后台轮次失败；已把状态标为受阻。',
        ...message === '' ? {} : { detail: message },
      }
    }
    return { ok: true, row: res.row }
  }

  /** Resume an agent commitment: persist first, then followup the SAME child. */
  async resume(
    commitment: CommitmentRow,
    agent: Agent,
    direction: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<WorkerOpOutput> {
    if (this.deps.mode !== 'telegram') {
      return { ok: false, code: 'wrong_control_surface', message: 'Agent 后台工作只在 Telegram 控制。' }
    }
    const parentSessionId = agent.session.id
    if (commitment.workerParentSessionId !== null && parentSessionId !== commitment.workerParentSessionId) {
      return {
        ok: false,
        code: 'wrong_control_surface',
        message: '恢复必须来自保存的后台子会话父 Agent。',
      }
    }
    if (commitment.workerSessionId === null) {
      return { ok: false, code: 'worker_control_failed', message: '后台子会话不可用（启动结果不确定）。' }
    }
    const res = this.deps.store.resumeAgent(commitment.id, commitment.revision)
    if (!res.ok) return { ok: false, ...writeResultToToolError(res) }
    try {
      await this.deps.subagents.followup(
        agent,
        SessionId(commitment.workerSessionId),
        [{ type: 'text', text: buildResumeText(direction) }],
        {
          source: { kind: 'plugin', plugin: 'dsh-assistant' },
          signal: signal ?? new AbortController().signal,
        },
      )
    } catch (error) {
      const message = cleanError(error)
      const fresh = this.deps.store.getById(commitment.id)
      if (fresh !== undefined && fresh.revision === res.row.revision && fresh.status === 'active') {
        this.deps.store.rollbackResume(fresh.id, fresh.revision)
      }
      return {
        ok: false,
        code: 'worker_control_failed',
        message: '恢复失败：无法把消息送达后台子会话。',
        ...message === '' ? {} : { detail: message },
      }
    }
    const fresh = this.deps.store.getById(commitment.id)
    return { ok: true, row: fresh ?? res.row }
  }

  /** Cancel an agent commitment: persist terminal first, then interrupt. */
  cancel(commitment: CommitmentRow): WorkerOpOutput {
    if (this.deps.mode !== 'telegram') {
      return { ok: false, code: 'wrong_control_surface', message: 'Agent 后台工作只在 Telegram 控制。' }
    }
    const res = this.deps.store.cancel(commitment.id, commitment.revision)
    if (!res.ok) return { ok: false, ...writeResultToToolError(res) }
    this.deps.abortInFlight?.(commitment.id)
    if (commitment.workerSessionId !== null) {
      try {
        this.deps.subagents.interrupt(SessionId(commitment.workerSessionId), {
          kind: 'user',
          parentSessionId: SessionId(this.deps.telegramParentSessionId),
        })
      } catch {
        // The terminal state is already durable; a late end must not reopen it.
      }
    }
    return { ok: true, row: res.row }
  }

  // ── internals ────────────────────────────────────────────────────────────

  private clearControlBestEffort(commitmentId: string): void {
    const fresh = this.deps.store.getById(commitmentId)
    if (fresh === undefined || fresh.workerControlState === 'none') return
    const res = this.deps.store.clearWorkerControl(commitmentId, fresh.revision)
    if (!res.ok) this.logWarn(`clearWorkerControl failed: ${res.message}`)
  }

  private settleBlocked(
    current: CommitmentRow,
    text: string,
    reason: string,
    nextAction: string | undefined,
    nowIso: string,
  ): void {
    const partial = boundedPartial(text, 1000)
    const outboxText = renderBlockedDelivery({
      title: current.title,
      summary: partial === '' ? '没有可用的部分输出' : partial,
      blocker: reason,
      ...nextAction === undefined ? {} : { nextAction },
    })
    this.settleTerminal(current, 'blocked', partial, reason, nextAction, outboxText, nowIso, current.workerRunId ?? undefined)
  }

  private settleTerminal(
    current: CommitmentRow,
    status: 'completed' | 'blocked',
    result: string,
    blockedReason: string | undefined,
    nextAction: string | undefined,
    outboxText: string,
    nowIso: string,
    workerRunId: string | undefined,
  ): void {
    const outboxId = workerRunId === undefined
      ? `worker:${current.id}:${nowIso}`
      : `worker:${current.id}:${workerRunId}`
    const res = this.deps.store.settleWorkerEnd(current.id, current.revision, {
      status,
      result,
      ...blockedReason === undefined ? {} : { blockedReason },
      ...nextAction === undefined ? {} : { nextAction },
      completedAt: nowIso,
      ...workerRunId === undefined ? {} : { workerRunId },
      outboxId,
      outboxText,
    })
    if (!res.ok) this.logWarn(`settleWorkerEnd failed: ${res.message}`)
  }

  private logWarn(message: string): void {
    this.deps.logger?.warn(`dsh-assistant: ${message}`)
  }
}
