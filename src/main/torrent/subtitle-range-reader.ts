import type { SubtitlePlaybackContext } from './subtitle-sampling-types.ts'

interface SampleSelection { priority?: number, notify?: (() => void) | null, from: number, to?: number, offset?: number, isStreamSelection?: boolean, remove: () => void }
export interface SampleTorrent {
  pieceLength: number
  lastPieceLength: number
  pieces: unknown[]
  bitfield: { get: (index: number) => boolean }
  store: { get: (index: number, options: { offset: number, length: number }, callback: (error: Error | null, buffer: Uint8Array) => void) => void }
  _select: (start: number, end: number, priority: number, notify: (() => void) | null, stream: boolean) => void
  _selections: Iterable<SampleSelection> & { sort: (compare: (a: SampleSelection, b: SampleSelection) => number) => void }
  _updateSelections: () => void
  destroyed?: boolean
}
export interface SampleFile { name: string, offset: number, length: number, _torrent: SampleTorrent }
export class SamplingStopped extends Error {
  readonly reason: 'cancelled' | 'timeout' | 'budget' | 'buffering'
  constructor (reason: 'cancelled' | 'timeout' | 'budget' | 'buffering') { super(reason); this.reason = reason }
}
/** Never creates a WebTorrent file iterator or marks a piece critical. */
export class SubtitleRangeReader {
  bytesFetched = 0
  bytesParsed = 0
  cancelled = false
  private suspended = true
  private readonly availableOnly: boolean
  private readonly requested = new Set<number>()
  private readonly selections = new Set<number>()
  private readonly pendingReads = new Set<() => void>()
  private readonly deadline: number
  // WebTorrent's public deselect ignores priority and removes overlapping ranges.
  // Keep separate stream selections and remove only our unique notification token.
  // This private adapter is covered against the pinned client by loopback tests.
  // The pinned scheduler shuffles *all nonzero priorities* together. Zero is
  // the only priority that reliably stays behind playback's priority one.
  private readonly selectionToken = () => {}
  readonly file: SampleFile
  playback: SubtitlePlaybackContext
  readonly limits: { download: number, parse: number, timeout: number }
  constructor (file: SampleFile, playback: SubtitlePlaybackContext, limits = { download: 64 * 1024 * 1024, parse: 128 * 1024 * 1024, timeout: 60_000 }, availableOnly = false) {
    this.availableOnly = availableOnly
    this.file = file
    this.playback = playback
    this.limits = limits
    this.deadline = Date.now() + limits.timeout
    this.update(playback)
  }

  update (context: SubtitlePlaybackContext) {
    this.playback = context
    // Unknown buffering is not permission to compete with playback.
    if (context.buffered === null) this.suspended = true
    else if (context.stalled || context.buffered < 15) this.suspended = true
    else if (context.buffered >= 30) this.suspended = false
    if (this.suspended) this.release()
  }

  check () {
    if (this.cancelled || this.file._torrent.destroyed) throw new SamplingStopped('cancelled')
    if (Date.now() >= this.deadline) throw new SamplingStopped('timeout')
  }

  private release () {
    const torrent = this.file._torrent
    for (const selection of torrent._selections) if (selection.notify === this.selectionToken) selection.remove()
    if (!torrent.destroyed) torrent._updateSelections()
    this.selections.clear()
  }

  cancel () {
    this.cancelled = true
    for (const stop of this.pendingReads) stop()
    this.release()
  }

  private storedPiece (piece: number, offset: number, length: number) {
    return new Promise<Uint8Array>((resolve, reject) => {
      let settled = false
      const stop = () => finish(new SamplingStopped('cancelled'))
      const timer = setTimeout(() => finish(new SamplingStopped('timeout')), Math.max(0, this.deadline - Date.now()))
      const finish = (error: Error | null, bytes?: Uint8Array) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.pendingReads.delete(stop)
        if (error) reject(error)
        else if (bytes) resolve(bytes)
        else reject(new Error('Missing subtitle sample piece'))
      }
      this.pendingReads.add(stop)
      // Storage callbacks have no deadline (fs/network volumes can stall).
      // A late callback after cancellation must not revive the session.
      try { this.file._torrent.store.get(piece, { offset, length }, finish) } catch (error) { finish(error instanceof Error ? error : new Error(String(error))) }
    })
  }

  async read (start: number, length: number) {
    this.check()
    if (!Number.isSafeInteger(start) || start < 0 || start >= this.file.length || length < 0) throw new Error('Invalid subtitle sample range')
    length = Math.min(length, this.file.length - start)
    if (this.bytesParsed + length > this.limits.parse) throw new SamplingStopped('budget')
    this.bytesParsed += length
    const output = new Uint8Array(length)
    const torrent = this.file._torrent
    let written = 0
    while (written < length) {
      this.check()
      const absolute = this.file.offset + start + written
      const piece = Math.floor(absolute / torrent.pieceLength)
      const offset = absolute % torrent.pieceLength
      const count = Math.min(length - written, torrent.pieceLength - offset)
      while (!torrent.bitfield.get(piece)) {
        this.check()
        // A cache-only probe must never select a missing piece or wait for the
        // playback buffer. Return an explicit outcome so a later session can
        // download with its own full time budget once playback is healthy.
        if (this.availableOnly) throw new SamplingStopped('buffering')
        if (!this.suspended && !this.selections.has(piece)) {
          const size = piece === torrent.pieces.length - 1 ? torrent.lastPieceLength : torrent.pieceLength
          if (!this.requested.has(piece)) {
            if (this.bytesFetched + size > this.limits.download) throw new SamplingStopped('budget')
            this.bytesFetched += size
            this.requested.add(piece)
          }
          torrent._select(piece, piece, 0, this.selectionToken, true)
          // Stay behind playback, but ahead of whole-file background downloads.
          torrent._selections.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || Number(b.notify === this.selectionToken) - Number(a.notify === this.selectionToken))
          torrent._updateSelections()
          this.selections.add(piece)
        }
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      this.check()
      const bytes = await this.storedPiece(piece, offset, count)
      this.check()
      if (bytes.length !== count) throw new Error('Incomplete subtitle sample piece')
      output.set(bytes, written)
      written += count
      if (this.selections.delete(piece)) this.release()
    }
    return output
  }
}
