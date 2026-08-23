/**
 * dsh-assistant: the private-personal-assistant plugin for DSH.
 *
 * One global user focus plus concurrent Telegram Agent responsibilities,
 * shared across Web and Telegram through a single SQLite store:
 * - `mode: web` — reads the state, tracks user-owned commitments, updates
 *   them; never scans reminders, never delivers Telegram, never controls
 *   agent children (surface rules keep those on Telegram);
 * - `mode: telegram` — additionally scans due reminders, pumps the Telegram
 *   outbox, and binds delegated agent work to continuable children.
 *
 * Every root agent (existing at mount AND created later) receives the
 * responsibility contract section and the assistant model tools on its own
 * scoped context.
 * @module @deepseek-ai/dsh-assistant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { randomUUID } from 'node:crypto'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { createTelegramHttp } from '@deepseek-ai/dsh-telegram-gateway'
import z from '@deepseek-ai/schemastery'
import { boundText, formatLocalTime } from './domain.ts'
import { createCronBoundMonitorRuntime } from './cron-bound-monitor.ts'
import { createAssistantCronControlAdapterFromSocket } from './cron-control-adapter.ts'
import { startAssistantCronControl } from './cron-composition.ts'
import { createCronControlUseCase } from './cron-control.ts'
import { reconcileCronBindings } from './cron-reconciliation.ts'
import { OutboxPump } from './outbox.ts'
import { ReminderRuntime } from './reminders.ts'
import { AssistantStore, defaultStorePath } from './store.ts'
import { registerAssistantTools, buildStatusOutput, type CronBindingView, type CommitmentView } from './tools.ts'
import { WorkerController } from './worker.ts'
import { WebTaskObserver } from './observer.ts'

/** Whether a message is one of the assistant worker's internal notices. */
function noticeKindOf(message: unknown): 'subagent-report' | 'subagent-settled' | undefined {
  if (typeof message !== 'object' || message === null) return undefined
  const source = (message as { source?: unknown }).source
  if (typeof source !== 'object' || source === null) return undefined
  const kind = (source as { kind?: unknown }).kind
  return kind === 'subagent-report' || kind === 'subagent-settled' ? kind : undefined
}

function senderSessionIdOf(message: unknown): string | undefined {
  if (typeof message !== 'object' || message === null) return undefined
  const source = (message as { source?: unknown }).source
  if (typeof source !== 'object' || source === null) return undefined
  const sender = (source as { senderSessionId?: unknown }).senderSessionId
  return typeof sender === 'string' ? sender : undefined
}

function messageIdOf(message: unknown): string | undefined {
  if (typeof message !== 'object' || message === null) return undefined
  const id = (message as { id?: unknown }).id
  return typeof id === 'string' && id !== '' ? id : undefined
}

function messageTextOf(message: unknown): string {
  if (typeof message !== 'object' || message === null) return ''
  const content = (message as { content?: unknown }).content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is { type: 'text'; text: string } => (
      typeof block === 'object' && block !== null
      && (block as { type?: unknown }).type === 'text'
      && typeof (block as { text?: unknown }).text === 'string'
    ))
    .map(block => block.text)
    .join('')
    .trim()
}

/**
 * The worker notice sink (验收返工 §4.3): a scoped `agent/pre-step` filter on
 * the Telegram interactive root that removes THIS plugin's own
 * `subagent-report` / `subagent-settled` notices from the model batch. Own
 * notices must never wake the parent model into a user-visible reply — the
 * outbox is the single user-facing deliverer. Other children's reports are
 * preserved; store failures fail open.
 */
