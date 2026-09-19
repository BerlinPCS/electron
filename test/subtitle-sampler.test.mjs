// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- Dynamic binary fixtures and deliberately partial native test doubles.
// @ts-nocheck
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire, registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { deflateSync } from 'node:zlib'

import { build } from 'esbuild'

import { SubtitleRangeReader } from '../src/main/torrent/subtitle-range-reader.ts'

// Match the desktop bundle: TCP tests do not load the optional WebRTC native addon.
const hooks = registerHooks({
  resolve (specifier, context, next) {
    if (specifier === 'webrtc-polyfill') return { url: 'data:text/javascript,export const RTCPeerConnection=undefined,RTCSessionDescription=undefined,RTCIceCandidate=undefined;', shortCircuit: true }
    return next(specifier, context)
  }
})
const temp = await mkdtemp(join(tmpdir(), 'subtitle-sampler-'))
await build({ entryPoints: [new URL('../src/main/torrent/subtitle-sampler.ts', import.meta.url).pathname], outfile: join(temp, 'sampler.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
await build({ entryPoints: [new URL('../../interface/src/lib/components/ui/player/subtitle-matcher.ts', import.meta.url).pathname], outfile: join(temp, 'matcher.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
const { matchSubtitleWindows } = await import(pathToFileURL(join(temp, 'matcher.mjs')).href)
const { SubtitleSampler } = await import(pathToFileURL(join(temp, 'sampler.mjs')).href)
function unsigned (value, bytes = 4) { const out = Buffer.alloc(bytes); out.writeUIntBE(value, 0, bytes); return out }
function element (id, data) {
  const idBuffer = Buffer.from(id.toString(16).padStart(2, '0'), 'hex')
  let count = 1
  while (data.length >= 2 ** (7 * count) - 1) count++
  const size = unsigned(data.length, count)
  size[0] |= 1 << (8 - count)
  return Buffer.concat([idBuffer, size, data])
}
const master = (id, entries) => element(id, Buffer.concat(entries))
const text = (id, value) => element(id, Buffer.from(value))
const num = (id, value) => element(id, unsigned(value))
const minuteStarts = minute => [2, 5.4, 11.7, 16.1, 24, 31.3, 38.8, 47, 54.9].map((start, i) => start + Math.sin(minute * 9.73 + i * 3.79) * 1.2)
function mkv ({ index = true, compressed = false, headerStripped = false, mediaBytes = 1024, subtitleStyle = 'Default' } = {}) {
  const float = Buffer.alloc(8); float.writeDoubleBE(600000)
  const info = master(0x1549a966, [num(0x2ad7b1, 1000000), element(0x4489, float)])
  const tracks = master(0x1654ae6b, [master(0xae, [num(0xd7, 1), num(0x83, 17), text(0x86, 'S_TEXT/ASS'), text(0x22b59c, 'eng'), ...(compressed || headerStripped ? [master(0x6d80, [master(0x6240, [master(0x5034, [num(0x4254, headerStripped ? 3 : 0), ...(headerStripped ? [text(0x4255, '0,0,Default,,0,0,0,,')] : [])])])])] : [])])])
  const clusters = []
  for (let time = 0; time <= 600; time += 10) {
    const blocks = minuteStarts(Math.floor(time / 60)).filter(start => start % 60 >= time % 60 && start % 60 < time % 60 + 10).map((start, i) => {
      const relative = Math.round((start % 10) * 1000)
      const head = Buffer.alloc(4); head[0] = 0x81; head.writeInt16BE(relative, 1)
      const raw = Buffer.from(`${i},0,${subtitleStyle},,0,0,0,,line ${time} ${i}`)
      return master(0xa0, [element(0xa1, Buffer.concat([head, compressed ? deflateSync(raw) : headerStripped ? Buffer.from(`line ${time} ${i}`) : raw])), num(0x9b, 1300)])
    })
    clusters.push(master(0x1f43b675, [num(0xe7, time * 1000), ...blocks, element(0xec, Buffer.alloc(mediaBytes))]))
  }
  const seek = position => master(0x114d9b74, [master(0x4dbb, [element(0x53ab, Buffer.from('1c53bb6b', 'hex')), num(0x53ac, position)])])
  const prefixLength = info.length + tracks.length + (index ? seek(0).length : 0)
  let position = prefixLength
  const cuePoints = clusters.map((cluster, i) => {
    const point = master(0xbb, [num(0xb3, i * 10000), master(0xb7, [num(0xf7, 1), num(0xf1, position)])])
    position += cluster.length
    return point
  })
  const segment = master(0x18538067, [...(index ? [seek(position)] : []), info, tracks, ...clusters, ...(index ? [master(0x1c53bb6b, cuePoints)] : [])])
  return Buffer.concat([master(0x1a45dfa3, []), segment])
}
const playback = { time: 0, duration: 600, buffered: 40, stalled: false }
function storedFile (data) {
  const pieceLength = 1024
  return {
    name: 'fixture.mkv',
    offset: 0,
    length: data.length,
    _torrent: {
      pieceLength,
      lastPieceLength: data.length % pieceLength || pieceLength,
      pieces: Array(Math.ceil(data.length / pieceLength)),
      bitfield: { get: () => true },
      store: { get: (index, { offset, length }, cb) => cb(null, data.subarray(index * pieceLength + offset, index * pieceLength + offset + length)) },
      _select: () => assert.fail('cached file should not request pieces'),
      _selections: [],
      _updateSelections: () => {}
    }
  }
}
for (const options of [{ index: true }, { index: false }, { index: true, compressed: true }, { index: true, headerStripped: true }]) {
  test(`samples future dialogue while playback remains at zero: ${JSON.stringify(options)}`, async () => {
    const sampler = new SubtitleSampler(new Map([['hash0', storedFile(mkv(options))]]))
    const events = []
    await sampler.start({ sessionId: 'session', hash: 'hash', fileId: 0, playback }, event => events.push(event))
    const result = events.at(-1)
    assert.equal(result.reason, 'complete', JSON.stringify(result))
    assert.ok(result.tracks[0].windows.length >= 2, JSON.stringify(result))
    assert.ok(result.tracks[0].windows.some(window => window.start >= 100 && window.cues.length >= 6))
    assert.equal(result.bytesFetched, 0)
    assert.ok(result.tracks[0].windows.flatMap(window => window.cues).every(cue => cue.style === 'Default' && cue.text.startsWith('line')))
  })
}
test('cache-only sampling completes on downloaded media with the reported paused-player reserve', async () => {
  const events = []
  await new SubtitleSampler(new Map([['hash0', storedFile(mkv())]])).start({
    sessionId: 'paused',
    hash: 'hash',
    fileId: 0,
    availableOnly: true,
    playback: { time: 198.637391, duration: 600, buffered: 19.543609, stalled: false }
  }, event => events.push(event))
  const result = events.at(-1)
  assert.equal(result.reason, 'complete')
  assert.equal(result.bytesFetched, 0)
  assert.ok(result.tracks[0].windows.length >= 2)
})
test('cache-only sampling returns an explicit buffer wait for incomplete media', async () => {
  const file = storedFile(mkv())
  file._torrent.bitfield.get = () => false
  const events = []
  await new SubtitleSampler(new Map([['hash0', file]])).start({ sessionId: 'missing', hash: 'hash', fileId: 0, availableOnly: true, playback }, event => events.push(event))
  assert.equal(events.at(-1).reason, 'buffering')
  assert.equal(events.at(-1).bytesFetched, 0)
})
test('opening animation fragments named OPStyle are excluded from sampled references', async () => {
  const events = []
  await new SubtitleSampler(new Map([['hash0', storedFile(mkv({ subtitleStyle: 'OPStyle' }))]])).start({ sessionId: 'opening', hash: 'hash', fileId: 0, playback }, event => events.push(event))
  const result = events.at(-1)
  assert.equal(result.reason, 'complete')
  assert.ok(result.tracks[0].windows.length >= 2)
  assert.ok(result.tracks[0].windows.every(window => window.cues.length === 0))
})
test('skips high bitrate media payload rather than exhausting the parse budget', async () => {
  const events = []
  await new SubtitleSampler(new Map([['hash0', storedFile(mkv({ mediaBytes: 3 * 1024 * 1024 }))]])).start({ sessionId: 'large', hash: 'hash', fileId: 0, playback }, event => events.push(event))
  assert.equal(events.at(-1).reason, 'complete')
  assert.ok(events.at(-1).bytesParsed < 100000)
  assert.equal(events.at(-1).tracks[0].windows.length, 4)
})
test('reports unsupported files explicitly', async () => {
  const events = []
  await new SubtitleSampler(new Map()).start({ sessionId: 'unsupported', hash: 'missing', fileId: 0, playback }, event => events.push(event))
  assert.equal(events.at(-1).reason, 'unsupported')
})

test('pinned scheduler keeps sampler below playback across repeated pipeline fills', async () => {
  const require = createRequire(import.meta.url)
  const torrentRequire = createRequire(require.resolve('torrent-client/package.json'))
  const root = dirname(torrentRequire.resolve('webtorrent'))
  const { default: Torrent } = await import(pathToFileURL(join(root, 'lib/torrent.js')).href)
  const { Selections } = await import(pathToFileURL(join(root, 'lib/selections.js')).href)
  const selections = new Selections()
  selections.insert({ from: 0, to: 0, offset: 0, priority: 1, isStreamSelection: true })
  selections.insert({ from: 0, to: 1, offset: 0, priority: 0, isStreamSelection: false })
  const requested = []
  const torrent = {
    pieceLength: 16384,
    lastPieceLength: 16384,
    pieces: Array(2),
    bitfield: { get: () => false },
    _selections: selections,
    _select: Torrent.prototype._select,
    _updateSelections: () => {},
    _debug: () => {},
    _critical: [],
    wires: [],
    strategy: 'sequential',
    _request: (wire, piece) => { requested.push(piece); wire.requests.push({}); return true }
  }
  const reader = new SubtitleRangeReader({ name: 'fixture.mkv', offset: 0, length: 32768, _torrent: torrent }, playback)
  const pending = reader.read(16384, 1)
  const wire = { requests: [], downloaded: 1, downloadSpeed: () => 1024 * 1024, peerPieces: { get: () => true } }
  try {
    for (let pass = 0; pass < 3; pass++) {
      wire.requests.length = 0
      Torrent.prototype._updateWire.call(torrent, wire)
      assert.equal(selections.get(0).priority, 1)
    }
    assert.ok(requested.length > 0)
    assert.ok(requested.every(piece => piece === 0), 'sampler must not jump ahead when playback fills a pipeline')
    selections.remove({ from: 0, to: 0, isStreamSelection: true })
    requested.length = 0
    wire.requests.length = 0
    Torrent.prototype._updateWire.call(torrent, wire)
    assert.ok(requested.length > 0)
    assert.ok(requested.every(piece => piece === 1), 'sampler must get ahead of priority-zero bulk downloads')
  } finally { reader.cancel(); await assert.rejects(pending, /cancelled/) }
  assert.equal(selections.length, 1)
})

// Exercise actual WebTorrent scheduling and verified storage over a loopback peer.
for (const rate of [0, 32 * 1024]) {
  test(`seeded loopback torrent retiming samples (upload limit ${rate})`, { timeout: 30000 }, async () => {
    const require = createRequire(import.meta.url)
    const torrentRequire = createRequire(require.resolve('torrent-client/package.json'))
    const { default: WebTorrent } = await import(pathToFileURL(torrentRequire.resolve('webtorrent')).href)
    const seeder = new WebTorrent({ dht: false, tracker: false, lsd: false, utp: false })
    const leecher = new WebTorrent({ dht: false, tracker: false, lsd: false, utp: false })
    try {
      if (rate) seeder.throttleUpload(rate)
      const seeded = await new Promise((resolve, reject) => { seeder.once('error', reject); seeder.seed(mkv(), { name: 'fixture.mkv', path: join(temp, `seed-${rate}`), announce: [], pieceLength: 16384 }, resolve) })
      const download = await new Promise((resolve, reject) => { leecher.once('error', reject); leecher.add(seeded.torrentFile, { path: join(temp, `download-${rate}`), announce: [], deselect: true }, resolve) })
      download.addPeer(`127.0.0.1:${seeder.torrentPort}`)
      const sampler = new SubtitleSampler(new Map([['hash0', download.files[0]]]))
      const events = []
      await sampler.start({ sessionId: 'live', hash: 'hash', fileId: 0, playback }, event => events.push(event))
      assert.equal(events.at(-1).reason, 'complete', JSON.stringify(events.at(-1)))
      assert.ok(events.at(-1).tracks[0].windows.some(window => window.start >= 100 && window.cues.length >= 6))
      assert.ok(download._critical.every(value => !value))
      const target = Array.from({ length: 10 }, (_, minute) => minuteStarts(minute).map(start => ({ start: minute * 60 + start - 5, end: minute * 60 + start - 5 + 1.3 }))).flat()
      const result = matchSubtitleWindows(events.at(-1).tracks[0].windows, target)
      assert.equal(result.accepted, true, JSON.stringify(result))
      assert.equal(result.offset, 5)
    } finally {
      await Promise.all([seeder, leecher].map(client => new Promise(resolve => client.destroy(resolve))))
    }
  })
}

await build({ stdin: { contents: "export { default as Metadata } from 'torrent-client/ebml/metadata.ts'; export { EbmlIteratorDecoder, EbmlTagId } from 'torrent-client/ebml/iterator/index.ts'", resolveDir: new URL('..', import.meta.url).pathname }, outfile: join(temp, 'metadata.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
const { Metadata, EbmlIteratorDecoder, EbmlTagId } = await import(pathToFileURL(join(temp, 'metadata.mjs')).href)
test('actual embedded decoder emits structured ASS packets, including split cluster headers', async () => {
  const metadata = Object.assign(Object.create(Metadata.prototype), new EventEmitter(), { tracks: Promise.resolve([]), subtitleTracks: new Map([[1, { type: 'ass', _compressed: false }]]), subtitleReplay: new Map(), timecodeScale: 1 })
  const packets = []
  metadata.on('subtitle', (subtitle, track) => packets.push({ subtitle, track }))
  const blockHead = Buffer.from([0x81, 0, 250, 0])
  const cluster = master(0x1f43b675, [num(0xe7, 5000), master(0xa0, [element(0xa1, Buffer.concat([blockHead, Buffer.from('8,2,Dialogue,Speaker,10,20,30,,Hello, world')])), num(0x9b, 1500)])])
  async function * split () { yield cluster.subarray(0, 2); yield cluster.subarray(2, 7); yield cluster.subarray(7) }
  for await (const chunk of metadata.parseStream(split())) assert.ok(chunk.length)
  await Promise.resolve()
  assert.equal(packets.length, 1)
  assert.deepEqual(packets[0], { track: 1, subtitle: { time: 5250, duration: 1500, readOrder: 8, layer: 2, style: 'Dialogue', name: 'Speaker', marginL: 10, marginR: 20, marginV: 30, effect: '', text: 'Hello, world' } })
  assert.equal(metadata.subtitleReplay.size, 1)
})
test('chapter display master is readable without a data field', async () => {
  const bytes = master(0x1043a770, [master(0x45b9, [master(0xb6, [num(0x91, 1000000000), num(0x92, 2000000000), master(0x80, [text(0x85, 'Chapter'), text(0x437c, 'eng')])])])])
  const chapters = [...new EbmlIteratorDecoder({ bufferTagIds: [EbmlTagId.Chapters] }).parseTags(bytes)][0]
  const metadata = Object.assign(Object.create(Metadata.prototype), { timecodeScale: 1, readSeekHeadTag: async () => chapters })
  assert.deepEqual(await metadata.getChapters(), [{ start: 1000, end: 2000, text: 'Chapter', language: 'eng' }])
})

test('embedded playback reconstructs header stripping and skips unsupported compression', async () => {
  const d = (id, data) => ({ id, data })
  const m = (id, Children) => ({ id, Children })
  const track = (id, algorithm) => m(EbmlTagId.TrackEntry, [d(EbmlTagId.TrackType, 17), d(EbmlTagId.TrackNumber, id), d(EbmlTagId.CodecID, 'S_TEXT/ASS'), m(EbmlTagId.ContentEncodings, [m(EbmlTagId.ContentEncoding, [m(EbmlTagId.ContentCompression, [d(EbmlTagId.ContentCompAlgo, algorithm), d(EbmlTagId.ContentCompSettings, Buffer.from('0,0,Default,,0,0,0,,'))])])])])
  const metadata = Object.assign(Object.create(Metadata.prototype), new EventEmitter(), { readSeekHeadTag: async () => m(EbmlTagId.Tracks, [track(1, 3), track(2, 2)]), subtitleTracks: new Map(), subtitleReplay: new Map() })
  assert.deepEqual((await metadata.getTracks()).map(track => track.number), [1])
  const packets = []
  metadata.on('subtitle', subtitle => packets.push(subtitle))
  await metadata.handleBlockGroup(m(EbmlTagId.BlockGroup, [{ id: EbmlTagId.Block, track: 1, value: 0, payload: Buffer.from('Hello') }, d(EbmlTagId.BlockDuration, 1000)]), 1, 0)
  assert.equal(packets[0].text, 'Hello')
})
test('a corrupt compressed embedded packet does not reject outside the stream', async () => {
  const metadata = Object.assign(Object.create(Metadata.prototype), new EventEmitter(), { tracks: Promise.resolve([]), subtitleTracks: new Map([[1, { type: 'ass', _compressed: true }]]), subtitleReplay: new Map(), timecodeScale: 1 })
  const cluster = master(0x1f43b675, [num(0xe7, 5000), master(0xa0, [element(0xa1, Buffer.concat([Buffer.from([0x81, 0, 0, 0]), Buffer.from('not zlib')])), num(0x9b, 1500)])])
  const warnings = []
  const warn = console.warn
  console.warn = (...args) => warnings.push(args)
  try {
    async function * source () { yield cluster }
    for await (const chunk of metadata.parseStream(source())) assert.ok(chunk.length)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(warnings.length, 1)
  } finally { console.warn = warn }
})

test.after(async () => { hooks.deregister(); await rm(temp, { recursive: true, force: true }) })
