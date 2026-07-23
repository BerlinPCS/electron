import type {
  MiningDictionaryEvent,
  MiningDictionaryKind,
  MiningDictionaryLookupRequest,
  MiningDictionaryLookupResult,
  MiningDictionaryState
} from '../main/hoshidicts/types.ts'
import type { MiningLocalAudioState } from '../main/mining-audio.ts'

declare module 'native' {
  interface Native {
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
    onMiningDictionaryEvent: (callback: (event: MiningDictionaryEvent) => void) => () => void
  }
}
