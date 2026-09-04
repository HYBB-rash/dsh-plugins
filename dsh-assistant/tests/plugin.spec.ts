/**
 * Plugin integration tests (src/index.ts): mounting the real apply() on a
 * real Cordis context with provided fakes.
 *
 * Rework coverage (验收返工指南 §4-§5):
 * - A. root isolation: no global assistant tools; only qualified interactive
 *      roots get tools/prompt/lifecycle; session-cron-* roots get nothing;
 *      future roots follow the same rule; no duplicate install.
 * - B. concurrent responsibilities: one Telegram root can hand off multiple
 *      responsibilities without a turn-wide guard; cron roots stay isolated.
 * - C. worker notice sink: agent/pre-step filters own subagent-report /
 *      subagent-settled notices without a model request; mixed batches keep
 *      user messages; other children are preserved; closed workers are still
 *      recognized; store failures fail open.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as plugin from '../src/index.ts'
import { ASSISTANT_PERSONA, createWorkerNoticeSink, promptSectionText, STABLE_CONTRACT } from '../src/index.ts'
import { AssistantStore } from '../src/store.ts'

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-assistant-plugin-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const NOW = '2026-08-15T02:00:00.000Z'

interface ToolDef {
  name: string
  execute(args: unknown, exec: unknown): Promise<unknown>
  description?: string
}

/** Guard verdict helper shape. */
type GuardResult = string | undefined

/** A fake agent-scoped context: listeners, effects, tools, guards, sections. */
function fakeAgentCtx() {
  const listeners = new Map<string, Array<(payload: unknown) => void>>()
  const tools = new Map<string, ToolDef>()
  const sections: Array<{ name: string; order: number; text: string | (() => string) }> = []
  const cleanups: Array<() => void> = []
  const guards: Array<(exec: unknown) => GuardResult> = []
  return {
    on(name: string, fn: (payload: unknown) => void) {
      const arr = listeners.get(name) ?? []
      arr.push(fn)
      listeners.set(name, arr)
      return () => {
        const idx = arr.indexOf(fn)
        if (idx >= 0) arr.splice(idx, 1)
      }
    },
    effect(fn: () => void | (() => void)) {
      const cleanup = fn() ?? (() => {})
      cleanups.push(cleanup)
      let done = false
      return () => {
        if (done) return
        done = true
        cleanup()
      }
    },
    tools: {
      register(def: ToolDef) {
        tools.set(def.name, def)
        return () => {
          tools.delete(def.name)
        }
      },
      guard(fn: (exec: unknown) => GuardResult) {
        guards.push(fn)
        return () => {
          const idx = guards.indexOf(fn)
          if (idx >= 0) guards.splice(idx, 1)
        }
      },
      schemas: () => [...tools.keys()].map(name => ({ name })),
    },
    systemPrompt: {
      section(section: { name: string; order: number; text: string | (() => string) }) {
        sections.push(section)
        let active = true
        return () => {
          active = false
          const idx = sections.indexOf(section)
          if (idx >= 0) sections.splice(idx, 1)
        }
      },
    },
    emit(name: string, payload: unknown) {
      for (const fn of listeners.get(name) ?? []) fn(payload)
    },
    /** Simulate one tool dispatch: guards first, then the body (zero side effects when denied). */
    _executeTool(name: string, args: unknown, exec: unknown): { denied: string } | { value: unknown } {
      for (const guard of guards) {
        const reason = guard(exec)
        if (reason !== undefined) return { denied: reason }
      }
      const def = tools.get(name)
      if (def === undefined) return { denied: `unknown tool ${name}` }
      return Promise.resolve(def.execute(args, exec)).then(value => ({ value })) as never
    },
    // introspection
    _tools: tools,
    _sections: sections,
    _cleanups: cleanups,
    _listeners: listeners,
    _guards: guards,
  }
}

function fakeAgent(id = 'session-telegram') {
  const ctx = fakeAgentCtx()
  const agent = {
    id: SessionId(id),
    session: { id: SessionId(id) },
    ctx,
    _emit(name: string, payload: unknown) {
      ctx.emit(name, payload)
    },
  }
  return agent as unknown as Agent & { ctx: ReturnType<typeof fakeAgentCtx>; _emit(name: string, payload: unknown): void }
}

interface FakeRegistry {
  roots(): Agent[]
  get(id: string): Agent | undefined
  add(agent: Agent): void
}

function fakeRegistry(initial: Agent[] = []) {
  const agents = new Map<string, Agent>()
  for (const agent of initial) agents.set(agent.id, agent)
  const registry: FakeRegistry = {
    roots: () => [...agents.values()],
    get: id => agents.get(id),
    add: agent => {
      agents.set(agent.id, agent)
    },
  }
  return registry
}

async function mount(
  config: { mode: 'web' | 'telegram' },
  agents: Agent[],
  overrides: {
    deliveryProvider?: unknown
    storePath?: string
  } = {},
) {
  const ctx = new Context()
  const registry = fakeRegistry(agents)
  const toolRegistry = new Map<string, unknown>()
  let childSeq = 0
  ctx.provide('agents', registry as never)
  let resumedRunSeq = 100
  const subagents = {
    startContinuable: vi.fn(async (spec: { request: { parent: Agent & { _emit?: (name: string, payload: unknown) => void } } }) => {
      childSeq++
      const childId = `child-${childSeq}`
      spec.request.parent._emit?.('subagent/start', { runId: `run-${childSeq}`, provider: 'spawn', id: childId, local: true })
      return { childId: SessionId(childId), messageId: `m${childSeq}` }
    }),
    interrupt: vi.fn(),
    followup: vi.fn(async (parent: Agent & { _emit?: (name: string, payload: unknown) => void }, childId: string) => {
      resumedRunSeq++
      parent._emit?.('subagent/start', { runId: `run-${resumedRunSeq}`, provider: 'spawn', id: childId, local: true })
      return `m${resumedRunSeq}`
    }),
  }
  ctx.provide('subagents', subagents as never)
  if (overrides.deliveryProvider !== undefined) {
    ctx.provide('dshTextDeliveryV1' as never, overrides.deliveryProvider as never)
  }
  ctx.provide('tools', {
    register: (def: { name: string }) => {
      toolRegistry.set(def.name, def)
      return () => {
        toolRegistry.delete(def.name)
      }
    },
  } as never)
  ctx.provide('systemPrompt', { section: () => () => {} } as never)
  const mounted = await ctx.plugin(plugin, {
    mode: config.mode,
    storePath: overrides.storePath ?? join(tempDir(), 'state.sqlite'),
    pollIntervalMs: 1000,
    ...config.mode === 'telegram' ? { telegramParentSessionId: 'session-telegram' } : {},
  } as never)
  return { ctx, mounted, registry, toolRegistry, subagents }
}

function seedRecoverableMonitor(storePath: string): string {
  const store = new AssistantStore(storePath)
  const created = store.createAgentCommitment({ title: 'continuous monitor', kind: 'monitor', monitorDirection: '持续观察该 workspace', sourceSurface: 'telegram', now: NOW })
  if (!created.ok) throw new Error('monitor seed failed')
  const saved = store.saveWorkerIdentity(created.row.id, created.row.revision, {
    workerSessionId: 'child-monitor', workerRunId: 'run-old', workerParentSessionId: 'session-telegram',
  })
  if (!saved.ok) throw new Error('monitor identity failed')
  const active = store.markAgentActive(saved.row.id, saved.row.revision)
  if (!active.ok) throw new Error('monitor activate failed')
  store.normalizeAgentOnStartup()
  store.close()
  return created.row.id
}

