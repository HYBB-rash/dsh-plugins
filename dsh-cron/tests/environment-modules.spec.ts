import { describe, expect, it, vi } from 'vitest'
import { loadCronEnvironmentModules } from '../src/environment-modules.ts'

describe('cron environment module loader', () => {
  it('passes bounded JSON config to a generic provider factory', async () => {
    const create = vi.fn(() => ({
      marker: 'business/v1',
      requirements: {},
      prepare: async () => ({ setupAgent: () => undefined, verifySurface: () => undefined, dispose: () => undefined }),
    }))
    const imported: string[] = []
    const providers = await loadCronEnvironmentModules(
      {} as never,
      [{ modulePath: '/opt/business/provider.js', configJson: '{"jobId":"job-a"}' }],
      async specifier => {
        imported.push(specifier)
        return { createCronEnvironmentExtension: create }
      },
    )
    expect(imported[0]).toMatch(/^file:\/\/\/opt\/business\/provider\.js$/)
    expect(create).toHaveBeenCalledWith(expect.anything(), { jobId: 'job-a' })
    expect(providers).toHaveLength(1)
    expect(providers[0]?.marker).toBe('business/v1')
  })

  it('rejects invalid config and modules without the factory contract', async () => {
    await expect(loadCronEnvironmentModules(
      {} as never,
      [{ modulePath: 'business-provider', configJson: '[]' }],
      async () => ({}),
    )).rejects.toThrow('must encode an object')
    await expect(loadCronEnvironmentModules(
      {} as never,
      [{ modulePath: 'business-provider' }],
      async () => ({}),
    )).rejects.toThrow('does not export createCronEnvironmentExtension')
  })
})
