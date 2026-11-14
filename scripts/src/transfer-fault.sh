# Sourced by the side producers (build-engine-quickjs.sh, build-engine-jsc.sh,
# build-engine-spidermonkey-shared.sh). Decides whether this run makes a validation side: one
# that refuses every allocation from a transfer's first detach on
# (crates/bunwasm-engine-quickjs/src/transfer_fault.rs). Such a side is never a release. Its
# producer writes no receipt for it, so no program can be staged from it.
#
# select_transfer_fault OPTION reads the producer's own option, named OPTION: unset or 0 is a
# release, 1 a validation side, anything else is refused, an empty value included. It sets
#   transfer_fault        0 or 1
#   transfer_fault_wraps  the linker arguments that route the side's allocators to the module
# and, for a validation side, exports BUN_WASM_TRANSFER_FAULT=1 for the build scripts.
#
# The compiler reads only BUN_WASM_TRANSFER_FAULT, and only a producer may set it. One that
# arrives from outside, whatever its value, would decide what is compiled without deciding
# the wraps and the receipt here, so the producer refuses to run.
select_transfer_fault() {
  local option=$1 value=0 name
  transfer_fault=0
  transfer_fault_wraps=()
  if [[ -n "${BUN_WASM_TRANSFER_FAULT+set}" ]]; then
    echo "error: unset BUN_WASM_TRANSFER_FAULT; this producer sets it itself for $option=1" >&2
    exit 2
  fi
  if [[ -n "${!option+set}" ]]; then value=${!option}; fi
  case "$value" in
    0) ;;
    1)
      transfer_fault=1
      export BUN_WASM_TRANSFER_FAULT=1
      for name in malloc calloc realloc posix_memalign aligned_alloc mmap bun_core_alloc bun_shared_buffer_alloc; do
        transfer_fault_wraps+=("--wrap=$name")
      done
      ;;
    *) echo "error: $option must be 0, 1 or unset" >&2; exit 2 ;;
  esac
}
