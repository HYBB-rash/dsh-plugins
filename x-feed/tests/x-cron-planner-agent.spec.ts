import { Context } from '@deepseek-ai/cordis'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { ToolCallId, createUserMessage, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PLANNER_SYSTEM_PROMPT,
  SUBMIT_X_CRON_PLANNER,
  SUBMIT_X_CRON_PLANNER_SCHEMA,
  projectPlannerSubmission,
  runXCronPlanner,
  type XCronPlannerRequest,
} from '../src/x-cron/planner-agent.ts'

const candidate = { id: 'candidate-1', title: '一条候选', summary: '当前候选摘要' } as const
const request: XCronPlannerRequest = {
  candidates: [candidate],
  allowedThemes: ['theme-1'],
  allowedTopics: ['topic-1'],
  allowlistedExploreIds: ['candidate-1'],
  mechanicalSignals: { contentAvailable: true, candidateCount: 1 },
}

function response(value: unknown, callId = 'planner-1'): StreamChunk[] {
  const args = JSON.stringify(value)
  const id = ToolCallId(callId)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name: SUBMIT_X_CRON_PLANNER, argumentsDelta: args },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: SUBMIT_X_CRON_PLANNER, arguments: args } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

class WireAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly script: StreamChunk[][]) { super() }
  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  override async *stream(requestValue: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(requestValue)
    for (const chunk of this.script.shift() ?? []) yield chunk
  }
}

async function harness(adapter: WireAdapter): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(AgentDefaultModelConfig, { provider: 'wire-test', model: 'wire-model' })
  ctx.llm.registerAdapter(['wire-test'], adapter)
  return ctx
}

const contexts: Context[] = []
afterEach(async () => {
  while (contexts.length > 0) await contexts.pop()?.fiber.dispose()
})

