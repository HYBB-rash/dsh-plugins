import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

export function devRuntimeIdentity(worktreeRoot) {
  const digest = createHash('sha256').update(resolve(worktreeRoot)).digest('hex')
  const id = digest.slice(0, 12)
  const prefix = `dsh-dev-${id}`
  const webPort = 20_000 + (Number.parseInt(digest.slice(12, 20), 16) % 30_000)

  return Object.freeze({
    id,
    network: `${prefix}-internal`,
    webPort,
    webUrl: `http://127.0.0.1:${webPort}`,
    containers: Object.freeze({
      web: `${prefix}-web`,
      telegram: `${prefix}-telegram`,
      fakeTelegram: `${prefix}-fake-telegram`,
    }),
  })
}
