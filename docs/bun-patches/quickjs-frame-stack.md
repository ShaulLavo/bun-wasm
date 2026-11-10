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

The emitted bytecode, error messages, error realms, stack traces and interrupt
polling do not change.

## Records and ownership

Records live in chunks that never move, because `arguments` objects, closure
variables and a callee's argument vector point into them. A chunk holds
16 KiB of records; a record larger than that gets a chunk of its own size.
Chunks form a stack: a record is popped only when it is the newest, and a chunk
is released when its last record leaves. One emptied default-size chunk is kept
as a spare so a call at a chunk boundary does not allocate each time.

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

Measured in the produced guest on the native launcher, five paired rounds
with about one percent of spread: calls between ordinary functions in a loop
are within two percent of the engine before the change, in either direction.
Plain recursion is 8 percent slower, and callbacks entered from native code
(`map`, `reduce`) 12 percent: those pay for the record without saving a C
call. That remainder is accepted here, not hidden.

## The frame limit

`JS_SetMaxFrameStackSize` bounds the bytes the frame stack costs the
allocator: every chunk's usable size plus the allocator's block header, so
chunk headers, alignment, unused tails and the spare are all counted. A call
whose record does not fit throws the same catchable
`RangeError: Maximum call stack size exceeded` as the stack guard, and the
engine continues. A failed chunk allocation throws out of memory instead.

Zero is a valid limit and refuses every ordinary call. When a default chunk no
longer fits the remaining budget, the remainder is offered as an exact-fit
chunk, so a small limit still runs small calls. The setter refuses a value
above its maximum or below what live frames hold, and releases the idle spare
to make a lower value fit. Record sizes are computed with checked arithmetic.

The default, and the setter's maximum, is 4 MiB. It was chosen from
measurement: a plain recursive call costs about 121 bytes on wasm32, so 2 MiB
held 17,343 of them. That is more than the 13,786 the native launcher's
4096 KiB budget allowed before this change, but fewer than the 20,685 recorded
for the Node host's 6144 KiB. 4 MiB holds 34,721, measured, which keeps both
([Stack limits](../stack-limits.md) has the measured depths).

This is a deliberate resource bound. Before, the native budget bounded
JavaScript depth and frame storage together. Now the native budget bounds
native recursion, and the frame limit bounds how much storage JavaScript calls
may hold, on every host alike.

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
`scripts/fixtures/quickjs-frame-stack.c`. It checks zero, tiny, exact and
refused limits, that the committed count equals what the allocator holds, every
denied chunk allocation of a deep chain, native recursion through a native
function, a constructor, `call`, a generator and a mixed chain, chains 6,000
deep on a 256 KiB native budget for each call shape, the last depth that fits a
small limit and the first that does not, interrupts polled from inline calls,
and a refusal that survives a stack-trace hook.
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

During development the same driver ran under AddressSanitizer and
UndefinedBehaviorSanitizer, and the runtime's embedded modules compiled to
byte-identical bytecode with the engine before the change.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| `quickjs.c`, `quickjs.h`, bytecode call frames | Port | Keep ordinary bytecode frames in a runtime-owned frame stack with a byte limit, and run ordinary-to-ordinary calls without a C call. |
| `scripts/check-quickjs-frame-stack.ts`, `scripts/quickjs-native-check.ts`, `scripts/fixtures/quickjs-frame-stack.c`, `scripts/fixtures/quickjs-frame-stack.ts` | Original adapter | Exercise the frame limit, accounting, allocation failures and call semantics on the bare engine. |
| `tests/fixtures/stack-frame-storage`, `tests/fixtures/stack-inline-calls` | Original adapter | Exercise large frames and deep ordinary calls through the guest entry point at the browser budgets. |

[Ledger scope and pinned revisions](scope.md).
