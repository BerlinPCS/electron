#!/bin/sh
set -eu

# This file and sources.env must use LF line endings; see the repository's
# .gitattributes. CRLF characters become part of shell variable values.

script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_directory=$(CDPATH= cd -- "$script_directory/../.." && pwd)

# shellcheck source=sources.env
. "$script_directory/sources.env"

work_directory=${HAYATAN_FFMPEG_WORK_DIR:-"$project_directory/node_modules/.cache/hayatan-ffmpeg-source"}
download_directory="$work_directory/downloads"
source_directory="$work_directory/sources"
build_directory="$work_directory/build"
prefix_directory="$work_directory/prefix"

case "$(uname -s)" in
  Darwin) platform=darwin ;;
  Linux) platform=linux ;;
  MINGW*|MSYS*|CYGWIN*) platform=win32 ;;
  *) echo "Unsupported build host: $(uname -s)" >&2; exit 1 ;;
esac

machine=$(uname -m)
case "$machine" in
  x86_64|amd64) architecture=x64 ;;
  arm64|aarch64) architecture=arm64 ;;
  *) echo "Unsupported build architecture: $machine" >&2; exit 1 ;;
esac

output_directory=${HAYATAN_FFMPEG_OUTPUT_DIR:-"$script_directory/dist/$platform-$architecture"}
executable_suffix=
[ "$platform" = win32 ] && executable_suffix=.exe

jobs=${HAYATAN_BUILD_JOBS:-}
if [ -z "$jobs" ]; then
  jobs=$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 2)
fi

for command in cmake curl make perl pkg-config tar; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Missing required build tool: $command" >&2
    exit 1
  fi
done

if command -v sha256sum >/dev/null 2>&1; then
  verify_checksum() {
    expected=$1
    file=$2
    printf '%s  %s\n' "$expected" "$file" | sha256sum -c -
  }
elif command -v shasum >/dev/null 2>&1; then
  verify_checksum() {
    expected=$1
    file=$2
    actual=$(shasum -a 256 "$file" | awk '{ print $1 }')
    [ "$actual" = "$expected" ]
  }
else
  echo "Missing required checksum tool: sha256sum or shasum" >&2
  exit 1
fi

ensure_directory() {
  [ -d "$1" ] || mkdir -p "$1"
}

for directory in \
  "$download_directory" \
  "$source_directory" \
  "$build_directory" \
  "$prefix_directory" \
  "$output_directory"
do
  ensure_directory "$directory"
done

# Some developer environments route the compiler through ccache. Keep its
# transient files in the build workspace, which also works in restricted CI.
export CCACHE_DIR=${CCACHE_DIR:-"$work_directory/ccache"}
ensure_directory "$CCACHE_DIR"

# FFmpeg's configure script needs an executable temporary directory. MSYS2's
# global /tmp can be unavailable in restricted Windows environments.
if [ "$platform" = win32 ] || [ -z "${TMPDIR:-}" ] || [ ! -w "$TMPDIR" ]; then
  TMPDIR="$work_directory/tmp"
fi
ensure_directory "$TMPDIR"
TMP=$TMPDIR
TEMP=$TMPDIR
export TMPDIR TMP TEMP

fetch() {
  name=$1
  url=$2
  checksum=$3
  destination="$download_directory/$name"

  if [ -f "$destination" ] && verify_checksum "$checksum" "$destination" >/dev/null 2>&1; then
    return
  fi

  temporary="$destination.tmp"
  rm -f "$temporary"
  curl --fail --location --retry 3 --output "$temporary" "$url"
  verify_checksum "$checksum" "$temporary"
  mv "$temporary" "$destination"
}

extract() {
  archive=$1
  destination=$2
  strip_components=${3:-1}
  stamp="$destination/.hayatan-extracted"

  if [ -f "$stamp" ]; then
    return
  fi

  rm -rf "$destination"
  mkdir -p "$destination"
  tar -xf "$archive" -C "$destination" --strip-components="$strip_components"
  touch "$stamp"
}

fetch "ffmpeg-$FFMPEG_VERSION.tar.xz" "$FFMPEG_URL" "$FFMPEG_SHA256"
fetch "lame-$LAME_VERSION.tar.gz" "$LAME_URL" "$LAME_SHA256"
fetch "libwebp-$LIBWEBP_VERSION.tar.gz" "$LIBWEBP_URL" "$LIBWEBP_SHA256"
fetch "aom-$AOM_VERSION.tar.gz" "$AOM_URL" "$AOM_SHA256"
fetch "openssl-$OPENSSL_VERSION.tar.gz" "$OPENSSL_URL" "$OPENSSL_SHA256"
fetch "zlib-$ZLIB_VERSION.tar.gz" "$ZLIB_URL" "$ZLIB_SHA256"

