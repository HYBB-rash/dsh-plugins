import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  CRON_AGENT_ENVIRONMENT_REGISTRY,
  createCronAgentEnvironmentRegistry,
  type CronAgentEnvironmentProvider,
} from '../src/run-environment.ts'
import { SchedulerRuntime, type SchedulerConfig } from '../src/scheduler.ts'
import { JobStore, RunLedger } from '../src/store.ts'
import type { Job } from '../src/types.ts'

const temporaryDirectories: string[] = []

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-cron-todo7-marked-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function readRunRecords(directory: string): Array<Record<string, unknown>> {
  const path = join(directory, 'runs.jsonl')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => JSON.parse(line) as Record<string, unknown>)
}

function lastFinish(directory: string): Record<string, unknown> {
  const finish = readRunRecords(directory).filter(record => record.event === 'finish').at(-1)
  if (finish === undefined) throw new Error('run ledger has no finish record')
  return finish
}

function waitForRunRecords(directory: string, count: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const poll = () => {
      if (readRunRecords(directory).filter(record => record.event === 'finish').length >= count) {
        resolve()
        return
      }
      if (Date.now() - startedAt > 4_000) {
        reject(new Error(`timed out waiting for ${count} run finish records`))
        return
      }
      setTimeout(poll, 10)
    }
    poll()
  })
}

function waitForEvent(directory: string, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const poll = () => {
      if (readRunRecords(directory).some(record => record.event === event)) return resolve()
      if (Date.now() - startedAt > 4_000) return reject(new Error(`timed out waiting for ${event}`))
      setTimeout(poll, 10)
    }
    poll()
  })
}

function seedJob(directory: string, job: Job): void {
  new JobStore(directory).append({ op: 'create', ...job })
}

function markedJob(id: string, deliver: Job['deliver'] = 'default'): Job {
  return {
    id,
    schedule: { kind: 'once', runAt: new Date(Date.now() - 60_000).toISOString() },
    prompt: 'generic marked task',
    deliver,
    sessionMode: 'per_run',
    agentEnvironment: 'test/v1',
    createdAt: new Date().toISOString(),
  }
}

function schedulerConfig(directory: string, deliverOnError = true): SchedulerConfig {
  return {
    storeDir: directory,
    pollIntervalMs: 60_000,
    maxConcurrent: 3,
    deliverOnError,
  }
}

interface RunAgent {
  session: { seq: number; events: SessionEvent[] }
  status: 'idle' | 'running'
  cancel(cause: unknown): void
  followup(message: unknown): void
  whenIdle(): Promise<void>
}

interface ContextOptions {
  readonly registry?: ReturnType<typeof createCronAgentEnvironmentRegistry>
  readonly order: string[]
  readonly agents: RunAgent[]
  readonly createOptions: Array<Record<string, unknown>>
  readonly finish: () => void
  readonly failCleanup?: boolean
}

function schedulerContext(options: ContextOptions): unknown {
  const getService = (name: string): unknown => {
    if (name === CRON_AGENT_ENVIRONMENT_REGISTRY) return options.registry
    if (name === 'sessions') return {
      flush: async () => {
        options.order.push('flush')
        if (options.failCleanup) throw new Error('session flush failed')
      },
    }
    if (name === 'sessionPersistence') {
      throw new Error('per_run execution must not inspect session persistence')
    }
    if (name === 'agentDefaultModel') return {
      currentSelection: () => ({ provider: 'test', model: 'test' }),
    }
    if (name === 'agents') {
      return {
        get: () => undefined,
        resume: async () => { throw new Error('marked per_run execution must not resume') },
        create: async (createOptions: Record<string, unknown>) => {
          options.order.push('create')
          options.createOptions.push(createOptions)
          const agent: RunAgent = {
            session: { seq: 0, events: [] },
            status: 'idle',
            cancel: () => {
              options.order.push('cancel')
              agent.status = 'idle'
              if (options.failCleanup) throw new Error('Agent cancel failed')
            },
            followup: () => undefined,
            whenIdle: async () => {
              options.order.push('idle')
              if (options.failCleanup) throw new Error('Agent idle failed')
            },
          }
          options.agents.push(agent)
          const setup = createOptions.setup as ((context: unknown) => Promise<void>) | undefined
          await setup?.({ on: () => () => undefined })
          return {
            agent,
            dispose: async () => {
              options.order.push('handle-dispose')
              if (options.failCleanup) throw new Error('Agent handle dispose failed')
            },
          }
        },
      }
    }
    return undefined
  }
  return {
    get: getService,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    parallel: async (name: string) => {
      if (name === 'dsh-cron/run-finished') options.finish()
    },
  } as never
}

