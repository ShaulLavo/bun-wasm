## QuickJS shared-module split

The `bunwasm-engine-quickjs` crate started as a build and allocator gate.
The unmerged production-entry checkpoint now links it to the actual CLI/runtime
core. Its RUN body evaluates literal 42, not the application driver. It builds locked rquickjs 0.13.0 with std and the existing
patched QuickJS-ng 0.16.2 C sources. No upstream code was copied into this adapter.
The existing patches remain documented in [QuickJS](quickjs.md),
[data conversion](quickjs-data-conversion.md), and [stack guards](wasm-stack-guards.md).

The crate's original global allocator imports core's libc allocation functions.
QuickJS's default C allocator imports that same libc. Core alone links the patched
wasi-libc and owns heap growth. Transport allocation is a separate provenance-checked
API over that heap, not an interposed replacement for `malloc`.

Run from the workspace with the pinned nightly and existing patched sysroot:

```sh
export QUICKJS_BUILD_DIR=/work/tmp/bun-wasm-quickjs-gate
QUICKJS_SMOKE_EXPORTS=1 scripts/build-engine-quickjs.sh
tests/linker/quickjs/run.sh
```

The fixture requires the committed runtime data/ops modules from PR235 or a
descendant. It validates their presence and committed state, then reads them
through repository-relative module declarations with a stable compiler path
remap. It writes HEAD and all four source blob IDs to `source-revision.txt` in
the build directory. No external worktree override or generated absolute module
path is used. `tests/linker/quickjs/path-repro.sh` checks byte-identical fixture
archives from two checkout paths and verifies the actionable missing-source
failure.

The build uses `--locked --offline` and PIC `-Zbuild-std=std,panic_abort`.
Stock target std contains non-PIC relocations and does not pass this gate.
No custom compiler or libc rebuild is needed. Populate the pinned toolchain's
build-std dependencies beforehand if they are not already cached. Use the host's
shared build queue. This script never changes workspace manifests or lockfiles.
The workspace's normal vendor dependency metadata must already be available.

The dedicated fixture links real core libc and includes the reusable data/ops
modules by path. Its echo native proves frame transport, not production stdout.
The fixture imports `runtime_proc.signal(0, 4)` as a fatal-only checkpoint.
The raw smoke supplies a counting test host. This does not prove every native
operation cooperates or grant production admission.

The initializer converter changes only the export and start sections. It exports
the original start function, renames data-relocation and constructor exports, and
re-exports the imported stack global for identity checks. It asserts all other
section bytes unchanged. The required explicit order is
`quickjs_initialize_memory`, `quickjs_apply_data_relocs`, `quickjs_call_ctors`.
Memory initialization must precede data relocation. The caller runs this list
once, after core constructors. Do not also invoke the old implicit start path.

The smoke tests a real VM, patched helpers, pending jobs, interrupts, shared-stack
nesting, owned ops echo, cross-boundary allocation, real core growth, and the
512 MiB ceiling. The result and exact module hashes are written to the selected
build directory. That directory belongs to the caller and can be removed once
artifact consumers have stopped. No browser loader or product engine trait moves.

## Production-entry checkpoint

Original adapters in `crates/bunwasm-runtime/src/split.rs` and
`crates/bunwasm-engine-quickjs/src/client.rs` connect the existing plain-data
Dispatcher/Transport to one registered RUN function. No VM value crosses that
boundary. The core dependency graph excludes rquickjs. The side imports core
libc for Rust and QuickJS allocations, plus the shared memory, table and stack.

`crates/bunwasm-cli/entry-split.c` is an original command-entry shim, not copied
CRT source. Waffle initializes core constructors before side memory,
relocations, constructors and registration. `_start` calls the real CLI without
repeating constructors. Volatile counters check the schedule. The original
8 MiB stack and 512 MiB memory maximum remain unchanged.

Build fresh matching bytes with `BUN_CORE_BUILD_DIR` pointing to a private
output directory, then run the ordinary-worker CLI fixture:

```sh
scripts/build-bun-core.sh
bun test tests/linker/quickjs/cli.test.ts
```

The fixture uses accepted Waffle revision
`1fa934ed99f95a744af2448fc6fb14bb984c37d4`. It requires exact `42\n` stdout,
empty stderr, exit 0 and one cleanup. Initialization is requested twice to test
idempotence. This does not accept application imports, promise jobs, timers or
the final split. Replace the literal RUN before merging.

## Classification

| Source | Class | Change |
| --- | --- | --- |
| `crates/bunwasm-engine-quickjs/**` | Port | Original rquickjs gate and core-backed Rust allocator. Manual FFI declarations name the existing six local QuickJS helpers; no upstream implementation copied. |
| `crates/bunwasm-runtime/src/split.rs`, `crates/bunwasm-cli/entry-split.c` | Port | Original process-state, registration, transport and command-entry adapters. No upstream implementation copied. |
| `scripts/build-bun-core.sh`, `scripts/quickjs-core-exports.txt` | Port | Original VM-free production-core producer and explicit libc/GOT export list. |
| `scripts/build-engine-quickjs.sh` | Port | Original PIC Rust/C shared-library build with no engine libc or heap-growth owner. |
| `tests/linker/quickjs/**` | Port | Original raw linked-VM fixtures, section-preserving initializer conversion, and real core-libc checks. Data/ops source stays owned by its existing modules and is included by path. |

[Ledger scope and pinned revisions](scope.md).
