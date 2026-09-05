import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, symlinkSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync, spawn } from 'node:child_process'

const repository = resolve(import.meta.dirname, '../..')
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-npm-contract-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const dir of ['bin', 'scripts', 'config/web', 'work space', 'home/runtime/node_modules/.bin', 'home/runtime/node_modules/@deepseek-ai/dsh/lib']) mkdirSync(join(root, dir), { recursive: true })
  for (const file of ['bin/dsh', 'scripts/dsh-web-runtime']) cpSync(join(repository, file), join(root, file))
  writeFileSync(join(root, 'config/web/portable.patch.yml'), '[]\n')
  writeFileSync(join(root, 'home/runtime/package.json'), JSON.stringify({ private: true, dependencies: { '@deepseek-ai/dsh': '0.1.2-rc.1' } }))
  const cliRoot = join(root, 'home/runtime/node_modules/@deepseek-ai/dsh')
  writeFileSync(join(cliRoot, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.2-rc.1', type: 'module', bin: { dsh: 'lib/bin.js' } }))
  writeFileSync(join(cliRoot, 'lib/bin.js'), '#!/usr/bin/env node\nconsole.log(JSON.stringify({args:process.argv.slice(2),flags:process.execArgv,cwd:process.cwd(),home:process.env.DSH_HOME,cli:process.argv[1]}))\n', { mode: 0o755 })
  symlinkSync('../@deepseek-ai/dsh/lib/bin.js', join(root, 'home/runtime/node_modules/.bin/dsh'))
  return { root, cliRoot, env: { ...process.env, DSH_HOME: join(root, 'home'), DSH_WEB_HOME: join(root, 'home'), DSH_CWD: join(root, 'work space'), npm_config_registry: 'http://127.0.0.1:9', npm_config_offline: 'true' } }
}

// Catches falling back to an npm cache/global CLI, losing loader flags or shell-escaping user arguments.
test('official CLI starts offline from its installation and preserves literal arguments', t => {
  const { root, cliRoot, env } = fixture(t)
  const value = 'literal $(touch must-not-exist); space'
  const result = spawnSync(join(root, 'bin/dsh'), ['--patch', value], { env, encoding: 'utf8', timeout: 15000 })
  assert.equal(result.status, 0, result.stderr)
  const output = JSON.parse(result.stdout.trim())
  assert.deepEqual(output.args, ['--patch', value])
  assert.ok(output.flags.includes('--expose-internals'))
  assert.equal(output.cli, join(cliRoot, 'lib/bin.js'))
  assert.equal(output.cwd, env.DSH_CWD)
})

test('Web defaults to 5080, honors explicit port, and does not add a port to config dumps', t => {
  const { root, env } = fixture(t)
  for (const [args, expected] of [[[], ['--port', '5080']], [['--port', '5093'], ['--port', '5093']], [['--dump-config'], ['--dump-config']]]) {
    const result = spawnSync(join(root, 'scripts/dsh-web-runtime'), args, { env, encoding: 'utf8', timeout: 15000 })
    assert.equal(result.status, 0, result.stderr)
    const output = JSON.parse(result.stdout.trim())
    assert.deepEqual(output.args.slice(-expected.length), expected)
    assert.equal(output.cwd, env.DSH_CWD)
    assert.equal(output.home, env.DSH_HOME)
  }
})

test('missing or mismatched installed CLI fails instead of invoking another available dsh', t => {
  const { root, cliRoot, env } = fixture(t)
  writeFileSync(join(cliRoot, 'package.json'), '{"name":"@deepseek-ai/dsh","version":"9.9.9"}')
  const before = readFileSync(join(root, 'home/runtime/package.json'), 'utf8')
  const result = spawnSync(join(root, 'bin/dsh'), ['--version'], { env, encoding: 'utf8', timeout: 10000 })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /installed.*version|version.*mismatch/i)
  assert.equal(readFileSync(join(root, 'home/runtime/package.json'), 'utf8'), before)
})

test('installation refuses the running-home lock without changing its runtime', async t => {
  const { root, env } = fixture(t)
  cpSync(join(repository, 'scripts/dsh-web-install-plugins'), join(root, 'scripts/dsh-web-install-plugins'))
  const holder = spawn('flock', ['-n', join(env.DSH_HOME, '.web-runtime.lock'), 'bash', '-c', 'echo locked; read -r line'], { stdio: ['pipe', 'pipe', 'pipe'] })
  t.after(() => { holder.stdin.end(); holder.kill() })
  await new Promise((resolve, reject) => { holder.stdout.once('data', resolve); holder.once('error', reject) })
  const before = readFileSync(join(env.DSH_HOME, 'runtime/package.json'), 'utf8')
  const result = spawnSync(join(root, 'scripts/dsh-web-install-plugins'), [], { env, encoding: 'utf8', timeout: 3000 })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /stop this DSH_HOME runtime/)
  assert.equal(readFileSync(join(env.DSH_HOME, 'runtime/package.json'), 'utf8'), before)
})
