import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createTrustedFact, isTrustedFact, type TrustedFact } from '../src/trusted-facts/model.ts'
import {
  FileTrustedFactSource,
  type AutomaticJudgmentFactQuery,
} from '../src/trusted-facts/source-adapter.ts'
import { FileTrustedFactRepository } from '../src/x-feedback/trusted-fact-repository.ts'

const targetOne = {
  id: 'x:one',
  content: '一条有具体例子的内容',
  source: 'https://x.com/alice/status/1',
  scope: 'this post',
} as const

const targetTwo = {
  id: 'x:two',
  content: '一条关于论证的内容',
  source: 'https://x.com/bob/status/2',
  scope: 'this post',
} as const

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'dsh-x-feed-fact-source-'))
  directories.push(path)
  return path
}

function factFor(
  target: { readonly id: string; readonly content: string; readonly source: string; readonly scope: string },
  overrides: Record<string, unknown> = {},
): TrustedFact {
  const result = createTrustedFact({
    target,
    dimension: 'content_value',
    reason: '有具体证据。',
    evidence: { kind: 'user_direct', rawUserExpression: '我明确说出的理由。' },
    ...overrides,
  })
  if (!result.ok) throw new Error(result.message)
  return result.fact
}

async function writeLegacyFixtures(directory: string): Promise<Map<string, string>> {
  const files = new Map<string, string>([
    ['legacy-x-preferences.md', '旧偏好 marker：不要读取。\n'],
    ['feedback.jsonl', '{"operation":"dislike","note":"旧评价 marker"}\n'],
    ['x_interest_graph.json', '{"anchors":["旧兴趣 marker"],"restricted":["旧禁区 marker"]}\n'],
    ['session-summary.jsonl', '{"summary":"旧 session marker"}\n'],
  ])
  for (const [name, content] of files) await writeFile(join(directory, name), content)
  return new Map(await Promise.all([...files.keys()].map(async name => [name, await fileHash(join(directory, name))] as const)))
}

