#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
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
  const hash = createHash('sha256')
  hash.update(readFileSync(path))
  return `sha256:${hash.digest('hex')}`
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
    if (['approved-stop', 'approved', 'synthetic'].includes(key)) { options[key] = true; continue }
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

function candidateFrom(value) {
  const path = value ? resolve(value) : join(stateRoot, 'candidates/latest.json')
  const candidate = readJson(path, 'candidate')
  for (const field of ['imageId', 'imageTag', 'archivePath', 'archiveSha256', 'pluginsCommit', 'harnessCommit']) {
    if (!candidate[field]) fail(`candidate 缺少 ${field}`, exitCodes.usage)
  }
  if (!existsSync(candidate.archivePath)) fail(`candidate 镜像归档不存在: ${candidate.archivePath}`, exitCodes.safety)
  if (sha256File(candidate.archivePath) !== candidate.archiveSha256) fail('candidate 镜像归档摘要不匹配', exitCodes.safety)
  return { candidate, path }
}

function imageId(name) {
  return run(engine, ['image', 'inspect', name, '--format', '{{.Id}}'], { capture: true, code: exitCodes.safety })
}

function stopDev() {
  for (const name of ['dsh-dev-telegram', 'dsh-dev-fake-telegram', 'dsh-dev-web']) {
    runStatus(engine, ['rm', '--force', name])
  }
  runStatus(engine, ['network', 'rm', 'dsh-dev-internal'])
}

function makeSyntheticHome(homePath) {
  ensureDir(join(homePath, '.dsh/storages/dsh-cron'))
  ensureDir(join(homePath, '.dsh/storages/personal-feed'))
  ensureDir(join(homePath, '.dsh/sessions'))
  ensureDir(join(homePath, '.dsh/workspace'))
  writeFileSync(join(homePath, '.dsh/storages/dsh-cron/jobs.jsonl'), '')
  writeFileSync(join(homePath, '.dsh/.credentials.yaml'), 'providers: {}\n', { mode: 0o600 })
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
  writeFileSync(join(dshHome, '.credentials.yaml'), 'providers: {}\n', { mode: 0o600 })
  for (const name of ['telegram-offset.json', 'scheduler.lock', 'worker.lock']) rmSync(join(dshHome, 'storages', name), { force: true })
}

function containerBaseArgs(homePath) {
  return [
    '--read-only', '--user', '1000:1000',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=512m', '--tmpfs', '/run:rw,nosuid,size=64m',
    '--volume', `${homePath}:/home/herman:rw`,
    '--env', 'HOME=/home/herman', '--env', 'DSH_HOME=/home/herman/.dsh', '--env', 'DSH_CWD=/home/herman/.dsh/workspace',
  ]
}

