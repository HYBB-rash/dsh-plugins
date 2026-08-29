/**
 * Model tool tests (src/tools.ts): status, track, update, and delegate —
 * ownership split, stable error codes, reminder scheduling, and the
 * web/telegram surface rules.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createCronControlUseCase } from '../src/cron-control.ts'
import { AssistantStore } from '../src/store.ts'
import { registerAssistantTools, type AssistantToolError, type MutationOutput } from '../src/tools.ts'
import { WorkerController, type SubagentsApi } from '../src/worker.ts'

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-assistant-tools-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const NOW = '2026-08-15T02:00:00.000Z'
const clock = () => Date.parse(NOW)

interface ToolDef {
  name: string
  parameters: Record<string, unknown>
  execute(args: unknown, exec: unknown): Promise<unknown>
  description?: string
}

function register(
  store: AssistantStore,
  mode: 'web' | 'telegram',
  worker?: WorkerController,
  cronControl?: ReturnType<typeof createCronControlUseCase>,
) {
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
  const dispose = registerAssistantTools(toolCtx as never, { store, mode, worker, cronControl, now: clock })
  return { tools, dispose }
}

function makeCronControl(store: AssistantStore, calls: string[]) {
  const snapshot = (externalRef: string, activeJob: string | null) => ({
    ok: true as const,
    snapshot: {
      externalRef,
      activeJob: activeJob === null ? null : { id: activeJob },
      latestRun: null,
    },
  })
  const controlPort = {
    ensureBound: async (spec: { externalRef: string }) => {
      calls.push(`ensure:${spec.externalRef}`)
      return snapshot(spec.externalRef, 'job-ensure')
    },
    replaceBound: async (spec: { externalRef: string }) => {
      calls.push(`replace:${spec.externalRef}`)
      return snapshot(spec.externalRef, 'job-replace')
    },
    deleteBound: async (externalRef: string) => {
      calls.push(`delete:${externalRef}`)
      return snapshot(externalRef, null)
    },
    getBound: async (externalRef: string) => snapshot(externalRef, null),
    readiness: async () => ({ state: 'ready' as const }),
  }
  return createCronControlUseCase({ store, controlPort: controlPort as never, now: () => NOW })
}

function exec(agentId = 'session-telegram'): { agent: Agent; signal: AbortSignal } {
  return {
    agent: { id: SessionId(agentId), session: { id: SessionId(agentId) } } as unknown as Agent,
    signal: new AbortController().signal,
  }
}

function fakeAgent(id = 'session-telegram') {
  const listeners = new Map<string, Array<(payload: unknown) => void>>()
  return {
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
  } as unknown as Agent & { emit(name: string, payload: unknown): void }
}

function fakeSubagents(agent: { emit(name: string, payload: unknown): void }, opts: { startFails?: Error } = {}): SubagentsApi {
  return {
    startContinuable: vi.fn(async () => {
      if (opts.startFails !== undefined) throw opts.startFails
      agent.emit('subagent/start', { runId: 'run-1', provider: 'spawn', id: 'child-1', local: true })
      return { childId: SessionId('child-1'), messageId: 'm1' }
    }),
    interrupt: vi.fn(),
    followup: vi.fn(async () => 'm2'),
  } as unknown as SubagentsApi
}

function makeWorker(agent: { emit(name: string, payload: unknown): void }, store: AssistantStore, opts: { startFails?: Error } = {}) {
  return new WorkerController({
    store,
    mode: 'telegram',
    subagents: fakeSubagents(agent, opts),
    telegramParentSessionId: 'session-telegram',
    now: clock,
    logger: { warn: () => undefined },
  })
}

function asError(value: unknown): AssistantToolError {
  return value as AssistantToolError
}

describe('registration', () => {
  it('web mode registers status/track/update but not delegate', () => {
    const store = new AssistantStore(join(tempDir(), 's.sqlite'))
    const { tools } = register(store, 'web')
    expect([...tools.keys()].sort()).toEqual([
      'assistant_task_status',
      'assistant_task_update',
      'assistant_track_task',
    ])
    expect(tools.has('assistant_delegate_task')).toBe(false)
    store.close()
  })

  it('telegram mode also registers delegate and the read-only Web observer query', () => {
    const store = new AssistantStore(join(tempDir(), 's.sqlite'))
    const agent = fakeAgent()
    const { tools } = register(store, 'telegram', makeWorker(agent, store))
    expect([...tools.keys()].sort()).toEqual([
      'assistant_delegate_task',
      'assistant_task_status',
      'assistant_task_update',
      'assistant_track_task',
      'assistant_web_task_status',
    ])
    store.close()
  })

  it('Web observer query reports conclusion and evidence without a control action', async () => {
    const store = new AssistantStore(join(tempDir(), 's.sqlite'))
    store.startWebObservation({
      sessionId: 'web-1', turn: 2, cwd: '/repo', now: NOW,
      writerInstanceId: 'writer', writerStartedAt: NOW,
    })
    store.updateWebObservation('web-1', 'writer', {
      assistantText: '测试已通过', assistantMessageId: 'a1', state: 'ended', turnReason: 'completed', finishedAt: NOW,
    }, NOW)
    const agent = fakeAgent()
    const { tools } = register(store, 'telegram', makeWorker(agent, store))
    const def = tools.get('assistant_web_task_status')!
    expect(Object.keys((def.parameters as { properties: Record<string, unknown> }).properties)).toEqual(['sessionId', 'query', 'limit'])
    expect(await def.execute({ sessionId: 'web-1' }, exec())).toMatchObject({
      selected: { state: 'ended', assistantConclusion: '测试已通过' }, ambiguous: false,
    })
    store.close()
  })

  it('dispose removes every tool', () => {
    const store = new AssistantStore(join(tempDir(), 's.sqlite'))
    const agent = fakeAgent()
    const { tools, dispose } = register(store, 'telegram', makeWorker(agent, store))
    dispose()
    expect(tools.size).toBe(0)
    store.close()
  })
})

describe('assistant_task_status', () => {
  it('shows responsibilities by surface and keeps current only when exactly one is visible', async () => {
    const store = new AssistantStore(join(tempDir(), 'state.sqlite'))
    const focus = store.createUserCommitment({ title: 'focus', status: 'active', sourceSurface: 'web', now: NOW })
    if (!focus.ok) throw new Error('focus seed failed')
    for (const title of ['a', 'b']) {
      const created = store.createAgentCommitment({ title, sourceSurface: 'telegram', now: NOW })
      if (!created.ok) throw new Error('agent seed failed')
    }
    const web = register(store, 'web')
    const tg = register(store, 'telegram')
    expect(await web.tools.get('assistant_task_status')!.execute({}, exec('web'))).toMatchObject({
      current: { title: 'focus' }, responsibilities: [{ title: 'focus' }], totalOpen: 1, truncated: false,
    })
    expect(await tg.tools.get('assistant_task_status')!.execute({}, exec())).toMatchObject({
      current: null, totalOpen: 3, truncated: false,
    })
    const tgStatus = await tg.tools.get('assistant_task_status')!.execute({}, exec()) as { responsibilities: unknown[] }
    expect(tgStatus.responsibilities).toHaveLength(3)
    const monitor = store.createAgentCommitment({
      title: 'bounded monitor status', kind: 'monitor', monitorDirection: 'private direction',
      sourceSurface: 'telegram', now: NOW,
    })
    if (!monitor.ok) throw new Error('monitor seed failed')
    const monitorStatus = await tg.tools.get('assistant_task_status')!.execute({}, exec()) as {
      responsibilities: Array<Record<string, unknown>>
    }
    const monitorView = monitorStatus.responsibilities.find(item => item.id === monitor.row.id)!
    expect(monitorView).toMatchObject({
      monitorDesiredState: 'running', monitorResumeState: 'none', hasWorker: false,
      monitorDirection: 'private direction', monitorCheckpoint: null,
      monitorEventKey: null, monitorProposedCheckpoint: null,
      monitorEventDeliveryState: null, monitorEventDeliveryError: null,
    })
    web.dispose(); tg.dispose(); store.close()
  })

  it('distinguishes a due reminder delivery failure from an unarmed timer', async () => {
    const store = new AssistantStore(join(tempDir(), 'check-in-delivery.sqlite'))
    const created = store.createUserCommitment({
      title: '外部访问', status: 'active', checkInMinutes: 2, sourceSurface: 'telegram', now: NOW,
    })
    if (!created.ok) throw new Error('focus seed failed')
    const queued = store.queueDueReminder('2026-08-15T02:02:00.000Z', 2 * 60 * 60 * 1000, () => '提醒')
    if (!queued.inserted || queued.outboxId === undefined) throw new Error('reminder was not queued')
    store.finishOutbox(queued.outboxId, 'failed', { error: 'fetch failed' })

    const { tools } = register(store, 'telegram')
    let status = await tools.get('assistant_task_status')!.execute({}, exec()) as { current: Record<string, unknown> }
    expect(status.current).toMatchObject({
      nextContactAt: null,
      checkInState: 'failed',
      lastCheckInDeliveryState: 'failed',
      lastCheckInDeliveryError: 'fetch failed',
    })

    const current = store.getById(created.row.id)!
    const rearmed = store.stillWorking(current.id, current.revision, 15, '2026-08-15T02:03:00.000Z')
    if (!rearmed.ok) throw new Error('re-arm failed')
    status = await tools.get('assistant_task_status')!.execute({}, exec()) as { current: Record<string, unknown> }
    expect(status.current).toMatchObject({
      checkInState: 'scheduled',
      nextContactAt: '2026-08-15T02:18:00.000Z',
      lastCheckInDeliveryState: 'failed',
      lastCheckInDeliveryError: 'fetch failed',
    })
    store.close()
  })

  it('shares one Telegram-created focus with Web, including Web updates visible back in Telegram', async () => {
    const store = new AssistantStore(join(tempDir(), 'cross-surface.sqlite'))
    const created = store.createUserCommitment({
      title: 'shared focus', status: 'active', sourceSurface: 'telegram', sourceSessionId: 'session-telegram', now: NOW,
    })
    if (!created.ok) throw new Error('focus seed failed')
    const web = register(store, 'web')
    const tg = register(store, 'telegram')
    expect(await web.tools.get('assistant_task_status')!.execute({}, exec('web'))).toMatchObject({
      current: { id: created.row.id, title: 'shared focus', status: 'active' }, totalOpen: 1,
    })
    expect(await web.tools.get('assistant_task_update')!.execute({
      action: 'pause', commitmentId: created.row.id,
    }, exec('web'))).toMatchObject({ current: { status: 'paused' } })
    expect(await tg.tools.get('assistant_task_status')!.execute({}, exec())).toMatchObject({
      current: { id: created.row.id, status: 'paused' }, totalOpen: 1,
    })
    web.dispose(); tg.dispose(); store.close()
  })

  it('returns null current and a lastClosed when nothing is open', async () => {
    const store = new AssistantStore(join(tempDir(), 's.sqlite'))
    const { tools } = register(store, 'telegram')
    const created = store.createUserCommitment({ title: 'old', status: 'active', sourceSurface: 'telegram', now: NOW })
    if (!created.ok) throw new Error('seed failed')
    store.completeUser(created.row.id, created.row.revision, '结果', NOW)
    const out = await tools.get('assistant_task_status')!.execute({}, exec())
    expect(out).toMatchObject({
      current: null,
      lastClosed: { title: 'old', status: 'completed', result: '结果' },
    })
    store.close()
  })

  it('drops lastClosed while a current commitment exists unless its delivery failed', async () => {
    const store = new AssistantStore(join(tempDir(), 's.sqlite'))
    const { tools } = register(store, 'telegram')
    const created = store.createUserCommitment({ title: 'old', status: 'active', sourceSurface: 'telegram', now: NOW })
    if (!created.ok) throw new Error('seed failed')
    store.completeUser(created.row.id, created.row.revision, '结果', NOW)
    const current = store.createUserCommitment({ title: 'new', status: 'active', sourceSurface: 'telegram', now: NOW })
    if (!current.ok) throw new Error('seed failed')
    // Delivered cleanly → no lastClosed while current exists
    let out = await tools.get('assistant_task_status')!.execute({}, exec())
    expect((out as { current: { title: string }; lastClosed: unknown }).current?.title).toBe('new')
    expect((out as { lastClosed: unknown }).lastClosed).toBeNull()
    // Simulate a failed delivery on the closed row → lastClosed surfaces again
    store.touchLastDelivery(created.row.id, 'failed', 'HTTP 500')
    out = await tools.get('assistant_task_status')!.execute({}, exec())
    expect((out as { lastClosed: { title: string; lastDeliveryState: string } }).lastClosed?.title).toBe('old')
    expect((out as { lastClosed: { lastDeliveryState: string } }).lastClosed?.lastDeliveryState).toBe('failed')
    store.close()
  })

  it('keeps a bounded multi-item view of recent Agent closures while other work remains open', async () => {
    const store = new AssistantStore(join(tempDir(), 'recent-agent-closures.sqlite'))
    const monitor = store.createAgentCommitment({
      title: '持续监控仓库', kind: 'monitor', monitorDirection: '持续观察该 workspace', sourceSurface: 'telegram', now: NOW,
    })
    if (!monitor.ok) throw new Error('monitor seed failed')

    const closeAgent = (title: string, child: string, completedAt: string, result: string) => {
      const created = store.createAgentCommitment({ title, sourceSurface: 'telegram', now: completedAt })
      if (!created.ok) throw new Error('agent seed failed')
      const saved = store.saveWorkerIdentity(created.row.id, created.row.revision, {
        workerSessionId: child, workerRunId: `run-${child}`, workerParentSessionId: 'session-telegram',
      })
      if (!saved.ok) throw new Error('identity seed failed')
      const settled = store.settleWorkerEnd(created.row.id, saved.row.revision, {
        status: 'completed', result, completedAt,
        outboxId: `outbox-${child}`, outboxText: `terminal ${title}`,
      })
      if (!settled.ok) throw new Error('settlement seed failed')
      return settled.row
    }

    const oldest = closeAgent('最旧已交付', 'old', '2026-08-15T02:01:00.000Z', 'old-result')
    const failed = closeAgent('验收 A', 'a', '2026-08-15T02:02:00.000Z', 'A-result-recoverable')
    const uncertain = closeAgent('验收 B', 'b', '2026-08-15T02:03:00.000Z', 'B-result-recoverable')
    const delivered = closeAgent('验收 C', 'c', '2026-08-15T02:04:00.000Z', 'C-result')
    store.touchLastDelivery(oldest.id, 'delivered')
    store.touchLastDelivery(failed.id, 'failed', 'HTTP 500')
    store.touchLastDelivery(uncertain.id, 'uncertain', 'send interrupted')
    store.touchLastDelivery(delivered.id, 'delivered')

    // A later focus closure becomes the legacy lastClosed row. It must not
    // hide the three independently completed Agent responsibilities.
    const focus = store.createUserCommitment({
      title: '用户焦点', status: 'active', sourceSurface: 'telegram', now: '2026-08-15T02:05:00.000Z',
    })
    if (!focus.ok) throw new Error('focus seed failed')
    store.completeUser(focus.row.id, focus.row.revision, 'focus done', '2026-08-15T02:06:00.000Z')

    const telegram = register(store, 'telegram')
    const web = register(store, 'web')
    const tgStatus = await telegram.tools.get('assistant_task_status')!.execute({}, exec()) as {
      current: { title: string }
      recentAgentClosures: Array<{
        title: string; result: string; lastDeliveryState: string; lastDeliveryError: string | null
      }>
    }
    expect(tgStatus.current.title).toBe('持续监控仓库')
    expect(tgStatus.recentAgentClosures).toMatchObject([
      { title: '验收 C', result: 'C-result', lastDeliveryState: 'delivered' },
      { title: '验收 B', result: 'B-result-recoverable', lastDeliveryState: 'uncertain', lastDeliveryError: 'send interrupted' },
      { title: '验收 A', result: 'A-result-recoverable', lastDeliveryState: 'failed', lastDeliveryError: 'HTTP 500' },
    ])
    expect(tgStatus.recentAgentClosures).toHaveLength(3)
    expect(tgStatus.recentAgentClosures.some(row => row.title === '最旧已交付')).toBe(false)
    expect(await web.tools.get('assistant_task_status')!.execute({}, exec('web'))).toMatchObject({
      recentAgentClosures: [],
    })
    telegram.dispose(); web.dispose(); store.close()
  })

  it('never exposes a Telegram Agent closure through the Web legacy lastClosed field', async () => {
    const closeAgent = (store: AssistantStore, title: string, completedAt: string) => {
      const created = store.createAgentCommitment({ title, sourceSurface: 'telegram', now: completedAt })
      if (!created.ok) throw new Error('agent seed failed')
      const saved = store.saveWorkerIdentity(created.row.id, created.row.revision, {
        workerSessionId: `child-${title}`, workerRunId: `run-${title}`, workerParentSessionId: 'session-telegram',
      })
      if (!saved.ok) throw new Error('identity seed failed')
      const settled = store.settleWorkerEnd(created.row.id, saved.row.revision, {
        status: 'completed', result: `private result ${title}`, completedAt,
        outboxId: `outbox-${title}`, outboxText: `terminal ${title}`,
      })
      if (!settled.ok) throw new Error('settlement seed failed')
    }

    const onlyAgent = new AssistantStore(join(tempDir(), 'web-last-closed-only-agent.sqlite'))
    closeAgent(onlyAgent, 'Telegram 私有 Agent 结果', '2026-08-15T02:01:00.000Z')
    const onlyAgentWeb = register(onlyAgent, 'web')
    const onlyAgentTg = register(onlyAgent, 'telegram')
    expect(await onlyAgentWeb.tools.get('assistant_task_status')!.execute({}, exec('web'))).toMatchObject({
      lastClosed: null,
      recentAgentClosures: [],
    })
    expect(await onlyAgentTg.tools.get('assistant_task_status')!.execute({}, exec())).toMatchObject({
      lastClosed: { title: 'Telegram 私有 Agent 结果', result: 'private result Telegram 私有 Agent 结果' },
    })
    onlyAgentWeb.dispose(); onlyAgentTg.dispose(); onlyAgent.close()

    const mixed = new AssistantStore(join(tempDir(), 'web-last-closed-mixed.sqlite'))
    const focus = mixed.createUserCommitment({
      title: 'Web 可见 focus 收口', status: 'active', sourceSurface: 'web', now: '2026-08-15T02:01:00.000Z',
    })
    if (!focus.ok) throw new Error('focus seed failed')
    mixed.completeUser(focus.row.id, focus.row.revision, 'focus result', '2026-08-15T02:02:00.000Z')
    closeAgent(mixed, '更新的 Telegram Agent 收口', '2026-08-15T02:03:00.000Z')
    const mixedWeb = register(mixed, 'web')
    const mixedTg = register(mixed, 'telegram')
    expect(await mixedWeb.tools.get('assistant_task_status')!.execute({}, exec('web'))).toMatchObject({
      lastClosed: { title: 'Web 可见 focus 收口', result: 'focus result' },
    })
    expect(await mixedTg.tools.get('assistant_task_status')!.execute({}, exec())).toMatchObject({
      lastClosed: { title: '更新的 Telegram Agent 收口', result: 'private result 更新的 Telegram Agent 收口' },
    })
    mixedWeb.dispose(); mixedTg.dispose(); mixed.close()
  })

  it('the tool description explicitly excludes the personal todo list and points to the workspace source', async () => {
    const store = new AssistantStore(join(tempDir(), 's.sqlite'))
    const { tools } = register(store, 'telegram')
    const status = tools.get('assistant_task_status')!
    expect(status.description).toContain('bounded open responsibilities')
    expect(status.description).toContain('not the user\'s personal todo list')
    expect(status.description).toContain('workspace')
    store.close()
  })

  it('shows bounded monitor facts and delivery failure without exposing event body', async () => {
    const store = new AssistantStore(join(tempDir(), 'monitor-delivery-status.sqlite'))
    const agent = fakeAgent()
    const worker = makeWorker(agent, store)
    const { tools } = register(store, 'telegram', worker)
    const delegated = await worker.delegate(
      agent as never,
      { title: 'delivery status monitor', prompt: 'private full direction', kind: 'monitor' },
      new AbortController().signal,
    )
    if (!delegated.ok) throw new Error('monitor delegation failed')
    worker.onEnd({
      id: SessionId('child-1'), runId: 'run-1', provider: 'spawn', local: true, stopReason: 'completed',
      lastAssistantMessage: [{ type: 'text', text: '业务正文不应出现在 status\nDSH_ASSISTANT_RESULT {"status":"completed","summary":"事件摘要","eventKey":"status-event","checkpoint":"status-cp"}' }],
    } as never)
    const event = store.listPendingOutbox()[0]!
    store.finishOutbox(event.id, 'failed', { error: 'HTTP 500' })
    const status = await tools.get('assistant_task_status')!.execute({}, exec()) as {
      current: Record<string, unknown>
    }
    expect(status.current).toMatchObject({
      kind: 'monitor', status: 'active', lastDeliveryState: 'failed', lastDeliveryError: 'HTTP 500',
      monitorDesiredState: 'running', hasWorker: false,
      monitorDirection: 'private full direction', monitorCheckpoint: null,
      monitorEventKey: 'status-event', monitorProposedCheckpoint: 'status-cp',
      monitorEventDeliveryState: 'failed', monitorEventDeliveryError: 'HTTP 500',
    })
    expect(JSON.stringify(status.current)).not.toContain('业务正文')
    store.close()
  })

  it.each([
    ['success+silent without summary', {
      runId: 'cron-run-success',
      runStatus: 'success',
      summary: undefined,
      error: undefined,
      deliveryState: 'silent',
      deliveryError: undefined,
    }],
    ['error+failed with independent errors', {
      runId: 'cron-run-error',
      runStatus: 'error',
      summary: 'Cron error summary',
      error: 'Cron run failed',
      deliveryState: 'failed',
      deliveryError: 'Cron delivery failed',
    }],
  ])('exposes an independent Cron binding and latestRun in status for %s', async (_label, run) => {
    const store = new AssistantStore(join(tempDir(), `cron-status-${run.runId}.sqlite`))
    const created = store.createAgentCommitment({
      title: 'bound Cron monitor', kind: 'monitor', monitorDirection: '完整 Cron 方向',
      sourceSurface: 'telegram', now: NOW,
    })
    if (!created.ok) throw new Error('monitor seed failed')
    const saved = store.saveWorkerIdentity(created.row.id, created.row.revision, {
      workerSessionId: `legacy-status-child-${run.runId}`,
      workerRunId: `legacy-status-worker-${run.runId}`,
      workerParentSessionId: 'session-telegram',
    })
    if (!saved.ok) throw new Error('worker identity seed failed')
    const active = store.markAgentActive(saved.row.id, saved.row.revision)
    if (!active.ok) throw new Error('monitor activation failed')
    const progress = store.recordWorkerProgress(
      `legacy-status-child-${run.runId}`,
      `legacy-status-progress-${run.runId}`,
      'legacy progress must remain separate from Cron facts',
      NOW,
    )
    if (!progress.inserted) throw new Error('legacy progress seed failed')
    const afterProgress = store.getById(created.row.id)
    if (afterProgress === undefined) throw new Error('monitor disappeared after progress')
    const legacyEvent = store.settleMonitorEvent({
      commitmentId: created.row.id,
      expectedRevision: afterProgress.revision,
      workerSessionId: `legacy-status-child-${run.runId}`,
      workerRunId: `legacy-status-worker-${run.runId}`,
      workerParentSessionId: 'session-telegram',
      monitorResumeEpoch: afterProgress.monitorResumeEpoch,
      eventKey: `legacy-event-${run.runId}`,
      checkpoint: 'legacy-checkpoint',
      summary: 'LEGACY-EVENT-SUMMARY-MUST-NOT-BE-CRON-FACT',
      outboxText: 'LEGACY-EVENT-OUTBOX-MUST-NOT-BE-CRON-FACT',
      now: NOW,
    })
    if (!legacyEvent.ok) throw new Error('legacy event seed failed')
    store.finishOutbox(legacyEvent.outbox.id, 'failed', { error: 'legacy event delivery failed' })

    const binding = store.createCronBinding({
      commitmentId: created.row.id,
      externalRef: `assistant:${created.row.id}`,
      desiredScheduleJson: JSON.stringify({ kind: 'interval', minutes: 15 }),
      desiredCwd: '/repo/cron-status',
      desiredState: 'running',
      boundJobId: 'cron-job-status',
      updatedAt: NOW,
    })
    if (!binding.ok) throw new Error('Cron binding seed failed')
    const observed = store.observeCronRunFinished({
      commitmentId: created.row.id,
      externalRef: `assistant:${created.row.id}`,
      runId: run.runId,
      jobId: 'cron-job-status',
      scheduledFor: '2026-08-18T07:00:00.000Z',
      finishedAt: '2026-08-18T07:00:03.000Z',
      runStatus: run.runStatus,
      ...(run.summary === undefined ? {} : { summary: run.summary }),
      ...(run.error === undefined ? {} : { error: run.error }),
      deliveryState: run.deliveryState,
      ...(run.deliveryError === undefined ? {} : { deliveryError: run.deliveryError }),
      now: NOW,
    })
    if (!observed.ok) throw new Error('Cron observation seed failed')
    const controlError = store.recordCronControlError({
      commitmentId: created.row.id,
      externalRef: `assistant:${created.row.id}`,
      code: 'control_unavailable',
      error: 'Cron manager observation unavailable',
    })
    if (controlError === undefined) throw new Error('Cron control error seed failed')

    const { tools } = register(store, 'telegram')
    const status = await tools.get('assistant_task_status')!.execute({}, exec()) as {
      current: Record<string, unknown>
      responsibilities: Array<Record<string, unknown>>
    }
    const view = status.current ?? status.responsibilities.find(item => item.id === created.row.id)
    expect(view).toMatchObject({
      kind: 'monitor',
      progressSummary: 'legacy progress must remain separate from Cron facts',
      lastDeliveryState: 'failed',
      lastDeliveryError: 'legacy event delivery failed',
      cronBinding: {
        desiredState: 'running',
        schedule: { kind: 'interval', minutes: 15 },
        desiredCwd: '/repo/cron-status',
        boundJobId: 'cron-job-status',
        controlError: 'Cron manager observation unavailable',
        lastRun: {
          runId: run.runId,
          jobId: 'cron-job-status',
          scheduledFor: '2026-08-18T07:00:00.000Z',
          finishedAt: '2026-08-18T07:00:03.000Z',
          runStatus: run.runStatus,
          summary: run.summary ?? null,
          runError: run.error ?? null,
          deliveryState: run.deliveryState,
          deliveryError: run.deliveryError ?? null,
        },
      },
    })
    expect(view).not.toHaveProperty('cronBinding.lastRun.eventKey')
    expect(view).not.toHaveProperty('cronBinding.lastRun.checkpoint')
    expect(view).not.toHaveProperty('cronBinding.lastRun.outboxText')
    store.close()
  })

  it('shows a monitor pause request separately from a live worker after interrupt failure', async () => {
    const store = new AssistantStore(join(tempDir(), 'monitor-interrupt-status.sqlite'))
    const created = store.createAgentCommitment({
      title: 'interrupt failure monitor', kind: 'monitor', monitorDirection: '新完整方向',
      sourceSurface: 'telegram', now: NOW,
    })
    if (!created.ok) throw new Error('monitor seed failed')
    const saved = store.saveWorkerIdentity(created.row.id, created.row.revision, {
      workerSessionId: 'old-child', workerRunId: 'old-run', workerParentSessionId: 'session-telegram',
    })
    if (!saved.ok) throw new Error('identity seed failed')
    const active = store.markAgentActive(saved.row.id, saved.row.revision)
    if (!active.ok) throw new Error('active seed failed')
    const paused = store.pauseAgent(active.row.id, active.row.revision)
    if (!paused.ok) throw new Error('pause seed failed')
    expect(paused.row.workerControlState).toBe('pause_requested')

    const { tools } = register(store, 'telegram')
    const status = await tools.get('assistant_task_status')!.execute({}, exec()) as {
      current: Record<string, unknown>
    }
    expect(status.current).toMatchObject({
      kind: 'monitor', status: 'paused', hasWorker: true,
      monitorDirection: '新完整方向', monitorDesiredState: 'paused',
      monitorResumeState: 'none', workerControlState: 'pause_requested',
    })
    store.close()
  })
})

describe('assistant_track_task', () => {
  it('creates an active user commitment with a scheduled reminder', async () => {
    const store = new AssistantStore(join(tempDir(), 's.sqlite'))
    const { tools } = register(store, 'telegram')
    const out = await tools.get('assistant_track_task')!.execute({ title: ' 整理书桌 ', status: 'active', checkInMinutes: 2, nextAction: '用户继续整理' }, exec())
    expect(asError(out).code).toBeUndefined()
    const result = out as MutationOutput
    expect(result.current.title).toBe('整理书桌')
    expect(result.current.workOwner).toBe('user')
    expect(result.current.status).toBe('active')
    expect(result.current.nextContactAt).toBe('2026-08-15T02:02:00.000Z')
    expect(result.reply).toContain('事情由你做，跟进由我负责。')
    expect(result.reply).toContain('我会在')
    const row = store.getCurrent()!
    expect(row.reminderState).toBe('scheduled')
    store.close()
  })

  it('rejects with current_commitment_exists when a current focus already exists', async () => {
    const store = new AssistantStore(join(tempDir(), 's.sqlite'))
    const { tools } = register(store, 'telegram')
    await tools.get('assistant_track_task')!.execute({ title: '第一件', status: 'active' }, exec())
    const out = asError(await tools.get('assistant_track_task')!.execute({ title: '第二件', status: 'active' }, exec()))
    expect(out.code).toBe('current_commitment_exists')
    expect(out.current?.title).toBe('第一件')
    expect(store.getCurrent()?.title).toBe('第一件')
    store.close()
  })

  it('validates title and checkInMinutes', async () => {
    const store = new AssistantStore(join(tempDir(), 's.sqlite'))
    const { tools } = register(store, 'telegram')
    expect(asError(await tools.get('assistant_track_task')!.execute({ title: '   ' }, exec())).code).toBe('invalid_transition')
    expect(asError(await tools.get('assistant_track_task')!.execute({ title: 't', checkInMinutes: 0 }, exec())).code).toBe('invalid_transition')
    expect(asError(await tools.get('assistant_track_task')!.execute({ title: 't', checkInMinutes: 99999 }, exec())).code).toBe('invalid_transition')
    store.close()
  })
})

describe('assistant_task_update (user route)', () => {
  it('requires commitmentId when more than one controllable responsibility is open and never guesses', async () => {
    const agent = fakeAgent()
    const store = new AssistantStore(join(tempDir(), 'state.sqlite'))
    const focus = store.createUserCommitment({ title: 'focus', status: 'active', sourceSurface: 'telegram', now: NOW })
    const delegated = store.createAgentCommitment({ title: 'delegated', sourceSurface: 'telegram', now: NOW })
    if (!focus.ok || !delegated.ok) throw new Error('seed failed')
    const worker = makeWorker(agent, store)
    const { tools, dispose } = register(store, 'telegram', worker)
    const before = store.listOpen().map(row => [row.id, row.status, row.revision])
    const ambiguous = await tools.get('assistant_task_update')!.execute({ action: 'cancel' }, exec()) as AssistantToolError & { candidates?: unknown[] }
    expect(ambiguous.code).toBe('ambiguous_commitment')
    expect(ambiguous.candidates).toHaveLength(2)
    expect(store.listOpen().map(row => [row.id, row.status, row.revision])).toEqual(before)
    const done = await tools.get('assistant_task_update')!.execute({ action: 'complete', commitmentId: focus.row.id }, exec())
    expect(done).toMatchObject({ current: { id: focus.row.id, status: 'completed' } })
    expect(store.getById(delegated.row.id)?.status).toBe('pending')
    dispose(); store.close()
  })

  it('an explicit commitmentId reaches an open Telegram responsibility beyond the bounded status page', async () => {
    const store = new AssistantStore(join(tempDir(), 'many-responsibilities.sqlite'))
    let targetId = ''
    for (let index = 0; index < 102; index++) {
      const created = store.createAgentCommitment({
        title: `agent-${index}`, sourceSurface: 'telegram',
        now: new Date(Date.parse(NOW) + index * 1000).toISOString(),
      })
      if (!created.ok) throw new Error('seed failed')
      targetId = created.row.id
    }
    const agent = fakeAgent()
    const { tools } = register(store, 'telegram', makeWorker(agent, store))
    expect(await tools.get('assistant_task_update')!.execute({
      action: 'cancel', commitmentId: targetId,
    }, exec())).toMatchObject({ current: { id: targetId, status: 'cancelled' } })
    expect(store.getById(targetId)?.status).toBe('cancelled')
    store.close()
  })

  async function seedActive(title = 't', checkInMinutes?: number) {
    const store = new AssistantStore(join(tempDir(), 's.sqlite'))
    const { tools } = register(store, 'telegram')
    const created = store.createUserCommitment({
      title,
      status: 'active',
      ...checkInMinutes === undefined ? {} : { checkInMinutes },
      sourceSurface: 'telegram',
      now: NOW,
    })
    if (!created.ok) throw new Error('seed failed')
    return { store, tools, row: created.row }
  }

  it('no_current_commitment when nothing is open', async () => {
    const store = new AssistantStore(join(tempDir(), 's.sqlite'))
    const { tools } = register(store, 'telegram')
    const out = asError(await tools.get('assistant_task_update')!.execute({ action: 'pause' }, exec()))
    expect(out.code).toBe('no_current_commitment')
    store.close()
  })

  it('pause, still_working, resume, complete, cancel round-trip with replies', async () => {
    const { store, tools, row } = await seedActive('整理书桌', 2)
    const paused = await tools.get('assistant_task_update')!.execute({ action: 'pause' }, exec())
    expect((paused as MutationOutput).current.status).toBe('paused')
    expect((paused as MutationOutput).reply).toContain('已暂停')
    expect(store.getCurrent()?.reminderState).toBe('cancelled')

    const resumed = await tools.get('assistant_task_update')!.execute({ action: 'resume', checkInMinutes: 5 }, exec())
    expect((resumed as MutationOutput).current.status).toBe('active')
    expect((resumed as MutationOutput).reply).toContain('已恢复')
    expect((resumed as MutationOutput).reply).toContain('10:05')
    expect(store.getCurrent()?.reminderDueAt).toBe('2026-08-15T02:05:00.000Z')

    const working = await tools.get('assistant_task_update')!.execute({ action: 'still_working' }, exec())
    expect((working as MutationOutput).current.status).toBe('active')
    expect((working as MutationOutput).reply).toContain('再问你')
    expect((working as MutationOutput).reply).toContain('10:05')

    const completed = await tools.get('assistant_task_update')!.execute({ action: 'complete', result: '全部收好' }, exec())
    expect((completed as MutationOutput).current.status).toBe('completed')
    expect((completed as MutationOutput).reply).toContain('已收口')
    expect(store.getCurrent()).toBeUndefined()
    expect(store.getLastClosed()?.result).toBe('全部收好')
    store.close()
  })

  it('block saves reason and nextAction; cancel releases the focus', async () => {
    const { store, tools, row } = await seedActive('t')
    const blocked = await tools.get('assistant_task_update')!.execute({ action: 'block', reason: '缺材料', nextAction: '用户补齐材料' }, exec())
    expect((blocked as MutationOutput).current.status).toBe('blocked')
    expect(store.getCurrent()?.blockedReason).toBe('缺材料')
    expect(store.getCurrent()?.nextAction).toBe('用户补齐材料')
    const cancelled = await tools.get('assistant_task_update')!.execute({ action: 'cancel' }, exec())
    expect((cancelled as MutationOutput).current.status).toBe('cancelled')
    expect(store.getCurrent()).toBeUndefined()
    store.close()
  })

  it('set_next_action updates the open commitment', async () => {
    const { store, tools } = await seedActive('t')
    const out = await tools.get('assistant_task_update')!.execute({ action: 'set_next_action', nextAction: '先读文档' }, exec())
    expect((out as MutationOutput).current.nextAction).toBe('先读文档')
    expect(store.getCurrent()?.nextAction).toBe('先读文档')
    store.close()
  })

  it('rejects invalid transitions (resume of an active commitment)', async () => {
    const { store, tools } = await seedActive('t')
    const out = asError(await tools.get('assistant_task_update')!.execute({ action: 'resume' }, exec()))
    expect(out.code).toBe('invalid_transition')
    store.close()
  })
})

describe('assistant_task_update (agent route)', () => {
  it('uses revise_monitor for a full direction replacement, not set_next_action', async () => {
    const store = new AssistantStore(join(tempDir(), 'monitor-direction-update.sqlite'))
    const agent = fakeAgent()
    const worker = makeWorker(agent, store)
    worker.ensureInstalled(agent)
    const calls: string[] = []
    const cronControl = makeCronControl(store, calls)
    const { tools } = register(store, 'telegram', worker, cronControl)
    const created = store.createAgentCommitment({
      title: 'monitor', kind: 'monitor', monitorDirection: '旧完整方向', sourceSurface: 'telegram', now: NOW,
    })
    if (!created.ok) throw new Error('seed failed')
    const active = store.markAgentActive(created.row.id, created.row.revision)
    if (!active.ok) throw new Error('active failed')
    const binding = store.createCronBinding({
      commitmentId: created.row.id,
      externalRef: `assistant:${created.row.id}`,
      desiredScheduleJson: JSON.stringify({ kind: 'interval', minutes: 30 }),
      desiredState: 'running',
      updatedAt: NOW,
    })
    if (!binding.ok) throw new Error('binding failed')
    const out = await tools.get('assistant_task_update')!.execute({
      action: 'revise_monitor', commitmentId: created.row.id, direction: '新完整方向',
    }, { agent, signal: new AbortController().signal }) as MutationOutput
    expect(out.current).toMatchObject({ kind: 'monitor', status: 'active', hasWorker: false })
    expect(calls).toEqual([`replace:assistant:${created.row.id}`])
    expect(store.getById(created.row.id)).toMatchObject({
      monitorDirection: '新完整方向',
      nextAction: null,
      workerControlState: 'none',
      workerSessionId: null,
    })
    store.close()
  })

  it('keeps monitor set_next_action as a pure next-action update', async () => {
    const store = new AssistantStore(join(tempDir(), 'monitor-next-action.sqlite'))
    const agent = fakeAgent()
    const subagents = fakeSubagents(agent) as SubagentsApi & {
      interrupt: ReturnType<typeof vi.fn>
      startContinuable: ReturnType<typeof vi.fn>
    }
    const worker = new WorkerController({
      store,
      mode: 'telegram',
      subagents,
      telegramParentSessionId: 'session-telegram',
      now: clock,
      logger: { warn: () => undefined },
    })
    worker.ensureInstalled(agent)
    const { tools } = register(store, 'telegram', worker)
    const created = store.createAgentCommitment({
      title: 'monitor', kind: 'monitor', monitorDirection: '旧完整方向', sourceSurface: 'telegram', now: NOW,
    })
    if (!created.ok) throw new Error('seed failed')
    const saved = store.saveWorkerIdentity(created.row.id, created.row.revision, {
      workerSessionId: 'child-1', workerRunId: 'run-1', workerParentSessionId: 'session-telegram',
    })
    if (!saved.ok) throw new Error('save failed')
    const active = store.markAgentActive(saved.row.id, saved.row.revision)
    if (!active.ok) throw new Error('active failed')
    const out = await tools.get('assistant_task_update')!.execute({
      action: 'set_next_action', commitmentId: created.row.id, nextAction: '下一次先检查日志',
    }, { agent, signal: new AbortController().signal }) as MutationOutput
    expect(out.current).toMatchObject({ kind: 'monitor', status: 'active', hasWorker: true, nextAction: '下一次先检查日志' })
    expect(store.getById(created.row.id)).toMatchObject({
      monitorDirection: '旧完整方向', nextAction: '下一次先检查日志', workerControlState: 'none', workerSessionId: 'child-1',
    })
    expect(subagents.interrupt).not.toHaveBeenCalled()
    expect(subagents.startContinuable).not.toHaveBeenCalled()
    store.close()
  })

  it('saves a paused monitor direction without resuming or starting a worker', async () => {
    const store = new AssistantStore(join(tempDir(), 'paused-monitor-direction.sqlite'))
    const agent = fakeAgent()
    const worker = makeWorker(agent, store)
    worker.ensureInstalled(agent)
    const calls: string[] = []
    const cronControl = makeCronControl(store, calls)
    const { tools } = register(store, 'telegram', worker, cronControl)
    const created = store.createAgentCommitment({
      title: 'paused monitor', kind: 'monitor', monitorDirection: '旧方向', sourceSurface: 'telegram', now: NOW,
    })
    if (!created.ok) throw new Error('seed failed')
    const active = store.markAgentActive(created.row.id, created.row.revision)
    if (!active.ok) throw new Error('active failed')
    const binding = store.createCronBinding({
      commitmentId: created.row.id,
      externalRef: `assistant:${created.row.id}`,
      desiredScheduleJson: JSON.stringify({ kind: 'interval', minutes: 30 }),
      desiredState: 'paused',
      updatedAt: NOW,
    })
    if (!binding.ok) throw new Error('binding failed')
    const paused = store.pauseAgent(active.row.id, active.row.revision)
    if (!paused.ok) throw new Error('pause failed')
    const out = await tools.get('assistant_task_update')!.execute({
      action: 'revise_monitor', commitmentId: created.row.id, direction: '新暂停方向',
    }, { agent, signal: new AbortController().signal }) as MutationOutput
    expect(out).toMatchObject({ current: { status: 'paused', hasWorker: false } })
    expect(calls).toEqual([])
    expect(store.getById(created.row.id)).toMatchObject({
      monitorDirection: '新暂停方向', status: 'paused', monitorDesiredState: 'paused', monitorResumeState: 'none', workerSessionId: null,
    })
    store.close()
  })

  it('complete on an agent commitment is rejected with wrong_work_owner', async () => {
    const store = new AssistantStore(join(tempDir(), 's.sqlite'))
    const agent = fakeAgent()
    const worker = makeWorker(agent, store)
    const { tools } = register(store, 'telegram', worker)
    const created = store.createAgentCommitment({ title: 'agent', sourceSurface: 'telegram', now: NOW })
    if (!created.ok) throw new Error('seed failed')
    const saved = store.saveWorkerIdentity(created.row.id, created.row.revision, {
      workerSessionId: 'child-1', workerRunId: 'run-1', workerParentSessionId: 'session-telegram',
    })
    if (!saved.ok) throw new Error('save failed')
    store.markAgentActive(created.row.id, saved.row.revision)
    const out = asError(await tools.get('assistant_task_update')!.execute({ action: 'complete', result: 'x' }, exec()))
    expect(out.code).toBe('wrong_work_owner')
    store.close()
  })

  it('rejects manual block for Agent work and leaves its live child active', async () => {
    const store = new AssistantStore(join(tempDir(), 'agent-block.sqlite'))
    const agent = fakeAgent()
    const worker = makeWorker(agent, store)
    const { tools } = register(store, 'telegram', worker)
    const created = store.createAgentCommitment({ title: 'agent', sourceSurface: 'telegram', now: NOW })
    if (!created.ok) throw new Error('seed failed')
    const saved = store.saveWorkerIdentity(created.row.id, created.row.revision, {
      workerSessionId: 'child-1', workerRunId: 'run-1', workerParentSessionId: 'session-telegram',
    })
    if (!saved.ok) throw new Error('save failed')
    const active = store.markAgentActive(saved.row.id, saved.row.revision)
    if (!active.ok) throw new Error('active failed')
    const out = asError(await tools.get('assistant_task_update')!.execute({
      action: 'block', commitmentId: created.row.id, reason: 'manual',
    }, exec()))
    expect(out.code).toBe('wrong_work_owner')
    expect(store.getById(created.row.id)).toMatchObject({ status: 'active', workerSessionId: 'child-1' })
    store.close()
  })

  it('the framework schema rejects a non-string Agent resume direction before worker code runs', async () => {
    const store = new AssistantStore(join(tempDir(), 'agent-direction.sqlite'))
    const agent = fakeAgent()
    const worker = makeWorker(agent, store)
    const { tools } = register(store, 'telegram', worker)
    const created = store.createAgentCommitment({ title: 'agent', sourceSurface: 'telegram', now: NOW })
    if (!created.ok) throw new Error('seed failed')
    const saved = store.saveWorkerIdentity(created.row.id, created.row.revision, {
      workerSessionId: 'child-1', workerRunId: 'run-1', workerParentSessionId: 'session-telegram',
    })
    if (!saved.ok) throw new Error('save failed')
    const active = store.markAgentActive(saved.row.id, saved.row.revision)
    if (!active.ok) throw new Error('active failed')
    const paused = store.pauseAgent(active.row.id, active.row.revision)
    if (!paused.ok) throw new Error('pause failed')
    await expect(tools.get('assistant_task_update')!.execute({
      action: 'resume', commitmentId: created.row.id, nextAction: 123,
    }, exec())).rejects.toThrow(/nextAction.*string/)
    expect(store.getById(created.row.id)?.status).toBe('paused')
    store.close()
  })

  it('web mode cannot see or control Telegram agent responsibilities', async () => {
    const store = new AssistantStore(join(tempDir(), 's.sqlite'))
    const tgAgent = fakeAgent()
    const worker = makeWorker(tgAgent, store)
    const created = store.createAgentCommitment({ title: 'agent', sourceSurface: 'telegram', now: NOW })
    if (!created.ok) throw new Error('seed failed')
    const saved = store.saveWorkerIdentity(created.row.id, created.row.revision, {
      workerSessionId: 'child-1', workerRunId: 'run-1', workerParentSessionId: 'session-telegram',
    })
    if (!saved.ok) throw new Error('save failed')
    store.markAgentActive(created.row.id, saved.row.revision)
    // A separate WEB registration shares the same store.
    const { tools } = register(store, 'web')
    for (const action of ['pause', 'resume', 'cancel'] as const) {
      const out = asError(await tools.get('assistant_task_update')!.execute({ action }, exec()))
      expect(out.code).toBe('no_current_commitment')
    }
    store.close()
  })

  it('pause from telegram really interrupts via the worker', async () => {
    const store = new AssistantStore(join(tempDir(), 's.sqlite'))
    const agent = fakeAgent()
    const worker = makeWorker(agent, store)
    const { tools } = register(store, 'telegram', worker)
    const created = store.createAgentCommitment({ title: 'agent', sourceSurface: 'telegram', now: NOW })
    if (!created.ok) throw new Error('seed failed')
    const saved = store.saveWorkerIdentity(created.row.id, created.row.revision, {
      workerSessionId: 'child-1', workerRunId: 'run-1', workerParentSessionId: 'session-telegram',
    })
    if (!saved.ok) throw new Error('save failed')
    store.markAgentActive(created.row.id, saved.row.revision)
    const out = await tools.get('assistant_task_update')!.execute({ action: 'pause' }, exec())
    expect((out as MutationOutput).current.status).toBe('paused')
    expect(store.getCurrent()?.workerControlState).toBe('pause_requested')
    store.close()
  })
})

describe('assistant_delegate_task', () => {
  it('delegates quickly with the acceptance reply and activates', async () => {
    const store = new AssistantStore(join(tempDir(), 's.sqlite'))
    const agent = fakeAgent()
    const worker = makeWorker(agent, store)
    const { tools } = register(store, 'telegram', worker)
    const out = await tools.get('assistant_delegate_task')!.execute(
      { title: '查资料', prompt: '查 Y 并汇报', nextAction: '等待结果' },
      { agent, signal: new AbortController().signal },
    )
    expect(asError(out).code).toBeUndefined()
    const result = out as MutationOutput
    expect(result.current.workOwner).toBe('agent')
    expect(result.current.status).toBe('active')
    expect(result.reply).toContain('归属：我来做')
    expect(result.reply).toContain('我已经接下这件事')
    const row = store.getCurrent()!
    expect(row.workerSessionId).toBe('child-1')
    store.close()
  })

  it('a failed start returns worker_start_failed and never claims acceptance', async () => {
    const store = new AssistantStore(join(tempDir(), 's.sqlite'))
    const agent = fakeAgent()
    const worker = makeWorker(agent, store, { startFails: new Error('boom') })
    const { tools } = register(store, 'telegram', worker)
    const out = asError(await tools.get('assistant_delegate_task')!.execute(
      { title: '查资料', prompt: '查 Y' },
      { agent, signal: new AbortController().signal },
    ))
    expect(out.code).toBe('worker_start_failed')
    expect(out.message).not.toContain('已接下')
    expect(store.getCurrent()?.status).toBe('blocked')
    store.close()
  })

  it('rejects empty prompt and invalid title', async () => {
    const store = new AssistantStore(join(tempDir(), 's.sqlite'))
    const agent = fakeAgent()
    const worker = makeWorker(agent, store)
    const { tools } = register(store, 'telegram', worker)
    const exec2 = { agent, signal: new AbortController().signal }
    expect(asError(await tools.get('assistant_delegate_task')!.execute({ title: 't', prompt: '  ' }, exec2)).code).toBe('invalid_transition')
    expect(asError(await tools.get('assistant_delegate_task')!.execute({ title: '', prompt: 'p' }, exec2)).code).toBe('invalid_transition')
    store.close()
  })
})
