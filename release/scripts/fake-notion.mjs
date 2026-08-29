import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

export const FAKE_NOTION_API_VERSION = '2026-03-11'
export const FAKE_NOTION_PAGE_ID = '00000000000000000000000000000001'
export const FAKE_NOTION_TOKEN = 'dsh-fake-notion-token-v1'
export const FAKE_NOTION_MARKDOWN = '# DSH fake Notion page v1\n\nTest-only fixture content.\n'
const FAKE_NOTION_MARKDOWN_BYTES = Buffer.from(FAKE_NOTION_MARKDOWN, 'utf8')
export const FAKE_NOTION_FIXTURE_LENGTH = FAKE_NOTION_MARKDOWN_BYTES.length
export const FAKE_NOTION_FIXTURE_SHA256 = createHash('sha256').update(FAKE_NOTION_MARKDOWN_BYTES).digest('hex')

const PAGE_PATH = `/v1/pages/${FAKE_NOTION_PAGE_ID}/markdown`
const PAGE_PATH_PATTERN = /^\/v1\/pages\/[^/]+\/markdown$/
const COUNT_PATH = '/__dsh_test__/request-count'
const RESET_PATH = '/__dsh_test__/reset'
const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export const isLoopbackRemoteAddress = (value) => {
  if (value === '::1') return true
  const address = String(value ?? '').toLowerCase()
  const ipv4 = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address
  const octets = ipv4.split('.')
  return octets.length === 4
    && octets.every(octet => /^(?:0|[1-9][0-9]{0,2})$/.test(octet) && Number(octet) <= 255)
    && octets[0] === '127'
}

export const classifyFakeNotionRequest = (method, path, remoteAddress) => {
  const controlPath = path === COUNT_PATH || path === RESET_PATH
  if (controlPath && isLoopbackRemoteAddress(remoteAddress)) {
    if (method === 'GET' && path === COUNT_PATH) return 'control-count'
    if (method === 'POST' && path === RESET_PATH) return 'control-reset'
    return 'control-invalid'
  }
  if (method === 'GET' && PAGE_PATH_PATTERN.test(path)) return 'get'
  if (MUTATION_METHODS.has(method ?? '')) return 'mutation'
  return 'other'
}

const sendJson = (res, status, value) => {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    'content-type': 'application/json',
  })
  res.end(body)
}

export const createFakeNotionServer = () => {
  const requestCounts = {
    successfulGetCount: 0,
    rejectedGetCount: 0,
    mutationRequestCount: 0,
    otherApiRequestCount: 0,
  }
  const countReceipt = () => ({
    schemaVersion: 1,
    ...requestCounts,
    fixtureLength: FAKE_NOTION_FIXTURE_LENGTH,
    fixtureSha256: FAKE_NOTION_FIXTURE_SHA256,
  })

  return createServer((req, res) => {
    const requestUrl = new URL(req.url ?? '/', 'http://fake-notion.invalid')
    const path = requestUrl.pathname
    const classification = classifyFakeNotionRequest(req.method, path, req.socket.remoteAddress)

    // Only a loopback exec inside this sidecar can use test controls. Traffic
    // from sibling containers is counted like ordinary API traffic instead.
    if (classification === 'control-count') return sendJson(res, 200, countReceipt())
    if (classification === 'control-reset') {
      requestCounts.successfulGetCount = 0
      requestCounts.rejectedGetCount = 0
      requestCounts.mutationRequestCount = 0
      requestCounts.otherApiRequestCount = 0
      return sendJson(res, 200, countReceipt())
    }
    if (classification === 'control-invalid') {
      return sendJson(res, 405, { object: 'error', status: 405 })
    }

    const pageApi = PAGE_PATH_PATTERN.test(path)
    if (req.method === 'GET' && pageApi) {
      if (path !== PAGE_PATH) {
        requestCounts.rejectedGetCount += 1
        return sendJson(res, 404, { object: 'error', status: 404 })
      }
      if (req.headers.authorization !== `Bearer ${FAKE_NOTION_TOKEN}`) {
        requestCounts.rejectedGetCount += 1
        return sendJson(res, 401, { object: 'error', status: 401 })
      }
      if (req.headers['notion-version'] !== FAKE_NOTION_API_VERSION) {
        requestCounts.rejectedGetCount += 1
        return sendJson(res, 400, { object: 'error', status: 400 })
      }
      requestCounts.successfulGetCount += 1
      return sendJson(res, 200, {
        id: FAKE_NOTION_PAGE_ID,
        markdown: FAKE_NOTION_MARKDOWN,
        truncated: false,
        unknown_block_ids: [],
      })
    }
    if (classification === 'mutation') requestCounts.mutationRequestCount += 1
    else requestCounts.otherApiRequestCount += 1
    if (path === PAGE_PATH) {
      return sendJson(res, 405, { object: 'error', status: 405 })
    }
    return sendJson(res, 404, { object: 'error', status: 404 })
  })
}

const parsePort = (raw) => {
  if (!/^[1-9][0-9]{0,4}$/.test(raw)) throw new Error('invalid fake Notion port')
  const port = Number(raw)
  if (port > 65535) throw new Error('invalid fake Notion port')
  return port
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const port = parsePort(process.env.FAKE_NOTION_PORT ?? '8081')
  createFakeNotionServer().listen(port, '0.0.0.0', () => {
    process.stdout.write(`fake Notion listening on 0.0.0.0:${port}; page=${FAKE_NOTION_PAGE_ID}\n`)
  })
}
