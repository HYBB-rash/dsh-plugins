/** Mechanical admission and physical proof for the exact Telegram no-focus close. */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { directExpressionHash, isDirectUserSource } from './managed-runtime.ts'

const TELEGRAM_SESSION_ID = 'session-telegram'
const CLOSE_TEXT = '这件事结束了'

export interface ClosureOnlyProofRecord {
  readonly closure: {
    readonly phase: 'pending' | 'physically_proved'
    readonly original: {
      readonly messageId: string
      readonly hash: string
    }
  }
}

export interface QualifiedTelegramNoFocusAdmission {
  readonly sessionId: typeof TELEGRAM_SESSION_ID
  readonly session: Agent['session']
  readonly message: UserMessage
  readonly origin: ClosureOnlyProofRecord['closure']['original']
}

export interface TelegramNoFocusAdmissionInput {
  readonly agent: Agent
  readonly message: UserMessage
  readonly inserted: UserMessage | undefined
  readonly claimed: UserMessage | undefined
  readonly stored: unknown
}

function textOf(message: UserMessage): string | undefined {
  return message.content.length === 1 && message.content[0]?.type === 'text'
    ? message.content[0].text
    : undefined
}

function isCanonical(event: SessionEvent): boolean {
  return event.type === 'user/message'
    && (event.data.source.kind === 'context-manager-canonical'
      || event.data.source.kind === 'context-manager-local-restriction'
      || event.data.source.kind === 'context-manager-no-safe-action')
}

function isPreContextEvent(event: SessionEvent): boolean {
  return event.type === 'user/message' || event.type === 'assistant/message'
}

/**
 * This function signs no business contract. It only proves that one exact
 * production-shaped root claim is absent from the Session and follows some
 * non-empty conversation history with no prior close or canonical marker.
 */
export function qualifyTelegramNoFocusAdmission(
  input: TelegramNoFocusAdmissionInput,
): QualifiedTelegramNoFocusAdmission | undefined {
  const { agent, message } = input
  const sessionId = String(agent.session.id)
  const messageId = String(message.id)
  const text = textOf(message)
  const events = agent.session.events
  if (sessionId !== TELEGRAM_SESSION_ID
    || (agent.session.header.delegationDepth ?? 0) !== 0
    || input.inserted !== message
    || input.claimed !== message
    || input.stored !== undefined
    || !isDirectUserSource(message.source)
    || text !== CLOSE_TEXT
    || events.some(event => event.type === 'user/message' && String(event.data.id) === messageId)
    || !events.some(isPreContextEvent)
    || events.some(isCanonical)
    || events.some(event => event.type === 'user/message'
      && event.data.source.kind === 'user'
      && textOf(event.data) === CLOSE_TEXT)) return undefined
  const origin = Object.freeze({
    messageId,
    hash: directExpressionHash(messageId, text),
  })
  return Object.freeze({ sessionId: TELEGRAM_SESSION_ID, session: agent.session, message, origin })
}

export interface ProveTelegramNoFocusAdmissionInput {
  readonly admission: QualifiedTelegramNoFocusAdmission
  readonly save: (record: ClosureOnlyProofRecord) => Promise<void>
  readonly flush: () => Promise<boolean>
  readonly readFrom: (fromSeq: number) => Promise<{ readonly events: readonly SessionEvent[] }>
}

function record(
  phase: ClosureOnlyProofRecord['closure']['phase'],
  origin: ClosureOnlyProofRecord['closure']['original'],
): ClosureOnlyProofRecord {
  return Object.freeze({
    closure: Object.freeze({ phase, original: Object.freeze({ ...origin }) }),
  })
}

/** Durable pending -> exact append/flush/readback -> physically-proved. */
export async function proveTelegramNoFocusAdmission(
  input: ProveTelegramNoFocusAdmissionInput,
): Promise<ClosureOnlyProofRecord> {
  const { admission } = input
  const pending = record('pending', admission.origin)
  await input.save(pending)
  const appended = admission.session.append('user/message', admission.message, { surfaceOp: 'append' })
  if (!await input.flush()) throw new Error('telegram no-focus admission flush failed')
  const detached = await input.readFrom(appended.seq)
  const liveBySeq = admission.session.events.filter(event => event.seq === appended.seq)
  const detachedBySeq = detached.events.filter(event => event.seq === appended.seq)
  const liveById = admission.session.events.filter(event => event.type === 'user/message'
    && String(event.data.id) === admission.origin.messageId)
  const detachedById = detached.events.filter(event => event.type === 'user/message'
    && String(event.data.id) === admission.origin.messageId)
  const live = liveBySeq[0]
  const persisted = detachedBySeq[0]
  const exact = (event: SessionEvent | undefined): boolean => event?.type === 'user/message'
    && String(event.data.id) === admission.origin.messageId
    && event.data.source.kind === 'user'
    && textOf(event.data) === CLOSE_TEXT
    && directExpressionHash(admission.origin.messageId, CLOSE_TEXT) === admission.origin.hash
  if (liveBySeq.length !== 1 || detachedBySeq.length !== 1
    || liveById.length !== 1 || detachedById.length !== 1
    || !exact(live) || !exact(persisted)) {
    throw new Error('telegram no-focus admission readback is not exact')
  }
  const proved = record('physically_proved', admission.origin)
  await input.save(proved)
  return proved
}
