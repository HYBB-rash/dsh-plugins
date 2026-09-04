/**
 * Lane A1 red tests for the durable bound-control service.
 *
 * The service module is intentionally not implemented in this phase. These
 * scenarios freeze idempotency, conflict, replacement, deletion, restart,
 * and history projection against the existing jobs.jsonl/runs.jsonl facts.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createControlService, inspectActiveJobs } from '../src/control.ts'
import { JsonlStore, RunLedger } from '../src/store.ts'
import type {
  BoundCronCommandSnapshot,
  BoundCronCommandSpec,
  BoundCronSnapshot,
  BoundCronSpec,
  ControlResponse,
  ControlSuccessResponse,
} from '../src/control-contract.ts'

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cron-a1-control-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const SPEC: BoundCronSpec = {
  externalRef: 'external:placeholder',
  schedule: { kind: 'interval', minutes: 5 },
  prompt: 'placeholder prompt',
  deliver: 'default',
  cwd: 'placeholder-cwd',
  sessionMode: 'per_run',
}

const CONFLICTING_SPEC: BoundCronSpec = {
  ...SPEC,
  prompt: 'conflicting placeholder prompt',
}

const GATED_SPEC: BoundCronSpec = {
  ...SPEC,
  externalRef: 'external:gated-placeholder',
  gate: {
    kind: 'nonempty_stdout',
    command: {
      argv: ['/usr/bin/python3', '/opt/gate.py'],
      timeoutSeconds: 180,
      outputMaxBytes: 65_536,
    },
  },
}

const COMMAND_SPEC: BoundCronCommandSpec = {
  externalRef: 'external:command-placeholder',
  schedule: { kind: 'interval', minutes: 5 },
  command: {
    argv: ['/usr/bin/python3', 'scripts/monitor.py', '--json'],
    timeoutSeconds: 120,
    outputMaxBytes: 4_096,
  },
  deliver: 'default',
  cwd: '/srv/monitor',
}

const FAILURE_ALERT = { after: 2, cooldownMinutes: 30 } as const

const ALERT_SPEC: BoundCronSpec = {
  ...SPEC,
  externalRef: 'external:alert-placeholder',
  failureAlert: FAILURE_ALERT,
}

const ALERT_COMMAND_SPEC: BoundCronCommandSpec = {
  ...COMMAND_SPEC,
  externalRef: 'external:alert-command-placeholder',
  failureAlert: FAILURE_ALERT,
}

const INVALID_SCHEDULE_SPECS: readonly BoundCronSpec[] = [
  { ...SPEC, schedule: { kind: 'cron', expr: '60 * * * *' } },
  { ...SPEC, schedule: { kind: 'cron', expr: '* * * * * *' } },
  { ...SPEC, schedule: { kind: 'interval', minutes: 0 } },
  { ...SPEC, schedule: { kind: 'interval', minutes: 1.5 } },
  { ...SPEC, schedule: { kind: 'once', runAt: 'not-a-date' } },
]

function activeJob(response: ControlResponse): NonNullable<BoundCronSnapshot['activeJob']> {
  expect(response.ok).toBe(true)
  const snapshot = (response as ControlSuccessResponse).snapshot
  expect(snapshot.activeJob).not.toBeNull()
  return snapshot.activeJob!
}

function activeCommandJob(response: ControlResponse): NonNullable<BoundCronCommandSnapshot['activeJob']> {
  expect(response.ok).toBe(true)
  const snapshot = (response as { readonly snapshot: BoundCronCommandSnapshot }).snapshot
  expect(snapshot.activeJob).not.toBeNull()
  return snapshot.activeJob!
}

function jobLines(dir: string): unknown[] {
  const file = join(dir, 'jobs.jsonl')
  try {
    return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  } catch {
    return []
  }
}

describe('Lane A1 control service binding lifecycle', () => {
  it('updates and clears an Agent failureAlert in place without changing identity, execution fields, anchor, or latestRun', async () => {
    const dir = tempDir()
    const service = createControlService({ storeDir: dir })
    const original = activeJob(await service.ensureBound(GATED_SPEC))
    new JsonlStore(join(dir, 'runs.jsonl')).append({
      schemaVersion: 2,
      event: 'finish',
      runId: 'run-before-policy-update',
      jobId: original.id,
      sessionId: 'session-before-policy-update',
      scheduledFor: '2026-08-20T00:00:00.000Z',
      startedAt: '2026-08-20T00:00:00.000Z',
      finishedAt: '2026-08-20T00:00:01.000Z',
      nextRunAt: '2026-08-20T01:00:01.000Z',
      status: 'error',
      deliveryState: 'not_requested',
    })

    const updatedResponse = await service.updateBoundFailureAlert(GATED_SPEC.externalRef, FAILURE_ALERT)
    const updated = activeJob(updatedResponse)
    const restarted = createControlService({ storeDir: dir })
    const afterRestart = activeJob(await restarted.getBound(GATED_SPEC.externalRef))

    expect(updated).toEqual({ ...original, failureAlert: FAILURE_ALERT })
    expect(afterRestart).toEqual(updated)
    expect((updatedResponse as ControlSuccessResponse).snapshot.latestRun).toMatchObject({
      runId: 'run-before-policy-update',
      jobId: original.id,
    })
    expect(new RunLedger(dir).foldJob(original.id)).toMatchObject({
      nextRunAt: '2026-08-20T01:00:01.000Z',
      consecutiveExecutionErrors: 1,
    })
    expect(jobLines(dir).filter(line => (line as { op?: string }).op === 'create')).toEqual([
      expect.objectContaining({ id: original.id, createdAt: original.createdAt }),
      expect.objectContaining({ id: original.id, createdAt: original.createdAt, failureAlert: FAILURE_ALERT }),
    ])
    expect(jobLines(dir).some(line => (line as { op?: string }).op === 'delete')).toBe(false)

    const cleared = activeJob(await restarted.updateBoundFailureAlert(GATED_SPEC.externalRef, null))
    expect(cleared).toEqual(original)
    expect(jobLines(dir).filter(line => (line as { op?: string }).op === 'create')).toHaveLength(3)
    expect(new RunLedger(dir).foldJob(original.id).nextRunAt).toBe('2026-08-20T01:00:01.000Z')
  })

  it('updates a command failureAlert in place and preserves every command field', async () => {
    const dir = tempDir()
    const service = createControlService({ storeDir: dir })
    const original = activeCommandJob(await service.ensureBoundCommand(COMMAND_SPEC))

    const updated = activeCommandJob(await service.updateBoundFailureAlert(COMMAND_SPEC.externalRef, FAILURE_ALERT))
    const restarted = createControlService({ storeDir: dir })

    expect(updated).toEqual({ ...original, failureAlert: FAILURE_ALERT })
    expect(activeCommandJob(await restarted.getBoundCommand(COMMAND_SPEC.externalRef))).toEqual(updated)
    expect(jobLines(dir)).toEqual([
      expect.objectContaining({ op: 'create', kind: 'command', id: original.id, createdAt: original.createdAt }),
      expect.objectContaining({
        op: 'create',
        kind: 'command',
        id: original.id,
        createdAt: original.createdAt,
        command: COMMAND_SPEC.command,
        failureAlert: FAILURE_ALERT,
      }),
    ])
  })

  it('is idempotent when the requested failureAlert is already authoritative', async () => {
    const dir = tempDir()
    const service = createControlService({ storeDir: dir })
    const original = activeJob(await service.ensureBound(ALERT_SPEC))

    const same = activeJob(await service.updateBoundFailureAlert(ALERT_SPEC.externalRef, {
      cooldownMinutes: 30,
      after: 2,
    }))

    expect(same).toEqual(original)
    expect(jobLines(dir)).toHaveLength(1)
  })

  it('fails closed for missing or ambiguous bindings and for policy on silent command delivery', async () => {
    const missingDir = tempDir()
    const missing = createControlService({ storeDir: missingDir })
    expect(await missing.updateBoundFailureAlert('external:missing', FAILURE_ALERT)).toMatchObject({
      ok: false,
      errorCode: 'binding_conflict',
    })
    expect(jobLines(missingDir)).toEqual([])

    const ambiguousDir = tempDir()
    const ambiguousStore = new JsonlStore(join(ambiguousDir, 'jobs.jsonl'))
    for (const [id, prompt] of [['job-one', 'first prompt'], ['job-two', 'second prompt']]) {
      ambiguousStore.append({
        op: 'create',
        id,
        externalRef: 'external:ambiguous',
        sessionMode: 'per_run',
        schedule: { kind: 'interval', minutes: 5 },
        prompt,
        deliver: 'default',
        createdAt: '2026-08-20T00:00:00.000Z',
      })
    }
    const ambiguousBefore = jobLines(ambiguousDir)
    expect(await createControlService({ storeDir: ambiguousDir }).updateBoundFailureAlert(
      'external:ambiguous',
      FAILURE_ALERT,
    )).toMatchObject({ ok: false, errorCode: 'binding_conflict' })
    expect(jobLines(ambiguousDir)).toEqual(ambiguousBefore)

    const silentDir = tempDir()
    const silent = createControlService({ storeDir: silentDir })
    await silent.ensureBoundCommand({ ...COMMAND_SPEC, externalRef: 'external:silent', deliver: 'silent' })
    const silentBefore = jobLines(silentDir)
    expect(await silent.updateBoundFailureAlert('external:silent', FAILURE_ALERT)).toMatchObject({
      ok: false,
      errorCode: 'invalid_request',
    })
    expect(jobLines(silentDir)).toEqual(silentBefore)
  })

  it('leaves the prior definition authoritative when the policy append fails', async () => {
    const dir = tempDir()
    const service = createControlService({ storeDir: dir })
    const original = activeJob(await service.ensureBound(GATED_SPEC))
    const before = jobLines(dir)
    mkdirSync(join(dir, 'jobs.jsonl.tmp'))

    const response = await service.updateBoundFailureAlert(GATED_SPEC.externalRef, FAILURE_ALERT)

    expect(response).toMatchObject({
      ok: false,
      operation: 'update-bound-failure-alert',
      errorCode: 'persistence_uncertain',
    })
    expect(jobLines(dir)).toEqual(before)
    expect(activeJob(await service.getBound(GATED_SPEC.externalRef))).toEqual(original)
  })

  it('round-trips and idempotently preserves the narrow per-run command gate', async () => {
    const dir = tempDir()
    const service = createControlService({ storeDir: dir })

    const first = await service.ensureBound(GATED_SPEC)
    const second = await service.ensureBound(GATED_SPEC)
    const conflict = await service.ensureBound({
      ...GATED_SPEC,
      gate: { ...GATED_SPEC.gate!, command: { ...GATED_SPEC.gate!.command, timeoutSeconds: 181 } },
    })

    expect(activeJob(first)).toMatchObject({ gate: GATED_SPEC.gate, sessionMode: 'per_run' })
    expect(activeJob(second)).toEqual(activeJob(first))
    expect(conflict).toMatchObject({ ok: false, errorCode: 'binding_conflict' })
    expect(jobLines(dir).filter(line => (line as { op?: string }).op === 'create')).toHaveLength(1)
  })

  it('rejects malformed, unbounded, or business-specific gate shapes without writing', async () => {
    const dir = tempDir()
    const service = createControlService({ storeDir: dir })
    const invalid = [
      { ...GATED_SPEC, gate: { ...GATED_SPEC.gate, kind: 'business-specific-gate' } },
      { ...GATED_SPEC, gate: { kind: 'nonempty_stdout', command: { ...GATED_SPEC.gate!.command, argv: [] } } },
      { ...GATED_SPEC, gate: { kind: 'nonempty_stdout', command: { ...GATED_SPEC.gate!.command, timeoutSeconds: 0 } } },
    ]

    for (const spec of invalid) {
      expect(await service.ensureBound(spec as never)).toMatchObject({ ok: false, errorCode: 'invalid_request' })
    }
    expect(jobLines(dir)).toEqual([])
  })

  it('creates, reads, and idempotently preserves a manager-bound command job', async () => {
    const dir = tempDir()
    const service = createControlService({ storeDir: dir })

    const first = await service.ensureBoundCommand(COMMAND_SPEC)
    const second = await service.ensureBoundCommand(COMMAND_SPEC)
    const read = await service.getBoundCommand(COMMAND_SPEC.externalRef)

    expect(activeCommandJob(first)).toMatchObject({
      externalRef: COMMAND_SPEC.externalRef,
      command: COMMAND_SPEC.command,
      deliver: 'default',
    })
    expect(activeCommandJob(second)).toEqual(activeCommandJob(first))
    expect(activeCommandJob(read)).toEqual(activeCommandJob(first))
    expect(jobLines(dir).filter(line => (line as { op?: string }).op === 'create')).toHaveLength(1)
    expect(jobLines(dir)[0]).toMatchObject({ op: 'create', kind: 'command', command: COMMAND_SPEC.command })
  })

  it('round-trips per-job failureAlert for Agent and command bindings and treats policy changes as conflicts', async () => {
    const dir = tempDir()
    const service = createControlService({ storeDir: dir })

    const agent = await service.ensureBound(ALERT_SPEC)
    const command = await service.ensureBoundCommand(ALERT_COMMAND_SPEC)
    const sameAgent = await service.ensureBound(ALERT_SPEC)
    const sameAgentWithReorderedPolicy = await service.ensureBound({
      ...ALERT_SPEC,
      failureAlert: { cooldownMinutes: 30, after: 2 },
    })
    const agentConflict = await service.ensureBound({
      ...ALERT_SPEC,
      failureAlert: { ...FAILURE_ALERT, cooldownMinutes: 31 },
    })
    const commandConflict = await service.ensureBoundCommand({
      ...ALERT_COMMAND_SPEC,
      failureAlert: { ...FAILURE_ALERT, after: 3 },
    })

    expect(activeJob(agent)).toMatchObject({ failureAlert: FAILURE_ALERT, sessionMode: 'per_run' })
    expect(activeJob(sameAgent)).toEqual(activeJob(agent))
    expect(activeJob(sameAgentWithReorderedPolicy)).toEqual(activeJob(agent))
    expect(activeCommandJob(command)).toMatchObject({ failureAlert: FAILURE_ALERT, deliver: 'default' })
    expect(agentConflict).toMatchObject({ ok: false, errorCode: 'binding_conflict' })
    expect(commandConflict).toMatchObject({ ok: false, errorCode: 'binding_conflict' })
    expect(jobLines(dir).filter(line => (line as { op?: string }).op === 'create')).toHaveLength(2)
  })

  it('rejects malformed, unbounded, or silent failureAlert bindings without writing', async () => {
    const dir = tempDir()
    const service = createControlService({ storeDir: dir })
    const invalid = [
      { kind: 'agent', spec: { ...ALERT_SPEC, failureAlert: { after: 0, cooldownMinutes: 30 } } },
      { kind: 'agent', spec: { ...ALERT_SPEC, failureAlert: { after: 2, cooldownMinutes: 0 } } },
      { kind: 'command', spec: { ...ALERT_COMMAND_SPEC, failureAlert: { after: 101, cooldownMinutes: 30 } } },
      { kind: 'command', spec: { ...ALERT_COMMAND_SPEC, failureAlert: { after: 2, cooldownMinutes: 10_081 } } },
      { kind: 'command', spec: { ...ALERT_COMMAND_SPEC, deliver: 'silent' } },
    ] as const

    for (const entry of invalid) {
      const response = entry.kind === 'agent'
        ? await service.ensureBound(entry.spec as never)
        : await service.ensureBoundCommand(entry.spec as never)
      expect(response).toMatchObject({ ok: false, errorCode: 'invalid_request' })
    }
    expect(jobLines(dir)).toEqual([])
  })

  it('does not allow an agent and command binding to silently share an externalRef', async () => {
    const dir = tempDir()
    const service = createControlService({ storeDir: dir })
    await service.ensureBound(SPEC)
    const before = jobLines(dir)

    const conflict = await service.ensureBoundCommand({ ...COMMAND_SPEC, externalRef: SPEC.externalRef })

    expect(conflict).toMatchObject({ ok: false, errorCode: 'binding_conflict' })
    expect(jobLines(dir)).toEqual(before)
  })
  it('ensure-bound is idempotent for the same externalRef and spec', async () => {
    const dir = tempDir()
    const service = createControlService({ storeDir: dir })

    const first = await service.ensureBound(SPEC)
    const second = await service.ensureBound(SPEC)

    expect(activeJob(second)).toEqual(activeJob(first))
    expect(activeJob(second)).not.toHaveProperty('failureAlert')
    expect(jobLines(dir).filter(line => (line as { op?: string }).op === 'create')).toHaveLength(1)
  })

  it('ensure-bound conflicts without writing when the same ref has a different spec', async () => {
    const dir = tempDir()
    const service = createControlService({ storeDir: dir })
    await service.ensureBound(SPEC)
    const before = jobLines(dir)

    const conflict = await service.ensureBound(CONFLICTING_SPEC)

    expect(conflict).toMatchObject({ ok: false, errorCode: 'binding_conflict' })
    expect(jobLines(dir)).toEqual(before)
  })

  it('rejects invalid schedules for ensure and replace without writing', async () => {
    const dir = tempDir()
    const service = createControlService({ storeDir: dir })

    for (const invalidSpec of INVALID_SCHEDULE_SPECS) {
      const beforeEnsure = jobLines(dir)
      const ensure = await service.ensureBound(invalidSpec)
      expect(ensure).toMatchObject({ ok: false, errorCode: 'invalid_request' })
      expect(jobLines(dir)).toEqual(beforeEnsure)
    }

    await service.ensureBound(SPEC)
    const beforeReplace = jobLines(dir)
    for (const invalidSpec of INVALID_SCHEDULE_SPECS) {
      const replace = await service.replaceBound(invalidSpec)
      expect(replace).toMatchObject({ ok: false, errorCode: 'invalid_request' })
      expect(jobLines(dir)).toEqual(beforeReplace)
    }
  })

  it('replace-bound creates a new job id and removes the old active job', async () => {
    const dir = tempDir()
    const service = createControlService({ storeDir: dir })
    const oldJob = activeJob(await service.ensureBound(SPEC))

    const replacement = await service.replaceBound(CONFLICTING_SPEC)
    const newJob = activeJob(replacement)
    const current = (await service.getBound(SPEC.externalRef)) as ControlSuccessResponse

    expect(newJob.id).not.toBe(oldJob.id)
    expect(current.snapshot.activeJob?.id).toBe(newJob.id)
    expect(jobLines(dir)).toEqual(expect.arrayContaining([
      expect.objectContaining({ op: 'delete', id: oldJob.id }),
      expect.objectContaining({ op: 'create', id: newJob.id }),
    ]))
  })

  it('active binding survives service restart and ensure same spec still has one create', async () => {
    const dir = tempDir()
    const first = createControlService({ storeDir: dir })
    const created = await first.ensureBound(SPEC)
    const restarted = createControlService({ storeDir: dir })
    const again = await restarted.ensureBound(SPEC)

    expect(activeJob(again)).toEqual(activeJob(created))
    expect(jobLines(dir).filter(line => (line as { op?: string }).op === 'create')).toHaveLength(1)
  })

  it('delete-bound is idempotent and ensure after delete explicitly creates a new binding', async () => {
    const dir = tempDir()
    const service = createControlService({ storeDir: dir })
    await service.ensureBound(SPEC)

    const firstDelete = await service.deleteBound(SPEC.externalRef)
    const secondDelete = await service.deleteBound(SPEC.externalRef)
    const restarted = createControlService({ storeDir: dir })
    const afterRestart = await restarted.ensureBound(SPEC)

    expect(firstDelete).toMatchObject({ ok: true })
    expect(secondDelete).toMatchObject({ ok: true })
    expect(afterRestart).toMatchObject({ ok: true })
    expect(jobLines(dir).filter(line => (line as { op?: string }).op === 'create')).toHaveLength(2)
  })

  it('recovers a persisted create+delete before response by creating one replacement active job', async () => {
    const dir = tempDir()
    const jobs = new JsonlStore(join(dir, 'jobs.jsonl'))
    jobs.append({
      op: 'create',
      id: 'job-old',
      externalRef: SPEC.externalRef,
      sessionMode: 'per_run',
      schedule: SPEC.schedule,
      prompt: SPEC.prompt,
      deliver: SPEC.deliver,
      cwd: SPEC.cwd,
      createdAt: '2026-08-18T00:00:00.000Z',
    })
    jobs.append({ op: 'delete', id: 'job-old', deletedAt: '2026-08-18T00:01:00.000Z' })

    const service = createControlService({ storeDir: dir })
    const replacement = await service.replaceBound(CONFLICTING_SPEC)
    const retry = await service.ensureBound(CONFLICTING_SPEC)

    expect(activeJob(retry)).toEqual(activeJob(replacement))
    expect(jobLines(dir).filter(line => (line as { op?: string }).op === 'create')).toHaveLength(2)
    expect(jobLines(dir).filter(line => (line as { op?: string }).op === 'delete')).toHaveLength(1)
  })

  it('joins deleted job history by externalRef and returns latestRun from runs.jsonl', async () => {
    const dir = tempDir()
    const service = createControlService({ storeDir: dir })
    const created = (await service.ensureBound(SPEC)) as ControlSuccessResponse
    const jobId = created.snapshot.activeJob?.id ?? 'job-placeholder'
    await service.deleteBound(SPEC.externalRef)
    new JsonlStore(join(dir, 'runs.jsonl')).append({
      schemaVersion: 2,
      event: 'finish',
      runId: 'run-placeholder',
      jobId,
      sessionId: 'session-placeholder',
      scheduledFor: '2026-08-18T00:05:00.000Z',
      startedAt: '2026-08-18T00:05:00.000Z',
      finishedAt: '2026-08-18T00:05:01.000Z',
      status: 'success',
    })

    const snapshot = (await service.getBound(SPEC.externalRef)) as ControlSuccessResponse

    expect(snapshot.snapshot.externalRef).toBe(SPEC.externalRef)
    expect(snapshot.snapshot.activeJob).toBeNull()
    expect(snapshot.snapshot.latestRun).toMatchObject({ runId: 'run-placeholder' })
  })

  it('keeps failure-alert claim state out of the public latest-run snapshot', async () => {
    const dir = tempDir()
    const service = createControlService({ storeDir: dir })
    const created = (await service.ensureBound(ALERT_SPEC)) as ControlSuccessResponse
    const jobId = created.snapshot.activeJob!.id
    const runs = new JsonlStore(join(dir, 'runs.jsonl'))
    runs.append({
      schemaVersion: 2,
      event: 'finish',
      runId: 'run-error',
      jobId,
      sessionId: 'session-error',
      scheduledFor: '2026-08-20T00:00:00.000Z',
      startedAt: '2026-08-20T00:00:00.000Z',
      finishedAt: '2026-08-20T00:00:01.000Z',
      status: 'error',
      deliveryState: 'delivered',
      error: 'bounded execution error',
    })
    runs.append({
      schemaVersion: 2,
      event: 'failure-alert-claim',
      runId: 'run-error',
      jobId,
      claimedAt: '2026-08-20T00:00:02.000Z',
    })

    const response = (await service.getBound(ALERT_SPEC.externalRef)) as ControlSuccessResponse
    const latestRun = response.snapshot.latestRun!

    expect(latestRun).toMatchObject({ runId: 'run-error', runStatus: 'error', deliveryState: 'delivered' })
    expect(Object.keys(latestRun).sort()).toEqual([
      'deliveryState',
      'error',
      'finishedAt',
      'jobId',
      'runId',
      'runStatus',
      'scheduledFor',
    ].sort())
    expect(JSON.stringify(latestRun)).not.toContain('failure-alert')
    expect(JSON.stringify(latestRun)).not.toContain('claimedAt')
  })

  it('projects every active Agent and command job for whole-ledger release guards', async () => {
    const dir = tempDir()
    const service = createControlService({ storeDir: dir })
    const agent = activeJob(await service.ensureBound(GATED_SPEC))
    const command = activeCommandJob(await service.ensureBoundCommand(ALERT_COMMAND_SPEC))
    new JsonlStore(join(dir, 'jobs.jsonl')).append({
      op: 'create',
      id: 'unbound-agent',
      sessionMode: 'persistent',
      schedule: { kind: 'interval', minutes: 30 },
      prompt: 'unbound prompt',
      deliver: 'default',
      createdAt: '2026-08-28T00:00:00.000Z',
    })

    expect(inspectActiveJobs({ storeDir: dir })).toEqual(expect.arrayContaining([
      { kind: 'agent', ...agent },
      { kind: 'command', ...command },
      {
        kind: 'agent',
        id: 'unbound-agent',
        sessionMode: 'persistent',
        schedule: { kind: 'interval', minutes: 30 },
        prompt: 'unbound prompt',
        deliver: 'default',
        createdAt: '2026-08-28T00:00:00.000Z',
      },
    ]))
  })
})
