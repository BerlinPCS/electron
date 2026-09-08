import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { safeStorage } from 'electron'

import { hasWatchedEnding, mergeRanges, splitAtBerlinMidnight } from './immersion-ranges.ts'

export interface ImmersionSegment {
  externalMediaId: string
  displayName: string
  episode: number
  mode: 'mining' | 'standard'
  wallMilliseconds: number
  contentStartSeconds: number
  contentEndSeconds: number
  durationSeconds: number
  occurredAt?: string
  sampleClamped?: boolean
}

export interface ImmersionDailyBaseline {
  date: string
  miningSeconds: number
  standardSeconds: number
}

export interface ImmersionConnectionPatch {
  endpoint: string
  token?: string
  clearToken?: boolean
}

export interface ImmersionConnectionState {
  pending: number
  rejected: number
  configured: boolean
  endpoint: string
  tokenConfigured: boolean
}

interface StoredConnection {
  endpoint: string
}

export class ImmersionOutbox {
  private readonly db: DatabaseSync
  private sending = false
  private readonly timer?: ReturnType<typeof setInterval>

  private endpoint: string
  private token: string
  private readonly configPath: string
  private readonly tokenPath: string

  constructor (path: string, endpoint = process.env.ANKILOCK_IMMERSION_URL ?? '', token = process.env.ANKILOCK_IMMERSION_TOKEN ?? '') {
    const directory = dirname(path)
    this.configPath = join(directory, 'immersion-connection.json')
    this.tokenPath = join(directory, 'immersion-token.bin')
    const stored = loadConnection(this.configPath)
    this.endpoint = normalizeEndpoint(endpoint || stored.endpoint)
    this.token = loadToken(this.tokenPath, token)
    if (endpoint) persistConnection(this.configPath, { endpoint: this.endpoint })
    this.db = new DatabaseSync(path)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS outbox (
        event_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL, created_at TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
        next_attempt_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS dead_letter (
        event_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL, error TEXT NOT NULL,
        rejected_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS migration_markers (
        marker TEXT PRIMARY KEY, completed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS media_reporting (
        external_media_id TEXT PRIMARY KEY, wall_milliseconds REAL NOT NULL DEFAULT 0,
        qualified INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS episode_coverage (
        external_media_id TEXT NOT NULL, episode INTEGER NOT NULL,
        duration_seconds REAL NOT NULL, ranges_json TEXT NOT NULL,
        completion_emitted INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(external_media_id, episode)
      );`)
    const outboxColumns = this.db.prepare('PRAGMA table_info(outbox)').all() as Array<{ name: string }>
    if (!outboxColumns.some(column => column.name === 'next_attempt_at')) {
      this.db.exec('ALTER TABLE outbox ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0')
    }
    // Existing media must keep reporting normally after an upgrade. Seed once;
    // held events from this version must never qualify merely because of a restart.
    if (!this.db.prepare("SELECT 1 FROM migration_markers WHERE marker='media-reporting-v1'").get()) {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        this.db.exec(`INSERT OR IGNORE INTO media_reporting(external_media_id,qualified)
          SELECT external_media_id,1 FROM episode_coverage;
          INSERT OR IGNORE INTO media_reporting(external_media_id,qualified)
          SELECT json_extract(payload_json,'$.external_media_id'),1 FROM outbox;`)
        this.db.prepare('INSERT INTO migration_markers(marker,completed_at) VALUES(?,?)')
          .run('media-reporting-v1', new Date().toISOString())
        this.db.exec('COMMIT')
      } catch (error) { this.db.exec('ROLLBACK'); throw error }
    }
    this.timer = setInterval(() => { this.flush().catch(() => undefined) }, 15_000)
    this.flush().catch(() => undefined)
  }

  recordSegment (input: ImmersionSegment) {
    validateSegment(input)
    const endedAt = input.occurredAt ? new Date(input.occurredAt) : new Date()
    const startedAt = new Date(endedAt.getTime() - input.wallMilliseconds)
    const parts = splitAtBerlinMidnight(startedAt, endedAt)
    let firstEventId = ''
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const [start, end] of parts) {
        const ratioStart = (start.getTime() - startedAt.getTime()) / input.wallMilliseconds
        const ratioEnd = (end.getTime() - startedAt.getTime()) / input.wallMilliseconds
        const contentSpan = input.contentEndSeconds - input.contentStartSeconds
        const payload = {
          event_id: randomUUID(),
          external_media_id: input.externalMediaId,
          display_name: input.displayName,
          event_type: 'watch_segment',
          occurred_at: start.toISOString(),
          wall_milliseconds: end.getTime() - start.getTime(),
          mode: input.mode,
          episode: input.episode,
          characters: 0,
          metadata: {
            content_start_seconds: input.contentStartSeconds + contentSpan * ratioStart,
            content_end_seconds: input.contentStartSeconds + contentSpan * ratioEnd,
            duration_seconds: input.durationSeconds,
            sample_clamped: Boolean(input.sampleClamped)
          }
        }
        if (!firstEventId) firstEventId = payload.event_id
        this.db.prepare('INSERT INTO outbox(event_id,payload_json,created_at) VALUES(?,?,?)')
          .run(payload.event_id, JSON.stringify(payload), new Date().toISOString())
      }
      this.updateCoverage(input)
      this.db.prepare(`INSERT INTO media_reporting(external_media_id,wall_milliseconds,qualified)
        VALUES(?,?,0) ON CONFLICT(external_media_id) DO UPDATE SET
        wall_milliseconds=wall_milliseconds+excluded.wall_milliseconds`).run(input.externalMediaId, input.wallMilliseconds)
      this.db.prepare('UPDATE media_reporting SET qualified=1 WHERE external_media_id=? AND wall_milliseconds>1200000')
        .run(input.externalMediaId)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    this.flush().catch(() => undefined)
    return firstEventId
  }

  migrateCurrentDayBaseline (input: ImmersionDailyBaseline) {
    validateBaseline(input)
    if (input.date !== berlinDateKey()) throw new Error('Only the current Berlin day can be migrated')
    const marker = `daily-baseline:${input.date}`
    if (this.db.prepare('SELECT 1 FROM migration_markers WHERE marker=?').get(marker)) return false
    const occurredAt = new Date().toISOString()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const [mode, seconds] of [['mining', input.miningSeconds], ['standard', input.standardSeconds]] as const) {
        if (seconds <= 0) continue
        const payload = {
          event_id: randomUUID(),
          external_media_id: `hayatan-legacy-day:${input.date}`,
          display_name: `Hayatan current-day baseline (${input.date})`,
          event_type: 'daily_baseline',
          occurred_at: occurredAt,
          wall_milliseconds: Math.floor(seconds * 1000),
          mode,
          episode: null,
          characters: 0,
          metadata: { legacy_daily_baseline: true }
        }
        this.db.prepare('INSERT INTO outbox(event_id,payload_json,created_at) VALUES(?,?,?)')
          .run(payload.event_id, JSON.stringify(payload), occurredAt)
      }
      this.db.prepare('INSERT INTO migration_markers(marker,completed_at) VALUES(?,?)')
        .run(marker, occurredAt)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    this.flush().catch(() => undefined)
    return true
  }

  state (): ImmersionConnectionState {
    return {
      pending: Number((this.db.prepare('SELECT COUNT(*) count FROM outbox').get() as { count: number }).count),
      rejected: Number((this.db.prepare('SELECT COUNT(*) count FROM dead_letter').get() as { count: number }).count),
      configured: Boolean(this.endpoint && this.token),
      endpoint: this.endpoint,
      tokenConfigured: Boolean(this.token)
    }
  }

  updateConnection (patch: ImmersionConnectionPatch) {
    const endpoint = normalizeEndpoint(patch.endpoint)
    if (patch.clearToken && patch.token) throw new Error('Cannot replace and clear the token together')
    if (patch.clearToken) {
      rmSync(this.tokenPath, { force: true })
      this.token = ''
    } else if (patch.token) {
      this.token = storeToken(this.tokenPath, patch.token)
    }
    this.endpoint = endpoint
    persistConnection(this.configPath, { endpoint })
    this.flush().catch(() => undefined)
    return this.state()
  }

  async testConnection () {
    if (!this.endpoint || !this.token) throw new Error('Configure both the backend URL and source token first')
    const response = await fetch(`${this.endpoint}/v1/immersion/sources/hayatan/events`, {
      method: 'POST',
      signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: [] })
    })
    if (!response.ok) throw new Error(`Backend returned HTTP ${response.status}`)
    const result = await response.json() as { accepted?: unknown[], duplicates?: unknown[], rejected?: unknown[] }
    if (!Array.isArray(result.accepted) || !Array.isArray(result.duplicates) || !Array.isArray(result.rejected)) {
      throw new Error('Backend returned an unexpected response')
    }
    return { ok: true, message: 'Authenticated with the immersion backend.' }
  }

  async flush () {
    if (this.sending || !this.endpoint || !this.token) return
    this.sending = true
    try {
      const rows = this.db.prepare('SELECT event_id,payload_json,attempts FROM outbox WHERE next_attempt_at<=? AND (json_extract(payload_json,\'$.event_type\')=\'daily_baseline\' OR EXISTS (SELECT 1 FROM media_reporting m WHERE m.external_media_id=json_extract(payload_json,\'$.external_media_id\') AND m.qualified=1)) ORDER BY created_at LIMIT 128')
        .all(Date.now()) as Array<{ event_id: string, payload_json: string, attempts: number }>
      if (!rows.length) return
      const response = await fetch(`${this.endpoint.replace(/\/$/, '')}/v1/immersion/sources/hayatan/events`, {
        method: 'POST',
        signal: AbortSignal.timeout(30_000),
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ events: rows.map(row => JSON.parse(row.payload_json)) })
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const result = await response.json() as { accepted: string[], duplicates: string[], rejected?: Array<{ event_id: string, error: string }> }
      const requested = new Set(rows.map(row => row.event_id))
      const remove = [...result.accepted, ...result.duplicates].filter(id => requested.has(id))
      const rejected = (result.rejected ?? []).filter(item => requested.has(item.event_id))
      const removeStatement = this.db.prepare('DELETE FROM outbox WHERE event_id=?')
      const rejectStatement = this.db.prepare(`INSERT OR REPLACE INTO dead_letter(event_id,payload_json,error,rejected_at)
        SELECT event_id,payload_json,?,? FROM outbox WHERE event_id=?`)
      const acknowledged = new Set([...remove, ...rejected.map(item => item.event_id)])
      const retryStatement = this.db.prepare('UPDATE outbox SET attempts=attempts+1,last_error=?,next_attempt_at=? WHERE event_id=?')
      this.db.exec('BEGIN')
      try {
        for (const id of remove) removeStatement.run(id)
        for (const item of rejected) {
          rejectStatement.run(item.error.slice(0, 500), new Date().toISOString(), item.event_id)
          removeStatement.run(item.event_id)
        }
        for (const row of rows.filter(row => !acknowledged.has(row.event_id))) {
          retryStatement.run('backend omitted event acknowledgement', Date.now() + retryDelay(row.attempts), row.event_id)
        }
        this.db.exec('COMMIT')
      } catch (error) { this.db.exec('ROLLBACK'); throw error }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const rows = this.db.prepare('SELECT event_id,attempts FROM outbox WHERE next_attempt_at<=? AND (json_extract(payload_json,\'$.event_type\')=\'daily_baseline\' OR EXISTS (SELECT 1 FROM media_reporting m WHERE m.external_media_id=json_extract(payload_json,\'$.external_media_id\') AND m.qualified=1)) ORDER BY created_at LIMIT 128')
        .all(Date.now()) as Array<{ event_id: string, attempts: number }>
      const statement = this.db.prepare('UPDATE outbox SET attempts=attempts+1,last_error=?,next_attempt_at=? WHERE event_id=?')
      for (const row of rows) statement.run(message.slice(0, 500), Date.now() + retryDelay(row.attempts), row.event_id)
    } finally { this.sending = false }
  }

  close () { if (this.timer) clearInterval(this.timer); this.db.close() }

  private updateCoverage (input: ImmersionSegment) {
    if (!Number.isFinite(input.durationSeconds) || input.durationSeconds <= 0) return
    const row = this.db.prepare(`SELECT duration_seconds,ranges_json,completion_emitted FROM episode_coverage
      WHERE external_media_id=? AND episode=?`).get(input.externalMediaId, input.episode) as
      { duration_seconds: number, ranges_json: string, completion_emitted: number } | undefined
    const ranges = mergeRanges([
      ...(row ? JSON.parse(row.ranges_json) as Array<[number, number]> : []),
      [Math.max(0, input.contentStartSeconds), Math.min(input.durationSeconds, input.contentEndSeconds)]
    ])
    const covered = ranges.reduce((sum, range) => sum + range[1] - range[0], 0)
    const completed = Boolean(row?.completion_emitted) || (covered >= input.durationSeconds * 0.75 || hasWatchedEnding(ranges, input.durationSeconds))
    this.db.prepare(`INSERT INTO episode_coverage(external_media_id,episode,duration_seconds,ranges_json,completion_emitted)
      VALUES(?,?,?,?,?) ON CONFLICT(external_media_id,episode) DO UPDATE SET
      duration_seconds=excluded.duration_seconds,ranges_json=excluded.ranges_json,
      completion_emitted=excluded.completion_emitted`)
      .run(input.externalMediaId, input.episode, input.durationSeconds, JSON.stringify(ranges), Number(completed))
    if (completed && !row?.completion_emitted) {
      const completion = {
        event_id: randomUUID(),
        external_media_id: input.externalMediaId,
        display_name: input.displayName,
        event_type: 'episode_completed',
        occurred_at: input.occurredAt ?? new Date().toISOString(),
        wall_milliseconds: 0,
        mode: input.mode,
        episode: input.episode,
        characters: 0,
        metadata: { coverage_seconds: covered, duration_seconds: input.durationSeconds }
      }
      this.db.prepare('INSERT INTO outbox(event_id,payload_json,created_at) VALUES(?,?,?)')
        .run(completion.event_id, JSON.stringify(completion), new Date().toISOString())
    }
  }
}

function loadToken (tokenPath: string, supplied: string) {
  if (supplied) return storeToken(tokenPath, supplied)
  if (!supplied && safeStorage.isEncryptionAvailable() && existsSync(tokenPath)) {
    return safeStorage.decryptString(readFileSync(tokenPath))
  }
  return supplied
}

function storeToken (tokenPath: string, supplied: string) {
  const token = supplied.trim()
  if (!token) throw new Error('The source token cannot be empty')
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure token storage is unavailable')
  writePrivateFile(tokenPath, safeStorage.encryptString(token))
  return token
}

function loadConnection (path: string): StoredConnection {
  if (!existsSync(path)) return { endpoint: '' }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<StoredConnection>
    return { endpoint: typeof parsed.endpoint === 'string' ? parsed.endpoint : '' }
  } catch {
    return { endpoint: '' }
  }
}

function persistConnection (path: string, connection: StoredConnection) {
  writePrivateFile(path, JSON.stringify(connection, null, 2) + '\n')
}

function writePrivateFile (path: string, contents: string | Uint8Array) {
  const temporary = `${path}.tmp`
  writeFileSync(temporary, contents, { mode: 0o600 })
  renameSync(temporary, path)
}

function normalizeEndpoint (value: string) {
  const endpoint = value.trim().replace(/\/+$/, '')
  if (!endpoint) return ''
  const parsed = new URL(endpoint)
  const localDevelopment = parsed.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(parsed.hostname)
  if (parsed.protocol !== 'https:' && !localDevelopment) throw new Error('The backend URL must use HTTPS')
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
    throw new Error('Enter only the backend origin, without credentials, a path, query, or fragment')
  }
  return parsed.origin
}

function validateSegment (input: ImmersionSegment) {
  if (!input.externalMediaId || input.externalMediaId.length > 128) throw new Error('Invalid media id')
  if (!Number.isFinite(input.wallMilliseconds) || input.wallMilliseconds < 100 || input.wallMilliseconds > 15_000) throw new Error('Invalid watch segment duration')
  if (!Number.isInteger(input.episode) || input.episode < 1) throw new Error('Invalid episode')
  if (!['mining', 'standard'].includes(input.mode)) throw new Error('Invalid watch mode')
}

function validateBaseline (input: ImmersionDailyBaseline) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new Error('Invalid baseline date')
  if (![input.miningSeconds, input.standardSeconds].every(value => Number.isFinite(value) && value >= 0)) {
    throw new Error('Invalid baseline duration')
  }
  if (input.miningSeconds + input.standardSeconds > 90_000) throw new Error('Baseline exceeds one Berlin day')
}

function berlinDateKey (date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(date)
}

function retryDelay (attempts: number) {
  return Math.min(900, 15 * (2 ** Math.min(attempts, 6))) * 1000
}
