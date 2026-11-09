# Worker large messages

Status: Approved. Independent plan review completed with three bounded corrections, applied by the parent. The early workload gate below precedes the full implementation investment.

Date: November 9, 2026. Design branch: `design/worker-large-messages`.
Parent and only reporting recipient: `mcp:launch:af0b9e1bccb194425523c944af9f581d1766031aa9d73c3597fffbf7276328a1`.

## Caller usage comes first

Ordinary worker code keeps its current API. No Angular override, public configuration, new async send API, or application retry loop is added.

```ts
source.postMessage("before");
source.postMessage({ text, buffer, port }, [buffer, port]);
source.postMessage("after");
Atomics.notify(signal, 0);
```

When the middle send succeeds, all its encoded bytes are committed before `postMessage` returns. A receiver already holding this channel's lifetime lane can wake from `Atomics.wait` and synchronously receive these three messages in order. ArrayBuffers detach once and carried ports move once. This guarantee concerns transport bytes and already-attached graph backings, not arbitrary new public SAB attachment.

A send can still throw `DataCloneError` before transfers detach. Admission is bounded by the encoded frame cap, an occupied overflow slot, the inline descriptor ring, the shared growth budget, host capability, and native allocation success. A synchronous caller never receives success for an incompletely published message. `receiveMessageOnPort` never treats a committed but incomplete or invalid frame as an empty queue.

The required ownership sequence is:

```ts
source.postMessage("before");
source.postMessage(largeA);
source.postMessage("after");
const moved = transferReadingEndpointWithoutPumpingItsLane(target, nextOwner);
expect(nextOwner.receive(moved)).toEqual("before");
expect(nextOwner.receive(moved)).toEqual(largeA);
expect(nextOwner.receive(moved)).toEqual("after");
source.postMessage(largeB);
expect(nextOwner.receive(moved)).toEqual(largeB);
source.close();
expectCloseOnceAfterDrain(moved);
```

These are test-fixture operations around the existing codec, not proposed public functions. Before A is copied, a second large send on that direction rejects. After copy credit, B reuses the same slot. A small `after` does not need that slot and can follow A immediately.

## Grounding and evidence

The entire research report is `/work/reports/goals/astro-angular/large-message/RESULT.md`. The starting checkpoint is `20c7a95bcc9c0c27c4352130286f8f35e75f7b83`. It contains three intentionally red maintained-runtime tests and passing native Node and Bun controls. Fetched `origin/main` is `e69f2afb3286abd832773fbc6d64f2f8e7b6cbe5`, already an ancestor of that checkpoint. `git merge origin/main` reported already up to date. No source rebase or force push is needed.

Angular's actual encoded payload size is unknown. The evidence proves only that it exceeds 1,048,572 bytes. The 2,097,279-byte encoded text control and base64-expanded 800 KiB ArrayBuffer are synthetic. They must not become framework measurements.

The production path is:

1. `worker_threads.ts` prepares `{ data, ports }` with `worker_codec.ts`. Codec preparation validates the transfer list, snapshots ports, and stages native references without detaching.
2. `SharedObjectService.routes.transaction` stages moving-port custody and reserves the route outbox. `MessagePort.#stagePacket` reserves the lane before native detach. Failed reservation aborts publication. Codec finish then detaches buffers and moves endpoints. The lane cursor commits after finish and `state.sent` advances last.
3. Each lane is a pair of SPSC rings. Side `s` reads ring `s` and writes ring `1 - s`. One committed frame is complete. Each direction has 1 MiB of bytes, with a four-byte length header. The maximum ordinary inline encoded frame is 1,048,572 bytes.
4. Lane drain copies and decodes bytes into the port's sequence-indexed pending graphs. `#acceptNext` accepts only `received`. Graph backing waits preserve that sequence. A snapshot carries the queue, pending graphs, and lane. Moving stops the old watch without closing the lane.
5. Broker route-owner versions, delivery receipts, and `toward` custody already keep carried endpoints alive when their sender exits. Local close discards unread graphs. Peer close waits behind lane data, even if its terminal takes the broker. Service exit leaves committed outbox records readable before route retirement.

The pool has 32 lifetime lanes and 672 bounded fresh fixed buffers. PR 560 pre-attaches that stock before guest entry. It does not make arbitrary native SAB publication synchronous. Namespace PR 552 is unrelated; this plan neither depends on it nor changes its native files.

The Chrome source prototype pre-attaches a zero-byte growable SAB, then grows it while the receiver is blocked. After a real wake, the receiver sees `before, large, after`, exact codec text, and empty-after-drain. This proves growth visibility without another attachment event. It does not prove slot reuse, transfer rollback, endpoint movement, or closure. Chrome's TextDecoder rejected a GSAB-backed input view. Copy to an ordinary fixed Uint8Array before decoding.

Sources for existing ownership rationale are `docs/concepts/architecture.md`, `docs/bun-patches/user-shared-objects.md`, lane ownership comments, and the tests at the checkpoint. This checkpoint changes no crate boundary or native engine API. The supplied report and source are sufficient for this bounded decision; no new candidate bakeoff, external account search, Angular install, or framework qualification was performed.