function commandBuild(options) {
  const harnessCommit = requireFullCommit(harnessRepo, options['harness-ref'], '--harness-ref')
  const pluginsCommit = requireFullCommit(repoRoot, options['plugins-ref'], '--plugins-ref')
  const lock = readJson(join(releaseRoot, 'image.lock.json'), 'image lock')
  const buildId = `${nowId()}-${pluginsCommit.slice(0, 12)}`
  const buildRoot = join(stateRoot, 'builds', buildId)
  const context = join(buildRoot, 'context')
  const harnessTarget = join(context, 'harness')
  const pluginsTarget = join(context, 'plugins')
  ensureDir(harnessTarget)
  ensureDir(pluginsTarget)

  const harnessTar = join(buildRoot, 'harness.tar')
  const pluginsTar = join(buildRoot, 'plugins.tar')
  run('git', ['-C', harnessRepo, 'archive', '--format=tar', `--output=${harnessTar}`, harnessCommit], { code: exitCodes.safety })
  run('git', ['-C', repoRoot, 'archive', '--format=tar', `--output=${pluginsTar}`, pluginsCommit], { code: exitCodes.safety })
  run('tar', ['-xf', harnessTar, '-C', harnessTarget], { code: exitCodes.safety })
  run('tar', ['-xf', pluginsTar, '-C', pluginsTarget], { code: exitCodes.safety })
  const archivedPatch = join(pluginsTarget, 'release/patches/harness-minimal-shell-path.patch')
  if (!existsSync(join(pluginsTarget, 'release/Containerfile')) || !existsSync(archivedPatch)) {
    fail('插件 commit 不包含受 Git 管理的 Docker 发版系统；请先提交实现再构建', exitCodes.safety)
  }
  run('git', ['-C', harnessTarget, 'apply', '--verbose', archivedPatch], { code: exitCodes.safety })
  const patchSha256 = sha256File(archivedPatch)
  const imageTag = `dsh-candidate:${pluginsCommit.slice(0, 12)}-${buildId.slice(0, 15).toLowerCase()}`
  const engineBuildOptions = engine === 'podman'
    ? ['--signature-policy', join(pluginsTarget, 'release/containers-policy.json')]
    : []

  run(engine, [
    'build', ...engineBuildOptions, '--format', 'docker', '--pull=missing',
    '--build-arg', `DSH_HARNESS_COMMIT=${harnessCommit}`,
    '--build-arg', `DSH_HARNESS_PATCH_SHA256=${patchSha256}`,
    '--build-arg', `DSH_PLUGINS_COMMIT=${pluginsCommit}`,
    '--label', `org.opencontainers.image.revision=${pluginsCommit}`,
    '--label', `io.dsh.harness.revision=${harnessCommit}`,
    '--label', `io.dsh.harness.patch-sha256=${patchSha256}`,
    '--tag', imageTag, '--file', join(pluginsTarget, 'release/Containerfile'), context,
  ], { code: exitCodes.test })

  const builtImageId = imageId(imageTag)
  const imageLabels = JSON.parse(run(engine, ['image', 'inspect', imageTag, '--format', '{{json .Config.Labels}}'], { capture: true, code: exitCodes.safety }))
  if (imageLabels['org.opencontainers.image.revision'] !== pluginsCommit
    || imageLabels['io.dsh.harness.revision'] !== harnessCommit
    || imageLabels['io.dsh.harness.patch-sha256'] !== patchSha256) {
    fail('镜像标签没有绑定到本次 Harness/插件源码身份', exitCodes.safety)
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

  const candidateDir = join(stateRoot, 'candidates', buildId)
  ensureDir(candidateDir)
  const receiptPath = join(candidateDir, 'image-tests.json')
  writeJson(receiptPath, testReceipt)
  const archivePath = join(candidateDir, 'image.tar')
  run(engine, ['save', '--format', 'docker-archive', '--output', archivePath, imageTag], { code: exitCodes.test })
  const archiveSha256 = sha256File(archivePath)

  // Prove the artifact can recreate the admitted identity. This only removes
  // the unique candidate tag created above; no user image is targeted.
  run(engine, ['image', 'rm', imageTag], { code: exitCodes.test })
  run(engine, ['load', '--input', archivePath], { code: exitCodes.test })
  const loadedImageId = imageId(imageTag)
  if (loadedImageId !== builtImageId) fail(`归档重载后的 image ID 改变: ${builtImageId} -> ${loadedImageId}`, exitCodes.test)

  const candidate = {
    schemaVersion: 1,
    candidateId: buildId,
    status: 'tested',
    imageId: builtImageId,
    imageTag,
    archivePath,
    archiveSha256,
    harnessCommit,
    harnessPatchSha256: patchSha256,
    pluginsCommit,
    baseImage: lock.image,
    baseImageDigest: lock.digest,
    builtAt: new Date().toISOString(),
    testReceiptPath: receiptPath,
    testReceiptSha256: sha256File(receiptPath),
  }
  const candidatePath = join(candidateDir, 'candidate.json')
  writeJson(candidatePath, candidate)
  copyFileSync(candidatePath, join(stateRoot, 'candidates/latest.json'))
  out({ result: 'candidate-built', candidatePath, ...candidate })
}

function commandDev(options) {
  const action = options._[0]
  if (action === 'down') {
    stopDev()
    out('开发容器已停止；开发数据副本保留。')
    return
  }
  const { candidate } = candidateFrom(options.candidate)
  const devRoot = join(stateRoot, 'dev', candidate.candidateId)
  const homePath = join(devRoot, 'home/herman')
  if (action === 'up') {
    stopDev()
    materializeSnapshot(options.snapshot ?? 'latest', homePath)
    run(engine, ['run', '--rm', ...containerBaseArgs(homePath), '--env', `DSH_IMAGE_ID=${candidate.imageId}`, candidate.imageTag, 'prepare'], { code: exitCodes.test })
    run(engine, ['network', 'create', '--internal', 'dsh-dev-internal'], { code: exitCodes.test })
    run(engine, ['run', '--detach', '--name', 'dsh-dev-fake-telegram', '--network', 'dsh-dev-internal', '--read-only', '--tmpfs', '/tmp:rw', candidate.imageTag, 'fake-telegram'], { code: exitCodes.test })
    run(engine, ['run', '--detach', '--name', 'dsh-dev-telegram', '--network', 'dsh-dev-internal', ...containerBaseArgs(homePath),
      '--env', 'TELEGRAM_BOT_TOKEN=test-token', '--env', 'TELEGRAM_ALLOWED_CHAT_ID=1', '--env', 'DEEPSEEK_API_KEY=test-key',
      candidate.imageTag, 'telegram-test'], { code: exitCodes.test })
    run(engine, ['run', '--detach', '--name', 'dsh-dev-web', '--network', 'host', ...containerBaseArgs(homePath),
      '--env', 'DSH_WEB_PORT=13080', '--env', 'DEEPSEEK_API_KEY=test-key', candidate.imageTag, 'web'], { code: exitCodes.test })
    out({ result: 'dev-started', web: 'http://127.0.0.1:13080', homePath, network: 'dsh-dev-internal', realTelegramReachable: false })
    return
  }
  if (action === 'shell') {
    if (!existsSync(homePath)) fail('开发数据副本不存在；请先执行 dev up', exitCodes.usage)
    run(engine, ['run', '--rm', '--interactive', '--tty', '--network', 'dsh-dev-internal', ...containerBaseArgs(homePath), candidate.imageTag, 'shell'], { code: exitCodes.test })
    return
  }
  fail('用法: dsh dev up --snapshot latest|synthetic；dsh dev shell；dsh dev down', exitCodes.usage)
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
    writersToStop: ['dsh-web.service', 'dsh-telegram-gateway.service', 'Docker Compose project dsh'],
    preservedOutOfScope: ['openclaw-gateway.service', '~/.openclaw', 'OpenClaw Telegram token'],
    snapshotRoot: '/home/herman/.local/share/dsh-container/snapshots',
    rollbackBoundary: '停机前完整 ~/.dsh 快照 + 旧 systemd units/release tree（首次切换）',
    next: `获得停机许可后重新执行，并添加 --approved-stop`,
  }
}

