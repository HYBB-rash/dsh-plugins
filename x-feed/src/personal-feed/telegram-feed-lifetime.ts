import { types as nodeTypes } from 'node:util'
import type {
  TelegramInboundEnvelope,
  TelegramInboundResult,
} from '@deepseek-ai/dsh-telegram-gateway'
import {
  createPersonalFeedV2RequestCoordinator,
  type CreatePersonalFeedV2RequestCoordinatorOptions,
  type PersonalFeedV2R2Port,
  type PersonalFeedV2R3Port,
} from '@herman/personal-feed'
import { createPersonalFeedTelegramRequestHandler } from './telegram-adapter.ts'

const FAILED_RESULT: TelegramInboundResult = Object.freeze({
  kind: 'failed',
  visibleError: '这次没有完成：判断或执行未完成。',
})
const CLEANUP_SEAL_AND_DRAIN = Symbol.for('@herman/personal-feed/v2/request-coordinator-cleanup-seal-and-drain')
const PROMISE_THEN = Promise.prototype.then

type RawClose = (reason: string) => unknown
type AuthorityState = 'idle' | 'closing' | 'failed-open' | 'final-retrying' | 'closed' | 'terminal-failed'

interface Authority {
  receiver: object | undefined
  close: RawClose | undefined
  state: AuthorityState
  attempt: Promise<boolean> | undefined
  terminalError: Error | undefined
  finalRetryStarted: boolean
}

interface DescriptorRecord {
  readonly values: ReadonlyMap<string, unknown>
}

export interface PersonalFeedTelegramInstallLifetimeOptions {
  readonly coordinatorOptions: CreatePersonalFeedV2RequestCoordinatorOptions
  readonly r2Shutdown?: () => unknown
}

export interface PersonalFeedTelegramInstallLifetime {
  readonly handler: (envelope: TelegramInboundEnvelope) => Promise<TelegramInboundResult>
  readonly shutdown: () => Promise<void>
}

function descriptorRecord(value: unknown): DescriptorRecord | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || nodeTypes.isProxy(value)) return undefined
  let prototype: object | null
  let keys: readonly PropertyKey[]
  let descriptors: Record<string, PropertyDescriptor>
  try {
    prototype = Object.getPrototypeOf(value)
    keys = Reflect.ownKeys(value)
    descriptors = Object.getOwnPropertyDescriptors(value)
  } catch {
    return undefined
  }
  if (prototype !== Object.prototype && prototype !== null) return undefined
  const values = new Map<string, unknown>()
  for (const key of keys) {
    if (typeof key !== 'string') return undefined
    const descriptor = descriptors[key]
    if (descriptor === undefined || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) return undefined
    values.set(key, descriptor.value)
  }
  return { values }
}

function exactDescriptorRecord(value: unknown, expectedKeys: readonly string[]): DescriptorRecord | undefined {
  const record = descriptorRecord(value)
  if (record === undefined || record.values.size !== expectedKeys.length) return undefined
  for (const key of expectedKeys) if (!record.values.has(key)) return undefined
  return record
}

function fixedFailure(): TelegramInboundResult {
  return FAILED_RESULT
}

function mapRealPromise(value: unknown, map: (value: unknown) => unknown): unknown {
  if (!nodeTypes.isPromise(value)) return map(value)
  return Reflect.apply(PROMISE_THEN, value, [map, undefined])
}

function makeAuthority(authorities: Set<Authority>, receiver: object, close: RawClose): Authority {
  const authority: Authority = {
    receiver,
    close,
    state: 'idle',
    attempt: undefined,
    terminalError: undefined,
    finalRetryStarted: false,
  }
  authorities.add(authority)
  return authority
}

function releaseAuthority(authority: Authority): void {
  authority.receiver = undefined
  authority.close = undefined
}

function authorityFailure(authority: Authority): Error {
  return authority.terminalError ?? new Error('personal Feed Telegram cleanup failed')
}

