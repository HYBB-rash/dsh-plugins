import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import {
  CallId,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import * as RouteInvariant from '../src/invariant.ts'
import {
  assertRouteFreshForCompaction,
  buildRouteMaterial,
  createRouteRearmMessage,
  createRouteRevisionMessage,
  decodeRouteMessage,
  foldRoute,
  isHumanAnswerEvent,
  parseRouteBody,
  renderRouteContext,
  routeNeedsRearm,
  routeBodyFailureCode,
  ROUTE_CONTEXT_SOURCE,
  type RouteBody,
  type RouteSnapshot,
} from '../src/index.ts'

function appendUser(session: Session, text: string): number {
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' }).seq
}

function appendAssistant(session: Session, text: string): number {
  return session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createAssistantMessage({
      content: [{ type: 'text', text }],
      source: { provider: 'mock', model: 'mock' },
    }),
  }, { surfaceOp: 'append' }).seq
}

function appendToolAnswer(
  session: Session,
  name: string,
  value: unknown,
  isError = false,
): number {
  const callId = CallId(`call-${session.seq}`)
  session.append('tool/call', {
    turn: 1,
    step: 1,
    callId,
    name,
    arguments: '{}',
  })
  return session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({
      callId,
      content: [{ type: 'text', text: JSON.stringify(value) }],
      isError,
    }),
  }, { surfaceOp: 'append' }).seq
}

function correctionFromTool(
  previous: RouteSnapshot,
  correctionSeq: number,
): RouteBody {
  const body = correctedBody(previous, 0, correctionSeq)
  return {
    ...body,
    detailRefs: [{
      label: '用户的人机选择原文',
      why: '发生路线冲突时核对最新明确决定',
      sourceSeqs: [correctionSeq],
      preferredSourceKinds: ['tool'],
    }],
  }
}

function initialBody(rootSeq: number, routeSeq: number): RouteBody {
  return {
    rootGoal: { text: '让长会话在多次压缩后仍知道正确路线', sourceSeqs: [rootSeq] },
    successCriteria: [
      { text: '模型能说清当前路线并按原始 seq 找回细节', sourceSeqs: [rootSeq] },
    ],
    currentRoute: {
      text: '先走路线 A',
      reason: '这是当前可运行的薄实现',
      status: 'tentative',
      sourceSeqs: [routeSeq],
    },
    decisions: [],
    retiredRoutes: [],
    currentNode: { text: '实现严格事件回放', sourceSeqs: [routeSeq] },
    nextDecision: { text: '检查压缩门禁是否成立', sourceSeqs: [routeSeq] },
    reviewTriggers: [
      { text: '路线纠正后旧路线重新成为默认时暂停', sourceSeqs: [rootSeq] },
    ],
    detailRefs: [{
      label: '用户定义的根目标原文',
      why: '需要核对目标边界时读取',
      sourceSeqs: [rootSeq],
      preferredSourceKinds: ['user'],
      fallbackQuery: '长会话 正确路线',
    }],
  }
}

function correctedBody(
  previous: RouteSnapshot,
  rootSeq: number,
  correctionSeq: number,
): RouteBody {
  return {
    rootGoal: { text: '让长会话在多次压缩后仍知道正确路线', sourceSeqs: [rootSeq] },
    successCriteria: [
      { text: '模型能说清当前路线并按原始 seq 找回细节', sourceSeqs: [rootSeq] },
    ],
    currentRoute: {
      text: '改走路线 B',
      reason: '用户明确纠正了实现方向',
      status: 'confirmed',
      sourceSeqs: [correctionSeq],
    },
    decisions: [{
      text: '使用 Session 标准持久上下文消息',
      status: 'confirmed',
      sourceSeqs: [correctionSeq],
    }],
    retiredRoutes: [{
      text: previous.currentRoute.text,
      reason: '被用户更新后的路线替代',
      status: 'superseded',
      sourceSeqs: [correctionSeq],
    }],
    currentNode: { text: '验证路线 B 不会在压缩后丢失', sourceSeqs: [correctionSeq] },
    nextDecision: null,
    reviewTriggers: [
      { text: '路线纠正后旧路线重新成为默认时暂停', sourceSeqs: [rootSeq] },
    ],
    detailRefs: [{
      label: '用户的路线纠正原文',
      why: '发生路线冲突时核对最新明确决定',
      sourceSeqs: [correctionSeq],
      preferredSourceKinds: ['user'],
    }],
  }
}

