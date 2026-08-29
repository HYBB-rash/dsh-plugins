import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

const ASSISTANT_APPLICATION_ID = 0x44534841
const releaseRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const validator = join(releaseRoot, 'scripts/validate-state.mjs')
const scratch = mkdtempSync(join(tmpdir(), 'dsh-validate-assistant-state-'))

const sha256File = (path) => `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`

const runValidator = (root) => spawnSync(process.execPath, [validator, root], {
  encoding: 'utf8',
  env: { ...process.env, NODE_NO_WARNINGS: '1' },
})

const createAssistantFixture = (path, options = {}) => {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  try {
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE commitments (id TEXT PRIMARY KEY, private_text TEXT);
      CREATE TABLE outbox (
        id TEXT PRIMARY KEY,
        commitment_id TEXT NOT NULL REFERENCES commitments(id),
        private_text TEXT
      );
      CREATE TABLE web_observations (session_id TEXT PRIMARY KEY, private_text TEXT);
      ${options.missingBindings ? '' : `CREATE TABLE assistant_cron_bindings (
        commitment_id TEXT PRIMARY KEY REFERENCES commitments(id),
        private_text TEXT
      );`}
      CREATE TABLE private_extra (private_text TEXT);
      PRAGMA application_id = ${ASSISTANT_APPLICATION_ID};
      PRAGMA user_version = ${options.userVersion ?? 4};
    `)
    db.prepare('INSERT INTO commitments VALUES (?, ?)').run('commitment-1', 'PRIVATE-COMMITMENT-BODY')
    db.prepare('INSERT INTO commitments VALUES (?, ?)').run('commitment-2', 'PRIVATE-COMMITMENT-BODY-2')
    db.prepare('INSERT INTO outbox VALUES (?, ?, ?)').run('outbox-1', 'commitment-1', 'PRIVATE-OUTBOX-BODY')
    db.prepare('INSERT INTO outbox VALUES (?, ?, ?)').run('outbox-2', 'commitment-2', 'PRIVATE-OUTBOX-BODY-2')
    db.prepare('INSERT INTO web_observations VALUES (?, ?)').run('session-1', 'PRIVATE-WEB-BODY')
    if (!options.missingBindings) {
      db.prepare('INSERT INTO assistant_cron_bindings VALUES (?, ?)').run(
        'commitment-1',
        'PRIVATE-BINDING-BODY',
      )
    }
    db.prepare('INSERT INTO private_extra VALUES (?)').run('PRIVATE-EXTRA-BODY')
    if (options.foreignKeyViolation) {
      db.exec('PRAGMA foreign_keys = OFF')
      db.prepare('INSERT INTO outbox VALUES (?, ?, ?)').run(
        'PRIVATE-VIOLATION-ID',
        'PRIVATE-MISSING-COMMITMENT',
        'PRIVATE-VIOLATION-BODY',
      )
    }
  } finally {
    db.close()
  }
}

const createGenericFixture = (path) => {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  try {
    db.exec('CREATE TABLE ordinary_state (id INTEGER PRIMARY KEY, private_text TEXT); PRAGMA user_version = 7;')
    db.prepare('INSERT INTO ordinary_state (private_text) VALUES (?)').run('PRIVATE-GENERIC-BODY')
  } finally {
    db.close()
  }
}

try {
  {
    const root = join(scratch, 'valid')
    const assistantPath = join(root, 'storages/dsh-assistant/state.sqlite')
    const genericPath = join(root, 'storages/other/other.sqlite')
    createAssistantFixture(assistantPath)
    createGenericFixture(genericPath)
    chmodSync(assistantPath, 0o444)
    chmodSync(genericPath, 0o444)
    const assistantBefore = sha256File(assistantPath)
    const genericBefore = sha256File(genericPath)

    const run = runValidator(root)
    assert.equal(run.status, 0, run.stderr)
    const receipt = JSON.parse(run.stdout)
    assert.equal(receipt.schemaVersion, 1)
    const assistant = receipt.databases.find((database) => database.path === 'storages/dsh-assistant/state.sqlite')
    const generic = receipt.databases.find((database) => database.path.endsWith('other.sqlite'))
    assert.ok(assistant)
    assert.ok(generic)
    assert.deepEqual(
      assistant,
      {
        path: 'storages/dsh-assistant/state.sqlite',
        applicationId: ASSISTANT_APPLICATION_ID,
        userVersion: 4,
        queryOnly: true,
        check: 'quick_check',
        integrity: 'ok',
        foreignKeyViolations: 0,
        tables: [
          { name: 'commitments', rows: 2 },
          { name: 'outbox', rows: 2 },
          { name: 'web_observations', rows: 1 },
          { name: 'assistant_cron_bindings', rows: 1 },
        ],
        sha256: assistantBefore,
      },
    )
    assert.equal(generic.userVersion, 7)
    assert.equal(generic.check, 'integrity_check')
    assert.deepEqual(generic.tables, [{ name: 'ordinary_state', rows: 1 }])
    assert.equal(generic.sha256, genericBefore)
    assert.equal(sha256File(assistantPath), assistantBefore)
    assert.equal(sha256File(genericPath), genericBefore)
    for (const suffix of ['-journal', '-shm', '-wal']) {
      assert.equal(existsSync(`${assistantPath}${suffix}`), false)
      assert.equal(existsSync(`${genericPath}${suffix}`), false)
    }

    const combinedOutput = `${run.stdout}\n${run.stderr}`
    for (const secret of [
      'PRIVATE-COMMITMENT-BODY',
      'PRIVATE-OUTBOX-BODY',
      'PRIVATE-WEB-BODY',
      'PRIVATE-BINDING-BODY',
      'PRIVATE-EXTRA-BODY',
      'private_extra',
      'PRIVATE-GENERIC-BODY',
    ]) {
      assert.equal(combinedOutput.includes(secret), false, `validator leaked fixture data: ${secret}`)
    }
  }

  {
    const root = join(scratch, 'wrong-version')
    const path = join(root, 'assistant.sqlite')
    createAssistantFixture(path, { userVersion: 3 })
    const before = sha256File(path)
    const run = runValidator(root)
    assert.notEqual(run.status, 0)
    assert.match(run.stderr, /schema version is 3, expected 4/)
    assert.equal(sha256File(path), before)
    assert.equal(`${run.stdout}\n${run.stderr}`.includes('PRIVATE-COMMITMENT-BODY'), false)
  }

  {
    const root = join(scratch, 'foreign-key')
    const path = join(root, 'assistant.sqlite')
    createAssistantFixture(path, { foreignKeyViolation: true })
    const before = sha256File(path)
    const run = runValidator(root)
    assert.notEqual(run.status, 0)
    assert.match(run.stderr, /foreign_key_check failed/)
    assert.equal(sha256File(path), before)
    for (const secret of ['PRIVATE-VIOLATION-ID', 'PRIVATE-MISSING-COMMITMENT', 'PRIVATE-VIOLATION-BODY']) {
      assert.equal(`${run.stdout}\n${run.stderr}`.includes(secret), false)
    }
  }

  {
    const root = join(scratch, 'missing-key-table')
    const path = join(root, 'assistant.sqlite')
    createAssistantFixture(path, { missingBindings: true })
    const before = sha256File(path)
    const run = runValidator(root)
    assert.notEqual(run.status, 0)
    assert.match(run.stderr, /missing key table assistant_cron_bindings/)
    assert.equal(sha256File(path), before)
    assert.equal(`${run.stdout}\n${run.stderr}`.includes('PRIVATE-COMMITMENT-BODY'), false)
  }

  process.stdout.write('assistant SQLite read-only validation passed\n')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
