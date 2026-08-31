import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

type SessionEventSummary = {
  readonly sessionId: string
  readonly seq: number
  readonly type: string
  readonly time: number
  readonly surface: 'current' | 'shadowed' | 'log-only'
}

type SessionHeader = {
  readonly version: 0
  readonly id: string
  readonly createdAt: number
  readonly cwd?: string
  readonly agentPreset?: string
}

type SessionTarget = {
  readonly type: 'user/message'
  readonly seq: number
  readonly time: number
  readonly data: {
    readonly id: string
    readonly role: 'user'
    readonly content: readonly Record<string, unknown>[]
    readonly source: { readonly kind: string }
  }
}

type SessionEvent = {
  readonly session: SessionHeader
  readonly target: SessionTarget
  readonly events: readonly [SessionTarget]
  readonly startSeq: number
  readonly endSeq: number
}

type SessionQuery = {
  readonly listEvents: (sessionId: string, signal?: AbortSignal) => unknown | Promise<unknown>
  readonly readEvent: (input: { readonly sessionId: string; readonly seq: number; readonly before: 0; readonly after: 0 }, signal?: AbortSignal) => unknown | Promise<unknown>
}

type HistoryMessage = {
  readonly locator: { readonly kind: 'telegram_session_history'; readonly sessionId: string; readonly eventSeq: number }
  readonly rawText: string
  readonly occurredAt: string
}

type HistoryObservation = {
  readonly schemaVersion: 1
  readonly sessionId: string
  readonly observedThroughSeq: number
  readonly manifestDigest: string
  readonly messages: readonly HistoryMessage[]
  readonly excludedEventCount: number
  readonly digest: string
}

type HistoryResult =
  | { readonly kind: 'complete'; readonly observation: HistoryObservation }
  | { readonly kind: 'unknown'; readonly reason: 'history_unavailable' | 'history_changed' | 'history_corrupt' | 'unsupported_user_content' | 'aborted' }

type HistoryAdapter = {
  readonly contract: { readonly schemaVersion: 1; readonly sourceKind: 'telegram_session_history'; readonly sessionId: string }
  readonly observe: (input?: { readonly signal?: AbortSignal }) => Promise<HistoryResult>
}

type Owner = {
  readonly bootstrap: (input: { readonly history: HistoryAdapter; readonly signal?: AbortSignal }) => Promise<unknown>
  readonly capture: (input: unknown) => unknown
  readonly settle: (input: { readonly sourceKey: string; readonly signal?: AbortSignal }) => Promise<unknown>
  readonly read: () => { readonly sources: readonly Record<string, unknown>[]; readonly coverage: readonly Record<string, unknown>[] }
  readonly freezeFence: (input: unknown) => unknown
  readonly snapshot: (input: unknown) => unknown
  readonly close: () => void
}

type CaptureReceipt = {
  readonly source: { readonly sourceKey: string; readonly captureSequence: number; readonly rawText: string | null }
  readonly coverage: Record<string, unknown>
}

type SemanticPorts = {
  readonly classifier: (input: unknown) => unknown | Promise<unknown>
  readonly entailmentValidator: (input: unknown) => unknown | Promise<unknown>
  readonly noFactValidator: (input: unknown) => unknown | Promise<unknown>
}

type Production = {
  readonly createSessionUserHistoryAdapter?: (options: { readonly sessionId: string; readonly sessionQuery: SessionQuery }) => HistoryAdapter
  readonly createPersonalContextOwner?: (options: {
    readonly databasePath: string
    readonly clock: { readonly now: () => Date }
    readonly semantics?: SemanticPorts
  }) => Owner
}

const temporaryDirectories: string[] = []
const sessionId = 'session-root-2026-08-31'
const occurredAt = '2026-08-31T16:00:00.000Z'
const digestPattern = /^sha256:[0-9a-f]{64}$/
const rawDigestPattern = /^[0-9a-f]{64}$/

function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(item => canonical(item)).join(',')}]`
  if (typeof value !== 'object') throw new Error('fixture value is not canonical JSON')
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonical(value), 'utf8').digest('hex')}`
}

function rawDigest(value: unknown): string {
  return createHash('sha256').update(canonical(value), 'utf8').digest('hex')
}

