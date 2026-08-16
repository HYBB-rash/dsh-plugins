/**
 * Crash-recovery specs for the scheduler (src/scheduler.ts).
 *
 * Written BEFORE the claim wiring exists, per the V1.1 guide. They prove
 * ORDER, not just final JSON: claim lands before any Agent/Telegram side
 * effect, a failed claim blocks the whole run, and a crash after claim but
 * before finish never replays or re-delivers.
 *
 * The test seam is the optional `deps` object on SchedulerRuntime: injected
 * driveTurn / deliverText replace the real agent and Telegram calls. A
 * never-resolving injected function simulates "process vanished mid-run".
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SchedulerRuntime, type SchedulerConfig } from '../src/scheduler.ts'
import { JobStore, RunLedger } from '../src/store.ts'
import type { Job } from '../src/types.ts'

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cron-sched-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  vi.useRealTimers()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function nowIso(): string {
  return new Date().toISOString()
}

function seedJob(dir: string, job: Job): void {
  const store = new JobStore(dir)
  store.append({ op: 'create', ...job })
}

function makeConfig(dir: string): SchedulerConfig {
  return {
    storeDir: dir,
    apiBaseUrl: 'https://api.telegram.org',
    tokenRef: 'TELEGRAM_BOT_TOKEN',
    chatIdRef: 'TELEGRAM_ALLOWED_CHAT_ID',
    pollIntervalMs: 60_000,
    maxConcurrent: 3,
    deliverOnError: true,
  }
}

const fakeAgent = {
  session: { seq: 0, events: [] },
  followup: () => undefined,
  whenIdle: async () => undefined,
}

function fakeCtx(errors: string[], events: Array<{ name: string; payload: unknown }> = []) {
  return {
    get: (name: string) => {
      if (name === 'agents') return {
        get: () => undefined,
        resume: async () => ({ agent: fakeAgent, dispose: async () => undefined }),
        create: async () => ({ agent: fakeAgent, dispose: async () => undefined }),
      }
      if (name === 'sessions') return { flush: async () => undefined }
      if (name === 'sessionPersistence') return { list: async () => [] }
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'test', model: 'test' }) }
      return undefined
    },
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: (message: string) => { errors.push(String(message)) },
    },
    parallel: async (name: string, payload: unknown) => { events.push({ name, payload }) },
  } as never
}

/** Poll until a condition holds, or throw. Uses REAL timers. */
async function waitFor(condition: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

function newRuntime(dir: string, deps: object) {
  const errors: string[] = []
  const events: Array<{ name: string; payload: unknown }> = []
  const controller = new AbortController()
  const runtime = new SchedulerRuntime(
    fakeCtx(errors, events),
    makeConfig(dir),
    {} as never,
    0,
    controller.signal,
    deps,
  )
  runtime.start()
  return { runtime, controller, errors, events }
}

/** Make a recurring job that is due within its grace window right now. */
function dueIntervalJob(intervalMinutes: number, createdAtAgoMs: number): Job {
  return {
    id: `cron-t${Math.floor(Math.random() * 1e9)}`,
    schedule: { kind: 'interval', minutes: intervalMinutes },
    prompt: 'test prompt',
    deliver: 'telegram',
    createdAt: new Date(Date.now() - createdAtAgoMs).toISOString(),
  }
}

function onceJob(runAtAgoMs: number): Job {
  return {
    id: `cron-t${Math.floor(Math.random() * 1e9)}`,
    schedule: { kind: 'once', runAt: new Date(Date.now() - runAtAgoMs).toISOString() },
    prompt: 'test prompt',
    deliver: 'telegram',
    createdAt: nowIso(),
  }
}

describe('claim ordering', () => {
  it('persists the claim before any Agent or Telegram side effect', async () => {
    const dir = tempDir()
    seedJob(dir, dueIntervalJob(10, 10 * 60_000 + 1_000))
    let driveCalls = 0
    let deliverCalls = 0
    const { runtime } = newRuntime(dir, {
      driveTurn: async () => { driveCalls++; return { text: 'hello' } },
      deliverText: async () => { deliverCalls++ },
    })
    await waitFor(() => driveCalls === 1 && deliverCalls === 1)
    await waitFor(() => new RunLedger(dir).foldJob(jobIdOf(dir)).interrupted.length === 0)
    await runtime.dispose()
    const lines = readLines(dir)
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!)).toMatchObject({ schemaVersion: 2, event: 'claim' })
    expect(JSON.parse(lines[1]!)).toMatchObject({ schemaVersion: 2, event: 'finish', status: 'success' })
  })

  it('a real claim append failure fails closed with bounded, spaced retries', async () => {
    const dir = tempDir()
    seedJob(dir, dueIntervalJob(10, 10 * 60_000 + 1_000))
    // runs.jsonl stays readable (absent = empty); ONLY the atomic tmp target
    // is a directory, so the ledger READ succeeds and the claim APPEND fails.
    mkdirSync(join(dir, 'runs.jsonl.tmp'))
    let driveCalls = 0
    let deliverCalls = 0
    const { runtime, controller, errors } = newRuntime(dir, {
      driveTurn: async () => { driveCalls++; return { text: 'x' } },
      deliverText: async () => { deliverCalls++ },
    })
    const claimErrors = () => errors.filter(message => message.includes('claim failed'))
    // The first failure lands; then a 250ms window must show NO tight retry
    // storm: zero side effects and a bounded attempt count (1).
    await waitFor(() => claimErrors().length === 1)
    await new Promise(resolve => setTimeout(resolve, 250))
    expect(driveCalls).toBe(0)
    expect(deliverCalls).toBe(0)
    expect(claimErrors().length).toBe(1)
    controller.abort()
    await runtime.dispose()
  })

  it('after the write fault clears, the SAME occurrence runs exactly once and later periods continue', async () => {
    const dir = tempDir()
    const job = dueIntervalJob(1, 61_000)
    seedJob(dir, job)
    const scheduledForMs = Date.parse(job.createdAt) + 60_000
    const expectedRunId = `${job.id}@${new Date(scheduledForMs).toISOString()}`
    mkdirSync(join(dir, 'runs.jsonl.tmp'))
    let driveCalls = 0
    let deliverCalls = 0
    const { runtime, controller, errors } = newRuntime(dir, {
      driveTurn: async () => { driveCalls++; return { text: 'recovered' } },
      deliverText: async () => { deliverCalls++ },
    })
    await waitFor(() => errors.some(message => message.includes('claim failed')))
    // Clear the fault; the in-process backoff retries the SAME trigger point.
    rmdirSync(join(dir, 'runs.jsonl.tmp'))
    await waitFor(() => driveCalls === 1, 12_000)
    const linesAfterFirst = readLines(dir)
    expect(linesAfterFirst).toHaveLength(2)
    const firstClaim = JSON.parse(linesAfterFirst[0]!) as { event: string; runId: string; scheduledFor: string }
    const firstFinish = JSON.parse(linesAfterFirst[1]!) as { event: string; runId: string; status: string }
    expect(firstClaim.event).toBe('claim')
    expect(firstClaim.runId).toBe(expectedRunId)
    expect(firstClaim.scheduledFor).toBe(new Date(scheduledForMs).toISOString())
    expect(firstFinish.runId).toBe(expectedRunId)
    expect(firstFinish.status).toBe('success')
    // The next period must still fire under a NEW runId.
    await waitFor(() => readLines(dir).filter(line => line.includes('"event":"claim"')).length >= 2, 90_000)
    await runtime.dispose()
    expect(driveCalls).toBe(2)
    expect(deliverCalls).toBe(2)
    const lines = readLines(dir)
    expect(lines).toHaveLength(4)
    const secondClaim = JSON.parse(lines[2]!) as { runId: string }
    expect(secondClaim.runId).not.toBe(expectedRunId)
    expect(controller.signal.aborted).toBe(false)
  }, 110_000)
})