## Candidate decision

| Candidate | Counterexample or cost | Decision |
| --- | --- | --- |
| Increase every inline ring to 4 or 8 MiB | Still an arbitrary cap with no measured Angular length. The 32-lane grant becomes about 256 or 512 MiB before overflow needs are known. Node page-touch measurements confirm the eventual resident cost. | Reject eager ring growth. |
| New ordinary SAB per large message plus descriptor | Receiver blocks in `Atomics.wait`; native attachment callbacks cannot run. A descriptor is visible but its body is not synchronously available. Retention also spends the process's 1,024-object allowance. | Reject for complete post-before-notify delivery. |
| One pre-attached growable slot per lane direction | Complete bytes can precede descriptor commit without another native attachment. A second unread large send is a deliberate bounded rejection. Growth cannot be undone or shrunk. | Select, subject to independent plan review and the lifecycle gates below. |

The legacy pipe adapter is not a usable larger lane. Its separate 64 MiB accumulated-text guard and queued writes do not give complete synchronous post-return visibility. The eight-slot, roughly 8 KiB route mailbox is custody transport, not body storage. Do not redirect large data through either path, disable shared routes, or add chunk reassembly.

A single slot is sufficient to preserve correctness for admitted sends. It does not establish native burst parity. The concrete counterexample is `post(largeA); post(largeB); notify()` while the receiver stays blocked. A succeeds, B fails before detach, even with spare growth budget. Increasing B's cap cannot fix that case. If the real Angular trace requires it, this shape is insufficient for that workload. Stop that implementation unit and redesign by reusing a bounded SPSC byte-ring queue in the pre-attached growable backing, not a generic shared allocator. Do not conceal the rejection with retry, yielding, or delayed publication.

## Private types and module changes

Only the adapter knows slots. Application values never contain them. Keep public `SharedReference` identity and exact fixed-length checks unchanged. In particular, do not encode a private GSAB as a public `shared` graph node with a length that becomes stale after growth.

```ts
type LaneSide = 0 | 1;
type LaneBacking = Readonly<{
	buffer: SharedArrayBuffer;
	poolIndex: number | null;
}>;
type PortLane = LaneBacking & Readonly<{ side: LaneSide }>;
type Reservation = { commit(): void; abort(): void };
type SlotPair = readonly [SharedArrayBuffer, SharedArrayBuffer];
type OverflowGrant = Readonly<{ slots: readonly SlotPair[] }>;
interface SharedPoolGrant {
	readonly control: SharedArrayBuffer;
	readonly stock: readonly (readonly SharedArrayBuffer[])[];
	readonly lanes: readonly SharedArrayBuffer[];
	readonly overflow: OverflowGrant | null;
}
interface SharedLanes {
	create(): LaneBacking;
	open(backing: LaneBacking, side: LaneSide): SharedLane;
}
```

`poolIndex` is null for the existing non-pool inline lane path. For an index, service opening verifies that `backing.buffer === pool.lanes[index]`. The codec resolves the ordinary fixed `pool/lN` reference through the receiver's own validated grant first, so wrapper identity is local and stable. Slots are `pool.overflow.slots[index][destinationSide]`. There is no new identity map, lookup by public MessagePort ID, native per-message publication, or slot reference in a message graph. Lifetime lane index and side are enough.

The new grant field is always present, including null on an inline-only host. This is one current protocol, not negotiation with an old version. A lane-bearing port node carries mandatory `poolIndex: number | null` alongside `side`. A node without a lane carries neither field. Update the codec's object encoder, `validPortNode`, hydration/restore, declarations, and all fixture type consumers together. Snapshot pending graphs already own copied text, so they require no slot pointers.

