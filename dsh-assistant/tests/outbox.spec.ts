/**
 * Outbox pump tests (src/outbox.ts): claim-before-send, no replay, failed vs
 * uncertain semantics, restart stale-claim handling, chunking, and in-flight
 * aborts. All HTTP is a scripted fake; the store is a real mkdtemp SQLite.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TelegramHttp } from '@deepseek-ai/dsh-telegram-gateway'
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
const clock = () => Date.parse(NOW)

function fakeHttp(overrides: { failOn?: number[] } = {}): TelegramHttp {
  let sentCalls = 0
  const sendMessage = vi.fn(async () => {
    if (overrides.failOn?.includes(sentCalls)) {
      throw new Error('HTTP 500 from telegram')
    }
    sentCalls++
    return { messageId: 100 + sentCalls }
  })
  return {
    getMe: vi.fn(async () => ({ id: 1 })),
    getUpdates: vi.fn(async () => []),
    sendMessage,
    editMessage: vi.fn(async () => undefined),
    sendTyping: vi.fn(async () => undefined),
    setReaction: vi.fn(async () => undefined),
  } as unknown as TelegramHttp
}

function setup(overrides: { failOn?: number[] } = {}) {
  const store = new AssistantStore(join(tempDir(), 'state.sqlite'))
  const http = fakeHttp(overrides)
  const controller = new AbortController()
  const pump = new OutboxPump({
    store,
    http,
    chatId: 12345,
    maxChars: 4096,
    signal: controller.signal,
    now: clock,
    logger: { warn: () => undefined },
  })
  return { store, http, pump, controller }
}

/** Create a closed agent commitment carrying one result outbox row. */
async function seedResult(store: AssistantStore, outboxId: string, text: string): Promise<void> {
  const created = store.createAgentCommitment({ title: 't', sourceSurface: 'telegram', now: NOW })
  if (!created.ok) throw new Error('seed failed')
  store.settleWorkerEnd(created.row.id, created.row.revision, {
    status: 'completed',
    result: 'r',
    completedAt: NOW,
    outboxId,
    outboxText: text,
  })
}

function eventKey(seed: string): string {
  return `event-key-${seed}`
}

function seedMonitorEvent(store: AssistantStore, seed = 'monitor-event', text = '📌 event'):
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
    eventKey: eventKey(seed),
    checkpoint: `checkpoint-${seed}`,
    summary: 'new event',
    outboxText: text,
    now: NOW,
  })
  if (!settled.ok) throw new Error('monitor event settlement failed')
  return { commitmentId: created.row.id, outboxId: settled.outbox.id }
}

describe('claim-before-send and delivery', () => {
  it('claims the row before any HTTP call and marks delivered after', async () => {
    const { store, http, pump } = setup()
    await seedResult(store, 'o1', '✅ done')
    const statesDuringSend: string[] = []
    http.sendMessage.mockImplementationOnce(async () => {
      statesDuringSend.push(store.getOutbox('o1')!.state)
      return { messageId: 1 }
    })
    await pump.pumpOnce()
    expect(statesDuringSend).toEqual(['claimed'])
    expect(store.getOutbox('o1')?.state).toBe('delivered')
    expect(store.getOutbox('o1')?.deliveredAt).toBe(NOW)
    expect(store.getLastClosed()?.lastDeliveryState).toBe('delivered')
    store.close()
  })

  it('delivered rows are never re-sent on later pumps', async () => {
    const { store, http, pump } = setup()
    await seedResult(store, 'o1', '✅ done')
    await pump.pumpOnce()
    await pump.pumpOnce()
    await pump.pumpOnce()
    expect(http.sendMessage).toHaveBeenCalledTimes(1)
    store.close()
  })

  it('an HTTP error marks failed and never auto-retries', async () => {
    const { store, http, pump } = setup({ failOn: [0] })
    await seedResult(store, 'o1', '✅ done')
    await pump.pumpOnce()
    await pump.pumpOnce()
    expect(http.sendMessage).toHaveBeenCalledTimes(1)
    const outbox = store.getOutbox('o1')!
    expect(outbox.state).toBe('failed')
    expect(outbox.error).toContain('HTTP 500')
    expect(store.getLastClosed()?.lastDeliveryState).toBe('failed')
    store.close()
  })

  it('stale claimed rows from a previous process become uncertain at start and are not sent', async () => {
    const { store, http, pump } = setup()
    await seedResult(store, 'o1', '✅ done')
    // Claim but never send (simulates a crash mid-flight).
    store.claimOutbox('o1', NOW)
    // A fresh pump's start() marks it uncertain; no HTTP is attempted.
    pump.start(5000)
    await pump.pumpOnce()
    expect(store.getOutbox('o1')?.state).toBe('uncertain')
    expect(http.sendMessage).not.toHaveBeenCalled()
    await pump.stop()
    store.close()
  })
})

