import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type {
  CronAgentEnvironmentBindPreparedDeliveryContext,
  CronRunDeliveryMeaningRunPort,
  PreparedDeliveryObject,
} from '@deepseek-ai/dsh-cron'
import type {
  DeliveryAndReceipt,
  FormalFeedContentDeliveryAccepted,
  PeriodBusinessFinalizer,
} from '@herman/personal-feed'
import { createPeriodBusinessFinalizer } from '@herman/personal-feed'
import {
  createOrdinaryFeedPreparedDeliveryAdapter,
  type OrdinaryFeedDeliveryOwnerReader,
  type OrdinaryFeedPreparedDeliveryAdapter,
  type OrdinaryFeedPreparedDeliveryAdapterOptions,
  type OrdinaryFeedPreparedDeliveryBindResult,
  type OrdinaryFeedPreparedDeliveryResult,
} from '../src/personal-feed/ordinary-feed-prepared-delivery-adapter.ts'
import { createOrdinaryFeedEditorAdapter } from '../src/personal-feed/ordinary-feed-editor-adapter.ts'
import {
  createRealOrdinaryFeedFixture,
  ordinaryFeedProposal,
} from './support/todo05-real-ordinary-feed-fixture.ts'

type Equal<Left, Right> = (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2) ? true : false
type Assert<Value extends true> = Value

type _Owner = Assert<Equal<
  OrdinaryFeedDeliveryOwnerReader,
  Pick<DeliveryAndReceipt, 'readFormalFeedContentDeliveryRequest'>
>>
type _Options = Assert<Equal<
  OrdinaryFeedPreparedDeliveryAdapterOptions,
  {
    readonly delivery: OrdinaryFeedDeliveryOwnerReader
    readonly finalizer: Pick<PeriodBusinessFinalizer, 'requestFormalContentDelivery'>
  }
>>
type _OptionsKeys = Assert<Equal<
  keyof OrdinaryFeedPreparedDeliveryAdapterOptions,
  'delivery' | 'finalizer'
>>
type _RuntimeKeys = Assert<Equal<
  keyof OrdinaryFeedPreparedDeliveryAdapter,
  'prepareAcceptedContent' | 'bindPreparedDelivery'
>>
type _PrepareInput = Assert<Equal<
  Parameters<OrdinaryFeedPreparedDeliveryAdapter['prepareAcceptedContent']>,
  [FormalFeedContentDeliveryAccepted]
>>
type _PrepareResult = Assert<Equal<
  ReturnType<OrdinaryFeedPreparedDeliveryAdapter['prepareAcceptedContent']>,
  OrdinaryFeedPreparedDeliveryResult
>>
type _BindInput = Assert<Equal<
  Parameters<OrdinaryFeedPreparedDeliveryAdapter['bindPreparedDelivery']>,
  [CronAgentEnvironmentBindPreparedDeliveryContext]
>>
type _BindResult = Assert<Equal<
  Awaited<ReturnType<OrdinaryFeedPreparedDeliveryAdapter['bindPreparedDelivery']>>,
  OrdinaryFeedPreparedDeliveryBindResult
>>
type _PreparedValue = Assert<Equal<
  Extract<OrdinaryFeedPreparedDeliveryResult, { readonly status: 'accepted' }>['value'],
  { readonly preparedDelivery: PreparedDeliveryObject }
>>

function snapshotDirectory(directory: string): readonly {
  readonly path: string
  readonly base64: string
}[] {
  return readdirSync(directory)
    .sort((left, right) => left.localeCompare(right))
    .map(path => ({ path, base64: readFileSync(join(directory, path)).toString('base64') }))
}

function runPort(
  bind: CronRunDeliveryMeaningRunPort['bindPreparedDelivery'] = async () => ({ status: 'accepted' }),
): CronRunDeliveryMeaningRunPort {
  return Object.freeze({
    bindPreparedDelivery: vi.fn(bind),
    acceptDurableReceipt: vi.fn<CronRunDeliveryMeaningRunPort['acceptDurableReceipt']>(
      async receipt => ({ status: 'failed', input: receipt }),
    ),
    commitBusinessFinalization: vi.fn<
      CronRunDeliveryMeaningRunPort['commitBusinessFinalization']
    >(async () => ({ status: 'failed', input: undefined })),
  })
}

