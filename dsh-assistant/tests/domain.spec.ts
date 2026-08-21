/**
 * Tests for the pure domain layer (src/domain.ts): field bounds, the
 * update-action state machine, visible-text renderers, and the worker
 * result-protocol parser.
 */

import { describe, expect, it } from 'vitest'
import {
  addMinutes,
  boundedPartial,
  formatLocalTime,
  isOpenStatus,
  lastNonEmptyLine,
  parseWorkerResult,
  renderBlockedDelivery,
  renderCompletedDelivery,
  renderDelegateAccepted,
  renderMissedReminderText,
  renderReminderText,
  renderTrackAccepted,
  stripProtocolLine,
  validateCheckInMinutes,
  validateMonitorCheckpoint,
  validateMonitorDirection,
  validateMonitorEventKey,
  MONITOR_EVENT_KEY_MAX_BYTES,
  validateResponsibilityKind,
  validateTitle,
  validateUpdate,
  WORKER_RESULT_PREFIX,
} from '../src/domain.ts'

const now = () => Date.parse('2026-08-15T02:00:00.000Z')

describe('field bounds', () => {
  it('keeps focus user-owned and delegated/monitor agent-owned', () => {
    expect(validateResponsibilityKind('focus', 'user')).toEqual({ ok: true })
    expect(validateResponsibilityKind('delegated', 'agent')).toEqual({ ok: true })
    expect(validateResponsibilityKind('monitor', 'agent')).toEqual({ ok: true })
    expect(validateResponsibilityKind('focus', 'agent')).toEqual({
      ok: false,
      message: 'focus responsibilities must be user-owned.',
    })
    expect(validateResponsibilityKind('monitor', 'user')).toEqual({
      ok: false,
      message: 'delegated and monitor responsibilities must be agent-owned.',
    })
  })

  it('accepts a trimmed 1-500 char title', () => {
    expect(validateTitle(' 整理书桌 ')).toBeUndefined()
    expect(validateTitle('a'.repeat(500))).toBeUndefined()
  })

  it('rejects empty, non-string, and >500 char titles', () => {
    expect(validateTitle('')).toBeTruthy()
    expect(validateTitle('   ')).toBeTruthy()
    expect(validateTitle(42)).toBeTruthy()
    expect(validateTitle('a'.repeat(501))).toBeTruthy()
  })

  it('validates checkInMinutes as a positive safe integer in [1, 10080]', () => {
    expect(validateCheckInMinutes(undefined)).toBeUndefined()
    expect(validateCheckInMinutes(1)).toBeUndefined()
    expect(validateCheckInMinutes(10080)).toBeUndefined()
    expect(validateCheckInMinutes(0)).toBeTruthy()
    expect(validateCheckInMinutes(-5)).toBeTruthy()
    expect(validateCheckInMinutes(10081)).toBeTruthy()
    expect(validateCheckInMinutes(1.5)).toBeTruthy()
    expect(validateCheckInMinutes('5')).toBeTruthy()
  })

  it('bounds long free text and partial output', () => {
    expect(boundedPartial('x'.repeat(5000), 1000)).toHaveLength(1000)
    expect(boundedPartial('short')).toBe('short')
  })

  it('bounds opaque monitor direction/checkpoint and event keys without hashing them', () => {
    expect(validateMonitorDirection('{"scope":"repo"}')).toBeUndefined()
    expect(validateMonitorCheckpoint('{"cursor":1}')).toBeUndefined()
    expect(validateMonitorDirection('')).toContain('must not be empty')
    expect(validateMonitorCheckpoint('\u0000')).toContain('NUL')
    expect(validateMonitorEventKey('stable-cursor:v1')).toBeUndefined()
    expect(validateMonitorEventKey(`x`.repeat(MONITOR_EVENT_KEY_MAX_BYTES + 1))).toContain('UTF-8 bytes')
    expect(validateMonitorEventKey('x\u0000y')).toContain('NUL')
  })
})

describe('open statuses', () => {
  it('pending/active/paused/blocked remain open; completed/cancelled are terminal', () => {
    for (const s of ['pending', 'active', 'paused', 'blocked'] as const) {
      expect(isOpenStatus(s)).toBe(true)
    }
    expect(isOpenStatus('completed')).toBe(false)
    expect(isOpenStatus('cancelled')).toBe(false)
  })
})

