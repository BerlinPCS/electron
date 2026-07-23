import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdir } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'
import process from 'node:process'

import log from 'electron-log/main'

import { HoshidictsClient, HoshidictsError } from './client.ts'

import type {
  HoshidictsHello,
  MiningDictionaryEvent,
  MiningDictionaryEntry,
  MiningDictionaryKind,
  MiningDictionaryLookupRequest,
  MiningDictionaryLookupResult,
  MiningDictionaryState,
  SidecarEvent
} from './types.ts'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'

const PROTOCOL_VERSION = 1
const RESTART_DELAYS = [250, 1_000, 4_000] as const
const CRASH_WINDOW_MS = 60_000
const HANDSHAKE_TIMEOUT_MS = 10_000
const SHUTDOWN_TIMEOUT_MS = 2_000

export interface ResolveSidecarPathOptions {
  appPath: string
  resourcesPath: string
  isPackaged: boolean
  platform?: typeof process.platform
  override?: string
}

export function resolveHoshidictsExecutable ({
  appPath,
  resourcesPath,
  isPackaged,
  platform = process.platform,
  override = process.env.HAYASE_HOSHIDICTS_PATH
}: ResolveSidecarPathOptions) {
  const executable = `hoshidicts-sidecar${platform === 'win32' ? '.exe' : ''}`
  if (override) return isAbsolute(override) ? override : resolve(override)
  if (isPackaged) return join(resourcesPath, 'sidecars', executable)
  return join(appPath, 'resources', 'sidecars', executable)
}

export interface HoshidictsSupervisorOptions {
  executable: string
  dictionaryRoot: string
  onEvent: (event: MiningDictionaryEvent) => void
}

export default class HoshidictsSupervisor {
  private child?: ChildProcessWithoutNullStreams
  private client?: HoshidictsClient
  private startPromise?: Promise<void>
  private restartTimer?: ReturnType<typeof setTimeout>
  private crashTimes: number[] = []
  private readonly activeImportPaths = new Set<string>()
  private stopping = false
  private permanentlyStopped = false

  constructor (private readonly options: HoshidictsSupervisorOptions) {}

  async start () {
    if (this.client) return
    if (this.permanentlyStopped) {
      throw new HoshidictsError({ code: 'BACKEND_UNAVAILABLE', message: 'Dictionary backend stopped after repeated crashes' })
    }
    if (this.startPromise) return await this.startPromise

    this.startPromise = this.spawnAndHandshake()
    try {
      await this.startPromise
    } finally {
      this.startPromise = undefined
    }
  }

  async state (): Promise<MiningDictionaryState> {
    try {
      await this.start()
      return normalizeState(await this.request<unknown>('state'))
    } catch (error) {
      return emptyUnavailableState(toPublicMessage(error))
    }
  }

  async lookup (request: MiningDictionaryLookupRequest): Promise<MiningDictionaryLookupResult> {
    validateLookupRequest(request)
    await this.start()
    const client = this.client
    if (!client) throw new HoshidictsError({ code: 'BACKEND_UNAVAILABLE', message: 'Dictionary backend is unavailable' })
    return normalizeLookupResult(await client.requestLatestLookup<unknown>(request))
  }

  async import (paths: string[]): Promise<MiningDictionaryState> {
    if (!paths.length) return await this.state()
    await this.start()
    for (const path of paths) this.activeImportPaths.add(path)
    try {
      return this.notifyStateChanged(normalizeState(await this.request<unknown>('import', { paths }, 0)))
    } finally {
      for (const path of paths) this.activeImportPaths.delete(path)
    }
  }

  async setEnabled (id: string, kind: MiningDictionaryKind, enabled: boolean): Promise<MiningDictionaryState> {
    validateId(id)
    validateKind(kind)
    await this.start()
    return this.notifyStateChanged(normalizeState(await this.request<unknown>('setEnabled', { id, kind, enabled }, 0)))
  }

