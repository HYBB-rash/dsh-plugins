import { afterEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import {
  createAssistantMessage,
  createUserMessage,
  LlmAdapter,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
  type UserMessage,
} from '@deepseek-ai/dsh-llm'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import * as ContextManager from '../src/index.ts'
import {
  FocusAuthority,
  createExplicitUserExpression,
  type ChatRef,
} from '../src/focus.ts'
import { directExpressionHash } from '../src/managed-runtime.ts'

const temporaryRoots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true })
})

function textChunks(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function messagesText(options: GenerateOptions): string {
  return options.messages.flatMap(message => message.content)
    .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

function hasCanarySchema(options: GenerateOptions): boolean {
  return options.messages.some(message => message.source.kind === 'plugin'
    && message.source.plugin === 'ui-context-compactor:focus-canary-schema')
}

class FocusCanaryAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  rootCalls = 0
  auxiliaryCalls = 0
  modelWindow: number | undefined = 8_192
  modelInfoBehavior: 'normal' | 'hang' = 'normal'
  auxiliaryOutput = '{"kind":"focus","subject":"untrusted proposal","relation":"new"}'
  auxiliaryBehavior: 'normal' | 'hang' = 'normal'

  override resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    if (this.modelInfoBehavior === 'hang') {
      return new Promise((_, reject) => {
        if (signal?.aborted === true) {
          reject(new Error('model-info aborted'))
          return
        }
        signal?.addEventListener('abort', () => reject(new Error('model-info aborted')), { once: true })
      })
    }
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      ...this.modelWindow === undefined ? {} : { context: { contextWindow: this.modelWindow } },
    })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (hasCanarySchema(options)) {
      this.auxiliaryCalls += 1
      if (this.auxiliaryBehavior === 'hang') {
        const signal = options.signal
        if (signal === undefined) throw new Error('expected an auxiliary abort signal')
        await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
        return
      }
      yield* textChunks(this.auxiliaryOutput)
      return
    }
    this.rootCalls += 1
    const recoveredNoFocusContinue = options.messages.length === 2
      && options.messages[0]?.source.kind === 'context-manager-canonical'
      && options.messages[0].source.phase === 'finalized'
      && options.messages[1]?.source.kind === 'user'
      && messagesText(options).includes('继续')
    if (recoveredNoFocusContinue) {
      yield* textChunks('当前事项已结束，请告诉我下一件事')
      return
    }
    const advice = messagesText(options).match(/已记录当前焦点：([^\n]+)/)?.[1]
    yield* textChunks(advice === undefined ? '继续处理：未成立焦点' : `继续处理：${advice}`)
  }
}

interface Harness {
  readonly ctx: Context
  readonly agent: Agent
  readonly adapter: FocusCanaryAdapter
  readonly root: string
}

interface CapturedCanaryDomain {
  close(): Promise<void>
  table(name: string): { put(key: string, value: unknown): Promise<void> }
}

type EnforcedCanaryConfig = Extract<NonNullable<ContextManager.Config['focusCanary']>, { readonly mode: 'enforce' }>

const canaryConfig: EnforcedCanaryConfig = {
  mode: 'enforce',
  safeUpdateMarginTokens: 64,
  allowlist: [...ContextManager.FOCUS_CANARY_IDS],
  auxiliary: {
    provider: 'focus-test',
    model: 'focus-test-model',
    maxOutputTokens: 64,
    timeoutMs: 500,
    maxExpressionChars: 240,
    maxProjectionTokens: 1_024,
    safetyMarginTokens: 128,
  },
}

async function mount(
  root: string,
  sessionId: string,
  adapter = new FocusCanaryAdapter(),
  resume = false,
  focusCanary: ContextManager.Config['focusCanary'] = canaryConfig,
  captureCanaryDomain?: (domain: CapturedCanaryDomain) => void,
): Promise<Harness> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  // The canary's DSH_HOME contract owns this exact parent. Do not let the
  // SQLite backend's incidental directory creation hide a path regression.
  await mkdir(join(root, 'storages'), { recursive: true })
  await ctx.plugin(Storage)
  await ctx.plugin(StorageSqlite, { path: join(root, 'storages', 'context-manager-focus-canary.sqlite') })
  await ctx.plugin(StorageDomain, { backend: 'sqlite' })
  await ctx.plugin(TokenMeter)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
  ctx.llm.registerAdapter(['focus-test'], adapter)
  if (captureCanaryDomain !== undefined) {
    const facility = ctx.get('storageDomain') as unknown as {
      open: (spec: unknown) => Promise<{ close(): Promise<void> }>
    }
    const open = facility.open.bind(facility)
    facility.open = async spec => {
      const domain = await open(spec)
      captureCanaryDomain(domain as unknown as CapturedCanaryDomain)
      return domain
    }
  }
  await ctx.plugin(ContextManager, focusCanary === undefined ? {} : { focusCanary })
  await ctx.plugin(AgentLoop, { agents: [] })
  const agent = resume
    ? (await ctx.agents.resume({
        resumeSessionId: SessionId(sessionId),
        agentOptions: { provider: 'focus-test', model: 'focus-test-model' },
      })).agent
    : ctx.agentLoop.create(SessionId(sessionId), { provider: 'focus-test', model: 'focus-test-model' })
  return { ctx, agent, adapter, root }
}

async function send(agent: Agent, text: string): Promise<UserMessage> {
  const message = createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
  agent.send(message, 'next-turn', true)
  await agent.whenIdle()
  return message
}

function directMessages(agent: Agent): Array<Extract<SessionEvent, { type: 'user/message' }>> {
  return agent.session.events.filter((event): event is Extract<SessionEvent, { type: 'user/message' }> =>
    event.type === 'user/message' && event.data.source.kind === 'user')
}

function textOfForTest(message: UserMessage): string | undefined {
  const text = message.content.flatMap(block => block.type === 'text' ? [block.text] : [])
  return text.length === 1 ? text[0] : undefined
}

function assistantMessages(agent: Agent) {
  return agent.session.events.filter(event => event.type === 'assistant/message')
}

function visibleAssistantTexts(agent: Agent): string[] {
  return agent.session.events.flatMap(event => event.type === 'assistant/message'
    ? event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : [])
    : [])
}

function canaryErrors(ctx: Context, agent: Agent): unknown[] {
  const errors: unknown[] = []
  ctx.on('agent/error', ({ agent: subject, error }) => {
    if (subject === agent) errors.push(error)
  })
  return errors
}

function downstreamPreStepCount(ctx: Context, agent: Agent): () => number {
  let count = 0
  ctx.on('agent/pre-step', ({ agent: subject }, next) => {
    if (subject === agent) count += 1
    return next()
  })
  return () => count
}

function claimedBatchTrace(ctx: Context, agent: Agent): () => {
  readonly claims: readonly { readonly turn: number; readonly id: string }[]
  readonly batches: readonly { readonly turn: number; readonly step: number; readonly ids: readonly string[] }[]
} {
  const claims: { turn: number; id: string }[] = []
  const batches: { turn: number; step: number; ids: string[] }[] = []
  ctx.on('agent/inbox/claimed', ({ agent: subject, message, turn }) => {
    if (subject === agent) claims.push({ turn, id: String(message.id) })
  })
  // This is a prepend-only observer, not the downstream listener counted by
  // the assertions below. It proves the public inbox lifecycle's actual
  // claimed batch before H1 rejects its unsupported shape.
  ctx.on('agent/pre-step', ({ agent: subject, messages, turn, step }, next) => {
    if (subject === agent) batches.push({ turn, step, ids: messages.map(message => String(message.id)) })
    return next()
  }, { prepend: true })
  return () => ({ claims, batches })
}

interface StoredFocusRecord {
  readonly original: { readonly messageId: string; readonly hash: string }
  readonly proposal: { readonly kind: 'focus'; readonly relation: 'new'; readonly subject: string }
  readonly decision: {
    readonly kind: 'focus_established'
    readonly ref: string
    readonly chat: string
    readonly currentMatter: string
    readonly latestCorrections: string
  }
}

