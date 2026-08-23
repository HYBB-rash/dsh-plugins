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
  sourceIdentity,
} from '@herman/personal-feed'
import { join } from 'node:path'
import { parseXFeedRuntimeConfig } from './config.ts'
import {
  assertXFeedRequiredSources,
  createXFeedScopeAdapter,
  X_FEED_SOURCE_IDENTITY,
} from './feed-scope-adapter.ts'
import { DeliveryReceipt } from './receipt.ts'
import { createXFeedCronEnvironmentProvider } from './x-cron/provider.ts'

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

  const receipt = new DeliveryReceipt({
    cronJobId: config.cronJobId,
    dataDir: config.dataDir,
    pythonBin: config.pythonBin,
    pipelinePath: config.pipelinePath,
    logger: ctx.logger,
  })
  const provider = createXFeedCronEnvironmentProvider({
    ctx,
    cronJobId: config.cronJobId,
    dataDir: config.dataDir,
    pythonBin: config.pythonBin,
    pipelinePath: config.pipelinePath,
  })

  return Object.freeze({
    marker: provider.marker,
    requirements: provider.requirements,
    settleRecoveredRun: async (event: CronRunFinishedEvent) => {
      await receipt.handle(event)
    },
    prepare: async (context: CronAgentEnvironmentPrepareContext) => {
      const closesAt = reportingWindowClosesAt(context.claimedAt, candidateReportingWindowMs)
      await scopeAdapter.establishExternalPeriodScope({
        requestIdentity: `dsh-cron:${context.jobId}:${context.runId}`,
        trigger: context.trigger,
        scheduledFor: context.scheduledFor,
        claimedAt: context.claimedAt,
        runId: context.runId,
        requiredSources: config.personalFeedRequiredSources,
        reportingWindowClosesAt: closesAt,
      })
      const lease = await provider.prepare(context)
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

function reportingWindowClosesAt(claimedAt: string, durationMs: number): string {
  const closesAt = Date.parse(claimedAt) + durationMs
  if (!Number.isFinite(closesAt)) throw new Error('x-feed cannot derive a finite candidate reporting window')
  return new Date(closesAt).toISOString()
}
