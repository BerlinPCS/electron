import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import createMiningAudioWorker from './mining-audio-worker.ts?nodeWorker'

import type { Worker } from 'node:worker_threads'

const LOCAL_SOURCE_TEMPLATE = 'hayase-local-audio-source://get/?term={term}&reading={reading}'
const SOURCE_PRIORITY = [
  'nhk16',
  'daijisen',
  'shinmeikai8',
  'jpod',
  'jpod_alternate',
  'taas',
  'ozk5',
  'forvo',
  'forvo_ext',
  'forvo_ext2'
] as const
const SUPPORTED_EXTENSIONS = new Set(['mp3', 'opus', 'ogg'])
const MAX_REMOTE_SOURCE_BYTES = 1024 * 1024
const MAX_LOCAL_AUDIO_BYTES = 20 * 1024 * 1024

export interface MiningLocalAudioState {
  available: boolean
  sizeBytes: number
  sources: string[]
  sourceOrder: string[]
  error?: string
}

interface LocalAudioRow {
  source: string
  expression: string
  reading: string | null
  file: string
}

interface LocalAudioConfig {
  version: 1
  sourceOrder: string[]
}

interface PendingDatabaseRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

export class MiningAudioRepository {
  private readonly databasePath: string
  private readonly configPath: string
  private cachedState?: MiningLocalAudioState
  private readonly database = new MiningAudioDatabaseWorker()

  constructor (private readonly root: string) {
    this.databasePath = join(root, 'android.db')
    this.configPath = join(root, 'android_sources.json')
  }

  async state (): Promise<MiningLocalAudioState> {
    if (this.cachedState) return cloneState(this.cachedState)
    try {
      await recoverFileBackup(this.databasePath)
      const file = await stat(this.databasePath)
      const rows = await this.database.request<Array<{ source?: unknown }>>('sources', this.databasePath)
      const sources = defaultSourceOrder(rows.flatMap(row => typeof row.source === 'string' ? [row.source] : []))
      const sourceOrder = await this.repairSourceOrder(sources)
      this.cachedState = {
        available: true,
        sizeBytes: file.size,
        sources,
        sourceOrder
      }
      return cloneState(this.cachedState)
    } catch (error) {
      if (isMissingFile(error)) {
        this.cachedState = emptyLocalAudioState()
        return cloneState(this.cachedState)
      }
      this.cachedState = {
        ...emptyLocalAudioState(),
        error: 'Unable to open the local audio database.'
      }
      return cloneState(this.cachedState)
    }
  }

  async importDatabase (sourcePath: string): Promise<MiningLocalAudioState> {
    await mkdir(this.root, { recursive: true })
    const temporaryPath = `${this.databasePath}.tmp`
    await rm(temporaryPath, { force: true })
    try {
      await copyFile(sourcePath, temporaryPath)
      await this.database.request('validate', temporaryPath)
      await replaceFile(temporaryPath, this.databasePath)
      await rm(this.configPath, { force: true })
      this.cachedState = undefined
      return await this.state()
    } catch (error) {
      await rm(temporaryPath, { force: true })
      throw error
    }
  }

  async removeDatabase (): Promise<MiningLocalAudioState> {
    await rm(this.databasePath, { force: true })
    await rm(`${this.databasePath}.backup`, { force: true })
    await rm(this.configPath, { force: true })
    await rm(`${this.configPath}.backup`, { force: true })
    this.cachedState = emptyLocalAudioState()
    return cloneState(this.cachedState)
  }

  async reorderSources (sourceOrder: string[]): Promise<MiningLocalAudioState> {
    const state = await this.state()
    if (!state.available) return state
    const repaired = repairSourceOrder(sourceOrder, state.sources)
    await this.writeConfig({ version: 1, sourceOrder: repaired })
    this.cachedState = { ...state, sourceOrder: repaired }
    return cloneState(this.cachedState)
  }

  async resolveSource (target: string, templates: string[]): Promise<string | null> {
    if (!isAllowedAudioTarget(target, templates)) {
      throw new Error('Audio source request does not match an enabled template')
    }
    const url = new URL(target)
    if (url.protocol === 'hayase-local-audio-source:') {
      if (url.hostname !== 'get') return null
      const entry = await this.findLocalAudio(
        url.searchParams.get('term') ?? '',
        url.searchParams.get('reading') ?? ''
      )
      if (!entry) return null
      const audio = new URL('hayase-local-audio://audio')
      audio.searchParams.set('source', entry.source)
      audio.searchParams.set('file', entry.file)
      return audio.href
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null

    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      redirect: 'follow',
      signal: AbortSignal.timeout(4_000)
    })
    if (!response.ok) return null
    const finalProtocol = new URL(response.url).protocol
    if (finalProtocol !== 'http:' && finalProtocol !== 'https:') return null
    const bytes = await readBoundedResponseBytes(response, MAX_REMOTE_SOURCE_BYTES)
    if (!bytes) return null

