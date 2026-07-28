import { DatabaseSync } from 'node:sqlite'
import { parentPort, Worker, type WorkerOptions } from 'node:worker_threads'

interface WorkerRequest {
  id: number
  operation: 'validate' | 'sources' | 'find' | 'audio'
  path: string
  args: unknown[]
}

interface LocalAudioRow {
  source: string
  expression: string
  reading: string | null
  file: string
}

const port = parentPort
if (port) {
  port.on('message', (request: WorkerRequest) => {
    try {
      port.postMessage({ id: request.id, result: execute(request) })
    } catch (error) {
      port.postMessage({
        id: request.id,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  })
}

// Electron Vite replaces this default export with a wrapper around its emitted
// worker asset. It also keeps direct Node test runs functional.
export default function createMiningAudioWorker (options: WorkerOptions) {
  return new Worker(new URL(import.meta.url), options)
}

function execute (request: WorkerRequest) {
  const database = new DatabaseSync(request.path, { readOnly: true })
  try {
    if (request.operation === 'validate') {
      const entries = tableColumns(database, 'entries')
      const audio = tableColumns(database, 'android')
      for (const column of ['source', 'expression', 'reading', 'file']) {
        if (!entries.has(column)) throw new Error(`android.db entries table is missing ${column}`)
      }
      for (const column of ['source', 'file', 'data']) {
        if (!audio.has(column)) throw new Error(`android.db android table is missing ${column}`)
      }
      return true
    }
    if (request.operation === 'sources') {
      return database.prepare(
        `SELECT DISTINCT source FROM entries
         WHERE lower(file) LIKE '%.mp3' OR lower(file) LIKE '%.opus' OR lower(file) LIKE '%.ogg'`
      ).all()
    }
    if (request.operation === 'find') {
      const [term, reading] = request.args as [string, string]
      return (reading
        ? database.prepare(
          'SELECT source, expression, reading, file FROM entries WHERE expression = ? OR reading = ?'
        ).all(term, reading)
        : database.prepare(
          'SELECT source, expression, reading, file FROM entries WHERE expression = ?'
        ).all(term)) as unknown as LocalAudioRow[]
    }
    const [source, file, maximumBytes] = request.args as [string, string, number]
    const row = database.prepare(
      'SELECT data FROM android WHERE source = ? AND file = ? LIMIT 1'
    ).get(source, file) as { data?: Uint8Array } | undefined
    return row?.data instanceof Uint8Array && row.data.byteLength <= maximumBytes ? row.data : undefined
  } finally {
    database.close()
  }
}

function tableColumns (database: DatabaseSync, table: string) {
  return new Set(
    (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>)
      .flatMap(row => typeof row.name === 'string' ? [row.name] : [])
  )
}
