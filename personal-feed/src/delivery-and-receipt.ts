import { appendJsonLine, readJsonLines } from './durable-jsonl-store.ts'
import { PersonalFeedScopeStoreError } from './errors.ts'
import { encodeCanonicalJson } from './canonical-json.ts'
import { formalFeedContentObjectIdentityFor } from './identity.ts'
import { canonicalCandidateTupleKey } from './candidate-tuple.ts'
import type {
  C19Result,
  EditingConclusionIdentity,
  FeedContentDeliveryObjectIdentity,
  FormalFeedContent,
  FormalFeedContentDeliveryRequest,
  FormalFeedContentDeliveryOwnerRead,
  PeriodIdentity,
  SourceCandidateReference,
} from './types.ts'

export interface DeliveryAndReceiptOptions {
  readonly ledgerPath: string
}

export interface DeliveryAndReceipt {
  readonly acceptFormalFeedContent: (request: FormalFeedContentDeliveryRequest) => C19Result
  readonly readFormalFeedContentDeliveryRequest: (
    object: FeedContentDeliveryObjectIdentity,
  ) => FormalFeedContentDeliveryRequest | undefined
  readonly readFormalFeedContentDeliveryRequestForPeriod: (
    period: PeriodIdentity,
  ) => FormalFeedContentDeliveryOwnerRead
}

type DeliveryRecord = {
  readonly schemaVersion: 1
  readonly event: 'formal_feed_content_delivery_accepted'
  readonly request: FormalFeedContentDeliveryRequest
}

export function createDeliveryAndReceipt(options: DeliveryAndReceiptOptions): DeliveryAndReceipt {
  if (options.ledgerPath.trim() === '') {
    throw new PersonalFeedScopeStoreError('personal Feed delivery ledger path must be non-empty')
  }

  const acceptFormalFeedContent = (request: FormalFeedContentDeliveryRequest): C19Result => {
    try {
      if (!isFormalFeedContentDeliveryRequest(request)) return failed(request)
      const records = readRecords(options.ledgerPath)
      const existing = findRequestInRecords(records, request.object.object)
      if (existing !== undefined) {
        return sameRequest(existing, request)
          ? { status: 'accepted', value: { request } }
          : rejected(request)
      }
      const record: DeliveryRecord = {
        schemaVersion: 1,
        event: 'formal_feed_content_delivery_accepted',
        request,
      }
      try {
        appendJsonLine(options.ledgerPath, records, record, serializeDeliveryRecord)
      } catch {
        return acceptedIfExactAppendWasRecovered(options.ledgerPath, records, record, request)
      }
      return acceptedIfExactAppendWasRecovered(options.ledgerPath, records, record, request)
    } catch {
      return failed(request)
    }
  }

  const readFormalFeedContentDeliveryRequest = (
    object: FeedContentDeliveryObjectIdentity,
  ): FormalFeedContentDeliveryRequest | undefined => {
    try {
      return findRequest(options.ledgerPath, object)
    } catch {
      return undefined
    }
  }

  const readFormalFeedContentDeliveryRequestForPeriod = (
    period: PeriodIdentity,
  ): FormalFeedContentDeliveryOwnerRead => {
    if (!isPeriodIdentity(period)) return rejected(period)
    try {
      const matching = readRecords(options.ledgerPath)
        .filter(record => samePeriod(record.request.object.period, period))
      if (matching.length === 0) return { status: 'missing' }
      if (matching.length > 1) return failed(period)
      const request = matching[0]?.request
      return request === undefined ? failed(period) : { status: 'found', value: { request } }
    } catch {
      return failed(period)
    }
  }

  return Object.freeze({
    acceptFormalFeedContent,
    readFormalFeedContentDeliveryRequest,
    readFormalFeedContentDeliveryRequestForPeriod,
  })
}

function readRecords(path: string): readonly DeliveryRecord[] {
  const records = readJsonLines(path, 'delivery and receipt').map((value, index) => parseRecord(value, index + 1))
  const identities = new Set<string>()
  for (const record of records) {
    const object = record.request.object.object
    if (identities.has(object)) {
      throw new PersonalFeedScopeStoreError('personal Feed delivery and receipt ledger has duplicate object ownership')
    }
    identities.add(object)
  }
  return records
}

function parseRecord(value: unknown, lineNumber: number): DeliveryRecord {
  if (!isRecord(value)
    || !hasExactKeys(value, ['event', 'request', 'schemaVersion'])
    || value.schemaVersion !== 1
    || value.event !== 'formal_feed_content_delivery_accepted'
    || !isFormalFeedContentDeliveryRequest(value.request)) {
    throw new PersonalFeedScopeStoreError(
      `personal Feed delivery and receipt ledger line ${lineNumber} has an invalid record`,
    )
  }
  return value as DeliveryRecord
}

