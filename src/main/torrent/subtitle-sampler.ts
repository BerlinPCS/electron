import { inflateSync } from 'node:zlib'

import { EbmlIteratorDecoder, EbmlTagId } from 'torrent-client/ebml/iterator/index.ts'

import { SubtitleRangeReader, SamplingStopped, type SampleFile } from './subtitle-range-reader.ts'

import type { SubtitleSampleEvent, SubtitleSampleRequest, SubtitlePlaybackContext, SubtitleSampleTrack, SubtitleSampleReason } from './subtitle-sampling-types.ts'

interface Tag { id: EbmlTagId, data?: unknown, Children?: Tag[], track?: number, value?: number, payload?: Uint8Array }
const children = (tag: Tag | undefined) => tag?.Children ?? []
const child = (tag: Tag | undefined, id: EbmlTagId) => children(tag).find(value => value.id === id)
const number = (tag: Tag | undefined, id: EbmlTagId, fallback = 0) => Number(child(tag, id)?.data ?? fallback)
const string = (tag: Tag | undefined, id: EbmlTagId, fallback = '') => {
  const value = child(tag, id)?.data
  return typeof value === 'string' ? value : value instanceof Uint8Array ? new TextDecoder().decode(value) : fallback
}
const uint = (data: unknown) => data instanceof Uint8Array ? [...data].reduce((value, byte) => value * 256 + byte, 0) : Number(data)
function vint (data: Uint8Array, start: number, keep = false) {
  const first = data[start]
  if (!first) return undefined
  const size = Math.clz32(first) - 24 + 1
  if (size > 8 || start + size > data.length) return undefined
  let value = keep ? first : first & (0xff >> size)
  let unknown = !keep && value === (0xff >> size)
  for (let index = 1; index < size; index++) { value = value * 256 + (data[start + index] ?? 0); unknown = unknown && data[start + index] === 255 }
  return { size, value: unknown ? Infinity : value }
}
function header (data: Uint8Array, start = 0): { id: EbmlTagId, size: number, length: number } | undefined {
  const id = vint(data, start, true)
  if (!id || id.size > 4) return undefined
  const size = vint(data, start + id.size)
  return size ? { id: id.value, size: size.value, length: id.size + size.size } : undefined
}
function decode (bytes: Uint8Array, ids: EbmlTagId[]) {
  const decoder = new EbmlIteratorDecoder({ bufferTagIds: ids })
  return [...decoder.parseTags(bytes)] as unknown as Tag[]
}
export class SubtitleSampler {
  private readonly sessions = new Map<string, SubtitleRangeReader>()
  constructor (private readonly files: Map<string, unknown>) {}
  update (id: string, context: SubtitlePlaybackContext) { this.sessions.get(id)?.update(context) }
  cancel (id: string) { this.sessions.get(id)?.cancel(); this.sessions.delete(id) }
  async start (request: SubtitleSampleRequest, callback: (event: SubtitleSampleEvent) => void) {
    for (const id of this.sessions.keys()) this.cancel(id)
    const file = this.files.get(request.hash + request.fileId) as SampleFile | undefined
    const tracks: SubtitleSampleTrack[] = []
    const reader = file && /\.(mkv|webm)$/i.test(file.name) ? new SubtitleRangeReader(file, request.playback, undefined, request.availableOnly) : undefined
    const send = (done: boolean, reason?: SubtitleSampleReason) => callback({ sessionId: request.sessionId, tracks: tracks.map(track => ({ ...track, windows: [...track.windows] })), bytesFetched: reader?.bytesFetched ?? 0, bytesParsed: reader?.bytesParsed ?? 0, done, reason })
    if (!file || !reader) { send(true, 'unsupported'); return }
    this.sessions.set(request.sessionId, reader)
    try {
      let segment = 0
      let position = 0
      // Locate the segment without reading video payload.
      for (let index = 0; index < 32; index++) {
        const tag = header(await reader.read(position, 16))
        if (!tag) throw new Error('Invalid EBML header')
        if (tag.id === EbmlTagId.Segment) { segment = position + tag.length; break }
        if (!Number.isFinite(tag.size)) throw new Error('Unknown header size')
        position += tag.length + tag.size
      }
      if (!segment) throw new Error('Missing segment')
      const locations = new Map<number, number>()
      let scale = 0.001
      let duration = request.playback.duration
      const compressed = new Set<string>()
      const headerStripping = new Map<string, Uint8Array>()
      const codecs = new Map<string, string>()
      const parseMetadata = (tag: Tag) => {
        if (tag.id === EbmlTagId.SeekHead) {
          for (const seek of children(tag)) locations.set(uint(child(seek, EbmlTagId.SeekID)?.data), segment + number(seek, EbmlTagId.SeekPosition))
        }
        if (tag.id === EbmlTagId.Info) {
          scale = number(tag, EbmlTagId.TimecodeScale, 1_000_000) / 1_000_000_000
          duration = number(tag, EbmlTagId.Duration) * scale || duration
        }
        if (tag.id === EbmlTagId.Tracks) {
          for (const entry of children(tag)) {
            if (number(entry, EbmlTagId.TrackType) !== 17) continue
            const codec = string(entry, EbmlTagId.CodecID)
            if (!['S_TEXT/ASS', 'S_TEXT/SSA', 'S_TEXT/UTF8', 'S_TEXT/WEBVTT'].includes(codec)) continue
            const id = String(number(entry, EbmlTagId.TrackNumber))
            const encodings = children(child(entry, EbmlTagId.ContentEncodings)).filter(value => value.id === EbmlTagId.ContentEncoding)
            if (encodings.length > 1) continue
            const encoding = encodings[0]
            if (encoding && (number(encoding, EbmlTagId.ContentEncodingScope, 1) !== 1 || number(encoding, EbmlTagId.ContentEncodingType) !== 0)) continue
            const compression = child(encoding, EbmlTagId.ContentCompression)
            const algorithm = compression ? number(compression, EbmlTagId.ContentCompAlgo) : undefined
            if (algorithm !== undefined && algorithm !== 0 && algorithm !== 3) continue
            if (algorithm === 0) compressed.add(id)
            const stripped = child(compression, EbmlTagId.ContentCompSettings)?.data
            if (algorithm === 3 && stripped instanceof Uint8Array) headerStripping.set(id, stripped)
            codecs.set(id, codec)
            if (!tracks.some(track => track.id === id)) tracks.push({ id, language: string(entry, EbmlTagId.Language, 'eng'), name: string(entry, EbmlTagId.Name), forced: !!number(entry, EbmlTagId.FlagForced), windows: [] })
          }
        }
      }
      const readTag = async (at: number) => {
        const tag = header(await reader.read(at, 16))
        if (!tag || !Number.isFinite(tag.size) || tag.size > 16 * 1024 * 1024) throw new Error('Oversized metadata')
        return decode(await reader.read(at, tag.length + tag.size), [tag.id]).find(value => value.id === tag.id)
      }
      position = segment
      for (let index = 0; index < 32 && position < file.length; index++) {
        const tag = header(await reader.read(position, 16))
        if (!tag || tag.id === EbmlTagId.Cluster) break
        if ([EbmlTagId.SeekHead, EbmlTagId.Info, EbmlTagId.Tracks].includes(tag.id)) {
          const value = await readTag(position)
          if (value) parseMetadata(value)
        }
        if (!Number.isFinite(tag.size)) break
        position += tag.length + tag.size
      }
      for (const id of [EbmlTagId.SeekHead, EbmlTagId.Info, EbmlTagId.Tracks]) {
        const at = locations.get(id)
        if (at !== undefined) { const tag = await readTag(at); if (tag) parseMetadata(tag) }
      }
      if (!tracks.some(track => !track.forced)) { send(true, 'no-reference'); return }
      const points: Array<{ time: number, position: number }> = []
      const cuesAt = locations.get(EbmlTagId.Cues)
      if (cuesAt !== undefined) {
        const cues = await readTag(cuesAt)
        for (const point of children(cues)) {
          const positions = child(point, EbmlTagId.CueTrackPositions)
          if (positions) points.push({ time: number(point, EbmlTagId.CueTime) * scale, position: segment + number(positions, EbmlTagId.CueClusterPosition) })
        }
        points.sort((a, b) => a.time - b.time)
      }
      const sampled = new Set<number>()
      const targets = [request.playback.time, duration * 0.2, duration * 0.5, duration * 0.8]
      for (const [windowIndex, target] of targets.entries()) {
        reader.check()
        const point = points.filter(value => value.time <= target).at(-1) ?? points[0]
        let at = point?.position ?? (windowIndex === 0 && target < 60 ? position : Math.floor(file.length * (duration ? target / duration : windowIndex / 4)))
        // Without Cues, probe bytes but derive all times from validated clusters.
        if (!point) {
          const probe = await reader.read(Math.max(segment, at), Math.min(2 * 1024 * 1024, file.length - Math.max(segment, at)))
          let found = -1
          for (let index = 0; index < probe.length - 16; index++) {
            if (probe[index] !== 0x1f || probe[index + 1] !== 0x43 || probe[index + 2] !== 0xb6 || probe[index + 3] !== 0x75) continue
            const candidate = header(probe, index)
            const first = candidate && header(probe, index + candidate.length)
            if (candidate && first && [EbmlTagId.Timecode, EbmlTagId.CRC32, EbmlTagId.Void].includes(first.id)) { found = index; break }
          }
          if (found < 0) continue
          at = Math.max(segment, at) + found
        }
        const windowCues = new Map<string, Array<{ start: number, end: number, text: string, style?: string }>>()
        let start: number | undefined
        let end = 0
        let lastCluster = -1
        for (let clusterCount = 0; clusterCount < 300 && at < file.length; clusterCount++) {
          const tag = header(await reader.read(at, 16))
          if (!tag || !Number.isFinite(tag.size)) break
          if (tag.id !== EbmlTagId.Cluster) { at += tag.length + tag.size; continue }
          if (sampled.has(at)) break
          sampled.add(at)
          // Skip media payload by EBML lengths. Reading whole clusters can spend
          // the entire budget on a few seconds of high bitrate video.
          const parts: Tag[] = []
          const clusterEnd = at + tag.length + tag.size
          for (let cursor = at + tag.length; cursor < clusterEnd;) {
            const entry = header(await reader.read(cursor, 16))
            if (!entry || !Number.isFinite(entry.size) || cursor + entry.length + entry.size > clusterEnd) throw new Error('Invalid cluster child')
            if (entry.id === EbmlTagId.Timecode) {
              parts.push(...decode(await reader.read(cursor, entry.length + entry.size), [EbmlTagId.Timecode]))
            } else if (entry.id === EbmlTagId.BlockGroup) {
              const groupEnd = cursor + entry.length + entry.size
              for (let blockAt = cursor + entry.length; blockAt < groupEnd;) {
                const prefix = await reader.read(blockAt, 24)
                const block = header(prefix)
                if (!block || !Number.isFinite(block.size) || blockAt + block.length + block.size > groupEnd) throw new Error('Invalid block group')
                if (block.id === EbmlTagId.Block) {
                  const track = vint(prefix, block.length)
                  if (track && codecs.has(String(track.value))) {
                    if (entry.size > 1024 * 1024) throw new Error('Oversized subtitle block')
                    parts.push(...decode(await reader.read(cursor, entry.length + entry.size), [EbmlTagId.BlockGroup]))
                  }
                  break
                }
                blockAt += block.length + block.size
              }
            }
            cursor += entry.length + entry.size
          }
          const clusterTime = Number(parts.find(part => part.id === EbmlTagId.Timecode)?.data)
          if (!Number.isFinite(clusterTime)) break
          const time = clusterTime * scale
          if (lastCluster >= 0 && time < lastCluster) break
          lastCluster = time
          start ??= time
          const enoughDialogue = [...windowCues.values()].some(cues => new Set(cues.map(cue => Math.round(cue.start * 10))).size >= 12)
          if (time >= start + 60 || (time >= start + 20 && enoughDialogue)) { end = time; break }
          end = time
          for (const group of parts.filter(part => part.id === EbmlTagId.BlockGroup)) {
            const block = child(group, EbmlTagId.Block)
            if (!block?.payload) continue
            const id = String(block.track)
            const codec = codecs.get(id)
            if (codec === undefined) continue
            const prefix = headerStripping.get(id)
            const payload = compressed.has(id) ? inflateSync(block.payload, { maxOutputLength: 1024 * 1024 }) : prefix ? Buffer.concat([prefix, block.payload]) : block.payload
            const raw = new TextDecoder().decode(payload)
            const fields = raw.split(',')
            const ass = /ASS|SSA/.test(codec)
            const cueStart = (clusterTime + Number(block.value)) * scale
            const cueEnd = cueStart + number(group, EbmlTagId.BlockDuration) * scale
            if (cueEnd <= cueStart) continue
            const text = ass ? fields.slice(8).join(',') : raw
            const style = ass ? fields[2] : undefined
            // Keep this reference policy consistent with the renderer matcher.
            // OPStyle/EDRomaji events can be thousands of animation fragments,
            // even without standard karaoke tags. They are not dialogue onsets.
            if (/sign|karaoke|opening|ending|lyrics|(?:^|[\s._-])(?:op|ed)(?:$|[\s._-]|\d|style|romaji|kanji|english|japanese)/i.test(style ?? '') || /\\(?:k[fo]?\d|p[1-9])/i.test(text)) continue
            const cues = windowCues.get(id) ?? []
            cues.push({ start: cueStart, end: cueEnd, text, style })
            windowCues.set(id, cues)
          }
          at += tag.length + tag.size
        }
        if (start !== undefined && end > start) {
          for (const track of tracks) track.windows.push({ id: `${windowIndex}:${start}`, start, end, cues: (windowCues.get(track.id) ?? []).filter(cue => cue.start < end) })
          send(false)
        }
      }
      send(true, 'complete')
    } catch (error) {
      console.debug('Subtitle sampler failure', JSON.stringify({ sessionId: request.sessionId, message: error instanceof Error ? error.message : String(error), bytesFetched: reader.bytesFetched, bytesParsed: reader.bytesParsed }))
      send(true, error instanceof SamplingStopped ? error.reason : 'error')
    } finally {
      reader.cancel()
      if (this.sessions.get(request.sessionId) === reader) this.sessions.delete(request.sessionId)
    }
  }
}
