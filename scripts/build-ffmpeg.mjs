import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const script = 'native/ffmpeg-build/build.sh'

if (process.platform !== 'win32') {
  run('sh', [script])
}

const roots = [
  process.env.MSYS2_ROOT,
  'C:\\msys64',
  'C:\\tools\\msys64'
].filter(Boolean)
const root = roots.find(candidate => existsSync(join(candidate, 'usr', 'bin', 'bash.exe')))

if (!root) {
  throw new Error(
    'Building FFmpeg on Windows requires MSYS2 with the UCRT64 toolchain. ' +
    'Install MSYS2, then set MSYS2_ROOT if it is not installed at C:\\msys64.'
  )
}

const bash = join(root, 'usr', 'bin', 'bash.exe')
run(bash, ['-lc', `exec ./${script}`], {
  ...process.env,
  CHERE_INVOKING: '1',
  MSYSTEM: 'UCRT64'
})

function run (command, args, env = process.env) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env,
    stdio: 'inherit'
  })
  if (result.error) throw result.error
  process.exit(result.status ?? 1)
}
