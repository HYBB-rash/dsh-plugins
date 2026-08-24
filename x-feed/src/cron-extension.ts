import type { Context } from '@deepseek-ai/cordis'
import type {
  CronAgentEnvironmentBindPreparedDeliveryContext,
  CronAgentEnvironmentPrepareContext,
  CronAgentEnvironmentProvider,
  CronDeliveryReceipt,
  CronPreparedDeliveryRecoveryContext,
  CronRunDeliveryMeaningRunPort,
  CronRunFinishedEvent,
} from '@deepseek-ai/dsh-cron'
import { toCronPreparedDeliveryClaimBinding } from '@deepseek-ai/dsh-cron'
import {
  createCandidateMaterialProjection,
  createDeliveryAndReceipt,
  createCurrentContextProjection,
  createCrossSourceEditor,
  createMechanicalAdmission,
  createPersonalFeedScopeService,
  createPeriodBusinessFinalizer,
  createSourceCandidateReportReader,
  sourceIdentity,
} from '@herman/personal-feed'
import type {
  PeriodBusinessFinalizer,
  PeriodScopeEstablished,
  SourceCandidateReportFinalizer,
} from '@herman/personal-feed'
import { join } from 'node:path'
import { parseXFeedRuntimeConfig } from './config.ts'
import {
  assertXFeedRequiredSources,
  createXFeedScopeAdapter,
  X_FEED_SOURCE_IDENTITY,
} from './feed-scope-adapter.ts'
import { DeliveryReceipt } from './receipt.ts'
import {
  createXFeedCronEnvironmentProvider,
  createXFeedCronEnvironmentProviderForOrdinaryFeed,
  type XFeedSourceCandidateReportWiring,
} from './x-cron/provider.ts'
import { createXSourceCandidateReportPorts } from './x-cron/source-candidate-report.ts'
import type { XCandidateEditingInputPorts } from './x-cron/candidate-editing-input.ts'
import { createCandidateLocalState } from './personal-feed/candidate-local-state.ts'
import { createOrdinaryBusinessFinalizationOwner } from './personal-feed/ordinary-business-finalization-owner.ts'
import { createOrdinaryFeedPostReceiptAdapter } from './personal-feed/ordinary-feed-post-receipt-adapter.ts'
import { createOrdinaryFeedPreparedDeliveryAdapter } from './personal-feed/ordinary-feed-prepared-delivery-adapter.ts'
import { createOrdinaryFeedRunLifecycle } from './personal-feed/ordinary-feed-run-lifecycle.ts'

/**
 * Business-owned dsh-cron environment. The host owns scheduling and the final
 * delivery lifecycle; this module owns X-specific preparation and settlement.
 */
