import { describe, expect, it } from 'vitest'
import { CurrentRunItemRegistry } from '../src/x-cron/current-run-item-registry.ts'
import { renderDigest } from '../src/x-cron/digest-renderer.ts'

const registry = new CurrentRunItemRegistry([{
  id: 'x-status:1', source: 'https://x.com/alice/status/1', content: '正文', topics: [],
}])

describe('deterministic digest renderer', () => {
  it('renders non-empty sections in fixed order with one canonical URL per item', () => {
    const result = renderDigest({
      title: '本轮洞察',
      sections: [
        { kind: 'source', items: [{ itemId: 'item:x-status:1', summary: '来源' }] },
        { kind: 'highlight', items: [{ itemId: 'item:x-status:1', summary: '重点' }] },
      ],
    }, registry)
    expect(result).toMatchObject({ ok: false, code: 'duplicate-item-id' })

    const valid = renderDigest({
      title: '本轮洞察',
      sections: [
        { kind: 'source', items: [{ itemId: 'item:x-status:1', summary: '来源' }] },
      ],
    }, registry)
    expect(valid).toMatchObject({ ok: true, urls: ['https://x.com/alice/status/1'] })
    if (!valid.ok) return
    expect(valid.text).toBe('📦 X 洞察 本轮洞察\n\n📌 来源补充\n- 来源 (https://x.com/alice/status/1)')
    expect(renderDigest({
      title: '本轮洞察',
      sections: [{ kind: 'source', items: [{ itemId: 'item:x-status:1', summary: '来源' }] }],
    }, registry)).toEqual(valid)
  })

  it('fails closed for unknown item, oversized output, and output-contract violations', () => {
    expect(renderDigest({ title: '标题', sections: [{ kind: 'source', items: [{ itemId: 'unknown', summary: 'x' }] }] }, registry))
      .toMatchObject({ ok: false, code: 'unknown-item-id' })
    expect(renderDigest({ title: '标题', sections: [{ kind: 'source', items: [{ itemId: 'item:x-status:1', summary: 'x'.repeat(401) }] }] }, registry))
      .toMatchObject({ ok: false })
  })
})
