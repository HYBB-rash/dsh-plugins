import { describe, expect, it } from 'vitest'
import {
  COMPOSER_SUMMARY_MAX_UTF8_BYTES,
  COMPOSER_TITLE_MAX_UTF8_BYTES,
  parseComposerDto,
  parsePlannerDto,
  validateComposerDto,
  validatePlannerDto,
} from '../src/x-cron/two-call-contract.ts'

const plannerContext = {
  candidateIds: ['candidate-1', 'candidate-2'],
  allowedTopicIds: ['agentic-systems', 'robotics'],
} as const

const composerContext = {
  itemIds: ['item-1', 'item-2', 'item-3', 'item-4', 'item-5'],
} as const

function planner(exploration: unknown = { kind: 'none' }): Record<string, unknown> {
  return {
    selectedCandidateIds: ['candidate-1'],
    themeId: 'agentic-systems',
    exploration,
  }
}

function composer(): Record<string, unknown> {
  return {
    title: '本轮 X 洞察',
    sections: [{ kind: 'highlight', items: [{ itemId: 'item-1', summary: '一条可核验的摘要' }] }],
  }
}

describe('X cron two-call strict DTO contract', () => {
  it('accepts a valid planner DTO against the current-run allowlists', () => {
    const result = parsePlannerDto(JSON.stringify({
      selectedCandidateIds: ['candidate-1', 'candidate-2'],
      themeId: 'agentic-systems',
      exploration: { kind: 'search', topicId: 'robotics' },
    }), {
      candidateIds: ['candidate-1', 'candidate-2'],
      allowedTopicIds: ['agentic-systems', 'robotics'],
    })

    expect(result).toMatchObject({
      ok: true,
      value: {
        selectedCandidateIds: ['candidate-1', 'candidate-2'],
        themeId: 'agentic-systems',
        exploration: { kind: 'search', topicId: 'robotics' },
      },
    })
  })

  it('rejects missing and unknown top-level or nested keys', () => {
    const missingPlanner = { selectedCandidateIds: ['candidate-1'], themeId: 'agentic-systems' }
    expect(validatePlannerDto(missingPlanner, plannerContext)).toMatchObject({ ok: false, code: 'missing-key' })
    expect(validatePlannerDto({ ...planner(), internal: 'leak' }, plannerContext)).toMatchObject({ ok: false, code: 'unknown-key' })
    expect(validatePlannerDto(planner({ kind: 'none', topicId: 'robotics' }), plannerContext)).toMatchObject({ ok: false, code: 'invalid-exploration' })

    const missingComposer = { title: '标题' }
    expect(validateComposerDto(missingComposer, composerContext)).toMatchObject({ ok: false, code: 'missing-key' })
    expect(validateComposerDto({ ...composer(), internal: 'leak' }, composerContext)).toMatchObject({ ok: false, code: 'unknown-key' })
    expect(validateComposerDto({ ...composer(), sections: [{ kind: 'highlight', items: [{ itemId: 'item-1' }] }] }, composerContext))
      .toMatchObject({ ok: false, code: 'invalid-item' })
    expect(validateComposerDto({ ...composer(), sections: [{ kind: 'highlight', items: [{ itemId: 'item-1', summary: '摘要', extra: true }] }] }, composerContext))
      .toMatchObject({ ok: false, code: 'invalid-item' })
  })

  it('enforces selected candidate uniqueness, non-emptiness, limit, and allowlist', () => {
    expect(validatePlannerDto({ ...planner(), selectedCandidateIds: [] }, plannerContext))
      .toMatchObject({ ok: false, code: 'selected-candidates-empty' })
    expect(validatePlannerDto({ ...planner(), selectedCandidateIds: ['candidate-1', 'candidate-1'] }, plannerContext))
      .toMatchObject({ ok: false, code: 'duplicate-selected-candidate-id' })
    expect(validatePlannerDto({ ...planner(), selectedCandidateIds: ['candidate-unknown'] }, plannerContext))
      .toMatchObject({ ok: false, code: 'unknown-selected-candidate-id' })
    expect(validatePlannerDto({ ...planner(), selectedCandidateIds: Array.from({ length: 21 }, (_, index) => `candidate-${index}`) }, {
      candidateIds: Array.from({ length: 21 }, (_, index) => `candidate-${index}`),
      allowedTopicIds: plannerContext.allowedTopicIds,
    })).toMatchObject({ ok: false, code: 'selected-candidates-limit' })
    expect(validatePlannerDto({ ...planner(), themeId: 'outside' }, plannerContext))
      .toMatchObject({ ok: false, code: 'unknown-theme-id' })
  })

  it('accepts each exploration branch and rejects overreach or mixed fields', () => {
    expect(validatePlannerDto(planner({ kind: 'none' }), plannerContext)).toMatchObject({ ok: true })
    expect(validatePlannerDto(planner({ kind: 'search', topicId: 'robotics' }), plannerContext)).toMatchObject({ ok: true })
    expect(validatePlannerDto(planner({ kind: 'explore', candidateId: 'candidate-2' }), plannerContext)).toMatchObject({ ok: true })
    expect(validatePlannerDto(planner({ kind: 'search', topicId: 'outside' }), plannerContext))
      .toMatchObject({ ok: false, code: 'unknown-exploration-topic' })
    expect(validatePlannerDto(planner({ kind: 'explore', candidateId: 'outside' }), plannerContext))
      .toMatchObject({ ok: false, code: 'unknown-exploration-candidate' })
    expect(validatePlannerDto(planner({ kind: 'search', topicId: 'robotics', candidateId: 'candidate-1' }), plannerContext))
      .toMatchObject({ ok: false, code: 'invalid-exploration' })
    expect(validatePlannerDto(planner({ kind: 'explore', candidateId: 'candidate-1', topicId: 'robotics' }), plannerContext))
      .toMatchObject({ ok: false, code: 'invalid-exploration' })
    expect(parsePlannerDto('{"selectedCandidateIds":', plannerContext)).toMatchObject({ ok: false, code: 'invalid-json' })
    expect(parsePlannerDto('{"secret":"do-not-repeat"}', plannerContext)).toMatchObject({ ok: false, code: 'missing-key' })
    const parseFailure = parsePlannerDto('{"secret":"do-not-repeat"}', plannerContext)
    if (!parseFailure.ok) expect(parseFailure.message).not.toContain('do-not-repeat')
  })

  it('accepts the fixed composer kinds and rejects URL, Markdown, unknown IDs, duplicates, and oversize text', () => {
    const allKinds = ['highlight', 'timeline', 'wander', 'focus', 'source'].map((kind, index) => ({
      kind,
      items: [{ itemId: `item-${index + 1}`, summary: `摘要 ${index + 1}` }],
    }))
    expect(validateComposerDto({ title: '本轮洞察', sections: allKinds }, composerContext)).toMatchObject({ ok: true })
    expect(parseComposerDto(JSON.stringify({ title: '本轮洞察', sections: allKinds }), composerContext)).toMatchObject({ ok: true })
    expect(validateComposerDto({ ...composer(), sections: [{ kind: 'unknown', items: [] }] }, composerContext))
      .toMatchObject({ ok: false, code: 'unknown-section-kind' })
    expect(validateComposerDto({ ...composer(), sections: [
      { kind: 'highlight', items: [{ itemId: 'item-1', summary: '摘要' }] },
      { kind: 'highlight', items: [] },
    ] }, composerContext)).toMatchObject({ ok: false, code: 'duplicate-section-kind' })
    expect(validateComposerDto({ ...composer(), sections: [{ kind: 'highlight', items: [{ itemId: 'outside', summary: '摘要' }] }] }, composerContext))
      .toMatchObject({ ok: false, code: 'unknown-item-id' })
    expect(validateComposerDto({ ...composer(), sections: [{ kind: 'highlight', items: [
      { itemId: 'item-1', summary: '摘要' },
      { itemId: 'item-1', summary: '重复' },
    ] }] }, composerContext)).toMatchObject({ ok: false, code: 'duplicate-item-id' })
    expect(validateComposerDto({ ...composer(), sections: [{ kind: 'highlight', items: [{ itemId: 'item-1', summary: '含 URL https://x.com/1' }] }] }, composerContext))
      .toMatchObject({ ok: false, code: 'forbidden-composer-content' })
    expect(validateComposerDto({ ...composer(), sections: [{ kind: 'highlight', items: [{ itemId: 'item-1', summary: '[链接](https://x.com/1)' }] }] }, composerContext))
      .toMatchObject({ ok: false, code: 'forbidden-composer-content' })
    expect(validateComposerDto({ ...composer(), title: '中'.repeat(COMPOSER_TITLE_MAX_UTF8_BYTES) }, composerContext))
      .toMatchObject({ ok: false, code: 'composer-title-too-large' })
    expect(validateComposerDto({ ...composer(), sections: [{ kind: 'highlight', items: [{ itemId: 'item-1', summary: '中'.repeat(COMPOSER_SUMMARY_MAX_UTF8_BYTES) }] }] }, composerContext))
      .toMatchObject({ ok: false, code: 'summary-too-large' })
  })

  it('requires at least one section and at least one item in every present section', () => {
    expect(validateComposerDto({ title: '本轮洞察', sections: [] }, composerContext))
      .toMatchObject({ ok: false, code: 'empty-sections' })
    expect(validateComposerDto({ ...composer(), sections: [{ kind: 'highlight', items: [] }] }, composerContext))
      .toMatchObject({ ok: false, code: 'empty-items' })
  })

  it('does not mutate input and freezes every successful output layer', () => {
    const input = planner({ kind: 'search', topicId: 'robotics' })
    const before = structuredClone(input)
    const result = validatePlannerDto(input, plannerContext)
    expect(input).toEqual(before)
    expect(result).toMatchObject({ ok: true })
    if (result.ok) {
      expect(Object.isFrozen(result)).toBe(true)
      expect(Object.isFrozen(result.value)).toBe(true)
      expect(Object.isFrozen(result.value.selectedCandidateIds)).toBe(true)
      expect(Object.isFrozen(result.value.exploration)).toBe(true)
      expect(result.value.selectedCandidateIds).not.toBe(input.selectedCandidateIds)
    }

    const composerInput = composer()
    const composerBefore = structuredClone(composerInput)
    const composerResult = validateComposerDto(composerInput, composerContext)
    expect(composerInput).toEqual(composerBefore)
    if (composerResult.ok) {
      expect(Object.isFrozen(composerResult.value.sections)).toBe(true)
      expect(Object.isFrozen(composerResult.value.sections[0])).toBe(true)
      expect(Object.isFrozen(composerResult.value.sections[0]?.items)).toBe(true)
      expect(Object.isFrozen(composerResult.value.sections[0]?.items[0])).toBe(true)
    }
  })
})
