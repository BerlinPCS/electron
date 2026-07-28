import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { basename, extname } from 'node:path'

import { isCanonicalBase64 } from './base64.ts'
import {
  type MiningCaptureSpec,
  type MiningEncodedMedia,
  MAX_MINING_MEDIA_BYTES,
  type MiningMediaEncoder,
  validateMiningCaptureSpec
} from './mining-media.ts'

export type MiningAnkiDuplicateScope = 'collection' | 'deck' | 'deckRoot'

export interface MiningAnkiSettings {
  endpoint: string
  apiKey: string
  deckName?: string
  modelName?: string
  fieldMappings: Record<string, string>
  tags: string
  allowDuplicates: boolean
  duplicateScope: MiningAnkiDuplicateScope
  checkAllModels: boolean
  forceSync: boolean
  showNotes: boolean
}

export type MiningAnkiSettingsPatch = Partial<MiningAnkiSettings>

export interface MiningAnkiModel {
  name: string
  fields: string[]
}

export interface MiningAnkiState {
  available: boolean
  connectionStatus: 'unknown' | 'connected' | 'disconnected'
  mediaCapture: {
    available: boolean
    error?: string
  }
  settings: Omit<MiningAnkiSettings, 'apiKey'> & { hasApiKey: boolean }
  decks: string[]
  models: MiningAnkiModel[]
  error?: string
}

export interface MiningAnkiEvent {
  event: 'stateChanged'
  data: MiningAnkiState
}

export interface MiningAnkiMedia {
  kind: 'screenshot' | 'audio' | 'dictionary' | 'wordAudio'
  filename: string
  mimeType: string
  /** Base64-encoded bytes. Data URLs are deliberately not accepted. */
  data: string
}

export interface MiningAnkiAddRequest {
  payload: {
    expression: string
    audio?: string
    dictionaryMedia?: Array<{ dictionary: string, path: string, filename: string }>
    [key: string]: unknown
  }
  context: {
    sentence: string
    selectedText: string
    title: string
    timestamp: number
    sentenceOffset?: number
    capture?: MiningCaptureSpec
    media?: MiningAnkiMedia[]
  }
}

export interface MiningAnkiDuplicateRequest {
  expression: string
}

export interface MiningAnkiShowNotesRequest {
  expression: string
}

export type MiningAnkiConnectionResult =
  | { status: 'success' }
  | { status: 'error', message: string }

export type MiningAnkiDuplicateResult =
  | { status: 'success', duplicate: boolean }
  | { status: 'error', message: string }

export type MiningAnkiAddResult =
  | { status: 'success', noteId?: number, warning?: string }
  | { status: 'duplicate' }
  | { status: 'error', message: string }

export type MiningAnkiShowNotesResult =
  | { status: 'success', cardIds: number[] }
  | { status: 'error', message: string }

export const DEFAULT_MINING_ANKI_SETTINGS: MiningAnkiSettings = {
  endpoint: 'http://127.0.0.1:8765',
  apiKey: '',
  fieldMappings: {},
  tags: 'HayatanMining',
  allowDuplicates: false,
  duplicateScope: 'collection',
  checkAllModels: false,
  forceSync: false,
  showNotes: true
}

interface AnkiConnectResponse<T> {
  result: T
  error: string | null
}

interface AnkiConnectAction {
  action: string
  params?: Record<string, unknown>
}

interface AnkiConnectNote {
  deckName: string
  modelName: string
  fields: Record<string, string>
  tags?: string[]
  options: {
    allowDuplicate: boolean
    duplicateScope: 'collection' | 'deck'
    duplicateScopeOptions?: {
      deckName?: string
      checkChildren?: boolean
      checkAllModels?: boolean
    }
  }
}

interface MiningAnkiStorage {
  read: () => MiningAnkiSettings
  write: (settings: MiningAnkiSettings) => void
}

export interface MiningAnkiHostMedia {
  filename: string
  mimeType: string
  data: Uint8Array
}

export interface MiningAnkiMediaLoaders {
  loadDictionaryMedia?: (dictionary: string, path: string) => Promise<Uint8Array>
  loadWordAudio?: (url: string) => Promise<MiningAnkiHostMedia>
}

type Fetch = typeof globalThis.fetch

export class AnkiConnectClient {
  readonly endpoint: string
  private readonly apiKey: string
  private readonly fetch: Fetch

  constructor (endpoint: string, apiKey = '', fetchImplementation: Fetch = globalThis.fetch) {
    this.endpoint = validateAnkiEndpoint(endpoint)
    this.apiKey = validateString(apiKey, 'AnkiConnect API key', 4096)
    this.fetch = fetchImplementation
  }

  async request<T> (action: string, params?: Record<string, unknown>): Promise<T> {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(action)) throw new Error('Invalid AnkiConnect action.')
    const body: Record<string, unknown> = { action, version: 6 }
    if (params) body.params = params
    if (this.apiKey) body.key = this.apiKey

