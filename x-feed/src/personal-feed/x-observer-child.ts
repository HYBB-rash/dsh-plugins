import { types as nodeTypes } from 'node:util'

const OPTION_KEYS = Object.freeze([
  'pythonFile',
  'observerCliPath',
  'totalBudgetMs',
  'cleanupReserveMs',
  'killGraceMs',
  'nowEpochMs',
  'spawn',
  'setTimeout',
  'clearTimeout',
] as const)

const INPUT_KEYS = Object.freeze(['request', 'signal'] as const)
const REQUEST_KEYS = Object.freeze(['requestId', 'cutoff', 'shanghaiDay'] as const)
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1_000
const DAY_MS = 24 * 60 * 60 * 1_000
const STDOUT_MAX_BYTES = 1_048_576
const STDERR_MAX_BYTES = 4_096
const OBSERVER_FAILED_LINE = '{"schemaVersion":1,"kind":"observer_failed"}\n'

type StrictByteChunk = Readonly<
  | { readonly kind: 'snapshot'; readonly bytes: Uint8Array; readonly byteLength: number }
  | { readonly kind: 'overflow' }
  | { readonly kind: 'failed' }
>

type IntrinsicGetter = (target: object) => unknown
type IntrinsicSet = (target: object, source: object) => unknown

const BYTE_CHUNK_INTRINSICS = (() => {
  let localUint8Array: typeof Uint8Array | undefined
  let reflectApply: typeof Reflect.apply | undefined
  let typedArrayByteLengthGetter: IntrinsicGetter | undefined
  let typedArrayBufferGetter: IntrinsicGetter | undefined
  let typedArraySet: IntrinsicSet | undefined
  let arrayBufferByteLengthGetter: IntrinsicGetter | undefined
  let arrayBufferResizableGetter: IntrinsicGetter | undefined
  let arrayBufferDetachedGetter: IntrinsicGetter | undefined
  try {
    localUint8Array = typeof Uint8Array === 'function' ? Uint8Array : undefined
    reflectApply = typeof Reflect === 'object' && typeof Reflect.apply === 'function' ? Reflect.apply : undefined
    if (localUint8Array !== undefined) {
      const typedArrayPrototype = Object.getPrototypeOf(localUint8Array.prototype)
      typedArrayByteLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')?.get
      typedArrayBufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')?.get
      typedArraySet = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'set')?.value
    }
    if (typeof ArrayBuffer === 'function') {
      const arrayBufferPrototype = ArrayBuffer.prototype
      arrayBufferByteLengthGetter = Object.getOwnPropertyDescriptor(arrayBufferPrototype, 'byteLength')?.get
      arrayBufferResizableGetter = Object.getOwnPropertyDescriptor(arrayBufferPrototype, 'resizable')?.get
      arrayBufferDetachedGetter = Object.getOwnPropertyDescriptor(arrayBufferPrototype, 'detached')?.get
    }
  } catch {
    // Missing or malformed intrinsics make strictByteChunk fail closed.
  }
  return Object.freeze({
    localUint8Array,
    reflectApply,
    typedArrayByteLengthGetter,
    typedArrayBufferGetter,
    typedArraySet,
    arrayBufferByteLengthGetter,
    arrayBufferResizableGetter,
    arrayBufferDetachedGetter,
  })
})()

