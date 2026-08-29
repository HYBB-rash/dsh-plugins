#!/usr/bin/env node

import { constants as fsConstants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'

const productionCredentialPath = '/run/dsh-production-credentials/.credentials.yaml'
const maximumCredentialBytes = 1024 * 1024
const maximumTokenBytes = 16 * 1024
const maximumRequestBytes = 16 * 1024 * 1024
const maximumResponseBytes = 32 * 1024 * 1024
const maximumRequests = 48
const maximumWallclockMs = 30 * 60 * 1000

function fixedFailure(message) {
  process.stderr.write(`${message}\n`)
  process.exitCode = 4
}

function sameIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.uid === right.uid
    && left.gid === right.gid
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
}

function validateToken(token) {
  if (!Buffer.isBuffer(token) || token.length < 1 || token.length > maximumTokenBytes) {
    throw new Error('invalid token length')
  }
  for (const byte of token) {
    if (byte < 0x21 || byte > 0x7e) throw new Error('token is not printable ASCII')
  }
  return token
}

async function extractCredential() {
  const pathEntry = lstatSync(productionCredentialPath, { bigint: true })
  if (!pathEntry.isFile() || pathEntry.isSymbolicLink()
    || pathEntry.nlink !== 1n || pathEntry.uid !== 1000n || pathEntry.gid !== 1000n
    || (pathEntry.mode & 0o777n) !== 0o600n
    || pathEntry.size < 1n || pathEntry.size > BigInt(maximumCredentialBytes)) {
    throw new Error('unsafe credential identity')
  }
  const descriptor = openSync(
    productionCredentialPath,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_CLOEXEC,
  )
  let text
  try {
    const before = fstatSync(descriptor, { bigint: true })
    if (!sameIdentity(pathEntry, before)) throw new Error('credential changed before read')
    text = readFileSync(descriptor, { encoding: 'utf8' })
    const after = fstatSync(descriptor, { bigint: true })
    if (!sameIdentity(before, after) || Buffer.byteLength(text) !== Number(before.size)) {
      throw new Error('credential changed during read')
    }
  } finally {
    closeSync(descriptor)
  }

  const credentialsModule = await import(
    'file:///opt/dsh/harness/packages/credentials/credentials-local/lib/index.js'
  )
  const document = credentialsModule.parseCredentialsDocument(text, productionCredentialPath)
  text = ''
  const value = document.refs.get('DEEPSEEK_API_KEY')
  if (typeof value !== 'string') throw new Error('credential reference missing')
  const token = validateToken(Buffer.from(value, 'utf8'))
  const framed = Buffer.concat([token, Buffer.from('\n')])
  await new Promise((resolve, reject) => {
    process.stdout.write(framed, error => error === null || error === undefined ? resolve() : reject(error))
  })
  framed.fill(0)
  token.fill(0)
}

async function readTokenFromStdin() {
  const iterator = process.stdin[Symbol.asyncIterator]()
  const chunks = []
  let length = 0
  while (true) {
    const item = await iterator.next()
    if (item.done) throw new Error('token frame ended early')
    const chunk = item.value
    const bytes = Buffer.from(chunk)
    if (Buffer.isBuffer(chunk)) chunk.fill(0)
    const newline = bytes.indexOf(0x0a)
    if (newline !== -1 && newline !== bytes.length - 1) throw new Error('token frame has trailing bytes')
    const content = newline === -1 ? bytes : bytes.subarray(0, newline)
    length += content.length
    if (length > maximumTokenBytes) throw new Error('token input too long')
    chunks.push(Buffer.from(content))
    bytes.fill(0)
    if (newline !== -1) break
  }
  const token = validateToken(Buffer.concat(chunks, length))
  for (const chunk of chunks) chunk.fill(0)
  const closed = (async () => {
    while (true) {
      const item = await iterator.next()
      if (item.done) return
      if (item.value.length !== 0) throw new Error('unexpected bytes after token frame')
    }
  })()
  return { token, closed }
}

function fixedResponse(response, status, body = '') {
  const bytes = Buffer.from(body)
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': String(bytes.length),
    'cache-control': 'no-store',
  })
  response.end(bytes)
  bytes.fill(0)
}

