# bun.wasm host ABI (`bun_wasm`, version 2)

WASI preview1 has no sockets. Hosts that want to give bun.wasm networking
(`fetch`, `Bun.serve`, `node:http`, `node:net`) provide the extra functions described here.
Hosts that don't need to do nothing for them: network APIs reject or throw "not supported".
Child processes are different: they use the `runtime_proc` import namespace
([Process imports](#process-imports)), which every host instantiating bun.wasm provides.

## Why not plain imports

A core wasm module cannot have optional imports: an unknown import makes
`wasmtime run` (and `WebAssembly.instantiate`) fail. So bun.wasm does **not
import** these functions. Instead the host *installs* them after
instantiation and before calling `_start`:

1. bun.wasm exports its function table as `__indirect_function_table`
   (growable) and a function `bun_wasm_host_slots() -> i32`.
2. `bun_wasm_host_slots()` returns a pointer `p` (in linear memory) to:

   | offset   | type  | meaning                                          |
   |----------|-------|--------------------------------------------------|
   | `p+0`    | `u32` | ABI version the guest speaks (`2`)               |
   | `p+4`    | `u32` | number of slots `N`                              |
   | `p+8+4i` | `u32` | slot `i`: table index of the host function, or 0 |

3. For every slot it implements, the host appends its function to the table
   (`table.grow(1, func)`) and stores the new index in the slot. Slots left
   at 0 mean "not provided"; the guest checks each slot before calling.
   A host may provide any subset (e.g. the browser has no `connect`).

Calling `bun_wasm_host_slots` before `_start` is safe (it only returns the
address of a static). Browsers cannot put a JS function into a table
directly; wrap it by instantiating a tiny module that imports the JS
functions and re-exports them (the exports are wasm functions and can be
stored in the table).

### Calling through an import

Some engines may reject a cross-module function in the guest's table: a call_indirect to it traps
with "signature does not match" (iOS Safari does this for functions of another module). For those, a host can
instead write `0xFFFFFFFF` into a slot. The guest then calls that slot through WASI's `sock_send`,
which every preview1 host already provides:

```
sock_send(fd = 0x7FFFB0B0, si_data = ptr to [slot, a, b, c, d] (5 × i32), si_data_len = 5,
          si_flags = 0, so_datalen = ptr to the i32 result) -> errno
```

The host answers with errno 0 and writes the slot's result. Unused arguments are 0. Any other errno
reads as `UNSUPPORTED`. The playground and sandbox use this by default (`web/src/net/trampoline.ts`,
`installHostSlotsViaImport`); `?slots=table` selects the table path for comparison.
`scripts/run.ts` uses it with `SLOTS=imports`.

## Conventions

- All parameters and results are `i32` (wasm32 pointers and lengths are
  `i32`). Every function has the exact signature listed; the guest calls them
  with `call_indirect`, so a mismatch traps.
- Buffers are `(ptr, len)` pairs in the guest's linear memory.
- Handles are positive `i32`s chosen by the host, unique per process and
  never reused while open. `0` is never a valid handle.
- Results `>= 0` are success. Negative results are errors:

  | code | name          | meaning                                                  |
  |------|---------------|----------------------------------------------------------|
  | `-1` | `ERROR`       | failed; `error(handle, …)` describes why                 |
  | `-2` | `AGAIN`       | would block; try again after `poll`                      |
  | `-3` | `BADF`        | unknown or closed handle                                 |
  | `-4` | `UNSUPPORTED` | the host doesn't do this (e.g. `connect` in a browser)   |

- **Nothing blocks except `poll`.** The guest's event loop calls the
  non-blocking functions; when everything returns `AGAIN` and no JS timer is
  due, it calls `poll(timeout)` to sleep until the host has news.
- Text is UTF-8. Structured data is UTF-8 JSON.

## Slots

| slot | name         | signature                                                        |
|------|--------------|------------------------------------------------------------------|
| 0    | `poll`       | `(timeout_ms) -> i32`                                            |
| 1    | `fetch`      | `(meta_ptr, meta_len, body_ptr, body_len) -> handle`             |
| 2    | `fetch_head` | `(handle, buf_ptr, buf_cap) -> len`                              |
| 3    | `read`       | `(handle, buf_ptr, buf_cap) -> n`                                |
| 4    | `write`      | `(handle, buf_ptr, len) -> n`                                    |
| 5    | `close`      | `(handle) -> i32`                                                |
| 6    | `listen`     | `(host_ptr, host_len, port) -> handle`                           |
| 7    | `local_port` | `(handle) -> port`                                               |
| 8    | `accept`     | `(listener) -> handle`                                           |
| 9    | `connect`    | `(host_ptr, host_len, port) -> handle`                           |
| 10   | `error`      | `(handle, buf_ptr, buf_cap) -> len`                              |
| 11   | `peer_addr`  | `(handle, buf_ptr, buf_cap) -> len`                              |
| 12   | `shutdown`   | `(connection) -> i32`                                            |
| 13   | `local_addr` | `(handle, buf_ptr, buf_cap) -> len`                              |
| 14   | `lookup_start` | `(host_ptr, host_len, family, hints) -> handle`                |
| 15   | `lookup_head` | `(handle, buf_ptr, buf_cap) -> len`                              |
| 16   | `listen_path` | `(path_ptr, path_len, flags) -> handle`                         |
| 17   | `connect_path` | `(path_ptr, path_len) -> handle`                              |

Version 2 has 18 slots. Slots 0 through 13 are unchanged. Hosts that do not
provide lookup leave slots 14 and 15 at 0; the runtime then keeps its existing
unsupported-capability rejection. There is no version-skew bridge.
The Bun-specific child slots (`spawn`, `child_wait`, `child_pipe`,
`child_kill`) and the signal slot no longer exist; slots after `peer_addr` were renumbered when
they went away. Child processes and signals use the `runtime_proc` imports.

### `poll(timeout_ms) -> i32`

Block until some handle may have changed state (a response head or body
bytes arrived, a connection is ready to accept, bytes are readable, a peer
closed, a write can proceed, an error happened) or `timeout_ms` elapsed.
`timeout_ms < 0` waits forever; `0` returns at once. Returns `1` if it woke
for an event, `0` on timeout. Spurious wake-ups are allowed: the guest
re-checks its handles either way. The host must not report the same
already-consumed event forever (`poll` may return 1 only when something new
happened since the previous `poll` returned).

### `fetch(meta_ptr, meta_len, body_ptr, body_len) -> handle`

Start an HTTP request. `meta` is JSON:

```json
{ "method": "POST", "url": "https://example.com/x",
  "headers": [["content-type", "text/plain"], ["x-a", "1"]],
  "redirect": "follow" }
```

`body` is the raw request body (`body_len` may be 0; ignored for GET/HEAD).
`redirect` is `"follow"` (default), `"manual"` or `"error"`. Returns a handle
at once; the request proceeds in the background. Errors that are known
immediately (malformed URL, unsupported scheme) may be returned as `-1` with
`error(0, …)` describing them.

Installer requests set `credentialPolicy` to `"package"`. Each redirect destination
must use HTTP or HTTPS without userinfo, a query or embedded npm auth options.
Redirects drop sensitive headers whenever the scheme, host or effective port changes.
Host traces report request, response and error sizes without printing payloads or headers.

### `fetch_head(handle, buf_ptr, buf_cap) -> len`

`AGAIN` until the response head is available. Then writes JSON:

```json
{ "status": 200, "statusText": "OK", "url": "https://example.com/x",
  "redirected": false, "headers": [["content-type", "text/html"]] }
```

and returns its length. If the JSON is longer than `buf_cap`, nothing is
written and the needed length is returned (the guest retries with a bigger
buffer). Network failures (DNS, refused, TLS, CORS in browsers) return `-1`;
`error(handle, …)` then gives the reason. Headers keep their order; names are
lower-case; repeated headers appear as separate pairs.

Optional `bodyEncoding`: a host that forwards compressed bytes names the
compression, and the guest decodes them before exposing the fetch body. Absent or
null means the bytes are exposed as-is. The Node host uses it for Zstd. The original content-encoding and content-length headers remain visible.

### `read(handle, buf_ptr, buf_cap) -> n`

For a fetch handle: the response body (after `fetch_head` succeeded),
already decoded from `content-encoding` (gzip/br/deflate) by the host, like
browsers do. For a connection handle: bytes from the peer. Returns `n > 0`
bytes, `0` at end of stream, `AGAIN`, or `ERROR`.

Handle `0` reads the current guest's stdin without blocking. It uses the same
return values. A host that does not expose stdin through this interface returns
`UNSUPPORTED`; ordinary WASI stdin remains available. The native launcher polls
its stdin stream, and browser and Node workers expose their shared subprocess
stdin pipe. Host-engine workers keep a watcher active while stdin is pending.
Callback `fs.read(0, ...)` registers an I/O waiter for these reads.
Synchronous reads use the WASI descriptor without Rust stdin prefetching.
The native WASI adapter and host interface share one read-ahead buffer, so
synchronous and callback reads keep one position.

### `write(handle, buf_ptr, len) -> n`

Connection handles only. Queues up to `len` bytes; returns how many were
accepted (`0 < n <= len`) or `AGAIN` when the host's buffer is full. Hosts
should accept at least 64 KiB per call when idle.

### `close(handle) -> i32`

Close any handle (fetch: abort the request; listener: stop listening;
connection: flush queued writes, then close). Returns 0 or `BADF`.

### `listen(host_ptr, host_len, port) -> handle`

Listen for TCP connections on `host:port` (`host` like `"0.0.0.0"`,
`"127.0.0.1"`, `"localhost"` or `"::"`; `port` 0 picks a free port).
Returns a listener handle or `ERROR` (e.g. `EADDRINUSE`, see `error`).

### `local_port(handle) -> port`

The port a listener (or connection) is bound to.

### `accept(listener) -> handle`

A new connection handle, or `AGAIN` when none is pending.

### `connect(host_ptr, host_len, port) -> handle`

Open a TCP connection (for `node:net` clients). Returns a handle at once;
`write` returns `AGAIN` until connected, `read`/`write` return `ERROR` if
the connection failed.

### `lookup_start(host_ptr, host_len, family, hints) -> handle`

Start a side-effect-free asynchronous hostname lookup. The host copies the
length-delimited UTF-8 hostname before returning and retains no guest pointer,
store or engine reference. `family` is `0`, `4` or `6`; `hints` is the Bun/Node
resolver bitmask (`AI_V4MAPPED` 8, `AI_ALL` 16 and `AI_ADDRCONFIG` 32), not a
platform libc value. Invalid arguments fail immediately with `ERROR` and are
described by `error(0, ...)`. A successful start returns a positive handle;
`close` may cancel it logically without waiting for the resolver worker.

The native implementation performs `getaddrinfo` on a detached host worker,
walks the returned list in resolver order, and publishes either one owned JSON
result or one structured resolver error. It does not connect, listen, fetch,
inspect `/etc/hosts`, or substitute a local hostname table. A cancelled worker
may finish later, but its result is discarded and it never retains guest state.

### Unix path calls

`listen_path` and `connect_path` take absolute UTF-8 paths. Bun joins relative
Node paths to the current cwd without lexical normalization. Invalid UTF-8 and
reserved listen flags report ERROR with EINVAL through `error(0)`. Listen flag
bit 0 requests unlink on close. NUL and abstract names report EINVAL.

The calls delegate to Waffle's `listenPath` and `connectPath`. All subsequent
accept, read, write, shutdown, close, error and sized address calls reuse the
same handles. Unix addresses are JSON `{ "family": "Unix", "path": string | null }`.
The native Wasmtime host leaves these two slots unset. The shared Waffle NET
provider is required for real filesystem sockets.

### `lookup_head(handle, buf_ptr, buf_cap) -> len`

Returns `AGAIN` while the resolver is pending. On success it returns repeatable
sized JSON until `close`:

```json
{ "addresses": [{ "address": "127.0.0.1", "family": 4 }] }
```

The host preserves resolver order and returns the full required length without
writing when `buf_cap` is too small. A resolver failure returns `ERROR`; read
`error(handle, ...)` immediately for JSON containing `code`, `syscall` set to
`"getaddrinfo"`, and the copied `hostname` (for example `ENOTFOUND`). After
`close`, `lookup_head`, `error` and a second `close` return `BADF`.

### `error(handle, buf_ptr, buf_cap) -> len`

JSON describing the last error on `handle` (or the last handle-less error
for handle `0`), same length protocol as `fetch_head`:

```json
{ "name": "TypeError", "message": "Failed to fetch", "code": "ECONNREFUSED" }
```

`code` is optional (a POSIX-style code such as `ECONNREFUSED`,
`EADDRINUSE`, `ENOTFOUND`, `ETIMEDOUT`).

### `peer_addr(handle, buf_ptr, buf_cap) -> len`

JSON `{ "address": "127.0.0.1", "port": 51234, "family": "IPv4" }` for a
connection, same length protocol as `fetch_head`.

## Signal dispositions

`runtime_proc.signal(sig, mode)` connects Node/Bun signal listeners to the process host; preview1
programs use the same import. Bun imports it like the other process calls, and there is no
signal slot.

- Modes 0, 1 and 2 synchronously set default, ignored and handled dispositions, respectively.
  Signal numbers are 1–64; SIGKILL (9) cannot be registered or ignored.
- Mode 3 raises a signal against this process's current disposition, including SIGKILL. It does
  not force the default action when a handler is registered.
- `(0, 0)` dequeues one pending handled signal, lowest signal number first; 0 means none.
  `runtime_proc.interrupted()` consumes that same queue, not a second copy. If signal death has
  already been selected, entering this checkpoint instead unwinds through that typed default
  action; an empty handled queue cannot hide a selected fatal outcome.
- `(0, 4)` polls selected fatal cancellation without consuming or changing handled pending
  signals. A live process returns 0. Engine callbacks use this operation and never call guest JS.
  Mode 4 with a nonzero signal is invalid.
- Set/raise/poll returns 0 on success; invalid arguments return -22. A selected default action may
  instead unwind the current execution through the host's typed signal termination path.

This layer supports SIGINT (2), SIGKILL (9), SIGPIPE (13) and SIGTERM (15). For a default
SIGINT/SIGTERM/SIGPIPE disposition, the supervisor immediately selects the signaled outcome,
revokes capabilities and requests termination. Ignored signals do nothing. Handled signals queue
without cancellation, so their handler can clean up and retain the guest's own exit code. SIGKILL
always selects 137 and cannot be caught or ignored. Registration and removal publish synchronously
with listener mutation, before user `removeListener` observers run. Removing a pending handler to
default immediately selects its default action; setting ignored clears the pending signal.

Browser/Node processes share 65 Int32 cells, indexed by signal number. The low two bits encode
the disposition and bit `0x4` records pending delivery. Atomic updates couple disposition and
pending state; distinct pending signals cannot overwrite one another, while repeats of one
standard signal may coalesce. Dequeue clears pending before a once-listener removes itself.
The existing interrupt word is only a wake hint. Cooperative dequeue clears that hint before
reading pending state, then re-arms it if another handled signal remains; mode 4 changes neither.
Page-delivered `kill` and `killJob` notify the process budget used by Bun host polling, and
generic process polling also receives a directory-wake notification. Preview1 waits observe
the same root or child interrupt channel. Native stores use the same disposition and pending
rules under their process-state synchronization. Polling/listener registration alone
does not keep an otherwise idle guest alive. Like Node, handled signal callbacks run only on
ordinary guest event-loop turns, never in the middle of synchronous JavaScript. QuickJS/JSC
engine checkpoints make one nonblocking `signal(0, 4)` call: live processes resume, leaving all
handled pending signals in the authoritative host set. This also preserves immediate default
and ignored transitions if a handler is removed before delivery. A selected fatal outcome
unwinds through the host's typed default action, outside guest catch/finally blocks, including
when a handled callback is itself CPU-bound. An infinite loop with a handled signal does not
run that handler without yielding; a default signal or SIGKILL can still stop it. Idle event-loop
waits wake for handled signals. This adds one mode to `signal`, not a slot, import, retry, or
timeout. Unhandled default actions remain immediate supervisor decisions; the engine hooks stop
physical execution even when the browser cannot terminate busy Wasm.

An EPIPE remains an error through guest stream callbacks/listeners or try/catch. Plain preview1
programs retain the default SIGPIPE action, so a SIGPIPE request selects 141. The Node/Bun JS
runtime is different: it initializes SIGPIPE as ignored, lets an explicit `SIGPIPE` listener opt
into handled delivery, and restores default after the last SIGPIPE listener is removed. An escaping EPIPE keeps the
ordinary uncaught-error path and exits 1 with the error printed, even with a SIGPIPE listener; a
handled EPIPE keeps the guest's own status. Error handling never synthesizes SIGPIPE or consumes
unrelated pending signals. An explicit parent SIGPIPE request uses the target disposition immediately,
just like SIGINT or SIGTERM.

## Process imports

Bun's `Bun.spawn`, `node:child_process` and `worker_threads` run on the generic `runtime_proc`
process ABI, the same imports preview1 programs use, so Bun children are ordinary members of the
runtime's process directory. Unlike the network slots they are real wasm imports: the guest
imports exactly these functions, all `i32` parameters and an `i32` result, with Waffle's
`ProcessABI` semantics (`proc/abi.ts` in the Waffle repository):

| import | signature |
|---|---|
| `runtime_proc.access_start` | `(path_ptr, path_len, cwd_ptr, cwd_len, mode) -> request` |
| `runtime_proc.access_take` | `(request) -> 0` or negative WASI errno (`-6` while pending) |
| `runtime_proc.access_cancel` | `(request) -> 0` |
| `runtime_proc.spawn` | `(desc_ptr, desc_len) -> pid` |
| `runtime_proc.job_of` | `(pid) -> job`; `job_of(0)` is the caller's own job |
| `runtime_proc.pipe` | `(out_ptr) -> 0` (two `u32`: read end, write end) |
| `runtime_proc.fd_kind` | `(fd) -> kind` or negative WASI errno |
| `runtime_proc.read` | `(fd, buf, len) -> n` |
| `runtime_proc.write` | `(fd, buf, len) -> n` |
| `runtime_proc.start_status` | `(pid) -> status`, non-consuming entry observation described below |
| `runtime_proc.wait` | `(pid, out_ptr) -> 0` (`u32 kind`, `i32 code`) |
| `runtime_proc.wait_job` | `(job, flags, status_ptr) -> errno` |
| `runtime_proc.kill` | `(pid, sig) -> 0` |
| `runtime_proc.kill_job` | `(job, sig) -> 0` |
| `runtime_proc.poll` | `(subs_ptr, n, timeout_ms, out_ptr) -> n_ready` |
| `runtime_proc.signal` | `(sig, mode) -> result`, see [Signal dispositions](#signal-dispositions) |
| `wasi_snapshot_preview1.fd_close` | `(fd) -> errno`, the only way to close a pipe end |

`fd_kind` is a non-consuming query of the effective descriptor binding. Its kinds are 0 for
other or unknown, 1 for a pipe, 2 for a terminal, 3 for a regular file and 4 for a directory.
Closed or absent bindings return `-8` BADF. The query neither reads bytes nor moves a cursor,
and duplication or renumbering preserves the resource kind. Kind 0 must never imply a pipe.
The guest still performs ordinary fstat first, preserving its capability checks, and uses kind 1
only to restore FIFO mode bits missing from preview1's file-type enumeration. The host and
guest must both implement this import; no legacy-host fallback exists.

Executable access requests observe live filesystem metadata and executable registry admission.
The guest asks for executable mode `1`, consumes each completion once, and cancels outstanding
requests if waiting fails. Query results use negative WASI errno, not native libc errno numbers.

The guest does not import `dup`, `interrupted` or `default_signal` (`signal(0, 0)` dequeues like
`interrupted`; a selected default action unwinds inside the host). A host that instantiates bun.wasm must provide the namespace; a plain `wasmtime run` of
bun.wasm no longer links. Results are `>= 0` or a negative WASI errno (`EAGAIN` is `-6`, `EPIPE`
`-64`); they are not the network slots' `-2 AGAIN`.

The guest never chooses descriptor numbers for itself. `spawn` takes UTF-8 JSON:

```json
{"executable":"/bin/bun","argv":["bun","run","/app.ts"],"cwd":"/","env":{"HOME":"/"},"job":0,
 "fds":[{"child":0,"parent":7},{"child":1,"parent":8},{"child":2,"parent":2}]}
```

- The guest resolves `executable` through the live access-query ABI before allocating pipes.
  Names containing `/` bypass PATH; otherwise entries are tried in order, including empty entries
  as cwd. ENOENT and ENOTDIR candidates are skipped; EACCES is remembered while later executable
  candidates remain eligible. Bun.which uses the same lookup. Absolute paths are never rewritten.
  Program files and engine PATH defaults are documented in the [package guide](browser-package.md#installation-and-ownership).
  The worker supplies the resolved executable as guest argv[0], making process.execPath a real
  executable path; spawn error metadata still names the caller's original command.
- `env` replaces the child environment; the host sets `PWD` to `cwd`.
- `job` is the caller's own job, from `job_of(0)`, so job-wide signals and waits from the owner
  reach grandchildren; the guest never waits for or signals that job as a whole. If `job_of(0)`
  fails the spawn throws that error (no new-job fallback). A `detached` child instead requests
  `job: 0`, a new foreground job owned by its parent; the guest then reaps it with
  `wait_job(job, NOHANG)` after observing the exit and signals it with `kill_job` on abort.
- `fds` binds child descriptors to parent descriptors. Stdio `pipe` creates a fresh pipe whose
  child end is bound to fd 0, 1 or 2 and whose other end the parent keeps. `inherit` binds
  `{child: n, parent: n}`, the parent's own stream, including a pipe when the parent is itself a
  child. `ignore` has no `/dev/null`: stdin is a pipe whose only writer closed, and output is a
  pipe the parent reads and discards. `spawn` takes its references before it returns, so the
  guest closes the child ends at once; nothing else is inherited.
- A `worker_threads` child additionally carries `"worker": {"resourceLimits": ..., "memoryLimitMb": ...}`
  (hosts may ignore it) and two extra bindings, one pipe in each direction. Each child number is
  the parent's own descriptor number for that end, and the child learns both from
  `BUNWASM_WORKER_CONTROL={"input":N,"output":M}` (it reads `N` and writes `M`, then deletes the
  variable). These are ordinary bindings: no reserved numbers, and a grandchild inherits them only
  if its own request lists them.

`wait` reports `-6` while the child is not safely complete, then writes `kind` 0 (exited,
`code` the byte-sized exit status), 1 (signaled, `code` the signal number), or 2 (startup failed,
`code` a positive WASI errno; see [job completion](#generic-runtime-job-completion)). A successful
wait consumes the child exactly once. That is the only way a signal death is classified:
`process.exit(143)` is `exitCode: 143, signalCode: null`, a selected SIGTERM is `exitCode: null,
signalCode: "SIGTERM"`, and requests or timeout flags never relabel an outcome. Real exits
126/127 remain ordinary exits. `kill` examines the target's disposition as described under
[Signal dispositions](#signal-dispositions); the runtime supports SIGINT, SIGTERM, SIGKILL
and SIGPIPE. Closing the parent's end of an output pipe makes child writes fail with `EPIPE`;
closing stdin sends EOF.

`start_status(pid)` observes entry without consuming the child or waiting for descriptor
cleanup: 0 means entry committed, `-6` means pending, a positive value is one of the seven
startup WASI errnos, `-11` means an exit or signal won before entry, and `-12` means an unknown,
wrong-parent or collected child. Entry commits only after host setup and before invoking
`_start`; entry and terminal selection arbitrate atomically. Poll CHILD_START (kind 6) is
level-triggered after any nonpending observation until collection. Node observes startup
before consuming an exit, emits spawn only for status 0, and removes kind 6 after that first
observation. This permits a spawn listener to feed a live child's stdin without waiting for
child output or exit.

While children are running the event loop sleeps in `poll` on exactly what its waiters watch
(readable output pipes, a blocked stdin pipe as writable, child exit kind 2, job-empty kind 4,
and child startup kind 6 while pending) instead of the network `poll(timeout)` slot, so child
output and lifecycle observations wake it directly.
`Bun.spawnSync` polls the same way until completion. Pipe capacity, the number of concurrent
children and per-process memory belong to the process service, not to this guest contract.

Fork launches a Bun child with two explicitly bound `runtime_proc` pipes for JSON IPC.
The child consumes its `{ input, output }` descriptor pair from `BUNWASM_IPC_CHANNEL`
during bootstrap. Newline-delimited JSON, queued writes, EOF/disconnect and endpoint
cleanup are guest policy. No new host import or broker is involved. Native handle
passing and advanced serialization remain unsupported.
Shell execution accepts a single quoted bun command, without shell operators or expansion. `$`
remains unsupported.

## Native process resource limits

The native `bun-wasm` launcher admits at most four active children across the root and all
its descendants. Each instance defaults to 512 MiB of linear memory; a worker's
`memoryLimitMb` extension can select its own memory limit. Each native guest thread reserves
a 16 MiB Wasm stack plus 8 MiB of host-call headroom. `BUN_WASM_HOST_STACK_KIB` changes the
Wasm portion for the root and children; `BUN_WASM_MEMORY_INIT_COW=0|1` controls Wasmtime's
copy-on-write memory initialization (use `0` for file-size-limit fixtures).

Children run the launcher's same compiled guest module under the Bun/Node aliases listed
above, never a native executable. They share the root's filesystem preopens, and their
absolute `cwd` must map into a preopen without parent-directory traversal. Process stream
bindings support arbitrary nonnegative child descriptors and share their open description
across spawn and duplication. A private Wasmtime filesystem descriptor cannot currently be
transferred through `fds`; the launcher rejects that request with `-8` (`EBADF`) rather than
silently replacing or dropping it. Process descriptors support ordinary WASI read, write,
close, renumber and `poll_oneoff` operations as well as the direct process imports. Filesystem
handles are translated through a private descriptor map, so inherited streams cannot expose
or revive a preopen with the same underlying number. Renumbering replaces files and streams
in either direction. Local filesystem-backed descriptors, including replaced stdin/stdout,
share their offsets across WASI and direct `runtime_proc.read`/`write`; their synchronous I/O
is immediately ready in process polls. This local interop does not enable filesystem handle
transfer through spawn. Mixed filesystem, clock and stream polls preserve guest subscriptions;
handled signals interrupt a blocked poll without consuming the signal.

## Hosts

- `crates/bunwasm-host` (`bun-wasm` binary): native launcher on wasmtime,
  implements every slot and the `runtime_proc` namespace.
- `web/`: the browser playground implements `poll`, `fetch`, `fetch_head`,
  `read`, `close`, `error`, and for `Bun.serve` previews `listen`,
  `local_port`, `accept`, `write` and `peer_addr` on virtual connections fed
  by a service worker (`/__preview/<port>/…`). `connect` works only to the
  guest's own listeners (an in-worker pipe); anything else is `UNSUPPORTED`.
  Requests are relayed through a SharedArrayBuffer ring (web/src/net/), so
  the page must be cross-origin isolated; without isolation no slots are
  installed. `scripts/run.ts` offers the same slots when running the shim
  in Bun.
- `wasmtime run`: cannot instantiate bun.wasm, which imports `runtime_proc`. A host without
  networking provides the namespace and leaves every network slot unset; network APIs then report
  "not supported".


## TCP half-close and local addresses

`shutdown(connection)` flushes bytes already accepted by `write`, then sends FIN
on that connection's write direction. The handle remains open for reads. A
second shutdown succeeds without sending another FIN. `close` releases the
handle after both directions are no longer needed.

`local_addr` uses the same JSON and buffer protocol as `peer_addr`. It accepts
listeners and connections and returns `AGAIN` while an outbound connection is
still opening. An empty `write` on a connecting handle returns `AGAIN`, zero
after the connection opens, or `ERROR` on connection failure. It does not send
data. The guest uses this to delay the Socket connect event until success.

All browser engines support raw TCP only between listeners and clients inside
the same guest worker. An absent loopback listener fails with `ECONNREFUSED`.
An outbound internet TCP connection fails with `ENOTSUP`; browsers provide no
raw socket API. HTTP previews and WebSocket relays still use the existing host
bridge. TLS and Unix sockets are outside this adapter.


## Generic runtime job completion

The preview1 `runtime_proc` namespace adds `wait_job(job, flags, status_ptr) -> errno`.
All arguments are i32. Flag `NOHANG = 1` returns `-EAGAIN` (`-6`) while any member is unsafe;
flag 0 blocks. Other flags return `-EINVAL` (`-28`). Success returns 0 and writes the same
**eight-byte little-endian result** as `wait(pid, out)`: `u32 kind` at offset 0 and `i32 value`
at offset 4. Kinds are EXITED=0 (ordinary exit code), SIGNALED=1 (signal number), and
START_FAILED=2 (positive WASI errno). The seven startup errnos are ENOENT=44, EACCES=2,
ENOTDIR=54, ENOEXEC=45, ENOMEM=48, EAGAIN=6 and EIO=29. Actual guest exits 126 and 127
remain EXITED; they never imply startup failure. Request validation, capacity and allocation
failures during admission remain negative returns from `spawn` itself.

A successful job wait reaps the job plus its remaining member process records. `wait(pid,out)`
can only consume a direct child; it does not establish descendant job completion. Both waits
validate all eight output bytes before consuming anything. Bun's asynchronous facade rejects
`exited` on START_FAILED; the synchronous facade throws a spawn error with code and errno.
Node reports error/close instead of spawn/exit for startup failure. Its spawn event follows
successful non-consuming `start_status` observation, independently of output or completion.

Poll subscription **kind 4** means job-empty; its id is the job ID. Subscriptions remain
16 bytes (`u32 kind`, `u32 id`, `u64 userdata`) and events remain 16 bytes (`u64 userdata`,
`u32 kind`, `u32 flags`), all little-endian. Job readiness is level-triggered, non-consuming,
and has flags 0. It can be mixed with readable/writable, child-exit and filesystem subscriptions.
After `wait_job` reaps, both repeated wait and job-empty observation return `-ECHILD` (`-12`),
not another successful completion. An unknown job returns `-ESRCH` (`-71`); a caller outside
the owner's ancestry returns `-EPERM` (`-63`). Owner-chain authority survives intermediate
individual reaping. Blocking wait returns `-EINTR` (`-27`) for a pending handled signal,
without consuming that signal or the job. Invalid memory returns `-EFAULT` (`-21`) before reap.

The first member's status is authoritative even if its direct parent already reaped it, it
exited normally while descendants kept running, or descendants later died from different
signals. Process job identity is immutable: there is no membership-movement operation today.
Spawning into a separate foreground/background job creates an independent lifetime; completed
jobs reject new members, while previously accepted reservations remain counted during admission.
`kill_job` is unchanged and selects only that job's members.

Job-empty follows immutable outcomes, revocation, descriptor release and the quiescence fence
for **every** member. Individual process wait/child-exit confirmation and root `run.done` also
follow their own fence. The supervisor's `quiesce(pid)` hook must finish admitted filesystem
and adapter work (including terminal critical sections); confirmation never waits for physical
worker termination. Shared pending membership includes accepted but not yet admitted spawns;
completion and one-time reaping are atomic with respect to joins and competing host/guest waits. Poll/wait capture their wake sequence before scanning readiness,
so completion racing registration or the scan cannot be lost.
