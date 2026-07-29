# Minimal FFmpeg sidecar

This builds the FFmpeg executable used by Hayatan from checksum-pinned official
source archives. LAME, libwebp, libaom, OpenSSL, and zlib are compiled as static
libraries in a private prefix. They are linked into FFmpeg without making the
Linux executable fully static, so normal system C libraries remain portable.

No dependency submodules are needed because Hayatan does not patch these
projects. Versions, URLs, and SHA-256 checksums live in `sources.env`.

## Build

Install a C/C++ toolchain, CMake, Make or Ninja, Perl, pkg-config, curl, tar,
xz, and preferably NASM. On Windows, install these in an MSYS2 UCRT64
environment; the npm launcher finds a standard `C:\msys64` installation, or
the installation selected by `MSYS2_ROOT`. Then run:

```sh
npm run build:ffmpeg:source
```

The result is written to `dist/<platform>-<architecture>/`. Downloads and
intermediate builds are cached under
`node_modules/.cache/hayatan-ffmpeg-source`. Override these locations with
`HAYATAN_FFMPEG_WORK_DIR` and `HAYATAN_FFMPEG_OUTPUT_DIR`.

`verify.sh` checks the required encoders, muxers, and filters. On Linux and
macOS it also rejects shared codec, compression, and TLS dependencies.

## Packaging

`scripts/prepare-ffmpeg.mjs` automatically prefers the matching locally built
artifact. Set `HAYATAN_FFMPEG_PATH` to select another verified build. If neither
exists, the script keeps using the checksum-pinned prebuilt fallback so release
platforms are not broken before their source builds have been validated.

## Updating

Update one release at a time in `sources.env`, calculate its SHA-256 from the
downloaded archive, clear that component's cached source/build directories, and
run a clean build plus `verify.sh`. Keep the upstream source URL available to
satisfy the corresponding open-source license obligations.
