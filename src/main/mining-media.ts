import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { parseBuffer } from 'music-metadata'

export type MiningCaptureMode = 'static' | 'animated'
export type MiningStaticImageFormat = 'png' | 'jpeg' | 'webp' | 'avif'
export type MiningAnimatedImageFormat = 'webp' | 'avif'
export type MiningMediaQuality = 'fast' | 'balanced' | 'high'

export interface MiningCaptureSpec {
  sourceUrl: string
  audioTrackIndex?: number
  currentTime: number
  start: number
  end: number
  captureImage: boolean
  captureAudio: boolean
  imageMode: MiningCaptureMode
  staticFormat: MiningStaticImageFormat
  animatedFormat: MiningAnimatedImageFormat
  quality: MiningMediaQuality
  maxHeight: number
  fps: number
  syncAnimationToWordAudio: boolean
}

export interface MiningEncodedMedia {
  kind: 'screenshot' | 'audio'
  filename: string
  mimeType: string
  data: Uint8Array
}

export interface MiningMediaEncoderState {
  available: boolean
  error?: string
}

export interface MiningMediaEncoderOptions {
  ffmpegPath: string
  spawnImplementation?: typeof spawn
  fetchImplementation?: typeof fetch
  temporaryRoot?: string
  timeoutMs?: number
  maxOutputBytes?: number
  now?: () => number
}

interface QualityOptions {
  jpegQscale: number
  webpQuality: number
  webpMethod: number
  avifCrf: number
  avifCpu: number
  mp3Bitrate: number
  pngCompression: number
}

interface MiningFfmpegPaths {
  inputSource?: string
  imagePath: string
  audioPath: string
  wordAudioDuration?: number
  maxOutputBytes?: number
}

class MiningMediaProcessError extends Error {
  constructor (
    message: string,
    readonly code: number | null,
    readonly signal: string | null,
    readonly diagnostic: string
  ) {
    super(message)
  }
}

const QUALITY: Record<MiningMediaQuality, QualityOptions> = {
  fast: {
    jpegQscale: 5,
    webpQuality: 70,
    webpMethod: 2,
    avifCrf: 40,
    avifCpu: 8,
    mp3Bitrate: 64,
    pngCompression: 3
  },
  balanced: {
    jpegQscale: 3,
    webpQuality: 82,
    webpMethod: 4,
    avifCrf: 32,
    avifCpu: 6,
    mp3Bitrate: 96,
    pngCompression: 6
  },
  high: {
    jpegQscale: 2,
    webpQuality: 92,
    webpMethod: 6,
    avifCrf: 24,
    avifCpu: 4,
    mp3Bitrate: 128,
    pngCompression: 9
  }
}

const MAX_CAPTURE_DURATION = 30
export const MAX_MINING_MEDIA_BYTES = 25 * 1024 * 1024
const DEFAULT_MAX_OUTPUT_BYTES = MAX_MINING_MEDIA_BYTES

export class MiningMediaEncoder {
  private readonly running = new Set<ChildProcess>()
  private readonly spawn: typeof spawn
  private readonly fetch: typeof fetch
  private readonly temporaryRoot: string
  private readonly timeoutMs: number
  private readonly maxOutputBytes: number
  private readonly now: () => number
  private stopped = false

  constructor (private readonly options: MiningMediaEncoderOptions) {
    this.spawn = options.spawnImplementation ?? spawn
    this.fetch = options.fetchImplementation ?? globalThis.fetch
    this.temporaryRoot = options.temporaryRoot ?? tmpdir()
    this.timeoutMs = options.timeoutMs ?? 60_000
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
    this.now = options.now ?? Date.now
  }

  state (): MiningMediaEncoderState {
    if (!existsSync(this.options.ffmpegPath)) {
      return { available: false, error: 'The packaged FFmpeg binary is unavailable.' }
    }
    return { available: true }
  }