function seedBoundMonitor(storePath: string): string {
  const store = new AssistantStore(storePath)
  const created = store.createAgentCommitment({ title: 'bound monitor', kind: 'monitor', monitorDirection: '持续观察该 workspace', sourceSurface: 'telegram', now: NOW })
  if (!created.ok) throw new Error('bound monitor seed failed')
  const active = store.markAgentActive(created.row.id, created.row.revision)
  if (!active.ok) throw new Error('bound monitor activate failed')
  const binding = store.createCronBinding({
    commitmentId: created.row.id,
    externalRef: `assistant:${created.row.id}`,
    desiredScheduleJson: JSON.stringify({ kind: 'interval', minutes: 15 }),
    desiredState: 'running',
    boundJobId: 'cron-bound-monitor-1',
    updatedAt: NOW,
  })
  if (!binding.ok) throw new Error('cron binding failed')
  store.close()
  return created.row.id
}

/** Run one agent/pre-step listener with a scripted next(). */
async function runPreStep(
  agent: Agent & { ctx: { _listeners: Map<string, Array<(payload: unknown, next: () => Promise<unknown>) => Promise<unknown> | unknown>> } },
  messages: unknown[],
) {
  let nextCalled = 0
  const next = async () => {
    nextCalled++
    return { kind: 'enter', messages } as const
  }
  const listeners = agent.ctx._listeners.get('agent/pre-step') ?? []
  const decisions: Array<{ kind: string; messages?: unknown[] }> = []
  for (const listener of listeners) {
    const decision = await listener({ agent, messages, turn: 1, step: 1, signal: new AbortController().signal }, next)
    decisions.push(decision as { kind: string; messages?: unknown[] })
  }
  return { decisions, nextCalled }
}

let reportSeq = 0
function ownReportMessage(senderSessionId: string, id = `report-${++reportSeq}`, text = '阶段进度'): {
  id: string; role: string; content: Array<{ type: string; text: string }>; source: { kind: string; senderSessionId: string }
} {
  return { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'subagent-report', senderSessionId } }
}

function ownSettledMessage(senderSessionId: string): { source: { kind: string; senderSessionId: string } } {
  return { source: { kind: 'subagent-settled', senderSessionId } }
}

function userMessage(): { source: { kind: string } } {
  return { source: { kind: 'user' } }
}

