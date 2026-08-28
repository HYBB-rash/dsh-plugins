import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import {
  createUserMessage,
  LlmAdapter,
  ReasoningEffortId,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import WebRuntime, { type WebSearchRequest } from '@deepseek-ai/dsh-web'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import * as commandCompact from '@deepseek-ai/dsh-command-compact'
import { runGateway, type TelegramHttp } from '../../telegram-gateway/src/index.ts'
import * as ContextManager from '../src/index.ts'
import { ManagedAwareBasicCompactionEngine } from '../src/managed-compaction.ts'

const roots: string[] = []
const contexts: Context[] = []
const sessionId = ContextManager.FOCUS_CANARY_IDS[0]!
const currentMatter = '准备升级 DeepSeek Harness'
const evidenceDirect = '查一下 DeepSeek Harness 当前最新版本；确认后再决定是否升级。'
const updateBackgroundDirect = '请更新当前背景'

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function chunks(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function messageText(messages: GenerateOptions['messages']): string {
  return messages.flatMap(message => message.content)
    .flatMap(block => block.type === 'text' ? [block.text] : [])
    .join('\n')
}

class Adapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  relationOutput: string | undefined
  relationFailure = false
  focusCalls = 0
  relationCalls = 0
  rootCalls = 0

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: 16_384 },
      reasoning: { efforts: [{ id: ReasoningEffortId('off'), name: 'Off' }] },
    })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (options.messages.some(message => message.source.kind === 'plugin'
      && message.source.plugin === 'ui-context-compactor:focus-canary-schema')) {
      this.focusCalls += 1
      yield* chunks(/(?:接受(?:这个|当前)结果|到此结束|这件事结束了|取消(?:这件事|当前这件事))/.test(messageText(options.messages))
        ? JSON.stringify({ kind: 'close', relation: 'current' })
        : JSON.stringify({ kind: 'focus', subject: currentMatter, relation: 'new' }))
      return
    }
    if (options.messages.some(message => message.source.kind === 'plugin'
      && message.source.plugin === 'ui-context-compactor:existing-focus-relation-schema')) {
      this.relationCalls += 1
      if (this.relationFailure) throw new Error('fixture relation provider failure')
      yield* chunks(this.relationOutput ?? JSON.stringify({
        kind: 'existing_focus_relation',
        focus: storedFocusRefFromProjection(messageText(options.messages)),
        relation: 'related',
      }))
      return
    }
    if (options.messages.some(message => message.source.kind === 'plugin'
      && message.source.plugin === 'ui-context-compactor:action-fact-need-schema')) {
      yield* chunks(JSON.stringify({
        actions: ['升级 DeepSeek Harness'],
        proposedRequirements: [{ fact: 'DeepSeek Harness 最新版本', neededFor: ['升级 DeepSeek Harness'] }],
        usableInputs: [],
        unresolvedInputs: [{
          fact: 'DeepSeek Harness 最新版本', meaning: '版本待核清', source: 'direct-user',
          degree: 'unknown', affected: '升级 DeepSeek Harness',
        }],
      }))
      return
    }
    if (options.messages.some(message => message.source.kind === 'plugin'
      && message.source.plugin === 'ui-context-compactor:evidence-schema')) {
      const projection = object(JSON.parse(messageText(options.messages.slice(1))))
      const material = object(projection?.material)
      yield* chunks(JSON.stringify({
        kind: 'direct_fact', fact: projection?.fact,
        conclusion: 'DeepSeek Harness 当前最新稳定版本为 1.4.2',
        appliesWhen: 'stable channel', observedAt: material?.observedAt,
        publishedAt: material?.publishedAt ?? null,
        futureUse: '只用于本次升级前版本判断', source: material?.source,
        degree: 'established', request: projection?.request,
        material: material?.ref, factNeeds: projection?.factNeeds,
      }))
      return
    }
    this.rootCalls += 1
    const direct = [...options.messages].reverse().find(message => message.source.kind === 'user')
    const text = direct === undefined ? 'no-direct' : messageText([direct])
    yield* chunks(options.messages.some(message => message.source.kind === 'plugin'
      && message.source.plugin === 'ui-context-compactor:no-focus')
      ? '当前事项已结束，请告诉我下一件事'
      : `公开回复：${text}`)
  }
}

function storedFocusRefFromProjection(value: string): string {
  const match = /"ref":"([^"]+)"/.exec(value)
  return match?.[1] ?? 'focus:missing'
}

