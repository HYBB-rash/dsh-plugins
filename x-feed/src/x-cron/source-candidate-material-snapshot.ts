import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
import type {
  CandidateReportingWindow,
  CandidateReportingWindowIdentity,
  MaterialProjectionReportScope,
  MaterialProjectionReportScopeEstablished,
  PeriodIdentity,
  SourceIdentity,
} from '@herman/personal-feed'
import {
  normalizeXCurrentCollection,
  type XSourceCollectionEvidence,
  type XSourceCollectionItem,
} from './source-candidate-report.ts'

const SNAPSHOT_SCHEMA_VERSION = 1
const SNAPSHOT_EVENT = 'x_source_candidate_material_snapshot_accepted'

interface SnapshotLedgerRecord {
  readonly schemaVersion: 1
  readonly event: typeof SNAPSHOT_EVENT
  readonly snapshot: XSourceCandidateMaterialSnapshot
}

export interface XSourceCandidateMaterialSnapshotBinding {
  readonly runId: string
  readonly period: PeriodIdentity
  readonly materialProjectionReportScope: MaterialProjectionReportScopeEstablished
}

export interface XSourceCandidateMaterialSnapshot
  extends XSourceCandidateMaterialSnapshotBinding {
  readonly collectionEvidence: XSourceCollectionEvidence
  readonly currentCollection: readonly XSourceCollectionItem[]
}

export interface XSourceCandidateMaterialSnapshotStoreOptions {
  readonly ledgerPath: string
}

export type XSourceCandidateMaterialSnapshotAcceptResult =
  | { readonly status: 'accepted'; readonly value: XSourceCandidateMaterialSnapshot }
  | {
      readonly status: 'rejected' | 'failed'
      readonly input: XSourceCandidateMaterialSnapshot
    }

export type XSourceCandidateMaterialSnapshotReadResult =
  | { readonly status: 'found'; readonly value: XSourceCandidateMaterialSnapshot }
  | {
      readonly status: 'missing' | 'rejected' | 'failed'
      readonly input: XSourceCandidateMaterialSnapshotBinding
    }

export interface XSourceCandidateMaterialSnapshotStore {
  readonly acceptSnapshot: (
    snapshot: XSourceCandidateMaterialSnapshot,
  ) => XSourceCandidateMaterialSnapshotAcceptResult
  readonly readSnapshot: (
    binding: XSourceCandidateMaterialSnapshotBinding,
  ) => XSourceCandidateMaterialSnapshotReadResult
}

type LedgerRead =
  | { readonly status: 'missing' }
  | { readonly status: 'found'; readonly snapshot: XSourceCandidateMaterialSnapshot }
  | { readonly status: 'failed' }

export function createXSourceCandidateMaterialSnapshotStore(
  options: XSourceCandidateMaterialSnapshotStoreOptions,
): XSourceCandidateMaterialSnapshotStore {
  if (options.ledgerPath.trim() === '') {
    throw new Error('X source candidate material snapshot ledger path must be non-empty')
  }

  return Object.freeze({
    acceptSnapshot: (snapshot: XSourceCandidateMaterialSnapshot): XSourceCandidateMaterialSnapshotAcceptResult => {
      const canonical = canonicalSnapshot(snapshot)
      if (canonical === undefined) return { status: 'rejected', input: snapshot }

      const existing = readLedger(options.ledgerPath)
      if (existing.status === 'failed') return { status: 'failed', input: snapshot }
      if (existing.status === 'found') {
        if (!sameBinding(existing.snapshot, canonical)) return { status: 'failed', input: snapshot }
        if (!sameValue(existing.snapshot, canonical)) return { status: 'rejected', input: snapshot }
        return { status: 'accepted', value: existing.snapshot }
      }

      try {
        persistRecord(options.ledgerPath, canonical)
      } catch {
        // A failed write can race with a successful rename. The physical
        // readback below is the only evidence allowed to recover acceptance.
      }
      const readback = readLedger(options.ledgerPath)
      if (readback.status === 'found' && sameValue(readback.snapshot, canonical)) {
        return { status: 'accepted', value: readback.snapshot }
      }
      return { status: 'failed', input: snapshot }
    },
    readSnapshot: (binding: XSourceCandidateMaterialSnapshotBinding): XSourceCandidateMaterialSnapshotReadResult => {
      const canonical = canonicalBinding(binding)
      if (canonical === undefined) return { status: 'rejected', input: binding }

      const record = readLedger(options.ledgerPath)
      if (record.status === 'missing') return { status: 'missing', input: binding }
      if (record.status === 'failed') return { status: 'failed', input: binding }
      if (!sameBinding(record.snapshot, canonical)) return { status: 'failed', input: binding }
      return { status: 'found', value: record.snapshot }
    },
  })
}

