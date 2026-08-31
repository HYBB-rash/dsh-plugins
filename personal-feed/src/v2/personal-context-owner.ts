import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { dirname } from 'node:path'
import { encodeCanonicalJson } from '../canonical-json.ts'
import {
  PersonalFeedScopeConflictError,
  PersonalFeedScopeInputError,
  PersonalFeedScopeStoreError,
} from '../errors.ts'

const APPLICATION_ID = 0x50435632
const SCHEMA_VERSION = 1

export interface PersonalContextTelegramLocator {
  readonly kind: 'telegram_inbound'
  readonly chatId: number
  readonly messageId: number
}

export interface PersonalContextCaptureInput {
  readonly locator: PersonalContextTelegramLocator
  readonly rawText: string
  readonly reference: null
  readonly excludedRequestId?: string
}

export interface PersonalContextSource {
  readonly locator: PersonalContextTelegramLocator
  readonly rawText: string
  readonly reference: null
  readonly excludedRequestId?: string
  readonly occurredAt: string
  readonly sourceKey: string
  readonly captureSequence: number
}

export interface PersonalContextCoverage {
  readonly sourceKey: string
  readonly status: 'pending'
}

export interface PersonalContextCaptureResult {
  readonly source: PersonalContextSource
  readonly coverage: PersonalContextCoverage
}

export interface PersonalContextOwnerSnapshot {
  readonly sources: readonly PersonalContextSource[]
  readonly coverage: readonly PersonalContextCoverage[]
}

export interface PersonalContextOwner {
  readonly capture: (input: PersonalContextCaptureInput) => PersonalContextCaptureResult
  readonly read: () => PersonalContextOwnerSnapshot
  readonly close: () => void
}

export interface PersonalContextClock {
  readonly now: () => Date
}

export interface CreatePersonalContextOwnerOptions {
  readonly databasePath: string
  readonly clock: PersonalContextClock
}

type SourceRow = {
  readonly source_key: unknown
  readonly locator_kind: unknown
  readonly chat_id: unknown
  readonly message_id: unknown
  readonly raw_text: unknown
  readonly reference_json: unknown
  readonly excluded_request_id: unknown
  readonly occurred_at: unknown
  readonly capture_sequence: unknown
  readonly payload_digest: unknown
}

type CoverageRow = {
  readonly source_key: unknown
  readonly status: unknown
}

const SOURCE_COLUMNS = `
  source_key, locator_kind, chat_id, message_id, raw_text, reference_json,
  excluded_request_id, occurred_at, capture_sequence, payload_digest
`

const EXPECTED_TABLES = new Set(['personal_context_sources', 'personal_context_coverage'])
const EXPECTED_SOURCE_COLUMNS = [
  ['source_key', 'TEXT', 1, 1],
  ['locator_kind', 'TEXT', 1, 0],
  ['chat_id', 'INTEGER', 1, 0],
  ['message_id', 'INTEGER', 1, 0],
  ['raw_text', 'TEXT', 1, 0],
  ['reference_json', 'TEXT', 1, 0],
  ['excluded_request_id', 'TEXT', 0, 0],
  ['occurred_at', 'TEXT', 1, 0],
  ['capture_sequence', 'INTEGER', 1, 0],
  ['payload_digest', 'TEXT', 1, 0],
] as const
const EXPECTED_COVERAGE_COLUMNS = [
  ['source_key', 'TEXT', 1, 1],
  ['status', 'TEXT', 1, 0],
] as const

