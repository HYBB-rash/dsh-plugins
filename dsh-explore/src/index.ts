import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import z from '@deepseek-ai/schemastery'
import { EXPLORE_CONTRACT } from './prompt.ts'
import { defaultDataDir, ExplorationStore } from './store.ts'
import { registerExploreTools } from './tools.ts'

export const name = 'dsh-explore'
export const inject = ['agents', 'tools', 'systemPrompt']
export interface Config { telegramSessionId?: string; dataDir?: string; dshHome?: string }
export const Config: z<Config> = z.object({ telegramSessionId: z.string().default('session-telegram'), dataDir: z.string().default(''), dshHome: z.string().default('') })
export function resolveDataDir(config: Config): string { return config.dataDir === undefined || config.dataDir === '' ? defaultDataDir(config.dshHome === undefined || config.dshHome === '' ? resolveDshHome() : config.dshHome) : config.dataDir }

export function apply(ctx: Context, config: Config): () => void {
  const telegramSessionId = config.telegramSessionId ?? 'session-telegram'; const store = new ExplorationStore(resolveDataDir(config)); const runtimes = new Map<Agent, () => void>(); let stopping = false
  const installForRoot = (agent: Agent): void => {
    if (stopping || runtimes.has(agent) || !ctx.agents.roots().includes(agent) || agent.session.id !== telegramSessionId) return
    const dispose = agent.ctx.effect(() => { const disposeTools = registerExploreTools(agent.ctx, store); const disposeSection = agent.ctx.systemPrompt.section({ name: 'explore:contract', order: 97, text: EXPLORE_CONTRACT }); return () => { disposeTools(); disposeSection() } }, 'dsh-explore.root()')
    runtimes.set(agent, () => { if (typeof dispose === 'function') dispose() })
  }
  for (const agent of ctx.agents.roots()) installForRoot(agent)
  const stopCreated = ctx.on('agent/created', ({ agent }) => installForRoot(agent))
  return () => { stopping = true; stopCreated(); for (const dispose of runtimes.values()) dispose(); runtimes.clear() }
}
