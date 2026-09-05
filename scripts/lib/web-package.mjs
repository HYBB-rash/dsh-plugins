import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, lstatSync, readdirSync, rmSync, renameSync, chmodSync } from 'node:fs'
import { dirname, join, resolve, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const sourceRoot = resolve(import.meta.dirname, '../..')
const ownDirs = ['telegram-gateway', 'dsh-cron', 'dsh-assistant']
const ownNames = ['@deepseek-ai/dsh-telegram-gateway', '@deepseek-ai/dsh-cron', '@deepseek-ai/dsh-assistant']
const retired = ['@linxin666/dsh-web-all', '@linxin666/dsh-perf']
const json = file => JSON.parse(readFileSync(file, 'utf8'))
const save = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
const required = file => {
  if (!existsSync(file) || !lstatSync(file).isFile()) throw new Error(`missing regular input: ${file}`)
}
export function run(command, args, { cwd, env = process.env, capture = false } = {}) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', capture ? 'pipe' : 'inherit', 'inherit'], maxBuffer: 16 * 1024 * 1024 })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${basename(command)} failed (${result.status ?? result.signal})`)
  return result.stdout ?? ''
}

function preflight(execute) {
  // No database files, no credentials, and no system package changes.
  execute('node', ['--input-type=module', '-e', "import { DatabaseSync } from 'node:sqlite'; import { spawnSync } from 'node:child_process'; const db=new DatabaseSync(':memory:'); db.exec('select 1'); db.close(); if(spawnSync(process.execPath,['-e','process.exit(0)']).status!==0)process.exit(1)"])
  execute('npm', ['--version'])
  execute('flock', ['--version'])
}

export function preparePackage(root, destination, { run: execute = run } = {}) {
  if (existsSync(destination)) throw new Error('prepare destination must not exist')
  preflight(execute)
  mkdirSync(join(destination, 'runtime'), { recursive: true, mode: 0o700 })
  const runtime = join(destination, 'runtime')
  save(join(runtime, 'package.json'), { name: 'dsh-web-runtime', private: true })
  // This is the single runtime latest selection for the entire batch.
  execute('npm', ['install', '--prefix', runtime, '--save-exact', '--no-audit', '--no-fund', '@deepseek-ai/dsh@latest', 'pnpm@11.24.0'])
  const manifest = json(join(runtime, 'package.json'))
  manifest.dshWebPlugins = {}
  for (const name of json(join(root, 'config/web/plugins.json'))) {
    manifest.dshWebPlugins[name] = JSON.parse(execute('npm', ['view', `${name}@latest`, 'version', '--json'], { capture: true }))
  }
  save(join(runtime, 'package.json'), manifest)
  const lock = json(join(runtime, 'package-lock.json'))
  const sdkVersion = name => {
    const version = lock.packages?.[`node_modules/${name}`]?.version
    if (!version) throw new Error(`selected runtime does not publish the required SDK: ${name}`)
    return version
  }
  const build = mkdtempSync(join(tmpdir(), 'dsh-plugin-build-'))
  try {
    const buildManifest = json(join(root, 'package.json'))
    for (const name of Object.keys(buildManifest.devDependencies)) {
      if (name.startsWith('@deepseek-ai/')) buildManifest.devDependencies[name] = sdkVersion(name)
    }
    save(join(build, 'package.json'), buildManifest)
    cpSync(join(root, 'vitest.config.ts'), join(build, 'vitest.config.ts'))
    for (const directory of ownDirs) {
      const target = join(build, directory)
      mkdirSync(target)
      for (const file of ['src', 'tests', 'package.json', 'tsconfig.json', 'tsdown.config.ts', 'cordis.patch.yml']) {
        if (existsSync(join(root, directory, file))) cpSync(join(root, directory, file), join(target, file), { recursive: true })
      }
      const pkg = json(join(target, 'package.json'))
      for (const group of ['dependencies', 'devDependencies', 'peerDependencies']) {
        for (const name of Object.keys(pkg[group] ?? {})) if (name.startsWith('@deepseek-ai/')) pkg[group][name] = sdkVersion(name)
      }
      save(join(target, 'package.json'), pkg)
    }
    execute('npm', ['install', '--prefix', build, '--ignore-scripts', '--no-audit', '--no-fund'])
    execute('npm', ['run', 'build'], { cwd: build })
    execute('npm', ['test', '--', '--reporter=dot'], { cwd: build })
    mkdirSync(join(destination, 'plugins'))
    for (const directory of ownDirs) execute('npm', ['pack', '--ignore-scripts', '--pack-destination', join(destination, 'plugins')], { cwd: join(build, directory) })
  } finally { rmSync(build, { recursive: true, force: true }) }
  mkdirSync(join(destination, 'bin'))
  mkdirSync(join(destination, 'scripts/lib'), { recursive: true })
  mkdirSync(join(destination, 'config'))
  cpSync(join(root, 'config/web/portable.patch.yml'), join(destination, 'config/web.patch.yml'))
  cpSync(join(root, 'bin/dsh'), join(destination, 'bin/dsh'))
  for (const [from, to] of [['dsh-web-install-plugins', 'install'], ['dsh-web-runtime', 'web'], ['dsh-web-start', 'start']]) cpSync(join(root, 'scripts', from), join(destination, 'bin', to))
  for (const file of ['lib/web-package.mjs', 'dsh-web-lan-proxy.mjs', 'dsh-web-notify-start-url.mjs']) cpSync(join(root, 'scripts', file), join(destination, 'scripts', file))
  return destination
}

