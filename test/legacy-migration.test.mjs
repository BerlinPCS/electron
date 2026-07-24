import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  applyPendingHayaseMigration,
  getHayaseMigrationState,
  scheduleHayaseMigration
} from '../src/main/legacy-migration.ts'

test('detects a pre-mining Hayase profile and replaces compatible Hayatan data', async t => {
  const root = await mkdtemp(join(tmpdir(), 'hayatan-migration-'))
  t.after(() => rm(root, { recursive: true, force: true }))

  const legacy = join(root, 'hayase')
  const current = join(root, 'hayatan')
  await mkdir(join(legacy, 'IndexedDB'), { recursive: true })
  await mkdir(join(legacy, 'Cache'), { recursive: true })
  await mkdir(join(current, 'IndexedDB'), { recursive: true })
  await mkdir(join(current, 'Cache'), { recursive: true })
  await mkdir(join(current, 'Session Storage'), { recursive: true })
  await writeFile(join(legacy, 'settings.json'), '{"torrentPath":"日本語"}')
  await writeFile(join(legacy, 'Cookies'), 'hayase-cookies')
  await writeFile(join(legacy, 'IndexedDB', 'profile.data'), 'hayase-profile')
  await writeFile(join(legacy, 'Cache', 'discard.data'), 'hayase-cache')
  await writeFile(join(current, 'settings.json'), '{"torrentPath":"fresh"}')
  await writeFile(join(current, 'IndexedDB', 'profile.data'), 'fresh-profile')
  await writeFile(join(current, 'Cache', 'keep.data'), 'hayatan-cache')
  await writeFile(join(current, 'Session Storage', 'stale.data'), 'hayatan-session')

  assert.deepEqual(await getHayaseMigrationState({
    currentUserData: current,
    appData: root
  }), {
    available: true,
    source: legacy
  })
  assert.equal(await scheduleHayaseMigration({
    currentUserData: current,
    appData: root
  }), true)
  assert.equal(await applyPendingHayaseMigration({
    currentUserData: current,
    appData: root
  }), true)

  assert.equal(await readFile(join(current, 'settings.json'), 'utf8'), '{"torrentPath":"日本語"}')
  assert.equal(await readFile(join(current, 'Cookies'), 'utf8'), 'hayase-cookies')
  assert.equal(await readFile(join(current, 'IndexedDB', 'profile.data'), 'utf8'), 'hayase-profile')
  assert.equal(await readFile(join(current, 'Cache', 'keep.data'), 'utf8'), 'hayatan-cache')
  await assert.rejects(stat(join(current, 'Cache', 'discard.data')))
  await assert.rejects(stat(join(current, 'Session Storage', 'stale.data')))
  assert.equal(await readFile(join(legacy, 'settings.json'), 'utf8'), '{"torrentPath":"日本語"}')
  assert.equal(JSON.parse(await readFile(join(current, '.hayase-import.json'), 'utf8')).source, legacy)
  await assert.rejects(stat(join(root, '.hayatan-hayase-import.json')))
})

test('does not schedule an import when no Hayase profile exists', async t => {
  const root = await mkdtemp(join(tmpdir(), 'hayatan-migration-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const paths = {
    currentUserData: join(root, 'Hayatan'),
    appData: root
  }

  assert.deepEqual(await getHayaseMigrationState(paths), { available: false })
  assert.equal(await scheduleHayaseMigration(paths), false)
  assert.equal(await applyPendingHayaseMigration(paths), false)
})
