import {
  assertProjectedTrustedFact,
  validateAssessmentAudit,
  type CandidateFactAssessmentAudit,
  type ExactLookupGrant,
  type FactProjectionAccessRegistry,
  type FrozenProjectionSnapshot,
  type LookupFailure,
  type LookupRequest,
  type LookupResult,
  type LookupSuccess,
  type ReadyFactProjectionAccess,
} from './contracts.ts'
import { isTrustedFact } from '../trusted-facts/model.ts'
import type {
  LocatedTrustedFact,
  LocatedTrustedFactSnapshot,
  Sha256Digest,
  TrustedFactLocator,
} from '../trusted-facts/navigation-contract.ts'

/** A source snapshot admitted by the exact lookup preflight. */
export type FrozenLocatedTrustedFactSnapshot = LocatedTrustedFactSnapshot

/** The only input accepted by the in-memory exact lookup builder. */
export interface ExactFactLookupBuildInput {
  readonly facts: FrozenLocatedTrustedFactSnapshot
  readonly snapshot: FrozenProjectionSnapshot
  readonly registry: FactProjectionAccessRegistry
  readonly access: ReadyFactProjectionAccess
  readonly grants: readonly ExactLookupGrant[]
  readonly audit: CandidateFactAssessmentAudit
  /** Frozen projection ticket ids; must exactly equal the installed grant ids. */
  readonly knownTicketIds: readonly string[]
}

export type ExactFactLookupBuildResult = ExactFactLookup | LookupFailure

/**
 * A process-local, exact-only lookup.  Its constructor is intentionally the
 * installation boundary: all source facts are validated and indexed once,
 * before any caller can invoke lookup.
 */
export class ExactFactLookup {
  private readonly factsByLocator: ReadonlyMap<string, ReturnType<typeof assertProjectedTrustedFact>>
  private readonly grantsByTicket: ReadonlyMap<string, ExactLookupGrant>
  private readonly access: ReadyFactProjectionAccess
  private readonly snapshot: FrozenProjectionSnapshot
  private readonly registry: FactProjectionAccessRegistry
  private readonly sourceSnapshot: FrozenLocatedTrustedFactSnapshot
  private readonly knownTicketIds: ReadonlySet<string>

  constructor(input: ExactFactLookupBuildInput) {
    const prepared = preflight(input)
    if (prepared.kind === 'lookup-failure') throw new ExactFactLookupBuildError(prepared)

    this.factsByLocator = prepared.factsByLocator
    this.grantsByTicket = prepared.grantsByTicket
    this.access = input.access
    this.snapshot = input.snapshot
    this.registry = input.registry
    this.sourceSnapshot = input.facts
    this.knownTicketIds = prepared.knownTicketIds
  }

  /**
   * The sole query operation.  The request is deliberately checked as an
   * exact one-field object; selectors, ranges, pagination, and broad reads do
   * not have an implementation path here.
   */
  lookup(access: ReadyFactProjectionAccess, request: LookupRequest): LookupResult {
    if (access !== this.access) return failure('invalid_access', 'Lookup access is not the installed capability.')
    if (!isExactTicketRequest(request)) return failure('invalid_access', 'Lookup request must contain only ticketId.')
    if (!this.knownTicketIds.has(request.ticketId)) {
      return failure('ticket_not_found', 'Lookup ticket was not present in the frozen projection.')
    }

    const grant = this.grantsByTicket.get(request.ticketId)
    if (grant === undefined) return failure('grant_not_found', 'No grant is installed for this lookup ticket.')
    if (grant.snapshotRevision !== this.snapshot.revision
      || this.sourceSnapshot.sourceRevision !== this.snapshot.revision) {
      return failure('grant_snapshot_mismatch', 'Lookup grant does not match the installed snapshot.')
    }
    try {
      if (!this.registry.authorize(this.access, grant, this.snapshot)) {
        return failure('invalid_access', 'Lookup grant is not authorized for the installed access.')
      }
    } catch {
      return failure('invalid_access', 'Lookup grant authorization failed.')
    }

    const facts: ReturnType<typeof assertProjectedTrustedFact>[] = []
    for (const locatorId of grant.locatorIds) {
      const fact = this.factsByLocator.get(locatorId)
      if (fact === undefined) return failure('invalid_fact', 'A granted locator is absent from the indexed snapshot.')
      facts.push(fact)
    }
    return success(facts)
  }
}

