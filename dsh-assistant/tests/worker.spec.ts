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
import { buildMonitorRoundPrompt, WorkerController, type SubagentsApi } from '../src/worker.ts'

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
  opts: { subagents?: FakeSubagents; mode?: 'web' | 'telegram'; abortInFlight?: (commitmentId: string) => void } = {},
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
    ...opts.abortInFlight === undefined ? {} : { abortInFlight: opts.abortInFlight },
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
    const recoveryPrompt = (subagents.followup.mock.calls[0]![2] as { text: string }[])[0]!.text
    expect(recoveryPrompt).toContain('monitor_direction:\nwatch forever')
    expect(recoveryPrompt).toContain('confirmed checkpoint:\nnull')
    expect(recoveryPrompt).toContain('只等待并处理第一个新事件')
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
    // A blocked monitor round is no longer a live child. Its identity is
    // cleared atomically so an explicit resume can claim a fresh child.
    const row = store.getCurrent()!
    expect(row).toMatchObject({ status: 'blocked', monitorResumeState: 'none', workerSessionId: null })
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
    if (!delegated.ok) throw new Error('expected monitor delegation')
    const commitmentId = delegated.row.id
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

    // The claimed resume was interrupted during shutdown. Startup must not
    // reuse that uncertain control window or stale child identity; it leaves
    // an active fresh-needed monitor that the next runtime can claim safely.
    expect(store.getById(commitmentId)).toMatchObject({
      status: 'active',
      monitorDesiredState: 'running',
      monitorResumeState: 'needed',
      workerControlState: 'none',
      workerSessionId: null,
      workerRunId: null,
    })
    worker.setStopping(false)
    await worker.continueMonitors(agent, new AbortController().signal)
    expect(store.getById(commitmentId)).toMatchObject({
      status: 'active',
      monitorDesiredState: 'running',
      monitorResumeState: 'none',
      workerSessionId: 'child-1',
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

  it('interrupts a known child when an initial monitor start resolves after cancel', async () => {
    const agent = fakeAgent()
    const subagents = fakeSubagents(agent, { emitStart: false })
    let releaseStart!: (value: { childId: SessionId; messageId: string }) => void
    subagents.startContinuable.mockImplementationOnce(() => new Promise(resolve => {
      releaseStart = resolve
    }))
    const { worker, store } = makeWorker(agent, { subagents })
    const delegatePromise = worker.delegate(
      agent,
      { title: '初始监控取消竞态', prompt: '完整方向', kind: 'monitor' },
      new AbortController().signal,
    )
    await Promise.resolve()
    const current = store.getCurrent()!
    const cancelled = worker.cancel(current)
    expect(cancelled.ok).toBe(true)
    expect(store.getById(current.id)?.status).toBe('cancelled')

    releaseStart({ childId: SessionId('late-child'), messageId: 'late-message' })
    const delegated = await delegatePromise
    expect(delegated).toMatchObject({ ok: true, row: { status: 'cancelled' } })
    expect(subagents.interrupt).toHaveBeenCalledWith(
      SessionId('late-child'),
      { kind: 'user', parentSessionId: SessionId('session-telegram') },
    )

    worker.onEnd(endInfo({
      id: SessionId('late-child'), runId: 'late-run',
      lastAssistantMessage: text([{ type: 'text', text: '迟到结果\nDSH_ASSISTANT_RESULT {"status":"completed","summary":"不应生效"}' }]),
    }))
    expect(store.getLastClosed()?.status).toBe('cancelled')
    expect(store.listPendingOutbox()).toEqual([])
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

  it('rejects monitor event fields on a delegated completion instead of silently ignoring them', async () => {
    const { worker, store } = await activeAgentCommitment()
    worker.onEnd(endInfo({
      lastAssistantMessage: text([
        { type: 'text', text: '委派结果\nDSH_ASSISTANT_RESULT {"status":"completed","summary":"完成","eventKey":"not-for-delegated","checkpoint":"not-for-delegated"}' },
      ]),
    }))
    const row = store.getCurrent()!
    expect(row).toMatchObject({ status: 'blocked' })
    expect(row.blockedReason).toContain('delegated completion must not include monitor event fields')
    expect(store.listPendingOutbox()).toHaveLength(1)
    expect(store.listPendingOutbox()[0]!.kind).toBe('blocked')
    store.close()
  })

  it('blocks a monitor completed marker that omits eventKey and checkpoint', async () => {
    const agent = fakeAgent()
    const { worker, store } = makeWorker(agent)
    const delegated = await worker.delegate(
      agent,
      { title: '缺少事件字段', prompt: '完整方向', kind: 'monitor' },
      new AbortController().signal,
    )
    expect(delegated.ok).toBe(true)
    worker.onEnd(endInfo({
      lastAssistantMessage: text([
        { type: 'text', text: '监控结果\nDSH_ASSISTANT_RESULT {"status":"completed","summary":"有摘要但没有事件字段"}' },
      ]),
    }))
    const row = store.getCurrent()!
    expect(row).toMatchObject({ status: 'blocked', workerSessionId: null })
    expect(row.blockedReason).toContain('monitor completion requires eventKey and checkpoint')
    expect(store.listPendingOutbox()[0]!.kind).toBe('blocked')
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

describe('monitor round lifecycle', () => {
  it('keeps checkpoint and failed keys round-trippable in the full prompt snapshot', () => {
    const checkpoint = 'cursor,with\nnewline-多字节'
    const keys = ['event,one', 'event\ntwo-多字节']
    const prompt = buildMonitorRoundPrompt({
      direction: '完整方向',
      checkpoint,
      failedOrUncertainEventKeys: keys,
    })
    expect(prompt).toContain(`confirmed checkpoint:\n${JSON.stringify(checkpoint)}`)
    expect(prompt).toContain(`已有 failed/uncertain event keys:\n${JSON.stringify(keys)}`)
    expect(prompt).not.toContain(`confirmed checkpoint:\n${checkpoint}`)
    expect(prompt).not.toContain(`已有 failed/uncertain event keys:\n${keys.join(', ')}`)
    const lines = prompt.split('\n')
    const checkpointLine = lines[lines.indexOf('confirmed checkpoint:') + 1]!
    const keysLine = lines[lines.indexOf('已有 failed/uncertain event keys:') + 1]!
    expect(JSON.parse(checkpointLine)).toBe(checkpoint)
    expect(JSON.parse(keysLine)).toEqual(keys)
  })

  it('disambiguates the monitor protocol in the child persona and first prompt', async () => {
    const agent = fakeAgent()
    const { worker, subagents, store } = makeWorker(agent)
    const delegated = await worker.delegate(
      agent,
      { title: 'persona monitor', prompt: '完整方向', kind: 'monitor' },
      new AbortController().signal,
    )
    expect(delegated.ok).toBe(true)
    const request = subagents.startContinuable.mock.calls[0]![0] as {
      request: { prompt: Array<{ text: string }>; persona: string }
    }
    expect(request.request.prompt[0]!.text).toContain('eventKey')
    expect(request.request.prompt[0]!.text).toContain('checkpoint')
    expect(request.request.persona).toContain('ordinary delegated work')
    expect(request.request.persona).toContain('declares a monitor round')
    expect(request.request.persona).toContain('both eventKey and checkpoint')
    store.close()
  })

  it('settles one event first, then only the next runtime tick starts a fresh round', async () => {
    const agent = fakeAgent()
    const subagents = fakeSubagents(agent)
    let starts = 0
    subagents.startContinuable.mockImplementation(async () => {
      starts++
      const childId = `child-${starts}`
      const runId = `run-${starts}`
      agent.emit('subagent/start', startInfo({ id: SessionId(childId), runId: runId as never }))
      return { childId: SessionId(childId), messageId: `m-${starts}` }
    })
    const { worker, store } = makeWorker(agent, { subagents })
    const delegated = await worker.delegate(
      agent,
      { title: '持续监控', prompt: '按方向等待下一个事件并回报', kind: 'monitor' },
      new AbortController().signal,
    )
    expect(delegated.ok).toBe(true)
    const firstPrompt = (subagents.startContinuable.mock.calls[0]![0] as { request: { prompt: { text: string }[] } }).request.prompt[0]!.text
    expect(firstPrompt).toContain('monitor_direction:\n按方向等待下一个事件并回报')
    expect(firstPrompt).toContain('confirmed checkpoint:\nnull')
    expect(firstPrompt).toContain('只等待并处理第一个新事件')

    worker.onEnd(endInfo({
      lastAssistantMessage: text([{
        type: 'text',
        text: '发现一个新事件。\nDSH_ASSISTANT_RESULT {"status":"completed","summary":"发现新事件","eventKey":"stable-event-1","checkpoint":"checkpoint-1"}',
      }]),
    }))
    // The worker result only creates the event outbox. It must not start the
    // next child before the outbox reaches a terminal delivery state.
    const row = store.getCurrent()!
    expect(row).toMatchObject({
      status: 'active',
      kind: 'monitor',
      monitorDesiredState: 'running',
    })
    expect(store.listPendingOutbox()).toHaveLength(1)
    expect(store.listPendingOutbox()[0]!.kind).toBe('monitor_event')
    expect(starts).toBe(1)

    const event = store.listPendingOutbox()[0]!
    store.finishOutbox(event.id, 'delivered', { deliveredAt: NOW })
    expect(starts).toBe(1)

    // ReminderRuntime invokes this worker seam after its outbox pump. The
    // claim is serialized by store state, so a second controller is harmless.
    await worker.continueMonitors(agent, new AbortController().signal)
    expect(starts).toBe(2)
    store.close()
  })

  it('interrupts a known fresh child when the monitor is cancelled before start returns', async () => {
    const agent = fakeAgent()
    const subagents = fakeSubagents(agent)
    let starts = 0
    let releaseStart!: (value: { childId: SessionId; messageId: string }) => void
    subagents.startContinuable.mockImplementation(async () => {
      starts++
      if (starts === 1) {
        agent.emit('subagent/start', startInfo({ id: SessionId('child-1'), runId: 'run-1' as never }))
        return { childId: SessionId('child-1'), messageId: 'm-1' }
      }
      return new Promise(resolve => {
        releaseStart = resolve
      })
    })
    const { worker, store } = makeWorker(agent, { subagents })
    const delegated = await worker.delegate(
      agent,
      { title: '取消 fresh 竞态', prompt: '完整方向', kind: 'monitor' },
      new AbortController().signal,
    )
    expect(delegated.ok).toBe(true)
    worker.onEnd(endInfo({
      lastAssistantMessage: text([{ type: 'text', text: '事件\nDSH_ASSISTANT_RESULT {"status":"completed","summary":"事件","eventKey":"cancel-fresh","checkpoint":"cp-1"}' }]),
    }))
    const event = store.listPendingOutbox()[0]!
    store.finishOutbox(event.id, 'delivered', { deliveredAt: NOW })

    const continuation = worker.continueMonitors(agent, new AbortController().signal)
    await Promise.resolve()
    expect(starts).toBe(2)
    const current = store.getCurrent()!
    const cancelled = worker.cancel(current)
    expect(cancelled.ok).toBe(true)
    expect(store.getById(current.id)?.status).toBe('cancelled')

    releaseStart({ childId: SessionId('child-2'), messageId: 'm-2' })
    await continuation
    expect(subagents.interrupt).toHaveBeenCalledWith(
      SessionId('child-2'),
      { kind: 'user', parentSessionId: SessionId('session-telegram') },
    )
    expect(store.getCurrent()).toBeUndefined()
    worker.onEnd(endInfo({
      id: SessionId('child-2'), runId: 'run-2',
      lastAssistantMessage: text([{ type: 'text', text: '迟到 fresh 结果\nDSH_ASSISTANT_RESULT {"status":"completed","summary":"不应生效","eventKey":"late","checkpoint":"late"}' }]),
    }))
    expect(store.getLastClosed()?.status).toBe('cancelled')
    expect(store.listPendingOutbox()).toEqual([])
    store.close()
  })

  it('blocks a fresh identity mismatch when interrupting the known child throws', async () => {
    const agent = fakeAgent()
    const subagents = fakeSubagents(agent, { interruptFails: new Error('interrupt unavailable') })
    let starts = 0
    let releaseStart!: (value: { childId: SessionId; messageId: string }) => void
    subagents.startContinuable.mockImplementation(async () => {
      starts++
      if (starts === 1) {
        agent.emit('subagent/start', startInfo({ id: SessionId('child-1'), runId: 'run-1' as never }))
        return { childId: SessionId('child-1'), messageId: 'm-1' }
      }
      if (starts === 2) {
        return new Promise(resolve => {
          releaseStart = () => {
            agent.emit('subagent/start', startInfo({ id: SessionId('child-2'), runId: 'run-2' as never }))
            resolve({ childId: SessionId('child-2'), messageId: 'm-2' })
          }
        })
      }
      const childId = `child-${starts}`
      const runId = `run-${starts}`
      agent.emit('subagent/start', startInfo({ id: SessionId(childId), runId: runId as never }))
      return { childId: SessionId(childId), messageId: `m-${starts}` }
    })
    const { worker, store } = makeWorker(agent, { subagents })
    const delegated = await worker.delegate(
      agent,
      { title: 'fresh 身份不确定', prompt: '旧方向', kind: 'monitor' },
      new AbortController().signal,
    )
    expect(delegated.ok).toBe(true)
    worker.onEnd(endInfo({
      lastAssistantMessage: text([{ type: 'text', text: '事件\nDSH_ASSISTANT_RESULT {"status":"completed","summary":"事件","eventKey":"mismatch","checkpoint":"cp-1"}' }]),
    }))
    const event = store.listPendingOutbox()[0]!
    store.finishOutbox(event.id, 'delivered', { deliveredAt: NOW })

    const continuation = worker.continueMonitors(agent, new AbortController().signal)
    await Promise.resolve()
    const claimed = store.getCurrent()!
    expect(claimed).toMatchObject({ status: 'active', monitorResumeState: 'claimed', workerControlState: 'resume_requested' })

    // Direction replacement invalidates the in-flight claim before its start
    // event arrives. The returned child is therefore an identity mismatch.
    const replaced = await worker.replaceMonitorDirection(
      claimed,
      agent,
      '新方向',
      new AbortController().signal,
    )
    expect(replaced.ok).toBe(true)
    expect(store.getCurrent()).toMatchObject({
      status: 'active', monitorDirection: '新方向', monitorResumeState: 'needed',
      workerControlState: 'none', workerSessionId: null,
    })

    releaseStart({ childId: SessionId('child-2'), messageId: 'm-2' })
    await continuation
    expect(subagents.interrupt).toHaveBeenCalledWith(
      SessionId('child-2'),
      { kind: 'user', parentSessionId: SessionId('session-telegram') },
    )
    expect(store.getCurrent()).toMatchObject({
      status: 'blocked', monitorResumeState: 'none', workerControlState: 'none', workerSessionId: null,
    })
    await worker.continueMonitors(agent, new AbortController().signal)
    expect(starts).toBe(2)
    store.close()
  })

  it('keeps a direction-replaced fresh mismatch needed when interrupt succeeds', async () => {
    const agent = fakeAgent()
    const subagents = fakeSubagents(agent)
    let starts = 0
    let releaseStart!: (value: { childId: SessionId; messageId: string }) => void
    subagents.startContinuable.mockImplementation(async () => {
      starts++
      if (starts === 1) {
        agent.emit('subagent/start', startInfo({ id: SessionId('child-1'), runId: 'run-1' as never }))
        return { childId: SessionId('child-1'), messageId: 'm-1' }
      }
      if (starts === 2) {
        return new Promise(resolve => {
          releaseStart = () => {
            agent.emit('subagent/start', startInfo({ id: SessionId('child-2'), runId: 'run-2' as never }))
            resolve({ childId: SessionId('child-2'), messageId: 'm-2' })
          }
        })
      }
      const childId = `child-${starts}`
      const runId = `run-${starts}`
      agent.emit('subagent/start', startInfo({ id: SessionId(childId), runId: runId as never }))
      return { childId: SessionId(childId), messageId: `m-${starts}` }
    })
    const { worker, store } = makeWorker(agent, { subagents })
    const delegated = await worker.delegate(
      agent,
      { title: 'fresh 身份重绑', prompt: '旧方向', kind: 'monitor' },
      new AbortController().signal,
    )
    expect(delegated.ok).toBe(true)
    worker.onEnd(endInfo({
      lastAssistantMessage: text([{ type: 'text', text: '事件\nDSH_ASSISTANT_RESULT {"status":"completed","summary":"事件","eventKey":"mismatch-success","checkpoint":"cp-1"}' }]),
    }))
    const event = store.listPendingOutbox()[0]!
    store.finishOutbox(event.id, 'delivered', { deliveredAt: NOW })

    const continuation = worker.continueMonitors(agent, new AbortController().signal)
    await Promise.resolve()
    const claimed = store.getCurrent()!
    const replaced = await worker.replaceMonitorDirection(
      claimed,
      agent,
      '新方向',
      new AbortController().signal,
    )
    expect(replaced.ok).toBe(true)
    expect(store.getCurrent()).toMatchObject({
      status: 'active', monitorDirection: '新方向', monitorResumeState: 'needed',
      workerControlState: 'none', workerSessionId: null,
    })

    releaseStart({ childId: SessionId('child-2'), messageId: 'm-2' })
    await continuation
    expect(subagents.interrupt).toHaveBeenCalledWith(
      SessionId('child-2'),
      { kind: 'user', parentSessionId: SessionId('session-telegram') },
    )
    expect(store.getCurrent()).toMatchObject({
      status: 'active', monitorDirection: '新方向', monitorResumeState: 'needed',
      workerControlState: 'none', workerSessionId: null,
    })
    expect(store.listPendingOutbox()).toEqual([])

    await worker.continueMonitors(agent, new AbortController().signal)
    expect(starts).toBe(3)
    expect(store.getCurrent()).toMatchObject({
      status: 'active', monitorDirection: '新方向', workerSessionId: 'child-3', monitorResumeState: 'none',
    })
    const prompt = (subagents.startContinuable.mock.calls[2]![0] as { request: { prompt: { text: string }[] } }).request.prompt[0]!.text
    expect(prompt).toContain('monitor_direction:\n新方向')
    store.close()
  })

  it('settles an initial monitor event synchronously before startContinuable resolves', async () => {
    const agent = fakeAgent()
    const subagents = fakeSubagents(agent)
    let starts = 0
    subagents.startContinuable.mockImplementation(async () => {
      starts++
      const childId = `child-${starts}`
      const runId = `run-${starts}`
      agent.emit('subagent/start', startInfo({ id: SessionId(childId), runId: runId as never }))
      if (starts === 1) {
        agent.emit('subagent/end', endInfo({
          id: SessionId(childId), runId: runId as never,
          lastAssistantMessage: text([{ type: 'text', text: '首轮事件\nDSH_ASSISTANT_RESULT {"status":"completed","summary":"首轮事件","eventKey":"initial-event","checkpoint":"cp-1"}' }]),
        }))
      }
      return { childId: SessionId(childId), messageId: `m-${starts}` }
    })
    const { worker, store } = makeWorker(agent, { subagents })
    const delegated = await worker.delegate(
      agent,
      { title: '初始同步监控', prompt: '完整方向', kind: 'monitor' },
      new AbortController().signal,
    )
    expect(delegated.ok).toBe(true)
    expect(store.getCurrent()).toMatchObject({
      status: 'active', monitorDesiredState: 'running', monitorResumeState: 'none',
      workerSessionId: null, workerRunId: null, workerParentSessionId: null,
    })
    expect(store.listPendingOutbox()).toMatchObject([{ kind: 'monitor_event' }])
    expect(store.listPendingOutbox()).toHaveLength(1)
    expect(starts).toBe(1)

    const event = store.listPendingOutbox()[0]!
    store.finishOutbox(event.id, 'delivered', { deliveredAt: NOW })
    await worker.continueMonitors(agent, new AbortController().signal)
    expect(starts).toBe(2)
    expect(store.getCurrent()).toMatchObject({ status: 'active', workerSessionId: 'child-2' })
    store.close()
  })

  it('does not block when a fresh child reports an already-settled event key synchronously', async () => {
    const agent = fakeAgent()
    const subagents = fakeSubagents(agent)
    let starts = 0
    subagents.startContinuable.mockImplementation(async () => {
      starts++
      const childId = 'child-' + starts
      const runId = 'run-' + starts
      agent.emit('subagent/start', startInfo({ id: SessionId(childId), runId: runId as never }))
      return { childId: SessionId(childId), messageId: 'm-' + starts }
    })
    const { worker, store } = makeWorker(agent, { subagents })
    const delegated = await worker.delegate(
      agent,
      { title: '重复事件', prompt: '完整方向', kind: 'monitor' },
      new AbortController().signal,
    )
    expect(delegated.ok).toBe(true)
    worker.onEnd(endInfo({
      lastAssistantMessage: text([{ type: 'text', text: '首次\nDSH_ASSISTANT_RESULT {"status":"completed","summary":"首次","eventKey":"same-key","checkpoint":"cp-1"}' }]),
    }))
    const firstEvent = store.listPendingOutbox()[0]!
    store.finishOutbox(firstEvent.id, 'delivered', { deliveredAt: NOW })
    await worker.continueMonitors(agent, new AbortController().signal)
    expect(starts).toBe(2)

    // The second child sees the same business event. The store's idempotent
    // monitor-event settlement detaches it and requests another round; the
    // fresh-start seam must recognize that synchronous end as success rather
    // than treating the unbound identity as a failed spawn.
    worker.onEnd(endInfo({
      id: SessionId('child-2'),
      runId: 'run-2',
      lastAssistantMessage: text([{ type: 'text', text: '重复\nDSH_ASSISTANT_RESULT {"status":"completed","summary":"重复","eventKey":"same-key","checkpoint":"cp-1"}' }]),
    }))
    const row = store.getCurrent()!
    expect(row).toMatchObject({
      status: 'active',
      monitorDesiredState: 'running',
      monitorResumeState: 'needed',
      workerSessionId: null,
    })
    expect(store.listPendingOutbox().filter(item => item.kind === 'blocked')).toHaveLength(0)
    await worker.continueMonitors(agent, new AbortController().signal)
    expect(starts).toBe(3)
    expect(store.getCurrent()?.status).toBe('active')
    store.close()
  })

  it('builds the next child from the full direction/checkpoint/failed-key snapshot', async () => {
    const agent = fakeAgent()
    const subagents = fakeSubagents(agent)
    let starts = 0
    subagents.startContinuable.mockImplementation(async spec => {
      starts++
      const childId = `child-${starts}`
      const runId = `run-${starts}`
      agent.emit('subagent/start', startInfo({ id: SessionId(childId), runId: runId as never }))
      return { childId: SessionId(childId), messageId: `m-${starts}` }
    })
    const { worker, store } = makeWorker(agent, { subagents })
    const delegated = await worker.delegate(
      agent,
      { title: '持续监控', prompt: '完整方向：只看这个 workspace', kind: 'monitor' },
      new AbortController().signal,
    )
    expect(delegated.ok).toBe(true)
    worker.onEnd(endInfo({
      lastAssistantMessage: text([{
        type: 'text',
        text: '第一事件\nDSH_ASSISTANT_RESULT {"status":"completed","summary":"第一事件","eventKey":"opaque-event-a","checkpoint":"confirmed-1"}',
      }]),
    }))
    const event = store.listPendingOutbox()[0]!
    store.finishOutbox(event.id, 'delivered', { deliveredAt: NOW })
    await worker.continueMonitors(agent, new AbortController().signal)
    expect(starts).toBe(2)
    worker.onEnd(endInfo({
      id: SessionId('child-2'),
      runId: 'run-2',
      lastAssistantMessage: text([{
        type: 'text',
        text: '业务正文不应进入下一轮 prompt。\nDSH_ASSISTANT_RESULT {"status":"completed","summary":"事件正文-不应注入","eventKey":"opaque-event-b","checkpoint":"confirmed-2"}',
      }]),
    }))
    const failedEvent = store.listPendingOutbox()[0]!
    store.finishOutbox(failedEvent.id, 'failed', { error: 'telegram unavailable' })
    await worker.continueMonitors(agent, new AbortController().signal)
    expect(starts).toBe(3)
    const prompt = (subagents.startContinuable.mock.calls[2]![0] as { request: { prompt: { text: string }[] } }).request.prompt[0]!.text
    expect(prompt).toContain('完整方向：只看这个 workspace')
    expect(prompt).toContain('confirmed checkpoint:\n"confirmed-1"')
    expect(prompt).toContain('已有 failed/uncertain event keys:\n["opaque-event-b"]')
    expect(prompt).not.toContain('事件正文-不应注入')
    expect(prompt).toContain('只等待并处理第一个新事件')
    expect(prompt).toContain('eventKey 必须是稳定、不透明')
    expect(prompt).toContain('checkpoint')
    store.close()
  })

  it('persists direction before interrupt, confirms the old stop, then starts a fresh child', async () => {
    const agent = fakeAgent()
    const subagents = fakeSubagents(agent)
    let starts = 0
    subagents.startContinuable.mockImplementation(async spec => {
      starts++
      const childId = `child-${starts}`
      const runId = `run-${starts}`
      agent.emit('subagent/start', startInfo({ id: SessionId(childId), runId: runId as never }))
      return { childId: SessionId(childId), messageId: `m-${starts}` }
    })
    const { worker, store } = makeWorker(agent, { subagents })
    const delegated = await worker.delegate(
      agent,
      { title: '方向替换', prompt: '旧方向', kind: 'monitor' },
      new AbortController().signal,
    )
    expect(delegated.ok).toBe(true)
    const before = store.getCurrent()!
    const replaced = await worker.replaceMonitorDirection(
      before,
      agent,
      '完整新方向',
      new AbortController().signal,
    )
    expect(replaced.ok).toBe(true)
    expect(subagents.interrupt).toHaveBeenCalledWith(
      SessionId('child-1'),
      { kind: 'user', parentSessionId: SessionId('session-telegram') },
    )
    let row = store.getById(before.id)!
    expect(row).toMatchObject({
      monitorDirection: '完整新方向',
      status: 'active',
      monitorDesiredState: 'running',
      workerControlState: 'pause_requested',
      workerSessionId: 'child-1',
      workerRunId: 'run-1',
    })
    expect(starts).toBe(1)

    // The old run's result is discarded; only its matching terminal event
    // clears the binding and exposes the fresh-needed state.
    worker.onEnd(endInfo({
      id: SessionId('child-1'),
      runId: 'run-1',
      lastAssistantMessage: text([{
        type: 'text',
        text: '迟到旧正文\nDSH_ASSISTANT_RESULT {"status":"completed","summary":"旧事件","eventKey":"old-key","checkpoint":"old-checkpoint"}',
      }]),
    }))
    row = store.getById(before.id)!
    expect(row).toMatchObject({
      status: 'active',
      monitorDesiredState: 'running',
      monitorResumeState: 'needed',
      workerControlState: 'none',
      workerSessionId: null,
      workerRunId: null,
    })
    expect(store.listPendingOutbox()).toEqual([])

    await worker.continueMonitors(agent, new AbortController().signal)
    expect(starts).toBe(2)
    // A duplicate late event from the old identity has no lookup and no side effect.
    worker.onEnd(endInfo({
      id: SessionId('child-1'),
      runId: 'run-1',
      lastAssistantMessage: text([{ type: 'text', text: 'DSH_ASSISTANT_RESULT {"status":"completed","summary":"重复旧事件","eventKey":"old-key-2","checkpoint":"old-2"}' }]),
    }))
    expect(starts).toBe(2)
    expect(store.listPendingOutbox()).toEqual([])
    store.close()
  })

  it('keeps the replacement stop gate when interrupt throws, so a late old result is inert', async () => {
    const agent = fakeAgent()
    const subagents = fakeSubagents(agent, { interruptFails: new Error('interrupt unavailable') })
    let starts = 0
    subagents.startContinuable.mockImplementation(async () => {
      starts++
      agent.emit('subagent/start', startInfo({ id: SessionId('child-1'), runId: 'run-1' as never }))
      return { childId: SessionId('child-1'), messageId: 'm-1' }
    })
    const { worker, store } = makeWorker(agent, { subagents })
    const delegated = await worker.delegate(
      agent,
      { title: 'interrupt 失败', prompt: '旧完整方向', kind: 'monitor' },
      new AbortController().signal,
    )
    expect(delegated.ok).toBe(true)
    const before = store.getCurrent()!
    const replaced = await worker.replaceMonitorDirection(
      before,
      agent,
      '新完整方向',
      new AbortController().signal,
    )
    expect(replaced.ok).toBe(false)
    expect(store.getById(before.id)).toMatchObject({
      status: 'active',
      monitorDesiredState: 'running',
      monitorDirection: '新完整方向',
      monitorCheckpoint: null,
      workerControlState: 'pause_requested',
      workerSessionId: 'child-1',
      workerRunId: 'run-1',
    })

    // The interrupt did not confirm. A completed payload from the old run
    // must not be parsed, delivered, or advance the checkpoint, and no fresh
    // child may start while the old identity remains gated.
    worker.onEnd(endInfo({
      lastAssistantMessage: text([{ type: 'text', text: '旧结果\nDSH_ASSISTANT_RESULT {"status":"completed","summary":"旧事件","eventKey":"old-key","checkpoint":"old-cp"}' }]),
    }))
    expect(starts).toBe(1)
    expect(store.listPendingOutbox()).toHaveLength(0)
    expect(store.getById(before.id)).toMatchObject({
      status: 'active', monitorDirection: '新完整方向', monitorCheckpoint: null,
      monitorDesiredState: 'running', monitorResumeState: 'needed',
      workerControlState: 'none', workerSessionId: null,
    })
    store.close()
  })

  it('uses only the persisted replacement direction after restart when the old stop event is late', async () => {
    const oldAgent = fakeAgent()
    const oldSubagents = fakeSubagents(oldAgent)
    const first = makeWorker(oldAgent, { subagents: oldSubagents })
    const delegated = await first.worker.delegate(
      oldAgent,
      { title: '跨重启方向', prompt: '旧完整方向', kind: 'monitor' },
      new AbortController().signal,
    )
    expect(delegated.ok).toBe(true)
    const oldRow = first.store.getCurrent()!
    const replaced = await first.worker.replaceMonitorDirection(
      oldRow,
      oldAgent,
      '重启后唯一采用的新完整方向',
      new AbortController().signal,
    )
    expect(replaced.ok).toBe(true)
    expect(first.store.getById(oldRow.id)).toMatchObject({
      monitorDirection: '重启后唯一采用的新完整方向',
      workerSessionId: 'child-1',
      workerControlState: 'pause_requested',
    })

    // The old controller disappears before the interrupt/end handshake. The
    // startup normalizer invalidates that identity; a new controller may only
    // claim a fresh child from durable state.
    first.worker.setStopping(true)
    first.store.normalizeAgentOnStartup()
    expect(first.store.getById(oldRow.id)).toMatchObject({
      status: 'active',
      monitorResumeState: 'needed',
      workerSessionId: null,
      monitorDirection: '重启后唯一采用的新完整方向',
    })
    const newAgent = fakeAgent()
    const newSubagents = fakeSubagents(newAgent, { childId: 'child-2', runId: 'run-2' })
    const second = new WorkerController({
      store: first.store,
      mode: 'telegram',
      subagents: newSubagents,
      telegramParentSessionId: 'session-telegram',
      now: clock,
      logger: { warn: () => undefined },
    })
    await second.continueMonitors(newAgent, new AbortController().signal)
    expect(first.store.getById(oldRow.id)).toMatchObject({ workerSessionId: 'child-2', monitorResumeState: 'none' })
    const prompt = (newSubagents.startContinuable.mock.calls[0]![0] as { request: { prompt: { text: string }[] } }).request.prompt[0]!.text
    expect(prompt).toContain('重启后唯一采用的新完整方向')
    expect(prompt).not.toContain('旧完整方向')

    // A late old end has no worker lookup and cannot add an outbox or alter
    // the new child binding.
    first.worker.setStopping(false)
    first.worker.onEnd(endInfo({
      id: SessionId('child-1'), runId: 'run-1',
      lastAssistantMessage: text([{ type: 'text', text: '旧结果\nDSH_ASSISTANT_RESULT {"status":"completed","summary":"旧事件","eventKey":"late-old","checkpoint":"old-cp"}' }]),
    }))
    expect(first.store.getById(oldRow.id)).toMatchObject({ workerSessionId: 'child-2', monitorDirection: '重启后唯一采用的新完整方向' })
    expect(first.store.listPendingOutbox()).toEqual([])
    first.store.close()
  })

  it('pauses and resumes a monitor with a fresh child instead of following up the old round', async () => {
    const agent = fakeAgent()
    const subagents = fakeSubagents(agent)
    let starts = 0
    subagents.startContinuable.mockImplementation(async () => {
      starts++
      const childId = `child-${starts}`
      const runId = `run-${starts}`
      agent.emit('subagent/start', startInfo({ id: SessionId(childId), runId: runId as never }))
      return { childId: SessionId(childId), messageId: `m-${starts}` }
    })
    const { worker, store } = makeWorker(agent, { subagents })
    const delegated = await worker.delegate(
      agent,
      { title: '暂停恢复监控', prompt: '完整方向', kind: 'monitor' },
      new AbortController().signal,
    )
    expect(delegated.ok).toBe(true)
    worker.pause(store.getCurrent()!)
    worker.onEnd(endInfo({ stopReason: 'aborted' }))
    const paused = store.getCurrent()!
    expect(paused).toMatchObject({ status: 'paused', workerSessionId: null, monitorDesiredState: 'paused' })
    const resumed = await worker.resume(paused, agent, undefined, new AbortController().signal)
    expect(resumed.ok).toBe(true)
    expect(subagents.followup).not.toHaveBeenCalled()
    expect(starts).toBe(1)
    expect(store.getCurrent()).toMatchObject({ status: 'active', workerSessionId: null, monitorResumeState: 'needed' })
    await worker.continueMonitors(agent, new AbortController().signal)
    expect(starts).toBe(2)
    expect(store.getCurrent()).toMatchObject({ status: 'active', workerSessionId: 'child-2', monitorResumeState: 'none' })
    store.close()
  })

  it('serializes two controller ticks through the durable fresh claim', async () => {
    const agent = fakeAgent()
    const subagents = fakeSubagents(agent)
    let starts = 0
    subagents.startContinuable.mockImplementation(async () => {
      starts++
      const childId = `child-${starts}`
      const runId = `run-${starts}`
      agent.emit('subagent/start', startInfo({ id: SessionId(childId), runId: runId as never }))
      return { childId: SessionId(childId), messageId: `m-${starts}` }
    })
    const first = makeWorker(agent, { subagents })
    const delegated = await first.worker.delegate(
      agent,
      { title: '双 controller', prompt: '完整方向', kind: 'monitor' },
      new AbortController().signal,
    )
    expect(delegated.ok).toBe(true)
    first.worker.onEnd(endInfo({
      lastAssistantMessage: text([{ type: 'text', text: '事件\nDSH_ASSISTANT_RESULT {"status":"completed","summary":"事件","eventKey":"claim-key-a","checkpoint":"cp-a"}' }]),
    }))
    const event = first.store.listPendingOutbox()[0]!
    first.store.finishOutbox(event.id, 'delivered', { deliveredAt: NOW })
    const second = new WorkerController({
      store: first.store,
      mode: 'telegram',
      subagents,
      telegramParentSessionId: 'session-telegram',
      now: clock,
      logger: { warn: () => undefined },
    })
    await Promise.all([
      first.worker.continueMonitors(agent, new AbortController().signal),
      second.continueMonitors(agent, new AbortController().signal),
    ])
    expect(starts).toBe(2)
    expect(first.store.getCurrent()).toMatchObject({ workerSessionId: 'child-2', monitorResumeState: 'none' })
    first.store.close()
  })

  it('marks a fresh-round start failure blocked and does not retry it in the same tick', async () => {
    const agent = fakeAgent()
    const subagents = fakeSubagents(agent)
    let starts = 0
    subagents.startContinuable.mockImplementation(async () => {
      starts++
      if (starts === 2) throw new Error('spawn unavailable')
      agent.emit('subagent/start', startInfo())
      return { childId: SessionId('child-1'), messageId: 'm-1' }
    })
    const { worker, store } = makeWorker(agent, { subagents })
    const delegated = await worker.delegate(
      agent,
      { title: '新轮次失败', prompt: '完整方向', kind: 'monitor' },
      new AbortController().signal,
    )
    expect(delegated.ok).toBe(true)
    worker.onEnd(endInfo({
      lastAssistantMessage: text([{ type: 'text', text: '事件\nDSH_ASSISTANT_RESULT {"status":"completed","summary":"事件","eventKey":"failure-key","checkpoint":"cp"}' }]),
    }))
    const event = store.listPendingOutbox()[0]!
    store.finishOutbox(event.id, 'failed', { error: 'send failed' })
    await worker.continueMonitors(agent, new AbortController().signal)
    expect(starts).toBe(2)
    expect(store.getCurrent()).toMatchObject({ status: 'blocked', workerSessionId: null })
    expect(store.listPendingOutbox().some(item => item.kind === 'blocked')).toBe(true)
    await worker.continueMonitors(agent, new AbortController().signal)
    expect(starts).toBe(2)
    store.close()
  })

  it('clears a blocked monitor worker and resumes it as a fresh round', async () => {
    const agent = fakeAgent()
    const subagents = fakeSubagents(agent)
    let starts = 0
    subagents.startContinuable.mockImplementation(async () => {
      starts++
      const childId = `child-${starts}`
      const runId = `run-${starts}`
      agent.emit('subagent/start', startInfo({ id: SessionId(childId), runId: runId as never }))
      return { childId: SessionId(childId), messageId: `m-${starts}` }
    })
    const { worker, store } = makeWorker(agent, { subagents })
    const delegated = await worker.delegate(
      agent,
      { title: '受阻后恢复', prompt: '完整方向', kind: 'monitor' },
      new AbortController().signal,
    )
    expect(delegated.ok).toBe(true)
    // A completed worker without eventKey/checkpoint is a monitor protocol
    // failure, not monitor completion; the old identity must be detached.
    worker.onEnd(endInfo({ lastAssistantMessage: text([{ type: 'text', text: '缺少事件协议' }]) }))
    let row = store.getCurrent()!
    expect(row).toMatchObject({ status: 'blocked', workerSessionId: null })
    const resumed = await worker.resume(row, agent, undefined, new AbortController().signal)
    expect(resumed.ok).toBe(true)
    row = store.getCurrent()!
    expect(row).toMatchObject({ status: 'active', monitorResumeState: 'needed', workerSessionId: null })
    await worker.continueMonitors(agent, new AbortController().signal)
    expect(starts).toBe(2)
    expect(store.getCurrent()).toMatchObject({ status: 'active', workerSessionId: 'child-2' })
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

  it('pauses a monitor after its worker is unbound without aborting the pending event outbox', async () => {
    const agent = fakeAgent()
    const subagents = fakeSubagents(agent)
    const abortInFlight = vi.fn()
    const { worker, store } = makeWorker(agent, { subagents, abortInFlight })
    const delegated = await worker.delegate(
      agent,
      { title: '暂停竞态', prompt: '等待事件', kind: 'monitor' },
      new AbortController().signal,
    )
    expect(delegated.ok).toBe(true)
    worker.onEnd(endInfo({
      lastAssistantMessage: text([{ type: 'text', text: '事件\nDSH_ASSISTANT_RESULT {"status":"completed","summary":"事件","eventKey":"pause-event","checkpoint":"cp-1"}' }]),
    }))
    const current = store.getCurrent()!
    expect(current.workerSessionId).toBeNull()
    const event = store.listPendingOutbox()[0]!
    const out = worker.pause(current)
    expect(out.ok).toBe(true)
    expect(subagents.interrupt).not.toHaveBeenCalled()
    expect(abortInFlight).toHaveBeenCalledWith(current.id)
    expect(store.getById(current.id)).toMatchObject({
      status: 'paused',
      monitorDesiredState: 'paused',
      workerControlState: 'none',
    })
    expect(store.getOutbox(event.id)?.state).toBe('pending')
    store.close()
  })

  it('cancels an unbound monitor and cancels its pending event without interrupting a child', async () => {
    const agent = fakeAgent()
    const subagents = fakeSubagents(agent)
    const { worker, store } = makeWorker(agent, { subagents })
    const delegated = await worker.delegate(
      agent,
      { title: '取消竞态', prompt: '等待事件', kind: 'monitor' },
      new AbortController().signal,
    )
    expect(delegated.ok).toBe(true)
    worker.onEnd(endInfo({
      lastAssistantMessage: text([{ type: 'text', text: '事件\nDSH_ASSISTANT_RESULT {"status":"completed","summary":"事件","eventKey":"cancel-event","checkpoint":"cp-1"}' }]),
    }))
    const current = store.getCurrent()!
    const event = store.listPendingOutbox()[0]!
    const out = worker.cancel(current)
    expect(out.ok).toBe(true)
    expect(subagents.interrupt).not.toHaveBeenCalled()
    expect(store.getCurrent()).toBeUndefined()
    expect(store.getLastClosed()?.status).toBe('cancelled')
    expect(store.getOutbox(event.id)?.state).toBe('cancelled')
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

  it('monitor interrupt failure preserves pause_requested until the old end confirms stop', async () => {
    const agent = fakeAgent()
    const subagents = fakeSubagents(agent, { interruptFails: new Error('no target') })
    const { worker, store } = makeWorker(agent, { subagents })
    const delegated = await worker.delegate(
      agent,
      { title: '监控暂停失败', prompt: '完整方向', kind: 'monitor' },
      new AbortController().signal,
    )
    expect(delegated.ok).toBe(true)
    const current = store.getCurrent()!
    const out = worker.pause(current)
    expect(out.ok).toBe(false)
    expect(out).toMatchObject({
      code: 'worker_control_failed',
      message: '暂停意图已保存，但未确认旧轮次已停止；中断后台轮次失败。',
    })
    expect(store.getById(current.id)).toMatchObject({
      status: 'paused',
      monitorDesiredState: 'paused',
      workerControlState: 'pause_requested',
      workerSessionId: 'child-1',
      workerRunId: 'run-1',
    })

    // Any old result remains behind the stop gate: no monitor event is
    // created, and only the matching end clears the old identity.
    worker.onEnd(endInfo({
      lastAssistantMessage: text([{ type: 'text', text: '旧结果\nDSH_ASSISTANT_RESULT {"status":"completed","summary":"旧事件","eventKey":"old-key","checkpoint":"old-cp"}' }]),
    }))
    expect(store.listPendingOutbox()).toHaveLength(0)
    expect(store.getById(current.id)).toMatchObject({
      status: 'paused',
      monitorDesiredState: 'paused',
      monitorResumeState: 'none',
      workerControlState: 'none',
      workerSessionId: null,
    })
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