| Path | Exact responsibility |
| --- | --- |
| `web/src/shared-objects/native.ts` | Capture native constructor, byteLength, growable, maxByteLength getters and grow method before guest installation. Construct private GSABs and call only captured methods. Missing growable getters must not break fixed-buffer detection. |
| `web/src/shared-objects/lane.ts` | Keep `createSharedLaneBuffer()` and inline-only low-level opening. Extend opening with trusted private overflow views. Own frame tags, slot state, admission errors, grow reservation, copy credit, and close flags. Export private policy/layout constants for protocol consumers without a protocol import cycle. |
| `web/src/shared-objects/protocol.ts` | Extend and validate `SharedPoolGrant`, control layout, exact 32 pairs, GSAB capabilities, and counters. Change private `SharedLanes` shape. No change to ordinary shared-reference equality rules. |
| `web/src/shared-objects/broker.ts` | Lazily create one pool including all slot handles and send it before entry. Add idempotent begin-disposal that publishes the shared barrier before client retirement, rejects new admission, and still permits committed-outbox draining. Final disposal invokes it and drops references only after retirement. No second endpoint registry. |
| `web/src/shared-objects/runtime.ts` | The actual installation close entry point begins shared-pool disposal before its first route or lease closes. Preserve individual service close and committed-outbox draining. Repeated installation close is harmless; add no automatic Waffle disposal integration. |
| `web/src/shared-objects/service.ts` | Claim a lifetime lane index with the existing saturating cursor. Return backing plus index. Resolve overflow by validated index at open. Unpooled lanes retain inline-only behavior. Preserve publication abort and route transaction behavior. |
| `web/src/shared-objects/host.ts` | Forward backing and side with active-host guards, preserve lane watch/wake wrapping, and guard reserve/drain on retained lane wrappers after service or engine closure. |
| `crates/bunwasm-runtime/src/js/worker_protocol.d.ts` | Update `PortLane`, `SharedObjects.lanes`, and lane-bearing WorkerNode metadata. Keep signatures aligned with host types. |
| `crates/bunwasm-runtime/src/js/worker_codec.ts` | Carry and validate pool index in port graph metadata and restore the complete private lane descriptor. No GSAB public graph type. |
| `crates/bunwasm-runtime/src/js/worker_threads.ts` | Use the new lane backing in ensure/open/snapshot. Keep one sequence stream and staged frame commit. Distinguish busy overflow from full inline-ring admission without calling either an oversized frame. |
| `scripts/fixtures/shared-objects/runtime-types.d.ts`, `source-runtime.ts`, `broker-clients.ts` | Update every fixture constructor and private signature, with narrow deterministic native capability/grow failure injection only where needed. Keep runtime-types importing authoritative declarations rather than duplicating the protocol. |
| `scripts/fixtures/shared-objects/sync-reply-worker.ts` | Update its real-worker open wrapper to accept the complete LaneBacking descriptor and preserve its close-control behavior and existing blocking owner. |
| `scripts/worker-shared-pool.test.ts` | Add mandatory overflow to complete grant fixtures. Treat lanes.create() as a descriptor: use its buffer explicitly for publication, low-level opening and byte-length checks, preserving lifetime-quota assertions. |
| `docs/worker-threads.md`, `docs/bun-patches/user-shared-objects.md` | Document bounded admission, private original-adapter changes, host limits, and unchanged fresh-backing limitations. Do not append to the stable ledger entrypoint. |
| `docs/bun-patches/original-adapter-shared-buffer-pool.md` | Update this specific existing owner for native constructor, pre-entry grant and pool-adapter changes alongside the general ownership record. |

`SharedLane.reserve(text): Reservation | null` stays the deep private operation. It owns inline/overflow selection and every byte reservation. Null still means insufficient inline ring space or an existing local reservation. Busy slot and other overflow admission failures throw explanatory DataCloneError. The codec and application do not coordinate slot operations. All preparation helpers below are internal to that operation, not exposed stages for callers.

## Admission and memory policy

The first implementation uses these private constants, subject to the review gate:

- Keep 1 MiB inline rings and their current 1,048,572-byte encoded inline maximum.
- Maximum overflow frame: 64 MiB of UTF-8 encoded lane packet, inclusive. This applies to the entire `{ kind, sequence, graph }` envelope, not the input string or raw buffer. It adopts the existing adapter family's 64 MiB guard scale, not a synthetic 2 MiB example. The legacy guard counts text differently, so this is an explicit new policy, not exact legacy parity.
- One initially zero-byte GSAB for each of 64 directions. Native maximum is 64 MiB each. No eager payload pages. Fixed slot metadata lives in the existing pool control SAB.
- Runtime-wide overflow growth budget: 128 MiB. This admits two directions at the full per-frame ceiling, or several smaller directions, without permitting every direction to reach 64 MiB. It is an admission bound on backing lengths, not a measured Angular working set or a total JS heap limit.
- Grow to `ceil(encodedLength / 65536) * 65536`, never geometrically beyond that. The target cannot exceed 64 MiB. Charge the target minus current native byteLength. Reuse at or below the existing high-water length costs zero even when the runtime budget is full.

The 64 MiB ceiling is intended to admit ordinary multi-megabyte traffic well beyond the old 1 MiB boundary. It is not proof that an unmeasured Angular message fits. The 128 MiB budget has a concrete two-maximum-direction rationale, but its mobile suitability remains unqualified. No public tuning is justified by a current caller.

`sharedPoolControlWords` changes from 27 to 221. Keep the first 27 quota cursors, then add a charged-byte counter and a runtime-disposed flag, followed by three Int32 words per slot for state, generation, and encoded length. With overflow disabled, retain this same fixed control layout and leave slot words unused. Initial fixed control backing rises from 108 to 884 bytes. Slot index is `laneIndex * 2 + destinationSide`. Small-message startup still grants the existing 67,109,888 lane bytes and 2,112,512 stock bytes, plus 884 control bytes. It does not commit 128 MiB of overflow eagerly.

Measured Node v26.12.1 evidence in `lane-memory.log` is separate from browser evidence. The existing pool totals 69,222,508 backing bytes. The allocation experiment's 64 zero-length GSABs with a 64 MiB maximum reserved 4,096 MiB of virtual address space. Initial RSS did not increase in that run; growing and touching one 4 MiB slot added 3.94 MiB RSS. Node's `arrayBuffers` counter omitted growable bytes. Neither that counter nor zero initial RSS establishes a memory budget.

