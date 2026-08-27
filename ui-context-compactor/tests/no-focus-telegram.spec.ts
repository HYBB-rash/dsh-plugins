import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import {
  createUserMessage,
  LlmAdapter,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
  type UserMessage,
} from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import * as commandCompact from '@deepseek-ai/dsh-command-compact'
import WebRuntime from '@deepseek-ai/dsh-web'
import { runGateway, type TelegramHttp } from '../../telegram-gateway/src/index.ts'
import * as ContextManager from '../src/index.ts'
import { ManagedAwareBasicCompactionEngine } from '../src/managed-compaction.ts'
import { FocusAuthority } from '../src/focus.ts'

const roots: string[] = []
const contexts: Context[] = []
const sessionId = 'session-telegram'
const closeText = '这件事结束了'

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

class Adapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  rootCalls = 0
  auxiliaryCalls = 0
  auxiliaryFailure: unknown

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 8_192 } })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (options.messages.some(message => message.source.kind === 'plugin'
      && message.source.plugin === 'ui-context-compactor:focus-canary-schema')) {
      this.auxiliaryCalls += 1
      if (this.auxiliaryFailure !== undefined) throw this.auxiliaryFailure
      yield* chunks('{"kind":"close","relation":"current"}')
      return
    }
    this.rootCalls += 1
    yield* chunks(options.messages[0]?.source.kind === 'context-manager-canonical'
      ? '当前事项已结束，请告诉我下一件事'
      : '历史回复')
  }
}

interface FrozenObservationLedger {
  readonly auxiliaryCalls: number
  readonly rootCalls: number
  readonly canonical: number
  readonly directClose: number
  readonly phase: string | undefined
  readonly familyKeys: readonly string[]
}

interface Mounted {
  readonly ctx: Context
  readonly agent: Agent
  readonly adapter: Adapter
  readonly root: string
  readonly sqlitePath: string
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function row(path: string): Record<string, unknown> | undefined {
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    const stored = object(database.prepare(
      'SELECT value FROM "u_context_manager_focus_precanonical" WHERE key = ?',
    ).get(sessionId))
    return typeof stored?.value === 'string' ? object(JSON.parse(stored.value)) : undefined
  } finally {
    database.close()
  }
}

function ledger(harness: Mounted): FrozenObservationLedger {
  const stored = row(harness.sqlitePath)
  const transaction = object(stored?.transaction)
  return Object.freeze({
    auxiliaryCalls: harness.adapter.auxiliaryCalls,
    rootCalls: harness.adapter.rootCalls,
    canonical: harness.agent.session.events.filter(event => event.type === 'user/message'
      && event.data.source.kind === 'context-manager-canonical').length,
    directClose: harness.agent.session.events.filter(event => event.type === 'user/message'
      && event.data.source.kind === 'user' && text(event.data) === closeText).length,
    phase: typeof transaction?.phase === 'string' ? transaction.phase : undefined,
    familyKeys: Object.freeze(stored === undefined ? [] : Object.keys(stored).sort()),
  })
}

function text(message: { readonly content: readonly { readonly type: string; readonly text?: string }[] }): string | undefined {
  return message.content.length === 1 && message.content[0]?.type === 'text'
    ? message.content[0].text
    : undefined
}

async function seedHistory(root: string, target = sessionId, prior = '历史上下文'): Promise<void> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  const adapter = new Adapter()
  ctx.llm.registerAdapter(['telegram-no-focus-test'], adapter)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  const agent = ctx.agentLoop.create(SessionId(target), { provider: 'telegram-no-focus-test', model: 'telegram-no-focus-test' })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: prior }], source: { kind: 'user' } }))
  await agent.whenIdle()
  await ctx.sessions.flush(agent.session)
  await ctx.fiber.dispose()
  contexts.splice(contexts.indexOf(ctx), 1)
}

