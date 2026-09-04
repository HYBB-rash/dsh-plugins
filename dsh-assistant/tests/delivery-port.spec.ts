import { describe, expect, it, vi } from 'vitest'
import { createAssistantTextDeliveryPort } from '../src/delivery-port.ts'

const signal = new AbortController().signal

describe('assistant text delivery boundary', () => {
  it('resolves the versioned provider for every delivery instead of caching it', async () => {
    const first = { protocolVersion: 1, deliver: vi.fn(async () => ({ state: 'delivered' as const, deliveredAt: '2026-09-05T01:00:00.000Z' })) }
    const second = { protocolVersion: 1, deliver: vi.fn(async () => ({ state: 'failed' as const, error: 'chat unavailable' })) }
    const resolve = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second)
    const port = createAssistantTextDeliveryPort(resolve)

    await expect(port.deliver({ text: 'first', signal })).resolves.toEqual({ state: 'delivered', deliveredAt: '2026-09-05T01:00:00.000Z' })
    await expect(port.deliver({ text: 'second', signal })).resolves.toEqual({ state: 'failed', error: 'chat unavailable' })
    expect(resolve).toHaveBeenCalledTimes(2)
    expect(first.deliver).toHaveBeenCalledWith({ text: 'first', signal })
    expect(second.deliver).toHaveBeenCalledWith({ text: 'second', signal })
  })

  it.each([
    ['missing', undefined],
    ['wrong version', { protocolVersion: 2, deliver: async () => ({ state: 'delivered', deliveredAt: 'ignored' }) }],
  ])('maps a %s provider to a definite failure before attempting delivery', async (_name, provider) => {
    const port = createAssistantTextDeliveryPort(() => provider)
    await expect(port.deliver({ text: 'hello', signal })).resolves.toMatchObject({ state: 'failed' })
  })

  it.each([
    ['throwing provider', { protocolVersion: 1, deliver: async () => { throw new Error('socket closed') } }],
    ['malformed provider result', { protocolVersion: 1, deliver: async () => ({ state: 'mystery' }) }],
  ])('maps a %s to uncertain after the attempt starts', async (_name, provider) => {
    const port = createAssistantTextDeliveryPort(() => provider)
    await expect(port.deliver({ text: 'hello', signal })).resolves.toMatchObject({ state: 'uncertain' })
  })
})
