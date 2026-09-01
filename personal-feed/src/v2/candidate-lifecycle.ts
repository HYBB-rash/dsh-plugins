import { readFileSync } from 'node:fs'
import { PersonalFeedScopeInputError } from '../errors.ts'
import type { PersonalFeedV2Clock, PersonalFeedV2Request } from './request-coordinator.ts'

export interface CreatePersonalFeedV2CandidateLifecycleOptions {
  readonly completionLedgerPath: string
  readonly clock: PersonalFeedV2Clock
  readonly processedQuery?: PersonalFeedV2ProcessedQuery
}

export interface PersonalFeedV2ProcessedQueryInput {
  readonly stableId: string
}

export type PersonalFeedV2ProcessedQueryResult =
  | { readonly kind: 'processed' }
  | { readonly kind: 'unprocessed' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'aborted' }

export type PersonalFeedV2ProcessedQuery = (
  input: PersonalFeedV2ProcessedQueryInput,
  signal: AbortSignal,
) => PersonalFeedV2ProcessedQueryResult | Promise<PersonalFeedV2ProcessedQueryResult>

export interface PersonalFeedV2CandidateAdmitInput {
  readonly request: PersonalFeedV2Request
  readonly window: unknown
  readonly signal: AbortSignal
}

export interface PersonalFeedV2CandidateProvenance {
  readonly capturedAt: string
  readonly surface: 'for_you' | 'following' | 'explore'
  readonly surfaceOrdinal: number
  readonly occurrenceOrdinal: number
  readonly canonicalUrl: string
  readonly authorHandle: string
  readonly publishedAt: string
}

export interface PersonalFeedV2CandidateLease {
  readonly stableId: string
  readonly canonicalUrl: string
  readonly position: number
  readonly body: string
  readonly provenance: PersonalFeedV2CandidateProvenance
}

export type PersonalFeedV2CandidateIncompleteReason =
  | 'aborted'
  | 'body_failed'
  | 'body_insufficient'
  | 'body_unknown'
  | 'capture_failed'
  | 'clock_failed'
  | 'expired'
  | 'invalid_input'
  | 'processed_query_aborted'
  | 'processed_query_failed'
  | 'processed_query_unknown'

export interface PersonalFeedV2CandidateIncomplete {
  readonly kind: 'incomplete'
  readonly reason: PersonalFeedV2CandidateIncompleteReason
}

export type PersonalFeedV2CandidateBorrowResult =
  | { readonly kind: 'candidate'; readonly lease: PersonalFeedV2CandidateLease }
  | { readonly kind: 'done' }
  | PersonalFeedV2CandidateIncomplete

export interface PersonalFeedV2CandidateCursor {
  readonly borrowCurrent: (input: { readonly signal: AbortSignal }) => Promise<PersonalFeedV2CandidateBorrowResult>
  readonly close: (reason: string) => Promise<void>
}

export type PersonalFeedV2CandidateAdmitResult =
  | { readonly kind: 'admitted'; readonly cursor: PersonalFeedV2CandidateCursor }
  | PersonalFeedV2CandidateIncomplete

export interface PersonalFeedV2CandidateLifecycle {
  readonly admit: (input: PersonalFeedV2CandidateAdmitInput) => Promise<PersonalFeedV2CandidateAdmitResult>
}

type SurfaceName = PersonalFeedV2CandidateProvenance['surface']

interface CaptureCloseHandle {
  readonly owner: object
  readonly close: (reason: string) => unknown
  closed: boolean
}

interface ParsedBodyCapture {
  readonly kind: 'sufficient' | 'insufficient' | 'failed' | 'unknown'
  readonly handle: CaptureCloseHandle
  readonly take?: (input: { readonly signal: AbortSignal }) => unknown
}

interface ParsedOccurrence {
  readonly stableId: string
  readonly canonicalUrl: string
  readonly capturedAt: string
  readonly surface: SurfaceName
  readonly surfaceOrdinal: number
  readonly occurrenceOrdinal: number
  readonly authorHandle: string
  readonly publishedAt: string
  readonly body: ParsedBodyCapture
}