export function createWorkerNoticeSink(
  store: Pick<AssistantStore, 'ownsWorkerSession' | 'recordWorkerProgress'>,
  parentSessionId: string,
  logger?: { warn(message: string): void },
  now: () => number = Date.now,
): (payload: { messages: UserMessage[] }, next: () => Promise<PreStepDecision>) => Promise<PreStepDecision> {
  const isOwnNotice = (message: unknown): boolean => {
    if (noticeKindOf(message) === undefined) return false
    const sender = senderSessionIdOf(message)
    if (sender === undefined) return false
    try {
      if (!store.ownsWorkerSession(sender, parentSessionId)) return false
      if (noticeKindOf(message) === 'subagent-report') {
        const messageId = messageIdOf(message)
        const text = messageTextOf(message)
        if (messageId !== undefined && text !== '') {
          store.recordWorkerProgress(sender, messageId, text, new Date(now()).toISOString())
        }
      }
      return true
    } catch (error) {
      // Fail open: never swallow an unknown message because the store query
      // failed; record a bounded log line.
      logger?.warn(`dsh-assistant: ownsWorkerSession query failed; preserving the notice: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }
  return async (payload, next): Promise<PreStepDecision> => {
    const messages = payload.messages
    if (!messages.some(message => noticeKindOf(message) !== undefined)) return next()
    const remaining: UserMessage[] = []
    let own = 0
    for (const message of messages) {
      if (isOwnNotice(message)) own++
      else remaining.push(message)
    }
    if (own === 0) return next()
    // Own notices removed: enter with only the real messages (possibly none,
    // which suppresses the model request entirely).
    return { kind: 'enter', messages: remaining }
  }
}

/** Stable Cordis plugin name. */
export const name = 'dsh-assistant'

/** Core services required by either mode before activation. */
export const inject = ['agents', 'tools', 'systemPrompt', 'subagents', 'credentials']

/** dsh-assistant configuration (§4.1). */
export interface Config {
  /** Which profile this runs: web (manager) or telegram (scheduler+delivery). */
  mode: 'web' | 'telegram'
  /** SQLite store path. Defaults to `$DSH_HOME/storages/dsh-assistant/state.sqlite`. */
  storePath?: string
  /** Reminder scan + outbox poll interval. Default 5000, min 1000. */
  pollIntervalMs?: number
  /** Telegram API base URL. Defaults to https://api.telegram.org. */
  apiBaseUrl?: string
  /** Bot token; falls back to the TELEGRAM_BOT_TOKEN credential reference. */
  token?: string
  /** Numeric chat id; falls back to the TELEGRAM_ALLOWED_CHAT_ID credential reference. */
  chatId?: string
  /** Subagent provider for continuable children. Defaults to `spawn`. */
  subagentProvider?: string
  /** Durable parent session id of the Telegram root. Defaults to `session-telegram`. */
  telegramParentSessionId?: string
  /** Missed-reminder honesty threshold. Default 2 hours. */
  lateReminderAfterMs?: number
  /** Explicit dsh-cron manager control socket; no implicit path is guessed. */
  cronControlSocketPath?: string
}

export const Config: z<Config> = z.object({
  mode: z.union(['web', 'telegram'] as const).default('web'),
  storePath: z.string().default(''),
  pollIntervalMs: z.number().step(1).min(1_000).default(5_000),
  apiBaseUrl: z.string().default('https://api.telegram.org'),
  token: z.string(),
  chatId: z.string(),
  subagentProvider: z.string().default('spawn'),
  telegramParentSessionId: z.string().default('session-telegram'),
  lateReminderAfterMs: z.number().step(1).min(0).default(2 * 60 * 60 * 1000),
  cronControlSocketPath: z.string().default(''),
})

/** Resolve a config value or its credential reference (env-inherited first). */
async function resolveSecret(ctx: Context, configured: string | undefined, ref: string): Promise<string | undefined> {
  if (configured !== undefined && configured !== '') return configured
  const credentials = ctx.get('credentials')
  if (credentials === undefined) return undefined
  const hit = await credentials.resolve(credentialRef(ref))
  return hit?.value
}

/** Status labels for the dynamic prompt snapshot. */
function statusLabel(status: string): string {
  switch (status) {
    case 'pending': return '待开始'
    case 'active': return '进行中'
    case 'paused': return '已暂停'
    case 'blocked': return '受阻'
    default: return status
  }
}

/** Per-item progress budget for the automatic prompt snapshot. */
const PROMPT_PROGRESS_MAX = 400
const PROMPT_CLOSED_TITLE_MAX = 160

function boundedCronReason(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value)
  return text.length > 400 ? `${text.slice(0, 399)}…` : text
}

function cronBindingPrompt(binding: CronBindingView): string {
  const lastRun = binding.lastRun
  const schedule = binding.schedule === null ? 'null' : boundText(JSON.stringify(binding.schedule), 400)
  const desiredState = boundText(binding.desiredState, 32)
  const desiredCwd = binding.desiredCwd === null ? 'null' : boundText(binding.desiredCwd, 160)
  const boundJobId = binding.boundJobId === null ? 'null' : boundText(binding.boundJobId, 160)
  const runStatus = lastRun === null ? 'null' : boundText(lastRun.runStatus, 32)
  const deliveryState = lastRun === null ? 'null' : boundText(lastRun.deliveryState, 32)
  const controlError = binding.controlError === null ? 'null' : boundText(binding.controlError, 400)
  const summary = lastRun?.summary === null || lastRun?.summary === undefined
    ? 'null'
    : boundText(lastRun.summary, PROMPT_PROGRESS_MAX)
  const runError = lastRun?.runError === null || lastRun?.runError === undefined
    ? 'null'
    : boundText(lastRun.runError, 400)
  const deliveryError = lastRun?.deliveryError === null || lastRun?.deliveryError === undefined
    ? 'null'
    : boundText(lastRun.deliveryError, 400)
  return [
    `；Cron desiredState=${desiredState}`,
    `；schedule=${schedule}`,
    `；desiredCwd=${desiredCwd}`,
    `；boundJobId=${boundJobId}`,
    `；runStatus=${runStatus}`,
    `；deliveryState=${deliveryState}`,
    `；controlError=${controlError}`,
    `；summary=${summary}`,
    `；runError=${runError}`,
    `；deliveryError=${deliveryError}`,
  ].join('')
}

function monitorPromptFacts(item: CommitmentView): string {
  if (item.kind !== 'monitor') return ''
  return item.cronBinding === null ? '；需显式 schedule 绑定' : cronBindingPrompt(item.cronBinding)
}

/**
 * Park open legacy monitors that have no assistant Cron binding. This
 * composition-root compatibility step uses existing store lifecycle writes;
 * it never invents a binding or starts a child. A complete stale worker
 * identity is cleared through the existing pause/confirmation handshake.
 */
function parkUnboundLegacyMonitors(
  store: AssistantStore,
  logger?: { warn(message: string): void },
): void {
  const warn = (message: string): void => logger?.warn(`dsh-assistant: ${message}`)
  const blocker = '未绑定 Cron：该 legacy monitor 尚未绑定 Cron，恢复需要显式 schedule'
  const nextAction = '请提供显式 schedule 后再恢复'
  for (const listed of store.listTelegramAgentResponsibilities(1_000)) {
    if (listed.kind !== 'monitor' || store.getCronBinding(listed.id) !== undefined) continue
    let current = store.getById(listed.id)
    if (current === undefined) continue

    const identity = current.workerSessionId !== null
      && current.workerRunId !== null
      && current.workerParentSessionId !== null
      ? {
        workerSessionId: current.workerSessionId,
        workerRunId: current.workerRunId,
        workerParentSessionId: current.workerParentSessionId,
      }
      : undefined
    if (identity !== undefined) {
      // normalizeAgentOnStartup parks a recoverable legacy child as paused;
      // move it through the existing pause confirmation so all identity
      // columns are cleared without creating an outbox event.
      if (current.status !== 'active') {
        const activated = store.setCommitmentStatus(current.id, 'active')
        if (activated === undefined) {
          warn(`could not prepare unbound monitor ${current.id} for worker cleanup`)
          continue
        }
        current = activated
      }
      const requested = store.pauseAgent(current.id, current.revision)
      if (!requested.ok) {
        warn(`could not request cleanup for unbound monitor ${current.id}: ${requested.message}`)
        continue
      }
      const confirmed = store.confirmMonitorPausedStop(current.id, requested.row.revision, identity)
      if (!confirmed.ok) {
        warn(`could not clear stale worker for unbound monitor ${current.id}: ${confirmed.message}`)
        continue
      }
      current = confirmed.row
    }

    // `block()` is the durable user-visible blocker contract. A paused
    // legacy row is first reopened through the existing status API so block()
    // can record both the reason and the explicit schedule next action.
    if (current.status === 'paused') {
      const reopened = store.setCommitmentStatus(current.id, 'active')
      if (reopened === undefined) {
        warn(`could not prepare paused unbound monitor ${current.id} for blocking`)
        continue
      }
      current = reopened
    }
    if (current.status === 'active' || current.status === 'pending') {
      const blocked = store.block(current.id, current.revision, blocker, nextAction)
      if (!blocked.ok) warn(`could not block unbound monitor ${current.id}: ${blocked.message}`)
    }
  }
}

function recentClosureDeliveryLabel(item: { status: string; lastDeliveryState: string | null }): string {
  if (item.status === 'cancelled') return '已取消，没有待等结果'
  switch (item.lastDeliveryState) {
    case 'delivered': return '终态已直接交付用户'
    case 'failed': return '终态投递失败，结果已保存；用户询问时用 assistant_task_status 取回'
    case 'uncertain': return '终态投递不确定，结果已保存；不能假称用户已经收到'
    default: return '终态投递待确认；由 outbox 负责，root 不得重复发送'
  }
}

/** The stable responsibility contract installed on every root (§9). */
/**
 * The Telegram interactive-root persona (验收返工 §4.1). Previously deployed
 * as the profile-wide `system-prompt` persona, which leaked the assistant
 * contract into every `session-cron-*` session in the same process. Now a
 * scoped prompt section installed ONLY on the qualified interactive root.
 */
export const ASSISTANT_PERSONA = [
  "You are the user's always-on private personal assistant, reachable through Telegram.",
  'Distinguish work the user plans to do from work explicitly delegated to you.',
  "For the user's own work, track, time, remind, pause, resume, and close the loop without doing the work for them.",
  'For work explicitly delegated to you, execute it and report completion or blockers.',
  "Keep replies concise and use the user's language. Assistant responsibility state is authoritative only for responsibilities dsh-assistant is tracking; it is not the user's complete personal task list. For personal task lists, follow the workspace-specified personal task source.",
  'When the user asks about work started in an independent Web conversation, use the read-only Web status tool if needed. Briefly relay the conclusion and key evidence; never take over or alter that Web work, and never poll it proactively.',
  // 消息级流式表达合同（Hermes-语义消息投递-落地指南）：gateway 会把完整
  // text + tool-call 的 assistant/message 立即作为不可变消息发送。
  'Telegram sends each complete assistant text that accompanies a tool call as an immediate, immutable user-visible message.',
  'Before calling tools, include user-visible text only when it is a complete, useful update that can stand on its own; omit trivial tool narration.',
  'Each later message must add progress, a correction, a result, or closure; do not mechanically repeat earlier messages in the final answer.',
  'A cron-bound monitor is scheduled and awakened by dsh-cron. Its run-finished observation is a manager fact; it does not spawn a continuable child or enter the assistant reminder tick. Only an explicit pause or cancel stops the binding.',
  'When a Cron monitor has no new observation or no change, Cron records success+silent; do not invent a synthetic event identity.',
].join('\n')

export const STABLE_CONTRACT = [
  '你是用户的私人助理，不只是收到短命令就执行的 coding agent。',
  '',
  '先判断工作归属：',
  '- 用户说「我准备做、我正在做、提醒我、帮我安排」时，工作由用户做；使用 assistant_track_task，你只负责记录、跟进、计时、暂停、恢复和收口，绝不代做内容。',
  '- 用户明确说「你去做、帮我查、改、修、落地、弄完告诉我」时，工作由你做；如果它会在本轮之后继续并需要回来汇报，使用 assistant_delegate_task。不要用通用 subagent 绕过承诺状态。',
  '- 普通问答、闲聊和能在当前回复内立即完成的一步请求，不自动创建承诺。',
  '- 含义不清且归属会改变是否产生副作用时，只问一句澄清问题。',
  '',
  '每项已接住的责任在结束前一直是你的跟进责任。用户当前时间焦点最多一项；Agent 委派和长期监控可以多项并存，互不占用焦点。',
  '任务来源必须分开，不能互相推断：',
  '- assistant_task_status 只读取 dsh-assistant 正在跟进的责任（含最近收口），不是你的完整个人任务清单。',
  '- 用户问「我的任务有哪些 / 我的待办 / 我还有什么要做 / 任务清单」时，按 workspace 指引读取现有个人任务事实源，不要先调用 assistant_task_status，也不要要求用户提供文件路径。',
  '- 只有明确问「当前承诺是什么 / 你在跟进哪件事 / 这件事跟到哪了」时，才优先调用 assistant_task_status。',
  '- 一个来源为空不能证明另一个来源也为空：当前承诺为空不代表个人任务清单为空，个人任务清单为空也不代表没有当前承诺。',
  '- 不要先搜 Session 或长期记忆来恢复当前承诺；现状以 assistant_task_status 读取的持久化承诺为准。',
  '只有已有用户时间焦点时才拒绝第二个焦点并询问是否切换；Agent 委派和监控不得因此被拒绝。',
  '暂停、恢复、完成或取消时优先使用精确 commitmentId；多项候选仍无法唯一定位时先问用户，绝不按标题或最近一项猜。',
  'monitor 表示持续到用户明确暂停或取消的监控；cron-bound monitor 的时钟和唤醒由 dsh-cron 持有，assistant 只保存用户期望与 manager 回传的运行事实，不启动 continuable child，也不走 reminder tick。普通 delegated worker 仍沿用现有 worker 生命周期。',
  'Cron 监控没有新观察或无更新时记为 success+silent，不要编造事件身份；只有 Cron 或明确的控制结果显示异常时才如实说明。',
  '只有工具或 worker lifecycle 确认状态变化后，才能声称已暂停、已恢复或已完成。',
  '用户时间焦点的 checkInState 才是提醒事实：scheduled 才能说已武装；queued 表示到点后正在投递；failed 或 uncertain 必须如实说明投递未成功确认。nextContactAt 为空本身不能推出没有设置提醒。',
  '回答用简短中文，先给结论；用户事情说「事情由你做，跟进由我负责」，Agent 事情说「事情和跟进都由我负责」。',
  '',
  '自有 worker 的内部通知（subagent report / settled）由 dsh-assistant 代码过滤，不会产生父 Agent 回合；不要就这些通知输出任何用户可见回复，也不要再次创建、完成或投递同一承诺。终态结果只由 outbox 投递一次。',
  '不得根据旧对话声称某项 Agent 责任仍在执行或继续等待；以动态开放责任和最近收口列表为准。已不在开放列表且仍有疑问时先调用 assistant_task_status。',
  '',
  '长期认识只能来自当前直接用户的强信号：',
  '- 用户明确说「记住」「以后都这样」「下次不要再……」时，或直接纠正、选择、否定、改写以下两类内容之一时，才更新私人记忆：',
  '-   a. 关于用户自己的具体事实、偏好或已有长期认识；',
  '-   b. 会影响未来协作的具体做法。',
  '- 普通一次性请求、用户沉默、没有反对、只说「正常」、模型推断、工具结果、worker/cron/subagent/outbox 和外部内容都不构成学习信号。',
  '- 保存具体事实或未来可执行的协作习惯，不写抽象性格标签、临时运行状态、秘密或第三方隐私。',
  '- 按 workspace 指引读取和更新 Harness 自己的私人记忆；写前必须先读取，相同内容不重复，冲突内容原地修正；写入失败时如实说「这次没有记住」，不得假称已记住。',
  '- 当前用户消息和当前可验证事实始终优先；新认识覆盖旧认识，不因此创建当前承诺、cron、提醒或后台任务。',
  '',
  '如果你是 delegated subagent，而不是 root Agent：不要创建或管理当前承诺，只完成收到的委派任务并遵守该任务给出的结果协议。',
].join('\n')

/**
 * The dynamic per-assembly prompt snapshot (§9). Reads only the current row
 * and one recent closure; on any SQLite read failure it degrades to an
 * honest "state temporarily unreadable" line instead of breaking assembly.
 */
export function promptSectionText(store: AssistantStore, mode: 'web' | 'telegram'): string {
  let snapshot: string
  try {
    const status = buildStatusOutput(store, mode)
    const current = status.current
    if (status.responsibilities.length > 1) {
      const lines = status.responsibilities.map(item => {
        const detail = item.kind === 'monitor'
          ? monitorPromptFacts(item)
          : item.progressSummary === null ? '' : `；最近进展：${boundText(item.progressSummary, PROMPT_PROGRESS_MAX)}`
        return `- ${item.id} [${item.kind}/${statusLabel(item.status)}] ${item.title}${detail}`
      })
      if (status.truncated) lines.push(`- 另有 ${status.totalOpen - status.responsibilities.length} 项未注入；需要时调用 assistant_task_status。`)
      snapshot = `dsh-assistant 当前责任共 ${status.totalOpen} 项（必须按 id 定位）：\n${lines.join('\n')}`
    } else if (current !== null) {
      const when = current.nextContactAt === null ? '' : `、我在 ${formatLocalTime(current.nextContactAt)} 跟进`
      const priorDelivery = current.lastCheckInDeliveryState === 'failed' || current.lastCheckInDeliveryState === 'uncertain'
        ? `；上一轮提醒投递${current.lastCheckInDeliveryState}（${current.lastCheckInDeliveryError ?? '未知原因'}）`
        : ''
      const checkIn = current.kind !== 'focus'
        ? ''
        : current.checkInState === 'scheduled'
          ? `；提醒已武装${priorDelivery}`
        : current.checkInState === 'failed' || current.checkInState === 'uncertain'
          ? `；上一轮提醒投递${current.checkInState}（${current.lastCheckInDeliveryError ?? '未知原因'}）`
            : current.checkInState === 'queued'
              ? '；提醒已到点，正在投递'
              : ''
      const next = current.nextAction === null ? '等待你的指示' : current.nextAction
      snapshot = [
        `dsh-assistant 当前承诺 ${current.id}（${current.kind}，revision ${current.revision}）：${current.title}；`,
        `工作归${current.workOwner === 'user' ? '用户' : 'Agent'}；`,
        `${statusLabel(current.status)}；`,
        `下一步是${next}${when}${checkIn}${monitorPromptFacts(current)}。`,
      ].join('')
    } else if (status.lastClosed !== null) {
      const closed = status.lastClosed
      const delivery = closed.lastDeliveryState === 'failed' || closed.lastDeliveryState === 'uncertain'
        ? `主动投递${closed.lastDeliveryState}（${closed.lastDeliveryError ?? '未知原因'}）；结果已保存，可展开。`
        : `投递正常。`
      snapshot = `dsh-assistant 当前承诺：无。这只表示当前没有由 Harness 跟进的一项承诺，不表示个人任务清单为空。\n最近收口：${closed.title}；结果：${closed.result ?? '（无结果文本）'}；${delivery}`
    } else {
      snapshot = 'dsh-assistant 当前承诺：无。这只表示当前没有由 Harness 跟进的一项承诺，不表示个人任务清单为空。'
    }
    if (mode === 'telegram' && status.recentAgentClosures.length > 0) {
      const closures = status.recentAgentClosures.map(item => (
        `- ${item.id} [${item.status}] ${boundText(item.title, PROMPT_CLOSED_TITLE_MAX)}；${recentClosureDeliveryLabel(item)}`
      ))
      snapshot += [
        '',
        '最近已收口的 Agent 责任（最多 3 项；终态由 outbox 唯一投递，不得重复发送结果或声称仍在等待）：',
        ...closures,
      ].join('\n')
    }
  } catch {
    snapshot = 'dsh-assistant 当前承诺状态暂时不可读，请调用 assistant_task_status 且不要猜。'
  }
  return `${STABLE_CONTRACT}\n\n${snapshot}`
}

/**
 * Cordis plugin entry: open the shared store (fail loud on schema mismatch),
 * install the contract + tools on every existing and future root, and — in
 * telegram mode — resolve credentials, start the reminder/outbox runtime,
 * and normalize leftover agent commitments.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  await ctx.effect(async () => {
    const storePath = config.storePath !== undefined && config.storePath !== ''
      ? config.storePath
      : defaultStorePath()
    const store = new AssistantStore(storePath)
    const writerStartedAt = new Date().toISOString()
    const webObserver = config.mode === 'web'
      ? new WebTaskObserver(store, {
        writerInstanceId: randomUUID(),
        writerStartedAt,
      })
      : undefined

    const worker = new WorkerController({
      store,
      mode: config.mode,
      subagents: ctx.subagents,
      telegramParentSessionId: config.telegramParentSessionId ?? 'session-telegram',
      provider: config.subagentProvider ?? 'spawn',
      logger: ctx.logger,
    })

    let cronControlPort: import('./cron-control-port.ts').AssistantCronControlPort | undefined
    const cronControlSocketPath = typeof config.cronControlSocketPath === 'string'
      ? config.cronControlSocketPath.trim()
      : ''
    if (config.mode === 'telegram' && cronControlSocketPath !== '') {
      try {
        cronControlPort = createAssistantCronControlAdapterFromSocket({ socketPath: cronControlSocketPath })
      } catch (error: unknown) {
        ctx.logger.warn(`dsh-assistant: Cron control adapter unavailable: ${boundedCronReason(error)}`)
      }
    }
    const cronControl = cronControlPort === undefined
      ? undefined
      : createCronControlUseCase({ store, controlPort: cronControlPort })
    const cronMonitor = cronControlPort === undefined
      ? undefined
      : createCronBoundMonitorRuntime({ store, controlPort: cronControlPort })

    let reminders: ReminderRuntime | undefined
    const runtimes = new Map<Agent, () => void>()
    let stopping = false
    let telegramLifetime: AbortController | undefined
    let disposeCronRunFinished: () => void = () => {}

    if (cronMonitor !== undefined) {
      disposeCronRunFinished = ctx.on('dsh-cron/run-finished', async event => {
        try {
          const result = await cronMonitor.handleRunFinished(event as unknown as Record<string, unknown>)
          if (result.ok === false) {
            ctx.logger.warn(`dsh-assistant: Cron run-finished observation unavailable: ${boundedCronReason(result.message ?? 'observation failed')}`)
          }
        } catch (error: unknown) {
          ctx.logger.warn(`dsh-assistant: Cron run-finished observer failed: ${boundedCronReason(error)}`)
        }
      })
    }

    /**
     * Whether this root is a qualified USER-INTERACTIVE root (验收返工 §4.1).
     * `session-cron-*` roots are runtime roots too, but they must never see
     * the assistant tools, contract, or current commitment body.
     */
    const isQualifiedRoot = (agent: Agent): boolean => {
      if (agent.session.id === undefined) return false
      if (String(agent.session.id).startsWith('session-cron-')) return false
      if (config.mode === 'telegram') {
        return agent.session.id === (config.telegramParentSessionId ?? 'session-telegram')
      }
      // Web mode: every current web host root is a user-interactive root.
      return true
    }

    const installForRoot = (agent: Agent): void => {
      if (runtimes.has(agent)) return
      if (!isQualifiedRoot(agent)) return
      const disposers: Array<() => void> = []
      disposers.push(agent.ctx.effect(() => {
        // Scoped, root-local assistant tools (§4.1): never the global ctx.
        const disposeTools = registerAssistantTools(agent.ctx, {
          store,
          mode: config.mode,
          ...config.mode === 'telegram' ? { worker } : {},
          ...config.mode === 'telegram' && cronControl !== undefined ? { cronControl } : {},
          abortInFlight: commitmentId => reminders?.abortInFlight(commitmentId),
        })
        let disposePersona: () => void = () => {}
        if (config.mode === 'telegram') {
          disposePersona = agent.ctx.systemPrompt.section({
            name: 'assistant:persona',
            order: 0,
            text: ASSISTANT_PERSONA,
          })
        }
        const disposeSection = agent.ctx.systemPrompt.section({
          name: 'assistant:current-commitment',
          order: 95,
          text: () => promptSectionText(store, config.mode),
        })
        let disposeObserver: () => void = () => {}
        if (webObserver !== undefined) {
          disposeObserver = agent.ctx.on('session/event', (session, event) => {
            if (session !== agent.session) return
            webObserver.handle(session, event)
          })
        }
        let disposeNoticeSink: () => void = () => {}
        if (config.mode === 'telegram') {
          disposeNoticeSink = agent.ctx.on(
            'agent/pre-step',
            createWorkerNoticeSink(store, config.telegramParentSessionId ?? 'session-telegram', ctx.logger),
          )
        }
        return () => {
          disposeTools()
          disposePersona()
          disposeSection()
          disposeObserver()
          disposeNoticeSink()
        }
      }, 'dsh-assistant.root()'))
      if (config.mode === 'telegram') {
        disposers.push(worker.ensureInstalled(agent))
      }
      let done = false
      runtimes.set(agent, () => {
        if (done) return
        done = true
        for (const dispose of disposers) dispose()
      })
    }

    // Existing roots first; then every future root (guard against duplicates).
    for (const agent of ctx.agents.roots()) installForRoot(agent)
    const stopCreated = ctx.on('agent/created', ({ agent }) => {
      if (stopping || runtimes.has(agent) || !ctx.agents.roots().includes(agent)) return
      installForRoot(agent)
    })

    if (config.mode === 'telegram') {
      const token = await resolveSecret(ctx, config.token, 'TELEGRAM_BOT_TOKEN')
      if (token === undefined || token === '') {
        throw new Error('dsh-assistant: TELEGRAM_BOT_TOKEN is required (config token or credential reference)')
      }
      const chatIdRaw = await resolveSecret(ctx, config.chatId, 'TELEGRAM_ALLOWED_CHAT_ID')
      const chatId = chatIdRaw !== undefined && chatIdRaw !== '' ? Number(chatIdRaw) : Number.NaN
      if (!Number.isFinite(chatId)) {
        throw new Error(`dsh-assistant: invalid allowed chat id "${chatIdRaw ?? ''}" (config chatId or TELEGRAM_ALLOWED_CHAT_ID credential)`)
      }
      const http = createTelegramHttp(config.apiBaseUrl ?? 'https://api.telegram.org', token)
      try {
        const me = await http.getMe()
        ctx.logger.info(`dsh-assistant: telegram connected as @${me.username ?? String(me.id)}`)
      } catch (error) {
        ctx.logger.warn(`dsh-assistant: getMe transient failure: ${error instanceof Error ? error.message : String(error)}`)
      }
      const lifetime = new AbortController()
      telegramLifetime = lifetime
      const pump = new OutboxPump({
        store,
        http,
        chatId,
        maxChars: 4096,
        signal: lifetime.signal,
        logger: ctx.logger,
      })
      reminders = new ReminderRuntime({
        store,
        pump,
        pollIntervalMs: config.pollIntervalMs ?? 5_000,
        lateReminderAfterMs: config.lateReminderAfterMs ?? 2 * 60 * 60 * 1000,
        signal: lifetime.signal,
        logger: ctx.logger,
      })
      // A previous process may have claimed an outbox row and died before
      // recording its delivery result. Resolve that one-time uncertainty
      // before normalize/recovery and before the existing reminder tick can
      // claim a fresh monitor round; do not start another pump here.
      store.markStaleClaimed()
      // A restart must not auto-rerun a leftover agent child (§11.5).
      store.normalizeAgentOnStartup()
      parkUnboundLegacyMonitors(store, ctx.logger)
      if (cronControlPort === undefined) {
        ctx.logger.warn('dsh-assistant: Cron control unavailable; explicit cronControlSocketPath is required')
      } else {
        const startup = await startAssistantCronControl({
          controlPort: cronControlPort,
          reconcileStartup: () => reconcileCronBindings({
            store,
            controlPort: cronControlPort!,
            maxBindings: 100,
            budgetMs: 30_000,
          }),
        })
        if (startup.state === 'unavailable') {
          ctx.logger.warn(`dsh-assistant: Cron startup unavailable${startup.reason === undefined ? '' : `: ${boundedCronReason(startup.reason)}`}`)
        } else if (startup.reconciliationState === 'budget_exhausted') {
          ctx.logger.warn(`dsh-assistant: Cron startup reconciliation budget exhausted after ${startup.processed} bindings${startup.reason === undefined ? '' : `: ${boundedCronReason(startup.reason)}`}`)
        }
      }
      reminders.start()
    }

    return async () => {
      stopping = true
      worker.setStopping(true)
      telegramLifetime?.abort()
      disposeCronRunFinished()
      stopCreated()
      // Safely park an active agent commitment BEFORE the child teardown's
      // late ends arrive, so they are never misreported as failures.
      if (config.mode === 'telegram') store.normalizeAgentOnStartup()
      webObserver?.dispose()
      await reminders?.dispose()
      const cleanups = [...runtimes.values()]
      runtimes.clear()
      await Promise.allSettled(cleanups.map(cleanup => Promise.resolve(cleanup())))
      store.close()
    }
  }, 'dsh-assistant()')
}
