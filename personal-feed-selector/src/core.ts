/** Framework-free business contract for selecting one scarce attention target. */

export const MAX_SELECTION_INPUT_CHARS = 40_000

export interface PersonalFeedSelectionInput {
  readonly personalContext: {
    readonly longTermInterests: string
    readonly existingUnderstanding: string
  }
  readonly candidates: readonly {
    readonly url: string
    readonly content: string
  }[]
}

export type SelectionOutcome =
  | { readonly kind: 'selected'; readonly url: string }
  | { readonly kind: 'empty' }

export type SelectionFailureCode =
  | 'invalid_input'
  | 'input_too_large'
  | 'model_route_unavailable'
  | 'model_call_failed'
  | 'timeout'
  | 'aborted'
  | 'invalid_model_output'

export type SelectionExecutionResult =
  | { readonly status: 'completed'; readonly outcome: SelectionOutcome }
  | { readonly status: 'failed'; readonly code: SelectionFailureCode }

export type SemanticDecision =
  | { readonly kind: 'selected'; readonly candidateIndex: number }
  | { readonly kind: 'empty' }

export type SemanticJudgmentResult =
  | { readonly status: 'completed'; readonly decision: SemanticDecision }
  | { readonly status: 'failed'; readonly code: Exclude<SelectionFailureCode, 'invalid_input' | 'input_too_large'> }

export interface SemanticJudge {
  judge(input: PersonalFeedSelectionInput, signal: AbortSignal): Promise<SemanticJudgmentResult>
}

type ValidatedSelectionInput =
  | { readonly status: 'valid'; readonly input: PersonalFeedSelectionInput }
  | Extract<SelectionExecutionResult, { status: 'failed' }>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const required = [...expected].sort()
  return actual.length === required.length && actual.every((key, index) => key === required[index])
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isXUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:'
      && ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(url.hostname.toLowerCase())
  } catch {
    return false
  }
}

function parseShape(value: unknown): PersonalFeedSelectionInput | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ['personalContext', 'candidates'])) return undefined
  if (!isRecord(value.personalContext)
    || !hasExactKeys(value.personalContext, ['longTermInterests', 'existingUnderstanding'])) return undefined
  const { longTermInterests, existingUnderstanding } = value.personalContext
  if (!isNonEmptyString(longTermInterests) || !isNonEmptyString(existingUnderstanding)) return undefined
  if (!Array.isArray(value.candidates)) return undefined

  const candidates: Array<{ url: string; content: string }> = []
  for (const candidate of value.candidates) {
    if (!isRecord(candidate) || !hasExactKeys(candidate, ['url', 'content'])) return undefined
    if (!isNonEmptyString(candidate.url) || !isXUrl(candidate.url) || !isNonEmptyString(candidate.content)) return undefined
    candidates.push({ url: candidate.url, content: candidate.content })
  }
  return {
    personalContext: { longTermInterests, existingUnderstanding },
    candidates,
  }
}

function inputCharacterCount(input: PersonalFeedSelectionInput): number {
  return input.personalContext.longTermInterests.length
    + input.personalContext.existingUnderstanding.length
    + input.candidates.reduce((total, candidate) => total + candidate.url.length + candidate.content.length, 0)
}

/** Validate unknown tool input before any model call. */
export function validateSelectionInput(value: unknown): ValidatedSelectionInput {
  const input = parseShape(value)
  if (input === undefined) return { status: 'failed', code: 'invalid_input' }
  if (inputCharacterCount(input) > MAX_SELECTION_INPUT_CHARS) {
    return { status: 'failed', code: 'input_too_large' }
  }
  return { status: 'valid', input }
}

/** Run the single use case and map only a supplied candidate index to a URL. */
export async function selectAttention(
  value: unknown,
  judge: SemanticJudge,
  signal: AbortSignal,
): Promise<SelectionExecutionResult> {
  const validated = validateSelectionInput(value)
  if (validated.status === 'failed') return validated
  if (validated.input.candidates.length === 0) {
    return { status: 'completed', outcome: { kind: 'empty' } }
  }

  let judgment: SemanticJudgmentResult
  try {
    judgment = await judge.judge(validated.input, signal)
  } catch {
    return { status: 'failed', code: signal.aborted ? 'aborted' : 'model_call_failed' }
  }
  if (judgment.status === 'failed') return judgment
  if (judgment.decision.kind === 'empty') {
    return { status: 'completed', outcome: { kind: 'empty' } }
  }
  const candidate = validated.input.candidates[judgment.decision.candidateIndex]
  if (candidate === undefined || !Number.isSafeInteger(judgment.decision.candidateIndex)) {
    return { status: 'failed', code: 'invalid_model_output' }
  }
  return { status: 'completed', outcome: { kind: 'selected', url: candidate.url } }
}
