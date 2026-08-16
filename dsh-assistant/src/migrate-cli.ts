#!/usr/bin/env node

import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { migrateDatabaseV1ToV2, type MigrationResult } from './store.ts'

/** Run the deliberately narrow offline v1-to-v2 migration command. */
export function runMigrationCli(
  args: readonly string[],
  write: (text: string) => void = text => process.stdout.write(text),
): MigrationResult {
  let path: string | undefined
  let monitorId: string | undefined
  let sawMonitorOption = false
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
    } else if (value.startsWith('--')) {
      throw new Error(`unknown migration option: ${value}`)
    } else if (path === undefined) {
      path = value
    } else {
      throw new Error('exactly one explicit database path is required')
    }
  }
  if (path === undefined || path.trim() === '') {
    throw new Error('usage: dsh-assistant-migrate-v1-to-v2 <database path> [--monitor-id <commitment id>] (an explicit database path is required)')
  }
  const result = migrateDatabaseV1ToV2(path, monitorId === undefined ? {} : { monitorId })
  write(`${JSON.stringify({ path, from: 1, to: 2, ...result, ...monitorId === undefined ? {} : { monitorId } })}\n`)
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
