import { execFile as nodeExecFile } from 'node:child_process'
import { basename, dirname, isAbsolute } from 'node:path'
import { promisify } from 'node:util'

const execFile = promisify(nodeExecFile)
const SURFACES = ['for_you', 'following', 'explore'] as const
const MAX_BUFFER = 1_048_576
const MAX_SURFACE_OCCURRENCES = 8
const MAX_TOTAL_OCCURRENCES = 24
const MAX_BODY_BYTES = 6_144
const INCOMPLETE = Object.freeze({ kind: 'incomplete' as const })
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const DAY = /^\d{4}-\d{2}-\d{2}$/

type PlainRecord = Record<string, unknown>
type Request = Readonly<{
  readonly requestId: string
  readonly cutoff: string
  readonly shanghaiDay: string
}>

type CommandRequest = Readonly<{
  readonly file: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly timeoutMs: number
  readonly maxBuffer: number
  readonly shell: false
  readonly signal: AbortSignal
}>

type CommandResult = Readonly<{ readonly stdout: string; readonly stderr: string }>
type CommandRunner = (request: CommandRequest) => Promise<CommandResult>
type Clock = Readonly<{ readonly now: () => Date }>

type Slot = {
  state: 'open' | 'taken' | 'closed'
  text: string | undefined
}

type CaptureBatch = {
  readonly signal: AbortSignal
  readonly slots: Set<Slot>
  readonly onAbort: () => void
  closed: boolean
}

function isRecord(value: unknown): value is PlainRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: PlainRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

function parseStamp(value: unknown): number | undefined {
  if (typeof value !== 'string' || !STAMP.test(value)) return undefined
  const epochMs = Date.parse(value)
  if (!Number.isFinite(epochMs)) return undefined
  try {
    return new Date(epochMs).toISOString() === value ? epochMs : undefined
  } catch {
    return undefined
  }
}

function parseRequest(value: unknown): Readonly<{ readonly request: Request; readonly cutoffEpochMs: number; readonly deadlineEpochMs: number }> | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ['requestId', 'cutoff', 'shanghaiDay'])) return undefined
  const { requestId, cutoff, shanghaiDay } = value
  if (typeof requestId !== 'string' || typeof cutoff !== 'string' || typeof shanghaiDay !== 'string'
    || !/^telegram:(?:-[1-9]\d*|[1-9]\d*):[1-9]\d*$/.test(requestId) || !DAY.test(shanghaiDay)) return undefined
  const [chatId, messageId] = requestId.slice('telegram:'.length).split(':').map(Number)
  if (!Number.isSafeInteger(chatId) || chatId === 0 || !Number.isSafeInteger(messageId) || (messageId ?? 0) <= 0) return undefined
  const cutoffEpochMs = parseStamp(cutoff)
  if (cutoffEpochMs === undefined) return undefined
  let expectedDay: string
  try {
    expectedDay = new Date(cutoffEpochMs + 8 * 60 * 60 * 1_000).toISOString().slice(0, 10)
  } catch {
    return undefined
  }
  if (expectedDay !== shanghaiDay) return undefined
  const deadlineEpochMs = Date.parse(`${shanghaiDay}T16:00:00.000Z`)
  if (!Number.isSafeInteger(deadlineEpochMs) || cutoffEpochMs >= deadlineEpochMs) return undefined
  return Object.freeze({
    request: Object.freeze({ requestId, cutoff, shanghaiDay }),
    cutoffEpochMs,
    deadlineEpochMs,
  })
}

function nowEpochMs(clock: Clock): number | undefined {
  try {
    const value = clock.now()
    const epochMs = value instanceof Date ? value.getTime() : Number.NaN
    return Number.isFinite(epochMs) ? epochMs : undefined
  } catch {
    return undefined
  }
}

function closeSlot(slot: Slot): void {
  slot.text = undefined
  slot.state = 'closed'
}

function closeBatch(batch: CaptureBatch): void {
  if (batch.closed) return
  batch.closed = true
  for (const slot of batch.slots) closeSlot(slot)
  batch.slots.clear()
  batch.signal.removeEventListener('abort', batch.onAbort)
}

function createBatch(signal: AbortSignal): CaptureBatch | undefined {
  let batch!: CaptureBatch
  const onAbort = (): void => closeBatch(batch)
  batch = { signal, slots: new Set<Slot>(), onAbort, closed: false }
  signal.addEventListener('abort', onAbort, { once: true })
  if (signal.aborted) {
    closeBatch(batch)
    return undefined
  }
  return batch
}

function createSufficientBody(batch: CaptureBatch, text: string): Readonly<Record<string, unknown>> {
  const slot: Slot = { state: 'open', text }
  batch.slots.add(slot)
  const take = (input: unknown): string | undefined => {
    if (batch.closed || batch.signal.aborted || slot.state !== 'open'
      || !isRecord(input) || !hasExactKeys(input, ['signal']) || input.signal !== batch.signal) return undefined
    const value = slot.text
    if (value === undefined) return undefined
    slot.text = undefined
    slot.state = 'taken'
    return value
  }
  const close = (): Promise<void> => {
    if (slot.state === 'open') closeSlot(slot)
    return Promise.resolve()
  }
  Object.freeze(take)
  Object.freeze(close)
  return Object.freeze({ kind: 'sufficient', capture: Object.freeze({ take, close }) })
}