interface Mounted {
  readonly ctx: Context
  readonly agent: Agent
  readonly adapter: Adapter
  readonly root: string
  readonly sqlitePath: string
  updateId: number
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function stored(path: string): Record<string, unknown> | undefined {
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    const row = object(database.prepare(
      'SELECT value FROM "u_context_manager_focus_precanonical" WHERE key = ?',
    ).get(sessionId))
    return typeof row?.value === 'string' ? object(JSON.parse(row.value)) : undefined
  } finally {
    database.close()
  }
}

function snapshot(path: string): string {
  return JSON.stringify(stored(path))
}

function directCount(agent: Agent, value: string): number {
  return agent.session.events.filter(event => event.type === 'user/message'
    && event.data.source.kind === 'user'
    && messageText([event.data]) === value).length
}

async function mount(
  root?: string,
  resume = false,
  adapter = new Adapter(),
  updateId = 1,
): Promise<Mounted> {
  const exactRoot = root ?? await mkdtemp(join(tmpdir(), 'focus-existing-telegram-'))
  if (root === undefined) roots.push(exactRoot)
  const ctx = new Context()
  contexts.push(ctx)
  const sqlitePath = join(exactRoot, 'context-manager.sqlite')
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageSqlite, { path: sqlitePath })
  await ctx.plugin(StorageDomain, { backend: 'sqlite' })
  await ctx.plugin(TokenMeter)
  await ctx.plugin(JsonlSessionPersistence, { root: join(exactRoot, 'sessions'), compression: 'none', packChunks: false })
  await ctx.plugin(CommandRuntime)
  const managedRuntime = {
    mode: 'enforce' as const,
    safeUpdateMarginTokens: 64,
    allowlist: [...ContextManager.FOCUS_CANARY_IDS],
  }
  await ctx.plugin(ManagedAwareBasicCompactionEngine, {
    auto: true, thresholdRatio: .99, retainRatio: .1, managedRuntime,
  })
  await ctx.plugin(commandCompact)
  await ctx.plugin(WebRuntime, { searchProvider: 'focus-existing-search' })
  ctx.web.registerSearchProvider({
    id: 'focus-existing-search',
    available: () => true,
    search: async (_request: WebSearchRequest) => ({
      content: 'private raw envelope',
      sources: [{
        url: 'https://example.test/releases/latest',
        snippet: 'DeepSeek Harness 当前最新稳定版本为 1.4.2。',
        publishedAt: '2026-08-25T09:30:00.000Z',
      }],
      truncated: false,
    }),
  })
  ctx.llm.registerAdapter(['focus-existing-test'], adapter)
  await ctx.plugin(AgentDefaultModel, { provider: 'focus-existing-test', model: 'focus-existing-test' })
  await ctx.plugin(ContextManager, {
    focusCanary: {
      ...managedRuntime,
      auxiliary: {
        provider: 'focus-existing-test', model: 'focus-existing-test',
        maxOutputTokens: 128, timeoutMs: 500, maxExpressionChars: 240,
        maxProjectionTokens: 2_048, safetyMarginTokens: 128,
      },
    },
    nativeWriterArbitration: { mode: 'enforce' },
    evidenceCanary: { mode: 'enforce' },
  })
  await ctx.plugin(AgentLoop, { agents: [] })
  const options = { provider: 'focus-existing-test', model: 'focus-existing-test', maxTokens: 256 }
  const agent = resume
    ? (await ctx.agents.resume({ resumeSessionId: SessionId(sessionId), agentOptions: options })).agent
    : ctx.agentLoop.create(SessionId(sessionId), options)
  for (let pass = 0; pass < 4; pass += 1) {
    await new Promise<void>(resolve => setImmediate(resolve))
    await agent.whenIdle()
  }
  return { ctx, agent, adapter, root: exactRoot, sqlitePath, updateId }
}

async function telegram(harness: Mounted, text: string): Promise<readonly string[]> {
  const lifetime = new AbortController()
  let delivered = false
  const sent: string[] = []
  const updateId = harness.updateId++
  const http: TelegramHttp = {
    getMe: async () => ({ id: 7, username: 'local' }),
    getUpdates: async () => {
      if (!delivered) {
        delivered = true
        return [{ update_id: updateId, message: {
          message_id: updateId, chat: { id: 42, type: 'private' }, text,
        } }]
      }
      lifetime.abort()
      return []
    },
    sendMessage: async (_chat, value) => { sent.push(value); return { messageId: sent.length } },
    sendTyping: async () => {},
    setReaction: async () => {},
  }
  await runGateway(harness.ctx, {
    token: 'local', allowedChatId: '42', sessionId, apiBaseUrl: 'http://127.0.0.1',
    pollTimeoutSeconds: 1, offsetDir: join(harness.root, `offset-${updateId}`),
    maxMessageChars: 4_096, requireInboundInterceptor: false,
  }, http, lifetime.signal)
  await harness.ctx.sessions.flush(harness.agent.session)
  return Object.freeze(sent)
}

