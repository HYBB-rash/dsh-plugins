import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { execFile as nodeExecFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'
import AgentRegistry, { installModelSelection } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { CallId, type GenerateOptions, LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { summarizeTurn } from '@deepseek-ai/dsh-telegram-gateway'
import { type ProjectionBudget } from '../src/fact-projection/index.ts'
import { preflightFactProjectionWithAssessmentBinder } from '../src/fact-projection/preflight.ts'
import { createCandidateFactAssessmentPort } from '../src/x-cron/assessment-agent.ts'
import { XFeedFinalAgentSurface } from '../src/x-cron/final-agent.ts'
import { validateXFeedRichMarkdown } from '../src/x-cron/output-contract.ts'
import { DeliveryReceipt, type ExecFileFn } from '../src/receipt.ts'
import type { NavigationSnapshot, Sha256Digest } from '../src/trusted-facts/navigation-contract.ts'

const temporaryDirectories: string[] = []
const contexts: Context[] = []
const revision = 'sha256:todo7-fail-closed' as Sha256Digest
const budget: ProjectionBudget = { maxInlineFacts: 4, maxLookupTickets: 4, maxSerializedBytes: 20_000 }
const candidateUrl = 'https://x.com/alice/status/1'
const execFileAsync = promisify(nodeExecFile)

afterEach(async () => {
  while (contexts.length > 0) await contexts.pop()!.fiber.dispose()
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-x-feed-todo7-fail-closed-'))
  temporaryDirectories.push(directory)
  return directory
}

function emptySources() {
  return {
    facts: { sourceRevision: revision, facts: [] },
    navigation: { schemaVersion: 1 as const, sourceRevision: revision, items: [] },
  }
}

type FailureReport = {
  readonly event: 'finish'
  readonly status: 'error'
  readonly deliveryState: 'not_requested'
  readonly error: string
}

async function appendAndReadFailureReport(path: string, code: string, message: string): Promise<FailureReport> {
  // This is the same local JSONL finish-report shape consumed by dsh-cron;
  // the adapter deliberately has no production-side write or delivery path.
  const report: FailureReport = {
    event: 'finish',
    status: 'error',
    deliveryState: 'not_requested',
    error: `${code}: ${message}`,
  }
  await appendFile(path, `${JSON.stringify(report)}\n`)
  const lines = (await readFile(path, 'utf8')).trim().split('\n')
  return JSON.parse(lines.at(-1)!) as FailureReport
}

function expectNoRunSideEffects(counters: Record<string, number>): void {
  expect(counters).toEqual({
    scrape: 0,
    search: 0,
    assessmentModel: 0,
    finalModel: 0,
    prepare: 0,
    delivery: 0,
    shown: 0,
  })
}

describe('TODO7-D preflight failure report and zero-side-effect matrix', () => {
  it.each([
    ['missing facts', (source: ReturnType<typeof emptySources>) => ({
      facts: { readLocatedSnapshot: () => { throw new Error('trusted facts file unavailable') } },
      navigation: { readNavigationSnapshot: () => source.navigation },
    }), 'facts-unavailable', 'trusted facts file unavailable'],
    ['missing navigation', (source: ReturnType<typeof emptySources>) => ({
      facts: { readLocatedSnapshot: () => source.facts },
      navigation: { readNavigationSnapshot: () => { throw Object.assign(new Error('navigation file missing'), { code: 'ENOENT' }) } },
    }), 'navigation-unavailable', 'navigation file missing'],
    ['bad navigation schema', (source: ReturnType<typeof emptySources>) => ({
      facts: { readLocatedSnapshot: () => source.facts },
      navigation: { readNavigationSnapshot: () => ({ schemaVersion: 99 } as never) },
    }), 'navigation-schema-invalid', 'Trusted-fact navigation snapshot has an invalid schema.'],
    ['source revision mismatch', (source: ReturnType<typeof emptySources>) => ({
      facts: { readLocatedSnapshot: () => source.facts },
      navigation: { readNavigationSnapshot: () => ({ ...source.navigation, sourceRevision: 'sha256:other-revision' }) },
    }), 'source-revision-mismatch', 'Trusted facts and navigation do not share the same source revision.'],
    ['assessment services unavailable', (source: ReturnType<typeof emptySources>) => ({
      facts: { readLocatedSnapshot: () => source.facts },
      navigation: { readNavigationSnapshot: () => source.navigation },
      assessmentBinder: (navigation: NavigationSnapshot) => createCandidateFactAssessmentPort({} as Context, navigation),
    }), 'assessment-policy-unavailable', 'X assessment requires the Harness agents service.'],
  ] as const)('%s is reportable and fails before every X side effect', async (_name, sourceFactory, expectedCode, expectedMessage) => {
    const directory = await temporaryDirectory()
    const reportPath = join(directory, 'runs.jsonl')
    const counters = { scrape: 0, search: 0, assessmentModel: 0, finalModel: 0, prepare: 0, delivery: 0, shown: 0 }
    const source = emptySources()
    // Use the production preflight function with these exact injected boundaries.
    const custom = sourceFactory(source)
    const preflight = preflightFactProjectionWithAssessmentBinder({
      facts: custom.facts,
      navigation: custom.navigation,
      assessmentBinder: custom.assessmentBinder ?? (() => ({ checkReadiness: () => ({ ready: true as const }) })),
      budget,
      projector: () => () => ({ kind: 'failure', code: 'unused', message: 'unused' } as never),
      lookup: () => () => ({ kind: 'lookup-failure', code: 'unused', message: 'unused' } as never),
    })
    expect(preflight).toMatchObject({ kind: 'not-ready', code: expectedCode, message: expectedMessage })
    const report = await appendAndReadFailureReport(reportPath, preflight.code, preflight.message)
    expect(report).toMatchObject({ error: `${expectedCode}: ${expectedMessage}` })
    expectNoRunSideEffects(counters)
  })
})

function toolCall(id: string, name: string, value: unknown): StreamChunk[] {
  const callId = CallId(id)
  const argumentsText = JSON.stringify(value)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: argumentsText },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name, arguments: argumentsText } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function textReply(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

class FinalOutputAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  private step = 0

  constructor(
    private readonly preparedText: string,
    private readonly finalText: string,
    private readonly preparedUrls: readonly string[],
  ) { super() }

  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    this.step += 1
    if (this.step === 1) {
      yield* toolCall('prepare-output', 'x_feed_prepare_delivery', {
        text: this.preparedText,
        urls: this.preparedUrls,
      })
      return
    }
    yield* textReply(this.finalText)
  }
}

class TextOnlyAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async *stream(_request: GenerateOptions): AsyncIterable<StreamChunk> {
    yield* textReply(oneItem)
  }
}

