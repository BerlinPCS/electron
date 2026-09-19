import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { serialize, deserialize } from 'node:v8'

import { expose, wrap, proxy } from 'abslink'

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
