import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createControlService } from '../src/control.ts'
import { foldJobLog, JobStore } from '../src/store.ts'
import type { BoundCronSpec, ControlSuccessResponse } from '../src/control-contract.ts'

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cron-agent-environment-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const BASE_SPEC: BoundCronSpec = {
  externalRef: 'external:agent-environment',
  schedule: { kind: 'interval', minutes: 5 },
  prompt: 'bounded environment prompt',
  deliver: 'telegram',
  sessionMode: 'per_run',
  agentEnvironment: 'dsh-x-feed/v1',
}

function jobLines(dir: string): unknown[] {
  try {
    return readFileSync(join(dir, 'jobs.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line))
  } catch {
    return []
  }
}

describe('generic agent environment marker contract', () => {
  it('keeps legacy rows byte-compatible while materializing a canonical per-run marker', () => {
    const legacy = JSON.stringify({
      op: 'create',
      id: 'legacy-agent',
      schedule: { kind: 'interval', minutes: 5 },
      prompt: 'legacy prompt',
      deliver: 'telegram',
      createdAt: '2026-08-20T00:00:00.000Z',
    })
    const marked = JSON.stringify({
      op: 'create',
      id: 'marked-agent',
      externalRef: BASE_SPEC.externalRef,
      schedule: BASE_SPEC.schedule,
      prompt: BASE_SPEC.prompt,
      deliver: BASE_SPEC.deliver,
      sessionMode: BASE_SPEC.sessionMode,
      agentEnvironment: BASE_SPEC.agentEnvironment,
      createdAt: '2026-08-20T00:00:00.000Z',
    })

    expect(foldJobLog([legacy])).toEqual({
      active: [{
        id: 'legacy-agent',
        schedule: { kind: 'interval', minutes: 5 },
        prompt: 'legacy prompt',
        deliver: 'telegram',
        sessionMode: 'persistent',
        createdAt: '2026-08-20T00:00:00.000Z',
      }],
      seenIds: ['legacy-agent'],
    })
    expect(foldJobLog([marked]).active).toEqual([expect.objectContaining({
      id: 'marked-agent',
      sessionMode: 'per_run',
      agentEnvironment: 'dsh-x-feed/v1',
    })])
  })

  it.each([
    ['persistent session', { sessionMode: 'persistent' }],
    ['command gate', {
      gate: {
        kind: 'nonempty_stdout',
        command: { argv: ['/bin/true'], timeoutSeconds: 1, outputMaxBytes: 100 },
      },
    }],
    ['command kind', { kind: 'command', command: { argv: ['/bin/true'], timeoutSeconds: 1, outputMaxBytes: 100 } }],
    ['blank marker', { agentEnvironment: ' dsh-x-feed/v1 ' }],
    ['noncanonical marker', { agentEnvironment: 'DSH-X-FEED/V1' }],
  ])('isolates invalid replay rows (%s) instead of activating them', (_label, extra) => {
    const raw = {
      op: 'create',
      id: `invalid-${_label}`,
      externalRef: BASE_SPEC.externalRef,
      schedule: BASE_SPEC.schedule,
      prompt: BASE_SPEC.prompt,
      deliver: BASE_SPEC.deliver,
      sessionMode: BASE_SPEC.sessionMode,
      agentEnvironment: BASE_SPEC.agentEnvironment,
      createdAt: '2026-08-20T00:00:00.000Z',
      ...extra,
    }
    const folded = foldJobLog([JSON.stringify(raw)])
    expect(folded.active).toEqual([])
    expect(folded.invalid).toEqual([expect.objectContaining({
      id: raw.id,
      line: 1,
    })])
  })

  it('rejects invalid marker combinations through control without appending', async () => {
    const dir = tempDir()
    const service = createControlService({ storeDir: dir })
    const invalid: readonly BoundCronSpec[] = [
      { ...BASE_SPEC, sessionMode: 'persistent' as never },
      {
        ...BASE_SPEC,
        agentEnvironment: 'dsh-x-feed/v1',
        gate: {
          kind: 'nonempty_stdout',
          command: { argv: ['/bin/true'], timeoutSeconds: 1, outputMaxBytes: 100 },
        },
      },
      { ...BASE_SPEC, agentEnvironment: ' dsh-x-feed/v1 ' },
      { ...BASE_SPEC, agentEnvironment: 'DSH-X-FEED/V1' },
    ]
    for (const spec of invalid) {
      const response = await service.ensureBound(spec)
      expect(response).toMatchObject({ ok: false, errorCode: 'invalid_request', operation: 'ensure-bound' })
    }
    expect(jobLines(dir)).toEqual([])
  })

  it('round-trips a marker through the manager-owned control response', async () => {
    const dir = tempDir()
    const service = createControlService({ storeDir: dir })
    const response = await service.ensureBound(BASE_SPEC) as ControlSuccessResponse
    expect(response.ok).toBe(true)
    expect(response.snapshot.activeJob).toMatchObject({
      agentEnvironment: 'dsh-x-feed/v1',
      sessionMode: 'per_run',
    })
    expect(jobLines(dir)[0]).toMatchObject({
      op: 'create',
      agentEnvironment: 'dsh-x-feed/v1',
      sessionMode: 'per_run',
    })

    const updated = await service.updateBoundFailureAlert(BASE_SPEC.externalRef, {
      after: 2,
      cooldownMinutes: 30,
    }) as ControlSuccessResponse
    expect(updated.snapshot.activeJob).toMatchObject({
      agentEnvironment: 'dsh-x-feed/v1',
      sessionMode: 'per_run',
    })
    expect(jobLines(dir).at(-1)).toMatchObject({
      op: 'create',
      agentEnvironment: 'dsh-x-feed/v1',
      sessionMode: 'per_run',
      failureAlert: { after: 2, cooldownMinutes: 30 },
    })
  })

  it('does not permit an agent marker on the command control surface', async () => {
    const dir = tempDir()
    const service = createControlService({ storeDir: dir })
    const response = await service.ensureBoundCommand({
      externalRef: 'external:command-with-marker',
      schedule: { kind: 'interval', minutes: 5 },
      command: { argv: ['/bin/true'], timeoutSeconds: 1, outputMaxBytes: 100 },
      deliver: 'silent',
      agentEnvironment: 'dsh-x-feed/v1',
    } as never)
    expect(response).toMatchObject({ ok: false, errorCode: 'invalid_request', operation: 'ensure-bound-command' })
    expect(jobLines(dir)).toEqual([])
  })

  it('keeps the invalid replay row isolated from a valid same-id prior row', () => {
    const store = new JobStore(tempDir())
    store.append({
      op: 'create',
      id: 'same-id',
      schedule: { kind: 'interval', minutes: 5 },
      prompt: 'valid prior row',
      deliver: 'silent',
      createdAt: '2026-08-20T00:00:00.000Z',
    })
    store.append({
      op: 'create',
      id: 'same-id',
      externalRef: 'external:bad',
      schedule: { kind: 'interval', minutes: 5 },
      prompt: 'invalid marker row',
      deliver: 'silent',
      sessionMode: 'persistent',
      agentEnvironment: 'dsh-x-feed/v1',
      createdAt: '2026-08-20T00:00:01.000Z',
    } as never)
    expect(store.fold().active).toEqual([expect.objectContaining({ id: 'same-id', prompt: 'valid prior row' })])
    expect(store.fold().invalid).toEqual([expect.objectContaining({ id: 'same-id' })])
  })
})
