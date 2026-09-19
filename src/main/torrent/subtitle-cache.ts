import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

export interface CachedSubtitle { name: string, source: string, profile?: string, rank: number, text: string }
/** Original subtitle files, scoped to the exact torrent and video file. */
export class SubtitleCache {
  private readonly operations = new Map<string, Promise<void>>()
  private root: string
  private readonly files: Map<string, unknown>
  constructor (root: string, files: Map<string, unknown>) { this.root = root; this.files = files }
  setRoot (root: string) { this.root = root }
  get storageRoot () { return this.root }
  private directory (hash: string, id?: number) {
    if (typeof hash !== 'string' || !/^[a-zA-Z0-9-]+$/.test(hash) || (id !== undefined && (!Number.isSafeInteger(id) || id < 0))) throw new Error('Invalid subtitle cache identity')
    const file = id === undefined ? undefined : this.files.get(hash + id) as { _torrent?: { path?: string } } | undefined
    const root = file?._torrent?.path ?? this.root
    return join(root, '.hayatan-subtitles', hash, ...(id === undefined ? [] : [String(id)]))
  }

  async list (hash: string, id: number): Promise<CachedSubtitle[]> {
    const directory = this.directory(hash, id)
    const names = await readdir(directory).catch(() => [])
    const results = await Promise.all(names.filter(name => name.endsWith('.json')).map(async name => {
      try {
        const meta = JSON.parse(await readFile(join(directory, name), 'utf8')) as Omit<CachedSubtitle, 'text'> & { file: string }
        if (basename(meta.file) !== meta.file) return undefined
        return { name: meta.name, source: meta.source, profile: meta.profile, rank: meta.rank, text: await readFile(join(directory, meta.file), 'utf8') }
      } catch { return undefined }
    }))
    return results.filter(value => value !== undefined)
  }

  put (hash: string, id: number, subtitle: CachedSubtitle) {
    return this.enqueue(hash, () => this.write(hash, id, subtitle))
  }

  private enqueue (hash: string, operation: () => Promise<void>) {
    const pending = (this.operations.get(hash) ?? Promise.resolve()).catch(() => {}).then(operation)
    this.operations.set(hash, pending)
    pending.finally(() => { if (this.operations.get(hash) === pending) this.operations.delete(hash) }).catch(() => {})
    return pending
  }

  private async write (hash: string, id: number, subtitle: CachedSubtitle) {
    const directory = this.directory(hash, id)
    // An obsolete renderer cannot recreate files after a torrent was removed.
    if (!this.files.has(hash + id)) return
    if (Buffer.byteLength(subtitle.text, 'utf8') > 16 * 1024 * 1024) throw new Error('Subtitle exceeds cache size limit')
    const key = createHash('sha256').update(subtitle.source + '\0' + subtitle.name).digest('hex').slice(0, 16)
    const file = `${key}-${basename(subtitle.name).replace(/[^\p{L}\p{N}._ ()[\]-]/gu, '_')}`
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, file), subtitle.text)
    await writeFile(join(directory, key + '.json'), JSON.stringify({ name: subtitle.name, source: subtitle.source, profile: subtitle.profile, rank: subtitle.rank, file }))
  }

  async removeDeleted (hashes: string[], root: string) {
    // The pinned client's manifest deletion marks a successful removal. Read
    // the captured folder: settings may have changed while removal was pending.
    const manifests = await readdir(join(root, 'hayase-cache')).catch(() => undefined)
    if (!manifests) return
    const remaining = new Set(manifests)
    for (const hash of hashes) if (!remaining.has(hash)) await this.remove(hash, root)
  }

  remove (hash: string, root = this.root) {
    return this.enqueue(hash, async () => {
      this.directory(hash) // validate the identity before resolving paths
      await rm(join(root, '.hayatan-subtitles', hash), { recursive: true, force: true })
    })
  }
}
