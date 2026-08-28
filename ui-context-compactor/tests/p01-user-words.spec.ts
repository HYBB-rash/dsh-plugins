import { describe, expect, it } from 'vitest'
import {
  CallId,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  freezeMessage,
  MessageId,
  type UserMessage,
} from '@deepseek-ai/dsh-llm'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import {
  P01_USER_WORDS_VIEW_HEADER,
  P01_USER_WORDS_VIEW_MAX_CHARS,
  buildP01UserWordsView,
  resolveP01UserWordsViewConfig,
} from '../src/index.ts'

interface BuildP01UserWordsViewRequest {
  readonly events: readonly SessionEvent[]
  readonly surfaceNodes: readonly number[]
}

function buildView(request: BuildP01UserWordsViewRequest): string {
  return buildP01UserWordsView(request)
}

function appendUser(session: Session, text: string, message?: UserMessage): number {
  return session.append('user/message', message ?? createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' }).seq
}

function appendCarrier(session: Session, text: string, message?: UserMessage): number {
  return session.append('user/message', message ?? createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'p01-test-carrier' },
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

function appendToolResult(session: Session, text: string): number {
  const callId = CallId(`p01-carrier-call-${session.seq}`)
  session.append('tool/call', {
    turn: 1,
    step: 1,
    callId,
    name: 'p01-test-tool-carrier',
    arguments: '{}',
  })
  return session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({
      callId,
      content: [{ type: 'text', text }],
      isError: false,
    }),
  }, { surfaceOp: 'append' }).seq
}

function expectRecord(view: string, seq: number, text: string): void {
  expect(view).toContain(P01_USER_WORDS_VIEW_HEADER)
  expect(view).toContain(`[seq ${seq}; message-id "`)
  expect(view).toContain(`; source direct-user]\n${text}`)
}