describe('worker result protocol', () => {
  it('parses a valid completed settlement and strips the protocol line', () => {
    const text = '完成情况说明。\nDSH_ASSISTANT_RESULT {"status":"completed","summary":"已读完目录","evidence":["12 个目录"]}'
    const parsed = parseWorkerResult(text)
    expect(parsed.kind).toBe('settlement')
    if (parsed.kind !== 'settlement') throw new Error('expected settlement')
    expect(parsed.settlement).toEqual({
      status: 'completed',
      summary: '已读完目录',
      evidence: ['12 个目录'],
    })
    expect(parsed.body).toBe('完成情况说明。')
  })

  it('parses a valid blocked settlement with nextAction', () => {
    const text = '做到一半。\nDSH_ASSISTANT_RESULT {"status":"blocked","summary":"已做到 A","blocker":"缺少权限","nextAction":"需要用户授权"}'
    const parsed = parseWorkerResult(text)
    expect(parsed.kind).toBe('settlement')
    if (parsed.kind !== 'settlement') throw new Error('expected settlement')
    expect(parsed.settlement).toEqual({
      status: 'blocked',
      summary: '已做到 A',
      blocker: '缺少权限',
      nextAction: '需要用户授权',
    })
  })

  it('accepts a marker on its own final line with no blank separator', () => {
    const text = '正文最后一行没有空行。\nDSH_ASSISTANT_RESULT {"status":"completed","summary":"ok"}'
    const parsed = parseWorkerResult(text)
    expect(parsed.kind).toBe('settlement')
    if (parsed.kind !== 'settlement') throw new Error('expected settlement')
    expect(parsed.body).toBe('正文最后一行没有空行。')
  })

  it('marks missing marker, bad JSON, unknown status, and missing fields invalid', () => {
    const cases: Array<{ text: string; reason: string }> = [
      { text: 'plain text without marker', reason: 'missing DSH_ASSISTANT_RESULT marker' },
      { text: 'DSH_ASSISTANT_RESULT {not json}', reason: 'not valid JSON' },
      { text: 'DSH_ASSISTANT_RESULT []', reason: 'must be a JSON object' },
      { text: 'DSH_ASSISTANT_RESULT {"status":"done","summary":"x"}', reason: 'unknown protocol status' },
      { text: 'DSH_ASSISTANT_RESULT {"status":"completed"}', reason: 'non-empty summary' },
      { text: 'DSH_ASSISTANT_RESULT {"status":"blocked","summary":"s"}', reason: 'non-empty blocker' },
      { text: 'DSH_ASSISTANT_RESULT {"status":"completed","summary":"s","evidence":["a",42]}', reason: 'array of strings' },
    ]
    for (const { text, reason } of cases) {
      const parsed = parseWorkerResult(text)
      expect(parsed.kind).toBe('invalid')
      if (parsed.kind !== 'invalid') throw new Error('expected invalid')
      expect(parsed.reason).toContain(reason)
    }
  })

  it('does not parse a marker in a middle line when a later line exists', () => {
    const text = 'DSH_ASSISTANT_RESULT {"status":"completed","summary":"fake"}\n真实结尾'
    const parsed = parseWorkerResult(text)
    expect(parsed.kind).toBe('invalid')
  })

  it('enforces monitor event fields when the commitment kind is supplied', () => {
    const delegated = parseWorkerResult('DSH_ASSISTANT_RESULT {"status":"completed","summary":"s","eventKey":"k","checkpoint":"c"}', 'delegated')
    expect(delegated).toMatchObject({ kind: 'invalid', reason: expect.stringContaining('delegated') })
    const monitor = parseWorkerResult('DSH_ASSISTANT_RESULT {"status":"completed","summary":"s"}', 'monitor')
    expect(monitor).toMatchObject({ kind: 'invalid', reason: expect.stringContaining('monitor') })
    const validMonitor = parseWorkerResult('DSH_ASSISTANT_RESULT {"status":"completed","summary":"s","eventKey":"k","checkpoint":"c"}', 'monitor')
    expect(validMonitor.kind).toBe('settlement')
  })

  it('preserves a protocol-looking line in the body when it is not the last line', () => {
    const text = 'DSH_ASSISTANT_RESULT {"status":"completed","summary":"fake"}\n真实结尾'
    expect(stripProtocolLine(text)).toBe('DSH_ASSISTANT_RESULT {"status":"completed","summary":"fake"}\n真实结尾')
  })

  it('exports a prefix that matches the protocol exactly', () => {
    expect(WORKER_RESULT_PREFIX).toBe('DSH_ASSISTANT_RESULT ')
    expect(lastNonEmptyLine('a\n\n  \nb')).toBe('b')
  })
})

