import { describe, expect, it, vi } from 'vitest'
import { createPersonalFeedV2RequestCoordinator } from '../src/v2/request-coordinator.ts'

const CANDIDATE = Object.freeze({
  stableId: 'x-status:42',
  canonicalUrl: 'https://x.com/alice/status/42',
  body: 'candidate body',
  provenance: Object.freeze([{ surface: 'for_you', surfaceOrdinal: 0, occurrenceOrdinal: 0 }]),
})

function controller() {
  return new AbortController()
}

function base(overrides: Readonly<Record<string, unknown>> = {}) {
  const order: string[] = []
  const snapshot = Object.freeze({ interests: Object.freeze(['reliable systems']), knowledge: Object.freeze(['queues']) })
  const window = Object.freeze({ marker: 'RAW_WINDOW_CANARY' })
  let closeCalls = 0
  let clockCalls = 0
  const options = {
    clock: {
      now: () => {
        clockCalls += 1
        return new Date('2026-08-31T02:00:00.000Z')
      },
    },
    r4: {
      snapshot: async (input: unknown) => {
        order.push('r4')
        expect(Object.keys(input as object).sort()).toEqual(['request', 'signal'])
        return Object.freeze({ kind: 'sufficient', snapshot })
      },
    },
    r2: {
      observe: async (input: unknown) => {
        order.push('r2')
        expect(Object.keys(input as object).sort()).toEqual(['request', 'signal'])
        return Object.freeze({
          kind: 'complete',
          window,
          close: async () => { closeCalls += 1; order.push('r2-close') },
        })
      },
    },
    r3: {
      evaluate: async (input: any) => {
        order.push('r3')
        expect(Object.keys(input).sort()).toEqual(['judgeOne', 'request', 'signal', 'window'])
        expect(input.window).toBe(window)
        expect(JSON.stringify(input)).not.toContain('reliable systems')
        const judgment = await input.judgeOne(CANDIDATE)
        expect(judgment).toEqual({ kind: 'qualified' })
        return Object.freeze({ kind: 'selected', stableId: CANDIDATE.stableId, canonicalUrl: CANDIDATE.canonicalUrl })
      },
    },
    r5: {
      judgeOne: async (input: any) => {
        order.push('r5')
        expect(Object.keys(input).sort()).toEqual(['candidate', 'request', 'signal', 'snapshot'])
        expect(input.snapshot).toBe(snapshot)
        expect(input.candidate).toBe(CANDIDATE)
        expect(JSON.stringify(input)).not.toContain('RAW_WINDOW_CANARY')
        return Object.freeze({ kind: 'qualified' })
      },
    },
    ...overrides,
  }
  return { options, order, snapshot, window, closeCalls: () => closeCalls, clockCalls: () => clockCalls }
}