  async reorder (kind: MiningDictionaryKind, ids: string[]): Promise<MiningDictionaryState> {
    validateKind(kind)
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !id)) {
      throw new HoshidictsError({ code: 'INVALID_REQUEST', message: 'Dictionary order contains an invalid id' })
    }
    if (new Set(ids).size !== ids.length) {
      throw new HoshidictsError({ code: 'INVALID_REQUEST', message: 'Dictionary order contains duplicate ids' })
    }
    await this.start()
    return this.notifyStateChanged(normalizeState(await this.request<unknown>('reorder', { kind, ids }, 0)))
  }

  async remove (id: string): Promise<MiningDictionaryState> {
    validateId(id)
    await this.start()
    return this.notifyStateChanged(normalizeState(await this.request<unknown>('remove', { id }, 0)))
  }

  async shutdown () {
    if (this.stopping) return
    this.stopping = true
    this.permanentlyStopped = true
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = undefined

    const child = this.child
    const client = this.client
    this.client = undefined
    this.child = undefined
    if (!child || !client) return

    try {
      await client.request('shutdown', {}, SHUTDOWN_TIMEOUT_MS)
    } catch {}

    if (child.exitCode == null && child.signalCode == null) {
      await Promise.race([
        new Promise<void>(resolve => child.once('exit', () => resolve())),
        new Promise<void>(resolve => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS))
      ])
    }
    if (child.exitCode == null && child.signalCode == null) child.kill()
    client.close()
  }

  private async spawnAndHandshake () {
    await mkdir(this.options.dictionaryRoot, { recursive: true })
    await access(this.options.executable, process.platform === 'win32' ? constants.F_OK : constants.X_OK)

    const child = spawn(this.options.executable, ['--dictionary-root', this.options.dictionaryRoot], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    this.child = child

    const client = new HoshidictsClient(child, {
      onEvent: event => this.forwardEvent(event),
      onProtocolError: error => log.error('[hoshidicts] protocol error:', error)
    })
    this.client = client

    child.stderr.on('data', data => log.info(`[hoshidicts] ${String(data).trimEnd()}`))
    child.once('error', error => {
      log.error('[hoshidicts] process error:', error)
    })
    child.once('exit', (code, signal) => this.handleExit(child, client, code, signal))

    try {
      const hello = await client.request<HoshidictsHello>('hello', { protocolVersion: PROTOCOL_VERSION }, HANDSHAKE_TIMEOUT_MS)
      if (hello.protocolVersion !== PROTOCOL_VERSION) {
        throw new HoshidictsError({
          code: 'PROTOCOL_VERSION_MISMATCH',
          message: `Unsupported dictionary protocol version ${hello.protocolVersion}`
        })
      }
      log.info(`[hoshidicts] backend ${hello.backendVersion} ready`)
    } catch (error) {
      client.close(error instanceof Error ? error : new Error(String(error)))
      child.kill()
      if (this.client === client) this.client = undefined
      if (this.child === child) this.child = undefined
      throw error
    }
  }

  private async request<T> (method: string, params: unknown = {}, timeoutMs?: number): Promise<T> {
    const client = this.client
    if (!client) throw new HoshidictsError({ code: 'BACKEND_UNAVAILABLE', message: 'Dictionary backend is unavailable' })
    return await client.request<T>(method, params, timeoutMs)
  }

  private handleExit (
    child: ChildProcessWithoutNullStreams,
    client: HoshidictsClient,
    code: number | null,
    signal: string | null
  ) {
    client.close()
    if (this.child === child) this.child = undefined
    if (this.client === client) this.client = undefined
    if (this.stopping) return

    log.error(`[hoshidicts] exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'null'})`)
    const now = Date.now()
    this.crashTimes = this.crashTimes.filter(time => now - time < CRASH_WINDOW_MS)
    this.crashTimes.push(now)

    const attempt = this.crashTimes.length
    if (attempt > RESTART_DELAYS.length) {
      this.permanentlyStopped = true
      this.options.onEvent({
        event: 'backendError',
        data: { code: 'BACKEND_CRASH_LOOP', message: 'Dictionary backend stopped after repeated crashes' }
      })
      return
    }

    const delay = RESTART_DELAYS[attempt - 1] ?? 4_000
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined
      this.start().catch(error => {
        log.error('[hoshidicts] restart failed:', error)
        this.options.onEvent({
          event: 'backendError',
          data: { code: 'BACKEND_RESTART_FAILED', message: toPublicMessage(error) }
        })
      })
    }, delay)
  }

  private forwardEvent (event: SidecarEvent) {
    if (event.event === 'importProgress' && isRecord(event.data)) {
      const data = event.data
      this.options.onEvent({
        event: 'importProgress',
        data: {
          operationId: stringValue(data.operationId),
          fileIndex: numberValue(data.fileIndex),
          fileCount: numberValue(data.fileCount),
          fileName: basename(stringValue(data.fileName ?? data.file)),
          dictionary: typeof data.dictionary === 'string' ? data.dictionary : undefined,
          phase: stringValue(data.phase),
          completed: numberValue(data.completed),
          total: numberValue(data.total)
        }
      })
    } else if (event.event === 'importError' && isRecord(event.data)) {
      const data = event.data
      this.options.onEvent({
        event: 'importError',
        data: {
          operationId: stringValue(data.operationId),
          fileIndex: numberValue(data.fileIndex),
          fileCount: numberValue(data.fileCount),
          fileName: basename(stringValue(data.fileName ?? data.file)),
          code: stringValue(data.code) || 'IMPORT_FAILED',
          message: this.sanitizeMessage(stringValue(data.message) || 'Dictionary import failed')
        }
      })
    } else if (event.event === 'stateChanged' && isRecord(event.data)) {
      if ('available' in event.data) {
        try {
          this.options.onEvent({ event: 'stateChanged', data: normalizeState(event.data) })
        } catch (error) {
          log.error('[hoshidicts] invalid stateChanged event:', error)
        }
      } else {
        this.state()
          .then(state => this.options.onEvent({ event: 'stateChanged', data: state }))
          .catch(error => log.error('[hoshidicts] failed to refresh stateChanged event:', error))
      }
    } else if (event.event === 'backendError' && isRecord(event.data)) {
      this.options.onEvent({
        event: 'backendError',
        data: {
          code: stringValue(event.data.code) || 'BACKEND_ERROR',
          message: this.sanitizeMessage(stringValue(event.data.message) || 'Dictionary backend error')
        }
      })
    }
  }

  private sanitizeMessage (message: string) {
    let sanitized = message
      .replaceAll(this.options.dictionaryRoot, 'dictionary storage')
      .replaceAll(this.options.executable, basename(this.options.executable))
    for (const path of this.activeImportPaths) sanitized = sanitized.replaceAll(path, basename(path))
    return sanitized
  }

  private notifyStateChanged (state: MiningDictionaryState) {
    this.options.onEvent({ event: 'stateChanged', data: state })
    return state
  }
}

