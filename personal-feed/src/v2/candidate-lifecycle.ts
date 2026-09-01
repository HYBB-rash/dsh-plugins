import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { types as nodeTypes } from 'node:util'
import { encodeCanonicalJson } from '../canonical-json.ts'

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  try {
    return (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype
    )
  } catch {
    return false
  }
}

function isPlainExactRecord(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (!isPlainRecord(value)) {
    return false
  }

  let ownKeys: readonly PropertyKey[]
  try {
    ownKeys = Reflect.ownKeys(value)
  } catch {
    return false
  }

  if (
    ownKeys.length !== expectedKeys.length ||
    ownKeys.some(
      (key) => typeof key !== 'string' || !expectedKeys.includes(key),
    )
  ) {
    return false
  }

  try {
    return expectedKeys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      return (
        descriptor !== undefined &&
        descriptor.enumerable === true &&
        'value' in descriptor
      )
    })
  } catch {
    return false
  }
}
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
  readonly completeCurrent: (
    input: PersonalFeedV2CandidateCompletionInput,
  ) => Promise<PersonalFeedV2CandidateCompletionResult>
}

export interface PersonalFeedV2CandidateCompletionInput {
  readonly judgment: PersonalFeedV2CandidateJudgment
}

export type PersonalFeedV2CandidateJudgment = 'qualified' | 'not_qualified'

export interface PersonalFeedV2CandidateCompletionReceipt {
  readonly kind: 'candidate_judgment_completed'
  readonly stableId: string
  readonly requestId: string
  readonly position: number
  readonly judgment: PersonalFeedV2CandidateJudgment
  readonly completedAt: string
}

export type PersonalFeedV2CandidateIncompleteReason =
  | 'aborted'
  | 'body_failed'
  | 'body_insufficient'
  | 'body_unknown'
  | 'capture_failed'
  | 'clock_failed'
  | 'completion_claim_invalid'
  | 'completion_conflict'
  | 'completion_store_failed'
  | 'concurrent_reservation'
  | 'expired'
  | 'failed'
  | 'invalid_input'
  | 'processed_query_aborted'
  | 'processed_query_failed'
  | 'processed_query_unknown'
  | 'timeout'
  | 'unknown'

export interface PersonalFeedV2CandidateIncomplete {
  readonly kind: 'incomplete'
  readonly reason: PersonalFeedV2CandidateIncompleteReason
}

export type PersonalFeedV2CandidateCompletionResult =
  | PersonalFeedV2CandidateCompletionReceipt
  | PersonalFeedV2CandidateIncomplete

export type PersonalFeedV2CandidateFinalizeResult =
  | {
      readonly kind: 'selected'
      readonly selected: {
        readonly stableId: string
        readonly canonicalUrl: string
        readonly position: number
      }
    }
  | { readonly kind: 'none' }
  | PersonalFeedV2CandidateIncomplete

export type PersonalFeedV2CandidateBorrowResult =
  | { readonly kind: 'candidate'; readonly lease: PersonalFeedV2CandidateLease }
  | { readonly kind: 'done' }
  | PersonalFeedV2CandidateIncomplete

export interface PersonalFeedV2CandidateCursor {
  readonly borrowCurrent: (input: { readonly signal: AbortSignal }) => Promise<PersonalFeedV2CandidateBorrowResult>
  readonly finalize: (claim: unknown) => Promise<PersonalFeedV2CandidateFinalizeResult>
  readonly close: (reason: string) => Promise<void>
}

export type PersonalFeedV2CandidateAdmitResult =
  | { readonly kind: 'admitted'; readonly cursor: PersonalFeedV2CandidateCursor }
  | PersonalFeedV2CandidateIncomplete

export interface PersonalFeedV2CandidateLifecycle {
  readonly admit: (input: PersonalFeedV2CandidateAdmitInput) => Promise<PersonalFeedV2CandidateAdmitResult>
}

type SurfaceName = PersonalFeedV2CandidateProvenance['surface']
type UnknownCallable = (...args: unknown[]) => unknown

