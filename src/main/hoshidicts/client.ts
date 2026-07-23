import { StringDecoder } from 'node:string_decoder'

import type { SidecarError, SidecarEvent, SidecarRequest } from './types.ts'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'

const DEFAULT_MAX_LINE_BYTES = 8 * 1024 * 1024

export class HoshidictsError extends Error {
  code: string

  constructor (error: SidecarError) {
    super(error.code === 'SUPERSEDED' ? `SUPERSEDED: ${error.message}` : error.message)
    this.name = 'HoshidictsError'
    this.code = error.code
  }
}

interface PendingRequest {
  method: string
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  timer?: ReturnType<typeof setTimeout>
}

export interface HoshidictsClientOptions {
  maxLineBytes?: number
  requestTimeoutMs?: number
  onEvent?: (event: SidecarEvent) => void
  onProtocolError?: (error: Error) => void
}

/**
 * Correlates the sidecar's newline-delimited JSON protocol. This class owns no
 * process lifecycle policy, making it usable with a fake child in tests.
 */
export class HoshidictsClient {
  private readonly decoder = new StringDecoder('utf8')
  private readonly maxLineBytes: number
  private readonly requestTimeoutMs: number
  private readonly pending = new Map<number, PendingRequest>()
  private buffer = ''
  private nextId = 1
  private latestLookupId?: number
  private closed = false

  constructor (
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly options: HoshidictsClientOptions = {}
  ) {
    this.maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000
    child.stdout.on('data', this.onData)
    child.stdin.on('error', this.onStdinError)
  }

  request<T> (method: string, params: unknown = {}, timeoutMs = this.requestTimeoutMs): Promise<T> {
    if (this.closed || !this.child.stdin.writable) {
      return Promise.reject(new HoshidictsError({ code: 'BACKEND_UNAVAILABLE', message: 'Dictionary backend is unavailable' }))
    }

    const id = this.nextId++
    const envelope: SidecarRequest = { id, method, params }

    return new Promise<T>((resolve, reject) => {
      const pending: PendingRequest = {
        method,
        resolve: value => resolve(value as T),
        reject
      }
      if (timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          this.pending.delete(id)
          if (this.latestLookupId === id) this.latestLookupId = undefined
          reject(new HoshidictsError({ code: 'TIMEOUT', message: `Dictionary ${method} request timed out` }))
        }, timeoutMs)
      }
      this.pending.set(id, pending)

      this.child.stdin.write(`${JSON.stringify(envelope)}\n`, error => {
        if (!error) return
        this.rejectRequest(id, error)
      })
    })
  }

  requestLatestLookup<T> (params: unknown): Promise<T> {
    if (this.latestLookupId != null) {
      this.rejectRequest(
        this.latestLookupId,
        new HoshidictsError({ code: 'SUPERSEDED', message: 'Dictionary lookup was superseded' })
      )
    }

    const promise = this.request<T>('lookup', params)
    this.latestLookupId = this.nextId - 1
    return promise
  }

  close (error: Error = new HoshidictsError({ code: 'BACKEND_EXITED', message: 'Dictionary backend exited' })) {
    if (this.closed) return
    this.closed = true
    this.child.stdout.off('data', this.onData)
    this.child.stdin.off('error', this.onStdinError)
    for (const id of [...this.pending.keys()]) this.rejectRequest(id, error)
    this.buffer = ''
  }

  private readonly onData = (chunk: Buffer | string) => {
    if (this.closed) return
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk)

    if (Buffer.byteLength(this.buffer, 'utf8') > this.maxLineBytes && !this.buffer.includes('\n')) {
      this.protocolFailure(new Error('Dictionary backend sent an oversized protocol line'))
      return
    }

    let newline = this.buffer.indexOf('\n')
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, '')
      this.buffer = this.buffer.slice(newline + 1)
      if (Buffer.byteLength(line, 'utf8') > this.maxLineBytes) {
        this.protocolFailure(new Error('Dictionary backend sent an oversized protocol line'))
        return
      }
      if (line.length > 0) this.parseLine(line)
      newline = this.buffer.indexOf('\n')
    }
  }

  private readonly onStdinError = (error: Error) => {
    this.close(new HoshidictsError({ code: 'BACKEND_IO_ERROR', message: error.message }))
  }

  private parseLine (line: string) {
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      this.protocolFailure(new Error('Dictionary backend sent malformed JSON'))
      return
    }

    if (!isRecord(message)) {
      this.protocolFailure(new Error('Dictionary backend sent an invalid protocol message'))
      return
    }

    if (typeof message.event === 'string' && 'data' in message) {
      this.options.onEvent?.(message as unknown as SidecarEvent)
      return
    }

    if (!Number.isSafeInteger(message.id)) {
      this.protocolFailure(new Error('Dictionary backend response is missing a valid request id'))
      return
    }

    const id = message.id as number
    const pending = this.pending.get(id)
    if (!pending) return

    this.pending.delete(id)
    if (pending.timer) clearTimeout(pending.timer)
    if (this.latestLookupId === id) this.latestLookupId = undefined

    if ('error' in message && isSidecarError(message.error)) {
      pending.reject(new HoshidictsError(message.error))
    } else if ('result' in message) {
      pending.resolve(message.result)
    } else {
      pending.reject(new HoshidictsError({ code: 'PROTOCOL_ERROR', message: 'Dictionary backend returned an invalid response' }))
    }
  }

  private rejectRequest (id: number, error: Error) {
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    if (pending.timer) clearTimeout(pending.timer)
    if (this.latestLookupId === id) this.latestLookupId = undefined
    pending.reject(error)
  }

  private protocolFailure (error: Error) {
    this.options.onProtocolError?.(error)
    this.close(new HoshidictsError({ code: 'PROTOCOL_ERROR', message: error.message }))
    this.child.kill()
  }
}

function isRecord (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value)
}

function isSidecarError (value: unknown): value is SidecarError {
  return isRecord(value) && typeof value.code === 'string' && typeof value.message === 'string'
}
