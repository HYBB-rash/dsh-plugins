import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'
import AgentRegistry, { installModelSelection } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { CallId, createUserMessage, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { summarizeTurn } from '@deepseek-ai/dsh-telegram-gateway'
import { afterEach, describe, expect, it } from 'vitest'
import { type CandidateDescriptor, type ProjectionBudget } from '../src/fact-projection/index.ts'
import { createXFeedCronEnvironmentProvider } from '../src/index.ts'
import { FileNavigationSnapshotStore } from '../src/navigation/file-navigation-snapshot-store.ts'
import { XFeedbackStore } from '../src/store.ts'
import { createTrustedFact } from '../src/trusted-facts/model.ts'
import type { NavigationItem, NavigationSnapshot } from '../src/trusted-facts/navigation-contract.ts'
import { FileTrustedFactRepository } from '../src/x-feedback/trusted-fact-repository.ts'
import { SUBMIT_X_CRON_COMPOSER } from '../src/x-cron/composer-agent.ts'
import { SUBMIT_X_CRON_PLANNER } from '../src/x-cron/planner-agent.ts'
import { runWithExecFile, type PythonCommandRequest, type PythonCommandResult } from '../src/x-cron/python-ports.ts'

const MODEL_SELECTION = { provider: 'wire-test', model: 'wire-model' } as const
const PIPELINE_PATH = join(new URL('.', import.meta.url).pathname, '../python/x_insight_pipeline.py')
const CANDIDATE: CandidateDescriptor = {
  id: 'x-status:1',
  content: '当前候选正文',
  source: 'https://x.com/alice/status/1',
}
const BUDGET: ProjectionBudget = { maxInlineFacts: 2, maxLookupTickets: 2, maxSerializedBytes: 16_000 }
const LEGACY_MARKER = 'TODO7-B-LEGACY-MARKER-MUST-NOT-CROSS'
const FIRST_ROUND_MARKER = 'TODO7-B-FIRST-ROUND-MARKER'
const OLD_SESSION_MARKER = 'TODO7-B-OLD-SESSION-MARKER-MUST-NOT-CROSS'
const directories: string[] = []
const contexts: Context[] = []

type Scenario = {
  readonly directory: string
  readonly navigation: NavigationSnapshot
  readonly legacyLedgerPath: string
  readonly legacyLedgerHash: string
  readonly legacyNoiseSizes: Readonly<Record<string, number>>
  readonly legacyNoiseBytes: number
}

type RoundEvidence = {
  readonly plannerWires: readonly GenerateOptions[]
  readonly composerWires: readonly GenerateOptions[]
  readonly sessionId: string
  readonly sessionEvents: string
}

class InvarianceAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  readonly plannerRequests: GenerateOptions[] = []
  readonly composerRequests: GenerateOptions[] = []
  private readonly plannerSteps = new Map<string, number>()
  private readonly composerSteps = new Map<string, number>()

  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    if (/assessment Agent|run-tools|x_feed_prepare_delivery|x_feed_set_run_theme|一次性的 X 洞察投递 Agent/u.test(request.system ?? '')) {
      throw new Error('TODO7-B received a forbidden legacy cron model surface')
    }
    const sessionId = String(request.sessionId ?? '')
    const firstRound = JSON.stringify(request.messages).includes(FIRST_ROUND_MARKER)
    if (request.system?.includes('planner Agent') === true || request.tools?.some(tool => tool.name === SUBMIT_X_CRON_PLANNER) === true) {
      const step = (this.plannerSteps.get(sessionId) ?? 0) + 1
      this.plannerSteps.set(sessionId, step)
      if (step !== 1) throw new Error('TODO7-B planner wire called more than once')
      this.plannerRequests.push(request)
      yield* toolCall('planner-call', SUBMIT_X_CRON_PLANNER, {
        selectedCandidateIds: [CANDIDATE.id], themeId: 'agentic systems', exploration: { kind: 'none' },
      }, firstRound)
      return
    }
    if (request.system?.includes('composer Agent') === true || request.tools?.some(tool => tool.name === SUBMIT_X_CRON_COMPOSER) === true) {
      const step = (this.composerSteps.get(sessionId) ?? 0) + 1
      this.composerSteps.set(sessionId, step)
      if (step !== 1) throw new Error('TODO7-B composer wire called more than once')
      this.composerRequests.push(request)
      yield* toolCall('composer-call', SUBMIT_X_CRON_COMPOSER, {
        title: 'provider title',
        sections: [{ kind: 'highlight', items: [{ itemId: `item:${CANDIDATE.id}`, summary: CANDIDATE.content }] }],
      }, firstRound)
      return
    }
    throw new Error('TODO7-B received an unexpected model surface')
  }
}

