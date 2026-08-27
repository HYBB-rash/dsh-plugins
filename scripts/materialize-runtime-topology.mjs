#!/usr/bin/env node

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
} from 'node:fs'
import { createRequire, isBuiltin } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const topologyPath = resolve(scriptDirectory, '../runtime-package-topology.json')

function fail(message) {
  throw new Error(`release runtime topology: ${message}`)
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    fail(`cannot read ${label} at ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function assertPackageName(value, label) {
  const scopedPackageName = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/u
  const unscopedPackageName = /^[a-z0-9][a-z0-9._-]*$/u
  const reservedUnscopedNames = new Set(['node_modules', 'favicon.ico'])
  if (typeof value !== 'string'
    || value.length > 214
    || (!scopedPackageName.test(value)
      && (!unscopedPackageName.test(value) || reservedUnscopedNames.has(value)))) {
    fail(`${label} must be one npm package name`)
  }
  return value
}

function assertReleaseDirectory(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)) {
    fail(`${label} must be one safe release directory segment`)
  }
  return value
}

function pathInside(root, path, label) {
  const offset = relative(root, path)
  if (offset === '' || (!isAbsolute(offset) && offset !== '..' && !offset.startsWith(`..${sep}`))) return path
  fail(`${label} escaped ${root}`)
}

function inspectPath(path) {
  try {
    return lstatSync(path)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
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

function filesUnder(directory) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...filesUnder(path))
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(path)
  }
  return files.sort()
}

function runtimePackageName(specifier) {
  if (specifier.startsWith('@')) return specifier.split('/').slice(0, 2).join('/')
  return specifier.split('/')[0]
}

function runtimeSpecifiers(source) {
  const specifiers = []
  const staticPattern = /\b(?:import|export)\s+(?:[^"'()]*?\s+from\s*)?["']([^"']+)["']/gu
  const callPattern = /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/gu
  for (const pattern of [staticPattern, callPattern]) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1])
  }
  return specifiers.filter(specifier => (
    !specifier.startsWith('.')
    && !specifier.startsWith('/')
    && !specifier.startsWith('#')
    && !specifier.startsWith('node:')
    && !isBuiltin(specifier)
  ))
}

function discoverConsumers(releasePlugins) {
  const consumers = []
  for (const entry of readdirSync(releasePlugins, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'node_modules') continue
    const directory = pathInside(releasePlugins, resolve(releasePlugins, entry.name), 'consumer path')
    const packagePath = join(directory, 'package.json')
    const libraryDirectory = join(directory, 'lib')
    if (!existsSync(packagePath) || !existsSync(libraryDirectory)) continue
    const manifest = readJson(packagePath, `consumer package manifest ${entry.name}`)
    const name = assertPackageName(manifest.name, `consumer package name for ${entry.name}`)
    consumers.push({ directory, manifest, name })
  }
  consumers.sort((left, right) => left.name.localeCompare(right.name))
  return consumers
}

function scanRuntimeImports(consumers) {
  const imports = []
  for (const consumer of consumers) {
    const seen = new Set()
    for (const path of filesUnder(join(consumer.directory, 'lib'))) {
      for (const specifier of runtimeSpecifiers(readFileSync(path, 'utf8'))) seen.add(specifier)
    }
    for (const specifier of [...seen].sort()) {
      imports.push({ consumer, packageName: runtimePackageName(specifier), specifier })
    }
  }
  return imports
}

function declaresDependency(manifest, packageName) {
  return ['dependencies', 'optionalDependencies', 'peerDependencies'].some(
    field => manifest[field]?.[packageName] !== undefined,
  )
}

function requiredConsumers(value, targetName, consumersByName) {
  const declaredConsumers = value?.requiredBy
  if (!Array.isArray(declaredConsumers) || declaredConsumers.length === 0) {
    fail(`target ${targetName} requiredBy must be a non-empty array`)
  }
  const requiredBy = declaredConsumers.map((consumer, index) => (
    assertPackageName(consumer, `target ${targetName} requiredBy[${index}]`)
  ))
  if (new Set(requiredBy).size !== requiredBy.length) {
    fail(`target ${targetName} has duplicate requiredBy entries`)
  }
  for (const consumerName of requiredBy) {
    const consumer = consumersByName.get(consumerName)
    if (consumer === undefined) fail(`target ${targetName} names missing consumer ${consumerName}`)
    if (!declaresDependency(consumer.manifest, targetName)) {
      fail(`${consumerName} does not declare runtime dependency ${targetName}`)
    }
  }
  return requiredBy
}

function runtimeTargetDirectory(value, targetName, releasePlugins, harnessPackages) {
  if (value?.kind === 'harness') {
    return pathInside(harnessPackages, resolve(harnessPackages, targetName), `target ${targetName} Harness path`)
  }
  if (value?.kind !== 'release') fail(`target ${targetName} has invalid kind ${String(value?.kind)}`)
  const releaseDirectory = assertReleaseDirectory(
    value.releaseDirectory,
    `target ${targetName} releaseDirectory`,
  )
  return pathInside(
    releasePlugins,
    resolve(releasePlugins, releaseDirectory),
    `target ${targetName} release path`,
  )
}

function loadRuntimeTarget(value, index, roots, consumersByName) {
  const name = assertPackageName(value?.name, `targets[${index}].name`)
  const requiredBy = requiredConsumers(value, name, consumersByName)
  const targetDirectory = runtimeTargetDirectory(value, name, roots.releasePlugins, roots.harnessPackages)
  const targetManifest = readPackage(targetDirectory, name, `${value.kind} runtime`)
  if (typeof targetManifest.main !== 'string' || targetManifest.main.length === 0) {
    fail(`runtime package ${name} has no main entry`)
  }
  const mainEntry = pathInside(targetDirectory, resolve(targetDirectory, targetManifest.main), `target ${name} main`)
  if (!existsSync(mainEntry)) fail(`runtime package ${name} is missing main entry ${targetManifest.main}`)
  const runtimeLink = pathInside(
    roots.releasePlugins,
    resolve(roots.releasePlugins, 'node_modules', name),
    `target ${name} runtime link`,
  )
  return { name, requiredBy, runtimeLink, targetDirectory }
}

function loadTopology(release) {
  const releasePlugins = pathInside(release, resolve(release, 'plugins'), 'release plugins path')
  const harnessPackages = pathInside(
    release,
    resolve(release, 'harness/node_modules/.pnpm/node_modules'),
    'Harness packages path',
  )
  const topology = readJson(topologyPath, 'runtime topology manifest')
  if (topology.schemaVersion !== 1) fail('schemaVersion must be 1')
  if (!Array.isArray(topology.targets) || topology.targets.length === 0) fail('targets must be a non-empty array')

  const consumers = discoverConsumers(releasePlugins)
  const consumersByName = new Map(consumers.map(consumer => [consumer.name, consumer]))
  const roots = { harnessPackages, releasePlugins }
  const targets = topology.targets.map((value, index) => (
    loadRuntimeTarget(value, index, roots, consumersByName)
  ))
  const targetNames = new Set()
  for (const target of targets) {
    if (targetNames.has(target.name)) fail(`duplicate runtime target ${target.name}`)
    targetNames.add(target.name)
  }

  const targetsByName = new Map(targets.map(target => [target.name, target]))
  const imports = scanRuntimeImports(consumers)
  for (const runtimeImport of imports) {
    const target = targetsByName.get(runtimeImport.packageName)
    if (target === undefined) {
      fail(`undeclared runtime import ${runtimeImport.specifier} from ${runtimeImport.consumer.name}`)
    }
    if (!target.requiredBy.includes(runtimeImport.consumer.name)) {
      fail(`runtime import ${runtimeImport.specifier} is not declared for ${runtimeImport.consumer.name}`)
    }
  }

  return { consumers, imports, targets }
}

function runtimeLinkProblem(target) {
  const runtimePath = inspectPath(target.runtimeLink)
  if (runtimePath === undefined) return `missing runtime link ${target.name}`
  if (!runtimePath.isSymbolicLink()) return `conflicting runtime path ${target.name}`
  const expectedTarget = relative(dirname(target.runtimeLink), target.targetDirectory)
  if (readlinkSync(target.runtimeLink) !== expectedTarget) return `conflicting runtime link ${target.name}`
  try {
    if (realpathSync(target.runtimeLink) !== realpathSync(target.targetDirectory)) {
      return `conflicting runtime link ${target.name}`
    }
  } catch {
    return `conflicting runtime link ${target.name}`
  }
  return undefined
}

function rejectConflicts(targets) {
  const conflict = targets.map(runtimeLinkProblem).find(problem => problem?.startsWith('conflicting'))
  if (conflict !== undefined) fail(conflict)
}

function materializeRuntimeLinks(targets) {
  rejectConflicts(targets)
  for (const target of targets) {
    if (inspectPath(target.runtimeLink) !== undefined) continue
    mkdirSync(dirname(target.runtimeLink), { recursive: true })
    symlinkSync(relative(dirname(target.runtimeLink), target.targetDirectory), target.runtimeLink, 'dir')
  }
}

function checkRuntimeLinks(targets) {
  const problems = targets.map(runtimeLinkProblem).filter(problem => problem !== undefined)
  if (problems.length > 0) fail(problems.join('\n'))
}

function verifyResolution(topology) {
  const targetsByName = new Map(topology.targets.map(target => [target.name, target]))
  const consumersByName = new Map(topology.consumers.map(consumer => [consumer.name, consumer]))
  const assertResolvedInsideTarget = (consumer, specifier, target) => {
    let resolved
    try {
      resolved = createRequire(join(consumer.directory, 'package.json')).resolve(specifier)
    } catch (error) {
      fail(`${consumer.name} cannot resolve ${specifier}: ${error instanceof Error ? error.message : String(error)}`)
    }
    pathInside(realpathSync(target.targetDirectory), realpathSync(resolved), `${consumer.name} resolution for ${specifier}`)
  }

  for (const target of topology.targets) {
    for (const consumerName of target.requiredBy) {
      const consumer = consumersByName.get(consumerName)
      if (consumer === undefined) fail(`cannot verify missing consumer ${consumerName}`)
      assertResolvedInsideTarget(consumer, target.name, target)
    }
  }
  for (const runtimeImport of topology.imports) {
    assertResolvedInsideTarget(
      runtimeImport.consumer,
      runtimeImport.specifier,
      targetsByName.get(runtimeImport.packageName),
    )
  }
}

function main() {
  const [mode, releaseInput] = process.argv.slice(2)
  if (!['--check', '--materialize'].includes(mode) || releaseInput === undefined) {
    fail('usage: materialize-runtime-topology.mjs <--check|--materialize> <release-directory>')
  }
  const release = resolve(releaseInput)
  const topology = loadTopology(release)
  if (mode === '--materialize') materializeRuntimeLinks(topology.targets)
  checkRuntimeLinks(topology.targets)
  verifyResolution(topology)
  process.stdout.write(
    `${mode === '--materialize' ? 'materialized' : 'checked'} ${topology.targets.length} runtime links; `
    + `checked ${topology.imports.length} imports\n`,
  )
}

try {
  main()
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
