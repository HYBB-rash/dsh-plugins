/**
 * Test-first specs for the V2 run ledger (src/store.ts RunLedger).
 *
 * Written BEFORE the ledger implementation exists, per the V1.1 guide:
 * - the same runId claimed twice returns already_claimed without re-appending;
 * - a claim write failure throws (the run must not proceed);
 * - a once claim alone keeps the job settled after restart;
 * - a recurring claim alone supplies the crash-recovery nextRunAt;
 * - claim + finish adopt the finish's re-anchored nextRunAt;
 * - orphan claims surface as interrupted but stay settled (never re-dispatched);
 * - V1 terminal lines mixed with V2 events still recover;
 * - corrupt or unknown-version lines never break valid records.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RunLedger } from '../src/store.ts'
import type {
  RunClaimRecord,
  RunFailureAlertClaimRecord,
  RunFinishRecord,
  RunRecord,
} from '../src/types.ts'

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cron-ledger-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function rawLines(dir: string): string[] {
  return readFileSync(join(dir, 'runs.jsonl'), 'utf8').split('\n').filter(line => line.trim() !== '')
}

/** Seed a ledger file directly with raw JSONL content (no ledger API). */
function seed(dir: string, lines: unknown[]): void {
  writeFileSync(join(dir, 'runs.jsonl'), `${lines.map(line => JSON.stringify(line)).join('\n')}\n`, 'utf8')
}

const RUN_ID = 'cron-a@2026-08-14T10:00:00.000Z'

function claim(overrides: Partial<RunClaimRecord> = {}): RunClaimRecord {
  return {
    schemaVersion: 2,
    event: 'claim',
    runId: RUN_ID,
    jobId: 'cron-a',
    sessionId: 'session-cron-cron-a',
    scheduledFor: '2026-08-14T10:00:00.000Z',
    claimedAt: '2026-08-14T10:00:01.000Z',
    ...overrides,
  }
}

function finish(overrides: Partial<RunFinishRecord> = {}): RunFinishRecord {
  return {
    schemaVersion: 2,
    event: 'finish',
    runId: RUN_ID,
    jobId: 'cron-a',
    sessionId: 'session-cron-cron-a',
    scheduledFor: '2026-08-14T10:00:00.000Z',
    startedAt: '2026-08-14T10:00:02.000Z',
    finishedAt: '2026-08-14T10:00:20.000Z',
    status: 'success',
    ...overrides,
  }
}

function failureAlertClaim(
  overrides: Partial<RunFailureAlertClaimRecord> = {},
): RunFailureAlertClaimRecord {
  return {
    schemaVersion: 2,
    event: 'failure-alert-claim',
    runId: RUN_ID,
    jobId: 'cron-a',
    claimedAt: '2026-08-14T10:00:21.000Z',
    ...overrides,
  }
}

function v1Record(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    jobId: 'cron-a',
    sessionId: 'session-cron-cron-a',
    startedAt: '2026-08-14T09:00:00.000Z',
    finishedAt: '2026-08-14T09:00:10.000Z',
    status: 'success',
    ...overrides,
  }
}

describe('RunLedger.claim', () => {
  it('claims a fresh runId and appends exactly one line', () => {
    const dir = tempDir()
    const ledger = new RunLedger(dir)
    const record = claim()
    expect(ledger.claim(record)).toBe('claimed')
    expect(ledger.claim(record)).toBe('already_claimed')
    expect(rawLines(dir)).toHaveLength(1)
  })

  it('treats a finished runId as already claimed', () => {
    const dir = tempDir()
    const ledger = new RunLedger(dir)
    ledger.claim(claim())
    ledger.finish(finish())
    expect(ledger.claim(claim())).toBe('already_claimed')
  })

  it('throws when the claim append fails', () => {
    const dir = tempDir()
    const storePath = join(dir, 'blocked')
    writeFileSync(storePath, 'x', 'utf8')
    const ledger = new RunLedger(storePath)
    expect(() => ledger.claim(claim())).toThrow()
  })
})

