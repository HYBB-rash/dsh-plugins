import assert from 'node:assert/strict'
import test from 'node:test'

import { devRuntimeIdentity } from '../dev-runtime-identity.mjs'

test('keeps one worktree on one stable, scoped development runtime', () => {
  const first = devRuntimeIdentity('/workspace/dsh-one')
  const second = devRuntimeIdentity('/workspace/dsh-one/../dsh-one')

  assert.deepEqual(first, second)
  assert.match(first.id, /^[0-9a-f]{12}$/u)
  assert.equal(first.network, `dsh-dev-${first.id}-internal`)
  assert.equal(first.containers.web, `dsh-dev-${first.id}-web`)
  assert.equal(first.containers.telegram, `dsh-dev-${first.id}-telegram`)
  assert.equal(first.containers.fakeTelegram, `dsh-dev-${first.id}-fake-telegram`)
  assert.equal(first.webUrl, `http://127.0.0.1:${first.webPort}`)
  assert.ok(first.webPort >= 20_000 && first.webPort < 50_000)
})

test('gives independent worktrees independent runtime resources', () => {
  const first = devRuntimeIdentity('/workspace/dsh-one')
  const second = devRuntimeIdentity('/workspace/dsh-two')

  assert.notEqual(first.id, second.id)
  assert.notEqual(first.network, second.network)
  assert.notEqual(first.containers.web, second.containers.web)
  assert.notEqual(first.containers.telegram, second.containers.telegram)
  assert.notEqual(first.containers.fakeTelegram, second.containers.fakeTelegram)
})