The proposed 64 GSABs also permit 4 GiB of aggregate virtual maximum, even though committed lengths are capped at 128 MiB. The Node observation supports that calculation, not browser reservation or iPhone RSS. Chrome evidence establishes only attached growth, exact bytes, and blocked-worker visibility for one slot. There are no Chrome RSS measurements or iPhone RSS claims here. Transient JSON strings, base64, encoder buffers, receiver copies, and decoded values remain additional allocations.

Before calling the policy suitable for the target workload, the later execution lane must record actual encoded lengths and per-direction maximum simultaneous unread large messages during the unchanged Angular command. Run one bounded cold pass and one warm pass, not another candidate exploration. Check the admitted high-water total and cap headroom. If a real maximum approaches the cap, select a cap at least 10 to 15 percent above that maximum, round to 64 KiB, recalculate all 64 virtual reservations, and review the changed policy. Do not silently raise it in the caller. If unread burst depth exceeds one, changing a size constant is not a remedy. Native Node, real Chrome, and target mobile allocation observations must stay separate. An allocation or workload failure is a result, not permission to claim parity or drop a platform.

## Reflection and ordering limits

Application-visible SABs keep native brand, byteLength, maxByteLength, growable, and fixed-buffer grow rejection. The existing guest constructor proxy and bounded allocation quotas remain observable policies, not perfect native allocation transparency. `web/src/shared-objects/realm.ts` needs no new public grow behavior or getter shim. Host slot allocation uses the captured native constructor and never consumes guest fresh-buffer stock. Private slots are not returned from a guest SAB constructor, included in a decoded message, or registered as public shared references.

A native structuredClone alias of a pooled fixed buffer still falls outside that wrapper's pool identity, as the existing pool alias test specifies. Do not add an identity map to conceal this. A new public growable SAB, a fixed allocation outside admitted stock, or an unpooled lane can still need the receiver's native attachment event and raise `ERR_WORKER_MESSAGE_BACKING_NOT_ATTACHED`. Overflow changes none of those reflection or readiness limits.

There is only per-port order, not a global order across ports. A descriptor cannot bypass a preceding graph waiting for a public attachment. Copy credit can return before that graph decodes, but the existing pending map still withholds following sequences. A lane beyond the 32-lane lifetime pool has no pre-attached overflow pair, so a large send there explicitly rejects before detach even on a GSAB-capable host. That is a lifetime admission boundary, not a reason to create new asynchronously attached overflow storage.

## Slot framing and state

The existing ring remains the single order stream. A normal frame's first little-endian u32 is its inline byte length. Reserve `0xffffffff` as the overflow tag. An overflow entry is exactly 12 ring bytes: tag, generation u32, encoded byte length u32. There is no inline graph body, slot ID, or separate message sequence in that descriptor. Its ring direction identifies the only possible slot; the copied packet still contains the normal sequence number.

Read the tag before ordinary length alignment. A normal length beyond the inline maximum is invalid, not an overflow descriptor. Descriptor fields can wrap through the existing ring copy helpers. Validate 12 available bytes before reading them. Reject any corrupted cursor distance, tag, truncated descriptor, mismatched generation, non-published phase, non-overflow length, length above cap, mismatched metadata length, or length above native current capacity. A malformed committed frame throws and terminates that lane rather than returning undefined, advancing past it, or exposing later messages.

Low phase bits are `EMPTY`, `RESERVED`, `PUBLISHED`, and `COPYING`. A monotonic `CLOSED` bit is orthogonal to phase. Terminal closure never clears. All transitions preserve that bit. The runtime-disposed flag independently rejects all new admissions.

| From | Actor and operation | To and visibility |
| --- | --- | --- |
| EMPTY | Sole producer claims by CAS after inline descriptor admission | RESERVED. No ring cursor or notification changes. |
| RESERVED | Producer increments generation, reserves growth budget, grows if needed, fills bytes and metadata | RESERVED. Invisible, even after growth. |
| RESERVED | Any preparation, route reservation, or native detach fails | EMPTY with the close bit preserved. Descriptor aborts. Successful growth remains charged. |
| RESERVED | Transfer finalization succeeds | PUBLISHED, then ring write-cursor commit, then signal increment and notify. |
| PUBLISHED | Sole reader validates descriptor and claims copy | COPYING. Producer cannot reuse. |
| COPYING | Reader obtains fixed bytes and decodes UTF-8 | Advance inline read cursor, then EMPTY with close bit preserved. Only now is credit returned. |
| COPYING | Recoverable copy or text allocation fails | Restore PUBLISHED without advancing cursor, generation, bytes or credit, preserving CLOSED. Throw explicitly. |
| COPYING | Malformed UTF-8 or an internal consume/JSON/pending-insertion failure | Persist an explicit terminal lane error. Later receives throw that error rather than looking empty or exposing following sequences; credit may already have returned after a valid fixed copy. |
| Any phase | Explicit receiver close or runtime disposal | Set CLOSED. Do not steal a producer reservation or an active reader copy. Never admit another send on this slot. |

A generation starts at zero. Each successful EMPTY-to-RESERVED claim consumes the next generation, including aborted attempts. Generation zero is never a published descriptor. Reject exhaustion before detach at `0xffffffff`; do not wrap into ABA. A new endpoint owner reads generation from shared control, not a stale snapshot; interpret its Int32 storage as unsigned when comparing with u32 descriptor fields. Slot reuse is within this direction only. Neither closed lanes nor their slots can become another channel.

