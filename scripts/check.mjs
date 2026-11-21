import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const problems = []
const passed = []

function ok(message) {
  passed.push(message)
}

function fail(message) {
  problems.push(message)
}

function jsFilesIn(dir) {
  const files = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...jsFilesIn(full))
    else if (/\.(?:mjs|js)$/i.test(entry.name)) files.push(full)
  }
  return files
}

const pkgPath = join(root, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))

if (pkg.name === 'dsh-free-games-claimer') ok('package name')
else fail(`package name is ${JSON.stringify(pkg.name)}, expected "dsh-free-games-claimer"`)

if (/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version)) ok(`package version ${pkg.version}`)
else fail(`package version is not semver: ${JSON.stringify(pkg.version)}`)

if (pkg.private === true) ok('package is private (not published to npm)')
else fail('package.json must stay "private": true; this is a DSH bundle, not an npm package')

if (pkg.type === 'module') ok('ESM package')
else fail('package.json must set "type": "module"')

for (const [key, value] of Object.entries({
  main: 'index.js',
  './client': './client.js',
  './package.json': './package.json',
})) {
  const actual = key === 'main' ? pkg.main : pkg.exports?.[key]
  if (actual === value) ok(`exports ${key}`)
  else fail(`exports ${key} is ${JSON.stringify(actual)}, expected ${JSON.stringify(value)}`)
}

for (const file of ['index.js', 'client.js', 'lib', 'cordis.patch.yml', 'README.md', 'LICENSE']) {
  if (Array.isArray(pkg.files) && pkg.files.includes(file)) ok(`files includes ${file}`)
  else fail(`package.json "files" must include ${JSON.stringify(file)}`)
}

if (pkg.dsh?.bundle?.patch === './cordis.patch.yml') ok('dsh bundle patch')
else fail('package.json "dsh.bundle.patch" must be "./cordis.patch.yml"')

if (pkg.dsh?.client?.platform === 'web') ok('dsh web client')
else fail('package.json "dsh.client.platform" must be "web"')

if (Array.isArray(pkg.dsh?.client?.inject) && pkg.dsh.client.inject.length > 0) ok('dsh client inject')
else fail('package.json "dsh.client.inject" must be a non-empty array')

if (pkg.dependencies?.['playwright-core']) ok('playwright-core dependency')
else fail('package.json must declare playwright-core')

if (existsSync(join(root, 'package-lock.json'))) ok('package-lock.json')
else fail('package-lock.json is missing')

const patchPath = join(root, 'cordis.patch.yml')
if (existsSync(patchPath)) {
  const patch = readFileSync(patchPath, 'utf8')
  if (/^\s*-\s*id:\s*free-games-claimer\s*$/m.test(patch) && patch.includes('name: dsh-free-games-claimer')) {
    ok('cordis patch id and module name')
  } else {
    fail('cordis.patch.yml must insert id: free-games-claimer and name: dsh-free-games-claimer')
  }
} else {
  fail('cordis.patch.yml is missing')
}

const jsFiles = [
  join(root, 'index.js'),
  join(root, 'client.js'),
  ...jsFilesIn(join(root, 'lib')),
  ...jsFilesIn(join(root, 'scripts')),
]

for (const file of jsFiles) {
  const rel = relative(root, file)
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
    ok(`syntax ${rel}`)
  } catch (error) {
    const detail = String(error.stderr || error.stdout || error.message).trim().split('\n')[0]
    fail(`syntax ${rel}: ${detail}`)
  }
}

for (const message of passed) console.log(`✓ ${message}`)

if (problems.length > 0) {
  console.error('\n检查失败：')
  for (const message of problems) console.error(`✗ ${message}`)
  process.exit(1)
}

console.log(`\n全部通过（${jsFiles.length} 个 JS 文件，v${pkg.version}）`)