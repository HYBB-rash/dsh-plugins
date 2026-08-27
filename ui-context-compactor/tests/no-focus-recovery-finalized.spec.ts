import { afterEach, describe, expect, it } from 'vitest'
import { once } from 'node:events'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { CallId, createToolResultMessage, createUserMessage, freezeMessage, LlmAdapter, MessageId, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent, type SessionEventMap, type SessionEventType, type SurfaceEventType, type SurfaceIntent } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { CompactionId, compactCheckpointSource, isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import * as commandCompact from '@deepseek-ai/dsh-command-compact'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import * as ContextManager from '../src/index.ts'
import { ManagedAwareBasicCompactionEngine, type ManagedAwareBasicCompactionConfig, type ManagedCompactionRuntimeConfig } from '../src/managed-compaction.ts'

const roots: string[] = []
const contexts: Context[] = []
const children: ChildProcess[] = []
const sessionId = ContextManager.FOCUS_CANARY_IDS[0]
const closeText = '这件事结束了'
const closedText = '唯一背景未能安全换入，本轮未继续行动'
const noticeText = '当前事项已结束。请告诉我接下来要开始哪件事。'
const packageRoot = resolve(fileURLToPath(new URL('../', import.meta.url)))
const contextManagerUrl = new URL('../src/index.ts', import.meta.url).href
const moduleRequire = createRequire(import.meta.url)
const tsxImport = createRequire(moduleRequire.resolve('vitest')).resolve('tsx/esm')

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) {
      child.kill('SIGKILL')
      await once(child, 'exit')
    }
  }
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

class Adapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  rootCalls = 0
  auxiliaryCalls = 0
  auxiliaryOutput = '{"kind":"focus","subject":"untrusted","relation":"new"}'

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 8_192 } })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (options.messages.some(message => message.source.kind === 'plugin'
      && message.source.plugin === 'ui-context-compactor:focus-canary-schema')) {
      this.auxiliaryCalls += 1
      yield* chunks(this.auxiliaryOutput)
      return
    }
    this.rootCalls += 1
    if (options.messages.length === 2
      && options.messages[0]?.source.kind === 'context-manager-canonical'
      && options.messages[1]?.source.kind === 'user') {
      yield* chunks('当前事项已结束，请告诉我下一件事')
      return
    }
    yield* chunks('继续处理：未成立焦点')
  }
}

type CanaryConfig = Extract<NonNullable<ContextManager.Config['focusCanary']>, { readonly mode: 'enforce' }>
const config: CanaryConfig = {
  mode: 'enforce', safeUpdateMarginTokens: 64, allowlist: [...ContextManager.FOCUS_CANARY_IDS],
  auxiliary: { provider: 'recovery-test', model: 'recovery-test-model', maxOutputTokens: 64, timeoutMs: 500,
    maxExpressionChars: 240, maxProjectionTokens: 1_024, safetyMarginTokens: 128 },
}

interface DomainTable { put(key: string, value: unknown): Promise<void> }
interface Domain { table(name: string): DomainTable }
interface Harness { readonly ctx: Context; readonly agent: Agent; readonly adapter: Adapter; readonly domain: Domain }

async function mount(
  root: string,
  resume = false,
  beforeAgent?: (ctx: Context, domain: Domain) => void | Promise<void>,
): Promise<Harness> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await mkdir(join(root, 'storages'), { recursive: true })
  await ctx.plugin(Storage)
  await ctx.plugin(StorageSqlite, { path: join(root, 'storages', 'context-manager-focus-canary.sqlite') })
  await ctx.plugin(StorageDomain, { backend: 'sqlite' })
  await ctx.plugin(TokenMeter)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
  await ctx.plugin(CommandRuntime)
  const managedRuntime: ManagedCompactionRuntimeConfig = {
    mode: 'enforce', safeUpdateMarginTokens: 64, allowlist: config.allowlist,
  }
  const compaction: ManagedAwareBasicCompactionConfig = {
    auto: true, thresholdRatio: 0.99, retainRatio: 0.1, managedRuntime,
  }
  await ctx.plugin(ManagedAwareBasicCompactionEngine, compaction)
  await ctx.plugin(commandCompact)
  const adapter = new Adapter()
  ctx.llm.registerAdapter(['recovery-test'], adapter)
  let domain: Domain | undefined
  const facility = ctx.get('storageDomain') as unknown as { open(spec: unknown): Promise<Domain> }
  const open = facility.open.bind(facility)
  facility.open = async spec => {
    const opened = await open(spec)
    domain = opened
    return opened
  }
  await ctx.plugin(ContextManager, { focusCanary: config, nativeWriterArbitration: { mode: 'enforce' } })
  await ctx.plugin(AgentLoop, { agents: [] })
  if (domain === undefined) throw new Error('expected public focus canary domain')
  await beforeAgent?.(ctx, domain)
  const agent = resume
    ? (await ctx.agents.resume({ resumeSessionId: SessionId(sessionId), agentOptions: { provider: 'recovery-test', model: 'recovery-test-model' } })).agent
    : ctx.agentLoop.create(SessionId(sessionId), { provider: 'recovery-test', model: 'recovery-test-model' })
  return { ctx, agent, adapter, domain }
}

async function send(agent: Agent, text: string): Promise<UserMessage> {
  const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
  agent.send(message, 'next-turn', true)
  await agent.whenIdle()
  return message
}

function errors(ctx: Context, agent: Agent): unknown[] {
  const found: unknown[] = []
  ctx.on('agent/error', ({ agent: subject, error }) => { if (subject === agent) found.push(error) })
  return found
}

function directEvents(agent: Agent, id?: UserMessage['id']): Array<Extract<SessionEvent, { type: 'user/message' }>> {
  return agent.session.events.filter((event): event is Extract<SessionEvent, { type: 'user/message' }> =>
    event.type === 'user/message' && event.data.source.kind === 'user'
      && (id === undefined || String(event.data.id) === String(id)))
}

function canonicalEvents(agent: Agent): SessionEvent<'user/message'>[] {
  return agent.session.events.filter((event): event is SessionEvent<'user/message'> =>
    event.type === 'user/message' && event.data.source.kind === 'context-manager-canonical',
  )
}

function readRecord(root: string): Record<string, unknown> {
  const database = new DatabaseSync(join(root, 'storages', 'context-manager-focus-canary.sqlite'), { readOnly: true })
  try {
    const row = database.prepare('SELECT value FROM "u_context_manager_focus_precanonical" WHERE key = ?')
      .get(sessionId) as { value: string } | undefined
    if (row === undefined) throw new Error('missing focus canary row')
    return JSON.parse(row.value) as Record<string, unknown>
  } finally { database.close() }
}

