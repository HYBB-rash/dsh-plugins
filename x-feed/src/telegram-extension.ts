import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createPersonalFeedV2RequestCoordinator } from '@herman/personal-feed'
import { createPersonalContextOwner, createSessionUserHistoryAdapter } from '@herman/personal-feed'
import { parseXFeedRuntimeConfig } from './config.ts'
import { XFeedbackStore } from './store.ts'
import { registerXFeedTools } from './tools.ts'
import { runCleanFeedback } from './x-feedback/clean-agent.ts'
import { FeedbackEffectAdapter, type FeedbackOperationStore } from './x-feedback/feedback-effect-adapter.ts'
import { InMemoryPendingStore } from './x-feedback/pending-store.ts'
import { registerTelegramFeedbackAdapter } from './x-feedback/telegram-adapter.ts'
import { createPersonalFeedTelegramRequestHandler, registerPersonalFeedTelegramAdapter } from './personal-feed/telegram-adapter.ts'
import { createPersonalContextTelegramRuntime } from './personal-feed/personal-context-telegram-runtime.ts'
import { createPersonalContextSemanticLlmPorts } from './personal-feed/personal-context-semantic-llm.ts'
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

/** The scoped Telegram interactive-root contract. */
export const X_FEED_CONTRACT = [
  'X 洞察反馈合同：',
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

/** Install the X feedback behavior as an ordinary Telegram business adapter. */
export async function installTelegramExtension(
  ctx: Context,
  rawConfig: Readonly<Record<string, unknown>>,
): Promise<() => Promise<void>> {
  const config = parseXFeedRuntimeConfig(rawConfig)
  let navigation: RebuildTrustedFactNavigation
  try {
    navigation = initializeTrustedFactNavigation(config.dataDir)
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error)
    const message = `x-feed: trusted-fact navigation not-ready: ${cause}`
    ctx.logger.error(message)
    throw new Error(message, { cause: error })
  }

  const store = new XFeedbackStore(config.dataDir)
  const fileTrustedFactRepository = new FileTrustedFactRepository(config.dataDir)
  const trustedFactRepository = {
    append: fileTrustedFactRepository.append.bind(fileTrustedFactRepository),
    readAll: (warn?: (message: string) => void) => fileTrustedFactRepository.readAll(message => {
      ctx.logger.warn(message)
      warn?.(message)
    }),
  }
  const operationStore: FeedbackOperationStore = { append: input => store.append(input) }
  const effectSink = new FeedbackEffectAdapter(trustedFactRepository, operationStore, navigation)
  const pendingStore = new InMemoryPendingStore({
    ttlMs: config.feedbackPendingTtlMs,
    clock: { now: () => Date.now() },
  })
  const useCase = new FeedbackUseCase(pendingStore)
  const service = (ctx as unknown as { get?: (name: string) => unknown }).get?.('sessionQuery')
  if (!isSessionQuery(service)) throw new Error('x-feed: Telegram sessionQuery service is unavailable')
  const modelService = (ctx as unknown as { get?: (name: string) => unknown }).get?.('agentDefaultModel')
  if (!isModelSelectionService(modelService)) throw new Error('x-feed: default model selection service is unavailable')
  const selection = modelService.currentSelection()
  if (!isModelSelection(selection)) throw new Error('x-feed: default model selection is invalid')
  const history = createSessionUserHistoryAdapter({
    sessionId: config.telegramSessionId,
    sessionQuery: service,
  })
  const semanticLifecycle = createPersonalContextSemanticLlmPorts({
    ctx,
    provider: selection.provider,
    model: selection.model,
  })
  const semantics = {
    classifier: semanticLifecycle.classifier,
    entailmentValidator: semanticLifecycle.entailmentValidator,
    noFactValidator: semanticLifecycle.noFactValidator,
  }
  const owner = createPersonalContextOwner({
    databasePath: join(config.personalFeedDataDir, 'v2', 'personal-context.sqlite'),
    clock: { now: () => new Date() },
    semantics,
  })
  const personalContextRuntime = createPersonalContextTelegramRuntime({
    owner,
    semanticLifecycle,
  })
  const shutdownPersonalContext = async (errors: unknown[]): Promise<void> => {
    try { await personalContextRuntime.shutdown() } catch (error) { errors.push(error) }
    try { owner.close() } catch (error) { errors.push(error) }
  }
  let bootstrap: Awaited<ReturnType<typeof owner.bootstrap>>
  try {
    bootstrap = await owner.bootstrap({ history })
  } catch (error) {
    const cleanupErrors: unknown[] = []
    await shutdownPersonalContext(cleanupErrors)
    if (cleanupErrors.length > 0) throw new AggregateError([error, ...cleanupErrors])
    throw error
  }
  if (bootstrap.status !== 'complete') {
    const primary = new Error(`x-feed: personal context bootstrap incomplete (${bootstrap.reason})`)
    const cleanupErrors: unknown[] = []
    await shutdownPersonalContext(cleanupErrors)
    if (cleanupErrors.length > 0) throw new AggregateError([primary, ...cleanupErrors])
    throw primary
  }

  const personalFeedCoordinator = createPersonalFeedV2RequestCoordinator({
    ledgerPath: join(config.personalFeedDataDir, 'v2', 'requests.jsonl'),
    clock: { now: () => new Date() },
    r4: personalContextRuntime.r4,
    r2: { observe: async () => ({ kind: 'unknown' }) },
    r3: { admit: async () => ({ kind: 'unknown' }) },
    r5: { judge: async () => ({ kind: 'unknown' }) },
  })
  const personalFeedHandler = createPersonalFeedTelegramRequestHandler({ coordinator: personalFeedCoordinator })
  let stopSource: (() => void) | undefined
  let stopFeedback: (() => void) | undefined
  let stopPersonalFeed: (() => void) | undefined
  const cleanupErrors = (actions: readonly (() => void)[]): unknown[] => {
    const errors: unknown[] = []
    for (const action of actions) {
      try { action() } catch (error) { errors.push(error) }
    }
    return errors
  }
  try {
    stopSource = personalContextRuntime.registerSourceFirst(ctx, {
      personalFeedHandler,
    })
    stopFeedback = registerTelegramFeedbackAdapter(ctx, {
      pendingStore,
      trustedFactRepository,
      effectSink,
      useCase,
      runCleanFeedback: (request, signal) => runBoundedCleanFeedback(
        ctx,
        request,
        signal,
        config.feedbackTurnTimeoutMs,
      ),
    })
    stopPersonalFeed = registerPersonalFeedTelegramAdapter(ctx, {
      coordinator: personalFeedCoordinator,
    })
  } catch (error) {
    const cleanup = cleanupErrors([
      ...(stopPersonalFeed === undefined ? [] : [stopPersonalFeed]),
      ...(stopFeedback === undefined ? [] : [stopFeedback]),
      ...(stopSource === undefined ? [] : [stopSource]),
    ])
    await shutdownPersonalContext(cleanup)
    if (cleanup.length > 0) throw new AggregateError([error, ...cleanup])
    throw error
  }

  const runtimes = new Map<Agent, () => void>()
  let stopping = false
  const installForRoot = (agent: Agent): void => {
    if (runtimes.has(agent) || agent.session.id !== config.telegramSessionId) return
    let disposeTools: (() => void) | undefined
    let disposeSection: (() => void) | undefined
    try {
      const cleanup = agent.ctx.effect(() => {
        disposeTools = registerXFeedTools(agent.ctx, { store, logger: ctx.logger })
        disposeSection = agent.ctx.systemPrompt.section({
          name: 'x-feed:contract',
          order: 96,
          text: X_FEED_CONTRACT,
        })
        return () => {
          const errors: unknown[] = []
          try { disposeSection?.() } catch (error) { errors.push(error) }
          try { disposeTools?.() } catch (error) { errors.push(error) }
          if (errors.length === 1) throw errors[0]
          if (errors.length > 1) throw new AggregateError(errors)
        }
      }, 'x-feed.telegram-root()')
      runtimes.set(agent, cleanup as () => void)
    } catch (error) {
      // registerXFeedTools is itself transactional.  If the effect host
      // throws after it returned a cleanup, finish this root rollback here.
      const rollbackErrors: unknown[] = []
      try { disposeSection?.() } catch (cleanupError) { rollbackErrors.push(cleanupError) }
      try { disposeTools?.() } catch (cleanupError) { rollbackErrors.push(cleanupError) }
      if (rollbackErrors.length > 0) throw new AggregateError([error, ...rollbackErrors])
      throw error
    }
  }

  let stopCreated: (() => void) | undefined
  try {
    for (const agent of ctx.agents.roots()) installForRoot(agent)
    stopCreated = ctx.on('agent/created', ({ agent }) => {
      if (stopping || runtimes.has(agent) || !ctx.agents.roots().includes(agent)) return
      installForRoot(agent)
    })
  } catch (error) {
    const rootCleanups = [...runtimes.values()].reverse()
    runtimes.clear()
    const cleanup = cleanupErrors(rootCleanups)
    cleanup.push(...cleanupErrors([
      ...(stopCreated === undefined ? [] : [stopCreated]),
      ...(stopPersonalFeed === undefined ? [] : [stopPersonalFeed]),
      ...(stopFeedback === undefined ? [] : [stopFeedback]),
      ...(stopSource === undefined ? [] : [stopSource]),
    ]))
    await shutdownPersonalContext(cleanup)
    if (cleanup.length > 0) throw new AggregateError([error, ...cleanup])
    throw error
  }

  let disposePromise: Promise<void> | undefined
  return (): Promise<void> => {
    if (disposePromise !== undefined) return disposePromise
    stopping = true
    const cleanups = [...runtimes.values()].reverse()
    runtimes.clear()
    disposePromise = (async () => {
      const errors: unknown[] = []
      try { stopCreated?.() } catch (error) { errors.push(error) }
      for (const cleanup of cleanups) {
        try { cleanup() } catch (error) { errors.push(error) }
      }
      try { stopPersonalFeed?.() } catch (error) { errors.push(error) }
      try { stopFeedback?.() } catch (error) { errors.push(error) }
      try { stopSource?.() } catch (error) { errors.push(error) }
      await shutdownPersonalContext(errors)
      if (errors.length > 0) throw new AggregateError(errors)
    })()
    void disposePromise.then(undefined, () => undefined)
    return disposePromise
  }
}

