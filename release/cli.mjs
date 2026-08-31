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
const patchPath = join(releaseRoot, 'patches/harness-minimal-shell-path.patch')
const exitCodes = Object.freeze({ usage: 2, approval: 3, safety: 4, test: 5, production: 6 })

function emptyTmpfsSpec(path, options = 'rw') {
  const mountOptions = basename(engine) === 'podman' ? `${options},notmpcopyup` : options
  return `${path}:${mountOptions}`
}

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
    env: { ...(options.baseEnv ?? process.env), ...options.env },
    input: options.input,
    encoding: 'utf8',
    stdio: options.capture ? ['pipe', 'pipe', 'pipe'] : [options.input === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'],
    maxBuffer: 128 * 1024 * 1024,
  })
  if (result.error) fail(`无法执行 ${command}: ${result.error.message}`, options.code)
  if (options.cancelOnSignal && result.signal) {
    const signalExitCode = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }[result.signal] ?? 1
    fail(`${options.cancelOnSignal} 已取消（${result.signal}）；既有开发环境保持不变`, signalExitCode)
  }
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

function credentialSafeEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => (
    !/^NOTION_/u.test(name)
    && !/(?:NOTION|AUTHORIZATION).*(?:TOKEN|SECRET|KEY)/iu.test(name)
  )))
}

function runRemoteCommand(command, args, { input, code = exitCodes.production } = {}) {
  return run('ssh', ['-o', 'BatchMode=yes', target, commandText(command, args)], {
    input,
    capture: true,
    announce: false,
    baseEnv: credentialSafeEnvironment(),
    code,
  })
}

function runRemoteReadOnlyStatus(command, args, input) {
  const result = spawnSync('ssh', ['-o', 'BatchMode=yes', target, commandText(command, args)], {
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: credentialSafeEnvironment(),
    maxBuffer: 256 * 1024,
    timeout: 240_000,
  })
  if (result.error || result.status !== 0 || result.signal
    || String(result.stderr ?? '') !== '' || Buffer.byteLength(String(result.stdout ?? '')) > 128 * 1024) {
    fail('Harness Notion automation 生产状态不可确认', exitCodes.production)
  }
  return String(result.stdout ?? '').trim()
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

function readGitBlob(commit, path, label = path) {
  const result = spawnSync('git', ['-C', repoRoot, 'show', `${commit}:${path}`], {
    encoding: null,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 4 * 1024 * 1024,
  })
  if (result.error || result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
    fail(`无法读取 ${label} 的绑定 Git 字节`, exitCodes.safety)
  }
  return result.stdout
}

function sha256Tree(root) {
  if (!existsSync(root)) fail(`无法计算缺失目录的 SHA-256: ${root}`, exitCodes.safety)
  const rootEntry = lstatSync(root)
  if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
    fail(`目录摘要输入不是普通目录: ${root}`, exitCodes.safety)
  }
  const records = []
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name)
      const entry = lstatSync(path)
      const relative = path.slice(root.length + 1)
      const mode = (entry.mode & 0o7777).toString(8).padStart(4, '0')
      if (entry.isSymbolicLink()) fail(`目录摘要拒绝符号链接: ${relative}`, exitCodes.safety)
      if (entry.isDirectory()) {
        records.push({ path: relative, type: 'directory', mode })
        visit(path)
      } else if (entry.isFile()) {
        records.push({
          path: relative,
          type: 'file',
          mode,
          size: entry.size,
          sha256: sha256File(path),
        })
      } else {
        fail(`目录摘要拒绝特殊文件: ${relative}`, exitCodes.safety)
      }
    }
  }
  visit(root)
  return sha256Text(JSON.stringify(records))
}

function validateWorkspaceMigration(value, label = 'candidate.workspaceMigration') {
  const required = [
    'version',
    'migrationId',
    'codeSha256',
    'manifestSha256',
    'templateSha256',
    'rootInstructionsSha256',
    'personalTaskListSkillSha256',
    'businessAutomation',
  ]
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('\0') !== [...required].sort().join('\0')) {
    fail(`${label} 字段不完整`, exitCodes.safety)
  }
  if (value.version !== 1 || value.migrationId !== 'harness-only-workspace-v1') {
    fail(`${label} 版本或 migrationId 不匹配`, exitCodes.safety)
  }
  for (const field of required.filter(field => field.endsWith('Sha256'))) {
    if (!/^sha256:[0-9a-f]{64}$/u.test(value[field] ?? '')) {
      fail(`${label}.${field} 不是完整 SHA-256`, exitCodes.safety)
    }
  }
  const ownership = value.businessAutomation
  if (!ownership || typeof ownership !== 'object' || Array.isArray(ownership)
    || Object.keys(ownership).sort().join('\0') !== ['includedInCandidate', 'owner'].sort().join('\0')
    || ownership.owner !== 'live-harness-workspace'
    || ownership.includedInCandidate !== false) {
    fail(`${label}.businessAutomation 不符合线上 Harness ownership 边界`, exitCodes.safety)
  }
  return value
}

const workspaceMigrationLabelFields = Object.freeze({
  version: 'io.dsh.workspace-migration.version',
  migrationId: 'io.dsh.workspace-migration.id',
  codeSha256: 'io.dsh.workspace-migration.code-sha256',
  manifestSha256: 'io.dsh.workspace-migration.manifest-sha256',
  templateSha256: 'io.dsh.workspace-migration.template-sha256',
  rootInstructionsSha256: 'io.dsh.workspace-migration.root-instructions-sha256',
  personalTaskListSkillSha256: 'io.dsh.workspace-migration.personal-task-list-skill-sha256',
})

function workspaceMigrationImageLabels(workspaceMigration) {
  const validated = validateWorkspaceMigration(workspaceMigration)
  const labels = Object.fromEntries(Object.entries(workspaceMigrationLabelFields).map(([field, name]) => [
    name,
    String(validated[field]),
  ]))
  labels['io.dsh.business-automation.owner'] = validated.businessAutomation.owner
  labels['io.dsh.business-automation.included-in-candidate'] = String(validated.businessAutomation.includedInCandidate)
  return labels
}

function workspaceMigrationExpectedEnvArgs(workspaceMigration) {
  if (workspaceMigration === null || workspaceMigration === undefined) return []
  return [
    '--env', `DSH_EXPECTED_WORKSPACE_MIGRATION_CODE_SHA256=${workspaceMigration.codeSha256}`,
    '--env', `DSH_EXPECTED_WORKSPACE_MIGRATION_MANIFEST_SHA256=${workspaceMigration.manifestSha256}`,
    '--env', `DSH_EXPECTED_WORKSPACE_MIGRATION_TEMPLATE_SHA256=${workspaceMigration.templateSha256}`,
    '--env', `DSH_EXPECTED_WORKSPACE_MIGRATION_ROOT_INSTRUCTIONS_SHA256=${workspaceMigration.rootInstructionsSha256}`,
    '--env', `DSH_EXPECTED_WORKSPACE_MIGRATION_PERSONAL_TASK_LIST_SKILL_SHA256=${workspaceMigration.personalTaskListSkillSha256}`,
  ]
}

function expectedCandidateImageLabels(candidate) {
  const labels = {
    'org.opencontainers.image.revision': candidate.pluginsCommit,
    'io.dsh.release.revision': candidate.releaseToolCommit,
    'io.dsh.harness.revision': candidate.harnessCommit,
    'io.dsh.harness.patch-sha256': candidate.harnessPatchSha256,
    'io.dsh.candidate.purpose': candidate.purpose,
  }
  if (candidate.purpose === 'release') {
    Object.assign(labels, workspaceMigrationImageLabels(candidate.workspaceMigration))
    labels['io.dsh.release.compose-sha256'] = candidate.composeSha256
  }
  return labels
}

function validateCandidateImageLabels(labels, candidate, label) {
  if (!labels || typeof labels !== 'object' || Array.isArray(labels)) {
    fail(`${label} 缺少镜像标签`, exitCodes.safety)
  }
  for (const [name, expected] of Object.entries(expectedCandidateImageLabels(candidate))) {
    if (labels[name] !== expected) fail(`${label} 镜像标签 ${name} 不匹配`, exitCodes.safety)
  }
  if (Object.keys(labels).some(name => /notion.*script.*sha256/iu.test(name))) {
    fail(`${label} 不得把 Workspace Notion 业务脚本写入候选标签`, exitCodes.safety)
  }
}

const formalCandidateFields = Object.freeze([
  'schemaVersion',
  'candidateId',
  'status',
  'purpose',
  'imageId',
  'imageTag',
  'archivePath',
  'archiveSha256',
  'archiveRoundTripCleanup',
  'composePath',
  'composeSha256',
  'harnessCommit',
  'harnessPatchSha256',
  'pluginsCommit',
  'releaseToolCommit',
  'baseImage',
  'baseImageDigest',
  'builtAt',
  'testReceiptPath',
  'testReceiptSha256',
  'workspaceMigration',
])

function validateFormalCandidateSchema(candidate, label = 'formal candidate') {
  if (candidate?.schemaVersion !== 3
    || Object.keys(candidate ?? {}).sort().join('\0') !== [...formalCandidateFields].sort().join('\0')) {
    fail(`${label} schema 必须是字段精确的 v3`, exitCodes.safety)
  }
  if (candidate.status !== 'tested' || candidate.purpose !== 'release') {
    fail(`${label} 必须是 tested release`, exitCodes.safety)
  }
  for (const field of ['pluginsCommit', 'releaseToolCommit', 'harnessCommit']) {
    if (!/^[0-9a-f]{40}$/u.test(candidate[field] ?? '')) fail(`${label}.${field} 不是完整 commit`, exitCodes.safety)
  }
  for (const field of ['harnessPatchSha256', 'baseImageDigest', 'archiveSha256', 'composeSha256', 'testReceiptSha256']) {
    if (!/^sha256:[0-9a-f]{64}$/u.test(candidate[field] ?? '')) fail(`${label}.${field} 不是完整 SHA-256`, exitCodes.safety)
  }
  validateWorkspaceMigration(candidate.workspaceMigration, `${label}.workspaceMigration`)
  return candidate
}

function validateLegacyFormalCandidateSchema(candidate, label) {
  const legacyFields = formalCandidateFields.filter(field => !['workspaceMigration', 'composePath', 'composeSha256'].includes(field))
  if (candidate?.schemaVersion !== 2
    || Object.keys(candidate ?? {}).sort().join('\0') !== [...legacyFields].sort().join('\0')
    || Object.hasOwn(candidate ?? {}, 'workspaceMigration')) {
    fail(`${label} 不是受控 legacy v2 candidate`, exitCodes.safety)
  }
  if (candidate.status !== 'tested' || candidate.purpose !== 'release') {
    fail(`${label} legacy v2 candidate 状态或用途不匹配`, exitCodes.safety)
  }
  return candidate
}

function workspaceMigrationFromArchives(releaseTarget, pluginsTarget) {
  const manifestPath = join(releaseTarget, 'release/workspace-migrations/harness-only-v1/manifest.json')
  const manifest = readJson(manifestPath, 'archived workspace migration manifest')
  if (manifest.schemaVersion !== 1 || manifest.migrationVersion !== 1
    || manifest.migrationId !== 'harness-only-workspace-v1') {
    fail('归档中的 workspace migration manifest 身份不匹配', exitCodes.safety)
  }
  if (existsSync(join(pluginsTarget, 'automations'))) {
    fail('正式候选不得包含 Workspace 业务 automation 副本', exitCodes.safety)
  }
  const templateSha256 = sha256File(join(releaseTarget, 'release/workspace-migrations/harness-only-v1/AGENTS.md'))
  if (manifest.workspace?.agents?.postimageSha256 !== templateSha256.slice('sha256:'.length)) {
    fail('workspace migration 模板摘要与 manifest postimage 不一致', exitCodes.safety)
  }
  return validateWorkspaceMigration({
    version: 1,
    migrationId: manifest.migrationId,
    codeSha256: sha256File(join(releaseTarget, 'release/scripts/migrate-workspace-state.py')),
    manifestSha256: sha256File(manifestPath),
    templateSha256,
    rootInstructionsSha256: sha256File(join(releaseTarget, 'release/harness-automation-instructions.md')),
    personalTaskListSkillSha256: sha256Tree(join(pluginsTarget, 'skills/personal-task-list')),
    businessAutomation: {
      owner: 'live-harness-workspace',
      includedInCandidate: false,
    },
  }, 'archived workspaceMigration')
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

const notionCredentialTarget = '/home/herman/.dsh/secrets/notion.token'
const notionPublicConfigFields = Object.freeze([
  'schemaVersion',
  'apiBase',
  'apiVersion',
  'pageId',
  'credentialPath',
  'inboxPath',
])

function productionNotionConfig(commit) {
  const source = readGitBlob(
    commit,
    'release/notion.production.json',
    'Notion production public configuration',
  )
  let config
  try { config = JSON.parse(source.toString('utf8')) } catch {
    fail('Notion production public configuration 不是有效 JSON', exitCodes.safety)
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)
    || Object.keys(config).sort().join('\0') !== [...notionPublicConfigFields].sort().join('\0')
    || config.schemaVersion !== 1
    || config.apiBase !== 'https://api.notion.com/v1'
    || config.apiVersion !== '2026-03-11'
    || !/^[0-9a-f]{32}$/u.test(config.pageId ?? '')
    || config.credentialPath !== notionCredentialTarget
    || config.inboxPath !== '/home/herman/.dsh/storages/task-inbox/inbox.md') {
    fail('Notion production public configuration 不符合固定发布合同', exitCodes.safety)
  }
  return config
}

function parseNotionReceipt(text, label) {
  let receipt
  try { receipt = JSON.parse(text) } catch { fail(`${label} 没有返回有效脱敏 JSON 回执`, exitCodes.production) }
  const required = ['target', 'time', 'permissions', 'pageReadable', 'bodyLength', 'bodySha256']
  const permissions = receipt?.permissions
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)
    || Object.keys(receipt).sort().join('\0') !== [...required].sort().join('\0')
    || receipt.target !== notionCredentialTarget
    || typeof receipt.time !== 'string' || !Number.isFinite(Date.parse(receipt.time))
    || receipt.pageReadable !== true
    || !Number.isSafeInteger(receipt.bodyLength) || receipt.bodyLength < 0
    || !/^[0-9a-f]{64}$/u.test(receipt.bodySha256 ?? '')
    || !permissions || typeof permissions !== 'object' || Array.isArray(permissions)
    || Object.keys(permissions).sort().join('\0') !== ['directory', 'file', 'ownerGid', 'ownerUid'].sort().join('\0')
    || permissions.directory !== '0700' || permissions.file !== '0600'
    || permissions.ownerUid !== 1000 || permissions.ownerGid !== 1000) {
    fail(`${label} 回执字段不符合脱敏合同`, exitCodes.production)
  }
  return receipt
}

const remoteCredentialLoader = [
  'import base64,subprocess,sys',
  'source=base64.b64decode(sys.stdin.buffer.readline().strip(),validate=True)',
  'token=sys.stdin.buffer.read()',
  'result=subprocess.run([sys.executable,"-c",source,*sys.argv[1:]],input=token)',
  'raise SystemExit(result.returncode)',
].join(';')

const remoteReadOnlyCheckerLoader = `
import base64, os, sys, tempfile
source = base64.b64decode(sys.stdin.buffer.readline().strip(), validate=True)
config = base64.b64decode(sys.stdin.buffer.readline().strip(), validate=True)
descriptor, config_path = tempfile.mkstemp(prefix="dsh-notion-public-", suffix=".json")
try:
    os.fchmod(descriptor, 0o600)
    written = 0
    while written < len(config):
        written += os.write(descriptor, config[written:])
    os.fsync(descriptor)
finally:
    os.close(descriptor)
try:
    sys.argv = ["check-notion-page.py", "--config", config_path, "--owner-uid", "1000", "--owner-gid", "1000"]
    exec(compile(source, "check-notion-page.py", "exec"), {"__name__": "__main__", "__file__": "check-notion-page.py"})
finally:
    try:
        os.unlink(config_path)
    except FileNotFoundError:
        pass
`

function verifyProductionNotionCredential(candidate) {
  const config = productionNotionConfig(candidate.releaseToolCommit)
  const source = readGitBlob(
    candidate.releaseToolCommit,
    'release/scripts/check-notion-page.py',
    '生产 Notion credential checker',
  )
  const input = Buffer.from(`${source.toString('base64')}\n${Buffer.from(JSON.stringify(config)).toString('base64')}\n`)
  const output = runRemoteCommand('python3', ['-c', remoteReadOnlyCheckerLoader], {
    input,
    code: exitCodes.production,
  })
  return parseNotionReceipt(output, '生产 Notion 凭据只读验证')
}

const notionArtifactContract = Object.freeze({
  interfaceVersion: 1,
  state: Object.freeze({
    role: 'state',
    path: 'storages/task-inbox/sync-state.json',
    mode: '0600',
  }),
  fingerprint: Object.freeze({
    role: 'fingerprint',
    path: 'storages/task-inbox/notion-fingerprint.json',
    mode: '0600',
  }),
})

function hasExactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0')
}

function isExactNotionArtifactContract(value) {
  if (!hasExactKeys(value, ['interfaceVersion', 'state', 'fingerprint'])
    || value.interfaceVersion !== notionArtifactContract.interfaceVersion) return false
  for (const role of ['state', 'fingerprint']) {
    const artifact = value[role]
    const expected = notionArtifactContract[role]
    if (!hasExactKeys(artifact, ['role', 'path', 'mode'])
      || artifact.role !== expected.role
      || artifact.path !== expected.path
      || artifact.mode !== expected.mode) return false
  }
  return true
}

function parseNotionAutomationReceipt(text, label, code = exitCodes.production) {
  let receipt
  try { receipt = JSON.parse(text) } catch { fail(`${label} 没有返回有效脱敏 JSON 回执`, code) }
  const required = [
    'status', 'owner', 'path', 'handoffPath', 'interfaceVersion', 'artifactContract',
    'size', 'sha256', 'handoffSha256', 'testReceiptSha256', 'testedAt',
  ]
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)
    || Object.keys(receipt).sort().join('\0') !== required.sort().join('\0')
    || receipt.status !== 'ready' || receipt.owner !== 'live-harness-workspace'
    || receipt.path !== 'workspace/automations/notion/notion_inbox_sync.py'
    || receipt.handoffPath !== 'workspace/automations/notion/notion_inbox_sync.handoff.json'
    || receipt.interfaceVersion !== 1
    || !isExactNotionArtifactContract(receipt.artifactContract)
    || !Number.isSafeInteger(receipt.size) || receipt.size < 1 || receipt.size > 1024 * 1024
    || !/^[0-9a-f]{64}$/u.test(receipt.sha256 ?? '')
    || !/^[0-9a-f]{64}$/u.test(receipt.handoffSha256 ?? '')
    || !/^[0-9a-f]{64}$/u.test(receipt.testReceiptSha256 ?? '')
    || typeof receipt.testedAt !== 'string' || !Number.isFinite(Date.parse(receipt.testedAt))) {
    fail(`${label} 回执字段不符合线上 Harness automation 合同`, code)
  }
  return receipt
}

function validateNotionInboxInitReceipt(receipt, notionAutomation, {
  allowedStatuses = ['initialized', 'already-initialized'],
  label = 'Notion task mirror 初始化',
  code = exitCodes.test,
} = {}) {
  const keys = [
    'status', 'entrypointSha256', 'handoffSha256', 'testReceiptSha256',
    'artifacts', 'remoteMethod',
  ]
  const expectedArtifacts = {
    mirror: { role: 'mirror', path: 'storages/task-inbox/inbox.md', mode: '0600' },
    state: notionAutomation?.artifactContract?.state,
    fingerprint: notionAutomation?.artifactContract?.fingerprint,
  }
  const artifactsValid = hasExactKeys(receipt?.artifacts, ['mirror', 'state', 'fingerprint'])
    && isExactNotionArtifactContract(notionAutomation?.artifactContract)
    && ['mirror', 'state', 'fingerprint'].every(role => {
      const artifact = receipt.artifacts[role]
      const expected = expectedArtifacts[role]
      return hasExactKeys(artifact, ['role', 'path', 'mode', 'length', 'sha256'])
        && artifact.role === expected.role
        && artifact.path === expected.path
        && artifact.mode === expected.mode
        && Number.isSafeInteger(artifact.length) && artifact.length > 0
        && /^[0-9a-f]{64}$/u.test(artifact.sha256 ?? '')
    })
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)
    || Object.keys(receipt).sort().join('\0') !== keys.sort().join('\0')
    || !allowedStatuses.includes(receipt.status)
    || receipt.entrypointSha256 !== notionAutomation.sha256
    || receipt.handoffSha256 !== notionAutomation.handoffSha256
    || receipt.testReceiptSha256 !== notionAutomation.testReceiptSha256
    || !artifactsValid
    || (receipt.status === 'initialized' && receipt.remoteMethod !== 'GET')
    || (receipt.status === 'already-initialized' && receipt.remoteMethod !== 'none')) {
    fail(`${label}回执不符合 Harness handoff 合同`, code)
  }
  return receipt
}

const remoteAutomationCheckerLoader = [
  'import base64,sys',
  'source=base64.b64decode(sys.stdin.buffer.read(),validate=True)',
  'sys.argv=["check-notion-automation-entrypoint.py","--dsh-home","/home/herman/.dsh","--owner-uid","1000","--owner-gid","1000","--expected-probe-sha256",sys.argv[1]]',
  'exec(compile(source,"check-notion-automation-entrypoint.py","exec"),{"__name__":"__main__","__file__":"check-notion-automation-entrypoint.py"})',
].join(';')

function verifyProductionNotionAutomation(candidate) {
  const source = readGitBlob(
    candidate.releaseToolCommit,
    'release/scripts/check-notion-automation-entrypoint.py',
    '生产 Notion automation checker',
  )
  const probe = readGitBlob(
    candidate.releaseToolCommit,
    'release/scripts/verify-harness-notion-automation.py',
    '生产 Notion automation trusted probe',
  )
  const probeSha256 = createHash('sha256').update(probe).digest('hex')
  const output = runRemoteCommand('python3', ['-c', remoteAutomationCheckerLoader, probeSha256], {
    input: source.toString('base64'),
    code: exitCodes.production,
  })
  return parseNotionAutomationReceipt(output, '生产 Harness-owned Notion automation 只读验证')
}

const harnessNotionOrchestrationAssets = Object.freeze({
  bridge: 'release/scripts/harness-notion-automation-bridge.mjs',
  patch: 'release/scripts/harness-notion-automation.patch.yml',
  prompt: 'release/scripts/harness-notion-automation-task.md',
  checker: 'release/scripts/check-notion-automation-entrypoint.py',
  probe: 'release/scripts/verify-harness-notion-automation.py',
})

const harnessNotionLocalAssets = Object.freeze({
  localImpl: 'release/scripts/harness-notion-automation-local/notion_inbox_sync.py',
  localTests: 'release/scripts/harness-notion-automation-local/tests/test_notion_inbox_sync.py',
})

const remoteHarnessNotionLoader = `
import base64, hashlib, json, sys

def reject():
    raise SystemExit(4)

try:
    payload = json.load(sys.stdin)
except Exception:
    reject()
if not isinstance(payload, dict) or set(payload) != {
    'runner', 'runnerSha256', 'orchestrationCommit', 'assets',
    'localImpl', 'localTests'
}:
    reject()
runner_sha256 = payload.get('runnerSha256')
if not isinstance(runner_sha256, str) or len(runner_sha256) != 64:
    reject()
try:
    runner = base64.b64decode(payload.get('runner'), validate=True)
except Exception:
    reject()
if hashlib.sha256(runner).hexdigest() != runner_sha256:
    reject()
items = payload.get('assets')
expected_names = {'bridge', 'patch', 'prompt', 'checker', 'probe'}
if not isinstance(items, dict) or set(items) != expected_names:
    reject()
assets = {}
hashes = {}
for name, item in items.items():
    if not isinstance(item, dict) or set(item) != {'content', 'sha256'}:
        reject()
    try:
        content = base64.b64decode(item.get('content'), validate=True)
    except Exception:
        reject()
    expected_sha256 = item.get('sha256')
    if not isinstance(expected_sha256, str) or hashlib.sha256(content).hexdigest() != expected_sha256:
        reject()
    assets[name] = content
    hashes[name] = expected_sha256
local_bytes = {}
for name in ('localImpl', 'localTests'):
    item = payload.get(name)
    if item is None:
        local_bytes[name] = None
        continue
    if not isinstance(item, dict) or set(item) != {'content', 'sha256'}:
        reject()
    try:
        content = base64.b64decode(item.get('content'), validate=True)
    except Exception:
        reject()
    expected_sha256 = item.get('sha256')
    if not isinstance(expected_sha256, str) or hashlib.sha256(content).hexdigest() != expected_sha256:
        reject()
    local_bytes[name] = content
scope = {
    '__name__': '__main__',
    '__file__': 'harness-notion-automation-remote.py',
    'EMBEDDED_ASSETS': assets,
    'EMBEDDED_ASSET_HASHES': hashes,
    'ORCHESTRATION_COMMIT': payload.get('orchestrationCommit'),
    'RUNNER_SHA256': runner_sha256,
    'LOCAL_IMPL_BYTES': local_bytes.get('localImpl'),
    'LOCAL_TESTS_BYTES': local_bytes.get('localTests'),
}
exec(compile(runner, 'harness-notion-automation-remote.py', 'exec'), scope)
`

const remoteHarnessNotionStatusLoader = `
import base64, hashlib, sys

def reject():
    raise SystemExit(6)

if len(sys.argv) != 3:
    reject()
commit, expected_sha256 = sys.argv[1:]
try:
    encoded = sys.stdin.buffer.read(1024 * 1024 + 1)
    if not encoded or len(encoded) > 1024 * 1024:
        reject()
    source = base64.b64decode(encoded, validate=True)
except Exception:
    reject()
if hashlib.sha256(source).hexdigest() != expected_sha256:
    reject()
sys.argv = [
    'harness-notion-automation-status.py',
    '--state-root', '/home/herman/.local/share/dsh-container',
    '--dsh-home', '/home/herman/.dsh',
    '--docker', '/usr/bin/docker',
    '--owner-uid', '1000',
    '--owner-gid', '1000',
    '--source-commit', commit,
    '--source-sha256', expected_sha256,
]
exec(compile(source, 'harness-notion-automation-status.py', 'exec'), {
    '__name__': '__main__',
    '__file__': 'harness-notion-automation-status.py',
})
`