function createInsufficientBody(batch: CaptureBatch): Readonly<Record<string, unknown>> {
  const slot: Slot = { state: 'open', text: undefined }
  batch.slots.add(slot)
  const close = (): Promise<void> => {
    if (slot.state === 'open') closeSlot(slot)
    return Promise.resolve()
  }
  Object.freeze(close)
  return Object.freeze({ kind: 'insufficient', close })
}

function parseBody(value: unknown, batch: CaptureBatch): Readonly<Record<string, unknown>> | undefined {
  if (!isRecord(value)) return undefined
  if (hasExactKeys(value, ['kind', 'text']) && value.kind === 'sufficient' && typeof value.text === 'string'
    && value.text.trim() !== '' && new TextEncoder().encode(value.text).byteLength <= MAX_BODY_BYTES) {
    return createSufficientBody(batch, value.text)
  }
  if (hasExactKeys(value, ['kind', 'reason']) && value.kind === 'insufficient'
    && (value.reason === 'placeholder' || value.reason === 'empty' || value.reason === 'too_large' || value.reason === 'show_more_failed')) {
    return createInsufficientBody(batch)
  }
  return undefined
}

function parseOccurrence(
  value: unknown,
  ordinal: number,
  cutoffEpochMs: number,
  faceStartedEpochMs: number,
  faceCompletedEpochMs: number,
  batch: CaptureBatch,
): Readonly<Record<string, unknown>> | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ['sourceUrl', 'body', 'occurrenceOrdinal', 'capturedAt', 'authorHandle', 'publishedAt'])
    || value.occurrenceOrdinal !== ordinal) return undefined
  const { sourceUrl, authorHandle, capturedAt, publishedAt } = value
  if (typeof sourceUrl !== 'string' || typeof authorHandle !== 'string') return undefined
  const match = /^https:\/\/x\.com\/([a-z0-9_]{1,15})\/status\/([1-9]\d*)$/.exec(sourceUrl)
  const capturedEpochMs = parseStamp(capturedAt)
  if (match === null || authorHandle !== match[1] || capturedEpochMs === undefined
    || capturedEpochMs < cutoffEpochMs || capturedEpochMs < faceStartedEpochMs || capturedEpochMs >= faceCompletedEpochMs
    || parseStamp(publishedAt) === undefined) return undefined
  const body = parseBody(value.body, batch)
  if (body === undefined) return undefined
  return Object.freeze({ sourceUrl, body, occurrenceOrdinal: ordinal, capturedAt, authorHandle, publishedAt })
}

function parseComplete(
  raw: unknown,
  request: Request,
  cutoffEpochMs: number,
  deadlineEpochMs: number,
  signal: AbortSignal,
): Readonly<{ readonly kind: 'complete'; readonly window: unknown; readonly close: () => Promise<void> }> | undefined {
  if (!isRecord(raw) || !hasExactKeys(raw, [
    'schemaVersion', 'kind', 'requestId', 'cutoff', 'shanghaiDay', 'startedAt', 'completedAt', 'surfaces',
  ]) || raw.schemaVersion !== 1 || raw.kind !== 'complete' || raw.requestId !== request.requestId
    || raw.cutoff !== request.cutoff || raw.shanghaiDay !== request.shanghaiDay || !Array.isArray(raw.surfaces)
    || raw.surfaces.length !== SURFACES.length) return undefined
  const startedEpochMs = parseStamp(raw.startedAt)
  const completedEpochMs = parseStamp(raw.completedAt)
  if (startedEpochMs === undefined || completedEpochMs === undefined || startedEpochMs < cutoffEpochMs
    || completedEpochMs <= startedEpochMs || completedEpochMs >= deadlineEpochMs) return undefined
  const batch = createBatch(signal)
  if (batch === undefined) return undefined
  const outputFaces: unknown[] = []
  let previousCompletedEpochMs = cutoffEpochMs
  let totalOccurrences = 0
  try {
    for (let ordinal = 0; ordinal < SURFACES.length; ordinal += 1) {
      const value = raw.surfaces[ordinal]
      const expectedSurface = SURFACES[ordinal]
      if (!isRecord(value) || expectedSurface === undefined || !hasExactKeys(value, [
        'kind', 'surface', 'surfaceOrdinal', 'startedAt', 'completedAt', 'occurrences',
      ]) || (value.kind !== 'complete' && value.kind !== 'natural_zero') || value.surface !== expectedSurface
        || value.surfaceOrdinal !== ordinal || !Array.isArray(value.occurrences)
        || value.occurrences.length > MAX_SURFACE_OCCURRENCES
        || (value.kind === 'natural_zero' && value.occurrences.length !== 0)
        || (value.kind === 'complete' && value.occurrences.length === 0)) throw new Error()
      const faceStartedEpochMs = parseStamp(value.startedAt)
      const faceCompletedEpochMs = parseStamp(value.completedAt)
      if (faceStartedEpochMs === undefined || faceCompletedEpochMs === undefined
        || faceStartedEpochMs < previousCompletedEpochMs || faceCompletedEpochMs <= faceStartedEpochMs
        || faceCompletedEpochMs > completedEpochMs || faceCompletedEpochMs >= deadlineEpochMs) throw new Error()
      const outputOccurrences: unknown[] = []
      for (let itemOrdinal = 0; itemOrdinal < value.occurrences.length; itemOrdinal += 1) {
        totalOccurrences += 1
        if (totalOccurrences > MAX_TOTAL_OCCURRENCES) throw new Error()
        const occurrence = parseOccurrence(
          value.occurrences[itemOrdinal],
          itemOrdinal,
          cutoffEpochMs,
          faceStartedEpochMs,
          faceCompletedEpochMs,
          batch,
        )
        if (occurrence === undefined) throw new Error()
        outputOccurrences.push(occurrence)
      }
      outputFaces.push(Object.freeze({
        kind: value.kind,
        surface: expectedSurface,
        surfaceOrdinal: ordinal,
        startedAt: value.startedAt,
        completedAt: value.completedAt,
        occurrences: Object.freeze(outputOccurrences),
      }))
      previousCompletedEpochMs = faceCompletedEpochMs
    }
  } catch {
    closeBatch(batch)
    return undefined
  }
  const window = Object.freeze({
    requestId: request.requestId,
    cutoff: request.cutoff,
    shanghaiDay: request.shanghaiDay,
    startedAt: raw.startedAt,
    completedAt: raw.completedAt,
    surfaces: Object.freeze(outputFaces),
  })
  const close = (): Promise<void> => {
    closeBatch(batch)
    return Promise.resolve()
  }
  Object.freeze(close)
  return Object.freeze({ kind: 'complete', window, close })
}

