import { isAbsolute } from 'node:path'
import { appendJsonLine, readJsonLines } from '../durable-jsonl-store.ts'
import { encodeCanonicalJson } from '../canonical-json.ts'
import { canonicalizeXStatusIdentity } from './x-status-identity.ts'

const SURFACES = ['for_you', 'following', 'explore'] as const
const MAX_SURFACE_OCCURRENCES = 8
const MAX_TOTAL_OCCURRENCES = 24
const MAX_BODY_BYTES = 6_144
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1_000
const DAY_MS = 24 * 60 * 60 * 1_000
const INCOMPLETE = Object.freeze({ kind: 'incomplete' as const })
const NONE = Object.freeze({ kind: 'none' as const })
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

type Surface = (typeof SURFACES)[number]
type PlainRecord = Record<string, unknown>
type Judgment = 'qualified' | 'not_qualified'

export interface PersonalFeedV2CandidateStateClock {
  readonly now: () => Date
}

export interface CreatePersonalFeedV2CandidateStateOwnerOptions {
  readonly statePath: string
  readonly clock: PersonalFeedV2CandidateStateClock
}

export interface PersonalFeedV2CandidateProvenance {
  readonly capturedAt: string
  readonly surface: Surface
  readonly surfaceOrdinal: number
  readonly occurrenceOrdinal: number
  readonly canonicalUrl: string
  readonly authorHandle: string
  readonly publishedAt: string
}

export interface PersonalFeedV2CandidateForJudgment {
  readonly stableId: string
  readonly canonicalUrl: string
  readonly body: string
  readonly provenance: readonly PersonalFeedV2CandidateProvenance[]
}

export type PersonalFeedV2CandidateJudgmentResult =
  | { readonly kind: 'qualified' }
  | { readonly kind: 'not_qualified' }
  | { readonly kind: 'incomplete' }

export type PersonalFeedV2CandidateStateResult =
  | { readonly kind: 'selected'; readonly stableId: string; readonly canonicalUrl: string }
  | { readonly kind: 'none' }
  | { readonly kind: 'incomplete' }

export interface PersonalFeedV2CandidateStateInput {
  readonly request: Readonly<{ readonly requestId: string; readonly cutoff: string; readonly shanghaiDay: string }>
  readonly window: unknown
  readonly signal: AbortSignal
  readonly judgeOne: (candidate: PersonalFeedV2CandidateForJudgment) => PersonalFeedV2CandidateJudgmentResult | Promise<PersonalFeedV2CandidateJudgmentResult>
}

export interface PersonalFeedV2CandidateStateOwner {
  readonly evaluate: (input: PersonalFeedV2CandidateStateInput) => Promise<PersonalFeedV2CandidateStateResult>
}

export type PersonalFeedV2CandidateStateRecord =
  | {
      readonly schemaVersion: 1
      readonly event: 'candidate_first_captured'
      readonly stableId: string
      readonly firstCapturedAt: string
    }
  | {
      readonly schemaVersion: 1
      readonly event: 'candidate_processed'
      readonly stableId: string
      readonly judgment: Judgment
      readonly processedAt: string
    }

type Request = PersonalFeedV2CandidateStateInput['request']
type CloseHandle = Readonly<{ readonly receiver: object; readonly close: () => unknown }>
type TakeHandle = Readonly<{ readonly receiver: object; readonly take: (input: { readonly signal: AbortSignal }) => unknown }>
type ParsedOccurrence = Readonly<{
  readonly stableId: string
  readonly canonicalUrl: string
  readonly capturedAtEpochMs: number
  readonly provenance: PersonalFeedV2CandidateProvenance
  readonly take?: TakeHandle
}>
type ProjectedCandidate = {
  readonly stableId: string
  readonly canonicalUrl: string
  readonly firstCapturedAt: string
  readonly firstCapturedAtEpochMs: number
  readonly provenance: PersonalFeedV2CandidateProvenance[]
  take?: TakeHandle
}
type CandidateState = {
  readonly firstCapturedAt: string
  readonly firstCapturedAtEpochMs: number
  processed?: Judgment
}
type ParsedState = {
  readonly records: PersonalFeedV2CandidateStateRecord[]
  readonly byStableId: Map<string, CandidateState>
}

