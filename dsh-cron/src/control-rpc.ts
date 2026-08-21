/**
 * Narrow HTTP-over-Unix-socket transport for the dsh-cron control service.
 *
 * The socket is hosted by the existing manager process. There is no queue,
 * event stream, child process, or second persistence source here.
 */

import { chmodSync, lstatSync, mkdirSync, renameSync, unlinkSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { createConnection } from 'node:net'
import { dirname } from 'node:path'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type {
  ControlErrorResponse,
  ControlHealthResponse,
  ControlRequest,
  ControlResponse,
  ControlRpcOperation,
  DshCronControlClient,
  DshCronControlClientError,
} from './control-contract.ts'
import {
  isValidBoundCronCommandSpec,
  isValidBoundCronSpec,
  isValidFailureAlertPolicyUpdate,
} from './control.ts'
import {
  CONTROL_HEALTH_METHOD,
  CONTROL_HEALTH_PATH,
  CONTROL_PROTOCOL_VERSION,
  CONTROL_RPC_OPERATIONS,
} from './control-contract.ts'

const DEFAULT_TIMEOUT_MS = 5_000
const MAX_BODY_BYTES = 1_048_576
const CONTROL_ERROR_CODES = [
  'invalid_request',
  'binding_conflict',
  'persistence_uncertain',
  'internal_error',
] as const

export interface ControlRpcServerConfig {
  readonly socketPath: string
  readonly control: DshCronControlClient
  readonly environment?: 'development' | 'production'
}

export interface ControlRpcClientConfig {
  readonly socketPath: string
  readonly timeoutMs?: number
}

interface SocketProbeOverride {
  readonly sameUid?: boolean
  readonly connection?: 'refused' | 'accepted' | 'unknown'
  readonly symlink?: boolean
  readonly exactPath?: boolean
}

interface ControlRpcServerTestConfig extends ControlRpcServerConfig {
  readonly socketProbe: SocketProbeOverride
}

type ServerIdentity = { readonly dev: number; readonly ino: number }

function jsonResponse(res: ServerResponse, statusCode: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.statusCode = statusCode
  res.setHeader('content-type', 'application/json')
  res.setHeader('content-length', Buffer.byteLength(body))
  res.end(body)
}

function localError(
  code: DshCronControlClientError['code'],
  message: string,
  operation?: DshCronControlClientError['operation'],
): DshCronControlClientError {
  return {
    code,
    message,
    ...(operation === undefined ? {} : { operation }),
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validExternalRef(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function invalidRequest(operation?: ControlErrorResponse['operation']): ControlErrorResponse {
  return {
    protocolVersion: CONTROL_PROTOCOL_VERSION,
    ok: false,
    ...(operation === undefined ? {} : { operation }),
    errorCode: 'invalid_request',
    message: 'The control request is invalid.',
  }
}

function internalError(operation: ControlErrorResponse['operation']): ControlErrorResponse {
  return {
    protocolVersion: CONTROL_PROTOCOL_VERSION,
    ok: false,
    ...(operation === undefined ? {} : { operation }),
    errorCode: 'internal_error',
    message: 'The control operation failed.',
  }
}

function parseRequest(value: unknown): ControlRequest | ControlErrorResponse {
  if (!isObject(value) || value.protocolVersion !== CONTROL_PROTOCOL_VERSION) return invalidRequest()
  const operation = value.operation as ControlRpcOperation
  if (!CONTROL_RPC_OPERATIONS.includes(operation)) return invalidRequest()
  if (operation === 'ensure-bound') {
    return isValidBoundCronSpec(value.spec)
      ? { protocolVersion: CONTROL_PROTOCOL_VERSION, operation: 'ensure-bound', spec: value.spec }
      : invalidRequest('ensure-bound')
  }
  if (operation === 'replace-bound') {
    return isValidBoundCronSpec(value.spec)
      ? { protocolVersion: CONTROL_PROTOCOL_VERSION, operation: 'replace-bound', spec: value.spec }
      : invalidRequest('replace-bound')
  }
  if (operation === 'delete-bound') {
    return validExternalRef(value.externalRef)
      ? { protocolVersion: CONTROL_PROTOCOL_VERSION, operation: 'delete-bound', externalRef: value.externalRef }
      : invalidRequest('delete-bound')
  }
  if (operation === 'get-bound') {
    return validExternalRef(value.externalRef)
      ? { protocolVersion: CONTROL_PROTOCOL_VERSION, operation: 'get-bound', externalRef: value.externalRef }
      : invalidRequest('get-bound')
  }
  if (operation === 'ensure-bound-command') {
    return isValidBoundCronCommandSpec(value.spec)
      ? { protocolVersion: CONTROL_PROTOCOL_VERSION, operation: 'ensure-bound-command', spec: value.spec }
      : invalidRequest('ensure-bound-command')
  }
  if (operation === 'replace-bound-command') {
    return isValidBoundCronCommandSpec(value.spec)
      ? { protocolVersion: CONTROL_PROTOCOL_VERSION, operation: 'replace-bound-command', spec: value.spec }
      : invalidRequest('replace-bound-command')
  }
  if (operation === 'get-bound-command') {
    return validExternalRef(value.externalRef)
      ? { protocolVersion: CONTROL_PROTOCOL_VERSION, operation: 'get-bound-command', externalRef: value.externalRef }
      : invalidRequest('get-bound-command')
  }
  return validExternalRef(value.externalRef) && isValidFailureAlertPolicyUpdate(value.failureAlert)
    ? {
        protocolVersion: CONTROL_PROTOCOL_VERSION,
        operation: 'update-bound-failure-alert',
        externalRef: value.externalRef,
        failureAlert: value.failureAlert,
      }
    : invalidRequest('update-bound-failure-alert')
}

function isControlResponseShape(value: unknown): value is ControlResponse {
  if (!isObject(value) || typeof value.protocolVersion !== 'number' || typeof value.ok !== 'boolean') return false
  if (value.ok === true) return CONTROL_RPC_OPERATIONS.includes(value.operation as ControlRpcOperation) && isObject(value.snapshot)
  return CONTROL_ERROR_CODES.includes(value.errorCode as (typeof CONTROL_ERROR_CODES)[number]) && typeof value.message === 'string'
}

function isControlResponse(value: unknown): value is ControlResponse {
  return isControlResponseShape(value) && value.protocolVersion === CONTROL_PROTOCOL_VERSION
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('request body is not JSON')
  }
}

function probeSocket(socketPath: string): Promise<'refused' | 'accepted' | 'unknown'> {
  return new Promise(resolve => {
    let settled = false
    const socket = createConnection({ path: socketPath })
    const finish = (result: 'refused' | 'accepted' | 'unknown') => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(result)
    }
    socket.once('connect', () => finish('accepted'))
    socket.once('error', error => finish((error as NodeJS.ErrnoException).code === 'ECONNREFUSED' ? 'refused' : 'unknown'))
    socket.setTimeout(250, () => finish('unknown'))
  })
}

async function prepareSocketPath(socketPath: string, override?: SocketProbeOverride): Promise<void> {
  let stat
  try {
    stat = lstatSync(socketPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (override !== undefined) {
    if (override.exactPath !== true || override.symlink === true || override.sameUid !== true || override.connection !== 'refused') {
      throw new Error('unsafe stale socket path')
    }
    unlinkSync(socketPath)
    return
  }
  if (stat.isSymbolicLink() || !stat.isSocket()) throw new Error('control path is not an exact Unix socket')
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error('control socket has a different owner')
  const result = await probeSocket(socketPath)
  if (result === 'refused') {
    unlinkSync(socketPath)
    return
  }
  throw new Error(result === 'accepted' ? 'control socket is already owned' : 'control socket ownership is unproven')
}

class ControlRpcServer {
  private readonly server: Server
  private identity: ServerIdentity | undefined
  private listening = false

  constructor(
    private readonly config: ControlRpcServerConfig,
    private readonly socketProbeOverride?: SocketProbeOverride,
  ) {
    this.server = createHttpServer((req, res) => {
      void this.handle(req, res)
    })
  }

  async listen(): Promise<void> {
    if (this.listening) return
    const parent = dirname(this.config.socketPath)
    mkdirSync(parent, { recursive: true, mode: 0o700 })
    chmodSync(parent, 0o700)
    await prepareSocketPath(this.config.socketPath, this.socketProbeOverride)
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.server.off('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        this.server.off('error', onError)
        resolve()
      }
      this.server.once('error', onError)
      this.server.once('listening', onListening)
      this.server.listen(this.config.socketPath)
    })
    chmodSync(this.config.socketPath, 0o600)
    const stat = lstatSync(this.config.socketPath)
    this.identity = { dev: stat.dev, ino: stat.ino }
    this.listening = true
  }

  async dispose(): Promise<void> {
    const identity = this.identity
    this.identity = undefined
    let replacementBackup: string | undefined
    try {
      if (identity !== undefined) {
        try {
          const current = lstatSync(this.config.socketPath)
          const ownsPath = current.dev === identity.dev && current.ino === identity.ino && current.isSocket()
          if (!ownsPath) {
            replacementBackup = `${this.config.socketPath}.dispose-${randomUUID()}`
            renameSync(this.config.socketPath, replacementBackup)
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
      if (this.listening) await new Promise<void>(resolve => this.server.close(() => resolve()))
    } finally {
      this.listening = false
      if (replacementBackup !== undefined) renameSync(replacementBackup, this.config.socketPath)
    }
    if (identity === undefined || replacementBackup !== undefined) return
    try {
      const current = lstatSync(this.config.socketPath)
      if (current.dev === identity.dev && current.ino === identity.ino && current.isSocket()) unlinkSync(this.config.socketPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === CONTROL_HEALTH_METHOD && req.url === CONTROL_HEALTH_PATH) {
      try {
        jsonResponse(res, 200, await this.config.control.readiness())
      } catch {
        jsonResponse(res, 503, { protocolVersion: CONTROL_PROTOCOL_VERSION, writer: 'manager', ready: false })
      }
      return
    }
    if (req.method !== 'POST' || req.url !== '/rpc') {
      jsonResponse(res, 404, { error: 'not found' })
      return
    }
    let parsed: ControlRequest | ControlErrorResponse
    try {
      parsed = parseRequest(await readBody(req))
    } catch {
      jsonResponse(res, 400, invalidRequest())
      return
    }
    if ('errorCode' in parsed) {
      jsonResponse(res, 400, parsed)
      return
    }
    let response: unknown
    try {
      response = parsed.operation === 'ensure-bound'
        ? await this.config.control.ensureBound(parsed.spec)
        : parsed.operation === 'replace-bound'
          ? await this.config.control.replaceBound(parsed.spec)
          : parsed.operation === 'delete-bound'
            ? await this.config.control.deleteBound(parsed.externalRef)
            : parsed.operation === 'get-bound'
              ? await this.config.control.getBound(parsed.externalRef)
              : parsed.operation === 'ensure-bound-command'
                ? await this.config.control.ensureBoundCommand(parsed.spec)
              : parsed.operation === 'replace-bound-command'
                  ? await this.config.control.replaceBoundCommand(parsed.spec)
                  : parsed.operation === 'get-bound-command'
                    ? await this.config.control.getBoundCommand(parsed.externalRef)
                    : await this.config.control.updateBoundFailureAlert(parsed.externalRef, parsed.failureAlert)
    } catch {
      response = internalError(parsed.operation)
    }
    jsonResponse(res, isControlResponseShape(response) ? 200 : 500, isControlResponseShape(response) ? response : internalError(parsed.operation))
  }
}

export function createControlRpcServer(config: ControlRpcServerConfig): Pick<ControlRpcServer, 'listen' | 'dispose'> {
  return new ControlRpcServer(config)
}

/** Test-only seam for proving stale-path safety without caller-controlled production options. */
export function createControlRpcServerForTest(config: ControlRpcServerTestConfig): Pick<ControlRpcServer, 'listen' | 'dispose'> {
  return new ControlRpcServer(config, config.socketProbe)
}

function requestJson(
  config: ControlRpcClientConfig,
  method: 'GET' | 'POST',
  path: string,
  body: unknown,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const req = httpRequest({
      socketPath: config.socketPath,
      method,
      path,
      timeout: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      ...(payload === undefined ? {} : {
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
      }),
    }, response => {
      let text = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { text += chunk })
      response.on('end', () => {
        try {
          resolve(JSON.parse(text))
        } catch {
          reject(new Error('control response is not JSON'))
        }
      })
    })
    req.on('timeout', () => req.destroy(new Error('control request timed out')))
    req.on('error', reject)
    if (payload !== undefined) req.end(payload)
    else req.end()
  })
}

function protocolError(operation?: DshCronControlClientError['operation']): DshCronControlClientError {
  return localError('protocol_error', 'The control response protocol version or shape is invalid.', operation)
}

function unavailable(operation?: DshCronControlClientError['operation']): DshCronControlClientError {
  return localError('control_unavailable', 'The control socket is unavailable.', operation)
}

function timedOut(operation?: DshCronControlClientError['operation']): DshCronControlClientError {
  return localError('timeout', 'The control socket request timed out.', operation)
}

function isTimeoutError(error: unknown): boolean {
  if (!isObject(error)) return false
  return error.code === 'ETIMEDOUT' || error.code === 'ESOCKETTIMEDOUT'
    || (typeof error.message === 'string' && error.message.includes('timed out'))
}

function isHealthResponse(value: unknown): value is ControlHealthResponse {
  return isObject(value) && value.protocolVersion === CONTROL_PROTOCOL_VERSION && value.writer === 'manager' && value.ready === true
}

export function createControlRpcClient(config: ControlRpcClientConfig): DshCronControlClient {
  async function operation(request: ControlRequest): Promise<ControlResponse | DshCronControlClientError> {
    try {
      const response = await requestJson(config, 'POST', '/rpc', request)
      if (!isControlResponse(response)) return protocolError(request.operation)
      return response
    } catch (error) {
      return isTimeoutError(error) ? timedOut(request.operation) : unavailable(request.operation)
    }
  }

  return {
    ensureBound: spec => operation({ protocolVersion: CONTROL_PROTOCOL_VERSION, operation: 'ensure-bound', spec }),
    replaceBound: spec => operation({ protocolVersion: CONTROL_PROTOCOL_VERSION, operation: 'replace-bound', spec }),
    deleteBound: externalRef => operation({ protocolVersion: CONTROL_PROTOCOL_VERSION, operation: 'delete-bound', externalRef }),
    getBound: externalRef => operation({ protocolVersion: CONTROL_PROTOCOL_VERSION, operation: 'get-bound', externalRef }),
    ensureBoundCommand: spec => operation({ protocolVersion: CONTROL_PROTOCOL_VERSION, operation: 'ensure-bound-command', spec }),
    replaceBoundCommand: spec => operation({ protocolVersion: CONTROL_PROTOCOL_VERSION, operation: 'replace-bound-command', spec }),
    getBoundCommand: externalRef => operation({ protocolVersion: CONTROL_PROTOCOL_VERSION, operation: 'get-bound-command', externalRef }),
    updateBoundFailureAlert: (externalRef, failureAlert) => operation({
      protocolVersion: CONTROL_PROTOCOL_VERSION,
      operation: 'update-bound-failure-alert',
      externalRef,
      failureAlert,
    }),
    readiness: async () => {
      try {
        const response = await requestJson(config, 'GET', CONTROL_HEALTH_PATH, undefined)
        if (!isHealthResponse(response)) throw protocolError()
        return response
      } catch (error) {
        if (isObject(error) && (error as { code?: unknown }).code === 'protocol_error') throw error
        if (isTimeoutError(error)) throw timedOut()
        throw unavailable()
      }
    },
  }
}