async function establishA(harness: Mounted): Promise<string> {
  const sent = await telegram(harness, currentMatter)
  expect(sent).toContain(`公开回复：${currentMatter}`)
  expect(harness.adapter.focusCalls).toBe(1)
  expect(harness.adapter.rootCalls).toBe(1)
  const row = stored(harness.sqlitePath)
  expect(object(row?.decision)?.currentMatter).toBe(currentMatter)
  const detached = await harness.ctx.sessionPersistence.readFrom(harness.agent.session.id, 0)
  expect(detached.events.some(event => event.type === 'user/message'
    && event.data.source.kind === 'user')).toBe(true)
  return snapshot(harness.sqlitePath)
}

async function establishCanonicalA(harness: Mounted): Promise<string> {
  await establishA(harness)
  await telegram(harness, evidenceDirect)
  await telegram(harness, updateBackgroundDirect)
  const row = stored(harness.sqlitePath)
  expect(row?.family).toBe('background')
  expect(object(row?.transaction)?.phase).toBe('finalized')
  expect(object(object(object(row?.transaction)?.material)?.canonicalState)?.focus).toMatchObject({
    kind: 'focus_established', currentMatter,
  })
  return snapshot(harness.sqlitePath)
}

function canonicalFocusRef(path: string): unknown {
  return object(object(object(object(stored(path)?.transaction)?.material)?.canonicalState)?.focus)?.ref
}

async function disposeMounted(harness: Mounted): Promise<void> {
  const index = contexts.indexOf(harness.ctx)
  if (index >= 0) contexts.splice(index, 1)
  await harness.ctx.fiber.dispose()
}

function relationRequest(harness: Mounted): GenerateOptions | undefined {
  return harness.adapter.requests.findLast(request => request.messages.some(message =>
    message.source.kind === 'plugin'
    && message.source.plugin === 'ui-context-compactor:existing-focus-relation-schema'))
}

