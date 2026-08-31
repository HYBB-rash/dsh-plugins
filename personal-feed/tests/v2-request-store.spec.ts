import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createPersonalFeedV2RequestCoordinator } from '../src/index.ts'

interface Calls {
  r4: number
  r2: number
  r3: number
  r5: number
}

interface Receipt {
  readonly chatId: number
  readonly triggerMessageId: number
  readonly visibleText: string
  readonly messageIds: readonly [number]
}

interface PreparedResult {
  readonly kind: 'prepared'
  readonly request: { readonly requestId: string }
  readonly outcome: { readonly finalText: string; readonly digest: string }
  readonly settle: (receipt: Receipt) => void
}

function makePorts() {
  const calls: Calls = { r4: 0, r2: 0, r3: 0, r5: 0 }
  const ports = Object.freeze({
    r4: {
      snapshot: async (_input: unknown): Promise<unknown> => {
        calls.r4 += 1
        return Object.freeze({
          kind: 'sufficient',
          snapshot: Object.freeze({ source: 'r4', captured: true }),
        })
      },
    },
    r2: {
      observe: async (_input: unknown): Promise<unknown> => {
        calls.r2 += 1
        return Object.freeze({
          kind: 'complete',
          window: Object.freeze({ source: 'r2', complete: true }),
        })
      },
    },
    r3: {
      admit: async (_input: unknown): Promise<unknown> => {
        calls.r3 += 1
        return Object.freeze({
          kind: 'admitted',
          candidates: Object.freeze([{ source: 'r3', candidate: 'one' }]),
        })
      },
    },
    r5: {
      judge: async (_input: unknown): Promise<unknown> => {
        calls.r5 += 1
        return Object.freeze({ kind: 'none' })
      },
    },
  })
  return { calls, ports }
}

function makeCoordinator(directory: string) {
  const ledgerPath = join(directory, 'ledger', 'requests.jsonl')
  const fake = makePorts()
  const coordinator = createPersonalFeedV2RequestCoordinator({
    ledgerPath,
    clock: { now: () => new Date('2026-08-31T15:59:59.000Z') },
    r4: fake.ports.r4,
    r2: fake.ports.r2,
    r3: fake.ports.r3,
    r5: fake.ports.r5,
  })
  return { coordinator, ledgerPath, calls: fake.calls }
}

function signal(): AbortSignal {
  return new AbortController().signal
}

function rewriteJsonString(line: string, key: string, replacement: string): string {
  const escaped = JSON.stringify(replacement)
  const pattern = new RegExp(`(\\"${key}\\"\\s*:\\s*)\\"(?:\\\\.|[^\\"\\\\])*\\"`)
  const rewritten = line.replace(pattern, `$1${escaped}`)
  if (rewritten === line) throw new Error(`fixture did not contain JSON string key ${key}`)
  return rewritten
}

function lastLedgerLine(path: string): string {
  const lines = readFileSync(path, 'utf8').trim().split('\n')
  const line = lines.at(-1)
  if (line === undefined || line === '') throw new Error('fixture ledger did not contain a record')
  return line
}