describe('TODO7-B context invariance across bounded fact projection and fresh cron Agents', () => {
  afterEach(async () => {
    while (contexts.length > 0) await contexts.pop()?.fiber.dispose()
    await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
  })

  it('keeps planner/composer wire bytes invariant from 2 to 200 facts across fresh two-call rounds', async () => {
    const smallAdapter = new InvarianceAdapter()
    const largeAdapter = new InvarianceAdapter()
    const smallContext = await createHarness(smallAdapter)
    const largeContext = await createHarness(largeAdapter)
    const small = await createScenario(2)
    const large = await createScenario(200)
    const smallRounds = [await runRound(smallContext, small, smallAdapter, 'round-1'), await runRound(smallContext, small, smallAdapter, 'round-2')]
    const largeRounds = [await runRound(largeContext, large, largeAdapter, 'round-1'), await runRound(largeContext, large, largeAdapter, 'round-2')]

    expect(small.navigation.items).toHaveLength(2)
    expect(large.navigation.items).toHaveLength(200)
    expect(large.legacyNoiseSizes['legacy-x-preferences.md']).toBeGreaterThan(small.legacyNoiseSizes['legacy-x-preferences.md']!)
    expect(large.legacyNoiseSizes['x_interest_graph.json']).toBeGreaterThan(small.legacyNoiseSizes['x_interest_graph.json']!)
    expect(large.legacyNoiseSizes['x_raw_history.jsonl']).toBeGreaterThan(small.legacyNoiseSizes['x_raw_history.jsonl']!)
    expect(large.legacyNoiseBytes).toBeGreaterThan(small.legacyNoiseBytes)
    expect(smallAdapter.requests).toHaveLength(4)
    expect(largeAdapter.requests).toHaveLength(4)
    for (const adapter of [smallAdapter, largeAdapter]) {
      expect(adapter.plannerRequests).toHaveLength(2)
      expect(adapter.composerRequests).toHaveLength(2)
      expect(adapter.requests.some(request => /assessment Agent|run-tools|x_feed_prepare_delivery|x_feed_set_run_theme|一次性的 X 洞察投递 Agent/u.test(request.system ?? ''))).toBe(false)
    }
    for (let index = 0; index < 2; index += 1) {
      const smallRound = smallRounds[index]!
      const largeRound = largeRounds[index]!
      expect(smallRound.plannerWires).toHaveLength(1)
      expect(smallRound.composerWires).toHaveLength(1)
      expect(largeRound.plannerWires).toHaveLength(1)
      expect(largeRound.composerWires).toHaveLength(1)
      expect(normalizedWireBytes(largeRound.plannerWires[0]!)).toEqual(normalizedWireBytes(smallRound.plannerWires[0]!))
      expect(normalizedWireBytes(largeRound.composerWires[0]!)).toEqual(normalizedWireBytes(smallRound.composerWires[0]!))
      expect(smallRound.plannerWires[0]!.sessionId).not.toBe(smallRound.composerWires[0]!.sessionId)
      expect(largeRound.plannerWires[0]!.sessionId).not.toBe(largeRound.composerWires[0]!.sessionId)
      expect(JSON.stringify([...smallRound.plannerWires, ...smallRound.composerWires])).not.toContain(LEGACY_MARKER)
      expect(JSON.stringify([...largeRound.plannerWires, ...largeRound.composerWires])).not.toContain(LEGACY_MARKER)
    }
    expect(smallRounds[1]!.sessionId).not.toBe(smallRounds[0]!.sessionId)
    expect(largeRounds[1]!.sessionId).not.toBe(largeRounds[0]!.sessionId)
    for (const round of [smallRounds[1]!, largeRounds[1]!]) {
      const wire = JSON.stringify([...round.plannerWires, ...round.composerWires])
      expect(wire).not.toContain(FIRST_ROUND_MARKER)
      expect(wire).not.toContain(OLD_SESSION_MARKER)
    }
    expect(smallRounds[0]!.sessionEvents).toContain(FIRST_ROUND_MARKER)
    expect(smallRounds[1]!.sessionEvents).not.toContain(FIRST_ROUND_MARKER)
    expect(largeRounds[0]!.sessionEvents).toContain(FIRST_ROUND_MARKER)
    expect(largeRounds[1]!.sessionEvents).not.toContain(FIRST_ROUND_MARKER)
    expect(new XFeedbackStore(small.directory).readAll().some(event => event.note === LEGACY_MARKER)).toBe(true)
    expect(new XFeedbackStore(large.directory).readAll().some(event => event.note === LEGACY_MARKER)).toBe(true)
    expect(sha256(await readFile(small.legacyLedgerPath))).toBe(small.legacyLedgerHash)
    expect(sha256(await readFile(large.legacyLedgerPath))).toBe(large.legacyLedgerHash)
  })
})

