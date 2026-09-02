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
const RESULT_KEYS = Object.freeze(['schemaVersion', 'kind', 'requestId', 'cutoff', 'shanghaiDay', 'startedAt', 'completedAt', 'surfaces'] as const)
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

function captureByteChunkIntrinsics() {
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
}

const BYTE_CHUNK_INTRINSICS = captureByteChunkIntrinsics()

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

type ObserverOwner = Readonly<{
  readonly observe: (input: unknown) => Promise<ObserverResult>
  readonly shutdown: () => Promise<void>
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
  readonly requestId: string
  readonly cutoff: string
  readonly shanghaiDay: string
  readonly startedAt: string
  readonly completedAt: string
  readonly surfaces: readonly CompleteSurface[]
}>

type ObserverIncomplete = Readonly<{
  readonly schemaVersion: 1
  readonly kind: 'incomplete'
  readonly requestId: string
  readonly cutoff: string
  readonly shanghaiDay: string
  readonly startedAt: string
  readonly completedAt: string
  readonly surfaces: readonly IncompleteSurface[]
}>

type ObserverResult = ObserverError | ObserverComplete | ObserverIncomplete

type ChildStream = Readonly<{
  readonly on: (event: string, listener: (...args: unknown[]) => void) => unknown
  readonly removeListener?: (event: string, listener: (...args: unknown[]) => void) => unknown
  readonly destroy?: () => unknown
}>

type ChildProcess = Readonly<{
  readonly pid?: unknown
  readonly stdin: Readonly<{
    readonly end: (...args: unknown[]) => unknown
    readonly destroy?: () => unknown
  }>
  readonly stdout: ChildStream
  readonly stderr: ChildStream
  readonly on: (event: string, listener: (...args: unknown[]) => void) => unknown
  readonly removeListener?: (event: string, listener: (...args: unknown[]) => void) => unknown
  readonly kill: (signal: 'SIGTERM' | 'SIGKILL') => unknown
}>

type ObserverOwnerHooks = Readonly<{
  readonly reserve: () => symbol
  readonly release: (token: symbol) => void
  readonly poison: () => void
  readonly quarantine: (token: symbol) => void
  readonly reaped: (token: symbol) => void
}>

type CapturedListenerOps = Readonly<{
  readonly target: object
  readonly on: ((...args: unknown[]) => unknown) | undefined
  readonly removeListener: ((...args: unknown[]) => unknown) | undefined
  readonly listenerCount: ((...args: unknown[]) => unknown) | undefined
  readonly destroy: ((...args: unknown[]) => unknown) | undefined
  readonly baselines: ReadonlyMap<string, number | undefined>
}>

type BusinessListenerState = 'absent' | 'maybe-installed' | 'installed'
type DrainListenerState = 'not-attempted' | 'maybe-installed' | 'verified-installed' | 'absent'

function drainLateStreamError(): void {
  // Keep a harmless error listener while a handed-off stream awaits close.
}

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

function matchesRequestIdentity(value: DataRecord, request: ObserverRequest): boolean {
  return value.requestId === request.requestId
    && value.cutoff === request.cutoff
    && value.shanghaiDay === request.shanghaiDay
}

function parseCompleteResult(
  value: DataRecord,
  request: ObserverRequest,
  cutoffEpochMs: number,
  deadlineEpochMs: number,
): ObserverComplete | undefined {
  if (value.schemaVersion !== 1 || value.kind !== 'complete'
    || !matchesRequestIdentity(value, request)) return undefined
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
    requestId: request.requestId,
    cutoff: request.cutoff,
    shanghaiDay: request.shanghaiDay,
    startedAt,
    completedAt,
    surfaces: Object.freeze(surfaces),
  })
}

function parseIncompleteResult(
  value: DataRecord,
  request: ObserverRequest,
  cutoffEpochMs: number,
  deadlineEpochMs: number,
  budgetEndEpochMs: number,
): ObserverIncomplete | undefined {
  if (value.schemaVersion !== 1 || value.kind !== 'incomplete'
    || !matchesRequestIdentity(value, request)) return undefined
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
    requestId: request.requestId,
    cutoff: request.cutoff,
    shanghaiDay: request.shanghaiDay,
    startedAt,
    completedAt,
    surfaces: Object.freeze(surfaces),
  })
}

