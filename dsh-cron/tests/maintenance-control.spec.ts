import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createMaintenanceControl,
  type AgentBinding,
  type TransitionAgentBindingRequest,
} from '../src/index.ts'
import { JobStore, JsonlStore } from '../src/store.ts'

const dirs: string[] = []
const PRIMARY = 'dsh-business:primary'
const MARKER = 'dsh-business/v1'

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cron-maintenance-'))
  dirs.push(dir)
  return dir
}

function lines(dir: string): unknown[] {
  try {
    return readFileSync(join(dir, 'jobs.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
  } catch {
    return []
  }
}

function legacy(dir: string, overrides: Record<string, unknown> = {}): void {
  new JsonlStore(join(dir, 'jobs.jsonl')).append({
    op: 'create',
    id: 'job-x-primary',
    schedule: { kind: 'interval', minutes: 60 },
    prompt: 'a prompt that must never be exposed by the migration state',
    deliver: 'telegram',
    createdAt: '2026-08-21T00:00:00.000Z',
    ...overrides,
  })
}

function request(
  dir: string,
  desiredBinding: AgentBinding,
  expectedBinding: AgentBinding = { sessionMode: 'persistent' },
): TransitionAgentBindingRequest {
  const inspected = createMaintenanceControl({ storeDir: dir }).inspectAgentBindingById('job-x-primary')!
  return {
    jobId: 'job-x-primary',
    expectedImmutableSha256: inspected.immutableSha256,
    expectedBinding,
    desiredBinding,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('local maintenance Agent binding CAS', () => {
  it('changes only binding fields, preserves identity, and appends one same-id row', () => {
    const dir = tempDir()
    legacy(dir)
    const control = createMaintenanceControl({ storeDir: dir })
    const before = control.inspectAgentBindingById('job-x-primary')!
    const result = control.transitionAgentBindingById(request(dir, {
      sessionMode: 'per_run',
      agentEnvironment: MARKER,
      externalRef: PRIMARY,
    }))

    expect(result).toMatchObject({ ok: true, changed: true, jobId: 'job-x-primary', binding: {
      sessionMode: 'per_run', agentEnvironment: MARKER, externalRef: PRIMARY,
    } })
    const after = control.inspectAgentBindingById('job-x-primary')!
    expect(after.immutableSha256).toBe(before.immutableSha256)
    expect(lines(dir)).toHaveLength(2)
    expect(lines(dir)).toEqual([
      expect.objectContaining({ id: 'job-x-primary', prompt: expect.any(String) }),
      expect.objectContaining({ id: 'job-x-primary', sessionMode: 'per_run', agentEnvironment: MARKER, externalRef: PRIMARY }),
    ])
    expect(new JobStore(dir).fold().active).toHaveLength(1)
  })

  it('is idempotent for desired and reverse bindings, including lost-response retry', () => {
    const dir = tempDir()
    legacy(dir)
    const control = createMaintenanceControl({ storeDir: dir })
    const desired = request(dir, { sessionMode: 'per_run', agentEnvironment: MARKER, externalRef: PRIMARY })
    expect(control.transitionAgentBindingById(desired)).toMatchObject({ ok: true, changed: true })
    const afterFirst = lines(dir)
    expect(control.transitionAgentBindingById({ ...desired, expectedBinding: { sessionMode: 'persistent' } })).toMatchObject({ ok: false, errorCode: 'binding_mismatch' })
    const retry = request(dir, { sessionMode: 'per_run', agentEnvironment: MARKER, externalRef: PRIMARY }, { sessionMode: 'per_run', agentEnvironment: MARKER, externalRef: PRIMARY })
    retry.expectedImmutableSha256 = control.inspectAgentBindingById('job-x-primary')!.immutableSha256
    expect(control.transitionAgentBindingById(retry)).toMatchObject({ ok: true, changed: false })
    expect(lines(dir)).toEqual(afterFirst)

    const reverse = request(dir, { sessionMode: 'persistent' }, { sessionMode: 'per_run', agentEnvironment: MARKER, externalRef: PRIMARY })
    reverse.expectedImmutableSha256 = control.inspectAgentBindingById('job-x-primary')!.immutableSha256
    expect(control.transitionAgentBindingById(reverse)).toMatchObject({ ok: true, changed: true })
    const reverseRetry = request(dir, { sessionMode: 'persistent' })
    reverseRetry.expectedImmutableSha256 = control.inspectAgentBindingById('job-x-primary')!.immutableSha256
    expect(control.transitionAgentBindingById(reverseRetry)).toMatchObject({ ok: true, changed: false })
    expect(new JobStore(dir).fold().active).toHaveLength(1)
  })

  it('leaves the old row authoritative when append fails', () => {
    const dir = tempDir()
    legacy(dir)
    const control = createMaintenanceControl({ storeDir: dir })
    const before = lines(dir)
    const append = JobStore.prototype.append
    vi.spyOn(JobStore.prototype, 'append').mockImplementation(() => { throw new Error('injected append failure') })
    const result = control.transitionAgentBindingById(request(dir, { sessionMode: 'per_run', agentEnvironment: MARKER, externalRef: PRIMARY }))
    expect(result).toMatchObject({ ok: false, errorCode: 'persistence_uncertain' })
    expect(lines(dir)).toEqual(before)
    expect(control.inspectAgentBindingById('job-x-primary')!.binding).toEqual({ sessionMode: 'persistent' })
    JobStore.prototype.append = append
  })

  it('fails closed with zero writes for identity, kind, digest, binding, collisions, and gate conflicts', () => {
    const dir = tempDir()
    legacy(dir)
    new JsonlStore(join(dir, 'jobs.jsonl')).append({
      op: 'create', kind: 'command', id: 'command-job', externalRef: PRIMARY,
      schedule: { kind: 'interval', minutes: 60 }, command: { argv: ['/bin/true'], timeoutSeconds: 1, outputMaxBytes: 1 },
      deliver: 'telegram', createdAt: '2026-08-21T00:00:00.000Z',
    })
    const control = createMaintenanceControl({ storeDir: dir })
    const before = lines(dir)
    const base = request(dir, { sessionMode: 'per_run', agentEnvironment: MARKER, externalRef: PRIMARY })
    for (const bad of [
      { ...base, jobId: 'missing' },
      { ...base, expectedImmutableSha256: '0'.repeat(64) },
      { ...base, expectedBinding: { sessionMode: 'per_run' } },
      { ...base, desiredBinding: { sessionMode: 'per_run', agentEnvironment: MARKER, externalRef: PRIMARY } },
    ]) {
      const result = control.transitionAgentBindingById(bad)
      expect(result.ok).toBe(false)
      expect(lines(dir)).toEqual(before)
    }
    const commandInspection = control.inspectAgentBindingById('command-job')
    expect(commandInspection).toBeNull()
    const commandTransition = control.transitionAgentBindingById({
      jobId: 'command-job',
      expectedImmutableSha256: '0'.repeat(64),
      expectedBinding: { sessionMode: 'persistent' },
      desiredBinding: { sessionMode: 'per_run', agentEnvironment: MARKER, externalRef: 'other' },
    })
    expect(commandTransition).toMatchObject({ ok: false, errorCode: 'wrong_kind' })
    expect(lines(dir)).toEqual(before)

    const gatedDir = tempDir()
    legacy(gatedDir, { sessionMode: 'per_run', gate: { kind: 'nonempty_stdout', command: { argv: ['/bin/true'], timeoutSeconds: 1, outputMaxBytes: 1 } } })
    const gated = createMaintenanceControl({ storeDir: gatedDir })
    const gatedBefore = lines(gatedDir)
    expect(gated.transitionAgentBindingById(request(gatedDir, { sessionMode: 'per_run', agentEnvironment: MARKER }, { sessionMode: 'per_run' }))).toMatchObject({ ok: false, errorCode: 'marker_gate_conflict' })
    expect(lines(gatedDir)).toEqual(gatedBefore)
  })

  it('does not alter unrelated non-X Agent definitions or command jobs', () => {
    const dir = tempDir()
    legacy(dir, { id: 'non-x-job', externalRef: 'non-x:primary', prompt: 'unrelated' })
    const before = lines(dir)
    const control = createMaintenanceControl({ storeDir: dir })
    const inspection = control.inspectAgentBindingById('non-x-job')!
    const result = control.transitionAgentBindingById({
      jobId: 'non-x-job', expectedImmutableSha256: inspection.immutableSha256,
      expectedBinding: inspection.binding, desiredBinding: { sessionMode: 'per_run', externalRef: 'non-x:primary' },
    })
    expect(result).toMatchObject({ ok: true, changed: true })
    const after = lines(dir)
    expect(after[0]).toEqual(before[0])
    expect(after[1]).toMatchObject({ id: 'non-x-job', externalRef: 'non-x:primary', prompt: 'unrelated', sessionMode: 'per_run' })
  })
})
