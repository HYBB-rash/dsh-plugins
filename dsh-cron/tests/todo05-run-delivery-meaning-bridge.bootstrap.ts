/**
 * Compile-only contract probe for the source-neutral scheduler bridge.
 *
 * This file imports the intended public types directly. It deliberately
 * defines no replacement interface and is not a Vitest behavior fixture.
 */

import type {
  CronAgentEnvironmentPrepareContext,
  CronAgentEnvironmentProvider,
  CronPreparedDeliveryRecoveryContext,
  CronRunDeliveryMeaningRunPort,
  CronAgentEnvironmentBindPreparedDeliveryContext,
  CronAgentEnvironmentRecoveredDeliverySettle,
  CronRunDeliveryMeaningPortFactory,
  CronPreparedDeliveryClaimBinding,
} from '../src/run-environment.ts'
import type { CronDeliveryReceipt, PreparedDeliveryObject } from '../src/types.ts'

type Assert<T extends true> = T
type Equal<Left, Right> =
  (<T>() => T extends Left ? 1 : 2) extends
  (<T>() => T extends Right ? 1 : 2)
    ? ((<T>() => T extends Right ? 1 : 2) extends
        (<T>() => T extends Left ? 1 : 2) ? true : false)
    : false

type OptIn = CronAgentEnvironmentProvider['runDeliveryMeaningLifecycle']
type PreparePort = CronAgentEnvironmentPrepareContext['runDeliveryMeaningPort']
type RecoveryPort = CronPreparedDeliveryRecoveryContext['runDeliveryMeaningPort']
type _ExactOptIn = Assert<Equal<OptIn, boolean | undefined>>
type _PreparePortOptional = Assert<Equal<PreparePort, CronRunDeliveryMeaningRunPort | undefined>>
type _RecoveryPortOptional = Assert<Equal<RecoveryPort, CronRunDeliveryMeaningRunPort | undefined>>
type _SameLegacyPort = Assert<Equal<PreparePort, RecoveryPort>>
type _ReadonlyPreparePort = Assert<Equal<
  Pick<CronAgentEnvironmentPrepareContext, 'runDeliveryMeaningPort'>,
  Readonly<Pick<CronAgentEnvironmentPrepareContext, 'runDeliveryMeaningPort'>>
>>

type PortKeys = keyof CronRunDeliveryMeaningRunPort
type _ExactPortKeys = Assert<Equal<
  PortKeys,
  'bindPreparedDelivery' | 'acceptDurableReceipt' | 'commitBusinessFinalization'
>>
type _ReadonlyPort = Assert<Equal<
  CronRunDeliveryMeaningRunPort,
  Readonly<CronRunDeliveryMeaningRunPort>
>>
type ForbiddenPortKeys = Extract<
  PortKeys,
  | 'claim'
  | 'jobId'
  | 'runId'
  | 'storeDir'
  | 'list'
  | 'enumerate'
  | 'lineage'
  | 'objectClass'
  | 'retry'
  | 'policy'
>
type _OpaquePort = Assert<Equal<ForbiddenPortKeys, never>>

type BindInput = Parameters<CronRunDeliveryMeaningRunPort['bindPreparedDelivery']>[0]
type CommitParams = Parameters<CronRunDeliveryMeaningRunPort['commitBusinessFinalization']>
type BindForbiddenKeys = Extract<
  keyof BindInput,
  | 'claim'
  | 'jobId'
  | 'runId'
  | 'lineage'
  | 'objectClass'
  | 'retry'
  | 'policy'
>
type _NarrowBind = Assert<Equal<BindForbiddenKeys, never>>
type _ExactBindInput = Assert<Equal<BindInput, {
  readonly businessRunId: string
  readonly businessPeriodId: string
}>>
type _BindParams = Assert<Equal<Parameters<CronRunDeliveryMeaningRunPort['bindPreparedDelivery']>['length'], 1>>
type _CommitParams = Assert<Equal<CommitParams, []>>
type AcceptParams = Parameters<CronRunDeliveryMeaningRunPort['acceptDurableReceipt']>
type _AcceptParams = Assert<Equal<AcceptParams, [CronDeliveryReceipt]>>
type AcceptResult = Awaited<ReturnType<CronRunDeliveryMeaningRunPort['acceptDurableReceipt']>>
type AcceptAccepted = Extract<AcceptResult, { readonly status: 'accepted' }>
type AcceptValue = AcceptAccepted['value']
type _AcceptAcceptedKeys = Assert<Equal<keyof AcceptAccepted, 'status' | 'value'>>
type _AcceptValueKeys = Assert<Equal<keyof AcceptValue, 'receipt'>>
type _AcceptReceipt = Assert<Equal<AcceptValue['receipt'], CronDeliveryReceipt>>
type AcceptRejected = Extract<AcceptResult, { readonly status: 'rejected' }>
type AcceptFailed = Extract<AcceptResult, { readonly status: 'failed' }>
type _AcceptRejectedKeys = Assert<Equal<keyof AcceptRejected, 'status' | 'input'>>
type _AcceptFailedKeys = Assert<Equal<keyof AcceptFailed, 'status' | 'input'>>
type _AcceptRejectedInput = Assert<Equal<AcceptRejected['input'], CronDeliveryReceipt>>
type _AcceptFailedInput = Assert<Equal<AcceptFailed['input'], CronDeliveryReceipt>>

