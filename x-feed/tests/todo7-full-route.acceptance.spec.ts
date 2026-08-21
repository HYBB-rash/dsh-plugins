import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { installModelSelection } from '@deepseek-ai/dsh-agent'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { CallId, createUserMessage, type GenerateOptions, LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { type SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { summarizeTurn } from '@deepseek-ai/dsh-telegram-gateway'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  TelegramInboundEnvelope,
  TelegramInboundResult,
} from '@deepseek-ai/dsh-telegram-gateway'
import type { CronRunFinishedEvent } from '@deepseek-ai/dsh-cron'
import { createTrustedFactNavigation, createXFeedCronEnvironmentProvider } from '../src/index.ts'
import { DeliveryReceipt } from '../src/receipt.ts'
import { XFeedbackStore } from '../src/store.ts'
import { FileTrustedFactRepository } from '../src/x-feedback/trusted-fact-repository.ts'
import { FeedbackEffectAdapter } from '../src/x-feedback/feedback-effect-adapter.ts'
import { InMemoryPendingStore } from '../src/x-feedback/pending-store.ts'
import { FeedbackUseCase } from '../src/x-feedback/use-case.ts'
import {
  registerTelegramFeedbackAdapter,
  type TelegramFeedbackAdapterContext,
} from '../src/x-feedback/telegram-adapter.ts'
import {
  CLEAN_FEEDBACK_SYSTEM_PROMPT,
  SUBMIT_X_FEEDBACK_INTERPRETATION,
} from '../src/x-feedback/clean-prompt.ts'
import { runCleanFeedback } from '../src/x-feedback/clean-agent.ts'
import {
  SUBMIT_X_CRON_ASSESSMENT,
} from '../src/x-cron/assessment-agent.ts'
import {
  X_CRON_FINAL_LOOKUP_TOOL,
  X_CRON_FINAL_PROJECT_TOOL,
} from '../src/x-cron/final-agent.ts'
import { runWithExecFile, type PythonCommandRequest, type PythonCommandResult } from '../src/x-cron/python-ports.ts'

const PYTHON_BIN = 'python3'
const PIPELINE_PATH = filePath('../python/x_insight_pipeline.py')
const MODEL_SELECTION = { provider: 'wire-test', model: 'wire-model' } as const
const CANDIDATE_URL = 'https://x.com/alice/status/1'
const CANDIDATE_ID = 'x-status:1'
const OLD_MATERIAL_MARKER = 'TODO7-OLD-MATERIAL-MARKER-never-enters-model'
const ROOT_HISTORY_MARKER = 'TODO7-ORDINARY-TELEGRAM-HISTORY-MARKER'
const FINAL_TEXT = `📦 X 洞察\n\n⭐ 当前候选\n- 当前候选正文 (${CANDIDATE_URL})`

const temporaryDirectories: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  while (contexts.length > 0) await contexts.pop()!.fiber.dispose()
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('TODO7 本机全链路 characterization acceptance', () => {
  it('runs Telegram inbound through a fresh clean wire and preserves the legacy audit bytes', async () => {
    const directory = await temporaryDirectory()
    const legacyLedger = await seedLegacyRatingLedger(directory)

    const adapter = new ScriptedWireAdapter([
      feedbackToolCall({
        kind: 'rating',
        sentiment: 'like',
        targetId: CANDIDATE_ID,
        dimension: 'argument_quality',
        reason: '用户直接说论证清楚。',
      }),
    ])
    const harness = await createHarness(adapter)
    addOrdinaryRootHistory(harness)
    const route = createFeedbackRoute(directory, harness)

    const result = await route.inbound('我喜欢这条，因为论证清楚。 https://x.com/alice/status/1')

    expect(result).toEqual({ kind: 'handled', finalText: '已记录这次反馈。' })
    expect(route.nextCalls).toBe(0)
    expect(new FileTrustedFactRepository(directory).readAll()).toHaveLength(1)
    expect(adapter.requests).toHaveLength(1)
    expect(JSON.stringify(adapter.requests[0])).not.toContain(ROOT_HISTORY_MARKER)
    expect(JSON.stringify(adapter.requests[0])).not.toContain(OLD_MATERIAL_MARKER)
    expect(adapter.requests[0]?.system).toBe(CLEAN_FEEDBACK_SYSTEM_PROMPT)
    expect(adapter.requests[0]?.tools?.map(tool => tool.name)).toEqual([SUBMIT_X_FEEDBACK_INTERPRETATION])

    const auditStore = new XFeedbackStore(directory)
    expect(auditStore.readAll().some(event => event.note === OLD_MATERIAL_MARKER)).toBe(true)
    expect(sha256(await readFile(legacyLedger.path))).toBe(legacyLedger.hash)
  })

  it('locks every TODO2 feedback branch to its intended fact and operation effects', async () => {
    const directory = await temporaryDirectory()
    const adapter = new ScriptedWireAdapter([
      feedbackToolCall({
        kind: 'candidate_reason',
        sentiment: 'dislike',
        targetId: CANDIDATE_ID,
        dimension: 'content_value',
        candidate: '候选理由：内容重复。',
      }),
      feedbackToolCall({ kind: 'confirm_candidate', confirmation: '对，就是这个理由。' }),
      feedbackToolCall({
        kind: 'rating',
        sentiment: 'like',
        targetId: CANDIDATE_ID,
        dimension: 'argument_quality',
      }),
      feedbackToolCall({ kind: 'operation', operation: 'save', targetId: CANDIDATE_ID }),
      feedbackToolCall({ kind: 'operation', operation: 'unsave', targetId: CANDIDATE_ID }),
    ])
    const harness = await createHarness(adapter)
    const route = createFeedbackRoute(directory, harness)
    const repository = new FileTrustedFactRepository(directory)
    const store = new XFeedbackStore(directory)

    const candidate = await route.inbound(`我不喜欢这条。 ${CANDIDATE_URL}`)
    expect(candidate).toMatchObject({ kind: 'handled', finalText: expect.stringContaining('对吗') })
    expect(repository.readAll()).toHaveLength(0)

    const confirmed = await route.inbound('对')
    expect(confirmed).toEqual({ kind: 'handled', finalText: '已记录这次反馈。' })
    expect(repository.readAll()).toHaveLength(1)
    expect(repository.readAll()[0]?.evidence.kind).toBe('user_confirmed_candidate')

    const noReason = await route.inbound(`我喜欢这条，但暂时不说原因。 ${CANDIDATE_URL}`)
    expect(noReason).toEqual({ kind: 'handled', finalText: '你愿意具体说说为什么吗？' })
    expect(repository.readAll()).toHaveLength(1)

    const operationRoute = createFeedbackRoute(directory, harness)
    const saved = await operationRoute.inbound(`收藏这条 ${CANDIDATE_URL}`)
    const unsaved = await operationRoute.inbound(`取消收藏这条 ${CANDIDATE_URL}`)
    expect(saved).toEqual({ kind: 'handled', finalText: '已记录这次反馈。' })
    expect(unsaved).toEqual({ kind: 'handled', finalText: '已记录这次反馈。' })
    expect(repository.readAll()).toHaveLength(1)
    expect(store.readAll().map(event => event.operation)).toEqual(['save', 'unsave'])

    const ordinary = await operationRoute.inbound('这份方案我不喜欢')
    expect(ordinary).toEqual({ kind: 'root-delivered' })
    expect(operationRoute.nextCalls).toBe(1)
    expect(repository.readAll()).toHaveLength(1)
    expect(store.readAll()).toHaveLength(2)
  })

  it('rebuilds navigation, pins one snapshot, runs assessment/project/lookup/final, and confirms shown once', async () => {
    const directory = await temporaryDirectory()
    const legacyLedger = await seedLegacyRatingLedger(directory)
    const adapter = new FullRouteWireAdapter()
    const harness = await createHarness(adapter)
    const route = createFeedbackRoute(directory, harness)
    const feedback = await route.inbound(`我喜欢这条，因为当前论证清楚。 ${CANDIDATE_URL}`)
    expect(feedback.kind).toBe('handled')

    const navigation = await readJson(join(directory, 'trusted-fact-navigation.json'))
    expect(navigation.items).toHaveLength(1)
    expect(navigation.sourceRevision).toBe(new FileTrustedFactRepository(directory).readLocatedSnapshot().sourceRevision)

    await seedLegacyCronMaterials(directory)
    const pythonCalls: PythonCommandRequest[] = []
    const packagePath = join(directory, 'x_insight_package.json')
    const packageMaterial = await readJson(packagePath)
    const pythonRun = async (request: PythonCommandRequest): Promise<PythonCommandResult> => {
      pythonCalls.push(request)
      if (request.args.includes('prepare-delivery')) return runWithExecFile(request)
      return { stdout: '{"ok":true}\n', stderr: '', exitCode: 0 }
    }

    const provider = createXFeedCronEnvironmentProvider({
      ctx: harness,
      cronJobId: 'cron-x-todo7',
      dataDir: directory,
      pythonBin: PYTHON_BIN,
      pipelinePath: PIPELINE_PATH,
      run: pythonRun,
      readFile: async path => readFile(path, 'utf8'),
      projectionBudget: { maxInlineFacts: 2, maxLookupTickets: 2, maxSerializedBytes: 8_000 },
    })
    const lease = await provider.prepare({
      jobId: 'cron-x-todo7',
      runId: 'cron-x-todo7@run-1',
      jobKind: 'agent',
      sessionMode: 'per_run',
      gate: 'forbidden',
    })

    const handle = await harness.agents.create({
      sessionId: 'session-todo7-final' as SessionId,
      agentOptions: MODEL_SELECTION,
      setup: agentContext => {
        installModelSelection(agentContext, { current: MODEL_SELECTION, assembled: undefined })
        lease.setupAgent(agentContext)
      },
    })
    let outcome: ReturnType<typeof summarizeTurn>
    try {
      await lease.verifySurface(handle.agent)
      const firstSeq = handle.agent.session.seq
      handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: '开始当前 X run' }],
        source: { kind: 'plugin', plugin: 'dsh-cron' },
      }))
      await handle.agent.whenIdle()
      outcome = summarizeTurn(handle.agent.session.events, firstSeq)
      lease.finalizeOutcome?.(outcome)
    } finally {
      await handle.dispose()
      await lease.dispose()
    }

    expect(outcome!.text).toBe(FINAL_TEXT)
    expect(outcome!.error).toBeUndefined()
    expect(adapter.assessmentRequests).toHaveLength(1)
    expect(JSON.stringify(adapter.assessmentRequests)).toContain(navigation.items[0]!.locator.locatorId)
    expect(adapter.finalRequests).toHaveLength(4)
    expect(new Set(adapter.finalRequests.map(request => request.sessionId)).size).toBe(1)
    expect(adapter.finalRequests.some(request => JSON.stringify(request).includes('lookup-success'))).toBe(true)
    expect(adapter.finalRequests.some(request => JSON.stringify(request).includes('当前论证清楚。'))).toBe(true)
    expect(JSON.stringify(adapter.assessmentRequests)).not.toContain(OLD_MATERIAL_MARKER)
    expect(JSON.stringify(adapter.finalRequests)).not.toContain(OLD_MATERIAL_MARKER)
    expect(JSON.stringify(adapter.finalRequests)).not.toContain('legacy-x-preferences')
    expect(new XFeedbackStore(directory).readAll().some(event => event.note === OLD_MATERIAL_MARKER)).toBe(true)
    expect(sha256(await readFile(legacyLedger.path))).toBe(legacyLedger.hash)
    expect(pythonCalls.filter(request => request.args.includes('prepare-delivery'))).toHaveLength(1)
    expect(packageMaterial.selected_urls).toEqual([CANDIDATE_URL])

    const prepared = await readJson(packagePath)
    expect(prepared.delivery_status).toBe('prepared')
    expect(existsSync(join(directory, 'x_shown.json'))).toBe(false)

    const receipt = new DeliveryReceipt({
      cronJobId: 'cron-x-todo7',
      dataDir: directory,
      pythonBin: PYTHON_BIN,
      pipelinePath: PIPELINE_PATH,
      logger: { warn: () => undefined, error: () => undefined },
      sleep: async () => undefined,
    })
    const event = cronFinishedEvent({ runId: 'cron-x-todo7@run-1', deliveredAt: '2026-08-21T00:00:00.000Z' })
    expect(await receipt.handle(event)).toMatchObject({ ok: true, confirmStatus: 'delivered' })
    const shownAfterDelivery = await readJson(join(directory, 'x_shown.json'))
    expect(shownAfterDelivery.urls).toEqual([CANDIDATE_URL])
    const shownHash = sha256(await readFile(join(directory, 'x_shown.json')))

    expect(await receipt.handle(event)).toMatchObject({ ok: true })
    expect(sha256(await readFile(join(directory, 'x_shown.json')))).toBe(shownHash)
    expect((await readJson(packagePath)).delivery_status).toBe('delivered')
  })

  it('does not write shown for a prepared run that receives a failed terminal event', async () => {
    const directory = await temporaryDirectory()
    const packagePath = join(directory, 'x_insight_package.json')
    await writeFile(packagePath, JSON.stringify({
      delivery_status: 'prepared',
      pending_urls: [CANDIDATE_URL],
      selected_urls: [CANDIDATE_URL],
    }), 'utf8')
    const receipt = new DeliveryReceipt({
      cronJobId: 'cron-x-todo7',
      dataDir: directory,
      pythonBin: PYTHON_BIN,
      pipelinePath: PIPELINE_PATH,
      logger: { warn: () => undefined, error: () => undefined },
      sleep: async () => undefined,
    })

    expect(await receipt.handle(cronFinishedEvent({ status: 'error' }))).toMatchObject({
      ok: true,
      confirmStatus: 'not-delivered',
    })
    expect(existsSync(join(directory, 'x_shown.json'))).toBe(false)
    expect((await readJson(packagePath)).delivery_status).toBe('failed')
  })
})

