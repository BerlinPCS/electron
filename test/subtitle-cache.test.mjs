import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { SubtitleCache } from '../src/main/torrent/subtitle-cache.ts'

test('original files persist per video and follow torrent deletion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'subtitle-cache-'))
  try {
    const files = new Map([['hash0', {}], ['hash1', {}]])
    const cache = new SubtitleCache(root, files)
    const subtitle = { name: '../Japanese.ass', source: 'jimaku', rank: 0, text: '[Script Info]\noriginal timing' }
    await cache.put('hash', 0, subtitle)
    assert.deepEqual(await new SubtitleCache(root, files).list('hash', 0), [{ ...subtitle, profile: undefined }])
    assert.deepEqual(await cache.list('hash', 1), [])
    assert.ok((await readdir(join(root, '.hayatan-subtitles/hash/0'))).some(name => name.endsWith('.ass')))
    await assert.rejects(cache.put('../outside', 0, subtitle))
    await cache.remove('hash')
    assert.deepEqual(await cache.list('hash', 0), [])
    await Promise.all([cache.put('hash', 0, subtitle), cache.remove('hash')])
    assert.deepEqual(await cache.list('hash', 0), [])
    files.clear()
    await cache.put('hash', 0, subtitle)
    assert.deepEqual(await cache.list('hash', 0), [])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('deleting one download folder does not remove retained sidecars in another', async () => {
  const base = await mkdtemp(join(tmpdir(), 'subtitle-cache-roots-'))
  const first = join(base, 'first')
  const second = join(base, 'second')
  const files = new Map([['hash0', {}]])
  const subtitle = { name: 'Japanese.ass', source: 'local', rank: 0, text: '[Script Info]' }
  const cache = new SubtitleCache(first, files)
  try {
    await cache.put('hash', 0, subtitle)
    cache.setRoot(second)
    await cache.put('hash', 0, subtitle)
    await cache.remove('hash')
    assert.deepEqual(await cache.list('hash', 0), [])
    cache.setRoot(first)
    assert.equal((await cache.list('hash', 0)).length, 1)
    // A currently playing torrent can still belong to the previous folder.
    cache.setRoot(second)
    await cache.remove('hash', first)
    cache.setRoot(first)
    assert.deepEqual(await cache.list('hash', 0), [])
  } finally { await rm(base, { recursive: true, force: true }) }
})

test('cleanup checks the captured library root and preserves failed removals', async () => {
  const base = await mkdtemp(join(tmpdir(), 'subtitle-cache-deletion-'))
  const first = join(base, 'first')
  const second = join(base, 'second')
  const cache = new SubtitleCache(first, new Map([['retained0', {}], ['deleted0', {}]]))
  const subtitle = { name: 'Japanese.ass', source: 'local', rank: 0, text: '[Script Info]' }
  try {
    await cache.put('retained', 0, subtitle)
    await cache.put('deleted', 0, subtitle)
    await mkdir(join(first, 'hayase-cache'))
    await writeFile(join(first, 'hayase-cache', 'retained'), 'manifest')
    cache.setRoot(second)
    await cache.removeDeleted(['retained', 'deleted'], first)
    cache.setRoot(first)
    assert.equal((await cache.list('retained', 0)).length, 1)
    assert.deepEqual(await cache.list('deleted', 0), [])
  } finally { await rm(base, { recursive: true, force: true }) }
})