/** Build and install one immutable, in-memory grant registry. */
export function buildExactFactLookup(input: ExactFactLookupBuildInput): ExactFactLookupBuildResult {
  try {
    return new ExactFactLookup(input)
  } catch (error) {
    if (error instanceof ExactFactLookupBuildError) return error.failure
    return failure('invalid_fact', error instanceof Error ? error.message : 'Exact lookup preflight failed.')
  }
}

/** Named builder alias for callers that prefer a factory-shaped API. */
export const createExactFactLookup = buildExactFactLookup

/** Stateful form kept deliberately thin so installation remains one path. */
export class ExactFactLookupBuilder {
  build(input: ExactFactLookupBuildInput): ExactFactLookupBuildResult {
    return buildExactFactLookup(input)
  }
}

interface PreparedLookup {
  readonly kind: 'ready'
  readonly factsByLocator: ReadonlyMap<string, ReturnType<typeof assertProjectedTrustedFact>>
  readonly grantsByTicket: ReadonlyMap<string, ExactLookupGrant>
  readonly knownTicketIds: ReadonlySet<string>
}

function preflight(input: ExactFactLookupBuildInput): PreparedLookup | LookupFailure {
  if (!isRecord(input) || !isRecord(input.registry) || !isRecord(input.access)
    || !isRecord(input.snapshot) || !isRecord(input.facts)
    || !Array.isArray(input.grants) || !isRecord(input.audit)
    || !Array.isArray(input.knownTicketIds)) {
    return failure('invalid_fact', 'Exact lookup input is incomplete.')
  }
  if (!isFrozenProjectionSnapshot(input.snapshot)) {
    return failure('grant_snapshot_mismatch', 'Projection snapshot must be frozen and valid.')
  }
  if (!isFrozenLocatedSnapshot(input.facts)) {
    return failure('invalid_fact', 'Located trusted-fact snapshot must be frozen and valid.')
  }
  if (input.facts.sourceRevision !== input.snapshot.revision) {
    return failure('grant_snapshot_mismatch', 'Fact and projection snapshots have different revisions.')
  }
  if (!isRegistry(input.registry)) return failure('invalid_access', 'Fact projection registry is invalid.')

  const factsByLocator = new Map<string, ReturnType<typeof assertProjectedTrustedFact>>()
  for (const located of input.facts.facts) {
    if (!isLocatedTrustedFact(located) || factsByLocator.has(located.locator.locatorId)) {
      return failure('invalid_fact', 'Located trusted-fact snapshot contains an invalid or duplicate locator.')
    }
    if (!isTrustedFact(located.fact)) {
      return failure('invalid_fact', 'Located snapshot contains a value that is not a trusted fact.')
    }
    try {
      factsByLocator.set(located.locator.locatorId, freezeProjectedFact(assertProjectedTrustedFact(located.fact)))
    } catch (error) {
      return failure('invalid_fact', error instanceof Error ? error.message : 'Trusted fact is invalid.')
    }
  }

  const auditResult = validateAssessmentAudit(input.audit)
  if (!auditResult.ok) return failure('invalid_fact', auditResult.message)
  const decisionsByLocator = new Map(auditResult.value.decisions.map(decision => [decision.locatorId, decision]))
  for (const locatorId of decisionsByLocator.keys()) {
    if (!factsByLocator.has(locatorId)) return failure('invalid_fact', 'Audit contains an unknown locator.')
  }

  const knownTicketIdsResult = validateKnownTicketIds(input.knownTicketIds)
  if (knownTicketIdsResult.kind === 'lookup-failure') return knownTicketIdsResult

  const grantsByTicket = new Map<string, ExactLookupGrant>()
  for (const grant of input.grants) {
    if (!isGrant(grant) || grantsByTicket.has(grant.ticketId)) {
      return failure('invalid_fact', 'Grant registry contains an invalid or duplicate ticket.')
    }
    if (grant.snapshotRevision !== input.snapshot.revision) {
      return failure('grant_snapshot_mismatch', 'Grant revision does not match the projection snapshot.')
    }
    try {
      if (!input.registry.authorize(input.access, grant, input.snapshot)) {
        return failure('grant_snapshot_mismatch', 'Grant is not authorized for this access and snapshot.')
      }
    } catch (error) {
      return failure('invalid_access', error instanceof Error ? error.message : 'Grant authorization failed.')
    }
    for (const locatorId of grant.locatorIds) {
      const fact = factsByLocator.get(locatorId)
      const decision = decisionsByLocator.get(locatorId)
      if (fact === undefined || decision === undefined
        || (decision.relevance !== 'high' && decision.relevance !== 'low_confidence')) {
        return failure('invalid_fact', 'Every granted locator needs an audited relevant decision.')
      }
    }
    grantsByTicket.set(grant.ticketId, grant)
  }

  if (knownTicketIdsResult.ids.size !== grantsByTicket.size
    || [...knownTicketIdsResult.ids].some(ticketId => !grantsByTicket.has(ticketId))) {
    return failure('grant_not_found', 'Frozen projection tickets and grants must have identical ids.')
  }
  return {
    kind: 'ready',
    factsByLocator,
    grantsByTicket,
    knownTicketIds: knownTicketIdsResult.ids,
  }
}

