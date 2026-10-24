## Native process descriptor bridge

Class **Host feature**, **original adapters** in `crates/bunwasm-host/src/process/{mod,descriptors,wasi}.rs`
and the `runtime_proc` linker in `crates/bunwasm-host/src/slots.rs`. They implement the same
spawn request and packed wait/poll records as Waffle's `proc/{types,abi}.ts`, whose exact
revision is pinned by the consuming package. The Rust supervisor owns process/job ancestry,
typed outcomes and child threads; shared open descriptions preserve inherited and duplicate
pipe endpoint lifetimes. Weak Wasmtime stdio wrappers do not retain an endpoint after the
last process descriptor closes, so EOF/EPIPE is published by descriptor ownership rather
than by eventual `WasiCtx` destruction. After guest descriptor/context teardown, the native
supervisor publishes completion and removes safely finished orphan records whose direct
parent has already completed or been collected. Running descendants retain their shutdown
owner and ancestor signal authority; job leader outcomes remain independently consumable.
This original safe-completion fence matches Waffle's lifecycle contract without copying its
supervisor implementation.

The preview1 bridge intercepts process-owned `fd_read`, `fd_write`, `fd_close`, `fd_renumber`,
`fd_fdstat_get` and `fd_filestat_get`. It keeps preview1's blocking I/O and positive errno
contract while `runtime_proc` operations remain immediate and return negative errnos.
Filesystem descriptors remain owned by Wasmtime and are not transferable through this
spawn adapter. A virtual external-to-private descriptor map isolates them from arbitrary
process bindings, including preopen discovery, all fd-bearing filesystem/path operations,
and cross-kind renumbering. Closing process stdio never revives a hidden preview1 stream.
File handles reserve the same monotonic allocation space as process handles. Direct
`runtime_proc.read`/`write` share local filesystem handles and offsets with preview1,
including filesystem-backed stdio; synchronous native files/directories are immediately
ready in process polls. File I/O uses independently cached private-memory delegates, so
alternating the two ABIs never overwrites guest iovecs or changes a delegate's memory.
Adapter imports accept zero-page memories because descriptor initialization needs no bytes.
The bridge validates guest iovecs before observable I/O and delegates translated filesystem operations
to the existing Wasmtime functions. Delegation re-enters a small,
original generated Wasm wrapper that imports the guest's existing memory and the retained
preview1 function, then exports that memory and a forwarding call. A direct host-to-host
`Func::call` has no caller memory export for preview1 to inspect; the wrapper supplies that
Wasm caller context without copying the guest's linear memory. Each forwarded function is
instantiated lazily and cached per store. `poll_oneoff` merges non-consuming process readiness
with nonblocking filesystem/clock scans in a separate private scratch memory, preserving
guest subscriptions and checking pending signals between scans. Start-section imports can
find the guest's exported memory before instantiation returns. The original resource-limit
adapter in `crates/bunwasm-host/src/main.rs` bounds the guest and delegation instances to 40,
while retaining the guest's linear-memory limit. Shared input retries concurrent-reader
races instead of reporting false EOF; output flushes non-newline writes without replaying
accepted bytes. These are host-composition adapters, not
Wasmtime patches or copied Wasm modules. WASI record layouts and constants are interface
definitions, not copied wasi-libc code. No Bun, wasi-libc or
Wasmtime implementation is copied or patched by these new modules; the Wasmtime `proc_exit` behavior and upstream revision remain in [Browser process service](browser-process-service.md#browser-process-service).


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [Native process descriptor bridge](#native-process-descriptor-bridge) | Host feature | Original Wasmtime linker, memory-sharing Wasm delegation wrappers and shared-description adapters route process pipes through preview1 fds without copying wasi-libc or Wasmtime implementations. |
