import { optimizer } from '@electron-toolkit/utils'
import { app, BrowserWindow, dialog } from 'electron'

import App, { BASE_ORIGIN } from './app.ts'
import { applyPendingHayaseMigration, migrateImportedHayaseLocalStorage } from './legacy-migration.ts'
import store from './store.ts'

// Keep a global reference of the window object, if you don't, the window will
// be closed automatically when the JavaScript object is garbage collected.
let main: App | undefined
let creating: Promise<void> | undefined

async function migrateImportedBrowserStorage () {
  let bridge: BrowserWindow | undefined
  await migrateImportedHayaseLocalStorage(app.getPath('userData'), async sourceOrigin => {
    if (sourceOrigin === BASE_ORIGIN) return
    bridge = new BrowserWindow({ show: false })
    try {
      await bridge.loadURL(new URL('/logo_white.svg', sourceOrigin).href)
      const entries = await bridge.webContents.executeJavaScript('Object.entries(localStorage)') as unknown
      if (!Array.isArray(entries)) throw new Error('Hayase local storage could not be read.')
      const safeEntries = entries.filter((entry): entry is [string, string] =>
        Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string'
      )

      await bridge.loadURL(new URL('/logo_white.svg', BASE_ORIGIN).href)
      await bridge.webContents.executeJavaScript(`
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
  return bridge
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