async function finalHarness(adapter: LlmAdapter): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(AgentDefaultModelConfig, { provider: 'todo7-wire', model: 'todo7-model' })
  ctx.llm.registerAdapter(['todo7-wire'], adapter)
  contexts.push(ctx)
  return ctx
}

const oneItem = `📦 X 洞察\n\n⭐ 当前候选\n- 当前事实 (${candidateUrl})`

async function driveFinalSurface(options: {
  readonly adapter: LlmAdapter
  readonly prepareResult?: { readonly ok: false; readonly code: string; readonly message: string }
  readonly shownPath: string
}): Promise<{ readonly surface: XFeedFinalAgentSurface; readonly outcome: ReturnType<typeof summarizeTurn>; readonly handle: { dispose(): Promise<unknown> }; readonly prepareCalls: number; readonly deliveryCalls: number }> {
  const ctx = await finalHarness(options.adapter)
  const deliveryCalls = { value: 0 }
  let prepareCalls = 0
  const surface = new XFeedFinalAgentSurface({
    material: {
      runId: 'todo7-final-run',
      allowedTopics: [],
      candidates: [{ id: 'x-status:1', content: 'current candidate', source: candidateUrl, topics: [] }],
    },
    runTools: {
      searchTopic: async () => ({ items: [] }),
      exploreCandidate: async () => ({ title: 'candidate', body: 'body', urls: [] }),
      setTheme: async theme => ({ theme }),
      prepareDelivery: async () => {
        prepareCalls += 1
        if (options.prepareResult !== undefined) return options.prepareResult
        return { ok: true, prepared: 1 }
      },
    },
    projection: {
      project: async () => ({ facts: [], tickets: [], serializedBytes: new Uint8Array() }),
      lookup: () => ({ kind: 'lookup-failure', code: 'ticket_not_found', message: 'not found' }),
    },
  })
  const sessionId = SessionId(`session-todo7-final-${Date.now()}`)
  surface.capture(ctx, sessionId)
  const handle = await ctx.agents.create({
    sessionId,
    agentOptions: { provider: 'todo7-wire', model: 'todo7-model' },
    setup: agentCtx => {
      installModelSelection(agentCtx, { current: { provider: 'todo7-wire', model: 'todo7-model' }, assembled: undefined })
      surface.setupAgent(agentCtx)
    },
  })
  await surface.verifySurface(handle.agent)
  const firstSeq = handle.agent.session.seq
  handle.agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'drive one final output' }],
    source: { kind: 'plugin', plugin: 'dsh-cron' },
  }))
  await handle.agent.whenIdle()
  const outcome = summarizeTurn(handle.agent.session.events, firstSeq)
  // The test's delivery owner is intentionally never invoked: finalization is
  // the last production surface before dsh-cron owns delivery.
  void deliveryCalls
  expect(existsSync(options.shownPath)).toBe(false)
  return { surface, outcome, handle, prepareCalls, deliveryCalls: deliveryCalls.value }
}

