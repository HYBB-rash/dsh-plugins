import type { Context } from '@deepseek-ai/cordis'
import type {
  TelegramInboundEnvelope,
  TelegramInboundResult,
} from './inbound-contract.ts'

/** The smallest Cordis surface required to dispatch one inbound envelope. */
export type TelegramInboundDispatchContext = Pick<Context, 'bail' | 'waterfall'>

/** The terminal operation used when no listener handles an envelope. */
export type TelegramInboundRoot = () => TelegramInboundResult | Promise<TelegramInboundResult>

const readinessRequiredError = 'Inbound interceptor required'
const dispatchFailureError = 'Inbound dispatch failed'

/**
 * Run readiness and waterfall dispatch for one immutable transport envelope.
 * Every exception is converted to a failed result so an unavailable listener
 * cannot accidentally fall through to the default root.
 */
export async function dispatchInbound(
  ctx: TelegramInboundDispatchContext,
  envelope: Readonly<TelegramInboundEnvelope>,
  requireInboundInterceptor: boolean,
  defaultRoot: TelegramInboundRoot,
): Promise<TelegramInboundResult> {
  if (!isReady(ctx, envelope, requireInboundInterceptor)) {
    return { kind: 'failed', visibleError: readinessRequiredError }
  }

  try {
    return await ctx.waterfall('telegram/inbound', envelope, defaultRoot)
  } catch {
    return { kind: 'failed', visibleError: dispatchFailureError }
  }
}

function isReady(
  ctx: TelegramInboundDispatchContext,
  envelope: Readonly<TelegramInboundEnvelope>,
  required: boolean,
): boolean {
  try {
    const ready = ctx.bail('telegram/inbound/ready', envelope)
    return !required || ready === true
  } catch {
    return false
  }
}
