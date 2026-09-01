import { types as nodeTypes } from 'node:util'

const OPTION_KEYS = Object.freeze([
  'pythonFile',
  'observerCliPath',
  'totalBudgetMs',
  'cleanupReserveMs',
  'killGraceMs',
  'nowEpochMs',
  'spawn',
] as const)

const INPUT_KEYS = Object.freeze(['request', 'signal'] as const)
const REQUEST_KEYS = Object.freeze(['requestId', 'cutoff', 'shanghaiDay'] as const)
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1_000
const DAY_MS = 24 * 60 * 60 * 1_000
const OBSERVER_FAILED_LINE = '{"schemaVersion":1,"kind":"observer_failed"}\n'

type ErrorCode = 'aborted' | 'invalid_request' | 'insufficient_budget' | 'observer_failed' | 'protocol_invalid'

type ObserverError = Readonly<{
  readonly kind: 'error'
  readonly code: ErrorCode
}>

type ObserverRequest = Readonly<{
  readonly requestId: string
  readonly cutoff: string
  readonly shanghaiDay: string
}>

type ObserverOptions = Readonly<{
  readonly pythonFile: string
  readonly observerCliPath: string
  readonly totalBudgetMs: number
  readonly cleanupReserveMs: number
  readonly killGraceMs: number
  readonly nowEpochMs: () => number
  readonly spawn: (...args: unknown[]) => unknown
}>

type ObserverChild = Readonly<{
  readonly observe: (input: unknown) => Promise<ObserverError>
}>

type DataRecord = Readonly<Record<string, unknown>>

type ChildStream = Readonly<{
  readonly on: (event: string, listener: (...args: unknown[]) => void) => unknown
  readonly setEncoding?: (encoding: string) => unknown
}>

type ChildProcess = Readonly<{
  readonly stdin: Readonly<{
    readonly end: (...args: unknown[]) => unknown
  }>
  readonly stdout: ChildStream
  readonly stderr: ChildStream
  readonly on: (event: string, listener: (...args: unknown[]) => void) => unknown
}>

function frozenError(code: ErrorCode): ObserverError {
  return Object.freeze({ kind: 'error', code })
}

function exactDataRecord(value: unknown, keys: readonly string[]): DataRecord | undefined {
  if (value === null || typeof value !== 'object') return undefined

  try {
    if (nodeTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) return undefined

    const ownKeys = Reflect.ownKeys(value)
    if (ownKeys.length !== keys.length) return undefined

    const descriptors = Object.getOwnPropertyDescriptors(value)
    const allowed = new Set(keys)
    for (const key of ownKeys) {
      if (typeof key !== 'string' || !allowed.has(key)) return undefined
      const descriptor = descriptors[key]
      if (descriptor === undefined || descriptor.enumerable !== true || !('value' in descriptor)) return undefined
    }

    for (const key of keys) {
      const descriptor = descriptors[key]
      if (descriptor === undefined || descriptor.enumerable !== true || !('value' in descriptor)) return undefined
    }

    const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const key of keys) snapshot[key] = descriptors[key]?.value
    return snapshot
  } catch {
    return undefined
  }
}

function validPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('\u0000') && value.startsWith('/')
}

function validSafePositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isNowEpochMs(value: unknown): value is () => number {
  return typeof value === 'function'
}

function isSpawn(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === 'function'
}

function validRequestId(value: unknown): value is string {
  return typeof value === 'string'
    && /^telegram:(?:0|-[1-9]\d*|[1-9]\d*):(?:0|-[1-9]\d*|[1-9]\d*)$/.test(value)
}

function parseRequest(value: unknown): { readonly request: ObserverRequest; readonly cutoffEpochMs: number } | undefined {
  const record = exactDataRecord(value, REQUEST_KEYS)
  if (record === undefined) return undefined

  const requestId = record.requestId
  const cutoff = record.cutoff
  const shanghaiDay = record.shanghaiDay
  if (!validRequestId(requestId) || typeof cutoff !== 'string' || typeof shanghaiDay !== 'string') return undefined
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(cutoff)) return undefined
  if (!/^\d{4}-\d{2}-\d{2}$/.test(shanghaiDay)) return undefined

  const cutoffEpochMs = Date.parse(cutoff)
  if (!Number.isFinite(cutoffEpochMs)) return undefined
  try {
    if (new Date(cutoffEpochMs).toISOString() !== cutoff) return undefined
    const expectedShanghaiDay = new Date(cutoffEpochMs + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10)
    if (expectedShanghaiDay !== shanghaiDay) return undefined
  } catch {
    return undefined
  }

  return {
    request: { requestId, cutoff, shanghaiDay },
    cutoffEpochMs,
  }
}

