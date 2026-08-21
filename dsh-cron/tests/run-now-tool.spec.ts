import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { installRunNowTools, runNowRequestKey } from '../src/run-now-tool.ts'

type Tool = {
  readonly name: string
  readonly parameters: Record<string, unknown>
  execute(args: unknown, exec: unknown): Promise<unknown>
}

function agent(sessionId: string) {
  const tools = new Map<string, Tool>()
  const effects: Array<() => void> = []
  const scope = {
    tools: {
      register(definition: Tool): () => void {
        tools.set(definition.name, definition)
        return () => { tools.delete(definition.name) }
      },
    },
    effect(factory: () => void | (() => void)): () => void {
      const cleanup = factory() ?? (() => {})
      effects.push(cleanup)
      return () => {
        const index = effects.indexOf(cleanup)
        if (index >= 0) effects.splice(index, 1)
        cleanup()
      }
    },
  }
  return {
    session: { id: sessionId },
    ctx: scope,
    tools,
    dispose: () => { for (const cleanup of [...effects]) cleanup() },
  }
}

function context(roots: readonly ReturnType<typeof agent>[]) {
  const listeners = new Map<string, Set<(payload: { agent: unknown }) => void>>()
  return {
    agents: { roots: () => roots },
    on(name: string, listener: (payload: { agent: unknown }) => void): () => void {
      const bucket = listeners.get(name) ?? new Set()
      bucket.add(listener)
      listeners.set(name, bucket)
      return () => bucket.delete(listener)
    },
    emit(name: string, payload: { agent: unknown }): void {
      for (const listener of listeners.get(name) ?? []) listener(payload)
    },
  }
}

const targetSession = 'session-telegram'
const jobId = 'cron-exact'

function exec(target: ReturnType<typeof agent>, callId: string): Record<string, unknown> {
  return { agent: target, callId, signal: new AbortController().signal }
}

describe('Telegram run-now tool composition', () => {
  it('installs only on the exact Telegram root and removes existing/future tools on dispose', () => {
    const telegram = agent(targetSession)
    const cron = agent('session-cron-cron-exact')
    const web = agent('session-web')
    const ctx = context([telegram, cron, web])
    const cleanup = installRunNowTools(ctx as never, { runNow: vi.fn() }, targetSession)

    expect([...telegram.tools.keys()]).toEqual(['cron_run_now'])
    expect(cron.tools.has('cron_run_now')).toBe(false)
    expect(web.tools.has('cron_run_now')).toBe(false)

    const later = agent(targetSession)
    ctx.agents.roots = () => [telegram, cron, web, later]
    ctx.emit('agent/created', { agent: later })
    expect(later.tools.has('cron_run_now')).toBe(true)

    cleanup()
    expect(telegram.tools.has('cron_run_now')).toBe(false)
    expect(later.tools.has('cron_run_now')).toBe(false)
    const after = agent(targetSession)
    ctx.agents.roots = () => [after]
    ctx.emit('agent/created', { agent: after })
    expect(after.tools.has('cron_run_now')).toBe(false)
  })

  it('exposes only jobId, derives a stable key from the exact tool call, and never receives model parameters', async () => {
    const telegram = agent(targetSession)
    const ctx = context([telegram])
    const runNow = vi.fn(async () => ({ ok: true as const, runId: 'manual-run-1' }))
    const cleanup = installRunNowTools(ctx as never, { runNow }, targetSession)
    const tool = telegram.tools.get('cron_run_now')!

    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: { jobId: { type: 'string' } },
      required: ['jobId'],
    })
    expect(Object.keys((tool.parameters as { properties: Record<string, unknown> }).properties)).toEqual(['jobId'])
    const result = await tool.execute({ jobId }, exec(telegram, 'call-1'))

    expect(result).toMatchObject({ ok: true, code: 'accepted', runId: 'manual-run-1' })
    expect(runNow).toHaveBeenCalledWith({
      jobId,
      requestKey: createHash('sha256').update(`v1\0${targetSession}\0call-1\0${jobId}`).digest('hex'),
    })
    expect(runNowRequestKey('ab', 'c', 'd')).not.toBe(runNowRequestKey('a', 'bc', 'd'))
    expect(JSON.stringify(runNow.mock.calls[0])).not.toContain('prompt')
    expect(JSON.stringify(runNow.mock.calls[0])).not.toContain('schedule')
    cleanup()
  })

  it('reuses the same derived key for the same context call and rejects a foreign agent', async () => {
    const telegram = agent(targetSession)
    const foreign = agent('session-other')
    const ctx = context([telegram])
    const runNow = vi.fn(async () => ({ ok: true as const, alreadyAccepted: true as const, runId: 'manual-run-1' }))
    const cleanup = installRunNowTools(ctx as never, { runNow }, targetSession)
    const tool = telegram.tools.get('cron_run_now')!

    await tool.execute({ jobId }, exec(telegram, 'same-call'))
    await tool.execute({ jobId }, exec(telegram, 'same-call'))
    expect(runNow).toHaveBeenCalledTimes(2)
    expect(runNow.mock.calls[0]).toEqual(runNow.mock.calls[1])

    const foreignResult = await tool.execute({ jobId }, exec(foreign, 'same-call'))
    expect(foreignResult).toMatchObject({ ok: false, code: 'wrong_root' })
    expect(runNow).toHaveBeenCalledTimes(2)
    cleanup()
  })
})
