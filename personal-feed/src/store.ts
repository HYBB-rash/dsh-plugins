import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { PersonalFeedScopeStoreError } from './errors.ts'
import type { PeriodScopeEstablished, RunRequestIdentity } from './types.ts'

export interface PeriodScopeStore {
  readonly findByRequest: (request: RunRequestIdentity) => PeriodScopeEstablished | undefined
  readonly list: () => readonly PeriodScopeEstablished[]
  readonly append: (record: PeriodScopeEstablished) => void
}

function parseLine(line: string, lineNumber: number): PeriodScopeEstablished {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch (cause) {
    throw new PersonalFeedScopeStoreError(
      `personal Feed scope ledger line ${lineNumber} is not valid JSON`,
      { cause },
    )
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PersonalFeedScopeStoreError(`personal Feed scope ledger line ${lineNumber} is not an object`)
  }
  const record = value as Partial<PeriodScopeEstablished>
  if (record.schemaVersion !== 1 || record.event !== 'period_scope_established') {
    throw new PersonalFeedScopeStoreError(`personal Feed scope ledger line ${lineNumber} has an unsupported schema`)
  }
  if (record.c01?.status !== 'accepted' || typeof record.c01.value?.request !== 'string') {
    throw new PersonalFeedScopeStoreError(`personal Feed scope ledger line ${lineNumber} has no accepted C01 identity`)
  }
  return value as PeriodScopeEstablished
}

function readRecords(path: string): PeriodScopeEstablished[] {
  if (!existsSync(path)) return []
  const text = readFileSync(path, 'utf8')
  if (text === '') return []
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines.map((line, index) => parseLine(line, index + 1))
}

/** Single-writer, append-only audit storage with atomic whole-file replacement. */
export function createPeriodScopeStore(path: string): PeriodScopeStore {
  if (path.trim() === '') throw new PersonalFeedScopeStoreError('personal Feed scope ledger path must be non-empty')

  return Object.freeze({
    list: () => readRecords(path),
    findByRequest: (request: RunRequestIdentity) => {
      return readRecords(path).find(record => record.c01.value.request === request)
    },
    append: (record: PeriodScopeEstablished) => {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      const records = readRecords(path)
      if (records.some(existing => existing.c01.value.request === record.c01.value.request)) {
        throw new PersonalFeedScopeStoreError(
          `personal Feed scope request ${record.c01.value.request} is already persisted`,
        )
      }
      const next = `${records.map(value => JSON.stringify(value)).join('\n')}${records.length === 0 ? '' : '\n'}${JSON.stringify(record)}\n`
      const temporaryPath = `${path}.${process.pid}.tmp`
      writeFileSync(temporaryPath, next, { encoding: 'utf8', mode: 0o600 })
      renameSync(temporaryPath, path)
    },
  })
}