interface CaptureCloseHandle {
  readonly owner: object
  readonly close: (reason: string) => unknown
  state: 'open' | 'closing' | 'closed'
  firstReason: string | undefined
  attempt: Promise<boolean> | undefined
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

interface WindowRecordSnapshot {
  readonly owner: object
  readonly values: ReadonlyMap<string, unknown>
}

interface WindowArraySnapshot {
  readonly owner: object
  readonly values: readonly unknown[]
}

interface WindowInterval {
  readonly startedAt: number
  readonly completedAt: number
}

interface SelectedCapture {
  readonly position: number
  readonly occurrence: ParsedOccurrence
}

interface CursorCandidate {
  readonly stableId: string
  readonly canonicalUrl: string
  readonly position: number
  readonly body: string
  readonly provenance: PersonalFeedV2CandidateProvenance
  readonly handle: CaptureCloseHandle
  readonly deadlineExclusive: number
}

interface CompletionRecord {
  readonly schemaVersion: 1
  readonly event: 'candidate_judgment_completed'
  readonly stableId: string
  readonly requestId: string
  readonly position: number
  readonly judgment: PersonalFeedV2CandidateJudgment
  readonly completedAt: string
}

interface CompletionLedger {
  readonly bytes: string
  readonly records: readonly CompletionRecord[]
}

interface CandidateReservation {
  readonly token: object
  readonly stableIds: readonly string[]
}

const SURFACES = ['for_you', 'following', 'explore'] as const
const ALLOWED_X_HOSTS = new Set(['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'])
const SHANGHAI_OFFSET_MILLISECONDS = 8 * 60 * 60 * 1000
const DONE_RESULT: PersonalFeedV2CandidateBorrowResult = Object.freeze({ kind: 'done' })
const DEFAULT_PROCESSED_RESULT: PersonalFeedV2ProcessedQueryResult = Object.freeze({ kind: 'processed' })
const DEFAULT_UNPROCESSED_RESULT: PersonalFeedV2ProcessedQueryResult = Object.freeze({ kind: 'unprocessed' })
let completionTemporarySequence = 0

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
  const reservations = new Map<string, object>()