function isRecord(value: unknown): value is PlainRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exact(value: PlainRecord, keys: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value)
  return actual.length === keys.length && actual.every(key => typeof key === 'string' && keys.includes(key))
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

function validStableId(value: unknown): value is string {
  return typeof value === 'string' && /^x-status:[1-9]\d*$/.test(value)
}

function parseRequest(value: unknown): Request | undefined {
  if (!isRecord(value) || !exact(value, ['requestId', 'cutoff', 'shanghaiDay'])
    || typeof value.requestId !== 'string' || typeof value.cutoff !== 'string' || typeof value.shanghaiDay !== 'string'
    || !/^telegram:-?[1-9]\d*:[1-9]\d*$/.test(value.requestId) || !/^\d{4}-\d{2}-\d{2}$/.test(value.shanghaiDay)) return undefined
  const cutoff = parseStamp(value.cutoff)
  if (cutoff === undefined || shanghaiDay(cutoff) !== value.shanghaiDay) return undefined
  return Object.freeze({ requestId: value.requestId, cutoff: value.cutoff, shanghaiDay: value.shanghaiDay })
}

function collectCloseHandles(windowValue: unknown): CloseHandle[] {
  const handles: CloseHandle[] = []
  try {
    if (!isRecord(windowValue) || !Array.isArray(windowValue.surfaces)) return handles
    for (const face of windowValue.surfaces) {
      if (!isRecord(face) || !Array.isArray(face.occurrences)) continue
      for (const rawOccurrence of face.occurrences) {
        if (!isRecord(rawOccurrence) || !isRecord(rawOccurrence.body)) continue
        const rawBody = rawOccurrence.body
        const receiver = rawBody.kind === 'sufficient' && isRecord(rawBody.capture) ? rawBody.capture : rawBody
        if (typeof receiver.close === 'function') handles.push({ receiver, close: receiver.close as () => unknown })
      }
    }
  } catch {
    return handles
  }
  return handles
}

function parseOccurrence(
  value: unknown,
  surface: Surface,
  surfaceOrdinal: number,
  occurrenceOrdinal: number,
  cutoffEpochMs: number,
  faceStartedEpochMs: number,
  faceCompletedEpochMs: number,
): ParsedOccurrence | undefined {
  if (!isRecord(value) || !exact(value, ['sourceUrl', 'body', 'occurrenceOrdinal', 'capturedAt', 'authorHandle', 'publishedAt'])
    || value.occurrenceOrdinal !== occurrenceOrdinal || typeof value.sourceUrl !== 'string'
    || typeof value.authorHandle !== 'string' || typeof value.capturedAt !== 'string' || typeof value.publishedAt !== 'string') return undefined
  const canonicalUrl = canonicalizeXStatusIdentity(value.sourceUrl)
  const capturedAtEpochMs = parseStamp(value.capturedAt)
  const publishedAtEpochMs = parseStamp(value.publishedAt)
  if (canonicalUrl === undefined || canonicalUrl !== value.sourceUrl
    || canonicalUrl.split('/')[3] !== value.authorHandle || capturedAtEpochMs === undefined || publishedAtEpochMs === undefined
    || publishedAtEpochMs > capturedAtEpochMs || capturedAtEpochMs < cutoffEpochMs
    || capturedAtEpochMs < faceStartedEpochMs || capturedAtEpochMs >= faceCompletedEpochMs || !isRecord(value.body)) return undefined
  const statusId = canonicalUrl.split('/')[5]
  if (statusId === undefined) return undefined
  let take: TakeHandle | undefined
  if (value.body.kind === 'sufficient' && exact(value.body, ['kind', 'capture']) && isRecord(value.body.capture)
    && exact(value.body.capture, ['take', 'close']) && typeof value.body.capture.take === 'function' && typeof value.body.capture.close === 'function') {
    take = { receiver: value.body.capture, take: value.body.capture.take as TakeHandle['take'] }
  } else if ((value.body.kind === 'insufficient' || value.body.kind === 'failed' || value.body.kind === 'unknown')
    && exact(value.body, ['kind', 'close']) && typeof value.body.close === 'function') {
    take = undefined
  } else return undefined
  const provenance = Object.freeze({
    capturedAt: value.capturedAt,
    surface,
    surfaceOrdinal,
    occurrenceOrdinal,
    canonicalUrl,
    authorHandle: value.authorHandle,
    publishedAt: value.publishedAt,
  })
  return Object.freeze({ stableId: `x-status:${statusId}`, canonicalUrl, capturedAtEpochMs, provenance, ...(take === undefined ? {} : { take }) })
}