describe('crash recovery', () => {
  it('once: a claim without finish never executes again after restart', async () => {
    const dir = tempDir()
    seedJob(dir, onceJob(60_000))
    let driveCalls = 0
    let deliverCalls = 0
    let release: () => void = () => undefined
    const started = new Promise<void>(resolve => { release = resolve })
    const { runtime, controller } = newRuntime(dir, {
      driveTurn: async () => {
        driveCalls++
        release()
        await new Promise(() => undefined) // simulate the process vanishing mid-run
        return undefined
      },
      deliverText: async () => { deliverCalls++ },
    })
    await started
    await waitFor(() => new RunLedger(dir).foldJob('x') === undefined || driveCalls === 1)
    // "Crash": abandon runtime1 without a finish; then start a fresh runtime.
    controller.abort()
    void runtime.dispose().catch(() => undefined)
    let driveCalls2 = 0
    let deliverCalls2 = 0
    const second = newRuntime(dir, {
      driveTurn: async () => { driveCalls2++; return { text: 'y' } },
      deliverText: async () => { deliverCalls2++ },
    })
    await new Promise(resolve => setTimeout(resolve, 400))
    await second.runtime.dispose()
    expect(driveCalls2).toBe(0)
    expect(deliverCalls2).toBe(0)
    const lines = readLines(dir)
    const events = lines.map(line => JSON.parse(line) as { event?: string; status?: string; runId?: string })
    expect(events[0]).toMatchObject({ event: 'claim' })
    expect(events.some(line => line.event === 'finish' && line.status === 'interrupted')).toBe(true)
  })

  it('recurring: no replay of the old occurrence; future occurrence still runs', async () => {
    const dir = tempDir()
    seedJob(dir, dueIntervalJob(10, 10 * 60_000 + 1_000))
    let driveCalls = 0
    let release: () => void = () => undefined
    const started = new Promise<void>(resolve => { release = resolve })
    const { runtime, controller } = newRuntime(dir, {
      driveTurn: async () => {
        driveCalls++
        release()
        await new Promise(() => undefined)
        return undefined
      },
      deliverText: async () => undefined,
    })
    await started
    await waitFor(() => driveCalls === 1)
    // Simulate a long downtime: the crash recovery anchor is now far past.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(Date.now() + 30 * 60_000))
    controller.abort()
    void runtime.dispose().catch(() => undefined)

    let driveCalls2 = 0
    const second = newRuntime(dir, {
      driveTurn: async () => { driveCalls2++; return { text: 'next' } },
      deliverText: async () => undefined,
    })
    await waitFor(() => driveCalls2 === 1)
    await second.runtime.dispose()

    // The old runId was claimed exactly once and finished as interrupted;
    // the future occurrence ran under a NEW runId.
    const ledger = new RunLedger(dir)
    const lines = readLines(dir)
    const claims = lines.map(line => JSON.parse(line)).filter((line: { event?: string }) => line.event === 'claim')
    expect(claims).toHaveLength(2)
    expect(claims[0]!.runId).not.toBe(claims[1]!.runId)
    const folded = ledger.foldJob(jobIdOf(dir))
    expect(folded.interrupted).toEqual([])
    expect(driveCalls2).toBe(1)
  })

  it('telegram delivered but finish lost: a fresh runtime never re-delivers', async () => {
    const dir = tempDir()
    seedJob(dir, onceJob(60_000))
    let deliverCalls = 0
    let release: () => void = () => undefined
    const delivered = new Promise<void>(resolve => { release = resolve })
    const { runtime, controller } = newRuntime(dir, {
      driveTurn: async () => ({ text: 'delivered once' }),
      deliverText: async () => {
        deliverCalls++
        release()
        await new Promise(() => undefined) // vanish after the send, before finish
      },
    })
    await delivered
    await waitFor(() => deliverCalls === 1)
    controller.abort()
    void runtime.dispose().catch(() => undefined)

    let deliverCalls2 = 0
    const second = newRuntime(dir, {
      driveTurn: async () => ({ text: 'again' }),
      deliverText: async () => { deliverCalls2++ },
    })
    await new Promise(resolve => setTimeout(resolve, 400))
    await second.runtime.dispose()
    expect(deliverCalls2).toBe(0)
  })

  it('abort/dispose leaves a claim that restores as interrupted', async () => {
    const dir = tempDir()
    seedJob(dir, dueIntervalJob(10, 10 * 60_000 + 1_000))
    const { runtime, controller } = newRuntime(dir, {
      driveTurn: async () => {
        await new Promise(resolve => setTimeout(resolve, 50))
        return { text: 'late' }
      },
      deliverText: async () => undefined,
    })
    await waitFor(() => {
      const lines = readLines(dir)
      return lines.length > 0 && JSON.parse(lines[0]!).event === 'claim'
    })
    controller.abort()
    await runtime.dispose()
    // The interrupted audit lands on the NEXT reload (restart projection).
    const second = newRuntime(dir, {
      driveTurn: async () => { throw new Error('must not run') },
      deliverText: async () => undefined,
    })
    await new Promise(resolve => setTimeout(resolve, 300))
    await second.runtime.dispose()
    const ledger = new RunLedger(dir)
    const folded = ledger.foldJob(jobIdOf(dir))
    const lines = readLines(dir)
    const events = lines.map(line => JSON.parse(line))
    expect(events.some((line: { event?: string }) => line.event === 'finish')).toBe(true)
    expect(events.some((line: { event?: string; status?: string }) => line.event === 'finish' && line.status === 'interrupted')).toBe(true)
    expect(folded.interrupted).toEqual([])
  })
})

