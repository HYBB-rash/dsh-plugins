/** Composition-root startup boundary for the assistant Cron bridge. */

import type { AssistantCronControlPort } from './cron-control-port.ts'

export interface AssistantCronStartupReport {
  readonly state: 'ready' | 'unavailable'
  readonly reconciliationState: 'completed' | 'budget_exhausted' | 'unavailable'
  readonly processed: number
  readonly reason?: string
}

export async function startAssistantCronControl(input: {
  readonly controlPort: Pick<AssistantCronControlPort, 'readiness'>
  readonly reconcileStartup: () => Promise<{
    readonly state: 'completed' | 'budget_exhausted' | 'unavailable'
    readonly processed: number
    readonly reason?: string
  }>
}): Promise<AssistantCronStartupReport> {
  let readiness: { readonly state: 'ready' | 'unavailable'; readonly reason?: string }
  try {
    readiness = await input.controlPort.readiness()
  } catch (error: unknown) {
    return {
      state: 'unavailable',
      reconciliationState: 'unavailable',
      processed: 0,
      reason: error instanceof Error ? error.message : String(error),
    }
  }
  if (readiness.state !== 'ready') {
    return {
      state: 'unavailable',
      reconciliationState: 'unavailable',
      processed: 0,
      ...(readiness.reason === undefined ? {} : { reason: readiness.reason }),
    }
  }
  try {
    const reconciliation = await input.reconcileStartup()
    if (reconciliation.state === 'unavailable') {
      return {
        state: 'unavailable',
        reconciliationState: 'unavailable',
        processed: 0,
        ...(reconciliation.reason === undefined ? {} : { reason: reconciliation.reason }),
      }
    }
    return {
      state: 'ready',
      reconciliationState: reconciliation.state,
      processed: reconciliation.processed,
      ...(reconciliation.reason === undefined ? {} : { reason: reconciliation.reason }),
    }
  } catch (error: unknown) {
    return {
      state: 'unavailable',
      reconciliationState: 'unavailable',
      processed: 0,
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}
