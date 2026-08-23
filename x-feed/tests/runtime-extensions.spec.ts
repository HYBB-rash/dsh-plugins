import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createCronEnvironmentExtension,
  installTelegramExtension,
  parseXFeedRuntimeConfig,
  resolveDataDir,
  resolvePipelinePath,
  X_FEED_CONTRACT,
} from '../src/index.ts'
import { FileNavigationSnapshotStore } from '../src/navigation/file-navigation-snapshot-store.ts'
import { DeliveryReceipt } from '../src/receipt.ts'
import * as xCronProvider from '../src/x-cron/provider.ts'

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
  it('preserves the existing data directory by default', () => {
    process.env.DSH_HOME = '/tmp/dsh-home'
    expect(resolveDataDir({})).toBe('/tmp/dsh-home/storages/dsh-x-feed')
  })

  it('resolves explicit paths and bounded defaults', () => {
    const config = parseXFeedRuntimeConfig({
      cronJobId: 'cron-x',
      dataDir: '/custom/data',
      pipelinePath: '/custom/x_insight_pipeline.py',
    })
    expect(config).toMatchObject({
      cronJobId: 'cron-x',
      dataDir: '/custom/data',
      pipelinePath: '/custom/x_insight_pipeline.py',
      pythonBin: '/usr/bin/python3',
      telegramSessionId: 'session-telegram',
      feedbackPendingTtlMs: 600_000,
      feedbackTurnTimeoutMs: 30_000,
      personalFeedRequiredSources: [],
      candidateReportingWindowMs: undefined,
    })
    expect(resolvePipelinePath({}).endsWith('python/x_insight_pipeline.py')).toBe(true)
  })

  it('rejects invalid values from host JSON', () => {
    expect(() => parseXFeedRuntimeConfig({ feedbackTurnTimeoutMs: 0 })).toThrow('feedbackTurnTimeoutMs')
    expect(() => parseXFeedRuntimeConfig({ dataDir: 42 })).toThrow('dataDir')
    expect(() => parseXFeedRuntimeConfig({ candidateReportingWindowMs: 0 })).toThrow('candidateReportingWindowMs')
    expect(() => parseXFeedRuntimeConfig({ personalFeedRequiredSources: 'x' })).toThrow('personalFeedRequiredSources')
  })
})

