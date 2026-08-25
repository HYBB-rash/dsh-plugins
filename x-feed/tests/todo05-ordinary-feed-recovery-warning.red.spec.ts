import { Context } from '@deepseek-ai/cordis'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { CallId, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { CronAgentEnvironmentPrepareContext, CronRunDeliveryMeaningRunPort } from '@deepseek-ai/dsh-cron'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRealOrdinaryFeedFixture } from './support/todo05-real-ordinary-feed-fixture.ts'
import { createOrdinaryFeedRunLifecycle } from '../src/personal-feed/ordinary-feed-run-lifecycle.ts'

const SUBMIT_PROPOSAL = 'submit_x_ordinary_feed_editing_proposal'
const FIXED_WARNING_PREFIX = 'x-feed: ordinary recovery failed category=ordinary_feed_recovery'
const MATERIAL_TOKEN = 'material-secret-token-ordinary-recovery'
const REASON_TOKEN = 'reason-secret-token-ordinary-recovery'
const BODY_TOKEN = 'body-secret-token-ordinary-recovery'

type FailureMode = 'structured' | 'proposal' | 'valid'
type OrdinaryFeedFixture = Awaited<ReturnType<typeof createRealOrdinaryFeedFixture>>
type HarnessFault = (fixture: OrdinaryFeedFixture) => {
  readonly editor?: OrdinaryFeedFixture['editor']
  readonly finalizer?: OrdinaryFeedFixture['finalizer']
}

class RecoveryFailureAdapter extends LlmAdapter {
  constructor(private readonly modes: FailureMode[]) { super() }

  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async *stream(_request: GenerateOptions): AsyncIterable<StreamChunk> {
    const mode = this.modes.shift() ?? 'structured'
    if (mode === 'structured') throw new Error(`${MATERIAL_TOKEN} ${BODY_TOKEN}`)
    const argumentsText = JSON.stringify({
      title: mode === 'valid' ? `${MATERIAL_TOKEN} valid proposal` : `${MATERIAL_TOKEN} dynamic proposal title`,
      sections: mode === 'valid'
        ? [{ kind: 'highlight', items: [{ itemId: 'item:x-status:1001', summary: `${BODY_TOKEN} summary` }] }]
        : [],
      decisions: mode === 'valid'
        ? [
            { itemId: 'item:x-status:1001', kind: 'selected' },
            { itemId: 'item:x-status:1002', kind: 'not_selected', semanticReason: REASON_TOKEN },
          ]
        : [{ itemId: 'item:x-status:1001', kind: 'not_selected', semanticReason: REASON_TOKEN }],
    })
    const callId = CallId('todo05-warning-proposal')
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield {
      type: 'tool-call-delta', index: 0, id: callId, name: SUBMIT_PROPOSAL,
      argumentsDelta: argumentsText,
    }
    yield {
      type: 'block-end', index: 0,
      block: { type: 'tool-call', id: callId, name: SUBMIT_PROPOSAL, arguments: argumentsText },
    }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

interface WarningHarness {
  readonly fixture: Awaited<ReturnType<typeof createRealOrdinaryFeedFixture>>
  readonly ctx: Context
  readonly lifecycle: ReturnType<typeof createOrdinaryFeedRunLifecycle>
  readonly warnings: string[]
  readonly dispose: () => Promise<void>
}

const harnesses: WarningHarness[] = []

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map(harness => harness.dispose()))
})

async function createHarness(modes: FailureMode[], fault?: HarnessFault): Promise<WarningHarness> {
  const fixture = await createRealOrdinaryFeedFixture()
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(AgentDefaultModelConfig, { provider: 'todo05-warning', model: 'todo05-warning' })
  ctx.llm.registerAdapter(['todo05-warning'], new RecoveryFailureAdapter(modes))

  const warnings: string[] = []
  const logger = ctx.logger as unknown as { warn: (...args: readonly unknown[]) => void }
  vi.spyOn(logger, 'warn').mockImplementation((...args) => warnings.push(String(args[0])))
  const overrides = fault?.(fixture) ?? {}
  const lifecycle = createOrdinaryFeedRunLifecycle({
    ctx,
    editor: overrides.editor ?? fixture.editor,
    finalizer: overrides.finalizer ?? fixture.finalizer,
    deliveryAndReceipt: fixture.deliveryAndReceipt,
    candidateLocalState: fixture.candidateLocalState,
    finalizationOwner: fixture.finalizationOwner,
  })
  const harness = {
    fixture,
    ctx,
    lifecycle,
    warnings,
    dispose: async () => {
      await ctx.fiber.dispose()
      fixture.dispose()
    },
  }
  harnesses.push(harness)
  return harness
}

