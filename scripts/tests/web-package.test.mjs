import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const repository = resolve(import.meta.dirname, '../..')
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-package-contract-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const pkg = join(root, 'prepared')
  for (const dir of ['runtime', 'plugins', 'bin', 'config', 'production-credentials/secrets']) mkdirSync(join(pkg, dir), { recursive: true })
  writeFileSync(join(pkg, 'runtime/package.json'), JSON.stringify({ private: true, dependencies: { '@deepseek-ai/dsh': '0.1.2-rc.1', pnpm: '11.24.0' }, dshWebPlugins: { '@linxin666/dsh-client-ui-task-board': '0.3.14' } }))
  writeFileSync(join(pkg, 'runtime/package-lock.json'), '{"lockfileVersion":3}')
  for (const name of ['telegram-gateway', 'cron', 'assistant']) writeFileSync(join(pkg, `plugins/deepseek-ai-dsh-${name}-1.0.0.tgz`), `fixture-${name}`)
  writeFileSync(join(pkg, 'production-credentials/.credentials.yaml'), 'fixture-credential')
  writeFileSync(join(pkg, 'production-credentials/secrets/notion.token'), 'fixture-notion')
  return { root, pkg, home: join(root, 'home') }
}

test('install uses the prepared exact versions and official plugin commands, never selects latest', async t => {
  const { installPackage } = await import('../lib/web-package.mjs')
  const { pkg, home } = fixture(t)
  const calls = []
  const run = (command, args, options) => { calls.push({ command, args, options }); return '' }
  installPackage(pkg, home, { run })
  assert.equal(JSON.parse(readFileSync(join(home, 'runtime/package.json'))).dependencies['@deepseek-ai/dsh'], '0.1.2-rc.1')
  assert.equal(calls.filter(c => c.command === 'npm' && c.args[0] === 'ci').length, 1)
  assert.ok(!JSON.stringify(calls).includes('@latest'))
  const adds = calls.filter(c => c.args.includes('add'))
  assert.ok(adds.some(c => c.args.includes('@linxin666/dsh-client-ui-task-board@0.3.14')))
  assert.ok(adds.some(c => c.args.some(a => a.endsWith('deepseek-ai-dsh-telegram-gateway-1.0.0.tgz'))))
  assert.ok(adds.every(c => c.args.includes('--ignore-scripts')))
  assert.ok(adds.every(c => c.args.includes('--save-exact')))
  assert.equal(readFileSync(join(home, '.credentials.yaml'), 'utf8'), 'fixture-credential')
  assert.ok(!existsSync(join(home, 'workspace')))
})

test('existing ranges are pinned by an explicit add before removing old bundles', async t => {
  const { installPackage } = await import('../lib/web-package.mjs')
  const { pkg, home } = fixture(t)
  mkdirSync(join(home, 'runtime'), { recursive: true })
  mkdirSync(join(home, 'profiles/web'), { recursive: true })
  writeFileSync(join(home, 'runtime/package.json'), '{}')
  writeFileSync(join(home, 'profiles/web/package.json'), JSON.stringify({ dependencies: {
    '@linxin666/dsh-client-ui-task-board': '^0.3.13',
    '@linxin666/dsh-web-all': '^0.3.13',
    '@deepseek-ai/dsh-cron': 'file:/old.tgz',
  } }))
  const mutations = []
  installPackage(pkg, home, { run: (command, args) => {
    if (args[0] === 'plugin') mutations.push(args)
    return ''
  } })
  assert.ok(mutations[0].includes('add') && mutations[0].includes('--save-exact'))
  assert.ok(mutations[0].includes('@linxin666/dsh-client-ui-task-board@0.3.14'))
  assert.deepEqual(mutations[1].slice(3), ['remove', '@linxin666/dsh-web-all', '@deepseek-ai/dsh-cron'])
  assert.ok(mutations[2].includes('add'))
})

test('legacy Profile requires an explicit stopped-instance migration and stays untouched otherwise', async t => {
  const { installPackage } = await import('../lib/web-package.mjs')
  const { pkg, home } = fixture(t)
  mkdirSync(join(home, 'profiles/web'), { recursive: true })
  const manifest = join(home, 'profiles/web/package.json')
  writeFileSync(manifest, '{"dependencies":{"old-plugin":"file:/old-checkout"}}')
  let calls = 0
  assert.throws(() => installPackage(pkg, home, { run: () => { calls++; return '' } }), /legacy.*--migrate/i)
  assert.equal(calls, 0)
  assert.equal(readFileSync(manifest, 'utf8'), '{"dependencies":{"old-plugin":"file:/old-checkout"}}')
  assert.ok(!existsSync(join(home, 'runtime')))
})

test('missing package inputs fail before writing runtime, Profile, or credentials', async t => {
  const { installPackage } = await import('../lib/web-package.mjs')
  const { pkg, home } = fixture(t)
  rmSync(join(pkg, 'runtime/package-lock.json'))
  assert.throws(() => installPackage(pkg, home), /package-lock.json/)
  assert.ok(!existsSync(home))
})

test('a broken installed native terminal fails before changing the Profile or credentials', async t => {
  const { installPackage } = await import('../lib/web-package.mjs')
  const { pkg, home } = fixture(t)
  mkdirSync(join(home, 'runtime'), { recursive: true })
  mkdirSync(join(home, 'profiles/web'), { recursive: true })
  writeFileSync(join(home, 'runtime/package.json'), '{}')
  writeFileSync(join(home, 'profiles/web/package.json'), '{"dependencies":{"existing":"1.0.0"}}')
  const run = (command, args) => {
    if (command === 'node' && args.some(arg => arg.includes('node-pty'))) throw new Error('native terminal unavailable')
    return ''
  }
  assert.throws(() => installPackage(pkg, home, { run }), /native terminal unavailable/)
  assert.equal(readFileSync(join(home, 'profiles/web/package.json'), 'utf8'), '{"dependencies":{"existing":"1.0.0"}}')
  assert.ok(!existsSync(join(home, '.credentials.yaml')))
})

test('archive consumes a prepared batch and includes no runtime tree or upstream source', async t => {
  const { createArchive } = await import('../lib/web-package.mjs')
  const { pkg, root } = fixture(t)
  mkdirSync(join(pkg, 'runtime/node_modules'), { recursive: true })
  writeFileSync(join(pkg, 'runtime/node_modules/DO-NOT-SHIP'), 'native build')
  writeFileSync(join(pkg, 'production-credentials/unrelated-secret'), 'do not ship')
  const output = join(root, 'package.tar.gz')
  createArchive(pkg, output)
  const listing = spawnSync('tar', ['-tzf', output], { encoding: 'utf8' })
  assert.equal(listing.status, 0)
  assert.match(listing.stdout, /dsh-web\/runtime\/package-lock.json/)
  assert.match(listing.stdout, /dsh-web\/plugins\/deepseek-ai-dsh-assistant-1.0.0.tgz/)
  assert.doesNotMatch(listing.stdout, /node_modules|upstream|runtime-node|unrelated-secret/)
  assert.equal(spawnSync('stat', ['-c', '%a', output], { encoding: 'utf8' }).stdout.trim(), '600')
})
