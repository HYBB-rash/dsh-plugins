import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

type TelegramLocator = {
  readonly kind: 'telegram_inbound'
  readonly chatId: number
  readonly messageId: number
}

type CaptureInput = {
  readonly locator: TelegramLocator
  readonly rawText: string
  readonly reference: null
  readonly excludedRequestId?: string
}

type SourceRecord = {
  readonly locator: TelegramLocator
  readonly rawText: string
  readonly reference: null
  readonly excludedRequestId: string
  readonly occurredAt: string
  readonly sourceKey: string
  readonly captureSequence: number
}

type CoverageRecord = {
  readonly sourceKey: string
  readonly status: 'pending' | string
}

type CaptureResult = {
  readonly source: SourceRecord
  readonly coverage: CoverageRecord
}

type OwnerSnapshot = {
  readonly sources: readonly SourceRecord[]
  readonly coverage: readonly CoverageRecord[]
}

type PersonalContextOwner = {
  readonly capture: (input: CaptureInput) => CaptureResult
  readonly read: () => OwnerSnapshot
  readonly close: () => void
}

type ProductionModule = {
  readonly createPersonalContextOwner?: (options: {
    readonly databasePath: string
    readonly clock: { readonly now: () => Date }
  }) => PersonalContextOwner
}

const temporaryDirectories: string[] = []
const occurredAt = '2026-08-31T16:00:00.000Z'
const locator: TelegramLocator = { kind: 'telegram_inbound', chatId: 731, messageId: 19 }
const input: CaptureInput = {
  locator,
  rawText: 'Synthetic context fixture alpha; no personal fact.',
  reference: null,
  excludedRequestId: 'telegram:731:19',
}

async function production(): Promise<ProductionModule> {
  return await import('../src/index.ts') as ProductionModule
}

function makeDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'personal-feed-v2-context-source-'))
  temporaryDirectories.push(directory)
  return join(directory, 'state', 'personal-context.sqlite')
}

async function makeOwner(databasePath = makeDatabasePath()): Promise<{
  readonly databasePath: string
  readonly owner: PersonalContextOwner
}> {
  const module = await production()
  expect(typeof module.createPersonalContextOwner).toBe('function')
  if (typeof module.createPersonalContextOwner !== 'function') {
    throw new Error('createPersonalContextOwner is not available')
  }
  return {
    databasePath,
    owner: module.createPersonalContextOwner({
      databasePath,
      clock: { now: () => new Date(occurredAt) },
    }),
  }
}

async function expectFailure(action: () => unknown): Promise<void> {
  let failed = false
  try {
    const result = await action()
    if (typeof result === 'object' && result !== null && 'status' in result) {
      const status = (result as { readonly status?: unknown }).status
      failed = status === 'conflict' || status === 'rejected' || status === 'failed'
    }
  } catch {
    failed = true
  }
  expect(failed).toBe(true)
}

