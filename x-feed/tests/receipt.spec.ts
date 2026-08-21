/**
 * Delivery receipt specs (§11.3): job filtering, status mapping, bounded
 * retries, no-shell args, and dispose semantics.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { DeliveryReceipt, type ExecFileFn } from '../src/receipt.ts'
import type { CronRunFinishedEvent } from '@deepseek-ai/dsh-cron'

function event(partial: Partial<CronRunFinishedEvent>): CronRunFinishedEvent {
  return {
    jobId: 'cron-x-1',
    runId: 'cron-x-1@2026-08-15T00:00:00.000Z',
    sessionId: 'session-cron-cron-x-1',
    scheduledFor: '2026-08-15T00:00:00.000Z',
    status: 'success',
    ...partial,
  }
}

function receiptDeps(overrides: {
  cronJobId?: string
  execFile?: ExecFileFn
  failTimes?: number
  calls?: Array<{ file: string; args: string[]; options: object }>
} = {}) {
  const calls = overrides.calls ?? []
  let failures = overrides.failTimes ?? 0
  const execFile: ExecFileFn = async (file, args, options) => {
    calls.push({ file, args: [...args], options })
    if (failures > 0) {
      failures--
      throw new Error('python crashed')
    }
    return { stdout: '{"ok": true}', stderr: '' }
  }
  return {
    calls,
    receipt: new DeliveryReceipt({
      cronJobId: overrides.cronJobId ?? 'cron-x-1',
      dataDir: '/tmp/dsh-x-feed-test',
      pythonBin: '/usr/bin/python3',
      pipelinePath: '/pkg/python/x_insight_pipeline.py',
      logger: { warn: () => undefined, error: () => undefined },
      execFile,
      sleep: async () => undefined,
    }),
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('job filtering (§11.2)', () => {
  it('非目标 job 完全无动作', async () => {
    const { calls, receipt } = receiptDeps()
    const r = await receipt.handle(event({ jobId: 'cron-other' }))
    expect(r).toEqual({ ok: true, skipped: true })
    expect(calls).toHaveLength(0)
  })

  it('未绑定 cronJobId：不执行 confirm 并记录 unbound', async () => {
    const { calls, receipt } = receiptDeps({ cronJobId: '' })
    const r = await receipt.handle(event({}))
    expect(r).toEqual({ ok: false, error: 'receipt_unbound' })
    expect(calls).toHaveLength(0)
  })
})

describe('status mapping (§11.2)', () => {
  it('success + deliveredAt → confirm delivered', async () => {
    const { calls, receipt } = receiptDeps()
    const r = await receipt.handle(event({ status: 'success', deliveredAt: '2026-08-15T00:00:01.000Z' }))
    expect(r.ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.file).toBe('/usr/bin/python3')
    expect(calls[0]!.args).toContain('confirm-prepared')
    expect(calls[0]!.args).toContain('--status')
    expect(calls[0]!.args).toContain('delivered')
  })

  it('error/silent/interrupted/expired → confirm not-delivered', async () => {
    for (const status of ['error', 'silent', 'interrupted', 'expired'] as const) {
      const { calls, receipt } = receiptDeps()
      const r = await receipt.handle(event({ status }))
      expect(r.ok).toBe(true)
      const args = calls[0]!.args
      expect(args[args.indexOf('--status') + 1]).toBe('not-delivered')
    }
  })

  it('success 缺 deliveredAt → not-delivered', async () => {
    const { calls, receipt } = receiptDeps()
    await receipt.handle(event({ status: 'success' }))
    const args = calls[0]!.args
    expect(args[args.indexOf('--status') + 1]).toBe('not-delivered')
  })

  it('重复 success 事件调用幂等 confirm（上游不会重复增加 shown）', async () => {
    const { calls, receipt } = receiptDeps()
    const ev = event({ status: 'success', deliveredAt: '2026-08-15T00:00:01.000Z' })
    await receipt.handle(ev)
    await receipt.handle(ev)
    // 两次都显式传 package/shown 路径与 DSH_X_FEED_DATA_DIR；Python 侧幂等
    expect(calls).toHaveLength(2)
    for (const call of calls) {
      const env = call.options as { env: Record<string, string | undefined> }
      expect(env.env.DSH_X_FEED_DATA_DIR).toBe('/tmp/dsh-x-feed-test')
      expect(call.args.join(' ')).toContain('--package /tmp/dsh-x-feed-test/x_insight_package.json')
      expect(call.args.join(' ')).toContain('--shown /tmp/dsh-x-feed-test/x_shown.json')
    }
  })
})

describe('retry and failure semantics (§11.2/§11.3)', () => {
  it('首次 exec 失败、第二次成功可恢复', async () => {
    const { calls, receipt } = receiptDeps({ failTimes: 1 })
    const r = await receipt.confirm('delivered')
    expect(r).toEqual({ ok: true, confirmStatus: 'delivered' })
    expect(calls).toHaveLength(2)
  })

  it('三次失败后抛出（不修改 shown，不重投 Telegram）', async () => {
    const { calls, receipt } = receiptDeps({ failTimes: 99 })
    await expect(receipt.confirm('delivered')).rejects.toThrow(/after 3 attempts/)
    expect(calls).toHaveLength(3)
  })

  it('参数中 URL/路径不经 shell（execFile 参数数组，无 shell）', async () => {
    const { calls, receipt } = receiptDeps()
    await receipt.handle(event({ status: 'success', deliveredAt: 't' }))
    expect(calls).toHaveLength(1)
    expect(calls[0]!.args).toBeInstanceOf(Array)
    expect(calls[0]!.args).toContain('delivered')
    const options = calls[0]!.options as { timeout: number; maxBuffer: number }
    expect(options.timeout).toBe(15_000)
    expect(options.maxBuffer).toBe(64 * 1024)
  })
})