Closure does not reclaim backing bytes or make the slot reusable. A closed slot can retain an unread PUBLISHED phase until disposal; no object is allocated per retained message. Already closed flags make later descriptors discard-only, never a reason to resume a reader. Existing broker endpoint retirement discards carried-port custody when the destination is explicitly closed. Do not parse unread slot graphs just to reclaim bytes.

## Reserve, abort, and commit ordering

Keep the current codec transaction. There must be no allocation, encoding, grow, graph validation, user callback, host capability lookup, or fallible route reservation in the final lane commit after native detach.

The internal pseudocode is:

```ts
function reserve(text: string): Reservation | null {
	assertActiveAndOpen();
	const bytes = encoder.encode(text);
	if (bytes.length <= inlineLimit) return reserveInline(bytes);
	assertOverflowCapabilityAndFrameLimit(bytes.length);
	const ring = reserveDescriptorSpace(12);
	if (!ring) return null;
	return prepareOverflowOrAbort(ring, bytes);
}

function prepareOverflowOrAbort(ring: RingReservation, bytes: Uint8Array): Reservation {
	try {
		claimEmptySlotAndNextGeneration();
		growWithinSharedBudget(bytes.length);
		writeSlotAndDescriptor(ring, bytes);
		return preparedReservation(ring);
	} catch (error) {
		abortOwnedSlotIfClaimed();
		ring.abort();
		throw error;
	}
}
```

Before entering native transfer finalization, codec validation and the service transaction must have reserved all route records. Lane reservation has already checked cap, descriptor capacity, slot credit, budget, native growth, views, and bytes. Existing final transfer validation stays before native detach. A pre-detach close observation rejects while the transfers remain attached.

After successful native detach and port moves, commit changes RESERVED to PUBLISHED without clearing CLOSED, commits the descriptor cursor, and notifies. `state.sent` advances exactly once after that commit. `commit()` and `abort()` are idempotent local token settlements. An aborted token can never publish, and abort after commit cannot retract delivery. An aborted ring frame never consumes sequence or leaves a notification for a phantom message.

A close that races after admission is not a post-detach exception. Commit remains nonthrowing and publishes the accepted frame even if the slot acquired CLOSED meanwhile. A live peer receives messages before its peer terminal. An explicitly closed receiver discards the accepted message and carried custody, as it already does for inline sends. There is no claim that such a race restores detached buffers. The slot is never reusable after that close.

Do not enlarge the existing claim about transaction atomicity. Native detachment is assumed to reject before changing the transfer group in the tested failure control. A host that partially detaches and then throws cannot be repaired by a byte slot. Arbitrary process termination halfway through native transfer or route movement remains outside the current adapter's distributed-transaction guarantee. Record that limitation in the classified adapter record.

## Shared high-water accounting

The counter is shared by every worker in the one Runtime, not one counter per service or lane. Per-slot high-water is its captured native byteLength, not current unread length. Sole-writer ownership lasts across endpoint moves.

```ts
function chargeGrowth(delta: number): void {
	if (delta === 0) return;
	for (;;) {
		const used = Atomics.load(budget, chargedWord);
		if (runtimeDisposed()) throw disposedError();
		if (delta > budgetBytes - used) throw budgetError();
		if (Atomics.compareExchange(budget, chargedWord, used, used + delta) === used) return;
	}
}
```

This CAS loop retries only a changed accounting word. It never waits for credit, yields to another event loop, retries a send, or retries native grow. Busy/full/budget admission fails synchronously. Ordinary small-message sends do not touch the growth CAS.

After charging delta, call the captured native grow once. If it succeeds, the charge is irrevocable until runtime disposal, even if a subsequent view allocation, outbox reservation, or native detach rejects. Zero a slot's unread length on abort, not its capacity charge. Returning receive credit also does not refund growth.

If native grow throws, inspect captured native byteLength. Refund only the reserved bytes that did not become backing length, with `Atomics.sub`. A normal native rejection leaves the old length and refunds all delta. If a test double reports failure after successful growth, retain that actual increase and abort the message. Never subtract another worker's charge. Unexpected capacity outside the reserved target is a protocol failure and closes the service; do not continue with an understated counter. Validate arithmetic and counter range at grant acceptance and before charge. Values here fit signed Int32 without wrap.

CAS charging precedes growth, so simultaneous reservations cannot exceed 128 MiB of promised backing. In-flight promises conservatively occupy the budget until growth succeeds or fails. A sender killed between charge and grow can strand a conservative charge. Do not refund it from process exit without proof that no grow occurred. This design has no lease-recovery allocator. The bound still holds, but later growth can fail until Runtime disposal. Closed channels also keep their high-water charge. These are intentional lifetime-policy limitations and need deterministic controls.

## Reader copy and endpoint lifecycle

