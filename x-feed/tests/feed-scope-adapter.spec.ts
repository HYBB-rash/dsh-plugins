import { describe, expect, it, vi } from 'vitest'
import {
  assertXFeedRequiredSources,
  createXFeedScopeAdapter,
  type XFeedPeriodScopeInput,
} from '../src/feed-scope-adapter.ts'

function input(trigger: 'scheduled' | 'manual'): XFeedPeriodScopeInput {
  return {
    requestIdentity: trigger === 'scheduled'
      ? '2026-08-23T13:00:00.000Z'
      : '2026-08-23T14:00:00.000Z',
    trigger,
    scheduledFor: trigger === 'scheduled'
      ? '2026-08-23T13:05:00.000Z'
      : '2026-08-23T14:05:00.000Z',
    claimedAt: trigger === 'scheduled'
      ? '2026-08-23T13:05:01.000Z'
      : '2026-08-23T14:05:01.000Z',
    runId: trigger === 'scheduled'
      ? '2026-08-23T13:05:02.000Z'
      : '2026-08-23T14:05:02.000Z',
    requiredSources: ['x'],
    reportingWindowClosesAt: trigger === 'scheduled'
      ? '2026-08-23T13:15:00.000Z'
      : '2026-08-23T14:15:00.000Z',
  }
}

describe('X feed period scope adapter', () => {
  it.each(['scheduled', 'manual'] as const)('uses the same external scope method for %s opportunities', async trigger => {
    const established = { kind: 'established', trigger }
    const establishExternalPeriodScope = vi.fn(async (_request: unknown) => established)
    const adapter = createXFeedScopeAdapter({ establishExternalPeriodScope })

    await expect(adapter.establishExternalPeriodScope(input(trigger))).resolves.toBe(established)
    expect(establishExternalPeriodScope).toHaveBeenCalledOnce()
    expect(establishExternalPeriodScope).toHaveBeenCalledWith({
      ...input(trigger),
      source: 'x',
    })
    expect(adapter).not.toHaveProperty('establishScheduledPeriodScope')
    expect(adapter).not.toHaveProperty('establishManualPeriodScope')
  })

  it.each([
    [[]],
    [['x', 'x']],
    [['threads']],
    [['x', 'threads']],
  ] as const)('rejects an invalid required source list without calling the port: %j', async requiredSources => {
    const establishExternalPeriodScope = vi.fn()
    const adapter = createXFeedScopeAdapter({ establishExternalPeriodScope })

    await expect(adapter.establishExternalPeriodScope({
      ...input('manual'),
      requiredSources,
    })).rejects.toMatchObject({ code: 'invalid_required_sources' })
    expect(establishExternalPeriodScope).not.toHaveBeenCalled()
  })

  it('passes every period and reporting-window field through unchanged while fixing source identity to x', async () => {
    const establishExternalPeriodScope = vi.fn(async (request: unknown) => request)
    const adapter = createXFeedScopeAdapter({ establishExternalPeriodScope })
    const request = input('manual')

    await expect(adapter.establishExternalPeriodScope(request)).resolves.toEqual({
      ...request,
      source: 'x',
    })
    const forwarded = establishExternalPeriodScope.mock.calls[0]?.[0] as Record<string, unknown>
    expect(forwarded.requestIdentity).toBe(request.requestIdentity)
    expect(forwarded.trigger).toBe(request.trigger)
    expect(forwarded.scheduledFor).toBe(request.scheduledFor)
    expect(forwarded.claimedAt).toBe(request.claimedAt)
    expect(forwarded.runId).toBe(request.runId)
    expect(forwarded.requiredSources).toBe(request.requiredSources)
    expect(forwarded.reportingWindowClosesAt).toBe(request.reportingWindowClosesAt)
    expect(forwarded.source).toBe('x')
  })

  it('does not call an X provider or pipeline while establishing scope', async () => {
    const establishExternalPeriodScope = vi.fn(async () => ({ kind: 'established' }))
    const xProvider = vi.fn()
    const xPipeline = vi.fn()
    const adapter = createXFeedScopeAdapter({ establishExternalPeriodScope, xProvider, xPipeline })

    await adapter.establishExternalPeriodScope(input('scheduled'))

    expect(establishExternalPeriodScope).toHaveBeenCalledOnce()
    expect(xProvider).not.toHaveBeenCalled()
    expect(xPipeline).not.toHaveBeenCalled()
  })

  it('exposes the same required-source assertion for fail-fast startup wiring', () => {
    expect(() => assertXFeedRequiredSources(['x'])).not.toThrow()
    expect(() => assertXFeedRequiredSources(['x', 'x'])).toThrow('exactly the unique list [x]')
  })
})
