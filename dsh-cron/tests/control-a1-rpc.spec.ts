/**
 * Lane A1 red tests for the narrow Unix-socket control RPC.
 *
 * The RPC implementation is intentionally absent. The scenarios below keep
 * the transport bounded to the frozen fixture and make socket ownership and
 * stale-path handling observable before implementation begins.
 */

import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CONTROL_HEALTH_METHOD,
  CONTROL_HEALTH_PATH,
  CONTROL_PROTOCOL_VERSION,
  CONTROL_RPC_OPERATIONS,
} from '../src/control-contract.ts'
import type {
  BoundCronCommandSpec,
  BoundCronSpec,
  ControlHealthResponse,
  ControlRequest,
  ControlSuccessResponse,
  DshCronControlClient,
} from '../src/control-contract.ts'
import {
  createControlRpcClient,
  createControlRpcServer,
  createControlRpcServerForTest,
} from '../src/control-rpc.ts'

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cron-a1-rpc-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

type ControlFixture = {
  requests: ControlRequest[]
  health: ControlHealthResponse
  successResponse: ControlSuccessResponse
}

const fixture = JSON.parse(
  // The frozen fixture is read-only evidence; this test does not modify it.
  readFileSync(new URL('./fixtures/control-v2.json', import.meta.url), 'utf8'),
) as ControlFixture

const SPEC = (fixture.requests.find(request => request.operation === 'ensure-bound') as Extract<
  ControlRequest,
  { operation: 'ensure-bound' }
>).spec

const GATED_SPEC: BoundCronSpec = {
  ...SPEC,
  externalRef: 'external:gated-placeholder',
  gate: {
    kind: 'nonempty_stdout',
    command: { argv: ['/usr/bin/python3', '/opt/gate.py'], timeoutSeconds: 120, outputMaxBytes: 65_536 },
  },
}

const ALERT_SPEC: BoundCronSpec = {
  ...SPEC,
  externalRef: 'external:alert-placeholder',
  failureAlert: { after: 2, cooldownMinutes: 30 },
}

const ALERT_COMMAND_SPEC: BoundCronCommandSpec = {
  externalRef: 'external:alert-command-placeholder',
  schedule: { kind: 'cron', expr: '1-59/2 * * * *' },
  command: { argv: ['/bin/false'], timeoutSeconds: 30, outputMaxBytes: 4_096 },
  deliver: 'default',
  failureAlert: { after: 2, cooldownMinutes: 30 },
}

type RpcServer = {
  listen(): Promise<void>
  dispose(): Promise<void>
}

type RpcClient = DshCronControlClient

type SocketProbeOverride = {
  readonly sameUid?: boolean
  readonly connection?: 'refused' | 'accepted' | 'unknown'
  readonly symlink?: boolean
  readonly exactPath?: boolean
}

type FakeControl = {
  readonly control: DshCronControlClient
  readonly calls: {
    ensureBound: number
    replaceBound: number
    deleteBound: number
    getBound: number
    ensureBoundCommand: number
    replaceBoundCommand: number
    getBoundCommand: number
    updateBoundFailureAlert: number
  }
}

function makeControl(): FakeControl {
  const calls = {
    ensureBound: 0,
    replaceBound: 0,
    deleteBound: 0,
    getBound: 0,
    ensureBoundCommand: 0,
    replaceBoundCommand: 0,
    getBoundCommand: 0,
    updateBoundFailureAlert: 0,
  }
  return {
    calls,
    control: {
      ensureBound: async (_spec: BoundCronSpec) => {
        calls.ensureBound += 1
        return fixture.successResponse
      },
      replaceBound: async (_spec: BoundCronSpec) => {
        calls.replaceBound += 1
        return fixture.successResponse
      },
      deleteBound: async (_externalRef: string) => {
        calls.deleteBound += 1
        return fixture.successResponse
      },
      getBound: async (_externalRef: string) => {
        calls.getBound += 1
        return fixture.successResponse
      },
      ensureBoundCommand: async (_spec: BoundCronCommandSpec) => {
        calls.ensureBoundCommand += 1
        return fixture.successResponse
      },
      replaceBoundCommand: async (_spec: BoundCronCommandSpec) => {
        calls.replaceBoundCommand += 1
        return fixture.successResponse
      },
      getBoundCommand: async (_externalRef: string) => {
        calls.getBoundCommand += 1
        return fixture.successResponse
      },
      updateBoundFailureAlert: async (_externalRef, _failureAlert) => {
        calls.updateBoundFailureAlert += 1
        return {
          ...fixture.successResponse,
          operation: 'update-bound-failure-alert',
        }
      },
      readiness: async () => fixture.health,
    },
  }
}