The descriptor's committed write cursor is the publication barrier for all slot bytes and metadata. The receiver reads that cursor atomically, validates the descriptor, and claims PUBLISHED-to-COPYING. A still-open reader never observes RESERVED behind a committed descriptor. That is a protocol error, not readiness to wait for. It allocates one ordinary fixed Uint8Array of the exact encoded length and copies the entire GSAB view. It decodes that ordinary copy with fatal UTF-8 decoding. No graph or pending-message entry retains a mutable slot view.

Only after the fixed copy and text exist does it advance the inline read cursor and return slot credit. Returning credit means phase EMPTY, not an asynchronous broker acknowledgment. Every phase update uses compare-exchange while preserving CLOSED, including copy failure and abort. A close can change that bit once during a transition; it cannot make a phase owner lose its claim. Another send can then overwrite the slot without affecting text or graphs already queued. `consume(text)` runs after credit; the runtime's existing pending sequence map owns that string's parsed graph. This also avoids reserving the slot across route-registration or native graph-attachment waits.

Move cases preserve the existing ownership model:

- Unread A stays in its original slot and descriptor ring when the reading endpoint moves. `#prepare` must not opportunistically pump or drain it. The old owner stops watching, with no close flag or credit. The new snapshot carries the same fixed lane reference, pool index, side, queue, pending map, and sequence counters. Its pre-entry grant already contains the slot pair. Only the new owner copies A and returns credit.
- If A was copied before the move, the snapshot carries owned pending graph or decoded queue data. The slot is already credited. B can coexist with that snapshot without corrupting A. Validate both schedules.
- Moving the writing endpoint hands over the same outbound generation and high-water capacity in shared control. The old endpoint is detached and cannot reserve again. A successfully completed synchronous `postMessage` cannot leave an in-process reservation for the move to inherit.
- A carried port inside A uses existing codec transfer plans and broker `toward` custody. The slot is only bytes. It does not become a second custody record. On sender exit, drain committed outbox movement records before retirement, as today. The broker's pool retains backing after sender service exit. A live destination can copy A, restore the carried port once, and use it.
- Sender exit or `source.close()` must not set CLOSED on the destination's inbound slot containing committed A. Peer terminal follows the lane sequence. Broker terminal handling drains lane frames first and `#maybeClose` waits for queued delivery. No close event can overtake A or occur twice.
- Explicit `target.close()` linearizes inbound closure in `#beginClose` before the API returns: stop delivery, mark its inbound ring and corresponding slot CLOSED, cancel graph attachment waits, and drop queued or pending graphs. Keep the outbound lane handle until the existing ordered terminal is published; do not close the peer's inbound slot holding A. It does not return usable slot credit. Broker retirement settles any unread carried endpoints through existing custody. Source sends observed after closure reject or follow the existing already-disconnected no-op path without detaching.
- Service close is not Runtime disposal. It must not close every lane in the shared pool, because endpoints can be in another process or in transit. Preserve the existing closeClient drain and holder rules. A stranded slot remains charged and cannot migrate into a new channel.
- The actual `installRuntimeSharedObjects(...).close()` entry point must invoke idempotent broker begin-disposal before its first route/lease retirement. Begin-disposal publishes the shared disposed barrier, marks pooled rings and slots closed, and wakes watches, while preserving internal draining of already committed outbox records. Final broker disposal also begins this barrier when called directly, then retires clients and releases references. Individual route/service close does not begin Runtime disposal. Retained host lane wrappers fail active checks. Reserve and drain also observe the shared disposed flag, so a worker blocked before native close notification cannot keep using its old pool. Disposal throws the existing closed-service error rather than reporting an empty receive. No late grant, move, or canceled wait revives the Runtime. Physical memory and virtual reservation release depends on final native aliases and GC, not merely the counter reset. Never reset a live pool for reuse.

## Unsupported host capability and validation

Probe the captured native constructor and getters during pool creation, before ready. Create all 64 zero-byte GSABs with 64 MiB maxima. Validate actual native growable/maxByteLength properties. If capability is absent or this complete allocation cannot be established, drop partial private handles and set the new overflow field to null. Still deliver the fixed lane and bounded stock grant and run existing small-message paths unchanged. Never try a fixed 64 MiB substitute per slot.

On such a host, messages within the inline limit keep the existing behavior. A larger lane message throws DataCloneError saying that large-message overflow is unavailable before detach. This is a host-capability branch, not old-version compatibility and not a platform drop. Do not throw at small-message startup because a growable getter is missing. A particular later native grow failure rejects only that send; it does not silently disable working small messages or retry on another transport.

Grant validation checks fixed control size, stock shapes, 32 fixed lane buffers, exact slot count and pair shape, GSAB brand, native maximum, aligned current lengths within maximum, distinct private backings, generation range, legal phase bits, and the charged-byte range. Validate shape at the native protocol boundary without relying on `instanceof` from a replaced guest constructor. A late-joining worker may receive already-grown, published, or closed slots. Do not demand zero lengths or EMPTY states at every attachment. Concurrent growth means a receiver cannot demand an equality snapshot between the global charge and a sum of 64 byteLength reads. Charge may also include an in-flight promise or conservative stranded reservation.