async function createScenario(factCount: number): Promise<Scenario> {
  const directory = await mkdtemp(join(tmpdir(), `dsh-x-feed-todo7-b-${factCount}-`))
  directories.push(directory)
  seedLegacyFiles(directory, factCount === 2 ? 1 : 100)
  const repository = new FileTrustedFactRepository(directory)
  for (let index = 0; index < factCount; index += 1) {
    const relevant = index < 2
    const targetId = relevant ? CANDIDATE.id : `target:unrelated-${index}`
    const source = relevant ? CANDIDATE.source : `https://x.com/noise/status/${index + 10}`
    const result = createTrustedFact({
      target: { id: targetId, content: relevant ? `真正相关事实 ${index + 1}` : `显式无关事实 ${index + 1}`, source, scope: 'this candidate' },
      dimension: index === 1 ? 'argument_quality' : 'content_value',
      reason: relevant ? `当前候选的明确事实依据 ${index + 1}` : `noise fact ${index + 1}`,
      evidence: { kind: 'user_direct', rawUserExpression: relevant ? `记住相关事实 ${index + 1}` : `ignore ${index + 1}` },
    })
    if (!result.ok) throw new Error(result.message)
    expect(repository.append(result.fact)).toMatchObject({ ok: true })
  }
  const factSnapshot = repository.readLocatedSnapshot()
  const items: NavigationItem[] = factSnapshot.facts.map((located, index) => ({
    schemaVersion: 1,
    kind: 'trusted-fact-navigation',
    origin: 'machine-derived',
    derivation: { method: 'todo7-b', version: '1' },
    locator: located.locator,
    hints: {
      topics: [index < 2 ? 'current-candidate' : `irrelevant-topic-${index}`],
      targetRefs: [{ targetId: located.fact.target.id, canonicalSource: located.fact.target.source }],
      dimension: located.fact.dimension,
      relations: [{ kind: 'about-target', targetId: located.fact.target.id }],
    },
  }))
  const navigation: NavigationSnapshot = { schemaVersion: 1, sourceRevision: factSnapshot.sourceRevision, items }
  new FileNavigationSnapshotStore(directory).replace(navigation)
  const ledger = Buffer.from(readFileSync(join(directory, 'feedback.jsonl')))
  const legacyNoiseSizes = readLegacyNoiseSizes(directory)
  return {
    directory, navigation, legacyLedgerPath: join(directory, 'feedback.jsonl'), legacyLedgerHash: sha256(ledger),
    legacyNoiseSizes, legacyNoiseBytes: Object.values(legacyNoiseSizes).reduce((total, size) => total + size, 0),
  }
}

async function runRound(context: Context, scenario: Scenario, adapter: InvarianceAdapter, label: string): Promise<RoundEvidence> {
  seedCronPackage(scenario.directory)
  const beforePlanner = adapter.plannerRequests.length
  const beforeComposer = adapter.composerRequests.length
  const pythonCalls: PythonCommandRequest[] = []
  const provider = createXFeedCronEnvironmentProvider({
    ctx: context, cronJobId: 'cron-x-todo7-b', dataDir: scenario.directory, pythonBin: 'python3', pipelinePath: PIPELINE_PATH,
    run: async (request: PythonCommandRequest): Promise<PythonCommandResult> => {
      pythonCalls.push(request)
      if (request.args.includes('prepare-delivery')) return runWithExecFile(request)
      return { stdout: '{"ok":true}\n', stderr: '', exitCode: 0 }
    },
    readFile: async path => readFile(path, 'utf8'), projectionBudget: BUDGET,
  })
  const lease = await provider.prepare({ jobId: 'cron-x-todo7-b', runId: `cron-x-todo7-b@${label}`, jobKind: 'agent', sessionMode: 'per_run', gate: 'forbidden' })
  const sessionId = SessionId(`session-todo7-b-${label}`)
  const handle = await context.agents.create({
    sessionId, agentOptions: MODEL_SELECTION,
    setup: agentContext => { installModelSelection(agentContext, { current: MODEL_SELECTION, assembled: undefined }); lease.setupAgent(agentContext) },
  })
  try {
    await lease.verifySurface(handle.agent)
    const firstSeq = handle.agent.session.seq
    const text = label.endsWith('round-1') ? `执行当前 X run ${FIRST_ROUND_MARKER} ${OLD_SESSION_MARKER}` : '执行当前 X run'
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: 'dsh-cron' } }))
    await handle.agent.whenIdle()
    const outcome = summarizeTurn(handle.agent.session.events, firstSeq)
    const finalized = await lease.finalizeOutcome?.(outcome) as { readonly text: string; readonly error: string | undefined } | undefined
    expect(outcome.error).toBeUndefined()
    expect(outcome.text).toContain('provider title')
    expect(finalized?.error).toBeUndefined()
    expect(pythonCalls.filter(request => request.args.includes('prepare-delivery'))).toHaveLength(1)
    return {
      plannerWires: adapter.plannerRequests.slice(beforePlanner), composerWires: adapter.composerRequests.slice(beforeComposer),
      sessionId: String(sessionId), sessionEvents: JSON.stringify(handle.agent.session.events),
    }
  } finally {
    await handle.dispose()
    await lease.dispose()
  }
}

