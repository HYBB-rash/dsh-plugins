import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  forbiddenRuntimeReferences,
  planReconciliation,
  reconcileProductionJobs,
  specFromInspection,
  specSha256,
  validateImageTargets,
  validateManifest,
} from '../scripts/reconcile_production_jobs.mjs'

const desired = {
  externalRef: 'legacy:watchdog',
  schedule: { kind: 'cron', expr: '1-59/2 * * * *' },
  command: {
    argv: ['/usr/bin/bash', '/opt/dsh/automations/mywechat/watchdog.sh'],
    timeoutSeconds: 600,
    outputMaxBytes: 1_048_576,
  },
  deliver: 'telegram',
  failureAlert: { after: 2, cooldownMinutes: 30 },
}

const old = {
  ...desired,
  command: {
    ...desired.command,
    argv: ['sh', '-lc', 'bash /home/user/.openclaw/workspace/watchdog.sh'],
  },
}

function inspection(spec = old, overrides = {}) {
  return {
    kind: 'command',
    id: 'job-old',
    createdAt: '2026-08-28T00:00:00.000Z',
    ...spec,
    ...overrides,
  }
}

function manifestJob(overrides = {}) {
  return {
    kind: 'command',
    spec: desired,
    predecessorSpecSha256: [specSha256(old)],
    allowCreate: false,
    business: 'mywechat',
    manifestPath: '/opt/dsh/automations/mywechat/jobs.production.json',
    ...overrides,
  }
}

test('manifest validation closes unknown keys and malformed predecessor digests', () => {
  assert.throws(() => validateManifest({ schemaVersion: 1, business: 'x', jobs: [], extra: true }), /invalid manifest keys/)
  assert.throws(() => validateManifest({
    schemaVersion: 1,
    business: 'x',
    jobs: [{
      kind: 'command',
      spec: desired,
      predecessorSpecSha256: ['bad'],
      allowCreate: false,
    }],
  }), /predecessorSpecSha256/)
})

test('planner migrates only an explicitly declared predecessor', () => {
  const plan = planReconciliation({ mode: 'migrate', manifestJobs: [manifestJob()], activeJobs: [inspection()] })
  assert.equal(plan[0].action, 'replace')
  assert.equal(plan[0].beforeSha256, specSha256(old))
  assert.throws(() => planReconciliation({
    mode: 'migrate',
    manifestJobs: [manifestJob({ predecessorSpecSha256: [] })],
    activeJobs: [inspection()],
  }), /unknown predecessor/)
})

test('planner is idempotent, rejects check drift and only creates when declared', () => {
  assert.equal(planReconciliation({
    mode: 'check',
    manifestJobs: [manifestJob()],
    activeJobs: [inspection(desired)],
  })[0].action, 'unchanged')
  assert.throws(() => planReconciliation({ mode: 'check', manifestJobs: [manifestJob()], activeJobs: [inspection()] }), /drift/)
  assert.throws(() => planReconciliation({ mode: 'migrate', manifestJobs: [manifestJob()], activeJobs: [] }), /missing/)
  assert.equal(planReconciliation({
    mode: 'migrate',
    manifestJobs: [manifestJob({ allowCreate: true })],
    activeJobs: [],
  })[0].action, 'create')
})

test('planner rejects duplicate refs, kind mismatch and unmanaged forbidden dependencies before writes', () => {
  assert.throws(() => planReconciliation({
    mode: 'migrate',
    manifestJobs: [manifestJob()],
    activeJobs: [inspection(), inspection(old, { id: 'duplicate' })],
  }), /multiple active jobs/)
  assert.throws(() => planReconciliation({
    mode: 'migrate',
    manifestJobs: [manifestJob()],
    activeJobs: [{ ...inspection(), kind: 'agent' }],
  }), /kind mismatch/)
  assert.throws(() => planReconciliation({
    mode: 'migrate',
    manifestJobs: [manifestJob()],
    activeJobs: [inspection(), inspection(old, { id: 'unmanaged', externalRef: 'other' })],
  }), /unmanaged active job/)
})

test('release guard checks prompt cwd argv gate and indirect repository shells', () => {
  assert.deepEqual(forbiddenRuntimeReferences(inspection()), ['argv[2]'])
  assert.deepEqual(forbiddenRuntimeReferences({
    kind: 'agent',
    prompt: 'run /home/u/.openclaw/x',
    cwd: '/home/u/.openclaw',
    gate: { command: { argv: ['/bin/tool', '/home/u/.openclaw/gate'] } },
  }), ['prompt', 'cwd', 'gate.argv[1]'])
  assert.deepEqual(forbiddenRuntimeReferences(inspection({
    ...desired,
    command: { ...desired.command, argv: ['sh', '-lc', 'python /opt/dsh/automations/x.py'] },
  })), ['indirect-repository-shell'])
})

test('image target guard requires repository targets to be executable files', () => {
  const checked = validateImageTargets([manifestJob()], path => ({
    isFile: () => path.endsWith('watchdog.sh'),
    mode: 0o100755,
  }))
  assert.deepEqual(checked, ['/opt/dsh/automations/mywechat/watchdog.sh'])
  assert.throws(() => validateImageTargets([manifestJob()], () => ({ isFile: () => true, mode: 0o100644 })), /not executable/)
  const agent = manifestJob({
    kind: 'agent',
    spec: {
      externalRef: 'agent:test',
      schedule: { kind: 'cron', expr: '0 * * * *' },
      prompt: 'run `bash /opt/dsh/automations/mywechat/hourly.sh` now',
      deliver: 'telegram',
      sessionMode: 'per_run',
    },
  })
  assert.deepEqual(
    validateImageTargets([agent], () => ({ isFile: () => true, mode: 0o100755 })),
    ['/opt/dsh/automations/mywechat/hourly.sh'],
  )
})

test('reconciler records a verified replacement and closes persistence uncertainty', async () => {
  let active = [inspection()]
  const successfulClient = {
    readiness: async () => ({ ready: true }),
    replaceBoundCommand: async spec => {
      active = [inspection(spec, { id: 'job-new' })]
      return { ok: true, snapshot: { activeJob: active[0] } }
    },
  }
  const receipt = await reconcileProductionJobs({
    mode: 'migrate',
    client: successfulClient,
    inspectActive: () => active,
    manifestJobs: [manifestJob()],
  })
  assert.equal(receipt.status, 'migrated')
  assert.equal(receipt.bindings[0].afterJobId, 'job-new')
  assert.equal(receipt.bindings[0].afterSpecSha256, specSha256(desired))
  assert.deepEqual(specFromInspection(active[0]), desired)

  const uncertainClient = {
    readiness: async () => ({ ready: true }),
    replaceBoundCommand: async () => ({ ok: false, errorCode: 'persistence_uncertain' }),
  }
  await assert.rejects(() => reconcileProductionJobs({
    mode: 'migrate',
    client: uncertainClient,
    inspectActive: () => [inspection()],
    manifestJobs: [manifestJob()],
  }), /persistence_uncertain/)
})