function attemptAuthority(authority: Authority, sealed: () => boolean, finalRetry: boolean, reason: string): Promise<boolean> {
  if (authority.attempt !== undefined) return authority.attempt
  if (authority.state === 'closed') return Promise.resolve(true)
  if (authority.state === 'terminal-failed') return Promise.resolve(false)
  const firstOrdinary = !finalRetry && authority.state === 'idle'
  if (sealed() && !finalRetry && !firstOrdinary) return Promise.reject(authorityFailure(authority))
  const receiver = authority.receiver
  const close = authority.close
  if (receiver === undefined || close === undefined) {
    authority.state = 'terminal-failed'
    authority.terminalError = authorityFailure(authority)
    return Promise.resolve(false)
  }
  if (finalRetry) authority.state = 'final-retrying'
  else authority.state = 'closing'
  let result: unknown
  try {
    result = Reflect.apply(close, receiver, [reason])
  } catch {
    const failure = new Error('personal Feed Telegram cleanup failed')
    authority.state = finalRetry ? 'terminal-failed' : 'failed-open'
    authority.terminalError = failure
    if (finalRetry) releaseAuthority(authority)
    return Promise.reject(failure)
  }
  const operation = Promise.resolve(result).then(
    () => {
      authority.state = 'closed'
      authority.terminalError = undefined
      releaseAuthority(authority)
      return true
    },
    () => {
      const failure = new Error('personal Feed Telegram cleanup failed')
      authority.state = finalRetry ? 'terminal-failed' : 'failed-open'
      authority.terminalError = failure
      if (finalRetry) releaseAuthority(authority)
      throw failure
    },
  )
  authority.attempt = operation
  void operation.then(
    () => { if (authority.attempt === operation) authority.attempt = undefined },
    () => { if (authority.attempt === operation) authority.attempt = undefined },
  )
  return operation
}

function closeProxy(authority: Authority, sealed: () => boolean): RawClose {
  return (reason: string): unknown => {
    if (authority.state === 'closed') return Promise.resolve()
    if (authority.state === 'terminal-failed') return Promise.reject(authorityFailure(authority))
    if (authority.attempt !== undefined) return authority.attempt
    const firstOrdinary = authority.state === 'idle'
    if (sealed() && !firstOrdinary) return Promise.reject(authorityFailure(authority))
    return attemptAuthority(authority, sealed, false, reason)
  }
}

function wrappedR2(
  raw: PersonalFeedV2R2Port,
  authorities: Set<Authority>,
  sealed: () => boolean,
): PersonalFeedV2R2Port {
  return {
    observe: input => {
      const rawResult = Reflect.apply(raw.observe, raw, [input])
      return mapRealPromise(rawResult, result => {
      const record = exactDescriptorRecord(result, ['kind', 'window', 'close'])
      if (record === undefined) return result
      const kind = record.values.get('kind')
      const close = record.values.get('close')
      if (kind !== 'complete' || typeof close !== 'function' || typeof result !== 'object' || result === null) return result
      const authority = makeAuthority(authorities, result, close as RawClose)
      return Object.freeze({ kind: 'complete' as const, window: record.values.get('window'), close: closeProxy(authority, sealed) })
      })
    },
  }
}

function mapR3AdmissionResult(result: unknown, authorities: Set<Authority>, sealed: () => boolean): unknown {
  const outer = exactDescriptorRecord(result, ['kind', 'cursor'])
  if (outer?.values.get('kind') !== 'admitted') return result
  const rawCursor = outer.values.get('cursor')
  const full = exactDescriptorRecord(rawCursor, ['borrowCurrent', 'finalize', 'close'])
  if (full !== undefined
    && typeof full.values.get('borrowCurrent') === 'function'
    && typeof full.values.get('finalize') === 'function'
    && typeof full.values.get('close') === 'function'
    && typeof rawCursor === 'object' && rawCursor !== null) {
    const authority = makeAuthority(authorities, rawCursor, full.values.get('close') as RawClose)
    return Object.freeze({
      kind: 'admitted' as const,
      cursor: Object.freeze({
        borrowCurrent: (borrowInput: unknown) => Reflect.apply(full.values.get('borrowCurrent') as (...args: unknown[]) => unknown, rawCursor, [borrowInput]),
        finalize: (claim: unknown) => Reflect.apply(full.values.get('finalize') as (...args: unknown[]) => unknown, rawCursor, [claim]),
        close: closeProxy(authority, sealed),
      }),
    })
  }
  const cleanup = descriptorRecord(rawCursor)
  const cleanupClose = cleanup?.values.get('close')
  if (cleanup !== undefined && typeof cleanupClose === 'function' && typeof rawCursor === 'object' && rawCursor !== null) {
    const authority = makeAuthority(authorities, rawCursor, cleanupClose as RawClose)
    return Object.freeze({
      kind: 'admitted' as const,
      cursor: Object.freeze({ close: closeProxy(authority, sealed) }),
    })
  }
  return result
}

function wrappedR3(
  raw: PersonalFeedV2R3Port,
  authorities: Set<Authority>,
  sealed: () => boolean,
): PersonalFeedV2R3Port {
  return {
    admit: input => {
      const rawResult = Reflect.apply(raw.admit, raw, [input])
      return mapRealPromise(rawResult, result => mapR3AdmissionResult(result, authorities, sealed))
    },
  }
}

