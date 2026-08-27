#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const publicEntry = '/opt/dsh/harness/local-plugins/dsh-cron/lib/index.js'
const socketPath = '/home/herman/.dsh/storages/dsh-cron/control.sock'

function assertOwnedMode(stat, expectedMode, label) {
  if (stat.uid !== process.getuid()) throw new Error(`${label} is not owned by the container user`)
  if ((stat.mode & 0o777) !== expectedMode) throw new Error(`${label} must have mode ${expectedMode.toString(8)}`)
}

async function main() {
  const parentStat = fs.lstatSync(path.dirname(socketPath))
  if (!parentStat.isDirectory()) throw new Error('control socket parent is not a directory')
  assertOwnedMode(parentStat, 0o700, 'control socket parent')
  const socketStat = fs.lstatSync(socketPath)
  if (!socketStat.isSocket()) throw new Error('control path is not a Unix socket')
  assertOwnedMode(socketStat, 0o600, 'control socket')
  const publicModule = await import(pathToFileURL(publicEntry).href)
  if (typeof publicModule.createControlRpcClient !== 'function') throw new Error('dsh-cron public control client is unavailable')
  const health = await publicModule.createControlRpcClient({ socketPath, timeoutMs: 3_000 }).readiness()
  if (health.protocolVersion !== 1 || health.writer !== 'manager' || health.ready !== true) {
    throw new Error('dsh-cron control readiness is not a ready v1 manager')
  }
  process.stdout.write(`${JSON.stringify(health)}\n`)
}

main().catch((error) => {
  process.stderr.write(`${String(error?.message ?? error).slice(0, 400)}\n`)
  process.exitCode = 1
})
