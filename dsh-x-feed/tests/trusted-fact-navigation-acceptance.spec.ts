import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  apply,
  createTrustedFactNavigation,
} from '../src/index.ts'
import {
  createTrustedFact,
  isTrustedFact,
  type ApplicationLevel,
  type FactEvidenceInput,
  type TrustedFact,
} from '../src/trusted-facts/index.ts'
import { FileTrustedFactSource } from '../src/trusted-facts/source-adapter.ts'
import { FileTrustedFactRepository } from '../src/x-feedback/trusted-fact-repository.ts'
import { TRUSTED_FACT_NAVIGATION_FILE_NAME } from '../src/navigation/file-navigation-snapshot-store.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'dsh-x-feed-navigation-acceptance-'))
  temporaryDirectories.push(path)
  return path
}

function factFor(index: number, applicationLevel: ApplicationLevel, scope: string, reason: string): TrustedFact {
  const evidence: FactEvidenceInput = applicationLevel === 'observation'
    ? { kind: 'user_direct', rawUserExpression: `我明确记录第 ${index} 条。` }
    : {
        kind: 'user_confirmed_candidate',
        rawUserExpression: `我确认第 ${index} 条。`,
        candidate: reason,
        confirmation: `确认按第 ${index} 条处理。`,
        explicitApplicationLevel: applicationLevel,
      }
  const result = createTrustedFact({
    target: {
      id: `ai-governance-${index}`,
      content: `AI 监管主题内容 ${index}`,
      source: `https://example.test/ai-governance/${index}`,
      scope,
    },
    dimension: index % 2 === 0 ? 'argument_quality' : 'content_value',
    reason,
    applicationLevel,
    evidence,
  })
  if (!result.ok) throw new Error(result.message)
  return result.fact
}

function fiveFacts(): TrustedFact[] {
  return [
    factFor(1, 'observation', 'this post', '事实有明确的监管例子。'),
    factFor(2, 'reusable_rule', 'this topic', '论证必须给出监管边界。'),
    factFor(3, 'hard_exclusion', 'all matching posts', '不能把监管结论写成无证据断言。'),
    factFor(4, 'reusable_rule', 'future discussions', '监管讨论应区分事实和推测。'),
    factFor(5, 'observation', 'this author', '这一条补充监管语境。'),
  ]
}

const derivation = { method: 'exact-topic', version: '1' } as const

function topicDeriver(topic: string) {
  return {
    derive: (locatedFact: { fact: TrustedFact }) => ({
      topics: topic === '' ? [] : [topic],
      relations: [{ kind: 'about-target' as const, targetId: locatedFact.fact.target.id }],
    }),
  }
}

async function rebuild(directory: string, topic = 'AI 监管') {
  return createTrustedFactNavigation(directory, topicDeriver(topic), derivation).execute()
}

async function readNavigation(directory: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(directory, TRUSTED_FACT_NAVIGATION_FILE_NAME), 'utf8')) as Record<string, unknown>
}

function allObjectKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(allObjectKeys)
  if (value === null || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([key, child]) => [key, ...allObjectKeys(child)])
}

