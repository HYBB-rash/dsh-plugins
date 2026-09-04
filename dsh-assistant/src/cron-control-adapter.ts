/** Assistant-owned v2 client for the manager's narrow HTTP-over-Unix-socket control surface. */

import { request as httpRequest } from 'node:http'
import type {
  AssistantCronActiveJob,
  AssistantCronBindingSnapshot,
  AssistantCronBindingSpec,
  AssistantCronControlPort,
  AssistantCronControlResult,
  AssistantCronLatestRun,
  AssistantCronSchedule,
} from './cron-control-port.ts'

export const ASSISTANT_CRON_CONTROL_PROTOCOL_VERSION = 2 as const

const MAX_RESPONSE_BYTES = 1_048_576
const DEFAULT_TIMEOUT_MS = 5_000
const RUN_STATUSES = ['success', 'error', 'expired', 'interrupted'] as const
const DELIVERY_STATES = ['delivered', 'silent', 'not_requested', 'failed', 'uncertain'] as const

type Operation = 'ensure-bound' | 'replace-bound' | 'delete-bound' | 'get-bound'

type ClientLike = {
  ensureBound(spec: unknown): Promise<unknown>
  replaceBound(spec: unknown): Promise<unknown>
  deleteBound(externalRef: string): Promise<unknown>
  getBound(externalRef: string): Promise<unknown>
  readiness(): Promise<unknown>
}

export interface AssistantCronControlSocketConfig {
  readonly socketPath: string
  readonly timeoutMs?: number
}

type Failure = Extract<AssistantCronControlResult, { readonly ok: false }>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string'
}

function errorResult(error: unknown, fallbackCode = 'control_unavailable'): Failure {
  if (isRecord(error)) {
    return {
      ok: false,
      code: typeof error.code === 'string' ? error.code : fallbackCode,
      message: typeof error.message === 'string' ? error.message : String(error),
    }
  }
  return { ok: false, code: fallbackCode, message: error instanceof Error ? error.message : String(error) }
}

function decodeSchedule(value: unknown): AssistantCronSchedule | undefined {
  if (!isRecord(value)) return undefined
  if (value.kind === 'cron' && nonEmptyString(value.expr)) return { kind: 'cron', expr: value.expr }
  if (value.kind === 'interval' && typeof value.minutes === 'number' && Number.isFinite(value.minutes) && value.minutes > 0) {
    return { kind: 'interval', minutes: value.minutes }
  }
  if (value.kind === 'once' && nonEmptyString(value.runAt)) return { kind: 'once', runAt: value.runAt }
  return undefined
}

function decodeJob(value: unknown): AssistantCronActiveJob | null | undefined {
  if (value === null) return null
  if (!isRecord(value)) return undefined
  const schedule = decodeSchedule(value.schedule)
  if (!nonEmptyString(value.id) || !nonEmptyString(value.externalRef) || schedule === undefined
    || !nonEmptyString(value.prompt) || !optionalString(value.cwd) || !nonEmptyString(value.createdAt)
    || (value.deliver !== 'default' && value.deliver !== 'silent')
    || value.sessionMode !== 'per_run') return undefined
  return {
    id: value.id,
    externalRef: value.externalRef,
    schedule,
    prompt: value.prompt,
    ...(value.cwd === undefined ? {} : { cwd: value.cwd }),
    createdAt: value.createdAt,
  }
}

function includes<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && values.includes(value as T)
}

function decodeRun(value: unknown): AssistantCronLatestRun | null | undefined {
  if (value === null) return null
  if (!isRecord(value)
    || !nonEmptyString(value.runId)
    || !nonEmptyString(value.jobId)
    || !nonEmptyString(value.scheduledFor)
    || !nonEmptyString(value.finishedAt)
    || !includes(RUN_STATUSES, value.runStatus)
    || !optionalString(value.summary)
    || !optionalString(value.error)
    || !includes(DELIVERY_STATES, value.deliveryState)
    || !optionalString(value.deliveredAt)
    || !optionalString(value.deliveryError)) return undefined
  return {
    runId: value.runId,
    jobId: value.jobId,
    scheduledFor: value.scheduledFor,
    finishedAt: value.finishedAt,
    runStatus: value.runStatus,
    ...(value.summary === undefined ? {} : { summary: value.summary }),
    ...(value.error === undefined ? {} : { error: value.error }),
    deliveryState: value.deliveryState,
    ...(value.deliveredAt === undefined ? {} : { deliveredAt: value.deliveredAt }),
    ...(value.deliveryError === undefined ? {} : { deliveryError: value.deliveryError }),
  }
}