type WireScript = (request: GenerateOptions) => StreamChunk[]

class ScriptedWireAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly scripts: WireScript[]) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    const script = this.scripts.shift()
    if (script === undefined) throw new Error('TODO7 wire script exhausted')
      for (const chunk of script(request)) yield chunk
  }
}

class FullRouteWireAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  readonly assessmentRequests: GenerateOptions[] = []
  readonly finalRequests: GenerateOptions[] = []
  private readonly finalSteps = new Map<string, number>()
  private feedbackDone = false

  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    if (request.system === CLEAN_FEEDBACK_SYSTEM_PROMPT) {
      if (this.feedbackDone) throw new Error('TODO7 expected one direct feedback wire')
      this.feedbackDone = true
      for (const chunk of feedbackToolCall({
        kind: 'rating',
        sentiment: 'like',
        targetId: CANDIDATE_ID,
        dimension: 'argument_quality',
        reason: '当前论证清楚。',
      })(request)) yield chunk
      return
    }
    if (request.system?.includes('assessment Agent') === true) {
      this.assessmentRequests.push(request)
      for (const chunk of assessmentToolCall(request)) yield chunk
      return
    }
    if (request.system?.includes('一次性的 X 洞察投递 Agent') === true) {
      this.finalRequests.push(request)
      for (const chunk of this.finalToolStep(request)) yield chunk
      return
    }
    throw new Error('TODO7 received an unexpected model surface')
  }

  private finalToolStep(request: GenerateOptions): StreamChunk[] {
    const sessionId = request.sessionId === undefined ? '' : String(request.sessionId)
    if (sessionId === '') throw new Error('TODO7 final wire omitted session id')
    const step = (this.finalSteps.get(sessionId) ?? 0) + 1
    this.finalSteps.set(sessionId, step)
    if (step === 1) return toolCall('project-1', X_CRON_FINAL_PROJECT_TOOL, { candidateId: CANDIDATE_ID })
    if (step === 2) return toolCall('lookup-1', X_CRON_FINAL_LOOKUP_TOOL, { ticketId: extractTicketId(request) })
    if (step === 3) return toolCall('prepare-1', 'x_feed_prepare_delivery', {
      text: FINAL_TEXT,
      urls: [CANDIDATE_URL],
    })
    return textReply(FINAL_TEXT)
  }
}