function parseHarnessNotionStatusReceipt(text, expected) {
  let receipt
  try { receipt = JSON.parse(text) } catch {
    fail('Harness Notion automation 生产状态不可确认', exitCodes.production)
  }
  const statusSource = receipt?.statusSource
  const targetStatus = receipt?.target
  const harnessTasks = receipt?.harnessTasks
  const resources = receipt?.oneShotResources
  const release = receipt?.release
  const containers = receipt?.containers
  const sha256 = /^sha256:[0-9a-f]{64}$/u
  const commit = /^[0-9a-f]{40}$/u
  const containerKeys = [
    'name', 'imageMatchesAccepted', 'composeLabelsMatch', 'running', 'status',
    'exitCode', 'oomKilled', 'dead', 'restarting', 'restartCount', 'health',
  ]
  const expectedContainers = {
    web: ['dsh-web', true, 'running', 'healthy'],
    telegram: ['dsh-telegram', true, 'running', 'none'],
    lan: ['dsh-lan-proxy', true, 'running', 'none'],
    prepare: ['dsh-prepare', false, 'exited', 'none'],
  }
  const validTarget = hasExactKeys(targetStatus, ['presence', 'type'])
    && ((targetStatus.presence === 'absent' && targetStatus.type === 'absent')
      || (targetStatus.presence === 'present' && targetStatus.type === 'directory'))
  const validRelease = hasExactKeys(release, [
    'currentEqualsLastGood', 'releaseId', 'engineImageId', 'imageTag',
    'pluginsCommit', 'releaseToolCommit', 'harnessCommit', 'harnessPatchSha256',
  ])
    && release.currentEqualsLastGood === true
    && /^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/u.test(release.releaseId ?? '')
    && sha256.test(release.engineImageId ?? '')
    && /^[0-9A-Za-z][0-9A-Za-z._/:+-]{0,255}$/u.test(release.imageTag ?? '')
    && commit.test(release.pluginsCommit ?? '')
    && commit.test(release.releaseToolCommit ?? '')
    && release.harnessCommit === 'b150a551b8d465e31e418e1b2eaf5e79bbb7d28e'
    && release.harnessPatchSha256 === 'sha256:1c8e1b65538f4ca50138f61503e05c14515884ed84a0c906fdc95c2d83784e97'
  const validContainers = hasExactKeys(containers, Object.keys(expectedContainers))
    && Object.entries(expectedContainers).every(([role, values]) => {
      const value = containers[role]
      const [name, running, status, health] = values
      return hasExactKeys(value, containerKeys)
        && value.name === name
        && value.imageMatchesAccepted === true
        && value.composeLabelsMatch === true
        && value.running === running
        && value.status === status
        && value.exitCode === 0
        && value.oomKilled === false
        && value.dead === false
        && value.restarting === false
        && value.restartCount === 0
        && value.health === health
    })
  if (!hasExactKeys(receipt, [
    'schemaVersion', 'status', 'statusSource', 'target', 'harnessTasks',
    'oneShotResources', 'release', 'containers',
  ])
    || receipt.schemaVersion !== 1
    || receipt.status !== 'accepted-production-boundary'
    || !hasExactKeys(statusSource, ['commit', 'sha256'])
    || statusSource.commit !== expected.commit
    || statusSource.sha256 !== `sha256:${expected.sha256}`
    || !validTarget
    || !hasExactKeys(harnessTasks, ['childCount'])
    || harnessTasks.childCount !== 0
    || !hasExactKeys(resources, ['ownerLabel', 'containerCount', 'networkCount'])
    || resources.ownerLabel !== 'io.dsh.owner=harness-notion-automation'
    || resources.containerCount !== 0
    || resources.networkCount !== 0
    || !validRelease
    || !validContainers) {
    fail('Harness Notion automation 生产状态不可确认', exitCodes.production)
  }
  return receipt
}

function parseHarnessNotionReceipt(text, expected) {
  let receipt
  try { receipt = JSON.parse(text) } catch { fail('Harness Notion automation 未返回有效脱敏 JSON 回执', exitCodes.production) }
  const required = [
    'status', 'owner', 'path', 'handoffPath', 'interfaceVersion', 'size', 'sha256',
    'handoffSha256', 'testReceiptSha256', 'probeSha256', 'testedAt', 'testsPassed',
    'releaseId', 'imageId', 'harnessCommit', 'harnessPatchSha256',
    'acceptedReleaseToolCommit', 'orchestrationCommit', 'orchestrationSha256',
    'promptSha256', 'targetParentIdentitySha256', 'siblingInspection', 'executedNow',
    'evidenceSource', 'network',
  ]
  if (!hasExactKeys(receipt, required)
    || receipt.status !== 'installed'
    || receipt.owner !== 'live-harness-workspace'
    || receipt.path !== 'workspace/automations/notion/notion_inbox_sync.py'
    || receipt.handoffPath !== 'workspace/automations/notion/notion_inbox_sync.handoff.json'
    || receipt.interfaceVersion !== 1
    || !Number.isSafeInteger(receipt.size) || receipt.size < 1 || receipt.size > 1024 * 1024
    || !/^[0-9a-f]{64}$/u.test(receipt.sha256 ?? '')
    || !/^[0-9a-f]{64}$/u.test(receipt.handoffSha256 ?? '')
    || !/^[0-9a-f]{64}$/u.test(receipt.testReceiptSha256 ?? '')
    || receipt.probeSha256 !== expected.probeSha256
    || typeof receipt.testedAt !== 'string' || !Number.isFinite(Date.parse(receipt.testedAt))
    || receipt.testsPassed !== 12
    || !/^[0-9A-Za-z._-]+$/u.test(receipt.releaseId ?? '')
    || !/^sha256:[0-9a-f]{64}$/u.test(receipt.imageId ?? '')
    || receipt.harnessCommit !== 'b150a551b8d465e31e418e1b2eaf5e79bbb7d28e'
    || receipt.harnessPatchSha256 !== 'sha256:1c8e1b65538f4ca50138f61503e05c14515884ed84a0c906fdc95c2d83784e97'
    || !/^[0-9a-f]{40}$/u.test(receipt.acceptedReleaseToolCommit ?? '')
    || receipt.orchestrationCommit !== expected.orchestrationCommit
    || !hasExactKeys(receipt.orchestrationSha256, [
      'runner', 'bridge', 'lockdownPatch', 'prompt', 'checker', 'probe',
    ])
    || Object.entries(expected.orchestrationSha256).some(
      ([name, value]) => receipt.orchestrationSha256[name] !== value,
    )
    || receipt.promptSha256 !== expected.promptSha256
    || !/^[0-9a-f]{64}$/u.test(receipt.targetParentIdentitySha256 ?? '')
    || receipt.siblingInspection !== 'not-performed-private-boundary'
    || receipt.executedNow !== true
    || receipt.evidenceSource !== 'this-invocation-trusted-probe'
    || receipt.network !== 'none-local-authoring') {
    fail('Harness Notion automation 回执不符合 create-only 生产合同', exitCodes.production)
  }
  return receipt
}

function commandHarness(options, tokens) {
  const optionNames = Object.keys(options).filter(name => name !== '_').sort()
  const preview = tokens.length === 1 && tokens[0] === 'notion-automation'
  const approved = tokens.length === 2
    && tokens[0] === 'notion-automation'
    && tokens[1] === '--approved'
  const status = tokens.length === 2
    && tokens[0] === 'notion-automation'
    && tokens[1] === '--status'
  if (!preview && !approved && !status) {
    fail('用法: dsh harness notion-automation [--approved|--status]', exitCodes.usage)
  }
  if (preview) {
    if (optionNames.length !== 0) fail('未批准预览不接受其他参数', exitCodes.usage)
    out({
      status: 'waiting-for-harness-notion-automation-authorization',
      target: `${target}:/home/herman/.dsh/workspace/automations/notion`,
      preimage: 'must-be-absent-create-only',
      execution: 'accepted-immutable-image-one-shot-local-authoring',
      network: 'none-local-authoring',
      productionWrite: false,
      next: './release/dsh harness notion-automation --approved',
    })
    process.exitCode = exitCodes.approval
    return
  }
  if (status) {
    if (!options.status || optionNames.length !== 1 || optionNames[0] !== 'status') {
      fail('只读状态必须准确使用 dsh harness notion-automation --status', exitCodes.usage)
    }
    if (target !== 'herman.hermes') {
      fail('Harness Notion automation 状态只允许读取 herman.hermes', exitCodes.safety)
    }
    const sourceCommit = run('git', ['-C', repoRoot, 'rev-parse', '--verify', 'HEAD^{commit}'], {
      capture: true,
      announce: false,
      code: exitCodes.safety,
    })
    if (!/^[0-9a-f]{40}$/u.test(sourceCommit)) {
      fail('Harness Notion automation 状态工具 commit 无效', exitCodes.safety)
    }
    const source = readGitBlob(
      sourceCommit,
      'release/scripts/harness-notion-automation-status.py',
      'Harness Notion automation read-only status helper',
    )
    const sourceSha256 = createHash('sha256').update(source).digest('hex')
    const output = runRemoteReadOnlyStatus(
      'python3',
      ['-c', remoteHarnessNotionStatusLoader, sourceCommit, sourceSha256],
      source.toString('base64'),
    )
    out(parseHarnessNotionStatusReceipt(output, { commit: sourceCommit, sha256: sourceSha256 }))
    return
  }
  if (!options.approved || optionNames.length !== 1 || optionNames[0] !== 'approved') {
    fail('批准执行必须准确使用 dsh harness notion-automation --approved', exitCodes.usage)
  }
  if (target !== 'herman.hermes') {
    fail('Harness Notion automation 只获准在 herman.hermes 执行', exitCodes.safety)
  }

  const releaseCommit = requireCurrentHeadReleaseTree('Harness Notion automation 编排')
  requireLatestMainAncestor(releaseCommit, 'Harness Notion automation 编排 commit')
  const runner = readGitBlob(
    releaseCommit,
    'release/scripts/harness-notion-automation-remote.py',
    'Harness Notion automation remote helper',
  )
  const assets = Object.fromEntries(Object.entries(harnessNotionOrchestrationAssets).map(([name, path]) => {
    const content = readGitBlob(releaseCommit, path, `Harness Notion automation ${name}`)
    return [name, {
      content: content.toString('base64'),
      sha256: createHash('sha256').update(content).digest('hex'),
    }]
  }))
  const localPayload = {}
  for (const [name, path] of Object.entries(harnessNotionLocalAssets)) {
    const content = readGitBlob(releaseCommit, path, `Harness Notion automation ${name}`)
    localPayload[name] = {
      content: content.toString('base64'),
      sha256: createHash('sha256').update(content).digest('hex'),
    }
  }
  const payload = {
    runner: runner.toString('base64'),
    runnerSha256: createHash('sha256').update(runner).digest('hex'),
    orchestrationCommit: releaseCommit,
    assets,
    ...localPayload,
  }
  const output = runRemoteCommand('python3', ['-c', remoteHarnessNotionLoader], {
    input: `${JSON.stringify(payload)}\n`,
    code: exitCodes.production,
  })
  out(parseHarnessNotionReceipt(output, {
    orchestrationCommit: releaseCommit,
    orchestrationSha256: {
      runner: payload.runnerSha256,
      bridge: assets.bridge.sha256,
      lockdownPatch: assets.patch.sha256,
      prompt: assets.prompt.sha256,
      checker: assets.checker.sha256,
      probe: assets.probe.sha256,
    },
    probeSha256: assets.probe.sha256,
    promptSha256: assets.prompt.sha256,
  }))
}

function commandCredential(options) {
  const optionNames = Object.keys(options).filter(name => name !== '_').sort()
  if (options._.length !== 1 || options._[0] !== 'notion') {
    fail('用法: dsh credential notion [--stdin --approved [--replace]]', exitCodes.usage)
  }
  if (!options.approved) {
    if (optionNames.length !== 0) {
      fail('未批准时只允许执行 dsh credential notion 查看影响', exitCodes.usage)
    }
    out({
      status: 'waiting-for-production-credential-authorization',
      target: `${target}:${notionCredentialTarget}`,
      impact: '只读验证固定 Notion 任务页；成功后以 0700 目录、0600 文件原子安装生产 DSH token',
      next: './release/dsh credential notion --stdin --approved；替换不同 token 时另加 --replace',
    })
    process.exitCode = exitCodes.approval
    return
  }
  const allowed = new Set(options.replace ? ['approved', 'replace', 'stdin'] : ['approved', 'stdin'])
  if (!options.stdin || optionNames.length !== allowed.size || optionNames.some(name => !allowed.has(name))) {
    fail('批准写入必须准确使用 --stdin --approved，可选 --replace', exitCodes.usage)
  }
  if (target !== 'herman.hermes') {
    fail('Notion production credential 只获准在 herman.hermes 安装', exitCodes.safety)
  }
  const credentialReleaseCommit = requireCurrentHeadReleaseTree('生产 credential 编排')
  requireLatestMainAncestor(credentialReleaseCommit, '生产 credential 编排 commit')
  if (process.stdin.isTTY) fail('Notion token 必须通过非交互 stdin 提供', exitCodes.usage)
  const token = readFileSync(0)
  if (token.length === 0 || token.length > 64 * 1024 + 1) {
    fail('Notion token stdin 长度无效', exitCodes.usage)
  }
  const config = productionNotionConfig(credentialReleaseCommit)
  const helper = readGitBlob(
    credentialReleaseCommit,
    'release/scripts/notion-credential-remote.py',
    '生产 Notion credential remote helper',
  )
  const publicArgs = [
    '--target', config.credentialPath,
    '--api-base', config.apiBase,
    '--page-id', config.pageId,
    '--api-version', config.apiVersion,
    '--owner-uid', '1000',
    '--owner-gid', '1000',
    '--state-root', '/home/herman/.local/share/dsh-container',
    '--docker', '/usr/bin/docker',
    ...(options.replace ? ['--replace'] : []),
  ]
  const input = Buffer.concat([Buffer.from(`${helper.toString('base64')}\n`), token])
  const output = runRemoteCommand('python3', ['-c', remoteCredentialLoader, ...publicArgs], {
    input,
    code: exitCodes.production,
  })
  out(parseNotionReceipt(output, 'Notion 凭据安装'))
}

function parseOptions(tokens) {
  const options = { _: [] }
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token.startsWith('--')) { options._.push(token); continue }
    if (token.includes('=')) fail('参数格式无效；不接受 --name=value', exitCodes.usage)
    const key = token.slice(2)
    if (!key || Object.hasOwn(options, key)) fail('参数重复或无效', exitCodes.usage)
    if (['approved-stop', 'approved-release', 'approved', 'status', 'synthetic', 'reset', 'stdin', 'replace'].includes(key)) { options[key] = true; continue }
    const value = tokens[index + 1]
    if (value === undefined || value.startsWith('--')) fail('参数缺少值', exitCodes.usage)
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

function requireExactReleaseTree(commit, label = 'release orchestration') {
  requireFullCommit(repoRoot, commit, `${label} commit`)
  const comparisonRoot = mkdtempSync(join(tmpdir(), 'dsh-release-tree-'))
  const archivePath = join(comparisonRoot, 'release.tar')
  try {
    run('git', ['-C', repoRoot, 'archive', '--format=tar', `--output=${archivePath}`, commit, 'release'], {
      announce: false,
      code: exitCodes.safety,
    })
    run('tar', ['-xf', archivePath, '-C', comparisonRoot], { announce: false, code: exitCodes.safety })
    if (sha256Tree(join(comparisonRoot, 'release')) !== sha256Tree(releaseRoot)) {
      fail(`${label} 字节与绑定 commit ${commit} 不一致`, exitCodes.safety)
    }
  } finally {
    rmSync(comparisonRoot, { recursive: true, force: true })
  }
  return commit
}

