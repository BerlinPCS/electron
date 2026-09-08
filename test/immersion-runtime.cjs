// Run in Electron against a temporary esbuild bundle of src/main/immersion.ts.
/* eslint-disable @typescript-eslint/no-require-imports -- Electron main-process harness uses CommonJS. */
const assert = require('node:assert/strict')
const { randomBytes } = require('node:crypto')
const { mkdtempSync, readFileSync, statSync, rmSync } = require('node:fs')
const { createServer } = require('node:http')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { DatabaseSync } = require('node:sqlite')

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
    // Isolated upgrade fixture: preserve pre-existing episode evidence and let
    // already known shows continue reporting without another threshold.
    const legacyPath = join(directory, 'legacy.sqlite3')
    const legacy = new DatabaseSync(legacyPath)
    legacy.exec(`CREATE TABLE episode_coverage(external_media_id TEXT NOT NULL, episode INTEGER NOT NULL,
      duration_seconds REAL NOT NULL, ranges_json TEXT NOT NULL, completion_emitted INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(external_media_id,episode));
      INSERT INTO episode_coverage VALUES('known',1,1440,'[[0,100]]',0)`)
    const before = legacy.prepare('SELECT * FROM episode_coverage').all()
    legacy.close()
    const upgraded = new ImmersionOutbox(legacyPath, '', '')
    upgraded.close()
    const verify = new DatabaseSync(legacyPath)
    assert.deepEqual(verify.prepare('SELECT * FROM episode_coverage').all(), before)
    assert.equal(verify.prepare("SELECT qualified FROM media_reporting WHERE external_media_id='known'").get().qualified, 1)
    assert.equal(verify.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
    verify.close()
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
    // New media remains local through restart and exactly twenty minutes.
    outbox.updateConnection({ endpoint, token: expectedToken })
    await outbox.flush()
    assert.equal(received.length, 0)
    for (let i = 0; i < 79; i++) outbox.recordSegment({ externalMediaId: 'test-media', displayName: 'Test', episode: 2, mode: 'standard', wallMilliseconds: 15000, contentStartSeconds: 0, contentEndSeconds: 0, durationSeconds: 1440 })
    outbox.recordSegment({ externalMediaId: 'test-media', displayName: 'Test', episode: 2, mode: 'mining', wallMilliseconds: 10000, contentStartSeconds: 0, contentEndSeconds: 0, durationSeconds: 1440 })
    await outbox.flush()
    assert.equal(received.length, 0, 'Exactly 20 minutes does not qualify')
    outbox.close()
    outbox = new ImmersionOutbox(join(directory, 'immersion.sqlite3'), '', '')
    await outbox.flush()
    assert.equal(received.length, 0, 'Restart does not release held media')
    outbox.recordSegment({ externalMediaId: 'test-media', displayName: 'Test', episode: 2, mode: 'mining', wallMilliseconds: 1000, contentStartSeconds: 0, contentEndSeconds: 0, durationSeconds: 1440 })
    for (let count = 0; count < 100 && outbox.state().pending; count++) {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.equal(outbox.state().pending, 0)
    assert.equal(received.length, 82)
    assert.equal(received[0].event_id, eventId)
    assert.equal(received.reduce((sum, event) => sum + event.wall_milliseconds, 0), 1201000)
    // Qualifying is permanent, and observed ending completion survives restart/replay.
    for (let position = 1250; position < 1300; position += 5) outbox.recordSegment({ externalMediaId: 'test-media', displayName: 'Test', episode: 4, mode: 'mining', wallMilliseconds: 5000, contentStartSeconds: position, contentEndSeconds: position + 5, durationSeconds: 1440 })
    for (let count = 0; count < 100 && outbox.state().pending; count++) {
      await new Promise(resolve => setTimeout(resolve, 20))
      await outbox.flush()
    }
    assert.equal(received.filter(event => event.event_type === 'episode_completed').length, 1)
    outbox.close()
    outbox = new ImmersionOutbox(join(directory, 'immersion.sqlite3'), '', '')
    outbox.recordSegment({ externalMediaId: 'test-media', displayName: 'Test', episode: 4, mode: 'standard', wallMilliseconds: 5000, contentStartSeconds: 1295, contentEndSeconds: 1300, durationSeconds: 1440 })
    for (let count = 0; count < 100 && outbox.state().pending; count++) {
      await new Promise(resolve => setTimeout(resolve, 20))
      await outbox.flush()
    }
    assert.equal(received.filter(event => event.event_type === 'episode_completed').length, 1)
    console.log('PASS: reporting threshold, cross-mode total, held restart, release original events, resumed completion and replay dedupe; encrypted storage, file permissions, restart persistence, empty test request, token rotation/removal, URL validation, offline event recovery and acknowledgement')
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
