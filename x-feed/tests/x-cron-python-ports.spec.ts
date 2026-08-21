import { describe, expect, it, vi } from 'vitest'
import {
  XFeedPythonPortError,
  createXFeedPythonPorts,
  type PythonCommandRequest,
  type PythonCommandResult,
  type XFeedRunCapabilities,
} from '../src/x-cron/python-ports.ts'

const capabilities: XFeedRunCapabilities = {
  runId: 'run-001',
  cronJobId: 'cron-x',
  dataDir: '/tmp/x-feed-run-001',
  packagePath: '/tmp/x-feed-run-001/x_insight_package.json',
  shownPath: '/tmp/x-feed-run-001/x_shown.json',
  collectionPath: '/tmp/x-feed-run-001/x_collections/run-001.jsonl',
  topicSearchOutputPath: '/tmp/x-feed-run-001/x_explore_items.jsonl',
  allowedTopics: ['agentic systems'],
  candidates: {
    'candidate-1': {
      id: 'candidate-1',
      url: 'https://x.com/alice/status/1',
      topics: ['agentic systems'],
    },
  },
  preparedUrls: ['https://x.com/alice/status/1'],
}

function makeRunner(stdout = '{"ok":true}\n'): {
  requests: PythonCommandRequest[]
  run: (request: PythonCommandRequest) => Promise<PythonCommandResult>
} {
  const requests: PythonCommandRequest[] = []
  return {
    requests,
    run: vi.fn(async (request: PythonCommandRequest) => {
      requests.push(request)
      return { stdout, stderr: '', exitCode: 0 }
    }),
  }
}

const packageJson = JSON.stringify({ ok: true, recent_items: [{ id: '1', url: 'https://x.com/alice/status/1', text: 'candidate' }] })

