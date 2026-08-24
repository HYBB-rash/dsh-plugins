import type {
  CronAgentEnvironmentBindPreparedDeliveryContext,
  PreparedDeliveryObject,
} from '@deepseek-ai/dsh-cron'
import { isValidPreparedDeliveryObject } from '@deepseek-ai/dsh-cron'
import type {
  DeliveryAndReceipt,
  FeedContentDeliveryObjectIdentity,
  FormalFeedContentDeliveryAccepted,
  FormalFeedContentDeliveryRequest,
  PeriodBusinessFinalizer,
} from '@herman/personal-feed'

export type OrdinaryFeedDeliveryOwnerReader = Pick<
  DeliveryAndReceipt,
  'readFormalFeedContentDeliveryRequest'
>

export interface OrdinaryFeedPreparedDeliveryAdapterOptions {
  readonly delivery: OrdinaryFeedDeliveryOwnerReader
  readonly finalizer: Pick<PeriodBusinessFinalizer, 'requestFormalContentDelivery'>
}

export type OrdinaryFeedPreparedDeliveryResult =
  | {
      readonly status: 'accepted'
      readonly value: { readonly preparedDelivery: PreparedDeliveryObject }
    }
  | { readonly status: 'rejected'; readonly input: FormalFeedContentDeliveryAccepted }
  | { readonly status: 'failed'; readonly input: FormalFeedContentDeliveryAccepted }

export type OrdinaryFeedPreparedDeliveryBindResult =
  | { readonly status: 'accepted' }
  | { readonly status: 'rejected'; readonly input: CronAgentEnvironmentBindPreparedDeliveryContext }
  | { readonly status: 'failed'; readonly input: CronAgentEnvironmentBindPreparedDeliveryContext }

export interface OrdinaryFeedPreparedDeliveryAdapter {
  readonly prepareAcceptedContent: (
    input: FormalFeedContentDeliveryAccepted,
  ) => OrdinaryFeedPreparedDeliveryResult
  readonly bindPreparedDelivery: (
    input: CronAgentEnvironmentBindPreparedDeliveryContext,
  ) => Promise<OrdinaryFeedPreparedDeliveryBindResult>
}

export function createOrdinaryFeedPreparedDeliveryAdapter(
  options: OrdinaryFeedPreparedDeliveryAdapterOptions,
): OrdinaryFeedPreparedDeliveryAdapter {
  const readDurableRequest = options.delivery.readFormalFeedContentDeliveryRequest
  const requestFormalContentDelivery = options.finalizer.requestFormalContentDelivery
  return Object.freeze({
    prepareAcceptedContent: (
      input: FormalFeedContentDeliveryAccepted,
    ): OrdinaryFeedPreparedDeliveryResult => {
      try {
        const projected = projectOrdinaryRequest(input)
        if (projected === undefined) return { status: 'rejected', input }
        const durable = readDurableRequest(projected.objectId)
        if (durable === undefined || !samePlainData(durable, projected.request)) {
          return { status: 'failed', input }
        }
        const accepted = requestFormalContentDelivery(projected.request)
        if (!isExactC19Accepted(accepted, projected.request)) return { status: 'failed', input }
        return {
          status: 'accepted',
          value: { preparedDelivery: projected.preparedDelivery },
        }
      } catch {
        return { status: 'failed', input }
      }
    },
    bindPreparedDelivery: async (
      input: CronAgentEnvironmentBindPreparedDeliveryContext,
    ): Promise<OrdinaryFeedPreparedDeliveryBindResult> => {
      try {
        const projected = projectBindInput(input)
        if (projected === undefined) return { status: 'rejected', input }
        const durable = readDurableRequest(projected.objectId)
        if (durable === undefined) return { status: 'failed', input }
        const owner = projectOrdinaryRequest({ request: durable })
        if (owner === undefined
          || owner.preparedDelivery.objectId !== projected.preparedDelivery.objectId
          || owner.preparedDelivery.text !== projected.preparedDelivery.text) {
          return { status: 'failed', input }
        }
        const accepted = requestFormalContentDelivery(owner.request)
        if (!isExactC19Accepted(accepted, owner.request)) return { status: 'failed', input }
        const binding = {
          businessRunId: owner.businessRunId,
          businessPeriodId: owner.businessPeriodId,
        }
        const result = await projected.bindPreparedDelivery(binding)
        const status = readExactStatus(result, binding)
        if (status === 'accepted') return { status }
        if (status === 'rejected') return { status, input }
        return { status: 'failed', input }
      } catch {
        return { status: 'failed', input }
      }
    },
  })
}

