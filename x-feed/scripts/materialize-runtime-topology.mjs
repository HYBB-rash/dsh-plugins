#!/usr/bin/env node

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const topologyPath = resolve(scriptDirectory, '../runtime-package-topology.json')

function fail(message) {
  throw new Error(`x-feed runtime topology: ${message}`)
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    fail(`cannot read ${label} at ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function assertReleaseDirectory(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)) {
    fail(`${label} must be one safe release directory segment`)
  }
  return value
}

function assertPackageName(value, label) {
  if (typeof value !== 'string' || !/^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/iu.test(value)) {
    fail(`${label} must be one scoped package name`)
  }
  return value
}

function pathInside(root, path, label) {
  const offset = relative(root, path)
  if (offset === '' || (!isAbsolute(offset) && offset !== '..' && !offset.startsWith(`..${sep}`))) return path
  fail(`${label} escaped the release plugins root`)
}

function readPackage(directory, expectedName, label) {
  const packagePath = join(directory, 'package.json')
  if (!existsSync(packagePath)) fail(`missing ${label} package ${expectedName}`)
  const manifest = readJson(packagePath, `${label} package manifest`)
  if (manifest.name !== expectedName) {
    fail(`${label} directory declares ${String(manifest.name)} instead of ${expectedName}`)
  }
  return manifest
}

function loadTopology(releasePlugins) {
  const topology = readJson(topologyPath, 'runtime topology manifest')
  if (topology.schemaVersion !== 1) fail('schemaVersion must be 1')

  const consumerName = assertPackageName(topology.consumerPackage?.name, 'consumer package name')
  const consumerReleaseDirectory = assertReleaseDirectory(
    topology.consumerPackage?.releaseDirectory,
    'consumer releaseDirectory',
  )
  const peerName = assertPackageName(topology.runtimePeer?.name, 'runtime peer name')
  const peerReleaseDirectory = assertReleaseDirectory(
    topology.runtimePeer?.releaseDirectory,
    'runtime peer releaseDirectory',
  )

  const consumerDirectory = pathInside(
    releasePlugins,
    resolve(releasePlugins, consumerReleaseDirectory),
    'consumer package path',
  )
  const peerDirectory = pathInside(
    releasePlugins,
    resolve(releasePlugins, peerReleaseDirectory),
    'runtime package path',
  )
  const runtimeLink = pathInside(releasePlugins, resolve(releasePlugins, 'node_modules', peerName), 'runtime link')

  const consumerManifest = readPackage(consumerDirectory, consumerName, 'consumer')
  if (consumerManifest.peerDependencies?.[peerName] === undefined) {
    fail(`${consumerName} does not declare runtime peer ${peerName}`)
  }
  const peerManifest = readPackage(peerDirectory, peerName, 'runtime')
  if (typeof peerManifest.main !== 'string' || peerManifest.main.length === 0) {
    fail(`runtime package ${peerName} has no main entry`)
  }
  const peerEntry = pathInside(peerDirectory, resolve(peerDirectory, peerManifest.main), 'runtime package main')
  if (!existsSync(peerEntry)) fail(`runtime package ${peerName} is missing main entry ${peerManifest.main}`)

  return { peerDirectory, peerName, runtimeLink }
}

function inspectPath(path) {
  try {
    return lstatSync(path)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
}

function checkRuntimeLink({ peerDirectory, peerName, runtimeLink }) {
  const runtimePath = inspectPath(runtimeLink)
  if (runtimePath === undefined) fail(`missing runtime link ${peerName}`)
  if (!runtimePath.isSymbolicLink()) fail(`conflicting runtime path ${peerName}`)

  const expectedTarget = relative(dirname(runtimeLink), peerDirectory)
  if (readlinkSync(runtimeLink) !== expectedTarget || realpathSync(runtimeLink) !== realpathSync(peerDirectory)) {
    fail(`conflicting runtime link ${peerName}`)
  }
}

function materializeRuntimeLink(topology) {
  if (inspectPath(topology.runtimeLink) !== undefined) {
    checkRuntimeLink(topology)
    return
  }
  mkdirSync(dirname(topology.runtimeLink), { recursive: true })
  symlinkSync(relative(dirname(topology.runtimeLink), topology.peerDirectory), topology.runtimeLink, 'dir')
  checkRuntimeLink(topology)
}

function main() {
  const [mode, releasePluginsInput] = process.argv.slice(2)
  if (!['--check', '--materialize'].includes(mode) || releasePluginsInput === undefined) {
    fail('usage: materialize-runtime-topology.mjs <--check|--materialize> <release-plugins-directory>')
  }
  const releasePlugins = resolve(releasePluginsInput)
  const topology = loadTopology(releasePlugins)
  if (mode === '--materialize') materializeRuntimeLink(topology)
  else checkRuntimeLink(topology)
  process.stdout.write(`${mode === '--materialize' ? 'materialized' : 'checked'} 1 runtime link\n`)
}

try {
  main()
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