describe('P01 fixed user-words view matrix', () => {
  it('accepts only one non-blank exact Session id in enforce mode', () => {
    expect(resolveP01UserWordsViewConfig({
      mode: 'enforce', allowlist: ['session-exact'],
    })).toEqual({ sessionId: 'session-exact' })
    expect(() => resolveP01UserWordsViewConfig({
      mode: 'observe', allowlist: ['session-exact'],
    })).toThrow(/exactly one allowlisted Session/u)
    expect(() => resolveP01UserWordsViewConfig({
      mode: 'enforce', allowlist: ['session-a', 'session-b'],
    })).toThrow(/exactly one allowlisted Session/u)
    expect(() => resolveP01UserWordsViewConfig({
      mode: 'enforce', allowlist: ['session-*'],
    })).toThrow(/without wildcards/u)
    expect(() => resolveP01UserWordsViewConfig({
      mode: 'enforce', allowlist: ['session-exact'], fallback: true,
    })).toThrow(/exactly one allowlisted Session/u)
  })

  it('returns an empty view when no saved user message is missing from the ordinary surface', () => {
    const session = Session.create(SessionId('p01-empty'))
    appendUser(session, '仍在普通 surface 的旧消息。')
    appendUser(session, '当前消息。')

    expect(buildView({
      events: session.events,
      surfaceNodes: session.surface.nodes,
    })).toBe('')
  })

  it('excludes the current message so the final ordinary request can contain it exactly once', () => {
    const session = Session.create(SessionId('p01-current-once'))
    const oldText = '较早且已经缺失的用户原话。'
    const currentText = '本轮当前消息。'
    const oldSeq = appendUser(session, oldText)
    const currentSeq = appendUser(session, currentText)

    const view = buildView({
      events: session.events,
      surfaceNodes: [currentSeq],
    })
    expectRecord(view, oldSeq, oldText)
    expect(view).not.toContain(currentText)
  })

  it('keeps two unrelated old user messages together and restores chronological order', () => {
    const session = Session.create(SessionId('p01-unrelated'))
    const first = '明早给薄荷浇水。'
    const second = '项目代号是银杏。'
    const firstSeq = appendUser(session, first)
    const secondSeq = appendUser(session, second)

    const view = buildView({ events: session.events, surfaceNodes: [] })
    expectRecord(view, firstSeq, first)
    expectRecord(view, secondSeq, second)
    expect(view.indexOf(first)).toBeLessThan(view.indexOf(second))
  })

  it('keeps one mixed-topic message as one complete opaque record', () => {
    const session = Session.create(SessionId('p01-mixed'))
    const mixed = '明早给薄荷浇水；项目代号是银杏；逐字保留 {{unknown_prompt_variable}}。'
    const seq = appendUser(session, mixed)

    const view = buildView({ events: session.events, surfaceNodes: [] })
    expectRecord(view, seq, mixed)
    expect(view.split(mixed).length - 1).toBe(1)
  })

  it('excludes assistant, tool, and plugin carriers without guessing from their text', () => {
    const session = Session.create(SessionId('p01-carriers'))
    const direct = '这条才是真实用户原话。'
    const directSeq = appendUser(session, direct)
    appendAssistant(session, '助手声称这是用户原话。')
    appendToolResult(session, '工具 carrier 声称这是用户原话。')
    appendCarrier(session, '插件 carrier 声称这是用户原话。')

    const view = buildView({ events: session.events, surfaceNodes: [] })
    expectRecord(view, directSeq, direct)
    expect(view).not.toContain('助手声称')
    expect(view).not.toContain('工具 carrier')
    expect(view).not.toContain('插件 carrier')
  })

  it('counts the complete rendered JS string within 4096 chars and omits an entire older record', () => {
    const session = Session.create(SessionId('p01-budget'))
    const older = `OLDER-BEGIN-${'甲'.repeat(3_800)}-OLDER-END`
    const newer = `NEWER-BEGIN-${'乙'.repeat(500)}-NEWER-END`
    appendUser(session, older)
    const newerSeq = appendUser(session, newer)

    const view = buildView({ events: session.events, surfaceNodes: [] })
    expect(view.length).toBeLessThanOrEqual(P01_USER_WORDS_VIEW_MAX_CHARS)
    expect(view).toMatch(/非穷尽|non-exhaustive/i)
    expectRecord(view, newerSeq, newer)
    expect(view).not.toContain('OLDER-BEGIN')
    expect(view).not.toContain('OLDER-END')
    expect(view).not.toContain('甲')
  })

  it('fails closed to no view on duplicate message ids', () => {
    const session = Session.create(SessionId('p01-duplicate-id'))
    const duplicated = createUserMessage({
      content: [{ type: 'text', text: '重复身份原话。' }],
      source: { kind: 'user' },
    })
    appendUser(session, 'ignored', duplicated)
    appendUser(session, 'ignored', duplicated)

    expect(buildView({ events: session.events, surfaceNodes: [] })).toBe('')
  })

  it('fails closed to no view when one message id has ambiguous user/plugin sources', () => {
    const session = Session.create(SessionId('p01-source-ambiguity'))
    const direct = createUserMessage({
      content: [{ type: 'text', text: '来源歧义原话。' }],
      source: { kind: 'user' },
    })
    appendUser(session, 'ignored', direct)
    appendCarrier(session, 'ignored', {
      ...direct,
      source: { kind: 'plugin', plugin: 'p01-ambiguous-source' },
    })

    expect(buildView({ events: session.events, surfaceNodes: [] })).toBe('')
  })

  it('fails closed to no view when a candidate user message is not pure text', () => {
    const session = Session.create(SessionId('p01-non-text'))
    const nonText = createUserMessage({
      content: [{ type: 'reasoning', text: '公开 ContentBlock 类型中的非纯文本内容。' }],
      source: { kind: 'user' },
    })
    session.append('user/message', nonText, { surfaceOp: 'append' })

    expect(buildView({ events: session.events, surfaceNodes: [] })).toBe('')
  })

  it('fails closed to no view on an empty message id', () => {
    const session = Session.create(SessionId('p01-empty-id'))
    const emptyIdentity: UserMessage = freezeMessage({
      id: MessageId(''),
      role: 'user',
      content: [{ type: 'text', text: '身份为空的原话。' }],
      source: { kind: 'user' },
    })
    session.append('user/message', emptyIdentity, { surfaceOp: 'append' })

    expect(buildView({ events: session.events, surfaceNodes: [] })).toBe('')
  })

  it('renders byte-for-byte identically from a detached cold replay of the same event log', () => {
    const session = Session.create(SessionId('p01-cold-replay'))
    appendUser(session, '冷启动前的第一条原话。')
    const currentSeq = appendUser(session, '仍在 surface 的当前消息。')
    const request = { events: session.events, surfaceNodes: [currentSeq] }
    const live = buildView(request)
    const detachedEvents = structuredClone(session.events)
    const cold = buildView({ ...request, events: detachedEvents })

    expect(cold).toBe(live)
  })
})
