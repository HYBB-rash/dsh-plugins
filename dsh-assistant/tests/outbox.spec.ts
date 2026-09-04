/** Assistant-owned outbox semantics with a real SQLite store and scripted delivery port. */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AssistantTextDeliveryPort, AssistantTextDeliveryResult } from '../src/delivery-port.ts'
import { AssistantStore } from '../src/store.ts'
import { OutboxPump } from '../src/outbox.ts'

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-assistant-outbox-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const NOW = '2026-08-15T02:00:00.000Z'
const DELIVERED_AT = '2026-08-15T02:00:01.000Z'
const clock = () => Date.parse(NOW)

function fakeDelivery(results: AssistantTextDeliveryResult[] = [
  { state: 'delivered', deliveredAt: DELIVERED_AT },
]): AssistantTextDeliveryPort {
  let index = 0
  return {
    deliver: vi.fn(async () => results[Math.min(index++, results.length - 1)]!),
  }
}

function setup(results?: AssistantTextDeliveryResult[]) {
  const store = new AssistantStore(join(tempDir(), 'state.sqlite'))
  const delivery = fakeDelivery(results)
  const controller = new AbortController()
  const pump = new OutboxPump({
    store,
    delivery,
    signal: controller.signal,
    now: clock,
    logger: { warn: () => undefined },
  })
  return { store, delivery, pump, controller }
}

async function seedResult(store: AssistantStore, outboxId: string, text: string): Promise<void> {
  const created = store.createAgentCommitment({ title: 't', sourceSurface: 'telegram', now: NOW })
  if (!created.ok) throw new Error('seed failed')
  store.settleWorkerEnd(created.row.id, created.row.revision, {
    status: 'completed', result: 'r', completedAt: NOW, outboxId, outboxText: text,
  })
}

function seedMonitorEvent(store: AssistantStore, seed = 'monitor-event', text = 'event'):
  { commitmentId: string; outboxId: string } {
  const created = store.createAgentCommitment({
    title: 'watch', kind: 'monitor', monitorDirection: 'opaque-direction', sourceSurface: 'telegram', now: NOW,
  })
  if (!created.ok) throw new Error('monitor seed failed')
  const saved = store.saveWorkerIdentity(created.row.id, created.row.revision, {
    workerSessionId: `child-${seed}`, workerRunId: `run-${seed}`, workerParentSessionId: 'root-1',
  })
  if (!saved.ok) throw new Error('monitor identity failed')
  const active = store.markAgentActive(created.row.id, saved.row.revision)
  if (!active.ok) throw new Error('monitor activation failed')
  const settled = store.settleMonitorEvent({
    commitmentId: created.row.id,
    expectedRevision: active.row.revision,
    workerSessionId: `child-${seed}`,
    workerRunId: `run-${seed}`,
    workerParentSessionId: 'root-1',
    monitorResumeEpoch: active.row.monitorResumeEpoch,
    eventKey: `event-key-${seed}`,
    checkpoint: `checkpoint-${seed}`,
    summary: 'new event',
    outboxText: text,
    now: NOW,
  })
  if (!settled.ok) throw new Error('monitor event settlement failed')
  return { commitmentId: created.row.id, outboxId: settled.outbox.id }
}

describe('claim-before-deliver and terminal mapping', () => {
  it('claims first, submits the complete text once, and preserves provider delivery time', async () => {
    const { store, delivery, pump } = setup()
    const text = 'x'.repeat(4990)
    await seedResult(store, 'o1', text)
    const statesDuringDelivery: string[] = []
    vi.mocked(delivery.deliver).mockImplementationOnce(async input => {
      statesDuringDelivery.push(store.getOutbox('o1')!.state)
      expect(input.text).toBe(text)
      return { state: 'delivered', deliveredAt: DELIVERED_AT }
    })

    await pump.pumpOnce()

    expect(statesDuringDelivery).toEqual(['claimed'])
    expect(delivery.deliver).toHaveBeenCalledTimes(1)
    expect(store.getOutbox('o1')).toMatchObject({ state: 'delivered', deliveredAt: DELIVERED_AT })
    expect(store.getLastClosed()?.lastDeliveryState).toBe('delivered')
    store.close()
  })

  it.each([
    ['failed', { state: 'failed', error: 'no delivery provider' }],
    ['uncertain', { state: 'uncertain', error: 'network result unknown' }],
  ] as const)('records %s and never retries the claimed row', async (state, result) => {
    const { store, delivery, pump } = setup([result])
    await seedResult(store, 'o1', 'done')
    await pump.pumpOnce()
    await pump.pumpOnce()
    expect(delivery.deliver).toHaveBeenCalledTimes(1)
    expect(store.getOutbox('o1')).toMatchObject({ state, error: result.error })
    expect(store.getLastClosed()?.lastDeliveryState).toBe(state)
    store.close()
  })

  it('stale claimed rows become uncertain on start and are never delivered', async () => {
    const { store, delivery, pump } = setup()
    await seedResult(store, 'o1', 'done')
    store.claimOutbox('o1', NOW)
    pump.start(5000)
    await pump.pumpOnce()
    expect(store.getOutbox('o1')?.state).toBe('uncertain')
    expect(delivery.deliver).not.toHaveBeenCalled()
    await pump.stop()
    store.close()
  })
})

