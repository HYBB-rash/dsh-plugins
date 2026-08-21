import { describe, expect, it } from 'vitest'
import {
  createCandidateNavigationRecall,
  type CandidateNavigationRecallRequest,
  type CandidateNavigationRecallResult,
} from '../src/x-cron/navigation-recall.ts'
import type {
  NavigationItem,
  NavigationSnapshot,
  Sha256Digest,
} from '../src/trusted-facts/navigation-contract.ts'

const sourceRevision = 'sha256:revision-1' as Sha256Digest

function navigationItem(
  locatorId: string,
  options: {
    readonly targetId?: string
    readonly source?: string
    readonly topic?: string
    readonly dimension?: NavigationItem['hints']['dimension']
  } = {},
): NavigationItem {
  const targetId = options.targetId ?? locatorId
  const source = options.source ?? `https://x.example/${locatorId}`
  return {
    schemaVersion: 1,
    kind: 'trusted-fact-navigation',
    origin: 'machine-derived',
    derivation: { method: 'test', version: '1' },
    locator: {
      schemaVersion: 1,
      locatorId,
      persistence: {
        sourceKind: 'trusted-fact-repository',
        sourceKey: 'trusted-facts.jsonl',
        lineNumber: Number(locatorId.replace('locator:', '')) || 1,
        canonicalDigest: `sha256:digest-${locatorId.slice('locator:'.length)}`,
      },
    },
    hints: {
      topics: [options.topic ?? `topic:${locatorId}`],
      targetRefs: [{ targetId, canonicalSource: source }],
      dimension: options.dimension ?? 'content_value',
      relations: [{ kind: 'about-target', targetId }],
    },
  }
}

function snapshot(items: readonly NavigationItem[]): NavigationSnapshot {
  return { schemaVersion: 1, sourceRevision, items }
}

function request(overrides: Partial<CandidateNavigationRecallRequest> = {}): CandidateNavigationRecallRequest {
  return {
    sourceRevision,
    targetIds: ['target:relevant'],
    canonicalSources: ['https://x.example/relevant'],
    topics: ['topic:relevant'],
    relationKeys: ['about-target:target:relevant'],
    dimensions: ['content_value'],
    ...overrides,
  }
}

function readyResult(items: readonly NavigationItem[]): CandidateNavigationRecallResult {
  const built = createCandidateNavigationRecall(snapshot(items))
  expect(built).toMatchObject({ kind: 'ready' })
  if (built.kind !== 'ready') throw new Error(built.message)
  const result = built.index.recall(request())
  expect(result.kind).toBe('recalled')
  return result
}

