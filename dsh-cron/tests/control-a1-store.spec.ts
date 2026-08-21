/**
 * Lane A1 red tests for durable binding identity and manager compatibility.
 *
 * These tests use only temporary stores. They intentionally describe the
 * next durable projection without changing the existing store or manager.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { registerCronTools } from '../src/manager.ts'
import { JobStore } from '../src/store.ts'

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cron-a1-store-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function appendRaw(store: JobStore, entry: unknown): void {
  ;(store as unknown as { append(entry: unknown): void }).append(entry)
}

function fakeScope() {
  const tools = new Map<string, { execute(args: unknown, exec: unknown): Promise<unknown> }>()
  const toolCtx = {
    tools: {
      register(def: { name: string; execute(args: unknown, exec: unknown): Promise<unknown> }) {
        tools.set(def.name, def)
        return () => tools.delete(def.name)
      },
    },
  }
  const rootCtx = {
    sessions: { flush: async () => undefined },
    logger: { warn: () => undefined },
  }
  return { tools, toolCtx, rootCtx }
}

const EXEC = { agent: { session: {} } }

describe('Lane A1 job identity persistence', () => {
  it('persists externalRef/sessionMode and interprets old records as persistent', () => {
    const store = new JobStore(tempDir())
    appendRaw(store, {
      op: 'create',
      id: 'job-new',
      externalRef: 'external:placeholder',
      sessionMode: 'per_run',
      schedule: { kind: 'interval', minutes: 5 },
      prompt: 'placeholder prompt',
      deliver: 'telegram',
      createdAt: '2026-08-18T00:00:00.000Z',
    })
    appendRaw(store, {
      op: 'create',
      id: 'job-old',
      schedule: { kind: 'interval', minutes: 5 },
      prompt: 'legacy placeholder prompt',
      deliver: 'telegram',
      createdAt: '2026-08-17T00:00:00.000Z',
    })

    const active = store.fold().active as readonly Record<string, unknown>[]
    expect(active).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'job-new',
        externalRef: 'external:placeholder',
        sessionMode: 'per_run',
      }),
      expect.objectContaining({ id: 'job-old', sessionMode: 'persistent' }),
    ]))
  })

  it('persists only a valid per-run nonempty-stdout gate and drops malformed or persistent gated rows', () => {
    const store = new JobStore(tempDir())
    const gate = {
      kind: 'nonempty_stdout',
      command: { argv: ['/usr/bin/python3', 'gate.py'], timeoutSeconds: 30, outputMaxBytes: 4_096 },
    } as const
    appendRaw(store, {
      op: 'create',
      id: 'job-gated',
      externalRef: 'external:gated',
      sessionMode: 'per_run',
      schedule: { kind: 'interval', minutes: 5 },
      prompt: 'fixed prompt',
      gate,
      deliver: 'telegram',
      createdAt: '2026-08-18T00:00:00.000Z',
    })
    for (const [id, sessionMode, badGate] of [
      ['job-persistent-gate', 'persistent', gate],
      ['job-bad-gate', 'per_run', { ...gate, kind: 'business-specific' }],
    ] as const) {
      appendRaw(store, {
        op: 'create',
        id,
        sessionMode,
        schedule: { kind: 'interval', minutes: 5 },
        prompt: 'must be rejected',
        gate: badGate,
        deliver: 'telegram',
        createdAt: '2026-08-18T00:00:00.000Z',
      })
    }

    expect(store.fold().active).toEqual([
      expect.objectContaining({ id: 'job-gated', sessionMode: 'per_run', gate }),
    ])
  })

  it('persists only bounded failure-alert policy rows and keeps legacy rows policy-free', () => {
    const store = new JobStore(tempDir())
    const failureAlert = { after: 2, cooldownMinutes: 30 } as const
    appendRaw(store, {
      op: 'create',
      id: 'job-alert-agent',
      externalRef: 'external:alert-agent',
      sessionMode: 'per_run',
      schedule: { kind: 'cron', expr: '4 * * * *' },
      prompt: 'fixed prompt',
      deliver: 'telegram',
      failureAlert,
      createdAt: '2026-08-20T00:00:00.000Z',
    })
    appendRaw(store, {
      op: 'create',
      kind: 'command',
      id: 'job-alert-command',
      externalRef: 'external:alert-command',
      schedule: { kind: 'interval', minutes: 2 },
      command: { argv: ['/bin/false'], timeoutSeconds: 30, outputMaxBytes: 4_096 },
      deliver: 'telegram',
      failureAlert,
      createdAt: '2026-08-20T00:00:00.000Z',
    })
    for (const [id, deliver, policy] of [
      ['job-alert-zero', 'telegram', { after: 0, cooldownMinutes: 30 }],
      ['job-alert-no-cooldown', 'telegram', { after: 2, cooldownMinutes: 0 }],
      ['job-alert-silent', 'silent', failureAlert],
    ] as const) {
      appendRaw(store, {
        op: 'create',
        kind: 'command',
        id,
        schedule: { kind: 'interval', minutes: 2 },
        command: { argv: ['/bin/false'], timeoutSeconds: 30, outputMaxBytes: 4_096 },
        deliver,
        failureAlert: policy,
        createdAt: '2026-08-20T00:00:00.000Z',
      })
    }

    expect(store.fold().active).toEqual([
      expect.objectContaining({ id: 'job-alert-agent', failureAlert }),
      expect.objectContaining({ id: 'job-alert-command', failureAlert }),
    ])
  })

  it('folds complete same-id policy upserts to one identity and remains readable when failureAlert is ignored', () => {
    const dir = tempDir()
    const store = new JobStore(dir)
    const original = {
      op: 'create',
      id: 'job-policy-upsert',
      externalRef: 'external:policy-upsert',
      sessionMode: 'per_run',
      schedule: { kind: 'interval', minutes: 60 },
      prompt: 'fixed prompt',
      gate: {
        kind: 'nonempty_stdout',
        command: { argv: ['/bin/true'], timeoutSeconds: 30, outputMaxBytes: 4_096 },
      },
      deliver: 'telegram',
      cwd: '/srv/fixed',
      createdAt: '2026-08-20T00:00:00.000Z',
    } as const
    appendRaw(store, original)
    appendRaw(store, { ...original, failureAlert: { after: 2, cooldownMinutes: 30 } })

    expect(store.fold()).toMatchObject({
      active: [{
        id: original.id,
        externalRef: original.externalRef,
        schedule: original.schedule,
        prompt: original.prompt,
        gate: original.gate,
        deliver: original.deliver,
        cwd: original.cwd,
        sessionMode: original.sessionMode,
        createdAt: original.createdAt,
        failureAlert: { after: 2, cooldownMinutes: 30 },
      }],
      seenIds: [original.id],
    })

    // Frozen compatibility projection for the prior reader: it ignores the
    // optional policy field but still applies the complete same-id create as
    // a last-write-wins upsert with the original identity and core fields.
    const legacyActive = new Map<string, Record<string, unknown>>()
    for (const raw of readFileSync(join(dir, 'jobs.jsonl'), 'utf8').split('\n').filter(Boolean)) {
      const entry = JSON.parse(raw) as Record<string, unknown>
      if (entry.op === 'delete') legacyActive.delete(String(entry.id))
      if (entry.op === 'create') {
        const { failureAlert: _ignored, ...known } = entry
        legacyActive.set(String(entry.id), known)
      }
    }
    expect([...legacyActive.values()]).toEqual([expect.objectContaining(original)])
  })

  it('keeps ordinary cron_create compatible by materializing persistent', async () => {
    const dir = tempDir()
    const { tools, toolCtx, rootCtx } = fakeScope()
    registerCronTools(rootCtx as never, toolCtx as never, new JobStore(dir))

    await tools.get('cron_create')!.execute(
      { prompt: 'placeholder prompt', schedule: { kind: 'interval', minutes: 5 } },
      EXEC,
    )

    const active = new JobStore(dir).fold().active as readonly Record<string, unknown>[]
    expect(active).toEqual([expect.objectContaining({ sessionMode: 'persistent' })])
  })

  it('exposes complete externalRef history and latestRun across deleted job ids', () => {
    const dir = tempDir()
    const store = new JobStore(dir)
    appendRaw(store, {
      op: 'create',
      id: 'job-first',
      externalRef: 'external:placeholder',
      sessionMode: 'persistent',
      schedule: { kind: 'interval', minutes: 5 },
      prompt: 'first placeholder prompt',
      deliver: 'telegram',
      createdAt: '2026-08-17T00:00:00.000Z',
    })
    appendRaw(store, {
      op: 'delete',
      id: 'job-first',
      deletedAt: '2026-08-18T00:00:00.000Z',
    })
    // This is intentionally the smallest proposed store boundary: jobs.jsonl
    // remains the job fact, while the store projection joins deleted history
    // by externalRef without reviving the old job. The control service test
    // separately composes runs.jsonl for latestRun.
    const history = (store as unknown as {
      externalRefHistory(externalRef: string): readonly Record<string, unknown>[]
    }).externalRefHistory('external:placeholder')

    expect(history).toEqual([
      expect.objectContaining({ id: 'job-first', externalRef: 'external:placeholder' }),
    ])
  })
})
