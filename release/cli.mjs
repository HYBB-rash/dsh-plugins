#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const releaseRoot = dirname(fileURLToPath(import.meta.url))
const repoRoot = dirname(releaseRoot)
const stateRoot = resolve(process.env.DSH_RELEASE_STATE_ROOT ?? join(homedir(), '.local/share/dsh-container'))
const harnessRepo = resolve(process.env.DSH_HARNESS_REPO ?? '/home/herman/Documents/Codex/2026-08-14/deepseek-harness')
const target = process.env.DSH_DEPLOY_TARGET ?? 'herman.hermes'
const engine = process.env.DSH_CONTAINER_ENGINE ?? 'podman'
const composePath = join(releaseRoot, 'compose.production.yml')
const patchPath = join(releaseRoot, 'patches/harness-minimal-shell-path.patch')
const exitCodes = Object.freeze({ usage: 2, approval: 3, safety: 4, test: 5, production: 6 })

class DshError extends Error {
  constructor(message, code = exitCodes.safety) {
    super(message)
    this.exitCode = code
  }
}

const fail = (message, code) => { throw new DshError(message, code) }
const out = (value) => process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`)
const warn = (message) => process.stderr.write(`清理警告：${message}\n`)
const ensureDir = (path) => mkdirSync(path, { recursive: true })
const nowId = () => new Date().toISOString().replaceAll(/[-:.]/g, '').replace('T', 'T').replace('Z', 'Z')
const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`
const commandText = (command, args) => [command, ...args].map(shellQuote).join(' ')

function run(command, args = [], options = {}) {
  if (options.announce !== false) process.stderr.write(`+ ${commandText(command, args)}\n`)
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    input: options.input,
    encoding: 'utf8',
    stdio: options.capture ? ['pipe', 'pipe', 'pipe'] : [options.input === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'],
    maxBuffer: 128 * 1024 * 1024,
  })
  if (result.error) fail(`无法执行 ${command}: ${result.error.message}`, options.code)
  if (result.status !== 0) {
    const detail = options.capture ? `\n${String(result.stderr ?? '').trim()}` : ''
    fail(`${command} 退出码 ${result.status}${detail}`, options.code)
  }
  return options.capture ? String(result.stdout).trim() : ''
}

function runStatus(command, args = [], options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    input: options.input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 128 * 1024 * 1024,
  })
}

function ssh(script, { capture = true, code = exitCodes.production } = {}) {
  return run('ssh', ['-o', 'BatchMode=yes', target, 'bash', '-s'], { input: script, capture, code })
}

function sha256File(path) {
  const result = run('sha256sum', ['--', path], { capture: true, announce: false, code: exitCodes.safety })
  const match = /^([0-9a-f]{64})\s/u.exec(result)
  if (match === null) fail(`无法解析 ${path} 的 SHA-256`, exitCodes.safety)
  return `sha256:${match[1]}`
}