function parseObserverResult(
  stdout: string,
  request: ObserverRequest,
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
  const resultRecord = exactDataRecord(decoded, RESULT_KEYS)
  if (resultRecord === undefined) return frozenError('protocol_invalid')
  const complete = parseCompleteResult(resultRecord, request, cutoffEpochMs, deadlineEpochMs)
  if (complete !== undefined) return complete
  const incomplete = parseIncompleteResult(resultRecord, request, cutoffEpochMs, deadlineEpochMs, budgetEndEpochMs)
  if (incomplete !== undefined) return incomplete
  return frozenError('protocol_invalid')
}

function validPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('\u0000') && value.startsWith('/')
}

function validSafePositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function readOwnSpawnPid(value: unknown): number | undefined {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return undefined
  try {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, 'pid')
    if (descriptor === undefined || descriptor.enumerable !== true || !('value' in descriptor)
      || !validSafePositiveInteger(descriptor.value)) return undefined
    return descriptor.value
  } catch {
    return undefined
  }
}

function readSafeMethod(value: unknown, name: string): ((...args: unknown[]) => unknown) | undefined {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return undefined
  try {
    if (nodeTypes.isProxy(value)) return undefined
    let cursor: object | null = value
    while (cursor !== null) {
      const descriptor = Reflect.getOwnPropertyDescriptor(cursor, name)
      if (descriptor !== undefined) {
        if (!('value' in descriptor) || typeof descriptor.value !== 'function') return undefined
        return descriptor.value as (...args: unknown[]) => unknown
      }
      cursor = Object.getPrototypeOf(cursor) as object | null
    }
  } catch {
    return undefined
  }
  return undefined
}

function captureListenerOps(target: object, events: readonly string[]): CapturedListenerOps {
  const on = readSafeMethod(target, 'on')
  const removeListener = readSafeMethod(target, 'removeListener')
  const listenerCount = readSafeMethod(target, 'listenerCount')
  const destroy = readSafeMethod(target, 'destroy')
  const baselines = new Map<string, number | undefined>()
  for (const event of events) {
    let baseline: number | undefined
    if (listenerCount !== undefined) {
      try {
        const value = Reflect.apply(listenerCount, target, [event])
        if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) baseline = value
      } catch {
        // A missing baseline prevents claiming a later detach.
      }
    }
    baselines.set(event, baseline)
  }
  return Object.freeze({ target, on, removeListener, listenerCount, destroy, baselines })
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
  if (typeof value !== 'string') return false
  const match = /^telegram:(-[1-9][0-9]*|[1-9][0-9]*):([1-9][0-9]*)$/.exec(value)
  if (match === null) return false
  const chatId = Number(match[1])
  const messageId = Number(match[2])
  return Number.isSafeInteger(chatId) && String(chatId) === match[1]
    && Number.isSafeInteger(messageId) && messageId > 0 && String(messageId) === match[2]
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

