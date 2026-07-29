# ThaUnknown npm package cache

This directory mirrors the exact npm tarballs used by Hayatan for packages
maintained by, scoped to, or hosted under ThaUnknown.

`package.json` uses pnpm overrides to resolve these versions from the local
tarballs. This keeps clean and frozen CI installs working if an upstream npm
version is later unpublished.

The tarballs were downloaded with `npm pack` and are unmodified. Verify them
with:

```sh
sha256sum --check npm-package-cache/SHA256SUMS
```

When updating a cached dependency:

1. Download the exact version with
   `npm pack --pack-destination npm-package-cache <package>@<version>`.
2. Update its override in `package.json`.
3. Regenerate `SHA256SUMS`.
4. Run `pnpm install --lockfile-only`.
5. Verify a clean `pnpm install --frozen-lockfile`.
