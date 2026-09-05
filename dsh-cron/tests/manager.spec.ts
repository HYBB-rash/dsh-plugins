/**
 * Characterization tests for the manager tools (src/manager.ts).
 *
 * These lock the CURRENT V1 behavior of registerCronTools: exactly three
 * tools are registered per root-agent scope, create/list/delete semantics,
 * validation error codes, durable tombstones, random ids, and the
 * persistence_uncertain path when the append fails. All persistence uses an
 * isolated mkdtemp store directory.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { validateJsonSchemaValue, type ToolOutputDefinition } from '@deepseek-ai/dsh-tools'
import { registerCronTools } from '../src/manager.ts'
import { JobStore } from '../src/store.ts'

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cron-manager-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface ToolDef {
  name: string
  output: ToolOutputDefinition
  execute(args: unknown, exec: unknown): Promise<unknown>
}

/** Minimal fake: tools.register collects definitions; sessions.flush resolves. */
function fakeScope() {
  const tools = new Map<string, ToolDef>()
  const toolCtx = {
    tools: {
      register(def: ToolDef): () => void {
        tools.set(def.name, def)
        return () => {
          tools.delete(def.name)
        }
      },
    },
  }
  const rootCtx = {
    sessions: { flush: async () => undefined },
    logger: { warn: () => undefined },
  }
  return { tools, toolCtx, rootCtx }
}

const execSession = { agent: { session: {} } }

describe('registerCronTools', () => {
  it('registers exactly the three cron tools', async () => {
    const { tools, toolCtx, rootCtx } = fakeScope()
    const dispose = registerCronTools(rootCtx as never, toolCtx as never, new JobStore(tempDir()))
    expect([...tools.keys()].sort()).toEqual(['cron_create', 'cron_delete', 'cron_list'])
    dispose()
    expect(tools.size).toBe(0)
  })
})

describe('cron_create', () => {
  it('creates a job with a random cron-<id> and persists a create line', async () => {
    const dir = tempDir()
    const { tools, toolCtx, rootCtx } = fakeScope()
    registerCronTools(rootCtx as never, toolCtx as never, new JobStore(dir))
    const result = await tools.get('cron_create')!.execute(
      { prompt: 'say hi', schedule: { kind: 'interval', minutes: 5 }, deliver: 'silent' },
      execSession,
    )
    expect(result).toMatchObject({
      schedule: { kind: 'interval', minutes: 5 },
      prompt: 'say hi',
      deliver: 'silent',
    })
    expect((result as { id: string }).id).toMatch(/^cron-[0-9a-f]{8}$/)
    const folded = new JobStore(dir).fold()
    expect(folded.active.map(job => job.id)).toEqual([(result as { id: string }).id])
  })

  it('rejects an empty prompt with invalid_prompt', async () => {
    const { tools, toolCtx, rootCtx } = fakeScope()
    registerCronTools(rootCtx as never, toolCtx as never, new JobStore(tempDir()))
    const result = await tools.get('cron_create')!.execute({ prompt: '  ', schedule: { kind: 'interval', minutes: 5 } }, execSession)
    expect(result).toMatchObject({ code: 'invalid_prompt' })
  })

  it('rejects an unknown schedule kind with a schema validation error', async () => {
    const { tools, toolCtx, rootCtx } = fakeScope()
    registerCronTools(rootCtx as never, toolCtx as never, new JobStore(tempDir()))
    // The defineTool schema (kind oneOf) rejects unknown kinds before execute.
    await expect(tools.get('cron_create')!.execute({ prompt: 'hi', schedule: { kind: 'hourly' } }, execSession))
      .rejects.toThrow(/invalid arguments/)
  })

  it('rejects a malformed cron expression with cron_parse_error', async () => {
    const { tools, toolCtx, rootCtx } = fakeScope()
    registerCronTools(rootCtx as never, toolCtx as never, new JobStore(tempDir()))
    const result = await tools.get('cron_create')!.execute({ prompt: 'hi', schedule: { kind: 'cron', expr: '60 * * * *' } }, execSession)
    expect(result).toMatchObject({ code: 'cron_parse_error' })
  })

  it('rejects an invalid deliver channel with a schema validation error', async () => {
    const { tools, toolCtx, rootCtx } = fakeScope()
    registerCronTools(rootCtx as never, toolCtx as never, new JobStore(tempDir()))
    // The deliver enum rejects unknown channels before execute.
    await expect(tools.get('cron_create')!.execute({ prompt: 'hi', schedule: { kind: 'interval', minutes: 5 }, deliver: 'email' }, execSession))
      .rejects.toThrow(/invalid arguments/)
  })

  it('defaults deliver to the neutral delivery port', async () => {
    const { tools, toolCtx, rootCtx } = fakeScope()
    registerCronTools(rootCtx as never, toolCtx as never, new JobStore(tempDir()))
    const result = await tools.get('cron_create')!.execute({ prompt: 'hi', schedule: { kind: 'interval', minutes: 5 } }, execSession)
    expect(result).toMatchObject({ deliver: 'default' })
  })

  it('returns persistence_uncertain when the append fails', async () => {
    const dir = tempDir()
    // A regular file at the store path makes mkdirSync of the parent fail.
    const storePath = join(dir, 'blocked')
    writeFileSync(storePath, 'x', 'utf8')
    const { tools, toolCtx, rootCtx } = fakeScope()
    registerCronTools(rootCtx as never, toolCtx as never, new JobStore(storePath))
    const result = await tools.get('cron_create')!.execute(
      { prompt: 'hi', schedule: { kind: 'interval', minutes: 5 } },
      execSession,
    )
    expect(result).toMatchObject({ code: 'persistence_uncertain', operation: 'create' })
  })
})