describe('monitor event delivery and continuation', () => {
  it('delivered advances the checkpoint atomically and leaves a desired-running monitor for continuation', async () => {
    const { store, http, pump } = setup()
    const seeded = seedMonitorEvent(store)
    await pump.pumpOnce()
    expect(http.sendMessage).toHaveBeenCalledTimes(1)
    expect(store.getOutbox(seeded.outboxId)?.state).toBe('delivered')
    expect(store.getById(seeded.commitmentId)).toMatchObject({
      monitorCheckpoint: 'checkpoint-monitor-event',
      monitorDesiredState: 'running',
      monitorResumeState: 'needed',
    })
    await pump.pumpOnce()
    expect(http.sendMessage).toHaveBeenCalledTimes(1)
    store.close()
  })

  it.each([
    ['failed', { failOn: [0] }],
    ['uncertain', { failOn: [1] }],
  ] as const)('%s does not advance the checkpoint, never resends, and keeps continuation durable', async (state, overrides) => {
    const { store, http, pump } = setup(overrides)
    const seeded = seedMonitorEvent(store, `monitor-${state}`, state === 'uncertain' ? 'x'.repeat(5000) : '📌 event')
    await pump.pumpOnce()
    const outbox = store.getOutbox(seeded.outboxId)!
    expect(outbox.state).toBe(state)
    expect(store.getById(seeded.commitmentId)).toMatchObject({
      monitorCheckpoint: null,
      monitorDesiredState: 'running',
      monitorResumeState: 'needed',
    })
    await pump.pumpOnce()
    expect(http.sendMessage).toHaveBeenCalledTimes(state === 'uncertain' ? 2 : 1)
    store.close()
  })

  it('a stale claimed monitor event becomes uncertain atomically and is not sent after restart', async () => {
    const { store, http, pump } = setup()
    const seeded = seedMonitorEvent(store, 'monitor-stale')
    expect(store.claimOutbox(seeded.outboxId, NOW).ok).toBe(true)
    store.markStaleClaimed()
    await pump.pumpOnce()
    expect(http.sendMessage).not.toHaveBeenCalled()
    expect(store.getOutbox(seeded.outboxId)?.state).toBe('uncertain')
    expect(store.getById(seeded.commitmentId)).toMatchObject({ monitorCheckpoint: null, monitorResumeState: 'needed' })
    store.close()
  })

  it('pause leaves a pending monitor event deliverable and does not resume a paused monitor', async () => {
    const { store, http, pump } = setup()
    const seeded = seedMonitorEvent(store, 'monitor-pause-pending')
    const current = store.getById(seeded.commitmentId)!
    const paused = store.pauseAgent(seeded.commitmentId, current.revision)
    expect(paused.ok).toBe(true)
    await pump.pumpOnce()
    expect(http.sendMessage).toHaveBeenCalledTimes(1)
    expect(store.getOutbox(seeded.outboxId)?.state).toBe('delivered')
    expect(store.getById(seeded.commitmentId)).toMatchObject({
      monitorCheckpoint: 'checkpoint-monitor-pause-pending',
      monitorDesiredState: 'paused',
      monitorResumeState: 'none',
      workerSessionId: null,
      workerRunId: null,
      workerParentSessionId: null,
    })
    store.close()
  })

  it('pause does not abort an already claimed in-flight monitor event', async () => {
    const { store, http, pump } = setup()
    const seeded = seedMonitorEvent(store, 'monitor-pause')
    let release!: () => void
    let entered!: () => void
    const sendEntered = new Promise<void>(resolve => { entered = resolve })
    http.sendMessage.mockImplementationOnce(async (_chatId, _text, _opts, signal) => {
      entered()
      await new Promise<void>((resolve, reject) => {
        release = resolve
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      })
    })
    const pumping = pump.pumpOnce()
    await sendEntered
    const current = store.getById(seeded.commitmentId)!
    const paused = store.pauseAgent(seeded.commitmentId, current.revision)
    expect(paused.ok).toBe(true)
    pump.abortCommitment(seeded.commitmentId)
    release()
    await pumping
    expect(store.getOutbox(seeded.outboxId)?.state).toBe('delivered')
    expect(store.getById(seeded.commitmentId)).toMatchObject({
      monitorCheckpoint: 'checkpoint-monitor-pause',
      monitorDesiredState: 'paused',
      monitorResumeState: 'none',
    })
    store.close()
  })

  it('cancel cancels an unclaimed monitor event and never sends it', async () => {
    const { store, http, pump } = setup()
    const seeded = seedMonitorEvent(store, 'monitor-cancel')
    const current = store.getById(seeded.commitmentId)!
    const cancelled = store.cancel(seeded.commitmentId, current.revision)
    expect(cancelled.ok).toBe(true)
    await pump.pumpOnce()
    expect(http.sendMessage).not.toHaveBeenCalled()
    expect(store.getOutbox(seeded.outboxId)?.state).toBe('cancelled')
    store.close()
  })

  it('cancel aborts an in-flight monitor event as uncertain without checkpoint advancement or continuation', async () => {
    const { store, http, pump } = setup()
    const seeded = seedMonitorEvent(store, 'monitor-cancel-in-flight')
    let release!: () => void
    let entered!: () => void
    const sendEntered = new Promise<void>(resolve => { entered = resolve })
    http.sendMessage.mockImplementationOnce(async (_chatId, _text, _opts, signal) => {
      entered()
      await new Promise<void>((resolve, reject) => {
        release = resolve
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      })
    })
    const pumping = pump.pumpOnce()
    await sendEntered
    const current = store.getById(seeded.commitmentId)!
    const cancelled = store.cancel(seeded.commitmentId, current.revision)
    expect(cancelled.ok).toBe(true)
    pump.abortCommitment(seeded.commitmentId)
    release()
    await pumping
    expect(store.getOutbox(seeded.outboxId)?.state).toBe('uncertain')
    expect(store.getById(seeded.commitmentId)).toMatchObject({
      monitorCheckpoint: null,
      monitorDesiredState: 'none',
      monitorResumeState: 'none',
    })
    await pump.pumpOnce()
    expect(http.sendMessage).toHaveBeenCalledTimes(1)
    store.close()
  })
})