    let response: Response
    try {
      response = await this.fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000)
      })
    } catch (error) {
      throw new Error(`Unable to connect to AnkiConnect: ${errorMessage(error)}`)
    }
    if (!response.ok) throw new Error(`AnkiConnect returned HTTP ${response.status}.`)

    let envelope: unknown
    try {
      envelope = await response.json()
    } catch {
      throw new Error('AnkiConnect returned invalid JSON.')
    }
    if (!isRecord(envelope) || !('result' in envelope) || !('error' in envelope)) {
      throw new Error('AnkiConnect returned an invalid response.')
    }
    const typed = envelope as unknown as AnkiConnectResponse<T>
    if (typed.error != null) {
      if (typeof typed.error !== 'string') throw new Error('AnkiConnect returned an invalid error.')
      throw new Error(typed.error)
    }
    return typed.result
  }

  async ping () {
    const version = await this.request<unknown>('version')
    if (typeof version !== 'number') throw new Error('AnkiConnect returned an invalid version.')
  }

  async multi (actions: AnkiConnectAction[]): Promise<unknown[]> {
    if (!actions.length) return []
    for (const { action } of actions) {
      if (!/^[A-Za-z][A-Za-z0-9]*$/.test(action) || action === 'multi') {
        throw new Error('Invalid AnkiConnect action.')
      }
    }

    const responses = await this.request<unknown>('multi', { actions })
    if (!Array.isArray(responses) || responses.length !== actions.length) {
      throw new Error('AnkiConnect returned an invalid multi response.')
    }
    return responses
  }

  async detect (): Promise<{ decks: string[], models: MiningAnkiModel[] }> {
    const [decksValue, modelNamesValue] = await this.multi([
      { action: 'deckNames' },
      { action: 'modelNames' }
    ])
    const decks = validateStringArray(decksValue, 'deck names').sort(compareNames)
    const modelNames = validateStringArray(modelNamesValue, 'model names')
    const fieldValues = await this.multi(modelNames.map(modelName => ({
      action: 'modelFieldNames',
      params: { modelName }
    })))
    const models = modelNames.map((name, index) => ({
      name,
      fields: validateStringArray(fieldValues[index], `fields for ${name}`)
    }))
    return { decks, models: models.sort((a, b) => compareNames(a.name, b.name)) }
  }

  async storeMedia (media: MiningAnkiMedia): Promise<string> {
    const normalized = validateMedia(media)
    const result = await this.request<unknown>('storeMediaFile', {
      filename: normalized.filename,
      data: normalized.data
    })
    if (typeof result !== 'string' || !result) throw new Error('AnkiConnect did not store the media file.')
    return result
  }

  async storeMediaBytes (media: MiningAnkiHostMedia): Promise<string> {
    return await this.storeMedia({
      kind: media.mimeType.startsWith('audio/') ? 'wordAudio' : 'dictionary',
      filename: media.filename,
      mimeType: media.mimeType,
      data: Buffer.from(media.data).toString('base64')
    })
  }

  async deleteMedia (filename: string): Promise<void> {
    await this.request<unknown>('deleteMediaFile', { filename })
  }

  checkNote (note: AnkiConnectNote) {
    return this.request<unknown>('canAddNotesWithErrorDetail', { notes: [note] })
  }

  addNote (note: AnkiConnectNote) {
    return this.request<unknown>('addNote', { note })
  }

  sync () {
    return this.request<unknown>('sync')
  }

  browse (query: string) {
    return this.request<unknown>('guiBrowse', { query })
  }
}

export class MiningAnkiService {
  private decks: string[] = []
  private models: MiningAnkiModel[] = []
  private error?: string
  private connectionStatus: MiningAnkiState['connectionStatus'] = 'unknown'
  private monitorTimer?: ReturnType<typeof setTimeout>
  private monitorStarted = false
  private offlineAttempt = 0
  private lastReachableAt = 0
  private probePromise?: Promise<MiningAnkiConnectionResult>
  private detectPromise?: Promise<{ decks: string[], models: MiningAnkiModel[] }>
  private fetchTail = Promise.resolve()
  private readonly queuedFetch: Fetch = async (input, init) => {
    const previous = this.fetchTail
    let release!: () => void
    this.fetchTail = new Promise<void>(resolve => { release = resolve })
    await previous
    try {
      return await this.fetchImplementation(input, init)
    } finally {
      release()
    }
  }

  constructor (
    private readonly storage: MiningAnkiStorage,
    private readonly fetchImplementation: Fetch = globalThis.fetch,
    private readonly mediaLoaders: MiningAnkiMediaLoaders = {},
    private readonly onEvent?: (event: MiningAnkiEvent) => void,
    private readonly mediaEncoder?: MiningMediaEncoder
  ) {}

  state (): MiningAnkiState {
    const settings = sanitizeSettings(this.storage.read())
    return {
      available: Boolean(settings.deckName && settings.modelName),
      connectionStatus: this.connectionStatus,
      mediaCapture: this.mediaEncoder?.state() ?? {
        available: false,
        error: 'Native media capture is unavailable.'
      },
      settings: redactSettings(settings),
      decks: [...this.decks],
      models: this.models.map(model => ({ ...model, fields: [...model.fields] })),
      ...(this.error ? { error: this.error } : {})
    }
  }

  updateSettings (patch: MiningAnkiSettingsPatch): MiningAnkiState {
    const current = sanitizeSettings(this.storage.read())
    const settings = sanitizeSettings({ ...current, ...validateSettingsPatch(patch) })
    this.storage.write(settings)
    this.error = undefined
    if ('endpoint' in patch || 'apiKey' in patch) {
      this.connectionStatus = 'unknown'
      this.offlineAttempt = 0
      this.scheduleProbe(0)
    }
    this.emitState()
    return this.state()
  }

