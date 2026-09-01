import { types as nodeTypes } from 'node:util'

const REFLECT_APPLY = typeof Reflect === 'object' && typeof Reflect.apply === 'function'
  ? Reflect.apply
  : undefined
const OBJECT_PROTOTYPE = Object.prototype
const ARRAY_PROTOTYPE = Array.prototype
const TOP_KEYS = Object.freeze([
  'schemaVersion', 'kind', 'requestId', 'cutoff', 'shanghaiDay', 'startedAt', 'completedAt', 'surfaces',
] as const)
const INPUT_KEYS = Object.freeze(['request', 'signal'] as const)
const REQUEST_KEYS = Object.freeze(['requestId', 'cutoff', 'shanghaiDay'] as const)
const FACTORY_KEYS = Object.freeze(['child'] as const)
const CHILD_KEYS = Object.freeze(['observe'] as const)
const SURFACE_KEYS = Object.freeze(['kind', 'surface', 'surfaceOrdinal', 'startedAt', 'completedAt', 'occurrences'] as const)
const OCCURRENCE_KEYS = Object.freeze(['sourceUrl', 'body', 'occurrenceOrdinal', 'capturedAt', 'authorHandle', 'publishedAt'] as const)
const SURFACES = Object.freeze(['for_you', 'following', 'explore'] as const)
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1_000
const MAX_SURFACE_OCCURRENCES = 8
const MAX_TOTAL_OCCURRENCES = 24
const MAX_BODY_BYTES = 6_144
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const CANONICAL_DAY = /^\d{4}-\d{2}-\d{2}$/

type DataRecord = Readonly<Record<string, unknown>>
type Request = Readonly<{
  readonly requestId: string
  readonly cutoff: string
  readonly shanghaiDay: string
}>


type Slot = {
  state: 'open' | 'taken' | 'closed'
  text: string | undefined
}

type Batch = {
  readonly signal: AbortSignal
  readonly batches: Set<Batch>
  readonly slots: Set<Slot>
  readonly onAbort: () => void
  closed: boolean
  listenerInstalled: boolean
}

type ParsedRequest = Readonly<{
  readonly request: Request
  readonly cutoffEpochMs: number
}>

type Intrinsics = Readonly<{
  readonly apply: typeof Reflect.apply | undefined
  readonly abortedGetter: (() => boolean) | undefined
  readonly addEventListener: ((type: string, listener: (...args: unknown[]) => unknown, options?: unknown) => unknown) | undefined
  readonly removeEventListener: ((type: string, listener: (...args: unknown[]) => unknown, options?: unknown) => unknown) | undefined
}>

function captureIntrinsics(): Intrinsics {
  let abortedGetter: (() => boolean) | undefined
  let addEventListener: Intrinsics['addEventListener']
  let removeEventListener: Intrinsics['removeEventListener']
  try {
    const abortSignalPrototype = typeof AbortSignal === 'function' ? AbortSignal.prototype : undefined
    const eventTargetPrototype = typeof EventTarget === 'function' ? EventTarget.prototype : undefined
    abortedGetter = Object.getOwnPropertyDescriptor(abortSignalPrototype ?? {}, 'aborted')?.get as (() => boolean) | undefined
    addEventListener = Object.getOwnPropertyDescriptor(eventTargetPrototype ?? {}, 'addEventListener')?.value as Intrinsics['addEventListener']
    removeEventListener = Object.getOwnPropertyDescriptor(eventTargetPrototype ?? {}, 'removeEventListener')?.value as Intrinsics['removeEventListener']
  } catch {
    abortedGetter = undefined
    addEventListener = undefined
    removeEventListener = undefined
  }
  return Object.freeze({ apply: REFLECT_APPLY, abortedGetter, addEventListener, removeEventListener })
}

const INTRINSICS = captureIntrinsics()
const INCOMPLETE = Object.freeze({ kind: 'incomplete' as const })

function isProxy(value: unknown): boolean {
  try {
    return nodeTypes.isProxy(value)
  } catch {
    return true
  }
}

