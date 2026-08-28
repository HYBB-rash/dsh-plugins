#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const DEFAULT_MODULE = '/opt/dsh/harness/local-plugins/dsh-cron/lib/index.js'
const DEFAULT_MANIFEST_ROOT = '/opt/dsh/automations'
const DEFAULT_STORE_DIR = '/home/herman/.dsh/storages/dsh-cron'
const DEFAULT_SOCKET = join(DEFAULT_STORE_DIR, 'control.sock')
const AUTOMATION_ROOT = '/opt/dsh/automations/'
const FORBIDDEN_LEGACY_HOME_SEGMENT = '.open' + 'claw'
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/u

export function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`
}

export function specSha256(spec) {
  return `sha256:${createHash('sha256').update(canonicalize(spec)).digest('hex')}`
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value, required, optional = []) {
  const allowed = new Set([...required, ...optional])
  return required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => allowed.has(key))
}

function assertString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} must be a non-empty string`)
}

function assertManifestJob(job, source) {
  if (!isObject(job) || !exactKeys(job, ['kind', 'spec', 'predecessorSpecSha256', 'allowCreate'], ['promptFile'])) {
    throw new Error(`${source}: invalid job entry keys`)
  }
  if (job.kind !== 'agent' && job.kind !== 'command') throw new Error(`${source}: invalid job kind`)
  if (!isObject(job.spec)) throw new Error(`${source}: spec must be an object`)
  assertString(job.spec.externalRef, `${source}: spec.externalRef`)
  if (!Array.isArray(job.predecessorSpecSha256)
    || job.predecessorSpecSha256.some(value => typeof value !== 'string' || !HASH_PATTERN.test(value))) {
    throw new Error(`${source}: predecessorSpecSha256 must contain only sha256 digests`)
  }
  if (typeof job.allowCreate !== 'boolean') throw new Error(`${source}: allowCreate must be boolean`)
  if (job.kind === 'agent') {
    const inline = typeof job.spec.prompt === 'string'
    const referenced = typeof job.promptFile === 'string' && job.promptFile.trim() !== ''
    if (inline === referenced) throw new Error(`${source}: Agent job must define exactly one of spec.prompt or promptFile`)
  } else if (job.promptFile !== undefined) {
    throw new Error(`${source}: command job cannot define promptFile`)
  }
  if (job.kind === 'command' && !Array.isArray(job.spec.command?.argv)) throw new Error(`${source}: command spec is missing argv`)
}

export function validateManifest(value, source = 'manifest') {
  if (!isObject(value) || !exactKeys(value, ['schemaVersion', 'business', 'jobs'])) {
    throw new Error(`${source}: invalid manifest keys`)
  }
  if (value.schemaVersion !== 1) throw new Error(`${source}: unsupported schemaVersion`)
  assertString(value.business, `${source}: business`)
  if (!Array.isArray(value.jobs) || value.jobs.length === 0) throw new Error(`${source}: jobs must be non-empty`)
  value.jobs.forEach(job => assertManifestJob(job, source))
  return value
}

export function loadManifests(root = DEFAULT_MANIFEST_ROOT) {
  const paths = []
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile() && entry.name === 'jobs.production.json') paths.push(path)
    }
  }
  walk(root)
  paths.sort()
  if (paths.length === 0) throw new Error(`no production job manifests under ${root}`)
  const manifests = paths.map(path => ({ path, manifest: validateManifest(JSON.parse(readFileSync(path, 'utf8')), path) }))
  const refs = new Set()
  for (const { path, manifest } of manifests) {
    for (const job of manifest.jobs) {
      if (job.kind === 'agent' && job.promptFile !== undefined) {
        const promptPath = resolve(dirname(path), job.promptFile)
        if (!promptPath.startsWith(`${resolve(dirname(path))}/`)) throw new Error(`${path}: promptFile escapes business directory`)
        job.spec = { ...job.spec, prompt: readFileSync(promptPath, 'utf8').replace(/\n$/u, '') }
      }
      if (refs.has(job.spec.externalRef)) throw new Error(`duplicate manifest externalRef ${job.spec.externalRef}`)
      refs.add(job.spec.externalRef)
      job.manifestPath = path
      job.business = manifest.business
    }
  }
  return manifests.flatMap(({ manifest }) => manifest.jobs)
}

