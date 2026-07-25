import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, openAsBlob } from 'node:fs'
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'

import readZip from 'zip-go/lib/read.js'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const outputDirectory = join(projectRoot, 'resources', 'sidecars')
const cacheDirectory = join(projectRoot, 'node_modules', '.cache', 'hayase-ffmpeg')
const executableSuffix = process.platform === 'win32' ? '.exe' : ''
const platformKey = `${process.platform}-${process.arch}`
const MAX_ARCHIVE_BYTES = 300 * 1024 * 1024
const archivePromises = new Map()

// These are immutable, checksum-pinned archives rather than "latest" URLs. Martin
// Riedl provides the Linux/macOS release builds; BtbN provides the Windows build.
const BUILDS = {
  'linux-x64': {
    version: '8.1.2',
    provider: 'Martin Riedl FFmpeg Builds',
    ffmpeg: {
      url: 'https://ffmpeg.martin-riedl.de/download/linux/amd64/1783011670_8.1.2/ffmpeg.zip',
      sha256: '56452c0bfc4ee0325cd615d62f46ba8264f62eed34f727c2224c6c84fa7b8719',
      entry: 'ffmpeg'
    },
    ffprobe: {
      url: 'https://ffmpeg.martin-riedl.de/download/linux/amd64/1783011670_8.1.2/ffprobe.zip',
      sha256: 'c6f2d36e98f9a4445fad0b0be539f4c4faf13fd502116bf131becd53f56cd390',
      entry: 'ffprobe'
    }
  },
  'darwin-x64': {
    version: '8.1.2',
    provider: 'Martin Riedl FFmpeg Builds',
    ffmpeg: {
      url: 'https://ffmpeg.martin-riedl.de/download/macos/amd64/1783018342_8.1.2/ffmpeg.zip',
      sha256: 'a52ef43883f44c219766d4b3bdde4e635b35465d0b704c01c3a0566b59775df9',
      entry: 'ffmpeg'
    },
    ffprobe: {
      url: 'https://ffmpeg.martin-riedl.de/download/macos/amd64/1783018342_8.1.2/ffprobe.zip',
      sha256: '5408ca588c8c72b0dde3afe676d0a7acf25ef97e55ae6eba5c7bede1cda42695',
      entry: 'ffprobe'
    }
  },
  'darwin-arm64': {
    version: '8.1.2',
    provider: 'Martin Riedl FFmpeg Builds',
    ffmpeg: {
      url: 'https://ffmpeg.martin-riedl.de/download/macos/arm64/1783011502_8.1.2/ffmpeg.zip',
      sha256: 'ef1aa60006c7b77ce170c1608c08d8e4ba1c30c5746f2ac986ded932d0ac2c3c',
      entry: 'ffmpeg'
    },
    ffprobe: {
      url: 'https://ffmpeg.martin-riedl.de/download/macos/arm64/1783011502_8.1.2/ffprobe.zip',
      sha256: 'c39787f4af7a3932502d2d48db6f6feaaa836b48a73ef78c32cc3285df61dfaf',
      entry: 'ffprobe'
    }
  },
  'win32-x64': {
    version: '8.0.1-66-g27b8d1a017',
    provider: 'BtbN FFmpeg Builds',
    ffmpeg: {
      url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-02-28-12-59/ffmpeg-n8.0.1-66-g27b8d1a017-win64-gpl-8.0.zip',
      sha256: 'e1f9fc491ef1969e666cfe36ec1d6c02b53baf49df800d5256eda10c942b1251',
      entry: /\/bin\/ffmpeg\.exe$/
    },
    ffprobe: {
      url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-02-28-12-59/ffmpeg-n8.0.1-66-g27b8d1a017-win64-gpl-8.0.zip',
      sha256: 'e1f9fc491ef1969e666cfe36ec1d6c02b53baf49df800d5256eda10c942b1251',
      entry: /\/bin\/ffprobe\.exe$/
    }
  }
}

const build = BUILDS[platformKey]
if (!build) {
  throw new Error(`No pinned FFmpeg build is configured for ${platformKey}.`)
}

await Promise.all([
  mkdir(outputDirectory, { recursive: true }),
  mkdir(cacheDirectory, { recursive: true })
])

const packagedFfmpegPath = join(outputDirectory, `ffmpeg${executableSuffix}`)
const packagedFfprobePath = join(outputDirectory, `ffprobe${executableSuffix}`)
await Promise.all([
  installBinary(build.ffmpeg, packagedFfmpegPath),
  installBinary(build.ffprobe, packagedFfprobePath)
])

if (process.platform !== 'win32') {
  await Promise.all([
    chmod(packagedFfmpegPath, 0o755),
    chmod(packagedFfprobePath, 0o755)
  ])
}

validateVersion(packagedFfmpegPath, build.version)
validateVersion(packagedFfprobePath, build.version)
validateCapability(packagedFfmpegPath, ['-hide_banner', '-encoders'], [
  'libmp3lame', 'png', 'mjpeg', 'libwebp', 'libwebp_anim', 'libaom-av1'
], 'encoders')
validateCapability(packagedFfmpegPath, ['-hide_banner', '-filters'], [
  'scale', 'trim', 'tpad'
], 'filters')
validateCapability(packagedFfmpegPath, ['-hide_banner', '-muxers'], [
  ' avif ', ' webp ', ' mp3 '
], 'muxers')

