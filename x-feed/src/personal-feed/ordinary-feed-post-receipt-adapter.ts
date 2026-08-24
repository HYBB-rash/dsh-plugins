import type {
  CronDeliveryReceipt,
  CronRunDeliveryMeaningRunPort,
} from '@deepseek-ai/dsh-cron'
import type {
  DeliveryAndReceipt,
  FeedContentDeliveryObjectIdentity,
  FormalFeedContentDeliveryReceipt,
  FormalFeedContentDeliveryRequest,
  OrdinaryContentFinalized,
  PeriodBusinessFinalizer,
  RunFeedContentDeliveryMeaningRecorded,
} from '@herman/personal-feed'
import type { CandidateLocalStateRuntime } from './candidate-local-state.ts'
import type { OrdinaryBusinessFinalizationOwner } from './ordinary-business-finalization-owner.ts'

export type OrdinaryFeedPostReceiptDeliveryReader = Pick<
  DeliveryAndReceipt,
  'readFormalFeedContentDeliveryRequest'
>

export type OrdinaryFeedPostReceiptFinalizer = Pick<
  PeriodBusinessFinalizer,
  | 'requestFormalContentDelivery'
  | 'acceptFormalFeedContentDeliveryReceipt'
  | 'ensureBusinessFinalization'
>

export type OrdinaryFeedPostReceiptCandidateState = Pick<
  CandidateLocalStateRuntime,
  'completePendingSourceDispositions'
>

export type OrdinaryFeedPostReceiptFinalizationReader = Pick<
  OrdinaryBusinessFinalizationOwner,
  'readAcceptedOrdinaryFinalization'
>

export type OrdinaryFeedPostReceiptRunPort = Pick<
  CronRunDeliveryMeaningRunPort,
  'acceptDurableReceipt' | 'commitBusinessFinalization'
>

export type OrdinaryFeedPostReceiptAdapterOptions = {
  readonly delivery: OrdinaryFeedPostReceiptDeliveryReader
  readonly finalizer: OrdinaryFeedPostReceiptFinalizer
  readonly candidateLocalState: OrdinaryFeedPostReceiptCandidateState
  readonly finalizationOwner: OrdinaryFeedPostReceiptFinalizationReader
  readonly runDeliveryMeaningPort: OrdinaryFeedPostReceiptRunPort
}

export type OrdinaryFeedPostReceiptResult =
  | { readonly status: 'accepted' }
  | { readonly status: 'failed'; readonly input: CronDeliveryReceipt }

export type OrdinaryFeedPostReceiptAdapter = {
  readonly settleDurableReceipt: (
    receipt: CronDeliveryReceipt,
  ) => Promise<OrdinaryFeedPostReceiptResult>
}

export function createOrdinaryFeedPostReceiptAdapter(
  options: OrdinaryFeedPostReceiptAdapterOptions,
): OrdinaryFeedPostReceiptAdapter {
  const acceptDurableReceipt = options.runDeliveryMeaningPort.acceptDurableReceipt
  const commitBusinessFinalization = options.runDeliveryMeaningPort.commitBusinessFinalization
  const readDelivery = options.delivery.readFormalFeedContentDeliveryRequest
  const replayC19 = options.finalizer.requestFormalContentDelivery
  const acceptC21 = options.finalizer.acceptFormalFeedContentDeliveryReceipt
  const ensureC23 = options.finalizer.ensureBusinessFinalization
  const completeCandidates = options.candidateLocalState.completePendingSourceDispositions
  const readC23Owner = options.finalizationOwner.readAcceptedOrdinaryFinalization

  return Object.freeze({
    settleDurableReceipt: async (
      receipt: CronDeliveryReceipt,
    ): Promise<OrdinaryFeedPostReceiptResult> => {
      const failed = (): OrdinaryFeedPostReceiptResult => ({ status: 'failed', input: receipt })
      try {
        const meaning = await acceptDurableReceipt(receipt)
        if (!isAcceptedCronReceipt(meaning, receipt)) return failed()

        const request = readDelivery(durableObjectIdentity(receipt.objectId))
        if (!isOrdinaryRequestForReceipt(request, receipt)) return failed()
        const c19 = replayC19(request)
        if (!isAcceptedC19(c19, request)) return failed()

        const formalReceipt = formalReceiptFor(request, receipt)
        if (formalReceipt === undefined) return failed()
        const c20: RunFeedContentDeliveryMeaningRecorded = { receipt: formalReceipt }
        const c21 = acceptC21(c20.receipt)
        if (!isAcceptedC21(c21, c20.receipt)) return failed()

        const completion = completeCandidates()
        if (!isCompletedCandidateState(completion)) return failed()

        const finalization: OrdinaryContentFinalized = {
          kind: 'ordinary_content_finalized',
          period: request.object.period,
        }
        const c23 = ensureC23(finalization)
        if (!isAcceptedC23(c23, finalization)) return failed()
        const finalizationOwner = readC23Owner(finalization.period)
        if (finalizationOwner === undefined || !sameValue(finalizationOwner, finalization)) return failed()

        const committed = await commitBusinessFinalization()
        return isAcceptedWithoutValue(committed) ? { status: 'accepted' } : failed()
      } catch {
        return failed()
      }
    },
  })
}

function durableObjectIdentity(value: string): FeedContentDeliveryObjectIdentity {
  return value as FeedContentDeliveryObjectIdentity
}

