// This module must run before stores, sessions, logging and the instance lock.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { app } from 'electron'

if (!app.isPackaged) {
  const profile = join(app.getPath('appData'), 'Hayatan Dev')
  mkdirSync(profile, { recursive: true })
  app.setName('Hayatan Dev')
  app.setPath('userData', profile)
  app.setPath('sessionData', profile)
  app.setAppLogsPath(join(profile, 'logs'))
}