function textDigest(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`
}

function exactKeys(value: unknown, keys: readonly string[]): void {
  expect(value).toBeTypeOf('object')
  expect(value).not.toBeNull()
  expect(Object.keys(value as object).sort()).toEqual([...keys].sort())
}

function databasePath(prefix = 'personal-feed-v2-bootstrap-'): string {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return join(directory, 'state', 'personal-context.sqlite')
}

async function production(): Promise<Production> {
  return await import('../src/index.ts') as Production
}

function summary(seq: number, type = 'user/message', id = sessionId): SessionEventSummary {
  return { sessionId: id, seq, type: type === 'user' || type === 'message' ? 'user/message' : type, time: Date.parse(occurredAt), surface: 'current' }
}

function userEvent(seq: number, text: string, id = sessionId, sourceKind = 'user'): SessionEvent {
  const target: SessionTarget = {
    type: 'user/message',
    seq,
    time: Date.parse(occurredAt),
    data: {
      id: `message-${seq}`,
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: sourceKind },
    },
  }
  return {
    session: { version: 0, id, createdAt: Date.parse(occurredAt) },
    target,
    events: [target],
    startSeq: seq,
    endSeq: seq,
  }
}

function userEventWithSessionHeader(seq: number, text: string, header: { readonly createdAt?: number; readonly cwd?: string } = {}): SessionEvent {
  const event = userEvent(seq, text)
  return {
    ...event,
    session: {
      ...event.session,
      cwd: header.cwd ?? '/home/herman/.dsh/workspace',
      agentPreset: 'telegram',
      ...(header.createdAt === undefined ? {} : { createdAt: header.createdAt }),
    },
  }
}

function makeQuery(events: readonly SessionEventSummary[], fullEvents: readonly SessionEvent[] = []): SessionQuery & { readonly calls: { list: number; reads: number[]; readSources: string[]; readInputs: Array<{ readonly sessionId: string; readonly seq: number; readonly before: 0; readonly after: 0 }> } } {
  const calls = { list: 0, reads: [] as number[], readSources: [] as string[], readInputs: [] as Array<{ readonly sessionId: string; readonly seq: number; readonly before: 0; readonly after: 0 }> }
  const bySeq = new Map(fullEvents.map(event => [event.target.seq, event] as const))
  return {
    calls,
    listEvents: async (id: string): Promise<unknown> => {
      calls.list += 1
      if (id !== sessionId) throw new Error(`unexpected session ${id}`)
      return events
    },
    readEvent: async (input): Promise<unknown> => {
      calls.reads.push(input.seq)
      calls.readInputs.push(input)
      const event = bySeq.get(input.seq)
      if (event === undefined) throw new Error(`missing fixture event ${input.seq}`)
      calls.readSources.push(event.target.data.source.kind)
      return event
    },
  }
}

type FakeHistoryAdapter = HistoryAdapter & {
  readonly calls: { observe: number }
  result: HistoryResult
  thrown?: Error
}

function fakeHistoryAdapter(result: HistoryResult, id = sessionId): FakeHistoryAdapter {
  const adapter: FakeHistoryAdapter = {
    contract: { schemaVersion: 1, sourceKind: 'telegram_session_history', sessionId: id },
    calls: { observe: 0 },
    result,
    observe: async () => {
      adapter.calls.observe += 1
      if (adapter.thrown !== undefined) throw adapter.thrown
      return adapter.result
    },
  }
  return adapter
}

async function adapterFor(query: SessionQuery, id = sessionId): Promise<HistoryAdapter> {
  const module = await production()
  expect(typeof module.createSessionUserHistoryAdapter).toBe('function')
  if (typeof module.createSessionUserHistoryAdapter !== 'function') throw new Error('session history adapter is unavailable')
  return module.createSessionUserHistoryAdapter({ sessionId: id, sessionQuery: query })
}

async function ownerFor(path = databasePath(), semantics?: SemanticPorts): Promise<{ readonly owner: Owner; readonly path: string }> {
  const module = await production()
  expect(typeof module.createPersonalContextOwner).toBe('function')
  if (typeof module.createPersonalContextOwner !== 'function') throw new Error('personal context owner is unavailable')
  return {
    path,
    owner: module.createPersonalContextOwner({
      databasePath: path,
      clock: { now: () => new Date(occurredAt) },
      ...(semantics === undefined ? {} : { semantics }),
    }),
  }
}

function completeHistory(messages: readonly HistoryMessage[] = [{
  locator: { kind: 'telegram_session_history', sessionId, eventSeq: 1 },
  rawText: '我长期关注可靠的软件设计',
  occurredAt,
}]): HistoryResult {
  const unsigned = {
    schemaVersion: 1 as const,
    sessionId,
    observedThroughSeq: Math.max(...messages.map(message => message.locator.eventSeq), 0),
    manifestDigest: digest(messages.map(message => ({ ...message.locator, occurredAt: message.occurredAt }))),
    messages,
    excludedEventCount: 0,
  }
  return { kind: 'complete', observation: { ...unsigned, digest: digest(unsigned) } }
}

function semanticsReturningNoFact(): SemanticPorts {
  return {
    classifier: () => ({ kind: 'no_fact', reason: 'not_personal_fact' }),
    entailmentValidator: () => ({ kind: 'target_and_revision_confirmed' }),
    noFactValidator: () => ({ kind: 'confirmed_no_fact' }),
  }
}

function sufficientSemantics(): SemanticPorts {
  const attitude = {
    speaker: 'user' as const,
    polarity: 'affirmed' as const,
    modality: 'committed' as const,
    attribution: 'own_statement' as const,
    temporal: 'current' as const,
    qualification: 'unqualified' as const,
  }
  const protectedSpans = {
    subject: [{ startUtf16: 0, endUtf16: 1 }], polarity: [], conditions: [], modality: [], attribution: [], temporal: [], applicability: [],
  }
  const proposal = (rawText: string, lane: 'long_term_interest' | 'existing_knowledge') => ({
    lane,
    ...(lane === 'long_term_interest' ? { stance: 'include' as const } : { epistemic: 'asserted' as const }),
    focusSpan: (() => {
      const marker = lane === 'long_term_interest' ? '关注' : '知道'
      const markerStart = rawText.indexOf(marker)
      if (markerStart < 0) throw new Error(`fixture text lacks semantic marker: ${marker}`)
      const afterMarker = markerStart + marker.length
      const firstNonWhitespace = rawText.slice(afterMarker).search(/\S/u)
      if (firstNonWhitespace < 0) throw new Error('fixture text lacks a focus span')
      return { startUtf16: afterMarker + firstNonWhitespace, endUtf16: rawText.length }
    })(),
    protectedSpans,
    attitude,
    operation: 'assert' as const,
    targetFactIds: [],
  })
  return {
    classifier: input => {
      expect(input).toMatchObject({ rawText: expect.any(String) })
      const rawText = (input as { readonly rawText: string }).rawText
      return rawText.startsWith('当前请求')
        ? { kind: 'no_fact', reason: 'not_personal_fact' }
        : {
            kind: 'facts',
            facts: [proposal(rawText, rawText.includes('知道') ? 'existing_knowledge' : 'long_term_interest')],
          }
    },
    entailmentValidator: () => ({ kind: 'target_and_revision_confirmed' }),
    noFactValidator: () => ({ kind: 'confirmed_no_fact' }),
  }
}

function createLegacySchema(path: string, version: number): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const database = new DatabaseSync(path)
  try {
    database.exec(`PRAGMA application_id = ${0x50435632}; PRAGMA user_version = ${version}`)
    database.exec(`
      CREATE TABLE personal_context_sources (
        source_key TEXT PRIMARY KEY,
        locator_kind TEXT NOT NULL CHECK (locator_kind = 'telegram_inbound'),
        chat_id INTEGER NOT NULL CHECK (chat_id <> 0),
        message_id INTEGER NOT NULL CHECK (message_id > 0),
        raw_text TEXT,
        reference_json TEXT NOT NULL CHECK (reference_json = 'null'),
        excluded_request_id TEXT,
        occurred_at TEXT NOT NULL,
        capture_sequence INTEGER NOT NULL UNIQUE,
        payload_digest TEXT NOT NULL,
        UNIQUE (locator_kind, chat_id, message_id)
      ) STRICT;
      CREATE TABLE personal_context_coverage (
        source_key TEXT PRIMARY KEY REFERENCES personal_context_sources(source_key),
        status TEXT NOT NULL CHECK (status IN ('pending', 'applied', 'ignored')),
        disposition_json TEXT,
        disposition_digest TEXT
        ${version === 2
          ? `, CHECK (
            (status = 'pending' AND disposition_json IS NULL AND disposition_digest IS NULL)
            OR (status IN ('applied', 'ignored') AND disposition_json IS NOT NULL AND disposition_digest IS NOT NULL)
          )`
          : `, terminal_transaction_sequence INTEGER UNIQUE, revision_digest TEXT,
          CHECK (
            (status = 'pending' AND disposition_json IS NULL AND disposition_digest IS NULL
              AND terminal_transaction_sequence IS NULL AND revision_digest IS NULL)
            OR
            (status IN ('applied', 'ignored') AND disposition_json IS NOT NULL AND disposition_digest IS NOT NULL
              AND terminal_transaction_sequence IS NOT NULL AND terminal_transaction_sequence > 0
              AND revision_digest IS NOT NULL)
          )`}
      ) STRICT;
      ${version === 2 ? '' : `CREATE TABLE personal_context_metadata (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        store_id TEXT NOT NULL
      ) STRICT;`}
      ${version === 2 ? '' : `CREATE TABLE personal_context_fences (
        request_id TEXT PRIMARY KEY,
        cutoff TEXT NOT NULL,
        shanghai_day TEXT NOT NULL,
        fence_json TEXT NOT NULL,
        fence_digest TEXT NOT NULL
      ) STRICT;`}
    `)
    const storeId = digest({ kind: 'personal_context_store', path })
    if (version !== 2) database.prepare('INSERT INTO personal_context_metadata (singleton, store_id) VALUES (1, ?)').run(storeId)
    const factSource = { kind: 'telegram_inbound', chatId: 700, messageId: 1 }
    const factSourceKey = digest(factSource)
    const fact = {
      lane: 'long_term_interest',
      stance: 'include',
      evidence: {
        sourceKey: factSourceKey,
        evidenceSpan: { startUtf16: 0, endUtf16: 7 },
        exactEvidenceText: '我关注可靠设计',
        focusSpanWithinEvidence: { startUtf16: 3, endUtf16: 7 },
        protectedSpansWithinEvidence: {
          subject: [{ startUtf16: 0, endUtf16: 1 }], polarity: [], conditions: [], modality: [], attribution: [], temporal: [], applicability: [],
        },
        attitude: { speaker: 'user', polarity: 'affirmed', modality: 'committed', attribution: 'own_statement', temporal: 'current', qualification: 'unqualified' },
      },
      useAuthorization: { policyId: 'personal-feed-direct-telegram-v1', purpose: 'personal_feed_context', sourceKind: 'telegram_inbound' },
    }
    const validationInputDigest = `sha256:${'1'.repeat(64)}`
    const operationDigest = digest({
      sourceKey: factSourceKey,
      factOrdinal: 0,
      lane: fact.lane,
      operation: 'assert',
      targetFactIds: [],
      terminalTransactionSequence: 1,
      validationInputDigest,
      fact,
    })
    const revisionId = digest({ kind: 'personal_context_revision', operationDigest })
    const entry = {
      revisionId,
      currentFactId: digest({ kind: 'personal_context_fact', revisionId }),
      sourceKey: factSourceKey,
      factOrdinal: 0,
      lane: fact.lane,
      operation: 'assert',
      targetFactIds: [],
      terminalTransactionSequence: 1,
      validationInputDigest,
      operationDigest,
    }
    const applied = version === 2
      ? { schemaVersion: 1, status: 'applied', facts: [fact] }
      : { schemaVersion: 2, status: 'applied', changes: [{ operation: 'assert', targetFactIds: [], fact, validationInputDigest }] }
    const appliedRevisionDigest = digest({ entries: [entry] })
    const ignored = version === 2
      ? { schemaVersion: 1, status: 'ignored', reason: 'not_personal_fact' }
      : { schemaVersion: 2, status: 'ignored', reason: 'not_personal_fact' }
    const rows = [
      { source: factSource, sourceKey: factSourceKey, rawText: null, sequence: 1, payload: { rawText: '我关注可靠设计', reference: null } },
      { source: { kind: 'telegram_inbound', chatId: 700, messageId: 2 }, sourceKey: digest({ kind: 'telegram_inbound', chatId: 700, messageId: 2 }), rawText: null, sequence: 2, payload: { rawText: '忽略', reference: null } },
      { source: { kind: 'telegram_inbound', chatId: 700, messageId: 3 }, sourceKey: digest({ kind: 'telegram_inbound', chatId: 700, messageId: 3 }), rawText: '待迁移', sequence: 3, payload: { rawText: '待迁移', reference: null } },
    ] as const
    for (const row of rows) {
      const disposition = row.sequence === 1 ? applied : row.sequence === 2 ? ignored : undefined
      const dispositionJson = disposition === undefined ? null : canonical(disposition)
      database.prepare(`INSERT INTO personal_context_sources (
        source_key, locator_kind, chat_id, message_id, raw_text, reference_json,
        excluded_request_id, occurred_at, capture_sequence, payload_digest
      ) VALUES (?, 'telegram_inbound', ?, ?, ?, 'null', NULL, ?, ?, ?)`)
        .run(row.sourceKey, row.source.chatId, row.source.messageId, row.rawText, occurredAt, row.sequence, rawDigest(row.payload))
      if (version === 2) {
        database.prepare(`INSERT INTO personal_context_coverage (
          source_key, status, disposition_json, disposition_digest
        ) VALUES (?, ?, ?, ?)`)
          .run(row.sourceKey, disposition === undefined ? 'pending' : disposition.status, dispositionJson,
            dispositionJson === null ? null : textDigest(dispositionJson))
      } else {
        database.prepare(`INSERT INTO personal_context_coverage (
          source_key, status, disposition_json, disposition_digest, terminal_transaction_sequence, revision_digest
        ) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(row.sourceKey, disposition === undefined ? 'pending' : disposition.status, dispositionJson,
            dispositionJson === null ? null : textDigest(dispositionJson), disposition === undefined ? null : row.sequence,
            disposition === undefined ? null : disposition === applied ? appliedRevisionDigest : digest({ entries: [] }))
      }
    }
    if (version !== 2) {
      const unsigned = {
        schemaVersion: 1,
        requestId: 'telegram:700:9',
        cutoff: '2026-08-31T09:00:00.000Z',
        shanghaiDay: '2026-08-31',
        storeId,
        maxCaptureSequence: 2,
        maxTerminalTransactionSequence: 2,
      }
      const fence = { ...unsigned, digest: digest(unsigned) }
      database.prepare(`INSERT INTO personal_context_fences (
        request_id, cutoff, shanghai_day, fence_json, fence_digest
      ) VALUES (?, ?, ?, ?, ?)`)
        .run(fence.requestId, fence.cutoff, fence.shanghaiDay, canonical(fence), fence.digest)
    }
  } finally {
    database.close()
  }
}

