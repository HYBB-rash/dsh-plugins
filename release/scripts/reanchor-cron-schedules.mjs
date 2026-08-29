#!/usr/bin/env node

import path from 'node:path'
import { pathToFileURL } from 'node:url'

const cronPublicEntry = '/opt/dsh/harness/local-plugins/dsh-cron/lib/index.js'

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exitCode = 4
}

function parseArgs(tokens) {
  const values = {}
  for (let index = 0; index < tokens.length; index += 2) {
    const name = tokens[index]
    const value = tokens[index + 1]
    if (!['--migration-id', '--cutover-at', '--reanchored-at', '--store-dir'].includes(name)
      || value === undefined
      || value.startsWith('--')) {
      throw new Error('invalid schedule reanchor arguments')
    }
    if (values[name] !== undefined) throw new Error('duplicate schedule reanchor argument')
    values[name] = value
  }
  for (const name of ['--migration-id', '--cutover-at', '--reanchored-at']) {
    if (values[name] === undefined) throw new Error(`missing ${name}`)
  }
  return values
}

async function main() {
  const values = parseArgs(process.argv.slice(2))
  const dshHome = process.env.DSH_HOME ?? '/home/herman/.dsh'
  const storeDir = values['--store-dir'] ?? path.join(dshHome, 'storages/dsh-cron')
  const cron = await import(pathToFileURL(cronPublicEntry).href)
  if (typeof cron.createMaintenanceControl !== 'function') {
    throw new Error('dsh-cron maintenance API is unavailable')
  }
  const result = cron.createMaintenanceControl({ storeDir }).reanchorCronSchedules({
    migrationVersion: 1,
    migrationId: values['--migration-id'],
    fromTimeZone: 'Etc/UTC',
    toTimeZone: 'Asia/Shanghai',
    cutoverAt: values['--cutover-at'],
    reanchoredAt: values['--reanchored-at'],
  })
  if (result?.ok !== true) {
    throw new Error(`schedule reanchor blocked: ${result?.errorCode ?? 'unknown_error'}`)
  }
  process.stdout.write(`${JSON.stringify({
    status: result.changed ? 'reanchored' : 'already-applied',
    migrationVersion: result.migrationVersion,
    migrationId: result.migrationId,
    inputSha256: result.inputSha256,
    cronJobCount: result.cronJobCount,
    appendedCount: result.appendedCount,
    jobs: result.jobs.map(job => ({
      jobId: job.jobId,
      scheduleSha256: job.scheduleSha256,
      nextRunAt: job.nextRunAt,
      changed: job.changed,
    })),
  })}\n`)
}

main().catch(error => fail(String(error?.message ?? error).slice(0, 400)))
