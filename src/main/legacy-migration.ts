import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import process from 'node:process'

const IMPORT_MARKER = '.hayase-import.json'
const PENDING_IMPORT = '.hayatan-hayase-import.json'
const PROFILE_ENTRIES = new Set([
  'settings.json',
  'Local State',
  'Preferences',
  'Cookies',
  'Local Storage',
  'IndexedDB',
  'Session Storage',
  'Service Worker',
  'WebStorage',
  'mining'
])
const VOLATILE_ENTRIES = new Set([
  'Cache',
  'Code Cache',
  'Crashpad',
  'DawnCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'GPUCache',
  'GrShaderCache',
  'GraphiteDawnCache',
  'ShaderCache',
  'blob_storage',
  'logs'
])

export interface HayaseMigrationPaths {
  currentUserData: string
  appData: string
}

export interface HayaseMigrationState {
  available: boolean
  source?: string
}

export async function getHayaseMigrationState ({
  currentUserData,
  appData
}: HayaseMigrationPaths): Promise<HayaseMigrationState> {
  const source = await findLegacyProfile(appData, currentUserData)
  return source ? { available: true, source } : { available: false }
}

export async function scheduleHayaseMigration (paths: HayaseMigrationPaths): Promise<boolean> {
  const state = await getHayaseMigrationState(paths)
  if (!state.source) return false
  await writeFile(pendingImportPath(paths.appData), JSON.stringify({
    version: 1,
    source: state.source,
    requestedAt: new Date().toISOString()
  }))
  return true
}

export async function applyPendingHayaseMigration ({
  currentUserData,
  appData
}: HayaseMigrationPaths): Promise<boolean> {
  const pendingPath = pendingImportPath(appData)
  if (!await pathExists(pendingPath)) return false

  let source: string
  try {
    source = await pendingSource(pendingPath)
  } catch (error) {
    await rm(pendingPath, { force: true })
    throw error
  }
  const expectedSource = await findLegacyProfile(appData, currentUserData)
  if (!expectedSource || normalizedPath(source) !== normalizedPath(expectedSource)) {
    await rm(pendingPath, { force: true })
    throw new Error('The Hayase profile selected for import is no longer available.')
  }

  const stagingPath = join(dirname(currentUserData), `.hayase-import-${process.pid}`)
  const backupPath = join(dirname(currentUserData), `.hayatan-backup-${process.pid}`)
  const backedUpEntries: string[] = []
  const installedEntries: string[] = []
  await rm(stagingPath, { recursive: true, force: true })
  await rm(backupPath, { recursive: true, force: true })

  try {
    await cp(source, stagingPath, {
      recursive: true,
      preserveTimestamps: true,
      filter: candidate => shouldImportPath(source, candidate)
    })
    await mkdir(currentUserData, { recursive: true })
    await mkdir(backupPath, { recursive: true })

    for (const entry of await readdir(currentUserData)) {
      if (shouldPreserveTargetEntry(entry)) continue
      await rename(join(currentUserData, entry), join(backupPath, entry))
      backedUpEntries.push(entry)
    }

    for (const entry of await readdir(stagingPath)) {
      const target = join(currentUserData, entry)
      installedEntries.push(entry)
      await cp(join(stagingPath, entry), target, {
        recursive: true,
        preserveTimestamps: true
      })
    }

    await writeFile(join(currentUserData, IMPORT_MARKER), JSON.stringify({
      version: 1,
      source,
      importedAt: new Date().toISOString()
    }))
    await rm(pendingPath, { force: true })
    return true
  } catch (error) {
    for (const entry of installedEntries.reverse()) {
      await rm(join(currentUserData, entry), { recursive: true, force: true }).catch(() => {})
    }
    for (const entry of backedUpEntries.reverse()) {
      await rename(join(backupPath, entry), join(currentUserData, entry)).catch(() => {})
    }
    await rm(pendingPath, { force: true }).catch(() => {})
    throw error
  } finally {
    await rm(stagingPath, { recursive: true, force: true }).catch(() => {})
    await rm(backupPath, { recursive: true, force: true }).catch(() => {})
  }
}

async function findLegacyProfile (appData: string, currentUserData: string): Promise<string | undefined> {
  const current = normalizedPath(currentUserData)
  for (const candidate of [join(appData, 'Hayase'), join(appData, 'hayase')]) {
    if (normalizedPath(candidate) === current) continue
    if (await hasProfileData(candidate)) return candidate
  }
  return undefined
}

async function hasProfileData (profilePath: string): Promise<boolean> {
  try {
    const entries = await readdir(profilePath)
    return entries.some(entry => PROFILE_ENTRIES.has(entry))
  } catch {
    return false
  }
}

function shouldImportPath (legacyRoot: string, source: string): boolean {
  const pathWithinProfile = relative(legacyRoot, source)
  if (!pathWithinProfile) return true
  const firstEntry = pathWithinProfile.split(/[\\/]/, 1)[0] ?? ''
  return !VOLATILE_ENTRIES.has(firstEntry) &&
    !firstEntry.startsWith('Singleton') &&
    basename(source) !== IMPORT_MARKER
}

function shouldPreserveTargetEntry (entry: string): boolean {
  return VOLATILE_ENTRIES.has(entry) || entry.startsWith('Singleton')
}

async function pendingSource (pendingPath: string): Promise<string> {
  const pending = JSON.parse(await readFile(pendingPath, 'utf8')) as { version?: unknown, source?: unknown }
  if (pending.version !== 1 || typeof pending.source !== 'string' || !pending.source) {
    throw new Error('The pending Hayase import request is invalid.')
  }
  return pending.source
}

function pendingImportPath (appData: string): string {
  return join(appData, PENDING_IMPORT)
}

async function pathExists (path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function normalizedPath (path: string): string {
  const normalized = join(path)
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized
}
