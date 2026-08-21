import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createFileProjectionSources } from '../src/fact-projection/file-projection-sources.ts'
import {
  FileNavigationSnapshotStore,
  TRUSTED_FACT_NAVIGATION_FILE_NAME,
} from '../src/navigation/file-navigation-snapshot-store.ts'
import { createTrustedFact } from '../src/trusted-facts/model.ts'
import { FileTrustedFactRepository } from '../src/x-feedback/trusted-fact-repository.ts'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'dsh-x-feed-fact-projection-'))
  directories.push(path)
  return path
}

function emptyRevision(): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(Buffer.alloc(0)).digest('hex')}`
}

describe('TODO5-S4 read-only file projection adapters', () => {
  it('reads only trusted facts and the navigation snapshot, pins each reader once, and exposes no writer', async () => {
    const directory = await temporaryDirectory()
    const sources = createFileProjectionSources(directory)
    const before = await readdir(directory)

    expect(Object.keys(sources).sort()).toEqual(['facts', 'navigation'])
    expect(Object.keys(sources.facts)).toEqual([])
    expect(Object.keys(sources.navigation)).toEqual([])
    expect(sources.facts).not.toHaveProperty('readAll')
    expect(sources.facts).not.toHaveProperty('append')
    expect(sources.navigation).not.toHaveProperty('replace')
    expect(await readdir(directory)).toEqual(before)
  })

  it('accepts an explicit empty navigation snapshot matching the empty facts source', async () => {
    const directory = await temporaryDirectory()
    const sources = createFileProjectionSources(directory)
    const facts = sources.facts.readLocatedSnapshot()
    new FileNavigationSnapshotStore(directory).replace({
      schemaVersion: 1,
      sourceRevision: facts.sourceRevision,
      items: [],
    })

    const navigation = sources.navigation.readNavigationSnapshot()
    expect(navigation).toEqual({
      schemaVersion: 1,
      sourceRevision: emptyRevision(),
      items: [],
    })
    expect(Object.isFrozen(facts)).toBe(true)
    expect(Object.isFrozen(facts.facts)).toBe(true)
    expect(Object.isFrozen(navigation)).toBe(true)
    expect(Object.isFrozen(navigation.items)).toBe(true)
  })

  it('reads the trusted-fact snapshot and keeps navigation as a separate neutral file', async () => {
    const directory = await temporaryDirectory()
    const factResult = createTrustedFact({
      target: {
        id: 'target-1',
        content: 'target content',
        source: 'https://example.test/target-1',
        scope: 'this post',
      },
      dimension: 'content_value',
      reason: 'explicit reason',
      evidence: { kind: 'user_direct', rawUserExpression: 'remember this' },
    })
    if (!factResult.ok) throw new Error(factResult.message)
    const repository = new FileTrustedFactRepository(directory)
    expect(repository.append(factResult.fact)).toMatchObject({ ok: true })

    const firstSources = createFileProjectionSources(directory)
    const facts = firstSources.facts.readLocatedSnapshot()
    const located = facts.facts[0]
    expect(located).toBeDefined()
    if (located === undefined) return
    new FileNavigationSnapshotStore(directory).replace({
      schemaVersion: 1,
      sourceRevision: facts.sourceRevision,
      items: [{
        schemaVersion: 1,
        kind: 'trusted-fact-navigation',
        origin: 'machine-derived',
        derivation: { method: 'test', version: '1' },
        locator: located.locator,
        hints: {
          topics: ['topic'],
          targetRefs: [{ targetId: located.fact.target.id, canonicalSource: located.fact.target.source }],
          dimension: located.fact.dimension,
          relations: [{ kind: 'about-target', targetId: located.fact.target.id }],
        },
      }],
    })

    const sources = createFileProjectionSources(directory)
    expect(sources.facts.readLocatedSnapshot().facts).toHaveLength(1)
    expect(sources.navigation.readNavigationSnapshot().items).toHaveLength(1)
    expect(sources.navigation.readNavigationSnapshot().items[0]?.locator.locatorId)
      .toBe(located.locator.locatorId)
    expect(JSON.stringify(sources.navigation.readNavigationSnapshot()))
      .not.toContain('explicit reason')
  })

  it('fails with ENOENT for a missing navigation file without creating it', async () => {
    const directory = await temporaryDirectory()
    const sources = createFileProjectionSources(directory)

    expect(() => sources.navigation.readNavigationSnapshot()).toThrowError(/ENOENT|no such file/i)
    expect(existsSync(join(directory, TRUSTED_FACT_NAVIGATION_FILE_NAME))).toBe(false)
  })

  it.each([
    ['invalid JSON', '{'],
    ['extra root field', JSON.stringify({ schemaVersion: 1, sourceRevision: 'sha256:x', items: [], extra: true })],
    ['extra item field', JSON.stringify({
      schemaVersion: 1,
      sourceRevision: 'sha256:x',
      items: [{ schemaVersion: 1, kind: 'trusted-fact-navigation', origin: 'machine-derived', extra: true }],
    })],
    ['invalid schema version', JSON.stringify({ schemaVersion: 2, sourceRevision: 'sha256:x', items: [] })],
  ])('rejects %s and never falls back to an old snapshot', async (_label, content) => {
    const directory = await temporaryDirectory()
    await writeFile(join(directory, TRUSTED_FACT_NAVIGATION_FILE_NAME), content)
    const sources = createFileProjectionSources(directory)

    expect(() => sources.navigation.readNavigationSnapshot()).toThrow()
    expect(await readFile(join(directory, TRUSTED_FACT_NAVIGATION_FILE_NAME), 'utf8')).toBe(content)
  })

  it('pins the first file snapshots so later disk changes cannot alter this run', async () => {
    const directory = await temporaryDirectory()
    const sources = createFileProjectionSources(directory)
    const firstFacts = sources.facts.readLocatedSnapshot()
    new FileNavigationSnapshotStore(directory).replace({
      schemaVersion: 1,
      sourceRevision: firstFacts.sourceRevision,
      items: [],
    })
    const firstNavigation = sources.navigation.readNavigationSnapshot()
    const firstFile = await readFile(join(directory, TRUSTED_FACT_NAVIGATION_FILE_NAME))

    new FileNavigationSnapshotStore(directory).replace({
      schemaVersion: 1,
      sourceRevision: 'sha256:changed' as `sha256:${string}`,
      items: [],
    })
    expect(sources.facts.readLocatedSnapshot()).toBe(firstFacts)
    expect(sources.navigation.readNavigationSnapshot()).toBe(firstNavigation)
    expect(await readFile(join(directory, TRUSTED_FACT_NAVIGATION_FILE_NAME))).not.toEqual(firstFile)
  })

  it('ignores legacy feedback, preference, graph, and raw-history files', async () => {
    const directory = await temporaryDirectory()
    for (const name of ['feedback.jsonl', 'preferences.json', 'graph.json', 'raw-history.json']) {
      await writeFile(join(directory, name), '{ definitely not a trusted snapshot')
    }
    const sources = createFileProjectionSources(directory)
    const facts = sources.facts.readLocatedSnapshot()
    new FileNavigationSnapshotStore(directory).replace({
      schemaVersion: 1,
      sourceRevision: facts.sourceRevision,
      items: [],
    })

    expect(sources.facts.readLocatedSnapshot()).toBe(facts)
    expect(sources.navigation.readNavigationSnapshot().items).toEqual([])
    expect(await readdir(directory)).toEqual([
      'feedback.jsonl',
      'graph.json',
      'preferences.json',
      'raw-history.json',
      TRUSTED_FACT_NAVIGATION_FILE_NAME,
    ])
  })
})
