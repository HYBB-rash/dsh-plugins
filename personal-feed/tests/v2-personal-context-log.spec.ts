import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createPersonalContextOwner as currentFactory,
  personalFeedV2TelegramRequestId,
} from '../src/index.ts'

type Source = {
  readonly kind: 'telegram_inbound'
  readonly chatId: number
  readonly messageId: number
}

type Request = {
  readonly requestId: string
  readonly cutoff: string
  readonly shanghaiDay: string
}

type NewOwner = {
  readonly observe: (input: {
    readonly source: Source
    readonly rawText: string
    readonly signal?: AbortSignal
  }) => Promise<unknown>
  readonly snapshot: (input: { readonly request: Request }) => unknown
}

type NewFactory = (options: {
  readonly logPath: string
  readonly clock: { readonly now: () => Date }
  readonly semantic: { readonly revise: (input: unknown, signal?: AbortSignal) => unknown | Promise<unknown> }
}) => NewOwner

const createOwner = currentFactory as unknown as NewFactory
const roots: string[] = []

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

function workspace(): { readonly root: string; readonly logPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'personal-context-log-'))
  roots.push(root)
  return { root, logPath: join(root, 'personal-facts.jsonl') }
}

function clock(start = '2026-09-01T00:00:00.000Z'): { readonly now: () => Date } {
  let now = Date.parse(start)
  return { now: () => new Date(now++) }
}

function source(messageId: number, chatId = -7001): Source {
  return { kind: 'telegram_inbound', chatId, messageId }
}

function request(
  requestId: string,
  cutoff = '2026-09-01T00:00:10.000Z',
): Request {
  return { requestId, cutoff, shanghaiDay: '2026-09-01' }
}

function span(rawText: string, exact: string): { readonly startUtf16: number; readonly endUtf16: number } {
  const startUtf16 = rawText.indexOf(exact)
  if (startUtf16 < 0) throw new Error(`missing fixture span: ${exact}`)
  return { startUtf16, endUtf16: startUtf16 + exact.length }
}

function assertInterest(rawText: string, evidence: string, scope: string, stance: 'include' | 'exclude' = 'include') {
  return {
    operation: 'assert',
    targetFactIds: [],
    lane: 'long_term_interest',
    stance,
    evidenceSpan: span(rawText, evidence),
    scopeSpan: span(rawText, scope),
  }
}

function assertKnowledge(rawText: string, evidence: string, scope: string, epistemic: 'asserted' | 'uncertain' = 'asserted') {
  return {
    operation: 'assert',
    targetFactIds: [],
    lane: 'existing_knowledge',
    epistemic,
    evidenceSpan: span(rawText, evidence),
    scopeSpan: span(rawText, scope),
  }
}

function readLines(path: string): unknown[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').trimEnd().split('\n').filter(Boolean).map(line => JSON.parse(line) as unknown)
}

