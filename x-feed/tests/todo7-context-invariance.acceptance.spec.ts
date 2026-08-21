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
import {
  createFactProjectionPreflight,
  type CandidateDescriptor,
  type LookupResult,
  type ProjectionBudget,
  type ProjectionView,
  type ReadyFactProjectionSession,
} from '../src/fact-projection/index.ts'
import { FileNavigationSnapshotStore } from '../src/navigation/file-navigation-snapshot-store.ts'
import { XFeedbackStore } from '../src/store.ts'
import { createTrustedFact } from '../src/trusted-facts/model.ts'
import type { NavigationItem, NavigationSnapshot } from '../src/trusted-facts/navigation-contract.ts'
import { FileTrustedFactRepository } from '../src/x-feedback/trusted-fact-repository.ts'
import { createCandidateFactAssessmentPort, SUBMIT_X_CRON_ASSESSMENT } from '../src/x-cron/assessment-agent.ts'
import {
  XFeedFinalAgentSurface,
  X_CRON_FINAL_LOOKUP_TOOL,
  X_CRON_FINAL_PROJECT_TOOL,
} from '../src/x-cron/final-agent.ts'

const MODEL_SELECTION = { provider: 'wire-test', model: 'wire-model' } as const
const CANDIDATE: CandidateDescriptor = {
  id: 'target:current-candidate',
  content: '当前候选正文',
  source: 'https://x.com/alice/status/1',
}
const BUDGET: ProjectionBudget = {
  maxInlineFacts: 2,
  maxLookupTickets: 2,
  maxSerializedBytes: 16_000,
}
const LEGACY_MARKER = 'TODO7-B-LEGACY-MARKER-MUST-NOT-CROSS'
const FIRST_ROUND_ASSISTANT_MARKER = 'TODO7-B-FIRST-ROUND-ASSISTANT-MARKER'
const FIRST_ROUND_TOOL_RESULT_MARKER = 'TODO7-B-FIRST-ROUND-TOOL-RESULT-MARKER'
const FIRST_ROUND_REASONING_MARKER = 'TODO7-B-FIRST-ROUND-REASONING-MARKER'
const OLD_SESSION_MARKER = 'TODO7-B-OLD-SESSION-MARKER-MUST-NOT-CROSS'
const FINAL_TEXT = `📦 X 洞察\n\n⭐ 当前候选\n- ${CANDIDATE.content} (${CANDIDATE.source})`
const FIRST_ROUND_FINAL_TEXT = `📦 X 洞察\n\n⭐ 当前候选\n- ${CANDIDATE.content} ${FIRST_ROUND_ASSISTANT_MARKER} (${CANDIDATE.source})`

const directories: string[] = []
const contexts: Context[] = []

type Scenario = {
  readonly directory: string
  readonly navigation: NavigationSnapshot
  readonly projectionSession: ReadyFactProjectionSession
  readonly assessment: ReturnType<typeof createCandidateFactAssessmentPort>
  readonly projected: ProjectionView
  readonly lookup: (ticketId: string) => LookupResult
  readonly legacyLedgerPath: string
  readonly legacyLedgerBytes: Buffer
  readonly legacyLedgerHash: string
  readonly legacyNoiseSizes: Readonly<Record<string, number>>
  readonly legacyNoiseBytes: number
}

type RoundEvidence = {
  readonly assessmentWires: readonly GenerateOptions[]
  readonly finalWires: readonly GenerateOptions[]
  readonly finalSessionId: string
  readonly assessmentSessionIds: readonly string[]
  readonly createdSessions: readonly { id: string; seedLength?: number; parentSession?: string }[]
}