function markedProvider(
  order: string[],
  overrides: Partial<CronAgentEnvironmentProvider> = {},
): CronAgentEnvironmentProvider {
  return {
    marker: 'test/v1',
    requirements: { jobKind: 'agent', sessionMode: 'per_run', gate: 'forbidden' },
    prepare: async () => {
      order.push('prepare')
      return {
        setupAgent: async () => { order.push('setup') },
        verifySurface: async () => { order.push('verify') },
        finalizeOutcome: async () => { order.push('finalize') },
        dispose: async () => { order.push('environment-dispose') },
      }
    },
    ...overrides,
  }
}

function runMarkedJob(
  directory: string,
  registry: ReturnType<typeof createCronAgentEnvironmentRegistry> | undefined,
  options: {
    readonly order: string[]
    readonly agents: RunAgent[]
    readonly createOptions: Array<Record<string, unknown>>
    readonly delivered: string[]
    readonly finish: () => void
    readonly driveTurn?: (agent: RunAgent, signal: AbortSignal) => Promise<{ text: string } | undefined>
    readonly deliverOnError?: boolean
  },
  controller = new AbortController(),
): SchedulerRuntime {
  const runtime = new SchedulerRuntime(
    schedulerContext({
      registry,
      order: options.order,
      agents: options.agents,
      createOptions: options.createOptions,
      finish: options.finish,
    }) as never,
    schedulerConfig(directory, options.deliverOnError ?? true),
    controller.signal,
    {
      driveTurn: async (agent, _prompt, _sessions, signal) => {
        options.order.push('drive')
        return options.driveTurn?.(agent as RunAgent, signal) ?? { text: '' }
      },
      deliverText: async (text) => {
        options.order.push('deliver')
        options.delivered.push(text)
        return { state: 'delivered', deliveredAt: new Date().toISOString()}
      },
    },
  )
  runtime.start()
  return runtime
}

