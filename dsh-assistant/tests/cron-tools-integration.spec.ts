import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { AssistantStore } from '../src/store.ts'
import { registerAssistantTools, type AssistantToolError } from '../src/tools.ts'

const dirs: string[] = []
const NOW = '2026-08-18T08:00:00.000Z'

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function store(): AssistantStore {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-assistant-cron-tools-'))
  dirs.push(dir)
  return new AssistantStore(join(dir, 'assistant.sqlite'))
}

type ToolDefinition = {
  name: string
  execute(args: Record<string, unknown>, exec: { agent?: Agent; signal: AbortSignal }): Promise<unknown>
}

type CronControl = {
  bindMonitor(input: Record<string, unknown>): Promise<unknown>
  resumeMonitor(input: Record<string, unknown>): Promise<unknown>
  pauseMonitor(commitmentId: string): Promise<unknown>
  cancelMonitor(commitmentId: string): Promise<unknown>
  reviseMonitor(input: Record<string, unknown>): Promise<unknown>
}

function register(storeValue: AssistantStore, cronControl: CronControl) {
  const tools = new Map<string, ToolDefinition>()
  const registerTool = (definition: ToolDefinition): (() => void) => {
    tools.set(definition.name, definition)
    return () => tools.delete(definition.name)
  }
  const delegate = vi.fn(async () => ({ ok: false, code: 'worker_called', message: 'monitor must not use WorkerController' }))
  const pause = vi.fn(() => ({ ok: false, code: 'worker_called', message: 'monitor must not use WorkerController' }))
  const resume = vi.fn(async () => ({ ok: false, code: 'worker_called', message: 'monitor must not use WorkerController' }))
  const cancel = vi.fn(() => ({ ok: false, code: 'worker_called', message: 'monitor must not use WorkerController' }))
  const replaceMonitorDirection = vi.fn(async () => ({ ok: false, code: 'worker_called', message: 'monitor must not use WorkerController' }))
  const dispose = registerAssistantTools(
    { tools: { register: registerTool } },
    {
      store: storeValue,
      mode: 'telegram',
      // This deliberately is only a fake WorkerController-shaped object. If
      // a Cron-bound route reaches it, the test gets a visible failure.
      worker: { delegate, pause, resume, cancel, replaceMonitorDirection } as never,
      cronControl: cronControl as never,
      now: () => Date.parse(NOW),
    },
  )
  return { tools, dispose, worker: { delegate, pause, resume, cancel, replaceMonitorDirection } }
}

function exec(): { agent: Agent; signal: AbortSignal } {
  return { agent: {} as Agent, signal: new AbortController().signal }
}

const ok = () => ({ ok: true, snapshot: { activeJob: { id: 'job-1' } } })

function activeMonitor(storeValue: AssistantStore, suffix: string): string {
  const created = storeValue.createAgentCommitment({
    title: `monitor-${suffix}`,
    kind: 'monitor',
    monitorDirection: '检查明确目标并汇报有界事实',
    sourceSurface: 'telegram',
    now: NOW,
  })
  if (!created.ok) throw new Error(created.message)
  const active = storeValue.markAgentActive(created.row.id, created.row.revision)
  if (!active.ok) throw new Error(active.message)
  const binding = storeValue.createCronBinding({
    commitmentId: created.row.id,
    externalRef: `assistant:${created.row.id}`,
    desiredScheduleJson: JSON.stringify({ kind: 'cron', expr: '0 * * * *' }),
    desiredPrompt: '检查明确目标并汇报有界事实',
    desiredState: 'running',
    updatedAt: NOW,
  })
  if (!binding.ok) throw new Error(binding.message)
  return created.row.id
}

function unboundMonitor(storeValue: AssistantStore, suffix: string, status: 'blocked' | 'paused' = 'blocked'): string {
  const created = storeValue.createAgentCommitment({
    title: `unbound-monitor-${suffix}`,
    kind: 'monitor',
    monitorDirection: '检查明确目标并汇报有界事实',
    sourceSurface: 'telegram',
    now: NOW,
  })
  if (!created.ok) throw new Error(created.message)
  const active = storeValue.markAgentActive(created.row.id, created.row.revision)
  if (!active.ok) throw new Error(active.message)
  const parked = storeValue.setCommitmentStatus(created.row.id, status)
  if (parked === undefined) throw new Error(`failed to park monitor as ${status}`)
  return created.row.id
}

