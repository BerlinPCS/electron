// Start a current local UI and native bundle together. An offline service-worker
// fallback must not disguise a missing preview server as a working development app.
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const frontend = fileURLToPath(new URL('../../interface/', import.meta.url))
const children = new Set()
let stopping = false
const isStopping = () => stopping
function launch (args, cwd = root) {
  const pnpm = process.env.npm_execpath
  const child = pnpm
    ? spawn(process.execPath, [pnpm, ...args], { cwd, stdio: 'inherit' })
    : spawn('pnpm', args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
  children.add(child)
  child.once('exit', () => children.delete(child))
  return child
}
function completion (child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`Development command exited: ${code ?? signal}`)))
  })
}
function stop () {
  stopping = true
  for (const child of children) child.kill('SIGTERM')
}
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
async function serving () {
  try { return (await fetch('http://localhost:7344/', { signal: AbortSignal.timeout(1000) })).ok } catch { return false }
}
try {
  // Vite preview snapshots its asset list at startup. Rebuilding underneath an
  // existing preview leaves new hashed chunks returning 404, so restart only a
  // preview positively identified as belonging to this interface checkout.
  if (await serving()) {
    if (process.platform !== 'darwin') throw new Error('Stop the existing interface preview on port 7344 first; pnpm start now manages it.')
    const pids = execFileSync('lsof', ['-t', '-iTCP:7344', '-sTCP:LISTEN'], { encoding: 'utf8' }).trim().split(/\s+/)
    for (const pid of pids) {
      const cwd = execFileSync('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn'], { encoding: 'utf8' })
      const command = execFileSync('ps', ['-p', pid, '-o', 'command='], { encoding: 'utf8' })
      if (!cwd.split('\n').includes('n' + frontend.replace(/\/$/, '')) || !/vite(?:\.js)? preview/.test(command)) throw new Error('Port 7344 belongs to another process; stop it before starting development.')
      process.kill(Number(pid), 'SIGTERM')
    }
    const deadline = Date.now() + 5000
    while (await serving()) {
      if (Date.now() >= deadline) throw new Error('The previous interface preview did not stop')
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  await completion(launch(['run', 'build'], frontend))
  if (isStopping()) process.exit(0)
  await completion(launch(['exec', 'electron-vite', 'build']))
  if (isStopping()) process.exit(0)
  await completion(launch(['run', 'prepare:torrent-runtime']))
  if (isStopping()) process.exit(0)
  if (!await serving()) {
    const preview = launch(['exec', 'vite', 'preview', '--host', 'localhost', '--port', '7344', '--strictPort'], frontend)
    /** @type {unknown} */
    let previewFailure
    const getPreviewFailure = () => previewFailure
    completion(preview).catch(error => { previewFailure = error })
    const deadline = Date.now() + 15_000
    while (!await serving()) {
      if (getPreviewFailure()) throw new Error('Interface preview failed', { cause: getPreviewFailure() })
      if (isStopping()) process.exit(0)
      if (Date.now() >= deadline) throw new Error('Interface preview did not start on port 7344')
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  if (!isStopping()) await completion(launch(['exec', 'electron-vite', 'preview']))
} catch (error) {
  if (!isStopping()) { console.error(error); process.exitCode = 1 }
} finally { stop() }
