# Hayatan 7.1.4

- Add backend connection settings with encrypted source-token storage, a connection test, and durable immersion event delivery. GitHub 7.1.3 did not include this integration even though the hosted interface showed its settings.
- Preserve queued events across restarts and offline periods, acknowledge deliveries, and bound network requests.
- Handle background update-check failures and explain when a local build has no update feed. Do not report an unchanged release as ready to install.

GitHub downloads are Windows x64 and Linux x64 only. macOS remains locally built and installed; there is no Mac GitHub update channel. Existing local installations require a local rebuild for updates.

Validation: 4 updater regression tests, 5 immersion range tests, and the Electron encrypted-storage/connection/restart/offline-recovery harness pass on macOS. Local production compilation and ARM64 directory packaging pass. The wider Node 22 suite has 51 passes and 3 existing failures (temporary-path canonicalization, FFmpeg test fixture, audio-duration fixture). Full typecheck has existing dependency/test errors. Windows/Linux release builds and installed Windows backend connection acceptance must be checked separately.
