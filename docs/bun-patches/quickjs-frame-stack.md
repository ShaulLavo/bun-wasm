# QuickJS frame stack for ordinary calls

Class **Port**. The upstream source is QuickJS-ng 0.16.2 in rquickjs-sys 0.13.0,
imported at `902364cf9`. The local files are
`third_party/rquickjs-sys/quickjs/quickjs.c` and `quickjs.h`.

Upstream runs every bytecode call in its own C activation of the interpreter.
That activation takes the call's copied arguments, local variables, operand
stack and closure-variable table from its C frame with `alloca`, and calls
itself for each JavaScript call the function makes. On a wasm host the storage
comes out of the shadow stack the stack guard counts
([Wasm stack guards](wasm-stack-guards.md)), and each call adds host frames the
guest cannot see. At the 32 and 36 KiB budgets browsers off V8 get, that had
two effects:

- A function's storage is data, not depth, but it counted as depth. TypeScript's
  library is one wrapper function with 5,278 local variables. Its frame is
  63,316 bytes, more than the whole budget, so `next dev` could not read
  `next.config.ts` on desktop Safari.
- Plain calls stopped at about 113 levels at 36 KiB. Acorn parsing Next's
  client entry holds 152.

This changes the upstream algorithm, which the stack-guard port does not. It
has two parts.

**Frame storage.** An ordinary bytecode call keeps its `JSStackFrame` and its
values in a record on a frame stack the runtime owns, not in the C frame. The
interpreter's C activation no longer grows with the function it runs.

**Inline calls.** When an ordinary record calls an ordinary bytecode function
with one of the call opcodes, the dispatch loop pushes the callee's record and
continues in the same C activation. The call takes no native stack. The
callee's return, tail position or exception continues the calling record where
the C call would have returned.

| Upstream code | Local form |
| --- | --- |
| `JSStackFrame sf_s` and the `alloca` of `JS_CallInternal` | `js_frame_push`, which returns a `JSExecFrame` record with the values behind it, and `js_frame_push_chunk` when the current chunk has no room. `local_buf` is derived from the record. |
| The return at the end of `JS_CallInternal` | `js_frame_pop`, after the frame is unlinked and its values are freed. A record entered inline reloads its caller and continues the loop. |
| Entry code of `JS_CallInternal` after the stack check | The same statements under `enter_frame`, reached from C and from `inline_call`. |
| `JS_CallInternal` at `OP_call0` to `OP_call3`, `OP_call`, `OP_tail_call`, `OP_call_method`, `OP_tail_call_method` | `inline_call` when the caller owns a record and `js_frame_inline_callee` accepts the callee. Otherwise the upstream call. |
| The entry stack check with `alloca_size` | `js_check_stack_overflow(rt, 0)` once per C activation, after a fixed 48-byte reservation. |
| No counterpart | `JS_SetMaxFrameStackSize`, `JS_GetFrameStackUsage` |
| `JSMallocFunctions`, which reports a block's size only after it exists | `JSMallocBoundFunc`, `JS_SetMallocBound`: the allocator states before a request what it can cost. `JS_DefaultMallocBound` and `JS_GetDefaultMallocFunctions` for the default callbacks. |
| `js_def_malloc`, `js_def_calloc`, `js_def_realloc`, `js_def_free` calling libc directly | On Linux, macOS and FreeBSD hosts, a request of at least one frame segment is served from a private mapping of its own. wasm32 keeps libc throughout. |

The emitted bytecode, error messages, error realms, stack traces and interrupt
polling do not change.

## Records and ownership

Records live in segments that never move, because `arguments` objects, closure
variables and a callee's argument vector point into them. A segment is one
block from the runtime's allocator: a request of 65,280 bytes (64 KiB less
256), or the next multiple of 64 KiB less 256 for a record that needs more.
Segments form a stack: a record is popped only when it is the newest, and a
segment goes back to the allocator when its last record leaves. One emptied
default-size segment is kept as a spare so a call at a segment boundary does
not allocate each time. (The code calls a segment a chunk.)

