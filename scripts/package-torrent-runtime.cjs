// Runs before signing. Use the exact packaged Electron runtime so native addon
// ABI and architecture match the torrent bundle. Never modify the main app fuse.
const { cp, mkdir, copyFile, readFile, writeFile } = require('node:fs/promises')
const { join } = require('node:path')

const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses')

/** @param {import('electron-builder').AfterPackContext} context */
module.exports = async function packageTorrentRuntime (context) {
  const { appOutDir, electronPlatformName, packager } = context
  const name = packager.appInfo.productFilename
  let target
  if (electronPlatformName === 'win32') {
    target = join(appOutDir, 'Hayatan Torrent.exe')
    await copyFile(join(appOutDir, `${name}.exe`), target)
  } else if (electronPlatformName === 'darwin') {
    const contents = join(appOutDir, `${name}.app`, 'Contents')
    target = join(contents, 'Resources', 'torrent-runtime', 'Hayatan Torrent.app')
    await mkdir(join(target, 'Contents', 'MacOS'), { recursive: true })
    await copyFile(join(contents, 'MacOS', name), join(target, 'Contents', 'MacOS', 'Hayatan Torrent'))
    await cp(join(contents, 'Frameworks'), join(target, 'Contents', 'Frameworks'), { recursive: true, verbatimSymlinks: true })
    await mkdir(join(target, 'Contents', 'Resources'), { recursive: true })
    // Preserve the upstream runtime's required metadata while giving PIA a
    // stable, distinct application identity and hiding this worker from the Dock.
    const plist = (await readFile(join(contents, 'Info.plist'), 'utf8'))
      .replace(/(<key>CFBundleExecutable<\/key>\s*<string>)[^<]*/, '$1Hayatan Torrent')
      .replace(/(<key>CFBundleIdentifier<\/key>\s*<string>)[^<]*/, '$1com.github.berlinpcs.hayatan.torrent')
      .replace(/(<key>CFBundleName<\/key>\s*<string>)[^<]*/, '$1Hayatan Torrent')
      .replace(/(<key>CFBundleDisplayName<\/key>\s*<string>)[^<]*/, '$1Hayatan Torrent')
      .replace('</dict>\n</plist>', '<key>LSUIElement</key><true/>\n</dict>\n</plist>')
    await writeFile(join(target, 'Contents', 'Info.plist'), plist)
  } else return
  await flipFuses(target, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: electronPlatformName === 'darwin',
    [FuseV1Options.RunAsNode]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false
  })
}
