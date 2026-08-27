import { DatabaseSync } from 'node:sqlite'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

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

const results = []
for (const path of databases) {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const integrity = db.prepare('PRAGMA integrity_check').all().map(row => Object.values(row)[0])
    const foreignKeys = db.prepare('PRAGMA foreign_key_check').all()
    if (integrity.length !== 1 || integrity[0] !== 'ok' || foreignKeys.length !== 0) {
      throw new Error(`SQLite validation failed: ${path}`)
    }
    results.push({ path: path.slice(root.length + 1), integrity: 'ok', foreignKeyViolations: 0 })
  } finally {
    db.close()
  }
}

process.stdout.write(`${JSON.stringify({ schemaVersion: 1, root, databases: results }, null, 2)}\n`)