function isAcceptedCronReceipt(value: unknown, receipt: CronDeliveryReceipt): boolean {
  const envelope = plainRecord(value, ['status', 'value'])
  const accepted = plainRecord(envelope?.get('value'), ['receipt'])
  return envelope?.get('status') === 'accepted'
    && accepted !== undefined
    && sameValue(accepted.get('receipt'), receipt)
}

function isOrdinaryRequestForReceipt(
  request: FormalFeedContentDeliveryRequest | undefined,
  receipt: CronDeliveryReceipt,
): request is FormalFeedContentDeliveryRequest {
  if (request === undefined
    || request.object.object !== receipt.objectId
    || !('candidates' in request.object.selected)
    || request.object.selected.candidates.length === 0) return false
  return true
}

function isAcceptedC19(value: unknown, request: FormalFeedContentDeliveryRequest): boolean {
  const envelope = plainRecord(value, ['status', 'value'])
  const accepted = plainRecord(envelope?.get('value'), ['request'])
  return envelope?.get('status') === 'accepted'
    && accepted !== undefined
    && sameValue(accepted.get('request'), request)
}

function formalReceiptFor(
  request: FormalFeedContentDeliveryRequest,
  receipt: CronDeliveryReceipt,
): FormalFeedContentDeliveryReceipt | undefined {
  const result = receipt.deliveryState === 'delivered'
    ? 'Delivered'
    : receipt.deliveryState === 'failed'
      ? 'Failed'
      : receipt.deliveryState === 'uncertain'
        ? 'Uncertain'
        : undefined
  return result === undefined ? undefined : {
    object: request.object.object,
    period: request.object.period,
    result,
  }
}

function isAcceptedC21(value: unknown, receipt: FormalFeedContentDeliveryReceipt): boolean {
  const envelope = plainRecord(value, ['status', 'value'])
  const accepted = plainRecord(envelope?.get('value'), ['period', 'receipt'])
  return envelope?.get('status') === 'accepted'
    && accepted !== undefined
    && sameValue(accepted.get('period'), receipt.period)
    && sameValue(accepted.get('receipt'), receipt)
}

function isCompletedCandidateState(value: unknown): boolean {
  const envelope = plainRecord(value, ['status', 'value'])
  const accepted = plainRecord(envelope?.get('value'), ['completed'])
  const completed = accepted?.get('completed')
  return envelope?.get('status') === 'completed'
    && typeof completed === 'number'
    && Number.isSafeInteger(completed)
    && completed >= 0
}

function isAcceptedC23(value: unknown, finalization: OrdinaryContentFinalized): boolean {
  const envelope = plainRecord(value, ['status', 'value'])
  const accepted = plainRecord(envelope?.get('value'), ['period'])
  return envelope?.get('status') === 'accepted'
    && accepted !== undefined
    && sameValue(accepted.get('period'), finalization.period)
}

function isAcceptedWithoutValue(value: unknown): boolean {
  return plainRecord(value, ['status'])?.get('status') === 'accepted'
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    const leftValues = plainArray(left)
    const rightValues = plainArray(right)
    return leftValues !== undefined
      && rightValues !== undefined
      && leftValues.length === rightValues.length
      && leftValues.every((value, index) => sameValue(value, rightValues[index]))
  }
  const leftRecord = plainRecord(left)
  const rightRecord = plainRecord(right)
  if (leftRecord === undefined || rightRecord === undefined) return false
  const leftKeys = [...leftRecord.keys()].sort()
  const rightKeys = [...rightRecord.keys()].sort()
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index]
      && sameValue(leftRecord.get(key), rightRecord.get(key)))
}

function plainRecord(
  value: unknown,
  expected?: readonly string[],
): ReadonlyMap<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  let prototype: object | null
  let keys: readonly PropertyKey[]
  try {
    prototype = Object.getPrototypeOf(value) as object | null
    keys = Reflect.ownKeys(value)
  } catch {
    return undefined
  }
  if (prototype !== Object.prototype && prototype !== null
    || keys.some(key => typeof key !== 'string')) return undefined
  const actual = (keys as readonly string[]).slice().sort()
  if (expected !== undefined) {
    const sortedExpected = [...expected].sort()
    if (actual.length !== sortedExpected.length
      || !actual.every((key, index) => key === sortedExpected[index])) return undefined
  }
  const record = new Map<string, unknown>()
  for (const key of actual) {
    let descriptor: PropertyDescriptor | undefined
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key)
    } catch {
      return undefined
    }
    if (descriptor === undefined || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      return undefined
    }
    record.set(key, descriptor.value)
  }
  return record
}

function plainArray(value: unknown): readonly unknown[] | undefined {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined
  let keys: readonly PropertyKey[]
  try {
    keys = Reflect.ownKeys(value)
  } catch {
    return undefined
  }
  const expected = [...Array.from({ length: value.length }, (_, index) => String(index)), 'length']
  if (keys.length !== expected.length || expected.some(key => !keys.includes(key))) return undefined
  const result: unknown[] = []
  for (let index = 0; index < value.length; index += 1) {
    let descriptor: PropertyDescriptor | undefined
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    } catch {
      return undefined
    }
    if (descriptor === undefined || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      return undefined
    }
    result.push(descriptor.value)
  }
  return result
}
