#!/bin/bash
set -euo pipefail
if [[ $(uname -s) != Darwin ]]; then
  echo 'Local Mac signing requires macOS.' >&2
  exit 1
fi
app_path=${1:?Usage: HAYATAN_MAC_SIGNING_IDENTITY=... scripts/sign-local-macos.sh path/to/Hayatan.app}
identity=${HAYATAN_MAC_SIGNING_IDENTITY:-${ANKILOCK_MAC_SIGNING_IDENTITY:-}}
if [[ -z "$identity" || "$identity" == - ]]; then
  echo 'Set HAYATAN_MAC_SIGNING_IDENTITY to the same stable local identity used by AnkiLock.' >&2
  exit 1
fi
if [[ ! -d "$app_path/Contents" ]]; then
  echo 'Expected a packaged .app directory.' >&2
  exit 1
fi
# Keep each Electron/helper executable's existing runtime and JIT entitlements.
/usr/bin/codesign --force --deep --sign "$identity" --timestamp=none \
  --preserve-metadata=identifier,entitlements,flags,runtime "$app_path"
/usr/bin/codesign --verify --deep --strict "$app_path"
requirement=$(/usr/bin/codesign -d -r- "$app_path" 2>&1)
if [[ "$requirement" == *'cdhash H'* || "$requirement" != *'certificate'* ]]; then
  echo 'The resulting identity is not stable across local builds.' >&2
  exit 1
fi
printf '%s\n' 'Stable local Mac signature verified.'