describe('TODO 4 trusted-fact navigation integration', () => {
  it('startup apply writes a valid navigation snapshot at the current facts revision', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-x-feed-navigation-startup-'))
    const context = {
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      agents: { roots: () => [] },
      on: () => () => {},
      effect: async (callback: () => unknown) => callback(),
    }

    try {
      await apply(context as never, {
        cronJobId: '',
        dataDir: directory,
        pythonBin: '/usr/bin/python3',
        pipelinePath: '/tmp/x-insight-pipeline.py',
        telegramSessionId: 'session-telegram',
        feedbackPendingTtlMs: 600_000,
        feedbackTurnTimeoutMs: 30_000,
      })

      const navigation = await readNavigation(directory)
      const facts = new FileTrustedFactRepository(directory).readLocatedSnapshot()
      expect(navigation).toMatchObject({ schemaVersion: 1, sourceRevision: facts.sourceRevision, items: [] })
      expect(existsSync(join(directory, TRUSTED_FACT_NAVIGATION_FILE_NAME))).toBe(true)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('exports the navigation contract and composes without writing until execute', async () => {
    const directory = await temporaryDirectory()
    const composition = createTrustedFactNavigation(directory, topicDeriver('AI 监管'), derivation)

    expect(existsSync(join(directory, TRUSTED_FACT_NAVIGATION_FILE_NAME))).toBe(false)
    expect(composition).toHaveProperty('execute')

    const repository = new FileTrustedFactRepository(directory)
    expect(repository.append(fiveFacts()[0])).toMatchObject({ ok: true })
    expect(existsSync(join(directory, TRUSTED_FACT_NAVIGATION_FILE_NAME))).toBe(false)

    await composition.execute()
    expect(existsSync(join(directory, TRUSTED_FACT_NAVIGATION_FILE_NAME))).toBe(true)
  })

  it('projects five independent AI governance facts with traceable locators and unchanged facts', async () => {
    const directory = await temporaryDirectory()
    const repository = new FileTrustedFactRepository(directory)
    const facts = fiveFacts()
    for (const fact of facts) expect(repository.append(fact)).toMatchObject({ ok: true })

    const before = repository.readLocatedSnapshot()
    const snapshot = await rebuild(directory)
    const navigation = await readNavigation(directory)

    expect(snapshot.items).toHaveLength(5)
    expect(new Set(snapshot.items.map(item => item.locator.locatorId)).size).toBe(5)
    expect(snapshot.items.map(item => item.locator.persistence.lineNumber)).toEqual([1, 2, 3, 4, 5])
    expect(snapshot.items.every(item => item.hints.topics.includes('AI 监管'))).toBe(true)
    expect(snapshot.sourceRevision).toBe(before.sourceRevision)
    expect(repository.readLocatedSnapshot().facts.map(item => item.fact)).toEqual(facts)
    expect(navigation).toEqual(snapshot)
  })

  it('keeps one navigation item per fact and exposes no attitude or judgment fields', async () => {
    const directory = await temporaryDirectory()
    const repository = new FileTrustedFactRepository(directory)
    for (const fact of fiveFacts()) expect(repository.append(fact)).toMatchObject({ ok: true })

    const snapshot = await rebuild(directory)
    const forbidden = new Set([
      'reason', 'scope', 'applicationLevel', 'evidence', 'rawUserExpression', 'content',
      'rank', 'score', 'allow', 'deny', 'filter', 'exclude', 'deliver', 'sentiment', 'preference',
    ])

    expect(snapshot.items).toHaveLength(5)
    expect(snapshot.items.every(item => !isTrustedFact(item))).toBe(true)
    expect(allObjectKeys(snapshot).filter(key => forbidden.has(key))).toEqual([])
    expect(JSON.stringify(snapshot)).not.toContain('用户喜欢')
    expect(JSON.stringify(snapshot)).not.toContain('用户讨厌')
    expect(snapshot.items.map(item => item.hints.topics)).toEqual(Array.from({ length: 5 }, () => ['AI 监管']))
  })

  it('replaces the snapshot after deleting and modifying facts without stale locators', async () => {
    const directory = await temporaryDirectory()
    const repository = new FileTrustedFactRepository(directory)
    const originalFacts = fiveFacts()
    for (const fact of originalFacts) expect(repository.append(fact)).toMatchObject({ ok: true })
    const original = await rebuild(directory)

    const changedFacts = [originalFacts[0], originalFacts[1], factFor(3, 'hard_exclusion', 'changed scope', '修改后的监管理由。'), originalFacts[4]]
    const serialized = changedFacts.map(fact => JSON.stringify({
      target: fact.target,
      dimension: fact.dimension,
      reason: fact.reason,
      applicationLevel: fact.applicationLevel,
      evidence: fact.evidence,
    })).join('\n') + '\n'
    await writeFile(join(directory, 'trusted-facts.jsonl'), serialized)

    const next = await rebuild(directory)
    const nextJson = JSON.stringify(await readNavigation(directory))

    expect(next.items).toHaveLength(4)
    expect(next.sourceRevision).not.toBe(original.sourceRevision)
    expect(nextJson).not.toContain(original.items[2].locator.locatorId)
    expect(nextJson).not.toContain(original.items[3].locator.locatorId)
    expect(nextJson).not.toContain(original.items[4].locator.locatorId)
    expect(nextJson).not.toContain('this author')
    expect(next.items.map(item => item.locator.persistence.lineNumber)).toEqual([1, 2, 3, 4])
    expect(next.items[2].locator.persistence.canonicalDigest).not.toBe(original.items[2].locator.persistence.canonicalDigest)
  })

  it('keeps navigation hints unable to act as trusted facts or judgment selectors', async () => {
    const directory = await temporaryDirectory()
    const repository = new FileTrustedFactRepository(directory)
    for (const fact of fiveFacts()) expect(repository.append(fact)).toMatchObject({ ok: true })

    const empty = await rebuild(directory, '')
    const correct = await rebuild(directory, 'AI 监管')
    const wrong = await rebuild(directory, '错误主题')
    const fakeRepository = { readAll: () => correct.items as unknown as TrustedFact[] }
    const source = new FileTrustedFactSource(fakeRepository)

    expect(source.query({ targetIds: [correct.items[0].hints.targetRefs[0].targetId] })).toEqual([])
    expect(empty.items.map(item => item.locator.locatorId)).toEqual(correct.items.map(item => item.locator.locatorId))
    expect(correct.items.map(item => item.locator.locatorId)).toEqual(wrong.items.map(item => item.locator.locatorId))
    expect(empty.items.map(item => item.hints.topics)).toEqual(Array.from({ length: 5 }, () => []))
    expect(correct.items.map(item => item.hints.topics)).toEqual(Array.from({ length: 5 }, () => ['AI 监管']))
    expect(wrong.items.map(item => item.hints.topics)).toEqual(Array.from({ length: 5 }, () => ['错误主题']))
  })
})
