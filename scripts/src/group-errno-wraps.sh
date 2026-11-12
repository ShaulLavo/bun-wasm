# Sourced by the shared-group engine producers (build-engine-quickjs.sh, build-engine-jsc.sh).
# Every errno-setting core function a side's Rust std imports must be wrapped (group-errno.c),
# or std would read this side's errno after a core call that set only the core's.
check_group_errno_wraps() {
  local archive=$1 out=$2
  shift 2
  local inert=" abort free malloc realloc posix_memalign strlen getenv strerror_r errno _CLOCK_MONOTONIC __stack_pointer $* "
  local std_members std_undefined std_imports unwrapped
  std_members=$("$WASI_SDK_PATH/bin/llvm-ar" t "$archive" | grep -F '.std-' || true)
  [[ -n "$std_members" ]] || { echo "error: no std objects found in $archive" >&2; exit 1; }
  rm -rf "$out/std-members" && mkdir "$out/std-members"
  (cd "$out/std-members" && "$WASI_SDK_PATH/bin/llvm-ar" x "$archive" $std_members)
  std_undefined=$("$WASI_SDK_PATH/bin/llvm-nm" -u "$out"/std-members/* | awk 'NF {print $NF}' | sort -u)
  rm -rf "$out/std-members"
  std_imports=$(comm -12 <(printf '%s\n' "$std_undefined") <(sort -u "$root/scripts/quickjs-core-exports.txt"))
  [[ -n "$std_imports" ]] || { echo "error: no core imports found in the side's std objects" >&2; exit 1; }
  unwrapped=$(while read -r name; do [[ "$inert" == *" $name "* ]] || echo "$name"; done <<< "$std_imports")
  [[ -z "$unwrapped" ]] || { echo "error: side std imports errno-setting core functions without an errno wrap: $unwrapped" >&2; exit 1; }
}
