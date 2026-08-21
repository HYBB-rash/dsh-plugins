import {
  createTrustedFact,
  isTrustedFact,
  type ApplicationLevel,
  type FactDimension,
  type TrustedFact,
} from './model.ts'

export interface ScopeCandidate {
  readonly isTrustedFact: false
  readonly target: TrustedFact['target']
  readonly dimension: FactDimension
  readonly reason: string
  readonly applicationLevel: 'reusable_rule' | 'hard_exclusion'
  readonly evidence: {
    readonly kind: 'candidate'
    readonly rawUserExpression: string
    readonly candidate: string
  }
}

export type ScopePolicyRequest =
  | { readonly kind: 'aggregate'; readonly observations: readonly unknown[] }
  | {
      readonly kind: 'propose'
      readonly observation: unknown
      readonly candidate: string
      readonly applicationLevel: 'reusable_rule' | 'hard_exclusion'
      readonly rawUserExpression: string
    }
  | {
      readonly kind: 'confirm'
      readonly observation: unknown
      readonly candidate: string
      readonly applicationLevel: 'reusable_rule' | 'hard_exclusion'
      readonly rawUserExpression: string
      readonly confirmation: string
    }

export type ScopePolicyResult =
  | { readonly kind: 'observations_only'; readonly facts: readonly TrustedFact[]; readonly effects: readonly [] }
  | { readonly kind: 'candidate'; readonly candidate: ScopeCandidate; readonly effects: readonly [] }
  | { readonly kind: 'trusted_fact'; readonly fact: TrustedFact; readonly effects: readonly ['append_trusted_fact'] }
  | { readonly kind: 'rejected'; readonly code: ScopePolicyErrorCode; readonly message: string }

export type ScopePolicyErrorCode =
  | 'untrusted_observation'
  | 'observation_level_required'
  | 'hard_exclusion_requires_confirmation'
  | 'invalid_observation'
  | 'invalid_confirmation'

const noEffects = [] as const

export function evaluateScopePolicy(request: ScopePolicyRequest): ScopePolicyResult {
  if (request.kind === 'aggregate') return aggregateObservations(request.observations)

  const observationResult = requireObservation(request.observation)
  if (observationResult.kind === 'rejected') return observationResult

  if (request.kind === 'propose') return proposeScope(observationResult.fact, request)
  return confirmScope(observationResult.fact, request)
}

function aggregateObservations(observations: readonly unknown[]): ScopePolicyResult {
  const facts: TrustedFact[] = []
  for (const observation of observations) {
    const result = requireObservation(observation)
    if (result.kind === 'rejected') return result
    facts.push(result.fact)
  }
  return { kind: 'observations_only', facts, effects: noEffects }
}

function requireObservation(value: unknown):
  | { readonly kind: 'observation'; readonly fact: TrustedFact }
  | Extract<ScopePolicyResult, { readonly kind: 'rejected' }> {
  if (!isTrustedFact(value)) {
    return rejected('untrusted_observation', '作用级别策略只接受 A 工厂生成的可信观察。')
  }
  if (value.applicationLevel !== 'observation') {
    return rejected('observation_level_required', '作用级别策略输入必须是 observation。')
  }
  return { kind: 'observation', fact: value }
}

function proposeScope(
  observation: TrustedFact,
  request: Extract<ScopePolicyRequest, { readonly kind: 'propose' }>,
): ScopePolicyResult {
  if (request.applicationLevel === 'hard_exclusion') {
    return rejected('hard_exclusion_requires_confirmation', '硬排除必须由用户明确确认作用级别。')
  }
  if (!hasText(request.candidate) || !hasText(request.rawUserExpression)) {
    return rejected('invalid_observation', '候选和用户表达不能为空。')
  }
  return {
    kind: 'candidate',
    candidate: {
      isTrustedFact: false,
      target: observation.target,
      dimension: observation.dimension,
      reason: request.candidate,
      applicationLevel: request.applicationLevel,
      evidence: {
        kind: 'candidate',
        rawUserExpression: request.rawUserExpression,
        candidate: request.candidate,
      },
    },
    effects: noEffects,
  }
}

function confirmScope(
  observation: TrustedFact,
  request: Extract<ScopePolicyRequest, { readonly kind: 'confirm' }>,
): ScopePolicyResult {
  if (!hasText(request.candidate) || !hasText(request.rawUserExpression) || !hasText(request.confirmation)) {
    return rejected('invalid_confirmation', '候选、用户表达和确认表达不能为空。')
  }
  const result = createTrustedFact({
    target: observation.target,
    dimension: observation.dimension,
    reason: request.candidate,
    applicationLevel: request.applicationLevel as ApplicationLevel,
    evidence: {
      kind: 'user_confirmed_candidate',
      rawUserExpression: request.rawUserExpression,
      candidate: request.candidate,
      confirmation: request.confirmation,
      explicitApplicationLevel: request.applicationLevel,
    },
  })
  if (!result.ok) return rejected('invalid_confirmation', result.message)
  return { kind: 'trusted_fact', fact: result.fact, effects: ['append_trusted_fact'] }
}

function hasText(value: string): boolean {
  return value.trim().length > 0
}

function rejected(code: ScopePolicyErrorCode, message: string): Extract<ScopePolicyResult, { readonly kind: 'rejected' }> {
  return { kind: 'rejected', code, message }
}