describe('A. root isolation', () => {
  it('does not auto-start an unbound legacy monitor during startup; only explicit Cron binding may resume it', async () => {
    const storePath = join(tempDir(), 'unbound-legacy-monitor.sqlite')
    const seed = new AssistantStore(storePath)
    const created = seed.createAgentCommitment({
      title: 'unbound legacy monitor',
      kind: 'monitor',
      monitorDirection: 'startup direction',
      sourceSurface: 'telegram',
      now: NOW,
    })
    if (!created.ok) throw new Error('monitor seed failed')
    const active = seed.markAgentActive(created.row.id, created.row.revision)
    if (!active.ok) throw new Error('monitor activation failed')
    seed.close()

    const tg = fakeAgent('session-telegram')
    const { mounted, subagents } = await mount({ mode: 'telegram' }, [tg], { storePath })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(subagents.startContinuable).not.toHaveBeenCalled()
    expect(subagents.followup).not.toHaveBeenCalled()

    const after = new AssistantStore(storePath)
    const row = after.getById(created.row.id)
    expect(row).toMatchObject({ workerSessionId: null })
    expect(row).toMatchObject({ status: 'blocked' })
    expect(row?.blockedReason).toContain('未绑定 Cron')
    expect(row?.blockedReason).toContain('schedule')
    expect(after.getCronBinding(created.row.id)).toBeUndefined()
    after.close()
    await mounted.dispose()
  })

  it('registers no assistant tools on the global context', async () => {
    const { mounted, toolRegistry } = await mount({ mode: 'telegram' }, [fakeAgent('session-telegram')])
    expect([...toolRegistry.keys()].some(name => name.startsWith('assistant_'))).toBe(false)
    expect(toolRegistry.size).toBe(0)
    await mounted.dispose()
  })

  it('a web root gets the three tools and the prompt on its own agent.ctx', async () => {
    const web = fakeAgent('session-web')
    const { mounted } = await mount({ mode: 'web' }, [web])
    const names = [...web.ctx._tools.keys()].sort()
    expect(names).toEqual([
      'assistant_task_status',
      'assistant_task_update',
      'assistant_track_task',
    ])
    expect(web.ctx._sections.some(s => s.name === 'assistant:current-commitment')).toBe(true)
    await mounted.dispose()
  })

  it('the telegram session-telegram root gets five tools, prompt and lifecycle on its own agent.ctx', async () => {
    const tg = fakeAgent('session-telegram')
    const { mounted } = await mount({ mode: 'telegram' }, [tg])
    const names = [...tg.ctx._tools.keys()].sort()
    expect(names).toEqual([
      'assistant_delegate_task',
      'assistant_task_status',
      'assistant_task_update',
      'assistant_track_task',
      'assistant_web_task_status',
    ])
    expect(tg.ctx._sections.some(s => s.name === 'assistant:current-commitment')).toBe(true)
    expect(tg.ctx._listeners.has('subagent/start')).toBe(true)
    expect(tg.ctx._listeners.has('subagent/end')).toBe(true)
    await mounted.dispose()
  })

  it('an existing session-cron-* root gets no assistant tools, prompt or worker lifecycle', async () => {
    const cron = fakeAgent('session-cron-test-job')
    const { mounted } = await mount({ mode: 'telegram' }, [cron])
    expect(cron.ctx._tools.size).toBe(0)
    expect(cron.ctx._sections.some(s => s.name === 'assistant:current-commitment')).toBe(false)
    expect(cron.ctx._listeners.has('subagent/start')).toBe(false)
    expect(cron.ctx._listeners.has('subagent/end')).toBe(false)
    await mounted.dispose()
  })

  it('a Web-process session-cron-* root gets neither assistant controls nor the Web observer', async () => {
    const web = fakeAgent('session-web')
    const cron = fakeAgent('session-cron-web-side')
    const { mounted } = await mount({ mode: 'web' }, [web, cron])
    expect(web.ctx._tools.has('assistant_task_status')).toBe(true)
    expect(web.ctx._listeners.has('session/event')).toBe(true)
    expect(cron.ctx._tools.size).toBe(0)
    expect(cron.ctx._sections).toHaveLength(0)
    expect(cron.ctx._listeners.has('session/event')).toBe(false)
    await mounted.dispose()
  })

  it('Web dispose never normalizes Telegram Agent responsibilities', async () => {
    const storePath = join(tempDir(), 'web-dispose.sqlite')
    const seed = new AssistantStore(storePath)
    const created = seed.createAgentCommitment({ title: 'telegram work', sourceSurface: 'telegram', now: NOW })
    if (!created.ok) throw new Error('seed failed')
    const saved = seed.saveWorkerIdentity(created.row.id, created.row.revision, {
      workerSessionId: 'child-web-dispose', workerRunId: 'run-1', workerParentSessionId: 'session-telegram',
    })
    if (!saved.ok) throw new Error('identity failed')
    const active = seed.markAgentActive(saved.row.id, saved.row.revision)
    if (!active.ok) throw new Error('activate failed')
    seed.close()
    const web = fakeAgent('session-web')
    const { mounted } = await mount({ mode: 'web' }, [web], { storePath })
    await mounted.dispose()
    const after = new AssistantStore(storePath)
    expect(after.getById(created.row.id)).toMatchObject({ status: 'active', workerSessionId: 'child-web-dispose' })
    after.close()
  })

  it('a Web root observer ignores session events from any other session object', async () => {
    const storePath = join(tempDir(), 'web-scope.sqlite')
    const web = fakeAgent('session-web')
    const { mounted } = await mount({ mode: 'web' }, [web], { storePath })
    const handler = web.ctx._listeners.get('session/event')?.[0] as ((session: unknown, event: unknown) => void) | undefined
    expect(handler).toBeDefined()
    handler?.({ id: SessionId('child-or-other') }, { type: 'turn/start', data: { turn: 1 } })
    handler?.(web.session, { type: 'turn/start', data: { turn: 2 } })
    const store = new AssistantStore(storePath)
    expect(store.getWebObservation('child-or-other')).toBeUndefined()
    expect(store.getWebObservation('session-web')).toMatchObject({ turn: 2, state: 'running' })
    store.close()
    await mounted.dispose()
  })

  it('a future telegram root is installed; a future cron root is skipped', async () => {
    const { ctx, mounted, registry } = await mount({ mode: 'telegram' }, [])
    const laterTg = fakeAgent('session-telegram')
    registry.add(laterTg)
    ctx.emit('agent/created' as never, { agent: laterTg } as never)
    expect(laterTg.ctx._tools.has('assistant_delegate_task')).toBe(true)
    expect(laterTg.ctx._sections.some(s => s.name === 'assistant:current-commitment')).toBe(true)

    const laterCron = fakeAgent('session-cron-future')
    registry.add(laterCron)
    ctx.emit('agent/created' as never, { agent: laterCron } as never)
    expect(laterCron.ctx._tools.size).toBe(0)
    expect(laterCron.ctx._sections.some(s => s.name === 'assistant:current-commitment')).toBe(false)
    await mounted.dispose()
  })

  it('does not cold-resume a bound monitor; dsh-cron remains the only monitor clock and worker owner', async () => {
    const storePath = join(tempDir(), 'existing-monitor.sqlite')
    const commitmentId = seedBoundMonitor(storePath)
    const tg = fakeAgent('session-telegram')
    const { mounted, subagents } = await mount({ mode: 'telegram' }, [tg], { storePath })
    expect(subagents.startContinuable).not.toHaveBeenCalled()
    expect(subagents.followup).not.toHaveBeenCalled()
    const store = new AssistantStore(storePath)
    const row = store.getById(commitmentId)
    expect(row).toMatchObject({ kind: 'monitor', status: 'active', workerSessionId: null })
    expect(store.getCronBinding(commitmentId)).toMatchObject({
      boundJobId: 'cron-bound-monitor-1', desiredState: 'running',
    })
    store.close()
    await mounted.dispose()
  })

  it('does not auto-resume an unbound legacy monitor when the fixed root appears later', async () => {
    const storePath = join(tempDir(), 'future-monitor.sqlite')
    const commitmentId = seedRecoverableMonitor(storePath)
    const { ctx, mounted, registry, subagents } = await mount({ mode: 'telegram' }, [], { storePath })
    expect(subagents.followup).not.toHaveBeenCalled()
    const later = fakeAgent('session-telegram')
    registry.add(later)
    ctx.emit('agent/created' as never, { agent: later } as never)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(subagents.startContinuable).not.toHaveBeenCalled()
    expect(subagents.followup).not.toHaveBeenCalled()
    const store = new AssistantStore(storePath)
    const row = store.getById(commitmentId)
    expect(row).toMatchObject({ kind: 'monitor', workerSessionId: null })
    expect(row).toMatchObject({ status: 'blocked' })
    expect(row?.blockedReason).toContain('未绑定 Cron')
    expect(row?.blockedReason).toContain('schedule')
    expect(store.getCronBinding(commitmentId)).toBeUndefined()
    store.close()
    await mounted.dispose()
  })

  it('keeps monitor lifecycle scheduling out of the assistant plugin composition root', () => {
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/monitorTick|continueMonitors|recoverMonitors|startContinuable/)
  })

  it('the telegram root gets the assistant persona at order 0; cron roots get no persona', async () => {
    const tg = fakeAgent('session-telegram')
    const cron = fakeAgent('session-cron-x')
    const { mounted } = await mount({ mode: 'telegram' }, [tg, cron])
    const tgPersona = tg.ctx._sections.find(s => s.order === 0)
    expect(tgPersona).toBeDefined()
    if (tgPersona !== undefined) {
      const text = typeof tgPersona.text === 'function' ? tgPersona.text() : tgPersona.text
      expect(text).toContain('always-on private personal assistant')
      expect(text).toContain('authoritative only for responsibilities dsh-assistant is tracking')
      expect(text).toContain('not the user\'s complete personal task list')
      expect(text).toContain('independent Web conversation')
    }
    expect(cron.ctx._sections.some(s => s.order === 0)).toBe(false)
    await mounted.dispose()
  })

  it('the telegram persona carries the message-level expression rules', async () => {
    const tg = fakeAgent('session-telegram')
    const { mounted } = await mount({ mode: 'telegram' }, [tg])
    const tgPersona = tg.ctx._sections.find(s => s.name === 'assistant:persona')
    expect(tgPersona).toBeDefined()
    if (tgPersona !== undefined) {
      const text = typeof tgPersona.text === 'function' ? tgPersona.text() : tgPersona.text
      expect(text).toContain('Telegram sends each complete assistant text that accompanies a tool call as an immediate, immutable user-visible message.')
      expect(text).toContain('Before calling tools, include user-visible text only when it is a complete, useful update that can stand on its own; omit trivial tool narration.')
      expect(text).toContain('Each later message must add progress, a correction, a result, or closure; do not mechanically repeat earlier messages in the final answer.')
    }
    await mounted.dispose()
  })

  it('the monitor persona delegates empty/no-change outcomes to Cron success+silent without pseudo event fields or auto-continue', () => {
    expect(STABLE_CONTRACT).toContain('success+silent')
    expect(STABLE_CONTRACT).toContain('无更新')
    expect(STABLE_CONTRACT).not.toMatch(/eventKey|checkpoint/)
    expect(STABLE_CONTRACT).not.toContain('自动继续')
    expect(ASSISTANT_PERSONA).not.toContain('eventKey')
    expect(ASSISTANT_PERSONA).not.toContain('checkpoint')
  })

  it('the Telegram expression rules never leak into the stable contract or a web root', async () => {
    const web = fakeAgent('session-web')
    const { mounted } = await mount({ mode: 'web' }, [web])
    // Web root 只有责任合同/承诺正文，绝不安装 Telegram persona
    expect(web.ctx._sections.some(s => s.name === 'assistant:persona')).toBe(false)
    // STABLE_CONTRACT 是 Web/cron/worker 共同依赖的责任合同，不被表达规则污染
    expect(STABLE_CONTRACT).not.toContain('immutable user-visible message')
    expect(STABLE_CONTRACT).not.toContain('complete, useful update')
    expect(STABLE_CONTRACT).not.toContain('do not mechanically repeat earlier messages')
    await mounted.dispose()
  })

  it('duplicate agent/created does not install the section twice', async () => {
    const existing = fakeAgent('session-telegram')
    const { ctx, mounted } = await mount({ mode: 'telegram' }, [existing])
    ctx.emit('agent/created' as never, { agent: existing } as never)
    ctx.emit('agent/created' as never, { agent: existing } as never)
    expect(existing.ctx._sections.filter(s => s.name === 'assistant:current-commitment')).toHaveLength(1)
    await mounted.dispose()
  })
})