function parseWindow(value: unknown, request: Request): ProjectedCandidate[] | undefined {
  if (!isRecord(value) || !exact(value, ['requestId', 'cutoff', 'shanghaiDay', 'startedAt', 'completedAt', 'surfaces'])
    || value.requestId !== request.requestId || value.cutoff !== request.cutoff || value.shanghaiDay !== request.shanghaiDay
    || !Array.isArray(value.surfaces) || value.surfaces.length !== SURFACES.length) return undefined
  const cutoffEpochMs = parseStamp(request.cutoff)
  const startedAtEpochMs = parseStamp(value.startedAt)
  const completedAtEpochMs = parseStamp(value.completedAt)
  if (cutoffEpochMs === undefined || startedAtEpochMs === undefined || completedAtEpochMs === undefined
    || startedAtEpochMs < cutoffEpochMs || completedAtEpochMs <= startedAtEpochMs) return undefined
  const ordered: ProjectedCandidate[] = []
  const byStableId = new Map<string, ProjectedCandidate>()
  let previousCompleted = cutoffEpochMs
  let total = 0
  for (let surfaceOrdinal = 0; surfaceOrdinal < SURFACES.length; surfaceOrdinal += 1) {
    const surface = SURFACES[surfaceOrdinal]
    const face = value.surfaces[surfaceOrdinal]
    if (surface === undefined || !isRecord(face) || !exact(face, ['kind', 'surface', 'surfaceOrdinal', 'startedAt', 'completedAt', 'occurrences'])
      || face.surface !== surface || face.surfaceOrdinal !== surfaceOrdinal
      || (face.kind !== 'complete' && face.kind !== 'natural_zero') || !Array.isArray(face.occurrences)
      || face.occurrences.length > MAX_SURFACE_OCCURRENCES
      || (face.kind === 'natural_zero' && face.occurrences.length !== 0)
      || (face.kind === 'complete' && face.occurrences.length === 0)) return undefined
    const faceStarted = parseStamp(face.startedAt)
    const faceCompleted = parseStamp(face.completedAt)
    if (faceStarted === undefined || faceCompleted === undefined || faceStarted < previousCompleted
      || faceCompleted <= faceStarted || faceCompleted > completedAtEpochMs) return undefined
    for (let occurrenceOrdinal = 0; occurrenceOrdinal < face.occurrences.length; occurrenceOrdinal += 1) {
      total += 1
      if (total > MAX_TOTAL_OCCURRENCES) return undefined
      const occurrence = parseOccurrence(
        face.occurrences[occurrenceOrdinal], surface, surfaceOrdinal, occurrenceOrdinal,
        cutoffEpochMs, faceStarted, faceCompleted,
      )
      if (occurrence === undefined) return undefined
      const current = byStableId.get(occurrence.stableId)
      if (current === undefined) {
        const candidate: ProjectedCandidate = {
          stableId: occurrence.stableId,
          canonicalUrl: occurrence.canonicalUrl,
          firstCapturedAt: occurrence.provenance.capturedAt,
          firstCapturedAtEpochMs: occurrence.capturedAtEpochMs,
          provenance: [occurrence.provenance],
          ...(occurrence.take === undefined ? {} : { take: occurrence.take }),
        }
        ordered.push(candidate)
        byStableId.set(candidate.stableId, candidate)
      } else {
        current.provenance.push(occurrence.provenance)
        if (current.take === undefined && occurrence.take !== undefined) current.take = occurrence.take
      }
    }
    previousCompleted = faceCompleted
  }
  return ordered
}

