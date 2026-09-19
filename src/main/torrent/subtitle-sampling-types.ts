export interface SubtitlePlaybackContext { time: number, duration: number, buffered: number | null, stalled: boolean }
export interface SubtitleSampleRequest { sessionId: string, hash: string, fileId: number, playback: SubtitlePlaybackContext, availableOnly?: boolean }
export interface SubtitleSampleCue { start: number, end: number, text: string, style?: string }
export interface SubtitleSampleWindow { id: string, start: number, end: number, cues: SubtitleSampleCue[] }
export interface SubtitleSampleTrack { id: string, language: string, name?: string, forced: boolean, windows: SubtitleSampleWindow[] }
export type SubtitleSampleReason = 'complete' | 'unsupported' | 'no-reference' | 'budget' | 'timeout' | 'cancelled' | 'error' | 'buffering'
export interface SubtitleSampleEvent { sessionId: string, tracks: SubtitleSampleTrack[], bytesFetched: number, bytesParsed: number, done: boolean, reason?: SubtitleSampleReason }
export interface SubtitleSamplingAPI {
  start: (request: SubtitleSampleRequest, callback: (event: SubtitleSampleEvent) => void) => Promise<void>
  update: (sessionId: string, playback: SubtitlePlaybackContext) => void
  cancel: (sessionId: string) => void
}
