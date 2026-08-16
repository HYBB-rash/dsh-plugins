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

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { TelegramHttp } from '@deepseek-ai/dsh-telegram-gateway'
import * as plugin from '../src/index.ts'
import { ASSISTANT_PERSONA, createWorkerNoticeSink, promptSectionText, STABLE_CONTRACT } from '../src/index.ts'
import { AssistantStore } from '../src/store.ts'

// The Telegram gateway is an integration boundary here; stub it so plugin
// mount tests are deterministic and never depend on live API availability.
vi.mock('@deepseek-ai/dsh-telegram-gateway', () => ({
  createTelegramHttp: () => ({
    getMe: vi.fn(async () => ({ id: 1, username: 'test' })),
  }),
}))

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
    credentials?: { resolve(): Promise<{ value: string } | undefined> }
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
  ctx.provide('credentials', (overrides.credentials ?? {
    resolve: async () => ({ value: 'test-token' }),
  }) as never)
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
    ...config.mode === 'telegram' ? {
      token: 'test-token',
      chatId: '12345',
      telegramParentSessionId: 'session-telegram',
    } : {},
  } as never)
  return { ctx, mounted, registry, toolRegistry, subagents }
}

function seedRecoverableMonitor(storePath: string): void {
  const store = new AssistantStore(storePath)
  const created = store.createAgentCommitment({ title: 'continuous monitor', kind: 'monitor', sourceSurface: 'telegram', now: NOW })
  if (!created.ok) throw new Error('monitor seed failed')
  const saved = store.saveWorkerIdentity(created.row.id, created.row.revision, {
    workerSessionId: 'child-monitor', workerRunId: 'run-old', workerParentSessionId: 'session-telegram',
  })
  if (!saved.ok) throw new Error('monitor identity failed')
  const active = store.markAgentActive(saved.row.id, saved.row.revision)
  if (!active.ok) throw new Error('monitor activate failed')
  store.normalizeAgentOnStartup()
  store.close()
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

  it('cold-resumes one migrated monitor exactly once when the fixed Telegram root already exists', async () => {
    const storePath = join(tempDir(), 'existing-monitor.sqlite')
    seedRecoverableMonitor(storePath)
    const tg = fakeAgent('session-telegram')
    const { mounted, subagents } = await mount({ mode: 'telegram' }, [tg], { storePath })
    expect(subagents.followup).toHaveBeenCalledTimes(1)
    const store = new AssistantStore(storePath)
    expect(store.listTelegramAgentResponsibilities(5)[0]).toMatchObject({
      kind: 'monitor', status: 'active', monitorResumeState: 'none', workerControlState: 'none',
    })
    store.close()
    await mounted.dispose()
  })

  it('cold-resumes once when the fixed Telegram root appears only after startup', async () => {
    const storePath = join(tempDir(), 'future-monitor.sqlite')
    seedRecoverableMonitor(storePath)
    const { ctx, mounted, registry, subagents } = await mount({ mode: 'telegram' }, [], { storePath })
    expect(subagents.followup).not.toHaveBeenCalled()
    const later = fakeAgent('session-telegram')
    registry.add(later)
    ctx.emit('agent/created' as never, { agent: later } as never)
    await vi.waitFor(() => expect(subagents.followup).toHaveBeenCalledTimes(1))
    await mounted.dispose()
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
      title: '监控 deepseek-harness 更新', kind: 'monitor', sourceSurface: 'telegram', now: NOW,
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