async function mount(
  root: string,
  target = sessionId,
  resume = true,
  initialRow?: Readonly<Record<string, unknown>>,
  beforeAgent?: (adapter: Adapter, ctx: Context) => void,
  installAfterAgent = false,
  afterAgentBeforeInstall?: (agent: Agent) => void,
): Promise<Mounted> {
  const ctx = new Context()
  contexts.push(ctx)
  const sqlitePath = join(root, 'context-manager.sqlite')
  const configPath = join(root, 'context-manager.yml')
  await mkdir(join(root, 'sessions'), { recursive: true })
  if (initialRow !== undefined) {
    const database = new DatabaseSync(sqlitePath)
    try {
      database.exec(`
        PRAGMA user_version = 1;
        CREATE TABLE units (
          name TEXT PRIMARY KEY,
          version INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE unit_globals (
          unit TEXT PRIMARY KEY REFERENCES units(name),
          value TEXT NOT NULL
        ) STRICT;
        CREATE TABLE "u_context_manager_focus_precanonical" (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        ) STRICT;
      `)
      database.prepare('INSERT INTO units (name, version) VALUES (?, ?)').run('context_manager', 1)
      database.prepare('INSERT INTO "u_context_manager_focus_precanonical" (key, value) VALUES (?, ?)')
        .run(target, JSON.stringify(initialRow))
    } finally {
      database.close()
    }
  }
  await writeFile(configPath, [
    '- name: cordis:context-manager',
    '  config:',
    '    focusCanary:',
    '      mode: enforce',
    '      safeUpdateMarginTokens: 64',
    '      allowlist:',
    `        - ${sessionId}`,
    '      auxiliary:',
    '        provider: telegram-no-focus-test',
    '        model: telegram-no-focus-test',
    '        maxOutputTokens: 64',
    '        timeoutMs: 500',
    '        maxExpressionChars: 240',
    '        maxProjectionTokens: 1024',
    '        safetyMarginTokens: 128',
    '    nativeWriterArbitration:',
    '      mode: enforce',
    '',
  ].join('\n'))
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageSqlite, { path: sqlitePath })
  await ctx.plugin(StorageDomain, { backend: 'sqlite' })
  await ctx.plugin(TokenMeter)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
  await ctx.plugin(CommandRuntime)
  const managedRuntime = { mode: 'enforce' as const, safeUpdateMarginTokens: 64, allowlist: [sessionId] }
  await ctx.plugin(ManagedAwareBasicCompactionEngine, {
    auto: true, thresholdRatio: .99, retainRatio: .1, managedRuntime,
  })
  await ctx.plugin(commandCompact)
  await ctx.plugin(WebRuntime, { searchProvider: 'telegram-no-focus-search' })
  ctx.web.registerSearchProvider({
    id: 'telegram-no-focus-search', available: () => true,
    search: async () => ({ sources: [], truncated: false }),
  })
  const adapter = new Adapter()
  ctx.llm.registerAdapter(['telegram-no-focus-test'], adapter)
  beforeAgent?.(adapter, ctx)
  await ctx.plugin(AgentDefaultModel, { provider: 'telegram-no-focus-test', model: 'telegram-no-focus-test' })
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.builtins['context-manager'] = ContextManager
  const installContextManager = async (): Promise<void> => {
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await ctx.loader.await()
  }
  if (!installAfterAgent) await installContextManager()
  await ctx.plugin(AgentLoop, { agents: [] })
  const agent = resume
    ? (await ctx.agents.resume({ resumeSessionId: SessionId(target), agentOptions: {
        provider: 'telegram-no-focus-test', model: 'telegram-no-focus-test',
      } })).agent
    : ctx.agentLoop.create(SessionId(target), { provider: 'telegram-no-focus-test', model: 'telegram-no-focus-test' })
  afterAgentBeforeInstall?.(agent)
  if (installAfterAgent) await installContextManager()
  return { ctx, agent, adapter, root, sqlitePath }
}

async function send(agent: Agent, value: string): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text: value }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

async function close(harness: Mounted): Promise<void> {
  await send(harness.agent, closeText)
  await harness.ctx.sessions.flush(harness.agent.session)
}

async function freshHistoric(): Promise<Mounted> {
  const root = await mkdtemp(join(tmpdir(), 'no-focus-telegram-'))
  roots.push(root)
  await seedHistory(root)
  return await mount(root)
}

function exactCloseMessage(agent: Agent): UserMessage {
  const matches = agent.session.events.filter((event): event is SessionEvent<'user/message'> =>
    event.type === 'user/message' && event.data.source.kind === 'user' && text(event.data) === closeText)
  const message = matches[0]?.data
  if (matches.length !== 1 || message === undefined) throw new Error('missing unique exact close evidence')
  return message
}

async function appendDetachedDirect(root: string, message: UserMessage): Promise<void> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  const adapter = new Adapter()
  ctx.llm.registerAdapter(['telegram-no-focus-test'], adapter)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  const agent = (await ctx.agents.resume({
    resumeSessionId: SessionId(sessionId),
    agentOptions: { provider: 'telegram-no-focus-test', model: 'telegram-no-focus-test' },
  })).agent
  agent.session.append('user/message', message, { surfaceOp: 'append' })
  await ctx.sessions.flush(agent.session)
  await ctx.fiber.dispose()
  contexts.splice(contexts.indexOf(ctx), 1)
}

function cleanPending(finalized: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const closure = object(finalized.closure)
  const transaction = object(finalized.transaction)
  if (closure === undefined || transaction === undefined) throw new Error('missing natural finalized transaction')
  return Object.freeze({
    closure: Object.freeze({ ...closure }),
    transaction: Object.freeze({
      phase: 'pending',
      pendingRef: transaction.pendingRef,
      canonicalRef: transaction.canonicalRef,
      generation: transaction.generation,
      machine: transaction.machine,
      body: transaction.body,
      bodyHash: transaction.bodyHash,
      material: transaction.material,
      c06: transaction.c06,
      c07: transaction.c07,
      c29: transaction.c29,
    }),
  })
}

