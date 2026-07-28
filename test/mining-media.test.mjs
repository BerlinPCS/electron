import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import {
  buildMiningFfmpegArguments,
  MiningMediaEncoder,
  resolveMiningMediaExecutable,
  validateMiningCaptureSpec,
  verifyMiningMediaSource
} from '../src/main/mining-media.ts'

const base = {
  sourceUrl: 'http://localhost:7344/video.mkv',
  audioTrackIndex: 1,
  currentTime: 12.5,
  start: 11.85,
  end: 15.15,
  captureImage: true,
  captureAudio: true,
  imageMode: 'static',
  staticFormat: 'webp',
  animatedFormat: 'webp',
  quality: 'balanced',
  maxHeight: 720,
  fps: 12,
  syncAnimationToWordAudio: false
}

const paths = {
  imagePath: '/tmp/capture.webp',
  audioPath: '/tmp/sentence.mp3'
}

test('builds balanced static WebP and mono MP3 outputs from the selected times and track', () => {
  const args = buildMiningFfmpegArguments(base, paths)
  assert.deepEqual(args.slice(0, 11), [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-protocol_whitelist', 'http,https,tcp,tls',
    '-ss', '11.85', '-i', base.sourceUrl
  ])
  assert.equal(args.includes('-max_redirects'), false)
  assert.equal(args.includes('-protocol_opts'), false)
  assert.ok(args.includes('libwebp'))
  assert.ok(args.includes('82'))
  assert.ok(args.includes('4'))
  assert.ok(args.includes('trim=start=0.65:duration=0.1,setpts=PTS-STARTPTS,scale=-2:min(ih\\,720)'))
  assert.ok(args.includes('0:a:1'))
  assert.ok(args.includes('libmp3lame'))
  assert.ok(args.includes('96k'))
  assert.ok(args.includes('48000'))
  assert.equal(args.filter(value => value === '-fs').length, 2)
  assert.ok(args.includes('/tmp/capture.webp'))
  assert.ok(args.includes('/tmp/sentence.mp3'))
})

test('builds a single-play animated AVIF with a measured word-audio hold', () => {
  const args = buildMiningFfmpegArguments({
    ...base,
    imageMode: 'animated',
    animatedFormat: 'avif',
    quality: 'high',
    syncAnimationToWordAudio: true
  }, {
    ...paths,
    imagePath: '/tmp/capture.avif',
    wordAudioDuration: 1.275
  })
  const filters = args[args.indexOf('-vf') + 1]
  assert.match(filters, /trim=start=0:end=3\.3/)
  assert.match(filters, /fps=12/)
  assert.match(filters, /tpad=start_mode=clone:start_duration=1\.275/)
  assert.ok(args.includes('libaom-av1'))
  assert.ok(args.includes('24'))
  assert.ok(args.includes('4'))
  assert.equal(args[args.indexOf('-loop') + 1], '1')
})

test('applies format-specific PNG and JPEG static settings', () => {
  const png = buildMiningFfmpegArguments({
    ...base,
    captureAudio: false,
    staticFormat: 'png',
    quality: 'high'
  }, { ...paths, imagePath: '/tmp/capture.png' })
  assert.equal(png[png.indexOf('-c:v') + 1], 'png')
  assert.equal(png[png.indexOf('-compression_level') + 1], '9')
  assert.equal(png[png.indexOf('-frames:v') + 1], '1')

  const jpeg = buildMiningFfmpegArguments({
    ...base,
    captureAudio: false,
    staticFormat: 'jpeg',
    quality: 'fast'
  }, { ...paths, imagePath: '/tmp/capture.jpg' })
  assert.equal(jpeg[jpeg.indexOf('-c:v') + 1], 'mjpeg')
  assert.equal(jpeg[jpeg.indexOf('-q:v') + 1], '5')
})

test('rejects non-local sources and capture ranges over thirty seconds', () => {
  assert.throws(() => validateMiningCaptureSpec({ ...base, sourceUrl: 'https://example.com/video.mkv' }), /localhost/)
  assert.throws(() => validateMiningCaptureSpec({ ...base, end: base.start + 31 }), /range/)
  assert.throws(() => validateMiningCaptureSpec({
    ...base,
    imageMode: 'animated',
    animatedFormat: 'gif'
  }), /animated image format/)
})

test('checks localhost media without allowing redirects', async () => {
  let options
  await verifyMiningMediaSource(base.sourceUrl, async (_url, init) => {
    options = init
    return new Response(null, { status: 200 })
  })
  assert.equal(options.method, 'HEAD')
  assert.equal(options.redirect, 'manual')

  await assert.rejects(
    verifyMiningMediaSource(base.sourceUrl, async () => new Response(null, {
      status: 302,
      headers: { location: 'https://example.com/video.mkv' }
    })),
    /redirect/
  )
  await assert.rejects(
    verifyMiningMediaSource(base.sourceUrl, async () => new Response(null, { status: 404 })),
    /HTTP 404/
  )
})

test('does not retry combined capture after an FFmpeg failure', async () => {
  const calls = []
  const spawnImplementation = (_executable, args) => {
    calls.push(args)
    const child = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => true
    queueMicrotask(() => {
      child.emit('close', null, 'SIGSEGV')
    })
    return child
  }
  const encoder = new MiningMediaEncoder({
    ffmpegPath: '/bin/true',
    ffprobePath: '/bin/true',
    spawnImplementation,
    fetchImplementation: async () => new Response(null, { status: 200 })
  })

  await assert.rejects(encoder.encode({
    ...base,
    imageMode: 'animated'
  }), /FFmpeg media capture failed/)
  assert.equal(calls.length, 1)
  assert.ok(calls[0].some(value => value.endsWith('.webp')))
  assert.ok(calls[0].some(value => value.endsWith('.mp3')))
})

test('resolves development and packaged sidecar paths without system fallback', () => {
  assert.equal(resolveMiningMediaExecutable('ffmpeg', {
    appPath: '/app',
    resourcesPath: '/resources',
    isPackaged: false,
    platform: 'linux'
  }), '/app/resources/sidecars/ffmpeg')
  assert.equal(resolveMiningMediaExecutable('ffprobe', {
    appPath: 'C:\\app',
    resourcesPath: 'C:\\resources',
    isPackaged: true,
    platform: 'win32'
  }), 'C:\\resources/sidecars/ffprobe.exe')
})
