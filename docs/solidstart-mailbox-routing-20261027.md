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

The broker allows at most 1,024 clients, 1,024 endpoints and 1,024 deferred ownership registrations. Pending data packets and deferred capacity batches share a global 1,024-entry budget. If a batch needs unavailable queue or registration capacity, its bytes remain in the sender outbox. A full global pending queue still permits direct delivery to a live destination with free mailbox space.

Draining an inbound mailbox sends credit. The broker flushes pending packets in target order and resumes retained outboxes. Source close records have bounded per-service storage, at most 2,048 commands. Broker terminal notifications occupy endpoint state rather than consuming data-queue credit. Outbox drain acknowledgements resume retained terminal records.

Cursor differences use unsigned 32-bit arithmetic across both signed and unsigned wrap. A bad length, invalid cursor distance, or consumer parse exception terminally closes the endpoint. Closed mailboxes report no queued work and cannot replay malformed bytes. Client close removes its ownership records, deferred registrations, outbound storage and originating pending packets.

## Source verification

`checks/web-worker-shared-mailbox.json` owns `scripts/worker-shared-mailbox.test.ts` in the existing web batch. The source tests use real native channels and the real worker factories, codec, host wrapper, service and broker. The native fixture transfers an actual source port and buffer, preserves shared backing aliases, and receives its reply while blocked in `Atomics.wait`, with no intervening timer or native callback.

The focused controls cover full destination credit, full outbox and global pending capacity, owner close, no orphan delivery, local transfer, ordering, exceptions, wrap, malformed frames and cleanup. The existing exact esbuild and inactive startup controls remain adjacent checks. No production guest build or application campaign belongs to this unit.


## Integrated correction after review 274

The five findings at `f680aac7` are corrected as one transaction and lifetime unit. The old source-only proof omitted receiver activation under pressure, unread input during handoff, and post-detachment callback failure.

Receiver delivery validates and reserves all restored bindings before constructing restored ports. A full outbox retains the graph and receive sequence. Actual outbox drain schedules the retry through the installed lifetime wrapper. Failed decoding discards temporary restored objects and cancels their registration. Closing a backpressured receiver releases transferred ownership while preserving already accepted replies.

The broker owns a receipt for each admitted input frame. A receipt records its holder and original accepted sender. Only that holder can acknowledge or return it. Moving an endpoint transfers unread receipts to its current owner with a new token, without asking the old owner to impersonate the sender. A stale token has no effect. This also preserves sequence order when pending data reaches the new mailbox before earlier unread data. Receiver close purges its receipts and expected transferred ownership.

Receipts have a global limit of 8,192 and a limit of eight per holder. Transferring a receipt replaces its old entry instead of requiring another global credit. The ordinary pending queue and deferred capacity batches share 1,024 entries. Deferred batches keep the authenticated source metadata captured before an owner moves or closes. This preserves previously accepted data while allowing a close to release endpoint capacity.

Resource-ready batches can pass blocked registrations directly in the existing eight-slot outbox, including capacity-releasing close and receipt records. A consumed flag in the slot header prevents replay; the read cursor still advances in order. This adds no payload queue. Authorization snapshots are tied to occupied outbox cursors, at most eight per client. They preserve earlier data when priority close retires its source. This path remains live when both the endpoint table and global pending budget are full, including a transferred payload accepted before the close that releases capacity.

There is one fallible precommit notification. Publishing or draining a mailbox changes its atomic revision and wakes the broker through host `Atomics.waitAsync`. All atomic operations used after commit are captured host intrinsics. There is no second JavaScript notification or user callback after publication. Installation rejects a host without atomic-wait support before offering the capability. Inactive defaults remain unchanged. Outbound data batches reserve 50 bytes for the inbound receipt metadata before detachment.

Port attachment cancellation runs before native detachment. The irreversible local commit updates private ref state and captured map operations, without calling public `unref`. Multiple-port rejection tests preserve every source port, buffer and ref count. The native blocked-sender fixture continues to receive its reply without a sender callback or timer.

`checks/web-worker-shared-mailbox-correction.json` adds the unique integrated correction tests to the existing web owner. These tests adapt the owner's original review witnesses and add multiple-transfer rejection, authenticated receipts, cross-owner order, close during activation, and combined-budget liveness. Their implementation is an original adapter; no upstream source or patch was added. Application and frozen-payload acceptance remain outside these source proofs.


## Atomic watch rearm

The watcher observes the revision before invoking its credit callback and waits against that observation afterward. A publication between the callback's final empty check and wait installation changes that revision, so the native wait reports a change instead of sleeping past queued data. A callback's own drain can cause one empty recheck; an unchanged revision then parks the watcher. Cancellation inside the callback and close before rearm prevent another callback. No polling, timer retry or postcommit JavaScript notification participates in this handshake.

A deterministic real-Atomics test reproduces the parent's missed wake on the previous candidate and observes both frames with the corrected subscription. A native producer also publishes during the callback over 512 request/publication handshakes, with ordered values, empty final storage and no callbacks after unwatch. Separate tests cover quiescence, idempotent unwatch, unwatch inside the callback and close before rearm. These extend the same original adapter and existing correction manifest.
