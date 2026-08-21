import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DeliveryReceipt } from '../src/receipt.ts'
import { createTrustedFactNavigation } from '../src/index.ts'
import { createTrustedFact, type TrustedFact } from '../src/trusted-facts/model.ts'
import { FileTrustedFactSource } from '../src/trusted-facts/source-adapter.ts'
import { InMemoryPendingStore } from '../src/x-feedback/pending-store.ts'
import { FeedbackEffectAdapter } from '../src/x-feedback/feedback-effect-adapter.ts'
import { FeedbackUseCase } from '../src/x-feedback/use-case.ts'
import { FileTrustedFactRepository } from '../src/x-feedback/trusted-fact-repository.ts'
import { XFeedbackStore } from '../src/store.ts'
import { registerXFeedTools } from '../src/tools.ts'

const packageDirectory = resolve(import.meta.dirname, '..')
const pythonDirectory = resolve(packageDirectory, 'python')
const pipelinePath = join(pythonDirectory, 'x_insight_pipeline.py')

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

type FileSnapshot = {
  readonly bytes: Buffer
  readonly sha256: string
}

type MixedFixture = {
  readonly directory: string
  readonly packagePath: string
  readonly shownPath: string
  readonly graphPath: string
  readonly aliasesPath: string
  readonly statePath: string
  readonly trustedPath: string
  readonly auditPaths: readonly string[]
  readonly legacyMarkers: readonly string[]
  readonly trustedFact: TrustedFact
}

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function snapshotFiles(paths: readonly string[]): Map<string, FileSnapshot> {
  return new Map(paths.map(path => {
    const bytes = readFileSync(path)
    return [path, { bytes, sha256: sha256(bytes) }] as const
  }))
}

function expectFilesUnchanged(before: Map<string, FileSnapshot>): void {
  for (const [path, snapshot] of before) {
    const after = readFileSync(path)
    expect(after.equals(snapshot.bytes), `${path} bytes changed`).toBe(true)
    expect(sha256(after), `${path} sha256 changed`).toBe(snapshot.sha256)
  }
}

function createFact(): TrustedFact {
  const result = createTrustedFact({
    target: {
      id: 'x:trusted-target',
      content: '可信目标，不应自动注入 marker',
      source: 'https://x.com/trusted/status/1',
      scope: 'this post',
    },
    dimension: 'content_value',
    reason: '可信事实 marker 只允许精确受控查询。',
    evidence: {
      kind: 'user_direct',
      rawUserExpression: '我明确说出这个可信事实 marker。',
    },
  })
  if (!result.ok) throw new Error(result.message)
  return result.fact
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function writeTimeline(path: string): void {
  const items = [
    { id: 'ai-1', url: 'https://x.com/current/1', text: 'Agent 当前主题一', source: 'x', ts: 1 },
    { id: 'ai-2', url: 'https://x.com/current/2', text: 'OpenAI 当前主题二', source: 'x', ts: 2 },
    { id: 'ai-3', url: 'https://x.com/current/3', text: 'LLM 当前主题三', source: 'x', ts: 3 },
    { id: 'ai-4', url: 'https://x.com/current/4', text: 'Codex 当前主题四', source: 'x', ts: 4 },
    { id: 'linux-1', url: 'https://x.com/current/5', text: 'Linux 机械候选', source: 'x', ts: 5 },
  ]
  writeFileSync(path, `${items.map(item => JSON.stringify(item)).join('\n')}\n`)
}

function createMixedFixture(): MixedFixture {
  const directory = temporaryDirectory('dsh-x-feed-todo3-mixed-')
  const legacyMarkers = [
    'legacy-preference-marker',
    'legacy-rating-marker',
    'legacy-anchor-marker',
    'legacy-restricted-marker',
    'legacy-bridge-marker',
  ] as const

  const legacyPreferencePath = join(directory, 'legacy-x-preferences.md')
  const feedbackPath = join(directory, 'feedback.jsonl')
  const graphPath = join(directory, 'x_interest_graph.json')
  const trustedPath = join(directory, 'trusted-facts.jsonl')
  writeFileSync(legacyPreferencePath, `旧偏好 ${legacyMarkers[0]}\n`)
  writeFileSync(feedbackPath, `${JSON.stringify({
    schemaVersion: 1,
    id: 'legacy-rating-1',
    createdAt: '2026-08-20T00:00:00.000Z',
    operation: 'dislike',
    topic: legacyMarkers[1],
    note: legacyMarkers[1],
  })}\n`)
  writeJson(graphPath, {
    anchors: [legacyMarkers[2]],
    restricted: [legacyMarkers[3]],
    edges: [
      { from: 'safe-theme', to: 'safe-one', hop: 99, bridge: legacyMarkers[4] },
      { from: 'safe-one', to: 'safe-two', hop: 99, bridge: legacyMarkers[4] },
      { from: 'safe-theme', to: 'safe-cooldown', hop: 1, bridge: legacyMarkers[4] },
      { from: 'safe-theme', to: 'safe-recent', hop: 1, bridge: legacyMarkers[4] },
      { from: 'safe-theme', to: 'safe-familiar', hop: 1, bridge: legacyMarkers[4] },
    ],
  })

  const trustedFact = createFact()
  const repository = new FileTrustedFactRepository(directory)
  const appended = repository.append(trustedFact)
  if (!appended.ok) throw new Error(appended.message)

  writeTimeline(join(directory, 'x_timeline.jsonl'))
  writeJson(join(directory, 'x_last_theme.json'), { theme: 'linux' })
  writeJson(join(directory, 'x_topic_aliases.json'), { ai: 'safe-theme' })
  const now = Math.floor(Date.now() / 1000)
  writeJson(join(directory, 'x_wander_state.json'), {
    cooldown_s: 3600,
    topics: {
      'safe-cooldown': { times: 1, last_explored_ts: now },
      'safe-recent': { times: 2, last_explored_ts: now - 10 },
      'safe-familiar': { times: 4, last_explored_ts: now - 7200 },
    },
  })

  return {
    directory,
    packagePath: join(directory, 'x_insight_package.json'),
    shownPath: join(directory, 'x_shown.json'),
    graphPath,
    aliasesPath: join(directory, 'x_topic_aliases.json'),
    statePath: join(directory, 'x_wander_state.json'),
    trustedPath,
    auditPaths: [legacyPreferencePath, feedbackPath, graphPath, trustedPath],
    legacyMarkers,
    trustedFact,
  }
}

function pythonEnvironment(directory: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DSH_X_FEED_DATA_DIR: directory,
    PYTHONDONTWRITEBYTECODE: '1',
  }
}