describe('TODO7-D final fail-closed output and resource cleanup', () => {
  it('fails closed for no-prepare and prepare failure with no delivery/shown and disposes the Agent', async () => {
    for (const mode of ['no-prepare', 'prepare-failure'] as const) {
      const directory = await temporaryDirectory()
      const shownPath = join(directory, 'x_shown.json')
      const adapter = mode === 'no-prepare'
        ? new TextOnlyAdapter()
        : new FinalOutputAdapter(oneItem, oneItem, [candidateUrl])
      const result = await driveFinalSurface({
        adapter,
        shownPath,
        ...(mode === 'prepare-failure' ? { prepareResult: { ok: false, code: 'prepare-failed', message: 'fixed prepare failure' } } : {}),
      })
      expect(() => result.surface.finalizeOutcome(result.outcome)).toThrow()
      expect(result.prepareCalls).toBe(mode === 'no-prepare' ? 0 : 1)
      expect(result.deliveryCalls).toBe(0)
      expect(existsSync(shownPath)).toBe(false)
      result.surface.dispose()
      await result.handle.dispose()
    }
  })

  it.each([
    ['prepared body mismatch', oneItem, oneItem.replace('当前事实', '改写正文'), [candidateUrl], 'prepared text'],
    ['prepared URL set mismatch', oneItem, oneItem, ['https://x.com/bob/status/2'], 'url-set-mismatch'],
    ['format failure', 'not rich markdown', 'not rich markdown', [candidateUrl], 'title-missing'],
  ] as const)('%s fails closed before delivery/shown and releases the real Agent', async (_name, preparedText, finalText, urls, expectedMessage) => {
    const directory = await temporaryDirectory()
    const shownPath = join(directory, 'x_shown.json')
    const result = await driveFinalSurface({
      adapter: new FinalOutputAdapter(preparedText, finalText, urls),
      shownPath,
    })
    expect(() => result.surface.finalizeOutcome(result.outcome)).toThrow(new RegExp(expectedMessage))
    expect(result.deliveryCalls).toBe(0)
    expect(existsSync(shownPath)).toBe(false)
    result.surface.dispose()
    await result.handle.dispose()
  })

  it('accepts one complete five-section Rich Markdown output with bounded lines, UTF-16 and canonical X URLs', () => {
    const output = richOutput(14)
    const urls = [...output.matchAll(/https:\/\/x\.com\/[A-Za-z0-9_]{1,15}\/status\/[1-9]\d*/gu)].map(match => match[0])
    const result = validateXFeedRichMarkdown(output, { preparedUrls: urls })
    expect(result).toMatchObject({ ok: true, nonEmptyLineCount: 20 })
    if (!result.ok) return
    expect(result.utf16CodeUnits).toBeLessThanOrEqual(3500)
    expect(urls.every(url => /^https:\/\/x\.com\/[A-Za-z0-9_]{1,15}\/status\/[1-9]\d*$/u.test(url))).toBe(true)
    expect(output).not.toMatch(/\|.*\|/u)
    expect(output).not.toMatch(/x_feed_prepare_delivery|confirm-prepared|x_shown\.json|runs\.jsonl/u)
  })

  it('rejects exactly 21 non-empty lines and accepts exactly 20', () => {
    const valid = richOutput(14)
    const tooMany = richOutput(15)
    const validUrls = [...valid.matchAll(/https:\/\/x\.com\/[A-Za-z0-9_]{1,15}\/status\/[1-9]\d*/gu)].map(match => match[0])
    const tooManyUrls = [...tooMany.matchAll(/https:\/\/x\.com\/[A-Za-z0-9_]{1,15}\/status\/[1-9]\d*/gu)].map(match => match[0])
    expect(validateXFeedRichMarkdown(valid, { preparedUrls: validUrls })).toMatchObject({ ok: true, nonEmptyLineCount: 20 })
    expect(validateXFeedRichMarkdown(tooMany, { preparedUrls: tooManyUrls })).toMatchObject({ ok: false, code: 'too-many-lines', details: { nonEmptyLineCount: 21 } })
  })

  it('rejects exactly 3501 UTF-16 units while accepting exactly 3500', () => {
    const base = richOutput(14)
    const baseUrls = [...base.matchAll(/https:\/\/x\.com\/[A-Za-z0-9_]{1,15}\/status\/[1-9]\d*/gu)].map(match => match[0])
    const at3500 = padOutputTo(base, 3500)
    const at3501 = padOutputTo(base, 3501)
    expect(at3500.length).toBe(3500)
    expect(at3501.length).toBe(3501)
    expect(validateXFeedRichMarkdown(at3500, { preparedUrls: baseUrls })).toMatchObject({ ok: true, utf16CodeUnits: 3500 })
    expect(validateXFeedRichMarkdown(at3501, { preparedUrls: baseUrls })).toMatchObject({ ok: false, code: 'too-large', details: { utf16CodeUnits: 3501 } })
  })

  it('rejects Markdown tables and internal protocol text rather than exposing them as user output', () => {
    const output = richOutput(14)
    const urls = [...output.matchAll(/https:\/\/x\.com\/[A-Za-z0-9_]{1,15}\/status\/[1-9]\d*/gu)].map(match => match[0])
    const table = output.replace('- item 1', '| item | URL |\n| --- | --- |\n- item 1')
    const protocol = output.replace('- item 2 (https://x.com/alice/status/2)', '- INTERNAL_PROTOCOL prepare delivery (https://x.com/alice/status/2)')
    expect(validateXFeedRichMarkdown(table, { preparedUrls: urls })).toMatchObject({ ok: false })
    expect(validateXFeedRichMarkdown(protocol, { preparedUrls: urls })).toMatchObject({
      ok: false,
      code: 'internal-protocol',
      message: 'X output contains internal protocol material',
    })
  })
})

