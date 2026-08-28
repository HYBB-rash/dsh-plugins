/** Package-owned route-stream and pre-compaction freshness invariants. */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import {
  assertRouteFreshForCompaction,
  decodeRouteMessage,
  foldRoute,
  isRouteContextEvent,
} from './route.ts'
import {
  assertP01UserWordsCompactionSafe,
  isP01UserWordsRootSession,
  resolveP01UserWordsViewConfig,
  type P01UserWordsViewConfig,
  type ResolvedP01UserWordsViewConfig,
} from './p01-user-words.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-context-compactor'

/** Cordis companion plugin name. */
export const name = 'client-ui-context-compactor-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Exact P01 activation contract shared with the runtime entry. */
export interface Config {
  readonly p01UserWordsView?: P01UserWordsViewConfig
}

export const Config: z<Config> = z.object({
  p01UserWordsView: z.object({
    mode: z.const('enforce').required(),
    allowlist: z.array(z.string()).required(),
  }).default(undefined as never),
}) as z<Config>

function rootSession(session: Session): boolean {
  return (session.header.delegationDepth ?? 0) === 0
}

function p01Session(
  session: Session,
  config: ResolvedP01UserWordsViewConfig | undefined,
): boolean {
  return isP01UserWordsRootSession(
    String(session.id),
    session.header.delegationDepth,
    config,
  )
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
function createInstaller(
  p01UserWordsView: ResolvedP01UserWordsViewConfig | undefined,
): InvariantInstaller {
  return Object.assign((ctx: Context, fail: InvariantFailure) => {
    const checkExisting = (session: Session): void => {
      if (!rootSession(session)) return
      if (p01Session(session, p01UserWordsView)) {
        checked(() => {
          assertP01UserWordsCompactionSafe({
            events: session.events,
            surfaceNodes: session.surface.nodes,
          })
        }, fail)
        return
      }
      checked(() => { foldRoute(session.events) }, fail)
    }

    for (const session of ctx.sessions.list()) checkExisting(session)

    ctx.on('session/created', checkExisting, { global: true })

    ctx.on('internal/dispatch', (_mode, eventName, args) => {
      if (eventName !== 'session/event') return
      const [session, event] = args as [Session, SessionEvent]
      if (!rootSession(session)) return
      if (p01Session(session, p01UserWordsView)) {
        if (isRouteContextEvent(event)) {
          fail('P01 Session rejects newly appended legacy context-route state')
          return
        }
        if (event.type === 'compaction/start') {
          checked(() => {
            assertP01UserWordsCompactionSafe({
              events: session.events,
              surfaceNodes: session.surface.nodes,
            })
          }, fail)
        }
        return
      }
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
}

/** Register this package's invariant companion. */
export const apply = (ctx: Context, config: Config = {}): Promise<() => void> => {
  const p01UserWordsView = resolveP01UserWordsViewConfig(config.p01UserWordsView)
  return Promise.resolve(ctx.invariants.register(PACKAGE_NAME, createInstaller(p01UserWordsView)))
}
/* jscpd:ignore-end */