function parseOptions(value: unknown): ObserverOptions {
  const record = exactDataRecord(value, OPTION_KEYS)
  if (record === undefined) throw new TypeError()

  const pythonFile = record.pythonFile
  const observerCliPath = record.observerCliPath
  const totalBudgetMs = record.totalBudgetMs
  const cleanupReserveMs = record.cleanupReserveMs
  const killGraceMs = record.killGraceMs
  const nowEpochMs = record.nowEpochMs
  const spawn = record.spawn
  if (!validPath(pythonFile) || !validPath(observerCliPath)) throw new TypeError()
  if (!validSafePositiveInteger(totalBudgetMs)
    || !validSafePositiveInteger(cleanupReserveMs)
    || !validSafePositiveInteger(killGraceMs)
    || !(totalBudgetMs > cleanupReserveMs && cleanupReserveMs > killGraceMs)) throw new TypeError()
  if (!isNowEpochMs(nowEpochMs) || !isSpawn(spawn)) throw new TypeError()

  return {
    pythonFile,
    observerCliPath,
    totalBudgetMs,
    cleanupReserveMs,
    killGraceMs,
    nowEpochMs,
    spawn,
  }
}

function observeChild(options: ObserverOptions, input: unknown): Promise<ObserverError> {
  const inputRecord = exactDataRecord(input, INPUT_KEYS)
  if (inputRecord === undefined) return Promise.resolve(frozenError('invalid_request'))

  const parsed = parseRequest(inputRecord.request)
  const signal = inputRecord.signal
  let realAbortSignal: AbortSignal
  try {
    if (nodeTypes.isProxy(signal) || !(signal instanceof AbortSignal)) return Promise.resolve(frozenError('invalid_request'))
    realAbortSignal = signal
  } catch {
    return Promise.resolve(frozenError('invalid_request'))
  }
  if (parsed === undefined) return Promise.resolve(frozenError('invalid_request'))

  let preAborted: boolean
  try {
    preAborted = realAbortSignal.aborted
  } catch {
    return Promise.resolve(frozenError('invalid_request'))
  }
  if (preAborted) return Promise.resolve(frozenError('aborted'))

  let snapshot: number
  try {
    snapshot = options.nowEpochMs()
  } catch {
    return Promise.resolve(frozenError('observer_failed'))
  }
  if (!Number.isFinite(snapshot)) return Promise.resolve(frozenError('observer_failed'))

  const cutoffEpochMs = parsed.cutoffEpochMs
  if (snapshot < cutoffEpochMs) return Promise.resolve(frozenError('invalid_request'))

  const nextShanghaiMidnight = Date.parse(`${parsed.request.shanghaiDay}T00:00:00.000Z`) - SHANGHAI_OFFSET_MS + DAY_MS
  const budgetEnd = Math.min(cutoffEpochMs + options.totalBudgetMs, nextShanghaiMidnight - 1)
  const deadlineEpochMs = budgetEnd - options.cleanupReserveMs
  if (!(cutoffEpochMs <= snapshot
    && snapshot < deadlineEpochMs
    && deadlineEpochMs < budgetEnd
    && deadlineEpochMs + options.killGraceMs < budgetEnd)) {
    return Promise.resolve(frozenError('insufficient_budget'))
  }

  const payload = `{"schemaVersion":1,"deadlineEpochMs":${deadlineEpochMs}}`
  let child: ChildProcess
  try {
    child = options.spawn(
      options.pythonFile,
      [options.observerCliPath],
      { shell: false, stdio: ['pipe', 'pipe', 'pipe'] },
    ) as ChildProcess
  } catch {
    return Promise.resolve(frozenError('observer_failed'))
  }

  return new Promise<ObserverError>((resolve) => {
    let settled = false
    let streamFailed = false
    let stdout = ''
    const finish = (): void => {
      if (settled) return
      settled = true
      if (streamFailed) {
        resolve(frozenError('observer_failed'))
      } else if (stdout === OBSERVER_FAILED_LINE) {
        resolve(frozenError('observer_failed'))
      } else {
        resolve(frozenError('protocol_invalid'))
      }
    }
    const collectStdout = (chunk: unknown): void => {
      if (typeof chunk === 'string') {
        stdout += chunk
      } else if (chunk instanceof Uint8Array) {
        stdout += new TextDecoder().decode(chunk)
      } else {
        streamFailed = true
      }
    }
    const markStreamFailure = (): void => {
      streamFailed = true
    }

    try {
      child.stdout.setEncoding?.('utf8')
      child.stderr.setEncoding?.('utf8')
      child.stdout.on('data', collectStdout)
      child.stderr.on('data', () => undefined)
      child.stdout.on('error', markStreamFailure)
      child.stderr.on('error', markStreamFailure)
      child.on('error', markStreamFailure)
      child.on('close', finish)
      child.stdin.end(payload, 'utf8', (error?: unknown) => {
        if (error !== undefined) streamFailed = true
      })
    } catch {
      streamFailed = true
    }
  })
}

export function createPersonalFeedXObserverChild(options: unknown): ObserverChild {
  const parsedOptions = parseOptions(options)
  return Object.freeze({
    observe: (input: unknown): Promise<ObserverError> => observeChild(parsedOptions, input),
  })
}