function mutateRecord(root: string, mutate: (record: Record<string, unknown>) => Record<string, unknown>): void {
  const database = new DatabaseSync(join(root, 'storages', 'context-manager-focus-canary.sqlite'))
  try {
    database.prepare('UPDATE "u_context_manager_focus_precanonical" SET value = ? WHERE key = ?')
      .run(JSON.stringify(mutate(readRecord(root))), sessionId)
  } finally { database.close() }
}

async function establishTail(root: string): Promise<void> {
  const live = await mount(root)
  await send(live.agent, '帮我审这份方案')
  live.adapter.auxiliaryOutput = '{"kind":"close","relation":"current"}'
  await send(live.agent, closeText)
  await live.ctx.sessions.flush(live.agent.session)
  await live.ctx.fiber.dispose()
  contexts.splice(contexts.indexOf(live.ctx), 1)
}

function tailCoordinates(agent: Agent): { readonly turn: number; readonly step: number } {
  const start = agent.session.events.findLast((event): event is SessionEvent<'step/start'> => event.type === 'step/start')
  if (start === undefined) throw new Error('expected natural finalized tail step')
  return start.data
}

function tailNotice(agent: Agent): SessionEvent<'user/message'> {
  const event = agent.session.events.findLast((candidate): candidate is SessionEvent<'user/message'> =>
    candidate.type === 'user/message'
      && candidate.data.source.kind === 'plugin'
      && candidate.data.source.plugin === 'ui-context-compactor:no-focus',
  )
  if (event === undefined) throw new Error('expected natural finalized tail notice')
  return event
}

function replaceTailNotice(
  agent: Agent,
  source: { readonly kind: 'plugin'; readonly plugin: string; readonly form: 'notice'; readonly summary: string },
  text = noticeText,
): void {
  const notice = tailNotice(agent)
  agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source }), {
    surfaceOp: { op: 'replace', start: notice.seq, end: notice.seq }, sourceEventSeqs: [notice.seq],
  })
}

interface TailViolation {
  readonly name: string
  readonly inject: (agent: Agent) => Promise<void> | void
}

const tailViolations: readonly TailViolation[] = [
  { name: 'extra-direct', inject: async agent => { await send(agent, '额外的 direct 尾巴') } },
  { name: 'tool-call', inject: agent => {
    const { turn, step } = tailCoordinates(agent)
    agent.session.append('tool/call', { turn, step, callId: CallId('tail-tool-call'), name: 'tail', arguments: '{}' })
  } },
  { name: 'tool-result', inject: agent => {
    const { turn, step } = tailCoordinates(agent)
    const callId = CallId('tail-tool-result')
    agent.session.append('tool/result', {
      turn, step, message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'tail result' }], isError: false }),
    }, { surfaceOp: 'append' })
  } },
  { name: 'compact-checkpoint', inject: agent => {
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'native compact checkpoint' }], source: compactCheckpointSource(CompactionId('tail-checkpoint')),
    }), { surfaceOp: 'append' })
  } },
  { name: 'context-route-plugin-message', inject: agent => {
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'context route evidence' }], source: { kind: 'plugin', plugin: 'context-route' },
    }), { surfaceOp: 'append' })
  } },
  { name: 'compaction-lifecycle', inject: agent => {
    const compactionId = CompactionId('tail-compaction')
    agent.session.append('compaction/start', { compactionId, turn: null })
    agent.session.append('compaction/end', { compactionId, turn: null })
  } },
  { name: 'wrong-turn', inject: agent => {
    const { turn, step } = tailCoordinates(agent)
    agent.session.append('tool/call', { turn: turn + 1, step, callId: CallId('tail-wrong-turn'), name: 'tail', arguments: '{}' })
  } },
  { name: 'wrong-step', inject: agent => {
    const { turn, step } = tailCoordinates(agent)
    const callId = CallId('tail-wrong-step')
    agent.session.append('tool/result', {
      turn, step: step + 1, message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'wrong step' }], isError: false }),
    }, { surfaceOp: 'append' })
  } },
  { name: 'extra-lifecycle', inject: agent => {
    const { turn } = tailCoordinates(agent)
    agent.session.append('turn/start', { turn: turn + 1 })
  } },
  { name: 'extra-chunk', inject: agent => {
    const { turn, step } = tailCoordinates(agent)
    agent.session.append('assistant/chunk', { turn, step, chunk: chunks('tail chunk')[0]! })
  } },
  { name: 'wrong-chunk', inject: agent => {
    const { turn, step } = tailCoordinates(agent)
    agent.session.append('assistant/chunk', { turn: turn + 1, step, chunk: chunks('wrong chunk')[0]! })
  } },
  { name: 'multiple-end-seed', inject: agent => {
    agent.session.append('session/end-seed', {})
    agent.session.append('session/end-seed', {})
  } },
  { name: 'wrong-position-end-seed', inject: agent => {
    const { turn, step } = tailCoordinates(agent)
    agent.session.append('session/end-seed', {})
    agent.session.append('tool/call', { turn, step, callId: CallId('tail-after-seed'), name: 'tail', arguments: '{}' })
  } },
  { name: 'tampered-notice-body', inject: agent => {
    replaceTailNotice(agent, { kind: 'plugin', plugin: 'ui-context-compactor:no-focus', form: 'notice', summary: 'no-focus closure receipt' }, 'tampered notice')
  } },
  { name: 'tampered-notice-summary', inject: agent => {
    replaceTailNotice(agent, { kind: 'plugin', plugin: 'ui-context-compactor:no-focus', form: 'notice', summary: 'tampered summary' })
  } },
  { name: 'tampered-notice-source', inject: agent => {
    replaceTailNotice(agent, { kind: 'plugin', plugin: 'ui-context-compactor:no-focus-tampered', form: 'notice', summary: 'no-focus closure receipt' })
  } },
]

interface RepairState {
  readonly phase: 'repair_pending' | 'repair_finalized'
  readonly targetMessageId: string
  readonly targetReplaceSeq?: number
  readonly generation: number
}

function objectField(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`expected ${label} record`)
  return Object.fromEntries(Object.entries(value))
}

