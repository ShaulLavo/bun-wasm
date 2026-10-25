# Process stdin and Waffle identity

Class **Host feature**. `process_stdin.ts` is an original adapter. No Bun or Node
implementation was copied. It delegates Node stream behavior to the existing
`node:stream` builtin. Reference APIs are `process.stdin` and `stream.Readable`
in Node v26.12.1 and Bun v1.4.4. Waffle's `proc/abi.ts` at
`b20fad173ebaa225cb87c51776f35edaaafd4a40` supplies the existing descriptor read
and readiness contracts.

The reader requests one chunk of at most 65,536 bytes per readiness step. An
EAGAIN result keeps the waiter subscribed to fd 0. A successful read completes
that waiter; Readable requests another read only when it has demand or buffer
space. This lets timers run between chunks and bounds default buffering to the
Readable high water mark. Node's builtin handles pause/resume, encoding across
chunks, readable events, EOF and async iteration.

`ref` and `unref` update the current waiter's loop reference. Explicit pause
releases that reference even if a read is waiting on an empty open pipe. Resume
restores the caller's reference preference without closing or losing input. Destroy removes
that reference immediately, prevents any further read and closes only fd 0 via
Waffle's existing descriptor-close call. A canceled waiter retires at the next
I/O pump without reading or subscribing again. The unrelated synchronous
`readStdin` data native remains for explicit whole-file APIs and CLI input.

The lifetime control also uses the generated guest stream bundle and actual
net I/O waiter core to check pause, resume and explicit ref/unref. Native Node
and Bun children exit after pause/ref with their parent write endpoint open.
These controls are not compiled-guest acceptance.

The source factory controls use the real host Readable implementation with a
scripted descriptor boundary. They do not prove compiled-guest scheduling.
`tests/fixtures/process-stdin` checks real parent/child event and iterator
protocols before EOF, including a timer while the pipe remains open. Its native
manifest enrolls the fixture in all existing guest-engine gates; a source test
or native Bun control is not a substitute for those gates.

| Patch or source | Class | Change |
| --- | --- | --- |
| `process_stdin.ts`, process reader delegation and declarations | Host feature | Original nonblocking Node stdin adapter over Waffle descriptors. |
| Source controls and `process-stdin` fixture | Host feature | Original bounded flow, cancellation and cross-process protocol checks. |
| `scripts/fixtures/process-reader-before.txt` | Host feature | Frozen bun-wasm reader from `114b84c3` used only to preserve the AST guard for unrelated behavior. |

[Ledger scope and pinned revisions](scope.md).

## Assigned process identity

The identity adapter is original Bun host policy, not copied Bun or Node code.
The executor binding is adopted byte-for-byte from the r172 disposable Bun
commit `ec6e030c0cdf52238728da9badf8978e070de742`, based on `114b84c3`.
Waffle `c1cb67c300439af24335d0b2ec481bfb52f79a01` already provides
`RuntimeProcessIdentity` and `WorkerSetupContext.identity`. Its identity and
bootstrap sources match `675eee5` for these contracts. No dependency pin or
version changes belong to this adapter.

`bun_identity.get(i32) -> i32` uses selector 0 for pid, 1 for parentPid, and
returns WASI -28 for an invalid selector. The Rust host import returns these as
`native.procIdentity(): [pid, parentPid]`; both embedded engines and the host
engine use the existing data-native registration. The process factory reads
this pair before constructing the public object. It never reads PID values from
the environment or the physical host. Parent PID is immutable creation ancestry.
Root parent is 0; exiting parents are not replaced by PID1.

The Node fixture provider snapshots the same Waffle transport record through
`createProcessIdentity`. Its import setup sits outside the reserved descriptor
translation block. The Wasmtime launcher has no Waffle process-context identity
provider yet, so the new import is not linked there. Node Workers currently
launch subprocesses and do not share process identity. No PID field was added to
worker environment messages to conceal that gap. Issue199 remains open.

The bootstrap proof runs real Waffle admission and the Bun executor with a tiny
Wasm selector guest. Root71/0, two child-handle matches and distinct siblings,
and child ancestry after root outcome are executable contracts. This is not a
compiled Bun guest or a browser campaign. The native process-identity fixture
adds the full Bun subprocess check to existing guest gates, still pending fresh
compiled acceptance. Thread identity remains an explicit missing runtime
contract, not a falsely passing test.

| Patch or source | Class | Change |
| --- | --- | --- |
| Executor namespaces and Node provider | Host feature | Original Waffle-assigned identity import binding. |
| Rust host import, data native and process properties | Host feature | Original thin identity facade, no allocation. |
| Identity controls and guest fixture | Host feature | Original assigned-pair, bootstrap and handle contracts. |
