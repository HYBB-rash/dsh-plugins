import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import * as durableJsonlStore from '../../personal-feed/src/durable-jsonl-store.ts'
import type {
  CronDeliveryReceipt,
  CronRunDeliveryMeaningRunPort,
} from '@deepseek-ai/dsh-cron'
import type {
  DeliveryAndReceipt,
  FormalFeedContentDeliveryReceipt,
  PeriodBusinessFinalizer,
} from '@herman/personal-feed'
import {
  createOrdinaryFeedPostReceiptAdapter,
  type OrdinaryFeedPostReceiptAdapter,
  type OrdinaryFeedPostReceiptAdapterOptions,
  type OrdinaryFeedPostReceiptCandidateState,
  type OrdinaryFeedPostReceiptDeliveryReader,
  type OrdinaryFeedPostReceiptFinalizationReader,
  type OrdinaryFeedPostReceiptFinalizer,
  type OrdinaryFeedPostReceiptResult,
  type OrdinaryFeedPostReceiptRunPort,
} from '../src/personal-feed/ordinary-feed-post-receipt-adapter.ts'
import type { CandidateLocalStateRuntime } from '../src/personal-feed/candidate-local-state.ts'
import type { OrdinaryBusinessFinalizationOwner } from '../src/personal-feed/ordinary-business-finalization-owner.ts'
import { createOrdinaryFeedEditorAdapter } from '../src/personal-feed/ordinary-feed-editor-adapter.ts'
import {
  createRealOrdinaryFeedFixture,
  ordinaryFeedProposal,
} from './support/todo05-real-ordinary-feed-fixture.ts'

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
    (<Value>() => Value extends Right ? 1 : 2) ? true : false
type Assert<Value extends true> = Value

type ContractAssertions = readonly [
  Assert<Equal<
    OrdinaryFeedPostReceiptDeliveryReader,
    Pick<DeliveryAndReceipt, 'readFormalFeedContentDeliveryRequest'>
  >>,
  Assert<Equal<
    OrdinaryFeedPostReceiptFinalizer,
    Pick<PeriodBusinessFinalizer,
      | 'requestFormalContentDelivery'
      | 'acceptFormalFeedContentDeliveryReceipt'
      | 'ensureBusinessFinalization'>
  >>,
  Assert<Equal<
    OrdinaryFeedPostReceiptCandidateState,
    Pick<CandidateLocalStateRuntime, 'completePendingSourceDispositions'>
  >>,
  Assert<Equal<
    OrdinaryFeedPostReceiptFinalizationReader,
    Pick<OrdinaryBusinessFinalizationOwner, 'readAcceptedOrdinaryFinalization'>
  >>,
  Assert<Equal<
    OrdinaryFeedPostReceiptRunPort,
    Pick<CronRunDeliveryMeaningRunPort, 'acceptDurableReceipt' | 'commitBusinessFinalization'>
  >>,
  Assert<Equal<keyof OrdinaryFeedPostReceiptAdapterOptions,
    | 'delivery'
    | 'finalizer'
    | 'candidateLocalState'
    | 'finalizationOwner'
    | 'runDeliveryMeaningPort'>>,
  Assert<Equal<keyof OrdinaryFeedPostReceiptAdapter, 'settleDurableReceipt'>>,
  Assert<Equal<
    Parameters<OrdinaryFeedPostReceiptAdapter['settleDurableReceipt']>,
    [CronDeliveryReceipt]
  >>,
  Assert<Equal<
    Awaited<ReturnType<OrdinaryFeedPostReceiptAdapter['settleDurableReceipt']>>,
    OrdinaryFeedPostReceiptResult
  >>,
]
const contractAssertions: ContractAssertions = [true, true, true, true, true, true, true, true, true]
void contractAssertions

function receipt(): CronDeliveryReceipt {
  return {
    objectId: 'todo05-post-receipt-object',
    jobId: 'todo05-post-receipt-job',
    runId: 'todo05-post-receipt-run',
    sessionId: 'todo05-post-receipt-session',
    scheduledFor: '2026-08-24T10:00:00.000Z',
    deliveryState: 'delivered',
    deliveredAt: '2026-08-24T10:00:02.000Z',
  }
}

function snapshotDirectory(directory: string): readonly { readonly path: string; readonly base64: string }[] {
  return readdirSync(directory).sort().map(path => ({
    path,
    base64: readFileSync(join(directory, path)).toString('base64'),
  }))
}