function exactRecord(value: unknown, keys: readonly string[]): DataRecord | undefined {
  if (value === null || typeof value !== 'object' || isProxy(value)) return undefined
  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== OBJECT_PROTOTYPE && prototype !== null) return undefined
    const ownKeys = Reflect.ownKeys(value)
    if (ownKeys.length !== keys.length) return undefined
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const allowed = new Set(keys)
    for (const ownKey of ownKeys) {
      if (typeof ownKey !== 'string' || !allowed.has(ownKey)) return undefined
      const descriptor = descriptors[ownKey]
      if (descriptor === undefined || descriptor.enumerable !== true || !('value' in descriptor)) return undefined
    }
    const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const key of keys) {
      const descriptor = descriptors[key]
      if (descriptor === undefined || descriptor.enumerable !== true || !('value' in descriptor)) return undefined
      snapshot[key] = descriptor.value
    }
    return snapshot
  } catch {
    return undefined
  }
}

function exactArray(value: unknown): readonly unknown[] | undefined {
  if (!Array.isArray(value) || isProxy(value)) return undefined
  try {
    if (Object.getPrototypeOf(value) !== ARRAY_PROTOTYPE) return undefined
    const ownKeys = Reflect.ownKeys(value)
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, 'length')
    if (lengthDescriptor === undefined || lengthDescriptor.enumerable !== false || !('value' in lengthDescriptor)
      || lengthDescriptor.value !== value.length || ownKeys.length !== value.length + 1) return undefined
    for (const ownKey of ownKeys) {
      if (ownKey === 'length') continue
      if (typeof ownKey !== 'string' || !/^\d+$/.test(ownKey)) return undefined
      const index = Number(ownKey)
      const descriptor = descriptors[ownKey]
      if (!Number.isSafeInteger(index) || index < 0 || index >= value.length || String(index) !== ownKey
        || descriptor === undefined || descriptor.enumerable !== true || !('value' in descriptor)) return undefined
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

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value !== 'string' || !validUnicode(value) || !CANONICAL_TIMESTAMP.test(value)) return undefined
  const epochMs = Date.parse(value)
  if (!Number.isFinite(epochMs)) return undefined
  try {
    return new Date(epochMs).toISOString() === value ? epochMs : undefined
  } catch {
    return undefined
  }
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

function parseRequest(value: unknown): ParsedRequest | undefined {
  const record = exactRecord(value, REQUEST_KEYS)
  if (record === undefined) return undefined
  const requestId = record.requestId
  const cutoff = record.cutoff
  const shanghaiDay = record.shanghaiDay
  if (!validRequestId(requestId) || typeof cutoff !== 'string' || typeof shanghaiDay !== 'string'
    || !CANONICAL_DAY.test(shanghaiDay)) return undefined
  const cutoffEpochMs = parseTimestamp(cutoff)
  if (cutoffEpochMs === undefined) return undefined
  try {
    const expectedShanghaiDay = new Date(cutoffEpochMs + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10)
    if (expectedShanghaiDay !== shanghaiDay) return undefined
  } catch {
    return undefined
  }
  return {
    request: Object.freeze({ requestId, cutoff, shanghaiDay }),
    cutoffEpochMs,
  }
}

function readAborted(signal: unknown): boolean | undefined {
  if (signal === null || (typeof signal !== 'object' && typeof signal !== 'function') || isProxy(signal)
    || INTRINSICS.apply === undefined || INTRINSICS.abortedGetter === undefined) return undefined
  try {
    const value = INTRINSICS.apply(INTRINSICS.abortedGetter, signal, [])
    return typeof value === 'boolean' ? value : undefined
  } catch {
    return undefined
  }
}

function safeBodyBytes(value: string): number | undefined {
  try {
    return new TextEncoder().encode(value).byteLength
  } catch {
    return undefined
  }
}

function validSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function validSurface(value: unknown): value is typeof SURFACES[number] {
  return value === 'for_you' || value === 'following' || value === 'explore'
}

function closeSlot(slot: Slot): void {
  slot.text = undefined
  slot.state = 'closed'
}

function closeBatch(batch: Batch): void {
  if (batch.closed) return
  batch.closed = true
  for (const slot of batch.slots) closeSlot(slot)
  batch.slots.clear()
  if (batch.listenerInstalled && INTRINSICS.apply !== undefined && INTRINSICS.removeEventListener !== undefined) {
    try {
      INTRINSICS.apply(INTRINSICS.removeEventListener, batch.signal, ['abort', batch.onAbort])
    } catch {
      // A real signal's intrinsic remove is not expected to fail; closure is already sealed.
    }
  }
  batch.listenerInstalled = false
  batch.batches.delete(batch)
}

function makeCapture(batch: Batch, text: string): Readonly<{ readonly take: (input: unknown) => string | undefined; readonly close: (...args: unknown[]) => Promise<void> }> {
  const slot: Slot = { state: 'open', text }
  batch.slots.add(slot)
  const take = (input: unknown): string | undefined => {
    if (batch.closed || slot.state !== 'open') return undefined
    const record = exactRecord(input, ['signal'])
    if (record === undefined || record.signal !== batch.signal) return undefined
    const aborted = readAborted(record.signal)
    if (aborted !== false) return undefined
    const local = slot.text
    if (local === undefined) return undefined
    slot.text = undefined
    slot.state = 'taken'
    return local
  }
  const close = (..._args: unknown[]): Promise<void> => {
    if (slot.state === 'open') closeSlot(slot)
    return Promise.resolve()
  }
  Object.freeze(take)
  Object.freeze(close)
  return Object.freeze({ take, close })
}

function makeInsufficientCapture(batch: Batch): Readonly<{ readonly kind: 'insufficient'; readonly close: (...args: unknown[]) => Promise<void> }> {
  const slot: Slot = { state: 'open', text: undefined }
  batch.slots.add(slot)
  const close = (..._args: unknown[]): Promise<void> => {
    if (slot.state === 'open') closeSlot(slot)
    return Promise.resolve()
  }
  Object.freeze(close)
  return Object.freeze({ kind: 'insufficient' as const, close })
}

function makeBatch(signal: AbortSignal, batches: Set<Batch>): Batch | undefined {
  if (INTRINSICS.apply === undefined || INTRINSICS.addEventListener === undefined
    || INTRINSICS.removeEventListener === undefined) return undefined
  let batch!: Batch
  const onAbort = (): void => closeBatch(batch)
  batch = {
    signal,
    batches,
    slots: new Set<Slot>(),
    onAbort,
    closed: false,
    listenerInstalled: false,
  }
  batches.add(batch)
  try {
    INTRINSICS.apply(INTRINSICS.addEventListener, signal, ['abort', batch.onAbort, { once: true }])
    batch.listenerInstalled = true
    const aborted = readAborted(signal)
    if (aborted !== false) {
      closeBatch(batch)
      return undefined
    }
    return batch
  } catch {
    closeBatch(batch)
    return undefined
  }
}

function validBody(value: unknown):
  | { readonly kind: 'sufficient'; readonly text: string }
  | { readonly kind: 'insufficient'; readonly reason: 'placeholder' | 'empty' | 'too_large' | 'show_more_failed' }
  | undefined {
  const sufficient = exactRecord(value, ['kind', 'text'])
  if (sufficient !== undefined && sufficient.kind === 'sufficient' && typeof sufficient.text === 'string'
    && validUnicode(sufficient.text) && sufficient.text.trim().length > 0) {
    const bytes = safeBodyBytes(sufficient.text)
    if (bytes !== undefined && bytes <= MAX_BODY_BYTES) return { kind: 'sufficient', text: sufficient.text }
  }
  const insufficient = exactRecord(value, ['kind', 'reason'])
  const reason = insufficient?.reason
  if (insufficient !== undefined && insufficient.kind === 'insufficient'
    && (reason === 'placeholder' || reason === 'empty' || reason === 'too_large' || reason === 'show_more_failed')) {
    return { kind: 'insufficient', reason }
  }
  return undefined
}

function parseComplete(
  value: unknown,
  request: Request,
  cutoffEpochMs: number,
  batch: Batch,
): Readonly<{ readonly window: unknown; readonly close: () => Promise<void> }> | undefined {
  const top = exactRecord(value, TOP_KEYS)
  if (top === undefined || top.schemaVersion !== 1 || top.kind !== 'complete'
    || top.requestId !== request.requestId || top.cutoff !== request.cutoff || top.shanghaiDay !== request.shanghaiDay) return undefined
  const startedAt = top.startedAt
  const completedAt = top.completedAt
  const startedEpochMs = parseTimestamp(startedAt)
  const completedEpochMs = parseTimestamp(completedAt)
  const surfacesInput = exactArray(top.surfaces)
  if (startedEpochMs === undefined || completedEpochMs === undefined || completedEpochMs < startedEpochMs
    || startedEpochMs < cutoffEpochMs || surfacesInput === undefined || surfacesInput.length !== 3) return undefined

  const outputSurfaces: unknown[] = []
  let previousCompletedEpochMs = cutoffEpochMs
  let totalOccurrences = 0
  for (let surfaceOrdinal = 0; surfaceOrdinal < 3; surfaceOrdinal += 1) {
    const surfaceRecord = exactRecord(surfacesInput[surfaceOrdinal], SURFACE_KEYS)
    const expectedSurface = SURFACES[surfaceOrdinal]
    if (surfaceRecord === undefined || expectedSurface === undefined || !validSurface(surfaceRecord.surface)
      || surfaceRecord.surface !== expectedSurface || surfaceRecord.surfaceOrdinal !== surfaceOrdinal
      || !validSafeNonNegativeInteger(surfaceRecord.surfaceOrdinal)
      || (surfaceRecord.kind !== 'complete' && surfaceRecord.kind !== 'natural_zero')) return undefined
    const surfaceStartedAt = surfaceRecord.startedAt
    const surfaceCompletedAt = surfaceRecord.completedAt
    const surfaceStartedEpochMs = parseTimestamp(surfaceStartedAt)
    const surfaceCompletedEpochMs = parseTimestamp(surfaceCompletedAt)
    const occurrencesInput = exactArray(surfaceRecord.occurrences)
    if (surfaceStartedEpochMs === undefined || surfaceCompletedEpochMs === undefined || occurrencesInput === undefined
      || surfaceStartedEpochMs < cutoffEpochMs || surfaceCompletedEpochMs <= surfaceStartedEpochMs
      || surfaceStartedEpochMs < previousCompletedEpochMs || surfaceCompletedEpochMs > completedEpochMs
      || occurrencesInput.length > MAX_SURFACE_OCCURRENCES
      || (surfaceRecord.kind === 'natural_zero' && occurrencesInput.length !== 0)
      || (surfaceRecord.kind === 'complete' && occurrencesInput.length === 0)) return undefined

    const outputOccurrences: unknown[] = []
    for (let occurrenceOrdinal = 0; occurrenceOrdinal < occurrencesInput.length; occurrenceOrdinal += 1) {
      const occurrenceRecord = exactRecord(occurrencesInput[occurrenceOrdinal], OCCURRENCE_KEYS)
      if (occurrenceRecord === undefined || occurrenceRecord.occurrenceOrdinal !== occurrenceOrdinal
        || !validSafeNonNegativeInteger(occurrenceRecord.occurrenceOrdinal)) return undefined
      const sourceUrl = occurrenceRecord.sourceUrl
      const authorHandle = occurrenceRecord.authorHandle
      const capturedAt = occurrenceRecord.capturedAt
      const publishedAt = occurrenceRecord.publishedAt
      if (typeof sourceUrl !== 'string' || typeof authorHandle !== 'string' || typeof capturedAt !== 'string'
        || typeof publishedAt !== 'string' || !validUnicode(sourceUrl) || !validUnicode(authorHandle)) return undefined
      const urlMatch = /^https:\/\/x\.com\/([a-z0-9_]{1,15})\/status\/([1-9]\d*)$/.exec(sourceUrl)
      const capturedEpochMs = parseTimestamp(capturedAt)
      if (urlMatch === null || authorHandle !== urlMatch[1] || capturedEpochMs === undefined
        || capturedEpochMs < cutoffEpochMs || capturedEpochMs < surfaceStartedEpochMs || capturedEpochMs >= surfaceCompletedEpochMs
        || parseTimestamp(publishedAt) === undefined) return undefined
      const body = validBody(occurrenceRecord.body)
      if (body === undefined) return undefined
      totalOccurrences += 1
      if (totalOccurrences > MAX_TOTAL_OCCURRENCES) return undefined
      let outputBody: unknown
      if (body.kind === 'sufficient') {
        const capture = makeCapture(batch, body.text)
        outputBody = Object.freeze({ kind: 'sufficient' as const, capture })
      } else {
        outputBody = makeInsufficientCapture(batch)
      }
      outputOccurrences.push(Object.freeze({
        sourceUrl,
        body: outputBody,
        occurrenceOrdinal,
        capturedAt,
        authorHandle,
        publishedAt,
      }))
    }
    outputSurfaces.push(Object.freeze({
      kind: surfaceRecord.kind,
      surface: expectedSurface,
      surfaceOrdinal,
      startedAt: surfaceStartedAt,
      completedAt: surfaceCompletedAt,
      occurrences: Object.freeze(outputOccurrences),
    }))
    previousCompletedEpochMs = surfaceCompletedEpochMs
  }
  if (readAborted(batch.signal) !== false) return undefined
  const window = Object.freeze({
    requestId: request.requestId,
    cutoff: request.cutoff,
    shanghaiDay: request.shanghaiDay,
    startedAt,
    completedAt,
    surfaces: Object.freeze(outputSurfaces),
  })
  const close = (): Promise<void> => {
    closeBatch(batch)
    return Promise.resolve()
  }
  Object.freeze(close)
  return Object.freeze({ kind: 'complete' as const, window, close }) as unknown as Readonly<{ readonly window: unknown; readonly close: () => Promise<void> }>
}

export function createPersonalFeedXSurfaceObserver(options: unknown): Readonly<{
  readonly observe: (input: unknown) => Promise<unknown>
  readonly shutdown: () => Promise<void>
}> {
  const optionsRecord = exactRecord(options, FACTORY_KEYS)
  const childValue = optionsRecord?.child
  const childRecord = exactRecord(childValue, CHILD_KEYS)
  const childObserve = childRecord?.observe
  if (optionsRecord === undefined || childRecord === undefined || typeof childObserve !== 'function') throw new TypeError()
  const childOwner = childValue as object
  const batches = new Set<Batch>()
  let accepting = true
  let active = 0
  let shutdownPromise: Promise<void> | undefined
  let resolveShutdown: (() => void) | undefined

  const observe = async (input: unknown): Promise<unknown> => {
    if (!accepting) return INCOMPLETE
    const inputRecord = exactRecord(input, INPUT_KEYS)
    const parsedRequest = parseRequest(inputRecord?.request)
    const signal = inputRecord?.signal
    if (inputRecord === undefined || parsedRequest === undefined || readAborted(signal) === undefined) return INCOMPLETE
    if (readAborted(signal) !== false || !accepting) return INCOMPLETE

    const childInput = Object.freeze({ request: parsedRequest.request, signal: signal as AbortSignal })
    active += 1
    try {
      let raw: unknown
      try {
        raw = await REFLECT_APPLY!(childObserve, childOwner, [childInput])
      } catch {
        return INCOMPLETE
      }
      if (!accepting || readAborted(signal) !== false) return INCOMPLETE
      const top = exactRecord(raw, TOP_KEYS)
      if (top === undefined || top.schemaVersion !== 1 || top.kind !== 'complete'
        || top.requestId !== parsedRequest.request.requestId || top.cutoff !== parsedRequest.request.cutoff
        || top.shanghaiDay !== parsedRequest.request.shanghaiDay) return INCOMPLETE
      const batch = makeBatch(signal as AbortSignal, batches)
      if (batch === undefined) return INCOMPLETE
      let complete: Readonly<{ readonly window: unknown; readonly close: () => Promise<void> }> | undefined
      try {
        complete = parseComplete(raw, parsedRequest.request, parsedRequest.cutoffEpochMs, batch)
      } catch {
        complete = undefined
      }
      if (complete === undefined || !accepting || readAborted(signal) !== false) {
        closeBatch(batch)
        return INCOMPLETE
      }
      return complete
    } finally {
      active -= 1
      if (!accepting && active === 0 && resolveShutdown !== undefined) {
        const resolve = resolveShutdown
        resolveShutdown = undefined
        resolve()
      }
    }
  }

  const shutdown = (): Promise<void> => {
    if (shutdownPromise !== undefined) return shutdownPromise
    accepting = false
    for (const batch of [...batches]) closeBatch(batch)
    if (active === 0) {
      shutdownPromise = Promise.resolve()
    } else {
      shutdownPromise = new Promise<void>(resolve => { resolveShutdown = resolve })
    }
    return shutdownPromise
  }

  Object.freeze(observe)
  Object.freeze(shutdown)
  return Object.freeze({ observe, shutdown })
}
