/** Package-owned route-stream and pre-compaction freshness invariants. */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import {
  assertRouteFreshForCompaction,
  decodeRouteMessage,
  foldRoute,
  isRouteContextEvent,
} from './route.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-context-compactor'

/** Cordis companion plugin name. */
export const name = 'client-ui-context-compactor-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

function rootSession(session: Session): boolean {
  return (session.header.delegationDepth ?? 0) === 0
}

function checked(action: () => void, fail: InvariantFailure): void {
  try {
    action()
  } catch (error: unknown) {
    fail(error instanceof Error ? error.message : 'invalid context-route state')
  }
}

/**
 * Validate every live route publication independently of the runtime plugin,
 * and veto compaction/start before append when the current revision is stale
 * or no longer visible. Cold seeds stay tolerant because their outer standard
 * message already passed core reconstruction and producer fields may be old or
 * externally malformed; runtime folding retains and rearms the last valid one.
 */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  for (const session of ctx.sessions.list()) {
    if (rootSession(session)) checked(() => { foldRoute(session.events) }, fail)
  }

  ctx.on('session/created', (session) => {
    if (rootSession(session)) checked(() => { foldRoute(session.events) }, fail)
  }, { global: true })

  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    if (!rootSession(session)) return
    if (isRouteContextEvent(event)) {
      checked(() => {
        decodeRouteMessage(event, foldRoute(session.events)?.snapshot, session.events)
      }, fail)
      return
    }
    if (event.type === 'compaction/start') {
      checked(() => {
        assertRouteFreshForCompaction(session.events, session.surface.nodes)
      }, fail)
    }
  }, { global: true })
}, { inject: ['sessions'] })

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