The size follows from how memory is acquired. wasm32 linear memory grows in
64 KiB pages, so any request can cost a page. A 16 KiB chunk charged a page
would fit 64 times in 4 MiB, about 8,600 plain frames, under the 20,685 the
limit has to hold. A request of 64 KiB less 256 leaves the allocator room for
its own header inside one page, so a segment is charged a page and uses nearly
all of it. The 256 is a sizing choice; the charge never depends on it.

Only `js_frame_push` creates a `JSExecFrame`. The native and coroutine
`JSStackFrame` values elsewhere in the engine are never cast to one. A record
stores what the dispatch loop reads from its C parameters, so a calling record
can be resumed after an inline callee: the receiver, `new.target`, the actual
argument count and vector (not the padded formal slots), the realm that made
the call, and the record that entered it. The function is the frame's
`cur_func`. A record that enters an inline callee also stores its operand
stack pointer and the call's shape; its program counter is the frame's
`cur_pc`, as for a C call.

The callee's record is pushed before anything changes, so a refused or failed
push, or an interrupt, is thrown in the calling record with its state intact.
The call's operands stay in the calling record's operand stack until the
callee returns and are released once: by the caller after a normal return, and
with the rest of the frame after a tail call or an exception. A coroutine
frame belongs to its own heap allocation, owns no record, and is never an
inline caller, so its `cur_sp` keeps meaning "suspended at".

## Cost per call

Every call pushes and pops a record, so that step has to be cheap. The guest
is built at `opt-level = "s"`, which does not inline small helpers by itself:
with pushing, popping and the callee test left as calls, call-heavy loops ran
14 to 23 percent slower than before this change. `js_frame_push`,
`js_frame_pop`, `js_frame_record_size` and `js_frame_inline_callee` are
therefore forced inline. What a chunk boundary, a refusal or an emptied chunk
needs stays in `js_frame_push_chunk` and `js_frame_pop_chunk`, out of line.

Before the allocator-bound correction, five paired rounds in the produced
guest on the native launcher had about one percent of spread. Calls between
ordinary functions in a loop were within two percent of the engine before
the change, in either direction. Plain recursion was 8 percent slower, and
callbacks entered from native code (`map`, `reduce`) 12 percent: those pay
for the record without saving a C
call. That remainder is accepted here, not hidden.

## The frame limit

`JS_SetMaxFrameStackSize` bounds what the segments the frame stack holds can
cost their allocator's backing. A call whose record does not fit throws the
same catchable `RangeError: Maximum call stack size exceeded` as the stack
guard, and the engine continues.

The default, and the setter's maximum, is 4 MiB. It was chosen from
measurement: a plain recursive call costs about 121 bytes on wasm32, so 2 MiB
held too few for the 20,685 recorded for the Node host's 6144 KiB budget
before this change. 4 MiB is 64 segments. The wasm32 contract below reaches
34,751 frames of a plain recursive function on the bare engine and fails
under 20,685 ([Stack limits](../stack-limits.md) has the produced guest's
depths).

This is a deliberate resource bound. Before, the native budget bounded
JavaScript depth and frame storage together. Now the native budget bounds
native recursion, and the frame limit bounds how much storage JavaScript calls
may hold, on every host alike.

### What a segment is charged

Upstream's allocator interface cannot say what a request will cost.
`js_malloc_usable_size` answers after the block exists, and only for the
block: not for the page, pool or mapping the allocator had to take to serve
it. Two earlier forms of this limit failed on exactly that. A chunk served as
one cell of QuickJS's own 4 KiB arena left 4,000 bytes behind a count of 216
under a 1,024-byte limit. A 199,968-byte request under a 200,000-byte limit
came back from glibc as a 200,704-byte mapping and was rejected only after it
had been made.

So the allocator declares the cost, before the request, through a
`JSMallocBoundFunc`. For one `js_malloc(opaque, size)` the bound covers,
whichever is larger:

- everything serving the request can make the allocator newly acquire from
  its own source: the block, its header and padding, its bookkeeping wherever
  that is kept, and the whole segment, pool, lease or mapping it may have to
  take, at the granularity it grows by;
