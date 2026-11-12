# Shared-group MessagePort lanes

Classification: original runtime adapter. No upstream implementation was copied. Node's and
Bun's `worker_threads` semantics are the behavior reference; the Browser engine's own lane
(`web/src/shared-objects/lane.ts`) is the protocol reference for frame order, close records and
custody, and none of its code is reused.

## Files

- `crates/bunwasm-runtime/src/wasm/lane.rs`: the lane format and algorithm, written against two
  small traits (`Memory`, `Host`) so its unit tests (`lane/tests.rs`) run the same code on a fake
  group that follows both hosts' region, pin, release and group-end rules.
- `crates/bunwasm-runtime/src/wasm.rs`: registers the `wasm.lane*` natives in shared-group builds.
- `crates/bunwasm-runtime/src/js/worker_lane.ts`: wraps the natives as `sharedObjects.groupLanes`.
- `crates/bunwasm-runtime/src/js/bootstrap.js`: installs `groupLanes` in the shared-group service.
- `crates/bunwasm-runtime/src/js/worker_threads.ts`, `worker_codec.ts`, `worker_protocol.d.ts`:
  ports use a group lane when the service has one.
- `crates/bunwasm-runtime/src/data.rs`, `ops.rs`, `ops/abi.rs`, `natives.rs`, `split.rs` and
  `crates/bunwasm-engine-quickjs/src/client.rs`, `natives.rs`, `driver.rs`: word natives, the
  call path the lane's effects use (below). The engine files are the ones every split engine
  compiles, so QuickJS, JSC, SpiderMonkey and Hermes all bind word natives the same way.
- `crates/bunwasm-engine-quickjs/src/transfer.rs`, included by `value_natives.rs`: the
  transfer native that commits a staged message ("Staged commit" below).

## Imports

The core imports `runtime_shm.shm_create`, `shm_attach`, `shm_detach`, `shm_pin`, `shm_unpin` and
`shm_route_group`. The last is new in both hosts: it hands a pin the caller owns to its group,
which then holds it until the group ends, and any launched member may unpin it. The native
launcher's operation is in `crates/bunwasm-host/src/shm.rs`; Waffle provides the same operation
from the release that carries it. There is no fallback for a host without it. The lane imports no
`runtime_proc.getpid` and makes no `runtime_nested` call.

## Format

- Ledger: one group-pinned 128 KiB region per group, created by the group's first member before it
  reserves a worker and passed to every worker in `BUNWASM_WORKER_INIT`. A 256-byte header, 512
  lane slots of 128 bytes and 2,040 small slots of 32 bytes (spill segments and worker cells).
- Every slot starts with an aligned 64-bit claim word: the claimant's member tag in the high half,
  then a 28-bit generation and a 4-bit phase. A tag is a 4-byte region the member holds for life;
  the host frees it at member release, so a failed `shm_attach` on a tag means that member is gone.
  Claiming, cleaning and freeing are compare-and-swap on the whole word, so the claimant is never a
  separate write. Generations never repeat and refuse before they would wrap.
- Each lane slot also holds, per side, a 64-bit end word (owner tag, 28-bit epoch, state), a
  64-bit version word naming the open epoch it was recorded for, and the custody of an end in
  flight; per direction, reader-closed, the writer fence, severed and armed. Severed and armed hold
  the lane generation. Epochs are not reset when a slot is reused.
- Lane region: magic and version, a 32-byte block per direction (write, read, tail, cursor) and two
  65,472-byte rings. Ring cursors run modulo twice the ring size. Records are a length word and
  UTF-8 bytes, or a 16-byte descriptor naming a spill segment by slot and generation.
- Segment region: magic, capacity, committed, next, sealed and read, then length-prefixed frames up
  to 64 MiB each.

## Word natives

A data native crosses the bridge in allocated buffers: the engine allocates and encodes a
request, the core copies the frame, decodes the arguments, runs the native, then allocates and
encodes a reply. Each of those allocations is checked, and a failed one reaches JavaScript as a
catchable error. A failure before the native runs is a refusal. A failure after it ran is not: the
effect happened and the caller was told it did not.

A word native has no such step. Its arguments are up to eight unsigned 32-bit words and its
result one signed 64-bit number, which JavaScript reads as a number.

- The engine allocates one 48-byte frame at startup (`CoreClient::new`) and keeps it for life.
  A call writes the operation, the session and the words into it, enters `bun_core_dispatch`
  and reads the result from it. The transport tells a word frame from a data frame by its size.
- The core reads the frame in place, runs the native and writes the result back
  (`ops/abi.rs`, `word`). The transport allocates, encodes and decodes nothing on either side,
  and there is no resource-limit status. A wrong session or operation is a broken engine and
  ends the guest.
