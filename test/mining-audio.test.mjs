import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import {
  isAllowedAudioTarget,
  LOCAL_SOURCE_TEMPLATE,
  localAudioResponse,
  MiningAudioRepository,
  resolveLocalAudio
} from '../src/main/mining-audio.ts'

test('only allows expanded requests from configured audio templates', () => {
  const target = 'https://example.test/audio?term=%E9%A3%9F%E3%81%B9%E3%82%8B&reading=%E3%81%9F%E3%81%B9%E3%82%8B'
  assert.equal(isAllowedAudioTarget(target, [
    'https://example.test/audio?term={term}&reading={reading}'
  ]), true)
  assert.equal(isAllowedAudioTarget('https://attacker.test/audio', [
    'https://example.test/audio?term={term}&reading={reading}'
  ]), false)
})

test('local resolution matches reading quality before provider order', () => {
  const result = resolveLocalAudio('食べる', 'たべる', [
    { source: 'nhk16', expression: '食べる', reading: 'たべない', file: 'audio/wrong.mp3' },
    { source: 'forvo', expression: '食べる', reading: 'たべる', file: 'audio/right.opus' }
  ], ['nhk16', 'forvo'])
  assert.equal(result?.source, 'forvo')
})

test('serves byte ranges for local audio playback', async () => {
  const response = localAudioResponse(Buffer.from('0123456789'), 'word.mp3', 'bytes=2-5')
  assert.equal(response.status, 206)
  assert.equal(response.headers.get('content-type'), 'audio/mpeg')
  assert.equal(response.headers.get('content-range'), 'bytes 2-5/10')
  assert.equal(await response.text(), '2345')
})

test('resolves Yomitan JSON audio source responses', async t => {
  const previousFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = previousFetch })
  globalThis.fetch = async () => {
    const response = new Response(JSON.stringify({
      type: 'audioSourceList',
      audioSources: [{ name: 'Test', url: 'https://cdn.test/word.mp3' }]
    }), { headers: { 'Content-Type': 'application/json' } })
    Object.defineProperty(response, 'url', { value: 'https://source.test/audio' })
    return response
  }
  const repository = new MiningAudioRepository(join(tmpdir(), 'unused-mining-audio'))
  assert.equal(
    await repository.resolveSource(
      'https://source.test/?term=%E9%A3%9F&reading=%E3%81%97%E3%82%87%E3%81%8F',
      ['https://source.test/?term={term}&reading={reading}']
    ),
    'https://cdn.test/word.mp3'
  )
})

test('imports Android audio databases, orders providers, resolves, and reads blobs', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'hayase-mining-audio-'))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const sourcePath = join(temporary, 'source.db')
  const database = new DatabaseSync(sourcePath)
  database.exec(`
    CREATE TABLE entries (source TEXT, expression TEXT, reading TEXT, file TEXT);
    CREATE TABLE android (source TEXT, file TEXT, data BLOB);
  `)
  database.prepare('INSERT INTO entries VALUES (?, ?, ?, ?)').run('forvo', '食べる', 'たべる', 'audio/forvo.mp3')
  database.prepare('INSERT INTO entries VALUES (?, ?, ?, ?)').run('nhk16', '食べる', 'たべる', 'audio/nhk.opus')
  database.prepare('INSERT INTO android VALUES (?, ?, ?)').run('nhk16', 'audio/nhk.opus', Buffer.from('opus-data'))
  database.close()

  const repository = new MiningAudioRepository(join(temporary, 'private'))
  const imported = await repository.importDatabase(sourcePath)
  assert.equal(imported.available, true)
  assert.deepEqual(imported.sourceOrder, ['nhk16', 'forvo'])

  const target = LOCAL_SOURCE_TEMPLATE
    .replace('{term}', encodeURIComponent('食べる'))
    .replace('{reading}', encodeURIComponent('たべる'))
  const resolved = await repository.resolveSource(target, [LOCAL_SOURCE_TEMPLATE])
  assert.match(resolved ?? '', /^hayase-local-audio:\/\/audio/)
  assert.equal(new URL(resolved).searchParams.get('source'), 'nhk16')
  assert.deepEqual(await repository.loadLocalAudio('nhk16', 'audio/nhk.opus'), Buffer.from('opus-data'))

  const reordered = await repository.reorderSources(['forvo', 'nhk16'])
  assert.deepEqual(reordered.sourceOrder, ['forvo', 'nhk16'])
  assert.equal(new URL(await repository.resolveSource(target, [LOCAL_SOURCE_TEMPLATE])).searchParams.get('source'), 'forvo')
})
