import { optimizer } from '@electron-toolkit/utils'
import { app, dialog } from 'electron'

import App from './app.ts'
import { applyPendingHayaseMigration } from './legacy-migration.ts'
import store from './store.ts'

// Keep a global reference of the window object, if you don't, the window will
// be closed automatically when the JavaScript object is garbage collected.
let main: App | undefined
let creating: Promise<void> | undefined

function createWindow (): Promise<void> {
  creating ??= (async () => {
    try {
      await applyPendingHayaseMigration({
        currentUserData: app.getPath('userData'),
        appData: app.getPath('appData')
      })
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
