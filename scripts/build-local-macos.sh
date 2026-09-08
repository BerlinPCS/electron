#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ $(uname -s) != Darwin ]]; then
  echo 'Local Mac packaging requires macOS.' >&2
  exit 1
fi
# Reuse the installed AnkiLock certificate unless the owner specifies an identity.
identity=${HAYATAN_MAC_SIGNING_IDENTITY:-${ANKILOCK_MAC_SIGNING_IDENTITY:-}}
if [[ -z "$identity" ]]; then
  ankilock_app=${ANKILOCK_APP_PATH:-$HOME/Applications/AnkiLock.app}
  identity=$(/usr/bin/codesign -dvv "$ankilock_app" 2>&1 | /usr/bin/sed -n 's/^Authority=//p' | /usr/bin/head -n 1)
fi
if [[ -z "$identity" || "$identity" == - ]]; then
  echo 'Set HAYATAN_MAC_SIGNING_IDENTITY to the stable certificate used by AnkiLock.' >&2
  exit 1
fi
export HAYATAN_MAC_SIGNING_IDENTITY="$identity"
export MAIN_VITE_INTERFACE_URL=${MAIN_VITE_INTERFACE_URL:-https://hayatan.berlinpcs.workers.dev/}
npm run build
CSC_IDENTITY_AUTO_DISCOVERY=false node_modules/.bin/electron-builder --mac --arm64 --dir -c.mac.identity=- -c.mac.notarize=false
bash scripts/sign-local-macos.sh dist/mac-arm64/Hayatan.app
