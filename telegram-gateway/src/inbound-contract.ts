/**
 * Transport-only input shared by the Telegram adapter and narrow consumers.
 * No routing decision or domain operation belongs in this envelope.
 */
export interface TelegramInboundChat {
  readonly id: number
  readonly type: string
}

export interface TelegramInboundMessage {
  readonly id: number
}

export interface TelegramInboundReference {
  readonly messageId?: number
  readonly selectedText?: string
  readonly messageText?: string
}

/** The complete transport context for one inbound message. */
export interface TelegramInboundEnvelope {
  readonly chat: TelegramInboundChat
  readonly message: TelegramInboundMessage
  readonly currentText: string
  readonly reference?: TelegramInboundReference
  readonly signal: AbortSignal
}

/** Terminal result returned by an inbound waterfall. */
export interface TelegramInboundHandled {
  readonly kind: 'handled'
  readonly finalText: string
}

/** The authoritative visible-message receipt returned by Telegram delivery. */
export interface TelegramInboundDeliveryReceipt {
  readonly chatId: number
  readonly triggerMessageId: number
  readonly visibleText: string
  readonly messageIds: readonly number[]
}

/** A handled result whose durable owner must be settled after transport delivery. */
export interface TelegramInboundHandledAwaitingDelivery {
  readonly kind: 'handled-awaiting-delivery'
  readonly finalText: string
  readonly settle: (receipt: TelegramInboundDeliveryReceipt) => void | Promise<void>
}

export interface TelegramInboundFailed {
  readonly kind: 'failed'
  readonly visibleError: string
}

export interface TelegramInboundRootDelivered {
  readonly kind: 'root-delivered'
}

export type TelegramInboundResult =
  | TelegramInboundHandled
  | TelegramInboundHandledAwaitingDelivery
  | TelegramInboundFailed
  | TelegramInboundRootDelivered

/** The ready observer runs before the waterfall and cannot intercept it. */
export type TelegramInboundReadyEvent = (envelope: TelegramInboundEnvelope) => true | void

/** The Cordis waterfall may intercept or delegate one inbound envelope. */
export type TelegramInboundWaterfallEvent = (
  envelope: TelegramInboundEnvelope,
  next: () => TelegramInboundResult | Promise<TelegramInboundResult>,
) => TelegramInboundResult | Promise<TelegramInboundResult>

declare module '@deepseek-ai/cordis' {
  interface Events {
    'telegram/inbound/ready': TelegramInboundReadyEvent
    'telegram/inbound': TelegramInboundWaterfallEvent
  }
}

/** Runtime guard for values crossing the adapter boundary. */
export function isTelegramInboundEnvelope(value: unknown): value is TelegramInboundEnvelope {
  if (!isRecord(value) || !hasKeys(value, ['chat', 'currentText', 'message', 'signal'], ['reference'])) return false
  if (!isChat(value.chat) || !isMessage(value.message) || typeof value.currentText !== 'string') return false
  if (value.reference !== undefined && !isReference(value.reference)) return false
  return isAbortSignal(value.signal)
}

function isChat(value: unknown): value is TelegramInboundChat {
  return isRecord(value)
    && hasExactKeys(value, ['id', 'type'])
    && typeof value.id === 'number'
    && Number.isSafeInteger(value.id)
    && typeof value.type === 'string'
}

function isMessage(value: unknown): value is TelegramInboundMessage {
  return isRecord(value)
    && hasExactKeys(value, ['id'])
    && typeof value.id === 'number'
    && Number.isSafeInteger(value.id)
}

function isReference(value: unknown): value is TelegramInboundReference {
  if (!isRecord(value) || !hasKeys(value, [], ['messageId', 'messageText', 'selectedText'])) return false
  if (value.messageId !== undefined
    && (typeof value.messageId !== 'number' || !Number.isSafeInteger(value.messageId))) return false
  if (value.selectedText !== undefined && typeof value.selectedText !== 'string') return false
  if (value.messageText !== undefined && typeof value.messageText !== 'string') return false
  return value.selectedText !== undefined || value.messageText !== undefined
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return isRecord(value)
    && typeof value.aborted === 'boolean'
    && typeof value.addEventListener === 'function'
    && typeof value.removeEventListener === 'function'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index])
}

function hasKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const allowed = new Set([...required, ...optional])
  const actual = Object.keys(value)
  return required.every(key => Object.hasOwn(value, key))
    && actual.every(key => allowed.has(key))
}