interface ParsedWindow {
  readonly shanghaiDay: string
  readonly occurrences: readonly ParsedOccurrence[]
}

interface SelectedCapture {
  readonly position: number
  readonly occurrence: ParsedOccurrence
}

interface CursorCandidate {
  readonly lease: PersonalFeedV2CandidateLease
  readonly handle: CaptureCloseHandle
  readonly deadlineExclusive: number
}

const SURFACES = ['for_you', 'following', 'explore'] as const
const ALLOWED_X_HOSTS = new Set(['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'])
const SHANGHAI_OFFSET_MILLISECONDS = 8 * 60 * 60 * 1000
const DONE_RESULT: PersonalFeedV2CandidateBorrowResult = Object.freeze({ kind: 'done' })
const DEFAULT_UNPROCESSED_RESULT: PersonalFeedV2ProcessedQueryResult = Object.freeze({ kind: 'unprocessed' })

export function createPersonalFeedV2CandidateLifecycle(
  options: CreatePersonalFeedV2CandidateLifecycleOptions,
): PersonalFeedV2CandidateLifecycle {
  if (!isRecord(options)
    || (!hasExactlyKeys(options, ['completionLedgerPath', 'clock'])
      && !hasExactlyKeys(options, ['completionLedgerPath', 'clock', 'processedQuery']))
    || typeof options.completionLedgerPath !== 'string' || options.completionLedgerPath.trim() === ''
    || !isRecord(options.clock) || !hasExactlyKeys(options.clock, ['now'])
    || typeof options.clock.now !== 'function'
    || (Object.prototype.hasOwnProperty.call(options, 'processedQuery')
      && typeof options.processedQuery !== 'function')) {
    throw new PersonalFeedScopeInputError('personal Feed v2 candidate lifecycle options are invalid')
  }
  const completionLedgerPath = options.completionLedgerPath
  const clock = options.clock
  const processedQuery = options.processedQuery

  const admit = async (input: PersonalFeedV2CandidateAdmitInput): Promise<PersonalFeedV2CandidateAdmitResult> => {
    const handles = collectCloseHandles(isRecord(input) ? input.window : undefined)
    const fail = async (reason: PersonalFeedV2CandidateIncompleteReason): Promise<PersonalFeedV2CandidateIncomplete> => {
      await closeHandles(handles, reason)
      return incomplete(reason)
    }

    if (!isRecord(input) || !hasExactlyKeys(input, ['request', 'window', 'signal'])
      || !isAbortSignal(input.signal)) {
      return fail('invalid_input')
    }
    if (input.signal.aborted) return fail('aborted')

    const request = parseRequest(input.request)
    const now = readClock(clock)
    if (now === undefined) return fail('clock_failed')
    const parsed = request === undefined
      ? undefined
      : parseWindow(input.window, request, now, handles)
    if (parsed === undefined) return fail('invalid_input')

    const occurrencesByIdentity = new Map<string, ParsedOccurrence[]>()
    for (const occurrence of parsed.occurrences) {
      const grouped = occurrencesByIdentity.get(occurrence.stableId)
      if (grouped === undefined) occurrencesByIdentity.set(occurrence.stableId, [occurrence])
      else grouped.push(occurrence)
    }

    const defaultQueryResult = processedQuery === undefined
      ? readDefaultProcessedState(completionLedgerPath)
      : DEFAULT_UNPROCESSED_RESULT
    if (defaultQueryResult === undefined) return fail('processed_query_failed')

    const selected: SelectedCapture[] = []
    for (const [stableId, occurrences] of occurrencesByIdentity) {
      if (input.signal.aborted) return fail('aborted')
      let queried: PersonalFeedV2ProcessedQueryResult
      if (processedQuery === undefined) {
        queried = defaultQueryResult
      } else {
        const queryInput: PersonalFeedV2ProcessedQueryInput = Object.freeze({ stableId })
        let parsedQuery: PersonalFeedV2ProcessedQueryResult | undefined
        try {
          const raw = await processedQuery(queryInput, input.signal)
          parsedQuery = parseProcessedQueryResult(raw)
        } catch {
          return fail('processed_query_failed')
        }
        if (parsedQuery === undefined) return fail('processed_query_failed')
        queried = parsedQuery
      }

      if (queried.kind === 'failed') return fail('processed_query_failed')
      if (queried.kind === 'unknown') return fail('processed_query_unknown')
      if (queried.kind === 'aborted') return fail('processed_query_aborted')
      if (input.signal.aborted) return fail('aborted')
      if (queried.kind === 'processed') {
        if (!await closeHandles(occurrences.map(occurrence => occurrence.body.handle), 'processed')) {
          return fail('capture_failed')
        }
        continue
      }
      const firstSufficient = occurrences.find(occurrence => occurrence.body.kind === 'sufficient')
      if (firstSufficient === undefined) return fail(bodyUnavailableReason(occurrences))
      const duplicateHandles = occurrences
        .filter(occurrence => occurrence !== firstSufficient)
        .map(occurrence => occurrence.body.handle)
      if (!await closeHandles(duplicateHandles, 'duplicate')) return fail('capture_failed')
      selected.push({ position: selected.length, occurrence: firstSufficient })
    }
    const selectedHandles = new Set(selected.map(capture => capture.occurrence.body.handle))
    const unusedHandles = handles.filter(handle => !selectedHandles.has(handle))
    if (!await closeHandles(unusedHandles, 'not_selected')) {
      await closeHandles(handles, 'capture_failed')
      return incomplete('capture_failed')
    }
    if (input.signal.aborted) return fail('aborted')

    const deadlineExclusive = deadlineExclusiveForShanghaiDay(parsed.shanghaiDay)
    const beforeTake = readClock(clock)
    if (beforeTake === undefined) return fail('clock_failed')
    if (beforeTake.getTime() >= deadlineExclusive) return fail('expired')

    const candidates: CursorCandidate[] = []
    try {
      for (const capture of selected) {
        if (input.signal.aborted) return fail('aborted')
        const take = capture.occurrence.body.take
        if (take === undefined) return fail('capture_failed')
        const body = await take({ signal: input.signal })
        if (input.signal.aborted) return fail('aborted')
        if (typeof body !== 'string' || body.trim() === '') return fail('capture_failed')
        candidates.push({
          lease: candidateLease(capture, body),
          handle: capture.occurrence.body.handle,
          deadlineExclusive,
        })
      }
    } catch {
      return fail(input.signal.aborted ? 'aborted' : 'capture_failed')
    }

    const cursor = createCursor(candidates, clock)
    return Object.freeze({ kind: 'admitted', cursor })
  }

  return Object.freeze({ admit })
}