describe('update-action state machine', () => {
  const base = { mode: 'telegram' as const, hasLiveWorker: false }

  it('pause: active only; web cannot pause agent commitments', () => {
    expect(validateUpdate({ ...base, action: 'pause', workOwner: 'user', status: 'active' }).ok).toBe(true)
    expect(validateUpdate({ ...base, action: 'pause', workOwner: 'user', status: 'paused' }).ok).toBe(false)
    expect(validateUpdate({ ...base, action: 'pause', workOwner: 'user', status: 'pending' }).ok).toBe(false)
    expect(validateUpdate({ ...base, action: 'pause', workOwner: 'user', status: 'blocked' }).ok).toBe(false)
    const webAgent = validateUpdate({ mode: 'web', action: 'pause', workOwner: 'agent', status: 'active' })
    expect(webAgent).toEqual({
      ok: false,
      code: 'wrong_control_surface',
      message: expect.any(String),
    })
    expect(validateUpdate({ ...base, action: 'pause', workOwner: 'agent', status: 'active' }).ok).toBe(true)
  })

  it('resume: paused/blocked only; web cannot resume agent commitments', () => {
    expect(validateUpdate({ ...base, action: 'resume', workOwner: 'user', status: 'paused' }).ok).toBe(true)
    expect(validateUpdate({ ...base, action: 'resume', workOwner: 'user', status: 'blocked' }).ok).toBe(true)
    expect(validateUpdate({ ...base, action: 'resume', workOwner: 'user', status: 'active' }).ok).toBe(false)
    expect(validateUpdate({ mode: 'web', action: 'resume', workOwner: 'agent', status: 'paused' })).toMatchObject({ ok: false, code: 'wrong_control_surface' })
  })

  it('still_working: user active only', () => {
    expect(validateUpdate({ ...base, action: 'still_working', workOwner: 'user', status: 'active' }).ok).toBe(true)
    expect(validateUpdate({ ...base, action: 'still_working', workOwner: 'user', status: 'paused' }).ok).toBe(false)
    expect(validateUpdate({ ...base, action: 'still_working', workOwner: 'agent', status: 'active' })).toMatchObject({ ok: false, code: 'wrong_work_owner' })
  })

  it('block: user-owned pending/active only; Agent work blocks through its worker contract', () => {
    expect(validateUpdate({ ...base, action: 'block', workOwner: 'user', status: 'pending' }).ok).toBe(true)
    expect(validateUpdate({ ...base, action: 'block', workOwner: 'user', status: 'active' }).ok).toBe(true)
    expect(validateUpdate({ ...base, action: 'block', workOwner: 'user', status: 'paused' }).ok).toBe(false)
    expect(validateUpdate({ ...base, action: 'block', workOwner: 'agent', status: 'active' })).toMatchObject({
      ok: false, code: 'wrong_work_owner',
    })
  })

  it('complete: user-owned open statuses only; agent-owned rejected with wrong_work_owner', () => {
    for (const s of ['pending', 'active', 'paused', 'blocked'] as const) {
      expect(validateUpdate({ ...base, action: 'complete', workOwner: 'user', status: s }).ok).toBe(true)
    }
    expect(validateUpdate({ ...base, action: 'complete', workOwner: 'user', status: 'completed' }).ok).toBe(false)
    const agent = validateUpdate({ ...base, action: 'complete', workOwner: 'agent', status: 'active' })
    expect(agent).toEqual({ ok: false, code: 'wrong_work_owner', message: expect.any(String) })
  })

  it('cancel: any open status; web cannot cancel agent commitments', () => {
    for (const s of ['pending', 'active', 'paused', 'blocked'] as const) {
      expect(validateUpdate({ ...base, action: 'cancel', workOwner: 'user', status: s }).ok).toBe(true)
      expect(validateUpdate({ ...base, action: 'cancel', workOwner: 'agent', status: s }).ok).toBe(true)
    }
    expect(validateUpdate({ ...base, action: 'cancel', workOwner: 'user', status: 'completed' }).ok).toBe(false)
    expect(validateUpdate({ mode: 'web', action: 'cancel', workOwner: 'agent', status: 'active' })).toMatchObject({ ok: false, code: 'wrong_control_surface' })
  })

  it('set_next_action: any open status, both owners', () => {
    for (const s of ['pending', 'active', 'paused', 'blocked'] as const) {
      expect(validateUpdate({ ...base, action: 'set_next_action', workOwner: 'user', status: s }).ok).toBe(true)
      expect(validateUpdate({ ...base, action: 'set_next_action', workOwner: 'agent', status: s }).ok).toBe(true)
    }
    expect(validateUpdate({ ...base, action: 'set_next_action', workOwner: 'user', status: 'completed' }).ok).toBe(false)
  })

  it('revise_monitor requires a Telegram Agent-owned monitor and a bounded direction', () => {
    const valid = {
      ...base,
      action: 'revise_monitor' as const,
      workOwner: 'agent' as const,
      kind: 'monitor' as const,
      status: 'active' as const,
      direction: 'watch-current',
    }
    expect(validateUpdate(valid)).toEqual({ ok: true })
    expect(validateUpdate({ ...valid, kind: 'delegated' })).toMatchObject({ ok: false, code: 'wrong_work_owner' })
    expect(validateUpdate({ ...valid, mode: 'web' })).toMatchObject({ ok: false, code: 'wrong_control_surface' })
    expect(validateUpdate({ ...valid, direction: '   ' })).toMatchObject({ ok: false, code: 'invalid_transition' })
    expect(validateUpdate({ ...valid, direction: 'x\u0000y' })).toMatchObject({ ok: false, code: 'invalid_transition' })
    expect(validateUpdate({ ...valid, direction: undefined })).toMatchObject({ ok: false, code: 'invalid_transition' })
  })
})

