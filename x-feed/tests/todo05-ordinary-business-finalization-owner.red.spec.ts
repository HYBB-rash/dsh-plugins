import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createOrdinaryBusinessFinalizationOwner,
  type OrdinaryBusinessFinalizationOwner,
  type OrdinaryBusinessFinalizationOwnerOptions,
} from '../src/personal-feed/ordinary-business-finalization-owner.ts'
import type {
  BusinessFinalization,
  BusinessFinalizationReceiver,
  OrdinaryContentFinalized,
  PeriodIdentity,
  PeriodReference,
  RunIdentity,
} from '@herman/personal-feed'

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
    (<Value>() => Value extends Right ? 1 : 2) ? true : false
type Assert<Value extends true> = Value

type ContractAssertions = readonly [
  Assert<Equal<
    OrdinaryBusinessFinalizationOwnerOptions,
    { readonly ledgerPath: string }
  >>,
  Assert<Equal<
    Parameters<typeof createOrdinaryBusinessFinalizationOwner>[0],
    OrdinaryBusinessFinalizationOwnerOptions
  >>,
  Assert<Equal<
    OrdinaryBusinessFinalizationOwner,
    {
      readonly receiver: BusinessFinalizationReceiver
      readonly readAcceptedOrdinaryFinalization: (
        period: PeriodIdentity,
      ) => OrdinaryContentFinalized | undefined
    }
  >>,
]
const contractAssertions: ContractAssertions = [true, true, true]
void contractAssertions

const temporaryDirectories: string[] = []
const renameControl = vi.hoisted(() => ({ before: false, after: false }))

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    renameSync: (
      oldPath: Parameters<typeof actual.renameSync>[0],
      newPath: Parameters<typeof actual.renameSync>[1],
    ): void => {
      if (renameControl.before) {
        renameControl.before = false
        throw new Error('controlled owner rename-before failure')
      }
      actual.renameSync(oldPath, newPath)
      if (renameControl.after) {
        renameControl.after = false
        throw new Error('controlled owner rename-after acknowledgement loss')
      }
    },
  }
})

afterEach(() => {
  renameControl.before = false
  renameControl.after = false
  vi.restoreAllMocks()
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function period(suffix: string): PeriodIdentity {
  return {
    run: `todo05-c23-owner-run:${suffix}` as RunIdentity,
    period: `todo05-c23-owner-period:${suffix}` as PeriodReference,
  }
}

function createOwnerFixture(suffix: string) {
  const directory = mkdtempSync(join(tmpdir(), `x-feed-todo05-c23-owner-${suffix}-`))
  temporaryDirectories.push(directory)
  const ledgerPath = join(directory, 'ordinary-business-finalizations.jsonl')
  const finalization: OrdinaryContentFinalized = {
    kind: 'ordinary_content_finalized',
    period: period(suffix),
  }
  const owner = createOrdinaryBusinessFinalizationOwner({ ledgerPath })
  return { directory, ledgerPath, finalization, owner }
}

function readRecords(path: string): Record<string, unknown>[] {
  return readFileSync(path, 'utf8').trim().split('\n')
    .map(line => JSON.parse(line) as Record<string, unknown>)
}

function writeRecords(path: string, records: readonly Record<string, unknown>[]): void {
  writeFileSync(path, `${records.map(record => JSON.stringify(record)).join('\n')}\n`, 'utf8')
}

function snapshotDirectory(directory: string): readonly [string, Buffer][] {
  return readdirSync(directory).sort().map(name => [name, readFileSync(join(directory, name))])
}

function recordAt(records: readonly Record<string, unknown>[], index: number): Record<string, unknown> {
  const record = records[index]
  if (record === undefined) throw new Error(`owner record ${index + 1} is missing`)
  return record
}

function nestedRecord(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key]
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`owner ${key} is not an object`)
  }
  return value as Record<string, unknown>
}