function readDefaultProcessedState(path: string): PersonalFeedV2ProcessedQueryResult | undefined {
  try {
    return readFileSync(path, 'utf8') === '' ? DEFAULT_UNPROCESSED_RESULT : undefined
  } catch (cause) {
    return hasErrorCode(cause, 'ENOENT') ? DEFAULT_UNPROCESSED_RESULT : undefined
  }
}

function parseProcessedQueryResult(value: unknown): PersonalFeedV2ProcessedQueryResult | undefined {
  if (!isRecord(value) || !hasExactlyKeys(value, ['kind'])) return undefined
  if (value.kind !== 'processed' && value.kind !== 'unprocessed' && value.kind !== 'failed'
    && value.kind !== 'unknown' && value.kind !== 'aborted') return undefined
  return Object.freeze({ kind: value.kind }) as PersonalFeedV2ProcessedQueryResult
}

function hasErrorCode(value: unknown, expected: string): boolean {
  if (typeof value !== 'object' || value === null) return false
  return (value as { readonly code?: unknown }).code === expected
}

function createCursor(
  candidates: readonly CursorCandidate[],
  clock: PersonalFeedV2Clock,
): PersonalFeedV2CandidateCursor {
  let closed = false

  const close = async (reason: string): Promise<void> => {
    if (closed) return
    closed = true
    const safeReason = reason === 'consumed' || reason === 'expired' ? reason : 'cursor_closed'
    await closeHandles(candidates.map(candidate => candidate.handle), safeReason)
  }

  const borrowCurrent = async (
    input: { readonly signal: AbortSignal },
  ): Promise<PersonalFeedV2CandidateBorrowResult> => {
    if (closed) return DONE_RESULT
    if (!isRecord(input) || !hasExactlyKeys(input, ['signal']) || !isAbortSignal(input.signal)) {
      await close('invalid_input')
      return incomplete('invalid_input')
    }
    if (input.signal.aborted) {
      await close('aborted')
      return incomplete('aborted')
    }
    const now = readClock(clock)
    if (now === undefined) {
      await close('clock_failed')
      return incomplete('clock_failed')
    }
    const candidate = candidates[0]
    if (candidate === undefined) return DONE_RESULT
    if (now.getTime() >= candidate.deadlineExclusive) {
      await close('expired')
      return incomplete('expired')
    }
    return Object.freeze({ kind: 'candidate', lease: candidate.lease })
  }

  return Object.freeze({ borrowCurrent, close })
}