- everything the block keeps from other requests while it is held, when it is
  served from storage the allocator already had: the block, and the rest of
  any slab or pool only requests of its kind can use.

The frame stack then keeps a ledger:

1. The charge is added before the allocator is asked, and only when it fits
   what the limit has left (an exact fit fits). If the allocator returns
   nothing, the charge is taken back and no link or count has changed.
2. A segment keeps the charge it was taken under until it is freed.
3. A request the allocator serves from storage it already had is charged in
   full all the same. Two segments may both pay for one shared page. Nothing
   is ever credited back against another segment.
4. A segment goes back through the registered `js_free`. Its charge ends once
   that call has returned. A declaration promises that the storage, with the
   bookkeeping that manages it, is then either returned to the allocator's
   source or part of a heap any later request can be served from. A cache,
   tail or descriptor that stays reserved for the freed block breaks that
   promise, and such an allocator cannot declare.
5. The declaration cannot change while any charge is outstanding, for a
   segment in use or spare, nor while the allocator is being asked for a
   segment or is taking one back. `JS_SetMallocBound` returns -1 then.

What the limit bounds is therefore the backing the held segments account for.
It is not the process's resident size, the total the allocator has ever
acquired, the engine's other allocations, or what an allocator keeps in a
reusable heap, fragmented or not, after segments have gone back to it.

The declaration is the embedder's promise about its own allocator. Nothing in
C can check it. The bound function gets the opaque passed to
`JS_NewRuntime2`, must hold in any state the allocator can be in, and must not
allocate, call into the engine, change the runtime's limits, or be made wrong
by another user of the allocator between the question and the request. When
an allocator reports a usable size above the bound it declared, the block is
freed and the call fails; that catches one kind of wrong declaration and
proves nothing about the others.

A segment is requested directly from the registered `js_malloc`, never as a
cell of QuickJS's small-block arena and without the arena's block header, so
the request the allocator sees is the one its bound was asked about. The
runtime's memory limit, allocation count, `malloc_size` and failure record
apply to it as to any block. An allocator that reports no usable size has the
segment counted by the bytes requested, so it still counts toward the memory
limit.

When a segment's bound does not fit what the limit has left, a block of
exactly the record's size is tried, so an allocator with byte-granular costs
still runs small calls under a small limit. Zero is a valid limit and refuses
every ordinary call. The limit setter refuses a value above its maximum or
below what live frames hold, and releases the idle spare to make a lower
value fit. All sizes are computed with checked arithmetic.

Three outcomes stay distinct:

| Condition | Error |
| --- | --- |
| No declaration, or none for either the segment or the exact-fit block | `InternalError: no allocator block bound for frame storage`, checked before a spare is reused |
| A valid bound that exceeds what the limit has left, also when the smaller fallback has no bound | `RangeError: Maximum call stack size exceeded` |
| The allocator returns no memory, or the runtime's memory limit refuses the block | `InternalError: out of memory` |

### What the default callbacks declare

`JS_NewRuntime` declares `JS_DefaultMallocBound` for its own callbacks.
`JS_NewRuntime2` declares nothing: custom callbacks, rquickjs's `rust-alloc`
and custom allocators included, run no ordinary bytecode call until the
embedder calls `JS_SetMallocBound`. The functions are in both pregenerated
binding files. Callbacks that pass every request, unchanged and one for one,
to `JS_GetDefaultMallocFunctions()` may declare the default bound.

Production uses `rquickjs::Runtime::new` (rquickjs and rquickjs-core 0.13.0,
without `rust-alloc`), which calls `JS_NewRuntime`.

**wasm32, split profile.** The engine module imports `malloc` from the core,
whose libc is wasi-libc `2e6fb9d8ee0c` as Waffle's released builder produces
it: dlmalloc with 16-byte alignment, no `mmap`, no trimming, no exported
`mallopt`, contiguous growth and a granularity of one 64 KiB page. For a
request, `nb = request2size(size) = max(16, align16(size + 4))`, and
`sys_alloc` is entered at most once, only when no free chunk, the designated
victim or the top chunk can serve it. With `TOP_FOOT_SIZE = 8 + 32 + 16` and
`SYS_ALLOC_PADDING = TOP_FOOT_SIZE + 16 = 72`, every path through it asks
`sbrk` for at most `asize = align65536(nb + 72)` in total:

