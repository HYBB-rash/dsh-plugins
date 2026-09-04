import {
  createPersonalFeedV2CandidateStateOwner,
} from '../v2/candidate-state-owner.ts'
import {
  createPersonalFeedV2RequestCoordinator,
  type CreatePersonalFeedV2RequestCoordinatorOptions,
  type PersonalFeedV2R2Port,
  type PersonalFeedV2R5Port,
} from '../v2/request-coordinator.ts'
import type { TelegramInboundEnvelope, TelegramInboundResult } from '@deepseek-ai/dsh-telegram-gateway'
import { createPersonalFeedTelegramRequestHandler } from './telegram-adapter.ts'

const FAILED_RESULT: TelegramInboundResult = Object.freeze({
  kind: 'failed',
  visibleError: '这次没有完成：判断或执行未完成。',
})
type CompositionOptions = Readonly<{
  readonly r4: CreatePersonalFeedV2RequestCoordinatorOptions['r4']
  readonly r2: PersonalFeedV2R2Port
  readonly r5: PersonalFeedV2R5Port
  readonly candidateStatePath: string
  readonly clock: CreatePersonalFeedV2RequestCoordinatorOptions['clock']
}>

type Composition = Readonly<{
  readonly handler: (envelope: TelegramInboundEnvelope) => Promise<TelegramInboundResult>
  readonly shutdown: () => Promise<void>
}>

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value)
  return actual.length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

function hasSingleFunction(value: unknown, key: string): boolean {
  return isRecord(value) && hasExactKeys(value, [key]) && typeof value[key] === 'function'
}

function readOptions(value: unknown): CompositionOptions {
  if (!isRecord(value) || !Object.isFrozen(value)
    || !hasExactKeys(value, ['r4', 'r2', 'r5', 'candidateStatePath', 'clock'])
    || !hasSingleFunction(value.r4, 'snapshot') || !hasSingleFunction(value.r2, 'observe')
    || !hasSingleFunction(value.r5, 'judgeOne')
    || typeof value.candidateStatePath !== 'string' || value.candidateStatePath.trim() === ''
    || !hasSingleFunction(value.clock, 'now')) {
    throw new Error('personal Feed Telegram composition options are invalid')
  }
  return value as CompositionOptions
}

/** Internal install-scoped composition; intentionally absent from the package root. */
export function createPersonalFeedTelegramProductionComposition(options: unknown): Composition {
  const resolved = readOptions(options)
  const candidateState = createPersonalFeedV2CandidateStateOwner({
    statePath: resolved.candidateStatePath,
    clock: resolved.clock,
  })
  const coordinator = createPersonalFeedV2RequestCoordinator({
    clock: resolved.clock,
    r4: resolved.r4,
    r2: resolved.r2,
    r3: candidateState,
    r5: resolved.r5,
  })
  const requestHandler = createPersonalFeedTelegramRequestHandler({ coordinator })
  const installController = new AbortController()
  const active = new Set<Promise<TelegramInboundResult>>()
  let accepting = true
  let shutdownPromise: Promise<void> | undefined

  const handler = (envelope: TelegramInboundEnvelope): Promise<TelegramInboundResult> => {
    if (!accepting) return Promise.resolve(FAILED_RESULT)
    let operation: Promise<TelegramInboundResult>
    try {
      const signal = AbortSignal.any([envelope.signal, installController.signal])
      const forwarded = Object.freeze({
        chat: envelope.chat,
        message: envelope.message,
        currentText: envelope.currentText,
        ...(envelope.reference === undefined ? {} : { reference: envelope.reference }),
        signal,
      })
      operation = Promise.resolve(requestHandler(forwarded)).then(
        result => result,
        () => FAILED_RESULT,
      )
    } catch {
      operation = Promise.resolve(FAILED_RESULT)
    }
    active.add(operation)
    void operation.finally(() => { active.delete(operation) })
    return operation
  }

  const shutdown = (): Promise<void> => {
    if (shutdownPromise !== undefined) return shutdownPromise
    accepting = false
    installController.abort(new Error('personal Feed Telegram install shutdown'))
    shutdownPromise = (async () => {
      while (active.size > 0) await Promise.allSettled([...active])
    })()
    void shutdownPromise.catch(() => undefined)
    return shutdownPromise
  }

  Object.freeze(handler)
  Object.freeze(shutdown)
  return Object.freeze({ handler, shutdown })
}
