/**
 * dsh-x-feed: thin X insight feed adapter (§5/§11).
 *
 * Responsibilities:
 * - resolve configuration and locate the Python kernel + Harness data dir;
 * - listen to the bound `dsh-cron` job's REAL terminal event and call
 *   `confirm-prepared` (delivery receipt, §11.2);
 * - inject the X reply-feedback contract and the two `x_feed_*` tools ONLY on
 *   the `session-telegram` interactive root (§10.3);
 * - persist save/unsave operations and answer the local saved list; ratings
 *   use the clean feedback / TrustedFact path instead of the legacy ledger.
 *
 * The mature Python X kernel owns collection/exploration/dedup/selection;
 * dsh-x-feed never re-implements it and never imports it in the other
 * direction.
 * @module @deepseek-ai/dsh-x-feed
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CronAgentEnvironmentRegistry } from '@deepseek-ai/dsh-cron'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import z from '@deepseek-ai/schemastery'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { DeliveryReceipt } from './receipt.ts'
import { XFeedbackStore, defaultStoreDir } from './store.ts'
import { registerXFeedTools } from './tools.ts'
import { runCleanFeedback } from './x-feedback/clean-agent.ts'
import { FeedbackEffectAdapter, type FeedbackOperationStore } from './x-feedback/feedback-effect-adapter.ts'
import { InMemoryPendingStore } from './x-feedback/pending-store.ts'
import { registerTelegramFeedbackAdapter } from './x-feedback/telegram-adapter.ts'
import { FileTrustedFactRepository } from './x-feedback/trusted-fact-repository.ts'
import { FeedbackUseCase } from './x-feedback/use-case.ts'
import {
  FileNavigationSnapshotStore,
  TRUSTED_FACT_NAVIGATION_FILE_NAME,
} from './navigation/file-navigation-snapshot-store.ts'
import { pinNavigationSnapshot } from './fact-projection/file-projection-sources.ts'
import {
  RebuildTrustedFactNavigation,
  TrustedFactNavigationProjector,
  type NavigationDerivation,
  type NavigationHintDeriver,
} from './trusted-facts/index.ts'
import {
  createXFeedCronEnvironmentProvider,
  type XFeedCronProviderOptions,
} from './x-cron/provider.ts'

export {
  createXFeedCronEnvironmentProvider,
  X_CRON_AGENT_ENVIRONMENT_MARKER,
  X_CRON_ENVIRONMENT_REQUIREMENTS,
  type XFeedCronProviderOptions,
} from './x-cron/provider.ts'

export {
  NAVIGATION_SCHEMA_VERSION,
  RebuildTrustedFactNavigation,
  TrustedFactNavigationProjector,
  type LocatedTrustedFact,
  type LocatedTrustedFactReader,
  type LocatedTrustedFactSnapshot,
  type NavigationDerivation,
  type NavigationHintDeriver,
  type NavigationHints,
  type NavigationItem,
  type NavigationRelation,
  type NavigationSnapshot,
  type NavigationSnapshotWriter,
  type NavigationTargetRef,
  type Sha256Digest,
  type TrustedFactLocator,
} from './trusted-facts/index.ts'

/**
 * Explicit, read-only trusted-fact projection for callers that own the
 * candidate assessment. Importing this module does not read files; only the
 * preflight function reads the explicitly supplied data directory.
 */
export {
  createFactProjectionPreflight,
  createBoundFactProjectionPreflight,
  preflightFactProjectionWithAssessmentBinder,
  candidateFingerprint,
  fingerprintCandidate,
  type ApplicationLevel,
  type AssessmentEssentiality,
  type AssessmentRelevance,
  type AssessmentReadinessProbe,
  type AssessmentSnapshotBinder,
  type CandidateDescriptor,
  type CandidateFactAssessment,
  type CandidateFactAssessmentAudit,
  type CandidateFactAssessmentDecision,
  type CandidateFactAssessmentPort,
  type CandidateFactAssessmentRequest,
  type FactProjectionPreflightResult,
  type FactProjectionAssessmentBinderInput,
  type LookupFailure,
  type LookupResult,
  type LookupSuccess,
  type LookupTicket,
  type NavigationSegment,
  type NeutralNavigationInput,
  type ProjectedTrustedFact,
  type ProjectionBudget,
  type ProjectionFailure,
  type ProjectionNotReady,
  type ProjectionView,
  type ReadyFactProjectionSession,
} from './fact-projection/index.ts'

/** Stable Cordis plugin name. */
export const name = 'dsh-x-feed'