async function fileHash(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

async function sourceWithFacts(facts: readonly TrustedFact[]): Promise<{
  readonly source: FileTrustedFactSource
  readonly directory: string
}> {
  const directory = await temporaryDirectory()
  const repository = new FileTrustedFactRepository(directory)
  for (const fact of facts) expect(repository.append(fact)).toMatchObject({ ok: true })
  return { source: new FileTrustedFactSource(repository), directory }
}

describe('FileTrustedFactSource', () => {
  it('returns facts for exact target ids and preserves all fact fields', async () => {
    const fact = factFor(targetOne, {
      dimension: 'argument_quality',
      reason: '论证结构清楚。',
      applicationLevel: 'reusable_rule',
      evidence: {
        kind: 'user_confirmed_candidate',
        rawUserExpression: '我确认这个理由。',
        candidate: '论证结构清楚。',
        confirmation: '对，以后按这个理由复用。',
        explicitApplicationLevel: 'reusable_rule',
      },
    })
    const { source } = await sourceWithFacts([fact])

    const result = source.query({ targetIds: [targetOne.id] })

    expect(result).toEqual([fact])
    expect(result[0]).toMatchObject({
      target: targetOne,
      dimension: 'argument_quality',
      reason: '论证结构清楚。',
      applicationLevel: 'reusable_rule',
      evidence: fact.evidence,
    })
  })

  it('returns facts for exact canonical sources only', async () => {
    const fact = factFor(targetTwo)
    const { source } = await sourceWithFacts([fact])

    expect(source.query({ canonicalSources: [targetTwo.source] })).toEqual([fact])
    expect(source.query({ targetIds: [targetTwo.source] })).toEqual([])
    expect(source.query({ canonicalSources: [targetTwo.id] })).toEqual([])
    expect(source.query({ canonicalSources: ['https://twitter.com/bob/status/2'] })).toEqual([])
    expect(source.query({ canonicalSources: ['https://x.com/bob/status/2?utm_source=old'] })).toEqual([])
  })

  it('unites exact id and source matches once without sorting or inferring', async () => {
    const first = factFor(targetOne)
    const second = factFor(targetTwo, { reason: '论证有边界。' })
    const { source } = await sourceWithFacts([first, second])

    const query: AutomaticJudgmentFactQuery = {
      targetIds: [targetOne.id, 'x:missing'],
      canonicalSources: [targetOne.source, targetTwo.source],
    }

    expect(source.query(query)).toEqual([first, second])
  })

  it('returns an empty result for an absent or empty query', async () => {
    const { source } = await sourceWithFacts([factFor(targetOne)])

    expect(source.query({})).toEqual([])
    expect(source.query({ targetIds: [] })).toEqual([])
    expect(source.query({ canonicalSources: [] })).toEqual([])
    expect(source.query({ targetIds: ['  '] })).toEqual([])
    expect(source.query({ canonicalSources: ['  '] })).toEqual([])
  })

  it('does not read the repository when no selector contains a non-whitespace value', () => {
    const readAll = () => {
      throw new Error('readAll must not run for an empty query')
    }
    const source = new FileTrustedFactSource({ readAll })

    expect(source.query({ targetIds: ['  '], canonicalSources: ['\t'] })).toEqual([])
  })

  it('does not match approximately by url, topic, author, content, or reason', async () => {
    const fact = factFor(targetOne, { reason: '原始理由 marker。' })
    const { source } = await sourceWithFacts([fact])

    expect(source.query({ targetIds: ['x:one-copy'] })).toEqual([])
    expect(source.query({ canonicalSources: ['https://x.com/alice/status/10'] })).toEqual([])
    expect(source.query({ canonicalSources: ['https://x.com/alice/status/1/replies'] })).toEqual([])
    expect(source.query({ canonicalSources: ['alice'] })).toEqual([])
  })

  it('does not trust a forged repository result', async () => {
    const forged = { ...factFor(targetOne) }
    const repository = {
      readAll: () => [forged] as TrustedFact[],
    }
    const source = new FileTrustedFactSource(repository)

    expect(isTrustedFact(forged)).toBe(false)
    expect(source.query({ targetIds: [targetOne.id] })).toEqual([])
  })

  it('does not expose candidate rows accepted by no repository gate', async () => {
    const directory = await temporaryDirectory()
    const repository = new FileTrustedFactRepository(directory)
    const candidate = {
      target: targetOne,
      dimension: 'content_value',
      reason: '模型猜测。',
      applicationLevel: 'observation',
      evidence: { kind: 'candidate', rawUserExpression: '不喜欢。', candidate: '模型猜测。' },
    }

    expect(repository.append(candidate as TrustedFact)).toMatchObject({ ok: false, code: 'invalid_fact' })
    expect(new FileTrustedFactSource(repository).query({ targetIds: [targetOne.id] })).toEqual([])
  })

  it('does not read or mutate legacy, feedback, graph, session, or trusted files', async () => {
    const directory = await temporaryDirectory()
    const legacyHashes = await writeLegacyFixtures(directory)
    const fact = factFor(targetOne)
    const repository = new FileTrustedFactRepository(directory)
    expect(repository.append(fact)).toMatchObject({ ok: true })
    const trustedPath = join(directory, 'trusted-facts.jsonl')
    const trustedBefore = await readFile(trustedPath, 'utf8')

    const source = new FileTrustedFactSource(repository)
    expect(source.query({ targetIds: [targetOne.id] })).toEqual([fact])
    expect(source.query({ canonicalSources: [targetOne.source] })).toEqual([fact])

    for (const [name, hash] of legacyHashes) expect(await fileHash(join(directory, name))).toBe(hash)
    await expect(readFile(trustedPath, 'utf8')).resolves.toBe(trustedBefore)
  })
})
