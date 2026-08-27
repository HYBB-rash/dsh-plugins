import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import * as commandCompact from '@deepseek-ai/dsh-command-compact'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import type { ManagedRuntimeConfig } from '../src/managed-runtime.ts'
import {
  ManagedAwareBasicCompactionEngine,
  type ManagedAwareBasicCompactionConfig,
  type ManagedCompactionRuntimeConfig,
} from '../src/managed-compaction.ts'
import * as ContextManager from '../src/index.ts'

const contexts: Context[] = []
const roots: string[] = []
const adapters = new WeakMap<Context, CountingAdapter>()

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

const managedRuntime: ManagedCompactionRuntimeConfig = Object.freeze({
  mode: 'enforce' as const,
  safeUpdateMarginTokens: 64,
  allowlist: [...ContextManager.FOCUS_CANARY_IDS],
})

class CountingAdapter extends LlmAdapter {
  requests = 0

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 100_000 } })
  }

  override async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests += 1
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function managerConfig() {
  return {
    focusCanary: {
      ...managedRuntime,
      auxiliary: {
        provider: 'unused', model: 'unused', maxOutputTokens: 64, timeoutMs: 500,
        maxExpressionChars: 240, maxProjectionTokens: 1_024, safetyMarginTokens: 128,
      },
    },
    nativeWriterArbitration: { mode: 'enforce' as const },
  }
}

