#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export const ASSISTANT_CRON_SOCKET_PATH = '/home/herman/.dsh/storages/dsh-cron/control.sock'
export const ASSISTANT_CRON_HEALTH_EXTERNAL_REF = 'dsh:health:read-only:v1'

const harnessCli = '/opt/dsh/harness/apps/cli/lib/bin.js'
const assistantPublicEntry = '/opt/dsh/harness/local-plugins/dsh-assistant/lib/index.js'
const cronPublicEntry = '/opt/dsh/harness/local-plugins/dsh-cron/lib/index.js'

function scalar(value) {
  const withoutComment = value.replace(/\s+#.*$/u, '').trim()
  if ((withoutComment.startsWith("'") && withoutComment.endsWith("'"))
    || (withoutComment.startsWith('"') && withoutComment.endsWith('"'))) {
    return withoutComment.slice(1, -1)
  }
  return withoutComment
}

function collectJsonAssistantConfigs(value, found = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectJsonAssistantConfigs(item, found)
    return found
  }
  if (typeof value !== 'object' || value === null) return found
  if (value.id === 'dsh-assistant' && typeof value.config === 'object' && value.config !== null) {
    found.push(value.config)
  }
  for (const child of Object.values(value)) collectJsonAssistantConfigs(child, found)
  return found
}

function jsonAssistantSocketPath(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  const configs = collectJsonAssistantConfigs(parsed)
  if (configs.length !== 1) {
    throw new Error(`effective telegram profile must contain exactly one dsh-assistant config; found ${configs.length}`)
  }
  const socketPath = configs[0].cronControlSocketPath
  return typeof socketPath === 'string' ? socketPath : null
}