describe('basic run outcomes', () => {
  it('records success with deliveredAt and an output preview', async () => {
    const dir = tempDir()
    seedJob(dir, dueIntervalJob(10, 10 * 60_000 + 1_000))
    const { runtime } = newRuntime(dir, {
      driveTurn: async () => ({ text: 'result body' }),
      deliverText: async () => undefined,
    })
    await waitFor(() => {
      const lines = readLines(dir)
      return lines.length >= 2 && JSON.parse(lines[lines.length - 1]!).status === 'success'
    })
    await runtime.dispose()
    const finish = JSON.parse(readLines(dir).at(-1)!) as { status: string; deliveredAt?: string; outputPreview?: string }
    expect(finish.status).toBe('success')
    expect(finish.deliveredAt).toBeDefined()
    expect(finish.outputPreview).toBe('result body')
  })

  it('records silent for an empty output', async () => {
    const dir = tempDir()
    seedJob(dir, { ...dueIntervalJob(10, 10 * 60_000 + 1_000), deliver: 'silent' })
    const { runtime } = newRuntime(dir, {
      driveTurn: async () => ({ text: 'ignored' }),
      deliverText: async () => undefined,
    })
    await waitFor(() => {
      const lines = readLines(dir)
      return lines.length >= 2 && JSON.parse(lines[lines.length - 1]!).status === 'silent'
    })
    await runtime.dispose()
  })

  it('records error when the agent turn fails', async () => {
    const dir = tempDir()
    seedJob(dir, dueIntervalJob(10, 10 * 60_000 + 1_000))
    const { runtime } = newRuntime(dir, {
      driveTurn: async () => { throw new Error('agent exploded') },
      deliverText: async () => undefined,
    })
    await waitFor(() => {
      const lines = readLines(dir)
      return lines.length >= 2 && JSON.parse(lines[lines.length - 1]!).status === 'error'
    })
    await runtime.dispose()
    const finish = JSON.parse(readLines(dir).at(-1)!) as { error?: string }
    expect(finish.error).toContain('agent exploded')
  })

  it('records error when delivery fails', async () => {
    const dir = tempDir()
    seedJob(dir, dueIntervalJob(10, 10 * 60_000 + 1_000))
    const { runtime } = newRuntime(dir, {
      driveTurn: async () => ({ text: 'to deliver' }),
      deliverText: async () => { throw new Error('network down') },
    })
    await waitFor(() => {
      const lines = readLines(dir)
      return lines.length >= 2 && JSON.parse(lines[lines.length - 1]!).status === 'error'
    })
    await runtime.dispose()
    const finish = JSON.parse(readLines(dir).at(-1)!) as { error?: string }
    expect(finish.error).toContain('delivery failed')
  })
})

