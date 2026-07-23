import type {
  MiningDictionaryEvent,
  MiningDictionaryKind,
  MiningDictionaryLookupRequest,
  MiningDictionaryLookupResult,
  MiningDictionaryState
} from '../main/hoshidicts/types.ts'

declare module 'native' {
  interface Native {
    miningDictionaryState: () => Promise<MiningDictionaryState>
    miningDictionaryLookup: (request: MiningDictionaryLookupRequest) => Promise<MiningDictionaryLookupResult>
    miningDictionaryImport: () => Promise<MiningDictionaryState>
    miningDictionarySetEnabled: (id: string, kind: MiningDictionaryKind, enabled: boolean) => Promise<MiningDictionaryState>
    miningDictionaryReorder: (kind: MiningDictionaryKind, ids: string[]) => Promise<MiningDictionaryState>
    miningDictionaryRemove: (id: string) => Promise<MiningDictionaryState>
    onMiningDictionaryEvent: (callback: (event: MiningDictionaryEvent) => void) => () => void
  }
}
