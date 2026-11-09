## Pre-attached shared buffer pool

`web/src/shared-objects/native.ts`, `realm.ts` and the pool parts of `protocol.ts`, `broker.ts`
and `service.ts` are original Browser-engine host adapters. So is the
`ERR_WORKER_MESSAGE_BACKING_NOT_ATTACHED` branch of `MessagePort.#receive` in
`crates/bunwasm-runtime/src/js/worker_threads.ts`. No upstream implementation was copied. The
comparison contract is Bun's `src/js/node/worker_threads.ts` at revision
`9510e74152073d850a18758ca41114d8f214ffa6`, Node's `worker_threads` documentation for
`receiveMessageOnPort`, and the ECMAScript `SharedArrayBuffer` constructor algorithm.

Why it exists: a browser cannot present a new native object to a worker that is blocked in
`Atomics.wait`, because attaching one needs that worker's event loop. A program that posts a fresh
`SharedArrayBuffer` and then notifies a gate its peer is blocked on needs the message synchronously.

What it does, and the limit of what it does:

- Before guest entry, every Browser-engine member receives the same table of native fixed
  `SharedArrayBuffer`s at exact lengths (every multiple of 4 up to 64 bytes, then powers of two up
  to 65,536 bytes) and 32 channel lanes.
- Failure to construct or deliver the startup grant releases the broker lease and fails the launch.
  Startup does not depend on sending an error through the same broken port.
- The guest realm's constructor (a `Proxy` of the native one, installed in `EngineHost.start`
  immediately before the guest bootstrap) hands out one of those buffers when the requested fixed
  length has stock. Its argument coercion and error order follow the specification. Host and Waffle
  allocators use constructors captured when the bundle evaluates.
- These are lifetime quotas for a runtime: a buffer or lane is handed out once and is never
  recycled, so no stale frame, queued snapshot or live guest alias can reach reused storage.
- Everything outside that table takes the existing asynchronous attachment: other exact lengths, a
  requested-growable buffer, a `WebAssembly.Memory` or `Module`, a native clone alias of a stock
  buffer, anything past its quota, and lane-less channels. A synchronous receive of such a
  message throws the named error. The frame stays queued, whole, with every transferred port and
  buffer, and a later event-loop turn delivers it.

This is a bounded capability, not general delivery. The platform has no way to deliver a new
object to a non-yielding agent, and no fixed native `SharedArrayBuffer` of an arbitrary exact
length can alias a pre-attached object. Stock and lane counts have no workload basis yet. Embedded
engines keep their shared directory and are unchanged. See `docs/worker-threads.md`.

`scripts/worker-shared-pool.test.ts` and `scripts/shared-fresh-backing-browser.test.ts` are the
blocking checks.