interface StoredNoFocusRecord {
  readonly focus: StoredFocusRecord
  readonly closure: {
    readonly phase: 'pending' | 'physically_proved'
    readonly original: { readonly messageId: string; readonly hash: string }
    readonly proposal: { readonly kind: 'close'; readonly relation: 'current' }
    readonly decision: {
      readonly kind: 'no_focus'
      readonly ref: string
      readonly chat: string
      readonly latestCorrections: string
    }
  }
  /** Present only once F07-H1 has durably entered its live transaction. */
  readonly transaction?: unknown
}

type StoredCanaryRecord = StoredFocusRecord | StoredNoFocusRecord

function readStoredFocus(root: string, sessionId: string): StoredCanaryRecord {
  // This is a read-only diagnostic of the real sidecar medium, not a plugin
  // test seam: it proves exactly what survives the cold process boundary.
  const database = new DatabaseSync(join(root, 'storages', 'context-manager-focus-canary.sqlite'), { readOnly: true })
  try {
    const row = database.prepare('SELECT value FROM "u_context_manager_focus_precanonical" WHERE key = ?')
      .get(sessionId) as { value: string } | undefined
    if (row === undefined) throw new Error(`missing sidecar record for ${sessionId}`)
    return JSON.parse(row.value) as StoredCanaryRecord
  } finally {
    database.close()
  }
}

function storedFocusCount(root: string): number {
  const database = new DatabaseSync(join(root, 'storages', 'context-manager-focus-canary.sqlite'), { readOnly: true })
  try {
    const row = database.prepare('SELECT COUNT(*) AS count FROM "u_context_manager_focus_precanonical"')
      .get() as { count: number }
    return row.count
  } finally {
    database.close()
  }
}

function hasFocusSidecarTable(root: string): boolean {
  const path = join(root, 'storages', 'context-manager-focus-canary.sqlite')
  if (!existsSync(path)) return false
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    return database.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get('u_context_manager_focus_precanonical') !== undefined
  } finally {
    database.close()
  }
}

function replaceStoredHash(root: string, sessionId: string, hash: string): void {
  const database = new DatabaseSync(join(root, 'storages', 'context-manager-focus-canary.sqlite'))
  try {
    const record = readStoredFocus(root, sessionId)
    if ('focus' in record) throw new Error('expected a focus record')
    const changed: StoredFocusRecord = {
      ...record,
      original: { ...record.original, hash },
    }
    database.prepare('UPDATE "u_context_manager_focus_precanonical" SET value = ? WHERE key = ?')
      .run(JSON.stringify(changed), sessionId)
  } finally {
    database.close()
  }
}

function mutateStoredNoFocus(
  root: string,
  sessionId: string,
  mutate: (record: StoredNoFocusRecord) => StoredNoFocusRecord,
): void {
  const database = new DatabaseSync(join(root, 'storages', 'context-manager-focus-canary.sqlite'))
  try {
    const record = readStoredFocus(root, sessionId)
    if (!('focus' in record)) throw new Error('expected no-focus record')
    database.prepare('UPDATE "u_context_manager_focus_precanonical" SET value = ? WHERE key = ?')
      .run(JSON.stringify(mutate(record)), sessionId)
  } finally {
    database.close()
  }
}

