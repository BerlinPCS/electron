import { once } from 'node:events'
import { join } from 'node:path'
import process, { platform } from 'node:process'

import { electronApp, is } from '@electron-toolkit/utils'
import electronShutdownHandler from '@paymoapp/electron-shutdown-handler'
import { expose } from 'abslink/electron'
import { BrowserWindow, MessageChannelMain, app, dialog, ipcMain, powerMonitor, shell, utilityProcess, Tray, Menu, protocol, nativeImage, session, nativeTheme, webFrame } from 'electron' // type NativeImage, Notification, nativeImage,
import log from 'electron-log/main'
import { autoUpdater } from 'electron-updater'

import ico from '../../build/icon.ico?asset'
import icon from '../../build/icon.png?asset'

import './util.ts'
import { rewriteInternalRequest } from './al.ts'
import forkPath from './background/background.ts?modulePath'
import Discord from './discord.ts'
import HoshidictsSupervisor, { resolveHoshidictsExecutable } from './hoshidicts/supervisor.ts'
// import Protocol from './protocol.ts'
import IPC from './ipc.ts'
import { localAudioResponse, MiningAudioRepository } from './mining-audio.ts'
import Plugins from './plugins.ts'
import Protocol from './protocol.ts'
import store from './store.ts'
import Updater from './updater.ts'

import type { Messageable } from 'abslink'

log.initialize({ spyRendererConsole: true, preload: false })
log.transports.file.level = 'debug'
log.transports.file.maxSize = 10 * 1024 * 1024 // 10MB

log.hooks.push(message => {
  const hasMatch = message.data.some(part => typeof part === 'string' && (part.includes('Mixed Content:') || part.includes('was loaded over HTTPS, but requested an insecure')))

  if (hasMatch) return false

  return message
})

autoUpdater.logger = log

// const TRANSPARENCY = store.get('transparency')

const BASE_URL = is.dev ? 'http://localhost:7344/' : import.meta.env.MAIN_VITE_INTERFACE_URL
if (!BASE_URL) throw new Error('MAIN_VITE_INTERFACE_URL must be set for production builds')
const BASE_ORIGIN = new URL(BASE_URL).origin

