// A separate executable identity for development VPN rules. Never alter the
// installed app or the Electron executable that launches the development UI.
import { execFileSync } from 'node:child_process'
import { cp, copyFile, mkdir, readFile, writeFile, stat, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { flipFuses, FuseVersion, FuseV1Options } from '@electron/fuses'

const require = createRequire(import.meta.url)
const executable = require('electron')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.sidecar-build', 'torrent-runtime')
const name = 'Hayatan Torrent Dev'
const target = process.platform === 'darwin' ? join(root, `${name}.app`) : join(root, `${name}.exe`)
const binary = process.platform === 'darwin' ? join(target, 'Contents', 'MacOS', name) : target

if (process.platform !== 'darwin' && process.platform !== 'win32') {
  console.log('Dedicated torrent runtime is available on macOS and Windows; development uses the utility process on this platform.')
} else {
  const sourceStat = await stat(executable)
  const signature = JSON.stringify({ schema: 1, electron: require('electron/package.json').version, platform: process.platform, arch: process.arch, executable, mtime: sourceStat.mtimeMs })
  let ready = false
  try { ready = await readFile(join(root, 'runtime.json'), 'utf8') === signature && (await stat(binary)).isFile() } catch { /* Prepare a fresh runtime. */ }
  if (!ready) {
    // Only this generated directory belongs to the preparation script.
    await rm(root, { recursive: true, force: true })
    await mkdir(root, { recursive: true })
    if (process.platform === 'darwin') {
      const sourceContents = resolve(dirname(executable), '..')
      const contents = join(target, 'Contents')
      await mkdir(join(contents, 'MacOS'), { recursive: true })
      await mkdir(join(contents, 'Resources'), { recursive: true })
      await copyFile(executable, binary)
      await cp(join(sourceContents, 'Frameworks'), join(contents, 'Frameworks'), { recursive: true, verbatimSymlinks: true })
      const plist = (await readFile(join(sourceContents, 'Info.plist'), 'utf8'))
        .replace(/(<key>CFBundleExecutable<\/key>\s*<string>)[^<]*/, `$1${name}`)
        .replace(/(<key>CFBundleIdentifier<\/key>\s*<string>)[^<]*/, '$1com.github.berlinpcs.hayatan.torrent.dev')
        .replace(/(<key>CFBundleName<\/key>\s*<string>)[^<]*/, `$1${name}`)
        .replace(/(<key>CFBundleDisplayName<\/key>\s*<string>)[^<]*/, `$1${name}`)
        .replace(/<\/dict>\s*<\/plist>\s*$/, '<key>LSUIElement</key><true/>\n</dict>\n</plist>')
      await writeFile(join(contents, 'Info.plist'), plist)
    } else {
      // The Windows executable also requires the matching DLLs and data files.
      await cp(dirname(executable), root, { recursive: true })
      await copyFile(executable, binary)
    }
    await flipFuses(target, {
      version: FuseVersion.V1,
      resetAdHocDarwinSignature: process.platform === 'darwin',
      [FuseV1Options.RunAsNode]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false
    })
    if (process.platform === 'darwin') execFileSync('codesign', ['--force', '--deep', '--sign', '-', target], { stdio: 'pipe' })
    await writeFile(join(root, 'runtime.json'), signature)
  }
  console.log(`Development torrent runtime ready: ${binary}`)
}
