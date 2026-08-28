import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, InboxTarget } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import {
  createUserMessage,
  freezeMessage,
  LlmAdapter,
  MessageId,
  ReasoningEffortId,
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
import {
  InputRequeueCoordinator,
  recoverableClaimedInputs,
  type InputRequeuePersistence,
} from '../src/input-requeue.ts'
import * as ContextManager from '../src/index.ts'
import { ManagedAwareBasicCompactionEngine } from '../src/managed-compaction.ts'
import { NO_FOCUS_TRANSACTION_FAILURE_TEXT } from '../src/managed-failure.ts'

const roots: string[] = []
const contexts: Context[] = []
const children: ChildProcess[] = []
const sessionId = ContextManager.FOCUS_CANARY_IDS[0]
const packageRoot = resolve(fileURLToPath(new URL('../', import.meta.url)))
const moduleRequire = createRequire(import.meta.url)
const tsxImport = createRequire(moduleRequire.resolve('vitest')).resolve('tsx/esm')
const contextManagerUrl = new URL('../src/index.ts', import.meta.url).href
const inputRequeueUrl = new URL('../src/input-requeue.ts', import.meta.url).href
const managedCompactionUrl = new URL('../src/managed-compaction.ts', import.meta.url).href

afterEach(async () => {
  vi.restoreAllMocks()
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
  readonly rootRequests: GenerateOptions[] = []

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: 8_192 },
      reasoning: { efforts: [{ id: ReasoningEffortId('off'), name: 'Off' }] },
    })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (options.messages.some(message => message.source.kind === 'plugin'
      && message.source.plugin === 'ui-context-compactor:focus-canary-schema')) {
      yield* chunks(JSON.stringify({ kind: 'focus', subject: '恢复原输入', relation: 'new' }))
      return
    }
    this.rootRequests.push(options)
    yield* chunks(`result-${this.requests.length}`)
  }
}

interface Harness {
  readonly ctx: Context
  readonly agent: Agent
  readonly adapter: Adapter
  readonly root: string
  readonly detachedReads: { readonly fromSeq: number; readonly events: readonly SessionEvent[] }[]
}

interface DomainTable {
  get(key: string): unknown
  put(key: string, value: unknown): Promise<void>
}

interface Domain {
  table(name: string): DomainTable
}

function isDomain(value: unknown): value is Domain {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && typeof Reflect.get(value, 'table') === 'function'
}

function isStorageDomainFacility(value: unknown): value is {
  open(spec: unknown): Promise<unknown>
} {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && typeof Reflect.get(value, 'open') === 'function'
}

async function mountPlain(root: string, resume = false): Promise<Harness> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await mkdir(join(root, 'sessions'), { recursive: true })
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
  const adapter = new Adapter()
  ctx.llm.registerAdapter(['input-requeue-test'], adapter)
  await ctx.plugin(AgentLoop, { agents: [] })
  const agent = resume
    ? (await ctx.agents.resume({
        resumeSessionId: SessionId(sessionId),
        agentOptions: { provider: 'input-requeue-test', model: 'input-requeue-test' },
      })).agent
    : ctx.agentLoop.create(SessionId(sessionId), {
        provider: 'input-requeue-test', model: 'input-requeue-test',
      })
  return { ctx, agent, adapter, root, detachedReads: [] }
}

