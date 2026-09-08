import { statSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'

import { expose } from 'abslink/w3c'
import TorrentClient from 'torrent-client'
import { childTransport, type Packet } from '../torrent/transport.ts'

import type { ClientSettings } from 'native'
import type { PROVIDERS } from 'torrent-client/doh'

interface Message {
  id: string
  data: unknown
}

let TMP: string
try {
  TMP = join(statSync('/tmp') && '/tmp', 'webtorrent')
} catch (err) {
  TMP = join(typeof os.tmpdir === 'function' ? os.tmpdir() : '/', 'webtorrent')
}

const pipe = process.send ? childTransport(packet => {
  if (process.connected) process.send!(packet, error => { if (error) process.exit(1) })
}) : undefined
if (pipe) {
  process.on('message', packet => pipe.receive(packet as Packet))
  process.once('disconnect', () => process.exit(0))
}
const parent = pipe?.parent ?? process.parentPort

parent.on('message', ({ ports, data: _data }) => {
  let settings: ClientSettings & { path: string, doh?: `https://${keyof typeof PROVIDERS}` } | undefined
  const { id, data } = _data as Message
  if (id === 'settings') {
    settings = data as ClientSettings & { path: string, doh?: `https://${keyof typeof PROVIDERS}` }
    if (!isValidDoHEndpoint(settings.doh)) delete settings.doh
  }
  if (id === 'destroy') {
    if (pipe) {
      Promise.resolve(tclient?.destroy()).then(() => process.exit(0), () => process.exit(1))
    } else tclient?.destroy()
    return
  }

  if (ports[0]) {
    ports[0].start()
    tclient ??= new TorrentClient(settings!, TMP)
    if (settings?.doh) tclient.setDOH(settings.doh)
    // re-exposing leaks memory, but not that much, so it's fine
    expose(tclient, ports[0] as unknown as MessagePort)
  } else if (settings) {
    tclient?.updateSettings(settings)
  }
})

let tclient: TorrentClient | undefined

function isValidDoHEndpoint (value: unknown): value is `https://${string}` {
  if (typeof value !== 'string' || !value) return false
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

if (pipe) process.send!({ kind: 'ready' })