function parseState(path: string): ParsedState | undefined {
  try {
    const records: PersonalFeedV2CandidateStateRecord[] = []
    const byStableId = new Map<string, CandidateState>()
    for (const value of readJsonLines(path, 'v2 candidate-state')) {
      if (!isRecord(value) || value.schemaVersion !== 1 || !validStableId(value.stableId)) return undefined
      if (value.event === 'candidate_first_captured' && exact(value, ['schemaVersion', 'event', 'stableId', 'firstCapturedAt'])) {
        const epochMs = parseStamp(value.firstCapturedAt)
        if (epochMs === undefined || byStableId.has(value.stableId)) return undefined
        const record = value as unknown as PersonalFeedV2CandidateStateRecord
        records.push(record)
        byStableId.set(value.stableId, { firstCapturedAt: value.firstCapturedAt as string, firstCapturedAtEpochMs: epochMs })
      } else if (value.event === 'candidate_processed' && exact(value, ['schemaVersion', 'event', 'stableId', 'judgment', 'processedAt'])
        && (value.judgment === 'qualified' || value.judgment === 'not_qualified')) {
        const state = byStableId.get(value.stableId)
        const processedAt = parseStamp(value.processedAt)
        if (state === undefined || state.processed !== undefined || processedAt === undefined || processedAt < state.firstCapturedAtEpochMs) return undefined
        state.processed = value.judgment
        records.push(value as unknown as PersonalFeedV2CandidateStateRecord)
      } else return undefined
    }
    return { records, byStableId }
  } catch {
    return undefined
  }
}

function serialize(value: unknown): string {
  const encoded = encodeCanonicalJson(value)
  if (encoded === undefined) throw new TypeError('candidate state record is invalid')
  return encoded
}

function appendState(path: string, state: ParsedState, record: PersonalFeedV2CandidateStateRecord): boolean {
  try {
    appendJsonLine(path, state.records, record, serialize)
    state.records.push(record)
    return true
  } catch {
    return false
  }
}

function readClock(clock: PersonalFeedV2CandidateStateClock): Date | undefined {
  try {
    const value = clock.now()
    return value instanceof Date && Number.isFinite(value.getTime()) ? new Date(value.getTime()) : undefined
  } catch {
    return undefined
  }
}

function shanghaiDay(epochMs: number): string {
  return new Date(epochMs + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10)
}

function deadlineExclusive(firstCapturedAtEpochMs: number): number {
  const day = shanghaiDay(firstCapturedAtEpochMs)
  const localMidnightUtc = Date.parse(`${day}T00:00:00.000Z`)
  return localMidnightUtc + 7 * DAY_MS - SHANGHAI_OFFSET_MS
}

function exactJudgment(value: unknown): Judgment | undefined {
  if (!isRecord(value) || !exact(value, ['kind'])) return undefined
  return value.kind === 'qualified' || value.kind === 'not_qualified' ? value.kind : undefined
}

async function closeAll(handles: readonly CloseHandle[]): Promise<boolean> {
  const results = await Promise.allSettled(handles.map(async handle => {
    await Reflect.apply(handle.close, handle.receiver, [])
  }))
  return results.every(result => result.status === 'fulfilled')
}

function frozenCandidate(candidate: ProjectedCandidate, body: string): PersonalFeedV2CandidateForJudgment {
  return Object.freeze({
    stableId: candidate.stableId,
    canonicalUrl: candidate.canonicalUrl,
    body,
    provenance: Object.freeze([...candidate.provenance]),
  })
}