class InvarianceAdapter extends LlmAdapter {
  readonly assessmentRequests: GenerateOptions[] = []
  readonly finalRequests: GenerateOptions[] = []
  private readonly finalSteps = new Map<string, number>()
  private readonly finalRounds = new Map<string, number>()
  private finalSessionOrder = 0

  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    if (request.system?.includes('assessment Agent') === true) {
      this.assessmentRequests.push(request)
      yield* assessmentResponse(request)
      return
    }
    this.finalRequests.push(request)
    const sessionId = String(request.sessionId ?? '')
    const step = (this.finalSteps.get(sessionId) ?? 0) + 1
    this.finalSteps.set(sessionId, step)
    if (step === 1) this.finalRounds.set(sessionId, this.finalSessionOrder++)
    const firstRound = this.finalRounds.get(sessionId) === 0
    if (step === 1) {
      yield* toolCall('project-call', X_CRON_FINAL_PROJECT_TOOL, { candidateId: CANDIDATE.id }, false)
      return
    }
    if (step === 2) {
      yield* toolCall('lookup-call', X_CRON_FINAL_LOOKUP_TOOL, { ticketId: extractTicketId(request) }, false)
      return
    }
    if (step === 3) {
      yield* toolCall('prepare-call', 'x_feed_prepare_delivery', {
        text: firstRound ? FIRST_ROUND_FINAL_TEXT : FINAL_TEXT,
        urls: [CANDIDATE.source],
      }, false)
      return
    }
    yield* textResponse(firstRound ? FIRST_ROUND_FINAL_TEXT : FINAL_TEXT, firstRound)
  }
}