function createFeedbackRoute(directory: string, harness: Context): {
  readonly inbound: (currentText: string) => Promise<TelegramInboundResult>
  readonly nextCalls: number
} {
  const pendingStore = new InMemoryPendingStore({ ttlMs: 60_000, clock: { now: () => Date.now() } })
  const repository = new FileTrustedFactRepository(directory)
  const store = new XFeedbackStore(directory)
  const navigation = createTrustedFactNavigation(
    directory,
    {
      derive: located => ({
        topics: ['agentic systems'],
        relations: [{ kind: 'about-target', targetId: located.fact.target.id }],
      }),
    },
    { method: 'todo7-acceptance', version: '1' },
  )
  const effectSink = new FeedbackEffectAdapter(repository, store, navigation)
  const useCase = new FeedbackUseCase(pendingStore)
  const registered = new Map<string, (...args: any[]) => unknown>()
  const telegramContext: TelegramFeedbackAdapterContext = {
    on: (event, listener) => {
      registered.set(event, listener as (...args: any[]) => unknown)
      return () => registered.delete(event)
    },
  }
  let nextCalls = 0

  registerTelegramFeedbackAdapter(telegramContext, {
    pendingStore,
    trustedFactRepository: repository,
    effectSink,
    useCase,
    runCleanFeedback: async (request, signal) => {
      if (signal.aborted) throw signal.reason ?? new Error('feedback aborted')
      const result = await runCleanFeedback(harness, request, {
        timeoutMs: 1_000,
        modelSelection: MODEL_SELECTION,
      })
      return { interpretation: result.interpretation }
    },
  })

  return {
    inbound: currentText => {
      const handler = registered.get('telegram/inbound')
      if (handler === undefined) throw new Error('telegram/inbound handler was not registered')
      return Promise.resolve(handler(
        telegramEnvelope(currentText),
        () => {
          nextCalls += 1
          return { kind: 'root-delivered' } satisfies TelegramInboundResult
        },
      ) as Promise<TelegramInboundResult>)
    },
    get nextCalls() { return nextCalls },
  }
}

