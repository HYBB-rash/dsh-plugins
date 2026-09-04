import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  installTelegramExtension,
} from '../src/index.ts'
import {
  parseXFeedRuntimeConfig,
  resolveDataDir,
  resolveObserverCliPath,
} from '../src/config.ts'
import {
  X_FEED_CONTRACT,
} from '../src/telegram-extension.ts'
import { FileNavigationSnapshotStore } from '../src/navigation/file-navigation-snapshot-store.ts'

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.DSH_HOME
})

function makeCtx(logs = { info: [] as string[], warn: [] as string[], error: [] as string[] }) {
  const handlers: string[] = []
  const listeners: Array<{ readonly name: string; readonly listener: (...args: any[]) => unknown }> = []
  const sessionQuery = {
    listEvents: async (_sessionId: string) => [],
    readEvent: async (_input: unknown) => undefined,
  }
  return {
    logs,
    handlers,
    listeners,
    ctx: {
      logger: {
        info: (message: string) => logs.info.push(message),
        warn: (message: string) => logs.warn.push(message),
        error: (message: string) => logs.error.push(message),
      },
      get: (name: string) => name === 'sessionQuery'
        ? sessionQuery
        : name === 'agentDefaultModel'
          ? { currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }) }
          : undefined,
      llm: { stream: async function* (_request: unknown) { /* empty fixture stream */ } },
      on: (name: string, listener?: (...args: any[]) => unknown) => {
        handlers.push(name)
        if (listener !== undefined) listeners.push({ name, listener })
        return () => undefined
      },
      waterfall: (name: string, value: unknown, root: () => unknown) => {
        const chain = listeners.filter(entry => entry.name === name).map(entry => entry.listener)
        let index = 0
        const next = (): unknown => {
          const listener = chain[index++]
          return listener === undefined ? root() : listener(value, next)
        }
        return next()
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
      personalFeedDataDir: '/custom/personal-feed',
      personalFeedRequiredSources: ['x'],
      candidateReportingWindowMs: 300_000,
    })
    expect(config).toEqual({
      dataDir: '/custom/data',
      personalFeedDataDir: '/custom/personal-feed',
      telegramSessionId: 'session-telegram',
      feedbackPendingTtlMs: 600_000,
      feedbackTurnTimeoutMs: 30_000,
    })
    expect(resolveObserverCliPath({}).endsWith('python/x_personal_feed_observer_cli.py')).toBe(true)
  })

  it('resolves the Personal Feed directory separately, including its default and type boundary', () => {
    process.env.DSH_HOME = '/tmp/dsh-home'
    expect(parseXFeedRuntimeConfig({}).personalFeedDataDir)
      .toBe('/tmp/dsh-home/storages/personal-feed')
    expect(parseXFeedRuntimeConfig({ personalFeedDataDir: '/custom/personal-feed' }).personalFeedDataDir)
      .toBe('/custom/personal-feed')
    expect(() => parseXFeedRuntimeConfig({ personalFeedDataDir: 42 })).toThrow('personalFeedDataDir')
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
      const dispose = await installTelegramExtension(harness.ctx as never, {
        dataDir,
        personalFeedDataDir: join(dataDir, 'personal-feed'),
      })
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

  it('observes Personal Feed first, then lets X feedback clear pending before the Feed handler fails safely', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'x-feed-telegram-personal-feed-'))
    const personalFeedDataDir = join(dataDir, 'personal-feed')
    const harness = makeCtx()
    try {
      const dispose = await installTelegramExtension(harness.ctx as never, {
        dataDir,
        personalFeedDataDir,
        personalFeedRequiredSources: ['x'],
      })
      const waterfallListeners = harness.listeners
        .filter(entry => entry.name === 'telegram/inbound')
        .map(entry => entry.listener)
      expect(waterfallListeners).toHaveLength(3)

      const root = vi.fn(() => ({ kind: 'root-delivered' as const }))
      const envelope = Object.freeze({
        chat: Object.freeze({ id: 7, type: 'private' }),
        message: Object.freeze({ id: 11 }),
        currentText: '给我一次个人 Feed',
        signal: new AbortController().signal,
      })
      const result = await harness.ctx.waterfall!('telegram/inbound', envelope, root)

      expect(result).toMatchObject({
        kind: 'handled',
        finalText: '这次没有完成：个人语境不足或未完成。',
      })
      expect((result as { readonly finalText: string }).finalText).not.toBe('这次没有值得看的内容。')
      expect(root).not.toHaveBeenCalled()
      await dispose()
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('Telegram adapter fails before registering handlers when navigation is unavailable', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'x-feed-startup-failure-'))
    const harness = makeCtx()
    vi.spyOn(FileNavigationSnapshotStore.prototype, 'replace').mockImplementation(() => {
      throw new Error('navigation disk unavailable')
    })
    try {
      await expect(installTelegramExtension(harness.ctx as never, {
        dataDir,
        personalFeedDataDir: join(dataDir, 'personal-feed'),
      }))
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
