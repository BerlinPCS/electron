# Local Mac installation

Run `npm run build:mac:local` on the owner's Apple Silicon Mac. This packages
`dist/mac-arm64/Hayatan.app` and signs it with the certificate used by the
installed `~/Applications/AnkiLock.app`. Override its location with
`ANKILOCK_APP_PATH`, or explicitly choose a Keychain identity with
`HAYATAN_MAC_SIGNING_IDENTITY` (also accepts `ANKILOCK_MAC_SIGNING_IDENTITY`).
The private key stays in Keychain; macOS may request approval to use it.

After quitting Hayatan, replace `~/Applications/Hayatan.app` with that signed
bundle. Keep the same bundle ID, installation path and certificate on future
builds. AnkiLock includes all three in its exact application identity. Ad-hoc
signing embeds a changing code hash and produces another catalog entry on each
install. Existing historical entries are retained by AnkiLock.

The command verifies the final nested signature and rejects an ad-hoc designated
requirement. It preserves Electron/helper entitlements. This is a local install,
without notarization or Mac release publishing; Windows/Linux release packaging
is unchanged. Run the packaged torrent runtime smoke check before installing.