- with no top chunk, one `sbrk(asize)`; the break is page-aligned, so no
  alignment is added;
- with a top chunk, one `sbrk(align65536(nb - top + 72))`, which is no more;
- if that extension comes back somewhere other than the end of the top's
  segment, a supplement of `align65536(nb + 72 - s)` after the first `s`;
  `s` is a multiple of the granularity, so the two sum to `asize`;
- a growth that fails acquires nothing, and the request fails.

The linker's initial heap is memory the module already has. Chunk headers,
segment records and fenceposts are inside the segments. `sbrk` grows this
program's linear memory by exactly the pages asked for, and in this profile
nothing else grows it: one heap, one thread, no `memory.grow` outside libc.
The non-adjacent case and dlmalloc's negative-`sbrk` recovery, which WASI's
`sbrk` cannot perform, are therefore not reachable in it; the bound is not
claimed for a build where they are. A freed chunk coalesces into dlmalloc's
bins, designated victim or top, from which any request is served. Linear
memory never shrinks.

`JS_DefaultMallocBound` returns that `asize`: 65,536 for any request up to
65,452 bytes, so one page for a default segment and `n` pages for a segment
of `n` quanta. No call fits a frame limit under 65,536 bytes on wasm32.

**wasm32, shared-group profile.** The same libc built with
`MORECORE_CONTIGUOUS=0` makes one `sbrk(asize)` per growth and passes it to
the group provider through `runtime_shm.group_grow`. Waffle 0.0.121, source
`6515a313bdc5b6b56491eab6210a3a58b9232224`, grants exactly the requested
pages without speculative leases or unused member remainders. Owner reuse
adds no backing; otherwise growable backing increases by at most the requested
pages. This supplies the acquisition bound at libc's source boundary.

Freed dlmalloc chunks remain reusable by frame and nonframe allocations in
that member. Its heap stays assigned until physical stop, including debt from
a failed stop. Released member ranges return to the owner's zeroed-on-reuse
pool; owner committed backing remains high-water until group teardown. The
fixed profile's startup reservation is separately charged and is not a new
physical acquisition for each logical grant. None of those quantities is
process RSS or a promise that the whole runtime fits the frame limit.
The split measurements below do not qualify a shared-group consumer.

**Linux, macOS, FreeBSD (test hosts).** No bound can be stated for the malloc
of glibc or Apple's libc: top padding, arena heaps, fallback mappings of
1 MiB, huge pages, size-ranged regions, tunables, `mallopt` and replacement
allocators all change what a request acquires. The default callbacks
therefore serve every request of at least one frame segment (65,280 bytes)
from a private anonymous mapping of its own: a 64-byte header, then the block,
rounded up to whole pages. The bound is that length exactly, and `free`
unmaps it. This holds for every large block the default callbacks serve, not
only frame segments. The block keeps malloc's alignment, because the header
is a multiple of `max_align_t`'s; a mapped block is recognised by finding its
header in a list of live mappings, never by reading memory in front of an
address; `calloc`, `realloc` across the threshold in both directions and the
usable size keep their meaning; a failed mapping fails the request and never
falls back to libc. Smaller requests stay with libc and have no bound, as has
every request when the page size cannot be read. The operating system's own
bookkeeping for a mapping is not counted.

**Any other host** declares nothing.

## What stays native

The inline route is deliberately narrow: an ordinary record calling an object
of the ordinary bytecode function class through a call opcode. A class
constructor called without `new` qualifies, and fails in its own bytecode with
the upstream error. Everything else keeps its C call and the native guard:
constructors (`new`, `super`, `Reflect.construct`), `Function.prototype.call`
and `apply`, `eval`, accessors, native functions and their callbacks
(`Array.prototype.map`, `reduce`, `sort`), bound functions, proxies, and
generator and async functions, both as callers and as callees. A recursion
that passes through any of these still costs native stack at every level and
is still refused by the guard.

