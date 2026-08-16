/**
 * Single-session context-route manager.
 *
 * The plugin keeps one complete, versioned route snapshot inside the Session
 * log, projects the latest revision into every model request, and leaves exact
 * operational detail in the original append-only history.
 *
 * @module @deepseek-ai/dsh-client-ui-context-compactor
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-compaction'
import type {} from '@deepseek-ai/dsh-system-prompt'
import {
  createRouteRearmMessage,
  foldRoute,
  renderRouteBootstrapContext,
  routeNeedsCompletedTurnRecovery,
  routeNeedsRearm,
} from './route.ts'
import {
  routeUpdateFailureCode,
  updateRoute,
  type RouteReducerConfig,
  type RouteUpdateFailureCode,
} from './reducer.ts'

/** Stable Cordis plugin name. */
export const name = 'ui-context-compactor'

/** Services used by route reduction and the stable model-facing policy. */
export const inject = ['llm', 'systemPrompt']

/** Deployment policy for the auxiliary route reducer. */
export interface Config {
  /** Optional explicit reducer provider; must be paired with model. */
  readonly provider?: string
  /** Optional explicit reducer model; must be paired with provider. */
  readonly model?: string
  /** Optional reasoning level used only by the auxiliary reducer call. */
  readonly reasoningEffort?: string
  /** Maximum reducer-input characters after bounded extraction. */
  readonly maxInputChars?: number
  /** Maximum route JSON output tokens. */
  readonly maxOutputTokens?: number
}

export const Config: z<Config> = z.object({
  provider: z.string(),
  model: z.string(),
  reasoningEffort: z.string(),
  maxInputChars: z.number().step(1).min(32_000).default(32_000),
  maxOutputTokens: z.number().step(1).min(256).default(2_400),
})

function resolveConfig(config: Config): RouteReducerConfig {
  const hasProvider = config.provider !== undefined
  const hasModel = config.model !== undefined
  if (hasProvider !== hasModel) {
    throw new Error('ui-context-compactor: provider and model must be configured together')
  }
  if (hasProvider && (config.provider?.trim().length === 0 || config.model?.trim().length === 0)) {
    throw new Error('ui-context-compactor: provider and model overrides must be non-blank')
  }
  if (config.reasoningEffort !== undefined && config.reasoningEffort.trim().length === 0) {
    throw new Error('ui-context-compactor: reasoningEffort must be non-blank when configured')
  }
  const maxInputChars = config.maxInputChars ?? 32_000
  const maxOutputTokens = config.maxOutputTokens ?? 2_400
  if (!Number.isSafeInteger(maxInputChars) || maxInputChars < 32_000) {
    throw new Error('ui-context-compactor: maxInputChars must be a safe integer of at least 32000')
  }
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 256) {
    throw new Error('ui-context-compactor: maxOutputTokens must be a safe integer of at least 256')
  }
  return {
    ...config.provider === undefined ? {} : { provider: config.provider },
    ...config.model === undefined ? {} : { model: config.model },
    ...config.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: ReasoningEffortId(config.reasoningEffort.trim()) },
    maxInputChars,
    maxOutputTokens,
  }
}

function isRootSession(delegationDepth: number | undefined): boolean {
  return (delegationDepth ?? 0) === 0
}

function warnRouteFailure(ctx: Context, code: RouteUpdateFailureCode): void {
  const message = `ui-context-compactor: route update failed (${code}); raw Session history is retained and compaction stays blocked until a later successful update`
  ctx.logger.warn(message)
  // Cordis always buffers the record, but some Web profiles have no stdout
  // logger exporter. Keep the diagnostic fixed-code and secret-free.
  console.warn(message)
}

/** Register stable route policy, rearming, stale recovery, and turn-end reduction. */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)

  ctx.systemPrompt.context({
    name: 'context-route:policy',
    order: -80,
    text: ({ agent }) => {
      if (agent === undefined || !isRootSession(agent.session.header.delegationDepth)) return ''
      return renderRouteBootstrapContext(String(agent.session.id))
    },
  })

  // Run after downstream pre-step listeners. If automatic compaction just
  // shadowed the route, the same request receives a rearm before dispatch.
  // If a completed turn's reducer attempt failed, recover before the next
  // conversation request. Do not reduce after every tool step inside one
  // still-running turn: those facts remain in the visible working tail and
  // the normal turn-stopping checkpoint folds the whole turn once.
  ctx.on('agent/pre-step', async (
    { agent, signal },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject'
      || !isRootSession(agent.session.header.delegationDepth)
      || signal.aborted) return decision
    const projection = foldRoute(agent.session.events)
    if (routeNeedsCompletedTurnRecovery(
      agent.session.events,
      projection?.snapshot.asOfSeq ?? -1,
    )) {
      try {
        await updateRoute(ctx, agent, resolved, signal)
      } catch (error: unknown) {
        if (!signal.aborted) warnRouteFailure(ctx, routeUpdateFailureCode(error))
      }
      return decision
    }
    if (projection !== undefined
      && routeNeedsRearm(agent.session.events, agent.session.surface.nodes)) {
      try {
        agent.session.append(
          'user/message',
          createRouteRearmMessage(String(agent.session.id), projection.snapshot),
          { surfaceOp: 'append' },
        )
      } catch {
        warnRouteFailure(ctx, 'append')
      }
    }
    return decision
  })

  ctx.on('agent/turn-stopping', async ({ agent, signal }) => {
    if (!isRootSession(agent.session.header.delegationDepth)) return
    try {
      await updateRoute(ctx, agent, resolved, signal)
    } catch (error: unknown) {
      if (signal.aborted) return
      warnRouteFailure(ctx, routeUpdateFailureCode(error))
    }
  })
}

export {
  assertRouteFreshForCompaction,
  buildRouteMaterial,
  containsSecret,
  createRouteRearmMessage,
  createRouteRevisionMessage,
  decodeRouteMessage,
  decodeRouteRevision,
  foldRoute,
  isHumanAnswerEvent,
  isRouteContextEvent,
  isRouteRelevantEvent,
  latestRouteContextSeq,
  latestRouteRelevantSeq,
  parseRouteBody,
  renderRouteBootstrapContext,
  renderRouteContext,
  renderRouteMessageContent,
  routeNeedsCompletedTurnRecovery,
  routeNeedsRearm,
  routeBodyFailureCode,
  ROUTE_CONTEXT_SOURCE,
  type CurrentRoute,
  type DetailReference,
  type DetailSourceKind,
  type RetiredRoute,
  type RetiredRouteStatus,
  type RouteBody,
  type RouteBodyFailureCode,
  type RouteContextSource,
  type RouteDecision,
  type RoutePublication,
  type RouteProjection,
  type RouteRevisionData,
  type RouteSnapshot,
  type RouteStatement,
  type RouteStatus,
} from './route.ts'
export {
  routeReducerSystemPrompt,
  routeUpdateFailureCode,
  updateRoute,
  type RouteReducerConfig,
  type RouteUpdateFailureCode,
} from './reducer.ts'