function strictByteChunk(value: unknown, maxByteLength: number): StrictByteChunk {
  if (!Number.isSafeInteger(maxByteLength) || maxByteLength < 0) return { kind: 'failed' }

  const {
    localUint8Array,
    reflectApply,
    typedArrayByteLengthGetter,
    typedArrayBufferGetter,
    typedArraySet,
    arrayBufferByteLengthGetter,
    arrayBufferResizableGetter,
    arrayBufferDetachedGetter,
  } = BYTE_CHUNK_INTRINSICS
  if (localUint8Array === undefined || reflectApply === undefined
    || typedArrayByteLengthGetter === undefined || typedArrayBufferGetter === undefined || typedArraySet === undefined
    || arrayBufferByteLengthGetter === undefined || arrayBufferResizableGetter === undefined
    || arrayBufferDetachedGetter === undefined) return { kind: 'failed' }

  let branded = false
  try {
    branded = nodeTypes.isUint8Array(value)
  } catch {
    return { kind: 'failed' }
  }
  if (!branded || (typeof value !== 'object' && typeof value !== 'function') || value === null) {
    return { kind: 'failed' }
  }

  let byteLength: unknown
  let owner: unknown
  try {
    byteLength = reflectApply(typedArrayByteLengthGetter, value, [])
    owner = reflectApply(typedArrayBufferGetter, value, [])
  } catch {
    return { kind: 'failed' }
  }
  if (typeof byteLength !== 'number' || !Number.isSafeInteger(byteLength) || byteLength < 0) {
    return { kind: 'failed' }
  }

  let ownerIsArrayBuffer = false
  try {
    ownerIsArrayBuffer = nodeTypes.isArrayBuffer(owner)
  } catch {
    return { kind: 'failed' }
  }
  if (!ownerIsArrayBuffer || owner === null || (typeof owner !== 'object' && typeof owner !== 'function')) {
    return { kind: 'failed' }
  }

  let ownerByteLength: unknown
  let ownerResizable: unknown
  let ownerDetached: unknown
  try {
    ownerByteLength = reflectApply(arrayBufferByteLengthGetter, owner, [])
    ownerResizable = reflectApply(arrayBufferResizableGetter, owner, [])
    ownerDetached = reflectApply(arrayBufferDetachedGetter, owner, [])
  } catch {
    return { kind: 'failed' }
  }
  if (typeof ownerByteLength !== 'number' || !Number.isSafeInteger(ownerByteLength) || ownerByteLength < 0
    || ownerResizable !== false || ownerDetached !== false || byteLength > ownerByteLength) {
    return { kind: 'failed' }
  }

  if (byteLength > maxByteLength) return { kind: 'overflow' }

  let snapshot: Uint8Array
  try {
    snapshot = new localUint8Array(byteLength)
    reflectApply(typedArraySet, snapshot, [value])
  } catch {
    return { kind: 'failed' }
  }

  let snapshotByteLength: unknown
  try {
    snapshotByteLength = reflectApply(typedArrayByteLengthGetter, snapshot, [])
  } catch {
    return { kind: 'failed' }
  }
  if (snapshotByteLength !== byteLength) return { kind: 'failed' }
  return { kind: 'snapshot', bytes: snapshot, byteLength }
}

type ErrorCode = 'aborted' | 'invalid_request' | 'child_invalid_input' | 'insufficient_budget' | 'observer_failed' | 'protocol_invalid' | 'timed_out'

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
  readonly setTimeout: (callback: () => void, delayMs: number) => unknown
  readonly clearTimeout: (handle: unknown) => void
}>

type ObserverChild = Readonly<{
  readonly observe: (input: unknown) => Promise<ObserverResult>
}>

type DataRecord = Readonly<Record<string, unknown>>

type ObserverBody = Readonly<
  | { readonly kind: 'sufficient'; readonly text: string }
  | { readonly kind: 'insufficient'; readonly reason: 'placeholder' | 'empty' | 'too_large' | 'show_more_failed' }
>

type ObserverOccurrence = Readonly<{
  readonly sourceUrl: string
  readonly body: ObserverBody
  readonly occurrenceOrdinal: number
  readonly capturedAt: string
  readonly authorHandle: string
  readonly publishedAt: string
}>

type CompleteSurface = Readonly<{
  readonly kind: 'complete' | 'natural_zero'
  readonly surface: 'for_you' | 'following' | 'explore'
  readonly surfaceOrdinal: number
  readonly startedAt: string
  readonly completedAt: string
  readonly occurrences: readonly ObserverOccurrence[]
}>

type IncompleteSurface = Readonly<{
  readonly kind: 'complete' | 'natural_zero' | 'partial' | 'failed' | 'unknown'
  readonly surface: 'for_you' | 'following' | 'explore'
  readonly surfaceOrdinal: number
}>

type ObserverComplete = Readonly<{
  readonly schemaVersion: 1
  readonly kind: 'complete'
  readonly startedAt: string
  readonly completedAt: string
  readonly surfaces: readonly CompleteSurface[]
}>

