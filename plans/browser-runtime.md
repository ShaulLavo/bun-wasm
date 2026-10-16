# Browser runtime

Status: Approved (owner, 2026-10-16)

## Goal

One reusable runtime for running WASM-compiled native programs in the browser. It grows out of
bun-wasm's browser host (`web/src`) and serves bun.wasm, the shell and later programs. It
provides processes, streaming pipes, a live shared filesystem on OPFS, networking and, later,
threads.

It is layered and pay-for-what-you-use. Bun light (`bun-browser.wasm`, user code on the host's JS
engine) loads only core, filesystem and networking, and must not get heavier or slower to start
than it is today. The process layer loads on the first spawn.

## Decisions

- **The shell is our own** (shell track, `/work/reports/browser-shell-research/handoff-shell.md`):
  a single-threaded async core on Bashkit's parser and interpreter semantics. Brush in brush-web
  is today's working baseline and the reference for what a shell needs from the runtime; it is
  not the long-term guest. The shell's next gate, real worker-backed spawn, shared interrupt,
  inherited descriptors and a background job, runs on this runtime's process layer.
- **Pipes serve two kinds of reader.** Preview1 programs block in `fd_read`; the async shell and
  Bun's event loop use non-blocking reads and a readiness wait (`poll`). The same pipe endpoint
  supports both.
- **No WASIX.** Programs speak WASI preview1 plus our own extensions: bun-wasm's `bun_wasm` host
  slots (`docs/host-abi.md`) and brush-web's process imports. The services underneath know nothing
  about any guest ABI, so another contract can be added later as an adapter without touching them.
- **No Unix fork.** Bun, the shell and Node's `child_process` all spawn. Node's `child_process.fork()`
  and Bun's `spawn({ ipc })` are spawn plus a message channel, and we support them that way. A
  program that needs Unix fork (real bash, for example) is out of scope until a specific one
  matters.
- **One worker per process.** A supervisor stays responsive while guests block, so spawn, kill
  and Ctrl+C always work, including against CPU-bound guests (`Worker.terminate()`).
- **One filesystem service on OPFS**, owned by one worker, reached synchronously from guest
  workers through shared memory. Writes are visible to every process when they complete. This
  replaces today's copy-at-spawn and merge-at-exit in both bun-wasm and brush-web.
- **Storage backends are swappable.** The filesystem service talks to storage through a small
  backend interface (load the tree, read data that isn't in memory, persist a batch, flush). We
  ship two from day one: IndexedDB, the default (fastest writes on Chromium and Safari, consistent
  reads), and OPFS. The OPFS backend is simple: one OPFS file per file, no per-file flush, create
  concurrency tuned per browser, and lazy loading (the index loads in about 20 ms; files are read
  on first use, since reading every file takes 16-33 s in Firefox). A packed OPFS backend, 15x
  faster to write in Firefox, can come later (spike 3). Later backends can include IndexedDB
  without our own memory cache (lower memory, the browser caches for us) and memory-only for
  throwaway sandboxes (owner, 2026-10-16).
- **Killing is not instant, so kills interrupt, revoke and confirm.** Chromium waits 2 s before
  forcibly stopping a busy worker after `terminate()` (`kForcibleTerminationDelay` in Blink's
  `worker_thread.cc`; spike 2 saw CPU-bound WASM and JS keep running and writing shared memory).
  Firefox and WebKit stop within a millisecond. So a shared interrupt word that guests check is
  the primary stop, and `terminate()` the backstop. Revocation wakes blocked peers at once (EOF in
  about 0.06 ms, EPIPE in about 0.3 ms), so pipelines never wait on a dying worker. The supervisor
  bumps a generation number on the dead process's descriptors so its late writes are ignored; that
  revocation is the correctness boundary. A guest that stops cooperatively acknowledges its exit;
  for an uncooperative kill the browser gives no teardown signal, and silence isn't proof (a guest
  may just be blocked). So a killed process's shared buffers are never handed to another process:
  new processes get fresh buffers, and the old ones are released for garbage collection.
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
| adapters | Bun slots, shell process imports, terminal (raw/cooked, resize, EOF) | the program that needs them |

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

### Process layer requirements from the shell

The own shell (brush-web `plans/004-own-shell.md`, `/work/reports/browser-shell-research/own-shell-spike.md`
sections 7 and 8) maps its `ProcessHost` trait onto this layer. The process layer provides:

- spawn with argv, env, cwd and arbitrary descriptor bindings (fd 3 and up, not only stdio);
- several concurrent children per parent;
- non-blocking reads and writes with readiness and child-exit notification, so a single-threaded
  async guest parks only when nothing is runnable;
- bounded pipes: EOF after the last writer closes, EPIPE after the last reader closes, partial
  writes, zero-length reads and writes;
- a shared interrupt word the guest can see while its WASM runs;
- Ctrl+C kills the foreground job and its descendants with confirmed exit, while unrelated
  background children keep running;
- a generic executable registry;
- broken pipe status: a child killed by SIGPIPE reports 141; a guest that handles EPIPE keeps its
  own status.

The process ABI section of the build plan is written against this list, and the shell lane is
told when it is settled.

### 1. Build plan

bun-wasm has no CI today (no `.github/workflows`; PRs report no checks). The runtime package's
first PR adds a GitHub Actions gate that runs its unit tests and headless browser tests on every
PR, and every later runtime PR must pass it.

Written from the spike results, with sizes and estimates per step, before any runtime code. It
covers where the package lives, the order of extraction, and the migration of bun-wasm's
playground and brush-web onto it.

## First milestone acceptance

1. The shell and bun.wasm use the same runtime package, filesystem service and process manager.
2. Executable selection is generic: the shell, bun.wasm and a small preview1 fixture are registered
   programs; the process service has no Bun-only assumption.
3. Pipelines run concurrently: a ticker piped into a filter shows lines before the producer exits;
   a stream larger than 1 MiB completes with bounded memory.
4. Pipe semantics are correct: zero-length reads and writes, partial writes, binary data, EOF after
   duplicated writers close, reader closure, cancellation, simultaneous stdin and stdout.
5. Files are live across processes: one process sees another's completed write before either
   exits. Editor changes go through the same filesystem.
6. Files survive reload, including metadata, rename, and unlink with an open descriptor.
7. Ctrl+C stops the foreground job and its descendants, including CPU-bound workers, wakes blocked
   I/O, and returns the shell to the prompt with status 130.
8. Bun previews keep working, routed through the network service.
9. Bun light stays near its budget: runtime JS about 100 KiB minified / 35 KiB gzipped, the
   process layer loaded only on first spawn, and no slower startup. The budget is a guide, not a
   hard gate (owner, 2026-10-16): modest overshoot is fine when it buys something.
10. Verified on Chromium, Firefox and real Safari (owner's Mac); iOS Safari where storage allows.

## References

- `/work/reports/browser-shell-research/browser-runtime.md`: prior art, browser support, coupling
  audit of `web/src`.
- brush-web `plans/001-brush-dev-shell.md` and `docs/external-commands.md`.
