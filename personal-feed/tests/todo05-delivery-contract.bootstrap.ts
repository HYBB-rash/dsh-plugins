import type {
  BusinessFinalization,
  C20FormalFeedContentResult,
  C21Result,
  C23Result,
  DeliveryChannelResult,
  FeedContentDeliveryObjectIdentity,
  FormalFeedContent,
  FormalFeedContentDeliveryAccepted,
  FormalFeedContentDeliveryReceipt,
  FormalFeedContentDeliveryRequest,
  PeriodIdentity,
} from '../src/index.ts'

type Equal<Left, Right> = (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2) ? true : false
type Assert<Value extends true> = Value
type Keys<Value> = keyof Value
type Check<Value, Expected> = 0 extends (1 & Value) ? true : Equal<Value, Expected>
type CheckKeys<Value, Expected> = 0 extends (1 & Value) ? true : Equal<Keys<Value>, Expected>

type _DeliveryChannelResultIsExactlyThreeStates = Assert<Check<
  DeliveryChannelResult,
  'Delivered' | 'Failed' | 'Uncertain'
>>
type _FormalReceiptKeysAreExact = Assert<CheckKeys<
  FormalFeedContentDeliveryReceipt,
  'object' | 'period' | 'result'
>>
type _C19RequestKeysAreExact = Assert<CheckKeys<FormalFeedContentDeliveryRequest, 'object'>>
type _C19AcceptedKeysAreExact = Assert<CheckKeys<FormalFeedContentDeliveryAccepted, 'request'>>
type C20Accepted = Extract<C20FormalFeedContentResult, { readonly status: 'accepted' }>
type C21Accepted = Extract<C21Result, { readonly status: 'accepted' }>
type C23Accepted = Extract<C23Result, { readonly status: 'accepted' }>
type _C20AcceptedKeysAreExact = Assert<CheckKeys<C20Accepted['value'], 'receipt'>>
type _C21AcceptedKeysAreExact = Assert<CheckKeys<C21Accepted['value'], 'period' | 'receipt'>>
type _C23AcceptedKeysAreExact = Assert<CheckKeys<C23Accepted['value'], 'period'>>
type _BusinessFinalizationHasOnlyOnePeriod = Assert<
  0 extends (1 & BusinessFinalization)
    ? true
    : Equal<Extract<Keys<BusinessFinalization>, `${string}period${string}`>, 'period'>
>

const period = {} as PeriodIdentity
const object = '' as FeedContentDeliveryObjectIdentity
const content = {} as FormalFeedContent
const request: FormalFeedContentDeliveryRequest = { object: content }
const accepted: FormalFeedContentDeliveryAccepted = { request }
const result: DeliveryChannelResult = 'Delivered'
const receipt: FormalFeedContentDeliveryReceipt = { object, period, result }

const c19RequestShape: FormalFeedContentDeliveryRequest = { object: content }
const c19AcceptedShape: FormalFeedContentDeliveryAccepted = { request: c19RequestShape }
const c20AcceptedShape: Extract<C20FormalFeedContentResult, { readonly status: 'accepted' }> = {
  status: 'accepted',
  value: { receipt },
}
const c21AcceptedShape: Extract<C21Result, { readonly status: 'accepted' }> = {
  status: 'accepted',
  value: { period, receipt },
}
const businessFinalization = {} as BusinessFinalization
const c23AcceptedShape: Extract<C23Result, { readonly status: 'accepted' }> = {
  status: 'accepted',
  value: { period },
}

void accepted
void c19AcceptedShape
void c20AcceptedShape
void c21AcceptedShape
void businessFinalization
void c23AcceptedShape
void receipt
void c19RequestShape
void request