describe('Personal Feed v2 request coordinator', () => {
  it('creates one immutable request context and runs R4, R2, R3 and per-candidate R5 with minimal information', async () => {
    const sample = base()
    const signal = controller().signal
    const coordinator = createPersonalFeedV2RequestCoordinator(sample.options as never)
    const prepared = await coordinator.prepare({ chatId: 17, messageId: 23, signal })

    expect(Object.keys(coordinator)).toEqual(['prepare'])
    expect(prepared).toEqual({
      kind: 'prepared',
      request: { requestId: 'telegram:17:23', cutoff: '2026-08-31T02:00:00.000Z', shanghaiDay: '2026-08-31' },
      outcome: { kind: 'one_link', finalText: 'https://x.com/alice/status/42' },
    })
    expect(Object.isFrozen(prepared.request)).toBe(true)
    expect(Object.isFrozen(prepared.outcome)).toBe(true)
    expect(sample.clockCalls()).toBe(1)
    expect(sample.closeCalls()).toBe(1)
    expect(sample.order).toEqual(['r4', 'r2', 'r3', 'r5', 'r2-close'])
  })

  it('returns business empty only from an exact completed R3 none result', async () => {
    const r5 = vi.fn()
    const sample = base({ r3: { evaluate: async () => ({ kind: 'none' }) }, r5: { judgeOne: r5 } })
    const prepared = await createPersonalFeedV2RequestCoordinator(sample.options as never)
      .prepare({ chatId: 17, messageId: 23, signal: signal() })
    expect(prepared.outcome).toEqual({ kind: 'business_empty', finalText: '这次没有值得看的内容。' })
    expect(r5).not.toHaveBeenCalled()
    expect(sample.closeCalls()).toBe(1)
  })

  it.each([
    { name: 'R4 incomplete', stage: 'r4', value: { kind: 'incomplete' }, category: 'personal_context', calls: [1, 0, 0, 0] },
    { name: 'R4 malformed', stage: 'r4', value: { kind: 'sufficient' }, category: 'personal_context', calls: [1, 0, 0, 0] },
    { name: 'R2 incomplete', stage: 'r2', value: { kind: 'incomplete' }, category: 'source_window', calls: [1, 1, 0, 0] },
    { name: 'R2 malformed', stage: 'r2', value: { kind: 'complete', window: {} }, category: 'source_window', calls: [1, 1, 0, 0] },
    { name: 'R3 incomplete', stage: 'r3', value: { kind: 'incomplete' }, category: 'judgement_execution', calls: [1, 1, 1, 0] },
    { name: 'R3 malformed none', stage: 'r3', value: { kind: 'none', extra: true }, category: 'judgement_execution', calls: [1, 1, 1, 0] },
    { name: 'R3 malformed selected', stage: 'r3', value: { kind: 'selected', stableId: 'x-status:42', canonicalUrl: 'https://x.com/alice/status/99' }, category: 'judgement_execution', calls: [1, 1, 1, 0] },
  ])('fails closed for $name without calling later stages', async testCase => {
    const calls = [vi.fn(), vi.fn(), vi.fn(), vi.fn()]
    const complete = Object.freeze({ kind: 'complete', window: Object.freeze({}), close: async () => undefined })
    const options = {
      clock: { now: () => new Date('2026-08-31T02:00:00.000Z') },
      r4: { snapshot: async () => { calls[0]!(); return testCase.stage === 'r4' ? testCase.value : { kind: 'sufficient', snapshot: {} } } },
      r2: { observe: async () => { calls[1]!(); return testCase.stage === 'r2' ? testCase.value : complete } },
      r3: { evaluate: async () => { calls[2]!(); return testCase.stage === 'r3' ? testCase.value : { kind: 'none' } } },
      r5: { judgeOne: async () => { calls[3]!(); return { kind: 'qualified' } } },
    }
    const prepared = await createPersonalFeedV2RequestCoordinator(options as never)
      .prepare({ chatId: 17, messageId: 23, signal: signal() })
    expect(prepared.outcome).toEqual({
      kind: 'incomplete',
      category: testCase.category,
      finalText: testCase.category === 'personal_context'
        ? '这次没有完成：个人语境不足或未完成。'
        : testCase.category === 'source_window'
          ? '这次没有完成：X 来源或观察窗口未完成。'
          : '这次没有完成：判断或执行未完成。',
    })
    expect(calls.map(call => call.mock.calls.length)).toEqual(testCase.calls)
  })

  it('maps thrown ports and outer capture-close failure to an honest incomplete terminal', async () => {
    const r2 = base({ r2: { observe: async () => { throw new Error('source failed') } } })
    await expect(createPersonalFeedV2RequestCoordinator(r2.options as never)
      .prepare({ chatId: 17, messageId: 23, signal: signal() }))
      .resolves.toMatchObject({ outcome: { kind: 'incomplete', category: 'source_window' } })

    const r3 = base({ r3: { evaluate: async () => { throw new Error('judge failed') } } })
    await expect(createPersonalFeedV2RequestCoordinator(r3.options as never)
      .prepare({ chatId: 17, messageId: 23, signal: signal() }))
      .resolves.toMatchObject({ outcome: { kind: 'incomplete', category: 'judgement_execution' } })

    const close = base({
      r3: { evaluate: async () => ({ kind: 'none' }) },
      r2: { observe: async () => ({ kind: 'complete', window: {}, close: async () => { throw new Error('close failed') } }) },
    })
    await expect(createPersonalFeedV2RequestCoordinator(close.options as never)
      .prepare({ chatId: 17, messageId: 23, signal: signal() }))
      .resolves.toMatchObject({ outcome: { kind: 'incomplete', category: 'source_window' } })
  })

  it('checks abort between stages and never converts it into business empty', async () => {
    const abort = controller()
    const r2 = vi.fn()
    const sample = base({
      r4: { snapshot: async () => { abort.abort(); return { kind: 'sufficient', snapshot: {} } } },
      r2: { observe: r2 },
    })
    const prepared = await createPersonalFeedV2RequestCoordinator(sample.options as never)
      .prepare({ chatId: 17, messageId: 23, signal: abort.signal })
    expect(prepared.outcome).toMatchObject({ kind: 'incomplete', category: 'personal_context' })
    expect(r2).not.toHaveBeenCalled()
  })

  it('rejects invalid request identity or clock instead of inventing a request context', async () => {
    const coordinator = createPersonalFeedV2RequestCoordinator(base().options as never)
    await expect(coordinator.prepare({ chatId: 0, messageId: 23, signal: signal() })).rejects.toThrow()
    const broken = createPersonalFeedV2RequestCoordinator(base({ clock: { now: () => new Date(Number.NaN) } }).options as never)
    await expect(broken.prepare({ chatId: 17, messageId: 23, signal: signal() })).rejects.toThrow()
  })
})

function signal(): AbortSignal {
  return controller().signal
}
