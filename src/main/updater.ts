import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { autoUpdater } from 'electron-updater'

export default class Updater {
  hasUpdate = false

  constructor () {
    autoUpdater.on('update-downloaded', () => {
      this.hasUpdate = true
    })

    if (!autoUpdater.isUpdaterActive() || !this.hasConfiguration()) return
    // Errors are already reported through electron-updater's logger/event.
    void this.check().catch(() => undefined)
    setInterval(() => { void this.check().catch(() => undefined) }, 1000 * 60 * 30).unref()
  }

  private hasConfiguration () {
    return autoUpdater.forceDevUpdateConfig || existsSync(join(process.resourcesPath, 'app-update.yml'))
  }

  async check () {
    if (!autoUpdater.isUpdaterActive()) return null
    if (!this.hasConfiguration()) {
      throw new Error('This local build has no update feed. Update it with a new local build.')
    }
    return autoUpdater.checkForUpdates()
  }

  async ready () {
    const update = await this.check()
    if (!update || update.isUpdateAvailable === false) throw new Error('No update available')
    await update.downloadPromise
  }

  install (forceRunAfter = false) {
    if (this.hasUpdate) {
      autoUpdater.quitAndInstall(true, forceRunAfter)
      this.hasUpdate = false
      return true
    }
    return false
  }
}