function candidateLease(capture: SelectedCapture, body: string): PersonalFeedV2CandidateLease {
  const occurrence = capture.occurrence
  const provenance: PersonalFeedV2CandidateProvenance = Object.freeze({
    capturedAt: occurrence.capturedAt,
    surface: occurrence.surface,
    surfaceOrdinal: occurrence.surfaceOrdinal,
    occurrenceOrdinal: occurrence.occurrenceOrdinal,
    canonicalUrl: occurrence.canonicalUrl,
    authorHandle: occurrence.authorHandle,
    publishedAt: occurrence.publishedAt,
  })
  return Object.freeze({
    stableId: occurrence.stableId,
    canonicalUrl: occurrence.canonicalUrl,
    position: capture.position,
    body,
    provenance,
  })
}

function parseRequest(value: unknown): PersonalFeedV2Request | undefined {
  if (!isRecord(value) || !hasExactlyKeys(value, ['requestId', 'cutoff', 'shanghaiDay'])
    || typeof value.requestId !== 'string' || !isCanonicalTelegramRequestId(value.requestId)
    || !isCanonicalIsoInstant(value.cutoff) || !isValidShanghaiDay(value.shanghaiDay)) return undefined
  if (shanghaiDayAt(Date.parse(value.cutoff)) !== value.shanghaiDay) return undefined
  return value as unknown as PersonalFeedV2Request
}

function parseWindow(
  value: unknown,
  request: PersonalFeedV2Request,
  now: Date,
  handles: readonly CaptureCloseHandle[],
): ParsedWindow | undefined {
  if (!isRecord(value) || !hasExactlyKeys(value, ['requestId', 'cutoff', 'shanghaiDay', 'surfaces'])
    || value.requestId !== request.requestId || value.cutoff !== request.cutoff
    || value.shanghaiDay !== request.shanghaiDay || !hasDenseArray(value.surfaces, SURFACES.length)) return undefined

  const handleByOwner = new Map(handles.map(handle => [handle.owner, handle]))
  const usedHandles = new Set<CaptureCloseHandle>()
  const occurrences: ParsedOccurrence[] = []
  for (let surfaceOrdinal = 0; surfaceOrdinal < SURFACES.length; surfaceOrdinal += 1) {
    const expectedSurface = SURFACES[surfaceOrdinal]
    const surface = value.surfaces[surfaceOrdinal]
    if (expectedSurface === undefined || !isRecord(surface)
      || !hasExactlyKeys(surface, ['kind', 'surface', 'surfaceOrdinal', 'occurrences'])
      || surface.kind !== 'complete' || surface.surface !== expectedSurface
      || surface.surfaceOrdinal !== surfaceOrdinal || !hasDenseArray(surface.occurrences)) return undefined

    for (let occurrenceOrdinal = 0; occurrenceOrdinal < surface.occurrences.length; occurrenceOrdinal += 1) {
      const occurrence = surface.occurrences[occurrenceOrdinal]
      if (!isRecord(occurrence) || !hasExactlyKeys(occurrence, [
        'sourceUrl', 'body', 'occurrenceOrdinal', 'capturedAt', 'authorHandle', 'publishedAt',
      ]) || occurrence.occurrenceOrdinal !== occurrenceOrdinal
        || typeof occurrence.authorHandle !== 'string' || occurrence.authorHandle.trim() === ''
        || !isCanonicalIsoInstant(occurrence.publishedAt)
        || !isCanonicalIsoInstant(occurrence.capturedAt)) return undefined

      const capturedAt = Date.parse(occurrence.capturedAt)
      if (capturedAt < Date.parse(request.cutoff) || capturedAt > now.getTime()
        || shanghaiDayAt(capturedAt) !== request.shanghaiDay) return undefined
      const identity = parseXStatusUrl(occurrence.sourceUrl)
      const body = parseBodyCapture(occurrence.body, handleByOwner)
      if (identity === undefined || body === undefined || usedHandles.has(body.handle)) return undefined
      usedHandles.add(body.handle)
      occurrences.push({
        stableId: identity.stableId,
        canonicalUrl: identity.canonicalUrl,
        capturedAt: occurrence.capturedAt,
        surface: expectedSurface,
        surfaceOrdinal,
        occurrenceOrdinal,
        authorHandle: occurrence.authorHandle,
        publishedAt: occurrence.publishedAt,
        body,
      })
    }
  }
  return { shanghaiDay: request.shanghaiDay, occurrences }
}

