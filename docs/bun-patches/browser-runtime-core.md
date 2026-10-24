## Browser runtime core

Class **Host feature**, **original adapters** in `waffle/core/`, `web/src/fs.ts`, `waffle/fs/`, and `waffle/proc/{pipes,worker-pipes}.ts`.
Waffle's `core/` and `fs/` sources provide the WASI, descriptor, shared-filesystem and memory
backend adapters consumed by `web/`; there is no copied Bun, Node, WebKit, brush-web or
browser_wasi_shim implementation in this layer. The preview1 adapter uses opaque filesystem
handles keyed by object identity (not serialized inode metadata), reference-counted descriptions
and descriptor readiness. The filesystem worker and shared-memory protocol are original
TypeScript adapters with no copied upstream implementation. The OPFS spike informed the
scheduling choice, not the implementation. One worker allocates inodes, owns open identities
and services all guests. Ancestor revocation cancels requests and releases each guest's references; bounded
read/stat caches use a shared mutation epoch. Atomic append selects EOF and writes the whole
request under shared mutation and file locks; conditional creation carries the caller's exclusivity intent. Transient
result handles are pinned together before eviction, and rejected cache reads do not touch guest
buffers. Shared ancestor wakeups also cancel blocked and asynchronous guests if the filesystem
worker fails. The sandbox's original network adapters send notification-only file-change events
after a shared-FS save, rather than replaying its old bytes. Copy-at-spawn and merge-at-exit are removed.
The original `waffle/fs/shared.ts` adapter adds shared file metadata, per-inode locks and
service-owned 64 KiB page tables across 16 MiB SAB segments. Original connection adapters
publish zero-byte growable segment references before execution, so service-owned backing
growth is visible even to a synchronous guest that cannot drain port messages. Retained file reads and in-capacity
writes and appends stay in the guest; namespace edits and geometric capacity growth stay
at the backend boundary. A guest read holds the file lock once and copies straight into guest
buffers; writes and appends also hold the global mutation lock. Each checks revocation once
while holding its locks and reads or writes slot fields only under the lock that guards them.
Negative `fd_pread`/`fd_pwrite` offsets return EINVAL. Original per-connection capability tables let cached opens and closes
change atomic local references while the service retains sole ownership of backend pins. The default configurable storage cap is 1 GiB; pool exhaustion uses
WASI ENOSPC and the per-file page-table limit uses EFBIG. Owner-tagged locks let revocation
reclaim abandoned guest locks without changing allocator state. This is original bun-wasm code,
not an adapted upstream allocator or filesystem. Path walking remains a local MemFS detail. Bun's
reserved socket slot bridge stays configured by `web/`, not imported into the generic core.
The persistence layer in `waffle/fs/{storage,indexeddb,persistent}.ts` is also an original adapter,
not copied or translated from PGlite, SQLite, Emscripten, or another upstream. The storage spike
informed its batched scheduling and crash-safety requirements. It adds immutable payloads,
checksummed incremental metadata, dual base snapshots, strict atomic IndexedDB commits, lifetime
Web Locks and lazy data hydration. Shared revision counters capture direct guest writes; clean
persisted data can leave the pool without changing inode identity. The editor adapters wait for
a durable checkpoint before marking a save complete, seed workspaces once, and explicitly reset
sandbox templates. `waffle/core/wasi.ts` routes both preview1 sync calls through this boundary.
The original worker/controller adapters in `waffle/fs/service.ts` and `web/src/shared-fs.ts`
now send startup failures as plain message and stack fields before revoking pending requests.
Unprintable rejection reasons and throwing stack getters still produce a diagnostic, and a
failed diagnostic transfer still dispatches the worker error fallback.
The playground catches startup rejection, displays the complete diagnostic, and enables Reload
for ordinary filesystem failures as well as ownership loss. The original startup fault fixture
checks the failed state, clicks Reload and requires a usable editor after navigation.
OPFS waits for an occupied Web Lock, reports waiting in the UI and resumes automatically after
the owner releases it. IndexedDB retains its default original takeover adapter. A new holder steals the lock, allocates a persisted epoch, and checks that epoch
inside every write transaction. A displaced page stops persistence and preserves visible editor text.
These changes extend bun-wasm's own adapters at `b14f536f`; no upstream implementation is copied.
The original persistence browser fixtures in `web/tests/persistence-browser-{main,worker}.ts`
and their Playwright/Safari runners exercise these adapters without a wasm build. The corpus
fixture retains only generated package-file sizes from the original local storage spike's
`build-corpus.py` output, identified by its SHA-256 in `fixtures/persistence-corpus.json`.
The worker reproduces the spike's original `fs-worker.js` synthetic seeded-word generator
(SHA-256 `4ea7e6f89a64af1c53b3b5eb5deb30291ff9f2dbbf7222cdee03ca627fe6e3fc`),
including its small-file seeds `17+i` and three large-file seeds `10033+i`. Local changes
add browser-native payload-read counters, incremental checkpoint timings and full-byte
integrity checks. This is original benchmark input, not copied package content or a Bun,
Node, WebKit, PGlite, or SQLite implementation.
Unbundled Node host adapters import Waffle's exported JavaScript memory helper through
`waffle/core/memory-views`, so headless CLI workflows remain dependency-free.
The original browser-build adapter resolves declared exports through the consuming app.
It validates the installed-package boundary and returns consumer-installed aliases for both
exported and relative imports, hiding isolated-cache directory names. No upstream code is copied.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`waffle/core/`, `waffle/fs/`, MemFS and pipe adapters](#browser-runtime-core) | Host feature | Original WASI, shared filesystem, IndexedDB persistence, lazy residency, startup diagnostics and descriptor adapters. |
| [`web/tests/persistence-browser-worker.ts`, persistence corpus](#browser-runtime-core) | Host feature | Original browser test adapter reproduces the local storage spike's generated sizes and synthetic bytes; no package contents or upstream implementation. |