function seedLegacyFiles(directory: string, noiseMultiplier: number): void {
  writeFileSync(join(directory, 'feedback.jsonl'), `${JSON.stringify({ schemaVersion: 1, id: 'legacy-rating', createdAt: '2026-08-20T00:00:00.000Z', operation: 'dislike', canonicalUrl: CANDIDATE.source, note: LEGACY_MARKER })}\n`)
  const noise = LEGACY_MARKER.repeat(noiseMultiplier)
  writeFileSync(join(directory, 'legacy-x-preferences.md'), noise)
  writeFileSync(join(directory, 'x_interest_graph.json'), JSON.stringify({ marker: noise }))
  writeFileSync(join(directory, 'x_raw_history.jsonl'), `${noise}\n`)
  seedCronPackage(directory)
}

function seedCronPackage(directory: string): void {
  writeFileSync(join(directory, 'x_insight_package.json'), JSON.stringify({
    allowed_topics: ['agentic systems'], recent_items: [{ id: '1', url: CANDIDATE.source, text: CANDIDATE.content, topics: ['agentic systems'] }],
    selected_urls: [CANDIDATE.source], decision: { top_theme: 'agentic systems' }, feedback_context: LEGACY_MARKER.repeat(20),
    preferences: { marker: LEGACY_MARKER }, graph: { marker: LEGACY_MARKER }, raw_history: [LEGACY_MARKER],
  }))
}

function readLegacyNoiseSizes(directory: string): Readonly<Record<string, number>> {
  const names = ['legacy-x-preferences.md', 'x_interest_graph.json', 'x_raw_history.jsonl'] as const
  return Object.freeze(Object.fromEntries(names.map(name => [name, readFileSync(join(directory, name)).byteLength])))
}

async function createHarness(adapter: InvarianceAdapter): Promise<Context> {
  const context = new Context()
  await context.plugin(LlmRuntime); await context.plugin(SessionStore); await context.plugin(SystemPrompt); await context.plugin(ToolRuntime)
  await context.plugin(AgentRegistry); await context.plugin(AgentDefaultModelConfig, MODEL_SELECTION); await context.plugin(AgentLoop, { agents: [] })
  context.llm.registerAdapter(['wire-test'], adapter); contexts.push(context); return context
}

function toolCall(id: string, name: string, value: unknown, withReasoning: boolean): StreamChunk[] {
  const callId = CallId(id); const argumentsText = JSON.stringify(value); const blocks: StreamChunk[] = []
  if (withReasoning) {
    const marker = `${FIRST_ROUND_MARKER} ${OLD_SESSION_MARKER}`
    blocks.push({ type: 'block-start', index: 0, blockType: 'reasoning' }, { type: 'reasoning-delta', index: 0, text: marker }, { type: 'block-end', index: 0, block: { type: 'reasoning', text: marker } })
  }
  const index = withReasoning ? 1 : 0
  blocks.push({ type: 'block-start', index, blockType: 'tool-call' }, { type: 'tool-call-delta', index, id: callId, name, argumentsDelta: argumentsText }, { type: 'block-end', index, block: { type: 'tool-call', id: callId, name, arguments: argumentsText } }, { type: 'finish', reason: { kind: 'tool-calls' } })
  return blocks
}

function normalizedWireBytes(request: GenerateOptions): Buffer {
  return Buffer.from(JSON.stringify(normalizeWire(request)), 'utf8')
}

function normalizeWire(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeWire)
  if (value === null || typeof value !== 'object') return value
  const record = value as Record<string, unknown>; const output: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(record)) {
    if (key === 'sessionId' || key === 'messageId' || key === 'callId' || key === 'toolCallId') continue
    if (key === 'id' && (Object.hasOwn(record, 'role') || record.type === 'tool-call' || record.type === 'tool-result')) continue
    output[key] = normalizeWire(child)
  }
  return output
}

function sha256(value: Uint8Array): string { return createHash('sha256').update(value).digest('hex') }