describe('CandidateNavigationRecall', () => {
  it('keeps locator closure and recalled JSON invariant under irrelevant 2 -> 200 -> 10k navigation growth', () => {
    const related = [
      navigationItem('locator:1', {
        targetId: 'target:relevant',
        source: 'https://x.example/relevant',
        topic: 'topic:relevant',
      }),
      navigationItem('locator:2', {
        targetId: 'target:other',
        source: 'https://x.example/other',
        topic: 'topic:other',
      }),
    ]
    const two = readyResult(related)
    const twoHundred = readyResult([
      ...related,
      ...Array.from({ length: 198 }, (_, index) => navigationItem(`locator:${index + 3}`)),
    ])
    const tenThousand = readyResult([
      ...related,
      ...Array.from({ length: 9_998 }, (_, index) => navigationItem(`locator:${index + 3}`)),
    ])

    expect(two).toEqual(twoHundred)
    expect(twoHundred).toEqual(tenThousand)
    expect(JSON.stringify(two)).toBe(JSON.stringify(twoHundred))
  })

  it('grows only when a new navigation item shares an exact neutral key', () => {
    const original = [navigationItem('locator:1', {
      targetId: 'target:relevant',
      source: 'https://x.example/relevant',
      topic: 'topic:relevant',
    })]
    const grown = [
      ...original,
      navigationItem('locator:2', {
        targetId: 'target:unrelated',
        source: 'https://x.example/unrelated',
        topic: 'topic:relevant',
      }),
      navigationItem('locator:3'),
    ]

    expect(readyResult(original)).toMatchObject({ locatorIds: ['locator:1'] })
    expect(readyResult(grown)).toMatchObject({ locatorIds: ['locator:1', 'locator:2'] })
  })

  it.each([
    ['no explicit key', { targetIds: [], canonicalSources: [], topics: [], relationKeys: [], dimensions: [] }],
    ['dimension only', { targetIds: [], canonicalSources: [], topics: [], relationKeys: [], dimensions: ['content_value'] }],
    ['free-text relation', { relationKeys: ['about AI regulation'] }],
    ['noncanonical target', { targetIds: [' target:relevant '] }],
  ] as const)('fails closed for %s', (_label, overrides) => {
    const built = createCandidateNavigationRecall(snapshot([navigationItem('locator:1')]))
    expect(built.kind).toBe('ready')
    if (built.kind !== 'ready') return

    const result = built.index.recall(request(overrides))
    expect(result.kind).toBe('recall-failure')
    expect(result).toMatchObject({
      code: _label === 'no explicit key' || _label === 'dimension only'
        ? 'needs-explicit-recall-key'
        : 'invalid-candidate-recall-key',
    })
  })

  it('treats a valid key with zero hits as an empty recall, never as full navigation', () => {
    const built = createCandidateNavigationRecall(snapshot([
      navigationItem('locator:1'),
      navigationItem('locator:2'),
    ]))
    expect(built.kind).toBe('ready')
    if (built.kind !== 'ready') return

    const result = built.index.recall(request({
      targetIds: ['target:missing'],
      canonicalSources: [],
      topics: [],
      relationKeys: [],
      dimensions: [],
    }))
    expect(result).toMatchObject({ kind: 'recalled', locatorIds: [], navigation: [] })
  })

  it('rejects duplicate locators, invalid index snapshots, and revision mismatches', () => {
    const duplicate = createCandidateNavigationRecall(snapshot([
      navigationItem('locator:1'),
      navigationItem('locator:1'),
    ]))
    expect(duplicate).toMatchObject({ kind: 'recall-failure', code: 'navigation-recall-index-invalid' })

    const invalid = createCandidateNavigationRecall({
      schemaVersion: 1,
      sourceRevision,
      items: [{ bad: true }],
    })
    expect(invalid).toMatchObject({ kind: 'recall-failure', code: 'navigation-recall-index-invalid' })

    const built = createCandidateNavigationRecall(snapshot([navigationItem('locator:1', {
      targetId: 'target:relevant',
      source: 'https://x.example/relevant',
      topic: 'topic:relevant',
    })]))
    expect(built.kind).toBe('ready')
    if (built.kind !== 'ready') return
    expect(built.index.recall(request({ sourceRevision: 'sha256:other-revision' }))).toMatchObject({
      kind: 'recall-failure',
      code: 'navigation-recall-revision-mismatch',
    })
  })

  it('pins input and output: caller mutation cannot change the index or result', () => {
    const items = [navigationItem('locator:1', {
      targetId: 'target:relevant',
      source: 'https://x.example/relevant',
      topic: 'topic:relevant',
    })]
    const source = snapshot(items)
    const built = createCandidateNavigationRecall(source)
    expect(built.kind).toBe('ready')
    if (built.kind !== 'ready') return

    const input = request()
    const first = built.index.recall(input)
    input.targetIds[0] = 'target:changed'
    items[0]!.hints.topics[0] = 'topic:changed'
    const second = built.index.recall(request())

    expect(second).toEqual(first)
    expect(second).not.toHaveProperty('navigation[0].fact')
    expect(Object.isFrozen(second)).toBe(true)
    if (second.kind === 'recalled') {
      expect(Object.isFrozen(second.navigation)).toBe(true)
      expect(Object.isFrozen(second.navigation[0])).toBe(true)
    }
  })
})
