import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'
import AgentRegistry, { installModelSelection } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { ToolCallId, createUserMessage, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { summarizeTurn } from '@deepseek-ai/dsh-telegram-gateway'
import { FileNavigationSnapshotStore } from '../src/navigation/file-navigation-snapshot-store.ts'
import { createTrustedFact } from '../src/trusted-facts/model.ts'
import { FileTrustedFactRepository } from '../src/x-feedback/trusted-fact-repository.ts'
import { createXFeedCronEnvironmentProvider } from '../src/x-cron/provider.ts'
import { type PythonCommandRequest, type PythonCommandResult } from '../src/x-cron/python-ports.ts'

const MODEL_SELECTION = { provider: 'wire-test', model: 'wire-model' } as const
const CANDIDATE_URL = 'https://x.com/alice/status/1'
const PACKAGE_TEXT = JSON.stringify({
  allowed_topics: ['agentic systems'],
  recent_items: [{ id: '1', url: CANDIDATE_URL, text: 'current candidate body', topics: ['agentic systems'] }],
  selected_urls: [CANDIDATE_URL],
  decision: { top_theme: 'agentic systems' },
})

const directories: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  while (contexts.length > 0) await contexts.pop()!.fiber.dispose()
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

type AdapterMode = 'valid' | 'planner-schema-error' | 'composer-schema-error'

class TwoCallAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  private readonly plannerCalls = new Map<string, number>()
  private readonly composerCalls = new Map<string, number>()

  constructor(private readonly mode: AdapterMode = 'valid') {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    const system = request.system ?? ''
    if (/assessment Agent|run-tools|x_feed_prepare_delivery|x_feed_set_run_theme|一次性的 X 洞察投递 Agent/u.test(system)) {
      throw new Error('x-cron integration received a forbidden legacy model surface')
    }
    const sessionId = String(request.sessionId ?? '')
    if (system.includes('planner Agent') || request.tools?.some(tool => tool.name === 'submit_x_cron_planner') === true) {
      const calls = (this.plannerCalls.get(sessionId) ?? 0) + 1
      this.plannerCalls.set(sessionId, calls)
      if (calls !== 1) throw new Error('planner was called more than once')
      const value = this.mode === 'planner-schema-error'
        ? { selectedCandidateIds: ['not-a-candidate'], themeId: 42, exploration: { kind: 'invalid' } }
        : { selectedCandidateIds: ['x-status:1'], themeId: 'agentic systems', exploration: { kind: 'none' } }
      yield* toolCall('planner-submit', 'submit_x_cron_planner', value)
      return
    }
    if (system.includes('composer Agent') || request.tools?.some(tool => tool.name === 'submit_x_cron_composer') === true) {
      const calls = (this.composerCalls.get(sessionId) ?? 0) + 1
      this.composerCalls.set(sessionId, calls)
      if (calls !== 1) throw new Error('composer was called more than once')
      const value = this.mode === 'composer-schema-error'
        ? { title: 42, sections: [{ kind: 'invalid-section' }] }
        : { title: 'provider title', sections: [{ kind: 'highlight', items: [{ itemId: 'item:x-status:1', summary: 'provider summary' }] }] }
      yield* toolCall('composer-submit', 'submit_x_cron_composer', value)
      return
    }
    throw new Error(`unexpected x-cron model surface: ${system}`)
  }
}

async function createHarness(adapter: LlmAdapter): Promise<Context> {
  const context = new Context()
  await context.plugin(LlmRuntime)
  await context.plugin(SessionStore)
  await context.plugin(SystemPrompt)
  await context.plugin(ToolRuntime)
  await context.plugin(AgentRegistry)
  await context.plugin(SessionProjectionRegistry)
  await context.plugin(AgentDefaultModelConfig, MODEL_SELECTION)
  await context.plugin(AgentLoop, { agents: [] })
  context.llm.registerAdapter(['wire-test'], adapter)
  contexts.push(context)
  return context
}

