import { createServer } from 'node:http'

const requests = []
const response = (res, value) => {
  const body = JSON.stringify({ ok: true, result: value })
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

createServer((req, res) => {
  requests.push({ method: req.method, url: req.url, time: new Date().toISOString() })
  const method = String(req.url ?? '').split('/').at(-1)?.split('?')[0]
  if (method === 'getMe') return response(res, { id: 1, is_bot: true, first_name: 'DSH Test', username: 'dsh_test_bot' })
  if (method === 'getUpdates') return response(res, [])
  if (method === 'getRequests') return response(res, requests)
  if (method === 'sendMessage') return response(res, { message_id: requests.length, date: Math.floor(Date.now() / 1000), chat: { id: 1, type: 'private' }, text: 'test' })
  if (method === 'sendChatAction' || method === 'setMessageReaction') return response(res, true)
  return response(res, true)
}).listen(8080, '0.0.0.0', () => {
  process.stdout.write('fake Telegram listening on 8080\n')
})
