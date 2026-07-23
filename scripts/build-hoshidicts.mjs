import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'

const projectRoot = resolve(import.meta.dirname, '..')
const sourceDir = join(projectRoot, 'native', 'hoshidicts-sidecar')
const hoshidictsDir = join(projectRoot, 'vendor', 'hoshidicts')
const platformArch = `${process.platform}-${process.arch}`
const buildDir = join(projectRoot, '.sidecar-build', `wrapper-${platformArch}`)
const executableName = `hoshidicts-sidecar${process.platform === 'win32' ? '.exe' : ''}`
const outputDir = join(projectRoot, 'resources', 'sidecars')
const outputPath = join(outputDir, executableName)
const buildEnvironment = {
  ...process.env,
  CCACHE_DIR: process.env.CCACHE_DIR ?? join(projectRoot, '.sidecar-build', 'ccache'),
  CCACHE_TEMPDIR: process.env.CCACHE_TEMPDIR ?? join(projectRoot, '.sidecar-build', 'ccache-tmp')
}

if (!existsSync(join(hoshidictsDir, 'CMakeLists.txt'))) {
  throw new Error('Hoshidicts submodule is missing. Run: git submodule update --init --recursive')
}
if (!existsSync(join(hoshidictsDir, 'external', 'glaze', 'CMakeLists.txt'))) {
  throw new Error('Hoshidicts dependencies are missing. Run: git submodule update --init --recursive')
}

const configureArgs = [
  '-S', sourceDir,
  '-B', buildDir,
  '-DCMAKE_BUILD_TYPE=Release',
  '-DBUILD_TESTING=OFF'
]

if (process.platform === 'darwin') {
  configureArgs.push('-DCMAKE_OSX_ARCHITECTURES=x86_64;arm64')
}

run('cmake', configureArgs)
run('cmake', ['--build', buildDir, '--config', 'Release', '--target', 'hoshidicts-sidecar', '--parallel'])

const candidates = [
  join(buildDir, executableName),
  join(buildDir, 'Release', executableName),
  join(buildDir, 'bin', executableName),
  join(buildDir, 'bin', 'Release', executableName)
]
const builtPath = candidates.find(existsSync)
if (!builtPath) {
  throw new Error(`CMake completed but ${executableName} was not found in the Hoshidicts build directory`)
}

mkdirSync(outputDir, { recursive: true })
const temporaryOutputPath = `${outputPath}.new`
copyFileSync(builtPath, temporaryOutputPath)
if (process.platform !== 'win32') chmodSync(temporaryOutputPath, 0o755)
renameSync(temporaryOutputPath, outputPath)
console.log(`Packaged Hoshidicts sidecar: ${outputPath}`)

/**
 * @param {string} command
 * @param {string[]} args
 */
function run (command, args) {
  const result = spawnSync(command, args, { cwd: projectRoot, env: buildEnvironment, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
