import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { XFeedbackStore } from '../src/store.ts'
import { createTrustedFactNavigation } from '../src/telegram-extension.ts'
import { createTrustedFact } from '../src/trusted-facts/model.ts'
import { FileTrustedFactRepository } from '../src/x-feedback/trusted-fact-repository.ts'
import { FeedbackEffectAdapter } from '../src/x-feedback/feedback-effect-adapter.ts'
import type { FeedbackEffect } from '../src/trusted-facts/feedback-session.ts'

const target = {
  id: 'x:adapter-1',
  content: '一条可靠标题',
  source: 'https://x.example/adapter-1',
  scope: 'this post',
} as const

const result = createTrustedFact({
  target,
  dimension: 'argument_quality',
  reason: '论证清楚。',
  evidence: { kind: 'user_direct', rawUserExpression: '我喜欢，因为论证清楚。' },
})
if (!result.ok) throw new Error(result.message)

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'dsh-x-feed-effect-'))
  directories.push(path)
  return path
}

function testNavigation() {
  return {
    execute: vi.fn(() => ({
      schemaVersion: 1 as const,
      sourceRevision: 'sha256:test' as const,
      items: [],
    })),
  }
}

describe('FeedbackEffectAdapter', () => {
  it('keeps the final navigation revision and complete locator set under concurrent inbound scheduling', async () => {
    const directory = await temporaryDirectory()
    const repository = new FileTrustedFactRepository(directory)
    const navigation = createTrustedFactNavigation(
      directory,
      {
        derive: located => ({
          topics: [],
          relations: [{ kind: 'about-target' as const, targetId: located.fact.target.id }],
        }),
      },
      { method: 'test-concurrent', version: '1' },
    )
    const adapter = new FeedbackEffectAdapter(repository, new XFeedbackStore(directory), navigation)
    const facts = [1, 2].map(index => {
      const factResult = createTrustedFact({
        target: {
          id: `x:concurrent-${index}`,
          content: `并发目标 ${index}`,
          source: `https://x.example/concurrent/${index}`,
          scope: 'current',
        },
        dimension: 'content_value',
        reason: `并发理由 ${index}`,
        evidence: { kind: 'user_direct', rawUserExpression: `记录并发事实 ${index}` },
      })
      if (!factResult.ok) throw new Error(factResult.message)
      return factResult.fact
    })

    const outcomes = await Promise.all(facts.map(fact => Promise.resolve().then(() => (
      adapter.apply({ kind: 'append_trusted_fact', fact })
    ))))

    expect(outcomes).toEqual([{ ok: true }, { ok: true }])
    const located = repository.readLocatedSnapshot()
    const stored = JSON.parse(await readFile(join(directory, 'trusted-fact-navigation.json'), 'utf8')) as {
      readonly sourceRevision: string
      readonly items: readonly { readonly locator: { readonly locatorId: string } }[]
    }
    expect(located.facts).toHaveLength(2)
    expect(stored.sourceRevision).toBe(located.sourceRevision)
    expect(stored.items).toHaveLength(2)
    expect(new Set(stored.items.map(item => item.locator.locatorId))).toEqual(
      new Set(located.facts.map(fact => fact.locator.locatorId)),
    )
  })

  it('rebuilds navigation immediately after a persisted fact and never for save operations', async () => {
    const directory = await temporaryDirectory()
    const repository = new FileTrustedFactRepository(directory)
    const navigation = { execute: vi.fn(() => ({ schemaVersion: 1, sourceRevision: 'sha256:1', items: [] })) }
    const adapter = new FeedbackEffectAdapter(repository, new XFeedbackStore(directory), navigation)

    expect(adapter.apply({ kind: 'append_trusted_fact', fact: result.fact })).toMatchObject({ ok: true })
    expect(navigation.execute).toHaveBeenCalledOnce()

    expect(adapter.apply({ kind: 'record_operation', operation: 'save', target })).toMatchObject({ ok: true })
    expect(navigation.execute).toHaveBeenCalledOnce()
  })

  it('reports a persisted fact when immediate navigation rebuild fails without retrying the append', async () => {
    const directory = await temporaryDirectory()
    const append = vi.fn(() => ({ ok: true as const, fact: result.fact }))
    const navigation = { execute: vi.fn(() => { throw new Error('projection unavailable') }) }
    const adapter = new FeedbackEffectAdapter({ append, readAll: () => [] }, new XFeedbackStore(directory), navigation)

    const outcome = adapter.apply({ kind: 'append_trusted_fact', fact: result.fact })

    expect(outcome).toMatchObject({
      ok: false,
      code: 'fact_persisted_projection_unavailable',
      factPersisted: true,
    })
    expect(append).toHaveBeenCalledOnce()
    expect(navigation.execute).toHaveBeenCalledOnce()
  })

  it('writes trusted facts only to the new repository', async () => {
    const directory = await temporaryDirectory()
    const repository = new FileTrustedFactRepository(directory)
    const oldStore = new XFeedbackStore(directory)
    const adapter = new FeedbackEffectAdapter(repository, oldStore, testNavigation())

    expect(adapter.apply({ kind: 'append_trusted_fact', fact: result.fact })).toMatchObject({ ok: true })
    expect(repository.readAll()).toHaveLength(1)
    expect(oldStore.readAll()).toHaveLength(0)
  })

  it.each(['save', 'unsave'] as const)('records %s as an old operation and never as a fact', async operation => {
    const directory = await temporaryDirectory()
    const repository = new FileTrustedFactRepository(directory)
    const oldStore = new XFeedbackStore(directory)
    const adapter = new FeedbackEffectAdapter(repository, oldStore, testNavigation())
    const append = vi.spyOn(oldStore, 'append')

    const outcome = adapter.apply({ kind: 'record_operation', operation, target })

    expect(outcome).toMatchObject({ ok: true })
    expect(append).toHaveBeenCalledWith({ operation, url: target.source, title: target.content })
    expect(repository.readAll()).toHaveLength(0)
    expect(oldStore.readAll()).toHaveLength(1)
    expect(oldStore.readAll()[0]).toMatchObject({ operation, canonicalUrl: target.source })
    expect(oldStore.readAll()[0]).not.toHaveProperty('note')
    expect(oldStore.readAll()[0]).not.toHaveProperty('like')
    expect(oldStore.readAll()[0]).not.toHaveProperty('dislike')
  })

  it('does not claim success when an injected operation store fails', async () => {
    const directory = await temporaryDirectory()
    const repository = new FileTrustedFactRepository(directory)
    const append = vi.fn(() => ({ ok: false as const, code: 'write_failed' as const, message: 'disk full' }))
    const adapter = new FeedbackEffectAdapter(repository, { append }, testNavigation())

    const outcome = adapter.apply({ kind: 'record_operation', operation: 'save', target })

    expect(outcome).toMatchObject({ ok: false, code: 'write_failed' })
    expect(repository.readAll()).toHaveLength(0)
  })

  it('does not claim success when the trusted repository fails', async () => {
    const directory = await temporaryDirectory()
    const oldStore = new XFeedbackStore(directory)
    const repository = { append: vi.fn(() => ({ ok: false as const, code: 'write_failed' as const, message: 'disk full' })) }
    const adapter = new FeedbackEffectAdapter(repository, oldStore, testNavigation())

    const outcome = adapter.apply({ kind: 'append_trusted_fact', fact: result.fact })

    expect(outcome).toMatchObject({ ok: false, code: 'write_failed' })
    await expect(readFile(join(directory, 'trusted-facts.jsonl'), 'utf8')).rejects.toThrow()
  })

  it('returns a stable invalid-effect failure for a forged runtime effect', async () => {
    const directory = await temporaryDirectory()
    const repository = new FileTrustedFactRepository(directory)
    const operationStore = { append: vi.fn(() => ({ ok: true as const, event: {} as never })) }
    const adapter = new FeedbackEffectAdapter(repository, operationStore, testNavigation())

    const outcome = adapter.apply({ kind: 'forged_effect' } as unknown as FeedbackEffect)

    expect(outcome).toMatchObject({ ok: false, code: 'invalid_effect' })
    expect(operationStore.append).not.toHaveBeenCalled()
    await expect(readFile(join(directory, 'trusted-facts.jsonl'), 'utf8')).rejects.toThrow()
  })

  it('returns a stable write failure when the trusted repository throws synchronously', async () => {
    const directory = await temporaryDirectory()
    const repository = { append: vi.fn(() => { throw new Error('repository unavailable') }) }
    const adapter = new FeedbackEffectAdapter(repository, { append: vi.fn() }, testNavigation())

    const outcome = adapter.apply({ kind: 'append_trusted_fact', fact: result.fact })

    expect(outcome).toMatchObject({ ok: false, code: 'write_failed', message: 'repository unavailable' })
    await expect(readFile(join(directory, 'trusted-facts.jsonl'), 'utf8')).rejects.toThrow()
  })

  it('exposes only the two TODO 1 effects at the adapter boundary', () => {
    const effect: FeedbackEffect = { kind: 'record_operation', operation: 'save', target }
    expect(effect.kind).toBe('record_operation')
  })
})
