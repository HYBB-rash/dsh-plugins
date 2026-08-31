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
import {
  PERSONAL_CONTEXT_USE_AUTHORIZATION,
  parseClassifierOutput,
  parseEntailmentApproval,
  parseNoFactApproval,
  parseTerminalDisposition,
  prepareFact,
  type PersonalContextSemanticPorts,
  type PersonalContextTerminalDisposition,
  type PersonalContextTerminalFact,
} from './personal-context-semantics.ts'

export {
  PERSONAL_CONTEXT_USE_AUTHORIZATION,
  type PersonalContextAttitude,
  type PersonalContextCanonicalFact,
  type PersonalContextClassifierInput,
  type PersonalContextEntailmentInput,
  type PersonalContextEntailmentTarget,
  type PersonalContextFactProposal,
  type PersonalContextNoFactInput,
  type PersonalContextNoFactReason,
  type PersonalContextProtectedSpans,
  type PersonalContextSemanticPorts,
  type PersonalContextSpan,
  type PersonalContextTerminalDisposition,
  type PersonalContextTerminalEvidence,
  type PersonalContextTerminalFact,
  type PersonalContextUseAuthorization,
} from './personal-context-semantics.ts'

const APPLICATION_ID = 0x50435632
const SCHEMA_VERSION = 2

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
  readonly rawText: string | null
  readonly reference: null
  readonly excludedRequestId?: string
  readonly occurredAt: string
  readonly sourceKey: string
  readonly captureSequence: number
}

export interface PersonalContextPendingCoverage {
  readonly sourceKey: string
  readonly status: 'pending'
}

export interface PersonalContextTerminalCoverage {
  readonly sourceKey: string
  readonly status: 'applied' | 'ignored'
  readonly disposition: PersonalContextTerminalDisposition
}

export type PersonalContextCoverage = PersonalContextPendingCoverage | PersonalContextTerminalCoverage

export interface PersonalContextSettleInput {
  readonly sourceKey: string
  readonly signal?: AbortSignal
}

export type PersonalContextSettleResult =
  | PersonalContextCoverage
  | {
      readonly sourceKey: string
      readonly status: 'pending'
      readonly reason: 'semantics_unavailable' | 'aborted' | 'semantic_validation_failed'
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
  readonly settle: (input: PersonalContextSettleInput) => Promise<PersonalContextSettleResult>
  readonly read: () => PersonalContextOwnerSnapshot
  readonly close: () => void
}

export interface PersonalContextClock {
  readonly now: () => Date
}

export interface CreatePersonalContextOwnerOptions {
  readonly databasePath: string
  readonly clock: PersonalContextClock
  readonly semantics?: PersonalContextSemanticPorts
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
  readonly disposition_json: unknown
  readonly disposition_digest: unknown
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
  ['raw_text', 'TEXT', 0, 0],
  ['reference_json', 'TEXT', 1, 0],
  ['excluded_request_id', 'TEXT', 0, 0],
  ['occurred_at', 'TEXT', 1, 0],
  ['capture_sequence', 'INTEGER', 1, 0],
  ['payload_digest', 'TEXT', 1, 0],
] as const
const EXPECTED_COVERAGE_COLUMNS = [
  ['source_key', 'TEXT', 1, 1],
  ['status', 'TEXT', 1, 0],
  ['disposition_json', 'TEXT', 0, 0],
  ['disposition_digest', 'TEXT', 0, 0],
] as const

