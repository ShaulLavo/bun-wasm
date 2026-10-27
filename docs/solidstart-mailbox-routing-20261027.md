# Synchronous source-port routing

Status: Approved implementation unit. Application acceptance remains parent-owned.

## Provenance

| Classification | Inputs | Local implementation |
| --- | --- | --- |
| Original adapter | bun-wasm `a145d02013c5020888c7ef63910f63636c52cc64`, PR 266 `ff97e6fb7f7d1d6a2fbd1d89a3861728c4934053`, retained `solidstart/review266-stop/wip-files/` | Transactional mailbox routing, host capability installation, transfer publication and lifecycle tests. No new upstream patch or copied Bun, Node, or WebKit implementation. |

The retained mailbox code supplied the unsigned cursor arithmetic, terminal malformed-frame policy, host wrapper, and credit direction. Its worker pump rerouted incoming deliveries through ownership state. Its outbound drain could discard a frame when the global pending budget filled. This implementation replaces those parts and integrates source-port transfer publication with one durable reservation.

## Installation and delivery

`createBunExecutor.setup()` already exports the private service when the runtime explicitly supplies `sharedObjects`. `EngineHost.valueNatives()` already calls `bindSharedObjectHost()`, and bootstrap takes `native.sharedObjects` into the worker factory. The wrapper now carries the mailbox and route methods and enables that installed capability. A bare service keeps routes disabled. An uninstalled worker keeps its existing channel path.

Active port IDs include the service owner. The broker tracks endpoint versions and ownership. A restored binding that arrives before its moving record waits in a bounded registration map. Incoming mailbox packets enter the worker's direct delivery function. They use the existing native `utf8Decode` ABI, without constructing a guest `TextDecoder`.

## Transfer transaction

The codec validates transfers and publishes shared backing references. It stages moving records and the delivery callback in one route batch. The service reserves an invisible outbox slot and checks notification admission before native buffer detachment. The codec validates again, detaches buffers, and commits local port ownership. Only then does the service publish the outbox cursor.

A full or oversized reservation, a retired destination, a publication failure, a delivery exception, a notification exception, or a native detachment failure aborts before publishing route bytes. Tests verify source ownership and buffer attachment on these failure paths. Committing a plan twice fails. A local transfer reserves its moving and restored binding together, including when only one slot remains.

Acceptance means durable ownership by the bounded outbox or broker queue. Closing a client cancels its accepted outstanding work. It cannot promise delivery after destination termination. A known retired destination rejects later sends before detachment.

## Bounds and credit

Each direction has eight slots of 8,192 bytes, including a four-byte frame header. The backing is 65,552 bytes. The maximum encoded frame is 8,188 bytes. Both directions keep stable backing identities.

The broker allows at most 1,024 clients, 1,024 endpoints, 1,024 deferred registrations, and 1,024 pending data packets. If a batch needs unavailable queue or registration capacity, its bytes remain in the sender outbox. A full global pending queue still permits direct delivery to a live destination with free mailbox space.

Draining an inbound mailbox sends credit. The broker flushes pending packets in target order and resumes retained outboxes. Source close records have bounded per-service storage, at most 2,048 commands. Broker terminal notifications occupy endpoint state rather than consuming data-queue credit. Outbox drain acknowledgements resume retained terminal records.

Cursor differences use unsigned 32-bit arithmetic across both signed and unsigned wrap. A bad length, invalid cursor distance, or consumer parse exception terminally closes the endpoint. Closed mailboxes report no queued work and cannot replay malformed bytes. Client close removes its ownership records, deferred registrations, outbound storage and originating pending packets.

## Source verification

`checks/web-worker-shared-mailbox.json` owns `scripts/worker-shared-mailbox.test.ts` in the existing web batch. The source tests use real native channels and the real worker factories, codec, host wrapper, service and broker. The native fixture transfers an actual source port and buffer, preserves shared backing aliases, and receives its reply while blocked in `Atomics.wait`, with no intervening timer or native callback.

The focused controls cover full destination credit, full outbox and global pending capacity, owner close, no orphan delivery, local transfer, ordering, exceptions, wrap, malformed frames and cleanup. The existing exact esbuild and inactive startup controls remain adjacent checks. No production guest build or application campaign belongs to this unit.