async function mountManaged(
  root: string,
  beforeResume?: (ctx: Context, domain: Domain) => void | Promise<void>,
): Promise<Harness> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await mkdir(join(root, 'storages'), { recursive: true })
  await ctx.plugin(Storage)
  await ctx.plugin(StorageSqlite, { path: join(root, 'storages', 'input-requeue.sqlite') })
  await ctx.plugin(StorageDomain, { backend: 'sqlite' })
  await ctx.plugin(TokenMeter)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
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
  const adapter = new Adapter()
  ctx.llm.registerAdapter(['input-requeue-test'], adapter)
  let openedDomain: Domain | undefined
  const storageDomain = ctx.get('storageDomain')
  if (!isStorageDomainFacility(storageDomain)) throw new Error('missing storage-domain facility')
  const open = storageDomain.open.bind(storageDomain)
  storageDomain.open = async spec => {
    const domain = await open(spec)
    if (!isDomain(domain)) throw new Error('invalid context-manager storage domain')
    openedDomain = domain
    return domain
  }
  await ctx.plugin(ContextManager, {
    focusCanary: {
      ...managedRuntime,
      auxiliary: {
        provider: 'input-requeue-test', model: 'input-requeue-test',
        maxOutputTokens: 64, timeoutMs: 500, maxExpressionChars: 240,
        maxProjectionTokens: 1_024, safetyMarginTokens: 128,
      },
    },
    nativeWriterArbitration: { mode: 'enforce' },
  })
  if (openedDomain === undefined) throw new Error('context-manager domain did not open')
  await beforeResume?.(ctx, openedDomain)
  const detachedReads: { fromSeq: number; events: readonly SessionEvent[] }[] = []
  const readFrom = ctx.sessionPersistence.readFrom.bind(ctx.sessionPersistence)
  ctx.sessionPersistence.readFrom = async (id, fromSeq, signal) => {
    const detached = await readFrom(id, fromSeq, signal)
    detachedReads.push({ fromSeq, events: detached.events })
    return detached
  }
  await ctx.plugin(AgentLoop, { agents: [] })
  const agent = (await ctx.agents.resume({
    resumeSessionId: SessionId(sessionId),
    agentOptions: { provider: 'input-requeue-test', model: 'input-requeue-test' },
  })).agent
  return { ctx, agent, adapter, root, detachedReads }
}

async function fresh(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'input-requeue-'))
  roots.push(root)
  return await mountPlain(root)
}

function direct(id: string, text = '原始输入'): UserMessage {
  return freezeMessage({
    ...createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
    id: MessageId(id),
  })
}

async function orphan(
  harness: Harness,
  message = direct('input-original'),
  target: InboxTarget = 'next-turn',
): Promise<UserMessage> {
  harness.agent.inbox.append(target, message)
  expect(harness.agent.inbox.claim(target, 1)).toStrictEqual([message])
  expect(await harness.ctx.sessions.flush(harness.agent.session)).toBe(true)
  return message
}

function persistence(harness: Harness): InputRequeuePersistence {
  return {
    flush: async () => await harness.ctx.sessions.flush(harness.agent.session),
    readFrom: async fromSeq => await harness.ctx.sessionPersistence.readFrom(
      harness.agent.session.id, fromSeq,
    ),
  }
}

function pendingIds(agent: Agent): string[] {
  return [...agent.inbox.nextStep, ...agent.inbox.nextTurn].map(message => String(message.id))
}

function requestsWith(adapter: Adapter, id: string): GenerateOptions[] {
  return adapter.rootRequests.filter(request => String(request.messages.findLast(
    message => message.source.kind === 'user',
  )?.id) === id)
}

async function settle(agent: Agent): Promise<void> {
  for (let pass = 0; pass < 4; pass += 1) {
    await new Promise<void>(resolve => setImmediate(resolve))
    await agent.whenIdle()
  }
}

function modelExecutionEvents(agent: Agent): SessionEvent[] {
  return agent.session.events.filter(event => event.type === 'step/start'
    || event.type === 'request/header'
    || event.type === 'request/context'
    || event.type === 'assistant/chunk'
    || event.type === 'assistant/message'
    || event.type === 'tool/call'
    || event.type === 'tool/result')
}

async function dispose(harness: Harness): Promise<void> {
  await harness.ctx.fiber.dispose()
  contexts.splice(contexts.indexOf(harness.ctx), 1)
}

type CrashCheckpoint = 'seed-single' | 'seed-batch'
  | 'seed-terminal-user' | 'seed-terminal-request' | 'seed-terminal-canceled'
  | 'before-wake' | 'after-wake' | 'after-second-claim'