export function installPackage(pkg, home, { run: execute = run, migrate = false } = {}) {
  for (const file of ['runtime/package.json', 'runtime/package-lock.json']) required(join(pkg, file))
  const manifest = json(join(pkg, 'runtime/package.json'))
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(manifest.dependencies?.['@deepseek-ai/dsh'] ?? '')) throw new Error('prepared runtime must select an exact version')
  const archives = ownNames.map(name => {
    const prefix = name.slice(1).replace('/', '-') + '-'
    const matches = readdirSync(join(pkg, 'plugins')).filter(file => file.startsWith(prefix) && file.endsWith('.tgz'))
    if (matches.length !== 1) throw new Error(`expected one archive for ${name}`)
    required(join(pkg, 'plugins', matches[0]))
    return matches[0]
  })
  const credentials = join(pkg, 'production-credentials')
  if (existsSync(credentials)) for (const file of ['.credentials.yaml', 'secrets/notion.token']) required(join(credentials, file))
  const profileFile = join(home, 'profiles/web/package.json')
  const legacy = existsSync(profileFile) && !existsSync(join(home, 'runtime/package.json'))
  if (legacy && !migrate) throw new Error('legacy Profile: stop the previous runtime, then explicitly install with --migrate')
  preflight(execute)
  if (migrate && existsSync(profileFile)) {
    const backup = join(home, 'recovery', `before-npm-${Date.now()}`)
    mkdirSync(backup, { recursive: true, mode: 0o700 })
    for (const file of ['profiles/web', 'runtime', 'plugin-packages', '.credentials.yaml', 'secrets']) {
      if (existsSync(join(home, file))) cpSync(join(home, file), join(backup, file), { recursive: true })
    }
    console.error(`Profile/runtime backup: ${backup}`)
  }
  const runtime = join(home, 'runtime')
  mkdirSync(runtime, { recursive: true, mode: 0o700 })
  for (const file of ['package.json', 'package-lock.json']) cpSync(join(pkg, 'runtime', file), join(runtime, file))
  execute('npm', ['ci', '--prefix', runtime, '--no-audit', '--no-fund'])
  // Exercise the installed native terminal before changing the Web Profile.
  execute('node', ['-e', "const p=require('node-pty').spawn('bash',['-lc','printf dsh-pty-ok'],{cwd:process.cwd(),env:process.env});let out='';p.onData(s=>out+=s);p.onExit(e=>process.exit(e.exitCode===0&&out.includes('dsh-pty-ok')?0:1));setTimeout(()=>{p.kill();process.exit(1)},5000).unref()"], { cwd: runtime })
  const env = { ...process.env, DSH_HOME: home, DSH_WEB_HOME: home, DSH_RUNTIME_ROOT: runtime, PATH: `${join(runtime, 'node_modules/.bin')}:${process.env.PATH}` }
  const cli = join(pkg, 'bin/dsh')
  // Inspect the official manifest, but leave all bundle/node_modules writes to plugin management.
  const previous = existsSync(profileFile) ? json(profileFile).dependencies ?? {} : {}
  const webSpecs = Object.entries(manifest.dshWebPlugins ?? {}).map(([name, version]) => `${name}@${version}`)
  // An explicit add both pins the selected versions and lets the official
  // package manager apply its policy for those deliberately requested releases.
  // Do this before removal, which can otherwise verify a newer existing lock
  // without the explicit package requests that justify its release-age entries.
  if (webSpecs.length) execute(cli, ['plugin', '--profile', 'web', 'add', '--ignore-scripts', '--save-exact', ...webSpecs], { env })
  const removals = [...retired, ...ownNames].filter(name => Object.hasOwn(previous, name))
  if (removals.length) execute(cli, ['plugin', '--profile', 'web', 'remove', ...removals], { env })
  const archiveHome = join(home, 'plugin-packages')
  mkdirSync(archiveHome, { recursive: true, mode: 0o700 })
  for (const file of archives) cpSync(join(pkg, 'plugins', file), join(archiveHome, file))
  execute(cli, ['plugin', '--profile', 'web', 'add', '--ignore-scripts', '--save-exact', ...archives.map(file => join(archiveHome, file))], { env })
  execute(cli, ['--profile', 'web', '--patch', join(pkg, 'config/web.patch.yml'), '--dump-config'], { env, capture: true })
  if (existsSync(credentials)) {
    mkdirSync(join(home, 'secrets'), { recursive: true, mode: 0o700 })
    for (const file of ['.credentials.yaml', 'secrets/notion.token']) {
      cpSync(join(credentials, file), join(home, file))
      chmodSync(join(home, file), 0o600)
    }
  }
}