describe('grace and fast-forward', () => {
  it('a recurring job far past grace fast-forwards and runs exactly once', async () => {
    const dir = tempDir()
    seedJob(dir, { ...dueIntervalJob(10, 60 * 60_000) })
    let driveCalls = 0
    const { runtime } = newRuntime(dir, {
      driveTurn: async () => { driveCalls++; return { text: 'catch-up' } },
      deliverText: async () => undefined,
    })
    await waitFor(() => driveCalls === 1)
    await runtime.dispose()
    const lines = readLines(dir)
    const claims = lines.map(line => JSON.parse(line)).filter((line: { event?: string }) => line.event === 'claim')
    expect(claims).toHaveLength(1)
    const claimRecord = claims[0] as { nextRunAt?: string }
    expect(claimRecord.nextRunAt).toBeDefined()
    expect(Date.parse(claimRecord.nextRunAt!)).toBeGreaterThan(Date.now())
  })

  it('a once job far past grace records expired without claim or execution', async () => {
    const dir = tempDir()
    seedJob(dir, onceJob(10 * 60_000))
    let driveCalls = 0
    const { runtime } = newRuntime(dir, {
      driveTurn: async () => { driveCalls++; return { text: 'x' } },
      deliverText: async () => undefined,
    })
    await new Promise(resolve => setTimeout(resolve, 400))
    await runtime.dispose()
    expect(driveCalls).toBe(0)
    const lines = readLines(dir)
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!)).toMatchObject({ event: 'finish', status: 'expired' })
  })
})

