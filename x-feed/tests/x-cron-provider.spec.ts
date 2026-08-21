import { createHash } from 'node:crypto'
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
import { SUBMIT_X_CRON_ASSESSMENT } from '../src/x-cron/assessment-agent.ts'
import { X_CRON_FINAL_LOOKUP_TOOL } from '../src/x-cron/final-agent.ts'
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
      return { stdout: '{"ok":true}\n', stderr: '', exitCode: 0 }
    }),
  }
}

function emptyNavigationRevision(): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(Buffer.alloc(0)).digest('hex')}`
}

const finalText = '📦 X 洞察\n\n⭐ 当前候选\n- 当前事实 (https://x.com/alice/status/1)'

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

function textReply(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

class ReadyProviderAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  lookupSucceeded = false
  private finalStep = 0

  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    if (request.system?.includes('assessment Agent') === true) {
      const message = request.messages[0]
      const block = message?.content[0]
      if (block?.type !== 'text') throw new Error('assessment request omitted its JSON envelope')
      const jsonStart = block.text.indexOf('\n')
      const material = JSON.parse(block.text.slice(jsonStart + 1)) as {
        readonly navigation: readonly { readonly locator: { readonly locatorId: string } }[]
      }
      const decisions = material.navigation.map((item, index) => ({
        locatorId: item.locator.locatorId,
        relevance: 'high',
        essentiality: 'lookup_only',
        priority: index + 1,
        reason: 'current candidate matches exact source key',
      }))
      yield* toolCall('assessment-submit', SUBMIT_X_CRON_ASSESSMENT, { decisions })
      return
    }
    this.finalStep += 1
    if (this.finalStep === 1) {
      yield* toolCall('project-call', 'x_feed_project_candidate_facts', { candidateId: 'x-status:1' })
      return
    }
    if (this.finalStep === 2) {
      const ticketId = projectionTicketId(request)
      yield* toolCall('lookup-call', X_CRON_FINAL_LOOKUP_TOOL, { ticketId })
      return
    }
    if (this.finalStep === 3) {
      const serialized = JSON.stringify(request.messages)
      if (!serialized.includes('lookup-success') || !serialized.includes('current trusted fact')) {
        throw new Error('final Agent did not receive the exact lookup result for the current candidate')
      }
      this.lookupSucceeded = true
      yield* toolCall('prepare-call', 'x_feed_prepare_delivery', {
        text: finalText,
        urls: ['https://x.com/alice/status/1'],
      })
      return
    }
    yield* textReply(finalText)
  }
}

function projectionTicketId(request: GenerateOptions): string {
  const match = /"ticketId":"([^"]+)"/u.exec(JSON.stringify(request.messages).replaceAll('\\"', '"'))
  if (match?.[1] !== undefined) return match[1]
  throw new Error('final Agent did not receive a projection ticket')
}

async function finalHarness(adapter: ReadyProviderAdapter): Promise<Context> {
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
    const sources = createFileProjectionSources(directory)
    new FileNavigationSnapshotStore(directory).replace({
      schemaVersion: 1,
      sourceRevision: sources.facts.readLocatedSnapshot().sourceRevision,
      items: [],
    })
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

  it('composes ready preflight, fixed Python package, real assessment/project, and a lease', async () => {
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
    const adapter = new ReadyProviderAdapter()
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
    expect(adapter.requests.filter(request => request.system?.includes('assessment Agent'))).toHaveLength(1)

    const sessionId = SessionId('provider-actual-final-session')
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
        content: [{ type: 'text', text: 'drive provider final run' }],
        source: { kind: 'plugin', plugin: 'dsh-cron' },
      }))
      await handle.agent.whenIdle()
      const outcome = summarizeTurn(handle.agent.session.events, firstSeq)
      lease.finalizeOutcome?.(outcome)

      const assessmentRequests = adapter.requests.filter(request => request.system?.includes('assessment Agent'))
      const finalRequests = adapter.requests.filter(request => request.system?.includes('一次性的 X 洞察投递 Agent'))
      expect(assessmentRequests).toHaveLength(1)
      expect(finalRequests).toHaveLength(4)
      expect(new Set(finalRequests.map(request => request.sessionId)).size).toBe(1)
      expect(finalRequests[0]?.sessionId).toBe(String(handle.agent.session.id))
      expect(python.calls).toHaveLength(2)
      expect(outcome.text).toBe(finalText)
      expect(outcome.error).toBeUndefined()
      expect(adapter.lookupSucceeded).toBe(true)
      expect(JSON.stringify(assessmentRequests)).not.toContain(legacyPackageMarker)
      expect(JSON.stringify(finalRequests)).not.toContain(legacyPackageMarker)
      expect(JSON.stringify(finalRequests)).toContain(candidateUrl)
      expect(JSON.stringify(finalRequests)).not.toContain(packageSource)
    } finally {
      await handle.dispose()
      await lease.dispose()
    }
  })

  it.each([
    ['pre-prefixed', 'x-status:1'],
    ['non-digit', 'alice'],
    ['leading-zero', '01'],
    ['mismatched', '2'],
    ['surrounding-whitespace', ' 1 '],
  ] as const)('rejects %s candidate identity before assessment or final Agent creation', async (_label, rawId) => {
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
    const adapter = new ReadyProviderAdapter()
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
