import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  parseScheduleReanchorEvidence,
  readScheduleReanchorEvidence,
  runScheduleReanchorInspection,
} from '../scripts/inspect-cron-reanchor.mjs'

const evidence = {
  schemaVersion: 1,
  migrationVersion: 1,
  migrationId: 'dsh-cron-shanghai-reanchor-v1',
  fromTimeZone: 'Etc/UTC',
  toTimeZone: 'Asia/Shanghai',
  cutoverAt: '2026-08-30T00:00:00.000Z',
  reanchoredAt: '2026-08-30T00:00:01.000Z',
  inputSha256: 'a'.repeat(64),
  cronJobCount: 2,
  jobs: [
    { jobId: 'daily-0902', scheduleSha256: 'c'.repeat(64), nextRunAt: '2026-08-30T01:02:00.000Z' },
    { jobId: 'daily-0805', scheduleSha256: 'b'.repeat(64), nextRunAt: '2026-08-30T00:05:00.000Z' },
  ],
}

const normalized = {
  ...evidence,
  jobs: [evidence.jobs[1], evidence.jobs[0]],
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

test('strictly reads bounded evidence and calls only the read-only inspection port', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cron-inspection-gate-'))
  try {
    const evidencePath = join(root, 'accepted-evidence.json')
    const ledgerPath = join(root, 'runs.jsonl')
    writeFileSync(evidencePath, JSON.stringify(evidence))
    writeFileSync(ledgerPath, '{"private":"PRIVATE-LEDGER-BODY"}\n')
    const evidenceBefore = sha256(evidencePath)
    const ledgerBefore = sha256(ledgerPath)
    let inspected = 0
    const cron = {
      createMaintenanceControl({ storeDir }) {
        assert.equal(storeDir, root)
        return {
          reanchorCronSchedules() {
            throw new Error('write API must never be called')
          },
          inspectScheduleReanchorMigration(request) {
            inspected += 1
            return { ok: true, ...request, ledgerRecordCount: request.cronJobCount }
          },
        }
      },
    }

    const parsed = readScheduleReanchorEvidence(evidencePath)
    assert.deepEqual(parsed, normalized)
    const evidenceLink = join(root, 'accepted-evidence-link.json')
    symlinkSync(evidencePath, evidenceLink)
    assert.throws(() => readScheduleReanchorEvidence(evidenceLink), /unavailable/)
    const receipt = runScheduleReanchorInspection(cron, parsed, root)
    assert.equal(inspected, 1)
    assert.deepEqual(receipt, {
      status: 'verified',
      ...normalized,
      ledgerRecordCount: 2,
    })
    assert.equal(sha256(evidencePath), evidenceBefore)
    assert.equal(sha256(ledgerPath), ledgerBefore)
    assert.equal(JSON.stringify(receipt).includes('PRIVATE-LEDGER-BODY'), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects missing, extra, duplicate, and private-bearing evidence without echoing it', () => {
  const badValues = [
    { ...evidence, inputSha256: 'not-a-hash' },
    { ...evidence, privateBody: 'PRIVATE-EVIDENCE-BODY' },
    { ...evidence, cronJobCount: 1 },
    { ...evidence, jobs: [evidence.jobs[0], evidence.jobs[0]] },
    { ...evidence, jobs: [{ ...evidence.jobs[0], changed: false }, evidence.jobs[1]] },
  ]
  for (const value of badValues) {
    assert.throws(
      () => parseScheduleReanchorEvidence(JSON.stringify(value)),
      (error) => {
        assert.equal(String(error).includes('PRIVATE-EVIDENCE-BODY'), false)
        assert.match(String(error), /evidence/)
        return true
      },
    )
  }
  assert.throws(
    () => parseScheduleReanchorEvidence('{"private":"PRIVATE-BROKEN-JSON"'),
    (error) => {
      assert.equal(String(error).includes('PRIVATE-BROKEN-JSON'), false)
      return true
    },
  )
})

test('fails closed on an inspection error or a result that differs from accepted evidence', () => {
  assert.throws(
    () => runScheduleReanchorInspection({
      createMaintenanceControl: () => ({
        inspectScheduleReanchorMigration: () => ({
          ok: false,
          errorCode: 'migration_conflict',
          message: 'PRIVATE-LEDGER-BODY',
        }),
      }),
    }, normalized, '/fixture'),
    (error) => {
      assert.match(String(error), /migration_conflict/)
      assert.equal(String(error).includes('PRIVATE-LEDGER-BODY'), false)
      return true
    },
  )

  assert.throws(
    () => runScheduleReanchorInspection({
      createMaintenanceControl: () => ({
        inspectScheduleReanchorMigration: (request) => ({
          ok: true,
          ...request,
          inputSha256: 'f'.repeat(64),
          ledgerRecordCount: request.cronJobCount,
        }),
      }),
    }, normalized, '/fixture'),
    /differs from accepted evidence/,
  )
})
