import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ASSISTANT_CRON_CONTROL_PROTOCOL_VERSION,
  createAssistantCronControlAdapter,
  createAssistantCronControlAdapterFromSocket,
} from '../src/cron-control-adapter.ts'
import type { AssistantCronBindingSpec } from '../src/cron-control-port.ts'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const SPEC: AssistantCronBindingSpec = {
  externalRef: 'assistant:monitor-1',
  schedule: { kind: 'interval', minutes: 15 },
  prompt: '只观察这个工作区的指定变化并在有变化时汇报。',
  cwd: '/tmp/assistant-control-test',
}

const SNAPSHOT = {
  externalRef: SPEC.externalRef,
  activeJob: {
    id: 'job-1',
    externalRef: SPEC.externalRef,
    schedule: SPEC.schedule,
    prompt: SPEC.prompt,
    cwd: SPEC.cwd,
    deliver: 'default',
    sessionMode: 'per_run',
    createdAt: '2026-09-05T00:00:00.000Z',
  },
  latestRun: {
    runId: 'run-1',
    jobId: 'job-1',
    scheduledFor: '2026-09-05T00:00:00.000Z',
    finishedAt: '2026-09-05T00:00:03.000Z',
    runStatus: 'success',
    summary: 'no change',
    deliveryState: 'delivered',
    deliveredAt: '2026-09-05T00:00:04.000Z',
  },
}

function success(operation: string, snapshot: unknown = SNAPSHOT) {
  return { protocolVersion: 2, ok: true, operation, snapshot }
}

function fakeClient(overrides: Partial<Record<'ensureBound' | 'replaceBound' | 'deleteBound' | 'getBound' | 'readiness', (...args: never[]) => Promise<unknown>>> = {}) {
  return {
    ensureBound: vi.fn(async () => success('ensure-bound')),
    replaceBound: vi.fn(async () => success('replace-bound')),
    deleteBound: vi.fn(async (externalRef: string) => success('delete-bound', { externalRef, activeJob: null, latestRun: null })),
    getBound: vi.fn(async (externalRef: string) => success('get-bound', { externalRef, activeJob: null, latestRun: null })),
    readiness: vi.fn(async () => ({ protocolVersion: 2, writer: 'manager', ready: true })),
    ...overrides,
  }
}

describe('assistant-owned cron control adapter', () => {
  it('uses protocol v2, sends neutral delivery, and strips manager-only job fields', async () => {
    const client = fakeClient()
    const port = createAssistantCronControlAdapter({ client })

    await expect(port.ensureBound(SPEC)).resolves.toEqual({
      ok: true,
      snapshot: {
        externalRef: SPEC.externalRef,
        activeJob: {
          id: 'job-1', externalRef: SPEC.externalRef, schedule: SPEC.schedule,
          prompt: SPEC.prompt, cwd: SPEC.cwd, createdAt: '2026-09-05T00:00:00.000Z',
        },
        latestRun: {
          runId: 'run-1', jobId: 'job-1', scheduledFor: '2026-09-05T00:00:00.000Z',
          finishedAt: '2026-09-05T00:00:03.000Z', runStatus: 'success', summary: 'no change',
          deliveryState: 'delivered', deliveredAt: '2026-09-05T00:00:04.000Z',
        },
      },
    })
    expect(ASSISTANT_CRON_CONTROL_PROTOCOL_VERSION).toBe(2)
    expect(client.ensureBound).toHaveBeenCalledWith({
      externalRef: SPEC.externalRef,
      schedule: SPEC.schedule,
      prompt: SPEC.prompt,
      cwd: SPEC.cwd,
      deliver: 'default',
      sessionMode: 'per_run',
    })
  })

  it.each([
    ['wrong protocol', success('get-bound', { externalRef: 'x', activeJob: null, latestRun: null }) as Record<string, unknown>],
    ['malformed snapshot', success('get-bound', { externalRef: 7, activeJob: null, latestRun: null })],
    ['malformed run', success('get-bound', { ...SNAPSHOT, latestRun: { ...SNAPSHOT.latestRun, deliveryState: 'mystery' } })],
    ['legacy delivery value', success('get-bound', { ...SNAPSHOT, activeJob: { ...SNAPSHOT.activeJob, deliver: 'telegram' } })],
    ['wrong session lifetime', success('get-bound', { ...SNAPSHOT, activeJob: { ...SNAPSHOT.activeJob, sessionMode: 'persistent' } })],
  ])('fails closed on a %s response decoded from unknown', async (name, response) => {
    if (name === 'wrong protocol') response.protocolVersion = 1
    const port = createAssistantCronControlAdapter({ client: fakeClient({ getBound: async () => response }) })
    await expect(port.getBound('assistant:monitor-1')).resolves.toMatchObject({ ok: false, code: 'protocol_error' })
  })

  it('maps manager and transport failures without turning them into success', async () => {
    const manager = createAssistantCronControlAdapter({
      client: fakeClient({
        ensureBound: async () => ({ protocolVersion: 2, ok: false, operation: 'ensure-bound', errorCode: 'binding_conflict', message: 'already owned' }),
      }),
    })
    await expect(manager.ensureBound(SPEC)).resolves.toEqual({ ok: false, code: 'binding_conflict', message: 'already owned' })

    const managerWithoutOperation = createAssistantCronControlAdapter({
      client: fakeClient({
        ensureBound: async () => ({ protocolVersion: 2, ok: false, errorCode: 'internal_error', message: 'manager failed before dispatch' }),
      }),
    })
    await expect(managerWithoutOperation.ensureBound(SPEC)).resolves.toEqual({
      ok: false,
      code: 'internal_error',
      message: 'manager failed before dispatch',
    })

    const transport = createAssistantCronControlAdapter({
      client: fakeClient({ ensureBound: async () => { throw new Error('socket refused') } }),
    })
    await expect(transport.ensureBound(SPEC)).resolves.toEqual({ ok: false, code: 'control_unavailable', message: 'socket refused' })
  })

  it('reports readiness mismatch or connection failure as unavailable', async () => {
    const mismatch = createAssistantCronControlAdapter({
      client: fakeClient({ readiness: async () => ({ protocolVersion: 1, writer: 'manager', ready: true }) }),
    })
    await expect(mismatch.readiness()).resolves.toMatchObject({ state: 'unavailable', reason: expect.stringContaining('protocol') })

    const unavailable = createAssistantCronControlAdapter({
      client: fakeClient({ readiness: async () => { throw new Error('no socket') } }),
    })
    await expect(unavailable.readiness()).resolves.toEqual({ state: 'unavailable', reason: 'no socket' })
  })
})

