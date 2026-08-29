import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import {
  ASSISTANT_CRON_HEALTH_EXTERNAL_REF,
  ASSISTANT_CRON_SOCKET_PATH,
  runAssistantCronHealth,
} from '../scripts/check-assistant-cron-ready.mjs'

function effectiveConfig(socketLine = `        cronControlSocketPath: ${ASSISTANT_CRON_SOCKET_PATH}`) {
  return [
    '# effective profile',
    '- insert:',
    '    - id: dsh-cron',
    "      name: '@deepseek-ai/dsh-cron'",
    '    - id: dsh-assistant',
    "      name: '@deepseek-ai/dsh-assistant'",
    '      config:',
    '        mode: telegram',
    socketLine,
    '',
  ].join('\n')
}

function fixture({ assistantProtocol = 1, cronProtocol = 1, getOk = true } = {}) {
  const calls = []
  const forbidden = operation => async () => {
    calls.push(operation)
    throw new Error(`${operation} must not be called by health`)
  }
  const assistantModule = {
    ASSISTANT_CRON_CONTROL_PROTOCOL_VERSION: assistantProtocol,
    createAssistantCronControlAdapterFromSocket(config) {
      calls.push(['adapter', config])
      return {
        readiness: async () => {
          calls.push('readiness')
          return { state: 'ready' }
        },
        getBound: async externalRef => {
          calls.push(['getBound', externalRef])
          return getOk
            ? { ok: true, snapshot: { externalRef, activeJob: null, latestRun: null } }
            : { ok: false, code: 'protocol_error', message: 'bad response' }
        },
        ensureBound: forbidden('ensureBound'),
        replaceBound: forbidden('replaceBound'),
        deleteBound: forbidden('deleteBound'),
      }
    },
  }
  const cronModule = { CONTROL_PROTOCOL_VERSION: cronProtocol }
  const accessCalls = []
  return {
    calls,
    accessCalls,
    input: {
      effectiveConfig: effectiveConfig(),
      assistantModule,
      cronModule,
      lstatSync: () => ({ isSocket: () => true }),
      accessSync: (target, mode) => accessCalls.push([target, mode]),
    },
  }
}

test('fails closed when effective assistant config is missing the socket path', async () => {
  const subject = fixture()
  subject.input.effectiveConfig = effectiveConfig('')
  await assert.rejects(
    runAssistantCronHealth(subject.input),
    /missing cronControlSocketPath/u,
  )
  assert.deepEqual(subject.calls, [])
})

test('fails before RPC when the current container user cannot access the socket', async () => {
  const subject = fixture()
  subject.input.accessSync = (target, mode) => {
    subject.accessCalls.push([target, mode])
    if (target === ASSISTANT_CRON_SOCKET_PATH) throw new Error('EACCES')
  }
  await assert.rejects(
    runAssistantCronHealth(subject.input),
    /inaccessible to the current container user/u,
  )
  assert.deepEqual(subject.calls, [])
  assert.deepEqual(subject.accessCalls, [
    ['/home/herman/.dsh/storages/dsh-cron', fs.constants.X_OK],
    [ASSISTANT_CRON_SOCKET_PATH, fs.constants.R_OK | fs.constants.W_OK],
  ])
})

test('fails before RPC when Assistant and dsh-cron protocol versions differ', async () => {
  const subject = fixture({ assistantProtocol: 1, cronProtocol: 2 })
  await assert.rejects(
    runAssistantCronHealth(subject.input),
    /protocol versions are incompatible/u,
  )
  assert.deepEqual(subject.calls, [])
})

test('passes through the public Assistant adapter using readiness and get only', async () => {
  const subject = fixture()
  const result = await runAssistantCronHealth(subject.input)
  assert.deepEqual(result, {
    state: 'ready',
    protocolVersion: 1,
    socketPath: ASSISTANT_CRON_SOCKET_PATH,
    checkedExternalRef: ASSISTANT_CRON_HEALTH_EXTERNAL_REF,
  })
  assert.deepEqual(subject.calls, [
    ['adapter', { socketPath: ASSISTANT_CRON_SOCKET_PATH, timeoutMs: 3_000 }],
    'readiness',
    ['getBound', ASSISTANT_CRON_HEALTH_EXTERNAL_REF],
  ])
})