function repairState(root: string): RepairState {
  const record = readRecord(root)
  const transaction = objectField(record.transaction, 'transaction')
  const repair = objectField(transaction.repair, 'repair')
  const phase = repair.phase
  const targetMessageId = repair.targetMessageId
  const generation = transaction.generation
  if ((phase !== 'repair_pending' && phase !== 'repair_finalized')
    || typeof targetMessageId !== 'string' || targetMessageId.length === 0
    || typeof generation !== 'number') throw new Error('expected durable repair state')
  const targetReplaceSeq = repair.targetReplaceSeq
  if (phase === 'repair_finalized') {
    if (typeof targetReplaceSeq !== 'number' || !Number.isSafeInteger(targetReplaceSeq)) {
      throw new Error('expected finalized repair replacement sequence')
    }
    return { phase, targetMessageId, targetReplaceSeq, generation }
  }
  return { phase, targetMessageId, generation }
}

function eventIds(agent: Agent): string[] {
  return agent.session.events.filter((event): event is SessionEvent<'user/message'> => event.type === 'user/message')
    .map(event => String(event.data.id))
}

function canonicalTargetEvents(agent: Agent, id: string): SessionEvent<'user/message'>[] {
  return agent.session.events.filter((event): event is SessionEvent<'user/message'> => event.type === 'user/message'
    && event.data.source.kind === 'context-manager-canonical' && String(event.data.id) === id)
}

function assertUniqueRepairLog(agent: Agent, allowedDuplicateMessageId?: string): void {
  const seqs = agent.session.events.map(event => event.seq)
  expect(new Set(seqs).size).toBe(seqs.length)
  const ids = agent.session.events.flatMap(event => event.type === 'user/message' ? [String(event.data.id)]
    : event.type === 'assistant/message' ? [String(event.data.message.id)] : [])
  const duplicates = [...new Set(ids.filter(id => ids.filter(candidate => candidate === id).length > 1))]
  expect(duplicates).toEqual(allowedDuplicateMessageId === undefined ? [] : [allowedDuplicateMessageId])
}

interface RecoveryTrace {
  readonly entries: string[]
  readonly restore: () => void
}

function traceRecoveryPorts(ctx: Context): RecoveryTrace {
  const entries: string[] = []
  const sessions = ctx.sessions as unknown as { flush(session: Agent['session']): Promise<boolean> }
  const flush = sessions.flush.bind(sessions)
  sessions.flush = async session => {
    const completed = await flush(session)
    entries.push(`flush:${String(completed)}`)
    return completed
  }
  const persistence = ctx.sessionPersistence
  const readFrom = persistence.readFrom.bind(persistence)
  persistence.readFrom = async (id, fromSeq) => {
    const read = await readFrom(id, fromSeq)
    entries.push(`read:${String(fromSeq)}`)
    return read
  }
  return { entries, restore: () => { sessions.flush = flush; persistence.readFrom = readFrom } }
}

function repairGeneration(root: string): number {
  const transaction = objectField(readRecord(root).transaction, 'transaction')
  if (typeof transaction.generation !== 'number') throw new Error('expected canonical generation')
  return transaction.generation
}

function repairWorkCounts(agent: Agent): { readonly root: number; readonly auxiliary: number; readonly tools: number; readonly checkpoints: number; readonly compaction: number; readonly routes: number } {
  return {
    root: 0,
    auxiliary: 0,
    tools: agent.session.events.filter(event => event.type.startsWith('tool/')).length,
    checkpoints: agent.session.events.filter(event => event.type === 'user/message' && isCompactCheckpointSource(event.data.source)).length,
    compaction: agent.session.events.filter(event => event.type.startsWith('compaction/')).length,
    routes: agent.session.events.filter(event => event.type === 'user/message'
      && event.data.source.kind === 'plugin' && event.data.source.plugin === 'context-route').length,
  }
}

async function assertClosedRepairContinuation(
  h: Harness,
  trace: RecoveryTrace,
  seen: readonly unknown[],
  baseline: { readonly root: number; readonly auxiliary: number; readonly tools: number; readonly checkpoints: number; readonly compaction: number; readonly routes: number },
): Promise<UserMessage> {
  const continued = await send(h.agent, '继续')
  const direct = directEvents(h.agent, continued.id)
  expect(direct).toHaveLength(1)
  const live = direct[0]
  if (live === undefined) throw new Error('expected exact live continuation')
  expect(live.data.source.kind).toBe('user')
  expect(live.data.content).toEqual([{ type: 'text', text: '继续' }])
  const expectedHash = createHash('sha256').update(String(continued.id)).update('\0').update('继续').digest('hex')
  expect(createHash('sha256').update(String(live.data.id)).update('\0').update('继续').digest('hex')).toBe(expectedHash)
  const detached = await h.ctx.sessionPersistence.readFrom(SessionId(sessionId), 0)
  const persisted = detached.events.filter((event): event is SessionEvent<'user/message'> => event.type === 'user/message'
    && String(event.data.id) === String(continued.id))
  expect(persisted).toHaveLength(1)
  const saved = persisted[0]
  if (saved === undefined) throw new Error('expected exact detached continuation')
  expect(saved.data.source.kind).toBe('user')
  expect(saved.data.content).toEqual([{ type: 'text', text: '继续' }])
  expect(createHash('sha256').update(String(saved.data.id)).update('\0').update('继续').digest('hex')).toBe(expectedHash)
  expect(h.adapter.rootCalls).toBe(baseline.root)
  expect(h.adapter.auxiliaryCalls).toBe(baseline.auxiliary)
  const after = repairWorkCounts(h.agent)
  expect(after.tools).toBe(baseline.tools)
  expect(after.checkpoints).toBe(baseline.checkpoints)
  expect(after.compaction).toBe(baseline.compaction)
  expect(after.routes).toBe(baseline.routes)
  expect(seen.map(error => error instanceof Error ? error.message : String(error))).toEqual([closedText])
  const flush = trace.entries.lastIndexOf('flush:true')
  const read = trace.entries.findIndex((entry, index) => index > flush && entry.startsWith('read:'))
  const error = trace.entries.indexOf('error')
  expect(flush).toBeGreaterThanOrEqual(0)
  expect(read).toBeGreaterThan(flush)
  expect(error).toBeGreaterThan(read)
  return continued
}

type CorruptReadback = 'wrong-seq' | 'wrong-id' | 'wrong-source' | 'wrong-text' | 'wrong-body-hash'