async function createHarness(adapter: LlmAdapter): Promise<Context> {
  const harness = new Context()
  await harness.plugin(LlmRuntime)
  await harness.plugin(SessionStore)
  await harness.plugin(SystemPrompt)
  await harness.plugin(ToolRuntime)
  await harness.plugin(AgentRegistry)
  await harness.plugin(AgentDefaultModelConfig, MODEL_SELECTION)
  await harness.plugin(AgentLoop, { agents: [] })
  harness.llm.registerAdapter(['wire-test'], adapter)
  contexts.push(harness)
  return harness
}

function addOrdinaryRootHistory(harness: Context): void {
  harness.systemPrompt.section({ name: 'ordinary-root-history', order: 10, text: ROOT_HISTORY_MARKER.repeat(100) })
  harness.systemPrompt.context({ name: 'ordinary-root-runtime', order: 10, text: ROOT_HISTORY_MARKER.repeat(100) })
}

function feedbackToolCall(value: unknown): WireScript {
  return () => toolCall('feedback-1', SUBMIT_X_FEEDBACK_INTERPRETATION, value)
}

function assessmentToolCall(request: GenerateOptions): StreamChunk[] {
  const message = request.messages[0]?.content[0]
  if (message?.type !== 'text') throw new Error('assessment wire omitted its JSON material')
  const jsonStart = message.text.indexOf('\n')
  const material = JSON.parse(message.text.slice(jsonStart + 1)) as {
    readonly navigation: readonly { readonly locator: { readonly locatorId: string } }[]
  }
  return toolCall('assessment-1', SUBMIT_X_CRON_ASSESSMENT, {
    decisions: material.navigation.map((item, index) => ({
      locatorId: item.locator.locatorId,
      relevance: 'high',
      essentiality: 'lookup_only',
      priority: index + 1,
      reason: '当前候选与该事实来源一致。',
    })),
  })
}

