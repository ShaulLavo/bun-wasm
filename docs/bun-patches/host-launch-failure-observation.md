# Immediate Bun worker launch failures

Classification: original adapter. No upstream implementation is copied or patched.

`web/src/launch-failure.ts` projects the admitted process context and the existing
Waffle 0.0.126 service and runtime snapshots into bounded scalar facts. The Bun
launcher records these immediately after `service.launchWorker` throws and before
its own cleanup. This is after any rollback performed inside that service call.
It preserves `refusal.cause` separately from the outer error. If cleanup throws,
both error summaries survive and the original cleanup error still propagates.

Attempt order belongs to this loaded `bun-launcher` module instance. It counts
launch call attempts after Bun setup, including call argument evaluation. It is
not group construction order, process creation order or a cross-page sequence.
The telemetry and command identities remain on the enclosing memory snapshot.
Root PID and directory come from the matching `workerMemory()` row, including
when that row falls outside the retained table. Missing fields remain null.

Each API sample has start/end times. Ledger table times describe copying the
single returned ledger snapshot; they are not additional ledger reads. Empty
tables are observed results. Unavailable reads, original row counts, row and PID
truncation are explicit. Text is capped at 192 UTF-16 code units, error messages
at 384 and stacks at 768. Each table retains at most eight rows and 2048 UTF-8
bytes of row JSON. A detached fact is capped at 32768 UTF-8 bytes, with two facts
per telemetry identity. Error accessors and coercion hooks are never called.

Before holder detail truncation, all returned ledger holders contribute to a
fixed set of shape categories and ledger-state counts. The aggregate separates
fixed buffers, growable buffers, request arenas, fixed and growable group
backings, shared guest backings, guest declarations, admission headroom, and
filesystem capacity promises. Shared-guest alias metadata is not another backing.
Declared bytes are ledger accounting. Maximum bytes are sums of explicit shape
lengths or maxima, not measured WebKit cage occupancy. Unknown current lengths
have a separate count. Missing or invalid declared or maximum sizes produce null
sums. Current bytes sum known lengths; `unknownCurrentCount` marks an incomplete
subtotal. Overflow produces a null sum.
Unknown shapes and states are counted, and unavailable differs from observed empty.
The aggregate is detached along with the detail rows and fits the same fact bound.

Ledger state does not identify request-arena pool activity. In the current Waffle
source, retained idle arenas can remain ledger-live. The aggregate reports that
activity as unavailable. Neither ledger insertion order nor these grouped counts
establish constructor order, backing identity across snapshots, fast-slot
assignment, garbage collection, process-wide capacity, or RSS. Guest declarations
and capacity promises are not observations of constructed backing.

These are reconciled API bookkeeping samples, not a native object census,
physical-memory measurement or a historical holder/group join. There is no new
allocator, constructor hook, policy, lifecycle owner, timeout or guest code.
Page-side retention keeps these facts and Browser trap counters when subsequent
worker/channel samples arrive or cleanup marks a record terminal. The goals log
collector saves launch facts for every engine before page disposal using its
existing observation budget and terminal/Angular fallback behavior.

The retained sample time stays with the newest memory observation; marking it
terminal does not create a new memory sample. Delayed older frames cannot replace
newer values or identity. Frames from a different command cannot fill a reused
diagnostic record. Frozen failure facts retain their earlier meaning when
later ordinary samples have no failure. Final logging retains copied launch facts
before waiting for active trap observations, including on budget expiry. A missing
retained hook is unavailable, distinct from a callable hook returning no facts.

The Browser CJS invocation gap is deferred. The frozen guest bootstrap captures
`Reflect.apply` and directly invokes returned wrappers. This change adds no
Browser module observation and requires no guest rebuild.