describe('TODO7-B context invariance across bounded fact projection and fresh cron Agents', () => {
  afterEach(async () => {
    while (contexts.length > 0) await contexts.pop()?.fiber.dispose()
    await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
  })

  it('keeps model-visible material and bytes invariant from 2 to 200 facts, isolates two fresh rounds, and ignores legacy noise', async () => {
    const smallAdapter = new InvarianceAdapter()
    const largeAdapter = new InvarianceAdapter()
    const smallContext = await createHarness(smallAdapter)
    const largeContext = await createHarness(largeAdapter)
    const small = await createScenario(2, smallContext, smallAdapter)
    const large = await createScenario(200, largeContext, largeAdapter)

    const smallRounds = [
      await runRound(smallContext, small, smallAdapter, 'small-1'),
      await runRound(smallContext, small, smallAdapter, 'small-2'),
    ]
    const largeRounds = [
      await runRound(largeContext, large, largeAdapter, 'large-1'),
      await runRound(largeContext, large, largeAdapter, 'large-2'),
    ]

    expect(small.projected.serializedBytes).toEqual(large.projected.serializedBytes)
    expect(small.projected.facts).toHaveLength(1)
    expect(small.projected.tickets).toHaveLength(1)
    expect(large.projected.facts).toEqual(small.projected.facts)
    expect(large.projected.tickets).toEqual(small.projected.tickets)
    expect(large.legacyNoiseSizes['legacy-x-preferences.md']).toBeGreaterThan(small.legacyNoiseSizes['legacy-x-preferences.md']!)
    expect(large.legacyNoiseSizes['x_interest_graph.json']).toBeGreaterThan(small.legacyNoiseSizes['x_interest_graph.json']!)
    expect(large.legacyNoiseSizes['x_raw_history.jsonl']).toBeGreaterThan(small.legacyNoiseSizes['x_raw_history.jsonl']!)
    expect(large.legacyNoiseBytes).toBeGreaterThan(small.legacyNoiseBytes)

    expect(smallRounds[0]!.assessmentWires).toHaveLength(1)
    expect(smallRounds[1]!.assessmentWires).toHaveLength(1)
    expect(largeRounds[0]!.assessmentWires).toHaveLength(1)
    expect(largeRounds[1]!.assessmentWires).toHaveLength(1)
    expect(largeRounds[0]!.assessmentWires[0]!.messages).toEqual(smallRounds[0]!.assessmentWires[0]!.messages)
    expect(largeRounds[0]!.assessmentWires[0]!.system).toBe(smallRounds[0]!.assessmentWires[0]!.system)
    expect(largeRounds[0]!.assessmentWires[0]!.tools).toEqual(smallRounds[0]!.assessmentWires[0]!.tools)
    expect(largeRounds[0]!.assessmentWires[0]!.provider).toBe(smallRounds[0]!.assessmentWires[0]!.provider)
    expect(largeRounds[0]!.assessmentWires[0]!.model).toBe(smallRounds[0]!.assessmentWires[0]!.model)
    expect(normalizedWireBytes(largeRounds[0]!.assessmentWires[0]!)).toEqual(normalizedWireBytes(smallRounds[0]!.assessmentWires[0]!))
    expect(requestByteLengths(largeRounds[0]!.assessmentWires)).toEqual(requestByteLengths(smallRounds[0]!.assessmentWires))
    expect(totalRequestBytes(largeRounds[0]!.assessmentWires)).toBe(totalRequestBytes(smallRounds[0]!.assessmentWires))

    expect(largeRounds[0]!.finalWires).toHaveLength(smallRounds[0]!.finalWires.length)
    for (let index = 0; index < smallRounds[0]!.finalWires.length; index += 1) {
      const smallWire = smallRounds[0]!.finalWires[index]!
      const largeWire = largeRounds[0]!.finalWires[index]!
      expect(normalizedWireBytes(largeWire)).toEqual(normalizedWireBytes(smallWire))
      expect(requestByteLength(largeWire)).toBe(requestByteLength(smallWire))
      expect(largeWire.provider).toBe(smallWire.provider)
      expect(largeWire.model).toBe(smallWire.model)
      expect(largeWire.system).toBe(smallWire.system)
      expect(largeWire.tools).toEqual(smallWire.tools)
    }
    expect(totalRequestBytes(largeRounds[0]!.finalWires)).toBe(totalRequestBytes(smallRounds[0]!.finalWires))
    expect(requestByteLengths(largeRounds[0]!.finalWires)).toEqual(requestByteLengths(smallRounds[0]!.finalWires))
    expect(totalRequestBytes(largeRounds[1]!.assessmentWires)).toBe(totalRequestBytes(smallRounds[1]!.assessmentWires))
    expect(requestByteLengths(largeRounds[1]!.assessmentWires)).toEqual(requestByteLengths(smallRounds[1]!.assessmentWires))
    expect(totalRequestBytes(largeRounds[1]!.finalWires)).toBe(totalRequestBytes(smallRounds[1]!.finalWires))
    expect(requestByteLengths(largeRounds[1]!.finalWires)).toEqual(requestByteLengths(smallRounds[1]!.finalWires))

    for (const round of [...smallRounds, ...largeRounds]) {
      expect(round.assessmentWires).toHaveLength(1)
      expect(round.finalWires).toHaveLength(4)
      expect(JSON.stringify(round.assessmentWires)).not.toContain(LEGACY_MARKER)
      expect(JSON.stringify(round.finalWires)).toContain('真正相关事实 1')
      expect(JSON.stringify(round.finalWires)).toContain('真正相关事实 2')
      expect(JSON.stringify(round.finalWires)).not.toContain('显式无关事实')
      expect(JSON.stringify(round.finalWires)).not.toContain(LEGACY_MARKER)
    }

    expect(largeRounds[0]!.assessmentSessionIds).toHaveLength(1)
    expect(largeRounds[1]!.assessmentSessionIds).toHaveLength(1)
    expect(largeRounds[1]!.assessmentSessionIds[0]).not.toBe(largeRounds[0]!.assessmentSessionIds[0])
    expect(largeRounds[1]!.finalSessionId).not.toBe(largeRounds[0]!.finalSessionId)
    expect([...largeRounds, ...smallRounds].flatMap(round => round.createdSessions)
      .every(session => session.seedLength === undefined && session.parentSession === undefined)).toBe(true)
    expect([...largeRounds, ...smallRounds].every(round => round.createdSessions.length >= 2)).toBe(true)
    expect(JSON.stringify(largeRounds[1]!.finalWires)).not.toContain(LEGACY_MARKER)
    expect(JSON.stringify(largeRounds[1]!.assessmentWires)).not.toContain(LEGACY_MARKER)
    for (const marker of [FIRST_ROUND_ASSISTANT_MARKER, FIRST_ROUND_TOOL_RESULT_MARKER, FIRST_ROUND_REASONING_MARKER, OLD_SESSION_MARKER]) {
      expect(JSON.stringify(largeRounds[1]!.finalWires)).not.toContain(marker)
      expect(JSON.stringify(largeRounds[1]!.assessmentWires)).not.toContain(marker)
      expect(largeRounds[0]!.firstRoundSessionEvents).toContain(marker)
      expect(largeRounds[1]!.firstRoundSessionEvents).not.toContain(marker)
    }
    expect(largeRounds[0]!.firstRoundSessionEvents).toContain('tool-call')

    expect(new XFeedbackStore(small.directory).readAll().some(event => event.note === LEGACY_MARKER)).toBe(true)
    expect(new XFeedbackStore(large.directory).readAll().some(event => event.note === LEGACY_MARKER)).toBe(true)
    expect(JSON.stringify(small.projected)).not.toContain(LEGACY_MARKER)
    expect(JSON.stringify(large.projected)).not.toContain(LEGACY_MARKER)
    expect(sha256(await readFile(small.legacyLedgerPath))).toBe(small.legacyLedgerHash)
    expect(sha256(await readFile(large.legacyLedgerPath))).toBe(large.legacyLedgerHash)
  })
})

