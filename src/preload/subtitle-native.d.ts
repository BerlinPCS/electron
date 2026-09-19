import type { SubtitleSampleRequest, SubtitleSampleEvent, SubtitlePlaybackContext } from '../main/torrent/subtitle-sampling-types.ts'
declare module 'native' {
  interface Native {
    subtitleCacheList: (hash: string, id: number) => Promise<Array<{ name: string, source: string, profile?: string, rank: number, text: string }>>
    subtitleCachePut: (hash: string, id: number, subtitle: { name: string, source: string, profile?: string, rank: number, text: string }) => Promise<void>
    subtitleSampleStart: (request: SubtitleSampleRequest, callback: (event: SubtitleSampleEvent) => void) => Promise<void>
    subtitleSampleUpdate: (id: string, context: SubtitlePlaybackContext) => Promise<void>
    subtitleSampleCancel: (id: string) => Promise<void>
  }
}
