import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { RecordInput } from './domain.ts'
import { ExplorationStore } from './store.ts'

const render = (_args: unknown, value: unknown): ContentBlock[] => [{ type: 'text', text: JSON.stringify(value) }]
const object = (value: unknown): Record<string, unknown> => typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
const safeRecordMeta = (value: unknown): { ok: boolean; code?: string; state?: string } => { const v = object(value); const state = object(v.item).state; return v.ok === true ? { ok: true, ...(typeof state === 'string' ? { state } : {}) } : { ok: false, ...(typeof v.code === 'string' ? { code: v.code } : {}) } }
const safeRecordPresentationMeta = (value: unknown): { ok: boolean; code?: string; state?: string } => { const v = object(value); return v.ok === true ? { ok: true, ...(typeof v.state === 'string' ? { state: v.state } : {}) } : { ok: false, ...(typeof v.code === 'string' ? { code: v.code } : {}) } }

export function registerExploreTools(toolCtx: { tools: { register(definition: unknown): () => void } }, store: ExplorationStore): () => void {
  const disposers: Array<() => void> = []
  disposers.push(toolCtx.tools.register(defineTool({
    name: 'exploration_record',
    description: '在 Harness 本地探索账本中保留、排除或更新一个已查证主题。只在当前直接用户明确表达兴趣/没兴趣，或没有明确表态但已有具体证据时调用；失败时不得声称已保存。',
    parameters: { operation: { type: 'string', enum: ['keep', 'dismiss', 'update'], required: true }, itemId: { type: 'string' }, sourceUrl: { type: 'string' }, title: { type: 'string', required: true }, hook: { type: 'string' }, currentFinding: { type: 'string', required: true }, nextQuestion: { type: 'string' }, citations: { type: 'array', items: { type: 'string' } }, signal: { type: 'string', enum: ['explicit_interest', 'explicit_disinterest', 'assistant_judgment'], required: true } },
    output: { schema: { oneOf: [{ type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, created: { type: 'boolean', required: true }, eventId: { type: 'string', required: true }, item: { type: 'json', required: true }, integrity: { type: 'json', required: true } } }, { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, code: { type: 'string', required: true }, message: { type: 'string', required: true }, candidates: { type: 'json' }, attemptedEventId: { type: 'string' }, integrity: { type: 'json' } } }] }, render, presentationMeta: (_args: unknown, value: unknown) => safeRecordMeta(value) },
    execute: async (args: RecordInput): Promise<never> => await store.record(args) as never,
    presentCall: args => { const value = object(args); return { card: 'generic', title: value.operation === 'dismiss' ? '排除探索候选' : '更新探索候选', kind: 'edit', rawInput: { operation: value.operation, title: value.title } } },
    presentResult: (_args, result) => { const meta = safeRecordPresentationMeta((result as { meta?: unknown }).meta); return { card: 'generic', title: (result as { isError?: unknown }).isError === true ? '探索账本调用失败' : meta.ok ? meta.state === 'active' ? '已更新探索候选' : '已更新排除认识' : `探索账本未更新：${meta.code ?? 'unknown'}` } },
  })))
  disposers.push(toolCtx.tools.register(defineTool({
    name: 'exploration_query',
    description: '查询 Harness 本地探索候选。默认只返回仍值得探索的 active 条目；查询 dismissed/all 必须带精确主题。不会启动浏览器或修改账本。',
    parameters: { state: { type: 'string', enum: ['active', 'dismissed', 'all'] }, query: { type: 'string' }, limit: { type: 'integer', description: '1 到 20 的整数；省略时为 20。' } },
    output: { schema: { oneOf: [{ type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, items: { type: 'json', required: true }, total: { type: 'integer', required: true }, truncated: { type: 'boolean', required: true }, integrity: { type: 'json', required: true } } }, { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, code: { type: 'string', required: true }, message: { type: 'string', required: true } } }] }, render, presentationMeta: (args: unknown, value: unknown) => { const v = object(value); const state = object(args).state; return { ok: v.ok === true, state: typeof state === 'string' ? state : 'active', count: Array.isArray(v.items) ? v.items.length : 0, degraded: object(v.integrity).status === 'degraded' } } },
    execute: async (args: { state?: 'active' | 'dismissed' | 'all'; query?: string; limit?: number }): Promise<never> => await store.query(args) as never,
    presentCall: args => ({ card: 'generic', title: '查询探索候选', kind: 'read', rawInput: { state: object(args).state, query: object(args).query } }),
    presentResult: (_args, result) => { const meta = object((result as { meta?: unknown }).meta); return { card: 'generic', title: (result as { isError?: unknown }).isError === true ? '探索候选查询失败' : meta.ok === true ? `找到 ${typeof meta.count === 'number' ? meta.count : 0} 项探索候选` : '探索候选查询未完成' } },
  })))
  return () => { for (const dispose of disposers) dispose() }
}
