import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type {
  BusinessFinalization,
  BusinessFinalizationReceiver,
  C23Result,
  OrdinaryContentFinalized,
  PeriodIdentity,
} from '@herman/personal-feed'

type OrdinaryBusinessFinalizationOwnerRecord = {
  readonly schemaVersion: 1
  readonly event: 'ordinary_business_finalization_accepted'
  readonly finalization: OrdinaryContentFinalized
  readonly accepted: { readonly period: PeriodIdentity }
}

export type OrdinaryBusinessFinalizationOwnerOptions = {
  readonly ledgerPath: string
}

export type OrdinaryBusinessFinalizationOwner = {
  readonly receiver: BusinessFinalizationReceiver
  readonly readAcceptedOrdinaryFinalization: (
    period: PeriodIdentity,
  ) => OrdinaryContentFinalized | undefined
}

export function createOrdinaryBusinessFinalizationOwner(
  options: OrdinaryBusinessFinalizationOwnerOptions,
): OrdinaryBusinessFinalizationOwner {
  if (options.ledgerPath.trim() === '') {
    throw new Error('ordinary business finalization ledger path must be non-empty')
  }
  const receiver: BusinessFinalizationReceiver = Object.freeze({
    acceptBusinessFinalization: (finalization: BusinessFinalization): C23Result => {
      const durableFinalization = projectOrdinaryFinalization(finalization)
      if (durableFinalization === undefined) return { status: 'rejected', input: finalization }
      let records: readonly OrdinaryBusinessFinalizationOwnerRecord[]
      try {
        records = readRecords(options.ledgerPath)
      } catch {
        return { status: 'failed', input: finalization }
      }
      const existing = records.find(record => samePeriod(record.finalization.period, durableFinalization.period))
      if (existing !== undefined) {
        return sameFinalization(existing.finalization, durableFinalization)
          ? { status: 'accepted', value: existing.accepted }
          : { status: 'rejected', input: finalization }
      }
      const next: OrdinaryBusinessFinalizationOwnerRecord = Object.freeze({
        schemaVersion: 1,
        event: 'ordinary_business_finalization_accepted',
        finalization: durableFinalization,
        accepted: Object.freeze({ period: durableFinalization.period }),
      })
      const expected = [...records, next]
      try {
        writeRecords(options.ledgerPath, expected)
      } catch {
        try {
          if (!sameRecords(readRecords(options.ledgerPath), expected)) {
            return { status: 'failed', input: finalization }
          }
        } catch {
          return { status: 'failed', input: finalization }
        }
      }
      return { status: 'accepted', value: next.accepted }
    },
  })

  return Object.freeze({
    receiver,
    readAcceptedOrdinaryFinalization: (period: PeriodIdentity): OrdinaryContentFinalized | undefined => {
      const durablePeriod = projectPeriod(period)
      if (durablePeriod === undefined) throw new Error('ordinary business finalization period is invalid')
      return readRecords(options.ledgerPath)
        .find(record => samePeriod(record.finalization.period, durablePeriod))?.finalization
    },
  })
}

function readRecords(path: string): readonly OrdinaryBusinessFinalizationOwnerRecord[] {
  if (!existsSync(path)) return []
  const text = readFileSync(path, 'utf8')
  if (text === '') throw new Error('ordinary business finalization ledger is unexpectedly empty')
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  const records = lines.map((line, index) => parseRecord(JSON.parse(line) as unknown, index + 1))
  for (const [index, record] of records.entries()) {
    if (records.slice(index + 1).some(other => samePeriod(other.finalization.period, record.finalization.period))) {
      throw new Error('ordinary business finalization ledger has more than one owner for a period')
    }
  }
  return records
}

function parseRecord(value: unknown, lineNumber: number): OrdinaryBusinessFinalizationOwnerRecord {
  const record = plainRecord(value, ['schemaVersion', 'event', 'finalization', 'accepted'])
  const finalization = projectOrdinaryFinalization(record?.get('finalization'))
  const accepted = projectAccepted(record?.get('accepted'))
  if (record === undefined
    || record.get('schemaVersion') !== 1
    || record.get('event') !== 'ordinary_business_finalization_accepted'
    || finalization === undefined
    || accepted === undefined
    || !samePeriod(finalization.period, accepted.period)) {
    throw new Error(`ordinary business finalization ledger line ${lineNumber} is invalid`)
  }
  return Object.freeze({
    schemaVersion: 1,
    event: 'ordinary_business_finalization_accepted',
    finalization,
    accepted,
  })
}

function projectAccepted(value: unknown): { readonly period: PeriodIdentity } | undefined {
  const record = plainRecord(value, ['period'])
  const period = projectPeriod(record?.get('period'))
  return record === undefined || period === undefined
    ? undefined
    : Object.freeze({ period })
}

function writeRecords(
  path: string,
  records: readonly OrdinaryBusinessFinalizationOwnerRecord[],
): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`
  try {
    writeFileSync(temporaryPath, `${records.map(record => JSON.stringify(record)).join('\n')}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    })
    renameSync(temporaryPath, path)
  } finally {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath)
  }
}

function sameRecords(
  left: readonly OrdinaryBusinessFinalizationOwnerRecord[],
  right: readonly OrdinaryBusinessFinalizationOwnerRecord[],
): boolean {
  return left.length === right.length
    && left.every((record, index) => {
      const other = right[index]
      return other !== undefined && sameFinalization(record.finalization, other.finalization)
        && samePeriod(record.accepted.period, other.accepted.period)
    })
}

function sameFinalization(left: OrdinaryContentFinalized, right: OrdinaryContentFinalized): boolean {
  return left.kind === right.kind && samePeriod(left.period, right.period)
}

function samePeriod(left: PeriodIdentity, right: PeriodIdentity): boolean {
  return left.run === right.run && left.period === right.period
}

function projectOrdinaryFinalization(value: unknown): OrdinaryContentFinalized | undefined {
  const record = plainRecord(value, ['kind', 'period'])
  const period = projectPeriod(record?.get('period'))
  return record === undefined
    || record.get('kind') !== 'ordinary_content_finalized'
    || period === undefined
    ? undefined
    : Object.freeze({ kind: 'ordinary_content_finalized', period })
}

function projectPeriod(value: unknown): PeriodIdentity | undefined {
  const record = plainRecord(value, ['run', 'period'])
  const run = record?.get('run')
  const period = record?.get('period')
  return typeof run !== 'string' || typeof period !== 'string'
    ? undefined
    : Object.freeze({ run, period }) as PeriodIdentity
}

function plainRecord(
  value: unknown,
  expected: readonly string[],
): ReadonlyMap<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  let prototype: object | null
  let keys: readonly PropertyKey[]
  try {
    prototype = Object.getPrototypeOf(value) as object | null
    keys = Reflect.ownKeys(value)
  } catch {
    return undefined
  }
  if (prototype !== Object.prototype && prototype !== null) return undefined
  const sortedExpected = [...expected].sort()
  const actual = keys.filter((key): key is string => typeof key === 'string').sort()
  if (actual.length !== keys.length
    || actual.length !== sortedExpected.length
    || !actual.every((key, index) => key === sortedExpected[index])) return undefined
  const result = new Map<string, unknown>()
  for (const key of actual) {
    let descriptor: PropertyDescriptor | undefined
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key)
    } catch {
      return undefined
    }
    if (descriptor === undefined || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      return undefined
    }
    result.set(key, descriptor.value)
  }
  return result
}
