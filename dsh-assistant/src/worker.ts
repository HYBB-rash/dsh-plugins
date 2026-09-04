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
 * - delegated resume persists `active + resume_requested` BEFORE `followup`;
 *   monitor pause/resume and direction replacement persist a fresh-round
 *   intent and wait for the old identity's exact stop before starting;
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
  boundText,
  cleanError,
  parseWorkerResult,
  renderBlockedDelivery,
  renderCompletedDelivery,
  boundedPartial,
  type ToolError,
} from './domain.ts'
import {
  AssistantStore,
  type CommitmentRow,
  type WriteResult,
} from './store.ts'

/** The opaque snapshot supplied to one monitor round. */
export interface MonitorRoundSnapshot {
  readonly direction: string
  readonly checkpoint: string | null
  readonly failedOrUncertainEventKeys: readonly string[]
}

/**
 * Build the complete prompt for one monitor round. Every fresh child receives
 * this complete snapshot; no child is asked to infer state from a prior turn.
 */
export function buildMonitorRoundPrompt(snapshot: MonitorRoundSnapshot): string {
  // Keep opaque values unambiguous at prompt boundaries. A key/checkpoint may
  // legitimately contain commas, newlines, or multibyte text; JSON escaping
  // lets the child recover the exact durable values without changing them or
  // imposing a second domain format.
  const failed = JSON.stringify(snapshot.failedOrUncertainEventKeys)
  const checkpoint = snapshot.checkpoint === null || snapshot.checkpoint.trim() === ''
    ? 'null'
    : JSON.stringify(snapshot.checkpoint)
  return [
    '这是一次长期监控的一轮执行，不代表长期监控已经完成。',
    '先校正业务 workspace，再按下面的完整快照工作：',
    `monitor_direction:\n${snapshot.direction}`,
    `confirmed checkpoint:\n${checkpoint}`,
    `已有 failed/uncertain event keys:\n${failed}`,
    '',
    '只等待并处理第一个新事件；不要处理第二个事件，也不要把没有变化当成事件。',
    'eventKey 必须是稳定、不透明、不含秘密或第三方隐私的事件键；不要把事件正文、凭据或敏感信息放进 eventKey。',
    '只返回一个严格的收口协议行，然后结束本轮：',
    'DSH_ASSISTANT_RESULT {"status":"completed","summary":"...","eventKey":"...","checkpoint":"..."}',
    '如果本轮确实受阻，返回 blocked 协议；不要假装完成，也不要自行启动下一轮。',
  ].join('\n')
}

function renderMonitorEventDelivery(title: string, summary: string): string {
  return boundText(`🔎 监控更新：${title}\n\n${summary}`)
}

type PendingStart = {
  readonly commitmentId: string
  readonly kind: 'delegate' | 'monitor-fresh'
  readonly claimToken?: string
  readonly monitorResumeEpoch?: number
}

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
  followup?: (
    parent: Agent,
    childId: SessionId,
    content: ContentBlock[],
    options: { source: { kind: 'plugin'; plugin: string }; signal: AbortSignal },
  ) => Promise<MessageId>
  sendMessage?: (
    sender: Agent,
    targetId: SessionId,
    content: ContentBlock[],
    options: { signal: AbortSignal },
  ) => Promise<MessageId>
}