  async ping (): Promise<MiningAnkiConnectionResult> {
    return await this.probeReachability()
  }

  startMonitoring () {
    if (this.monitorStarted) return
    this.monitorStarted = true
    this.scheduleProbe(0)
  }

  stopMonitoring () {
    this.monitorStarted = false
    if (this.monitorTimer) clearTimeout(this.monitorTimer)
    this.monitorTimer = undefined
    this.mediaEncoder?.stop()
  }

  notifyActivity () {
    if (!this.monitorStarted || !this.state().available) return
    this.scheduleProbe(0)
  }

  async probeReachability (): Promise<MiningAnkiConnectionResult> {
    if (this.probePromise) return await this.probePromise
    this.probePromise = (async () => {
      try {
        await this.client().ping()
        if (!this.models.length) {
          const detected = await this.detectConfiguration()
          this.decks = detected.decks
          this.models = detected.models
        }
        this.setConnectionState('connected')
        return { status: 'success' } as const
      } catch (error) {
        const message = errorMessage(error)
        this.setConnectionState('disconnected', message)
        return { status: 'error', message } as const
      } finally {
        this.probePromise = undefined
        const delay = this.connectionStatus === 'connected'
          ? 60_000
          : offlineRetryDelay(this.offlineAttempt++)
        this.scheduleProbe(delay)
      }
    })()
    return await this.probePromise
  }

  async detect (): Promise<MiningAnkiState> {
    try {
      const detected = await this.detectConfiguration()
      if (!detected.decks.length) throw new Error('No Anki decks were found.')
      if (!detected.models.length) throw new Error('No Anki note types were found.')
      this.decks = detected.decks
      this.models = detected.models

      const current = sanitizeSettings(this.storage.read())
      const deckName = detected.decks.includes(current.deckName ?? '')
        ? current.deckName
        : detected.decks.find(deck => deck.toLowerCase() !== 'default') ?? detected.decks[0]
      const model = detected.models.find(model => model.name === current.modelName) ??
        detected.models.find(model => model.name in HOSHI_DEFAULT_MAPPINGS) ??
        detected.models[0]
      if (!model) throw new Error('No Anki note types were found.')
      const hasMappedSelectedField = model.fields.some(field => current.fieldMappings[field] != null)
      const defaults = HOSHI_DEFAULT_MAPPINGS[model.name] ?? {}
      const fieldMappings = hasMappedSelectedField
        ? current.fieldMappings
        : Object.fromEntries(model.fields.flatMap(field => defaults[field] == null ? [] : [[field, defaults[field]]]))

      this.storage.write(sanitizeSettings({ ...current, deckName, modelName: model.name, fieldMappings }))
      this.setConnectionState('connected')
    } catch (error) {
      this.error = errorMessage(error)
      if (isConnectionError(error)) this.setConnectionState('disconnected', this.error)
    }
    this.emitState()
    return this.state()
  }

  async checkDuplicate (request: MiningAnkiDuplicateRequest): Promise<MiningAnkiDuplicateResult> {
    try {
      if (!isRecord(request)) throw new Error('Invalid duplicate-check request.')
      const expression = validateString(request.expression, 'Expression', 16_384).trim()
      if (!expression) return { status: 'success', duplicate: false }
      await this.requireReachable()
      const settings = this.requireConfigured()
      const firstField = (await this.selectedModel(settings)).fields[0]
      if (!firstField) throw new Error('The selected Anki note type has no fields.')
      const note = this.note(settings, { [firstField]: expression })
      // Duplicate status remains useful to the UI even when adding duplicates is allowed.
      note.options.allowDuplicate = false
      const duplicate = !parseCanAdd(await this.client().checkNote(note))
      this.setConnectionState('connected')
      return { status: 'success', duplicate }
    } catch (error) {
      this.recordOperationFailure(error)
      return { status: 'error', message: errorMessage(error) }
    }
  }

