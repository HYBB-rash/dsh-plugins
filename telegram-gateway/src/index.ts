/**
 * Telegram gateway: chat with a fixed DSH session through a Telegram bot.
 *
 * The gateway applies these transport and lifecycle rules:
 * - durable-before-ack: the next update offset is persisted before a batch
 *   is processed, so a crash between fetch and process never redelivers an
 *   acknowledged batch;
 * - monotonic offset persistence through an atomic rename;
 * - error classification: Bot API 429/5xx retry locally honoring
 *   `retry_after`, 401/404 are fatal, 409 signals a duplicate poller;
 * - outbound text chunking at 4096 chars with continuation messages;
 * - `getMe` startup validation so an invalid token fails fast;
 * - recoverable transport failures (network/timeout) back off and keep
 *   polling; the first private message authorizes the bot when no chat id is
 *   configured (first-run adoption).
 *
 * Per-turn Telegram feedback (`TurnFeedback`) follows the message-level
 * streaming contract: 👀 on the trigger message plus typing refresh while the
 * agent works, every complete `assistant/message` with text AND a tool-call
 * delivered as an immediate, immutable interim message, and the final text
 * from `summarizeTurn()` delivered as a new immutable message with 👍/👎.
 * `assistant/chunk` deltas are never shown and no message is ever edited.
 * Reaction, typing, and interim sends are best-effort and degrade without
 * blocking the agent or the authoritative final delivery.
 *
 * The gateway owns one durable session (`session-telegram`), resumed from
 * persistence when present, and drives it with the user's Telegram messages.
 *
 * @module @deepseek-ai/dsh-telegram-gateway
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  installModelSelection,
  type Agent,
  type AgentHandle,
  type AgentSetup,
  type ModelSelectionRef,
} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-cmdline'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { ignoreFeedbackFailure, TurnFeedback } from './turn-feedback.ts'
import { dispatchInbound } from './inbound-dispatch.ts'
import type {
  TelegramInboundEnvelope,
  TelegramInboundResult,
} from './inbound-contract.ts'
import {
  buildIncomingUserText,
  chunkText,
  createTelegramHttp,
  TelegramApiError,
  type TelegramHttp,
  type TelegramUpdate,
} from './telegram-contract.ts'
import { loadTelegramExtensions, type TelegramExtensionConfig } from './extensions.ts'

// Shared transport contract re-exported so existing consumers (dsh-assistant,
// tests) keep importing these names from the package entry.
export {
  buildIncomingUserText,
  chunkText,
  createTelegramHttp,
  formatMarkdownV2,
  TelegramApiError,
  type ReplyToMessage,
  type TelegramMessageQuote,
  type SendMessageOptions,
  type TelegramHttp,
  type TelegramMessageRef,
  type TelegramUpdate,
  type TelegramApiErrorKind,
} from './telegram-contract.ts'

export {
  isTelegramInboundEnvelope,
  type TelegramInboundChat,
  type TelegramInboundEnvelope,
  type TelegramInboundFailed,
  type TelegramInboundHandled,
  type TelegramInboundMessage,
  type TelegramInboundReference,
  type TelegramInboundResult,
  type TelegramInboundRootDelivered,
  type TelegramInboundReadyEvent,
  type TelegramInboundWaterfallEvent,
} from './inbound-contract.ts'

export * from './extensions.ts'

/** Stable Cordis plugin name. */
export const name = 'telegram-gateway'

/** Core services required before the bot loop can start. */
export const inject = [
  'agentDefaultModel',
  'agents',
  'sessions',
  'credentials',
  'loader',
  'llm',
]

