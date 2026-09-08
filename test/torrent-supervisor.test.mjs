import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { DedicatedTorrentProcess } from '../src/main/torrent/supervisor.ts'
const fixture = fileURLToPath(new URL('./fixtures/torrent-child.mjs', import.meta.url))
class Port extends EventEmitter {
  start () {}
  /** @param {unknown} data */
  postMessage (data) { this.emit('reply', data) }
  close () { this.emit('close') }
}

test('dedicated subprocess bridges actual IPC, renderer reload, and shutdown', { timeout: 10000 }, async t => {
  const worker = new DedicatedTorrentProcess(fixture, process.execPath)
  t.after(() => worker.kill())
  worker.stderr?.resume()
  await once(worker, 'spawn')
  for (let i = 0; i < 2; i++) {
    const port = new Port()
    worker.postMessage({ id: 'settings' }, [port])
    const reply = once(port, 'reply')
    port.emit('message', { data: new Uint8Array([i, 255]) })
    assert.deepEqual((await reply)[0], new Uint8Array([i, 255]))
    port.close()
  }
  const exited = once(worker, 'exit')
  worker.postMessage({ id: 'destroy' })
  assert.equal((await exited)[0], 0)
})

test('failure to spawn reports exit instead of waiting forever', { timeout: 3000 }, async () => {
  const worker = new DedicatedTorrentProcess(fixture, '/nonexistent/hayatan-torrent-runtime')
  assert.notEqual((await once(worker, 'exit'))[0], 0)
})