describe('X cron Python ports', () => {
  it('keeps construction definition-only with zero runner or artifact calls', () => {
    const runner = vi.fn(async () => ({ stdout: '{"ok":true}', stderr: '', exitCode: 0 }))
    const readFile = vi.fn(async () => '{}')
    createXFeedPythonPorts({
      pythonBin: '/usr/bin/python3',
      pythonDirectory: '/pkg/python',
      pipelinePath: '/pkg/python/x_insight_pipeline.py',
      topicSearchPath: '/pkg/python/x_topic_search.py',
      explorerPath: '/pkg/python/x_explorer.py',
      capabilities,
      run: runner,
      readFile,
    })
    expect(runner).not.toHaveBeenCalled()
    expect(readFile).not.toHaveBeenCalled()
  })

  it('builds only fixed mature-pipeline argv with shell disabled', async () => {
    const runner = makeRunner()
    const readFile = vi.fn(async () => packageJson)
    const ports = createXFeedPythonPorts({
      pythonBin: '/usr/bin/python3',
      pythonDirectory: '/pkg/python',
      pipelinePath: '/pkg/python/x_insight_pipeline.py',
      topicSearchPath: '/pkg/python/x_topic_search.py',
      explorerPath: '/pkg/python/x_explorer.py',
      capabilities,
      run: runner.run,
      readFile,
    })

    await expect(ports.runPipeline()).resolves.toEqual(JSON.parse(packageJson))
    expect(runner.requests).toHaveLength(1)
    expect(runner.requests[0]).toMatchObject({
      file: '/usr/bin/python3',
      cwd: '/pkg/python',
      shell: false,
      env: { DSH_X_FEED_DATA_DIR: capabilities.dataDir },
      args: [
        '/pkg/python/x_insight_pipeline.py',
        '--out', capabilities.packagePath,
        '--shown', capabilities.shownPath,
        '--batch-out', capabilities.collectionPath,
      ],
    })
    expect(runner.requests[0]!.env.DSH_X_FEED_DATA_DIR).toBe(capabilities.dataDir)
    expect(runner.requests[0]!.env.PATH).toBe(process.env.PATH)
    expect(runner.requests[0]!.env.HOME).toBe(process.env.HOME)
    expect(runner.requests[0]!.args).not.toContain('mark-shown')
    expect(readFile).toHaveBeenCalledWith(capabilities.packagePath, expect.anything())
  })

  it('allows search and exploration only through current capability state', async () => {
    const runner = makeRunner()
    const ports = createXFeedPythonPorts({
      pythonBin: '/usr/bin/python3',
      pythonDirectory: '/pkg/python',
      pipelinePath: '/pkg/python/x_insight_pipeline.py',
      topicSearchPath: '/pkg/python/x_topic_search.py',
      explorerPath: '/pkg/python/x_explorer.py',
      capabilities,
      run: runner.run,
      readFile: async () => '{"ok":true}\n',
    })

    await ports.searchTopic('agentic systems')
    await ports.exploreCandidate('candidate-1')
    expect(runner.requests[0]!.args).toEqual([
      '/pkg/python/x_topic_search.py', 'agentic systems', '--rolls', '3', '--live', '--out', capabilities.topicSearchOutputPath,
    ])
    expect(runner.requests[1]!.args).toEqual([
      '/pkg/python/x_explorer.py', '--url', 'https://x.com/alice/status/1', '--name', 'candidate-1',
    ])
    await expect(ports.searchTopic('invented topic')).rejects.toMatchObject({ code: 'capability-denied' })
    await expect(ports.exploreCandidate('candidate-unknown')).rejects.toMatchObject({ code: 'capability-denied' })
  })

  it('prepares an artifact only and never exposes mark-shown or receipt commands', async () => {
    const runner = makeRunner('{"ok":true,"prepared":1}\n')
    const ports = createXFeedPythonPorts({
      pythonBin: '/usr/bin/python3',
      pythonDirectory: '/pkg/python',
      pipelinePath: '/pkg/python/x_insight_pipeline.py',
      topicSearchPath: '/pkg/python/x_topic_search.py',
      explorerPath: '/pkg/python/x_explorer.py',
      capabilities,
      run: runner.run,
    })

    const deliveryText = [
      '📦 X 洞察', '', '⭐ 高优先级',
      '- 采用内容 (https://x.com/alice/status/1)',
    ].join('\n')
    await ports.prepareDelivery(deliveryText, ['https://x.com/alice/status/1'])
    expect(runner.requests[0]!.args).toEqual([
      '/pkg/python/x_insight_pipeline.py', 'prepare-delivery',
      '--package', capabilities.packagePath,
      '--cron-job-id', 'cron-x',
      '--urls', 'https://x.com/alice/status/1',
    ])
    expect(runner.requests[0]!.args).not.toEqual(expect.arrayContaining(['mark-shown', 'confirm-prepared', 'mark-delivered']))
    await expect(ports.prepareDelivery(deliveryText, ['https://x.com/not-current/status/2']))
      .rejects.toMatchObject({ code: 'capability-denied' })
  })

  it('reads only fixed bounded JSONL/TXT artifacts and extends delivery allowlist from status URLs', async () => {
    const runner = makeRunner('{"ok":true,"new":1}\n')
    const readFile = vi.fn(async (path: string) => path.endsWith('.jsonl')
      ? JSON.stringify({ id: '2', url: 'https://twitter.com/bob/status/2', text: 'found' }) + '\n'
      : 'URL: https://x.com/alice/status/1\nTITLE: Explored\n\nBody\n\nLINKS: {"tweet":"https://x.com/bob/status/2"}')
    const ports = createXFeedPythonPorts({
      pythonBin: '/usr/bin/python3',
      pythonDirectory: '/pkg/python',
      pipelinePath: '/pkg/python/x_insight_pipeline.py',
      topicSearchPath: '/pkg/python/x_topic_search.py',
      explorerPath: '/pkg/python/x_explorer.py',
      capabilities,
      run: runner.run,
      readFile,
    })
    const search = await ports.searchTopic('agentic systems')
    expect(search).toMatchObject({ items: [{ url: 'https://x.com/bob/status/2', text: 'found' }] })
    const explored = await ports.exploreCandidate('candidate-1')
    expect(explored).toMatchObject({ title: 'Explored', body: 'Body', urls: ['https://x.com/alice/status/1', 'https://x.com/bob/status/2'] })
    const deliveryText = [
      '📦 X 洞察', '', '⭐ 高优先级',
      '- 采用内容 (https://x.com/bob/status/2)',
    ].join('\n')
    await expect(ports.prepareDelivery(deliveryText, ['https://x.com/bob/status/2'])).resolves.toMatchObject({ ok: true })
    expect(readFile).toHaveBeenCalledWith(capabilities.topicSearchOutputPath, expect.anything())
    expect(readFile).toHaveBeenCalledWith('/tmp/x-feed-run-001/x_explore/candidate-1.txt', expect.anything())
  })

  it('fails closed for timeout, abort, non-zero, invalid JSON and oversized stdout', async () => {
    const makePorts = (run: (request: PythonCommandRequest) => Promise<PythonCommandResult>) => createXFeedPythonPorts({
      pythonBin: '/usr/bin/python3',
      pythonDirectory: '/pkg/python',
      pipelinePath: '/pkg/python/x_insight_pipeline.py',
      topicSearchPath: '/pkg/python/x_topic_search.py',
      explorerPath: '/pkg/python/x_explorer.py',
      capabilities,
      run,
      maxStdoutBytes: 32,
    })
    await expect(makePorts(async () => { throw new XFeedPythonPortError('timeout', 'timed out') }).runPipeline())
      .rejects.toMatchObject({ code: 'timeout' })
    await expect(makePorts(async () => { throw new XFeedPythonPortError('aborted', 'aborted') }).runPipeline())
      .rejects.toMatchObject({ code: 'aborted' })
    await expect(makePorts(async () => ({ stdout: '{"ok":false}', stderr: '', exitCode: 2 })).runPipeline())
      .rejects.toMatchObject({ code: 'non-zero-exit' })
    await expect(makePorts(async () => ({ stdout: 'not-json', stderr: '', exitCode: 0 })).runPipeline())
      .rejects.toMatchObject({ code: 'invalid-json' })
    await expect(makePorts(async () => ({ stdout: 'x'.repeat(100), stderr: '', exitCode: 0 })).runPipeline())
      .rejects.toMatchObject({ code: 'oversized-stdout' })
  })
})