type ObserverIncomplete = Readonly<{
  readonly schemaVersion: 1
  readonly kind: 'incomplete'
  readonly startedAt: string
  readonly completedAt: string
  readonly surfaces: readonly IncompleteSurface[]
}>

type ObserverResult = ObserverError | ObserverComplete | ObserverIncomplete

type ChildStream = Readonly<{
  readonly on: (event: string, listener: (...args: unknown[]) => void) => unknown
}>

type ChildProcess = Readonly<{
  readonly stdin: Readonly<{
    readonly end: (...args: unknown[]) => unknown
  }>
  readonly stdout: ChildStream
  readonly stderr: ChildStream
  readonly on: (event: string, listener: (...args: unknown[]) => void) => unknown
  readonly kill: (signal: 'SIGTERM' | 'SIGKILL') => unknown
}>

function frozenError(code: ErrorCode): ObserverError {
  return Object.freeze({ kind: 'error', code })
}

function exactDataRecord(value: unknown, keys: readonly string[]): DataRecord | undefined {
  if (value === null || typeof value !== 'object') return undefined

  try {
    const prototype = Object.getPrototypeOf(value)
    if (nodeTypes.isProxy(value) || (prototype !== Object.prototype && prototype !== null)) return undefined

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

function exactDataArray(value: unknown): readonly unknown[] | undefined {
  try {
    if (!Array.isArray(value)) return undefined
    if (nodeTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const ownKeys = Reflect.ownKeys(value)
    if (ownKeys.length !== value.length + 1) return undefined
    const lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, 'length')
    if (lengthDescriptor === undefined || lengthDescriptor.enumerable !== false || !('value' in lengthDescriptor)
      || lengthDescriptor.value !== value.length) return undefined

    for (const key of ownKeys) {
      if (key === 'length') continue
      if (typeof key !== 'string' || !/^\d+$/.test(key)) return undefined
      const index = Number(key)
      if (!Number.isSafeInteger(index) || index < 0 || index >= value.length || String(index) !== key) return undefined
      const descriptor = descriptors[key]
      if (descriptor === undefined || descriptor.enumerable !== true || !('value' in descriptor)) return undefined
    }
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)]
      if (descriptor === undefined || descriptor.enumerable !== true || !('value' in descriptor)) return undefined
    }
    return value
  } catch {
    return undefined
  }
}

function validUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false
    }
  }
  return true
}

const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

