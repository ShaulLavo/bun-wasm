## Descriptor kinds and storage modes

Class **Host feature**. These are original adapters, not copied or translated upstream code.
The matching contract was written against Waffle main `f6017d12f59c81dae75eece5a6cb62c0470d166e`, specifically
`proc/abi.ts`, `core/descriptors.ts`, `fs/vfs.ts` and `browser/shared-fs.ts`. The root package,
web page and sandbox now pin Waffle `c2cc1d318af6791f6b2e3d207cc56df9d7bf542a` together, including their lockfiles.

The 2026-10-24 consumer refresh also updates original launcher fixtures for the required
`RuntimeProcessContext.identity`, delegates identity reservation and bounded payload methods
through the persistence test wrapper, and narrows directory entries before reading children.
The shell lists a non-directory entry without assuming it has children. These changes adapt
to Waffle's public types and entry kinds; they copy no upstream implementation. The real
installer tests arrange the blocked parent during mutation rather than before preflight,
because Waffle now reports an intermediate non-directory during lookup. They retain the
rollback race and expect the canonical WASI ENOTDIR value, 54.

`crates/bunwasm-runtime/src/host.rs` imports `runtime_proc.fd_kind`. The original descriptor
metadata adapter in `natives.rs` retains libc fstat and its rights checks before restoring the
missing FIFO type for kind 1 only. The native Wasmtime adapters in
`crates/bunwasm-host/src/process/{descriptors,mod,wasi}.rs` inspect the effective descriptor
namespace without reading a payload or moving a file cursor. Closed descriptors return BADF;
files, directories, terminals and runtime pipes remain distinct through duplication and remapping.

`web/src/main.ts` and `sandbox/src/main.ts` use the public `fast|safe|memory` mode contract.
Their outer startup handlers share `web/src/startup.ts` to expose typed failures even when
construction fails before a filesystem exists. Both pages retain the existing workspace
names and never switch stores on failure. The original editor-gate fixture in
`web/tests/fixtures/startup-filesystem.ts` selects Waffle's supported `whenBusy: "wait"`
policy for an explicit fast-mode control. It does not expose a product backend selector or
alter default takeover behavior; the real page and filesystem worker still own waiting,
recovery and persistence.
The old physical-store selector is removed from product pages. Conformance fixtures alone use
Waffle's internal implementation override to retain IndexedDB and OPFS backend tests. Runtime-child startup-refusal tests also follow Waffle's current host-only diagnostics contract,
leaving inherited stderr untouched while the parent consumes the typed START_FAILED result. No old
request shapes, version detection or compatibility fallback are added. See
[storage modes](../storage-modes.md) and [the process ABI](../host-abi.md#process-imports).


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [Descriptor kinds and storage modes](#descriptor-kinds-and-storage-modes) | Host feature | Original Rust descriptor-kind adapters and page startup handling adopt the pinned Waffle contract without guessing pipe types or changing workspace names. |

[Ledger scope and pinned revisions](scope.md).
