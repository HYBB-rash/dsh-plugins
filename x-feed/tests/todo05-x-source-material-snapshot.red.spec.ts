import { appendFile, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { sourceIdentity } from '@herman/personal-feed'
import type {
  CandidateReportingWindowIdentity,
  MaterialProjectionReportScopeEstablished,
  PeriodIdentity,
} from '@herman/personal-feed'
import {
  createXSourceCandidateMaterialSnapshotStore,
  type XSourceCandidateMaterialSnapshot,
  type XSourceCandidateMaterialSnapshotBinding,
  type XSourceCandidateMaterialSnapshotStore,
} from '../src/x-cron/source-candidate-material-snapshot.ts'
import {
  normalizeXCurrentCollection,
  type XSourceCollectionEvidence,
  type XSourceCollectionItem,
} from '../src/x-cron/source-candidate-report.ts'

async function snapshotDirectory(root: string): Promise<readonly {
  readonly path: string
  readonly bytes: string
}[]> {
  const entries = await readdir(root, { withFileTypes: true })
  const snapshot: Array<{ path: string; bytes: string }> = []
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      const children = await snapshotDirectory(path)
      snapshot.push(...children.map(child => ({
        path: join(entry.name, child.path),
        bytes: child.bytes,
      })))
    } else {
      snapshot.push({ path: entry.name, bytes: (await readFile(path)).toString('base64') })
    }
  }
  return snapshot.sort((left, right) => left.path.localeCompare(right.path))
}