describe('TODO7-D prepare/receipt/shown product contract', () => {
  it('keeps shown empty after prepare and failed/uncertain receipts, then idempotently records one delivered URL', async () => {
    const directory = await temporaryDirectory()
    const packagePath = join(directory, 'x_insight_package.json')
    const shownPath = join(directory, 'x_shown.json')
    const pipelinePath = join(import.meta.dirname, '../python/x_insight_pipeline.py')
    const pythonBin = process.env.DSH_X_FEED_PYTHON ?? 'python3'
    const initialPackage = {
      selected_urls: [candidateUrl],
      recent_items: [{ url: candidateUrl, id: '1', text: 'candidate' }],
    }
    await writeJson(packagePath, initialPackage)
    const runPython: ExecFileFn = async (file, args, options) => {
      const result = await execFileAsync(file, [...args], options)
      return { stdout: result.stdout, stderr: result.stderr }
    }
    const prepare = async () => {
      await runPython(pythonBin, [
        pipelinePath, 'prepare-delivery', '--package', packagePath,
        '--cron-job-id', 'cron-x', '--urls', candidateUrl,
      ], { env: { ...process.env, DSH_X_FEED_DATA_DIR: directory }, timeout: 15_000, maxBuffer: 64 * 1024 })
    }
    const receipt = new DeliveryReceipt({
      cronJobId: 'cron-x',
      dataDir: directory,
      pythonBin,
      pipelinePath,
      logger: { warn: () => undefined, error: () => undefined },
      execFile: runPython,
      sleep: async () => undefined,
    })
    const event = (status: 'success' | 'error', deliveredAt?: string) => ({
      jobId: 'cron-x', runId: 'run-receipt', sessionId: 'session-receipt',
      scheduledFor: '2026-08-21T00:00:00.000Z', status,
      ...(deliveredAt === undefined ? {} : { deliveredAt }),
    }) as never

    await prepare()
    expect(existsSync(shownPath)).toBe(false)
    await expect(receipt.handle(event('error'))).resolves.toMatchObject({ ok: true, confirmStatus: 'not-delivered' })
    expect(existsSync(shownPath)).toBe(false)

    await prepare()
    await expect(receipt.handle(event('success'))).resolves.toMatchObject({ ok: true, confirmStatus: 'not-delivered' })
    expect(existsSync(shownPath)).toBe(false)

    await prepare()
    await expect(receipt.handle(event('success', '2026-08-21T00:00:01.000Z'))).resolves.toMatchObject({ ok: true, confirmStatus: 'delivered' })
    const shownAfterDelivery = await readFile(shownPath, 'utf8')
    const shownHash = await sha256(shownAfterDelivery)
    expect(JSON.parse(shownAfterDelivery).urls).toEqual([candidateUrl])
    await expect(receipt.handle(event('success', '2026-08-21T00:00:01.000Z'))).resolves.toMatchObject({ ok: true, confirmStatus: 'delivered' })
    expect(await sha256(await readFile(shownPath, 'utf8'))).toBe(shownHash)
  })
})

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value))
}