async function acceptedC19Fixture() {
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
  const body = c19.value.request.object.content.body
  if (typeof body !== 'string') {
    fixture.dispose()
    throw new Error('real ordinary Feed body was not text')
  }
  return { fixture, c19, body }
}

describe('TODO05 ordinary-feed prepared-delivery adapter bootstrap', () => {
  it('projects a real durable C19 object and binds its internal business identity after preparation', async () => {
    const fixture = await createRealOrdinaryFeedFixture()
    try {
      const c19 = createOrdinaryFeedEditorAdapter({
        period: fixture.period,
        editor: fixture.editor,
        finalizer: fixture.finalizer,
      }).acceptEditingProposal(ordinaryFeedProposal())
      expect(c19.status).toBe('accepted')
      if (c19.status !== 'accepted') throw new Error('real ordinary Feed chain did not reach C19')
      expect(fixture.deliveryAndReceipt.readFormalFeedContentDeliveryRequest(
        c19.value.request.object.object,
      )).toEqual(c19.value.request)
      const body = c19.value.request.object.content.body
      expect(typeof body).toBe('string')
      if (typeof body !== 'string') throw new Error('real ordinary Feed body was not text')
      const before = snapshotDirectory(fixture.directory)
      const adapter = createOrdinaryFeedPreparedDeliveryAdapter({
        delivery: fixture.deliveryAndReceipt,
        finalizer: fixture.finalizer,
      })

      const prepared = adapter.prepareAcceptedContent(c19.value)

      expect(prepared).toEqual({
        status: 'accepted',
        value: {
          preparedDelivery: {
            objectId: c19.value.request.object.object,
            text: body,
          },
        },
      })
      if (prepared.status !== 'accepted') throw new Error('real C19 was not projected for cron delivery')
      expect(Reflect.ownKeys(prepared.value.preparedDelivery)).toEqual(['objectId', 'text'])
      const bindPreparedDelivery = vi.fn<CronRunDeliveryMeaningRunPort['bindPreparedDelivery']>(
        async () => ({ status: 'accepted' }),
      )
      const acceptDurableReceipt = vi.fn<CronRunDeliveryMeaningRunPort['acceptDurableReceipt']>(
        async receipt => ({ status: 'failed', input: receipt }),
      )
      const commitBusinessFinalization = vi.fn<
        CronRunDeliveryMeaningRunPort['commitBusinessFinalization']
      >(async () => ({ status: 'failed', input: undefined }))
      const runDeliveryMeaningPort: CronRunDeliveryMeaningRunPort = Object.freeze({
        bindPreparedDelivery,
        acceptDurableReceipt,
        commitBusinessFinalization,
      })
      const bindInput: CronAgentEnvironmentBindPreparedDeliveryContext = Object.freeze({
        preparedDelivery: prepared.value.preparedDelivery,
        runDeliveryMeaningPort,
      })

      await expect(adapter.bindPreparedDelivery(bindInput)).resolves.toEqual({ status: 'accepted' })

      expect(bindPreparedDelivery).toHaveBeenCalledOnce()
      expect(bindPreparedDelivery).toHaveBeenCalledWith({
        businessRunId: c19.value.request.object.period.run,
        businessPeriodId: c19.value.request.object.period.period,
      })
      expect(acceptDurableReceipt).not.toHaveBeenCalled()
      expect(commitBusinessFinalization).not.toHaveBeenCalled()
      expect(snapshotDirectory(fixture.directory)).toEqual(before)
    } finally {
      fixture.dispose()
    }
  })

  it('rejects a prepared object with an extra field before invoking the cron run port', async () => {
    const { fixture, c19, body } = await acceptedC19Fixture()
    try {
      const adapter = createOrdinaryFeedPreparedDeliveryAdapter({
        delivery: fixture.deliveryAndReceipt,
        finalizer: fixture.finalizer,
      })
      const port = runPort()
      const input = {
        preparedDelivery: {
          objectId: c19.value.request.object.object,
          text: body,
          extra: true,
        },
        runDeliveryMeaningPort: port,
      } as CronAgentEnvironmentBindPreparedDeliveryContext
      const before = snapshotDirectory(fixture.directory)

      await expect(adapter.bindPreparedDelivery(input)).resolves.toEqual({ status: 'rejected', input })

      expect(port.bindPreparedDelivery).not.toHaveBeenCalled()
      expect(snapshotDirectory(fixture.directory)).toEqual(before)
    } finally {
      fixture.dispose()
    }
  })

  it('fails when the cron run port rejects a different business binding', async () => {
    const { fixture, c19 } = await acceptedC19Fixture()
    try {
      const adapter = createOrdinaryFeedPreparedDeliveryAdapter({
        delivery: fixture.deliveryAndReceipt,
        finalizer: fixture.finalizer,
      })
      const prepared = adapter.prepareAcceptedContent(c19.value)
      if (prepared.status !== 'accepted') throw new Error('real C19 was not projected for cron delivery')
      const port = runPort(async () => ({
        status: 'rejected',
        input: { businessRunId: 'wrong-run', businessPeriodId: 'wrong-period' },
      }))
      const input: CronAgentEnvironmentBindPreparedDeliveryContext = {
        preparedDelivery: prepared.value.preparedDelivery,
        runDeliveryMeaningPort: port,
      }
      const before = snapshotDirectory(fixture.directory)

      await expect(adapter.bindPreparedDelivery(input)).resolves.toEqual({ status: 'failed', input })

      expect(port.bindPreparedDelivery).toHaveBeenCalledWith({
        businessRunId: c19.value.request.object.period.run,
        businessPeriodId: c19.value.request.object.period.period,
      })
      expect(snapshotDirectory(fixture.directory)).toEqual(before)
    } finally {
      fixture.dispose()
    }
  })

  it('fails without binding when a prepared object no longer matches its real C19 body', async () => {
    const { fixture, c19, body } = await acceptedC19Fixture()
    try {
      const adapter = createOrdinaryFeedPreparedDeliveryAdapter({
        delivery: fixture.deliveryAndReceipt,
        finalizer: fixture.finalizer,
      })
      const port = runPort()
      const input: CronAgentEnvironmentBindPreparedDeliveryContext = {
        preparedDelivery: {
          objectId: c19.value.request.object.object,
          text: `${body}\nforged`,
        },
        runDeliveryMeaningPort: port,
      }
      const before = snapshotDirectory(fixture.directory)

      await expect(adapter.bindPreparedDelivery(input)).resolves.toEqual({ status: 'failed', input })

      expect(port.bindPreparedDelivery).not.toHaveBeenCalled()
      expect(snapshotDirectory(fixture.directory)).toEqual(before)
    } finally {
      fixture.dispose()
    }
  })

  it('fails when the durable C19 owner cannot be read', async () => {
    const { fixture, c19 } = await acceptedC19Fixture()
    try {
      const missing = createOrdinaryFeedPreparedDeliveryAdapter({
        delivery: { readFormalFeedContentDeliveryRequest: () => undefined },
        finalizer: fixture.finalizer,
      })
      const throwing = createOrdinaryFeedPreparedDeliveryAdapter({
        delivery: {
          readFormalFeedContentDeliveryRequest: () => {
            throw new Error('controlled delivery owner read failure')
          },
        },
        finalizer: fixture.finalizer,
      })
      const before = snapshotDirectory(fixture.directory)

      expect(missing.prepareAcceptedContent(c19.value)).toEqual({ status: 'failed', input: c19.value })
      expect(throwing.prepareAcceptedContent(c19.value)).toEqual({ status: 'failed', input: c19.value })
      expect(snapshotDirectory(fixture.directory)).toEqual(before)
    } finally {
      fixture.dispose()
    }
  })

  it('fails when a purported C19 accepted value diverges from its durable owner', async () => {
    const { fixture, c19, body } = await acceptedC19Fixture()
    try {
      const adapter = createOrdinaryFeedPreparedDeliveryAdapter({
        delivery: fixture.deliveryAndReceipt,
        finalizer: fixture.finalizer,
      })
      const input = {
        request: {
          object: {
            ...c19.value.request.object,
            content: { body: `${body}\nforged before preparation` },
          },
        },
      } as FormalFeedContentDeliveryAccepted
      const before = snapshotDirectory(fixture.directory)

      expect(adapter.prepareAcceptedContent(input)).toEqual({ status: 'failed', input })

      expect(snapshotDirectory(fixture.directory)).toEqual(before)
    } finally {
      fixture.dispose()
    }
  })

  it('maps only an exact cron binding result and preserves the original bind context', async () => {
    const { fixture, c19 } = await acceptedC19Fixture()
    try {
      const adapter = createOrdinaryFeedPreparedDeliveryAdapter({
        delivery: fixture.deliveryAndReceipt,
        finalizer: fixture.finalizer,
      })
      const prepared = adapter.prepareAcceptedContent(c19.value)
      if (prepared.status !== 'accepted') throw new Error('real C19 was not projected for cron delivery')
      const cases = [
        {
          result: (binding: { readonly businessRunId: string; readonly businessPeriodId: string }) => ({
            status: 'rejected' as const,
            input: binding,
          }),
          expected: 'rejected' as const,
        },
        {
          result: (binding: { readonly businessRunId: string; readonly businessPeriodId: string }) => ({
            status: 'failed' as const,
            input: binding,
          }),
          expected: 'failed' as const,
        },
        {
          result: () => ({ status: 'accepted' as const, extra: true }),
          expected: 'failed' as const,
        },
      ]
      for (const current of cases) {
        const port = runPort(async binding => current.result(binding))
        const input: CronAgentEnvironmentBindPreparedDeliveryContext = {
          preparedDelivery: prepared.value.preparedDelivery,
          runDeliveryMeaningPort: port,
        }
        await expect(adapter.bindPreparedDelivery(input)).resolves.toEqual(
          current.expected === 'rejected'
            ? { status: 'rejected', input }
            : { status: 'failed', input },
        )
      }
      const throwingPort = runPort(async () => {
        throw new Error('controlled cron binding failure')
      })
      const throwingInput: CronAgentEnvironmentBindPreparedDeliveryContext = {
        preparedDelivery: prepared.value.preparedDelivery,
        runDeliveryMeaningPort: throwingPort,
      }
      await expect(adapter.bindPreparedDelivery(throwingInput)).resolves.toEqual({
        status: 'failed',
        input: throwingInput,
      })
    } finally {
      fixture.dispose()
    }
  })

  it('rejects malformed and non-ordinary C19 inputs before reading an owner', async () => {
    const { fixture, c19 } = await acceptedC19Fixture()
    try {
      const readOwner = vi.fn<OrdinaryFeedDeliveryOwnerReader['readFormalFeedContentDeliveryRequest']>(
        object => fixture.deliveryAndReceipt.readFormalFeedContentDeliveryRequest(object),
      )
      const adapter = createOrdinaryFeedPreparedDeliveryAdapter({
        delivery: { readFormalFeedContentDeliveryRequest: readOwner },
        finalizer: fixture.finalizer,
      })
      const withExtra = { ...c19.value, extra: true } as FormalFeedContentDeliveryAccepted
      const empty = {
        request: {
          object: {
            ...c19.value.request.object,
            selected: {},
          },
        },
      } as FormalFeedContentDeliveryAccepted

      expect(adapter.prepareAcceptedContent(withExtra)).toEqual({ status: 'rejected', input: withExtra })
      expect(adapter.prepareAcceptedContent(empty)).toEqual({ status: 'rejected', input: empty })
      expect(readOwner).not.toHaveBeenCalled()
    } finally {
      fixture.dispose()
    }
  })

  it('rejects an oversized accepted body before reading the durable owner', async () => {
    const { fixture, c19 } = await acceptedC19Fixture()
    try {
      const readOwner = vi.fn<OrdinaryFeedDeliveryOwnerReader['readFormalFeedContentDeliveryRequest']>(
        object => fixture.deliveryAndReceipt.readFormalFeedContentDeliveryRequest(object),
      )
      const adapter = createOrdinaryFeedPreparedDeliveryAdapter({
        delivery: { readFormalFeedContentDeliveryRequest: readOwner },
        finalizer: fixture.finalizer,
      })
      const input = {
        request: {
          object: {
            ...c19.value.request.object,
            content: { body: 'x'.repeat(64 * 1024 + 1) },
          },
        },
      } as FormalFeedContentDeliveryAccepted
      const before = snapshotDirectory(fixture.directory)

      expect(adapter.prepareAcceptedContent(input)).toEqual({ status: 'rejected', input })

      expect(readOwner).not.toHaveBeenCalled()
      expect(snapshotDirectory(fixture.directory)).toEqual(before)
    } finally {
      fixture.dispose()
    }
  })

  it('exposes a frozen fail-closed adapter without reading or binding delivery facts', async () => {
    const delivery: OrdinaryFeedDeliveryOwnerReader = {
      readFormalFeedContentDeliveryRequest: vi.fn<
        OrdinaryFeedDeliveryOwnerReader['readFormalFeedContentDeliveryRequest']
      >(),
    }
    const requestFormalContentDelivery = vi.fn<PeriodBusinessFinalizer['requestFormalContentDelivery']>(
      request => ({ status: 'failed', input: request }),
    )
    const runtime = createOrdinaryFeedPreparedDeliveryAdapter({
      delivery,
      finalizer: { requestFormalContentDelivery },
    })
    const c19 = Object.freeze({ request: Object.freeze({ object: Object.freeze({}) }) }) as
      FormalFeedContentDeliveryAccepted
    const bind = Object.freeze({}) as CronAgentEnvironmentBindPreparedDeliveryContext

    expect(Object.isFrozen(runtime)).toBe(true)
    expect(Reflect.ownKeys(runtime)).toEqual(['prepareAcceptedContent', 'bindPreparedDelivery'])
    expect(runtime.prepareAcceptedContent(c19)).toEqual({ status: 'rejected', input: c19 })
    await expect(runtime.bindPreparedDelivery(bind)).resolves.toEqual({ status: 'rejected', input: bind })
    expect(delivery.readFormalFeedContentDeliveryRequest).not.toHaveBeenCalled()
    expect(requestFormalContentDelivery).not.toHaveBeenCalled()
  })

  it('repairs the receiver-first C19 crash gap through the real finalizer before preparation', async () => {
    const { fixture, c19 } = await acceptedC19Fixture()
    try {
      const periodBusinessLedgerPath = join(fixture.directory, 'period-business.jsonl')
      const rows = readFileSync(periodBusinessLedgerPath, 'utf8')
        .trimEnd()
        .split('\n')
        .filter(line => JSON.parse(line).event !== 'formal_content_delivery_accepted')
      writeFileSync(periodBusinessLedgerPath, `${rows.join('\n')}\n`, 'utf8')
      expect(fixture.deliveryAndReceipt.readFormalFeedContentDeliveryRequest(
        c19.value.request.object.object,
      )).toEqual(c19.value.request)
      expect(rows.some(line => JSON.parse(line).event === 'formal_content_delivery_accepted')).toBe(false)
      const rebuiltFinalizer = createPeriodBusinessFinalizer({
        periodScopeLedgerPath: join(fixture.directory, 'period-scopes.jsonl'),
        reportLedgerPath: join(fixture.directory, 'source-candidate-reports.jsonl'),
        candidatePeriodLedgerPath: join(fixture.directory, 'candidate-period-facts.jsonl'),
        editingInputLedgerPath: join(fixture.directory, 'editing-inputs.jsonl'),
        periodBusinessLedgerPath,
        now: () => '2026-08-24T00:03:00.000Z',
        editingInputClosureReceiver: fixture.editor,
        formalContentDeliveryReceiver: fixture.deliveryAndReceipt,
      })
      const adapter = createOrdinaryFeedPreparedDeliveryAdapter({
        delivery: fixture.deliveryAndReceipt,
        finalizer: rebuiltFinalizer,
      })

      expect(adapter.prepareAcceptedContent(c19.value).status).toBe('accepted')

      const repaired = readFileSync(periodBusinessLedgerPath, 'utf8')
        .trimEnd()
        .split('\n')
        .filter(line => JSON.parse(line).event === 'formal_content_delivery_accepted')
      expect(repaired).toHaveLength(1)
      const afterRepair = snapshotDirectory(fixture.directory)
      const rebuiltAdapter = createOrdinaryFeedPreparedDeliveryAdapter({
        delivery: fixture.deliveryAndReceipt,
        finalizer: createPeriodBusinessFinalizer({
          periodScopeLedgerPath: join(fixture.directory, 'period-scopes.jsonl'),
          reportLedgerPath: join(fixture.directory, 'source-candidate-reports.jsonl'),
          candidatePeriodLedgerPath: join(fixture.directory, 'candidate-period-facts.jsonl'),
          editingInputLedgerPath: join(fixture.directory, 'editing-inputs.jsonl'),
          periodBusinessLedgerPath,
          now: () => '2026-08-24T00:04:00.000Z',
          editingInputClosureReceiver: fixture.editor,
          formalContentDeliveryReceiver: fixture.deliveryAndReceipt,
        }),
      })
      expect(rebuiltAdapter.prepareAcceptedContent(c19.value).status).toBe('accepted')
      expect(snapshotDirectory(fixture.directory)).toEqual(afterRepair)
    } finally {
      fixture.dispose()
    }
  })

  it('invokes only the descriptor-validated cron bind method when owner reading mutates the input', async () => {
    const { fixture, c19 } = await acceptedC19Fixture()
    try {
      const prepared = createOrdinaryFeedPreparedDeliveryAdapter({
        delivery: fixture.deliveryAndReceipt,
        finalizer: fixture.finalizer,
      }).prepareAcceptedContent(c19.value)
      if (prepared.status !== 'accepted') throw new Error('real C19 was not projected for cron delivery')
      const verified = runPort()
      const replacement = runPort()
      let input: CronAgentEnvironmentBindPreparedDeliveryContext
      const adapter = createOrdinaryFeedPreparedDeliveryAdapter({
        delivery: {
          readFormalFeedContentDeliveryRequest: object => {
            Object.defineProperty(input, 'runDeliveryMeaningPort', {
              value: replacement,
              enumerable: true,
              configurable: true,
              writable: true,
            })
            return fixture.deliveryAndReceipt.readFormalFeedContentDeliveryRequest(object)
          },
        },
        finalizer: fixture.finalizer,
      })
      input = {
        preparedDelivery: prepared.value.preparedDelivery,
        runDeliveryMeaningPort: verified,
      }

      await expect(adapter.bindPreparedDelivery(input)).resolves.toEqual({ status: 'accepted' })

      expect(verified.bindPreparedDelivery).toHaveBeenCalledOnce()
      expect(replacement.bindPreparedDelivery).not.toHaveBeenCalled()
    } finally {
      fixture.dispose()
    }
  })

  it('fails closed when the PF C19 owner is corrupt even though the delivery owner remains durable', async () => {
    const { fixture, c19 } = await acceptedC19Fixture()
    try {
      const periodBusinessLedgerPath = join(fixture.directory, 'period-business.jsonl')
      const rows = readFileSync(periodBusinessLedgerPath, 'utf8')
        .trimEnd()
        .split('\n')
        .map(line => {
          const row = JSON.parse(line)
          return JSON.stringify(row.event === 'formal_content_delivery_accepted'
            ? { ...row, accepted: { request: { object: { ...row.request.object, extra: true } } } }
            : row)
        })
      writeFileSync(periodBusinessLedgerPath, `${rows.join('\n')}\n`, 'utf8')
      expect(fixture.deliveryAndReceipt.readFormalFeedContentDeliveryRequest(
        c19.value.request.object.object,
      )).toEqual(c19.value.request)
      const before = snapshotDirectory(fixture.directory)
      const adapter = createOrdinaryFeedPreparedDeliveryAdapter({
        delivery: fixture.deliveryAndReceipt,
        finalizer: createPeriodBusinessFinalizer({
          periodScopeLedgerPath: join(fixture.directory, 'period-scopes.jsonl'),
          reportLedgerPath: join(fixture.directory, 'source-candidate-reports.jsonl'),
          candidatePeriodLedgerPath: join(fixture.directory, 'candidate-period-facts.jsonl'),
          editingInputLedgerPath: join(fixture.directory, 'editing-inputs.jsonl'),
          periodBusinessLedgerPath,
          now: () => '2026-08-24T00:05:00.000Z',
          editingInputClosureReceiver: fixture.editor,
          formalContentDeliveryReceiver: fixture.deliveryAndReceipt,
        }),
      })

      expect(adapter.prepareAcceptedContent(c19.value)).toEqual({ status: 'failed', input: c19.value })

      expect(snapshotDirectory(fixture.directory)).toEqual(before)
    } finally {
      fixture.dispose()
    }
  })

  it('fails without invoking cron when the delivery owner is missing or unreadable during bind', async () => {
    const { fixture, c19 } = await acceptedC19Fixture()
    try {
      const prepared = createOrdinaryFeedPreparedDeliveryAdapter({
        delivery: fixture.deliveryAndReceipt,
        finalizer: fixture.finalizer,
      }).prepareAcceptedContent(c19.value)
      if (prepared.status !== 'accepted') throw new Error('real C19 was not projected for cron delivery')
      const before = snapshotDirectory(fixture.directory)
      for (const readFormalFeedContentDeliveryRequest of [
        () => undefined,
        () => { throw new Error('controlled bind owner read failure') },
      ] as const) {
        const port = runPort()
        const input: CronAgentEnvironmentBindPreparedDeliveryContext = {
          preparedDelivery: prepared.value.preparedDelivery,
          runDeliveryMeaningPort: port,
        }
        const adapter = createOrdinaryFeedPreparedDeliveryAdapter({
          delivery: { readFormalFeedContentDeliveryRequest },
          finalizer: fixture.finalizer,
        })

        await expect(adapter.bindPreparedDelivery(input)).resolves.toEqual({ status: 'failed', input })
        expect(port.bindPreparedDelivery).not.toHaveBeenCalled()
      }
      expect(snapshotDirectory(fixture.directory)).toEqual(before)
    } finally {
      fixture.dispose()
    }
  })

  it('fails when the finalizer does not echo the exact durable C19 request', async () => {
    const { fixture, c19 } = await acceptedC19Fixture()
    try {
      const requestFormalContentDelivery = vi.fn<PeriodBusinessFinalizer['requestFormalContentDelivery']>(
        request => ({
          status: 'accepted',
          value: {
            request: {
              object: { ...request.object, content: { body: 'different formal body' } },
            },
          },
        } as ReturnType<PeriodBusinessFinalizer['requestFormalContentDelivery']>),
      )
      const adapter = createOrdinaryFeedPreparedDeliveryAdapter({
        delivery: fixture.deliveryAndReceipt,
        finalizer: { requestFormalContentDelivery },
      })
      const before = snapshotDirectory(fixture.directory)

      expect(adapter.prepareAcceptedContent(c19.value)).toEqual({ status: 'failed', input: c19.value })

      expect(requestFormalContentDelivery).toHaveBeenCalledWith(c19.value.request)
      expect(snapshotDirectory(fixture.directory)).toEqual(before)
    } finally {
      fixture.dispose()
    }
  })
})
