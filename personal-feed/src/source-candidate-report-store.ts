import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { PersonalFeedScopeStoreError } from './errors.ts'
import type {
  SourceCandidateReportAccepted,
  SourceCandidateReport,
} from './types.ts'

interface SourceCandidateReportLedgerRecord {
  readonly schemaVersion: 1
  readonly event: 'source_candidate_report_accepted'
  readonly accepted: SourceCandidateReportAccepted
}

export interface SourceCandidateReportStore {
  readonly findByScope: (scopeKey: string) => SourceCandidateReportAccepted | undefined
  readonly append: (accepted: SourceCandidateReportAccepted) => void
}

function readRecords(path: string): SourceCandidateReportLedgerRecord[] {
  if (!existsSync(path)) return []
  const text = readFileSync(path, 'utf8')
  if (text === '') return []
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines.map((line, index) => parseLine(line, index + 1))
}

function parseLine(line: string, lineNumber: number): SourceCandidateReportLedgerRecord {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch (cause) {
    throw new PersonalFeedScopeStoreError(
      `personal Feed source candidate report ledger line ${lineNumber} is not valid JSON`,
      { cause },
    )
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PersonalFeedScopeStoreError(
      `personal Feed source candidate report ledger line ${lineNumber} is not an object`,
    )
  }
  const record = value as Partial<SourceCandidateReportLedgerRecord>
  if (record.schemaVersion !== 1
    || record.event !== 'source_candidate_report_accepted'
    || typeof record.accepted?.report !== 'object'
    || record.accepted.report === null) {
    throw new PersonalFeedScopeStoreError(
      `personal Feed source candidate report ledger line ${lineNumber} has an unsupported schema`,
    )
  }
  return record as SourceCandidateReportLedgerRecord
}

export function sourceCandidateReportScopeKey(report: SourceCandidateReport): string {
  return [
    report.source,
    report.period.run,
    report.period.period,
    report.scope.scope.reportingWindow.window.window,
  ].join('\u0000')
}

export function createSourceCandidateReportStore(path: string): SourceCandidateReportStore {
  if (path.trim() === '') {
    throw new PersonalFeedScopeStoreError('personal Feed source candidate report ledger path must be non-empty')
  }

  return Object.freeze({
    findByScope: (scopeKey: string) => {
      const existing = readRecords(path).find(record => sourceCandidateReportScopeKey(record.accepted.report) === scopeKey)
      return existing?.accepted
    },
    append: (accepted: SourceCandidateReportAccepted) => {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      const records = readRecords(path)
      const key = sourceCandidateReportScopeKey(accepted.report)
      if (records.some(record => sourceCandidateReportScopeKey(record.accepted.report) === key)) {
        throw new PersonalFeedScopeStoreError(`source candidate report ${key} is already persisted`)
      }
      const nextRecord: SourceCandidateReportLedgerRecord = {
        schemaVersion: 1,
        event: 'source_candidate_report_accepted',
        accepted,
      }
      const next = `${records.map(record => JSON.stringify(record)).join('\n')}${records.length === 0 ? '' : '\n'}${JSON.stringify(nextRecord)}\n`
      const temporaryPath = `${path}.${process.pid}.tmp`
      writeFileSync(temporaryPath, next, { encoding: 'utf8', mode: 0o600 })
      renameSync(temporaryPath, path)
    },
  })
}