describe('one-shot X cron planner Agent', () => {
  it('returns a strict DTO from one fresh isolated model request', async () => {
    const adapter = new WireAdapter([response({
      selectedCandidateIds: ['candidate-1'],
      themeId: 'theme-1',
      exploration: { kind: 'search', topicId: 'topic-1' },
    })])
    const ctx = await harness(adapter)
    contexts.push(ctx)

    const result = await runXCronPlanner(ctx, request)

    expect(result?.dto).toEqual({
      selectedCandidateIds: ['candidate-1'],
      themeId: 'theme-1',
      exploration: { kind: 'search', topicId: 'topic-1' },
    })
    expect(result?.sessionId).toMatch(/^session-x-planner-[0-9a-f-]+$/u)
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]?.tools?.map(tool => tool.name)).toEqual([SUBMIT_X_CRON_PLANNER])
    expect(adapter.requests[0]?.system).toBe(PLANNER_SYSTEM_PROMPT)
    expect(adapter.requests[0]?.tools?.[0]).toEqual(SUBMIT_X_CRON_PLANNER_SCHEMA)
    expect(JSON.stringify(adapter.requests[0])).not.toMatch(/https?:\/\/|`|\*\*|\[[^\]]+\]\(/u)
  })

  it('keeps a successful submit when the harness emits a post-submit empty internal stream', async () => {
    const adapter = new WireAdapter([response({
      selectedCandidateIds: ['candidate-1'],
      themeId: 'theme-1',
      exploration: { kind: 'none' },
    })])
    const ctx = await harness(adapter)
    contexts.push(ctx)
    const events: string[] = []
    const observedWires: Array<{ readonly keys: string[]; readonly sessionId: string | undefined; readonly system: string | undefined; readonly tools: number | undefined }> = []
    let injected = false
    let injectedStream: Promise<void> | undefined
    ctx.on('agent/pre-step', (_payload, next) => {
      events.push('agent/pre-step')
      return next()
    })
    ctx.on('llm/stream', (wire, next) => {
      observedWires.push({ keys: Object.keys(wire), sessionId: wire.sessionId, system: wire.system, tools: wire.tools?.length })
      events.push('llm/stream')
      return next()
    })
    ctx.on('session/event', (session, event) => {
      events.push(event.type)
      if (event.type !== 'tool/result' || injected) return
      injected = true
      injectedStream = (async () => {
        for await (const _chunk of ctx.llm.stream({
          provider: 'wire-test',
          model: 'wire-model',
          messages: [],
          sessionId: session.id,
        })) { /* the structured surface must short-circuit this internal call */ }
      })()
    })

    const result = await runXCronPlanner(ctx, request)
    await injectedStream
    expect(result.dto.exploration).toEqual({ kind: 'none' })
    expect(observedWires).toHaveLength(2)
    expect(observedWires[0]?.keys).toEqual(['provider', 'model', 'messages', 'system', 'tools', 'sessionId', 'signal'])
    expect(observedWires[0]?.system).toBe(PLANNER_SYSTEM_PROMPT)
    expect(observedWires[0]?.tools).toBe(1)
    expect(observedWires[1]).toEqual({
      keys: ['provider', 'model', 'messages', 'sessionId'],
      sessionId: result.sessionId,
      system: undefined,
      tools: undefined,
    })
    expect(events.indexOf('llm/stream')).toBeLessThan(events.indexOf('tool/call'))
    expect(events.lastIndexOf('llm/stream')).toBeGreaterThan(events.indexOf('tool/result'))
    expect(events.at(-1)).toBe('turn/end')
    expect(adapter.requests).toHaveLength(1)
  })

  it('rejects a second pre-step before it can reach llm/stream or the adapter', async () => {
    const adapter = new WireAdapter([textResponse('首步没有提交 DTO')])
    const ctx = await harness(adapter)
    contexts.push(ctx)
    let steered = false
    let stepStarts = 0
    ctx.on('session/event', (_session, event) => {
      if (event.type === 'step/start') stepStarts += 1
    })
    ctx.on('agent/turn-stopping', ({ agent }) => {
      if (!steered) {
        steered = true
        agent.steer(createUserMessage({
          content: [{ type: 'text', text: 'second pre-step probe' }],
          source: { kind: 'plugin', plugin: 'test' },
        }))
      }
    })

    await expect(runXCronPlanner(ctx, request)).rejects.toThrow(/second pre-step|invalid-submission|cancelled/u)
    expect(adapter.requests).toHaveLength(1)
    expect(stepStarts).toBe(1)
  })

  it('projects the real three-key explore submission before strict parsing', async () => {
    const adapter = new WireAdapter([response({
      selectedCandidateIds: ['candidate-1'],
      themeId: 'theme-1',
      exploration: { kind: 'explore', topicId: 'stale-union-field', candidateId: 'candidate-1' },
    })])
    const ctx = await harness(adapter)
    contexts.push(ctx)

    await expect(runXCronPlanner(ctx, request)).resolves.toMatchObject({
      dto: {
        selectedCandidateIds: ['candidate-1'],
        themeId: 'theme-1',
        exploration: { kind: 'explore', candidateId: 'candidate-1' },
      },
    })
    expect(adapter.requests).toHaveLength(1)
  })

  it('projects the symmetric three-key search submission before strict parsing', async () => {
    const adapter = new WireAdapter([response({
      selectedCandidateIds: ['candidate-1'],
      themeId: 'theme-1',
      exploration: { kind: 'search', topicId: 'topic-1', candidateId: 'stale-union-field' },
    })])
    const ctx = await harness(adapter)
    contexts.push(ctx)

    await expect(runXCronPlanner(ctx, request)).resolves.toMatchObject({
      dto: {
        selectedCandidateIds: ['candidate-1'],
        themeId: 'theme-1',
        exploration: { kind: 'search', topicId: 'topic-1' },
      },
    })
    expect(adapter.requests).toHaveLength(1)
  })

  it('canonicalizes a topic-only explore submission to search with one request', async () => {
    const adapter = new WireAdapter([response({
      selectedCandidateIds: ['candidate-1'],
      themeId: 'theme-1',
      exploration: { kind: 'explore', topicId: 'crypto' },
    })])
    const ctx = await harness(adapter)
    contexts.push(ctx)
    const canonicalRequest = { ...request, allowedTopics: ['topic-1', 'crypto'] }

    await expect(runXCronPlanner(ctx, canonicalRequest)).resolves.toMatchObject({
      dto: { exploration: { kind: 'search', topicId: 'crypto' } },
    })
    expect(adapter.requests).toHaveLength(1)
  })

  it('canonicalizes a candidate-only search submission to explore with one request', async () => {
    const adapter = new WireAdapter([response({
      selectedCandidateIds: ['candidate-1'],
      themeId: 'theme-1',
      exploration: { kind: 'search', candidateId: 'candidate-1' },
    })])
    const ctx = await harness(adapter)
    contexts.push(ctx)

    await expect(runXCronPlanner(ctx, request)).resolves.toMatchObject({
      dto: { exploration: { kind: 'explore', candidateId: 'candidate-1' } },
    })
    expect(adapter.requests).toHaveLength(1)
  })

  it.each([
    [{ kind: 'explore', candidateId: 'candidate-1', topicId: '' }, { kind: 'explore', candidateId: 'candidate-1' }],
    [{ kind: 'search', topicId: 'topic-1', candidateId: '' }, { kind: 'search', topicId: 'topic-1' }],
  ] as const)('drops only an empty stale union field', async (exploration, expected) => {
    const adapter = new WireAdapter([response({
      selectedCandidateIds: ['candidate-1'],
      themeId: 'theme-1',
      exploration,
    })])
    const ctx = await harness(adapter)
    contexts.push(ctx)

    await expect(runXCronPlanner(ctx, request)).resolves.toMatchObject({ dto: { exploration: expected } })
    expect(adapter.requests).toHaveLength(1)
  })

  it('rejects a non-none exploration without a target and rejects canonicalized targets outside their allowlists', async () => {
    const submissions = [
      { kind: 'search' },
      { kind: 'explore' },
      { kind: 'explore', url: 'https://x.com/status/1' },
      { kind: 'explore', topicId: 'outside-topic' },
      { kind: 'search', candidateId: 'outside-candidate' },
    ]
    const adapter = new WireAdapter(submissions.map((exploration, index) => response({
      selectedCandidateIds: ['candidate-1'],
      themeId: 'theme-1',
      exploration,
    }, `canonical-invalid-${index}`)))
    const ctx = await harness(adapter)
    contexts.push(ctx)

    for (const _submission of submissions) {
      await expect(runXCronPlanner(ctx, request)).rejects.toThrow(/invalid|unknown|allowlist|unexpected/u)
    }
    expect(adapter.requests).toHaveLength(submissions.length)
  })

  it('keeps strict rejection for none, unknown keys, and unsafe union remnants', async () => {
    const submissions = [
      { kind: 'none', topicId: 'topic-1' },
      { kind: 'none', candidateId: 'candidate-1' },
      { kind: 'explore', candidateId: 'candidate-1', url: 'https://x.com/status/1' },
      { kind: 'explore', candidateId: 'candidate-1', query: 'plain query' },
      { kind: 'search', topicId: 'topic-1', instructions: 'plain instructions' },
      { kind: 'explore', candidateId: 'candidate-1', topicId: 'https://x.com/status/1' },
      { kind: 'search', topicId: 'topic-1', candidateId: '[link](https://x.com/1)' },
      { kind: 'explore', candidateId: 'candidate-1', topicId: '\u0001' },
      { kind: 'search', topicId: 'topic-1', candidateId: { value: 'candidate-1' } },
    ]
    const adapter = new WireAdapter(submissions.map((exploration, index) => response({
      selectedCandidateIds: ['candidate-1'],
      themeId: 'theme-1',
      exploration,
    }, `invalid-${index}`)))
    const ctx = await harness(adapter)
    contexts.push(ctx)

    for (const _submission of submissions) {
      await expect(runXCronPlanner(ctx, request)).rejects.toThrow(/invalid|unexpected|URL|Markdown/u)
    }
    expect(adapter.requests).toHaveLength(submissions.length)
  })

  it('keeps unknown top-level submission keys visible to the strict parser', async () => {
    const adapter = new WireAdapter([response({
      selectedCandidateIds: ['candidate-1'],
      themeId: 'theme-1',
      exploration: { kind: 'none' },
      unexpected: 'leak',
    })])
    const ctx = await harness(adapter)
    contexts.push(ctx)

    await expect(runXCronPlanner(ctx, request)).rejects.toThrow(/unknown|invalid/u)
    expect(adapter.requests).toHaveLength(1)
  })

  it('projects into new objects without mutating the raw submission', () => {
    const raw = {
      selectedCandidateIds: ['candidate-1'],
      themeId: 'theme-1',
      exploration: { kind: 'explore', topicId: 'stale-union-field', candidateId: 'candidate-1' },
    }
    const before = structuredClone(raw)

    const projected = projectPlannerSubmission(raw)

    expect(raw).toEqual(before)
    expect(projected).not.toBe(raw)
    expect((projected as typeof raw).exploration).not.toBe(raw.exploration)
    expect(projected).toEqual({
      selectedCandidateIds: ['candidate-1'],
      themeId: 'theme-1',
      exploration: { kind: 'explore', candidateId: 'candidate-1' },
    })

    const canonicalRaw = {
      selectedCandidateIds: ['candidate-1'],
      themeId: 'theme-1',
      exploration: { kind: 'explore', topicId: 'topic-1' },
    }
    const canonicalBefore = structuredClone(canonicalRaw)
    const canonicalProjected = projectPlannerSubmission(canonicalRaw)
    expect(canonicalRaw).toEqual(canonicalBefore)
    expect(canonicalProjected).toEqual({
      selectedCandidateIds: ['candidate-1'],
      themeId: 'theme-1',
      exploration: { kind: 'search', topicId: 'topic-1' },
    })
  })

  it('rejects an empty candidate set without a model request', async () => {
    const adapter = new WireAdapter([])
    const ctx = await harness(adapter)
    contexts.push(ctx)
    await expect(runXCronPlanner(ctx, { ...request, candidates: [], mechanicalSignals: { contentAvailable: false, candidateCount: 0 } }))
      .rejects.toThrow(/non-empty|candidate/u)
    expect(adapter.requests).toHaveLength(0)
  })

  it('fails closed for unknown IDs and does not make a second request', async () => {
    const adapter = new WireAdapter([response({
      selectedCandidateIds: ['outside'],
      themeId: 'theme-1',
      exploration: { kind: 'none' },
    })])
    const ctx = await harness(adapter)
    contexts.push(ctx)
    await expect(runXCronPlanner(ctx, request)).rejects.toThrow(/allowlist|unknown|invalid/u)
    expect(adapter.requests).toHaveLength(1)
  })

  it('fails closed for unknown theme, topic, schema, and URL-bearing candidate input before model creation', async () => {
    const adapter = new WireAdapter([
      response({ selectedCandidateIds: ['candidate-1'], themeId: 'other-theme', exploration: { kind: 'none' } }, 'bad-theme'),
      response({ selectedCandidateIds: ['candidate-1'], themeId: 'theme-1', exploration: { kind: 'search', topicId: 'other-topic' } }, 'bad-topic'),
    ])
    const ctx = await harness(adapter)
    contexts.push(ctx)
    await expect(runXCronPlanner(ctx, request)).rejects.toThrow(/theme|allow|invalid/u)
    await expect(runXCronPlanner(ctx, request)).rejects.toThrow(/topic|allow|invalid/u)
    await expect(runXCronPlanner(ctx, { ...request, unexpected: 'history' } as never)).rejects.toThrow(/unknown|invalid/u)
    await expect(runXCronPlanner(ctx, {
      ...request,
      candidates: [{ id: candidate.id, title: candidate.title, summary: 'https://x.com/status/1' }],
    })).rejects.toThrow(/candidate|invalid/u)
    await expect(runXCronPlanner(ctx, {
      ...request,
      candidates: [{ id: candidate.id, content: '替代字段' }],
    } as never)).rejects.toThrow(/shape|invalid/u)
    expect(adapter.requests).toHaveLength(2)
  })

  it('uses a new context-free session for every call', async () => {
    const adapter = new WireAdapter([
      response({ selectedCandidateIds: ['candidate-1'], themeId: 'theme-1', exploration: { kind: 'none' } }, 'one'),
      response({ selectedCandidateIds: ['candidate-1'], themeId: 'theme-1', exploration: { kind: 'none' } }, 'two'),
    ])
    const ctx = await harness(adapter)
    contexts.push(ctx)
    const first = await runXCronPlanner(ctx, request)
    const second = await runXCronPlanner(ctx, request)
    expect(second?.sessionId).not.toBe(first?.sessionId)
    expect(adapter.requests).toHaveLength(2)
    expect(adapter.requests[1]?.messages[0]?.content).toEqual(adapter.requests[0]?.messages[0]?.content)
  })
})