function replaceLedgerLine(path: string, lineNumber: number, replacement: string): void {
  const lines = readFileSync(path, 'utf8').trim().split('\n')
  if (lines[lineNumber] === undefined) throw new Error(`fixture ledger line ${lineNumber + 1} is missing`)
  lines[lineNumber] = replacement
  writeFileSync(path, `${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 })
}

async function seedTerminal(directory: string) {
  const fixture = makeCoordinator(directory)
  const prepared = await fixture.coordinator.prepare({ chatId: 42, messageId: 5, signal: signal() }) as PreparedResult
  prepared.settle({
    chatId: 42,
    triggerMessageId: 5,
    visibleText: prepared.outcome.finalText,
    messageIds: [9001],
  })
  return fixture
}

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('Personal Feed v2 request ledger', () => {
  it('creates a 0700 ledger directory and a 0600 ledger file', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'personal-feed-v2-store-mode-'))
    temporaryDirectories.push(directory)
    const { coordinator, ledgerPath } = makeCoordinator(directory)

    await coordinator.prepare({ chatId: 42, messageId: 5, signal: signal() })
    expect(statSync(join(directory, 'ledger')).mode & 0o777).toBe(0o700)
    expect(statSync(ledgerPath).mode & 0o777).toBe(0o600)
  })

  it.each([
    ['bad JSON', '{not-json\n'],
    ['unknown schema', JSON.stringify({ schemaVersion: 999, event: 'request_opened', requestId: 'telegram:42:5' }) + '\n'],
  ] as const)('fails closed on %s instead of treating the ledger as empty', async (_name, contents) => {
    const directory = mkdtempSync(join(tmpdir(), 'personal-feed-v2-store-corrupt-'))
    temporaryDirectories.push(directory)
    const fixture = makeCoordinator(directory)
    const ledgerDirectory = join(directory, 'ledger')
    // The directory/file are deliberately created as a user-owned ledger fixture.
    mkdirSync(ledgerDirectory, { recursive: true, mode: 0o700 })
    writeFileSync(fixture.ledgerPath, contents, { encoding: 'utf8', mode: 0o600 })
    chmodSync(ledgerDirectory, 0o700)

    expect(() => fixture.coordinator.read('telegram:42:5')).toThrow()
    await expect(fixture.coordinator.prepare({ chatId: 42, messageId: 5, signal: signal() })).rejects.toThrow()
    expect(fixture.calls).toEqual({ r4: 0, r2: 0, r3: 0, r5: 0 })
  })

  it('fails closed on a valid record carrying an unknown extra key', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'personal-feed-v2-store-extra-'))
    temporaryDirectories.push(directory)
    const fixture = await seedTerminal(directory)
    const lines = readFileSync(fixture.ledgerPath, 'utf8').trim().split('\n')
    const original = JSON.parse(lines[0] ?? '') as Record<string, unknown>
    original.extra = 'not part of the schema'
    replaceLedgerLine(fixture.ledgerPath, 0, JSON.stringify(original))

    const reopened = makeCoordinator(directory)
    expect(() => reopened.coordinator.read('telegram:42:5')).toThrow()
    await expect(reopened.coordinator.prepare({ chatId: 42, messageId: 5, signal: signal() })).rejects.toThrow()
    expect(reopened.calls).toEqual({ r4: 0, r2: 0, r3: 0, r5: 0 })
  })

  it('fails closed on a conflicting duplicate request record and never replaces it with an empty outcome', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'personal-feed-v2-store-request-conflict-'))
    temporaryDirectories.push(directory)
    const fixture = await seedTerminal(directory)
    const original = readFileSync(fixture.ledgerPath, 'utf8').trim().split('\n')[0]
    if (original === undefined) throw new Error('fixture ledger did not contain a request record')
    const conflicting = rewriteJsonString(original, 'cutoff', '2026-09-01T16:01:00.000Z')
    appendFileSync(fixture.ledgerPath, `${conflicting}\n`, { encoding: 'utf8' })

    const reopened = makeCoordinator(directory)
    expect(() => reopened.coordinator.read('telegram:42:5')).toThrow()
    await expect(reopened.coordinator.prepare({ chatId: 42, messageId: 5, signal: signal() })).rejects.toThrow()
    expect(reopened.calls).toEqual({ r4: 0, r2: 0, r3: 0, r5: 0 })
  })

  it('fails closed on a conflicting duplicate terminal receipt and preserves the original terminal', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'personal-feed-v2-store-terminal-conflict-'))
    temporaryDirectories.push(directory)
    const fixture = await seedTerminal(directory)
    const original = lastLedgerLine(fixture.ledgerPath)
    const conflicting = rewriteJsonString(original, 'visibleText', 'conflicting terminal text')
    appendFileSync(fixture.ledgerPath, `${conflicting}\n`, { encoding: 'utf8' })

    const reopened = makeCoordinator(directory)
    expect(() => reopened.coordinator.read('telegram:42:5')).toThrow()
    await expect(reopened.coordinator.prepare({ chatId: 42, messageId: 5, signal: signal() })).rejects.toThrow()
    expect(reopened.calls).toEqual({ r4: 0, r2: 0, r3: 0, r5: 0 })
  })

  it('persists delivered_terminal outcomeDigest exactly from outcome_prepared', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'personal-feed-v2-store-digest-'))
    temporaryDirectories.push(directory)
    const fixture = makeCoordinator(directory)
    const prepared = await fixture.coordinator.prepare({ chatId: 42, messageId: 5, signal: signal() }) as PreparedResult
    prepared.settle({
      chatId: 42,
      triggerMessageId: 5,
      visibleText: prepared.outcome.finalText,
      messageIds: [9001],
    })

    const lines = readFileSync(fixture.ledgerPath, 'utf8').trim().split('\n')
    const preparedRecord = JSON.parse(lines.find(line => line.includes('"event":"outcome_prepared"')) ?? '') as {
      readonly outcome?: { readonly digest?: unknown }
    }
    const terminal = JSON.parse(lines.at(-1) ?? '') as Record<string, unknown>
    expect(preparedRecord.outcome?.digest).toBe(prepared.outcome.digest)
    expect(terminal).toMatchObject({
      event: 'delivered_terminal',
      outcomeDigest: preparedRecord.outcome?.digest,
    })
  })

  it('fails closed after changing only delivered_terminal outcomeDigest to another legal digest', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'personal-feed-v2-store-digest-conflict-'))
    temporaryDirectories.push(directory)
    const fixture = await seedTerminal(directory)
    const lines = readFileSync(fixture.ledgerPath, 'utf8').trim().split('\n')
    const terminal = JSON.parse(lines.at(-1) ?? '') as Record<string, unknown>
    const changedDigest = '0123'.repeat(16)
    expect(terminal.outcomeDigest).not.toBe(changedDigest)
    terminal.outcomeDigest = changedDigest
    replaceLedgerLine(fixture.ledgerPath, lines.length - 1, JSON.stringify(terminal))

    const reopened = makeCoordinator(directory)
    expect(() => reopened.coordinator.read('telegram:42:5')).toThrow()
    await expect(reopened.coordinator.prepare({ chatId: 42, messageId: 5, signal: signal() })).rejects.toThrow()
    expect(reopened.calls).toEqual({ r4: 0, r2: 0, r3: 0, r5: 0 })
  })

  it('fails closed after changing only delivered_terminal.receipt.visibleText in place', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'personal-feed-v2-store-terminal-text-'))
    temporaryDirectories.push(directory)
    const fixture = await seedTerminal(directory)
    const lines = readFileSync(fixture.ledgerPath, 'utf8').trim().split('\n')
    const terminal = JSON.parse(lines.at(-1) ?? '') as { readonly receipt?: Record<string, unknown> }
    if (terminal.receipt === undefined) throw new Error('fixture terminal did not contain a receipt')
    const changedTerminal = { ...terminal, receipt: { ...terminal.receipt, visibleText: 'conflicting terminal text' } }
    replaceLedgerLine(fixture.ledgerPath, lines.length - 1, JSON.stringify(changedTerminal))

    const reopened = makeCoordinator(directory)
    expect(() => reopened.coordinator.read('telegram:42:5')).toThrow()
    await expect(reopened.coordinator.prepare({ chatId: 42, messageId: 5, signal: signal() })).rejects.toThrow()
    expect(reopened.calls).toEqual({ r4: 0, r2: 0, r3: 0, r5: 0 })
  })

  it('fails closed after changing only request_opened.shanghaiDay to another valid but cutoff-inconsistent day', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'personal-feed-v2-store-day-conflict-'))
    temporaryDirectories.push(directory)
    const fixture = await seedTerminal(directory)
    const lines = readFileSync(fixture.ledgerPath, 'utf8').trim().split('\n')
    const opened = JSON.parse(lines[0] ?? '') as { readonly request?: Record<string, unknown> }
    if (opened.request === undefined) throw new Error('fixture opened record did not contain a request')
    const changedOpened = { ...opened, request: { ...opened.request, shanghaiDay: '2026-09-01' } }
    replaceLedgerLine(fixture.ledgerPath, 0, JSON.stringify(changedOpened))

    const reopened = makeCoordinator(directory)
    expect(() => reopened.coordinator.read('telegram:42:5')).toThrow()
    await expect(reopened.coordinator.prepare({ chatId: 42, messageId: 5, signal: signal() })).rejects.toThrow()
    expect(reopened.calls).toEqual({ r4: 0, r2: 0, r3: 0, r5: 0 })
  })

  it('tightens a pre-existing 0777 ledger parent directory to 0700 on the first append', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'personal-feed-v2-store-parent-mode-'))
    temporaryDirectories.push(directory)
    const ledgerDirectory = join(directory, 'ledger')
    mkdirSync(ledgerDirectory, { recursive: true, mode: 0o777 })
    chmodSync(ledgerDirectory, 0o777)
    const { coordinator } = makeCoordinator(directory)

    await coordinator.prepare({ chatId: 42, messageId: 5, signal: signal() })
    expect(statSync(ledgerDirectory).mode & 0o777).toBe(0o700)
  })

  it('replays each clean request/prepared/terminal record exactly once without changing the delivered result', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'personal-feed-v2-store-replay-'))
    temporaryDirectories.push(directory)
    const fixture = await seedTerminal(directory)
    const cleanLines = readFileSync(fixture.ledgerPath, 'utf8').trim().split('\n')
    expect(cleanLines).toHaveLength(3)
    writeFileSync(fixture.ledgerPath, `${cleanLines.join('\n')}\n${cleanLines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 })
    const reopened = makeCoordinator(directory)

    const baseline = reopened.coordinator.read('telegram:42:5')
    expect(baseline).toMatchObject({ status: 'delivered' })
    const duplicate = await reopened.coordinator.prepare({ chatId: 42, messageId: 5, signal: signal() })
    expect(duplicate).toEqual({ kind: 'duplicate_consumed' })
    expect(reopened.coordinator.read('telegram:42:5')).toEqual(baseline)
    expect(reopened.calls).toEqual({ r4: 0, r2: 0, r3: 0, r5: 0 })
  })
})
