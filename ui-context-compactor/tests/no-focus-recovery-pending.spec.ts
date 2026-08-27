import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent, type SessionEventMap, type SessionEventType, type SurfaceEventType, type SurfaceIntent } from '@deepseek-ai/dsh-session'
import { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import * as commandCompact from '@deepseek-ai/dsh-command-compact'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import * as ContextManager from '../src/index.ts'
import { BoundFocusProposal } from '../src/focus.ts'
import { ManagedAwareBasicCompactionEngine } from '../src/managed-compaction.ts'
import { CanonicalContextAuthority, EffectiveStatePreservation } from '../src/state-transaction.ts'

const roots: string[] = []
const contexts: Context[] = []
const children: ChildProcess[] = []
const sessionId = ContextManager.FOCUS_CANARY_IDS[0]
const closeText = '这件事结束了'
const closedText = '唯一背景未能安全换入，本轮未继续行动'
const noticeText = '当前事项已结束。请告诉我接下来要开始哪件事。'
const canonicalText = '当前没有正在进行的事项。请询问用户想开始哪件事。'
const packageRoot = resolve(fileURLToPath(new URL('../', import.meta.url)))
const moduleRequire = createRequire(import.meta.url)
const contextManagerUrl = new URL('../src/index.ts', import.meta.url).href
const tsxImport = createRequire(moduleRequire.resolve('vitest')).resolve('tsx/esm')

afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null) { child.kill('SIGKILL'); await once(child, 'exit') }
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function chunks(text: string): StreamChunk[] {
  return [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'block-end', index: 0, block: { type: 'text', text } }, { type: 'finish', reason: { kind: 'stop' } }]
}
class Adapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  rootCalls = 0
  auxiliaryCalls = 0
  auxiliaryOutput = '{"kind":"focus","subject":"pending A","relation":"new"}'
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> { return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 8192 } }) }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (options.messages.some(message => message.source.kind === 'plugin' && message.source.plugin === 'ui-context-compactor:focus-canary-schema')) { this.auxiliaryCalls += 1; yield* chunks(this.auxiliaryOutput); return }
    this.rootCalls += 1
    if (options.messages.length === 2 && options.messages[0]?.source.kind === 'context-manager-canonical' && options.messages[1]?.source.kind === 'user') {
      yield* chunks('当前事项已结束，请告诉我下一件事')
      return
    }
    yield* chunks('unexpected root shape')
  }
}
interface DomainTable { get(key: string): unknown; put(key: string, value: unknown): Promise<void> }
interface Domain { table(name: string): DomainTable }
interface Harness { readonly ctx: Context; readonly agent: Agent; readonly adapter: Adapter; readonly domain: Domain; readonly timeline: string[] }
function isDomain(value: unknown): value is Domain { return value !== null && typeof value === 'object' && !Array.isArray(value) && typeof Reflect.get(value, 'table') === 'function' }
function isStorageDomainFacility(value: unknown): value is { open(spec: unknown): Promise<unknown> } { return value !== null && typeof value === 'object' && !Array.isArray(value) && typeof Reflect.get(value, 'open') === 'function' }
async function mount(root: string, resume = false, before?: (ctx: Context, domain: Domain) => void): Promise<Harness> {
  const ctx = new Context(); contexts.push(ctx); await mountAgentLoopTestDependencies(ctx)
  await mkdir(join(root, 'storages'), { recursive: true }); await ctx.plugin(Storage); await ctx.plugin(StorageSqlite, { path: join(root, 'storages', 'context-manager-focus-canary.sqlite') }); await ctx.plugin(StorageDomain, { backend: 'sqlite' }); await ctx.plugin(TokenMeter); await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' }); await ctx.plugin(CommandRuntime)
  await ctx.plugin(ManagedAwareBasicCompactionEngine, { auto: true, thresholdRatio: 0.99, retainRatio: 0.1, managedRuntime: { mode: 'enforce', safeUpdateMarginTokens: 64, allowlist: [...ContextManager.FOCUS_CANARY_IDS] } }); await ctx.plugin(commandCompact)
  const adapter = new Adapter(); ctx.llm.registerAdapter(['pending-test'], adapter)
  let openedDomain: Domain | undefined; const storageDomain = ctx.get('storageDomain'); if (!isStorageDomainFacility(storageDomain)) throw new Error('missing storage domain facility'); const open = storageDomain.open.bind(storageDomain); storageDomain.open = async spec => { const opened = await open(spec); if (!isDomain(opened)) throw new Error('storage domain returned an invalid domain'); openedDomain = opened; return opened }
  await ctx.plugin(ContextManager, { focusCanary: { mode: 'enforce', safeUpdateMarginTokens: 64, allowlist: [...ContextManager.FOCUS_CANARY_IDS], auxiliary: { provider: 'pending-test', model: 'pending-test-model', maxOutputTokens: 64, timeoutMs: 500, maxExpressionChars: 240, maxProjectionTokens: 1024, safetyMarginTokens: 128 } }, nativeWriterArbitration: { mode: 'enforce' } }); await ctx.plugin(AgentLoop, { agents: [] })
  const timeline: string[] = []
  const flush = ctx.sessions.flush.bind(ctx.sessions)
  ctx.sessions.flush = async session => { const flushed = await flush(session); timeline.push(`flush:${String(flushed)}`); return flushed }
  const readFrom = ctx.sessionPersistence.readFrom.bind(ctx.sessionPersistence)
  ctx.sessionPersistence.readFrom = async (id, fromSeq) => { const detached = await readFrom(id, fromSeq); timeline.push(`readFrom:${String(fromSeq)}`); return detached }
  ctx.on('agent/error', ({ error }) => { timeline.push(`error:${error instanceof Error ? error.message : String(error)}`) })
  if (openedDomain === undefined) throw new Error('missing domain'); before?.(ctx, openedDomain)
  const agent = resume ? (await ctx.agents.resume({ resumeSessionId: SessionId(sessionId), agentOptions: { provider: 'pending-test', model: 'pending-test-model' } })).agent : ctx.agentLoop.create(SessionId(sessionId), { provider: 'pending-test', model: 'pending-test-model' })
  return { ctx, agent, adapter, domain: openedDomain, timeline }
}
async function send(agent: Agent, text: string): Promise<UserMessage> { const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }); agent.send(message, 'next-turn', true); await agent.whenIdle(); return message }
type ObjectRecord = Record<string, unknown>
function object(value: unknown, label: string): ObjectRecord { if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`expected ${label} object`); const copy: ObjectRecord = Object.create(Object.getPrototypeOf(value)); return Object.assign(copy, value) }
function field(value: unknown, key: string, label: string): ObjectRecord { return object(object(value, label)[key], `${label}.${key}`) }
function phase(value: unknown): string | undefined { const transaction = object(value, 'stored row').transaction; if (transaction === null || typeof transaction !== 'object' || Array.isArray(transaction)) return undefined; const candidate = object(transaction, 'transaction').phase; return typeof candidate === 'string' ? candidate : undefined }
function recordJson(root: string): string { const db = new DatabaseSync(join(root, 'storages', 'context-manager-focus-canary.sqlite'), { readOnly: true }); try { const row = db.prepare('SELECT value FROM "u_context_manager_focus_precanonical" WHERE key = ?').get(sessionId); if (row === undefined) throw new Error('missing pending record'); const value = object(row, 'database row').value; if (typeof value !== 'string') throw new Error('stored record value is not text'); return value } finally { db.close() } }
function record(root: string): ObjectRecord { const parsed: unknown = JSON.parse(recordJson(root)); return object(parsed, 'stored row') }
function mutate(root: string, f: (row: ObjectRecord) => ObjectRecord): void { const db = new DatabaseSync(join(root, 'storages', 'context-manager-focus-canary.sqlite')); try { db.prepare('UPDATE "u_context_manager_focus_precanonical" SET value = ? WHERE key = ?').run(JSON.stringify(f(record(root))), sessionId) } finally { db.close() } }
function canonical(agent: Agent): SessionEvent<'user/message'>[] { return agent.session.events.filter((event): event is SessionEvent<'user/message'> => event.type === 'user/message' && event.data.source.kind === 'context-manager-canonical') }
function canonicalFromSession(session: Agent['session']): SessionEvent<'user/message'>[] { return session.events.filter((event): event is SessionEvent<'user/message'> => event.type === 'user/message' && event.data.source.kind === 'context-manager-canonical') }
function canonicalPhase(event: SessionEvent<'user/message'>): 'current' | 'finalized' { if (event.data.source.kind !== 'context-manager-canonical') throw new Error('expected canonical source'); return event.data.source.phase }
function canonicalGeneration(event: SessionEvent<'user/message'>): number { if (event.data.source.kind !== 'context-manager-canonical') throw new Error('expected canonical source'); return event.data.source.generation }
function isFinalizedCanonical(value: unknown): boolean { if (value === null || typeof value !== 'object' || Array.isArray(value)) return false; const source = object(value, 'message').source; return source !== null && typeof source === 'object' && !Array.isArray(source) && object(source, 'message source').kind === 'context-manager-canonical' && object(source, 'message source').phase === 'finalized' }
type PublicationFault = 'flush-false' | 'read-throw' | 'wrong-seq' | 'wrong-id' | 'wrong-source' | 'wrong-text' | 'wrong-body-hash'
function corruptPublicationRead(
  events: readonly SessionEvent[], fault: Exclude<PublicationFault, 'flush-false' | 'read-throw'>,
): SessionEvent[] {
  const target = events.find((event): event is SessionEvent<'user/message'> => event.type === 'user/message' && event.data.source.kind === 'context-manager-canonical' && event.data.source.phase === 'finalized')
  const other = events.find((event): event is SessionEvent<'user/message'> => event.type === 'user/message' && event !== target)
  const current = events.find((event): event is SessionEvent<'user/message'> => event.type === 'user/message' && event.data.source.kind === 'context-manager-canonical' && event.data.source.phase === 'current')
  if (target === undefined || other === undefined || current === undefined) throw new Error('missing publication corruption evidence')
  return events.map(event => {
    if (event !== target) return event
    if (fault === 'wrong-seq') return { ...event, seq: event.seq + 10_000 }
    if (fault === 'wrong-id') return { ...event, data: { ...event.data, id: other.data.id } }
    if (fault === 'wrong-source') return { ...event, data: { ...event.data, source: current.data.source } }
    if (fault === 'wrong-text') return { ...event, data: { ...event.data, content: other.data.content } }
    return { ...event, data: { ...event.data, source: { ...event.data.source, bodyHash: '0'.repeat(64) } } }
  })
}
function direct(agent: Agent, id?: UserMessage['id']): SessionEvent<'user/message'>[] { return agent.session.events.filter((event): event is SessionEvent<'user/message'> => event.type === 'user/message' && event.data.source.kind === 'user' && (id === undefined || String(event.data.id) === String(id))) }
function assistantTexts(agent: Agent): string[] { return agent.session.events.flatMap(event => event.type === 'assistant/message' ? event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []) : []) }
interface WorkCounts { readonly root: number; readonly auxiliary: number; readonly tools: number; readonly compaction: number; readonly checkpoints: number; readonly routes: number }
function workCounts(h: Harness): WorkCounts { return { root: h.adapter.rootCalls, auxiliary: h.adapter.auxiliaryCalls, tools: h.agent.session.events.filter(event => event.type.startsWith('tool/')).length, compaction: h.agent.session.events.filter(event => event.type.startsWith('compaction/')).length, checkpoints: h.agent.session.events.filter(event => event.type === 'user/message' && isCompactCheckpointSource(event.data.source)).length, routes: h.agent.session.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'plugin' && event.data.source.plugin === 'context-route').length } }
function directText(event: SessionEvent<'user/message'>): string | undefined { const texts = event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []); return texts.length === 1 ? texts[0] : undefined }
function directHash(event: SessionEvent<'user/message'>): string { return createHash('sha256').update(String(event.data.id)).update('\0').update(directText(event) ?? '').digest('hex') }
async function sessionFiles(root: string, relative = ''): Promise<readonly { readonly path: string; readonly bytes: string }[]> {
  const directory = join(root, 'sessions', relative)
  const entries = await readdir(directory, { withFileTypes: true })
  const snapshots: { path: string; bytes: string }[] = []
  for (const entry of entries) {
    const path = join(relative, entry.name)
    if (entry.isDirectory()) snapshots.push(...await sessionFiles(root, path))
    else snapshots.push({ path, bytes: (await readFile(join(root, 'sessions', path))).toString('hex') })
  }
  return snapshots.sort((left, right) => left.path.localeCompare(right.path))
}
async function assertReadyContinuation(h: Harness): Promise<void> {
  const baseline = workCounts(h); const assistantBaseline = assistantTexts(h.agent).length; const continued = await send(h.agent, '继续')
  expect(h.adapter.rootCalls).toBe(baseline.root + 1); expect(h.adapter.auxiliaryCalls).toBe(baseline.auxiliary)
  const request = h.adapter.requests.at(-1); if (request === undefined) throw new Error('missing continuation request')
  expect(request.messages).toHaveLength(2); const [stored, directMessage] = request.messages
  const finalized = canonical(h.agent).filter(event => canonicalPhase(event) === 'finalized'); expect(finalized).toHaveLength(1)
  expect(stored).toEqual(finalized[0]?.data); expect(stored?.content).toEqual([{ type: 'text', text: canonicalText }])
  expect(directMessage?.id).toBe(continued.id); expect(directMessage?.source.kind).toBe('user'); expect(directMessage?.content).toEqual([{ type: 'text', text: '继续' }])
  const requestedTexts = request.messages.flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []))
  expect(request.messages.some(message => { const role = object(message, 'request message').role; return role === 'assistant' || role === 'tool' })).toBe(false)
  expect(request.messages.some(message => message.source.kind === 'plugin' && message.source.plugin === 'context-route')).toBe(false)
  expect(request.messages.some(message => message.source.kind === 'plugin' && message.source.plugin === 'ui-context-compactor:focus-canary-advice')).toBe(false)
  expect(request.messages.some(message => message.source.kind === 'plugin')).toBe(false)
  expect(request.messages.some(message => isCompactCheckpointSource(message.source))).toBe(false)
  expect(requestedTexts.filter(text => text === 'child A' || text === closeText || text === noticeText)).toHaveLength(0)
  expect(direct(h.agent, continued.id)).toHaveLength(1)
  expect(assistantTexts(h.agent).slice(assistantBaseline)).toEqual(['当前事项已结束，请告诉我下一件事'])
  const after = workCounts(h); expect(after.tools).toBe(baseline.tools); expect(after.compaction).toBe(baseline.compaction); expect(after.checkpoints).toBe(baseline.checkpoints); expect(after.routes).toBe(baseline.routes)
}
function pendingChildProgram(): string { return `
import { Context } from '@deepseek-ai/cordis'; import AgentLoop from '@deepseek-ai/dsh-agent-loop'; import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'; import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'; import { SessionId } from '@deepseek-ai/dsh-session'; import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'; import Storage from '@deepseek-ai/dsh-storage'; import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'; import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'; import TokenMeter from '@deepseek-ai/dsh-token-meter'; import CommandRuntime from '@deepseek-ai/dsh-commands'; import * as commandCompact from '@deepseek-ai/dsh-command-compact'
const root=process.env.PENDING_CHILD_ROOT, managerUrl=process.env.PENDING_CHILD_MANAGER_URL, cwd=process.env.PENDING_CHILD_CWD
if(typeof root!=='string'||typeof managerUrl!=='string'||typeof cwd!=='string'||process.cwd()!==cwd) throw new Error('pending child environment')
const ContextManager=await import(managerUrl); const chunks=text=>[{type:'block-start',index:0,blockType:'text'},{type:'block-end',index:0,block:{type:'text',text}},{type:'finish',reason:{kind:'stop'}}]
const compactionUrl=process.env.PENDING_CHILD_COMPACTION_URL; if(typeof compactionUrl!=='string') throw new Error('missing compaction url'); const { ManagedAwareBasicCompactionEngine }=await import(compactionUrl)
class Adapter extends LlmAdapter { calls=0; async resolveModel(provider,model){return {provider,id:model,name:model,context:{contextWindow:8192}}}; async *stream(options){if(options.messages.some(message=>message.source.kind==='plugin'&&message.source.plugin==='ui-context-compactor:focus-canary-schema')){this.calls++;yield* chunks(this.calls===1?'{"kind":"focus","subject":"child A","relation":"new"}':'{"kind":"close","relation":"current"}');return}yield* chunks('child root receipt')} }
const mode=process.env.PENDING_CHILD_MODE; if(mode!=='pending'&&mode!=='first-replace')throw new Error('invalid child mode'); const ctx=new Context(); await mountAgentLoopTestDependencies(ctx); await (await import('node:fs/promises')).mkdir(root+'/storages',{recursive:true}); await ctx.plugin(Storage);await ctx.plugin(StorageSqlite,{path:root+'/storages/context-manager-focus-canary.sqlite'});await ctx.plugin(StorageDomain,{backend:'sqlite'});await ctx.plugin(TokenMeter);await ctx.plugin(JsonlSessionPersistence,{root:root+'/sessions',compression:'none'});await ctx.plugin(CommandRuntime);await ctx.plugin(ManagedAwareBasicCompactionEngine,{auto:true,thresholdRatio:.99,retainRatio:.1,managedRuntime:{mode:'enforce',safeUpdateMarginTokens:64,allowlist:[...ContextManager.FOCUS_CANARY_IDS]}});await ctx.plugin(commandCompact);ctx.llm.registerAdapter(['pending-test'],new Adapter());let domain;const facility=ctx.get('storageDomain');const open=facility.open.bind(facility);facility.open=async spec=>{domain=await open(spec);return domain};await ctx.plugin(ContextManager,{focusCanary:{mode:'enforce',safeUpdateMarginTokens:64,allowlist:[...ContextManager.FOCUS_CANARY_IDS],auxiliary:{provider:'pending-test',model:'pending-test-model',maxOutputTokens:64,timeoutMs:500,maxExpressionChars:240,maxProjectionTokens:1024,safetyMarginTokens:128}},nativeWriterArbitration:{mode:'enforce'}});await ctx.plugin(AgentLoop,{agents:[]});const table=domain.table('focus_precanonical'),put=table.put.bind(table);if(mode==='pending'){table.put=async(key,value)=>{await put(key,value);if(value?.transaction?.phase==='pending'){process.send?.({kind:'pending'});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0)}};const agent=ctx.agentLoop.create(SessionId(ContextManager.FOCUS_CANARY_IDS[0]),{provider:'pending-test',model:'pending-test-model'});const send=async text=>{const message=createUserMessage({content:[{type:'text',text}],source:{kind:'user'}});agent.send(message,'next-turn',true);await agent.whenIdle()};await send('帮我审这份方案');await send('这件事结束了')}else{ctx.on('agent/created',({agent})=>{const append=agent.session.append;let stopped=false;agent.session.append=function(type,data,...options){const surface=options[0]?.surfaceOp;if(!stopped&&typeof surface==='object'&&surface!==null&&surface.op==='replace'){stopped=true;process.send?.({kind:'first-replace'});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0)}return Reflect.apply(append,this,[type,data,...options])}});const agent=(await ctx.agents.resume({resumeSessionId:SessionId(ContextManager.FOCUS_CANARY_IDS[0]),agentOptions:{provider:'pending-test',model:'pending-test-model'}})).agent;await agent.whenIdle()}
` }
async function killAtChildCheckpoint(root: string, mode: 'pending' | 'first-replace'): Promise<void> {
  const child = spawn(process.execPath, ['--import', tsxImport, '--eval', pendingChildProgram()], { cwd: packageRoot, env: { ...process.env, PENDING_CHILD_MODE: mode, PENDING_CHILD_ROOT: root, PENDING_CHILD_MANAGER_URL: contextManagerUrl, PENDING_CHILD_CWD: packageRoot, PENDING_CHILD_COMPACTION_URL: new URL('../src/managed-compaction.ts', import.meta.url).href }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }); children.push(child)
  await new Promise<void>((resolveCheckpoint, reject) => { let stderr=''; const timer=setTimeout(()=>reject(new Error(`${mode} child checkpoint timeout`)),10_000); child.stderr?.on('data', chunk=>{stderr+=String(chunk)}); child.once('message', message=>{clearTimeout(timer); if(message!==null&&typeof message==='object'&&'kind' in message&&message.kind===(mode==='pending'?'pending':'first-replace')) resolveCheckpoint(); else reject(new Error(`${mode} child checkpoint mismatch`))}); child.once('exit', code=>{clearTimeout(timer);reject(new Error(`${mode} child exited ${String(code)}: ${stderr}`))}); child.once('error',reject) })
  child.kill('SIGKILL'); await once(child,'exit'); children.splice(children.indexOf(child),1); expect(phase(record(root))).toBe('pending')
}
async function pendingRoot(root: string): Promise<void> { await killAtChildCheckpoint(root, 'pending') }
function noAction(h: Harness): void { expect(h.adapter.rootCalls).toBe(0); expect(h.adapter.auxiliaryCalls).toBe(0); expect(h.agent.session.events.filter(event => event.type.startsWith('tool/'))).toHaveLength(0); expect(h.agent.session.events.filter(event => event.type.startsWith('compaction/'))).toHaveLength(0); expect(h.agent.session.events.filter(event => event.type === 'user/message' && isCompactCheckpointSource(event.data.source))).toHaveLength(0) }
async function withoutRecoveryResigning<Result>(action: () => Promise<Result>): Promise<Result> {
  const originalC01 = BoundFocusProposal.prototype.decideFocus
  const originalC06 = EffectiveStatePreservation.prototype.acceptFocusFactToPreserve
  const originalC29 = EffectiveStatePreservation.prototype.checkPreservationEligibility
  const originalC07 = CanonicalContextAuthority.prototype.acceptCurrentFocus
  const calls = { c01: 0, c06: 0, c07: 0, c29: 0 }
  BoundFocusProposal.prototype.decideFocus = function guardedC01(expression) { calls.c01 += 1; return originalC01.call(this, expression) }
  EffectiveStatePreservation.prototype.acceptFocusFactToPreserve = function guardedC06(focus) { calls.c06 += 1; return originalC06.call(this, focus) }
  EffectiveStatePreservation.prototype.checkPreservationEligibility = function guardedC29(state) { calls.c29 += 1; return originalC29.call(this, state) }
  CanonicalContextAuthority.prototype.acceptCurrentFocus = function guardedC07(focus) { calls.c07 += 1; return originalC07.call(this, focus) }
  try { const result = await action(); expect(calls).toEqual({ c01: 0, c06: 0, c07: 0, c29: 0 }); return result } finally {
    BoundFocusProposal.prototype.decideFocus = originalC01
    EffectiveStatePreservation.prototype.acceptFocusFactToPreserve = originalC06
    EffectiveStatePreservation.prototype.checkPreservationEligibility = originalC29
    CanonicalContextAuthority.prototype.acceptCurrentFocus = originalC07
  }
}
function assertStoredReportsUnchanged(before: ObjectRecord, after: ObjectRecord): void {
  const beforeTransaction = field(before, 'transaction', 'before row'); const afterTransaction = field(after, 'transaction', 'after row')
  expect(afterTransaction.generation).toBe(beforeTransaction.generation)
  for (const key of ['c06', 'c07', 'c29']) {
    expect(afterTransaction[key]).toEqual(beforeTransaction[key])
    expect(field(afterTransaction[key], 'identity', `after ${key}`).call).toBe(field(beforeTransaction[key], 'identity', `before ${key}`).call)
  }
}
async function assertClosed(h: Harness, errors: unknown[] = []): Promise<void> {
  if (errors.length === 0) h.ctx.on('agent/error', ({ error }) => errors.push(error))
  const baseline = workCounts(h); const priorErrors = errors.length; const timelineStart = h.timeline.length
  const continued = await send(h.agent, '继续')
  const liveMatches = direct(h.agent, continued.id); expect(liveMatches).toHaveLength(1)
  const live = liveMatches[0]; if (live === undefined) throw new Error('missing live direct continuation')
  expect(live.data.source.kind).toBe('user'); expect(directText(live)).toBe('继续')
  const turnTimeline = h.timeline.slice(timelineStart)
  const closedError = `error:${closedText}`; const lastClosedError = turnTimeline.lastIndexOf(closedError)
  const flushed = turnTimeline.findIndex(entry => entry === 'flush:true')
  const read = turnTimeline.findIndex((entry, index) => index > flushed && entry.startsWith('readFrom:'))
  expect(flushed).toBeGreaterThanOrEqual(0); expect(read).toBeGreaterThan(flushed); expect(lastClosedError).toBeGreaterThan(read)
  expect(turnTimeline.filter(entry => entry.startsWith('error:'))).toEqual([closedError])
  const detached = await h.ctx.sessionPersistence.readFrom(SessionId(sessionId), 0)
  const persistedMatches = detached.events.filter((event): event is SessionEvent<'user/message'> => event.type === 'user/message' && String(event.data.id) === String(continued.id))
  expect(persistedMatches).toHaveLength(1)
  const persisted = persistedMatches[0]; if (persisted === undefined) throw new Error('missing detached direct continuation')
  expect(persisted.seq).toBe(live.seq); expect(String(persisted.data.id)).toBe(String(live.data.id)); expect(persisted.data.source).toEqual(live.data.source)
  expect(directText(persisted)).toBe('继续'); expect(directHash(persisted)).toBe(directHash(live))
  expect([...new Set(errors.slice(priorErrors).map(error => error instanceof Error ? error.message : String(error)))]).toEqual([closedText])
  expect(workCounts(h)).toEqual(baseline); noAction(h)
}