function requireCurrentHeadReleaseTree(label) {
  const head = run('git', ['-C', repoRoot, 'rev-parse', '--verify', 'HEAD^{commit}'], {
    capture: true,
    announce: false,
    code: exitCodes.safety,
  })
  return requireExactReleaseTree(head, label)
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

function verifyDevelopmentTestReceipt(candidate) {
  for (const field of ['testReceiptPath', 'testReceiptSha256']) {
    if (!candidate[field]) fail(`开发底座缺少 ${field}`, exitCodes.safety)
  }
  if (!existsSync(candidate.testReceiptPath)) fail(`开发底座镜像测试回执不存在: ${candidate.testReceiptPath}`, exitCodes.safety)
  if (sha256File(candidate.testReceiptPath) !== candidate.testReceiptSha256) {
    fail('开发底座镜像测试回执摘要不匹配', exitCodes.safety)
  }
  const receipt = readJson(candidate.testReceiptPath, 'development image test receipt')
  if (receipt.schemaVersion !== 1) fail('开发底座镜像测试回执版本不匹配', exitCodes.safety)
  if (receipt.imageId !== candidate.imageId) {
    fail(`开发底座镜像测试回执身份不匹配: ${receipt.imageId ?? 'missing'} != ${candidate.imageId}`, exitCodes.safety)
  }
  return receipt
}

function requireRegularCandidateArtifact(path, label) {
  let entry
  try {
    entry = lstatSync(path)
  } catch {
    fail(`${label} 不存在: ${path}`, exitCodes.safety)
  }
  if (!entry.isFile() || entry.isSymbolicLink()) {
    fail(`${label} 不是普通文件: ${path}`, exitCodes.safety)
  }
}

function verifyFormalCandidateArtifacts(candidate) {
  requireRegularCandidateArtifact(candidate.archivePath, '正式 candidate 镜像归档')
  if (sha256File(candidate.archivePath) !== candidate.archiveSha256) {
    fail('candidate 镜像归档摘要不匹配', exitCodes.safety)
  }
  requireRegularCandidateArtifact(candidate.composePath, '正式 candidate Compose')
  if (sha256File(candidate.composePath) !== candidate.composeSha256) {
    fail('正式 candidate Compose 摘要不匹配', exitCodes.safety)
  }
  requireRegularCandidateArtifact(candidate.testReceiptPath, '正式 candidate 镜像测试回执')
  if (sha256File(candidate.testReceiptPath) !== candidate.testReceiptSha256) {
    fail('正式 candidate 镜像测试回执摘要不匹配', exitCodes.safety)
  }
  const receipt = readJson(candidate.testReceiptPath, 'formal image test receipt')
  const required = ['schemaVersion', 'imageId', 'startedAt', 'completedAt', 'output']
  if (Object.keys(receipt ?? {}).sort().join('\0') !== required.sort().join('\0')
    || receipt.schemaVersion !== 1
    || receipt.imageId !== candidate.imageId
    || typeof receipt.startedAt !== 'string' || !Number.isFinite(Date.parse(receipt.startedAt))
    || typeof receipt.completedAt !== 'string' || !Number.isFinite(Date.parse(receipt.completedAt))
    || typeof receipt.output !== 'string') {
    fail('正式 candidate 镜像测试回执未精确绑定候选镜像', exitCodes.safety)
  }
  return receipt
}

function candidateFrom(value, { verifyDevelopmentImage = true } = {}) {
  const path = value ? resolve(value) : join(stateRoot, 'candidates/latest.json')
  requireRegularCandidateArtifact(path, 'candidate.json')
  const candidate = readJson(path, 'candidate')
  for (const field of ['imageId', 'imageTag', 'pluginsCommit', 'releaseToolCommit', 'harnessCommit']) {
    if (!candidate[field]) fail(`candidate 缺少 ${field}`, exitCodes.usage)
  }
  if (candidate.status !== 'tested') fail(`candidate 尚未通过镜像测试，当前状态是 ${candidate.status ?? 'missing'}`, exitCodes.safety)
  const purpose = candidatePurpose(candidate)
  if (purpose === 'development') {
    if (candidate.schemaVersion !== 2 || Object.hasOwn(candidate, 'workspaceMigration')) {
      fail('development candidate schema 必须为 v2 且不得声明生产 workspace migration', exitCodes.safety)
    }
    verifyDevelopmentTestReceipt(candidate)
    if (verifyDevelopmentImage) verifyDevelopmentCandidateImage(candidate)
    return { candidate, path }
  }
  validateFormalCandidateSchema(candidate, '正式 candidate')
  verifyFormalCandidateArtifacts(candidate)
  const manifestText = run('tar', ['-xOf', candidate.archivePath, 'manifest.json'], { capture: true, announce: false, code: exitCodes.safety })
  let archiveEntries
  try {
    archiveEntries = JSON.parse(manifestText).map(({ Config, RepoTags = [] }) => ({
      configPath: Config,
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
  let archiveConfig
  try {
    archiveConfig = JSON.parse(run('tar', ['-xOf', candidate.archivePath, archiveEntry.configPath], {
      capture: true,
      announce: false,
      code: exitCodes.safety,
    }))
  } catch (error) {
    fail(`无法读取 candidate 镜像配置标签: ${error.message}`, exitCodes.safety)
  }
  validateCandidateImageLabels(archiveConfig?.config?.Labels, candidate, 'candidate archive')
  return { candidate, path }
}

function imageId(name) {
  return run(engine, ['image', 'inspect', name, '--format', '{{.Id}}'], { capture: true, code: exitCodes.safety })
}

function staleFormalBuildRoots(buildRoot) {
  const buildsRoot = join(stateRoot, 'builds')
  if (!existsSync(buildsRoot)) return []
  const buildName = /^\d{8}T\d{9}Z-[0-9a-f]{12}$/u
  return readdirSync(buildsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && buildName.test(entry.name))
    .map((entry) => join(buildsRoot, entry.name))
    .filter((path) => path !== buildRoot
      && ['harness.tar', 'plugins.tar', 'release-system.tar', 'context'].every((name) => existsSync(join(path, name))))
}

const formalBuildName = /^\d{8}T\d{9}Z-[0-9a-f]{12}$/u

function recordedStaleFormalBuildIds() {
  const candidatesRoot = join(stateRoot, 'candidates')
  if (!existsSync(candidatesRoot)) return []
  const recorded = new Set()
  for (const entry of readdirSync(candidatesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const path = join(candidatesRoot, entry.name, 'candidate.json')
    if (!existsSync(path)) continue
  try {
      const candidate = readJson(path, 'formal candidate cleanup receipt')
      const cleanup = candidate.archiveRoundTripCleanup
      if (candidate.candidateId !== entry.name
        || candidate.status !== 'tested'
        || candidatePurpose(candidate) !== 'release'
        || !Array.isArray(cleanup?.removedExternalContainers)
        || cleanup.removedExternalContainers.length === 0
        || !cleanup.removedExternalContainers.every((id) => /^[0-9a-f]{64}$/u.test(id))) continue
      const evidenceIds = [
        ...(Array.isArray(cleanup.removedStaleBuildRoots) ? cleanup.removedStaleBuildRoots : []),
        ...(Array.isArray(cleanup.staleBuildEvidenceIds) ? cleanup.staleBuildEvidenceIds : []),
      ]
      if (!evidenceIds.every((id) => formalBuildName.test(id))) continue
      for (const id of evidenceIds) recorded.add(id)
    } catch {}
  }
  return [...recorded]
}

function formalBuildStartedAt(buildId) {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z-[0-9a-f]{12}$/u.exec(buildId)
  if (match === null) return null
  const [, year, month, day, hour, minute, second, millisecond] = match
  return Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), Number(millisecond))
}

function externalCreatedAt(value) {
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?\s*(Z|[+-]\d{2}:?\d{2})(?:\s+UTC)?$/u.exec(value?.trim() ?? '')
  if (match === null) return null
  const [, date, time, fraction = '', zone] = match
  const millisecond = `${fraction}000`.slice(0, 3)
  const normalizedZone = zone === 'Z' ? zone : `${zone.slice(0, 3)}:${zone.slice(-2)}`
  const parsed = Date.parse(`${date}T${time}.${millisecond}${normalizedZone}`)
  return Number.isFinite(parsed) ? parsed : null
}

function matchingStaleBuildId(createdAt, buildIds) {
  const created = externalCreatedAt(createdAt)
  if (created === null) return null
  const maximumBuildDurationMs = 30 * 60 * 1000
  return buildIds.find((buildId) => {
    const started = formalBuildStartedAt(buildId)
    return started !== null && created >= started && created < started + maximumBuildDurationMs
  }) ?? null
}

function removeFormalImageForArchiveRoundTrip({ imageTag, buildRoot }) {
  const staleBuildRoots = staleFormalBuildRoots(buildRoot)
  const staleBuildIds = [...new Set([
    ...staleBuildRoots.map((path) => basename(path)),
    ...recordedStaleFormalBuildIds(),
  ])]
  const removedExternalContainers = []
  const staleBuildEvidenceIds = new Set()

  for (let attempt = 0; attempt < 16; attempt += 1) {
    process.stderr.write(`+ ${commandText(engine, ['image', 'rm', imageTag])}\n`)
    const removal = runStatus(engine, ['image', 'rm', imageTag])
    let imageRemoved = removal.status === 0
    if (!imageRemoved && removedExternalContainers.length > 0) {
      process.stderr.write(`+ ${commandText(engine, ['image', 'inspect', imageTag])}\n`)
      const inspection = runStatus(engine, ['image', 'inspect', imageTag])
      const missingDetail = `${String(removal.stderr ?? '')}\n${String(inspection.stderr ?? '')}`
      imageRemoved = inspection.status !== 0 && /(image not known|no such image|image .* not found)/iu.test(missingDetail)
    }
    if (imageRemoved) {
      if (removedExternalContainers.length > 0) {
        for (const path of staleBuildRoots) removeControlledPath(join(stateRoot, 'builds'), path)
      }
      return {
        removedExternalContainers,
        removedStaleBuildRoots: removedExternalContainers.length > 0 ? staleBuildRoots.map((path) => basename(path)) : [],
        staleBuildEvidenceIds: [...staleBuildEvidenceIds],
      }
    }

    const detail = String(removal.stderr ?? '').trim()
    if (basename(engine) !== 'podman' || staleBuildIds.length === 0) {
      fail(`${engine} 退出码 ${removal.status}${detail ? `\n${detail}` : ''}`, exitCodes.test)
    }
    const blockerMatch = /image used by ([0-9a-f]{12,64})\b/u.exec(detail)
    if (blockerMatch === null) {
      fail(`无法确认镜像删除失败来自中断构建残留\n${detail}`, exitCodes.test)
    }
    const blockerId = blockerMatch[1]
    if (removedExternalContainers.some((id) => id.startsWith(blockerId))) {
      fail(`清理外部构建残留后镜像仍被同一容器占用: ${blockerId}`, exitCodes.test)
    }

    const external = run(engine, [
      'ps', '--all', '--external', '--no-trunc',
      '--filter', `id=${blockerId}`,
      '--format', '{{.ID}}\t{{.ImageID}}\t{{.Command}}\t{{.Status}}\t{{.CreatedAt}}',
    ], { capture: true, code: exitCodes.test })
    const records = external.split('\n').filter(Boolean).map((line) => {
      const [id, image, command, status, createdAt, ...unexpected] = line.split('\t')
      return { id, image, command, status, createdAt, unexpected }
    })
    const record = records.find(({ id }) => id?.startsWith(blockerId))
    if (records.length !== 1 || record === undefined || record.unexpected.length > 0
      || !/^(sha256:)?[0-9a-f]{64}$/u.test(record.image ?? '')
      || record.status?.trim().toLowerCase() !== 'storage'
      || !['buildah', 'storage'].some((kind) => record.command?.toLowerCase().includes(kind))) {
      fail(`占用镜像的容器不是可确认的 Buildah 外部存储残留: ${blockerId}`, exitCodes.test)
    }

    const staleBuildId = matchingStaleBuildId(record.createdAt, staleBuildIds)
    if (staleBuildId === null) {
      fail(`Buildah 外部存储残留的创建时间不属于已确认的中断正式构建: ${blockerId}`, exitCodes.test)
    }

    process.stderr.write(`检测到中断正式构建 ${staleBuildId} 的残留；仅清理外部 Buildah 存储残留 ${record.id}\n`)
    run(engine, ['rm', '--force', record.id], { capture: true, code: exitCodes.test })
    removedExternalContainers.push(record.id)
    staleBuildEvidenceIds.add(staleBuildId)
  }

  fail('外部构建残留超过安全清理上限，拒绝继续归档', exitCodes.test)
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
    fakeNotion: runtime.fakeNotion ?? `dsh-dev-${runtime.key.slice(0, 12)}-fake-notion`,
  }
}

function legacyDevelopmentRuntime() {
  return {
    schemaVersion: 1,
    legacy: true,
    network: 'dsh-dev-internal',
    fakeTelegram: 'dsh-dev-fake-telegram',
    fakeNotion: 'dsh-dev-fake-notion',
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
      fakeNotion: `dsh-dev-${suffix}-fake-notion`,
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
  for (const name of [runtime.toolbox, runtime.telegram, runtime.fakeTelegram, runtime.fakeNotion, runtime.web]) {
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
  try {
    verifyDevelopmentTestReceipt(candidate)
    return true
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
    candidate.status = 'retired'
    candidate.retiredAt = candidate.retiredAt ?? new Date().toISOString()
    candidate.retiredReason = 'superseded-development-base'
    writeJson(path, candidate)
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
      candidate.status = 'retired'
      candidate.retiredAt = candidate.retiredAt ?? new Date().toISOString()
      candidate.retiredReason = 'accepted-production-release'
      writeJson(candidatePath, candidate)
      cleaned.push(candidate.candidateId)
    }
  }
  return {
    result: 'accepted-release-invalidated-development',
    cleanedCandidateIds: cleaned,
    keptReferencedCandidateIds: kept,
    candidateAndTestReceipts: 'preserved',
    invalidatedSourcePaths,
    sourceWorktrees: 'preserved',
  }
}

function normalizedImageId(value) {
  return String(value ?? '').replace(/^sha256:/u, '')
}

function sameImageId(left, right) {
  return normalizedImageId(left) !== '' && normalizedImageId(left) === normalizedImageId(right)
}

function cleanupObjectKey(value) {
  return `${value.kind}:${value.path ?? value.imageId ?? value.id ?? ''}`
}

function pushUniqueCleanupObject(values, value) {
  const key = cleanupObjectKey(value)
  if (!values.some((existing) => cleanupObjectKey(existing) === key)) values.push(value)
}

function cleanupError(cleanup, scope, code, object, message) {
  cleanup.errors.push({ scope, code, object, message })
}

function cleanupAttempt(release) {
  return {
    status: 'incomplete',
    protected: [],
    local: { deleted: [], kept: [], bytes: { before: 0, after: 0, reclaimed: 0 } },
    remote: { deleted: [], kept: [], bytes: { before: 0, after: 0, reclaimed: 0 } },
    errors: [],
    completedAt: null,
    releaseId: release.releaseId,
    candidateId: release.candidate?.candidateId ?? null,
  }
}

function finishCleanupAttempt(cleanup) {
  for (const scopeName of ['local', 'remote']) {
    const scope = cleanup[scopeName]
    const before = new Map()
    const after = new Map()
    for (const value of [...scope.deleted, ...scope.kept]) {
      const key = cleanupObjectKey(value)
      before.set(key, Math.max(before.get(key) ?? 0, Number(value.bytes ?? 0)))
    }
    for (const value of scope.kept) {
      const key = cleanupObjectKey(value)
      after.set(key, Math.max(after.get(key) ?? 0, Number(value.bytes ?? 0)))
    }
    scope.bytes.before = [...before.values()].reduce((sum, value) => sum + value, 0)
    scope.bytes.after = [...after.values()].reduce((sum, value) => sum + value, 0)
    scope.bytes.reclaimed = Math.max(0, scope.bytes.before - scope.bytes.after)
  }
  cleanup.status = cleanup.errors.length === 0 ? 'complete' : 'incomplete'
  cleanup.completedAt = new Date().toISOString()
  return cleanup
}

function filesRecursively(root, predicate) {
  if (!existsSync(root)) return []
  const found = []
  const visit = (directory) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name)
      const entry = lstatSync(path)
      if (entry.isDirectory() && !entry.isSymbolicLink()) visit(path)
      else if (entry.isFile() && predicate(path)) found.push(path)
    }
  }
  visit(root)
  return found.sort()
}

function requiredCandidateMetadata(candidate, candidatePath, expected = null, { allowLegacyV2 = false } = {}) {
  const candidatesRoot = join(stateRoot, 'candidates')
  const resolvedPath = resolve(candidatePath)
  const candidateDir = dirname(resolvedPath)
  if (!controlledChild(candidatesRoot, candidateDir) || basename(resolvedPath) !== 'candidate.json') {
    throw new Error(`candidate 不在受控目录: ${candidatePath}`)
  }
  if (!existsSync(candidateDir) || !lstatSync(candidateDir).isDirectory() || lstatSync(candidateDir).isSymbolicLink()) {
    throw new Error('candidate 目录不是受控普通目录')
  }
  if (!existsSync(resolvedPath) || !lstatSync(resolvedPath).isFile() || lstatSync(resolvedPath).isSymbolicLink()) {
    throw new Error('candidate.json 不是受控普通文件')
  }
  const legacyV2 = allowLegacyV2 && candidate.schemaVersion === 2
  const identityFields = [
    'candidateId', 'imageId', 'imageTag', 'archivePath', 'archiveSha256',
    ...(legacyV2 ? [] : ['composePath', 'composeSha256']),
    'testReceiptPath', 'testReceiptSha256',
  ]
  for (const field of identityFields) {
    if (!candidate?.[field]) throw new Error(`candidate 缺少 ${field}`)
  }
  if (legacyV2) validateLegacyFormalCandidateSchema(candidate, 'required candidate')
  else validateFormalCandidateSchema(candidate, 'required candidate')
  if (candidatePurpose(candidate) !== 'release') throw new Error(`candidate 用途不是 release: ${candidatePurpose(candidate)}`)
  if (candidate.candidateId !== basename(candidateDir)) throw new Error('candidateId 与受控目录不一致')
  if (!/^(?:sha256:)?[0-9a-f]{64}$/u.test(candidate.imageId)) throw new Error('candidate imageId 不是完整镜像 ID')
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*:[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(candidate.imageTag)) throw new Error('candidate imageTag 不是受控精确标签')
  if (!/^sha256:[0-9a-f]{64}$/u.test(candidate.archiveSha256)
    || (!legacyV2 && !/^sha256:[0-9a-f]{64}$/u.test(candidate.composeSha256))
    || !/^sha256:[0-9a-f]{64}$/u.test(candidate.testReceiptSha256)) {
    throw new Error('candidate 归档、Compose 或测试回执摘要格式不完整')
  }
  if (resolve(candidate.archivePath) !== join(candidateDir, 'image.tar')) throw new Error('candidate archivePath 不是候选目录内的 image.tar')
  if (!legacyV2 && resolve(candidate.composePath) !== join(candidateDir, 'compose.production.yml')) throw new Error('candidate composePath 不是候选目录内的 compose.production.yml')
  if (resolve(candidate.testReceiptPath) !== join(candidateDir, 'image-tests.json')) throw new Error('candidate testReceiptPath 不是候选目录内的 image-tests.json')
  if (expected) {
    for (const field of ['candidateId', 'imageId', 'imageTag', 'archiveSha256', ...(legacyV2 ? [] : ['composeSha256']), 'testReceiptSha256']) {
      if (candidate[field] !== expected[field]) throw new Error(`candidate ${field} 与 release.json 不一致`)
    }
    if (candidate.schemaVersion === 3) {
      validateWorkspaceMigration(expected.workspaceMigration, 'release candidate.workspaceMigration')
      if (JSON.stringify(candidate.workspaceMigration) !== JSON.stringify(expected.workspaceMigration)) {
        throw new Error('candidate workspaceMigration 与 release.json 不一致')
      }
    } else if (Object.hasOwn(expected, 'workspaceMigration')) {
      throw new Error('legacy candidate 与 release.json 的 workspaceMigration 边界不一致')
    }
  }
  return { candidate, candidatePath: resolvedPath, candidateDir }
}

function localImageInventory(imageTag) {
  const inspection = runStatus(engine, ['image', 'inspect', imageTag, '--format', '{{.Id}}|{{.Size}}'])
  if (inspection.status !== 0) return null
  const [id, sizeText = '0'] = String(inspection.stdout ?? '').trim().split('|')
  return { id, size: Number(sizeText) || 0 }
}

function localContainerImageIds() {
  const listed = runStatus(engine, ['ps', '--all', '--quiet'])
  if (listed.status !== 0) throw new Error(`无法列出本机容器: ${String(listed.stderr ?? '').trim()}`)
  const ids = String(listed.stdout ?? '').trim().split(/\s+/u).filter(Boolean)
  const images = new Set()
  for (const id of ids) {
    const inspected = runStatus(engine, ['inspect', id, '--format', '{{.Image}}'])
    if (inspected.status !== 0) throw new Error(`无法检查本机容器 ${id} 的镜像引用`)
    images.add(normalizedImageId(String(inspected.stdout ?? '').trim()))
  }
  return images
}

function collectRemoteCleanupInventory() {
  const remoteRoot = '/home/herman/.local/share/dsh-container'
  const text = ssh(`set -Eeuo pipefail
# DSH_ACCEPT_CLEANUP_INVENTORY_V1
python3 - <<'PY'
import hashlib
import json
import os
import re
import subprocess

root = '/home/herman/.local/share/dsh-container'
errors = []

def load_json(path, label):
    try:
        if not os.path.isfile(path) or os.path.islink(path):
            raise ValueError('not a regular file')
        with open(path, 'r', encoding='utf-8') as handle:
            return json.load(handle), None
    except Exception as error:
        return None, f'{label}: {error}'

def file_record(path, with_sha=False):
    if not os.path.isfile(path) or os.path.islink(path):
        return None
    value = {'path': os.path.realpath(path), 'bytes': os.path.getsize(path)}
    if with_sha:
        digest = hashlib.sha256()
        with open(path, 'rb') as handle:
            for chunk in iter(lambda: handle.read(8 * 1024 * 1024), b''):
                digest.update(chunk)
        value['sha256'] = 'sha256:' + digest.hexdigest()
    return value

def run(*args):
    return subprocess.run(args, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

def pointer(name):
    path = os.path.join(root, name)
    return os.path.realpath(path) if os.path.lexists(path) else None

releases = []
release_root = os.path.join(root, 'releases')
if os.path.isdir(release_root):
    for entry in sorted(os.scandir(release_root), key=lambda value: value.name):
        name = entry.name
        directory = entry.path
        if not entry.is_dir(follow_symlinks=False):
            continue
        release, release_error = load_json(os.path.join(directory, 'release.json'), f'release {name}')
        candidate, candidate_error = load_json(os.path.join(directory, 'candidate.json'), f'candidate {name}')
        releases.append({
            'name': name,
            'dir': os.path.realpath(directory),
            'release': release,
            'releaseError': release_error,
            'candidate': candidate,
            'candidateError': candidate_error,
            'archive': file_record(os.path.join(directory, 'image.tar')),
            'compose': file_record(os.path.join(directory, 'compose.production.yml')),
            'candidateFile': file_record(os.path.join(directory, 'candidate.json')),
        })

snapshot_root = os.path.join(root, 'snapshots')
latest, latest_error = load_json(os.path.join(snapshot_root, 'latest.json'), 'latest snapshot')
snapshot_archives = []
if os.path.isdir(snapshot_root):
    for directory, _, names in os.walk(snapshot_root):
        for name in sorted(names):
            if name.endswith('.tar.zst'):
                archive_path = os.path.join(directory, name)
                record = file_record(archive_path)
                if record is None:
                    continue
                metadata_path = os.path.join(directory, 'snapshot.json') if name == 'home.tar.zst' else archive_path[:-len('.tar.zst')] + '.json'
                metadata, metadata_error = load_json(metadata_path, f'snapshot {name}')
                record.update({'metadataPath': metadata_path, 'metadata': metadata, 'metadataError': metadata_error, 'metadataValid': False})
                expected_snapshot_id = os.path.basename(directory) if name == 'home.tar.zst' else name[:-len('.tar.zst')]
                if isinstance(metadata, dict) and metadata.get('snapshotId') == expected_snapshot_id and re.fullmatch(r'sha256:[0-9a-f]{64}', str(metadata.get('archiveSha256', ''))) and os.path.realpath(str(metadata.get('archivePath', ''))) == os.path.realpath(archive_path):
                    record['metadataValid'] = True
                elif metadata_error is None:
                    record['metadataError'] = 'snapshot metadata does not identify archive'
                snapshot_archives.append(record)

container_images = []
containers_complete = True
listed = run('docker', 'ps', '--all', '--quiet')
if listed.returncode != 0:
    containers_complete = False
    errors.append('docker containers: ' + listed.stderr.strip())
else:
    for container_id in listed.stdout.split():
        inspected = run('docker', 'inspect', container_id, '--format', '{{.Image}}')
        if inspected.returncode != 0:
            containers_complete = False
            errors.append(f'docker container {container_id}: ' + inspected.stderr.strip())
        else:
            container_images.append(inspected.stdout.strip())

tags = set()
for item in releases:
    for source in (item.get('candidate'), (item.get('release') or {}).get('candidate')):
        if isinstance(source, dict) and isinstance(source.get('imageTag'), str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._/-]*:[A-Za-z0-9][A-Za-z0-9._-]*', source['imageTag']):
            tags.add(source['imageTag'])
images = {}
for tag in sorted(tags):
    inspected = run('docker', 'image', 'inspect', tag, '--format', '{{.Id}}|{{.Size}}')
    if inspected.returncode == 0:
        parts = inspected.stdout.strip().split('|', 1)
        images[tag] = {'id': parts[0], 'size': int(parts[1]) if len(parts) == 2 and parts[1].isdigit() else 0}
    elif 'No such image' not in inspected.stderr and 'No such object' not in inspected.stderr:
        images[tag] = {'error': inspected.stderr.strip() or f'exit {inspected.returncode}'}

current_path = pointer('current')
last_good_path = pointer('last-good')
for item in releases:
    if item['dir'] == current_path and item.get('archive'):
        item['archive'] = file_record(item['archive']['path'], with_sha=True)

latest_archive = None
if isinstance(latest, dict) and isinstance(latest.get('archivePath'), str):
    requested = os.path.realpath(latest['archivePath'])
    snapshot_id = latest.get('snapshotId')
    expected = os.path.join(snapshot_root, f'{snapshot_id}.tar.zst') if isinstance(snapshot_id, str) else None
    if expected is not None and requested == expected and requested.startswith(snapshot_root + os.sep):
        latest_archive = file_record(requested, with_sha=True)

print(json.dumps({
    'root': root,
    'currentPath': current_path,
    'lastGoodPath': last_good_path,
    'releases': releases,
    'latestSnapshot': latest,
    'latestSnapshotError': latest_error,
    'latestSnapshotArchive': latest_archive,
    'snapshotArchives': [value for value in snapshot_archives if value],
    'containerImages': container_images,
    'containersComplete': containers_complete,
    'images': images,
    'errors': errors,
}, separators=(',', ':')))
PY
`)
  try { return JSON.parse(text) } catch (error) { throw new Error(`无法解析远端清理盘点: ${error.message}`) }
}

function remoteCleanupStatus(script) {
  return runStatus('ssh', ['-o', 'BatchMode=yes', target, 'bash', '-s'], { input: script })
}

function localSnapshotArchiveEvidence(path) {
  const suffix = '.tar.zst'
  const metadataPath = basename(path) === 'home.tar.zst'
    ? join(dirname(path), 'snapshot.json')
    : `${path.slice(0, -suffix.length)}.json`
  const record = { path, bytes: statSync(path).size, metadataPath, metadataValid: false, metadataError: null }
  try {
    if (!existsSync(metadataPath) || !lstatSync(metadataPath).isFile() || lstatSync(metadataPath).isSymbolicLink()) throw new Error('对应快照元数据不是普通文件')
    const metadata = readJson(metadataPath, 'snapshot evidence')
    if (!metadata.snapshotId || !/^sha256:[0-9a-f]{64}$/u.test(metadata.archiveSha256 ?? '')) throw new Error('快照元数据缺少完整 snapshotId/archiveSha256')
    const expectedSnapshotId = basename(path) === 'home.tar.zst' ? basename(dirname(path)) : basename(path, suffix)
    if (metadata.snapshotId !== expectedSnapshotId) throw new Error('快照元数据 snapshotId 与归档名不一致')
    if (resolve(metadata.archivePath) !== path) throw new Error('快照元数据 archivePath 与归档不一致')
    record.metadata = metadata
    record.metadataValid = true
  } catch (error) {
    record.metadataError = error.message
  }
  return record
}

function collectLocalCleanupInventory(release, cleanup) {
  const candidatesRoot = join(stateRoot, 'candidates')
  const snapshotsRoot = join(stateRoot, 'snapshots')
  const inventory = {
    gateComplete: true,
    current: null,
    candidates: [],
    latestSnapshot: null,
    snapshotArchives: filesRecursively(snapshotsRoot, (path) => path.endsWith('.tar.zst'))
      .map(localSnapshotArchiveEvidence),
    containerImageIds: null,
  }
  try {
    if (!release.candidatePath) throw new Error('release.json 缺少 candidatePath')
    const candidatePath = resolve(release.candidatePath)
    if (!existsSync(candidatePath) || !lstatSync(candidatePath).isFile() || lstatSync(candidatePath).isSymbolicLink()) throw new Error(`当前 candidate.json 不是普通文件: ${candidatePath}`)
    const candidate = readJson(candidatePath, 'accepted candidate')
    const current = requiredCandidateMetadata(candidate, candidatePath, release.candidate)
    if (!existsSync(current.candidate.archivePath) || !lstatSync(current.candidate.archivePath).isFile() || lstatSync(current.candidate.archivePath).isSymbolicLink()) throw new Error('当前候选 image.tar 不是普通文件')
    if (sha256File(current.candidate.archivePath) !== current.candidate.archiveSha256) throw new Error('当前候选 image.tar 摘要不匹配')
    if (!existsSync(current.candidate.composePath) || !lstatSync(current.candidate.composePath).isFile() || lstatSync(current.candidate.composePath).isSymbolicLink()) throw new Error('当前候选 Compose 不是普通文件')
    if (sha256File(current.candidate.composePath) !== current.candidate.composeSha256) throw new Error('当前候选 Compose 摘要不匹配')
    if (!existsSync(current.candidate.testReceiptPath) || !lstatSync(current.candidate.testReceiptPath).isFile() || lstatSync(current.candidate.testReceiptPath).isSymbolicLink()) throw new Error('当前候选测试回执不是普通文件')
    if (sha256File(current.candidate.testReceiptPath) !== current.candidate.testReceiptSha256) throw new Error('当前候选测试回执摘要不匹配')
    const image = localImageInventory(current.candidate.imageTag)
    if (!image || !sameImageId(image.id, current.candidate.imageId)) throw new Error('当前候选 Podman 镜像身份缺失或不匹配')
    inventory.current = {
      ...current,
      archive: { path: current.candidate.archivePath, bytes: statSync(current.candidate.archivePath).size },
      testReceipt: { path: current.candidate.testReceiptPath, bytes: statSync(current.candidate.testReceiptPath).size },
      image,
    }
    for (const value of [
      { scope: 'local', kind: 'candidate-directory', path: current.candidateDir },
      { scope: 'local', kind: 'candidate', path: current.candidatePath },
      { scope: 'local', kind: 'candidate-archive', path: current.candidate.archivePath },
      { scope: 'local', kind: 'test-receipt', path: current.candidate.testReceiptPath },
      { scope: 'local', kind: 'podman-image', imageId: current.candidate.imageId, imageTag: current.candidate.imageTag },
    ]) pushUniqueCleanupObject(cleanup.protected, value)
  } catch (error) {
    inventory.gateComplete = false
    cleanupError(cleanup, 'local', 'current-candidate-incomplete', release.candidatePath ?? null, error.message)
  }

  if (existsSync(candidatesRoot)) {
    for (const name of readdirSync(candidatesRoot).sort()) {
      const candidateDir = join(candidatesRoot, name)
      if (!lstatSync(candidateDir).isDirectory()) continue
      const candidatePath = join(candidateDir, 'candidate.json')
      const archivePath = join(candidateDir, 'image.tar')
      const archiveIsRegular = existsSync(archivePath) && lstatSync(archivePath).isFile() && !lstatSync(archivePath).isSymbolicLink()
      if (!existsSync(candidatePath)) {
        if (archiveIsRegular) {
          inventory.candidates.push({ valid: false, candidateDir, candidatePath, archive: { path: archivePath, bytes: statSync(archivePath).size } })
          cleanupError(cleanup, 'local', 'candidate-metadata-missing', archivePath, 'image.tar 没有对应 candidate.json')
        }
        continue
      }
      if (!lstatSync(candidatePath).isFile() || lstatSync(candidatePath).isSymbolicLink()) {
        const archive = archiveIsRegular ? { path: archivePath, bytes: statSync(archivePath).size } : null
        inventory.candidates.push({ valid: false, candidateDir, candidatePath, archive })
        if (archive) cleanupError(cleanup, 'local', 'candidate-metadata-invalid', archive.path, 'candidate.json 不是普通文件')
        continue
      }
      try {
        const candidate = readJson(candidatePath, 'candidate evidence')
        if (candidatePurpose(candidate) !== 'release') continue
        const validated = requiredCandidateMetadata(candidate, candidatePath, null, { allowLegacyV2: true })
        inventory.candidates.push({
          valid: true,
          ...validated,
          archive: archiveIsRegular ? { path: archivePath, bytes: statSync(archivePath).size } : null,
          image: localImageInventory(candidate.imageTag),
        })
      } catch (error) {
        const archive = archiveIsRegular ? { path: archivePath, bytes: statSync(archivePath).size } : null
        inventory.candidates.push({ valid: false, candidateDir, candidatePath, archive })
        if (archive) cleanupError(cleanup, 'local', 'candidate-metadata-invalid', archive.path, error.message)
      }
    }
  }

  try {
    const latestPath = join(snapshotsRoot, 'latest.json')
    if (!existsSync(latestPath) || !lstatSync(latestPath).isFile() || lstatSync(latestPath).isSymbolicLink()) throw new Error('latest snapshot 元数据不是普通文件')
    const latest = readJson(latestPath, 'latest snapshot')
    for (const field of ['snapshotId', 'archivePath', 'archiveSha256']) {
      if (!latest[field]) throw new Error(`latest snapshot 缺少 ${field}`)
    }
    const archivePath = resolve(latest.archivePath)
    const allowedPaths = new Set([
      join(snapshotsRoot, `${latest.snapshotId}.tar.zst`),
      join(snapshotsRoot, latest.snapshotId, 'home.tar.zst'),
    ])
    if (!allowedPaths.has(archivePath) || !controlledChild(snapshotsRoot, archivePath)) throw new Error('latest snapshot archivePath 不在受控快照路径')
    if (!existsSync(archivePath) || !lstatSync(archivePath).isFile() || lstatSync(archivePath).isSymbolicLink()) throw new Error('latest snapshot 归档不是普通文件')
    if (sha256File(archivePath) !== latest.archiveSha256) throw new Error('latest snapshot 归档摘要不匹配')
    inventory.latestSnapshot = { metadata: latest, metadataPath: latestPath, archive: { path: archivePath, bytes: statSync(archivePath).size } }
    pushUniqueCleanupObject(cleanup.protected, { scope: 'local', kind: 'snapshot-metadata', path: latestPath })
    pushUniqueCleanupObject(cleanup.protected, { scope: 'local', kind: 'snapshot-archive', path: archivePath })
  } catch (error) {
    inventory.gateComplete = false
    cleanupError(cleanup, 'local', 'latest-snapshot-incomplete', join(snapshotsRoot, 'latest.json'), error.message)
  }

  try { inventory.containerImageIds = localContainerImageIds() } catch (error) {
    cleanupError(cleanup, 'local', 'container-inventory-failed', 'podman containers', error.message)
  }
  return inventory
}

function remoteCandidateMetadata(item) {
  const remoteRoot = '/home/herman/.local/share/dsh-container'
  const expectedDir = `${remoteRoot}/releases/${item.name}`
  if (item.dir !== expectedDir || item.release?.releaseId !== item.name) throw new Error('releaseId 或 release 目录不一致')
  if (!item.candidate || !item.release?.candidate) throw new Error(item.candidateError ?? item.releaseError ?? '缺少 candidate/release 元数据')
  const candidate = item.candidate
  for (const field of ['candidateId', 'imageId', 'imageTag', 'archiveSha256']) {
    if (!candidate[field]) throw new Error(`candidate 缺少 ${field}`)
    if (candidate[field] !== item.release.candidate[field]) throw new Error(`candidate ${field} 与 release.json 不一致`)
  }
  if (candidatePurpose(candidate) !== 'release') throw new Error('candidate 用途不是 release')
  if (!/^(?:sha256:)?[0-9a-f]{64}$/u.test(candidate.imageId)) throw new Error('candidate imageId 不是完整镜像 ID')
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*:[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(candidate.imageTag)) throw new Error('candidate imageTag 不是受控精确标签')
  if (!/^sha256:[0-9a-f]{64}$/u.test(candidate.archiveSha256)) throw new Error('candidate archiveSha256 不完整')
  if (item.archive && item.archive.path !== `${expectedDir}/image.tar`) throw new Error('release image.tar 路径不精确')
  if (item.compose && item.compose.path !== `${expectedDir}/compose.production.yml`) throw new Error('release Compose 路径不精确')
  if (item.candidateFile && item.candidateFile.path !== `${expectedDir}/candidate.json`) throw new Error('release candidate.json 路径不精确')
  return candidate
}

function remoteEngineImageId(item) {
  const imageId = item.release?.production?.engineImageId
  if (!/^(?:sha256:)?[0-9a-f]{64}$/u.test(imageId ?? '')) {
    throw new Error('release production.engineImageId 不是完整远端 Docker 镜像 ID')
  }
  return imageId
}

function validateRemoteCleanupInventory(release, inventory, cleanup) {
  const remoteRoot = '/home/herman/.local/share/dsh-container'
  const expectedDir = `${remoteRoot}/releases/${release.releaseId}`
  let gateComplete = true
  if (!inventory || inventory.root !== remoteRoot) {
    cleanupError(cleanup, 'remote', 'inventory-incomplete', target, '远端 state root 盘点缺失或不匹配')
    return { gateComplete: false, current: null }
  }
  for (const message of inventory.errors ?? []) cleanupError(cleanup, 'remote', 'inventory-warning', target, message)
  if (inventory.currentPath !== expectedDir || inventory.lastGoodPath !== expectedDir) {
    gateComplete = false
    cleanupError(cleanup, 'remote', 'release-pointers-incomplete', expectedDir, `current=${inventory.currentPath ?? 'missing'} last-good=${inventory.lastGoodPath ?? 'missing'}`)
  }
  const current = inventory.releases?.find((item) => item.dir === expectedDir) ?? null
  try {
    if (!current) throw new Error('当前 release 目录不在远端盘点中')
    const candidate = remoteCandidateMetadata(current)
    for (const field of ['candidateId', 'imageId', 'imageTag', 'archiveSha256']) {
      if (candidate[field] !== release.candidate?.[field]) throw new Error(`远端当前 candidate ${field} 与本机 release.json 不一致`)
    }
    if (current.release.status !== 'accepted') throw new Error(`远端当前 release 状态不是 accepted: ${current.release.status ?? 'missing'}`)
    if (current.release.rollbackBoundary?.status !== 'retired-at-accept') throw new Error('远端 rollbackBoundary 尚未在 accept 退休')
    if (!current.archive || current.archive.sha256 !== candidate.archiveSha256) throw new Error('远端当前 image.tar 缺失或摘要不匹配')
    if (!current.compose || !current.candidateFile) throw new Error('远端当前 Compose 或 candidate.json 缺失')
    const engineImageId = remoteEngineImageId(current)
    if (!sameImageId(engineImageId, release.production?.engineImageId)) {
      throw new Error('远端当前 production.engineImageId 与本机 release.json 不一致')
    }
    const image = inventory.images?.[candidate.imageTag]
    if (!image || image.error || !sameImageId(image.id, engineImageId)) {
      throw new Error('远端当前 Docker 镜像身份缺失或不匹配')
    }
    for (const value of [
      { scope: 'remote', kind: 'release-directory', path: current.dir },
      { scope: 'remote', kind: 'release-archive', path: current.archive.path },
      { scope: 'remote', kind: 'compose', path: current.compose.path },
      { scope: 'remote', kind: 'candidate', path: current.candidateFile.path },
      { scope: 'remote', kind: 'docker-image', imageId: image.id, imageTag: candidate.imageTag },
    ]) pushUniqueCleanupObject(cleanup.protected, value)
  } catch (error) {
    gateComplete = false
    cleanupError(cleanup, 'remote', 'current-release-incomplete', expectedDir, error.message)
  }

  try {
    const latest = inventory.latestSnapshot
    for (const field of ['snapshotId', 'archivePath', 'archiveSha256']) {
      if (!latest?.[field]) throw new Error(`latest snapshot 缺少 ${field}`)
    }
    const archivePath = resolve(latest.archivePath)
    const snapshotsRoot = `${remoteRoot}/snapshots`
    if (archivePath !== `${snapshotsRoot}/${latest.snapshotId}.tar.zst` || !controlledChild(snapshotsRoot, archivePath)) {
      throw new Error('latest snapshot archivePath 不在受控快照路径')
    }
    const actual = inventory.latestSnapshotArchive
    if (!actual || actual.path !== archivePath || actual.sha256 !== latest.archiveSha256) throw new Error('latest snapshot 归档缺失或摘要不匹配')
    pushUniqueCleanupObject(cleanup.protected, { scope: 'remote', kind: 'snapshot-metadata', path: `${snapshotsRoot}/latest.json` })
    pushUniqueCleanupObject(cleanup.protected, { scope: 'remote', kind: 'snapshot-archive', path: archivePath })
  } catch (error) {
    gateComplete = false
    cleanupError(cleanup, 'remote', 'latest-snapshot-incomplete', `${remoteRoot}/snapshots/latest.json`, error.message)
  }
  return { gateComplete, current }
}

function keepLocalFormalInventory(inventory, cleanup, reason) {
  for (const item of inventory.candidates) {
    if (item.archive) pushUniqueCleanupObject(cleanup.local.kept, { kind: 'candidate-archive', path: item.archive.path, bytes: item.archive.bytes, reason })
    if (item.image) pushUniqueCleanupObject(cleanup.local.kept, { kind: 'podman-image', imageId: item.image.id, imageTag: item.candidate?.imageTag, bytes: item.image.size, reason })
  }
  for (const item of inventory.snapshotArchives) {
    pushUniqueCleanupObject(cleanup.local.kept, { kind: 'snapshot-archive', path: item.path, bytes: item.bytes, reason })
  }
}

function keepRemoteFormalInventory(inventory, cleanup, reason) {
  for (const item of inventory?.releases ?? []) {
    if (item.archive) pushUniqueCleanupObject(cleanup.remote.kept, { kind: 'release-archive', path: item.archive.path, bytes: item.archive.bytes, reason })
    const candidate = item.candidate ?? item.release?.candidate
    const image = candidate?.imageTag ? inventory.images?.[candidate.imageTag] : null
    if (image?.id) pushUniqueCleanupObject(cleanup.remote.kept, { kind: 'docker-image', imageId: image.id, imageTag: candidate.imageTag, bytes: image.size, reason })
  }
  for (const item of inventory?.snapshotArchives ?? []) {
    pushUniqueCleanupObject(cleanup.remote.kept, { kind: 'snapshot-archive', path: item.path, bytes: item.bytes, reason })
  }
}

function removeLocalFileForCleanup(path, kind, bytes, cleanup) {
  try {
    rmSync(path, { force: true })
    pushUniqueCleanupObject(cleanup.local.deleted, { kind, path, bytes })
    return true
  } catch (error) {
    pushUniqueCleanupObject(cleanup.local.kept, { kind, path, bytes, reason: 'delete-failed' })
    cleanupError(cleanup, 'local', 'delete-failed', path, error.message)
    return false
  }
}

function removeRemoteFileForCleanup(path, kind, bytes, cleanup) {
  const remoteRoot = '/home/herman/.local/share/dsh-container'
  if (!controlledChild(remoteRoot, path)) {
    pushUniqueCleanupObject(cleanup.remote.kept, { kind, path, bytes, reason: 'uncontrolled-path' })
    cleanupError(cleanup, 'remote', 'uncontrolled-path', path, '拒绝删除不受控远端路径')
    return false
  }
  const result = remoteCleanupStatus(`set -Eeuo pipefail
# DSH_ACCEPT_CLEANUP_REMOVE_FILE_V1
root=${shellQuote(remoteRoot)}
path=${shellQuote(path)}
case "$path" in "$root"/*) ;; *) echo 'uncontrolled path' >&2; exit 71 ;; esac
if test -f "$path"; then rm -- "$path"; fi
`)
  if (result.status === 0) {
    pushUniqueCleanupObject(cleanup.remote.deleted, { kind, path, bytes })
    return true
  }
  pushUniqueCleanupObject(cleanup.remote.kept, { kind, path, bytes, reason: 'delete-failed' })
  cleanupError(cleanup, 'remote', 'delete-failed', path, String(result.stderr ?? '').trim() || `ssh exit ${result.status}`)
  return false
}

function removeRemoteImageForCleanup(imageTag, imageIdValue, bytes, cleanup) {
  const result = remoteCleanupStatus(`set -Eeuo pipefail
# DSH_ACCEPT_CLEANUP_REMOVE_IMAGE_V1
expected_tag=${shellQuote(imageTag)}
expected_id=${shellQuote(imageIdValue)}
if ! docker image inspect "$expected_tag" >/dev/null 2>&1; then exit 0; fi
actual_id="$(docker image inspect "$expected_tag" --format '{{.Id}}')"
test "$actual_id" = "$expected_id" || { echo "image identity changed: $actual_id" >&2; exit 72; }
while read -r container_id; do
  test -n "$container_id" || continue
  container_image="$(docker inspect "$container_id" --format '{{.Image}}')"
  test "$container_image" != "$expected_id" || { echo "image referenced by container $container_id" >&2; exit 73; }
done < <(docker ps --all --quiet)
docker image rm "$expected_id"
`)
  if (result.status === 0) {
    pushUniqueCleanupObject(cleanup.remote.deleted, { kind: 'docker-image', imageId: imageIdValue, imageTag, bytes })
    return true
  }
  pushUniqueCleanupObject(cleanup.remote.kept, { kind: 'docker-image', imageId: imageIdValue, imageTag, bytes, reason: 'delete-failed' })
  cleanupError(cleanup, 'remote', 'image-delete-failed', imageIdValue, String(result.stderr ?? '').trim() || `ssh exit ${result.status}`)
  return false
}

function cleanupLocalFormalObjects(release, inventory, cleanup) {
  const currentCandidatePath = inventory.current?.candidatePath
  const currentImageId = inventory.current?.candidate.imageId
  const imageTargets = new Map()

  if (inventory.current) {
    pushUniqueCleanupObject(cleanup.local.kept, { kind: 'candidate-archive', path: inventory.current.archive.path, bytes: inventory.current.archive.bytes, reason: 'current-accepted-candidate' })
    pushUniqueCleanupObject(cleanup.local.kept, { kind: 'test-receipt', path: inventory.current.testReceipt.path, bytes: inventory.current.testReceipt.bytes, reason: 'historical-evidence' })
    pushUniqueCleanupObject(cleanup.local.kept, { kind: 'podman-image', imageId: inventory.current.image.id, imageTag: inventory.current.candidate.imageTag, bytes: inventory.current.image.size, reason: 'current-accepted-candidate' })
  }

  for (const item of inventory.candidates) {
    if (item.valid && item.candidatePath === currentCandidatePath) continue
    if (!item.valid) {
      if (item.archive) pushUniqueCleanupObject(cleanup.local.kept, { kind: 'candidate-archive', path: item.archive.path, bytes: item.archive.bytes, reason: 'metadata-incomplete' })
      continue
    }
    if (item.archive) removeLocalFileForCleanup(item.archive.path, 'candidate-archive', item.archive.bytes, cleanup)
    if (!item.image) continue
    if (!sameImageId(item.image.id, item.candidate.imageId)) {
      pushUniqueCleanupObject(cleanup.local.kept, { kind: 'podman-image', imageId: item.image.id, imageTag: item.candidate.imageTag, bytes: item.image.size, reason: 'identity-mismatch' })
      cleanupError(cleanup, 'local', 'image-identity-mismatch', item.candidate.imageTag, `${item.image.id} != ${item.candidate.imageId}`)
      continue
    }
    const key = normalizedImageId(item.image.id)
    if (!imageTargets.has(key)) imageTargets.set(key, item)
  }

  for (const item of imageTargets.values()) {
    const image = item.image
    if (sameImageId(image.id, currentImageId)) continue
    if (inventory.containerImageIds === null) {
      pushUniqueCleanupObject(cleanup.local.kept, { kind: 'podman-image', imageId: image.id, imageTag: item.candidate.imageTag, bytes: image.size, reason: 'container-inventory-incomplete' })
      continue
    }
    if (inventory.containerImageIds.has(normalizedImageId(image.id))) {
      pushUniqueCleanupObject(cleanup.local.kept, { kind: 'podman-image', imageId: image.id, imageTag: item.candidate.imageTag, bytes: image.size, reason: 'container-reference' })
      cleanupError(cleanup, 'local', 'image-referenced', image.id, 'Podman 镜像仍被容器引用')
      continue
    }
    const removed = runStatus(engine, ['image', 'rm', image.id])
    if (removed.status === 0) {
      pushUniqueCleanupObject(cleanup.local.deleted, { kind: 'podman-image', imageId: image.id, imageTag: item.candidate.imageTag, bytes: image.size })
    } else {
      pushUniqueCleanupObject(cleanup.local.kept, { kind: 'podman-image', imageId: image.id, imageTag: item.candidate.imageTag, bytes: image.size, reason: 'delete-failed' })
      cleanupError(cleanup, 'local', 'image-delete-failed', image.id, String(removed.stderr ?? '').trim() || `engine exit ${removed.status}`)
    }
  }

  const protectedSnapshot = inventory.latestSnapshot?.archive.path
  if (inventory.latestSnapshot) {
    pushUniqueCleanupObject(cleanup.local.kept, { kind: 'snapshot-archive', path: protectedSnapshot, bytes: inventory.latestSnapshot.archive.bytes, reason: 'latest-snapshot' })
  }
  for (const item of inventory.snapshotArchives) {
    if (item.path === protectedSnapshot) continue
    if (!item.metadataValid) {
      pushUniqueCleanupObject(cleanup.local.kept, { kind: 'snapshot-archive', path: item.path, bytes: item.bytes, reason: 'metadata-incomplete' })
      cleanupError(cleanup, 'local', 'snapshot-metadata-invalid', item.path, item.metadataError)
      continue
    }
    removeLocalFileForCleanup(item.path, 'snapshot-archive', item.bytes, cleanup)
  }

  const latestCandidatePointer = join(stateRoot, 'candidates/latest.json')
  if (existsSync(latestCandidatePointer)) {
    removeLocalFileForCleanup(latestCandidatePointer, 'candidate-pointer', statSync(latestCandidatePointer).size, cleanup)
  }
}

function cleanupRemoteFormalObjects(release, inventory, validated, cleanup) {
  const currentDir = validated.current.dir
  const currentCandidate = validated.current.candidate
  const currentImage = inventory.images[currentCandidate.imageTag]
  const imageTargets = new Map()
  pushUniqueCleanupObject(cleanup.remote.kept, { kind: 'release-archive', path: validated.current.archive.path, bytes: validated.current.archive.bytes, reason: 'current-accepted-release' })
  pushUniqueCleanupObject(cleanup.remote.kept, { kind: 'docker-image', imageId: currentImage.id, imageTag: currentCandidate.imageTag, bytes: currentImage.size, reason: 'current-running-release' })

  for (const item of inventory.releases ?? []) {
    if (item.dir === currentDir) continue
    let candidate
    try { candidate = remoteCandidateMetadata(item) } catch (error) {
      if (item.archive) {
        pushUniqueCleanupObject(cleanup.remote.kept, { kind: 'release-archive', path: item.archive.path, bytes: item.archive.bytes, reason: 'metadata-incomplete' })
        cleanupError(cleanup, 'remote', 'release-metadata-invalid', item.dir, error.message)
      }
      continue
    }
    if (item.archive) removeRemoteFileForCleanup(item.archive.path, 'release-archive', item.archive.bytes, cleanup)
    const image = inventory.images?.[candidate.imageTag]
    if (!image) continue
    if (image.error) {
      cleanupError(cleanup, 'remote', 'image-inventory-failed', candidate.imageTag, image.error)
      continue
    }
    const target = imageTargets.get(candidate.imageTag) ?? { candidate, image, expectedImageIds: new Set(), metadataErrors: [] }
    try {
      target.expectedImageIds.add(normalizedImageId(remoteEngineImageId(item)))
    } catch (error) {
      target.metadataErrors.push(`${item.name}: ${error.message}`)
    }
    imageTargets.set(candidate.imageTag, target)
  }

  const containerImages = new Set((inventory.containerImages ?? []).map(normalizedImageId))
  for (const { candidate, image, expectedImageIds, metadataErrors } of imageTargets.values()) {
    if (sameImageId(image.id, currentImage.id)) continue
    if (expectedImageIds.size === 0) {
      pushUniqueCleanupObject(cleanup.remote.kept, { kind: 'docker-image', imageId: image.id, imageTag: candidate.imageTag, bytes: image.size, reason: 'metadata-incomplete' })
      cleanupError(cleanup, 'remote', 'image-identity-missing', candidate.imageTag, metadataErrors.join('; ') || '没有 release 记录远端 Docker 镜像 ID')
      continue
    }
    if (expectedImageIds.size !== 1 || !expectedImageIds.has(normalizedImageId(image.id))) {
      pushUniqueCleanupObject(cleanup.remote.kept, { kind: 'docker-image', imageId: image.id, imageTag: candidate.imageTag, bytes: image.size, reason: 'identity-mismatch' })
      cleanupError(cleanup, 'remote', 'image-identity-mismatch', candidate.imageTag, `${image.id} != ${[...expectedImageIds].join(',')}`)
      continue
    }
    if (!inventory.containersComplete) {
      pushUniqueCleanupObject(cleanup.remote.kept, { kind: 'docker-image', imageId: image.id, imageTag: candidate.imageTag, bytes: image.size, reason: 'container-inventory-incomplete' })
      continue
    }
    if (containerImages.has(normalizedImageId(image.id))) {
      pushUniqueCleanupObject(cleanup.remote.kept, { kind: 'docker-image', imageId: image.id, imageTag: candidate.imageTag, bytes: image.size, reason: 'container-reference' })
      cleanupError(cleanup, 'remote', 'image-referenced', image.id, 'Docker 镜像仍被容器引用')
      continue
    }
    removeRemoteImageForCleanup(candidate.imageTag, image.id, image.size, cleanup)
  }

  const protectedSnapshot = resolve(inventory.latestSnapshot.archivePath)
  const protectedRecord = inventory.snapshotArchives.find((item) => item.path === protectedSnapshot) ?? inventory.latestSnapshotArchive
  if (protectedRecord) pushUniqueCleanupObject(cleanup.remote.kept, { kind: 'snapshot-archive', path: protectedSnapshot, bytes: protectedRecord.bytes, reason: 'latest-snapshot' })
  for (const item of inventory.snapshotArchives ?? []) {
    if (item.path === protectedSnapshot) continue
    if (!item.metadataValid) {
      pushUniqueCleanupObject(cleanup.remote.kept, { kind: 'snapshot-archive', path: item.path, bytes: item.bytes, reason: 'metadata-incomplete' })
      cleanupError(cleanup, 'remote', 'snapshot-metadata-invalid', item.path, item.metadataError ?? '快照元数据不能精确识别归档')
      continue
    }
    removeRemoteFileForCleanup(item.path, 'snapshot-archive', item.bytes, cleanup)
  }
}

function cleanupAcceptedRelease(release) {
  const cleanup = cleanupAttempt(release)
  try {
    cleanup.development = cleanupAcceptedDevelopmentState()
    if (cleanup.development.keptReferencedCandidateIds.length > 0) {
      cleanupError(cleanup, 'local', 'development-image-retained', cleanup.development.keptReferencedCandidateIds, '开发镜像仍有受保护引用')
    }
  } catch (error) {
    cleanup.development = { result: 'incomplete', error: error.message }
    cleanupError(cleanup, 'local', 'development-cleanup-failed', join(stateRoot, 'dev'), error.message)
  }

  const localInventory = collectLocalCleanupInventory(release, cleanup)
  let remoteInventory = null
  try { remoteInventory = collectRemoteCleanupInventory() } catch (error) {
    cleanupError(cleanup, 'remote', 'inventory-failed', target, error.message)
  }
  const remoteValidation = validateRemoteCleanupInventory(release, remoteInventory, cleanup)
  const formalGateComplete = localInventory.gateComplete && remoteValidation.gateComplete
  if (!formalGateComplete) {
    keepLocalFormalInventory(localInventory, cleanup, 'formal-metadata-incomplete')
    keepRemoteFormalInventory(remoteInventory, cleanup, 'formal-metadata-incomplete')
  } else {
    cleanupLocalFormalObjects(release, localInventory, cleanup)
    cleanupRemoteFormalObjects(release, remoteInventory, remoteValidation, cleanup)
  }
  return finishCleanupAttempt(cleanup)
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

function writeTestNotionCredential(dshHome) {
  const secrets = join(dshHome, 'secrets')
  rmSync(secrets, { recursive: true, force: true })
  mkdirSync(secrets, { recursive: true, mode: 0o700 })
  chmodSync(secrets, 0o700)
  writeFileSync(join(secrets, 'notion.token'), 'dsh-fake-notion-token-v1', { mode: 0o600 })
}

function makeSyntheticHome(homePath) {
  ensureDir(join(homePath, '.dsh/storages/dsh-cron'))
  ensureDir(join(homePath, '.dsh/storages/personal-feed'))
  ensureDir(join(homePath, '.dsh/sessions'))
  ensureDir(join(homePath, '.dsh/workspace'))
  writeFileSync(join(homePath, '.dsh/storages/dsh-cron/jobs.jsonl'), '')
  writeTestCredentials(join(homePath, '.dsh/.credentials.yaml'))
  writeTestNotionCredential(join(homePath, '.dsh'))
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
  run('python3', [
    join(releaseRoot, 'scripts/scrub-preflight-state.py'),
    '--dsh-home', dshHome,
    '--preflight-root', resolve(homePath, '../..'),
  ], { capture: true, announce: false, code: exitCodes.test })
  const prodCron = join(dshHome, 'storages/dsh-cron/jobs.jsonl')
  if (existsSync(prodCron)) {
    ensureDir(dirname(prodCron))
    writeFileSync(prodCron, '')
  }
  for (const name of ['telegram-offset.json', 'scheduler.lock', 'worker.lock']) rmSync(join(dshHome, 'storages', name), { force: true })
}

function containerBaseArgs(homePath, {
  notionApiBase = 'http://fake-notion:8081/v1',
  notionPageId = '00000000000000000000000000000001',
} = {}) {
  // Rootless Podman maps container uid 0 to the invoking host user. Running
  // the local development/preflight containers as uid 1000 would instead map
  // to a subordinate host uid and make the freshly copied snapshot unwritable.
  // Production uses Docker and remains fixed at the required 1000:1000.
  const localUser = engine === 'podman' ? '0:0' : '1000:1000'
  return [
    '--read-only', '--user', localUser,
    '--tmpfs', emptyTmpfsSpec('/tmp', 'rw,noexec,nosuid,size=512m'),
    '--tmpfs', emptyTmpfsSpec('/run', 'rw,nosuid,size=64m'),
    '--tmpfs', emptyTmpfsSpec('/home/herman/.openclaw', 'rw,noexec,nosuid,size=1m'),
    '--tmpfs', emptyTmpfsSpec('/home/herman/task-inbox-workflow', 'rw,noexec,nosuid,size=1m'),
    '--volume', `${homePath}:/home/herman:rw`,
    '--env', 'HOME=/home/herman', '--env', 'DSH_HOME=/home/herman/.dsh', '--env', 'DSH_CWD=/home/herman/.dsh/workspace',
    '--env', 'TZ=Asia/Shanghai',
    '--env', 'NOTION_TOKEN_FILE=/home/herman/.dsh/secrets/notion.token',
    '--env', 'NOTION_INBOX_FILE=/home/herman/.dsh/storages/task-inbox/inbox.md',
    '--env', `NOTION_API_BASE=${notionApiBase}`,
    '--env', `NOTION_PAGE_ID=${notionPageId}`,
  ]
}

const developmentPackages = Object.freeze([
  'telegram-gateway',
  'dsh-cron',
  'dsh-assistant',
  'personal-feed-selector',
  'personal-feed',
  'x-feed',
])

function editableSourceFingerprint(sourcePath) {
  const listed = run('git', ['-C', sourcePath, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    capture: true,
    announce: false,
    code: exitCodes.safety,
  })
  const deleted = new Set(run('git', ['-C', sourcePath, 'ls-files', '-z', '--deleted'], {
    capture: true,
    announce: false,
    code: exitCodes.safety,
  }).split('\0').filter(Boolean))
  const paths = [...new Set(listed.split('\0').filter(Boolean))].sort()
  const digest = createHash('sha256')
  for (const relativePath of paths) {
    const path = join(sourcePath, relativePath)
    let entry
    try {
      entry = lstatSync(path)
    } catch (error) {
      if (deleted.has(relativePath)) {
        digest.update(`${relativePath}\0deleted\0`)
        continue
      }
      fail(`验证源码在计算指纹时变化: ${relativePath}`, exitCodes.safety)
    }
    digest.update(`${relativePath}\0`)
    if (entry.isSymbolicLink()) {
      digest.update('symlink\0').update(readlinkSync(path))
    } else if (entry.isFile()) {
      digest.update('file\0').update(readFileSync(path))
    } else {
      fail(`验证源码含不支持的 Git 输入类型: ${relativePath}`, exitCodes.safety)
    }
    digest.update('\0')
  }
  return `sha256:${digest.digest('hex')}`
}

function editableSourceReceipt(source, candidate, scope, sourceFingerprint) {
  const status = run('git', ['-C', source.sourcePath, 'status', '--porcelain=v1', '--untracked-files=all'], {
    capture: true,
    announce: false,
    code: exitCodes.safety,
  })
  return {
    baseline: {
      candidateId: candidate.candidateId,
      imageId: candidate.imageId,
      pluginsCommit: candidate.pluginsCommit,
      imageTestReceiptPath: candidate.testReceiptPath ?? null,
      imageTestReceiptSha256: candidate.testReceiptSha256 ?? null,
    },
    editableSource: {
      sourcePath: source.sourcePath,
      branch: source.branch,
      head: source.head,
      originMain: source.originMain,
      workingTree: status ? 'dirty' : 'clean',
      workingTreeStatusSha256: sha256Text(status),
      sourceFingerprint,
      scope,
      identities: {
        typeBuildBundle: 'rootless-toolbox-uid-0',
        test: '1000:1000',
      },
      cache: 'toolbox-tmpfs',
    },
  }
}

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
  for (const profile of ['web', 'telegram', 'telegram-test']) {
    args.push(
      '--volume',
      `${join(sourcePath, 'personal-feed-selector')}:/opt/dsh/harness/local-profiles/${profile}/node_modules/@herman/personal-feed-selector:rw`,
    )
  }
  args.push(
    '--volume', `${join(sourcePath, 'release/cli.mjs')}:/opt/dsh/release-system/cli.mjs:ro`,
    '--volume', `${join(sourcePath, 'release/dsh')}:/opt/dsh/release-system/dsh:ro`,
    '--volume', `${join(sourcePath, 'release/scripts')}:/opt/dsh/release-system/scripts:rw`,
    '--volume', `${join(sourcePath, 'release/tests')}:/opt/dsh/release-system/tests:ro`,
    '--volume', `${join(sourcePath, 'release/notion.production.json')}:/opt/dsh/release-system/notion.production.json:ro`,
    '--volume', `${join(sourcePath, 'release/harness-automation-instructions.md')}:/opt/dsh/release-system/harness-automation-instructions.md:ro`,
    '--volume', `${join(sourcePath, 'release/workspace-migrations')}:/opt/dsh/release-system/workspace-migrations:ro`,
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

function startDevelopmentToolbox(candidate, runtime, homePath, sourceArgs, baseArgs = containerBaseArgs(homePath)) {
  run(engine, [
    'run', '--detach', '--name', runtime.toolbox, '--network', runtime.network,
    ...developmentContainerLabels(runtime, 'toolbox'),
    ...baseArgs, ...sourceArgs,
    candidate.imageTag, 'toolbox',
  ], { code: exitCodes.test })
}

function startFakeNotion(candidate, runtime, sourceArgs = []) {
  run(engine, [
    'run', '--detach', '--name', runtime.fakeNotion, '--network', runtime.network,
    '--network-alias', 'fake-notion',
    ...developmentContainerLabels(runtime, 'fake-notion'),
    '--read-only', '--tmpfs', emptyTmpfsSpec('/tmp', 'rw,noexec,nosuid,size=16m'),
    ...sourceArgs,
    candidate.imageTag, 'fake-notion',
  ], { code: exitCodes.test })
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const ready = runStatus(engine, [
      'exec', runtime.fakeNotion, 'curl', '--fail', '--silent', '--max-time', '2',
      'http://127.0.0.1:8081/__dsh_test__/request-count',
    ])
    if (ready.status === 0) return
    if (!devContainerRunning(runtime.fakeNotion)) break
    sleepSync(100)
  }
  fail(`假 Notion sidecar 未就绪\n${devLogs(runtime.fakeNotion)}`, exitCodes.test)
}

function fakeNotionRequestCount(runtime) {
  let value
  try {
    value = JSON.parse(run(engine, [
      'exec', runtime.fakeNotion, 'curl', '--fail', '--silent', '--max-time', '2',
      'http://127.0.0.1:8081/__dsh_test__/request-count',
    ], { capture: true, announce: false, code: exitCodes.test }))
  } catch {
    fail('无法解析假 Notion 脱敏请求计数', exitCodes.test)
  }
  const countFields = [
    'schemaVersion', 'successfulGetCount', 'rejectedGetCount',
    'mutationRequestCount', 'otherApiRequestCount', 'fixtureLength', 'fixtureSha256',
  ]
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('\0') !== [...countFields].sort().join('\0')
    || value.schemaVersion !== 1
    || !['successfulGetCount', 'rejectedGetCount', 'mutationRequestCount', 'otherApiRequestCount'].every(field => (
      Number.isSafeInteger(value[field]) && value[field] >= 0
    ))
    || !Number.isSafeInteger(value.fixtureLength) || value.fixtureLength < 0
    || !/^[0-9a-f]{64}$/u.test(value.fixtureSha256 ?? '')) {
    fail('假 Notion 请求计数不符合固定脱敏合同', exitCodes.test)
  }
  return value
}

function resetFakeNotion(runtime) {
  run(engine, [
    'exec', runtime.fakeNotion, 'curl', '--fail', '--silent', '--max-time', '2',
    '--request', 'POST', 'http://127.0.0.1:8081/__dsh_test__/reset',
  ], { capture: true, announce: false, code: exitCodes.test })
  const count = fakeNotionRequestCount(runtime)
  if (count.successfulGetCount !== 0 || count.rejectedGetCount !== 0
    || count.mutationRequestCount !== 0 || count.otherApiRequestCount !== 0) {
    fail('假 Notion 请求计数没有归零', exitCodes.test)
  }
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
    'release/cli.mjs',
    'release/dsh',
    'release/scripts',
    'release/tests',
    'release/notion.production.json',
    'release/harness-automation-instructions.md',
    'release/workspace-migrations',
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
    const web = runStatus(engine, ['exec', runtime.web, 'curl', '--fail', '--silent', '--max-time', '2', `http://127.0.0.1:${runtime.webPort}/`])
    if (web.status === 0 && devContainerRunning(runtime.toolbox) && devContainerRunning(runtime.web) && devContainerRunning(runtime.telegram)
      && devContainerRunning(runtime.fakeTelegram) && devContainerRunning(runtime.fakeNotion)) {
      ready = true
      break
    }
    if (!devContainerRunning(runtime.toolbox) || !devContainerRunning(runtime.web) || !devContainerRunning(runtime.telegram)) break
    sleepSync(1000)
  }
  if (!ready) {
    fail(`开发环境启动失败\n--- web ---\n${devLogs(runtime.web)}\n--- telegram ---\n${devLogs(runtime.telegram)}`, exitCodes.test)
  }

  for (const name of [runtime.toolbox, runtime.web, runtime.telegram, runtime.fakeNotion]) {
    const identity = run(engine, ['inspect', name, '--format', '{{.Image}}|{{.HostConfig.ReadonlyRootfs}}'], { capture: true, announce: false, code: exitCodes.test })
    if (identity !== `${candidate.imageId}|true`) fail(`${name} 没有运行同一个只读候选镜像: ${identity}`, exitCodes.test)
  }
  const networkInternal = run(engine, ['network', 'inspect', runtime.network, '--format', '{{.Internal}}'], {
    capture: true,
    announce: false,
    code: exitCodes.test,
  })
  if (networkInternal !== 'true') {
    fail(`开发网络不是 internal: ${runtime.network}`, exitCodes.test)
  }
  for (const name of [runtime.toolbox, runtime.web, runtime.telegram, runtime.fakeTelegram, runtime.fakeNotion]) {
    let networks
    try {
      networks = JSON.parse(run(engine, ['inspect', name, '--format', '{{json .NetworkSettings.Networks}}'], {
        capture: true,
        announce: false,
        code: exitCodes.test,
      }))
    } catch {
      fail(`${name} 的网络成员信息不可解析`, exitCodes.test)
    }
    const networkNames = networks && typeof networks === 'object' && !Array.isArray(networks)
      ? Object.keys(networks)
      : []
    if (networkNames.length !== 1 || networkNames[0] !== runtime.network) {
      fail(`${name} 未唯一连接预期内部网络 ${runtime.network}`, exitCodes.test)
    }
  }
  const notionApiBase = run(engine, ['exec', runtime.web, 'printenv', 'NOTION_API_BASE'], {
    capture: true,
    announce: false,
    code: exitCodes.test,
  })
  if (notionApiBase !== 'http://fake-notion:8081/v1') {
    fail(`开发 Web 没有使用固定假 Notion endpoint: ${notionApiBase}`, exitCodes.test)
  }
  fakeNotionRequestCount(runtime)
  run(engine, ['exec', runtime.fakeTelegram, 'curl', '--fail', '--silent', 'http://127.0.0.1:8080/bottest-token/getMe'], { capture: true, announce: false, code: exitCodes.test })
  run(engine, ['exec', runtime.fakeTelegram, 'curl', '--fail', '--silent', '--request', 'POST', 'http://127.0.0.1:8080/bottest-token/sendMessage'], { capture: true, announce: false, code: exitCodes.test })
  const requests = run(engine, ['exec', runtime.fakeTelegram, 'curl', '--fail', '--silent', 'http://127.0.0.1:8080/bottest-token/getRequests'], { capture: true, announce: false, code: exitCodes.test })
  for (const method of ['getMe', 'getUpdates', 'sendMessage']) {
    if (!requests.includes(`/${method}`)) fail(`假 Telegram 没有观察到 ${method}`, exitCodes.test)
  }
  const realTelegram = runStatus(engine, ['exec', runtime.telegram, 'curl', '--silent', '--show-error', '--max-time', '2', 'https://api.telegram.org'])
  if (realTelegram.status === 0) fail('开发 Telegram 容器可以访问真实 Telegram；内部网络隔离失效', exitCodes.test)
  const realNotion = runStatus(engine, ['exec', runtime.web, 'curl', '--silent', '--show-error', '--max-time', '2', 'https://api.notion.com'])
  if (realNotion.status === 0) fail('开发 Web 容器可以访问真实 Notion；内部网络隔离失效', exitCodes.test)
  const assistantCronHealth = JSON.parse(run(engine, [
    'exec', runtime.telegram, 'node',
    '/opt/dsh/release-system/scripts/check-assistant-cron-ready.mjs',
  ], { capture: true, announce: false, code: exitCodes.test }))
  if (assistantCronHealth.state !== 'ready' || assistantCronHealth.protocolVersion !== 1) {
    fail('开发 Telegram 容器的 Assistant→Cron 健康门没有通过', exitCodes.test)
  }
  const cronLedger = join(homePath, '.dsh/storages/dsh-cron/jobs.jsonl')
  if (existsSync(cronLedger) && readFileSync(cronLedger, 'utf8').trim() !== '') fail('开发 cron 台账不是空的，拒绝启动真实任务', exitCodes.test)
  return {
    requests: ['getMe', 'getUpdates', 'sendMessage'],
    realTelegramReachable: false,
    realNotionReachable: false,
    assistantCronHealth,
    cronJobs: 0,
    webAccess: 'container-exec/internal-no-external-route',
  }
}

