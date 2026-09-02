import { types as nodeTypes } from 'node:util'
import { dirname, join, normalize, resolve } from 'node:path'
import {
  createPersonalFeedV2CandidateLifecycle,
  type CreatePersonalFeedV2CandidateLifecycleOptions,
  type CreatePersonalFeedV2RequestCoordinatorOptions,
  type PersonalFeedV2R2Input,
  type PersonalFeedV2R2Port,
} from '@herman/personal-feed'
import {
  createPersonalFeedTelegramInstallLifetime,
  type PersonalFeedTelegramInstallLifetime,
} from './telegram-feed-lifetime.ts'

const EXPECTED_OPTIONS_KEYS = Object.freeze([
  'runtimeConfig',
  'startupFactory',
  'r4',
  'completionLedgerPath',
  'clock',
] as const)
const EXPECTED_R4_KEYS = Object.freeze(['snapshot'] as const)
const EXPECTED_CLOCK_KEYS = Object.freeze(['now'] as const)
const EXPECTED_OWNER_KEYS = Object.freeze(['observe', 'shutdown'] as const)
const PROMISE_THEN = Promise.prototype.then
const UNKNOWN_RESULT = Object.freeze({ kind: 'unknown' })
const CLEANUP_FAILURE_MESSAGE = 'personal Feed Telegram cleanup failed'
const CONSERVATIVE_R5_RESULT = Object.freeze({
  kind: 'incomplete',
  completed: Object.freeze([]),
  reason: 'unknown',
})
const CONSERVATIVE_R5 = Object.freeze({
  judge: () => CONSERVATIVE_R5_RESULT,
})

type PlainDataRecord = Readonly<Record<string, unknown>>

type CompositionOptions = Readonly<{
  readonly runtimeConfig: PlainDataRecord
  readonly startupFactory: (runtimeConfig: unknown) => unknown
  readonly r4: CreatePersonalFeedV2RequestCoordinatorOptions['r4']
  readonly completionLedgerPath: string
  readonly clock: CreatePersonalFeedV2RequestCoordinatorOptions['clock']
}>

type PersonalFeedTelegramProductionComposition = Readonly<{
  readonly handler: PersonalFeedTelegramInstallLifetime['handler']
  readonly shutdown: PersonalFeedTelegramInstallLifetime['shutdown']
}>

type StartupOwner = Readonly<{
  readonly observe: (input: PersonalFeedV2R2Input) => unknown
  readonly shutdown: () => unknown
}>

type OwnerState = 'uninitialized' | 'initializing' | 'ready' | 'failed' | 'shutting' | 'closed'

function isNonProxyFunction(value: unknown): value is (...args: never[]) => unknown {
  if (typeof value !== 'function') return false
  try {
    return !nodeTypes.isProxy(value)
  } catch {
    return false
  }
}

function readFrozenPlainDataRecord(value: unknown): PlainDataRecord | undefined {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)
      || nodeTypes.isProxy(value) || !Object.isFrozen(value)) return undefined
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return undefined
    const keys = Reflect.ownKeys(value)
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const key of keys) {
      if (typeof key !== 'string') return undefined
      const descriptor = descriptors[key]
      if (descriptor === undefined || descriptor.enumerable !== true
        || !Object.hasOwn(descriptor, 'value')
        || descriptor.configurable !== false || descriptor.writable !== false) return undefined
      values[key] = descriptor.value
    }
    return values as PlainDataRecord
  } catch {
    return undefined
  }
}

function readExactFrozenRecord(
  value: unknown,
  expectedKeys: readonly string[],
  requireFrozen = true,
): ReadonlyMap<string, unknown> | undefined {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)
      || nodeTypes.isProxy(value) || (requireFrozen && !Object.isFrozen(value))) return undefined
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return undefined
    const keys = Reflect.ownKeys(value)
    if (keys.length !== expectedKeys.length
      || keys.some(key => typeof key !== 'string' || !expectedKeys.includes(key))) return undefined
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const values = new Map<string, unknown>()
    for (const key of expectedKeys) {
      const descriptor = descriptors[key]
      if (descriptor === undefined || descriptor.enumerable !== true
        || !Object.hasOwn(descriptor, 'value')
        || (requireFrozen && (descriptor.configurable !== false || descriptor.writable !== false))) return undefined
      values.set(key, descriptor.value)
    }
    return values
  } catch {
    return undefined
  }
}