function sha256Text(text) {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`
}

function writeJson(path, value) {
  ensureDir(dirname(path))
  const next = `${path}.next-${process.pid}`
  writeFileSync(next, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(next, path)
}

function readJson(path, label = path) {
  if (!existsSync(path)) fail(`找不到 ${label}: ${path}`, exitCodes.usage)
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch (error) { fail(`${label} 不是有效 JSON: ${error.message}`, exitCodes.usage) }
}

function parseOptions(tokens) {
  const options = { _: [] }
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token.startsWith('--')) { options._.push(token); continue }
    const key = token.slice(2)
    if (['approved-stop', 'approved', 'synthetic', 'reset'].includes(key)) { options[key] = true; continue }
    const value = tokens[index + 1]
    if (value === undefined || value.startsWith('--')) fail(`参数 ${token} 缺少值`, exitCodes.usage)
    options[key] = value
    index += 1
  }
  return options
}

function requireFullCommit(repo, ref, name) {
  if (!/^[0-9a-f]{40}$/.test(ref ?? '')) fail(`${name} 必须是完整的 40 位 Git commit`, exitCodes.usage)
  const resolved = run('git', ['-C', repo, 'rev-parse', '--verify', `${ref}^{commit}`], { capture: true, announce: false, code: exitCodes.usage })
  if (resolved !== ref) fail(`${name} 没有解析为指定 commit`, exitCodes.usage)
  return resolved
}

function requireLatestMainAncestor(commit, label) {
  run('git', ['-C', repoRoot, 'fetch', 'origin'], { code: exitCodes.safety })
  const originMain = run('git', ['-C', repoRoot, 'rev-parse', 'origin/main'], {
    capture: true,
    announce: false,
    code: exitCodes.safety,
  })
  const basedOnLatestMain = runStatus('git', ['-C', repoRoot, 'merge-base', '--is-ancestor', originMain, commit])
  if (basedOnLatestMain.status !== 0) {
    fail(`${label} ${commit} 没有基于最新 origin/main ${originMain}；请先 rebase 后再继续`, exitCodes.safety)
  }
  return originMain
}

function verifyDevelopmentCandidateImage(candidate) {
  const localImageId = imageId(candidate.imageTag)
  if (localImageId !== candidate.imageId) fail(`开发底座镜像身份改变: ${candidate.imageId} -> ${localImageId}`, exitCodes.safety)
  const purpose = run(engine, ['image', 'inspect', candidate.imageTag, '--format', '{{index .Config.Labels "io.dsh.candidate.purpose"}}'], {
    capture: true,
    announce: false,
    code: exitCodes.safety,
  })
  if (purpose !== 'development') fail(`开发底座镜像缺少用途身份: ${purpose || 'missing'}`, exitCodes.safety)
}

function candidateFrom(value, { verifyDevelopmentImage = true } = {}) {
  const path = value ? resolve(value) : join(stateRoot, 'candidates/latest.json')
  const candidate = readJson(path, 'candidate')
  for (const field of ['imageId', 'imageTag', 'pluginsCommit', 'releaseToolCommit', 'harnessCommit']) {
    if (!candidate[field]) fail(`candidate 缺少 ${field}`, exitCodes.usage)
  }
  if (candidate.status !== 'tested') fail(`candidate 尚未通过镜像测试，当前状态是 ${candidate.status ?? 'missing'}`, exitCodes.safety)
  if (candidatePurpose(candidate) === 'development') {
    if (verifyDevelopmentImage) verifyDevelopmentCandidateImage(candidate)
    return { candidate, path }
  }
  if (!candidate.archiveSha256) fail('正式 candidate 缺少 archiveSha256', exitCodes.usage)
  if (!candidate.archivePath) fail('正式 candidate 缺少 archivePath', exitCodes.usage)
  if (!existsSync(candidate.archivePath)) fail(`candidate 镜像归档不存在: ${candidate.archivePath}`, exitCodes.safety)
  if (sha256File(candidate.archivePath) !== candidate.archiveSha256) fail('candidate 镜像归档摘要不匹配', exitCodes.safety)
  const manifestText = run('tar', ['-xOf', candidate.archivePath, 'manifest.json'], { capture: true, announce: false, code: exitCodes.safety })
  let archiveEntries
  try {
    archiveEntries = JSON.parse(manifestText).map(({ Config, RepoTags = [] }) => ({
      imageId: basename(Config, '.json').replace(/^sha256:/u, ''),
      repoTags: RepoTags,
    }))
  } catch (error) {
    fail(`无法读取 candidate 镜像归档身份: ${error.message}`, exitCodes.safety)
  }
  const archiveEntry = archiveEntries.find(({ imageId: value }) => value === candidate.imageId.replace(/^sha256:/u, ''))
  if (archiveEntry === undefined) {
    fail(`candidate 声明的 image ID 不在镜像归档中: ${candidate.imageId}`, exitCodes.safety)
  }
  const acceptedTags = new Set([candidate.imageTag, `localhost/${candidate.imageTag}`])
  if (!archiveEntry.repoTags.some((tag) => acceptedTags.has(tag))) fail(`candidate 声明的镜像标签不在归档中: ${candidate.imageTag}`, exitCodes.safety)
  return { candidate, path }
}

function imageId(name) {
  return run(engine, ['image', 'inspect', name, '--format', '{{.Id}}'], { capture: true, code: exitCodes.safety })
}

function archiveStagingRoot(candidateDir) {
  if (process.env.DSH_RELEASE_ARCHIVE_STAGING_ROOT) {
    const configured = resolve(process.env.DSH_RELEASE_ARCHIVE_STAGING_ROOT)
    ensureDir(configured)
    return configured
  }
  if (existsSync('/dev/shm')) {
    const availableText = run('df', ['--output=avail', '--block-size=1', '/dev/shm'], { capture: true, announce: false, code: exitCodes.safety })
    const available = Number(availableText.split(/\s+/u).at(-1))
    if (Number.isFinite(available) && available >= 8 * 1024 ** 3) {
      const automatic = '/dev/shm/dsh-release-staging'
      ensureDir(automatic)
      return automatic
    }
  }
  return candidateDir
}

function candidatePurpose(candidate) {
  return candidate.purpose ?? 'release'
}

function developmentCandidatePointerPath() {
  return join(stateRoot, 'dev/main-candidate.json')
}

function developmentKey(sourcePath) {
  return createHash('sha256').update(resolve(sourcePath)).digest('hex')
}

function developmentRuntimePath(sourcePath) {
  return join(stateRoot, 'dev/runtimes', `${developmentKey(sourcePath)}.json`)
}

function normalizeDevelopmentRuntime(runtime) {
  if (!runtime?.key || !runtime?.sourcePath) return runtime
  return {
    ...runtime,
    schemaVersion: 3,
    toolbox: runtime.toolbox ?? `dsh-dev-${runtime.key.slice(0, 12)}-toolbox`,
  }
}

function legacyDevelopmentRuntime() {
  return {
    schemaVersion: 1,
    legacy: true,
    network: 'dsh-dev-internal',
    fakeTelegram: 'dsh-dev-fake-telegram',
    telegram: 'dsh-dev-telegram',
    web: 'dsh-dev-web',
    webPort: 13080,
  }
}

function allocatedDevelopmentPorts() {
  const ports = new Set()
  const runtimesRoot = join(stateRoot, 'dev/runtimes')
  if (!existsSync(runtimesRoot)) return ports
  for (const name of readdirSync(runtimesRoot)) {
    if (!name.endsWith('.json')) continue
    try {
      const runtime = readJson(join(runtimesRoot, name), 'development runtime')
      if (Number.isInteger(runtime.webPort)) ports.add(runtime.webPort)
    } catch (error) {
      warn(error.message)
    }
  }
  return ports
}

function listeningTcpPorts() {
  const result = runStatus('ss', ['-H', '-ltn'])
  if (result.status !== 0) return new Set()
  const ports = new Set()
  for (const line of String(result.stdout).split('\n')) {
    const match = /:(\d+)\s/u.exec(line)
    if (match !== null) ports.add(Number(match[1]))
  }
  return ports
}

function withShortStateLock(name, operation) {
  const locksRoot = join(stateRoot, 'locks')
  const lockPath = join(locksRoot, `${name}.lock`)
  ensureDir(locksRoot)
  const started = Date.now()
  while (true) {
    try {
      mkdirSync(lockPath)
      writeJson(join(lockPath, 'owner.json'), { pid: process.pid, createdAt: new Date().toISOString() })
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      try {
        const owner = readJson(join(lockPath, 'owner.json'), `${name} lock owner`)
        try { process.kill(owner.pid, 0) } catch (processError) {
          if (processError.code === 'ESRCH') rmSync(lockPath, { recursive: true, force: true })
        }
      } catch {}
      if (Date.now() - started > 30_000) fail(`等待 ${name} 状态锁超时`, exitCodes.safety)
      sleepSync(100)
    }
  }
  try {
    return operation()
  } finally {
    rmSync(lockPath, { recursive: true, force: true })
  }
}

function developmentRuntime(sourcePath, { create = false } = {}) {
  const resolvedSource = resolve(sourcePath)
  const key = developmentKey(resolvedSource)
  const path = developmentRuntimePath(resolvedSource)
  if (existsSync(path)) {
    const runtime = normalizeDevelopmentRuntime(readJson(path, 'development runtime'))
    writeJson(path, runtime)
    return runtime
  }
  if (!create) return null
  return withShortStateLock('development-runtime', () => {
    if (existsSync(path)) {
      const runtime = normalizeDevelopmentRuntime(readJson(path, 'development runtime'))
      writeJson(path, runtime)
      return runtime
    }
    const used = allocatedDevelopmentPorts()
    for (const port of listeningTcpPorts()) used.add(port)
    const firstPort = 13080 + (Number.parseInt(key.slice(0, 8), 16) % 10_000)
    let webPort = null
    for (let offset = 0; offset < 10_000; offset += 1) {
      const candidate = 13080 + ((firstPort - 13080 + offset) % 10_000)
      if (!used.has(candidate)) { webPort = candidate; break }
    }
    if (webPort === null) fail('没有可用的本地开发 Web 端口', exitCodes.safety)
    const suffix = key.slice(0, 12)
    const runtime = {
      schemaVersion: 3,
      sourcePath: resolvedSource,
      key,
      network: `dsh-dev-${suffix}-internal`,
      toolbox: `dsh-dev-${suffix}-toolbox`,
      fakeTelegram: `dsh-dev-${suffix}-fake-telegram`,
      telegram: `dsh-dev-${suffix}-telegram`,
      web: `dsh-dev-${suffix}-web`,
      webPort,
      createdAt: new Date().toISOString(),
    }
    writeJson(path, runtime)
    return runtime
  })
}

function controlledChild(root, path) {
  const resolvedRoot = resolve(root)
  const resolvedPath = resolve(path)
  return resolvedPath !== resolvedRoot && resolvedPath.startsWith(`${resolvedRoot}/`)
}

function removeControlledPath(root, path) {
  if (!controlledChild(root, path)) fail(`拒绝清理不受控路径: ${path}`, exitCodes.safety)
  rmSync(path, { recursive: true, force: true })
}

function developmentLeasePath(sourcePath) {
  return join(stateRoot, 'dev/leases', `${developmentKey(sourcePath)}.json`)
}

function readDevelopmentLeases() {
  const leasesRoot = join(stateRoot, 'dev/leases')
  if (!existsSync(leasesRoot)) return { complete: true, leases: [] }
  const leases = []
  for (const name of readdirSync(leasesRoot)) {
    if (!name.endsWith('.json')) continue
    try {
      leases.push(readJson(join(leasesRoot, name), 'development lease'))
    } catch (error) {
      warn(error.message)
      return { complete: false, leases }
    }
  }
  return { complete: true, leases }
}

function protectedCandidateIds() {
  const ids = new Set()
  let complete = true
  const latestPath = join(stateRoot, 'candidates/latest.json')
  if (existsSync(latestPath)) {
    try { ids.add(readJson(latestPath, 'latest candidate').candidateId) } catch (error) { warn(error.message); complete = false }
  }
  const leaseState = readDevelopmentLeases()
  complete &&= leaseState.complete
  for (const lease of leaseState.leases) ids.add(lease.candidateId)
  const releasesRoot = join(stateRoot, 'releases')
  if (existsSync(releasesRoot)) {
    for (const name of readdirSync(releasesRoot)) {
      const releasePath = join(releasesRoot, name, 'release.json')
      if (!existsSync(releasePath)) continue
      try {
        const release = readJson(releasePath, 'release evidence')
        if (release.candidate?.candidateId) ids.add(release.candidate.candidateId)
        if (release.previous?.candidate?.candidateId) ids.add(release.previous.candidate.candidateId)
      } catch (error) {
        warn(error.message)
        complete = false
      }
    }
  }
  ids.delete(undefined)
  return { complete, ids, leases: leaseState.leases }
}

function runtimeForLease(lease) {
  return normalizeDevelopmentRuntime(lease?.runtime) ?? developmentRuntime(lease?.sourcePath ?? '') ?? legacyDevelopmentRuntime()
}

function stopDev(runtime) {
  if (!runtime) return
  for (const name of [runtime.toolbox, runtime.telegram, runtime.fakeTelegram, runtime.web]) {
    if (name) runStatus(engine, ['rm', '--force', name])
  }
  if (runtime.network) runStatus(engine, ['network', 'rm', runtime.network])
}

function removeDevelopmentRuntime(sourcePath) {
  if (!sourcePath) return
  rmSync(developmentRuntimePath(sourcePath), { force: true })
}

function cleanupDevelopmentLease(lease) {
  if (!lease?.candidateId || !lease?.devRoot) return { result: 'nothing-to-clean' }
  const devRoot = resolve(lease.devRoot)
  if (controlledChild(join(stateRoot, 'dev'), devRoot)) removeControlledPath(join(stateRoot, 'dev'), devRoot)
  removeDevelopmentRuntime(lease.sourcePath)
  return { result: 'development-environment-cleaned', candidateId: lease.candidateId, sharedMainImage: 'kept' }
}

function replaceDevelopmentLease(source, candidate, candidatePath, devRoot) {
  const leasePath = developmentLeasePath(source.sourcePath)
  const lease = {
    schemaVersion: 2,
    sourcePath: source.sourcePath,
    candidateId: candidate.candidateId,
    candidatePath,
    imageId: candidate.imageId,
    imageTag: candidate.imageTag,
    devRoot,
    runtime: source.runtime,
    updatedAt: new Date().toISOString(),
  }
  writeJson(leasePath, lease)
  return { lease, leasePath }
}

function invalidateDevelopmentEnvironments({ exceptCandidateId = null } = {}) {
  const leaseState = readDevelopmentLeases()
  if (!leaseState.complete) fail('开发租约不完整，拒绝自动清理旧环境', exitCodes.safety)
  const invalidated = []
  for (const lease of leaseState.leases) {
    if (exceptCandidateId && lease.candidateId === exceptCandidateId) continue
    stopDev(runtimeForLease(lease))
    rmSync(developmentLeasePath(lease.sourcePath), { force: true })
    cleanupDevelopmentLease(lease)
    invalidated.push(lease.sourcePath)
  }
  return invalidated
}

function developmentCandidates() {
  const candidatesRoot = join(stateRoot, 'candidates')
  if (!existsSync(candidatesRoot)) return []
  const candidates = []
  for (const name of readdirSync(candidatesRoot)) {
    const path = join(candidatesRoot, name, 'candidate.json')
    if (!existsSync(path)) continue
    try {
      const candidate = readJson(path, 'development candidate')
      if (candidatePurpose(candidate) === 'development') candidates.push({ candidate, path })
    } catch (error) {
      warn(error.message)
    }
  }
  return candidates
}

function developmentTestReceiptValid(candidate) {
  if (!candidate.testReceiptPath || !candidate.testReceiptSha256 || !existsSync(candidate.testReceiptPath)) return false
  try {
    return sha256File(candidate.testReceiptPath) === candidate.testReceiptSha256
  } catch {
    return false
  }
}

function reusableDevelopmentCandidate({ pluginsCommit, harnessCommit, releaseToolCommit, baseImageDigest }) {
  return developmentCandidates()
    .filter(({ candidate }) => candidate.status === 'tested'
      && candidate.pluginsCommit === pluginsCommit
      && candidate.harnessCommit === harnessCommit
      && candidate.releaseToolCommit === releaseToolCommit
      && candidate.baseImageDigest === baseImageDigest
      && developmentTestReceiptValid(candidate))
    .sort((left, right) => String(right.candidate.builtAt).localeCompare(String(left.candidate.builtAt)))
    .find(({ candidate }) => runStatus(engine, ['image', 'inspect', candidate.imageTag]).status === 0) ?? null
}

function removeObsoleteDevelopmentCandidates(currentCandidateId) {
  const cleaned = []
  for (const { candidate, path } of developmentCandidates()) {
    if (candidate.candidateId === currentCandidateId) continue
    const inspection = runStatus(engine, ['image', 'inspect', candidate.imageTag])
    if (inspection.status === 0) {
      const removal = runStatus(engine, ['image', 'rm', candidate.imageTag])
      if (removal.status !== 0) {
        fail(`旧开发镜像仍被未知容器使用，无法保持单一 main 镜像: ${candidate.imageTag}\n${String(removal.stderr ?? '').trim()}`, exitCodes.safety)
      }
    }
    removeControlledPath(join(stateRoot, 'candidates'), dirname(path))
    cleaned.push(candidate.candidateId)
  }
  return cleaned
}

function admitDevelopmentCandidate(candidate, candidatePath) {
  const invalidatedSourcePaths = invalidateDevelopmentEnvironments({ exceptCandidateId: candidate.candidateId })
  const cleanedCandidateIds = removeObsoleteDevelopmentCandidates(candidate.candidateId)
  writeJson(developmentCandidatePointerPath(), candidate)
  const legacyLatest = join(stateRoot, 'candidates/latest.json')
  if (existsSync(legacyLatest)) {
    try {
      if (candidatePurpose(readJson(legacyLatest, 'latest candidate')) === 'development') rmSync(legacyLatest, { force: true })
    } catch (error) {
      warn(error.message)
    }
  }
  return { candidatePath, invalidatedSourcePaths, cleanedCandidateIds }
}

function cleanupAcceptedDevelopmentState() {
  const invalidatedSourcePaths = invalidateDevelopmentEnvironments()
  stopDev(legacyDevelopmentRuntime())
  const devRoot = join(stateRoot, 'dev')
  const inferredDevelopmentIds = new Set()
  if (existsSync(devRoot)) {
    for (const name of readdirSync(devRoot)) {
      const path = join(devRoot, name)
      if (['leases', 'runtimes'].includes(name)) continue
      const metadataPath = join(path, 'dev.json')
      if (existsSync(metadataPath)) {
        try {
          const metadata = readJson(metadataPath, 'development metadata')
          if (metadata.mode === 'editable-source' && metadata.candidateId) inferredDevelopmentIds.add(metadata.candidateId)
        } catch (error) {
          warn(error.message)
        }
      }
      if (controlledChild(devRoot, path)) removeControlledPath(devRoot, path)
    }
  }
  const leasesRoot = join(devRoot, 'leases')
  if (existsSync(leasesRoot)) {
    for (const name of readdirSync(leasesRoot)) {
      if (name.endsWith('.json')) rmSync(join(leasesRoot, name), { force: true })
    }
  }
  rmSync(join(devRoot, 'runtimes'), { recursive: true, force: true })
  rmSync(developmentCandidatePointerPath(), { force: true })

  const candidatesRoot = join(stateRoot, 'candidates')
  const latestPath = join(candidatesRoot, 'latest.json')
  if (existsSync(latestPath)) {
    try {
      const latest = readJson(latestPath, 'latest candidate')
      if (candidatePurpose(latest) === 'development' || inferredDevelopmentIds.has(latest.candidateId)) rmSync(latestPath, { force: true })
    } catch (error) {
      warn(error.message)
    }
  }
  const protection = protectedCandidateIds()
  const cleaned = []
  const kept = []
  if (existsSync(candidatesRoot)) {
    for (const name of readdirSync(candidatesRoot)) {
      const candidateDir = join(candidatesRoot, name)
      const candidatePath = join(candidateDir, 'candidate.json')
      if (!existsSync(candidatePath)) continue
      let candidate
      try { candidate = readJson(candidatePath, 'development candidate') } catch (error) { warn(error.message); kept.push(name); continue }
      const isDevelopment = candidatePurpose(candidate) === 'development' || inferredDevelopmentIds.has(candidate.candidateId)
      if (!isDevelopment) continue
      if (!protection.complete || protection.ids.has(candidate.candidateId)) {
        kept.push(candidate.candidateId)
        continue
      }
      const inspection = runStatus(engine, ['image', 'inspect', candidate.imageTag])
      if (inspection.status === 0 && runStatus(engine, ['image', 'rm', candidate.imageTag]).status !== 0) {
        warn(`验收后未能删除开发镜像 ${candidate.imageTag}`)
        kept.push(candidate.candidateId)
        continue
      }
      removeControlledPath(candidatesRoot, candidateDir)
      cleaned.push(candidate.candidateId)
    }
  }
  return {
    result: 'accepted-release-invalidated-development',
    cleanedCandidateIds: cleaned,
    keptReferencedCandidateIds: kept,
    invalidatedSourcePaths,
    sourceWorktrees: 'preserved',
  }
}

function writeTestCredentials(path) {
  writeFileSync(path, [
    'version: 1',
    'refs:',
    '  DEEPSEEK_API_KEY: test-key',
    '  TELEGRAM_BOT_TOKEN: test-token',
    '  TELEGRAM_ALLOWED_CHAT_ID: "1"',
    '',
  ].join('\n'), { mode: 0o600 })
}

function makeSyntheticHome(homePath) {
  ensureDir(join(homePath, '.dsh/storages/dsh-cron'))
  ensureDir(join(homePath, '.dsh/storages/personal-feed'))
  ensureDir(join(homePath, '.dsh/sessions'))
  ensureDir(join(homePath, '.dsh/workspace'))
  writeFileSync(join(homePath, '.dsh/storages/dsh-cron/jobs.jsonl'), '')
  writeTestCredentials(join(homePath, '.dsh/.credentials.yaml'))
  writeFileSync(join(homePath, '.dsh/settings.yaml'), '{}\n', { mode: 0o600 })
}

function materializeSnapshot(snapshot, homePath) {
  rmSync(homePath, { recursive: true, force: true })
  ensureDir(homePath)
  if (snapshot === 'synthetic') return makeSyntheticHome(homePath)
  const metaPath = snapshot === 'latest' ? join(stateRoot, 'snapshots/latest.json') : resolve(snapshot)
  const meta = readJson(metaPath, 'snapshot metadata')
  if (!existsSync(meta.archivePath)) fail(`快照归档不存在: ${meta.archivePath}`, exitCodes.safety)
  if (sha256File(meta.archivePath) !== meta.archiveSha256) fail('快照归档摘要不匹配', exitCodes.safety)
  run('tar', ['-xf', meta.archivePath, '-C', homePath], { code: exitCodes.safety })
  const dshHome = join(homePath, '.dsh')
  if (!existsSync(dshHome)) fail('快照中没有 .dsh', exitCodes.safety)
  const prodCron = join(dshHome, 'storages/dsh-cron/jobs.jsonl')
  if (existsSync(prodCron)) {
    ensureDir(dirname(prodCron))
    writeFileSync(prodCron, '')
  }
  rmSync(join(dshHome, '.credentials.yaml'), { force: true })
  writeTestCredentials(join(dshHome, '.credentials.yaml'))
  for (const name of ['telegram-offset.json', 'scheduler.lock', 'worker.lock']) rmSync(join(dshHome, 'storages', name), { force: true })
}

function containerBaseArgs(homePath) {
  // Rootless Podman maps container uid 0 to the invoking host user. Running
  // the local development/preflight containers as uid 1000 would instead map
  // to a subordinate host uid and make the freshly copied snapshot unwritable.
  // Production uses Docker and remains fixed at the required 1000:1000.
  const localUser = engine === 'podman' ? '0:0' : '1000:1000'
  return [
    '--read-only', '--user', localUser,
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=512m', '--tmpfs', '/run:rw,nosuid,size=64m',
    '--volume', `${homePath}:/home/herman:rw`,
    '--env', 'HOME=/home/herman', '--env', 'DSH_HOME=/home/herman/.dsh', '--env', 'DSH_CWD=/home/herman/.dsh/workspace',
  ]
}

const developmentPackages = Object.freeze([
  'telegram-gateway',
  'dsh-cron',
  'dsh-assistant',
  'personal-feed',
  'x-feed',
  'ui-context-compactor',
])

function developmentSourceArgs(sourcePath) {
  const args = ['--volume', `${sourcePath}:/workspace/dsh-plugins:ro`]
  const imageNodeModules = '/opt/dsh/harness/node_modules/.pnpm/node_modules'
  for (const packageName of developmentPackages) {
    const localNodeModules = join(sourcePath, packageName, 'node_modules')
    try {
      const entry = lstatSync(localNodeModules)
      if (!entry.isSymbolicLink() || readlinkSync(localNodeModules) !== imageNodeModules) {
        fail(`拒绝覆盖已有开发依赖目录: ${localNodeModules}`, exitCodes.safety)
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      symlinkSync(imageNodeModules, localNodeModules, 'dir')
    }
    args.push('--volume', `${join(sourcePath, packageName)}:/opt/dsh/harness/local-plugins/${packageName}:rw`)
  }
  args.push(
    '--volume', `${join(sourcePath, 'release/scripts')}:/opt/dsh/release-system/scripts:rw`,
    '--volume', `${join(sourcePath, 'release/fixtures/context-manager-telegram-canary')}:/opt/dsh/harness/local-plugins/deployment/herman-hermes/context-manager-telegram-canary:ro`,
    '--volume', `${join(sourcePath, 'release/vitest.external.config.ts')}:/opt/dsh/harness/vitest.external.config.ts:ro`,
    '--volume', `${join(sourcePath, 'runtime-package-topology.json')}:/opt/dsh/harness/local-plugins/runtime-package-topology.json:rw`,
    '--volume', `${join(sourcePath, 'scripts/materialize-runtime-topology.mjs')}:/opt/dsh/harness/local-plugins/scripts/materialize-runtime-topology.mjs:rw`,
  )
  args.push('--volume', `${join(sourcePath, 'skills')}:/opt/dsh/plugins-src/skills:rw`)
  for (const profile of ['web', 'telegram', 'telegram-test']) {
    for (const file of ['package.json', 'cordis.patch.yml']) {
      args.push('--volume', `${join(sourcePath, 'release/profiles', profile, file)}:/opt/dsh/harness/local-profiles/${profile}/${file}:rw`)
    }
  }
  return args
}

function developmentContainerLabels(runtime, role) {
  return [
    '--label', `io.dsh.dev.source-key=${runtime.key}`,
    '--label', `io.dsh.dev.source-path=${runtime.sourcePath}`,
    '--label', `io.dsh.dev.role=${role}`,
  ]
}

function startDevelopmentToolbox(candidate, runtime, homePath, sourceArgs) {
  run(engine, [
    'run', '--detach', '--name', runtime.toolbox, '--network', runtime.network,
    ...developmentContainerLabels(runtime, 'toolbox'),
    ...containerBaseArgs(homePath), ...sourceArgs,
    candidate.imageTag, 'toolbox',
  ], { code: exitCodes.test })
}

function inspectDevelopmentSource(value) {
  if (!value) fail('dev prepare 必须提供 --source <独立任务 worktree>', exitCodes.usage)
  const sourcePath = resolve(value)
  const topLevel = run('git', ['-C', sourcePath, 'rev-parse', '--show-toplevel'], { capture: true, announce: false, code: exitCodes.usage })
  if (resolve(topLevel) !== sourcePath) fail(`--source 必须指向 worktree 根目录: ${sourcePath}`, exitCodes.usage)
  const branch = run('git', ['-C', sourcePath, 'branch', '--show-current'], { capture: true, announce: false, code: exitCodes.safety })
  if (!branch || ['main', 'master'].includes(branch)) fail('开发必须在独立任务分支，不能直接使用 main/master', exitCodes.safety)
  run('git', ['-C', sourcePath, 'fetch', 'origin'], { code: exitCodes.safety })
  const head = run('git', ['-C', sourcePath, 'rev-parse', 'HEAD'], { capture: true, announce: false, code: exitCodes.safety })
  const originMain = run('git', ['-C', sourcePath, 'rev-parse', 'origin/main'], { capture: true, announce: false, code: exitCodes.safety })
  const containsLatestMain = runStatus('git', ['-C', sourcePath, 'merge-base', '--is-ancestor', originMain, head]).status === 0
  if (!containsLatestMain) {
    fail(`任务分支没有基于最新 origin/main ${originMain}；请先 rebase 后再继续`, exitCodes.safety)
  }
  for (const packageName of developmentPackages) {
    if (!existsSync(join(sourcePath, packageName, 'package.json'))) fail(`开发源码缺少 ${packageName}/package.json`, exitCodes.safety)
  }
  for (const required of [
    'release/scripts',
    'skills',
    'release/profiles/web/cordis.patch.yml',
    'release/profiles/telegram/cordis.patch.yml',
    'release/profiles/telegram-test/cordis.patch.yml',
    'runtime-package-topology.json',
    'scripts/materialize-runtime-topology.mjs',
  ]) {
    if (!existsSync(join(sourcePath, required))) fail(`开发源码缺少镜像运行输入: ${required}`, exitCodes.safety)
  }
  return { sourcePath, branch, head, originMain }
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

function devContainerRunning(name) {
  const result = runStatus(engine, ['inspect', name, '--format', '{{.State.Running}}'])
  return result.status === 0 && String(result.stdout).trim() === 'true'
}

function devLogs(name) {
  const result = runStatus(engine, ['logs', '--tail', '160', name])
  return `${String(result.stdout ?? '')}${String(result.stderr ?? '')}`.trim()
}

function verifyDev(candidate, homePath, runtime) {
  let ready = false
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const web = runStatus('curl', ['--fail', '--silent', '--max-time', '2', `http://127.0.0.1:${runtime.webPort}/`])
    if (web.status === 0 && devContainerRunning(runtime.toolbox) && devContainerRunning(runtime.web) && devContainerRunning(runtime.telegram)
      && devContainerRunning(runtime.fakeTelegram)) {
      ready = true
      break
    }
    if (!devContainerRunning(runtime.toolbox) || !devContainerRunning(runtime.web) || !devContainerRunning(runtime.telegram)) break
    sleepSync(1000)
  }
  if (!ready) {
    fail(`开发环境启动失败\n--- web ---\n${devLogs(runtime.web)}\n--- telegram ---\n${devLogs(runtime.telegram)}`, exitCodes.test)
  }

  for (const name of [runtime.toolbox, runtime.web, runtime.telegram]) {
    const identity = run(engine, ['inspect', name, '--format', '{{.Image}}|{{.HostConfig.ReadonlyRootfs}}'], { capture: true, announce: false, code: exitCodes.test })
    if (identity !== `${candidate.imageId}|true`) fail(`${name} 没有运行同一个只读候选镜像: ${identity}`, exitCodes.test)
  }
  run(engine, ['exec', runtime.fakeTelegram, 'curl', '--fail', '--silent', 'http://127.0.0.1:8080/bottest-token/getMe'], { capture: true, announce: false, code: exitCodes.test })
  run(engine, ['exec', runtime.fakeTelegram, 'curl', '--fail', '--silent', '--request', 'POST', 'http://127.0.0.1:8080/bottest-token/sendMessage'], { capture: true, announce: false, code: exitCodes.test })
  const requests = run(engine, ['exec', runtime.fakeTelegram, 'curl', '--fail', '--silent', 'http://127.0.0.1:8080/bottest-token/getRequests'], { capture: true, announce: false, code: exitCodes.test })
  for (const method of ['getMe', 'getUpdates', 'sendMessage']) {
    if (!requests.includes(`/${method}`)) fail(`假 Telegram 没有观察到 ${method}`, exitCodes.test)
  }
  const realTelegram = runStatus(engine, ['exec', runtime.telegram, 'curl', '--silent', '--show-error', '--max-time', '2', 'https://api.telegram.org'])
  if (realTelegram.status === 0) fail('开发 Telegram 容器可以访问真实 Telegram；内部网络隔离失效', exitCodes.test)
  const cronLedger = join(homePath, '.dsh/storages/dsh-cron/jobs.jsonl')
  if (existsSync(cronLedger) && readFileSync(cronLedger, 'utf8').trim() !== '') fail('开发 cron 台账不是空的，拒绝启动真实任务', exitCodes.test)
  return { requests: ['getMe', 'getUpdates', 'sendMessage'], realTelegramReachable: false, cronJobs: 0 }
}