function yamlAssistantSocketPath(text) {
  const lines = text.split(/\r?\n/u)
  const entryIndexes = []
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s*-\s+id:\s*['"]?dsh-assistant['"]?\s*(?:#.*)?$/u.test(lines[index])) {
      entryIndexes.push(index)
    }
  }
  if (entryIndexes.length !== 1) {
    throw new Error(`effective telegram profile must contain exactly one dsh-assistant config; found ${entryIndexes.length}`)
  }

  const entryIndex = entryIndexes[0]
  const entryIndent = lines[entryIndex].match(/^\s*/u)[0].length
  let endIndex = lines.length
  for (let index = entryIndex + 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '') continue
    const indent = lines[index].match(/^\s*/u)[0].length
    if (indent <= entryIndent && /^\s*-\s+/u.test(lines[index])) {
      endIndex = index
      break
    }
  }

  let configIndex = -1
  let configIndent = -1
  for (let index = entryIndex + 1; index < endIndex; index += 1) {
    const match = lines[index].match(/^(\s*)config:\s*(?:#.*)?$/u)
    if (match !== null && match[1].length > entryIndent) {
      configIndex = index
      configIndent = match[1].length
      break
    }
  }
  if (configIndex === -1) return null

  const values = []
  for (let index = configIndex + 1; index < endIndex; index += 1) {
    if (lines[index].trim() === '') continue
    const indent = lines[index].match(/^\s*/u)[0].length
    if (indent <= configIndent) break
    const match = lines[index].match(/^\s*cronControlSocketPath:\s*(.*?)\s*$/u)
    if (match !== null) values.push(scalar(match[1]))
  }
  if (values.length > 1) throw new Error('effective dsh-assistant config contains duplicate cronControlSocketPath fields')
  return values.length === 1 ? values[0] : null
}

/** Extract only the Assistant socket field without logging the effective profile. */
export function assistantSocketPathFromEffectiveConfig(text) {
  if (typeof text !== 'string' || text.trim() === '') throw new Error('effective telegram profile dump is empty')
  const jsonResult = jsonAssistantSocketPath(text)
  return jsonResult === undefined ? yamlAssistantSocketPath(text) : jsonResult
}

function verifySocket({ socketPath, lstatSync, accessSync }) {
  let socketStat
  try {
    socketStat = lstatSync(socketPath)
  } catch {
    throw new Error('assistant Cron control socket is missing')
  }
  if (!socketStat.isSocket()) throw new Error('assistant Cron control path is not a Unix socket')
  try {
    accessSync(path.dirname(socketPath), fs.constants.X_OK)
    accessSync(socketPath, fs.constants.R_OK | fs.constants.W_OK)
  } catch {
    throw new Error('assistant Cron control socket is inaccessible to the current container user')
  }
}

/**
 * Cross-plugin Telegram-container gate. It deliberately exposes no mutating
 * operation: readiness and getBound are the only adapter methods invoked.
 */
export async function runAssistantCronHealth({
  effectiveConfig,
  assistantModule,
  cronModule,
  lstatSync = fs.lstatSync,
  accessSync = fs.accessSync,
  socketPath = ASSISTANT_CRON_SOCKET_PATH,
  externalRef = ASSISTANT_CRON_HEALTH_EXTERNAL_REF,
}) {
  const configuredSocketPath = assistantSocketPathFromEffectiveConfig(effectiveConfig)
  if (configuredSocketPath === null) {
    throw new Error('effective dsh-assistant config is missing cronControlSocketPath')
  }
  if (configuredSocketPath !== socketPath) {
    throw new Error('effective dsh-assistant cronControlSocketPath does not match the release contract')
  }

  verifySocket({ socketPath, lstatSync, accessSync })

  const assistantProtocol = assistantModule?.ASSISTANT_CRON_CONTROL_PROTOCOL_VERSION
  const cronProtocol = cronModule?.CONTROL_PROTOCOL_VERSION
  if (!Number.isInteger(assistantProtocol) || !Number.isInteger(cronProtocol)) {
    throw new Error('Assistant or dsh-cron public protocol version is unavailable')
  }
  if (assistantProtocol !== cronProtocol) {
    throw new Error('Assistant and dsh-cron control protocol versions are incompatible')
  }
  if (typeof assistantModule?.createAssistantCronControlAdapterFromSocket !== 'function') {
    throw new Error('dsh-assistant public Cron control adapter is unavailable')
  }

  const adapter = assistantModule.createAssistantCronControlAdapterFromSocket({ socketPath, timeoutMs: 3_000 })
  const readiness = await adapter.readiness()
  if (readiness?.state !== 'ready') throw new Error('Assistant Cron control adapter is not ready')

  const getResult = await adapter.getBound(externalRef)
  if (getResult?.ok !== true || getResult.snapshot?.externalRef !== externalRef) {
    throw new Error('Assistant Cron control adapter read-only get failed')
  }

  return {
    state: 'ready',
    protocolVersion: assistantProtocol,
    socketPath,
    checkedExternalRef: externalRef,
  }
}

function readEffectiveTelegramConfig() {
  try {
    return execFileSync(process.execPath, [harnessCli, '--profile', 'telegram', '--dump-config'], {
      encoding: 'utf8',
      input: '',
      maxBuffer: 4 * 1024 * 1024,
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch {
    throw new Error('failed to dump the effective telegram profile')
  }
}

async function main() {
  const [assistantModule, cronModule] = await Promise.all([
    import(pathToFileURL(assistantPublicEntry).href),
    import(pathToFileURL(cronPublicEntry).href),
  ])
  const result = await runAssistantCronHealth({
    effectiveConfig: readEffectiveTelegramConfig(),
    assistantModule,
    cronModule,
  })
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

const invokedUrl = process.argv[1] === undefined ? '' : pathToFileURL(path.resolve(process.argv[1])).href
if (import.meta.url === invokedUrl) {
  main().catch((error) => {
    process.stderr.write(`${String(error?.message ?? error).slice(0, 400)}\n`)
    process.exitCode = 1
  })
}
