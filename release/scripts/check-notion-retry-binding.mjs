#!/usr/bin/env node

import { createHash } from 'node:crypto'
import {
  accessSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const NOTION_RETRY_EXTERNAL_REF = 'dsh:notion-task-inbox:retry:v1'
export const CRON_CONTROL_SOCKET = '/home/herman/.dsh/storages/dsh-cron/control.sock'

const cronPublicEntry = '/opt/dsh/harness/local-plugins/dsh-cron/lib/index.js'
const MAX_ENTRYPOINT_BYTES = 1024 * 1024
const REQUIRED_INTERFACE_TOKENS = [
  '--pull', '--set', '--push', '--force', '--retry-pending', '--json',
  'NOTION_TOKEN_FILE', 'NOTION_INBOX_FILE', 'NOTION_API_BASE', 'NOTION_PAGE_ID',
]
const FORBIDDEN_INTERFACE_TOKENS = [
  '.openclaw', 'NOTION_API_KEY', 'NOTION_ENV_FILE', '/home/herman/task-inbox-workflow',
]

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`
}

function specSha256(value) {
  return createHash('sha256').update(canonicalize(value), 'utf8').digest('hex')
}

function within(root, value) {
  const relative = path.relative(root, value)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

export function inspectLiveEntrypoint(automationRoot, entrypoint) {
  const rootEntry = lstatSync(automationRoot)
  const scriptEntry = lstatSync(entrypoint)
  if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()
    || !scriptEntry.isFile() || scriptEntry.isSymbolicLink() || scriptEntry.nlink !== 1
    || scriptEntry.size < 1 || scriptEntry.size > MAX_ENTRYPOINT_BYTES) {
    throw new Error('invalid automation entrypoint type')
  }
  const realRoot = realpathSync(automationRoot)
  const realEntrypoint = realpathSync(entrypoint)
  if (!within(realRoot, realEntrypoint)) throw new Error('automation entrypoint escapes DSH_HOME')
  accessSync(realEntrypoint, constants.R_OK)
  const descriptor = openSync(realEntrypoint, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const current = fstatSync(descriptor)
    if (!current.isFile() || current.nlink !== 1 || current.size !== scriptEntry.size
      || current.ino !== scriptEntry.ino || current.dev !== scriptEntry.dev) {
      throw new Error('automation entrypoint changed while being inspected')
    }
    const bytes = readFileSync(descriptor)
    if (bytes.length !== current.size || bytes.length > MAX_ENTRYPOINT_BYTES) {
      throw new Error('automation entrypoint size changed while being inspected')
    }
    const source = bytes.toString('utf8')
    if (REQUIRED_INTERFACE_TOKENS.some(token => !source.includes(token))
      || FORBIDDEN_INTERFACE_TOKENS.some(token => source.includes(token))) {
      throw new Error('automation entrypoint does not expose the Harness-owned Notion contract')
    }
    return {
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.length,
    }
  } finally {
    closeSync(descriptor)
  }
}

/** Read-only release guard for the live-Harness-owned retry binding. */
export async function checkNotionRetryBinding({
  client,
  dshHome = '/home/herman/.dsh',
  inspectEntrypoint = inspectLiveEntrypoint,
}) {
  const readiness = await client.readiness()
  if (readiness?.ready !== true || readiness?.protocolVersion !== 1 || readiness?.writer !== 'manager') {
    throw new Error('dsh-cron manager is not ready for a read-only binding check')
  }
  const response = await client.getBoundCommand(NOTION_RETRY_EXTERNAL_REF)
  if (response?.ok !== true
    || response.operation !== 'get-bound-command'
    || response.protocolVersion !== 1
    || response.snapshot?.externalRef !== NOTION_RETRY_EXTERNAL_REF
    || response.snapshot.activeJob === null) {
    throw new Error('live Harness has not registered the Notion pending-retry binding')
  }
  const job = response.snapshot.activeJob
  const argv = job.command?.argv
  const automationRoot = path.join(dshHome, 'workspace/automations')
  const expectedEntrypoint = path.join(
    dshHome,
    'workspace/automations/notion/notion_inbox_sync.py',
  )
  const entrypoint = Array.isArray(argv) && argv.length === 4 && path.isAbsolute(argv[1])
    ? path.resolve(argv[1])
    : ''
  if (job.externalRef !== NOTION_RETRY_EXTERNAL_REF
    || job.schedule?.kind !== 'interval' || job.schedule.minutes !== 5
    || job.deliver !== 'silent'
    || !Array.isArray(argv) || argv.length !== 4
    || !['python3', '/usr/bin/python3'].includes(argv[0])
    || argv[2] !== '--retry-pending' || argv[3] !== '--json'
    || entrypoint !== expectedEntrypoint
    || !within(automationRoot, entrypoint)
    || !Number.isInteger(job.command.timeoutSeconds) || job.command.timeoutSeconds < 1 || job.command.timeoutSeconds > 300
    || !Number.isInteger(job.command.outputMaxBytes) || job.command.outputMaxBytes < 1 || job.command.outputMaxBytes > 65_536
    || (job.cwd !== undefined && !within(dshHome, path.resolve(job.cwd)))) {
    throw new Error('live Harness Notion pending-retry binding does not match the product contract')
  }
  let entrypointEvidence
  try {
    entrypointEvidence = inspectEntrypoint(automationRoot, entrypoint)
  } catch {
    throw new Error('live Harness Notion pending-retry entrypoint is unavailable')
  }
  if (!entrypointEvidence || typeof entrypointEvidence !== 'object'
    || !/^[0-9a-f]{64}$/u.test(entrypointEvidence.sha256 ?? '')
    || !Number.isSafeInteger(entrypointEvidence.size)
    || entrypointEvidence.size < 1 || entrypointEvidence.size > MAX_ENTRYPOINT_BYTES) {
    throw new Error('live Harness Notion pending-retry entrypoint evidence is invalid')
  }
  const immutableSpec = {
    externalRef: job.externalRef,
    schedule: job.schedule,
    command: job.command,
    deliver: job.deliver,
    ...(job.cwd === undefined ? {} : { cwd: job.cwd }),
    ...(job.failureAlert === undefined ? {} : { failureAlert: job.failureAlert }),
  }
  return {
    status: 'ready',
    externalRef: NOTION_RETRY_EXTERNAL_REF,
    jobId: job.id,
    specSha256: specSha256(immutableSpec),
    entrypointSha256: entrypointEvidence.sha256,
    entrypointSize: entrypointEvidence.size,
  }
}

async function main() {
  const cron = await import(pathToFileURL(cronPublicEntry).href)
  if (typeof cron.createControlRpcClient !== 'function') {
    throw new Error('dsh-cron public control client is unavailable')
  }
  const receipt = await checkNotionRetryBinding({
    client: cron.createControlRpcClient({ socketPath: CRON_CONTROL_SOCKET, timeoutMs: 3_000 }),
  })
  process.stdout.write(`${JSON.stringify(receipt)}\n`)
}

const invoked = process.argv[1] === undefined ? '' : pathToFileURL(path.resolve(process.argv[1])).href
if (import.meta.url === invoked) {
  main().catch(error => {
    process.stderr.write(`${String(error?.message ?? error).slice(0, 300)}\n`)
    process.exitCode = 4
  })
}
