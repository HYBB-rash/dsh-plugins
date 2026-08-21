import { Context } from '@deepseek-ai/cordis'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { CallId, createAssistantMessage, createUserMessage, LlmAdapter, type GenerateOptions, type StreamChunk, type ToolSchema } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { summarizeTurn } from '@deepseek-ai/dsh-telegram-gateway'
import { afterEach, describe, expect, it } from 'vitest'
import {
  COMPOSER_SYSTEM_PROMPT,
  SUBMIT_X_CRON_COMPOSER,
  SUBMIT_X_CRON_COMPOSER_SCHEMA,
  XFeedComposerAgentSurface,
  type XFeedComposerMaterial,
} from '../src/x-cron/composer-agent.ts'

const material: XFeedComposerMaterial = {
  selectedItems: [{ itemId: 'item-1', title: '当前条目', summary: '一条当前条目摘要' }],
  exploration: { kind: 'none' },
  facts: [{ targetId: 'item-1', summary: '当前目标的精确事实' }],
  allowedSectionKinds: ['highlight', 'source'],
}

function response(value: unknown, callId = 'composer-1'): StreamChunk[] {
  const args = JSON.stringify(value)
  const id = CallId(callId)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name: SUBMIT_X_CRON_COMPOSER, argumentsDelta: args },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: SUBMIT_X_CRON_COMPOSER, arguments: args } },
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
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(AgentDefaultModelConfig, { provider: 'wire-test', model: 'wire-model' })
  ctx.llm.registerAdapter(['wire-test'], adapter)
  return ctx
}

async function drive(
  ctx: Context,
  surface: XFeedComposerAgentSurface,
  afterCapture?: (sessionId: SessionId) => void,
): Promise<{ readonly sessionId: SessionId; readonly firstSeq: number; readonly handle: Awaited<ReturnType<Context['agents']['create']>> }> {
  const sessionId = SessionId('session-cron-run-composer-1')
  const handle = await ctx.agents.create({
    sessionId,
    agentOptions: { provider: 'wire-test', model: 'wire-model' },
    setup: agentCtx => surface.setupAgent(agentCtx),
  })
  surface.capture(ctx, sessionId)
  afterCapture?.(sessionId)
  await surface.verifySurface(handle.agent)
  const firstSeq = handle.agent.session.seq
  handle.agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'composer driver' }],
    source: { kind: 'plugin', plugin: 'dsh-cron' },
  }))
  await handle.agent.whenIdle()
  return { sessionId, handle, firstSeq }
}

async function expectRejectedDto(dto: unknown, materialValue: XFeedComposerMaterial = material): Promise<void> {
  const original = structuredClone(dto)
  const adapter = new WireAdapter([response(dto)])
  const ctx = await harness(adapter)
  contexts.push(ctx)
  const surface = new XFeedComposerAgentSurface({ material: materialValue })
  const { handle, firstSeq } = await drive(ctx, surface)
  try {
    expect(() => surface.finalizeOutcome(summarizeTurn(handle.agent.session.events, firstSeq))).toThrow(/invalid|submission|outcome|unknown|allowlist|empty/u)
    expect(dto).toEqual(original)
    expect(surface.wires).toHaveLength(1)
    expect(adapter.requests).toHaveLength(1)
  } finally {
    surface.dispose()
    await ctx.sessions.flush(handle.agent.session)
    await handle.dispose()
  }
}

const contexts: Context[] = []
afterEach(async () => {
  while (contexts.length > 0) await contexts.pop()?.fiber.dispose()
})