const gplLicense = await readFile(join(outputDirectory, 'FFMPEG-LICENSE.txt'), 'utf8')
await Promise.all([
  writeFile(join(outputDirectory, 'FFMPEG-LICENSE.txt'), gplLicense),
  writeFile(join(outputDirectory, 'FFPROBE-LICENSE.txt'), gplLicense),
  writeFile(join(outputDirectory, 'FFMPEG-SOURCES.txt'), [
    `Packaged platform: ${platformKey}`,
    `Packaged version: ${build.version}`,
    `Binary provider: ${build.provider}`,
    '',
    `FFmpeg archive: ${build.ffmpeg.url}`,
    `FFmpeg archive SHA-256: ${build.ffmpeg.sha256}`,
    `FFprobe archive: ${build.ffprobe.url}`,
    `FFprobe archive SHA-256: ${build.ffprobe.sha256}`,
    '',
    'FFmpeg source and license information: https://ffmpeg.org/',
    'Martin Riedl binary provider: https://ffmpeg.martin-riedl.de/',
    'BtbN binary provider and build sources: https://github.com/BtbN/FFmpeg-Builds',
    ''
  ].join('\n'))
])

console.log(`Prepared FFmpeg ${build.version} and FFprobe for ${platformKey}.`)

/**
 * @param {{ url: string, sha256: string, entry: string | RegExp }} artifact
 * @param {string} destination
 */
async function installBinary (artifact, destination) {
  const archive = await cachedArchive(artifact)
  const blob = await openAsBlob(archive)
  for await (const entry of readZip(blob)) {
    const matches = typeof artifact.entry === 'string'
      ? entry.name === artifact.entry
      : artifact.entry.test(entry.name)
    if (!entry.directory && matches) {
      const temporary = `${destination}.${process.pid}.tmp`
      try {
        await entry.stream().pipeTo(Writable.toWeb(createWriteStream(temporary, { mode: 0o755 })))
        await rename(temporary, destination)
      } finally {
        await unlink(temporary).catch(() => {})
      }
      return
    }
  }
  throw new Error(`Could not find ${String(artifact.entry)} in ${artifact.url}.`)
}

function cachedArchive (artifact) {
  let promise = archivePromises.get(artifact.sha256)
  if (!promise) {
    promise = ensureArchive(artifact)
    archivePromises.set(artifact.sha256, promise)
  }
  return promise
}

async function ensureArchive (artifact) {
  const archive = join(cacheDirectory, `${artifact.sha256}.zip`)
  if (await sha256(archive) !== artifact.sha256) {
    await download(artifact.url, archive, artifact.sha256)
  }
  return archive
}

async function download (url, destination, expectedSha256) {
  const temporary = `${destination}.${process.pid}.tmp`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5 * 60_000)
  try {
    const response = await fetch(url, { redirect: 'follow', signal: controller.signal })
    if (!response.ok || !response.body) throw new Error(`Download failed with HTTP ${response.status}: ${url}`)
    const contentLength = Number(response.headers.get('content-length') ?? 0)
    if (contentLength > MAX_ARCHIVE_BYTES) throw new Error(`FFmpeg archive exceeds ${MAX_ARCHIVE_BYTES} bytes.`)

    let received = 0
    const bounded = new TransformStream({
      transform (chunk, streamController) {
        received += chunk.byteLength
        if (received > MAX_ARCHIVE_BYTES) throw new Error(`FFmpeg archive exceeds ${MAX_ARCHIVE_BYTES} bytes.`)
        streamController.enqueue(chunk)
      }
    })
    await response.body.pipeThrough(bounded).pipeTo(Writable.toWeb(createWriteStream(temporary)))
    const actualSha256 = await sha256(temporary)
    if (actualSha256 !== expectedSha256) {
      throw new Error(`FFmpeg archive checksum mismatch: expected ${expectedSha256}, received ${actualSha256}.`)
    }
    await rename(temporary, destination)
  } finally {
    clearTimeout(timeout)
    await unlink(temporary).catch(() => {})
  }
}

async function sha256 (path) {
  const hash = createHash('sha256')
  try {
    for await (const chunk of createReadStream(path)) hash.update(chunk)
    return hash.digest('hex')
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

function validateVersion (executable, expectedVersion) {
  const result = spawnSync(executable, ['-version'], { encoding: 'utf8', maxBuffer: 1024 * 1024 })
  if (result.error ?? result.status !== 0) {
    throw new Error(`Could not inspect packaged binary version: ${result.error?.message ?? result.stderr}`)
  }
  if (!result.stdout.includes(expectedVersion)) {
    throw new Error(`Packaged binary is not the pinned ${expectedVersion} build: ${result.stdout.split('\n')[0]}`)
  }
}

/**
 * @param {string} executable
 * @param {string[]} args
 * @param {string[]} requirements
 * @param {string} label
 */
function validateCapability (executable, args, requirements, label) {
  const result = spawnSync(executable, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  if (result.error ?? result.status !== 0) {
    throw new Error(`Could not inspect packaged FFmpeg ${label}: ${result.error?.message ?? result.stderr}`)
  }
  const output = `${result.stdout}\n${result.stderr}`
  const missing = requirements.filter(requirement => !output.includes(requirement))
  if (missing.length) throw new Error(`Packaged FFmpeg is missing required ${label}: ${missing.join(', ')}`)
}
