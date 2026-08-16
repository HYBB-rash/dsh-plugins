/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-plugin-guardian`.
 * @module @deepseek-ai/dsh-client-ui-plugin-guardian/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-plugin-guardian'

/** Cordis companion plugin name. */
export const name = 'client-ui-plugin-guardian-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the watcher is effect-owned with disposal proven by
 * the plugin spec; this package owns no mutable state beyond the audit log.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