function appendInitialRoute(session: Session): RouteSnapshot {
  const rootSeq = appendUser(session, '我要让长会话多次压缩后仍知道正确路线。')
  const routeSeq = appendAssistant(session, '可以先走路线 A。')
  const data = parseRouteBody(
    JSON.stringify(initialBody(rootSeq, routeSeq)),
    undefined,
    routeSeq,
    session.events,
  )
  session.append(
    'user/message',
    createRouteRevisionMessage(String(session.id), data),
    { surfaceOp: 'append' },
  )
  return data.snapshot
}

describe('strict route message fold', () => {
  it('replays a complete create revision deterministically', () => {
    const session = Session.create(SessionId('route-create'))
    const snapshot = appendInitialRoute(session)

    expect(foldRoute(session.events)).toEqual({ snapshot, eventSeq: 2 })
    expect(snapshot.revision).toBe(1)
    expect(snapshot.asOfSeq).toBe(1)
  })

  it('makes a newer user correction current and explicitly retires the old route', () => {
    const session = Session.create(SessionId('route-correction'))
    const first = appendInitialRoute(session)
    const correctionSeq = appendUser(session, '不要路线 A，确认改走路线 B。')
    const update = parseRouteBody(
      JSON.stringify(correctedBody(first, 0, correctionSeq)),
      first,
      correctionSeq,
      session.events,
    )
    session.append(
      'user/message',
      createRouteRevisionMessage(String(session.id), update),
      { surfaceOp: 'append' },
    )

    const folded = foldRoute(session.events)?.snapshot
    expect(folded?.revision).toBe(2)
    expect(folded?.currentRoute.text).toBe('改走路线 B')
    expect(folded?.retiredRoutes).toContainEqual(expect.objectContaining({
      text: '先走路线 A',
      status: 'superseded',
    }))
  })

  it('accepts only a successful correlated ask_user_question answer as human confirmation', () => {
    const session = Session.create(SessionId('route-human-answer'))
    const first = appendInitialRoute(session)
    const answerSeq = appendToolAnswer(session, 'ask_user_question', {
      answers: [{ id: 'route', selected: ['确认改走路线 B'] }],
    })
    const answerEvent = session.events[answerSeq]
    expect(answerEvent).toBeDefined()
    expect(isHumanAnswerEvent(answerEvent!, session.events)).toBe(true)
    expect(buildRouteMaterial(session.events, first, 32_000))
      .toContain(`[seq ${answerSeq} human-answer]`)

    const update = parseRouteBody(
      JSON.stringify(correctionFromTool(first, answerSeq)),
      first,
      answerSeq,
      session.events,
    )
    expect(update.snapshot.currentRoute).toMatchObject({
      text: '改走路线 B',
      status: 'confirmed',
      sourceSeqs: [answerSeq],
    })
  })

  it('does not let ordinary, failed, or empty tool results confirm a route', () => {
    const cases = [
      { id: 'ordinary', name: 'choose_route', value: { answers: [{ id: 'route', selected: ['路线 B'] }] }, error: false },
      { id: 'failed', name: 'ask_user_question', value: { answers: [{ id: 'route', selected: ['路线 B'] }] }, error: true },
      { id: 'empty', name: 'ask_user_question', value: { answers: [{ id: 'route', selected: [] }] }, error: false },
    ] as const
    for (const item of cases) {
      const session = Session.create(SessionId(`route-human-answer-${item.id}`))
      const first = appendInitialRoute(session)
      const resultSeq = appendToolAnswer(session, item.name, item.value, item.error)
      const resultEvent = session.events[resultSeq]
      expect(resultEvent).toBeDefined()
      expect(isHumanAnswerEvent(resultEvent!, session.events)).toBe(false)
      expect(() => parseRouteBody(
        JSON.stringify(correctionFromTool(first, resultSeq)),
        first,
        resultSeq,
        session.events,
      )).toThrow(/verified ask_user_question answer/)
    }
  })

  it('rejects a route switch that silently drops the previous current route', () => {
    const session = Session.create(SessionId('route-missing-retirement'))
    const first = appendInitialRoute(session)
    const correctionSeq = appendUser(session, '确认改走路线 B。')
    const body = correctedBody(first, 0, correctionSeq)

    expect(() => parseRouteBody(
      JSON.stringify({ ...body, retiredRoutes: [] }),
      first,
      correctionSeq,
      session.events,
    )).toThrow(/must explicitly retire the previous current route/)
  })

  it('keeps the previous valid snapshot when a cold source has non-monotonic metadata', () => {
    const session = Session.create(SessionId('route-revision'))
    const first = appendInitialRoute(session)
    const correctionSeq = appendUser(session, '确认改走路线 B。')
    const valid = parseRouteBody(
      JSON.stringify(correctedBody(first, 0, correctionSeq)),
      first,
      correctionSeq,
      session.events,
    )
    const malformed = session.append(
      'user/message',
      createRouteRevisionMessage(String(session.id), {
        ...valid,
        snapshot: { ...valid.snapshot, revision: 7 },
      }),
      { surfaceOp: 'append' },
    )

    expect(() => decodeRouteMessage(
      malformed,
      first,
      session.events.slice(0, malformed.seq),
    )).toThrow(/revision 7 must be 2/)
    expect(foldRoute(session.events)?.snapshot).toEqual(first)
    expect(routeNeedsRearm(session.events, session.surface.nodes)).toBe(true)
  })

  it('rearms the exact latest snapshot after compaction hides its publication', () => {
    const session = Session.create(SessionId('route-rearm'))
    const snapshot = appendInitialRoute(session)
    const shadowed = [...session.surface.nodes]
    const start = shadowed[0]
    const end = shadowed.at(-1)
    if (start === undefined || end === undefined) throw new Error('expected a non-empty surface')
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '压缩后的工作尾巴摘要。' }],
      source: { kind: 'plugin', plugin: 'route-test-compactor' },
    }), {
      surfaceOp: { op: 'replace', start, end },
      sourceEventSeqs: shadowed,
    })

    expect(routeNeedsRearm(session.events, session.surface.nodes)).toBe(true)
    const rearm = session.append(
      'user/message',
      createRouteRearmMessage(String(session.id), snapshot),
      { surfaceOp: 'append' },
    )

    expect(foldRoute(session.events)).toEqual({ snapshot, eventSeq: rearm.seq })
    expect(routeNeedsRearm(session.events, session.surface.nodes)).toBe(false)
    expect(session.deriveMessages().filter(message =>
      message.source.kind === ROUTE_CONTEXT_SOURCE)).toHaveLength(1)
  })

  it('cold-restores through core only and remains readable with no plugin runtime', () => {
    const original = Session.create(SessionId('route-standard-cold'))
    const snapshot = appendInitialRoute(original)
    const restored = Session.create(
      SessionId('route-standard-cold'),
      JSON.parse(JSON.stringify(original.events)) as typeof original.events,
    )

    expect(foldRoute(restored.events)?.snapshot).toEqual(snapshot)
    expect(restored.events.every(event => [
      'user/message',
      'assistant/message',
      'session/end-seed',
    ].includes(event.type))).toBe(true)
    expect(() => restored.deriveMessages()).not.toThrow()
    expect(restored.deriveMessages().at(-1)?.source.kind).toBe(ROUTE_CONTEXT_SOURCE)
  })
})

