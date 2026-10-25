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

`ref` and `unref` update the current waiter's loop reference. Destroy removes
that reference immediately, prevents any further read and closes only fd 0 via
Waffle's existing descriptor-close call. A canceled waiter retires at the next
I/O pump without reading or subscribing again. The unrelated synchronous
`readStdin` data native remains for explicit whole-file APIs and CLI input.

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

[Ledger scope and pinned revisions](scope.md).