extract "$download_directory/ffmpeg-$FFMPEG_VERSION.tar.xz" "$source_directory/ffmpeg"
extract "$download_directory/lame-$LAME_VERSION.tar.gz" "$source_directory/lame"
extract "$download_directory/libwebp-$LIBWEBP_VERSION.tar.gz" "$source_directory/libwebp"
extract "$download_directory/aom-$AOM_VERSION.tar.gz" "$source_directory/aom"
extract "$download_directory/openssl-$OPENSSL_VERSION.tar.gz" "$source_directory/openssl"
extract "$download_directory/zlib-$ZLIB_VERSION.tar.gz" "$source_directory/zlib"

cmake_generator='Unix Makefiles'
if command -v ninja >/dev/null 2>&1; then
  cmake_generator=Ninja
fi

build_cmake() {
  name=$1
  shift
  cmake -S "$source_directory/$name" -B "$build_directory/$name" \
    -G "$cmake_generator" \
    -DCMAKE_BUILD_TYPE=MinSizeRel \
    -DCMAKE_INSTALL_PREFIX="$prefix_directory" \
    -DCMAKE_INSTALL_LIBDIR=lib \
    -DCMAKE_POSITION_INDEPENDENT_CODE=ON \
    -DBUILD_SHARED_LIBS=OFF \
    "$@"
  cmake --build "$build_directory/$name" --parallel "$jobs"
  cmake --install "$build_directory/$name"
}

if [ ! -f "$prefix_directory/.zlib-$ZLIB_VERSION" ]; then
  build_cmake zlib \
    -DZLIB_BUILD_SHARED=OFF \
    -DZLIB_BUILD_STATIC=ON
  touch "$prefix_directory/.zlib-$ZLIB_VERSION"
fi

# zlib's CMake build calls the static MinGW archive libzs.a, but its installed
# pkg-config file still advertises -lz. Provide the conventional static name so
# FFmpeg does not fall through to MSYS2's zlib1.dll import library.
if [ "$platform" = win32 ] && [ -f "$prefix_directory/lib/libzs.a" ]; then
  cp "$prefix_directory/lib/libzs.a" "$prefix_directory/lib/libz.a"
fi

if [ ! -f "$prefix_directory/.lame-$LAME_VERSION" ]; then
  (
    cd "$source_directory/lame"
    ./configure \
      --prefix="$prefix_directory" \
      --disable-shared \
      --enable-static \
      --disable-frontend \
      CFLAGS="-Os -ffunction-sections -fdata-sections"
    make -j"$jobs"
    make install
  )
  touch "$prefix_directory/.lame-$LAME_VERSION"
fi

if [ ! -f "$prefix_directory/.libwebp-$LIBWEBP_VERSION" ]; then
  build_cmake libwebp \
    -DWEBP_BUILD_ANIM_UTILS=OFF \
    -DWEBP_BUILD_CWEBP=OFF \
    -DWEBP_BUILD_DWEBP=OFF \
    -DWEBP_BUILD_EXTRAS=OFF \
    -DWEBP_BUILD_GIF2WEBP=OFF \
    -DWEBP_BUILD_IMG2WEBP=OFF \
    -DWEBP_BUILD_LIBWEBPMUX=ON \
    -DWEBP_BUILD_VWEBP=OFF \
    -DWEBP_BUILD_WEBPINFO=OFF \
    -DWEBP_BUILD_WEBPMUX=OFF
  touch "$prefix_directory/.libwebp-$LIBWEBP_VERSION"
fi

aom_nasm=0
aom_target_cpu=
if command -v nasm >/dev/null 2>&1; then
  aom_nasm=1
elif [ "$architecture" = x64 ]; then
  aom_target_cpu=-DAOM_TARGET_CPU=generic
  echo "NASM was not found; the build will work, but media encoding will be slower." >&2
fi

if [ ! -f "$prefix_directory/.aom-$AOM_VERSION" ]; then
  build_cmake aom \
    -DCONFIG_AV1_DECODER=0 \
    -DCONFIG_AV1_ENCODER=1 \
    -DCONFIG_LIBYUV=0 \
    -DCONFIG_WEBM_IO=0 \
    -DENABLE_DOCS=0 \
    -DENABLE_EXAMPLES=0 \
    -DENABLE_NASM="$aom_nasm" \
    -DENABLE_TESTS=0 \
    -DENABLE_TOOLS=0 \
    $aom_target_cpu
  touch "$prefix_directory/.aom-$AOM_VERSION"
fi

case "$platform-$architecture" in
  linux-x64) openssl_target=linux-x86_64 ;;
  linux-arm64) openssl_target=linux-aarch64 ;;
  darwin-x64) openssl_target=darwin64-x86_64-cc ;;
  darwin-arm64) openssl_target=darwin64-arm64-cc ;;
  win32-x64) openssl_target=mingw64 ;;
  *) echo "No OpenSSL target for $platform-$architecture" >&2; exit 1 ;;
esac