describe('chunking', () => {
  it('splits at 4096 chars and sends every chunk', async () => {
    const { store, http, pump } = setup()
    const long = 'x'.repeat(4990)
    await seedResult(store, 'o1', long)
    await pump.pumpOnce()
    expect(http.sendMessage).toHaveBeenCalledTimes(2)
    const lengths = http.sendMessage.mock.calls.map(call => (call[1] as string).length)
    expect(lengths).toEqual([4096, 894])
    store.close()
  })

  it('a failure on the second chunk marks the whole row uncertain and never replays the first chunk', async () => {
    const { store, http, pump } = setup({ failOn: [1] })
    const long = 'x'.repeat(4990)
    await seedResult(store, 'o1', long)
    await pump.pumpOnce()
    expect(http.sendMessage).toHaveBeenCalledTimes(2) // first chunk ok, second failed
    const outbox = store.getOutbox('o1')!
    expect(outbox.state).toBe('uncertain')
    expect(outbox.error).toContain('partial delivery')
    // No replay of the accepted first chunk
    await pump.pumpOnce()
    expect(http.sendMessage).toHaveBeenCalledTimes(2)
    store.close()
  })
})

describe('check-in revalidation and aborts', () => {
  it('a pending check-in whose commitment is no longer active is cancelled without sending', async () => {
    const { store, http, pump } = setup()
    const created = store.createUserCommitment({ title: 't', status: 'active', checkInMinutes: 2, sourceSurface: 'telegram', now: NOW })
    if (!created.ok) throw new Error('seed failed')
    store.queueDueReminder(NOW, 2 * 60 * 60 * 1000, () => '⏰')
    store.pauseUser(created.row.id, created.row.revision)
    await pump.pumpOnce()
    expect(http.sendMessage).not.toHaveBeenCalled()
    store.close()
  })

  it('abortCommitment aborts an in-flight send and marks it uncertain', async () => {
    const { store, http, pump } = setup()
    await seedResult(store, 'o1', '✅ done')
    http.sendMessage.mockImplementationOnce(async (_chatId, _text, _opts, signal) => {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      })
    })
    const pumping = pump.pumpOnce()
    // Wait until the send is in flight, then abort it.
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
    pump.abortCommitment(store.getLastClosed()!.id)
    await pumping
    const outbox = store.getOutbox('o1')!
    expect(outbox.state).toBe('uncertain')
    expect(outbox.error).toContain('aborted')
    store.close()
  })

  it('stores scrubbed errors without endpoint placeholders or message bodies', async () => {
    const { store, http, pump } = setup()
    await seedResult(store, 'o1', '✅ done')
    http.sendMessage.mockRejectedValueOnce(new Error('sendMessage failed: https://api.telegram.org/bot-placeholder/sendMessage -> 400'))
    await pump.pumpOnce()
    const error = store.getOutbox('o1')!.error ?? ''
    expect(error).not.toContain('bot-placeholder')
    expect(error).not.toContain('api.telegram.org')
    store.close()
  })
})
