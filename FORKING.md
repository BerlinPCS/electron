# Maintaining and releasing Hayatan

Hayatan is kept as a downstream fork of Hayase. Keep `origin` pointed at the
Hayatan repository and `upstream` pointed at Hayase:

```sh
git remote -v
git fetch upstream
git switch main
git merge upstream/main
```

Resolve conflicts, run the checks, bump `version` in `package.json`, and commit
the merge separately from any Hayatan-only fixes when practical. Keeping the
branding and release configuration in small, dedicated commits makes later
upstream merges easier to review.

## Independent application identity

The following values must stay unique so Hayatan and Hayase can coexist:

- `appId`, `productName`, executable name, Linux desktop name, and installer
  metadata in `electron-builder.yml`
- the `hayatan://` operating-system URL scheme
- the Windows Application User Model ID in `src/main/app.ts`
- the package name, updater cache name, and GitHub publish repository

Do not rename internal TypeScript variables or private in-app protocols merely
for branding. Names such as `hayase-dictionary-media` are implementation
details, are shared with the interface, and do not affect side-by-side OS
installation.

Use a new icon before public release so users can distinguish the two apps.
Replace `build/icon.ico`, `build/icon.icns`, and `build/icon.png` together.

## License check before public distribution

Branding a fork does not change its license. The checked-in Business Source
License 1.1 allows copying, modification, redistribution, and non-production
use, but says uses outside its current grant require a commercial license. It
changes to GPL-3.0 on 2029-04-01. Preserve the license conspicuously and confirm
with the Hayase licensor or qualified counsel that the intended public release
and users' use are permitted before publishing installers. This section is a
warning, not legal advice.

## Interface hosting

The Electron shell currently loads the interface from `BASE_URL` in
`src/main/app.ts`. Development uses the local interface server on port 7344.
Before making a production build:

1. Build and deploy the `BerlinPCS/interface` repository under a Hayatan-owned
   HTTPS origin.
2. Add that full origin, including `https://`, as the `HAYATAN_INTERFACE_URL`
   GitHub Actions repository variable. Electron Vite embeds it into production
   builds as `MAIN_VITE_INTERFACE_URL`.
3. Add only the external origins the interface really needs to
   `WHITELISTED_URLS` in `src/main/ipc.ts`.
4. Replace Hayase website, support, W2G, OAuth callback, Discord application,
   and donation URLs as Hayatan-owned equivalents become available.

Until this is done, the shell is independently installable but the product is
not operationally independent from Hayase's web services.

## GitHub releases and automatic updates

`electron-builder.yml` publishes update metadata and installers to
`BerlinPCS/electron`. Packaged builds read that generated `app-update.yml`;
`src/main/updater.ts` must not override it with a Hayase feed URL.

The release workflow runs only for version tags. The tag and package version
must match:

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run lint
git tag v6.4.89
git push origin main
git push origin v6.4.89
```

GitHub Actions currently builds and publishes only the Windows x64 NSIS
installer. The macOS and Linux electron-builder targets remain available if
multi-platform releases are needed later.

### Signing secrets

For trusted public distribution, configure repository Actions secrets:

- Windows: `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD`

Never commit signing certificates or passwords. Windows can be shipped unsigned
for testing, but users will see SmartScreen warnings; signing is strongly
recommended for releases and reliable update trust.

## Remaining upstream dependencies

The `native` and `torrent-client` packages and several hosted APIs still point
at Hayase-owned projects. The legacy `electron-dist` gitlink remains in the
repository but is no longer checked out or used by the build. Fork and repoint
the remaining dependencies only when you need operational control or when
upstream compatibility becomes a problem; doing so increases the maintenance
burden.
