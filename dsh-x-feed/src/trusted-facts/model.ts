export type FactDimension =
  | 'content_value'
  | 'argument_quality'
  | 'factual_accuracy'

export type ApplicationLevel =
  | 'observation'
  | 'reusable_rule'
  | 'hard_exclusion'

const trustedFactBrand: unique symbol = Symbol('TrustedFact')

export interface FactTarget {
  readonly id: string
  readonly content: string
  readonly source: string
  readonly scope: string
}

interface UserDirectEvidence {
  readonly kind: 'user_direct'
  readonly rawUserExpression: string
  readonly explicitApplicationLevel?: ApplicationLevel
}

interface UserConfirmedCandidateEvidence {
  readonly kind: 'user_confirmed_candidate'
  readonly rawUserExpression: string
  readonly candidate: string
  readonly confirmation: string
  readonly explicitApplicationLevel?: ApplicationLevel
}

interface UnconfirmedCandidateEvidence {
  readonly kind: 'candidate'
  readonly rawUserExpression: string
  readonly candidate: string
  readonly explicitApplicationLevel?: ApplicationLevel
}

export type FactEvidence = UserDirectEvidence | UserConfirmedCandidateEvidence
export type FactEvidenceInput = FactEvidence | UnconfirmedCandidateEvidence

export interface TrustedFact {
  readonly [trustedFactBrand]: true
  readonly target: FactTarget
  readonly dimension: FactDimension
  readonly reason: string
  readonly applicationLevel: ApplicationLevel
  readonly evidence: FactEvidence
}

export interface TrustedFactInput {
  readonly target: FactTarget
  readonly dimension: FactDimension
  readonly reason: string
  readonly applicationLevel?: ApplicationLevel
  readonly evidence: FactEvidenceInput
}

export type TrustedFactErrorCode =
  | 'invalid_input'
  | 'empty_target_id'
  | 'empty_target_content'
  | 'empty_target_source'
  | 'empty_target_scope'
  | 'invalid_dimension'
  | 'empty_reason'
  | 'empty_raw_user_expression'
  | 'candidate_not_confirmed'
  | 'empty_candidate'
  | 'empty_confirmation'
  | 'invalid_application_level'
  | 'application_level_not_confirmed'

export type TrustedFactResult =
  | { readonly ok: true; readonly fact: TrustedFact }
  | { readonly ok: false; readonly code: TrustedFactErrorCode; readonly message: string }

const trustedFactInstances = new WeakSet<object>()

export function isTrustedFact(value: unknown): value is TrustedFact {
  return typeof value === 'object' && value !== null && trustedFactInstances.has(value)
}

export function createTrustedFact(input: unknown): TrustedFactResult {
  if (!isRecord(input)) return failure('invalid_input', '事实输入必须是对象。')

  const targetResult = validateTarget(input.target)
  if (!targetResult.ok) return targetResult

  if (!isFactDimension(input.dimension)) {
    return failure('invalid_dimension', '事实维度无效。')
  }

  if (!hasText(input.reason)) return failure('empty_reason', '事实理由不能为空。')

  const evidenceResult = validateEvidence(input.evidence)
  if (!evidenceResult.ok) return evidenceResult

  const applicationLevel = input.applicationLevel ?? 'observation'
  if (!isApplicationLevel(applicationLevel)) {
    return failure('invalid_application_level', '事实作用级别无效。')
  }

  if (!hasRequiredUserAssignment(evidenceResult.evidence, applicationLevel)) {
    return failure(
      'application_level_not_confirmed',
      '可复用规则或硬排除规则必须有用户明确赋予相应作用级别的证据。',
    )
  }

  const fact = freezeFact({
    [trustedFactBrand]: true,
    target: targetResult.target,
    dimension: input.dimension,
    reason: input.reason,
    applicationLevel,
    evidence: evidenceResult.evidence,
  })
  trustedFactInstances.add(fact)

  return { ok: true, fact }
}

function validateTarget(value: unknown):
  | { readonly ok: true; readonly target: FactTarget }
  | { readonly ok: false; readonly code: TrustedFactErrorCode; readonly message: string } {
  if (!isRecord(value)) return failure('invalid_input', '事实对象必须包含有效目标。')

  const fields: Array<readonly [keyof FactTarget, TrustedFactErrorCode, string]> = [
    ['id', 'empty_target_id', '目标 id 不能为空。'],
    ['content', 'empty_target_content', '目标内容不能为空。'],
    ['source', 'empty_target_source', '目标来源不能为空。'],
    ['scope', 'empty_target_scope', '目标范围不能为空。'],
  ]
  for (const [field, code, message] of fields) {
    if (!hasText(value[field])) return failure(code, message)
  }

  return {
    ok: true,
    target: {
      id: value.id as string,
      content: value.content as string,
      source: value.source as string,
      scope: value.scope as string,
    },
  }
}

function validateEvidence(value: unknown):
  | { readonly ok: true; readonly evidence: FactEvidence }
  | { readonly ok: false; readonly code: TrustedFactErrorCode; readonly message: string } {
  if (!isRecord(value) || !hasText(value.rawUserExpression)) {
    return failure('empty_raw_user_expression', '原始用户表达不能为空。')
  }
  if (value.explicitApplicationLevel !== undefined && !isApplicationLevel(value.explicitApplicationLevel)) {
    return failure('invalid_application_level', '事实作用级别无效。')
  }

  if (value.kind === 'candidate') {
    return failure('candidate_not_confirmed', '外部候选必须先得到用户明确确认。')
  }
  if (value.kind === 'user_direct') {
    return {
      ok: true,
      evidence: {
        kind: 'user_direct',
        rawUserExpression: value.rawUserExpression as string,
        ...(optionalApplicationLevel(value.explicitApplicationLevel)),
      },
    }
  }
  if (value.kind !== 'user_confirmed_candidate') {
    return failure('invalid_input', '事实证据类型无效。')
  }
  if (!hasText(value.candidate)) return failure('empty_candidate', '候选理由不能为空。')
  if (!hasText(value.confirmation)) return failure('empty_confirmation', '用户确认表达不能为空。')

  return {
    ok: true,
    evidence: {
      kind: 'user_confirmed_candidate',
      rawUserExpression: value.rawUserExpression as string,
      candidate: value.candidate as string,
      confirmation: value.confirmation as string,
      ...(optionalApplicationLevel(value.explicitApplicationLevel)),
    },
  }
}

function hasRequiredUserAssignment(evidence: FactEvidence, applicationLevel: ApplicationLevel): boolean {
  return applicationLevel === 'observation' || evidence.explicitApplicationLevel === applicationLevel
}

function optionalApplicationLevel(value: unknown): { readonly explicitApplicationLevel?: ApplicationLevel } {
  if (value === undefined) return {}
  return { explicitApplicationLevel: value as ApplicationLevel }
}

function isFactDimension(value: unknown): value is FactDimension {
  return value === 'content_value' || value === 'argument_quality' || value === 'factual_accuracy'
}

function isApplicationLevel(value: unknown): value is ApplicationLevel {
  return value === 'observation' || value === 'reusable_rule' || value === 'hard_exclusion'
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function freezeFact(value: TrustedFact): TrustedFact {
  return Object.freeze({
    ...value,
    target: Object.freeze({ ...value.target }),
    evidence: Object.freeze({ ...value.evidence }),
  })
}

function failure(code: TrustedFactErrorCode, message: string): {
  readonly ok: false
  readonly code: TrustedFactErrorCode
  readonly message: string
} {
  return { ok: false, code, message }
}