const COVERAGE_COLUMNS = 'source_key, status, disposition_json, disposition_digest'

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
        `SELECT ${COVERAGE_COLUMNS} FROM personal_context_coverage WHERE source_key = ?`,
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

  const settle = async (input: PersonalContextSettleInput): Promise<PersonalContextSettleResult> => {
    assertOpen()
    const parsed = validateSettleInput(input)
    const initial = selectSourceAndCoverage(database, parsed.sourceKey)
    if (initial === undefined) throw new PersonalFeedScopeInputError('personal context settle source does not exist')
    const initialCoverage = coverageFromRow(initial.coverage)
    const initialSource = sourceFromRow(initial.source, initialCoverage)
    if (initialCoverage.status !== 'pending') return initialCoverage
    if (isAbortRequested(parsed.signal)) return pendingSettleResult(parsed.sourceKey, 'aborted')
    if (options.semantics === undefined) return pendingSettleResult(parsed.sourceKey, 'semantics_unavailable')
    if (initialSource.rawText === null) throw new PersonalFeedScopeStoreError('pending personal context source is missing raw text')

    const rawText = initialSource.rawText
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (isAbortRequested(parsed.signal)) return pendingSettleResult(parsed.sourceKey, 'aborted')
      const classifierInput = deepFreeze({
        sourceKey: parsed.sourceKey,
        rawText,
        useAuthorization: PERSONAL_CONTEXT_USE_AUTHORIZATION,
      })
      let classifierAwaited: AwaitedSemanticPort<unknown>
      try {
        classifierAwaited = await awaitSemanticPort(options.semantics.classifier(classifierInput), parsed.signal)
      } catch {
        if (isAbortRequested(parsed.signal)) return pendingSettleResult(parsed.sourceKey, 'aborted')
        continue
      }
      if (classifierAwaited.aborted) return pendingSettleResult(parsed.sourceKey, 'aborted')
      const proposal = parseClassifierOutput(classifierAwaited.value, rawText)
      if (proposal === undefined) continue

      if (proposal.kind === 'no_fact') {
        const validatorInput = deepFreeze({
          fullRawText: rawText,
          proposedReason: proposal.reason,
          useAuthorization: PERSONAL_CONTEXT_USE_AUTHORIZATION,
        })
        let validationAwaited: AwaitedSemanticPort<unknown>
        try {
          validationAwaited = await awaitSemanticPort(options.semantics.noFactValidator(validatorInput), parsed.signal)
        } catch {
          if (isAbortRequested(parsed.signal)) return pendingSettleResult(parsed.sourceKey, 'aborted')
          continue
        }
        if (validationAwaited.aborted) return pendingSettleResult(parsed.sourceKey, 'aborted')
        if (!parseNoFactApproval(validationAwaited.value)) continue
        if (isAbortRequested(parsed.signal)) return pendingSettleResult(parsed.sourceKey, 'aborted')
        return persistTerminalDisposition(
          database,
          options.databasePath,
          initial.source,
          { schemaVersion: 1, status: 'ignored', reason: proposal.reason },
        )
      }

      const facts: PersonalContextTerminalFact[] = []
      for (const factProposal of proposal.facts) {
        const prepared = prepareFact(factProposal, rawText, parsed.sourceKey)
        if (prepared === undefined) {
          if (isAbortRequested(parsed.signal)) return pendingSettleResult(parsed.sourceKey, 'aborted')
          return pendingSettleResult(parsed.sourceKey, 'semantic_validation_failed')
        }
        const validatorInput = deepFreeze(prepared.validatorInput)
        let validationAwaited: AwaitedSemanticPort<unknown>
        try {
          validationAwaited = await awaitSemanticPort(
            options.semantics.entailmentValidator(validatorInput),
            parsed.signal,
          )
        } catch {
          if (isAbortRequested(parsed.signal)) return pendingSettleResult(parsed.sourceKey, 'aborted')
          return pendingSettleResult(parsed.sourceKey, 'semantic_validation_failed')
        }
        if (validationAwaited.aborted) return pendingSettleResult(parsed.sourceKey, 'aborted')
        if (!parseEntailmentApproval(validationAwaited.value)) {
          if (isAbortRequested(parsed.signal)) return pendingSettleResult(parsed.sourceKey, 'aborted')
          return pendingSettleResult(parsed.sourceKey, 'semantic_validation_failed')
        }
        facts.push(prepared.terminalFact)
      }
      if (isAbortRequested(parsed.signal)) return pendingSettleResult(parsed.sourceKey, 'aborted')
      return persistTerminalDisposition(
        database,
        options.databasePath,
        initial.source,
        { schemaVersion: 1, status: 'applied', facts },
      )
    }
    return pendingSettleResult(parsed.sourceKey, 'semantic_validation_failed')
  }

  return Object.freeze({ capture, settle, read, close })
}

function selectSource(database: DatabaseSync, locator: PersonalContextTelegramLocator): SourceRow | undefined {
  return database.prepare(
    `SELECT ${SOURCE_COLUMNS} FROM personal_context_sources WHERE locator_kind = ? AND chat_id = ? AND message_id = ?`,
  ).get(locator.kind, locator.chatId, locator.messageId) as SourceRow | undefined
}