function runPython(directory: string, args: readonly string[]): string {
  return execFileSync('python3', [pipelinePath, ...args], {
    cwd: pythonDirectory,
    env: pythonEnvironment(directory),
    encoding: 'utf8',
  })
}

function runPipeline(fixture: MixedFixture): { readonly stdout: string; readonly package: Record<string, any> } {
  const stdout = runPython(fixture.directory, ['--no-collect', '--out', fixture.packagePath])
  return {
    stdout,
    package: JSON.parse(readFileSync(fixture.packagePath, 'utf8')) as Record<string, any>,
  }
}

describe('TODO3 mixed legacy isolation integration', () => {
  it('隔离旧评价、精确可信事实与安全 topology，同时保留当前批次漫游指标', () => {
    const fixture = createMixedFixture()
    const before = snapshotFiles(fixture.auditPaths)

    const repository = new FileTrustedFactRepository(fixture.directory)
    const source = new FileTrustedFactSource(repository)
    expect(repository.readAll()).toEqual([fixture.trustedFact])
    expect(source.query({ targetIds: [fixture.trustedFact.target.id] })).toEqual([fixture.trustedFact])
    expect(source.query({ canonicalSources: [fixture.trustedFact.target.source] })[0]).toMatchObject({
      target: fixture.trustedFact.target,
      reason: fixture.trustedFact.reason,
      evidence: fixture.trustedFact.evidence,
    })
    expect(source.query({ targetIds: ['x:missing'] })).toEqual([])
    expect(source.query({ canonicalSources: ['https://x.com/trusted/status/10'] })).toEqual([])
    expect(source.query({ canonicalSources: ['trusted'] })).toEqual([])

    const { stdout, package: insightPackage } = runPipeline(fixture)
    const rendered = `${stdout}\n${JSON.stringify(insightPackage)}`
    for (const marker of [...fixture.legacyMarkers, '可信事实 marker', 'feedback_context']) {
      expect(rendered, `automatic material leaked ${marker}`).not.toContain(marker)
    }

    expect(insightPackage.decision.top_theme).toBe('ai')
    expect(insightPackage.decision.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: 'https://x.com/current/5', theme: 'linux' }),
    ]))
    const exploreCandidates = insightPackage.explore_candidates as Array<Record<string, any>>
    expect(exploreCandidates.map(candidate => candidate.topic)).toEqual([
      'safe-one', 'safe-familiar', 'safe-two',
    ])
    expect(exploreCandidates.find(candidate => candidate.topic === 'safe-one')).toMatchObject({
      hop: 1,
      bridge: 'safe-theme → safe-one',
      explored_count: 0,
      familiarity: 0,
    })
    expect(exploreCandidates.find(candidate => candidate.topic === 'safe-two')).toMatchObject({
      hop: 2,
      bridge: 'safe-one → safe-two',
    })
    expect(exploreCandidates.find(candidate => candidate.topic === 'safe-familiar')).toMatchObject({
      explored_count: 4,
      familiarity: 0.8,
    })
    expect((insightPackage.wander.blocked as Array<Record<string, any>>)).toEqual(expect.arrayContaining([
      expect.objectContaining({ topic: 'safe-cooldown', reason: 'cooldown' }),
      expect.objectContaining({ topic: 'safe-recent', reason: 'cooldown' }),
    ]))
    expect(insightPackage.wander.recent_explorations).toEqual(expect.arrayContaining([
      expect.objectContaining({ topic: 'safe-recent', times: 2 }),
    ]))
    expect(readFileSync(fixture.graphPath, 'utf8')).toContain(fixture.legacyMarkers[4])
    expectFilesUnchanged(before)
  })

  it('prepare 后不写 shown，只有真实 DeliveryReceipt delivered 才 confirm；失败不写 shown', async () => {
    const fixture = createMixedFixture()
    const before = snapshotFiles(fixture.auditPaths)
    runPipeline(fixture)

    const selectedUrl = 'https://x.com/current/1'
    expect(runPython(fixture.directory, [
      'prepare-delivery', '--package', fixture.packagePath,
      '--cron-job-id', 'cron-x-todo3', '--urls', selectedUrl,
    ])).toContain('"ok": true')
    expect(existsSync(fixture.shownPath)).toBe(false)
    expect(JSON.parse(readFileSync(fixture.packagePath, 'utf8'))).toMatchObject({
      delivery_status: 'prepared',
      pending_urls: [selectedUrl],
    })

    const receipt = new DeliveryReceipt({
      cronJobId: 'cron-x-todo3',
      dataDir: fixture.directory,
      pythonBin: 'python3',
      pipelinePath,
      logger: { warn: () => undefined, error: () => undefined },
      sleep: async () => undefined,
    })
    await expect(receipt.handle({
      jobId: 'other-job',
      runId: 'other-run',
      sessionId: 'session-cron-other-job',
      scheduledFor: '2026-08-20T00:00:00.000Z',
      status: 'success',
      deliveredAt: '2026-08-20T00:00:01.000Z',
    })).resolves.toEqual({ ok: true, skipped: true })
    expect(existsSync(fixture.shownPath)).toBe(false)

    await expect(receipt.handle({
      jobId: 'cron-x-todo3',
      runId: 'cron-x-todo3@1',
      sessionId: 'session-cron-cron-x-todo3',
      scheduledFor: '2026-08-20T00:00:00.000Z',
      status: 'success',
      deliveredAt: '2026-08-20T00:00:01.000Z',
    })).resolves.toMatchObject({ ok: true, confirmStatus: 'delivered' })
    expect(JSON.parse(readFileSync(fixture.shownPath, 'utf8')).urls).toEqual([selectedUrl])
    expect(JSON.parse(readFileSync(fixture.packagePath, 'utf8'))).toMatchObject({
      delivery_status: 'delivered',
      delivered_urls: [selectedUrl],
    })
    expect(JSON.parse(readFileSync(fixture.packagePath, 'utf8'))).not.toHaveProperty('pending_urls')

    const failedDirectory = temporaryDirectory('dsh-x-feed-todo3-failed-receipt-')
    const failedPackage = join(failedDirectory, 'x_insight_package.json')
    writeJson(failedPackage, {
      delivery_id: 'failed-delivery',
      selected_urls: [selectedUrl],
      delivery_status: 'pending',
    })
    const failedShown = join(failedDirectory, 'x_shown.json')
    runPython(failedDirectory, [
      'prepare-delivery', '--package', failedPackage,
      '--cron-job-id', 'cron-failed', '--urls', selectedUrl,
    ])
    const failedReceipt = new DeliveryReceipt({
      cronJobId: 'cron-failed',
      dataDir: failedDirectory,
      pythonBin: 'python3',
      pipelinePath,
      logger: { warn: () => undefined, error: () => undefined },
      sleep: async () => undefined,
    })
    await expect(failedReceipt.handle({
      jobId: 'cron-failed',
      runId: 'cron-failed@1',
      sessionId: 'session-cron-cron-failed',
      scheduledFor: '2026-08-20T00:00:00.000Z',
      status: 'success',
    })).resolves.toMatchObject({ ok: true, confirmStatus: 'not-delivered' })
    expect(existsSync(failedShown)).toBe(false)
    expect(JSON.parse(readFileSync(failedPackage, 'utf8'))).toMatchObject({ delivery_status: 'failed' })
    expectFilesUnchanged(before)
  })

  it('旧 rating 只能读审计且零写，save/unsave 正常；clean rating 只写 TrustedFact', async () => {
    const fixture = createMixedFixture()
    const before = snapshotFiles(fixture.auditPaths)
    const auditStore = new XFeedbackStore(fixture.directory)
    expect(auditStore.readAll()[0]).toMatchObject({
      operation: 'dislike',
      note: fixture.legacyMarkers[1],
    })
    const originalFeedback = readFileSync(join(fixture.directory, 'feedback.jsonl'))
    expect(auditStore.append({ operation: 'dislike', url: 'https://x.com/new/1' } as never)).toMatchObject({
      ok: false,
      code: 'rating_requires_clean_feedback',
    })
    expect(readFileSync(join(fixture.directory, 'feedback.jsonl')).equals(originalFeedback)).toBe(true)

    const writerDirectory = temporaryDirectory('dsh-x-feed-todo3-writer-')
    const writerStore = new XFeedbackStore(writerDirectory)
    const definitions: Array<{ readonly name: string; readonly execute?: (args: Record<string, unknown>) => Promise<unknown> }> = []
    registerXFeedTools({
      tools: {
        register: (definition: unknown) => {
          definitions.push(definition as typeof definitions[number])
          return () => undefined
        },
      },
    }, { store: writerStore, logger: { warn: () => undefined } })
    const feedbackTool = definitions.find(definition => definition.name === 'x_feed_record_feedback')
    if (feedbackTool?.execute === undefined) throw new Error('x_feed_record_feedback tool missing')
    await expect(feedbackTool.execute({ operation: 'dislike', url: 'https://x.com/new/2' })).resolves.toMatchObject({
      ok: false,
      code: 'rating_requires_clean_feedback',
    })
    await expect(feedbackTool.execute({
      operation: 'save',
      url: 'https://twitter.com/u/status/77?utm_source=todo3',
      title: '收藏内容',
      note: '收藏理由',
    })).resolves.toMatchObject({ ok: true, event: { operation: 'save', canonicalUrl: 'https://x.com/u/status/77' } })
    await expect(feedbackTool.execute({ operation: 'unsave', url: 'https://x.com/u/status/77' })).resolves.toMatchObject({
      ok: true,
      event: { operation: 'unsave' },
    })

    const cleanDirectory = temporaryDirectory('dsh-x-feed-todo3-clean-rating-')
    const cleanRepository = new FileTrustedFactRepository(cleanDirectory)
    const cleanStore = new XFeedbackStore(cleanDirectory)
    const navigation = createTrustedFactNavigation(
      cleanDirectory,
      {
        derive: located => ({
          topics: [],
          relations: [{ kind: 'about-target' as const, targetId: located.fact.target.id }],
        }),
      },
      { method: 'todo3-test', version: '1' },
    )
    const effects = new FeedbackEffectAdapter(cleanRepository, {
      append: input => cleanStore.append(input),
    }, navigation)
    const target = {
      id: 'x:clean-rating',
      content: 'clean feedback target',
      source: 'https://x.com/clean/status/2',
      scope: 'current message',
    } as const
    const useCase = new FeedbackUseCase(new InMemoryPendingStore({ ttlMs: 60_000, clock: { now: () => 1 } }))
    const result = useCase.execute({
      conversationKey: 'todo3',
      request: {
        currentMessage: { id: 1, text: '我喜欢，因为有明确证据。', targets: [target] },
        targetCatalog: { currentMessage: [target], reference: [] },
        trustedFactsByTarget: {},
      },
      interpretation: {
        kind: 'rating', sentiment: 'like', targetId: target.id,
        dimension: 'content_value', reason: '有明确证据。',
      },
    })
    expect(result.kind).toBe('completed')
    if (result.kind !== 'completed') throw new Error('clean rating did not complete')
    expect(result.effects).toHaveLength(1)
    expect(result.effects[0]?.kind).toBe('append_trusted_fact')
    const effectResult = effects.apply(result.effects[0]!)
    expect(effectResult).toEqual({ ok: true })
    expect(readFileSync(join(cleanDirectory, 'trusted-facts.jsonl'), 'utf8')).toContain('有明确证据')
    expect(existsSync(join(cleanDirectory, 'feedback.jsonl'))).toBe(false)
    expectFilesUnchanged(before)
  })

  it('pack gate 仍包含 prompt、Python runtime 与 lib，且不带私有状态', () => {
    const output = execFileSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: packageDirectory,
      encoding: 'utf8',
    })
    const entries = JSON.parse(output) as Array<{ files?: Array<{ path?: string }> }>
    const files = entries.flatMap(entry => (entry.files ?? []).flatMap(file => file.path === undefined ? [] : [file.path]))
    expect(files).toContain('python/x_insight_pipeline.py')
    expect(files).toContain('python/x_neighborhood.py')
    expect(files.some(file => /^lib\/.*\.js$/.test(file))).toBe(true)
    expect(files.some(file => /(?:feedback\.jsonl|x_insight_package\.json|__pycache__|(?:^|\/)tests?\/(?:|$))/.test(file))).toBe(false)
  })
})
