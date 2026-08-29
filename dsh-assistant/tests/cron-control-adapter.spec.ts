/**
 * Lane C: test-first boundary for the assistant -> dsh-cron control bridge.
 *
 * These tests deliberately load the future adapter dynamically.  The first
 * red run therefore identifies the missing assistant-side control surface
 * without importing dsh-cron into the assistant core or changing any of the
 * existing lifecycle/store work in this dirty worktree.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// These type imports are intentionally from the future assistant-owned inner
// module. They prevent the test from becoming the source of truth for the
// port/DTO shape while `loadInnerPort()` below keeps the first red runtime
// diagnostic explicit and dynamic.
type AssistantCronPortModule = typeof import('../src/cron-control-port.ts')
type AssistantCronBindingSpec = import('../src/cron-control-port.ts').AssistantCronBindingSpec
type AssistantCronBindingSnapshot = import('../src/cron-control-port.ts').AssistantCronBindingSnapshot
type AssistantCronControlPort = import('../src/cron-control-port.ts').AssistantCronControlPort

type DshCronResponse = {
  readonly protocolVersion: 1
  readonly ok: boolean
  readonly operation?: 'ensure-bound' | 'replace-bound' | 'delete-bound' | 'get-bound'
  readonly snapshot?: unknown
  readonly errorCode?: string
  readonly message?: string
}

type DshCronTransportError = {
  readonly code: 'control_unavailable' | 'timeout' | 'protocol_error'
  readonly message: string
}

type DshCronClientFake = {
  ensureBound(spec: unknown): Promise<DshCronResponse | DshCronTransportError>
  replaceBound(spec: unknown): Promise<DshCronResponse | DshCronTransportError>
  deleteBound(externalRef: string): Promise<DshCronResponse | DshCronTransportError>
  getBound(externalRef: string): Promise<DshCronResponse | DshCronTransportError>
  readiness(): Promise<{ readonly protocolVersion: 1; readonly writer: 'manager'; readonly ready: true }>
}

type AdapterModule = typeof import('../src/cron-control-adapter.ts')

async function loadInnerPort(): Promise<{ readonly module?: AssistantCronPortModule; readonly error?: unknown }> {
  try {
    const module = await import('../src/cron-control-port.ts') as AssistantCronPortModule
    return { module }
  } catch (error: unknown) {
    return { error }
  }
}

async function loadAdapter(): Promise<{ readonly module?: AdapterModule; readonly error?: unknown }> {
  try {
    const module = await import('../src/cron-control-adapter.ts') as unknown as AdapterModule
    return { module }
  } catch (error: unknown) {
    return { error }
  }
}

const BOUND_SPEC: AssistantCronBindingSpec = {
  externalRef: 'assistant:monitor-1',
  schedule: { kind: 'interval', minutes: 15 },
  prompt: '只观察这个工作区的指定变化并在有变化时汇报。',
  cwd: '/tmp/assistant-cron-test',
}

const WIRE_SNAPSHOT = {
  externalRef: BOUND_SPEC.externalRef,
  activeJob: {
    id: 'cron-job-1',
    externalRef: BOUND_SPEC.externalRef,
    schedule: BOUND_SPEC.schedule,
    prompt: BOUND_SPEC.prompt,
    cwd: BOUND_SPEC.cwd,
    deliver: 'telegram' as const,
    sessionMode: 'per_run' as const,
    createdAt: '2026-08-18T00:00:00.000Z',
  },
  latestRun: null,
}

const LOCAL_SNAPSHOT: AssistantCronBindingSnapshot = {
  externalRef: BOUND_SPEC.externalRef,
  activeJob: {
    id: WIRE_SNAPSHOT.activeJob.id,
    externalRef: WIRE_SNAPSHOT.activeJob.externalRef,
    schedule: WIRE_SNAPSHOT.activeJob.schedule,
    prompt: WIRE_SNAPSHOT.activeJob.prompt,
    cwd: WIRE_SNAPSHOT.activeJob.cwd,
    createdAt: WIRE_SNAPSHOT.activeJob.createdAt,
  },
  latestRun: null,
}

describe('dsh-assistant cron control boundary (first red)', () => {
  it('defines the assistant-owned port and keeps inner layers free of dsh-cron imports', async () => {
    const inner = await loadInnerPort()
    expect(inner.error, 'assistant-owned port/DTO module is not implemented yet').toBeUndefined()
    if (inner.error !== undefined || inner.module === undefined) return

    const loaded = await loadAdapter()
    expect(loaded.error, 'assistant cron adapter is not implemented yet').toBeUndefined()
    if (loaded.error !== undefined || loaded.module === undefined) return

    const innerSourceFiles = readdirSync(new URL('../src/', import.meta.url))
      .filter(file => file.endsWith('.ts') && file !== 'cron-control-adapter.ts')
    for (const file of innerSourceFiles) {
      const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8')
      expect(source, `${file} must not import the manager package`).not.toMatch(/@deepseek-ai\/dsh-cron|dsh-cron\/src/)
    }

    const adapterSource = readFileSync(new URL('../src/cron-control-adapter.ts', import.meta.url), 'utf8')
    expect(adapterSource, 'only the outer adapter may import the manager package').toMatch(/@deepseek-ai\/dsh-cron/)

    // Interface/type declarations are erased at runtime, so the inner module
    // itself must be present and the adapter's returned object must satisfy the
    // method fixture defined by the assistant-owned contract.
    expect(adapterSource).toMatch(/AssistantCronControlPort/)
    const methods = ['ensureBound', 'replaceBound', 'deleteBound', 'getBound', 'readiness'] as const
    const client = {
      ensureBound: async () => ({ protocolVersion: 1, ok: true, operation: 'ensure-bound' as const, snapshot: WIRE_SNAPSHOT }),
      replaceBound: async () => ({ protocolVersion: 1, ok: true, operation: 'replace-bound' as const, snapshot: WIRE_SNAPSHOT }),
      deleteBound: async (externalRef: string) => ({ protocolVersion: 1, ok: true, operation: 'delete-bound' as const, snapshot: { externalRef, activeJob: null, latestRun: null } }),
      getBound: async (externalRef: string) => ({ protocolVersion: 1, ok: true, operation: 'get-bound' as const, snapshot: { externalRef, activeJob: null, latestRun: null } }),
      readiness: async () => ({ protocolVersion: 1, writer: 'manager' as const, ready: true as const }),
    }
    const port = loaded.module.createAssistantCronControlAdapter({ client }) as AssistantCronControlPort
    expect(methods.every(method => typeof port[method] === 'function')).toBe(true)
  })

  it('maps local DTOs to the manager-owned per-run Telegram binding and preserves actual snapshots', async () => {
    const loaded = await loadAdapter()
    expect(loaded.error, 'assistant cron adapter is not implemented yet').toBeUndefined()
    if (loaded.error !== undefined || loaded.module === undefined) return

    const calls: unknown[] = []
    const client: DshCronClientFake = {
      ensureBound: async spec => {
        calls.push(spec)
        return {
          protocolVersion: 1,
          ok: true,
          operation: 'ensure-bound',
          snapshot: WIRE_SNAPSHOT,
        }
      },
      replaceBound: async spec => {
        calls.push(spec)
        return {
          protocolVersion: 1,
          ok: true,
          operation: 'replace-bound',
          snapshot: WIRE_SNAPSHOT,
        }
      },
      deleteBound: async externalRef => ({
        protocolVersion: 1,
        ok: true,
        operation: 'delete-bound',
        snapshot: { externalRef, activeJob: null, latestRun: null },
      }),
      getBound: async externalRef => ({
        protocolVersion: 1,
        ok: true,
        operation: 'get-bound',
        snapshot: { externalRef, activeJob: null, latestRun: null },
      }),
      readiness: async () => ({ protocolVersion: 1, writer: 'manager', ready: true }),
    }

    const port = loaded.module.createAssistantCronControlAdapter({ client })
    const result = await port.ensureBound(BOUND_SPEC)
    expect(result).toMatchObject({ ok: true, snapshot: LOCAL_SNAPSHOT })
    expect(result).not.toHaveProperty('snapshot.activeJob.deliver')
    expect(result).not.toHaveProperty('snapshot.activeJob.sessionMode')
    expect(calls).toEqual([{
      externalRef: BOUND_SPEC.externalRef,
      schedule: BOUND_SPEC.schedule,
      prompt: BOUND_SPEC.prompt,
      cwd: BOUND_SPEC.cwd,
      deliver: 'telegram',
      sessionMode: 'per_run',
    }])
  })

  it('maps both frozen wire errors and local transport errors without turning either into success', async () => {
    const inner = await loadInnerPort()
    expect(inner.error, 'assistant-owned port/DTO module is not implemented yet').toBeUndefined()
    if (inner.error !== undefined || inner.module === undefined) return
    const loaded = await loadAdapter()
    expect(loaded.error, 'assistant cron adapter is not implemented yet').toBeUndefined()
    if (loaded.error !== undefined || loaded.module === undefined) return

    const baseClient: DshCronClientFake = {
      ensureBound: async () => ({ protocolVersion: 1, ok: false, operation: 'ensure-bound', errorCode: 'binding_conflict', message: 'manager already owns this ref' }),
      replaceBound: async () => ({ protocolVersion: 1, ok: false, operation: 'replace-bound', errorCode: 'persistence_uncertain', message: 'manager write uncertain' }),
      deleteBound: async externalRef => ({ protocolVersion: 1, ok: true, operation: 'delete-bound', snapshot: { externalRef, activeJob: null, latestRun: null } }),
      getBound: async externalRef => ({ protocolVersion: 1, ok: true, operation: 'get-bound', snapshot: { externalRef, activeJob: null, latestRun: null } }),
      readiness: async () => ({ protocolVersion: 1, writer: 'manager', ready: true }),
    }
    const wirePort = loaded.module.createAssistantCronControlAdapter({ client: baseClient })
    await expect(wirePort.ensureBound(BOUND_SPEC)).resolves.toMatchObject({
      ok: false,
      code: 'binding_conflict',
      message: 'manager already owns this ref',
    })

    const transportPort = loaded.module.createAssistantCronControlAdapter({
      client: {
        ...baseClient,
        ensureBound: async () => ({ code: 'control_unavailable' as const, message: 'socket refused connection' }),
      },
    })
    await expect(transportPort.ensureBound(BOUND_SPEC)).resolves.toMatchObject({
      ok: false,
      code: 'control_unavailable',
      message: 'socket refused connection',
    })
  })

  it('reports manager readiness asynchronously and never labels an unavailable control plane ready', async () => {
    const loaded = await loadAdapter()
    expect(loaded.error, 'assistant cron adapter is not implemented yet').toBeUndefined()
    if (loaded.error !== undefined || loaded.module === undefined) return

    const unavailableClient: DshCronClientFake = {
      ensureBound: async () => ({ protocolVersion: 1, ok: false, errorCode: 'internal_error', message: 'unused' }),
      replaceBound: async () => ({ protocolVersion: 1, ok: false, errorCode: 'internal_error', message: 'unused' }),
      deleteBound: async externalRef => ({ protocolVersion: 1, ok: true, operation: 'delete-bound', snapshot: { externalRef, activeJob: null, latestRun: null } }),
      getBound: async externalRef => ({ protocolVersion: 1, ok: true, operation: 'get-bound', snapshot: { externalRef, activeJob: null, latestRun: null } }),
      readiness: async () => {
        throw new Error('manager socket is unavailable')
      },
    }

    const port = loaded.module.createAssistantCronControlAdapter({ client: unavailableClient })
    await expect(port.readiness()).resolves.toMatchObject({
      state: 'unavailable',
      reason: expect.stringContaining('manager socket is unavailable'),
    })
  })

  it('fails closed when the assistant and manager protocol versions differ', async () => {
    const loaded = await loadAdapter()
    expect(loaded.error).toBeUndefined()
    if (loaded.error !== undefined || loaded.module === undefined) return
    const mismatch = {
      ensureBound: async () => ({ protocolVersion: 2, ok: true, operation: 'ensure-bound', snapshot: WIRE_SNAPSHOT }),
      replaceBound: async () => ({ protocolVersion: 2, ok: true, operation: 'replace-bound', snapshot: WIRE_SNAPSHOT }),
      deleteBound: async (externalRef: string) => ({ protocolVersion: 2, ok: true, operation: 'delete-bound', snapshot: { externalRef, activeJob: null, latestRun: null } }),
      getBound: async (externalRef: string) => ({ protocolVersion: 2, ok: true, operation: 'get-bound', snapshot: { externalRef, activeJob: null, latestRun: null } }),
      readiness: async () => ({ protocolVersion: 2, writer: 'manager', ready: true }),
    }
    const port = loaded.module.createAssistantCronControlAdapter({ client: mismatch as never })
    await expect(port.getBound('dsh:health:read-only:v1')).resolves.toMatchObject({
      ok: false,
      code: 'protocol_error',
    })
    await expect(port.readiness()).resolves.toMatchObject({
      state: 'unavailable',
      reason: expect.stringContaining('protocol'),
    })
  })
})