function corruptOneRepairRead(ctx: Context, variant: CorruptReadback): void {
  const persistence = ctx.sessionPersistence
  const readFrom = persistence.readFrom.bind(persistence)
  let consumed = false
  persistence.readFrom = async (id, fromSeq) => {
    const read = await readFrom(id, fromSeq)
    if (consumed || fromSeq === 0) return read
    consumed = true
    const events = read.events.map(event => {
      if (event.seq !== fromSeq || event.type !== 'user/message') return event
      if (variant === 'wrong-seq') return { ...event, seq: event.seq + 10_000 } as SessionEvent
      if (variant === 'wrong-id') return { ...event, data: { ...event.data, id: MessageId('wrong-repair-target') } } as SessionEvent
      if (variant === 'wrong-source') return { ...event, data: { ...event.data, source: { kind: 'plugin', plugin: 'wrong-repair-source' } } } as SessionEvent
      if (variant === 'wrong-text') return { ...event, data: { ...event.data, content: [{ type: 'text', text: 'wrong repair text' }] } } as SessionEvent
      return { ...event, data: { ...event.data, content: [{ type: 'text', text: 'wrong repair body' }], source: { ...event.data.source, bodyHash: '0'.repeat(64) } } } as SessionEvent
    })
    return { ...read, events }
  }
}

function throwOneRepairRead(ctx: Context): void {
  const persistence = ctx.sessionPersistence
  const readFrom = persistence.readFrom.bind(persistence)
  let consumed = false
  persistence.readFrom = async (id, fromSeq) => {
    if (!consumed && fromSeq !== 0) {
      consumed = true
      throw new Error('read fault')
    }
    return await readFrom(id, fromSeq)
  }
}

function failOneRepairFlush(ctx: Context): void {
  const sessions = ctx.sessions as unknown as { flush(session: Agent['session']): Promise<boolean> }
  const flush = sessions.flush.bind(sessions)
  let consumed = false
  sessions.flush = async session => {
    if (!consumed) {
      consumed = true
      return false
    }
    return await flush(session)
  }
}

type TargetInjection = 'duplicate-target' | 'mismatched-target'

function appendPublicMalformedRepairTarget(agent: Agent, targetMessageId: string, variant: TargetInjection): void {
  const original = agent.session.events.find((event): event is SessionEvent<'user/message'> => event.type === 'user/message'
    && event.data.source.kind === 'context-manager-canonical')
  if (original === undefined) throw new Error('missing public finalized canonical for target injection')
  const exact = freezeMessage({ ...original.data, id: MessageId(targetMessageId) }) as UserMessage
  if (variant === 'duplicate-target') {
    agent.session.append('user/message', exact, { surfaceOp: 'append' })
    const nodes = [...agent.session.surface.nodes]
    if (nodes.length === 0) throw new Error('missing public surface for duplicate target replacement')
    agent.session.append('user/message', exact, {
        surfaceOp: { op: 'replace', start: nodes[0]!, end: nodes.at(-1)! }, sourceEventSeqs: nodes,
    })
    return
  }
  if (exact.source.kind !== 'context-manager-canonical') throw new Error('expected canonical public target')
  const mismatched = freezeMessage({
    ...exact, content: [{ type: 'text', text: 'wrong public target body' }],
    source: { ...exact.source, bodyHash: '0'.repeat(64), machine: { ...exact.source.machine, closeHash: '0'.repeat(64) } },
  })
  agent.session.append('user/message', mismatched, { surfaceOp: 'append' })
}

function finalizedChildProgram(): string {
  return `
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
const root = process.env.RECOVERY_CHILD_ROOT
if (typeof root !== 'string') throw new Error('missing recovery child root')
const contextManagerUrl = process.env.RECOVERY_CHILD_CONTEXT_MANAGER_URL
const packageCwd = process.env.RECOVERY_CHILD_PACKAGE_CWD
if (typeof contextManagerUrl !== 'string' || typeof packageCwd !== 'string') throw new Error('missing recovery child module location')
if (process.cwd() !== packageCwd) throw new Error('recovery child cwd drifted')
const ContextManager = await import(contextManagerUrl)
const chunks = text => [{ type:'block-start', index:0, blockType:'text' }, { type:'block-end', index:0, block:{ type:'text', text } }, { type:'finish', reason:{ kind:'stop' } }]
class Adapter extends LlmAdapter {
  calls = 0
  async resolveModel(provider, model) { return { provider, id:model, name:model, context:{ contextWindow:8192 } } }
  async *stream(options) { if (options.messages.some(message => message.source.kind === 'plugin' && message.source.plugin === 'ui-context-compactor:focus-canary-schema')) { this.calls += 1; yield* chunks(this.calls === 1 ? '{"kind":"focus","subject":"child A","relation":"new"}' : '{"kind":"close","relation":"current"}'); return } yield* chunks('child root receipt') }
}
const ctx = new Context()
await mountAgentLoopTestDependencies(ctx)
await (await import('node:fs/promises')).mkdir(root + '/storages', { recursive:true })
await ctx.plugin(Storage); await ctx.plugin(StorageSqlite, { path:root + '/storages/context-manager-focus-canary.sqlite' }); await ctx.plugin(StorageDomain,{backend:'sqlite'}); await ctx.plugin(TokenMeter); await ctx.plugin(JsonlSessionPersistence,{root:root + '/sessions',compression:'none'})
ctx.llm.registerAdapter(['recovery-test'], new Adapter())
let domain
const facility = ctx.get('storageDomain'); const open = facility.open.bind(facility); facility.open = async spec => { domain = await open(spec); return domain }
await ctx.plugin(ContextManager,{focusCanary:{mode:'enforce',safeUpdateMarginTokens:64,allowlist:[...ContextManager.FOCUS_CANARY_IDS],auxiliary:{provider:'recovery-test',model:'recovery-test-model',maxOutputTokens:64,timeoutMs:500,maxExpressionChars:240,maxProjectionTokens:1024,safetyMarginTokens:128}}})
await ctx.plugin(AgentLoop,{agents:[]})
const table = domain.table('focus_precanonical'); const put = table.put.bind(table); table.put = async (key,value) => { await put(key,value); if (value?.transaction?.phase === 'finalized') { process.send?.({kind:'finalized'}); await new Promise(() => {}) } }
const agent = ctx.agentLoop.create(SessionId(ContextManager.FOCUS_CANARY_IDS[0]),{provider:'recovery-test',model:'recovery-test-model'})
const send = async text => { const message=createUserMessage({content:[{type:'text',text}],source:{kind:'user'}}); agent.send(message,'next-turn',true); await agent.whenIdle() }
await send('帮我审这份方案'); await send('这件事结束了')
`
}

