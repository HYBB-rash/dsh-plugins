#!/usr/bin/env node

import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const cronPublicEntry = '/opt/dsh/harness/local-plugins/dsh-cron/lib/index.js'
const MAX_EVIDENCE_BYTES = 1024 * 1024
const TOP_LEVEL_KEYS = [
  'cronJobCount',
  'cutoverAt',
  'fromTimeZone',
  'inputSha256',
  'jobs',
  'migrationId',
  'migrationVersion',
  'reanchoredAt',
  'schemaVersion',
  'toTimeZone',
]
const JOB_KEYS = ['jobId', 'nextRunAt', 'scheduleSha256']
const RESULT_KEYS = [
  'cronJobCount',
  'cutoverAt',
  'fromTimeZone',
  'inputSha256',
  'jobs',
  'ledgerRecordCount',
  'migrationId',
  'migrationVersion',
  'ok',
  'reanchoredAt',
  'toTimeZone',
]

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value, expected) {
  return isObject(value)
    && Object.keys(value).sort().join('\0') === [...expected].sort().join('\0')
}

function isCanonicalIso(value) {
  return typeof value === 'string'
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value
}

/** Parse the private-free evidence extracted from one accepted release. */
export function parseScheduleReanchorEvidence(text) {
  let value
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error('accepted schedule reanchor evidence is not valid JSON')
  }
  if (!hasExactKeys(value, TOP_LEVEL_KEYS)
    || value.schemaVersion !== 1
    || value.migrationVersion !== 1
    || typeof value.migrationId !== 'string'
    || !/^[a-z0-9][a-z0-9:._-]{2,127}$/u.test(value.migrationId)
    || value.fromTimeZone !== 'Etc/UTC'
    || value.toTimeZone !== 'Asia/Shanghai'
    || !isCanonicalIso(value.cutoverAt)
    || !isCanonicalIso(value.reanchoredAt)
    || typeof value.inputSha256 !== 'string'
    || !/^[a-f0-9]{64}$/u.test(value.inputSha256)
    || !Number.isSafeInteger(value.cronJobCount)
    || value.cronJobCount < 1
    || !Array.isArray(value.jobs)
    || value.jobs.length !== value.cronJobCount) {
    throw new Error('accepted schedule reanchor evidence does not match schema v1')
  }

  const jobIds = new Set()
  const jobs = []
  for (const job of value.jobs) {
    if (!hasExactKeys(job, JOB_KEYS)
      || typeof job.jobId !== 'string'
      || job.jobId.trim() === ''
      || jobIds.has(job.jobId)
      || typeof job.scheduleSha256 !== 'string'
      || !/^[a-f0-9]{64}$/u.test(job.scheduleSha256)
      || !isCanonicalIso(job.nextRunAt)) {
      throw new Error('accepted schedule reanchor job evidence does not match schema v1')
    }
    jobIds.add(job.jobId)
    jobs.push({
      jobId: job.jobId,
      scheduleSha256: job.scheduleSha256,
      nextRunAt: job.nextRunAt,
    })
  }
  jobs.sort((left, right) => left.jobId.localeCompare(right.jobId))
  return {
    schemaVersion: 1,
    migrationVersion: 1,
    migrationId: value.migrationId,
    fromTimeZone: 'Etc/UTC',
    toTimeZone: 'Asia/Shanghai',
    cutoverAt: value.cutoverAt,
    reanchoredAt: value.reanchoredAt,
    inputSha256: value.inputSha256,
    cronJobCount: value.cronJobCount,
    jobs,
  }
}