- This is a statement about the transport, not about every byte an engine touches. QuickJS
  passes and returns immediate numbers. JSC's callback wrapper still builds an argument vector
  and protects its values, and SpiderMonkey roots a handle for the argument and the result.
  None of those is a checked allocation, so none can come back as a catchable resource limit.
- A word native must not call back into the engine: the one frame is in use for the length of
  the call. The lane and pipe natives call only the core and the host.
- A word native that can be refused returns -1 and keeps the reason, which `laneRefusal` reads.
- The core export list and the linker inputs are unchanged. A core and an engine side still have
  to come from the same source, as before: the description the core sends now lists word natives.

Every lane native that changes group memory is a word native, and so are the read-only ones
the close and retire paths call. Two natives carry text and stay data natives:

- `laneReserve` stages a frame under the name of its end (slot, generation, side), not under an
  id in its reply. If the reply is lost, `worker_lane.ts` aborts by the same end. Staging again
  abandons an earlier frame first, and an end that moves or closes takes its frame with it.
- `laneDrain` keeps the frames it read until `laneDrained` says JavaScript has them. A call
  whose reply was lost returns the same frames again. This costs one extra copy of the drained
  frames while the call is in progress. An end holding such frames refuses to transfer, since
  they are in neither the lane nor the port's snapshot.

`laneLedger` and `laneJoin` are data natives too; a repeated `laneLedger` returns what the first
stored, and a failed `laneJoin` ends the starting worker.

The broker's record that a port is moving, and the wake hint, go to the control pipe after
buffers detach, so that write follows the same rule (`worker_channel.ts`, `natives.rs`):

- A frame is queued as text and encoded when its first write is tried. A failed encode leaves it
  queued.
- `procWriteOnce` writes like `procWrite` and keeps its result under its attempt: the
  descriptor and a token. If the call throws on its way back, the word native
  `procWriteResult` returns that result for the same attempt, or says it never ran. A frame
  is therefore written once, whole and in order.
- The core keeps one last attempt for the whole guest, so a token names one attempt of the
  guest, not of a channel. The channel module counts them across every channel it opens and
  never reuses one (53 bits, passed to the word native as two words).
- A flush never throws for a call the bridge could not carry. The frame stays queued and the
  pipe's writable subscription brings the next attempt.

The host engine (`engine_host.rs`) has one bridge, so it registers word natives as ordinary
natives. The runtime JavaScript calls them the same way on every engine.

### Staged commit

The core and the engine side can publish a message, its ports and its detached buffers in
one native call. The runtime JavaScript does not use this yet: `postMessage` still runs the
sequence under "Rules" below, and moves to this call in the change that follows.

- `laneStageEnd(sender end, carried end)` adds a port end to the frame staged under the
  sender end and returns the epoch it will have in flight. Nothing moves and nothing in group
  memory changes. It is refused unless this member holds the end open, with no frames read
  and not yet taken, and with epochs left for the move and its terminal transitions.
- `laneCommitCheck(sender end, nonce high, nonce low)` checks everything the commit relies
  on: the frame is staged, each end it names is still this member's at the epoch it was
  added at, and the nonce is in range. It is the last call that can refuse.
- `laneCommitStaged`, with the same words, moves each named end into the custody of the
  frame's reader, publishes the frame, and records the nonce. It allocates nothing, calls no
  host function and cannot refuse. A member that dies inside it leaves the message absent or
  whole: ends that already moved wait with the frame's reader and close when it does.
- `laneCommitted()` returns the last recorded nonce doubled, plus one when the reader was
  due a wake, and 0 before any commit. A nonce is at most 2^52 - 1, so the word is at most
  2^53 - 1 and reaches JavaScript as an exact number.
