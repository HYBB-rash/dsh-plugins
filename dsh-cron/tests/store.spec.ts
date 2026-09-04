/**
 * Characterization tests for the durable JSONL stores (src/store.ts).
 *
 * These lock the current job-log folding (tombstones, corrupt line skipping,
 * last-writer-wins), atomic appends, and V2 run-record reading. Every test
 * uses an isolated mkdtemp store directory and never touches the live
 * ~/.dsh/storages/dsh-cron.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { foldJobLog, JobStore, JsonlStore, RunStore } from '../src/store.ts'
import type { RunFinishRecord } from '../src/types.ts'

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cron-test-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('foldJobLog', () => {
  it('folds an empty log into no active jobs', () => {
    expect(foldJobLog([])).toEqual({ active: [], seenIds: [] })
  })

  it('keeps a single create active', () => {
    const folded = foldJobLog([
      JSON.stringify({ op: 'create', id: 'cron-a', schedule: { kind: 'interval', minutes: 5 }, prompt: 'hi', deliver: 'default', createdAt: '2026-08-14T00:00:00.000Z' }),
    ])
    expect(folded.active.map(job => job.id)).toEqual(['cron-a'])
    expect(folded.seenIds).toEqual(['cron-a'])
  })

  it('removes a job after a delete tombstone but keeps it seen', () => {
    const create = JSON.stringify({ op: 'create', id: 'cron-a', schedule: { kind: 'interval', minutes: 5 }, prompt: 'hi', deliver: 'default', createdAt: '2026-08-14T00:00:00.000Z' })
    const del = JSON.stringify({ op: 'delete', id: 'cron-a', deletedAt: '2026-08-14T00:01:00.000Z' })
    const folded = foldJobLog([create, del])
    expect(folded.active).toEqual([])
    expect(folded.seenIds).toEqual(['cron-a'])
  })

  it('lets the last create win for the same id', () => {
    const first = JSON.stringify({ op: 'create', id: 'cron-a', schedule: { kind: 'interval', minutes: 5 }, prompt: 'first', deliver: 'default', createdAt: '2026-08-14T00:00:00.000Z' })
    const second = JSON.stringify({ op: 'create', id: 'cron-a', schedule: { kind: 'interval', minutes: 10 }, prompt: 'second', deliver: 'silent', createdAt: '2026-08-14T00:01:00.000Z' })
    const folded = foldJobLog([first, second])
    expect(folded.active).toHaveLength(1)
    expect(folded.active[0]!.prompt).toBe('second')
    expect(folded.active[0]!.schedule).toEqual({ kind: 'interval', minutes: 10 })
  })

  it('ignores delete tombstones for unknown ids', () => {
    const folded = foldJobLog([JSON.stringify({ op: 'delete', id: 'cron-nope', deletedAt: '2026-08-14T00:01:00.000Z' })])
    expect(folded.active).toEqual([])
    expect(folded.seenIds).toEqual(['cron-nope'])
  })

  it('skips corrupt JSON lines without breaking valid ones', () => {
    const good = JSON.stringify({ op: 'create', id: 'cron-a', schedule: { kind: 'interval', minutes: 5 }, prompt: 'hi', deliver: 'default', createdAt: '2026-08-14T00:00:00.000Z' })
    const folded = foldJobLog(['{not json', good, 'garbage'])
    expect(folded.active.map(job => job.id)).toEqual(['cron-a'])
  })

  it('skips invalid creates (missing prompt, non-string id)', () => {
    const noPrompt = JSON.stringify({ op: 'create', id: 'cron-a', schedule: { kind: 'interval', minutes: 5 }, prompt: '  ', deliver: 'default', createdAt: '2026-08-14T00:00:00.000Z' })
    const noId = JSON.stringify({ op: 'create', schedule: { kind: 'interval', minutes: 5 }, prompt: 'hi', deliver: 'default', createdAt: '2026-08-14T00:00:00.000Z' })
    const folded = foldJobLog([noPrompt, noId])
    expect(folded.active).toEqual([])
  })
})

describe('JsonlStore', () => {
  it('reads an absent file as empty', () => {
    const store = new JsonlStore(join(tempDir(), 'absent.jsonl'))
    expect(store.readLines()).toEqual([])
  })

  it('appends atomically and preserves history', () => {
    const store = new JsonlStore(join(tempDir(), 'log.jsonl'))
    store.append({ op: 'create', id: 'cron-a' })
    store.append({ op: 'delete', id: 'cron-a' })
    const lines = store.readLines().map(line => line.trim()).filter(line => line !== '')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!)).toMatchObject({ op: 'create', id: 'cron-a' })
    expect(JSON.parse(lines[1]!)).toMatchObject({ op: 'delete', id: 'cron-a' })
  })
})

describe('JobStore', () => {
  it('round-trips append and fold', () => {
    const store = new JobStore(tempDir())
    store.append({ op: 'create', id: 'cron-a', schedule: { kind: 'cron', expr: '0 8 * * *' }, prompt: 'morning', deliver: 'silent', createdAt: '2026-08-14T00:00:00.000Z' })
    store.append({ op: 'create', id: 'cron-b', schedule: { kind: 'once', runAt: '2026-08-20T00:00:00.000Z' }, prompt: 'one', deliver: 'default', createdAt: '2026-08-14T00:00:01.000Z' })
    store.append({ op: 'delete', id: 'cron-b', deletedAt: '2026-08-14T00:00:02.000Z' })
    const folded = store.fold()
    expect(folded.active.map(job => job.id)).toEqual(['cron-a'])
    expect(folded.seenIds).toEqual(['cron-a', 'cron-b'])
    expect(folded.active[0]).toMatchObject({ schedule: { kind: 'cron', expr: '0 8 * * *' }, deliver: 'silent' })
  })
})

describe('RunStore', () => {
  it('round-trips a V2 terminal event', () => {
    const store = new RunStore(tempDir())
    const record: RunFinishRecord = {
      schemaVersion: 2,
      event: 'finish',
      runId: 'cron-a@2026-08-14T00:00:00.000Z',
      jobId: 'cron-a',
      sessionId: 'session-cron-cron-a',
      scheduledFor: '2026-08-14T00:00:00.000Z',
      startedAt: '2026-08-14T00:00:00.000Z',
      finishedAt: '2026-08-14T00:00:10.000Z',
      status: 'success',
      deliveredAt: '2026-08-14T00:00:11.000Z',
      outputPreview: 'ok',
    }
    store.appendEvent(record)
    expect(store.readAll()).toEqual([record])
  })

  it('skips unversioned terminal rows and corrupt lines', () => {
    const dir = tempDir()
    writeFileSync(
      join(dir, 'runs.jsonl'),
      '{"jobId":"cron-a","sessionId":"s","startedAt":"2026-08-14T00:00:00.000Z","finishedAt":"2026-08-14T00:00:10.000Z","status":"silent"}\n{corrupt\n',
      'utf8',
    )
    const reloaded = new RunStore(dir)
    expect(reloaded.readAll()).toEqual([])
  })
})