  const admit = async (input: PersonalFeedV2CandidateAdmitInput): Promise<PersonalFeedV2CandidateAdmitResult> => {
    let handles: CaptureCloseHandle[] = []
    try {
      handles = collectCloseHandles(isRecord(input) ? input.window : undefined)
    } catch {
      // Discovery is best effort; a failed reflection must still resolve through
      // the ordinary invalid-input cleanup path.
    }
    let activeReservation: CandidateReservation | undefined
    const fail = async (reason: PersonalFeedV2CandidateIncompleteReason): Promise<PersonalFeedV2CandidateIncomplete> => {
      if (activeReservation !== undefined) releaseReservation(reservations, activeReservation)
      await closeHandles(handles, reason)
      return incomplete(reason)
    }

    if (!isRecord(input) || !hasExactlyKeys(input, ['request', 'window', 'signal'])
      || !isAbortSignal(input.signal)) {
      return fail('invalid_input')
    }
    if (input.signal.aborted) return fail('aborted')

      const request = parseRequest(input.request)
      if (request === undefined) {
        return fail('invalid_input')
      }
    const now = readClock(clock)
    if (now === undefined) return fail('clock_failed')
    let parsed: ParsedWindow | undefined
    try {
      parsed = request === undefined
        ? undefined
        : parseWindow(input.window, request, now, handles)
    } catch {
      return fail('invalid_input')
    }
    if (parsed === undefined) return fail('invalid_input')

    const occurrencesByIdentity = new Map<string, ParsedOccurrence[]>()
    for (const occurrence of parsed.occurrences) {
      const grouped = occurrencesByIdentity.get(occurrence.stableId)
      if (grouped === undefined) occurrencesByIdentity.set(occurrence.stableId, [occurrence])
      else grouped.push(occurrence)
    }

    const completionLedger = readCompletionLedger(completionLedgerPath)
    if (completionLedger === undefined) return fail('completion_store_failed')
    const completedStableIds = new Set(completionLedger.records.map(record => record.stableId))

    const selected: SelectedCapture[] = []
    for (const [stableId, occurrences] of occurrencesByIdentity) {
      if (input.signal.aborted) return fail('aborted')
      let queried: PersonalFeedV2ProcessedQueryResult
      if (completedStableIds.has(stableId)) {
        queried = DEFAULT_PROCESSED_RESULT
      } else if (processedQuery === undefined) {
        queried = DEFAULT_UNPROCESSED_RESULT
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

    activeReservation = tryReserveCandidates(
      reservations,
      selected.map(capture => capture.occurrence.stableId),
    )
    if (activeReservation === undefined) return fail('concurrent_reservation')
    const selectedHandles = new Set(selected.map(capture => capture.occurrence.body.handle))
    const unusedHandles = handles.filter(handle => !selectedHandles.has(handle))
    if (!await closeHandles(unusedHandles, 'not_selected')) {
      return fail('capture_failed')
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
        candidates.push(cursorCandidate(capture, body, deadlineExclusive))
      }
    } catch {
      return fail(input.signal.aborted ? 'aborted' : 'capture_failed')
    }

    const cursor = createCursor(
      candidates,
      clock,
      request.requestId,
      completionLedgerPath,
      reservations,
      activeReservation,
    )
    return Object.freeze({ kind: 'admitted', cursor })
  }

  return Object.freeze({ admit })
}

function readCompletionLedger(path: string): CompletionLedger | undefined {
  let bytes: string
  try {
    bytes = readFileSync(path, 'utf8')
  } catch (cause) {
    return hasErrorCode(cause, 'ENOENT') ? { bytes: '', records: [] } : undefined
  }
  if (bytes === '') return { bytes, records: [] }
  if (!bytes.endsWith('\n')) return undefined

  const records: CompletionRecord[] = []
  const stableIds = new Set<string>()
  for (const line of bytes.slice(0, -1).split('\n')) {
    let decoded: unknown
    try {
      decoded = JSON.parse(line) as unknown
    } catch {
      return undefined
    }
    const record = parseCompletionRecord(decoded)
    if (record === undefined || stableIds.has(record.stableId)) return undefined
    const canonical = encodeCanonicalJson(record)
    if (canonical === undefined || canonical !== line) return undefined
    stableIds.add(record.stableId)
    records.push(record)
  }
  return { bytes, records }
}

function parseCompletionRecord(value: unknown): CompletionRecord | undefined {
  if (!isRecord(value) || !hasExactlyKeys(value, [
    'schemaVersion', 'event', 'stableId', 'requestId', 'position', 'judgment', 'completedAt',
  ]) || value.schemaVersion !== 1 || value.event !== 'candidate_judgment_completed'
    || typeof value.stableId !== 'string' || !/^x-status:[1-9][0-9]*$/.test(value.stableId)
    || typeof value.requestId !== 'string' || !isCanonicalTelegramRequestId(value.requestId)
    || typeof value.position !== 'number' || !Number.isSafeInteger(value.position)
    || value.position < 0 || Object.is(value.position, -0)
    || (value.judgment !== 'qualified' && value.judgment !== 'not_qualified')
    || !isCanonicalIsoInstant(value.completedAt)) return undefined
  return Object.freeze(value as unknown as CompletionRecord)
}

function appendCompletionRecord(path: string, record: CompletionRecord): boolean {
  const before = readCompletionLedger(path)
  if (before === undefined || before.records.some(existing => existing.stableId === record.stableId)) return false
  const encoded = encodeCanonicalJson(record)
  if (encoded === undefined) return false
  const expectedBytes = `${before.bytes}${encoded}\n`
  const directory = dirname(path)
  completionTemporarySequence += 1
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.${completionTemporarySequence}.tmp`
  let renamed = false
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    chmodSync(directory, 0o700)
    writeFileSync(temporaryPath, expectedBytes, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    renameSync(temporaryPath, path)
    renamed = true
    chmodSync(path, 0o600)
    const readback = readCompletionLedger(path)
    const last = readback?.records.at(-1)
    return readback !== undefined && readback.bytes === expectedBytes
      && readback.records.length === before.records.length + 1
      && last !== undefined && sameCompletionRecord(last, record)
  } catch {
    return false
  } finally {
    if (!renamed) {
      try {
        unlinkSync(temporaryPath)
      } catch {
        // A missing or already-renamed temporary is not an alternate authority.
      }
    }
  }
}

function sameCompletionRecord(left: CompletionRecord, right: CompletionRecord): boolean {
  return left.schemaVersion === right.schemaVersion && left.event === right.event
    && left.stableId === right.stableId && left.requestId === right.requestId
    && left.position === right.position && left.judgment === right.judgment
    && left.completedAt === right.completedAt
}

function tryReserveCandidates(
  reservations: Map<string, object>,
  stableIds: readonly string[],
): CandidateReservation | undefined {
  if (stableIds.some(stableId => reservations.has(stableId))) return undefined
  const reservation: CandidateReservation = {
    token: Object.freeze({}),
    stableIds: Object.freeze([...stableIds]),
  }
  for (const stableId of stableIds) reservations.set(stableId, reservation.token)
  return reservation
}

function releaseReservedCandidate(
  reservations: Map<string, object>,
  reservation: CandidateReservation,
  stableId: string,
): void {
  if (reservations.get(stableId) === reservation.token) reservations.delete(stableId)
}

function releaseReservation(reservations: Map<string, object>, reservation: CandidateReservation): void {
  for (const stableId of reservation.stableIds) {
    releaseReservedCandidate(reservations, reservation, stableId)
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
  requestId: string,
  completionLedgerPath: string,
  reservations: Map<string, object>,
  reservation: CandidateReservation,
): PersonalFeedV2CandidateCursor {
  let closed = false
  let terminal = false
  let currentIndex = 0
  let qualifiedReceipt: PersonalFeedV2CandidateCompletionReceipt | undefined
  let finalizedResult: PersonalFeedV2CandidateFinalizeResult | undefined
  let businessFailure: PersonalFeedV2CandidateIncomplete | undefined
  let cleanupAttempt: Promise<void> | undefined
  let cleanupComplete = false
  const receipts: PersonalFeedV2CandidateCompletionReceipt[] = []

  const freezeCaptureFailure = (): PersonalFeedV2CandidateIncomplete => {
    if (businessFailure === undefined) businessFailure = incomplete('capture_failed')
    return businessFailure
  }

  const closeResources = (reason: string): Promise<void> => {
    releaseReservation(reservations, reservation)
    if (cleanupComplete) return Promise.resolve()
    if (cleanupAttempt !== undefined) return cleanupAttempt
    const safeReason = reason === 'consumed' || reason === 'expired' ? reason : 'cursor_closed'
    const attempt = (async (): Promise<void> => {
      if (!await closeHandles(candidates.map(candidate => candidate.handle), safeReason)) {
        throw new Error('personal Feed v2 candidate capture close failed')
      }
      cleanupComplete = true
    })()
    cleanupAttempt = attempt
    const clearAttempt = (): void => {
      if (cleanupAttempt === attempt) cleanupAttempt = undefined
    }
    void attempt.then(clearAttempt, clearAttempt)
    return attempt
  }

  const close = (reason: string): Promise<void> => {
    closed = true
    return closeResources(reason).catch((cause: unknown) => {
      freezeCaptureFailure()
      throw cause
    })
  }

  const failCompletion = async (
    reason: PersonalFeedV2CandidateIncompleteReason,
  ): Promise<PersonalFeedV2CandidateIncomplete> => {
    const result = incomplete(reason)
    try {
      await close(reason)
    } catch {
      // The current operation keeps its original failure; later observations
      // expose the frozen capture failure and explicit close can retry cleanup.
    }
    return result
  }

  const failCaptureClosure = async (): Promise<PersonalFeedV2CandidateIncomplete> => {
    const result = freezeCaptureFailure()
    closed = true
    releaseReservation(reservations, reservation)
    const unattempted = candidates
      .map(candidate => candidate.handle)
      .filter(handle => handle.firstReason === undefined)
    await closeHandles(unattempted, 'capture_failed')
    return result
  }

  const completeAt = async (
    index: number,
    input: PersonalFeedV2CandidateCompletionInput,
  ): Promise<PersonalFeedV2CandidateCompletionResult> => {
    if (businessFailure !== undefined && receipts[index] === undefined) return businessFailure
    if (!isPlainExactRecord(input, ['judgment'])
      || (input.judgment !== 'qualified' && input.judgment !== 'not_qualified')) {
      return failCompletion('invalid_input')
    }

    const replay = receipts[index]
    if (replay !== undefined) {
      return replay.judgment === input.judgment
        ? replay
        : failCompletion('completion_conflict')
    }
    if (closed || terminal || finalizedResult !== undefined || index !== currentIndex) {
      return failCompletion('completion_conflict')
    }
    const candidate = candidates[index]
    if (candidate === undefined) return failCompletion('completion_conflict')
    const now = readClock(clock)
    if (now === undefined || now.getTime() < Date.parse(candidate.provenance.capturedAt)) {
      return failCompletion('clock_failed')
    }
    if (now.getTime() >= candidate.deadlineExclusive) return failCompletion('expired')

    const record: CompletionRecord = Object.freeze({
      schemaVersion: 1,
      event: 'candidate_judgment_completed',
      stableId: candidate.stableId,
      requestId,
      position: candidate.position,
      judgment: input.judgment,
      completedAt: now.toISOString(),
    })
    if (!appendCompletionRecord(completionLedgerPath, record)) {
      return failCompletion('completion_store_failed')
    }

    const receipt: PersonalFeedV2CandidateCompletionReceipt = Object.freeze({
      kind: 'candidate_judgment_completed',
      stableId: record.stableId,
      requestId: record.requestId,
      position: record.position,
      judgment: record.judgment,
      completedAt: record.completedAt,
    })
    const handlesToClose = input.judgment === 'qualified'
      ? candidates.map(item => item.handle)
      : [candidate.handle]
    const closedCaptures = await closeHandles(handlesToClose, input.judgment)
    if (!closedCaptures) return failCaptureClosure()
    if (input.judgment === 'qualified') releaseReservation(reservations, reservation)
    else releaseReservedCandidate(reservations, reservation, candidate.stableId)

    receipts.push(receipt)
    if (input.judgment === 'qualified') {
      qualifiedReceipt = receipt
      terminal = true
      currentIndex = candidates.length
    } else {
      currentIndex += 1
    }
    return receipt
  }

  const leases = candidates.map((candidate, index) => candidateLease(
    candidate,
    input => completeAt(index, input),
  ))

  const borrowCurrent = async (
    input: { readonly signal: AbortSignal },
  ): Promise<PersonalFeedV2CandidateBorrowResult> => {
    if (businessFailure !== undefined) return businessFailure
    if (closed || terminal || finalizedResult !== undefined) return DONE_RESULT
    if (!isRecord(input) || !hasExactlyKeys(input, ['signal']) || !isAbortSignal(input.signal)) {
      return failCompletion('invalid_input')
    }
    if (input.signal.aborted) {
      return failCompletion('aborted')
    }
    const now = readClock(clock)
    if (now === undefined) {
      return failCompletion('clock_failed')
    }
    const candidate = candidates[currentIndex]
    const lease = leases[currentIndex]
    if (candidate === undefined || lease === undefined) return DONE_RESULT
    if (now.getTime() >= candidate.deadlineExclusive) {
      return failCompletion('expired')
    }
    return Object.freeze({ kind: 'candidate', lease })
  }

  const finalize = async (claim: unknown): Promise<PersonalFeedV2CandidateFinalizeResult> => {
    if (businessFailure !== undefined) return businessFailure
    if (finalizedResult !== undefined) return finalizedResult
    const finish = async (
      result: PersonalFeedV2CandidateFinalizeResult,
      reason: string,
    ): Promise<PersonalFeedV2CandidateFinalizeResult> => {
      try {
        await close(reason)
        finalizedResult = result
        return result
      } catch {
        const failure = freezeCaptureFailure()
        finalizedResult = failure
        return failure
      }
    }
    const reject = async (): Promise<PersonalFeedV2CandidateFinalizeResult> => {
      const result = incomplete('completion_claim_invalid')
      return finish(result, 'completion_claim_invalid')
    }
    if (!isPlainRecord(claim) || typeof claim.kind !== 'string') return reject()

    if (claim.kind === 'selected') {
      if (!isPlainExactRecord(claim, ['kind', 'completed', 'selected'])
        || !hasExactReceiptPrefix(claim.completed, receipts)) return reject()
      const lastReceipt = receipts.at(-1)
      if (lastReceipt === undefined || claim.selected !== lastReceipt
        || qualifiedReceipt !== lastReceipt || lastReceipt.judgment !== 'qualified') return reject()
      const candidate = candidates[lastReceipt.position]
      if (candidate === undefined || candidate.stableId !== lastReceipt.stableId) return reject()
      const selected = Object.freeze({
        stableId: candidate.stableId,
        canonicalUrl: candidate.canonicalUrl,
        position: candidate.position,
      })
      const result: PersonalFeedV2CandidateFinalizeResult = Object.freeze({ kind: 'selected', selected })
      return finish(result, 'finalized')
    }

    if (claim.kind === 'none') {
      if (!isPlainExactRecord(claim, ['kind', 'completed'])
        || !hasExactReceiptPrefix(claim.completed, receipts)
        || currentIndex !== candidates.length || receipts.length !== candidates.length
      || qualifiedReceipt !== undefined
        || receipts.some(receipt => receipt.judgment !== 'not_qualified')) return reject()
      const result: PersonalFeedV2CandidateFinalizeResult = Object.freeze({ kind: 'none' })
      return finish(result, 'finalized')
    }

    if (claim.kind === 'incomplete') {
      if (!isPlainExactRecord(claim, ['kind', 'completed', 'reason'])
        || !hasExactReceiptPrefix(claim.completed, receipts)
        || !isFinalIncompleteReason(claim.reason)
        || qualifiedReceipt !== undefined
        || receipts.some(receipt => receipt.judgment !== 'not_qualified')) return reject()
      const result = incomplete(claim.reason)
      return finish(result, 'finalized')
    }
    return reject()
  }

  return Object.freeze({ borrowCurrent, finalize, close })
}

function candidateLease(
  candidate: CursorCandidate,
  completeCurrent: (
    input: PersonalFeedV2CandidateCompletionInput,
  ) => Promise<PersonalFeedV2CandidateCompletionResult>,
): PersonalFeedV2CandidateLease {
  return Object.freeze({
    stableId: candidate.stableId,
    canonicalUrl: candidate.canonicalUrl,
    position: candidate.position,
    body: candidate.body,
    provenance: candidate.provenance,
    completeCurrent,
  })
}

function cursorCandidate(capture: SelectedCapture, body: string, deadlineExclusive: number): CursorCandidate {
  const occurrence = capture.occurrence
  return {
    stableId: occurrence.stableId,
    canonicalUrl: occurrence.canonicalUrl,
    position: capture.position,
    body,
    provenance: Object.freeze({
      capturedAt: occurrence.capturedAt,
      surface: occurrence.surface,
      surfaceOrdinal: occurrence.surfaceOrdinal,
      occurrenceOrdinal: occurrence.occurrenceOrdinal,
      canonicalUrl: occurrence.canonicalUrl,
      authorHandle: occurrence.authorHandle,
      publishedAt: occurrence.publishedAt,
    }),
    handle: occurrence.body.handle,
    deadlineExclusive,
  }
}

function hasExactReceiptPrefix(
  value: unknown,
  receipts: readonly PersonalFeedV2CandidateCompletionReceipt[],
): boolean {
  if (!hasDenseArray(value) || value.length !== receipts.length) return false
  return receipts.every((receipt, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    return descriptor !== undefined && descriptor.enumerable && 'value' in descriptor
      && descriptor.value === receipt
  })
}

function isFinalIncompleteReason(value: unknown): value is 'failed' | 'aborted' | 'timeout' | 'unknown' {
  return value === 'failed' || value === 'aborted' || value === 'timeout' || value === 'unknown'
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
  const window = snapshotWindowRecord(value, [
    'requestId', 'cutoff', 'shanghaiDay', 'startedAt', 'completedAt', 'surfaces',
  ])
  if (window === undefined) return undefined
  const windowValues = window.values
  const requestId = windowValues.get('requestId')
  const cutoffValue = windowValues.get('cutoff')
  const shanghaiDayValue = windowValues.get('shanghaiDay')
  const startedAt = windowValues.get('startedAt')
  const completedAt = windowValues.get('completedAt')
  const surfaces = snapshotWindowArray(windowValues.get('surfaces'), SURFACES.length)
  if (requestId !== request.requestId || cutoffValue !== request.cutoff
    || shanghaiDayValue !== request.shanghaiDay || surfaces === undefined) return undefined

  const cutoff = Date.parse(request.cutoff)
  const topInterval = parseWindowInterval(
    startedAt,
    completedAt,
    cutoff,
    now.getTime(),
    request.shanghaiDay,
  )
  if (topInterval === undefined) return undefined

  const handleByOwner = new Map(handles.map(handle => [handle.owner, handle]))
  const usedHandles = new Set<CaptureCloseHandle>()
  const occurrences: ParsedOccurrence[] = []
  let previousSurfaceCompletedAt = topInterval.startedAt
  for (let surfaceOrdinal = 0; surfaceOrdinal < SURFACES.length; surfaceOrdinal += 1) {
    const expectedSurface = SURFACES[surfaceOrdinal]
    const surface = snapshotWindowRecord(surfaces.values[surfaceOrdinal], [
        'kind', 'surface', 'surfaceOrdinal', 'startedAt', 'completedAt', 'occurrences',
      ])
    if (expectedSurface === undefined || surface === undefined) return undefined
    const surfaceValues = surface.values
    const surfaceKind = surfaceValues.get('kind')
    const surfaceName = surfaceValues.get('surface')
    const surfaceOrdinalValue = surfaceValues.get('surfaceOrdinal')
    const surfaceOccurrences = snapshotWindowArray(surfaceValues.get('occurrences'))
    if ((surfaceKind !== 'complete' && surfaceKind !== 'natural_zero')
      || surfaceName !== expectedSurface || surfaceOrdinalValue !== surfaceOrdinal
      || surfaceOccurrences === undefined) return undefined

    const surfaceInterval = parseWindowInterval(
      surfaceValues.get('startedAt'),
      surfaceValues.get('completedAt'),
      cutoff,
      now.getTime(),
      request.shanghaiDay,
    )
    if (surfaceInterval === undefined
      || surfaceInterval.startedAt < topInterval.startedAt
      || surfaceInterval.completedAt > topInterval.completedAt
      || surfaceInterval.startedAt < previousSurfaceCompletedAt
      || (surfaceKind === 'complete' && surfaceOccurrences.values.length === 0)
      || (surfaceKind === 'natural_zero' && surfaceOccurrences.values.length !== 0)) return undefined
    previousSurfaceCompletedAt = surfaceInterval.completedAt

    for (let occurrenceOrdinal = 0; occurrenceOrdinal < surfaceOccurrences.values.length; occurrenceOrdinal += 1) {
      const occurrence = snapshotWindowRecord(surfaceOccurrences.values[occurrenceOrdinal], [
        'sourceUrl', 'body', 'occurrenceOrdinal', 'capturedAt', 'authorHandle', 'publishedAt',
      ])
      if (occurrence === undefined) return undefined
      const occurrenceValues = occurrence.values
      const occurrenceOrdinalValue = occurrenceValues.get('occurrenceOrdinal')
      const authorHandle = occurrenceValues.get('authorHandle')
      const publishedAt = occurrenceValues.get('publishedAt')
      const capturedAtValue = occurrenceValues.get('capturedAt')
      if (occurrenceOrdinalValue !== occurrenceOrdinal
        || typeof authorHandle !== 'string' || authorHandle.trim() === ''
        || !isCanonicalIsoInstant(publishedAt)
        || !isCanonicalIsoInstant(capturedAtValue)) return undefined

      const capturedAt = Date.parse(capturedAtValue)
      if (capturedAt < Date.parse(request.cutoff) || capturedAt > now.getTime()
        || shanghaiDayAt(capturedAt) !== request.shanghaiDay
        || capturedAt < surfaceInterval.startedAt || capturedAt > surfaceInterval.completedAt) return undefined
      const identity = parseXStatusUrl(occurrenceValues.get('sourceUrl'))
      const body = parseBodyCapture(occurrenceValues.get('body'), handleByOwner)
      if (identity === undefined || body === undefined || usedHandles.has(body.handle)) return undefined
      usedHandles.add(body.handle)
      occurrences.push({
        stableId: identity.stableId,
        canonicalUrl: identity.canonicalUrl,
        capturedAt: capturedAtValue,
        surface: expectedSurface,
        surfaceOrdinal,
        occurrenceOrdinal,
        authorHandle,
        publishedAt,
        body,
      })
    }
  }
  if (previousSurfaceCompletedAt > topInterval.completedAt) return undefined
  return { shanghaiDay: request.shanghaiDay, occurrences }
}

function parseWindowInterval(
  startedAt: unknown,
  completedAt: unknown,
  cutoff: number,
  now: number,
  shanghaiDay: string,
): WindowInterval | undefined {
  const parsedStartedAt = parseWindowTime(startedAt)
  const parsedCompletedAt = parseWindowTime(completedAt)
  if (parsedStartedAt === undefined || parsedCompletedAt === undefined
    || !isWindowTimeInBounds(parsedStartedAt, cutoff, now, shanghaiDay)
    || !isWindowTimeInBounds(parsedCompletedAt, cutoff, now, shanghaiDay)
    || parsedStartedAt > parsedCompletedAt) return undefined
  return { startedAt: parsedStartedAt, completedAt: parsedCompletedAt }
}

function parseWindowTime(value: unknown): number | undefined {
  return isCanonicalIsoInstant(value) ? Date.parse(value) : undefined
}

function isWindowTimeInBounds(
  value: number,
  cutoff: number,
  now: number,
  shanghaiDay: string,
): boolean {
  return value >= cutoff && value <= now && shanghaiDayAt(value) === shanghaiDay
}

function snapshotWindowRecord(
  value: unknown,
  expectedKeys: readonly string[],
): WindowRecordSnapshot | undefined {
  if (!isSnapshotObject(value) || nodeTypes.isProxy(value)) return undefined
  let prototype: object | null
  let ownKeys: readonly PropertyKey[]
  try {
    prototype = Object.getPrototypeOf(value)
    ownKeys = Reflect.ownKeys(value)
  } catch {
    return undefined
  }
  if (prototype !== Object.prototype && prototype !== null) return undefined
  if (ownKeys.length !== expectedKeys.length
    || ownKeys.some(key => typeof key !== 'string' || !expectedKeys.includes(key))) return undefined

  const values = new Map<string, unknown>()
  for (const key of expectedKeys) {
    let descriptor: PropertyDescriptor | undefined
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key)
    } catch {
      return undefined
    }
    if (descriptor === undefined || descriptor.enumerable !== true
      || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return undefined
    values.set(key, descriptor.value)
  }
  return { owner: value, values }
}

function snapshotWindowArray(
  value: unknown,
  expectedLength?: number,
): WindowArraySnapshot | undefined {
  if (!isSnapshotObject(value) || nodeTypes.isProxy(value)) return undefined
  let prototype: object | null
  let ownKeys: readonly PropertyKey[]
  let lengthDescriptor: PropertyDescriptor | undefined
  try {
    prototype = Object.getPrototypeOf(value)
    ownKeys = Reflect.ownKeys(value)
    lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
  } catch {
    return undefined
  }
  if (prototype !== Array.prototype || lengthDescriptor === undefined
    || lengthDescriptor.enumerable !== false
    || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')
    || typeof lengthDescriptor.value !== 'number'
    || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0
    || (expectedLength !== undefined && lengthDescriptor.value !== expectedLength)) return undefined
  const length = lengthDescriptor.value
  const expectedKeys = ['length', ...Array.from({ length }, (_, index) => String(index))]
  if (ownKeys.length !== expectedKeys.length
    || ownKeys.some(key => typeof key !== 'string' || !expectedKeys.includes(key))) return undefined

  const values: unknown[] = []
  for (let index = 0; index < length; index += 1) {
    const key = String(index)
    let descriptor: PropertyDescriptor | undefined
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key)
    } catch {
      return undefined
    }
    if (descriptor === undefined || descriptor.enumerable !== true
      || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return undefined
    values.push(descriptor.value)
  }
  return { owner: value, values }
}

function isSnapshotObject(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function'
}

function parseBodyCapture(
  value: unknown,
  handleByOwner: ReadonlyMap<object, CaptureCloseHandle>,
): ParsedBodyCapture | undefined {
  const kind = readDataDescriptor(value, 'kind')
  if (kind === 'sufficient') {
    const body = snapshotWindowRecord(value, ['kind', 'capture'])
    if (body === undefined) return undefined
    const capture = snapshotWindowRecord(body.values.get('capture'), ['take', 'close'])
    if (capture === undefined) return undefined
    const take = capture.values.get('take')
    const close = capture.values.get('close')
    if (!isUnknownCallable(take) || !isUnknownCallable(close)) return undefined
    const handle = handleByOwner.get(capture.owner)
    if (handle === undefined) return undefined
    return {
      kind: 'sufficient',
      handle,
      take: input => Reflect.apply(take, capture.owner, [input]),
    }
  }
  if (kind !== 'insufficient' && kind !== 'failed' && kind !== 'unknown') return undefined
  const body = snapshotWindowRecord(value, ['kind', 'close'])
  if (body === undefined) return undefined
  const close = body.values.get('close')
  if (!isUnknownCallable(close)) return undefined
  const handle = handleByOwner.get(body.owner)
  return handle === undefined ? undefined : { kind, handle }
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
  discoverWindowEdge(window, 'surfaces', surfaces => {
    discoverArrayElements(surfaces, surface => {
      discoverWindowEdge(surface, 'occurrences', occurrences => {
        discoverArrayElements(occurrences, occurrence => {
          discoverWindowEdge(occurrence, 'body', body => {
            if (!isSnapshotObject(body)) return
            const bodyClose = readDataDescriptor(body, 'close')
            if (isUnknownCallable(bodyClose)) {
              addCloseHandle(handles, owners, body, bodyClose)
            }
            const capture = readDataDescriptor(body, 'capture')
            if (isSnapshotObject(capture)) {
              const captureClose = readDataDescriptor(capture, 'close')
              if (isUnknownCallable(captureClose)) {
                addCloseHandle(handles, owners, capture, captureClose)
              }
            }
          })
        })
      })
    })
  })
  return handles
}

function discoverWindowEdge(
  owner: unknown,
  key: string,
  visit: (value: unknown) => void,
): void {
  const value = readDataDescriptor(owner, key)
  if (value !== undefined) visit(value)
}

function discoverArrayElements(value: unknown, visit: (value: unknown) => void): void {
  if (!isSnapshotObject(value)) return
  const indices = new Set<number>()
  let ownKeys: readonly PropertyKey[] | undefined
  try {
    ownKeys = Reflect.ownKeys(value)
  } catch {
    // A readable length descriptor still permits discovery of known indices.
  }
  if (ownKeys !== undefined) {
    for (const key of ownKeys) {
      if (typeof key !== 'string') continue
      const index = canonicalArrayIndex(key)
      if (index !== undefined) indices.add(index)
    }
  }
  const lengthDescriptor = readOwnDataDescriptor(value, 'length')
  if (lengthDescriptor !== undefined && typeof lengthDescriptor === 'number'
    && Number.isSafeInteger(lengthDescriptor) && lengthDescriptor >= 0) {
    for (let index = 0; index < lengthDescriptor; index += 1) indices.add(index)
  }
  for (const index of [...indices].sort((left, right) => left - right)) {
    const element = readDataDescriptor(value, String(index))
    if (element !== undefined) visit(element)
  }
}

function readDataDescriptor(owner: unknown, key: string): unknown {
  if (!isSnapshotObject(owner)) return undefined
  let descriptor: PropertyDescriptor | undefined
  try {
    descriptor = Object.getOwnPropertyDescriptor(owner, key)
  } catch {
    return undefined
  }
  return descriptor !== undefined
    && Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ? descriptor.value
    : undefined
}

function readOwnDataDescriptor(owner: unknown, key: string): unknown {
  return readDataDescriptor(owner, key)
}

function isUnknownCallable(value: unknown): value is UnknownCallable {
  return typeof value === 'function'
}

function canonicalArrayIndex(key: string): number | undefined {
  if (!/^(?:0|[1-9][0-9]*)$/.test(key)) return undefined
  const index = Number(key)
  return Number.isSafeInteger(index) && index >= 0 && index < 0xffffffff
    && String(index) === key ? index : undefined
}

function addCloseHandle(
  handles: CaptureCloseHandle[],
  owners: Set<object>,
  owner: object,
  close: UnknownCallable,
): void {
  if (owners.has(owner)) return
  owners.add(owner)
  handles.push({
    owner,
    close: reason => Reflect.apply(close, owner, [reason]),
    state: 'open',
    firstReason: undefined,
    attempt: undefined,
  })
}

async function closeHandles(handles: readonly CaptureCloseHandle[], reason: string): Promise<boolean> {
  let succeeded = true
  for (const handle of handles) {
    if (!await closeCaptureHandle(handle, reason)) succeeded = false
  }
  return succeeded
}

function closeCaptureHandle(handle: CaptureCloseHandle, reason: string): Promise<boolean> {
  if (handle.state === 'closed') return Promise.resolve(true)
  if (handle.state === 'closing' && handle.attempt !== undefined) return handle.attempt

  const firstReason = handle.firstReason ?? reason
  handle.firstReason = firstReason
  handle.state = 'closing'
  const attempt = (async (): Promise<boolean> => {
    // Yield once so re-entrant and concurrent close calls can observe this attempt.
    await Promise.resolve()
    try {
      await handle.close(firstReason)
      handle.state = 'closed'
      return true
    } catch {
      handle.state = 'open'
      return false
    } finally {
      handle.attempt = undefined
    }
  })()
  handle.attempt = attempt
  return attempt
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
