import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { apply as applyCron, Config, createControlService, type BoundCronCommandSpec } from '../src/index.ts'

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cron-managed-command-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const RETRY_BINDING: BoundCronCommandSpec = {
  externalRef: 'dsh:notion-task-inbox:retry:v1',
  schedule: { kind: 'interval', minutes: 5 },
  command: {
    argv: [
      '/usr/bin/python3',
      '/home/herman/.dsh/workspace/automations/notion/notion_inbox_sync.py',
      '--retry-pending',
      '--json',
    ],
    timeoutSeconds: 120,
    outputMaxBytes: 4096,
  },
  deliver: 'silent',
  cwd: '/home/herman/.dsh/workspace',
}

async function startManager(storeDir: string, binding = RETRY_BINDING): Promise<Context> {
  const ctx = new Context()
  const config = Config({
    mode: 'manager',
    storeDir,
    controlSocketPath: join(storeDir, 'control.sock'),
    managedCommandBindings: [binding],
  })
  await applyCron(ctx, config)
  return ctx
}

describe('manager-owned command bindings', () => {
  it('registers the exact configured binding before manager startup completes', async () => {
    const storeDir = tempDir()
    const ctx = await startManager(storeDir)
    try {
      const response = await createControlService({ storeDir })
        .getBoundCommand(RETRY_BINDING.externalRef)
      expect(response).toMatchObject({
        ok: true,
        operation: 'get-bound-command',
        snapshot: { activeJob: RETRY_BINDING },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('is idempotent across a real manager restart', async () => {
    const storeDir = tempDir()
    const first = await startManager(storeDir)
    await first.fiber.dispose()
    const rowsBefore = readFileSync(join(storeDir, 'jobs.jsonl'), 'utf8').trim().split('\n')

    const second = await startManager(storeDir)
    await second.fiber.dispose()
    const rowsAfter = readFileSync(join(storeDir, 'jobs.jsonl'), 'utf8').trim().split('\n')

    expect(rowsBefore).toHaveLength(1)
    expect(rowsAfter).toEqual(rowsBefore)
  })

  it('recreates a configured binding after an earlier tombstone', async () => {
    const storeDir = tempDir()
    const first = await startManager(storeDir)
    await first.fiber.dispose()
    const service = createControlService({ storeDir })
    await service.deleteBound(RETRY_BINDING.externalRef)

    const second = await startManager(storeDir)
    try {
      const response = await createControlService({ storeDir })
        .getBoundCommand(RETRY_BINDING.externalRef)
      expect(response).toMatchObject({
        ok: true,
        operation: 'get-bound-command',
        snapshot: { activeJob: RETRY_BINDING },
      })
    } finally {
      await second.fiber.dispose()
    }
  })

  it('fails startup closed when the external ref already has a different spec', async () => {
    const storeDir = tempDir()
    const service = createControlService({ storeDir })
    await service.ensureBoundCommand({
      ...RETRY_BINDING,
      schedule: { kind: 'interval', minutes: 10 },
    })
    const ctx = new Context()
    const config = Config({
      mode: 'manager',
      storeDir,
      controlSocketPath: join(storeDir, 'control.sock'),
      managedCommandBindings: [RETRY_BINDING],
    })
    await expect(applyCron(ctx, config)).rejects.toThrow(/managed command binding conflict/u)
    expect(existsSync(join(storeDir, 'control.sock'))).toBe(false)
    await ctx.fiber.dispose()
  })
})
