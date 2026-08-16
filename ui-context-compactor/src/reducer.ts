/** LLM adapter that turns new Session facts into one validated route revision. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  BlockAssembler,
  createUserMessage,
  deepFreeze,
  type FinishReason,
  type GenerateOptions,
  type ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import {
  buildRouteMaterial,
  createRouteRevisionMessage,
  foldRoute,
  latestRouteRelevantSeq,
  parseRouteBody,
  routeBodyFailureCode,
  type RouteBodyFailureCode,
} from './route.ts'

/** Validated reducer policy supplied by the host plugin. */
export interface RouteReducerConfig {
  readonly provider?: string
  readonly model?: string
  readonly reasoningEffort?: ReasoningEffortId
  readonly maxInputChars: number
  readonly maxOutputTokens: number
}

/** Fixed, non-secret reasons an auxiliary route update can fail. */
export type RouteUpdateFailureCode =
  | 'route-replay'
  | 'input-budget'
  | 'model-route'
  | 'model-call'
  | 'model-max-tokens'
  | 'unexpected-tool'
  | 'empty-output'
  | 'source-changed'
  | RouteBodyFailureCode
  | 'append'
  | 'unknown'

class RouteUpdateFailure extends Error {
  constructor(readonly routeCode: RouteUpdateFailureCode) {
    super(`context-route update failed (${routeCode})`)
    this.name = 'RouteUpdateFailure'
  }
}

function failUpdate(code: RouteUpdateFailureCode): never {
  throw new RouteUpdateFailure(code)
}

/** Reduce arbitrary thrown values to a safe code without exposing their text. */
export function routeUpdateFailureCode(error: unknown): RouteUpdateFailureCode {
  return error instanceof RouteUpdateFailure ? error.routeCode : 'unknown'
}

const REDUCER_SYSTEM_PROMPT = `You maintain the current route state for one long-running AI work session.

The Session has exactly one root problem. Do not switch the root to a new unrelated problem; the user must open a new Session for that. Update the route only from the supplied prior snapshot and source-labelled original events. A newer direct human source overrides an older snapshot, inference, assistant proposal, or ordinary tool result. Direct human sources are [user] events and [human-answer] events; [human-answer] is a successful, host-verified answer returned by ask_user_question, not an assistant proposal.

Return exactly one JSON object and nothing else. It must have these exact keys:
{
  "rootGoal": {"text": "...", "sourceSeqs": [0]},
  "successCriteria": [{"text": "...", "sourceSeqs": [0]}],
  "currentRoute": {"text": "...", "reason": "...", "status": "confirmed|tentative", "sourceSeqs": [0]},
  "decisions": [{"text": "...", "status": "confirmed|tentative", "sourceSeqs": [0]}],
  "retiredRoutes": [{"text": "...", "reason": "...", "status": "superseded|rejected", "sourceSeqs": [0]}],
  "currentNode": {"text": "...", "sourceSeqs": [0]},
  "nextDecision": null,
  "reviewTriggers": [{"text": "...", "sourceSeqs": [0]}],
  "detailRefs": [{"label": "...", "why": "...", "sourceSeqs": [0], "preferredSourceKinds": ["user"], "fallbackQuery": "optional short query"}]
}

Rules:
- Every revision is a complete current snapshot, not a patch.
- Copy no code, command output, logs, credentials, tokens, private keys, or long operational detail into the JSON.
- sourceSeqs must name supplied original semantic events. rootGoal and every success criterion must cite a [user] or [human-answer] event. A confirmed route or decision must cite a [user] or [human-answer] event; otherwise mark it tentative.
- detailRefs may cite only [user], [human-answer], or ordinary tool-result events. They describe what to retrieve and why, but never copy the detail itself. Prefer exact sourceSeqs; fallbackQuery is optional and secondary.
- If currentRoute changes, copy the previous currentRoute.text exactly into retiredRoutes and explain whether it was superseded or rejected. Preserve all earlier retiredRoutes so an old route cannot silently revive.
- Preserve the root goal, accepted constraints, and valid review triggers unless a newer direct human event explicitly corrects them.
- Keep prose concise, plain, and in the user's language. Use one line per text field.`