function runContext(
  jobId: string,
  runId: string,
  sessionId: string,
): CronAgentEnvironmentPrepareContext {
  const runDeliveryMeaningPort: CronRunDeliveryMeaningRunPort = Object.freeze({
    bindPreparedDelivery: async () => ({ status: 'accepted' as const }),
    acceptDurableReceipt: async input => ({ status: 'accepted' as const, value: { receipt: input } }),
    commitBusinessFinalization: async () => ({ status: 'accepted' as const }),
  })
  return {
    jobId,
    jobKind: 'agent',
    sessionMode: 'per_run',
    gate: 'forbidden',
    runId,
    trigger: 'scheduled',
    scheduledFor: '2026-08-24T00:00:00.000Z',
    claimedAt: '2026-08-24T00:00:01.000Z',
    sessionId,
    runDeliveryMeaningPort,
  } as CronAgentEnvironmentPrepareContext
}

function runContextWithoutSessionId(
  jobId: string,
  runId: string,
): CronAgentEnvironmentPrepareContext {
  const { sessionId: _sessionId, ...context } = runContext(jobId, runId, 'not-live') as CronAgentEnvironmentPrepareContext & {
    readonly sessionId?: string
  }
  return context as CronAgentEnvironmentPrepareContext
}

async function rejectOnce(
  harness: WarningHarness,
  context: CronAgentEnvironmentPrepareContext,
): Promise<Error> {
  const error = await harness.lifecycle.prepareOrdinaryFeed({
    period: harness.fixture.period,
    context,
  }).then(() => undefined, value => value)
  expect(error).toBeInstanceOf(Error)
  return error as Error
}

function safeBindingPart(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, '?')
}

function expectedWarning(
  stage: string,
  code: string,
  binding: { readonly jobId: string; readonly runId: string; readonly sessionId: string },
): string {
  return `${FIXED_WARNING_PREFIX} stage=${stage} code=${code}`
    + ` jobId=${safeBindingPart(binding.jobId)}`
    + ` runId=${safeBindingPart(binding.runId)}`
    + ` sessionId=${safeBindingPart(binding.sessionId)}`
}

function xWarnings(harness: WarningHarness): readonly string[] {
  return harness.warnings.filter(warning => warning.startsWith('x-feed:'))
}

function assertSafeWarning(warning: string): void {
  expect(warning).not.toContain(MATERIAL_TOKEN)
  expect(warning).not.toContain(REASON_TOKEN)
  expect(warning).not.toContain(BODY_TOKEN)
  expect(warning).not.toContain('dynamic proposal title')
  expect(warning).not.toContain('candidate')
  expect(warning).not.toContain('body')
  expect(warning).not.toContain('cause')
}

function assertSafeDiagnostic(error: Error, stage: string, code: string): void {
  expect(error).toMatchObject({ stage, code, message: 'ordinary Feed recovery failed' })
  const surface = [String(error), JSON.stringify(error), ...Reflect.ownKeys(error).map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(error, key)
    return `${String(key)}:${String(descriptor?.value)}`
  })].join('\n')
  expect(surface).not.toContain(MATERIAL_TOKEN)
  expect(surface).not.toContain(REASON_TOKEN)
  expect(surface).not.toContain(BODY_TOKEN)
}

async function snapshotDirectory(root: string): Promise<readonly { readonly path: string; readonly bytes: string }[]> {
  const entries = await readdir(root, { withFileTypes: true })
  const snapshots: { path: string; bytes: string }[] = []
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      snapshots.push(...(await snapshotDirectory(path)).map(child => ({
        path: join(entry.name, child.path),
        bytes: child.bytes,
      })))
    } else {
      snapshots.push({ path: entry.name, bytes: (await readFile(path)).toString('base64') })
    }
  }
  return snapshots.sort((left, right) => left.path.localeCompare(right.path))
}

