import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { serialize, deserialize } from 'node:v8'

import { expose, wrap, proxy, releaseProxy } from 'abslink'

import { childTransport } from '../src/main/torrent/transport.ts'
/** @param {unknown} value */
// Exercise the same advanced serialization used on the real inherited pipe.
const clone = value => deserialize(serialize(value))

test('torrent pipe carries binary results, callbacks and remote errors', async () => {
  const endpoint = Object.assign(new EventEmitter(), { postMessage: (/** @type {unknown} */ data) => { return data } })
  const child = childTransport(packet => queueMicrotask(() => endpoint.emit('message', clone(packet.data))))
  endpoint.postMessage = data => queueMicrotask(() => child.receive(clone({ kind: 'port', port: 1, data })))
  child.parent.on('message', ({ ports }) => {
    const port = ports[0]
    expose({
      binary: () => new Uint8Array([0, 128, 255]),
      callback: async (/** @type {(value: string) => Promise<void>} */ notify) => { await notify('torrent'); return 'done' },
      fail: () => { throw new Error('expected failure') }
    }, {
      on: (name, fn) => port.on(name, /** @param {{ data: unknown }} event */ event => fn(event.data)),
      off: () => {},
      postMessage: data => port.postMessage(data)
    })
  })
  child.receive({ kind: 'control', ports: [1], data: { id: 'settings' } })
  const remote = wrap(endpoint)
  assert.deepEqual(await remote.binary(), new Uint8Array([0, 128, 255]))
  let received
  assert.equal(await remote.callback(proxy((/** @type {string} */ value) => { received = value })), 'done')
  assert.equal(received, 'torrent')
  await assert.rejects(remote.fail(), /expected failure/)
})

test('reloading a renderer gives an independent channel and closes old channels', () => {
  /** @type {import('../src/main/torrent/transport.ts').Packet[]} */
  const sent = []
  const child = childTransport(packet => sent.push(packet))
  /** @type {import('../src/main/torrent/transport.ts').PipePort[]} */
  const attached = []
  child.parent.on('message', ({ ports }) => attached.push(...ports))
  child.receive({ kind: 'control', ports: [1] })
  child.receive({ kind: 'control', ports: [2] })
  /** @type {unknown[]} */
  const seen = []
  attached[0]?.on('message', /** @param {{ data: unknown }} event */ event => seen.push(['old', event.data]))
  attached[1]?.on('message', /** @param {{ data: unknown }} event */ event => seen.push(['new', event.data]))
  child.receive({ kind: 'close', port: 1 })
  child.receive({ kind: 'port', port: 1, data: 'ignored' })
  child.receive({ kind: 'port', port: 2, data: 'current' })
  attached[1]?.postMessage(new Uint8Array([7]))
  assert.deepEqual(seen, [['new', 'current']])
  assert.deepEqual(sent, [{ kind: 'port', port: 2, data: new Uint8Array([7]) }])
})

test('releasing episode callbacks keeps root requests alive on a shared pipe', { timeout: 3000 }, async () => {
  const { expose: exposePort, wrap: wrapPort } = await import('abslink/w3c')
  let physicalCloses = 0
  const endpoint = Object.assign(new EventEmitter(), {
    start () {},
    close () { physicalCloses++; endpoint.removeAllListeners() },
    /** @param {unknown} data */
    postMessage (data) { queueMicrotask(() => child.receive(clone({ kind: 'port', port: 1, data }))) }
  })
  const child = childTransport(packet => {
    if (packet.kind === 'close') endpoint.close()
    else queueMicrotask(() => endpoint.emit('message', { data: clone(packet.data) }))
  })
  /** @type {import('abslink').Remote<() => void> | undefined} */
  let callback
  child.parent.on('message', ({ ports }) => exposePort({
    select: (/** @type {import('abslink').Remote<() => void>} */ notify) => { callback = notify; return 'ready' },
    // Force the same RELEASE path as GC of the previous episode's callback.
    release: () => { callback?.[releaseProxy](); callback = undefined },
    stats: () => ({ seeders: 4, progress: 0.5 }),
    metadata: () => ['episode.mkv']
  }, ports[0]))
  child.receive({ kind: 'control', ports: [1] })
  const remote = wrapPort(endpoint)
  for (let episode = 0; episode < 20; episode++) {
    assert.equal(await remote.select(proxy(() => {})), 'ready')
    await remote.release()
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(await remote.stats(), { seeders: 4, progress: 0.5 })
    assert.deepEqual(await remote.metadata(), ['episode.mkv'])
  }
  assert.equal(physicalCloses, 0)
  assert.equal(endpoint.listenerCount('message'), 1, 'released callback listeners are removed')
  endpoint.close()
  child.receive({ kind: 'close', port: 1 })
})

test('callback release also preserves native MessagePort requests', { timeout: 3000 }, async t => {
  const { MessageChannel } = await import('node:worker_threads')
  const { expose: exposePort, wrap: wrapPort } = await import('abslink/w3c')
  const { port1, port2 } = new MessageChannel()
  t.after(() => { port1.close(); port2.close() })
  exposePort({
    episode: async (/** @type {import('abslink').Remote<() => void>} */ callback) => {
      await callback()
      await callback[releaseProxy]()
      return 'ready'
    },
    stats: () => ({ seeders: 2, progress: 0.75 })
  }, port1)
  const remote = wrapPort(port2)
  for (let episode = 0; episode < 10; episode++) {
    assert.equal(await remote.episode(proxy(() => {})), 'ready')
    assert.deepEqual(await remote.stats(), { seeders: 2, progress: 0.75 })
  }
})
