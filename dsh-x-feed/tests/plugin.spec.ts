/**
 * Plugin entry specs (§11.1/§13): config resolution and the unbound-receipt
 * startup contract.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, X_FEED_CONTRACT, resolveDataDir, resolvePipelinePath } from '../src/index.ts'
import { FileNavigationSnapshotStore } from '../src/navigation/file-navigation-snapshot-store.ts'

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.DSH_HOME
})

function makeCtx(logs: { info: string[]; warn: string[]; error: string[] }) {
  const cleanups: Array<() => unknown> = []
  const on = vi.fn(() => () => undefined)
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
    on,
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
  it('只处理可定位的 X 反馈：多 URL 歧义只问一句，成功写入后确认且不扩展为其他责任', () => {
    expect(X_FEED_CONTRACT).not.toContain('探索合同')
    expect(X_FEED_CONTRACT).not.toContain('探索账本')
    expect(X_FEED_CONTRACT).not.toContain('exploration_record')
    expect(X_FEED_CONTRACT).not.toContain('dsh-explore')
    expect(X_FEED_CONTRACT).not.toContain('research_read_page')
    expect(X_FEED_CONTRACT).not.toContain('browser_unavailable')
    expect(X_FEED_CONTRACT).not.toContain('unsupported_content')
    expect(X_FEED_CONTRACT).not.toContain('blocked_address')
    expect(X_FEED_CONTRACT).not.toContain('blocked_redirect')
    expect(X_FEED_CONTRACT).not.toContain('x_path_forbidden')
    expect(X_FEED_CONTRACT).not.toContain('fallback')
    expect(X_FEED_CONTRACT).not.toContain('Browser')
    expect(X_FEED_CONTRACT).not.toContain('Explore')
    expect(X_FEED_CONTRACT).not.toContain('优先读取')
    expect(X_FEED_CONTRACT).not.toContain('keep')
    expect(X_FEED_CONTRACT).not.toContain('dismiss')
    expect(X_FEED_CONTRACT).toContain('没有 X 线索的普通对话')
    expect(X_FEED_CONTRACT).toContain('按普通对话回应，不调用 x_feed 工具，也不强行追问')
    expect(X_FEED_CONTRACT).toContain('Telegram 引用块只提供定位上下文，当前用户消息才是用户的新指令')
    expect(X_FEED_CONTRACT).toContain('用户消息里直接给出明确 X URL')
    expect(X_FEED_CONTRACT).toContain('唯一的序号或唯一标题')
    expect(X_FEED_CONTRACT).toContain('引用报告有多个 X URL')
    expect(X_FEED_CONTRACT).toContain('当前消息明确在谈 X 内容或明确要求记录 X 反馈，但没有可定位的 X 引用上下文')
    expect(X_FEED_CONTRACT).toContain('不能调用工具写账本')
    expect(X_FEED_CONTRACT).toContain('收藏或取消收藏时，先定位目标，再调用 x_feed_record_feedback')
    expect(X_FEED_CONTRACT).toContain('喜欢/不喜欢由 Telegram clean feedback 与 TrustedFact 链处理')
    expect(X_FEED_CONTRACT).toContain('只有对应链路成功后，才能向用户确认')
    expect(X_FEED_CONTRACT).toContain('只写 X 收藏账本；具体单条 save/unsave 不进长期 canary memory')
    expect(X_FEED_CONTRACT).toContain('不得为了 X 反馈另建 Markdown、research 文件或其他平行收藏文件')
    expect(X_FEED_CONTRACT).toContain('不因为反馈创建当前承诺、cron 或后台 worker')
  })
})

describe('unbound receipt (§11.1)', () => {
  it('projects an empty navigation before activation completes', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dsh-x-feed-startup-'))
    try {
      const ctx = makeCtx({ info: [], warn: [], error: [] })
      await apply(ctx as never, {
        cronJobId: '',
        dataDir,
        feedbackPendingTtlMs: 600_000,
        feedbackTurnTimeoutMs: 30_000,
      })

      expect(JSON.parse(readFileSync(join(dataDir, 'trusted-fact-navigation.json'), 'utf8'))).toMatchObject({
        schemaVersion: 1,
        items: [],
      })
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('aborts activation and registers nothing when startup projection fails', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dsh-x-feed-startup-failure-'))
    const logs = { info: [] as string[], warn: [] as string[], error: [] as string[] }
    const ctx = makeCtx(logs)
    vi.spyOn(FileNavigationSnapshotStore.prototype, 'replace').mockImplementation(() => {
      throw new Error('navigation disk unavailable')
    })

    try {
      await expect(apply(ctx as never, {
        cronJobId: 'cron-x-1',
        dataDir,
        feedbackPendingTtlMs: 600_000,
        feedbackTurnTimeoutMs: 30_000,
      })).rejects.toThrow('dsh-x-feed: trusted-fact navigation not-ready: navigation disk unavailable')
      expect(ctx.on).not.toHaveBeenCalled()
      expect(logs.error.some(message => message.includes('not-ready'))).toBe(true)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('cronJobId 为空时记录启动日志，不注册终态监听', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dsh-x-feed-unbound-'))
    const logs = { info: [] as string[], warn: [] as string[], error: [] as string[] }
    const ctx = makeCtx(logs)
    let runFinishedRegistered = false
    const origOn = ctx.on
    ctx.on = (name: string) => {
      if (name === 'dsh-cron/run-finished') runFinishedRegistered = true
      return () => undefined
    }
    try {
      await apply(ctx as never, { cronJobId: '', dataDir })
      expect(runFinishedRegistered).toBe(false)
      expect(logs.info.some(m => m.includes('未绑定'))).toBe(true)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('cronJobId 绑定时注册终态监听并记录绑定日志', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dsh-x-feed-bound-'))
    const logs = { info: [] as string[], warn: [] as string[], error: [] as string[] }
    const ctx = makeCtx(logs)
    let runFinishedRegistered = false
    const origOn = ctx.on
    ctx.on = (name: string) => {
      if (name === 'dsh-cron/run-finished') runFinishedRegistered = true
      return () => undefined
    }
    try {
      await apply(ctx as never, { cronJobId: 'cron-x-1', dataDir })
      expect(runFinishedRegistered).toBe(true)
      expect(logs.info.some(m => m.includes('cron-x-1'))).toBe(true)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