  async encode (raw: MiningCaptureSpec, wordAudioDuration = 0): Promise<MiningEncodedMedia[]> {
    if (this.stopped) throw new Error('Media capture is shutting down.')
    const state = this.state()
    if (!state.available) throw new Error(state.error)
    const spec = validateMiningCaptureSpec(raw)
    if (!spec.captureImage && !spec.captureAudio) return []
    await verifyMiningMediaSource(spec.sourceUrl, this.fetch)

    const temporaryDirectory = await mkdtemp(join(this.temporaryRoot, 'hayase-mining-'))
    try {
      const imageFormat = spec.imageMode === 'animated' ? spec.animatedFormat : spec.staticFormat
      const imageExtension = imageFormat === 'jpeg' ? 'jpg' : imageFormat
      const imagePath = join(temporaryDirectory, `capture.${imageExtension}`)
      const audioPath = join(temporaryDirectory, 'sentence.mp3')
      const paths = {
        imagePath,
        audioPath,
        wordAudioDuration: clampDuration(wordAudioDuration),
        maxOutputBytes: this.maxOutputBytes
      }
      try {
        await this.run(this.options.ffmpegPath, buildMiningFfmpegArguments(spec, paths))
      } catch (error) {
        this.reportProcessFailure(error)
        throw error
      }

      const identity = `${this.now()}_${randomUUID()}`
      const media: MiningEncodedMedia[] = []
      if (spec.captureImage) {
        const data = await this.readBoundedOutput(imagePath)
        media.push({
          kind: 'screenshot',
          filename: `hayase_screenshot_${identity}.${imageExtension}`,
          mimeType: imageMimeType(imageFormat),
          data
        })
      }
      if (spec.captureAudio) {
        const data = await this.readBoundedOutput(audioPath)
        media.push({
          kind: 'audio',
          filename: `hayase_sentence_${identity}.mp3`,
          mimeType: 'audio/mpeg',
          data
        })
      }
      return media
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  }

  async probeDuration (media: { filename: string, data: Uint8Array }): Promise<number | undefined> {
    if (this.stopped || !this.state().available) return
    try {
      const metadata = await parseBuffer(media.data, {
        path: safeFilename(media.filename),
        size: media.data.byteLength
      }, { duration: true, skipCovers: true })
      const duration = metadata.format.duration
      return typeof duration === 'number' && Number.isFinite(duration) && duration > 0 && duration <= 60 * 60
        ? duration
        : undefined
    } catch {
      return undefined
    }
  }

  stop () {
    this.stopped = true
    for (const process of this.running) process.kill()
    this.running.clear()
  }

  private async readBoundedOutput (path: string) {
    const details = await stat(path)
    if (details.size > this.maxOutputBytes) throw new Error('FFmpeg media output exceeds the configured size limit.')
    const data = await readFile(path)
    if (!data.byteLength) throw new Error('FFmpeg produced an empty media file.')
    return new Uint8Array(data)
  }

  private reportProcessFailure (error: unknown) {
    if (error instanceof MiningMediaProcessError) {
      console.error('[mining-media] FFmpeg failed', {
        code: error.code,
        signal: error.signal,
        stderr: error.diagnostic || '(no diagnostic output)'
      })
    }
  }

  private run (executable: string, args: string[]) {
    return new Promise<void>((resolve, reject) => {
      const process = this.spawn(executable, args, {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe']
      })
      this.running.add(process)
      let stderr = ''
      let settled = false
      let timeoutError: Error | undefined
      let forceKillTimer: ReturnType<typeof setTimeout> | undefined
      let abandonTimer: ReturnType<typeof setTimeout> | undefined
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        if (forceKillTimer) clearTimeout(forceKillTimer)
        if (abandonTimer) clearTimeout(abandonTimer)
        this.running.delete(process)
        error ? reject(error) : resolve()
      }
      const timeout = setTimeout(() => {
        timeoutError = new Error('FFmpeg media capture timed out.')
        process.kill()
        forceKillTimer = setTimeout(() => {
          process.kill('SIGKILL')
          abandonTimer = setTimeout(() => finish(timeoutError), 2_000)
          abandonTimer.unref()
        }, 2_000)
        forceKillTimer.unref()
      }, this.timeoutMs)
      timeout.unref()
      process.stderr.on('data', chunk => {
        if (stderr.length < 64 * 1024) stderr += String(chunk)
      })
      process.once('error', error => finish(new Error(`Could not start media encoder: ${error.message}`)))
      process.once('close', (code, signal) => {
        if (timeoutError) {
          finish(timeoutError)
          return
        }
        if (code === 0) {
          finish()
        } else {
          const diagnostic = stderr.trim()
          const exit = code == null ? `signal ${signal ?? 'unknown'}` : `exit code ${code}`
          finish(new MiningMediaProcessError(
            `FFmpeg media capture failed (${exit})${diagnostic ? `: ${diagnostic}` : '.'}`,
            code,
            signal,
            diagnostic
          ))
        }
      })
    })
  }
}