describe('B. multiple delegated responsibilities', () => {
  it('one Telegram root can hand off two independent responsibilities without a turn-wide tool guard', async () => {
    const tg = fakeAgent('session-telegram')
    const cron = fakeAgent('session-cron-x')
    const storePath = join(tempDir(), 'state.sqlite')
    const { mounted } = await mount({ mode: 'telegram' }, [tg, cron], { storePath })
    const exec = { agent: tg, signal: new AbortController().signal }
    const spy = vi.fn(async () => 'spy ran')
    tg.ctx.tools.register({ name: 'spy_tool', execute: spy })

    const first = await tg.ctx._executeTool('assistant_delegate_task', { title: 'first', prompt: 'p1' }, exec)
    const second = await tg.ctx._executeTool('assistant_delegate_task', { title: 'second', prompt: 'p2' }, exec)
    expect('value' in first).toBe(true)
    expect('value' in second).toBe(true)
    const plain = await tg.ctx._executeTool('spy_tool', {}, exec)
    expect('denied' in plain).toBe(false)
    expect(spy).toHaveBeenCalledTimes(1)

    const store = new AssistantStore(storePath)
    expect(store.listTelegramAgentResponsibilities(10).map(row => row.title).sort()).toEqual(['first', 'second'])
    store.close()
    expect(tg.ctx._guards).toHaveLength(0)
    expect(cron.ctx._guards).toHaveLength(0)
    expect(cron.ctx._tools.size).toBe(0)
    await mounted.dispose()
  })
})

describe('C. worker notice sink (agent/pre-step filter)', () => {
  async function mountedTg() {
    const tg = fakeAgent('session-telegram')
    const storePath = join(tempDir(), 'state.sqlite')
    const { mounted } = await mount({ mode: 'telegram' }, [tg], { storePath })
    return { tg, mounted, storePath }
  }

  /** Seed a worker commitment (active) whose child id is known. */
  async function seedWorker(storePath: string): Promise<{ commitmentId: string; childId: string }> {
    const store = new AssistantStore(storePath)
    const created = store.createAgentCommitment({ title: 'w', sourceSurface: 'telegram', now: NOW })
    if (!created.ok) throw new Error('seed failed')
    const saved = store.saveWorkerIdentity(created.row.id, created.row.revision, {
      workerSessionId: 'child-own-1',
      workerRunId: 'run-1',
      workerParentSessionId: 'session-telegram',
    })
    if (!saved.ok) throw new Error('save failed')
    store.markAgentActive(created.row.id, saved.row.revision)
    store.close()
    return { commitmentId: created.row.id, childId: 'child-own-1' }
  }

  it('an own subagent-report waking alone yields enter with zero messages (no model request)', async () => {
    const { tg, mounted, storePath } = await mountedTg()
    const { childId } = await seedWorker(storePath)
    const { decisions, nextCalled } = await runPreStep(tg, [ownReportMessage(childId)])
    expect(decisions).toHaveLength(1)
    expect(decisions[0]!.kind).toBe('enter')
    expect(decisions[0]!.messages).toEqual([])
    expect(nextCalled).toBe(0)
    await mounted.dispose()
  })

  it('an own subagent-settled waking alone yields enter with zero messages', async () => {
    const { tg, mounted, storePath } = await mountedTg()
    const { childId } = await seedWorker(storePath)
    const { decisions, nextCalled } = await runPreStep(tg, [ownSettledMessage(childId)])
    expect(decisions[0]!.kind).toBe('enter')
    expect(decisions[0]!.messages).toEqual([])
    expect(nextCalled).toBe(0)
    await mounted.dispose()
  })

  it('report then settled arriving back-to-back still produce zero parent deliveries', async () => {
    const { tg, mounted, storePath } = await mountedTg()
    const { childId } = await seedWorker(storePath)
    const first = await runPreStep(tg, [ownReportMessage(childId)])
    const second = await runPreStep(tg, [ownSettledMessage(childId)])
    expect(first.decisions[0]!.messages).toEqual([])
    expect(second.decisions[0]!.messages).toEqual([])
    await mounted.dispose()
  })

  it('a batch mixing a real user message keeps the user message and removes only own notices', async () => {
    const { tg, mounted, storePath } = await mountedTg()
    const { childId } = await seedWorker(storePath)
    const { decisions } = await runPreStep(tg, [ownSettledMessage(childId), userMessage()])
    expect(decisions[0]!.kind).toBe('enter')
    expect(decisions[0]!.messages).toHaveLength(1)
    expect((decisions[0]!.messages![0] as { source: { kind: string } }).source.kind).toBe('user')
    await mounted.dispose()
  })

  it('a report from another plain child is preserved (delegates to next)', async () => {
    const { tg, mounted } = await mountedTg()
    const { decisions, nextCalled } = await runPreStep(tg, [ownReportMessage('some-other-child')])
    expect(nextCalled).toBeGreaterThan(0)
    expect(decisions[0]!.kind).toBe('enter')
    expect(decisions[0]!.messages).toHaveLength(1)
    await mounted.dispose()
  })

  it('a settled notice for an already-closed worker is still recognized by durable id', async () => {
    const { tg, mounted, storePath } = await mountedTg()
    const { commitmentId, childId } = await seedWorker(storePath)
    // Close the commitment (terminal), then a late settled arrives.
    const store = new AssistantStore(storePath)
    const current = store.getCurrent()!
    store.settleWorkerEnd(current.id, current.revision, {
      status: 'completed', result: 'done', completedAt: NOW, outboxId: 'w1', outboxText: 't',
    })
    store.close()
    expect(store ? true : true).toBe(true)
    const { decisions, nextCalled } = await runPreStep(tg, [ownSettledMessage(childId)])
    expect(decisions[0]!.messages).toEqual([])
    expect(nextCalled).toBe(0)
    await mounted.dispose()
    expect(commitmentId).toBeTruthy()
  })

  it('store query failure fails open: the notice is not swallowed', async () => {
    const sink = createWorkerNoticeSink(
      { ownsWorkerSession: () => { throw new Error('boom') } } as never,
      'session-telegram',
    )
    let nextCalled = 0
    const next = async () => {
      nextCalled++
      return { kind: 'enter', messages: [ownSettledMessage('child-own-1')] } as const
    }
    const decision = await sink({ messages: [ownSettledMessage('child-own-1')] } as never, next)
    expect(nextCalled).toBe(1)
    expect(decision.messages).toHaveLength(1)
  })

  it('integration: report -> valid end -> settled leaves one progress plus one terminal outbox and zero parent deliveries', async () => {
    const { tg, mounted, storePath } = await mountedTg()
    const { childId } = await seedWorker(storePath)
    // report arrives alone -> filtered (no parent delivery)
    const reportStep = await runPreStep(tg, [ownReportMessage(childId)])
    expect(reportStep.decisions[0]!.messages).toEqual([])
    // valid end settles the worker via the lifecycle listener -> one outbox
    const listener = tg.ctx._listeners.get('subagent/end')![0]!
    await listener({
      runId: 'run-1',
      provider: 'spawn',
      id: childId,
      local: true,
      stopReason: 'completed',
      lastAssistantMessage: [{ type: 'text', text: 'DSH_ASSISTANT_RESULT {"status":"completed","summary":"done"}' }],
    })
    // settled arrives after the worker is closed -> still recognized by durable id
    const settledStep = await runPreStep(tg, [ownSettledMessage(childId)])
    expect(settledStep.decisions[0]!.messages).toEqual([])
    const store = new AssistantStore(storePath)
    const outbox = store.listPendingOutbox()
    expect(outbox.map(row => row.kind)).toEqual(['progress', 'completed'])
    expect(store.getCurrent()).toBeUndefined()
    store.close()
    await mounted.dispose()
  })

  it('deduplicates the same report message id but delivers identical text from a new id', async () => {
    const { tg, mounted, storePath } = await mountedTg()
    const { childId } = await seedWorker(storePath)
    await runPreStep(tg, [ownReportMessage(childId, 'p-1', 'same')])
    await runPreStep(tg, [ownReportMessage(childId, 'p-1', 'replay')])
    await runPreStep(tg, [ownReportMessage(childId, 'p-2', 'same')])
    const store = new AssistantStore(storePath)
    expect(store.listPendingOutbox().map(row => [row.id, row.text])).toEqual([
      [`progress:${childId}:p-1`, '🔄 进展：w\n\nsame'],
      [`progress:${childId}:p-2`, '🔄 进展：w\n\nsame'],
    ])
    store.close()
    await mounted.dispose()
  })
})