describe('time helpers', () => {
  it('addMinutes anchors on the ISO value, not the clock', () => {
    const result = addMinutes('2026-08-15T02:00:00.000Z', 2, now)
    expect(result).toBe('2026-08-15T02:02:00.000Z')
  })

  it('formatLocalTime renders local HH:MM', () => {
    expect(formatLocalTime('2026-08-15T02:00:00.000Z')).toMatch(/^\d{2}:\d{2}$/)
  })
})

describe('visible text renderers', () => {
  it('renders the tracked acceptance with follow-up time', () => {
    const text = renderTrackAccepted({ title: '整理书桌', nextContactAt: '2026-08-15T02:02:00.000Z' })
    expect(text).toContain('- [ ] 整理书桌')
    expect(text).toContain('事情由你做，跟进由我负责。')
    expect(text).toContain('状态：进行中')
    expect(text).toContain('我会在')
    expect(text).not.toContain('我来做')
  })

  it('renders the delegated acceptance', () => {
    const text = renderDelegateAccepted({ title: '查资料' })
    expect(text).toContain('- [ ] 查资料')
    expect(text).toContain('归属：我来做')
    expect(text).toContain('我已经接下这件事；完成或受阻时会主动告诉你。')
  })

  it('renders ordinary and missed reminders', () => {
    expect(renderReminderText('整理书桌')).toContain('⏰ 到时间了：整理书桌')
    expect(renderReminderText('整理书桌')).toContain('还在做、先休息，还是已经完成？')
    expect(renderMissedReminderText('整理书桌')).toContain('⏰ 我在离线期间错过了这次跟进：整理书桌')
  })

  it('renders completed and blocked deliveries', () => {
    const done = renderCompletedDelivery('查资料', '结果正文')
    expect(done).toContain('✅ 我负责的事情已完成：查资料')
    expect(done).toContain('结果正文')
    const blocked = renderBlockedDelivery({ title: '查资料', summary: '已到 A', blocker: '缺权限', nextAction: '用户授权' })
    expect(blocked).toContain('⚠️ 我负责的事情受阻：查资料')
    expect(blocked).toContain('已经做到：已到 A')
    expect(blocked).toContain('阻断：缺权限')
    expect(blocked).toContain('下一步需要：用户授权')
  })

  it('omits nextAction from blocked delivery when absent', () => {
    const blocked = renderBlockedDelivery({ title: 't', summary: 's', blocker: 'b' })
    expect(blocked).not.toContain('下一步需要')
  })
})