interface ProjectedOrdinaryRequest {
  readonly request: FormalFeedContentDeliveryRequest
  readonly objectId: FeedContentDeliveryObjectIdentity
  readonly businessRunId: string
  readonly businessPeriodId: string
  readonly preparedDelivery: PreparedDeliveryObject
}

function projectOrdinaryRequest(
  input: FormalFeedContentDeliveryAccepted,
): ProjectedOrdinaryRequest | undefined {
  const accepted = readOwnDataProperties(input)
  if (accepted === undefined || !hasExactKeys(accepted, ['request'])) return undefined
  const request = readOwnDataProperties(accepted.get('request'))
  if (request === undefined || !hasExactKeys(request, ['object'])) return undefined
  const objectValue = request.get('object')
  const object = readOwnDataProperties(objectValue)
  if (object === undefined
    || !hasExactKeys(object, ['object', 'period', 'original', 'content', 'selected'])) return undefined
  const objectId = object.get('object')
  const original = object.get('original')
  if (typeof objectId !== 'string' || objectId.trim() === ''
    || typeof original !== 'string' || original.trim() === '') return undefined
  const period = readOwnDataProperties(object.get('period'))
  if (period === undefined || !hasExactKeys(period, ['run', 'period'])) return undefined
  const businessRunId = period.get('run')
  const businessPeriodId = period.get('period')
  if (typeof businessRunId !== 'string' || businessRunId.trim() === ''
    || typeof businessPeriodId !== 'string' || businessPeriodId.trim() === '') return undefined
  const content = readOwnDataProperties(object.get('content'))
  if (content === undefined || !hasExactKeys(content, ['body'])) return undefined
  const text = content.get('body')
  const selected = readOwnDataProperties(object.get('selected'))
  if (selected === undefined || !hasExactKeys(selected, ['candidates'])) return undefined
  const selectedCandidates = readDenseArray(selected.get('candidates'))
  if (selectedCandidates === undefined || selectedCandidates.length === 0) return undefined
  const preparedDelivery = { objectId, text }
  if (!isValidPreparedDeliveryObject(preparedDelivery)) return undefined
  return {
    request: accepted.get('request') as FormalFeedContentDeliveryRequest,
    objectId: objectId as FeedContentDeliveryObjectIdentity,
    businessRunId,
    businessPeriodId,
    preparedDelivery,
  }
}

function projectBindInput(
  input: CronAgentEnvironmentBindPreparedDeliveryContext,
): {
  readonly objectId: FeedContentDeliveryObjectIdentity
  readonly preparedDelivery: PreparedDeliveryObject
  readonly bindPreparedDelivery: CronAgentEnvironmentBindPreparedDeliveryContext[
    'runDeliveryMeaningPort'
  ]['bindPreparedDelivery']
} | undefined {
  const properties = readOwnDataProperties(input)
  if (properties === undefined
    || !hasExactKeys(properties, ['preparedDelivery', 'runDeliveryMeaningPort'])) return undefined
  const prepared = readOwnDataProperties(properties.get('preparedDelivery'))
  if (prepared === undefined || !hasExactKeys(prepared, ['objectId', 'text'])) return undefined
  const preparedDelivery = {
    objectId: prepared.get('objectId'),
    text: prepared.get('text'),
  }
  if (!isValidPreparedDeliveryObject(preparedDelivery)) return undefined
  const port = readOwnDataProperties(properties.get('runDeliveryMeaningPort'))
  if (port === undefined
    || !hasExactKeys(port, [
      'bindPreparedDelivery',
      'acceptDurableReceipt',
      'commitBusinessFinalization',
    ])
    || typeof port.get('bindPreparedDelivery') !== 'function'
    || typeof port.get('acceptDurableReceipt') !== 'function'
    || typeof port.get('commitBusinessFinalization') !== 'function') return undefined
  return {
    objectId: preparedDelivery.objectId as FeedContentDeliveryObjectIdentity,
    preparedDelivery,
    bindPreparedDelivery: port.get('bindPreparedDelivery') as CronAgentEnvironmentBindPreparedDeliveryContext[
      'runDeliveryMeaningPort'
    ]['bindPreparedDelivery'],
  }
}