describe('prompt snapshot', () => {
  type PromptCronRun = {
    readonly runId: string
    readonly jobId: string
    readonly runStatus: 'success' | 'error'
    readonly scheduledFor: string
    readonly finishedAt: string
    readonly deliveryState: 'silent' | 'failed'
    readonly summary?: string
    readonly error?: string
    readonly deliveryError?: string
  }

  function seedBoundPromptMonitor(
    store: AssistantStore,
    suffix: string,
    run: PromptCronRun,
    controlError?: string,
    bindingOverrides: { readonly desiredScheduleJson?: string; readonly desiredCwd?: string } = {},
  ): string {
    const created = store.createAgentCommitment({
      title: `bound Cron prompt ${suffix}`,
      kind: 'monitor',
      monitorDirection: `完整 Cron 方向 ${suffix}`,
      sourceSurface: 'telegram',
      now: NOW,
    })
    if (!created.ok) throw new Error('bound prompt monitor seed failed')
    const saved = store.saveWorkerIdentity(created.row.id, created.row.revision, {
      workerSessionId: `bound-prompt-child-${suffix}`,
      workerRunId: `bound-prompt-worker-${suffix}`,
      workerParentSessionId: 'session-telegram',
    })
    if (!saved.ok) throw new Error('bound prompt worker seed failed')
    const active = store.markAgentActive(saved.row.id, saved.row.revision)
    if (!active.ok) throw new Error('bound prompt activation failed')
    const progress = store.recordWorkerProgress(
      `bound-prompt-child-${suffix}`,
      `bound-prompt-progress-${suffix}`,
      `LEGACY_PROGRESS_MARKER_${suffix}`,
      NOW,
    )
    if (!progress.inserted) throw new Error('bound prompt progress seed failed')
    const afterProgress = store.getById(created.row.id)
    if (afterProgress === undefined) throw new Error('bound prompt monitor disappeared')
    const event = store.settleMonitorEvent({
      commitmentId: created.row.id,
      expectedRevision: afterProgress.revision,
      workerSessionId: `bound-prompt-child-${suffix}`,
      workerRunId: `bound-prompt-worker-${suffix}`,
      workerParentSessionId: 'session-telegram',
      monitorResumeEpoch: afterProgress.monitorResumeEpoch,
      eventKey: `LEGACY_EVENT_KEY_${suffix}`,
      checkpoint: `LEGACY_CHECKPOINT_${suffix}`,
      summary: `LEGACY_EVENT_SUMMARY_${suffix}`,
      outboxText: `LEGACY_OUTBOX_TEXT_${suffix}`,
      now: NOW,
    })
    if (!event.ok) throw new Error('bound prompt legacy event seed failed')
    store.finishOutbox(event.outbox.id, 'failed', { error: `LEGACY_EVENT_DELIVERY_${suffix}` })

    const binding = store.createCronBinding({
      commitmentId: created.row.id,
      externalRef: `assistant:${created.row.id}`,
      desiredScheduleJson: bindingOverrides.desiredScheduleJson ?? JSON.stringify({ kind: 'interval', minutes: 15 }),
      desiredCwd: bindingOverrides.desiredCwd ?? `/repo/bound-cron-${suffix}`,
      desiredState: 'running',
      boundJobId: run.jobId,
      updatedAt: NOW,
    })
    if (!binding.ok) throw new Error('bound prompt Cron binding seed failed')
    const observed = store.observeCronRunFinished({
      commitmentId: created.row.id,
      externalRef: `assistant:${created.row.id}`,
      runId: run.runId,
      jobId: run.jobId,
      scheduledFor: run.scheduledFor,
      finishedAt: run.finishedAt,
      runStatus: run.runStatus,
      ...(run.summary === undefined ? {} : { summary: run.summary }),
      ...(run.error === undefined ? {} : { error: run.error }),
      deliveryState: run.deliveryState,
      ...(run.deliveryError === undefined ? {} : { deliveryError: run.deliveryError }),
      now: NOW,
    })
    if (!observed.ok) throw new Error('bound prompt Cron observation seed failed')
    if (controlError !== undefined) {
      const recorded = store.recordCronControlError({
        commitmentId: created.row.id,
        externalRef: `assistant:${created.row.id}`,
        code: 'control_unavailable',
        error: controlError,
      })
      if (recorded === undefined) throw new Error('bound prompt control error seed failed')
    }
    return created.row.id
  }

  it('keeps monitor facts queryable in status but out of the automatic root snapshot', () => {
    const store = new AssistantStore(join(tempDir(), 'monitor-prompt-boundary.sqlite'))
    const direction = 'SECRET-DIRECTION-MARKER'
    const confirmedCheckpoint = 'SECRET-CONFIRMED-CHECKPOINT'
    const eventKey = 'SECRET-EVENT-KEY'
    const proposedCheckpoint = 'SECRET-PROPOSED-CHECKPOINT'
    const summary = 'SECRET-EVENT-SUMMARY'
    const outboxText = 'SECRET-OUTBOX-TEXT'
    const created = store.createAgentCommitment({
      title: '边界监控',
      kind: 'monitor',
      monitorDirection: direction,
      monitorCheckpoint: confirmedCheckpoint,
      sourceSurface: 'telegram',
      now: NOW,
    })
    if (!created.ok) throw new Error('monitor seed failed')
    const saved = store.saveWorkerIdentity(created.row.id, created.row.revision, {
      workerSessionId: 'child-prompt-boundary',
      workerRunId: 'run-prompt-boundary',
      workerParentSessionId: 'session-telegram',
    })
    if (!saved.ok) throw new Error('monitor identity failed')
    const active = store.markAgentActive(saved.row.id, saved.row.revision)
    if (!active.ok) throw new Error('monitor activation failed')
    const settled = store.settleMonitorEvent({
      commitmentId: active.row.id,
      expectedRevision: active.row.revision,
      workerSessionId: 'child-prompt-boundary',
      workerRunId: 'run-prompt-boundary',
      workerParentSessionId: 'session-telegram',
      monitorResumeEpoch: active.row.monitorResumeEpoch,
      eventKey,
      checkpoint: proposedCheckpoint,
      summary,
      outboxText,
      now: NOW,
    })
    if (!settled.ok) throw new Error('monitor event settlement failed')
    store.finishOutbox(settled.outbox.id, 'failed', { error: 'delivery failed' })
    const parked = store.getById(active.row.id)
    if (parked === undefined) throw new Error('monitor disappeared after event settlement')
    const blocked = store.block(
      parked.id,
      parked.revision,
      '未绑定 Cron：该 legacy monitor 尚未绑定 Cron',
      '请提供显式 schedule 后再恢复',
    )
    if (!blocked.ok) throw new Error('legacy monitor parking failed')

    const text = promptSectionText(store, 'telegram')
    for (const marker of [direction, confirmedCheckpoint, eventKey, proposedCheckpoint, summary, outboxText]) {
      expect(text).not.toContain(marker)
    }
    expect(text).not.toContain('最近监控事件投递')
    expect(text).toContain('显式 schedule')
    expect(store.listMonitorEventOutbox(created.row.id)).toHaveLength(1)
    store.close()
  })

  it('projects one bound monitor from Cron binding facts only, including normal success+silent without summary', () => {
    const store = new AssistantStore(join(tempDir(), 'bound-cron-prompt-single.sqlite'))
    const run: PromptCronRun = {
      runId: 'CRON_RUN_SINGLE',
      jobId: 'CRON_JOB_SINGLE',
      scheduledFor: '2026-08-18T07:00:00.000Z',
      finishedAt: '2026-08-18T07:00:03.000Z',
      runStatus: 'success',
      deliveryState: 'silent',
    }
    const commitmentId = seedBoundPromptMonitor(store, 'SINGLE', run)
    const text = promptSectionText(store, 'telegram')

    expect(text).toContain('Cron desiredState=running')
    expect(text).toContain('boundJobId=CRON_JOB_SINGLE')
    expect(text).toContain('runStatus=success')
    expect(text).toContain('deliveryState=silent')
    expect(text).toContain('controlError=null')
    expect(text).toContain('summary=null')
    expect(text).not.toContain('最近监控事件投递')
    for (const marker of [
      'LEGACY_PROGRESS_MARKER_SINGLE',
      'LEGACY_EVENT_KEY_SINGLE',
      'LEGACY_CHECKPOINT_SINGLE',
      'LEGACY_EVENT_SUMMARY_SINGLE',
      'LEGACY_OUTBOX_TEXT_SINGLE',
      'LEGACY_EVENT_DELIVERY_SINGLE',
    ]) {
      expect(text).not.toContain(marker)
    }
    expect(store.getCronBinding(commitmentId)).toMatchObject({ boundJobId: 'CRON_JOB_SINGLE' })
    store.close()
  })

  it('projects bounded Cron facts for a bound monitor among multiple responsibilities', () => {
    const store = new AssistantStore(join(tempDir(), 'bound-cron-prompt-multiple.sqlite'))
    const summaryHead = 'CRON_SUMMARY_HEAD_MULTI'
    const summaryTail = 'CRON_SUMMARY_TAIL_MULTI'
    const runErrorHead = 'CRON_RUN_ERROR_HEAD_MULTI'
    const runErrorTail = 'CRON_RUN_ERROR_TAIL_MULTI'
    const deliveryErrorHead = 'CRON_DELIVERY_ERROR_HEAD_MULTI'
    const deliveryErrorTail = 'CRON_DELIVERY_ERROR_TAIL_MULTI'
    const controlErrorHead = 'CRON_CONTROL_ERROR_HEAD_MULTI'
    const controlErrorTail = 'CRON_CONTROL_ERROR_TAIL_MULTI'
    const jobHead = 'CRON_JOB_HEAD_MULTI'
    const jobTail = 'CRON_JOB_TAIL_MULTI'
    const cwdHead = 'CRON_CWD_HEAD_MULTI'
    const cwdTail = 'CRON_CWD_TAIL_MULTI'
    const scheduleHead = 'CRON_SCHEDULE_HEAD_MULTI'
    const scheduleTail = 'CRON_SCHEDULE_TAIL_MULTI'
    const run: PromptCronRun = {
      runId: 'CRON_RUN_MULTI',
      jobId: `${jobHead}${'j'.repeat(450)}${jobTail}`,
      scheduledFor: '2026-08-18T08:00:00.000Z',
      finishedAt: '2026-08-18T08:00:04.000Z',
      runStatus: 'error',
      summary: `${summaryHead}${'x'.repeat(500)}${summaryTail}`,
      error: `${runErrorHead}${'r'.repeat(500)}${runErrorTail}`,
      deliveryState: 'failed',
      deliveryError: `${deliveryErrorHead}${'d'.repeat(500)}${deliveryErrorTail}`,
    }
    seedBoundPromptMonitor(
      store,
      'MULTI',
      run,
      `${controlErrorHead}${'c'.repeat(500)}${controlErrorTail}`,
      {
        desiredCwd: `${cwdHead}${'w'.repeat(250)}${cwdTail}`,
        desiredScheduleJson: JSON.stringify({ kind: 'cron', expr: `0 * * * ${scheduleHead}${'s'.repeat(500)}${scheduleTail}` }),
      },
    )
    const other = store.createAgentCommitment({
      title: 'other responsibility remains visible',
      kind: 'delegated',
      sourceSurface: 'telegram',
      now: NOW,
    })
    if (!other.ok) throw new Error('other responsibility seed failed')

    const text = promptSectionText(store, 'telegram')
    const field = (name: string): string => text.match(new RegExp(`${name}=([^；\\n]*)`))?.[1] ?? ''
    expect(text).toContain('other responsibility remains visible')
    expect(text).toContain('Cron desiredState=running')
    expect(text).toContain(`boundJobId=${jobHead}`)
    expect(text).toContain('runStatus=error')
    expect(text).toContain('deliveryState=failed')
    expect(text).toContain(`controlError=${controlErrorHead}`)
    expect(text).toContain(`desiredCwd=${cwdHead}`)
    expect(text).toContain(`schedule={"kind":"cron","expr":"0 * * * ${scheduleHead}`)
    expect(text).toContain(summaryHead)
    expect(text).toContain(runErrorHead)
    expect(text).toContain(deliveryErrorHead)
    expect(text).not.toContain(summaryTail)
    for (const tail of [runErrorTail, deliveryErrorTail, controlErrorTail, jobTail, cwdTail, scheduleTail]) {
      expect(text).not.toContain(tail)
    }
    expect(text).not.toContain('最近监控事件投递')
    for (const marker of [
      'LEGACY_PROGRESS_MARKER_MULTI',
      'LEGACY_EVENT_KEY_MULTI',
      'LEGACY_CHECKPOINT_MULTI',
      'LEGACY_EVENT_SUMMARY_MULTI',
      'LEGACY_OUTBOX_TEXT_MULTI',
      'LEGACY_EVENT_DELIVERY_MULTI',
    ]) {
      expect(text).not.toContain(marker)
    }
    expect(field('schedule').length).toBeLessThanOrEqual(400)
    expect(field('desiredCwd').length).toBeLessThanOrEqual(160)
    expect(field('boundJobId').length).toBeLessThanOrEqual(160)
    expect(field('controlError').length).toBeLessThanOrEqual(400)
    expect(field('summary').length).toBeLessThanOrEqual(400)
    expect(field('runError').length).toBeLessThanOrEqual(400)
    expect(field('deliveryError').length).toBeLessThanOrEqual(400)
    store.close()
  })

  it('keeps an unbound legacy monitor honest in the automatic prompt', () => {
    const store = new AssistantStore(join(tempDir(), 'unbound-legacy-prompt.sqlite'))
    const created = store.createAgentCommitment({
      title: 'unbound legacy prompt monitor',
      kind: 'monitor',
      monitorDirection: 'legacy direction',
      sourceSurface: 'telegram',
      now: NOW,
    })
    if (!created.ok) throw new Error('legacy prompt monitor seed failed')
    const blocked = store.block(
      created.row.id,
      created.row.revision,
      '未绑定 Cron：该 legacy monitor 尚未绑定 Cron',
      '请提供显式 schedule 后再恢复',
    )
    if (!blocked.ok) throw new Error('legacy prompt monitor block failed')
    const text = promptSectionText(store, 'telegram')
    expect(text).toContain('显式 schedule')
    expect(text).not.toContain('running')
    expect(text).not.toContain('最近监控事件投递')
    store.close()
  })

  it('the dynamic snapshot reflects the current commitment and lastClosed', async () => {
    const store = new AssistantStore(join(tempDir(), 'state.sqlite'))
    const created = store.createUserCommitment({ title: '整理书桌', status: 'active', checkInMinutes: 2, sourceSurface: 'telegram', now: NOW })
    if (!created.ok) throw new Error('seed failed')
    store.completeUser(created.row.id, created.row.revision, '做完了', NOW)
    const current = store.createUserCommitment({ title: '第二件', status: 'active', sourceSurface: 'telegram', now: NOW })
    if (!current.ok) throw new Error('seed failed')
    const text = promptSectionText(store, 'telegram')
    expect(text).toContain('dsh-assistant 当前承诺 assistant-')
    expect(text).toContain('第二件')
    expect(text).toContain('工作归用户')
    expect(text).toContain('进行中')
    store.close()
  })

  it('attaches a recent closure with delivery state when nothing is current', async () => {
    const store = new AssistantStore(join(tempDir(), 'state.sqlite'))
    const created = store.createUserCommitment({ title: '老事', status: 'active', sourceSurface: 'telegram', now: NOW })
    if (!created.ok) throw new Error('seed failed')
    store.completeUser(created.row.id, created.row.revision, '结果文本', NOW)
    store.touchLastDelivery(created.row.id, 'uncertain', 'claimed before restart')
    const text = promptSectionText(store, 'telegram')
    expect(text).toContain('dsh-assistant 当前承诺：无。')
    expect(text).toContain('不表示个人任务清单为空')
    expect(text).toContain('最近收口：老事')
    expect(text).toContain('结果文本')
    expect(text).toContain('主动投递uncertain')
    store.close()
  })

  it('tells the Telegram root that multiple Agent results already closed and were delivered without reinjecting results', () => {
    const store = new AssistantStore(join(tempDir(), 'delivered-agent-context.sqlite'))
    const monitor = store.createAgentCommitment({
      title: '监控 deepseek-harness 更新', kind: 'monitor', monitorDirection: '持续观察该 workspace', sourceSurface: 'telegram', now: NOW,
    })
    if (!monitor.ok) throw new Error('monitor seed failed')

    const closeDelivered = (title: string, child: string, completedAt: string, result: string) => {
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
      store.touchLastDelivery(settled.row.id, 'delivered')
    }
    closeDelivered('验收 A', 'a', '2026-08-15T02:01:00.000Z', 'A-LARGE-RESULT-MUST-NOT-BE-IN-PROMPT')
    closeDelivered(`验收 B${'乙'.repeat(480)}TITLE-TAIL`, 'b', '2026-08-15T02:02:00.000Z', 'B-LARGE-RESULT-MUST-NOT-BE-IN-PROMPT')

    const focus = store.createUserCommitment({
      title: '当前用户工作', status: 'active', sourceSurface: 'telegram', now: '2026-08-15T02:03:00.000Z',
    })
    if (!focus.ok) throw new Error('focus seed failed')
    store.completeUser(focus.row.id, focus.row.revision, 'focus result', '2026-08-15T02:04:00.000Z')

    const text = promptSectionText(store, 'telegram')
    expect(text).toContain('监控 deepseek-harness 更新')
    expect(text).toContain('最近已收口的 Agent 责任')
    expect(text).toContain('验收 A')
    expect(text).toContain('验收 B')
    expect(text.match(/终态已直接交付用户/g)).toHaveLength(2)
    expect(text).toContain('不得重复发送结果或声称仍在等待')
    expect(text).not.toContain('A-LARGE-RESULT-MUST-NOT-BE-IN-PROMPT')
    expect(text).not.toContain('B-LARGE-RESULT-MUST-NOT-BE-IN-PROMPT')
    expect(text).not.toContain('TITLE-TAIL')
    const closureLines = text.split('\n').filter(line => line.startsWith('- assistant-') && line.includes('[completed]'))
    expect(closureLines).toHaveLength(2)
    expect(closureLines.every(line => line.length < 260)).toBe(true)
    store.close()
  })

  it('the empty snapshot explicitly says an empty current commitment does not mean the personal task list is empty', async () => {
    const store = new AssistantStore(join(tempDir(), 'state.sqlite'))
    const text = promptSectionText(store, 'telegram')
    expect(text).toContain('dsh-assistant 当前承诺：无。')
    expect(text).toContain('不表示个人任务清单为空')
    store.close()
  })

  it('degrades to an honest unreadable line when the store read fails', async () => {
    const store = new AssistantStore(join(tempDir(), 'state.sqlite'))
    store.close()
    const text = promptSectionText(store, 'telegram')
    expect(text).toContain('dsh-assistant 当前承诺状态暂时不可读，请调用 assistant_task_status 且不要猜。')
    expect(text).toContain(STABLE_CONTRACT.slice(0, 20))
  })

  it('bounds every injected progress summary and the total multi-responsibility snapshot', () => {
    const store = new AssistantStore(join(tempDir(), 'bounded-prompt.sqlite'))
    for (let i = 0; i < 5; i++) {
      const created = store.createAgentCommitment({
        title: `并行责任 ${i + 1}`,
        sourceSurface: 'telegram',
        now: NOW,
      })
      if (!created.ok) throw new Error('seed failed')
      const saved = store.saveWorkerIdentity(created.row.id, created.row.revision, {
        workerSessionId: `child-prompt-${i}`,
        workerRunId: `run-prompt-${i}`,
        workerParentSessionId: 'session-telegram',
      })
      if (!saved.ok) throw new Error('identity failed')
      store.recordWorkerProgress(`child-prompt-${i}`, 'report-1', `${String(i).repeat(700)}TAIL`, NOW)
    }

    const text = promptSectionText(store, 'telegram')
    const snapshot = text.slice(STABLE_CONTRACT.length + 2)
    const summaries = [...snapshot.matchAll(/最近进展：([^\n]+)/g)].map(match => match[1]!)
    expect(summaries).toHaveLength(5)
    expect(summaries.every(summary => summary.length <= 400)).toBe(true)
    expect(summaries.every(summary => summary.endsWith('…'))).toBe(true)
    expect(snapshot).not.toContain('TAIL')
    expect(snapshot.length).toBeLessThan(5_000)
    store.close()
  })

  it('the stable contract separates ownership and forbids session search', async () => {
    expect(STABLE_CONTRACT).toContain('绝不代做内容')
    expect(STABLE_CONTRACT).toContain('assistant_delegate_task')
    expect(STABLE_CONTRACT).toContain('不要先搜 Session 或长期记忆')
    expect(STABLE_CONTRACT).toContain('普通问答、闲聊和能在当前回复内立即完成的一步请求，不自动创建承诺')
  })

  it('the stable contract separates the personal task list from the current commitment and drops the broad status-first rule', async () => {
    expect(STABLE_CONTRACT).toContain('assistant_task_status 只读取')
    expect(STABLE_CONTRACT).toContain('我的任务有哪些')
    expect(STABLE_CONTRACT).toContain('一个来源为空不能证明另一个来源也为空')
    expect(STABLE_CONTRACT).not.toContain('显式状态查询先调用 assistant_task_status')
  })

  it('the stable contract no longer instructs the parent to confirm settled notices', async () => {
    expect(STABLE_CONTRACT).not.toContain('最短的内部确认')
    expect(STABLE_CONTRACT).not.toContain('只做最短的内部确认')
  })
})

