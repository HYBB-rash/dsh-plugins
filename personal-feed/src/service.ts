import {
  createPeriodBusinessFinalizer,
  createRunOpportunityLifecycle,
  requireC32Accepted,
  requireC33Accepted,
  requireC35Accepted,
} from './components.ts'
import { PersonalFeedScopeConflictError, PersonalFeedScopeInputError } from './errors.ts'
import {
  reportingWindowIdentityFor,
  runRequestIdentity,
} from './identity.ts'
import { createPeriodScopeStore } from './store.ts'
import type {
  CandidateReportingWindow,
  CurrentContextProjection,
  ExternalPeriodScopeInput,
  MechanicalAdmissionPeriodScopeRequest,
  MaterialProjectionReportScope,
  PeriodScopeEstablished,
  PersonalFeedScopeService,
  RunOpportunityRequest,
  SourceIdentity,
  SourceScopeComponents,
} from './types.ts'

export interface PersonalFeedScopeServiceOptions {
  readonly ledgerPath: string
  readonly sourceScopes: readonly SourceScopeComponents[]
  readonly currentContextProjection: CurrentContextProjection
}

export function createPersonalFeedScopeService(
  options: PersonalFeedScopeServiceOptions,
): PersonalFeedScopeService {
  validateConfiguredComponents(options.sourceScopes)
  const store = createPeriodScopeStore(options.ledgerPath)
  const lifecycle = createRunOpportunityLifecycle()
  const finalizer = createPeriodBusinessFinalizer()
  let previous = Promise.resolve()

  const establishExternalPeriodScope = (
    rawInput: ExternalPeriodScopeInput,
  ): Promise<PeriodScopeEstablished> => {
    const operation = previous.then(async () => {
      const input = normalizeInput(rawInput)
      const selectedSources = selectSourceComponents(input.requiredSources, options.sourceScopes)
      const existing = store.findByRequest(runRequestIdentity(input.requestIdentity))
      if (existing !== undefined) {
        if (!sameInput(existing.external, input)) {
          throw new PersonalFeedScopeConflictError(
            `request identity ${input.requestIdentity} already established a different period scope`,
          )
        }
        return existing
      }

      const requestIdentity = runRequestIdentity(input.requestIdentity)
      const origin: RunOpportunityRequest['origin'] = input.trigger === 'manual'
        ? { kind: 'manual', request: requestIdentity }
        : { kind: 'scheduled', trigger: input.scheduledFor }
      const request: RunOpportunityRequest = { request: requestIdentity, origin }
      const c01 = lifecycle.requestRunOpportunity(request)
      const opportunity = c01.value
      const { period } = opportunity
      const c02 = finalizer.establishPeriod({
        period,
        startFact: opportunity.startFact,
        origin,
      })
      const window: CandidateReportingWindow = {
        window: reportingWindowIdentityFor(JSON.stringify({
          period,
          sources: input.requiredSources,
          closesAt: input.reportingWindowClosesAt,
        })),
        period,
        sources: input.requiredSources,
        closesAt: input.reportingWindowClosesAt,
      }
      const c34 = finalizer.acceptCandidateReportingWindow(window)

      const c32 = []
      for (const components of selectedSources) {
        const scope: MechanicalAdmissionPeriodScopeRequest = {
          period,
          source: components.source,
          start: c02.value,
          reportingWindow: c34.value,
        }
        c32.push(requireC32Accepted(
          await components.mechanicalAdmission.establishPeriodScope(scope),
          scope,
        ))
      }

      const c33 = requireC33Accepted(
        await options.currentContextProjection.establishPeriodScope(period),
        period,
      )

      const c35 = []
      for (const components of selectedSources) {
        const scope: MaterialProjectionReportScope = {
          period,
          source: components.source,
          reportingWindow: c34.value,
        }
        c35.push(requireC35Accepted(
          await components.candidateMaterialProjection.establishReportScope(scope),
          scope,
        ))
      }

      const record: PeriodScopeEstablished = {
        schemaVersion: 1,
        event: 'period_scope_established',
        external: input,
        c01,
        c02,
        c34,
        c32,
        c33,
        c35,
      }
      store.append(record)
      return record
    })
    previous = operation.then(() => undefined, () => undefined)
    return operation
  }

  return Object.freeze({ establishExternalPeriodScope })
}

