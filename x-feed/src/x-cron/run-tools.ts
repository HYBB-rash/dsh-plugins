/**
 * The model-facing surface for one X cron run.
 *
 * The tool list is intentionally small and run-local. It has no shell, file,
 * session, browser, web-search, feedback, receipt, or shown-marking route.
 */

import {
  ToolArgsError,
  type JsonSchemaNode,
  type ToolDefinition,
  type ToolRunContext,
  validateJsonSchemaValue,
} from '@deepseek-ai/dsh-tools'
import type { XFeedInsightPackage, XFeedPreparedArtifact } from './python-ports.ts'

export type XFeedRunToolFailure = {
  readonly ok: false
  readonly code: string
  readonly message: string
}

export type XFeedRunToolSuccess = {
  readonly ok: true
  readonly [key: string]: unknown
}

export type XFeedRunToolResult = XFeedRunToolSuccess | XFeedRunToolFailure

export interface XFeedRunToolPort {
  searchTopic(topic: string, signal?: AbortSignal): Promise<XFeedInsightPackage | XFeedRunToolResult>
  exploreCandidate(candidateId: string, signal?: AbortSignal): Promise<XFeedInsightPackage | XFeedRunToolResult>
  setTheme(theme: string, signal?: AbortSignal): Promise<XFeedInsightPackage | XFeedRunToolResult>
  prepareDelivery(text: string, urls: readonly string[], signal?: AbortSignal): Promise<XFeedPreparedArtifact | XFeedRunToolResult>
}

const searchParameters: JsonSchemaNode = {
  type: 'object',
  properties: { topic: { type: 'string' } },
  required: ['topic'],
  additionalProperties: false,
}

const candidateParameters: JsonSchemaNode = {
  type: 'object',
  properties: { candidateId: { type: 'string' } },
  required: ['candidateId'],
  additionalProperties: false,
}

const themeParameters: JsonSchemaNode = {
  type: 'object',
  properties: { theme: { type: 'string' } },
  required: ['theme'],
  additionalProperties: false,
}

const prepareParameters: JsonSchemaNode = {
  type: 'object',
  properties: {
    text: { type: 'string' },
    urls: { type: 'array', items: { type: 'string' } },
  },
  required: ['text', 'urls'],
  additionalProperties: false,
}

const resultSchema: JsonSchemaNode = {
  type: 'object',
  additionalProperties: true,
}

function renderResult(_args: unknown, value: unknown) {
  return [{ type: 'text' as const, text: JSON.stringify(value) }]
}

function asFailure(error: unknown): XFeedRunToolFailure {
  const candidate = error as { code?: unknown; message?: unknown }
  return {
    ok: false,
    code: typeof candidate.code === 'string' ? candidate.code : 'run-failed',
    message: candidate.message instanceof Error
      ? candidate.message.message
      : typeof candidate.message === 'string' ? candidate.message : String(error),
  }
}

function resultFromPort(value: XFeedInsightPackage | XFeedPreparedArtifact | XFeedRunToolResult): XFeedRunToolResult {
  if (typeof value === 'object' && value !== null && 'ok' in value && value.ok === false) {
    return value as XFeedRunToolFailure
  }
  return { ok: true, result: value }
}

function strictTool(
  name: string,
  description: string,
  parameters: JsonSchemaNode,
  execute: (args: Record<string, unknown>, exec: ToolRunContext) => Promise<XFeedRunToolResult>,
): ToolDefinition {
  return {
    name,
    description,
    parameters: parameters as Record<string, unknown>,
    output: { schema: resultSchema, render: renderResult },
    async execute(args: unknown, exec: ToolRunContext): Promise<XFeedRunToolResult> {
      const violations = validateJsonSchemaValue(parameters, args, '')
      if (violations.length > 0) throw new ToolArgsError(violations)
      return execute(args as Record<string, unknown>, exec)
    },
  }
}

/** Create the exact model-visible tools for a single prepared X run. */
export function createXFeedRunTools(port: XFeedRunToolPort): ToolDefinition[] {
  return [
    strictTool(
      'x_feed_search_topic',
      'Search one topic already present in this run capability state.',
      searchParameters,
      async (args, exec) => {
        try {
          return resultFromPort(await port.searchTopic(args.topic as string, exec.signal))
        } catch (error) {
          return asFailure(error)
        }
      },
    ),
    strictTool(
      'x_feed_explore_candidate',
      'Explore one current candidate already present in this run capability state.',
      candidateParameters,
      async (args, exec) => {
        try {
          return resultFromPort(await port.exploreCandidate(args.candidateId as string, exec.signal))
        } catch (error) {
          return asFailure(error)
        }
      },
    ),
    strictTool(
      'x_feed_set_run_theme',
      'Record the selected theme for this run from its current topic allowlist.',
      themeParameters,
      async (args, exec) => {
        try {
          return resultFromPort(await port.setTheme(args.theme as string, exec.signal))
        } catch (error) {
          return asFailure(error)
        }
      },
    ),
    strictTool(
      'x_feed_prepare_delivery',
      'Validate and prepare the final Rich Markdown artifact and its current-run URLs. This never sends Telegram and never marks shown.',
      prepareParameters,
      async (args, exec) => {
        try {
          return resultFromPort(await port.prepareDelivery(
            args.text as string,
            args.urls as readonly string[],
            exec.signal,
          ))
        } catch (error) {
          return asFailure(error)
        }
      },
    ),
  ]
}
