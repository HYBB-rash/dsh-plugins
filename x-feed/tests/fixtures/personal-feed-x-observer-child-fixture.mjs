import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'

const input = await new Promise((resolve) => {
  let text = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => { text += chunk })
  process.stdin.on('end', () => resolve(text))
})

let deadlineEpochMs
try {
  const decoded = JSON.parse(input)
  deadlineEpochMs = decoded?.deadlineEpochMs
} catch {
  process.exitCode = 2
}

if (!Number.isSafeInteger(deadlineEpochMs)) process.exitCode = 2

const iso = (offset) => new Date(deadlineEpochMs + offset).toISOString()
const complete = JSON.stringify({
  schemaVersion: 1,
  kind: 'complete',
  startedAt: iso(-90),
  completedAt: iso(-10),
  surfaces: [
    {
      kind: 'natural_zero',
      surface: 'for_you',
      surfaceOrdinal: 0,
      startedAt: iso(-80),
      completedAt: iso(-70),
      occurrences: [],
    },
    {
      kind: 'natural_zero',
      surface: 'following',
      surfaceOrdinal: 1,
      startedAt: iso(-60),
      completedAt: iso(-50),
      occurrences: [],
    },
    {
      kind: 'natural_zero',
      surface: 'explore',
      surfaceOrdinal: 2,
      startedAt: iso(-40),
      completedAt: iso(-30),
      occurrences: [],
    },
  ],
})

const mode = deadlineEpochMs % 10
if (mode === 0) {
  process.stdout.write(`${complete}\n`, () => process.exit(0))
} else if (mode === 1) {
  process.stderr.write('READY\n')
  const keepAlive = setInterval(() => {}, 1_000)
  process.once('SIGTERM', () => {
    clearInterval(keepAlive)
    process.exit(0)
  })
} else if (mode === 2) {
  process.stderr.write('READY\n')
  const keepAlive = setInterval(() => {}, 1_000)
  process.on('SIGTERM', () => { keepAlive.refresh() })
} else if (mode === 3) {
  const marker = `${tmpdir()}/personal-feed-x-observer-child-holder-${deadlineEpochMs}.release`
  const holderSource = [
    "import { existsSync, unlinkSync } from 'node:fs'",
    'const marker = process.argv[1]',
    'const finish = () => { try { if (existsSync(marker)) unlinkSync(marker) } catch {} process.exit(0) }',
    'const poll = setInterval(() => { if (existsSync(marker)) finish() }, 20)',
    'setTimeout(() => { clearInterval(poll); finish() }, 5000)',
  ].join(';')
  process.stdout.write(`${complete}\n`, () => {
    spawn(process.execPath, ['--input-type=module', '-e', holderSource, marker], {
      stdio: ['ignore', 'inherit', 'inherit'],
    })
    process.exit(0)
  })
} else {
  process.exit(3)
}