/** Core services required by either role before activation. */
export const inject = [
  'agentDefaultModel',
  'agents',
  'sessions',
  'tools',
  'systemPrompt',
]

/** dsh-x-feed configuration (§11.1). */
export interface Config {
  /** Bound dsh-cron job id; MUST be filled before deployment. Empty keeps the
   *  feedback tools available but leaves the receipt unbound with a log line. */
  cronJobId: string
  /** Harness X data dir. Defaults to `$DSH_HOME/storages/dsh-x-feed`. */
  dataDir?: string
  /** Python interpreter. Defaults to /usr/bin/python3. */
  pythonBin?: string
  /** Path to the shipped `python/x_insight_pipeline.py`. Defaults to the
   *  python dir inside this npm package. */
  pipelinePath?: string
  /** Interactive Telegram root session id. Defaults to `session-telegram`. */
  telegramSessionId?: string
  /** Process-local TTL for an unfinished feedback interaction. Defaults to 10 minutes. */
  feedbackPendingTtlMs: number
  /** Maximum time for one clean feedback interpretation. Defaults to 30 seconds. */
  feedbackTurnTimeoutMs: number
}

export const Config: z<Config> = z.object({
  cronJobId: z.string().default(''),
  dataDir: z.string().default(''),
  pythonBin: z.string().default('/usr/bin/python3'),
  pipelinePath: z.string().default(''),
  telegramSessionId: z.string().default('session-telegram'),
  feedbackPendingTtlMs: z.number().step(1).min(1).max(86_400_000).default(600_000),
  feedbackTurnTimeoutMs: z.number().step(1).min(1).max(120_000).default(30_000),
})

/** Resolve the data dir, defaulting under DSH_HOME. */
export function resolveDataDir(config: Pick<Config, 'dataDir'>): string {
  return config.dataDir !== undefined && config.dataDir !== ''
    ? config.dataDir
    : defaultStoreDir(resolveDshHome())
}

/** Resolve the pipeline path: explicit config, else the package's python dir. */
export function resolvePipelinePath(config: Pick<Config, 'pipelinePath'>): string {
  if (config.pipelinePath !== undefined && config.pipelinePath !== '') return config.pipelinePath
  // lib/index.js → <package>/python/x_insight_pipeline.py (bundle and source
  // both sit one level under the package root).
  const here = fileURLToPath(new URL('.', import.meta.url))
  return join(here, '..', 'python', 'x_insight_pipeline.py')
}

/**
 * Compose the file-backed trusted-fact navigation use case without executing it.
 * The caller must provide both the data directory and derivation policy; no
 * default DSH path or agent-facing capability is installed here.
 */
export function createTrustedFactNavigation(
  dataDir: string,
  hintDeriver: NavigationHintDeriver,
  derivation: NavigationDerivation,
): RebuildTrustedFactNavigation {
  const repository = new FileTrustedFactRepository(dataDir)
  const projector = new TrustedFactNavigationProjector(hintDeriver, derivation)
  const writer = new FileNavigationSnapshotStore(dataDir)
  return new RebuildTrustedFactNavigation(repository, projector, writer)
}

const DEFAULT_NAVIGATION_DERIVATION: NavigationDerivation = Object.freeze({
  method: 'trusted-fact-navigation-neutral',
  version: '1',
})

const DEFAULT_NAVIGATION_HINT_DERIVER: NavigationHintDeriver = {
  derive: locatedFact => ({
    topics: [],
    relations: [{ kind: 'about-target', targetId: locatedFact.fact.target.id }],
  }),
}

function initializeTrustedFactNavigation(
  dataDir: string,
): RebuildTrustedFactNavigation {
  const navigation = createTrustedFactNavigation(
    dataDir,
    DEFAULT_NAVIGATION_HINT_DERIVER,
    DEFAULT_NAVIGATION_DERIVATION,
  )
  const expected = navigation.execute()
  const navigationPath = join(dataDir, TRUSTED_FACT_NAVIGATION_FILE_NAME)
  const stored = pinNavigationSnapshot(JSON.parse(readFileSync(navigationPath, 'utf8')))
  if (JSON.stringify(stored) !== JSON.stringify(expected)) {
    throw new Error('dsh-x-feed: trusted-fact navigation verification failed')
  }
  return navigation
}

const DEFAULT_FEEDBACK_PENDING_TTL_MS = 600_000
const DEFAULT_FEEDBACK_TURN_TIMEOUT_MS = 30_000

