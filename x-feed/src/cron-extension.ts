import type { Context } from '@deepseek-ai/cordis'
import type {
  CronAgentEnvironmentPrepareContext,
  CronAgentEnvironmentProvider,
  CronRunFinishedEvent,
} from '@deepseek-ai/dsh-cron'
import {
  createCandidateMaterialProjection,
  createCurrentContextProjection,
  createMechanicalAdmission,
  createPersonalFeedScopeService,
  createPeriodBusinessFinalizer,
  sourceIdentity,
} from '@herman/personal-feed'
import type {
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
  type XFeedSourceCandidateReportWiring,
} from './x-cron/provider.ts'
import { createXSourceCandidateReportPorts } from './x-cron/source-candidate-report.ts'

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
  const scopeService = createPersonalFeedScopeService({
    ledgerPath: join(config.personalFeedDataDir, 'period-scopes.jsonl'),
    sourceScopes: [{
      source: xSource,
      mechanicalAdmission: createMechanicalAdmission(xSource),
      candidateMaterialProjection: createCandidateMaterialProjection(xSource),
    }],
    currentContextProjection: createCurrentContextProjection(),
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
  const sourceCandidateReportFinalizer = createPeriodBusinessFinalizer({
    periodScopeLedgerPath: join(config.personalFeedDataDir, 'period-scopes.jsonl'),
    reportLedgerPath: join(config.personalFeedDataDir, 'source-candidate-reports.jsonl'),
    now: () => new Date().toISOString(),
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

  return Object.freeze({
    marker: provider.marker,
    requirements: provider.requirements,
    settleRecoveredRun: async (event: CronRunFinishedEvent) => {
      await receipt.handle(event)
    },
    prepare: async (context: CronAgentEnvironmentPrepareContext) => {
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
      const sourceCandidateReport = sourceCandidateReportWiring(
        established,
        sourceCandidateReportFinalizer,
      )
      const runProvider = createXFeedCronEnvironmentProvider({
        ...providerOptions,
        sourceCandidateReport,
      })
      const lease = await runProvider.prepare(context)
      if ('kind' in lease && lease.kind === 'skip') return lease
      return {
        ...lease,
        settleRun: async (event: CronRunFinishedEvent) => {
          if (event.jobId !== context.jobId || event.runId !== context.runId) {
            throw new Error('x-feed received a terminal receipt for a different run')
          }
          await receipt.handle(event)
        },
      }
    },
  })
}

function sourceCandidateReportWiring(
  established: PeriodScopeEstablished,
  finalizer: SourceCandidateReportFinalizer,
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
  }
}

function reportingWindowClosesAt(claimedAt: string, durationMs: number): string {
  const closesAt = Date.parse(claimedAt) + durationMs
  if (!Number.isFinite(closesAt)) throw new Error('x-feed cannot derive a finite candidate reporting window')
  return new Date(closesAt).toISOString()
}
