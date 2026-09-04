import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import http from 'node:http'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const script = new URL('../dsh-web-notify-start-url.mjs', import.meta.url)
const launchUrl = 'http://127.0.0.1:3080/?token=launch-secret'

const listen = server => new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => resolve(server.address().port))
})
const close = server => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
const run = (home, apiOrigin, args = [], publicOrigin) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [script.pathname, ...args], {
    env: {
      ...process.env,
      DSH_HOME: home,
      DSH_TELEGRAM_API_ORIGIN: apiOrigin,
      ...(publicOrigin === undefined ? {} : { DSH_WEB_PUBLIC_ORIGIN: publicOrigin }),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const stdout = []
  const stderr = []
  child.stdout.on('data', chunk => stdout.push(chunk))
  child.stderr.on('data', chunk => stderr.push(chunk))
  child.once('error', reject)
  child.once('exit', code => resolve({
    code,
    stdout: Buffer.concat(stdout).toString(),
    stderr: Buffer.concat(stderr).toString(),
  }))
  child.stdin.end(`${launchUrl}\n`)
})

async function credentialHome() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-web-notify-test.'))
  await mkdir(home, { recursive: true })
  await writeFile(join(home, '.credentials.yaml'), [
    'version: 1',
    'refs:',
    '  TELEGRAM_BOT_TOKEN: 123:test-bot-token',
    '  TELEGRAM_ALLOWED_CHAT_ID: "-10001"',
    '',
  ].join('\n'), { mode: 0o600 })
  return home
}

function assertSecretsAbsent(result) {
  for (const output of [result.stdout, result.stderr]) {
    assert.doesNotMatch(output, /launch-secret|test-bot-token/)
  }
}

test('sends exactly one public HTTPS startup URL without logging secrets', async () => {
  const home = await credentialHome()
  const requests = []
  const server = http.createServer((request, response) => {
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      requests.push({ path: request.url, body: JSON.parse(Buffer.concat(chunks).toString()) })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"ok":true,"result":{}}')
    })
  })
  const port = await listen(server)
  try {
    const result = await run(home, `http://127.0.0.1:${port}`)
    assert.equal(result.code, 0)
    assertSecretsAbsent(result)
    assert.deepEqual(requests, [{
      path: '/bot123:test-bot-token/sendMessage',
      body: { chat_id: '-10001', text: 'https://dsh.man-her.icu/?token=launch-secret' },
    }])
  } finally {
    await close(server)
    await rm(home, { recursive: true, force: true })
  }
})

test('allows an explicitly configured loopback HTTP startup URL', async () => {
  const home = await credentialHome()
  const requests = []
  const server = http.createServer((request, response) => {
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      requests.push({ path: request.url, body: JSON.parse(Buffer.concat(chunks).toString()) })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"ok":true,"result":{}}')
    })
  })
  const port = await listen(server)
  try {
    const result = await run(home, `http://127.0.0.1:${port}`, [], 'http://127.0.0.1:3080')
    assert.equal(result.code, 0)
    assertSecretsAbsent(result)
    assert.deepEqual(requests, [{
      path: '/bot123:test-bot-token/sendMessage',
      body: { chat_id: '-10001', text: launchUrl },
    }])
  } finally {
    await close(server)
    await rm(home, { recursive: true, force: true })
  }
})

test('rejects a non-loopback HTTP public origin', async () => {
  const home = await credentialHome()
  try {
    const result = await run(home, 'http://127.0.0.1:9', [], 'http://192.168.1.10:3080')
    assert.notEqual(result.code, 0)
    assertSecretsAbsent(result)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('fails closed without credentials or after a Telegram rejection and never leaks secrets', async () => {
  const missingHome = await mkdtemp(join(tmpdir(), 'dsh-web-notify-missing.'))
  const missing = await run(missingHome, 'http://127.0.0.1:9')
  assert.notEqual(missing.code, 0)
  assertSecretsAbsent(missing)
  await rm(missingHome, { recursive: true, force: true })

  const home = await credentialHome()
  const server = http.createServer((_request, response) => {
    response.writeHead(500)
    response.end('rejected')
  })
  const port = await listen(server)
  try {
    const rejected = await run(home, `http://127.0.0.1:${port}`)
    assert.notEqual(rejected.code, 0)
    assertSecretsAbsent(rejected)
  } finally {
    await close(server)
    await rm(home, { recursive: true, force: true })
  }
})

test('refuses URL arguments so the login token never appears in process argv', async () => {
  const home = await credentialHome()
  try {
    const result = await run(home, 'http://127.0.0.1:9', [launchUrl])
    assert.notEqual(result.code, 0)
    assertSecretsAbsent(result)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