    const payload = JSON.parse(new TextDecoder().decode(bytes)) as unknown
    if (!isRecord(payload) || payload.type !== 'audioSourceList' || !Array.isArray(payload.audioSources)) return null
    for (const candidate of payload.audioSources) {
      if (!isRecord(candidate) || typeof candidate.url !== 'string') continue
      try {
        const audioUrl = new URL(candidate.url)
        if (audioUrl.protocol === 'http:' || audioUrl.protocol === 'https:') return audioUrl.href
      } catch {}
    }
    return null
  }

  async loadLocalAudio (source: string, file: string): Promise<Buffer | null> {
    if (!source || source.length > 1024 || !file || file.length > 4096 || !isSupportedAudioFile(file)) return null
    try {
      const data = await this.database.request<Uint8Array | undefined>(
        'audio', this.databasePath, source, file, MAX_LOCAL_AUDIO_BYTES
      )
      return data ? Buffer.from(data) : null
    } catch {
      return null
    }
  }

  private async findLocalAudio (term: string, reading: string): Promise<LocalAudioRow | null> {
    const normalizedReading = katakanaToHiragana(reading)
    const state = await this.state()
    if (!state.available) return null

    try {
      const rows = await this.database.request<LocalAudioRow[]>(
        'find', this.databasePath, term, normalizedReading
      )
      return resolveLocalAudio(term, normalizedReading, rows, state.sourceOrder)
    } catch {
      return null
    }
  }

  private async repairSourceOrder (sources: string[]) {
    let current: string[] = []
    try {
      await recoverFileBackup(this.configPath)
      const value = JSON.parse(await readFile(this.configPath, 'utf8')) as unknown
      if (isRecord(value) && value.version === 1 && Array.isArray(value.sourceOrder)) {
        current = value.sourceOrder.filter((source): source is string => typeof source === 'string')
      }
    } catch {}
    const repaired = repairSourceOrder(current, sources)
    if (sources.length && JSON.stringify(current) !== JSON.stringify(repaired)) {
      await this.writeConfig({ version: 1, sourceOrder: repaired })
    }
    return repaired
  }

  private async writeConfig (config: LocalAudioConfig) {
    await mkdir(this.root, { recursive: true })
    const temporaryPath = `${this.configPath}.tmp`
    await writeFile(temporaryPath, JSON.stringify(config), 'utf8')
    await replaceFile(temporaryPath, this.configPath)
  }
}

export function isAllowedAudioTarget (target: string, templates: string[]): boolean {
  if (typeof target !== 'string' || target.length > 8192 || !Array.isArray(templates) || templates.length > 32) return false
  return templates.some(template => {
    if (typeof template !== 'string' || template.length > 4096) return false
    const pattern = template
      .split(/(\{term\}|\{reading\})/)
      .map(part => part === '{term}' || part === '{reading}' ? '[^&#]*' : escapeRegExp(part))
      .join('')
    return new RegExp(`^${pattern}$`).test(target)
  })
}

export function resolveLocalAudio (
  term: string,
  normalizedReading: string,
  rows: LocalAudioRow[],
  sourceOrder: string[]
): LocalAudioRow | null {
  const ranks = new Map(sourceOrder.map((source, index) => [source, index]))
  return rows
    .filter(row =>
      (row.expression === term || (Boolean(row.reading) && row.reading === normalizedReading)) &&
      isSupportedAudioFile(row.file)
    )
    .sort((left, right) =>
      localMatchRank(left, term, normalizedReading) - localMatchRank(right, term, normalizedReading) ||
      (ranks.get(left.source) ?? Number.MAX_SAFE_INTEGER) - (ranks.get(right.source) ?? Number.MAX_SAFE_INTEGER) ||
      left.source.localeCompare(right.source)
    )[0] ?? null
}

export function localAudioMimeType (file: string) {
  return file.toLowerCase().endsWith('.mp3') ? 'audio/mpeg' : 'audio/ogg'
}

export function localAudioResponse (audio: Buffer, file: string, rangeHeader: string | null) {
  const headers: Record<string, string> = {
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'Content-Type': localAudioMimeType(file),
    'Cross-Origin-Resource-Policy': 'cross-origin'
  }
  if (!rangeHeader) {
    headers['Content-Length'] = String(audio.byteLength)
    return new Response(new Uint8Array(audio), { headers })
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader)
  if (!match) return new Response('Invalid range', { status: 416 })
  const requestedStart = match[1] ? Number(match[1]) : undefined
  const requestedEnd = match[2] ? Number(match[2]) : undefined
  const start = requestedStart ?? Math.max(0, audio.byteLength - (requestedEnd ?? 0))
  const end = Math.min(requestedEnd ?? audio.byteLength - 1, audio.byteLength - 1)
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= audio.byteLength) {
    return new Response('Invalid range', {
      status: 416,
      headers: { 'Content-Range': `bytes */${audio.byteLength}` }
    })
  }
  const body = audio.subarray(start, end + 1)
  headers['Content-Length'] = String(body.byteLength)
  headers['Content-Range'] = `bytes ${start}-${end}/${audio.byteLength}`
  return new Response(new Uint8Array(body), { status: 206, headers })
}