export function specFromInspection(job) {
  if (job.kind === 'command') {
    return {
      externalRef: job.externalRef,
      schedule: job.schedule,
      command: job.command,
      deliver: job.deliver,
      ...(job.failureAlert === undefined ? {} : { failureAlert: job.failureAlert }),
      ...(job.cwd === undefined ? {} : { cwd: job.cwd }),
    }
  }
  return {
    externalRef: job.externalRef,
    schedule: job.schedule,
    prompt: job.prompt,
    deliver: job.deliver,
    sessionMode: job.sessionMode,
    ...(job.agentEnvironment === undefined ? {} : { agentEnvironment: job.agentEnvironment }),
    ...(job.gate === undefined ? {} : { gate: job.gate }),
    ...(job.failureAlert === undefined ? {} : { failureAlert: job.failureAlert }),
    ...(job.cwd === undefined ? {} : { cwd: job.cwd }),
  }
}

function valuesAtRuntimeBoundaries(job) {
  const values = []
  if (job.kind === 'agent') {
    values.push(['prompt', job.prompt], ['cwd', job.cwd])
    for (const [index, value] of (job.gate?.command?.argv ?? []).entries()) values.push([`gate.argv[${index}]`, value])
  } else {
    values.push(['cwd', job.cwd])
    for (const [index, value] of (job.command?.argv ?? []).entries()) values.push([`argv[${index}]`, value])
  }
  return values.filter(([, value]) => typeof value === 'string')
}

function isIndirectRepositoryShell(job) {
  if (job.kind !== 'command') return false
  const argv = job.command?.argv ?? []
  const shell = argv[0]
  return (shell === 'sh' || shell === '/bin/sh' || shell === 'bash' || shell === '/bin/bash' || shell === '/usr/bin/bash')
    && (argv[1] === '-c' || argv[1] === '-lc')
    && argv.slice(2).some(value => typeof value === 'string' && value.includes(AUTOMATION_ROOT))
}

export function forbiddenRuntimeReferences(job) {
  const findings = valuesAtRuntimeBoundaries(job)
    .filter(([, value]) => value.includes(FORBIDDEN_LEGACY_HOME_SEGMENT))
    .map(([field]) => field)
  if (isIndirectRepositoryShell(job)) findings.push('indirect-repository-shell')
  return findings
}

function imageAutomationPaths(spec) {
  const values = spec.prompt === undefined
    ? [...(spec.command?.argv ?? [])]
    : [...(spec.gate?.command?.argv ?? [])]
  if (typeof spec.prompt === 'string') {
    values.push(...(spec.prompt.match(/\/opt\/dsh\/automations\/[A-Za-z0-9._/-]+/gu) ?? []))
  }
  return [...new Set(values.filter(value => typeof value === 'string' && value.startsWith(AUTOMATION_ROOT)))]
}

export function validateImageTargets(jobs, inspectPath = path => lstatSync(path)) {
  const checked = []
  for (const job of jobs) {
    for (const path of imageAutomationPaths(job.spec)) {
      const stat = inspectPath(path)
      if (!stat.isFile()) throw new Error(`manifest target is not a file: ${path}`)
      if ((stat.mode & 0o111) === 0) throw new Error(`manifest target is not executable: ${path}`)
      checked.push(path)
    }
  }
  return [...new Set(checked)].sort()
}

function indexActive(activeJobs) {
  const byRef = new Map()
  for (const job of activeJobs) {
    if (job.externalRef === undefined) continue
    const list = byRef.get(job.externalRef) ?? []
    list.push(job)
    byRef.set(job.externalRef, list)
  }
  return byRef
}