type PendingPollution = 'identity' | 'hash' | 'chat' | 'generation'

function pollutePending(
  pending: Readonly<Record<string, unknown>>,
  pollution: PendingPollution,
): Readonly<Record<string, unknown>> {
  const closure = object(pending.closure)
  const original = object(closure?.original)
  const decision = object(closure?.decision)
  const transaction = object(pending.transaction)
  if (closure === undefined || original === undefined || decision === undefined || transaction === undefined) {
    throw new Error('pending pollution fixture is incomplete')
  }
  return Object.freeze({
    closure: Object.freeze({
      ...closure,
      original: pollution === 'hash' ? Object.freeze({ ...original, hash: 'foreign-hash' }) : original,
      decision: pollution === 'chat' ? Object.freeze({ ...decision, chat: 'foreign-chat' }) : decision,
    }),
    transaction: Object.freeze({
      ...transaction,
      pendingRef: pollution === 'identity' ? 'pending:foreign' : transaction.pendingRef,
      generation: pollution === 'generation' ? 2 : transaction.generation,
    }),
  })
}

function canonicalMessages(events: readonly SessionEvent[]): number {
  return events.filter(event => event.type === 'user/message'
    && event.data.source.kind === 'context-manager-canonical').length
}

function emitDuplicateCreated(ctx: Context, agent: Agent): void {
  try {
    ctx.emit('agent/created', { agent })
  } catch (error) {
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('already registered')
  }
}

const proofOnlyPutFailurePattern = /^module=proof-only-cold-recovery stage=put-fail error=(?:Error|TypeError|RangeError|AbortError|UnknownError)$/

function captureProofOnlyRecoveryWarnings(ctx: Context, warnings: string[]): void {
  vi.spyOn(ctx.logger, 'warn').mockImplementation((message: unknown): undefined => {
    if (typeof message === 'string' && message.startsWith('module=proof-only-cold-recovery ')) {
      warnings.push(message)
    }
  })
}

function expectProofOnlyWarningsWhitelisted(warnings: readonly string[], secret: string): void {
  expect(warnings.every(message => proofOnlyPutFailurePattern.test(message))).toBe(true)
  expect(JSON.stringify(warnings)).not.toContain(closeText)
  expect(JSON.stringify(warnings)).not.toContain(secret)
}

