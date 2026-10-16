# Browser runtime

Status: Approved (owner, 2026-10-16)

## Goal

One reusable runtime for running WASM-compiled native programs in the browser. It grows out of
bun-wasm's browser host (`web/src`) and serves bun.wasm, the shell and later programs. It
provides processes, streaming pipes, a live shared persistent filesystem, networking and, later,
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
- **One filesystem service**, owned by one worker, reached synchronously from guest
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
  Safari and WebKit never stop a WASM loop that makes no host calls: real Safari 26.4 kept all
  three such loops running past 5 s in 15 of 15 trials, while loops that call the host stopped at
  once. So a shared interrupt word that guests check is the required stop, not an optimization:
  our own programs (bun.wasm, the shell) check it, and third-party WASM gets interrupt checks
  injected at loop headers when it is loaded. `terminate()` stays as the backstop. Revocation
  wakes blocked peers at once (EOF in about 0.06 ms, EPIPE in about 0.3 ms), so pipelines never wait on a dying worker. The supervisor
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
| fs | Filesystem service (memory first, IndexedDB or OPFS backend) and its client | everything that touches files |
| net | Fetch bridge, virtual TCP namespace shared across processes, preview ingress | programs that use the network |
| proc | Supervisor, worker pool, process table, pipes, IPC channel, kill and job control | first spawn |
| threads | `wasi-threads` adapter (later) | threaded programs |
| adapters | Bun slots, shell process imports, terminal (raw/cooked, resize, EOF) | the program that needs them |

Bun-specific code stays in bun-wasm: `engine-host.js`, module serving in the service worker,
the install cache, `runner.ts`.

## Steps

### 0. Spikes (done, 2026-10-16)

Reports in `/work/reports/browser-runtime/spikes/`: `1-size-startup.md`, `2-processes-pipes.md`,
`3-opfs-fs.md`, `4-wasi-host-shell.md`. What they settled:

- **Size and startup.** Runtime JS for bun light is about 30-37 KiB gzipped and adds 10-30 ms at
  startup; the 3.85 MB WASM and the demo UI (89% of the JS) dominate. Proc is imported and
  constructed on every run today. Per-layer budgets: core 6 KiB, fs 6 KiB, net 14 KiB, proc
  8 KiB gzipped, zero proc bytes before the first spawn.
- **Processes and pipes.** Sharing one compiled module cuts bun.wasm spawn from 57-76 ms to
  23-32 ms; a 1-2 worker idle pool saves a few more ms at 2-3 MiB per worker; a finished bun
  instance costs 7-27 MiB, so none are kept. bun-wasm's existing `SharedPipe` is as fast as a new
  ring (3-9 GB/s) and lean on memory; it needs separate reader and writer ends. MessagePort is
  fine for IPC. Termination findings are in the decisions above.
- **Filesystem.** Per-file flushing, not files, made OPFS slow. IndexedDB batched writes and
  packed OPFS work everywhere; simple per-file OPFS works with parallel writes and no per-file
  flush but is slow in Firefox. Safari allows 253 open sync handles. Two backends from day one.
- **WASI host.** bun-wasm's host beats brush-web's by 2-9x per call and 4.5-10% on whole
  programs. It has nine correctness bugs to fix first (list in the spike 4 report).

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

## Build plan

### Where it lives

A new `runtime/` directory in bun-wasm: a TypeScript package (`@bun-wasm/runtime`) with one entry
per layer (`core`, `fs`, `net`, `proc`, `term`) so a bundler includes only what a page imports,
and `proc` behind a dynamic `import()` made on the first spawn. Bun's adapter and executor stay in
`web/`. brush-web and the own shell consume the package as a pinned copy, the way brush-web
vendors `third-party/bun-wasm/` today, until the product repository exists. Every new file that
adapts upstream code (brush-web's terminal discipline, SQLite's OPFS bridge pattern) gets its row
in `docs/bun-patches.md`.

### Process ABI (for the shell lane)

The service is a TypeScript interface; guests reach it through a WASM import module named
`runtime_proc`. Bun keeps its slots, adapted onto the same service. All calls are non-blocking
except `poll`.

| Import | Signature | Meaning |
|---|---|---|
| `spawn` | `(desc_ptr, desc_len) -> pid` | `desc` is UTF-8 JSON: `executable`, `argv`, `env`, `cwd`, `job` (`"foreground"`, `"background"` or a job id), and `fds`: a list of `{fd, handle}` binding child descriptor numbers (0, 1, 2 and any higher) to handles the parent owns. Returns a pid or a negative errno. |
| `pipe` | `(out_ptr) -> errno` | Creates a pipe; writes the read and write handles. |
| `dup` | `(handle) -> handle` | Another reference to the same endpoint (for `2>&1` and inheritance). |
| `close` | `(handle) -> errno` | Drops one reference; EOF reaches readers after the last writer reference closes, EPIPE reaches writers after the last reader reference closes. |
| `read` | `(handle, buf, len) -> n` | `n > 0` bytes, `0` at EOF, `len == 0` returns 0 at once, `-EAGAIN` when empty. |
| `write` | `(handle, buf, len) -> n` | Accepted bytes (partial writes allowed), `-EAGAIN` when full, `-EPIPE` when no reader. |
| `wait` | `(pid, status_ptr) -> errno` | `-EAGAIN` while running; otherwise writes `{kind: exited or signaled, code}`. |
| `kill` | `(pid_or_job, signal) -> errno` | `SIGINT`, `SIGTERM`, `SIGKILL`, `SIGPIPE`. Revokes at once; physical teardown follows. |
| `poll` | `(subs_ptr, n, timeout_ms, out_ptr) -> n_ready` | Waits until any handle is readable or writable, any listed child exits, the interrupt word is set, or the timeout passes. The only call that blocks. |
| `interrupted` | `() -> i32` | Reads and clears this process's interrupt word. Guests call it at checkpoints. Because it is a host call, it also lets `terminate()` stop the guest in Safari. |