function legacyBytes(path: string): Buffer {
  return readFileSync(path)
}

function setPragma(path: string, statement: string): void {
  const database = new DatabaseSync(path)
  try {
    database.exec(statement)
  } finally {
    database.close()
  }
}

function mutateCheckpointStatus(path: string, status: 'settling' | 'complete'): void {
  const database = new DatabaseSync(path)
  try {
    database.prepare('UPDATE personal_context_bootstrap SET status = ? WHERE singleton = 1').run(status)
  } finally {
    database.close()
  }
}

function mutateLegacySemanticField(path: string, version: 2 | 3, field: string): void {
  const database = new DatabaseSync(path)
  try {
    if (field === 'source_key') database.exec('PRAGMA foreign_keys = OFF')
    database.exec('BEGIN IMMEDIATE')
    if (field === 'disposition_digest') {
      database.prepare("UPDATE personal_context_coverage SET disposition_digest = ? WHERE status = 'applied'").run(textDigest('semantically mismatched disposition'))
    } else if (field === 'payload_digest') {
      database.prepare("UPDATE personal_context_sources SET payload_digest = ? WHERE capture_sequence = 3").run(rawDigest('semantically mismatched payload'))
    } else if (field === 'source_key') {
      const oldKey = digest({ kind: 'telegram_inbound', chatId: 700, messageId: 1 })
      const newKey = digest({ kind: 'telegram_inbound', chatId: 700, messageId: 999 })
      database.prepare('UPDATE personal_context_coverage SET source_key = ? WHERE source_key = ?').run(newKey, oldKey)
      database.prepare('UPDATE personal_context_sources SET source_key = ? WHERE source_key = ?').run(newKey, oldKey)
    } else if (field === 'revision_digest' && version === 3) {
      database.prepare("UPDATE personal_context_coverage SET revision_digest = ? WHERE status = 'applied'").run(`sha256:${'e'.repeat(64)}`)
    } else if (field === 'store_id' && version === 3) {
      database.prepare('UPDATE personal_context_metadata SET store_id = ? WHERE singleton = 1').run(digest({ kind: 'personal_context_store', path: `${path}-other` }))
    } else if (field === 'fence_digest' && version === 3) {
      database.prepare('UPDATE personal_context_fences SET fence_digest = ? WHERE request_id = ?').run(`sha256:${'e'.repeat(64)}`, 'telegram:700:9')
    } else {
      throw new Error(`unsupported legacy semantic field ${version}:${field}`)
    }
    database.exec('COMMIT')
    if (field === 'source_key') {
      database.exec('PRAGMA foreign_keys = ON')
      if (database.prepare('PRAGMA foreign_key_check').all().length !== 0) {
        throw new Error('paired source key fixture introduced a foreign key violation')
      }
    }
  } catch (error) {
    try { database.exec('ROLLBACK') } catch { /* preserve original failure */ }
    throw error
  } finally {
    if (field === 'source_key') {
      try { database.exec('PRAGMA foreign_keys = ON') } catch { /* closing still releases the fixture */ }
    }
    database.close()
  }
}

function deleteHistorySource(path: string, eventSeq: number): void {
  const database = new DatabaseSync(path)
  try {
    database.exec('BEGIN IMMEDIATE')
    const row = database.prepare('SELECT source_key FROM personal_context_sources WHERE locator_kind = \'telegram_session_history\' AND event_seq = ?').get(eventSeq) as { readonly source_key: string } | undefined
    if (row === undefined) throw new Error(`missing history fixture ${eventSeq}`)
    database.prepare('DELETE FROM personal_context_coverage WHERE source_key = ?').run(row.source_key)
    database.prepare('DELETE FROM personal_context_sources WHERE source_key = ?').run(row.source_key)
    database.exec('COMMIT')
  } catch (error) {
    try { database.exec('ROLLBACK') } catch { /* preserve original failure */ }
    throw error
  } finally {
    database.close()
  }
}

function applicationCounts(path: string): Record<string, number> {
  const database = new DatabaseSync(path)
  try {
    const tables = ['personal_context_sources', 'personal_context_coverage', 'personal_context_metadata', 'personal_context_fences', 'personal_context_bootstrap'] as const
    return Object.fromEntries(tables.map(table => {
      const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { readonly count: number }
      return [table, row.count]
    }))
  } finally {
    database.close()
  }
}