describe('H1R-P clean pending cold recovery', () => {
  it('positive: durable natural pending replays exact stored reports then one ordinary continuation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pending-positive-')); roots.push(root); await pendingRoot(root); const before = record(root)
    const h = await withoutRecoveryResigning(async () => { const mounted = await mount(root, true); await mounted.agent.whenIdle(); return mounted })
    const after = record(root); expect(phase(after)).toBe('finalized'); assertStoredReportsUnchanged(before, after); expect(canonical(h.agent)).toHaveLength(2); noAction(h)
    await assertReadyContinuation(h); assertStoredReportsUnchanged(before, record(root))
  })
  it('positive: a second cold replay is killed by child IPC before first replace, then the next cold replay finalizes once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pending-restart-')); roots.push(root)
    await pendingRoot(root); const pending = record(root)
    await killAtChildCheckpoint(root, 'first-replace')
    expect(phase(record(root))).toBe('pending')
    const resumed = await withoutRecoveryResigning(async () => { const mounted = await mount(root, true); await mounted.agent.whenIdle(); return mounted })
    const ids = canonical(resumed.agent).map(event => String(event.data.id))
    expect(new Set(ids).size).toBe(ids.length)
    expect(phase(record(root))).toBe('finalized')
    assertStoredReportsUnchanged(pending, record(root))
    await assertReadyContinuation(resumed)
    assertStoredReportsUnchanged(pending, record(root))
  })
  it('negative: current or finalized same-generation canonical trace closes', async () => {
    for (const tracePhase of ['current', 'finalized'] as const) { const root = await mkdtemp(join(tmpdir(), `pending-trace-${tracePhase}-`)); roots.push(root); await pendingRoot(root); const pending = record(root); const first = await mount(root, true, tracePhase === 'current' ? (_ctx, domain) => { const table=domain.table('focus_precanonical'); const put=table.put.bind(table); table.put=async(key,value)=>{if(phase(value)==='current') throw new Error('natural current sidecar crash'); await put(key,value)} } : undefined); await first.agent.whenIdle(); await first.ctx.sessions.flush(first.agent.session); if (tracePhase === 'finalized') mutate(root, row => ({ ...row, transaction: pending.transaction })); await first.ctx.fiber.dispose(); contexts.splice(contexts.indexOf(first.ctx), 1); const seen: unknown[]=[]; const h=await mount(root,true,ctx=>ctx.on('agent/error',({error})=>seen.push(error))); await h.agent.whenIdle(); await assertClosed(h,seen); expect(record(root).transaction).toEqual(pending.transaction) }
  })
  it('negative: durable current sidecar followed by a second-replace receiver fault closes only on the next cold Context', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pending-current-window-')); roots.push(root); await pendingRoot(root)
    const first = await mount(root, true, ctx => {
      ctx.on('agent/created', ({ agent }) => {
        const append = agent.session.append
        agent.session.append = function failSecondCanonicalReplace<T extends SessionEventType>(
          type: T, data: SessionEventMap[T], ...options: T extends SurfaceEventType ? [SurfaceIntent] : []
        ): SessionEvent<T> {
          const operation = options[0]?.surfaceOp
          if (type === 'user/message' && isFinalizedCanonical(data)
            && typeof operation === 'object' && operation !== null && operation.op === 'replace') {
            throw new Error('second canonical replace fault')
          }
          return Reflect.apply(append, this, [type, data, ...options])
        }
      })
    })
    await first.agent.whenIdle(); expect(phase(record(root))).toBe('current'); expect(canonical(first.agent)).toHaveLength(1)
    await first.ctx.sessions.flush(first.agent.session); await first.ctx.fiber.dispose(); contexts.splice(contexts.indexOf(first.ctx), 1)
    const errors: unknown[] = []; const cold = await mount(root, true, ctx => ctx.on('agent/error', ({ error }) => errors.push(error)))
    await cold.agent.whenIdle(); await assertClosed(cold, errors); expect(phase(record(root))).toBe('current')
  })
  it('negative: C06/C07/C29/material schema vetoes bytes; a schema-admissible private relation still closes', async () => {
    for (const key of ['c06', 'c07', 'c29', 'material'] as const) {
      const root = await mkdtemp(join(tmpdir(), `pending-schema-${key}-`)); roots.push(root); await pendingRoot(root)
      mutate(root, row => {
        const transaction = field(row, 'transaction', 'row')
        if (key === 'c06') {
          const report = field(transaction, 'c06', 'transaction'); const identity = field(report, 'identity', 'c06')
          return { ...row, transaction: { ...transaction, c06: { ...report, identity: { ...identity, subject: transaction.pendingRef } } } }
        }
        if (key === 'c07') {
          const report = field(transaction, 'c07', 'transaction'); const accepted = field(report, 'value', 'c07'); const focus = field(accepted, 'value', 'c07.value')
          return { ...row, transaction: { ...transaction, c07: { ...report, value: { ...accepted, value: { ...focus, ref: transaction.canonicalRef } } } } }
        }
        if (key === 'c29') {
          const report = field(transaction, 'c29', 'transaction'); const eligibility = field(report, 'value', 'c29')
          return { ...row, transaction: { ...transaction, c29: { ...report, value: { ...eligibility, state: transaction.canonicalRef } } } }
        }
        const material = field(transaction, 'material', 'transaction')
        return { ...row, transaction: { ...transaction, material: { ...material, target: transaction.pendingRef } } }
      })
      const bytes = recordJson(root); const files = await sessionFiles(root); let veto: unknown; let mounted: Harness | undefined
      try { mounted = await mount(root, true) } catch (error) { veto = error }
      expect(mounted).toBeUndefined()
      expect(veto instanceof Error ? veto.message : String(veto)).toContain('does not match its schema')
      expect(recordJson(root)).toBe(bytes); expect(await sessionFiles(root)).toEqual(files)
    }

    const root = await mkdtemp(join(tmpdir(), 'pending-private-relation-')); roots.push(root); await pendingRoot(root)
    mutate(root, row => {
      const transaction = field(row, 'transaction', 'row')
      const material = field(transaction, 'material', 'transaction')
      const canonicalState = field(material, 'canonicalState', 'material')
      return { ...row, transaction: { ...transaction, canonicalRef: 'canonical:forged', material: { ...material, canonicalState: { ...canonicalState, ref: 'canonical:forged' } } } }
    })
    const bytes = recordJson(root); const seen: unknown[] = []
    const h = await mount(root, true, ctx => ctx.on('agent/error', ({ error }) => seen.push(error)))
    await h.agent.whenIdle(); await assertClosed(h, seen)
    expect(recordJson(root)).toBe(bytes)
    expect(canonical(h.agent)).toHaveLength(0)
  })
  it('negative: C33, C30, first replace, and second replace receiver containment preserve one physical direct input then close', async () => {
    for (const fault of ['c33', 'c30', 'first-replace', 'second-replace'] as const) {
      const root = await mkdtemp(join(tmpdir(), `pending-receiver-${fault}-`)); roots.push(root); await pendingRoot(root); const original = record(root)
      const generation = field(original, 'transaction', 'original transaction').generation
      const originalC30 = EffectiveStatePreservation.prototype.establishRecoverablePreservation
      let c30Thrown = false
      if (fault === 'c30') {
        EffectiveStatePreservation.prototype.establishRecoverablePreservation = async function containedC30(state) {
          if (!c30Thrown) { c30Thrown = true; throw new Error('C30 receiver containment') }
          return await originalC30.call(this, state)
        }
      }
      const errors: unknown[] = []
      try {
        const h = await mount(root, true, (ctx, domain) => {
          ctx.on('agent/error', ({ error }) => errors.push(error))
          if (fault === 'c33') {
            const table = domain.table('focus_precanonical'); const put = table.put.bind(table)
            table.put = async (key, value) => { if (phase(value) === 'pending') throw new Error('C33 receiver containment'); await put(key, value) }
          }
          if (fault === 'first-replace' || fault === 'second-replace') ctx.on('agent/created', ({ agent }) => {
            const append = agent.session.append
            agent.session.append = function containedReplace<T extends SessionEventType>(
              type: T, data: SessionEventMap[T], ...options: T extends SurfaceEventType ? [SurfaceIntent] : []
            ): SessionEvent<T> {
              const operation = options[0]?.surfaceOp
              const first = type === 'user/message' && !isFinalizedCanonical(data)
              const second = type === 'user/message' && isFinalizedCanonical(data)
              if (typeof operation === 'object' && operation !== null && operation.op === 'replace'
                && (fault === 'first-replace' && first || fault === 'second-replace' && second)) throw new Error(`${fault} receiver containment`)
              return Reflect.apply(append, this, [type, data, ...options])
            }
          })
        })
        await h.agent.whenIdle()
        const window = record(root); expect(field(window, 'transaction', 'window transaction').generation).toBe(generation)
        const visible = canonical(h.agent)
        if (fault === 'second-replace') {
          expect(phase(window)).toBe('current'); expect(visible).toHaveLength(1); expect(visible[0] === undefined ? undefined : canonicalPhase(visible[0])).toBe('current'); expect(visible[0] === undefined ? undefined : canonicalGeneration(visible[0])).toBe(generation)
        } else {
          expect(phase(window)).toBe('pending'); expect(visible).toHaveLength(0)
        }
        expect(c30Thrown).toBe(fault === 'c30')
        await assertClosed(h, errors); expect(record(root)).toEqual(window)
        expect(h.adapter.rootCalls).toBe(0); expect(h.adapter.auxiliaryCalls).toBe(0)
        expect(h.agent.session.events.filter(event => event.type.startsWith('tool/') || event.type.startsWith('compaction/'))).toHaveLength(0)
      } finally { EffectiveStatePreservation.prototype.establishRecoverablePreservation = originalC30 }
    }
  })
  it('negative: seven finalized publication faults retain current, then a distinct cold Context closes', async () => {
    for (const fault of ['flush-false', 'read-throw', 'wrong-seq', 'wrong-id', 'wrong-source', 'wrong-text', 'wrong-body-hash'] as const) {
      const root = await mkdtemp(join(tmpdir(), `pending-publication-${fault}-`)); roots.push(root); await pendingRoot(root); const original = record(root)
      const generation = field(original, 'transaction', 'original transaction').generation
      let publicationFlushed = false
      const first = await mount(root, true, ctx => {
        const flush = ctx.sessions.flush.bind(ctx.sessions)
        ctx.sessions.flush = async session => {
          const hasFinalized = canonicalFromSession(session).some(event => event.data.source.kind === 'context-manager-canonical' && event.data.source.phase === 'finalized')
          if (!hasFinalized) return await flush(session)
          publicationFlushed = true
          return fault === 'flush-false' ? false : await flush(session)
        }
        if (fault !== 'flush-false') {
          const read = ctx.sessionPersistence.readFrom.bind(ctx.sessionPersistence)
          ctx.sessionPersistence.readFrom = async (id, fromSeq) => {
            if (publicationFlushed && fault === 'read-throw') throw new Error('publication detached-read fault')
            const detached = await read(id, fromSeq)
            if (!publicationFlushed || fault === 'read-throw') return detached
            return { ...detached, events: corruptPublicationRead(detached.events, fault) }
          }
        }
      })
      await first.agent.whenIdle()
      const failed = record(root); expect(phase(failed), fault).toBe('current'); expect(field(failed, 'transaction', 'failed transaction').generation).toBe(generation)
      const failedCanonical = canonical(first.agent); expect(failedCanonical).toHaveLength(2)
      expect(failedCanonical.map(canonicalPhase)).toEqual(['current', 'finalized'])
      expect(failedCanonical.map(canonicalGeneration)).toEqual([generation, generation])
      const preColdCanonical = failedCanonical.map(event => ({ seq: event.seq, id: String(event.data.id), phase: canonicalPhase(event), generation: canonicalGeneration(event) }))
      expect(new Set(preColdCanonical.map(event => event.id)).size).toBe(2)
      await first.ctx.fiber.dispose(); contexts.splice(contexts.indexOf(first.ctx), 1)
      const errors: unknown[] = []
      const cold = await mount(root, true, ctx => ctx.on('agent/error', ({ error }) => errors.push(error)))
      await cold.agent.whenIdle()
      expect(record(root)).toEqual(failed); expect(phase(record(root))).toBe('current')
      expect(canonical(cold.agent).map(event => ({ seq: event.seq, id: String(event.data.id), phase: canonicalPhase(event), generation: canonicalGeneration(event) }))).toEqual(preColdCanonical)
      await assertClosed(cold, errors); expect(record(root)).toEqual(failed)
    }
  })
})