type BindHook = NonNullable<CronAgentEnvironmentProvider['bindPreparedDelivery']>
type BindHookInput = Parameters<BindHook>[0]
type _ExactBindHookKeys = Assert<Equal<keyof BindHookInput, 'preparedDelivery' | 'runDeliveryMeaningPort'>>
type _BindHookPort = Assert<Equal<BindHookInput['runDeliveryMeaningPort'], CronRunDeliveryMeaningRunPort>>
type _BindHookObject = Assert<Equal<BindHookInput['preparedDelivery'], PreparedDeliveryObject>>
type _BindHookContext = Assert<Equal<BindHookInput, CronAgentEnvironmentBindPreparedDeliveryContext>>

type BindResult = Awaited<ReturnType<CronRunDeliveryMeaningRunPort['bindPreparedDelivery']>>
type CommitResult = Awaited<ReturnType<CronRunDeliveryMeaningRunPort['commitBusinessFinalization']>>
type BindAccepted = Extract<BindResult, { readonly status: 'accepted' }>
type BindRejected = Extract<BindResult, { readonly status: 'rejected' }>
type CommitAccepted = Extract<CommitResult, { readonly status: 'accepted' }>
type CommitRejected = Extract<CommitResult, { readonly status: 'rejected' }>
type _BindAcceptedKeys = Assert<Equal<keyof BindAccepted, 'status'>>
type _BindRejectedKeys = Assert<Equal<keyof BindRejected, 'status' | 'input'>>
type _CommitAcceptedKeys = Assert<Equal<keyof CommitAccepted, 'status'>>
type _CommitRejectedKeys = Assert<Equal<keyof CommitRejected, 'status' | 'input'>>
type _BindFailed = Assert<Equal<Extract<BindResult, { readonly status: 'failed' }>['status'], 'failed'>>
type _CommitFailed = Assert<Equal<Extract<CommitResult, { readonly status: 'failed' }>['status'], 'failed'>>

type RecoverySettleParams = Parameters<CronAgentEnvironmentRecoveredDeliverySettle>
type _RecoverySettlePort = Assert<Equal<RecoverySettleParams[1], CronRunDeliveryMeaningRunPort | undefined>>

type FactoryKeys = keyof CronRunDeliveryMeaningPortFactory
type ForbiddenFactoryKeys = Extract<
  FactoryKeys,
  | 'current'
  | 'get'
  | 'runId'
  | 'list'
  | 'store'
  | 'storeDir'
  | 'enumerate'
>
type _FactoryKeys = Assert<Equal<FactoryKeys, 'createRunPort'>>
type _FactoryForbiddenKeys = Assert<Equal<ForbiddenFactoryKeys, never>>
type _FactoryInput = Assert<Equal<
  Parameters<CronRunDeliveryMeaningPortFactory['createRunPort']>,
  [CronPreparedDeliveryClaimBinding]
>>
type FactoryResult = Awaited<ReturnType<CronRunDeliveryMeaningPortFactory['createRunPort']>>
type FactoryAccepted = Extract<FactoryResult, { readonly status: 'accepted' }>
type _FactoryAcceptedKeys = Assert<Equal<keyof FactoryAccepted, 'status' | 'port' | 'dispose'>>
type _FactoryAcceptedPort = Assert<Equal<FactoryAccepted['port'], CronRunDeliveryMeaningRunPort>>
type _FactoryAcceptedDispose = Assert<Equal<
  FactoryAccepted['dispose'],
  () => void | Promise<void>
>>
type FactoryFailed = Extract<FactoryResult, { readonly status: 'failed' }>
type _FactoryFailedKeys = Assert<Equal<keyof FactoryFailed, 'status' | 'error'>>
type _FactoryFailed = Assert<Equal<Extract<FactoryResult, { readonly status: 'failed' }>['status'], 'failed'>>

export type CompileContract = {
  readonly exactOptIn: _ExactOptIn
  readonly preparePortOptional: _PreparePortOptional
  readonly recoveryPortOptional: _RecoveryPortOptional
  readonly sameLegacyPort: _SameLegacyPort
  readonly readonlyPreparePort: _ReadonlyPreparePort
  readonly opaquePort: _OpaquePort
  readonly narrowBind: _NarrowBind
  readonly bindParams: _BindParams
  readonly commitParams: _CommitParams
  readonly bindHookPort: _BindHookPort
  readonly bindHookObject: _BindHookObject
  readonly bindHookContext: _BindHookContext
}