describe('F07-T1 exact Telegram no-focus admission', () => {
  it('keeps closure-only stage diagnostics fixed-code and the managed failure unchanged', async () => {
    const secret = `${closeText}:must-not-leak`
    const cases = [
      {
        stage: 'bounded-proposal',
        errorName: 'Error',
        configure(harness: Mounted): () => void {
          const error = new Error(secret)
          error.name = secret
          harness.adapter.auxiliaryFailure = error
          return () => { harness.adapter.auxiliaryFailure = undefined }
        },
      },
      {
        stage: 'decision-and-carrier',
        errorName: 'UnknownError',
        configure(): () => void {
          const error = new Error(secret)
          error.name = secret
          const spy = vi.spyOn(FocusAuthority.prototype, 'fromBoundProposal').mockImplementation(() => { throw error })
          return () => spy.mockRestore()
        },
      },
      {
        stage: 'canonical-transaction',
        errorName: 'Error',
        configure(harness: Mounted): () => void {
          const database = new DatabaseSync(harness.sqlitePath)
          try {
            database.exec(`
              CREATE TRIGGER reject_closure_only_transaction
              BEFORE UPDATE ON "u_context_manager_focus_precanonical"
              WHEN json_type(NEW.value, '$.transaction') IS NOT NULL
              BEGIN
                SELECT RAISE(FAIL, '${secret}');
              END;
            `)
          } finally {
            database.close()
          }
          return () => {}
        },
      },
    ] as const

    for (const candidate of cases) {
      const harness = await freshHistoric()
      const errors: unknown[] = []
      harness.ctx.on('agent/error', ({ agent, error }) => {
        if (agent === harness.agent) errors.push(error)
      })
      const warn = vi.spyOn(harness.ctx.logger, 'warn').mockImplementation(() => undefined)
      const restore = candidate.configure(harness)
      try {
        await send(harness.agent, closeText)
      } finally {
        restore()
      }

      expect(errors.map(error => error instanceof Error ? error.message : String(error)))
        .toEqual(['唯一背景未能安全换入，本轮未继续行动'])
      const diagnostics = warn.mock.calls.filter(([message]) =>
        typeof message === 'string' && message.startsWith('ui-context-compactor: closure-only-live failure'))
      expect(diagnostics).toEqual([[
        `ui-context-compactor: closure-only-live failure module=closure-only-live stage=${candidate.stage} error=${candidate.errorName}`,
      ]])
      expect(JSON.stringify(warn.mock.calls)).not.toContain(secret)
      expect(JSON.stringify(errors.map(error => error instanceof Error ? error.message : String(error))))
        .not.toContain(secret)
      warn.mockRestore()
    }
  })

  it('positive: a public gateway closes the first exact historic session without a prior sidecar', async () => {
    const h = await freshHistoric()
    const lifetime = new AbortController()
    let polls = 0
    const sent: string[] = []
    const http: TelegramHttp = {
      getMe: async () => ({ id: 7, username: 'local' }),
      getUpdates: async () => {
        if (polls++ === 0) return [{ update_id: 1, message: {
          message_id: 9, chat: { id: 42, type: 'private' }, text: closeText,
        } }]
        lifetime.abort()
        return []
      },
      sendMessage: async (_chat, value) => { sent.push(value); return { messageId: sent.length } },
      sendTyping: async () => {},
      setReaction: async () => {},
    }
    await runGateway(h.ctx, {
      token: 'local', allowedChatId: '42', sessionId, apiBaseUrl: 'http://127.0.0.1',
      pollTimeoutSeconds: 1, offsetDir: join(h.root, 'offset'), maxMessageChars: 4096,
      requireInboundInterceptor: false,
    }, http, lifetime.signal)
    expect(ledger(h)).toStrictEqual(Object.freeze({
      auxiliaryCalls: 1, rootCalls: 1, canonical: 2, directClose: 1,
      phase: 'finalized', familyKeys: Object.freeze(['closure', 'transaction']),
    }))
    expect(sent).toContain('当前事项已结束，请告诉我下一件事')
  })

  it('positive: finalized closure-only cold recovery continues without reviving focus', async () => {
    const first = await freshHistoric()
    await close(first)
    const root = first.root
    await first.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(first.ctx), 1)
    const cold = await mount(root)
    await cold.agent.whenIdle()
    expect(ledger(cold).phase).toBe('finalized')
    const before = cold.adapter.auxiliaryCalls
    await send(cold.agent, '继续')
    expect(cold.adapter.auxiliaryCalls).toBe(before)
    expect(cold.adapter.rootCalls).toBe(1)
    expect(cold.adapter.requests.at(-1)?.messages.map(message => message.source.kind))
      .toStrictEqual(['context-manager-canonical', 'user'])
  })

  it('positive: closure-only clean-pending recovery replays the same generation without re-signing', async () => {
    const first = await freshHistoric()
    await close(first)
    const finalized = row(first.sqlitePath)
    if (finalized === undefined) throw new Error('missing natural finalized evidence')
    const pending = cleanPending(finalized)
    const generation = object(pending.transaction)?.generation
    const directClose = exactCloseMessage(first.agent)
    await first.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(first.ctx), 1)
    const root = await mkdtemp(join(tmpdir(), 'no-focus-clean-pending-'))
    roots.push(root)
    await seedHistory(root)
    await appendDetachedDirect(root, directClose)
    const replay = await mount(root, sessionId, true, pending)
    await replay.agent.whenIdle()
    const replayed = row(replay.sqlitePath)
    expect(object(replayed?.transaction)?.generation).toBe(generation)
    expect(ledger(replay)).toStrictEqual(Object.freeze({
      auxiliaryCalls: 0, rootCalls: 0, canonical: 2, directClose: 1,
      phase: 'finalized', familyKeys: Object.freeze(['closure', 'transaction']),
    }))
    await send(replay.agent, '继续')
    expect(replay.adapter.auxiliaryCalls).toBe(0)
    expect(replay.adapter.rootCalls).toBe(1)
    expect(replay.adapter.requests.at(-1)?.messages.map(message => message.source.kind))
      .toStrictEqual(['context-manager-canonical', 'user'])
  })

  it('positive: cron remains outside the exact classifier on its first line', async () => {
    const root = await mkdtemp(join(tmpdir(), 'no-focus-cron-'))
    roots.push(root)
    await seedHistory(root, 'session-cron-f07')
    const h = await mount(root, 'session-cron-f07')
    await send(h.agent, closeText)
    expect(h.adapter.auxiliaryCalls).toBe(0)
    expect(h.adapter.rootCalls).toBeGreaterThan(0)
    expect(row(h.sqlitePath)).toBeUndefined()
    expect(canonicalMessages(h.agent.session.events)).toBe(0)
  })

  it('negative: non-exact close preserves the input and creates no canonical state', async () => {
    const h = await freshHistoric()
    await send(h.agent, `${closeText}。`)
    expect(h.adapter.rootCalls).toBe(0)
    expect(canonicalMessages(h.agent.session.events)).toBe(0)
    expect(row(h.sqlitePath)).toBeUndefined()
  })

  it('negative: empty history or a prior native trace bypasses no error boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'no-focus-empty-'))
    roots.push(root)
    const h = await mount(root, sessionId, false)
    await send(h.agent, closeText)
    expect(h.adapter.rootCalls).toBe(0)
    expect(canonicalMessages(h.agent.session.events)).toBe(0)
    expect(row(h.sqlitePath)).toBeUndefined()

    const nativeRoot = await mkdtemp(join(tmpdir(), 'no-focus-native-'))
    roots.push(nativeRoot)
    await seedHistory(nativeRoot)
    const native = await mount(nativeRoot)
    native.agent.followup(createUserMessage({
      content: [{ type: 'text', text: closeText }],
      source: { kind: 'plugin', plugin: 'native-checkpoint' },
    }))
    await native.agent.whenIdle()
    expect(native.adapter.auxiliaryCalls).toBe(0)
    expect(native.adapter.rootCalls).toBe(0)
    expect(canonicalMessages(native.agent.session.events)).toBe(0)
    expect(row(native.sqlitePath)).toBeUndefined()
  })

  it('negative: expected-missing prior exact close or canonical state never becomes a fresh chat', async () => {
    const root = await mkdtemp(join(tmpdir(), 'no-focus-prior-close-'))
    roots.push(root)
    await seedHistory(root, sessionId, closeText)
    const h = await mount(root)
    await h.agent.whenIdle()
    await send(h.agent, closeText)
    expect(h.adapter.rootCalls).toBe(0)
    expect(h.adapter.auxiliaryCalls).toBe(0)
    expect(row(h.sqlitePath)).toBeUndefined()

    const established = await freshHistoric()
    await close(established)
    await established.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(established.ctx), 1)
    const database = new DatabaseSync(established.sqlitePath)
    try {
      database.prepare('DELETE FROM "u_context_manager_focus_precanonical" WHERE key = ?').run(sessionId)
    } finally {
      database.close()
    }
    const missing = await mount(established.root)
    await missing.agent.whenIdle()
    await send(missing.agent, closeText)
    expect(missing.adapter.rootCalls).toBe(0)
    expect(missing.adapter.auxiliaryCalls).toBe(0)

  })

  it('negative: pending identity, hash, chat, or generation pollution cannot replay', async () => {
    const natural = await freshHistoric()
    await close(natural)
    const finalized = row(natural.sqlitePath)
    if (finalized === undefined) throw new Error('missing natural finalized evidence')
    const pending = cleanPending(finalized)
    const directClose = exactCloseMessage(natural.agent)
    await natural.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(natural.ctx), 1)
    for (const pollution of ['identity', 'hash', 'chat', 'generation'] as const) {
      const root = await mkdtemp(join(tmpdir(), `no-focus-polluted-${pollution}-`))
      roots.push(root)
      await seedHistory(root)
      await appendDetachedDirect(root, directClose)
      const outcome = await mount(root, sessionId, true, pollutePending(pending, pollution)).then(
        harness => ({ kind: 'mounted' as const, harness }),
        () => ({ kind: 'rejected' as const }),
      )
      if (outcome.kind === 'mounted') {
        await outcome.harness.agent.whenIdle()
        await send(outcome.harness.agent, '继续')
        expect(outcome.harness.adapter.rootCalls).toBe(0)
        expect(outcome.harness.adapter.auxiliaryCalls).toBe(0)
        expect(canonicalMessages(outcome.harness.agent.session.events)).toBe(0)
      } else {
        expect(outcome.kind).toBe('rejected')
      }
    }
  })

  it('negative: storage put/read or replacement-tail failures stay closed', async () => {
    const putFailure = await freshHistoric()
    const putDatabase = new DatabaseSync(putFailure.sqlitePath)
    try {
      putDatabase.exec(`
        CREATE TRIGGER reject_no_focus_put
        BEFORE INSERT ON "u_context_manager_focus_precanonical"
        BEGIN
          SELECT RAISE(FAIL, 'fixture put failure');
        END
      `)
    } finally {
      putDatabase.close()
    }
    await close(putFailure)
    expect(putFailure.adapter.rootCalls).toBe(0)
    expect(putFailure.adapter.auxiliaryCalls).toBe(0)
    expect(canonicalMessages(putFailure.agent.session.events)).toBe(0)

    const readFailure = await freshHistoric()
    await readFailure.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(readFailure.ctx), 1)
    const readDatabase = new DatabaseSync(readFailure.sqlitePath)
    try {
      readDatabase.prepare('INSERT INTO "u_context_manager_focus_precanonical" (key, value) VALUES (?, ?)')
        .run(sessionId, '{')
    } finally {
      readDatabase.close()
    }
    const readOutcome = await mount(readFailure.root).then(
      () => 'mounted' as const,
      () => 'rejected' as const,
    )
    expect(readOutcome).toBe('rejected')

    const first = await freshHistoric()
    await close(first)
    first.agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '污染的后续输入' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    await first.ctx.sessions.flush(first.agent.session)
    const root = first.root
    await first.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(first.ctx), 1)
    const cold = await mount(root)
    await cold.agent.whenIdle()
    await send(cold.agent, '继续')
    expect(cold.adapter.rootCalls).toBe(0)
    expect(cold.adapter.auxiliaryCalls).toBe(0)
  })

  it('positive: proof-only cold recovery closes the exact two-failure transcript without a third direct', async () => {
    const h = await freshHistoric()
    const firstErrors: unknown[] = []
    h.ctx.on('agent/error', ({ agent, error }) => {
      if (agent === h.agent) firstErrors.push(error)
    })
    const database = new DatabaseSync(h.sqlitePath)
    try {
      database.exec(`
        CREATE TRIGGER reject_closure_only_transaction_recovery_fixture
        BEFORE UPDATE ON "u_context_manager_focus_precanonical"
        WHEN json_type(NEW.value, '$.transaction') IS NOT NULL
        BEGIN
          SELECT RAISE(FAIL, 'fixture');
        END;
      `)
    } finally {
      database.close()
    }
    await send(h.agent, closeText)
    const writable = new DatabaseSync(h.sqlitePath)
    try {
      writable.exec('DROP TRIGGER reject_closure_only_transaction_recovery_fixture')
    } finally {
      writable.close()
    }
    await h.ctx.sessions.flush(h.agent.session)
    expect(firstErrors.map(error => error instanceof Error ? error.message : String(error)))
      .toEqual(['唯一背景未能安全换入，本轮未继续行动'])
    const closeIds = h.agent.session.events.filter(event => event.type === 'user/message'
      && event.data.source.kind === 'user' && text(event.data) === closeText).map(event => String(event.data.id))
    expect(closeIds).toHaveLength(1)
    await h.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(h.ctx), 1)
    const second = await mount(h.root, sessionId, true, undefined, adapter => {
      adapter.auxiliaryFailure = new Error('fixture recovery admission failure')
    })
    await second.agent.whenIdle()
    second.adapter.auxiliaryFailure = undefined
    const secondErrors: unknown[] = []
    second.ctx.on('agent/error', ({ agent, error }) => {
      if (agent === second.agent) secondErrors.push(error)
    })
    await send(second.agent, '继续')
    await second.ctx.sessions.flush(second.agent.session)
    expect(secondErrors.map(error => error instanceof Error ? error.message : String(error)))
      .toEqual(['唯一背景未能安全换入，本轮未继续行动'])
    const continueIds = second.agent.session.events.filter(event => event.type === 'user/message'
      && event.data.source.kind === 'user' && text(event.data) === '继续').map(event => String(event.data.id))
    const assistantBaseline = second.agent.session.events.filter(event => event.type === 'assistant/message').length
    expect(continueIds).toHaveLength(1)
    await second.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(second.ctx), 1)
    const recoveryWarnings: string[] = []
    let maintenanceAttempts = 0
    const recovered = await mount(h.root, sessionId, true, undefined, (_adapter, ctx) => {
      captureProofOnlyRecoveryWarnings(ctx, recoveryWarnings)
    }, true, agent => {
      const runMaintenance = agent.runMaintenance.bind(agent)
      vi.spyOn(agent, 'runMaintenance').mockImplementation(task => {
        maintenanceAttempts += 1
        if (maintenanceAttempts === 1) throw new Error('fixture busy race')
        return runMaintenance(task)
      })
    })
    emitDuplicateCreated(recovered.ctx, recovered.agent)
    recovered.ctx.emit('agent/status', { agent: recovered.agent, status: 'idle' })
    await recovered.agent.whenIdle()
    await vi.waitFor(() => { expect(ledger(recovered).phase).toBe('finalized') })
    expect(maintenanceAttempts).toBe(2)
    expect(recoveryWarnings).toEqual([])
    expect(ledger(recovered)).toStrictEqual(Object.freeze({
      auxiliaryCalls: 1, rootCalls: 0, canonical: 2, directClose: 1,
      phase: 'finalized', familyKeys: Object.freeze(['closure', 'transaction']),
    }))
    expect(recovered.agent.session.events.filter(event => event.type === 'user/message'
      && event.data.source.kind === 'user' && text(event.data) === '继续').map(event => String(event.data.id)))
      .toEqual(continueIds)
    expect(recovered.agent.session.events.filter(event => event.type === 'assistant/message')).toHaveLength(assistantBaseline)
    expect(recovered.agent.session.deriveMessages().map(message => message.source.kind))
      .toStrictEqual(['context-manager-canonical'])
    const finalized = row(recovered.sqlitePath)
    const canonicalBefore = recovered.agent.session.events.filter(event => event.type === 'user/message'
      && event.data.source.kind === 'context-manager-canonical').map(event => ({ seq: event.seq, id: String(event.data.id) }))
    const assistantBefore = recovered.agent.session.events.filter(event => event.type === 'assistant/message').length
    const outboxBefore = recovered.agent.session.events.filter(event => String(event.type).includes('outbox')).length
    await recovered.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(recovered.ctx), 1)
    const idempotent = await mount(h.root, sessionId, true, undefined, undefined, true)
    emitDuplicateCreated(idempotent.ctx, idempotent.agent)
    await idempotent.agent.whenIdle()
    expect(row(idempotent.sqlitePath)).toEqual(finalized)
    expect(idempotent.adapter.auxiliaryCalls).toBe(0)
    expect(idempotent.adapter.rootCalls).toBe(0)
    expect(idempotent.agent.session.events.filter(event => event.type === 'user/message'
      && event.data.source.kind === 'context-manager-canonical').map(event => ({ seq: event.seq, id: String(event.data.id) })))
      .toEqual(canonicalBefore)
    expect(idempotent.agent.session.events.filter(event => event.type === 'user/message'
      && event.data.source.kind === 'user' && text(event.data) === closeText).map(event => String(event.data.id)))
      .toEqual(closeIds)
    expect(idempotent.agent.session.events.filter(event => event.type === 'user/message'
      && event.data.source.kind === 'user' && text(event.data) === '继续').map(event => String(event.data.id)))
      .toEqual(continueIds)
    expect(idempotent.agent.session.events.filter(event => event.type === 'assistant/message')).toHaveLength(assistantBefore)
    expect(idempotent.agent.session.events.filter(event => String(event.type).includes('outbox'))).toHaveLength(outboxBefore)
  })

  it('negative: polluted proof identity, hash, chat, missing direct, or extra tail stays closed', async () => {
    const variants = ['identity', 'hash', 'chat', 'missing-direct', 'extra-tail'] as const
    for (const variant of variants) {
      const source = await freshHistoric()
      const database = new DatabaseSync(source.sqlitePath)
      try {
        database.exec(`
          CREATE TRIGGER reject_closure_only_transaction_pollution_fixture
          BEFORE UPDATE ON "u_context_manager_focus_precanonical"
          WHEN json_type(NEW.value, '$.transaction') IS NOT NULL
          BEGIN
            SELECT RAISE(FAIL, 'fixture');
          END;
        `)
      } finally {
        database.close()
      }
      await send(source.agent, closeText)
      const proof = row(source.sqlitePath)
      const closure = object(proof?.closure)
      const original = object(closure?.original)
      if (proof === undefined || closure === undefined || original === undefined) {
        throw new Error('missing proof-only pollution fixture')
      }
      let root = source.root
      if (variant === 'missing-direct') {
        const missingRoot = await mkdtemp(join(tmpdir(), 'no-focus-proof-missing-direct-'))
        roots.push(missingRoot)
        await seedHistory(missingRoot)
        root = missingRoot
      } else if (variant === 'extra-tail') {
        source.agent.session.append('user/message', createUserMessage({
          content: [{ type: 'text', text: '污染的后续输入' }], source: { kind: 'user' },
        }), { surfaceOp: 'append' })
        await source.ctx.sessions.flush(source.agent.session)
      }
      await source.ctx.fiber.dispose()
      contexts.splice(contexts.indexOf(source.ctx), 1)
      const targetPath = join(root, 'context-manager.sqlite')
      const target = new DatabaseSync(targetPath)
      try {
        if (variant === 'missing-direct') {
          target.exec(`
            PRAGMA user_version = 1;
            CREATE TABLE units (name TEXT PRIMARY KEY, version INTEGER NOT NULL) STRICT;
            CREATE TABLE unit_globals (unit TEXT PRIMARY KEY REFERENCES units(name), value TEXT NOT NULL) STRICT;
            CREATE TABLE "u_context_manager_focus_precanonical" (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
          `)
          target.prepare('INSERT INTO units (name, version) VALUES (?, ?)').run('context_manager', 1)
          target.prepare('INSERT INTO "u_context_manager_focus_precanonical" (key, value) VALUES (?, ?)')
            .run(sessionId, JSON.stringify(proof))
        } else {
          const polluted = variant === 'chat'
            ? { closure: { ...closure,
                proposal: { kind: 'close', relation: 'current' },
                decision: { kind: 'no_focus', ref: 'focus:foreign', chat: 'foreign-chat', latestCorrections: '' } } }
            : { closure: { ...closure, original: {
                ...original,
                ...(variant === 'identity' ? { messageId: 'foreign-message' } : {}),
                ...(variant === 'hash' ? { hash: 'foreign-hash' } : {}),
              } } }
          target.prepare('UPDATE "u_context_manager_focus_precanonical" SET value = ? WHERE key = ?')
            .run(JSON.stringify(polluted), sessionId)
          target.exec('DROP TRIGGER reject_closure_only_transaction_pollution_fixture')
        }
      } finally {
        target.close()
      }
      const cold = await mount(root)
      await cold.agent.whenIdle()
      expect(cold.adapter.auxiliaryCalls, variant).toBe(0)
      expect(cold.adapter.rootCalls, variant).toBe(0)
      expect(canonicalMessages(cold.agent.session.events), variant).toBe(0)
      expect(object(row(cold.sqlitePath)?.transaction), variant).toBeUndefined()
    }
  })

  it('negative: proof-only recovery rejects a runtime C01 decision for another chat', async () => {
    const source = await freshHistoric()
    const database = new DatabaseSync(source.sqlitePath)
    try {
      database.exec(`
        CREATE TRIGGER reject_closure_only_transaction_runtime_chat_fixture
        BEFORE UPDATE ON "u_context_manager_focus_precanonical"
        WHEN json_type(NEW.value, '$.transaction') IS NOT NULL
        BEGIN
          SELECT RAISE(FAIL, 'fixture');
        END;
      `)
    } finally {
      database.close()
    }
    await send(source.agent, closeText)
    const writable = new DatabaseSync(source.sqlitePath)
    try {
      writable.exec('DROP TRIGGER reject_closure_only_transaction_runtime_chat_fixture')
    } finally {
      writable.close()
    }
    await source.ctx.sessions.flush(source.agent.session)
    await source.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(source.ctx), 1)

    const original = FocusAuthority.prototype.fromBoundProposal
    const spy = vi.spyOn(FocusAuthority.prototype, 'fromBoundProposal').mockImplementation(function (
      this: FocusAuthority,
      proposal,
    ) {
      const bound = original.call(this, proposal)
      return {
        decideFocus(expression: Parameters<typeof bound.decideFocus>[0]) {
          const report = bound.decideFocus(expression)
          if (report.kind !== 'business_result' || report.value.kind !== 'no_focus') return report
          return {
            ...report,
            value: { ...report.value, chat: 'foreign-chat' as typeof report.value.chat },
          }
        },
      } as unknown as ReturnType<typeof original>
    })
    try {
      const cold = await mount(source.root)
      await cold.agent.whenIdle()
      expect(cold.adapter.auxiliaryCalls).toBe(1)
      expect(cold.adapter.rootCalls).toBe(0)
      expect(canonicalMessages(cold.agent.session.events)).toBe(0)
      expect(object(row(cold.sqlitePath)?.transaction)).toBeUndefined()
    } finally {
      spy.mockRestore()
    }
  })

  it('positive: proof-only transaction storage failure stays closed and completes on the next restart', async () => {
    const secret = 'proof-only-put-secret-must-not-leak'
    const first = await freshHistoric()
    const database = new DatabaseSync(first.sqlitePath)
    try {
      database.exec(`
        CREATE TRIGGER reject_closure_only_transaction_once
        BEFORE UPDATE ON "u_context_manager_focus_precanonical"
        WHEN json_type(NEW.value, '$.transaction') IS NOT NULL
        BEGIN
          SELECT RAISE(FAIL, '${secret}');
        END;
      `)
    } finally {
      database.close()
    }
    await send(first.agent, closeText)
    await first.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(first.ctx), 1)
    const warnings: string[] = []
    const failed = await mount(first.root, sessionId, true, undefined, (_adapter, ctx) => {
      captureProofOnlyRecoveryWarnings(ctx, warnings)
    })
    emitDuplicateCreated(failed.ctx, failed.agent)
    await failed.agent.whenIdle()
    expect(warnings).toEqual([
      'module=proof-only-cold-recovery stage=put-fail error=Error',
    ])
    expectProofOnlyWarningsWhitelisted(warnings, secret)
    expect(failed.adapter.auxiliaryCalls).toBe(1)
    expect(failed.adapter.rootCalls).toBe(0)
    expect(canonicalMessages(failed.agent.session.events)).toBe(0)
    expect(object(row(failed.sqlitePath)?.transaction)).toBeUndefined()
    await failed.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(failed.ctx), 1)
    const writable = new DatabaseSync(failed.sqlitePath)
    try {
      writable.exec('DROP TRIGGER reject_closure_only_transaction_once')
    } finally {
      writable.close()
    }
    const resumed = await mount(first.root)
    await resumed.agent.whenIdle()
    expect(ledger(resumed)).toStrictEqual(Object.freeze({
      auxiliaryCalls: 1, rootCalls: 0, canonical: 2, directClose: 1,
      phase: 'finalized', familyKeys: Object.freeze(['closure', 'transaction']),
    }))
  })
})