/** Gateway configuration. */
export interface Config {
  /** Telegram bot token (BotFather). Falls back to the `TELEGRAM_BOT_TOKEN` credential reference. */
  token?: string
  /** Numeric Telegram chat id allowed to drive the session. Falls back to the `TELEGRAM_ALLOWED_CHAT_ID` credential reference. */
  allowedChatId?: string
  /** Stable session id used for the fixed conversation. Defaults to `session-telegram`. */
  sessionId: string
  /** Optional Agent preset for hosts that move model-facing tools behind presets. */
  agentPreset?: string
  /** Working directory for the agent's bash/filesystem tools. Defaults to the process cwd. */
  cwd?: string
  /** Telegram API base URL. Defaults to https://api.telegram.org. */
  apiBaseUrl: string
  /** Long-poll timeout seconds per getUpdates call. Defaults to 30. */
  pollTimeoutSeconds: number
  /** Directory for the persisted update offset. Defaults to `$DSH_HOME/storages/telegram`. */
  offsetDir: string
  /** Text chunk limit for outbound messages (Telegram hard cap 4096). Defaults to 4096. */
  maxMessageChars: number
  /** Require a ready inbound interceptor before dispatching messages. Defaults to false. */
  requireInboundInterceptor: boolean
  /** Trusted business adapters loaded at the Telegram edge. */
  extensions?: TelegramExtensionConfig[]
}

export const Config: z<Config> = z.object({
  token: z.string(),
  allowedChatId: z.string(),
  sessionId: z.string().default('session-telegram'),
  agentPreset: z.string(),
  cwd: z.string(),
  apiBaseUrl: z.string().default('https://api.telegram.org'),
  pollTimeoutSeconds: z.number().step(1).min(1).max(50).default(30),
  offsetDir: z.string().default(''),
  maxMessageChars: z.number().step(1).min(1).max(4096).default(4096),
  requireInboundInterceptor: z.boolean().default(false),
  extensions: z.array(z.object({
    modulePath: z.string(),
    configJson: z.string(),
  })).default([]),
})

/**
 * Aggregate the last assistant text and any error from one owned interval.
 * @param events - Session events that may include earlier turns.
 * @param firstSeq - First sequence number owned by the current Telegram turn.
 * @returns final visible text and the terminal error, when present.
 */
export function summarizeTurn(events: readonly SessionEvent[], firstSeq: number): TurnOutcome {
  let started = false
  let text = ''
  let error: string | undefined
  for (const event of events) {
    if (event.seq < firstSeq) continue
    if (event.type === 'turn/start') {
      started = true
      continue
    }
    if (!started) continue
    if (event.type === 'assistant/message') {
      const joined = event.data.message.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')
      if (joined !== '') text = joined
    }
    if (event.type === 'turn/end' && event.data.reason.kind === 'error') {
      error = `${event.data.reason.error.code}: ${event.data.reason.error.message}`
    }
  }
  return { text, error }
}

/** Outcome of one driven turn. */
export interface TurnOutcome {
  text: string
  error: string | undefined
}

/** Resolve a config value or its credential reference (env-inherited first). */
async function resolveSecret(ctx: Context, configured: string | undefined, ref: string): Promise<string | undefined> {
  if (configured !== undefined && configured !== '') return configured
  const credentials = ctx.get('credentials')
  if (credentials === undefined) return undefined
  const hit = await credentials.resolve(credentialRef(ref))
  return hit?.value
}

/**
 * Monotonic update-offset persistence (durable-before-ack). The file holds the
 * inclusive offset for the next `getUpdates` call and is replaced atomically.
 */
export interface OffsetStore {
  read(): number
  write(nextOffset: number): void
}

/**
 * Open one atomic monotonic Telegram update-offset store.
 * @param file - absolute or process-relative offset file path.
 * @returns in-process view backed by atomic file replacement.
 */
export function createOffsetStore(file: string): OffsetStore {
  let current = 0
  try {
    const raw = readFileSync(file, 'utf8').trim()
    const parsed = Number(raw)
    if (Number.isSafeInteger(parsed) && parsed >= 0) current = parsed
  } catch {
    // Absent or unreadable offset file is the fresh-start state.
  }
  return {
    read: () => current,
    write(nextOffset) {
      if (nextOffset <= current) return
      current = nextOffset
      mkdirSync(dirname(file), { recursive: true })
      const tmp = `${file}.tmp`
      writeFileSync(tmp, String(nextOffset), 'utf8')
      renameSync(tmp, file)
    },
  }
}

/** Result of one driven turn: outcome plus the turn's feedback handle. */
interface DrivenTurn {
  /** Summarized outcome when the turn completed; undefined when it was interrupted. */
  outcome: TurnOutcome | undefined
  /** Set when the turn failed to execute (e.g. session flush); undefined on abort. */
  failure: unknown
  /** Per-turn Telegram presentation handle. */
  feedback: TurnFeedback
}