export function createArchive(pkg, output) {
  required(join(pkg, 'runtime/package.json'))
  required(join(pkg, 'runtime/package-lock.json'))
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 })
  const staging = mkdtempSync(join(dirname(output), '.dsh-package-'))
  try {
    const target = join(staging, 'dsh-web')
    mkdirSync(join(target, 'runtime'), { recursive: true })
    for (const file of ['package.json', 'package-lock.json']) cpSync(join(pkg, 'runtime', file), join(target, 'runtime', file))
    for (const directory of ['plugins', 'config', 'bin', 'scripts']) {
      if (existsSync(join(pkg, directory))) cpSync(join(pkg, directory), join(target, directory), { recursive: true })
    }
    if (existsSync(join(pkg, 'production-credentials'))) {
      mkdirSync(join(target, 'production-credentials/secrets'), { recursive: true, mode: 0o700 })
      for (const file of ['.credentials.yaml', 'secrets/notion.token']) {
        required(join(pkg, 'production-credentials', file))
        cpSync(join(pkg, 'production-credentials', file), join(target, 'production-credentials', file))
        chmodSync(join(target, 'production-credentials', file), 0o600)
      }
    }
    const temporary = join(staging, 'archive.tar.gz')
    run('tar', ['-czf', temporary, '-C', staging, 'dsh-web'])
    chmodSync(temporary, 0o600)
    renameSync(temporary, output)
  } finally { rmSync(staging, { recursive: true, force: true }) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.umask(0o077)
  try {
    const [action, ...args] = process.argv.slice(2)
    if (action === 'prepare') {
      if (args.length !== 1) throw new Error('usage: prepare <new-package-directory>')
      preparePackage(sourceRoot, resolve(args[0]))
    } else if (action === 'install') {
      const home = resolve(process.env.DSH_WEB_HOME ?? process.env.DSH_HOME ?? join(sourceRoot, '.dsh-web'))
      if (args.some(arg => arg !== '--migrate')) throw new Error('usage: install [--migrate]')
      installPackage(sourceRoot, home, { migrate: args.includes('--migrate') })
    } else if (action === 'package') {
      if (args.length !== 1) throw new Error('usage: package <output.tar.gz>')
      const credentials = process.env.DSH_WEB_PRODUCTION_CREDENTIALS ?? join(sourceRoot, 'config/web/production-credentials')
      for (const file of ['.credentials.yaml', 'secrets/notion.token']) required(join(credentials, file))
      const work = mkdtempSync(join(tmpdir(), 'dsh-prepare-'))
      try {
        const pkg = preparePackage(sourceRoot, join(work, 'dsh-web'))
        mkdirSync(join(pkg, 'production-credentials/secrets'), { recursive: true, mode: 0o700 })
        for (const file of ['.credentials.yaml', 'secrets/notion.token']) cpSync(join(credentials, file), join(pkg, 'production-credentials', file))
        const output = resolve(args[0])
        createArchive(pkg, output)
        console.log(`archive: ${output}\nsha256: ${createHash('sha256').update(readFileSync(output)).digest('hex')}`)
      } finally { rmSync(work, { recursive: true, force: true }) }
    } else throw new Error('expected prepare, install or package')
  } catch (error) { console.error(`dsh web: ${error.message}`); process.exitCode = 1 }
}
