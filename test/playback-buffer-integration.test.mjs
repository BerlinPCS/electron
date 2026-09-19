// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- Real torrent/demuxer integration with dynamic bundles.
// @ts-nocheck
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire, registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL, fileURLToPath } from 'node:url'

import { build } from 'esbuild'
const hooks = registerHooks({
  resolve (specifier, context, next) {
    if (specifier === 'webrtc-polyfill') return { url: 'data:text/javascript,export const RTCPeerConnection=undefined,RTCSessionDescription=undefined,RTCIceCandidate=undefined;', shortCircuit: true }
    return next(specifier, context)
  }
})
const temp = await mkdtemp(join(tmpdir(), 'hayatan-live-buffer-'))
for (const [name, relative] of [['buffer', '../../interface/src/lib/components/ui/player/bunny/playback-buffer.ts'], ['sampler', '../src/main/torrent/subtitle-sampler.ts'], ['matcher', '../../interface/src/lib/components/ui/player/subtitle-matcher.ts']]) {
  await build({ entryPoints: [fileURLToPath(new URL(relative, import.meta.url))], outfile: join(temp, name + '.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
}
const { torrentPlaybackBuffer, PLAYBACK_RANGE_BYTES } = await import(pathToFileURL(join(temp, 'buffer.mjs')).href)
const { SubtitleSampler } = await import(pathToFileURL(join(temp, 'sampler.mjs')).href)
const { matchSubtitleWindows } = await import(pathToFileURL(join(temp, 'matcher.mjs')).href)
const require = createRequire(import.meta.url)
const torrentRequire = createRequire(require.resolve('torrent-client/package.json'))
const { default: WebTorrent } = await import(pathToFileURL(torrentRequire.resolve('webtorrent')).href)
let seed = 0x12345678
let time = 2
const cues = []
while (time < 295) {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
  cues.push({ start: time, end: time + 0.8 })
  time += 1.2 + seed / 2 ** 32 * 4.5
}
const timestamp = value => { const ms = Math.round(value * 1000); return `00:${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}` }
await writeFile(join(temp, 'dialogue.srt'), cues.map((cue, index) => `${index + 1}\n${timestamp(cue.start)} --> ${timestamp(cue.end)}\nFixture dialogue ${index}\n`).join('\n'))
execFileSync(fileURLToPath(new URL('../resources/sidecars/ffmpeg', import.meta.url)), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=6:duration=300', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000:duration=300', '-i', join(temp, 'dialogue.srt'), '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '1000k', '-minrate', '1000k', '-maxrate', '1000k', '-bufsize', '1000k', '-x264-params', 'nal-hrd=cbr:force-cfr=1', '-g', '12', '-keyint_min', '12', '-sc_threshold', '0', '-c:a', 'aac', '-c:s', 'ass', '-metadata:s:s:0', 'language=eng', join(temp, 'fixture.mkv')])
for (const rate of [0, 2 * 1024 * 1024]) {
  test(`real custom demux buffer enables future sampling (${rate || 'unlimited'} bytes/s)`, { timeout: 65000 }, async t => {
    const seeder = new WebTorrent({ dht: false, tracker: false, lsd: false, utp: false })
    const leecher = new WebTorrent({ dht: false, tracker: false, lsd: false, utp: false })
    let buffer, sampler, server, poll, starveTimer, resumeTimer
    try {
      if (rate) seeder.throttleUpload(rate)
      const seeded = await new Promise((resolve, reject) => { seeder.once('error', reject); seeder.seed(join(temp, 'fixture.mkv'), { announce: [], pieceLength: 65536 }, resolve) })
      const torrent = await new Promise((resolve, reject) => { leecher.once('error', reject); leecher.add(seeded.torrentFile, { path: join(temp, `download-${rate}`), announce: [], deselect: true }, resolve) })
      torrent.addPeer(`127.0.0.1:${seeder.torrentPort}`)
      const file = torrent.files[0]; const requests = []; let served = 0; let finished = 0
      server = createServer((request, response) => {
        const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '')
        if (!match) { response.writeHead(400); response.end(); return }
        const start = Number(match[1]); const end = Math.min(Number(match[2]), file.length - 1)
        requests.push({ start, end })
        response.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${file.length}`, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes' })
        const stream = file.createReadStream({ start, end })
        stream.on('data', bytes => { served += bytes.length }); response.on('finish', () => { finished++ }); stream.on('error', () => response.destroy()); response.on('close', () => stream.destroy()); stream.pipe(response)
      }).listen(0, '127.0.0.1')
      await once(server, 'listening')
      let ranges = []
      let stalled = false
      let samplerSelections = 0
      let selectionsDuringStarvation = 0
      const select = torrent._select.bind(torrent)
      torrent._select = (...args) => {
        if (args[2] === 0 && typeof args[3] === 'function') { samplerSelections++; if (stalled) selectionsDuringStarvation++ }
        return select(...args)
      }
      buffer = torrentPlaybackBuffer(`http://127.0.0.1:${server.address().port}/video`, file.length, '1', '2', 300, value => { ranges = value; sampler?.update('live', { time: 0, duration: 300, buffered: ranges[0]?.end ?? 0, stalled }) })
      buffer.update(0, false)
      assert.deepEqual(ranges, [], 'playback start does not await prefetch')
      await new Promise((resolve, reject) => {
        const deadline = Date.now() + 25000
        poll = setInterval(() => {
          if ((ranges[0]?.end ?? 0) >= 30) { clearInterval(poll); resolve() } else if (Date.now() > deadline) { clearInterval(poll); reject(new Error(`buffer not ready: ${JSON.stringify({ ranges, requests: requests.slice(0, 5), count: requests.length, served, finished, progress: torrent.progress })}`)) }
        }, 20)
      })
      assert.ok(torrent.progress < 0.9, 'buffer is ready before the episode finishes downloading')
      const bufferedBefore = ranges[0].end
      const progressBefore = torrent.progress
      sampler = new SubtitleSampler(new Map([['fixture0', file]]))
      let result
      starveTimer = setTimeout(() => { stalled = true; buffer.update(0, true) }, 150)
      resumeTimer = setTimeout(() => { stalled = false; buffer.update(0, false) }, 450)
      await sampler.start({ sessionId: 'live', hash: 'fixture', fileId: 0, playback: { time: 0, duration: 300, buffered: ranges[0].end, stalled: false } }, event => { result = event })
      assert.equal(result.reason, 'complete')
      assert.ok(samplerSelections > 0)
      assert.equal(selectionsDuringStarvation, 0)
      assert.ok(result.bytesFetched > 0, 'sampler downloads data absent from playback reserve')
      assert.ok(result.tracks[0].windows.some(window => window.start > 140 && window.cues.length >= 6))
      const match = matchSubtitleWindows(result.tracks[0].windows, cues.map(cue => ({ start: cue.start - 5, end: cue.end - 5 })))
      assert.equal(match.accepted, true, JSON.stringify(match)); assert.equal(match.offset, 5)
      assert.ok(requests.every(range => range.end - range.start + 1 <= PLAYBACK_RANGE_BYTES))
      assert.ok(requests.length > 1, 'real demuxer issues bounded finite reads')
      t.diagnostic(JSON.stringify({ bufferedBefore, progressBefore, sampledBytes: result.bytesFetched, confidence: match.confidence, offset: match.offset, selectionsDuringStarvation }))
    } finally {
      clearTimeout(starveTimer); clearTimeout(resumeTimer); clearInterval(poll); sampler?.cancel('live'); buffer?.destroy(); server?.closeAllConnections()
      await new Promise(resolve => server ? server.close(resolve) : resolve())
      await Promise.all([seeder, leecher].map(client => new Promise(resolve => client.destroy(resolve))))
    }
  })
}
test.after(async () => { hooks.deregister(); await rm(temp, { recursive: true, force: true }) })
