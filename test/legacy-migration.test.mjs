import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  applyPendingHayaseMigration,
  getHayaseMigrationState,
  migrateImportedHayaseExtensionStorage,
  migrateImportedHayaseLocalStorage,
  scheduleHayaseMigration
} from '../src/main/legacy-migration.ts'

test('detects a pre-mining Hayase profile and replaces compatible Hayatan data', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'hayatan-migration-')))
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
  await writeFile(join(legacy, 'lockfile'), 'stale-hayase-lock')
  await writeFile(join(current, 'settings.json'), '{"torrentPath":"fresh"}')
  await writeFile(join(current, 'IndexedDB', 'profile.data'), 'fresh-profile')
  await writeFile(join(current, 'Cache', 'keep.data'), 'hayatan-cache')
  await writeFile(join(current, 'Session Storage', 'stale.data'), 'hayatan-session')
  await writeFile(join(current, 'lockfile'), 'live-hayatan-lock')

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
  let migratedOrigin
  assert.equal(await migrateImportedHayaseLocalStorage(current, async origin => {
    migratedOrigin = origin
  }), true)
  assert.equal(migratedOrigin, 'https://hayase.app')
  assert.equal(await migrateImportedHayaseLocalStorage(current, async () => {
    throw new Error('already migrated')
  }), false)
  let migratedExtensionOrigin
  assert.equal(await migrateImportedHayaseExtensionStorage(current, async origin => {
    migratedExtensionOrigin = origin
  }), true)
  assert.equal(migratedExtensionOrigin, 'https://hayase.app')
  assert.equal(await migrateImportedHayaseExtensionStorage(current, async () => {
    throw new Error('already migrated')
  }), false)

  assert.equal(await readFile(join(current, 'settings.json'), 'utf8'), '{"torrentPath":"日本語"}')
  assert.equal(await readFile(join(current, 'Cookies'), 'utf8'), 'hayase-cookies')
  assert.equal(await readFile(join(current, 'IndexedDB', 'profile.data'), 'utf8'), 'hayase-profile')
  assert.equal(await readFile(join(current, 'Cache', 'keep.data'), 'utf8'), 'hayatan-cache')
  assert.equal(await readFile(join(current, 'lockfile'), 'utf8'), 'live-hayatan-lock')
  await assert.rejects(stat(join(current, 'Cache', 'discard.data')))
  await assert.rejects(stat(join(current, 'Session Storage', 'stale.data')))
  assert.equal(await readFile(join(legacy, 'settings.json'), 'utf8'), '{"torrentPath":"日本語"}')
  const marker = JSON.parse(await readFile(join(current, '.hayase-import.json'), 'utf8'))
  assert.equal(marker.source, legacy)
  assert.equal(typeof marker.localStorageMigratedAt, 'string')
  assert.equal(typeof marker.extensionStorageMigratedAt, 'string')
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

test('development and installed profiles consume only their own pending imports', async t => {
  const root = await mkdtemp(join(tmpdir(), 'hayatan-migration-isolation-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const legacy = join(root, 'hayase')
  const main = { currentUserData: join(root, 'hayatan'), appData: root }
  const dev = { currentUserData: join(root, 'Hayatan Dev'), appData: root, development: true }
  await mkdir(legacy, { recursive: true })
  await mkdir(main.currentUserData, { recursive: true })
  await mkdir(dev.currentUserData, { recursive: true })
  await writeFile(join(legacy, 'settings.json'), '{"marker":"legacy"}')
  await writeFile(join(main.currentUserData, 'settings.json'), '{"marker":"main"}')
  await writeFile(join(dev.currentUserData, 'settings.json'), '{"marker":"dev"}')

  assert.equal(await scheduleHayaseMigration(main), true)
  assert.equal(await applyPendingHayaseMigration(dev), false)
  assert.equal(await readFile(join(dev.currentUserData, 'settings.json'), 'utf8'), '{"marker":"dev"}')
  assert.equal(await applyPendingHayaseMigration(main), true)

  assert.equal(await scheduleHayaseMigration(dev), true)
  assert.equal(await applyPendingHayaseMigration(main), false)
  assert.equal(await applyPendingHayaseMigration(dev), true)

  // Simultaneous requests must coexist rather than overwrite or consume one another.
  await scheduleHayaseMigration(main)
  await scheduleHayaseMigration(dev)
  assert.equal(await applyPendingHayaseMigration(dev), true)
  assert.equal(await applyPendingHayaseMigration(main), true)
})