export function planReconciliation({ mode, manifestJobs, activeJobs }) {
  if (mode !== 'check' && mode !== 'migrate') throw new Error(`unsupported reconciliation mode: ${mode}`)
  const byRef = indexActive(activeJobs)
  const managedRefs = new Set(manifestJobs.map(job => job.spec.externalRef))
  const actions = []

  for (const [externalRef, jobs] of byRef) {
    if (jobs.length > 1) throw new Error(`externalRef has multiple active jobs: ${externalRef}`)
  }
  for (const job of activeJobs) {
    const findings = forbiddenRuntimeReferences(job)
    if (findings.length > 0 && (job.externalRef === undefined || !managedRefs.has(job.externalRef))) {
      throw new Error(`unmanaged active job ${job.id} has forbidden runtime references: ${findings.join(',')}`)
    }
  }

  for (const manifestJob of manifestJobs) {
    const externalRef = manifestJob.spec.externalRef
    const matches = byRef.get(externalRef) ?? []
    if (matches.length === 0) {
      if (mode === 'migrate' && manifestJob.allowCreate) {
        actions.push({ action: 'create', manifestJob, before: null, beforeSha256: null })
        continue
      }
      throw new Error(`managed binding is missing: ${externalRef}`)
    }
    const current = matches[0]
    if (current.kind !== manifestJob.kind) throw new Error(`managed binding kind mismatch: ${externalRef}`)
    const currentSpec = specFromInspection(current)
    const currentSha256 = specSha256(currentSpec)
    const desiredSha256 = specSha256(manifestJob.spec)
    if (currentSha256 === desiredSha256) {
      actions.push({ action: 'unchanged', manifestJob, before: current, beforeSha256: currentSha256 })
      continue
    }
    if (mode === 'check') throw new Error(`managed binding drift: ${externalRef}`)
    if (!manifestJob.predecessorSpecSha256.includes(currentSha256)) {
      throw new Error(`managed binding has unknown predecessor: ${externalRef} ${currentSha256}`)
    }
    actions.push({ action: 'replace', manifestJob, before: current, beforeSha256: currentSha256 })
  }
  return actions
}

