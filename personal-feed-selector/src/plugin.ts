/** Cordis composition root and root-scoped model tool. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { selectAttention, type SemanticJudge, type SelectionExecutionResult } from './core.ts'
import { createDshSemanticJudge } from './dsh-semantic-judge.ts'

export const PERSONAL_FEED_SELECT_ATTENTION_TOOL = 'personal_feed_select_attention'

export const inject = ['agents', 'tools', 'llm']

export interface Config {
  readonly mode: 'web' | 'telegram'
  readonly telegramParentSessionId?: string
  readonly timeoutMs?: number
}

export const Config: z<Config> = z.object({
  mode: z.union(['web', 'telegram'] as const).default('web'),
  telegramParentSessionId: z.string().default('session-telegram'),
  timeoutMs: z.number().step(1).min(1).default(30_000),
})

function renderResult(_args: unknown, value: unknown): ContentBlock[] {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

/** Register the one public selector operation on one qualified root scope. */
export function registerSelectionTool(
  toolCtx: Agent['ctx'],
  judge: SemanticJudge,
): () => void {
  return toolCtx.tools.register(defineTool({
    name: PERSONAL_FEED_SELECT_ATTENTION_TOOL,
    description:
      'Given the user\'s long-term interests, existing understanding, and X candidates, '
      + 'select exactly one supplied original URL with enough personal information gain, or return a genuine empty result. '
      + 'A failed status means judgment did not complete and must never be presented as empty.',
    parameters: {
      personalContext: {
        type: 'object',
        required: true,
        additionalProperties: false,
        properties: {
          longTermInterests: { type: 'string', required: true },
          existingUnderstanding: { type: 'string', required: true },
        },
      },
      candidates: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            url: { type: 'string', required: true },
            content: { type: 'string', required: true },
          },
        },
      },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: { type: 'string', required: true, const: 'completed' },
              outcome: { type: 'json', required: true },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: { type: 'string', required: true, const: 'failed' },
              code: { type: 'string', required: true },
            },
          },
        ],
      },
      render: renderResult,
    },
    async execute(args: Record<string, unknown>, exec: ToolRunContext): Promise<SelectionExecutionResult> {
      return selectAttention(args, judge, exec.signal)
    },
    presentCall: () => ({ card: 'generic', title: 'Select one attention target', kind: 'read' }),
  }))
}

type SelectionHost = Pick<Context, 'agents' | 'on' | 'llm'>

/** Install only on interactive roots, including future replacement roots. */
export function installSelectionTools(host: SelectionHost, config: Config): () => void {
  const installed = new Map<Agent, () => void>()
  let stopping = false
  const telegramRoot = config.telegramParentSessionId ?? 'session-telegram'

  const isQualifiedRoot = (agent: Agent): boolean => {
    if (!host.agents.roots().includes(agent) || agent.session.id === undefined) return false
    if (String(agent.session.id).startsWith('session-cron-')) return false
    return config.mode === 'web' || agent.session.id === telegramRoot
  }

  const install = (agent: Agent): void => {
    if (stopping || installed.has(agent) || !isQualifiedRoot(agent)) return
    const dispose = agent.ctx.effect(
      () => registerSelectionTool(
        agent.ctx,
        createDshSemanticJudge(host as Pick<Context, 'llm'>, agent, { timeoutMs: config.timeoutMs ?? 30_000 }),
      ),
      'personal-feed-selector.root()',
    )
    installed.set(agent, dispose)
  }

  for (const agent of host.agents.roots()) install(agent)
  const stopCreated = host.on('agent/created', ({ agent }) => install(agent))

  return () => {
    if (stopping) return
    stopping = true
    stopCreated()
    for (const dispose of installed.values()) dispose()
    installed.clear()
  }
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  await ctx.effect(() => installSelectionTools(ctx, config))
}
