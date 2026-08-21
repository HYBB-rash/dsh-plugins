import { describe, expect, it, vi } from 'vitest'
import { CurrentRunItemRegistry } from '../src/x-cron/current-run-item-registry.ts'
import { prepareDigest } from '../src/x-cron/prepare-digest.ts'

const registry = new CurrentRunItemRegistry([{
  id: 'x-status:1', source: 'https://x.com/alice/status/1', content: '正文', topics: [],
}])
const text = '📦 X 洞察 标题\n\n📌 来源补充\n- 摘要 (https://x.com/alice/status/1)'

describe('prepare digest application helper', () => {
  it('derives URLs from item IDs and calls prepareDelivery exactly once without theme/shown side effects', async () => {
    const prepareDelivery = vi.fn(async () => ({ ok: true, prepared: 1, rejected: [] }))
    const result = await prepareDigest({
      text, themeId: 'topic-a', usedItemIds: ['item:x-status:1'], registry,
      ports: { prepareDelivery },
    })
    expect(result).toMatchObject({ ok: true, text, themeId: 'topic-a', usedItemIds: ['item:x-status:1'] })
    expect(prepareDelivery).toHaveBeenCalledTimes(1)
    expect(prepareDelivery).toHaveBeenCalledWith(text, ['https://x.com/alice/status/1'], { themeId: 'topic-a' })
  })

  it('returns no success and makes zero port calls for invalid item/output or prepare failure', async () => {
    const prepareDelivery = vi.fn(async () => ({ ok: false, reason: 'package_not_found' }))
    await expect(prepareDigest({ text, themeId: 'topic-a', usedItemIds: ['unknown'], registry, ports: { prepareDelivery } }))
      .resolves.toMatchObject({ ok: false })
    expect(prepareDelivery).not.toHaveBeenCalled()
    const failed = await prepareDigest({ text, themeId: 'topic-a', usedItemIds: ['item:x-status:1'], registry, ports: { prepareDelivery } })
    expect(failed).toMatchObject({ ok: false, code: 'prepare-failed' })
    expect(prepareDelivery).toHaveBeenCalledTimes(1)
  })

  it.each([undefined, null, {}, { ok: true }, { ok: false, reason: 'package_not_found' }])(
    'never fabricates success for malformed Python result %j', async raw => {
      const prepareDelivery = vi.fn(async () => raw)
      const result = await prepareDigest({ text, themeId: 'topic-a', usedItemIds: ['item:x-status:1'], registry, ports: { prepareDelivery } })
      expect(result).toMatchObject({ ok: false, code: 'prepare-failed' })
      expect(JSON.stringify(result)).not.toContain('package_not_found')
    },
  )

  it('accepts only the formal Python success shape with the exact prepared count and empty rejected list', async () => {
    const prepareDelivery = vi.fn(async () => ({ ok: true, prepared: 1, rejected: [] }))
    await expect(prepareDigest({ text, themeId: 'topic-a', usedItemIds: ['item:x-status:1'], registry, ports: { prepareDelivery } }))
      .resolves.toMatchObject({ ok: true, pending: true })
    for (const raw of [
      { ok: true, prepared: 0, rejected: [] },
      { ok: true, prepared: 1, rejected: ['bad'] },
      { ok: true, prepared: '1', rejected: [] },
    ]) {
      const result = await prepareDigest({ text, themeId: 'topic-a', usedItemIds: ['item:x-status:1'], registry, ports: { prepareDelivery: vi.fn(async () => raw) } })
      expect(result).toMatchObject({ ok: false, code: 'prepare-failed' })
    }
  })
})
