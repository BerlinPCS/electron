import { optimizer } from '@electron-toolkit/utils'
import { app, BrowserWindow, dialog } from 'electron'

import App, { BASE_ORIGIN } from './app.ts'
import {
  applyPendingHayaseMigration,
  migrateImportedHayaseExtensionStorage,
  migrateImportedHayaseLocalStorage
} from './legacy-migration.ts'
import store from './store.ts'

// Keep a global reference of the window object, if you don't, the window will
// be closed automatically when the JavaScript object is garbage collected.
let main: App | undefined
let creating: Promise<void> | undefined

async function migrateImportedBrowserStorage () {
  let bridge: BrowserWindow | undefined
  const getBridge = () => {
    bridge ??= new BrowserWindow({
      show: false,
      webPreferences: {
        sandbox: true,
        webSecurity: true
      }
    })
    return bridge
  }

  await migrateImportedHayaseLocalStorage(app.getPath('userData'), async sourceOrigin => {
    if (sourceOrigin === BASE_ORIGIN) return
    try {
      const migrationWindow = getBridge()
      await migrationWindow.loadURL(new URL('/logo_white.svg', sourceOrigin).href)
      const entries = await migrationWindow.webContents.executeJavaScript('Object.entries(localStorage)') as unknown
      if (!Array.isArray(entries)) throw new Error('Hayase local storage could not be read.')
      const safeEntries = entries.filter((entry): entry is [string, string] =>
        Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string'
      )

      await migrationWindow.loadURL(new URL('/logo_white.svg', BASE_ORIGIN).href)
      await migrationWindow.webContents.executeJavaScript(`
        for (const [key, value] of ${JSON.stringify(safeEntries)}) {
          localStorage.setItem(key, value)
        }
      `)
    } catch (error) {
      bridge.destroy()
      bridge = undefined
      throw error
    }
  })

  await migrateImportedHayaseExtensionStorage(app.getPath('userData'), async sourceOrigin => {
    if (sourceOrigin === BASE_ORIGIN) return
    try {
      const migrationWindow = getBridge()
      await migrationWindow.loadURL(new URL('/logo_white.svg', sourceOrigin).href)
      const entries = await migrationWindow.webContents.executeJavaScript(readExtensionCacheScript()) as unknown
      const safeEntries = extensionCacheEntries(entries)

      await migrationWindow.loadURL(new URL('/logo_white.svg', BASE_ORIGIN).href)
      await migrationWindow.webContents.executeJavaScript(writeExtensionCacheScript(safeEntries))
    } catch (error) {
      bridge?.destroy()
      bridge = undefined
      throw error
    }
  })
  return bridge
}

function extensionCacheEntries (entries: unknown): Array<[string, string]> {
  if (!Array.isArray(entries)) throw new Error('Hayase extension storage could not be read.')
  return entries.filter((entry): entry is [string, string] =>
    Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string'
  )
}

function readExtensionCacheScript (): string {
  return /* js */`(async () => {
    let configs
    try {
      configs = JSON.parse(localStorage.getItem('extensions') || '{}')
    } catch {
      return []
    }
    const ids = Object.keys(configs)
    if (!ids.length) return []
    if (indexedDB.databases && !(await indexedDB.databases()).some(database => database.name === 'keyval-store')) return []

    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('keyval-store')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    if (!database.objectStoreNames.contains('keyval')) {
      database.close()
      return []
    }

    const transaction = database.transaction('keyval', 'readonly')
    const objectStore = transaction.objectStore('keyval')
    const entries = await Promise.all(ids.map(key => new Promise((resolve, reject) => {
      const request = objectStore.get(key)
      request.onsuccess = () => resolve([key, request.result])
      request.onerror = () => reject(request.error)
    })))
    database.close()
    return entries.filter(([, value]) => typeof value === 'string')
  })()`
}

function writeExtensionCacheScript (entries: Array<[string, string]>): string {
  return /* js */`(async () => {
    const entries = ${JSON.stringify(entries)}
    if (!entries.length) return
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('keyval-store')
      request.onupgradeneeded = () => request.result.createObjectStore('keyval')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    if (!database.objectStoreNames.contains('keyval')) {
      database.close()
      throw new Error('Hayatan extension storage is invalid.')
    }

    await new Promise((resolve, reject) => {
      const transaction = database.transaction('keyval', 'readwrite')
      const objectStore = transaction.objectStore('keyval')
      for (const [key, value] of entries) {
        const request = objectStore.get(key)
        request.onsuccess = () => {
          if (request.result === undefined) objectStore.put(value, key)
        }
      }
      transaction.oncomplete = () => resolve()
      transaction.onabort = transaction.onerror = () => reject(transaction.error)
    })
    database.close()
  })()`
}

function createWindow (): Promise<void> {
  creating ??= (async () => {
    let migrationBridge: BrowserWindow | undefined
    try {
      await applyPendingHayaseMigration({
        currentUserData: app.getPath('userData'),
        appData: app.getPath('appData')
      })
      migrationBridge = await migrateImportedBrowserStorage()
    } catch (error) {
      console.error('Could not import Hayase data:', error)
      await dialog.showMessageBox({
        type: 'error',
        title: 'Hayase import failed',
        message: 'Hayatan could not import your Hayase profile.',
        detail: error instanceof Error ? error.message : String(error)
      })
    }
    store.reload()
    main = new App()
    migrationBridge?.destroy()
  })().finally(() => {
    creating = undefined
  })
  return creating
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
// Menu.setApplicationMenu(null) // performance, but no keyboard shortcuts, sucks
  app.on('ready', () => { createWindow().catch(console.error) })

  app.on('activate', () => {
    if (main == null) createWindow().catch(console.error)
  })

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })
}