  async addNote (request: MiningAnkiAddRequest): Promise<MiningAnkiAddResult> {
    const startedAt = performance.now()
    const timings: Record<string, number> = {}
    const storedMedia: string[] = []
    let client: AnkiConnectClient | undefined
    let noteAdded = false
    try {
      const validated = validateAddRequest(request)
      await this.requireReachable()
      const settings = this.requireConfigured()
      const model = await this.selectedModel(settings)
      const values = templateValues(validated)
      const fields = Object.fromEntries(model.fields.flatMap(field => {
        const template = settings.fieldMappings[field]
        return template == null ? [] : [[field, renderTemplate(template, values)]]
      }))
      if (!Object.keys(fields).length) throw new Error('No fields are mapped for the selected Anki note type.')

      const note = this.note(settings, fields)
      client = this.client()
      if (!settings.allowDuplicates && !parseCanAdd(await client.checkNote(note))) {
        timings.duplicateCheck = elapsed(startedAt)
        timings.total = timings.duplicateCheck
        console.debug('[mining-anki] timings', timings)
        this.setConnectionState('connected')
        return { status: 'duplicate' }
      }
      timings.duplicateCheck = elapsed(startedAt)

      const replacements = await this.storeRequestMedia(validated, note.fields, client, storedMedia, timings)
      note.fields = Object.fromEntries(Object.entries(note.fields).map(([field, value]) => [
        field,
        replaceMediaReferences(value, replacements)
      ]))
      const addStartedAt = performance.now()
      const noteId = await client.addNote(note)
      timings.addNote = elapsed(addStartedAt)
      if (typeof noteId !== 'number' || !Number.isSafeInteger(noteId)) {
        throw new Error('AnkiConnect did not return a valid note ID.')
      }
      noteAdded = true
      let warning: string | undefined
      if (settings.forceSync) {
        try {
          await client.sync()
        } catch (error) {
          warning = `The note was added, but Anki sync failed: ${errorMessage(error)}`
          this.recordOperationFailure(error)
        }
      }
      if (!warning) this.setConnectionState('connected')
      timings.total = elapsed(startedAt)
      console.debug('[mining-anki] timings', timings)
      return { status: 'success', noteId, ...(warning ? { warning } : {}) }
    } catch (error) {
      if (!noteAdded && client && storedMedia.length) await this.removeStoredMedia(client, storedMedia)
      timings.total = elapsed(startedAt)
      console.debug('[mining-anki] timings', timings)
      this.recordOperationFailure(error)
      const message = errorMessage(error)
      if (/duplicate/i.test(message)) return { status: 'duplicate' }
      return { status: 'error', message }
    }
  }

  async showNotes (request: MiningAnkiShowNotesRequest): Promise<MiningAnkiShowNotesResult> {
    try {
      if (!isRecord(request)) throw new Error('Invalid show-notes request.')
      const expression = validateString(request.expression, 'Expression', 16_384).trim()
      if (!expression) throw new Error('Expression is required to show notes.')
      await this.requireReachable()
      const settings = this.requireConfigured()
      if (!settings.showNotes) throw new Error('Showing notes is disabled in Anki settings.')
      const firstField = (await this.selectedModel(settings)).fields[0]
      if (!firstField) throw new Error('The selected Anki note type has no fields.')
      const { modelName } = settings
      if (!modelName) throw new Error('Fetch and select an Anki note type first.')
      const query = [
        `note:"${escapeAnkiSearch(modelName)}"`,
        `"${escapeAnkiSearch(firstField)}:${escapeAnkiSearch(expression)}"`
      ].join(' ')
      const result = await this.client().browse(query)
      if (!Array.isArray(result) || result.some(id => typeof id !== 'number' || !Number.isSafeInteger(id))) {
        throw new Error('AnkiConnect returned invalid card IDs.')
      }
      this.setConnectionState('connected')
      return { status: 'success', cardIds: result }
    } catch (error) {
      this.recordOperationFailure(error)
      return { status: 'error', message: errorMessage(error) }
    }
  }

  private client () {
    const settings = sanitizeSettings(this.storage.read())
    return new AnkiConnectClient(settings.endpoint, settings.apiKey, this.queuedFetch)
  }

  private requireConfigured () {
    const settings = sanitizeSettings(this.storage.read())
    if (!settings.deckName || !settings.modelName) throw new Error('Fetch and select an Anki deck and note type first.')
    return settings
  }

  private async selectedModel (settings: MiningAnkiSettings) {
    let model = this.models.find(model => model.name === settings.modelName)
    if (!model) {
      const detected = await this.detectConfiguration()
      this.decks = detected.decks
      this.models = detected.models
      model = detected.models.find(model => model.name === settings.modelName)
    }
    if (!model) throw new Error('Fetch the selected Anki note type again.')
    if (!model.fields.length) throw new Error('The selected Anki note type has no fields.')
    return model
  }

  private async detectConfiguration () {
    this.detectPromise ??= this.client().detect()
      .finally(() => {
        this.detectPromise = undefined
      })
    return await this.detectPromise
  }

  private note (settings: MiningAnkiSettings, fields: Record<string, string>): AnkiConnectNote {
    const deckName = settings.deckName
    const modelName = settings.modelName
    if (!deckName || !modelName) throw new Error('Fetch and select an Anki deck and note type first.')
    const duplicateScopeOptions: AnkiConnectNote['options']['duplicateScopeOptions'] = {}
    if (settings.duplicateScope === 'deckRoot') {
      duplicateScopeOptions.deckName = deckName.split('::')[0]
      duplicateScopeOptions.checkChildren = true
    }
    if (settings.checkAllModels) duplicateScopeOptions.checkAllModels = true
    return {
      deckName,
      modelName,
      fields,
      tags: settings.tags.split(/\s+/).filter(Boolean),
      options: {
        allowDuplicate: settings.allowDuplicates,
        duplicateScope: settings.duplicateScope === 'collection' ? 'collection' : 'deck',
        ...(Object.keys(duplicateScopeOptions).length ? { duplicateScopeOptions } : {})
      }
    }
  }

