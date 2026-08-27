import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { DatabaseSync } from 'node:sqlite'

const projectRoot = join(import.meta.dirname, '..', '..')
const harnessRoot = process.env.DSH_HARNESS_ROOT ?? '/home/herman/Documents/Codex/2026-08-14/deepseek-harness'
const prepareProfile = join(projectRoot, 'deployment/herman-hermes/context-manager-telegram-canary/prepare-profile.sh')
const canarySession = 'session-context-manager-focus-canary-a'
const roots: string[] = []
const servers: Server[] = []
const children: ChildProcess[] = []

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await once(child, 'exit')
    }
  }
  for (const server of servers.splice(0)) await new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)))
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

interface BotStub {
  readonly origin: string
  readonly sent: string[]
  readonly requestedOffsets: number[]
  enqueue(update: Record<string, unknown>): void
  receipt(path: string | undefined): void
}

async function startBotStub(): Promise<BotStub> {
  const updates: Record<string, unknown>[] = []
  const sent: string[] = []
  const requestedOffsets: number[] = []
  let receiptPath: string | undefined
  let messageId = 1_000
  const server = createServer(async (request, response) => {
    const endpoint = request.url?.split('?')[0]?.split('/').at(-1)
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    const body = chunks.length === 0 ? {} as Record<string, unknown> : JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
    const reply = (result: unknown, afterFinish?: () => Promise<void>) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, result }), () => { if (afterFinish !== undefined) void afterFinish() })
    }
    if (endpoint === 'getMe') return reply({ id: 100, username: 'context-manager-canary' })
    if (endpoint === 'getUpdates') {
      requestedOffsets.push(Number(new URL(request.url ?? '/', 'http://127.0.0.1').searchParams.get('offset')))
      const offset = requestedOffsets.at(-1)!
      const delivered = updates.filter(update => Number(update.update_id) >= offset)
      updates.splice(0, updates.length)
      if (delivered.length === 0) await new Promise(resolve => setTimeout(resolve, 25))
      return reply(delivered)
    }
    if (endpoint === 'sendMessage') {
      const text = String(body.text ?? '')
      sent.push(text)
      const receipt = receiptPath !== undefined && text.includes('公开回复：帮我审这份方案')
        ? async () => { await writeFile(receiptPath!, 'final-Bot-reply-observed\n', { mode: 0o600 }) }
        : undefined
      return reply({ message_id: messageId++ }, receipt)
    }
    if (endpoint === 'sendChatAction' || endpoint === 'setMessageReaction') return reply(true)
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: false, error_code: 404, description: 'unexpected local endpoint' }))
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen({ port: 0, host: '127.0.0.1' }, resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('local Bot stub did not bind TCP')
  return {
    origin: `http://127.0.0.1:${address.port}`, sent, requestedOffsets,
    enqueue: update => { updates.push(update) }, receipt: path => { receiptPath = path },
  }
}

