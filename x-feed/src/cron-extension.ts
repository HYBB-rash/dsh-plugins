import type { Context } from '@deepseek-ai/cordis'
import type {
  CronAgentEnvironmentPrepareContext,
  CronAgentEnvironmentProvider,
  CronRunFinishedEvent,
} from '@deepseek-ai/dsh-cron'
import { parseXFeedRuntimeConfig } from './config.ts'
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
      const lease = await provider.prepare(context)
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