The C entry reserves 48 shadow-stack bytes, once per C activation, not per
inline call. The frame storage that left the shadow stack was also what made
the budget cover the host frames one C entry costs. Each entry now costs about
128 fewer host bytes but, unreserved, 60 to 100 fewer guarded bytes, so every
native route got more host stack per guarded byte. With 16 bytes reserved the
guard still allowed more `Reflect.construct` levels than the native launcher's
host stack holds at its default budget, and that recursion trapped instead of
throwing; the existing `tests/fixtures/stack-overflow` caught it. That route,
the tightest, needed 28 to 32 bytes to match the build before. 48 is the next
step of the shadow stack's 16-byte alignment and leaves it a little more room
than it had: the guard now refuses `Reflect.construct` with about 15.2 MiB of
the launcher's 16 MiB host stack in use, where the build before used 15.8. On
every measured native route the depth at 32 and 36 KiB is at or above what it
was, and the host stack in use at the refusal is lower
([Stack limits](../stack-limits.md)). This is a fixed accounting compensation
measured on wasmtime, not a browser safety result.

## Checks

`scripts/check-quickjs-frame-stack.ts` builds the bare engine with
`scripts/fixtures/quickjs-frame-stack.c` and runs one contract on several
allocators behind the same callbacks. Each watches the frame stack's blocks
from its own side: what a request made it acquire and what the block
occupies are read from the allocator's sources, never from the bound function
or the engine's count.

- **exact**: a general heap in the fixture that owns its backing and grows a
  byte-granular break. Small and exact limits are checked to the byte.
- **paged**: the same heap growing 64 KiB at a time and never shrinking, as
  wasm32 linear memory does. 64 segments fill 4 MiB exactly, a limit under
  64 KiB refuses every call, and a second run is served from kept storage
  without acquiring any while every segment is still charged in full.
- **default**: the engine's default callbacks. The fixture's own `mmap` and
  `munmap` see every mapping, so each segment's mapping is compared with its
  bound and every mapping is seen to return to the system.
- **sanitizer**, only under AddressSanitizer: libc blocks with a bound that
  makes no accounting claim, so the sanitizer sees every frame block.

On each it checks zero, tiny, exact and refused limits; that the charged count
equals the sum of the bounds declared for the blocks held, within the limit,
and covers what they occupy, also at the deepest point of a chain; that no
block makes the allocator acquire more than was declared; every denied segment
of a deep chain, with nothing charged for it; the smallest limit a call fits
and the refusal one byte under it, where the block that does not fit is priced
and never requested, for a small frame and for a frame of 25,000 locals; the
runtime memory limit stopping a segment; native recursion through a native
function, a constructor, `call`, a generator and a mixed chain; chains 6,000
deep on a 256 KiB native budget for each call shape; the last depth that fits
a small limit and the first that does not; interrupts polled from inline
calls; and a refusal that survives a stack-trace hook. On the exact allocator
it also checks a block larger than its declared bound, zero, understated and
unlimited bounds with their error classes, a withdrawn declaration, and a
declaration that cannot change while a frame or a spare is held or from inside
the allocator's callbacks. Separate runtimes check custom callbacks that
declare nothing, an allocator that reports no block sizes, callbacks over
glibc's malloc, which now run no call and ask malloc for no frame block, and
an unreadable page size. The default callbacks are checked on their own for
alignment, mapping size, `calloc`, `realloc` across the threshold, release,
and a mapping that fails: the request fails, a `realloc` leaves its old block
intact, and a segment is an out-of-memory error with nothing charged.
Both setters are also called after the backing free, during spare trimming
and runtime teardown. They refuse before reading storage that has already
been released. The Linux default-allocator observer counts an unmap only
after the syscall succeeds. An injected unmap failure must terminate the
native process with a fatal diagnostic before the frame charge can be
cleared: the registered void free callback cannot return a release error.