function parseBodyCapture(
  value: unknown,
  handleByOwner: ReadonlyMap<object, CaptureCloseHandle>,
): ParsedBodyCapture | undefined {
  if (!isRecord(value) || typeof value.kind !== 'string') return undefined
  if (value.kind === 'sufficient') {
    if (!hasExactlyKeys(value, ['kind', 'capture']) || !isRecord(value.capture)
      || !hasExactlyKeys(value.capture, ['take', 'close'])
      || typeof value.capture.take !== 'function' || typeof value.capture.close !== 'function') return undefined
    const handle = handleByOwner.get(value.capture)
    if (handle === undefined) return undefined
    return {
      kind: 'sufficient',
      handle,
      take: input => (value.capture as { readonly take: (input: { readonly signal: AbortSignal }) => unknown }).take(input),
    }
  }
  if (value.kind !== 'insufficient' && value.kind !== 'failed' && value.kind !== 'unknown') return undefined
  if (!hasExactlyKeys(value, ['kind', 'close']) || typeof value.close !== 'function') return undefined
  const handle = handleByOwner.get(value)
  return handle === undefined ? undefined : { kind: value.kind, handle }
}

function bodyUnavailableReason(
  occurrences: readonly ParsedOccurrence[],
): 'body_failed' | 'body_unknown' | 'body_insufficient' {
  if (occurrences.some(occurrence => occurrence.body.kind === 'failed')) return 'body_failed'
  if (occurrences.some(occurrence => occurrence.body.kind === 'unknown')) return 'body_unknown'
  return 'body_insufficient'
}

function collectCloseHandles(window: unknown): CaptureCloseHandle[] {
  const handles: CaptureCloseHandle[] = []
  const owners = new Set<object>()
  if (!isRecord(window) || !Array.isArray(window.surfaces)) return handles
  for (const surface of window.surfaces) {
    if (!isRecord(surface) || !Array.isArray(surface.occurrences)) continue
    for (const occurrence of surface.occurrences) {
      if (!isRecord(occurrence) || !isRecord(occurrence.body)) continue
      const body = occurrence.body
      if (isRecord(body.capture) && typeof body.capture.close === 'function') {
        addCloseHandle(
          handles,
          owners,
          body.capture,
          body.capture.close as (...args: unknown[]) => unknown,
        )
      }
      if (typeof body.close === 'function') {
        addCloseHandle(handles, owners, body, body.close as (...args: unknown[]) => unknown)
      }
    }
  }
  return handles
}

