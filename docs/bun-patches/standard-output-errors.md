## Standard output errors

Class **Host feature**, **original adapters** in `crates/bunwasm-runtime/src/lib.rs`,
`src/natives.rs`, `src/js/spawn.ts`, `src/js/{process,web}.js`, `web/scripts/node-host.ts`,
`web/scripts/node-stdio.ts`, `web/src/{bun-executor,worker}.ts`, and
`crates/bunwasm-host/src/process/{mod,pipe,stdio}.rs`, and its original `net/error.rs` error record.
No Bun or Node implementation is copied or adapted for this change.
Rust output natives return write errors with Node-style `EPIPE`, errno `-32`, and
syscall `write`. The synchronous process writers emit their stream's `error` event.
Failed writes in one batch share the first error object and one stream error event.
All pending write callbacks receive that error on the next tick. The event runs
after ticks scheduled by those callbacks. During failure and callbacks, `writable`
is false; it resets to true before their ticks and the event. `destroyed` stays false,
matching Node v26.7.0's standard-stream reset. A later failure starts a new batch.
An unhandled error ends the guest with status 1. A listener can handle the error.
The Node WASI adapter waits only for temporary `EAGAIN` backpressure and returns
WASI `PIPE` for closed output. Worker child adapters preserve the same error and
close inherited output transports when their downstream reader disappears.
The minimal readable stream invokes its underlying cancellation callback so
canceling a subprocess reader actually closes its pipe.
Native child pipes attach the OS `EPIPE` number to their error. Wasmtime 39.0.2
translates an `ErrorKind::BrokenPipe` without an OS errno to generic WASI `IO`.
Child exit closes its owned stdin reader. Native and worker stdin write errors
retain `code`, `errno`, and `syscall` through the public Bun and Node writers.
Worker hosts retain each pipe's error until the handle is closed, so unrelated
network errors cannot replace it on either the engine or WASI-slot bridge.
The native cancellation wrapper delegates the underlying WASI output stream
instead of wrapping inherited stdio in Wasmtime's asynchronous output queue.
That queue becomes permanently closed after EPIPE and returns generic EIO on
later writes. Direct delegation preserves EPIPE for later batches and retains
cancellation while waiting for child-pipe capacity. No Wasmtime code is copied.

The browser's top-level stdout and stderr write to a terminal through messages,
so they have no OS reader that can close. Browser child pipes do have readers;
the real-browser subprocess check cancels those readers on all three engines.
The regression fixtures and Python OS-pipe driver are original test code.
The driver checks QuickJS and JSC under both the native launcher and Node's
worker host, plus the host engine under Node.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [Standard output error adapters](#standard-output-errors) | Host feature | Original Rust and worker adapters preserve EPIPE and block on temporary output backpressure. |