describe('D. long-term recognition contract', () => {
  it('the stable contract lets interactive roots learn only from current user strong signals and follow the workspace memory path', () => {
    expect(STABLE_CONTRACT).toContain('长期认识只能来自当前直接用户的强信号')
    expect(STABLE_CONTRACT).toContain('「记住」「以后都这样」「下次不要再……」')
    expect(STABLE_CONTRACT).toContain('直接纠正、选择、否定、改写')
    expect(STABLE_CONTRACT).toContain('按 workspace 指引读取和更新 Harness 自己的私人记忆')
  })

  it('treats the user\'s own concrete facts, preferences and existing long-term knowledge as learnable alongside future collaboration practices', () => {
    // 反例防护（例如：用户纠正一项长期偏好）：只有"未来协作的具体做法"是不够的。
    // 两个类别必须并列出现在同一强信号触发句群内（直接纠正、选择、否定、改写 … 普通一次性请求之前），
    // 防止实现只在禁止列表或文档别处提及"用户自己的具体事实、偏好或已有长期认识"而假绿。
    const triggerStart = STABLE_CONTRACT.indexOf('直接纠正、选择、否定、改写')
    const signalBlockEnd = STABLE_CONTRACT.indexOf('普通一次性请求')
    expect(triggerStart).toBeGreaterThan(-1)
    expect(signalBlockEnd).toBeGreaterThan(triggerStart)
    const signalBlock = STABLE_CONTRACT.slice(triggerStart, signalBlockEnd)
    expect(signalBlock).toContain('用户自己的具体事实、偏好或已有长期认识')
    expect(signalBlock).toContain('会影响未来协作的具体做法')
  })

  it('the stable contract excludes ordinary requests, silence, model inference, tool results, worker/cron/subagent/outbox and external content', () => {
    expect(STABLE_CONTRACT).toContain('普通一次性请求')
    expect(STABLE_CONTRACT).toContain('用户沉默')
    expect(STABLE_CONTRACT).toContain('模型推断')
    expect(STABLE_CONTRACT).toContain('工具结果')
    expect(STABLE_CONTRACT).toContain('worker/cron/subagent/outbox')
    expect(STABLE_CONTRACT).toContain('外部内容')
  })

  it('the stable contract requires concrete executable knowledge instead of abstract personality labels', () => {
    expect(STABLE_CONTRACT).toContain('保存具体事实或未来可执行的协作习惯')
    expect(STABLE_CONTRACT).toContain('不写抽象性格标签')
    expect(STABLE_CONTRACT).toContain('临时运行状态')
    expect(STABLE_CONTRACT).toContain('秘密')
    expect(STABLE_CONTRACT).toContain('第三方隐私')
  })

  it('the stable contract requires read-before-write, exact dedupe, conflict replacement and honest failure', () => {
    expect(STABLE_CONTRACT).toContain('写前必须先读取')
    expect(STABLE_CONTRACT).toContain('相同内容不重复')
    expect(STABLE_CONTRACT).toContain('冲突内容原地修正')
    expect(STABLE_CONTRACT).toContain('这次没有记住')
    expect(STABLE_CONTRACT).toContain('不得假称已记住')
  })

  it('the stable contract forbids creating a current commitment, cron, reminder or background task just for a memory update', () => {
    expect(STABLE_CONTRACT).toContain('不因此创建当前承诺、cron、提醒或后台任务')
  })

  it('the interactive persona and stable contract never hardcode an author-machine path', () => {
    expect(ASSISTANT_PERSONA).not.toMatch(/\/home\/[A-Za-z0-9_-]+(?:$|\/)/)
    expect(STABLE_CONTRACT).not.toMatch(/\/home\/[A-Za-z0-9_-]+(?:$|\/)/)
  })

  it('delegated child roots still do not receive the long-term recognition contract', async () => {
    const child = fakeAgent('session-child-1')
    const { mounted } = await mount({ mode: 'telegram' }, [child])
    const learningSections = child.ctx._sections.filter(section => {
      const text = typeof section.text === 'function' ? section.text() : section.text
      return text.includes('长期认识')
    })
    expect(learningSections).toHaveLength(0)
    await mounted.dispose()
  })

  it('cron roots still do not receive the long-term recognition contract', async () => {
    const cron = fakeAgent('session-cron-x')
    const { mounted } = await mount({ mode: 'telegram' }, [cron])
    const learningSections = cron.ctx._sections.filter(section => {
      const text = typeof section.text === 'function' ? section.text() : section.text
      return text.includes('长期认识')
    })
    expect(learningSections).toHaveLength(0)
    await mounted.dispose()
  })
})