async function runExecFile(request: CommandRequest): Promise<CommandResult> {
  const result = await execFile(request.file, [...request.args], {
    cwd: request.cwd,
    encoding: 'utf8',
    timeout: request.timeoutMs,
    maxBuffer: request.maxBuffer,
    shell: request.shell,
    signal: request.signal,
  })
  return { stdout: result.stdout, stderr: result.stderr }
}

function parseOutput(result: CommandResult): unknown {
  if (result.stderr !== '' || !result.stdout.endsWith('\n')) return undefined
  const line = result.stdout.slice(0, -1)
  if (line === '' || line.includes('\n') || line.includes('\r')) return undefined
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}

export function createPersonalFeedXSurfaceObserver(options: unknown): Readonly<{
  readonly observe: (input: unknown) => Promise<unknown>
}> {
  if (!isRecord(options)) throw new TypeError('personal Feed X observer options are invalid')
  const pythonBin = options.pythonBin
  const observerCliPath = options.observerCliPath
  const clock = options.clock
  const run = options.run ?? runExecFile
  if (typeof pythonBin !== 'string' || !isAbsolute(pythonBin) || pythonBin.includes('\0')
    || typeof observerCliPath !== 'string' || !isAbsolute(observerCliPath) || observerCliPath.includes('\0')
    || basename(observerCliPath) !== 'x_personal_feed_observer_cli.py'
    || !isRecord(clock) || typeof clock.now !== 'function' || typeof run !== 'function') {
    throw new TypeError('personal Feed X observer options are invalid')
  }

  const observe = async (input: unknown): Promise<unknown> => {
    if (!isRecord(input) || !hasExactKeys(input, ['request', 'signal']) || !(input.signal instanceof AbortSignal)) return INCOMPLETE
    const signal = input.signal
    const parsed = parseRequest(input.request)
    if (parsed === undefined || signal.aborted) return INCOMPLETE
    const startedNow = nowEpochMs(clock as Clock)
    if (startedNow === undefined || startedNow < parsed.cutoffEpochMs || startedNow >= parsed.deadlineEpochMs) return INCOMPLETE
    const timeoutMs = Math.floor(parsed.deadlineEpochMs - startedNow)
    const wire = JSON.stringify({ schemaVersion: 1, ...parsed.request, deadlineEpochMs: parsed.deadlineEpochMs })
    let commandResult: CommandResult
    try {
      commandResult = await (run as CommandRunner)(Object.freeze({
        file: pythonBin,
        args: Object.freeze([observerCliPath, wire]),
        cwd: dirname(observerCliPath),
        timeoutMs,
        maxBuffer: MAX_BUFFER,
        shell: false,
        signal,
      }))
    } catch {
      return INCOMPLETE
    }
    if (signal.aborted) return INCOMPLETE
    const raw = parseOutput(commandResult)
    const complete = parseComplete(raw, parsed.request, parsed.cutoffEpochMs, parsed.deadlineEpochMs, signal)
    if (complete === undefined) return INCOMPLETE
    const completedNow = nowEpochMs(clock as Clock)
    if (completedNow === undefined || completedNow >= parsed.deadlineEpochMs || signal.aborted) {
      await complete.close()
      return INCOMPLETE
    }
    return complete
  }

  Object.freeze(observe)
  return Object.freeze({ observe })
}
