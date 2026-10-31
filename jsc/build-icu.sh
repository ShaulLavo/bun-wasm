#!/usr/bin/env bash
# ICU4C for wasm32-wasip1: a host build (for its data tools), then common + i18n cross-built with
# wasi-sdk, and the data filtered to root/en and linked as a static archive (icudt<N>_dat).
# Output: $JSC_BUILD_DIR/icu/prefix/{include/unicode,lib/libicu{uc,i18n,data}.a}
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
major="${ICU_VERSION%%.*}"
tgz="$ICU_DIR/icu4c-$ICU_VERSION-sources.tgz"
host="$ICU_DIR/host-src/source"
wasm="$ICU_DIR/wasm-src/source"
bun "$REPO/scripts/build-wasi-sysroot.ts"
mkdir -p "$ICU_DIR"
# A native archive is reusable only for the exact source, compiler and patched
# sysroot inputs. Never bless an older SDK build merely because its files exist.
stamp="$ICU_DIR/.bunwasm-inputs"
host_cc="${CC:-cc}"
host_cxx="${CXX:-c++}"
inputs="$({
  printf 'ICU_VERSION=%s\nICU_SHA256=%s\nSYSROOT=%s\nSDK=%s\n' "$ICU_VERSION" "$ICU_SHA256" "$BUN_WASM_SYSROOT" "$WASI_SDK_PATH"
  cat "$BUN_WASM_SYSROOT/bun-wasm-sysroot.json" "$WASI_SDK_PATH/VERSION"
  sha256sum "$JSC_SRC/build-icu.sh"
  for variable in CC CXX AR RANLIB LD CFLAGS CXXFLAGS CPPFLAGS LDFLAGS CPATH C_INCLUDE_PATH \
    CPLUS_INCLUDE_PATH LIBRARY_PATH LD_LIBRARY_PATH SDKROOT PKG_CONFIG_PATH; do
    printf '%s=%s\n' "$variable" "${!variable-}"
  done
  # Configure accepts compiler command strings, including wrappers and flags.
  # Use the same effective defaults for probing and the host configure invocation.
  for compiler in "$host_cc" "$host_cxx"; do
    printf 'host-compiler=%s\n' "$compiler"
    read -r -a command <<< "$compiler"
    command -v "${command[0]}" || exit 1
    "${command[@]}" --version || exit 1
  done
  "$WASI_SDK_PATH/bin/clang" --version || exit 1
  "$WASI_SDK_PATH/bin/clang++" --version || exit 1
} | sha256sum | cut -d' ' -f1)"
if [[ -f "$stamp" ]]; then
  if [[ "$(cat "$stamp")" != "$inputs" ]]; then
    echo "error: ICU inputs changed at $ICU_DIR; choose a fresh JSC_BUILD_DIR." >&2
    exit 1
  fi
elif [[ -e "$ICU_DIR/host-src" || -e "$ICU_DIR/wasm-src" || -e "$ICU_PREFIX" ]]; then
  echo "error: ICU cache at $ICU_DIR has no input receipt; choose a fresh JSC_BUILD_DIR." >&2
  exit 1
else
  printf '%s\n' "$inputs" > "$stamp"
fi

if [[ -f "$ICU_PREFIX/lib/libicudata.a" && -f "$ICU_PREFIX/lib/libicuuc.a" && -f "$ICU_PREFIX/lib/libicui18n.a" ]]; then
  echo "icu: $ICU_PREFIX already built"
  exit 0
fi

if [[ ! -f "$tgz" ]]; then
  curl -fsSL -o "$tgz" "https://github.com/unicode-org/icu/releases/download/release-$ICU_VERSION/icu4c-$ICU_VERSION-sources.tgz"
fi
echo "$ICU_SHA256  $tgz" | sha256sum -c --quiet

# 1. Host ICU: icupkg and genccode for the data step, and --with-cross-build for the wasm configure.
if [[ ! -x "$host/bin/icupkg" ]]; then
  rm -rf "$ICU_DIR/host-src" && mkdir -p "$ICU_DIR/host-src"
  tar -xf "$tgz" -C "$ICU_DIR/host-src" --strip-components=1
  (cd "$host" && $CAGE env CC="$host_cc" CXX="$host_cxx" bash -c "./configure --enable-static --disable-shared --disable-tests --disable-samples \
      --disable-extras --disable-layoutex --disable-icuio > ../../host-configure.log 2>&1 && make -j$JOBS > ../../host-make.log 2>&1")
fi