describe('F02-H1/H2 real Harness focus canary', () => {
  it('takes A through natural focus then a finalized F07 close without replaying the claimed input', async () => {
    const root = await mkdtemp(join(tmpdir(), 'focus-canary-'))
    temporaryRoots.push(root)
    const h = await mount(root, ContextManager.FOCUS_CANARY_IDS[0])

    await send(h.agent, '帮我审这份方案')

    expect(h.adapter.auxiliaryCalls).toBe(1)
    expect(h.adapter.rootCalls).toBe(1)
    expect(assistantMessages(h.agent)).toHaveLength(1)
    expect(visibleAssistantTexts(h.agent)).toEqual(['继续处理：帮我审这份方案'])
    expect(messagesText(h.adapter.requests.at(-1)!)).toContain('已记录当前焦点：帮我审这份方案')
    expect(messagesText(h.adapter.requests.at(-1)!)).not.toContain('当前会话路线管理（内部政策）')
    expect(h.adapter.requests.some(hasCanarySchema)).toBe(true)
    expect(h.agent.session.events.filter(event => event.type.startsWith('compaction/'))).toHaveLength(0)
    expect(directMessages(h.agent)).toHaveLength(1)

    const errors = canaryErrors(h.ctx, h.agent)
    const sessions = h.ctx.sessions as unknown as { flush(session: typeof h.agent.session): Promise<boolean> }
    const flush = sessions.flush.bind(sessions)
    let flushResult: boolean | undefined
    sessions.flush = async session => {
      flushResult = await flush(session)
      return flushResult
    }
    const persistence = (h.ctx as unknown as {
      get(name: 'sessionPersistence'): { readFrom(sessionId: string, fromSeq: number): Promise<{ events: readonly SessionEvent[] }> }
    }).get('sessionPersistence')
    const readFrom = persistence.readFrom.bind(persistence)
    const detachedReads: Array<{ readonly fromSeq: number; readonly events: readonly SessionEvent[] }> = []
    persistence.readFrom = async (sessionId, fromSeq) => {
      const result = await readFrom(sessionId, fromSeq)
      detachedReads.push({ fromSeq, events: result.events })
      return result
    }
    h.adapter.auxiliaryOutput = '{"kind":"close","relation":"current"}'
    const close = await send(h.agent, '这件事结束了')
    const record = readStoredFocus(root, ContextManager.FOCUS_CANARY_IDS[0])
    expect(h.adapter.auxiliaryCalls).toBe(2)
    expect(h.adapter.rootCalls).toBe(2)
    expect('focus' in record).toBe(true)
    if (!('focus' in record)) throw new Error('expected physically proved close record')
    const closeEvent = directMessages(h.agent).find(event => String(event.data.id) === String(close.id))
    expect(closeEvent).toBeDefined()
    expect(flushResult).toBe(true)
    const closeRead = detachedReads.find(read => read.events.some(event => event.type === 'user/message'
      && String(event.data.id) === String(close.id)))
    expect(closeRead).toBeDefined()
    expect(closeRead?.events).toHaveLength(1)
    const detachedClose = closeRead?.events[0]
    expect(detachedClose?.seq).toBe(closeEvent!.seq)
    expect(detachedClose?.type).toBe('user/message')
    if (detachedClose?.type !== 'user/message') throw new Error('expected detached close user message')
    expect(String(detachedClose.data.id)).toBe(String(close.id))
    expect(detachedClose.data.source.kind).toBe('user')
    expect(textOfForTest(detachedClose.data)).toBe('这件事结束了')
    expect(directExpressionHash(String(detachedClose.data.id), textOfForTest(detachedClose.data)!))
      .toBe(directExpressionHash(String(close.id), '这件事结束了'))
    expect(directMessages(h.agent).filter(event => String(event.data.id) === String(close.id))).toHaveLength(1)
    expect(closeRead?.events.filter(event => event.type === 'user/message' && String(event.data.id) === String(close.id))).toHaveLength(1)
    expect(record.closure.phase).toBe('physically_proved')
    expect(errors).toEqual([])
    expect(assistantMessages(h.agent)).toHaveLength(2)
    expect(String(directMessages(h.agent)[1]!.data.id)).toBe(String(close.id))
    expect(record.closure.original.messageId).toBe(String(close.id))
    expect(record.closure.original.hash).toBe(directExpressionHash(String(close.id), '这件事结束了'))
    expect(h.agent.session.events.filter(event => event.type.startsWith('tool/')
      || event.type.startsWith('compaction/'))).toHaveLength(0)
  })

  it('cold-repairs the exact finalized H1 tail before a natural continue reaches one no-focus root request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'focus-canary-restart-'))
    temporaryRoots.push(root)
    const sessionId = ContextManager.FOCUS_CANARY_IDS[0]
    const first = await mount(root, sessionId)
    await send(first.agent, '帮我审这份方案')
    first.adapter.auxiliaryOutput = '{"kind":"close","relation":"current"}'
    const close = await send(first.agent, '这件事结束了')
    const canonicalSnapshot = first.agent.session.events.flatMap(event => {
      if (event.type !== 'user/message' || event.data.source.kind !== 'context-manager-canonical') return []
      return [{
        seq: event.seq,
        id: String(event.data.id),
        text: textOfForTest(event.data),
        phase: event.data.source.phase,
        pendingStateRef: event.data.source.pendingStateRef,
        canonicalStateRef: event.data.source.canonicalStateRef,
        generation: event.data.source.generation,
        chat: event.data.source.chat,
        bodyHash: event.data.source.bodyHash,
        machine: {
          kind: event.data.source.machine.kind,
          focusRef: event.data.source.machine.focusRef,
          latestCorrections: event.data.source.machine.latestCorrections,
          closeMessageId: event.data.source.machine.closeMessageId,
          closeHash: event.data.source.machine.closeHash,
        },
      }]
    })
    expect(canonicalSnapshot).toHaveLength(2)
    expect(canonicalSnapshot.map(entry => entry.phase)).toEqual(['current', 'finalized'])
    expect(canonicalSnapshot[0]).toMatchObject({
      text: '当前没有正在进行的事项。请询问用户想开始哪件事。',
      machine: { kind: 'no_focus', closeMessageId: String(close.id) },
    })
    expect(canonicalSnapshot[1]).toMatchObject({
      text: canonicalSnapshot[0]?.text,
      pendingStateRef: canonicalSnapshot[0]?.pendingStateRef,
      canonicalStateRef: canonicalSnapshot[0]?.canonicalStateRef,
      generation: canonicalSnapshot[0]?.generation,
      chat: canonicalSnapshot[0]?.chat,
      machine: canonicalSnapshot[0]?.machine,
    })
    await first.ctx.sessions.flush(first.agent.session)
    await first.ctx.fiber.dispose()
    const beforeRecord = readStoredFocus(root, sessionId)
    expect('focus' in beforeRecord).toBe(true)
    if (!('focus' in beforeRecord)) throw new Error('expected a physically-proved no-focus closure')
    expect(beforeRecord.closure.phase).toBe('physically_proved')
    expect(beforeRecord.closure.original.messageId).toBe(String(close.id))

    const second = await mount(root, sessionId, new FocusCanaryAdapter(), true)
    // `agent/created` has synchronously claimed maintenance.  Waiting for the
    // public whole-agent idle boundary exercises the completed cold-recovery
    // attempt rather than intentionally submitting into its restoring gate.
    await second.agent.whenIdle()
    expect(readStoredFocus(root, sessionId)).toMatchObject({
      transaction: { repair: { phase: 'repair_finalized' } },
    })
    const errors = canaryErrors(second.ctx, second.agent)
    const persistence = (second.ctx as unknown as {
      get(name: 'sessionPersistence'): { readFrom(sessionId: string, fromSeq: number): Promise<{ events: readonly SessionEvent[] }> }
    }).get('sessionPersistence')
    const readFrom = persistence.readFrom.bind(persistence)
    const detachedReads: Array<readonly SessionEvent[]> = []
    persistence.readFrom = async (id, seq) => {
      const read = await readFrom(id, seq)
      detachedReads.push(read.events)
      return read
    }
    const continued = await send(second.agent, '继续')
    const newMatter = await send(second.agent, '请开始另一件事')
    persistence.readFrom = readFrom
    const direct = directMessages(second.agent)

    expect(second.adapter.auxiliaryCalls).toBe(0)
    expect(second.adapter.rootCalls).toBe(1)
    expect(errors.map(error => error instanceof Error ? error.message : String(error))).toEqual([
      '唯一背景未能安全换入，本轮未继续行动',
    ])
    expect(direct).toHaveLength(4)
    expect(String(direct[1]?.data.id)).toBe(String(close.id))
    expect(direct.filter(event => String(event.data.id) === String(continued.id))).toHaveLength(1)
    expect(detachedReads).toHaveLength(1)
    for (const message of [newMatter]) {
      const sessionEvent = direct.find(event => String(event.data.id) === String(message.id))
      expect(sessionEvent).toBeDefined()
      expect(direct.filter(event => String(event.data.id) === String(message.id))).toHaveLength(1)
      const detached = detachedReads.find(events => events.some(event => event.type === 'user/message'
        && String(event.data.id) === String(message.id)))
      expect(detached).toBeDefined()
      const event = detached?.find(event => event.type === 'user/message'
        && String(event.data.id) === String(message.id))
      expect(event?.seq).toBe(sessionEvent!.seq)
      expect(event?.type).toBe('user/message')
      if (event?.type !== 'user/message') throw new Error('expected detached post-close input')
      expect(event.data.source.kind).toBe('user')
      expect(textOfForTest(event.data)).toBe(textOfForTest(message))
      expect(directExpressionHash(String(event.data.id), textOfForTest(event.data)!))
        .toBe(directExpressionHash(String(message.id), textOfForTest(message)!))
      expect(detached?.filter(candidate => candidate.type === 'user/message'
        && String(candidate.data.id) === String(message.id))).toHaveLength(1)
    }
    const recoveredRequest = second.adapter.requests.at(-1)
    expect(recoveredRequest).toBeDefined()
    expect(recoveredRequest?.messages.map(message => message.role)).toEqual(['user', 'user'])
    expect(recoveredRequest?.messages[0]?.source.kind).toBe('context-manager-canonical')
    expect(recoveredRequest?.messages[1]?.source.kind).toBe('user')
    expect(visibleAssistantTexts(second.agent).at(-1)).toBe('当前事项已结束，请告诉我下一件事')
    expect(second.adapter.requests.every(request => !messagesText(request).includes('focus_precanonical'))).toBe(true)
    expect(visibleAssistantTexts(second.agent)).toEqual([
      '继续处理：帮我审这份方案',
      '继续处理：未成立焦点',
      '当前事项已结束，请告诉我下一件事',
    ])
    const canonicalAfterRestart = second.agent.session.events.flatMap(event => {
      if (event.type !== 'user/message' || event.data.source.kind !== 'context-manager-canonical') return []
      return [{
        seq: event.seq,
        id: String(event.data.id),
        text: textOfForTest(event.data),
        phase: event.data.source.phase,
        pendingStateRef: event.data.source.pendingStateRef,
        canonicalStateRef: event.data.source.canonicalStateRef,
        generation: event.data.source.generation,
        chat: event.data.source.chat,
        bodyHash: event.data.source.bodyHash,
        machine: {
          kind: event.data.source.machine.kind,
          focusRef: event.data.source.machine.focusRef,
          latestCorrections: event.data.source.machine.latestCorrections,
          closeMessageId: event.data.source.machine.closeMessageId,
          closeHash: event.data.source.machine.closeHash,
        },
      }]
    })
    expect(canonicalAfterRestart.slice(0, 2)).toEqual(canonicalSnapshot)
    expect(canonicalAfterRestart).toHaveLength(3)
    expect(canonicalAfterRestart[2]).toMatchObject({
      phase: 'finalized',
      text: canonicalSnapshot[1]?.text,
      pendingStateRef: canonicalSnapshot[1]?.pendingStateRef,
      canonicalStateRef: canonicalSnapshot[1]?.canonicalStateRef,
      generation: canonicalSnapshot[1]?.generation,
      chat: canonicalSnapshot[1]?.chat,
      bodyHash: canonicalSnapshot[1]?.bodyHash,
      machine: canonicalSnapshot[1]?.machine,
    })
    expect(canonicalAfterRestart[2]?.id).not.toBe(canonicalSnapshot[1]?.id)
    expect(second.agent.session.events.filter(event => event.type.startsWith('tool/')
      || event.type.startsWith('compaction/'))).toHaveLength(0)
    await second.ctx.sessions.flush(second.agent.session)
    await second.ctx.fiber.dispose()
    const afterRecord = readStoredFocus(root, sessionId)
    expect(afterRecord).toMatchObject({
      closure: beforeRecord.closure,
      transaction: { repair: { phase: 'repair_finalized' } },
    })
  })

  it('keeps B unrelated, rejects a natural thanks without closing, and leaves A independently continuable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'focus-canary-isolation-'))
    temporaryRoots.push(root)
    const a = await mount(root, ContextManager.FOCUS_CANARY_IDS[0])
    await send(a.agent, '帮我审这份方案')
    await a.ctx.sessions.flush(a.agent.session)
    await a.ctx.fiber.dispose()
    const beforeB = readStoredFocus(root, ContextManager.FOCUS_CANARY_IDS[0])

    const b = await mount(root, ContextManager.FOCUS_CANARY_IDS[1])
    await send(b.agent, '帮我规划周末徒步')
    expect(messagesText(b.adapter.requests.at(-1)!)).toContain('已记录当前焦点：帮我规划周末徒步')
    expect(messagesText(b.adapter.requests.at(-1)!)).not.toContain('帮我审这份方案')
    expect(visibleAssistantTexts(b.agent)).toEqual(['继续处理：帮我规划周末徒步'])
    const beforeThanks = readStoredFocus(root, ContextManager.FOCUS_CANARY_IDS[1])
    expect('focus' in beforeThanks).toBe(false)
    const bErrors = canaryErrors(b.ctx, b.agent)
    await send(b.agent, '好，谢谢')
    expect(b.adapter.auxiliaryCalls).toBe(1)
    expect(b.adapter.rootCalls).toBe(1)
    expect(bErrors.map(error => error instanceof Error ? error.message : String(error))).toEqual(['focus-canary'])
    expect(visibleAssistantTexts(b.agent)).toEqual(['继续处理：帮我规划周末徒步'])
    expect(readStoredFocus(root, ContextManager.FOCUS_CANARY_IDS[1])).toEqual(beforeThanks)
    await b.ctx.sessions.flush(b.agent.session)
    await b.ctx.fiber.dispose()
    expect(readStoredFocus(root, ContextManager.FOCUS_CANARY_IDS[0])).toEqual(beforeB)

    const resumedA = await mount(root, ContextManager.FOCUS_CANARY_IDS[0], new FocusCanaryAdapter(), true)
    await send(resumedA.agent, '继续')
    expect(resumedA.adapter.auxiliaryCalls).toBe(0)
    expect(messagesText(resumedA.adapter.requests.at(-1)!)).toContain('已记录当前焦点：帮我审这份方案')
    expect(visibleAssistantTexts(resumedA.agent).at(-1)).toBe('继续处理：帮我审这份方案')
    await resumedA.ctx.sessions.flush(resumedA.agent.session)
    await resumedA.ctx.fiber.dispose()
    expect(readStoredFocus(root, ContextManager.FOCUS_CANARY_IDS[0])).toEqual(beforeB)
  })

  it('keeps nonallowlisted/cron inputs outside H1 and closes startup or fresh missing-persistence inputs safely', async () => {
    const root = await mkdtemp(join(tmpdir(), 'focus-canary-bypass-'))
    temporaryRoots.push(root)
    const h = await mount(root, 'session-cron-focus-canary')
    await send(h.agent, '帮我审这份方案')
    expect(h.adapter.auxiliaryCalls).toBe(0)
    expect(h.adapter.rootCalls).toBeGreaterThanOrEqual(1)
    expect(messagesText(h.adapter.requests[0]!)).not.toContain('已记录当前焦点')

    const { safeUpdateMarginTokens: _omittedMargin, ...missingMarginCanaryConfig } = canaryConfig
    const cases: readonly {
      readonly name: string
      readonly mount: (ctx: Context, root: string) => Promise<void>
      readonly failure: 'dependency' | 'no-persistence' | 'open' | 'allowlist' | 'margin'
      readonly focusCanary?: EnforcedCanaryConfig
    }[] = [
      {
        name: 'storageDomain',
        mount: async ctx => { await ctx.plugin(TokenMeter) },
        failure: 'dependency',
      },
      {
        name: 'tokenMeter',
        mount: async (ctx, root) => {
          await ctx.plugin(Storage)
          await ctx.plugin(StorageSqlite, { path: join(root, 'missing-token-meter.sqlite') })
          await ctx.plugin(StorageDomain, { backend: 'sqlite' })
        },
        failure: 'dependency',
      },
      {
        name: 'sessionPersistence',
        mount: async (ctx, root) => {
          await mkdir(join(root, 'storages'), { recursive: true })
          await ctx.plugin(Storage)
          await ctx.plugin(StorageSqlite, { path: join(root, 'storages', 'context-manager-focus-canary.sqlite') })
          await ctx.plugin(StorageDomain, { backend: 'sqlite' })
          await ctx.plugin(TokenMeter)
        },
        failure: 'no-persistence',
      },
      {
        name: 'sidecar-open',
        mount: async (ctx, root) => {
          await ctx.plugin(Storage)
          // An existing directory is not a SQLite medium. The storage backend
          // is mounted, but ContextManager's awaited domain open must reject.
          await ctx.plugin(StorageSqlite, { path: root })
          await ctx.plugin(StorageDomain, { backend: 'sqlite' })
          await ctx.plugin(TokenMeter)
          await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
        },
        failure: 'open',
      },
      {
        name: 'duplicate-allowlist',
        mount: async (ctx, root) => {
          await ctx.plugin(Storage)
          await ctx.plugin(StorageSqlite, { path: join(root, 'duplicate-allowlist.sqlite') })
          await ctx.plugin(StorageDomain, { backend: 'sqlite' })
          await ctx.plugin(TokenMeter)
          await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
        },
        failure: 'allowlist',
        focusCanary: { ...canaryConfig, allowlist: [ContextManager.FOCUS_CANARY_IDS[0], ContextManager.FOCUS_CANARY_IDS[0]] },
      },
      {
        name: 'missing-safe-update-margin',
        mount: async (ctx, root) => {
          await ctx.plugin(Storage)
          await ctx.plugin(StorageSqlite, { path: join(root, 'missing-margin.sqlite') })
          await ctx.plugin(StorageDomain, { backend: 'sqlite' })
          await ctx.plugin(TokenMeter)
        },
        failure: 'margin',
        focusCanary: missingMarginCanaryConfig,
      },
    ]
    for (const testCase of cases) {
      const root = await mkdtemp(join(tmpdir(), `focus-canary-missing-${testCase.name}-`))
      temporaryRoots.push(root)
      const ctx = new Context()
      contexts.push(ctx)
      await mountAgentLoopTestDependencies(ctx)
      const adapter = new FocusCanaryAdapter()
      ctx.llm.registerAdapter(['focus-test'], adapter)
      await testCase.mount(ctx, root)
      let domainOpens = 0
      const facility = ctx.get('storageDomain') as unknown as {
        open?: (spec: unknown) => Promise<unknown>
      } | undefined
      if (facility?.open !== undefined) {
        const open = facility.open.bind(facility)
        facility.open = async spec => {
          domainOpens += 1
          return await open(spec)
        }
      }
      if (testCase.failure === 'no-persistence') {
        await expect(ctx.plugin(ContextManager, { focusCanary: testCase.focusCanary ?? canaryConfig }), testCase.name).resolves.toBeDefined()
        expect(domainOpens, testCase.name).toBe(1)
        await ctx.plugin(AgentLoop, { agents: [] })
        const agent = ctx.agentLoop.create(SessionId(ContextManager.FOCUS_CANARY_IDS[0]), {
          provider: 'focus-test', model: 'focus-test-model',
        })
        const errors = canaryErrors(ctx, agent)
        await send(agent, '帮我审这份方案')
        const focusBeforeClose = readStoredFocus(root, ContextManager.FOCUS_CANARY_IDS[0])
        expect('focus' in focusBeforeClose, testCase.name).toBe(false)
        const close = await send(agent, '这件事结束了')
        expect(adapter.auxiliaryCalls, testCase.name).toBe(1)
        expect(adapter.rootCalls, testCase.name).toBe(1)
        expect(adapter.requests.filter(hasCanarySchema), testCase.name).toHaveLength(1)
        expect(errors.map(error => error instanceof Error ? error.message : String(error)), testCase.name)
          .toEqual(['focus-canary'])
        expect(assistantMessages(agent), testCase.name).toHaveLength(1)
        expect(directMessages(agent), testCase.name).toHaveLength(2)
        const closeEvents = directMessages(agent).filter(event => String(event.data.id) === String(close.id))
        expect(closeEvents, testCase.name).toHaveLength(1)
        expect(closeEvents[0]?.data.source.kind, testCase.name).toBe('user')
        expect(textOfForTest(closeEvents[0]!.data), testCase.name).toBe('这件事结束了')
        expect(readStoredFocus(root, ContextManager.FOCUS_CANARY_IDS[0]), testCase.name).toEqual(focusBeforeClose)
        continue
      }
      const loading = expect(ctx.plugin(ContextManager, { focusCanary: testCase.focusCanary ?? canaryConfig }), testCase.name).rejects
      if (testCase.failure === 'dependency') {
        await loading.toThrow('focus canary enforce requires storageDomain and tokenMeter')
      } else if (testCase.failure === 'allowlist') {
        await loading.toThrow('focus canary allowlist must contain exactly the two H1 chat ids')
      } else if (testCase.failure === 'margin') {
        expect(Object.hasOwn(testCase.focusCanary!, 'safeUpdateMarginTokens'), testCase.name).toBe(false)
        await loading.toThrow('managed enforce mode requires a positive safeUpdateMarginTokens')
        expect(domainOpens, testCase.name).toBe(0)
      } else {
        await loading.toThrow()
      }
      if (testCase.failure === 'open') {
        expect(domainOpens, testCase.name).toBeGreaterThan(0)
      } else {
        expect(domainOpens, testCase.name).toBe(0)
      }
      expect(ctx.agents.get(SessionId(ContextManager.FOCUS_CANARY_IDS[0])), testCase.name).toBeUndefined()
      expect(adapter.requests, testCase.name).toHaveLength(0)
    }

    const observe = new Context()
    contexts.push(observe)
    await mountAgentLoopTestDependencies(observe)
    const observeAdapter = new FocusCanaryAdapter()
    observe.llm.registerAdapter(['focus-test'], observeAdapter)
    await expect(observe.plugin(ContextManager, { focusCanary: { mode: 'observe' } })).resolves.toBeDefined()
    expect(observe.get('storageDomain')).toBeUndefined()
    expect(observe.get('tokenMeter')).toBeUndefined()
    expect(observeAdapter.requests).toHaveLength(0)

    const observeRoot = await mkdtemp(join(tmpdir(), 'focus-canary-observe-'))
    temporaryRoots.push(observeRoot)
    const observed = await mount(
      observeRoot,
      ContextManager.FOCUS_CANARY_IDS[0],
      new FocusCanaryAdapter(),
      false,
      { mode: 'observe' },
    )
    await send(observed.agent, '帮我审这份方案')
    expect(observed.adapter.auxiliaryCalls).toBe(0)
    // The ordinary legacy route reducer may use the configured root adapter;
    // observe must add no focus provider dispatch or focus request material.
    expect(observed.adapter.rootCalls).toBeGreaterThanOrEqual(1)
    expect(observed.adapter.requests.some(hasCanarySchema)).toBe(false)
    expect(observed.adapter.requests.every(request => !messagesText(request).includes('已记录当前焦点：'))).toBe(true)
    // A SQLite backend medium may exist independently of a domain. Creating
    // this empty test medium must not reveal a context-manager table: observe
    // never opens the canary domain or writes its sidecar.
    const observeSidecarPath = join(observeRoot, 'storages', 'context-manager-focus-canary.sqlite')
    const emptyBackend = new DatabaseSync(observeSidecarPath)
    emptyBackend.close()
    expect(existsSync(observeSidecarPath)).toBe(true)
    expect(hasFocusSidecarTable(observeRoot)).toBe(false)

    const lifecycleRoot = await mkdtemp(join(tmpdir(), 'focus-canary-domain-dispose-'))
    temporaryRoots.push(lifecycleRoot)
    await mkdir(join(lifecycleRoot, 'storages'), { recursive: true })
    const lifecycle = new Context()
    contexts.push(lifecycle)
    await mountAgentLoopTestDependencies(lifecycle)
    await lifecycle.plugin(Storage)
    await lifecycle.plugin(StorageSqlite, { path: join(lifecycleRoot, 'storages', 'context-manager-focus-canary.sqlite') })
    await lifecycle.plugin(StorageDomain, { backend: 'sqlite' })
    await lifecycle.plugin(TokenMeter)
    await lifecycle.plugin(JsonlSessionPersistence, { root: join(lifecycleRoot, 'sessions'), compression: 'none' })
    const systemPrompt = lifecycle.get('systemPrompt') as unknown as {
      context: (entry: unknown) => () => void
    }
    const realContext = systemPrompt.context.bind(systemPrompt)
    systemPrompt.context = () => { throw new Error('forced post-open registration failure') }
    await expect(lifecycle.plugin(ContextManager, { focusCanary: canaryConfig })).rejects
      .toThrow('forced post-open registration failure')
    systemPrompt.context = realContext
    // A second actual canary installation re-opens the identical named Domain;
    // storage-domain would reject `already-open` if the failed first apply had
    // leaked its post-open handle.
    await expect(lifecycle.plugin(ContextManager, { focusCanary: canaryConfig })).resolves.toBeDefined()
  })

  it('fails closed for bounded budget/window/timeout/malformed output without a root call or synthetic assistant', async () => {
    const cases: readonly {
      readonly name: string
      readonly configure: (adapter: FocusCanaryAdapter) => void
      readonly focusCanary?: EnforcedCanaryConfig
      readonly expectedAuxiliaryCalls: number
    }[] = [
      {
        name: 'unknown-window',
        configure: adapter => { adapter.modelWindow = undefined },
        expectedAuxiliaryCalls: 0,
      },
      {
        name: 'projection-budget',
        configure: () => {},
        focusCanary: {
          ...canaryConfig,
          auxiliary: { ...canaryConfig.auxiliary, maxProjectionTokens: 1 },
        },
        expectedAuxiliaryCalls: 0,
      },
      {
        name: 'malformed',
        configure: adapter => { adapter.auxiliaryOutput = '{not-json' },
        expectedAuxiliaryCalls: 1,
      },
      {
        name: 'stream-timeout',
        configure: adapter => { adapter.auxiliaryBehavior = 'hang' },
        focusCanary: {
          ...canaryConfig,
          auxiliary: { ...canaryConfig.auxiliary, timeoutMs: 5 },
        },
        expectedAuxiliaryCalls: 1,
      },
      {
        name: 'model-info-timeout',
        configure: adapter => { adapter.modelInfoBehavior = 'hang' },
        focusCanary: {
          ...canaryConfig,
          auxiliary: { ...canaryConfig.auxiliary, timeoutMs: 5 },
        },
        expectedAuxiliaryCalls: 0,
      },
    ]
    for (const testCase of cases) {
      const root = await mkdtemp(join(tmpdir(), `focus-canary-${testCase.name}-`))
      temporaryRoots.push(root)
      const adapter = new FocusCanaryAdapter()
      testCase.configure(adapter)
      const h = await mount(
        root,
        ContextManager.FOCUS_CANARY_IDS[0],
        adapter,
        false,
        testCase.focusCanary ?? canaryConfig,
      )
      const errors = canaryErrors(h.ctx, h.agent)
      const sent = await send(h.agent, '帮我审这份方案')
      expect(adapter.auxiliaryCalls, testCase.name).toBe(testCase.expectedAuxiliaryCalls)
      expect(adapter.rootCalls, testCase.name).toBe(0)
      expect(errors.map(error => error instanceof Error ? error.message : String(error)), testCase.name).toContain('focus-canary')
      expect(directMessages(h.agent), testCase.name).toHaveLength(1)
      expect(directMessages(h.agent).map(event => String(event.data.id)), testCase.name).toEqual([String(sent.id)])
      expect(assistantMessages(h.agent), testCase.name).toHaveLength(0)
    }

    const proofFailures: readonly {
      readonly name: 'append' | 'flush-false' | 'readFrom' | 'readFrom-corrupt'
      readonly breakProof: (h: Harness) => () => void
    }[] = [
      {
        name: 'append',
        breakProof: h => {
          const session = h.agent.session as unknown as {
            append: (type: string, data: UserMessage, options?: unknown) => unknown
          }
          const append = session.append.bind(session)
          session.append = (type, data, options) => {
            if (type === 'user/message' && textOfForTest(data) === '这件事结束了') {
              throw new Error('forced append failure')
            }
            return append(type, data, options)
          }
          return () => { session.append = append }
        },
      },
      {
        name: 'flush-false',
        breakProof: h => {
          const sessions = (h.ctx as unknown as {
            get(name: 'sessions'): { flush(session: typeof h.agent.session): Promise<boolean> }
          }).get('sessions')
          const flush = sessions.flush.bind(sessions)
          sessions.flush = async () => false
          return () => { sessions.flush = flush }
        },
      },
      {
        name: 'readFrom',
        breakProof: h => {
          const persistence = (h.ctx as unknown as {
            get(name: 'sessionPersistence'): {
              readFrom(sessionId: string, fromSeq: number): Promise<{ events: readonly SessionEvent[] }>
            }
          }).get('sessionPersistence')
          const readFrom = persistence.readFrom.bind(persistence)
          persistence.readFrom = async () => { throw new Error('forced detached read failure') }
          return () => { persistence.readFrom = readFrom }
        },
      },
      {
        name: 'readFrom-corrupt',
        breakProof: h => {
          const persistence = (h.ctx as unknown as {
            get(name: 'sessionPersistence'): {
              readFrom(sessionId: string, fromSeq: number): Promise<{ events: readonly SessionEvent[] }>
            }
          }).get('sessionPersistence')
          const readFrom = persistence.readFrom.bind(persistence)
          persistence.readFrom = async (sessionId, fromSeq) => {
            const result = await readFrom(sessionId, fromSeq)
            const event = result.events[0]
            if (event?.type !== 'user/message') return result
            return {
              events: [{
                ...event,
                seq: event.seq + 1,
                data: createUserMessage({
                  content: [{ type: 'text', text: 'tampered detached text' }],
                  source: { kind: 'plugin', plugin: 'tampered-detached-source' },
                }),
              }],
            }
          }
          return () => { persistence.readFrom = readFrom }
        },
      },
    ]
    for (const proofFailure of proofFailures) {
      const root = await mkdtemp(join(tmpdir(), `focus-canary-proof-${proofFailure.name}-`))
      temporaryRoots.push(root)
      const h = await mount(root, ContextManager.FOCUS_CANARY_IDS[0])
      await send(h.agent, '帮我审这份方案')
      h.adapter.auxiliaryOutput = '{"kind":"close","relation":"current"}'
      const errors = canaryErrors(h.ctx, h.agent)
      const restore = proofFailure.breakProof(h)
      try {
        await send(h.agent, '这件事结束了')
      } finally {
        restore()
      }
      const stored = readStoredFocus(root, ContextManager.FOCUS_CANARY_IDS[0])
      expect('focus' in stored, proofFailure.name).toBe(true)
      if (!('focus' in stored)) throw new Error('expected pending close record')
      expect(stored.closure.phase, proofFailure.name).toBe('pending')
      expect(h.adapter.auxiliaryCalls, proofFailure.name).toBe(2)
      expect(h.adapter.rootCalls, proofFailure.name).toBe(1)
      expect(errors.map(error => error instanceof Error ? error.message : String(error)), proofFailure.name)
        .toEqual(['focus-canary'])
      expect(visibleAssistantTexts(h.agent), proofFailure.name).toEqual(['继续处理：帮我审这份方案'])
      // Restore the public fault, then make every still-buffered event durable
      // before cold restart. Pending remains untrusted whether the close
      // event is absent (append) or now physically present (flush/readFrom).
      await h.ctx.sessions.flush(h.agent.session)
      await h.ctx.fiber.dispose()
      const restarted = await mount(root, ContextManager.FOCUS_CANARY_IDS[0], new FocusCanaryAdapter(), true)
      const restartErrors = canaryErrors(restarted.ctx, restarted.agent)
      await send(restarted.agent, '继续')
      const afterRestart = readStoredFocus(root, ContextManager.FOCUS_CANARY_IDS[0])
      expect('focus' in afterRestart, proofFailure.name).toBe(true)
      if (!('focus' in afterRestart)) throw new Error('expected pending close after restart')
      expect(afterRestart.closure.phase, proofFailure.name).toBe('pending')
      expect(restarted.adapter.auxiliaryCalls, proofFailure.name).toBe(0)
      expect(restarted.adapter.rootCalls, proofFailure.name).toBe(0)
      expect(restartErrors.map(error => error instanceof Error ? error.message : String(error)), proofFailure.name)
        .toEqual(['唯一背景未能安全换入，本轮未继续行动'])
    }
  })

  it('rejects durable prior assistant, route, native, and compaction evidence before provider dispatch', async () => {
    const priors: readonly {
      readonly name: string
      readonly append: (agent: Agent) => void
    }[] = [
      {
        name: 'assistant',
        append: agent => {
          agent.session.append('assistant/message', {
            turn: 1,
            step: 1,
            message: createAssistantMessage({
              content: [{ type: 'text', text: '这件事结束了' }],
              source: { provider: 'focus-test', model: 'focus-test-model' },
            }),
          }, { surfaceOp: 'append' })
        },
      },
      {
        name: 'route',
        append: agent => {
          agent.session.append('user/message', createUserMessage({
            content: [{ type: 'text', text: '这件事结束了' }],
            source: { kind: 'plugin', plugin: 'context-route' },
          }), { surfaceOp: 'append' })
        },
      },
      {
        name: 'native',
        append: agent => {
          agent.session.append('user/message', createUserMessage({
            content: [{ type: 'text', text: '这件事结束了' }],
            source: { kind: 'plugin', plugin: 'native-checkpoint' },
          }), { surfaceOp: 'append' })
        },
      },
      {
        name: 'compaction',
        append: agent => {
          const compactionId = CompactionId('prior-compaction')
          agent.session.append('compaction/start', { compactionId, turn: null })
          agent.session.append('compaction/end', { compactionId, turn: null })
        },
      },
    ]
    for (const prior of priors) {
      const root = await mkdtemp(join(tmpdir(), `focus-canary-prior-${prior.name}-`))
      temporaryRoots.push(root)
      const h = await mount(root, ContextManager.FOCUS_CANARY_IDS[0])
      const errors = canaryErrors(h.ctx, h.agent)
      prior.append(h.agent)
      await h.ctx.sessions.flush(h.agent.session)
      await send(h.agent, '帮我审这份方案')
      expect(h.adapter.auxiliaryCalls, prior.name).toBe(0)
      expect(h.adapter.rootCalls, prior.name).toBe(0)
      expect(errors, prior.name).toHaveLength(1)
      expect(directMessages(h.agent), prior.name).toHaveLength(1)
      expect(storedFocusCount(root), prior.name).toBe(0)
    }

    const nonDirectCloseSources: readonly {
      readonly name: 'assistant' | 'plugin' | 'native' | 'context'
      readonly submit: (agent: Agent) => Promise<void>
      readonly expectedErrors: number
    }[] = [
      {
        name: 'assistant',
        submit: async agent => {
          agent.session.append('assistant/message', {
            turn: 1,
            step: 2,
            message: createAssistantMessage({
              content: [{ type: 'text', text: '这件事结束了' }],
              source: { provider: 'focus-test', model: 'focus-test-model' },
            }),
          }, { surfaceOp: 'append' })
        },
        expectedErrors: 0,
      },
      ...(['plugin', 'native', 'context'] as const).map(name => ({
        name,
        submit: async (agent: Agent) => {
          agent.send(createUserMessage({
            content: [{ type: 'text', text: '这件事结束了' }],
            source: {
              kind: 'plugin' as const,
              plugin: name === 'native' ? 'native-checkpoint' : name === 'context' ? 'focused-test-context' : 'focused-test-plugin',
            },
          }), 'next-turn', true)
          await agent.whenIdle()
        },
        expectedErrors: 1,
      })),
    ]
    for (const source of nonDirectCloseSources) {
      const root = await mkdtemp(join(tmpdir(), `focus-canary-nondirect-close-${source.name}-`))
      temporaryRoots.push(root)
      const h = await mount(root, ContextManager.FOCUS_CANARY_IDS[0])
      await send(h.agent, '帮我审这份方案')
      const focusBefore = readStoredFocus(root, ContextManager.FOCUS_CANARY_IDS[0])
      expect('focus' in focusBefore, source.name).toBe(false)
      const errors = canaryErrors(h.ctx, h.agent)
      await source.submit(h.agent)
      expect(readStoredFocus(root, ContextManager.FOCUS_CANARY_IDS[0]), source.name).toEqual(focusBefore)
      expect(h.adapter.auxiliaryCalls, source.name).toBe(1)
      expect(h.adapter.rootCalls, source.name).toBe(1)
      expect(errors, source.name).toHaveLength(source.expectedErrors)
      expect(errors.map(error => error instanceof Error ? error.message : String(error)), source.name)
        .not.toContain('已识别方向变化，但唯一背景尚未安全换入，本轮未继续行动')
    }
  })

  it('rejects a proposal bound to A when authority receives B, with no C01 business result', () => {
    const aOrigin = { messageId: 'a-direct', hash: directExpressionHash('a-direct', '帮我审这份方案') }
    const bOrigin = { messageId: 'b-direct', hash: directExpressionHash('b-direct', '帮我规划周末徒步') }
    const a = createExplicitUserExpression('帮我审这份方案', 'chat-a' as ChatRef, aOrigin)
    const b = createExplicitUserExpression('帮我规划周末徒步', 'chat-b' as ChatRef, {
      ...bOrigin,
    })
    const result = FocusAuthority.fromBoundProposal({
      kind: 'proposal',
      origin: aOrigin,
      value: {
        kind: 'focus',
        relation: 'new',
        subject: 'untrusted A proposal',
        origin: aOrigin,
      },
    }).decideFocus(b)
    expect(a.expression).toBe('帮我审这份方案')
    expect(result.kind).not.toBe('business_result')
  })

  it('stops on rejudge mismatches, sidecar proof-commit failure, and unsupported claimed batch shapes', async () => {
    const hashRoot = await mkdtemp(join(tmpdir(), 'focus-canary-hash-mismatch-'))
    temporaryRoots.push(hashRoot)
    const first = await mount(hashRoot, ContextManager.FOCUS_CANARY_IDS[0])
    await send(first.agent, '帮我审这份方案')
    await first.ctx.sessions.flush(first.agent.session)
    await first.ctx.fiber.dispose()
    replaceStoredHash(hashRoot, ContextManager.FOCUS_CANARY_IDS[0], '0'.repeat(64))
    const resumed = await mount(hashRoot, ContextManager.FOCUS_CANARY_IDS[0], new FocusCanaryAdapter(), true)
    const hashErrors = canaryErrors(resumed.ctx, resumed.agent)
    await send(resumed.agent, '继续')
    expect(resumed.adapter.auxiliaryCalls).toBe(0)
    expect(resumed.adapter.rootCalls).toBe(0)
    expect(hashErrors).toHaveLength(1)

    const rejudgeRoot = await mkdtemp(join(tmpdir(), 'focus-canary-close-rejudge-mismatch-'))
    temporaryRoots.push(rejudgeRoot)
    const rejudgeFirst = await mount(rejudgeRoot, ContextManager.FOCUS_CANARY_IDS[0])
    await send(rejudgeFirst.agent, '帮我审这份方案')
    rejudgeFirst.adapter.auxiliaryOutput = '{"kind":"close","relation":"current"}'
    await send(rejudgeFirst.agent, '这件事结束了')
    await rejudgeFirst.ctx.sessions.flush(rejudgeFirst.agent.session)
    await rejudgeFirst.ctx.fiber.dispose()
    // This is a post-write corruption fault, not a fixture C01/C08 result:
    // the close itself above travelled through Agent.send and physical proof.
    mutateStoredNoFocus(rejudgeRoot, ContextManager.FOCUS_CANARY_IDS[0], record => {
      // Model the crash point immediately after H2 proof and before H1 took
      // ownership: physically remove the later F07 transaction first, then
      // corrupt the original H2 decision for the normal cold rejudge path.
      const { transaction: _transaction, ...pureH2 } = record
      return {
        ...pureH2,
        closure: {
          ...pureH2.closure,
          decision: { ...pureH2.closure.decision, ref: 'tampered-no-focus-ref' },
        },
      }
    })
    const rejudgeRestart = await mount(rejudgeRoot, ContextManager.FOCUS_CANARY_IDS[0], new FocusCanaryAdapter(), true)
    const rejudgeErrors = canaryErrors(rejudgeRestart.ctx, rejudgeRestart.agent)
    await send(rejudgeRestart.agent, '继续')
    expect(rejudgeRestart.adapter.auxiliaryCalls).toBe(0)
    expect(rejudgeRestart.adapter.rootCalls).toBe(0)
    expect(rejudgeErrors.map(error => error instanceof Error ? error.message : String(error)))
      .toEqual(['唯一背景未能安全换入，本轮未继续行动'])

    const pendingWriteRoot = await mkdtemp(join(tmpdir(), 'focus-canary-pending-put-failure-'))
    temporaryRoots.push(pendingWriteRoot)
    let pendingWriteDomain: CapturedCanaryDomain | undefined
    const pendingWrite = await mount(
      pendingWriteRoot,
      ContextManager.FOCUS_CANARY_IDS[0],
      new FocusCanaryAdapter(),
      false,
      canaryConfig,
      domain => { pendingWriteDomain = domain },
    )
    await send(pendingWrite.agent, '帮我审这份方案')
    const oldFocus = readStoredFocus(pendingWriteRoot, ContextManager.FOCUS_CANARY_IDS[0])
    expect('focus' in oldFocus).toBe(false)
    if (pendingWriteDomain === undefined) throw new Error('expected canary domain')
    const pendingWriteTable = pendingWriteDomain.table('focus_precanonical')
    const pendingPut = pendingWriteTable.put.bind(pendingWriteTable)
    pendingWriteTable.put = async (key, value) => {
      if ('closure' in (value as object)) throw new Error('forced pending sidecar write failure')
      await pendingPut(key, value)
    }
    pendingWrite.adapter.auxiliaryOutput = '{"kind":"close","relation":"current"}'
    const pendingWriteErrors = canaryErrors(pendingWrite.ctx, pendingWrite.agent)
    const failedClose = await send(pendingWrite.agent, '这件事结束了')
    pendingWriteTable.put = pendingPut
    expect(readStoredFocus(pendingWriteRoot, ContextManager.FOCUS_CANARY_IDS[0])).toEqual(oldFocus)
    expect(directMessages(pendingWrite.agent).filter(event => String(event.data.id) === String(failedClose.id))).toHaveLength(1)
    expect(pendingWriteErrors.map(error => error instanceof Error ? error.message : String(error))).toEqual(['focus-canary'])
    expect(pendingWrite.adapter.auxiliaryCalls).toBe(2)
    expect(pendingWrite.adapter.rootCalls).toBe(1)
    await pendingWrite.ctx.sessions.flush(pendingWrite.agent.session)
    await pendingWrite.ctx.fiber.dispose()
    const pendingWriteRestart = await mount(
      pendingWriteRoot,
      ContextManager.FOCUS_CANARY_IDS[0],
      new FocusCanaryAdapter(),
      true,
    )
    expect(directMessages(pendingWriteRestart.agent)
      .filter(event => String(event.data.id) === String(failedClose.id))).toHaveLength(1)
    const pendingWriteRestartErrors = canaryErrors(pendingWriteRestart.ctx, pendingWriteRestart.agent)
    await send(pendingWriteRestart.agent, '继续')
    expect(readStoredFocus(pendingWriteRoot, ContextManager.FOCUS_CANARY_IDS[0])).toEqual(oldFocus)
    expect(pendingWriteRestart.adapter.auxiliaryCalls).toBe(0)
    expect(pendingWriteRestart.adapter.rootCalls).toBe(0)
    expect(pendingWriteRestartErrors.map(error => error instanceof Error ? error.message : String(error)))
      .toEqual(['focus-canary'])

    const pendingRoot = await mkdtemp(join(tmpdir(), 'focus-canary-pending-restart-'))
    temporaryRoots.push(pendingRoot)
    let pendingDomain: CapturedCanaryDomain | undefined
    const pending = await mount(
      pendingRoot,
      ContextManager.FOCUS_CANARY_IDS[0],
      new FocusCanaryAdapter(),
      false,
      canaryConfig,
      domain => { pendingDomain = domain },
    )
    await send(pending.agent, '帮我审这份方案')
    if (pendingDomain === undefined) throw new Error('expected canary domain')
    const pendingTable = pendingDomain.table('focus_precanonical')
    const put = pendingTable.put.bind(pendingTable)
    pendingTable.put = async (key, value) => {
      const record = value as { closure?: { phase?: string } }
      if (record.closure?.phase === 'physically_proved') throw new Error('forced sidecar proof commit failure')
      await put(key, value)
    }
    pending.adapter.auxiliaryOutput = '{"kind":"close","relation":"current"}'
    const pendingErrors = canaryErrors(pending.ctx, pending.agent)
    await send(pending.agent, '这件事结束了')
    pendingTable.put = put
    const pendingStored = readStoredFocus(pendingRoot, ContextManager.FOCUS_CANARY_IDS[0])
    expect('focus' in pendingStored).toBe(true)
    if (!('focus' in pendingStored)) throw new Error('expected pending closure')
    expect(pendingStored.closure.phase).toBe('pending')
    expect(pendingErrors.map(error => error instanceof Error ? error.message : String(error))).toEqual(['focus-canary'])
    expect(pending.adapter.auxiliaryCalls).toBe(2)
    expect(pending.adapter.rootCalls).toBe(1)
    await pending.ctx.sessions.flush(pending.agent.session)
    await pending.ctx.fiber.dispose()

    const pendingRestart = await mount(pendingRoot, ContextManager.FOCUS_CANARY_IDS[0], new FocusCanaryAdapter(), true)
    const pendingRestartErrors = canaryErrors(pendingRestart.ctx, pendingRestart.agent)
    await send(pendingRestart.agent, '继续')
    expect(pendingRestart.adapter.auxiliaryCalls).toBe(0)
    expect(pendingRestart.adapter.rootCalls).toBe(0)
    expect(pendingRestartErrors.map(error => error instanceof Error ? error.message : String(error)))
      .toEqual(['唯一背景未能安全换入，本轮未继续行动'])
    expect(visibleAssistantTexts(pendingRestart.agent)).toEqual(['继续处理：帮我审这份方案'])

    const closedRoot = await mkdtemp(join(tmpdir(), 'focus-canary-closed-domain-'))
    temporaryRoots.push(closedRoot)
    let captured: { close(): Promise<void> } | undefined
    const closed = await mount(
      closedRoot,
      ContextManager.FOCUS_CANARY_IDS[0],
      new FocusCanaryAdapter(),
      false,
      canaryConfig,
      domain => { captured = domain },
    )
    if (captured === undefined) throw new Error('expected publicly opened canary domain')
    await captured.close()
    const closedErrors = canaryErrors(closed.ctx, closed.agent)
    const closedInput = await send(closed.agent, '帮我审这份方案')
    const preserved = directMessages(closed.agent)
    expect(closed.adapter.auxiliaryCalls).toBe(0)
    expect(closed.adapter.rootCalls).toBe(0)
    expect(closedErrors).toHaveLength(1)
    expect(preserved).toHaveLength(1)
    expect(preserved.map(event => String(event.data.id))).toEqual([String(closedInput.id)])

    const batchRoot = await mkdtemp(join(tmpdir(), 'focus-canary-batch-shape-'))
    temporaryRoots.push(batchRoot)
    const batch = await mount(batchRoot, ContextManager.FOCUS_CANARY_IDS[0])
    const batchErrors = canaryErrors(batch.ctx, batch.agent)
    const batchDownstream = downstreamPreStepCount(batch.ctx, batch.agent)
    const batchTrace = claimedBatchTrace(batch.ctx, batch.agent)
    const firstDirect = createUserMessage({
      content: [{ type: 'text', text: '帮我审这份方案' }],
      source: { kind: 'user' },
    })
    const secondDirect = createUserMessage({
      content: [{ type: 'text', text: '帮我规划周末徒步' }],
      source: { kind: 'user' },
    })
    // Inbox.claim(next-turn) consumes every queued next-step message plus one
    // next-turn message. This makes both real Agent.send inputs one natural
    // pre-step batch rather than two separate turns.
    batch.agent.send(firstDirect, 'next-step', false)
    batch.agent.send(secondDirect, 'next-turn', true)
    await batch.agent.whenIdle()
    expect(batchTrace()).toEqual({
      claims: [
        { turn: 1, id: String(firstDirect.id) },
        { turn: 1, id: String(secondDirect.id) },
      ],
      batches: [{ turn: 1, step: 1, ids: [String(firstDirect.id), String(secondDirect.id)] }],
    })
    expect(batchDownstream()).toBe(0)
    expect(batch.adapter.auxiliaryCalls).toBe(0)
    expect(batch.adapter.rootCalls).toBe(0)
    expect(storedFocusCount(batchRoot)).toBe(0)
    expect(directMessages(batch.agent).map(event => String(event.data.id))).toEqual([
      String(firstDirect.id),
      String(secondDirect.id),
    ])
    expect(batchErrors).toHaveLength(1)

    const mixedRoot = await mkdtemp(join(tmpdir(), 'focus-canary-mixed-shape-'))
    temporaryRoots.push(mixedRoot)
    const mixed = await mount(mixedRoot, ContextManager.FOCUS_CANARY_IDS[0])
    const mixedErrors = canaryErrors(mixed.ctx, mixed.agent)
    const mixedDownstream = downstreamPreStepCount(mixed.ctx, mixed.agent)
    const mixedTrace = claimedBatchTrace(mixed.ctx, mixed.agent)
    const mixedDirect = createUserMessage({
      content: [{ type: 'text', text: '帮我审这份方案' }],
      source: { kind: 'user' },
    })
    const injectedPlugin = createUserMessage({
      content: [{ type: 'text', text: 'plugin context must not become a continuation' }],
      source: { kind: 'plugin', plugin: 'focused-test-context' },
    })
    mixed.agent.send(mixedDirect, 'next-step', false)
    mixed.agent.send(injectedPlugin, 'next-turn', true)
    await mixed.agent.whenIdle()
    expect(mixedTrace()).toEqual({
      claims: [
        { turn: 1, id: String(mixedDirect.id) },
        { turn: 1, id: String(injectedPlugin.id) },
      ],
      batches: [{ turn: 1, step: 1, ids: [String(mixedDirect.id), String(injectedPlugin.id)] }],
    })
    expect(mixedDownstream()).toBe(0)
    expect(mixed.adapter.auxiliaryCalls).toBe(0)
    expect(mixed.adapter.rootCalls).toBe(0)
    expect(storedFocusCount(mixedRoot)).toBe(0)
    expect(directMessages(mixed.agent).map(event => String(event.data.id))).toEqual([String(mixedDirect.id)])
    expect(mixedErrors).toHaveLength(1)

    const zeroRoot = await mkdtemp(join(tmpdir(), 'focus-canary-zero-direct-'))
    temporaryRoots.push(zeroRoot)
    const zero = await mount(zeroRoot, ContextManager.FOCUS_CANARY_IDS[0])
    const zeroErrors = canaryErrors(zero.ctx, zero.agent)
    const zeroDownstream = downstreamPreStepCount(zero.ctx, zero.agent)
    zero.agent.send(createUserMessage({
      content: [{ type: 'text', text: 'plugin-only context is not a canary input' }],
      source: { kind: 'plugin', plugin: 'focused-test-context' },
    }), 'next-turn', true)
    await zero.agent.whenIdle()
    expect(zeroDownstream()).toBe(0)
    expect(zero.adapter.auxiliaryCalls).toBe(0)
    expect(zero.adapter.rootCalls).toBe(0)
    expect(storedFocusCount(zeroRoot)).toBe(0)
    expect(directMessages(zero.agent)).toHaveLength(0)
    expect(zeroErrors).toHaveLength(1)
  })
})