export function createCronEnvironmentExtension(
  ctx: Context,
  rawConfig: Readonly<Record<string, unknown>>,
): CronAgentEnvironmentProvider {
  const config = parseXFeedRuntimeConfig(rawConfig)
  if (config.cronJobId.trim() === '') throw new Error('x-feed cron extension requires cronJobId')
  if (config.candidateReportingWindowMs === undefined) {
    throw new Error('x-feed cron extension requires candidateReportingWindowMs')
  }
  const candidateReportingWindowMs = config.candidateReportingWindowMs
  assertXFeedRequiredSources(config.personalFeedRequiredSources)

  const xSource = sourceIdentity(X_FEED_SOURCE_IDENTITY)
  const periodScopeLedgerPath = join(config.personalFeedDataDir, 'period-scopes.jsonl')
  const candidatePeriodLedgerPath = join(config.personalFeedDataDir, 'candidate-period-facts.jsonl')
  const editingInputLedgerPath = join(config.personalFeedDataDir, 'editing-inputs.jsonl')
  const periodBusinessLedgerPath = join(config.personalFeedDataDir, 'period-business.jsonl')
  const reportLedgerPath = join(config.personalFeedDataDir, 'source-candidate-reports.jsonl')
  const crossSourceEditor = createCrossSourceEditor({
    candidatePeriodLedgerPath,
    editingInputLedgerPath,
    periodBusinessLedgerPath,
    periodScopeLedgerPath,
    currentContextInputLedgerPath: join(config.personalFeedDataDir, 'current-context-inputs.jsonl'),
  })
  const currentContextProjection = createCurrentContextProjection({
    resultProducer: {
      produceCurrentContextResult: scope => ({
        kind: 'unavailable',
        value: {
          scope,
          period: scope.period,
          unavailableFact: { kind: 'no_configured_authorized_context_source' },
        },
      }),
    },
    c11Receiver: crossSourceEditor,
  })
  const scopeService = createPersonalFeedScopeService({
    ledgerPath: periodScopeLedgerPath,
    sourceScopes: [{
      source: xSource,
      mechanicalAdmission: createMechanicalAdmission(xSource),
      candidateMaterialProjection: createCandidateMaterialProjection(xSource),
    }],
    currentContextProjection,
  })
  const scopeAdapter = createXFeedScopeAdapter({
    establishExternalPeriodScope: request => scopeService.establishExternalPeriodScope({
      requestIdentity: request.requestIdentity,
      trigger: request.trigger,
      scheduledFor: request.scheduledFor,
      claimedAt: request.claimedAt,
      runId: request.runId,
      requiredSources: request.requiredSources.map(sourceIdentity),
      reportingWindowClosesAt: request.reportingWindowClosesAt,
    }),
  })
  const deliveryAndReceipt = createDeliveryAndReceipt({
    ledgerPath: join(config.personalFeedDataDir, 'delivery-and-receipt.jsonl'),
  })
  const ordinaryBusinessFinalizationOwner = createOrdinaryBusinessFinalizationOwner({
    ledgerPath: join(config.personalFeedDataDir, 'ordinary-business-finalizations.jsonl'),
  })
  let periodBusinessFinalizer: PeriodBusinessFinalizer & SourceCandidateReportFinalizer
  const candidateLocalState = createCandidateLocalState({
    ledgerPath: join(config.personalFeedDataDir, 'candidate-local-state.jsonl'),
    completionPort: {
      requestSourceDisposition: disposition => periodBusinessFinalizer.requestSourceDisposition(disposition),
      acceptSourceDispositionState: state => periodBusinessFinalizer.acceptSourceDispositionState(state),
    },
  })
  periodBusinessFinalizer = createPeriodBusinessFinalizer({
    periodScopeLedgerPath,
    reportLedgerPath,
    candidatePeriodLedgerPath,
    editingInputLedgerPath,
    periodBusinessLedgerPath,
    now: () => new Date().toISOString(),
    editingInputClosureReceiver: crossSourceEditor,
    candidateDispositionReceiver: candidateLocalState.candidateDispositionReceiver,
    formalContentDeliveryReceiver: deliveryAndReceipt,
    displayFactReceiver: crossSourceEditor,
    businessFinalizationReceiver: ordinaryBusinessFinalizationOwner.receiver,
  })
  const sourceCandidateReportReader = createSourceCandidateReportReader({ reportLedgerPath })
  const ordinaryFeedRunLifecycle = createOrdinaryFeedRunLifecycle({
    ctx,
    editor: crossSourceEditor,
    finalizer: periodBusinessFinalizer,
    deliveryAndReceipt,
    candidateLocalState,
    finalizationOwner: ordinaryBusinessFinalizationOwner,
  })
  const ordinaryFeedPreparedDelivery = createOrdinaryFeedPreparedDeliveryAdapter({
    delivery: deliveryAndReceipt,
    finalizer: periodBusinessFinalizer,
  })
  const receipt = new DeliveryReceipt({
    cronJobId: config.cronJobId,
    dataDir: config.dataDir,
    pythonBin: config.pythonBin,
    pipelinePath: config.pipelinePath,
    logger: ctx.logger,
  })
  const providerOptions = {
    ctx,
    cronJobId: config.cronJobId,
    dataDir: config.dataDir,
    pythonBin: config.pythonBin,
    pipelinePath: config.pipelinePath,
  }
  const provider = createXFeedCronEnvironmentProvider(providerOptions)

  const prepareXFeedRun = async (context: CronAgentEnvironmentPrepareContext) => {
    const closesAt = reportingWindowClosesAt(context.claimedAt, candidateReportingWindowMs)
    const established = await scopeAdapter.establishExternalPeriodScope({
      requestIdentity: `dsh-cron:${context.jobId}:${context.runId}`,
      trigger: context.trigger,
      scheduledFor: context.scheduledFor,
      claimedAt: context.claimedAt,
      runId: context.runId,
      requiredSources: config.personalFeedRequiredSources,
      reportingWindowClosesAt: closesAt,
    })
    const c11 = await currentContextProjection.completeCurrentContextForEstablishedScope(established.c33.value)
    if (c11.status !== 'accepted') {
      throw new Error('x-feed C11 current-context result was not accepted')
    }
    const recoveredExistingOrdinaryFeed = ordinaryFeedRunLifecycle.recoverExistingOrdinaryFeed({
      period: established.c01.value.period,
      context,
    })
    if (recoveredExistingOrdinaryFeed !== undefined) return recoveredExistingOrdinaryFeed
    const sourceCandidateReport = sourceCandidateReportWiring(
      established,
      periodBusinessFinalizer,
      crossSourceEditor,
    )
    const acceptedReport = sourceCandidateReportReader.readAcceptedSourceCandidateReport(
      sourceCandidateReport.materialProjectionReportScope,
    )
    if (acceptedReport.status === 'rejected' || acceptedReport.status === 'failed') {
      throw new Error(`x-feed C36 recovery read was ${acceptedReport.status}`)
    }
    if (acceptedReport.status === 'found' && acceptedReport.value.report.candidates.length === 0) {
      return { kind: 'skip' as const, outcome: { text: undefined, error: undefined } }
    }
    const providerSourceCandidateReport = acceptedReport.status === 'found'
      ? { ...sourceCandidateReport, acceptedReport: acceptedReport.value }
      : sourceCandidateReport
    const runProvider = createXFeedCronEnvironmentProviderForOrdinaryFeed(
      {
        ...providerOptions,
        sourceCandidateReport: providerSourceCandidateReport,
      },
      {
        prepareOrdinaryFeed: () => ordinaryFeedRunLifecycle.prepareOrdinaryFeed({
          period: established.c01.value.period,
          context,
        }),
      },
    )
    const lease = await runProvider.prepare(context)
    if ('kind' in lease && lease.kind === 'skip') return lease
    if ('preparedDelivery' in lease) return lease
    return {
      ...lease,
      settleRun: async (event: CronRunFinishedEvent) => {
        if (event.jobId !== context.jobId || event.runId !== context.runId) {
          throw new Error('x-feed received a terminal receipt for a different run')
        }
        await receipt.handle(event)
      },
    }
  }

  return Object.freeze({
    marker: provider.marker,
    requirements: provider.requirements,
    preparedDeliveryLifecycle: true,
    runDeliveryMeaningLifecycle: true,
    bindPreparedDelivery: async (context: CronAgentEnvironmentBindPreparedDeliveryContext) => {
      const result = await ordinaryFeedPreparedDelivery.bindPreparedDelivery(context)
      if (result.status !== 'accepted') {
        throw new Error('x-feed prepared delivery binding was not accepted')
      }
    },
    settleRecoveredDelivery: async (
      receiptValue: CronDeliveryReceipt,
      runDeliveryMeaningPort?: CronRunDeliveryMeaningRunPort,
    ) => {
      if (runDeliveryMeaningPort === undefined) {
        throw new Error('x-feed recovered delivery settlement requires a run delivery meaning port')
      }
      const postReceipt = createOrdinaryFeedPostReceiptAdapter({
        delivery: deliveryAndReceipt,
        finalizer: periodBusinessFinalizer,
        candidateLocalState,
        finalizationOwner: ordinaryBusinessFinalizationOwner,
        runDeliveryMeaningPort,
      })
      const result = await postReceipt.settleDurableReceipt(receiptValue)
      if (result.status !== 'accepted') {
        throw new Error('x-feed recovered delivery settlement was not accepted')
      }
      return { status: 'accepted' as const }
    },
    recoverPreparedDelivery: async (context: CronPreparedDeliveryRecoveryContext) => {
      const claim = toCronPreparedDeliveryClaimBinding(context)
      const lease = await prepareXFeedRun(context)
      if ('kind' in lease) {
        return { status: 'not-ready' as const, claim }
      }
      if (!('preparedDelivery' in lease)) {
        if ('dispose' in lease) await lease.dispose()
        return { status: 'conflict' as const, claim }
      }
      const recoveredPreparedDelivery = lease.preparedDelivery
      await lease.dispose()
      return {
        status: 'ready' as const,
        claim,
        preparedDelivery: recoveredPreparedDelivery,
      }
    },
    settleRecoveredRun: async (event: CronRunFinishedEvent) => {
      await receipt.handle(event)
    },
    prepare: prepareXFeedRun,
  })
}