async function materializeModuleRoot(root: string): Promise<string> {
  const moduleRoot = join(root, 'module-root')
  const scope = join(moduleRoot, '@deepseek-ai')
  const installed = join(harnessRoot, 'node_modules', '.pnpm', 'node_modules', '@deepseek-ai')
  await mkdir(scope, { recursive: true })
  for (const name of await readdir(installed)) {
    const source = join(installed, name)
    try {
      await symlink(await realpath(source), join(scope, name), 'dir')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  await rm(join(scope, 'dsh-client-ui-context-compactor'), { force: true })
  await rm(join(scope, 'dsh-telegram-gateway'), { force: true })
  await symlink(join(projectRoot, 'ui-context-compactor'), join(scope, 'dsh-client-ui-context-compactor'), 'dir')
  await symlink(join(projectRoot, 'telegram-gateway'), join(scope, 'dsh-telegram-gateway'), 'dir')
  return moduleRoot
}

async function prepareCanaryProfile(home: string, moduleRoot: string, credentials: string): Promise<void> {
  return await new Promise<void>((resolve, reject) => {
    const child = spawn(prepareProfile, [home, moduleRoot, credentials], { stdio: ['ignore', 'pipe', 'pipe'] })
    children.push(child)
    let stderr = ''
    let settled = false
    let timedOut = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      const index = children.indexOf(child)
      if (index !== -1) children.splice(index, 1)
      error === undefined ? resolve() : reject(error)
    }
    const timeout = setTimeout(() => {
      timedOut = true
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }, 10_000)
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    child.once('error', error => finish(error))
    child.once('exit', (code, signal) => timedOut
      ? finish(new Error('prepare profile child timed out after 10 seconds'))
      : code === 0 && signal === null
      ? finish()
      : finish(new Error(`prepare failed (code=${String(code)}, signal=${String(signal)}): ${stderr}`)))
  })
}

async function writeTestRuntime(root: string, home: string, botOrigin: string): Promise<string> {
  const profile = join(home, 'profiles', 'telegram')
  const overlay = join(root, 'local-only-overlay.yml')
  const runner = join(root, 'run-profile-once.mjs')
  await writeFile(join(profile, 'mock-llm.mjs'), [
    "import { LlmAdapter } from '@deepseek-ai/dsh-llm'",
    "const chunks = text => [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'block-end', index: 0, block: { type: 'text', text } }, { type: 'finish', reason: { kind: 'stop' } }]",
    'class Mock extends LlmAdapter {',
    '  async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 8192 } } }',
    '  async * stream(options) {',
    "    const classifier = options.messages.some(message => message.source?.kind === 'plugin' && message.source.plugin === 'ui-context-compactor:focus-canary-schema')",
    "    if (classifier) { yield* chunks('{\\\"kind\\\":\\\"focus\\\",\\\"subject\\\":\\\"帮我审这份方案\\\",\\\"relation\\\":\\\"new\\\"}'); return }",
    "    const text = options.messages.flatMap(message => message.content).filter(block => block.type === 'text').map(block => block.text).join('\\n')",
    "    const focus = /已记录当前焦点：([^\\n]+)/.exec(text)?.[1]",
    "    yield* chunks(focus === undefined ? '公开回复：未建立焦点' : `公开回复：${focus}`)",
    '  }',
    '}',
    "export const name = 'context-manager-local-mock-llm'",
    "export const inject = ['llm']",
    "export function apply(ctx) { ctx.llm.registerAdapter(['context-manager-local-mock'], new Mock()) }",
    '',
  ].join('\n'))
  await writeFile(overlay, [
    '- id: llm-deepseek', '  disabled: true',
    '- insert:', '    - id: context-manager-local-mock-llm', "      name: './mock-llm.mjs'",
    '- id: agent-default-model', '  config:', '    provider: context-manager-local-mock', '    model: context-manager-local-mock',
    '- id: ui-context-compactor', '  config:', '    focusCanary:', '      mode: enforce', '      safeUpdateMarginTokens: 64', '      allowlist:',
    `        - ${canarySession}`, '        - session-context-manager-focus-canary-b', '      auxiliary:',
    '        provider: context-manager-local-mock', '        model: context-manager-local-mock', '        maxOutputTokens: 64', '        timeoutMs: 500',
    '        maxExpressionChars: 240', '        maxProjectionTokens: 1024', '        safetyMarginTokens: 128',
    '    nativeWriterArbitration:', '      mode: enforce',
    '- id: telegram-gateway', '  config:', `    sessionId: ${canarySession}`, `    apiBaseUrl: ${JSON.stringify(botOrigin)}`, '    pollTimeoutSeconds: 1', '',
  ].join('\n'))
  await writeFile(runner, [
    "import { pathToFileURL } from 'node:url'",
    "import { createRequire } from 'node:module'",
    "const origin = process.env.CONTEXT_MANAGER_TEST_BOT_ORIGIN; if (origin === undefined) throw new Error('missing local Bot origin')",
    'const originalFetch = globalThis.fetch',
    'globalThis.fetch = async (input, init) => {',
    "  const raw = typeof input === 'string' || input instanceof URL ? String(input) : input.url",
    '  const url = new URL(raw)',
    "  if (url.origin !== origin) throw new Error(`blocked non-local fetch: ${url.origin}`)",
    '  return await originalFetch(input, init)',
    '}',
    "const { readFile, writeFile } = await import('node:fs/promises')",
    "const harnessRequire = createRequire(`${process.env.DSH_HOME}/profiles/telegram/package.json`)",
    "const { loadLayeredEnv } = await import(pathToFileURL(harnessRequire.resolve('@deepseek-ai/dsh-app-boot')).href)",
    "const { runProfile } = await import(pathToFileURL(`${process.env.CONTEXT_MANAGER_TEST_HARNESS_ROOT}/apps/cli/src/profile-boot.ts`).href)",
    "const { ctx } = await runProfile({ environment: loadLayeredEnv('dsh'), profile: 'telegram', patchFiles: [process.env.CONTEXT_MANAGER_TEST_OVERLAY], args: [] })",
    'const deadline = Date.now() + 5000',
    'for (;;) {',
    "  try { await readFile(process.env.CONTEXT_MANAGER_TEST_RECEIPT, 'utf8'); break } catch {}",
    "  if (Date.now() >= deadline) throw new Error('local Bot update did not finish through public profile')",
    '  await new Promise(resolve => setTimeout(resolve, 10))',
    '}',
    `const agent = ctx.agents.get('${canarySession}')`,
    "if (agent === undefined) throw new Error('Bot receipt arrived without the managed session')",
    "const texts = type => agent.session.events.filter(event => event.type === type).flatMap(event => type === 'user/message' ? event.data.content : event.data.message?.content ?? []).filter(block => block.type === 'text').map(block => block.text)",
    "const userSources = agent.session.events.filter(event => event.type === 'user/message').map(event => event.data.source)",
    "const directUserTexts = agent.session.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user').flatMap(event => event.data.content).filter(block => block.type === 'text').map(block => block.text)",
    "const profileDir = `${process.env.DSH_HOME}/profiles/telegram`",
    "const resolve = createRequire(`${profileDir}/package.json`).resolve",
    "await writeFile(process.env.CONTEXT_MANAGER_TEST_PROOF, JSON.stringify({ types: agent.session.events.map(event => event.type), userTexts: texts('user/message'), directUserTexts, userSources, assistantTexts: texts('assistant/message'), resolved: { root: resolve('@deepseek-ai/dsh-client-ui-context-compactor'), managed: resolve('@deepseek-ai/dsh-client-ui-context-compactor/managed-compaction'), gateway: resolve('@deepseek-ai/dsh-telegram-gateway') } }), { mode: 0o600 })",
    'await ctx.fiber.dispose()', "process.stdout.write('profile-run-complete\\n')", '',
  ].join('\n'))
  return runner
}

async function runChild(runner: string, home: string, overlay: string, origin: string, receipt: string, proof: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ['--expose-internals', '--import', 'tsx/esm', runner], {
      cwd: harnessRoot,
      env: { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', CONTEXT_MANAGER_TEST_BOT_ORIGIN: origin, CONTEXT_MANAGER_TEST_HARNESS_ROOT: harnessRoot, CONTEXT_MANAGER_TEST_OVERLAY: overlay, CONTEXT_MANAGER_TEST_RECEIPT: receipt, CONTEXT_MANAGER_TEST_PROOF: proof },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.push(child)
    let stdout = ''; let stderr = ''
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      const index = children.indexOf(child)
      if (index !== -1) children.splice(index, 1)
      if (error === undefined) resolve(stdout)
      else reject(error)
    }
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }, 10_000)
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    child.once('error', error => finish(error))
    child.once('exit', (code, signal) => timedOut
      ? finish(new Error('profile child timed out after 10 seconds'))
      : code === 0 && signal === null
      ? finish()
      : finish(new Error(`profile child failed (code=${String(code)}, signal=${String(signal)}): ${stderr}\nstdout:${stdout}`)))
  })
}

