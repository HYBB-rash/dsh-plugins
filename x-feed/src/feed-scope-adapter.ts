/**
 * The X source's smallest TODO01 adapter.
 *
 * This module only hands an already-created external period opportunity to
 * the future Feed core. It does not persist scope, collect candidates, build
 * reports or materials, or start any X runtime process.
 */

export const X_FEED_SOURCE_IDENTITY = 'x' as const

export interface XFeedPeriodScopeInput {
  readonly requestIdentity: string
  readonly trigger: 'scheduled' | 'manual'
  readonly scheduledFor: string
  readonly claimedAt: string
  readonly runId: string
  readonly requiredSources: readonly string[]
  readonly reportingWindowClosesAt: string
}

/** The local port deliberately contains one operation and no X runtime hooks. */
export interface ExternalPeriodScopePort<TResult = unknown> {
  establishExternalPeriodScope(
    input: XFeedExternalPeriodScopeRequest,
  ): TResult | PromiseLike<TResult>
}

export interface XFeedExternalPeriodScopeRequest extends XFeedPeriodScopeInput {
  readonly source: typeof X_FEED_SOURCE_IDENTITY
}

export class XFeedScopeAdapterError extends Error {
  readonly code = 'invalid_required_sources' as const

  constructor() {
    super('X feed scope requires requiredSources to be exactly the unique list [x]')
    this.name = 'XFeedScopeAdapterError'
  }
}

export interface XFeedScopeAdapter<TResult = unknown> {
  establishExternalPeriodScope(input: XFeedPeriodScopeInput): Promise<TResult>
}

export function createXFeedScopeAdapter<TResult = unknown>(
  port: ExternalPeriodScopePort<TResult>,
): XFeedScopeAdapter<TResult> {
  if (typeof port?.establishExternalPeriodScope !== 'function') {
    throw new TypeError('X feed scope adapter requires establishExternalPeriodScope')
  }

  return Object.freeze({
    establishExternalPeriodScope: async (input: XFeedPeriodScopeInput): Promise<TResult> => {
      assertXFeedRequiredSources(input.requiredSources)
      return await port.establishExternalPeriodScope({
        ...input,
        source: X_FEED_SOURCE_IDENTITY,
      })
    },
  })
}

export function assertXFeedRequiredSources(requiredSources: readonly string[]): void {
  if (!Array.isArray(requiredSources)
    || requiredSources.length !== 1
    || requiredSources[0] !== X_FEED_SOURCE_IDENTITY) {
    throw new XFeedScopeAdapterError()
  }
}
