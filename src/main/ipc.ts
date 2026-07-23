import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import { basename, dirname, extname } from 'node:path'

import { app, dialog, shell, type UtilityProcess, ipcMain, systemPreferences } from 'electron'
import log from 'electron-log/main'
import { autoUpdater } from 'electron-updater'

import { HoshidictsError } from './hoshidicts/client.ts'
import store from './store'

import type App from './app'
import type Discord from './discord'
import type { MiningDictionaryKind, MiningDictionaryLookupRequest } from './hoshidicts/types.ts'
import type { SessionMetadata, ClientSettings } from 'native'

const WHITELISTED_URLS = ['https://anilist.co/', 'https://github.com/sponsors/ThaUnknown/', 'https://myanimelist.net/', 'https://miru.watch', 'https://hayase.app', 'https://hayase.watch', 'https://thewiki.moe', 'https://kitsu.app']

let player: ReturnType<typeof spawn> | undefined

export default class IPC {
  app
  torrentProcess
  hideToTray = false
  discord
  corsURLS: string[] = []
  constructor (window: App, torrentProcess: UtilityProcess, discord: Discord) {
    this.app = window
    this.torrentProcess = torrentProcess
    this.discord = discord
    ipcMain.handle('version', () => app.getVersion())
  }

  openURL (url: string) {
    if (!WHITELISTED_URLS.some((whitelisted) => url.startsWith(whitelisted))) return
    shell.openExternal(url)
  }

  maximise () {
    this.app.mainWindow.isMaximized() ? this.app.mainWindow.unmaximize() : this.app.mainWindow.maximize()
  }

  close () {
    if (this.hideToTray) {
      this.app.mainWindow.hide()
    } else {
      this.app.destroy()
    }
  }

  setZoom (scale: number) {
    this.app.mainWindow.webContents.setZoomFactor(Math.min(2.5, Math.max(Number(scale) || 1, 0.3)))
  }

  setHideToTray (enabled: boolean) {
    this.hideToTray = enabled
  }

  restart () {
    app.relaunch()
    this.app.destroy()
  }

  enableCORS (urls: string[]) {
    this.corsURLS = urls.filter(url => !WHITELISTED_URLS.some(whitelisted => url.startsWith(whitelisted)))
  }

  focus () {
    this.app.mainWindow.show()
    if (this.app.mainWindow.isMinimized()) this.app.mainWindow.restore()
    this.app.mainWindow.focus()
  }

  unsafeUseInternalALAPI () {
    app.relaunch({ args: ['--use-internal-al-api'] })
    this.app.destroy()
  }

  async selectPlayer () {
    const { filePaths, canceled } = await dialog.showOpenDialog({
      title: 'Select video player executable',
      properties: ['openFile']
    })
    if (canceled || !filePaths.length) return store.get('player')

    const path = filePaths[0]!

    store.set('player', path)
    return basename(path, extname(path))
  }

  updateSettings (settings: ClientSettings = store.data.torrentSettings) {
    store.set('torrentSettings', settings)

    this.torrentProcess.postMessage({ id: 'settings', data: { ...store.data.torrentSettings, path: store.data.torrentPath } })
  }

  async selectDownload () {
    const { filePaths, canceled } = await dialog.showOpenDialog({
      title: 'Select torrent download location',
      properties: ['openDirectory']
    })
    if (canceled || !filePaths.length) return store.get('torrentPath')

    let path = filePaths[0]!

    if (dirname(path) === path) throw new Error('Cannot select root directory as download location. Please create a folder inside the desired drive and select that instead.')

    if (!(path.endsWith('\\') || path.endsWith('/'))) {
      if (path.includes('\\')) {
        path += '\\'
      } else if (path.includes('/')) {
        path += '/'
      }
    }
    store.set('torrentPath', path)
    this.updateSettings()
    return path
  }

  miningDictionaryState () {
    return this.app.hoshidicts.state()
  }

  miningDictionaryLookup (request: MiningDictionaryLookupRequest) {
    return this.app.hoshidicts.lookup(request)
  }

  async miningDictionaryImport () {
    const { filePaths, canceled } = await dialog.showOpenDialog(this.app.mainWindow, {
      title: 'Import Yomitan dictionaries',
      buttonLabel: 'Import',
      filters: [{ name: 'Yomitan dictionary ZIPs', extensions: ['zip'] }],
      properties: ['openFile', 'multiSelections']
    })

    if (canceled || filePaths.length === 0) return await this.app.hoshidicts.state()

    try {
      return await this.app.hoshidicts.import(filePaths)
    } catch (error) {
      throw sanitizeImportError(error, filePaths)
    }
  }

  miningDictionarySetEnabled (id: string, kind: MiningDictionaryKind, enabled: boolean) {
    return this.app.hoshidicts.setEnabled(id, kind, enabled)
  }