function parseCanonicalTimestamp(value: unknown): number | undefined {
  if (typeof value !== 'string' || !validUnicode(value) || !CANONICAL_TIMESTAMP.test(value)) return undefined
  const epochMs = Date.parse(value)
  if (!Number.isFinite(epochMs)) return undefined
  try {
    return new Date(epochMs).toISOString() === value ? epochMs : undefined
  } catch {
    return undefined
  }
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function parseBody(value: unknown): ObserverBody | undefined {
  const sufficient = exactDataRecord(value, ['kind', 'text'])
  if (sufficient !== undefined && sufficient.kind === 'sufficient'
    && typeof sufficient.text === 'string' && validUnicode(sufficient.text)
    && sufficient.text.trim().length > 0 && utf8ByteLength(sufficient.text) <= 6_144) {
    return Object.freeze({ kind: 'sufficient', text: sufficient.text })
  }

  const insufficient = exactDataRecord(value, ['kind', 'reason'])
  const reason = insufficient?.reason
  if (insufficient !== undefined && insufficient.kind === 'insufficient'
    && (reason === 'placeholder' || reason === 'empty' || reason === 'too_large' || reason === 'show_more_failed')) {
    return Object.freeze({ kind: 'insufficient', reason })
  }
  return undefined
}

function parseOccurrence(
  value: unknown,
  occurrenceOrdinal: number,
  surfaceStartedEpochMs: number,
  surfaceCompletedEpochMs: number,
  cutoffEpochMs: number,
  deadlineEpochMs: number,
): ObserverOccurrence | undefined {
  const record = exactDataRecord(value, ['sourceUrl', 'body', 'occurrenceOrdinal', 'capturedAt', 'authorHandle', 'publishedAt'])
  if (record === undefined || record.occurrenceOrdinal !== occurrenceOrdinal || !validSafeNonNegativeInteger(record.occurrenceOrdinal)) return undefined
  const sourceUrl = record.sourceUrl
  const authorHandle = record.authorHandle
  const capturedAt = record.capturedAt
  const publishedAt = record.publishedAt
  if (typeof sourceUrl !== 'string' || typeof authorHandle !== 'string'
    || typeof capturedAt !== 'string' || typeof publishedAt !== 'string'
    || !validUnicode(sourceUrl) || !validUnicode(authorHandle)) return undefined
  if (utf8ByteLength(sourceUrl) > 512) return undefined
  const urlMatch = /^https:\/\/x\.com\/([a-z0-9_]{1,15})\/status\/([1-9]\d*)$/.exec(sourceUrl)
  if (urlMatch === null || authorHandle !== urlMatch[1]) return undefined
  const capturedEpochMs = parseCanonicalTimestamp(capturedAt)
  if (capturedEpochMs === undefined || capturedEpochMs < cutoffEpochMs || capturedEpochMs >= deadlineEpochMs
    || capturedEpochMs < surfaceStartedEpochMs || capturedEpochMs >= surfaceCompletedEpochMs) return undefined
  if (parseCanonicalTimestamp(publishedAt) === undefined) return undefined
  const body = parseBody(record.body)
  if (body === undefined) return undefined
  return Object.freeze({
    sourceUrl,
    body,
    occurrenceOrdinal,
    capturedAt,
    authorHandle,
    publishedAt,
  })
}

function validSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

const SURFACES = Object.freeze(['for_you', 'following', 'explore'] as const)
const INCOMPLETE_KINDS = Object.freeze(['complete', 'natural_zero', 'partial', 'failed', 'unknown'] as const)

function parseCompleteResult(
  value: DataRecord,
  cutoffEpochMs: number,
  deadlineEpochMs: number,
): ObserverComplete | undefined {
  if (value.schemaVersion !== 1 || value.kind !== 'complete') return undefined
  const startedAt = value.startedAt
  const completedAt = value.completedAt
  if (typeof startedAt !== 'string' || typeof completedAt !== 'string') return undefined
  const startedEpochMs = parseCanonicalTimestamp(startedAt)
  const completedEpochMs = parseCanonicalTimestamp(completedAt)
  if (startedEpochMs === undefined || completedEpochMs === undefined
    || startedEpochMs < cutoffEpochMs || startedEpochMs >= deadlineEpochMs
    || completedEpochMs < startedEpochMs || completedEpochMs >= deadlineEpochMs) return undefined
  const surfacesInput = exactDataArray(value.surfaces)
  if (surfacesInput === undefined || surfacesInput.length !== 3) return undefined

  const surfaces: CompleteSurface[] = []
  let totalOccurrences = 0
  let previousCompletedEpochMs = cutoffEpochMs
  for (let index = 0; index < surfacesInput.length; index += 1) {
    const surfaceRecord = exactDataRecord(surfacesInput[index], ['kind', 'surface', 'surfaceOrdinal', 'startedAt', 'completedAt', 'occurrences'])
    const expectedSurface = SURFACES[index]
    if (surfaceRecord === undefined || expectedSurface === undefined
      || (surfaceRecord.kind !== 'complete' && surfaceRecord.kind !== 'natural_zero')
      || surfaceRecord.surface !== expectedSurface || surfaceRecord.surfaceOrdinal !== index
      || !validSafeNonNegativeInteger(surfaceRecord.surfaceOrdinal)) return undefined
    const surfaceStartedAt = surfaceRecord.startedAt
    const surfaceCompletedAt = surfaceRecord.completedAt
    if (typeof surfaceStartedAt !== 'string' || typeof surfaceCompletedAt !== 'string') return undefined
    const faceStartedEpochMs = parseCanonicalTimestamp(surfaceStartedAt)
    const faceCompletedEpochMs = parseCanonicalTimestamp(surfaceCompletedAt)
    if (faceStartedEpochMs === undefined || faceCompletedEpochMs === undefined
      || faceStartedEpochMs < cutoffEpochMs || faceStartedEpochMs >= deadlineEpochMs
      || faceCompletedEpochMs <= faceStartedEpochMs || faceCompletedEpochMs >= deadlineEpochMs
      || faceStartedEpochMs < previousCompletedEpochMs
      || (index === 0 && faceStartedEpochMs < startedEpochMs)
      || (index === surfacesInput.length - 1 && faceCompletedEpochMs > completedEpochMs)) return undefined
    const occurrencesInput = exactDataArray(surfaceRecord.occurrences)
    if (occurrencesInput === undefined || occurrencesInput.length > 8
      || (surfaceRecord.kind === 'natural_zero' && occurrencesInput.length !== 0)
      || (surfaceRecord.kind === 'complete' && occurrencesInput.length === 0)) return undefined
    const occurrences: ObserverOccurrence[] = []
    for (let occurrenceOrdinal = 0; occurrenceOrdinal < occurrencesInput.length; occurrenceOrdinal += 1) {
      const occurrenceValue = parseOccurrence(
        occurrencesInput[occurrenceOrdinal],
        occurrenceOrdinal,
        faceStartedEpochMs,
        faceCompletedEpochMs,
        cutoffEpochMs,
        deadlineEpochMs,
      )
      if (occurrenceValue === undefined) return undefined
      occurrences.push(occurrenceValue)
    }
    totalOccurrences += occurrences.length
    if (totalOccurrences > 24) return undefined
    surfaces.push(Object.freeze({
      kind: surfaceRecord.kind,
      surface: expectedSurface,
      surfaceOrdinal: index,
      startedAt: surfaceStartedAt,
      completedAt: surfaceCompletedAt,
      occurrences: Object.freeze(occurrences),
    }))
    previousCompletedEpochMs = faceCompletedEpochMs
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: 'complete',
    startedAt,
    completedAt,
    surfaces: Object.freeze(surfaces),
  })
}

