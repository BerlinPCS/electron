import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import { HoshidictsClient, HoshidictsError } from '../src/main/hoshidicts/client.ts'

function fakeChild () {
  /** @type {import('node:child_process').ChildProcessWithoutNullStreams & { stdin: PassThrough, stdout: PassThrough, stderr: PassThrough, killed: boolean }} */
  const child = /** @type {any} */ (new EventEmitter())
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.killed = false
  child.kill = () => {
    child.killed = true
    return true
  }
  return child
}

/** @param {import('node:child_process').ChildProcessWithoutNullStreams} child */
async function nextRequest (child) {
  const [chunk] = await once(child.stdin, 'data')
  return JSON.parse(String(chunk))
}

test('correlates out-of-order NDJSON responses by id', async () => {
  const child = fakeChild()
  const client = new HoshidictsClient(child)

  const first = client.request('state')
  const firstRequest = await nextRequest(child)
  const second = client.request('hello')
  const secondRequest = await nextRequest(child)

  child.stdout.write(`${JSON.stringify({ id: secondRequest.id, result: { protocolVersion: 1 } })}\n`)
  child.stdout.write(`${JSON.stringify({ id: firstRequest.id, result: { generation: 4 } })}\n`)

  assert.deepEqual(await first, { generation: 4 })
  assert.deepEqual(await second, { protocolVersion: 1 })
})

test('rejects the previous lookup when a newer lookup supersedes it', async () => {
  const child = fakeChild()
  const client = new HoshidictsClient(child)

  const first = client.requestLatestLookup({ text: '食べる', offset: 0 })
  await nextRequest(child)
  const second = client.requestLatestLookup({ text: '見る', offset: 0 })
  const secondRequest = await nextRequest(child)

  await assert.rejects(first, error => error instanceof HoshidictsError && error.code === 'SUPERSEDED')
  child.stdout.write(`${JSON.stringify({ id: secondRequest.id, result: { length: 1, entries: [] } })}\n`)
  assert.deepEqual(await second, { length: 1, entries: [] })
})

test('forwards events without consuming pending responses', async () => {
  const child = fakeChild()
  /** @type {import('../src/main/hoshidicts/types.ts').SidecarEvent[]} */
  const events = []
  const client = new HoshidictsClient(child, { onEvent: event => events.push(event) })

  const response = client.request('state')
  const request = await nextRequest(child)
  child.stdout.write('{"event":"stateChanged","data":{"generation":2}}\n')
  child.stdout.write(`${JSON.stringify({ id: request.id, result: { generation: 2 } })}\n`)

  assert.deepEqual(await response, { generation: 2 })
  assert.deepEqual(events, [{ event: 'stateChanged', data: { generation: 2 } }])
})

test('kills the sidecar and rejects requests on malformed protocol data', async () => {
  const child = fakeChild()
  const client = new HoshidictsClient(child)
  const response = client.request('state')
  await nextRequest(child)

  child.stdout.write('not-json\n')

  await assert.rejects(response, error => error instanceof HoshidictsError && error.code === 'PROTOCOL_ERROR')
  assert.equal(child.killed, true)
})

test('bounds unterminated protocol lines', async () => {
  const child = fakeChild()
  const client = new HoshidictsClient(child, { maxLineBytes: 16 })
  const response = client.request('state')
  await nextRequest(child)

  child.stdout.write('{"oversized":"protocol')

  await assert.rejects(response, error => error instanceof HoshidictsError && error.code === 'PROTOCOL_ERROR')
  assert.equal(child.killed, true)
})

test('preserves sidecar error codes and marks superseded errors in the message', async () => {
  const child = fakeChild()
  const client = new HoshidictsClient(child)
  const response = client.request('lookup')
  const request = await nextRequest(child)

  child.stdout.write(`${JSON.stringify({
    id: request.id,
    error: { code: 'SUPERSEDED', message: 'lookup moved' }
  })}\n`)

  await assert.rejects(response, error =>
    error instanceof HoshidictsError &&
    error.code === 'SUPERSEDED' &&
    error.message.includes('SUPERSEDED')
  )
})