  private async storeRequestMedia (
    request: MiningAnkiAddRequest,
    fields: Record<string, string>,
    client: AnkiConnectClient,
    storedMedia: string[],
    timings: Record<string, number> = {}
  ) {
    const replacements = new Map<string, string>()
    const renderedFields = Object.values(fields).join('\n')
    const wordAudioSource = request.payload.audio
    const needsWordAudio = renderedFields.includes('{audio}') && Boolean(wordAudioSource)
    const wordStartedAt = performance.now()
    const wordPromise = needsWordAudio && wordAudioSource
      ? this.loadWordAudio(wordAudioSource).then(media => {
        timings.wordAudio = elapsed(wordStartedAt)
        return media
      })
      : Promise.resolve(undefined)
    const dictionaryDescriptors = (request.payload.dictionaryMedia ?? [])
      .filter(descriptor => renderedFields.includes(descriptor.filename))

    let wordAudio: MiningAnkiHostMedia | undefined
    let wordAudioDuration = 0
    const capture = request.context.capture
    if (capture?.syncAnimationToWordAudio && capture.imageMode === 'animated' && needsWordAudio) {
      wordAudio = await wordPromise
      const probeStartedAt = performance.now()
      wordAudioDuration = wordAudio
        ? await this.requireMediaEncoder().probeDuration(wordAudio) ?? 0
        : 0
      timings.wordAudioProbe = elapsed(probeStartedAt)
    }

    const encodeStartedAt = performance.now()
    const encodedPromise = capture && (capture.captureImage || capture.captureAudio)
      ? this.requireMediaEncoder().encode(capture, wordAudioDuration).finally(() => {
        timings.mediaEncode = elapsed(encodeStartedAt)
      })
      : Promise.resolve([] as MiningEncodedMedia[])
    const [encoded, resolvedWordAudio] = await Promise.all([
      encodedPromise,
      wordAudio ? Promise.resolve(wordAudio) : wordPromise
    ])
    wordAudio = resolvedWordAudio

    const storageStartedAt = performance.now()
    const store = async (media: MiningAnkiMedia | MiningAnkiHostMedia) => {
      const filename = uniqueAnkiMediaFilename(media.filename)
      const stored = isSerializedMiningMedia(media)
        ? await client.storeMedia({ ...media, filename })
        : await client.storeMediaBytes({ ...media, filename })
      storedMedia.push(stored)
      return stored
    }
    for (const item of request.context.media ?? []) {
      const placeholder = item.kind === 'audio' ? '{sentence-audio}' : `{${item.kind}}`
      if (!renderedFields.includes(placeholder)) continue
      const stored = await store(item)
      replacements.set(item.filename, mediaTag(item.mimeType, stored))
      replacements.set(placeholder, mediaTag(item.mimeType, stored))
    }
    for (const item of encoded) {
      const placeholder = item.kind === 'audio' ? '{sentence-audio}' : '{screenshot}'
      if (!renderedFields.includes(placeholder)) continue
      const stored = await store(item)
      replacements.set(item.filename, mediaTag(item.mimeType, stored))
      replacements.set(placeholder, mediaTag(item.mimeType, stored))
    }
    if (needsWordAudio && wordAudio) {
      replacements.set('{audio}', `[sound:${await store(wordAudio)}]`)
    }
    for (const descriptor of dictionaryDescriptors) {
      if (!this.mediaLoaders.loadDictionaryMedia) throw new Error('Dictionary media loading is unavailable.')
      const media = {
        filename: descriptor.filename,
        mimeType: mediaMimeType(descriptor.filename),
        data: await this.mediaLoaders.loadDictionaryMedia(descriptor.dictionary, descriptor.path)
      }
      const stored = await store(media)
      replacements.set(
        descriptor.filename,
        media.mimeType.startsWith('image/') ? `<img src="${escapeHtmlAttribute(stored)}">` : stored
      )
    }
    timings.mediaStorage = elapsed(storageStartedAt)
    return replacements
  }

  private async removeStoredMedia (client: AnkiConnectClient, filenames: string[]) {
    await Promise.allSettled(filenames.map(filename => client.deleteMedia(filename)))
  }

  private async loadWordAudio (source: string) {
    if (!this.mediaLoaders.loadWordAudio) throw new Error('Word audio loading is unavailable.')
    return await this.mediaLoaders.loadWordAudio(source)
  }

  private requireMediaEncoder () {
    const state = this.mediaEncoder?.state()
    if (!this.mediaEncoder || !state?.available) {
      throw new Error(state?.error ?? 'Native media capture is unavailable.')
    }
    return this.mediaEncoder
  }

  private async requireReachable () {
    if (this.connectionStatus === 'unknown') return
    if (this.connectionStatus === 'disconnected') {
      throw new Error(this.error ?? 'AnkiConnect is not reachable.')
    }
    if (Date.now() - this.lastReachableAt < 2_000) return
    const result = await this.probeReachability()
    if (result.status === 'error') throw new Error(result.message)
  }

  private recordOperationFailure (error: unknown) {
    if (isConnectionError(error)) this.setConnectionState('disconnected', errorMessage(error))
  }

  private setConnectionState (status: MiningAnkiState['connectionStatus'], error?: string) {
    const changed = this.connectionStatus !== status || this.error !== error
    this.connectionStatus = status
    this.error = error
    if (status === 'connected') {
      this.offlineAttempt = 0
      this.lastReachableAt = Date.now()
    }
    if (changed) this.emitState()
    if (this.monitorStarted) {
      this.scheduleProbe(status === 'connected' ? 60_000 : offlineRetryDelay(this.offlineAttempt))
    }
  }

