import type { FeedbackEffect } from '../trusted-facts/feedback-session.ts'
import type { NavigationSnapshot } from '../trusted-facts/navigation-contract.ts'
import type { TrustedFactRepository, TrustedFactWriteResult } from './trusted-fact-repository.ts'
import type { FeedbackWriteResult } from '../store.ts'

export interface FeedbackOperationStore {
  append(input: {
    readonly operation: 'save' | 'unsave'
    readonly url?: string
    readonly title?: string
  }): FeedbackWriteResult
}

export type FeedbackEffectResult =
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly code: 'invalid_effect' | 'write_failed'
      readonly message: string
    }
  | {
      readonly ok: false
      readonly code: 'fact_persisted_projection_unavailable'
      readonly factPersisted: true
      readonly message: string
    }

/** The only projection operation needed after a trusted fact append. */
export interface TrustedFactNavigationExecutor {
  execute(): NavigationSnapshot
}

/** Narrow outer adapter: TODO 1 effects become durable side effects. */
export interface FeedbackEffectSink {
  apply(effect: FeedbackEffect): FeedbackEffectResult
}

export class FeedbackEffectAdapter implements FeedbackEffectSink {
  private readonly operationStore: FeedbackOperationStore

  constructor(
    private readonly trustedFactRepository: TrustedFactRepository,
    operationStore: FeedbackOperationStore,
    private readonly navigation: TrustedFactNavigationExecutor,
  ) {
    this.operationStore = operationStore
  }

  apply(effect: FeedbackEffect): FeedbackEffectResult {
    switch (effect.kind) {
      case 'append_trusted_fact':
        return this.appendTrustedFact(effect.fact)
      case 'record_operation':
        return this.recordOperation(effect.operation, effect.target)
      default:
        return invalidEffect(effect)
    }
  }

  private appendTrustedFact(fact: Parameters<TrustedFactRepository['append']>[0]): FeedbackEffectResult {
    let persisted: TrustedFactWriteResult
    try {
      persisted = this.trustedFactRepository.append(fact)
    } catch (error) {
      return failure(error)
    }
    if (!persisted.ok) return toEffectResult(persisted)
    try {
      // Keep this synchronous: the repository append and the projection cannot
      // be interleaved by another JS writer in the same turn.
      this.navigation.execute()
      return { ok: true }
    } catch (error) {
      return projectionUnavailable(error)
    }
  }

  private recordOperation(
    operation: 'save' | 'unsave',
    target: Extract<FeedbackEffect, { readonly kind: 'record_operation' }>['target'],
  ): FeedbackEffectResult {
    try {
      return toEffectResult(this.operationStore.append({
        operation,
        url: target.source,
        ...(target.content.trim() === '' ? {} : { title: target.content }),
      }))
    } catch (error) {
      return failure(error)
    }
  }
}

function toEffectResult(result: TrustedFactWriteResult | FeedbackWriteResult): FeedbackEffectResult {
  if (result.ok) return { ok: true }
  return { ok: false, code: 'write_failed', message: result.message }
}

function failure(error: unknown): FeedbackEffectResult {
  return { ok: false, code: 'write_failed', message: error instanceof Error ? error.message : String(error) }
}

function projectionUnavailable(error: unknown): FeedbackEffectResult {
  return {
    ok: false,
    code: 'fact_persisted_projection_unavailable',
    factPersisted: true,
    message: error instanceof Error ? error.message : String(error),
  }
}

function invalidEffect(_value: never): FeedbackEffectResult {
  return { ok: false, code: 'invalid_effect', message: '反馈副作用类型无效。' }
}