function validateLookupRequest (request: MiningDictionaryLookupRequest) {
  if (typeof request.text !== 'string' || !Number.isSafeInteger(request.offset) || request.offset < 0 || request.offset > request.text.length) {
    throw new HoshidictsError({ code: 'INVALID_REQUEST', message: 'Dictionary lookup offset is invalid' })
  }
  if (!Number.isSafeInteger(request.maxResults) || request.maxResults < 1 || request.maxResults > 100) {
    throw new HoshidictsError({ code: 'INVALID_REQUEST', message: 'Dictionary lookup result limit is invalid' })
  }
  if (!Number.isSafeInteger(request.scanLength) || request.scanLength < 1 || request.scanLength > 256) {
    throw new HoshidictsError({ code: 'INVALID_REQUEST', message: 'Dictionary lookup scan length is invalid' })
  }
}

function validateId (id: string) {
  if (typeof id !== 'string' || !id || id.length > 256) {
    throw new HoshidictsError({ code: 'INVALID_REQUEST', message: 'Dictionary id is invalid' })
  }
}

function validateKind (kind: string): asserts kind is MiningDictionaryKind {
  if (kind !== 'term' && kind !== 'frequency' && kind !== 'pitch') {
    throw new HoshidictsError({ code: 'INVALID_REQUEST', message: 'Dictionary kind is invalid' })
  }
}

function emptyUnavailableState (error: string): MiningDictionaryState {
  return {
    available: false,
    generation: 0,
    error,
    dictionaries: [],
    order: { term: [], frequency: [], pitch: [] },
    styles: {}
  }
}

function toPublicMessage (error: unknown) {
  if (error instanceof HoshidictsError) return error.message
  return 'Dictionary backend is unavailable'
}

function isRecord (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value)
}

function stringValue (value: unknown) {
  return typeof value === 'string' ? value : ''
}

