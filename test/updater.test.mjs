import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import test from 'node:test'

import { transformSync } from 'esbuild'

const require = createRequire(import.meta.url)
const { code } = transformSync(readFileSync(new URL('../src/main/updater.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'cjs' })

function fixture ({ platform = 'darwin', configured = true, available = false, failure = false } = {}) {
  let checks = 0
  let timer
  const updater = {
    autoDownload: true,
    isUpdaterActive: () => true,
    on: () => undefined,
    async checkForUpdates () {
      checks++
      if (failure) throw new Error('Offline')
      return { isUpdateAvailable: available, updateInfo: { version: '7.1.5' }, downloadPromise: Promise.resolve() }
    }
  }
  const module = { exports: {} }
  runInNewContext(code, {
    module, exports: module.exports,
    require: name => name === 'electron-updater' ? { autoUpdater: updater } : name === 'node:fs' ? { existsSync: () => configured } : require(name),
    process: { platform, resourcesPath: '/app/resources' },
    setInterval: callback => { timer = callback; return { unref () {} } }
  })
  const instance = new module.exports.default()
  return { instance, updater, checks: () => checks, tick: () => timer?.() }
}

test('unpacked local builds do not start failing background checks', async () => {
  const f = fixture({ configured: false })
  assert.equal(f.checks(), 0)
  await assert.rejects(f.instance.ready(), /local build has no update feed/)
})

test('current releases report no update', async () => {
  const f = fixture()
  await assert.rejects(f.instance.ready(), /No update available/)
})

test('Windows releases retain automatic download and readiness', async () => {
  const f = fixture({ platform: 'win32', available: true })
  assert.equal(f.updater.autoDownload, true)
  await f.instance.ready()
})

test('offline background checks are handled; explicit checks report the failure', async () => {
  const f = fixture({ failure: true })
  f.tick()
  await assert.rejects(f.instance.check(), /Offline/)
  await new Promise(resolve => setImmediate(resolve))
})
