/**
 * The one public failure boundary for a managed canonical-state transaction.
 *
 * It deliberately creates no assistant message.  The Agent loop exposes the
 * error through its existing `agent/error`/outcome path, which keeps a failed
 * replacement from looking like a completed no-focus reply.
 */

export const NO_FOCUS_TRANSACTION_FAILURE_TEXT = '唯一背景未能安全换入，本轮未继续行动'

export class ManagedFailurePresenter {
  /**
   * A caller may use this only after it has independently proved that the
   * claimed direct input is durable.  Keeping the capability on the argument
   * prevents a transaction branch from accidentally publishing this bounded
   * result before the H2 append/flush/detached-readback gate.
   */
  afterPhysicallyProvedInput(proof: { readonly physicallyProved: true }): never {
    void proof
    throw new Error(NO_FOCUS_TRANSACTION_FAILURE_TEXT)
  }
}

/** Identifies the only F07 failure that must not re-append an H2-proved id. */
export function isManagedFailure(error: unknown): boolean {
  return error instanceof Error && error.message === NO_FOCUS_TRANSACTION_FAILURE_TEXT
}