function commandBuild(options) {
  const purpose = options.purpose ?? 'release'
  if (!['development', 'release'].includes(purpose)) fail('--purpose 只能是 development 或 release', exitCodes.usage)
  const harnessCommit = requireFullCommit(harnessRepo, options['harness-ref'], '--harness-ref')
  const pluginsCommit = requireFullCommit(repoRoot, options['plugins-ref'], '--plugins-ref')
  const originMain = requireLatestMainAncestor(pluginsCommit, '插件 commit')
  if (purpose === 'development' && pluginsCommit !== originMain) {
    fail(`开发底座只能使用最新 origin/main：requested=${pluginsCommit}，origin/main=${originMain}`, exitCodes.safety)
  }
  const releaseToolRef = purpose === 'development'
    ? originMain
    : run('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { capture: true, announce: false })
  const releaseToolCommit = requireFullCommit(repoRoot, releaseToolRef, 'release tool commit')
  const releaseToolBasedOnMain = runStatus('git', ['-C', repoRoot, 'merge-base', '--is-ancestor', originMain, releaseToolCommit])
  if (releaseToolBasedOnMain.status !== 0) {
    fail(`发版工具 commit ${releaseToolCommit} 没有基于最新 origin/main ${originMain}；请先 rebase 后再继续`, exitCodes.safety)
  }
  const lock = readJson(join(releaseRoot, 'image.lock.json'), 'image lock')
  if (purpose === 'development') {
    const harnessLock = readJson(join(releaseRoot, 'harness.lock.json'), 'Harness lock')
    if (harnessCommit !== harnessLock.commit) {
      fail(`开发底座必须使用固定 Harness commit：requested=${harnessCommit}，lock=${harnessLock.commit}`, exitCodes.safety)
    }
    const reusable = reusableDevelopmentCandidate({
      pluginsCommit,
      harnessCommit,
      releaseToolCommit,
      baseImageDigest: lock.digest,
    })
    if (reusable) {
      verifyDevelopmentCandidateImage(reusable.candidate)
      const cleanup = admitDevelopmentCandidate(reusable.candidate, reusable.path)
      out({ result: 'development-base-reused', ...cleanup, ...reusable.candidate })
      return
    }
  }
  const buildId = purpose === 'development'
    ? `development-${pluginsCommit}`
    : `${nowId()}-${pluginsCommit.slice(0, 12)}`
  const buildRoot = join(stateRoot, 'builds', buildId)
  const context = join(buildRoot, 'context')
  const harnessTarget = join(context, 'harness')
  const pluginsTarget = join(context, 'plugins')
  const releaseTarget = join(context, 'release-system')
  const candidateDir = join(stateRoot, 'candidates', buildId)
  const archivePath = join(candidateDir, 'image.tar')
  let stagedArchivePath = null
  let imageTag = null
  let admitted = false

  try {
    if (purpose === 'development' && existsSync(candidateDir)) {
      removeControlledPath(join(stateRoot, 'candidates'), candidateDir)
    }
    ensureDir(harnessTarget)
    ensureDir(pluginsTarget)
    ensureDir(releaseTarget)
    const harnessTar = join(buildRoot, 'harness.tar')
    const pluginsTar = join(buildRoot, 'plugins.tar')
    const releaseTar = join(buildRoot, 'release-system.tar')
    run('git', ['-C', harnessRepo, 'archive', '--format=tar', `--output=${harnessTar}`, harnessCommit], { code: exitCodes.safety })
    run('git', ['-C', repoRoot, 'archive', '--format=tar', `--output=${pluginsTar}`, pluginsCommit], { code: exitCodes.safety })
    run('git', ['-C', repoRoot, 'archive', '--format=tar', `--output=${releaseTar}`, releaseToolCommit, 'release'], { code: exitCodes.safety })
    run('tar', ['-xf', harnessTar, '-C', harnessTarget], { code: exitCodes.safety })
    run('tar', ['-xf', pluginsTar, '-C', pluginsTarget], { code: exitCodes.safety })
    run('tar', ['-xf', releaseTar, '-C', releaseTarget], { code: exitCodes.safety })
    const archivedPatch = join(releaseTarget, 'release/patches/harness-minimal-shell-path.patch')
    if (!existsSync(join(releaseTarget, 'release/Containerfile')) || !existsSync(archivedPatch)) {
      fail('release tool commit 不包含受 Git 管理的 Docker 发版系统', exitCodes.safety)
    }
    run('git', ['-C', harnessTarget, 'apply', '--verbose', archivedPatch], { code: exitCodes.safety })
    const patchSha256 = sha256File(archivedPatch)
    imageTag = purpose === 'development'
      ? `localhost/dsh-development-main:${pluginsCommit}`
      : `localhost/dsh-candidate:${pluginsCommit.slice(0, 12)}-${buildId.slice(0, 15).toLowerCase()}`
    const signaturePolicy = join(releaseTarget, 'release/containers-policy.json')
    const engineBuildOptions = engine === 'podman' ? ['--signature-policy', signaturePolicy] : []
    const engineArchiveOptions = engine === 'podman' ? ['--signature-policy', signaturePolicy] : []

    run(engine, [
      'build', ...engineBuildOptions, '--format', 'docker', '--pull=missing',
      '--build-arg', `DSH_HARNESS_COMMIT=${harnessCommit}`,
      '--build-arg', `DSH_HARNESS_PATCH_SHA256=${patchSha256}`,
      '--build-arg', `DSH_PLUGINS_COMMIT=${pluginsCommit}`,
      '--build-arg', `DSH_RELEASE_COMMIT=${releaseToolCommit}`,
      '--label', `org.opencontainers.image.revision=${pluginsCommit}`,
      '--label', `io.dsh.release.revision=${releaseToolCommit}`,
      '--label', `io.dsh.harness.revision=${harnessCommit}`,
      '--label', `io.dsh.harness.patch-sha256=${patchSha256}`,
      '--label', `io.dsh.candidate.purpose=${purpose}`,
      '--tag', imageTag, '--file', join(releaseTarget, 'release/Containerfile'), context,
    ], { code: exitCodes.test })

    const builtImageId = imageId(imageTag)
    const imageLabels = JSON.parse(run(engine, ['image', 'inspect', imageTag, '--format', '{{json .Config.Labels}}'], { capture: true, code: exitCodes.safety }))
    if (imageLabels['org.opencontainers.image.revision'] !== pluginsCommit
      || imageLabels['io.dsh.release.revision'] !== releaseToolCommit
      || imageLabels['io.dsh.harness.revision'] !== harnessCommit
      || imageLabels['io.dsh.harness.patch-sha256'] !== patchSha256
      || imageLabels['io.dsh.candidate.purpose'] !== purpose) {
      fail('镜像标签没有绑定到本次 Harness/插件源码身份和候选用途', exitCodes.safety)
    }
    const testStartedAt = new Date().toISOString()
    const testOutput = run(engine, [
      'run', '--rm', '--read-only', '--user', '1000:1000',
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=512m', '--tmpfs', '/run:rw,nosuid,size=64m',
      imageTag, 'self-test',
    ], { capture: true, code: exitCodes.test })
    const testReceipt = {
      schemaVersion: 1,
      imageId: builtImageId,
      startedAt: testStartedAt,
      completedAt: new Date().toISOString(),
      output: testOutput,
    }

    ensureDir(candidateDir)
    const receiptPath = join(candidateDir, 'image-tests.json')
    writeJson(receiptPath, testReceipt)
    let archiveSha256 = null
    if (purpose === 'release') {
      const stagingRoot = archiveStagingRoot(candidateDir)
      stagedArchivePath = stagingRoot === candidateDir ? archivePath : join(stagingRoot, `${buildId}.image.tar`)
      rmSync(stagedArchivePath, { force: true })
      run(engine, ['save', ...engineArchiveOptions, '--format', 'docker-archive', '--output', stagedArchivePath, imageTag], { code: exitCodes.test })
      archiveSha256 = sha256File(stagedArchivePath)

      // Formal releases prove that the transferred archive restores the exact
      // admitted image identity.  The wrapper serializes this shared-store
      // mutation; development bases never perform this destructive round-trip.
      run(engine, ['image', 'rm', imageTag], { code: exitCodes.test })
      run(engine, ['load', ...engineArchiveOptions, '--input', stagedArchivePath], { code: exitCodes.test })
      const loadedImageId = imageId(imageTag)
      if (loadedImageId !== builtImageId) fail(`归档重载后的 image ID 改变: ${builtImageId} -> ${loadedImageId}`, exitCodes.test)
      if (stagedArchivePath !== archivePath) {
        copyFileSync(stagedArchivePath, archivePath)
        if (sha256File(archivePath) !== archiveSha256) fail('暂存归档复制后的摘要改变', exitCodes.safety)
        rmSync(stagedArchivePath, { force: true })
      }
    }

    const candidate = {
      schemaVersion: 2,
      candidateId: buildId,
      status: 'tested',
      purpose,
      imageId: builtImageId,
      imageTag,
      archivePath: purpose === 'release' ? archivePath : null,
      archiveSha256,
      harnessCommit,
      harnessPatchSha256: patchSha256,
      pluginsCommit,
      releaseToolCommit,
      baseImage: lock.image,
      baseImageDigest: lock.digest,
      builtAt: new Date().toISOString(),
      testReceiptPath: receiptPath,
      testReceiptSha256: sha256File(receiptPath),
    }
    const candidatePath = join(candidateDir, 'candidate.json')
    writeJson(candidatePath, candidate)
    let developmentCleanup = null
    if (purpose === 'development') {
      run('git', ['-C', repoRoot, 'fetch', 'origin'], { code: exitCodes.safety })
      const completedMain = run('git', ['-C', repoRoot, 'rev-parse', 'origin/main'], { capture: true, announce: false, code: exitCodes.safety })
      if (completedMain !== pluginsCommit) {
        fail(`开发镜像构建期间 main 已更新：image=${pluginsCommit}，origin/main=${completedMain}；拒绝登记旧镜像`, exitCodes.safety)
      }
      developmentCleanup = admitDevelopmentCandidate(candidate, candidatePath)
    } else {
      copyFileSync(candidatePath, join(stateRoot, 'candidates/latest.json'))
    }
    admitted = true
    out({ result: 'candidate-built', candidatePath, developmentCleanup, ...candidate })
  } finally {
    try { removeControlledPath(join(stateRoot, 'builds'), buildRoot) } catch (error) { warn(error.message) }
    if (stagedArchivePath && stagedArchivePath !== archivePath) {
      try { rmSync(stagedArchivePath, { force: true }) } catch (error) { warn(error.message) }
    }
    if (!admitted) {
      try { removeControlledPath(join(stateRoot, 'candidates'), candidateDir) } catch (error) { warn(error.message) }
      if (imageTag) {
        const removal = runStatus(engine, ['image', 'rm', imageTag])
        if (removal.status !== 0 && runStatus(engine, ['image', 'inspect', imageTag]).status === 0) {
          warn(`失败构建镜像未能删除 ${imageTag}: ${String(removal.stderr ?? '').trim()}`)
        }
      }
    }
  }
}

function commandDev(options) {
  const action = options._[0]
  if (action === 'down') {
    const sourcePath = resolve(options.source ?? repoRoot)
    const leasePath = developmentLeasePath(sourcePath)
    const lease = existsSync(leasePath) ? readJson(leasePath, 'development lease') : null
    const runtime = lease ? runtimeForLease(lease) : developmentRuntime(sourcePath)
    if (runtime) stopDev(runtime)
    out({ result: 'development-stopped', sourcePath, runtime: runtime ?? 'already-absent', data: 'preserved' })
    return
  }
  if (action === 'retire') {
    if (!options.source) fail('dev retire 必须提供 --source <任务 worktree>', exitCodes.usage)
    const sourcePath = resolve(options.source)
    const leasePath = developmentLeasePath(sourcePath)
    if (!existsSync(leasePath)) {
      const runtime = developmentRuntime(sourcePath)
      if (runtime) stopDev(runtime)
      const devRoot = join(stateRoot, 'dev/environments', developmentKey(sourcePath))
      if (controlledChild(join(stateRoot, 'dev'), devRoot)) removeControlledPath(join(stateRoot, 'dev'), devRoot)
      removeDevelopmentRuntime(sourcePath)
      out({ result: 'development-already-retired', sourcePath })
      return
    }
    const lease = readJson(leasePath, 'development lease')
    const runtime = runtimeForLease(lease)
    stopDev(runtime)
    const running = [runtime.toolbox, runtime.web, runtime.telegram, runtime.fakeTelegram].filter(devContainerRunning)
    if (running.length > 0) fail(`开发容器未全部退出，拒绝删除租约：${running.join(', ')}`, exitCodes.safety)
    rmSync(leasePath, { force: true })
    const cleanup = cleanupDevelopmentLease(lease)
    out({ result: 'development-retired', sourcePath, cleanup })
    return
  }
  if (action === 'prepare' && !options.source) fail('dev prepare 必须提供 --source <独立任务 worktree>', exitCodes.usage)
  const sourcePath = resolve(options.source ?? repoRoot)
  const defaultDevelopmentCandidate = developmentCandidatePointerPath()
  const candidateValue = options.candidate
    ?? (['prepare', 'shell'].includes(action) && existsSync(defaultDevelopmentCandidate) ? defaultDevelopmentCandidate : undefined)
  const { candidate, path: candidatePath } = candidateFrom(candidateValue, { verifyDevelopmentImage: action !== 'prepare' })
  const runtime = developmentRuntime(sourcePath, { create: ['prepare', 'up'].includes(action) })
  const devRoot = join(stateRoot, 'dev/environments', developmentKey(sourcePath))
  const homePath = join(devRoot, 'home/herman')
  const devMetaPath = join(devRoot, 'dev.json')
  if (action === 'up') {
    stopDev(runtime)
    const snapshot = options.snapshot ?? 'latest'
    const prior = existsSync(devMetaPath) ? readJson(devMetaPath, 'development metadata') : null
    const reuseData = !options.reset && prior?.snapshot === snapshot && existsSync(join(homePath, '.dsh'))
    if (!reuseData) {
      materializeSnapshot(snapshot, homePath)
      writeJson(devMetaPath, { schemaVersion: 1, candidateId: candidate.candidateId, snapshot, createdAt: new Date().toISOString() })
    }
    run(engine, ['run', '--rm', ...containerBaseArgs(homePath), '--env', `DSH_IMAGE_ID=${candidate.imageId}`, candidate.imageTag, 'prepare'], { code: exitCodes.test })
    run(engine, ['network', 'create', '--internal', runtime.network], { code: exitCodes.test })
    startDevelopmentToolbox(candidate, runtime, homePath, [])
    run(engine, ['run', '--detach', '--name', runtime.fakeTelegram, '--network', runtime.network, '--network-alias', 'fake-telegram',
      ...developmentContainerLabels(runtime, 'fake-telegram'), '--read-only', '--tmpfs', '/tmp:rw', candidate.imageTag, 'fake-telegram'], { code: exitCodes.test })
    run(engine, ['run', '--detach', '--name', runtime.telegram, '--network', runtime.network,
      ...developmentContainerLabels(runtime, 'telegram'), ...containerBaseArgs(homePath),
      '--env', 'TELEGRAM_BOT_TOKEN=test-token', '--env', 'TELEGRAM_ALLOWED_CHAT_ID=1', '--env', 'DEEPSEEK_API_KEY=test-key',
      candidate.imageTag, 'telegram-test'], { code: exitCodes.test })
    // Harness intentionally binds Web only to loopback.  Keep it on the host
    // network for local browser access; the Telegram/cron writer remains on
    // the egress-free internal network with only the fake Bot API.
    run(engine, ['run', '--detach', '--name', runtime.web, '--network', 'host',
      ...developmentContainerLabels(runtime, 'web'), ...containerBaseArgs(homePath),
      '--env', `DSH_WEB_PORT=${runtime.webPort}`, '--env', 'DEEPSEEK_API_KEY=test-key', candidate.imageTag, 'web'], { code: exitCodes.test })
    const verification = verifyDev(candidate, homePath, runtime)
    const metadata = {
      schemaVersion: 2,
      mode: 'immutable-candidate',
      candidateId: candidate.candidateId,
      imageId: candidate.imageId,
      snapshot,
      sourcePath,
      runtime,
      createdAt: new Date().toISOString(),
      verification,
    }
    writeJson(devMetaPath, metadata)
    const lease = replaceDevelopmentLease({ sourcePath, runtime }, candidate, candidatePath, devRoot)
    const result = { result: 'dev-started', web: `http://127.0.0.1:${runtime.webPort}`, homePath, data: reuseData ? 'reused' : 'materialized', network: runtime.network, runtime, leasePath: lease.leasePath, ...verification }
    out(result)
    return result
  }
  if (action === 'prepare') {
    if (candidatePurpose(candidate) !== 'development') {
      fail('dev prepare 只接受 --purpose development 构建的开发底座，不能占用正式发版候选', exitCodes.safety)
    }
    const source = inspectDevelopmentSource(options.source)
    const harnessLock = readJson(join(releaseRoot, 'harness.lock.json'), 'Harness lock')
    if (candidate.pluginsCommit !== source.originMain) {
      fail(`开发基础镜像不是最新 main：candidate=${candidate.pluginsCommit}，origin/main=${source.originMain}`, exitCodes.safety)
    }
    if (candidate.harnessCommit !== harnessLock.commit) {
      fail(`开发基础镜像没有使用固定 Harness commit：candidate=${candidate.harnessCommit}，lock=${harnessLock.commit}`, exitCodes.safety)
    }
    verifyDevelopmentCandidateImage(candidate)
    stopDev(runtime)
    commandSnapshot({ _: ['latest'] })
    materializeSnapshot('latest', homePath)
    const sourceArgs = developmentSourceArgs(source.sourcePath)
    run(engine, ['run', '--rm', ...containerBaseArgs(homePath), ...sourceArgs,
      '--env', `DSH_IMAGE_ID=${candidate.imageId}`, candidate.imageTag, 'dev-source-build'], { code: exitCodes.test })
    run(engine, ['run', '--rm', ...containerBaseArgs(homePath), ...sourceArgs,
      '--env', `DSH_IMAGE_ID=${candidate.imageId}`, candidate.imageTag, 'prepare'], { code: exitCodes.test })
    run(engine, ['network', 'create', '--internal', runtime.network], { code: exitCodes.test })
    startDevelopmentToolbox(candidate, runtime, homePath, sourceArgs)
    run(engine, ['run', '--detach', '--name', runtime.fakeTelegram, '--network', runtime.network, '--network-alias', 'fake-telegram',
      ...developmentContainerLabels(runtime, 'fake-telegram'), '--read-only', '--tmpfs', '/tmp:rw', ...sourceArgs, candidate.imageTag, 'fake-telegram'], { code: exitCodes.test })
    run(engine, ['run', '--detach', '--name', runtime.telegram, '--network', runtime.network,
      ...developmentContainerLabels(runtime, 'telegram'), ...containerBaseArgs(homePath), ...sourceArgs,
      '--env', 'TELEGRAM_BOT_TOKEN=test-token', '--env', 'TELEGRAM_ALLOWED_CHAT_ID=1', '--env', 'DEEPSEEK_API_KEY=test-key',
      candidate.imageTag, 'telegram-test'], { code: exitCodes.test })
    run(engine, ['run', '--detach', '--name', runtime.web, '--network', 'host',
      ...developmentContainerLabels(runtime, 'web'), ...containerBaseArgs(homePath), ...sourceArgs,
      '--env', `DSH_WEB_PORT=${runtime.webPort}`, '--env', 'DEEPSEEK_API_KEY=test-key', candidate.imageTag, 'web'], { code: exitCodes.test })
    const verification = verifyDev(candidate, homePath, runtime)
    let completionSource
    try {
      completionSource = inspectDevelopmentSource(source.sourcePath)
      if (candidate.pluginsCommit !== completionSource.originMain) {
        fail(`开发准备期间 main 已更新：candidate=${candidate.pluginsCommit}，origin/main=${completionSource.originMain}；请先 rebase 并重建开发基础镜像`, exitCodes.safety)
      }
    } catch (error) {
      stopDev(runtime)
      throw error
    }
    const metadata = {
      schemaVersion: 2,
      mode: 'editable-source',
      candidateId: candidate.candidateId,
      imageId: candidate.imageId,
      snapshot: 'latest',
      sourcePath: completionSource.sourcePath,
      branch: completionSource.branch,
      sourceHead: completionSource.head,
      originMain: completionSource.originMain,
      runtime,
      createdAt: new Date().toISOString(),
      qualification: {
        editableSourceBuild: 'passed',
        productTests: 'shared-main-image-build',
        imageTestReceiptSha256: candidate.testReceiptSha256,
      },
      verification,
    }
    writeJson(devMetaPath, metadata)
    const lease = replaceDevelopmentLease({ ...completionSource, runtime }, candidate, candidatePath, devRoot)
    const result = {
      result: 'dev-source-ready',
      web: `http://127.0.0.1:${runtime.webPort}`,
      homePath,
      data: 'fresh-isolated-production-snapshot',
      network: runtime.network,
      ...metadata,
      leasePath: lease.leasePath,
    }
    out(result)
    return result
  }
  if (action === 'shell') {
    if (!existsSync(homePath)) fail('开发数据副本不存在；请先执行 dev up', exitCodes.usage)
    const prior = existsSync(devMetaPath) ? readJson(devMetaPath, 'development metadata') : null
    const shellRuntime = normalizeDevelopmentRuntime(prior?.runtime) ?? runtime
    if (!shellRuntime) fail('开发 runtime 不存在；请先执行 dev prepare', exitCodes.usage)
    const leasePath = developmentLeasePath(sourcePath)
    if (!existsSync(leasePath)) fail('开发环境租约不存在；请重新执行 dev prepare', exitCodes.safety)
    const lease = readJson(leasePath, 'development lease')
    if (lease.candidateId !== candidate.candidateId || lease.imageId !== candidate.imageId) {
      fail('开发环境与当前共享 main 镜像不一致；请重新执行 dev prepare', exitCodes.safety)
    }
    if (!devContainerRunning(shellRuntime.toolbox)) fail('开发 toolbox 没有运行；请重新执行 dev prepare', exitCodes.safety)
    const workdir = prior?.mode === 'editable-source' ? '/workspace/dsh-plugins' : '/home/herman/.dsh/workspace'
    run(engine, ['exec', '--interactive', '--tty', '--workdir', workdir, shellRuntime.toolbox, 'bash'], { code: exitCodes.test })
    return
  }
  fail('用法: dsh dev prepare --source <worktree> [--candidate <candidate.json>]；dsh dev up --snapshot latest|synthetic；dsh dev shell；dsh dev down [--source <worktree>]；dsh dev retire --source <worktree>', exitCodes.usage)
}

function commandSnapshot(options) {
  const which = options._[0]
  if (which !== 'latest') fail('用法: dsh snapshot latest', exitCodes.usage)
  ensureDir(join(stateRoot, 'snapshots'))
  const remoteMeta = `${homedir()}/.local/share/dsh-container/snapshots/latest.json`
  const result = runStatus('ssh', ['-o', 'BatchMode=yes', target, 'test', '-f', remoteMeta])
  if (result.status !== 0) fail('线上还没有 Docker 新格式快照；首次开发请用 --snapshot synthetic', exitCodes.safety)
  const metaText = run('ssh', ['-o', 'BatchMode=yes', target, 'cat', remoteMeta], { capture: true, code: exitCodes.production })
  const remote = JSON.parse(metaText)
  const localArchive = join(stateRoot, 'snapshots', `${remote.snapshotId}.tar.zst`)
  run('scp', ['-p', `${target}:${remote.archivePath}`, localArchive], { code: exitCodes.production })
  const meta = { ...remote, archivePath: localArchive, downloadedAt: new Date().toISOString() }
  if (sha256File(localArchive) !== meta.archiveSha256) fail('下载后的快照摘要不匹配', exitCodes.safety)
  const path = join(stateRoot, 'snapshots', `${remote.snapshotId}.json`)
  writeJson(path, meta)
  copyFileSync(path, join(stateRoot, 'snapshots/latest.json'))
  out({ result: 'snapshot-downloaded', metadata: path, ...meta })
}

function releasePlan(candidate) {
  return {
    candidateId: candidate.candidateId,
    imageId: candidate.imageId,
    archiveSha256: candidate.archiveSha256,
    target,
    writersToStop: ['Docker Compose project dsh'],
    preservedOutOfScope: ['openclaw-gateway.service', '~/.openclaw', 'OpenClaw Telegram token'],
    snapshotRoot: '/home/herman/.local/share/dsh-container/snapshots',
    rollbackBoundary: '停机前完整 ~/.dsh 快照 + 上一个 accepted Docker release',
    next: `获得停机许可后重新执行，并添加 --approved-stop`,
  }
}

function commandRelease(options) {
  const requestedCandidatePath = options.candidate ? resolve(options.candidate) : join(stateRoot, 'candidates/latest.json')
  if (candidatePurpose(readJson(requestedCandidatePath, 'candidate')) !== 'release') {
    fail('development 候选不能发布；请重新构建 --purpose release 的唯一正式候选', exitCodes.safety)
  }
  const { candidate, path: candidatePath } = candidateFrom(requestedCandidatePath)
  requireLatestMainAncestor(candidate.pluginsCommit, '候选插件 commit')
  requireLatestMainAncestor(candidate.releaseToolCommit, '候选发版工具 commit')
  if (!options['approved-stop']) {
    out({ status: 'waiting-for-downtime-authorization', ...releasePlan(candidate) })
    process.exitCode = exitCodes.approval
    return
  }
  performProductionRelease(candidate, candidatePath)
}

function performProductionRelease(candidate, candidatePath) {
  const releaseId = `${nowId()}-${candidate.pluginsCommit.slice(0, 12)}`
  const localReleaseDir = join(stateRoot, 'releases', releaseId)
  const localSnapshotDir = join(stateRoot, 'snapshots', releaseId)
  const releasePath = join(localReleaseDir, 'release.json')
  ensureDir(localReleaseDir)
  ensureDir(localSnapshotDir)
  const evidence = {
    schemaVersion: 1,
    releaseId,
    status: 'prepared',
    currentStage: 'remote-preflight',
    candidatePath,
    candidate,
    snapshot: null,
    previous: null,
    preflight: null,
    production: null,
    createdAt: new Date().toISOString(),
    userAcceptance: null,
  }
  const stage = (currentStage, details = {}) => {
    evidence.currentStage = currentStage
    Object.assign(evidence, details)
    writeJson(releasePath, evidence)
  }
  stage('remote-preflight')
  try {
    return performProductionReleaseUnsafe(candidate, candidatePath, releaseId, stage)
  } catch (error) {
    evidence.status = 'failed'
    evidence.failedAt = new Date().toISOString()
    evidence.failure = { stage: evidence.currentStage, message: error.message, exitCode: error.exitCode ?? 1 }
    const snapshotMetaPath = join(localSnapshotDir, 'snapshot.json')
    if (existsSync(snapshotMetaPath)) evidence.snapshot = readJson(snapshotMetaPath, 'snapshot')
    writeJson(releasePath, evidence)
    runStatus('scp', ['-p', releasePath, `${target}:/home/herman/.local/share/dsh-container/releases/${releaseId}/release.json`])
    throw error
  }
}

function performProductionReleaseUnsafe(candidate, candidatePath, releaseId, stage) {
  const localReleaseDir = join(stateRoot, 'releases', releaseId)
  const localSnapshotDir = join(stateRoot, 'snapshots', releaseId)
  ensureDir(localReleaseDir)
  ensureDir(localSnapshotDir)

  const preflight = ssh(`set -Eeuo pipefail
command -v docker >/dev/null || { echo 'Docker 未安装；请先在 herman.hermes 安装 docker.io 和 docker-compose-v2' >&2; exit 41; }
docker compose version >/dev/null
docker info >/dev/null
printf 'openclaw=%s\\n' "$(systemctl --user show openclaw-gateway.service -p MainPID -p NRestarts --value 2>/dev/null | tr '\\n' ',')"
`)

  const remoteRoot = '/home/herman/.local/share/dsh-container'
  const previousText = ssh(`set -Eeuo pipefail
root=${shellQuote(remoteRoot)}
test -f "$root/current/release.json" || { echo '当前生产不是可识别的 Docker release' >&2; exit 42; }
cat "$root/current/release.json"
`)
  const currentRelease = JSON.parse(previousText)
  if (currentRelease.status !== 'accepted') fail(`当前 Docker release 尚未 accepted，状态是 ${currentRelease.status ?? 'missing'}`, exitCodes.production)
  const previous = {
    mode: 'docker',
    releaseId: currentRelease.releaseId,
    remoteDir: `${remoteRoot}/releases/${currentRelease.releaseId}`,
    candidate: {
      imageId: currentRelease.candidate?.imageId,
      imageTag: currentRelease.candidate?.imageTag,
    },
    engineImageId: currentRelease.production?.engineImageId,
  }
  if (!previous.releaseId || !previous.candidate.imageId || !previous.candidate.imageTag || !previous.engineImageId) {
    fail('当前 Docker release.json 缺少回退所需镜像身份', exitCodes.production)
  }
  const remoteReleaseDir = `${remoteRoot}/releases/${releaseId}`
  const remoteSnapshot = `${remoteRoot}/snapshots/${releaseId}.tar.zst`
  stage('stop-writers-and-snapshot', { previous, preflight: { remote: preflight } })
  const stopOutput = ssh(`set -Eeuo pipefail
root=${shellQuote(remoteRoot)}
release_id=${shellQuote(releaseId)}
mkdir -p "$root/releases/$release_id" "$root/snapshots"
if test -f "$root/current/compose.production.yml"; then
  DSH_IMAGE=dummy DSH_IMAGE_ID=dummy docker compose -p dsh -f "$root/current/compose.production.yml" down --timeout 30 || true
else
  echo '当前 Docker release 缺少 compose.production.yml' >&2
  exit 43
fi
if docker ps --format '{{.Names}}' | grep -Eq '^dsh-(web|telegram|lan-proxy)$'; then echo 'DSH container writer still active' >&2; exit 43; fi
if pgrep -u "$(id -u)" -af 'apps/cli/(src/bin\\.ts|lib/bin\\.js).*(web|--profile telegram)' >/dev/null; then
  echo 'DSH Harness writer process still active' >&2; exit 44
fi
openclaw_before="$(systemctl --user show openclaw-gateway.service -p MainPID -p NRestarts --value 2>/dev/null | tr '\\n' ',')"
tar --acls --xattrs -C /home/herman -cf - .dsh | zstd -T0 -10 -o ${shellQuote(remoteSnapshot)}
chmod 600 ${shellQuote(remoteSnapshot)}
sha="sha256:$(sha256sum ${shellQuote(remoteSnapshot)} | awk '{print $1}')"
cat >"$root/releases/$release_id/stop.json" <<EOF
{"releaseId":"$release_id","archivePath":${JSON.stringify(remoteSnapshot)},"archiveSha256":"$sha","openclawBefore":"$openclaw_before"}
EOF
cat "$root/releases/$release_id/stop.json"
`)
  let stopMeta
  try { stopMeta = JSON.parse(stopOutput.split('\n').at(-1)) } catch { fail(`无法解析停机快照回执: ${stopOutput}`, exitCodes.production) }

  stage('verify-snapshot')
  const localSnapshot = join(localSnapshotDir, 'home.tar.zst')
  run('scp', ['-p', `${target}:${remoteSnapshot}`, localSnapshot], { code: exitCodes.production })
  if (sha256File(localSnapshot) !== stopMeta.archiveSha256) fail('停机快照传输摘要不一致；生产保持停止，等待人工裁决', exitCodes.production)
  const snapshotMeta = { schemaVersion: 1, snapshotId: releaseId, archivePath: localSnapshot, archiveSha256: stopMeta.archiveSha256, remoteArchivePath: remoteSnapshot, createdAt: new Date().toISOString() }
  const snapshotMetaPath = join(localSnapshotDir, 'snapshot.json')
  writeJson(snapshotMetaPath, snapshotMeta)
  copyFileSync(snapshotMetaPath, join(stateRoot, 'snapshots/latest.json'))

  const remoteSnapshotMetaPath = join(localReleaseDir, 'remote-snapshot.json')
  writeJson(remoteSnapshotMetaPath, { ...snapshotMeta, archivePath: remoteSnapshot })
  run('scp', ['-p', remoteSnapshotMetaPath, `${target}:${remoteRoot}/snapshots/${releaseId}.json`], { code: exitCodes.production })
  ssh(`set -Eeuo pipefail
root=${shellQuote(remoteRoot)}
cp "$root/snapshots/${releaseId}.json" "$root/snapshots/latest.json.next"
mv -Tf "$root/snapshots/latest.json.next" "$root/snapshots/latest.json"
  `)

  stage('snapshot-copy-tests', { snapshot: snapshotMeta })
  const preflightRoot = join(localReleaseDir, 'preflight')
  const testHome = join(preflightRoot, 'home/herman')
  let stateReceipt
  let selfTest
  let runtimeReceipt
  const preflightSourcePath = join(localReleaseDir, 'preflight-runtime')
  try {
    ensureDir(testHome)
    run('tar', ['--zstd', '-xf', localSnapshot, '-C', testHome], { code: exitCodes.test })
    const baseArgs = containerBaseArgs(testHome)
    run(engine, ['run', '--rm', ...baseArgs, '--env', `DSH_IMAGE_ID=${candidate.imageId}`, candidate.imageTag, 'prepare'], { code: exitCodes.test })
    stateReceipt = run(engine, ['run', '--rm', ...baseArgs, candidate.imageTag, 'validate-state', '/home/herman/.dsh'], { capture: true, code: exitCodes.test })
    writeFileSync(join(localReleaseDir, 'state-validation.json'), `${stateReceipt}\n`)
    selfTest = run(engine, ['run', '--rm', '--read-only', '--user', '1000:1000', '--tmpfs', '/tmp:rw', '--tmpfs', '/run:rw', candidate.imageTag, 'self-test'], { capture: true, code: exitCodes.test })
    writeFileSync(join(localReleaseDir, 'preflight-tests.txt'), `${selfTest}\n`)
    runtimeReceipt = commandDev({ _: ['up'], source: preflightSourcePath, snapshot: snapshotMetaPath, candidate: candidatePath, reset: true })
  } finally {
    const preflightLeasePath = developmentLeasePath(preflightSourcePath)
    if (existsSync(preflightLeasePath)) {
      const preflightLease = readJson(preflightLeasePath, 'preflight development lease')
      stopDev(runtimeForLease(preflightLease))
      rmSync(preflightLeasePath, { force: true })
      cleanupDevelopmentLease(preflightLease)
    } else {
      stopDev(runtimeReceipt?.runtime ?? developmentRuntime(preflightSourcePath))
      removeDevelopmentRuntime(preflightSourcePath)
    }
    try { removeControlledPath(localReleaseDir, preflightRoot) } catch (error) { warn(error.message) }
  }

  stage('transfer-and-start')
  run('ssh', ['-o', 'BatchMode=yes', target, 'mkdir', '-p', remoteReleaseDir], { code: exitCodes.production })
  run('scp', ['-p', candidate.archivePath, `${target}:${remoteReleaseDir}/image.tar`], { code: exitCodes.production })
  run('scp', ['-p', composePath, `${target}:${remoteReleaseDir}/compose.production.yml`], { code: exitCodes.production })
  run('scp', ['-p', candidatePath, `${target}:${remoteReleaseDir}/candidate.json`], { code: exitCodes.production })

  const startOutput = ssh(`set -Eeuo pipefail
release_dir=${shellQuote(remoteReleaseDir)}
expected_archive=${shellQuote(candidate.archiveSha256)}
expected_image=${shellQuote(candidate.imageId)}
expected_tag=${shellQuote(candidate.imageTag)}
actual_archive="sha256:$(sha256sum "$release_dir/image.tar" | awk '{print $1}')"
test "$actual_archive" = "$expected_archive" || { echo 'archive sha256 mismatch' >&2; exit 51; }
archive_identity="$(tar -xOf "$release_dir/image.tar" manifest.json | python3 -c 'import json,sys; entry=json.load(sys.stdin)[0]; print(entry["Config"]+"|"+entry["RepoTags"][0])')"
test "$archive_identity" = "${candidate.imageId.replace(/^sha256:/u, '')}.json|$expected_tag" || { echo "archive identity mismatch: $archive_identity" >&2; exit 52; }
docker load --input "$release_dir/image.tar"
engine_image="$(docker image inspect "$expected_tag" --format '{{.Id}}')"
test "$(docker image inspect "$expected_tag" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" = ${shellQuote(candidate.pluginsCommit)}
test "$(docker image inspect "$expected_tag" --format '{{index .Config.Labels "io.dsh.release.revision"}}')" = ${shellQuote(candidate.releaseToolCommit)}
test "$(docker image inspect "$expected_tag" --format '{{index .Config.Labels "io.dsh.harness.revision"}}')" = ${shellQuote(candidate.harnessCommit)}
cd "$release_dir"
DSH_IMAGE="$expected_tag" DSH_IMAGE_ID="$expected_image" docker compose -p dsh -f compose.production.yml up -d
for attempt in $(seq 1 24); do curl --fail --silent --max-time 2 http://127.0.0.1:3080/ >/dev/null && break; sleep 5; done
curl --fail --silent --max-time 3 http://127.0.0.1:3080/ >/dev/null
curl --fail --silent --max-time 3 http://192.168.6.240:3080/ >/dev/null
test "$(docker inspect dsh-web --format '{{.State.Running}}/{{.RestartCount}}')" = 'true/0'
test "$(docker inspect dsh-telegram --format '{{.State.Running}}/{{.RestartCount}}')" = 'true/0'
test "$(docker inspect dsh-lan-proxy --format '{{.State.Running}}/{{.RestartCount}}')" = 'true/0'
docker exec dsh-web node /opt/dsh/release-system/scripts/check-cron-control-ready.cjs >/dev/null
openclaw_after="$(systemctl --user show openclaw-gateway.service -p MainPID -p NRestarts --value 2>/dev/null | tr '\\n' ',')"
ln -sfn "$release_dir" ${shellQuote(remoteRoot)}/current.next
mv -Tf ${shellQuote(remoteRoot)}/current.next ${shellQuote(remoteRoot)}/current
printf '{"imageId":"%s","engineImageId":"%s","web":"%s","telegram":"%s","lan":"%s","cronControl":"ready","openclawAfter":"%s"}\\n' "$expected_image" "$engine_image" "$(docker inspect dsh-web --format '{{.State.Running}}/{{.RestartCount}}')" "$(docker inspect dsh-telegram --format '{{.State.Running}}/{{.RestartCount}}')" "$(docker inspect dsh-lan-proxy --format '{{.State.Running}}/{{.RestartCount}}')" "$openclaw_after"
`)
  let productionReceipt
  try { productionReceipt = JSON.parse(startOutput.split('\n').at(-1)) } catch { fail(`无法解析生产启动回执: ${startOutput}`, exitCodes.production) }
  if (stopMeta.openclawBefore !== productionReceipt.openclawAfter) fail('OpenClaw PID 或重启计数发生变化；不得宣告发版完成', exitCodes.production)

  const release = {
    schemaVersion: 1,
    releaseId,
    status: 'awaiting-user-acceptance',
    candidatePath,
    candidate,
    snapshot: snapshotMeta,
    previous,
    preflight: { remote: preflight, stateReceiptSha256: sha256Text(stateReceipt), selfTestSha256: sha256Text(selfTest), runtime: runtimeReceipt },
    production: productionReceipt,
    createdAt: new Date().toISOString(),
    userAcceptance: null,
  }
  const releasePath = join(localReleaseDir, 'release.json')
  writeJson(releasePath, release)
  run('scp', ['-p', releasePath, `${target}:${remoteReleaseDir}/release.json`], { code: exitCodes.production })
  out({ result: 'production-running-awaiting-user-acceptance', releasePath, releaseId, required: '请从真实 Telegram 发一条验收消息，并检查 Web；通过后执行 dsh accept。' })
}

function findRelease(value) {
  if (!value) fail('--release 必填', exitCodes.usage)
  const path = existsSync(value) ? resolve(value) : join(stateRoot, 'releases', value, 'release.json')
  return { path, release: readJson(path, 'release') }
}

function commandAccept(options) {
  const { path, release } = findRelease(options.release)
  if (release.status !== 'awaiting-user-acceptance') fail(`只有 awaiting-user-acceptance 可验收，当前是 ${release.status}`, exitCodes.safety)
  if (!options.evidence) fail('accept 必须提供 --evidence，记录真实 Telegram/Web 验收结论', exitCodes.usage)
  const evidence = existsSync(options.evidence) ? readFileSync(options.evidence, 'utf8').trim() : options.evidence
  if (!evidence) fail('验收证据不能为空', exitCodes.usage)
  const acceptanceHealth = ssh(`set -Eeuo pipefail
test "sha256:$(sha256sum ${shellQuote(`/home/herman/.local/share/dsh-container/releases/${release.releaseId}/image.tar`)} | awk '{print $1}')" = ${shellQuote(release.candidate.archiveSha256)}
test "$(docker image inspect ${shellQuote(release.candidate.imageTag)} --format '{{.Id}}')" = ${shellQuote(release.production.engineImageId)}
test "$(docker inspect dsh-web --format '{{.Image}}')" = ${shellQuote(release.production.engineImageId)}
test "$(docker inspect dsh-telegram --format '{{.Image}}')" = ${shellQuote(release.production.engineImageId)}
test "$(docker inspect dsh-web --format '{{.State.Running}}/{{.RestartCount}}')" = 'true/0'
test "$(docker inspect dsh-telegram --format '{{.State.Running}}/{{.RestartCount}}')" = 'true/0'
test "$(docker inspect dsh-lan-proxy --format '{{.State.Running}}/{{.RestartCount}}')" = 'true/0'
curl --fail --silent --max-time 3 http://127.0.0.1:3080/ >/dev/null
curl --fail --silent --max-time 3 http://192.168.6.240:3080/ >/dev/null
docker exec dsh-web node /opt/dsh/release-system/scripts/check-cron-control-ready.cjs >/dev/null
printf '%s\n' 'containers-and-web-healthy'
`)
  release.status = 'accepted'
  release.currentStage = 'accepted'
  release.acceptedAt = new Date().toISOString()
  release.userAcceptance = { evidence, acceptanceHealth }
  writeJson(path, release)
  const remoteDir = `/home/herman/.local/share/dsh-container/releases/${release.releaseId}`
  run('scp', ['-p', path, `${target}:${remoteDir}/release.json`], { code: exitCodes.production })
  ssh(`set -Eeuo pipefail
root=/home/herman/.local/share/dsh-container
release_dir=${shellQuote(remoteDir)}
test -f "$release_dir/release.json"
ln -sfn "$release_dir" "$root/last-good.next"
mv -Tf "$root/last-good.next" "$root/last-good"
`)
  const developmentCleanup = cleanupAcceptedDevelopmentState()
  release.localDevelopmentCleanup = developmentCleanup
  writeJson(path, release)
  const cleanupEvidenceSync = runStatus('scp', ['-p', path, `${target}:${remoteDir}/release.json`])
  if (cleanupEvidenceSync.status !== 0) warn('开发环境清理回执未能同步到远端 release.json；本地证据已保存')
  out({ result: 'accepted', releaseId: release.releaseId, imageId: release.candidate.imageId, developmentCleanup, next: '该 release 已固定为 current 和 last-good；旧开发环境已失效并清理。' })
}

function commandRollback(options) {
  const { path, release } = findRelease(options.release)
  if (!options.approved) {
    out({ status: 'waiting-for-rollback-authorization', releaseId: release.releaseId, restore: release.previous, snapshot: release.snapshot, next: '用户批准后加 --approved' })
    process.exitCode = exitCodes.approval
    return
  }
  if (release.previous?.mode !== 'docker') fail('release 没有可识别的上一 Docker release', exitCodes.safety)
  const remoteRoot = '/home/herman/.local/share/dsh-container'
  const remoteSnapshot = release.snapshot.remoteArchivePath
  const restartPrevious = `
previous_dir=${shellQuote(release.previous.remoteDir)}
previous_image=${shellQuote(release.previous.candidate.imageTag)}
previous_image_id=${shellQuote(release.previous.candidate.imageId)}
previous_engine_image_id=${shellQuote(release.previous.engineImageId)}
test -f "$previous_dir/compose.production.yml"
if ! docker image inspect "$previous_image" >/dev/null 2>&1; then
  test -f "$previous_dir/image.tar"
  docker load --input "$previous_dir/image.tar"
fi
test "$(docker image inspect "$previous_image" --format '{{.Id}}')" = "$previous_engine_image_id"
ln -sfn "$previous_dir" "$root/current.next"
mv -Tf "$root/current.next" "$root/current"
cd "$previous_dir"
DSH_IMAGE="$previous_image" DSH_IMAGE_ID="$previous_image_id" docker compose -p dsh -f compose.production.yml up -d
for attempt in $(seq 1 24); do curl --fail --silent --max-time 2 http://127.0.0.1:3080/ >/dev/null && break; sleep 5; done
curl --fail --silent --max-time 3 http://127.0.0.1:3080/ >/dev/null
test "$(docker inspect dsh-web --format '{{.State.Running}}/{{.RestartCount}}')" = 'true/0'
test "$(docker inspect dsh-telegram --format '{{.State.Running}}/{{.RestartCount}}')" = 'true/0'
test "$(docker inspect dsh-lan-proxy --format '{{.State.Running}}/{{.RestartCount}}')" = 'true/0'
docker exec dsh-web node /opt/dsh/release-system/scripts/check-cron-control-ready.cjs >/dev/null
`
  ssh(`set -Eeuo pipefail
root=${shellQuote(remoteRoot)}
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
openclaw_before="$(systemctl --user show openclaw-gateway.service -p MainPID -p NRestarts --value 2>/dev/null | tr '\\n' ',')"
if test -f "$root/current/compose.production.yml"; then
  cd "$root/current"
  DSH_IMAGE=${shellQuote(release.candidate.imageTag)} DSH_IMAGE_ID=${shellQuote(release.candidate.imageId)} docker compose -p dsh -f compose.production.yml down --timeout 30
fi
tar --acls --xattrs -C /home/herman -cf - .dsh | zstd -T0 -10 -o "$root/snapshots/failed-$timestamp.tar.zst"
restore="$root/restore-$timestamp"
mkdir -p "$restore"
tar --zstd -xf ${shellQuote(remoteSnapshot)} -C "$restore"
test -d "$restore/.dsh"
mv /home/herman/.dsh "$root/failed-dsh-$timestamp"
mv "$restore/.dsh" /home/herman/.dsh
${restartPrevious}
openclaw_after="$(systemctl --user show openclaw-gateway.service -p MainPID -p NRestarts --value 2>/dev/null | tr '\\n' ',')"
test "$openclaw_before" = "$openclaw_after"
`)
  release.status = 'rolled-back'
  release.currentStage = 'rolled-back'
  release.rolledBackAt = new Date().toISOString()
  writeJson(path, release)
  runStatus('scp', ['-p', path, `${target}:/home/herman/.local/share/dsh-container/releases/${release.releaseId}/release.json`])
  out({ result: 'rolled-back', releaseId: release.releaseId, restored: `${release.previous.mode} + downtime snapshot`, note: '失败版本现场数据另存，未直接删除。' })
}

function commandStatus() {
  const localCandidate = existsSync(join(stateRoot, 'candidates/latest.json')) ? readJson(join(stateRoot, 'candidates/latest.json')) : null
  const developmentCandidate = existsSync(developmentCandidatePointerPath()) ? readJson(developmentCandidatePointerPath()) : null
  const remoteResult = runStatus('ssh', ['-o', 'BatchMode=yes', target, 'bash', '-s'], { input: `set -u
printf 'openclaw='; systemctl --user show openclaw-gateway.service -p MainPID -p NRestarts --value 2>/dev/null | tr '\\n' ','; printf '\\n'
if command -v docker >/dev/null 2>&1; then
  docker ps --filter name='^dsh-' --format '{{.Names}} {{.Image}} {{.Status}}' 2>/dev/null || true
else
  echo 'docker=not-installed'
fi
printf 'current='; readlink -f /home/herman/.local/share/dsh-container/current 2>/dev/null || true
printf 'last-good='; readlink -f /home/herman/.local/share/dsh-container/last-good 2>/dev/null || true
` })
  out({ local: { stateRoot, latestCandidate: localCandidate, developmentMain: developmentCandidate }, remote: { target, reachable: remoteResult.status === 0, output: String(remoteResult.stdout ?? '').trim(), error: String(remoteResult.stderr ?? '').trim() } })
}

function usage() {
  out(`DSH Docker 发版唯一入口

  ./release/dsh snapshot latest
  ./release/dsh dev prepare --source <独立任务worktree> [--candidate <latest-main-candidate.json>]
  ./release/dsh dev up --snapshot latest|synthetic [--candidate candidate.json] [--reset]
  ./release/dsh dev shell [--candidate candidate.json]
  ./release/dsh dev down [--source <独立任务worktree>]
  ./release/dsh dev retire --source <独立任务worktree>
  ./release/dsh build --purpose development|release --harness-ref <40位commit> --plugins-ref <40位commit>
  ./release/dsh release --candidate <candidate.json> [--approved-stop]
  ./release/dsh status
  ./release/dsh accept --release <release-id|release.json> --evidence <说明|文件>
  ./release/dsh rollback --release <release-id|release.json> [--approved]

退出码：2 参数错误；3 等待授权；4 安全门；5 测试失败；6 生产验收失败。`)
}

async function main() {
  ensureDir(stateRoot)
  const [command, ...tokens] = process.argv.slice(2)
  const options = parseOptions(tokens)
  if (command === 'build') return commandBuild(options)
  if (command === 'dev') return commandDev(options)
  if (command === 'snapshot') return commandSnapshot(options)
  if (command === 'release') return commandRelease(options)
  if (command === 'status') return commandStatus(options)
  if (command === 'accept') return commandAccept(options)
  if (command === 'rollback') return commandRollback(options)
  if (!command || ['help', '--help', '-h'].includes(command)) return usage()
  fail(`未知命令: ${command}`, exitCodes.usage)
}

main().catch((error) => {
  process.stderr.write(`错误：${error.message}\n`)
  process.exitCode = error.exitCode ?? 1
})