function hardCrashProgram(): string {
  return `
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, freezeMessage, LlmAdapter, MessageId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import * as commandCompact from '@deepseek-ai/dsh-command-compact'
const root=process.env.R1A_ROOT, mode=process.env.R1A_MODE, phase=process.env.R1A_PHASE
const managerUrl=process.env.R1A_MANAGER_URL, requeueUrl=process.env.R1A_REQUEUE_URL
const compactionUrl=process.env.R1A_COMPACTION_URL, sessionId=process.env.R1A_SESSION_ID
if(!root||!mode||!managerUrl||!requeueUrl||!compactionUrl||!sessionId) throw new Error('invalid R1A child environment')
const ContextManager=await import(managerUrl)
const { InputRequeueCoordinator }=await import(requeueUrl)
const { ManagedAwareBasicCompactionEngine }=await import(compactionUrl)
const checkpoint=(kind,data={})=>{process.send?.({kind,...data});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0)}
const direct=(id,text)=>freezeMessage({...createUserMessage({content:[{type:'text',text}],source:{kind:'user'}}),id:MessageId(id)})
const chunks=text=>[{type:'block-start',index:0,blockType:'text'},{type:'block-end',index:0,block:{type:'text',text}},{type:'finish',reason:{kind:'stop'}}]
class Adapter extends LlmAdapter { async resolveModel(provider,model){return {provider,id:model,name:model,context:{contextWindow:8192},reasoning:{efforts:[{id:'off',name:'Off'}]}}};async *stream(options){if(options.messages.some(message=>message.source.kind==='plugin'&&message.source.plugin==='ui-context-compactor:focus-canary-schema')){yield* chunks(JSON.stringify({kind:'focus',subject:'恢复原输入',relation:'new'}));return}yield* chunks('recovered result')}}
const ctx=new Context();await mountAgentLoopTestDependencies(ctx)
const fs=await import('node:fs/promises');await fs.mkdir(root+'/sessions',{recursive:true});await fs.mkdir(root+'/storages',{recursive:true})
await ctx.plugin(JsonlSessionPersistence,{root:root+'/sessions',compression:'none'})
ctx.llm.registerAdapter(['input-requeue-test'],new Adapter())
if(mode==='seed'){
  await ctx.plugin(AgentLoop,{agents:[]})
  const agent=ctx.agentLoop.create(SessionId(sessionId),{provider:'input-requeue-test',model:'input-requeue-test'})
  if(phase==='single'){
    const original=direct(process.env.R1A_INPUT_ID,'hard crash recovery')
    agent.inbox.append('next-turn',original);agent.inbox.claim('next-turn',1)
    if(!await ctx.sessions.flush(agent.session)) throw new Error('seed flush failed')
    checkpoint('seed-single',{inputId:String(original.id)})
  }
  if(phase==='batch'){
    const f07=direct('input-f07-owned','F07 owner'), canceled=direct('input-canceled-batch','canceled')
    const first=direct('input-batch-a','batch A'), second=direct('input-batch-b','batch B')
    const replaced=direct('input-replaced-old','replaced old')
    agent.inbox.splice('next-step',0,0,[f07,canceled,first,second,replaced]);agent.inbox.claim('next-step',5)
    agent.inbox.append('next-step',canceled);agent.inbox.remove(canceled.id)
    agent.inbox.append('next-step',replaced);agent.inbox.replace(replaced.id,direct('input-replacement','replacement'))
    agent.inbox.append('next-step',direct('input-later','later traffic'))
    const coordinator=new InputRequeueCoordinator(), full=coordinator.plan(agent)
    const selected=full.filter(input=>['input-batch-a','input-batch-b'].includes(String(input.message.id)))
    const outcomes=[]
    for(const input of selected) outcomes.push(await coordinator.recover(agent,input,{flush:async()=>await ctx.sessions.flush(agent.session),readFrom:async fromSeq=>await ctx.sessionPersistence.readFrom(agent.session.id,fromSeq)},'none',selected))
    if(outcomes.some(outcome=>outcome.kind!=='reinserted')) throw new Error('batch reinsert failed')
    checkpoint('seed-batch',{plan:full.map(input=>String(input.message.id)),pending:[...agent.inbox.nextStep,...agent.inbox.nextTurn].map(message=>String(message.id))})
  }
  if(phase?.startsWith('terminal-')){
    const variant=phase.slice('terminal-'.length), original=direct('input-terminal-'+variant,'terminal '+variant)
    agent.inbox.append('next-turn',original)
    if(variant==='canceled') agent.inbox.remove(original.id)
    else {
      agent.inbox.claim('next-turn',1)
      if(variant==='user') agent.session.append('user/message',original,{surfaceOp:'append'})
      else if(variant==='request') { agent.session.append('turn/start',{turn:1});agent.session.append('step/start',{turn:1,step:1}) }
      else throw new Error('invalid terminal variant')
    }
    agent.inbox.append('next-turn',original);agent.inbox.claim('next-turn',2)
    if(!await ctx.sessions.flush(agent.session)) throw new Error('terminal seed flush failed')
    checkpoint('seed-terminal-'+variant,{inputId:String(original.id)})
  }
  throw new Error('invalid seed phase')
}
await ctx.plugin(Storage);await ctx.plugin(StorageSqlite,{path:root+'/storages/input-requeue.sqlite'});await ctx.plugin(StorageDomain,{backend:'sqlite'});await ctx.plugin(TokenMeter);await ctx.plugin(CommandRuntime)
const managedRuntime={mode:'enforce',safeUpdateMarginTokens:64,allowlist:[...ContextManager.FOCUS_CANARY_IDS]}
await ctx.plugin(ManagedAwareBasicCompactionEngine,{auto:true,thresholdRatio:.99,retainRatio:.1,managedRuntime});await ctx.plugin(commandCompact)
await ctx.plugin(ContextManager,{focusCanary:{...managedRuntime,auxiliary:{provider:'input-requeue-test',model:'input-requeue-test',maxOutputTokens:64,timeoutMs:500,maxExpressionChars:240,maxProjectionTokens:1024,safetyMarginTokens:128}},nativeWriterArbitration:{mode:'enforce'}})
const originalId=process.env.R1A_INPUT_ID
if(mode==='recover'&&phase==='before-wake')ctx.on('agent/created',({agent})=>{const whenIdle=agent.whenIdle.bind(agent);let intercepted=false;agent.whenIdle=()=>{if(!intercepted){intercepted=true;checkpoint('before-wake')}return whenIdle()}})
if(mode==='recover'&&phase==='after-wake')ctx.on('agent/inbox/inserted',({message})=>{if(message.source.kind==='context-manager-input-requeue-wake')checkpoint('after-wake')})
if(mode==='recover'&&phase==='after-second-claim')ctx.on('agent/inbox/claimed',({message})=>{if(String(message.id)===originalId)checkpoint('after-second-claim')})
await ctx.plugin(AgentLoop,{agents:[]})
const agent=(await ctx.agents.resume({resumeSessionId:SessionId(sessionId),agentOptions:{provider:'input-requeue-test',model:'input-requeue-test'}})).agent
await agent.whenIdle();throw new Error('recovery checkpoint was not reached')
`
}

