/**
 * Outer adapter from the assistant-owned port to the frozen dsh-cron client.
 * No application/store module should import the manager package directly.
 */

import { createControlRpcClient } from '@deepseek-ai/dsh-cron'
import type {
  BoundCronJobView,
  BoundCronSnapshot,
  BoundCronSpec,
  CronRunSnapshot,
  DshCronControlClient,
  DshCronControlClientError,
  ControlResponse,
  ControlRpcClientConfig,
} from '@deepseek-ai/dsh-cron'
import type {
  AssistantCronActiveJob,
  AssistantCronBindingSnapshot,
  AssistantCronBindingSpec,
  AssistantCronControlPort,
  AssistantCronControlResult,
  AssistantCronLatestRun,
} from './cron-control-port.ts'

type ClientLike = Pick<DshCronControlClient, 'ensureBound' | 'replaceBound' | 'deleteBound' | 'getBound' | 'readiness'>

type AssistantCronControlFailure = Extract<AssistantCronControlResult, { readonly ok: false }>

function errorResult(error: unknown, fallbackCode = 'control_unavailable'): AssistantCronControlFailure {
  if (typeof error === 'object' && error !== null) {
    const candidate = error as { code?: unknown; message?: unknown }
    const code = typeof candidate.code === 'string' ? candidate.code : fallbackCode
    const message = typeof candidate.message === 'string' ? candidate.message : String(error)
    return { ok: false, code, message }
  }
  return { ok: false, code: fallbackCode, message: String(error) }
}

function mapRun(run: CronRunSnapshot | null | undefined): AssistantCronLatestRun | null {
  if (run === null || run === undefined) return null
  return {
    runId: run.runId,
    jobId: run.jobId,
    scheduledFor: run.scheduledFor,
    finishedAt: run.finishedAt,
    runStatus: run.runStatus,
    ...(run.summary === undefined ? {} : { summary: run.summary }),
    ...(run.error === undefined ? {} : { error: run.error }),
    deliveryState: run.deliveryState,
    ...(run.deliveredAt === undefined ? {} : { deliveredAt: run.deliveredAt }),
    ...(run.deliveryError === undefined ? {} : { deliveryError: run.deliveryError }),
  }
}

function mapJob(job: BoundCronJobView | null | undefined): AssistantCronActiveJob | null {
  if (job === null || job === undefined) return null
  return {
    id: job.id,
    externalRef: job.externalRef,
    schedule: job.schedule as AssistantCronActiveJob['schedule'],
    prompt: job.prompt,
    ...(job.cwd === undefined ? {} : { cwd: job.cwd }),
    createdAt: job.createdAt,
  }
}

function mapSnapshot(snapshot: BoundCronSnapshot): AssistantCronBindingSnapshot {
  return {
    externalRef: snapshot.externalRef,
    activeJob: mapJob(snapshot.activeJob),
    latestRun: mapRun(snapshot.latestRun),
  }
}

function mapResponse(response: ControlResponse | DshCronControlClientError | unknown): AssistantCronControlResult {
  if (typeof response === 'object' && response !== null) {
    const candidate = response as { ok?: unknown; snapshot?: unknown; errorCode?: unknown; code?: unknown; message?: unknown }
    if (candidate.ok === true && typeof candidate.snapshot === 'object' && candidate.snapshot !== null) {
      return { ok: true, snapshot: mapSnapshot(candidate.snapshot as BoundCronSnapshot) }
    }
    if (candidate.ok === false || typeof candidate.code === 'string' || typeof candidate.errorCode === 'string') {
      const code = typeof candidate.errorCode === 'string'
        ? candidate.errorCode
        : typeof candidate.code === 'string' ? candidate.code : 'internal_error'
      return {
        ok: false,
        code,
        message: typeof candidate.message === 'string' ? candidate.message : 'dsh-cron control operation failed',
      }
    }
  }
  return { ok: false, code: 'protocol_error', message: 'dsh-cron returned an invalid control response' }
}

function toWireSpec(spec: AssistantCronBindingSpec): BoundCronSpec {
  return {
    externalRef: spec.externalRef,
    schedule: spec.schedule as BoundCronSpec['schedule'],
    prompt: spec.prompt,
    ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
    deliver: 'telegram',
    sessionMode: 'per_run',
  }
}

async function callOperation(
  operation: () => Promise<ControlResponse | DshCronControlClientError>,
): Promise<AssistantCronControlResult> {
  try {
    return mapResponse(await operation())
  } catch (error: unknown) {
    return errorResult(error)
  }
}

export function createAssistantCronControlAdapter(input: { readonly client: ClientLike }): AssistantCronControlPort {
  return {
    ensureBound: spec => callOperation(() => input.client.ensureBound(toWireSpec(spec))),
    replaceBound: spec => callOperation(() => input.client.replaceBound(toWireSpec(spec))),
    deleteBound: externalRef => callOperation(() => input.client.deleteBound(externalRef)),
    getBound: externalRef => callOperation(() => input.client.getBound(externalRef)),
    readiness: async () => {
      try {
        const health = await input.client.readiness()
        return health.ready ? { state: 'ready' } : { state: 'unavailable', reason: 'dsh-cron control plane is not ready' }
      } catch (error: unknown) {
        const mapped = errorResult(error)
        return { state: 'unavailable', reason: mapped.message }
      }
    },
  }
}

/** Build the outer adapter from the manager's public Unix-socket client. */
export function createAssistantCronControlAdapterFromSocket(config: ControlRpcClientConfig): AssistantCronControlPort {
  return createAssistantCronControlAdapter({ client: createControlRpcClient(config) })
}