export function createPersonalContextOwner(options: CreatePersonalContextOwnerOptions): PersonalContextOwner {
  validateOptions(options)
  const database = openDatabase(options.databasePath)
  let closed = false

  const assertOpen = (): void => {
    if (closed) throw new PersonalFeedScopeStoreError('personal context owner is closed')
  }

  const read = (): PersonalContextOwnerSnapshot => {
    assertOpen()
    return readSnapshot(database, options.databasePath)
  }

  const capture = (input: PersonalContextCaptureInput): PersonalContextCaptureResult => {
    assertOpen()
    const parsed = validateCaptureInput(input)
    const sourceKey = sourceKeyFor(parsed.locator)
    const payloadDigest = payloadDigestFor(parsed)
    const existingBeforeTransaction = selectSource(database, parsed.locator)
    if (existingBeforeTransaction !== undefined) {
      return readExistingCapture(database, existingBeforeTransaction, payloadDigest)
    }
    let began = false
    try {
      database.exec('BEGIN IMMEDIATE')
      began = true
      // Recheck after acquiring the write lock for a concurrent first capture.
      // The ordinary replay/conflict path above remains a pure read.
      const existing = selectSource(database, parsed.locator)
      if (existing !== undefined) {
        const result = readExistingCapture(database, existing, payloadDigest)
        database.exec('ROLLBACK')
        began = false
        return result
      }

      const occurredAt = readClock(options.clock)
      const nextSequence = (database.prepare(
        'SELECT COALESCE(MAX(capture_sequence), 0) + 1 AS next_sequence FROM personal_context_sources',
      ).get() as { readonly next_sequence: unknown }).next_sequence
      if (typeof nextSequence !== 'number' || !Number.isSafeInteger(nextSequence) || nextSequence <= 0) {
        throw new PersonalFeedScopeStoreError('personal context capture sequence is not a positive safe integer')
      }
      database.prepare(`
        INSERT INTO personal_context_sources (
          source_key, locator_kind, chat_id, message_id, raw_text, reference_json,
          excluded_request_id, occurred_at, capture_sequence, payload_digest
        ) VALUES (?, ?, ?, ?, ?, 'null', ?, ?, ?, ?)
      `).run(
        sourceKey,
        parsed.locator.kind,
        parsed.locator.chatId,
        parsed.locator.messageId,
        parsed.rawText,
        parsed.excludedRequestId ?? null,
        occurredAt,
        nextSequence,
        payloadDigest,
      )
      database.prepare(
        "INSERT INTO personal_context_coverage (source_key, status) VALUES (?, 'pending')",
      ).run(sourceKey)
      const source = database.prepare(
        `SELECT ${SOURCE_COLUMNS} FROM personal_context_sources WHERE source_key = ?`,
      ).get(sourceKey) as SourceRow | undefined
      const coverage = database.prepare(
        'SELECT source_key, status FROM personal_context_coverage WHERE source_key = ?',
      ).get(sourceKey) as CoverageRow | undefined
      if (source === undefined || coverage === undefined) {
        throw new PersonalFeedScopeStoreError('personal context capture did not persist source and coverage')
      }
      const result = captureResultFromRows(source, coverage)
      database.exec('COMMIT')
      began = false
      return result
    } catch (error: unknown) {
      if (began) {
        try {
          database.exec('ROLLBACK')
        } catch {
          // Preserve the original failure.
        }
      }
      throw error
    }
  }

  const close = (): void => {
    if (closed) return
    closed = true
    database.close()
  }

  return Object.freeze({ capture, read, close })
}

function selectSource(database: DatabaseSync, locator: PersonalContextTelegramLocator): SourceRow | undefined {
  return database.prepare(
    `SELECT ${SOURCE_COLUMNS} FROM personal_context_sources WHERE locator_kind = ? AND chat_id = ? AND message_id = ?`,
  ).get(locator.kind, locator.chatId, locator.messageId) as SourceRow | undefined
}

function readExistingCapture(database: DatabaseSync, existing: SourceRow, payloadDigest: string): PersonalContextCaptureResult {
  if (existing.payload_digest !== payloadDigest) {
    throw new PersonalFeedScopeConflictError('personal context source locator has a conflicting payload')
  }
  if (!isStableSourceKey(existing.source_key)) {
    throw new PersonalFeedScopeStoreError('personal context source key is invalid')
  }
  const coverage = database.prepare(
    'SELECT source_key, status FROM personal_context_coverage WHERE source_key = ?',
  ).get(existing.source_key) as CoverageRow | undefined
  if (coverage === undefined) {
    throw new PersonalFeedScopeStoreError('personal context source is missing coverage')
  }
  return captureResultFromRows(existing, coverage)
}

function openDatabase(path: string): DatabaseSync {
  const wasMissing = !existsSync(path)
  const parent = dirname(path)
  mkdirSync(parent, { recursive: true, mode: 0o700 })
  chmodSync(parent, 0o700)
  let database: DatabaseSync | undefined
  try {
    database = new DatabaseSync(path)
    chmodSync(path, 0o600)
    configureDatabase(database, path, wasMissing)
    return database
  } catch (error: unknown) {
    try {
      database?.close()
    } catch {
      // Preserve the original open/schema failure.
    }
    throw error
  }
}