function findRequest(path: string, object: FeedContentDeliveryObjectIdentity): FormalFeedContentDeliveryRequest | undefined {
  return findRequestInRecords(readRecords(path), object)
}

function findRequestInRecords(
  records: readonly DeliveryRecord[],
  object: FeedContentDeliveryObjectIdentity,
): FormalFeedContentDeliveryRequest | undefined {
  return records.find(record => record.request.object.object === object)?.request
}

function acceptedIfExactAppendWasRecovered(
  path: string,
  before: readonly DeliveryRecord[],
  appended: DeliveryRecord,
  request: FormalFeedContentDeliveryRequest,
): C19Result {
  try {
    const after = readRecords(path)
    return isExactAppendRecovery(before, after, appended)
      ? { status: 'accepted', value: { request } }
      : failed(request)
  } catch {
    return failed(request)
  }
}

function isExactAppendRecovery(
  before: readonly DeliveryRecord[],
  after: readonly DeliveryRecord[],
  appended: DeliveryRecord,
): boolean {
  return after.length === before.length + 1
    && before.every((record, index) => sameRecord(record, after[index]))
    && sameRecord(after[after.length - 1], appended)
}

function sameRecord(left: DeliveryRecord | undefined, right: DeliveryRecord | undefined): boolean {
  if (left === undefined || right === undefined) return false
  const leftEncoded = encodeCanonicalJson(left)
  const rightEncoded = encodeCanonicalJson(right)
  return leftEncoded !== undefined && leftEncoded === rightEncoded
}

function serializeDeliveryRecord(value: unknown): string {
  const encoded = encodeCanonicalJson(value)
  if (encoded === undefined) throw new PersonalFeedScopeStoreError('personal Feed delivery record is not canonical JSON')
  return encoded
}

function isFormalFeedContentDeliveryRequest(value: unknown): value is FormalFeedContentDeliveryRequest {
  return isRecord(value)
    && hasExactKeys(value, ['object'])
    && isFormalFeedContent(value.object)
    && encodeCanonicalJson(value) !== undefined
}

function isFormalFeedContent(value: unknown): value is FormalFeedContent {
  if (!isRecord(value)
    || !hasExactKeys(value, ['content', 'object', 'original', 'period', 'selected'])
    || typeof value.object !== 'string'
    || typeof value.original !== 'string'
    || !isPeriodIdentity(value.period)
    || !isEditedFeedContent(value.content)
    || !isRecord(value.selected)
    || value.object !== formalFeedContentObjectIdentityFor(value.original as EditingConclusionIdentity)) return false
  if (Object.keys(value.selected).length === 0) return true
  return hasExactKeys(value.selected, ['candidates'])
    && Array.isArray(value.selected.candidates)
    && value.selected.candidates.length > 0
    && new Set(value.selected.candidates.map(canonicalCandidateTupleKey)).size === value.selected.candidates.length
    && value.selected.candidates.every(isSourceCandidateReference)
}

function isPeriodIdentity(value: unknown): value is PeriodIdentity {
  return isRecord(value)
    && hasExactKeys(value, ['period', 'run'])
    && typeof value.run === 'string'
    && typeof value.period === 'string'
}

function samePeriod(left: PeriodIdentity, right: PeriodIdentity): boolean {
  return left.run === right.run && left.period === right.period
}

function isEditedFeedContent(value: unknown): value is { readonly body: unknown } {
  return isRecord(value) && hasExactKeys(value, ['body'])
}

function isSourceCandidateReference(value: unknown): value is SourceCandidateReference {
  return isRecord(value)
    && hasExactKeys(value, ['candidate', 'source', 'stableReference'])
    && typeof value.source === 'string'
    && typeof value.candidate === 'string'
    && typeof value.stableReference === 'string'
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index])
}

function sameRequest(left: FormalFeedContentDeliveryRequest, right: FormalFeedContentDeliveryRequest): boolean {
  const leftEncoded = encodeCanonicalJson(left)
  const rightEncoded = encodeCanonicalJson(right)
  return leftEncoded !== undefined && leftEncoded === rightEncoded
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function failed<T>(input: T): { readonly status: 'failed'; readonly input: T } {
  return { status: 'failed', input }
}

function rejected<T>(input: T): { readonly status: 'rejected'; readonly input: T } {
  return { status: 'rejected', input }
}