# 2. wasm ICU (common + i18n only; the data is built by hand below).
if [[ ! -f "$wasm/lib/libicui18n.a" ]]; then
  rm -rf "$ICU_DIR/wasm-src" && mkdir -p "$ICU_DIR/wasm-src"
  tar -xf "$tgz" -C "$ICU_DIR/wasm-src" --strip-components=1
  emu="-D_WASI_EMULATED_MMAN -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_GETPID"
  (cd "$wasm" && $CAGE env \
      CC="$WASI_SDK_PATH/bin/clang --target=wasm32-wasip1 --sysroot=$BUN_WASM_SYSROOT" CXX="$WASI_SDK_PATH/bin/clang++ --target=wasm32-wasip1 --sysroot=$BUN_WASM_SYSROOT" \
      AR="$WASI_SDK_PATH/bin/llvm-ar" RANLIB="$WASI_SDK_PATH/bin/llvm-ranlib" \
      CFLAGS="-O2 -fPIC $emu" CXXFLAGS="-O2 -fPIC -fno-exceptions $emu" \
      CPPFLAGS="-DU_HAVE_MMAP=0 -DU_ENABLE_DYLOAD=0 -DU_HAVE_TZSET=0 -DU_HAVE_TZNAME=0 -DU_HAVE_TIMEZONE=0" \
      ./configure --host=wasm32-unknown-wasi --with-cross-build="$host" --enable-static --disable-shared \
        --disable-tools --disable-tests --disable-samples --disable-extras --disable-layoutex --disable-icuio \
        --disable-dyload --with-data-packaging=static > ../../wasm-configure.log 2>&1)
  # ICU's configure knows no wasi platform makefile; Linux's works with genccode's assembly output off.
  cp "$wasm/config/mh-linux" "$wasm/config/mh-unknown"
  sed -i 's/^GENCCODE_ASSEMBLY=.*/GENCCODE_ASSEMBLY=/' "$wasm/config/mh-unknown"
  mkdir -p "$wasm/lib" "$wasm/bin"
  (cd "$wasm" && $CAGE bash -c "make -j$JOBS -C stubdata && make -j$JOBS -C common && make -j$JOBS -C i18n" > "$ICU_DIR/wasm-make.log" 2>&1)
fi

# 3. Data: drop every locale but root/en (and the converters, transliterators, names), keep the
# break-iterator dictionaries and the CLDR supplemental data. 33 MB -> 8 MB.
data="$ICU_DIR/data"
rm -rf "$data" && mkdir -p "$data/in" "$data/out"
export LD_LIBRARY_PATH="$host/lib"
cp "$host/data/in/icudt${major}l.dat" "$data/in/"
"$host/bin/icupkg" -l "$data/in/icudt${major}l.dat" > "$data/all.lst"
keep='^(([a-z]+)/)?(root|en|en_US|en_US_POSIX|en_001|res_index|pool|supplementalData|likelySubtags|metaZones|timezoneTypes|windowsZones|numberingSystems|keyTypeData|zoneinfo64|icustd|icuver|dayPeriods|genderList|grammaticalFeatures|metadata|pluralRanges|plurals|tzdbNames|units|unitPrefixes|currencyNumericCodes|langInfo)\.res$'
grep -vE "$keep" "$data/all.lst" | grep -E '\.res$|\.cnv$|^translit/|^unames\.icu$|\.spp$|\.cfu$|^cnvalias\.icu$' > "$data/remove.lst"
"$host/bin/icupkg" -r "$data/remove.lst" "$data/in/icudt${major}l.dat" "$data/out/icudt${major}l.dat"
(cd "$data/out" && "$host/bin/genccode" -e "icudt$major" "icudt${major}l.dat" >/dev/null)
$CAGE "$WASI_SDK_PATH/bin/clang" --target=wasm32-wasip1 --sysroot=$BUN_WASM_SYSROOT -fPIC -O1 -I"$wasm/common" -c "$data/out/icudt${major}l_dat.c" -o "$data/out/icudata.o"

mkdir -p "$ICU_PREFIX/lib" "$ICU_PREFIX/include/unicode"
cp "$wasm/lib/libicuuc.a" "$wasm/lib/libicui18n.a" "$ICU_PREFIX/lib/"
rm -f "$ICU_PREFIX/lib/libicudata.a"
"$WASI_SDK_PATH/bin/llvm-ar" rcs "$ICU_PREFIX/lib/libicudata.a" "$data/out/icudata.o"
cp "$wasm"/common/unicode/*.h "$wasm"/i18n/unicode/*.h "$ICU_PREFIX/include/unicode/"
echo "icu: $(stat -c %s "$data/out/icudt${major}l.dat") bytes of data, libs in $ICU_PREFIX/lib"