describe('RunLedger.claimFailureAlert', () => {
  it('persists before the side effect, is idempotent by runId, and survives a new ledger instance', () => {
    const dir = tempDir()
    const record = failureAlertClaim()
    const ledger = new RunLedger(dir)

    expect(ledger.claimFailureAlert(record)).toBe('claimed')
    expect(ledger.claimFailureAlert(record)).toBe('already_claimed')

    const restarted = new RunLedger(dir)
    expect(restarted.foldJob('cron-a').failureAlertRunIds.has(RUN_ID)).toBe(true)
    expect(restarted.foldJob('cron-a').lastFailureAlertClaimedAt).toBe(record.claimedAt)
    expect(rawLines(dir)).toHaveLength(1)
  })

  it('throws on append failure so no untracked Telegram side effect is authorized', () => {
    const dir = tempDir()
    const blocked = join(dir, 'blocked')
    writeFileSync(blocked, 'x', 'utf8')
    const ledger = new RunLedger(blocked)

    expect(() => ledger.claimFailureAlert(failureAlertClaim())).toThrow()
  })
})

describe('RunLedger.foldJob', () => {
  it('once: a claim alone keeps the job settled with no next run', () => {
    const dir = tempDir()
    const ledger = new RunLedger(dir)
    ledger.claim(claim({ nextRunAt: undefined }))
    const folded = ledger.foldJob('cron-a')
    expect(folded.anyRecord).toBe(true)
    expect(folded.settledRunIds.has(RUN_ID)).toBe(true)
    expect(folded.nextRunAt).toBeUndefined()
    expect(folded.interrupted).toEqual([claim({ nextRunAt: undefined })])
  })

  it('recurring: a claim alone supplies the crash-recovery nextRunAt', () => {
    const dir = tempDir()
    const ledger = new RunLedger(dir)
    ledger.claim(claim({ nextRunAt: '2026-08-14T10:05:00.000Z' }))
    const folded = ledger.foldJob('cron-a')
    expect(folded.nextRunAt).toBe('2026-08-14T10:05:00.000Z')
  })

  it('claim + finish adopts the finish re-anchored nextRunAt', () => {
    const dir = tempDir()
    const ledger = new RunLedger(dir)
    ledger.claim(claim({ nextRunAt: '2026-08-14T10:05:00.000Z' }))
    ledger.finish(finish({ nextRunAt: '2026-08-14T10:05:20.000Z' }))
    const folded = ledger.foldJob('cron-a')
    expect(folded.nextRunAt).toBe('2026-08-14T10:05:20.000Z')
    expect(folded.interrupted).toEqual([])
    expect(folded.unsettledFinishes).toHaveLength(1)
    ledger.environmentSettled({
      schemaVersion: 2,
      event: 'environment-settle',
      jobId: 'cron-a',
      runId: RUN_ID,
      settledAt: '2026-08-14T10:05:21.000Z',
    })
    expect(ledger.foldJob('cron-a').unsettledFinishes).toEqual([])
  })

  it('surfaces an orphan claim as interrupted but keeps it settled', () => {
    const dir = tempDir()
    const ledger = new RunLedger(dir)
    ledger.claim(claim())
    const folded = ledger.foldJob('cron-a')
    expect(folded.interrupted).toHaveLength(1)
    expect(folded.interrupted[0]!.runId).toBe(RUN_ID)
    expect(folded.settledRunIds.has(RUN_ID)).toBe(true)
  })

  it('recovers when V1 terminal lines mix with V2 events', () => {
    const dir = tempDir()
    seed(dir, [v1Record({ finishedAt: '2026-08-14T09:00:10.000Z' }), claim({ nextRunAt: '2026-08-14T10:05:00.000Z' })])
    const ledger = new RunLedger(dir)
    const folded = ledger.foldJob('cron-a')
    expect(folded.legacyFinishedAt).toBe('2026-08-14T09:00:10.000Z')
    expect(folded.nextRunAt).toBe('2026-08-14T10:05:00.000Z')
    expect(folded.anyRecord).toBe(true)
  })

  it('ignores corrupt lines and unknown schema versions', () => {
    const dir = tempDir()
    seed(dir, [
      claim(),
      '{corrupt',
      { schemaVersion: 99, event: 'claim', jobId: 'cron-a', runId: 'x', scheduledFor: 't', claimedAt: 't', sessionId: 's' },
    ])
    const ledger = new RunLedger(dir)
    const folded = ledger.foldJob('cron-a')
    expect(folded.settledRunIds.has(RUN_ID)).toBe(true)
    expect(folded.interrupted).toHaveLength(1)
  })

  it('keeps per-job projections isolated', () => {
    const dir = tempDir()
    seed(dir, [
      claim({ jobId: 'cron-a', runId: 'cron-a@t', scheduledFor: '2026-08-14T10:00:00.000Z' }),
      claim({ jobId: 'cron-b', runId: 'cron-b@t', scheduledFor: '2026-08-14T11:00:00.000Z' }),
    ])
    const ledger = new RunLedger(dir)
    expect(ledger.foldJob('cron-a').anyRecord).toBe(true)
    expect(ledger.foldJob('cron-b').anyRecord).toBe(true)
    expect(ledger.foldJob('cron-c').anyRecord).toBe(false)
  })

  it('folds consecutive execution errors separately from delivery failures and success resets them', () => {
    const dir = tempDir()
    seed(dir, [
      finish({ runId: 'run-1', status: 'error', finishedAt: '2026-08-14T10:00:00.000Z' }),
      finish({ runId: 'run-2', status: 'error', finishedAt: '2026-08-14T10:01:00.000Z' }),
      finish({
        runId: 'run-3',
        status: 'success',
        deliveryState: 'failed',
        deliveryError: 'telegram rejected',
        finishedAt: '2026-08-14T10:02:00.000Z',
      }),
      finish({ runId: 'run-4', status: 'error', finishedAt: '2026-08-14T10:03:00.000Z' }),
      finish({ runId: 'run-5', status: 'interrupted', finishedAt: '2026-08-14T10:04:00.000Z' }),
      finish({ runId: 'run-6', status: 'expired', finishedAt: '2026-08-14T10:05:00.000Z' }),
    ])

    expect(new RunLedger(dir).foldJob('cron-a').consecutiveExecutionErrors).toBe(1)
  })

  it('uses the latest durable alert claim as cooldown state without settling the business run', () => {
    const dir = tempDir()
    seed(dir, [
      claim({ runId: 'run-active' }),
      failureAlertClaim({ runId: 'run-old', claimedAt: '2026-08-14T10:10:00.000Z' }),
      failureAlertClaim({ runId: 'run-new', claimedAt: '2026-08-14T10:20:00.000Z' }),
    ])

    const folded = new RunLedger(dir).foldJob('cron-a')
    expect(folded.lastFailureAlertClaimedAt).toBe('2026-08-14T10:20:00.000Z')
    expect(folded.failureAlertRunIds).toEqual(new Set(['run-old', 'run-new']))
    expect(folded.settledRunIds.has('run-old')).toBe(false)
    expect(folded.interrupted).toHaveLength(1)
  })

  it('does not let an alert-only event settle a one-shot or become a business-run record', () => {
    const dir = tempDir()
    seed(dir, [failureAlertClaim({ runId: 'alert-only' })])

    const folded = new RunLedger(dir).foldJob('cron-a')

    expect(folded.anyRecord).toBe(false)
    expect(folded.settledRunIds).toEqual(new Set())
    expect(folded.interrupted).toEqual([])
    expect(folded.failureAlertRunIds).toEqual(new Set(['alert-only']))
  })
})

