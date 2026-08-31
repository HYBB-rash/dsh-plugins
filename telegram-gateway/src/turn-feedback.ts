/**
 * Single-turn Telegram feedback: 👀 reaction, typing refresh, and serialized
 * delivery of complete, immutable semantic messages.
 *
 * Delivery contract (Hermes-语义消息投递-落地指南):
 * - `assistant/chunk` (including `text-delta`) never becomes visible text;
 * - only a complete `assistant/message` with non-empty text AND a tool-call
 *   block is enqueued as one interim message — reasoning never leaks and
 *   text-only messages are left for `summarizeTurn()`/`finish()`;
 * - interim messages are sent strictly in session-event order through a single
 *   promise queue, each as a new immutable message (never an edit);
 * - exact dedup on the normalized full visible text (CRLF/CR → LF, trimmed
 *   ends only); queued vs delivered texts are tracked separately, so a failed
 *   interim is not treated as delivered and the identical final is resent;
 * - typing refreshes every 4 s until finish/fail/close; reaction, typing, and
 *   interim sends are best-effort, while the final/error delivery is the
 *   authoritative one and throws so the caller's error boundary stays honest.
 */

import { chunkText, type SendMessageOptions, type TelegramHttp } from './telegram-contract.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { TelegramInboundDeliveryReceipt } from './inbound-contract.ts'

export type TurnFeedbackReceipt = TelegramInboundDeliveryReceipt

/** Narrow logger surface used by feedback calls. */
export interface TurnFeedbackLogger {
  debug(message: string): void
  warn(message: string): void
}

