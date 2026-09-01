import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  installTelegramExtension,
  parseXFeedRuntimeConfig,
  resolveDataDir,
  resolvePipelinePath,
  X_FEED_CONTRACT,
} from '../src/index.ts'
import { FileNavigationSnapshotStore } from '../src/navigation/file-navigation-snapshot-store.ts'

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.DSH_HOME
})

function makeCtx(logs = { info: [] as string[], warn: [] as string[], error: [] as string[] }) {
  const handlers: string[] = []
  return {
    logs,
    handlers,
    ctx: {
      logger: {
        info: (message: string) => logs.info.push(message),
        warn: (message: string) => logs.warn.push(message),
        error: (message: string) => logs.error.push(message),
      },
      on: (name: string) => {
        handlers.push(name)
        return () => undefined
      },
      agents: { roots: () => [] },
    },
  }
}

describe('X runtime configuration', () => {
  it('preserves the existing X data directory by default', () => {
    process.env.DSH_HOME = '/tmp/dsh-home'
    expect(resolveDataDir({})).toBe('/tmp/dsh-home/storages/dsh-x-feed')
  })

  it('resolves only the Telegram feedback and bookmark fields used by the formal extension', () => {
    const config = parseXFeedRuntimeConfig({
      cronJobId: 'cron-x',
      dataDir: '/custom/data',
      pythonBin: '/custom/python3',
      pipelinePath: '/custom/x_insight_pipeline.py',
      personalFeedDataDir: '/obsolete/personal-feed',
      personalFeedRequiredSources: ['x'],
      candidateReportingWindowMs: 300_000,
    })
    expect(config).toEqual({
      dataDir: '/custom/data',
      telegramSessionId: 'session-telegram',
      feedbackPendingTtlMs: 600_000,
      feedbackTurnTimeoutMs: 30_000,
    })
    expect(resolvePipelinePath({}).endsWith('python/x_insight_pipeline.py')).toBe(true)
  })

  it('rejects invalid fields that remain part of the X runtime contract', () => {
    expect(() => parseXFeedRuntimeConfig({ feedbackTurnTimeoutMs: 0 })).toThrow('feedbackTurnTimeoutMs')
    expect(() => parseXFeedRuntimeConfig({ dataDir: 42 })).toThrow('dataDir')
  })
})

describe('Telegram extension boundary', () => {
  it('projects navigation and never subscribes to cron terminal events', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'x-feed-telegram-extension-'))
    try {
      const harness = makeCtx()
      const dispose = await installTelegramExtension(harness.ctx as never, { dataDir })
      expect(JSON.parse(readFileSync(join(dataDir, 'trusted-fact-navigation.json'), 'utf8'))).toMatchObject({
        schemaVersion: 1,
        items: [],
      })
      expect(harness.handlers).toContain('telegram/inbound')
      expect(harness.handlers).not.toContain('dsh-cron/run-finished')
      await dispose()
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('fails before registering handlers when navigation is unavailable', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'x-feed-startup-failure-'))
    const harness = makeCtx()
    vi.spyOn(FileNavigationSnapshotStore.prototype, 'replace').mockImplementation(() => {
      throw new Error('navigation disk unavailable')
    })
    try {
      await expect(installTelegramExtension(harness.ctx as never, { dataDir }))
        .rejects.toThrow('x-feed: trusted-fact navigation not-ready: navigation disk unavailable')
      expect(harness.handlers).toEqual([])
      expect(harness.logs.error.some(message => message.includes('not-ready'))).toBe(true)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})

describe('feedback context contract', () => {
  it('keeps feedback narrow and leaves ordinary non-X messages alone', () => {
    expect(X_FEED_CONTRACT).toContain('没有 X 线索的普通对话')
    expect(X_FEED_CONTRACT).toContain('按普通对话回应，不调用 x_feed 工具，也不强行追问')
    expect(X_FEED_CONTRACT).toContain('Telegram 引用块只提供定位上下文，当前用户消息才是用户的新指令')
    expect(X_FEED_CONTRACT).toContain('引用报告有多个 X URL')
    expect(X_FEED_CONTRACT).toContain('不能调用工具写账本')
    expect(X_FEED_CONTRACT).toContain('收藏或取消收藏时，先定位目标，再调用 x_feed_record_feedback')
    expect(X_FEED_CONTRACT).toContain('喜欢/不喜欢由 Telegram clean feedback 与 TrustedFact 链处理')
    expect(X_FEED_CONTRACT).toContain('不因为反馈创建当前承诺、cron 或后台 worker')
    expect(X_FEED_CONTRACT).not.toContain('dsh-explore')
    expect(X_FEED_CONTRACT).not.toContain('research_read_page')
  })
})