describe('TODO 05 ordinary business finalization owner', () => {
  it('keeps the package-private owner contract exact and leaves a healthy empty store untouched', () => {
    const directory = mkdtempSync(join(tmpdir(), 'x-feed-todo05-c23-owner-skeleton-'))
    temporaryDirectories.push(directory)
    const ledgerPath = join(directory, 'ordinary-business-finalizations.jsonl')
    const owner = createOrdinaryBusinessFinalizationOwner({ ledgerPath })
    const input: OrdinaryContentFinalized = {
      kind: 'ordinary_content_finalized',
      period: period('skeleton'),
    }

    expect(Object.keys(owner).sort()).toEqual(['readAcceptedOrdinaryFinalization', 'receiver'])
    expect(Object.keys(owner.receiver)).toEqual(['acceptBusinessFinalization'])
    expect(Object.isFrozen(owner)).toBe(true)
    expect(Object.isFrozen(owner.receiver)).toBe(true)
    expect(owner.readAcceptedOrdinaryFinalization(input.period)).toBeUndefined()
    expect(owner.receiver.acceptBusinessFinalization({
      kind: 'normal_empty_period_finalized',
      period: input.period,
    })).toEqual({
      status: 'rejected',
      input: { kind: 'normal_empty_period_finalized', period: input.period },
    })
    expect(existsSync(ledgerPath)).toBe(false)
  })

  it('owns one durable ordinary C23 fact per period and replays it across rebuilds', () => {
    const directory = mkdtempSync(join(tmpdir(), 'x-feed-todo05-c23-owner-core-'))
    temporaryDirectories.push(directory)
    const ledgerPath = join(directory, 'ordinary-business-finalizations.jsonl')
    const first: OrdinaryContentFinalized = {
      kind: 'ordinary_content_finalized',
      period: period('first'),
    }
    const second: OrdinaryContentFinalized = {
      kind: 'ordinary_content_finalized',
      period: period('second'),
    }
    const owner = createOrdinaryBusinessFinalizationOwner({ ledgerPath })

    expect(owner.receiver.acceptBusinessFinalization(first)).toEqual({
      status: 'accepted', value: { period: first.period },
    })
    expect(owner.readAcceptedOrdinaryFinalization(first.period)).toEqual(first)
    expect(owner.readAcceptedOrdinaryFinalization(second.period)).toBeUndefined()
    expect(statSync(ledgerPath).mode & 0o777).toBe(0o600)
    const afterFirst = readFileSync(ledgerPath)

    expect(owner.receiver.acceptBusinessFinalization(first)).toEqual({
      status: 'accepted', value: { period: first.period },
    })
    expect(readFileSync(ledgerPath)).toEqual(afterFirst)

    const rebuilt = createOrdinaryBusinessFinalizationOwner({ ledgerPath })
    expect(rebuilt.receiver.acceptBusinessFinalization(first)).toEqual({
      status: 'accepted', value: { period: first.period },
    })
    expect(rebuilt.readAcceptedOrdinaryFinalization(first.period)).toEqual(first)
    expect(readFileSync(ledgerPath)).toEqual(afterFirst)

    expect(rebuilt.receiver.acceptBusinessFinalization(second)).toEqual({
      status: 'accepted', value: { period: second.period },
    })
    expect(rebuilt.readAcceptedOrdinaryFinalization(first.period)).toEqual(first)
    expect(rebuilt.readAcceptedOrdinaryFinalization(second.period)).toEqual(second)
    expect(readFileSync(ledgerPath, 'utf8').trim().split('\n')).toHaveLength(2)
  })

  it('rejects unsafe runtime inputs without executing accessors or creating an owner file', () => {
    const fixture = createOwnerFixture('unsafe-input')
    const getter = vi.fn(() => fixture.finalization.period)
    const throwingGetter = vi.fn((): PeriodIdentity => { throw new Error('input getter must not run') })
    const inherited = Object.assign(Object.create({ inherited: true }), fixture.finalization) as unknown
    const accessor = Object.defineProperties({}, {
      kind: { value: 'ordinary_content_finalized', enumerable: true },
      period: { get: getter, enumerable: true },
    })
    const throwingAccessor = Object.defineProperties({}, {
      kind: { value: 'ordinary_content_finalized', enumerable: true },
      period: { get: throwingGetter, enumerable: true },
    })
    const symbolExtra = { ...fixture.finalization } as Record<PropertyKey, unknown>
    symbolExtra[Symbol('extra')] = true
    const nonEnumerableExtra = { ...fixture.finalization }
    Object.defineProperty(nonEnumerableExtra, 'extra', { value: true })
    const inputs = [
      { ...fixture.finalization, extra: true },
      { kind: 'ordinary_content_finalized' },
      { ...fixture.finalization, period: { ...fixture.finalization.period, extra: true } },
      inherited,
      accessor,
      throwingAccessor,
      symbolExtra,
      nonEnumerableExtra,
    ] as const

    for (const input of inputs) {
      expect(fixture.owner.receiver.acceptBusinessFinalization(input as BusinessFinalization))
        .toEqual({ status: 'rejected', input })
    }

    expect(getter).not.toHaveBeenCalled()
    expect(throwingGetter).not.toHaveBeenCalled()
    expect(existsSync(fixture.ledgerPath)).toBe(false)
  })

  it('keeps accepted and durable values detached from later caller mutation', () => {
    const fixture = createOwnerFixture('caller-mutation')
    const originalPeriod = { ...fixture.finalization.period }
    const result = fixture.owner.receiver.acceptBusinessFinalization(fixture.finalization)
    expect(result.status).toBe('accepted')
    if (result.status !== 'accepted') throw new Error('owner did not accept its first fact')

    const mutablePeriod = fixture.finalization.period as { run: string; period: string }
    mutablePeriod.run = 'mutated-after-accept'

    expect(result.value).toEqual({ period: originalPeriod })
    expect(fixture.owner.readAcceptedOrdinaryFinalization(originalPeriod as PeriodIdentity)).toEqual({
      kind: 'ordinary_content_finalized',
      period: originalPeriod,
    })
    expect(Object.isFrozen(result.value)).toBe(true)
    expect(Object.isFrozen(result.value.period)).toBe(true)
  })

  it.each([
    ['top-level extra', (records: Record<string, unknown>[]) => { recordAt(records, 0).extra = true }],
    ['wrong event', (records: Record<string, unknown>[]) => { recordAt(records, 0).event = 'wrong' }],
    ['finalization extra', (records: Record<string, unknown>[]) => {
      nestedRecord(recordAt(records, 0), 'finalization').extra = true
    }],
    ['accepted extra', (records: Record<string, unknown>[]) => {
      nestedRecord(recordAt(records, 0), 'accepted').extra = true
    }],
    ['accepted period mismatch', (records: Record<string, unknown>[]) => {
      nestedRecord(nestedRecord(recordAt(records, 0), 'accepted'), 'period').run = 'wrong-run'
    }],
    ['duplicate exact physical row', (records: Record<string, unknown>[]) => {
      records.push(JSON.parse(JSON.stringify(recordAt(records, 0))) as Record<string, unknown>)
    }],
  ] as const)('fails every owner operation closed on %s corruption', (_label, mutate) => {
    const fixture = createOwnerFixture(`corrupt-${_label.replaceAll(' ', '-')}`)
    expect(fixture.owner.receiver.acceptBusinessFinalization(fixture.finalization)).toMatchObject({ status: 'accepted' })
    const records = readRecords(fixture.ledgerPath)
    mutate(records)
    writeRecords(fixture.ledgerPath, records)
    const before = snapshotDirectory(fixture.directory)

    expect(() => fixture.owner.readAcceptedOrdinaryFinalization(fixture.finalization.period)).toThrow()
    expect(fixture.owner.receiver.acceptBusinessFinalization(fixture.finalization)).toEqual({
      status: 'failed', input: fixture.finalization,
    })
    const newFinalization: OrdinaryContentFinalized = {
      kind: 'ordinary_content_finalized',
      period: period(`new-${_label}`),
    }
    expect(fixture.owner.receiver.acceptBusinessFinalization(newFinalization)).toEqual({
      status: 'failed', input: newFinalization,
    })
    expect(snapshotDirectory(fixture.directory)).toEqual(before)
  })

  it('cleans its temporary file on rename-before failure and remains retryable', () => {
    const fixture = createOwnerFixture('rename-before')
    renameControl.before = true

    expect(fixture.owner.receiver.acceptBusinessFinalization(fixture.finalization)).toEqual({
      status: 'failed', input: fixture.finalization,
    })
    expect(readdirSync(fixture.directory)).toEqual([])

    expect(fixture.owner.receiver.acceptBusinessFinalization(fixture.finalization)).toMatchObject({ status: 'accepted' })
    expect(readdirSync(fixture.directory)).toEqual(['ordinary-business-finalizations.jsonl'])
  })

  it('reads back an exact first owner when rename succeeds before acknowledgement is lost', () => {
    const fixture = createOwnerFixture('rename-after')
    renameControl.after = true

    expect(fixture.owner.receiver.acceptBusinessFinalization(fixture.finalization)).toEqual({
      status: 'accepted', value: { period: fixture.finalization.period },
    })
    expect(fixture.owner.readAcceptedOrdinaryFinalization(fixture.finalization.period)).toEqual(fixture.finalization)
    expect(readRecords(fixture.ledgerPath)).toHaveLength(1)
    expect(readdirSync(fixture.directory)).toEqual(['ordinary-business-finalizations.jsonl'])
  })

  it('distinguishes owner I/O failure from a healthy missing fact', () => {
    const directory = mkdtempSync(join(tmpdir(), 'x-feed-todo05-c23-owner-io-'))
    temporaryDirectories.push(directory)
    const finalization: OrdinaryContentFinalized = {
      kind: 'ordinary_content_finalized',
      period: period('io'),
    }
    const owner = createOrdinaryBusinessFinalizationOwner({ ledgerPath: directory })
    const before = readdirSync(directory)

    expect(() => owner.readAcceptedOrdinaryFinalization(finalization.period)).toThrow()
    expect(owner.receiver.acceptBusinessFinalization(finalization)).toEqual({
      status: 'failed', input: finalization,
    })
    expect(readdirSync(directory)).toEqual(before)
  })

  it('treats an existing empty owner file as corruption instead of overwriting it', () => {
    const fixture = createOwnerFixture('empty-file')
    writeFileSync(fixture.ledgerPath, '', { encoding: 'utf8', mode: 0o600 })
    const before = snapshotDirectory(fixture.directory)

    expect(() => fixture.owner.readAcceptedOrdinaryFinalization(fixture.finalization.period)).toThrow()
    expect(fixture.owner.receiver.acceptBusinessFinalization(fixture.finalization)).toEqual({
      status: 'failed', input: fixture.finalization,
    })
    expect(snapshotDirectory(fixture.directory)).toEqual(before)
  })

  it('rejects an empty ledger path before creating a runtime', () => {
    expect(() => createOrdinaryBusinessFinalizationOwner({ ledgerPath: '' })).toThrow()
  })
})