function parseIncompleteResult(
  value: DataRecord,
  cutoffEpochMs: number,
  deadlineEpochMs: number,
  budgetEndEpochMs: number,
): ObserverIncomplete | undefined {
  if (value.schemaVersion !== 1 || value.kind !== 'incomplete') return undefined
  const startedAt = value.startedAt
  const completedAt = value.completedAt
  if (typeof startedAt !== 'string' || typeof completedAt !== 'string') return undefined
  const startedEpochMs = parseCanonicalTimestamp(startedAt)
  const completedEpochMs = parseCanonicalTimestamp(completedAt)
  if (startedEpochMs === undefined || completedEpochMs === undefined
    || startedEpochMs < cutoffEpochMs || startedEpochMs >= deadlineEpochMs
    || completedEpochMs < startedEpochMs || completedEpochMs >= budgetEndEpochMs) return undefined
  const surfacesInput = exactDataArray(value.surfaces)
  if (surfacesInput === undefined || surfacesInput.length !== 3) return undefined
  const surfaces: IncompleteSurface[] = []
  for (let index = 0; index < surfacesInput.length; index += 1) {
    const surfaceRecord = exactDataRecord(surfacesInput[index], ['surface', 'surfaceOrdinal', 'kind'])
    const expectedSurface = SURFACES[index]
    if (surfaceRecord === undefined || expectedSurface === undefined || surfaceRecord.surface !== expectedSurface
      || surfaceRecord.surfaceOrdinal !== index || !validSafeNonNegativeInteger(surfaceRecord.surfaceOrdinal)
      || !INCOMPLETE_KINDS.includes(surfaceRecord.kind as typeof INCOMPLETE_KINDS[number])) return undefined
    surfaces.push(Object.freeze({
      surface: expectedSurface,
      surfaceOrdinal: index,
      kind: surfaceRecord.kind as IncompleteSurface['kind'],
    }))
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: 'incomplete',
    startedAt,
    completedAt,
    surfaces: Object.freeze(surfaces),
  })
}