function decodeSnapshot(value: unknown): AssistantCronBindingSnapshot | undefined {
  if (!isRecord(value) || !nonEmptyString(value.externalRef)) return undefined
  const activeJob = decodeJob(value.activeJob)
  const latestRun = decodeRun(value.latestRun)
  if (activeJob === undefined || latestRun === undefined) return undefined
  return { externalRef: value.externalRef, activeJob, latestRun }
}

function mapResponse(value: unknown, operation: Operation): AssistantCronControlResult {
  if (!isRecord(value)) return { ok: false, code: 'protocol_error', message: 'control service returned an invalid response' }
  if (value.protocolVersion !== ASSISTANT_CRON_CONTROL_PROTOCOL_VERSION) {
    return { ok: false, code: 'protocol_error', message: 'control protocol version mismatch' }
  }
  if (value.ok === true) {
    if (value.operation !== operation) {
      return { ok: false, code: 'protocol_error', message: 'control operation mismatch' }
    }
    const snapshot = decodeSnapshot(value.snapshot)
    return snapshot === undefined
      ? { ok: false, code: 'protocol_error', message: 'control service returned an invalid snapshot' }
      : { ok: true, snapshot }
  }
  if (value.ok === false && nonEmptyString(value.errorCode) && nonEmptyString(value.message)) {
    if (value.operation !== undefined && value.operation !== operation) {
      return { ok: false, code: 'protocol_error', message: 'control operation mismatch' }
    }
    return { ok: false, code: value.errorCode, message: value.message }
  }
  return { ok: false, code: 'protocol_error', message: 'control service returned an invalid response' }
}

function wireSpec(spec: AssistantCronBindingSpec): Record<string, unknown> {
  return {
    externalRef: spec.externalRef,
    schedule: spec.schedule,
    prompt: spec.prompt,
    ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
    deliver: 'default',
    sessionMode: 'per_run',
  }
}

async function callOperation(operation: Operation, call: () => Promise<unknown>): Promise<AssistantCronControlResult> {
  try {
    return mapResponse(await call(), operation)
  } catch (error: unknown) {
    return errorResult(error)
  }
}

export function createAssistantCronControlAdapter(input: { readonly client: ClientLike }): AssistantCronControlPort {
  return {
    ensureBound: spec => callOperation('ensure-bound', () => input.client.ensureBound(wireSpec(spec))),
    replaceBound: spec => callOperation('replace-bound', () => input.client.replaceBound(wireSpec(spec))),
    deleteBound: externalRef => callOperation('delete-bound', () => input.client.deleteBound(externalRef)),
    getBound: externalRef => callOperation('get-bound', () => input.client.getBound(externalRef)),
    readiness: async () => {
      try {
        const value = await input.client.readiness()
        return isRecord(value)
          && value.protocolVersion === ASSISTANT_CRON_CONTROL_PROTOCOL_VERSION
          && value.writer === 'manager'
          && value.ready === true
          ? { state: 'ready' }
          : { state: 'unavailable', reason: 'control protocol or readiness mismatch' }
      } catch (error: unknown) {
        return { state: 'unavailable', reason: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}

function requestJson(
  config: AssistantCronControlSocketConfig,
  method: 'GET' | 'POST',
  path: '/health' | '/rpc',
  body?: unknown,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? undefined : JSON.stringify(body)
    const request = httpRequest({
      socketPath: config.socketPath,
      method,
      path,
      ...(encoded === undefined ? {} : {
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(encoded),
        },
      }),
    }, response => {
      const chunks: Buffer[] = []
      let bytes = 0
      response.on('data', (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        bytes += buffer.length
        if (bytes > MAX_RESPONSE_BYTES) {
          request.destroy(new Error('control response is too large'))
          return
        }
        chunks.push(buffer)
      })
      response.once('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown)
        } catch {
          reject({ code: 'protocol_error', message: 'control response is not JSON' })
        }
      })
    })
    request.once('error', error => reject(error))
    request.setTimeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS, () => {
      request.destroy()
      reject({ code: 'timeout', message: 'control request timed out' })
    })
    request.end(encoded)
  })
}

function createSocketClient(config: AssistantCronControlSocketConfig): ClientLike {
  const rpc = (body: Record<string, unknown>) => requestJson(config, 'POST', '/rpc', body)
  return {
    ensureBound: spec => rpc({ protocolVersion: 2, operation: 'ensure-bound', spec }),
    replaceBound: spec => rpc({ protocolVersion: 2, operation: 'replace-bound', spec }),
    deleteBound: externalRef => rpc({ protocolVersion: 2, operation: 'delete-bound', externalRef }),
    getBound: externalRef => rpc({ protocolVersion: 2, operation: 'get-bound', externalRef }),
    readiness: () => requestJson(config, 'GET', '/health'),
  }
}

export function createAssistantCronControlAdapterFromSocket(config: AssistantCronControlSocketConfig): AssistantCronControlPort {
  return createAssistantCronControlAdapter({ client: createSocketClient(config) })
}
