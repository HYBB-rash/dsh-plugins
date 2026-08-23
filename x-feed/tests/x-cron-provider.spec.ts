import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'
import AgentRegistry, { installModelSelection } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { CallId, type GenerateOptions, LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { summarizeTurn } from '@deepseek-ai/dsh-telegram-gateway'
import {
  createXFeedCronEnvironmentProvider,
  X_CRON_AGENT_ENVIRONMENT_MARKER,
  X_CRON_ENVIRONMENT_REQUIREMENTS,
} from '../src/x-cron/provider.ts'
import { createCronEnvironmentExtension } from '../src/index.ts'
import { createCronAgentEnvironmentRegistry } from '@deepseek-ai/dsh-cron'
import { FileNavigationSnapshotStore } from '../src/navigation/file-navigation-snapshot-store.ts'
import { createFileProjectionSources } from '../src/fact-projection/file-projection-sources.ts'
import { createTrustedFact } from '../src/trusted-facts/model.ts'
import { FileTrustedFactRepository } from '../src/x-feedback/trusted-fact-repository.ts'
import { parseXStatusIdentity } from '../src/x-cron/x-status-identity.ts'
import type { PythonCommandRequest, PythonCommandResult } from '../src/x-cron/python-ports.ts'

const directories: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
  while (contexts.length > 0) await contexts.pop()?.fiber.dispose()
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-x-feed-cron-provider-'))
  directories.push(directory)
  return directory
}

function runner(): { calls: PythonCommandRequest[]; run: (request: PythonCommandRequest) => Promise<PythonCommandResult> } {
  const calls: PythonCommandRequest[] = []
  return {
    calls,
    run: vi.fn(async (request: PythonCommandRequest) => {
      calls.push(request)
      const stdout = request.args.includes('prepare-delivery')
        ? '{"ok":true,"prepared":1,"rejected":[]}\n'
        : '{"ok":true}\n'
      return { stdout, stderr: '', exitCode: 0 }
    }),
  }
}

function toolCall(id: string, name: string, value: unknown): StreamChunk[] {
  const callId = CallId(id)
  const args = JSON.stringify(value)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: args },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name, arguments: args } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

class TwoCallProviderAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(
    private readonly themeId = 'agentic systems',
    private readonly composerItemId = 'item:x-status:1',
  ) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    if (request.system.includes('planner Agent')) {
      yield* toolCall('planner-submit', 'submit_x_cron_planner', {
        selectedCandidateIds: ['x-status:1'],
        themeId: this.themeId,
        exploration: { kind: 'none' },
      })
      return
    }
    if (request.system.includes('composer Agent')) {
      yield* toolCall('composer-submit', 'submit_x_cron_composer', {
        title: 'provider title',
        sections: [{ kind: 'highlight', items: [{ itemId: this.composerItemId, summary: 'provider summary' }] }],
      })
      return
    }
    throw new Error(`unexpected non-S6a provider system: ${request.system}`)
  }
}

class FailIfCalledAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    throw new Error('model must not be called for invalid identity')
  }
}

async function finalHarness(adapter: LlmAdapter): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(AgentDefaultModelConfig, { provider: 'wire-test', model: 'wire-model' })
  ctx.llm.registerAdapter(['wire-test'], adapter)
  contexts.push(ctx)
  return ctx
}

async function readyFactFixture(): Promise<{
  readonly directory: string
  readonly candidateUrl: string
  readonly packagePath: string
}> {
  const directory = await temporaryDirectory()
  const candidateUrl = 'https://x.com/alice/status/1'
  const factResult = createTrustedFact({
    target: {
      id: 'x-status:1',
      content: 'current trusted fact',
      source: candidateUrl,
      scope: 'this candidate',
    },
    dimension: 'content_value',
    reason: 'user supplied current fact',
    evidence: { kind: 'user_direct', rawUserExpression: 'remember this current fact' },
  })
  if (!factResult.ok) throw new Error(factResult.message)
  const repository = new FileTrustedFactRepository(directory)
  expect(repository.append(factResult.fact)).toMatchObject({ ok: true })
  const sources = createFileProjectionSources(directory)
  const snapshot = sources.facts.readLocatedSnapshot()
  const located = snapshot.facts[0]
  if (located === undefined) throw new Error('fixture fact was not persisted')
  new FileNavigationSnapshotStore(directory).replace({
    schemaVersion: 1,
    sourceRevision: snapshot.sourceRevision,
    items: [{
      schemaVersion: 1,
      kind: 'trusted-fact-navigation',
      origin: 'machine-derived',
      derivation: { method: 'provider-test', version: '1' },
      locator: located.locator,
      hints: {
        topics: ['agentic systems'],
        targetRefs: [{ targetId: 'x-status:1', canonicalSource: candidateUrl }],
        dimension: 'content_value',
        relations: [{ kind: 'about-target', targetId: 'x-status:1' }],
      },
    }],
  })
  return { directory, candidateUrl, packagePath: join(directory, 'x_insight_package.json') }
}