function addCloseHandle(
  handles: CaptureCloseHandle[],
  owners: Set<object>,
  owner: object,
  close: (...args: unknown[]) => unknown,
): void {
  if (owners.has(owner)) return
  owners.add(owner)
  handles.push({ owner, close: reason => close.call(owner, reason), closed: false })
}

async function closeHandles(handles: readonly CaptureCloseHandle[], reason: string): Promise<boolean> {
  let succeeded = true
  for (const handle of handles) {
    if (handle.closed) continue
    handle.closed = true
    try {
      await handle.close(reason)
    } catch {
      succeeded = false
    }
  }
  return succeeded
}

function parseXStatusUrl(value: unknown): { readonly stableId: string; readonly canonicalUrl: string } | undefined {
  if (typeof value !== 'string' || value.trim() !== value) return undefined
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== ''
    || !ALLOWED_X_HOSTS.has(url.hostname)) return undefined
  const match = /^\/([A-Za-z0-9_]{1,15})\/status\/([1-9][0-9]*)(?:\/(?:photo|video)\/([1-9][0-9]*))?\/?$/.exec(url.pathname)
  if (match === null) return undefined
  const username = match[1]
  const statusId = match[2]
  if (username === undefined || statusId === undefined) return undefined
  return Object.freeze({
    stableId: `x-status:${statusId}`,
    canonicalUrl: `https://x.com/${username.toLowerCase()}/status/${statusId}`,
  })
}

function readClock(clock: PersonalFeedV2Clock): Date | undefined {
  try {
    const now = clock.now()
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) return undefined
    return new Date(now.getTime())
  } catch {
    return undefined
  }
}

function deadlineExclusiveForShanghaiDay(day: string): number {
  const localDate = new Date(`${day}T00:00:00.000Z`)
  localDate.setUTCDate(localDate.getUTCDate() + 7)
  return localDate.getTime() - SHANGHAI_OFFSET_MILLISECONDS
}

function shanghaiDayAt(milliseconds: number): string {
  return new Date(milliseconds + SHANGHAI_OFFSET_MILLISECONDS).toISOString().slice(0, 10)
}

function isCanonicalTelegramRequestId(value: string): boolean {
  const match = /^telegram:(-?[1-9][0-9]*):([1-9][0-9]*)$/.exec(value)
  if (match === null) return false
  const chatIdText = match[1]
  const messageIdText = match[2]
  if (chatIdText === undefined || messageIdText === undefined) return false
  const chatId = Number(chatIdText)
  const messageId = Number(messageIdText)
  return Number.isSafeInteger(chatId) && chatId !== 0 && String(chatId) === chatIdText
    && Number.isSafeInteger(messageId) && messageId > 0 && String(messageId) === messageIdText
}

function isCanonicalIsoInstant(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false
  const parsed = new Date(value)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value
}

function isValidShanghaiDay(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime())) return false
  const [year, month, day] = value.split('-').map(Number)
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() + 1 === month && parsed.getUTCDate() === day
}

function isAbortSignal(value: unknown): value is AbortSignal {
  if (typeof value !== 'object' || value === null) return false
  const signal = value as {
    readonly aborted?: unknown
    readonly addEventListener?: unknown
    readonly removeEventListener?: unknown
  }
  return typeof signal.aborted === 'boolean'
    && typeof signal.addEventListener === 'function'
    && typeof signal.removeEventListener === 'function'
}

function hasDenseArray(value: unknown, length?: number): value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || (length !== undefined && value.length !== length)) return false
  const ownKeys = Reflect.ownKeys(value)
  if (ownKeys.some(key => typeof key !== 'string')) return false
  const expected = ['length', ...Array.from({ length: value.length }, (_, index) => String(index))].sort()
  const actual = (ownKeys as string[]).sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactlyKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const ownKeys = Reflect.ownKeys(value)
  if (ownKeys.some(key => typeof key !== 'string')) return false
  const actual = (ownKeys as string[]).sort()
  const sortedExpected = [...expected].sort()
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index])
}

function incomplete(reason: PersonalFeedV2CandidateIncompleteReason): PersonalFeedV2CandidateIncomplete {
  return Object.freeze({ kind: 'incomplete', reason })
}
