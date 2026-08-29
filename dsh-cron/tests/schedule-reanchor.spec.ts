import { appendFileSync, chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createMaintenanceControl,
  type InspectScheduleReanchorMigrationRequest,
  type ReanchorCronSchedulesSuccess,
} from '../src/index.ts'
import { JobStore, RunLedger } from '../src/store.ts'

const dirs: string[] = []
const originalTimeZone = process.env.TZ
const request = {
  migrationVersion: 1 as const,
  migrationId: 'dsh-cron:utc-to-shanghai:v1',
  fromTimeZone: 'Etc/UTC' as const,
  toTimeZone: 'Asia/Shanghai' as const,
  cutoverAt: '2026-08-30T00:00:00.000Z',
  reanchoredAt: '2026-08-30T00:00:01.000Z',
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cron-reanchor-'))
  dirs.push(dir)
  return dir
}

function seed(dir: string): JobStore {
  const store = new JobStore(dir)
  const createdAt = '2026-08-01T00:00:00.000Z'
  store.append({
    op: 'create', id: 'daily-0805', schedule: { kind: 'cron', expr: '5 8 * * *' },
    prompt: 'daily one', deliver: 'silent', createdAt,
  })
  store.append({
    op: 'create', kind: 'command', id: 'daily-0902', schedule: { kind: 'cron', expr: '2 9 * * *' },
    command: { argv: ['/bin/true'], timeoutSeconds: 1, outputMaxBytes: 1 },
    deliver: 'silent', createdAt,
  })
  store.append({
    op: 'create', id: 'interval', schedule: { kind: 'interval', minutes: 5 },
    prompt: 'interval', deliver: 'silent', createdAt,
  })
  store.append({
    op: 'create', id: 'once', schedule: { kind: 'once', runAt: '2026-09-01T00:00:00.000Z' },
    prompt: 'once', deliver: 'silent', createdAt,
  })
  return store
}

function inspectionEvidence(
  result: ReanchorCronSchedulesSuccess,
): InspectScheduleReanchorMigrationRequest {
  return {
    ...request,
    inputSha256: result.inputSha256,
    cronJobCount: result.cronJobCount,
    jobs: result.jobs.map(job => ({
      jobId: job.jobId,
      scheduleSha256: job.scheduleSha256,
      nextRunAt: job.nextRunAt,
    })),
  }
}

beforeEach(() => { process.env.TZ = 'Asia/Shanghai' })