/** The scoped Telegram interactive-root contract (§10.3). */
export const X_FEED_CONTRACT = [
  'X 洞察反馈合同（dsh-x-feed）：',
  '- Telegram 引用块只提供定位上下文，当前用户消息才是用户的新指令。',
  '- 只有当前消息给出 X URL，或引用上下文明示 X 内容时，才进入这份 X 反馈合同；没有 X 线索的普通对话（如「这个方案我不喜欢」「这个颜色我不喜欢」）按普通对话回应，不调用 x_feed 工具，也不强行追问。',
  '- 用户消息里直接给出明确 X URL 时可以记录；引用里只有一个 X URL 时也可以直接定位。',
  '- 用户给出唯一的序号或唯一标题时可以记录；必须能在当前引用中唯一对应一条 X 内容。',
  '- 引用报告有多个 X URL，而用户只说「这个/这条/它」等无法唯一指向的话时，只问一句「你指哪一条？」；不能调用工具写账本。',
  '- 当前消息明确在谈 X 内容或明确要求记录 X 反馈，但没有可定位的 X 引用上下文，且用户没有直接给出 URL、唯一序号或唯一标题时，只问一句「你指哪一条？」或请用户贴出 URL；不能调用工具写账本，也不能根据会话历史猜。',
  '- 用户明确对已定位的 X 内容说收藏或取消收藏时，先定位目标，再调用 x_feed_record_feedback；喜欢/不喜欢由 Telegram clean feedback 与 TrustedFact 链处理，不调用旧账本工具。',
  '- 「这批都没兴趣」「最近 Codex 太多」等评价不得写入旧反馈账本；必须由 clean feedback 链按其自身合同判断。',
  '- 无论是否曾经记录过、无论用户是否重复表达，只要用户明确表达收藏/取消收藏，都必须先调用工具写入；喜欢/不喜欢则等待 clean feedback 链结果。不得凭记忆或推测声称「已记录」「无需记录」——只有对应链路成功后，才能向用户确认。',
  '- x_feed_record_feedback 本身只写 X 收藏账本；具体单条 save/unsave 不进长期 canary memory。',
  '- 不得为了 X 反馈另建 Markdown、research 文件或其他平行收藏文件；这不限制上层产品因其自身目的另做记录。',
  '- 只有用户明确泛化为「以后多发/少发这种」时，才同时遵守现有长期认识增量层合同。',
  '- 不因为反馈创建当前承诺、cron 或后台 worker。',
  '- 工具写入成功后自然确认一句，不报告文件路径和内部步骤。',
].join('\n')

/** Whether this root is the qualified Telegram interactive root. */
function isQualifiedRoot(agent: Agent, telegramSessionId: string): boolean {
  return agent.session.id === telegramSessionId
}