function assertControlSuccess(response, label) {
  if (response?.ok !== true || !isObject(response.snapshot)) {
    const code = response?.errorCode ?? response?.code ?? 'unknown'
    throw new Error(`${label} failed: ${code}`)
  }
  return response.snapshot
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.tmp.${process.pid}.${randomUUID()}`
  const bytes = `${JSON.stringify(value, null, 2)}\n`
  const fd = openSync(temporary, 'wx', 0o600)
  try {
    writeFileSync(fd, bytes)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  chmodSync(temporary, 0o600)
  renameSync(temporary, path)
  const directory = openSync(dirname(path), 'r')
  try { fsyncSync(directory) } finally { closeSync(directory) }
}

export async function reconcileProductionJobs({
  mode,
  client,
  inspectActive,
  manifestJobs,
  imageTargets = [],
  receiptPath,
}) {
  await client.readiness()
  const beforeJobs = inspectActive()
  const plan = planReconciliation({ mode, manifestJobs, activeJobs: beforeJobs })
  const receipt = {
    schemaVersion: 1,
    mode,
    status: 'prepared',
    startedAt: new Date().toISOString(),
    imageTargets,
    bindings: plan.map(item => ({
      business: item.manifestJob.business,
      manifestPath: item.manifestJob.manifestPath,
      kind: item.manifestJob.kind,
      externalRef: item.manifestJob.spec.externalRef,
      action: item.action,
      beforeJobId: item.before?.id ?? null,
      beforeSpecSha256: item.beforeSha256,
      desiredSpecSha256: specSha256(item.manifestJob.spec),
    })),
  }
  if (receiptPath) writeJsonAtomic(receiptPath, receipt)

  try {
    for (const item of plan) {
      if (item.action === 'unchanged') continue
      const { kind, spec } = item.manifestJob
      const response = item.action === 'create'
        ? kind === 'command' ? await client.ensureBoundCommand(spec) : await client.ensureBound(spec)
        : kind === 'command' ? await client.replaceBoundCommand(spec) : await client.replaceBound(spec)
      const snapshot = assertControlSuccess(response, `${item.action} ${spec.externalRef}`)
      const active = snapshot.activeJob
      if (active === null || active === undefined) throw new Error(`control response omitted active job: ${spec.externalRef}`)
      const actual = specFromInspection({ kind, ...active })
      if (specSha256(actual) !== specSha256(spec)) throw new Error(`control verification mismatch: ${spec.externalRef}`)
      const entry = receipt.bindings.find(binding => binding.externalRef === spec.externalRef)
      entry.afterJobId = active.id
      entry.afterSpecSha256 = specSha256(actual)
      if (receiptPath) writeJsonAtomic(receiptPath, receipt)
    }

    const afterJobs = inspectActive()
    for (const job of afterJobs) {
      const findings = forbiddenRuntimeReferences(job)
      if (findings.length > 0) throw new Error(`active job ${job.id} has forbidden runtime references: ${findings.join(',')}`)
    }
    planReconciliation({ mode: 'check', manifestJobs, activeJobs: afterJobs })
    for (const binding of receipt.bindings) {
      if (binding.afterJobId === undefined) {
        const job = afterJobs.find(value => value.externalRef === binding.externalRef)
        binding.afterJobId = job?.id ?? null
        binding.afterSpecSha256 = job === undefined ? null : specSha256(specFromInspection(job))
      }
    }
    receipt.status = mode === 'check' ? 'checked' : 'migrated'
    receipt.finishedAt = new Date().toISOString()
    if (receiptPath) writeJsonAtomic(receiptPath, receipt)
    return receipt
  } catch (error) {
    receipt.status = 'failed'
    receipt.finishedAt = new Date().toISOString()
    receipt.error = String(error?.message ?? error).slice(0, 600)
    if (receiptPath) writeJsonAtomic(receiptPath, receipt)
    throw error
  }
}

function parseArgs(argv) {
  const options = { _: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (!value.startsWith('--')) {
      options._.push(value)
      continue
    }
    const key = value.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) options[key] = true
    else {
      options[key] = next
      index += 1
    }
  }
  return options
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const mode = options._[0]
  if (mode !== 'check' && mode !== 'migrate') {
    throw new Error('usage: reconcile_production_jobs.mjs check|migrate [--offline-store DIR] [--socket PATH] [--receipt PATH]')
  }
  const modulePath = resolve(options['module-path'] ?? DEFAULT_MODULE)
  const manifestRoot = resolve(options['manifest-root'] ?? DEFAULT_MANIFEST_ROOT)
  const storeDir = resolve(options['offline-store'] ?? options['store-dir'] ?? DEFAULT_STORE_DIR)
  const publicModule = await import(pathToFileURL(modulePath).href)
  const manifestJobs = loadManifests(manifestRoot)
  const imageTargets = validateImageTargets(manifestJobs)
  let server
  let socketPath = resolve(options.socket ?? DEFAULT_SOCKET)
  if (options['offline-store']) {
    socketPath = join(storeDir, `release-reconcile-${process.pid}.sock`)
    const control = publicModule.createControlService({ storeDir })
    server = publicModule.createControlRpcServer({ socketPath, control, environment: 'development' })
    await server.listen()
  }
  try {
    const client = publicModule.createControlRpcClient({ socketPath, timeoutMs: 5_000 })
    const receipt = await reconcileProductionJobs({
      mode,
      client,
      inspectActive: () => publicModule.inspectActiveJobs({ storeDir }),
      manifestJobs,
      imageTargets,
      receiptPath: options.receipt === undefined ? undefined : resolve(options.receipt),
    })
    process.stdout.write(`${JSON.stringify(receipt)}\n`)
  } finally {
    if (server !== undefined) await server.dispose()
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    process.stderr.write(`${String(error?.message ?? error).slice(0, 800)}\n`)
    process.exitCode = 1
  })
}