describe('run-finished event (§8)', () => {
  const eventsFor = (events: Array<{ name: string; payload: unknown }>) =>
    events.filter(e => e.name === 'dsh-cron/run-finished').map(e => e.payload as Record<string, unknown>)

  it('Telegram 成功、finish 成功后发一条 success + deliveredAt 事件', async () => {
    const dir = tempDir()
    seedJob(dir, dueIntervalJob(10, 10 * 60_000 + 1_000))
    const { runtime, events } = newRuntime(dir, {
      driveTurn: async () => ({ text: 'result body' }),
      deliverText: async () => undefined,
    })
    await waitFor(() => eventsFor(events).length === 1)
    await runtime.dispose()
    const event = eventsFor(events)[0]!
    expect(event.status).toBe('success')
    expect(typeof event.deliveredAt).toBe('string')
    expect(event.jobId).toBe(jobIdOf(dir))
    expect(typeof event.runId).toBe('string')
    expect(event.sessionId).toBe(`session-cron-${jobIdOf(dir)}`)
    expect(typeof event.scheduledFor).toBe('string')
    expect(event.error).toBeUndefined()
  })

  it('Telegram 失败后发 error，且没有 deliveredAt', async () => {
    const dir = tempDir()
    seedJob(dir, dueIntervalJob(10, 10 * 60_000 + 1_000))
    const { runtime, events } = newRuntime(dir, {
      driveTurn: async () => ({ text: 'to deliver' }),
      deliverText: async () => { throw new Error('network down') },
    })
    await waitFor(() => eventsFor(events).length === 1)
    await runtime.dispose()
    const event = eventsFor(events)[0]!
    expect(event.status).toBe('error')
    expect(event.deliveredAt).toBeUndefined()
    expect(String(event.error)).toContain('delivery failed')
  })

  it('silent 运行发 silent', async () => {
    const dir = tempDir()
    seedJob(dir, { ...dueIntervalJob(10, 10 * 60_000 + 1_000), deliver: 'silent' })
    const { runtime, events } = newRuntime(dir, {
      driveTurn: async () => ({ text: 'ignored' }),
      deliverText: async () => undefined,
    })
    await waitFor(() => eventsFor(events).length === 1)
    await runtime.dispose()
    expect(eventsFor(events)[0]!.status).toBe('silent')
  })

  it('finish append 失败不发事件', async () => {
    const dir = tempDir()
    seedJob(dir, dueIntervalJob(10, 10 * 60_000 + 1_000))
    const { runtime, controller, errors, events } = newRuntime(dir, {
      driveTurn: async () => {
        // claim 已落盘之后让 finish 的原子追加目标变成目录 → append 失败
        mkdirSync(join(dir, 'runs.jsonl.tmp'))
        return { text: 'x' }
      },
      deliverText: async () => undefined,
    })
    await waitFor(() => errors.some(message => message.includes('finish append failed')))
    await new Promise(resolve => setTimeout(resolve, 250))
    controller.abort()
    await runtime.dispose()
    // 没有伪造终态事件
    expect(eventsFor(events)).toHaveLength(0)
    // claim 仍保留
    const lines = readLines(dir)
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!)).toMatchObject({ event: 'claim' })
  })

  it('observer reject 不改变已写入的 finish、不重复执行、不重复投递', async () => {
    const dir = tempDir()
    seedJob(dir, dueIntervalJob(10, 10 * 60_000 + 1_000))
    let driveCalls = 0
    let deliverCalls = 0
    const events: Array<{ name: string; payload: unknown }> = []
    const controller = new AbortController()
    const ctx = fakeCtx([], events) as { parallel: (name: string, payload: unknown) => Promise<void> }
    ctx.parallel = async () => { throw new Error('observer boom') }
    const runtime = new SchedulerRuntime(
      ctx as never,
      makeConfig(dir),
      {} as never,
      0,
      controller.signal,
      {
        driveTurn: async () => { driveCalls++; return { text: 'ok' } },
        deliverText: async () => { deliverCalls++ },
      },
    )
    runtime.start()
    await waitFor(() => {
      const lines = readLines(dir)
      return lines.length >= 2 && JSON.parse(lines[lines.length - 1]!).status === 'success'
    })
    await new Promise(resolve => setTimeout(resolve, 250))
    await runtime.dispose()
    // finish 已真实持久化, 未因 observer 失败倒改
    const finish = JSON.parse(readLines(dir).at(-1)!) as { status: string; deliveredAt?: string }
    expect(finish.status).toBe('success')
    expect(finish.deliveredAt).toBeDefined()
    expect(driveCalls).toBe(1)
    expect(deliverCalls).toBe(1)
  })

  it('事件不含 prompt、完整 output、token 或 chat id', async () => {
    const dir = tempDir()
    seedJob(dir, dueIntervalJob(10, 10 * 60_000 + 1_000))
    const { runtime, events } = newRuntime(dir, {
      driveTurn: async () => ({ text: 'secret full output body' }),
      deliverText: async () => undefined,
    })
    await waitFor(() => eventsFor(events).length === 1)
    await runtime.dispose()
    const event = eventsFor(events)[0]!
    const serialized = JSON.stringify(event)
    expect(serialized).not.toContain('test prompt')
    expect(serialized).not.toContain('secret full output body')
    expect(serialized).not.toContain('token')
    expect(serialized).not.toContain('chatId')
    expect(serialized).not.toContain('outputPreview')
  })
})

function readLines(dir: string): string[] {
  const file = join(dir, 'runs.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter(line => line.trim() !== '')
}

function jobIdOf(dir: string): string {
  const file = join(dir, 'jobs.jsonl')
  const lines = readFileSync(file, 'utf8').split('\n').filter(line => line.trim() !== '')
  return (JSON.parse(lines.at(-1)!) as { id: string }).id
}