function sourceCandidateReportWiring(
  established: PeriodScopeEstablished,
  finalizer: SourceCandidateReportFinalizer & XCandidateEditingInputPorts['periodFinalizer'],
  crossSourceEditor: ReturnType<typeof createCrossSourceEditor>,
): XFeedSourceCandidateReportWiring {
  const c32 = established.c32.find(scope => scope.value.source === X_FEED_SOURCE_IDENTITY)
  const c35 = established.c35.find(scope => scope.value.scope.source === X_FEED_SOURCE_IDENTITY)
  if (c32 === undefined || c35 === undefined) {
    throw new Error('x-feed period scope did not establish the X C32/C35 values')
  }
  return {
    period: established.c01.value.period,
    mechanicalAdmissionScope: c32.value,
    materialProjectionReportScope: c35.value,
    candidatePort: createXSourceCandidateReportPorts(),
    reportPort: {
      submitSourceCandidateReport: report => finalizer.acceptSourceCandidateReport(report),
    },
    periodFinalizer: finalizer,
    crossSourceEditor,
  }
}

function reportingWindowClosesAt(claimedAt: string, durationMs: number): string {
  const closesAt = Date.parse(claimedAt) + durationMs
  if (!Number.isFinite(closesAt)) throw new Error('x-feed cannot derive a finite candidate reporting window')
  return new Date(closesAt).toISOString()
}