function readCompositionOptions(value: unknown): CompositionOptions {
  const record = readExactFrozenRecord(value, EXPECTED_OPTIONS_KEYS)
  if (record === undefined) throw new Error('personal Feed Telegram composition options are invalid')

  const runtimeConfig = record.get('runtimeConfig')
  const startupFactory = record.get('startupFactory')
  const r4 = record.get('r4')
  const completionLedgerPath = record.get('completionLedgerPath')
  const clock = record.get('clock')
  const r4Record = readExactFrozenRecord(r4, EXPECTED_R4_KEYS, false)
  const clockRecord = readExactFrozenRecord(clock, EXPECTED_CLOCK_KEYS, false)
  if (readFrozenPlainDataRecord(runtimeConfig) === undefined
    || !isNonProxyFunction(startupFactory)
    || !hasFunctionArity(startupFactory, 1)
    || r4Record === undefined
    || !isNonProxyFunction(r4Record.get('snapshot'))
    || typeof completionLedgerPath !== 'string'
    || completionLedgerPath.trim() === ''
    || clockRecord === undefined
    || !isNonProxyFunction(clockRecord.get('now'))) {
    throw new Error('personal Feed Telegram composition options are invalid')
  }
  return {
    runtimeConfig: runtimeConfig as PlainDataRecord,
    startupFactory: startupFactory as CompositionOptions['startupFactory'],
    r4: r4 as CompositionOptions['r4'],
    completionLedgerPath,
    clock: clock as CompositionOptions['clock'],
  }
}

function hasFunctionArity(value: Function, expected: number): boolean {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, 'length')
    return descriptor !== undefined && Object.hasOwn(descriptor, 'value') && descriptor.value === expected
  } catch {
    return false
  }
}

function readOwner(value: unknown): StartupOwner | undefined {
  const record = readExactFrozenRecord(value, EXPECTED_OWNER_KEYS)
  if (record === undefined) return undefined
  const observe = record.get('observe')
  const shutdown = record.get('shutdown')
  if (!isNonProxyFunction(observe) || !isNonProxyFunction(shutdown)) return undefined
  return value as StartupOwner
}

function mapNativePromise(value: unknown, onFulfilled: (value: unknown) => unknown, onRejected: () => unknown): unknown {
  if (!nodeTypes.isPromise(value)) return onFulfilled(value)
  return Reflect.apply(PROMISE_THEN, value, [onFulfilled, onRejected])
}