describe('monitor event delivery and continuation', () => {
  it('delivered advances the checkpoint and leaves a desired-running monitor for continuation', async () => {
    const { store, delivery, pump } = setup()
    const seeded = seedMonitorEvent(store)
    await pump.pumpOnce()
    expect(delivery.deliver).toHaveBeenCalledTimes(1)
    expect(store.getOutbox(seeded.outboxId)?.state).toBe('delivered')
    expect(store.getById(seeded.commitmentId)).toMatchObject({
      monitorCheckpoint: 'checkpoint-monitor-event', monitorDesiredState: 'running', monitorResumeState: 'needed',
    })
    store.close()
  })

  it.each([
    ['failed', { state: 'failed', error: 'rejected' }],
    ['uncertain', { state: 'uncertain', error: 'unknown' }],
  ] as const)('%s does not advance the checkpoint and never resends', async (state, result) => {
    const { store, delivery, pump } = setup([result])
    const seeded = seedMonitorEvent(store, `monitor-${state}`)
    await pump.pumpOnce()
    expect(store.getOutbox(seeded.outboxId)?.state).toBe(state)
    expect(store.getById(seeded.commitmentId)).toMatchObject({
      monitorCheckpoint: null, monitorDesiredState: 'running', monitorResumeState: 'needed',
    })
    await pump.pumpOnce()
    expect(delivery.deliver).toHaveBeenCalledTimes(1)
    store.close()
  })

  it('pause keeps a pending monitor event deliverable without resuming the monitor', async () => {
    const { store, delivery, pump } = setup()
    const seeded = seedMonitorEvent(store, 'monitor-pause-pending')
    const paused = store.pauseAgent(seeded.commitmentId, store.getById(seeded.commitmentId)!.revision)
    expect(paused.ok).toBe(true)
    await pump.pumpOnce()
    expect(delivery.deliver).toHaveBeenCalledTimes(1)
    expect(store.getById(seeded.commitmentId)).toMatchObject({
      monitorCheckpoint: 'checkpoint-monitor-pause-pending', monitorDesiredState: 'paused', monitorResumeState: 'none',
    })
    store.close()
  })

  it('pause does not abort an in-flight monitor event', async () => {
    const { store, delivery, pump } = setup()
    const seeded = seedMonitorEvent(store, 'monitor-pause')
    let release!: () => void
    let entered!: () => void
    const deliveryEntered = new Promise<void>(resolve => { entered = resolve })
    vi.mocked(delivery.deliver).mockImplementationOnce(async ({ signal }) => {
      entered()
      await new Promise<void>((resolve, reject) => {
        release = resolve
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      })
      return { state: 'delivered', deliveredAt: DELIVERED_AT }
    })
    const pumping = pump.pumpOnce()
    await deliveryEntered
    store.pauseAgent(seeded.commitmentId, store.getById(seeded.commitmentId)!.revision)
    pump.abortCommitment(seeded.commitmentId)
    release()
    await pumping
    expect(store.getOutbox(seeded.outboxId)?.state).toBe('delivered')
    expect(store.getById(seeded.commitmentId)).toMatchObject({ monitorDesiredState: 'paused', monitorResumeState: 'none' })
    store.close()
  })

  it('cancel cancels an unclaimed monitor event without delivery', async () => {
    const { store, delivery, pump } = setup()
    const seeded = seedMonitorEvent(store, 'monitor-cancel')
    store.cancel(seeded.commitmentId, store.getById(seeded.commitmentId)!.revision)
    await pump.pumpOnce()
    expect(delivery.deliver).not.toHaveBeenCalled()
    expect(store.getOutbox(seeded.outboxId)?.state).toBe('cancelled')
    store.close()
  })

  it('cancel aborts an in-flight monitor event as uncertain', async () => {
    const { store, delivery, pump } = setup()
    const seeded = seedMonitorEvent(store, 'monitor-cancel-in-flight')
    let entered!: () => void
    const deliveryEntered = new Promise<void>(resolve => { entered = resolve })
    vi.mocked(delivery.deliver).mockImplementationOnce(async ({ signal }) => {
      entered()
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      })
      return { state: 'delivered', deliveredAt: DELIVERED_AT }
    })
    const pumping = pump.pumpOnce()
    await deliveryEntered
    store.cancel(seeded.commitmentId, store.getById(seeded.commitmentId)!.revision)
    pump.abortCommitment(seeded.commitmentId)
    await pumping
    expect(store.getOutbox(seeded.outboxId)?.state).toBe('uncertain')
    expect(store.getById(seeded.commitmentId)).toMatchObject({
      monitorCheckpoint: null, monitorDesiredState: 'none', monitorResumeState: 'none',
    })
    store.close()
  })
})

describe('revalidation and aborts', () => {
  it('cancels a pending check-in whose commitment is no longer active', async () => {
    const { store, delivery, pump } = setup()
    const created = store.createUserCommitment({ title: 't', status: 'active', checkInMinutes: 2, sourceSurface: 'telegram', now: NOW })
    if (!created.ok) throw new Error('seed failed')
    store.queueDueReminder(NOW, 2 * 60 * 60 * 1000, () => 'reminder')
    store.pauseUser(created.row.id, created.row.revision)
    await pump.pumpOnce()
    expect(delivery.deliver).not.toHaveBeenCalled()
    store.close()
  })

  it('abortCommitment turns a throwing in-flight delivery into uncertain', async () => {
    const { store, delivery, pump } = setup()
    await seedResult(store, 'o1', 'done')
    vi.mocked(delivery.deliver).mockImplementationOnce(async ({ signal }) => {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      })
      return { state: 'delivered', deliveredAt: DELIVERED_AT }
    })
    const pumping = pump.pumpOnce()
    await new Promise<void>(resolve => setTimeout(resolve, 20))
    pump.abortCommitment(store.getLastClosed()!.id)
    await pumping
    expect(store.getOutbox('o1')).toMatchObject({ state: 'uncertain', error: expect.stringContaining('aborted') })
    store.close()
  })
})