function configureDatabase(database: DatabaseSync, path: string, wasMissing: boolean): void {
  database.exec('PRAGMA foreign_keys = ON')
  database.exec('PRAGMA busy_timeout = 5000')
  let began = false
  try {
    database.exec('BEGIN IMMEDIATE')
    began = true
    const userVersion = (database.prepare('PRAGMA user_version').get() as { readonly user_version: unknown }).user_version
    const applicationId = (database.prepare('PRAGMA application_id').get() as { readonly application_id: unknown }).application_id
    const objects = database.prepare(
      "SELECT name, type FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name",
    ).all() as Array<{ readonly name: unknown; readonly type: unknown }>
    if (!wasMissing || userVersion !== 0 || applicationId !== 0 || objects.length !== 0) {
      if (userVersion !== SCHEMA_VERSION || applicationId !== APPLICATION_ID) {
        throw new PersonalFeedScopeStoreError(`personal context database at "${path}" has an unsupported identity or schema version`)
      }
      assertSchema(database, path, objects)
    } else {
      createSchema(database)
      database.exec(`PRAGMA application_id = ${APPLICATION_ID}`)
      database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
      assertSchema(database, path)
    }
    database.exec('COMMIT')
    began = false
  } catch (error: unknown) {
    if (began) {
      try {
        database.exec('ROLLBACK')
      } catch {
        // Preserve the original schema failure.
      }
    }
    throw error
  }
}

function createSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE personal_context_sources (
      source_key TEXT PRIMARY KEY,
      locator_kind TEXT NOT NULL CHECK (locator_kind = 'telegram_inbound'),
      chat_id INTEGER NOT NULL CHECK (chat_id <> 0),
      message_id INTEGER NOT NULL CHECK (message_id > 0),
      raw_text TEXT NOT NULL,
      reference_json TEXT NOT NULL CHECK (reference_json = 'null'),
      excluded_request_id TEXT,
      occurred_at TEXT NOT NULL,
      capture_sequence INTEGER NOT NULL UNIQUE,
      payload_digest TEXT NOT NULL,
      UNIQUE (locator_kind, chat_id, message_id)
    ) STRICT;

    CREATE TABLE personal_context_coverage (
      source_key TEXT PRIMARY KEY REFERENCES personal_context_sources(source_key),
      status TEXT NOT NULL CHECK (status = 'pending')
    ) STRICT;
  `)
}

function assertSchema(
  database: DatabaseSync,
  path: string,
  knownObjects?: readonly { readonly name: unknown; readonly type: unknown }[],
): void {
  const objects = knownObjects ?? database.prepare(
    "SELECT name, type FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name",
  ).all() as Array<{ readonly name: unknown; readonly type: unknown }>
  if (objects.length !== EXPECTED_TABLES.size || objects.some(object => object.type !== 'table' || typeof object.name !== 'string' || !EXPECTED_TABLES.has(object.name))) {
    throw new PersonalFeedScopeStoreError(`personal context database at "${path}" has unknown or missing schema objects`)
  }
  assertTable(database, path, 'personal_context_sources', EXPECTED_SOURCE_COLUMNS)
  assertTable(database, path, 'personal_context_coverage', EXPECTED_COVERAGE_COLUMNS)
  const sourceSql = (database.prepare(
    "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'personal_context_sources'",
  ).get() as { readonly sql: unknown } | undefined)?.sql
  const coverageSql = (database.prepare(
    "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'personal_context_coverage'",
  ).get() as { readonly sql: unknown } | undefined)?.sql
  if (typeof sourceSql !== 'string' || typeof coverageSql !== 'string' || !/\bSTRICT\b/i.test(sourceSql) || !/\bSTRICT\b/i.test(coverageSql)) {
    throw new PersonalFeedScopeStoreError(`personal context database at "${path}" has a non-strict schema`)
  }
  const normalizedSourceSql = sourceSql.replaceAll(/\s+/g, ' ').toLowerCase()
  const normalizedCoverageSql = coverageSql.replaceAll(/\s+/g, ' ').toLowerCase()
  if (!normalizedSourceSql.includes("check (locator_kind = 'telegram_inbound')")
    || !normalizedSourceSql.includes('capture_sequence integer not null unique')
    || !normalizedSourceSql.includes('unique (locator_kind, chat_id, message_id)')
    || !normalizedSourceSql.includes("check (reference_json = 'null')")
    || !normalizedCoverageSql.includes('references personal_context_sources(source_key)')
    || !normalizedCoverageSql.includes("check (status = 'pending')")) {
    throw new PersonalFeedScopeStoreError(`personal context database at "${path}" has invalid schema constraints`)
  }
}

function assertTable(
  database: DatabaseSync,
  path: string,
  table: string,
  expected: readonly (readonly [string, string, number, number])[],
): void {
  const rows = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    readonly name: unknown
    readonly type: unknown
    readonly notnull: unknown
    readonly pk: unknown
  }>
  if (rows.length !== expected.length || rows.some((row, index) => {
    const wanted = expected[index]
    return wanted === undefined || row.name !== wanted[0] || row.type !== wanted[1] || row.notnull !== wanted[2] || row.pk !== wanted[3]
  })) {
    throw new PersonalFeedScopeStoreError(`personal context database at "${path}" has an invalid ${table} definition`)
  }
}

function validateOptions(options: CreatePersonalContextOwnerOptions): void {
  if (!isRecord(options) || !hasExactlyKeys(options, ['databasePath', 'clock'])) {
    throw new PersonalFeedScopeInputError('personal context owner options have an unsupported shape')
  }
  if (typeof options.databasePath !== 'string' || options.databasePath.trim() === '') {
    throw new PersonalFeedScopeInputError('personal context database path must be non-empty')
  }
  if (!isRecord(options.clock) || !hasExactlyKeys(options.clock, ['now']) || typeof options.clock.now !== 'function') {
    throw new PersonalFeedScopeInputError('personal context owner clock is invalid')
  }
}

function validateCaptureInput(input: PersonalContextCaptureInput): PersonalContextCaptureInput {
  if (!isRecord(input) || !hasExactlyKeys(input, ['locator', 'rawText', 'reference', 'excludedRequestId'], ['excludedRequestId'])) {
    throw new PersonalFeedScopeInputError('personal context capture input has an unsupported shape')
  }
  if (!isRecord(input.locator) || !hasExactlyKeys(input.locator, ['kind', 'chatId', 'messageId'])) {
    throw new PersonalFeedScopeInputError('personal context Telegram locator is invalid')
  }
  if (input.locator.kind !== 'telegram_inbound' || !isSafeNonZeroInteger(input.locator.chatId) || !isSafePositiveInteger(input.locator.messageId)) {
    throw new PersonalFeedScopeInputError('personal context Telegram locator has invalid identifiers')
  }
  if (typeof input.rawText !== 'string' || input.rawText.trim() === '') {
    throw new PersonalFeedScopeInputError('personal context raw text must be non-blank')
  }
  if (input.reference !== null) {
    throw new PersonalFeedScopeInputError('personal context reference must be null')
  }
  const excludedPresent = Object.prototype.hasOwnProperty.call(input, 'excludedRequestId')
  if (excludedPresent) {
    if (typeof input.excludedRequestId !== 'string' || input.excludedRequestId === '') {
      throw new PersonalFeedScopeInputError('personal context excluded request id is invalid')
    }
    const expected = requestIdFor(input.locator)
    if (input.excludedRequestId !== expected) {
      throw new PersonalFeedScopeInputError('personal context excluded request id does not match locator')
    }
  }
  return input
}

function readClock(clock: PersonalContextClock): string {
  let now: Date
  try {
    now = clock.now()
  } catch (cause) {
    throw new PersonalFeedScopeStoreError('personal context owner clock failed', { cause })
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new PersonalFeedScopeStoreError('personal context owner clock did not return a valid Date')
  }
  return now.toISOString()
}

function readSnapshot(database: DatabaseSync, path: string): PersonalContextOwnerSnapshot {
  const rows = database.prepare(`SELECT ${SOURCE_COLUMNS} FROM personal_context_sources ORDER BY capture_sequence`).all() as SourceRow[]
  const coverageRows = database.prepare(
    'SELECT source_key, status FROM personal_context_coverage ORDER BY source_key',
  ).all() as CoverageRow[]
  if (coverageRows.length !== rows.length) {
    throw new PersonalFeedScopeStoreError(`personal context database at "${path}" has incomplete source coverage`)
  }
  const coverageByKey = new Map<string, CoverageRow>()
  for (const row of coverageRows) {
    if (typeof row.source_key !== 'string' || coverageByKey.has(row.source_key)) {
      throw new PersonalFeedScopeStoreError(`personal context database at "${path}" has invalid coverage rows`)
    }
    coverageByKey.set(row.source_key, row)
  }
  const sources: PersonalContextSource[] = []
  const coverage: PersonalContextCoverage[] = []
  for (const row of rows) {
    const rowCoverage = typeof row.source_key === 'string' ? coverageByKey.get(row.source_key) : undefined
    if (rowCoverage === undefined) throw new PersonalFeedScopeStoreError(`personal context database at "${path}" has source without coverage`)
    const source = sourceFromRow(row)
    sources.push(source)
    coverage.push(coverageFromRow(rowCoverage))
    coverageByKey.delete(row.source_key as string)
  }
  if (coverageByKey.size !== 0) throw new PersonalFeedScopeStoreError(`personal context database at "${path}" has coverage without source`)
  return deepFreeze({ sources, coverage })
}

function captureResultFromRows(sourceRow: SourceRow, coverageRow: CoverageRow): PersonalContextCaptureResult {
  if (coverageRow.source_key !== sourceRow.source_key) {
    throw new PersonalFeedScopeStoreError('personal context coverage does not belong to source')
  }
  return deepFreeze({ source: sourceFromRow(sourceRow), coverage: coverageFromRow(coverageRow) })
}

function sourceFromRow(row: SourceRow): PersonalContextSource {
  if (row.locator_kind !== 'telegram_inbound' || !isSafeNonZeroInteger(row.chat_id) || !isSafePositiveInteger(row.message_id) || typeof row.raw_text !== 'string' || row.raw_text.trim() === '' || row.reference_json !== 'null' || typeof row.occurred_at !== 'string' || !isCanonicalIso(row.occurred_at) || typeof row.source_key !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(row.source_key) || !isSafePositiveInteger(row.capture_sequence) || typeof row.payload_digest !== 'string') {
    throw new PersonalFeedScopeStoreError('personal context source row is invalid')
  }
  const locator: PersonalContextTelegramLocator = { kind: 'telegram_inbound', chatId: row.chat_id, messageId: row.message_id }
  if (row.source_key !== sourceKeyFor(locator)) throw new PersonalFeedScopeStoreError('personal context source key is invalid')
  const excludedRequestId = row.excluded_request_id
  if (excludedRequestId !== null && (typeof excludedRequestId !== 'string' || excludedRequestId !== requestIdFor(locator))) {
    throw new PersonalFeedScopeStoreError('personal context excluded request id is invalid')
  }
  const payload: PersonalContextCaptureInput = excludedRequestId === null
    ? { locator, rawText: row.raw_text, reference: null }
    : { locator, rawText: row.raw_text, reference: null, excludedRequestId }
  if (row.payload_digest !== payloadDigestFor(payload)) throw new PersonalFeedScopeStoreError('personal context payload digest is invalid')
  return excludedRequestId === null
    ? { locator, rawText: row.raw_text, reference: null, occurredAt: row.occurred_at, sourceKey: row.source_key, captureSequence: row.capture_sequence }
    : { locator, rawText: row.raw_text, reference: null, excludedRequestId, occurredAt: row.occurred_at, sourceKey: row.source_key, captureSequence: row.capture_sequence }
}

function coverageFromRow(row: CoverageRow): PersonalContextCoverage {
  if (typeof row.source_key !== 'string' || row.status !== 'pending') throw new PersonalFeedScopeStoreError('personal context coverage row is invalid')
  return { sourceKey: row.source_key, status: 'pending' }
}

function sourceKeyFor(locator: PersonalContextTelegramLocator): string {
  const canonical = encodeCanonicalJson(locator)
  if (canonical === undefined) throw new PersonalFeedScopeInputError('personal context locator is not canonical JSON')
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`
}