async function killAtCheckpoint(
  root: string,
  checkpoint: CrashCheckpoint,
  inputId?: string,
): Promise<Record<string, unknown>> {
  const seed = checkpoint.startsWith('seed-')
  const child = spawn(process.execPath, ['--import', tsxImport, '--eval', hardCrashProgram()], {
    cwd: packageRoot,
    env: {
      ...process.env,
      R1A_ROOT: root,
      R1A_MODE: seed ? 'seed' : 'recover',
      R1A_PHASE: seed ? checkpoint.slice('seed-'.length) : checkpoint,
      R1A_INPUT_ID: inputId,
      R1A_SESSION_ID: sessionId,
      R1A_MANAGER_URL: contextManagerUrl,
      R1A_REQUEUE_URL: inputRequeueUrl,
      R1A_COMPACTION_URL: managedCompactionUrl,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  children.push(child)
  const message = await new Promise<Record<string, unknown>>((resolveCheckpoint, reject) => {
    let stderr = ''
    const timer = setTimeout(() => reject(new Error(`${checkpoint} child timeout: ${stderr}`)), 15_000)
    child.stderr?.on('data', chunk => { stderr += String(chunk) })
    child.once('message', (value: unknown) => {
      clearTimeout(timer)
      if (value !== null && typeof value === 'object' && !Array.isArray(value)
        && Reflect.get(value, 'kind') === checkpoint) {
        resolveCheckpoint(value as Record<string, unknown>)
      } else {
        reject(new Error(`${checkpoint} child checkpoint mismatch: ${JSON.stringify(value)}`))
      }
    })
    child.once('exit', code => {
      clearTimeout(timer)
      reject(new Error(`${checkpoint} child exited ${String(code)}: ${stderr}`))
    })
    child.once('error', reject)
  })
  child.kill('SIGKILL')
  await once(child, 'exit')
  children.splice(children.indexOf(child), 1)
  return message
}

describe('F06-R1A claimed input recovery', () => {
  it('positive: real cold created recovery resumes once after crashes before wake, after wake and after the second claim', async () => {
    for (const phase of ['before-wake', 'after-wake', 'after-second-claim'] as const) {
      const root = await mkdtemp(join(tmpdir(), `input-requeue-${phase}-`))
      roots.push(root)
      const inputId = `input-${phase}`
      await killAtCheckpoint(root, 'seed-single', inputId)
      await killAtCheckpoint(root, phase, inputId)

      const cold = await mountManaged(root)
      await settle(cold.agent)
      expect(requestsWith(cold.adapter, inputId), `${phase}: ${JSON.stringify({
        pending: pendingIds(cold.agent),
        events: cold.agent.session.events.map(event => event.type === 'agent/inbox/spliced'
          ? { seq: event.seq, type: event.type, target: event.data.target, start: event.data.start,
              removedCount: event.data.removedCount, outcome: event.data.outcome,
              ids: event.data.inserted.map(message => String(message.id)) }
          : { seq: event.seq, type: event.type }),
        reads: cold.detachedReads.map(read => read.fromSeq),
      })}`).toHaveLength(1)
      expect(cold.agent.session.events.filter(event => event.type === 'user/message'
        && String(event.data.id) === inputId), phase).toHaveLength(1)
      expect(cold.agent.session.events.filter(event => event.type === 'assistant/message'), phase)
        .toHaveLength(1)
      expect(cold.agent.session.events.some(event => event.type === 'user/message'
        && event.data.source.kind === 'context-manager-input-requeue-wake'), phase).toBe(false)
      expect(pendingIds(cold.agent), phase).toStrictEqual([])
    }
  })

  it('positive: a selected multi-message batch returns to the target head in original order ahead of later traffic and remains cold-idempotent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'input-requeue-batch-'))
    roots.push(root)
    const seeded = await killAtCheckpoint(root, 'seed-batch')
    expect(seeded.plan).toStrictEqual(['input-f07-owned', 'input-batch-a', 'input-batch-b'])
    expect(seeded.pending).toStrictEqual([
      'input-batch-a', 'input-batch-b', 'input-replacement', 'input-later',
    ])

    const claimed: string[] = []
    const cold = await mountManaged(root, async (ctx, domain) => {
      await domain.table('focus_precanonical').put(sessionId, {
        closure: {
          phase: 'pending',
          original: { messageId: 'input-f07-owned', hash: 'f07-owned-proof' },
        },
      })
      ctx.on('agent/inbox/claimed', ({ message }) => { claimed.push(String(message.id)) })
    })
    await settle(cold.agent)
    expect(claimed.slice(0, 4)).toStrictEqual([
      'input-batch-a', 'input-batch-b', 'input-replacement', 'input-later',
    ])
    expect(claimed).not.toContain('input-f07-owned')
    expect(claimed).not.toContain('input-canceled-batch')
    expect(claimed).not.toContain('input-replaced-old')

    const reinsertions = cold.agent.session.events.filter(event => event.type === 'agent/inbox/spliced'
      && event.data.inserted.length === 1
      && event.data.inserted.some(message => ['input-batch-a', 'input-batch-b'].includes(String(message.id))))
    expect(reinsertions.map(event => event.type === 'agent/inbox/spliced' ? event.data.start : undefined))
      .toStrictEqual([0, 1])
    for (const event of reinsertions) {
      const read = cold.detachedReads.find(candidate => candidate.fromSeq === event.seq)
      expect(read, `detached proof for reinsert seq ${event.seq}`).toBeDefined()
      expect(read?.events.filter(candidate => candidate.seq === event.seq)).toStrictEqual([event])
    }
    expect(cold.adapter.rootRequests).toHaveLength(0)
    expect(cold.agent.session.events.some(event => event.type === 'user/message'
      && event.data.source.kind === 'context-manager-input-requeue-wake')).toBe(false)
  })

  it('positive: one proved live batch schedules one filtered wake and executes the original once', async () => {
    const harness = await fresh()
    const original = await orphan(harness)
    const coordinator = new InputRequeueCoordinator()
    const [firstPlan] = coordinator.plan(harness.agent)
    expect((await coordinator.recover(harness.agent, firstPlan!, persistence(harness))).kind)
      .toBe('reinserted')
    expect(harness.agent.inbox.claim('next-turn', 2)).toStrictEqual([original])
    const [secondPlan] = coordinator.plan(harness.agent)
    harness.ctx.on('agent/inbox/inserted', ({ agent, message }) => {
      if (agent === harness.agent) coordinator.discardInsertedWake(agent, message)
    }, { prepend: true })
    expect((await coordinator.recover(harness.agent, secondPlan!, persistence(harness))).kind)
      .toBe('reinserted')
    coordinator.wakeAfterIdle(harness.agent, [secondPlan!])
    await new Promise<void>(resolve => setImmediate(resolve))
    await harness.agent.whenIdle()
    expect(requestsWith(harness.adapter, String(original.id))).toHaveLength(1)
    expect(harness.agent.session.events.filter(event => event.type === 'assistant/message')).toHaveLength(1)
    expect(harness.agent.session.events.filter(event => event.type === 'tool/call'
      || event.type === 'tool/result')).toHaveLength(0)
    const wakeSplices = harness.agent.session.events.filter(event => event.type === 'agent/inbox/spliced'
      && event.data.inserted.some(message => message.source.kind === 'context-manager-input-requeue-wake'))
    expect(wakeSplices).toHaveLength(1)
    expect(harness.agent.session.events.some(event => event.type === 'user/message'
      && event.data.source.kind === 'context-manager-input-requeue-wake')).toBe(false)
    expect(pendingIds(harness.agent)).toStrictEqual([])
  })

  it('negative: a pre-reinsert throw plus write-behind refusal keeps one live identity and starts no wake or provider', async () => {
    const harness = await fresh()
    const original = await orphan(harness)
    const coordinator = new InputRequeueCoordinator()
    const [plan] = coordinator.plan(harness.agent)
    const splice = harness.agent.inbox.splice.bind(harness.agent.inbox)
    let calls = 0
    harness.agent.inbox.splice = ((...args: Parameters<typeof splice>) => {
      calls += 1
      if (calls === 1) throw new Error('before reinsert')
      return splice(...args)
    }) as typeof harness.agent.inbox.splice
    const outcome = await coordinator.recover(harness.agent, plan!, {
      flush: async () => false,
      readFrom: async () => ({ events: [] }),
    })
    expect(outcome.kind).toBe('persistence-failed')
    expect(calls).toBe(2)
    expect(pendingIds(harness.agent)).toStrictEqual([String(original.id)])
    expect(harness.adapter.requests).toHaveLength(0)
    expect(modelExecutionEvents(harness.agent)).toStrictEqual([])
    expect(harness.agent.session.events.some(event => event.type === 'user/message')).toBe(false)
    expect(harness.agent.session.events.some(event => event.type === 'agent/inbox/spliced'
      && event.data.inserted.some(message => message.source.kind === 'context-manager-input-requeue-wake'))).toBe(false)
  })

  it('negative: throw, empty and mismatched detached reads never prove persistence or wake the model', async () => {
    for (const variant of ['throw', 'empty', 'mismatch'] as const) {
      const harness = await fresh()
      const original = await orphan(harness, direct(`input-${variant}`))
      const coordinator = new InputRequeueCoordinator()
      const [plan] = coordinator.plan(harness.agent)
      const port = persistence(harness)
      const outcome = await coordinator.recover(harness.agent, plan!, {
        flush: port.flush,
        readFrom: async (fromSeq) => {
          if (variant === 'throw') throw new Error('read failed')
          if (variant === 'empty') return { events: [] }
          const detached = await port.readFrom(fromSeq)
          return {
            events: detached.events.map((event): SessionEvent => event.seq !== fromSeq
              || event.type !== 'agent/inbox/spliced'
              ? event
              : ({ ...event, data: { ...event.data, target: 'next-step' } } as SessionEvent)),
          }
        },
      })
      expect(outcome.kind, variant).toBe('persistence-failed')
      expect(pendingIds(harness.agent), variant).toStrictEqual([String(original.id)])
      expect(coordinator.hasDeferredFailure(harness.agent, String(original.id)), variant).toBe(true)
      expect(harness.adapter.requests, variant).toHaveLength(0)
      expect(modelExecutionEvents(harness.agent), variant).toStrictEqual([])
    }
  })

  it('negative: an existing same-id user message or request-start evidence is rejected for R1A and left for R1B', async () => {
    const userEvidence = await fresh()
    const original = await orphan(userEvidence, direct('input-user-evidence'))
    userEvidence.agent.session.append('user/message', original, { surfaceOp: 'append' })
    expect(recoverableClaimedInputs(sessionId, userEvidence.agent.session.events)).toStrictEqual([])

    const requestEvidence = await fresh()
    await orphan(requestEvidence, direct('input-request-evidence'))
    requestEvidence.agent.session.append('turn/start', { turn: 1 })
    requestEvidence.agent.session.append('step/start', { turn: 1, step: 1 })
    expect(recoverableClaimedInputs(sessionId, requestEvidence.agent.session.events)).toStrictEqual([])

    const canceled = await fresh()
    const canceledOriginal = await orphan(canceled, direct('input-canceled'))
    canceled.agent.inbox.append('next-turn', canceledOriginal)
    expect(canceled.agent.inbox.remove(canceledOriginal.id)).toBe(true)
    expect(recoverableClaimedInputs(sessionId, canceled.agent.session.events)).toStrictEqual([])
    expect(pendingIds(userEvidence.agent)).toStrictEqual([])
    expect(pendingIds(requestEvidence.agent)).toStrictEqual([])
    expect(pendingIds(canceled.agent)).toStrictEqual([])

    for (const variant of ['user', 'request', 'canceled'] as const) {
      const root = await mkdtemp(join(tmpdir(), `input-requeue-terminal-${variant}-`))
      roots.push(root)
      const inputId = `input-terminal-${variant}`
      await killAtCheckpoint(root, `seed-terminal-${variant}`)
      const cold = await mountManaged(root)
      await settle(cold.agent)
      expect(recoverableClaimedInputs(sessionId, cold.agent.session.events), variant).toStrictEqual([])
      expect(cold.agent.session.events.filter(event => event.type === 'agent/inbox/spliced'
        && event.data.inserted.some(message => String(message.id) === inputId)), variant).toHaveLength(2)
      expect(cold.agent.session.events.filter(event => event.type === 'agent/inbox/spliced'
        && event.data.inserted.some(message => message.source.kind === 'context-manager-input-requeue-wake')),
      variant).toHaveLength(0)
      expect(cold.adapter.rootRequests, variant).toHaveLength(0)
      expect(pendingIds(cold.agent), variant).toStrictEqual([])
    }
  })

  it('negative: real created and pre-step wiring keeps a cold persistence failure silent, then delegates once to the F07 owner', async () => {
    const first = await fresh()
    const original = await orphan(first, direct('input-deferred'))
    await dispose(first)

    let forcedFailures = 0
    const managed = await mountManaged(first.root, (ctx) => {
      const flush = ctx.sessions.flush.bind(ctx.sessions)
      ctx.sessions.flush = async session => {
        if (forcedFailures < 2) {
          forcedFailures += 1
          return false
        }
        return await flush(session)
      }
    })
    const errors: string[] = []
    managed.ctx.on('agent/error', ({ agent, error }) => {
      if (agent === managed.agent) errors.push(error instanceof Error ? error.message : String(error))
    })
    await settle(managed.agent)
    expect(forcedFailures).toBe(2)
    expect(pendingIds(managed.agent)).toStrictEqual([String(original.id)])
    expect(managed.adapter.requests).toHaveLength(0)
    expect(managed.agent.session.events.some(event => event.type === 'turn/start'
      || event.type === 'user/message')).toBe(false)
    expect(errors).toStrictEqual([])

    const next = direct('input-next-legal', '下一次合法 managed 输入')
    managed.agent.followup(next)
    await settle(managed.agent)
    expect(errors.filter(message => message === NO_FOCUS_TRANSACTION_FAILURE_TEXT)).toHaveLength(1)
    expect(requestsWith(managed.adapter, String(original.id))).toHaveLength(0)
    expect(managed.agent.session.events.filter(event => event.type === 'user/message'
      && String(event.data.id) === String(original.id))).toHaveLength(1)
    expect(managed.agent.session.events.filter(event => event.type === 'user/message'
      && event.data.source.kind === 'context-manager-input-requeue-wake')).toHaveLength(0)
  })
})
