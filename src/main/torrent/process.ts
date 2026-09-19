import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { app, utilityProcess } from 'electron'

import { DedicatedTorrentProcess } from './supervisor.ts'

export function torrentExecutable () {
  if (!app.isPackaged) {
    const root = join(app.getAppPath(), '.sidecar-build', 'torrent-runtime')
    if (process.platform === 'darwin') return join(root, 'Hayatan Torrent Dev.app', 'Contents', 'MacOS', 'Hayatan Torrent Dev')
    if (process.platform === 'win32') return join(root, 'Hayatan Torrent Dev.exe')
    return ''
  }
  if (process.platform === 'darwin') return join(process.resourcesPath, 'torrent-runtime', 'Hayatan Torrent.app', 'Contents', 'MacOS', 'Hayatan Torrent')
  if (process.platform === 'win32') return join(process.resourcesPath, '..', 'Hayatan Torrent.exe')
  return ''
}

export function torrentRuntimeAvailable () {
  const path = torrentExecutable()
  return Boolean(path) && existsSync(path)
}

export function startTorrentProcess (script: string, dedicated: boolean) {
  if (!dedicated) {
    return utilityProcess.fork(script, [], {
      stdio: ['ignore', 'pipe', 'pipe'], serviceName: 'Hayatan Torrent Client'
    })
  }
  // Never silently fall back to an executable the owner may have excluded from VPN.
  if (!torrentRuntimeAvailable()) {
    throw new Error(app.isPackaged
      ? 'Dedicated torrent runtime is missing. Reinstall Hayatan or disable dedicated torrent mode.'
      : 'Development torrent runtime is missing. Run pnpm run prepare:torrent-runtime, then restart Hayatan Dev.')
  }
  return new DedicatedTorrentProcess(script, torrentExecutable())
}
