#!/usr/bin/env node
import http from 'node:http'
import net from 'node:net'
import { pathToFileURL } from 'node:url'

export const defaultAllowedClients = new Set([
  '127.0.0.1',
  '192.168.6.1',
  '192.168.6.189',
])

export function normalizeAddress(address = '') {
  return address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address
}

function allowed(socket, allowedClients) {
  return allowedClients.has(normalizeAddress(socket.remoteAddress))
}

export function createLanProxy({
  listenAddress = '192.168.6.240',
  listenPort = 3080,
  upstreamAddress = '127.0.0.1',
  upstreamPort = 3080,
  allowedClients = defaultAllowedClients,
} = {}) {
  const server = http.createServer((request, response) => {
    const clientAddress = normalizeAddress(request.socket.remoteAddress)
    if (!allowed(request.socket, allowedClients)) {
      response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' })
      response.end('Forbidden\n')
      return
    }

    const headers = {
      ...request.headers,
      'x-forwarded-for': clientAddress,
    }
    delete headers.forwarded
    const upstream = http.request({
      host: upstreamAddress,
      port: upstreamPort,
      method: request.method,
      path: request.url,
      headers,
    }, upstreamResponse => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
      upstreamResponse.pipe(response)
    })
    upstream.on('error', () => {
      if (!response.headersSent) response.writeHead(502, { connection: 'close' })
      response.end()
    })
    request.pipe(upstream)
  })

  server.on('upgrade', (request, socket, head) => {
    if (!allowed(socket, allowedClients)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      return
    }
    const clientAddress = normalizeAddress(socket.remoteAddress)
    const upstream = net.connect(upstreamPort, upstreamAddress)
    upstream.once('connect', () => {
      const lines = [`${request.method} ${request.url} HTTP/${request.httpVersion}`]
      for (let index = 0; index < request.rawHeaders.length; index += 2) {
        const name = request.rawHeaders[index]
        if (name.toLowerCase() === 'forwarded' || name.toLowerCase() === 'x-forwarded-for') continue
        lines.push(`${name}: ${request.rawHeaders[index + 1]}`)
      }
      lines.push(`X-Forwarded-For: ${clientAddress}`, '', '')
      upstream.write(lines.join('\r\n'))
      if (head.length > 0) upstream.write(head)
      socket.pipe(upstream).pipe(socket)
    })
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
  })

  return server
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const listenAddress = process.env.DSH_LAN_ADDRESS ?? '192.168.6.240'
  const listenPort = Number(process.env.DSH_LAN_PORT ?? 3080)
  const upstreamPort = Number(process.env.DSH_WEB_PORT ?? 3080)
  const server = createLanProxy({ listenAddress, listenPort, upstreamPort })
  server.listen(listenPort, listenAddress, () => {
    console.log(`dsh lan proxy: http://${listenAddress}:${listenPort}/`)
  })
  const stop = () => server.close(() => process.exit(0))
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}