function observeChild(
  options: ObserverOptions,
  input: unknown,
  ownerHooks?: ObserverOwnerHooks,
  ownershipToken?: symbol,
): Promise<ObserverResult> {
  const releaseBeforeSpawn = (): void => {
    if (ownershipToken !== undefined) {
      ownerHooks?.release(ownershipToken)
      ownershipToken = undefined
    }
  }
  const failBeforeSpawn = (result: ObserverError): Promise<ObserverResult> => {
    releaseBeforeSpawn()
    return Promise.resolve(result)
  }
  const inputRecord = exactDataRecord(input, INPUT_KEYS)
  if (inputRecord === undefined) return failBeforeSpawn(frozenError('invalid_request'))

  const parsed = parseRequest(inputRecord.request)
  const signal = inputRecord.signal
  let realAbortSignal: AbortSignal
  try {
    if (nodeTypes.isProxy(signal) || !(signal instanceof AbortSignal)) return failBeforeSpawn(frozenError('invalid_request'))
    realAbortSignal = signal
  } catch {
    return failBeforeSpawn(frozenError('invalid_request'))
  }
  if (parsed === undefined) return failBeforeSpawn(frozenError('invalid_request'))

  let preAborted: boolean
  try {
    preAborted = realAbortSignal.aborted
  } catch {
    return failBeforeSpawn(frozenError('invalid_request'))
  }
  if (preAborted) return failBeforeSpawn(frozenError('aborted'))

  let snapshot: number
  try {
    snapshot = options.nowEpochMs()
  } catch {
    return failBeforeSpawn(frozenError('observer_failed'))
  }
  if (!Number.isFinite(snapshot)) return failBeforeSpawn(frozenError('observer_failed'))

  const cutoffEpochMs = parsed.cutoffEpochMs
  if (snapshot < cutoffEpochMs) return failBeforeSpawn(frozenError('invalid_request'))

  const nextShanghaiMidnight = Date.parse(`${parsed.request.shanghaiDay}T00:00:00.000Z`) - SHANGHAI_OFFSET_MS + DAY_MS
  const budgetEnd = Math.min(cutoffEpochMs + options.totalBudgetMs, nextShanghaiMidnight - 1)
  const deadlineEpochMs = budgetEnd - options.cleanupReserveMs
  if (!(cutoffEpochMs <= snapshot
    && snapshot < deadlineEpochMs
    && deadlineEpochMs < budgetEnd
    && deadlineEpochMs + options.killGraceMs < budgetEnd)) {
    return failBeforeSpawn(frozenError('insufficient_budget'))
  }

  const payload = `{"schemaVersion":1,"requestId":${JSON.stringify(parsed.request.requestId)},"cutoff":${JSON.stringify(parsed.request.cutoff)},"shanghaiDay":${JSON.stringify(parsed.request.shanghaiDay)},"deadlineEpochMs":${deadlineEpochMs}}`
  let child: ChildProcess
  try {
    child = options.spawn(
      options.pythonFile,
      [options.observerCliPath],
      { shell: false, stdio: ['pipe', 'pipe', 'pipe'] },
    ) as ChildProcess
  } catch {
    return failBeforeSpawn(frozenError('observer_failed'))
  }

  const capturedPid = readOwnSpawnPid(child)

  return new Promise<ObserverResult>((resolve) => {
    let stdinStream: ChildProcess['stdin']
    let stdoutStream: ChildStream
    let stderrStream: ChildStream
    try {
      stdinStream = child.stdin
      stdoutStream = child.stdout
      stderrStream = child.stderr
    } catch {
      ownerHooks?.poison()
      if (ownershipToken !== undefined) {
        ownerHooks?.quarantine(ownershipToken)
        ownershipToken = undefined
      }
      resolve(frozenError('observer_failed'))
      return
    }
    const childListenerOps = captureListenerOps(child, ['exit', 'close', 'spawn', 'error'])
    const stdoutListenerOps = captureListenerOps(stdoutStream, ['data', 'error'])
    const stderrListenerOps = captureListenerOps(stderrStream, ['data', 'error'])
    const stdinListenerOps = captureListenerOps(stdinStream, [])

    type TimerSlot = {
      generation: number
      active: boolean
      handle: unknown
    }

    let spawnState: 'pending' | 'running' | 'failed' = capturedPid === undefined ? 'failed' : 'running'
    let processExited = spawnState === 'failed'
    let stdioClosed = false
    let settled = false
    let hardBudgetHandoff = false
    let quarantineToken: symbol | undefined
    let firstReason: ErrorCode | undefined = spawnState === 'failed' ? 'observer_failed' : undefined
    let stdout = ''
    let stdoutDecoder: InstanceType<typeof TextDecoder> | undefined = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
    let stderrDecoder: InstanceType<typeof TextDecoder> | undefined = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
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
    let stdoutDataState: BusinessListenerState = 'absent'
    let stderrDataState: BusinessListenerState = 'absent'
    let stdoutErrorState: BusinessListenerState = 'absent'
    let stderrErrorState: BusinessListenerState = 'absent'
    let stdoutDrainState: DrainListenerState = 'not-attempted'
    let stderrDrainState: DrainListenerState = 'not-attempted'
    let exitListenerInstalled = false
    let closeListenerInstalled = false
    let spawnListenerInstalled = false
    let childErrorListenerInstalled = false
    let hardCleanupComplete = false

    const readCapturedSpecificCount = (
      listenerOps: CapturedListenerOps,
      event: string,
      listener: (...args: unknown[]) => void,
    ): number | undefined => {
      if (listenerOps.listenerCount === undefined) return undefined
      try {
        const specific = Reflect.apply(listenerOps.listenerCount, listenerOps.target, [event, listener])
        return typeof specific === 'number' && Number.isSafeInteger(specific) && specific >= 0 ? specific : undefined
      } catch {
        return undefined
      }
    }

    const detachCapturedSpecific = (
      listenerOps: CapturedListenerOps,
      event: string,
      listener: (...args: unknown[]) => void,
    ): boolean => {
      if (listenerOps.removeListener === undefined) return false
      let specific = readCapturedSpecificCount(listenerOps, event, listener)
      if (specific === undefined) return false
      const upperBound = specific
      let attempts = 0
      try {
        while (specific > 0 && attempts < upperBound) {
          Reflect.apply(listenerOps.removeListener, listenerOps.target, [event, listener])
          const nextSpecific = readCapturedSpecificCount(listenerOps, event, listener)
          if (nextSpecific === undefined || nextSpecific >= specific) return false
          specific = nextSpecific
          attempts += 1
        }
      } catch {
        return false
      }
      return specific === 0
    }

    const detachCapturedListener = (
      listenerOps: CapturedListenerOps,
      event: string,
      listener: (...args: unknown[]) => void,
      retainedCount = 0,
    ): boolean => {
      const baseline = listenerOps.baselines.get(event)
      if (baseline === undefined || listenerOps.listenerCount === undefined) return false
      if (!detachCapturedSpecific(listenerOps, event, listener)) return false
      try {
        const currentTotal = Reflect.apply(listenerOps.listenerCount, listenerOps.target, [event])
        return currentTotal === baseline + retainedCount
      } catch {
        return false
      }
    }

    const installCapturedListener = (
      listenerOps: CapturedListenerOps,
      event: string,
      listener: (...args: unknown[]) => void,
    ): 'installed' | 'absent' | 'maybe-installed' => {
      if (listenerOps.on === undefined) return 'maybe-installed'
      try {
        Reflect.apply(listenerOps.on, listenerOps.target, [event, listener])
        if (listenerOps.listenerCount === undefined) return 'maybe-installed'
        const specific = Reflect.apply(listenerOps.listenerCount, listenerOps.target, [event, listener])
        if (typeof specific !== 'number' || !Number.isSafeInteger(specific) || specific < 0) return 'maybe-installed'
        return specific > 0 ? 'installed' : 'absent'
      } catch {
        return 'maybe-installed'
      }
    }

    const destroyCapturedStream = (listenerOps: CapturedListenerOps): void => {
      try {
        if (listenerOps.destroy !== undefined) Reflect.apply(listenerOps.destroy, listenerOps.target, [])
      } catch {
        // Best-effort cleanup only.
      }
    }

    const canSignalChild = (): boolean => spawnState === 'running'
      && !processExited && !stdioClosed && !settled

    const safeKill = (signalToSend: 'SIGTERM' | 'SIGKILL', markAttempted: () => void): boolean => {
      if (!canSignalChild()) return false
      markAttempted()
      try {
        child.kill(signalToSend)
      } catch {
        // A kill failure cannot prove that the child exited; close remains authoritative.
      }
      return true
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
          if (stdioClosed || settled) return
          callback()
        }, delayMs)
        if (callbackEntered || stdioClosed || !slot.active || slot.generation !== token) {
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
        if (callbackEntered || stdioClosed || !slot.active || slot.generation !== token) return true
        slot.generation += 1
        slot.active = false
        slot.handle = undefined
        return false
      }
    }

    const attemptTerm = (): void => {
      if (termAttempted) return
      safeKill('SIGTERM', () => { termAttempted = true })
    }

    const attemptGraceKill = (): void => {
      if (graceKillAttempted || graceConsumed) return
      safeKill('SIGKILL', () => {
        graceConsumed = true
        graceKillAttempted = true
      })
    }

    const scheduleGrace = (): void => {
      if (!canSignalChild() || graceConsumed || graceKillAttempted || graceSlot.active) return
      const registered = armTimer(graceSlot, onGrace, options.killGraceMs)
      if (!registered && canSignalChild() && !graceConsumed && !graceKillAttempted) attemptGraceKill()
    }

    const attemptBudgetKill = (): void => {
      if (budgetKillAttempted) return
      safeKill('SIGKILL', () => { budgetKillAttempted = true })
    }

    const lockFirstReason = (reason: ErrorCode): void => {
      if (stdioClosed || settled || firstReason !== undefined) return
      firstReason = reason
      stdout = ''
      cancelTimer(deadlineSlot)
      attemptTerm()
      scheduleGrace()
    }

    function onAbort(): void {
      if (stdioClosed || settled) return
      lockFirstReason('aborted')
    }

    const collectStdout = (chunk: unknown): void => {
      if (stdioClosed || settled || firstReason !== undefined) return

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
        if (stdoutDecoder === undefined) return
        stdout += stdoutDecoder.decode(bytes, { stream: true })
      } catch {
        lockFirstReason('protocol_invalid')
      }
    }

    const collectStderr = (chunk: unknown): void => {
      if (stdioClosed || settled || firstReason !== undefined) return

      const byteChunk = strictByteChunk(chunk, STDERR_MAX_BYTES - stderrRawBytes)
      if (byteChunk.kind === 'failed' || byteChunk.kind === 'overflow') {
        lockFirstReason('observer_failed')
        return
      }
      const { bytes, byteLength } = byteChunk

      try {
        if (stderrDecoder === undefined) return
        stderrDecoder.decode(bytes, { stream: true })
        stderrRawBytes += byteLength
      } catch {
        lockFirstReason('observer_failed')
      }
    }
    const markStreamFailure = (): void => {
      if (stdioClosed || settled) return
      lockFirstReason('observer_failed')
    }
    const consumeGraceForBudget = (): void => {
      cancelTimer(graceSlot)
      graceConsumed = true
    }

    const failWithoutBudgetTimer = (): void => {
      ownerHooks?.poison()
      if (!stdioClosed && !settled && firstReason === undefined) {
        firstReason = 'observer_failed'
        stdout = ''
      }
      cancelTimer(deadlineSlot)
      cancelTimer(graceSlot)
      cancelTimer(budgetSlot)
      attemptTerm()
      attemptBudgetKill()
      handoffAtHardBudget()
    }

    function onGrace(): void {
      if (stdioClosed || settled) return
      attemptGraceKill()
    }

    const onDeadline = (): void => {
      if (stdioClosed || settled) return
      lockFirstReason('timed_out')
    }

    const onBudget = (): void => {
      if (stdioClosed || settled) return
      ownerHooks?.poison()
      consumeGraceForBudget()
      if (firstReason === undefined) firstReason = 'timed_out'
      stdout = ''
      cancelTimer(deadlineSlot)
      attemptTerm()
      attemptBudgetKill()
      handoffAtHardBudget()
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

    const cleanupBusinessListeners = (removeDrainListeners = false): void => {
      if (removeDrainListeners) {
        if (stdoutDataState !== 'absent' && detachCapturedSpecific(stdoutListenerOps, 'data', collectStdout)) stdoutDataState = 'absent'
        if (stderrDataState !== 'absent' && detachCapturedSpecific(stderrListenerOps, 'data', collectStderr)) stderrDataState = 'absent'
        if (stdoutErrorState !== 'absent') {
          if (detachCapturedSpecific(stdoutListenerOps, 'error', markStreamFailure)) stdoutErrorState = 'absent'
        }
        if (stderrErrorState !== 'absent') {
          if (detachCapturedSpecific(stderrListenerOps, 'error', markStreamFailure)) stderrErrorState = 'absent'
        }
        if (stdoutDrainState !== 'not-attempted' && stdoutDrainState !== 'absent'
          && detachCapturedSpecific(stdoutListenerOps, 'error', drainLateStreamError)) stdoutDrainState = 'absent'
        if (stderrDrainState !== 'not-attempted' && stderrDrainState !== 'absent'
          && detachCapturedSpecific(stderrListenerOps, 'error', drainLateStreamError)) stderrDrainState = 'absent'
        return
      }
      if (stdoutDataState !== 'absent') {
        if (detachCapturedListener(stdoutListenerOps, 'data', collectStdout)) stdoutDataState = 'absent'
      }
      if (stderrDataState !== 'absent') {
        if (detachCapturedListener(stderrListenerOps, 'data', collectStderr)) stderrDataState = 'absent'
      }
      if (stdoutErrorState !== 'absent' && (removeDrainListeners || stdoutDrainState === 'verified-installed')) {
        if (detachCapturedListener(stdoutListenerOps, 'error', markStreamFailure, stdoutDrainState === 'verified-installed' ? 1 : 0)) stdoutErrorState = 'absent'
      }
      if (stderrErrorState !== 'absent' && (removeDrainListeners || stderrDrainState === 'verified-installed')) {
        if (detachCapturedListener(stderrListenerOps, 'error', markStreamFailure, stderrDrainState === 'verified-installed' ? 1 : 0)) stderrErrorState = 'absent'
      }
    }

    const cleanupBusinessState = (): void => {
      cleanup()
      if (stdoutDrainState === 'not-attempted') {
        stdoutDrainState = 'maybe-installed'
        const drainState = installCapturedListener(stdoutListenerOps, 'error', drainLateStreamError)
        stdoutDrainState = drainState === 'installed' ? 'verified-installed' : drainState === 'absent' ? 'absent' : 'maybe-installed'
      }
      if (stderrDrainState === 'not-attempted') {
        stderrDrainState = 'maybe-installed'
        const drainState = installCapturedListener(stderrListenerOps, 'error', drainLateStreamError)
        stderrDrainState = drainState === 'installed' ? 'verified-installed' : drainState === 'absent' ? 'absent' : 'maybe-installed'
      }
      cleanupBusinessListeners()
      stdout = ''
      stdoutRawBytes = 0
      stderrRawBytes = 0
      stdoutDecoder = undefined
      stderrDecoder = undefined
      try {
        destroyCapturedStream(stdinListenerOps)
      } catch {
        // Best-effort cleanup only.
      }
      try {
        destroyCapturedStream(stdoutListenerOps)
      } catch {
        // Best-effort cleanup only.
      }
      try {
        destroyCapturedStream(stderrListenerOps)
      } catch {
        // Best-effort cleanup only.
      }
      hardCleanupComplete = true
    }

    function handoffAtHardBudget(): void {
      if (stdioClosed || settled || hardBudgetHandoff) return
      hardBudgetHandoff = true
      settled = true
      ownerHooks?.poison()
      if (ownershipToken !== undefined) {
        ownerHooks?.quarantine(ownershipToken)
        quarantineToken = ownershipToken
        ownershipToken = undefined
      }
      cleanupBusinessState()
      finishHardReap()
      resolve(frozenError(firstReason ?? 'observer_failed'))
    }

    function finishHardReap(): void {
      if (!hardCleanupComplete || !stdioClosed) return
      cleanupBusinessListeners(true)
      const childDetached = (installed: boolean, event: string, listener: (...args: unknown[]) => void): boolean => {
        if (!installed) return true
        return detachCapturedListener(childListenerOps, event, listener)
      }
      if (exitListenerInstalled && childDetached(true, 'exit', onExit)) exitListenerInstalled = false
      if (closeListenerInstalled && childDetached(true, 'close', onClose)) closeListenerInstalled = false
      if (spawnListenerInstalled && childDetached(true, 'spawn', onSpawn)) spawnListenerInstalled = false
      if (childErrorListenerInstalled && childDetached(true, 'error', markChildFailure)) childErrorListenerInstalled = false
      const streamBaselineRestored = (listenerOps: CapturedListenerOps): boolean => {
        const dataBaseline = listenerOps.baselines.get('data')
        const baseline = listenerOps.baselines.get('error')
        const dataListener = listenerOps.target === stdoutListenerOps.target ? collectStdout : collectStderr
        const dataSpecific = readCapturedSpecificCount(listenerOps, 'data', dataListener)
        const businessSpecific = readCapturedSpecificCount(listenerOps, 'error', markStreamFailure)
        const drainSpecific = readCapturedSpecificCount(listenerOps, 'error', drainLateStreamError)
        if (dataBaseline === undefined || baseline === undefined || dataSpecific !== 0
          || businessSpecific !== 0 || drainSpecific !== 0 || listenerOps.listenerCount === undefined) return false
        try {
          return Reflect.apply(listenerOps.listenerCount, listenerOps.target, ['data']) === dataBaseline
            && Reflect.apply(listenerOps.listenerCount, listenerOps.target, ['error']) === baseline
        } catch {
          return false
        }
      }
      const streamDetached = stdoutDataState === 'absent' && stderrDataState === 'absent'
        && streamBaselineRestored(stdoutListenerOps) && streamBaselineRestored(stderrListenerOps)
      const childDetachedCompletely = !exitListenerInstalled && !closeListenerInstalled
        && !spawnListenerInstalled && !childErrorListenerInstalled
      if (streamDetached && childDetachedCompletely) {
        if (quarantineToken !== undefined) ownerHooks?.reaped(quarantineToken)
        quarantineToken = undefined
      }
    }

    const onExit = (): void => {
      if (stdioClosed || settled || processExited) return
      processExited = true
      cancelTimer(graceSlot)
    }

    const onSpawn = (): void => {
      if (stdioClosed || settled || spawnState !== 'running') return
      const matchingPid = readOwnSpawnPid(child) === capturedPid
      if (matchingPid) return
      spawnState = 'failed'
      processExited = true
      cancelTimer(graceSlot)
      lockFirstReason('observer_failed')
    }

    const markChildFailure = (): void => {
      if (stdioClosed || settled) return
      if (spawnState !== 'running') {
        spawnState = 'failed'
        processExited = true
        cancelTimer(graceSlot)
      }
      lockFirstReason('observer_failed')
    }

    const onClose = (code?: unknown, signalToReport?: unknown): void => {
      if (stdioClosed) {
        if (hardBudgetHandoff) finishHardReap()
        return
      }
      stdioClosed = true
      processExited = true
      if (hardBudgetHandoff) {
        finishHardReap()
        return
      }
      if (settled) return
      settled = true
      let result: ObserverResult
      if (firstReason !== undefined) {
        result = frozenError(firstReason)
      } else {
        let finalizationReason: ErrorCode | undefined
        try {
          if (stdoutDecoder === undefined) throw new Error()
          stdout += stdoutDecoder.decode()
        } catch {
          finalizationReason = 'protocol_invalid'
        }
        try {
          if (stderrDecoder === undefined) throw new Error()
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
            result = parseObserverResult(stdout, parsed.request, cutoffEpochMs, deadlineEpochMs, budgetEnd)
          } catch {
            result = frozenError('observer_failed')
          }
        }
      }
      cleanup()
      if (ownershipToken !== undefined) {
        ownerHooks?.release(ownershipToken)
        ownershipToken = undefined
      }
      resolve(result)
    }

    let exitGateInstalled = false
    let closeGateInstalled = false
    let listenerInstallationFailed = false
    try {
      if (childListenerOps.on === undefined) throw new Error()
      exitListenerInstalled = true
      Reflect.apply(childListenerOps.on, child, ['exit', onExit])
      exitGateInstalled = true
    } catch {
      spawnState = 'failed'
      processExited = true
      if (firstReason === undefined) {
        firstReason = 'observer_failed'
        stdout = ''
      }
    }
    try {
      if (childListenerOps.on === undefined) throw new Error()
      closeListenerInstalled = true
      Reflect.apply(childListenerOps.on, child, ['close', onClose])
      closeGateInstalled = true
    } catch {
      listenerInstallationFailed = true
    }
    try {
      if (childListenerOps.on === undefined) throw new Error()
      spawnListenerInstalled = true
      Reflect.apply(childListenerOps.on, child, ['spawn', onSpawn])
    } catch {
      listenerInstallationFailed = true
    }
    try {
      if (childListenerOps.on === undefined) throw new Error()
      childErrorListenerInstalled = true
      Reflect.apply(childListenerOps.on, child, ['error', markChildFailure])
    } catch {
      listenerInstallationFailed = true
    }

    if (!closeGateInstalled) {
      failWithoutBudgetTimer()
      return
    }
    if (!exitGateInstalled) {
      spawnState = 'failed'
      processExited = true
    }
    if (listenerInstallationFailed) lockFirstReason('observer_failed')

    try {
      if (!stdioClosed && !settled) {
        const budgetArmed = armTimer(budgetSlot, onBudget, budgetEnd - snapshot)
        if (!budgetArmed) {
          failWithoutBudgetTimer()
          return
        }
      }

      if (!stdioClosed && !settled && firstReason === undefined) {
        const deadlineArmed = armTimer(deadlineSlot, onDeadline, deadlineEpochMs - snapshot)
        if (!deadlineArmed) lockFirstReason('observer_failed')
      }

      if (!stdioClosed && !settled) {
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
      if (!stdioClosed && !settled) {
        try {
          abortedAfterRegistration = realAbortSignal.aborted
        } catch {
          lockFirstReason('observer_failed')
        }
      }
      if (abortedAfterRegistration) onAbort()

      if (!stdioClosed && !settled) {
        stdoutDataState = installCapturedListener(stdoutListenerOps, 'data', collectStdout)
        stderrDataState = installCapturedListener(stderrListenerOps, 'data', collectStderr)
        stdoutErrorState = installCapturedListener(stdoutListenerOps, 'error', markStreamFailure)
        stderrErrorState = installCapturedListener(stderrListenerOps, 'error', markStreamFailure)
        if (stdoutDataState !== 'installed' || stderrDataState !== 'installed'
          || stdoutErrorState !== 'installed' || stderrErrorState !== 'installed') lockFirstReason('observer_failed')
      }

      if (!stdioClosed && !settled) stdinStream.end(payload, 'utf8', (...callbackValues: unknown[]) => {
        for (const callbackValue of callbackValues) {
          if (callbackValue !== undefined && callbackValue !== null) {
            lockFirstReason('observer_failed')
            return
          }
        }
      })
    } catch {
      lockFirstReason('observer_failed')
    }
  })
}

