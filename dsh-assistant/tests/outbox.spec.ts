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

  it('stores scrubbed errors without tokens or message bodies', async () => {
    const { store, http, pump } = setup()
    await seedResult(store, 'o1', '✅ done')
    http.sendMessage.mockRejectedValueOnce(new Error('sendMessage failed: https://api.telegram.org/bot123456:secret-token/sendMessage -> 400'))
    await pump.pumpOnce()
    const error = store.getOutbox('o1')!.error ?? ''
    expect(error).not.toContain('secret-token')
    expect(error).not.toContain('bot123456')
    store.close()
  })
})
