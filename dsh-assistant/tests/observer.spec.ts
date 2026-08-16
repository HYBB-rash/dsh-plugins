import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { AssistantStore } from '../src/store.ts'
import { WebTaskObserver, queryWebTasks } from '../src/observer.ts'

const dirs: string[] = []
function path(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-assistant-observer-'))
  dirs.push(dir)
  return join(dir, 'state.sqlite')
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function session(id: string, cwd = '/work'): { id: string; header: { cwd: string } } {
  return { id: SessionId(id), header: { cwd } }
}

describe('Web task observation', () => {
  it('projects direct request, latest assistant conclusion, and turn result for multiple sessions', () => {
    const store = new AssistantStore(path())
    let now = Date.parse('2026-08-16T03:00:00.000Z')
    const observer = new WebTaskObserver(store, { writerInstanceId: 'writer-1', writerStartedAt: new Date(now).toISOString(), now: () => now })
    const one = session('web-one')
    observer.handle(one as never, { type: 'turn/start', data: { turn: 7 } } as never)
    observer.handle(one as never, {
      type: 'user/message', data: { id: MessageId('u1'), role: 'user', content: [{ type: 'text', text: '修好测试' }], source: { kind: 'user' } },
    } as never)
    observer.handle(one as never, {
      type: 'assistant/message', data: { turn: 7, step: 1, message: { id: MessageId('a1'), role: 'assistant', content: [{ type: 'text', text: '已修好，测试 10/10。' }], source: { kind: 'model' } } },
    } as never)
    observer.handle(one as never, { type: 'turn/end', data: { turn: 7, reason: { kind: 'completed' } } } as never)
    now += 1000
    const two = session('web-two', '/other')
    observer.handle(two as never, { type: 'turn/start', data: { turn: 1 } } as never)
    expect(store.getWebObservation('web-one')).toMatchObject({
      state: 'ended', turn: 7, requestText: '修好测试', lastAssistantText: '已修好，测试 10/10。',
      lastAssistantMessageId: 'a1', turnReason: 'completed', writerInstanceId: 'writer-1', cwd: '/work',
    })
    expect(store.getWebObservation('web-two')).toMatchObject({ state: 'running', turn: 1, cwd: '/other' })
    observer.dispose()
    expect(store.getWebObservation('web-two')?.state).toBe('interrupted')
    expect(store.getWebObservation('web-one')?.state).toBe('ended')
    store.close()
  })

  it('a newer writer takes over on a real turn/start; late old events and dispose cannot overwrite it', () => {
    const store = new AssistantStore(path())
    const started = '2026-08-16T03:00:00.000Z'
    const first = new WebTaskObserver(store, { writerInstanceId: 'old', writerStartedAt: started, now: () => Date.parse(started) })
    first.handle(session('same') as never, { type: 'turn/start', data: { turn: 1 } } as never)
    const second = new WebTaskObserver(store, {
      writerInstanceId: 'new', writerStartedAt: '2026-08-16T04:00:00.000Z', now: () => Date.parse('2026-08-16T04:00:00.000Z'),
    })
    second.handle(session('same') as never, { type: 'turn/start', data: { turn: 2 } } as never)
    expect(store.getWebObservation('same')).toMatchObject({ writerInstanceId: 'new', turn: 2, state: 'running' })
    first.handle(session('same') as never, {
      type: 'assistant/message', data: { turn: 1, step: 9, message: { id: MessageId('late-old'), role: 'assistant', content: [{ type: 'text', text: '旧 writer 迟到' }] } },
    } as never)
    first.dispose()
    expect(store.getWebObservation('same')).toMatchObject({
      writerInstanceId: 'new', turn: 2, state: 'running', lastAssistantText: null,
    })
    const result = queryWebTasks(store, {}, Date.parse('2026-08-16T05:00:00.000Z'), 60_000)
    expect(result.selected).toMatchObject({ state: 'running', assistantConclusion: null })
    expect(result.selected?.evidence.join('\n')).toContain('无法确认正常或卡住')
    expect(result.selected?.evidence.join('\n')).not.toContain('已经挂掉')
    store.close()
  })
})