describe('F02-T1E existing-focus Telegram lifecycle', () => {
  it('P1 keeps A while a related direct expression continues through the public Telegram outcome', async () => {
    let h = await mount()
    await establishCanonicalA(h)
    const expectedFocusRef = canonicalFocusRef(h.sqlitePath)
    const root = h.root
    await disposeMounted(h)
    h = await mount(root, true, new Adapter(), 100)
    const before = snapshot(h.sqlitePath)
    expect(canonicalFocusRef(h.sqlitePath)).toBe(expectedFocusRef)
    const direct = '继续把 A 的风险列完'
    h.adapter.relationOutput = JSON.stringify({
      kind: 'existing_focus_relation', focus: canonicalFocusRef(h.sqlitePath), relation: 'related',
    })
    expect(await telegram(h, direct)).toContain(`公开回复：${direct}`)
    expect(snapshot(h.sqlitePath)).toBe(before)
    expect(h.adapter.rootCalls).toBe(1)
    expect(directCount(h.agent, direct)).toBe(1)
    expect(messageText(relationRequest(h)?.messages ?? [])).toContain(currentMatter)
    expect(relationRequest(h)?.tools).toBeUndefined()
  })

  it('P2 answers one unrelated one-off question truthfully without replacing A', async () => {
    const h = await mount()
    const before = await establishCanonicalA(h)
    const direct = '顺便问一句今天星期几？'
    h.adapter.relationOutput = JSON.stringify({
      kind: 'existing_focus_relation', focus: canonicalFocusRef(h.sqlitePath),
      relation: 'one_off_unrelated',
    })
    expect(await telegram(h, direct)).toContain(`公开回复：${direct}`)
    expect(snapshot(h.sqlitePath)).toBe(before)
    expect(directCount(h.agent, direct)).toBe(1)
    expect(messageText(h.adapter.requests.at(-1)?.messages ?? [])).toContain('一次性插问')
  })

  it('P3 treats polite acknowledgement as non-closing and keeps A', async () => {
    const h = await mount()
    const before = await establishCanonicalA(h)
    const direct = '好，谢谢'
    const rootCalls = h.adapter.rootCalls
    h.adapter.relationOutput = JSON.stringify({
      kind: 'existing_focus_relation', focus: object(stored(h.sqlitePath)?.decision)?.ref,
      relation: 'acknowledgement',
    })
    expect(await telegram(h, direct)).toContain(`公开回复：${direct}`)
    expect(snapshot(h.sqlitePath)).toBe(before)
    expect(h.adapter.rootCalls).toBe(rootCalls + 1)
    expect(h.adapter.relationCalls).toBe(0)
    expect(directCount(h.agent, direct)).toBe(1)
    expect(JSON.stringify(stored(h.sqlitePath))).not.toContain('no_focus')
  })

  it('P4 closes only conservative explicit accept, end, or cancel expressions through the existing C07 no-focus transaction', async () => {
    for (const [index, close] of ['我接受这个结果', '到此结束', '取消当前这件事'].entries()) {
      const h = await mount()
      const before = await establishCanonicalA(h)
      if (index === 0) {
        h.adapter.relationOutput = JSON.stringify({
          kind: 'existing_focus_relation', focus: canonicalFocusRef(h.sqlitePath), relation: 'new_matter',
        })
        await telegram(h, '先别取消当前这件事')
        expect(snapshot(h.sqlitePath)).toBe(before)
        expect(JSON.stringify(stored(h.sqlitePath))).not.toContain('C07')
      }
      expect(await telegram(h, close)).toContain('当前事项已结束，请告诉我下一件事')
      const row = stored(h.sqlitePath)
      const transaction = object(row?.transaction)
      expect(object(object(transaction?.c07)?.identity)?.contract, close).toBe('C07')
      expect(object(object(transaction?.c07)?.value)?.value, close).toMatchObject({ kind: 'no_focus' })
      expect(directCount(h.agent, close), close).toBe(1)
    }
  })

  it('N1 does not mis-sign persistent unrelated work or silently replace A', async () => {
    const h = await mount()
    const before = await establishA(h)
    h.adapter.relationOutput = JSON.stringify({
      kind: 'existing_focus_relation', focus: object(stored(h.sqlitePath)?.decision)?.ref,
      relation: 'new_matter',
    })
    await telegram(h, '现在开始规划项目 B，接下来都做 B')
    expect(snapshot(h.sqlitePath)).toBe(before)
    expect(h.adapter.rootCalls).toBe(1)
    expect(directCount(h.agent, '现在开始规划项目 B，接下来都做 B')).toBe(1)
    expect(JSON.stringify(stored(h.sqlitePath))).not.toContain('项目 B')
    expect(JSON.stringify(stored(h.sqlitePath))).not.toContain('no_focus')
  })

  it('N2 rejects future, unclaimed, or non-current focus identity without changing A', async () => {
    const h = await mount()
    const before = await establishA(h)
    for (const focus of ['focus:future', 'focus:unclaimed', 'focus:foreign-current']) {
      h.adapter.relationOutput = JSON.stringify({
        kind: 'existing_focus_relation', focus, relation: 'related',
      })
      await telegram(h, `继续 A ${focus}`)
      expect(snapshot(h.sqlitePath), focus).toBe(before)
    }
    expect(h.adapter.rootCalls).toBe(1)
    expect(JSON.stringify(stored(h.sqlitePath))).not.toContain('no_focus')
  })

  it('N3 ignores assistant, old-route, cron, and worker non-owner inputs for focus and close', async () => {
    const h = await mount()
    const before = await establishA(h)
    for (const plugin of ['assistant-commitment', 'old-route', 'cron', 'worker']) {
      h.agent.followup(createUserMessage({
        content: [{ type: 'text', text: '这件事结束了' }],
        source: { kind: 'plugin', plugin },
      }))
      await h.agent.whenIdle()
      expect(snapshot(h.sqlitePath), plugin).toBe(before)
    }
    expect(h.adapter.relationCalls).toBe(0)
    expect(h.adapter.rootCalls).toBe(1)
    expect(JSON.stringify(stored(h.sqlitePath))).not.toContain('no_focus')
  })

  it('N4 leaves unknown, multiple, and provider failure undecided without C01 or C07 effects', async () => {
    const h = await mount()
    const before = await establishA(h)
    const focus = object(stored(h.sqlitePath)?.decision)?.ref
    for (const relation of ['unknown', 'multiple'] as const) {
      h.adapter.relationOutput = JSON.stringify({ kind: 'existing_focus_relation', focus, relation })
      await telegram(h, `关系待定 ${relation}`)
      expect(snapshot(h.sqlitePath), relation).toBe(before)
    }
    h.adapter.relationFailure = true
    await telegram(h, '提供方失败')
    expect(snapshot(h.sqlitePath)).toBe(before)
    expect(h.adapter.rootCalls).toBe(1)
    expect(JSON.stringify(stored(h.sqlitePath))).not.toContain('C07')
    expect(JSON.stringify(stored(h.sqlitePath))).not.toContain('no_focus')
  })
})
