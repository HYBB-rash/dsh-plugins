import type { Context } from '@deepseek-ai/cordis'
import type {
  TelegramInboundEnvelope,
  TelegramInboundResult,
} from '@deepseek-ai/dsh-telegram-gateway'
import { isTrustedFact } from '../trusted-facts/model.ts'
import {
  serializeTrustedFactsByTarget,
  type CleanFeedbackRequest,
  type FeedbackPending,
} from './contract.ts'
import { parseFeedbackInterpretation } from './clean-agent.ts'
import { collectFeedbackTargetCatalog } from './target-catalog.ts'
import type { PendingStore } from './pending-store.ts'
import type { FeedbackEffectSink } from './feedback-effect-adapter.ts'
import type { TrustedFactRepository } from './trusted-fact-repository.ts'
import type {
  FeedbackUseCaseInput,
  FeedbackUseCaseResult,
} from './use-case.ts'
import { isExplicitPersonalFeedRequest } from '../personal-feed/telegram-adapter.ts'

/** The only Cordis surface needed by this delivery adapter. */
export type TelegramFeedbackAdapterContext = Pick<Context, 'on'>

/** The S4 seam; production binds this to runCleanFeedback(ctx, request). */
export type CleanFeedbackRunner = (
  request: CleanFeedbackRequest,
  signal: AbortSignal,
) => Promise<{
  readonly interpretation: unknown
}>

export interface TelegramFeedbackAdapterDependencies {
  readonly pendingStore: PendingStore
  readonly trustedFactRepository: TrustedFactRepository
  readonly effectSink: FeedbackEffectSink
  readonly useCase: {
    execute(input: FeedbackUseCaseInput): FeedbackUseCaseResult
  }
  readonly runCleanFeedback: CleanFeedbackRunner
}

const disposedError = 'X 反馈入口已卸载。'
const cleanFailurePrefix = 'X 反馈处理失败：'
const effectFailurePrefix = 'X 反馈写入失败：'
const partialFactFailureMessage = '事实已保存但投影暂不可用，无需重复发送，服务恢复后会重建。'

/**
 * Install the narrow Telegram X-feedback adapter and return its disposer.
 *
 * Routing is intentionally mechanical at this boundary: target extraction is
 * delegated to the catalog, intent is delegated to the clean Agent, and all
 * state/effects are delegated to S3/S5 ports.
 */
export function registerTelegramFeedbackAdapter(
  ctx: TelegramFeedbackAdapterContext,
  dependencies: TelegramFeedbackAdapterDependencies,
): () => void {
  let disposed = false
  let cleanupError: unknown
  const stopReady = ctx.on('telegram/inbound/ready', () => true)
  let stopWaterfall: (() => void) | undefined
  try {
    stopWaterfall = ctx.on('telegram/inbound', async (envelope, next) => {
      if (disposed) return failed(disposedError)
      return handleInbound(envelope, next, dependencies)
    })
  } catch (error) {
    // Registration is a local transaction.  The acquisition error remains the
    // error observed by the caller even if one of the rollback hooks fails.
    const rollbackErrors: unknown[] = []
    try { stopReady() } catch (cleanupError) { rollbackErrors.push(cleanupError) }
    try { dependencies.pendingStore.unload() } catch (cleanupError) { rollbackErrors.push(cleanupError) }
    throw combinePrimaryAndCleanup(error, rollbackErrors)
  }

  return () => {
    if (disposed) {
      if (cleanupError !== undefined) throw cleanupError
      return
    }
    disposed = true
    const errors: unknown[] = []
    try { stopWaterfall?.() } catch (error) { errors.push(error) }
    try { stopReady() } catch (error) { errors.push(error) }
    try { dependencies.pendingStore.unload() } catch (error) { errors.push(error) }
    cleanupError = errors.length === 1 ? errors[0] : errors.length > 1 ? new AggregateError(errors) : undefined
    if (cleanupError !== undefined) throw cleanupError
  }
}

function combinePrimaryAndCleanup(primary: unknown, cleanupErrors: readonly unknown[]): unknown {
  return cleanupErrors.length === 0 ? primary : new AggregateError([primary, ...cleanupErrors])
}

