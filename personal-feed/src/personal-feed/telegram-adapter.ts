import type { Context } from '@deepseek-ai/cordis'
import type {
  TelegramInboundEnvelope,
  TelegramInboundResult,
} from '@deepseek-ai/dsh-telegram-gateway'
import type { PersonalFeedV2RequestCoordinator } from '../v2/request-coordinator.ts'

export type PersonalFeedTelegramAdapterContext = Pick<Context, 'on'>

export interface PersonalFeedTelegramAdapterOptions {
  readonly handler: (envelope: TelegramInboundEnvelope) => Promise<TelegramInboundResult>
}

const failedText = '这次没有完成：判断或执行未完成。'

export interface PersonalFeedTelegramRequestHandlerOptions {
  readonly coordinator: PersonalFeedV2RequestCoordinator
}

/** The single request boundary shared by every Telegram entry. */
export function createPersonalFeedTelegramRequestHandler(
  options: PersonalFeedTelegramRequestHandlerOptions,
): (envelope: TelegramInboundEnvelope) => Promise<TelegramInboundResult> {
  return async (envelope: TelegramInboundEnvelope): Promise<TelegramInboundResult> => {
    try {
      const prepared = await options.coordinator.prepare({
        chatId: envelope.chat.id,
        messageId: envelope.message.id,
        signal: envelope.signal,
      })
      return {
        kind: 'handled' as const,
        finalText: prepared.outcome.finalText,
      }
    } catch {
      return { kind: 'failed', visibleError: failedText }
    }
  }
}

/** Install the narrow explicit Personal Feed request interceptor. */
export function registerPersonalFeedTelegramAdapter(
  ctx: PersonalFeedTelegramAdapterContext,
  options: PersonalFeedTelegramAdapterOptions,
): () => void {
  let disposed = false
  const stop = ctx.on('telegram/inbound', async (envelope, next) => {
    if (disposed) return await next()
    if (envelope.currentText.trim() === '') return { kind: 'handled', finalText: '' }
    if (!isExplicitPersonalFeedRequest(envelope)) return await next()
    return options.handler(envelope)
  })

  return () => {
    if (disposed) return
    disposed = true
    stop()
  }
}

export function isExplicitPersonalFeedRequest(envelope: TelegramInboundEnvelope): boolean {
  if (containsXLink(envelope.currentText) || containsXLink(envelope.reference?.selectedText)
    || containsXLink(envelope.reference?.messageText)) return false
  const text = envelope.currentText.trim()
  return /^(?:给我(?:发)?一次个人\s*feed|我想看一下 personal\s+feed|我最近不关心通用 ai 新闻了，给我一次个人\s+feed)[。.!！?？]?$/i.test(text)
}

function containsXLink(value: string | undefined): boolean {
  return value !== undefined
    && /(?:https?:\/\/)?(?:www\.)?(?:x\.com|twitter\.com)(?:[/?#\s]|$)/i.test(value)
}