function parseObserverResult(
  stdout: string,
  cutoffEpochMs: number,
  deadlineEpochMs: number,
  budgetEndEpochMs: number,
): ObserverResult {
  if (stdout === OBSERVER_FAILED_LINE) return frozenError('observer_failed')
  let decoded: unknown
  try {
    decoded = JSON.parse(stdout) as unknown
  } catch {
    return frozenError('protocol_invalid')
  }
  const record = exactDataRecord(decoded, ['schemaVersion', 'kind'])
  if (record !== undefined && record.schemaVersion === 1 && record.kind === 'invalid_input') {
    return frozenError('child_invalid_input')
  }
  if (record !== undefined && record.schemaVersion === 1 && record.kind === 'observer_failed') {
    return frozenError('observer_failed')
  }
  const resultRecord = exactDataRecord(decoded, ['schemaVersion', 'kind', 'startedAt', 'completedAt', 'surfaces'])
  if (resultRecord === undefined) return frozenError('protocol_invalid')
  const complete = parseCompleteResult(resultRecord, cutoffEpochMs, deadlineEpochMs)
  if (complete !== undefined) return complete
  const incomplete = parseIncompleteResult(resultRecord, cutoffEpochMs, deadlineEpochMs, budgetEndEpochMs)
  if (incomplete !== undefined) return incomplete
  return frozenError('protocol_invalid')
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

function isSetTimeout(value: unknown): value is (callback: () => void, delayMs: number) => unknown {
  return typeof value === 'function'
}

function isClearTimeout(value: unknown): value is (handle: unknown) => void {
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
  const setTimeout = record.setTimeout
  const clearTimeout = record.clearTimeout
  if (!validPath(pythonFile) || !validPath(observerCliPath)) throw new TypeError()
  if (!validSafePositiveInteger(totalBudgetMs)
    || !validSafePositiveInteger(cleanupReserveMs)
    || !validSafePositiveInteger(killGraceMs)
    || !(totalBudgetMs > cleanupReserveMs && cleanupReserveMs > killGraceMs)) throw new TypeError()
  if (!isNowEpochMs(nowEpochMs) || !isSpawn(spawn)
    || !isSetTimeout(setTimeout) || !isClearTimeout(clearTimeout)) throw new TypeError()

  return {
    pythonFile,
    observerCliPath,
    totalBudgetMs,
    cleanupReserveMs,
    killGraceMs,
    nowEpochMs,
    spawn,
    setTimeout,
    clearTimeout,
  }
}

function observeChild(options: ObserverOptions, input: unknown): Promise<ObserverResult> {
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

  return new Promise<ObserverResult>((resolve) => {
    type TimerSlot = {
      generation: number
      active: boolean
      handle: unknown
    }

    let settled = false
    let closed = false
    let firstReason: ErrorCode | undefined
    let stdout = ''
    const stdoutDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
    const stderrDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
    let stdoutRawBytes = 0
    let stderrRawBytes = 0
    let stdoutFirstByteSeen = false
    let stdoutSawLf = false
    let stdoutLastByte: number | undefined
    const deadlineSlot: TimerSlot = { generation: 0, active: false, handle: undefined }
    const budgetSlot: TimerSlot = { generation: 0, active: false, handle: undefined }
    const graceSlot: TimerSlot = { generation: 0, active: false, handle: undefined }
    let abortOwnership: 'none' | 'adding' | 'installed' | 'removed' = 'none'
    let termAttempted = false
    let graceKillAttempted = false
    let graceConsumed = false
    let budgetKillAttempted = false

    const safeKill = (signalToSend: 'SIGTERM' | 'SIGKILL'): void => {
      try {
        child.kill(signalToSend)
      } catch {
        // A kill failure cannot prove that the child exited; close remains authoritative.
      }
    }

    const cancelTimer = (slot: TimerSlot): void => {
      const wasActive = slot.active
      const handle = slot.handle
      slot.generation += 1
      slot.active = false
      slot.handle = undefined
      if (!wasActive) return
      try {
        options.clearTimeout(handle)
      } catch {
        // Logical cancellation remains in force when clearTimeout throws.
      }
    }

    const armTimer = (slot: TimerSlot, callback: () => void, delayMs: number): boolean => {
      cancelTimer(slot)
      const token = slot.generation + 1
      slot.generation = token
      slot.active = true
      slot.handle = undefined
      let callbackEntered = false
      try {
        const handle = options.setTimeout(() => {
          callbackEntered = true
          if (slot.generation !== token || !slot.active) return
          slot.active = false
          slot.handle = undefined
          if (closed || settled) return
          callback()
        }, delayMs)
        if (callbackEntered || closed || !slot.active || slot.generation !== token) {
          try {
            options.clearTimeout(handle)
          } catch {
            // Best-effort cleanup only.
          }
          return true
        }
        slot.handle = handle
        return true
      } catch {
        if (callbackEntered || closed || !slot.active || slot.generation !== token) return true
        slot.generation += 1
        slot.active = false
        slot.handle = undefined
        return false
      }
    }

    const attemptTerm = (): void => {
      if (closed || termAttempted) return
      termAttempted = true
      safeKill('SIGTERM')
    }

    const attemptGraceKill = (): void => {
      if (closed || graceKillAttempted || graceConsumed) return
      graceConsumed = true
      graceKillAttempted = true
      safeKill('SIGKILL')
    }

    const scheduleGrace = (): void => {
      if (closed || graceConsumed || graceKillAttempted || graceSlot.active) return
      const registered = armTimer(graceSlot, onGrace, options.killGraceMs)
      if (!registered && !closed && !graceConsumed && !graceKillAttempted) attemptGraceKill()
    }

    const attemptBudgetKill = (): void => {
      if (closed || budgetKillAttempted) return
      budgetKillAttempted = true
      safeKill('SIGKILL')
    }

    const lockFirstReason = (reason: ErrorCode): void => {
      if (closed || firstReason !== undefined) return
      firstReason = reason
      stdout = ''
      cancelTimer(deadlineSlot)
      attemptTerm()
      if (!closed) scheduleGrace()
    }

    function onAbort(): void {
      if (closed) return
      lockFirstReason('aborted')
    }

    const collectStdout = (chunk: unknown): void => {
      if (closed || firstReason !== undefined) return

      const byteChunk = strictByteChunk(chunk, STDOUT_MAX_BYTES - stdoutRawBytes)
      if (byteChunk.kind === 'failed') {
        lockFirstReason('observer_failed')
        return
      }
      if (byteChunk.kind === 'overflow') {
        lockFirstReason('protocol_invalid')
        return
      }
      const { bytes, byteLength } = byteChunk

      try {
        for (let index = 0; index < byteLength; index += 1) {
          const byte = bytes[index]
          if (byte === undefined || !Number.isInteger(byte) || byte < 0 || byte > 0xff) throw new Error()
          if (!stdoutFirstByteSeen) {
            stdoutFirstByteSeen = true
            if (byte !== 0x7b) {
              lockFirstReason('protocol_invalid')
              return
            }
          }
          if (stdoutSawLf || byte === 0x0d) {
            lockFirstReason('protocol_invalid')
            return
          }
          if (byte === 0x0a) {
            if (stdoutLastByte !== 0x7d) {
              lockFirstReason('protocol_invalid')
              return
            }
            stdoutSawLf = true
            if (index !== byteLength - 1) {
              lockFirstReason('protocol_invalid')
              return
            }
          }
          stdoutLastByte = byte
        }
        stdoutRawBytes += byteLength
      } catch {
        lockFirstReason('observer_failed')
        return
      }

      try {
        stdout += stdoutDecoder.decode(bytes, { stream: true })
      } catch {
        lockFirstReason('protocol_invalid')
      }
    }

    const collectStderr = (chunk: unknown): void => {
      if (closed || firstReason !== undefined) return

      const byteChunk = strictByteChunk(chunk, STDERR_MAX_BYTES - stderrRawBytes)
      if (byteChunk.kind === 'failed' || byteChunk.kind === 'overflow') {
        lockFirstReason('observer_failed')
        return
      }
      const { bytes, byteLength } = byteChunk

      try {
        stderrDecoder.decode(bytes, { stream: true })
        stderrRawBytes += byteLength
      } catch {
        lockFirstReason('observer_failed')
      }
    }
    const markStreamFailure = (): void => {
      if (closed) return
      lockFirstReason('observer_failed')
    }
    const consumeGraceForBudget = (): void => {
      cancelTimer(graceSlot)
      graceConsumed = true
    }

    const failWithoutBudgetTimer = (): void => {
      if (!closed && firstReason === undefined) {
        firstReason = 'observer_failed'
        stdout = ''
      }
      cancelTimer(deadlineSlot)
      cancelTimer(graceSlot)
      cancelTimer(budgetSlot)
      attemptTerm()
      if (!closed) attemptBudgetKill()
    }

    function onGrace(): void {
      if (closed) return
      attemptGraceKill()
    }

    const onDeadline = (): void => {
      if (closed) return
      lockFirstReason('timed_out')
    }

    const onBudget = (): void => {
      if (closed) return
      budgetKillAttempted = true
      consumeGraceForBudget()
      if (firstReason === undefined) lockFirstReason('timed_out')
      else attemptTerm()
      if (!closed) safeKill('SIGKILL')
    }

    const cleanup = (): void => {
      cancelTimer(deadlineSlot)
      cancelTimer(graceSlot)
      cancelTimer(budgetSlot)
      if (abortOwnership === 'adding' || abortOwnership === 'installed') {
        abortOwnership = 'removed'
        try {
          realAbortSignal.removeEventListener('abort', onAbort)
        } catch {
          // Marked removed before the call so a throwing removal cannot leak ownership.
        }
      }
    }

    const onClose = (code?: unknown, signalToReport?: unknown): void => {
      if (closed || settled) return
      closed = true
      settled = true
      let result: ObserverResult
      if (firstReason !== undefined) {
        result = frozenError(firstReason)
      } else {
        let finalizationReason: ErrorCode | undefined
        try {
          stdout += stdoutDecoder.decode()
        } catch {
          finalizationReason = 'protocol_invalid'
        }
        try {
          stderrDecoder.decode()
        } catch {
          if (finalizationReason === undefined) finalizationReason = 'observer_failed'
        }

        if (finalizationReason !== undefined) {
          result = frozenError(finalizationReason)
        } else if (code !== 0 || signalToReport !== null) {
          result = frozenError('observer_failed')
        } else if (!stdoutFirstByteSeen || stdoutRawBytes <= 1 || !stdoutSawLf) {
          result = frozenError('protocol_invalid')
        } else {
          try {
            result = parseObserverResult(stdout, cutoffEpochMs, deadlineEpochMs, budgetEnd)
          } catch {
            result = frozenError('observer_failed')
          }
        }
      }
      cleanup()
      resolve(result)
    }

    let closeGateInstalled = false
    try {
      // Install close first so every post-spawn failure still has a close gate.
      child.on('close', onClose)
      closeGateInstalled = true
    } catch {
      if (firstReason === undefined) {
        firstReason = 'observer_failed'
        stdout = ''
      }
      attemptTerm()
      if (!closed) attemptBudgetKill()
      return
    }

    if (!closeGateInstalled) return

    try {

      if (!closed) {
        const budgetArmed = armTimer(budgetSlot, onBudget, budgetEnd - snapshot)
        if (!budgetArmed) {
          failWithoutBudgetTimer()
          return
        }
      }

      if (!closed && firstReason === undefined) {
        const deadlineArmed = armTimer(deadlineSlot, onDeadline, deadlineEpochMs - snapshot)
        if (!deadlineArmed) lockFirstReason('observer_failed')
      }

      if (!closed) {
        abortOwnership = 'adding'
        try {
          realAbortSignal.addEventListener('abort', onAbort, { once: true })
          if (abortOwnership === 'adding') abortOwnership = 'installed'
        } catch {
          lockFirstReason('observer_failed')
        }
      }

      // The child can abort synchronously inside spawn, before the listener existed.
      let abortedAfterRegistration = false
      if (!closed) {
        try {
          abortedAfterRegistration = realAbortSignal.aborted
        } catch {
          lockFirstReason('observer_failed')
        }
      }
      if (abortedAfterRegistration) onAbort()

      if (!closed) {
        child.stdout.on('data', collectStdout)
        child.stderr.on('data', collectStderr)
        child.stdout.on('error', markStreamFailure)
        child.stderr.on('error', markStreamFailure)
        child.on('error', markStreamFailure)
      }

      if (!closed) child.stdin.end(payload, 'utf8', (error?: unknown) => {
        if (error !== undefined) lockFirstReason('observer_failed')
      })
    } catch {
      lockFirstReason('observer_failed')
    }
  })
}

export function createPersonalFeedXObserverChild(options: unknown): ObserverChild {
  const parsedOptions = parseOptions(options)
  return Object.freeze({
    observe: (input: unknown): Promise<ObserverResult> => observeChild(parsedOptions, input),
  })
}