function toolCall(id: string, name: string, value: unknown): StreamChunk[] {
  const callId = ToolCallId(id)
  const argumentsText = JSON.stringify(value)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: argumentsText },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name, arguments: argumentsText } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function runner(options: { readonly failPrepare?: boolean } = {}): {
  readonly calls: PythonCommandRequest[]
  readonly run: (request: PythonCommandRequest) => Promise<PythonCommandResult>
} {
  const calls: PythonCommandRequest[] = []
  return {
    calls,
    run: async request => {
      calls.push(request)
      if (options.failPrepare === true && request.args.includes('prepare-delivery')) {
        throw new Error('synthetic prepare failure')
      }
      return { stdout: request.args.includes('prepare-delivery') ? '{"ok":true,"prepared":1,"rejected":[]}\n' : '{"ok":true}\n', stderr: '', exitCode: 0 }
    },
  }
}

async function readyFixture(): Promise<{ readonly directory: string; readonly packagePath: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-x-feed-cron-integration-'))
  directories.push(directory)
  const fact = createTrustedFact({
    target: { id: 'x-status:1', content: 'current trusted fact', source: CANDIDATE_URL, scope: 'this candidate' },
    dimension: 'content_value', reason: 'user supplied current fact',
    evidence: { kind: 'user_direct', rawUserExpression: 'remember this current fact' },
  })
  if (!fact.ok) throw new Error(fact.message)
  const repository = new FileTrustedFactRepository(directory)
  if (!repository.append(fact.fact).ok) throw new Error('failed to seed trusted fact')
  const snapshot = repository.readLocatedSnapshot()
  const located = snapshot.facts[0]
  if (located === undefined) throw new Error('fixture fact was not persisted')
  new FileNavigationSnapshotStore(directory).replace({
    schemaVersion: 1, sourceRevision: snapshot.sourceRevision,
    items: [{
      schemaVersion: 1, kind: 'trusted-fact-navigation', origin: 'machine-derived',
      derivation: { method: 'integration', version: '1' }, locator: located.locator,
      hints: {
        topics: ['agentic systems'],
        targetRefs: [{ targetId: 'x-status:1', canonicalSource: CANDIDATE_URL }],
        dimension: 'content_value', relations: [{ kind: 'about-target', targetId: 'x-status:1' }],
      },
    }],
  })
  return { directory, packagePath: join(directory, 'x_insight_package.json') }
}

async function emptyFixture(): Promise<{ readonly directory: string; readonly packagePath: string }> {
  const fixture = await readyFixture()
  return fixture
}

function providerFor(
  context: Context,
  directory: string,
  packagePath: string,
  python: ReturnType<typeof runner>,
  packageText = PACKAGE_TEXT,
) {
  return createXFeedCronEnvironmentProvider({
    ctx: context, cronJobId: 'cron-x-integration', dataDir: directory,
    pythonBin: 'python3', pipelinePath: '/pkg/python/x_insight_pipeline.py', run: python.run,
    readFile: async path => {
      if (path !== packagePath) throw new Error(`unexpected artifact read: ${path}`)
      return packageText
    },
  })
}

async function runAgent(
  context: Context,
  lease: Exclude<Awaited<ReturnType<ReturnType<typeof createXFeedCronEnvironmentProvider>['prepare']>>, { kind: 'skip' }>,
): Promise<{ readonly text: string; readonly error: string | undefined }> {
  const handle = await context.agents.create({
    sessionId: SessionId('x-cron-integration-composer'), agentOptions: MODEL_SELECTION,
    setup: agentContext => { installModelSelection(agentContext, { current: MODEL_SELECTION, assembled: undefined }); lease.setupAgent(agentContext) },
  })
  try {
    await lease.verifySurface(handle.agent)
    const firstSeq = handle.agent.session.seq
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'drive current X run' }], source: { kind: 'plugin', plugin: 'dsh-cron' } }))
    await handle.agent.whenIdle()
    return summarizeTurn(handle.agent.session.snapshotEvents(), firstSeq)
  } finally {
    await handle.dispose()
  }
}