async function readUtf8IfPresent(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? (error as { readonly code?: unknown }).code
      : undefined
    if (code === 'ENOENT') return ''
    throw error
  }
}

describe('TODO05 ordinary Feed recovery warning RED', () => {
  it('warns once for three same-binding structured failures while every attempt rejects', async () => {
    const harness = await createHarness(['structured', 'structured', 'structured'])
    const binding = { jobId: 'job-one', runId: 'run-one', sessionId: 'session-one' }
    const context = runContext(binding.jobId, binding.runId, binding.sessionId)
    const before = await snapshotDirectory(harness.fixture.directory)
    await rejectOnce(harness, context)
    await rejectOnce(harness, context)
    await rejectOnce(harness, context)

    expect(await snapshotDirectory(harness.fixture.directory)).toEqual(before)
    expect(await readUtf8IfPresent(harness.fixture.ordinaryBusinessFinalizationLedgerPath)).toBe('')
    expect(xWarnings(harness)).toEqual([expectedWarning('structured_agent', 'structured_agent_failed', binding)])
    expect(xWarnings(harness).every(warning => !warning.includes('not-ready'))).toBe(true)
    assertSafeWarning(xWarnings(harness)[0] ?? '')
  })

  it('warns for a real materials-not-accepted diagnostic without exposing its payload', async () => {
    const harness = await createHarness(['structured'], fixture => ({
      editor: Object.freeze({
        ...fixture.editor,
        listAcceptedInputs: () => [] as readonly unknown[],
      }) as OrdinaryFeedFixture['editor'],
    }))
    const binding = { jobId: 'job-materials', runId: 'run-materials', sessionId: 'session-materials' }
    const error = await rejectOnce(harness, runContext(binding.jobId, binding.runId, binding.sessionId))

    assertSafeDiagnostic(error, 'read_model_materials', 'materials_not_accepted')
    expect(xWarnings(harness)).toEqual([expectedWarning('read_model_materials', 'materials_not_accepted', binding)])
    assertSafeWarning(xWarnings(harness)[0] ?? '')
  })

  it('warns for a real adapter nonacceptance after the proposal is accepted', async () => {
    const harness = await createHarness(['valid'], fixture => ({
      finalizer: Object.freeze({
        ...fixture.finalizer,
        establishEditingInputClosure: () => ({
          status: 'rejected',
          input: `${MATERIAL_TOKEN} ${REASON_TOKEN} ${BODY_TOKEN}`,
        }),
      }) as OrdinaryFeedFixture['finalizer'],
    }))
    const binding = { jobId: 'job-adapter', runId: 'run-adapter', sessionId: 'session-adapter' }
    const error = await rejectOnce(harness, runContext(binding.jobId, binding.runId, binding.sessionId))

    assertSafeDiagnostic(error, 'adapter', 'adapter_not_accepted')
    expect(xWarnings(harness)).toEqual([expectedWarning('adapter', 'adapter_not_accepted', binding)])
    assertSafeWarning(xWarnings(harness)[0] ?? '')
  })

  it('does not emit an empty-session warning for a live context without sessionId', async () => {
    const harness = await createHarness(['structured'])
    const error = await rejectOnce(harness, runContextWithoutSessionId('job-no-session', 'run-no-session'))

    assertSafeDiagnostic(error, 'structured_agent', 'structured_agent_failed')
    expect(xWarnings(harness)).toHaveLength(0)
    expect(harness.warnings.some(warning => warning.includes('sessionId='))).toBe(false)
  })

  it('keeps stage and raw binding dimensions distinct without delimiter collisions', async () => {
    const harness = await createHarness(['structured', 'proposal', 'structured', 'structured', 'structured', 'structured', 'structured', 'structured'])
    const sameRun = { jobId: 'job-one', runId: 'run-one', sessionId: 'session-one' }
    const sameRunProposal = runContext(sameRun.jobId, sameRun.runId, sameRun.sessionId)
    await rejectOnce(harness, sameRunProposal)
    await rejectOnce(harness, sameRunProposal)

    const differentRun = { jobId: 'job-one', runId: 'run-two', sessionId: 'session-one' }
    await rejectOnce(harness, runContext(differentRun.jobId, differentRun.runId, differentRun.sessionId))
    const differentSession = { jobId: 'job-one', runId: 'run-one', sessionId: 'session-two' }
    await rejectOnce(harness, runContext(differentSession.jobId, differentSession.runId, differentSession.sessionId))
    const collisionLeft = { jobId: 'a:b', runId: 'c', sessionId: 'd' }
    const collisionRight = { jobId: 'a', runId: 'b:c', sessionId: 'd' }
    await rejectOnce(harness, runContext(collisionLeft.jobId, collisionLeft.runId, collisionLeft.sessionId))
    await rejectOnce(harness, runContext(collisionRight.jobId, collisionRight.runId, collisionRight.sessionId))
    const sanitizedLeft = { jobId: 'job-sanitize', runId: 'run\nx', sessionId: 'session-sanitize' }
    const sanitizedRight = { jobId: 'job-sanitize', runId: 'run?x', sessionId: 'session-sanitize' }
    await rejectOnce(harness, runContext(sanitizedLeft.jobId, sanitizedLeft.runId, sanitizedLeft.sessionId))
    await rejectOnce(harness, runContext(sanitizedRight.jobId, sanitizedRight.runId, sanitizedRight.sessionId))

    expect(xWarnings(harness)).toEqual([
      expectedWarning('structured_agent', 'structured_agent_failed', sameRun),
      expectedWarning('proposal_validation', 'proposal_not_accepted', sameRun),
      expectedWarning('structured_agent', 'structured_agent_failed', differentRun),
      expectedWarning('structured_agent', 'structured_agent_failed', differentSession),
      expectedWarning('structured_agent', 'structured_agent_failed', collisionLeft),
      expectedWarning('structured_agent', 'structured_agent_failed', collisionRight),
      expectedWarning('structured_agent', 'structured_agent_failed', sanitizedLeft),
      expectedWarning('structured_agent', 'structured_agent_failed', sanitizedRight),
    ])
    xWarnings(harness).forEach(assertSafeWarning)
  })

  it('uses a bounded FIFO warning key set so the oldest binding can be recorded again', async () => {
    const capacity = 64
    const harness = await createHarness(Array.from({ length: capacity + 2 }, () => 'structured'))
    for (let index = 0; index < capacity; index++) {
      const binding = { jobId: 'job-fifo', runId: `run-${index}`, sessionId: 'session-fifo' }
      await rejectOnce(harness, runContext(binding.jobId, binding.runId, binding.sessionId))
    }
    const oldest = { jobId: 'job-fifo', runId: 'run-0', sessionId: 'session-fifo' }
    await rejectOnce(harness, runContext(oldest.jobId, oldest.runId, oldest.sessionId))
    expect(xWarnings(harness)).toHaveLength(capacity)

    const newest = { jobId: 'job-fifo', runId: `run-${capacity}`, sessionId: 'session-fifo' }
    await rejectOnce(harness, runContext(newest.jobId, newest.runId, newest.sessionId))
    await rejectOnce(harness, runContext(oldest.jobId, oldest.runId, oldest.sessionId))

    expect(xWarnings(harness)).toHaveLength(capacity + 2)
    expect(xWarnings(harness)[capacity]).toBe(expectedWarning('structured_agent', 'structured_agent_failed', newest))
    expect(xWarnings(harness).at(-1)).toBe(expectedWarning('structured_agent', 'structured_agent_failed', oldest))
    xWarnings(harness).forEach(assertSafeWarning)
  })

  it('sanitizes control characters in binding fields while preserving normal IDs and exact fixed format', async () => {
    const harness = await createHarness(['structured'])
    const binding = {
      jobId: 'job-normal',
      runId: 'run\u0001with\u001fcontrols\n\r\t\0\x7f',
      sessionId: 'session-normal',
    }
    await rejectOnce(harness, runContext(binding.jobId, binding.runId, binding.sessionId))

    const warning = xWarnings(harness)[0]
    expect(warning).toBe(expectedWarning('structured_agent', 'structured_agent_failed', binding))
    expect(warning).toContain('jobId=job-normal')
    expect(warning).toContain('sessionId=session-normal')
    expect(warning).not.toMatch(/[\u0000-\u001f\u007f]/)
    assertSafeWarning(warning ?? '')
  })
})
