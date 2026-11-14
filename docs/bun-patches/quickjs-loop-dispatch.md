# QuickJS builtin loop continuations

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
alignment and containment assertions. This unit adds no reduce or apply state.
Budgets, backing limits and native entry reservations are unchanged.

Original regression adapters are `scripts/fixtures/quickjs-frame-stack.c` and
`.ts`, driven by `scripts/check-quickjs-frame-stack.ts`, plus the engine-neutral
native fixture `tests/fixtures/stack-loop-continuations`. The semantic snapshot
was captured from the engine before this dispatch change.