describe('route projection and bounded material', () => {
  it('renders decisions, retired routes, review triggers, and exact retrieval instructions', () => {
    const session = Session.create(SessionId('route-render'))
    const first = appendInitialRoute(session)
    const correctionSeq = appendUser(session, '不要路线 A，确认改走路线 B。')
    const update = parseRouteBody(
      JSON.stringify(correctedBody(first, 0, correctionSeq)),
      first,
      correctionSeq,
      session.events,
    )
    const text = renderRouteContext(String(session.id), update.snapshot)

    expect(text).toContain('根目标：让长会话在多次压缩后仍知道正确路线')
    expect(text).toContain('当前路线：[confirmed] 改走路线 B')
    expect(text).toContain('[superseded] 先走路线 A')
    expect(text).toContain('原始 seq：3')
    expect(text).toContain('session_event_read')
    expect(text).toContain('不要把压缩摘要当作原始事实')
  })

  it('excludes runtime snapshots and raw tool arguments while redacting secret-like text', () => {
    const session = Session.create(SessionId('route-material'))
    appendUser(session, '根目标；password=super-secret-value')
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Current runtime context with duplicate route prose' }],
      source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' },
    }), { surfaceOp: 'append' })
    session.append('tool/call', {
      turn: 1,
      step: 1,
      callId: 'call-1' as never,
      name: 'deploy',
      arguments: '{"token":"raw-tool-secret"}',
    })

    const material = buildRouteMaterial(session.events, undefined, 32_000)
    expect(material).toContain('[sensitive detail omitted')
    expect(material).toContain('[tool call deploy; arguments omitted]')
    expect(material).not.toContain('super-secret-value')
    expect(material).not.toContain('raw-tool-secret')
    expect(material).not.toContain('duplicate route prose')
  })

  it('keeps the first root fact and newest human correction when older detail exceeds the budget', () => {
    const session = Session.create(SessionId('route-material-priority'))
    const rootSeq = appendUser(session, `最初根目标 ${'根'.repeat(3_500)}`)
    for (let index = 0; index < 12; index += 1) {
      appendAssistant(session, `旧操作 ${index} ${'旧'.repeat(2_400)}`)
      appendUser(session, `中间消息 ${index} ${'中'.repeat(3_500)}`)
    }
    const correctionSeq = appendUser(session, `最新明确纠正 ${'新'.repeat(3_500)}`)

    const material = buildRouteMaterial(session.events, undefined, 32_000)
    expect(material.length).toBeLessThanOrEqual(32_000)
    expect(material).toContain(`[seq ${rootSeq} user] 最初根目标`)
    expect(material).toContain(`[seq ${correctionSeq} user] 最新明确纠正`)
    expect(material).not.toMatch(/\u2026$/)
  })

  it('rejects secret-like model output before it can become a route message', () => {
    const session = Session.create(SessionId('route-secret'))
    const rootSeq = appendUser(session, '请维护当前路线。')
    const routeSeq = appendAssistant(session, '先做薄实现。')
    const unsafe = {
      ...initialBody(rootSeq, routeSeq),
      currentNode: { text: '使用 password=super-secret-value', sourceSeqs: [routeSeq] },
    }

    let failure: unknown
    try {
      parseRouteBody(JSON.stringify(unsafe), undefined, routeSeq, session.events)
    } catch (error: unknown) {
      failure = error
    }
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toMatch(/secret-like material/)
    expect(routeBodyFailureCode(failure)).toBe('secret-like-output')
    expect(session.events.some(event =>
      event.type === 'user/message' && event.data.source.kind === ROUTE_CONTEXT_SOURCE)).toBe(false)
  })
})

