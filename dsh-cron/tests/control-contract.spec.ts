/**
 * A0 test-first contract for the manager-owned dsh-cron control surface.
 *
 * The fixture is deliberately made of generic placeholders. These tests
 * freeze both the TypeScript surface and the JSON wire vocabulary before any
 * control core, store, socket, or manager implementation is added.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  CONTROL_HEALTH_METHOD,
  CONTROL_HEALTH_PATH,
  CONTROL_PROTOCOL_VERSION,
  CONTROL_RPC_OPERATIONS,
} from '../src/control-contract.ts'
import type {
  BoundCronJobView,
  BoundCronSnapshot,
  BoundCronSpec,
  ControlErrorResponse,
  ControlHealthResponse,
  ControlRequest,
  ControlSuccessResponse,
  CronRunDeliveryState,
  CronRunExecutionStatus,
  CronRunSnapshot,
  CronSessionMode,
  DeleteBoundRequest,
  DshCronControlClientError,
  DshCronControlClient,
  EnsureBoundRequest,
  GetBoundRequest,
  ReplaceBoundRequest,
} from '../src/control-contract.ts'

type ControlFixture = {
  requests: [EnsureBoundRequest, ReplaceBoundRequest, DeleteBoundRequest, GetBoundRequest]
  health: ControlHealthResponse
  noUpdateSnapshot: CronRunSnapshot
  successResponse: ControlSuccessResponse
  errorResponses: ControlErrorResponse[]
}

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/control-v1.json', import.meta.url), 'utf8'),
) as ControlFixture

const [ensureRequest, replaceRequest, deleteRequest, getRequest] = fixture.requests
const BOUND_SPEC: BoundCronSpec = ensureRequest.spec
const NO_UPDATE_RUN: CronRunSnapshot = fixture.noUpdateSnapshot

const EXECUTION_STATUSES = [
  'success',
  'error',
  'expired',
  'interrupted',
] as const satisfies readonly CronRunExecutionStatus[]

const DELIVERY_STATES = [
  'delivered',
  'silent',
  'not_requested',
  'failed',
  'uncertain',
] as const satisfies readonly CronRunDeliveryState[]

const SESSION_MODES = ['persistent', 'per_run'] as const satisfies readonly CronSessionMode[]

type ExactKeys<Actual, Expected extends PropertyKey> =
  [Exclude<keyof Actual, Expected>] extends [never]
    ? [Exclude<Expected, keyof Actual>] extends [never] ? true : false
    : false

type RequiredClientMethods =
  | 'ensureBound'
  | 'replaceBound'
  | 'deleteBound'
  | 'getBound'
  | 'ensureBoundCommand'
  | 'replaceBoundCommand'
  | 'getBoundCommand'
  | 'updateBoundFailureAlert'
  | 'readiness'

type UnexpectedClientMethods = Exclude<keyof DshCronControlClient, RequiredClientMethods>
type MissingClientMethods = Exclude<RequiredClientMethods, keyof DshCronControlClient>

// These assignments are compile-time locks: an added or removed public key
// must be reviewed explicitly instead of silently widening the v1 contract.
const BOUND_SPEC_KEYS: ExactKeys<
  BoundCronSpec,
  'externalRef' | 'schedule' | 'prompt' | 'deliver' | 'cwd' | 'sessionMode' | 'gate' | 'failureAlert' | 'agentEnvironment'
> = true
const RUN_SNAPSHOT_KEYS: ExactKeys<
  CronRunSnapshot,
  'runId' | 'jobId' | 'scheduledFor' | 'finishedAt' | 'runStatus' | 'summary' | 'error'
    | 'deliveryState' | 'deliveredAt' | 'deliveryError'
> = true
const BOUND_SNAPSHOT_KEYS: ExactKeys<BoundCronSnapshot, 'externalRef' | 'activeJob' | 'latestRun'> = true
const JOB_VIEW_KEYS: ExactKeys<
  BoundCronJobView,
  'id' | 'externalRef' | 'schedule' | 'prompt' | 'deliver' | 'cwd' | 'sessionMode' | 'gate'
    | 'failureAlert' | 'agentEnvironment' | 'createdAt'
> = true
const CLIENT_ERROR_KEYS: ExactKeys<DshCronControlClientError, 'code' | 'message' | 'operation'> = true
const CLIENT_KEYS: ExactKeys<DshCronControlClient, RequiredClientMethods> = true
const NO_UNEXPECTED_CLIENT_METHODS: UnexpectedClientMethods extends never ? true : never = true
const NO_MISSING_CLIENT_METHODS: MissingClientMethods extends never ? true : never = true

type ReadinessResponse = DshCronControlClient['readiness'] extends (...args: never[]) => infer Result
  ? Awaited<Result>
  : never
const fixtureHealthAsReadiness: ReadinessResponse = fixture.health

describe('dsh-cron control contract v1', () => {
  it('freezes the protocol version and GET health response', () => {
    expect(CONTROL_PROTOCOL_VERSION).toBe(1)
    expect(CONTROL_HEALTH_METHOD).toBe('GET')
    expect(CONTROL_HEALTH_PATH).toBe('/health')
    expect(fixture.health).toEqual({ protocolVersion: 1, writer: 'manager', ready: true })
    expect(fixtureHealthAsReadiness).toEqual(fixture.health)
  })

  it('freezes the typed status and session-mode vocabularies', () => {
    expect(EXECUTION_STATUSES).toEqual(['success', 'error', 'expired', 'interrupted'])
    expect(DELIVERY_STATES).toEqual(['delivered', 'silent', 'not_requested', 'failed', 'uncertain'])
    expect(SESSION_MODES).toEqual(['persistent', 'per_run'])
  })

  it('keeps the legacy fixture requests as the first four versioned operations', () => {
    const requests: readonly ControlRequest[] = fixture.requests
    expect(requests.map(request => request.operation)).toEqual(CONTROL_RPC_OPERATIONS.slice(0, 4))
    expect(requests.every(request => request.protocolVersion === CONTROL_PROTOCOL_VERSION)).toBe(true)

    expect(ensureRequest.spec).toEqual(BOUND_SPEC)
    expect(replaceRequest.spec).toEqual(BOUND_SPEC)
    expect(deleteRequest.externalRef).toBe(BOUND_SPEC.externalRef)
    expect(getRequest.externalRef).toBe(BOUND_SPEC.externalRef)
    expect(CONTROL_RPC_OPERATIONS.at(-1)).toBe('update-bound-failure-alert')
  })

  it('keeps execution status and delivery state orthogonal for a no-update run', () => {
    expect(NO_UPDATE_RUN).toMatchObject({ runStatus: 'success', deliveryState: 'silent' })
    expect(NO_UPDATE_RUN).not.toHaveProperty('error')
    expect(NO_UPDATE_RUN).not.toHaveProperty('deliveryError')
  })

  it('requires externalRef and explicit per_run on a bound spec', () => {
    expect(BOUND_SPEC).toMatchObject({
      externalRef: 'external:placeholder',
      deliver: 'telegram',
      sessionMode: 'per_run',
      schedule: { kind: 'interval', minutes: 5 },
    })
    expect(BOUND_SPEC).not.toHaveProperty('id')

    // The ordinary cron_create compatibility default remains persistent; a
    // BoundCronSpec is the explicit per_run escape hatch.
    const cronCreateDefault: CronSessionMode = 'persistent'
    expect(cronCreateDefault).toBe('persistent')
  })

  it('freezes successful responses and the bounded wire error vocabulary', () => {
    expect(fixture.successResponse).toMatchObject({
      protocolVersion: 1,
      ok: true,
      operation: 'get-bound',
      snapshot: {
        externalRef: 'external:placeholder',
        activeJob: {
          id: 'cron-placeholder',
          createdAt: '2026-08-18T00:00:00.000Z',
          sessionMode: 'per_run',
        },
      },
    })
    expect(fixture.errorResponses.map(error => error.errorCode)).toEqual([
      'invalid_request',
      'binding_conflict',
      'persistence_uncertain',
      'internal_error',
    ])
    expect(fixture.errorResponses.every(error => error.protocolVersion === 1 && error.ok === false)).toBe(true)
  })

  it('keeps the v1 client surface closed and key-stable', () => {
    expect(BOUND_SPEC_KEYS).toBe(true)
    expect(RUN_SNAPSHOT_KEYS).toBe(true)
    expect(BOUND_SNAPSHOT_KEYS).toBe(true)
    expect(JOB_VIEW_KEYS).toBe(true)
    expect(CLIENT_ERROR_KEYS).toBe(true)
    expect(CLIENT_KEYS).toBe(true)
    expect(NO_UNEXPECTED_CLIENT_METHODS).toBe(true)
    expect(NO_MISSING_CLIENT_METHODS).toBe(true)
  })
})
