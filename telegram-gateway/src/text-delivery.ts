import {
  chunkText,
  TelegramApiError,
  type TelegramHttp,
} from './telegram-contract.ts'

/** Shared Cordis service key for the first text-delivery protocol. */
export const DSH_TEXT_DELIVERY_V1 = 'dshTextDeliveryV1' as const

/** One request accepted by the generic text-delivery boundary. */
export interface DshTextDeliveryInput {
  readonly text: string
  readonly signal: AbortSignal
}

/** Stable delivery states exposed to transport-neutral consumers. */
export type DshTextDeliveryResult =
  | { readonly state: 'delivered'; readonly deliveredAt: string }
  | { readonly state: 'failed'; readonly error: string }
  | { readonly state: 'uncertain'; readonly error: string }

/** Versioned text-delivery service provided by the Telegram gateway. */
export interface DshTextDeliveryV1 {
  readonly protocolVersion: 1
  deliver(input: DshTextDeliveryInput): Promise<DshTextDeliveryResult>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    readonly dshTextDeliveryV1: DshTextDeliveryV1
  }
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message !== '') return error.message
  if (typeof error === 'string' && error !== '') return error
  return fallback
}

/**
 * Create the gateway-owned provider. The chat resolver is deliberately read
 * for every delivery so first-run private-chat authorization takes effect
 * without replacing or mutating the registered service.
 */
export function createDshTextDeliveryV1(
  http: TelegramHttp,
  resolveChatId: () => number | undefined,
  maxMessageChars: number,
): DshTextDeliveryV1 {
  return {
    protocolVersion: 1,
    async deliver({ text, signal }) {
      if (signal.aborted) {
        return {
          state: 'uncertain',
          error: errorMessage(signal.reason, 'telegram-gateway: delivery aborted'),
        }
      }
      const chatId = resolveChatId()
      if (chatId === undefined || !Number.isFinite(chatId)) {
        return { state: 'failed', error: 'telegram-gateway: no authorized chat' }
      }

      let confirmedChunks = 0
      try {
        for (const chunk of chunkText(text, maxMessageChars)) {
          signal.throwIfAborted()
          await http.sendMessage(chatId, chunk, undefined, signal)
          confirmedChunks += 1
        }
        return { state: 'delivered', deliveredAt: new Date().toISOString() }
      } catch (error) {
        const interrupted = signal.aborted
        const visibleError = errorMessage(
          interrupted ? signal.reason : error,
          interrupted ? 'telegram-gateway: delivery aborted' : 'telegram-gateway: delivery failed',
        )
        if (confirmedChunks > 0 || interrupted || !(error instanceof TelegramApiError)) {
          return { state: 'uncertain', error: visibleError }
        }
        return { state: 'failed', error: visibleError }
      }
    },
  }
}