/** Best-effort boundary: a decorative Telegram call failure only degrades. */
export function ignoreFeedbackFailure(
  logger: TurnFeedbackLogger,
  label: string,
  action: () => Promise<void>,
): Promise<void> {
  const degrade = (error: unknown): void => {
    logger.debug(`telegram-gateway: ${label} unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    // action() 可能同步抛错（例如测试里的缺失方法）；catch 必须同时覆盖同步路径。
    return action().catch(degrade)
  } catch (error) {
    degrade(error)
    return Promise.resolve()
  }
}

export interface TurnFeedbackOptions {
  /** Authenticated Telegram transport. */
  http: TelegramHttp
  /** Chat that owns the trigger message and the delivered messages. */
  chatId: number
  /** The user's message this turn answers; first visible message and reactions target it. */
  triggerMessageId: number
  /** Plugin-lifetime cancellation. */
  signal: AbortSignal
  /** Logger for degrade warnings and debug traces. */
  logger: TurnFeedbackLogger
  /** Telegram single-message cap; also the interim skip cap. Defaults to 4096. */
  maxMessageChars?: number
  /** Typing refresh interval. Defaults to 4 s. */
  typingIntervalMs?: number
}

/**
 * Normalize the visible full text for exact dedup. The ONLY allowed changes:
 * CRLF/CR are unified to LF, and leading/trailing whitespace of the whole text
 * is trimmed. Internal whitespace, blank lines, and punctuation are preserved;
 * similarity, prefix/suffix diffs, or sentence splitting are never used.
 */
export function normalizeVisibleText(text: string): string {
  return text.replace(/\r\n?/g, '\n').trim()
}

/** One in-flight turn's Telegram presentation state. */
export class TurnFeedback {
  private readonly http: TelegramHttp
  private readonly chatId: number
  private readonly triggerMessageId: number
  private readonly signal: AbortSignal
  private readonly logger: TurnFeedbackLogger
  private readonly maxMessageChars: number
  private readonly typingIntervalMs: number

  private typingTimer: ReturnType<typeof setInterval> | undefined
  private closed = false
  private inTurn = false

  /** Serialized delivery queue: complete messages send strictly in order. */
  private deliveryTail: Promise<void> = Promise.resolve()
  /** Normalized full texts queued but not yet delivered. */
  private readonly reservedVisibleTexts = new Set<string>()
  /** Normalized full texts successfully delivered this turn. */
  private readonly deliveredVisibleTexts = new Set<string>()
  /** Whether any visible message has been delivered (drives the trigger reply). */
  private hasDeliveredVisibleMessage = false

  /** Whether the 👀 reaction was actually applied (drives dispose cleanup). */
  reactionArmed = false

  constructor(options: TurnFeedbackOptions) {
    this.http = options.http
    this.chatId = options.chatId
    this.triggerMessageId = options.triggerMessageId
    this.signal = options.signal
    this.logger = options.logger
    this.maxMessageChars = options.maxMessageChars ?? 4096
    this.typingIntervalMs = options.typingIntervalMs ?? 4000
  }

  /** Set 👀 and start the 4 s typing refresh; both are best-effort. */
  async start(): Promise<void> {
    try {
      await this.http.setReaction(this.chatId, this.triggerMessageId, '👀', this.signal)
      this.reactionArmed = true
    } catch (error) {
      this.logger.debug(`telegram-gateway: reaction 👀 unavailable: ${this.describe(error)}`)
    }
    await ignoreFeedbackFailure(this.logger, 'typing', () => this.http.sendTyping(this.chatId, this.signal))
    this.typingTimer = setInterval(() => {
      // typing 持续刷新直到 turn 结束/失败/abort；发送中途消息后不停止。
      if (this.closed) {
        this.stopTyping()
        return
      }
      void ignoreFeedbackFailure(this.logger, 'typing', () => this.http.sendTyping(this.chatId, this.signal))
    }, this.typingIntervalMs)
  }

  /**
   * Observe one session event of the driven turn. Synchronous: only enqueues
   * complete interim messages onto the serialized delivery queue.
   */
  observe(event: SessionEvent): void {
    if (this.closed) return
    switch (event.type) {
      case 'turn/start':
        this.inTurn = true
        return
      case 'turn/end':
        this.inTurn = false
        return
      case 'assistant/message': {
        if (!this.inTurn) return
        const content = event.data.message.content
        const joined = content
          .filter(block => block.type === 'text')
          .map(block => block.text)
          .join('')
        const normalized = normalizeVisibleText(joined)
        if (normalized === '') return
        // reasoning + tool-call、纯工具、空 text 都保持安静；text-only 留给 finish()。
        const hasToolCall = content.some(block => block.type === 'tool-call')
        if (!hasToolCall) return
        // 超长中途不提前拆成多条进度：跳过并继续 typing，等待最终交付。
        if (normalized.length > this.maxMessageChars) return
        this.enqueueInterim(normalized)
        return
      }
      default:
        // assistant/chunk、tool/call、tool/result、usage、step 边界都不产生正文。
        return
    }
  }

  /** Close new frames and deliver the authoritative final text, then 👍. */
  async finish(finalText: string): Promise<void> {
    await this.finishWithReceipt(finalText)
  }

  /** Close new frames, deliver the final text, and return its transport receipt. */
  async finishWithReceipt(finalText: string): Promise<TurnFeedbackReceipt> {
    this.close()
    await this.deliveryTail
    const normalized = normalizeVisibleText(finalText)
    const messageIds = await this.writeFinal(normalized)
    await ignoreFeedbackFailure(this.logger, 'success reaction', () => {
      return this.http.setReaction(this.chatId, this.triggerMessageId, '👍', this.signal)
    })
    return Object.freeze({
      chatId: this.chatId,
      triggerMessageId: this.triggerMessageId,
      visibleText: normalized,
      messageIds: Object.freeze([...messageIds]),
    })
  }

  /** Close new frames, deliver the visible error text, then 👎. */
  async fail(visibleError: string): Promise<void> {
    this.close()
    await this.deliveryTail
    await this.writeFinal(visibleError)
    await ignoreFeedbackFailure(this.logger, 'failure reaction', () => {
      return this.http.setReaction(this.chatId, this.triggerMessageId, '👎', this.signal)
    })
  }

  /** Best-effort 👎 after a delivery failure (never marks 👍). */
  async markFailed(): Promise<void> {
    await ignoreFeedbackFailure(this.logger, 'failure reaction', () => {
      return this.http.setReaction(this.chatId, this.triggerMessageId, '👎', this.signal)
    })
  }

  /**
   * Stop all timers and block new events/messages. Leaves the current reaction
   * untouched so the plugin disposal path can clear 👀 with its own signal.
   */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.inTurn = false
    this.stopTyping()
  }

  private stopTyping(): void {
    if (this.typingTimer !== undefined) {
      clearInterval(this.typingTimer)
      this.typingTimer = undefined
    }
  }

  /**
   * Enqueue one interim semantic message. Reserved/delivered tracking keeps
   * queued texts separate from delivered ones; a failed send is removed from
   * reserved so the final can deliver the same text again.
   */
  private enqueueInterim(normalized: string): void {
    if (this.reservedVisibleTexts.has(normalized) || this.deliveredVisibleTexts.has(normalized)) return
    this.reservedVisibleTexts.add(normalized)
    const run = this.deliveryTail.then(async () => {
      try {
        await this.sendSemanticMessage(normalized)
        this.reservedVisibleTexts.delete(normalized)
        this.deliveredVisibleTexts.add(normalized)
      } catch (error) {
        // 中途发送失败：best-effort，不阻塞 Agent；相同最终文本仍会重试。
        this.reservedVisibleTexts.delete(normalized)
        this.logger.debug(`telegram-gateway: interim message unavailable: ${this.describe(error)}`)
      }
    })
    this.deliveryTail = run
  }

  /**
   * Authoritative final/error delivery. A final identical to an already
   * delivered interim full text is not resent (exact dedup on the whole text);
   * a failed interim does not count as delivered, so the same text is sent.
   */
  private async writeFinal(finalText: string): Promise<readonly number[]> {
    const normalized = normalizeVisibleText(finalText)
    if (normalized === '') return []
    if (this.deliveredVisibleTexts.has(normalized)) return []
    return this.sendSemanticMessage(normalized)
  }

  /**
   * Send one immutable semantic message (possibly chunked for the final).
   * The first successfully delivered visible message replies to the user's
   * trigger message; later messages are sent plain. Multi-chunk finals keep
   * replying to their previous chunk so ordering is explicit.
   */
  private async sendSemanticMessage(text: string): Promise<readonly number[]> {
    const replyTo = this.hasDeliveredVisibleMessage ? undefined : this.triggerMessageId
    const chunks = chunkText(text, this.maxMessageChars)
    let lastMessageId: number | undefined
    const messageIds: number[] = []
    for (const [index, chunk] of chunks.entries()) {
      const options: SendMessageOptions | undefined = index === 0
        ? (replyTo !== undefined ? { replyToMessageId: replyTo } : undefined)
        : (lastMessageId !== undefined ? { replyToMessageId: lastMessageId } : undefined)
      const ref = await this.http.sendMessage(this.chatId, chunk, options, this.signal)
      lastMessageId = ref.messageId
      messageIds.push(ref.messageId)
    }
    this.hasDeliveredVisibleMessage = true
    return messageIds
  }

  private describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }
}
