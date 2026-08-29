import { describe, expect, it, vi } from 'vitest'
import { createDshSemanticJudge, selectionSystemPrompt } from '../src/dsh-semantic-judge.ts'
import type { PersonalFeedSelectionInput } from '../src/core.ts'

const input: PersonalFeedSelectionInput = {
  personalContext: { longTermInterests: 'reliable agents', existingUnderstanding: 'I know basic retry patterns.' },
  candidates: [{ url: 'https://x.com/a/status/1', content: 'A new recovery protocol.' }],
}

function chunks(text: string, finish: 'stop' | 'tool-calls' | 'max-tokens' | 'aborted' | 'error' = 'stop') {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: finish } },
  ]
}

function fixture(output: readonly object[] = chunks('{"kind":"selected","candidateIndex":0}')) {
  const stream = vi.fn(async function* () { for (const chunk of output) yield chunk })
  const agent = {
    session: { id: 'root-session', requestHeader: () => ({ config: { provider: 'provider-a', model: 'model-a' } }) },
    options: {},
  }
  return { stream, agent, judge: createDshSemanticJudge({ llm: { stream } } as never, agent as never, { timeoutMs: 30_000 }) }
}

describe('DSH semantic judge', () => {
  it('makes one isolated deterministic request using the root model route', async () => {
    const { stream, judge } = fixture()
    await expect(judge.judge(input, new AbortController().signal)).resolves.toEqual({
      status: 'completed', decision: { kind: 'selected', candidateIndex: 0 },
    })
    expect(stream).toHaveBeenCalledTimes(1)
    const options = stream.mock.calls[0]![0]
    expect(options).toMatchObject({ provider: 'provider-a', model: 'model-a', temperature: 0, maxTokens: 64 })
    expect(options.sessionId).not.toBe('root-session')
    expect(options.messages).toHaveLength(1)
    expect(options.system).toBe(selectionSystemPrompt())
    expect(JSON.stringify(options.messages)).toContain('reliable agents')
    expect(JSON.stringify(options.messages)).toContain('A new recovery protocol.')
    expect(options.system).toContain('untrusted')
  })

  it.each([
    ['```json\n{"kind":"empty"}\n```'],
    ['{"kind":"empty"}\nextra'],
    ['{"kind":"selected","candidateIndex":0,"url":"https://evil.example"}'],
    ['{"kind":"selected","candidateIndex":0.5}'],
    ['{"kind":"selected","candidateIndex":-1}'],
    [''],
  ])('rejects non-exact output: %s', async text => {
    const { judge } = fixture(chunks(text))
    await expect(judge.judge(input, new AbortController().signal)).resolves.toEqual({
      status: 'failed', code: 'invalid_model_output',
    })
  })

  it('rejects tool-call termination', async () => {
    const { judge } = fixture(chunks('', 'tool-calls'))
    await expect(judge.judge(input, new AbortController().signal)).resolves.toEqual({
      status: 'failed', code: 'invalid_model_output',
    })
  })

  it('reports a missing model route', async () => {
    const stream = vi.fn()
    const judge = createDshSemanticJudge({ llm: { stream } } as never, {
      session: { id: 'root', requestHeader: () => undefined }, options: {},
    } as never)
    await expect(judge.judge(input, new AbortController().signal)).resolves.toEqual({
      status: 'failed', code: 'model_route_unavailable',
    })
    expect(stream).not.toHaveBeenCalled()
  })

  it('reports caller abort separately', async () => {
    const controller = new AbortController()
    controller.abort()
    const { judge } = fixture()
    await expect(judge.judge(input, controller.signal)).resolves.toEqual({ status: 'failed', code: 'aborted' })
  })

  it('reports a stream exception as model-call failure', async () => {
    const stream = vi.fn(async function* () { throw new Error('provider unavailable') })
    const agent = {
      session: { id: 'root', requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) }, options: {},
    }
    const judge = createDshSemanticJudge({ llm: { stream } } as never, agent as never)
    await expect(judge.judge(input, new AbortController().signal)).resolves.toEqual({
      status: 'failed', code: 'model_call_failed',
    })
  })

  it('reports timeout separately when the adapter observes the request signal', async () => {
    const stream = vi.fn(async function* (options: { signal: AbortSignal }) {
      await new Promise<void>((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    const agent = {
      session: { id: 'root', requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) }, options: {},
    }
    const judge = createDshSemanticJudge({ llm: { stream } } as never, agent as never, { timeoutMs: 1 })
    await expect(judge.judge(input, new AbortController().signal)).resolves.toEqual({
      status: 'failed', code: 'timeout',
    })
  })
})
