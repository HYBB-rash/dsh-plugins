import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  NOTION_RETRY_EXTERNAL_REF,
  checkNotionRetryBinding,
  inspectLiveEntrypoint,
} from '../scripts/check-notion-retry-binding.mjs'

const goodJob = {
  id: 'fixture-retry-job',
  createdAt: '2026-08-30T00:00:00.000Z',
  externalRef: NOTION_RETRY_EXTERNAL_REF,
  schedule: { kind: 'interval', minutes: 5 },
  command: {
    argv: [
      '/usr/bin/python3',
      '/home/herman/.dsh/workspace/automations/notion/notion_inbox_sync.py',
      '--retry-pending',
      '--json',
    ],
    timeoutSeconds: 120,
    outputMaxBytes: 4096,
  },
  deliver: 'silent',
  cwd: '/home/herman/.dsh/workspace',
}

function client(activeJob = goodJob) {
  const calls = []
  return {
    calls,
    readiness: async () => {
      calls.push('readiness')
      return { protocolVersion: 1, writer: 'manager', ready: true }
    },
    getBoundCommand: async externalRef => {
      calls.push(`get:${externalRef}`)
      return {
        protocolVersion: 1,
        ok: true,
        operation: 'get-bound-command',
        snapshot: { externalRef, activeJob, latestRun: null },
      }
    },
    ensureBoundCommand: async () => { calls.push('ensure'); throw new Error('must not mutate') },
    replaceBoundCommand: async () => { calls.push('replace'); throw new Error('must not mutate') },
  }
}

test('passes with readiness/get only for the live Harness binding', async () => {
  const fixture = client()
  const receipt = await checkNotionRetryBinding({
    client: fixture,
    inspectEntrypoint: () => ({ sha256: 'a'.repeat(64), size: 12_345 }),
  })
  assert.equal(receipt.status, 'ready')
  assert.equal(receipt.jobId, goodJob.id)
  assert.match(receipt.specSha256, /^[0-9a-f]{64}$/u)
  assert.equal(receipt.entrypointSha256, 'a'.repeat(64))
  assert.equal(receipt.entrypointSize, 12_345)
  assert.deepEqual(fixture.calls, ['readiness', `get:${NOTION_RETRY_EXTERNAL_REF}`])
})

test('fails closed when the online-owned binding is absent', async () => {
  const fixture = client(null)
  await assert.rejects(() => checkNotionRetryBinding({ client: fixture, inspectEntrypoint: () => ({ sha256: 'a'.repeat(64), size: 1 }) }), /has not registered/u)
  assert.deepEqual(fixture.calls, ['readiness', `get:${NOTION_RETRY_EXTERNAL_REF}`])
})

test('fails closed on a spec or path mismatch without writing', async () => {
  const fixture = client({
    ...goodJob,
    command: {
      ...goodJob.command,
      argv: ['/usr/bin/python3', '/opt/dsh/notion.py', '--retry-pending', '--json'],
    },
  })
  await assert.rejects(() => checkNotionRetryBinding({ client: fixture, inspectEntrypoint: () => ({ sha256: 'a'.repeat(64), size: 1 }) }), /does not match/u)
  assert.deepEqual(fixture.calls, ['readiness', `get:${NOTION_RETRY_EXTERNAL_REF}`])
})

test('rejects a different entrypoint even when it stays under the automation root', async () => {
  const fixture = client({
    ...goodJob,
    command: {
      ...goodJob.command,
      argv: [
        '/usr/bin/python3',
        '/home/herman/.dsh/workspace/automations/notion/other_sync.py',
        '--retry-pending',
        '--json',
      ],
    },
  })
  await assert.rejects(
    () => checkNotionRetryBinding({
      client: fixture,
      inspectEntrypoint: () => ({ sha256: 'a'.repeat(64), size: 1 }),
    }),
    /does not match/u,
  )
  assert.deepEqual(fixture.calls, ['readiness', `get:${NOTION_RETRY_EXTERNAL_REF}`])
})

test('fails closed when the online-owned entrypoint is missing without writing', async () => {
  const fixture = client()
  await assert.rejects(
    () => checkNotionRetryBinding({
      client: fixture,
      inspectEntrypoint: () => { throw new Error('missing fixture') },
    }),
    /entrypoint is unavailable/u,
  )
  assert.deepEqual(fixture.calls, ['readiness', `get:${NOTION_RETRY_EXTERNAL_REF}`])
})

test('hashes a bounded Harness-owned entrypoint and rejects retired dependencies', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-notion-retry-entrypoint-'))
  try {
    const automationRoot = join(root, 'automations')
    const entrypoint = join(automationRoot, 'notion/notion_inbox_sync.py')
    mkdirSync(join(automationRoot, 'notion'), { recursive: true })
    const contract = [
      '# --pull --set --push --force --retry-pending --json',
      '# NOTION_TOKEN_FILE NOTION_INBOX_FILE NOTION_API_BASE NOTION_PAGE_ID',
      '',
    ].join('\n')
    writeFileSync(entrypoint, contract)
    const evidence = inspectLiveEntrypoint(automationRoot, entrypoint)
    assert.match(evidence.sha256, /^[0-9a-f]{64}$/u)
    assert.equal(evidence.size, Buffer.byteLength(contract))
    writeFileSync(entrypoint, `${contract}# .openclaw\n`)
    assert.throws(() => inspectLiveEntrypoint(automationRoot, entrypoint), /does not expose/u)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