export function validateMiningCaptureSpec (value: MiningCaptureSpec): MiningCaptureSpec {
  if (!isRecord(value)) throw new Error('Media capture request is invalid.')
  const sourceUrl = validateLocalMediaUrl(value.sourceUrl)
  const start = finiteNumber(value.start, 'Capture start')
  const end = finiteNumber(value.end, 'Capture end')
  if (start < 0 || end <= start || end - start > MAX_CAPTURE_DURATION) {
    throw new Error('Media capture range is invalid.')
  }
  const currentTime = finiteNumber(value.currentTime, 'Capture timestamp')
  if (currentTime < 0) throw new Error('Capture timestamp is invalid.')
  const imageMode = oneOf(value.imageMode, ['static', 'animated'] as const, 'capture mode')
  const staticFormat = oneOf(value.staticFormat, ['png', 'jpeg', 'webp', 'avif'] as const, 'static image format')
  const animatedFormat = oneOf(value.animatedFormat, ['webp', 'avif'] as const, 'animated image format')
  const quality = oneOf(value.quality, ['fast', 'balanced', 'high'] as const, 'media quality')
  const maxHeight = integerInRange(value.maxHeight, 240, 2160, 'Maximum image height')
  const fps = integerInRange(value.fps, 1, 30, 'Animation frame rate')
  const audioTrackIndex = value.audioTrackIndex == null
    ? undefined
    : integerInRange(value.audioTrackIndex, 0, 128, 'Audio track')
  return {
    sourceUrl,
    ...(audioTrackIndex == null ? {} : { audioTrackIndex }),
    currentTime,
    start,
    end,
    captureImage: Boolean(value.captureImage),
    captureAudio: Boolean(value.captureAudio),
    imageMode,
    staticFormat,
    animatedFormat,
    quality,
    maxHeight,
    fps,
    syncAnimationToWordAudio: Boolean(value.syncAnimationToWordAudio)
  }
}

export async function verifyMiningMediaSource (sourceUrl: string, fetchImplementation: typeof fetch) {
  const response = await fetchImplementation(validateLocalMediaUrl(sourceUrl), {
    method: 'HEAD',
    redirect: 'manual',
    signal: AbortSignal.timeout(5_000)
  })
  if (response.status >= 300 && response.status < 400) {
    throw new Error('The localhost media source attempted to redirect.')
  }
  if (!response.ok) throw new Error(`The localhost media source returned HTTP ${response.status}.`)
}

export function buildMiningFfmpegArguments (
  raw: MiningCaptureSpec,
  paths: MiningFfmpegPaths
) {
  const spec = validateMiningCaptureSpec(raw)
  const quality = QUALITY[spec.quality]
  const inputSeek = miningInputSeek(spec)
  const relativeStart = Math.max(0, spec.start - inputSeek)
  const relativeEnd = Math.max(relativeStart, spec.end - inputSeek)
  const relativeCurrentTime = Math.max(0, spec.currentTime - inputSeek)
  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    ...miningInputArguments(paths.inputSource ?? spec.sourceUrl, inputSeek)
  ]
  const videoFilters = buildMiningVideoFilters(spec, paths, {
    relativeStart,
    relativeEnd,
    relativeCurrentTime,
    includeWordAudioHold: true
  })

  if (spec.captureImage) {
    args.push('-map', '0:v:0', '-vf', videoFilters.join(','), '-an')
    appendMiningImageEncoderArguments(args, spec, quality, paths.imagePath, paths.maxOutputBytes)
  }

  if (spec.captureAudio) {
    args.push(
      '-map', `0:a:${spec.audioTrackIndex ?? 0}`,
      '-af', `atrim=start=${decimal(relativeStart)}:end=${decimal(relativeEnd)},asetpts=PTS-STARTPTS`,
      '-vn',
      '-ac', '1',
      '-ar', '48000',
      '-c:a', 'libmp3lame',
      '-b:a', `${quality.mp3Bitrate}k`,
      '-fs', String(paths.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES),
      paths.audioPath
    )
  }
  return args
}

