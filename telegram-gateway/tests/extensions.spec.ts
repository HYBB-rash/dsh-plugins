import { describe, expect, it, vi } from 'vitest'
import { loadTelegramExtensions } from '../src/extensions.ts'

describe('Telegram extension loader', () => {
  it('loads a trusted adapter and disposes it', async () => {
    const dispose = vi.fn()
    const install = vi.fn(() => dispose)
    const disposers = await loadTelegramExtensions(
      {} as never,
      [{ modulePath: '/opt/business/telegram.js', configJson: '{"dataDir":"/srv/data"}' }],
      async specifier => {
        expect(specifier).toBe('file:///opt/business/telegram.js')
        return { installTelegramExtension: install }
      },
    )
    expect(install).toHaveBeenCalledWith(expect.anything(), { dataDir: '/srv/data' })
    await disposers[0]?.()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('cleans up already-loaded adapters when a later module fails', async () => {
    const dispose = vi.fn()
    let calls = 0
    await expect(loadTelegramExtensions(
      {} as never,
      [{ modulePath: 'one' }, { modulePath: 'two' }],
      async () => {
        calls += 1
        return calls === 1 ? { installTelegramExtension: () => dispose } : {}
      },
    )).rejects.toThrow('does not export installTelegramExtension')
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('resolves a bare business package from the active profile composition', async () => {
    const install = vi.fn()
    const load = vi.fn(async () => ({ installTelegramExtension: install }))
    const ctx = {
      baseUrl: 'file:///srv/dsh/profiles/telegram/cordis.yml',
      loader: { internal: { import: load } },
    }
    await loadTelegramExtensions(ctx as never, [{ modulePath: '@herman/business' }])
    expect(load).toHaveBeenCalledWith(
      '@herman/business',
      'file:///srv/dsh/profiles/telegram/cordis.yml',
      {},
    )
  })
})
