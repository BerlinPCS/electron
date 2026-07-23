export type MiningDictionaryKind = 'term' | 'frequency' | 'pitch'

export interface MiningDictionaryCounts {
  term: number
  frequency: number
  pitch: number
  media: number
}

export interface MiningDictionaryEnabled {
  term: boolean
  frequency: boolean
  pitch: boolean
}

export interface MiningDictionaryDescriptor {
  id: string
  title: string
  revision: string
  format: number
  counts: MiningDictionaryCounts
  enabled: MiningDictionaryEnabled
}

export interface MiningDictionaryState {
  available: boolean
  generation: number
  error?: string
  dictionaries: MiningDictionaryDescriptor[]
  order: Record<MiningDictionaryKind, string[]>
  styles: Record<string, string>
}

export interface MiningDictionaryLookupRequest {
  text: string
  offset: number
  maxResults: number
  scanLength: number
}

export interface MiningDictionaryTrace {
  name: string
  description: string
}

export interface MiningDictionaryGlossary {
  dictionary: string
  content: string
  definitionTags: string
  termTags: string
}

export interface MiningDictionaryFrequencyValue {
  value: number
  displayValue: string
}

export interface MiningDictionaryFrequency {
  dictionary: string
  frequencies: MiningDictionaryFrequencyValue[]
}

export interface MiningDictionaryPitch {
  dictionary: string
  pitchPositions: number[]
  transcriptions: string[]
}

export interface MiningDictionaryEntry {
  expression: string
  reading: string
  matched: string
  deinflected: string
  trace: MiningDictionaryTrace[]
  rules: string[]
  glossaries: MiningDictionaryGlossary[]
  frequencies: MiningDictionaryFrequency[]
  pitches: MiningDictionaryPitch[]
}

export interface MiningDictionaryLookupResult {
  length: number
  entries: MiningDictionaryEntry[]
}

export interface MiningDictionaryImportProgress {
  operationId: string
  fileIndex: number
  fileCount: number
  fileName: string
  dictionary?: string
  phase: string
  completed: number
  total: number
}

export type MiningDictionaryEvent =
  | { event: 'importProgress', data: MiningDictionaryImportProgress }
  | { event: 'stateChanged', data: MiningDictionaryState }
  | { event: 'backendError', data: { code: string, message: string } }

export interface HoshidictsHello {
  protocolVersion: number
  backendVersion: string
  capabilities: string[]
}

export interface SidecarError {
  code: string
  message: string
}

export interface SidecarRequest {
  id: number
  method: string
  params: unknown
}

export type SidecarResponse =
  | { id: number, result: unknown }
  | { id: number, error: SidecarError }

export interface SidecarEvent {
  event: string
  data: unknown
}