async function handleInbound(
  envelope: TelegramInboundEnvelope,
  next: () => TelegramInboundResult | Promise<TelegramInboundResult>,
  dependencies: TelegramFeedbackAdapterDependencies,
): Promise<TelegramInboundResult> {
  const conversationKey = conversationKeyForChat(envelope.chat.id)
  let pending: FeedbackPending | undefined
  try {
    pending = dependencies.pendingStore.get(conversationKey)
  } catch (error: unknown) {
    clearPending(dependencies.pendingStore, conversationKey)
    return failed(formatFailure(cleanFailurePrefix, error))
  }
  if (pending !== undefined && isExplicitPersonalFeedRequest(envelope)) {
    clearPending(dependencies.pendingStore, conversationKey)
    return await next()
  }
  const referenceText = selectedReferenceText(envelope)
  const targetCatalog = collectFeedbackTargetCatalog(envelope.currentText, referenceText)

  if (targetCatalog.quick.kind === 'pass' && pending === undefined) return await next()

  let request: CleanFeedbackRequest
  try {
    request = buildCleanRequest(
      envelope,
      referenceText,
      targetCatalog.catalog,
      pending,
      dependencies,
    )
  } catch (error: unknown) {
    return failed(formatFailure(cleanFailurePrefix, error))
  }

  let interpretation: ReturnType<typeof parseFeedbackInterpretation>
  try {
    const clean = await dependencies.runCleanFeedback(request, envelope.signal)
    interpretation = parseFeedbackInterpretation(clean.interpretation)
  } catch (error: unknown) {
    clearPending(dependencies.pendingStore, conversationKey)
    return failed(formatFailure(cleanFailurePrefix, error))
  }

  let result: FeedbackUseCaseResult
  try {
    result = dependencies.useCase.execute({
      conversationKey,
      request,
      interpretation,
    })
  } catch (error: unknown) {
    clearPending(dependencies.pendingStore, conversationKey)
    return failed(formatFailure('X 反馈状态转换失败：', error))
  }

  try {
    return await settleUseCaseResult(
      result,
      dependencies.effectSink,
      next,
      () => clearPending(dependencies.pendingStore, conversationKey),
    )
  } catch (error: unknown) {
    clearPending(dependencies.pendingStore, conversationKey)
    return failed(formatFailure('X 反馈状态转换失败：', error))
  }
}

function buildCleanRequest(
  envelope: TelegramInboundEnvelope,
  referenceText: string | undefined,
  targetCatalog: CleanFeedbackRequest['targetCatalog'],
  pending: FeedbackPending | undefined,
  dependencies: TelegramFeedbackAdapterDependencies,
): CleanFeedbackRequest {
  try {
    const targetIds = new Set([
      ...targetCatalog.currentMessage.map(target => target.id),
      ...targetCatalog.reference.map(target => target.id),
      ...(pending === undefined ? [] : [pending.target.id]),
    ])
    const trustedFacts = dependencies.trustedFactRepository
      .readAll()
      .filter(fact => isTrustedFact(fact) && targetIds.has(fact.target.id))

    return {
      currentMessage: {
        id: envelope.message.id,
        text: envelope.currentText,
        targets: targetCatalog.currentMessage,
      },
      ...(referenceText === undefined || envelope.reference === undefined ? {} : {
        reference: {
          ...(envelope.reference.messageId === undefined ? {} : { messageId: envelope.reference.messageId }),
          text: referenceText,
          targets: targetCatalog.reference,
        },
      }),
      targetCatalog,
      ...(pending === undefined ? {} : { pending }),
      trustedFactsByTarget: serializeTrustedFactsByTarget(trustedFacts),
    }
  } catch (error: unknown) {
    clearPending(dependencies.pendingStore, conversationKeyForChat(envelope.chat.id))
    throw error
  }
}

function selectedReferenceText(envelope: TelegramInboundEnvelope): string | undefined {
  const reference = envelope.reference
  if (reference === undefined) return undefined
  return reference.selectedText !== undefined ? reference.selectedText : reference.messageText
}

/** Stable key derived mechanically from the transport chat id only. */
export function conversationKeyForChat(chatId: number): string {
  return `telegram-chat:${chatId}`
}

function clearPending(store: PendingStore, conversationKey: string): void {
  try {
    store.clear(conversationKey)
  } catch {
    // A cleanup error must not turn a bounded failure into a root fallback.
  }
}

async function settleUseCaseResult(
  result: FeedbackUseCaseResult,
  effectSink: FeedbackEffectSink,
  next: () => TelegramInboundResult | Promise<TelegramInboundResult>,
  clearPendingOnFailure: () => void,
): Promise<TelegramInboundResult> {
  if (result.kind === 'pass') return await next()
  if (result.kind === 'failure') {
    clearPendingOnFailure()
    return failed(result.message)
  }
  if (result.kind === 'awaiting_reason'
    || result.kind === 'awaiting_candidate_confirmation'
    || result.kind === 'discarded') {
    return handled(result.reply)
  }

  if (result.kind !== 'completed') {
    clearPendingOnFailure()
    return failed('X 反馈状态转换失败：结果类型无效。')
  }

  for (const effect of result.effects) {
    let outcome
    try {
      outcome = effectSink.apply(effect)
    } catch (error: unknown) {
      clearPendingOnFailure()
      return failed(formatFailure(effectFailurePrefix, error))
    }
    if (!outcome.ok) {
      clearPendingOnFailure()
      if (outcome.code === 'fact_persisted_projection_unavailable') {
        return failed(partialFactFailureMessage)
      }
      return failed(`${effectFailurePrefix}${outcome.message}`)
    }
  }
  return handled(result.reply)
}

function handled(finalText: string): TelegramInboundResult {
  return { kind: 'handled', finalText }
}

function failed(visibleError: string): TelegramInboundResult {
  return { kind: 'failed', visibleError }
}

function formatFailure(prefix: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return `${prefix}${message}`
}