protocol.registerSchemesAsPrivileged([
  { scheme: 'https', privileges: { standard: true, bypassCSP: true, allowServiceWorkers: true, supportFetchAPI: true, corsEnabled: false, stream: true, codeCache: true, secure: true } },
  { scheme: 'hayase-dictionary-media', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
  { scheme: 'hayase-local-audio', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }
])

function setCors (record?: Record<string, string[]>, credentails = false) {
  if (!record) return
  if (record['access-control-allow-origin'] ?? record['Access-Control-Allow-Origin']) return
  record['access-control-allow-origin'] = ['*']
  record['access-control-allow-methods'] = ['GET, POST, PUT, DELETE, OPTIONS, PATCH']
  record['access-control-allow-headers'] = ['*']
  if (credentails) record['access-control-allow-credentials'] = ['true']
}

export default class App {
  torrentProcess = utilityProcess.fork(forkPath, [], {
    stdio: ['ignore', 'pipe', 'pipe'],
    serviceName: 'Hayatan Torrent Client'
  })

  mainWindow = new BrowserWindow({
    width: 1600,
    height: 869,
    frame: false, // process.platform === 'darwin', // Only keep the native frame on Mac
    titleBarStyle: 'hidden',
    autoHideMenuBar: true,
    // transparent: TRANSPARENCY,
    resizable: true,
    maximizable: true,
    fullscreenable: true,
    show: false,
    title: 'Hayatan',
    backgroundColor: '#000000',
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: true,
      enableBlinkFeatures: 'FluentOverlayScrollbars,FluentOverlayScrollbar',
      backgroundThrottling: true
    }
  })

  protocol = new Protocol(this.mainWindow)
  plugins = new Plugins(this.mainWindow)
  updater = new Updater()
  discord = new Discord()
  hoshidicts = new HoshidictsSupervisor({
    executable: resolveHoshidictsExecutable({
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
      isPackaged: app.isPackaged
    }),
    dictionaryRoot: join(app.getPath('userData'), 'mining', 'dictionaries'),
    onEvent: event => {
      if (!this.destroyed && !this.mainWindow.webContents.isDestroyed()) {
        this.mainWindow.webContents.send('mining-dictionary-event', event)
      }
    }
  })

  miningAudio = new MiningAudioRepository(join(app.getPath('userData'), 'mining', 'audio'))

  ipc = new IPC(this, this.torrentProcess, this.discord)
  tray = new Tray(process.platform === 'win32' ? ico : process.platform === 'darwin' ? nativeImage.createFromPath(icon).resize({ width: 16, height: 16 }) : icon)

  unsafeUseInternalALAPI = process.argv.includes('--use-internal-al-api')

  constructor () {
    protocol.handle('hayase-dictionary-media', async request => {
      try {
        const url = new URL(request.url)
        if (url.hostname !== 'media') return new Response('Not found', { status: 404 })
        const dictionary = url.searchParams.get('dictionary')
        const mediaPath = url.searchParams.get('path')
        if (!dictionary || !mediaPath) return new Response('Invalid dictionary media request', { status: 400 })
        const media = await this.hoshidicts.media(dictionary, mediaPath)
        return new Response(new Uint8Array(media), {
          headers: {
            'Cache-Control': 'no-store',
            'Content-Type': dictionaryMediaContentType(mediaPath),
            'Cross-Origin-Resource-Policy': 'cross-origin'
          }
        })
      } catch (error) {
        log.warn('[hoshidicts] dictionary media request failed:', error)
        return new Response('Dictionary media not found', { status: 404 })
      }
    })
    protocol.handle('hayase-local-audio', async request => {
      try {
        const url = new URL(request.url)
        if (url.hostname !== 'audio') return new Response('Not found', { status: 404 })
        const source = url.searchParams.get('source')
        const file = url.searchParams.get('file')
        if (!source || !file) return new Response('Invalid local audio request', { status: 400 })
        const audio = await this.miningAudio.loadLocalAudio(source, file)
        if (!audio) return new Response('Local audio not found', { status: 404 })
        return localAudioResponse(audio, file, request.headers.get('range'))
      } catch (error) {
        log.warn('[mining-audio] local audio request failed:', error)
        return new Response('Local audio not found', { status: 404 })
      }
    })
    this.hoshidicts.start().catch(error => log.warn('[hoshidicts] startup deferred:', error))
    if (store.data.doh) this.setDOH(store.data.doh)
    nativeTheme.themeSource = 'dark'
    expose(this.ipc, ipcMain, this.mainWindow.webContents as Messageable)

    const userAgent = session.defaultSession.getUserAgent().replace(/\s+(Electron|hayase)\/[\d.]+/gi, '')
    session.defaultSession.setUserAgent(userAgent)
    app.userAgentFallback = userAgent
    this.mainWindow.webContents.session.setUserAgent(userAgent)
    this.mainWindow.webContents.setUserAgent(userAgent)
    this.mainWindow.setMenuBarVisibility(false)

    this.mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (!url.startsWith('https://anilist.co/api/v2/oauth/authorize') && !url.startsWith('https://myanimelist.net/v1/oauth2/authorize')) return { action: 'deny' }
      return {
        action: 'allow',
        createWindow (options) {
          const win = new BrowserWindow(
            url.startsWith('https://anilist.co/api/v2/oauth/authorize')
              ? { ...options, resizable: false, fullscreenable: false, title: 'AniList', titleBarOverlay: { color: '#0b1622' }, titleBarStyle: 'hidden', backgroundColor: '#0b1622' }
              : { ...options, resizable: false, fullscreenable: false, title: 'MyAnimeList', titleBarOverlay: { color: '#ffffff' }, titleBarStyle: 'hidden', backgroundColor: '#ffffff' }
          )
          win.setMenuBarVisibility(false)
          win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
          win.webContents.session.setUserAgent(userAgent)
          win.webContents.setUserAgent(userAgent)
          return win.webContents
        }
      }
    })

    // not insanely safe, but fixes VPNs breaking w2g
    this.mainWindow.webContents.setWebRTCIPHandlingPolicy('default_public_and_private_interfaces')

    this.torrentProcess.stderr?.on('data', d => console.error('' + d))
    this.torrentProcess.stdout?.on('data', d => console.log('' + d))
    // if (TRANSPARENCY) {
    // // Transparency fixes, window is resizable when fullscreen/maximized
    //   this.mainWindow.on('enter-html-full-screen', () => {
    //     this.mainWindow.setResizable(false)
    //   })
    //   this.mainWindow.on('leave-html-full-screen', () => {
    //     this.mainWindow.setResizable(!this.mainWindow.isMaximized())
    //   })
    //   this.mainWindow.on('enter-full-screen', () => {
    //     this.mainWindow.setResizable(false)
    //   })
    //   this.mainWindow.on('leave-full-screen', () => {
    //     this.mainWindow.setResizable(!this.mainWindow.isMaximized())
    //   })
    //   this.mainWindow.on('maximize', () => {
    //     this.mainWindow.setResizable(false)
    //   })
    //   this.mainWindow.on('unmaximize', () => {
    //     this.mainWindow.setResizable(true)
    //   })

    //   this.mainWindow.on('will-move', (e) => {
    //     if (this.mainWindow.isMaximized()) {
    //       this.mainWindow.setResizable(true)
    //       this.mainWindow.unmaximize()
    //       e.preventDefault()
    //     }
    //   })
    // }

    if (this.unsafeUseInternalALAPI) {
      session.defaultSession.webRequest.onBeforeRequest({ urls: ['https://graphql.anilist.co/*'] }, (details, callback) => {
        if (details.method !== 'POST') return callback({ cancel: false })
        callback({ redirectURL: 'https://anilist.co/graphql/' })
      })
    }

    session.defaultSession.webRequest.onBeforeSendHeaders(async (details, callback) => {
      if (details.url.startsWith('https://graphql.anilist.co')) {
        details.requestHeaders.Referer = 'https://anilist.co/'
        details.requestHeaders.Origin = 'https://anilist.co'
        delete details.requestHeaders['User-Agent']
      }

      if (details.url.startsWith('https://anilist.co/graphql') && this.unsafeUseInternalALAPI && details.method !== 'GET') await rewriteInternalRequest(details)

      callback({ cancel: false, requestHeaders: details.requestHeaders })
    })

    // anilist.... forgot to set the cache header on their preflights..... pathetic.... this just wastes rate limits, this fixes it!
    // they also don't set CORS headers on errors
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      if (details.url.startsWith('https://graphql.anilist.co') && details.responseHeaders) {
        setCors(details.responseHeaders)
        if (details.method === 'OPTIONS') {
          details.responseHeaders['Cache-Control'] = ['public, max-age=86400']
          details.responseHeaders['access-control-max-age'] = ['86400']
          details.statusLine = '204 No Content'
          details.statusCode = 204
        }
      }

      if (details.url.startsWith('https://anilist.co/graphql') && this.unsafeUseInternalALAPI) setCors(details.responseHeaders)

      // MAL doesn't implement CORS....
      // enable CORS for any extensions that want it, but only for specific urls
      if (details.url.startsWith('https://myanimelist.net/v1/oauth2') || details.url.startsWith('https://api.myanimelist.net/v2/') || this.ipc.corsURLS.some(corsUrl => details.url.startsWith(corsUrl))) {
        setCors(details.responseHeaders, true)
        if (details.method === 'OPTIONS' && (details.statusCode / 100 | 0) !== 2) {
          details.statusLine = '200 OK'
          details.statusCode = 200
        }
      }

      callback(details)
    })

    this.tray.setToolTip('Hayatan')
    // this needs to be way better lol
    this.tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Hayatan', enabled: false },
      { type: 'separator' },
      {
        label: 'Show App',
        click: () => {
          this.mainWindow.show()
          this.mainWindow.focus()
        }
      },
      { type: 'separator' },
      { label: 'Exit Hayatan', click: () => this.destroy() }
    ]))
    this.tray.on('click', () => {
      this.mainWindow.show()
      this.mainWindow.focus()
    })

    this.mainWindow.once('ready-to-show', () => {
      this.mainWindow.show()
    })

    this.mainWindow.on('closed', () => this.destroy())
    this.torrentProcess.on('exit', () => this.destroy())
    ipcMain.on('close', () => this.destroy())
    app.on('before-quit', e => {
      if (this.destroyed) return
      e.preventDefault()
      this.destroy()
    })

    this.mainWindow.webContents.on('frame-created', (_, { frame }) => {
      frame?.once('dom-ready', () => {
        if (frame.url.startsWith('https://www.youtube-nocookie.com')) {
          frame.executeJavaScript(/* js */`
            new MutationObserver(() => {
              if (document.querySelector('div.ytp-error-content-wrap-subreason a[href*="www.youtube"]')) location.reload()
            }).observe(document.body, { childList: true, subtree: true })
          `)
        }
      })
    })

    // @ts-expect-error idk brokey
    powerMonitor.on('shutdown', (e: Event) => {
      if (this.destroyed) return
      e.preventDefault()
      this.destroy()
    })

    // TODO
    // ipcMain.on('notification', async (_e, opts: { icon?: string | NativeImage, data: { id?: number }}) => {
    //   if (opts.icon != null) {
    //     const res = await fetch(opts.icon as string)
    //     const buffer = await res.arrayBuffer()
    //     opts.icon = nativeImage.createFromBuffer(Buffer.from(buffer))
    //   }
    //   const notification = new Notification(opts)
    //   notification.on('click', () => {
    //     if (opts.data.id != null) {
    //       this.mainWindow.show()
    //       this.protocol.protocolMap.anime(',' + opts.data.id)
    //     }
    //   })
    //   notification.show()
    // })

    electronApp.setAppUserModelId('com.github.berlinpcs.hayatan')
    if (process.platform === 'win32') {
      // this message usually fires in dev-mode from the parent process
      process.on('message', data => {
        if (data === 'graceful-exit') this.destroy()
      })
      electronShutdownHandler.setWindowHandle(this.mainWindow.getNativeWindowHandle())
      electronShutdownHandler.blockShutdown('Saving torrent data...')
      electronShutdownHandler.on('shutdown', async () => {
        await this.destroy()
        electronShutdownHandler.releaseShutdown()
      })
    } else {
      process.on('SIGTERM', () => this.destroy())
    }

    if (is.dev) this.mainWindow.webContents.openDevTools()
    this.mainWindow.loadURL(BASE_URL, { userAgent }).catch(err => {
      log.error(err)
      if (this.hasDOH) return
      this.setDOH('https://cloudflare-dns.com/dns-query')
      queueMicrotask(() => this.mainWindow.loadURL(BASE_URL, { userAgent }))
    })
    this.mainWindow.webContents.on('will-navigate', (e, url) => {
      const parsedUrl = new URL(url)
      if (parsedUrl.origin !== BASE_ORIGIN) {
        e.preventDefault()
      }
    })

    const history = this.mainWindow.webContents.navigationHistory
    const back = () => history.canGoBack() && history.goBack()
    const forward = () => history.canGoForward() && history.goForward()

    if (platform === 'win32' || platform === 'darwin') {
      this.mainWindow.on('app-command', (_e, command) => {
        if (command === 'browser-backward') back()
        else if (command === 'browser-forward') forward()
      })
    }

    this.mainWindow.on('swipe', (_e, direction) => {
      if (direction === 'left') back()
      else if (direction === 'right') forward()
    })

    let crashcount = 0
    this.mainWindow.webContents.on('render-process-gone', async (_e, { reason }) => {
      if (reason === 'crashed') {
        if (++crashcount > 10) {
          // TODO
          await dialog.showMessageBox({ message: 'Crashed too many times.', title: 'Hayatan', detail: 'App crashed too many times. Please report this at https://github.com/BerlinPCS/electron/issues.', icon })
          shell.openExternal('https://github.com/BerlinPCS/electron/issues')
        } else {
          app.relaunch()
        }
        app.quit()
      }
    })

    const reloadPorts = () => {
      if (this.destroyed) return
      const { port1, port2 } = new MessageChannelMain()
      this.torrentProcess.postMessage({ id: 'settings', data: { ...store.data.torrentSettings, path: store.data.torrentPath } }, [port1])

      this.mainWindow.webContents.postMessage('port', null, [port2])
    }

    const { port1, port2 } = new MessageChannelMain()
    this.torrentProcess.once('spawn', () => this.torrentProcess.postMessage({ id: 'settings', data: { ...store.data.torrentSettings, path: store.data.torrentPath, doh: this.hasDOH && store.data.doh } }, [port1]))
    ipcMain.once('preload-done', () => {
      this.mainWindow.webContents.postMessage('port', null, [port2])
      ipcMain.on('preload-done', () => reloadPorts())
    })

    app.on('second-instance', (_event, commandLine) => {
      if (this.destroyed) return
      // Someone tried to run a second instance, we should focus our window.
      this.mainWindow.show()
      this.mainWindow.focus()
      if (this.mainWindow.isMinimized()) this.mainWindow.restore()
      this.mainWindow.focus()
      // There's probably a better way to do this instead of a for loop and split[1][0]
      // but for now it works as a way to fix multiple OS's commandLine differences
      for (const line of commandLine) {
        this.protocol.handleProtocol(line)
      }
    })

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    app.setJumpList?.([
      {
        type: 'custom',
        name: 'Frequent',
        items: [
          {
            type: 'task',
            program: 'hayatan://schedule/',
            title: 'Airing Schedule',
            description: 'Open The Airing Schedule'
          },
          {
            type: 'task',
            program: 'hayatan://w2g/',
            title: 'Watch Together',
            description: 'Create a New Watch Together Lobby'
          },
          {
            type: 'task',
            program: 'hayatan://donate/',
            title: 'Donate',
            description: 'Support This App'
          },
          {
            type: 'task',
            program: 'hayatan://devtools/',
            title: 'Devtools',
            description: 'Open Devtools'
          }
        ]
      }
    ])
  }

  hasDOH = false
  setDOH (dns: string) {
    try {
      if (!dns) {
        app.configureHostResolver({ secureDnsMode: 'off' })
        this.hasDOH = false
        return
      }
      app.configureHostResolver({
        secureDnsMode: 'secure',
        secureDnsServers: [dns]
      })
      this.hasDOH = true
    } catch (e) {
      const err = e as Error
      console.error('Failed to set DOH: ', err.stack)
      this.hasDOH = false
    }
  }

  destroyed = false

  hideToTray () {
    if (this.destroyed) return
    this.mainWindow.hide()
    webFrame.clearCache()
  }

  async destroy (forceRunAfter = false) {
    if (this.destroyed) return
    this.destroyed = true
    try {
      this.mainWindow.hide()
    } catch {}
    try {
      this.torrentProcess.postMessage({ id: 'destroy' })
      await once(this.torrentProcess, 'exit', { signal: AbortSignal.timeout(5000) })
      this.torrentProcess.kill()
    } catch {}
    try {
      await this.hoshidicts.shutdown()
    } catch {}
    if (!this.updater.install(forceRunAfter)) app.quit()
  }
}

function dictionaryMediaContentType (path: string) {
  const extension = path.split('.').pop()?.toLowerCase()
  const contentTypes: Record<string, string> = {
    apng: 'image/apng',
    avif: 'image/avif',
    bmp: 'image/bmp',
    gif: 'image/gif',
    ico: 'image/x-icon',
    jpeg: 'image/jpeg',
    jpg: 'image/jpeg',
    png: 'image/png',
    svg: 'image/svg+xml',
    webp: 'image/webp'
  }
  return contentTypes[extension ?? ''] ?? 'application/octet-stream'
}
