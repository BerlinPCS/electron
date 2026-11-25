import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { proxy, wrap } from 'abslink'

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

test('dedicated subprocess survives repeated episode callback releases', { timeout: 10000 }, async t => {
  const worker = new DedicatedTorrentProcess(fixture, process.env.HAYATAN_TEST_TORRENT_RUNTIME ?? process.execPath)
  t.after(() => worker.kill())
  worker.stderr?.resume()
  await once(worker, 'spawn')
  for (let reload = 0; reload < 2; reload++) {
    const port = new Port()
    worker.postMessage({ id: 'rpc' }, [port])
    const remote = wrap({
      on: (_name, listener) => { port.on('reply', listener) },
      off: (_name, listener) => { port.off('reply', listener) },
      postMessage: data => { port.emit('message', { data }) },
      close: () => port.close()
    })
    for (let episode = 1; episode <= 25; episode++) {
      let received
      assert.equal(await remote.episode(proxy((/** @type {number} */ value) => { received = value }), episode), episode)
      assert.equal(received, episode)
      assert.deepEqual(await remote.metadata(), new Uint8Array([0, 128, 255]))
      assert.deepEqual(await remote.stats(), { seeders: 3, downloaded: 1024 })
    }
    port.close()
  }
  const exited = once(worker, 'exit')
  worker.postMessage({ id: 'destroy' })
  assert.equal((await exited)[0], 0)
})