function entryBlock(dump: string, id: string): string {
  const lines = dump.split('\n')
  const start = lines.findIndex(line => line === `- id: ${id}`)
  if (start === -1) throw new Error(`profile dump is missing top-level entry ${id}`)
  const next = lines.findIndex((line, index) => index > start && line.startsWith('- id: '))
  return lines.slice(start, next === -1 ? lines.length : next).join('\n')
}

async function dumpCanaryProfile(home: string, overlay: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ['--expose-internals', '--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', 'telegram', '--patch', overlay, '--dump-config'], {
      cwd: harnessRoot,
      env: { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.push(child)
    let stdout = ''; let stderr = ''
    let settled = false
    let timedOut = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      const index = children.indexOf(child)
      if (index !== -1) children.splice(index, 1)
      error === undefined ? resolve(stdout) : reject(error)
    }
    const timeout = setTimeout(() => {
      timedOut = true
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }, 10_000)
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    child.once('error', error => finish(error))
    child.once('exit', (code, signal) => {
      timedOut
        ? finish(new Error('profile dump timed out after 10 seconds'))
        : code === 0 && signal === null
        ? finish()
        : finish(new Error(`profile dump failed (code=${String(code)}, signal=${String(signal)}): ${stderr}`))
    })
  })
}

describe('F02-T1N local Telegram profile canary', () => {
  it('runs two independent public profile cold starts through a local Bot and Loader-mounted mock LLM, preserving A and O < O-prime', async () => {
    const root = await mkdtemp(join(tmpdir(), 'context-manager-profile-e2e-'))
    roots.push(root)
    const credentials = join(root, 'dummy-credentials.yaml')
    const home = join(root, 'dsh-home')
    const moduleRoot = await materializeModuleRoot(root)
    await writeFile(credentials, 'version: 1\nrefs:\n  TELEGRAM_BOT_TOKEN: local-stub-token\n  TELEGRAM_ALLOWED_CHAT_ID: "42"\n', { mode: 0o600 })
    await chmod(credentials, 0o600)
    await prepareCanaryProfile(home, moduleRoot, credentials)
    expect((await stat(join(home, '.credentials.yaml'))).mode & 0o777).toBe(0o600)
    const bot = await startBotStub()
    const runner = await writeTestRuntime(root, home, bot.origin)
    const overlay = join(root, 'local-only-overlay.yml')
    const dump = await dumpCanaryProfile(home, overlay)
    const storage = entryBlock(dump, 'storage')
    const sqlite = entryBlock(dump, 'storage-sqlite')
    const domain = entryBlock(dump, 'storage-domain')
    const managed = entryBlock(dump, 'context-manager-managed-compaction')
    const ui = entryBlock(dump, 'ui-context-compactor')
    const gateway = entryBlock(dump, 'telegram-gateway')
    const basic = entryBlock(dump, 'compaction-basic')
    expect(storage).toContain("name: '@deepseek-ai/dsh-storage'")
    expect(sqlite).toContain("name: '@deepseek-ai/dsh-storage-sqlite'")
    expect(sqlite).toContain('context-manager-focus-canary.sqlite')
    expect(domain).toContain("name: '@deepseek-ai/dsh-storage-domain'")
    expect(domain).toContain('backend: sqlite')
    expect(managed).toContain("name: '@deepseek-ai/dsh-client-ui-context-compactor/managed-compaction'")
    expect(managed).toContain('mode: enforce')
    expect(ui).toContain("name: '@deepseek-ai/dsh-client-ui-context-compactor'")
    expect(ui).toMatch(/inject:\n\s+- storageDomain\n\s+- tokenMeter/)
    expect(gateway).toContain("name: '@deepseek-ai/dsh-telegram-gateway'")
    expect(gateway).toContain(`sessionId: ${canarySession}`)
    expect(basic).toContain('disabled: true')
    for (const forbidden of ['compactEveryTurns:', 'id: dsh-cron', 'id: dsh-assistant', 'id: dsh-x-feed']) {
      expect(dump).not.toContain(forbidden)
    }
    expect(ui).not.toContain('extensions:')
    expect(gateway).not.toContain('extensions:')

    bot.enqueue({ update_id: 41, message: { message_id: 1, chat: { id: 42, type: 'private' }, text: '帮我审这份方案' } })
    const firstReceipt = join(root, 'first.receipt')
    const firstProofPath = join(root, 'first.proof.json')
    bot.receipt(firstReceipt)
    await expect(runChild(runner, home, overlay, bot.origin, firstReceipt, firstProofPath)).resolves.toContain('profile-run-complete')
    const firstOffset = await readFile(join(home, 'storages', 'telegram', 'offset.txt'), 'utf8')
    const firstProof = JSON.parse(await readFile(firstProofPath, 'utf8')) as {
      types: string[]; userTexts: string[]; directUserTexts: string[]; userSources: Array<{ kind?: string }>; assistantTexts: string[]; resolved: Record<string, string>
    }
    const sessionFiles = await readdir(join(home, 'sessions'), { recursive: true })
    const sessionFile = sessionFiles.find(file => file.includes(canarySession) && file.endsWith('.jsonl.zstd'))
    expect(sessionFile).toBeDefined()
    const firstSessionSize = (await stat(join(home, 'sessions', sessionFile!))).size
    const secondPollStart = bot.requestedOffsets.length
    bot.enqueue({ update_id: 42, message: { message_id: 2, chat: { id: 42, type: 'private' }, text: '继续' } })
    const secondReceipt = join(root, 'second.receipt')
    const secondProofPath = join(root, 'second.proof.json')
    bot.receipt(secondReceipt)
    await expect(runChild(runner, home, overlay, bot.origin, secondReceipt, secondProofPath)).resolves.toContain('profile-run-complete')
    const secondOffset = await readFile(join(home, 'storages', 'telegram', 'offset.txt'), 'utf8')
    const secondProof = JSON.parse(await readFile(secondProofPath, 'utf8')) as typeof firstProof
    const secondSessionSize = (await stat(join(home, 'sessions', sessionFile!))).size

    expect(bot.sent.filter(text => text.includes('公开回复：帮我审这份方案'))).toHaveLength(2)
    expect(bot.requestedOffsets[0]).toBe(0)
    expect(bot.requestedOffsets[secondPollStart]).toBe(42)
    expect(Number(firstOffset)).toBe(42)
    expect(Number(secondOffset)).toBe(43)
    expect(Number(secondOffset)).toBeGreaterThan(Number(firstOffset))
    expect(secondSessionSize).toBeGreaterThan(firstSessionSize)
    expect(firstProof.directUserTexts).toContain('帮我审这份方案')
    expect(secondProof.directUserTexts).toContain('继续')
    expect(firstProof.assistantTexts).toContain('公开回复：帮我审这份方案')
    expect(secondProof.assistantTexts).toContain('公开回复：帮我审这份方案')
    expect(secondProof.types.some(type => type.startsWith('compaction/'))).toBe(false)
    expect(secondProof.userSources.some(source => source.kind === 'context-route')).toBe(false)
    expect(firstProof.resolved.root).toBe(join(projectRoot, 'ui-context-compactor', 'lib', 'index.js'))
    expect(firstProof.resolved.managed).toBe(join(projectRoot, 'ui-context-compactor', 'lib', 'managed-compaction.js'))
    expect(firstProof.resolved.gateway).toBe(join(projectRoot, 'telegram-gateway', 'lib', 'index.js'))
    expect(secondProof.resolved).toEqual(firstProof.resolved)
    const sidecarPath = join(home, 'storages', 'context-manager-focus-canary.sqlite')
    expect((await stat(sidecarPath)).isFile()).toBe(true)
    const sidecar = new DatabaseSync(sidecarPath, { readOnly: true })
    try {
      expect(sidecar.prepare('SELECT value FROM "u_context_manager_focus_precanonical" WHERE key = ?').get(canarySession)).toBeDefined()
    } finally {
      sidecar.close()
    }
  }, 30_000)
})
