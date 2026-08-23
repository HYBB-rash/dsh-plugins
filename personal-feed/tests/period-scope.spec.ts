import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PersonalFeedScopeConflictError,
  PersonalFeedScopeInputError,
  createPersonalFeedScopeService,
  type CandidateMaterialProjection,
  type CurrentContextProjection,
  type ExternalPeriodScopeInput,
  type MechanicalAdmission,
  type SourceIdentity,
} from '../src/index.ts'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function source(value: string): SourceIdentity {
  return value as SourceIdentity
}

function input(overrides: Partial<ExternalPeriodScopeInput> = {}): ExternalPeriodScopeInput {
  return {
    requestIdentity: 'dsh-cron:cron-feed:run-1',
    trigger: 'scheduled',
    scheduledFor: '2026-08-23T13:30:00.000Z',
    claimedAt: '2026-08-23T13:30:01.000Z',
    runId: 'cron-feed@2026-08-23T13:30:00.000Z',
    requiredSources: [source('x'), source('reading-list')],
    reportingWindowClosesAt: '2026-08-23T13:35:01.000Z',
    ...overrides,
  }
}

function acceptedReceivers(sourceIdentity: SourceIdentity) {
  const mechanicalAdmission: MechanicalAdmission = {
    source: sourceIdentity,
    establishPeriodScope: vi.fn(async request => ({
      status: 'accepted',
      value: request,
    })),
  }
  const candidateMaterialProjection: CandidateMaterialProjection = {
    source: sourceIdentity,
    establishReportScope: vi.fn(async scope => ({
      status: 'accepted',
      value: { scope },
    })),
  }
  return { source: sourceIdentity, mechanicalAdmission, candidateMaterialProjection }
}

function harness() {
  const directory = mkdtempSync(join(tmpdir(), 'personal-feed-scope-'))
  directories.push(directory)
  const x = acceptedReceivers(source('x'))
  const readingList = acceptedReceivers(source('reading-list'))
  const currentContextProjection: CurrentContextProjection = {
    establishPeriodScope: vi.fn(async period => ({
      status: 'accepted',
      value: { period },
    })),
  }
  const ledgerPath = join(directory, 'period-scopes.jsonl')
  return {
    ledgerPath,
    x,
    readingList,
    currentContextProjection,
    service: createPersonalFeedScopeService({
      ledgerPath,
      sourceScopes: [x, readingList],
      currentContextProjection,
    }),
  }
}

