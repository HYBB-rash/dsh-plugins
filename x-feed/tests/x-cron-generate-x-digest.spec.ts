import { describe, expect, it, vi } from 'vitest'
import { generateXDigest } from '../src/x-cron/generate-x-digest.ts'

describe('generateXDigest application service', () => {
  const candidate = {
    id: 'x-status:1',
    source: 'https://x.com/alice/status/1',
    content: '正文',
    topics: ['systems'],
    title: '条目一',
    summary: '条目一摘要',
  } as const
  const secondCandidate = {
    id: 'x-status:2',
    source: 'https://x.com/alice/status/2',
    content: '正文二',
    topics: ['systems'],
    title: '条目二',
    summary: '条目二摘要',
  } as const
  const searchedCandidate = {
    id: 'x-status:3',
    source: 'https://x.com/bob/status/3',
    content: '随机换台后的正文',
    topics: ['anime'],
    title: '随机换台条目',
    summary: '随机换台摘要',
  } as const

  const plan = (exploration: { kind: 'none' } | { kind: 'search'; topicId: string } | { kind: 'explore'; candidateId: string }) => ({
    selectedCandidateIds: ['x-status:1'],
    themeId: 'theme-a',
    exploration,
  })

  function basePorts(overrides: Partial<{
    plan: (request: unknown) => unknown
    search: (topicId: string) => unknown
    explore: (candidateId: string) => unknown
    projectFacts: (item: unknown) => unknown
    prepareDelivery: (text: string, urls: readonly string[], options: { themeId: string }) => unknown
  }> = {}) {
    return {
      plan: vi.fn(overrides.plan ?? (() => plan({ kind: 'none' }))),
      search: vi.fn(overrides.search ?? (() => ({ items: [], summary: '没有新增结果' }))),
      explore: vi.fn(overrides.explore ?? (() => ({ content: '扩展正文', topics: [], summary: '扩展摘要' }))),
      projectFacts: vi.fn(overrides.projectFacts ?? (() => ({ facts: [], audit: { policyId: 'x-cron-exact-target', policyVersion: '1', matchedLocatorCount: 0 } }))),
      prepareDelivery: vi.fn(overrides.prepareDelivery ?? (() => ({ ok: true, prepared: 1, rejected: [] }))),
    }
  }

  it('skips an empty current run without calling any port', async () => {
    const ports = {
      plan: vi.fn(),
      search: vi.fn(),
      explore: vi.fn(),
      projectFacts: vi.fn(),
      prepareDelivery: vi.fn(),
    }

    const result = await generateXDigest({
      candidates: [],
      allowedThemes: ['topic-a'],
      allowedTopics: ['topic-b'],
      allowlistedExploreIds: [],
      ports,
    })

    expect(result).toEqual({ kind: 'skip', outcome: { text: undefined, error: undefined } })
    expect(ports.plan).not.toHaveBeenCalled()
    expect(ports.search).not.toHaveBeenCalled()
    expect(ports.explore).not.toHaveBeenCalled()
    expect(ports.projectFacts).not.toHaveBeenCalled()
    expect(ports.prepareDelivery).not.toHaveBeenCalled()
  })

  it('plans once, projects only selected items, and prepares once with the theme object', async () => {
    const ports = basePorts({
      plan: () => plan({ kind: 'none' }),
      projectFacts: item => ({
        facts: [{ targetId: 'item:x-status:1', summary: `事实 ${item && typeof item === 'object' && 'id' in item ? item.id : ''}` }],
        audit: { policyId: 'x-cron-exact-target', policyVersion: '1', matchedLocatorCount: 1 },
      }),
    })
    const ready = await generateXDigest({ candidates: [candidate, secondCandidate], allowedThemes: ['theme-a'], allowedTopics: [], allowlistedExploreIds: [], ports })
    expect(ready.kind).toBe('ready')
    if (ready.kind !== 'ready') return
    expect(ports.plan).toHaveBeenCalledTimes(1)
    expect(ports.projectFacts).toHaveBeenCalledTimes(1)
    expect(ports.projectFacts).toHaveBeenCalledWith({ id: candidate.id, source: candidate.source, content: candidate.content, topics: candidate.topics })
    expect(ready.composerMaterial.exploration).toEqual({ kind: 'none' })
    const dto = { title: '本轮洞察', sections: [{ kind: 'source' as const, items: [{ itemId: 'item:x-status:1', summary: '来源' }] }] }
    await expect(ready.finalize(dto)).resolves.toEqual({ text: '📦 X 洞察 本轮洞察\n\n📌 来源补充\n- 来源 (https://x.com/alice/status/1)', error: undefined })
    expect(ports.prepareDelivery).toHaveBeenCalledTimes(1)
    expect(ports.prepareDelivery).toHaveBeenCalledWith(
      '📦 X 洞察 本轮洞察\n\n📌 来源补充\n- 来源 (https://x.com/alice/status/1)',
      ['https://x.com/alice/status/1'],
      { themeId: 'theme-a' },
    )
  })

  it('mechanically changes topic once, admits discovered items, and lets the composer judge them', async () => {
    const ports = basePorts({
      plan: () => plan({ kind: 'none' }),
      search: () => ({ items: [searchedCandidate], summary: '换台搜索完成' }),
    })
    const ready = await generateXDigest({
      candidates: [candidate, secondCandidate],
      allowedThemes: ['theme-a'],
      allowedTopics: [],
      allowlistedExploreIds: ['x-status:1', 'x-status:2'],
      randomWalk: {
        roll: 0,
        options: [{ kind: 'search', topicId: 'anime', themeId: 'anime' }],
      },
      ports,
    })

    expect(ready.kind).toBe('ready')
    if (ready.kind !== 'ready') return
    expect(ports.plan).toHaveBeenCalledTimes(1)
    expect(ports.search).toHaveBeenCalledTimes(1)
    expect(ports.search).toHaveBeenCalledWith('anime')
    expect(ports.explore).not.toHaveBeenCalled()
    expect(ready.themeId).toBe('anime')
    expect(ready.composerMaterial.exploration).toEqual({
      kind: 'search', topicId: 'anime', status: 'success', summary: '换台搜索完成',
    })
    expect(ready.composerMaterial.selectedItems.map(item => item.itemId)).toEqual([
      'item:x-status:3',
      'item:x-status:1',
    ])

    await expect(ready.finalize({
      title: '随机漫步',
      sections: [{ kind: 'wander', items: [{ itemId: 'item:x-status:3', summary: '换台后值得发' }] }],
    })).resolves.toEqual({
      text: '📦 X 洞察 随机漫步\n\n🔄 漫游发现\n- 换台后值得发 (https://x.com/bob/status/3)',
      error: undefined,
    })
    expect(ports.prepareDelivery).toHaveBeenCalledWith(
      '📦 X 洞察 随机漫步\n\n🔄 漫游发现\n- 换台后值得发 (https://x.com/bob/status/3)',
      ['https://x.com/bob/status/3'],
      { themeId: 'anime' },
    )
  })

  it('does not retry or change the recorded theme when the mechanical topic switch fails', async () => {
    const ports = basePorts({
      plan: () => plan({ kind: 'none' }),
      search: () => { throw new Error('search failed') },
    })
    const ready = await generateXDigest({
      candidates: [candidate],
      allowedThemes: ['theme-a'],
      allowedTopics: [],
      allowlistedExploreIds: ['x-status:1'],
      randomWalk: {
        roll: 0,
        options: [{ kind: 'search', topicId: 'anime', themeId: 'anime' }],
      },
      ports,
    })

    expect(ready.kind).toBe('ready')
    if (ready.kind !== 'ready') return
    expect(ports.search).toHaveBeenCalledTimes(1)
    expect(ready.themeId).toBe('theme-a')
    expect(ready.composerMaterial.exploration).toEqual({
      kind: 'search', topicId: 'anime', status: 'failed', summary: 'search unavailable',
    })
    expect(ready.composerMaterial.selectedItems.map(item => item.itemId)).toEqual(['item:x-status:1'])
  })

  it('uses the run-local roll to choose exactly one option from the mechanical walk pool', async () => {
    const ports = basePorts({ plan: () => plan({ kind: 'none' }) })
    const ready = await generateXDigest({
      candidates: [candidate, secondCandidate],
      allowedThemes: ['theme-a'],
      allowedTopics: [],
      allowlistedExploreIds: ['x-status:1', 'x-status:2'],
      randomWalk: {
        roll: 0.75,
        options: [
          { kind: 'search', topicId: 'anime', themeId: 'anime' },
          { kind: 'explore', candidateId: 'x-status:2', themeId: 'mixed' },
        ],
      },
      ports,
    })

    expect(ready.kind).toBe('ready')
    if (ready.kind !== 'ready') return
    expect(ports.search).not.toHaveBeenCalled()
    expect(ports.explore).toHaveBeenCalledTimes(1)
    expect(ports.explore).toHaveBeenCalledWith('x-status:2')
    expect(ready.themeId).toBe('mixed')
    expect(ready.composerMaterial.selectedItems.map(item => item.itemId)).toEqual([
      'item:x-status:2',
      'item:x-status:1',
    ])
  })

  it.each([
    ['search', plan({ kind: 'search', topicId: 'topic-a' }), 'search unavailable'],
    ['explore', plan({ kind: 'explore', candidateId: 'x-status:1' }), 'exploration unavailable'],
  ] as const)('turns %s failure into bounded failed material without retry', async (kind, planner, summary) => {
    const ports = basePorts({
      plan: () => planner,
      search: () => { throw new Error('raw search stack and secrets') },
      explore: () => { throw new Error('raw explore stack and secrets') },
    })
    const ready = await generateXDigest({ candidates: [candidate], allowedThemes: ['theme-a'], allowedTopics: ['topic-a'], allowlistedExploreIds: ['x-status:1'], ports })
    expect(ready.kind).toBe('ready')
    if (ready.kind !== 'ready') return
    expect(ready.composerMaterial.exploration).toMatchObject({ kind, status: 'failed', summary })
    expect(JSON.stringify(ready.composerMaterial)).not.toContain('raw search stack and secrets')
    expect(JSON.stringify(ready.composerMaterial)).not.toContain('raw explore stack and secrets')
    expect(kind === 'search' ? ports.search : ports.explore).toHaveBeenCalledTimes(1)
    expect(kind === 'search' ? ports.explore : ports.search).not.toHaveBeenCalled()
  })

  it('fails closed on a second finalize without a second prepare call', async () => {
    const ports = basePorts()
    const ready = await generateXDigest({ candidates: [candidate], allowedThemes: ['theme-a'], allowedTopics: [], allowlistedExploreIds: [], ports })
    if (ready.kind !== 'ready') throw new Error('expected ready')
    const dto = { title: '本轮洞察', sections: [{ kind: 'source' as const, items: [{ itemId: 'item:x-status:1', summary: '来源' }] }] }
    await ready.finalize(dto)
    await expect(ready.finalize(dto)).rejects.toMatchObject({ code: 'invalid-plan', message: 'finalize already consumed' })
    expect(ports.prepareDelivery).toHaveBeenCalledTimes(1)
  })

  it('registers successful search atomically and leaves explore unused', async () => {
    const ports = basePorts({
      plan: () => plan({ kind: 'search', topicId: 'topic-a' }),
      search: () => ({ items: [secondCandidate], summary: '搜索完成' }),
    })
    const ready = await generateXDigest({ candidates: [candidate], allowedThemes: ['theme-a'], allowedTopics: ['topic-a'], allowlistedExploreIds: [], ports })
    expect(ready.kind).toBe('ready')
    if (ready.kind !== 'ready') return
    expect(ready.composerMaterial.exploration).toEqual({ kind: 'search', topicId: 'topic-a', status: 'success', summary: '搜索完成' })
    expect(ports.search).toHaveBeenCalledTimes(1)
    expect(ports.explore).not.toHaveBeenCalled()
  })

  it('registers successful explore and passes only the normalized current item to facts', async () => {
    const ports = basePorts({
      plan: () => plan({ kind: 'explore', candidateId: 'x-status:1' }),
      explore: () => ({ content: '扩展后的正文', topics: ['new-topic'], summary: '探索完成' }),
    })
    const ready = await generateXDigest({ candidates: [candidate, secondCandidate], allowedThemes: ['theme-a'], allowedTopics: [], allowlistedExploreIds: ['x-status:1'], ports })
    expect(ready.kind).toBe('ready')
    if (ready.kind !== 'ready') return
    expect(ready.composerMaterial.exploration).toEqual({ kind: 'explore', candidateId: 'x-status:1', status: 'success', summary: '探索完成' })
    expect(ports.explore).toHaveBeenCalledTimes(1)
    expect(ports.search).not.toHaveBeenCalled()
    expect(ports.projectFacts).toHaveBeenCalledTimes(1)
    expect(ports.projectFacts).toHaveBeenCalledWith({ id: 'x-status:1', source: candidate.source, content: '扩展后的正文', topics: ['new-topic'] })
  })

  it('rejects a plan selecting outside the current run before exploration, facts, or preparation', async () => {
    const ports = basePorts({ plan: () => ({ ...plan({ kind: 'none' }), selectedCandidateIds: ['outside'] }) })
    await expect(generateXDigest({ candidates: [candidate], allowedThemes: ['theme-a'], allowedTopics: [], allowlistedExploreIds: [], ports })).rejects.toMatchObject({ code: 'invalid-plan' })
    expect(ports.explore).not.toHaveBeenCalled()
    expect(ports.projectFacts).not.toHaveBeenCalled()
    expect(ports.prepareDelivery).not.toHaveBeenCalled()
  })

  it('fails closed for URL or Markdown in candidate, exploration, and facts', async () => {
    const badCandidate = { ...candidate, content: '[leak](https://secret.example)' }
    await expect(generateXDigest({ candidates: [badCandidate], allowedThemes: ['theme-a'], allowedTopics: [], allowlistedExploreIds: [], ports: basePorts() })).rejects.toMatchObject({ code: 'invalid-input' })

    const explorationPorts = basePorts({
      plan: () => plan({ kind: 'search', topicId: 'topic-a' }),
      search: () => ({ items: [], summary: '[raw](https://secret.example)' }),
    })
    const explored = await generateXDigest({ candidates: [candidate], allowedThemes: ['theme-a'], allowedTopics: ['topic-a'], allowlistedExploreIds: [], ports: explorationPorts })
    expect(explored.kind).toBe('ready')
    if (explored.kind === 'ready') expect(explored.composerMaterial.exploration).toMatchObject({ status: 'failed' })

    const factPorts = basePorts({ projectFacts: () => ({ facts: [{ targetId: 'item:x-status:1', summary: '[raw](https://secret.example)' }], audit: { policyId: 'x-cron-exact-target', policyVersion: '1', matchedLocatorCount: 1 } }) })
    await expect(generateXDigest({ candidates: [candidate], allowedThemes: ['theme-a'], allowedTopics: [], allowlistedExploreIds: [], ports: factPorts })).rejects.toMatchObject({ code: 'projection-failed' })
  })

  it('rejects invalid composer DTO and formal prepare failure without delivery', async () => {
    const invalidPorts = basePorts()
    const invalidReady = await generateXDigest({ candidates: [candidate], allowedThemes: ['theme-a'], allowedTopics: [], allowlistedExploreIds: [], ports: invalidPorts })
    if (invalidReady.kind !== 'ready') throw new Error('expected ready')
    await expect(invalidReady.finalize({ title: 'invalid', sections: [] })).rejects.toMatchObject({ code: 'invalid-plan' })
    expect(invalidPorts.prepareDelivery).not.toHaveBeenCalled()

    const failedPorts = basePorts({ prepareDelivery: () => ({ ok: false, reason: 'not delivered' }) })
    const failedReady = await generateXDigest({ candidates: [candidate], allowedThemes: ['theme-a'], allowedTopics: [], allowlistedExploreIds: [], ports: failedPorts })
    if (failedReady.kind !== 'ready') throw new Error('expected ready')
    await expect(failedReady.finalize({ title: '本轮洞察', sections: [{ kind: 'source' as const, items: [{ itemId: 'item:x-status:1', summary: '来源' }] }] })).rejects.toMatchObject({ code: 'invalid-plan' })
    expect(failedPorts.prepareDelivery).toHaveBeenCalledTimes(1)
  })

  it('fails closed when aggregate projected facts exceed the composer bound', async () => {
    const ports = basePorts({
      projectFacts: () => ({
        facts: Array.from({ length: 21 }, (_, index) => ({ targetId: 'item:x-status:1', summary: `事实${index}` })),
        audit: { policyId: 'x-cron-exact-target', policyVersion: '1', matchedLocatorCount: 21 },
      }),
    })
    await expect(generateXDigest({ candidates: [candidate], allowedThemes: ['theme-a'], allowedTopics: [], allowlistedExploreIds: [], ports })).rejects.toMatchObject({ code: 'projection-failed' })
    expect(ports.prepareDelivery).not.toHaveBeenCalled()
  })
})
