import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'

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
  ffprobePath: string
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
}

class MiningMediaProcessError extends Error {
  stage?: string

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
const DEFAULT_MAX_OUTPUT_BYTES = 100 * 1024 * 1024

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
    if (!existsSync(this.options.ffprobePath)) {
      return { available: false, error: 'The packaged FFprobe binary is unavailable.' }
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
        wordAudioDuration: clampDuration(wordAudioDuration)
      }
      try {
        await this.runStage('combined capture', this.options.ffmpegPath, buildMiningFfmpegArguments(spec, paths))
      } catch (error) {
        if (error instanceof MiningMediaProcessError &&
          error.signal === 'SIGSEGV' &&
          spec.captureImage &&
          (spec.captureAudio || spec.imageMode === 'animated')) {
          console.warn('[mining-media] Capture crashed; retrying with an isolated image pipeline.')
          try {
            if (spec.imageMode === 'animated') {
              const framePattern = join(temporaryDirectory, 'frame-%06d.png')
              const recoveryTasks = [
                this.runStage('frame extraction', this.options.ffmpegPath, buildMiningFrameExtractionArguments(spec, {
                  ...paths,
                  framePattern
                }))
              ]
              if (spec.captureAudio) {
                recoveryTasks.push(this.runStage('sentence audio', this.options.ffmpegPath, buildMiningFfmpegArguments({
                  ...spec,
                  captureImage: false
                }, paths)))
              }
              await Promise.all(recoveryTasks)
              await this.runStage('animation assembly', this.options.ffmpegPath, buildMiningFrameAssemblyArguments(spec, {
                ...paths,
                framePattern
              }))
            } else {
              await this.runStage('static image', this.options.ffmpegPath, buildMiningFfmpegArguments({
                ...spec,
                captureAudio: false
              }, paths))
              await this.runStage('sentence audio', this.options.ffmpegPath, buildMiningFfmpegArguments({
                ...spec,
                captureImage: false
              }, paths))
            }
          } catch (fallbackError) {
            this.reportProcessFailure(fallbackError)
            throw fallbackError
          }
        } else {
          this.reportProcessFailure(error)
          throw error
        }
      }

      const timestamp = this.now()
      const media: MiningEncodedMedia[] = []
      if (spec.captureImage) {
        const data = await this.readBoundedOutput(imagePath)
        media.push({
          kind: 'screenshot',
          filename: `hayase_screenshot_${timestamp}.${imageExtension}`,
          mimeType: imageMimeType(imageFormat),
          data
        })
      }
      if (spec.captureAudio) {
        const data = await this.readBoundedOutput(audioPath)
        media.push({
          kind: 'audio',
          filename: `hayase_sentence_${timestamp}.mp3`,
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
    const temporaryDirectory = await mkdtemp(join(this.temporaryRoot, 'hayase-probe-'))
    try {
      const extension = safeExtension(media.filename)
      const path = join(temporaryDirectory, `word-audio${extension}`)
      await writeFile(path, media.data)
      const output = await this.run(this.options.ffprobePath, [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        path
      ], true)
      const duration = Number(output.trim())
      return Number.isFinite(duration) && duration > 0 && duration <= 60 * 60 ? duration : undefined
    } catch {
      return undefined
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
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
        stage: error.stage ?? 'unknown',
        code: error.code,
        signal: error.signal,
        stderr: error.diagnostic || '(no diagnostic output)'
      })
    }
  }

  private async runStage (stage: string, executable: string, args: string[], captureStdout = false) {
    try {
      return await this.run(executable, args, captureStdout)
    } catch (error) {
      if (error instanceof MiningMediaProcessError) error.stage = stage
      throw error
    }
  }