function createPersonalFeedXObserverChildOwnerInternal(options: unknown): ObserverOwner {
  const parsedOptions = parseOptions(options)
  let poisoned = false
  let sealed = false
  let shutdownPromise: Promise<void> | undefined
  const ownership = new Map<symbol, 'active' | 'quarantined'>()
  const hooks: ObserverOwnerHooks = Object.freeze({
    reserve: () => {
      const token = Symbol('personal-feed-x-observer-child')
      ownership.set(token, 'active')
      return token
    },
    release: (token: symbol) => {
      if (ownership.get(token) === 'active') ownership.delete(token)
    },
    poison: () => { poisoned = true },
    quarantine: (token: symbol) => {
      if (ownership.get(token) === 'active') ownership.set(token, 'quarantined')
    },
    reaped: (token: symbol) => { ownership.delete(token) },
  })
  const observe = (input: unknown): Promise<ObserverResult> => {
    if (poisoned || sealed) return Promise.resolve(frozenError('observer_failed'))
    const token = hooks.reserve()
    return observeChild(parsedOptions, input, hooks, token)
  }
  const shutdown = (): Promise<void> => {
    if (shutdownPromise !== undefined) return shutdownPromise
    sealed = true
    if (ownership.size > 0) {
      shutdownPromise = Promise.reject(new Error('Unable to shutdown personal-feed X observer child: resource not reaped'))
    } else {
      shutdownPromise = Promise.resolve()
    }
    return shutdownPromise
  }
  return Object.freeze({ observe, shutdown })
}

export function createPersonalFeedXObserverChildOwner(options: unknown): ObserverOwner {
  return createPersonalFeedXObserverChildOwnerInternal(options)
}

export function createPersonalFeedXObserverChild(options: unknown): ObserverChild {
  const owner = createPersonalFeedXObserverChildOwnerInternal(options)
  return Object.freeze({ observe: owner.observe })
}
