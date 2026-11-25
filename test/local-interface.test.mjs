import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { localInterfaceAsset } from '../src/main/local-interface.ts'

test('bundled interface serves assets and routes without leaking files or stale assets', async t => {
  const root = await mkdtemp(join(tmpdir(), 'hayatan-interface-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, '_app'))
  await writeFile(join(root, 'index.html'), '<html></html>')
  await writeFile(join(root, '_app', 'player.js'), 'export {}')
  const url = (/** @type {string} */ path) => 'https://hayatan.example' + path
  assert.equal(await localInterfaceAsset(root, url('/')), join(root, 'index.html'))
  assert.equal(await localInterfaceAsset(root, url('/app/player')), join(root, 'index.html'))
  assert.equal(await localInterfaceAsset(root, url('/_app/player.js?v=2')), join(root, '_app', 'player.js'))
  assert.equal(await localInterfaceAsset(root, url('/_app/old.js')), undefined)
  assert.equal(await localInterfaceAsset(root, url('/_app/missing')), undefined)
  assert.equal(await localInterfaceAsset(root, url('/%2e%2e%2fsecret.txt')), undefined)
  assert.equal(await localInterfaceAsset(root, url('/%invalid')), undefined)
})