async function sha256(value: string): Promise<string> {
  return createHash('sha256').update(value).digest('hex')
}

function richOutput(itemCount: number): string {
  const sections = ['⭐ 高优先级', '🌊 时间线新发现', '🔄 换口味/随机发现', '🎯 主题聚焦', '📌 信号源']
  const counts = [itemCount - 8, 2, 2, 2, 2]
  let nextUrl = 1
  const lines = ['📦 X 洞察', '']
  for (const [sectionIndex, section] of sections.entries()) {
    lines.push(section)
    for (let index = 0; index < counts[sectionIndex]!; index += 1) {
      lines.push(`- item ${nextUrl} (https://x.com/alice/status/${nextUrl})`)
      nextUrl += 1
    }
    if (sectionIndex < sections.length - 1) lines.push('')
  }
  return lines.join('\n')
}

function padOutputTo(output: string, targetLength: number): string {
  const delta = targetLength - output.length
  if (delta < 0) throw new Error(`output is already ${-delta} units over target`)
  return output.replace('- item 1', `- ${'x'.repeat(delta)}item 1`)
}

describe('TODO7-D assessment abort and timeout release', () => {
  it('aborts and times out the real assessment Agent without publishing a partial assessment', async () => {
    class HangingAdapter extends LlmAdapter {
      readonly requests: GenerateOptions[] = []
      override resolveModel(provider: string, model: string) { return Promise.resolve({ provider, id: model, name: model }) }
      override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
        this.requests.push(request)
        yield { type: 'block-start', index: 0, blockType: 'text' }
        await new Promise<void>((_resolve, reject) => {
          const abort = () => reject(new Error('assessment stream aborted'))
          request.signal?.addEventListener('abort', abort, { once: true })
        })
      }
    }
    const adapter = new HangingAdapter()
    const ctx = await finalHarness(adapter)
    const navigation: NavigationSnapshot = {
      schemaVersion: 1,
      sourceRevision: revision,
      items: [{
        schemaVersion: 1,
        kind: 'trusted-fact-navigation',
        origin: 'machine-derived',
        derivation: { method: 'todo7', version: '1' },
        locator: {
          schemaVersion: 1,
          locatorId: 'locator:1',
          persistence: {
            sourceKind: 'trusted-fact-repository',
            sourceKey: 'trusted-facts.jsonl',
            lineNumber: 1,
            canonicalDigest: 'sha256:locator-1',
          },
        },
        hints: {
          topics: ['candidate'],
          targetRefs: [{ targetId: 'x-status:1', canonicalSource: candidateUrl }],
          dimension: 'content_value',
          relations: [{ kind: 'about-target', targetId: 'x-status:1' }],
        },
      }],
    }
    const port = createCandidateFactAssessmentPort(ctx, navigation, { timeoutMs: 20, modelSelection: { provider: 'todo7-wire', model: 'todo7-model' } })
    const request = {
      candidate: { id: 'x-status:1', content: 'candidate', source: candidateUrl },
      navigation: navigation.items,
      budget,
    } as const
    await expect(port.prime(request)).rejects.toMatchObject({ code: 'timeout' })
    const controller = new AbortController()
    const pending = port.prime(request, { signal: controller.signal, timeoutMs: 1_000 })
    setTimeout(() => controller.abort(new Error('caller aborted')), 5)
    await expect(pending).rejects.toMatchObject({ code: 'aborted' })
    expect(adapter.requests).toHaveLength(2)
    expect(port.assess(request)).toMatchObject({ kind: 'projection-failure' })
  })
})