async function runRelay() {
  const { token, closed } = await readTokenFromStdin()
  const authorization = `Bearer ${token.toString('ascii')}`
  let activeRequests = 0
  let totalRequests = 0
  let stopping = false
  const startedAt = Date.now()
  const bindAddress = process.env.DSH_RELAY_BIND_ADDRESS
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/u.test(bindAddress ?? '')
    || bindAddress.split('.').some(part => Number(part) > 255)) {
    throw new Error('relay bind address is invalid')
  }

  const server = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/healthz') {
      response.writeHead(204, { 'cache-control': 'no-store' })
      response.end()
      return
    }
    if (stopping || Date.now() - startedAt >= maximumWallclockMs
      || request.method !== 'POST' || request.url !== '/chat/completions') {
      request.resume()
      fixedResponse(response, stopping || Date.now() - startedAt >= maximumWallclockMs ? 503 : 404)
      return
    }
    if (activeRequests >= 1 || totalRequests >= maximumRequests
      || !String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
      request.resume()
      fixedResponse(response, activeRequests >= 1 || totalRequests >= maximumRequests ? 503 : 415)
      return
    }
    const declaredLength = Number(request.headers['content-length'] ?? 0)
    if (!Number.isSafeInteger(declaredLength) || declaredLength < 0 || declaredLength > maximumRequestBytes) {
      request.resume()
      fixedResponse(response, 413)
      return
    }

    activeRequests += 1
    totalRequests += 1
    let received = 0
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      activeRequests -= 1
    }
    const upstream = https.request({
      protocol: 'https:',
      hostname: 'api.deepseek.com',
      port: 443,
      method: 'POST',
      path: '/chat/completions',
      headers: {
        authorization,
        'content-type': 'application/json',
        accept: 'application/json',
        ...(declaredLength > 0 ? { 'content-length': String(declaredLength) } : {}),
        'user-agent': 'dsh-harness-notion-automation-relay/1',
      },
      timeout: 180_000,
      agent: false,
    }, (upstreamResponse) => {
      const status = upstreamResponse.statusCode ?? 502
      const contentType = String(upstreamResponse.headers['content-type'] ?? '').toLowerCase()
      const responseLength = Number(upstreamResponse.headers['content-length'] ?? 0)
      if (status < 200 || (status >= 300 && status < 400)
        || (!contentType.startsWith('application/json') && !contentType.startsWith('text/event-stream'))
        || !Number.isSafeInteger(responseLength) || responseLength < 0 || responseLength > maximumResponseBytes) {
        upstreamResponse.resume()
        fixedResponse(response, 502)
        finish()
        return
      }
      response.writeHead(status, {
        'content-type': contentType,
        'cache-control': 'no-store',
      })
      let sent = 0
      upstreamResponse.on('data', (chunk) => {
        sent += chunk.length
        if (sent > maximumResponseBytes) {
          upstreamResponse.destroy()
          response.destroy()
          finish()
          return
        }
        if (!response.write(chunk)) upstreamResponse.pause()
      })
      response.on('drain', () => upstreamResponse.resume())
      response.on('close', () => {
        if (!settled) upstreamResponse.destroy()
        finish()
      })
      upstreamResponse.on('error', () => {
        response.destroy()
        finish()
      })
      upstreamResponse.on('end', () => {
        response.end()
        finish()
      })
    })
    upstream.on('timeout', () => upstream.destroy())
    upstream.on('error', () => {
      if (!response.headersSent) fixedResponse(response, 502)
      else response.destroy()
      finish()
    })
    request.on('data', (chunk) => {
      received += chunk.length
      if (received > maximumRequestBytes) {
        upstream.destroy()
        request.destroy()
        if (!response.headersSent) fixedResponse(response, 413)
        finish()
        return
      }
      if (!upstream.write(chunk)) request.pause()
    })
    upstream.on('drain', () => request.resume())
    request.on('end', () => upstream.end())
    request.setTimeout(30_000, () => {
      upstream.destroy()
      request.destroy()
      if (!response.headersSent) fixedResponse(response, 408)
      finish()
    })
    request.on('error', () => {
      upstream.destroy()
      finish()
    })
  })
  server.on('clientError', (_error, socket) => socket.destroy())
  server.headersTimeout = 5_000
  server.requestTimeout = 180_000
  server.keepAliveTimeout = 1_000
  server.maxRequestsPerSocket = 1

  const stop = () => {
    if (stopping) return
    stopping = true
    server.close(() => {
      token.fill(0)
      process.exit(0)
    })
    setTimeout(() => {
      token.fill(0)
      process.exit(0)
    }, 5_000).unref()
  }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  closed.then(stop, stop)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(8080, bindAddress, resolve)
  })
  setTimeout(stop, maximumWallclockMs).unref()
}

try {
  const mode = process.argv[2]
  if (process.argv.length !== 3 || !['extract', 'relay'].includes(mode)) {
    throw new Error('invalid bridge mode')
  }
  if (mode === 'extract') await extractCredential()
  else await runRelay()
} catch {
  fixedFailure('harness notion automation credential bridge failed')
}
