import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, copyFile, mkdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const [downloadArgument, platformKey, outputArgument] = process.argv.slice(2)

if (!downloadArgument || !/^(linux|win32)-x64$/.test(platformKey ?? '')) {
  throw new Error(
    'Usage: node scripts/install-ffmpeg-release.mjs <download-directory> <linux-x64|win32-x64> [output-directory]'
  )
}

const downloadDirectory = resolve(downloadArgument)
const outputDirectory = outputArgument
  ? resolve(outputArgument)
  : join(projectRoot, 'native', 'ffmpeg-build', 'dist', platformKey)
const executableSuffix = platformKey === 'win32-x64' ? '.exe' : ''
const releaseFiles = new Map([
  [`ffmpeg-${platformKey}${executableSuffix}`, `ffmpeg${executableSuffix}`],
  [`FFMPEG-LICENSE-${platformKey}.txt`, 'FFMPEG-LICENSE.txt'],
  [`FFMPEG-SOURCES-${platformKey}.txt`, 'FFMPEG-SOURCES.txt'],
  [`FFMPEG-THIRD-PARTY-LICENSES-${platformKey}.txt`, 'FFMPEG-THIRD-PARTY-LICENSES.txt']
])

const checksums = parseChecksums(
  await readFile(join(downloadDirectory, 'SHA256SUMS'), 'utf8')
)

await mkdir(outputDirectory, { recursive: true })

for (const [releaseName, outputName] of releaseFiles) {
  const expectedChecksum = checksums.get(releaseName)
  if (!expectedChecksum) {
    throw new Error(`FFmpeg release checksum manifest is missing ${releaseName}.`)
  }

  const source = join(downloadDirectory, releaseName)
  const sourceStat = await stat(source)
  if (!sourceStat.isFile() || sourceStat.size === 0) {
    throw new Error(`FFmpeg release asset is empty or invalid: ${releaseName}`)
  }

  const actualChecksum = await sha256(source)
  if (actualChecksum !== expectedChecksum) {
    throw new Error(
      `FFmpeg release checksum mismatch for ${releaseName}: expected ${expectedChecksum}, received ${actualChecksum}.`
    )
  }

  await copyFile(source, join(outputDirectory, outputName))
}

if (platformKey !== 'win32-x64') {
  await chmod(join(outputDirectory, 'ffmpeg'), 0o755)
}

console.log(`Installed checksum-verified FFmpeg release assets for ${platformKey}.`)

function parseChecksums (contents) {
  const checksums = new Map()
  for (const line of contents.split(/\r?\n/)) {
    if (!line) continue
    const match = /^([a-f0-9]{64})\s+\*?(.+)$/.exec(line)
    if (!match) throw new Error(`Invalid SHA256SUMS line: ${line}`)
    const name = basename(match[2])
    if (checksums.has(name)) throw new Error(`Duplicate SHA256SUMS entry: ${name}`)
    checksums.set(name, match[1])
  }
  return checksums
}

async function sha256 (path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
