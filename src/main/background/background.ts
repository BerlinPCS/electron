/* eslint-disable @typescript-eslint/prefer-nullish-coalescing -- Empty configured paths intentionally use the temporary directory. */
import { statSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'

import { expose } from 'abslink/w3c'
import TorrentClient from 'torrent-client'

import { SubtitleCache } from '../torrent/subtitle-cache.ts'
import { SubtitleSampler } from '../torrent/subtitle-sampler.ts'
import { childTransport, type Packet } from '../torrent/transport.ts'

import type { ClientSettings } from 'native'
import type { PROVIDERS } from 'torrent-client/doh'

interface Message {
  id: string
  data: unknown
}

let TMP: string
let temporaryRoot: string | undefined
try {
  statSync('/tmp')
  TMP = join('/tmp', 'webtorrent')
} catch (err) {
  TMP = join(typeof os.tmpdir === 'function' ? os.tmpdir() : '/', 'webtorrent')
}

const pipe = process.send
  ? childTransport(packet => {
    if (process.connected) process.send?.(packet, error => { if (error) process.exit(1) })
  })
  : undefined
if (pipe) {
  process.on('message', packet => pipe.receive(packet as Packet))
  process.once('disconnect', () => process.exit(0))
}
const parent = pipe?.parent ?? process.parentPort

parent.on('message', ({ ports, data: _data }) => {
  let settings: ClientSettings & { path: string, temporaryPath?: string, doh?: `https://${keyof typeof PROVIDERS}` } | undefined
  const { id, data } = _data as Message
  if (id === 'settings') {
    settings = data as ClientSettings & { path: string, temporaryPath?: string, doh?: `https://${keyof typeof PROVIDERS}` }
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
    if (!tclient) {
      if (!settings) return
      temporaryRoot = settings.temporaryPath || TMP
      const client = new TorrentClient(settings, temporaryRoot)
      const registeredFiles = new Map(client.attachments.filemap)
      const register = client.attachments.register.bind(client.attachments)
      client.attachments.register = (files, hash) => {
        registeredFiles.clear()
        files.forEach((file, id) => registeredFiles.set(hash + id, file))
        register(files, hash)
      }
      const subtitleCache = new SubtitleCache(settings.path || temporaryRoot, registeredFiles)
      const playTorrent = client.playTorrent.bind(client)
      client.playTorrent = async (...args) => {
        const oldFiles = [...registeredFiles.values()]
        const oldHash = oldFiles[0]?._torrent.infoHash
        const oldRoot = oldFiles[0]?._torrent.path ?? subtitleCache.storageRoot
        const persist = client.persist
        const result = await playTorrent(...args)
        if (!persist && oldHash && oldHash !== [...registeredFiles.values()][0]?._torrent.infoHash) await subtitleCache.remove(oldHash, oldRoot).catch(error => console.error('Subtitle cache cleanup failed', error))
        return result
      }
      const deleteTorrents = client.deleteTorrents.bind(client)
      client.deleteTorrents = async hashes => {
        const root = subtitleCache.storageRoot
        await deleteTorrents(hashes)
        await subtitleCache.removeDeleted(hashes, root).catch(error => console.error('Subtitle cache cleanup failed', error))
      }
      tclient = Object.assign(client, { subtitleSampling: new SubtitleSampler(client.attachments.filemap), subtitleCache })
    }
    if (settings?.doh) tclient.setDOH(settings.doh)
    // re-exposing leaks memory, but not that much, so it's fine
    expose(tclient, ports[0] as unknown as MessagePort)
  } else if (settings) {
    tclient?.updateSettings(settings)
    tclient?.subtitleCache.setRoot(settings.path || temporaryRoot || TMP)
  }
})

let tclient: (TorrentClient & { subtitleSampling: SubtitleSampler, subtitleCache: SubtitleCache }) | undefined

function isValidDoHEndpoint (value: unknown): value is `https://${string}` {
  if (typeof value !== 'string' || !value) return false
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

if (pipe) process.send?.({ kind: 'ready' })
