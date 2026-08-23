import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { PersonalFeedScopeStoreError } from './errors.ts'
import type { CandidateMaterial } from './types.ts'

interface EditingInputRecord {
  readonly schemaVersion: 1
  readonly event: 'editing_input_accepted'
  readonly material: CandidateMaterial
}

export interface EditingInputStore {
  readonly findByCandidate: (material: CandidateMaterial) => CandidateMaterial | undefined
  readonly list: () => readonly CandidateMaterial[]
  readonly append: (material: CandidateMaterial) => void
}

export function createEditingInputStore(path: string): EditingInputStore {
  if (path.trim() === '') {
    throw new PersonalFeedScopeStoreError('personal Feed editing input ledger path must be non-empty')
  }

  return Object.freeze({
    findByCandidate: (material: CandidateMaterial) => readRecords(path)
      .map(record => record.material)
      .find(existing => sameCandidatePeriod(existing, material)),
    list: () => readRecords(path).map(record => record.material),
    append: (material: CandidateMaterial) => {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      const records = readRecords(path)
      const nextRecord: EditingInputRecord = {
        schemaVersion: 1,
        event: 'editing_input_accepted',
        material: deepFreeze(structuredClone(material)),
      }
      const next = `${records.map(record => JSON.stringify(record)).join('\n')}${records.length === 0 ? '' : '\n'}${JSON.stringify(nextRecord)}\n`
      const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`
      writeFileSync(temporaryPath, next, { encoding: 'utf8', mode: 0o600 })
      renameSync(temporaryPath, path)
    },
  })
}

function readRecords(path: string): readonly EditingInputRecord[] {
  if (!existsSync(path)) return []
  const text = readFileSync(path, 'utf8')
  if (text === '') return []
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines.map((line, index) => parseRecord(line, index + 1))
}

function parseRecord(line: string, lineNumber: number): EditingInputRecord {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch (cause) {
    throw new PersonalFeedScopeStoreError(
      `personal Feed editing input ledger line ${lineNumber} is not valid JSON`,
      { cause },
    )
  }
  if (!isRecord(value) || value.schemaVersion !== 1 || value.event !== 'editing_input_accepted'
    || !isRecord(value.material)) {
    throw new PersonalFeedScopeStoreError(
      `personal Feed editing input ledger line ${lineNumber} has an unsupported schema`,
    )
  }
  return deepFreeze(value as unknown as EditingInputRecord)
}

function sameCandidatePeriod(left: CandidateMaterial, right: CandidateMaterial): boolean {
  return left.period.run === right.period.run
    && left.period.period === right.period.period
    && left.candidate.source === right.candidate.source
    && left.candidate.candidate === right.candidate.candidate
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  return value
}