function persistRecord(path: string, snapshot: XSourceCandidateMaterialSnapshot): void {
  const temporaryPath = `${path}.${process.pid}.tmp`
  let renamed = false
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const record: SnapshotLedgerRecord = {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      event: SNAPSHOT_EVENT,
      snapshot,
    }
    writeFileSync(temporaryPath, `${JSON.stringify(record)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    renameSync(temporaryPath, path)
    renamed = true
  } finally {
    if (!renamed) {
      try {
        unlinkSync(temporaryPath)
      } catch {
        // There may be no temporary file when directory creation failed.
      }
    }
  }
}

function readLedger(path: string): LedgerRead {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) return { status: 'missing' }
    return { status: 'failed' }
  }

  try {
    const lines = text.split('\n')
    if (lines.at(-1) === '') lines.pop()
    if (lines.length !== 1 || lines[0]!.trim() === '') return { status: 'failed' }

    const value: unknown = JSON.parse(lines[0]!)
    if (!isRecord(value)
      || !hasExactKeys(value, ['event', 'schemaVersion', 'snapshot'])
      || value.schemaVersion !== SNAPSHOT_SCHEMA_VERSION
      || value.event !== SNAPSHOT_EVENT) {
      return { status: 'failed' }
    }
    const snapshot = canonicalSnapshot(value.snapshot)
    return snapshot === undefined ? { status: 'failed' } : { status: 'found', snapshot }
  } catch {
    return { status: 'failed' }
  }
}

function canonicalSnapshot(value: unknown): XSourceCandidateMaterialSnapshot | undefined {
  if (!isRecord(value)
    || !hasExactKeys(value, [
      'collectionEvidence',
      'currentCollection',
      'materialProjectionReportScope',
      'period',
      'runId',
    ])
    || !isNonEmptyString(value.runId)
    || !Array.isArray(value.currentCollection)) {
    return undefined
  }

  const period = parsePeriodIdentity(value.period)
  if (period === undefined) return undefined
  const materialProjectionReportScope = parseMaterialProjectionReportScope(
    value.materialProjectionReportScope,
    period,
  )
  if (materialProjectionReportScope === undefined) return undefined
  const collectionEvidence = parseCollectionEvidence(value.collectionEvidence, value.runId)
  if (collectionEvidence === undefined) return undefined

  let currentCollection: readonly XSourceCollectionItem[]
  try {
    currentCollection = normalizeXCurrentCollection(value.currentCollection)
  } catch {
    return undefined
  }

  return deepFreeze({
    runId: value.runId,
    period,
    materialProjectionReportScope,
    collectionEvidence,
    currentCollection,
  })
}

function canonicalBinding(value: unknown): XSourceCandidateMaterialSnapshotBinding | undefined {
  if (!isRecord(value)
    || !hasExactKeys(value, ['materialProjectionReportScope', 'period', 'runId'])
    || !isNonEmptyString(value.runId)) {
    return undefined
  }
  const period = parsePeriodIdentity(value.period)
  if (period === undefined) return undefined
  const materialProjectionReportScope = parseMaterialProjectionReportScope(
    value.materialProjectionReportScope,
    period,
  )
  if (materialProjectionReportScope === undefined) return undefined
  return deepFreeze({ runId: value.runId, period, materialProjectionReportScope })
}

function parsePeriodIdentity(value: unknown): PeriodIdentity | undefined {
  if (!isRecord(value)
    || !hasExactKeys(value, ['period', 'run'])
    || !isNonEmptyString(value.run)
    || !isNonEmptyString(value.period)) {
    return undefined
  }
  return { run: value.run as PeriodIdentity['run'], period: value.period as PeriodIdentity['period'] }
}

function parseMaterialProjectionReportScope(
  value: unknown,
  period: PeriodIdentity,
): MaterialProjectionReportScopeEstablished | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ['scope']) || !isRecord(value.scope)
    || !hasExactKeys(value.scope, ['period', 'reportingWindow', 'source'])
    || !isNonEmptyString(value.scope.source)
    || value.scope.source !== 'x'
    || !sameValue(value.scope.period, period)
    || !isRecord(value.scope.reportingWindow)
    || !hasExactKeys(value.scope.reportingWindow, ['window'])) {
    return undefined
  }

  const window = value.scope.reportingWindow.window
  if (!isRecord(window)
    || !hasExactKeys(window, ['closesAt', 'period', 'sources', 'window'])
    || !sameValue(window.period, period)
    || !isNonEmptyString(window.window)
    || !isNonEmptyString(window.closesAt)
    || !Array.isArray(window.sources)
    || window.sources.length === 0
    || window.sources.some(source => !isNonEmptyString(source))
    || !window.sources.includes('x')) {
    return undefined
  }

  const canonicalWindow: CandidateReportingWindow = {
    window: window.window as CandidateReportingWindowIdentity,
    period,
    sources: window.sources.map(source => source as SourceIdentity),
    closesAt: window.closesAt,
  }
  const canonicalScope: MaterialProjectionReportScope = {
    period,
    source: value.scope.source as SourceIdentity,
    reportingWindow: { window: canonicalWindow },
  }
  return { scope: canonicalScope }
}

function parseCollectionEvidence(value: unknown, runId: string): XSourceCollectionEvidence | undefined {
  if (!isRecord(value)
    || !hasExactKeys(value, ['collectionBatch', 'collectionPath', 'deliveryId', 'runId', 'source', 'ts'])
    || !isNonEmptyString(value.runId)
    || value.runId !== runId
    || value.source !== 'x'
    || !isNonEmptyString(value.collectionPath)
    || !isNonEmptyString(value.collectionBatch)
    || !isNonEmptyString(value.deliveryId)
    || !isPositiveSafeInteger(value.ts)) {
    return undefined
  }
  return {
    runId: value.runId,
    source: 'x',
    collectionPath: value.collectionPath,
    collectionBatch: value.collectionBatch,
    deliveryId: value.deliveryId,
    ts: value.ts,
  }
}

function sameBinding(
  left: XSourceCandidateMaterialSnapshotBinding,
  right: XSourceCandidateMaterialSnapshotBinding,
): boolean {
  return left.runId === right.runId
    && sameValue(left.period, right.period)
    && sameValue(left.materialProjectionReportScope, right.materialProjectionReportScope)
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((item, index) => sameValue(item, right[index]))
  }
  if (!isRecord(left) || !isRecord(right)) return false
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && sameValue(left[key], right[key]))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index])
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === code
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null) return value
  if (!Object.isFrozen(value)) Object.freeze(value)
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  return value
}
