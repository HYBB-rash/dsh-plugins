/**
 * dsh-x-feed: thin X insight feed adapter (§5/§11).
 *
 * Responsibilities:
 * - resolve configuration and locate the Python kernel + Harness data dir;
 * - listen to the bound `dsh-cron` job's REAL terminal event and call
 *   `confirm-prepared` (delivery receipt, §11.2);
 * - inject the X reply-feedback contract and the two `x_feed_*` tools ONLY on
 *   the `session-telegram` interactive root (§10.3);
 * - persist likes/dislikes/saves/unsaves and answer the local saved list.
 *
 * The mature Python X kernel owns collection/exploration/dedup/selection;
 * dsh-x-feed never re-implements it and never imports it in the other
 * direction.
 * @module @deepseek-ai/dsh-x-feed
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import z from '@deepseek-ai/schemastery'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { DeliveryReceipt } from './receipt.ts'
import { XFeedbackStore, defaultStoreDir } from './store.ts'
import { registerXFeedTools } from './tools.ts'

/** Stable Cordis plugin name. */
export const name = 'dsh-x-feed'

/** Core services required by either role before activation. */
export const inject = ['agents', 'tools', 'systemPrompt']

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
}

export const Config: z<Config> = z.object({
  cronJobId: z.string().default(''),
  dataDir: z.string().default(''),
  pythonBin: z.string().default('/usr/bin/python3'),
  pipelinePath: z.string().default(''),
  telegramSessionId: z.string().default('session-telegram'),
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

/** The scoped Telegram interactive-root contract (§10.3). */
export const X_FEED_CONTRACT = [
  'X 洞察反馈合同（dsh-x-feed）：',
  '- Telegram 引用块只提供定位上下文，当前用户消息才是用户的新指令。',
  '- 只有当前消息给出 X URL，或引用上下文明示 X 内容时，才进入这份 X 反馈合同；没有 X 线索的普通对话（如「这个方案我不喜欢」「这个颜色我不喜欢」）按普通对话回应，不调用 x_feed 工具，也不强行追问。',
  '- 用户消息里直接给出明确 X URL 时可以记录；引用里只有一个 X URL 时也可以直接定位。',
  '- 用户给出唯一的序号或唯一标题时可以记录；必须能在当前引用中唯一对应一条 X 内容。',
  '- 引用报告有多个 X URL，而用户只说「这个/这条/它」等无法唯一指向的话时，只问一句「你指哪一条？」；不能调用工具写账本。',
  '- 当前消息明确在谈 X 内容或明确要求记录 X 反馈，但没有可定位的 X 引用上下文，且用户没有直接给出 URL、唯一序号或唯一标题时，只问一句「你指哪一条？」或请用户贴出 URL；不能调用工具写账本，也不能根据会话历史猜。',
  '- 用户明确对已定位的 X 内容说喜欢、不喜欢、收藏或取消收藏时，先定位目标，再调用对应工具（x_feed_record_feedback）。',
  '- 「这批都没兴趣」「最近 Codex 太多」可以记录为 topic/batch feedback，不伪造具体 URL。',
  '- 无论是否曾经记录过、无论用户是否重复表达，只要用户明确表达喜欢/不喜欢/收藏/取消收藏，都必须先调用工具写入或覆盖；不得凭记忆或推测声称「已记录」「无需记录」——只有工具返回成功后，才能向用户确认。',
  '- 具体单条 like/save 只进 X 反馈账本，不进长期 canary memory。',
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
    const store = new XFeedbackStore(dataDir)

    const runtimes = new Map<Agent, () => void>()
    let stopping = false

    if (config.cronJobId === undefined || config.cronJobId === '') {
      ctx.logger.info(
        'dsh-x-feed: cronJobId 未绑定，receipt 保持未绑定（不处理终态事件）；交互反馈工具仍可用',
      )
    } else {
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
      const cleanups = [...runtimes.values()]
      runtimes.clear()
      await Promise.allSettled(cleanups.map(cleanup => Promise.resolve(cleanup())))
    }
  }, 'dsh-x-feed()')
}
