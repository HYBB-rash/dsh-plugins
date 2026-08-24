import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { encodeCanonicalJson } from './canonical-json.ts'
import { PersonalFeedScopeStoreError } from './errors.ts'
import type {
  CurrentContextResult,
  CurrentContextProjectionPeriodScopeEstablished,
  PeriodIdentity,
} from './types.ts'

export interface CurrentContextInputReceipt {
  readonly schemaVersion: 1
  readonly event: 'current_context_accepted'
  readonly period: PeriodIdentity
  readonly scope: CurrentContextProjectionPeriodScopeEstablished
  readonly branch: CurrentContextResult['kind']
  readonly digest: string
}

export interface CurrentContextInputStore {
  readonly findByPeriod: (period: PeriodIdentity) => CurrentContextInputReceipt | undefined
  readonly append: (receipt: CurrentContextInputReceipt) => void
}

export function createCurrentContextInputStore(path: string): CurrentContextInputStore {
  if (path.trim() === '') {
    throw new PersonalFeedScopeStoreError('personal Feed current context input ledger path must be non-empty')
  }

  return Object.freeze({
    findByPeriod: (period: PeriodIdentity) => readRecords(path)
      .find(record => samePeriod(record.period, period)),
    append: (receipt: CurrentContextInputReceipt) => {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      const records = readRecords(path)
      if (records.some(record => samePeriod(record.period, receipt.period))) {
        throw new PersonalFeedScopeStoreError(
          `personal Feed current context period ${receipt.period.period} is already persisted`,
        )
      }
      const next = `${records.map(record => JSON.stringify(record)).join('\n')}${records.length === 0 ? '' : '\n'}${JSON.stringify(receipt)}\n`
      const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`
      writeFileSync(temporaryPath, next, { encoding: 'utf8', mode: 0o600 })
      renameSync(temporaryPath, path)
    },
  })
}

export function currentContextInputReceiptFor(
  result: CurrentContextResult,
): CurrentContextInputReceipt | undefined {
  const canonicalResult = encodeCanonicalJson(result)
  if (canonicalResult === undefined) return undefined

  const inputPeriod = result.kind === 'available' ? result.context.period : result.value.period
  const inputScope = result.kind === 'available' ? result.context.scope : result.value.scope
  const period = minimalPeriodIdentity(inputPeriod)
  const scope = { period: minimalPeriodIdentity(inputScope.period) }
  return {
    schemaVersion: 1,
    event: 'current_context_accepted',
    period,
    scope,
    branch: result.kind,
    digest: createHash('sha256').update(canonicalResult).digest('hex'),
  }
}

function readRecords(path: string): readonly CurrentContextInputReceipt[] {
  if (!existsSync(path)) return []
  const text = readFileSync(path, 'utf8')
  if (text === '') return []
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines.map((line, index) => parseRecord(line, index + 1))
}

function parseRecord(line: string, lineNumber: number): CurrentContextInputReceipt {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch (cause) {
    throw new PersonalFeedScopeStoreError(
      `personal Feed current context input ledger line ${lineNumber} is not valid JSON`,
      { cause },
    )
  }
  if (!isRecord(value) || value.schemaVersion !== 1 || value.event !== 'current_context_accepted'
    || !hasExactlyKeys(value, ['schemaVersion', 'event', 'period', 'scope', 'branch', 'digest'])
    || !isPeriodIdentity(value.period) || !isContextScope(value.scope)
    || (value.branch !== 'available' && value.branch !== 'unavailable')
    || typeof value.digest !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.digest)) {
    throw new PersonalFeedScopeStoreError(
      `personal Feed current context input ledger line ${lineNumber} has an unsupported schema`,
    )
  }
  if (!samePeriod(value.period, value.scope.period)) {
    throw new PersonalFeedScopeStoreError(
      `personal Feed current context input ledger line ${lineNumber} has a conflicting scope period`,
    )
  }
  return deepFreeze(value as unknown as CurrentContextInputReceipt)
}

function minimalPeriodIdentity(period: PeriodIdentity): PeriodIdentity {
  return { run: period.run, period: period.period }
}

function samePeriod(left: PeriodIdentity, right: PeriodIdentity): boolean {
  return left.run === right.run && left.period === right.period
}

function isPeriodIdentity(value: unknown): value is PeriodIdentity {
  return isRecord(value)
    && hasExactlyKeys(value, ['run', 'period'])
    && typeof value.run === 'string'
    && typeof value.period === 'string'
}

function isContextScope(value: unknown): value is CurrentContextProjectionPeriodScopeEstablished {
  return isRecord(value) && hasExactlyKeys(value, ['period']) && isPeriodIdentity(value.period)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactlyKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index])
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  return value
}