  private emitState () {
    this.onEvent?.({ event: 'stateChanged', data: this.state() })
  }

  private scheduleProbe (delay: number) {
    if (!this.monitorStarted || !this.state().available) return
    if (this.monitorTimer) clearTimeout(this.monitorTimer)
    this.monitorTimer = setTimeout(() => {
      this.monitorTimer = undefined
      this.probeReachability().catch(() => {})
    }, delay)
    this.monitorTimer.unref()
  }
}

export function validateAnkiEndpoint (value: string) {
  const raw = validateString(value, 'AnkiConnect endpoint', 2048).trim()
  let endpoint: URL
  try {
    endpoint = new URL(raw)
  } catch {
    throw new Error('Invalid AnkiConnect endpoint.')
  }
  const allowedHost = endpoint.hostname === 'localhost' || endpoint.hostname === '127.0.0.1' || endpoint.hostname === '[::1]'
  if (!allowedHost || (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') ||
      endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('AnkiConnect endpoint must be an HTTP(S) localhost URL.')
  }
  return endpoint.toString()
}

export function parseCanAdd (value: unknown): boolean {
  if (!Array.isArray(value) || value.length !== 1 || !isRecord(value[0]) || typeof value[0].canAdd !== 'boolean') {
    throw new Error('AnkiConnect returned an invalid duplicate-check response.')
  }
  const result = value[0]
  if (!result.canAdd && typeof result.error === 'string' && result.error && !/duplicate/i.test(result.error)) {
    throw new Error(result.error)
  }
  return result.canAdd as boolean
}

function sanitizeSettings (value: unknown): MiningAnkiSettings {
  const source = isRecord(value) ? value : {}
  const duplicateScope = source.duplicateScope
  return {
    endpoint: validateAnkiEndpoint(validateString(
      source.endpoint ?? DEFAULT_MINING_ANKI_SETTINGS.endpoint,
      'AnkiConnect endpoint',
      2048
    )),
    apiKey: validateString(source.apiKey ?? '', 'AnkiConnect API key', 4096),
    ...(source.deckName ? { deckName: validateString(source.deckName, 'Deck name', 1024) } : {}),
    ...(source.modelName ? { modelName: validateString(source.modelName, 'Note type name', 1024) } : {}),
    fieldMappings: normalizeVideoFieldMappings(validateMappings(source.fieldMappings)),
    tags: validateString(source.tags ?? '', 'Tags', 4096),
    allowDuplicates: Boolean(source.allowDuplicates),
    duplicateScope: duplicateScope === 'deck' || duplicateScope === 'deckRoot' ? duplicateScope : 'collection',
    checkAllModels: Boolean(source.checkAllModels),
    forceSync: Boolean(source.forceSync),
    showNotes: source.showNotes == null ? DEFAULT_MINING_ANKI_SETTINGS.showNotes : Boolean(source.showNotes)
  }
}

function validateSettingsPatch (patch: MiningAnkiSettingsPatch): MiningAnkiSettingsPatch {
  if (!isRecord(patch)) throw new Error('Invalid Anki settings.')
  const allowed = new Set(Object.keys(DEFAULT_MINING_ANKI_SETTINGS).concat('deckName', 'modelName'))
  if (Object.keys(patch).some(key => !allowed.has(key))) throw new Error('Invalid Anki setting.')
  return patch
}

function redactSettings (settings: MiningAnkiSettings): MiningAnkiState['settings'] {
  const { apiKey, ...safe } = settings
  return { ...safe, fieldMappings: { ...safe.fieldMappings }, hasApiKey: Boolean(apiKey) }
}

function validateAddRequest (request: MiningAnkiAddRequest): MiningAnkiAddRequest {
  if (!isRecord(request) || !isRecord(request.payload) || !isRecord(request.context)) throw new Error('Invalid add-note request.')
  if (Object.keys(request.payload).length > 256) throw new Error('Mining payload is too large.')
  const payload: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(request.payload)) {
    if (key.length > 256 || !/^[\w-]+$/.test(key)) {
      throw new Error('Mining payload contains an invalid value.')
    }
    if (key === 'dictionaryMedia') {
      if (!Array.isArray(value) || value.length > 256) throw new Error('Dictionary media descriptors are invalid.')
      payload[key] = value.map(validateDictionaryMedia)
    } else if (['string', 'number', 'boolean', 'undefined'].includes(typeof value) || value === null) {
      payload[key] = typeof value === 'string' ? validateString(value, `Payload ${key}`, 2_000_000) : value
    } else {
      throw new Error('Mining payload contains an invalid value.')
    }
  }
  validateString(payload.expression, 'Expression', 16_384)
  const media = request.context.media ?? []
  if (!Array.isArray(media) || media.length > 64) throw new Error('Mining media is invalid.')
  media.forEach(validateMedia)
  const capture = request.context.capture == null
    ? undefined
    : validateMiningCaptureSpec(request.context.capture)
  return {
    payload: payload as MiningAnkiAddRequest['payload'],
    context: {
      sentence: validateString(request.context.sentence, 'Sentence', 100_000),
      selectedText: validateString(request.context.selectedText, 'Selected text', 100_000),
      title: validateString(request.context.title, 'Media title', 16_384),
      timestamp: validateTimestamp(request.context.timestamp),
      ...(request.context.sentenceOffset == null
        ? {}
        : { sentenceOffset: validateSentenceOffset(request.context.sentenceOffset, request.context.sentence.length) }),
      ...(capture ? { capture } : {}),
      media
    }
  }
}