function selectSourceAndCoverage(
  database: DatabaseSync,
  sourceKey: string,
): { readonly source: SourceRow; readonly coverage: CoverageRow } | undefined {
  const source = database.prepare(
    `SELECT ${SOURCE_COLUMNS} FROM personal_context_sources WHERE source_key = ?`,
  ).get(sourceKey) as SourceRow | undefined
  if (source === undefined) return undefined
  const coverage = database.prepare(
    `SELECT ${COVERAGE_COLUMNS} FROM personal_context_coverage WHERE source_key = ?`,
  ).get(sourceKey) as CoverageRow | undefined
  if (coverage === undefined) throw new PersonalFeedScopeStoreError('personal context source is missing coverage')
  return { source, coverage }
}

function persistTerminalDisposition(
  database: DatabaseSync,
  databasePath: string,
  originalSource: SourceRow,
  disposition: PersonalContextTerminalDisposition,
): PersonalContextTerminalCoverage {
  if (!isStableSourceKey(originalSource.source_key)) {
    throw new PersonalFeedScopeStoreError('personal context source key is invalid before terminal persistence')
  }
  const dispositionJson = dispositionJsonFor(disposition)
  const dispositionDigest = dispositionDigestForJson(dispositionJson)
  let began = false
  try {
    database.exec('BEGIN IMMEDIATE')
    began = true
    const current = selectSourceAndCoverage(database, originalSource.source_key)
    if (current === undefined) throw new PersonalFeedScopeStoreError('personal context source disappeared before terminal persistence')
    const currentCoverage = coverageFromRow(current.coverage)
    if (currentCoverage.status !== 'pending') {
      database.exec('ROLLBACK')
      began = false
      return currentCoverage
    }
    const currentSource = sourceFromRow(current.source, currentCoverage)
    if (currentSource.rawText === null
      || current.source.payload_digest !== originalSource.payload_digest
      || current.source.raw_text !== originalSource.raw_text
      || current.source.locator_kind !== originalSource.locator_kind
      || current.source.chat_id !== originalSource.chat_id
      || current.source.message_id !== originalSource.message_id
      || current.source.capture_sequence !== originalSource.capture_sequence) {
      throw new PersonalFeedScopeStoreError('personal context source changed during semantic settlement')
    }
    const coverageUpdate = database.prepare(`
      UPDATE personal_context_coverage
      SET status = ?, disposition_json = ?, disposition_digest = ?
      WHERE source_key = ? AND status = 'pending'
    `).run(disposition.status, dispositionJson, dispositionDigest, originalSource.source_key)
    const sourceUpdate = database.prepare(`
      UPDATE personal_context_sources
      SET raw_text = NULL
      WHERE source_key = ? AND raw_text IS NOT NULL
    `).run(originalSource.source_key)
    if (coverageUpdate.changes !== 1 || sourceUpdate.changes !== 1) {
      throw new PersonalFeedScopeStoreError('personal context terminal persistence did not update one source atomically')
    }
    const persisted = selectSourceAndCoverage(database, originalSource.source_key)
    if (persisted === undefined) throw new PersonalFeedScopeStoreError('personal context terminal source disappeared')
    const persistedCoverage = coverageFromRow(persisted.coverage)
    sourceFromRow(persisted.source, persistedCoverage)
    if (persistedCoverage.status === 'pending') throw new PersonalFeedScopeStoreError('personal context terminal coverage remained pending')
    database.exec('COMMIT')
    began = false
    return persistedCoverage
  } catch (cause) {
    if (began) {
      try {
        database.exec('ROLLBACK')
      } catch {
        // Preserve the original failure.
      }
    }
    if (cause instanceof PersonalFeedScopeStoreError) throw cause
    throw new PersonalFeedScopeStoreError(`personal context terminal persistence failed at "${databasePath}"`, { cause })
  }
}

function pendingSettleResult(
  sourceKey: string,
  reason: 'semantics_unavailable' | 'aborted' | 'semantic_validation_failed',
): PersonalContextSettleResult {
  return deepFreeze({ sourceKey, status: 'pending', reason })
}

async function awaitSemanticPort<T>(
  value: T | PromiseLike<T>,
  signal: AbortSignal | undefined,
): Promise<AwaitedSemanticPort<T>> {
  if (signal === undefined) return { aborted: false, value: await value }
  if (signal.aborted) return { aborted: true }
  return await new Promise((resolve, reject) => {
    let finished = false
    const finish = (result: { readonly aborted: true } | { readonly aborted: false; readonly value: T }): void => {
      if (finished) return
      finished = true
      signal.removeEventListener('abort', abort)
      resolve(result)
    }
    const abort = (): void => finish({ aborted: true })
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve(value).then(
      result => finish({ aborted: false, value: result }),
      error => {
        if (finished) return
        finished = true
        signal.removeEventListener('abort', abort)
        reject(error)
      },
    )
  })
}

