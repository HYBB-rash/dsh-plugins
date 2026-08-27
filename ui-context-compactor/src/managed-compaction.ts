/**
 * Native compaction arbitration for one explicitly managed interactive root.
 *
 * This is intentionally a BasicCompactionEngine subclass rather than a
 * wrapper or a mutation of `ctx.compaction`: all public native writer paths
 * remain dynamically dispatched through this single service.
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ManualCompactionError, type CompactionResult, type CompactionTrigger } from '@deepseek-ai/dsh-compaction'
import BasicCompactionEngine, { type BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'
import type { CommandId } from '@deepseek-ai/dsh-commands'
import {
  ManagedInteractiveRootClassifier,
  resolveManagedRuntimeConfig,
  type ManagedRuntimeConfig,
} from './managed-runtime.ts'

/** Basic backend settings plus the exact H1 managed-root definition. */
export interface ManagedCompactionRuntimeConfig {
  readonly mode: 'enforce'
  readonly safeUpdateMarginTokens: number
  readonly allowlist: readonly string[]
}

export interface ManagedAwareBasicCompactionConfig extends BasicCompactionConfig {
  readonly managedRuntime: ManagedCompactionRuntimeConfig
}

function hasNoDuplicateAllowlistEntries(runtime: ManagedRuntimeConfig): boolean {
  return new Set(runtime.allowlist).size === runtime.allowlist.length
}

const managedRuntimeConfigSchema: z<ManagedCompactionRuntimeConfig> = z.object({
  mode: z.const('enforce').required(),
  safeUpdateMarginTokens: z.number().step(1).min(1).required(),
  allowlist: z.array(z.string()).required(),
}) as z<ManagedCompactionRuntimeConfig>

/** Public loader schema for the engine's profile-shaped composition. */
export const ManagedAwareBasicCompactionConfigSchema: z<ManagedAwareBasicCompactionConfig> = z.intersect([
  BasicCompactionEngine.Config,
  z.object({ managedRuntime: managedRuntimeConfigSchema.required() }),
]) as unknown as z<ManagedAwareBasicCompactionConfig>

function sameRuntime(left: ManagedRuntimeConfig, right: ManagedRuntimeConfig): boolean {
  if (!hasNoDuplicateAllowlistEntries(left) || !hasNoDuplicateAllowlistEntries(right)) return false
  return left.mode === right.mode
    && left.safeUpdateMarginTokens === right.safeUpdateMarginTokens
    && left.allowlist.length === right.allowlist.length
    && left.allowlist.every(sessionId => right.allowlist.includes(sessionId))
}

/**
 * The only native writer adapter permitted for a managed root.
 *
 * BasicCompactionEngine registers its public listeners during `super()`. In a
 * correctly composed profile this constructor still completes synchronously
 * before any Agent is created, so every listener and the context-manager
 * entry plugin receive the same completed classifier before a first event.
 * Pressure, overflow, direct manual compaction, direct region compaction,
 * and the scoped command consequently use one synchronous classification
 * decision.
 */
export class ManagedAwareBasicCompactionEngine extends BasicCompactionEngine {
  /** Extend (do not copy) Basic's public profile schema. */
  static override Config: z<BasicCompactionConfig> & z<ManagedAwareBasicCompactionConfig>
    = ManagedAwareBasicCompactionConfigSchema as z<BasicCompactionConfig> & z<ManagedAwareBasicCompactionConfig>

  readonly managedRuntime: ManagedRuntimeConfig
  readonly classifier: ManagedInteractiveRootClassifier

  constructor(ctx: Context, config: ManagedAwareBasicCompactionConfig) {
    const { managedRuntime: configuredRuntime, ...basicConfig } = config
    if (configuredRuntime.mode !== 'enforce') {
      throw new Error('ui-context-compactor: managed compaction requires mode "enforce"')
    }
    const managedRuntime = resolveManagedRuntimeConfig(configuredRuntime)
    if (!hasNoDuplicateAllowlistEntries(managedRuntime)) {
      throw new Error('ui-context-compactor: managed compaction allowlist contains duplicate session ids')
    }
    super(ctx, basicConfig)
    this.managedRuntime = managedRuntime
    this.classifier = new ManagedInteractiveRootClassifier(managedRuntime)
  }

  /** True only when this engine was composed with the identical H1 config. */
  hasManagedRuntime(runtime: ManagedRuntimeConfig): boolean {
    return sameRuntime(this.managedRuntime, runtime)
  }

  override compactIfNeeded(
    agent: Parameters<BasicCompactionEngine['compactIfNeeded']>[0],
    trigger: CompactionTrigger,
    signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    if (this.isManaged(agent)) return Promise.resolve(null)
    return super.compactIfNeeded(agent, trigger, signal)
  }

  override compactNow(
    agent: Parameters<BasicCompactionEngine['compactNow']>[0],
    signal: AbortSignal,
    sourceCommandId?: CommandId,
  ): Promise<CompactionResult | null> {
    if (this.isManaged(agent)) return Promise.reject(managedWriterBlocked())
    return super.compactNow(agent, signal, sourceCommandId)
  }

  override compactRegion(
    start: number,
    end: number,
    agent: Parameters<BasicCompactionEngine['compactRegion']>[2],
    signal?: AbortSignal,
  ): Promise<CompactionResult> {
    if (this.isManaged(agent)) return Promise.reject(managedWriterBlocked())
    return super.compactRegion(start, end, agent, signal)
  }

  private isManaged(agent: Parameters<BasicCompactionEngine['compactIfNeeded']>[0]): boolean {
    return this.classifier.isManagedInteractiveRoot(
      String(agent.session.id),
      agent.session.header.delegationDepth,
    )
  }
}

function managedWriterBlocked(): ManualCompactionError {
  return new ManualCompactionError(
    'busy',
    'managed interactive roots use the context-manager update transaction',
  )
}

/** Loader-safe default entry for the managed Basic compaction composition. */
export default ManagedAwareBasicCompactionEngine