describe('cron_list', () => {
  it('returns schema-valid rows with and without a persisted working directory', async () => {
    const store = new JobStore(tempDir())
    for (const job of [
      { id: 'cron-with-cwd', cwd: '/workspace' },
      { id: 'cron-without-cwd' },
    ]) {
      store.append({ op: 'create', ...job, schedule: { kind: 'interval', minutes: 5 }, prompt: 'report', deliver: 'default', createdAt: '2026-09-05T00:00:00.000Z' })
    }
    const { tools, toolCtx, rootCtx } = fakeScope()
    registerCronTools(rootCtx as never, toolCtx as never, store)
    const tool = tools.get('cron_list')!
    const result = await tool.execute({}, execSession)
    expect(result).toEqual([
      { id: 'cron-with-cwd', cwd: '/workspace', schedule: { kind: 'interval', minutes: 5 }, prompt: 'report', deliver: 'default', createdAt: '2026-09-05T00:00:00.000Z' },
      { id: 'cron-without-cwd', schedule: { kind: 'interval', minutes: 5 }, prompt: 'report', deliver: 'default', createdAt: '2026-09-05T00:00:00.000Z' },
    ])
    expect(validateJsonSchemaValue(tool.output.schema, result)).toEqual([])
  })

  it('lists active jobs in creation order', async () => {
    const dir = tempDir()
    const store = new JobStore(dir)
    store.append({ op: 'create', id: 'cron-a', schedule: { kind: 'interval', minutes: 5 }, prompt: 'a', deliver: 'default', createdAt: '2026-08-14T00:00:00.000Z' })
    store.append({ op: 'create', id: 'cron-b', schedule: { kind: 'once', runAt: '2026-08-20T00:00:00.000Z' }, prompt: 'b', deliver: 'silent', createdAt: '2026-08-14T00:00:01.000Z' })
    const { tools, toolCtx, rootCtx } = fakeScope()
    registerCronTools(rootCtx as never, toolCtx as never, store)
    const result = await tools.get('cron_list')!.execute({}, execSession)
    expect(result).toEqual([
      expect.objectContaining({ id: 'cron-a', prompt: 'a' }),
      expect.objectContaining({ id: 'cron-b', prompt: 'b', deliver: 'silent' }),
    ])
  })

  it('lists nothing for an empty log', async () => {
    const { tools, toolCtx, rootCtx } = fakeScope()
    registerCronTools(rootCtx as never, toolCtx as never, new JobStore(tempDir()))
    const result = await tools.get('cron_list')!.execute({}, execSession)
    expect(result).toEqual([])
  })
})

describe('cron_delete', () => {
  it('tombstones an existing job and removes it from the fold', async () => {
    const dir = tempDir()
    const store = new JobStore(dir)
    store.append({ op: 'create', id: 'cron-a', schedule: { kind: 'interval', minutes: 5 }, prompt: 'a', deliver: 'default', createdAt: '2026-08-14T00:00:00.000Z' })
    const { tools, toolCtx, rootCtx } = fakeScope()
    registerCronTools(rootCtx as never, toolCtx as never, store)
    const result = await tools.get('cron_delete')!.execute({ id: 'cron-a' }, execSession)
    expect(result).toEqual({ id: 'cron-a', deleted: true })
    const folded = new JobStore(dir).fold()
    expect(folded.active).toEqual([])
    expect(folded.seenIds).toEqual(['cron-a'])
  })

  it('reports job_not_found for an unknown id without appending', async () => {
    const dir = tempDir()
    const store = new JobStore(dir)
    const { tools, toolCtx, rootCtx } = fakeScope()
    registerCronTools(rootCtx as never, toolCtx as never, store)
    const result = await tools.get('cron_delete')!.execute({ id: 'cron-nope' }, execSession)
    expect(result).toEqual({ id: 'cron-nope', deleted: false, code: 'job_not_found' })
    expect(new JobStore(dir).fold().active).toEqual([])
  })

  it('cannot delete a manager-owned command binding', async () => {
    const dir = tempDir()
    const store = new JobStore(dir)
    store.append({
      op: 'create',
      kind: 'command',
      id: 'cron-managed',
      externalRef: 'dsh:notion-task-inbox:retry:v1',
      schedule: { kind: 'interval', minutes: 5 },
      command: {
        argv: ['/usr/bin/python3', '/home/herman/.dsh/workspace/automations/notion/notion_inbox_sync.py', '--retry-pending', '--json'],
        timeoutSeconds: 120,
        outputMaxBytes: 4096,
      },
      deliver: 'silent',
      cwd: '/home/herman/.dsh/workspace',
      createdAt: '2026-08-14T00:00:00.000Z',
    })
    const { tools, toolCtx, rootCtx } = fakeScope()
    registerCronTools(rootCtx as never, toolCtx as never, store)

    const result = await tools.get('cron_delete')!.execute({ id: 'cron-managed' }, execSession)

    expect(result).toEqual({ id: 'cron-managed', deleted: false, code: 'job_not_found' })
    expect(new JobStore(dir).fold().active).toEqual([
      expect.objectContaining({ id: 'cron-managed', kind: 'command' }),
    ])
  })

  it('rejects ids with surrounding whitespace', async () => {
    const { tools, toolCtx, rootCtx } = fakeScope()
    registerCronTools(rootCtx as never, toolCtx as never, new JobStore(tempDir()))
    const result = await tools.get('cron_delete')!.execute({ id: ' cron-a ' }, execSession)
    expect(result).toMatchObject({ code: 'invalid_schedule' })
  })
})
