import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  CRON_AGENT_ENVIRONMENT_REGISTRY,
  createCronAgentEnvironmentRegistry,
  provideCronAgentEnvironmentRegistry,
  type CronAgentEnvironmentLease,
  type CronAgentEnvironmentPrepareContext,
  type CronAgentEnvironmentProvider,
} from '../src/run-environment.ts'
import { apply as applyCron } from '../src/index.ts'

const REQUIREMENTS = {
  jobKind: 'agent',
  sessionMode: 'per_run',
  gate: 'forbidden',
} as const

function provider(marker: string): CronAgentEnvironmentProvider {
  return {
    marker,
    requirements: REQUIREMENTS,
    prepare: async () => ({
      setupAgent: async () => undefined,
      verifySurface: async () => undefined,
      dispose: async () => undefined,
    }),
  }
}

describe('dsh-cron run environment registry', () => {
  it('resolves one provider and rejects missing markers without fallback', () => {
    const registry = createCronAgentEnvironmentRegistry([provider('business/v1')])

    expect(registry.resolve('business/v1')).toMatchObject({ ok: true })
    expect(registry.resolve('unknown')).toMatchObject({
      ok: false,
      error: {
        code: 'missing_provider',
        marker: 'unknown',
      },
    })
    expect(registry.resolve(' business/v1 ')).toMatchObject({
      ok: false,
      error: { code: 'missing_provider', marker: ' business/v1 ' },
    })
    expect(registry.resolve('   ')).toMatchObject({
      ok: false,
      error: { code: 'missing_provider' },
    })
  })

  it('fails closed for duplicate markers', () => {
    const registry = createCronAgentEnvironmentRegistry([provider('business/v1'), provider('business/v1')])

    expect(registry.resolve('business/v1')).toMatchObject({
      ok: false,
      error: {
        code: 'duplicate_provider',
        marker: 'business/v1',
      },
    })
  })

  it('returns an idempotent disposer that removes only this registration', () => {
    const registry = createCronAgentEnvironmentRegistry()
    const first = registry.register(provider('business/v1'))
    const second = registry.register(provider('business/v1'))

    expect(registry.resolve('business/v1')).toMatchObject({
      ok: false,
      error: { code: 'duplicate_provider' },
    })
    first()
    expect(registry.resolve('business/v1')).toMatchObject({ ok: true })
    first()
    expect(registry.resolve('business/v1')).toMatchObject({ ok: true })
    second()
    expect(registry.resolve('business/v1')).toMatchObject({
      ok: false,
      error: { code: 'missing_provider' },
    })
    second()
  })

  it('validates generic job requirements before preparing an environment', async () => {
    const prepare = vi.fn(provider('business/v1').prepare)
    const registry = createCronAgentEnvironmentRegistry([{
      ...provider('business/v1'),
      prepare,
    }])

    await expect(registry.prepare('business/v1', {
      jobId: 'cron-business',
      jobKind: 'agent',
      sessionMode: 'persistent',
      gate: 'forbidden',
      runId: 'run-1',
    })).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'requirements_mismatch',
        marker: 'business/v1',
      },
    })
    expect(prepare).not.toHaveBeenCalled()
  })

  it('passes the exact generic job id to a provider after requirements pass', async () => {
    const received: CronAgentEnvironmentPrepareContext[] = []
    const registry = createCronAgentEnvironmentRegistry([{
      ...provider('business/v1'),
      prepare: async context => {
        received.push(context)
        return provider('business/v1').prepare(context)
      },
    }])

    await expect(registry.prepare('business/v1', {
      jobId: 'cron-business',
      jobKind: 'agent',
      sessionMode: 'per_run',
      gate: 'forbidden',
      runId: 'run-1',
    })).resolves.toMatchObject({ ok: true })
    expect(received).toEqual([expect.objectContaining({ jobId: 'cron-business' })])
  })

  it('passes a typed generic skip through prepare without treating it as a lease', async () => {
    const registry = createCronAgentEnvironmentRegistry([{
      ...provider('business/v1'),
      prepare: async () => ({
        kind: 'skip',
        outcome: { text: undefined, error: undefined },
      }) as never,
    }])

    await expect(registry.prepare('business/v1', {
      jobId: 'cron-business',
      jobKind: 'agent',
      sessionMode: 'per_run',
      gate: 'forbidden',
      runId: 'run-skip',
    })).resolves.toMatchObject({
      ok: true,
      skip: {
        kind: 'skip',
        outcome: { text: undefined, error: undefined },
      },
    })
  })

  it.each([
    ['array outcome', { kind: 'skip', outcome: [] }],
    ['extra outcome field', { kind: 'skip', outcome: { text: undefined, error: undefined, extra: true } }],
    ['extra top-level field', { kind: 'skip', outcome: { text: undefined, error: undefined }, extra: true }],
  ])('fails closed for a malformed generic skip (%s)', async (_name, malformed) => {
    const registry = createCronAgentEnvironmentRegistry([{
      ...provider('business/v1'),
      prepare: async () => malformed as never,
    }])

    await expect(registry.prepare('business/v1', {
      jobId: 'cron-business',
      jobKind: 'agent',
      sessionMode: 'per_run',
      gate: 'forbidden',
      runId: 'run-invalid-skip',
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'prepare_failed', operation: 'prepare' },
    })
  })

  it('maps surface verification failures and always exposes cleanup', async () => {
    const dispose = vi.fn(async () => undefined)
    const lease: CronAgentEnvironmentLease = {
      setupAgent: async () => undefined,
      verifySurface: async () => { throw new Error('unexpected tool') },
      dispose,
    }
    const registry = createCronAgentEnvironmentRegistry([{
      ...provider('business/v1'),
      prepare: async () => lease,
    }])
    const prepared = await registry.prepare('business/v1', {
      jobId: 'cron-business',
      jobKind: 'agent',
      sessionMode: 'per_run',
      gate: 'forbidden',
      runId: 'run-1',
    })
    expect(prepared).toMatchObject({ ok: true })
    if (!prepared.ok) throw new Error('expected lease')

    await expect(registry.verify(prepared.lease, {})).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'surface_verification_failed',
        marker: 'business/v1',
      },
    })
    await prepared.lease.dispose()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('owns one registry per Cordis context and removes it with the owning fiber', async () => {
    const first = new Context()
    const second = new Context()
    const firstRegistry = provideCronAgentEnvironmentRegistry(first)
    const secondRegistry = provideCronAgentEnvironmentRegistry(second)

    expect(first.get(CRON_AGENT_ENVIRONMENT_REGISTRY)).toBe(firstRegistry)
    expect(second.get(CRON_AGENT_ENVIRONMENT_REGISTRY)).toBe(secondRegistry)
    expect(firstRegistry).not.toBe(secondRegistry)

    firstRegistry.register(provider('first-only'))
    expect(first.get(CRON_AGENT_ENVIRONMENT_REGISTRY)?.resolve('first-only')).toMatchObject({ ok: true })
    expect(second.get(CRON_AGENT_ENVIRONMENT_REGISTRY)?.resolve('first-only')).toMatchObject({
      ok: false,
      error: { code: 'missing_provider' },
    })

    await first.fiber.dispose()
    expect(first.get(CRON_AGENT_ENVIRONMENT_REGISTRY)).toBeUndefined()
    expect(second.get(CRON_AGENT_ENVIRONMENT_REGISTRY)).toBe(secondRegistry)
    await second.fiber.dispose()
  })

  it('reuses the existing registry when two cron roles share one Cordis context', async () => {
    const ctx = new Context()
    const firstRegistry = provideCronAgentEnvironmentRegistry(ctx)
    const secondRegistry = provideCronAgentEnvironmentRegistry(ctx)

    expect(secondRegistry).toBe(firstRegistry)
    expect(ctx.get(CRON_AGENT_ENVIRONMENT_REGISTRY)).toBe(firstRegistry)

    await ctx.fiber.dispose()
  })

  it('provides the same registry to a later consumer through the real plugin entry', async () => {
    const storeDir = mkdtempSync(join(tmpdir(), 'dsh-cron-environment-service-'))
    const ctx = new Context()
    try {
      await applyCron(ctx, { mode: 'manager', storeDir } as never)
      const consumerRegistry = ctx.get(CRON_AGENT_ENVIRONMENT_REGISTRY)
      expect(consumerRegistry).toBeDefined()
      expect(consumerRegistry).toBe(ctx.get(CRON_AGENT_ENVIRONMENT_REGISTRY))
    } finally {
      await ctx.fiber.dispose()
      rmSync(storeDir, { recursive: true, force: true })
    }
    expect(ctx.get(CRON_AGENT_ENVIRONMENT_REGISTRY)).toBeUndefined()
  })
})
