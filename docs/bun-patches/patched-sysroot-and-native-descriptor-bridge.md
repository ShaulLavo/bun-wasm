## Patched sysroot and native descriptor bridge

Class **Port**, with an original local build wrapper and native runtime adapter. The libc input is
not copied into this repository. The original `scripts/waffle-release-inputs.ts` adapter binds
runtime archive `waffle-v0.0.91` to reviewed source `62d08fcb8091bc4d31220f8250b943ea858d6e15`.
The checked `scripts/waffle-release-inputs.json` records its HTTPS archive URL, SHA-256/size,
source commit, `packages/waffle` directory and the hashes of its package metadata, libc builder
and patch. The adapter verifies the archive and installed builder, then caches those three
native source files from that exact commit. It always uses this released-source directory;
there is no installed-file fallback or old Git-pin branch. The runtime archive remains untouched.
The build wrapper and guest source manifest use the same cached native directory, preserving
source provenance and the actual builder/patch hashes even though the runtime archive omits
its private libc patch. Update the release binding with the dependency pin. The builder pins
wasi-libc revision `2e6fb9d8ee0cdf9e431fbcabe8af3115de000a13`. Its `preopen-scan.patch` skips occupied inherited descriptors
only when `fd_fdstat_get` succeeds and stops on the first real BADF. `scripts/build-wasi-sysroot.ts`
keys reuse on the actual builder and patch content, SDK VERSION, compiler/archive-tool binaries and
versions, host build tools, effective compiler environment and SDK overlay targets, with an integrity
hash of the built libc. Waffle package revisions remain provenance rather than cache inputs: an
unrelated process-only revision reuses the identical receipt, as the package regression proves. A
nonmatching receipt is rejected outright, without upgrades or compatibility handling. The wrapper exposes
the same input object through `wasiSysrootInputs` and `--inputs` so Actions can
select a compatible cache before restoring it. Restore prefixes preserve that
input digest, image and architecture. The builder then validates the full receipt,
libc bytes and overlay targets before the cache is saved, ahead of other native
builds. Lockfile or scratch-policy edits alone do not alter this identity. The wrapper
claims an atomic output lock, stages next to the destination for same-filesystem atomic publication,
and refuses stale or caller-owned outputs. Reuse verifies the SDK overlay targets against the selected SDK, even
when two SDK directories have identical VERSION files. It symlinks only
unchanged SDK C++ headers and noeh libraries; CRT, libc and emulation archives come from the
patched sysroot. Every guest and native C/C++ consumer receives that sysroot explicitly, while
Rust self-contained libc remains disabled. The JSC/ICU side uses the same receipt boundary:
`jsc/build-icu.sh` fingerprints the ICU source, wasi-sdk VERSION, patched sysroot receipt, compiler
versions, effective host compiler commands and paths, compiler/include/linker environment, and build
script before accepting an existing cache; a failed compiler probe or missing or mismatched receipt on a
nonempty cache is an error rather than a silent reuse of older libc inputs. `jsc/common.sh` extends
the JSC prebuild fingerprint with that receipt and the effective toolchain, and `scripts/build-bun-jsc.sh`
requires the matching stamp before linking a guest. Each guest build also checks that the clean
imported Bun tree matches the checked-in patch series before compilation. Its final optimized Wasm
gets the shared [guest build receipt](../guest-build-receipts.md), recording the vendor commit/tree,
patched-sysroot receipt hash and exact artifact hash/size. The build refuses a source or input-receipt
change before writing that sidecar; browser acceptance and publication can consume the same format.

`crates/bunwasm-runtime/src/natives.rs` is original bun-wasm code, not a copied wasi-libc or Node
implementation. Its open-file table stores real descriptors, allowing inherited fd3/fd4 resources
to use the same read/write/fstat/ftruncate namespace and preserving shared open-file cursors. Empty
reads and writes validate descriptors, negative closes return EBADF, interrupted writes retry, and later failures return committed partial
progress. Direct writes flush both output streams first because inherited descriptors can alias
stdout or stderr. Native inherited fstat preserves the libc mode, including pipes and devices.
On WASI, preview1 has no FIFO tag. After the ordinary fstat capability check, the original
adapter consults `runtime_proc.fd_kind` and restores FIFO bits only for an explicit pipe kind.
UNKNOWN remains unknown rather than becoming a pipe. Device, socket and filesystem modes
and metadata capability errors remain intact. Waffle grants FD_FILESTAT_GET to both pipe endpoints; inherited
descriptors keep those exact rights, so the real pipe-fstat controls succeed without bypassing
metadata capability checks. No upstream implementation or new binding dependency is copied.
The original `src/js/node_fs.js` Stats predicates test those type bits rather than hard-coding false.
Its public readSync and callback read validate buffer/offset/length arguments, then return zero before
invoking the native for a zero-byte request, as native Node and Bun do even on a closed descriptor.
A zero-byte request allows an offset beyond the buffer, and follows Bun in ignoring its position.
Direct native empty reads still validate the descriptor.
FileHandle.read checks the handle's closed state first, so closing a handle cannot be hidden by that
public short-circuit. A parity table distinguishes these reads from empty writes, which still fail
with EBADF. These are original adapters, not copied Node or Bun implementations.
The browser process controls create a real filesystem file and inherited pipe, verify shared open-file
cursors and pipe/device metadata, reject empty writes to closed descriptors, and preserve buffered
output ordering across direct fd aliases in Chromium, Firefox and WebKit. The package installer uses exclusive marker creation and rolls back only paths
it created. A borrowed public FilesystemClient observes each mutation's own completion, including
exclusive-create EEXIST, and is disposed after success or failure. The page-side resolvePath ordering
primitive makes earlier undrained writes visible without consuming the caller-owned sticky failure.
A matching concurrent marker is shared; unrelated page failures remain available to the caller's
explicit drain in either request ordering. The formerly expected-failing libc controls are now
strict successes in that earlier descriptor-bridge validation: all 18 scenarios passed
without retries in each of Chromium, Firefox and WebKit for browser, QuickJS and JSC artifacts.
This supersedes the historical expected-failure notes for earlier pins below and above.

The earlier descriptor-bridge validation captured host intrinsics and shared-view identities. Its measured
core closure is 24,744 B minified / 8,073 B gzip; the core gate is now a tight 8,192 B gzip.
The captured-intrinsics module is classified with eager reservation/control primitives, not the
lazy process supervisor. Test-only wait, notify and outcome instrumentation uses module injection
or a pre-import fixture observer; no production mutable hook or export was added.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [Patched sysroot, native descriptor bridge and JSC receipts](#patched-sysroot-and-native-descriptor-bridge) | Port | Consume Waffle's wasi-libc preopen-scan patch through its installed builder, keep inherited WASI descriptors in the runtime's real fd namespace with shared offsets, and reject stale ICU/JSC inputs through exact receipts. |

[Ledger scope and pinned revisions](scope.md).