/** Default child persona: focus on the delegation, never manage commitments. */
export const DEFAULT_CHILD_PERSONA = [
  'You are a delegated background worker for the user\'s private assistant.',
  'Complete exactly the task given in your first message, working autonomously and to completion.',
  'You do not manage commitments: never call any assistant_task_* tool and never create or complete commitments.',
  'Use the official report tool only for a meaningful completed stage, a concrete blocker, or a long stage whose current state matters. Do not send fixed-interval heartbeats and do not use report for the final result.',
  'Your final message is collected by dsh-assistant automatically. If you lack permissions or need a user decision, finish with the blocked protocol instead of guessing.',
  'For ordinary delegated work, finish your final message with exactly one protocol line as the last non-empty line:',
  'DSH_ASSISTANT_RESULT {"status":"completed","summary":"<what you finished>","evidence":["<key evidence>"]}',
  'If the first task message declares a monitor round, its complete monitor-round protocol takes precedence over the ordinary delegated example: a completed line must include both eventKey and checkpoint, exactly as required by that first message.',
  'For either kind, when you cannot finish:',
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
  private readonly pendingStarts = new Map<string, PendingStart[]>()
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
    const start = pending?.shift()
    if (pending !== undefined && pending.length === 0) this.pendingStarts.delete(String(parentSessionId))
    if (start === undefined) return
    const current = this.deps.store.getById(start.commitmentId)
    if (current === undefined || current.workOwner !== 'agent') return
    if (current.status === 'completed' || current.status === 'cancelled') return
    if (current.workerSessionId !== null) return

    if (start.kind === 'monitor-fresh') {
      const claimToken = start.claimToken
      const epoch = start.monitorResumeEpoch
      if (claimToken === undefined || epoch === undefined) return
      const res = this.deps.store.saveMonitorWorkerIdentity(current.id, current.revision, claimToken, epoch, {
        workerSessionId: String(info.id),
        workerRunId: String(info.runId),
        workerParentSessionId: String(parentSessionId),
      })
      if (!res.ok) this.logWarn(`saveMonitorWorkerIdentity failed: ${res.message}`)
      return
    }

    // Only the delegate's pending window may adopt an identity; a generic
    // subagent start on an active commitment must not hijack the fields.
    if (current.status !== 'pending') return
    const res = this.deps.store.saveWorkerIdentity(current.id, current.revision, {
      workerSessionId: String(info.id),
      workerRunId: String(info.runId),
      workerParentSessionId: String(parentSessionId),
    })
    if (!res.ok) {
      this.logWarn(`saveWorkerIdentity failed: ${res.message}`)
      return
    }
    // A monitor round may end synchronously inside startContinuable, before
    // delegate() receives its returned promise. Mark only initial monitors
    // active immediately after identity persistence so settleMonitorEvent can
    // authenticate that run; ordinary delegated work retains its pending
    // window until delegate() completes.
    if (current.kind === 'monitor') {
      const active = this.deps.store.markAgentActive(res.row.id, res.row.revision)
      if (!active.ok) this.logWarn(`markAgentActive for initial monitor failed: ${active.message}`)
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

    // A direction replacement or user pause deliberately leaves the old
    // identity bound until its matching terminal event confirms that the
    // interrupt took effect. In either control window, the old result is
    // never parsed or delivered, regardless of stopReason.
    if (current.kind === 'monitor' && current.workerControlState === 'pause_requested') {
      const expectedIdentity = {
        workerSessionId: String(info.id),
        workerRunId: String(info.runId),
        workerParentSessionId: current.workerParentSessionId ?? this.deps.telegramParentSessionId,
      }
      const confirmed = current.monitorDesiredState === 'running'
        ? this.deps.store.confirmMonitorFreshStop(current.id, current.revision, expectedIdentity)
        : this.deps.store.confirmMonitorPausedStop(current.id, current.revision, expectedIdentity)
      if (!confirmed.ok) this.logWarn(`monitor stop confirmation failed: ${confirmed.message}`)
      return
    }

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

    const parsed = parseWorkerResult(text, current.kind)
    if (parsed.kind === 'invalid') {
      this.settleBlocked(current, text, `后台轮次结束但没有给出有效收口结果：${parsed.reason}`, undefined, nowIso)
      return
    }
    const settlement = parsed.settlement
    const body = parsed.body !== '' ? parsed.body : settlement.summary
    if (settlement.status === 'completed' && current.kind === 'monitor') {
      const monitorSettlement = this.monitorSettlement(settlement)
      if (monitorSettlement === undefined) {
        this.settleBlocked(
          current,
          body,
          '监控轮次没有返回严格的 eventKey 和 checkpoint，目前未监控。',
          undefined,
          nowIso,
        )
        return
      }
      const settled = this.deps.store.settleMonitorEvent({
        commitmentId: current.id,
        expectedRevision: current.revision,
        workerSessionId: String(info.id),
        workerRunId: String(info.runId),
        workerParentSessionId: current.workerParentSessionId ?? this.deps.telegramParentSessionId,
        monitorResumeEpoch: current.monitorResumeEpoch,
        eventKey: monitorSettlement.eventKey,
        checkpoint: monitorSettlement.checkpoint,
        summary: monitorSettlement.summary,
        outboxText: renderMonitorEventDelivery(current.title, monitorSettlement.summary),
        now: nowIso,
      })
      if (!settled.ok) this.logWarn(`settleMonitorEvent failed: ${settled.message}`)
      // A normal monitor round is intentionally complete at this point. The
      // outbox pump + next ReminderRuntime tick own fresh-child continuation.
      return
    }
    if (settlement.status === 'completed') {
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
      ...(args.kind === 'monitor' ? { monitorDirection: args.prompt } : {}),
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
    pending.push({ commitmentId: commitment.id, kind: 'delegate' })
    this.pendingStarts.set(parentKey, pending)

    const monitorSnapshot = args.kind === 'monitor' ? this.monitorSnapshot(commitment) : undefined
    if (args.kind === 'monitor' && monitorSnapshot === undefined) {
      this.removePendingStart(parentKey, commitment.id)
      this.deps.store.markStartFailed(commitment.id, commitment.revision, '监控方向未持久化，目前未监控。')
      return { ok: false, code: 'worker_start_failed', message: '监控方向未持久化，目前未监控。' }
    }
    const monitorPrompt = args.kind === 'monitor'
      ? buildMonitorRoundPrompt(monitorSnapshot!)
      : args.prompt

    let started: { childId: SessionId; messageId: MessageId }
    try {
      started = await this.deps.subagents.startContinuable({
        provider: this.deps.provider ?? 'spawn',
        label: args.title,
        request: {
          prompt: [{ type: 'text', text: monitorPrompt }],
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
        const index = stillPending.findIndex(item => item.commitmentId === commitment.id)
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
      const index = stillPending.findIndex(item => item.commitmentId === commitment.id)
      if (index >= 0) stillPending.splice(index, 1)
      if (stillPending.length === 0) this.pendingStarts.delete(parentKey)
    }

    const fresh = this.deps.store.getById(commitment.id)
    if (fresh === undefined) {
      return { ok: false, code: 'persistence_failed', message: '承诺状态丢失，无法确认后台子会话。' }
    }
    if (fresh.status === 'cancelled') {
      // Cancellation can win while startContinuable is still resolving. The
      // start event is deliberately not bound to a terminal row, so the
      // returned child must be interrupted explicitly to avoid an untracked
      // process continuing after cancellation.
      this.interruptStartedChild(started.childId)
      return { ok: true, row: fresh }
    }
    if (this.isSynchronousMonitorSettlement(commitment, fresh)) {
      return { ok: true, row: fresh }
    }
    if (fresh.status === 'completed' || fresh.status === 'blocked') {
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

  /**
   * Start fresh monitor rounds claimed by the current ReminderRuntime tick.
   * The claim is the only cross-process scheduling primitive: if another
   * controller wins it, this call simply skips that row.
   */
  async continueMonitors(agent: Agent, signal: AbortSignal): Promise<void> {
    if (this.deps.mode !== 'telegram' || this.stopping || signal.aborted) return
    this.ensureInstalled(agent)
    for (const candidate of this.deps.store.listMonitorsNeedingResume()) {
      if (this.stopping || signal.aborted) return
      // Cold restart recovery has a live identity and is handled by
      // recoverMonitors. Fresh rounds always claim an unbound monitor.
      if (candidate.kind !== 'monitor' || candidate.workerSessionId !== null) continue
      // A settled round may have left a pending/claimed monitor_event. The
      // event must reach terminal delivery before a new round is claimable;
      // this guard also protects against a broader store query during the
      // same tick or a second controller racing between reads.
      if (this.deps.store.listMonitorEventOutbox(candidate.id).some(item => item.state === 'pending' || item.state === 'claimed')) continue
      await this.startFreshMonitor(agent, candidate, signal)
    }
  }

  private async startFreshMonitor(agent: Agent, candidate: CommitmentRow, signal: AbortSignal): Promise<boolean> {
    const candidateSnapshot = this.monitorSnapshot(candidate)
    if (candidateSnapshot === undefined) {
      this.deps.store.failWorker(candidate.id, candidate.revision, '监控方向缺失，新轮次未启动，目前未监控。')
      return false
    }
    const token = randomUUID()
    const claimed = this.deps.store.claimFreshMonitor(candidate.id, candidate.revision, token, iso(this.deps.now))
    if (!claimed.ok) return false
    if (signal.aborted || this.stopping) return false

    const claimedRow = claimed.row
    const parentKey = String(agent.session.id)
    const pending = this.pendingStarts.get(parentKey) ?? []
    pending.push({
      commitmentId: claimedRow.id,
      kind: 'monitor-fresh',
      claimToken: token,
      monitorResumeEpoch: claimedRow.monitorResumeEpoch,
    })
    this.pendingStarts.set(parentKey, pending)

    let started: { childId: SessionId; messageId: MessageId }
    try {
      started = await this.deps.subagents.startContinuable({
        provider: this.deps.provider ?? 'spawn',
        label: claimedRow.title,
        request: {
          prompt: [{ type: 'text', text: buildMonitorRoundPrompt(this.monitorSnapshot(claimedRow) ?? candidateSnapshot) }],
          parent: agent,
          maxDepth: 1,
          persona: this.deps.childPersona ?? DEFAULT_CHILD_PERSONA,
        },
        signal,
      })
    } catch (error) {
      this.removePendingStart(parentKey, claimedRow.id)
      if (signal.aborted || this.stopping) return false
      const fresh = this.deps.store.getById(claimedRow.id)
      if (fresh !== undefined) {
        this.failFreshMonitor(
          fresh,
          `监控新轮次启动失败：${cleanError(error)}`,
        )
      }
      return false
    }

    this.removePendingStart(parentKey, claimedRow.id)
    const fresh = this.deps.store.getById(claimedRow.id)
    if (fresh === undefined) return false
    // A child may complete synchronously inside startContinuable. A valid
    // monitor round has then already detached the worker and left exactly its
    // monitor_event outbox; that is success, not an unpersisted identity.
    if (
      fresh.kind === 'monitor'
      && fresh.status === 'active'
      && fresh.monitorDesiredState === 'running'
      && fresh.workerSessionId === null
      && fresh.workerRunId === null
      && fresh.workerParentSessionId === null
      && fresh.workerControlState === 'none'
      && fresh.monitorResumeState !== 'claimed'
      && fresh.monitorClaimToken === null
      && fresh.monitorClaimedAt === null
      && fresh.monitorResumeEpoch === claimedRow.monitorResumeEpoch
      && fresh.revision > claimedRow.revision
      && this.deps.store.listMonitorEventOutbox(fresh.id).some(item => item.kind === 'monitor_event')
    ) return true
    if (fresh.status === 'cancelled') {
      this.interruptStartedChild(started.childId)
      return false
    }
    if (fresh.status === 'blocked') return false
    if (fresh.workerSessionId !== String(started.childId)) {
      const interrupted = this.interruptStartedChild(started.childId)
      const claimStillCurrent = fresh.monitorResumeState === 'claimed'
        && fresh.workerControlState === 'resume_requested'
      // A direction replacement may have deliberately invalidated this
      // claim, leaving active/needed for the next tick. If the known child
      // was successfully interrupted, preserve that fresh-needed path. Only
      // an interrupt failure in the invalidated active/needed shape needs the
      // narrow blocked/no-resume failure transaction.
      if (claimStillCurrent || !interrupted) {
        this.failFreshMonitor(fresh, '监控新轮次启动结果不确定：child 身份未持久化')
      }
      return false
    }
    return true
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
      const snapshot = this.monitorSnapshot(candidate)
      if (snapshot === undefined) {
        this.failMonitorRecovery(claimed.row, '监控方向缺失，恢复未启动，目前未监控。')
        continue
      }
      try {
        await this.sendFollowup(
          agent,
          SessionId(candidate.workerSessionId),
          [{ type: 'text', text: buildMonitorRoundPrompt(snapshot) }],
          signal,
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

  /** Send a follow-up prompt to an existing continuable child, supporting both API shapes. */
  private async sendFollowup(
    parent: Agent,
    childId: SessionId,
    content: ContentBlock[],
    signal: AbortSignal,
  ): Promise<MessageId> {
    if (this.deps.subagents.followup !== undefined) {
      return this.deps.subagents.followup(parent, childId, content, {
        source: { kind: 'plugin', plugin: 'dsh-assistant' },
        signal,
      })
    }
    if (this.deps.subagents.sendMessage !== undefined) {
      return this.deps.subagents.sendMessage(parent, childId, content, { signal })
    }
    throw new Error('dsh-subagent runtime missing followup/sendMessage support')
  }

  private failMonitorRecovery(row: CommitmentRow, reason: string): void {
    const nowIso = iso(this.deps.now)
    const text = renderBlockedDelivery({ title: row.title, summary: row.progressSummary ?? '等待恢复原监控', blocker: reason })
    const res = this.deps.store.failMonitorResume(row.id, row.revision, reason, nowIso, text)
    if (!res.ok) this.logWarn(`failMonitorResume failed: ${res.message}`)
  }

  /** Fail a fresh-round claim atomically and leave one bounded notice. */
  private failFreshMonitor(row: CommitmentRow, reason: string): void {
    let claimed = row
    if (claimed.status === 'active'
      && claimed.monitorResumeState !== 'claimed'
      && claimed.monitorResumeState === 'needed'
      && claimed.workerSessionId === null
      && claimed.workerControlState === 'none'
      && claimed.monitorDesiredState === 'running') {
      const reacquired = this.deps.store.claimFreshMonitor(
        claimed.id,
        claimed.revision,
        randomUUID(),
        iso(this.deps.now),
      )
      if (!reacquired.ok) {
        this.logWarn(`claimFreshMonitor for failure settlement failed: ${reacquired.message}`)
        return
      }
      claimed = reacquired.row
    }
    const nowIso = iso(this.deps.now)
    const text = renderBlockedDelivery({
      title: claimed.title,
      summary: claimed.progressSummary ?? '等待启动新的监控轮次',
      blocker: reason,
    })
    const res = this.deps.store.failMonitorResume(claimed.id, claimed.revision, reason, nowIso, text)
    if (!res.ok) this.logWarn(`failMonitorResume failed: ${res.message}`)
  }

  /** Pause an agent commitment: persist first, then really interrupt. */
  pause(commitment: CommitmentRow): WorkerOpOutput {
    if (this.deps.mode !== 'telegram') {
      return { ok: false, code: 'wrong_control_surface', message: 'Agent 后台工作只在 Telegram 控制。' }
    }
    if (commitment.workerSessionId === null && commitment.kind !== 'monitor') {
      return { ok: false, code: 'worker_control_failed', message: '没有可暂停的后台子会话。' }
    }
    const res = this.deps.store.pauseAgent(commitment.id, commitment.revision)
    if (!res.ok) return { ok: false, ...writeResultToToolError(res) }
    // Let the outbox layer inspect every in-flight row after desired=paused
    // is durable. Its kind-specific gate preserves monitor_event delivery
    // while retaining the ordinary abort behavior for progress/blocked rows.
    this.deps.abortInFlight?.(commitment.id)
    if (commitment.workerSessionId === null) {
      if (commitment.kind === 'monitor') return { ok: true, row: res.row }
      return { ok: false, code: 'worker_control_failed', message: '没有可暂停的后台子会话。' }
    }
    try {
      this.deps.subagents.interrupt(SessionId(commitment.workerSessionId), {
        kind: 'user',
        parentSessionId: SessionId(this.deps.telegramParentSessionId),
      })
    } catch (error) {
      const message = cleanError(error)
      const fresh = this.deps.store.getById(commitment.id)
      if (fresh !== undefined && commitment.kind !== 'monitor') {
        this.deps.store.failWorker(fresh.id, fresh.revision, `暂停失败：interrupt 抛出 ${message}`)
      }
      return {
        ok: false,
        code: 'worker_control_failed',
        message: commitment.kind === 'monitor'
          ? '暂停意图已保存，但未确认旧轮次已停止；中断后台轮次失败。'
          : '已标记暂停，但中断后台轮次失败；已把状态标为受阻。',
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
    if (commitment.kind === 'monitor') {
      return this.restartMonitorWithDirection(commitment, agent, direction, signal, 'resume')
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
      await this.sendFollowup(
        agent,
        SessionId(commitment.workerSessionId),
        [{ type: 'text', text: buildResumeText(direction) }],
        signal ?? new AbortController().signal,
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

  /** Replace a monitor's complete direction, then interrupt and await a fresh round. */
  async replaceMonitorDirection(
    commitment: CommitmentRow,
    agent: Agent,
    direction: string,
    signal: AbortSignal | undefined,
  ): Promise<WorkerOpOutput> {
    if (commitment.kind !== 'monitor') {
      return { ok: false, code: 'invalid_transition', message: '只有 monitor 承诺可以替换监控方向。' }
    }
    return this.restartMonitorWithDirection(commitment, agent, direction, signal, 'direction')
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

  private removePendingStart(parentSessionId: string, commitmentId: string): void {
    const pending = this.pendingStarts.get(parentSessionId)
    if (pending === undefined) return
    const index = pending.findIndex(item => item.commitmentId === commitmentId)
    if (index >= 0) pending.splice(index, 1)
    if (pending.length === 0) this.pendingStarts.delete(parentSessionId)
  }

  /** Build the complete fresh-round snapshot without exposing event bodies. */
  private monitorSnapshot(row: CommitmentRow): MonitorRoundSnapshot | undefined {
    if (row.monitorDirection === null || row.monitorDirection.trim() === '') return undefined
    const failedOrUncertainEventKeys = this.deps.store.listMonitorFailedOrUncertainEventKeys(row.id)
    return {
      direction: row.monitorDirection,
      checkpoint: row.monitorCheckpoint,
      failedOrUncertainEventKeys: [...new Set(failedOrUncertainEventKeys)],
    }
  }

  private monitorSettlement(settlement: {
    readonly eventKey?: string
    readonly checkpoint?: string
    readonly summary: string
  }): { readonly eventKey: string; readonly checkpoint: string; readonly summary: string } | undefined {
    if (settlement.eventKey === undefined || settlement.checkpoint === undefined) return undefined
    if (settlement.eventKey.trim() === '' || settlement.checkpoint.trim() === '') return undefined
    return {
      eventKey: settlement.eventKey,
      checkpoint: settlement.checkpoint,
      summary: settlement.summary,
    }
  }

  private restartMonitorWithDirection(
    commitment: CommitmentRow,
    agent: Agent,
    direction: string | undefined,
    signal: AbortSignal | undefined,
    intent: 'direction' | 'resume',
  ): Promise<WorkerOpOutput> {
    return this.restartMonitorWithDirectionAsync(commitment, agent, direction, signal, intent)
  }

  private async restartMonitorWithDirectionAsync(
    commitment: CommitmentRow,
    agent: Agent,
    direction: string | undefined,
    signal: AbortSignal | undefined,
    intent: 'direction' | 'resume',
  ): Promise<WorkerOpOutput> {
    const parentSessionId = String(agent.session.id)
    if (commitment.workerParentSessionId !== null && parentSessionId !== commitment.workerParentSessionId) {
      return {
        ok: false,
        code: 'wrong_control_surface',
        message: '监控恢复必须来自保存的后台子会话父 Agent。',
      }
    }
    // A monitor resume is an explicit lifecycle intent, not a direction
    // update. Its prompt must use the direction already persisted on the
    // commitment; callers must use revise_monitor/replaceMonitorDirection to
    // change that direction first.
    const replacement = intent === 'resume'
      ? commitment.monitorDirection
      : direction === undefined || direction.trim() === ''
        ? commitment.monitorDirection
        : direction.trim()
    if (replacement === null || replacement.trim() === '') {
      return { ok: false, code: 'invalid_transition', message: '监控方向不能为空。' }
    }
    const replaced = intent === 'resume'
      ? this.deps.store.requestMonitorResume(commitment.id, commitment.revision, replacement, iso(this.deps.now))
      : this.deps.store.replaceMonitorDirection(commitment.id, commitment.revision, replacement, iso(this.deps.now))
    if (!replaced.ok) {
      return { ok: false, code: replaced.code === 'not_found' ? 'no_current_commitment' : 'invalid_transition', message: replaced.message }
    }

    // The replacement is durable before the old child is interrupted. Any
    // stale end from that child now fails the run/epoch checks and has no
    // side effect; the next runtime tick starts the fresh child.
    const oldWorker = replaced.oldWorker
    const stopAlreadyRequested = commitment.workerControlState === 'pause_requested'
    if (oldWorker !== null && !stopAlreadyRequested) {
      try {
        this.deps.subagents.interrupt(SessionId(oldWorker.workerSessionId), {
          kind: 'user',
          parentSessionId: SessionId(oldWorker.workerParentSessionId),
        })
      } catch (error) {
        // The complete replacement and epoch invalidation are already
        // durable. Keep pause_requested and the old identity bound when the
        // interrupt call itself throws: only its exact terminal end may clear
        // the stop gate. A generic failWorker here would make the old run
        // look current again and allow a late result to be consumed.
        this.logWarn(`监控方向已保存，但旧轮次中断失败：${cleanError(error)}`)
        return { ok: false, code: 'worker_control_failed', message: '监控方向已保存，但旧轮次中断失败。' }
      }
    }
    if (signal?.aborted || this.stopping) {
      const latest = this.deps.store.getById(commitment.id)
      return latest === undefined
        ? { ok: false, code: 'persistence_failed', message: '监控状态暂时不可读。' }
        : { ok: true, row: latest }
    }

    // Do not start directly from this user-control path. The old identity is
    // intentionally still bound until its matching end confirms the
    // interrupt; the same reminder tick seam that handles outbox terminal
    // states serializes the subsequent fresh claim.
    const latest = this.deps.store.getById(commitment.id)
    if (latest === undefined) return { ok: false, code: 'persistence_failed', message: '监控状态暂时不可读。' }
    if (latest.status === 'blocked') {
      return { ok: false, code: 'worker_start_failed', message: '监控新轮次启动失败，目前未监控。' }
    }
    return { ok: true, row: latest }
  }

  private clearControlBestEffort(commitmentId: string): void {
    const fresh = this.deps.store.getById(commitmentId)
    if (fresh === undefined || fresh.workerControlState === 'none') return
    const res = this.deps.store.clearWorkerControl(commitmentId, fresh.revision)
    if (!res.ok) this.logWarn(`clearWorkerControl failed: ${res.message}`)
  }

  private isSynchronousMonitorSettlement(baseline: CommitmentRow, fresh: CommitmentRow): boolean {
    return fresh.kind === 'monitor'
      && fresh.status === 'active'
      && fresh.monitorDesiredState === 'running'
      && fresh.workerSessionId === null
      && fresh.workerRunId === null
      && fresh.workerParentSessionId === null
      && fresh.workerControlState === 'none'
      && fresh.monitorResumeState !== 'claimed'
      && fresh.monitorClaimToken === null
      && fresh.monitorClaimedAt === null
      && fresh.monitorResumeEpoch === baseline.monitorResumeEpoch
      && fresh.revision > baseline.revision
      && this.deps.store.listMonitorEventOutbox(fresh.id).some(item => item.kind === 'monitor_event')
  }

  private interruptStartedChild(childId: SessionId): boolean {
    try {
      this.deps.subagents.interrupt(childId, {
        kind: 'user',
        parentSessionId: SessionId(this.deps.telegramParentSessionId),
      })
      return true
    } catch (error) {
      this.logWarn(`interrupt known child failed: ${cleanError(error)}`)
      return false
    }
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