function numberValue (value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function normalizeState (value: unknown): MiningDictionaryState {
  const state = protocolRecord(value, 'state')
  const dictionaries = protocolArray(state.dictionaries, 'state dictionaries').map(value => {
    const dictionary = protocolRecord(value, 'dictionary')
    const counts = protocolRecord(dictionary.counts, 'dictionary counts')
    const enabled = protocolRecord(dictionary.enabled, 'dictionary enabled state')
    return {
      id: protocolString(dictionary.id, 'dictionary id'),
      title: protocolString(dictionary.title, 'dictionary title'),
      revision: protocolString(dictionary.revision, 'dictionary revision'),
      format: protocolNumber(dictionary.format, 'dictionary format'),
      counts: {
        term: protocolNumber(counts.term, 'term count'),
        frequency: protocolNumber(counts.frequency, 'frequency count'),
        pitch: protocolNumber(counts.pitch, 'pitch count'),
        media: protocolNumber(counts.media, 'media count')
      },
      enabled: {
        term: protocolBoolean(enabled.term, 'term enabled state'),
        frequency: protocolBoolean(enabled.frequency, 'frequency enabled state'),
        pitch: protocolBoolean(enabled.pitch, 'pitch enabled state')
      }
    }
  })
  const order = protocolRecord(state.order, 'dictionary order')
  const styles = protocolRecord(state.styles, 'dictionary styles')
  const normalizedStyles: Record<string, string> = {}
  for (const [dictionary, css] of Object.entries(styles)) {
    normalizedStyles[dictionary] = protocolString(css, 'dictionary stylesheet')
  }

  return {
    available: protocolBoolean(state.available, 'backend availability'),
    generation: protocolNumber(state.generation, 'state generation'),
    error: typeof state.error === 'string' ? state.error : undefined,
    dictionaries,
    order: {
      term: protocolStringArray(order.term, 'term dictionary order'),
      frequency: protocolStringArray(order.frequency, 'frequency dictionary order'),
      pitch: protocolStringArray(order.pitch, 'pitch dictionary order')
    },
    styles: normalizedStyles
  }
}

function normalizeLookupResult (value: unknown): MiningDictionaryLookupResult {
  const result = protocolRecord(value, 'lookup result')
  return {
    length: protocolNumber(result.length, 'lookup match length'),
    entries: protocolArray(result.entries, 'lookup entries').map(normalizeLookupEntry)
  }
}

function normalizeLookupEntry (value: unknown): MiningDictionaryEntry {
  const entry = protocolRecord(value, 'lookup entry')
  return {
    expression: protocolString(entry.expression, 'entry expression'),
    reading: protocolString(entry.reading, 'entry reading'),
    matched: protocolString(entry.matched, 'entry match'),
    deinflected: protocolString(entry.deinflected, 'deinflected expression'),
    trace: protocolArray(entry.trace, 'deinflection trace').map(value => {
      const trace = protocolRecord(value, 'deinflection trace item')
      return {
        name: protocolString(trace.name, 'deinflection name'),
        description: protocolString(trace.description, 'deinflection description')
      }
    }),
    rules: protocolStringArray(entry.rules, 'entry rules'),
    glossaries: protocolArray(entry.glossaries, 'entry glossaries').map(value => {
      const glossary = protocolRecord(value, 'glossary')
      return {
        dictionary: protocolString(glossary.dictionary, 'glossary dictionary'),
        content: protocolString(glossary.content, 'glossary content'),
        definitionTags: protocolString(glossary.definitionTags, 'glossary definition tags'),
        termTags: protocolString(glossary.termTags, 'glossary term tags')
      }
    }),
    frequencies: protocolArray(entry.frequencies, 'entry frequencies').map(value => {
      const frequency = protocolRecord(value, 'frequency group')
      return {
        dictionary: protocolString(frequency.dictionary, 'frequency dictionary'),
        frequencies: protocolArray(frequency.frequencies, 'frequency values').map(value => {
          const item = protocolRecord(value, 'frequency value')
          return {
            value: protocolNumber(item.value, 'frequency value'),
            displayValue: protocolString(item.displayValue, 'frequency display value')
          }
        })
      }
    }),
    pitches: protocolArray(entry.pitches, 'entry pitches').map(value => {
      const pitch = protocolRecord(value, 'pitch group')
      return {
        dictionary: protocolString(pitch.dictionary, 'pitch dictionary'),
        pitchPositions: protocolNumberArray(pitch.pitchPositions, 'pitch positions'),
        transcriptions: protocolStringArray(pitch.transcriptions, 'pitch transcriptions')
      }
    })
  }
}

function protocolRecord (value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) throw protocolDataError(name)
  return value
}

function protocolArray (value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw protocolDataError(name)
  return value
}

function protocolString (value: unknown, name: string) {
  if (typeof value !== 'string') throw protocolDataError(name)
  return value
}

function protocolNumber (value: unknown, name: string) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw protocolDataError(name)
  return value
}

function protocolBoolean (value: unknown, name: string) {
  if (typeof value !== 'boolean') throw protocolDataError(name)
  return value
}

function protocolStringArray (value: unknown, name: string) {
  return protocolArray(value, name).map(item => protocolString(item, name))
}

function protocolNumberArray (value: unknown, name: string) {
  return protocolArray(value, name).map(item => protocolNumber(item, name))
}

function protocolDataError (name: string) {
  return new HoshidictsError({ code: 'PROTOCOL_ERROR', message: `Dictionary backend returned invalid ${name}` })
}
