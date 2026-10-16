# Browser runtime

Status: Approved (owner, 2026-10-16)

## Goal

One reusable runtime for running WASM-compiled native programs in the browser. It grows out of
bun-wasm's browser host (`web/src`) and serves bun.wasm, Brush (brush-web) and later programs. It
provides processes, streaming pipes, a live shared filesystem on OPFS, networking and, later,
threads.

It is layered and pay-for-what-you-use. Bun light (`bun-browser.wasm`, user code on the host's JS
engine) loads only core, filesystem and networking, and must not get heavier or slower to start
than it is today. The process layer loads on the first spawn.

## Decisions

- **No WASIX.** Programs speak WASI preview1 plus our own extensions: bun-wasm's `bun_wasm` host
  slots (`docs/host-abi.md`) and brush-web's process imports. The services underneath know nothing
  about any guest ABI, so another contract can be added later as an adapter without touching them.
- **No Unix fork.** Bun, Brush and Node's `child_process` all spawn. Node's `child_process.fork()`
  and Bun's `spawn({ ipc })` are spawn plus a message channel, and we support them that way. A
  program that needs Unix fork (real bash, for example) is out of scope until a specific one
  matters.
- **One worker per process.** A supervisor stays responsive while guests block, so spawn, kill
  and Ctrl+C always work, including against CPU-bound guests (`Worker.terminate()`).
- **One filesystem service on OPFS**, owned by one worker, reached synchronously from guest
  workers through shared memory. Writes are visible to every process when they complete. This
  replaces today's copy-at-spawn and merge-at-exit in both bun-wasm and brush-web.
- **Pipes run directly between workers** over shared memory, not through the supervisor.
- **Not adopted:** `@wasmer/sdk`, a fork of `@bjorn3/browser_wasi_shim`, SLICC code.

## Layers

| Layer | Contents | Loaded by |
|---|---|---|
| core | WASI preview1 host, descriptor table, memory views, clocks, random | everything |
| fs | OPFS filesystem service and its client | everything that touches files |
| net | Fetch bridge, virtual TCP namespace shared across processes, preview ingress | programs that use the network |
| proc | Supervisor, worker pool, process table, pipes, IPC channel, kill and job control | first spawn |
| threads | `wasi-threads` adapter (later) | threaded programs |
| adapters | Bun slots, Brush process imports, terminal (raw/cooked, resize, EOF) | the program that needs them |

Bun-specific code stays in bun-wasm: `engine-host.js`, module serving in the service worker,
the install cache, `runner.ts`.

## Steps

### 0. Spikes (now)

Measure before building. Each spike writes a report to `/work/reports/browser-runtime/spikes/` and
keeps prototype code in `/work/tmp/bun-wasm-spike-*`. No product code changes.

1. **Size and startup.** What each layer weighs today (bytes, gzipped), what bun light loads and
   what it spends its startup time on. Target budgets per layer.
2. **Processes and pipes.** Spawn latency cold, with one compiled `WebAssembly.Module` shared by
   every worker, and with a warm worker pool. Pipe throughput and latency worker-to-worker over
   shared memory against relaying through the supervisor. Killing a CPU-bound worker and waking
   blocked readers. A Node-style IPC channel's cost.
3. **OPFS filesystem.** A sync-access-handle pool for a dev workload (a `node_modules` tree of
   about 10,000 small files): create, open, read, stat, readdir, rename, unlink. Round-trip cost
   from a blocked guest worker to the filesystem worker. Metadata persistence and recovery.
   Handle limits. Chromium, Firefox, WebKit, and Safari on the owner's Mac.
4. **One WASI host and the shell.** Benchmark bun-wasm's `web/src/wasi.ts` against brush-web's
   `browser_wasi_shim` host on Brush and bun.wasm system-call paths (brush-web plan 001 step 2).
   Map what Brush needs from the runtime: process imports, concurrent pipelines, job control,
   Ctrl+C, terminal modes.

### 1. Build plan

Written from the spike results, with sizes and estimates per step, before any runtime code. It
covers where the package lives, the order of extraction, and the migration of bun-wasm's
playground and brush-web onto it.

## First milestone acceptance

1. Brush and bun.wasm use the same runtime package, filesystem service and process manager.
2. Executable selection is generic: Brush, bun.wasm and a small preview1 fixture are registered
   programs; the process service has no Bun-only assumption.
3. Pipelines run concurrently: a ticker piped into a filter shows lines before the producer exits;
   a stream larger than 1 MiB completes with bounded memory.
4. Pipe semantics are correct: zero-length reads and writes, partial writes, binary data, EOF after
   duplicated writers close, reader closure, cancellation, simultaneous stdin and stdout.
5. Files are live across processes: one process sees another's completed write before either
   exits. Editor changes go through the same filesystem.
6. Files survive reload, including metadata, rename, and unlink with an open descriptor.
7. Ctrl+C stops the foreground job and its descendants, including CPU-bound workers, wakes blocked
   I/O, and returns Brush to the prompt with status 130.
8. Bun previews keep working, routed through the network service.
9. Bun light's download size and startup time do not regress.
10. Verified on Chromium, Firefox and real Safari (owner's Mac); iOS Safari where storage allows.

## References

- `/work/reports/browser-shell-research/browser-runtime.md`: prior art, browser support, coupling
  audit of `web/src`.
- brush-web `plans/001-brush-dev-shell.md` and `docs/external-commands.md`.
