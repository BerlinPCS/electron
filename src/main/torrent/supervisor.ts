import { fork } from 'node:child_process'
import { EventEmitter } from 'node:events'

import type { Packet } from './transport.ts'
import type { MessagePortMain } from 'electron'
import type { Readable } from 'node:stream'

export class DedicatedTorrentProcess extends EventEmitter {
  private readonly child
  private readonly ports = new Map<number, MessagePortMain>()
  private nextPort = 0
  private readonly timer
  constructor (script: string, executable: string) {
    super()
    // Do not pass backend tokens, proxy settings or Node injection flags to torrents.
    const env: NodeJS.ProcessEnv = {}
    for (const key of ['PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR', 'SystemRoot', 'WINDIR', 'LANG']) {
      if (process.env[key]) env[key] = process.env[key]
    }
    env.ELECTRON_RUN_AS_NODE = '1'
    this.child = fork(script, [], { execPath: executable, execArgv: [], env, serialization: 'advanced', stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    this.timer = setTimeout(() => this.child.kill(), 15_000)
    this.child.on('message', (packet: Packet) => {
      if (packet.kind === 'ready') { clearTimeout(this.timer); this.emit('spawn') }
      if (packet.kind === 'port' && packet.port !== undefined) this.ports.get(packet.port)?.postMessage(packet.data)
      if (packet.kind === 'close' && packet.port !== undefined) { this.ports.get(packet.port)?.close(); this.ports.delete(packet.port) }
    })
    this.child.on('error', () => this.child.kill())
    this.child.once('close', (code) => {
      clearTimeout(this.timer)
      for (const port of this.ports.values()) port.close()
      this.ports.clear()
      this.emit('exit', code)
    })
  }

  get stdout (): Readable | null { return this.child.stdout }
  get stderr (): Readable | null { return this.child.stderr }
  get pid () { return this.child.pid }
  private send (packet: Packet) {
    if (this.child.connected) this.child.send(packet, error => { if (error) this.child.kill() })
  }

  postMessage (data: unknown, ports: MessagePortMain[] = []) {
    const ids = ports.map(port => {
      const id = ++this.nextPort
      this.ports.set(id, port)
      port.on('message', event => this.send({ kind: 'port', port: id, data: event.data }))
      port.once('close', () => { this.ports.delete(id); this.send({ kind: 'close', port: id }) })
      port.start()
      return id
    })
    this.send({ kind: 'control', data, ports: ids })
  }

  kill () { return this.child.kill() }
}
