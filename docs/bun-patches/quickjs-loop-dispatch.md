# QuickJS getter dispatch and builtin loop continuations

Class **Port**. Upstream is QuickJS-ng 0.16.2 in rquickjs-sys 0.13.0,
imported at `902364cf9`. The adapted implementation is
`third_party/rquickjs-sys/quickjs/quickjs.c`.

`Function.prototype.call` forwards ordinary bytecode targets within the running
interpreter. A continuation record preserves the original builtin object, its
realm and its native stack frame while the target executes. Bound, proxy,
native, generator and async targets retain upstream dispatch. Replaced builtins
also retain their own dispatch. Arbitrary C calls never suspend C activations.

Ordinary records return to either another ordinary record or a continuation.
Their return shape counts the caller operands to release after success. Throws
leave those operands for the existing unwinder. C entries have no resume record,
even when a continuation is already linked. Coroutine frames retain their
separate ownership and return path.

CALL borrows its target, receiver and writable argument slots from the creating
record's operands. Zero actual arguments use a NULL vector. Formal padding and
closing captured arguments use ordinary bytecode entry and teardown. A native
continuation frame exposes actual arguments without native-length padding;
native frame readers must not index that vector. Stack and CallSite readers use
the original builtin object and frame linkage.

The continuation initializes its owned result before linking. Its step consumes
the target's owned return value or exception signal. One final disposer moves
and clears the result, unlinks the native frame and pops storage. The pending
exception object remains owned by the runtime. Allocation and interrupt refusals
take the same return path and allow subsequent calls to run.

The ordinary header stays 104 bytes on wasm32 and 168 bytes on x86_64. Record
kind and function ownership occupy existing padding. Continuation allocation
rounds its actual structure's tail up to value slots, with compile-time layout,
alignment and containment assertions. With reduce state the continuation is
208 bytes on wasm32 and 352 bytes on x86_64, allocated as 208 and 360 bytes.
Budgets, backing limits and native entry reservations are unchanged.

Ordinary JavaScript getters selected by `OP_get_field`, `OP_get_field2` and
`OP_get_super_value` also enter the running interpreter. Their result replaces
one, zero or three caller operand slots respectively. Lookup keeps the original
receiver, including inherited and `super` reads. `super` coerces its key once
before searching ordinary prototypes. Exotics, computed ordinary keys, data,
VARREF and AUTOINIT properties, native getters, async functions and generators
retain the existing property lookup and native call paths. Coroutine callers
retain native dispatch.

The selected getter is duplicated before interrupt polling or frame allocation.
The callee record owns that reference until its normal or exceptional teardown.
Interrupt and allocation refusal release it before unwinding the caller, whose
operands remain intact. No property pointer is used after a poll. Zero actual
arguments use a NULL vector and declared formal slots receive undefined.

`Array.prototype.reduce` and `reduceRight` use that same return path for ordinary
bytecode callbacks. Initialization and stepping stay out of line. Their step
mirrors upstream `js_array_reduce`. It converts
the receiver, reads length once, scans present indices in the chosen direction,
and supplies the accumulator, value, index and original object with an undefined
callback receiver. Element accessors, proxies and length coercion keep native
dispatch. Typed-array intrinsics, bound, proxy, native, async and generator
callbacks also keep native dispatch. The generic Array intrinsic borrowed onto
a typed array still uses the generic algorithm.

The record owns its converted object, accumulator and four writable callback
arguments. All slots are initialized before linking. Every release clears its
slot; successful completion moves and clears the accumulator into the result.
The final disposer releases the remaining state on return, throw, interrupt or
refused callback allocation. Callback parameter writes and escaping mapped
arguments retain ordinary bytecode ownership and closure handling.

Original regression adapters are `scripts/fixtures/quickjs-frame-stack.c` and
`.ts`, driven by `scripts/check-quickjs-frame-stack.ts`, plus the engine-neutral
native fixture `tests/fixtures/stack-loop-continuations`. The semantic snapshot
was captured from the engine before each dispatch change. The wasm32 contract
also runs deep reduce calls and recovery at 32 KiB. The native fixtures run on
all three engines, and the existing browser stack gate runs the continuation
fixture in its browser matrix. `tests/stack-depth.js` adds an original reduce
depth probe. Apply remains a separate unit.

Getter-specific original adapters extend those same bare-engine fixtures and
add `tests/fixtures/stack-getter-loop`, discovered by
`checks/native-stack-getter-loop.json`. They cover selected-getter collection
during an interrupt, accessor mutation, receiver and key semantics, formal
padding, escaping references, refused allocations, unbounded recursion and
recovery at the unchanged 32 and 36 KiB native budgets. Getter dispatch and
reduce continuations now both use the interpreter loop.