function isSessionQuery(value: unknown): value is {
  readonly listEvents: (sessionId: string, signal?: AbortSignal) => unknown | Promise<unknown>
  readonly readEvent: (input: unknown, signal?: AbortSignal) => unknown | Promise<unknown>
} {
  return value !== null && typeof value === 'object'
    && typeof (value as { listEvents?: unknown }).listEvents === 'function'
    && typeof (value as { readEvent?: unknown }).readEvent === 'function'
}

function isModelSelectionService(value: unknown): value is { currentSelection(): unknown } {
  return value !== null && typeof value === 'object'
    && typeof (value as { currentSelection?: unknown }).currentSelection === 'function'
}

function isModelSelection(value: unknown): value is { readonly provider: string; readonly model: string } {
  return value !== null && typeof value === 'object'
    && typeof (value as { provider?: unknown }).provider === 'string'
    && (value as { provider: string }).provider.trim() !== ''
    && typeof (value as { model?: unknown }).model === 'string'
    && (value as { model: string }).model.trim() !== ''
}

export function createTrustedFactNavigation(
  dataDir: string,
  hintDeriver: NavigationHintDeriver,
  derivation: NavigationDerivation,
): RebuildTrustedFactNavigation {
  return new RebuildTrustedFactNavigation(
    new FileTrustedFactRepository(dataDir),
    new TrustedFactNavigationProjector(hintDeriver, derivation),
    new FileNavigationSnapshotStore(dataDir),
  )
}

function initializeTrustedFactNavigation(dataDir: string): RebuildTrustedFactNavigation {
  const navigation = createTrustedFactNavigation(
    dataDir,
    {
      derive: locatedFact => ({
        topics: [],
        relations: [{ kind: 'about-target', targetId: locatedFact.fact.target.id }],
      }),
    },
    { method: 'trusted-fact-navigation-neutral', version: '1' },
  )
  const expected = navigation.execute()
  const navigationPath = join(dataDir, TRUSTED_FACT_NAVIGATION_FILE_NAME)
  const stored = pinNavigationSnapshot(JSON.parse(readFileSync(navigationPath, 'utf8')))
  if (JSON.stringify(stored) !== JSON.stringify(expected)) {
    throw new Error('x-feed: trusted-fact navigation verification failed')
  }
  return navigation
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