function sqliteApplicationTables(databasePath: string): string[] {
  const database = new DatabaseSync(databasePath)
  try {
    return (database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all() as Array<{ readonly name: string }>).map(row => row.name)
  } finally {
    database.close()
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('Personal Feed v2 source-neutral PersonalContextOwner', () => {
  it('exposes one real owner factory before any source behavior is used', async () => {
    const module = await production()
    expect(typeof module.createPersonalContextOwner).toBe('function')
  })

  it('durably captures one trusted Telegram source with pending coverage and owner metadata', async () => {
    const { databasePath, owner } = await makeOwner()

    const result = owner.capture(input)
    const snapshot = owner.read()

    expect(result.source.locator).toEqual(locator)
    expect(result.source.rawText).toBe(input.rawText)
    expect(result.source.reference).toBeNull()
    expect(result.source.excludedRequestId).toBe(input.excludedRequestId)
    expect(result.source.occurredAt).toBe(occurredAt)
    expect(result.source.captureSequence).toBeGreaterThan(0)
    expect(Number.isSafeInteger(result.source.captureSequence)).toBe(true)
    expect(result.source.sourceKey).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(result.coverage).toMatchObject({ sourceKey: result.source.sourceKey, status: 'pending' })
    expect(snapshot.sources).toHaveLength(1)
    expect(snapshot.coverage).toHaveLength(1)
    expect(snapshot.coverage[0]?.status).toBe('pending')
    expect(statSync(dirname(databasePath)).mode & 0o777).toBe(0o700)
    expect(statSync(databasePath).mode & 0o777).toBe(0o600)
  })

  it('replays an identical locator and raw text idempotently without a second source or coverage row', async () => {
    const { databasePath, owner } = await makeOwner()

    const first = owner.capture(input)
    const before = owner.read()
    const bytesBefore = readFileSync(databasePath)
    const second = owner.capture(input)

    expect(second).toEqual(first)
    expect(owner.read()).toEqual(before)
    expect(readFileSync(databasePath)).toEqual(bytesBefore)
    expect(owner.read().sources).toHaveLength(1)
    expect(owner.read().coverage).toHaveLength(1)
  })

  it('accepts a non-zero safe negative Telegram chat id', async () => {
    const { owner } = await makeOwner()
    const negativeChatIdInput = {
      ...input,
      locator: { kind: 'telegram_inbound', chatId: -731, messageId: 20 } as const,
      excludedRequestId: 'telegram:-731:20',
    }

    const result = owner.capture(negativeChatIdInput)

    expect(result.source.locator).toEqual(negativeChatIdInput.locator)
    expect(result.source.excludedRequestId).toBe('telegram:-731:20')
    expect(owner.read().sources).toHaveLength(1)
    expect(owner.read().coverage).toHaveLength(1)
  })

  it('rejects a same-locator different raw text without changing the durable source', async () => {
    const { databasePath, owner } = await makeOwner()

    owner.capture(input)
    const before = owner.read()
    const bytesBefore = readFileSync(databasePath)

    await expectFailure(() => owner.capture({
      ...input,
      rawText: 'Synthetic context fixture beta; deliberately conflicting raw text.',
    }))

    expect(owner.read()).toEqual(before)
    expect(readFileSync(databasePath)).toEqual(bytesBefore)
  })

  it.each([
    ['zero chat id', { kind: 'telegram_inbound', chatId: 0, messageId: 19 }],
    ['negative message id', { kind: 'telegram_inbound', chatId: 731, messageId: -1 }],
    ['fractional message id', { kind: 'telegram_inbound', chatId: 731, messageId: 1.5 }],
    ['non-numeric chat id', { kind: 'telegram_inbound', chatId: '731', messageId: 19 }],
    ['non-finite message id', { kind: 'telegram_inbound', chatId: 731, messageId: Number.NaN }],
    ['unsafe chat id', { kind: 'telegram_inbound', chatId: Number.MAX_SAFE_INTEGER + 1, messageId: 19 }],
    ['unsafe negative chat id', { kind: 'telegram_inbound', chatId: Number.MIN_SAFE_INTEGER - 1, messageId: 19 }],
    ['unsafe message id', { kind: 'telegram_inbound', chatId: 731, messageId: Number.MAX_SAFE_INTEGER + 1 }],
    ['wrong locator kind', { kind: 'telegram', chatId: 731, messageId: 19 }],
    ['missing locator kind', { chatId: 731, messageId: 19 }],
    ['extra locator key', { kind: 'telegram_inbound', chatId: 731, messageId: 19, extra: 'forged' }],
  ] as const)('rejects %s without adding coverage', async (_name, badLocator) => {
    const { owner } = await makeOwner()

    await expectFailure(() => owner.capture({ ...input, locator: badLocator as TelegramLocator }))

    expect(owner.read().sources).toHaveLength(0)
    expect(owner.read().coverage).toHaveLength(0)
  })

  it.each([
    ['empty raw text', { rawText: '' }],
    ['whitespace-only raw text', { rawText: '   \n\t' }],
    ['forged source key', { sourceKey: 'sha256:forged' }],
    ['forged occurred-at', { occurredAt: '2000-01-01T00:00:00.000Z' }],
    ['forged capture sequence', { captureSequence: 999 }],
    ['mismatched excluded request id', { excludedRequestId: 'telegram:731:20' }],
    ['empty excluded request id', { excludedRequestId: '' }],
    ['forged excluded request id', { excludedRequestId: 'not-a-telegram-locator' }],
  ] as const)('rejects %s at the runtime boundary without adding coverage', async (_name, extra) => {
    const { owner } = await makeOwner()

    await expectFailure(() => owner.capture({ ...input, ...extra } as CaptureInput))

    expect(owner.read().sources).toHaveLength(0)
    expect(owner.read().coverage).toHaveLength(0)
  })

  it('reopens the same database and reads the same pending source instead of treating it as empty or terminal', async () => {
    const databasePath = makeDatabasePath()
    const firstOwner = (await makeOwner(databasePath)).owner
    const first = firstOwner.capture(input)
    const expected = firstOwner.read()
    firstOwner.close()

    const reopened = (await makeOwner(databasePath)).owner
    expect(reopened.read()).toEqual(expected)
    expect(reopened.read().sources[0]).toEqual(first.source)
    expect(reopened.read().sources[0]?.reference).toBeNull()
    expect(reopened.read().sources[0]?.excludedRequestId).toBe('telegram:731:19')
    expect(reopened.read().coverage).toEqual([{ sourceKey: first.source.sourceKey, status: 'pending' }])
    expect(reopened.read().coverage.every(row => row.status !== 'terminal')).toBe(true)
  })

  it('fails closed on a damaged SQLite schema instead of reading empty or terminal state', async () => {
    const databasePath = makeDatabasePath()
    const owner = (await makeOwner(databasePath)).owner
    owner.capture(input)
    owner.close()

    const [table] = sqliteApplicationTables(databasePath)
    expect(table).toBeDefined()
    if (table === undefined) throw new Error('capture did not create a durable application table')
    const database = new DatabaseSync(databasePath)
    try {
      database.exec(`DROP TABLE "${table.replaceAll('"', '""')}"`)
    } finally {
      database.close()
    }

    const module = await production()
    expect(() => {
      if (typeof module.createPersonalContextOwner !== 'function') {
        throw new Error('createPersonalContextOwner is not available')
      }
      module.createPersonalContextOwner({
        databasePath,
        clock: { now: () => new Date(occurredAt) },
      })
    }).toThrow()
  })
})