Exit statuses: `exited(code)`, or `signaled(sig)` reported to shells as 128 + sig (130 for SIGINT,
141 for SIGPIPE, 143 for SIGTERM, 137 for SIGKILL). A guest that handles EPIPE and exits on its own
keeps its own code. WASI preview1 programs use the same handles through ordinary fds: a spawned
child's `fd_read(0)` blocks on its bound pipe, and `poll_oneoff` reports pipe readiness.

Third-party preview1 programs get `interrupted` checks injected at loop headers when loaded
(step 9); a check that sees the word set traps with exit status 130.

### Steps

Line counts include tests. Each step is one PR with an independent review; nothing merges without
the CI gate.

| # | Step | Estimate |
|---|---|---:|
| 1 | **Fix the WASI host bugs in place** (after PR #21 merges): the nine from spike 4, each with a failing test first, reusing spike 4's fixtures. Add the CI gate (GitHub Actions running `web/tests` and a headless browser smoke). | 600-900 |
| 2 | **Package skeleton and core.** Create `runtime/`, move `wasi.ts`, `memory-views.js` and path helpers; put the WASI host behind a descriptor interface with file, directory, pipe and terminal kinds, so it no longer holds MemFS nodes; explicit import namespaces instead of ENOSYS stubs; `poll_oneoff` with real per-descriptor readiness. `web/` consumes it with no behaviour change. CI adds a bundle-size check against the budgets. | 1,500-2,200 |
| 3 | **Filesystem service.** Filesystem worker owning an in-memory tree; synchronous calls from guest workers over SharedArrayBuffer; open-file identity across rename and unlink; background batched persistence; flush on `fsync`; backend interface with IndexedDB (default) and simple OPFS (lazy loading, bounded handle cache, per-browser create concurrency); checksummed metadata written beside the old copy then swapped; Web Locks for one writer tab. Editor writes go through it; delete copy-at-spawn and merge-at-exit. | 3,000-4,500 |
| 4 | **Process layer.** Supervisor, process table, generic executable registry (module plus guest adapter per entry), shared compiled modules, lazy 1-2 worker pool, pipes built from `SharedPipe` with endpoint reference counts and readiness, interrupt words, kill with revocation and generation numbers, foreground and background jobs, exit statuses, MessagePort IPC for Node `fork()` and Bun `spawn({ipc})`, the `runtime_proc` imports above. Loaded on first spawn. | 2,000-3,000 |
| 5 | **Terminal.** Terminal descriptor kind with a foreground owner; cooked mode (echo, line editing, Ctrl+D) ported from brush-web; raw mode passes Ctrl+C through as a byte; resize events. | 600-1,000 |
| 6 | **Network.** One socket namespace shared by all processes (children get networking; loopback works across workers); fetch bridge; bounded connection writes; preview routing split from Bun's module-serving service worker, one registration; the preview client loads only when a preview opens. | 1,000-1,600 |
| 7 | **Bun onto the runtime.** Bun's slots as an adapter over the services; remove the Bun-only spawn restrictions (`spawn.js:49-65`, `subprocess.js:170-179`) and engine inheritance; playground migrated; demo UI out of the runtime import graph; WebKit engine-cache retention fixed. Bun light must meet the budgets. | 1,000-1,500 |
| 8 | **The shell on the runtime.** Owned by the shell track: its `ProcessHost` maps onto the process ABI. This track supplies the ABI, a preview1 test fixture, and the milestone's Playwright acceptance tests (`/work/reports/browser-shell-research/pipelines.acceptance.spec.ts`). | shell track |
| 9 | **Interrupt injection for third-party WASM.** Spike first (a day): rewrite a module at load time to call `interrupted` at loop headers, measuring rewrite time and runtime overhead on a real program; then build it into the loader. | 800-1,500 |

Total for this track: about 10,500-16,200 lines across eight PRs, plus the shell track's own
work. Steps 2 and 3 can start in parallel once step 1 lands; step 4 depends on 2; 5, 6 and 7
depend on 4; 9 can run any time after 2.

### Before merging runtime PRs

Pause the compatibility wave while the runtime PRs land in order, then resume it (owner,
2026-10-16).

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
- brush-web `plans/001-brush-dev-shell.md`, `plans/004-own-shell.md` and `docs/external-commands.md`.
- Spike reports: `/work/reports/browser-runtime/spikes/`.