  miningDictionaryReorder (kind: MiningDictionaryKind, ids: string[]) {
    return this.app.hoshidicts.reorder(kind, ids)
  }

  miningDictionaryRemove (id: string) {
    return this.app.hoshidicts.remove(id)
  }

  miningAudioLocalState () {
    return this.app.miningAudio.state()
  }

  async miningAudioLocalImport () {
    const { filePaths, canceled } = await dialog.showOpenDialog(this.app.mainWindow, {
      title: 'Select Hoshi local audio database',
      buttonLabel: 'Import',
      filters: [{ name: 'Hoshi Android audio database', extensions: ['db', 'sqlite', 'sqlite3'] }],
      properties: ['openFile']
    })
    if (canceled || !filePaths[0]) return await this.app.miningAudio.state()
    try {
      return await this.app.miningAudio.importDatabase(filePaths[0])
    } catch {
      throw new Error('The selected file is not a supported Hoshi android.db audio database.')
    }
  }

  miningAudioLocalRemove () {
    return this.app.miningAudio.removeDatabase()
  }

  miningAudioLocalReorder (sourceOrder: string[]) {
    if (!Array.isArray(sourceOrder) || sourceOrder.length > 128 ||
        sourceOrder.some(source => typeof source !== 'string' || !source || source.length > 1024)) {
      throw new Error('Local audio source order is invalid.')
    }
    return this.app.miningAudio.reorderSources(sourceOrder)
  }

  miningAudioResolveSource (target: string, templates: string[]) {
    return this.app.miningAudio.resolveSource(target, templates)
  }

  setAngle (angle: string) {
    const current = store.get('angle')
    if (current === angle) return
    store.set('angle', angle)
    this.restart()
  }

  async getLogs () {
    return await readFile(log.transports.file.getFile().path, 'utf8')
  }

  async getDeviceInfo () {
    const { model, speed } = os.cpus()[0]!
    return {
      features: app.getGPUFeatureStatus(),
      info: await app.getGPUInfo('complete'),
      cpu: { model, speed },
      ram: os.totalmem()
    }
  }

  toggleDiscordDetails (enabled: boolean) {
    this.discord.allowDiscordDetails = enabled
    this.discord.debouncedDiscordRPC()
  }

  setMediaSession (metadata: SessionMetadata, id: number) {
    this.discord.session = metadata
    this.discord.mediaId = id
    this.discord.debouncedDiscordRPC()
  }

  setPositionState (state?: MediaPositionState) {
    this.discord.position = state
    this.discord.debouncedDiscordRPC()
  }

  setPlayBackState (paused: 'none' | 'paused' | 'playing') {
    this.discord.playback = paused
    this.discord.debouncedDiscordRPC()
  }

  setDOH (dns: string) {
    this.app.setDOH(dns)
    store.set('doh', dns)
    // this.updateSettings()
  }

  updateProgress () {
    autoUpdater.on('download-progress', (progress) => {
      this.app.mainWindow.webContents.send('update-progress', progress.percent)
    })
    autoUpdater.on('update-downloaded', () => {
      this.app.mainWindow.webContents.send('update-progress', 100)
    })
  }

  accentColor () {
    return '#' + systemPreferences.getAccentColor().slice(0, 6)
  }

  async checkUpdate () {
    await autoUpdater.checkForUpdates()
  }

  async updateReady () {
    const update = await autoUpdater.checkForUpdates()
    if (!update) throw new Error('No update available')
    await update.downloadPromise
  }

  async spawnPlayer (url: string) {
    if (!url) throw new Error('No URL provided')
    if (!url.startsWith('http://localhost:')) throw new Error('Invalid URL')
    let path = store.get('player')
    if (!path) throw new Error('No player selected')

    if (process.platform === 'darwin' && extname(path) === '.app') {
    // Mac: Use executable in packaged .app bundle
      path += `/Contents/MacOS/${basename(path, '.app')}`
    }

    player?.kill()

    await new Promise((resolve, reject) => {
      const playerProcess = spawn(path, [new URL(url).toString()], { stdio: 'ignore' })
      player = playerProcess
      this.app.mainWindow.focus()
      playerProcess.once('close', resolve)
      playerProcess.once('error', reject)
    })
    // this.dispatch('open', `intent://localhost:${this.server.address().port}${found.streamURL}#Intent;type=video/any;scheme=http;end;`)
  }
}

function sanitizeImportError (error: unknown, paths: string[]) {
  const code = error instanceof HoshidictsError ? error.code : 'IMPORT_FAILED'
  let message = error instanceof Error ? error.message : 'Dictionary import failed'
  for (const path of paths) {
    message = message.replaceAll(path, basename(path))
  }
  return new HoshidictsError({ code, message })
}
