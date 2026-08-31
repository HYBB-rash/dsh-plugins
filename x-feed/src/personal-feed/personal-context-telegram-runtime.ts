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
  readonly semanticLifecycle?: { readonly shutdown: () => Promise<void> }
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
  readonly shutdown: () => Promise<void>
}

type Settled<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown }

function observe<T>(promise: Promise<T>): Promise<Settled<T>> {
  return promise.then(
    value => ({ ok: true as const, value }),
    error => ({ ok: false as const, error }),
  )
}

function appendErrors(error: unknown, errors: unknown[]): void {
  if (error instanceof AggregateError) {
    for (const nested of error.errors) appendErrors(nested, errors)
    return
  }
  if (!errors.includes(error)) errors.push(error)
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
  const lifetime = new AbortController()
  let accepting = true
  const actualOperations = new Map<Promise<unknown>, Promise<Settled<unknown>>>()
  let shutdownPromise: Promise<void> | undefined

  const track = <T>(operation: () => T | Promise<T>): T | Promise<T> => {
    let value: T | Promise<T>
    try { value = operation() } catch (error) { throw error }
    if (!(value instanceof Promise)) return value
    const observed = observe(value)
    actualOperations.set(value, observed)
    void observed.then(() => { actualOperations.delete(value as Promise<unknown>) })
    return value
  }

  const combinedSignal = (envelope: TelegramInboundEnvelope): AbortSignal => AbortSignal.any([
    envelope.signal,
    lifetime.signal,
  ])

  const r4 = {
    snapshot: (input: {
      readonly request: { readonly requestId: string; readonly cutoff: string; readonly shanghaiDay: string }
      readonly signal: AbortSignal
    }): Promise<unknown> => {
      if (!accepting) return Promise.resolve({ kind: 'unknown', reason: 'runtime_stopping' })
      if (failureMarkers.delete(input.request.requestId)) {
        return Promise.resolve({ kind: 'unknown', reason: 'current_source_pending' })
      }
      const operation = (async (): Promise<unknown> => {
        const fence = options.owner.freezeFence({ request: input.request })
        return options.owner.snapshot({ fence })
      })()
      return track(() => operation) as Promise<unknown>
    },
  }

  const registerSourceFirst = (
    ctx: Pick<Context, 'on'>,
    registration: { readonly personalFeedHandler: (envelope: TelegramInboundEnvelope) => Promise<TelegramInboundResult> },
  ): (() => void) => {
    let disposed = false
    const stop = ctx.on('telegram/inbound', async (envelope, next) => {
      if (disposed) return await next()
      if (!accepting) return await next()
      if (envelope.currentText.trim() === '') return { kind: 'handled', finalText: '' }

      const isFeed = isExplicitPersonalFeedRequest(envelope)
      const requestId = isFeed
        ? personalFeedV2TelegramRequestId(envelope.chat.id, envelope.message.id)
        : undefined
      const captureResult = await track(async () => {
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
            return { kind: 'capture_failed' as const }
          }
          return { kind: 'feed_fallback' as const }
        }

        await drainPendingSources(captured.source, envelope)
        return { kind: 'captured' as const }
      })
      if (captureResult.kind === 'capture_failed') {
        return { kind: 'failed', visibleError: captureFailureText }
      }
      if (captureResult.kind === 'feed_fallback' && requestId !== undefined) {
        failureMarkers.add(requestId)
        try {
          return await registration.personalFeedHandler(envelope)
        } finally {
          failureMarkers.delete(requestId)
        }
      }
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
        settled = await options.owner.settle({ sourceKey: source.sourceKey, signal: combinedSignal(envelope) })
      } catch {
        return
      }
      if (settled.status === 'pending') return
    }
  }

  const shutdown = (): Promise<void> => {
    if (shutdownPromise !== undefined) return shutdownPromise
    accepting = false
    lifetime.abort(new Error('personal context Telegram runtime shutdown'))
    shutdownPromise = (async () => {
      const errors: unknown[] = []
      let semanticSettlement: Promise<Settled<void>>
      try {
        const semantic = options.semanticLifecycle?.shutdown()
        semanticSettlement = observe(Promise.resolve(semantic))
      } catch (error) {
        semanticSettlement = Promise.resolve({ ok: false as const, error })
      }
      while (actualOperations.size > 0) {
        const current = [...actualOperations.values()]
        const settled = await Promise.all(current)
        for (const outcome of settled) if (!outcome.ok) appendErrors(outcome.error, errors)
      }
      const semanticResult = await semanticSettlement
      if (!semanticResult.ok) appendErrors(semanticResult.error, errors)
      if (errors.length > 0) throw new AggregateError(errors)
    })()
    void shutdownPromise.then(undefined, () => undefined)
    return shutdownPromise
  }

  return Object.freeze({ r4, registerSourceFirst, shutdown })
}
