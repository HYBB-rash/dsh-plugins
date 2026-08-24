import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  DisplayFact,
  FormalCandidateDisposition,
  FormalFeedContentDeliveryReceipt,
  PeriodIdentity,
  SourceCandidateReference,
} from '../src/index.ts'

const temporaryDirectories: string[] = []

function deliveredFact(): { readonly fact: DisplayFact; readonly receipt: FormalFeedContentDeliveryReceipt } {
  const period = { run: '' as PeriodIdentity['run'], period: '' as PeriodIdentity['period'] } satisfies PeriodIdentity
  const candidate = {
    source: '' as SourceCandidateReference['source'],
    candidate: '' as SourceCandidateReference['candidate'],
    stableReference: '' as SourceCandidateReference['stableReference'],
  } satisfies SourceCandidateReference
  const disposition = {
    period,
    source: candidate.source,
    candidate,
    value: 'Shown',
  } satisfies FormalCandidateDisposition
  const receipt = {
    object: '' as FormalFeedContentDeliveryReceipt['object'],
    period,
    result: 'Delivered',
  } satisfies FormalFeedContentDeliveryReceipt
  return {
    receipt,
    fact: { period, candidate, disposition, receipt } satisfies DisplayFact,
  }
}

function snapshot(directory: string): readonly [string, string][] {
  return readdirSync(directory).sort().map(name => [name, readFileSync(join(directory, name), 'utf8')])
}

describe('TODO05 post-delivery bootstrap seams', () => {
  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
  })

  it('exposes the real C21 receipt entry point on a configured PeriodBusinessFinalizer', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'todo05-post-delivery-bootstrap-'))
    temporaryDirectories.push(directory)
    const before = snapshot(directory)
    const production = await import('../src/index.ts') as typeof import('../src/index.ts')
    const finalizer = production.createPeriodBusinessFinalizer({
      candidatePeriodLedgerPath: join(directory, 'candidate-period.jsonl'),
      periodScopeLedgerPath: join(directory, 'period-scopes.jsonl'),
      reportLedgerPath: join(directory, 'reports.jsonl'),
      editingInputLedgerPath: join(directory, 'editing-inputs.jsonl'),
      periodBusinessLedgerPath: join(directory, 'period-business.jsonl'),
      now: () => '2026-08-24T15:00:00.000Z',
    })

    const { receipt } = deliveredFact()
    expect(finalizer.acceptFormalFeedContentDeliveryReceipt(receipt)).toEqual({ status: 'rejected', input: receipt })
    expect(snapshot(directory)).toEqual(before)
  })

  it('exposes the real C28 display-fact entry point on CrossSourceEditor', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'todo05-post-delivery-editor-bootstrap-'))
    temporaryDirectories.push(directory)
    const before = snapshot(directory)
    const production = await import('../src/index.ts') as typeof import('../src/index.ts')
    const editor = production.createCrossSourceEditor({
      candidatePeriodLedgerPath: join(directory, 'candidate-period.jsonl'),
      editingInputLedgerPath: join(directory, 'editing-inputs.jsonl'),
    })

    const { fact } = deliveredFact()
    expect(editor.acceptDisplayFact(fact)).toEqual({ status: 'rejected', input: fact })
    expect(snapshot(directory)).toEqual(before)
  })
})
