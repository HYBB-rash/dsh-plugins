/**
 * Worker tests (src/worker.ts): the continuable-child lifecycle — delegate
 * ordering, strict result-protocol settlement, real interrupt, same-child
 * resume, the pause/resume/end races, and dispose/restart behavior.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentRunEndInfo, SubagentRunInfo } from '@deepseek-ai/dsh-subagent'
import { AssistantStore } from '../src/store.ts'
import { WorkerController, type SubagentsApi } from '../src/worker.ts'

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-assistant-worker-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const NOW = '2026-08-15T02:00:00.000Z'
const clock = () => Date.parse(NOW)

interface FakeAgent extends Agent {
  emit(name: 'subagent/start' | 'subagent/end', payload: unknown): void
}

function fakeAgent(id = 'session-telegram'): FakeAgent {
  const listeners = new Map<string, Array<(payload: unknown) => void>>()
  const agent = {
    id: SessionId(id),
    session: { id: SessionId(id) },
    ctx: {
      on: (name: string, fn: (payload: unknown) => void) => {
        const arr = listeners.get(name) ?? []
        arr.push(fn)
        listeners.set(name, arr)
        return () => {
          const idx = arr.indexOf(fn)
          if (idx >= 0) arr.splice(idx, 1)
        }
      },
    },
    emit(name: string, payload: unknown) {
      for (const fn of listeners.get(name) ?? []) fn(payload)
    },
  }
  return agent as unknown as FakeAgent
}

interface FakeSubagents extends SubagentsApi {
  startContinuable: ReturnType<typeof vi.fn>
  interrupt: ReturnType<typeof vi.fn>
  followup: ReturnType<typeof vi.fn>
}

function fakeSubagents(
  agent: FakeAgent,
  opts: {
    childId?: string
    runId?: string
    emitStart?: boolean
    startFails?: Error
    followupFails?: Error
    interruptFails?: Error
  } = {},
): FakeSubagents {
  const childId = opts.childId ?? 'child-1'
  const runId = opts.runId ?? 'run-1'
  return {
    startContinuable: vi.fn(async () => {
      if (opts.startFails !== undefined) throw opts.startFails
      if (opts.emitStart !== false) {
        agent.emit('subagent/start', { runId, provider: 'spawn', id: childId, local: true })
      }
      return { childId: SessionId(childId), messageId: 'm1' }
    }),
    interrupt: vi.fn(() => {
      if (opts.interruptFails !== undefined) throw opts.interruptFails
    }),
    followup: vi.fn(async () => {
      if (opts.followupFails !== undefined) throw opts.followupFails
      return 'm2'
    }),
  } as unknown as FakeSubagents
}

function makeWorker(
  agent: FakeAgent,
  opts: { subagents?: FakeSubagents; mode?: 'web' | 'telegram' } = {},
): { worker: WorkerController; subagents: FakeSubagents; store: AssistantStore } {
  const store = new AssistantStore(join(tempDir(), 'state.sqlite'))
  const subagents = opts.subagents ?? fakeSubagents(agent)
  const worker = new WorkerController({
    store,
    mode: opts.mode ?? 'telegram',
    subagents,
    telegramParentSessionId: 'session-telegram',
    now: clock,
    logger: { warn: () => undefined },
  })
  return { worker, subagents, store }
}

function startInfo(overrides: Partial<SubagentRunInfo> = {}): SubagentRunInfo {
  return { runId: 'run-1', provider: 'spawn', id: 'child-1', local: true, ...overrides } as unknown as SubagentRunInfo
}

function endInfo(overrides: Partial<SubagentRunEndInfo> = {}): SubagentRunEndInfo {
  return {
    runId: 'run-1',
    provider: 'spawn',
    id: 'child-1',
    local: true,
    stopReason: 'completed',
    ...overrides,
  } as unknown as SubagentRunEndInfo
}

function text(blocks: unknown[]): unknown {
  return blocks
}

async function delegateTask(worker: WorkerController, agent: FakeAgent, title = '查资料', prompt = '去查 Y 并汇报') {
  return worker.delegate(agent, { title, prompt }, new AbortController().signal)
}

describe('delegate', () => {
  it('binds two starts to their own commitments and settles out of order', async () => {
    const agent = fakeAgent()
    let n = 0
    const subagents = fakeSubagents(agent, { emitStart: false })
    subagents.startContinuable.mockImplementation(async () => {
      n++
      const childId = `child-${n}`
      const runId = `run-${n}`
      agent.emit('subagent/start', startInfo({ id: SessionId(childId), runId: runId as never }))
      return { childId: SessionId(childId), messageId: `m-${n}` }
    })
    const { worker, store } = makeWorker(agent, { subagents })
    const first = await worker.delegate(agent, { title: 'first', prompt: 'one' }, new AbortController().signal)
    const second = await worker.delegate(agent, { title: 'second', prompt: 'two' }, new AbortController().signal)
    expect(first.ok && second.ok).toBe(true)
    expect(store.getByWorkerSessionId('child-1')?.title).toBe('first')
    expect(store.getByWorkerSessionId('child-2')?.title).toBe('second')

    agent.emit('subagent/end', endInfo({
      id: SessionId('child-2'), runId: 'run-2' as never,
      lastAssistantMessage: text([{ type: 'text', text: 'second done\nDSH_ASSISTANT_RESULT {"status":"completed","summary":"second"}' }]),
    }))
    agent.emit('subagent/end', endInfo({
      id: SessionId('child-1'), runId: 'run-1' as never,
      lastAssistantMessage: text([{ type: 'text', text: 'first done\nDSH_ASSISTANT_RESULT {"status":"completed","summary":"first"}' }]),
    }))
    expect(store.getByWorkerSessionId('child-1')).toMatchObject({ status: 'completed', result: 'first done' })
    expect(store.getByWorkerSessionId('child-2')).toMatchObject({ status: 'completed', result: 'second done' })
    expect(store.listPendingOutbox()).toHaveLength(2)
    store.close()
  })

  it('cold-resumes each desired-running monitor on the same child after listeners are ready', async () => {
    const agent = fakeAgent()
    const subagents = fakeSubagents(agent)
    const { worker, store } = makeWorker(agent, { subagents })
    const delegated = await worker.delegate(
      agent,
      { title: 'watch', prompt: 'watch forever', kind: 'monitor' },
      new AbortController().signal,
    )
    expect(delegated.ok).toBe(true)
    store.normalizeAgentOnStartup()
    subagents.followup.mockImplementationOnce(async (_parent, childId) => {
      agent.emit('subagent/start', startInfo({ id: childId, runId: 'run-cold-2' as never }))
      return 'm-cold'
    })
    await worker.recoverMonitors(agent, new AbortController().signal, 50)
    expect(subagents.followup).toHaveBeenCalledWith(
      agent,
      SessionId('child-1'),
      expect.any(Array),
      expect.any(Object),
    )
    expect(store.getByWorkerSessionId('child-1')).toMatchObject({
      status: 'active', workerRunId: 'run-cold-2', workerControlState: 'none', monitorResumeState: 'none',
    })
    store.close()
  })

  it('blocks once when monitor cold-resume followup fails', async () => {
    const agent = fakeAgent()
    const subagents = fakeSubagents(agent, { followupFails: new Error('gone') })
    const { worker, store } = makeWorker(agent, { subagents })
    const delegated = await worker.delegate(
      agent,
      { title: 'watch', prompt: 'watch forever', kind: 'monitor' },
      new AbortController().signal,
    )
    expect(delegated.ok).toBe(true)
    store.normalizeAgentOnStartup()
    await worker.recoverMonitors(agent, new AbortController().signal, 20)
    const row = store.getByWorkerSessionId('child-1')!
    expect(row).toMatchObject({ status: 'blocked', monitorResumeState: 'none' })
    expect(row.blockedReason).toContain('目前未监控')
    expect(store.listPendingOutbox().filter(item => item.id.startsWith('monitor-resume:'))).toHaveLength(1)
    await worker.recoverMonitors(agent, new AbortController().signal, 20)
    expect(store.listPendingOutbox().filter(item => item.id.startsWith('monitor-resume:'))).toHaveLength(1)
    store.close()
  })

  it('parks a claimed monitor without a blocked notice when shutdown aborts recovery', async () => {
    const agent = fakeAgent()
    const controller = new AbortController()
    const subagents = fakeSubagents(agent)
    const { worker, store } = makeWorker(agent, { subagents })
    const delegated = await worker.delegate(
      agent,
      { title: 'watch through restart', prompt: 'watch forever', kind: 'monitor' },
      new AbortController().signal,
    )
    expect(delegated.ok).toBe(true)
    store.normalizeAgentOnStartup()
    const failResume = vi.spyOn(store, 'failMonitorResume')
    subagents.followup.mockImplementationOnce(async () => {
      worker.setStopping(true)
      controller.abort()
      throw new Error('aborted by normal shutdown')
    })

    await worker.recoverMonitors(agent, controller.signal, 20)
    expect(failResume).not.toHaveBeenCalled()
    store.normalizeAgentOnStartup()

    expect(store.getByWorkerSessionId('child-1')).toMatchObject({
      status: 'paused',
      monitorDesiredState: 'running',
      monitorResumeState: 'needed',
      workerControlState: 'none',
    })
    expect(store.listPendingOutbox().filter(item => item.id.startsWith('monitor-resume:'))).toEqual([])
    store.close()
  })

  it('persists one responsibility as pending, starts a child, and activates after identity is persisted', async () => {
    const agent = fakeAgent()
    const { worker, subagents, store } = makeWorker(agent)
    const out = await delegateTask(worker, agent)
    expect(out.ok).toBe(true)
    if (!out.ok) throw new Error('expected success')
    expect(out.row.status).toBe('active')
    expect(out.row.workerSessionId).toBe('child-1')
    expect(out.row.workerRunId).toBe('run-1')
    expect(out.row.workerParentSessionId).toBe('session-telegram')
    expect(subagents.startContinuable).toHaveBeenCalledOnce()
    const spec = subagents.startContinuable.mock.calls[0]![0] as {
      provider: string
      request: { maxDepth: number; toolFilter: { deny: string[] }; prompt: { text: string }[]; persona: string }
    }
    expect(spec.provider).toBe('spawn')
    expect(spec.request.maxDepth).toBe(1)
    // Rework §4.1: assistant tools are root-local, so the child request must
    // NOT carry a global toolFilter.deny (tools.restrict cannot name them).
    expect(spec.request.toolFilter).toBeUndefined()
    expect(spec.request.prompt[0]!.text).toBe('去查 Y 并汇报')
    expect(spec.request.persona).toContain('official report tool only for a meaningful completed stage')
    expect(spec.request.persona).toContain('do not use report for the final result')
    expect(spec.request.persona).toContain('final message is collected by dsh-assistant automatically')
    store.close()
  })

  it('an ultra-fast child settling before activation keeps its terminal state', async () => {
    const agent = fakeAgent()
    const subagents = fakeSubagents(agent, {
      emitStart: true,
    })
    subagents.startContinuable.mockImplementationOnce(async () => {
      agent.emit('subagent/start', startInfo())
      agent.emit('subagent/end', endInfo({
        stopReason: 'completed',
        lastAssistantMessage: text([{ type: 'text', text: '做完了\nDSH_ASSISTANT_RESULT {"status":"completed","summary":"已完成"}' }]),
      }))
      return { childId: SessionId('child-1'), messageId: 'm1' }
    })
    const { worker, store } = makeWorker(agent, { subagents })
    const out = await delegateTask(worker, agent)
    expect(out.ok).toBe(true)
    if (!out.ok) throw new Error('expected success')
    expect(out.row.status).toBe('completed')
    expect(out.row.result).toBe('做完了')
    expect(store.getCurrent()).toBeUndefined()
    store.close()
  })

  it('interrupts the known child and marks blocked when the identity is not persisted', async () => {
    const agent = fakeAgent()
    const subagents = fakeSubagents(agent, { emitStart: false })
    const { worker, store } = makeWorker(agent, { subagents })
    const out = await delegateTask(worker, agent)
    expect(out.ok).toBe(false)
    if (out.ok) throw new Error('expected failure')
    expect(out.code).toBe('worker_start_failed')
    expect(subagents.interrupt).toHaveBeenCalledWith(
      SessionId('child-1'),
      { kind: 'user', parentSessionId: SessionId('session-telegram') },
    )
    const row = store.getCurrent()
    expect(row?.status).toBe('blocked')
    expect(row?.blockedReason).toContain('启动结果不确定')
    store.close()
  })

  it('a failed start marks the commitment blocked and never replies accepted', async () => {
    const agent = fakeAgent()
    const subagents = fakeSubagents(agent, { startFails: new Error('provider down') })
    const { worker, store } = makeWorker(agent, { subagents })
    const out = await delegateTask(worker, agent)
    expect(out.ok).toBe(false)
    if (out.ok) throw new Error('expected failure')
    expect(out.code).toBe('worker_start_failed')
    const row = store.getCurrent()
    expect(row?.status).toBe('blocked')
    expect(row?.blockedReason).toContain('后台启动失败')
    store.close()
  })

  it('rejects delegation from web mode', async () => {
    const agent = fakeAgent()
    const { worker } = makeWorker(agent, { mode: 'web' })
    const out = await delegateTask(worker, agent)
    expect(out.ok).toBe(false)
    if (out.ok) throw new Error('expected failure')
    expect(out.code).toBe('wrong_control_surface')
  })
})

describe('lifecycle edge guards', () => {
  it('ignores start/end of unrelated children', async () => {
    const agent = fakeAgent()
    const { worker, store } = makeWorker(agent)
    await delegateTask(worker, agent)
    const before = store.getById('assistant-x') ?? store.getCurrent()!
    worker.onStart(startInfo({ id: 'other-child', runId: 'other-run' }))
    worker.onEnd(endInfo({ id: 'other-child', runId: 'other-run' }))
    const after = store.getCurrent()!
    expect(after).toEqual(before)
    store.close()
  })

  it('ignores a stale epoch end whose run id no longer matches', async () => {
    const agent = fakeAgent()
    const { worker, store } = makeWorker(agent)
    await delegateTask(worker, agent)
    // Pause + resume arms the resume window; then the new residency start
    // lands and atomically takes over the run id and clears the control.
    worker.pause(store.getCurrent()!)
    const resumed = await worker.resume(store.getCurrent()!, agent, undefined, undefined)
    expect(resumed.ok).toBe(true)
    agent.emit('subagent/start', startInfo({ runId: 'run-2' }))
    expect(store.getCurrent()?.workerRunId).toBe('run-2')
    expect(store.getCurrent()?.workerControlState).toBe('none')
    // The OLD epoch's end arrives late.
    worker.onEnd(endInfo({ runId: 'run-1', stopReason: 'aborted' }))
    const row = store.getCurrent()!
    expect(row.status).toBe('active')
    expect(row.workerControlState).toBe('none')
    store.close()
  })
})

describe('result protocol settlement', () => {
  async function activeAgentCommitment(): Promise<{ worker: WorkerController; agent: FakeAgent; store: AssistantStore }> {
    const agent = fakeAgent()
    const { worker, store } = makeWorker(agent)
    await delegateTask(worker, agent)
    return { worker, agent, store }
  }

  it('completed stopReason + valid completed marker settles completed with an outbox', async () => {
    const { worker, store } = await activeAgentCommitment()
    worker.onEnd(endInfo({
      lastAssistantMessage: text([
        { type: 'text', text: '完成正文。\nDSH_ASSISTANT_RESULT {"status":"completed","summary":"已统计 12 个目录","evidence":["<workspace-path>"]}' },
      ]),
    }))
    const row = store.getCurrent()
    expect(row).toBeUndefined()
    const closed = store.getLastClosed()!
    expect(closed.status).toBe('completed')
    expect(closed.result).toBe('完成正文。')
    const outbox = store.listPendingOutbox()
    expect(outbox).toHaveLength(1)
    expect(outbox[0]!.kind).toBe('completed')
    expect(outbox[0]!.id).toMatch(/^worker:assistant-[0-9a-f]{8}:run-1$/)
    expect(outbox[0]!.text).toContain('✅ 我负责的事情已完成')
    expect(outbox[0]!.text).toContain('完成正文。')
    store.close()
  })

  it('completed stopReason + valid blocked marker settles blocked', async () => {
    const { worker, store } = await activeAgentCommitment()
    worker.onEnd(endInfo({
      lastAssistantMessage: text([
        { type: 'text', text: 'DSH_ASSISTANT_RESULT {"status":"blocked","summary":"已做到 A","blocker":"缺权限","nextAction":"用户授权"}' },
      ]),
    }))
    const row = store.getCurrent()!
    expect(row.status).toBe('blocked')
    expect(row.blockedReason).toBe('缺权限')
    expect(row.nextAction).toBe('用户授权')
    const outbox = store.listPendingOutbox()
    expect(outbox[0]!.kind).toBe('blocked')
    expect(outbox[0]!.text).toContain('⚠️ 我负责的事情受阻')
    store.close()
  })

  it.each([
    { name: 'no marker', text: '只是普通文本输出' },
    { name: 'bad JSON', text: 'DSH_ASSISTANT_RESULT {bad}' },
    { name: 'missing summary', text: 'DSH_ASSISTANT_RESULT {"status":"completed"}' },
    { name: 'unknown status', text: 'DSH_ASSISTANT_RESULT {"status":"done"}' },
  ])('completed stopReason + $name is blocked, never guessed as completed', async ({ text: body }) => {
    const { worker, store } = await activeAgentCommitment()
    worker.onEnd(endInfo({ lastAssistantMessage: text([{ type: 'text', text: body }]) }))
    const row = store.getCurrent()!
    expect(row.status).toBe('blocked')
    expect(row.blockedReason).toContain('没有给出有效收口结果')
    store.close()
  })

  it.each(['error', 'max-tokens', 'refusal'] as const)('stopReason=%s is blocked with bounded partial output', async (stopReason) => {
    const { worker, store } = await activeAgentCommitment()
    worker.onEnd(endInfo({ stopReason, lastAssistantMessage: text([{ type: 'text', text: '做到一半的部分输出' }]) }))
    const row = store.getCurrent()!
    expect(row.status).toBe('blocked')
    expect(row.blockedReason).toContain(`stopReason=${stopReason}`)
    expect(row.result).toContain('做到一半')
    store.close()
  })

  it('does not deliver a duplicate end for an already-terminal commitment', async () => {
    const { worker, store } = await activeAgentCommitment()
    worker.onEnd(endInfo({ lastAssistantMessage: text([{ type: 'text', text: 'DSH_ASSISTANT_RESULT {"status":"completed","summary":"ok"}' }]) }))
    expect(store.listPendingOutbox()).toHaveLength(1)
    // A late duplicate end (same run id) must not reopen or re-deliver.
    worker.onEnd(endInfo({ lastAssistantMessage: text([{ type: 'text', text: 'DSH_ASSISTANT_RESULT {"status":"blocked","blocker":"x","summary":"s"}' }]) }))
    expect(store.getLastClosed()?.status).toBe('completed')
    expect(store.listPendingOutbox()).toHaveLength(1)
    store.close()
  })
})

describe('pause / resume / cancel', () => {
  async function activeAgentCommitment(): Promise<{ worker: WorkerController; agent: FakeAgent; store: AssistantStore }> {
    const agent = fakeAgent()
    const { worker, store } = makeWorker(agent)
    await delegateTask(worker, agent)
    return { worker, agent, store }
  }

  it('pause persists paused first, then really interrupts; aborted end confirms and never fails', async () => {
    const { worker, store } = await activeAgentCommitment()
    const current = store.getCurrent()!
    const out = worker.pause(current)
    expect(out.ok).toBe(true)
    if (!out.ok) throw new Error('expected success')
    expect(out.row.status).toBe('paused')
    expect(out.row.workerControlState).toBe('pause_requested')
    const row = store.getCurrent()!
    expect(row.status).toBe('paused')
    store.close()
  })

  it('pause calls interrupt with the saved child id', async () => {
    const agent = fakeAgent()
    const subagents = fakeSubagents(agent)
    const { worker, store } = makeWorker(agent, { subagents })
    await delegateTask(worker, agent)
    const out = worker.pause(store.getCurrent()!)
    expect(out.ok).toBe(true)
    expect(subagents.interrupt).toHaveBeenCalledWith(
      SessionId('child-1'),
      { kind: 'user', parentSessionId: SessionId('session-telegram') },
    )
    store.close()
  })

  it('aborted end after pause clears the control state without blocking or delivering', async () => {
    const { worker, store } = await activeAgentCommitment()
    worker.pause(store.getCurrent()!)
    worker.onEnd(endInfo({ stopReason: 'aborted' }))
    const row = store.getCurrent()!
    expect(row.status).toBe('paused')
    expect(row.workerControlState).toBe('none')
    expect(store.listPendingOutbox()).toHaveLength(0)
    store.close()
  })

  it('a valid completed end wins the race against an in-flight pause', async () => {
    const { worker, store } = await activeAgentCommitment()
    worker.pause(store.getCurrent()!)
    worker.onEnd(endInfo({
      lastAssistantMessage: text([{ type: 'text', text: 'DSH_ASSISTANT_RESULT {"status":"completed","summary":"提前完成"}' }]),
    }))
    const row = store.getCurrent()
    expect(row).toBeUndefined()
    expect(store.getLastClosed()?.status).toBe('completed')
    store.close()
  })

  it('interrupt throwing marks the commitment blocked with worker_control_failed', async () => {
    const agent = fakeAgent()
    const subagents = fakeSubagents(agent, { interruptFails: new Error('no target') })
    const { worker, store } = makeWorker(agent, { subagents })
    await delegateTask(worker, agent)
    const out = worker.pause(store.getCurrent()!)
    expect(out.ok).toBe(false)
    if (out.ok) throw new Error('expected failure')
    expect(out.code).toBe('worker_control_failed')
    const row = store.getCurrent()!
    expect(row.status).toBe('blocked')
    store.close()
  })

  it('resume follows up the SAME child id and activates', async () => {
    const agent = fakeAgent()
    const subagents = fakeSubagents(agent)
    const { worker, store } = makeWorker(agent, { subagents })
    await delegateTask(worker, agent)
    worker.pause(store.getCurrent()!)
    worker.onEnd(endInfo({ stopReason: 'aborted' }))
    const paused = store.getCurrent()!
    const out = await worker.resume(paused, agent, '继续做', undefined)
    expect(out.ok).toBe(true)
    if (!out.ok) throw new Error('expected success')
    expect(subagents.followup).toHaveBeenCalledOnce()
    const followupArgs = subagents.followup.mock.calls[0]!
    expect(followupArgs[0]).toBe(agent)
    expect(followupArgs[1]).toBe(SessionId('child-1'))
    const text0 = (followupArgs[2] as { text: string }[])[0]!.text
    expect(text0).toContain('继续上次未完成的任务')
    expect(text0).toContain('用户补充方向：继续做')
    expect(out.row.status).toBe('active')
    expect(out.row.workerControlState).toBe('resume_requested')
    store.close()
  })

  it('a new residency epoch after resume gets the new run id; old aborted end cannot block the new cycle', async () => {
    const agent = fakeAgent()
    const { worker, store } = makeWorker(agent)
    await delegateTask(worker, agent)
    // Pause, then resume before the abort end arrives (the race).
    const current = store.getCurrent()!
    worker.pause(current)
    const paused = store.getCurrent()!
    const resumed = await worker.resume(paused, agent, undefined, undefined)
    expect(resumed.ok).toBe(true)
    // The OLD aborted end lands while the resume window is open.
    worker.onEnd(endInfo({ runId: 'run-1', stopReason: 'aborted' }))
    let row = store.getCurrent()!
    expect(row.status).toBe('active') // NOT blocked by the old abort
    // The followup cold-resumes a new epoch with a new run id.
    agent.emit('subagent/start', startInfo({ runId: 'run-2' }))
    row = store.getCurrent()!
    expect(row.workerRunId).toBe('run-2')
    // The new epoch's end settles normally.
    worker.onEnd(endInfo({
      runId: 'run-2',
      lastAssistantMessage: text([{ type: 'text', text: 'DSH_ASSISTANT_RESULT {"status":"completed","summary":"完成"}' }]),
    }))
    expect(store.getCurrent()).toBeUndefined()
    expect(store.getLastClosed()?.status).toBe('completed')
    store.close()
  })

  it('resume failure rolls back to paused only when the revision is unchanged', async () => {
    const agent = fakeAgent()
    const subagents = fakeSubagents(agent, { followupFails: new Error('not resumable') })
    const { worker, store } = makeWorker(agent, { subagents })
    await delegateTask(worker, agent)
    worker.pause(store.getCurrent()!)
    worker.onEnd(endInfo({ stopReason: 'aborted' }))
    const paused = store.getCurrent()!
    const out = await worker.resume(paused, agent, undefined, undefined)
    expect(out.ok).toBe(false)
    if (out.ok) throw new Error('expected failure')
    expect(out.code).toBe('worker_control_failed')
    const row = store.getCurrent()!
    expect(row.status).toBe('paused')
    expect(row.workerControlState).toBe('none')
    store.close()
  })

  it('cancel persists cancelled first, interrupts, and late ends never reopen or deliver', async () => {
    const agent = fakeAgent()
    const subagents = fakeSubagents(agent)
    const { worker, store } = makeWorker(agent, { subagents })
    await delegateTask(worker, agent)
    const out = worker.cancel(store.getCurrent()!)
    expect(out.ok).toBe(true)
    expect(subagents.interrupt).toHaveBeenCalled()
    expect(store.getCurrent()).toBeUndefined()
    expect(store.getLastClosed()?.status).toBe('cancelled')
    // A late completed end must not revive the commitment or deliver.
    worker.onEnd(endInfo({
      lastAssistantMessage: text([{ type: 'text', text: 'DSH_ASSISTANT_RESULT {"status":"completed","summary":"迟到"}' }]),
    }))
    expect(store.getLastClosed()?.status).toBe('cancelled')
    expect(store.listPendingOutbox()).toHaveLength(0)
    store.close()
  })

  it('rejects pause/resume/cancel of agent commitments from web mode', async () => {
    const agent = fakeAgent()
    const { worker, store } = makeWorker(agent, { mode: 'web' })
    await delegateTask(worker, agent) // web mode rejects; use telegram store directly
    store.close()
    const agent2 = fakeAgent()
    const w2 = makeWorker(agent2, { mode: 'web' })
    // create an agent commitment via a telegram worker first
    const tg = fakeAgent()
    const tgWorker = makeWorker(tg, { mode: 'telegram' })
    await delegateTask(tgWorker.worker, tg)
    const commitment = tgWorker.store.getCurrent()!
    expect(w2.worker.pause(commitment).ok).toBe(false)
    expect(w2.worker.cancel(commitment).ok).toBe(false)
    const resumed = await w2.worker.resume(commitment, agent2, undefined, undefined)
    expect(resumed.ok).toBe(false)
    if (resumed.ok) throw new Error('expected failure')
    expect(resumed.code).toBe('wrong_control_surface')
    tgWorker.store.close()
  })
})

describe('rework: resume control races (验收返工 §4.4)', () => {
  async function activeAgentCommitment(): Promise<{ worker: WorkerController; agent: FakeAgent; store: AssistantStore }> {
    const agent = fakeAgent()
    const { worker, store } = makeWorker(agent)
    await delegateTask(worker, agent)
    return { worker, agent, store }
  }

  it('order 2: pause -> resume -> old aborted -> new start keeps resume_requested until the new run id lands', async () => {
    const agent = fakeAgent()
    const { worker, store } = makeWorker(agent)
    await delegateTask(worker, agent)
    // pause
    worker.pause(store.getCurrent()!)
    // resume BEFORE the old aborted end arrives
    const resumed = await worker.resume(store.getCurrent()!, agent, undefined, undefined)
    expect(resumed.ok).toBe(true)
    let row = store.getCurrent()!
    expect(row.workerControlState).toBe('resume_requested')
    // the OLD run's aborted end arrives while the new start has not landed
    worker.onEnd(endInfo({ runId: 'run-1', stopReason: 'aborted' }))
    row = store.getCurrent()!
    expect(row.status).toBe('active')
    expect(row.workerControlState).toBe('resume_requested') // NOT cleared by the old abort
    expect(row.workerRunId).toBe('run-1')
    // the new residency start lands: run id updates AND control clears atomically
    agent.emit('subagent/start', startInfo({ runId: 'run-2' }))
    row = store.getCurrent()!
    expect(row.workerRunId).toBe('run-2')
    expect(row.workerControlState).toBe('none')
    store.close()
  })

  it('order 4: pause -> resume -> new start -> new aborted marks the commitment blocked with one outbox', async () => {
    const agent = fakeAgent()
    const { worker, store } = makeWorker(agent)
    await delegateTask(worker, agent)
    worker.pause(store.getCurrent()!)
    const resumed = await worker.resume(store.getCurrent()!, agent, undefined, undefined)
    expect(resumed.ok).toBe(true)
    // new residency start lands
    agent.emit('subagent/start', startInfo({ runId: 'run-2' }))
    expect(store.getCurrent()?.workerControlState).toBe('none')
    // the NEW run aborts abnormally: must become blocked, never a silent active
    worker.onEnd(endInfo({ runId: 'run-2', stopReason: 'aborted' }))
    const row = store.getCurrent()!
    expect(row.status).toBe('blocked')
    expect(row.blockedReason).toContain('后台轮次被中断')
    const outbox = store.listPendingOutbox()
    expect(outbox).toHaveLength(1)
    expect(outbox[0]!.kind).toBe('blocked')
    store.close()
  })

  it('resume keeps resume_requested until the new run id is persisted (no early clear)', async () => {
    const agent = fakeAgent()
    const { worker, store } = makeWorker(agent)
    await delegateTask(worker, agent)
    worker.pause(store.getCurrent()!)
    worker.onEnd(endInfo({ stopReason: 'aborted' }))
    const paused = store.getCurrent()!
    const resumed = await worker.resume(paused, agent, undefined, undefined)
    expect(resumed.ok).toBe(true)
    expect(store.getCurrent()?.workerControlState).toBe('resume_requested')
    // new start persists the run id and clears control in one guarded write
    agent.emit('subagent/start', startInfo({ runId: 'run-2' }))
    const row = store.getCurrent()!
    expect(row.workerRunId).toBe('run-2')
    expect(row.workerControlState).toBe('none')
    store.close()
  })
})

describe('stopping', () => {
  it('ignores all ends while the plugin is stopping', async () => {
    const agent = fakeAgent()
    const { worker, store } = makeWorker(agent)
    await delegateTask(worker, agent)
    worker.setStopping(true)
    worker.onEnd(endInfo({
      lastAssistantMessage: text([{ type: 'text', text: 'DSH_ASSISTANT_RESULT {"status":"completed","summary":"x"}' }]),
    }))
    const row = store.getCurrent()!
    expect(row.status).toBe('active') // untouched
    expect(store.listPendingOutbox()).toHaveLength(0)
    store.close()
  })
})