describe('assistant native HTTP-over-Unix-socket client', () => {
  it('implements only ensure, replace, delete, get and readiness with v2 requests', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-assistant-control-'))
    dirs.push(dir)
    const socketPath = join(dir, 'control.sock')
    const requests: Array<{ method?: string; url?: string; body?: unknown }> = []
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const bodyText = Buffer.concat(chunks).toString('utf8')
      const body = bodyText === '' ? undefined : JSON.parse(bodyText) as unknown
      requests.push({ method: req.method, url: req.url, body })
      const response = req.url === '/health'
        ? { protocolVersion: 2, writer: 'manager', ready: true }
        : success((body as { operation: string }).operation, {
            externalRef: (body as { externalRef?: string; spec?: { externalRef: string } }).externalRef
              ?? (body as { spec: { externalRef: string } }).spec.externalRef,
            activeJob: null,
            latestRun: null,
          })
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(response))
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, resolve)
    })

    try {
      const port = createAssistantCronControlAdapterFromSocket({ socketPath, timeoutMs: 1_000 })
      await expect(port.readiness()).resolves.toEqual({ state: 'ready' })
      await expect(port.ensureBound(SPEC)).resolves.toMatchObject({ ok: true })
      await expect(port.replaceBound(SPEC)).resolves.toMatchObject({ ok: true })
      await expect(port.deleteBound(SPEC.externalRef)).resolves.toMatchObject({ ok: true })
      await expect(port.getBound(SPEC.externalRef)).resolves.toMatchObject({ ok: true })
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }

    expect(requests).toEqual([
      { method: 'GET', url: '/health', body: undefined },
      { method: 'POST', url: '/rpc', body: { protocolVersion: 2, operation: 'ensure-bound', spec: { ...SPEC, deliver: 'default', sessionMode: 'per_run' } } },
      { method: 'POST', url: '/rpc', body: { protocolVersion: 2, operation: 'replace-bound', spec: { ...SPEC, deliver: 'default', sessionMode: 'per_run' } } },
      { method: 'POST', url: '/rpc', body: { protocolVersion: 2, operation: 'delete-bound', externalRef: SPEC.externalRef } },
      { method: 'POST', url: '/rpc', body: { protocolVersion: 2, operation: 'get-bound', externalRef: SPEC.externalRef } },
    ])
  })
})