Distinct backing allocation is a trusted broker construction invariant. Reject duplicate wrappers, but do not claim JavaScript reference equality detects aliases made by separately cloning a SAB. Preserve the existing public clone-alias limitation.

The service accepts one grant and validates lane index, side, and local fixed-buffer identity before handing trusted views to lane code. Malformed grants fail readiness explicitly. Malformed lane metadata or descriptors fail delivery explicitly. No new public identity caches, empty-receive fallbacks, package tests disabled for unsupported hosts, or runtime polling loops are introduced.

## Verification gates and retained red policy

No production test is run as a proof of this unimplemented design. Existing red and passing evidence stays intact. One independent Sol review requested three bounded amendments; the parent applied them without commissioning a second round. This is a corrected plan, not implementation acceptance.

Gate 0A is the cheapest available observation through the owning Angular workload before production work: record exact rejected encoded byte length, direction and lifetime lane index at the real reservation boundary, with an executable small-message/observer positive control. A trace ending at the first rejection cannot prove burst compatibility. Reuse a retained runnable workload if one exists; do not reinstall Angular merely to repeat the synthetic investigation. Prior cleanup removed the old installed project, profiles and servers, so absence of a runnable workload must be recorded, not disguised as measured compatibility.

At the first matching Browser guest/host artifact, restore the maintained workload only as an execution prerequisite and run its unchanged command. After the minimal safe slice passes focused source controls and one real blocked-worker smoke, this exploratory Angular run precedes the exhaustive matrix. Record attempted encoded lengths and lane/direction, send/copy-credit boundaries, slot-busy admissions, lane-pool exhaustion and committed high-water. If no matching artifact exists yet, the prerequisite is a minimal matching Browser build from this implementation, not a new native-engine project. Existing native workload captures may disqualify the one-slot shape cheaply, but cannot prove browser scheduling. Stop this shape on a real unread-large burst; redesign the bounded queue, never hide it with retries or yields. Later cold/warm qualification stays separate.

The implementation must satisfy these named gates:

1. **Low-level inline contract.** Keep `scripts/worker-channel-lane.test.ts`'s direct `openSharedLane` oversized rejection and full/wrap/invisible-reservation assertions unchanged. Add slot-level framing, generation mismatch/exhaustion, descriptor wrap, reserved invisibility, copy allocation failure, and close-race controls in `scripts/worker-large-message.test.ts` or a new feature-owned `scripts/worker-lane-overflow.test.ts`.
2. **Runtime admission policy.** Deliberately replace only the old runtime test named `a message larger than the lane is rejected before anything detaches`. Replace it with encoded-cap boundary success and cap-plus-one rejection, disabled-overflow rejection, busy-slot rejection, full descriptor ring rejection, runtime budget rejection, native-grow rejection, and native-detach rejection. Each rejection checks an attached buffer, an independently usable source port, unchanged send sequence, no phantom delivery, and no staged publication. Never skip or delete this policy test to obtain green.
3. **Maintained source regressions.** All three source tests at checkpoint 20c7a95 pass through real production factories. Retain positive native Node and Bun controls unchanged. Add the exact hard sequence `before, A, after`, unread endpoint move, new-owner copy, credit, B reuse, and one close. Prove slot non-reuse before copy using its shared state, not just timing.
4. **Failure and lifetime matrix.** Cover busy A with rejected B, later B success after copy, full ring with a descriptor that cannot fit, budget saturation across different directions, successful reuse at full budget, failed grow with complete rollback, successful grow followed by route-outbox or detach rejection with retained charge, conservative stranded charge, sender exit with carried port, explicit unread receiver close, move after copy, move of writer, late pool joining after growth, repeated close/dispose, and closure at RESERVED/PUBLISHED/COPYING. Exercise actual installation.close(): at the first client-retirement hook, retained peer wrappers already reject inline reserve and drain by the shared disposed flag. Add persistent terminal-error controls after malformed UTF-8 or consume/JSON insertion failures. Use narrow deterministic fixture interleavings, not timing sleeps as evidence. Check broker pending routes, custody registrations, attachments, and close counts.
5. **Existing source suites.** Run lane, pool, startup, codec, shared objects, attachment lifetime, mailbox, mailbox correction, and sync-reply suites. Type-check root scripts and web/runtime projects with their actual dependency prerequisites, plus focused lint. Check discovery must still pass. This detects every consumer of the changed private signature. Preserve checks/web-worker-sync-reply.json and checks/web-worker-shared-pool.json. Await both validated grants before overflow fixture lane allocation; retain a separate explicit unpooled control.
6. **Real Chrome blocked-worker transport.** Retain `chrome-slot-prototype.log` as the original fact. Promote or adapt the private `chrome-source.ts` and `chrome-program.ts` controller to exercise production overflow, not a hand-built substitute slot. Require its 64 KiB prerequisite, actual `Atomics.wait === "ok"`, one waiter woken, exact UTF-8/buffer content, before/after order, empty-after-drain, carried-port reply, and a second wake proving reuse. Add movement and failure controls without claiming the old prototype proved them. Source Chrome evidence is not a Wasm guest result.
7. **Built-guest browser contract.** Add `scripts/worker-large-message-browser.test.ts` and `checks/browser-guest-worker-large-message.json`, following `scripts/shared-fresh-backing-browser.test.ts` and the `browser-guest` owner. Reuse the same-commit guest site producer via `scripts/browser-guest-site.ts` and `BUN_WASM_BROWSER_SITE`; do not rebuild it per check. Run actual browser-engine guest workers on Chromium and WebKit. If a tested host lacks GSAB, its explicit inline-only control remains blocking; the large-success gate must run on a proven capable host, not be silently skipped. Keep capability results distinct.
8. **Runtime and integration regression.** Existing worker fixtures run QuickJS, JSC, and browser engine gates because shared worker graph metadata changed. Reuse existing artifacts and manifests. Do not change native engine code or JSC stack limits to make them pass. Only after the earlier exploratory workload checkpoint, qualify the unchanged Angular command with cold and warm passes, recording real lengths, burst depth, outcome and high-water. An Angular failure remains a failure; synthetic greens do not qualify it.