/**
 * Cordis plugin entry: open the shared ledger, mount the receipt listener
 * (when bound), and install the contract + tools on the interactive root.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  await ctx.effect(async () => {
    const dataDir = resolveDataDir(config)
    const pythonBin = config.pythonBin ?? '/usr/bin/python3'
    const pipelinePath = resolvePipelinePath(config)
    const telegramSessionId = config.telegramSessionId ?? 'session-telegram'
    let navigation: RebuildTrustedFactNavigation
    try {
      navigation = initializeTrustedFactNavigation(dataDir)
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error)
      const message = `dsh-x-feed: trusted-fact navigation not-ready: ${cause}`
      ctx.logger.error(message)
      throw new Error(message, { cause: error })
    }
    const store = new XFeedbackStore(dataDir)
    const fileTrustedFactRepository = new FileTrustedFactRepository(dataDir)
    const trustedFactRepository = {
      append: fileTrustedFactRepository.append.bind(fileTrustedFactRepository),
      readAll: (warn?: (message: string) => void) => fileTrustedFactRepository.readAll(message => {
        ctx.logger.warn(message)
        warn?.(message)
      }),
    }
    const operationStore: FeedbackOperationStore = {
      append: input => store.append(input),
    }
    const effectSink = new FeedbackEffectAdapter(trustedFactRepository, operationStore, navigation)
    const pendingStore = new InMemoryPendingStore({
      ttlMs: config.feedbackPendingTtlMs ?? DEFAULT_FEEDBACK_PENDING_TTL_MS,
      clock: { now: () => Date.now() },
    })
    const useCase = new FeedbackUseCase(pendingStore)
    const stopFeedback = registerTelegramFeedbackAdapter(ctx, {
      pendingStore,
      trustedFactRepository,
      effectSink,
      useCase,
      runCleanFeedback: (request, signal) => runBoundedCleanFeedback(
        ctx,
        request,
        signal,
        config.feedbackTurnTimeoutMs ?? DEFAULT_FEEDBACK_TURN_TIMEOUT_MS,
      ),
    })

    const runtimes = new Map<Agent, () => void>()
    let stopping = false
    let disposeProvider: (() => void) | undefined

    if (config.cronJobId === undefined || config.cronJobId === '') {
      ctx.logger.info(
        'dsh-x-feed: cronJobId 未绑定，receipt 保持未绑定（不处理终态事件）；交互反馈工具仍可用',
      )
    } else {
      let registry: CronAgentEnvironmentRegistry | undefined
      try {
        registry = ctx.get('cronAgentEnvironmentRegistry') as CronAgentEnvironmentRegistry
      } catch (error) {
        ctx.logger.warn(`dsh-x-feed: cron agent environment registry unavailable; provider not registered: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (registry === undefined || typeof registry.register !== 'function') {
        ctx.logger.warn('dsh-x-feed: cron agent environment registry unavailable; provider not registered')
      } else {
        const providerOptions: XFeedCronProviderOptions = {
          ctx,
          cronJobId: config.cronJobId,
          dataDir,
          pythonBin,
          pipelinePath,
        }
        disposeProvider = registry.register(createXFeedCronEnvironmentProvider(providerOptions))
      }
      const receipt = new DeliveryReceipt({
        cronJobId: config.cronJobId,
        dataDir,
        pythonBin,
        pipelinePath,
        logger: ctx.logger,
      })
      ctx.logger.info(`dsh-x-feed: receipt 绑定 cron job ${config.cronJobId}`)
      // 失败（含重试耗尽）抛出，由 dsh-cron 的 emitRunFinished 捕获为
      // bounded error；不重投 Telegram，不修改 shown。
      const stopReceipt = ctx.on('dsh-cron/run-finished', async (event) => {
        await receipt.handle(event)
      })
      ctx.effect(() => stopReceipt, 'dsh-x-feed.receipt()')
    }

    const installForRoot = (agent: Agent): void => {
      if (runtimes.has(agent)) return
      if (!isQualifiedRoot(agent, telegramSessionId)) return
      const disposers: Array<() => void> = []
      disposers.push(agent.ctx.effect(() => {
        const disposeTools = registerXFeedTools(agent.ctx, { store, logger: ctx.logger })
        const disposeSection = agent.ctx.systemPrompt.section({
          name: 'x-feed:contract',
          order: 96,
          text: X_FEED_CONTRACT,
        })
        return () => {
          disposeTools()
          disposeSection()
        }
      }, 'dsh-x-feed.root()'))
      let done = false
      runtimes.set(agent, () => {
        if (done) return
        done = true
        for (const dispose of disposers) dispose()
      })
    }

    for (const agent of ctx.agents.roots()) installForRoot(agent)
    const stopCreated = ctx.on('agent/created', ({ agent }) => {
      if (stopping || runtimes.has(agent) || !ctx.agents.roots().includes(agent)) return
      installForRoot(agent)
    })

    return async () => {
      stopping = true
      stopCreated()
      stopFeedback()
      disposeProvider?.()
      disposeProvider = undefined
      const cleanups = [...runtimes.values()]
      runtimes.clear()
      await Promise.allSettled(cleanups.map(cleanup => Promise.resolve(cleanup())))
    }
  }, 'dsh-x-feed()')
}

async function runBoundedCleanFeedback(
  ctx: Context,
  request: Parameters<typeof runCleanFeedback>[1],
  signal: AbortSignal,
  timeoutMs: number,
): Promise<{ readonly interpretation: unknown }> {
  if (signal.aborted) throw signal.reason ?? new Error('X 反馈处理已取消。')

  const timeout = AbortSignal.timeout(timeoutMs)
  const combined = AbortSignal.any([signal, timeout])
  const run = runCleanFeedback(ctx, request, { timeoutMs })
  let removeAbortListener = (): void => {}
  const interrupted = new Promise<never>((_resolve, reject) => {
    const rejectOnAbort = (): void => reject(combined.reason ?? new Error('X 反馈处理已取消。'))
    if (combined.aborted) {
      rejectOnAbort()
      return
    }
    combined.addEventListener('abort', rejectOnAbort, { once: true })
    removeAbortListener = () => combined.removeEventListener('abort', rejectOnAbort)
  })
  try {
    return await Promise.race([run, interrupted])
  } finally {
    removeAbortListener()
  }
}
