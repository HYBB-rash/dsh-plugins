import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const SELF_TEST_SCRIPT = '/opt/dsh/release-system/scripts/self-test.sh'
const X_FEED_ENTRY_URL = 'file:///opt/dsh/harness/local-plugins/x-feed/lib/index.js'
const X_FEED_PACKAGE_JSON = '/opt/dsh/harness/local-plugins/x-feed/package.json'
const PERSONAL_FEED_PACKAGE = '@herman/personal-feed'
const PERSONAL_FEED_ENTRY = '/opt/dsh/harness/local-plugins/personal-feed/lib/index.js'
const SELF_TEST_RECEIPT = 'personal-feed-x-startup-self-test/v1'
const SELF_TEST_PASS = 'container self-test passed'
const SELF_TEST_FAILURE = 'personal-feed-x-startup-self-test failed'
const MODE_ENV = 'DSH_PERSONAL_FEED_STARTUP_SELF_TEST_MODE'
const TRACE_ENV = 'DSH_PERSONAL_FEED_STARTUP_SELF_TEST_TRACE'
const FORMAL_PATH = '/opt/dsh/harness/node_modules/.bin:/usr/local/bin:/usr/bin:/bin'
const TRACE_WAIT_MS = 5_000
const TRACE_POLL_MS = 50
const WATCHDOG_MS = 120_000
const TERMINATION_GRACE_MS = 2_000

const scenarios = Object.freeze([
  { name: 'success', mode: 'success', canary: 'PF_X_STARTUP_SUCCESS_CANARY' },
  { name: 'wrong-receipt', mode: 'wrong-receipt', canary: 'PF_X_STARTUP_WRONG_RECEIPT_CANARY' },
  { name: 'throw', mode: 'throw', canary: 'PF_X_STARTUP_THROW_CANARY' },
])

function fixtureSource(canaries) {
  return `import { appendFileSync } from 'node:fs'

const receipt = ${JSON.stringify(SELF_TEST_RECEIPT)}
const modeName = ${JSON.stringify(MODE_ENV)}
const traceName = ${JSON.stringify(TRACE_ENV)}
const wrongReceipt = ${JSON.stringify(canaries['wrong-receipt'])}
const thrownCanary = ${JSON.stringify(canaries.throw)}

export async function runPersonalFeedXStartupSelfTest() {
  appendFileSync(process.env[traceName], JSON.stringify({ calls: 1, argCount: arguments.length }) + '\\n', 'utf8')
  if (process.env[modeName] === 'wrong-receipt') return wrongReceipt
  if (process.env[modeName] === 'throw') throw new Error(thrownCanary)
  return receipt
}
`
}

function loaderSource(fixtureUrl) {
  return `const exactEntry = ${JSON.stringify(X_FEED_ENTRY_URL)}
const fixture = ${JSON.stringify(fixtureUrl)}

export async function resolve(specifier, context, defaultResolve) {
  if (specifier === exactEntry) return { url: fixture, shortCircuit: true }
  return defaultResolve(specifier, context, defaultResolve)
}
`
}

function preloadSource() {
  return `const moduleApi = require('node:module')
const originalCreateRequire = moduleApi.createRequire
const exactFilename = ${JSON.stringify(X_FEED_PACKAGE_JSON)}
const exactSpecifier = ${JSON.stringify(PERSONAL_FEED_PACKAGE)}
const expectedResolution = ${JSON.stringify(PERSONAL_FEED_ENTRY)}

moduleApi.createRequire = function createRequire(filename) {
  const requireFunction = originalCreateRequire(filename)
  if (filename !== exactFilename) return requireFunction
  const originalResolve = requireFunction.resolve
  requireFunction.resolve = function resolve(specifier, ...args) {
    if (specifier === exactSpecifier) return expectedResolution
    return Reflect.apply(originalResolve, requireFunction, [specifier, ...args])
  }
  return requireFunction
}
`
}

function prepareFixture(root) {
  const packageRoot = join(root, 'fixture-package')
  const fixturePath = join(packageRoot, 'index.mjs')
  const loaderPath = join(root, 'exact-x-feed-loader.mjs')
  const preloadPath = join(root, 'topology-preload.cjs')
  const tracePath = join(root, 'trace.jsonl')
  const canaries = {
    'wrong-receipt': 'PF_X_STARTUP_WRONG_RECEIPT_CANARY',
    throw: 'PF_X_STARTUP_THROW_CANARY',
  }

  mkdirSync(packageRoot, { recursive: true })
  writeFileSync(join(packageRoot, 'package.json'), '{"name":"fixture-x-feed","type":"module"}\n', 'utf8')
  writeFileSync(fixturePath, fixtureSource(canaries), 'utf8')
  writeFileSync(loaderPath, loaderSource(pathToFileURL(fixturePath).href), 'utf8')
  writeFileSync(preloadPath, preloadSource(), 'utf8')
  writeFileSync(tracePath, '', 'utf8')
  return { fixtureRoot: packageRoot, loaderPath, preloadPath, tracePath, canaries }
}

function killProcessGroup(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (!Number.isInteger(child.pid) || child.pid <= 0) return
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error
  }
}