function text(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

function semanticSequence(...values: readonly unknown[]) {
  let index = 0
  return vi.fn(() => {
    const value = values[index]
    index += 1
    if (value instanceof Error) throw value
    if (value === undefined) throw new Error('semantic fixture exhausted')
    return value
  })
}

function activeFacts(snapshotResult: unknown, lane: 'longTermInterest' | 'existingKnowledge'): Record<string, unknown>[] {
  const result = snapshotResult as {
    readonly kind?: unknown
    readonly snapshot?: Record<string, { readonly activeFacts?: unknown }>
  }
  expect(result.kind).toBe('sufficient')
  const facts = result.snapshot?.[lane]?.activeFacts
  expect(Array.isArray(facts)).toBe(true)
  return facts as Record<string, unknown>[]
}

describe('Personal Context minimal append-only facts and revisions log', () => {
  it('uses one semantic call to atomically persist both lanes without raw text and reopens the same cutoff snapshot', async () => {
    const { logPath } = workspace()
    const rawText = '我以后持续研究可验证的软件设计；我已经知道复杂度只会转移。'
    const revise = vi.fn(() => ({
      kind: 'revisions',
      changes: [
        assertInterest(rawText, '我以后持续研究可验证的软件设计', '可验证的软件设计'),
        assertKnowledge(rawText, '我已经知道复杂度只会转移', '复杂度'),
      ],
    }))
    const owner = createOwner({ logPath, clock: clock(), semantic: { revise } })

    await expect(owner.observe({ source: source(1), rawText })).resolves.toEqual({ kind: 'applied' })
    expect(revise).toHaveBeenCalledTimes(1)
    expect(Object.keys(revise.mock.calls[0]![0] as object)).toEqual([
      'source', 'rawText', 'authorization', 'activeFacts',
    ])
    expect(revise.mock.calls[0]![0]).toEqual({
      source: source(1),
      rawText,
      authorization: { policy: 'direct_user_statement', purpose: 'personal_feed_context' },
      activeFacts: [],
    })

    const records = readLines(logPath)
    expect(records).toHaveLength(1)
    expect(records[0]).toStrictEqual({
      schemaVersion: 1,
      event: 'personal_fact_source_observed',
      source: {
        ...source(1),
        occurredAt: '2026-09-01T00:00:00.000Z',
      },
      appliedAt: '2026-09-01T00:00:00.001Z',
      authorization: { policy: 'direct_user_statement', purpose: 'personal_feed_context' },
      decision: {
        kind: 'revisions',
        changes: [
          {
            operation: 'assert',
            targetFactIds: [],
            evidence: { verbatim: '我以后持续研究可验证的软件设计' },
            fact: {
              factId: 'telegram_inbound:-7001:1#0',
              lane: 'long_term_interest',
              stance: 'include',
              scope: { verbatim: '可验证的软件设计' },
            },
          },
          {
            operation: 'assert',
            targetFactIds: [],
            evidence: { verbatim: '我已经知道复杂度只会转移' },
            fact: {
              factId: 'telegram_inbound:-7001:1#1',
              lane: 'existing_knowledge',
              epistemic: 'asserted',
              scope: { verbatim: '复杂度' },
            },
          },
        ],
      },
    })
    expect(statSync(logPath).mode & 0o777).toBe(0o600)
    expect(text(logPath)).not.toContain(rawText)
    expect(text(logPath)).not.toMatch(/rawText|digest|checkpoint|fence|sequence|proof|attitude|summary|proposition|reasoning|Span/)

    const snapshot = owner.snapshot({ request: request('personal-feed:v2:telegram:-7001:99') })
    expect(snapshot).toMatchObject({
      kind: 'sufficient',
      snapshot: {
        schemaVersion: 1,
        cutoff: '2026-09-01T00:00:10.000Z',
        longTermInterest: { sufficiency: { status: 'sufficient', basisFactIds: ['telegram_inbound:-7001:1#0'] } },
        existingKnowledge: { sufficiency: { status: 'sufficient', basisFactIds: ['telegram_inbound:-7001:1#1'] } },
      },
    })
    const reopenedRevise = vi.fn(() => ({ kind: 'ignored' }))
    const reopened = createOwner({ logPath, clock: clock('2026-09-02T00:00:00.000Z'), semantic: { revise: reopenedRevise } })
    expect(reopened.snapshot({ request: request('personal-feed:v2:telegram:-7001:99') })).toStrictEqual(snapshot)
    expect(reopenedRevise).not.toHaveBeenCalled()
  })

  it('persists an ignored source without body and replays the immutable locator without another semantic call', async () => {
    const { logPath } = workspace()
    const revise = vi.fn(() => ({ kind: 'ignored' }))
    const owner = createOwner({ logPath, clock: clock(), semantic: { revise } })
    const input = { source: source(2), rawText: '看看这条普通消息' }

    await expect(owner.observe(input)).resolves.toEqual({ kind: 'ignored' })
    const before = text(logPath)
    await expect(owner.observe(input)).resolves.toEqual({ kind: 'already_observed' })

    expect(revise).toHaveBeenCalledTimes(1)
    expect(text(logPath)).toBe(before)
    expect(readLines(logPath)).toStrictEqual([{
      schemaVersion: 1,
      event: 'personal_fact_source_observed',
      source: { ...source(2), occurredAt: '2026-09-01T00:00:00.000Z' },
      appliedAt: '2026-09-01T00:00:00.001Z',
      authorization: { policy: 'direct_user_statement', purpose: 'personal_feed_context' },
      decision: { kind: 'ignored' },
    }])
    expect(before).not.toContain(input.rawText)
  })

  it('folds assert, confirm, correct, replace, and withdraw while rejecting invalid target relations atomically', async () => {
    const { logPath } = workspace()
    const raws = [
      '我以后持续研究 AI',
      '我确认会继续研究 AI',
      '我以后持续研究模型评测',
      '我纠正为研究 AI 可靠性',
      '以后统一研究可验证 AI 系统',
      '我撤回这个长期方向',
      '我知道上下文越多不一定越好',
      '这次非法地同时改同一事实',
    ]
    const firstId = 'telegram_inbound:-7001:10#0'
    const secondId = 'telegram_inbound:-7001:12#0'
    const correctedId = 'telegram_inbound:-7001:13#0'
    const replacementId = 'telegram_inbound:-7001:14#0'
    const knowledgeId = 'telegram_inbound:-7001:16#0'
    const revise = semanticSequence(
      { kind: 'revisions', changes: [assertInterest(raws[0]!, raws[0]!, 'AI')] },
      { kind: 'revisions', changes: [{ operation: 'confirm', targetFactIds: [firstId], evidenceSpan: span(raws[1]!, raws[1]!)}] },
      { kind: 'revisions', changes: [assertInterest(raws[2]!, raws[2]!, '模型评测')] },
      { kind: 'revisions', changes: [{
        operation: 'correct', targetFactIds: [firstId], lane: 'long_term_interest', stance: 'include',
        evidenceSpan: span(raws[3]!, raws[3]!), scopeSpan: span(raws[3]!, 'AI 可靠性'),
      }] },
      { kind: 'revisions', changes: [{
        operation: 'replace', targetFactIds: [correctedId, secondId], lane: 'long_term_interest', stance: 'include',
        evidenceSpan: span(raws[4]!, raws[4]!), scopeSpan: span(raws[4]!, '可验证 AI 系统'),
      }] },
      { kind: 'revisions', changes: [{ operation: 'withdraw', targetFactIds: [replacementId], evidenceSpan: span(raws[5]!, raws[5]!)}] },
      { kind: 'revisions', changes: [assertKnowledge(raws[6]!, raws[6]!, '上下文')] },
      { kind: 'revisions', changes: [
        { operation: 'withdraw', targetFactIds: [knowledgeId], evidenceSpan: span(raws[7]!, raws[7]!) },
        {
          operation: 'correct', targetFactIds: [knowledgeId], lane: 'existing_knowledge', epistemic: 'asserted',
          evidenceSpan: span(raws[7]!, raws[7]!), scopeSpan: span(raws[7]!, '同一事实'),
        },
      ] },
    )
    const owner = createOwner({ logPath, clock: clock(), semantic: { revise } })
    for (let index = 0; index < 7; index += 1) {
      await expect(owner.observe({ source: source(10 + index), rawText: raws[index]! })).resolves.toMatchObject({
        kind: 'applied',
      })
    }

    const afterWithdraw = owner.snapshot({ request: request('personal-feed:v2:telegram:-7001:90') }) as any
    expect(afterWithdraw.kind).toBe('insufficient')
    expect(afterWithdraw.laneStatus.longTermInterest).toEqual({ status: 'insufficient', reason: 'no_active_include' })
    expect(afterWithdraw.laneStatus.existingKnowledge).toEqual({ status: 'sufficient', basisFactIds: [knowledgeId] })
    const records = readLines(logPath) as any[]
    expect(records[1].decision.changes[0]).toEqual({
      operation: 'confirm', targetFactIds: [firstId], evidence: { verbatim: raws[1] },
    })
    expect(records[3].decision.changes[0].fact.factId).toBe(correctedId)
    expect(records[4].decision.changes[0].fact.factId).toBe(replacementId)
    expect(records[5].decision.changes[0]).toEqual({
      operation: 'withdraw', targetFactIds: [replacementId], evidence: { verbatim: raws[5] },
    })

    const bytes = text(logPath)
    await expect(owner.observe({ source: source(17), rawText: raws[7]! })).resolves.toEqual({
      kind: 'incomplete', reason: 'invalid_semantics',
    })
    expect(text(logPath)).toBe(bytes)
  })

  it('derives every persistent string from valid UTF-16 spans and rejects generated text, bad spans, and invalid targets without writing', async () => {
    const accepted = workspace()
    const rawText = '我长期研究🧠系统'
    const acceptedOwner = createOwner({
      logPath: accepted.logPath,
      clock: clock(),
      semantic: { revise: () => ({ kind: 'revisions', changes: [assertInterest(rawText, rawText, '🧠系统')] }) },
    })
    await expect(acceptedOwner.observe({ source: source(20), rawText })).resolves.toEqual({ kind: 'applied' })
    expect(readLines(accepted.logPath)).toMatchObject([{
      decision: { changes: [{ evidence: { verbatim: rawText }, fact: { scope: { verbatim: '🧠系统' } } }] },
    }])

    const invalidOutputs: readonly unknown[] = [
      { kind: 'revisions', changes: [{ ...assertInterest(rawText, rawText, '🧠系统'), evidenceSpan: { startUtf16: 0, endUtf16: rawText.length + 1 } }] },
      { kind: 'revisions', changes: [{ ...assertInterest(rawText, rawText, '🧠系统'), scopeSpan: { startUtf16: 0, endUtf16: 0 } }] },
      { kind: 'revisions', changes: [{ ...assertInterest(rawText, rawText, '🧠系统'), generatedFact: '模型生成的扩写' }] },
      { kind: 'revisions', changes: [{ ...assertInterest(rawText, rawText, '🧠系统') }], extra: true },
      { kind: 'revisions', changes: [{ operation: 'withdraw', targetFactIds: ['missing'], evidenceSpan: span(rawText, rawText) }] },
    ]
    for (let index = 0; index < invalidOutputs.length; index += 1) {
      const isolated = workspace()
      const owner = createOwner({
        logPath: isolated.logPath,
        clock: clock(),
        semantic: { revise: () => invalidOutputs[index] },
      })
      await expect(owner.observe({ source: source(30 + index), rawText })).resolves.toEqual({
        kind: 'incomplete', reason: 'invalid_semantics',
      })
      expect(text(isolated.logPath)).toBe('')
    }

    const crossLaneBytes = text(accepted.logPath)
    const interestId = (readLines(accepted.logPath)[0] as any).decision.changes[0].fact.factId as string
    const crossLane = createOwner({
      logPath: accepted.logPath,
      clock: clock('2026-09-01T00:01:00.000Z'),
      semantic: { revise: () => ({
        kind: 'revisions',
        changes: [{
          operation: 'correct', targetFactIds: [interestId], lane: 'existing_knowledge', epistemic: 'asserted',
          evidenceSpan: span('我知道它', '我知道它'), scopeSpan: span('我知道它', '它'),
        }],
      }) },
    })
    await expect(crossLane.observe({ source: source(40), rawText: '我知道它' })).resolves.toEqual({
      kind: 'incomplete', reason: 'invalid_semantics',
    })
    expect(text(accepted.logPath)).toBe(crossLaneBytes)
  })

  it('computes long-term-interest and existing-knowledge sufficiency independently', async () => {
    const { logPath } = workspace()
    const raws = ['我不关注漫展', '我也许知道这个结论', '我持续关注动漫', '我知道价格受政策驱动']
    const revise = semanticSequence(
      { kind: 'revisions', changes: [assertInterest(raws[0]!, raws[0]!, '漫展', 'exclude')] },
      { kind: 'revisions', changes: [assertKnowledge(raws[1]!, raws[1]!, '这个结论', 'uncertain')] },
      { kind: 'revisions', changes: [assertInterest(raws[2]!, raws[2]!, '动漫')] },
      { kind: 'revisions', changes: [assertKnowledge(raws[3]!, raws[3]!, '价格')] },
    )
    const owner = createOwner({ logPath, clock: clock(), semantic: { revise } })
    await owner.observe({ source: source(50), rawText: raws[0]! })
    await owner.observe({ source: source(51), rawText: raws[1]! })
    expect(owner.snapshot({ request: request('personal-feed:v2:telegram:-7001:90') })).toMatchObject({
      kind: 'insufficient',
      laneStatus: {
        longTermInterest: { status: 'insufficient', reason: 'no_active_include' },
        existingKnowledge: { status: 'insufficient', reason: 'no_asserted_knowledge' },
      },
    })
    await owner.observe({ source: source(52), rawText: raws[2]! })
    expect(owner.snapshot({ request: request('personal-feed:v2:telegram:-7001:90') })).toMatchObject({
      kind: 'insufficient',
      laneStatus: {
        longTermInterest: { status: 'sufficient' },
        existingKnowledge: { status: 'insufficient' },
      },
    })
    await owner.observe({ source: source(53), rawText: raws[3]! })
    expect(owner.snapshot({ request: request('personal-feed:v2:telegram:-7001:90') })).toMatchObject({
      kind: 'sufficient',
      snapshot: {
        longTermInterest: { sufficiency: { status: 'sufficient' } },
        existingKnowledge: { sufficiency: { status: 'sufficient' } },
      },
    })
  })

  it('folds both lanes from one cutoff prefix, excludes the current Telegram source, and exposes it only to a later request', async () => {
    const { logPath } = workspace()
    const rawText = '我以后持续研究缓存；我知道缓存可能落盘。'
    const currentSource = source(60)
    const owner = createOwner({
      logPath,
      clock: clock('2026-09-01T00:00:00.000Z'),
      semantic: { revise: () => ({
        kind: 'revisions',
        changes: [
          assertInterest(rawText, '我以后持续研究缓存', '缓存'),
          assertKnowledge(rawText, '我知道缓存可能落盘', '缓存'),
        ],
      }) },
    })
    await owner.observe({ source: currentSource, rawText })
    const currentRequestId = personalFeedV2TelegramRequestId(currentSource.chatId, currentSource.messageId)
    expect(owner.snapshot({ request: request(currentRequestId) })).toMatchObject({
      kind: 'insufficient',
      laneStatus: {
        longTermInterest: { status: 'insufficient' },
        existingKnowledge: { status: 'insufficient' },
      },
    })
    const later = owner.snapshot({ request: request(personalFeedV2TelegramRequestId(-7001, 61)) })
    expect(later).toMatchObject({ kind: 'sufficient', snapshot: { cutoff: '2026-09-01T00:00:10.000Z' } })
    expect(activeFacts(later, 'longTermInterest')).toHaveLength(1)
    expect(activeFacts(later, 'existingKnowledge')).toHaveLength(1)

    const afterCutoffRaw = '我以后持续研究未来主题；我知道未来命题。'
    const afterCutoffOwner = createOwner({
      logPath,
      clock: clock('2026-09-01T00:01:00.000Z'),
      semantic: { revise: () => ({
        kind: 'revisions',
        changes: [
          assertInterest(afterCutoffRaw, '我以后持续研究未来主题', '未来主题'),
          assertKnowledge(afterCutoffRaw, '我知道未来命题', '未来命题'),
        ],
      }) },
    })
    await afterCutoffOwner.observe({ source: source(62), rawText: afterCutoffRaw })
    const sameCutoff = afterCutoffOwner.snapshot({ request: request(personalFeedV2TelegramRequestId(-7001, 63)) })
    expect(activeFacts(sameCutoff, 'longTermInterest')).toHaveLength(1)
    expect(activeFacts(sameCutoff, 'existingKnowledge')).toHaveLength(1)
  })

  it('fails closed across restart, corrupt storage, semantic failure, abort, and append failure without partial or sensitive output', async () => {
    const corruptCases = [
      '{not-json}\n',
      '{"schemaVersion":2}\n',
      '{"schemaVersion":1,"event":"personal_fact_source_observed","extra":true}\n',
    ]
    for (const [index, raw] of corruptCases.entries()) {
      const isolated = workspace()
      writeFileSync(isolated.logPath, raw, { mode: 0o600 })
      const owner = createOwner({ logPath: isolated.logPath, clock: clock(), semantic: { revise: vi.fn() } })
      expect(owner.snapshot({ request: request(`personal-feed:v2:telegram:-7001:${70 + index}`) })).toEqual({
        kind: 'unknown', reason: 'store_unavailable',
      })
      await expect(owner.observe({ source: source(70 + index), rawText: 'PRIVATE_CORRUPT_CANARY' })).resolves.toEqual({
        kind: 'incomplete', reason: 'store_unavailable',
      })
      expect(text(isolated.logPath)).toBe(raw)
    }

    const semanticFailure = workspace()
    const secret = 'PRIVATE_SEMANTIC_CANARY'
    const owner = createOwner({
      logPath: semanticFailure.logPath,
      clock: clock(),
      semantic: { revise: () => { throw new Error(`RAW_ERROR_${secret}`) } },
    })
    const failed = await owner.observe({ source: source(80), rawText: secret })
    expect(failed).toEqual({ kind: 'incomplete', reason: 'semantic_unavailable' })
    expect(JSON.stringify(failed)).not.toContain(secret)
    expect(text(semanticFailure.logPath)).toBe('')

    const aborted = workspace()
    const revise = vi.fn()
    const controller = new AbortController()
    controller.abort(new Error('PRIVATE_ABORT_CANARY'))
    const abortedOwner = createOwner({ logPath: aborted.logPath, clock: clock(), semantic: { revise } })
    await expect(abortedOwner.observe({ source: source(81), rawText: secret, signal: controller.signal })).resolves.toEqual({
      kind: 'incomplete', reason: 'aborted',
    })
    expect(revise).not.toHaveBeenCalled()
    expect(text(aborted.logPath)).toBe('')

    const unwritable = workspace()
    mkdirSync(unwritable.logPath)
    chmodSync(unwritable.logPath, 0o700)
    const appendOwner = createOwner({
      logPath: unwritable.logPath,
      clock: clock(),
      semantic: { revise: () => ({ kind: 'ignored' }) },
    })
    const appendFailure = await appendOwner.observe({ source: source(82), rawText: secret })
    expect(appendFailure).toEqual({ kind: 'incomplete', reason: 'store_unavailable' })
    expect(JSON.stringify(appendFailure)).not.toContain(secret)
    expect(statSync(unwritable.logPath).isDirectory()).toBe(true)
  })
})
