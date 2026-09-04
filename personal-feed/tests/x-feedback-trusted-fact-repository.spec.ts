import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createTrustedFact, isTrustedFact, type TrustedFact } from '../src/trusted-facts/model.ts'
import { FileTrustedFactRepository } from '../src/x-feedback/trusted-fact-repository.ts'

const target = {
  id: 'x:repo-1',
  content: 'A post with a concrete example',
  source: 'https://x.example/repo-1',
  scope: 'this post',
} as const

const factResult = createTrustedFact({
  target,
  dimension: 'content_value',
  reason: '具体例让内容有价值。',
  evidence: { kind: 'user_direct', rawUserExpression: '我喜欢，因为有具体例子。' },
})

if (!factResult.ok) throw new Error(factResult.message)
const fact = factResult.fact

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'dsh-x-feed-trusted-facts-'))
  directories.push(path)
  return path
}

describe('FileTrustedFactRepository', () => {
  it('returns a source revision for an empty trusted-facts file', async () => {
    const directory = await temporaryDirectory()
    await writeFile(join(directory, 'trusted-facts.jsonl'), '')

    const snapshot = new FileTrustedFactRepository(directory).readLocatedSnapshot()

    expect(snapshot).toEqual({
      sourceRevision: `sha256:${createHash('sha256').update('').digest('hex')}`,
      facts: [],
    })
  })

  it('locates a valid row with its physical line and canonical digest', async () => {
    const directory = await temporaryDirectory()
    const repository = new FileTrustedFactRepository(directory)
    expect(repository.append(fact)).toMatchObject({ ok: true })
    const raw = await readFile(join(directory, 'trusted-facts.jsonl'))
    const persisted = JSON.parse(raw.toString('utf8').trim())
    const canonicalDigest = `sha256:${createHash('sha256').update(JSON.stringify(persisted)).digest('hex')}`

    const snapshot = repository.readLocatedSnapshot()

    expect(snapshot.facts).toHaveLength(1)
    expect(snapshot.facts[0].fact).toEqual(fact)
    expect(snapshot.facts[0].locator).toEqual({
      schemaVersion: 1,
      locatorId: `tf-jsonl-v0:1:${canonicalDigest}`,
      persistence: {
        sourceKind: 'trusted-fact-repository',
        sourceKey: 'trusted-facts.jsonl',
        lineNumber: 1,
        canonicalDigest,
      },
    })
    expect(snapshot.sourceRevision).toBe(`sha256:${createHash('sha256').update(raw).digest('hex')}`)
    expect(snapshot.facts[0].locator.persistence).not.toHaveProperty('sourceRevision')
  })

  it('gives duplicate canonical rows different locators', async () => {
    const directory = await temporaryDirectory()
    const repository = new FileTrustedFactRepository(directory)
    expect(repository.append(fact)).toMatchObject({ ok: true })
    expect(repository.append(fact)).toMatchObject({ ok: true })

    const located = repository.readLocatedSnapshot().facts

    expect(located).toHaveLength(2)
    expect(located[0].locator.persistence.canonicalDigest).toBe(located[1].locator.persistence.canonicalDigest)
    expect(located[0].locator.locatorId).not.toBe(located[1].locator.locatorId)
    expect(located[0].locator.persistence.lineNumber).toBe(1)
    expect(located[1].locator.persistence.lineNumber).toBe(2)
  })

  it('counts empty and invalid physical lines when locating a later valid row', async () => {
    const directory = await temporaryDirectory()
    const repository = new FileTrustedFactRepository(directory)
    const serialized = JSON.stringify({
      target: fact.target,
      dimension: fact.dimension,
      reason: fact.reason,
      applicationLevel: fact.applicationLevel,
      evidence: fact.evidence,
    })
    await writeFile(join(directory, 'trusted-facts.jsonl'), `\n{not-json\n${serialized}\n`)

    const located = repository.readLocatedSnapshot().facts

    expect(located).toHaveLength(1)
    expect(located[0].locator.persistence.lineNumber).toBe(3)
  })

  it('uses canonical field order rather than the persisted key order for the digest', async () => {
    const directory = await temporaryDirectory()
    const repository = new FileTrustedFactRepository(directory)
    const reordered = JSON.stringify({
      evidence: fact.evidence,
      applicationLevel: fact.applicationLevel,
      reason: fact.reason,
      dimension: fact.dimension,
      target: {
        scope: fact.target.scope,
        source: fact.target.source,
        content: fact.target.content,
        id: fact.target.id,
      },
    })
    await writeFile(join(directory, 'trusted-facts.jsonl'), `${reordered}\n`)

    const located = repository.readLocatedSnapshot().facts
    const canonical = JSON.stringify({
      target: fact.target,
      dimension: fact.dimension,
      reason: fact.reason,
      applicationLevel: fact.applicationLevel,
      evidence: fact.evidence,
    })

    expect(located).toHaveLength(1)
    expect(located[0].locator.persistence.canonicalDigest).toBe(
      `sha256:${createHash('sha256').update(canonical).digest('hex')}`,
    )
  })

  it('keeps an existing locator stable when a later row is appended', async () => {
    const directory = await temporaryDirectory()
    const repository = new FileTrustedFactRepository(directory)
    expect(repository.append(fact)).toMatchObject({ ok: true })
    const beforeSnapshot = repository.readLocatedSnapshot()
    const before = beforeSnapshot.facts[0].locator
    expect(repository.append(fact)).toMatchObject({ ok: true })

    const afterSnapshot = repository.readLocatedSnapshot()
    const after = afterSnapshot.facts[0].locator

    expect(after.locatorId).toBe(before.locatorId)
    expect(after.persistence.canonicalDigest).toBe(before.persistence.canonicalDigest)
    expect(after.persistence.lineNumber).toBe(before.persistence.lineNumber)
    expect(beforeSnapshot.sourceRevision).not.toBe(afterSnapshot.sourceRevision)
    expect(after.persistence).not.toHaveProperty('sourceRevision')
  })

  it('durably appends and reconstructs a branded fact', async () => {
    const repository = new FileTrustedFactRepository(await temporaryDirectory())

    expect(repository.append(fact)).toMatchObject({ ok: true })
    const loaded = repository.readAll()

    expect(loaded).toHaveLength(1)
    expect(loaded[0]).toEqual(fact)
    expect(isTrustedFact(loaded[0])).toBe(true)
  })

  it('rejects plain, spread, and forged facts without changing the file', async () => {
    const directory = await temporaryDirectory()
    const repository = new FileTrustedFactRepository(directory)
    expect(repository.append(fact)).toMatchObject({ ok: true })
    const before = await readFile(join(directory, 'trusted-facts.jsonl'), 'utf8')

    const candidates: unknown[] = [
      { ...fact },
      { ...fact, __brand: 'TrustedFact' },
      { target, dimension: 'content_value', reason: '伪造', applicationLevel: 'observation', evidence: fact.evidence },
      { schemaVersion: 1, id: 'legacy', createdAt: new Date(0).toISOString(), operation: 'like', canonicalUrl: target.source, note: '旧模型内容' },
    ]
    for (const candidate of candidates) {
      expect(repository.append(candidate as TrustedFact)).toMatchObject({ ok: false, code: 'invalid_fact' })
    }

    await expect(readFile(join(directory, 'trusted-facts.jsonl'), 'utf8')).resolves.toBe(before)
  })

  it('skips corrupt and unknown rows while warning and retaining valid rows', async () => {
    const directory = await temporaryDirectory()
    const valid = JSON.stringify({
      target,
      dimension: fact.dimension,
      reason: fact.reason,
      applicationLevel: fact.applicationLevel,
      evidence: fact.evidence,
    })
    await writeFile(join(directory, 'trusted-facts.jsonl'), [
      valid,
      '{not-json',
      JSON.stringify({ ...JSON.parse(valid), unknown: true }),
      JSON.stringify({ target, dimension: 'content_value', reason: 'bad', applicationLevel: 'observation', evidence: { kind: 'candidate', rawUserExpression: '模型猜的', candidate: 'bad' } }),
    ].join('\n') + '\n')
    const warnings: string[] = []

    const loaded = new FileTrustedFactRepository(directory).readAll(message => warnings.push(message))

    expect(loaded).toHaveLength(1)
    expect(isTrustedFact(loaded[0])).toBe(true)
    expect(warnings).toHaveLength(3)
  })

  it('does not create locators for corrupt, unknown, or unadmitted candidate rows', async () => {
    const directory = await temporaryDirectory()
    const valid = JSON.stringify({
      target,
      dimension: fact.dimension,
      reason: fact.reason,
      applicationLevel: fact.applicationLevel,
      evidence: fact.evidence,
    })
    const invalid = '{not-json'
    const unknown = JSON.stringify({ ...JSON.parse(valid), unknown: true })
    const candidate = JSON.stringify({
      target,
      dimension: 'content_value',
      reason: 'bad',
      applicationLevel: 'observation',
      evidence: { kind: 'candidate', rawUserExpression: '模型猜的', candidate: 'bad' },
    })
    await writeFile(join(directory, 'trusted-facts.jsonl'), [invalid, unknown, candidate, valid].join('\n') + '\n')
    const warnings: string[] = []

    const snapshot = new FileTrustedFactRepository(directory).readLocatedSnapshot(message => warnings.push(message))

    expect(snapshot.facts).toHaveLength(1)
    expect(snapshot.facts[0].locator.persistence.lineNumber).toBe(4)
    expect(warnings).toEqual([
      `personal-feed: skipping corrupt trusted-facts.jsonl line: ${invalid}`,
      `personal-feed: skipping invalid trusted-facts.jsonl line: ${unknown.slice(0, 120)}`,
      `personal-feed: skipping invalid trusted-facts.jsonl line: ${candidate.slice(0, 120)}`,
    ])
  })


  it('returns a stable failure instead of claiming success when append cannot write', async () => {
    const directory = await temporaryDirectory()
    const repository = new FileTrustedFactRepository(join(directory, 'a-file'))
    await writeFile(join(directory, 'a-file'), 'not a directory')

    const result = repository.append(fact)

    expect(result).toMatchObject({ ok: false, code: 'write_failed' })
  })
})
