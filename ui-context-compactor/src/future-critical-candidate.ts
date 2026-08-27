/**
 * T1F's package-internal projection of already-authorized material into the
 * one frozen FutureCriticalPoint collection consumed by candidate formation.
 * It does not form, review, qualify or apply a candidate.
 */

import type {
  FutureCriticalConclusion,
  FutureCriticalCondition,
  FutureCriticalPoint,
  FutureCriticalUse,
} from './candidate-qualification.ts'
import {
  bindAuthenticBoundedFutureCriticalProposalRequest,
  BoundedAuxiliarySemanticCall,
  type BoundedFutureCriticalProposalRequest,
} from './managed-runtime.ts'

export interface AuthenticatedStructuredFutureCriticalMaterial {
  readonly kind: 'authenticated_structured'
  readonly material: string
  readonly source: string
  readonly conclusion: string
  readonly appliesWhen: string
  readonly futureUse: string
}

export interface AuthorizedUnstructuredFutureCriticalMaterial {
  readonly kind: 'authorized_unstructured'
  readonly material: string
  readonly source: string
  readonly authorizedExcerpt: string
}

export type FutureCriticalCandidateMaterial =
  | AuthenticatedStructuredFutureCriticalMaterial
  | AuthorizedUnstructuredFutureCriticalMaterial

export type FutureCriticalPointProjection =
  | {
      readonly kind: 'projected'
      readonly points: readonly [FutureCriticalPoint]
      readonly auxiliaryCalls: 0 | 1
    }
  | {
      readonly kind: 'unavailable'
      readonly reason:
        | 'not_exactly_one_authorized_material'
        | 'authorized_material_invalid'
        | 'bounded_proposal_unavailable'
      readonly auxiliaryCalls: 0 | 1
    }

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && actual.every(key => keys.includes(key))
}

function nonblank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function point(
  conclusion: string,
  appliesWhen: string,
  futureUse: string,
): FutureCriticalPoint {
  return Object.freeze({
    conclusion: conclusion as FutureCriticalConclusion,
    appliesWhen: appliesWhen as FutureCriticalCondition,
    futureUse: futureUse as FutureCriticalUse,
  })
}

function unavailable(
  reason: Extract<FutureCriticalPointProjection, { readonly kind: 'unavailable' }>['reason'],
  auxiliaryCalls: 0 | 1,
): FutureCriticalPointProjection {
  return Object.freeze({ kind: 'unavailable', reason, auxiliaryCalls })
}

/**
 * The caller supplies exactly one material selected by its existing authority
 * path. Structured material costs no provider call. An explicitly authorized
 * excerpt may use the one existing bounded caller and remains unsigned until
 * the normal Formation/ContentReviewer/FreshnessReviewer/Qualification chain.
 */
export async function projectFutureCriticalPoints(
  materials: readonly FutureCriticalCandidateMaterial[],
  semantic: BoundedAuxiliarySemanticCall,
  signal: AbortSignal,
): Promise<FutureCriticalPointProjection> {
  const material = materials.length === 1 ? materials[0] : undefined
  if (material === undefined || signal.aborted) {
    return unavailable('not_exactly_one_authorized_material', 0)
  }
  const raw = object(material)
  if (raw === undefined || !Object.isFrozen(material)) {
    return unavailable('authorized_material_invalid', 0)
  }
  if (material.kind === 'authenticated_structured') {
    if (!onlyKeys(raw, ['kind', 'material', 'source', 'conclusion', 'appliesWhen', 'futureUse'])
      || !nonblank(material.material)
      || !nonblank(material.source)
      || !nonblank(material.conclusion)
      || !nonblank(material.appliesWhen)
      || !nonblank(material.futureUse)) return unavailable('authorized_material_invalid', 0)
    const points: readonly [FutureCriticalPoint] = Object.freeze([
      point(material.conclusion, material.appliesWhen, material.futureUse),
    ])
    return Object.freeze({
      kind: 'projected',
      points,
      auxiliaryCalls: 0,
    })
  }
  if (!onlyKeys(raw, ['kind', 'material', 'source', 'authorizedExcerpt'])
    || !nonblank(material.material)
    || !nonblank(material.source)
    || !nonblank(material.authorizedExcerpt)) return unavailable('authorized_material_invalid', 0)
  const request: BoundedFutureCriticalProposalRequest = Object.freeze({
    material: material.material,
    source: material.source,
    authorizedExcerpt: material.authorizedExcerpt,
  })
  if (!bindAuthenticBoundedFutureCriticalProposalRequest(request, semantic)) {
    return unavailable('authorized_material_invalid', 0)
  }
  const outcome = await semantic.proposeFutureCriticalPoint(request, signal)
  if (outcome.kind !== 'proposal'
    || outcome.request !== request
    || outcome.value.material !== request.material
    || outcome.value.source !== request.source
    || !nonblank(outcome.value.conclusion)
    || !nonblank(outcome.value.appliesWhen)
    || !nonblank(outcome.value.futureUse)) return unavailable('bounded_proposal_unavailable', 1)
  const points: readonly [FutureCriticalPoint] = Object.freeze([
    point(outcome.value.conclusion, outcome.value.appliesWhen, outcome.value.futureUse),
  ])
  return Object.freeze({
    kind: 'projected',
    points,
    auxiliaryCalls: 1,
  })
}
