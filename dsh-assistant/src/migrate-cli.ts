#!/usr/bin/env node

import { readFileSync, realpathSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { migrateDatabaseToV3, migrateDatabaseToV4, type MigrationResult, type ReconciliationManifest } from './migration.ts'
import { ASSISTANT_APPLICATION_ID, ASSISTANT_SCHEMA_VERSION } from './schema.ts'

interface CliMigrationResult {
  readonly from: 1 | 2 | 3 | 4
  readonly to: 4
  readonly commitments: number
  readonly outbox: number
  readonly webObservations: number
  readonly bindings: number
  readonly alreadyAtTarget?: boolean
  readonly reconciledCommitments?: number
  readonly reconciledOutboxEvents?: number
}

function readDatabaseIdentity(path: string): { readonly version: number; readonly applicationId: number } {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number }
    const { application_id: applicationId } = db.prepare('PRAGMA application_id').get() as { application_id: number }
    return { version, applicationId }
  } finally {
    db.close()
  }
}

function readCounts(path: string): Pick<CliMigrationResult, 'commitments' | 'outbox' | 'webObservations'> {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const tableExists = (name: string): boolean => db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name) !== undefined
    const count = (table: string): number => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n)
    return {
      commitments: count('commitments'),
      outbox: count('outbox'),
      webObservations: tableExists('web_observations') ? count('web_observations') : 0,
    }
  } finally {
    db.close()
  }
}

/** Run the deliberately narrow offline v1/v2/v3-to-v4 migration command. */
export function runMigrationCli(
  args: readonly string[],
  write: (text: string) => void = text => process.stdout.write(text),
): CliMigrationResult {
  let path: string | undefined
  let monitorId: string | undefined
  let sawMonitorOption = false
  let manifestPath: string | undefined
  let sawManifestOption = false
  for (let index = 0; index < args.length; index++) {
    const value = args[index]!
    if (value === '--monitor-id') {
      if (sawMonitorOption) throw new Error('--monitor-id may be provided only once')
      sawMonitorOption = true
      const candidate = args[++index]
      if (candidate === undefined || candidate === '' || candidate.startsWith('--')) {
        throw new Error('--monitor-id requires one exact commitment id')
      }
      monitorId = candidate
    } else if (value === '--manifest') {
      if (sawManifestOption) throw new Error('--manifest may be provided only once')
      sawManifestOption = true
      const candidate = args[++index]
      if (candidate === undefined || candidate === '' || candidate.startsWith('--')) {
        throw new Error('--manifest requires one explicit JSON file path')
      }
      manifestPath = candidate
    } else if (value.startsWith('--')) {
      throw new Error(`unknown migration option: ${value}`)
    } else if (path === undefined) {
      path = value
    } else {
      throw new Error('exactly one explicit database path is required')
    }
  }
  if (path === undefined || path.trim() === '') {
    throw new Error('usage: dsh-assistant-migrate-to-v4 <database path> [--monitor-id <commitment id>] [--manifest <JSON path>] (an explicit database path is required)')
  }
  const identity = readDatabaseIdentity(path)
  if (identity.applicationId !== ASSISTANT_APPLICATION_ID) {
    throw new Error(`expected dsh-assistant application id ${ASSISTANT_APPLICATION_ID}; found ${identity.applicationId}`)
  }
  if (identity.version === ASSISTANT_SCHEMA_VERSION && (monitorId !== undefined || manifestPath !== undefined)) {
    throw new Error('schema v4 does not accept legacy --monitor-id or --manifest options')
  }
  let manifest: ReconciliationManifest | undefined
  if (manifestPath !== undefined) {
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(manifestPath, 'utf8'))
    } catch (error) {
      throw new Error(`cannot read reconciliation manifest: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('reconciliation manifest must be a JSON object')
    manifest = parsed as ReconciliationManifest
  }
  let result: CliMigrationResult
  if (identity.version === 1 || identity.version === 2 || identity.version === 3) {
    const v3: MigrationResult = migrateDatabaseToV3(path, {
      ...monitorId === undefined ? {} : { monitorId },
      ...manifest === undefined ? {} : { manifest },
    })
    const v4 = migrateDatabaseToV4(path)
    result = {
      from: identity.version, to: 4,
      commitments: v3.commitments, outbox: v3.outbox, webObservations: v3.webObservations,
      reconciledCommitments: v3.reconciledCommitments ?? 0,
      reconciledOutboxEvents: v3.reconciledOutboxEvents ?? 0,
      bindings: v4.bindings,
    }
  } else if (identity.version === ASSISTANT_SCHEMA_VERSION) {
    const v4 = migrateDatabaseToV4(path)
    const v4Result: CliMigrationResult = {
      from: 4, to: 4, ...readCounts(path), bindings: v4.bindings,
      reconciledCommitments: 0, reconciledOutboxEvents: 0,
      ...(v4.alreadyAtTarget === undefined ? {} : { alreadyAtTarget: v4.alreadyAtTarget }),
    }
    result = v4Result
  } else {
    throw new Error(`expected dsh-assistant schema v1, v2, v3, or v4 at "${path}"; found version ${identity.version}`)
  }
  const { bindings, ...machineResult } = result
  const output: Record<string, unknown> = { path, ...machineResult }
  if (bindings !== 0) output.bindings = bindings
  if (monitorId !== undefined) output.monitorId = monitorId
  if (manifestPath !== undefined) output.manifestPath = manifestPath
  write(`${JSON.stringify(output)}\n`)
  return result
}

function isMainModule(): boolean {
  const invoked = process.argv[1]
  if (invoked === undefined) return false
  try {
    return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isMainModule()) {
  try {
    runMigrationCli(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`dsh-assistant offline migration failed: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