afterEach(() => {
  vi.restoreAllMocks()
  if (originalTimeZone === undefined) delete process.env.TZ
  else process.env.TZ = originalTimeZone
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('offline schedule reanchor maintenance', () => {
  it('anchors only active cron schedules at Shanghai wall-clock occurrences', () => {
    const dir = tempDir()
    seed(dir)
    const result = createMaintenanceControl({ storeDir: dir }).reanchorCronSchedules(request)
    expect(result).toMatchObject({ ok: true, changed: true, cronJobCount: 2, appendedCount: 2 })
    if (!result.ok) return
    expect(result.jobs).toEqual([
      expect.objectContaining({ jobId: 'daily-0805', nextRunAt: '2026-08-30T00:05:00.000Z', changed: true }),
      expect.objectContaining({ jobId: 'daily-0902', nextRunAt: '2026-08-30T01:02:00.000Z', changed: true }),
    ])

    const ledger = new RunLedger(dir)
    const first = ledger.foldJob('daily-0805')
    expect(first.nextRunAt).toBe('2026-08-30T00:05:00.000Z')
    expect(first.anyRecord).toBe(false)
    expect(first.settledRunIds.size).toBe(0)
    expect(first.claims.size).toBe(0)
    expect(first.consecutiveExecutionErrors).toBe(0)
    expect(first.deliveryReceipts.size).toBe(0)
    expect(ledger.foldJob('interval').nextRunAt).toBeUndefined()
    expect(ledger.foldJob('once').nextRunAt).toBeUndefined()

    const rows = readFileSync(join(dir, 'runs.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    expect(rows).toHaveLength(2)
    expect(rows.every(row => row.event === 'schedule-reanchor')).toBe(true)
    expect(rows.every(row => row.runId === undefined && row.sessionId === undefined && row.status === undefined)).toBe(true)
  })

  it('is a byte-stable no-op for the exact migration and fails closed on drift', () => {
    const dir = tempDir()
    const jobs = seed(dir)
    const control = createMaintenanceControl({ storeDir: dir })
    expect(control.reanchorCronSchedules(request)).toMatchObject({ ok: true, changed: true })
    const afterFirst = readFileSync(join(dir, 'runs.jsonl'))
    expect(control.reanchorCronSchedules(request)).toMatchObject({ ok: true, changed: false, appendedCount: 0 })
    expect(readFileSync(join(dir, 'runs.jsonl'))).toEqual(afterFirst)

    expect(control.reanchorCronSchedules({ ...request, cutoverAt: '2026-08-31T00:00:00.000Z' }))
      .toMatchObject({ ok: false, errorCode: 'migration_conflict' })
    expect(readFileSync(join(dir, 'runs.jsonl'))).toEqual(afterFirst)

    jobs.append({
      op: 'create', id: 'daily-0805', schedule: { kind: 'cron', expr: '6 8 * * *' },
      prompt: 'daily one', deliver: 'silent', createdAt: '2026-08-01T00:00:00.000Z',
    })
    expect(control.reanchorCronSchedules(request)).toMatchObject({ ok: false, errorCode: 'migration_conflict' })
    expect(readFileSync(join(dir, 'runs.jsonl'))).toEqual(afterFirst)
  })

  it('strictly inspects accepted evidence without folding jobs or writing any ledger byte', () => {
    const dir = tempDir()
    seed(dir)
    const applied = createMaintenanceControl({ storeDir: dir }).reanchorCronSchedules(request)
    expect(applied).toMatchObject({ ok: true })
    if (!applied.ok) return
    const evidence = inspectionEvidence(applied)
    const ledgerPath = join(dir, 'runs.jsonl')
    const before = readFileSync(ledgerPath)
    chmodSync(ledgerPath, 0o444)
    const fold = vi.spyOn(JobStore.prototype, 'fold').mockImplementation(() => {
      throw new Error('inspection must not read current jobs')
    })
    const append = vi.spyOn(RunLedger.prototype, 'scheduleReanchor').mockImplementation(() => {
      throw new Error('inspection must not append schedule reanchor rows')
    })

    const inspected = createMaintenanceControl({ storeDir: dir })
      .inspectScheduleReanchorMigration(evidence)
    expect(inspected).toEqual({
      ok: true,
      ...evidence,
      jobs: [...evidence.jobs].sort((left, right) => left.jobId.localeCompare(right.jobId)),
      ledgerRecordCount: 2,
    })
    expect(fold).not.toHaveBeenCalled()
    expect(append).not.toHaveBeenCalled()
    expect(readFileSync(ledgerPath)).toEqual(before)
    expect(readdirSync(dir).sort()).toEqual(['jobs.jsonl', 'runs.jsonl'])
  })

  it('fails closed and stays byte-stable for absent, drifted, duplicate, or extra evidence', () => {
    const appliedDir = tempDir()
    seed(appliedDir)
    const control = createMaintenanceControl({ storeDir: appliedDir })
    const applied = control.reanchorCronSchedules(request)
    expect(applied).toMatchObject({ ok: true })
    if (!applied.ok) return
    const evidence = inspectionEvidence(applied)
    const ledgerPath = join(appliedDir, 'runs.jsonl')
    const before = readFileSync(ledgerPath)
    const firstJob = evidence.jobs[0]!

    const drifted: InspectScheduleReanchorMigrationRequest[] = [
      { ...evidence, inputSha256: '0'.repeat(64) },
      { ...evidence, cutoverAt: '2026-08-31T00:00:00.000Z' },
      { ...evidence, reanchoredAt: '2026-08-30T00:00:02.000Z' },
      { ...evidence, jobs: evidence.jobs.map((job, index) => index === 0
          ? { ...job, nextRunAt: '2026-08-30T00:06:00.000Z' }
          : job) },
      { ...evidence, cronJobCount: 1, jobs: [firstJob] },
      { ...evidence, cronJobCount: 2, jobs: [firstJob, firstJob] },
      { ...evidence, cronJobCount: 3, jobs: [...evidence.jobs, {
        jobId: 'extra-job', scheduleSha256: '1'.repeat(64), nextRunAt: '2026-08-30T02:00:00.000Z',
      }] },
    ]
    for (const candidate of drifted) {
      expect(control.inspectScheduleReanchorMigration(candidate))
        .toMatchObject({ ok: false })
      expect(readFileSync(ledgerPath)).toEqual(before)
    }

    const absentDir = tempDir()
    seed(absentDir)
    expect(createMaintenanceControl({ storeDir: absentDir })
      .inspectScheduleReanchorMigration(evidence))
      .toMatchObject({ ok: false, errorCode: 'migration_not_found' })
    expect(() => readFileSync(join(absentDir, 'runs.jsonl'))).toThrow()

    const firstRow = readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean)[0]!
    appendFileSync(ledgerPath, `${firstRow}\n`)
    const duplicated = readFileSync(ledgerPath)
    expect(control.inspectScheduleReanchorMigration(evidence))
      .toMatchObject({ ok: false, errorCode: 'migration_conflict' })
    expect(readFileSync(ledgerPath)).toEqual(duplicated)
  })

  it('fails closed when the same migration id has a different result or a malformed row', () => {
    const resultConflictDir = tempDir()
    seed(resultConflictDir)
    const resultControl = createMaintenanceControl({ storeDir: resultConflictDir })
    const first = resultControl.reanchorCronSchedules(request)
    expect(first).toMatchObject({ ok: true })
    if (!first.ok) return
    const firstRow = JSON.parse(readFileSync(join(resultConflictDir, 'runs.jsonl'), 'utf8').split('\n')[0]!)
    appendFileSync(join(resultConflictDir, 'runs.jsonl'), `${JSON.stringify({
      ...firstRow,
      nextRunAt: '2026-08-30T00:06:00.000Z',
    })}\n`)
    const beforeResultRetry = readFileSync(join(resultConflictDir, 'runs.jsonl'))
    expect(resultControl.reanchorCronSchedules(request))
      .toMatchObject({ ok: false, errorCode: 'migration_conflict' })
    expect(readFileSync(join(resultConflictDir, 'runs.jsonl'))).toEqual(beforeResultRetry)

    const malformedDir = tempDir()
    seed(malformedDir)
    appendFileSync(join(malformedDir, 'runs.jsonl'), `${JSON.stringify({
      schemaVersion: 2,
      event: 'schedule-reanchor',
      migrationVersion: 1,
      jobId: 'daily-0805',
      migrationId: request.migrationId,
      fromTimeZone: 'Etc/UTC',
      toTimeZone: 'Asia/Shanghai',
      cutoverAt: request.cutoverAt,
      reanchoredAt: request.reanchoredAt,
      inputSha256: 'not-a-sha256',
      scheduleSha256: '0'.repeat(64),
      nextRunAt: '2026-08-30T00:05:00.000Z',
    })}\n`)
    const beforeMalformedRetry = readFileSync(join(malformedDir, 'runs.jsonl'))
    expect(createMaintenanceControl({ storeDir: malformedDir }).reanchorCronSchedules(request))
      .toMatchObject({ ok: false, errorCode: 'migration_conflict' })
    expect(readFileSync(join(malformedDir, 'runs.jsonl'))).toEqual(beforeMalformedRetry)
  })

  it('lets a later normal claim and finish naturally replace the anchor', () => {
    const dir = tempDir()
    seed(dir)
    const control = createMaintenanceControl({ storeDir: dir })
    const applied = control.reanchorCronSchedules(request)
    expect(applied).toMatchObject({ ok: true })
    if (!applied.ok) return
    const evidence = inspectionEvidence(applied)
    const ledger = new RunLedger(dir)
    ledger.claim({
      schemaVersion: 2, event: 'claim', runId: 'daily-0805@2026-08-30T00:05:00.000Z',
      jobId: 'daily-0805', sessionId: 'session-cron-test',
      scheduledFor: '2026-08-30T00:05:00.000Z', claimedAt: '2026-08-30T00:05:01.000Z',
      nextRunAt: '2026-08-31T00:05:00.000Z',
    })
    expect(ledger.foldJob('daily-0805').nextRunAt).toBe('2026-08-31T00:05:00.000Z')
    ledger.finish({
      schemaVersion: 2, event: 'finish', runId: 'daily-0805@2026-08-30T00:05:00.000Z',
      jobId: 'daily-0805', sessionId: 'session-cron-test', scheduledFor: '2026-08-30T00:05:00.000Z',
      startedAt: '2026-08-30T00:05:01.000Z', finishedAt: '2026-08-30T00:06:00.000Z',
      status: 'success', deliveryState: 'silent', nextRunAt: '2026-09-01T00:05:00.000Z',
    })
    expect(ledger.foldJob('daily-0805').nextRunAt).toBe('2026-09-01T00:05:00.000Z')
    expect(control.inspectScheduleReanchorMigration(evidence))
      .toMatchObject({ ok: true, ledgerRecordCount: 2 })
  })

  it('refuses a non-Shanghai maintenance runtime before writing', () => {
    process.env.TZ = 'Etc/UTC'
    const dir = tempDir()
    seed(dir)
    expect(createMaintenanceControl({ storeDir: dir }).reanchorCronSchedules(request))
      .toMatchObject({ ok: false, errorCode: 'timezone_mismatch' })
    expect(() => readFileSync(join(dir, 'runs.jsonl'))).toThrow()
  })
})
