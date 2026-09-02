// Run in Electron against a temporary esbuild bundle of src/main/immersion.ts.
/* eslint-disable @typescript-eslint/no-require-imports -- Electron main-process harness uses CommonJS. */
const assert = require('node:assert/strict')
const { randomBytes } = require('node:crypto')
const { mkdtempSync, readFileSync, statSync, rmSync } = require('node:fs')
const { createServer } = require('node:http')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const { app, safeStorage } = require('electron')

const directory = mkdtempSync(join(tmpdir(), 'hayatan-immersion-test-'))
app.setPath('userData', directory)

app.whenReady().then(async () => {
  const { ImmersionOutbox } = require(process.env.IMMERSION_TEST_BUNDLE)
  const token = randomBytes(32).toString('hex')
  const received = []
  let expectedToken = token
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${expectedToken}`) {
      response.writeHead(401).end()
      return
    }
    let body = ''
    for await (const chunk of request) body += chunk
    const { events } = JSON.parse(body)
    received.push(...events)
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ accepted: events.map(event => event.event_id), duplicates: [], rejected: [] }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const endpoint = `http://127.0.0.1:${server.address().port}`
  let outbox
  try {
    assert.equal(safeStorage.isEncryptionAvailable(), true)
    outbox = new ImmersionOutbox(join(directory, 'immersion.sqlite3'), '', '')
    assert.equal(outbox.state().configured, false)
    assert.throws(() => outbox.updateConnection({ endpoint: 'http://example.com' }))
    assert.throws(() => outbox.updateConnection({ endpoint: 'https://example.com/path' }))
    assert.throws(() => outbox.updateConnection({ endpoint: 'https://user:password@example.com' }))
    outbox.updateConnection({ endpoint, token })
    assert.equal(outbox.state().configured, true)
    assert.equal('token' in outbox.state(), false)
    assert.equal(readFileSync(join(directory, 'immersion-token.bin')).includes(Buffer.from(token)), false)
    assert.equal(statSync(join(directory, 'immersion-token.bin')).mode & 0o777, 0o600)
    assert.equal(statSync(join(directory, 'immersion-connection.json')).mode & 0o777, 0o600)
    outbox.close()
    outbox = new ImmersionOutbox(join(directory, 'immersion.sqlite3'), '', '')
    assert.equal(outbox.state().endpoint, endpoint)
    assert.equal(outbox.state().tokenConfigured, true)
    assert.equal((await outbox.testConnection()).ok, true)
    assert.equal(received.length, 0, 'Connection tests must not create statistics')
    outbox.updateConnection({ endpoint, token: '' })
    assert.equal((await outbox.testConnection()).ok, true, 'Blank input retains the saved token')
    expectedToken = randomBytes(32).toString('hex')
    outbox.updateConnection({ endpoint, token: expectedToken })
    assert.equal((await outbox.testConnection()).ok, true, 'Token rotation authenticates')
    outbox.updateConnection({ endpoint, clearToken: true })
    assert.equal(outbox.state().configured, false)
    await assert.rejects(outbox.testConnection(), /Configure both/)
    const eventId = outbox.recordSegment({ externalMediaId: 'test-media', displayName: 'Test', episode: 1, mode: 'mining', wallMilliseconds: 5000, contentStartSeconds: 0, contentEndSeconds: 5, durationSeconds: 100 })
    assert.equal(outbox.state().pending, 1)
    outbox.close()
    outbox = new ImmersionOutbox(join(directory, 'immersion.sqlite3'), '', '')
    assert.equal(outbox.state().pending, 1, 'Pending statistics survive restart')
    outbox.updateConnection({ endpoint, token: expectedToken })
    for (let count = 0; count < 100 && outbox.state().pending; count++) {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.equal(outbox.state().pending, 0)
    assert.equal(received.length, 1)
    assert.equal(received[0].event_id, eventId)
    console.log('PASS: encrypted storage, file permissions, restart persistence, empty test request, token rotation/removal, URL validation, offline event recovery and acknowledgement')
  } finally {
    outbox?.close()
    await new Promise(resolve => server.close(resolve))
  }
}).then(() => {
  rmSync(directory, { recursive: true, force: true })
  app.exit(0)
}).catch(error => {
  console.error(error.message)
  app.exit(1)
})