/**
 * Drive one user message through the owned turn. The caller creates and starts
 * the presentation handle before dispatching the inbound envelope; this keeps
 * root and intercepted paths on one lifecycle. `TurnFeedback` enqueues each
 * complete `assistant/message` (text + tool-call) as an immutable interim
 * message while the agent works; the authority (`summarizeTurn`) outcome and
 * the feedback handle are returned for the final write. Returns undefined when
 * the gateway was aborted before the turn started.
 */
async function driveTurn(
  ctx: Context,
  agent: Agent,
  text: string,
  sessions: { flush(session: unknown): Promise<void> },
  signal: AbortSignal,
  feedback: TurnFeedback,
): Promise<DrivenTurn | undefined> {
  if (!await waitForIdle(agent, signal)) {
    // The presentation handle is created before dispatch, so an abort before
    // the listener seam is installed still needs to close this one lifecycle.
    feedback.close()
    return undefined
  }
  // 精确认领本轮：同一 Session、firstSeq 之后、本轮 turn 边界内的事件才进入反馈。
  const firstSeq = agent.session.seq
  const disposeListener = ctx.on('session/event', (session, event) => {
    if (session === agent.session && event.seq >= firstSeq) feedback.observe(event)
  })
  let completed = false
  try {
    agent.followup(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }))
    if (!await waitForIdle(agent, signal)) return { outcome: undefined, failure: undefined, feedback }
    try {
      await sessions.flush(agent.session)
    } catch (error) {
      if (signal.aborted) return { outcome: undefined, failure: undefined, feedback }
      return { outcome: undefined, failure: error, feedback }
    }
    if (signal.aborted) return { outcome: undefined, failure: undefined, feedback }
    completed = true
    return { outcome: summarizeTurn(agent.session.snapshotEvents(), firstSeq), failure: undefined, feedback }
  } finally {
    disposeListener()
    // 未完成的本轮不再有 finish()/fail()：停掉 timer，👀 留给 dispose 路径清理。
    if (!completed) feedback.close()
  }
}