function validateMedia (media: MiningAnkiMedia): MiningAnkiMedia {
  if (!isRecord(media) || !['screenshot', 'audio', 'dictionary', 'wordAudio'].includes(media.kind)) {
    throw new Error('Mining media has an invalid kind.')
  }
  const originalFilename = validateString(media.filename, 'Media filename', 1024)
  const filename = basename(originalFilename).replace(/[^\p{L}\p{N}_. -]/gu, '_')
  if (!filename || filename === '.' || filename === '..') throw new Error('Mining media has an invalid filename.')
  const mimeType = validateString(media.mimeType, 'Media MIME type', 256)
  if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(mimeType)) throw new Error('Mining media has an invalid MIME type.')
  const data = validateString(media.data, 'Media data', 140_000_000)
  if (!isCanonicalBase64(data)) {
    throw new Error('Mining media must contain base64-encoded bytes.')
  }
  const decoded = Buffer.from(data, 'base64')
  if (decoded.byteLength > MAX_MINING_MEDIA_BYTES) throw new Error('Mining media exceeds 25 MiB.')
  return { kind: media.kind, filename, mimeType, data }
}

function isSerializedMiningMedia (
  media: MiningAnkiMedia | MiningAnkiHostMedia
): media is MiningAnkiMedia {
  return typeof media.data === 'string'
}

function validateMappings (value: unknown) {
  const mappings = value ?? {}
  if (!isRecord(mappings) || Object.keys(mappings).length > 256) throw new Error('Anki field mappings are invalid.')
  return Object.fromEntries(Object.entries(mappings).map(([field, template]) => [
    validateString(field, 'Anki field name', 1024),
    validateString(template, 'Anki field template', 2_000_000)
  ]))
}

function normalizeVideoFieldMappings (mappings: Record<string, string>) {
  return Object.fromEntries(Object.entries(mappings).map(([field, template]) => [
    field,
    template
      .replaceAll('{sasayaki-audio}', '{sentence-audio}')
      .replaceAll('{book-cover}', '{screenshot}')
  ]))
}

function validateStringArray (value: unknown, label: string) {
  if (!Array.isArray(value) || value.length > 10_000 || value.some(item => typeof item !== 'string')) {
    throw new Error(`AnkiConnect returned invalid ${label}.`)
  }
  return [...new Set(value as string[])]
}

function validateString (value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length > maxLength) throw new Error(`${label} is invalid.`)
  return value
}

function validateTimestamp (value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new Error('Timestamp is invalid.')
  }
  return value
}

function templateValues (request: MiningAnkiAddRequest) {
  const payload = request.payload
  const values: Record<string, string> = {
    sentence: highlightedSentence(
      request.context.sentence,
      typeof payload.matched === 'string' ? payload.matched : payload.expression,
      request.context.sentenceOffset
    ),
    'popup-selection-text': typeof payload.popupSelectionText === 'string'
      ? escapeHtml(payload.popupSelectionText)
      : escapeHtml(request.context.selectedText),
    'selected-text': escapeHtml(request.context.selectedText),
    'document-title': escapeHtml(request.context.title),
    title: escapeHtml(request.context.title),
    timestamp: formatTimestamp(request.context.timestamp),
    'timestamp-seconds': String(request.context.timestamp),
    'furigana-plain': typeof payload.furiganaPlain === 'string' ? escapeHtml(payload.furiganaPlain) : '',
    frequencies: typeof payload.frequenciesHtml === 'string' ? payload.frequenciesHtml : '',
    'frequency-harmonic-rank': typeof payload.freqHarmonicRank === 'string' ? payload.freqHarmonicRank : '',
    'glossary-first': typeof payload.glossaryFirst === 'string' ? payload.glossaryFirst : '',
    'pitch-accent-positions': typeof payload.pitchPositions === 'string' ? payload.pitchPositions : '',
    'pitch-accent-categories': typeof payload.pitchCategories === 'string' ? payload.pitchCategories : '',
    'phonetic-transcriptions': typeof payload.phoneticTranscriptions === 'string' ? payload.phoneticTranscriptions : ''
  }
  for (const [key, value] of Object.entries(request.payload)) {
    if (key !== 'audio' && key !== 'dictionaryMedia' && ['string', 'number', 'boolean'].includes(typeof value)) {
      values[key] = richTemplateValue(key) ? String(value) : escapeHtml(String(value))
    }
  }
  return values
}

function highlightedSentence (sentence: string, matched: string, offset?: number) {
  if (!matched) return escapeHtml(sentence)
  if (offset != null && sentence.slice(offset, offset + matched.length) === matched) {
    return escapeHtml(sentence.slice(0, offset)) + `<b>${escapeHtml(matched)}</b>` + escapeHtml(sentence.slice(offset + matched.length))
  }
  const index = sentence.indexOf(matched)
  return index < 0
    ? escapeHtml(sentence)
    : escapeHtml(sentence.slice(0, index)) + `<b>${escapeHtml(matched)}</b>` + escapeHtml(sentence.slice(index + matched.length))
}