function localMatchRank (row: LocalAudioRow, term: string, normalizedReading: string) {
  const readingMatches = Boolean(normalizedReading) && row.reading === normalizedReading
  const expressionMatches = row.expression === term
  if (readingMatches && expressionMatches) return 0
  if (readingMatches) return 1
  if (expressionMatches) return 2
  return 3
}

function defaultSourceOrder (sources: string[]) {
  const unique = [...new Set(sources.filter(Boolean))]
  return unique.sort((left, right) => {
    const leftRank = SOURCE_PRIORITY.indexOf(left as typeof SOURCE_PRIORITY[number])
    const rightRank = SOURCE_PRIORITY.indexOf(right as typeof SOURCE_PRIORITY[number])
    return (leftRank < 0 ? Number.MAX_SAFE_INTEGER : leftRank) -
      (rightRank < 0 ? Number.MAX_SAFE_INTEGER : rightRank) ||
      left.localeCompare(right)
  })
}

function repairSourceOrder (order: string[], available: string[]) {
  const availableSet = new Set(available)
  const kept = [...new Set(order.filter(source => availableSet.has(source)))]
  return [...kept, ...defaultSourceOrder(available.filter(source => !kept.includes(source)))]
}

function katakanaToHiragana (text: string) {
  return [...text].map(character => {
    const code = character.codePointAt(0) ?? 0
    return code >= 0x30a1 && code <= 0x30f6 ? String.fromCodePoint(code - 0x60) : character
  }).join('')
}

function isSupportedAudioFile (file: string) {
  return SUPPORTED_EXTENSIONS.has(file.split('.').pop()?.toLowerCase() ?? '')
}

function emptyLocalAudioState (): MiningLocalAudioState {
  return { available: false, sizeBytes: 0, sources: [], sourceOrder: [] }
}

function cloneState (state: MiningLocalAudioState): MiningLocalAudioState {
  return {
    ...state,
    sources: [...state.sources],
    sourceOrder: [...state.sourceOrder]
  }
}

function isMissingFile (error: unknown) {
  return isRecord(error) && error.code === 'ENOENT'
}

function isRecord (value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function escapeRegExp (value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export { LOCAL_SOURCE_TEMPLATE }

export async function readBoundedResponseBytes (response: Response, maximumBytes: number) {
  const declaredLength = Number(response.headers.get('content-length') ?? 0)
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) return
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    return bytes.byteLength <= maximumBytes ? bytes : undefined
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maximumBytes) {
        await reader.cancel()
        return
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

async function replaceFile (temporaryPath: string, destinationPath: string) {
  const backupPath = `${destinationPath}.backup`
  await recoverFileBackup(destinationPath)
  await rm(backupPath, { force: true })
  let backedUp = false
  try {
    await rename(destinationPath, backupPath)
    backedUp = true
  } catch (error) {
    if (!isMissingFile(error)) throw error
  }
  try {
    await rename(temporaryPath, destinationPath)
  } catch (error) {
    if (backedUp) await rename(backupPath, destinationPath)
    throw error
  }
  if (backedUp) await rm(backupPath, { force: true })
}

async function recoverFileBackup (destinationPath: string) {
  try {
    await stat(destinationPath)
    return
  } catch (error) {
    if (!isMissingFile(error)) throw error
  }
  try {
    await rename(`${destinationPath}.backup`, destinationPath)
  } catch (error) {
    if (!isMissingFile(error)) throw error
  }
}

class MiningAudioDatabaseWorker {
  private worker?: Worker
  private nextId = 1
  private readonly pending = new Map<number, PendingDatabaseRequest>()

  request<T> (operation: 'validate' | 'sources' | 'find' | 'audio', path: string, ...args: unknown[]) {
    const worker = this.getWorker()
    const id = this.nextId++
    if (!this.pending.size) worker.ref()
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: value => resolve(value as T), reject })
      worker.postMessage({ id, operation, path, args })
    })
  }

  private getWorker () {
    if (this.worker) return this.worker
    const worker = createMiningAudioWorker({})
    worker.unref()
    worker.on('message', (message: { id: number, result?: unknown, error?: string }) => {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error))
      else pending.resolve(message.result)
      if (!this.pending.size) worker.unref()
    })
    const fail = (error: Error) => {
      for (const pending of this.pending.values()) pending.reject(error)
      this.pending.clear()
      if (this.worker === worker) this.worker = undefined
    }
    worker.on('error', fail)
    worker.on('exit', code => {
      if (code !== 0) fail(new Error(`Mining audio worker exited with code ${code}.`))
    })
    this.worker = worker
    return worker
  }
}