function runReleaseSelfTest(env, cwd) {
  const child = spawn('bash', [SELF_TEST_SCRIPT], {
    cwd,
    detached: true,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  let settled = false
  let timedOut = false
  let watchdog
  let hardStop

  const result = new Promise(resolve => {
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(watchdog)
      clearTimeout(hardStop)
      resolve(value)
    }

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', error => finish({ error, code: null, signal: null, timedOut, stdout, stderr }))
    child.once('close', (code, signal) => finish({ code, signal, timedOut, stdout, stderr }))
    watchdog = setTimeout(() => {
      timedOut = true
      killProcessGroup(child)
      hardStop = setTimeout(() => finish({ code: null, signal: 'SIGKILL', timedOut: true, stdout, stderr }), TERMINATION_GRACE_MS)
    }, WATCHDOG_MS)
  })

  return { child, result }
}

function exactLineCount(text, line) {
  return text.split(/\r?\n/u).filter(candidate => candidate === line).length
}

function traceRecords(tracePath) {
  return readFileSync(tracePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
}

function traceHasRecord(tracePath) {
  return readFileSync(tracePath, 'utf8').length > 0
}

function waitForTraceOrEarlyExit(tracePath, running) {
  return new Promise(resolve => {
    const startedAt = Date.now()
    let settled = false
    let pollTimer
    const finish = value => {
      if (settled) return
      settled = true
      clearTimeout(pollTimer)
      resolve(value)
    }
    const poll = () => {
      if (traceHasRecord(tracePath)) {
        finish({ invoked: true })
        return
      }
      if (Date.now() - startedAt >= TRACE_WAIT_MS) {
        finish({ invoked: false, reason: 'not-invoked' })
        return
      }
      pollTimer = setTimeout(poll, TRACE_POLL_MS)
    }
    void running.result.then(outcome => {
      if (settled) return
      if (!traceHasRecord(tracePath)) finish({ invoked: false, reason: 'early-exit', outcome })
    }, error => {
      if (settled) return
      finish({ invoked: false, reason: 'early-exit', outcome: { error } })
    })
    poll()
  })
}

async function waitForResultBeforeCleanup(result) {
  let timer
  const bounded = new Promise(resolve => {
    timer = setTimeout(resolve, TERMINATION_GRACE_MS)
  })
  try {
    await Promise.race([result.catch(() => undefined), bounded])
  } finally {
    clearTimeout(timer)
  }
}

function assertNoFixtureLeak(text, root, canary) {
  assert.equal(text.includes(root), false)
  assert.equal(text.includes(canary), false)
}

function assertNoFailureDetails(text) {
  assert.doesNotMatch(text, /\b(?:Error|Exception|Traceback)\b/u)
  assert.doesNotMatch(text, /\bat [^\n]*:\d+:\d+\b/u)
}

test('release self-test invokes the package-root startup self-test with a bounded, redacted contract', async t => {
  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const root = mkdtempSync(join(tmpdir(), 'personal-feed-x-release-self-test-'))
      const fixture = prepareFixture(root)
      const env = {
        HOME: '/home/herman',
        PATH: FORMAL_PATH,
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        TZ: 'Asia/Shanghai',
        NODE_NO_WARNINGS: '1',
        NODE_OPTIONS: `--require=${fixture.preloadPath} --experimental-loader=${pathToFileURL(fixture.loaderPath).href}`,
        [MODE_ENV]: scenario.mode,
        [TRACE_ENV]: fixture.tracePath,
      }
      const running = runReleaseSelfTest(env, root)
      try {
        const traceGate = await waitForTraceOrEarlyExit(fixture.tracePath, running)
        if (!traceGate.invoked) {
          if (traceGate.reason === 'early-exit') {
            assert.fail('infrastructure/preexisting self-test failure before package-root startup self-test')
          }
          assert.fail('package-root startup self-test was not invoked')
        }
        const outcome = await running.result
        assert.equal(outcome.error, undefined)
        assert.equal(outcome.timedOut, false)
        const records = traceRecords(fixture.tracePath)
        assert.deepStrictEqual(records, [{ calls: 1, argCount: 0 }])

        if (scenario.name === 'success') {
          assert.equal(outcome.code, 0)
          assert.equal(outcome.signal, null)
          assert.equal(exactLineCount(outcome.stdout, SELF_TEST_RECEIPT), 1)
          assert.equal(exactLineCount(outcome.stdout, SELF_TEST_PASS), 1)
          assert.ok(outcome.stdout.indexOf(`${SELF_TEST_RECEIPT}\n`) < outcome.stdout.indexOf(`${SELF_TEST_PASS}\n`))
          assert.equal(exactLineCount(outcome.stderr, SELF_TEST_FAILURE), 0)
          assertNoFixtureLeak(`${outcome.stdout}${outcome.stderr}`, root, scenario.canary)
        } else {
          assert.notEqual(outcome.code, 0)
          assert.equal(exactLineCount(outcome.stderr, SELF_TEST_FAILURE), 1)
          assert.equal(exactLineCount(outcome.stdout, SELF_TEST_RECEIPT), 0)
          assert.equal(exactLineCount(outcome.stderr, SELF_TEST_RECEIPT), 0)
          assert.equal(exactLineCount(outcome.stdout, SELF_TEST_PASS), 0)
          assert.equal(exactLineCount(outcome.stderr, SELF_TEST_PASS), 0)
          assertNoFixtureLeak(`${outcome.stdout}${outcome.stderr}`, root, scenario.canary)
          assertNoFailureDetails(`${outcome.stdout}${outcome.stderr}`)
        }
      } finally {
        killProcessGroup(running.child)
        await waitForResultBeforeCleanup(running.result)
        rmSync(root, { recursive: true, force: true })
      }
    })
  }
})
