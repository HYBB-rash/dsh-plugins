import type { Context } from '@deepseek-ai/cordis'
import type {
  TelegramInboundDeliveryReceipt,
  TelegramInboundEnvelope,
  TelegramInboundResult,
} from '@deepseek-ai/dsh-telegram-gateway'
import type {
  PersonalFeedV2RequestCoordinator,
  PersonalFeedV2Receipt,
} from '@herman/personal-feed'

export type PersonalFeedTelegramAdapterContext = Pick<Context, 'on'>

export interface PersonalFeedTelegramAdapterOptions {
  readonly coordinator: PersonalFeedV2RequestCoordinator
}

const failedText = '这次没有完成：判断或执行未完成。'

export interface PersonalFeedTelegramRequestHandlerOptions {
  readonly coordinator: PersonalFeedV2RequestCoordinator
}

/** The single request/prepare/receipt boundary shared by every Telegram entry. */
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
      if (prepared.kind === 'duplicate_consumed') return { kind: 'handled', finalText: '' }
      return {
        kind: 'handled-awaiting-delivery' as const,
        finalText: prepared.outcome.finalText,
        settle: (receipt: TelegramInboundDeliveryReceipt) => {
          if (!hasOneTelegramMessageId(receipt)) {
            throw new Error('Telegram delivery receipt must contain exactly one message id')
          }
          return prepared.settle(receipt as PersonalFeedV2Receipt)
        },
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
  const handler = createPersonalFeedTelegramRequestHandler(options)
  const stop = ctx.on('telegram/inbound', async (envelope, next) => {
    if (disposed) return await next()
    if (envelope.currentText.trim() === '') return { kind: 'handled', finalText: '' }
    if (!isExplicitPersonalFeedRequest(envelope)) return await next()
    return handler(envelope)
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
  return /^(?:给我一次个人\s+feed|我想看一下 personal\s+feed|我最近不关心通用 ai 新闻了，给我一次个人\s+feed)[。.!！?？]?$/i.test(text)
}

function containsXLink(value: string | undefined): boolean {
  return value !== undefined
    && /(?:https?:\/\/)?(?:www\.)?(?:x\.com|twitter\.com)(?:[/?#\s]|$)/i.test(value)
}

function hasOneTelegramMessageId(value: TelegramInboundDeliveryReceipt): boolean {
  return Array.isArray(value.messageIds)
    && value.messageIds.length === 1
    && Number.isSafeInteger(value.messageIds[0])
    && value.messageIds[0] > 0
}
