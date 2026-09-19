// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- Dynamic diagnostic bundle and structural piece-store adapter.
// @ts-nocheck
// Read-only diagnostic for a downloaded MKV/WebM and an external ASS/SRT subtitle.
// Prints timing evidence. Does not touch the app profile.
import { open, readFile, writeFile, stat, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { build } from 'esbuild'

const [video, subtitle, playbackTime = '0', bufferedSeconds = '0', fixtureOutput] = process.argv.slice(2)
if (!video || !subtitle) throw new Error('Usage: node scripts/diagnose-subtitle-timing.mjs <video.mkv> <subtitle.ass|srt> [playback-seconds] [buffered-seconds] [timestamp-fixture.json]')
const temp = await mkdtemp(join(tmpdir(), 'hayatan-diagnose-'))
const handle = await open(video)
try {
  const root = new URL('..', import.meta.url).pathname
  await build({ entryPoints: [join(root, 'src/main/torrent/subtitle-sampler.ts')], outfile: join(temp, 'sampler.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  await build({ entryPoints: [resolve(root, '../interface/src/lib/components/ui/player/subtitle-matcher.ts')], outfile: join(temp, 'matcher.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  const { SubtitleSampler } = await import(pathToFileURL(join(temp, 'sampler.mjs')).href)
  const { matchSubtitleWindows, dialogueCue } = await import(pathToFileURL(join(temp, 'matcher.mjs')).href)
  const { size } = await stat(video)
  const pieceLength = 1024 * 1024
  const file = {
    name: video,
    offset: 0,
    length: size,
    _torrent: {
      pieceLength,
      lastPieceLength: size % pieceLength || pieceLength,
      pieces: Array(Math.ceil(size / pieceLength)),
      bitfield: { get: () => true },
      store: {
        get: (piece, { offset, length }, callback) => {
          const bytes = Buffer.alloc(length)
          handle.read(bytes, 0, length, piece * pieceLength + offset).then(({ bytesRead }) => callback(null, bytes.subarray(0, bytesRead)), callback)
        }
      },
      _selections: [],
      _updateSelections () {},
      _select () { throw new Error('Local diagnostic must not download') }
    }
  }
  let sampled
  const started = performance.now()
  const playback = { time: Number(playbackTime), duration: 0, buffered: Number(bufferedSeconds), stalled: false }
  if (!Number.isFinite(playback.time) || !Number.isFinite(playback.buffered) || playback.time < 0 || playback.buffered < 0) throw new Error('Playback and buffer seconds must be nonnegative numbers')
  await new SubtitleSampler(new Map([['local0', file]])).start({ sessionId: 'local-diagnostic', hash: 'local', fileId: 0, availableOnly: true, playback }, event => { sampled = event })
  const toTime = value => value.split(':').reduce((total, part) => total * 60 + Number(part), 0)
  let format = []
  const cues = []
  let events = false
  const subtitleText = await readFile(subtitle, 'utf8')
  for (const line of subtitleText.split(/\r?\n/)) {
    if (line.startsWith('[')) events = line.trim().toLowerCase() === '[events]'
    if (!events) continue
    if (line.startsWith('Format:')) format = line.slice(7).toLowerCase().split(',').map(value => value.trim())
    if (!line.startsWith('Dialogue:')) continue
    const fields = line.slice(9).trim().split(',')
    const eventFormat = format
    const field = name => fields[eventFormat.indexOf(name)] ?? ''
    if (dialogueCue(fields.slice(format.indexOf('text')).join(','), field('style'))) cues.push({ start: toTime(field('start')), end: toTime(field('end')) })
  }
  if (/\.srt$/i.test(subtitle)) {
    for (const line of subtitleText.split(/\r?\n/)) {
      const match = line.match(/^(\d+:\d+:\d+[,.]\d+)\s*-->\s*(\d+:\d+:\d+[,.]\d+)/)
      if (match) cues.push({ start: toTime(match[1].replace(',', '.')), end: toTime(match[2].replace(',', '.')) })
    }
  }
  if (fixtureOutput) {
    await writeFile(fixtureOutput, JSON.stringify({
      references: sampled.tracks.filter(track => !track.forced).map(track => track.windows.map(window => ({ ...window, cues: window.cues.filter(cue => dialogueCue(cue.text, cue.style)).map(({ start, end }) => ({ start, end })) }))),
      cues
    }))
  }
  console.log(JSON.stringify({ elapsedMs: Math.round(performance.now() - started), reason: sampled.reason, bytesParsed: sampled.bytesParsed, bytesFetched: sampled.bytesFetched, references: sampled.tracks.filter(track => !track.forced).map(track => ({ track: track.id, language: track.language, windows: track.windows.map(window => ({ start: window.start, end: window.end, cues: window.cues.length })), alignment: matchSubtitleWindows(track.windows.map(window => ({ ...window, cues: window.cues.filter(cue => dialogueCue(cue.text, cue.style)) })), cues) })) }, null, 2))
} finally {
  await handle.close()
  await rm(temp, { recursive: true, force: true })
}
