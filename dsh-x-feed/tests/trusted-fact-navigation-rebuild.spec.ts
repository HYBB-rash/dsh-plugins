import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTrustedFact, type TrustedFact } from '../src/trusted-facts/model.ts'
import type {
  LocatedTrustedFact,
  LocatedTrustedFactSnapshot,
  NavigationItem,
  NavigationSnapshot,
  Sha256Digest,
} from '../src/trusted-facts/navigation-contract.ts'
import { RebuildTrustedFactNavigation } from '../src/trusted-facts/rebuild-navigation.ts'
import {
  FileNavigationSnapshotStore,
  TRUSTED_FACT_NAVIGATION_FILE_NAME,
} from '../src/navigation/file-navigation-snapshot-store.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'dsh-x-feed-navigation-rebuild-'))
  temporaryDirectories.push(path)
  return path
}

function factAt(index: number): TrustedFact {
  const result = createTrustedFact({
    target: {
      id: `post-${index}`,
      content: `Post ${index}`,
      source: `https://example.com/post-${index}`,
      scope: 'x',
    },
    dimension: 'content_value',
    reason: `Reason ${index}`,
    evidence: { kind: 'user_direct', rawUserExpression: `Remember ${index}` },
  })
  if (!result.ok) throw new Error(result.message)
  return result.fact
}

function locatedFact(index: number): LocatedTrustedFact {
  const canonicalDigest = `sha256:${index.toString().padStart(64, '0')}` as Sha256Digest
  return {
    locator: {
      schemaVersion: 1,
      locatorId: `tf-jsonl-v0:${index}:${canonicalDigest}`,
      persistence: {
        sourceKind: 'trusted-fact-repository',
        sourceKey: 'trusted-facts.jsonl',
        lineNumber: index,
        canonicalDigest,
      },
    },
    fact: factAt(index),
  }
}

function navigationItem(located: LocatedTrustedFact, marker: string): NavigationItem {
  return {
    schemaVersion: 1,
    kind: 'trusted-fact-navigation',
    origin: 'machine-derived',
    derivation: { method: 'test', version: '1' },
    locator: located.locator,
    hints: {
      topics: [marker],
      targetRefs: [{ targetId: located.fact.target.id, canonicalSource: located.fact.target.source }],
      dimension: located.fact.dimension,
      relations: [{ kind: 'about-target', targetId: located.fact.target.id }],
    },
  }
}

function locatedSnapshot(facts: readonly LocatedTrustedFact[]): LocatedTrustedFactSnapshot {
  return { sourceRevision: 'sha256:source' as Sha256Digest, facts }
}

function snapshotWithMarker(marker: string): NavigationSnapshot {
  const located = locatedFact(1)
  return {
    schemaVersion: 1,
    sourceRevision: `sha256:${createHash('sha256').update(marker).digest('hex')}` as Sha256Digest,
    items: [navigationItem(located, marker)],
  }
}

describe('RebuildTrustedFactNavigation', () => {
  it('writes a legal empty snapshot and preserves the source revision', () => {
    const input = locatedSnapshot([])
    const reader = { readLocatedSnapshot: vi.fn(() => input) }
    const projector = { project: vi.fn() }
    const writer = { replace: vi.fn() }

    const result = new RebuildTrustedFactNavigation(reader, projector, writer).execute()

    expect(result).toEqual({ schemaVersion: 1, sourceRevision: input.sourceRevision, items: [] })
    expect(reader.readLocatedSnapshot).toHaveBeenCalledTimes(1)
    expect(projector.project).not.toHaveBeenCalled()
    expect(writer.replace).toHaveBeenCalledTimes(1)
    expect(writer.replace).toHaveBeenCalledWith(result)
  })

  it('projects each located fact once, preserving order, and replaces once', () => {
    const facts = [locatedFact(1), locatedFact(2), locatedFact(3)]
    const input = locatedSnapshot(facts)
    const reader = { readLocatedSnapshot: vi.fn(() => input) }
    const project = vi.fn((located: LocatedTrustedFact) => navigationItem(located, located.fact.target.id))
    const writer = { replace: vi.fn() }

    const result = new RebuildTrustedFactNavigation(reader, { project }, writer).execute()

    expect(project).toHaveBeenCalledTimes(3)
    expect(project.mock.calls.map(([located]) => located.locator.locatorId)).toEqual(
      facts.map(located => located.locator.locatorId),
    )
    expect(result.items.map(item => item.hints.topics[0])).toEqual(['post-1', 'post-2', 'post-3'])
    expect(writer.replace).toHaveBeenCalledTimes(1)
    expect(writer.replace).toHaveBeenCalledWith(result)
  })
})

describe('FileNavigationSnapshotStore', () => {
  it('replaces the complete snapshot instead of merging old items', async () => {
    const directory = await temporaryDirectory()
    const store = new FileNavigationSnapshotStore(directory)

    store.replace(snapshotWithMarker('old-marker'))
    store.replace(snapshotWithMarker('new-marker'))

    const content = await readFile(join(directory, TRUSTED_FACT_NAVIGATION_FILE_NAME), 'utf8')
    expect(content).toContain('new-marker')
    expect(content).not.toContain('old-marker')
    expect(JSON.parse(content).items).toHaveLength(1)
  })

  it('writes a complete 0600 target with no temporary residue', async () => {
    const directory = await temporaryDirectory()
    const store = new FileNavigationSnapshotStore(directory)
    const snapshot = snapshotWithMarker('complete-marker')

    store.replace(snapshot)

    const target = join(directory, TRUSTED_FACT_NAVIGATION_FILE_NAME)
    expect(JSON.parse(await readFile(target, 'utf8'))).toEqual(snapshot)
    expect((await stat(target)).mode & 0o777).toBe(0o600)
    expect(await readdir(directory)).toEqual([TRUSTED_FACT_NAVIGATION_FILE_NAME])
  })

  it('does not leave a pseudo-target or temporary file when replacement fails', async () => {
    const directory = await temporaryDirectory()
    await mkdir(join(directory, TRUSTED_FACT_NAVIGATION_FILE_NAME))

    expect(() => new FileNavigationSnapshotStore(directory).replace(snapshotWithMarker('must-not-write'))).toThrow()
    expect((await stat(join(directory, TRUSTED_FACT_NAVIGATION_FILE_NAME))).isDirectory()).toBe(true)
    expect(await readdir(directory)).toEqual([TRUSTED_FACT_NAVIGATION_FILE_NAME])
  })
})
