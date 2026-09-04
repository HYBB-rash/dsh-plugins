#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

function fail() {
  console.error('dsh web: Telegram startup URL notification failed')
  process.exitCode = 1
}

function yamlScalar(source, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`^\\s*${escaped}:\\s*(.*?)\\s*$`, 'mu').exec(source)
  if (match === null || match[1] === '') throw new Error('missing credential')
  const raw = match[1]
  if (raw.startsWith('"')) return JSON.parse(raw)
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1).replaceAll("''", "'")
  return raw
}

async function main() {
  if (process.argv.length !== 2) throw new Error('URL arguments are forbidden')

  let input = ''
  for await (const chunk of process.stdin) input += chunk
  const launchUrl = new URL(input.trim())
  if (launchUrl.protocol !== 'http:' || launchUrl.hostname !== '127.0.0.1') throw new Error('invalid launch URL')
  if (!launchUrl.searchParams.has('token')) throw new Error('missing launch token')

  const publicOrigin = new URL(process.env.DSH_WEB_PUBLIC_ORIGIN ?? 'https://dsh.man-her.icu')
  const allowedProtocol = publicOrigin.protocol === 'https:'
    || (publicOrigin.protocol === 'http:' && publicOrigin.hostname === '127.0.0.1')
  if (!allowedProtocol || publicOrigin.username !== '' || publicOrigin.password !== ''
    || publicOrigin.pathname !== '/' || publicOrigin.search !== '' || publicOrigin.hash !== '') {
    throw new Error('invalid public origin')
  }
  const publicUrl = new URL(launchUrl.pathname, publicOrigin)
  publicUrl.search = launchUrl.search

  const dshHome = process.env.DSH_HOME
  if (dshHome === undefined || dshHome === '') throw new Error('missing DSH_HOME')
  const credentials = await readFile(join(dshHome, '.credentials.yaml'), 'utf8')
  const botToken = yamlScalar(credentials, 'TELEGRAM_BOT_TOKEN')
  const chatId = yamlScalar(credentials, 'TELEGRAM_ALLOWED_CHAT_ID')
  if (!/^\d+:[A-Za-z0-9_-]+$/u.test(botToken) || !/^-?\d+$/u.test(chatId)) throw new Error('invalid credential')

  const apiOrigin = new URL(process.env.DSH_TELEGRAM_API_ORIGIN ?? 'https://api.telegram.org')
  const endpoint = new URL(`/bot${botToken}/sendMessage`, apiOrigin)
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: publicUrl.href }),
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error('Telegram rejected notification')
  const body = await response.json()
  if (body?.ok !== true) throw new Error('Telegram returned an unsuccessful result')
}

try {
  await main()
} catch {
  fail()
}
