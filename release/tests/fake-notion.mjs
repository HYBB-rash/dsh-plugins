import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { afterEach, beforeEach, test } from 'node:test'
import {
  classifyFakeNotionRequest,
  createFakeNotionServer,
  FAKE_NOTION_API_VERSION,
  FAKE_NOTION_FIXTURE_LENGTH,
  FAKE_NOTION_FIXTURE_SHA256,
  FAKE_NOTION_MARKDOWN,
  FAKE_NOTION_PAGE_ID,
  FAKE_NOTION_TOKEN,
  isLoopbackRemoteAddress,
} from '../scripts/fake-notion.mjs'

let server
let baseUrl

beforeEach(async () => {
  server = createFakeNotionServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert(address && typeof address === 'object')
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterEach(async () => {
  server.closeAllConnections?.()
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()))
  })
})

const pagePath = `/v1/pages/${FAKE_NOTION_PAGE_ID}/markdown`
const zeroCounts = {
  schemaVersion: 1,
  successfulGetCount: 0,
  rejectedGetCount: 0,
  mutationRequestCount: 0,
  otherApiRequestCount: 0,
  fixtureLength: FAKE_NOTION_FIXTURE_LENGTH,
  fixtureSha256: FAKE_NOTION_FIXTURE_SHA256,
}
const getCount = async () => {
  const response = await fetch(`${baseUrl}/__dsh_test__/request-count`)
  assert.equal(response.status, 200)
  return response.json()
}

test('serves the fixed versioned page as a complete markdown envelope', async () => {
  assert.match(FAKE_NOTION_PAGE_ID, /^[0-9a-f]{32}$/)
  const response = await fetch(`${baseUrl}${pagePath}`, {
    headers: {
      Authorization: `Bearer ${FAKE_NOTION_TOKEN}`,
      'Notion-Version': FAKE_NOTION_API_VERSION,
    },
  })

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    id: FAKE_NOTION_PAGE_ID,
    markdown: FAKE_NOTION_MARKDOWN,
    truncated: false,
    unknown_block_ids: [],
  })
  assert.equal(FAKE_NOTION_FIXTURE_LENGTH, Buffer.byteLength(FAKE_NOTION_MARKDOWN))
  assert.equal(
    FAKE_NOTION_FIXTURE_SHA256,
    createHash('sha256').update(Buffer.from(FAKE_NOTION_MARKDOWN, 'utf8')).digest('hex'),
  )
  assert.deepEqual(await getCount(), { ...zeroCounts, successfulGetCount: 1 })
})

test('classifies GET, mutation, and other API traffic without counting controls', async () => {
  await fetch(`${baseUrl}${pagePath}`)
  await fetch(`${baseUrl}/v1/pages/not-the-fixed-page/markdown`)
  await fetch(`${baseUrl}${pagePath}`, { method: 'PATCH' })
  await fetch(`${baseUrl}/v1/unexpected`)

  const before = await getCount()
  assert.deepEqual(before, {
    schemaVersion: 1,
    successfulGetCount: 0,
    rejectedGetCount: 2,
    mutationRequestCount: 1,
    otherApiRequestCount: 1,
    fixtureLength: FAKE_NOTION_FIXTURE_LENGTH,
    fixtureSha256: FAKE_NOTION_FIXTURE_SHA256,
  })
  const serialized = JSON.stringify(before)
  for (const privateValue of [FAKE_NOTION_TOKEN, FAKE_NOTION_MARKDOWN, 'Authorization', 'Notion-Version']) {
    assert.equal(serialized.includes(privateValue), false)
  }

  const reset = await fetch(`${baseUrl}/__dsh_test__/reset`, { method: 'POST' })
  assert.equal(reset.status, 200)
  assert.deepEqual(await reset.json(), zeroCounts)
  assert.deepEqual(await getCount(), zeroCounts)
  const invalidControl = await fetch(`${baseUrl}/__dsh_test__/request-count`, { method: 'POST' })
  assert.equal(invalidControl.status, 405)
  assert.deepEqual(await getCount(), zeroCounts)
})

test('allows controls only from loopback and counts sibling access as API traffic', () => {
  for (const address of ['127.0.0.1', '127.42.3.9', '::1', '::ffff:127.0.0.1']) {
    assert.equal(isLoopbackRemoteAddress(address), true)
  }
  for (const address of [undefined, 'localhost', '0.0.0.0', '192.168.1.2', '::ffff:192.168.1.2']) {
    assert.equal(isLoopbackRemoteAddress(address), false)
  }

  assert.equal(classifyFakeNotionRequest('GET', '/__dsh_test__/request-count', '127.0.0.1'), 'control-count')
  assert.equal(classifyFakeNotionRequest('POST', '/__dsh_test__/reset', '::ffff:127.0.0.1'), 'control-reset')
  assert.equal(classifyFakeNotionRequest('PATCH', '/__dsh_test__/reset', '::1'), 'control-invalid')
  assert.equal(classifyFakeNotionRequest('GET', '/__dsh_test__/request-count', '10.88.0.12'), 'other')
  assert.equal(classifyFakeNotionRequest('POST', '/__dsh_test__/reset', '10.88.0.12'), 'mutation')
})

test('fails closed for credentials, API version, page identity, and mutation', async () => {
  const wrongToken = await fetch(`${baseUrl}${pagePath}`, {
    headers: { Authorization: 'Bearer wrong', 'Notion-Version': FAKE_NOTION_API_VERSION },
  })
  assert.equal(wrongToken.status, 401)

  const wrongVersion = await fetch(`${baseUrl}${pagePath}`, {
    headers: { Authorization: `Bearer ${FAKE_NOTION_TOKEN}`, 'Notion-Version': '2025-09-03' },
  })
  assert.equal(wrongVersion.status, 400)

  const wrongPage = await fetch(`${baseUrl}/v1/pages/not-the-fixed-page/markdown`, {
    headers: { Authorization: `Bearer ${FAKE_NOTION_TOKEN}`, 'Notion-Version': FAKE_NOTION_API_VERSION },
  })
  assert.equal(wrongPage.status, 404)

  const mutation = await fetch(`${baseUrl}${pagePath}`, { method: 'PATCH' })
  assert.equal(mutation.status, 405)
  const abnormal = await fetch(`${baseUrl}${pagePath}`, { method: 'HEAD' })
  assert.equal(abnormal.status, 405)
  assert.deepEqual(await getCount(), {
    schemaVersion: 1,
    successfulGetCount: 0,
    rejectedGetCount: 3,
    mutationRequestCount: 1,
    otherApiRequestCount: 1,
    fixtureLength: FAKE_NOTION_FIXTURE_LENGTH,
    fixtureSha256: FAKE_NOTION_FIXTURE_SHA256,
  })
})
