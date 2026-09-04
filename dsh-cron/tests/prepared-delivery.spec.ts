import { describe, expect, it, vi } from 'vitest'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import {
  createPreparedDeliveryEnvironmentProvider,
  PREPARE_DELIVERY_TOOL,
  type PreparedDeliveryDriverRequest,
} from '../src/prepared-delivery.ts'
import type { CronRunFinishedEvent } from '../src/types.ts'

const DRIVER = {
  argv: ['/usr/bin/python3', '/opt/business-driver.py'],
  timeoutSeconds: 30,
  outputMaxBytes: 4_096,
} as const

function finishEvent(): CronRunFinishedEvent {
  return {
    jobId: 'job-a',
    runId: 'job-a@run-1',
    sessionId: 'session-a',
    scheduledFor: '2026-08-21T00:00:00.000Z',
    status: 'success',
    deliveryState: 'delivered',
    deliveredAt: '2026-08-21T00:00:01.000Z',
  }
}

describe('prepared-delivery environment', () => {
  it('prepares the exact text, validates the outcome, then settles the durable receipt', async () => {
    const requests: PreparedDeliveryDriverRequest[] = []
    const execFile = vi.fn(async (_file: string, args: readonly string[]) => {
      requests.push(JSON.parse(args.at(-1)!) as PreparedDeliveryDriverRequest)
      return { stdout: '{"ok":true}', stderr: '' }
    })
    const provider = createPreparedDeliveryEnvironmentProvider({
      bindings: [{ jobId: 'job-a', driver: DRIVER, cwd: '/srv/business' }],
      execFile,
    })
    const lease = await provider.prepare({
      jobId: 'job-a', jobKind: 'agent', sessionMode: 'per_run', gate: 'forbidden', runId: 'job-a@run-1',
    })
    let tool: ToolDefinition | undefined
    let toolDisposed = false
    let promptDisposed = false
    lease.setupAgent({
      tools: {
        register: (value: ToolDefinition) => {
          tool = value
          return () => { toolDisposed = true }
        },
      },
      systemPrompt: {
        section: () => () => { promptDisposed = true },
      },
    })
    expect(tool?.name).toBe(PREPARE_DELIVERY_TOOL)
    await lease.verifySurface({
      ctx: { tools: { schemas: () => [{ name: PREPARE_DELIVERY_TOOL }] } },
    })

    const prepared = await tool!.execute({
      text: 'final body',
      metadata: { urls: ['https://x.com/a/status/1'] },
    }, {} as never)
    expect(prepared).toMatchObject({ ok: true, digest: expect.any(String) })
    await lease.finalizeOutcome?.({ text: 'final body', error: undefined })
    await lease.settleRun?.(finishEvent())
    await lease.dispose()

    expect(requests).toEqual([
      {
        protocolVersion: 1,
        operation: 'prepare',
        jobId: 'job-a',
        runId: 'job-a@run-1',
        payload: { text: 'final body', metadata: { urls: ['https://x.com/a/status/1'] } },
      },
      {
        protocolVersion: 1,
        operation: 'settle',
        jobId: 'job-a',
        runId: 'job-a@run-1',
        event: finishEvent(),
      },
    ])
    expect(execFile).toHaveBeenNthCalledWith(
      1,
      '/usr/bin/python3',
      ['/opt/business-driver.py', expect.any(String)],
      expect.objectContaining({ cwd: '/srv/business', timeout: 30_000, maxBuffer: 4_096 }),
    )
    expect(toolDisposed).toBe(true)
    expect(promptDisposed).toBe(true)
  })

  it('fails closed when final output differs from the prepared text', async () => {
    let tool: ToolDefinition | undefined
    const provider = createPreparedDeliveryEnvironmentProvider({
      bindings: [{ jobId: 'job-a', driver: DRIVER }],
      execFile: async () => ({ stdout: '{"ok":true}', stderr: '' }),
    })
    const lease = await provider.prepare({
      jobId: 'job-a', jobKind: 'agent', sessionMode: 'per_run', gate: 'forbidden', runId: 'job-a@run-1',
    })
    lease.setupAgent({
      tools: { register: (value: ToolDefinition) => { tool = value; return () => undefined } },
      systemPrompt: { section: () => () => undefined },
    })
    await tool!.execute({ text: 'prepared', metadata: {} }, {} as never)
    expect(() => lease.finalizeOutcome?.({ text: 'different', error: undefined }))
      .toThrow('differs from the prepared payload')
  })

  it('replays a recovered durable receipt through the same bounded driver', async () => {
    const requests: PreparedDeliveryDriverRequest[] = []
    const provider = createPreparedDeliveryEnvironmentProvider({
      bindings: [{ jobId: 'job-a', driver: DRIVER }],
      execFile: async (_file, args) => {
        requests.push(JSON.parse(args.at(-1)!) as PreparedDeliveryDriverRequest)
        return { stdout: '{"ok":true}', stderr: '' }
      },
    })
    await provider.settleRecoveredRun?.(finishEvent())
    expect(requests).toEqual([{
      protocolVersion: 1,
      operation: 'settle',
      jobId: 'job-a',
      runId: 'job-a@run-1',
      event: finishEvent(),
    }])
  })

  it('rejects duplicate job bindings before any run starts', () => {
    expect(() => createPreparedDeliveryEnvironmentProvider({
      bindings: [
        { jobId: 'job-a', driver: DRIVER },
        { jobId: 'job-a', driver: DRIVER },
      ],
    })).toThrow('duplicate prepared-delivery binding')
  })
})