function makeServerWithControl(socketPath: string, fake: FakeControl): RpcServer {
  return createControlRpcServer({
    socketPath,
    control: fake.control,
    environment: 'development',
  }) as unknown as RpcServer
}

function makeServer(socketPath: string): RpcServer {
  return makeServerWithControl(socketPath, makeControl())
}

function makeTestOnlyServer(socketPath: string, socketProbe: SocketProbeOverride): RpcServer {
  const fake = makeControl()
  return createControlRpcServerForTest({
    socketPath,
    control: fake.control,
    socketProbe,
  }) as unknown as RpcServer
}

function makeClient(socketPath: string): RpcClient {
  return createControlRpcClient({ socketPath }) as unknown as RpcClient
}

async function abandonSocketInChild(socketPath: string): Promise<void> {
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "import net from 'node:net'; const server = net.createServer(); server.listen(process.env.DSH_A1_SOCKET_PATH);",
    ],
    {
      env: { ...process.env, DSH_A1_SOCKET_PATH: socketPath },
      stdio: 'ignore',
    },
  )
  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        if (lstatSync(socketPath).isSocket()) break
      } catch {
        // The child has not finished binding yet.
      }
      await delay(10)
    }
    expect(lstatSync(socketPath).isSocket()).toBe(true)
    child.kill('SIGKILL')
    await once(child, 'exit')
    expect(lstatSync(socketPath).isSocket()).toBe(true)
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL')
  }
}

function rawRpc(socketPath: string, payload: unknown): Promise<{ statusCode?: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const requestBody = JSON.stringify(payload)
    const req = request({
      socketPath,
      method: 'POST',
      path: '/rpc',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(requestBody),
      },
    }, response => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { body += chunk })
      response.on('end', () => {
        try {
          resolve({ statusCode: response.statusCode, body: JSON.parse(body) })
        } catch {
          reject(new Error(`RPC response was not JSON: ${body}`))
        }
      })
    })
    req.on('error', reject)
    req.end(requestBody)
  })
}