function isExactC19Accepted(
  value: unknown,
  expectedRequest: FormalFeedContentDeliveryRequest,
): boolean {
  const result = readOwnDataProperties(value)
  if (result === undefined
    || !hasExactKeys(result, ['status', 'value'])
    || result.get('status') !== 'accepted') return false
  const accepted = readOwnDataProperties(result.get('value'))
  return accepted !== undefined
    && hasExactKeys(accepted, ['request'])
    && samePlainData(accepted.get('request'), expectedRequest)
}

function readExactStatus(
  value: unknown,
  expectedInput: { readonly businessRunId: string; readonly businessPeriodId: string },
): 'accepted' | 'rejected' | 'failed' | undefined {
  const properties = readOwnDataProperties(value)
  if (properties === undefined) return undefined
  const status = properties.get('status')
  if (status === 'accepted' && hasExactKeys(properties, ['status'])) return status
  if ((status === 'rejected' || status === 'failed')
    && hasExactKeys(properties, ['status', 'input'])
    && samePlainData(properties.get('input'), expectedInput)) return status
  return undefined
}

function samePlainData(
  left: unknown,
  right: unknown,
  active: WeakMap<object, WeakSet<object>> = new WeakMap(),
): boolean {
  if (!isObject(left) || !isObject(right)) return Object.is(left, right)
  const leftArray = readDenseArray(left)
  const rightArray = readDenseArray(right)
  if (leftArray !== undefined || rightArray !== undefined) {
    if (leftArray === undefined || rightArray === undefined || leftArray.length !== rightArray.length) {
      return false
    }
    if (hasPair(active, left, right)) return false
    rememberPair(active, left, right)
    const equal = leftArray.every((value, index) => samePlainData(value, rightArray[index], active))
    forgetPair(active, left, right)
    return equal
  }
  const leftProperties = readOwnDataProperties(left)
  const rightProperties = readOwnDataProperties(right)
  if (leftProperties === undefined || rightProperties === undefined) return false
  if (hasPair(active, left, right)) return false
  rememberPair(active, left, right)
  const leftKeys = [...leftProperties.keys()].sort()
  const rightKeys = [...rightProperties.keys()].sort()
  const equal = leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index]
      && samePlainData(leftProperties.get(key), rightProperties.get(key), active))
  forgetPair(active, left, right)
  return equal
}

function readOwnDataProperties(value: unknown): ReadonlyMap<string, unknown> | undefined {
  if (!isObject(value) || Array.isArray(value)) return undefined
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return undefined
  const keys = Reflect.ownKeys(value)
  if (keys.some(key => typeof key !== 'string')) return undefined
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const properties = new Map<string, unknown>()
  for (const key of keys) {
    if (typeof key !== 'string') return undefined
    const descriptor = descriptors[key]
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) return undefined
    properties.set(key, descriptor.value)
  }
  return properties
}

function readDenseArray(value: unknown): readonly unknown[] | undefined {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined
  const keys = Reflect.ownKeys(value)
  if (keys.some(key => typeof key !== 'string')) return undefined
  const length = Object.getOwnPropertyDescriptor(value, 'length')?.value as unknown
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0
    || keys.length !== length + 1) return undefined
  const result: unknown[] = []
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) return undefined
    result.push(descriptor.value)
  }
  return result
}

function hasExactKeys(value: ReadonlyMap<string, unknown>, expected: readonly string[]): boolean {
  const actual = [...value.keys()].sort()
  const sortedExpected = [...expected].sort()
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index])
}

function hasPair(active: WeakMap<object, WeakSet<object>>, left: object, right: object): boolean {
  return active.get(left)?.has(right) === true
}

function rememberPair(active: WeakMap<object, WeakSet<object>>, left: object, right: object): void {
  const rights = active.get(left) ?? new WeakSet<object>()
  rights.add(right)
  active.set(left, rights)
}

function forgetPair(active: WeakMap<object, WeakSet<object>>, left: object, right: object): void {
  active.get(left)?.delete(right)
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null
}