async function createScenario(factCount: number, context: Context, adapter: InvarianceAdapter): Promise<Scenario> {
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
  const assessment = createCandidateFactAssessmentPort(context, navigation, { modelSelection: MODEL_SELECTION })
  const preflight = createFactProjectionPreflight(directory, BUDGET, assessment)
  if (preflight.kind !== 'ready') throw new Error(`projection preflight failed: ${preflight.code}`)
  const firstPrime = await assessment.prime({ candidate: CANDIDATE, navigation: navigation.items, budget: BUDGET })
  const projected = preflight.session.project(CANDIDATE, firstPrime.assessment)
  if (projected.kind !== 'ready') throw new Error(`projection failed: ${projected.code}`)
  const ledger = Buffer.from(readFileSync(join(directory, 'feedback.jsonl')))
  const legacyNoiseSizes = readLegacyNoiseSizes(directory)
  adapter.assessmentRequests.length = 0
  return {
    directory,
    navigation,
    projectionSession: preflight.session,
    assessment,
    projected: projected.view,
    lookup: projected.lookup,
    legacyLedgerBytes: ledger,
    legacyLedgerHash: sha256(ledger),
    legacyLedgerPath: join(directory, 'feedback.jsonl'),
    legacyNoiseSizes,
    legacyNoiseBytes: Object.values(legacyNoiseSizes).reduce((total, size) => total + size, 0),
  }
}

