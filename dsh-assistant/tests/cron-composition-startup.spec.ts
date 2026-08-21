/**
 * Lane C / G: red tests for composition-root readiness.
 *
 * Unix-socket/control readiness belongs to the outer assistant adapter and
 * composition startup.  ReminderRuntime/scheduler are not the readiness
 * owner, and an unavailable manager must not be reported as a started monitor.
 */

import { describe, expect, it } from 'vitest'

type LocalControlPort = {
  readiness(): Promise<{ readonly state: 'ready' | 'unavailable'; readonly reason?: string }>
}

type StartupReport = {
  readonly state: 'ready' | 'unavailable'
  readonly reconciliationState: 'completed' | 'budget_exhausted' | 'unavailable'
  readonly processed: number
  readonly reason?: string
}

type CompositionModule = {
  startAssistantCronControl(input: {
    readonly controlPort: LocalControlPort
    readonly reconcileStartup: () => Promise<{
      readonly state: 'completed' | 'budget_exhausted' | 'unavailable'
      readonly processed: number
      readonly reason?: string
    }>
  }): Promise<StartupReport>
}

async function loadCompositionModule(): Promise<{ readonly module?: CompositionModule; readonly error?: unknown }> {
  try {
    const module = await import('../src/cron-composition.ts') as unknown as CompositionModule
    return { module }
  } catch (error: unknown) {
    return { error }
  }
}

describe('assistant cron composition startup readiness (first red)', () => {
  it('reports ready only after async readiness and one bounded reconciliation startup call', async () => {
    const loaded = await loadCompositionModule()
    expect(loaded.error, 'cron composition startup module is not implemented yet').toBeUndefined()
    if (loaded.error !== undefined || loaded.module === undefined) return

    let reconciliations = 0
    const report = await loaded.module.startAssistantCronControl({
      controlPort: { readiness: async () => ({ state: 'ready' }) },
      reconcileStartup: async () => {
        reconciliations++
        return { state: 'completed', processed: 1 }
      },
    })
    expect(report).toMatchObject({ state: 'ready', reconciliationState: 'completed', processed: 1 })
    expect(report).not.toHaveProperty('monitorStarted')
    expect(reconciliations).toBe(1)
  })

  it('reports unavailable without claiming any monitor started when the manager control plane is unavailable', async () => {
    const loaded = await loadCompositionModule()
    expect(loaded.error, 'cron composition startup module is not implemented yet').toBeUndefined()
    if (loaded.error !== undefined || loaded.module === undefined) return

    let reconciliations = 0
    const report = await loaded.module.startAssistantCronControl({
      controlPort: { readiness: async () => ({ state: 'unavailable', reason: 'manager socket unavailable' }) },
      reconcileStartup: async () => {
        reconciliations++
        return { state: 'completed', processed: 1 }
      },
    })
    expect(report).toMatchObject({
      state: 'unavailable',
      reconciliationState: 'unavailable',
      processed: 0,
      reason: 'manager socket unavailable',
    })
    expect(report).not.toHaveProperty('monitorStarted')
    expect(reconciliations).toBe(0)
  })

  it('does not turn a failed reconciliation into a ready startup report', async () => {
    const loaded = await loadCompositionModule()
    expect(loaded.error, 'cron composition startup module is not implemented yet').toBeUndefined()
    if (loaded.error !== undefined || loaded.module === undefined) return

    const report = await loaded.module.startAssistantCronControl({
      controlPort: { readiness: async () => ({ state: 'ready' }) },
      reconcileStartup: async () => ({ state: 'unavailable', processed: 0 }),
    })
    expect(report).toMatchObject({ state: 'unavailable', reconciliationState: 'unavailable', processed: 0 })
    expect(report).not.toHaveProperty('monitorStarted')
  })

  it('keeps the control plane ready while reporting a bounded reconciliation budget exhaustion', async () => {
    const loaded = await loadCompositionModule()
    expect(loaded.error, 'cron composition startup module is not implemented yet').toBeUndefined()
    if (loaded.error !== undefined || loaded.module === undefined) return

    let reconciliations = 0
    const report = await loaded.module.startAssistantCronControl({
      controlPort: { readiness: async () => ({ state: 'ready' }) },
      reconcileStartup: async () => {
        reconciliations++
        return { state: 'budget_exhausted', processed: 100, reason: 'startup reconciliation exceeded 30s budget' }
      },
    })
    expect(report).toMatchObject({
      state: 'ready',
      reconciliationState: 'budget_exhausted',
      processed: 100,
      reason: 'startup reconciliation exceeded 30s budget',
    })
    expect(report).not.toHaveProperty('monitorStarted')
    expect(reconciliations).toBe(1)
  })

  it('reports unavailable and stops after one readiness attempt when readiness throws', async () => {
    const loaded = await loadCompositionModule()
    expect(loaded.error, 'cron composition startup module is not implemented yet').toBeUndefined()
    if (loaded.error !== undefined || loaded.module === undefined) return

    let readinessAttempts = 0
    let reconciliations = 0
    const report = await loaded.module.startAssistantCronControl({
      controlPort: {
        readiness: async () => {
          readinessAttempts++
          throw new Error('manager socket probe failed')
        },
      },
      reconcileStartup: async () => {
        reconciliations++
        return { state: 'completed', processed: 1 }
      },
    })
    expect(report).toMatchObject({
      state: 'unavailable',
      reconciliationState: 'unavailable',
      processed: 0,
      reason: 'manager socket probe failed',
    })
    expect(report).not.toHaveProperty('monitorStarted')
    expect(readinessAttempts).toBe(1)
    expect(reconciliations).toBe(0)
  })
})
