# Optional dedicated torrent process

The desktop Client settings page offers **Dedicated torrent process (VPN split
tunneling)** on packaged Windows and macOS builds that include its runtime.
It defaults to off and is stored locally in native settings. Changes require a
full quit and restart; the page shows saved and running modes separately.
Older native builds and Linux do not offer the option.

To use it with PIA:

1. Enable the option, note the displayed executable path, and quit Hayatan.
2. Add **Hayatan Torrent** to PIA as **Only VPN**. On macOS select the nested
   `Hayatan.app/Contents/Resources/torrent-runtime/Hayatan Torrent.app`; on Windows
   select `Hayatan Torrent.exe` beside `Hayatan.exe` in the installation directory.
3. Allow **Hayatan** itself to bypass PIA. Keep Tailscale active without an exit node.
4. Start Hayatan. Confirm settings report the dedicated process as running.
5. Verify private-service access, torrent egress through PIA, and that torrent
   connections stop if PIA disconnects. Repeat on each installed operating system.

Before disabling the option, restore the VPN rule on **Hayatan** itself, then
restart. A missing dedicated executable never triggers a silent fallback. If an
installation is incomplete, reinstall it; as an offline recovery step, set
`dedicatedTorrentProcess` to `false` in native `settings.json` while Hayatan is
closed, and restore the Hayatan VPN rule before reopening.

This is process separation, not an in-app interface binding or kill switch. PIA
still controls routing and may attribute child applications differently between
versions/OSes. This feature must not be described as verified leak protection
until installed acceptance passes. Search, metadata, backend sync and other main
app requests follow the main application's rule. The dedicated engine also owns
its tracker/DHT, web seed, NZB and casting connections; VPN routing can affect
local casting. Restarting after updates may require rechecking PIA's selected path.

## Implementation and validation

Default mode retains Electron's utility process. Dedicated mode runs the same
built torrent module in a separately named Electron Node runtime with matching
native-addon ABI. Packaging creates the helper before signing, preserves macOS
framework symlinks, and enables RunAsNode only in that helper; the main app keeps
its hardened fuse settings. macOS includes its own framework copy, increasing
bundle size. Windows shares the installation's runtime DLLs.

An inherited IPC pipe carries control messages and multiplexed renderer RPCs,
including callbacks and binary data; there is no new TCP control listener. The
existing local streaming server remains part of the torrent engine. Only a small
OS environment allowlist is inherited, excluding backend credentials and Node
injection flags. Parent disconnect exits the helper. Startup has a timeout, and
shutdown force-terminates the helper if graceful cleanup exceeds the deadline.

Run focused tests with `node --test test/torrent-*.test.mjs` (Node 26), or add
`--experimental-transform-types` on Node 22. After packaging, run:

```
node scripts/verify-torrent-runtime.mjs /path/to/packaged/resources
```

Use `Contents/Resources` on macOS. The smoke test uses an empty temporary library
and downloads no torrents. It checks startup, native engine loading, IPC, and
shutdown, not VPN routing. Actual Windows execution and PIA egress/disconnection
acceptance on both OSes remain required. Hosted interface changes must be deployed
alongside the updated native build for the new Client setting to appear.