export function createPersonalFeedV2CandidateStateOwner(options: CreatePersonalFeedV2CandidateStateOwnerOptions): PersonalFeedV2CandidateStateOwner {
  if (!isRecord(options) || !exact(options, ['statePath', 'clock']) || typeof options.statePath !== 'string'
    || !isAbsolute(options.statePath) || options.statePath.includes('\0') || !isRecord(options.clock)
    || !exact(options.clock, ['now']) || typeof options.clock.now !== 'function') {
    throw new TypeError('personal Feed v2 candidate-state options are invalid')
  }
  const statePath = options.statePath
  const clock = options.clock as unknown as PersonalFeedV2CandidateStateClock

  const evaluateOne = async (rawInput: unknown): Promise<PersonalFeedV2CandidateStateResult> => {
    const rawWindow = isRecord(rawInput) ? rawInput.window : undefined
    const closeHandles = collectCloseHandles(rawWindow)
    let result: PersonalFeedV2CandidateStateResult = INCOMPLETE
    try {
      if (!isRecord(rawInput) || !exact(rawInput, ['request', 'window', 'signal', 'judgeOne'])
        || !(rawInput.signal instanceof AbortSignal) || typeof rawInput.judgeOne !== 'function') return INCOMPLETE
      const request = parseRequest(rawInput.request)
      const candidates = request === undefined ? undefined : parseWindow(rawInput.window, request)
      if (request === undefined || candidates === undefined || rawInput.signal.aborted) return INCOMPLETE
      const state = parseState(statePath)
      if (state === undefined) return INCOMPLETE

      for (const candidate of candidates) {
        const existing = state.byStableId.get(candidate.stableId)
        if (existing !== undefined && candidate.firstCapturedAtEpochMs < existing.firstCapturedAtEpochMs) return INCOMPLETE
        if (existing === undefined) {
          const record = Object.freeze({
            schemaVersion: 1 as const,
            event: 'candidate_first_captured' as const,
            stableId: candidate.stableId,
            firstCapturedAt: candidate.firstCapturedAt,
          })
          if (!appendState(statePath, state, record)) return INCOMPLETE
          state.byStableId.set(candidate.stableId, {
            firstCapturedAt: candidate.firstCapturedAt,
            firstCapturedAtEpochMs: candidate.firstCapturedAtEpochMs,
          })
        }
      }

      for (const candidate of candidates) {
        if (rawInput.signal.aborted) return INCOMPLETE
        const stateValue = state.byStableId.get(candidate.stableId)
        if (stateValue === undefined) return INCOMPLETE
        if (stateValue.processed !== undefined) continue
        const nowBeforeTake = readClock(clock)
        if (nowBeforeTake === undefined || nowBeforeTake.getTime() >= deadlineExclusive(stateValue.firstCapturedAtEpochMs)
          || candidate.take === undefined) return INCOMPLETE
        let body: unknown
        try {
          body = Reflect.apply(candidate.take.take, candidate.take.receiver, [{ signal: rawInput.signal }])
        } catch {
          return INCOMPLETE
        }
        if (rawInput.signal.aborted || typeof body !== 'string' || body.trim() === ''
          || new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) return INCOMPLETE
        let judged: unknown
        try {
          judged = await Reflect.apply(rawInput.judgeOne, undefined, [frozenCandidate(candidate, body)])
        } catch {
          return INCOMPLETE
        }
        if (rawInput.signal.aborted) return INCOMPLETE
        const judgment = exactJudgment(judged)
        if (judgment === undefined) return INCOMPLETE
        const processedAt = readClock(clock)
        if (processedAt === undefined || processedAt.getTime() >= deadlineExclusive(stateValue.firstCapturedAtEpochMs)) return INCOMPLETE
        const record = Object.freeze({
          schemaVersion: 1 as const,
          event: 'candidate_processed' as const,
          stableId: candidate.stableId,
          judgment,
          processedAt: processedAt.toISOString(),
        })
        if (!appendState(statePath, state, record)) return INCOMPLETE
        stateValue.processed = judgment
        if (judgment === 'qualified') {
          result = Object.freeze({ kind: 'selected', stableId: candidate.stableId, canonicalUrl: candidate.canonicalUrl })
          break
        }
      }
      if (result.kind !== 'selected') result = NONE
    } catch {
      result = INCOMPLETE
    } finally {
      if (!await closeAll(closeHandles)) result = INCOMPLETE
    }
    return result
  }

  let queue: Promise<unknown> = Promise.resolve()
  const evaluate = (input: PersonalFeedV2CandidateStateInput): Promise<PersonalFeedV2CandidateStateResult> => {
    const current = queue.then(() => evaluateOne(input), () => evaluateOne(input))
    queue = current.then(() => undefined, () => undefined)
    return current
  }
  Object.freeze(evaluate)
  return Object.freeze({ evaluate })
}