describe('pre-compaction freshness invariant', () => {
  it('blocks stale compaction before append and leaves raw history intact', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(RouteInvariant)
    const session = ctx.sessions.create(SessionId('route-gate'))
    appendUser(session, '请完成这个长任务。')
    appendAssistant(session, '已经推进一部分。')
    const before = session.events.length

    expect(() => session.append('compaction/start', {
      compactionId: CompactionId('stale-1'),
      turn: null,
    })).toThrow(/compaction is blocked: no route snapshot/)
    expect(session.events).toHaveLength(before)

    const data = parseRouteBody(JSON.stringify(initialBody(0, 1)), undefined, 1, session.events)
    session.append(
      'user/message',
      createRouteRevisionMessage(String(session.id), data),
      { surfaceOp: 'append' },
    )
    expect(() => assertRouteFreshForCompaction(session.events)).not.toThrow()
    session.append('compaction/start', { compactionId: CompactionId('fresh-1'), turn: null })
    session.append('compaction/end', { compactionId: CompactionId('fresh-1'), turn: null })

    appendUser(session, '这里有一个新的明确纠正。')
    const staleLength = session.events.length
    expect(() => session.append('compaction/start', {
      compactionId: CompactionId('stale-2'),
      turn: null,
    })).toThrow(/latest semantic seq is/)
    expect(session.events).toHaveLength(staleLength)
  })
})