function bootstrapCount(path: string): number {
  const database = new DatabaseSync(path)
  try {
    const row = database.prepare("SELECT COUNT(*) AS count FROM personal_context_bootstrap").get() as { readonly count: number }
    return row.count
  } finally {
    database.close()
  }
}

function bootstrapStatus(path: string): unknown {
  const database = new DatabaseSync(path)
  try {
    return (database.prepare('SELECT status FROM personal_context_bootstrap LIMIT 1').get() as { readonly status: unknown }).status
  } finally {
    database.close()
  }
}

function v3Durability(path: string): unknown {
  const database = new DatabaseSync(path)
  try {
    return {
      metadata: database.prepare('SELECT store_id FROM personal_context_metadata').all(),
      sources: database.prepare('SELECT source_key, capture_sequence FROM personal_context_sources ORDER BY capture_sequence').all(),
      coverage: database.prepare('SELECT source_key, terminal_transaction_sequence, disposition_digest, revision_digest FROM personal_context_coverage ORDER BY source_key').all(),
      fences: database.prepare('SELECT request_id, fence_json, fence_digest FROM personal_context_fences').all(),
    }
  } finally {
    database.close()
  }
}

function mutateIntegrity(path: string, wanted: readonly string[]): string | undefined {
  const database = new DatabaseSync(path)
  try {
    const tables = database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ readonly name: string }>
    for (const table of tables) {
      const columns = database.prepare(`PRAGMA table_info("${table.name.replaceAll('"', '""')}")`).all() as Array<{ readonly name: string }>
      for (const column of columns) {
        if (!wanted.includes(column.name)) continue
        const tableName = `"${table.name.replaceAll('"', '""')}"`
        const columnName = `"${column.name.replaceAll('"', '""')}"`
        const row = database.prepare(`SELECT rowid AS __test_rowid, ${columnName} AS value FROM ${tableName} WHERE ${columnName} IS NOT NULL LIMIT 1`).get() as { readonly __test_rowid: unknown; readonly value: unknown } | undefined
        if (row === undefined) continue
        const normalizedRowId = typeof row.__test_rowid === 'number' && Number.isSafeInteger(row.__test_rowid)
          ? row.__test_rowid
          : typeof row.__test_rowid === 'bigint'
            && row.__test_rowid >= BigInt(Number.MIN_SAFE_INTEGER)
            && row.__test_rowid <= BigInt(Number.MAX_SAFE_INTEGER)
            ? Number(row.__test_rowid)
            : undefined
        if (normalizedRowId === undefined || !Number.isSafeInteger(normalizedRowId)) continue
        const replacement = typeof row.value === 'string' && rawDigestPattern.test(row.value)
          ? 'f'.repeat(64)
          : 'sha256:' + 'f'.repeat(64)
        database.prepare(`UPDATE ${tableName} SET ${columnName} = ? WHERE rowid = ?`).run(replacement, normalizedRowId)
        return `${table.name}.${column.name}`
      }
    }
    return undefined
  } finally {
    database.close()
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('Personal Feed v2 group 4 history bootstrap and v4 durability', () => {
  it('migrates only exact v2/v3 fixtures atomically, preserves replay evidence, is idempotent, and rejects v1/foreign/future/malformed schemas without clearing bytes', async () => {
    for (const version of [2, 3] as const) {
      const path = databasePath(`personal-feed-v2-migrate-${version}-`)
      createLegacySchema(path, version)
      const preMigrationV3 = version === 3 ? v3Durability(path) : undefined
      const firstBefore = legacyBytes(path)
      const first = await ownerFor(path)
      const firstRead = first.owner.read()
      expect(firstRead.sources).toHaveLength(3)
      expect(firstRead.coverage.map(row => row.status).sort()).toEqual(['applied', 'ignored', 'pending'])
      expect(firstRead.coverage.filter(row => row.status === 'applied')).toHaveLength(1)
      expect(firstRead.coverage.filter(row => row.status === 'ignored')).toHaveLength(1)
      expect(firstRead.coverage.filter(row => row.status === 'pending')).toHaveLength(1)
      if (version === 2) {
        const fence = first.owner.freezeFence({ request: { requestId: 'telegram:700:9', cutoff: '2026-08-31T09:00:00.000Z', shanghaiDay: '2026-08-31' } })
        expect(fence).toMatchObject({ maxCaptureSequence: 3, maxTerminalTransactionSequence: 2 })
        expect(fence && (fence as Record<string, unknown>).digest).toMatch(digestPattern)
        const snapshot = first.owner.snapshot({ fence }) as Record<string, unknown>
        expect(snapshot).toBeDefined()
        expect(snapshot.kind).toBe('unknown')
        const proof = snapshot.proof as Record<string, unknown>
        const revisions = proof.revisions as Record<string, unknown>
        expect((revisions.entries as readonly unknown[]).length).toBe(1)
        expect((revisions.entries as readonly Record<string, unknown>[])[0]?.terminalTransactionSequence).toBe(1)
        const applied = firstRead.coverage.find(row => row.status === 'applied') as Record<string, unknown>
        const disposition = applied.disposition as Record<string, unknown>
        expect(disposition.schemaVersion).toBe(2)
        expect(disposition.status).toBe('applied')
        expect((disposition.changes as readonly Record<string, unknown>[])[0]).toMatchObject({ operation: 'assert', targetFactIds: [] })
        expect(applied.terminalTransactionSequence).toBe(1)
      } else {
        const fence = first.owner.freezeFence({ request: { requestId: 'telegram:700:9', cutoff: '2026-08-31T09:00:00.000Z', shanghaiDay: '2026-08-31' } })
        const snapshot = first.owner.snapshot({ fence }) as Record<string, unknown>
        expect(snapshot.kind).toBe('unknown')
        expect(v3Durability(path)).toEqual(preMigrationV3)
      }
      const migratedBytes = legacyBytes(path)
      expect(migratedBytes).not.toEqual(firstBefore)
      first.owner.close()
      const reopened = await ownerFor(path)
      expect(reopened.owner.read()).toEqual(firstRead)
      reopened.owner.close()
    }

    for (const badVersion of [1, 4, 99] as const) {
      const path = databasePath(`personal-feed-v2-reject-${badVersion}-`)
      createLegacySchema(path, badVersion === 1 ? 2 : 3)
      setPragma(path, `PRAGMA user_version = ${badVersion}`)
      const before = legacyBytes(path)
      await expect(ownerFor(path)).rejects.toThrow()
      expect(legacyBytes(path)).toEqual(before)
    }
    const malformed = databasePath('personal-feed-v2-reject-malformed-')
    mkdirSync(dirname(malformed), { recursive: true, mode: 0o700 })
    const database = new DatabaseSync(malformed)
    database.exec('PRAGMA application_id = 0x50435632; PRAGMA user_version = 3; CREATE TABLE foreign_state (value TEXT)')
    database.close()
    const beforeMalformed = legacyBytes(malformed)
    await expect(ownerFor(malformed)).rejects.toThrow()
    expect(legacyBytes(malformed)).toEqual(beforeMalformed)
    const foreign = databasePath('personal-feed-v2-reject-foreign-')
    createLegacySchema(foreign, 3)
    const foreignDatabase = new DatabaseSync(foreign)
    foreignDatabase.exec('PRAGMA application_id = 12345')
    foreignDatabase.close()
    const beforeForeign = legacyBytes(foreign)
    await expect(ownerFor(foreign)).rejects.toThrow()
    expect(legacyBytes(foreign)).toEqual(beforeForeign)
  })

  it('reads only the configured session through the raw query port, selects user text in sequence order, strips the exact Telegram quote wrapper, and fails closed on malformed or unsupported user content', async () => {
    const quoted = [
      '当前用户前缀',
      '',
      '<telegram-quoted-message id="77">',
      '被引用正文',
      '</telegram-quoted-message>',
    ].join('\n')
    const events = [summary(0, 'turn/start'), summary(1), summary(2, 'tool/result'), summary(3), summary(4, 'assistant/message'), summary(5, 'turn/end'), summary(6)]
    const query = makeQuery(events, [
      userEvent(1, '我关注可靠设计'),
      userEvent(3, quoted),
      userEvent(6, '模型或插件不应导入', sessionId, 'model'),
    ])
    const adapter = await adapterFor(query)
    expect(adapter.contract).toEqual({ schemaVersion: 1, sourceKind: 'telegram_session_history', sessionId })
    const result = await adapter.observe()
    expect(result.kind).toBe('complete')
    if (result.kind !== 'complete') throw new Error('fixture history unexpectedly incomplete')
    exactKeys(result.observation, ['schemaVersion', 'sessionId', 'observedThroughSeq', 'manifestDigest', 'messages', 'excludedEventCount', 'digest'])
    expect(result.observation.sessionId).toBe(sessionId)
    expect(result.observation.messages.map(message => message.locator.eventSeq)).toEqual([1, 3])
    expect(result.observation.messages.map(message => message.rawText)).toEqual(['我关注可靠设计', '当前用户前缀'])
    expect(result.observation.messages.every(message => message.locator.kind === 'telegram_session_history')).toBe(true)
    expect(result.observation.excludedEventCount).toBe(5)
    expect(query.calls.reads).toEqual([1, 3, 6, 1, 3, 6])
    expect(query.calls.readSources).toEqual(['user', 'user', 'model', 'user', 'user', 'model'])
    expect(query.calls.readInputs).toEqual([
      { sessionId, seq: 1, before: 0, after: 0 },
      { sessionId, seq: 3, before: 0, after: 0 },
      { sessionId, seq: 6, before: 0, after: 0 },
      { sessionId, seq: 1, before: 0, after: 0 },
      { sessionId, seq: 3, before: 0, after: 0 },
      { sessionId, seq: 6, before: 0, after: 0 },
    ])
    expect(query.calls.list).toBe(2)
    await expect(adapterFor(query, '')).rejects.toThrow()

    const malformed = userEvent(1, '当前\n<telegram-quoted-message id="77">\n引用\n</telegram-quoted-message>\n尾')
    const unsupported = userEvent(1, '图片')
    const unsupportedTarget: SessionTarget = { ...unsupported.target, data: { ...unsupported.target.data, content: [{ type: 'image', url: 'file://unsupported' }] } }
    const unsupportedEvent: SessionEvent = { ...unsupported, target: unsupportedTarget, events: [unsupportedTarget] }
    for (const invalidEvent of [malformed, unsupportedEvent] as const) {
      const invalidQuery = makeQuery([summary(0, 'turn/start'), summary(1)], [invalidEvent])
      const invalidAdapter = await adapterFor(invalidQuery)
      await expect(invalidAdapter.observe()).resolves.toEqual({ kind: 'unknown', reason: 'unsupported_user_content' })
      expect(invalidQuery.calls.reads).toEqual([1])
    }
    const forgedSessionQuery = makeQuery([summary(0, 'turn/start'), summary(1, 'user/message', 'foreign-session')], [userEvent(1, '不能跨 session', 'foreign-session')])
    const forgedAdapter = await adapterFor(forgedSessionQuery)
    await expect(forgedAdapter.observe()).resolves.toEqual({ kind: 'unknown', reason: 'history_corrupt' })
  })

  it('rechecks the frozen high-water prefix and every target, never imports appended or changed data, and maps throw, corruption, gaps, reverse order, wrong session, and abort to allowlisted unknown results', async () => {
    const initial = [summary(0), summary(1)]
    const targetEvents = [userEvent(0, '第一条'), userEvent(1, '第二条')]
    const appendedState = { listCalls: 0, reads: [] as number[] }
    const appendedQuery: SessionQuery = {
      listEvents: async () => {
        appendedState.listCalls += 1
        return appendedState.listCalls === 1 ? initial : [...initial, summary(2)]
      },
      readEvent: async input => {
        appendedState.reads.push(input.seq)
        const event = targetEvents.find(candidate => candidate.target.seq === input.seq)
        if (event === undefined) throw new Error('appended event must not be read')
        return event
      },
    }
    const appendedAdapter = await adapterFor(appendedQuery)
    const appendedResult = await appendedAdapter.observe()
    expect(appendedResult.kind).toBe('complete')
    if (appendedResult.kind === 'complete') expect(appendedResult.observation.observedThroughSeq).toBe(1)
    expect(appendedState.reads).toEqual([0, 1, 0, 1])
    const mutations: Array<{ readonly name: string; readonly mutate: (state: { summaries: SessionEventSummary[]; targets: Map<number, SessionEvent> }) => void }> = [
      { name: 'prefix', mutate: state => { state.summaries[0] = summary(0, 'user/message', sessionId + '-changed') } },
      { name: 'target', mutate: state => { state.targets.set(1, userEvent(1, '第二条被改写')) } },
      { name: 'gap', mutate: state => { state.summaries = [summary(0), summary(2)] } },
      { name: 'reverse', mutate: state => { state.summaries = [summary(1), summary(0)] } },
      { name: 'wrong session', mutate: state => { state.summaries = [summary(0), summary(1, 'user/message', 'foreign')] } },
    ]
    for (const mutation of mutations) {
      const state = { summaries: [...initial], targets: new Map(targetEvents.map(event => [event.target.seq, event] as const)) }
      let listCalls = 0
      const query: SessionQuery = {
        listEvents: async () => {
          listCalls += 1
          if (listCalls === 2) mutation.mutate(state)
          return state.summaries
        },
        readEvent: async input => {
          const event = state.targets.get(input.seq)
          if (event === undefined) throw new Error('target missing')
          return event
        },
      }
      const adapter = await adapterFor(query)
      const result = await adapter.observe()
      expect(result, mutation.name).toEqual({ kind: 'unknown', reason: 'history_changed' })
      expect(listCalls).toBe(2)
    }
    const throwing = await adapterFor({ listEvents: () => { throw new Error('history unavailable') }, readEvent: async () => userEvent(1, 'never') })
    await expect(throwing.observe()).resolves.toEqual({ kind: 'unknown', reason: 'history_unavailable' })
    const corrupt = await adapterFor({ listEvents: async () => [summary(0), summary(1)], readEvent: async () => ({ ...summary(1), source: { kind: 'user' }, content: [{ type: 'text' }] }) })
    await expect(corrupt.observe()).resolves.toEqual({ kind: 'unknown', reason: 'history_corrupt' })
    const aborted = await adapterFor(makeQuery(initial, targetEvents))
    const controller = new AbortController()
    controller.abort()
    await expect(aborted.observe({ signal: controller.signal })).resolves.toEqual({ kind: 'unknown', reason: 'aborted' })
  })

  it('atomically imports one complete cohort, assigns capture sequences to real session/event locators, leaves unknown clean, and retains a settling cohort for pending semantics', async () => {
    const complete = completeHistory([
      { locator: { kind: 'telegram_session_history', sessionId, eventSeq: 4 }, rawText: '第一条历史', occurredAt },
      { locator: { kind: 'telegram_session_history', sessionId, eventSeq: 8 }, rawText: '第二条历史', occurredAt },
    ])
    const completeSemantics = semanticsReturningNoFact()
    const completeAdapter = fakeHistoryAdapter(complete)
    const completeFixture = await ownerFor(databasePath(), completeSemantics)
    const completeResult = await completeFixture.owner.bootstrap({ history: completeAdapter })
    expect(completeAdapter.calls.observe).toBe(1)
    exactKeys(completeResult, ['status', 'sessionId', 'observedThroughSeq', 'importedSourceCount', 'excludedEventCount', 'digest'])
    expect(completeResult).toMatchObject({ status: 'complete', sessionId, observedThroughSeq: 8, importedSourceCount: 2, excludedEventCount: 0 })
    const completeRead = completeFixture.owner.read()
    expect(completeRead.sources).toHaveLength(2)
    expect(completeRead.sources.map(source => source.locator)).toEqual([
      { kind: 'telegram_session_history', sessionId, eventSeq: 4 },
      { kind: 'telegram_session_history', sessionId, eventSeq: 8 },
    ])
    expect(completeRead.sources.map(source => source.captureSequence)).toEqual([1, 2])
    expect(completeRead.coverage.every(row => row.status === 'ignored' || row.status === 'applied')).toBe(true)
    completeFixture.owner.close()

    const unknownPath = databasePath('personal-feed-v2-bootstrap-unknown-')
    const unknownFixture = await ownerFor(unknownPath, completeSemantics)
    const unknownAdapter = fakeHistoryAdapter({ kind: 'unknown', reason: 'history_corrupt' })
    const unknownResult = await unknownFixture.owner.bootstrap({ history: unknownAdapter })
    expect(unknownAdapter.calls.observe).toBe(1)
    expect(unknownResult).toEqual({ status: 'incomplete', reason: 'history_corrupt' })
    expect(unknownFixture.owner.read()).toEqual({ sources: [], coverage: [] })
    expect(bootstrapCount(unknownPath)).toBe(0)
    const throwingAdapter = fakeHistoryAdapter(complete)
    throwingAdapter.thrown = new Error('query unavailable')
    const throwingResult = await unknownFixture.owner.bootstrap({ history: throwingAdapter })
    expect(throwingResult).toEqual({ status: 'incomplete', reason: 'history_unavailable' })
    expect(throwingAdapter.calls.observe).toBe(1)
    expect(unknownFixture.owner.read()).toEqual({ sources: [], coverage: [] })
    expect(bootstrapCount(unknownPath)).toBe(0)
    unknownFixture.owner.close()

    const pendingPath = databasePath('personal-feed-v2-bootstrap-pending-')
    const pendingSemantics: SemanticPorts = {
      classifier: () => { throw new Error('semantic port unavailable') },
      entailmentValidator: () => ({ kind: 'target_and_revision_confirmed' }),
      noFactValidator: () => ({ kind: 'confirmed_no_fact' }),
    }
    const pendingFixture = await ownerFor(pendingPath, pendingSemantics)
    const pendingAdapter = fakeHistoryAdapter(complete)
    const pendingResult = await pendingFixture.owner.bootstrap({ history: pendingAdapter })
    expect(pendingAdapter.calls.observe).toBe(1)
    expect(pendingResult).toEqual({ status: 'incomplete', reason: 'semantics_pending' })
    expect(pendingFixture.owner.read().sources).toHaveLength(2)
    expect(pendingFixture.owner.read().coverage.every(row => row.status === 'pending')).toBe(true)
    expect(bootstrapStatus(pendingPath)).toBe('settling')
    const pendingFence = pendingFixture.owner.freezeFence({ request: { requestId: 'telegram:700:31', cutoff: '2026-08-31T09:00:00.000Z', shanghaiDay: '2026-08-31' } })
    expect(pendingFixture.owner.snapshot({ fence: pendingFence })).toMatchObject({ kind: 'unknown', reason: 'coverage_incomplete' })
    const duplicatePath = databasePath('personal-feed-v2-bootstrap-duplicate-')
    const duplicate = await ownerFor(duplicatePath, completeSemantics)
    const duplicateHistory = completeHistory([
      { locator: { kind: 'telegram_session_history', sessionId, eventSeq: 1 }, rawText: '相同定位 A', occurredAt },
      { locator: { kind: 'telegram_session_history', sessionId, eventSeq: 1 }, rawText: '相同定位 B', occurredAt },
    ])
    await expect(duplicate.owner.bootstrap({ history: fakeHistoryAdapter(duplicateHistory) })).rejects.toThrow()
    expect(duplicate.owner.read()).toEqual({ sources: [], coverage: [] })
    expect(bootstrapCount(duplicatePath)).toBe(0)
    duplicate.owner.close()
    pendingFixture.owner.close()
  })

  it('recovers pending import and settling idempotently, rejects changed contracts and non-empty stores without checkpoints, and keeps live capture Telegram-only', async () => {
    const history = completeHistory([
      { locator: { kind: 'telegram_session_history', sessionId, eventSeq: 1 }, rawText: '第一条历史', occurredAt },
      { locator: { kind: 'telegram_session_history', sessionId, eventSeq: 2 }, rawText: '第二条历史', occurredAt },
    ])
    let allowSecond = false
    const classifierCalls: string[] = []
    const semantics: SemanticPorts = {
      classifier: input => {
        const rawText = (input as { readonly rawText: string }).rawText
        classifierCalls.push(rawText)
        if (rawText === '第一条历史') return { kind: 'no_fact', reason: 'not_personal_fact' }
        if (!allowSecond) throw new Error('second semantic result pending')
        return { kind: 'no_fact', reason: 'not_personal_fact' }
      },
      entailmentValidator: () => ({ kind: 'target_and_revision_confirmed' }),
      noFactValidator: () => ({ kind: 'confirmed_no_fact' }),
    }
    const adapter = fakeHistoryAdapter(history)
    const path = databasePath('personal-feed-v2-bootstrap-recover-')
    const fixture = await ownerFor(path, semantics)
    const first = await fixture.owner.bootstrap({ history: adapter })
    expect(first).toEqual({ status: 'incomplete', reason: 'semantics_pending' })
    expect(adapter.calls.observe).toBe(1)
    expect(fixture.owner.read().coverage.filter(row => row.status === 'ignored' || row.status === 'applied')).toHaveLength(1)
    expect(fixture.owner.read().coverage.filter(row => row.status === 'pending')).toHaveLength(1)
    const firstClassifierCount = classifierCalls.length
    fixture.owner.close()
    allowSecond = true
    const reopened = await ownerFor(path, semantics)
    const resumed = await reopened.owner.bootstrap({ history: adapter })
    expect(resumed).toMatchObject({ status: 'complete', sessionId })
    expect(adapter.calls.observe).toBe(1)
    expect(classifierCalls.slice(firstClassifierCount)).not.toContain('第一条历史')
    expect(classifierCalls.slice(firstClassifierCount).every(rawText => rawText === '第二条历史')).toBe(true)
    const bytesAfterCommit = legacyBytes(path)
    const second = await reopened.owner.bootstrap({ history: adapter })
    expect(second).toEqual(resumed)
    expect(adapter.calls.observe).toBe(1)
    expect(legacyBytes(path)).toEqual(bytesAfterCommit)
    const differentContract = fakeHistoryAdapter(history, 'other-session')
    await expect(reopened.owner.bootstrap({ history: differentContract })).rejects.toThrow()
    expect(differentContract.calls.observe).toBe(0)
    expect(legacyBytes(path)).toEqual(bytesAfterCommit)
    const appended = completeHistory([...history.observation.messages, { locator: { kind: 'telegram_session_history', sessionId, eventSeq: 3 }, rawText: '高水位之后', occurredAt }])
    adapter.result = appended
    const third = await reopened.owner.bootstrap({ history: adapter })
    expect(third).toEqual(resumed)
    expect(adapter.calls.observe).toBe(1)
    expect(reopened.owner.read().sources).toHaveLength(2)
    reopened.owner.close()

    const nonEmptyPath = databasePath('personal-feed-v2-bootstrap-conflict-')
    const nonEmpty = await ownerFor(nonEmptyPath)
    // A live Telegram source is deliberately not a bootstrap checkpoint.
    const capture = nonEmpty.owner.capture
    expect(capture).toBeDefined()
    if (capture !== undefined) capture({ locator: { kind: 'telegram_inbound', chatId: 700, messageId: 101 }, rawText: '已有个人语境', reference: null })
    expect(() => nonEmpty.owner.capture({ locator: { kind: 'telegram_session_history', sessionId, eventSeq: 101 }, rawText: '伪造历史', reference: null })).toThrow()
    const nonEmptyBefore = legacyBytes(nonEmptyPath)
    await expect(nonEmpty.owner.bootstrap({ history: fakeHistoryAdapter(completeHistory()) })).rejects.toThrow()
    expect(legacyBytes(nonEmptyPath)).toEqual(nonEmptyBefore)
    nonEmpty.owner.close()
  })

  it('preserves v4 close/reopen fence and snapshot bytes, excludes post-completion high-water events, and fails closed on checkpoint/source/coverage/fence/store identity corruption', async () => {
    const path = databasePath('personal-feed-v2-bootstrap-integrity-')
    const fixture = await ownerFor(path, semanticsReturningNoFact())
    const history = completeHistory()
    const adapter = fakeHistoryAdapter(history)
    const result = await fixture.owner.bootstrap({ history: adapter })
    expect(result).toMatchObject({ status: 'complete' })
    const fence = fixture.owner.freezeFence({ request: { requestId: 'telegram:700:201', cutoff: '2026-08-31T09:00:00.000Z', shanghaiDay: '2026-08-31' } })
    const baseline = fixture.owner.snapshot({ fence })
    const baselineBytes = JSON.stringify(baseline)
    expect(baselineBytes).toBeTruthy()
    fixture.owner.close()
    const reopened = await ownerFor(path, semanticsReturningNoFact())
    expect(JSON.stringify(reopened.owner.snapshot({ fence }))).toBe(baselineBytes)
    const afterRestart = reopened.owner.read()
    expect(afterRestart.sources).toHaveLength(1)
    reopened.owner.close()

    for (const [kind, field] of [
      ['checkpoint', 'checkpoint_digest'],
      ['source row', 'source_row_digest'],
      ['terminal payload', 'payload_digest'],
      ['coverage disposition', 'disposition_digest'],
      ['coverage revision', 'revision_digest'],
      ['fence', 'fence_digest'],
      ['metadata', 'store_id'],
    ] as const) {
      const corruptedPath = databasePath(`personal-feed-v2-bootstrap-corrupt-${kind.replaceAll(' ', '-')}-`)
      const corrupted = await ownerFor(corruptedPath, semanticsReturningNoFact())
      await corrupted.owner.bootstrap({ history: fakeHistoryAdapter(history) })
      const corruptedFence = corrupted.owner.freezeFence({ request: { requestId: 'telegram:700:202', cutoff: '2026-08-31T09:00:00.000Z', shanghaiDay: '2026-08-31' } })
      corrupted.owner.close()
      const changed = mutateIntegrity(corruptedPath, [field])
      expect(changed, `${kind}:${field}`).toBeDefined()
      let failure: unknown
      try {
        const reopenedCorrupt = await ownerFor(corruptedPath, semanticsReturningNoFact())
        try {
          reopenedCorrupt.owner.read()
          reopenedCorrupt.owner.snapshot({ fence: corruptedFence })
        } catch (error: unknown) {
          failure = error
        } finally {
          reopenedCorrupt.owner.close()
        }
      } catch (error: unknown) {
        failure = error
      }
      expect(failure, `${kind}:${field}`).toBeInstanceOf(Error)
    }
  })

  it('uses the real Telegram quote-first wrapper as an input boundary and exposes only the current user text downstream', async () => {
    const { buildIncomingUserText } = await import('../../telegram-gateway/src/telegram-contract.ts')
    const current = '当前用户 literal，不是引用'
    const wrapped = buildIncomingUserText(
      current,
      { message_id: 77, text: 'fallback quote' },
      { text: 'QUOTE_SECRET_CANARY' },
    )
    expect(wrapped).toContain('QUOTE_SECRET_CANARY')
    expect(wrapped).toContain(current)
    const query = makeQuery([summary(0, 'turn/start'), summary(1)], [userEvent(1, wrapped)])
    const adapter = await adapterFor(query)
    const observed = await adapter.observe()
    expect(observed.kind).toBe('complete')
    if (observed.kind !== 'complete') throw new Error('wrapped history unexpectedly incomplete')
    expect(observed.observation.messages.map(message => message.rawText)).toEqual([current])
    expect(JSON.stringify(observed.observation)).not.toContain('QUOTE_SECRET_CANARY')

    const semanticMaterials: unknown[] = []
    const semantics: SemanticPorts = {
      classifier: input => { semanticMaterials.push(input); return { kind: 'no_fact', reason: 'not_personal_fact' } },
      entailmentValidator: input => { semanticMaterials.push(input); return { kind: 'target_and_revision_confirmed' } },
      noFactValidator: input => { semanticMaterials.push(input); return { kind: 'confirmed_no_fact' } },
    }
    const fixture = await ownerFor(databasePath('personal-feed-v2-wrapper-'), semantics)
    const bootstrapped = await fixture.owner.bootstrap({ history: fakeHistoryAdapter(observed) })
    expect(bootstrapped).toMatchObject({ status: 'complete', importedSourceCount: 1 })
    const visible = JSON.stringify({ result: bootstrapped, read: fixture.owner.read(), semanticMaterials })
    expect(visible).toContain(current)
    expect(visible).not.toContain('QUOTE_SECRET_CANARY')
    expect(semanticMaterials.some(material => JSON.stringify(material).includes(current))).toBe(true)
    expect(fixture.owner.read().sources[0]?.rawText).toBeNull()
    fixture.owner.close()
  })

  it('accepts the real SessionHeader shape and returns history_changed when only a later header changes', async () => {
    const cases = [
      { name: 'stable', changed: false, mutation: undefined },
      { name: 'createdAt changed', changed: true, mutation: 'createdAt' as const },
      { name: 'cwd changed', changed: true, mutation: 'cwd' as const },
    ] as const
    for (const testCase of cases) {
      let listCalls = 0
      let readCalls = 0
      const firstEvent = userEventWithSessionHeader(1, `header ${testCase.name}`)
      const changedEvent = userEventWithSessionHeader(1, `header ${testCase.name}`, {
        ...(testCase.mutation === 'createdAt' ? { createdAt: Date.parse('2026-08-31T17:00:00.000Z') } : { cwd: '/home/herman/.dsh/other-workspace' }),
      })
      const query: SessionQuery = {
        listEvents: async () => {
          listCalls += 1
          return [summary(0, 'turn/start'), summary(1)]
        },
        readEvent: async input => {
          readCalls += 1
          return testCase.changed && readCalls > 1 ? changedEvent : firstEvent
        },
      }
      const adapter = await adapterFor(query)
      const result = await adapter.observe()
      if (!testCase.changed) {
        expect(result.kind, testCase.name).toBe('complete')
        if (result.kind === 'complete') expect(result.observation.messages[0]?.rawText).toBe(`header ${testCase.name}`)
      } else {
        expect(result, testCase.name).toEqual({ kind: 'unknown', reason: 'history_changed' })
      }
      expect(listCalls, testCase.name).toBe(2)
      expect(readCalls, testCase.name).toBe(2)
    }
  })

  it('keeps a complete cohort unknown throughout a settling crash window and resumes in place without observing history again', async () => {
    const history = completeHistory([
      { locator: { kind: 'telegram_session_history', sessionId, eventSeq: 1 }, rawText: '我关注可靠设计', occurredAt },
      { locator: { kind: 'telegram_session_history', sessionId, eventSeq: 2 }, rawText: '我知道可验证交付', occurredAt },
    ])
    const path = databasePath('personal-feed-v2-settling-crash-')
    const fixture = await ownerFor(path, sufficientSemantics())
    const bootstrapped = await fixture.owner.bootstrap({ history: fakeHistoryAdapter(history) })
    expect(bootstrapped).toMatchObject({ status: 'complete', importedSourceCount: 2 })
    const current = fixture.owner.capture({ locator: { kind: 'telegram_inbound', chatId: 700, messageId: 501 }, rawText: '当前请求没有事实', reference: null, excludedRequestId: 'telegram:700:501' }) as CaptureReceipt
    const fence = fixture.owner.freezeFence({ request: { requestId: 'telegram:700:501', cutoff: '2026-08-31T09:00:00.000Z', shanghaiDay: '2026-08-31' } })
    await fixture.owner.settle({ sourceKey: current.source.sourceKey })
    const baseline = fixture.owner.snapshot({ fence })
    expect((baseline as Record<string, unknown>).kind).toBe('sufficient')
    mutateCheckpointStatus(path, 'settling')
    expect(fixture.owner.snapshot({ fence })).toMatchObject({ kind: 'unknown', reason: 'coverage_incomplete' })
    fixture.owner.close()
    const reopened = await ownerFor(path, sufficientSemantics())
    expect(reopened.owner.snapshot({ fence })).toMatchObject({ kind: 'unknown', reason: 'coverage_incomplete' })
    const resumeHistory = fakeHistoryAdapter(history)
    await expect(reopened.owner.bootstrap({ history: resumeHistory })).resolves.toMatchObject({ status: 'complete' })
    expect(resumeHistory.calls.observe).toBe(0)
    expect(reopened.owner.snapshot({ fence })).toEqual(baseline)
    reopened.owner.close()
  })

  it('performs legacy v2/v3 semantic preflight before migration and leaves every mismatched database byte-for-byte unchanged', async () => {
    const cases = [
      { version: 2 as const, field: 'disposition_digest' },
      { version: 2 as const, field: 'payload_digest' },
      { version: 2 as const, field: 'source_key' },
      { version: 3 as const, field: 'disposition_digest' },
      { version: 3 as const, field: 'revision_digest' },
      { version: 3 as const, field: 'store_id' },
      { version: 3 as const, field: 'fence_digest' },
    ] as const
    for (const testCase of cases) {
      const path = databasePath(`personal-feed-v2-legacy-preflight-${testCase.version}-${testCase.field}-`)
      createLegacySchema(path, testCase.version)
      mutateLegacySemanticField(path, testCase.version, testCase.field)
      const before = legacyBytes(path)
      await expect(ownerFor(path), `${testCase.version}:${testCase.field}`).rejects.toThrow()
      expect(legacyBytes(path), `${testCase.version}:${testCase.field}`).toEqual(before)
    }
  })

  it('rejects a completed checkpoint whose actual history cohort is missing, before calling the history adapter', async () => {
    const cases = [
      { name: 'middle history source', deleteSeq: 2 },
      { name: 'last history source', deleteSeq: 3 },
      { name: 'correction-retraction decision source', deleteSeq: 1 },
    ] as const
    for (const testCase of cases) {
      const path = databasePath(`personal-feed-v2-cohort-${testCase.deleteSeq}-`)
      const history = completeHistory([
        { locator: { kind: 'telegram_session_history', sessionId, eventSeq: 1 }, rawText: '我关注主题 A', occurredAt },
        { locator: { kind: 'telegram_session_history', sessionId, eventSeq: 2 }, rawText: '我改为关注主题 B', occurredAt },
        { locator: { kind: 'telegram_session_history', sessionId, eventSeq: 3 }, rawText: '我撤回主题 B', occurredAt },
      ])
      const fixture = await ownerFor(path, semanticsReturningNoFact())
      await expect(fixture.owner.bootstrap({ history: fakeHistoryAdapter(history) })).resolves.toMatchObject({ status: 'complete' })
      deleteHistorySource(path, testCase.deleteSeq)
      try {
        expect(() => fixture.owner.read(), testCase.name).toThrow()
        const probe = fakeHistoryAdapter(history)
        await expect(fixture.owner.bootstrap({ history: probe }), testCase.name).rejects.toThrow()
        expect(probe.calls.observe, testCase.name).toBe(0)
      } finally {
        fixture.owner.close()
      }
      await expect(ownerFor(path), `${testCase.name}:factory`).rejects.toThrow()
    }
  })

  it('fails closed before every write entry point when stored integrity is damaged and preserves rows and raw input', async () => {
    const cases = [
      { name: 'capture store identity', field: 'store_id', operation: 'capture' as const },
      { name: 'capture checkpoint digest', field: 'checkpoint_digest', operation: 'capture-after-bootstrap' as const },
      { name: 'bootstrap store identity', field: 'store_id', operation: 'bootstrap' as const },
      { name: 'settle store identity', field: 'store_id', operation: 'settle' as const },
      { name: 'settle checkpoint digest', field: 'checkpoint_digest', operation: 'settle-after-bootstrap' as const },
      { name: 'freeze fence source digest', field: 'source_row_digest', operation: 'freezeFence' as const },
    ] as const
    for (const testCase of cases) {
      const path = databasePath(`personal-feed-v2-write-guard-${testCase.operation}-`)
      const classifierInputs: unknown[] = []
      const semantics: SemanticPorts = {
        classifier: input => { classifierInputs.push(input); return { kind: 'no_fact', reason: 'not_personal_fact' } },
        entailmentValidator: input => { classifierInputs.push(input); return { kind: 'target_and_revision_confirmed' } },
        noFactValidator: input => { classifierInputs.push(input); return { kind: 'confirmed_no_fact' } },
      }
      const fixture = await ownerFor(path, semantics)
      if (testCase.operation === 'capture-after-bootstrap' || testCase.operation === 'settle-after-bootstrap') {
        await fixture.owner.bootstrap({ history: fakeHistoryAdapter(completeHistory()) })
      }
      let before = applicationCounts(path)
      if (testCase.operation === 'bootstrap') {
        mutateIntegrity(path, [testCase.field])
        const probe = fakeHistoryAdapter(completeHistory([{ locator: { kind: 'telegram_session_history', sessionId, eventSeq: 1 }, rawText: 'CAPTURE_SECRET_CANARY', occurredAt }]))
        await expect(fixture.owner.bootstrap({ history: probe }), testCase.name).rejects.toThrow()
        expect(probe.calls.observe, testCase.name).toBe(0)
      } else if (testCase.operation === 'capture' || testCase.operation === 'capture-after-bootstrap') {
        mutateIntegrity(path, [testCase.field])
        await expect(Promise.resolve().then(() => fixture.owner.capture({ locator: { kind: 'telegram_inbound', chatId: 700, messageId: 601 }, rawText: 'CAPTURE_SECRET_CANARY', reference: null })), testCase.name).rejects.toThrow()
      } else if (testCase.operation === 'settle' || testCase.operation === 'settle-after-bootstrap') {
        const captured = fixture.owner.capture({ locator: { kind: 'telegram_inbound', chatId: 700, messageId: 602 }, rawText: 'CAPTURE_SECRET_CANARY', reference: null }) as CaptureReceipt
        before = applicationCounts(path)
        classifierInputs.splice(0)
        mutateIntegrity(path, [testCase.field])
        await expect(fixture.owner.settle({ sourceKey: captured.source.sourceKey }), testCase.name).rejects.toThrow()
        expect(classifierInputs, testCase.name).toHaveLength(0)
        expect(readFileSync(path).includes(Buffer.from('CAPTURE_SECRET_CANARY')), testCase.name).toBe(true)
      } else {
        fixture.owner.capture({ locator: { kind: 'telegram_inbound', chatId: 700, messageId: 603 }, rawText: 'freeze fence input', reference: null })
        before = applicationCounts(path)
        mutateIntegrity(path, [testCase.field])
        expect(() => fixture.owner.freezeFence({ request: { requestId: 'telegram:700:603', cutoff: '2026-08-31T09:00:00.000Z', shanghaiDay: '2026-08-31' } }), testCase.name).toThrow()
      }
      expect(applicationCounts(path), testCase.name).toEqual(before)
      expect(readFileSync(path).includes(Buffer.from('CAPTURE_SECRET_CANARY')), testCase.name).toBe(testCase.operation === 'settle' || testCase.operation === 'settle-after-bootstrap')
      fixture.owner.close()
    }
  })
})