async function runRound(
  context: Context,
  scenario: Scenario,
  adapter: InvarianceAdapter,
  label: string,
): Promise<RoundEvidence & { readonly firstRoundSessionEvents: string }> {
  const beforeAssessment = adapter.assessmentRequests.length
  const beforeFinal = adapter.finalRequests.length
  const createdSessions: RoundEvidence['createdSessions'][number][] = []
  const offCreated = context.on('session/created', session => {
    const id = String(session.id)
    if (id.includes('todo7-b') || id.includes('x-assessment')) {
      createdSessions.push({
        id,
        ...(session.header.seedLength === undefined ? {} : { seedLength: session.header.seedLength }),
        ...(session.header.parentSession === undefined ? {} : { parentSession: session.header.parentSession }),
      })
    }
  })
  const prime = await scenario.assessment.prime({ candidate: CANDIDATE, navigation: scenario.navigation.items, budget: BUDGET })
  expect(prime.recall.locatorIds).toHaveLength(2)
  expect(prime.recall.navigation).toHaveLength(2)
  expect(prime.segments).toHaveLength(1)
  const projected = scenario.projectionSession.project(CANDIDATE, prime.assessment)
  if (projected.kind !== 'ready') throw new Error(`round projection failed: ${projected.code}`)
  expect(projected.view.serializedBytes).toEqual(scenario.projected.serializedBytes)
  const firstRound = label.endsWith('-1')
  const finalSurface = new XFeedFinalAgentSurface({
    material: { runId: `run-${label}`, allowedTopics: ['current-candidate'], candidates: [{ ...CANDIDATE, topics: ['current-candidate'] }] },
    runTools: {
      searchTopic: async () => ({ items: [] }),
      exploreCandidate: async () => ({ title: 'candidate', body: 'body', urls: [] }),
      setTheme: async theme => ({ theme }),
      prepareDelivery: async () => firstRound
        ? { ok: true, prepared: 1, marker: FIRST_ROUND_TOOL_RESULT_MARKER }
        : { ok: true, prepared: 1 },
    },
    projection: { project: async () => projected.view, lookup: projected.lookup },
  })
  const sessionId = SessionId(`session-todo7-b-final-${label}`)
  const assessmentSessionIds: string[] = []
  const handle = await context.agents.create({
    sessionId,
    agentOptions: MODEL_SELECTION,
    setup: agentContext => {
      installModelSelection(agentContext, { current: MODEL_SELECTION, assembled: undefined })
      finalSurface.setupAgent(agentContext)
    },
  })
  try {
    finalSurface.capture(context, sessionId)
    await finalSurface.verifySurface(handle.agent)
    const firstSeq = handle.agent.session.seq
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: '执行当前 X run' }], source: { kind: 'plugin', plugin: 'dsh-cron' } }))
    await handle.agent.whenIdle()
    const outcome = summarizeTurn(handle.agent.session.events, firstSeq)
    finalSurface.finalizeOutcome(outcome)
    const finalRequests = adapter.finalRequests.slice(beforeFinal)
    const assessmentRequests = adapter.assessmentRequests.slice(beforeAssessment)
    assessmentSessionIds.push(...assessmentRequests.map(request => String(request.sessionId)))
    return {
      assessmentWires: assessmentRequests,
      finalWires: finalRequests,
      finalSessionId: String(sessionId),
      assessmentSessionIds,
      createdSessions,
      firstRoundSessionEvents: JSON.stringify(handle.agent.session.events),
    }
  } finally {
    offCreated()
    finalSurface.dispose()
    await handle.dispose()
  }
}

function seedLegacyFiles(directory: string, noiseMultiplier: number): void {
  writeFileSync(join(directory, 'feedback.jsonl'), `${JSON.stringify({ schemaVersion: 1, id: 'legacy-rating', createdAt: '2026-08-20T00:00:00.000Z', operation: 'dislike', canonicalUrl: CANDIDATE.source, note: LEGACY_MARKER })}\n`)
  const noise = LEGACY_MARKER.repeat(noiseMultiplier)
  writeFileSync(join(directory, 'legacy-x-preferences.md'), noise)
  writeFileSync(join(directory, 'x_interest_graph.json'), JSON.stringify({ marker: noise }))
  writeFileSync(join(directory, 'x_raw_history.jsonl'), `${noise}\n`)
}

function readLegacyNoiseSizes(directory: string): Readonly<Record<string, number>> {
  const names = ['legacy-x-preferences.md', 'x_interest_graph.json', 'x_raw_history.jsonl'] as const
  return Object.freeze(Object.fromEntries(names.map(name => [name, readFileSync(join(directory, name)).byteLength])))
}

async function createHarness(adapter: InvarianceAdapter): Promise<Context> {
  const context = new Context()
  await context.plugin(LlmRuntime)
  await context.plugin(SessionStore)
  await context.plugin(SystemPrompt)
  await context.plugin(ToolRuntime)
  await context.plugin(AgentRegistry)
  await context.plugin(AgentDefaultModelConfig, MODEL_SELECTION)
  await context.plugin(AgentLoop, { agents: [] })
  context.llm.registerAdapter(['wire-test'], adapter)
  contexts.push(context)
  return context
}