- The engine side's `transferArrayBuffers(buffers, slot, generation, side, nonceHigh,
  nonceLow, makeError)` (`crates/bunwasm-engine-quickjs/src/transfer.rs`, compiled into
  every split engine) admits its arguments exactly, roots every buffer, makes its result,
  runs the engine's detach predicate on every buffer and then `laneCommitCheck`. Only then
  does it detach, call `laneCommitStaged` and return the value it already made. It keeps one
  more reference to everything it was given until `transferSettled()` or its next call, so
  the engine's release of its arguments on return never drops a last reference. With only a
  buffer list it validates, detaches and returns, for the callers that have no lane.

`lane/tests.rs` covers the refusals, a replaced plan, and a sender killed before each memory
access of the commit. The engine crate's tests run the native on QuickJS with a recording
stand-in for the core.

### Engine exceptions between detachment and return

Word natives remove the native bridge's own failures. The JavaScript around them can still be
interrupted by an exception the engine raises itself. Two kinds are catchable:

- Stack exhaustion. Measured on a shared-group QuickJS guest on the native launcher: a
  `postMessage` that transfers an ArrayBuffer, with and without a carried port, called from
  every stack depth around the limit, with the sender on the group's first guest and in a
  worker, at 4096 KiB and 36 KiB budgets. In 59,520 attempts every call either threw with the
  buffer attached, the port still local and nothing received, or returned with the whole
  message received. The reason is the order of work: the deepest point of the call is reached
  while the message is prepared and staged, before anything detaches, and what follows
  detachment is a loop over the carried ports, not a recursion. A control that overflows on
  purpose after a finished post is reported by the same probe. This has not been measured on
  JSC or SpiderMonkey guests.
- Heap exhaustion that QuickJS reports as a catchable error. After detachment the runtime still
  creates a few small objects and one control frame. An allocation failure exactly there, after
  the larger allocations of preparing and staging succeeded and were freed, has not been
  produced or ruled out.

Ending a guest is not catchable and follows the death rules.

## Rules

- Staging may allocate and call the host, and refuses with `DataCloneError` before detachment.
  Commit is stores only, with no allocation, and one publication point: the ring cursor, a
  segment's committed or next word, or the ring cursor after sealing. Between detachment and
  the return of `postMessage` the only native calls are word natives: the transfer of each
  carried end, then the frame's commit.
- A terminal end (Closed, or ClosedDead after an exit report) is reader-closed by its end word.
  A close, cascade, death declaration or release therefore writes nothing after its terminal
  swap except generation-checked swaps, and nothing counts dead ends but their end words. A
  transfer reserves the epochs its terminal transitions need; a slot whose epochs run out is
  never used again.
- Sweeps, which may call the group owner, run only on an event-loop step, never inside a
  synchronous receive. After its sweep the root retires broker records whose lane end a
  cascade or release closed, and closes their peers. It rescans when the sum of all end epochs
  changed. An end's epoch rises in the store that changes its state, so a closure needs no
  second write to be noticed, and a member that dies right after closing an end has still
  announced it. A full sweep also returns a lane whose finalizer died between its terminal swap
  and the lane's release. A worker's exit runs this housekeeping on its own turn of the loop,
  which is not inside a receive: an otherwise idle root takes no later step.
- Receiving is atomic loads, stores and copies on group memory. It validates every cursor, length,
  slot and address before use and closes the direction on corruption, never writing through an
  address that failed validation. The failure is reported once: later reads of a direction
  whose reader has stopped say the lane is over, and the port closes.
- A failed drain in an event-loop step does not stop the step or the loop. The other ports,
  the mailbox, the control channels and the housekeeping are still served, then the first
  failure is thrown as the thread's uncaught error. The loop drops a waiter whose step threw,
  so the worker waiter puts itself back: it is the only thing that pumps the thread's lanes
  and channels.
- A slot that names a pin is handed to the group only after the ledger names the pin. Cleaning
  keeps the slot exclusive until unpin settles; a later member recovers a dead cleaner's slot and
  accepts only "bad pin" as already absent.
- Storage a guest may still touch is freed only after that guest gave it up while running or the
  host released it. An exit report closes a guest's ends logically and waits for the release.

## Tests

`lane/tests.rs` covers every commit store against a concurrent reader, aborts and refusals, wrap
of the non-power-of-two period, spill chains and reuse with no host call, role handover, the
custody cascade against adoption, the writer fence, exit reports before release, retained
members, death at every creation host step, dead cleaners, two concurrent sweepers, group pins
surviving the first member and a two-thread writer and reader. It also parks a death declaration,
and one of two finalizers, before each of its memory accesses while another guest frees and
reuses the slot, and checks near-limit epochs. It kills a finalizer before each of its memory
accesses and checks that a closed end has always changed the epoch sum and that the next full
sweep leaves no lane behind. It covers a staged frame and a drained batch whose replies were
lost. `ops/tests.rs` and `ops/memory_tests.rs` run a word call on a transport that can allocate
nothing, beside a data call that fails there, and measure that it allocates nothing.
`scripts/worker-group-lanes.test.ts` runs the real runtime JavaScript, `worker_lane.ts`
included, over relay-mode Waffle pipes with a small model of the native contract, as a codec
and topology control. Its model can fail a data native before or after it ran, and names the
natives called after detachment. `scripts/worker-codec.test.ts` fails the control pipe's write
and its encoding the same way.

`tests/fixtures/shared-wasm-memory/group-lane.ts` and `group-lane-lifetime.ts` run on a real
shared-group guest. The lifetime fixture starts 200 workers in turn, which takes about 100
seconds on the native launcher at roughly half a second per worker start.