function buildMiningVideoFilters (
  spec: MiningCaptureSpec,
  paths: MiningFfmpegPaths,
  times: {
    relativeStart: number
    relativeEnd: number
    relativeCurrentTime: number
    includeWordAudioHold: boolean
  }
) {
  const videoFilters: string[] = []
  if (spec.imageMode === 'animated') {
    videoFilters.push(
      `trim=start=${decimal(times.relativeStart)}:end=${decimal(times.relativeEnd)}`,
      'setpts=PTS-STARTPTS',
      `fps=${spec.fps}`,
      `scale=-2:min(ih\\,${spec.maxHeight})`
    )
    const hold = times.includeWordAudioHold && spec.syncAnimationToWordAudio
      ? clampDuration(paths.wordAudioDuration ?? 0)
      : 0
    if (hold > 0) videoFilters.push(`tpad=start_mode=clone:start_duration=${decimal(hold)}`)
  } else {
    videoFilters.push(
      `trim=start=${decimal(times.relativeCurrentTime)}:duration=0.1`,
      'setpts=PTS-STARTPTS',
      `scale=-2:min(ih\\,${spec.maxHeight})`
    )
  }
  return videoFilters
}

function appendMiningImageEncoderArguments (
  args: string[],
  spec: MiningCaptureSpec,
  quality: QualityOptions,
  imagePath: string,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES
) {
  const format = spec.imageMode === 'animated' ? spec.animatedFormat : spec.staticFormat
  if (format === 'png') {
    args.push('-frames:v', '1', '-c:v', 'png', '-compression_level', String(quality.pngCompression))
  } else if (format === 'jpeg') {
    args.push('-frames:v', '1', '-c:v', 'mjpeg', '-q:v', String(quality.jpegQscale))
  } else if (format === 'webp') {
    args.push(
      '-c:v', spec.imageMode === 'animated' ? 'libwebp_anim' : 'libwebp',
      '-quality', String(quality.webpQuality),
      '-compression_level', String(quality.webpMethod),
      ...(spec.imageMode === 'animated' ? ['-loop', '1'] : ['-frames:v', '1'])
    )
  } else {
    args.push(
      '-c:v', 'libaom-av1',
      '-crf', String(quality.avifCrf),
      '-cpu-used', String(quality.avifCpu),
      '-pix_fmt', 'yuv420p',
      ...(spec.imageMode === 'animated' ? ['-loop', '1'] : ['-frames:v', '1', '-still-picture', '1'])
    )
  }
  args.push('-fs', String(maxOutputBytes), imagePath)
}

export function resolveMiningMediaExecutable (
  options: { appPath: string, resourcesPath: string, isPackaged: boolean, platform?: typeof process.platform }
) {
  const platform = options.platform ?? process.platform
  const executable = `ffmpeg${platform === 'win32' ? '.exe' : ''}`
  return options.isPackaged
    ? join(options.resourcesPath, 'sidecars', executable)
    : join(options.appPath, 'resources', 'sidecars', executable)
}

function validateLocalMediaUrl (value: unknown) {
  if (typeof value !== 'string' || value.length > 4096) throw new Error('Media source URL is invalid.')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Media source URL is invalid.')
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (!local || (url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
    throw new Error('Media capture requires a localhost HTTP(S) source.')
  }
  return url.toString()
}

function safeFilename (value: string) {
  const filename = basename(value).replace(/[^\p{L}\p{N}_. -]/gu, '_')
  if (!filename || filename === '.' || filename === '..') throw new Error('Media filename is invalid.')
  return filename
}

function miningInputArguments (source: string, inputSeek: number) {
  const isHttp = source.startsWith('http://') || source.startsWith('https://')
  return [
    ...(isHttp ? ['-protocol_whitelist', 'http,https,tcp,tls'] : []),
    '-ss', decimal(inputSeek),
    '-i', source
  ]
}

function imageMimeType (format: MiningStaticImageFormat | MiningAnimatedImageFormat) {
  if (format === 'jpeg') return 'image/jpeg'
  return `image/${format}`
}

function oneOf<const T extends readonly string[]> (value: unknown, choices: T, label: string): T[number] {
  if (typeof value !== 'string' || !choices.includes(value)) throw new Error(`Invalid ${label}.`)
  return value
}

function finiteNumber (value: unknown, label: string) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} is invalid.`)
  return value
}

function integerInRange (value: unknown, minimum: number, maximum: number, label: string) {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label} is invalid.`)
  }
  return value as number
}

function decimal (value: number) {
  return String(Math.round(value * 1000) / 1000)
}

function miningInputSeek (spec: MiningCaptureSpec) {
  return spec.captureAudio || (spec.captureImage && spec.imageMode === 'animated')
    ? spec.start
    : spec.currentTime
}

function clampDuration (value: number) {
  return Number.isFinite(value) ? Math.max(0, Math.min(value, MAX_CAPTURE_DURATION)) : 0
}

function isRecord (value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
