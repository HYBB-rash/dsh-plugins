import { describe, expect, it, vi } from 'vitest'
import {
  MAX_SELECTION_INPUT_CHARS,
  selectAttention,
  validateSelectionInput,
  type PersonalFeedSelectionInput,
  type SemanticJudge,
} from '../src/core.ts'

const validInput: PersonalFeedSelectionInput = {
  personalContext: {
    longTermInterests: 'Agent systems and reliable delivery boundaries',
    existingUnderstanding: 'I already know that prompts alone cannot enforce transactional guarantees.',
  },
  candidates: [
    { url: 'https://x.com/example/status/100', content: 'A new study compares recovery semantics across agent runtimes.' },
    { url: 'https://twitter.com/example/status/200', content: 'A generic productivity slogan.' },
  ],
}

describe('strict input validation', () => {
  it.each([
    [{ ...validInput, surprise: true }],
    [{ ...validInput, personalContext: { ...validInput.personalContext, surprise: true } }],
    [{ ...validInput, candidates: [{ ...validInput.candidates[0]!, surprise: true }] }],
    [{ ...validInput, personalContext: { ...validInput.personalContext, longTermInterests: ' ' } }],
    [{ ...validInput, personalContext: { ...validInput.personalContext, existingUnderstanding: '' } }],
    [{ ...validInput, candidates: [{ url: 'http://x.com/example/status/1', content: 'content' }] }],
    [{ ...validInput, candidates: [{ url: 'https://example.com/status/1', content: 'content' }] }],
    [{ ...validInput, candidates: [{ url: 'https://x.com/example/status/1', content: '' }] }],
  ])('rejects an invalid value before semantic judgment', value => {
    expect(validateSelectionInput(value)).toEqual({ status: 'failed', code: 'invalid_input' })
  })

  it('rejects an oversized request distinctly', () => {
    const value = {
      ...validInput,
      candidates: [{ url: 'https://x.com/example/status/1', content: 'x'.repeat(MAX_SELECTION_INPUT_CHARS) }],
    }
    expect(validateSelectionInput(value)).toEqual({ status: 'failed', code: 'input_too_large' })
  })
})

describe('selection use case', () => {
  it('returns completed empty without calling the model when candidates are empty', async () => {
    const judge: SemanticJudge = { judge: vi.fn() }
    await expect(selectAttention({ ...validInput, candidates: [] }, judge, new AbortController().signal))
      .resolves.toEqual({ status: 'completed', outcome: { kind: 'empty' } })
    expect(judge.judge).not.toHaveBeenCalled()
  })

  it('maps a selected index to the exact caller-supplied URL', async () => {
    const judge: SemanticJudge = {
      judge: vi.fn(async () => ({ status: 'completed', decision: { kind: 'selected', candidateIndex: 0 } })),
    }
    await expect(selectAttention(validInput, judge, new AbortController().signal)).resolves.toEqual({
      status: 'completed',
      outcome: { kind: 'selected', url: 'https://x.com/example/status/100' },
    })
  })

  it('preserves a genuine semantic empty result', async () => {
    const judge: SemanticJudge = {
      judge: vi.fn(async () => ({ status: 'completed', decision: { kind: 'empty' } })),
    }
    await expect(selectAttention(validInput, judge, new AbortController().signal)).resolves.toEqual({
      status: 'completed', outcome: { kind: 'empty' },
    })
  })

  it('never disguises a model failure as empty', async () => {
    const judge: SemanticJudge = {
      judge: vi.fn(async () => ({ status: 'failed', code: 'model_call_failed' })),
    }
    await expect(selectAttention(validInput, judge, new AbortController().signal)).resolves.toEqual({
      status: 'failed', code: 'model_call_failed',
    })
  })

  it('contains an unexpected judge exception as a model-call failure', async () => {
    const judge: SemanticJudge = {
      judge: vi.fn(async () => { throw new Error('adapter escaped its contract') }),
    }
    await expect(selectAttention(validInput, judge, new AbortController().signal)).resolves.toEqual({
      status: 'failed', code: 'model_call_failed',
    })
  })

  it('rejects an out-of-range model index instead of accepting a fabricated URL', async () => {
    const judge: SemanticJudge = {
      judge: vi.fn(async () => ({ status: 'completed', decision: { kind: 'selected', candidateIndex: 99 } })),
    }
    await expect(selectAttention(validInput, judge, new AbortController().signal)).resolves.toEqual({
      status: 'failed', code: 'invalid_model_output',
    })
  })
})