export function readScheduleReanchorEvidence(file) {
  let descriptor
  try {
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch {
    throw new Error('accepted schedule reanchor evidence file is unavailable')
  }
  try {
    const metadata = fstatSync(descriptor)
    if (!metadata.isFile() || metadata.size < 2 || metadata.size > MAX_EVIDENCE_BYTES) {
      throw new Error('accepted schedule reanchor evidence file is not a bounded regular file')
    }
    const bytes = readFileSync(descriptor)
    if (bytes.length < 2 || bytes.length > MAX_EVIDENCE_BYTES) {
      throw new Error('accepted schedule reanchor evidence changed while being read')
    }
    return parseScheduleReanchorEvidence(bytes.toString('utf8'))
  } finally {
    closeSync(descriptor)
  }
}

function evidenceWithoutSchema(evidence) {
  const { schemaVersion: _schemaVersion, ...request } = evidence
  return request
}

/** Call only the maintenance inspection port and validate its exact receipt. */
export function runScheduleReanchorInspection(cron, evidence, storeDir) {
  if (!isObject(cron) || typeof cron.createMaintenanceControl !== 'function') {
    throw new Error('dsh-cron schedule reanchor inspection API is unavailable')
  }
  const control = cron.createMaintenanceControl({ storeDir })
  if (!isObject(control) || typeof control.inspectScheduleReanchorMigration !== 'function') {
    throw new Error('dsh-cron schedule reanchor inspection API is unavailable')
  }
  const request = evidenceWithoutSchema(evidence)
  const result = control.inspectScheduleReanchorMigration(request)
  if (result?.ok !== true) {
    const code = typeof result?.errorCode === 'string' && /^[a-z_]{2,64}$/u.test(result.errorCode)
      ? result.errorCode
      : 'unknown_error'
    throw new Error(`schedule reanchor inspection blocked: ${code}`)
  }
  if (!hasExactKeys(result, RESULT_KEYS)
    || !Number.isSafeInteger(result.ledgerRecordCount)
    || result.ledgerRecordCount !== evidence.cronJobCount) {
    throw new Error('schedule reanchor inspection returned an invalid ledger count')
  }

  const returnedEvidence = parseScheduleReanchorEvidence(JSON.stringify({
    schemaVersion: 1,
    migrationVersion: result.migrationVersion,
    migrationId: result.migrationId,
    fromTimeZone: result.fromTimeZone,
    toTimeZone: result.toTimeZone,
    cutoverAt: result.cutoverAt,
    reanchoredAt: result.reanchoredAt,
    inputSha256: result.inputSha256,
    cronJobCount: result.cronJobCount,
    jobs: result.jobs,
  }))
  if (JSON.stringify(returnedEvidence) !== JSON.stringify(evidence)) {
    throw new Error('schedule reanchor inspection result differs from accepted evidence')
  }
  return {
    status: 'verified',
    ...evidence,
    ledgerRecordCount: result.ledgerRecordCount,
  }
}

/** Recover evidence only when dsh-cron can prove the complete ledger against current jobs. */
export function runScheduleReanchorRecovery(cron, migrationId, storeDir) {
  if (!isObject(cron) || typeof cron.createMaintenanceControl !== 'function') {
    throw new Error('dsh-cron schedule reanchor recovery API is unavailable')
  }
  const control = cron.createMaintenanceControl({ storeDir })
  if (!isObject(control) || typeof control.recoverScheduleReanchorMigration !== 'function') {
    throw new Error('dsh-cron schedule reanchor recovery API is unavailable')
  }
  const result = control.recoverScheduleReanchorMigration(migrationId)
  if (result?.ok !== true) {
    const code = typeof result?.errorCode === 'string' && /^[a-z_]{2,64}$/u.test(result.errorCode)
      ? result.errorCode
      : 'unknown_error'
    if (code === 'migration_not_found') return { status: 'absent', migrationId }
    throw new Error(`schedule reanchor recovery blocked: ${code}`)
  }
  if (!hasExactKeys(result, RESULT_KEYS)
    || !Number.isSafeInteger(result.ledgerRecordCount)
    || result.ledgerRecordCount !== result.cronJobCount) {
    throw new Error('schedule reanchor recovery returned an invalid ledger count')
  }
  const evidence = parseScheduleReanchorEvidence(JSON.stringify({
    schemaVersion: 1,
    migrationVersion: result.migrationVersion,
    migrationId: result.migrationId,
    fromTimeZone: result.fromTimeZone,
    toTimeZone: result.toTimeZone,
    cutoverAt: result.cutoverAt,
    reanchoredAt: result.reanchoredAt,
    inputSha256: result.inputSha256,
    cronJobCount: result.cronJobCount,
    jobs: result.jobs,
  }))
  return { status: 'recovered', evidence, ledgerRecordCount: result.ledgerRecordCount }
}

function parseArgs(tokens) {
  const values = {}
  for (let index = 0; index < tokens.length; index += 2) {
    const name = tokens[index]
    const value = tokens[index + 1]
    if (!['--evidence-file', '--recover-migration-id', '--store-dir'].includes(name)
      || value === undefined
      || value.startsWith('--')
      || values[name] !== undefined) {
      throw new Error('invalid schedule reanchor inspection arguments')
    }
    values[name] = value
  }
  if ((values['--evidence-file'] === undefined) === (values['--recover-migration-id'] === undefined)) {
    throw new Error('select exactly one schedule reanchor inspection mode')
  }
  return values
}

async function main() {
  const values = parseArgs(process.argv.slice(2))
  const dshHome = process.env.DSH_HOME ?? '/home/herman/.dsh'
  const storeDir = values['--store-dir'] ?? path.join(dshHome, 'storages/dsh-cron')
  const cron = await import(pathToFileURL(cronPublicEntry).href)
  const receipt = values['--recover-migration-id'] === undefined
    ? runScheduleReanchorInspection(cron, readScheduleReanchorEvidence(values['--evidence-file']), storeDir)
    : runScheduleReanchorRecovery(cron, values['--recover-migration-id'], storeDir)
  process.stdout.write(`${JSON.stringify(receipt)}\n`)
}

const invokedPath = process.argv[1] === undefined ? '' : pathToFileURL(path.resolve(process.argv[1])).href
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${String(error?.message ?? error).slice(0, 300)}\n`)
    process.exitCode = 4
  })
}
