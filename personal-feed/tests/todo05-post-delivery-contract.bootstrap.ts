import type {
  BusinessFinalization,
  BusinessFinalizationReceiver,
  C21Result,
  C23Result,
  C28Result,
  CrossSourceEditor,
  DisplayFact,
  FormalCandidateDisposition,
  FormalFeedContentDeliveryReceipt,
  PeriodBusinessFinalizer,
  PeriodBusinessFinalizerOptions,
  PeriodIdentity,
  RecentDeduplicationBasisAccepted,
  SourceCandidateReference,
} from '../src/index.ts'

const period = {} as PeriodIdentity
const candidate = {} as SourceCandidateReference
const object = '' as FormalFeedContentDeliveryReceipt['object']

const deliveredReceipt = { object, period, result: 'Delivered' } satisfies FormalFeedContentDeliveryReceipt
const failedReceipt = { object, period, result: 'Failed' } satisfies FormalFeedContentDeliveryReceipt
const uncertainReceipt = { object, period, result: 'Uncertain' } satisfies FormalFeedContentDeliveryReceipt

const deliveredDisposition = {
  period,
  source: candidate.source,
  candidate,
  value: 'Shown',
} satisfies FormalCandidateDisposition
const failedDisposition = {
  period,
  source: candidate.source,
  candidate,
  value: 'NotDeliveredThisPeriod',
} satisfies FormalCandidateDisposition
const uncertainDisposition = {
  period,
  source: candidate.source,
  candidate,
  value: 'PossiblyDelivered',
} satisfies FormalCandidateDisposition

const deliveredFact = {
  period,
  candidate,
  disposition: deliveredDisposition,
  receipt: deliveredReceipt,
} satisfies DisplayFact
const failedFact = {
  period,
  candidate,
  disposition: failedDisposition,
  receipt: failedReceipt,
} satisfies DisplayFact
const uncertainFact = {
  period,
  candidate,
  disposition: uncertainDisposition,
  receipt: uncertainReceipt,
} satisfies DisplayFact

type Equal<Left, Right> = (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2) ? true : false
type Assert<Value extends true> = Value
type DeliveredDisplayFact = Extract<DisplayFact, { readonly receipt: { readonly result: 'Delivered' } }>
type FailedDisplayFact = Extract<DisplayFact, { readonly receipt: { readonly result: 'Failed' } }>
type UncertainDisplayFact = Extract<DisplayFact, { readonly receipt: { readonly result: 'Uncertain' } }>
type _DeliveredMapsToShown = Assert<Equal<DeliveredDisplayFact['disposition']['value'], 'Shown'>>
type _FailedMapsToNotDelivered = Assert<Equal<FailedDisplayFact['disposition']['value'], 'NotDeliveredThisPeriod'>>
type _UncertainMapsToPossiblyDelivered = Assert<Equal<UncertainDisplayFact['disposition']['value'], 'PossiblyDelivered'>>
type _DisplayFactKeysAreExact = Assert<Equal<keyof DisplayFact, 'period' | 'candidate' | 'disposition' | 'receipt'>>
type _RecentDeduplicationBasisKeysAreExact = Assert<Equal<keyof RecentDeduplicationBasisAccepted, 'fact'>>

const displayFactReceiver: CrossSourceEditor = {} as CrossSourceEditor
type C28Accepted = Extract<C28Result, { readonly status: 'accepted' }>
type _C28AcceptedKeysAreExact = Assert<Equal<keyof C28Accepted['value'], 'fact'>>
const c28Accepted: Extract<C28Result, { readonly status: 'accepted' }> = {
  status: 'accepted',
  value: { fact: deliveredFact } satisfies RecentDeduplicationBasisAccepted,
}
const c28Result: C28Result = displayFactReceiver.acceptDisplayFact(deliveredFact)

const finalizer: PeriodBusinessFinalizer = {} as PeriodBusinessFinalizer
const c21Result: C21Result = finalizer.acceptFormalFeedContentDeliveryReceipt(deliveredReceipt)

const businessFinalizationReceiver: BusinessFinalizationReceiver = {
  acceptBusinessFinalization(finalization: BusinessFinalization): C23Result {
    return { status: 'accepted', value: { period: finalization.period } }
  },
}
const finalizerOptions: PeriodBusinessFinalizerOptions = {
  periodScopeLedgerPath: '',
  reportLedgerPath: '',
  now: () => '',
  businessFinalizationReceiver,
}

void failedFact
void uncertainFact
void c28Accepted
void c28Result
void c21Result
void finalizerOptions
