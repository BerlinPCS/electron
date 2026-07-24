import type {
  MiningDictionaryEvent,
  MiningDictionaryKind,
  MiningDictionaryLookupRequest,
  MiningDictionaryLookupResult,
  MiningDictionaryState
} from '../main/hoshidicts/types.ts'
import type { HayaseMigrationState } from '../main/legacy-migration.ts'
import type {
  MiningAnkiAddRequest,
  MiningAnkiAddResult,
  MiningAnkiConnectionResult,
  MiningAnkiDuplicateRequest,
  MiningAnkiDuplicateResult,
  MiningAnkiEvent,
  MiningAnkiSettingsPatch,
  MiningAnkiShowNotesRequest,
  MiningAnkiShowNotesResult,
  MiningAnkiState
} from '../main/mining-anki.ts'
import type { MiningLocalAudioState } from '../main/mining-audio.ts'

declare module 'native' {
  interface Native {
    hayaseMigrationState: () => Promise<HayaseMigrationState>
    hayaseMigrationImport: () => Promise<boolean>
    miningDictionaryState: () => Promise<MiningDictionaryState>
    miningDictionaryLookup: (request: MiningDictionaryLookupRequest) => Promise<MiningDictionaryLookupResult>
    miningDictionaryImport: () => Promise<MiningDictionaryState>
    miningDictionarySetEnabled: (id: string, kind: MiningDictionaryKind, enabled: boolean) => Promise<MiningDictionaryState>
    miningDictionaryReorder: (kind: MiningDictionaryKind, ids: string[]) => Promise<MiningDictionaryState>
    miningDictionaryRemove: (id: string) => Promise<MiningDictionaryState>
    miningAudioLocalState: () => Promise<MiningLocalAudioState>
    miningAudioLocalImport: () => Promise<MiningLocalAudioState>
    miningAudioLocalRemove: () => Promise<MiningLocalAudioState>
    miningAudioLocalReorder: (sourceOrder: string[]) => Promise<MiningLocalAudioState>
    miningAudioResolveSource: (target: string, templates: string[]) => Promise<string | null>
    miningAnkiState: () => Promise<MiningAnkiState>
    miningAnkiUpdateSettings: (patch: MiningAnkiSettingsPatch) => Promise<MiningAnkiState>
    miningAnkiPing: () => Promise<MiningAnkiConnectionResult>
    miningAnkiDetect: () => Promise<MiningAnkiState>
    miningAnkiCheckDuplicate: (request: MiningAnkiDuplicateRequest) => Promise<MiningAnkiDuplicateResult>
    miningAnkiAddNote: (request: MiningAnkiAddRequest) => Promise<MiningAnkiAddResult>
    miningAnkiShowNotes: (request: MiningAnkiShowNotesRequest) => Promise<MiningAnkiShowNotesResult>
    onMiningAnkiEvent: (callback: (event: MiningAnkiEvent) => void) => () => void
    onMiningDictionaryEvent: (callback: (event: MiningDictionaryEvent) => void) => () => void
  }
}
