import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

import ts from 'typescript'

const require = createRequire(import.meta.url)
const compile = path => ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const bootstrap = compile('../src/main/development-profile.ts')
const entry = compile('../src/main/index.ts')

for (const packaged of [false, true]) {
  test(`profile initialization precedes stores and instance lock (packaged=${packaged})`, () => {
    const root = mkdtempSync(join(tmpdir(), 'hayatan-profile-test-'))
    const original = join(root, 'Hayatan')
    const paths = { appData: root, userData: original, sessionData: original }
    const observations = []
    let name = 'Hayatan'
    const app = {
      isPackaged: packaged,
      getPath: key => paths[key],
      setPath: (key, value) => { paths[key] = value },
      setName: value => { name = value },
      setAppLogsPath: value => { paths.logs = value },
      requestSingleInstanceLock: () => { observations.push(paths.userData); return false },
      quit: () => {}
    }
    const mockRequire = specifier => {
      if (specifier === 'electron') return { app }
      if (specifier === './development-profile.ts') { runInNewContext(bootstrap, { require: mockRequire, exports: {} }); return {} }
      if (specifier === './store.ts') { observations.push(paths.userData); return {} }
      if (specifier === './app.ts' || specifier === './legacy-migration.ts' || specifier === '@electron-toolkit/utils') return {}
      return require(specifier)
    }
    try {
      runInNewContext(entry, { require: mockRequire, exports: {} })
      const expected = packaged ? original : join(root, 'Hayatan Dev')
      assert.deepEqual(observations, [expected, expected])
      assert.equal(paths.sessionData, expected)
      assert.equal(name, packaged ? 'Hayatan' : 'Hayatan Dev')
      assert.equal(paths.logs, packaged ? undefined : join(expected, 'logs'))
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
}

test('dedicated runtime resolves dev and packaged identities and never silently falls back', () => {
  const source = compile('../src/main/torrent/process.ts')
  for (const packaged of [false, true]) {
    const exports = {}
    let exists = true
    const mockRequire = specifier => {
      if (specifier === 'electron') return { app: { isPackaged: packaged, getAppPath: () => '/project' }, utilityProcess: { fork: () => assert.fail('must not fall back') } }
      if (specifier === 'node:fs') return { existsSync: () => exists }
      if (specifier === './supervisor.ts') return { DedicatedTorrentProcess: null }
      return require(specifier)
    }
    runInNewContext(source, { require: mockRequire, exports, process: { platform: 'darwin', resourcesPath: '/installed/Resources' } })
    assert.equal(exports.torrentExecutable(), packaged
      ? '/installed/Resources/torrent-runtime/Hayatan Torrent.app/Contents/MacOS/Hayatan Torrent'
      : '/project/.sidecar-build/torrent-runtime/Hayatan Torrent Dev.app/Contents/MacOS/Hayatan Torrent Dev')
    assert.equal(exports.torrentRuntimeAvailable(), true)
    exists = false
    assert.throws(() => exports.startTorrentProcess('worker.js', true), packaged ? /Reinstall Hayatan/ : /prepare:torrent-runtime/)
  }
})

test('development leaves the installed application protocol registration untouched', () => {
  const source = compile('../src/main/protocol.ts')
  for (const packaged of [false, true]) {
    const registrations = []
    const exports = {}
    const app = { isPackaged: packaged, setAsDefaultProtocolClient: (...args) => registrations.push(args), on: () => {} }
    runInNewContext(source, {
      require: specifier => specifier === 'electron' ? { app, shell: {} } : require(specifier),
      exports,
      process: { defaultApp: !packaged, argv: ['electron', '/dev/app'], execPath: '/electron' }
    })
    assert.deepEqual(registrations.map(args => [...args]), packaged ? [['hayatan']] : [])
    const navigations = []
    const Protocol = exports.default
    const protocol = new Protocol({ webContents: { send: (...args) => navigations.push(args) } })
    protocol.handleProtocol('hayatan://schedule/')
    assert.equal(navigations.length, 1)
    assert.equal(navigations[0][1].target, 'schedule')
  }
})