function assessmentResponse(request: GenerateOptions): StreamChunk[] {
  const message = request.messages[0]?.content[0]
  if (message?.type !== 'text') throw new Error('assessment request omitted its material')
  const material = JSON.parse(message.text.slice(message.text.indexOf('\n') + 1)) as { navigation: readonly { locator: { locatorId: string } }[] }
  return toolCall('assessment-call', SUBMIT_X_CRON_ASSESSMENT, {
    decisions: material.navigation.map((item, index) => ({ locatorId: item.locator.locatorId, relevance: 'high', essentiality: index === 0 ? 'inline_priority' : 'lookup_only', priority: index + 1, reason: '当前候选与该事实明确相关' })),
  }, false)
}

function toolCall(id: string, name: string, value: unknown, withReasoning: boolean): StreamChunk[] {
  const callId = CallId(id)
  const argumentsText = JSON.stringify(value)
  const blocks: StreamChunk[] = []
  if (withReasoning) {
    const marker = `${FIRST_ROUND_REASONING_MARKER} ${OLD_SESSION_MARKER}`
    blocks.push({ type: 'block-start', index: 0, blockType: 'reasoning' }, { type: 'reasoning-delta', index: 0, text: marker }, { type: 'block-end', index: 0, block: { type: 'reasoning', text: marker } })
  }
  const index = withReasoning ? 1 : 0
  blocks.push({ type: 'block-start', index, blockType: 'tool-call' }, { type: 'tool-call-delta', index, id: callId, name, argumentsDelta: argumentsText }, { type: 'block-end', index, block: { type: 'tool-call', id: callId, name, arguments: argumentsText } }, { type: 'finish', reason: { kind: 'tool-calls' } })
  return blocks
}

function textResponse(text: string, withReasoning: boolean): StreamChunk[] {
  const blocks: StreamChunk[] = []
  if (withReasoning) {
    const marker = `${FIRST_ROUND_REASONING_MARKER} ${OLD_SESSION_MARKER}`
    blocks.push({ type: 'block-start', index: 0, blockType: 'reasoning' }, { type: 'reasoning-delta', index: 0, text: marker }, { type: 'block-end', index: 0, block: { type: 'reasoning', text: marker } })
  }
  const index = withReasoning ? 1 : 0
  blocks.push({ type: 'block-start', index, blockType: 'text' }, { type: 'text-delta', index, text }, { type: 'block-end', index, block: { type: 'text', text } }, { type: 'finish', reason: { kind: 'stop' } })
  return blocks
}

function extractTicketId(request: GenerateOptions): string {
  const match = /"ticketId":"([^"]+)"/u.exec(JSON.stringify(request.messages).replaceAll('\\"', '"'))
  if (match?.[1] === undefined) throw new Error('final request omitted projection ticket')
  return match[1]
}

function normalizedWireBytes(request: GenerateOptions): Buffer {
  return Buffer.from(JSON.stringify(normalizeWire({ provider: request.provider, model: request.model, messages: request.messages, system: request.system, tools: request.tools })), 'utf8')
}

// Keep every model-facing value and array order. Only fresh-lineage controls are
// removed: request sessionId, message/call/tool-call ids, and block ids.
function normalizeWire(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeWire)
  if (value === null || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  const output: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(record)) {
    if (key === 'sessionId' || key === 'messageId' || key === 'callId' || key === 'toolCallId') continue
    if (key === 'id' && (Object.hasOwn(record, 'role') || record.type === 'tool-call' || record.type === 'tool-result')) continue
    output[key] = normalizeWire(child)
  }
  return output
}

function requestByteLength(request: GenerateOptions): number {
  return Buffer.byteLength(JSON.stringify({ provider: request.provider, model: request.model, messages: request.messages, system: request.system, tools: request.tools }), 'utf8')
}

function requestByteLengths(requests: readonly GenerateOptions[]): readonly number[] {
  return requests.map(requestByteLength)
}

function totalRequestBytes(requests: readonly GenerateOptions[]): number {
  return requestByteLengths(requests).reduce((total, length) => total + length, 0)
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}