function commandRelease(options) {
  const { candidate, path: candidatePath } = candidateFrom(options.candidate)
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
  ensureDir(localReleaseDir)
  ensureDir(localSnapshotDir)

  const preflight = ssh(`set -Eeuo pipefail
command -v docker >/dev/null || { echo 'Docker 未安装；请先在 herman.hermes 安装 docker.io 和 docker-compose-v2' >&2; exit 41; }
docker compose version >/dev/null
docker info >/dev/null
printf 'openclaw=%s\\n' "$(systemctl --user show openclaw-gateway.service -p MainPID -p NRestarts --value 2>/dev/null | tr '\\n' ',')"
`)

  const remoteRoot = '/home/herman/.local/share/dsh-container'
  const remoteReleaseDir = `${remoteRoot}/releases/${releaseId}`
  const remoteSnapshot = `${remoteRoot}/snapshots/${releaseId}.tar.zst`
  const stopOutput = ssh(`set -Eeuo pipefail
root=${shellQuote(remoteRoot)}
release_id=${shellQuote(releaseId)}
mkdir -p "$root/releases/$release_id" "$root/snapshots"
if test -f "$root/current/compose.production.yml"; then
  DSH_IMAGE=dummy DSH_IMAGE_ID=dummy docker compose -p dsh -f "$root/current/compose.production.yml" down --timeout 30 || true
fi
systemctl --user stop dsh-telegram-gateway.service dsh-web-lan.socket dsh-web-lan.service dsh-web.service 2>/dev/null || true
for unit in dsh-telegram-gateway.service dsh-web.service dsh-web-lan.service dsh-web-lan.socket; do
  state="$(systemctl --user is-active "$unit" 2>/dev/null || true)"
  test "$state" != active && test "$state" != activating || { echo "writer still active: $unit" >&2; exit 42; }
done
if docker ps --format '{{.Names}}' | grep -Eq '^dsh-(web|telegram|lan-proxy)$'; then echo 'DSH container writer still active' >&2; exit 43; fi
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

  const localSnapshot = join(localSnapshotDir, 'home.tar.zst')
  run('scp', ['-p', `${target}:${remoteSnapshot}`, localSnapshot], { code: exitCodes.production })
  if (sha256File(localSnapshot) !== stopMeta.archiveSha256) fail('停机快照传输摘要不一致；生产保持停止，等待人工裁决', exitCodes.production)
  const snapshotMeta = { schemaVersion: 1, snapshotId: releaseId, archivePath: localSnapshot, archiveSha256: stopMeta.archiveSha256, remoteArchivePath: remoteSnapshot, createdAt: new Date().toISOString() }
  const snapshotMetaPath = join(localSnapshotDir, 'snapshot.json')
  writeJson(snapshotMetaPath, snapshotMeta)
  copyFileSync(snapshotMetaPath, join(stateRoot, 'snapshots/latest.json'))

  const testHome = join(localReleaseDir, 'preflight/home/herman')
  ensureDir(testHome)
  run('tar', ['--zstd', '-xf', localSnapshot, '-C', testHome], { code: exitCodes.test })
  const baseArgs = containerBaseArgs(testHome)
  run(engine, ['run', '--rm', ...baseArgs, '--env', `DSH_IMAGE_ID=${candidate.imageId}`, candidate.imageTag, 'prepare'], { code: exitCodes.test })
  const stateReceipt = run(engine, ['run', '--rm', ...baseArgs, candidate.imageTag, 'validate-state', '/home/herman/.dsh'], { capture: true, code: exitCodes.test })
  writeFileSync(join(localReleaseDir, 'state-validation.json'), `${stateReceipt}\n`)
  const selfTest = run(engine, ['run', '--rm', '--read-only', '--user', '1000:1000', '--tmpfs', '/tmp:rw', '--tmpfs', '/run:rw', candidate.imageTag, 'self-test'], { capture: true, code: exitCodes.test })
  writeFileSync(join(localReleaseDir, 'preflight-tests.txt'), `${selfTest}\n`)

  run('ssh', ['-o', 'BatchMode=yes', target, 'mkdir', '-p', remoteReleaseDir], { code: exitCodes.production })
  run('scp', ['-p', candidate.archivePath, `${target}:${remoteReleaseDir}/image.tar`], { code: exitCodes.production })
  run('scp', ['-p', composePath, `${target}:${remoteReleaseDir}/compose.production.yml`], { code: exitCodes.production })
  run('scp', ['-p', candidatePath, `${target}:${remoteReleaseDir}/candidate.json`], { code: exitCodes.production })

  const startOutput = ssh(`set -Eeuo pipefail
release_dir=${shellQuote(remoteReleaseDir)}
expected_archive=${shellQuote(candidate.archiveSha256)}
expected_image=${shellQuote(candidate.imageId)}
actual_archive="sha256:$(sha256sum "$release_dir/image.tar" | awk '{print $1}')"
test "$actual_archive" = "$expected_archive" || { echo 'archive sha256 mismatch' >&2; exit 51; }
docker load --input "$release_dir/image.tar"
actual_image="$(docker image inspect ${shellQuote(candidate.imageTag)} --format '{{.Id}}')"
test "$actual_image" = "$expected_image" || { echo "image ID mismatch: $actual_image" >&2; exit 52; }
ln -sfn "$release_dir" ${shellQuote(remoteRoot)}/current.next
mv -Tf ${shellQuote(remoteRoot)}/current.next ${shellQuote(remoteRoot)}/current
cd "$release_dir"
DSH_IMAGE=${shellQuote(candidate.imageTag)} DSH_IMAGE_ID="$expected_image" docker compose -p dsh -f compose.production.yml up -d
for attempt in $(seq 1 24); do curl --fail --silent --max-time 2 http://127.0.0.1:3080/ >/dev/null && break; sleep 5; done
curl --fail --silent --max-time 3 http://127.0.0.1:3080/ >/dev/null
test "$(docker inspect dsh-web --format '{{.State.Running}}/{{.RestartCount}}')" = 'true/0'
test "$(docker inspect dsh-telegram --format '{{.State.Running}}/{{.RestartCount}}')" = 'true/0'
openclaw_after="$(systemctl --user show openclaw-gateway.service -p MainPID -p NRestarts --value 2>/dev/null | tr '\\n' ',')"
printf '{"imageId":"%s","web":"%s","telegram":"%s","openclawAfter":"%s"}\\n' "$actual_image" "$(docker inspect dsh-web --format '{{.State.Running}}/{{.RestartCount}}')" "$(docker inspect dsh-telegram --format '{{.State.Running}}/{{.RestartCount}}')" "$openclaw_after"
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
    previous: { mode: 'legacy-systemd', releaseId: null },
    preflight: { remote: preflight, stateReceiptSha256: sha256Text(stateReceipt), selfTestSha256: sha256Text(selfTest) },
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
  release.status = 'accepted'
  release.acceptedAt = new Date().toISOString()
  release.userAcceptance = { evidence }
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
  out({ result: 'accepted', releaseId: release.releaseId, imageId: release.candidate.imageId, next: '旧系统仍保留；只有确认隔壁任务不再使用后才能执行 retire-legacy。' })
}

function commandRollback(options) {
  const { path, release } = findRelease(options.release)
  if (!options.approved) {
    out({ status: 'waiting-for-rollback-authorization', releaseId: release.releaseId, restore: release.previous, snapshot: release.snapshot, next: '用户批准后加 --approved' })
    process.exitCode = exitCodes.approval
    return
  }
  if (release.previous?.mode !== 'legacy-systemd') fail('当前第一版只允许回退到首次切换前的 legacy systemd；Docker→Docker 回退会在第一次验收后的第二轮演练中启用', exitCodes.safety)
  const remoteRoot = '/home/herman/.local/share/dsh-container'
  const remoteSnapshot = release.snapshot.remoteArchivePath
  ssh(`set -Eeuo pipefail
root=${shellQuote(remoteRoot)}
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
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
systemctl --user start dsh-web.service dsh-web-lan.socket dsh-telegram-gateway.service
for attempt in $(seq 1 24); do curl --fail --silent --max-time 2 http://127.0.0.1:3080/ >/dev/null && break; sleep 5; done
curl --fail --silent --max-time 3 http://127.0.0.1:3080/ >/dev/null
systemctl --user is-active --quiet dsh-web.service
systemctl --user is-active --quiet dsh-telegram-gateway.service
`)
  release.status = 'rolled-back'
  release.rolledBackAt = new Date().toISOString()
  writeJson(path, release)
  out({ result: 'rolled-back', releaseId: release.releaseId, restored: 'legacy-systemd + downtime snapshot', note: '失败版本现场数据另存，未直接删除。' })
}

function commandStatus() {
  const localCandidate = existsSync(join(stateRoot, 'candidates/latest.json')) ? readJson(join(stateRoot, 'candidates/latest.json')) : null
  const remoteResult = runStatus('ssh', ['-o', 'BatchMode=yes', target, 'bash', '-s'], { input: `set -u
printf 'openclaw='; systemctl --user show openclaw-gateway.service -p MainPID -p NRestarts --value 2>/dev/null | tr '\\n' ','; printf '\\n'
if command -v docker >/dev/null 2>&1; then
  docker ps --filter name='^dsh-' --format '{{.Names}} {{.Image}} {{.Status}}' 2>/dev/null || true
else
  echo 'docker=not-installed'
fi
for unit in dsh-web.service dsh-telegram-gateway.service; do printf '%s=' "$unit"; systemctl --user is-active "$unit" 2>/dev/null || true; done
` })
  out({ local: { stateRoot, latestCandidate: localCandidate }, remote: { target, reachable: remoteResult.status === 0, output: String(remoteResult.stdout ?? '').trim(), error: String(remoteResult.stderr ?? '').trim() } })
}

function commandRetireLegacy(options) {
  const { release } = findRelease(options.release)
  if (release.status !== 'accepted') fail('只有 accepted release 才能清理旧系统', exitCodes.safety)
  if (!options.approved) {
    out({ status: 'waiting-for-destructive-cleanup-authorization', releaseId: release.releaseId, next: '确认隔壁任务不再依赖旧流程后加 --approved' })
    process.exitCode = exitCodes.approval
    return
  }
  const healthy = ssh(`set -Eeuo pipefail
test "$(docker inspect dsh-web --format '{{.State.Running}}/{{.RestartCount}}')" = 'true/0'
test "$(docker inspect dsh-telegram --format '{{.State.Running}}/{{.RestartCount}}')" = 'true/0'
test "$(docker image inspect ${shellQuote(release.candidate.imageTag)} --format '{{.Id}}')" = ${shellQuote(release.candidate.imageId)}
`)
  void healthy
  ssh(`set -Eeuo pipefail
systemctl --user disable --now dsh-web.service dsh-telegram-gateway.service dsh-web-lan.service dsh-web-lan.socket 2>/dev/null || true
for unit in dsh-web.service dsh-telegram-gateway.service dsh-web-lan.service dsh-web-lan.socket dsh-canary.slice; do
  rm -f -- "/home/herman/.config/systemd/user/$unit"
done
systemctl --user daemon-reload
rm -rf -- /home/herman/.local/share/dsh-deploy
`)
  const legacyLocal = realpathSync(process.env.DSH_LEGACY_LOCAL_ROOT ?? '/home/herman/Projects/dsh-plugins/deployment/herman-hermes')
  if (legacyLocal !== '/home/herman/Projects/dsh-plugins/deployment/herman-hermes') fail(`拒绝删除非预期目录: ${legacyLocal}`, exitCodes.safety)
  rmSync(legacyLocal, { recursive: true, force: true })
  out({ result: 'legacy-runtime-retired', releaseId: release.releaseId, note: '受 Git 管理的旧引用和一次性兼容代码还需在本分支提交删除，并完成 Docker→Docker 演练。' })
}

function usage() {
  out(`DSH Docker 发版唯一入口

  ./release/dsh snapshot latest
  ./release/dsh dev up --snapshot latest|synthetic [--candidate candidate.json]
  ./release/dsh dev shell [--candidate candidate.json]
  ./release/dsh dev down
  ./release/dsh build --harness-ref <40位commit> --plugins-ref <40位commit>
  ./release/dsh release --candidate <candidate.json> [--approved-stop]
  ./release/dsh status
  ./release/dsh accept --release <release-id|release.json> --evidence <说明|文件>
  ./release/dsh rollback --release <release-id|release.json> [--approved]
  ./release/dsh retire-legacy --release <accepted-release-id|release.json> [--approved]

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
  if (command === 'retire-legacy') return commandRetireLegacy(options)
  if (!command || ['help', '--help', '-h'].includes(command)) return usage()
  fail(`未知命令: ${command}`, exitCodes.usage)
}

main().catch((error) => {
  process.stderr.write(`错误：${error.message}\n`)
  process.exitCode = error.exitCode ?? 1
})
