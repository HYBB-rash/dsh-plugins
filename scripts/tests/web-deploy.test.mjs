import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync, readlinkSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

const repository = resolve(import.meta.dirname, '../..')
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-deploy-contract-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'scripts'))
  mkdirSync(join(root, 'fake-bin'))
  return root
}
const script = (path, text) => writeFileSync(path, '#!/usr/bin/env bash\nset -euo pipefail\n' + text, { mode: 0o755 })

test('upload writes an incoming batch, not current, and never executes install/start/stop remotely', t => {
  const root = fixture(t)
  for (const file of ['dsh-web-deploy', 'dsh-web-install', 'dsh-web-start', 'dsh-web-notify-start-url.mjs']) cpSync(join(repository, 'scripts', file), join(root, 'scripts', file))
  script(join(root, 'scripts/package-dsh-web'), 'printf archive >"$1"\n')
  for (const command of ['ssh', 'scp']) script(join(root, 'fake-bin', command), 'printf "%s\\n" "$0 $*" >>"$TEST_COMMAND_LOG"\n')
  const log = join(root, 'commands')
  const result = spawnSync(join(root, 'scripts/dsh-web-deploy'), [], { encoding: 'utf8', env: { ...process.env, PATH: `${root}/fake-bin:${process.env.PATH}`, TEST_COMMAND_LOG: log, DSH_WEB_REMOTE_ROOT: '/deployment', DSH_WEB_DEPLOY_TARGET: 'test-host' } })
  assert.equal(result.status, 0, result.stderr)
  const commands = readFileSync(log, 'utf8').trim().split('\n')
  const ssh = commands.filter(line => line.includes('/ssh '))
  assert.ok(ssh.length > 0 && ssh.every(line => /test-host install -d -m 0700 \/deployment/.test(line)))
  const uploads = commands.filter(line => line.includes('/scp '))
  assert.equal(uploads.length, 4)
  assert.ok(uploads.every(line => /test-host:\/deployment\/incoming\/[a-f0-9]{64}\//.test(line)))
  assert.ok(uploads.some(line => line.endsWith('/dsh-web-install')))
  assert.doesNotMatch(commands.join('\n'), /systemctl|pkill|reset --hard|\/current/)
})

test('local preparation never overwrites active launch files or invokes a service manager', t => {
  const root = fixture(t)
  for (const file of ['dsh-web-local-deploy', 'dsh-web-install', 'dsh-web-start']) cpSync(join(repository, 'scripts', file), join(root, 'scripts', file))
  script(join(root, 'scripts/package-dsh-web'), 'printf archive >"$1"\n')
  const destination = join(root, 'deployment')
  mkdirSync(destination)
  writeFileSync(join(destination, 'dsh-web-start'), 'active launcher')
  for (const command of ['systemctl', 'pkill', 'git', 'npm']) script(join(root, 'fake-bin', command), 'echo forbidden >&2; exit 98\n')
  const result = spawnSync(join(root, 'scripts/dsh-web-local-deploy'), [], { encoding: 'utf8', env: { ...process.env, PATH: `${root}/fake-bin:${process.env.PATH}`, DSH_WEB_PACKAGE_ROOT: destination, DSH_WEB_PRODUCTION_CREDENTIALS: join(root, 'synthetic-credentials') } })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(readFileSync(join(destination, 'dsh-web-start'), 'utf8'), 'active launcher')
  const batch = result.stdout.match(/prepared: (.+)/)?.[1]
  assert.ok(batch?.startsWith(join(destination, 'incoming') + '/'))
  for (const file of ['dsh-web.tar.gz', 'dsh-web.tar.gz.sha256', 'dsh-web-install', 'dsh-web-start']) assert.ok(existsSync(join(batch, file)))
})

// Regressions: publishing current inside incoming instead of the unit's root,
// accepting a running/mismatched unit, or selecting packages again on install.
for (const scenario of ['success', 'install-failed', 'active', 'wrong-entry', 'bad-checksum']) {
  test(`local batch handoff: ${scenario}`, t => {
    const root = fixture(t)
    const destination = join(root, 'deployment')
    const batch = join(destination, 'incoming/batch.test')
    const home = join(root, 'home')
    const payload = join(root, 'payload/dsh-web/bin')
    for (const dir of [batch, home, payload, join(destination, 'old/bin')]) mkdirSync(dir, {recursive:true})
    symlinkSync('old', join(destination, 'current'))
    writeFileSync(join(home, 'business-state'), 'preserved')
    script(join(payload, 'install'), `[[ "$DSH_WEB_HOME" == "$DSH_HOME" ]] || exit 97\nprintf '%s\\n' "$*" >"$DSH_HOME/install-arguments"\nexit ${scenario === 'install-failed' ? 42 : 0}\n`)
    const startMarker = join(root, 'web-started')
    script(join(payload, 'web'), `touch '${startMarker}'\nprintf "new web %s\\n" "$*"\n`)
    const archive = join(batch, 'dsh-web.tar.gz')
    assert.equal(spawnSync('tar', ['-czf', archive, '-C', join(root, 'payload'), 'dsh-web']).status, 0)
    const sha = createHash('sha256').update(readFileSync(archive)).digest('hex')
    writeFileSync(archive + '.sha256', `${scenario === 'bad-checksum' ? '0'.repeat(64) : sha}  dsh-web.tar.gz\n`)
    cpSync(join(repository, 'scripts/dsh-web-install'), join(batch, 'dsh-web-install'))
    cpSync(join(repository, 'scripts/dsh-web-local-deploy'), join(root, 'scripts/dsh-web-local-deploy'))
    script(join(root, 'scripts/package-dsh-web'), 'echo unexpected-rebuild >&2; exit 98\n')
    const entry = scenario === 'wrong-entry' ? '/another/current/bin/web' : join(destination, 'current/bin/web')
    script(join(root, 'fake-bin/systemctl'), `[[ "$*" == '--user show dsh-web-local.service -p ActiveState -p MainPID -p ExecStart' ]] || exit 98\nprintf '%s\\n' 'ActiveState=${scenario === 'active' ? 'active' : 'inactive'}' 'MainPID=${scenario === 'active' ? '123' : '0'}' 'ExecStart={ path=${entry} ; argv[]=${entry} --host 127.0.0.1 --port 3080 --no-open ; }'\n`)
    for (const command of ['npm', 'ssh', 'scp']) script(join(root, 'fake-bin', command), 'exit 98\n')
    const result = spawnSync(join(root, 'scripts/dsh-web-local-deploy'), ['install', batch], {encoding:'utf8', env:{...process.env, DSH_HOME:home, DSH_WEB_HOME:'/must-not-use', DSH_WEB_PACKAGE_ROOT:destination, PATH:`${root}/fake-bin:${process.env.PATH}`}})
    assert.equal(existsSync(startMarker), false, 'installation must not start Web')
    if (scenario === 'success') {
      assert.equal(result.status, 0, result.stderr)
      assert.equal(readlinkSync(join(destination, 'current')), `releases/${sha}`)
      const started = spawnSync(join(destination, 'current/bin/web'), ['--host', '127.0.0.1', '--port', '3080', '--no-open'], {encoding:'utf8'})
      assert.equal(started.stdout, 'new web --host 127.0.0.1 --port 3080 --no-open\n')
    } else {
      assert.notEqual(result.status, 0)
      if (scenario === 'install-failed') assert.equal(result.status, 42)
      assert.equal(readlinkSync(join(destination, 'current')), 'old')
      if (scenario === 'active') assert.match(result.stderr, /stop dsh-web-local.service/)
      if (scenario === 'wrong-entry') assert.match(result.stderr, /ExecStart/)
      if (scenario === 'bad-checksum') assert.match(result.stdout + result.stderr, /checksum|FAILED/)
    }
    assert.equal(existsSync(join(batch, 'current')), false)
    assert.equal(readFileSync(join(home, 'business-state'), 'utf8'), 'preserved')
    if (['success', 'install-failed'].includes(scenario)) assert.equal(readFileSync(join(home, 'install-arguments'), 'utf8'), '--migrate\n')
    else assert.equal(existsSync(join(home, 'install-arguments')), false)
  })
}

test('local preparation requires explicitly selected local credentials before preparing anything', t => {
  const root = fixture(t)
  cpSync(join(repository, 'scripts/dsh-web-local-deploy'), join(root, 'scripts/dsh-web-local-deploy'))
  script(join(root, 'scripts/package-dsh-web'), 'echo should-not-package >&2; exit 98\n')
  const destination = join(root, 'deployment')
  const result = spawnSync(join(root, 'scripts/dsh-web-local-deploy'), [], {encoding:'utf8',env:{...process.env,DSH_WEB_PACKAGE_ROOT:destination,DSH_WEB_PRODUCTION_CREDENTIALS:''}})
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /DSH_WEB_PRODUCTION_CREDENTIALS/)
  assert.equal(existsSync(destination), false)
})

for (const exitCode of [0, 42]) test(`archive installation keeps start separate and switches current only on success (${exitCode})`, t => {
  const root = fixture(t)
  const payload = join(root, 'payload/dsh-web/bin')
  mkdirSync(payload, { recursive: true })
  script(join(payload, 'install'), `printf '%s\\n' "$*" >"$DSH_HOME/install-arguments"\nexit ${exitCode}\n`)
  script(join(payload, 'web'), 'echo forbidden >&2; exit 99\n')
  const archive = join(root, 'dsh-web.tar.gz')
  assert.equal(spawnSync('tar', ['-czf', archive, '-C', join(root, 'payload'), 'dsh-web']).status, 0)
  const sha = createHash('sha256').update(readFileSync(archive)).digest('hex')
  writeFileSync(archive + '.sha256', `${sha}  dsh-web.tar.gz\n`)
  cpSync(join(repository, 'scripts/dsh-web-install'), join(root, 'dsh-web-install'))
  mkdirSync(join(root, 'home'))
  mkdirSync(join(root, 'old'))
  symlinkSync('old', join(root, 'current'))
  const result = spawnSync(join(root, 'dsh-web-install'), ['--migrate'], { encoding: 'utf8', env: { ...process.env, DSH_WEB_PACKAGE_ROOT: root, DSH_HOME: join(root, 'home') } })
  assert.equal(result.status, exitCode, result.stderr)
  assert.equal(readFileSync(join(root, 'home/install-arguments'), 'utf8'), '--migrate\n')
  assert.equal(readlinkSync(join(root, 'current')), exitCode === 0 ? `releases/${sha}` : 'old')
})

for (const override of [false, true]) test(`remote start loads config and public origin without installing (custom environment: ${override})`, t => {
  const root = fixture(t)
  const release = join(root, 'release')
  for (const directory of ['bin', 'scripts', 'config']) mkdirSync(join(release, directory), { recursive: true })
  writeFileSync(join(release, 'config/remote.patch.yml'), '')
  mkdirSync(join(root, 'home/runtime'), { recursive: true })
  writeFileSync(join(root, 'home/runtime/package-lock.json'), '{}')
  cpSync(join(repository, 'scripts/dsh-web-start'), join(root, 'dsh-web-start'))
  symlinkSync('release', join(root, 'current'))
  script(join(release, 'bin/dsh'), 'printf "cli %s\\n" "$*" >>"$TEST_COMMAND_LOG"\n')
  script(join(release, 'bin/web'), 'printf "web %s\\n" "$*" >>"$TEST_COMMAND_LOG"\nprintf "bind %s:%s public %s\\n" "$DSH_WEB_HOST" "$DSH_WEB_PORT" "$DSH_REMOTE_PUBLIC_BASE_URL" >>"$TEST_COMMAND_LOG"\nexit 7\n')
  writeFileSync(join(release, 'scripts/dsh-web-notify-start-url.mjs'), '')
  for (const command of ['npm', 'pnpm', 'tar', 'systemctl']) script(join(root, 'fake-bin', command), 'echo forbidden >&2; exit 98\n')
  const log = join(root, 'commands')
  const result = spawnSync(join(root, 'dsh-web-start'), [], { encoding: 'utf8', timeout: 5000, env: { ...process.env, DSH_WEB_HOME: '', DSH_HOME: join(root, 'home'), DSH_WEB_HOST: override ? '127.0.0.1' : '', DSH_WEB_PORT: override ? '5095' : '', DSH_WEB_PUBLIC_ORIGIN: 'https://dsh.man-her.icu', DSH_REMOTE_PUBLIC_BASE_URL: override ? 'https://dsh.example.test' : '', PATH: `${root}/fake-bin:${process.env.PATH}`, TEST_COMMAND_LOG: log } })
  assert.equal(result.status, 7, result.stderr)
  const commands = readFileSync(log, 'utf8')
  assert.match(commands, /cli --version/)
  assert.ok(commands.includes(`web --patch ${release}/config/remote.patch.yml --port ${override ? '5095' : '3080'} --no-open`))
  assert.ok(commands.includes(override ? 'bind 127.0.0.1:5095 public https://dsh.example.test' : 'bind 0.0.0.0:3080 public https://dsh.man-her.icu'))
  assert.doesNotMatch(commands, /--host|--trusted-host/)
  assert.doesNotMatch(commands, /install|latest/)
})

test('remote start refuses conflicting CLI bind flags before touching an installation', t => {
  const root = fixture(t)
  cpSync(join(repository, 'scripts/dsh-web-start'), join(root, 'dsh-web-start'))
  for (const args of [['--host', '0.0.0.0'], ['--port=5095']]) {
    const result = spawnSync(join(root, 'dsh-web-start'), args, {encoding:'utf8',env:{...process.env,DSH_HOME:join(root,'missing-home')}})
    assert.equal(result.status, 1)
    assert.match(result.stderr, /set DSH_WEB_HOST \/ DSH_WEB_PORT/)
    assert.ok(!existsSync(join(root,'missing-home')))
  }
})

test('terminating the supervisor stops the complete Web process group without a LAN proxy', async t => {
  const root = fixture(t)
  const release = join(root, 'release')
  for (const directory of ['bin', 'scripts', 'config']) mkdirSync(join(release, directory), { recursive: true })
  writeFileSync(join(release, 'config/remote.patch.yml'), '')
  mkdirSync(join(root, 'home/runtime'), { recursive: true })
  writeFileSync(join(root, 'home/runtime/package-lock.json'), '{}')
  cpSync(join(repository, 'scripts/dsh-web-start'), join(root, 'dsh-web-start'))
  writeFileSync(join(release, 'scripts/dsh-web-notify-start-url.mjs'), '')
  symlinkSync('release', join(root, 'current'))
  script(join(release, 'bin/dsh'), 'exit 0\n')
  script(join(release, 'bin/web'), 'sleep 20 &\nchild=$!\nprintf "ready %s %s\\n" "$$" "$child"\ntrap \'wait "$child" 2>/dev/null || true; exit 143\' TERM\nwait "$child"\n')
  const child = spawn(join(root, 'dsh-web-start'), [], {
    env: { ...process.env, DSH_HOME: join(root, 'home') },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  const stopped = new Promise(resolve => child.once('exit', resolve))
  const ready = await new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), 3000)
    child.stdout.on('data', data => {
      output += data
      if (/ready \d+ \d+/.test(output)) { clearTimeout(timer); resolve(true) }
    })
    child.once('exit', () => { clearTimeout(timer); resolve(false) })
  })
  if (child.exitCode === null) child.kill('SIGTERM')
  await stopped
  assert.equal(ready, true, 'Web must start without a proxy file in the release')
  for (const pid of output.match(/ready (\d+) (\d+)/).slice(1)) {
    assert.throws(() => process.kill(Number(pid), 0), {code:'ESRCH'}, `Web descendant ${pid} must be stopped`)
  }
})