describe('dsh-x-feed cron provider two-call integration', () => {
  it('runs planner then composer once and finalizes one prepared delivery', async () => {
    const { directory, packagePath } = await readyFixture()
    const python = runner()
    const adapter = new TwoCallAdapter()
    const context = await createHarness(adapter)
    const provider = providerFor(context, directory, packagePath, python)
    const lease = await provider.prepare({ jobId: 'cron-x-integration', runId: 'cron-x-integration@success' })
    if (lease.kind === 'skip') throw new Error('ready package unexpectedly skipped')
    try {
      const outcome = await runAgent(context, lease)
      const finalized = await lease.finalizeOutcome!(outcome)
      expect(finalized.error).toBeUndefined()
      expect(finalized.text).toContain('provider title')
      expect(adapter.requests).toHaveLength(2)
      expect(adapter.requests.filter(request => request.system?.includes('planner Agent'))).toHaveLength(1)
      expect(adapter.requests.filter(request => request.system?.includes('composer Agent'))).toHaveLength(1)
      expect(new Set(adapter.requests.map(request => String(request.sessionId))).size).toBe(2)
      expect(adapter.requests.some(request => /assessment Agent|run-tools|x_feed_prepare_delivery|x_feed_set_run_theme|投递 Agent/u.test(request.system ?? ''))).toBe(false)
      expect(python.calls.filter(request => request.args.includes('prepare-delivery'))).toHaveLength(1)
      expect(existsSync(join(directory, 'x_shown.json'))).toBe(false)
    } finally {
      await lease.dispose()
    }
  })

  it('returns typed skip for an empty package with zero Agent, LLM, delivery, or shown activity', async () => {
    const { directory, packagePath } = await emptyFixture()
    const python = runner()
    const adapter = new TwoCallAdapter()
    const context = await createHarness(adapter)
    const provider = providerFor(context, directory, packagePath, python, JSON.stringify({ recent_items: [], selected_urls: [], decision: {} }))
    await expect(provider.prepare({ jobId: 'cron-x-integration', runId: 'cron-x-integration@empty' })).resolves.toEqual({ kind: 'skip', outcome: { text: undefined, error: undefined } })
    expect(adapter.requests).toHaveLength(0)
    expect(python.calls).toHaveLength(1)
    expect(python.calls.some(request => request.args.includes('prepare-delivery'))).toBe(false)
    expect(existsSync(join(directory, 'x_shown.json'))).toBe(false)
  })

  it('fails closed on planner schema error before composer, delivery, or shown', async () => {
    const { directory, packagePath } = await readyFixture()
    const python = runner()
    const adapter = new TwoCallAdapter('planner-schema-error')
    const context = await createHarness(adapter)
    const provider = providerFor(context, directory, packagePath, python)
    await expect(provider.prepare({ jobId: 'cron-x-integration', runId: 'cron-x-integration@planner-error' })).rejects.toThrow()
    expect(adapter.requests).toHaveLength(1)
    expect(python.calls.filter(request => request.args.includes('prepare-delivery'))).toHaveLength(0)
    expect(existsSync(join(directory, 'x_shown.json'))).toBe(false)
  })

  it('fails closed on composer schema error without prepare-delivery or shown', async () => {
    const { directory, packagePath } = await readyFixture()
    const python = runner()
    const adapter = new TwoCallAdapter('composer-schema-error')
    const context = await createHarness(adapter)
    const provider = providerFor(context, directory, packagePath, python)
    const lease = await provider.prepare({ jobId: 'cron-x-integration', runId: 'cron-x-integration@composer-error' })
    if (lease.kind === 'skip') throw new Error('ready package unexpectedly skipped')
    try {
      const outcome = await runAgent(context, lease)
      expect(outcome.text).toBe('')
      await expect(lease.finalizeOutcome!(outcome)).rejects.toThrow()
    } finally {
      await lease.dispose()
    }
    expect(adapter.requests).toHaveLength(2)
    expect(python.calls.filter(request => request.args.includes('prepare-delivery'))).toHaveLength(0)
    expect(existsSync(join(directory, 'x_shown.json'))).toBe(false)
  })

  it('does not deliver or write shown when prepare-delivery fails after valid planner/composer calls', async () => {
    const { directory, packagePath } = await readyFixture()
    const python = runner({ failPrepare: true })
    const adapter = new TwoCallAdapter()
    const context = await createHarness(adapter)
    const provider = providerFor(context, directory, packagePath, python)
    const lease = await provider.prepare({ jobId: 'cron-x-integration', runId: 'cron-x-integration@prepare-error' })
    if (lease.kind === 'skip') throw new Error('ready package unexpectedly skipped')
    try {
      const outcome = await runAgent(context, lease)
      await expect(lease.finalizeOutcome!(outcome)).rejects.toThrow(/prepare/i)
    } finally {
      await lease.dispose()
    }
    expect(adapter.requests).toHaveLength(2)
    expect(python.calls.filter(request => request.args.includes('prepare-delivery'))).toHaveLength(1)
    expect(existsSync(join(directory, 'x_shown.json'))).toBe(false)
  })
})