function formatTimestamp (seconds: number) {
  const milliseconds = Math.floor(seconds * 1000)
  const hours = Math.floor(milliseconds / 3_600_000)
  const minutes = Math.floor(milliseconds / 60_000) % 60
  const wholeSeconds = Math.floor(milliseconds / 1000) % 60
  const fraction = milliseconds % 1000
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')}.${String(fraction).padStart(3, '0')}`
}

function validateSentenceOffset (value: unknown, sentenceLength: number) {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > sentenceLength) {
    throw new Error('Sentence offset is invalid.')
  }
  return value as number
}

function renderTemplate (template: string, values: Record<string, string>) {
  return template.replace(/\{([\w-]+)\}/g, (whole, key: string) => values[key] ?? whole)
}

export function replaceMediaReferences (value: string, replacements: Map<string, string>) {
  let rendered = value
  for (const [reference, tag] of replacements) rendered = rendered.split(reference).join(tag)
  return rendered.replace(/\{(?:audio|sentence-audio|screenshot)\}/g, '')
}

function compareNames (a: string, b: string) {
  return a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true })
}

function escapeHtmlAttribute (value: string) {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeHtml (value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

const RICH_TEMPLATE_VALUES = new Set([
  'frequenciesHtml',
  'glossary',
  'glossaryFirst',
  'singleGlossaries',
  'pitchPositions',
  'pitchCategories',
  'phoneticTranscriptions'
])

function richTemplateValue (key: string) {
  return RICH_TEMPLATE_VALUES.has(key)
}

function uniqueAnkiMediaFilename (filename: string) {
  const normalized = basename(filename)
  const extension = extname(normalized)
  const stem = normalized.slice(0, Math.max(0, normalized.length - extension.length)) || 'hayase_media'
  return `${stem}_${randomUUID()}${extension}`
}

function mediaTag (mimeType: string, stored: string) {
  return mimeType.startsWith('audio/')
    ? `[sound:${stored}]`
    : `<img src="${escapeHtmlAttribute(stored)}">`
}

function elapsed (startedAt: number) {
  return Math.round((performance.now() - startedAt) * 10) / 10
}

function escapeAnkiSearch (value: string) {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function isRecord (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorMessage (error: unknown) {
  return error instanceof Error && error.message ? error.message : 'AnkiConnect request failed.'
}

function isConnectionError (error: unknown) {
  return errorMessage(error).startsWith('Unable to connect to AnkiConnect:')
}

function offlineRetryDelay (attempt: number) {
  return [2_000, 5_000, 10_000, 30_000][Math.min(attempt, 3)] ?? 30_000
}

function validateDictionaryMedia (value: unknown) {
  if (!isRecord(value)) throw new Error('Dictionary media descriptor is invalid.')
  return {
    dictionary: validateString(value.dictionary, 'Dictionary identifier', 1024),
    path: validateString(value.path, 'Dictionary media path', 4096),
    filename: validateString(value.filename, 'Dictionary media filename', 1024)
  }
}

export function mediaMimeType (filename: string) {
  const extension = filename.split('.').pop()?.toLowerCase()
  if (extension === 'png') return 'image/png'
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg'
  if (extension === 'gif') return 'image/gif'
  if (extension === 'webp') return 'image/webp'
  if (extension === 'avif') return 'image/avif'
  if (extension === 'svg') return 'image/svg+xml'
  if (extension === 'ogg' || extension === 'opus') return 'audio/ogg'
  if (extension === 'wav') return 'audio/wav'
  if (extension === 'aac') return 'audio/aac'
  if (extension === 'm4a') return 'audio/mp4'
  return 'audio/mpeg'
}

const LAPIS_DEFAULT_MAPPINGS: Record<string, string> = {
  Expression: '{expression}',
  ExpressionFurigana: '{furigana-plain}',
  ExpressionReading: '{reading}',
  ExpressionAudio: '{audio}',
  SelectionText: '{popup-selection-text}',
  MainDefinition: '{glossary-first}',
  Sentence: '{sentence}',
  SentenceAudio: '{sentence-audio}',
  Picture: '{screenshot}',
  Glossary: '{glossary}',
  PitchPosition: '{pitch-accent-positions}',
  PitchCategories: '{pitch-accent-categories}',
  Frequency: '{frequencies}',
  FreqSort: '{frequency-harmonic-rank}',
  MiscInfo: '{document-title}'
}

const HOSHI_DEFAULT_MAPPINGS: Record<string, Record<string, string>> = {
  Lapis: LAPIS_DEFAULT_MAPPINGS,
  Kiku: LAPIS_DEFAULT_MAPPINGS,
  Senren: {
    word: '{expression}',
    reading: '{reading}',
    sentence: '{sentence}',
    selectionText: '{popup-selection-text}',
    definition: '{glossary-first}',
    wordAudio: '{audio}',
    sentenceAudio: '{sentence-audio}',
    picture: '{screenshot}',
    glossary: '{glossary}',
    pitchPositions: '{pitch-accent-positions}',
    pitchCategories: '{pitch-accent-categories}',
    frequencies: '{frequencies}',
    freqSort: '{frequency-harmonic-rank}',
    miscInfo: '{document-title}'
  }
}
