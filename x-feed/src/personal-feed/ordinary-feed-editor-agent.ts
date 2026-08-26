import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { OrdinaryFeedEditingProposalRuntime } from './ordinary-feed-editing-proposal.ts'
import { runOneShotStructuredAgent } from '../x-cron/one-shot-structured-agent.ts'

const SUBMIT_ORDINARY_FEED_EDITING_PROPOSAL = 'submit_x_ordinary_feed_editing_proposal'

const ORDINARY_FEED_EDITOR_SYSTEM_PROMPT = [
  '你是一次性的 X 普通 Feed 编辑 Agent。',
  '只能依据当前 user message 中的本期材料，为每个 itemId 做一次 selected 或 not_selected 决定。',
  `必须调用 ${SUBMIT_ORDINARY_FEED_EDITING_PROPOSAL} 一次，提交严格结构化编辑提案；不要输出普通文本。`,
  'selected 项必须且只能在 sections 中出现一次；not_selected 项必须提供非空 semanticReason。',
  '不得创造 itemId，不得返回网址、候选身份、period、Raw/C37/C15/C19、探索、主题、planner 或 composer 字段，也不得调用其他工具。',
].join('\n')

const ORDINARY_FEED_EDITOR_TOOL_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string' },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: ['highlight', 'timeline', 'wander', 'focus', 'source'] },
          items: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                itemId: { type: 'string' },
                summary: { type: 'string' },
              },
              required: ['itemId', 'summary'],
            },
          },
        },
        required: ['kind', 'items'],
      },
    },
    decisions: {
      type: 'array',
      items: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              itemId: { type: 'string' },
              kind: { type: 'string', enum: ['selected'] },
            },
            required: ['itemId', 'kind'],
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              itemId: { type: 'string' },
              kind: { type: 'string', enum: ['not_selected'] },
              semanticReason: { type: 'string' },
            },
            required: ['itemId', 'kind', 'semanticReason'],
          },
        ],
      },
    },
  },
  required: ['title', 'sections', 'decisions'],
} as const

export type OrdinaryFeedEditorAgentProposalPort = Pick<
  OrdinaryFeedEditingProposalRuntime,
  'readModelMaterials' | 'validateProposal'
>

export interface OrdinaryFeedEditorAgentOptions {
  readonly ctx: Context
  readonly proposal: OrdinaryFeedEditorAgentProposalPort
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

export type OrdinaryFeedEditorAgentResult =
  | { readonly status: 'accepted'; readonly value: { readonly proposal: unknown } }
  | { readonly status: 'failed' }

export interface OrdinaryFeedEditorAgent {
  readonly formEditingProposal: () => Promise<OrdinaryFeedEditorAgentResult>
}

export function createOrdinaryFeedEditorAgent(
  options: OrdinaryFeedEditorAgentOptions,
): OrdinaryFeedEditorAgent {
  return Object.freeze({
    formEditingProposal: async (): Promise<OrdinaryFeedEditorAgentResult> => {
      try {
        const materialResult = options.proposal.readModelMaterials()
        if (materialResult.status !== 'accepted') return { status: 'failed' }
        const result = await runOneShotStructuredAgent<unknown>({
          ctx: options.ctx,
          sessionPrefix: 'session-x-ordinary-feed-editor',
          promptSectionName: 'x-feed:ordinary-editor-system',
          systemPrompt: ORDINARY_FEED_EDITOR_SYSTEM_PROMPT,
          inputMessage: createUserMessage({
            content: [{
              type: 'text',
              text: `当前普通 Feed 编辑材料\n${JSON.stringify(materialResult.value.materials)}`,
            }],
            source: { kind: 'plugin', plugin: 'x-feed' },
          }),
          toolName: SUBMIT_ORDINARY_FEED_EDITING_PROPOSAL,
          toolDescription: '提交当前普通 Feed 的严格结构化编辑提案。',
          toolParameters: ORDINARY_FEED_EDITOR_TOOL_PARAMETERS,
          parseSubmission: value => {
            const validated = options.proposal.validateProposal(value)
            if (validated.status !== 'accepted') {
              throw new Error('ordinary Feed editing proposal was not accepted')
            }
            return value
          },
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        })
        return Object.freeze({
          status: 'accepted',
          value: Object.freeze({ proposal: result.value }),
        })
      } catch {
        return { status: 'failed' }
      }
    },
  })
}
