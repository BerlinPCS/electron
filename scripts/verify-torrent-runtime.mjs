// node scripts/verify-torrent-runtime.mjs /path/to/packaged/Resources
// Windows: pass the packaged resources directory. No torrents are downloaded.
import assert from 'node:assert/strict'
import { execFileSync, fork } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const resources = resolve(process.argv[2] ?? '')
if (!process.argv[2]) throw new Error('Pass the packaged resources directory')
const runtime = process.platform === 'darwin'
  ? join(resources, 'torrent-runtime', 'Hayatan Torrent.app', 'Contents', 'MacOS', 'Hayatan Torrent')
  : join(resources, '..', 'Hayatan Torrent.exe')
const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ELECTRON_RUN_AS_NODE: '1' }
const main = join(resources, 'app.asar', 'out', 'main')
const bundle = execFileSync(runtime, ['-e', `console.log(require('fs').readdirSync(${JSON.stringify(main)}).find(x => /^background-.*\\.js$/.test(x)))`], { env, encoding: 'utf8' }).trim()
assert.match(bundle, /^background-.*\.js$/)
const directory = mkdtempSync(join(tmpdir(), 'hayatan-torrent-smoke-'))
const child = fork(join(main, bundle), [], { execPath: runtime, execArgv: [], env, serialization: 'advanced', stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
child.stdout?.resume()
child.stderr?.on('data', data => process.stderr.write(data))
const timer = setTimeout(() => child.kill(), 15000)
let verified = false
child.on('message', raw => {
  const packet = /** @type {{ kind: string, data: { id: string, value: unknown } }} */ (raw)
  if (packet.kind === 'ready') {
    child.send({ kind: 'control', ports: [1], data: { id: 'settings', data: {
      path: directory, torrentDHT: true, torrentPeX: true, torrentSpeed: 1,
      maxConns: 1, torrentPort: 0, dhtPort: 0
    } } })
    child.send({ kind: 'port', port: 1, data: { id: 'smoke', type: 'APPLY', path: ['library'], argumentList: [] } })
  }
  if (packet.kind === 'port') {
    assert.equal(packet.data.id, 'smoke')
    assert.deepEqual(packet.data.value, [])
    verified = true
    child.send({ kind: 'control', data: { id: 'destroy' } })
  }
})
try {
  const [code] = await once(child, 'exit')
  assert.equal(code, 0)
  assert.equal(verified, true)
  console.log('Packaged torrent runtime: startup, native engine, IPC and shutdown passed.')
} finally {
  clearTimeout(timer)
  child.kill()
  rmSync(directory, { recursive: true, force: true })
}