function countEvent(path: string, event: string): number {
  if (!existsSync(path)) return 0
  const text = readFileSync(path, 'utf8').trim()
  if (text === '') return 0
  return text.split('\n')
    .map(line => JSON.parse(line) as { readonly event?: unknown })
    .filter(record => record.event === event).length
}

function eventRecords(path: string, event: string): Record<string, unknown>[] {
  if (!existsSync(path)) return []
  const text = readFileSync(path, 'utf8').trim()
  if (text === '') return []
  return text.split('\n')
    .map(line => JSON.parse(line) as Record<string, unknown>)
    .filter(record => record.event === event)
}

async function realC19Fixture() {
  const fixture = await createRealOrdinaryFeedFixture()
  const c19 = createOrdinaryFeedEditorAdapter({
    period: fixture.period,
    editor: fixture.editor,
    finalizer: fixture.finalizer,
  }).acceptEditingProposal(ordinaryFeedProposal())
  if (c19.status !== 'accepted') {
    fixture.dispose()
    throw new Error('real ordinary Feed chain did not reach C19')
  }
  return { fixture, c19 }
}

function acceptingRunPort(
  commit: OrdinaryFeedPostReceiptRunPort['commitBusinessFinalization'] = async () => ({ status: 'accepted' }),
): OrdinaryFeedPostReceiptRunPort {
  return {
    acceptDurableReceipt: vi.fn<OrdinaryFeedPostReceiptRunPort['acceptDurableReceipt']>(
      async value => ({ status: 'accepted', value: { receipt: value } }),
    ),
    commitBusinessFinalization: vi.fn(commit),
  }
}

function directAdapter(
  fixture: Awaited<ReturnType<typeof createRealOrdinaryFeedFixture>>,
  runDeliveryMeaningPort: OrdinaryFeedPostReceiptRunPort,
  finalizer = fixture.finalizer,
  candidateLocalState = fixture.candidateLocalState,
  finalizationOwner = fixture.finalizationOwner,
) {
  return createOrdinaryFeedPostReceiptAdapter({
    delivery: fixture.deliveryAndReceipt,
    finalizer,
    candidateLocalState,
    finalizationOwner,
    runDeliveryMeaningPort,
  })
}