describe('Lane A1 narrow control RPC', () => {
  it('round-trips frozen requests through a public client over a real Unix socket', async () => {
    const socketPath = join(tempDir(), 'control.sock')
    const server = makeServer(socketPath)
    await server.listen()
    const client = makeClient(socketPath)

    expect(fixture.requests.map(request => request.operation)).toEqual(CONTROL_RPC_OPERATIONS.slice(0, 4))
    for (const request of fixture.requests) {
      const response = request.operation === 'ensure-bound'
        ? await client.ensureBound(request.spec)
        : request.operation === 'replace-bound'
          ? await client.replaceBound(request.spec)
          : request.operation === 'delete-bound'
            ? await client.deleteBound(request.externalRef)
            : await client.getBound(request.externalRef)
      expect(response.protocolVersion).toBe(CONTROL_PROTOCOL_VERSION)
    }

    expect(await client.readiness()).toEqual(fixture.health)
    expect(CONTROL_HEALTH_METHOD).toBe('GET')
    expect(CONTROL_HEALTH_PATH).toBe('/health')
    await server.dispose()
  })

  it('round-trips the optional generic command gate without adding a business-specific RPC operation', async () => {
    const socketPath = join(tempDir(), 'control.sock')
    const fake = makeControl()
    const server = makeServerWithControl(socketPath, fake)
    await server.listen()
    const client = makeClient(socketPath)

    const response = await client.ensureBound(GATED_SPEC)

    expect(response.protocolVersion).toBe(CONTROL_PROTOCOL_VERSION)
    expect(fake.calls.ensureBound).toBe(1)
    expect(CONTROL_RPC_OPERATIONS).not.toContain('ensure-info-feed')
    await server.dispose()
  })

  it('round-trips bounded per-job failureAlert for Agent and command requests without adding RPC operations', async () => {
    const socketPath = join(tempDir(), 'control.sock')
    const fake = makeControl()
    const server = makeServerWithControl(socketPath, fake)
    await server.listen()
    const client = makeClient(socketPath)

    const agent = await client.ensureBound(ALERT_SPEC)
    const command = await client.ensureBoundCommand(ALERT_COMMAND_SPEC)

    expect(agent.protocolVersion).toBe(CONTROL_PROTOCOL_VERSION)
    expect(command.protocolVersion).toBe(CONTROL_PROTOCOL_VERSION)
    expect(fake.calls.ensureBound).toBe(1)
    expect(fake.calls.ensureBoundCommand).toBe(1)
    expect(CONTROL_RPC_OPERATIONS).not.toContain('send-failure-alert')
    await server.dispose()
  })

  it('round-trips the generic set-or-clear failureAlert operation for either binding kind', async () => {
    const socketPath = join(tempDir(), 'control.sock')
    const fake = makeControl()
    const server = makeServerWithControl(socketPath, fake)
    await server.listen()
    const client = makeClient(socketPath)

    const set = await client.updateBoundFailureAlert('external:alert-placeholder', {
      after: 2,
      cooldownMinutes: 30,
    })
    const clear = await client.updateBoundFailureAlert('external:alert-command-placeholder', null)

    expect(set).toMatchObject({ protocolVersion: 2, ok: true, operation: 'update-bound-failure-alert' })
    expect(clear).toMatchObject({ protocolVersion: 2, ok: true, operation: 'update-bound-failure-alert' })
    expect(fake.calls.updateBoundFailureAlert).toBe(2)
    await server.dispose()
  })

  it('rejects unknown operations, bad versions, and malformed specs without calling fake control', async () => {
    const socketPath = join(tempDir(), 'control.sock')
    const fake = makeControl()
    const server = makeServerWithControl(socketPath, fake)
    await server.listen()

    const invalidRequests = [
      { protocolVersion: 2, operation: 'unknown-operation' },
      { protocolVersion: 99, operation: 'get-bound', externalRef: 'external:placeholder' },
      { protocolVersion: 2, operation: 'ensure-bound', spec: { externalRef: '', sessionMode: 'persistent' } },
      { protocolVersion: 2, operation: 'ensure-bound', spec: { ...SPEC, schedule: { kind: 'cron', expr: '60 * * * *' } } },
      { protocolVersion: 2, operation: 'replace-bound', spec: { ...SPEC, schedule: { kind: 'interval', minutes: 0 } } },
      { protocolVersion: 2, operation: 'ensure-bound', spec: { ...SPEC, schedule: { kind: 'once', runAt: 'not-a-date' } } },
      { protocolVersion: 2, operation: 'ensure-bound', spec: { ...SPEC, gate: { kind: 'business-specific-gate', command: { argv: ['x'], timeoutSeconds: 1, outputMaxBytes: 1 } } } },
      { protocolVersion: 2, operation: 'ensure-bound', spec: { ...SPEC, gate: { kind: 'nonempty_stdout', command: { argv: [], timeoutSeconds: 1, outputMaxBytes: 1 } } } },
      { protocolVersion: 2, operation: 'ensure-bound', spec: { ...SPEC, failureAlert: { after: 0, cooldownMinutes: 30 } } },
      { protocolVersion: 2, operation: 'ensure-bound-command', spec: { ...ALERT_COMMAND_SPEC, deliver: 'silent' } },
      { protocolVersion: 2, operation: 'update-bound-failure-alert', externalRef: '', failureAlert: null },
      { protocolVersion: 2, operation: 'update-bound-failure-alert', externalRef: 'external:placeholder' },
      { protocolVersion: 2, operation: 'update-bound-failure-alert', externalRef: 'external:placeholder', failureAlert: { after: 0, cooldownMinutes: 30 } },
    ]
    for (const requestBody of invalidRequests) {
      const response = await rawRpc(socketPath, requestBody)
      expect(response.body).toMatchObject({ protocolVersion: 2, ok: false, errorCode: 'invalid_request' })
    }
    expect(fake.calls).toEqual({
      ensureBound: 0,
      replaceBound: 0,
      deleteBound: 0,
      getBound: 0,
      ensureBoundCommand: 0,
      replaceBoundCommand: 0,
      getBoundCommand: 0,
      updateBoundFailureAlert: 0,
    })
    await server.dispose()
  })

  it('maps a missing socket to control_unavailable for operations and rejects readiness', async () => {
    const client = makeClient(join(tempDir(), 'missing.sock'))

    await expect(client.getBound('external:placeholder')).resolves.toMatchObject({ code: 'control_unavailable' })
    await expect(client.readiness()).rejects.toMatchObject({ code: 'control_unavailable' })
  })

  it('maps an unexpected protocol version from the server to protocol_error', async () => {
    const socketPath = join(tempDir(), 'control.sock')
    const fake = makeControl()
    fake.control.getBound = async (_externalRef: string) => ({
      ...fixture.successResponse,
      protocolVersion: 99,
    }) as never
    fake.control.readiness = async () => ({
      ...fixture.health,
      protocolVersion: 99,
    }) as never
    const server = makeServerWithControl(socketPath, fake)
    await server.listen()
    const client = makeClient(socketPath)

    await expect(client.getBound('external:placeholder')).resolves.toMatchObject({ code: 'protocol_error' })
    await expect(client.readiness()).rejects.toMatchObject({ code: 'protocol_error' })
    await server.dispose()
  })

  it('creates a 0700 parent directory and 0600 socket', async () => {
    const dir = join(tempDir(), 'private-control')
    const socketPath = join(dir, 'control.sock')
    const server = makeServer(socketPath)

    await server.listen()

    expect(lstatSync(dir).mode & 0o777).toBe(0o700)
    expect(lstatSync(socketPath).mode & 0o777).toBe(0o600)
    await server.dispose()
  })

  it('keeps the first writer healthy through socket health and rejects a second writer', async () => {
    const socketPath = join(tempDir(), 'control.sock')
    const first = makeServer(socketPath)
    const second = makeServer(socketPath)
    await first.listen()

    const client = makeClient(socketPath)
    await expect(second.listen()).rejects.toThrow()
    await expect(client.readiness()).resolves.toEqual(fixture.health)
    await first.dispose()
  })

  it('clears only a same-uid exact socket whose probe gets ECONNREFUSED', async () => {
    const socketPath = join(tempDir(), 'stale.sock')
    await abandonSocketInChild(socketPath)

    const server = makeServer(socketPath)
    await server.listen()
    await server.dispose()
  })

  it('rejects ordinary files, symlinks, wrong uid, and an unproven connection', async () => {
    const dir = tempDir()
    const ordinaryPath = join(dir, 'ordinary')
    writeFileSync(ordinaryPath, 'placeholder', 'utf8')
    await expect(makeServer(ordinaryPath).listen()).rejects.toThrow()

    const target = join(dir, 'target')
    writeFileSync(target, 'placeholder', 'utf8')
    const link = join(dir, 'link')
    symlinkSync(target, link)
    await expect(makeServer(link).listen()).rejects.toThrow()
    expect(lstatSync(target).isFile()).toBe(true)
    expect(lstatSync(link).isSymbolicLink()).toBe(true)

    const wrongUidPath = join(dir, 'wrong-uid.sock')
    await abandonSocketInChild(wrongUidPath)
    await expect(makeTestOnlyServer(wrongUidPath, {
      sameUid: false,
      connection: 'refused',
      symlink: false,
      exactPath: true,
    }).listen()).rejects.toThrow()
    expect(lstatSync(wrongUidPath).isSocket()).toBe(true)

    const unknownPath = join(dir, 'unknown.sock')
    await abandonSocketInChild(unknownPath)
    await expect(makeTestOnlyServer(unknownPath, {
      sameUid: true,
      connection: 'unknown',
      symlink: false,
      exactPath: true,
    }).listen()).rejects.toThrow()
    expect(lstatSync(unknownPath).isSocket()).toBe(true)
  })

  it('does not unlink a replacement path when dispose loses the original dev+ino', async () => {
    const socketPath = join(tempDir(), 'control.sock')
    const server = makeServer(socketPath)
    await server.listen()

    rmSync(socketPath)
    writeFileSync(socketPath, 'replacement', 'utf8')
    chmodSync(socketPath, 0o600)
    await server.dispose()

    expect(lstatSync(socketPath).isFile()).toBe(true)
  })
})