function normalizeInput(input: ExternalPeriodScopeInput): ExternalPeriodScopeInput {
  if (typeof input !== 'object' || input === null) {
    throw new PersonalFeedScopeInputError('external period scope input must be an object')
  }
  requireNonEmpty(input.requestIdentity, 'requestIdentity')
  requireNonEmpty(input.runId, 'runId')
  requireIsoInstant(input.scheduledFor, 'scheduledFor')
  const claimedAt = requireIsoInstant(input.claimedAt, 'claimedAt')
  const closesAt = requireIsoInstant(input.reportingWindowClosesAt, 'reportingWindowClosesAt')
  if (closesAt <= claimedAt) {
    throw new PersonalFeedScopeInputError('reportingWindowClosesAt must be after claimedAt')
  }
  if (input.trigger !== 'manual' && input.trigger !== 'scheduled') {
    throw new PersonalFeedScopeInputError('trigger must be scheduled or manual')
  }
  if (!Array.isArray(input.requiredSources) || input.requiredSources.length === 0) {
    throw new PersonalFeedScopeInputError('requiredSources must contain at least one source')
  }
  const sources = input.requiredSources.map((source, index) => {
    requireNonEmpty(source, `requiredSources[${index}]`)
    return source as SourceIdentity
  })
  if (new Set(sources).size !== sources.length) {
    throw new PersonalFeedScopeInputError('requiredSources must not contain duplicates')
  }
  return Object.freeze({
    requestIdentity: input.requestIdentity,
    trigger: input.trigger,
    scheduledFor: input.scheduledFor,
    claimedAt: input.claimedAt,
    runId: input.runId,
    requiredSources: Object.freeze([...sources]),
    reportingWindowClosesAt: input.reportingWindowClosesAt,
  })
}

function requireNonEmpty(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PersonalFeedScopeInputError(`${name} must be a non-empty string`)
  }
}

function requireIsoInstant(value: unknown, name: string): number {
  if (typeof value !== 'string') throw new PersonalFeedScopeInputError(`${name} must be an ISO instant`)
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new PersonalFeedScopeInputError(`${name} must be a canonical ISO instant`)
  }
  return milliseconds
}

function validateConfiguredComponents(sourceScopes: readonly SourceScopeComponents[]): void {
  if (sourceScopes.length === 0) {
    throw new PersonalFeedScopeInputError('at least one source scope component is required')
  }
  const identities = sourceScopes.map(components => components.source)
  if (new Set(identities).size !== identities.length) {
    throw new PersonalFeedScopeInputError('source scope component identities must be unique')
  }
  for (const components of sourceScopes) {
    if (components.mechanicalAdmission.source !== components.source
      || components.candidateMaterialProjection.source !== components.source) {
      throw new PersonalFeedScopeInputError('source scope component identities must agree')
    }
  }
}

function selectSourceComponents(
  required: readonly SourceIdentity[],
  configured: readonly SourceScopeComponents[],
): SourceScopeComponents[] {
  return required.map(source => {
    const match = configured.find(components => components.source === source)
    if (match === undefined) {
      throw new PersonalFeedScopeInputError(`required source ${source} has no scope components`)
    }
    return match
  })
}

function sameInput(left: ExternalPeriodScopeInput, right: ExternalPeriodScopeInput): boolean {
  return left.requestIdentity === right.requestIdentity
    && left.trigger === right.trigger
    && left.scheduledFor === right.scheduledFor
    && left.claimedAt === right.claimedAt
    && left.runId === right.runId
    && left.reportingWindowClosesAt === right.reportingWindowClosesAt
    && left.requiredSources.length === right.requiredSources.length
    && left.requiredSources.every((source, index) => source === right.requiredSources[index])
}