function finishFailure(finish: FinishReason): RouteUpdateFailureCode | undefined {
  switch (finish.kind) {
    case 'stop': return undefined
    case 'error':
    case 'aborted': return 'model-call'
    case 'max-tokens': return 'model-max-tokens'
    case 'tool-calls': return 'unexpected-tool'
    default: return 'model-call'
  }
}

function resolveRoute(agent: Agent, config: RouteReducerConfig): { provider: string; model: string } {
  if (config.provider !== undefined && config.model !== undefined) {
    return { provider: config.provider, model: config.model }
  }
  const logged = agent.session.requestHeader()?.config
  if (logged !== undefined && logged.provider.length > 0 && logged.model.length > 0) {
    return { provider: logged.provider, model: logged.model }
  }
  if (agent.options.provider !== undefined && agent.options.model !== undefined
    && agent.options.provider.length > 0 && agent.options.model.length > 0) {
    return { provider: agent.options.provider, model: agent.options.model }
  }
  throw new Error('context-route reducer has no provider/model route')
}

/**
 * Commit one complete route revision when the Session has unprocessed semantic
 * facts. Returns false for a genuine no-op.
 */
export async function updateRoute(
  ctx: Context,
  agent: Agent,
  config: RouteReducerConfig,
  signal: AbortSignal,
): Promise<boolean> {
  signal.throwIfAborted()
  let projection: ReturnType<typeof foldRoute>
  try {
    projection = foldRoute(agent.session.events)
  } catch {
    return failUpdate('route-replay')
  }
  const asOfSeq = latestRouteRelevantSeq(agent.session.events)
  if (asOfSeq === undefined || asOfSeq <= (projection?.snapshot.asOfSeq ?? -1)) return false

  let material: string
  try {
    material = buildRouteMaterial(agent.session.events, projection?.snapshot, config.maxInputChars)
  } catch {
    return failUpdate('input-budget')
  }
  let route: { provider: string; model: string }
  try {
    route = resolveRoute(agent, config)
  } catch {
    return failUpdate('model-route')
  }
  const options: GenerateOptions = deepFreeze({
    provider: route.provider,
    model: route.model,
    ...config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort },
    messages: [createUserMessage({
      content: [{ type: 'text', text: material }],
      source: { kind: 'plugin', plugin: 'ui-context-compactor:route-reducer' },
    })],
    system: REDUCER_SYSTEM_PROMPT,
    temperature: 0,
    maxTokens: config.maxOutputTokens,
    sessionId: agent.session.id,
    signal,
  })

  const assembler = new BlockAssembler()
  try {
    for await (const chunk of ctx.llm.stream(options)) {
      signal.throwIfAborted()
      assembler.push(chunk)
    }
  } catch {
    if (signal.aborted) signal.throwIfAborted()
    return failUpdate('model-call')
  }
  signal.throwIfAborted()
  const terminalError = finishFailure(assembler.finish)
  if (terminalError !== undefined) return failUpdate(terminalError)
  const blocks = assembler.blocks()
  if (blocks.some(block => block.type === 'tool-call')) {
    return failUpdate('unexpected-tool')
  }
  const output = blocks
    .filter((block): block is Extract<(typeof blocks)[number], { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
  if (output.trim().length === 0) return failUpdate('empty-output')

  // A background producer changing semantic history while the auxiliary call
  // runs invalidates the proposed asOf boundary. Keep raw history and retry on
  // a later turn rather than stamping a snapshot over unseen facts.
  if (latestRouteRelevantSeq(agent.session.events) !== asOfSeq) {
    return failUpdate('source-changed')
  }
  let revision: ReturnType<typeof parseRouteBody>
  try {
    revision = parseRouteBody(output, projection?.snapshot, asOfSeq, agent.session.events)
  } catch (error: unknown) {
    return failUpdate(routeBodyFailureCode(error))
  }
  try {
    agent.session.append(
      'user/message',
      createRouteRevisionMessage(String(agent.session.id), revision),
      { surfaceOp: 'append' },
    )
  } catch {
    return failUpdate('append')
  }
  return true
}

/** Exported for contract tests without widening the runtime configuration API. */
export function routeReducerSystemPrompt(): string {
  return REDUCER_SYSTEM_PROMPT
}