type AwaitedSemanticPort<T> = { readonly aborted: true } | { readonly aborted: false; readonly value: T }

function isAbortRequested(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

function readExistingCapture(database: DatabaseSync, existing: SourceRow, payloadDigest: string): PersonalContextCaptureResult {
  if (existing.payload_digest !== payloadDigest) {
    throw new PersonalFeedScopeConflictError('personal context source locator has a conflicting payload')
  }
  if (!isStableSourceKey(existing.source_key)) {
    throw new PersonalFeedScopeStoreError('personal context source key is invalid')
  }
  const coverage = database.prepare(
    `SELECT ${COVERAGE_COLUMNS} FROM personal_context_coverage WHERE source_key = ?`,
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
      disposition_digest TEXT,
      CHECK (
        (status = 'pending' AND disposition_json IS NULL AND disposition_digest IS NULL)
        OR
        (status IN ('applied', 'ignored') AND disposition_json IS NOT NULL AND disposition_digest IS NOT NULL)
      )
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
    || !normalizedCoverageSql.includes("status text not null check (status in ('pending', 'applied', 'ignored'))")
    || !normalizedCoverageSql.includes("status = 'pending' and disposition_json is null and disposition_digest is null")
    || !normalizedCoverageSql.includes("status in ('applied', 'ignored') and disposition_json is not null and disposition_digest is not null")) {
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
  if (!isRecord(options) || !hasExactlyKeys(options, ['databasePath', 'clock'], ['semantics'])) {
    throw new PersonalFeedScopeInputError('personal context owner options have an unsupported shape')
  }
  if (typeof options.databasePath !== 'string' || options.databasePath.trim() === '') {
    throw new PersonalFeedScopeInputError('personal context database path must be non-empty')
  }
  if (!isRecord(options.clock) || !hasExactlyKeys(options.clock, ['now']) || typeof options.clock.now !== 'function') {
    throw new PersonalFeedScopeInputError('personal context owner clock is invalid')
  }
  if (Object.prototype.hasOwnProperty.call(options, 'semantics')) {
    if (!isRecord(options.semantics)
      || !hasExactlyKeys(options.semantics, ['classifier', 'entailmentValidator', 'noFactValidator'])
      || typeof options.semantics.classifier !== 'function'
      || typeof options.semantics.entailmentValidator !== 'function'
      || typeof options.semantics.noFactValidator !== 'function') {
      throw new PersonalFeedScopeInputError('personal context semantic ports are invalid')
    }
  }
}

function validateSettleInput(input: PersonalContextSettleInput): PersonalContextSettleInput {
  if (!isRecord(input) || !hasExactlyKeys(input, ['sourceKey'], ['signal'])) {
    throw new PersonalFeedScopeInputError('personal context settle input has an unsupported shape')
  }
  if (!isStableSourceKey(input.sourceKey)) {
    throw new PersonalFeedScopeInputError('personal context settle source key is invalid')
  }
  if (Object.prototype.hasOwnProperty.call(input, 'signal') && !(input.signal instanceof AbortSignal)) {
    throw new PersonalFeedScopeInputError('personal context settle abort signal is invalid')
  }
  return input
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
    `SELECT ${COVERAGE_COLUMNS} FROM personal_context_coverage ORDER BY source_key`,
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
    const parsedCoverage = coverageFromRow(rowCoverage)
    const source = sourceFromRow(row, parsedCoverage)
    sources.push(source)
    coverage.push(parsedCoverage)
    coverageByKey.delete(row.source_key as string)
  }
  if (coverageByKey.size !== 0) throw new PersonalFeedScopeStoreError(`personal context database at "${path}" has coverage without source`)
  return deepFreeze({ sources, coverage })
}

function captureResultFromRows(sourceRow: SourceRow, coverageRow: CoverageRow): PersonalContextCaptureResult {
  if (coverageRow.source_key !== sourceRow.source_key) {
    throw new PersonalFeedScopeStoreError('personal context coverage does not belong to source')
  }
  const coverage = coverageFromRow(coverageRow)
  return deepFreeze({ source: sourceFromRow(sourceRow, coverage), coverage })
}

function sourceFromRow(row: SourceRow, coverage: PersonalContextCoverage): PersonalContextSource {
  if (row.locator_kind !== 'telegram_inbound' || !isSafeNonZeroInteger(row.chat_id) || !isSafePositiveInteger(row.message_id) || (row.raw_text !== null && (typeof row.raw_text !== 'string' || row.raw_text.trim() === '')) || row.reference_json !== 'null' || typeof row.occurred_at !== 'string' || !isCanonicalIso(row.occurred_at) || typeof row.source_key !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(row.source_key) || !isSafePositiveInteger(row.capture_sequence) || typeof row.payload_digest !== 'string' || !/^[0-9a-f]{64}$/.test(row.payload_digest)) {
    throw new PersonalFeedScopeStoreError('personal context source row is invalid')
  }
  if (coverage.sourceKey !== row.source_key
    || (coverage.status === 'pending' && row.raw_text === null)
    || (coverage.status !== 'pending' && row.raw_text !== null)) {
    throw new PersonalFeedScopeStoreError('personal context source and coverage lifecycle is invalid')
  }
  const locator: PersonalContextTelegramLocator = { kind: 'telegram_inbound', chatId: row.chat_id, messageId: row.message_id }
  if (row.source_key !== sourceKeyFor(locator)) throw new PersonalFeedScopeStoreError('personal context source key is invalid')
  const excludedRequestId = row.excluded_request_id
  if (excludedRequestId !== null && (typeof excludedRequestId !== 'string' || excludedRequestId !== requestIdFor(locator))) {
    throw new PersonalFeedScopeStoreError('personal context excluded request id is invalid')
  }
  if (row.raw_text !== null) {
    const payload: PersonalContextCaptureInput = excludedRequestId === null
      ? { locator, rawText: row.raw_text, reference: null }
      : { locator, rawText: row.raw_text, reference: null, excludedRequestId }
    if (row.payload_digest !== payloadDigestFor(payload)) throw new PersonalFeedScopeStoreError('personal context payload digest is invalid')
  }
  return excludedRequestId === null
    ? { locator, rawText: row.raw_text, reference: null, occurredAt: row.occurred_at, sourceKey: row.source_key, captureSequence: row.capture_sequence }
    : { locator, rawText: row.raw_text, reference: null, excludedRequestId, occurredAt: row.occurred_at, sourceKey: row.source_key, captureSequence: row.capture_sequence }
}

function coverageFromRow(row: CoverageRow): PersonalContextCoverage {
  if (typeof row.source_key !== 'string' || !isStableSourceKey(row.source_key)) {
    throw new PersonalFeedScopeStoreError('personal context coverage row is invalid')
  }
  if (row.status === 'pending' && row.disposition_json === null && row.disposition_digest === null) {
    return { sourceKey: row.source_key, status: 'pending' }
  }
  if ((row.status !== 'applied' && row.status !== 'ignored')
    || typeof row.disposition_json !== 'string'
    || typeof row.disposition_digest !== 'string'
    || !/^[0-9a-f]{64}$/.test(row.disposition_digest)
    || dispositionDigestForJson(row.disposition_json) !== row.disposition_digest) {
    throw new PersonalFeedScopeStoreError('personal context terminal coverage row is invalid')
  }
  let decoded: unknown
  try {
    decoded = JSON.parse(row.disposition_json)
  } catch (cause) {
    throw new PersonalFeedScopeStoreError('personal context terminal disposition is not JSON', { cause })
  }
  const disposition = parseTerminalDisposition(decoded)
  if (disposition === undefined || disposition.status !== row.status || dispositionJsonFor(disposition) !== row.disposition_json) {
    throw new PersonalFeedScopeStoreError('personal context terminal disposition is invalid')
  }
  if (disposition.status === 'applied' && disposition.facts.some(fact => fact.evidence.sourceKey !== row.source_key)) {
    throw new PersonalFeedScopeStoreError('personal context terminal fact belongs to another source')
  }
  return deepFreeze({ sourceKey: row.source_key, status: row.status, disposition })
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

function dispositionJsonFor(disposition: PersonalContextTerminalDisposition): string {
  const canonical = encodeCanonicalJson(disposition)
  if (canonical === undefined) throw new PersonalFeedScopeStoreError('personal context terminal disposition is not canonical JSON')
  return canonical
}

function dispositionDigestForJson(dispositionJson: string): string {
  return createHash('sha256').update(dispositionJson, 'utf8').digest('hex')
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