function createLazyOwner(
  runtimeConfig: PlainDataRecord,
  startupFactory: (runtimeConfig: unknown) => unknown,
  publicShutdownPromise: () => Promise<void> | undefined,
): Readonly<PersonalFeedV2R2Port & { readonly shutdown: () => Promise<void> }> {
  let state: OwnerState = 'uninitialized'
  let owner: StartupOwner | undefined
  let shutdownPromise: Promise<void> | undefined
  let resolveShutdown: (() => void) | undefined
  let rejectShutdown: (() => void) | undefined
  const isShutting = (): boolean => state === 'shutting'

  const fixedShutdownFailure = (): Error => new Error(CLEANUP_FAILURE_MESSAGE)

  const publishShutdown = (): Promise<void> => {
    if (shutdownPromise !== undefined) return shutdownPromise
    shutdownPromise = new Promise<void>((resolve, reject) => {
      resolveShutdown = resolve
      rejectShutdown = () => reject(fixedShutdownFailure())
    })
    void shutdownPromise.catch(() => undefined)
    return shutdownPromise
  }

  const completeShutdown = (): void => {
    state = 'closed'
    resolveShutdown?.()
  }

  const failShutdown = (): void => {
    state = 'closed'
    rejectShutdown?.()
  }

  const closeReadyOwner = (): void => {
    let raw: unknown
    try {
      raw = Reflect.apply(owner!.shutdown, owner, [])
    } catch {
      failShutdown()
      return
    }
    if (raw === publicShutdownPromise() || raw === shutdownPromise) {
      failShutdown()
      return
    }
    if (!nodeTypes.isPromise(raw)) {
      completeShutdown()
      return
    }
    void Reflect.apply(PROMISE_THEN, raw, [
      () => { completeShutdown() },
      () => { failShutdown() },
    ])
  }

  const shutdown = (): Promise<void> => {
    if (shutdownPromise !== undefined) return shutdownPromise

    if (state === 'uninitialized' || state === 'failed') {
      state = 'closed'
      shutdownPromise = Promise.resolve()
      return shutdownPromise
    }

    if (state === 'initializing') {
      state = 'shutting'
      return publishShutdown()
    }

    if (state === 'ready') {
      state = 'shutting'
      const stableShutdown = publishShutdown()
      closeReadyOwner()
      return stableShutdown
    }

    state = 'closed'
    shutdownPromise = Promise.resolve()
    return shutdownPromise
  }

  const observe = (input: PersonalFeedV2R2Input): unknown => {
    if (state === 'closed' || state === 'shutting' || state === 'failed') return UNKNOWN_RESULT
    if (owner === undefined) {
      state = 'initializing'
      try {
        const created = Reflect.apply(startupFactory, undefined, [runtimeConfig])
        const validated = readOwner(created)
        if (validated === undefined) throw new Error('personal Feed Telegram startup owner is invalid')
        owner = validated
      } catch {
        if (shutdownPromise !== undefined) completeShutdown()
        else state = 'failed'
        return UNKNOWN_RESULT
      }
      if (isShutting()) {
        closeReadyOwner()
        return UNKNOWN_RESULT
      }
      state = 'ready'
    }

    let raw: unknown
    try {
      raw = Reflect.apply(owner.observe, owner, [input])
    } catch {
      return UNKNOWN_RESULT
    }
    return mapNativePromise(raw, value => value, () => UNKNOWN_RESULT)
  }

  return Object.freeze({ observe, shutdown })
}

/** Internal production composition seam; intentionally absent from the package root. */
export function createPersonalFeedTelegramProductionComposition(
  options: unknown,
): PersonalFeedTelegramProductionComposition {
  const resolved = readCompositionOptions(options)
  const requestLedgerPath = join(dirname(resolved.completionLedgerPath), 'requests.jsonl')
  if (resolve(normalize(resolved.completionLedgerPath)) === resolve(normalize(requestLedgerPath))) {
    throw new Error('personal Feed Telegram composition ledger paths collide')
  }

  let publicShutdownPromise: Promise<void> | undefined
  let resolvePublicShutdown: (() => void) | undefined
  let rejectPublicShutdown: ((reason: unknown) => void) | undefined
  const lazyOwner = createLazyOwner(
    resolved.runtimeConfig,
    resolved.startupFactory,
    () => publicShutdownPromise,
  )
  const candidateOptions: CreatePersonalFeedV2CandidateLifecycleOptions = {
    completionLedgerPath: resolved.completionLedgerPath,
    clock: resolved.clock,
  }
  const candidateLifecycle = createPersonalFeedV2CandidateLifecycle(candidateOptions)
  const coordinatorOptions: CreatePersonalFeedV2RequestCoordinatorOptions = {
    ledgerPath: requestLedgerPath,
    clock: resolved.clock,
    r4: resolved.r4,
    r2: lazyOwner,
    r3: candidateLifecycle,
    r5: CONSERVATIVE_R5,
  }
  const lifetime = createPersonalFeedTelegramInstallLifetime({
    coordinatorOptions,
    r2Shutdown: lazyOwner.shutdown,
  })
  const shutdown = (): Promise<void> => {
    if (publicShutdownPromise !== undefined) return publicShutdownPromise
    publicShutdownPromise = new Promise<void>((resolveValue, rejectValue) => {
      resolvePublicShutdown = resolveValue
      rejectPublicShutdown = rejectValue
    })
    void publicShutdownPromise.catch(() => undefined)
    try {
      const lifetimeShutdown = lifetime.shutdown()
      void lifetimeShutdown.then(
        () => { resolvePublicShutdown?.() },
        error => { rejectPublicShutdown?.(error) },
      )
    } catch {
      rejectPublicShutdown?.(new Error(CLEANUP_FAILURE_MESSAGE))
    }
    return publicShutdownPromise
  }
  return Object.freeze({ handler: lifetime.handler, shutdown })
}