function isStableSourceKey(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value)
}

function payloadDigestFor(input: PersonalContextCaptureInput): string {
  const value = Object.prototype.hasOwnProperty.call(input, 'excludedRequestId')
    ? { rawText: input.rawText, reference: input.reference, excludedRequestId: input.excludedRequestId }
    : { rawText: input.rawText, reference: input.reference }
  const canonical = encodeCanonicalJson(value)
  if (canonical === undefined) throw new PersonalFeedScopeInputError('personal context payload is not canonical JSON')
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

function requestIdFor(locator: PersonalContextTelegramLocator): string {
  return `telegram:${locator.chatId}:${locator.messageId}`
}

function isSafeNonZeroInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value !== 0
}

function isSafePositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isCanonicalIso(value: string): boolean {
  try {
    return new Date(value).toISOString() === value
  } catch {
    return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactlyKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const ownKeys = Reflect.ownKeys(value)
  if (ownKeys.some(key => typeof key !== 'string')) return false
  const allowed = new Set([...required, ...optional])
  const keys = ownKeys as string[]
  if (keys.some(key => !allowed.has(key))) return false
  return required.every(key => Object.prototype.hasOwnProperty.call(value, key))
    && keys.length >= required.length
    && keys.length <= required.length + optional.length
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  return value
}