/** Wait for an Agent to become idle without holding plugin disposal open. */
async function waitForIdle(agent: Agent, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false
  let onAbort!: () => void
  const aborted = new Promise<void>((resolve) => {
    onAbort = resolve
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    await Promise.race([agent.whenIdle(), aborted])
    return !signal.aborted
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/** Deliver text to Telegram, chunking at the 4096-char cap. */
async function deliverText(
  http: TelegramHttp,
  chatId: number,
  text: string,
  maxChars: number,
  signal?: AbortSignal,
): Promise<void> {
  for (const chunk of chunkText(text, maxChars)) {
    await http.sendMessage(chatId, chunk, undefined, signal)
  }
}

/** Send the best-effort startup notification while preserving fatal failures. */
async function sendStartupNotification(
  ctx: Context,
  http: TelegramHttp,
  chatId: number,
  signal: AbortSignal,
): Promise<void> {
  try {
    await http.sendMessage(chatId, '✅ 已连接。你可以让我记住、跟进，或执行一件当前事情。', undefined, signal)
  } catch (error) {
    signal.throwIfAborted()
    if (error instanceof TelegramApiError && error.kind === 'fatal') throw error
    ctx.logger.warn('telegram-gateway: startup notification failed')
  }
}

/** Build the neutral transport envelope consumed by inbound listeners. */
function buildInboundEnvelope(
  message: NonNullable<TelegramUpdate['message']>,
  currentText: string,
  signal: AbortSignal,
): TelegramInboundEnvelope {
  const reply = message.reply_to_message
  const selectedText = nonEmptyText(message.quote?.text)
  const messageText = nonEmptyText(reply?.text) ?? nonEmptyText(reply?.caption)
  const reference = {
    ...(reply === undefined ? {} : { messageId: reply.message_id }),
    ...(selectedText === undefined ? {} : { selectedText }),
    ...(messageText === undefined ? {} : { messageText }),
  }
  return Object.freeze({
    chat: Object.freeze({ id: message.chat.id, type: message.chat.type }),
    message: Object.freeze({ id: message.message_id }),
    currentText,
    ...(Object.keys(reference).length === 0 ? {} : { reference: Object.freeze(reference) }),
    signal,
  })
}

function nonEmptyText(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value
}

/**
 * Keep the optional mode compatible with small legacy test hosts that expose
 * only the gateway services. Real Cordis contexts provide both methods; the
 * defaults still pass through the same S0 dispatcher and required mode stays
 * fail-closed because its default readiness result is not true.
 */
function inboundDispatchContext(ctx: Context): Parameters<typeof dispatchInbound>[0] {
  const host = ctx as unknown as {
    bail?: (event: string, envelope: TelegramInboundEnvelope) => unknown
    waterfall?: (
      event: string,
      envelope: TelegramInboundEnvelope,
      next: () => TelegramInboundResult | Promise<TelegramInboundResult>,
    ) => TelegramInboundResult | Promise<TelegramInboundResult>
  }
  return {
    bail: (event: 'telegram/inbound/ready', envelope: TelegramInboundEnvelope) => typeof host.bail === 'function'
      ? host.bail.call(ctx, event, envelope)
      : undefined,
    waterfall: (
      event: 'telegram/inbound',
      envelope: TelegramInboundEnvelope,
      next: () => TelegramInboundResult | Promise<TelegramInboundResult>,
    ) => typeof host.waterfall === 'function'
      ? host.waterfall.call(ctx, event, envelope, next)
      : next(),
  } as unknown as Parameters<typeof dispatchInbound>[0]
}

/** Wait for a retry delay or plugin disposal. */
function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, ms)
    function onAbort(): void {
      clearTimeout(timer)
      resolve(false)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Run the gateway until `signal` aborts, then dispose any Agent created by this
 * invocation before resolving.
 * @param ctx - plugin context carrying the Agent and persistence services.
 * @param config - validated gateway configuration.
 * @param http - authenticated Telegram transport.
 * @param signal - plugin-lifetime cancellation.
 * @param ready - called after startup validation and Agent acquisition.
 */
export async function runGateway(
  ctx: Context,
  config: Config,
  http: TelegramHttp,
  signal: AbortSignal,
  ready: () => void = () => {},
): Promise<void> {
  const agents = ctx.get('agents')
  const defaultModel = ctx.get('agentDefaultModel')
  const sessions = ctx.get('sessions')
  const persistence = ctx.get('sessionPersistence')
  if (agents === undefined || defaultModel === undefined || sessions === undefined || persistence === undefined) {
    throw new Error('telegram-gateway: core services unavailable')
  }
  signal.throwIfAborted()
  const configuredChat = await resolveSecret(ctx, config.allowedChatId, 'TELEGRAM_ALLOWED_CHAT_ID')
  // First-run authorization: when no chat id is configured, the first private
  // message this bot receives becomes the allowed chat.
  let chatId = configuredChat !== undefined && configuredChat !== '' ? Number(configuredChat) : Number.NaN
  if (configuredChat !== undefined && configuredChat !== '' && !Number.isFinite(chatId)) {
    throw new Error(`telegram-gateway: invalid allowed chat id "${configuredChat}"`)
  }
  const sessionId = SessionId(config.sessionId)
  const cwd = config.cwd ?? process.cwd()
  const selection = defaultModel.currentSelection()

  // Validate the token at startup (fails fast on 401).
  try {
    const me = await http.getMe(signal)
    ctx.logger.info(`telegram-gateway: connected as @${me.username ?? String(me.id)}`)
  } catch (error) {
    signal.throwIfAborted()
    if (error instanceof TelegramApiError && error.kind === 'fatal') throw error
    ctx.logger.warn(`telegram-gateway: getMe transient failure: ${error instanceof Error ? error.message : String(error)}`)
  }

  // Reuse a live Agent. Otherwise resume only a materialized session; failures
  // other than absence remain visible instead of falling through to create().
  const setup: AgentSetup = async (agentCtx) => {
    const selected: ModelSelectionRef = { current: selection, assembled: undefined }
    installModelSelection(agentCtx, selected)
    if (config.agentPreset !== undefined) {
      const presets = ctx.get('agentPresets')
      if (presets === undefined) {
        throw new Error(`telegram-gateway: Agent preset "${config.agentPreset}" requested but agent-presets is unavailable`)
      }
      await presets.mount(agentCtx, config.agentPreset)
    }
  }
  let handle: AgentHandle | undefined
  const live = agents.get(sessionId)
  if (live === undefined) {
    const persisted = (await persistence.list({ signal })).some(snapshot => snapshot.header.id === sessionId)
    handle = persisted
      ? await agents.resume({ resumeSessionId: sessionId, agentOptions: { provider: selection.provider, model: selection.model }, setup })
      : await agents.create({
          sessionId,
          meta: { cwd, ...(config.agentPreset === undefined ? {} : { agentPreset: config.agentPreset }) },
          agentOptions: { provider: selection.provider, model: selection.model },
          setup,
        })
  }
  const agent = live ?? handle!.agent

  const offsetDir = config.offsetDir !== ''
    ? config.offsetDir
    : join(resolveDshHome(), 'storages', 'telegram')
  const offsetStore = createOffsetStore(join(offsetDir, 'offset.txt'))
  let offset = offsetStore.read()

  // 未收尾的 👀（正常 dispose 时用独立短超时信号尽力清理）。
  let armedReaction: { chatId: number; messageId: number } | undefined

  try {
    if (Number.isFinite(chatId)) {
      await sendStartupNotification(ctx, http, chatId, signal)
    }
    ready()

    while (!signal.aborted) {
      let updates: Awaited<ReturnType<TelegramHttp['getUpdates']>>
      try {
        updates = await http.getUpdates(offset, config.pollTimeoutSeconds, signal)
      } catch (error) {
        if (signal.aborted) return
        if (error instanceof TelegramApiError) {
          if (error.kind === 'fatal') throw error
          if (error.kind === 'conflict') {
            ctx.logger.error(`telegram-gateway: ${error.message}`)
            if (!await sleep(30_000, signal)) return
            continue
          }
          const delayMs = Math.min((error.retryAfterSeconds ?? 5) * 1000, 60_000)
          if (!await sleep(delayMs, signal)) return
          continue
        }
        if (!await sleep(5_000, signal)) return
        continue
      }
      // Telegram's offset is inclusive. Persist the next offset before
      // processing so a restart cannot redeliver an acknowledged batch.
      const nextOffset = updates.reduce(
        (highest, update) => Math.max(highest, update.update_id + 1),
        offset,
      )
      if (nextOffset > offset) {
        offsetStore.write(nextOffset)
        offset = nextOffset
      }
      for (const update of updates) {
        const message = update.message
        if (message === undefined) continue
        if (!Number.isFinite(chatId)) {
          if (message.chat.type !== 'private') continue
          chatId = message.chat.id
          await sendStartupNotification(ctx, http, chatId, signal)
        }
        if (message.chat.id !== chatId) continue
        const text = message.text
        if (text === undefined || text.trim() === '') continue
        // 回复引用上下文（§9）：引用正文只作为定位参考，当前用户消息才是指令。
        const effectiveText = buildIncomingUserText(text, message.reply_to_message, message.quote)
        const feedback = new TurnFeedback({
          http,
          chatId,
          triggerMessageId: message.message_id,
          signal,
          logger: ctx.logger,
          maxMessageChars: config.maxMessageChars,
        })
        let driven: DrivenTurn | undefined
        try {
          await feedback.start()
          if (feedback.reactionArmed) {
            armedReaction = { chatId, messageId: message.message_id }
          }
          const envelope = buildInboundEnvelope(message, text, signal)
          const defaultRoot = async (): Promise<TelegramInboundResult> => {
            driven = await driveTurn(ctx, agent, effectiveText, sessions as never, signal, feedback)
            return { kind: 'root-delivered' }
          }
          const result = await dispatchInbound(
            inboundDispatchContext(ctx),
            envelope,
            config.requireInboundInterceptor,
            defaultRoot,
          )

          if (result.kind === 'handled') {
            await feedback.finish(result.finalText)
            armedReaction = undefined
            continue
          }
          if (result.kind === 'failed') {
            await feedback.fail(result.visibleError)
            armedReaction = undefined
            continue
          }
          if (driven === undefined) {
            if (signal.aborted) return
            await feedback.fail('Inbound root did not run')
            armedReaction = undefined
            continue
          }
          if (driven.outcome === undefined) {
            if (driven.failure !== undefined) {
              // 执行失败：沿用现有错误文案，收尾为 👎。
              await driven.feedback.fail(
                `⚠️ 执行失败：${driven.failure instanceof Error ? driven.failure.message : String(driven.failure)}`,
              )
              armedReaction = undefined
              continue
            }
            // 插件中止：交给 finally 清理未完成的 👀。
            return
          }
          if (driven.outcome.error !== undefined) {
            await driven.feedback.fail(`⚠️ 任务出错：${driven.outcome.error}`)
          } else if (driven.outcome.text.trim() === '') {
            await driven.feedback.finish('（完成，但没有任何文本输出）')
          } else {
            await driven.feedback.finish(driven.outcome.text)
          }
          armedReaction = undefined
        } catch (error) {
          if (feedback.reactionArmed) {
            armedReaction = { chatId, messageId: message.message_id }
          }
          feedback.close()
          if (signal.aborted) return
          if (driven !== undefined) {
            // 最终交付失败：不标 👍，尽力收尾为 👎。
            await driven.feedback.markFailed()
            armedReaction = undefined
          }
          await deliverText(http, chatId, `⚠️ 执行失败：${error instanceof Error ? error.message : String(error)}`, config.maxMessageChars, signal)
        }
      }
    }
  } finally {
    // 正常 dispose：主 signal 已 abort，用独立短超时信号尽力清理未完成的 👀。
    if (armedReaction !== undefined) {
      const pending = armedReaction
      await ignoreFeedbackFailure(ctx.logger, 'clear reaction', () => {
        return http.setReaction(pending.chatId, pending.messageId, undefined, AbortSignal.timeout(3_000))
      })
    }
    if (handle !== undefined) {
      await handle.dispose()
    }
  }
}

/** Non-serializable dependency overrides for deterministic lifecycle tests. */
export interface TelegramGatewayInternals {
  /** Build the Telegram transport after the credential-backed token resolves. */
  createHttp?: typeof createTelegramHttp
}

/**
 * Mount one lifecycle-owned gateway loop. Startup failures reject plugin load;
 * failures after readiness request bounded application shutdown.
 * @param ctx - plugin context carrying core services.
 * @param config - validated gateway configuration.
 * @param internals - deterministic transport override for tests.
 */
export async function apply(
  ctx: Context,
  config: Config,
  internals: TelegramGatewayInternals = {},
): Promise<void> {
  await ctx.effect(async () => {
    const token = await resolveSecret(ctx, config.token, 'TELEGRAM_BOT_TOKEN')
    if (token === undefined || token === '') {
      throw new Error('telegram-gateway: TELEGRAM_BOT_TOKEN is required (config token or credential reference)')
    }
    const http = (internals.createHttp ?? createTelegramHttp)(config.apiBaseUrl, token)
    const extensionDisposers = await loadTelegramExtensions(ctx, config.extensions ?? [])
    const lifetime = new AbortController()
    const ready = Promise.withResolvers<void>()
    let readyObserved = false
    const running = runGateway(ctx, config, http, lifetime.signal, () => {
      readyObserved = true
      ready.resolve()
    }).catch((error: unknown) => {
      if (!readyObserved) {
        ready.reject(error)
        return
      }
      if (lifetime.signal.aborted) return
      ctx.logger.error(`telegram-gateway: ${error instanceof Error ? error.message : String(error)}`)
      ctx.get('appExit')?.(1)
    })

    try {
      await ready.promise
    } catch (error) {
      lifetime.abort(error)
      await running
      await Promise.allSettled(extensionDisposers.reverse().map(dispose => Promise.resolve(dispose())))
      throw error
    }

    return async () => {
      lifetime.abort(new Error('telegram-gateway disposed'))
      await running
      await Promise.allSettled(extensionDisposers.reverse().map(dispose => Promise.resolve(dispose())))
    }
  }, 'telegram-gateway.run()')
}