async function mountPrerequisites(options: {
  readonly withCommands?: boolean
  readonly withGlobalCompact?: boolean
  readonly engineRuntime?: ManagedCompactionRuntimeConfig
  readonly basicEngine?: boolean
} = {}): Promise<Context> {
  const root = await mkdtemp(join(tmpdir(), 'context-manager-compact-command-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  const adapter = new CountingAdapter()
  adapters.set(ctx, adapter)
  ctx.llm.registerAdapter(['unused'], adapter)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageSqlite, { path: join(root, 'context-manager.sqlite') })
  await ctx.plugin(StorageDomain, { backend: 'sqlite' })
  await ctx.plugin(TokenMeter)
  if (options.withCommands !== false) await ctx.plugin(CommandRuntime)
  if (options.basicEngine === true) {
    await ctx.plugin(BasicCompactionEngine, { auto: true })
  } else {
    const compactionConfig: ManagedAwareBasicCompactionConfig = {
      auto: true, managedRuntime: options.engineRuntime ?? managedRuntime,
    }
    await ctx.plugin(ManagedAwareBasicCompactionEngine, compactionConfig)
  }
  if (options.withCommands !== false && options.withGlobalCompact !== false) await ctx.plugin(commandCompact)
  return ctx
}

async function mount(): Promise<Context> {
  const ctx = await mountPrerequisites()
  await ctx.plugin(ContextManager, managerConfig())
  await ctx.plugin(AgentLoop, { agents: [] })
  return ctx
}

async function rejectionMessage(operation: () => PromiseLike<unknown>): Promise<string> {
  try {
    await operation()
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('expected startup rejection')
}

describe('managed /compact command arbitration', () => {
  it('rejects missing required public composition before a managed command can execute', async () => {
    const nonManaged = await mountPrerequisites({ basicEngine: true })
    expect(await rejectionMessage(() => nonManaged.plugin(ContextManager, managerConfig())))
      .toMatch(/ManagedAwareBasicCompactionEngine/)

    const mismatchedRuntime: ManagedRuntimeConfig & ManagedCompactionRuntimeConfig = {
      ...managedRuntime, safeUpdateMarginTokens: 65,
    }
    const mismatch = await mountPrerequisites({ engineRuntime: mismatchedRuntime })
    expect(await rejectionMessage(() => mismatch.plugin(ContextManager, managerConfig())))
      .toMatch(/managed runtime config must exactly match/)

    const missingCommands = await mountPrerequisites({ withCommands: false })
    expect(await rejectionMessage(() => missingCommands.plugin(ContextManager, managerConfig())))
      .toMatch(/commands service/)

    const missingGlobal = await mountPrerequisites({ withGlobalCompact: false })
    await missingGlobal.plugin(ContextManager, managerConfig())
    await missingGlobal.plugin(AgentLoop, { agents: [] })
    const missingGlobalId = SessionId(ContextManager.FOCUS_CANARY_IDS[0])
    expect(await rejectionMessage(() => missingGlobal.agents.create({
      sessionId: missingGlobalId,
      agentOptions: { provider: 'unused', model: 'unused' },
    }))).toMatch(/global compact command/)
    expect(missingGlobal.agents.get(missingGlobalId)).toBeUndefined()
    expect(missingGlobal.sessions.get(missingGlobalId)).toBeUndefined()

    const collision = await mountPrerequisites({ withGlobalCompact: false })
    let globalExecutions = 0
    collision.commands.register({
      name: 'compact', description: 'count global compact execution',
      handler: () => {
        globalExecutions += 1
        return { kind: 'error' as const, text: 'global compact must not run during failed creation' }
      },
    })
    await collision.plugin(ContextManager, managerConfig())
    await collision.plugin(AgentLoop, { agents: [] })
    const collisionId = SessionId(ContextManager.FOCUS_CANARY_IDS[0])
    const nativeEvents: string[] = []
    collision.on('session/event', (session, event) => {
      if (session.id === collisionId && event.type.startsWith('compaction/')) nativeEvents.push(event.type)
    })
    expect(await rejectionMessage(() => collision.agents.create({
      sessionId: collisionId,
      agentOptions: { provider: 'unused', model: 'unused' },
      setup(agentCtx) {
        const commands = agentCtx.get('commands')
        if (commands === undefined) throw new Error('test setup missing commands')
        commands.register({
          name: 'compact', description: 'occupy managed scoped compact',
          handler: () => ({ kind: 'error' as const, text: 'occupied' }),
        })
      },
    }))).toMatch(/already registered in this scope/)
    expect(collision.agents.get(collisionId)).toBeUndefined()
    expect(collision.agents.list().some(agent => agent.id === collisionId)).toBe(false)
    expect(collision.sessions.get(collisionId)).toBeUndefined()
    expect(adapters.get(collision)?.requests).toBe(0)
    expect(nativeEvents).toEqual([])
    expect(globalExecutions).toBe(0)

  })

  it('uses the agent-scoped closed command for a managed root while unmanaged roots retain the global native definition', async () => {
    const ctx = await mount()
    const managedHandle = await ctx.agents.create({
      sessionId: SessionId(ContextManager.FOCUS_CANARY_IDS[0]),
      agentOptions: { provider: 'unused', model: 'unused' },
    })
    const managed = managedHandle.agent
    const unmanaged = (await ctx.agents.create({
      sessionId: SessionId('compact-command-unmanaged'),
      agentOptions: { provider: 'unused', model: 'unused' },
    })).agent
    const cron = (await ctx.agents.create({
      sessionId: SessionId('session-cron-compact-command'),
      agentOptions: { provider: 'unused', model: 'unused' },
    })).agent
    const worker = (await ctx.agents.create({
      sessionId: SessionId(ContextManager.FOCUS_CANARY_IDS[1]),
      meta: { delegationDepth: 1 },
      agentOptions: { provider: 'unused', model: 'unused' },
    })).agent

    const global = ctx.commands.find(unmanaged, 'compact')
    expect(global).toBeDefined()
    expect(ctx.commands.find(managed, 'compact')?.handler).not.toBe(global?.handler)

    expect((await ctx.commands.execute(managed, '/compact', [], new AbortController().signal))?.result)
      .toEqual({ kind: 'error', text: '上下文管理候选尚未换入，本次未压缩。' })
    expect(managed.session.events.filter(event => event.type.startsWith('compaction/'))).toEqual([])
    expect(adapters.get(ctx)?.requests).toBe(0)

    await managedHandle.dispose()
    expect(ctx.commands.find(managed, 'compact')?.handler).toBe(global?.handler)

    expect((await ctx.commands.execute(unmanaged, '/compact', [], new AbortController().signal))?.result)
      .toEqual({ kind: 'success', text: 'No compactable history yet.' })
    expect(ctx.commands.find(cron, 'compact')?.handler).toBe(global?.handler)
    expect(ctx.commands.find(worker, 'compact')?.handler).toBe(global?.handler)
    expect((await ctx.commands.execute(cron, '/compact', [], new AbortController().signal))?.result)
      .toEqual({ kind: 'success', text: 'No compactable history yet.' })
    expect((await ctx.commands.execute(worker, '/compact', [], new AbortController().signal))?.result)
      .toEqual({ kind: 'success', text: 'No compactable history yet.' })
    expect(unmanaged.session.events.filter(event => event.type === 'command/run' || event.type === 'command/done'))
      .toHaveLength(2)
  })
})
