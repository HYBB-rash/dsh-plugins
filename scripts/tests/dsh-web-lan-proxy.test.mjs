import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import test from 'node:test'
import { createLanProxy, defaultAllowedClients, normalizeAddress } from '../dsh-web-lan-proxy.mjs'

const listen = (server, host = '127.0.0.1') => new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, host, () => resolve(server.address().port))
})
const close = server => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
const request = ({ port, localAddress = '127.0.0.1', headers = {} }) => new Promise((resolve, reject) => {
  const req = http.get({ host: '127.0.0.1', port, path: '/probe', localAddress, headers }, response => {
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

test('proxy forwards an allowed client without rewriting its browser authority', async () => {
  let upstreamRequests = 0
  let upstreamHost
  let upstreamOrigin
  const upstream = http.createServer((req, res) => {
    upstreamRequests += 1
    upstreamHost = req.headers.host
    upstreamOrigin = req.headers.origin
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
    assert.deepEqual(await request({
      port: proxyPort,
      headers: { host: '192.168.6.240:3080', origin: 'http://192.168.6.240:3080' },
    }), { status: 200, body: 'upstream:/probe' })
    assert.equal(upstreamRequests, 1)
    assert.equal(upstreamHost, '192.168.6.240:3080')
    assert.equal(upstreamOrigin, 'http://192.168.6.240:3080')
    assert.deepEqual(await request({ port: proxyPort, localAddress: '127.0.0.2' }), { status: 403, body: 'Forbidden\n' })
    assert.equal(upstreamRequests, 1)
  } finally {
    await close(proxy)
    await close(upstream)
  }
})

test('proxy preserves browser authority on WebSocket upgrades', async () => {
  let observed
  const upstream = http.createServer()
  upstream.on('upgrade', (request, socket) => {
    observed = { host: request.headers.host, origin: request.headers.origin }
    socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
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
    const response = await new Promise((resolve, reject) => {
      const socket = net.connect(proxyPort, '127.0.0.1', () => {
        socket.write([
          'GET /api/remote.mux HTTP/1.1',
          'Host: 192.168.6.240:3080',
          'Origin: http://192.168.6.240:3080',
          'Connection: Upgrade',
          'Upgrade: websocket',
          '',
          '',
        ].join('\r\n'))
      })
      let text = ''
      socket.on('data', chunk => { text += chunk.toString() })
      socket.on('end', () => resolve(text))
      socket.on('error', reject)
    })
    assert.match(response, /^HTTP\/1\.1 101 /)
    assert.deepEqual(observed, {
      host: '192.168.6.240:3080',
      origin: 'http://192.168.6.240:3080',
    })
  } finally {
    await close(proxy)
    await close(upstream)
  }
})