describe('generic marked Agent run lifecycle acceptance', () => {
  it('claims durably, creates a fresh Agent, cleans it, then delivers once and finishes', async () => {
    const directory = temporaryDirectory()
    seedJob(directory, markedJob('marked-normal'))
    const order: string[] = []
    const agents: RunAgent[] = []
    const createOptions: Array<Record<string, unknown>> = []
    const delivered: string[] = []
    const finish = () => { order.push('finish') }
    const registry = createCronAgentEnvironmentRegistry([markedProvider(order, {
      prepare: async () => {
        const records = readRunRecords(directory)
        expect(records[0]).toMatchObject({ event: 'claim' })
        order.push('prepare')
        return {
          setupAgent: async () => { order.push('setup') },
          verifySurface: async () => { order.push('verify') },
          finalizeOutcome: async () => { order.push('finalize') },
          dispose: async () => { order.push('environment-dispose') },
        }
      },
    })])
    const runtime = runMarkedJob(directory, registry, {
      order,
      agents,
      createOptions,
      delivered,
      finish,
      driveTurn: async agent => {
        agent.status = 'running'
        return { text: 'success body' }
      },
    })
    try {
      await waitForRunRecords(directory, 1)
      expect(order).toEqual([
        'prepare', 'create', 'setup', 'verify', 'drive', 'finalize',
        'cancel', 'idle', 'flush', 'handle-dispose', 'environment-dispose',
        'deliver', 'finish',
      ])
      expect(delivered).toEqual(['success body'])
      expect(createOptions).toHaveLength(1)
      expect(createOptions[0]).toMatchObject({ sessionId: expect.any(String) })
      expect(createOptions[0]).not.toHaveProperty('resumeSessionId')
      expect(createOptions[0]).not.toHaveProperty('seed')
      expect(createOptions[0]).not.toHaveProperty('parent')
      expect(lastFinish(directory)).toMatchObject({ status: 'success', deliveryState: 'delivered' })
    } finally {
      await runtime.dispose()
    }
  })

  it('uses a distinct per-run session and one delivery for each equal marked contract', async () => {
    const directory = temporaryDirectory()
    seedJob(directory, markedJob('marked-round-one'))
    seedJob(directory, markedJob('marked-round-two'))
    const order: string[] = []
    const agents: RunAgent[] = []
    const createOptions: Array<Record<string, unknown>> = []
    const delivered: string[] = []
    const finish = () => { order.push('finish') }
    const provider = markedProvider(order)
    const runtime = runMarkedJob(directory, createCronAgentEnvironmentRegistry([provider]), {
      order, agents, createOptions, delivered, finish,
      driveTurn: async agent => {
        agent.status = 'running'
        return { text: `body-${agents.length}` }
      },
    })
    try {
      await waitForRunRecords(directory, 2)
      expect(createOptions).toHaveLength(2)
      expect(new Set(createOptions.map(options => String(options.sessionId))).size).toBe(2)
      expect(delivered).toHaveLength(2)
      expect(order.filter(step => step === 'prepare')).toHaveLength(2)
      expect(order.filter(step => step === 'create')).toHaveLength(2)
      expect(order.filter(step => step === 'deliver')).toHaveLength(2)
      expect(order.filter(step => step === 'finish')).toHaveLength(2)
    } finally {
      await runtime.dispose()
    }
  })

  it('settles the exact run only after Telegram delivery and the durable finish event', async () => {
    const directory = temporaryDirectory()
    seedJob(directory, markedJob('marked-settlement'))
    const order: string[] = []
    const registry = createCronAgentEnvironmentRegistry([markedProvider(order, {
      prepare: async () => ({
        setupAgent: async () => { order.push('setup') },
        verifySurface: async () => { order.push('verify') },
        finalizeOutcome: async () => { order.push('finalize') },
        settleRun: async event => {
          order.push(`settle:${event.deliveryState}`)
          expect(lastFinish(directory)).toMatchObject({
            event: 'finish',
            runId: event.runId,
            deliveryState: 'delivered',
          })
        },
        dispose: async () => { order.push('environment-dispose') },
      }),
    })])
    const runtime = runMarkedJob(directory, registry, {
      order,
      agents: [],
      createOptions: [],
      delivered: [],
      finish: () => { order.push('finish') },
      driveTurn: async agent => {
        agent.status = 'running'
        return { text: 'settled body' }
      },
    })
    try {
      await waitForRunRecords(directory, 1)
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(order.slice(-3)).toEqual(['deliver', 'finish', 'settle:delivered'])
    } finally {
      await runtime.dispose()
    }
  })

  it('replays an unacknowledged durable finish after restart without rerunning or redelivering', async () => {
    const directory = temporaryDirectory()
    const job = markedJob('marked-recovered-settlement')
    seedJob(directory, job)
    const scheduledFor = (job.schedule as { runAt: string }).runAt
    const runId = `${job.id}@${scheduledFor}`
    const ledger = new RunLedger(directory)
    ledger.claim({
      schemaVersion: 2,
      event: 'claim',
      runId,
      jobId: job.id,
      sessionId: 'session-recovered',
      scheduledFor,
      claimedAt: scheduledFor,
    })
    ledger.finish({
      schemaVersion: 2,
      event: 'finish',
      runId,
      jobId: job.id,
      sessionId: 'session-recovered',
      scheduledFor,
      startedAt: scheduledFor,
      finishedAt: new Date().toISOString(),
      status: 'success',
      deliveryState: 'delivered',
      deliveredAt: new Date().toISOString(),
    })

    const recovered: string[] = []
    const order: string[] = []
    const registry = createCronAgentEnvironmentRegistry([markedProvider(order, {
      settleRecoveredRun: async event => { recovered.push(event.runId) },
    })])
    const options = {
      order,
      agents: [] as RunAgent[],
      createOptions: [] as Array<Record<string, unknown>>,
      delivered: [] as string[],
      finish: () => { order.push('finish') },
    }
    const first = runMarkedJob(directory, registry, options)
    try {
      await waitForEvent(directory, 'environment-settle')
      expect(recovered).toEqual([runId])
      expect(options.createOptions).toEqual([])
      expect(options.delivered).toEqual([])
      expect(order).not.toContain('finish')
    } finally {
      await first.dispose()
    }

    const second = runMarkedJob(directory, registry, options)
    try {
      await new Promise(resolve => setTimeout(resolve, 30))
      expect(recovered).toEqual([runId])
      expect(readRunRecords(directory).filter(record => record.event === 'environment-settle')).toHaveLength(1)
    } finally {
      await second.dispose()
    }
  })

  it.each([
    ['setup', async (order: string[]) => markedProvider(order, {
      prepare: async () => ({
        setupAgent: async () => { order.push('setup'); throw new Error('setup failed') },
        verifySurface: async () => { order.push('verify') },
        dispose: async () => { order.push('environment-dispose') },
      }),
    })],
    ['verify', async (order: string[]) => markedProvider(order, {
      prepare: async () => ({
        setupAgent: async () => { order.push('setup') },
        verifySurface: async () => { order.push('verify'); throw new Error('verify failed') },
        dispose: async () => { order.push('environment-dispose') },
      }),
    })],
    ['drive-timeout', async (order: string[]) => markedProvider(order)],
    ['finalize', async (order: string[]) => markedProvider(order, {
      prepare: async () => ({
        setupAgent: async () => { order.push('setup') },
        verifySurface: async () => { order.push('verify') },
        finalizeOutcome: async () => { order.push('finalize'); throw new Error('finalize failed') },
        dispose: async () => { order.push('environment-dispose') },
      }),
    })],
  ])('fails closed on %s without success body or forged success', async (stage, providerFactory) => {
    const directory = temporaryDirectory()
    seedJob(directory, markedJob(`marked-${stage}`))
    const order: string[] = []
    const agents: RunAgent[] = []
    const createOptions: Array<Record<string, unknown>> = []
    const delivered: string[] = []
    const runtime = runMarkedJob(directory, createCronAgentEnvironmentRegistry([await providerFactory(order)]), {
      order, agents, createOptions, delivered, finish: () => { order.push('finish') },
      driveTurn: async agent => {
        if (stage === 'drive-timeout') {
          agent.status = 'running'
          throw new Error('drive timed out')
        }
        agent.status = 'running'
        return { text: 'success body must not be delivered' }
      },
    })
    try {
      await waitForRunRecords(directory, 1)
      const finish = lastFinish(directory)
      expect(finish.status).toBe('error')
      expect(finish.error).toEqual(expect.stringContaining(stage === 'drive-timeout' ? 'drive timed out' : `${stage} failed`))
      if (stage === 'finalize') {
        expect(delivered).toHaveLength(0)
        expect(finish.deliveryState).toBe('not_requested')
      } else {
        expect(delivered).toHaveLength(1)
        expect(delivered[0]).toContain('出错')
        expect(delivered[0]).not.toContain('success body must not be delivered')
        expect(finish.deliveryState).toBe('delivered')
      }

      const position = (step: string): number => order.indexOf(step)
      if (stage === 'drive-timeout') {
        expect(order.slice(position('cancel'), position('environment-dispose') + 1)).toEqual([
          'cancel', 'idle', 'flush', 'handle-dispose', 'environment-dispose',
        ])
        expect(position('environment-dispose')).toBeLessThan(position('deliver'))
      }
      if (stage === 'verify') {
        expect(order).not.toContain('drive')
        expect(order).not.toContain('finalize')
        expect(order.slice(position('handle-dispose'), position('environment-dispose') + 1)).toEqual([
          'handle-dispose', 'environment-dispose',
        ])
        expect(position('environment-dispose')).toBeLessThan(position('deliver'))
      }
      if (stage === 'finalize') {
        expect(order.slice(position('finalize'), position('environment-dispose') + 1)).toEqual([
          'finalize', 'cancel', 'idle', 'flush', 'handle-dispose', 'environment-dispose',
        ])
        expect(order).not.toContain('deliver')
      }
      if (stage === 'setup') {
        expect(order).toContain('environment-dispose')
        expect(order).not.toContain('verify')
        expect(order).not.toContain('drive')
        expect(order).not.toContain('finalize')
        expect(position('environment-dispose')).toBeLessThan(position('deliver'))
      }
    } finally {
      await runtime.dispose()
    }
  })

  it('aborts an active run through cancel, idle, flush, handle disposal and environment disposal', async () => {
    const directory = temporaryDirectory()
    seedJob(directory, markedJob('marked-abort'))
    const order: string[] = []
    const agents: RunAgent[] = []
    const createOptions: Array<Record<string, unknown>> = []
    const delivered: string[] = []
    const controller = new AbortController()
    let driveStarted = false
    const runtime = runMarkedJob(directory, createCronAgentEnvironmentRegistry([markedProvider(order)]), {
      order, agents, createOptions, delivered, finish: () => { order.push('finish') },
      driveTurn: async (agent, signal) => {
        driveStarted = true
        agent.status = 'running'
        await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
        return undefined
      },
    }, controller)
    try {
      while (!driveStarted) await new Promise(resolve => setTimeout(resolve, 10))
      controller.abort()
      await waitForRunRecords(directory, 1)
      expect(order).toEqual([
        'prepare', 'create', 'setup', 'verify', 'drive', 'cancel', 'idle', 'flush',
        'handle-dispose', 'environment-dispose', 'finish',
      ])
      expect(delivered).toEqual([])
      expect(lastFinish(directory)).toMatchObject({ status: 'interrupted', deliveryState: 'uncertain' })
    } finally {
      await runtime.dispose()
    }
  })

  it('attempts every cleanup step and reports every cleanup failure without success delivery', async () => {
    const directory = temporaryDirectory()
    seedJob(directory, markedJob('marked-cleanup-failures'))
    const order: string[] = []
    const agents: RunAgent[] = []
    const createOptions: Array<Record<string, unknown>> = []
    const delivered: string[] = []
    const provider: CronAgentEnvironmentProvider = {
      marker: 'test/v1',
      requirements: { jobKind: 'agent', sessionMode: 'per_run', gate: 'forbidden' },
      prepare: async () => ({
        setupAgent: async () => { order.push('setup') },
        verifySurface: async () => { order.push('verify') },
        dispose: async () => { order.push('environment-dispose'); throw new Error('environment cleanup failed') },
      }),
    }
    const context = schedulerContext({
      registry: createCronAgentEnvironmentRegistry([provider]),
      order,
      agents,
      createOptions,
      finish: () => { order.push('finish') },
      failCleanup: true,
    }) as never
    const runtime = new SchedulerRuntime(context, schedulerConfig(directory), new AbortController().signal, {
      driveTurn: async (agent, _prompt, _sessions) => {
        order.push('drive')
        agent.status = 'running'
        return { text: 'success body must not be delivered' }
      },
      deliverText: async (text) => { order.push('deliver'); delivered.push(text); return { state: 'delivered', deliveredAt: new Date().toISOString()} },
    })
    runtime.start()
    try {
      await waitForRunRecords(directory, 1)
      const finish = lastFinish(directory)
      expect(order).toContain('cancel')
      expect(order).toContain('idle')
      expect(order).toContain('flush')
      expect(order).toContain('handle-dispose')
      expect(order).toContain('environment-dispose')
      expect(delivered).toHaveLength(1)
      expect(delivered[0]).not.toContain('success body must not be delivered')
      expect(finish).toMatchObject({ status: 'error', deliveryState: 'delivered' })
      expect(String(finish.error)).toEqual(expect.stringContaining('Agent cancel failed'))
      expect(String(finish.error)).toEqual(expect.stringContaining('Agent idle failed'))
      expect(String(finish.error)).toEqual(expect.stringContaining('session flush failed'))
      expect(String(finish.error)).toEqual(expect.stringContaining('Agent handle dispose failed'))
      expect(String(finish.error)).toContain('environment cleanup failed')
    } finally {
      await runtime.dispose()
    }
  })

  it.each([
    ['missing', undefined, 'agent_environment.missing_provider'],
    ['duplicate', createCronAgentEnvironmentRegistry([markedProvider([]), markedProvider([])]), 'agent_environment.duplicate_provider'],
    ['requirements-mismatch', createCronAgentEnvironmentRegistry([markedProvider([], {
      requirements: { jobKind: 'agent', sessionMode: 'persistent', gate: 'forbidden' },
    })]), 'agent_environment.requirements_mismatch'],
    ['prepare-failure', createCronAgentEnvironmentRegistry([markedProvider([], {
      prepare: async () => { throw new Error('provider prepare failed') },
    })]), 'agent_environment.prepare_failed'],
  ])('writes a stable local failure report for %s before any Agent or delivery', async (_name, registry, expectedCode) => {
    const directory = temporaryDirectory()
    seedJob(directory, markedJob(`marked-report-${_name}`))
    const agents: RunAgent[] = []
    const createOptions: Array<Record<string, unknown>> = []
    const delivered: string[] = []
    let driveCalls = 0
    const runtime = runMarkedJob(directory, registry, {
      order: [],
      agents,
      createOptions,
      delivered,
      finish: () => undefined,
      deliverOnError: false,
      driveTurn: async () => { driveCalls++; return { text: 'must not drive' } },
    })
    try {
      await waitForRunRecords(directory, 1)
      const finish = lastFinish(directory)
      expect(finish).toMatchObject({ status: 'error', deliveryState: 'not_requested' })
      expect(String(finish.error)).toContain(expectedCode)
      expect(agents).toHaveLength(0)
      expect(createOptions).toHaveLength(0)
      expect(driveCalls).toBe(0)
      expect(delivered).toHaveLength(0)
    } finally {
      await runtime.dispose()
    }
  })
})