function coordinatorDrain(coordinator: object): Promise<void> {
  const prepare = (coordinator as { readonly prepare?: unknown }).prepare
  if (typeof prepare !== 'function') return Promise.reject(new Error('personal Feed Telegram coordinator cleanup capability missing'))
  const descriptor = Object.getOwnPropertyDescriptor(prepare, CLEANUP_SEAL_AND_DRAIN)
  if (descriptor === undefined || descriptor.enumerable || descriptor.configurable || descriptor.writable || typeof descriptor.value !== 'function') {
    return Promise.reject(new Error('personal Feed Telegram coordinator cleanup capability missing'))
  }
  return Reflect.apply(descriptor.value as (this: unknown, value: object) => Promise<void>, prepare, [coordinator])
}

export function createPersonalFeedTelegramInstallLifetime(
  options: PersonalFeedTelegramInstallLifetimeOptions,
): PersonalFeedTelegramInstallLifetime {
  const authorities = new Set<Authority>()
  const installController = new AbortController()
  const installReason = new Error('personal Feed Telegram install shutdown')
  let accepting = true
  let shutdownPromise: Promise<void> | undefined
  const active = new Set<Promise<unknown>>()

  const sealed = (): boolean => !accepting
  const coordinatorOptions = options.coordinatorOptions
  const coordinator = createPersonalFeedV2RequestCoordinator({
    ...coordinatorOptions,
    r2: wrappedR2(coordinatorOptions.r2, authorities, sealed),
    r3: wrappedR3(coordinatorOptions.r3, authorities, sealed),
  })
  const requestHandler = createPersonalFeedTelegramRequestHandler({ coordinator })

  const handler = (envelope: TelegramInboundEnvelope): Promise<TelegramInboundResult> => {
    let release!: () => void
    const token = new Promise<void>(resolve => { release = resolve })
    active.add(token)
    const finish = (result: TelegramInboundResult): TelegramInboundResult => {
      active.delete(token)
      release()
      return result
    }
    if (!accepting) return Promise.resolve(finish(fixedFailure()))
    try {
      const signal = AbortSignal.any([envelope.signal, installController.signal])
      const forwarded = Object.freeze({
        chat: envelope.chat,
        message: envelope.message,
        currentText: envelope.currentText,
        ...(envelope.reference === undefined ? {} : { reference: envelope.reference }),
        signal,
      })
      if (!accepting) return Promise.resolve(finish(fixedFailure()))
      return Promise.resolve(requestHandler(forwarded)).then(
        result => finish(result),
        () => finish(fixedFailure()),
      )
    } catch {
      return Promise.resolve(finish(fixedFailure()))
    }
  }

  const shutdown = (): Promise<void> => {
    if (shutdownPromise !== undefined) return shutdownPromise
    accepting = false
    installController.abort(installReason)
    let shutdownOperation: Promise<'fulfilled' | 'failed'>
    try {
      shutdownOperation = Promise.resolve(options.r2Shutdown?.()).then(
        () => 'fulfilled' as const,
        () => 'failed' as const,
      )
    } catch {
      shutdownOperation = Promise.resolve('failed')
    }
    shutdownPromise = (async () => {
      const errors: unknown[] = []
      let authorityCleanupFailed = false
      const observe = async (operation: Promise<unknown>): Promise<unknown> => {
        try { return await operation } catch { errors.push(new Error('personal Feed Telegram cleanup failed')); return undefined }
      }
      while (active.size > 0) await Promise.all([...active].map(operation => observe(operation)))
      for (const authority of authorities) {
        if (authority.attempt !== undefined) {
          try { await authority.attempt } catch { /* the lifetime final retry decides recoverability */ }
        }
        if (authority.state !== 'closed' && authority.state !== 'terminal-failed' && !authority.finalRetryStarted) {
          authority.finalRetryStarted = true
          try {
            await attemptAuthority(authority, sealed, true, 'personal Feed Telegram install shutdown')
          } catch {
            authorityCleanupFailed = true
          }
        }
      }
      let coordinatorFailed = false
      try {
        await coordinatorDrain(coordinator)
      } catch (error) {
        coordinatorFailed = true
        errors.push(authorityCleanupFailed ? new Error('personal Feed Telegram cleanup failed') : error)
      }
      if (authorityCleanupFailed && !coordinatorFailed) errors.push(new Error('personal Feed Telegram cleanup failed'))
      if (await shutdownOperation === 'failed') errors.push(new Error('personal Feed Telegram cleanup failed'))
      authorities.clear()
      if (errors.length > 0) throw new AggregateError(errors)
    })()
    void shutdownPromise.then(undefined, () => undefined)
    return shutdownPromise
  }

  return Object.freeze({ handler, shutdown })
}
