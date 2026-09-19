// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- Dynamic binary fixtures and deliberately partial native test doubles.
// @ts-nocheck
import assert from 'node:assert/strict'
import test from 'node:test'

import { SubtitleRangeReader } from '../src/main/torrent/subtitle-range-reader.ts'

const context = { time: 0, duration: 500, buffered: 40, stalled: false }
function fixture (available = true) {
  const selected = []
  const calls = []
  let ready = available
  const torrent = {
    pieceLength: 16,
    lastPieceLength: 16,
    pieces: Array(4),
    bitfield: { get: () => ready },
    store: { get: (_, { length }, cb) => cb(null, new Uint8Array(length)) },
    _select: (from, to, priority, notify, isStreamSelection) => { calls.push({ from, to, priority }); selected.push({ from, to, priority, notify, isStreamSelection }); ready = true },
    _selections: { sort: compare => selected.sort(compare), * [Symbol.iterator] () { for (const item of [...selected]) yield { ...item, remove: () => selected.splice(selected.indexOf(item), 1) } } },
    _updateSelections: () => {},
    critical: () => assert.fail('must not mark pieces critical')
  }
  return { file: { name: 'episode.mkv', length: 64, offset: 0, _torrent: torrent }, calls, selected }
}
test('reads cached data without downloads even while playback is starved', async () => {
  const { file, calls } = fixture()
  const reader = new SubtitleRangeReader(file, { ...context, buffered: 0, stalled: true })
  assert.equal((await reader.read(0, 20)).length, 20)
  assert.equal(calls.length, 0)
  assert.equal(reader.bytesFetched, 0)
})
test('low-priority reads preserve overlapping playback and normal download selections', async () => {
  const { file, calls, selected } = fixture(false)
  const playback = { from: 0, to: 0, priority: 1, isStreamSelection: true }
  const download = { from: 0, to: 3, priority: 0 }
  selected.push(playback, download)
  const reader = new SubtitleRangeReader(file, context)
  await reader.read(0, 10)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].priority, 0)
  assert.equal(reader.bytesFetched, 16)
  reader.cancel()
  assert.deepEqual(selected, [playback, download])
})
test('starvation suspends requests until 30 seconds are buffered', async () => {
  const { file, calls } = fixture(false)
  const reader = new SubtitleRangeReader(file, { ...context, buffered: 0 })
  const result = reader.read(0, 10)
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(calls.length, 0)
  reader.update({ ...context, buffered: 20 })
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(calls.length, 0)
  reader.update(context)
  await result
  assert.equal(calls.length, 1)
})
test('counts whole pieces, caps parsing, and terminates on cancel/deadline', async () => {
  const { file, calls } = fixture(false)
  const reader = new SubtitleRangeReader(file, context, { download: 15, parse: 100, timeout: 1000 })
  await assert.rejects(reader.read(0, 1), /budget/)
  assert.equal(calls.length, 0)
  const parsing = new SubtitleRangeReader(file, context, { download: 100, parse: 5, timeout: 1000 })
  await assert.rejects(parsing.read(0, 6), /budget/)
  const cancelled = new SubtitleRangeReader(file, { ...context, buffered: 0 })
  const pending = cancelled.read(0, 1)
  cancelled.cancel()
  await assert.rejects(pending, /cancelled/)
  const deadline = new SubtitleRangeReader(file, { ...context, buffered: 0 }, { download: 100, parse: 100, timeout: 20 })
  await assert.rejects(deadline.read(0, 1), /timeout/)
})

test('unknown custom buffer suspends downloads even with a live open-ended playback selection', async () => {
  const { file, calls, selected } = fixture(false)
  let sampleReady = false
  file._torrent.bitfield.get = index => index === 0 ? true : sampleReady
  selected.push({ from: 0, to: 3, offset: 0, priority: 1, isStreamSelection: true })
  const select = file._torrent._select
  file._torrent._select = (...args) => { select(...args); sampleReady = true }
  const reader = new SubtitleRangeReader(file, { ...context, buffered: null })
  const pending = reader.read(16, 4)
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(calls.length, 0)
  // A verified leading piece and a selected range do not quantify buffer time.
  reader.update({ ...context, buffered: 20 })
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(calls.length, 0)
  reader.update(context)
  await pending
  assert.equal(calls.length, 1)
  assert.equal(selected.length, 1)
})

test('store callbacks cannot exceed the deadline or revive cancelled reads', async () => {
  const { file } = fixture()
  let callback
  file._torrent.store.get = (_piece, _range, cb) => { callback = cb }
  const deadline = new SubtitleRangeReader(file, context, { download: 100, parse: 100, timeout: 25 })
  await assert.rejects(deadline.read(0, 1), /timeout/)
  callback(null, new Uint8Array(1))
  const cancelled = new SubtitleRangeReader(file, context)
  const pending = cancelled.read(0, 1)
  cancelled.cancel()
  await assert.rejects(pending, /cancelled/)
  callback(null, new Uint8Array(1))
})

test('cache-only pass reads verified pieces but returns buffering without selecting missing pieces', async () => {
  const { file, calls } = fixture(true)
  file._torrent.bitfield.get = piece => piece === 0
  const reader = new SubtitleRangeReader(file, { ...context, buffered: 19.543609 }, undefined, true)
  assert.equal((await reader.read(0, 10)).length, 10)
  reader.update(context)
  await assert.rejects(reader.read(16, 10), error => error.reason === 'buffering')
  assert.equal(reader.bytesFetched, 0)
  assert.equal(calls.length, 0)
  reader.cancel()
})

test('starting with 19 seconds buffered cannot select new sample pieces until reserve recovers', async () => {
  const { file, calls } = fixture(false)
  const reader = new SubtitleRangeReader(file, { ...context, buffered: 19.543609 })
  const pending = reader.read(0, 10)
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(calls.length, 0)
  reader.update(context)
  await pending
  assert.equal(calls.length, 1)
  reader.cancel()
})
