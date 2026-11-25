import { stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'

// Local builds keep the hosted origin so settings and sign-in stay in the same
// browser profile, but read their interface assets from the installed app.
export async function localInterfaceAsset (root: string, url: string): Promise<string | undefined> {
  let pathname: string
  try { pathname = decodeURIComponent(new URL(url).pathname) } catch { return }
  const base = resolve(root)
  const target = resolve(base, '.' + pathname)
  if (target !== base && !target.startsWith(base + sep)) return
  try {
    if ((await stat(target)).isFile()) return target
  } catch {}
  if (extname(pathname) || pathname.startsWith('/_app/')) return
  return resolve(base, 'index.html')
}
