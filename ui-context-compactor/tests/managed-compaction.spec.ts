import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import LlmRuntime, { CONTEXT_WINDOW_EXCEEDED_CODE, createUserMessage, isAgentLoopRequest, LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import * as commandCompact from '@deepseek-ai/dsh-command-compact'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import {
  ManagedAwareBasicCompactionEngine,
  type ManagedAwareBasicCompactionConfig,
  type ManagedCompactionRuntimeConfig,
} from '../src/managed-compaction.ts'
import * as ContextManager from '../src/index.ts'

const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function textChunks(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function isCanaryCall(options: GenerateOptions): boolean {
  return options.messages.some(message => message.source.kind === 'plugin'
    && message.source.plugin === 'ui-context-compactor:focus-canary-schema')
}

class NativeWriterAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  overflowNext = false

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 100_000 } })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (isCanaryCall(options)) {
      yield* textChunks('{"kind":"focus","subject":"native writer arbitration","relation":"new"}')
      return
    }
    if (this.overflowNext && isAgentLoopRequest(options)) {
      this.overflowNext = false
      yield {
        type: 'finish',
        reason: { kind: 'error', failure: { message: 'too large', code: CONTEXT_WINDOW_EXCEEDED_CODE } },
      }
      return
    }
    yield* textChunks('native summary or ordinary response')
  }
}

type CanaryConfig = Extract<NonNullable<ContextManager.Config['focusCanary']>, { readonly mode: 'enforce' }>

const runtime: ManagedCompactionRuntimeConfig = Object.freeze({
  mode: 'enforce' as const,
  safeUpdateMarginTokens: 64,
  allowlist: [...ContextManager.FOCUS_CANARY_IDS],
})

const canary: CanaryConfig = {
  ...runtime,
  auxiliary: {
    provider: 'native-test',
    model: 'native-test-model',
    maxOutputTokens: 64,
    timeoutMs: 500,
    maxExpressionChars: 240,
    maxProjectionTokens: 1_024,
    safetyMarginTokens: 128,
  },
}

interface Harness {
  readonly ctx: Context
  readonly engine: ManagedAwareBasicCompactionEngine
  readonly adapter: NativeWriterAdapter
  readonly managed: Agent
  readonly unmanaged: Agent
  readonly managedHandle: AgentHandle
  readonly unmanagedHandle: AgentHandle
  readonly manager: { dispose(): Promise<void> }
}

async function mount(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'context-manager-native-writer-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageSqlite, { path: join(root, 'context-manager.sqlite') })
  await ctx.plugin(StorageDomain, { backend: 'sqlite' })
  await ctx.plugin(TokenMeter)
  await ctx.plugin(CommandRuntime)
  const adapter = new NativeWriterAdapter()
  ctx.llm.registerAdapter(['native-test'], adapter)
  const compactionConfig: ManagedAwareBasicCompactionConfig = {
    auto: true,
    thresholdRatio: 0.99,
    retainRatio: 0.1,
    managedRuntime: runtime,
  }
  await ctx.plugin(ManagedAwareBasicCompactionEngine, compactionConfig)
  const engine = ctx.compaction as ManagedAwareBasicCompactionEngine
  await ctx.plugin(commandCompact)
  const manager = ctx.plugin(ContextManager, {
    focusCanary: canary,
    nativeWriterArbitration: { mode: 'enforce' },
  })
  await manager
  await ctx.plugin(AgentLoop, { agents: [] })
  const managedHandle = await ctx.agents.create({
    sessionId: SessionId(ContextManager.FOCUS_CANARY_IDS[0]),
    agentOptions: { provider: 'native-test', model: 'native-test-model' },
  })
  const unmanagedHandle = await ctx.agents.create({
    sessionId: SessionId('session-native-unmanaged'),
    agentOptions: { provider: 'native-test', model: 'native-test-model' },
  })
  return {
    ctx, engine, adapter,
    managed: managedHandle.agent,
    unmanaged: unmanagedHandle.agent,
    managedHandle,
    unmanagedHandle,
    manager,
  }
}

