import type { Context } from '@deepseek-ai/cordis'
import {
  personalFeedV2TelegramRequestId,
  type PersonalContextOwner,
  type PersonalContextRequest,
} from '@herman/personal-feed'
import { isExplicitPersonalFeedRequest } from './telegram-adapter.ts'

export interface PersonalContextTelegramRuntimeOptions {
  readonly owner: PersonalContextOwner
  readonly installSignal: AbortSignal
}

export interface PersonalContextTelegramRuntime {
  readonly r4: {
    readonly snapshot: (input: {
      readonly request: PersonalContextRequest
      readonly signal: AbortSignal
    }) => Promise<unknown>
  }
  readonly registerSourceFirst: (ctx: Pick<Context, 'on'>) => () => void
}

/** Keeps direct Telegram facts ahead of the one Personal Feed request handler. */
export function createPersonalContextTelegramRuntime(
  options: PersonalContextTelegramRuntimeOptions,
): PersonalContextTelegramRuntime {
  if (!(options.installSignal instanceof AbortSignal)) {
    throw new TypeError('personal context install signal is invalid')
  }
  const unavailableRequests = new Set<string>()

  const r4 = Object.freeze({
    snapshot: async (input: { readonly request: PersonalContextRequest; readonly signal: AbortSignal }): Promise<unknown> => {
      if (input.signal.aborted || options.installSignal.aborted) {
        return { kind: 'unknown', reason: 'aborted' }
      }
      if (unavailableRequests.has(input.request.requestId)) {
        return { kind: 'unknown', reason: 'current_source_unavailable' }
      }
      return options.owner.snapshot({ request: input.request })
    },
  })

  const registerSourceFirst = (ctx: Pick<Context, 'on'>): (() => void) => {
    let disposed = false
    const stop = ctx.on('telegram/inbound', async (envelope, next) => {
      if (disposed || options.installSignal.aborted) return await next()
      if (envelope.currentText.trim() === '') return await next()
      const feedRequest = isExplicitPersonalFeedRequest(envelope)
      const requestId = feedRequest
        ? personalFeedV2TelegramRequestId(envelope.chat.id, envelope.message.id)
        : undefined
      let observed = false
      try {
        const result = await options.owner.observe({
          source: { kind: 'telegram_inbound', chatId: envelope.chat.id, messageId: envelope.message.id },
          rawText: envelope.currentText,
          signal: AbortSignal.any([envelope.signal, options.installSignal]),
        })
        observed = result.kind !== 'incomplete'
      } catch {
        observed = false
      }

      if (feedRequest && requestId !== undefined && !observed) unavailableRequests.add(requestId)
      try {
        return await next()
      } finally {
        if (requestId !== undefined) unavailableRequests.delete(requestId)
      }
    }, { prepend: true })

    return () => {
      if (disposed) return
      disposed = true
      stop()
    }
  }

  return Object.freeze({ r4, registerSourceFirst })
}
