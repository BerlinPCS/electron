import { autoUpdater } from 'electron-updater'

// autoUpdater.forceDevUpdateConfig = true

export default class Updater {
  hasUpdate = false

  constructor () {
    autoUpdater.on('update-downloaded', () => {
      this.hasUpdate = true
    })

    // Packaged builds read the GitHub repository from the generated
    // app-update.yml. Development builds can opt in with
    // autoUpdater.forceDevUpdateConfig and dev-app-update.yml.
    if (!autoUpdater.isUpdaterActive()) return
    autoUpdater.checkForUpdates()
    setInterval(() => autoUpdater.checkForUpdates(), 1000 * 60 * 30).unref() // 30 mins
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
