/**
 * Reminder runtime tests (src/reminders.ts): one due reminder, no duplicates
 * across polls/restarts, still_working rescheduling, pause/resume coupling,
 * terminal cancels, and the restart catch-up with honest >2h wording.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TelegramHttp } from '@deepseek-ai/dsh-telegram-gateway'
import { AssistantStore } from '../src/store.ts'
import { OutboxPump } from '../src/outbox.ts'
import { ReminderRuntime } from '../src/reminders.ts'

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-assistant-reminder-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const START = Date.parse('2026-08-15T02:00:00.000Z')
const LATE_MS = 2 * 60 * 60 * 1000

function setup(nowMs = START) {
  const store = new AssistantStore(join(tempDir(), 'state.sqlite'))
  const sendMessage = vi.fn(async () => ({ messageId: 1 }))
  const http = {
    getMe: vi.fn(async () => ({ id: 1 })),
    getUpdates: vi.fn(async () => []),
    sendMessage,
    editMessage: vi.fn(async () => undefined),
    sendTyping: vi.fn(async () => undefined),
    setReaction: vi.fn(async () => undefined),
  } as unknown as TelegramHttp
  const controller = new AbortController()
  const clock = { value: nowMs, now: () => clock.value }
  const pump = new OutboxPump({
    store,
    http,
    chatId: 1,
    maxChars: 4096,
    signal: controller.signal,
    now: clock.now,
    logger: { warn: () => undefined },
  })
  const runtime = new ReminderRuntime({
    store,
    pump,
    pollIntervalMs: 5000,
    lateReminderAfterMs: LATE_MS,
    signal: controller.signal,
    now: clock.now,
    logger: { warn: () => undefined },
  })
  return { store, http, pump, runtime, clock, sendMessage }
}

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

async function seedActiveUserTask(store: AssistantStore, title: string, checkInMinutes: number, atMs = START) {
  const created = store.createUserCommitment({
    title,
    status: 'active',
    checkInMinutes,
    sourceSurface: 'telegram',
    now: iso(atMs),
  })
  if (!created.ok) throw new Error('seed failed')
  return created.row
}

describe('due reminders', () => {
  it('never schedules any monitor round; bound and unbound monitors stay outside focus reminders and outbox delivery', async () => {
    const { store, runtime, sendMessage } = setup()
    const unbound = store.createAgentCommitment({
      title: 'unbound monitor',
      kind: 'monitor',
      monitorDirection: '只观察明确目标',
      sourceSurface: 'telegram',
      now: iso(START),
    })
    if (!unbound.ok) throw new Error('unbound monitor seed failed')
    const unboundActive = store.markAgentActive(unbound.row.id, unbound.row.revision)
    if (!unboundActive.ok) throw new Error('unbound monitor activation failed')
    const blocked = store.setCommitmentStatus(unbound.row.id, 'blocked')
    if (blocked === undefined) throw new Error('unbound monitor block failed')

    const bound = store.createAgentCommitment({
      title: 'bound monitor',
      kind: 'monitor',
      monitorDirection: '只观察另一个明确目标',
      sourceSurface: 'telegram',
      now: iso(START),
    })
    if (!bound.ok) throw new Error('bound monitor seed failed')
    const boundActive = store.markAgentActive(bound.row.id, bound.row.revision)
    if (!boundActive.ok) throw new Error('bound monitor activation failed')
    const binding = store.createCronBinding({
      commitmentId: bound.row.id,
      externalRef: `assistant:${bound.row.id}`,
      desiredScheduleJson: JSON.stringify({ kind: 'interval', minutes: 15 }),
      desiredPrompt: '只观察另一个明确目标',
      desiredState: 'running',
      boundJobId: 'cron-reminder-bound-1',
      updatedAt: iso(START),
    })
    if (!binding.ok) throw new Error('bound monitor binding failed')

    await runtime.tick()
    expect(sendMessage).not.toHaveBeenCalled()
    expect(store.getById(unbound.row.id)).toMatchObject({ status: 'blocked', workerSessionId: null })
    expect(store.getCronBinding(unbound.row.id)).toBeUndefined()
    expect(store.getById(bound.row.id)).toMatchObject({ status: 'active', workerSessionId: null })
    expect(store.getCronBinding(bound.row.id)).toMatchObject({
      boundJobId: 'cron-reminder-bound-1', desiredState: 'running',
    })
    const source = readFileSync(new URL('../src/reminders.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/monitorTick|continueMonitors|startContinuable|followup/)
    store.close()
  })

  it('queues and delivers exactly one reminder when the clock passes the due time', async () => {
    const { store, runtime, sendMessage, clock } = setup()
    await seedActiveUserTask(store, '整理书桌', 2)
    // Before due: nothing.
    await runtime.tick()
    expect(sendMessage).not.toHaveBeenCalled()
    expect(store.listPendingOutbox()).toHaveLength(0)
    // At due: one reminder, delivered once.
    clock.value = START + 2 * 60_000 + 1000
    await runtime.tick()
    expect(sendMessage).toHaveBeenCalledTimes(1)
    const text = sendMessage.mock.calls[0]![1] as string
    expect(text).toContain('⏰ 到时间了：整理书桌')
    expect(text).toContain('还在做、先休息，还是已经完成？')
    // The row is queued+delivered; repeated ticks never re-send.
    await runtime.tick()
    await runtime.tick()
    expect(sendMessage).toHaveBeenCalledTimes(1)
    store.close()
  })

  it('duplicate scans across two runtimes (two pollers) insert only one outbox', async () => {
    const { store, runtime, sendMessage, clock } = setup()
    await seedActiveUserTask(store, 't', 1)
    const otherClock = { value: START + 60_000, now: () => otherClock.value }
    const second = new OutboxPump({
      store,
      http: { sendMessage: vi.fn(async () => ({ messageId: 2 })) } as unknown as TelegramHttp,
      chatId: 1,
      signal: new AbortController().signal,
      now: otherClock.now,
    })
    const other = new ReminderRuntime({
      store,
      pump: second,
      pollIntervalMs: 5000,
      lateReminderAfterMs: LATE_MS,
      signal: new AbortController().signal,
      now: otherClock.now,
    })
    clock.value = START + 60_000
    await runtime.tick()
    await other.tick()
    expect(store.listPendingOutbox()).toHaveLength(0)
    expect(sendMessage).toHaveBeenCalledTimes(1)
    store.close()
  })
})

describe('rescheduling and coupling', () => {
  it('still_working reschedules with the stored interval from now', async () => {
    const { store, runtime, sendMessage, clock } = setup()
    const row = await seedActiveUserTask(store, 't', 5)
    clock.value = START + 5 * 60_000 + 1000
    await runtime.tick()
    expect(sendMessage).toHaveBeenCalledTimes(1)
    // User says still working at T+6min: reschedule to T+11min.
    clock.value = START + 6 * 60_000
    const res = store.stillWorking(row.id, store.getById(row.id)!.revision, undefined, iso(START + 6 * 60_000))
    if (!res.ok) throw new Error('stillWorking failed')
    expect(res.row.reminderDueAt).toBe(iso(START + 11 * 60_000))
    // Before the new due: no new reminder.
    clock.value = START + 10 * 60_000
    await runtime.tick()
    expect(sendMessage).toHaveBeenCalledTimes(1)
    // At the new due: exactly one more.
    clock.value = START + 11 * 60_000 + 1000
    await runtime.tick()
    expect(sendMessage).toHaveBeenCalledTimes(2)
    store.close()
  })

  it('pause cancels the reminder; resume re-schedules it', async () => {
    const { store, runtime, sendMessage, clock } = setup()
    const row = await seedActiveUserTask(store, 't', 2)
    // Pause before due: no reminder even past the old due.
    clock.value = START + 3 * 60_000
    let res = store.pauseUser(row.id, store.getById(row.id)!.revision)
    if (!res.ok) throw new Error('pause failed')
    await runtime.tick()
    expect(sendMessage).not.toHaveBeenCalled()
    // Resume: re-scheduled from now (T+3min → T+5min).
    res = store.resumeUser(row.id, store.getById(row.id)!.revision, 2, iso(START + 3 * 60_000))
    if (!res.ok) throw new Error('resume failed')
    expect(res.row.reminderDueAt).toBe(iso(START + 5 * 60_000))
    await runtime.tick()
    expect(sendMessage).not.toHaveBeenCalled()
    clock.value = START + 5 * 60_000 + 1000
    await runtime.tick()
    expect(sendMessage).toHaveBeenCalledTimes(1)
    store.close()
  })

  it('complete cancels the pending reminder before claim; it never sends', async () => {
    const { store, runtime, sendMessage, clock } = setup()
    const row = await seedActiveUserTask(store, 't', 2)
    clock.value = START + 2 * 60_000 + 1000
    const res = store.completeUser(row.id, store.getById(row.id)!.revision, '做完了', iso(START + 2 * 60_000 + 1000))
    if (!res.ok) throw new Error('complete failed')
    await runtime.tick()
    expect(sendMessage).not.toHaveBeenCalled()
    expect(store.listPendingOutbox()).toHaveLength(0)
    store.close()
  })
})

describe('restart catch-up', () => {
  it('an overdue reminder fires exactly once after a restart, with normal wording within 2h', async () => {
    const { store, runtime, sendMessage } = setup(START + 30 * 60_000)
    await seedActiveUserTask(store, 't', 2)
    // Restart at T+30min: the T+2min due is overdue by 28min (< 2h).
    await runtime.tick()
    expect(sendMessage).toHaveBeenCalledTimes(1)
    const text = sendMessage.mock.calls[0]![1] as string
    expect(text).toContain('⏰ 到时间了：t')
    expect(text).not.toContain('错过')
    await runtime.tick()
    expect(sendMessage).toHaveBeenCalledTimes(1)
    store.close()
  })

  it('an overdue reminder beyond 2h uses the honest missed wording once', async () => {
    const { store, runtime, sendMessage } = setup(START + 3 * 60 * 60 * 1000)
    await seedActiveUserTask(store, 't', 2)
    await runtime.tick()
    expect(sendMessage).toHaveBeenCalledTimes(1)
    const text = sendMessage.mock.calls[0]![1] as string
    expect(text).toContain('⏰ 我在离线期间错过了这次跟进：t')
    await runtime.tick()
    expect(sendMessage).toHaveBeenCalledTimes(1)
    store.close()
  })

  it('a future dueAt survives a restart unchanged', async () => {
    const path = join(tempDir(), 'state.sqlite')
    const store = new AssistantStore(path)
    const row = await seedActiveUserTask(store, 't', 15)
    expect(row.reminderDueAt).toBe(iso(START + 15 * 60_000))
    // Reopen the store (restart) and scan before due: no reminder, due intact.
    store.close()
    const store2 = new AssistantStore(path)
    const runtime = makeRuntime(store2)
    await runtime.tick()
    expect(store2.getById(row.id)?.reminderDueAt).toBe(iso(START + 15 * 60_000))
    store2.close()
  })
})

function makeRuntime(store: AssistantStore): ReminderRuntime {
  const sendMessage = vi.fn(async () => ({ messageId: 1 }))
  const http = { sendMessage } as unknown as TelegramHttp
  const pump = new OutboxPump({
    store,
    http,
    chatId: 1,
    signal: new AbortController().signal,
    now: () => START,
  })
  return new ReminderRuntime({
    store,
    pump,
    pollIntervalMs: 5000,
    lateReminderAfterMs: LATE_MS,
    signal: new AbortController().signal,
    now: () => START,
  })
}
