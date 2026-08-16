/**
 * Plugin entry specs (§11.1/§13): config resolution and the unbound-receipt
 * startup contract.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, X_FEED_CONTRACT, resolveDataDir, resolvePipelinePath } from '../src/index.ts'

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.DSH_HOME
})

function makeCtx(logs: { info: string[]; warn: string[]; error: string[] }) {
  const cleanups: Array<() => unknown> = []
  return {
    logger: {
      info: (m: string) => logs.info.push(m),
      warn: (m: string) => logs.warn.push(m),
      error: (m: string) => logs.error.push(m),
    },
    get: () => undefined,
    effect: async (cb: () => unknown) => {
      const cleanup = await cb()
      cleanups.push(typeof cleanup === 'function' ? cleanup : () => undefined)
      return cleanup
    },
    on: () => () => undefined,
    agents: { roots: () => [] },
  }
}

describe('config resolution (§11.1)', () => {
  it('dataDir 默认 $DSH_HOME/storages/dsh-x-feed', () => {
    process.env.DSH_HOME = '/tmp/dsh-home'
    expect(resolveDataDir({})).toBe('/tmp/dsh-home/storages/dsh-x-feed')
  })

  it('dataDir 显式配置优先', () => {
    expect(resolveDataDir({ dataDir: '/custom/data' })).toBe('/custom/data')
  })

  it('pipelinePath 默认指向包内 python/x_insight_pipeline.py', () => {
    const path = resolvePipelinePath({})
    expect(path.endsWith('python/x_insight_pipeline.py')).toBe(true)
  })

  it('pipelinePath 显式配置优先', () => {
    expect(resolvePipelinePath({ pipelinePath: '/custom/pipeline.py' })).toBe('/custom/pipeline.py')
  })
})

describe('feedback context contract (§10.3)', () => {
  it('明确 URL、唯一序号或唯一引用可记录；多 URL 的“这个”与无上下文都只追问', () => {
    expect(X_FEED_CONTRACT).toContain('没有 X 线索的普通对话')
    expect(X_FEED_CONTRACT).toContain('按普通对话回应，不调用 x_feed 工具，也不强行追问')
    expect(X_FEED_CONTRACT).toContain('用户消息里直接给出明确 X URL')
    expect(X_FEED_CONTRACT).toContain('唯一的序号或唯一标题')
    expect(X_FEED_CONTRACT).toContain('引用报告有多个 X URL')
    expect(X_FEED_CONTRACT).toContain('当前消息明确在谈 X 内容或明确要求记录 X 反馈，但没有可定位的 X 引用上下文')
    expect(X_FEED_CONTRACT).toContain('不能调用工具写账本')
  })
})

describe('unbound receipt (§11.1)', () => {
  it('cronJobId 为空时记录启动日志，不注册终态监听', async () => {
    const logs = { info: [] as string[], warn: [] as string[], error: [] as string[] }
    const ctx = makeCtx(logs)
    let runFinishedRegistered = false
    const origOn = ctx.on
    ctx.on = (name: string) => {
      if (name === 'dsh-cron/run-finished') runFinishedRegistered = true
      return () => undefined
    }
    await apply(ctx as never, { cronJobId: '' })
    expect(runFinishedRegistered).toBe(false)
    expect(logs.info.some(m => m.includes('未绑定'))).toBe(true)
  })

  it('cronJobId 绑定时注册终态监听并记录绑定日志', async () => {
    const logs = { info: [] as string[], warn: [] as string[], error: [] as string[] }
    const ctx = makeCtx(logs)
    let runFinishedRegistered = false
    const origOn = ctx.on
    ctx.on = (name: string) => {
      if (name === 'dsh-cron/run-finished') runFinishedRegistered = true
      return () => undefined
    }
    await apply(ctx as never, { cronJobId: 'cron-x-1' })
    expect(runFinishedRegistered).toBe(true)
    expect(logs.info.some(m => m.includes('cron-x-1'))).toBe(true)
  })
})