function toolCall(id: string, name: string, value: unknown): StreamChunk[] {
  const callId = CallId(id)
  const argumentsText = JSON.stringify(value)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: argumentsText },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name, arguments: argumentsText } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function textReply(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function extractTicketId(request: GenerateOptions): string {
  const match = /"ticketId":"([^"]+)"/u.exec(JSON.stringify(request.messages).replaceAll('\\"', '"'))
  if (match?.[1] === undefined) throw new Error('final wire omitted the exact projection ticket')
  return match[1]
}

function telegramEnvelope(currentText: string): TelegramInboundEnvelope {
  return {
    chat: { id: 7007, type: 'private' },
    message: { id: 1 },
    currentText,
    signal: new AbortController().signal,
  }
}

async function seedLegacyCronMaterials(directory: string): Promise<void> {
  await writeFile(join(directory, 'legacy-x-preferences.md'), OLD_MATERIAL_MARKER, 'utf8')
  await writeFile(join(directory, 'x_interest_graph.json'), JSON.stringify({ marker: OLD_MATERIAL_MARKER }), 'utf8')
  await writeFile(join(directory, 'x_raw_history.jsonl'), `${OLD_MATERIAL_MARKER}\n`, 'utf8')
  await writeFile(join(directory, 'x_insight_package.json'), JSON.stringify({
    allowed_topics: ['agentic systems'],
    recent_items: [{ id: '1', url: CANDIDATE_URL, text: '当前候选正文', topics: ['agentic systems'] }],
    selected_urls: [CANDIDATE_URL],
    decision: { top_theme: 'agentic systems' },
    feedback_context: OLD_MATERIAL_MARKER.repeat(20),
    preferences: { marker: OLD_MATERIAL_MARKER },
    graph: { marker: OLD_MATERIAL_MARKER },
    raw_history: [OLD_MATERIAL_MARKER],
  }), 'utf8')
}

async function seedLegacyRatingLedger(directory: string): Promise<{ readonly path: string; readonly hash: string }> {
  const path = join(directory, 'feedback.jsonl')
  const event = `${JSON.stringify({
    schemaVersion: 1,
    id: 'legacy-rating-1',
    createdAt: '2026-08-20T00:00:00.000Z',
    operation: 'dislike',
    canonicalUrl: CANDIDATE_URL,
    note: OLD_MATERIAL_MARKER,
  })}\n`
  await writeFile(path, event, 'utf8')
  return { path, hash: sha256(await readFile(path)) }
}

async function readJson(path: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, any>
}

function cronFinishedEvent(partial: Partial<CronRunFinishedEvent> = {}): CronRunFinishedEvent {
  return {
    jobId: 'cron-x-todo7',
    runId: 'cron-x-todo7@run-1',
    sessionId: 'session-todo7-final',
    scheduledFor: '2026-08-21T00:00:00.000Z',
    status: 'success',
    ...partial,
  }
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-x-feed-todo7-full-route-'))
  temporaryDirectories.push(directory)
  return directory
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function filePath(relativePath: string): string {
  return join(dirname(new URL(import.meta.url).pathname), relativePath)
}
