import type { Context } from '@deepseek-ai/cordis'
import type {
  TelegramInboundEnvelope,
  TelegramInboundResult,
} from '@deepseek-ai/dsh-telegram-gateway'
import {
  personalFeedV2TelegramRequestId,
  type PersonalContextOwner,
  type PersonalContextSource,
  type PersonalContextCoverage,
} from '@herman/personal-feed'
import { isExplicitPersonalFeedRequest } from './telegram-adapter.ts'

const captureFailureText = '这次没有完成：判断或执行未完成。'

export interface PersonalContextTelegramRuntimeOptions {
  readonly owner: PersonalContextOwner
}

export interface PersonalContextTelegramRuntime {
  readonly r4: {
    readonly snapshot: (input: {
      readonly request: { readonly requestId: string; readonly cutoff: string; readonly shanghaiDay: string }
      readonly signal: AbortSignal
    }) => unknown | Promise<unknown>
  }
  readonly registerSourceFirst: (
    ctx: Pick<Context, 'on'>,
    options: { readonly personalFeedHandler: (envelope: TelegramInboundEnvelope) => Promise<TelegramInboundResult> },
  ) => () => void
}

/**
 * Owns the source capture barrier around the existing Telegram waterfalls.
 * This is deliberately package-private: it is a composition seam, not a
 * user-visible or Agent-visible capability.
 */
export function createPersonalContextTelegramRuntime(
  options: PersonalContextTelegramRuntimeOptions,
): PersonalContextTelegramRuntime {
  const failureMarkers = new Set<string>()

  const r4 = {
    snapshot: async (input: {
      readonly request: { readonly requestId: string; readonly cutoff: string; readonly shanghaiDay: string }
      readonly signal: AbortSignal
    }): Promise<unknown> => {
      if (failureMarkers.delete(input.request.requestId)) {
        return { kind: 'unknown', reason: 'current_source_pending' }
      }
      const fence = options.owner.freezeFence({ request: input.request })
      return options.owner.snapshot({ fence })
    },
  }

  const registerSourceFirst = (
    ctx: Pick<Context, 'on'>,
    registration: { readonly personalFeedHandler: (envelope: TelegramInboundEnvelope) => Promise<TelegramInboundResult> },
  ): (() => void) => {
    let disposed = false
    const stop = ctx.on('telegram/inbound', async (envelope, next) => {
      if (disposed) return await next()
      if (envelope.currentText.trim() === '') return { kind: 'handled', finalText: '' }

      const isFeed = isExplicitPersonalFeedRequest(envelope)
      const requestId = isFeed
        ? personalFeedV2TelegramRequestId(envelope.chat.id, envelope.message.id)
        : undefined
      let captured: { readonly source: PersonalContextSource; readonly coverage: PersonalContextCoverage }
      try {
        captured = options.owner.capture({
          locator: { kind: 'telegram_inbound', chatId: envelope.chat.id, messageId: envelope.message.id },
          rawText: envelope.currentText,
          reference: null,
          ...(requestId === undefined ? {} : { excludedRequestId: requestId }),
        })
      } catch {
        if (!isFeed || requestId === undefined) {
          return { kind: 'failed', visibleError: captureFailureText }
        }
        failureMarkers.add(requestId)
        try {
          return await registration.personalFeedHandler(envelope)
        } finally {
          failureMarkers.delete(requestId)
        }
      }

      await drainPendingSources(captured.source, envelope)
      return await next()
    }, { prepend: true })

    return () => {
      if (disposed) return
      disposed = true
      stop()
    }
  }

  const drainPendingSources = async (current: PersonalContextSource, envelope: TelegramInboundEnvelope): Promise<void> => {
    let state: ReturnType<PersonalContextOwner['read']>
    try {
      state = options.owner.read()
    } catch {
      return
    }
    const coverageBySourceKey = new Map(state.coverage.map(value => [value.sourceKey, value] as const))
    const sources = [...state.sources]
      .filter(source => source.captureSequence <= current.captureSequence)
      .sort((left, right) => left.captureSequence - right.captureSequence)
    for (const source of sources) {
      const coverage = coverageBySourceKey.get(source.sourceKey)
      if (coverage === undefined || coverage.status !== 'pending') continue
      let settled: PersonalContextCoverage | { readonly status: 'pending'; readonly sourceKey: string; readonly reason: string }
      try {
        settled = await options.owner.settle({ sourceKey: source.sourceKey, signal: envelope.signal })
      } catch {
        return
      }
      if (settled.status === 'pending') return
    }
  }

  return Object.freeze({ r4, registerSourceFirst })
}