async function loadProfile(managedRuntimeLines: readonly string[]): Promise<Context> {
  const root = await mkdtemp(join(tmpdir(), 'context-manager-managed-loader-'))
  roots.push(root)
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-llm'",
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-token-meter'",
    "- name: '@test/managed-compaction'",
    '  config:',
    '    auto: false',
    ...managedRuntimeLines.map(line => `    ${line}`),
    '',
  ].join('\n'))

  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-token-meter', TokenMeter],
    ['@test/managed-compaction', ManagedAwareBasicCompactionEngine],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

function input(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function nativeEvents(agent: Agent): string[] {
  return agent.session.events.flatMap(event => event.type === 'compaction/start'
    || event.type === 'compaction/summary'
    || event.type === 'compaction/end'
    ? [event.type]
    : [])
}

describe('ManagedAwareBasicCompactionEngine', () => {
  it('accepts profile-shaped enforce config through the real Loader and rejects invalid managed-runtime startup config', async () => {
    const loaded = await loadProfile([
      'managedRuntime:',
      '  mode: enforce',
      '  safeUpdateMarginTokens: 64',
      '  allowlist:',
      `    - ${ContextManager.FOCUS_CANARY_IDS[1]}`,
      `    - ${ContextManager.FOCUS_CANARY_IDS[0]}`,
    ])
    expect(loaded.get('compaction')).toBeInstanceOf(ManagedAwareBasicCompactionEngine)
    expect((loaded.get('compaction') as ManagedAwareBasicCompactionEngine).managedRuntime).toEqual({
      mode: 'enforce', safeUpdateMarginTokens: 64, allowlist: [...ContextManager.FOCUS_CANARY_IDS].reverse(),
    })

    await expect(loadProfile([
      'managedRuntime:', '  mode: observe', '  safeUpdateMarginTokens: 64', '  allowlist: [managed-a]',
    ])).rejects.toThrow()
    await expect(loadProfile([
      'managedRuntime:', '  mode: enforce', '  allowlist: [managed-a]',
    ])).rejects.toThrow()
    await expect(loadProfile([
      'managedRuntime:', '  mode: enforce', '  safeUpdateMarginTokens: 64', '  allowlist: ["", managed-a]',
    ])).rejects.toThrow(/blank session id/)
    await expect(loadProfile([
      'managedRuntime:', '  mode: enforce', '  safeUpdateMarginTokens: 64', '  allowlist: [managed-a, managed-a]',
    ])).rejects.toThrow(/duplicate/)

    const direct = new Context()
    contexts.push(direct)
    await direct.plugin(LlmRuntime)
    await direct.plugin(SessionStore)
    await direct.plugin(TokenMeter)
    await direct.plugin(inner => {
      const observeConfig = {
        auto: false,
        managedRuntime: {
          mode: 'observe', safeUpdateMarginTokens: 64, allowlist: ['managed-a'],
        },
      }
      expect(() => Reflect.construct(ManagedAwareBasicCompactionEngine, [inner, observeConfig]))
        .toThrow(/requires mode "enforce"/)
    })
  })

  it('uses the same pre-first-event classifier to block direct managed compactNow and compactRegion writes', async () => {
    const h = await mount()
    const managedMessage = h.managed.session.append(
      'user/message', input(`managed direct history ${'M'.repeat(5_000)}`), { surfaceOp: 'append' },
    )
    h.managed.session.append('turn/start', { turn: 1 })

    await expect(h.engine.compactNow(h.managed, new AbortController().signal))
      .rejects.toMatchObject({ code: 'busy' })
    await expect(h.engine.compactRegion(managedMessage.seq, managedMessage.seq, h.managed))
      .rejects.toBeInstanceOf(ManualCompactionError)

    expect(nativeEvents(h.managed)).toEqual([])
    expect(h.adapter.requests).toHaveLength(0)
    expect(h.engine.classifier.isManagedInteractiveRoot(String(h.managed.session.id), 0)).toBe(true)
  })

  it('short-circuits managed pressure and real CONTEXT_WINDOW_EXCEEDED recovery before every native write', async () => {
    const h = await mount()
    const compactIfNeeded = vi.spyOn(h.engine, 'compactIfNeeded')

    h.managed.followup(input('建立焦点。'))
    await h.managed.whenIdle()
    h.adapter.overflowNext = true
    h.managed.followup(input('继续'))
    await h.managed.whenIdle()

    expect(nativeEvents(h.managed)).toEqual([])
    expect(compactIfNeeded.mock.calls.map(([, trigger]) => trigger)).toEqual([
      'pressure', 'pressure', 'context-overflow',
    ])
    expect(h.adapter.requests.filter(request => !isCanaryCall(request))).toHaveLength(2)
    expect(h.managed.session.events.filter(event => event.type === 'compaction/summary')).toHaveLength(0)
    expect(h.managed.session.events.filter(event => event.type === 'compaction/end')).toHaveLength(0)
  })

  it('keeps unmanaged direct-region, compactNow, and pressure delegation on BasicCompaction semantics', async () => {
    const h = await mount()
    const compactIfNeeded = vi.spyOn(h.engine, 'compactIfNeeded')
    expect(await h.engine.compactIfNeeded(h.unmanaged, 'pressure', new AbortController().signal)).toBeNull()
    expect(await h.engine.compactNow(h.unmanaged, new AbortController().signal)).toBeNull()

    h.unmanaged.followup(input('ordinary unmanaged turn'))
    await h.unmanaged.whenIdle()
    h.adapter.overflowNext = true
    h.unmanaged.followup(input('trigger overflow recovery'))
    await h.unmanaged.whenIdle()
    const unmanagedTriggers = compactIfNeeded.mock.calls
      .filter(([agent]) => agent === h.unmanaged)
      .map(([, trigger]) => trigger)
    expect(unmanagedTriggers.filter(trigger => trigger === 'pressure')).toHaveLength(3)
    expect(unmanagedTriggers).toContain('context-overflow')

    const message = h.unmanaged.session.append(
      'user/message', input(`unmanaged direct history ${'U'.repeat(5_000)}`), { surfaceOp: 'append' },
    )
    h.unmanaged.session.append('turn/start', { turn: 1 })
    const result = await h.engine.compactRegion(message.seq, message.seq, h.unmanaged)

    expect(result.shadowedSeqs).toEqual([message.seq])
    expect(nativeEvents(h.unmanaged)).toEqual([
      'compaction/start', 'compaction/summary', 'compaction/end',
      'compaction/start', 'compaction/summary', 'compaction/end',
    ])
    expect(h.adapter.requests.length).toBeGreaterThanOrEqual(4)
  })

  it('removes an agent shadow on handle disposal and mounts no new shadow after listener disposal', async () => {
    const h = await mount()
    const global = h.ctx.commands.find(h.unmanaged, 'compact')
    expect(global).toBeDefined()
    expect(h.ctx.commands.find(h.managed, 'compact')?.handler).not.toBe(global?.handler)

    const first = await h.ctx.commands.execute(h.managed, '/compact', [], new AbortController().signal)
    expect(first?.result).toEqual({ kind: 'error', text: '上下文管理候选尚未换入，本次未压缩。' })
    expect(nativeEvents(h.managed)).toEqual([])
    expect(h.adapter.requests).toHaveLength(0)

    await h.managedHandle.dispose()
    expect(h.ctx.commands.find(h.managed, 'compact')?.handler).toBe(global?.handler)

    await h.manager.dispose()
    const afterListenerDisposed = await h.ctx.agents.create({
      sessionId: SessionId(ContextManager.FOCUS_CANARY_IDS[1]),
      agentOptions: { provider: 'native-test', model: 'native-test-model' },
    })
    expect(h.ctx.commands.find(afterListenerDisposed.agent, 'compact')?.handler).toBe(global?.handler)
    await afterListenerDisposed.dispose()
  })
})
