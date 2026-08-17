import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import z from '@deepseek-ai/schemastery'
import { BROWSER_READONLY_CONTRACT } from './prompt.ts'
import { registerBrowserTools } from './tools.ts'

export const name = 'dsh-browser-readonly'
export const inject = ['agents', 'tools', 'systemPrompt']

export interface Config {
  readonly telegramSessionId?: string
  readonly dshHome?: string
  readonly cdpBaseUrl?: string
  readonly browserLockPath?: string
}

export const Config: z<Config> = z.object({
  telegramSessionId: z.string().default('session-telegram'),
  dshHome: z.string().default(''),
  cdpBaseUrl: z.string().default('http://127.0.0.1:9222'),
  browserLockPath: z.string().default(''),
})

function qualified(ctx: Context, agent: Agent, sessionId: string): boolean {
  return ctx.agents.roots().includes(agent) && agent.session.id === sessionId
}

function loopbackHttp(value: string): boolean {
  try {
    const url = new URL(value)
    const hostname = url.hostname.replace(/^\[|\]$/g, '')
    return url.protocol === 'http:' && url.username === '' && url.password === '' && ['127.0.0.1', '::1', 'localhost'].includes(hostname)
  } catch { return false }
}

/** Mount this potentially login-adjacent reader only into session-telegram. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  await ctx.effect(async () => {
    const sessionId = config.telegramSessionId ?? 'session-telegram'
    const dshHome = resolveDshHome(config.dshHome === '' ? undefined : config.dshHome)
    const cdpBaseUrl = config.cdpBaseUrl ?? 'http://127.0.0.1:9222'
    if (!loopbackHttp(cdpBaseUrl)) throw new Error('dsh-browser-readonly: cdpBaseUrl 必须是 loopback HTTP')
    const browserLockPath = config.browserLockPath === undefined || config.browserLockPath === ''
      ? `${dshHome}/storages/dsh-x-feed/.x_timeline_browser.lock`
      : config.browserLockPath
    const runtimes = new Map<Agent, () => void>()
    let stopping = false
    const installForRoot = (agent: Agent): void => {
      if (runtimes.has(agent) || !qualified(ctx, agent, sessionId)) return
      const dispose = agent.ctx.effect(() => {
        const disposeTools = registerBrowserTools(agent.ctx, { dshHome, cdpBaseUrl, browserLockPath })
        const disposePrompt = agent.ctx.systemPrompt.section({ name: 'browser-readonly:contract', order: 112, text: BROWSER_READONLY_CONTRACT })
        return () => { disposeTools(); disposePrompt() }
      }, 'dsh-browser-readonly.root()')
      let done = false
      runtimes.set(agent, () => {
        if (done) return
        done = true
        if (typeof dispose === 'function') dispose()
      })
    }
    for (const agent of ctx.agents.roots()) installForRoot(agent)
    const stopCreated = ctx.on('agent/created', ({ agent }) => {
      if (!stopping && ctx.agents.roots().includes(agent)) installForRoot(agent)
    })
    return async () => {
      stopping = true
      stopCreated()
      const cleanups = [...runtimes.values()]
      runtimes.clear()
      await Promise.allSettled(cleanups.map(cleanup => Promise.resolve(cleanup())))
    }
  }, 'dsh-browser-readonly()')
}
