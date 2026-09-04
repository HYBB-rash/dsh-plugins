import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { SchedulerRuntime, type SchedulerConfig } from '../src/scheduler.ts'
import { JobStore, RunStore } from '../src/store.ts'

const directories: string[] = []

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-cron-delivery-port-'))
  directories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function config(storeDir: string): SchedulerConfig {
  return {
    storeDir,
    pollIntervalMs: 60_000,
    maxConcurrent: 1,
    deliverOnError: true,
  }
}

function seedDueJob(storeDir: string, id: string): void {
  new JobStore(storeDir).append({
    op: 'create',
    kind: 'command',
    id,
    schedule: { kind: 'once', runAt: new Date(Date.now() - 30_000).toISOString() },
    command: { argv: ['unused'], timeoutSeconds: 1, outputMaxBytes: 1024 },
    deliver: 'default',
    createdAt: new Date().toISOString(),
  })
}

async function waitForFinish(storeDir: string, count = 1): Promise<void> {
  const startedAt = Date.now()
  while (new RunStore(storeDir).readAll().filter(record => record.event === 'finish').length < count) {
    if (Date.now() - startedAt > 4_000) throw new Error('timed out waiting for scheduler finish')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

function context(resolveDelivery: () => unknown) {
  return {
    get: (name: string) => name === 'dshTextDeliveryV1' ? resolveDelivery() : undefined,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    parallel: async () => undefined,
  } as never
}

async function observe(provider: unknown): Promise<Record<string, unknown>> {
  const storeDir = temporaryDirectory()
  seedDueJob(storeDir, 'delivery-port-job')
  const runtime = new SchedulerRuntime(
    context(() => provider),
    config(storeDir),
    new AbortController().signal,
    { runCommand: async () => ({ text: 'complete body', error: undefined }) },
  )
  runtime.start()
  try {
    await waitForFinish(storeDir)
    return new RunStore(storeDir).readAll().find(record => record.event === 'finish') as unknown as Record<string, unknown>
  } finally {
    await runtime.dispose()
  }
}

describe('neutral delivery service boundary', () => {
  it.each([
    ['missing', undefined],
    ['incompatible protocol', { protocolVersion: 2, deliver: async () => ({ state: 'delivered' }) }],
  ])('starts and records failed when the provider is %s', async (_name, provider) => {
    await expect(observe(provider)).resolves.toMatchObject({ status: 'success', deliveryState: 'failed' })
  })

  it('records uncertain when the provider throws', async () => {
    const provider = { protocolVersion: 1, deliver: async () => { throw new Error('ambiguous') } }
    await expect(observe(provider)).resolves.toMatchObject({
      status: 'success',
      deliveryState: 'uncertain',
      deliveryError: 'ambiguous',
    })
  })

  it.each([
    ['malformed result', { protocolVersion: 1, deliver: async () => ({ unexpected: true }) }],
    ['empty delivered timestamp', { protocolVersion: 1, deliver: async () => ({ state: 'delivered', deliveredAt: '' }) }],
    ['blank failed error', { protocolVersion: 1, deliver: async () => ({ state: 'failed', error: '   ' }) }],
    ['empty uncertain error', { protocolVersion: 1, deliver: async () => ({ state: 'uncertain', error: '' }) }],
  ])('rejects %s as an unrecognized result', async (_name, provider) => {
    await expect(observe(provider)).resolves.toMatchObject({
      status: 'success',
      deliveryState: 'uncertain',
      deliveryError: 'delivery returned an unrecognized result',
    })
  })

  it.each([
    [{ state: 'delivered', deliveredAt: '2026-09-05T00:00:00.000Z' }, 'delivered'],
    [{ state: 'failed', error: 'rejected' }, 'failed'],
    [{ state: 'uncertain', error: 'unknown' }, 'uncertain'],
  ] as const)('preserves a valid provider result %#', async (result, expected) => {
    const provider = {
      protocolVersion: 1,
      deliver: async ({ text, signal }: { text: string; signal: AbortSignal }) => {
        expect(text).toBe('complete body')
        expect(signal).toBeInstanceOf(AbortSignal)
        return result
      },
    }
    await expect(observe(provider)).resolves.toMatchObject({ status: 'success', deliveryState: expected })
  })

  it('resolves the service again for each delivery attempt', async () => {
    const storeDir = temporaryDirectory()
    seedDueJob(storeDir, 'first')
    seedDueJob(storeDir, 'second')
    let resolutions = 0
    const runtime = new SchedulerRuntime(
      context(() => {
        resolutions += 1
        return {
          protocolVersion: 1,
          deliver: async () => resolutions === 1
            ? { state: 'delivered', deliveredAt: '2026-09-05T00:00:00.000Z' }
            : { state: 'failed', error: 'provider changed' },
        }
      }),
      config(storeDir),
      new AbortController().signal,
      { runCommand: async () => ({ text: 'complete body', error: undefined }) },
    )
    runtime.start()
    try {
      await waitForFinish(storeDir, 2)
      expect(resolutions).toBe(2)
      const finishes = new RunStore(storeDir).readAll().filter(record => record.event === 'finish')
      expect(finishes.map(record => record.deliveryState).sort()).toEqual(['delivered', 'failed'])
    } finally {
      await runtime.dispose()
    }
  })
})