if [ ! -f "$prefix_directory/.openssl-$OPENSSL_VERSION" ]; then
  (
    cd "$source_directory/openssl"
    ./Configure "$openssl_target" \
      --prefix="$prefix_directory" \
      --libdir=lib \
      no-apps no-docs no-dso no-shared no-tests
    make -j"$jobs"
    make install_sw
  )
  touch "$prefix_directory/.openssl-$OPENSSL_VERSION"
fi

export PKG_CONFIG_PATH=
export PKG_CONFIG_LIBDIR="$prefix_directory/lib/pkgconfig:$prefix_directory/share/pkgconfig"
export CFLAGS="-I$prefix_directory/include -Os -ffunction-sections -fdata-sections"
export LDFLAGS="-L$prefix_directory/lib"

case "$platform" in
  darwin) size_ldflags='-Wl,-dead_strip' ;;
  win32) size_ldflags='-Wl,--gc-sections -static' ;;
  *) size_ldflags='-Wl,--gc-sections' ;;
esac

x86asm_flag=
if [ "$architecture" = x64 ] && ! command -v nasm >/dev/null 2>&1 && ! command -v yasm >/dev/null 2>&1; then
  x86asm_flag=--disable-x86asm
fi

ensure_directory "$build_directory/ffmpeg"
(
  cd "$build_directory/ffmpeg"
  "$source_directory/ffmpeg/configure" \
    --prefix="$prefix_directory" \
    --pkg-config-flags=--static \
    --disable-autodetect \
    --disable-debug \
    --disable-doc \
    --disable-ffplay \
    --disable-ffprobe \
    --disable-devices \
    --disable-hwaccels \
    --disable-encoders \
    --enable-encoder=libmp3lame,png,mjpeg,libwebp,libwebp_anim,libaom_av1 \
    --disable-decoder=libaom_av1 \
    --disable-muxers \
    --enable-muxer=mp3,image2,webp,avif \
    --disable-filters \
    --enable-filter=abuffer,abuffersink,aresample,asetpts,atrim,buffer,buffersink,fps,scale,setpts,tpad,trim \
    --disable-protocols \
    --enable-protocol=file,http,https,tcp,tls \
    --enable-libmp3lame \
    --enable-libwebp \
    --enable-libaom \
    --enable-openssl \
    --enable-zlib \
    --enable-small \
    --extra-cflags="$CFLAGS" \
    --extra-ldflags="$LDFLAGS $size_ldflags" \
    $x86asm_flag
  # MinGW names this target ffmpeg.exe rather than ffmpeg.
  make -j"$jobs" "ffmpeg$executable_suffix"
)

cp "$build_directory/ffmpeg/ffmpeg$executable_suffix" "$output_directory/ffmpeg$executable_suffix"
if command -v strip >/dev/null 2>&1; then
  strip "$output_directory/ffmpeg$executable_suffix" 2>/dev/null || true
fi
chmod +x "$output_directory/ffmpeg$executable_suffix"
cp "$source_directory/ffmpeg/COPYING.LGPLv2.1" "$output_directory/FFMPEG-LICENSE.txt"

{
  for license in \
    "$source_directory/lame/COPYING" \
    "$source_directory/libwebp/COPYING" \
    "$source_directory/aom/LICENSE" \
    "$source_directory/openssl/LICENSE.txt" \
    "$source_directory/zlib/LICENSE"
  do
    echo
    echo "============================================================================="
    echo "$(basename "$(dirname "$license")") — $(basename "$license")"
    echo "============================================================================="
    echo
    cat "$license"
  done
} > "$output_directory/FFMPEG-THIRD-PARTY-LICENSES.txt"

{
  echo "Hayatan minimal FFmpeg source build"
  echo "Target: $platform-$architecture"
  echo
  echo "FFmpeg $FFMPEG_VERSION: $FFMPEG_URL"
  echo "SHA-256: $FFMPEG_SHA256"
  echo "LAME $LAME_VERSION: $LAME_URL"
  echo "SHA-256: $LAME_SHA256"
  echo "libwebp $LIBWEBP_VERSION: $LIBWEBP_URL"
  echo "SHA-256: $LIBWEBP_SHA256"
  echo "libaom $AOM_VERSION: $AOM_URL"
  echo "SHA-256: $AOM_SHA256"
  echo "OpenSSL $OPENSSL_VERSION: $OPENSSL_URL"
  echo "SHA-256: $OPENSSL_SHA256"
  echo "zlib $ZLIB_VERSION: $ZLIB_URL"
  echo "SHA-256: $ZLIB_SHA256"
  echo
  echo "Rebuild instructions: native/ffmpeg-build/README.md"
} > "$output_directory/FFMPEG-SOURCES.txt"

"$script_directory/verify.sh" "$output_directory/ffmpeg$executable_suffix"
echo "Built $output_directory/ffmpeg$executable_suffix"