describe('TODO 05 ordinary Feed post-receipt adapter', () => {
  it('keeps the package-private contract exact and stops after a nonaccepted C1 result', async () => {
    const delivery = {
      readFormalFeedContentDeliveryRequest: vi.fn(() => undefined),
    } satisfies OrdinaryFeedPostReceiptDeliveryReader
    const finalizer = {
      requestFormalContentDelivery: vi.fn<OrdinaryFeedPostReceiptFinalizer['requestFormalContentDelivery']>(
        input => ({ status: 'failed', input }),
      ),
      acceptFormalFeedContentDeliveryReceipt: vi.fn<
        OrdinaryFeedPostReceiptFinalizer['acceptFormalFeedContentDeliveryReceipt']
      >(input => ({ status: 'failed', input })),
      ensureBusinessFinalization: vi.fn<OrdinaryFeedPostReceiptFinalizer['ensureBusinessFinalization']>(
        input => ({ status: 'failed', input }),
      ),
    }
    const candidateLocalState = {
      completePendingSourceDispositions: vi.fn(() => ({ status: 'failed' as const })),
    } satisfies OrdinaryFeedPostReceiptCandidateState
    const finalizationOwner = {
      readAcceptedOrdinaryFinalization: vi.fn(() => undefined),
    } satisfies OrdinaryFeedPostReceiptFinalizationReader
    const runDeliveryMeaningPort = {
      acceptDurableReceipt: vi.fn<OrdinaryFeedPostReceiptRunPort['acceptDurableReceipt']>(
        async input => ({ status: 'failed', input }),
      ),
      commitBusinessFinalization: vi.fn<OrdinaryFeedPostReceiptRunPort['commitBusinessFinalization']>(
        async () => ({ status: 'failed', input: undefined }),
      ),
    }
    const adapter = createOrdinaryFeedPostReceiptAdapter({
      delivery,
      finalizer,
      candidateLocalState,
      finalizationOwner,
      runDeliveryMeaningPort,
    })
    const input = receipt()

    expect(Object.keys(adapter)).toEqual(['settleDurableReceipt'])
    expect(Object.isFrozen(adapter)).toBe(true)
    await expect(adapter.settleDurableReceipt(input)).resolves.toEqual({ status: 'failed', input })
    expect(delivery.readFormalFeedContentDeliveryRequest).not.toHaveBeenCalled()
    expect(finalizer.requestFormalContentDelivery).not.toHaveBeenCalled()
    expect(finalizer.acceptFormalFeedContentDeliveryReceipt).not.toHaveBeenCalled()
    expect(finalizer.ensureBusinessFinalization).not.toHaveBeenCalled()
    expect(candidateLocalState.completePendingSourceDispositions).not.toHaveBeenCalled()
    expect(finalizationOwner.readAcceptedOrdinaryFinalization).not.toHaveBeenCalled()
    expect(runDeliveryMeaningPort.acceptDurableReceipt).toHaveBeenCalledOnce()
    expect(runDeliveryMeaningPort.acceptDurableReceipt).toHaveBeenCalledWith(input)
    expect(runDeliveryMeaningPort.commitBusinessFinalization).not.toHaveBeenCalled()
  })

  it('settles one real ordinary C19 receipt through C21, local C17/C18, C28, durable C23, then C2', async () => {
    const fixture = await createRealOrdinaryFeedFixture()
    try {
      const c19 = createOrdinaryFeedEditorAdapter({
        period: fixture.period,
        editor: fixture.editor,
        finalizer: fixture.finalizer,
      }).acceptEditingProposal(ordinaryFeedProposal())
      expect(c19.status).toBe('accepted')
      if (c19.status !== 'accepted') throw new Error('real ordinary Feed chain did not reach C19')
      const input: CronDeliveryReceipt = {
        objectId: c19.value.request.object.object,
        jobId: 'todo05-post-receipt-job',
        runId: 'todo05-post-receipt-run',
        sessionId: 'todo05-post-receipt-session',
        scheduledFor: '2026-08-24T10:00:00.000Z',
        deliveryState: 'delivered',
        deliveredAt: '2026-08-24T10:00:02.000Z',
      }
      const formalReceipt: FormalFeedContentDeliveryReceipt = {
        object: c19.value.request.object.object,
        period: c19.value.request.object.period,
        result: 'Delivered',
      }
      const sequence: string[] = []
      const acceptDurableReceipt = vi.fn<OrdinaryFeedPostReceiptRunPort['acceptDurableReceipt']>(
        async value => {
          sequence.push('C1')
          expect(value).toBe(input)
          return { status: 'accepted', value: { receipt: value } }
        },
      )
      const commitBusinessFinalization = vi.fn<
        OrdinaryFeedPostReceiptRunPort['commitBusinessFinalization']
      >(async () => {
        sequence.push('C2')
        expect(countEvent(fixture.periodBusinessLedgerPath, 'formal_content_delivery_receipt_accepted')).toBe(1)
        expect(countEvent(fixture.periodBusinessLedgerPath, 'business_finalization_accepted')).toBe(1)
        expect(countEvent(fixture.candidateLocalStateLedgerPath, 'source_disposition_completion_accepted')).toBe(2)
        expect(countEvent(fixture.editingInputLedgerPath, 'display_fact_accepted')).toBe(1)
        expect(fixture.finalizationOwner.readAcceptedOrdinaryFinalization(fixture.period)).toEqual({
          kind: 'ordinary_content_finalized',
          period: fixture.period,
        })
        return { status: 'accepted' }
      })
      const runDeliveryMeaningPort: OrdinaryFeedPostReceiptRunPort = {
        acceptDurableReceipt,
        commitBusinessFinalization,
      }
      const createAdapter = (
        finalizer = fixture.finalizer,
        candidateLocalState = fixture.candidateLocalState,
        finalizationOwner = fixture.finalizationOwner,
      ) => createOrdinaryFeedPostReceiptAdapter({
        delivery: {
          readFormalFeedContentDeliveryRequest: object => {
            sequence.push('DeliveryOwner')
            return fixture.deliveryAndReceipt.readFormalFeedContentDeliveryRequest(object)
          },
        },
        finalizer: {
          requestFormalContentDelivery: request => {
            sequence.push('C19')
            return finalizer.requestFormalContentDelivery(request)
          },
          acceptFormalFeedContentDeliveryReceipt: value => {
            sequence.push('C21')
            expect(value).toEqual(formalReceipt)
            return finalizer.acceptFormalFeedContentDeliveryReceipt(value)
          },
          ensureBusinessFinalization: value => {
            sequence.push('C23')
            return finalizer.ensureBusinessFinalization(value)
          },
        },
        candidateLocalState: {
          completePendingSourceDispositions: () => {
            sequence.push('CandidateLocalState')
            return candidateLocalState.completePendingSourceDispositions()
          },
        },
        finalizationOwner: {
          readAcceptedOrdinaryFinalization: period => {
            sequence.push('C23Owner')
            return finalizationOwner.readAcceptedOrdinaryFinalization(period)
          },
        },
        runDeliveryMeaningPort,
      })
      const adapter = createAdapter()

      await expect(adapter.settleDurableReceipt(input)).resolves.toEqual({ status: 'accepted' })

      expect(sequence).toEqual([
        'C1',
        'DeliveryOwner',
        'C19',
        'C21',
        'CandidateLocalState',
        'C23',
        'C23Owner',
        'C2',
      ])
      expect(acceptDurableReceipt).toHaveBeenCalledOnce()
      expect(commitBusinessFinalization).toHaveBeenCalledOnce()
      expect(countEvent(fixture.periodBusinessLedgerPath, 'formal_content_delivery_accepted')).toBe(1)
      expect(countEvent(fixture.periodBusinessLedgerPath, 'formal_content_delivery_receipt_accepted')).toBe(1)
      expect(countEvent(fixture.periodBusinessLedgerPath, 'business_finalization_accepted')).toBe(1)
      expect(countEvent(fixture.candidateLocalStateLedgerPath, 'candidate_disposition_accepted')).toBe(2)
      expect(countEvent(fixture.candidateLocalStateLedgerPath, 'source_disposition_completion_accepted')).toBe(2)
      expect(countEvent(fixture.editingInputLedgerPath, 'display_fact_accepted')).toBe(1)
      expect(countEvent(fixture.ordinaryBusinessFinalizationLedgerPath, 'ordinary_business_finalization_accepted')).toBe(1)
      const afterFirst = snapshotDirectory(fixture.directory)
      sequence.length = 0
      const rebuiltAdapter = createAdapter(
        fixture.rebuildFinalizer(),
        fixture.rebuildCandidateLocalState(),
        fixture.rebuildFinalizationOwner(),
      )

      await expect(rebuiltAdapter.settleDurableReceipt(input)).resolves.toEqual({ status: 'accepted' })

      expect(sequence).toEqual([
        'C1',
        'DeliveryOwner',
        'C19',
        'C21',
        'CandidateLocalState',
        'C23',
        'C23Owner',
        'C2',
      ])
      expect(snapshotDirectory(fixture.directory)).toEqual(afterFirst)
    } finally {
      fixture.dispose()
    }
  })

  it.each([
    ['failed', 'Failed', 'NotDeliveredThisPeriod', 'Suppressed'],
    ['uncertain', 'Uncertain', 'PossiblyDelivered', 'Suppressed'],
  ] as const)(
    'maps cron %s to the exact PF receipt, selected disposition, C18, and C28 fact',
    async (deliveryState, formalResult, selectedDisposition, sourceState) => {
      const { fixture, c19 } = await realC19Fixture()
      try {
        const input: CronDeliveryReceipt = {
          objectId: c19.value.request.object.object,
          jobId: `todo05-post-receipt-${deliveryState}`,
          runId: `todo05-post-receipt-${deliveryState}-run`,
          sessionId: `todo05-post-receipt-${deliveryState}-session`,
          scheduledFor: '2026-08-24T10:10:00.000Z',
          deliveryState,
          deliveryError: deliveryState === 'failed' ? 'controlled delivery failure' : 'ambiguous delivery result',
        }
        const port = acceptingRunPort()

        await expect(directAdapter(fixture, port).settleDurableReceipt(input))
          .resolves.toEqual({ status: 'accepted' })

        const receiptRows = eventRecords(
          fixture.periodBusinessLedgerPath,
          'formal_content_delivery_receipt_accepted',
        )
        expect(receiptRows).toHaveLength(1)
        expect(receiptRows[0]?.receipt).toEqual({
          object: c19.value.request.object.object,
          period: c19.value.request.object.period,
          result: formalResult,
        })
        const localOwners = eventRecords(
          fixture.candidateLocalStateLedgerPath,
          'candidate_disposition_accepted',
        )
        expect(localOwners.map(record => (record.disposition as { value?: unknown }).value).sort())
          .toEqual(['ReviewedNotSelected', selectedDisposition].sort())
        const selected = localOwners.find(record =>
          (record.disposition as { value?: unknown }).value === selectedDisposition)
        expect(selected?.state).toMatchObject({ state: sourceState })
        const displayFacts = eventRecords(fixture.editingInputLedgerPath, 'display_fact_accepted')
        expect(displayFacts).toHaveLength(1)
        expect(displayFacts[0]?.fact).toMatchObject({
          disposition: { value: selectedDisposition },
          receipt: { result: formalResult },
        })
        expect(port.commitBusinessFinalization).toHaveBeenCalledOnce()
      } finally {
        fixture.dispose()
      }
    },
  )

  it('repairs a Delivery-owner-first C19 gap before accepting C21 or committing C2', async () => {
    const { fixture, c19 } = await realC19Fixture()
    try {
      const businessRecords = readFileSync(fixture.periodBusinessLedgerPath, 'utf8').trim().split('\n')
        .map(line => JSON.parse(line) as Record<string, unknown>)
      writeFileSync(
        fixture.periodBusinessLedgerPath,
        `${businessRecords.filter(record => record.event !== 'formal_content_delivery_accepted')
          .map(record => JSON.stringify(record)).join('\n')}\n`,
        'utf8',
      )
      expect(fixture.deliveryAndReceipt.readFormalFeedContentDeliveryRequest(
        c19.value.request.object.object,
      )).toEqual(c19.value.request)
      expect(countEvent(fixture.periodBusinessLedgerPath, 'formal_content_delivery_accepted')).toBe(0)
      const input: CronDeliveryReceipt = {
        objectId: c19.value.request.object.object,
        jobId: 'todo05-post-receipt-c19-gap',
        runId: 'todo05-post-receipt-c19-gap-run',
        sessionId: 'todo05-post-receipt-c19-gap-session',
        scheduledFor: '2026-08-24T10:20:00.000Z',
        deliveryState: 'delivered',
      }
      const port = acceptingRunPort()

      await expect(directAdapter(fixture, port, fixture.rebuildFinalizer()).settleDurableReceipt(input))
        .resolves.toEqual({ status: 'accepted' })

      expect(countEvent(fixture.periodBusinessLedgerPath, 'formal_content_delivery_accepted')).toBe(1)
      expect(countEvent(fixture.periodBusinessLedgerPath, 'formal_content_delivery_receipt_accepted')).toBe(1)
      expect(countEvent(fixture.periodBusinessLedgerPath, 'business_finalization_accepted')).toBe(1)
      expect(port.commitBusinessFinalization).toHaveBeenCalledOnce()
    } finally {
      fixture.dispose()
    }
  })

  it('holds C2 across an owner-first C23 gap, then repairs PF C23 on rebuilt settlement', async () => {
    const { fixture, c19 } = await realC19Fixture()
    try {
      const input: CronDeliveryReceipt = {
        objectId: c19.value.request.object.object,
        jobId: 'todo05-post-receipt-c23-gap',
        runId: 'todo05-post-receipt-c23-gap-run',
        sessionId: 'todo05-post-receipt-c23-gap-session',
        scheduledFor: '2026-08-24T10:30:00.000Z',
        deliveryState: 'delivered',
      }
      const port = acceptingRunPort()
      const append = durableJsonlStore.appendJsonLine
      const appendSpy = vi.spyOn(durableJsonlStore, 'appendJsonLine').mockImplementation(
        (path, records, record) => {
          if ((record as { readonly event?: unknown }).event === 'business_finalization_accepted') {
            throw new Error('controlled C23 owner-first crash gap')
          }
          append(path, records, record)
        },
      )

      await expect(directAdapter(fixture, port).settleDurableReceipt(input))
        .resolves.toEqual({ status: 'failed', input })

      expect(countEvent(fixture.ordinaryBusinessFinalizationLedgerPath, 'ordinary_business_finalization_accepted')).toBe(1)
      expect(countEvent(fixture.periodBusinessLedgerPath, 'business_finalization_accepted')).toBe(0)
      expect(port.commitBusinessFinalization).not.toHaveBeenCalled()
      appendSpy.mockRestore()
      const beforeRepair = snapshotDirectory(fixture.directory)

      await expect(directAdapter(
        fixture,
        port,
        fixture.rebuildFinalizer(),
        fixture.rebuildCandidateLocalState(),
        fixture.rebuildFinalizationOwner(),
      ).settleDurableReceipt(input)).resolves.toEqual({ status: 'accepted' })

      expect(countEvent(fixture.ordinaryBusinessFinalizationLedgerPath, 'ordinary_business_finalization_accepted')).toBe(1)
      expect(countEvent(fixture.periodBusinessLedgerPath, 'business_finalization_accepted')).toBe(1)
      expect(port.commitBusinessFinalization).toHaveBeenCalledOnce()
      expect(snapshotDirectory(fixture.directory)).not.toEqual(beforeRepair)
      const afterRepair = snapshotDirectory(fixture.directory)
      await expect(directAdapter(
        fixture,
        port,
        fixture.rebuildFinalizer(),
        fixture.rebuildCandidateLocalState(),
        fixture.rebuildFinalizationOwner(),
      ).settleDurableReceipt(input)).resolves.toEqual({ status: 'accepted' })
      expect(snapshotDirectory(fixture.directory)).toEqual(afterRepair)
    } finally {
      vi.restoreAllMocks()
      fixture.dispose()
    }
  })

  it.each(['C1', 'C19', 'C21', 'CandidateLocalState', 'C23', 'C2'] as const)(
    'rejects an accepted %s result with a symbol extra before the next stage',
    async faultStage => {
      const { fixture, c19 } = await realC19Fixture()
      try {
        const input: CronDeliveryReceipt = {
          objectId: c19.value.request.object.object,
          jobId: `todo05-post-receipt-symbol-${faultStage}`,
          runId: `todo05-post-receipt-symbol-${faultStage}-run`,
          sessionId: `todo05-post-receipt-symbol-${faultStage}-session`,
          scheduledFor: '2026-08-24T10:40:00.000Z',
          deliveryState: 'delivered',
        }
        const sequence: string[] = []
        const withSymbolExtra = <Value extends object>(value: Value): Value => {
          const result = { ...value }
          Object.defineProperty(result, Symbol('unexpected'), { value: true, enumerable: true })
          return result
        }
        const runDeliveryMeaningPort: OrdinaryFeedPostReceiptRunPort = {
          acceptDurableReceipt: async value => {
            sequence.push('C1')
            const accepted = { status: 'accepted' as const, value: { receipt: value } }
            return faultStage === 'C1' ? withSymbolExtra(accepted) : accepted
          },
          commitBusinessFinalization: async () => {
            sequence.push('C2')
            const accepted = { status: 'accepted' as const }
            return faultStage === 'C2' ? withSymbolExtra(accepted) : accepted
          },
        }
        const adapter = createOrdinaryFeedPostReceiptAdapter({
          delivery: {
            readFormalFeedContentDeliveryRequest: object => {
              sequence.push('DeliveryOwner')
              return fixture.deliveryAndReceipt.readFormalFeedContentDeliveryRequest(object)
            },
          },
          finalizer: {
            requestFormalContentDelivery: request => {
              sequence.push('C19')
              const result = fixture.finalizer.requestFormalContentDelivery(request)
              return faultStage === 'C19' ? withSymbolExtra(result) : result
            },
            acceptFormalFeedContentDeliveryReceipt: receipt => {
              sequence.push('C21')
              const result = fixture.finalizer.acceptFormalFeedContentDeliveryReceipt(receipt)
              return faultStage === 'C21' ? withSymbolExtra(result) : result
            },
            ensureBusinessFinalization: finalization => {
              sequence.push('C23')
              const result = fixture.finalizer.ensureBusinessFinalization(finalization)
              return faultStage === 'C23' ? withSymbolExtra(result) : result
            },
          },
          candidateLocalState: {
            completePendingSourceDispositions: () => {
              sequence.push('CandidateLocalState')
              const result = fixture.candidateLocalState.completePendingSourceDispositions()
              return faultStage === 'CandidateLocalState' ? withSymbolExtra(result) : result
            },
          },
          finalizationOwner: {
            readAcceptedOrdinaryFinalization: period => {
              sequence.push('C23Owner')
              return fixture.finalizationOwner.readAcceptedOrdinaryFinalization(period)
            },
          },
          runDeliveryMeaningPort,
        })
        const fullSequence = [
          'C1',
          'DeliveryOwner',
          'C19',
          'C21',
          'CandidateLocalState',
          'C23',
          'C23Owner',
          'C2',
        ]
        const faultIndex = fullSequence.indexOf(faultStage)

        await expect(adapter.settleDurableReceipt(input)).resolves.toEqual({ status: 'failed', input })

        expect(sequence).toEqual(fullSequence.slice(0, faultIndex + 1))
        if (faultStage !== 'C2') expect(sequence).not.toContain('C2')
      } finally {
        fixture.dispose()
      }
    },
  )

  it('does not commit C2 until the separate ordinary C23 owner can be read back exactly', async () => {
    const { fixture, c19 } = await realC19Fixture()
    try {
      const input: CronDeliveryReceipt = {
        objectId: c19.value.request.object.object,
        jobId: 'todo05-post-receipt-owner-read',
        runId: 'todo05-post-receipt-owner-read-run',
        sessionId: 'todo05-post-receipt-owner-read-session',
        scheduledFor: '2026-08-24T10:50:00.000Z',
        deliveryState: 'delivered',
      }
      const port = acceptingRunPort()
      const blocked = createOrdinaryFeedPostReceiptAdapter({
        delivery: fixture.deliveryAndReceipt,
        finalizer: fixture.finalizer,
        candidateLocalState: fixture.candidateLocalState,
        finalizationOwner: { readAcceptedOrdinaryFinalization: () => undefined },
        runDeliveryMeaningPort: port,
      })

      await expect(blocked.settleDurableReceipt(input)).resolves.toEqual({ status: 'failed', input })

      expect(countEvent(fixture.periodBusinessLedgerPath, 'business_finalization_accepted')).toBe(1)
      expect(countEvent(fixture.ordinaryBusinessFinalizationLedgerPath, 'ordinary_business_finalization_accepted')).toBe(1)
      expect(port.commitBusinessFinalization).not.toHaveBeenCalled()
      const beforeRepair = snapshotDirectory(fixture.directory)

      await expect(directAdapter(
        fixture,
        port,
        fixture.rebuildFinalizer(),
        fixture.rebuildCandidateLocalState(),
        fixture.rebuildFinalizationOwner(),
      ).settleDurableReceipt(input)).resolves.toEqual({ status: 'accepted' })

      expect(port.commitBusinessFinalization).toHaveBeenCalledOnce()
      expect(snapshotDirectory(fixture.directory)).toEqual(beforeRepair)
    } finally {
      fixture.dispose()
    }
  })

  it('retries only C2 after a failed commit without changing any PF or X owner bytes', async () => {
    const { fixture, c19 } = await realC19Fixture()
    try {
      const input: CronDeliveryReceipt = {
        objectId: c19.value.request.object.object,
        jobId: 'todo05-post-receipt-c2-retry',
        runId: 'todo05-post-receipt-c2-retry-run',
        sessionId: 'todo05-post-receipt-c2-retry-session',
        scheduledFor: '2026-08-24T11:00:00.000Z',
        deliveryState: 'delivered',
      }
      let allowCommit = false
      const commitBusinessFinalization = vi.fn<
        OrdinaryFeedPostReceiptRunPort['commitBusinessFinalization']
      >(async () => allowCommit
        ? { status: 'accepted' }
        : { status: 'failed', input: undefined })
      const port = acceptingRunPort(commitBusinessFinalization)

      await expect(directAdapter(fixture, port).settleDurableReceipt(input))
        .resolves.toEqual({ status: 'failed', input })

      expect(commitBusinessFinalization).toHaveBeenCalledOnce()
      const beforeRetry = snapshotDirectory(fixture.directory)
      allowCommit = true

      await expect(directAdapter(
        fixture,
        port,
        fixture.rebuildFinalizer(),
        fixture.rebuildCandidateLocalState(),
        fixture.rebuildFinalizationOwner(),
      ).settleDurableReceipt(input)).resolves.toEqual({ status: 'accepted' })

      expect(commitBusinessFinalization).toHaveBeenCalledTimes(2)
      expect(snapshotDirectory(fixture.directory)).toEqual(beforeRetry)
    } finally {
      fixture.dispose()
    }
  })
})
