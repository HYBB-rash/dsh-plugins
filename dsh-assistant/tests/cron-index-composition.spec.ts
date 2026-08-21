/**
 * Lane C2b2: composition-root wiring red tests.
 *
 * These tests deliberately exercise the real Cordis plugin entry point.  The
 * Unix-socket adapter is the only mocked seam; the assistant SQLite store,
 * startup reconciliation, and run-finished projection remain real.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as plugin from '../src/index.ts'
import { AssistantStore, type CronBindingRow } from '../src/store.ts'

const cronAdapterMock = vi.hoisted(() => ({
  createAssistantCronControlAdapterFromSocket: vi.fn(),
}))

vi.mock('../src/cron-control-adapter.ts', () => cronAdapterMock)
vi.mock('@deepseek-ai/dsh-telegram-gateway', () => ({
  createTelegramHttp: () => ({
    getMe: vi.fn(async () => ({ id: 1, username: 'test' })),
  }),
}))

const NOW = '2026-08-18T02:00:00.000Z'
const SOCKET_PATH = '/tmp/dsh-cron-c2b2-control.sock'

const tempDirs: string[] = []

function tempPath(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-assistant-cron-index-'))
  tempDirs.push(dir)
  return join(dir, name)
}

afterEach(() => {
  cronAdapterMock.createAssistantCronControlAdapterFromSocket.mockReset()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

type CronPort = {
  ensureBound: ReturnType<typeof vi.fn>
  replaceBound: ReturnType<typeof vi.fn>
  deleteBound: ReturnType<typeof vi.fn>
  getBound: ReturnType<typeof vi.fn>
  readiness: ReturnType<typeof vi.fn>
}

function makeCronPort(options: {
  readonly readiness?: { readonly state: 'ready' | 'unavailable'; readonly reason?: string }
  readonly getBound?: (externalRef: string) => unknown
} = {}): CronPort {
  const readiness = options.readiness ?? { state: 'ready' as const }
  return {
    ensureBound: vi.fn(async () => ({ ok: false, code: 'unexpected', message: 'unexpected ensureBound' })),
    replaceBound: vi.fn(async () => ({ ok: false, code: 'unexpected', message: 'unexpected replaceBound' })),
    deleteBound: vi.fn(async () => ({ ok: false, code: 'unexpected', message: 'unexpected deleteBound' })),
    getBound: vi.fn(async (externalRef: string) => options.getBound?.(externalRef) ?? {
      ok: true,
      snapshot: { externalRef, activeJob: null, latestRun: null },
    }),
    readiness: vi.fn(async () => readiness),
  }
}

function fakeAgentContext() {
  const listeners = new Map<string, Array<(payload: unknown) => void>>()
  const tools = new Map<string, unknown>()
  return {
    on(name: string, fn: (payload: unknown) => void) {
      const callbacks = listeners.get(name) ?? []
      callbacks.push(fn)
      listeners.set(name, callbacks)
      return () => {
        const index = callbacks.indexOf(fn)
        if (index >= 0) callbacks.splice(index, 1)
      }
    },
    effect(fn: () => void | (() => void)) {
      const cleanup = fn() ?? (() => {})
      let disposed = false
      return () => {
        if (disposed) return
        disposed = true
        cleanup()
      }
    },
    tools: {
      register(def: { readonly name: string }) {
        tools.set(def.name, def)
        return () => { tools.delete(def.name) }
      },
      guard: () => () => {},
      schemas: () => [...tools.keys()].map(name => ({ name })),
    },
    systemPrompt: { section: () => () => {} },
    emit(name: string, payload: unknown) {
      for (const callback of listeners.get(name) ?? []) callback(payload)
    },
    _listeners: listeners,
  }
}

function fakeAgent(id = 'session-telegram') {
  const ctx = fakeAgentContext()
  const agent = {
    id: SessionId(id),
    session: { id: SessionId(id) },
    ctx,
  }
  return agent as unknown as Agent
}

function fakeRegistry(initial: Agent[] = []) {
  const agents = new Map(initial.map(agent => [String(agent.id), agent]))
  return {
    roots: () => [...agents.values()],
    get: (id: string) => agents.get(id),
    add: (agent: Agent) => { agents.set(String(agent.id), agent) },
  }
}

async function mount(
  mode: 'web' | 'telegram',
  storePath: string,
  options: { readonly cronControlSocketPath?: string; readonly raw?: boolean } = {},
) {
  const ctx = new Context()
  const warning = vi.spyOn(ctx.logger, 'warn')
  const registry = fakeRegistry(mode === 'telegram' ? [fakeAgent()] : [fakeAgent('session-web')])
  ctx.provide('agents', registry as never)
  ctx.provide('subagents', {
    startContinuable: vi.fn(async () => ({ childId: SessionId('child-test'), messageId: 'message-test' })),
    interrupt: vi.fn(),
    followup: vi.fn(async () => 'message-test'),
  } as never)
  ctx.provide('credentials', { resolve: async () => ({ value: 'test-token' }) } as never)
  ctx.provide('tools', { register: () => () => {} } as never)
  ctx.provide('systemPrompt', { section: () => () => {} } as never)

  const config = {
    mode,
    storePath,
    pollIntervalMs: 60_000,
    ...(mode === 'telegram' ? { token: 'test-token', chatId: '12345', telegramParentSessionId: 'session-telegram' } : {}),
    ...(options.cronControlSocketPath === undefined ? {} : { cronControlSocketPath: options.cronControlSocketPath }),
  }
  const mounted = options.raw === true
    ? (await plugin.apply(ctx, config as never), { dispose: async () => (ctx as unknown as { fiber: { dispose(): Promise<void> } }).fiber.dispose() })
    : await ctx.plugin(plugin, config as never)
  return { ctx, mounted, warning }
}

type SeededBinding = {
  readonly commitmentId: string
  readonly externalRef: string
  readonly jobId: string
  readonly direction: string
}

function seedBoundMonitors(path: string, count: number): SeededBinding[] {
  const store = new AssistantStore(path)
  const bindings: SeededBinding[] = []
  try {
    for (let index = 0; index < count; index++) {
      const direction = `watch direction ${index}`
      const created = store.createAgentCommitment({
        title: `bound monitor ${index}`,
        kind: 'monitor',
        monitorDirection: direction,
        sourceSurface: 'telegram',
        now: NOW,
      })
      if (!created.ok) throw new Error(`monitor seed failed: ${created.message}`)
      const active = store.markAgentActive(created.row.id, created.row.revision)
      if (!active.ok) throw new Error(`monitor activation failed: ${active.message}`)
      const externalRef = `assistant:${created.row.id}`
      const jobId = `manager-job-${index}`
      const binding = store.createCronBinding({
        commitmentId: created.row.id,
        externalRef,
        desiredScheduleJson: JSON.stringify({ kind: 'interval', minutes: 15 }),
        desiredState: 'running',
        boundJobId: jobId,
        updatedAt: NOW,
      })
      if (!binding.ok) throw new Error(`binding seed failed: ${binding.message}`)
      bindings.push({ commitmentId: created.row.id, externalRef, jobId, direction })
    }
  } finally {
    store.close()
  }
  return bindings
}

function managerSnapshot(binding: SeededBinding, latestRun: Record<string, unknown> | null = null) {
  return {
    ok: true,
    snapshot: {
      externalRef: binding.externalRef,
      activeJob: {
        id: binding.jobId,
        externalRef: binding.externalRef,
        schedule: { kind: 'interval', minutes: 15 },
        prompt: binding.direction,
        createdAt: NOW,
      },
      latestRun,
    },
  }
}

function latestManagerRun(binding: SeededBinding): Record<string, unknown> {
  return {
    runId: 'manager-run-1',
    jobId: binding.jobId,
    scheduledFor: '2026-08-18T02:15:00.000Z',
    finishedAt: '2026-08-18T02:15:03.000Z',
    runStatus: 'success',
    summary: 'manager-owned summary',
    deliveryState: 'delivered',
    deliveredAt: '2026-08-18T02:15:04.000Z',
  }
}

describe('assistant Cron composition at the real index entry point (first red)', () => {
  it('Telegram explicit socket creates one adapter and performs one bounded startup reconciliation', async () => {
    const storePath = tempPath('bounded-startup.sqlite')
    const bindings = seedBoundMonitors(storePath, 101)
    const port = makeCronPort({
      getBound: externalRef => {
        const binding = bindings.find(candidate => candidate.externalRef === externalRef)
        if (binding === undefined) throw new Error(`unknown binding ${externalRef}`)
        return managerSnapshot(binding)
      },
    })
    cronAdapterMock.createAssistantCronControlAdapterFromSocket.mockReturnValue(port)

    const { mounted } = await mount('telegram', storePath, { cronControlSocketPath: SOCKET_PATH })
    try {
      expect(cronAdapterMock.createAssistantCronControlAdapterFromSocket).toHaveBeenCalledTimes(1)
      expect(cronAdapterMock.createAssistantCronControlAdapterFromSocket).toHaveBeenCalledWith({ socketPath: SOCKET_PATH })
      expect(port.getBound).toHaveBeenCalledTimes(100)
      expect(port.ensureBound).not.toHaveBeenCalled()
      expect(port.replaceBound).not.toHaveBeenCalled()
      expect(port.deleteBound).not.toHaveBeenCalled()
    } finally {
      await mounted.dispose()
    }
  })

  it('observes run-finished through manager latestRun once, keeps commitment active, and creates no assistant outbox', async () => {
    const storePath = tempPath('run-finished.sqlite')
    const [binding] = seedBoundMonitors(storePath, 1)
    if (binding === undefined) throw new Error('binding seed missing')
    const port = makeCronPort({ getBound: externalRef => managerSnapshot(binding, latestManagerRun(binding)) })
    cronAdapterMock.createAssistantCronControlAdapterFromSocket.mockReturnValue(port)

    const { ctx, mounted } = await mount('telegram', storePath, { cronControlSocketPath: SOCKET_PATH })
    try {
      const event = {
        jobId: binding.jobId,
        runId: 'event-run-that-must-not-be-trusted',
        sessionId: 'session-cron-bound-monitor',
        scheduledFor: '2026-08-18T02:15:00.000Z',
        status: 'success',
        deliveryState: 'delivered',
        summary: 'untrusted event summary',
      }
      const before = new AssistantStore(storePath)
      const outboxBefore = before.listOutbox(binding.commitmentId)
      before.close()

      await ctx.parallel('dsh-cron/run-finished', event)
      await ctx.parallel('dsh-cron/run-finished', event)

      const after = new AssistantStore(storePath)
      const projected = after.getCronBinding(binding.commitmentId) as CronBindingRow | undefined
      const commitment = after.getById(binding.commitmentId)
      const outboxAfter = after.listOutbox(binding.commitmentId)
      after.close()
      expect(port.getBound).toHaveBeenCalledTimes(3) // one startup read + two event observations
      expect(projected).toMatchObject({
        lastRunId: 'manager-run-1',
        lastRunSummary: 'manager-owned summary',
        runStatus: 'success',
      })
      expect(commitment).toMatchObject({ status: 'active', workerSessionId: null, workerRunId: null })
      expect(outboxAfter).toEqual(outboxBefore)
    } finally {
      await mounted.dispose()
    }
  })

  it('removes the run-finished listener on dispose before a later event can read or write', async () => {
    const storePath = tempPath('dispose.sqlite')
    const [binding] = seedBoundMonitors(storePath, 1)
    if (binding === undefined) throw new Error('binding seed missing')
    const port = makeCronPort({ getBound: externalRef => managerSnapshot(binding, latestManagerRun(binding)) })
    cronAdapterMock.createAssistantCronControlAdapterFromSocket.mockReturnValue(port)

    const { ctx, mounted } = await mount('telegram', storePath, { cronControlSocketPath: SOCKET_PATH })
    const beforeDispose = port.getBound.mock.calls.length
    await mounted.dispose()
    await ctx.parallel('dsh-cron/run-finished', {
      jobId: binding.jobId,
      runId: 'late-run-after-dispose',
      sessionId: 'session-cron-bound-monitor',
      scheduledFor: '2026-08-18T02:15:00.000Z',
      status: 'success',
      deliveryState: 'delivered',
    })
    expect(port.getBound).toHaveBeenCalledTimes(beforeDispose)
  })

  it('Web mode neither creates or pings the Cron adapter nor listens for run-finished', async () => {
    const storePath = tempPath('web-isolation.sqlite')
    const { ctx, mounted } = await mount('web', storePath, { cronControlSocketPath: SOCKET_PATH })
    try {
      await ctx.parallel('dsh-cron/run-finished', {
        jobId: 'unrelated-job',
        runId: 'unrelated-run',
        sessionId: 'session-cron-unrelated',
        scheduledFor: NOW,
        status: 'success',
        deliveryState: 'silent',
      })
      expect(cronAdapterMock.createAssistantCronControlAdapterFromSocket).not.toHaveBeenCalled()
    } finally {
      await mounted.dispose()
    }
  })

  it('Telegram with cronControlSocketPath omitted mounts without creating an adapter and reports only the honest missing-path warning', async () => {
    const storePath = tempPath('missing-socket-path.sqlite')
    const { mounted, warning } = await mount('telegram', storePath, { raw: true })
    try {
      expect(cronAdapterMock.createAssistantCronControlAdapterFromSocket).not.toHaveBeenCalled()
      expect(warning).toHaveBeenCalledTimes(1)
      expect(warning).toHaveBeenCalledWith('dsh-assistant: Cron control unavailable; explicit cronControlSocketPath is required')
    } finally {
      await mounted.dispose()
    }
  })

  it('bounds adapter factory failures before writing Cron warnings', async () => {
    const storePath = tempPath('factory-error.sqlite')
    const tail = 'C2B2_FACTORY_ERROR_UNBOUNDED_TAIL'
    cronAdapterMock.createAssistantCronControlAdapterFromSocket.mockImplementation(() => {
      throw new Error(`${'factory failure '.repeat(80)}${tail}`)
    })
    const { mounted, warning } = await mount('telegram', storePath, { cronControlSocketPath: SOCKET_PATH })
    try {
      expect(cronAdapterMock.createAssistantCronControlAdapterFromSocket).toHaveBeenCalledTimes(1)
      expect(warning.mock.calls.flat().join('\n')).not.toContain(tail)
    } finally {
      await mounted.dispose()
    }
  })

  it('Telegram control readiness unavailable still mounts, reports the unavailable startup, and performs no manager mutation', async () => {
    const storePath = tempPath('unavailable.sqlite')
    const startupTail = 'C2B2_STARTUP_REASON_UNBOUNDED_TAIL'
    const port = makeCronPort({ readiness: { state: 'unavailable', reason: `${'manager socket unavailable '.repeat(80)}${startupTail}` } })
    cronAdapterMock.createAssistantCronControlAdapterFromSocket.mockReturnValue(port)

    const ctx = new Context()
    const warning = vi.spyOn(ctx.logger, 'warn')
    // Use the normal mount fixture, but retain the logger spy on this exact
    // context by reproducing its small dependency setup here.
    const registry = fakeRegistry([fakeAgent()])
    ctx.provide('agents', registry as never)
    ctx.provide('subagents', { startContinuable: vi.fn(), interrupt: vi.fn(), followup: vi.fn() } as never)
    ctx.provide('credentials', { resolve: async () => ({ value: 'test-token' }) } as never)
    ctx.provide('tools', { register: () => () => {} } as never)
    ctx.provide('systemPrompt', { section: () => () => {} } as never)
    const mounted = await ctx.plugin(plugin, {
      mode: 'telegram',
      storePath,
      pollIntervalMs: 60_000,
      token: 'test-token',
      chatId: '12345',
      telegramParentSessionId: 'session-telegram',
      cronControlSocketPath: SOCKET_PATH,
    } as never)
    try {
      expect(cronAdapterMock.createAssistantCronControlAdapterFromSocket).toHaveBeenCalledTimes(1)
      expect(port.ensureBound).not.toHaveBeenCalled()
      expect(port.replaceBound).not.toHaveBeenCalled()
      expect(port.deleteBound).not.toHaveBeenCalled()
      expect(warning).toHaveBeenCalledWith(expect.stringMatching(/unavailable|manager socket unavailable/i))
      expect(warning.mock.calls.flat().join('\n')).not.toContain(startupTail)
    } finally {
      await mounted.dispose()
    }
  })
})