function isFrozenLocatedSnapshot(value: unknown): value is FrozenLocatedTrustedFactSnapshot {
  return isRecord(value) && Object.isFrozen(value) && isSha256Digest(value.sourceRevision)
    && Array.isArray(value.facts) && Object.isFrozen(value.facts)
}

function isFrozenProjectionSnapshot(value: unknown): value is FrozenProjectionSnapshot {
  return isRecord(value) && Object.isFrozen(value)
    && Object.keys(value).length === 1 && hasText(value.revision)
}

function isLocatedTrustedFact(value: unknown): value is LocatedTrustedFact {
  if (!isRecord(value) || !isRecord(value.locator) || !('fact' in value)
    || !isValidLocator(value.locator)) return false
  return isRecord(value.fact)
}

function isValidLocator(value: Record<string, any>): value is TrustedFactLocator {
  const persistence = value.persistence
  return Object.keys(value).length === 3 && value.schemaVersion === 1 && hasText(value.locatorId)
    && isRecord(persistence) && Object.keys(persistence).length === 4
    && persistence.sourceKind === 'trusted-fact-repository' && hasText(persistence.sourceKey)
    && isPositiveInteger(persistence.lineNumber) && isSha256Digest(persistence.canonicalDigest)
}

function isGrant(value: unknown): value is ExactLookupGrant {
  if (!isRecord(value) || Object.keys(value).length !== 3 || !hasText(value.ticketId)
    || !isSha256Digest(value.snapshotRevision) || !Array.isArray(value.locatorIds)
    || value.locatorIds.length === 0) return false
  return value.locatorIds.every(hasText) && new Set(value.locatorIds).size === value.locatorIds.length
}

function validateKnownTicketIds(
  value: readonly string[],
): { readonly kind: 'valid'; readonly ids: ReadonlySet<string> } | LookupFailure {
  const ids = new Set<string>()
  for (const ticketId of value) {
    if (!hasText(ticketId) || ids.has(ticketId)) {
      return failure('invalid_fact', 'Frozen projection ticket ids must be non-empty and unique.')
    }
    ids.add(ticketId)
  }
  return { kind: 'valid', ids }
}

function isRegistry(value: FactProjectionAccessRegistry): value is FactProjectionAccessRegistry {
  return typeof value.createAccess === 'function' && typeof value.issueGrant === 'function'
    && typeof value.authorize === 'function'
}

function freezeProjectedFact(
  fact: ReturnType<typeof assertProjectedTrustedFact>,
): ReturnType<typeof assertProjectedTrustedFact> {
  return Object.freeze({
    ...fact,
    target: Object.freeze({ ...fact.target }),
    evidence: Object.freeze({ ...fact.evidence }),
  })
}

function isExactTicketRequest(value: unknown): value is LookupRequest {
  return isRecord(value) && Object.keys(value).length === 1 && hasText(value.ticketId)
}

function success(facts: readonly ReturnType<typeof assertProjectedTrustedFact>[]): LookupSuccess {
  return Object.freeze({ kind: 'lookup-success', facts: Object.freeze([...facts]) })
}

function failure(code: LookupFailure['code'], message: string): LookupFailure {
  return Object.freeze({ kind: 'lookup-failure', code, message })
}

class ExactFactLookupBuildError extends Error {
  constructor(readonly failure: LookupFailure) {
    super(failure.message)
    this.name = 'ExactFactLookupBuildError'
  }
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isSha256Digest(value: unknown): value is Sha256Digest {
  return typeof value === 'string' && /^sha256:.+$/.test(value)
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