`scripts/check-quickjs-frame-wasi.ts` builds the bare engine with
`scripts/fixtures/quickjs-frame-wasi.c` for wasm32 against the split-profile
sysroot and runs it under wasmtime. It reads the linear memory size around
every request: no request of a 6,000-request sweep over a fragmented heap,
and no frame segment, grows memory by more than its bound; a limit of 65,535
bytes refuses and 65,536 runs; plain recursion reaches at least 20,685 frames
at 4 MiB with the 64 segments charged exactly 4 MiB; and a second run reuses
the freed segments without growing memory.
`scripts/fixtures/quickjs-frame-stack.ts` holds call semantics whose expected
output, `quickjs-frame-stack.expected.txt`, is what the engine printed before
this change: actual and padded arguments, mapped `arguments`, receivers,
`super`, `new.target`, class-call errors and their realm, exceptions and
`finally`, stack traces, generators with forced collection, two contexts and
closures over reused storage.

`tests/fixtures/stack-frame-storage` calls a function with 5,300 captured
locals at 32 and 36 KiB. `tests/fixtures/stack-inline-calls` runs direct,
mutual, method and tail chains 5,000 deep with zero to five arguments at the
same budgets, catches unbounded recursion and recursion through a native
function, and continues. Both run on every engine with one expected output and
set the budgets only where QuickJS's parser compiles the source.

On November 11, 2026, the corrected normal split guest reached 34,746 plain
frames and 34,752 promise callbacks on the native launcher at 32 and 36 KiB
with a 512 KiB host stack, and at its 4096 KiB default. One more raised the
expected RangeError and continued. All 26 maintained recursion inputs and
the supplemental native routes kept their supported safety outcomes, with
no depth below the paired baseline. These are produced-pair measurements,
not the bare-engine depth above or shared-group qualification.

During development the same driver ran under AddressSanitizer and
UndefinedBehaviorSanitizer, and the runtime's embedded modules compiled to
byte-identical bytecode with the engine before the change.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| `quickjs.c`, `quickjs.h`, bytecode call frames | Port | Keep ordinary bytecode frames in a runtime-owned frame stack with a byte limit, and run ordinary-to-ordinary calls without a C call. |
| `quickjs.c`, `quickjs.h`, `JSMallocBoundFunc`, `JS_SetMallocBound`, `js_malloc_block_rt` | Port | Let the allocator declare what a request can cost before it is made, and take each frame segment as one direct request charged that bound. |
| `quickjs.c`, `js_def_malloc` and the other default callbacks, `JS_DefaultMallocBound`, `JS_GetDefaultMallocFunctions` | Port | Declare wasi-libc's dlmalloc growth for the split profile; on Linux, macOS and FreeBSD serve large blocks from private mappings whose cost is exact. |
| `third_party/rquickjs-sys/src/bindings/wasm32-wasip1.rs`, `x86_64-unknown-linux-gnu.rs` | Port | Add the frame-limit and allocator-bound functions to the pregenerated bindings. |
| `scripts/check-quickjs-frame-stack.ts`, `scripts/quickjs-native-check.ts`, `scripts/fixtures/quickjs-frame-stack.c`, `scripts/fixtures/quickjs-frame-stack.ts` | Original adapter | Exercise the frame limit, what allocators acquire and hold against what is charged, allocation failures and call semantics on the bare engine. |
| `scripts/check-quickjs-frame-wasi.ts`, `scripts/fixtures/quickjs-frame-wasi.c` | Original adapter | Compare linear-memory growth with the declared bound on wasm32 under the split-profile libc. |
| `scripts/fixtures/quickjs-async-context.c`, `quickjs-memory-telemetry.c`, `quickjs-parser-stack.c` | Original adapter | Forward their counting callbacks to the default callbacks and declare the default bound, at all four runtime sites. |
| `tests/fixtures/stack-frame-storage`, `tests/fixtures/stack-inline-calls` | Original adapter | Exercise large frames and deep ordinary calls through the guest entry point at the browser budgets. |

[Ledger scope and pinned revisions](scope.md).