function fixture(): {
  readonly binding: XSourceCandidateMaterialSnapshotBinding
  readonly snapshot: XSourceCandidateMaterialSnapshot
} {
  const run = 'run:todo05-x-source-material-snapshot' as PeriodIdentity['run']
  const period: PeriodIdentity = {
    run,
    period: 'period:todo05-x-source-material-snapshot' as PeriodIdentity['period'],
  }
  const source = sourceIdentity('x')
  const reportingWindow = {
    window: {
      window: 'window:todo05-x-source-material-snapshot' as CandidateReportingWindowIdentity,
      period,
      sources: [source],
      closesAt: '2026-08-25T05:00:00.000Z',
    },
  }
  const materialProjectionReportScope: MaterialProjectionReportScopeEstablished = {
    scope: { period, source, reportingWindow },
  }
  const currentCollection: readonly XSourceCollectionItem[] = normalizeXCurrentCollection([{
    id: '1001',
    url: 'https://x.com/alice/status/1001',
    text: 'A bounded X collection item.',
    time: '2026-08-25T04:00:00.000Z',
    user: 'alice',
    media: [],
    ts: 1_755_961_200,
  }])
  const collectionEvidence: XSourceCollectionEvidence = {
    runId: 'cron-x@2026-08-25T04:00:00.000Z',
    source: 'x',
    collectionPath: '/tmp/todo05-x-source-material-snapshot/collection.jsonl',
    collectionBatch: '/tmp/todo05-x-source-material-snapshot/collection.jsonl',
    deliveryId: 'delivery:todo05-x-source-material-snapshot',
    ts: 1_755_961_200,
  }
  const binding: XSourceCandidateMaterialSnapshotBinding = {
    runId: collectionEvidence.runId,
    period,
    materialProjectionReportScope,
  }
  return {
    binding,
    snapshot: {
      ...binding,
      collectionEvidence,
      currentCollection,
    },
  }
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function requireAccepted(
  result: ReturnType<XSourceCandidateMaterialSnapshotStore['acceptSnapshot']>,
): XSourceCandidateMaterialSnapshot {
  if (result.status !== 'accepted') {
    expect(result.status).toBe('accepted')
    throw new Error('unreachable after accepted assertion')
  }
  return result.value
}

function expectDeepFrozen(value: unknown, seen = new Set<object>()): void {
  if (typeof value !== 'object' || value === null || seen.has(value)) return
  seen.add(value)
  expect(Object.isFrozen(value)).toBe(true)
  for (const child of Object.values(value)) expectDeepFrozen(child, seen)
}

async function readSingleLedgerRow(path: string): Promise<string> {
  const text = await readFile(path, 'utf8')
  const lines = text.trim().split('\n')
  if (lines.length !== 1 || lines[0] === '') throw new Error('expected exactly one durable snapshot row')
  return lines[0]
}

function changedSnapshot(snapshot: XSourceCandidateMaterialSnapshot): XSourceCandidateMaterialSnapshot {
  const changed = clone(snapshot)
  const mutable = changed as unknown as { currentCollection: Array<{ text: string }> }
  mutable.currentCollection[0]!.text = 'material conflict'
  return changed
}

function invalidSnapshot(
  snapshot: XSourceCandidateMaterialSnapshot,
  change: (value: XSourceCandidateMaterialSnapshot) => void,
): XSourceCandidateMaterialSnapshot {
  const invalid = clone(snapshot)
  change(invalid)
  return invalid
}

function alternatePeriod(period: PeriodIdentity): PeriodIdentity {
  return {
    ...period,
    period: 'period:todo05-x-source-material-snapshot-mismatch' as PeriodIdentity['period'],
  }
}

async function createFixtureStore(directory: string): Promise<{
  readonly store: XSourceCandidateMaterialSnapshotStore
  readonly binding: XSourceCandidateMaterialSnapshotBinding
  readonly snapshot: XSourceCandidateMaterialSnapshot
  readonly ledgerPath: string
}> {
  const ledgerPath = join(directory, 'material-snapshots.jsonl')
  const store = createXSourceCandidateMaterialSnapshotStore({ ledgerPath })
  const values = fixture()
  return { store, ...values, ledgerPath }
}

describe('TODO05 X source candidate material snapshot bootstrap', () => {
  it('rejects a blank ledger path', () => {
    expect(() => createXSourceCandidateMaterialSnapshotStore({ ledgerPath: '  ' })).toThrow(
      'ledger path must be non-empty',
    )
  })

  it('exposes a frozen two-method store', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'x-feed-todo05-material-snapshot-'))
    try {
      const before = await snapshotDirectory(directory)
      const store: XSourceCandidateMaterialSnapshotStore = createXSourceCandidateMaterialSnapshotStore({
        ledgerPath: join(directory, 'material-snapshots.jsonl'),
      })
      expect(Object.isFrozen(store)).toBe(true)
      expect(Object.keys(store)).toEqual(['acceptSnapshot', 'readSnapshot'])
      expect(await snapshotDirectory(directory)).toEqual(before)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('accepts one snapshot, freezes it, and reads it after store rebuild', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'x-feed-todo05-material-snapshot-'))
    try {
      const before = await snapshotDirectory(directory)
      const { store, binding, snapshot, ledgerPath } = await createFixtureStore(directory)
      const submitted = clone(snapshot)
      const accepted = store.acceptSnapshot(submitted)
      const acceptedValue = requireAccepted(accepted)
      expectDeepFrozen(acceptedValue)

      const afterAccept = await snapshotDirectory(directory)
      expect(afterAccept).not.toEqual(before)
      const firstRead = store.readSnapshot(binding)
      expect(firstRead).toEqual({ status: 'found', value: acceptedValue })
      const rebuiltRead = createXSourceCandidateMaterialSnapshotStore({ ledgerPath }).readSnapshot(binding)
      expect(rebuiltRead).toEqual({ status: 'found', value: acceptedValue })
      expect(await snapshotDirectory(directory)).toEqual(afterAccept)

      const mutableSubmitted = submitted as unknown as {
        currentCollection: Array<{ text: string }>
      }
      mutableSubmitted.currentCollection[0]!.text = 'caller mutation must not change durable value'
      const afterMutationRead = store.readSnapshot(binding)
      expect(afterMutationRead).toEqual({ status: 'found', value: acceptedValue })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('accepts exact replay and rejects a changed material field without changing bytes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'x-feed-todo05-material-snapshot-'))
    try {
      const { store, binding, snapshot, ledgerPath } = await createFixtureStore(directory)
      const accepted = requireAccepted(store.acceptSnapshot(clone(snapshot)))
      const afterFirstAccept = await snapshotDirectory(directory)

      expect(store.acceptSnapshot(clone(snapshot))).toEqual({ status: 'accepted', value: accepted })
      expect(await snapshotDirectory(directory)).toEqual(afterFirstAccept)
      const rebuilt = createXSourceCandidateMaterialSnapshotStore({ ledgerPath })
      expect(rebuilt.acceptSnapshot(clone(snapshot))).toEqual({ status: 'accepted', value: accepted })
      expect(await snapshotDirectory(directory)).toEqual(afterFirstAccept)

      const changed = changedSnapshot(snapshot)
      const rejected = store.acceptSnapshot(changed)
      expect(rejected).toEqual({ status: 'rejected', input: changed })
      expect(rejected.input).toBe(changed)
      expect(await snapshotDirectory(directory)).toEqual(afterFirstAccept)
      expect(store.readSnapshot(binding)).toEqual({ status: 'found', value: accepted })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects invalid snapshot bindings with the original input and zero writes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'x-feed-todo05-material-snapshot-'))
    try {
      const { store, binding, snapshot } = await createFixtureStore(directory)
      const before = await snapshotDirectory(directory)

      const blankRunId = invalidSnapshot(snapshot, value => {
        (value as unknown as { runId: string }).runId = ''
      })
      const blankResult = store.acceptSnapshot(blankRunId)
      expect(blankResult).toEqual({ status: 'rejected', input: blankRunId })
      expect(blankResult.input).toBe(blankRunId)

      const mismatchedRunId = invalidSnapshot(snapshot, value => {
        (value as unknown as { runId: string }).runId = 'cron-x:mismatch'
      })
      const mismatchResult = store.acceptSnapshot(mismatchedRunId)
      expect(mismatchResult).toEqual({ status: 'rejected', input: mismatchedRunId })
      expect(mismatchResult.input).toBe(mismatchedRunId)

      const mismatchedPeriod = invalidSnapshot(snapshot, value => {
        (value as unknown as { period: PeriodIdentity }).period = alternatePeriod(value.period)
      })
      const periodResult = store.acceptSnapshot(mismatchedPeriod)
      expect(periodResult).toEqual({ status: 'rejected', input: mismatchedPeriod })
      expect(periodResult.input).toBe(mismatchedPeriod)

      const invalidBinding = clone(binding)
      ;(invalidBinding as { runId: string }).runId = ''
      const readResult = store.readSnapshot(invalidBinding)
      expect(readResult).toEqual({ status: 'rejected', input: invalidBinding })
      expect(readResult.input).toBe(invalidBinding)
      expect(await snapshotDirectory(directory)).toEqual(before)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('reports a healthy absent ledger as missing without writing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'x-feed-todo05-material-snapshot-'))
    try {
      const { store, binding } = await createFixtureStore(directory)
      const before = await snapshotDirectory(directory)
      const result = store.readSnapshot(binding)
      expect(result).toEqual({ status: 'missing', input: binding })
      expect(result.input).toBe(binding)
      expect(await snapshotDirectory(directory)).toEqual(before)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('fails closed on a duplicate or corrupt row derived from one real accepted row', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'x-feed-todo05-material-snapshot-'))
    try {
      const { store, binding, snapshot, ledgerPath } = await createFixtureStore(directory)
      const accepted = requireAccepted(store.acceptSnapshot(clone(snapshot)))
      expectDeepFrozen(accepted)
      const row = await readSingleLedgerRow(ledgerPath)

      await appendFile(ledgerPath, `${row}\n`)
      const duplicateBytes = await snapshotDirectory(directory)
      const duplicateResult = store.readSnapshot(binding)
      expect(duplicateResult).toEqual({ status: 'failed', input: binding })
      expect(duplicateResult.input).toBe(binding)
      expect(await snapshotDirectory(directory)).toEqual(duplicateBytes)

      const corruptRecord = JSON.parse(row) as Record<string, unknown>
      corruptRecord.schemaVersion = 999
      await writeFile(ledgerPath, `${JSON.stringify(corruptRecord)}\n`, 'utf8')
      const corruptBytes = await snapshotDirectory(directory)
      const corruptResult = createXSourceCandidateMaterialSnapshotStore({ ledgerPath }).readSnapshot(binding)
      expect(corruptResult).toEqual({ status: 'failed', input: binding })
      expect(corruptResult.input).toBe(binding)
      expect(await snapshotDirectory(directory)).toEqual(corruptBytes)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('fails closed for a directory ledger path without side effects', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'x-feed-todo05-material-snapshot-'))
    try {
      const store = createXSourceCandidateMaterialSnapshotStore({ ledgerPath: directory })
      const { binding, snapshot } = fixture()
      const before = await snapshotDirectory(directory)

      const acceptResult = store.acceptSnapshot(snapshot)
      expect(acceptResult).toEqual({ status: 'failed', input: snapshot })
      expect(acceptResult.input).toBe(snapshot)
      const readResult = store.readSnapshot(binding)
      expect(readResult).toEqual({ status: 'failed', input: binding })
      expect(readResult.input).toBe(binding)
      expect(await snapshotDirectory(directory)).toEqual(before)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