describe('Telegram tool registration for Cron-bound monitors', () => {
  it('monitor creation requires an explicit schedule and routes to Cron without a worker', async () => {
    const assistantStore = store()
    const cronControl: CronControl = {
      bindMonitor: vi.fn(async () => ok()),
      resumeMonitor: vi.fn(async () => ok()),
      pauseMonitor: vi.fn(async () => ok()),
      cancelMonitor: vi.fn(async () => ok()),
      reviseMonitor: vi.fn(async () => ok()),
    }
    const registered = register(assistantStore, cronControl)
    const tool = registered.tools.get('assistant_delegate_task')!

    const missingSchedule = await tool.execute({ title: '定时观察', prompt: '检查明确目标', kind: 'monitor' }, exec()) as AssistantToolError
    expect(missingSchedule.code).toBe('schedule_required')
    expect(cronControl.bindMonitor).not.toHaveBeenCalled()
    expect(registered.worker.delegate).not.toHaveBeenCalled()
    expect(assistantStore.listTelegramAgentResponsibilities(20)).toHaveLength(0)

    const accepted = await tool.execute({
      title: '定时观察',
      prompt: '检查明确目标',
      kind: 'monitor',
      schedule: { kind: 'cron', expr: '0 * * * *' },
    }, exec()) as { current: { kind: string }; reply: string }
    expect(accepted.current.kind).toBe('monitor')
    expect(cronControl.bindMonitor).toHaveBeenCalledWith(expect.objectContaining({
      schedule: { kind: 'cron', expr: '0 * * * *' },
    }))
    expect(registered.worker.delegate).not.toHaveBeenCalled()
    registered.dispose()
    assistantStore.close()
  })

  it('pause/resume/cancel/revise_monitor all use the injected Cron control use case', async () => {
    const assistantStore = store()
    const cronControl: CronControl = {
      bindMonitor: vi.fn(async () => ok()),
      resumeMonitor: vi.fn(async () => ok()),
      pauseMonitor: vi.fn(async () => ok()),
      cancelMonitor: vi.fn(async () => ok()),
      reviseMonitor: vi.fn(async () => ok()),
    }
    const registered = register(assistantStore, cronControl)
    const update = registered.tools.get('assistant_task_update')!

    const pauseId = activeMonitor(assistantStore, 'pause')
    await update.execute({ action: 'pause', commitmentId: pauseId }, exec())
    expect(cronControl.pauseMonitor).toHaveBeenCalledWith(pauseId)
    expect(registered.worker.pause).not.toHaveBeenCalled()

    const resumeId = activeMonitor(assistantStore, 'resume')
    assistantStore.setCommitmentStatus(resumeId, 'paused')
    await update.execute({ action: 'resume', commitmentId: resumeId }, exec())
    expect(cronControl.resumeMonitor).toHaveBeenCalledWith({ commitmentId: resumeId })
    expect(registered.worker.resume).not.toHaveBeenCalled()

    const cancelId = activeMonitor(assistantStore, 'cancel')
    await update.execute({ action: 'cancel', commitmentId: cancelId }, exec())
    expect(cronControl.cancelMonitor).toHaveBeenCalledWith(cancelId)
    expect(registered.worker.cancel).not.toHaveBeenCalled()

    const reviseId = activeMonitor(assistantStore, 'revise')
    await update.execute({ action: 'revise_monitor', commitmentId: reviseId, direction: '只汇报新的明确目标' }, exec())
    expect(cronControl.reviseMonitor).toHaveBeenCalledWith({ commitmentId: reviseId, direction: '只汇报新的明确目标' })
    expect(registered.worker.replaceMonitorDirection).not.toHaveBeenCalled()

    registered.dispose()
    assistantStore.close()
  })

  it('requires an explicit schedule for an unbound legacy monitor and keeps the failure side-effect free', async () => {
    const assistantStore = store()
    const cronControl: CronControl = {
      bindMonitor: vi.fn(async () => ok()),
      resumeMonitor: vi.fn(async () => ok()),
      pauseMonitor: vi.fn(async () => ok()),
      cancelMonitor: vi.fn(async () => ok()),
      reviseMonitor: vi.fn(async () => ok()),
    }
    const registered = register(assistantStore, cronControl)
    const update = registered.tools.get('assistant_task_update')!
    const monitorId = unboundMonitor(assistantStore, 'legacy')

    const result = await update.execute({ action: 'resume', commitmentId: monitorId }, exec()) as AssistantToolError
    expect(result).toMatchObject({ code: 'schedule_required' })
    expect(cronControl.resumeMonitor).not.toHaveBeenCalled()
    expect(registered.worker.resume).not.toHaveBeenCalled()
    expect(assistantStore.getCronBinding(monitorId)).toBeUndefined()
    expect(assistantStore.getById(monitorId)).toMatchObject({ status: 'blocked' })

    registered.dispose()
    assistantStore.close()
  })

  it('rebinds an unbound legacy monitor only through Cron when the user supplies a valid schedule', async () => {
    const assistantStore = store()
    const cronControl: CronControl = {
      bindMonitor: vi.fn(async () => ok()),
      resumeMonitor: vi.fn(async () => ok()),
      pauseMonitor: vi.fn(async () => ok()),
      cancelMonitor: vi.fn(async () => ok()),
      reviseMonitor: vi.fn(async () => ok()),
    }
    const registered = register(assistantStore, cronControl)
    const update = registered.tools.get('assistant_task_update')!
    const monitorId = unboundMonitor(assistantStore, 'explicit')
    const schedule = { kind: 'interval', minutes: 30 }

    await update.execute({ action: 'resume', commitmentId: monitorId, schedule }, exec())
    expect(cronControl.resumeMonitor).toHaveBeenCalledWith({ commitmentId: monitorId, schedule })
    expect(registered.worker.resume).not.toHaveBeenCalled()
    expect(assistantStore.getCronBinding(monitorId)).toBeUndefined()

    registered.dispose()
    assistantStore.close()
  })

  it('rejects malformed Cron schedules locally before commitment persistence, RPC, or WorkerController side effects', async () => {
    const assistantStore = store()
    const cronControl: CronControl = {
      bindMonitor: vi.fn(async () => ok()),
      resumeMonitor: vi.fn(async () => ok()),
      pauseMonitor: vi.fn(async () => ok()),
      cancelMonitor: vi.fn(async () => ok()),
      reviseMonitor: vi.fn(async () => ok()),
    }
    const registered = register(assistantStore, cronControl)
    const tool = registered.tools.get('assistant_delegate_task')!
    const invalidSchedules: unknown[] = [
      { kind: 'cron', expr: '' },
      { kind: 'cron', expr: 'not a five-field cron' },
      { kind: 'interval', minutes: 0 },
      { kind: 'interval', minutes: 1.5 },
      { kind: 'interval', minutes: 'not-a-number' },
      { kind: 'once', runAt: '' },
      { kind: 'once', runAt: 'not-an-ISO-date' },
      { kind: 'once', runAt: 123 },
      { kind: 'unknown', value: 'anything' },
      null,
      ['interval', 15],
    ]

    for (const [index, schedule] of invalidSchedules.entries()) {
      const result = await tool.execute({
        title: `非法 schedule ${index}`,
        prompt: '检查明确目标',
        kind: 'monitor',
        schedule,
      }, exec()) as AssistantToolError
      expect(result, `schedule ${JSON.stringify(schedule)} must be rejected`).toMatchObject({ code: 'invalid_transition' })
    }
    expect(cronControl.bindMonitor).not.toHaveBeenCalled()
    expect(registered.worker.delegate).not.toHaveBeenCalled()
    expect(assistantStore.listTelegramAgentResponsibilities(20)).toHaveLength(0)

    registered.dispose()
    assistantStore.close()
  })

  it('keeps ordinary delegated work on WorkerController and exposes Cron control failure', async () => {
    const assistantStore = store()
    const cronControl: CronControl = {
      bindMonitor: vi.fn(async () => ({ ok: false, code: 'control_unavailable', message: 'socket unavailable' })),
      resumeMonitor: vi.fn(async () => ok()),
      pauseMonitor: vi.fn(async () => ok()),
      cancelMonitor: vi.fn(async () => ok()),
      reviseMonitor: vi.fn(async () => ok()),
    }
    const registered = register(assistantStore, cronControl)
    const delegate = registered.tools.get('assistant_delegate_task')!

    const failed = await delegate.execute({
      title: 'Cron 失败', prompt: '检查目标', kind: 'monitor', schedule: { kind: 'interval', minutes: 30 },
    }, exec()) as AssistantToolError
    expect(failed.code).toBe('control_unavailable')
    expect(failed.message).not.toContain('已接下')
    expect(registered.worker.delegate).not.toHaveBeenCalled()

    const ordinary = await delegate.execute({ title: '普通委派', prompt: '完成一次任务', kind: 'delegated' }, exec())
    expect(registered.worker.delegate).toHaveBeenCalledOnce()
    expect(cronControl.bindMonitor).toHaveBeenCalledOnce()
    expect((ordinary as AssistantToolError).code).toBe('worker_called')

    registered.dispose()
    assistantStore.close()
  })
})