describe('RunLedger V2 strict validation', () => {
  it('skips a finish with an unknown status', () => {
    const dir = tempDir()
    seed(dir, [claim(), finish({ status: 'bogus' })])
    const folded = new RunLedger(dir).foldJob('cron-a')
    // The valid claim stands; the bogus finish must not count as a finish.
    expect(folded.anyRecord).toBe(true)
    expect(folded.settledRunIds.has(RUN_ID)).toBe(true)
    expect(folded.interrupted).toHaveLength(1)
  })

  it('skips a claim with an invalid required time', () => {
    const dir = tempDir()
    seed(dir, [claim({ scheduledFor: 'not-a-date' })])
    const folded = new RunLedger(dir).foldJob('cron-a')
    expect(folded.anyRecord).toBe(false)
    expect(folded.settledRunIds.size).toBe(0)
    expect(folded.interrupted).toEqual([])
  })

  it('skips a finish with an invalid startedAt', () => {
    const dir = tempDir()
    seed(dir, [claim(), finish({ startedAt: 'not-a-date' })])
    const folded = new RunLedger(dir).foldJob('cron-a')
    expect(folded.interrupted).toHaveLength(1)
    expect(folded.nextRunAt).toBeUndefined()
  })

  it('skips a claim whose nextRunAt is not a valid time', () => {
    const dir = tempDir()
    seed(dir, [claim({ nextRunAt: 'not-a-date' })])
    const folded = new RunLedger(dir).foldJob('cron-a')
    expect(folded.anyRecord).toBe(false)
    expect(folded.nextRunAt).toBeUndefined()
  })

  it('a corrupt row never overrides the recovery anchor of valid rows', () => {
    const dir = tempDir()
    seed(dir, [
      claim({ nextRunAt: '2026-08-14T10:05:00.000Z' }),
      finish({ status: 'bogus', nextRunAt: '2026-08-14T23:00:00.000Z' }),
      finish({ nextRunAt: '2026-08-14T10:05:30.000Z' }),
    ])
    const folded = new RunLedger(dir).foldJob('cron-a')
    expect(folded.nextRunAt).toBe('2026-08-14T10:05:30.000Z')
    expect(folded.interrupted).toEqual([])
  })

  it('an invalid nextRunAt on a finish leaves the claim anchor standing', () => {
    const dir = tempDir()
    seed(dir, [
      claim({ nextRunAt: '2026-08-14T10:05:00.000Z' }),
      finish({ nextRunAt: 'not-a-date' }),
    ])
    const folded = new RunLedger(dir).foldJob('cron-a')
    expect(folded.nextRunAt).toBe('2026-08-14T10:05:00.000Z')
    expect(folded.interrupted).toHaveLength(1)
  })

  it('skips events with empty required identifiers', () => {
    const dir = tempDir()
    seed(dir, [
      claim({ runId: '' }),
      claim({ sessionId: '' }),
      failureAlertClaim({ runId: '' }),
      failureAlertClaim({ claimedAt: 'not-a-date' }),
    ])
    const folded = new RunLedger(dir).foldJob('cron-a')
    expect(folded.anyRecord).toBe(false)
  })

  it('keeps V1 compatibility untouched after strict V2 validation', () => {
    const dir = tempDir()
    seed(dir, [
      v1Record({ finishedAt: '2026-08-14T09:00:10.000Z' }),
      claim({ nextRunAt: '2026-08-14T10:05:00.000Z' }),
    ])
    const ledger = new RunLedger(dir)
    const folded = ledger.foldJob('cron-a')
    expect(folded.legacyFinishedAt).toBe('2026-08-14T09:00:10.000Z')
    expect(folded.nextRunAt).toBe('2026-08-14T10:05:00.000Z')
    expect(folded.anyRecord).toBe(true)
  })
})