async function crashAfterFinalizedPut(root: string): Promise<void> {
  const child = spawn(process.execPath, [
    '--import', tsxImport,
    '--eval', finalizedChildProgram(),
  ], {
    cwd: packageRoot,
    env: { ...process.env, RECOVERY_CHILD_ROOT: root, RECOVERY_CHILD_CONTEXT_MANAGER_URL: contextManagerUrl, RECOVERY_CHILD_PACKAGE_CWD: packageRoot },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  children.push(child)
  await new Promise<void>((resolve, reject) => {
    let stderr = ''
    child.stderr?.on('data', chunk => { stderr += String(chunk) })
    const timer = setTimeout(() => reject(new Error('child did not report durable finalized put')), 5_000)
    child.once('message', message => {
      clearTimeout(timer)
      if (message !== null && typeof message === 'object' && 'kind' in message && message.kind === 'finalized') resolve()
      else reject(new Error('unexpected child checkpoint'))
    })
    child.once('exit', code => {
      clearTimeout(timer)
      reject(new Error(`recovery child exited before checkpoint (${String(code)}): ${stderr}`))
    })
    child.once('error', reject)
  })
  child.kill('SIGKILL')
  await once(child, 'exit')
  children.splice(children.indexOf(child), 1)
}

describe('F07-H1R-F finalized cold recovery: 1 positive chain and 5 adversarial stimuli', () => {
  it('positive: SIGKILL recovery reaches ready once, remains cold-idempotent, then accepts one direct continuation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'no-focus-clean-crash-'))
    roots.push(root)
    await crashAfterFinalizedPut(root)
    const first = await mount(root, true)
    await first.agent.whenIdle()
    const readyRecord = readRecord(root)
    const readyCanonical = canonicalEvents(first.agent).map(event => ({ id: String(event.data.id), seq: event.seq }))
    expect(first.adapter.rootCalls).toBe(0)
    expect(first.adapter.auxiliaryCalls).toBe(0)
    await first.ctx.sessions.flush(first.agent.session)
    await first.ctx.fiber.dispose(); contexts.splice(contexts.indexOf(first.ctx), 1)

    const resumed = await mount(root, true)
    await resumed.agent.whenIdle()
    expect(readRecord(root)).toEqual(readyRecord)
    expect(canonicalEvents(resumed.agent).map(event => ({ id: String(event.data.id), seq: event.seq }))).toEqual(readyCanonical)
    expect(resumed.adapter.rootCalls).toBe(0)
    expect(resumed.adapter.auxiliaryCalls).toBe(0)
    const readyWork = repairWorkCounts(resumed.agent)
    expect(readyWork.tools).toBe(0)
    expect(readyWork.checkpoints).toBe(0)
    expect(readyWork.compaction).toBe(0)
    expect(readyWork.routes).toBe(0)
    const continued = await send(resumed.agent, '继续')
    expect(resumed.adapter.rootCalls).toBe(1)
    expect(resumed.adapter.auxiliaryCalls).toBe(0)
    const request = resumed.adapter.requests.at(-1)
    if (request === undefined) throw new Error('expected final root request')
    expect(request?.messages).toHaveLength(2)
    const requestedCanonical = request?.messages[0]
    const requestedDirect = request?.messages[1]
    if (requestedCanonical === undefined || requestedDirect === undefined) throw new Error('expected canonical plus direct request')
    const finalized = canonicalEvents(resumed.agent).filter(event => event.data.source.kind === 'context-manager-canonical'
      && event.data.source.phase === 'finalized'
      && String(event.data.id) === String(requestedCanonical.id))
    expect(finalized).toHaveLength(1)
    expect(requestedCanonical).toEqual(finalized[0]?.data)
    expect(requestedDirect.id).toBe(continued.id)
    expect(requestedDirect.source.kind).toBe('user')
    expect(requestedDirect.content).toEqual([{ type: 'text', text: '继续' }])
    const requestedTexts = request.messages.flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []))
    expect(request.messages.some(message => message.source.kind === 'plugin')).toBe(false)
    expect(requestedTexts).not.toContain('child A')
    expect(requestedTexts).not.toContain(closeText)
    expect(requestedTexts).not.toContain(noticeText)
    expect(directEvents(resumed.agent, continued.id)).toHaveLength(1)
    expect(resumed.agent.session.deriveMessages()).toHaveLength(3)
    expect(repairWorkCounts(resumed.agent)).toEqual(readyWork)
  })

  it('negative: expected-missing closes with physical direct proof; malformed sidecars veto mount without mutation', async () => {
    const variants = ['missing', 'chat', 'ref', 'material', 'body', 'hash', 'seq', 'id'] as const
    for (const variant of variants) {
      const root = await mkdtemp(join(tmpdir(), `no-focus-corrupt-${variant}-`)); roots.push(root)
      await establishTail(root)
      const before = readRecord(root)
      const close = before.closure as { original: { messageId: string } }
      if (variant === 'missing') {
        mutateRecord(root, record => ({ ...record, transaction: undefined }))
      } else {
        mutateRecord(root, record => {
          const transaction = record.transaction as Record<string, unknown>
          const machine = transaction.machine as Record<string, unknown>
          const material = transaction.material as Record<string, unknown>
          if (variant === 'chat') return { ...record, transaction: { ...transaction, machine: { ...machine, chat: 'other-chat' } } }
          if (variant === 'ref') return { ...record, transaction: { ...transaction, machine: { ...machine, focusRef: 'no-focus:wrong' } } }
          if (variant === 'material') return { ...record, transaction: { ...transaction, material: { ...material, ref: 'material:wrong' } } }
          if (variant === 'body') return { ...record, transaction: { ...transaction, body: 'wrong canonical body' } }
          if (variant === 'hash') return { ...record, transaction: { ...transaction, bodyHash: '0'.repeat(64) } }
          if (variant === 'seq') return { ...record, transaction: { ...transaction, finalizedReplaceSeq: -1 } }
          return { ...record, closure: { ...(record.closure as Record<string, unknown>), original: { ...((record.closure as Record<string, unknown>).original as Record<string, unknown>), messageId: 'wrong-id' } } }
        })
      }
      if (variant !== 'missing') {
        const corruptedBytes = createHash('sha256').update(JSON.stringify(readRecord(root))).digest('hex')
        await expect(mount(root, true)).rejects.toThrow('does not match its schema')
        expect(createHash('sha256').update(JSON.stringify(readRecord(root))).digest('hex')).toBe(corruptedBytes)
        continue
      }
      let trace: RecoveryTrace | undefined
      const h = await mount(root, true, ctx => {
        trace = traceRecoveryPorts(ctx)
        ctx.on('agent/error', () => { trace?.entries.push('error') })
      })
      if (trace === undefined) throw new Error('missing expected-missing trace')
      await h.agent.whenIdle()
      const baseline = { ...repairWorkCounts(h.agent), root: h.adapter.rootCalls, auxiliary: h.adapter.auxiliaryCalls }
      const seen = errors(h.ctx, h.agent)
      await assertClosedRepairContinuation(h, trace, seen, baseline)
      expect(directEvents(h.agent).filter(event => String(event.data.id) === close.original.messageId)).toHaveLength(1)
      trace.restore()
    }
  })

  it('negative: normal-tail whitelist violations do no repair, provider, tool, native, or compaction work', async () => {
    for (const violation of tailViolations) {
      const root = await mkdtemp(join(tmpdir(), `no-focus-tail-violation-${violation.name}-`)); roots.push(root)
      const live = await mount(root)
      await send(live.agent, '帮我审这份方案')
      live.adapter.auxiliaryOutput = '{"kind":"close","relation":"current"}'
      await send(live.agent, closeText)
      await violation.inject(live.agent)
      await live.ctx.sessions.flush(live.agent.session)
      await live.ctx.fiber.dispose()
      contexts.splice(contexts.indexOf(live.ctx), 1)

      const timeline: string[] = []
      const h = await mount(root, true, ctx => {
        const flush = ctx.sessions.flush.bind(ctx.sessions)
        ctx.sessions.flush = async session => {
          const flushed = await flush(session)
          timeline.push(`flush:${String(flushed)}`)
          return flushed
        }
        const readFrom = ctx.sessionPersistence.readFrom.bind(ctx.sessionPersistence)
        ctx.sessionPersistence.readFrom = async (...args) => {
          const read = await readFrom(...args)
          timeline.push('read')
          return read
        }
        ctx.on('agent/error', () => { timeline.push('error') })
      })
      await h.agent.whenIdle()
      const recoveryBaseline = {
        events: h.agent.session.events.length,
        rootCalls: h.adapter.rootCalls,
        auxiliaryCalls: h.adapter.auxiliaryCalls,
        canonicalEvents: canonicalEvents(h.agent).length,
        repair: (readRecord(root).transaction as { repair?: unknown }).repair,
      }
      const seen = errors(h.ctx, h.agent)
      const continued = await send(h.agent, '继续')
      const close = readRecord(root).closure as { original: { messageId: string } }

      expect(h.agent.session.events.length).toBeGreaterThan(recoveryBaseline.events)
      expect(h.adapter.rootCalls).toBe(recoveryBaseline.rootCalls)
      expect(h.adapter.auxiliaryCalls).toBe(recoveryBaseline.auxiliaryCalls)
      expect(canonicalEvents(h.agent)).toHaveLength(recoveryBaseline.canonicalEvents)
      expect((readRecord(root).transaction as { repair?: unknown }).repair).toBe(recoveryBaseline.repair)
      expect(seen.map(error => error instanceof Error ? error.message : String(error))).toEqual([closedText])
      expect(timeline.indexOf('flush:true')).toBeGreaterThanOrEqual(0)
      expect(timeline.indexOf('read')).toBeGreaterThan(timeline.indexOf('flush:true'))
      expect(timeline.indexOf('error')).toBeGreaterThan(timeline.indexOf('read'))
      expect(directEvents(h.agent, continued.id)).toHaveLength(1)
      const detached = await h.ctx.sessionPersistence.readFrom(SessionId(sessionId), 0)
      const persisted = detached.events.filter((event): event is SessionEvent<'user/message'> =>
        event.type === 'user/message' && String(event.data.id) === String(continued.id),
      )
      expect(persisted).toHaveLength(1)
      const direct = persisted[0]
      const liveDirect = directEvents(h.agent, continued.id)[0]
      if (direct === undefined || liveDirect === undefined) throw new Error('expected exact live and detached continuation')
      expect(direct.data.source.kind).toBe('user')
      expect(direct.data.content).toEqual([{ type: 'text', text: '继续' }])
      const liveHash = createHash('sha256').update(String(liveDirect.data.id)).update('\0').update('继续').digest('hex')
      const detachedHash = createHash('sha256').update(String(direct.data.id)).update('\0').update('继续').digest('hex')
      expect(detachedHash).toBe(liveHash)
      expect(directEvents(h.agent).filter(event => String(event.data.id) === close.original.messageId)).toHaveLength(1)
      expect((readRecord(root).transaction as { repair?: unknown }).repair).toBeUndefined()
    }
  })

  it('negative: repair pending and publication fault windows close without a second target id or generation', async () => {
    const variants = ['pending-put', 'replace', 'flush', 'read', 'finalized-put',
      'wrong-seq', 'wrong-id', 'wrong-source', 'wrong-text', 'wrong-body-hash'] as const
    for (const variant of variants) {
      const root = await mkdtemp(join(tmpdir(), `no-focus-repair-fault-${variant}-`)); roots.push(root); await establishTail(root)
      const generation = repairGeneration(root)
      let trace: RecoveryTrace | undefined
      const h = await mount(root, true, async (ctx, domain) => {
        trace = traceRecoveryPorts(ctx)
        ctx.on('agent/error', () => { trace?.entries.push('error') })
        if (variant === 'pending-put') { const table = domain.table('focus_precanonical'); const put = table.put.bind(table); table.put = async (key, value) => { if ((value as { transaction?: { repair?: { phase?: string } } }).transaction?.repair?.phase === 'repair_pending') throw new Error('pending put'); await put(key, value) } }
        if (variant === 'flush') failOneRepairFlush(ctx)
        if (variant === 'read') throwOneRepairRead(ctx)
        if (variant === 'wrong-seq' || variant === 'wrong-id' || variant === 'wrong-source' || variant === 'wrong-text' || variant === 'wrong-body-hash') corruptOneRepairRead(ctx, variant)
        if (variant === 'finalized-put') { const table = domain.table('focus_precanonical'); const put = table.put.bind(table); table.put = async (key, value) => { if ((value as { transaction?: { repair?: { phase?: string } } }).transaction?.repair?.phase === 'repair_finalized') throw new Error('finalized put'); await put(key, value) } }
        if (variant === 'replace') ctx.on('agent/created', ({ agent }) => {
          const append = agent.session.append
          agent.session.append = function appendWithFailure<T extends SessionEventType>(
            type: T,
            data: SessionEventMap[T],
            ...options: T extends SurfaceEventType ? [SurfaceIntent] : []
          ): SessionEvent<T> {
            const surface = options[0]?.surfaceOp
            if (typeof surface === 'object' && surface !== null && 'op' in surface && surface.op === 'replace') {
              throw new Error('replace fault')
            }
            return Reflect.apply(append, this, [type, data, ...options])
          }
        }, { prepend: true })
      })
      if (trace === undefined) throw new Error('missing repair trace')
      await h.agent.whenIdle()
      const baseline = { ...repairWorkCounts(h.agent), root: h.adapter.rootCalls, auxiliary: h.adapter.auxiliaryCalls }
      const seen = errors(h.ctx, h.agent)
      await assertClosedRepairContinuation(h, trace, seen, baseline)
      const close = readRecord(root).closure as { original: { messageId: string } }
      expect(directEvents(h.agent).filter(event => String(event.data.id) === close.original.messageId)).toHaveLength(1)
      expect(repairGeneration(root)).toBe(generation)
      if (variant === 'pending-put') {
        expect((readRecord(root).transaction as { repair?: unknown }).repair).toBeUndefined()
      } else {
        const repair = repairState(root)
        expect(repair.phase).toBe('repair_pending')
        expect(eventIds(h.agent).filter(id => id === repair.targetMessageId)).toHaveLength(variant === 'replace' ? 0 : 1)
        expect(canonicalTargetEvents(h.agent, repair.targetMessageId)).toHaveLength(variant === 'replace' ? 0 : 1)
      }
      assertUniqueRepairLog(h.agent)
      trace.restore()
    }

    const restartWindows = ['target-absent', 'target-exact-present', 'finalized-put-restart'] as const
    for (const window of restartWindows) {
      const root = await mkdtemp(join(tmpdir(), `no-focus-repair-restart-${window}-`)); roots.push(root); await establishTail(root)
      const generation = repairGeneration(root)
      const first = await mount(root, true, async (ctx, domain) => {
        if (window === 'target-absent') ctx.on('agent/created', ({ agent }) => {
          const append = agent.session.append
          agent.session.append = function appendWithFailure<T extends SessionEventType>(
            type: T,
            data: SessionEventMap[T],
            ...options: T extends SurfaceEventType ? [SurfaceIntent] : []
          ): SessionEvent<T> {
            const surface = options[0]?.surfaceOp
            if (typeof surface === 'object' && surface !== null && 'op' in surface && surface.op === 'replace') {
              throw new Error('target absent before replace')
            }
            return Reflect.apply(append, this, [type, data, ...options])
          }
        }, { prepend: true })
        if (window === 'target-exact-present') {
          const sessions = ctx.sessions as unknown as { flush(session: Agent['session']): Promise<boolean> }
          const flush = sessions.flush.bind(sessions)
          let calls = 0
          sessions.flush = async session => ++calls === 1 ? false : await flush(session)
        }
        if (window === 'finalized-put-restart') {
          const table = domain.table('focus_precanonical')
          const put = table.put.bind(table)
          table.put = async (key, value) => {
            if ((value as { transaction?: { repair?: { phase?: string } } }).transaction?.repair?.phase === 'repair_finalized') {
              throw new Error('finalized put restart')
            }
            await put(key, value)
          }
        }
      })
      await first.agent.whenIdle()
      const pending = repairState(root)
      expect(pending.phase).toBe('repair_pending')
      expect(pending.generation).toBe(generation)
      const targetBeforeRestart = eventIds(first.agent).filter(id => id === pending.targetMessageId)
      expect(targetBeforeRestart).toHaveLength(window === 'target-absent' ? 0 : 1)
      const targetEventsBeforeRestart = canonicalTargetEvents(first.agent, pending.targetMessageId)
      expect(targetEventsBeforeRestart).toHaveLength(window === 'target-absent' ? 0 : 1)
      const plannedReplaceSeq = targetEventsBeforeRestart[0]?.seq
      assertUniqueRepairLog(first.agent)
      await first.ctx.sessions.flush(first.agent.session)
      await first.ctx.fiber.dispose(); contexts.splice(contexts.indexOf(first.ctx), 1)

      const second = await mount(root, true)
      await second.agent.whenIdle()
      const finalized = repairState(root)
      expect(finalized.phase).toBe('repair_finalized')
      expect(finalized.targetMessageId).toBe(pending.targetMessageId)
      expect(finalized.generation).toBe(pending.generation)
      expect(finalized.generation).toBe(generation)
      expect(eventIds(second.agent).filter(id => id === finalized.targetMessageId)).toHaveLength(1)
      const targetEventsAfterRestart = canonicalTargetEvents(second.agent, finalized.targetMessageId)
      expect(targetEventsAfterRestart).toHaveLength(1)
      expect(finalized.targetReplaceSeq).toBe(targetEventsAfterRestart[0]?.seq)
      if (plannedReplaceSeq !== undefined) expect(finalized.targetReplaceSeq).toBe(plannedReplaceSeq)
      assertUniqueRepairLog(second.agent)
      expect(second.adapter.rootCalls).toBe(0)
      expect(second.adapter.auxiliaryCalls).toBe(0)
      const continued = await send(second.agent, '继续')
      expect(second.adapter.rootCalls).toBe(1)
      expect(directEvents(second.agent, continued.id)).toHaveLength(1)
    }

    const malformedTargets = ['duplicate-target', 'mismatched-target'] as const
    for (const variant of malformedTargets) {
      const root = await mkdtemp(join(tmpdir(), `no-focus-repair-public-${variant}-`)); roots.push(root); await establishTail(root)
      const generation = repairGeneration(root)
      let firstTrace: RecoveryTrace | undefined
      let restoreFirstAppend: (() => void) | undefined
      const first = await mount(root, true, async (ctx, _domain) => {
        firstTrace = traceRecoveryPorts(ctx)
        ctx.on('agent/error', () => { firstTrace?.entries.push('error') })
        ctx.on('agent/created', ({ agent }) => {
          const append = agent.session.append
          agent.session.append = function preventPlannedTarget<T extends SessionEventType>(
            type: T,
            data: SessionEventMap[T],
            ...options: T extends SurfaceEventType ? [SurfaceIntent] : []
          ): SessionEvent<T> {
            const surface = options[0]?.surfaceOp
            if (typeof surface === 'object' && surface !== null && 'op' in surface && surface.op === 'replace') {
              throw new Error('hold public target until injection')
            }
            return Reflect.apply(append, this, [type, data, ...options])
          }
          restoreFirstAppend = () => { agent.session.append = append }
        }, { prepend: true })
      })
      if (firstTrace === undefined) throw new Error('missing first public-target trace')
      await first.agent.whenIdle()
      const pending = repairState(root)
      expect(pending.phase).toBe('repair_pending')
      expect(pending.generation).toBe(generation)
      expect(canonicalTargetEvents(first.agent, pending.targetMessageId)).toHaveLength(0)
      restoreFirstAppend?.()
      appendPublicMalformedRepairTarget(first.agent, pending.targetMessageId, variant)
      const firstTargets = canonicalTargetEvents(first.agent, pending.targetMessageId)
      expect(firstTargets).toHaveLength(variant === 'duplicate-target' ? 2 : 1)
      if (variant === 'duplicate-target') {
        expect(eventIds(first.agent).filter(id => id === pending.targetMessageId)).toHaveLength(2)
      } else {
        expect(eventIds(first.agent).filter(id => id === pending.targetMessageId)).toHaveLength(1)
      }
      const firstBaseline = { ...repairWorkCounts(first.agent), root: first.adapter.rootCalls, auxiliary: first.adapter.auxiliaryCalls }
      const firstErrors = errors(first.ctx, first.agent)
      await assertClosedRepairContinuation(first, firstTrace, firstErrors, firstBaseline)
      expect(repairState(root)).toEqual(pending)
      expect(repairGeneration(root)).toBe(generation)
      assertUniqueRepairLog(first.agent, variant === 'duplicate-target' ? pending.targetMessageId : undefined)
      await first.ctx.sessions.flush(first.agent.session)
      firstTrace.restore()
      await first.ctx.fiber.dispose(); contexts.splice(contexts.indexOf(first.ctx), 1)

      let secondTrace: RecoveryTrace | undefined
      const second = await mount(root, true, async ctx => {
        secondTrace = traceRecoveryPorts(ctx)
        ctx.on('agent/error', () => { secondTrace?.entries.push('error') })
      })
      if (secondTrace === undefined) throw new Error('missing restarted public-target trace')
      await second.agent.whenIdle()
      const afterRestart = repairState(root)
      expect(afterRestart).toEqual(pending)
      expect(afterRestart.targetMessageId).toBe(pending.targetMessageId)
      expect(afterRestart.generation).toBe(generation)
      const restartedTargets = canonicalTargetEvents(second.agent, pending.targetMessageId)
      expect(restartedTargets).toHaveLength(firstTargets.length)
      expect(restartedTargets.map(event => event.seq)).toEqual(firstTargets.map(event => event.seq))
      const secondBaseline = { ...repairWorkCounts(second.agent), root: second.adapter.rootCalls, auxiliary: second.adapter.auxiliaryCalls }
      const secondErrors = errors(second.ctx, second.agent)
      await assertClosedRepairContinuation(second, secondTrace, secondErrors, secondBaseline)
      expect(repairState(root)).toEqual(pending)
      expect(repairGeneration(root)).toBe(generation)
      assertUniqueRepairLog(second.agent, variant === 'duplicate-target' ? pending.targetMessageId : undefined)
      secondTrace.restore()
    }
  })

  it('negative: final repair sidecar write failure retains one physically proved direct input and stays pending', async () => {
    const root = await mkdtemp(join(tmpdir(), 'no-focus-owner-closed-')); roots.push(root); await establishTail(root)
    let trace: RecoveryTrace | undefined
    const h = await mount(root, true, async (ctx, domain) => {
      trace = traceRecoveryPorts(ctx)
      ctx.on('agent/error', () => { trace?.entries.push('error') })
      const table = domain.table('focus_precanonical')
      const put = table.put.bind(table)
      table.put = async (key, value) => {
        if ((value as { transaction?: { repair?: { phase?: string } } }).transaction?.repair?.phase === 'repair_finalized') {
          throw new Error('maintenance final write')
        }
        await put(key, value)
      }
    })
    if (trace === undefined) throw new Error('missing final-write trace')
    await h.agent.whenIdle()
    const pending = repairState(root)
    expect(pending.phase).toBe('repair_pending')
    const baseline = { ...repairWorkCounts(h.agent), root: h.adapter.rootCalls, auxiliary: h.adapter.auxiliaryCalls }
    const seen = errors(h.ctx, h.agent)
    await assertClosedRepairContinuation(h, trace, seen, baseline)
    expect(repairState(root)).toEqual(pending)
    expect(repairGeneration(root)).toBe(pending.generation)
    trace.restore()
  })

  it('negative: public duplicate-created lifecycle rejection and sequential distinct Context preserve external recovery idempotency', async () => {
    const root = await mkdtemp(join(tmpdir(), 'no-focus-duplicate-created-')); roots.push(root); await establishTail(root)
    const target = await mount(root, true)
    await target.agent.whenIdle()
    const before = readRecord(root)
    const targetCanonical = canonicalEvents(target.agent).map(event => ({ id: String(event.data.id), seq: event.seq }))
    const targetWork = repairWorkCounts(target.agent)
    expect(target.adapter.rootCalls).toBe(0)
    expect(target.adapter.auxiliaryCalls).toBe(0)

    expect(() => target.ctx.emit('agent/created', { agent: target.agent })).toThrow('already registered')
    expect(() => target.ctx.emit('agent/created', { agent: target.agent })).toThrow('already registered')
    await target.agent.whenIdle()
    expect(readRecord(root)).toEqual(before)
    expect(canonicalEvents(target.agent).map(event => ({ id: String(event.data.id), seq: event.seq }))).toEqual(targetCanonical)
    expect(repairWorkCounts(target.agent)).toEqual(targetWork)
    expect(target.adapter.rootCalls).toBe(0)
    expect(target.adapter.auxiliaryCalls).toBe(0)

    const observer = await mount(root, true)
    await observer.agent.whenIdle()
    expect(readRecord(root)).toEqual(before)
    expect(canonicalEvents(observer.agent).map(event => ({ id: String(event.data.id), seq: event.seq }))).toEqual(targetCanonical)
    expect(repairWorkCounts(observer.agent)).toEqual(targetWork)
    expect(observer.adapter.rootCalls).toBe(0)
    expect(observer.adapter.auxiliaryCalls).toBe(0)
    await observer.ctx.fiber.dispose(); contexts.splice(contexts.indexOf(observer.ctx), 1)

    await target.ctx.fiber.dispose(); contexts.splice(contexts.indexOf(target.ctx), 1)
    const finalTarget = await mount(root, true)
    await finalTarget.agent.whenIdle()
    expect(readRecord(root)).toEqual(before)
    expect(canonicalEvents(finalTarget.agent).map(event => ({ id: String(event.data.id), seq: event.seq }))).toEqual(targetCanonical)
    const continued = await send(finalTarget.agent, '继续')
    expect(finalTarget.adapter.rootCalls).toBe(1)
    expect(finalTarget.adapter.auxiliaryCalls).toBe(0)
    expect(directEvents(finalTarget.agent, continued.id)).toHaveLength(1)
  })
})