describe('scheduler-owned X cron composer Agent surface', () => {
  it('keeps a failed exploration as explicit bounded composer material', () => {
    const failedMaterial: XFeedComposerMaterial = {
      ...material,
      exploration: { kind: 'search', topicId: 'topic-a', status: 'failed', summary: 'search unavailable' },
    }
    const surface = new XFeedComposerAgentSurface({ material: failedMaterial })
    try {
      expect(surface.materialText).toContain('"status":"failed"')
      expect(surface.materialText).toContain('"summary":"search unavailable"')
      expect(surface.materialText).not.toMatch(/https?:\/\//u)
    } finally {
      surface.dispose()
    }
  })

  it('uses the scheduler session unchanged, one wire, one submit tool, and JSON DTO outcome', async () => {
    const dto = {
      title: '本轮洞察',
      sections: [{ kind: 'highlight', items: [{ itemId: 'item-1', summary: '当前条目摘要' }] }],
    }
    const adapter = new WireAdapter([response(dto)])
    const ctx = await harness(adapter)
    contexts.push(ctx)
    const oldSession = ctx.sessions.create(SessionId('ordinary-old-composer-session'))
    oldSession.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: 'OLD-COMPOSER-HISTORY-MARKER' }],
        source: { provider: 'wire-test', model: 'wire-model' },
      }),
    }, { surfaceOp: 'append', sourceEventSeqs: [] })
    const surface = new XFeedComposerAgentSurface({ material })
    const { sessionId, handle, firstSeq } = await drive(ctx, surface)
    try {
      const summarized = summarizeTurn(handle.agent.session.events, firstSeq)
      expect(summarized.text).toBe(JSON.stringify(dto))
      const outcome = surface.finalizeOutcome(summarized)
      expect(outcome).toEqual(dto)
      expect(surface.sessionId).toBe(sessionId)
      expect(surface.wires).toHaveLength(1)
      expect(adapter.requests).toHaveLength(1)
      expect(adapter.requests[0]?.sessionId).toBe(sessionId)
      expect(adapter.requests[0]?.tools?.map(tool => tool.name)).toEqual([SUBMIT_X_CRON_COMPOSER])
      expect(adapter.requests[0]?.system).toBe(COMPOSER_SYSTEM_PROMPT)
      expect(adapter.requests[0]?.tools?.[0]).toEqual(SUBMIT_X_CRON_COMPOSER_SCHEMA)
      expect(JSON.stringify(adapter.requests[0])).not.toMatch(/https?:\/\/|`|\*\*|\[[^\]]+\]\(/u)
      expect(JSON.stringify(adapter.requests[0])).not.toContain('OLD-COMPOSER-HISTORY-MARKER')
    } finally {
      surface.dispose()
      await ctx.sessions.flush(handle.agent.session)
      await handle.dispose()
    }
  })

  it('accepts the real composer summary with an inline plus sign in one wire', async () => {
    const summary = '一个用 GPT Image 2 + Minimax H3 组合的工作流示例：通过详细分镜脚本提示词，生成阳光客厅里胖橘猫与穿黄色背带裤 4 岁女孩追逐打闹的 15 秒写实多镜头序列，展示文生视频的多模态叙事能力。'
    const dto = {
      title: '从 2 万美元机器人到全球芯片荒：AI 超级周期的惊人胃口',
      sections: [{ kind: 'wander', items: [{ itemId: 'item-1', summary }] }],
    }
    const adapter = new WireAdapter([response(dto)])
    const ctx = await harness(adapter)
    contexts.push(ctx)
    const surface = new XFeedComposerAgentSurface({ material: { ...material, allowedSectionKinds: ['wander'] } })
    const { handle, firstSeq } = await drive(ctx, surface)
    try {
      const summarized = summarizeTurn(handle.agent.session.events, firstSeq)
      expect(summarized.text).toBe(JSON.stringify(dto))
      expect(surface.finalizeOutcome(summarized)).toEqual(dto)
      expect(surface.wires).toHaveLength(1)
      expect(adapter.requests).toHaveLength(1)
    } finally {
      surface.dispose()
      await ctx.sessions.flush(handle.agent.session)
      await handle.dispose()
    }
  })

  it('UTF8-safely bounds an over-limit summary before strict DTO parsing', async () => {
    const rawSummary = '中'.repeat(135) + 'ab'
    expect(new TextEncoder().encode(rawSummary).byteLength).toBe(407)
    const rawTitle = '中'.repeat(55) + 'ab'
    expect(new TextEncoder().encode(rawTitle).byteLength).toBe(167)
    const dto = {
      title: rawTitle,
      sections: [{ kind: 'highlight', items: [{ itemId: 'item-1', summary: rawSummary }] }],
    }
    const original = structuredClone(dto)
    const projected = {
      title: '中'.repeat(53),
      sections: [{ kind: 'highlight', items: [{ itemId: 'item-1', summary: '中'.repeat(133) }] }],
    }
    const adapter = new WireAdapter([response(dto)])
    const ctx = await harness(adapter)
    contexts.push(ctx)
    const surface = new XFeedComposerAgentSurface({ material })
    const { handle, firstSeq } = await drive(ctx, surface)
    try {
      const summarized = summarizeTurn(handle.agent.session.events, firstSeq)
      expect(summarized.text).toBe(JSON.stringify(projected))
      expect(surface.finalizeOutcome(summarized)).toEqual(projected)
      expect(dto).toEqual(original)
      expect(surface.wires).toHaveLength(1)
      expect(adapter.requests).toHaveLength(1)
    } finally {
      surface.dispose()
      await ctx.sessions.flush(handle.agent.session)
      await handle.dispose()
    }
  })

  it('keeps the first occurrence of an item across sections, drops empty sections, and preserves the raw DTO', async () => {
    const dto = {
      title: '本轮洞察',
      sections: [
        { kind: 'highlight', items: [{ itemId: 'item-1', summary: '首次摘要' }] },
        { kind: 'source', items: [{ itemId: 'item-1', summary: '第二摘要' }] },
        { kind: 'timeline', items: [{ itemId: 'item-1', summary: '第三摘要' }] },
        { kind: 'focus', items: [{ itemId: 'item-1', summary: '第四摘要' }] },
      ],
    }
    const original = structuredClone(dto)
    const adapter = new WireAdapter([response(dto)])
    const ctx = await harness(adapter)
    contexts.push(ctx)
    const surface = new XFeedComposerAgentSurface({ material: {
      ...material,
      allowedSectionKinds: ['highlight', 'source', 'timeline', 'focus'],
    } })
    const { handle, firstSeq } = await drive(ctx, surface)
    try {
      const projected = {
        title: '本轮洞察',
        sections: [{ kind: 'highlight', items: [{ itemId: 'item-1', summary: '首次摘要' }] }],
      }
      const summarized = summarizeTurn(handle.agent.session.events, firstSeq)
      expect(summarized.text).toBe(JSON.stringify(projected))
      expect(surface.finalizeOutcome(summarized)).toEqual(projected)
      expect(dto).toEqual(original)
      expect(surface.wires).toHaveLength(1)
      expect(adapter.requests).toHaveLength(1)
    } finally {
      surface.dispose()
      await ctx.sessions.flush(handle.agent.session)
      await handle.dispose()
    }
  })

  it('keeps only the first duplicate in one section', async () => {
    const dto = {
      title: '本轮洞察',
      sections: [{
        kind: 'highlight',
        items: [
          { itemId: 'item-1', summary: '首次摘要' },
          { itemId: 'item-1', summary: '重复摘要' },
        ],
      }],
    }
    const original = structuredClone(dto)
    const adapter = new WireAdapter([response(dto)])
    const ctx = await harness(adapter)
    contexts.push(ctx)
    const surface = new XFeedComposerAgentSurface({ material })
    const { handle, firstSeq } = await drive(ctx, surface)
    try {
      const projected = {
        title: '本轮洞察',
        sections: [{ kind: 'highlight', items: [{ itemId: 'item-1', summary: '首次摘要' }] }],
      }
      const summarized = summarizeTurn(handle.agent.session.events, firstSeq)
      expect(summarized.text).toBe(JSON.stringify(projected))
      expect(surface.finalizeOutcome(summarized)).toEqual(projected)
      expect(dto).toEqual(original)
      expect(adapter.requests).toHaveLength(1)
    } finally {
      surface.dispose()
      await ctx.sessions.flush(handle.agent.session)
      await handle.dispose()
    }
  })

  it('fails closed for unknown IDs, keys, kinds, unsafe text, and all-empty sections', async () => {
    await expectRejectedDto({
      title: '本轮洞察',
      sections: [{ kind: 'highlight', items: [{ itemId: 'item-1', summary: '摘要' }] }],
      extra: 'unknown',
    })
    await expectRejectedDto({
      title: '本轮洞察',
      sections: [
        { kind: 'highlight', items: [{ itemId: 'item-1', summary: '首次摘要' }] },
        { kind: 'source', items: [{ itemId: 'item-1', summary: '越权重复摘要' }] },
      ],
    }, { ...material, allowedSectionKinds: ['highlight'] })
    await expectRejectedDto({
      title: '本轮洞察',
      sections: [{ kind: 'highlight', items: [{ itemId: 'item-1', summary: '摘要' }], extra: 'unknown' }],
    })
    await expectRejectedDto({
      title: '本轮洞察',
      sections: [{ kind: 'highlight', items: [{ itemId: 'outside', summary: '越权条目' }] }],
    })
    await expectRejectedDto({
      title: '本轮洞察',
      sections: [{ kind: 'highlight', items: [{ itemId: 'item-1', summary: '摘要', extra: 'unknown' }] }],
    })
    await expectRejectedDto({
      title: '本轮洞察',
      sections: [{ kind: 'invalid-kind', items: [{ itemId: 'item-1', summary: '摘要' }] }],
    })
    await expectRejectedDto({
      title: '本轮洞察',
      sections: [{ kind: 'highlight', items: [{ itemId: 'item-1', summary: 'https://example.com' }] }],
    })
    await expectRejectedDto({
      title: '本轮洞察',
      sections: [{ kind: 'highlight', items: [{ itemId: 'item-1', summary: '内容\n- 列表' }] }],
    })
    await expectRejectedDto({
      title: '本轮洞察',
      sections: [{ kind: 'highlight', items: [{ itemId: 'item-1', summary: '含\u0000控制' }] }],
    })
    await expectRejectedDto({
      title: '本轮洞察',
      sections: [{ kind: 'highlight', items: [] }],
    })
  })

  it('fails closed for malformed or overreaching DTOs without a second wire', async () => {
    const adapter = new WireAdapter([response({
      title: '本轮洞察',
      sections: [{ kind: 'highlight', items: [{ itemId: 'outside', summary: '越权条目' }] }],
    })])
    const ctx = await harness(adapter)
    contexts.push(ctx)
    const surface = new XFeedComposerAgentSurface({ material })
    const { handle, firstSeq } = await drive(ctx, surface)
    try {
      expect(() => surface.finalizeOutcome(summarizeTurn(handle.agent.session.events, firstSeq))).toThrow(/invalid|submission|outcome|unknown|allowlist/u)
      expect(surface.wires).toHaveLength(1)
      expect(adapter.requests).toHaveLength(1)
    } finally {
      surface.dispose()
      await ctx.sessions.flush(handle.agent.session)
      await handle.dispose()
    }
  })

  it('stops the wire waterfall before the adapter when an upstream listener contaminates the request', async () => {
    const adapter = new WireAdapter([response({
      title: '本轮洞察',
      sections: [{ kind: 'highlight', items: [{ itemId: 'item-1', summary: '当前条目摘要' }] }],
    })])
    const ctx = await harness(adapter)
    contexts.push(ctx)
    const surface = new XFeedComposerAgentSurface({ material })
    const { handle, firstSeq } = await drive(ctx, surface, actualSessionId => {
      ctx.on('llm/stream', (request, next) => {
        if (request.sessionId === actualSessionId && request.tools !== undefined) {
          const tools = request.tools as ToolSchema[]
          tools.push({ name: 'polluted_tool', description: 'pollution', parameters: { type: 'object' } })
        }
        return next()
      })
    })
    try {
      expect(adapter.requests).toHaveLength(0)
      expect(() => surface.finalizeOutcome(summarizeTurn(handle.agent.session.events, firstSeq))).toThrow(/contaminated|outcome|request/u)
    } finally {
      surface.dispose()
      await ctx.sessions.flush(handle.agent.session)
      await handle.dispose()
    }
  })

  it('does not open a second model request when the first response submits no DTO', async () => {
    const adapter = new WireAdapter([textResponse('普通文本但没有 composer DTO')])
    const ctx = await harness(adapter)
    contexts.push(ctx)
    const surface = new XFeedComposerAgentSurface({ material })
    const { handle, firstSeq } = await drive(ctx, surface)
    try {
      expect(adapter.requests).toHaveLength(1)
      const outcome = summarizeTurn(handle.agent.session.events, firstSeq)
      expect(outcome.text).toBe('普通文本但没有 composer DTO')
      expect(() => surface.finalizeOutcome(outcome)).toThrow(/submission|outcome|DTO/u)
    } finally {
      surface.dispose()
      await ctx.sessions.flush(handle.agent.session)
      await handle.dispose()
    }
  })
})
