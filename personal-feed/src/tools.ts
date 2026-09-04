/**
 * Personal Feed model tools, registered ONLY on the Telegram interactive
 * root: `personal_feed_record_feedback` and `personal_feed_list_saved`.
 *
 * Feedback goes to the local append-only ledger, never to the X account,
 * never to long-term canary memory, and never creates commitments/cron jobs.
 * @module @herman/personal-feed
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  XFeedbackStore,
  type FeedbackWriteResult,
  type SavedItem,
  type XFeedbackEvent,
} from './store.ts'

/** Input of personal_feed_record_feedback. */
export interface RecordFeedbackInput {
  operation: 'save' | 'unsave'
  url?: string
  title?: string
  note?: string
}

/** Output of personal_feed_record_feedback. */
export type RecordFeedbackOutput =
  | { readonly ok: true; readonly event: XFeedbackEvent }
  | { readonly ok: false; readonly code: string; readonly message: string }

/** Output of personal_feed_list_saved. */
export interface ListSavedOutput {
  readonly items: SavedItem[]
}

/** Stable tool error value for list failures. */
export interface ListSavedError {
  readonly code: 'list_failed'
  readonly message: string
}

function renderValue(_args: unknown, value: unknown): ContentBlock[] {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

function toToolError(result: FeedbackWriteResult): RecordFeedbackOutput {
  if (result.ok) return result
  return { ok: false, code: result.code, message: result.message }
}

/** Register both tools on the tool context of the interactive root. */
export function registerPersonalFeedTools(
  toolCtx: { tools: { register(def: unknown): () => void } },
  deps: { store: XFeedbackStore; logger: { warn(message: string): void } },
): () => void {
  const disposers: Array<() => void> = []

  disposers.push(toolCtx.tools.register(defineTool({
    name: 'personal_feed_record_feedback',
    description:
      '记录用户对 X 信息流具体内容的收藏/取消收藏（Harness 本地收藏账本）。'
      + 'like/dislike 不得通过本工具写入；必须由 Telegram clean feedback 与 TrustedFact 链处理。'
      + '用户明确收藏或取消收藏时调用；先定位目标再写入。'
      + '即使你认为该内容已经记录过，也必须调用本工具（写入是 append-only），不要凭空声称「已记录」或「无需记录」。'
      + '只有当前消息或当前 Telegram 引用能唯一定位 X URL、唯一序号或唯一标题时才写入；含多个 X URL 的引用里只说「这个/那条」时必须先问用户。'
      + '没有任何 X 线索的普通对话不调用本工具，也不根据会话历史猜。'
      + '写入失败必须如实返回错误，不能口头假称已记录。'
      + '具体单条 save/unsave 只进 X 收藏账本，不进长期记忆；不创建当前承诺、cron 或后台 worker。',
    parameters: {
      operation: {
        type: 'string',
        enum: ['save', 'unsave'],
        required: true,
        description: '收藏时传 save，取消收藏时传 unsave。',
      },
      url: { type: 'string', description: '明确指向具体推文时传（引用里只有一个 X URL 时可以直接定位）。' },
      title: { type: 'string', description: '能从引用消息可靠还原标题时传。' },
      note: { type: 'string', description: '用户表达的简短、具体理由，可省略。' },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              event: { type: 'json', required: true },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              code: { type: 'string', required: true },
              message: { type: 'string', required: true },
            },
          },
        ],
      },
      render: renderValue,
    },
    async execute(args: Record<string, unknown>): Promise<RecordFeedbackOutput> {
      const operation = args.operation
      if (operation !== 'save' && operation !== 'unsave') {
        return { ok: false, code: 'invalid_operation', message: 'operation 必须是 save|unsave' }
      }
      const result = deps.store.append({
        operation,
        ...(typeof args.url === 'string' ? { url: args.url } : {}),
        ...(typeof args.title === 'string' ? { title: args.title } : {}),
        ...(typeof args.note === 'string' ? { note: args.note } : {}),
      })
      return toToolError(result)
    },
    presentCall: (args: unknown) => ({
      card: 'generic',
      title: 'Personal Feed: record feedback',
      kind: 'other',
      rawInput: (args as Record<string, unknown>).operation as string | undefined,
    }),
  })))

  try {
    disposers.push(toolCtx.tools.register(defineTool({
    name: 'personal_feed_list_saved',
    description:
      '查询 Harness 本地收藏（稍后阅读）列表：fold 全部 save/unsave，默认返回最近 20 条仍处于 saved 的项目。'
      + '只返回 URL、title、savedAt 和必要 note；不启动浏览器、不访问 X、不修改外部账户。',
    parameters: {
      limit: { type: 'number', description: '最多返回条数，默认 20。' },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              items: { type: 'json', required: true },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              code: { type: 'string', required: true },
              message: { type: 'string', required: true },
            },
          },
        ],
      },
      render: renderValue,
    },
    async execute(args: Record<string, unknown>): Promise<ListSavedOutput | ListSavedError> {
      const limit = typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.floor(args.limit) : 20
      try {
        return { items: deps.store.listSaved(limit, message => deps.logger.warn(message)) }
      } catch (error) {
        return { code: 'list_failed', message: error instanceof Error ? error.message : String(error) }
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Personal Feed: list saved', kind: 'read' }),
    })))
  } catch (error) {
    const rollbackErrors: unknown[] = []
    try { disposers[0]?.() } catch (cleanupError) { rollbackErrors.push(cleanupError) }
    throw rollbackErrors.length === 0 ? error : new AggregateError([error, ...rollbackErrors])
  }

  let disposed = false
  let cleanupError: unknown
  return () => {
    if (disposed) {
      if (cleanupError !== undefined) throw cleanupError
      return
    }
    disposed = true
    const errors: unknown[] = []
    for (const dispose of [...disposers].reverse()) {
      try { dispose() } catch (error) { errors.push(error) }
    }
    cleanupError = errors.length === 1 ? errors[0] : errors.length > 1 ? new AggregateError(errors) : undefined
    if (cleanupError !== undefined) throw cleanupError
  }
}
