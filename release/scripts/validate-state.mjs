import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ASSISTANT_APPLICATION_ID = 0x44534841
const ASSISTANT_SCHEMA_VERSION = 4
const ASSISTANT_KEY_TABLES = Object.freeze([
  'commitments',
  'outbox',
  'web_observations',
  'assistant_cron_bindings',
])

const root = resolve(process.argv[2] ?? process.env.DSH_HOME ?? '/home/herman/.dsh')
if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`state root is not a directory: ${root}`)

const databases = []
const visit = (directory) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) visit(path)
    else if (entry.isFile() && path.endsWith('.sqlite')) databases.push(path)
  }
}
visit(root)
databases.sort()

const firstValue = (row) => Object.values(row)[0]

const sha256File = (path) => {
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  const descriptor = openSync(path, 'r')
  try {
    for (;;) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
    }
  } finally {
    closeSync(descriptor)
  }
  return `sha256:${hash.digest('hex')}`
}

const countRows = (db, table) => {
  const quoted = String(table).replaceAll('"', '""')
  const row = db.prepare(`SELECT count(*) AS count FROM "${quoted}"`).get()
  return Number(row.count)
}

const validateCheck = (db, pragma, path) => {
  const rows = db.prepare(`PRAGMA ${pragma}`).all().map(firstValue)
  if (rows.length !== 1 || rows[0] !== 'ok') {
    throw new Error(`SQLite ${pragma} failed: ${path}`)
  }
}

const validateForeignKeys = (db, path) => {
  const violations = db.prepare('PRAGMA foreign_key_check').all()
  if (violations.length !== 0) throw new Error(`SQLite foreign_key_check failed: ${path}`)
}

const results = []
for (const path of databases) {
  const db = new DatabaseSync(path, { readOnly: true })
  let result
  try {
    db.exec('PRAGMA query_only = ON')
    const queryOnly = Number(firstValue(db.prepare('PRAGMA query_only').get()))
    if (queryOnly !== 1) throw new Error(`SQLite query_only could not be enabled: ${path}`)

    const applicationId = Number(firstValue(db.prepare('PRAGMA application_id').get()))
    const userVersion = Number(firstValue(db.prepare('PRAGMA user_version').get()))
    const isAssistant = applicationId === ASSISTANT_APPLICATION_ID
    if (isAssistant && userVersion !== ASSISTANT_SCHEMA_VERSION) {
      throw new Error(
        `assistant SQLite schema version is ${userVersion}, expected ${ASSISTANT_SCHEMA_VERSION}: ${path}`,
      )
    }

    const check = isAssistant ? 'quick_check' : 'integrity_check'
    validateCheck(db, check, path)
    validateForeignKeys(db, path)

    const tables = isAssistant
      ? ASSISTANT_KEY_TABLES.map((name) => {
          const exists = db.prepare(
            "SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = ?",
          ).get(name)
          if (exists === undefined) throw new Error(`assistant SQLite v4 is missing key table ${name}: ${path}`)
          return { name, rows: countRows(db, name) }
        })
      : db.prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        ).all().map(({ name }) => ({ name: String(name), rows: countRows(db, name) }))

    result = {
      path: path.slice(root.length + 1),
      applicationId,
      userVersion,
      queryOnly: true,
      check,
      integrity: 'ok',
      foreignKeyViolations: 0,
      tables,
    }
  } finally {
    db.close()
  }
  results.push({ ...result, sha256: sha256File(path) })
}

process.stdout.write(`${JSON.stringify({ schemaVersion: 1, root, databases: results }, null, 2)}\n`)