function isolatePreflightRuntimeState(homePath) {
  const dshHome = join(homePath, '.dsh')
  if (!existsSync(dshHome) || !lstatSync(dshHome).isDirectory() || lstatSync(dshHome).isSymbolicLink()) {
    fail('已 scrub 的预发布副本缺少普通 .dsh 目录', exitCodes.test)
  }
  const cronLedger = join(dshHome, 'storages/dsh-cron/jobs.jsonl')
  if (existsSync(cronLedger)) writeFileSync(cronLedger, '')
  for (const name of ['telegram-offset.json', 'scheduler.lock', 'worker.lock']) {
    rmSync(join(dshHome, 'storages', name), { force: true })
  }
}

function runPreflightRuntime(candidate, homePath, sourcePath, notionAutomation) {
  const runtime = developmentRuntime(sourcePath, { create: true })
  stopDev(runtime)
  isolatePreflightRuntimeState(homePath)
  const baseArgs = containerBaseArgs(homePath)
  run(engine, ['run', '--rm', '--network', 'none', ...baseArgs,
    candidate.imageTag, 'workspace-migrate'], { code: exitCodes.test })
  run(engine, ['run', '--rm', '--network', 'none', ...baseArgs,
    '--env', `DSH_IMAGE_ID=${candidate.imageId}`, candidate.imageTag, 'prepare'], { code: exitCodes.test })
  run(engine, ['run', '--rm', '--network', 'none', ...baseArgs,
    candidate.imageTag, 'harness-only-health'], { code: exitCodes.test })
  run(engine, ['network', 'create', '--internal', runtime.network], { code: exitCodes.test })
  startFakeNotion(candidate, runtime)

  // Exercise only the hash-locked live-Harness-owned entrypoint already in the
  // scrubbed snapshot copy.  The independent fixture proves first-GET and
  // second-run no-op semantics without changing the migration/runtime copy.
  const notionFixtureHome = join(dirname(dirname(homePath)), 'notion-fixture/home/herman')
  rmSync(notionFixtureHome, { recursive: true, force: true })
  ensureDir(dirname(notionFixtureHome))
  cpSync(homePath, notionFixtureHome, {
    recursive: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  })
  rmSync(join(notionFixtureHome, '.dsh/storages/task-inbox'), { recursive: true, force: true })
  const notionArgs = containerBaseArgs(notionFixtureHome)
  const fixtureAutomation = parseNotionAutomationReceipt(run(engine, [
    'run', '--rm', '--network', 'none', ...notionArgs,
    candidate.imageTag, 'notion-automation-health',
  ], { capture: true, announce: false, code: exitCodes.test }), '预发布 Harness-owned Notion automation', exitCodes.test)
  if (JSON.stringify(fixtureAutomation) !== JSON.stringify(notionAutomation)) {
    fail('预发布快照中的 Harness-owned Notion automation 与停机前锁定身份不一致', exitCodes.test)
  }
  resetFakeNotion(runtime)
  const notionFirst = validateNotionInboxInitReceipt(parsePrivateFreeJson(run(engine, [
    'run', '--rm', '--network', runtime.network, ...notionArgs,
    candidate.imageTag, 'notion-inbox-init',
  ], { capture: true, announce: false, code: exitCodes.test }), 'preflight Notion first initialization'), notionAutomation, {
    allowedStatuses: ['initialized'],
    label: '预发布 Notion task mirror 首次初始化',
  })
  const firstRequestCount = fakeNotionRequestCount(runtime)
  if (firstRequestCount.successfulGetCount !== 1
    || firstRequestCount.rejectedGetCount !== 0
    || firstRequestCount.mutationRequestCount !== 0
    || firstRequestCount.otherApiRequestCount !== 0) {
    fail('预发布 Notion 首次初始化必须准确执行一次 GET 且不得发出写请求或异常 API 请求', exitCodes.test)
  }
  if (notionFirst.artifacts.mirror.length !== firstRequestCount.fixtureLength
    || notionFirst.artifacts.mirror.sha256 !== firstRequestCount.fixtureSha256) {
    fail('预发布 Notion 首次初始化的本地镜像与固定 GET fixture 不一致', exitCodes.test)
  }
  const notionSecond = validateNotionInboxInitReceipt(parsePrivateFreeJson(run(engine, [
    'run', '--rm', '--network', runtime.network, ...notionArgs,
    candidate.imageTag, 'notion-inbox-init',
  ], { capture: true, announce: false, code: exitCodes.test }), 'preflight Notion second initialization'), notionAutomation, {
    allowedStatuses: ['already-initialized'],
    label: '预发布 Notion task mirror 第二次初始化',
  })
  const secondRequestCount = fakeNotionRequestCount(runtime)
  if (JSON.stringify(secondRequestCount) !== JSON.stringify(firstRequestCount)) {
    fail('预发布 Notion 第二次初始化发生了额外网络请求', exitCodes.test)
  }
  if (JSON.stringify(notionSecond.artifacts) !== JSON.stringify(notionFirst.artifacts)) {
    fail('预发布 Notion 第二次初始化改变了任一持久化 artifact', exitCodes.test)
  }

  startDevelopmentToolbox(candidate, runtime, homePath, [], baseArgs)
  run(engine, ['run', '--detach', '--name', runtime.fakeTelegram, '--network', runtime.network, '--network-alias', 'fake-telegram',
    ...developmentContainerLabels(runtime, 'fake-telegram'), '--read-only', '--tmpfs', emptyTmpfsSpec('/tmp'), candidate.imageTag, 'fake-telegram'], { code: exitCodes.test })
  run(engine, ['run', '--detach', '--name', runtime.telegram, '--network', runtime.network,
    ...developmentContainerLabels(runtime, 'telegram'), ...baseArgs,
    '--env', 'TELEGRAM_BOT_TOKEN=test-token', '--env', 'TELEGRAM_ALLOWED_CHAT_ID=1', '--env', 'DEEPSEEK_API_KEY=test-key',
    candidate.imageTag, 'telegram-test'], { code: exitCodes.test })
  run(engine, ['run', '--detach', '--name', runtime.web, '--network', runtime.network,
    ...developmentContainerLabels(runtime, 'web'), ...baseArgs,
    '--env', `DSH_WEB_PORT=${runtime.webPort}`, '--env', 'DEEPSEEK_API_KEY=test-key', candidate.imageTag, 'web'], { code: exitCodes.test })
  const verification = verifyDev(candidate, homePath, runtime)
  return {
    result: 'preflight-runtime-verified',
    imageId: candidate.imageId,
    data: 'already-scrubbed-snapshot-copy',
    webNetwork: 'internal-no-external-route',
    notionApiBase: 'http://fake-notion:8081/v1',
    notionInboxInit: {
      entrypointSha256: notionFirst.entrypointSha256,
      handoffSha256: notionFirst.handoffSha256,
      testReceiptSha256: notionFirst.testReceiptSha256,
      first: {
        status: notionFirst.status,
        remoteMethod: notionFirst.remoteMethod,
        artifacts: notionFirst.artifacts,
        requestCounts: firstRequestCount,
      },
      second: {
        status: notionSecond.status,
        remoteMethod: notionSecond.remoteMethod,
        artifacts: notionSecond.artifacts,
        requestCounts: secondRequestCount,
      },
    },
    runtime,
    verification,
  }
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
  if (purpose === 'release') requireExactReleaseTree(releaseToolCommit, '正式候选 build 编排')
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
  let archiveRoundTripCleanup = null
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
    const workspaceMigration = purpose === 'release'
      ? workspaceMigrationFromArchives(releaseTarget, pluginsTarget)
      : null
    const archivedComposePath = join(releaseTarget, 'release/compose.production.yml')
    const composeSha256 = purpose === 'release' ? sha256File(archivedComposePath) : null
    imageTag = purpose === 'development'
      ? `localhost/dsh-development-main:${pluginsCommit}`
      : `localhost/dsh-candidate:${pluginsCommit.slice(0, 12)}-${buildId.slice(0, 15).toLowerCase()}`
    const signaturePolicy = join(releaseTarget, 'release/containers-policy.json')
    const engineBuildOptions = engine === 'podman' ? ['--signature-policy', signaturePolicy] : []
    const engineArchiveOptions = engine === 'podman' ? ['--signature-policy', signaturePolicy] : []
    const expectedLabels = expectedCandidateImageLabels({
      pluginsCommit,
      releaseToolCommit,
      harnessCommit,
      harnessPatchSha256: patchSha256,
      purpose,
      workspaceMigration,
      composeSha256,
    })
    const imageLabelArgs = Object.entries(expectedLabels).flatMap(([name, value]) => ['--label', `${name}=${value}`])

    run(engine, [
      'build', ...engineBuildOptions, '--format', 'docker', '--pull=missing',
      '--build-arg', `DSH_HARNESS_COMMIT=${harnessCommit}`,
      '--build-arg', `DSH_HARNESS_PATCH_SHA256=${patchSha256}`,
      '--build-arg', `DSH_PLUGINS_COMMIT=${pluginsCommit}`,
      '--build-arg', `DSH_RELEASE_COMMIT=${releaseToolCommit}`,
      ...imageLabelArgs,
      '--tag', imageTag, '--file', join(releaseTarget, 'release/Containerfile'), context,
    ], { code: exitCodes.test })

    const builtImageId = imageId(imageTag)
    const imageLabels = JSON.parse(run(engine, ['image', 'inspect', imageTag, '--format', '{{json .Config.Labels}}'], { capture: true, code: exitCodes.safety }))
    validateCandidateImageLabels(imageLabels, {
      pluginsCommit,
      releaseToolCommit,
      harnessCommit,
      harnessPatchSha256: patchSha256,
      purpose,
      workspaceMigration,
      composeSha256,
    }, 'built candidate')
    const testStartedAt = new Date().toISOString()
    const workspaceSelfTestEnvArgs = workspaceMigrationExpectedEnvArgs(workspaceMigration)
    const testOutput = run(engine, [
      'run', '--rm', '--read-only', '--user', '1000:1000',
      '--tmpfs', emptyTmpfsSpec('/tmp', 'rw,noexec,nosuid,size=512m'),
      '--tmpfs', emptyTmpfsSpec('/run', 'rw,nosuid,size=64m'),
      ...workspaceSelfTestEnvArgs,
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
    const candidateComposePath = purpose === 'release' ? join(candidateDir, 'compose.production.yml') : null
    if (candidateComposePath !== null) {
      copyFileSync(archivedComposePath, candidateComposePath)
      if (sha256File(candidateComposePath) !== composeSha256) {
        fail('归档 Compose 写入候选目录后的摘要改变', exitCodes.safety)
      }
    }
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
      archiveRoundTripCleanup = removeFormalImageForArchiveRoundTrip({
        imageTag,
        buildRoot,
      })
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
      schemaVersion: purpose === 'release' ? 3 : 2,
      candidateId: buildId,
      status: 'tested',
      purpose,
      imageId: builtImageId,
      imageTag,
      archivePath: purpose === 'release' ? archivePath : null,
      archiveSha256,
      archiveRoundTripCleanup,
      ...(purpose === 'release' ? { composePath: candidateComposePath, composeSha256 } : {}),
      harnessCommit,
      harnessPatchSha256: patchSha256,
      pluginsCommit,
      releaseToolCommit,
      baseImage: lock.image,
      baseImageDigest: lock.digest,
      builtAt: new Date().toISOString(),
      testReceiptPath: receiptPath,
      testReceiptSha256: sha256File(receiptPath),
      ...(purpose === 'release' ? { workspaceMigration } : {}),
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
    const running = [runtime.toolbox, runtime.web, runtime.telegram, runtime.fakeTelegram, runtime.fakeNotion].filter(devContainerRunning)
    if (running.length > 0) fail(`开发容器未全部退出，拒绝删除租约：${running.join(', ')}`, exitCodes.safety)
    rmSync(leasePath, { force: true })
    const cleanup = cleanupDevelopmentLease(lease)
    out({ result: 'development-retired', sourcePath, cleanup })
    return
  }
  if (['prepare', 'verify'].includes(action) && !options.source) fail(`dev ${action} 必须提供 --source <独立任务 worktree>`, exitCodes.usage)
  const sourcePath = resolve(options.source ?? repoRoot)
  const defaultDevelopmentCandidate = developmentCandidatePointerPath()
  const candidateValue = options.candidate
    ?? (['prepare', 'verify', 'shell'].includes(action) && existsSync(defaultDevelopmentCandidate) ? defaultDevelopmentCandidate : undefined)
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
    run(engine, ['run', '--rm', '--network', 'none', ...containerBaseArgs(homePath),
      candidate.imageTag, 'workspace-migrate'], { code: exitCodes.test })
    run(engine, ['run', '--rm', '--network', 'none', ...containerBaseArgs(homePath),
      '--env', `DSH_IMAGE_ID=${candidate.imageId}`, candidate.imageTag, 'prepare'], { code: exitCodes.test })
    run(engine, ['run', '--rm', '--network', 'none', ...containerBaseArgs(homePath),
      candidate.imageTag, 'harness-only-health'], { code: exitCodes.test })
    run(engine, ['network', 'create', '--internal', runtime.network], { code: exitCodes.test })
    startFakeNotion(candidate, runtime)
    startDevelopmentToolbox(candidate, runtime, homePath, [])
    run(engine, ['run', '--detach', '--name', runtime.fakeTelegram, '--network', runtime.network, '--network-alias', 'fake-telegram',
      ...developmentContainerLabels(runtime, 'fake-telegram'), '--read-only', '--tmpfs', emptyTmpfsSpec('/tmp'), candidate.imageTag, 'fake-telegram'], { code: exitCodes.test })
    run(engine, ['run', '--detach', '--name', runtime.telegram, '--network', runtime.network,
      ...developmentContainerLabels(runtime, 'telegram'), ...containerBaseArgs(homePath),
      '--env', 'TELEGRAM_BOT_TOKEN=test-token', '--env', 'TELEGRAM_ALLOWED_CHAT_ID=1', '--env', 'DEEPSEEK_API_KEY=test-key',
      candidate.imageTag, 'telegram-test'], { code: exitCodes.test })
    run(engine, ['run', '--detach', '--name', runtime.web, '--network', runtime.network,
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
    const result = { result: 'dev-started', web: 'container-exec/internal-no-external-route', homePath, data: reuseData ? 'reused' : 'materialized', network: runtime.network, runtime, leasePath: lease.leasePath, ...verification }
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
    run(engine, ['run', '--rm', '--network', 'none', ...containerBaseArgs(homePath), ...sourceArgs,
      '--env', `DSH_IMAGE_ID=${candidate.imageId}`, candidate.imageTag, 'dev-source-build'], { code: exitCodes.test })
    run(engine, ['run', '--rm', '--network', 'none', ...containerBaseArgs(homePath), ...sourceArgs,
      candidate.imageTag, 'workspace-migrate'], { code: exitCodes.test })
    run(engine, ['run', '--rm', '--network', 'none', ...containerBaseArgs(homePath), ...sourceArgs,
      '--env', `DSH_IMAGE_ID=${candidate.imageId}`, candidate.imageTag, 'prepare'], { code: exitCodes.test })
    run(engine, ['run', '--rm', '--network', 'none', ...containerBaseArgs(homePath), ...sourceArgs,
      candidate.imageTag, 'harness-only-health'], { code: exitCodes.test })
    run(engine, ['network', 'create', '--internal', runtime.network], { code: exitCodes.test })
    startFakeNotion(candidate, runtime, sourceArgs)
    startDevelopmentToolbox(candidate, runtime, homePath, sourceArgs)
    run(engine, ['run', '--detach', '--name', runtime.fakeTelegram, '--network', runtime.network, '--network-alias', 'fake-telegram',
      ...developmentContainerLabels(runtime, 'fake-telegram'), '--read-only', '--tmpfs', emptyTmpfsSpec('/tmp'), ...sourceArgs, candidate.imageTag, 'fake-telegram'], { code: exitCodes.test })
    run(engine, ['run', '--detach', '--name', runtime.telegram, '--network', runtime.network,
      ...developmentContainerLabels(runtime, 'telegram'), ...containerBaseArgs(homePath), ...sourceArgs,
      '--env', 'TELEGRAM_BOT_TOKEN=test-token', '--env', 'TELEGRAM_ALLOWED_CHAT_ID=1', '--env', 'DEEPSEEK_API_KEY=test-key',
      candidate.imageTag, 'telegram-test'], { code: exitCodes.test })
    run(engine, ['run', '--detach', '--name', runtime.web, '--network', runtime.network,
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
      web: 'container-exec/internal-no-external-route',
      homePath,
      data: 'fresh-isolated-production-snapshot',
      network: runtime.network,
      ...metadata,
      leasePath: lease.leasePath,
    }
    out(result)
    return result
  }
  if (action === 'verify') {
    if (candidatePurpose(candidate) !== 'development') {
      fail('dev verify 只接受 --purpose development 构建的开发底座，不能占用正式发版候选', exitCodes.safety)
    }
    const scope = options.package ?? 'all'
    if (scope !== 'all' && !developmentPackages.includes(scope)) {
      fail(`dev verify --package 必须是 all 或一个已挂载包: ${scope}`, exitCodes.usage)
    }
    const source = inspectDevelopmentSource(options.source)
    const harnessLock = readJson(join(releaseRoot, 'harness.lock.json'), 'Harness lock')
    if (candidate.pluginsCommit !== source.originMain) {
      fail(`开发基础镜像不是最新 main：candidate=${candidate.pluginsCommit}，origin/main=${source.originMain}`, exitCodes.safety)
    }
    if (candidate.harnessCommit !== harnessLock.commit) {
      fail(`开发基础镜像没有使用固定 Harness commit：candidate=${candidate.harnessCommit}，lock=${harnessLock.commit}`, exitCodes.safety)
    }
    const prior = existsSync(devMetaPath) ? readJson(devMetaPath, 'development metadata') : null
    if (prior?.mode !== 'editable-source') fail('dev verify 只验证已准备好的 editable-source 环境；请先执行 dev prepare', exitCodes.usage)
    const verifyRuntime = normalizeDevelopmentRuntime(prior.runtime) ?? runtime
    const leasePath = developmentLeasePath(source.sourcePath)
    if (!existsSync(leasePath)) fail('开发环境租约不存在；请重新执行 dev prepare', exitCodes.safety)
    const lease = readJson(leasePath, 'development lease')
    if (lease.candidateId !== candidate.candidateId || lease.imageId !== candidate.imageId) {
      fail('开发环境与当前共享 main 镜像不一致；请重新执行 dev prepare', exitCodes.safety)
    }
    if (!devContainerRunning(verifyRuntime.toolbox)) fail('开发 toolbox 没有运行；请重新执行 dev prepare', exitCodes.safety)
    const sourceFingerprint = editableSourceFingerprint(source.sourcePath)
    run(engine, [
      'exec', '--workdir', '/workspace/dsh-plugins', verifyRuntime.toolbox,
      'bash', '/opt/dsh/release-system/scripts/dev-source-verify.sh', scope,
    ], { code: exitCodes.test, cancelOnSignal: 'dev verify' })
    const completedSource = inspectDevelopmentSource(source.sourcePath)
    if (candidate.pluginsCommit !== completedSource.originMain) {
      fail(`验证期间 main 已更新：candidate=${candidate.pluginsCommit}，origin/main=${completedSource.originMain}；请先 rebase 并重建开发基础镜像`, exitCodes.safety)
    }
    const completedFingerprint = editableSourceFingerprint(completedSource.sourcePath)
    if (completedFingerprint !== sourceFingerprint) {
      fail('验证期间 editable source 已变化；拒绝为旧源码状态输出 verify 回执', exitCodes.safety)
    }
    const receipt = editableSourceReceipt(completedSource, candidate, scope, completedFingerprint)
    const result = {
      result: 'dev-source-verified',
      receipt,
      tests: {
        typeBuildBundle: scope === 'all' ? [...developmentPackages] : [scope],
        typeScript: scope === 'all' ? 'all-mounted-package-suites' : scope,
        python: scope === 'all' || scope === 'x-feed' ? 'x-feed unittest discover + test_insight_engine' : 'not-applicable',
      },
      runtime: verifyRuntime,
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
  fail('用法: dsh dev prepare --source <worktree> [--candidate <candidate.json>]；dsh dev verify --source <worktree> [--package <包名>]；dsh dev up --snapshot latest|synthetic；dsh dev shell；dsh dev down [--source <worktree>]；dsh dev retire --source <worktree>', exitCodes.usage)
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

function parsePrivateFreeJson(text, label) {
  try {
    const value = JSON.parse(text)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object')
    return value
  } catch {
    fail(`${label} 没有返回有效 JSON；为避免泄露状态正文，不回显原始输出`, exitCodes.test)
  }
}

function migrationPathRecord(path, root) {
  const relative = path.slice(root.length + 1)
  if (!existsSync(path) && !lstatMaybe(path)) return { path: relative, type: 'absent' }
  const entry = lstatSync(path)
  const mode = (entry.mode & 0o7777).toString(8).padStart(4, '0')
  if (entry.isSymbolicLink()) {
    return { path: relative, type: 'symlink', mode, targetSha256: sha256Text(readlinkSync(path)) }
  }
  if (entry.isFile()) return { path: relative, type: 'file', mode, size: entry.size, sha256: sha256File(path) }
  if (entry.isDirectory()) return { path: relative, type: 'directory', mode }
  return { path: relative, type: 'special', mode }
}

function lstatMaybe(path) {
  try { return lstatSync(path) } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

function migrationStateFingerprint(dshHome) {
  const relativePaths = [
    'workspace/AGENTS.md',
    'workspace/MEMORY.md',
    'migration-receipts/harness-only-workspace-v1.json',
    'storages/dsh-cron/jobs.jsonl',
    'storages/dsh-cron/runs.jsonl',
  ]
  const records = relativePaths.map(relative => migrationPathRecord(join(dshHome, relative), dshHome))
  const automations = join(dshHome, 'workspace/automations')
  records.push({
    path: 'workspace/automations',
    type: existsSync(automations) ? 'tree' : 'absent',
    sha256: existsSync(automations) ? sha256Tree(automations) : null,
  })
  return sha256Text(JSON.stringify(records))
}

function validateWorkspaceMigrationReceipt(receipt, { secondRun = false } = {}) {
  const allowedStatuses = secondRun ? ['already-applied'] : ['applied', 'already-applied']
  if (!allowedStatuses.includes(receipt.status)
    || receipt.migrationId !== 'harness-only-workspace-v1'
    || receipt.migrationVersion !== 1
    || !/^[0-9a-f]{64}$/u.test(receipt.manifestSha256 ?? '')
    || !/^[0-9a-f]{64}$/u.test(receipt.receiptSha256 ?? '')) {
    fail('workspace migration 回执不符合幂等发布合同', exitCodes.test)
  }
  return receipt
}

function validateReanchorReceipt(receipt, request, { secondRun = false } = {}) {
  const required = ['status', 'migrationVersion', 'migrationId', 'inputSha256', 'cronJobCount', 'appendedCount', 'jobs']
  if (Object.keys(receipt).sort().join('\0') !== required.sort().join('\0')
    || receipt.migrationVersion !== 1
    || receipt.migrationId !== request.migrationId
    || !/^[0-9a-f]{64}$/u.test(receipt.inputSha256 ?? '')
    || !Number.isSafeInteger(receipt.cronJobCount) || receipt.cronJobCount < 1
    || !Number.isSafeInteger(receipt.appendedCount) || receipt.appendedCount < 0
    || receipt.appendedCount > receipt.cronJobCount
    || !Array.isArray(receipt.jobs) || receipt.jobs.length !== receipt.cronJobCount
    || (secondRun && (receipt.status !== 'already-applied' || receipt.appendedCount !== 0))
    || (!secondRun && !['reanchored', 'already-applied'].includes(receipt.status))) {
    fail('schedule reanchor 回执不符合幂等发布合同', exitCodes.test)
  }
  const jobIds = new Set()
  for (const job of receipt.jobs) {
    if (!job || typeof job !== 'object' || Array.isArray(job)
      || Object.keys(job).sort().join('\0') !== ['changed', 'jobId', 'nextRunAt', 'scheduleSha256'].sort().join('\0')
      || typeof job.jobId !== 'string' || job.jobId.length === 0 || jobIds.has(job.jobId)
      || !/^[0-9a-f]{64}$/u.test(job.scheduleSha256 ?? '')
      || typeof job.nextRunAt !== 'string' || !Number.isFinite(Date.parse(job.nextRunAt))
      || typeof job.changed !== 'boolean' || (secondRun && job.changed)) {
      fail('schedule reanchor job 回执不符合脱敏发布合同', exitCodes.test)
    }
    jobIds.add(job.jobId)
  }
  return receipt
}

function validateReanchorEvidence(value, label = 'schedule reanchor evidence') {
  const keys = [
    'schemaVersion', 'migrationVersion', 'migrationId', 'fromTimeZone', 'toTimeZone',
    'cutoverAt', 'reanchoredAt', 'inputSha256', 'cronJobCount', 'jobs',
  ]
  const canonicalIso = candidate => typeof candidate === 'string'
    && Number.isFinite(Date.parse(candidate))
    && new Date(candidate).toISOString() === candidate
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('\0') !== keys.sort().join('\0')
    || value.schemaVersion !== 1 || value.migrationVersion !== 1
    || value.migrationId !== 'dsh-cron-shanghai-reanchor-v1'
    || value.fromTimeZone !== 'Etc/UTC' || value.toTimeZone !== 'Asia/Shanghai'
    || !canonicalIso(value.cutoverAt) || !canonicalIso(value.reanchoredAt)
    || !/^[0-9a-f]{64}$/u.test(value.inputSha256 ?? '')
    || !Number.isSafeInteger(value.cronJobCount) || value.cronJobCount < 1
    || !Array.isArray(value.jobs) || value.jobs.length !== value.cronJobCount) {
    fail(`${label} 不符合精确 schema v1`, exitCodes.safety)
  }
  const jobIds = new Set()
  const jobs = value.jobs.map(job => {
    if (!job || typeof job !== 'object' || Array.isArray(job)
      || Object.keys(job).sort().join('\0') !== ['jobId', 'nextRunAt', 'scheduleSha256'].sort().join('\0')
      || typeof job.jobId !== 'string' || job.jobId.length === 0 || jobIds.has(job.jobId)
      || !/^[0-9a-f]{64}$/u.test(job.scheduleSha256 ?? '')
      || !canonicalIso(job.nextRunAt)) {
      fail(`${label} 的 job 证据不符合精确 schema v1`, exitCodes.safety)
    }
    jobIds.add(job.jobId)
    return { jobId: job.jobId, scheduleSha256: job.scheduleSha256, nextRunAt: job.nextRunAt }
  }).sort((left, right) => left.jobId.localeCompare(right.jobId))
  return {
    schemaVersion: 1,
    migrationVersion: 1,
    migrationId: value.migrationId,
    fromTimeZone: value.fromTimeZone,
    toTimeZone: value.toTimeZone,
    cutoverAt: value.cutoverAt,
    reanchoredAt: value.reanchoredAt,
    inputSha256: value.inputSha256,
    cronJobCount: value.cronJobCount,
    jobs,
  }
}

function reanchorEvidenceFromResult(request, receipt) {
  validateReanchorReceipt(receipt, request)
  return validateReanchorEvidence({
    schemaVersion: 1,
    migrationVersion: request.migrationVersion,
    migrationId: request.migrationId,
    fromTimeZone: request.fromTimeZone,
    toTimeZone: request.toTimeZone,
    cutoverAt: request.cutoverAt,
    reanchoredAt: request.reanchoredAt,
    inputSha256: receipt.inputSha256,
    cronJobCount: receipt.cronJobCount,
    jobs: receipt.jobs.map(({ jobId, scheduleSha256, nextRunAt }) => ({ jobId, scheduleSha256, nextRunAt })),
  })
}

function validateReanchorInspectionReceipt(receipt, evidence, label = 'schedule reanchor inspection') {
  const canonicalEvidence = validateReanchorEvidence(evidence, `${label} accepted evidence`)
  const keys = ['status', 'ledgerRecordCount', ...Object.keys(canonicalEvidence)]
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)
    || Object.keys(receipt).sort().join('\0') !== keys.sort().join('\0')
    || receipt.status !== 'verified'
    || !Number.isSafeInteger(receipt.ledgerRecordCount)
    || receipt.ledgerRecordCount !== canonicalEvidence.cronJobCount) {
    fail(`${label} 回执不符合只读验证合同`, exitCodes.safety)
  }
  const returnedEvidence = validateReanchorEvidence(Object.fromEntries(
    Object.keys(canonicalEvidence).map(key => [key, receipt[key]]),
  ), `${label} returned evidence`)
  if (JSON.stringify(returnedEvidence) !== JSON.stringify(canonicalEvidence)) {
    fail(`${label} 返回的证据与 accepted evidence 不同`, exitCodes.safety)
  }
  return receipt
}

function reanchorRequestFromPrevious(currentRelease) {
  const prior = currentRelease.production?.scheduleReanchor
  if (prior !== undefined) {
    if (!prior || typeof prior !== 'object' || Array.isArray(prior)
      || prior.status !== 'complete' || prior.evidence === undefined) {
      fail('上一 accepted release 声称存在 schedule reanchor，但缺少可核验的完整证据', exitCodes.safety)
    }
    const evidence = validateReanchorEvidence(prior.evidence, '上一 accepted release schedule reanchor evidence')
    return {
      required: false,
      inheritedFrom: currentRelease.releaseId,
      migrationVersion: evidence.migrationVersion,
      migrationId: evidence.migrationId,
      fromTimeZone: evidence.fromTimeZone,
      toTimeZone: evidence.toTimeZone,
      cutoverAt: evidence.cutoverAt,
      reanchoredAt: evidence.reanchoredAt,
      evidence,
    }
  }
  const cutoverAt = new Date().toISOString()
  return {
    required: true,
    migrationVersion: 1,
    migrationId: 'dsh-cron-shanghai-reanchor-v1',
    fromTimeZone: 'Etc/UTC',
    toTimeZone: 'Asia/Shanghai',
    cutoverAt,
    reanchoredAt: cutoverAt,
  }
}

function cronReanchorArgs(request) {
  return [
    'cron-reanchor',
    '--migration-id', request.migrationId,
    '--cutover-at', request.cutoverAt,
    '--reanchored-at', request.reanchoredAt,
  ]
}

function releasePlan(candidate, notionCredential, notionAutomation) {
  return {
    candidateId: candidate.candidateId,
    imageId: candidate.imageId,
    archiveSha256: candidate.archiveSha256,
    target,
    notionCredential,
    notionAutomation,
    writersToStop: ['Docker Compose project dsh'],
    excludedExternalSystems: ['OpenClaw is neither required nor managed by this release'],
    snapshotRoot: '/home/herman/.local/share/dsh-container/snapshots',
    rollbackBoundary: '停机前完整 ~/.dsh 快照 + 上一个 accepted Docker release',
    authorizationGates: ['production-downtime', 'production-release'],
    next: '获得停机许可后重新执行同一 candidate，并仅添加 --approved-stop；停机快照完成后工具会输出独立的 --approved-release 命令。',
  }
}

function commandRelease(options) {
  const optionNames = Object.keys(options).filter(name => name !== '_').sort()
  if (options._.length !== 0) fail('release 不接受位置参数', exitCodes.usage)
  const allowed = options['approved-release']
    ? ['approved-release', 'release']
    : [...(options.candidate ? ['candidate'] : []), ...(options['approved-stop'] ? ['approved-stop'] : [])]
  if (optionNames.length !== allowed.length || optionNames.some(name => !allowed.includes(name))) {
    fail('release 参数必须精确匹配 preview/停机授权/独立发布授权合同', exitCodes.usage)
  }
  if (options['approved-stop'] && options['approved-release']) {
    fail('停机授权与生产发布授权必须分两次独立执行，不能同时提供', exitCodes.usage)
  }
  if (options['approved-release']) {
    if (!options.release || options.candidate) {
      fail('--approved-release 必须且只能配合 --release <waiting release>', exitCodes.usage)
    }
    return resumeProductionRelease(options.release)
  }
  if (options.release) fail('--release 只用于独立的 --approved-release continuation', exitCodes.usage)
  const requestedCandidatePath = options.candidate ? resolve(options.candidate) : join(stateRoot, 'candidates/latest.json')
  if (candidatePurpose(readJson(requestedCandidatePath, 'candidate')) !== 'release') {
    fail('development 候选不能发布；请重新构建 --purpose release 的唯一正式候选', exitCodes.safety)
  }
  const { candidate, path: candidatePath } = candidateFrom(requestedCandidatePath)
  requireExactReleaseTree(candidate.releaseToolCommit, '生产 release 编排')
  requireLatestMainAncestor(candidate.pluginsCommit, '候选插件 commit')
  requireLatestMainAncestor(candidate.releaseToolCommit, '候选发版工具 commit')
  const notionCredential = verifyProductionNotionCredential(candidate)
  const notionAutomation = verifyProductionNotionAutomation(candidate)
  if (!options['approved-stop']) {
    out({ status: 'waiting-for-downtime-authorization', ...releasePlan(candidate, notionCredential, notionAutomation) })
    process.exitCode = exitCodes.approval
    return
  }
  performProductionRelease(candidate, candidatePath, notionCredential, notionAutomation)
}

function validateWaitingReanchorRequest(request) {
  const common = [
    'required', 'migrationVersion', 'migrationId', 'fromTimeZone', 'toTimeZone',
    'cutoverAt', 'reanchoredAt',
  ]
  const required = request?.required === false ? [...common, 'inheritedFrom', 'evidence'] : common
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || Object.keys(request).sort().join('\0') !== required.sort().join('\0')
    || typeof request.required !== 'boolean'
    || request.migrationVersion !== 1
    || request.migrationId !== 'dsh-cron-shanghai-reanchor-v1'
    || request.fromTimeZone !== 'Etc/UTC' || request.toTimeZone !== 'Asia/Shanghai'
    || typeof request.cutoverAt !== 'string' || !Number.isFinite(Date.parse(request.cutoverAt))
    || typeof request.reanchoredAt !== 'string' || !Number.isFinite(Date.parse(request.reanchoredAt))
    || (request.required === false && (typeof request.inheritedFrom !== 'string' || request.inheritedFrom.length === 0))) {
    fail('waiting release 的 schedule reanchor request 不完整', exitCodes.safety)
  }
  if (request.required === false) {
    const evidence = validateReanchorEvidence(request.evidence, 'waiting release schedule reanchor evidence')
    for (const key of ['migrationVersion', 'migrationId', 'fromTimeZone', 'toTimeZone', 'cutoverAt', 'reanchoredAt']) {
      if (request[key] !== evidence[key]) fail('waiting release 的 reanchor request 与 accepted evidence 不一致', exitCodes.safety)
    }
  }
}

function waitingReleaseFrom(value) {
  if (!value) fail('--release 必填', exitCodes.usage)
  const path = existsSync(value) ? resolve(value) : join(stateRoot, 'releases', value, 'release.json')
  requireRegularCandidateArtifact(path, 'waiting release.json')
  const release = readJson(path, 'waiting release')
  const required = [
    'schemaVersion', 'releaseId', 'status', 'currentStage', 'candidatePath', 'candidate',
    'snapshot', 'previous', 'preflight', 'production', 'createdAt', 'userAcceptance',
    'rollbackBoundary', 'cleanup',
  ]
  const expectedPath = join(stateRoot, 'releases', release.releaseId ?? '', 'release.json')
  const expectedSnapshotPath = join(stateRoot, 'snapshots', release.releaseId ?? '', 'home.tar.zst')
  const expectedRemoteSnapshot = `/home/herman/.local/share/dsh-container/snapshots/${release.releaseId ?? ''}.tar.zst`
  const snapshotFields = ['schemaVersion', 'snapshotId', 'archivePath', 'archiveSha256', 'remoteArchivePath', 'createdAt']
  const previousFields = ['mode', 'releaseId', 'remoteDir', 'candidate', 'engineImageId']
  const rollbackFields = ['status', 'previousReleaseId', 'snapshotId', 'snapshotArchiveSha256']
  if (release.schemaVersion !== 1
    || Object.keys(release).sort().join('\0') !== required.sort().join('\0')
    || !formalBuildName.test(release.releaseId ?? '')
    || release.status !== 'waiting-for-release-authorization'
    || release.currentStage !== 'waiting-for-release-authorization'
    || path !== expectedPath
    || release.production !== null || release.userAcceptance !== null || release.cleanup !== null
    || !release.snapshot || Object.keys(release.snapshot).sort().join('\0') !== snapshotFields.sort().join('\0')
    || release.snapshot.schemaVersion !== 1 || release.snapshot.snapshotId !== release.releaseId
    || resolve(release.snapshot.archivePath ?? '') !== expectedSnapshotPath
    || release.snapshot.remoteArchivePath !== expectedRemoteSnapshot
    || !/^sha256:[0-9a-f]{64}$/u.test(release.snapshot.archiveSha256 ?? '')
    || typeof release.snapshot.createdAt !== 'string' || !Number.isFinite(Date.parse(release.snapshot.createdAt))
    || !release.previous || Object.keys(release.previous).sort().join('\0') !== previousFields.sort().join('\0')
    || release.previous.mode !== 'docker' || typeof release.previous.releaseId !== 'string'
    || release.previous.remoteDir !== `/home/herman/.local/share/dsh-container/releases/${release.previous.releaseId}`
    || Object.keys(release.previous.candidate ?? {}).sort().join('\0') !== ['imageId', 'imageTag'].sort().join('\0')
    || typeof release.previous.candidate.imageId !== 'string' || typeof release.previous.candidate.imageTag !== 'string'
    || typeof release.previous.engineImageId !== 'string'
    || Object.keys(release.preflight ?? {}).sort().join('\0') !== ['notionAutomation', 'notionCredential', 'reanchorRequest', 'remote'].sort().join('\0')
    || typeof release.preflight.remote !== 'string' || release.preflight.remote.length === 0
    || !release.preflight.notionCredential
    || !release.preflight.notionAutomation
    || !release.rollbackBoundary || Object.keys(release.rollbackBoundary).sort().join('\0') !== rollbackFields.sort().join('\0')
    || release.rollbackBoundary.status !== 'production-stopped-snapshot-available'
    || release.rollbackBoundary.previousReleaseId !== release.previous.releaseId
    || release.rollbackBoundary.snapshotId !== release.snapshot.snapshotId
    || release.rollbackBoundary.snapshotArchiveSha256 !== release.snapshot.archiveSha256
    || typeof release.createdAt !== 'string' || !Number.isFinite(Date.parse(release.createdAt))) {
    fail('release 记录不是精确的停机后待发布状态', exitCodes.safety)
  }
  validateWaitingReanchorRequest(release.preflight.reanchorRequest)
  parseNotionReceipt(JSON.stringify(release.preflight.notionCredential), 'waiting release Notion credential')
  parseNotionAutomationReceipt(JSON.stringify(release.preflight.notionAutomation), 'waiting release Notion automation')
  const { candidate, path: candidatePath } = candidateFrom(release.candidatePath)
  if (candidatePath !== resolve(release.candidatePath)
    || JSON.stringify(candidate) !== JSON.stringify(release.candidate)) {
    fail('waiting release 的 candidate 已漂移', exitCodes.safety)
  }
  return { path, release, candidate, candidatePath }
}

function resumeProductionRelease(value) {
  const waiting = waitingReleaseFrom(value)
  requireExactReleaseTree(waiting.candidate.releaseToolCommit, '生产 approved-release 编排')
  requireLatestMainAncestor(waiting.candidate.pluginsCommit, '候选插件 commit')
  requireLatestMainAncestor(waiting.candidate.releaseToolCommit, '候选发版工具 commit')
  const notionCredential = verifyProductionNotionCredential(waiting.candidate)
  const notionAutomation = verifyProductionNotionAutomation(waiting.candidate)
  if (JSON.stringify(notionAutomation) !== JSON.stringify(waiting.release.preflight.notionAutomation)) {
    fail('停机后线上 Harness-owned Notion automation 已漂移，拒绝继续发布', exitCodes.production)
  }
  return performProductionRelease(waiting.candidate, waiting.candidatePath, notionCredential, notionAutomation, {
    resumeEvidence: waiting.release,
    releasePath: waiting.path,
  })
}

function performProductionRelease(candidate, candidatePath, notionCredential, notionAutomation, { resumeEvidence = null, releasePath: resumedPath = null } = {}) {
  const releaseId = resumeEvidence?.releaseId ?? `${nowId()}-${candidate.pluginsCommit.slice(0, 12)}`
  const localReleaseDir = resumeEvidence === null ? join(stateRoot, 'releases', releaseId) : dirname(resumedPath)
  const localSnapshotDir = join(stateRoot, 'snapshots', releaseId)
  const releasePath = resumedPath ?? join(localReleaseDir, 'release.json')
  ensureDir(localReleaseDir)
  ensureDir(localSnapshotDir)
  const evidence = resumeEvidence ?? {
    schemaVersion: 1,
    releaseId,
    status: 'prepared',
    currentStage: 'remote-preflight',
    candidatePath,
    candidate,
    snapshot: null,
    previous: null,
    preflight: { notionCredential, notionAutomation },
    production: null,
    createdAt: new Date().toISOString(),
    userAcceptance: null,
    rollbackBoundary: null,
    cleanup: null,
  }
  const stage = (currentStage, details = {}) => {
    evidence.currentStage = currentStage
    Object.assign(evidence, details)
    writeJson(releasePath, evidence)
  }
  if (resumeEvidence === null) stage('remote-preflight')
  else stage('release-authorization-approved', {
    status: 'releasing',
    preflight: { ...evidence.preflight, notionCredential, notionAutomation },
  })
  try {
    return performProductionReleaseUnsafe(candidate, candidatePath, releaseId, notionCredential, notionAutomation, stage, { resumeEvidence })
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

function stoppedWritersVerificationShell() {
  return `
compose_ids="$(docker ps --all --quiet --filter label=com.docker.compose.project=dsh)"
if test -n "$compose_ids"; then
  echo "DSH Compose containers remain after stop: $compose_ids" >&2
  exit 43
fi
if docker ps --format '{{.Names}}' | grep -Eq '^dsh-'; then
  echo 'DSH-named container remains active after stop' >&2
  exit 43
fi
if pgrep -u "$(id -u)" -af '(/opt/dsh/harness/|deepseek-harness/.*/apps/cli/|apps/cli/(src/bin\\.ts|lib/bin\\.js))' >/dev/null; then
  echo 'DSH Harness process remains active after stop' >&2
  exit 44
fi
if command -v systemctl >/dev/null; then
  running_units="$(systemctl --user --no-legend --plain --state=running --type=service 'dsh*')" || {
    echo 'cannot enumerate DSH user services' >&2
    exit 44
  }
  if test -n "$running_units"; then
    echo "DSH user services remain active after stop: $running_units" >&2
    exit 44
  fi
fi
`
}

function performProductionReleaseUnsafe(candidate, candidatePath, releaseId, notionCredential, notionAutomation, stage, { resumeEvidence = null } = {}) {
  const localReleaseDir = join(stateRoot, 'releases', releaseId)
  const localSnapshotDir = join(stateRoot, 'snapshots', releaseId)
  ensureDir(localReleaseDir)
  ensureDir(localSnapshotDir)

  const remoteRoot = '/home/herman/.local/share/dsh-container'
  const remoteReleaseDir = `${remoteRoot}/releases/${releaseId}`
  let preflight
  let currentRelease
  let previous
  let remoteSnapshot
  let reanchorRequest
  let localSnapshot
  let snapshotMeta
  let snapshotMetaPath

  if (resumeEvidence === null) {
    preflight = ssh(`set -Eeuo pipefail
command -v docker >/dev/null || { echo 'Docker 未安装；请先在 herman.hermes 安装 docker.io 和 docker-compose-v2' >&2; exit 41; }
docker compose version >/dev/null
docker info >/dev/null
printf '%s\n' 'docker-ready'
`)

    const previousText = ssh(`set -Eeuo pipefail
root=${shellQuote(remoteRoot)}
test -f "$root/current/release.json" || { echo '当前生产不是可识别的 Docker release' >&2; exit 42; }
cat "$root/current/release.json"
`)
    currentRelease = JSON.parse(previousText)
    if (currentRelease.status !== 'accepted') fail(`当前 Docker release 尚未 accepted，状态是 ${currentRelease.status ?? 'missing'}`, exitCodes.production)
    previous = {
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
    remoteSnapshot = `${remoteRoot}/snapshots/${releaseId}.tar.zst`
    stage('stop-writers-and-snapshot', {
      previous,
      preflight: { remote: preflight, notionCredential, notionAutomation },
    })
    const stopOutput = ssh(`set -Eeuo pipefail
root=${shellQuote(remoteRoot)}
release_id=${shellQuote(releaseId)}
mkdir -p "$root/releases/$release_id" "$root/snapshots"
if test -f "$root/current/compose.production.yml"; then
  DSH_IMAGE=dummy DSH_IMAGE_ID=dummy docker compose -p dsh -f "$root/current/compose.production.yml" down --timeout 30
else
  echo '当前 Docker release 缺少 compose.production.yml' >&2
  exit 43
fi
${stoppedWritersVerificationShell()}
tar --acls --xattrs -C /home/herman -cf - .dsh | zstd -T0 -10 -o ${shellQuote(remoteSnapshot)}
chmod 600 ${shellQuote(remoteSnapshot)}
sha="sha256:$(sha256sum ${shellQuote(remoteSnapshot)} | awk '{print $1}')"
cat >"$root/releases/$release_id/stop.json" <<EOF
{"releaseId":"$release_id","archivePath":${JSON.stringify(remoteSnapshot)},"archiveSha256":"$sha"}
EOF
cat "$root/releases/$release_id/stop.json"
  `)
    let stopMeta
    try { stopMeta = JSON.parse(stopOutput.split('\n').at(-1)) } catch { fail(`无法解析停机快照回执: ${stopOutput}`, exitCodes.production) }
    // The cutover anchor is created only after every writer is stopped and the
    // consistent snapshot is closed.  Creating it before `compose down` would
    // leave a race in which a final production claim could occur after cutover.
    reanchorRequest = reanchorRequestFromPrevious(currentRelease)

    stage('verify-snapshot', {
      preflight: { remote: preflight, notionCredential, notionAutomation, reanchorRequest },
    })
    localSnapshot = join(localSnapshotDir, 'home.tar.zst')
    run('scp', ['-p', `${target}:${remoteSnapshot}`, localSnapshot], { code: exitCodes.production })
    if (sha256File(localSnapshot) !== stopMeta.archiveSha256) fail('停机快照传输摘要不一致；生产保持停止，等待人工裁决', exitCodes.production)
    snapshotMeta = { schemaVersion: 1, snapshotId: releaseId, archivePath: localSnapshot, archiveSha256: stopMeta.archiveSha256, remoteArchivePath: remoteSnapshot, createdAt: new Date().toISOString() }
    snapshotMetaPath = join(localSnapshotDir, 'snapshot.json')
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
    stage('waiting-for-release-authorization', {
      status: 'waiting-for-release-authorization',
      snapshot: snapshotMeta,
      rollbackBoundary: {
        status: 'production-stopped-snapshot-available',
        previousReleaseId: previous.releaseId,
        snapshotId: snapshotMeta.snapshotId,
        snapshotArchiveSha256: snapshotMeta.archiveSha256,
      },
    })
    const waitingPath = join(localReleaseDir, 'release.json')
    out({
      result: 'production-stopped-awaiting-release-authorization',
      releaseId,
      releasePath: waitingPath,
      snapshot: { snapshotId: snapshotMeta.snapshotId, archiveSha256: snapshotMeta.archiveSha256 },
      next: `确认独立的生产发布授权后执行 ./release/dsh release --release ${releaseId} --approved-release`,
    })
    return
  }

  preflight = ssh(`set -Eeuo pipefail
command -v docker >/dev/null || exit 41
docker compose version >/dev/null
docker info >/dev/null
${stoppedWritersVerificationShell()}
test -f ${shellQuote(resumeEvidence.snapshot.remoteArchivePath)}
test "sha256:$(sha256sum ${shellQuote(resumeEvidence.snapshot.remoteArchivePath)} | awk '{print $1}')" = ${shellQuote(resumeEvidence.snapshot.archiveSha256)}
printf '%s\n' 'docker-ready-production-still-stopped'
`)
  const previousText = ssh(`set -Eeuo pipefail
root=${shellQuote(remoteRoot)}
test -f "$root/current/release.json"
cat "$root/current/release.json"
`)
  currentRelease = JSON.parse(previousText)
  previous = resumeEvidence.previous
  if (currentRelease.status !== 'accepted'
    || currentRelease.releaseId !== previous.releaseId
    || currentRelease.candidate?.imageId !== previous.candidate?.imageId
    || currentRelease.candidate?.imageTag !== previous.candidate?.imageTag
    || currentRelease.production?.engineImageId !== previous.engineImageId) {
    fail('停机后 current release 边界已经漂移，拒绝继续生产发布', exitCodes.production)
  }
  remoteSnapshot = resumeEvidence.snapshot.remoteArchivePath
  reanchorRequest = resumeEvidence.preflight.reanchorRequest
  localSnapshot = resumeEvidence.snapshot.archivePath
  snapshotMeta = resumeEvidence.snapshot
  snapshotMetaPath = join(localSnapshotDir, 'snapshot.json')
  if (!existsSync(snapshotMetaPath)
    || JSON.stringify(readJson(snapshotMetaPath, 'stopped snapshot metadata')) !== JSON.stringify(snapshotMeta)
    || !existsSync(localSnapshot)
    || sha256File(localSnapshot) !== snapshotMeta.archiveSha256) {
    fail('停机快照本地 continuation 证据不完整或已漂移', exitCodes.safety)
  }
  stage('snapshot-copy-tests', {
    status: 'releasing',
    snapshot: snapshotMeta,
    previous,
    preflight: { ...resumeEvidence.preflight, remoteResume: preflight, notionCredential, notionAutomation },
  })

  const preflightRoot = join(localReleaseDir, 'preflight')
  const testHome = join(preflightRoot, 'home/herman')
  let stateReceipt
  let selfTest
  let runtimeReceipt
  let migrationPreflight
  const preflightSourcePath = join(localReleaseDir, 'preflight-runtime')
  try {
    ensureDir(testHome)
    run('tar', ['--zstd', '-xf', localSnapshot, '-C', testHome], { code: exitCodes.test })
    // Scrub before the snapshot is mounted into any candidate container.  The
    // host-side scrubber comes from the exact releaseToolCommit already bound
    // into the candidate image, never from the mutable checkout.
    const scrubToolRoot = join(preflightRoot, 'candidate-release-tool')
    const scrubToolArchive = join(preflightRoot, 'candidate-release-tool.tar')
    ensureDir(scrubToolRoot)
    run('git', [
      '-C', repoRoot, 'archive', '--format=tar', `--output=${scrubToolArchive}`,
      candidate.releaseToolCommit, 'release/scripts/scrub-preflight-state.py',
    ], { code: exitCodes.safety })
    run('tar', ['-xf', scrubToolArchive, '-C', scrubToolRoot], { code: exitCodes.safety })
    const scrubReceipt = parsePrivateFreeJson(run('python3', [
      join(scrubToolRoot, 'release/scripts/scrub-preflight-state.py'),
      '--dsh-home', join(testHome, '.dsh'),
      '--preflight-root', preflightRoot,
    ], { capture: true, code: exitCodes.test }), 'snapshot credential scrub')
    if (scrubReceipt.status !== 'scrubbed' || scrubReceipt.externalNetworkRequired !== false) {
      fail('snapshot credential scrub 回执不符合隔离合同', exitCodes.test)
    }
    const baseArgs = containerBaseArgs(testHome)
    const isolatedArgs = ['run', '--rm', '--network', 'none', ...baseArgs]

    const contentReceipt = parsePrivateFreeJson(run(engine, [
      ...isolatedArgs,
      ...workspaceMigrationExpectedEnvArgs(candidate.workspaceMigration),
      candidate.imageTag,
      'workspace-migration-verify',
    ], { capture: true, code: exitCodes.test }), 'candidate workspace migration content')
    if (contentReceipt.status !== 'verified' || contentReceipt.metadataBound !== true) {
      fail('候选镜像迁移字节未绑定 candidate metadata', exitCodes.test)
    }

    const workspaceFirst = validateWorkspaceMigrationReceipt(parsePrivateFreeJson(run(engine, [
      ...isolatedArgs,
      candidate.imageTag,
      'workspace-migrate',
    ], { capture: true, code: exitCodes.test }), 'workspace migration first run'))

    let reanchorFirst = null
    let reanchorSecond = null
    let reanchorInspection = null
    if (reanchorRequest.required) {
      reanchorFirst = validateReanchorReceipt(parsePrivateFreeJson(run(engine, [
        ...isolatedArgs,
        candidate.imageTag,
        ...cronReanchorArgs(reanchorRequest),
      ], { capture: true, code: exitCodes.test }), 'schedule reanchor first run'), reanchorRequest)
    } else {
      const evidenceRelativePath = '.dsh/migration-receipts/dsh-cron-shanghai-reanchor-v1.accepted.json'
      const evidenceHostPath = join(testHome, evidenceRelativePath)
      writeJson(evidenceHostPath, reanchorRequest.evidence)
      chmodSync(evidenceHostPath, 0o600)
      reanchorInspection = validateReanchorInspectionReceipt(parsePrivateFreeJson(run(engine, [
        ...isolatedArgs,
        candidate.imageTag,
        'cron-reanchor-inspect',
        '--evidence-file', `/home/herman/${evidenceRelativePath}`,
      ], { capture: true, code: exitCodes.test }), 'accepted schedule reanchor snapshot inspection'), reanchorRequest.evidence)
    }
    const firstFingerprint = migrationStateFingerprint(join(testHome, '.dsh'))

    const workspaceSecond = validateWorkspaceMigrationReceipt(parsePrivateFreeJson(run(engine, [
      ...isolatedArgs,
      candidate.imageTag,
      'workspace-migrate',
    ], { capture: true, code: exitCodes.test }), 'workspace migration second run'), { secondRun: true })
    if (reanchorRequest.required) {
      reanchorSecond = validateReanchorReceipt(parsePrivateFreeJson(run(engine, [
        ...isolatedArgs,
        candidate.imageTag,
        ...cronReanchorArgs(reanchorRequest),
      ], { capture: true, code: exitCodes.test }), 'schedule reanchor second run'), reanchorRequest, { secondRun: true })
    }
    const secondFingerprint = migrationStateFingerprint(join(testHome, '.dsh'))
    if (secondFingerprint !== firstFingerprint) {
      fail('生产快照副本的第二次迁移改变了状态；拒绝发布', exitCodes.test)
    }

    run(engine, [
      ...isolatedArgs,
      '--env', `DSH_IMAGE_ID=${candidate.imageId}`,
      candidate.imageTag,
      'prepare',
    ], { code: exitCodes.test })
    const harnessHealth = parsePrivateFreeJson(run(engine, [
      ...isolatedArgs,
      candidate.imageTag,
      'harness-only-health',
    ], { capture: true, code: exitCodes.test }), 'Harness-only state health')
    if (harnessHealth.status !== 'pass') fail('生产快照副本未通过 Harness-only health', exitCodes.test)

    stateReceipt = run(engine, [
      ...isolatedArgs,
      candidate.imageTag,
      'validate-state', '/home/herman/.dsh',
    ], { capture: true, code: exitCodes.test })
    writeFileSync(join(localReleaseDir, 'state-validation.json'), `${stateReceipt}\n`)
    selfTest = run(engine, [
      'run', '--rm', '--network', 'none', '--read-only', '--user', '1000:1000',
      '--tmpfs', emptyTmpfsSpec('/tmp'), '--tmpfs', emptyTmpfsSpec('/run'),
      ...workspaceMigrationExpectedEnvArgs(candidate.workspaceMigration),
      candidate.imageTag, 'self-test',
    ], { capture: true, code: exitCodes.test })
    writeFileSync(join(localReleaseDir, 'preflight-tests.txt'), `${selfTest}\n`)
    migrationPreflight = {
      scrub: scrubReceipt,
      candidateContent: contentReceipt,
      workspace: { first: workspaceFirst, second: workspaceSecond },
      scheduleReanchor: reanchorRequest.required
        ? { request: reanchorRequest, first: reanchorFirst, second: reanchorSecond }
        : { request: reanchorRequest, inspection: reanchorInspection },
      stateFingerprint: secondFingerprint,
      harnessHealth,
    }
    writeJson(join(localReleaseDir, 'migration-preflight.json'), migrationPreflight)
    runtimeReceipt = runPreflightRuntime(candidate, testHome, preflightSourcePath, notionAutomation)
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
  const admittedComposePath = join(localReleaseDir, 'compose.production.yml')
  copyFileSync(candidate.composePath, admittedComposePath)
  if (sha256File(admittedComposePath) !== candidate.composeSha256) {
    fail('传输前 candidate Compose 摘要发生漂移', exitCodes.safety)
  }
  const admittedCandidatePath = join(localReleaseDir, 'candidate.json')
  writeJson(admittedCandidatePath, candidate)
  run('ssh', ['-o', 'BatchMode=yes', target, 'mkdir', '-p', remoteReleaseDir], { code: exitCodes.production })
  run('scp', ['-p', candidate.archivePath, `${target}:${remoteReleaseDir}/image.tar`], { code: exitCodes.production })
  run('scp', ['-p', admittedComposePath, `${target}:${remoteReleaseDir}/compose.production.yml`], { code: exitCodes.production })
  run('scp', ['-p', admittedCandidatePath, `${target}:${remoteReleaseDir}/candidate.json`], { code: exitCodes.production })
  if (!reanchorRequest.required) {
    const admittedReanchorEvidencePath = join(localReleaseDir, 'reanchor-evidence.json')
    writeJson(admittedReanchorEvidencePath, reanchorRequest.evidence)
    chmodSync(admittedReanchorEvidencePath, 0o600)
    run('scp', ['-p', admittedReanchorEvidencePath, `${target}:${remoteReleaseDir}/reanchor-evidence.json`], { code: exitCodes.production })
  }

  const reanchorPublicRequest = {
    migrationVersion: reanchorRequest.migrationVersion,
    migrationId: reanchorRequest.migrationId,
    fromTimeZone: reanchorRequest.fromTimeZone,
    toTimeZone: reanchorRequest.toTimeZone,
    cutoverAt: reanchorRequest.cutoverAt,
    reanchoredAt: reanchorRequest.reanchoredAt,
  }
  const remoteReanchorStep = reanchorRequest.required
    ? `compose run --rm --no-deps prepare ${cronReanchorArgs(reanchorRequest).map(shellQuote).join(' ')} >"$release_dir/schedule-reanchor.json"
python3 - "$release_dir/schedule-reanchor.json" <<'PY'
import json, re, sys
value = json.load(open(sys.argv[1], encoding='utf-8'))
assert value.get('status') in {'reanchored', 'already-applied'}
assert value.get('migrationId') == 'dsh-cron-shanghai-reanchor-v1'
assert isinstance(value.get('cronJobCount'), int) and value['cronJobCount'] > 0
assert isinstance(value.get('appendedCount'), int) and 0 <= value['appendedCount'] <= value['cronJobCount']
assert re.fullmatch(r'[0-9a-f]{64}', value.get('inputSha256', ''))
assert len(value.get('jobs', [])) == value['cronJobCount']
PY`
    : `test -f "$release_dir/reanchor-evidence.json"
test "$(stat -c '%a' "$release_dir/reanchor-evidence.json")" = 600
compose run --rm --no-deps \
  --volume "$release_dir/reanchor-evidence.json:/run/reanchor-evidence.json:ro" \
  prepare cron-reanchor-inspect --evidence-file /run/reanchor-evidence.json \
  >"$release_dir/schedule-reanchor.json"
python3 - "$release_dir/schedule-reanchor.json" <<'PY'
import json, sys
value = json.load(open(sys.argv[1], encoding='utf-8'))
assert value.get('status') == 'verified'
assert value.get('migrationId') == 'dsh-cron-shanghai-reanchor-v1'
assert isinstance(value.get('cronJobCount'), int) and value['cronJobCount'] > 0
assert value.get('ledgerRecordCount') == value['cronJobCount']
assert len(value.get('jobs', [])) == value['cronJobCount']
PY`

  const startOutput = ssh(`set -Eeuo pipefail
release_dir=${shellQuote(remoteReleaseDir)}
expected_archive=${shellQuote(candidate.archiveSha256)}
expected_image=${shellQuote(candidate.imageId)}
expected_tag=${shellQuote(candidate.imageTag)}
actual_archive="sha256:$(sha256sum "$release_dir/image.tar" | awk '{print $1}')"
test "$actual_archive" = "$expected_archive" || { echo 'archive sha256 mismatch' >&2; exit 51; }
actual_compose="sha256:$(sha256sum "$release_dir/compose.production.yml" | awk '{print $1}')"
test "$actual_compose" = ${shellQuote(candidate.composeSha256)} || { echo 'compose sha256 mismatch' >&2; exit 51; }
archive_identity="$(tar -xOf "$release_dir/image.tar" manifest.json | python3 -c 'import json,sys; entry=json.load(sys.stdin)[0]; print(entry["Config"]+"|"+entry["RepoTags"][0])')"
test "$archive_identity" = "${candidate.imageId.replace(/^sha256:/u, '')}.json|$expected_tag" || { echo "archive identity mismatch: $archive_identity" >&2; exit 52; }
docker load --input "$release_dir/image.tar"
engine_image="$(docker image inspect "$expected_tag" --format '{{.Id}}')"
test "$(docker image inspect "$expected_tag" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" = ${shellQuote(candidate.pluginsCommit)}
test "$(docker image inspect "$expected_tag" --format '{{index .Config.Labels "io.dsh.release.revision"}}')" = ${shellQuote(candidate.releaseToolCommit)}
test "$(docker image inspect "$expected_tag" --format '{{index .Config.Labels "io.dsh.harness.revision"}}')" = ${shellQuote(candidate.harnessCommit)}
test "$(docker image inspect "$expected_tag" --format '{{index .Config.Labels "io.dsh.harness.patch-sha256"}}')" = ${shellQuote(candidate.harnessPatchSha256)}
test "$(docker image inspect "$expected_tag" --format '{{index .Config.Labels "io.dsh.candidate.purpose"}}')" = 'release'
test "$(docker image inspect "$expected_tag" --format '{{index .Config.Labels "io.dsh.workspace-migration.version"}}')" = ${shellQuote(String(candidate.workspaceMigration.version))}
test "$(docker image inspect "$expected_tag" --format '{{index .Config.Labels "io.dsh.workspace-migration.id"}}')" = ${shellQuote(candidate.workspaceMigration.migrationId)}
test "$(docker image inspect "$expected_tag" --format '{{index .Config.Labels "io.dsh.workspace-migration.code-sha256"}}')" = ${shellQuote(candidate.workspaceMigration.codeSha256)}
test "$(docker image inspect "$expected_tag" --format '{{index .Config.Labels "io.dsh.workspace-migration.manifest-sha256"}}')" = ${shellQuote(candidate.workspaceMigration.manifestSha256)}
test "$(docker image inspect "$expected_tag" --format '{{index .Config.Labels "io.dsh.workspace-migration.template-sha256"}}')" = ${shellQuote(candidate.workspaceMigration.templateSha256)}
test "$(docker image inspect "$expected_tag" --format '{{index .Config.Labels "io.dsh.workspace-migration.root-instructions-sha256"}}')" = ${shellQuote(candidate.workspaceMigration.rootInstructionsSha256)}
test "$(docker image inspect "$expected_tag" --format '{{index .Config.Labels "io.dsh.workspace-migration.personal-task-list-skill-sha256"}}')" = ${shellQuote(candidate.workspaceMigration.personalTaskListSkillSha256)}
test "$(docker image inspect "$expected_tag" --format '{{index .Config.Labels "io.dsh.business-automation.owner"}}')" = 'live-harness-workspace'
test "$(docker image inspect "$expected_tag" --format '{{index .Config.Labels "io.dsh.business-automation.included-in-candidate"}}')" = 'false'
test "$(docker image inspect "$expected_tag" --format '{{index .Config.Labels "io.dsh.release.compose-sha256"}}')" = ${shellQuote(candidate.composeSha256)}
cd "$release_dir"
export DSH_IMAGE="$expected_tag" DSH_IMAGE_ID="$expected_image"
compose() { docker compose -p dsh -f "$release_dir/compose.production.yml" "$@"; }
printf '%s\n' ${shellQuote(JSON.stringify(reanchorPublicRequest))} >"$release_dir/reanchor-request.json"

# State transitions run while every DSH writer remains stopped.
compose run --rm --no-deps prepare workspace-migrate >"$release_dir/workspace-migration.json"
python3 - "$release_dir/workspace-migration.json" <<'PY'
import json, re, sys
value = json.load(open(sys.argv[1], encoding='utf-8'))
assert value.get('status') in {'applied', 'already-applied'}
assert value.get('migrationId') == 'harness-only-workspace-v1'
assert value.get('migrationVersion') == 1
assert re.fullmatch(r'[0-9a-f]{64}', value.get('manifestSha256', ''))
assert re.fullmatch(r'[0-9a-f]{64}', value.get('receiptSha256', ''))
PY
compose run --rm --no-deps \
  -e DSH_EXPECTED_WORKSPACE_MIGRATION_CODE_SHA256=${shellQuote(candidate.workspaceMigration.codeSha256)} \
  -e DSH_EXPECTED_WORKSPACE_MIGRATION_MANIFEST_SHA256=${shellQuote(candidate.workspaceMigration.manifestSha256)} \
  -e DSH_EXPECTED_WORKSPACE_MIGRATION_TEMPLATE_SHA256=${shellQuote(candidate.workspaceMigration.templateSha256)} \
  -e DSH_EXPECTED_WORKSPACE_MIGRATION_ROOT_INSTRUCTIONS_SHA256=${shellQuote(candidate.workspaceMigration.rootInstructionsSha256)} \
  -e DSH_EXPECTED_WORKSPACE_MIGRATION_PERSONAL_TASK_LIST_SKILL_SHA256=${shellQuote(candidate.workspaceMigration.personalTaskListSkillSha256)} \
  prepare workspace-migration-verify >"$release_dir/workspace-content.json"

# This is a second read-only credential/page check through the candidate
# environment. Business task-mirror initialization remains owned by the live
# Harness Workspace and is deliberately not fabricated by release code.
compose run --rm --no-deps prepare notion-page-check >"$release_dir/notion-page.json"
compose run --rm --no-deps prepare notion-inbox-init >"$release_dir/notion-inbox-init.json"
python3 - "$release_dir/notion-inbox-init.json" <<'PY'
import json, re, sys
value = json.load(open(sys.argv[1], encoding='utf-8'))
assert set(value) == {
    'status', 'entrypointSha256', 'handoffSha256', 'testReceiptSha256',
    'artifacts', 'remoteMethod',
}
assert value.get('status') in {'initialized', 'already-initialized'}
assert value.get('remoteMethod') == (
    'GET' if value['status'] == 'initialized' else 'none'
)
for key in ('entrypointSha256', 'handoffSha256', 'testReceiptSha256'):
    assert re.fullmatch(r'[0-9a-f]{64}', value.get(key, ''))
expected = {
    'mirror': ('storages/task-inbox/inbox.md', '0600'),
    'state': ('storages/task-inbox/sync-state.json', '0600'),
    'fingerprint': ('storages/task-inbox/notion-fingerprint.json', '0600'),
}
artifacts = value.get('artifacts')
assert isinstance(artifacts, dict) and set(artifacts) == set(expected)
for role, (path, mode) in expected.items():
    artifact = artifacts[role]
    assert isinstance(artifact, dict)
    assert set(artifact) == {'role', 'path', 'mode', 'length', 'sha256'}
    assert artifact['role'] == role
    assert artifact['path'] == path
    assert artifact['mode'] == mode
    assert isinstance(artifact['length'], int) and artifact['length'] > 0
    assert re.fullmatch(r'[0-9a-f]{64}', artifact['sha256'])
PY
${remoteReanchorStep}

# Start the manager first; Telegram and LAN stay down until its control plane
# and the live-Harness-owned retry binding pass read-only checks.
compose up -d prepare web
wait_http() {
  local url="$1"
  for attempt in $(seq 1 24); do
    if curl --fail --silent --max-time 2 "$url" >/dev/null; then return 0; fi
    sleep 5
  done
  curl --fail --silent --max-time 3 "$url" >/dev/null
}
wait_http http://127.0.0.1:3080/
test "$(docker inspect dsh-web --format '{{.State.Running}}/{{.RestartCount}}')" = 'true/0'
test "$(docker inspect dsh-prepare --format '{{.State.Status}}/{{.State.ExitCode}}')" = 'exited/0'
docker exec dsh-web node /opt/dsh/release-system/scripts/check-cron-control-ready.cjs >/dev/null
docker exec dsh-web node /opt/dsh/release-system/scripts/check-notion-retry-binding.mjs >"$release_dir/notion-retry-binding.json"

compose up -d telegram lan-proxy
wait_http http://192.168.6.240:3080/
test "$(docker inspect dsh-telegram --format '{{.State.Running}}/{{.RestartCount}}')" = 'true/0'
test "$(docker inspect dsh-lan-proxy --format '{{.State.Running}}/{{.RestartCount}}')" = 'true/0'
assistant_ready=false
for attempt in $(seq 1 24); do
  if docker exec dsh-telegram node /opt/dsh/release-system/scripts/check-assistant-cron-ready.mjs \
      >"$release_dir/assistant-cron-health.json" 2>/dev/null; then
    assistant_ready=true
    break
  fi
  sleep 5
done
test "$assistant_ready" = true
docker exec dsh-telegram node /opt/dsh/release-system/scripts/check-assistant-cron-ready.mjs \
  >"$release_dir/assistant-cron-health.json"
docker exec dsh-web /opt/dsh/release-system/scripts/entrypoint.sh harness-only-health \
  >"$release_dir/harness-only-health.json"
compose run --rm --no-deps prepare validate-state /home/herman/.dsh \
  >"$release_dir/state-validation.json"
python3 - "$release_dir/state-validation.json" <<'PY'
import json, sys
value = json.load(open(sys.argv[1], encoding='utf-8'))
assistant = [item for item in value.get('databases', []) if item.get('applicationId') == 0x44534841]
assert len(assistant) == 1
database = assistant[0]
assert database.get('userVersion') == 4
assert database.get('queryOnly') is True
assert database.get('check') == 'quick_check'
assert database.get('foreignKeyViolations') == 0
assert [table.get('name') for table in database.get('tables', [])] == [
    'commitments', 'outbox', 'web_observations', 'assistant_cron_bindings'
]
PY
ln -sfn "$release_dir" ${shellQuote(remoteRoot)}/current.next
mv -Tf ${shellQuote(remoteRoot)}/current.next ${shellQuote(remoteRoot)}/current
python3 - "$expected_image" "$engine_image" "$release_dir" <<'PY'
import json, os, sys
image_id, engine_image_id, root = sys.argv[1:]
def load(name):
    with open(os.path.join(root, name), encoding='utf-8') as source:
        return json.load(source)
request = load('reanchor-request.json')
reanchor = load('schedule-reanchor.json')
state = load('state-validation.json')
if reanchor.get('status') == 'verified':
    evidence = {
        key: reanchor[key]
        for key in (
            'schemaVersion', 'migrationVersion', 'migrationId', 'fromTimeZone',
            'toTimeZone', 'cutoverAt', 'reanchoredAt', 'inputSha256',
            'cronJobCount', 'jobs',
        )
    }
else:
    evidence = {
        'schemaVersion': 1,
        **request,
        'inputSha256': reanchor['inputSha256'],
        'cronJobCount': reanchor['cronJobCount'],
        'jobs': [
            {
                'jobId': job['jobId'],
                'scheduleSha256': job['scheduleSha256'],
                'nextRunAt': job['nextRunAt'],
            }
            for job in reanchor['jobs']
        ],
    }
evidence['jobs'] = sorted(evidence['jobs'], key=lambda value: value['jobId'])
assistant_databases = [
    value for value in state.get('databases', [])
    if value.get('applicationId') == 0x44534841
]
assistant_state = [
    {
        'userVersion': value.get('userVersion'),
        'queryOnly': value.get('queryOnly'),
        'check': value.get('check'),
        'foreignKeyViolations': value.get('foreignKeyViolations'),
        'tables': value.get('tables'),
        'sha256': value.get('sha256'),
    }
    for value in assistant_databases
]
receipt = {
    'imageId': image_id,
    'engineImageId': engine_image_id,
    'prepare': 'exited/0',
    'web': 'true/0',
    'telegram': 'true/0',
    'lan': 'true/0',
    'cronControl': 'ready',
    'workspaceMigration': load('workspace-migration.json'),
    'workspaceContent': load('workspace-content.json'),
    'notionPage': load('notion-page.json'),
    'notionInboxInit': load('notion-inbox-init.json'),
    'scheduleReanchor': {
        'status': 'complete',
        **request,
        'evidence': evidence,
        'operation': reanchor,
    },
    'notionRetryBinding': load('notion-retry-binding.json'),
    'assistantCron': load('assistant-cron-health.json'),
    'harnessOnly': load('harness-only-health.json'),
    'stateValidation': {
        'databaseCount': len(state.get('databases', [])),
        'assistantDatabaseCount': len(assistant_state),
        'assistant': assistant_state,
    },
    'businessAutomation': {'owner': 'live-harness-workspace', 'includedInCandidate': False},
}
print(json.dumps(receipt, sort_keys=True, separators=(',', ':')))
PY
`)
  let productionReceipt
  try { productionReceipt = JSON.parse(startOutput.split('\n').at(-1)) } catch { fail(`无法解析生产启动回执: ${startOutput}`, exitCodes.production) }
  const productionReanchor = productionReceipt?.scheduleReanchor
  const productionReanchorKeys = [
    'status', 'migrationVersion', 'migrationId', 'fromTimeZone', 'toTimeZone',
    'cutoverAt', 'reanchoredAt', 'evidence', 'operation',
  ]
  if (!productionReanchor || typeof productionReanchor !== 'object' || Array.isArray(productionReanchor)
    || Object.keys(productionReanchor).sort().join('\0') !== productionReanchorKeys.sort().join('\0')
    || productionReanchor.status !== 'complete') {
    fail('生产 schedule reanchor 回执不完整', exitCodes.production)
  }
  const productionReanchorEvidence = validateReanchorEvidence(
    productionReanchor.evidence,
    '生产 schedule reanchor evidence',
  )
  for (const key of ['migrationVersion', 'migrationId', 'fromTimeZone', 'toTimeZone', 'cutoverAt', 'reanchoredAt']) {
    if (productionReanchor[key] !== reanchorRequest[key]
      || productionReanchorEvidence[key] !== reanchorRequest[key]) {
      fail('生产 schedule reanchor 回执与停机后 request 不一致', exitCodes.production)
    }
  }
  if (reanchorRequest.required) {
    const expectedEvidence = reanchorEvidenceFromResult(reanchorRequest, productionReanchor.operation)
    if (JSON.stringify(productionReanchorEvidence) !== JSON.stringify(expectedEvidence)) {
      fail('生产 schedule reanchor event 与 evidence 不一致', exitCodes.production)
    }
  } else {
    validateReanchorInspectionReceipt(
      productionReanchor.operation,
      reanchorRequest.evidence,
      '生产 accepted schedule reanchor inspection',
    )
    if (JSON.stringify(productionReanchorEvidence) !== JSON.stringify(reanchorRequest.evidence)) {
      fail('生产 inherited schedule reanchor evidence 已漂移', exitCodes.production)
    }
  }
  const notionBinding = productionReceipt?.notionRetryBinding
  const notionBindingKeys = [
    'status', 'externalRef', 'jobId', 'specSha256', 'entrypointSha256', 'entrypointSize',
  ]
  if (!notionBinding || typeof notionBinding !== 'object' || Array.isArray(notionBinding)
    || Object.keys(notionBinding).sort().join('\0') !== notionBindingKeys.sort().join('\0')
    || notionBinding.status !== 'ready'
    || notionBinding.externalRef !== 'dsh:notion-task-inbox:retry:v1'
    || typeof notionBinding.jobId !== 'string' || notionBinding.jobId.length === 0
    || !/^[0-9a-f]{64}$/u.test(notionBinding.specSha256 ?? '')
    || notionBinding.entrypointSha256 !== notionAutomation.sha256
    || notionBinding.entrypointSize !== notionAutomation.size) {
    fail('生产 Harness-owned Notion automation/binding 与停机前证据不一致', exitCodes.production)
  }
  const notionInit = validateNotionInboxInitReceipt(
    productionReceipt?.notionInboxInit,
    notionAutomation,
    { label: '生产 Notion task mirror 初始化', code: exitCodes.production },
  )
  const release = {
    schemaVersion: 1,
    releaseId,
    status: 'awaiting-user-acceptance',
    candidatePath,
    candidate,
    snapshot: snapshotMeta,
    previous,
    preflight: {
      remote: preflight,
      notionCredential,
      notionAutomation,
      migrations: migrationPreflight,
      stateReceiptSha256: sha256Text(stateReceipt),
      selfTestSha256: sha256Text(selfTest),
      runtime: runtimeReceipt,
    },
    production: productionReceipt,
    createdAt: new Date().toISOString(),
    userAcceptance: null,
    rollbackBoundary: {
      status: 'available-before-accept',
      previousReleaseId: previous.releaseId,
      snapshotId: snapshotMeta.snapshotId,
      snapshotArchiveSha256: snapshotMeta.archiveSha256,
    },
    cleanup: null,
  }
  const releasePath = join(localReleaseDir, 'release.json')
  writeJson(releasePath, release)
  run('scp', ['-p', releasePath, `${target}:${remoteReleaseDir}/release.json`], { code: exitCodes.production })
  out({
    result: 'production-running-awaiting-user-acceptance',
    releasePath,
    releaseId,
    required: '请验收 Web、Telegram 与本次产品改动；全部通过后执行 dsh accept。',
  })
}

function findRelease(value) {
  if (!value) fail('--release 必填', exitCodes.usage)
  const path = existsSync(value) ? resolve(value) : join(stateRoot, 'releases', value, 'release.json')
  requireRegularCandidateArtifact(path, 'release.json')
  const release = readJson(path, 'release')
  const expectedPath = join(stateRoot, 'releases', release.releaseId ?? '', 'release.json')
  if (!formalBuildName.test(release.releaseId ?? '') || path !== expectedPath) {
    fail('release.json 不在受控 release 路径或 releaseId 无效', exitCodes.safety)
  }
  return { path, release }
}

function validateRollbackSnapshot(release) {
  const snapshot = release.snapshot
  const fields = ['schemaVersion', 'snapshotId', 'archivePath', 'archiveSha256', 'remoteArchivePath', 'createdAt']
  const expectedLocal = join(stateRoot, 'snapshots', release.releaseId, 'home.tar.zst')
  const expectedRemote = `/home/herman/.local/share/dsh-container/snapshots/${release.releaseId}.tar.zst`
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)
    || Object.keys(snapshot).sort().join('\0') !== fields.sort().join('\0')
    || snapshot.schemaVersion !== 1 || snapshot.snapshotId !== release.releaseId
    || resolve(snapshot.archivePath ?? '') !== expectedLocal
    || snapshot.remoteArchivePath !== expectedRemote
    || !/^sha256:[0-9a-f]{64}$/u.test(snapshot.archiveSha256 ?? '')
    || typeof snapshot.createdAt !== 'string' || !Number.isFinite(Date.parse(snapshot.createdAt))) {
    fail('release 的停机快照记录不符合受控 schema/path', exitCodes.safety)
  }
  requireRegularCandidateArtifact(expectedLocal, '本地停机快照')
  if (sha256File(expectedLocal) !== snapshot.archiveSha256) {
    fail('本地停机快照摘要已经漂移', exitCodes.safety)
  }
  return snapshot
}

function validateRollbackPrevious(release) {
  const previous = release.previous
  const fields = ['mode', 'releaseId', 'remoteDir', 'candidate', 'engineImageId']
  if (!previous || typeof previous !== 'object' || Array.isArray(previous)
    || Object.keys(previous).sort().join('\0') !== fields.sort().join('\0')
    || previous.mode !== 'docker' || !formalBuildName.test(previous.releaseId ?? '')
    || previous.remoteDir !== `/home/herman/.local/share/dsh-container/releases/${previous.releaseId}`
    || Object.keys(previous.candidate ?? {}).sort().join('\0') !== ['imageId', 'imageTag'].sort().join('\0')
    || typeof previous.candidate.imageId !== 'string' || previous.candidate.imageId.length === 0
    || typeof previous.candidate.imageTag !== 'string' || previous.candidate.imageTag.length === 0
    || typeof previous.engineImageId !== 'string' || previous.engineImageId.length === 0) {
    fail('release 的上一 accepted image 边界不符合受控 schema/path', exitCodes.safety)
  }
  return previous
}

function validateRollbackBoundary(release) {
  const boundary = release.rollbackBoundary
  const fields = ['status', 'previousReleaseId', 'snapshotId', 'snapshotArchiveSha256']
  if (!boundary || typeof boundary !== 'object' || Array.isArray(boundary)
    || Object.keys(boundary).sort().join('\0') !== fields.sort().join('\0')
    || !['production-stopped-snapshot-available', 'available-before-accept'].includes(boundary.status)
    || boundary.previousReleaseId !== release.previous.releaseId
    || boundary.snapshotId !== release.snapshot.snapshotId
    || boundary.snapshotArchiveSha256 !== release.snapshot.archiveSha256) {
    fail('release 的 rollbackBoundary 已漂移', exitCodes.safety)
  }
  if (release.status === 'waiting-for-release-authorization'
    && boundary.status !== 'production-stopped-snapshot-available') {
    fail('停机后 waiting release 缺少精确 rollbackBoundary', exitCodes.safety)
  }
  return boundary
}

function rollbackReleaseFrom(value) {
  const found = findRelease(value)
  const { path, release } = found
  if (release.status === 'accepted' || release.rollbackBoundary?.status === 'retired-at-accept') {
    fail(`release ${release.releaseId} 已 accepted，回退边界已在 accept 退休；拒绝任何远端恢复动作`, exitCodes.safety)
  }
  if (release.status === 'waiting-for-release-authorization') {
    const waiting = waitingReleaseFrom(path)
    validateRollbackSnapshot(waiting.release)
    validateRollbackPrevious(waiting.release)
    validateRollbackBoundary(waiting.release)
    return { path, release: waiting.release, candidate: waiting.candidate }
  }
  const baseFields = [
    'schemaVersion', 'releaseId', 'status', 'candidatePath', 'candidate', 'snapshot',
    'previous', 'preflight', 'production', 'createdAt', 'userAcceptance',
    'rollbackBoundary', 'cleanup',
  ]
  const required = release.status === 'failed'
    ? [...baseFields, 'currentStage', 'failedAt', 'failure']
    : baseFields
  if (release.schemaVersion !== 1
    || !['awaiting-user-acceptance', 'failed'].includes(release.status)
    || Object.keys(release).sort().join('\0') !== required.sort().join('\0')
    || release.userAcceptance !== null || release.cleanup !== null
    || typeof release.createdAt !== 'string' || !Number.isFinite(Date.parse(release.createdAt))
    || (release.status === 'failed' && (
      typeof release.currentStage !== 'string' || release.currentStage.length === 0
      || typeof release.failedAt !== 'string' || !Number.isFinite(Date.parse(release.failedAt))
      || !release.failure || typeof release.failure !== 'object' || Array.isArray(release.failure)
      || Object.keys(release.failure).sort().join('\0') !== ['exitCode', 'message', 'stage'].sort().join('\0')
    ))) {
    fail('release 记录不是受控的未 accept rollback schema', exitCodes.safety)
  }
  const candidateArtifact = candidateFrom(release.candidatePath)
  if (JSON.stringify(candidateArtifact.candidate) !== JSON.stringify(release.candidate)) {
    fail('rollback release 的 candidate 已漂移', exitCodes.safety)
  }
  validateRollbackSnapshot(release)
  validateRollbackPrevious(release)
  validateRollbackBoundary(release)
  return { path, release, candidate: candidateArtifact.candidate }
}

function ensureAcceptedRemotePointers(release) {
  const remoteRoot = '/home/herman/.local/share/dsh-container'
  const remoteDir = `${remoteRoot}/releases/${release.releaseId}`
  ssh(`set -Eeuo pipefail
root=${shellQuote(remoteRoot)}
release_dir=${shellQuote(remoteDir)}
test -f "$release_dir/release.json"
test "$(readlink -f "$root/current")" = "$release_dir" || { echo 'current does not point at accepted release' >&2; exit 61; }
ln -sfn "$release_dir" "$root/last-good.next"
mv -Tf "$root/last-good.next" "$root/last-good"
test "$(readlink -f "$root/current")" = "$release_dir"
test "$(readlink -f "$root/last-good")" = "$release_dir"
`)
  return remoteDir
}

function pendingAcceptedCleanup(release, code, message) {
  const cleanup = cleanupAttempt(release)
  cleanupError(cleanup, 'remote', code, target, message)
  return finishCleanupAttempt(cleanup)
}

function writeCleanupReceipt(path, release, cleanup) {
  const releaseDir = dirname(path)
  const receiptName = cleanup.receiptName ?? `cleanup-${nowId()}.json`
  cleanup.receiptName = receiptName
  const receiptPath = join(releaseDir, receiptName)
  writeJson(receiptPath, cleanup)
  release.cleanup = cleanup
  const history = Array.isArray(release.cleanupHistory) ? release.cleanupHistory : []
  const existing = history.find((entry) => entry.receiptName === receiptName)
  if (existing) {
    existing.status = cleanup.status
    existing.completedAt = cleanup.completedAt
  } else {
    history.push({ receiptName, status: cleanup.status, completedAt: cleanup.completedAt })
  }
  release.cleanupHistory = history
  writeJson(path, release)
  return { receiptName, receiptPath }
}

function syncCleanupReceipt(path, release, cleanup, remoteDir) {
  const { receiptName, receiptPath } = writeCleanupReceipt(path, release, cleanup)
  const receiptSync = runStatus('scp', ['-p', receiptPath, `${target}:${remoteDir}/${receiptName}`])
  if (receiptSync.status !== 0) {
    cleanupError(cleanup, 'remote', 'cleanup-receipt-sync-failed', `${remoteDir}/${receiptName}`, String(receiptSync.stderr ?? '').trim() || `scp exit ${receiptSync.status}`)
  }
  finishCleanupAttempt(cleanup)
  writeCleanupReceipt(path, release, cleanup)
  const releaseSync = runStatus('scp', ['-p', path, `${target}:${remoteDir}/release.json`])
  if (releaseSync.status !== 0) {
    cleanupError(cleanup, 'remote', 'release-evidence-sync-failed', `${remoteDir}/release.json`, String(releaseSync.stderr ?? '').trim() || `scp exit ${releaseSync.status}`)
    finishCleanupAttempt(cleanup)
    writeCleanupReceipt(path, release, cleanup)
  }
}

const acceptanceChecklist = Object.freeze([
  Object.freeze({ id: 'telegramWebTaskQuery', label: 'Telegram/Web 普通任务查询' }),
  Object.freeze({ id: 'notionReversibleTask', label: '唯一标记的可逆 Notion 任务写入、镜像一致性与删除' }),
  Object.freeze({ id: 'temporaryMonitorLifecycle', label: '临时 monitor create/pause/resume/revise/cancel' }),
  Object.freeze({ id: 'shanghaiReminder', label: '数分钟后的上海时间提醒' }),
  Object.freeze({ id: 'dailyCronNextRuns', label: '两条 daily Cron 下一执行时间' }),
  Object.freeze({ id: 'existingMemoryFact', label: '新会话读取既有 DSH MEMORY 事实' }),
  Object.freeze({ id: 'noLegacyPathEacces', label: '本次发布后新日志无旧路径 EACCES' }),
  Object.freeze({ id: 'assistantSqliteIntegrity', label: 'Assistant SQLite quick_check、外键与关键表行数' }),
])
const acceptanceChecklistIds = Object.freeze(acceptanceChecklist.map(({ id }) => id))
const acceptanceEvidenceSummary = 'all-required-acceptance-checks-passed'

const acceptanceHealthChecks = Object.freeze([
  'candidate-archive-sha256', 'candidate-engine-image', 'web-image', 'telegram-image',
  'lan-proxy-image', 'prepare-image', 'web-running', 'telegram-running',
  'lan-proxy-running', 'prepare-exited-zero', 'web-loopback-http', 'web-lan-http',
  'cron-control-ready', 'notion-retry-binding-ready', 'assistant-cron-ready',
  'harness-only-health', 'notion-page-readonly', 'assistant-state-valid',
])

function acceptanceEvidenceReceipt(raw) {
  const text = String(raw ?? '').trim()
  const inputLength = Buffer.byteLength(text)
  if (inputLength < 1 || inputLength > 64 * 1024) fail('验收证据长度必须在 1..65536 字节', exitCodes.usage)
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    fail('accept --evidence 必须是结构化 JSON 文件或 JSON 对象', exitCodes.usage)
  }
  if (!hasExactKeys(parsed, ['schemaVersion', 'checks']) || parsed.schemaVersion !== 1
    || !hasExactKeys(parsed.checks, acceptanceChecklistIds)) {
    fail('accept --evidence 必须精确包含 schemaVersion=1 和固定 8 项 checks，不得夹带正文或额外字段', exitCodes.usage)
  }
  const failed = acceptanceChecklistIds.filter(id => parsed.checks[id] !== true)
  if (failed.length !== 0) {
    fail(`accept --evidence 的固定 8 项 checks 必须逐项为 true；未通过: ${failed.join(',')}`, exitCodes.usage)
  }
  const normalized = JSON.stringify({
    schemaVersion: 1,
    checks: Object.fromEntries(acceptanceChecklistIds.map(id => [id, true])),
  })
  return {
    recordedAt: new Date().toISOString(),
    summary: acceptanceEvidenceSummary,
    length: Buffer.byteLength(normalized),
    sha256: sha256Text(normalized),
    checklistVersion: 1,
    requiredCount: acceptanceChecklist.length,
    passedCount: acceptanceChecklist.length,
    checklist: acceptanceChecklist.map(item => ({ ...item })),
  }
}

function validateAcceptanceEvidenceReceipt(value) {
  const fields = [
    'recordedAt', 'summary', 'length', 'sha256', 'checklistVersion',
    'requiredCount', 'passedCount', 'checklist',
  ]
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('\0') !== fields.sort().join('\0')
    || typeof value.recordedAt !== 'string' || !Number.isFinite(Date.parse(value.recordedAt))
    || !Number.isSafeInteger(value.length) || value.length < 1 || value.length > 64 * 1024
    || !/^sha256:[0-9a-f]{64}$/u.test(value.sha256 ?? '')
    || value.summary !== acceptanceEvidenceSummary
    || value.checklistVersion !== 1 || value.requiredCount !== acceptanceChecklist.length
    || value.passedCount !== acceptanceChecklist.length
    || JSON.stringify(value.checklist) !== JSON.stringify(acceptanceChecklist)) {
    fail('accept evidence receipt 不符合脱敏固定 schema', exitCodes.safety)
  }
  return value
}

function validateAcceptanceHealthReceipt(value) {
  const fields = ['checkedAt', 'passedCount', 'checks']
  if (!hasExactKeys(value, fields)
    || typeof value.checkedAt !== 'string' || !Number.isFinite(Date.parse(value.checkedAt))
    || value.passedCount !== acceptanceHealthChecks.length
    || JSON.stringify(value.checks) !== JSON.stringify(acceptanceHealthChecks)) {
    fail('accept health receipt 不符合脱敏固定 schema', exitCodes.safety)
  }
  return value
}

function commandAccept(options) {
  const optionNames = Object.keys(options).filter(name => name !== '_').sort()
  if (options._.length !== 0 || !options.release
    || optionNames.some(name => !['evidence', 'release'].includes(name))) {
    fail('accept 必须准确使用 --release，首次验收另加 --evidence', exitCodes.usage)
  }
  const { path, release } = findRelease(options.release)
  const firstAcceptance = release.status === 'awaiting-user-acceptance'
  const cleanupRetry = release.status === 'accepted' && release.cleanup?.status === 'incomplete'
  if (release.status === 'accepted' && release.cleanup?.status === 'complete') {
    if (optionNames.length !== 1 || optionNames[0] !== 'release') {
      fail('已 accepted 的 release 只接受准确的 --release 幂等查询', exitCodes.usage)
    }
    out({ result: 'accepted', releaseId: release.releaseId, imageId: release.candidate.imageId, cleanup: release.cleanup, next: '该 release 已 accepted，正式材料已经收敛。' })
    return
  }
  if (!firstAcceptance && !cleanupRetry) fail(`只有 awaiting-user-acceptance 或 cleanup incomplete 的 accepted release 可执行 accept，当前是 ${release.status}`, exitCodes.safety)

  const candidateArtifact = candidateFrom(release.candidatePath)
  if (JSON.stringify(candidateArtifact.candidate) !== JSON.stringify(release.candidate)) {
    fail('accept release 的 candidate 已漂移', exitCodes.safety)
  }
  requireExactReleaseTree(candidateArtifact.candidate.releaseToolCommit, '生产 accept 编排')

  if (firstAcceptance && (optionNames.length !== 2 || !options.evidence)) {
    fail('accept 必须准确提供 --release 与 --evidence <结构化 8 项验收 JSON>', exitCodes.usage)
  }
  if (cleanupRetry && optionNames.length !== 1) {
    fail('accepted cleanup retry 只接受 --release，并复用已锁定的脱敏验收回执', exitCodes.usage)
  }
  const evidenceText = firstAcceptance
    ? (existsSync(options.evidence) ? (requireRegularCandidateArtifact(resolve(options.evidence), 'accept evidence'), readFileSync(options.evidence, 'utf8').trim()) : options.evidence)
    : null
  const evidence = firstAcceptance
    ? validateAcceptanceEvidenceReceipt(acceptanceEvidenceReceipt(evidenceText))
    : validateAcceptanceEvidenceReceipt(release.userAcceptance?.evidence)
  if (firstAcceptance && !evidence) fail('验收证据不能为空', exitCodes.usage)
  if (firstAcceptance) ssh(`set -Eeuo pipefail
test "sha256:$(sha256sum ${shellQuote(`/home/herman/.local/share/dsh-container/releases/${release.releaseId}/image.tar`)} | awk '{print $1}')" = ${shellQuote(release.candidate.archiveSha256)}
test "$(docker image inspect ${shellQuote(release.candidate.imageTag)} --format '{{.Id}}')" = ${shellQuote(release.production.engineImageId)}
test "$(docker inspect dsh-web --format '{{.Image}}')" = ${shellQuote(release.production.engineImageId)}
test "$(docker inspect dsh-telegram --format '{{.Image}}')" = ${shellQuote(release.production.engineImageId)}
test "$(docker inspect dsh-lan-proxy --format '{{.Image}}')" = ${shellQuote(release.production.engineImageId)}
test "$(docker inspect dsh-prepare --format '{{.Image}}')" = ${shellQuote(release.production.engineImageId)}
test "$(docker inspect dsh-web --format '{{.State.Running}}/{{.RestartCount}}')" = 'true/0'
test "$(docker inspect dsh-telegram --format '{{.State.Running}}/{{.RestartCount}}')" = 'true/0'
test "$(docker inspect dsh-lan-proxy --format '{{.State.Running}}/{{.RestartCount}}')" = 'true/0'
test "$(docker inspect dsh-prepare --format '{{.State.Status}}/{{.State.ExitCode}}')" = 'exited/0'
curl --fail --silent --max-time 3 http://127.0.0.1:3080/ >/dev/null
curl --fail --silent --max-time 3 http://192.168.6.240:3080/ >/dev/null
docker exec dsh-web node /opt/dsh/release-system/scripts/check-cron-control-ready.cjs >/dev/null
docker exec dsh-web node /opt/dsh/release-system/scripts/check-notion-retry-binding.mjs >/dev/null
docker exec dsh-telegram node /opt/dsh/release-system/scripts/check-assistant-cron-ready.mjs >/dev/null
docker exec dsh-web /opt/dsh/release-system/scripts/entrypoint.sh harness-only-health >/dev/null
docker exec dsh-web /opt/dsh/release-system/scripts/entrypoint.sh notion-page-check >/dev/null
docker exec dsh-web node /opt/dsh/release-system/scripts/validate-state.mjs /home/herman/.dsh >/dev/null
printf '%s\n' 'containers-and-web-healthy'
`)
  const acceptanceHealth = firstAcceptance ? validateAcceptanceHealthReceipt({
    checkedAt: new Date().toISOString(),
    passedCount: acceptanceHealthChecks.length,
    checks: [...acceptanceHealthChecks],
  }) : validateAcceptanceHealthReceipt(release.userAcceptance?.acceptanceHealth)

  let remoteDir
  if (firstAcceptance) {
    remoteDir = ensureAcceptedRemotePointers(release)
    const acceptedAt = new Date().toISOString()
    release.status = 'accepted'
    release.currentStage = 'accepted'
    release.acceptedAt = acceptedAt
    release.userAcceptance = { evidence, acceptanceHealth }
    release.rollbackBoundary = {
      status: 'retired-at-accept',
      retiredAt: acceptedAt,
      previousReleaseId: release.previous?.releaseId ?? null,
      snapshotId: release.snapshot?.snapshotId ?? null,
      recovery: 'current-release-only',
    }
    release.cleanup = pendingAcceptedCleanup(release, 'cleanup-pending', 'accepted 状态已提交，正式材料清理尚未完成')
    writeJson(path, release)
  } else {
    release.userAcceptance = { ...release.userAcceptance, evidence, acceptanceHealth }
    remoteDir = `/home/herman/.local/share/dsh-container/releases/${release.releaseId}`
    try { ensureAcceptedRemotePointers(release) } catch (error) {
      const cleanup = pendingAcceptedCleanup(release, 'release-pointers-incomplete', error.message)
      syncCleanupReceipt(path, release, cleanup, remoteDir)
      out({ result: 'accepted-cleanup-incomplete', releaseId: release.releaseId, imageId: release.candidate.imageId, cleanup })
      process.exitCode = exitCodes.production
      return
    }
  }

  const acceptedSync = runStatus('scp', ['-p', path, `${target}:${remoteDir}/release.json`])
  if (acceptedSync.status !== 0) {
    const cleanup = pendingAcceptedCleanup(release, 'accepted-evidence-sync-failed', String(acceptedSync.stderr ?? '').trim() || `scp exit ${acceptedSync.status}`)
    syncCleanupReceipt(path, release, cleanup, remoteDir)
    out({ result: 'accepted-cleanup-incomplete', releaseId: release.releaseId, imageId: release.candidate.imageId, cleanup })
    process.exitCode = exitCodes.production
    return
  }

  const cleanup = cleanupAcceptedRelease(release)
  release.localDevelopmentCleanup = cleanup.development
  syncCleanupReceipt(path, release, cleanup, remoteDir)
  const result = cleanup.status === 'complete' ? 'accepted' : 'accepted-cleanup-incomplete'
  out({
    result,
    releaseId: release.releaseId,
    imageId: release.candidate.imageId,
    cleanup,
    next: cleanup.status === 'complete'
      ? '该 release 已固定为 current 和 last-good；只保留当前正式版本与 latest 生产快照。'
      : 'accepted 状态不会回退；修复清理错误后，对同一 release 再次执行 accept 只会重试清理。',
  })
  if (cleanup.status === 'incomplete') process.exitCode = exitCodes.production
}

function commandRollback(options) {
  const optionNames = Object.keys(options).filter(name => name !== '_').sort()
  const allowed = options.approved ? ['approved', 'release'] : ['release']
  if (options._.length !== 0 || !options.release
    || optionNames.length !== allowed.length || optionNames.some(name => !allowed.includes(name))) {
    fail('rollback 必须准确使用 --release，可选独立 --approved', exitCodes.usage)
  }
  const { path, release, candidate } = rollbackReleaseFrom(options.release)
  requireExactReleaseTree(candidate.releaseToolCommit, '生产 rollback 编排')
  if (release.status === 'accepted' || release.rollbackBoundary?.status === 'retired-at-accept') {
    fail(`release ${release.releaseId} 已 accepted，回退边界已在 accept 退休；拒绝任何远端恢复动作`, exitCodes.safety)
  }
  if (!['waiting-for-release-authorization', 'awaiting-user-acceptance', 'failed'].includes(release.status)) {
    fail(`只有未 accept 的候选可以按本快照回退，当前是 ${release.status}`, exitCodes.safety)
  }
  if (!options.approved) {
    out({ status: 'waiting-for-rollback-authorization', target, releaseId: release.releaseId, restore: release.previous, snapshot: release.snapshot, next: '用户批准后加 --approved' })
    process.exitCode = exitCodes.approval
    return
  }
  const remoteRoot = '/home/herman/.local/share/dsh-container'
  const remoteSnapshot = release.snapshot.remoteArchivePath
  const currentAllowed = release.status === 'waiting-for-release-authorization'
    ? [release.previous.remoteDir]
    : [release.previous.remoteDir, `${remoteRoot}/releases/${release.releaseId}`]
  const candidateEngineImageId = release.production?.engineImageId ?? null
  ssh(`set -Eeuo pipefail
root=${shellQuote(remoteRoot)}
snapshot=${shellQuote(remoteSnapshot)}
expected_snapshot_sha=${shellQuote(release.snapshot.archiveSha256)}
previous_dir=${shellQuote(release.previous.remoteDir)}
previous_release_id=${shellQuote(release.previous.releaseId)}
previous_image=${shellQuote(release.previous.candidate.imageTag)}
previous_image_id=${shellQuote(release.previous.candidate.imageId)}
previous_engine_image_id=${shellQuote(release.previous.engineImageId)}
candidate_dir=${shellQuote(`${remoteRoot}/releases/${release.releaseId}`)}
candidate_release_id=${shellQuote(release.releaseId)}
candidate_image=${shellQuote(release.candidate.imageTag)}
candidate_image_id=${shellQuote(release.candidate.imageId)}
candidate_engine_image_id=${shellQuote(candidateEngineImageId ?? '')}
test -f "$snapshot"
test "sha256:$(sha256sum "$snapshot" | awk '{print $1}')" = "$expected_snapshot_sha"
test -f "$previous_dir/release.json"
test "$(docker image inspect "$previous_image" --format '{{.Id}}')" = "$previous_engine_image_id"
current_dir="$(readlink -f "$root/current")"
case " ${currentAllowed.join(' ')} " in
  *" $current_dir "*) ;;
  *) echo "remote current pointer is outside the admitted rollback identities" >&2; exit 62 ;;
esac
if test "$current_dir" = "$candidate_dir"; then
  test -n "$candidate_engine_image_id"
  test "$(docker image inspect "$candidate_image" --format '{{.Id}}')" = "$candidate_engine_image_id"
fi
python3 - "$root" "$previous_dir" "$previous_release_id" "$previous_image_id" "$previous_image" "$previous_engine_image_id" "$candidate_dir" "$candidate_release_id" "$candidate_image_id" "$candidate_image" "$candidate_engine_image_id" ${currentAllowed.map(shellQuote).join(' ')} <<'PY'
import json, os, sys
(
    root, previous_dir, previous_release_id, previous_image_id, previous_image,
    previous_engine_image_id, candidate_dir, candidate_release_id,
    candidate_image_id, candidate_image, candidate_engine_image_id, *allowed,
) = sys.argv[1:]
with open(os.path.join(previous_dir, 'release.json'), encoding='utf-8') as handle:
    previous = json.load(handle)
assert previous.get('status') == 'accepted'
assert previous.get('releaseId') == previous_release_id
assert previous.get('candidate', {}).get('imageId') == previous_image_id
assert previous.get('candidate', {}).get('imageTag') == previous_image
assert previous.get('production', {}).get('engineImageId') == previous_engine_image_id
current_dir = os.path.realpath(os.path.join(root, 'current'))
assert current_dir in allowed
if current_dir == candidate_dir:
    assert candidate_engine_image_id
    with open(os.path.join(candidate_dir, 'release.json'), encoding='utf-8') as handle:
        current = json.load(handle)
    assert current.get('releaseId') == candidate_release_id
    assert current.get('candidate', {}).get('imageId') == candidate_image_id
    assert current.get('candidate', {}).get('imageTag') == candidate_image
    assert current.get('production', {}).get('engineImageId') == candidate_engine_image_id
PY
printf '%s\n' 'rollback-boundary-verified'
`)
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
test "$(docker inspect dsh-prepare --format '{{.State.Status}}/{{.State.ExitCode}}')" = 'exited/0'
docker exec dsh-web node /opt/dsh/release-system/scripts/check-cron-control-ready.cjs >/dev/null
`
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
${restartPrevious}
`)
  release.status = 'rolled-back'
  release.currentStage = 'rolled-back'
  release.rolledBackAt = new Date().toISOString()
  writeJson(path, release)
  runStatus('scp', ['-p', path, `${target}:/home/herman/.local/share/dsh-container/releases/${release.releaseId}/release.json`])
  out({ result: 'rolled-back', releaseId: release.releaseId, restored: `${release.previous.mode} + downtime snapshot`, note: '失败版本现场数据另存，未直接删除。' })
}

function cleanupResidualStatus() {
  const releasesRoot = join(stateRoot, 'releases')
  if (!existsSync(releasesRoot)) return { status: 'complete', residuals: [] }
  const residuals = []
  for (const name of readdirSync(releasesRoot).sort()) {
    const path = join(releasesRoot, name, 'release.json')
    if (!existsSync(path)) continue
    try {
      const release = readJson(path, 'release status')
      if (release.status === 'accepted' && release.cleanup?.status === 'incomplete') {
        residuals.push({
          releaseId: release.releaseId,
          completedAt: release.cleanup.completedAt ?? null,
          errors: release.cleanup.errors ?? [],
          localKept: release.cleanup.local?.kept ?? [],
          remoteKept: release.cleanup.remote?.kept ?? [],
        })
      }
    } catch (error) {
      residuals.push({ releaseId: name, completedAt: null, errors: [{ code: 'release-json-invalid', message: error.message }], localKept: [], remoteKept: [] })
    }
  }
  return { status: residuals.length === 0 ? 'complete' : 'incomplete', residuals }
}

function commandStatus() {
  const localCandidate = existsSync(join(stateRoot, 'candidates/latest.json')) ? readJson(join(stateRoot, 'candidates/latest.json')) : null
  const developmentCandidate = existsSync(developmentCandidatePointerPath()) ? readJson(developmentCandidatePointerPath()) : null
  const cleanup = cleanupResidualStatus()
  const remoteResult = runStatus('ssh', ['-o', 'BatchMode=yes', target, 'bash', '-s'], { input: `set -u
if command -v docker >/dev/null 2>&1; then
  docker ps --filter name='^dsh-' --format '{{.Names}} {{.Image}} {{.Status}}' 2>/dev/null || true
else
  echo 'docker=not-installed'
fi
printf 'current='; readlink -f /home/herman/.local/share/dsh-container/current 2>/dev/null || true
printf 'last-good='; readlink -f /home/herman/.local/share/dsh-container/last-good 2>/dev/null || true
` })
  out({ local: { stateRoot, latestCandidate: localCandidate, developmentMain: developmentCandidate, cleanup }, remote: { target, reachable: remoteResult.status === 0, output: String(remoteResult.stdout ?? '').trim(), error: String(remoteResult.stderr ?? '').trim() } })
}

function usage() {
  out(`DSH Docker 发版唯一入口

  ./release/dsh snapshot latest
  ./release/dsh dev prepare --source <独立任务worktree> [--candidate <latest-main-candidate.json>]
  ./release/dsh dev verify --source <独立任务worktree> [--package <已挂载包>]
  ./release/dsh dev up --snapshot latest|synthetic [--candidate candidate.json] [--reset]
  ./release/dsh dev shell [--candidate candidate.json]
  ./release/dsh dev down [--source <独立任务worktree>]
  ./release/dsh dev retire --source <独立任务worktree>
  ./release/dsh build --purpose development|release --harness-ref <40位commit> --plugins-ref <40位commit>
  ./release/dsh credential notion
  ./release/dsh credential notion --stdin --approved [--replace]
  ./release/dsh harness notion-automation [--approved|--status]
  ./release/dsh release --candidate <candidate.json> [--approved-stop]
  ./release/dsh release --release <release-id|release.json> --approved-release
  ./release/dsh status
  ./release/dsh accept --release <release-id|release.json> --evidence <8项验收JSON文件|JSON对象>
  ./release/dsh rollback --release <release-id|release.json> [--approved]

退出码：2 参数错误；3 等待授权；4 安全门；5 测试失败；6 生产验收失败。`)
}

async function main() {
  const [command, ...tokens] = process.argv.slice(2)
  if (command !== 'harness' && command !== 'status') ensureDir(stateRoot)
  const options = parseOptions(tokens)
  if (command === 'build') return commandBuild(options)
  if (command === 'dev') return commandDev(options)
  if (command === 'snapshot') return commandSnapshot(options)
  if (command === 'credential') return commandCredential(options)
  if (command === 'harness') return commandHarness(options, tokens)
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
