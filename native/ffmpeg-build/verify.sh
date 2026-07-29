#!/bin/sh
set -eu

binary=${1:?Usage: verify.sh /path/to/ffmpeg}

require_output() {
  label=$1
  arguments=$2
  shift 2
  output=$("$binary" -hide_banner $arguments 2>&1)
  for requirement in "$@"; do
    if ! printf '%s\n' "$output" | grep -F "$requirement" >/dev/null; then
      echo "FFmpeg is missing required $label: $requirement" >&2
      exit 1
    fi
  done
}

"$binary" -version
require_output encoder -encoders libmp3lame png mjpeg libwebp libwebp_anim libaom-av1
require_output filter -filters scale trim tpad
require_output muxer -muxers avif webp mp3

case "$(uname -s)" in
  Linux)
    shared_dependencies=$(ldd "$binary" | awk '{ print $1 }' | grep -E 'lib(aom|mp3lame|webp|sharpyuv|ssl|crypto|z)\\.so' || true)
    if [ -n "$shared_dependencies" ]; then
      echo "FFmpeg unexpectedly uses shared codec/TLS dependencies:" >&2
      echo "$shared_dependencies" >&2
      exit 1
    fi
    ;;
  Darwin)
    shared_dependencies=$(otool -L "$binary" | grep -E 'lib(aom|mp3lame|webp|sharpyuv|ssl|crypto|z)\\.' || true)
    if [ -n "$shared_dependencies" ]; then
      echo "FFmpeg unexpectedly uses shared codec/TLS dependencies:" >&2
      echo "$shared_dependencies" >&2
      exit 1
    fi
    ;;
  MINGW*|MSYS*|CYGWIN*)
    non_system_dependencies=$(objdump -p "$binary" |
      awk '/DLL Name:/ { print $3 }' |
      grep -E -i '^(lib)?(aom|mp3lame|webp|sharpyuv|ssl|crypto|zlib|gcc|stdc\+\+|winpthread).*\.dll$' || true)
    if [ -n "$non_system_dependencies" ]; then
      echo "FFmpeg unexpectedly uses non-system DLL dependencies:" >&2
      echo "$non_system_dependencies" >&2
      exit 1
    fi
    ;;
esac

echo "FFmpeg capabilities and static dependency linkage verified."