Candidate implementation check commands, all after `source env.sh`, include:

```sh
bun test scripts/worker-large-message.test.ts scripts/worker-channel-lane.test.ts
bun test scripts/worker-shared-pool.test.ts scripts/worker-shared-startup.test.ts
bun test scripts/worker-codec.test.ts scripts/worker-shared-objects.test.ts
bun test scripts/worker-shared-attachment-lifetime.test.ts
bun test scripts/worker-shared-mailbox.test.ts scripts/worker-shared-mailbox-correction.test.ts
bun test scripts/worker-sync-reply.test.ts scripts/test-checks.test.ts
bun scripts/test-checks.ts browser-guest --list
```

Use existing manifests `checks/web-worker-large-message.json`, `checks/web-worker-channel-lane.json`, and the current source-suite owners. Add a new manifest only for a new maintained test file. No workflow command-list, package script, package/version, lockfile version, goals matrix, native engine, stack-budget, or Waffle pin edits belong in this unit. Update the owning classified record for changed original adapters. Add no GitHub issue and no plan-only PR.

## Execution boundary, risks, and cost

Throughput checkpoint:

- Blocking first steps: apply the completed review corrections, take the cheapest available existing-workload observation, then assign one owner to the minimal safe slice. Run its focused controls and one real Chrome blocked-worker smoke, perform the early unchanged Angular check at the first matching artifact, and only then complete exhaustive verification.
- Independent workstreams: not applicable inside this design-only child. The data path, grant, and codec signature form one coupled implementation unit. Native positive controls can run alongside its focused source tests under the runner's scheduling.
- Shared mutable state: two SPSC roles per direction; runtime-wide CAS growth budget; monotonic lifetime lane cursor. No pooled channel reuse, new shared checkout, or parallel source writers.
- Smallest safe decomposition: one owner implements private grants, byte framing, and snapshot signatures together, with source lifecycle controls. A follow-on verification unit adds the built-guest check after source behavior works. The plan accompanies that feature PR, never a standalone documentation PR.

First implementation unit estimate: 1.5 to 2.5 agent hours, plus 0.5 to 1 agent hour for focused real-worker gates and independent source review. It includes no Angular installation or guest rebuild. Replace estimates with actual time when completed. The previous research used about 0.54 agent hours. This design checkpoint targets 0.5 to 0.75 agent hours, not another broad investigation.

The difficult parts are preserving close flags across commit/copy, changing every port snapshot consumer, and proving that failure after growth refunds no committed bytes. The GSAB visibility fact is already proven in Chrome. Slot lifecycle remains unimplemented. Two review or execution rounds without meaningful progress stop for the parent to reassess payoff.

Accepted tradeoffs are explicit synchronous busy rejection, a 64 MiB encoded ceiling, lifetime high-water retention, possible conservative budget stranding on abrupt termination, 4 GiB aggregate virtual maximum, and no arbitrary fresh-SAB readiness guarantee. A one-slot transport can remove the measured size boundary yet still fail an Angular burst. That is the main workload risk, not a claim deferred to a comment in code.

The domain-modeling principle selects an explicit state machine. The laziness principle keeps the current ring and custody protocol instead of adding allocator/reassembly or a second route. Boundary discipline keeps native validation outside public message graphs. Prove It Works requires the unread move/reuse sequence and real blocked workers before any claim of delivery parity. Architect parallel exploration and further probes are deliberately omitted here because the supplied three-candidate research is complete and this child is forbidden to launch agents.

## Checkpoint cleanup and handoff

This child owns no test dependencies, browser profiles, listeners, services, remote sessions, containers, or scratch probes. It uses only its T3-assigned checkout. The only deliverables are this locally committed plan and compact audit evidence in `/work/reports/goals/astro-angular/large-message/design/`. Keep the assigned checkout clean for the parent's reviewer. The parent owns removal of the retained audit directory and eventual checkout retirement after the feature lands or this checkpoint is superseded.

The parent applied plan-review corrections for disposal entry ordering, complete fixture/ownership inventory and early workload sequencing. Preserve intentionally red tests until behavior changes and fold this corrected plan into the feature's normal independent source-review path. No PR, merge, watch, source force push, or production edit is part of this checkpoint.
