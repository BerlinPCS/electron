import { EventEmitter } from 'node:events'

// The inherited child-process IPC pipe is private to this parent/child pair.
// abslink proxies callbacks on the same channel; it needs no transferred ports.
export interface Packet {
  kind: 'control' | 'port' | 'close' | 'ready'
  port?: number
  ports?: number[]
  data?: unknown
}

export class PipePort extends EventEmitter {
  private id: number
  private send: (packet: Packet) => void
  constructor (id: number, send: (packet: Packet) => void) {
    super()
    this.id = id
    this.send = send
  }
  start () {}
  postMessage (data: unknown) { this.send({ kind: 'port', port: this.id, data }) }
  close () { this.removeAllListeners(); this.send({ kind: 'close', port: this.id }) }
}

export function childTransport (send: (packet: Packet) => void) {
  const parent = new EventEmitter()
  const ports = new Map<number, PipePort>()
  return {
    parent,
    receive (packet: Packet) {
      if (packet.kind === 'control') {
        const attached = (packet.ports ?? []).map(id => {
          const port = new PipePort(id, send)
          ports.set(id, port)
          return port
        })
        parent.emit('message', { data: packet.data, ports: attached })
      } else if (packet.kind === 'port') {
        ports.get(packet.port!)?.emit('message', { data: packet.data })
      } else if (packet.kind === 'close') {
        ports.get(packet.port!)?.removeAllListeners()
        ports.delete(packet.port!)
      }
    }
  }
}