describe('business extension boundaries', () => {
  it('Telegram adapter projects navigation and never subscribes to cron terminal events', async () => {
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

  it('Telegram adapter fails before registering handlers when navigation is unavailable', async () => {
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

  it('cron adapter returns one provider, owns no global listener, and exposes crash recovery', async () => {
    const harness = makeCtx()
    const handle = vi.spyOn(DeliveryReceipt.prototype, 'handle').mockResolvedValue({ ok: true, confirmStatus: 'delivered' })
    const provider = createCronEnvironmentExtension(harness.ctx as never, {
      cronJobId: 'cron-x-1',
      dataDir: '/tmp/x-feed-cron-extension',
      pipelinePath: '/opt/x-feed/python/x_insight_pipeline.py',
      personalFeedRequiredSources: ['x'],
      candidateReportingWindowMs: 300_000,
    })
    expect(provider.marker).toBe('dsh-x-feed/v1')
    expect(provider.requirements).toMatchObject({ jobKind: 'agent', sessionMode: 'per_run', gate: 'forbidden' })
    expect(harness.handlers).toEqual([])
    await provider.settleRecoveredRun?.({
      jobId: 'cron-x-1',
      runId: 'cron-x-1@2026-08-21T00:00:00.000Z',
      sessionId: 'session-cron-x',
      scheduledFor: '2026-08-21T00:00:00.000Z',
      status: 'success',
      deliveryState: 'delivered',
      deliveredAt: '2026-08-21T00:01:00.000Z',
    })
    expect(handle).toHaveBeenCalledOnce()
  })

  it('cron adapter refuses an unbound job', () => {
    expect(() => createCronEnvironmentExtension(makeCtx().ctx as never, {})).toThrow('requires cronJobId')
  })

  it('returns a provider skip byte-for-byte without decorating it with settleRun', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'x-feed-cron-skip-'))
    const skip = Object.freeze({
      kind: 'skip' as const,
      outcome: Object.freeze({ text: undefined, error: undefined }),
    })
    vi.spyOn(xCronProvider, 'createXFeedCronEnvironmentProvider').mockReturnValue({
      marker: 'dsh-x-feed/v1',
      requirements: { jobKind: 'agent', sessionMode: 'per_run', gate: 'forbidden' },
      prepare: vi.fn(async () => skip),
    } as never)

    try {
      const provider = createCronEnvironmentExtension(makeCtx().ctx as never, {
        cronJobId: 'cron-x-skip',
        dataDir: directory,
        pipelinePath: '/opt/x-feed/python/x_insight_pipeline.py',
        personalFeedDataDir: join(directory, 'personal-feed'),
        personalFeedRequiredSources: ['x'],
        candidateReportingWindowMs: 300_000,
      })
      const prepared = await provider.prepare({
        jobId: 'cron-x-skip',
        jobKind: 'agent',
        sessionMode: 'per_run',
        gate: 'forbidden',
        runId: 'cron-x-skip@once',
        trigger: 'scheduled',
        scheduledFor: '2026-08-23T13:00:00.000Z',
        claimedAt: '2026-08-23T13:00:01.000Z',
      })

      expect(prepared).toBe(skip)
      expect(prepared).toEqual(skip)
      expect('settleRun' in prepared).toBe(false)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('establishes one observable Feed period scope before X preparation for scheduled and manual runs', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'x-feed-personal-scope-'))
    const scopeDirectory = join(directory, 'personal-feed')
    const ledgerPath = join(scopeDirectory, 'period-scopes.jsonl')
    const observedScopeCounts: number[] = []
    const prepare = vi.fn(async () => {
      observedScopeCounts.push(readFileSync(ledgerPath, 'utf8').trim().split('\n').length)
      return {
        kind: 'skip' as const,
        outcome: { text: undefined, error: undefined },
      }
    })
    vi.spyOn(xCronProvider, 'createXFeedCronEnvironmentProvider').mockReturnValue({
      marker: 'dsh-x-feed/v1',
      requirements: { jobKind: 'agent', sessionMode: 'per_run', gate: 'forbidden' },
      prepare,
    } as never)

    try {
      const provider = createCronEnvironmentExtension(makeCtx().ctx as never, {
        cronJobId: 'cron-x-scope',
        dataDir: directory,
        pipelinePath: '/opt/x-feed/python/x_insight_pipeline.py',
        personalFeedDataDir: scopeDirectory,
        personalFeedRequiredSources: ['x'],
        candidateReportingWindowMs: 300_000,
      })
      const scheduled = {
        jobId: 'cron-x-scope',
        jobKind: 'agent' as const,
        sessionMode: 'per_run' as const,
        gate: 'forbidden' as const,
        runId: 'cron-x-scope@2026-08-23T13:30:00.000Z',
        trigger: 'scheduled' as const,
        scheduledFor: '2026-08-23T13:30:00.000Z',
        claimedAt: '2026-08-23T13:30:01.000Z',
      }
      const manual = {
        ...scheduled,
        runId: 'manual:cron-x-scope:request-1',
        trigger: 'manual' as const,
        scheduledFor: '2026-08-23T13:31:00.000Z',
        claimedAt: '2026-08-23T13:31:01.000Z',
      }

      await provider.prepare(scheduled)
      await provider.prepare(manual)

      const records = readFileSync(ledgerPath, 'utf8').trim().split('\n').map(line => JSON.parse(line))
      expect(observedScopeCounts).toEqual([1, 2])
      expect(records).toHaveLength(2)
      expect(records.map(record => record.external.trigger)).toEqual(['scheduled', 'manual'])
      expect(records[0].c01.value.run).not.toBe(records[1].c01.value.run)
      for (const record of records) {
        expect(record.c01.value.run).toBe(record.c01.value.period.run)
        expect(record.c02.value.start.period).toEqual(record.c01.value.period)
        expect(record.c34.value.window.period).toEqual(record.c01.value.period)
        expect(record.c34.value.window.sources).toEqual(['x'])
        expect(record.c32[0].value.reportingWindow).toEqual(record.c34.value)
        expect(record.c33.value.period).toEqual(record.c01.value.period)
        expect(record.c35[0].value.scope.reportingWindow).toEqual(record.c34.value)
      }

      await expect(provider.prepare({
        ...manual,
        claimedAt: '2026-08-23T13:31:02.000Z',
      })).rejects.toThrow('already established a different period scope')
      expect(prepare).toHaveBeenCalledTimes(2)
      expect(readFileSync(ledgerPath, 'utf8').trim().split('\n')).toHaveLength(2)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('feedback context contract', () => {
  it('keeps feedback narrow and does not create extra responsibilities', () => {
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