  private run (executable: string, args: string[], captureStdout = false) {
    return new Promise<string>((resolve, reject) => {
      const process = this.spawn(executable, args, {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', captureStdout ? 'pipe' : 'ignore', 'pipe']
      })
      this.running.add(process)
      let stderr = ''
      let stdout = ''
      let settled = false
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        this.running.delete(process)
        error ? reject(error) : resolve(stdout)
      }
      const timeout = setTimeout(() => {
        process.kill()
        finish(new Error('FFmpeg media capture timed out.'))
      }, this.timeoutMs)
      timeout.unref()
      process.stdout?.on('data', chunk => {
        stdout += String(chunk)
        if (Buffer.byteLength(stdout) > 1024 * 1024) {
          process.kill()
          finish(new Error('FFprobe returned too much output.'))
        }
      })
      process.stderr?.on('data', chunk => {
        if (stderr.length < 64 * 1024) stderr += String(chunk)
      })
      process.once('error', error => finish(new Error(`Could not start media encoder: ${error.message}`)))
      process.once('close', (code, signal) => {
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
    appendMiningImageEncoderArguments(args, spec, quality, paths.imagePath)
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
      paths.audioPath
    )
  }
  return args
}

export function buildMiningFrameExtractionArguments (
  raw: MiningCaptureSpec,
  paths: MiningFfmpegPaths & { framePattern: string }
) {
  const spec = validateMiningCaptureSpec(raw)
  if (spec.imageMode !== 'animated' || !spec.captureImage) {
    throw new Error('Frame extraction requires animated image capture.')
  }
  const inputSeek = miningInputSeek(spec)
  const relativeStart = Math.max(0, spec.start - inputSeek)
  const relativeEnd = Math.max(relativeStart, spec.end - inputSeek)
  const filters = buildMiningVideoFilters(spec, paths, {
    relativeStart,
    relativeEnd,
    relativeCurrentTime: 0,
    includeWordAudioHold: false
  })
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    ...miningInputArguments(paths.inputSource ?? spec.sourceUrl, inputSeek, true),
    '-map', '0:v:0',
    '-vf', filters.join(','),
    '-an',
    '-fps_mode', 'passthrough',
    '-c:v', 'png',
    '-compression_level', '3',
    paths.framePattern
  ]
}

export function buildMiningFrameAssemblyArguments (
  raw: MiningCaptureSpec,
  paths: MiningFfmpegPaths & { framePattern: string }
) {
  const spec = validateMiningCaptureSpec(raw)
  if (spec.imageMode !== 'animated' || !spec.captureImage) {
    throw new Error('Frame assembly requires animated image capture.')
  }
  const quality = QUALITY[spec.quality]
  const hold = spec.syncAnimationToWordAudio ? clampDuration(paths.wordAudioDuration ?? 0) : 0
  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y'
  ]
  if (hold > 0) {
    args.push(
      '-loop', '1',
      '-framerate', String(spec.fps),
      '-t', decimal(hold),
      '-i', paths.framePattern.replace('%06d', '000001')
    )
  }
  args.push('-framerate', String(spec.fps), '-i', paths.framePattern)
  const animationInput = hold > 0
    ? '[0:v:0]setpts=PTS-STARTPTS[hold];[1:v:0]setpts=PTS-STARTPTS[main];[hold][main]concat=n=2:v=1:a=0[animation]'
    : ''
  if (hold > 0) {
    args.push('-filter_complex', animationInput, '-map', '[animation]', '-an')
    appendMiningImageEncoderArguments(args, spec, quality, paths.imagePath)
  } else {
    args.push('-vf', 'setpts=PTS-STARTPTS', '-an')
    appendMiningImageEncoderArguments(args, spec, quality, paths.imagePath)
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
  imagePath: string
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
  args.push(imagePath)
}

export function resolveMiningMediaExecutable (
  name: 'ffmpeg' | 'ffprobe',
  options: { appPath: string, resourcesPath: string, isPackaged: boolean, platform?: typeof process.platform }
) {
  const platform = options.platform ?? process.platform
  const executable = `${name}${platform === 'win32' ? '.exe' : ''}`
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

function miningInputArguments (source: string, inputSeek: number, singleThreaded = false) {
  const isHttp = source.startsWith('http://') || source.startsWith('https://')
  return [
    ...(isHttp ? ['-protocol_whitelist', 'http,https,tcp,tls'] : []),
    '-ss', decimal(inputSeek),
    ...(singleThreaded ? ['-threads', '1'] : []),
    '-i', source
  ]
}

function safeExtension (filename: string) {
  const extension = extname(safeFilename(filename)).toLowerCase()
  return /^\.[a-z0-9]{1,10}$/.test(extension) ? extension : '.bin'
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
