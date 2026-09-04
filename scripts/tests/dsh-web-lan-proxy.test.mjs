import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import { createLanProxy, defaultAllowedClients, normalizeAddress } from '../dsh-web-lan-proxy.mjs'

const listen = (server, host = '127.0.0.1') => new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, host, () => resolve(server.address().port))
})
const close = server => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
const request = ({ port, localAddress = '127.0.0.1' }) => new Promise((resolve, reject) => {
  const req = http.get({ host: '127.0.0.1', port, path: '/probe', localAddress }, response => {
    const chunks = []
    response.on('data', chunk => chunks.push(chunk))
    response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() }))
  })
  req.on('error', reject)
})

test('default LAN policy trusts only loopback, router, and this workstation', () => {
  assert.deepEqual([...defaultAllowedClients].sort(), ['127.0.0.1', '192.168.6.1', '192.168.6.189'])
  assert.equal(normalizeAddress('::ffff:192.168.6.189'), '192.168.6.189')
  assert.equal(defaultAllowedClients.has(normalizeAddress('192.168.6.2')), false)
})

test('proxy forwards an allowed client and rejects another source before upstream', async () => {
  let upstreamRequests = 0
  const upstream = http.createServer((req, res) => {
    upstreamRequests += 1
    res.end(`upstream:${req.url}`)
  })
  const upstreamPort = await listen(upstream)
  const proxy = createLanProxy({
    listenAddress: '127.0.0.1',
    listenPort: 0,
    upstreamAddress: '127.0.0.1',
    upstreamPort,
    allowedClients: new Set(['127.0.0.1']),
  })
  const proxyPort = await listen(proxy)
  try {
    assert.deepEqual(await request({ port: proxyPort }), { status: 200, body: 'upstream:/probe' })
    assert.equal(upstreamRequests, 1)
    assert.deepEqual(await request({ port: proxyPort, localAddress: '127.0.0.2' }), { status: 403, body: 'Forbidden\n' })
    assert.equal(upstreamRequests, 1)
  } finally {
    await close(proxy)
    await close(upstream)
  }
})