describe('TODO 01 external period scope', () => {
  it('establishes C01/C02/C34 and gives every receiver the same period and window', async () => {
    const setup = harness()

    const established = await setup.service.establishExternalPeriodScope(input())

    expect(established).toMatchObject({
      schemaVersion: 1,
      event: 'period_scope_established',
      c01: { status: 'accepted' },
      c02: { status: 'accepted' },
      c34: { status: 'accepted' },
      c33: { status: 'accepted' },
    })
    expect(established.c01.value.run).toBe(established.c01.value.period.run)
    expect(established.c02.value.start.period).toEqual(established.c01.value.period)
    expect(established.c34.value.window.period).toEqual(established.c01.value.period)
    expect(established.c34.value.window.sources).toEqual([source('x'), source('reading-list')])
    expect(established.c34.value.window.closesAt).toBe('2026-08-23T13:35:01.000Z')

    expect(established.c32).toHaveLength(2)
    expect(established.c35).toHaveLength(2)
    for (const result of established.c32) {
      expect(result.status).toBe('accepted')
      if (result.status !== 'accepted') throw new Error('expected C32 accepted')
      expect(result.value.period).toEqual(established.c01.value.period)
      expect(result.value.start).toEqual(established.c02.value)
      expect(result.value.reportingWindow).toEqual(established.c34.value)
    }
    for (const result of established.c35) {
      expect(result.status).toBe('accepted')
      if (result.status !== 'accepted') throw new Error('expected C35 accepted')
      expect(result.value.scope.period).toEqual(established.c01.value.period)
      expect(result.value.scope.reportingWindow).toEqual(established.c34.value)
    }
    expect(established.c33.value.period).toEqual(established.c01.value.period)

    expect(setup.x.mechanicalAdmission.establishPeriodScope).toHaveBeenCalledTimes(1)
    expect(setup.readingList.mechanicalAdmission.establishPeriodScope).toHaveBeenCalledTimes(1)
    expect(setup.x.candidateMaterialProjection.establishReportScope).toHaveBeenCalledTimes(1)
    expect(setup.readingList.candidateMaterialProjection.establishReportScope).toHaveBeenCalledTimes(1)
    expect(setup.currentContextProjection.establishPeriodScope).toHaveBeenCalledTimes(1)

    const persisted = JSON.parse(readFileSync(setup.ledgerPath, 'utf8').trim())
    expect(persisted).toEqual(established)
    expect(persisted).not.toHaveProperty('candidates')
    expect(persisted).not.toHaveProperty('sourceCandidateReports')
    expect(persisted).not.toHaveProperty('currentContext')
    expect(persisted).not.toHaveProperty('content')
    expect(persisted).not.toHaveProperty('delivery')
  })

  it.each(['scheduled', 'manual'] as const)(
    'uses one business identity path for a %s opportunity',
    async trigger => {
      const setup = harness()
      const request = input({
        requestIdentity: `dsh-cron:cron-feed:${trigger}-run`,
        trigger,
        runId: `${trigger}-run`,
      })

      const established = await setup.service.establishExternalPeriodScope(request)

      expect(established.external).toEqual(request)
      expect(established.c01.value.request).toBe(request.requestIdentity)
      expect(established.c01.value.origin).toEqual(trigger === 'manual'
        ? { kind: 'manual', request: request.requestIdentity }
        : { kind: 'scheduled', trigger: request.scheduledFor })
      expect(established.c01.value.period.run).toBe(established.c01.value.run)
    },
  )

  it('returns the one persisted identity for an exact duplicate without calling receivers again', async () => {
    const setup = harness()
    const request = input()

    const first = await setup.service.establishExternalPeriodScope(request)
    const duplicate = await setup.service.establishExternalPeriodScope(request)

    expect(duplicate).toEqual(first)
    expect(readFileSync(setup.ledgerPath, 'utf8').trim().split('\n')).toHaveLength(1)
    expect(setup.x.mechanicalAdmission.establishPeriodScope).toHaveBeenCalledTimes(1)
    expect(setup.currentContextProjection.establishPeriodScope).toHaveBeenCalledTimes(1)
  })

  it('rejects a conflicting reuse of one request identity without a second period', async () => {
    const setup = harness()
    await setup.service.establishExternalPeriodScope(input())

    await expect(setup.service.establishExternalPeriodScope(input({
      reportingWindowClosesAt: '2026-08-23T13:36:01.000Z',
    }))).rejects.toBeInstanceOf(PersonalFeedScopeConflictError)

    expect(readFileSync(setup.ledgerPath, 'utf8').trim().split('\n')).toHaveLength(1)
    expect(setup.x.mechanicalAdmission.establishPeriodScope).toHaveBeenCalledTimes(1)
  })

  it('rejects duplicate, missing, or unbounded source/window input before any receiver is called', async () => {
    const setup = harness()

    await expect(setup.service.establishExternalPeriodScope(input({
      requiredSources: [source('x'), source('x')],
    }))).rejects.toBeInstanceOf(PersonalFeedScopeInputError)
    await expect(setup.service.establishExternalPeriodScope(input({
      requiredSources: [source('unknown')],
    }))).rejects.toBeInstanceOf(PersonalFeedScopeInputError)
    await expect(setup.service.establishExternalPeriodScope(input({
      reportingWindowClosesAt: 'not-a-time',
    }))).rejects.toBeInstanceOf(PersonalFeedScopeInputError)

    expect(setup.x.mechanicalAdmission.establishPeriodScope).not.toHaveBeenCalled()
    expect(setup.currentContextProjection.establishPeriodScope).not.toHaveBeenCalled()
  })

  it('fails closed when a receiver substitutes another period or window', async () => {
    const setup = harness()
    setup.x.mechanicalAdmission.establishPeriodScope = vi.fn(async request => ({
      status: 'accepted',
      value: {
        ...request,
        period: { ...request.period, period: 'cross-period' as never },
      },
    }))

    await expect(setup.service.establishExternalPeriodScope(input()))
      .rejects.toBeInstanceOf(PersonalFeedScopeConflictError)

    expect(() => readFileSync(setup.ledgerPath, 'utf8')).toThrow()
    expect(setup.x.candidateMaterialProjection.establishReportScope).not.toHaveBeenCalled()
  })
})