describe('telegram wiring', () => {
  it('mounts without a delivery provider and terminally fails a claimed outbox row', async () => {
    const storePath = join(tempDir(), 'state.sqlite')
    const seed = new AssistantStore(storePath)
    const created = seed.createAgentCommitment({ title: '待通知', sourceSurface: 'telegram', now: NOW })
    if (!created.ok) throw new Error('seed failed')
    seed.settleWorkerEnd(created.row.id, created.row.revision, {
      status: 'completed', result: 'done', completedAt: NOW,
      outboxId: 'missing-provider-outbox', outboxText: '完整结果',
    })
    seed.close()

    const { mounted } = await mount({ mode: 'telegram' }, [fakeAgent('session-telegram')], { storePath })
    await vi.waitFor(() => {
      const check = new AssistantStore(storePath)
      try {
        expect(check.getOutbox('missing-provider-outbox')).toMatchObject({
          state: 'failed', error: expect.stringContaining('provider'),
        })
      } finally {
        check.close()
      }
    })
    await mounted.dispose()
  })

  it('normalizes a leftover agent commitment to paused on startup and keeps the child id', async () => {
    const storePath = join(tempDir(), 'state.sqlite')
    const seed = new AssistantStore(storePath)
    const created = seed.createAgentCommitment({ title: '遗留', sourceSurface: 'telegram', now: NOW })
    if (!created.ok) throw new Error('seed failed')
    const saved = seed.saveWorkerIdentity(created.row.id, created.row.revision, {
      workerSessionId: 'child-1', workerRunId: 'run-1', workerParentSessionId: 'session-telegram',
    })
    if (!saved.ok) throw new Error('save failed')
    seed.markAgentActive(created.row.id, saved.row.revision)
    seed.close()

    const existing = fakeAgent('session-telegram')
    const { mounted } = await mount({ mode: 'telegram' }, [existing], { storePath })
    const check = new AssistantStore(storePath)
    const row = check.getCurrent()!
    expect(row.status).toBe('paused')
    expect(row.workerSessionId).toBe('child-1')
    expect(row.nextAction).toContain('服务重启后等待用户明确恢复')
    check.close()
    await mounted.dispose()
  })
})