async function emptyAlignedFactFixture(): Promise<{
  readonly directory: string
  readonly candidateUrl: string
  readonly packagePath: string
}> {
  const directory = await temporaryDirectory()
  const candidateUrl = 'https://x.com/alice/status/1'
  const sources = createFileProjectionSources(directory)
  new FileNavigationSnapshotStore(directory).replace({
    schemaVersion: 1,
    sourceRevision: sources.facts.readLocatedSnapshot().sourceRevision,
    items: [],
  })
  return { directory, candidateUrl, packagePath: join(directory, 'x_insight_package.json') }
}

describe('dsh-x-feed/v1 cron provider composition boundary', () => {
  it('registers one exact marker with only per-run Agent requirements', () => {
    const provider = createXFeedCronEnvironmentProvider({
      ctx: {} as never,
      cronJobId: 'cron-x',
      dataDir: '/tmp/x-provider',
      pythonBin: 'python3',
      pipelinePath: '/pkg/python/x_insight_pipeline.py',
    })

    expect(provider.marker).toBe(X_CRON_AGENT_ENVIRONMENT_MARKER)
    expect(provider.requirements).toEqual(X_CRON_ENVIRONMENT_REQUIREMENTS)
    expect(provider.marker).toBe('dsh-x-feed/v1')
  })

  it('is loaded as a business provider and its host registration is disposable', async () => {
    const directory = await temporaryDirectory()
    const registry = createCronAgentEnvironmentRegistry()
    const provider = createCronEnvironmentExtension({
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    } as never, {
      cronJobId: 'cron-x',
      dataDir: directory,
      pythonBin: 'python3',
      pipelinePath: '/pkg/python/x_insight_pipeline.py',
      personalFeedDataDir: join(directory, 'personal-feed'),
      personalFeedRequiredSources: ['x'],
      candidateReportingWindowMs: 300_000,
    })
    const dispose = registry.register(provider)
    expect(registry.resolve(X_CRON_AGENT_ENVIRONMENT_MARKER)).toMatchObject({ ok: true })
    dispose()
    expect(registry.resolve(X_CRON_AGENT_ENVIRONMENT_MARKER)).toMatchObject({
      ok: false,
      error: { code: 'missing_provider' },
    })
    expect(() => createCronEnvironmentExtension({ logger: console } as never, {}))
      .toThrow('requires cronJobId')
  })

  it('checks the exact persisted job id before any preflight or Python side effect', async () => {
    const directory = await temporaryDirectory()
    const python = runner()
    const provider = createXFeedCronEnvironmentProvider({
      ctx: {} as never,
      cronJobId: 'cron-x',
      dataDir: directory,
      pythonBin: 'python3',
      pipelinePath: '/pkg/python/x_insight_pipeline.py',
      run: python.run,
    })

    await expect(provider.prepare({ jobId: 'other-job', runId: 'cron-x@once' })).rejects.toThrow(/job id mismatch/)
    expect(python.run).not.toHaveBeenCalled()
    expect(existsSync(join(directory, '.runs'))).toBe(false)
  })

  it('fails preflight closed with zero scrape/search/assessment/model/prepare/shown activity', async () => {
    const directory = await temporaryDirectory()
    // Leave navigation absent: source availability, rather than empty facts,
    // is the preflight failure being exercised here.
    const python = runner()
    const agents = { create: vi.fn() }
    const provider = createXFeedCronEnvironmentProvider({
      ctx: { agents } as never,
      cronJobId: 'cron-x',
      dataDir: directory,
      pythonBin: 'python3',
      pipelinePath: '/pkg/python/x_insight_pipeline.py',
      run: python.run,
    })

    await expect(provider.prepare({ jobId: 'cron-x', runId: 'cron-x@once' })).rejects.toThrow(/preflight/)
    expect(agents.create).not.toHaveBeenCalled()
    expect(python.run).not.toHaveBeenCalled()
    expect(existsSync(join(directory, '.runs'))).toBe(false)
    expect(existsSync(join(directory, 'x_insight_package.json'))).toBe(false)
    expect(existsSync(join(directory, 'x_shown.json'))).toBe(false)
  })

  it('returns the typed skip for an empty package without planner/composer/prepare activity', async () => {
    const { directory, packagePath } = await readyFactFixture()
    const python = runner()
    const readFile = vi.fn(async (path: string) => {
      if (path !== packagePath) throw new Error(`unexpected artifact read: ${path}`)
      return JSON.stringify({ recent_items: [], selected_urls: [], decision: {} })
    })
    const provider = createXFeedCronEnvironmentProvider({
      ctx: {} as never,
      cronJobId: 'cron-x',
      dataDir: directory,
      pythonBin: 'python3',
      pipelinePath: '/pkg/python/x_insight_pipeline.py',
      run: python.run,
      readFile,
    })

    await expect(provider.prepare({ jobId: 'cron-x', runId: 'cron-x@empty' })).resolves.toEqual({
      kind: 'skip', outcome: { text: undefined, error: undefined },
    })
    expect(python.calls).toHaveLength(1)
    expect(readFile).toHaveBeenCalledWith(packagePath, expect.any(Number))
  })

  it('wires exactly one fresh planner and one scheduler composer, then prepares the pending theme', async () => {
    const { directory, candidateUrl, packagePath } = await emptyAlignedFactFixture()
    const python = runner()
    const readFile = vi.fn(async (path: string) => {
      if (path !== packagePath) throw new Error(`unexpected artifact read: ${path}`)
      return JSON.stringify({
        allowed_topics: ['agentic systems'],
        recent_items: [{ id: '1', url: candidateUrl, text: 'current candidate body', topics: ['agentic systems'] }],
        selected_urls: [candidateUrl],
        decision: { top_theme: 'agentic systems' },
      })
    })
    const adapter = new TwoCallProviderAdapter()
    const ctx = await finalHarness(adapter)
    const provider = createXFeedCronEnvironmentProvider({
      ctx,
      cronJobId: 'cron-x',
      dataDir: directory,
      pythonBin: 'python3',
      pipelinePath: '/pkg/python/x_insight_pipeline.py',
      run: python.run,
      readFile,
    })

    const lease = await provider.prepare({ jobId: 'cron-x', runId: 'cron-x@two-call' })
    if (lease.kind === 'skip') throw new Error('ready fixture unexpectedly skipped')
    const handle = await ctx.agents.create({
      sessionId: SessionId('provider-composer-session'),
      agentOptions: { provider: 'wire-test', model: 'wire-model' },
      setup: async agentCtx => {
        installModelSelection(agentCtx, { current: { provider: 'wire-test', model: 'wire-model' }, assembled: undefined })
        await lease.setupAgent(agentCtx)
      },
    })
    try {
      await lease.verifySurface(handle.agent)
      const firstSeq = handle.agent.session.seq
      handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'drive provider composition' }],
        source: { kind: 'plugin', plugin: 'dsh-cron' },
      }))
      await handle.agent.whenIdle()
      const outcome = summarizeTurn(handle.agent.session.events, firstSeq)
      const finalized = await lease.finalizeOutcome!(outcome)

      expect(adapter.requests).toHaveLength(2)
      expect(adapter.requests.filter(request => request.system.includes('planner Agent'))).toHaveLength(1)
      expect(adapter.requests.filter(request => request.system.includes('composer Agent'))).toHaveLength(1)
      expect(adapter.requests.some(request => request.system.includes('assessment Agent'))).toBe(false)
      expect(adapter.requests.some(request => request.system.includes('投递 Agent'))).toBe(false)
      expect(new Set(adapter.requests.map(request => String(request.sessionId))).size).toBe(2)
      expect(finalized.text).toContain('📦 X 洞察 provider title')
      expect(python.calls).toHaveLength(2)
      const prepareArgs = python.calls.at(-1)?.args ?? []
      expect(prepareArgs).toEqual(expect.arrayContaining(['--pending-theme', 'agentic systems', '--last-theme', `${directory}/x_last_theme.json`]))
      expect(prepareArgs).not.toContain('set-theme')
    } finally {
      await handle.dispose()
      await lease.dispose()
    }
  })

  it('uses a mixed theme for a nonempty unclassified random-walk batch without inventing a search topic', async () => {
    const { directory, candidateUrl, packagePath } = await emptyAlignedFactFixture()
    const python = runner()
    const readFile = vi.fn(async (path: string) => {
      if (path !== packagePath) throw new Error(`unexpected artifact read: ${path}`)
      return JSON.stringify({
        recent_items: [{ id: '1', url: candidateUrl, text: 'an uncategorized random-walk candidate' }],
        selected_urls: [candidateUrl],
        decision: { top_theme: null, themes: {} },
      })
    })
    const adapter = new TwoCallProviderAdapter('mixed')
    const ctx = await finalHarness(adapter)
    const provider = createXFeedCronEnvironmentProvider({
      ctx,
      cronJobId: 'cron-x',
      dataDir: directory,
      pythonBin: 'python3',
      pipelinePath: '/pkg/python/x_insight_pipeline.py',
      run: python.run,
      readFile,
    })

    const lease = await provider.prepare({ jobId: 'cron-x', runId: 'cron-x@mixed-theme' })
    if (lease.kind === 'skip') throw new Error('nonempty unclassified fixture unexpectedly skipped')
    const plannerRequest = adapter.requests.find(request => request.system.includes('planner Agent'))
    const plannerText = plannerRequest?.messages[0]?.content.find(block => block.type === 'text')
    expect(plannerText).toMatchObject({ type: 'text' })
    if (plannerText?.type !== 'text') throw new Error('planner material is missing')
    const plannerMaterial = JSON.parse(plannerText.text.slice(plannerText.text.indexOf('\n') + 1)) as {
      allowedThemes: readonly string[]
      allowedTopics: readonly string[]
    }
    expect(plannerMaterial).toMatchObject({ allowedThemes: ['mixed'], allowedTopics: [] })

    const handle = await ctx.agents.create({
      sessionId: SessionId('provider-mixed-composer-session'),
      agentOptions: { provider: 'wire-test', model: 'wire-model' },
      setup: async agentCtx => {
        installModelSelection(agentCtx, { current: { provider: 'wire-test', model: 'wire-model' }, assembled: undefined })
        await lease.setupAgent(agentCtx)
      },
    })
    try {
      await lease.verifySurface(handle.agent)
      const firstSeq = handle.agent.session.seq
      handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'drive mixed provider composition' }],
        source: { kind: 'plugin', plugin: 'dsh-cron' },
      }))
      await handle.agent.whenIdle()
      const finalized = await lease.finalizeOutcome!(summarizeTurn(handle.agent.session.events, firstSeq))

      expect(adapter.requests).toHaveLength(2)
      expect(finalized.text).toContain('📦 X 洞察 provider title')
      expect(python.calls).toHaveLength(2)
      expect(python.calls.at(-1)?.args).toEqual(expect.arrayContaining(['--pending-theme', 'mixed']))
      expect(python.calls.some(call => call.args.includes('search-topic'))).toBe(false)
    } finally {
      await handle.dispose()
      await lease.dispose()
    }
  })

  it('mechanically searches one unfamiliar graph topic and admits its result into the composer', async () => {
    const { directory, candidateUrl, packagePath } = await emptyAlignedFactFixture()
    const searchUrl = 'https://x.com/bob/status/2'
    const python = runner()
    const readFile = vi.fn(async (path: string) => {
      if (path === packagePath) {
        return JSON.stringify({
          recent_items: [{ id: '1', url: candidateUrl, text: 'repeated AI candidate' }],
          selected_urls: [candidateUrl],
          decision: {
            top_theme: 'ai', themes: { ai: 1 }, flooded: true, same_as_last: true,
            random_roll: 0, random_hit: true, wander_suggested: true,
          },
          explore_candidates: [{
            topic: 'anime', hop: 1, from_anchor: 'ai-agent', via: 'creative-tools',
            bridge: 'creative-tools → anime', explored_count: 0, last_explored_ts: null,
            familiarity: 'new', cooldown_ok: true, cooldown_remaining_s: 0, recently_explored: false,
          }],
        })
      }
      if (path.endsWith('/topic-search.jsonl')) {
        return `${JSON.stringify({ id: '2', url: searchUrl, text: 'a genuinely different anime discovery', topic: 'anime' })}\n`
      }
      throw new Error(`unexpected artifact read: ${path}`)
    })
    const adapter = new TwoCallProviderAdapter('ai', 'item:x-status:2')
    const ctx = await finalHarness(adapter)
    const provider = createXFeedCronEnvironmentProvider({
      ctx,
      cronJobId: 'cron-x',
      dataDir: directory,
      pythonBin: 'python3',
      pipelinePath: '/pkg/python/x_insight_pipeline.py',
      run: python.run,
      readFile,
    })

    const lease = await provider.prepare({ jobId: 'cron-x', runId: 'cron-x@mechanical-random-walk' })
    if (lease.kind === 'skip') throw new Error('random-walk fixture unexpectedly skipped')
    const handle = await ctx.agents.create({
      sessionId: SessionId('provider-random-walk-composer-session'),
      agentOptions: { provider: 'wire-test', model: 'wire-model' },
      setup: async agentCtx => {
        installModelSelection(agentCtx, { current: { provider: 'wire-test', model: 'wire-model' }, assembled: undefined })
        await lease.setupAgent(agentCtx)
      },
    })
    try {
      await lease.verifySurface(handle.agent)
      const firstSeq = handle.agent.session.seq
      handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'drive mechanical random walk' }],
        source: { kind: 'plugin', plugin: 'dsh-cron' },
      }))
      await handle.agent.whenIdle()
      const finalized = await lease.finalizeOutcome!(summarizeTurn(handle.agent.session.events, firstSeq))

      expect(adapter.requests).toHaveLength(2)
      expect(python.calls.filter(call => call.args.some(arg => arg.endsWith('/x_topic_search.py')))).toHaveLength(1)
      expect(python.calls.some(call => call.args.includes('anime'))).toBe(true)
      expect(finalized.text).toContain(searchUrl)
      expect(python.calls.at(-1)?.args).toEqual(expect.arrayContaining(['--pending-theme', 'anime']))
    } finally {
      await handle.dispose()
      await lease.dispose()
    }
  })

  it('falls back to one non-dominant current candidate when the topic graph has no route', async () => {
    const { directory, candidateUrl, packagePath } = await emptyAlignedFactFixture()
    const alternateUrl = 'https://x.com/bob/status/2'
    const python = runner()
    const readFile = vi.fn(async (path: string) => {
      if (path === packagePath) {
        return JSON.stringify({
          recent_items: [
            { id: '1', url: candidateUrl, text: 'repeated AI candidate' },
            { id: '2', url: alternateUrl, text: 'an unrelated everyday discovery' },
          ],
          selected_urls: [candidateUrl, alternateUrl],
          decision: {
            top_theme: 'ai', themes: { ai: 1 }, flooded: true, same_as_last: true,
            random_roll: 0, random_hit: true, wander_suggested: true,
            candidates: [{ url: alternateUrl, text: 'an unrelated everyday discovery', theme: null }],
          },
          explore_candidates: [],
        })
      }
      if (path.endsWith('/x_explore/x-status:2.txt')) {
        return `TITLE: alternate details\nURL: ${alternateUrl}\n\nalternate expanded body\nLINKS:\n${alternateUrl}\n`
      }
      throw new Error(`unexpected artifact read: ${path}`)
    })
    const adapter = new TwoCallProviderAdapter('ai', 'item:x-status:2')
    const ctx = await finalHarness(adapter)
    const provider = createXFeedCronEnvironmentProvider({
      ctx,
      cronJobId: 'cron-x',
      dataDir: directory,
      pythonBin: 'python3',
      pipelinePath: '/pkg/python/x_insight_pipeline.py',
      run: python.run,
      readFile,
    })

    const lease = await provider.prepare({ jobId: 'cron-x', runId: 'cron-x@candidate-random-walk' })
    if (lease.kind === 'skip') throw new Error('candidate random-walk fixture unexpectedly skipped')
    const handle = await ctx.agents.create({
      sessionId: SessionId('provider-candidate-walk-composer-session'),
      agentOptions: { provider: 'wire-test', model: 'wire-model' },
      setup: async agentCtx => {
        installModelSelection(agentCtx, { current: { provider: 'wire-test', model: 'wire-model' }, assembled: undefined })
        await lease.setupAgent(agentCtx)
      },
    })
    try {
      await lease.verifySurface(handle.agent)
      const firstSeq = handle.agent.session.seq
      handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'drive candidate random walk' }],
        source: { kind: 'plugin', plugin: 'dsh-cron' },
      }))
      await handle.agent.whenIdle()
      const finalized = await lease.finalizeOutcome!(summarizeTurn(handle.agent.session.events, firstSeq))

      expect(adapter.requests).toHaveLength(2)
      expect(python.calls.filter(call => call.args.some(arg => arg.endsWith('/x_explorer.py')))).toHaveLength(1)
      expect(python.calls.filter(call => call.args.some(arg => arg.endsWith('/x_topic_search.py')))).toHaveLength(0)
      expect(finalized.text).toContain(alternateUrl)
      expect(python.calls.at(-1)?.args).toEqual(expect.arrayContaining(['--pending-theme', 'mixed']))
    } finally {
      await handle.dispose()
      await lease.dispose()
    }
  })

  it('rejects an explicitly empty theme allowlist instead of silently using mixed', async () => {
    const { directory, candidateUrl, packagePath } = await emptyAlignedFactFixture()
    const python = runner()
    const readFile = vi.fn(async (path: string) => {
      if (path !== packagePath) throw new Error(`unexpected artifact read: ${path}`)
      return JSON.stringify({
        allowed_themes: [],
        recent_items: [{ id: '1', url: candidateUrl, text: 'candidate with a malformed explicit allowlist' }],
        selected_urls: [candidateUrl],
        decision: { top_theme: null, themes: {} },
      })
    })
    const adapter = new FailIfCalledAdapter()
    const ctx = await finalHarness(adapter)
    const provider = createXFeedCronEnvironmentProvider({
      ctx,
      cronJobId: 'cron-x',
      dataDir: directory,
      pythonBin: 'python3',
      pipelinePath: '/pkg/python/x_insight_pipeline.py',
      run: python.run,
      readFile,
    })

    await expect(provider.prepare({ jobId: 'cron-x', runId: 'cron-x@invalid-theme-allowlist' }))
      .rejects.toThrow(/bounded theme/u)
    expect(adapter.requests).toHaveLength(0)
    expect(python.calls).toHaveLength(1)
  })

  it('uses the shared status identity parser for canonical and invalid package URLs', () => {
    expect(parseXStatusIdentity('https://twitter.com/Alice/status/1')).toEqual({
      statusId: '1', canonicalUrl: 'https://x.com/alice/status/1', itemId: 'item:x-status:1',
    })
    for (const value of ['https://x.com/alice/status/01', 'https://x.com/alice/status/1?x=1', 'https://x.com/alice/photo/1']) {
      expect(parseXStatusIdentity(value)).toBeUndefined()
    }
  })

  it('composes a bounded package without carrying legacy history into planner/composer', async () => {
    const { directory, candidateUrl, packagePath } = await readyFactFixture()
    const legacyPackageMarker = 'legacy-package-state-marker'
    const legacyPackageState = legacyPackageMarker.repeat(1_500)
    const packageSource = 'https://x.com/Alice/status/1'
    const packageValue = {
      allowed_topics: ['agentic systems'],
      recent_items: [{
        id: '1',
        url: packageSource,
        text: 'current candidate body',
        topics: ['agentic systems'],
      }],
      selected_urls: [packageSource],
      decision: { top_theme: 'agentic systems' },
      feedback_context: legacyPackageState,
      preferences: { legacyPackageState },
      graph: { legacyPackageState },
      raw_history: [legacyPackageState],
    }
    const python = runner()
    const readFile = vi.fn(async (path: string) => {
      if (path !== packagePath) throw new Error(`unexpected artifact read: ${path}`)
      return JSON.stringify(packageValue)
    })
    const adapter = new TwoCallProviderAdapter()
    const ctx = await finalHarness(adapter)
    const provider = createXFeedCronEnvironmentProvider({
      ctx,
      cronJobId: 'cron-x',
      dataDir: directory,
      pythonBin: 'python3',
      pipelinePath: '/pkg/python/x_insight_pipeline.py',
      run: python.run,
      readFile,
    })

    const lease = await provider.prepare({ jobId: 'cron-x', runId: 'cron-x@ready' })
    expect(python.calls).toHaveLength(1)
    expect(python.calls[0]?.args).toContain('--batch-out')
    expect(readFile).toHaveBeenCalledWith(packagePath, expect.any(Number))
    expect(adapter.requests.filter(request => request.system?.includes('planner Agent'))).toHaveLength(1)

    const sessionId = SessionId('provider-actual-composer-session')
    const handle = await ctx.agents.create({
      sessionId,
      agentOptions: { provider: 'wire-test', model: 'wire-model' },
      setup: async agentCtx => {
        installModelSelection(agentCtx, { current: { provider: 'wire-test', model: 'wire-model' }, assembled: undefined })
        await lease.setupAgent(agentCtx)
      },
    })
    try {
      await lease.verifySurface(handle.agent)
      const firstSeq = handle.agent.session.seq
      handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'drive provider composition run' }],
        source: { kind: 'plugin', plugin: 'dsh-cron' },
      }))
      await handle.agent.whenIdle()
      const outcome = summarizeTurn(handle.agent.session.events, firstSeq)
      const finalized = await lease.finalizeOutcome?.(outcome)

      const plannerRequests = adapter.requests.filter(request => request.system?.includes('planner Agent'))
      const composerRequests = adapter.requests.filter(request => request.system?.includes('composer Agent'))
      expect(plannerRequests).toHaveLength(1)
      expect(composerRequests).toHaveLength(1)
      expect(new Set(adapter.requests.map(request => request.sessionId)).size).toBe(2)
      expect(composerRequests[0]?.sessionId).toBe(String(handle.agent.session.id))
      expect(python.calls).toHaveLength(2)
      expect(finalized?.text).toContain('📦 X 洞察 provider title')
      expect(outcome.error).toBeUndefined()
      expect(JSON.stringify(adapter.requests)).not.toContain(legacyPackageMarker)
      expect(JSON.stringify(adapter.requests)).not.toContain(candidateUrl)
      expect(JSON.stringify(adapter.requests)).not.toContain(packageSource)
    } finally {
      await handle.dispose()
      await lease.dispose()
    }
  })

  it('normalizes raw multiline candidate text before exactly one planner wire', async () => {
    const { directory, candidateUrl, packagePath } = await emptyAlignedFactFixture()
    const python = runner()
    const rawPackage = {
      allowed_topics: ['agentic systems'],
      recent_items: [{
        id: '1',
        url: candidateUrl,
        text: `第一行\n第二行\r\n  中文   内容\t尾部${' 中文'.repeat(600)}`,
        topics: ['agentic systems'],
      }],
      selected_urls: [candidateUrl],
      decision: { top_theme: 'agentic systems' },
    }
    const rawPackageJson = JSON.stringify(rawPackage)
    const readFile = vi.fn(async (path: string) => {
      if (path !== packagePath) throw new Error(`unexpected artifact read: ${path}`)
      return rawPackageJson
    })
    const adapter = new TwoCallProviderAdapter()
    const ctx = await finalHarness(adapter)
    const provider = createXFeedCronEnvironmentProvider({
      ctx,
      cronJobId: 'cron-x',
      dataDir: directory,
      pythonBin: 'python3',
      pipelinePath: '/pkg/python/x_insight_pipeline.py',
      run: python.run,
      readFile,
    })

    const lease = await provider.prepare({ jobId: 'cron-x', runId: 'cron-x@raw-multiline' })
    try {
      expect(lease).toHaveProperty('setupAgent')
      expect(adapter.requests).toHaveLength(1)
      const wireMessage = JSON.parse(JSON.stringify(adapter.requests[0]?.messages[0])) as {
        content?: readonly { readonly type?: unknown; readonly text?: unknown }[]
      }
      const wireText = wireMessage.content?.find(block => block.type === 'text')?.text
      if (typeof wireText !== 'string') throw new Error('planner request omitted its text material')
      const plannerMaterial = JSON.parse(wireText.slice(wireText.indexOf('\n') + 1)) as {
        candidates: readonly { readonly title: string; readonly summary: string }[]
      }
      const candidate = plannerMaterial.candidates[0]
      if (candidate === undefined) throw new Error('planner request omitted its candidate')
      for (const [field, maxBytes] of [['title', 320], ['summary', 1_200]] as const) {
        const value = candidate[field]
        expect(Buffer.byteLength(value, 'utf8')).toBeLessThanOrEqual(maxBytes)
        expect(Buffer.from(value, 'utf8').toString('utf8')).toBe(value)
        expect(value).not.toMatch(/[\u0000-\u001f\u007f]/u)
        expect(value).not.toMatch(/https?:\/\/|ftp:\/\/|www\.|`|\*\*|__|\[[^\]]+\]\(/u)
      }
      expect(candidate.title).toContain('第一行 第二行 中文 内容 尾部')
      expect(candidate.summary).toContain('第一行 第二行 中文 内容 尾部')
      expect(JSON.stringify(rawPackage)).toBe(rawPackageJson)
    } finally {
      await lease.dispose?.()
    }
  })

  it.each([
    ['bare schemes separated by whitespace', 'http://\nhttps:// ftp:// www.'],
    ['complete URL', 'https://x.com/alice/status/99'],
    ['scheme followed by punctuation', 'http://, https://. ftp://! www.)'],
  ] as const)('removes %s while preserving ordinary http text', async (_label, marker) => {
    const { directory, candidateUrl, packagePath } = await emptyAlignedFactFixture()
    const python = runner()
    const rawPackage = {
      allowed_topics: ['agentic systems'],
      recent_items: [{
        id: '1',
        url: candidateUrl,
        text: `ordinary http text ${marker} remains useful`,
        topics: ['agentic systems'],
      }],
      selected_urls: [candidateUrl],
      decision: { top_theme: 'agentic systems' },
    }
    const rawPackageJson = JSON.stringify(rawPackage)
    const readFile = vi.fn(async (path: string) => {
      if (path !== packagePath) throw new Error(`unexpected artifact read: ${path}`)
      return rawPackageJson
    })
    const adapter = new TwoCallProviderAdapter()
    const ctx = await finalHarness(adapter)
    const provider = createXFeedCronEnvironmentProvider({
      ctx,
      cronJobId: 'cron-x',
      dataDir: directory,
      pythonBin: 'python3',
      pipelinePath: '/pkg/python/x_insight_pipeline.py',
      run: python.run,
      readFile,
    })

    const lease = await provider.prepare({ jobId: 'cron-x', runId: `cron-x/url-${_label}` })
    try {
      expect(lease).toHaveProperty('setupAgent')
      expect(adapter.requests).toHaveLength(1)
      const wireMessage = JSON.parse(JSON.stringify(adapter.requests[0]?.messages[0])) as {
        content?: readonly { readonly type?: unknown; readonly text?: unknown }[]
      }
      const wireText = wireMessage.content?.find(block => block.type === 'text')?.text
      if (typeof wireText !== 'string') throw new Error('planner request omitted its text material')
      const plannerMaterial = JSON.parse(wireText.slice(wireText.indexOf('\n') + 1)) as {
        candidates: readonly { readonly title: string; readonly summary: string }[]
      }
      const candidate = plannerMaterial.candidates[0]
      if (candidate === undefined) throw new Error('planner request omitted its candidate')
      for (const value of [candidate.title, candidate.summary]) {
        expect(value).not.toMatch(/(?:https?:\/\/|ftp:\/\/|www\.)/iu)
        expect(value).not.toMatch(/[\u0000-\u001f\u007f]/u)
      }
      expect(candidate.title).toContain('ordinary http text')
      expect(candidate.summary).toContain('ordinary http text')
      expect(JSON.stringify(rawPackage)).toBe(rawPackageJson)
    } finally {
      await lease.dispose?.()
    }
  })

  it('keeps all 20 parsed candidates inside the strict planner text bounds without mutating raw JSON', async () => {
    const { directory, candidateUrl, packagePath } = await emptyAlignedFactFixture()
    const python = runner()
    const rawPackage = {
      allowed_topics: ['agentic systems'],
      recent_items: Array.from({ length: 20 }, (_, index) => ({
        id: String(index + 1),
        url: `https://x.com/alice/status/${index + 1}`,
        text: `candidate ${index + 1}: ordinary http text http://\nhttps:// ftp:// www. https://x.com/alice/status/99 http://,`,
        topics: ['agentic systems'],
        title: `title ${index + 1}: ordinary http text http://`,
        summary: `summary ${index + 1}: ordinary http text https://`,
      })),
      selected_urls: [candidateUrl],
      decision: { top_theme: 'agentic systems' },
    }
    const rawPackageJson = JSON.stringify(rawPackage)
    const readFile = vi.fn(async (path: string) => {
      if (path !== packagePath) throw new Error(`unexpected artifact read: ${path}`)
      return rawPackageJson
    })
    const adapter = new TwoCallProviderAdapter()
    const ctx = await finalHarness(adapter)
    const provider = createXFeedCronEnvironmentProvider({
      ctx,
      cronJobId: 'cron-x',
      dataDir: directory,
      pythonBin: 'python3',
      pipelinePath: '/pkg/python/x_insight_pipeline.py',
      run: python.run,
      readFile,
    })

    const lease = await provider.prepare({ jobId: 'cron-x', runId: 'cron-x/twenty-candidates' })
    try {
      expect(lease).toHaveProperty('setupAgent')
      expect(adapter.requests).toHaveLength(1)
      const wireMessage = JSON.parse(JSON.stringify(adapter.requests[0]?.messages[0])) as {
        content?: readonly { readonly type?: unknown; readonly text?: unknown }[]
      }
      const wireText = wireMessage.content?.find(block => block.type === 'text')?.text
      if (typeof wireText !== 'string') throw new Error('planner request omitted its text material')
      const plannerMaterial = JSON.parse(wireText.slice(wireText.indexOf('\n') + 1)) as {
        candidates: readonly { readonly id: string; readonly title: string; readonly summary: string }[]
      }
      expect(plannerMaterial.candidates).toHaveLength(20)
      for (const candidate of plannerMaterial.candidates) {
        for (const [value, maxBytes] of [[candidate.title, 320], [candidate.summary, 1_200]] as const) {
          expect(typeof value).toBe('string')
          expect(value).toBe(value.trim())
          expect(value).not.toBe('')
          expect(Buffer.byteLength(value, 'utf8')).toBeLessThanOrEqual(maxBytes)
          expect(value).not.toMatch(/(?:https?:\/\/|ftp:\/\/|www\.)/iu)
          expect(value).not.toMatch(/!?(?:\[[^\]]*\]\([^)]*\)|`{1,3}|\*\*|__|^\s{0,3}#{1,6}\s|(?:^|\s)[*+-]\s)/mu)
          expect(value).not.toMatch(/[\u0000-\u001f\u007f]/u)
        }
      }
      expect(JSON.stringify(rawPackage)).toBe(rawPackageJson)
    } finally {
      await lease.dispose?.()
    }
  })

  it.each([
    ['pre-prefixed', 'x-status:1'],
    ['non-digit', 'alice'],
    ['leading-zero', '01'],
    ['mismatched', '2'],
    ['surrounding-whitespace', ' 1 '],
  ] as const)('rejects %s candidate identity before any model Agent creation', async (_label, rawId) => {
    const { directory, candidateUrl, packagePath } = await readyFactFixture()
    const python = runner()
    const readFile = vi.fn(async (path: string) => {
      if (path !== packagePath) throw new Error(`unexpected artifact read: ${path}`)
      return JSON.stringify({
        allowed_topics: ['agentic systems'],
        recent_items: [{ id: rawId, url: candidateUrl, text: 'invalid identity candidate' }],
        selected_urls: [candidateUrl],
        decision: { top_theme: 'agentic systems' },
      })
    })
    const adapter = new FailIfCalledAdapter()
    const ctx = await finalHarness(adapter)
    const provider = createXFeedCronEnvironmentProvider({
      ctx,
      cronJobId: 'cron-x',
      dataDir: directory,
      pythonBin: 'python3',
      pipelinePath: '/pkg/python/x_insight_pipeline.py',
      run: python.run,
      readFile,
    })

    await expect(provider.prepare({ jobId: 'cron-x', runId: `cron-x@invalid-${_label}` }))
      .rejects.toThrow(/canonical status id/u)
    expect(python.calls).toHaveLength(1)
    expect(adapter.requests).toHaveLength(0)
  })
})
